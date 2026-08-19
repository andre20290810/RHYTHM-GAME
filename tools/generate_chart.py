#!/usr/bin/env python3
"""
Turns a song-agnostic analysis.json (produced by analyze_audio.py) into
playable EASY / NORMAL / HARD note charts for the RHYTHM-GAME piano-tile
engine.

Nothing here is specific to any one song - every decision is driven by the
numbers in analysis.json (onset times/strengths/categories/bands,
beat/downbeat times, section labels). Running this script against a
different song's analysis.json produces a different chart with the same
code.

Design (v2 - layered/hierarchical):
  - Notes come ONLY from real detected onsets - never a fixed-interval
    grid, and never quantized onto the beat grid (onset TIMES are used
    verbatim; the beat/downbeat grid is only used to judge which onsets
    are musically important).
  - There is no note-count or notes-per-second target. Each difficulty is
    built from a QUALITY-based candidate pool (musical category + a
    strength floor), and note count is whatever survives that pool plus
    the playability spacing rules - never a number to hit.
  - EASY is the song's rhythmic skeleton: kicks, phrase-start
    (vocal/melody) onsets, and strong downbeat-aligned accents only.
  - NORMAL = EASY's notes, unchanged, PLUS snares and secondary
    beat-aligned accents layered on top.
  - HARD = NORMAL's notes, unchanged, PLUS the remaining onsets that
    still clear a minimum musical-relevance bar (rhythmically grounded
    or clearly categorized) - weak/ornamental/reverb-tail onsets are
    excluded at every difficulty, not just downgraded to "extra HARD
    filler".
  - Lane (0-3) is primarily driven by the onset's dominant frequency band
    (bass -> lane 0 .. treble -> lane 3), not randomness.
  - Long sustained harmonic onsets (held vocal/instrument notes) become
    hold notes instead of a burst of taps.
  - Chords (two simultaneous lanes) are reserved for strong downbeats in
    high-energy sections and are rationed per difficulty.
  - No note is ever placed after the song's usable end (outro buffer).
"""
import sys
import json
import argparse
import random
import bisect

LAYER_CONFIG = {
    "easy": {
        "min_gap_global": 0.28,
        "min_gap_lane": 0.50,
        "max_consecutive_lane": 2,
        "hold_threshold": 0.90,
        "hold_convert_prob": 0.55,
        "chord_prob": 0.0,
        "downbeat_window": 0.06,
        "beat_window": 0.06,
    },
    "normal": {
        "min_gap_global": 0.15,
        "min_gap_lane": 0.28,
        "max_consecutive_lane": 2,
        "hold_threshold": 0.70,
        "hold_convert_prob": 0.40,
        "chord_prob": 0.10,
        "downbeat_window": 0.07,
        "beat_window": 0.07,
    },
    "hard": {
        "min_gap_global": 0.095,
        "min_gap_lane": 0.16,
        "max_consecutive_lane": 3,
        "hold_threshold": 0.55,
        "hold_convert_prob": 0.30,
        "chord_prob": 0.22,
        "downbeat_window": 0.10,
        "beat_window": 0.10,
    },
}

OUTRO_BUFFER_SEC = 1.2
LANE_COUNT = 4
HIGH_ENERGY_SECTIONS = {"chorus", "climax"}


def nearest_dist(t, times):
    if not times:
        return 999.0
    lo, hi = 0, len(times) - 1
    best = abs(times[0] - t)
    while lo <= hi:
        mid = (lo + hi) // 2
        best = min(best, abs(times[mid] - t))
        if times[mid] < t:
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def section_at(t, sections):
    for s in sections:
        if s["start"] <= t < s["end"]:
            return s["label"]
    return sections[-1]["label"] if sections else "verse"


