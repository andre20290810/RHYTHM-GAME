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
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)

    bar_edges = list(downbeat_times) + [duration]
    bar_features = []
    for i in range(len(bar_edges) - 1):
        t0, t1 = bar_edges[i], bar_edges[i + 1]
        mask = (rms_times >= t0) & (rms_times < t1)
        energy = float(rms[mask].mean()) if mask.any() else 0.0
        density = sum(1 for o in onsets if t0 <= o["time"] < t1)
        bar_features.append({"start": t0, "end": t1, "energy": energy, "density": density})

    if bar_features:
        energies = np.array([b["energy"] for b in bar_features])
        # smooth with a small moving average (2-bar window) to avoid flicker
        kernel = np.array([0.25, 0.5, 0.25])
        padded = np.pad(energies, 1, mode="edge")
        smoothed = np.convolve(padded, kernel, mode="valid")
        # percentile-based thresholds adapt to this song's own dynamic range
        # instead of fixed cutoffs, so quiet/loud mixes are handled alike.
        p25, p40, p70, p85 = np.percentile(smoothed, [25, 40, 70, 85])
        norm_energy = smoothed  # keep raw units; compare against percentiles below

        n = len(bar_features)
        sections = []
        cur_label = None
        cur_start = 0.0
        intro_end_idx = 0
        for i in range(n):
            if norm_energy[i] > p40 or i > n * 0.12:
                intro_end_idx = i
                break

        climax_start_idx = int(n * 0.78)
        for i, b in enumerate(bar_features):
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
