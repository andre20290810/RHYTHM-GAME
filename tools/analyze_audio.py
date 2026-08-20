#!/usr/bin/env python3
"""
Audio analysis for the RHYTHM-GAME engine.

Analyzes a song (mp3) and writes a song-agnostic analysis.json containing:
  - duration, bpm, beat_times, downbeat_times (bar starts)
  - onsets: real detected note candidates (time, strength, band, source)
  - sections: coarse structural labels derived from energy/onset-density

This script is NOT specific to any one song. It is meant to be run once per
song to produce the raw material that generate_chart.py turns into playable
charts. Nothing here is hardcoded to "Nijiiro Eden" - it just reads whatever
mp3 path is passed on the command line.

Techniques used (all classic, deterministic signal processing - no network
calls, no ML source-separation models):
  - librosa beat tracking for BPM / beat grid
  - onset strength + onset detection for note candidates
  - harmonic/percussive source separation (HPSS) to approximate
    "drum accent" (percussive) vs "vocal/melody phrase" (harmonic) onsets
  - mel-band energy per onset to pick a natural low->high frequency band
    (used later to choose a lane)
  - bar-level RMS energy + onset density to segment the song into coarse
    sections (intro / verse / chorus / break / climax / outro)
"""
import sys
import json
import argparse
from bisect import bisect_left
import numpy as np
import librosa