def percentile(values, pct):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (pct / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def build_candidate_pool(layer, onsets, used, beat_times, downbeat_times, thresholds):
    """Onsets eligible to be ADDED at this layer, keyed by musical category
    and a strength floor - never by picking "the next N strongest" onsets.
    Already-used onset indices (placed in a lower layer) are excluded so a
    higher layer only ever adds NEW notes on top."""
    cfg = LAYER_CONFIG[layer]
    pool = []
    for i, o in enumerate(onsets):
        if i in used:
            continue
        if layer == "easy":
            qualifies = (
                o["category"] == "kick"
                or o["phrase_start"]
                or (
                    nearest_dist(o["time"], downbeat_times) <= cfg["downbeat_window"]
                    and o["strength"] >= thresholds["strong"]
                )
            )
        elif layer == "normal":
            qualifies = (
                o["category"] == "snare"
                or o["phrase_start"]
                or (
                    nearest_dist(o["time"], beat_times) <= cfg["beat_window"]
                    and o["strength"] >= thresholds["medium"]
                )
            )
        else:  # hard
            if o["strength"] < thresholds["floor"]:
                continue
            qualifies = (
                o["category"] in ("kick", "snare")
                or o["phrase_start"]
                or nearest_dist(o["time"], beat_times) <= cfg["beat_window"]
            )
        if qualifies:
            pool.append(i)
    return pool


def build_layer(layer, prev_notes, prev_note_onset_ids, onsets, used, beat_times,
                 downbeat_times, sections, thresholds, seed):
    """Replays prev_notes (locked, never modified) in time order interleaved
    with this layer's new candidate onsets, applying spacing/hold/chord
    rules from this layer's config only to the NEW candidates. Returns the
    combined note list (superset of prev_notes) and the updated used-id set."""
    cfg = LAYER_CONFIG[layer]
    rng = random.Random(seed)
    candidate_ids = build_candidate_pool(layer, onsets, used, beat_times, downbeat_times, thresholds)

    timeline = []
    for note, onset_id in zip(prev_notes, prev_note_onset_ids):
        timeline.append((note["time"], "locked", note, onset_id))
    for i in candidate_ids:
        timeline.append((onsets[i]["time"], "candidate", onsets[i], i))
    timeline.sort(key=lambda x: (x[0], x[1] == "candidate"))

    # Locked notes (from a lower difficulty layer) can never be moved or
    # dropped, so a NEW candidate must also yield to a locked note that
    # comes chronologically AFTER it - not just to whatever was placed
    # earlier in this same left-to-right walk. These sorted lookup
    # structures let a candidate check both directions around itself.
    locked_all_times = sorted(n["time"] for n in prev_notes)
    locked_lane_times = [sorted(n["time"] for n in prev_notes if n["lane"] == l) for l in range(LANE_COUNT)]

    def next_locked_gap(t, lane):
        all_idx = bisect.bisect_left(locked_all_times, t)
        global_gap = (locked_all_times[all_idx] - t) if all_idx < len(locked_all_times) else 999.0
        lane_times = locked_lane_times[lane]
        lane_idx = bisect.bisect_left(lane_times, t)
        lane_gap = (lane_times[lane_idx] - t) if lane_idx < len(lane_times) else 999.0
        return global_gap, lane_gap

    lane_free_time = [0.0] * LANE_COUNT
    global_last_time = -999.0
    last_lane = -1
    consecutive = 0
    notes = []
    note_onset_ids = []
    new_used = set(used)

    def pick_lane(base_band, avoid=None):
        nonlocal last_lane, consecutive
        lane = base_band
        if avoid is not None and lane == avoid:
            lane = (lane + 1) % LANE_COUNT
        if lane == last_lane and consecutive >= cfg["max_consecutive_lane"]:
            choices = [l for l in range(LANE_COUNT) if l != last_lane and l != avoid]
            lane = rng.choice(choices)
        return lane

    for t, kind, obj, onset_id in timeline:
        if kind == "locked":
            note = obj
            lane = note["lane"]
            if lane == last_lane:
                consecutive += 1
            else:
                consecutive = 1
            last_lane = lane
            lane_free_time[lane] = max(
                lane_free_time[lane],
                note["time"] + (note.get("duration", 0.0) if note["type"] == "hold" else cfg["min_gap_lane"]),
            )
            global_last_time = note["time"]
            notes.append(note)
            note_onset_ids.append(onset_id)
            continue

        o = obj
        lane = pick_lane(o["band"])
        if t < lane_free_time[lane]:
            continue
        is_chord_partner_of_prev = notes and abs(notes[-1]["time"] - t) < 0.02
        if not is_chord_partner_of_prev and (t - global_last_time) < cfg["min_gap_global"]:
            continue
        # symmetric check against locked notes coming AFTER this candidate
        next_global_gap, next_lane_gap = next_locked_gap(t, lane)
        if next_lane_gap < cfg["min_gap_lane"]:
            continue
        if not is_chord_partner_of_prev and next_global_gap < cfg["min_gap_global"]:
            continue

        is_hold = (
            o.get("sustain", 0.0) >= cfg["hold_threshold"]
            and o["source"] == "harm"
            and rng.random() < cfg["hold_convert_prob"]
        )
        note = {"time": round(t, 3), "lane": lane, "type": "hold" if is_hold else "tap"}
        if is_hold:
            # never let a hold's tail run into a locked note in the same lane
            dur = min(o["sustain"], max(0.0, next_lane_gap - 0.02))
            if dur < 0.15:
                is_hold = False
                note["type"] = "tap"
            else:
                note["duration"] = round(dur, 3)

        notes.append(note)
        note_onset_ids.append(onset_id)
        new_used.add(onset_id)
        if lane == last_lane:
            consecutive += 1
        else:
            consecutive = 1
        last_lane = lane
        lane_free_time[lane] = t + (note.get("duration", 0.0) if is_hold else cfg["min_gap_lane"])
        global_last_time = t

        can_chord = (
            cfg["chord_prob"] > 0
            and not is_hold
            and nearest_dist(t, downbeat_times) <= cfg["downbeat_window"]
            and section_at(t, sections) in HIGH_ENERGY_SECTIONS
            and o["strength"] > 0.7
            and rng.random() < cfg["chord_prob"]
        )
        if can_chord:
            other_lanes = [l for l in range(LANE_COUNT) if l != lane and t >= lane_free_time[l]]
            if other_lanes:
                lane2 = rng.choice(other_lanes)
                notes.append({"time": round(t, 3), "lane": lane2, "type": "tap"})
                note_onset_ids.append(None)  # synthetic chord partner, not a real onset
                lane_free_time[lane2] = t + cfg["min_gap_lane"]

    combined = list(zip(notes, note_onset_ids))
    combined.sort(key=lambda p: (p[0]["time"], p[0]["lane"]))
    notes_sorted = [n for n, _ in combined]
    ids_sorted = [i for _, i in combined]
    return notes_sorted, ids_sorted, new_used


def generate_all_difficulties(analysis, base_seed):
    duration = analysis["duration_sec"]
    usable_end = duration - OUTRO_BUFFER_SEC
    onsets = [o for o in analysis["onsets"] if o["time"] < usable_end]
    beat_times = analysis["beat_times"]
    downbeat_times = analysis["downbeat_times"]
    sections = analysis["sections"]

    strengths = [o["strength"] for o in onsets]
    thresholds = {
        "strong": percentile(strengths, 75),
        "medium": percentile(strengths, 55),
        "floor": percentile(strengths, 30),
    }

    used = set()
    notes, ids = [], []
    results = {}
    for layer_i, layer in enumerate(["easy", "normal", "hard"]):
        notes, ids, used = build_layer(
            layer, notes, ids, onsets, used, beat_times, downbeat_times, sections,
            thresholds, seed=base_seed + layer_i,
        )
        results[layer] = list(notes)  # snapshot - "hard" continues building on this list
    return results, thresholds


def summarize(notes):
    taps = sum(1 for n in notes if n["type"] == "tap")
    holds = sum(1 for n in notes if n["type"] == "hold")
    return {"total": len(notes), "tap": taps, "hold": holds}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate EASY/NORMAL/HARD charts from analysis.json")
    parser.add_argument("analysis", help="path to analysis.json")
    parser.add_argument("-o", "--out-dir", default=".", help="directory to write easy.json/normal.json/hard.json")
    parser.add_argument("--seed", type=int, default=136136, help="base RNG seed for reproducible lane/chord choices")
    args = parser.parse_args()

    with open(args.analysis, "r", encoding="utf-8") as f:
        analysis = json.load(f)

    results, thresholds = generate_all_difficulties(analysis, base_seed=args.seed)

    summary = {"thresholds": thresholds}
    for diff, notes in results.items():
        out_path = f"{args.out_dir}/{diff}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({
                "difficulty": diff.upper(),
                "bpm": analysis["bpm"],
                "duration_sec": analysis["duration_sec"],
                "notes": notes,
            }, f, ensure_ascii=False, indent=2)
        summary[diff] = summarize(notes)

    print(json.dumps(summary, ensure_ascii=False, indent=2), file=sys.stderr)