def to_native(obj):
    if isinstance(obj, dict):
        return {k: to_native(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_native(v) for v in obj]
    if isinstance(obj, (np.floating,)):
        return round(float(obj), 5)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    return obj


def estimate_downbeat_phase(beat_times, onset_env_perc, sr, hop_length):
    # librosa's beat tracker gives an accurate tempo/beat grid but does NOT
    # know which beat is "1" - grouping every 4th beat starting from
    # beat_times[0] (the old approach) silently assumes the very first
    # detected beat is a downbeat, which is often wrong and rewards the
    # wrong beat position when generate_chart.py scores onsets by downbeat
    # proximity. Downbeats/backbeats usually carry more percussive
    # (kick/snare) energy than off-beats, so we try all 4 phase offsets and
    # keep whichever aligns with the most percussive-onset energy.
    if len(beat_times) < 4:
        return 0
    n_frames = len(onset_env_perc)
    beat_frames = np.clip(np.round(beat_times * sr / hop_length).astype(int), 0, n_frames - 1)
    beat_strength = onset_env_perc[beat_frames]
    best_phase, best_score = 0, -1.0
    for phase in range(4):
        score = float(beat_strength[phase::4].sum())
        if score > best_score:
            best_score = score
            best_phase = phase
    return best_phase


def classify_percussive_onsets(y_perc, sr, onset_times, win_sec=0.08):
    # Kick vs snare vs "other percussive" from short-window spectral shape
    # right after each onset - kicks concentrate energy very low with a
    # low, stable spectral centroid; snares are broadband/noisy (high
    # spectral flatness, more zero-crossings) with a higher centroid.
    # Thresholds are percentile-based (relative to this song's own
    # percussive onsets), not fixed magic numbers, so it adapts per track.
    win = max(256, int(win_sec * sr))
    centroids, flatness, low_ratio = [], [], []
    for t in onset_times:
        start = int(t * sr)
        seg = y_perc[start:start + win]
        if len(seg) < 256:
            seg = np.pad(seg, (0, 256 - len(seg)))
        c = float(librosa.feature.spectral_centroid(y=seg, sr=sr)[0].mean())
        f = float(librosa.feature.spectral_flatness(y=seg)[0].mean())
        S = np.abs(np.fft.rfft(seg))
        freqs = np.fft.rfftfreq(len(seg), 1 / sr)
        total_e = float((S ** 2).sum()) or 1.0
        low_e = float((S[freqs < 150] ** 2).sum())
        centroids.append(c)
        flatness.append(f)
        low_ratio.append(low_e / total_e)

    centroids = np.array(centroids)
    flatness = np.array(flatness)
    low_ratio = np.array(low_ratio)
    if len(centroids) == 0:
        return []

    centroid_p40 = np.percentile(centroids, 40)
    low_ratio_p60 = np.percentile(low_ratio, 60)
    flatness_p60 = np.percentile(flatness, 60)

    categories = []
    for c, f, lr in zip(centroids, flatness, low_ratio):
        if c <= centroid_p40 and lr >= low_ratio_p60:
            categories.append("kick")
        elif f >= flatness_p60 and c > centroid_p40:
            categories.append("snare")
        else:
            categories.append("perc_other")
    return categories


def band_index(freq_hz):
    # 4 coarse bands mapped later to lanes 0..3 (low -> high)
    if freq_hz < 150:
        return 0
    if freq_hz < 500:
        return 1
    if freq_hz < 2000:
        return 2
    return 3


def dominant_band(mel_spec, mel_freqs, frame_idx, n_frames, band_baseline):
    # Raw low-frequency energy is almost always largest (typical spectral
    # tilt of music/kick drums), which would collapse every onset onto lane
    # 0. Instead compare each band's local energy to ITS OWN average level
    # across the whole song, so a band only "wins" when it is unusually
    # prominent at this instant - this keeps all 4 lanes musically active.
    lo = max(0, frame_idx - 1)
    hi = min(n_frames, frame_idx + 2)
    energy = mel_spec[:, lo:hi].mean(axis=1)
    bands = np.zeros(4)
    for i, f in enumerate(mel_freqs):
        bands[band_index(f)] += energy[i]
    ratio = bands / band_baseline
    return int(np.argmax(ratio))


def nearest_value_and_dist(t, sorted_times):
    """Binary-search nearest neighbour in a sorted list - returns
    (nearest_value, abs_distance). Used for beat/downbeat/subdivision grid
    classification below; distinct from generate_chart.py's own
    nearest_dist() (that one only needs the distance, not the value, and
    lives on the other side of the analysis/chart-generation boundary)."""
    if len(sorted_times) == 0:
        return None, 999.0
    lo, hi = 0, len(sorted_times) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_times[mid] < t:
            lo = mid + 1
        else:
            hi = mid
    candidates = [lo]
    if lo > 0:
        candidates.append(lo - 1)
    best_i = min(candidates, key=lambda i: abs(sorted_times[i] - t))
    return sorted_times[best_i], abs(sorted_times[best_i] - t)


def build_subdivision_grid(beat_times):
    """8th/16th grid points interpolated between each consecutive pair of
    DETECTED beats, not a synthetic constant-BPM grid - this adapts to the
    song's own local tempo (including any natural drift) the same way the
    beat grid itself already does."""
    beat_times = list(beat_times)
    eighth, sixteenth = [], []
    for i in range(len(beat_times) - 1):
        t0, t1 = beat_times[i], beat_times[i + 1]
        span = t1 - t0
        for frac in (0.0, 0.5):
            eighth.append(t0 + span * frac)
        for frac in (0.0, 0.25, 0.5, 0.75):
            sixteenth.append(t0 + span * frac)
    if beat_times:
        eighth.append(beat_times[-1])
        sixteenth.append(beat_times[-1])
    eighth = sorted(set(round(x, 4) for x in eighth))
    sixteenth = sorted(set(round(x, 4) for x in sixteenth))
    return eighth, sixteenth


def classify_grid_position(t, downbeat_times, beat_times, eighth_grid, sixteenth_grid, beat_period):
    """Where does this onset sit on the rhythmic grid? Coarsest match wins
    (a hit that is close to both a beat and a 16th point is reported as
    "beat", not "16th") - tolerances are fractions of the beat period so
    they scale correctly with this song's own tempo, not a fixed ms value.
    Returns (grid_class, grid_time, grid_offset) where grid_offset is the
    SIGNED (onset.time - grid_time) distance in seconds - generate_chart.py
    uses this to decide whether an onset is close enough to be measurement
    jitter (safe to snap) or a genuine, deliberate off-grid timing choice
    (never snapped)."""
    tol_beat = beat_period * 0.18
    tol_eighth = beat_period * 0.5 * 0.22
    tol_sixteenth = beat_period * 0.25 * 0.30

    db_val, db_dist = nearest_value_and_dist(t, downbeat_times)
    if db_dist <= tol_beat:
        return "downbeat", db_val, t - db_val

    b_val, b_dist = nearest_value_and_dist(t, beat_times)
    if b_dist <= tol_beat:
        return "beat", b_val, t - b_val

    e_val, e_dist = nearest_value_and_dist(t, eighth_grid)
    if e_dist <= tol_eighth:
        return "8th", e_val, t - e_val

    s_val, s_dist = nearest_value_and_dist(t, sixteenth_grid)
    if s_dist <= tol_sixteenth:
        return "16th", s_val, t - s_val

    return "off_grid", t, 0.0


def build_bar_patterns(onsets, downbeat_times, duration, similarity_threshold=0.75):
    """Groups bars (downbeat-to-downbeat spans, i.e. assumed 4/4 measures -
    consistent with downbeat_times already being every 4th beat above) into
    repeated-pattern clusters from their kick/snare skeleton alone, so
    generate_chart.py can give the SAME rhythmic phrase a consistent lane
    pattern each time it recurs (e.g. a chorus's kick-kick-snare-kick loop)
    instead of re-randomizing lanes every repetition. Each bar is reduced
    to a 16-slot (16th-note resolution) signature string; bars whose
    signatures agree on enough slots are clustered into one pattern_id via
    simple greedy matching against previously-seen signatures - not exact
    string equality, so near-identical fills/variations still cluster
    together. Purely descriptive: never changes onset times or strengths.
    Returns (bars, onset_bar_index, onset_slot) where the latter two are
    per-onset-index lists aligned with `onsets`."""
    edges = list(downbeat_times) + [duration]
    bars = []
    onset_bar_index = [-1] * len(onsets)
    onset_slot = [-1] * len(onsets)

    for bar_i in range(len(edges) - 1):
        t0, t1 = edges[bar_i], edges[bar_i + 1]
        span = t1 - t0
        if span <= 0:
            bars.append({"start": t0, "end": t1, "signature": "." * 16, "pattern_id": -1})
            continue
        slots = ["."] * 16
        for oi, o in enumerate(onsets):
            if not (t0 <= o["time"] < t1):
                continue
            # Use the GRID-classified time (when this onset landed on the
            # grid at all) rather than its raw detected time - onset
            # detection jitter of a few ms would otherwise scatter what is
            # musically "the same slot, repeated" across neighbouring
            # slots and defeat the whole point of pattern clustering.
            pos_t = o["grid_time"] if o.get("grid_class") != "off_grid" else o["time"]
            slot = int(round((pos_t - t0) / span * 16))
            slot = max(0, min(15, slot))
            onset_bar_index[oi] = bar_i
            onset_slot[oi] = slot
            if o["category"] in ("kick", "snare"):
                # kick takes priority when two categories land on the same
                # slot - it is the more foundational rhythmic anchor
                if slots[slot] == "." or (slots[slot] == "S" and o["category"] == "kick"):
                    slots[slot] = "K" if o["category"] == "kick" else "S"
        bars.append({"start": t0, "end": t1, "signature": "".join(slots), "pattern_id": -1})

    def similarity(sig_a, sig_b):
        compared = sum(1 for a, b in zip(sig_a, sig_b) if a != "." or b != ".")
        if compared == 0:
            return 0.0
        agree = sum(1 for a, b in zip(sig_a, sig_b) if a == b and a != ".")
        return agree / compared

    representatives = []  # [(pattern_id, signature)]
    next_id = 0
    for bar in bars:
        if bar["signature"] == "." * 16:
            continue  # silent/empty bar - not a "pattern" worth reusing
        best_id, best_score = -1, 0.0
        for pid, sig in representatives:
            score = similarity(bar["signature"], sig)
            if score > best_score:
                best_score, best_id = score, pid
        if best_id != -1 and best_score >= similarity_threshold:
            bar["pattern_id"] = best_id
        else:
            bar["pattern_id"] = next_id
            representatives.append((next_id, bar["signature"]))
            next_id += 1

    return bars, onset_bar_index, onset_slot


# ---------- Harmonic phrase-anchor resolution ----------
# Percussive hits (kick/snare) have a real physical attack, so their own
# onset time IS the musically meaningful moment - build_candidate_pool in
# generate_chart.py keeps using onsets/grid_class for those directly.
# Harmonic material (pads, vocals, reverb, sustained/atmospheric sound)
# often has no clean attack at all, so "the onset time" is frequently not
# where a listener actually feels the phrase. Instead of placing a note at
# a detected harmonic onset, this resolves each harmonic PHRASE (a
# contiguous span of sustained harmonic energy - see find_energy_spans) to
# whichever of three candidate moments (its own onset if any, its local
# RMS peak, or its RMS-weighted center) is most musically natural, scored
# on grid alignment AND energy/presence together - never grid-distance
# alone.
GRID_IMPORTANCE = {"downbeat": 1.0, "beat": 0.8, "8th": 0.5, "16th": 0.3, "off_grid": 0.0}
ROLE_BONUS = {"onset": 0.15, "rms_peak": 0.10, "phrase_center": 0.05}
# A candidate's total musical-naturalness score must clear this to become a
# note candidate AT ALL - below it, the phrase contributes no note (silence
# is an accepted outcome, not a gap to be forced closed).
MIN_COMPOSITE_TO_PLACE = 0.35
# An off-grid candidate (no beat/downbeat/8th/16th nearby) needs a much
# higher bar - only a genuinely prominent, unmistakable phrase moment earns
# a note that isn't anchored to the rhythm grid at all.
OFF_GRID_COMPOSITE_FLOOR = 0.60


def grid_tolerance_for(grid_class, beat_period):
    """Mirrors the tolerance fractions used inside classify_grid_position()
    - kept as a separate lookup here since that function only returns the
    classification result, not the tolerance it used internally."""
    if grid_class in ("downbeat", "beat"):
        return beat_period * 0.18
    if grid_class == "8th":
        return beat_period * 0.5 * 0.22
    if grid_class == "16th":
        return beat_period * 0.25 * 0.30
    return 0.0


def smooth_envelope(values, window_frames):
    """Small centered moving-average smoothing - turns frame-level jitter
    in an RMS envelope into a stable "perceived loudness" contour, which is
    what local-peak/phrase-center detection needs (a single noisy spike
    should never win over a genuinely sustained swell)."""
    values = np.asarray(values, dtype=float)
    if window_frames <= 1 or len(values) == 0:
        return values.copy()
    kernel = np.ones(window_frames * 2 + 1) / (window_frames * 2 + 1)
    padded = np.pad(values, window_frames, mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def find_phrase_spans_by_envelope(rms_smoothed, times, min_phrase_len, duration):
    """Segments a continuous harmonic energy envelope into phrases using
    its OWN local minima (valleys) rather than requiring it to drop below
    a fixed silence floor - a pad/atmosphere track's harmonic energy may
    never truly go silent, but it still naturally swells and recedes, and
    those valleys are exactly where one musical phrase ends and the next
    begins. Minima closer together than min_phrase_len are merged so this
    doesn't fragment into unmusically tiny slivers."""
    n = len(rms_smoothed)
    if n < 3:
        return [(times[0], duration)] if n else []
    minima_times = [times[0]]
    for i in range(1, n - 1):
        if rms_smoothed[i] <= rms_smoothed[i - 1] and rms_smoothed[i] <= rms_smoothed[i + 1]:
            minima_times.append(times[i])
    minima_times.append(times[-1])

    merged = [minima_times[0]]
    for t in minima_times[1:]:
        if t - merged[-1] < min_phrase_len:
            continue
        merged.append(t)
    if merged[-1] < duration - min_phrase_len:
        merged.append(duration)
    elif merged[-1] < duration:
        merged[-1] = duration
    return [(merged[i], merged[i + 1]) for i in range(len(merged) - 1)]


def score_candidate(t, role, rms_env_smoothed, rms_times_arr, phrase_peak_val,
                     downbeat_times, beat_times, eighth_grid, sixteenth_grid, beat_period):
    """Composite musical-naturalness score for one candidate moment - grid
    alignment (importance + closeness), local energy, and how prominent
    this instant is relative to its OWN phrase's peak, plus a small role
    bonus. Never grid-distance alone."""
    gc, gt, goff = classify_grid_position(t, downbeat_times, beat_times, eighth_grid, sixteenth_grid, beat_period)
    tol = grid_tolerance_for(gc, beat_period)
    closeness = max(0.0, 1.0 - abs(goff) / tol) if tol > 0 else 0.0

    idx = int(np.searchsorted(rms_times_arr, t))
    idx = min(max(idx, 0), len(rms_env_smoothed) - 1)
    local_val = min(1.0, float(rms_env_smoothed[idx]))
    presence = min(1.0, local_val / phrase_peak_val) if phrase_peak_val > 0 else 0.0

    composite = (
        0.30 * GRID_IMPORTANCE[gc]
        + 0.20 * closeness
        + 0.15 * local_val
        + 0.25 * presence
        + ROLE_BONUS[role]
    )
    return composite, gc, gt, goff


def resolve_phrase_anchor(phrase_start, phrase_end, onset_times_in_phrase, rms_env_smoothed, rms_times_arr,
                           downbeat_times, beat_times, eighth_grid, sixteenth_grid, beat_period):
    """Picks the single most musically-natural moment for one harmonic
    phrase span, comparing its own onset (if any), its local RMS peak, and
    its RMS-weighted center - see score_candidate(). Returns None if the
    span has no measurable energy at all (shouldn't normally happen since
    spans are built FROM the energy envelope, but guards a degenerate
    edge case)."""
    mask = (rms_times_arr >= phrase_start) & (rms_times_arr <= phrase_end)
    if not mask.any():
        return None
    seg_vals = rms_env_smoothed[mask]
    seg_times = rms_times_arr[mask]
    phrase_peak_val = float(seg_vals.max())
    if phrase_peak_val <= 0:
        return None

    candidates = []
    if onset_times_in_phrase:
        candidates.append((onset_times_in_phrase[0], "onset"))
    rms_peak_time = float(seg_times[int(np.argmax(seg_vals))])
    candidates.append((rms_peak_time, "rms_peak"))
    weights = seg_vals - seg_vals.min()
    if weights.sum() > 0:
        phrase_center_time = float(np.average(seg_times, weights=weights))
    else:
        phrase_center_time = float((phrase_start + phrase_end) / 2)
    candidates.append((phrase_center_time, "phrase_center"))

    best = None
    for t, role in candidates:
        composite, gc, gt, goff = score_candidate(
            t, role, rms_env_smoothed, rms_times_arr, phrase_peak_val,
            downbeat_times, beat_times, eighth_grid, sixteenth_grid, beat_period,
        )
        if best is None or composite > best["composite"]:
            best = {
                "raw_time": t, "role": role, "composite": composite,
                "grid_class": gc, "grid_time": gt, "grid_offset": goff,
            }

    if best["composite"] < MIN_COMPOSITE_TO_PLACE:
        return None  # not musically justified enough - this phrase stays silent

    if best["grid_class"] != "off_grid":
        final_time = best["grid_time"]
    elif best["composite"] >= OFF_GRID_COMPOSITE_FLOOR:
        final_time = best["raw_time"]  # a genuinely prominent moment, kept at its own timing
    else:
        return None

    best["time"] = round(float(final_time), 4)
    return best


# Sections this energetic get their ambient_score damped hard (see
# compute_ambient_scores) - "lots of sustained harmonic content" alone
# must not read as ambient when the song is actually at its most driven.
# Mirrors generate_chart.py's own HIGH_ENERGY_SECTIONS constant (kept as a
# separate copy since analyze_audio.py doesn't import from generate_chart.py).
HIGH_ENERGY_SECTION_LABELS = {"chorus", "climax"}
HIGH_ENERGY_AMBIENT_DAMPING = 0.4


def section_label_at(t, sections):
    for s in sections:
        if s["start"] <= t < s["end"]:
            return s["label"]
    return sections[-1]["label"] if sections else "verse"


def compute_ambient_scores(bars, onsets, rms_perc_norm, rms_perc_times, rms_harm_norm_local, sections):
    """Per-bar "ambient score" (0..1): high when a bar is QUIET overall,
    has little percussive activity, mostly long-ringing harmonic content,
    and weak percussive-vs-harmonic energy locally - i.e. genuinely
    pad/atmosphere, not just "this bar happens to have sustained notes".
    A bar's absolute loudness (bars[i]["energy"], set by the caller before
    this runs) and whether it falls inside a high-energy chorus/climax
    section are BOTH part of the score now, and a high-energy section gets
    an extra multiplicative damping on top - "lots of sustain" must not by
    itself outrank "the song is actually at its most driven right now".
    All percentile-normalized against THIS SONG's own distribution. Sets
    bar["ambient_score"] and bar["is_ambient"] in place; also smooths the
    is_ambient flag so it doesn't flicker bar-to-bar."""
    if not bars:
        return
    perc_density, harm_sustain_mean, perc_ratio, energy = [], [], [], []
    for b in bars:
        t0, t1 = b["start"], b["end"]
        span = max(1e-6, t1 - t0)
        perc_count = sum(1 for o in onsets if t0 <= o["time"] < t1 and o["category"] in ("kick", "snare"))
        perc_density.append(perc_count / span)

        harm_onsets_here = [o for o in onsets if t0 <= o["time"] < t1 and "harm" in o["source"]]
        harm_sustain_mean.append(
            float(np.mean([o.get("sustain", 0.0) for o in harm_onsets_here])) if harm_onsets_here else 0.0
        )

        mask = (rms_perc_times >= t0) & (rms_perc_times < t1)
        if mask.any():
            p = float(rms_perc_norm[mask].mean())
            h = float(rms_harm_norm_local[mask].mean())
            perc_ratio.append(p / (p + h) if (p + h) > 0 else 0.0)
        else:
            perc_ratio.append(0.0)

        energy.append(float(b.get("energy", 0.0)))

    def pct_rank(values):
        arr = np.asarray(values, dtype=float)
        if arr.max() == arr.min():
            return np.full_like(arr, 0.5)
        order = arr.argsort().argsort()
        return order / max(1, len(arr) - 1)

    perc_density_pct = pct_rank(perc_density)
    harm_sustain_pct = pct_rank(harm_sustain_mean)
    perc_ratio_pct = pct_rank(perc_ratio)
    energy_pct = pct_rank(energy)

    # "Quiet, weak-attack, spatially spread out" - absolute energy is now
    # one of the four signals (not just a bolt-on veto), so a bar needs to
    # actually be QUIET, not merely low-percussive-density, to score high.
    raw_scores = (
        (1.0 - perc_density_pct) * 0.30
        + harm_sustain_pct * 0.25
        + (1.0 - perc_ratio_pct) * 0.20
        + (1.0 - energy_pct) * 0.25
    )

    damped_scores = np.array(raw_scores, dtype=float)
    for i, b in enumerate(bars):
        label = section_label_at((b["start"] + b["end"]) / 2, sections)
        if label in HIGH_ENERGY_SECTION_LABELS:
            damped_scores[i] *= HIGH_ENERGY_AMBIENT_DAMPING

    threshold = float(np.percentile(damped_scores, 65))

    for b, score in zip(bars, damped_scores):
        b["ambient_score"] = round(float(score), 4)
        b["is_ambient"] = bool(score >= threshold)

    # smooth away single-bar flicker: an isolated bar surrounded by the
    # opposite classification on both sides flips to match its neighbours
    for i in range(1, len(bars) - 1):
        if bars[i]["is_ambient"] != bars[i - 1]["is_ambient"] and bars[i]["is_ambient"] != bars[i + 1]["is_ambient"]:
            bars[i]["is_ambient"] = bars[i - 1]["is_ambient"]


def bar_lookup(t, bars):
    for i, b in enumerate(bars):
        if b["start"] <= t < b["end"]:
            span = b["end"] - b["start"]
            slot = int(round((t - b["start"]) / span * 16)) if span > 0 else 0
            return i, max(0, min(15, slot))
    return -1, -1


def merge_onsets(times_a, strengths_a, source_a, times_b, strengths_b, source_b, merge_window=0.03):
    events = []
    for t, s in zip(times_a, strengths_a):
        events.append([t, s, source_a])
    for t, s in zip(times_b, strengths_b):
        events.append([t, s, source_b])
    events.sort(key=lambda e: e[0])

    merged = []
    for t, s, src in events:
        if merged and (t - merged[-1]["time"]) < merge_window:
            prev = merged[-1]
            if s > prev["strength"]:
                prev["strength"] = s
            if src not in prev["source"]:
                prev["source"] += "+" + src
        else:
            merged.append({"time": float(t), "strength": float(s), "source": src})
    return merged


def analyze(path, sr_target=44100, hop_length=512):
    y, sr = librosa.load(path, sr=sr_target, mono=True)
    duration = len(y) / sr

    y_harm, y_perc = librosa.effects.hpss(y)

    onset_env_full = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env_full, sr=sr, hop_length=hop_length, trim=False
    )
    bpm = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)
    beat_times = beat_times[beat_times <= duration]
    if len(beat_times) == 0 or beat_times[0] > 0.05:
        beat_times = np.concatenate([[0.0], beat_times])

    onset_env_perc = librosa.onset.onset_strength(y=y_perc, sr=sr, hop_length=hop_length)
    onset_env_harm = librosa.onset.onset_strength(y=y_harm, sr=sr, hop_length=hop_length)

    # bar/downbeat estimate: group every 4 beats, phase-corrected (see
    # estimate_downbeat_phase) instead of assuming beat_times[0] is beat 1.
    downbeat_phase = estimate_downbeat_phase(beat_times, onset_env_perc, sr, hop_length)
    downbeat_times = beat_times[downbeat_phase::4]

    onset_frames_perc = librosa.onset.onset_detect(
        onset_envelope=onset_env_perc, sr=sr, hop_length=hop_length, backtrack=True, units="frames"
    )
    onset_frames_harm = librosa.onset.onset_detect(
        onset_envelope=onset_env_harm, sr=sr, hop_length=hop_length, backtrack=True, units="frames"
    )

    onset_times_perc = librosa.frames_to_time(onset_frames_perc, sr=sr, hop_length=hop_length)
    onset_times_harm = librosa.frames_to_time(onset_frames_harm, sr=sr, hop_length=hop_length)

    def norm(env, frames):
        vals = env[frames] if len(frames) else np.array([])
        if len(vals) == 0:
            return vals
        p95 = np.percentile(vals, 95) or 1.0
        return np.clip(vals / p95, 0, 1.2)

    strengths_perc = norm(onset_env_perc, onset_frames_perc)
    strengths_harm = norm(onset_env_harm, onset_frames_harm)

    onsets = merge_onsets(
        onset_times_perc, strengths_perc, "perc",
        onset_times_harm, strengths_harm, "harm",
    )
    onsets = [o for o in onsets if o["time"] < duration - 0.05]

    # frequency band per onset (for natural lane placement) from the full mix
    mel_spec = librosa.feature.melspectrogram(y=y, sr=sr, hop_length=hop_length, n_mels=40)
    mel_freqs = librosa.mel_frequencies(n_mels=40, fmin=0, fmax=sr / 2)
    n_frames = mel_spec.shape[1]

    band_baseline = np.zeros(4)
    band_mean_energy = mel_spec.mean(axis=1)
    for i, f in enumerate(mel_freqs):
        band_baseline[band_index(f)] += band_mean_energy[i]
    band_baseline = np.maximum(band_baseline, 1e-6)

    for o in onsets:
        frame_idx = int(round(o["time"] * sr / hop_length))
        o["band"] = dominant_band(mel_spec, mel_freqs, frame_idx, n_frames, band_baseline)

    # sustain flag: does harmonic energy stay high for a while after this onset?
    rms_harm = librosa.feature.rms(y=y_harm, hop_length=hop_length)[0]
    rms_harm_times = librosa.frames_to_time(np.arange(len(rms_harm)), sr=sr, hop_length=hop_length)
    rms_harm_norm = rms_harm / (np.percentile(rms_harm, 95) or 1.0)
    # percussive-side RMS on the same frame grid - used for compute_ambient_
    # scores()'s local percussive-vs-harmonic energy ratio (a bar with
    # weak percussive RMS relative to harmonic RMS reads as ambient/pad-
    # driven even if both onset detectors found little to report there).
    rms_perc = librosa.feature.rms(y=y_perc, hop_length=hop_length)[0]
    rms_perc_norm = rms_perc / (np.percentile(rms_perc, 95) or 1.0)
    # heavier-smoothed harmonic RMS envelope for local-peak/phrase-center
    # detection - a "perceived loudness" contour, not frame-level jitter.
    rms_harm_smoothed = smooth_envelope(rms_harm_norm, window_frames=max(1, int(round(0.12 * sr / hop_length))))

    def sustain_duration(start_time, floor=0.35, max_dur=2.5, step=0.05):
        t = start_time
        while t - start_time < max_dur:
            idx = int(round((t + step) * sr / hop_length))
            if idx >= len(rms_harm_norm) or rms_harm_norm[idx] < floor:
                break
            t += step
        return round(t - start_time, 3)

    for o in onsets:
        if "harm" in o["source"] and o["strength"] > 0.35:
            o["sustain"] = sustain_duration(o["time"])
        else:
            o["sustain"] = 0.0

    # --- musical category per onset (see classify_percussive_onsets) ---
    # A merged "perc+harm" event is driven primarily by the percussive hit
    # (typically the more rhythmically foundational component), so the
    # percussive classification takes precedence when both are present.
    perc_idx = [i for i, o in enumerate(onsets) if "perc" in o["source"]]
    if perc_idx:
        perc_categories = classify_percussive_onsets(y_perc, sr, [onsets[i]["time"] for i in perc_idx])
        for i, cat in zip(perc_idx, perc_categories):
            onsets[i]["category"] = cat
    for o in onsets:
        if "category" not in o:
            o["category"] = "harm_other"

    # phrase-start: a harmonic (vocal/melody) onset following a genuine gap
    # in harmonic energy, i.e. a new phrase entering after a rest/breath -
    # not just a wobble mid-note. Independent of the perc/harm category
    # above, since a merged onset can be both e.g. a kick AND a phrase start.
    harm_gap_floor = float(np.percentile(rms_harm_norm, 25))
    gap_needed_sec = 0.35

    def is_phrase_start(t):
        end_frame = int(round(t * sr / hop_length))
        start_frame = max(0, end_frame - int(round(gap_needed_sec * sr / hop_length)))
        if start_frame >= end_frame:
            return False
        return bool(rms_harm_norm[start_frame:end_frame].mean() < harm_gap_floor)

    for o in onsets:
        o["phrase_start"] = "harm" in o["source"] and is_phrase_start(o["time"])

    # --- rhythm grid classification (beat-first redesign) ---
    # Every onset is placed on the beat/downbeat/8th/16th subdivision grid
    # (or "off_grid" if it truly isn't close to any of them) so
    # generate_chart.py can select and quantize by RHYTHMIC role instead of
    # raw onset strength alone. grid_offset is signed and always measured
    # against the onset's own RAW detected time - nothing here modifies
    # o["time"] itself; quantization (if any) happens downstream.
    beat_period = 60.0 / bpm if bpm > 0 else 0.5
    eighth_grid, sixteenth_grid = build_subdivision_grid(beat_times)
    for o in onsets:
        grid_class, grid_time, grid_offset = classify_grid_position(
            o["time"], downbeat_times, beat_times, eighth_grid, sixteenth_grid, beat_period
        )
        o["grid_class"] = grid_class
        o["grid_time"] = round(float(grid_time), 4)
        o["grid_offset"] = round(float(grid_offset), 4)

    # --- repeated-rhythm-pattern detection (per bar, kick/snare skeleton) ---
    # See build_bar_patterns() - lets generate_chart.py reuse a consistent
    # lane pattern across repetitions of "the same" rhythmic phrase (e.g. a
    # chorus's recurring kick/snare loop) instead of re-randomizing lanes
    # every time it repeats.
    bars, onset_bar_index, onset_slot = build_bar_patterns(onsets, downbeat_times, duration)
    for o, bar_i, slot in zip(onsets, onset_bar_index, onset_slot):
        o["bar_index"] = bar_i
        o["bar_slot"] = slot
        o["pattern_id"] = bars[bar_i]["pattern_id"] if 0 <= bar_i < len(bars) else -1

    # --- section detection: bar-level RMS energy + onset density ---
    # Moved ahead of ambient scoring (see compute_ambient_scores) - a bar's
    # absolute loudness and whether it falls inside a high-energy chorus/
    # climax section are now both inputs to the ambient score, so section
    # labels have to exist first. Reuses `bars`' own start/end boundaries
    # directly (identical to the old separately-built bar_edges) and
    # stores each bar's absolute energy/onset density onto `bars` itself.
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)

    for b in bars:
        t0, t1 = b["start"], b["end"]
        mask = (rms_times >= t0) & (rms_times < t1)
        b["energy"] = float(rms[mask].mean()) if mask.any() else 0.0
        b["density"] = sum(1 for o in onsets if t0 <= o["time"] < t1)

    if bars:
        energies = np.array([b["energy"] for b in bars])
        # smooth with a small moving average (2-bar window) to avoid flicker
        kernel = np.array([0.25, 0.5, 0.25])
        padded = np.pad(energies, 1, mode="edge")
        smoothed = np.convolve(padded, kernel, mode="valid")
        # percentile-based thresholds adapt to this song's own dynamic range
        # instead of fixed cutoffs, so quiet/loud mixes are handled alike.
        p25, p40, p70, p85 = np.percentile(smoothed, [25, 40, 70, 85])
        norm_energy = smoothed  # keep raw units; compare against percentiles below

        n = len(bars)
        sections = []
        cur_label = None
        cur_start = 0.0
        intro_end_idx = 0
        for i in range(n):
            if norm_energy[i] > p40 or i > n * 0.12:
                intro_end_idx = i
                break

        climax_start_idx = int(n * 0.78)
        for i, b in enumerate(bars):
            if i < intro_end_idx:
                label = "intro"
            elif i >= n - max(2, int(n * 0.04)):
                label = "outro"
            elif norm_energy[i] < p25:
                label = "break"
            elif i >= climax_start_idx and norm_energy[i] >= p85:
                label = "climax"
            elif norm_energy[i] >= p70:
                label = "chorus"
            else:
                label = "verse"

            if label != cur_label:
                if cur_label is not None:
                    sections.append({"start": round(cur_start, 3), "end": round(b["start"], 3), "label": cur_label})
                cur_label = label
                cur_start = b["start"]
        sections.append({"start": round(cur_start, 3), "end": round(duration, 3), "label": cur_label})

        # merge tiny sections (<2 bars) into their neighbour
        min_len = (60.0 / bpm) * 4 * 1.5
        merged_sections = []
        for s in sections:
            if merged_sections and (s["end"] - s["start"]) < min_len:
                merged_sections[-1]["end"] = s["end"]
            else:
                merged_sections.append(s)
        sections = merged_sections
    else:
        sections = [{"start": 0.0, "end": duration, "label": "verse"}]

    # --- ambient/pad-vs-driven scoring per bar (see compute_ambient_scores) ---
    compute_ambient_scores(bars, onsets, rms_perc_norm, rms_harm_times, rms_harm_norm, sections)

    # --- harmonic phrase-anchor resolution (see resolve_phrase_anchor) ---
    # Replaces "use the harmonic onset's own detected time" with "use
    # whichever of onset / local RMS peak / phrase center is most musically
    # natural for this phrase" - applies to ALL harmonic phrases, ambient
    # and non-ambient alike (percussive kick/snare onsets are untouched and
    # keep using their own onset time directly, elsewhere in this file and
    # in generate_chart.py).
    min_phrase_len = max(0.6, beat_period * 1.5)
    harmonic_spans = find_phrase_spans_by_envelope(rms_harm_smoothed, rms_harm_times, min_phrase_len, duration)
    harm_onset_times_sorted = sorted(o["time"] for o in onsets if "harm" in o["source"])
    harmonic_phrases = []
    for p_start, p_end in harmonic_spans:
        if p_end >= duration - 0.05:
            continue  # no notes past the song's usable end, same rule as onsets above
        lo = bisect_left(harm_onset_times_sorted, p_start)
        hi = bisect_left(harm_onset_times_sorted, p_end)
        onset_times_in_phrase = harm_onset_times_sorted[lo:hi]

        result = resolve_phrase_anchor(
            p_start, p_end, onset_times_in_phrase, rms_harm_smoothed, rms_harm_times,
            downbeat_times, beat_times, eighth_grid, sixteenth_grid, beat_period,
        )
        if result is None:
            continue  # not musically justified - this phrase stays silent, by design

        frame_idx = int(round(result["time"] * sr / hop_length))
        band = dominant_band(mel_spec, mel_freqs, frame_idx, n_frames, band_baseline)
        bar_i, slot = bar_lookup(result["time"], bars)
        harmonic_phrases.append({
            "time": result["time"],
            "phrase_start": round(p_start, 4),
            "phrase_end": round(p_end, 4),
            "resolved_from": result["role"],
            "composite_score": round(result["composite"], 4),
            "grid_class": result["grid_class"],
            "band": band,
            "sustain": round(min(2.5, p_end - p_start), 3),
            "bar_index": bar_i,
            "bar_slot": slot,
            "pattern_id": bars[bar_i]["pattern_id"] if 0 <= bar_i < len(bars) else -1,
            "is_ambient": bool(bars[bar_i]["is_ambient"]) if 0 <= bar_i < len(bars) else False,
        })

    result = {
        "source_file": path,
        "sample_rate": sr,
        "duration_sec": duration,
        "bpm": bpm,
        "beat_times": beat_times.tolist(),
        "downbeat_times": downbeat_times.tolist(),
        "eighth_grid": eighth_grid,
        "sixteenth_grid": sixteenth_grid,
        "bars": bars,
        "onsets": onsets,
        "harmonic_phrases": harmonic_phrases,
        "sections": sections,
    }
    return to_native(result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Analyze a song for the RHYTHM-GAME chart generator")
    parser.add_argument("input", help="path to audio file (mp3/wav)")
    parser.add_argument("-o", "--output", default="analysis.json", help="output analysis JSON path")
    args = parser.parse_args()

    data = analyze(args.input)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"duration={data['duration_sec']:.2f}s bpm={data['bpm']:.2f} "
          f"beats={len(data['beat_times'])} onsets={len(data['onsets'])} "
          f"sections={len(data['sections'])}", file=sys.stderr)
