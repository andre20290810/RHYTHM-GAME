#!/usr/bin/env python3
"""
Turns a song-agnostic analysis.json (produced by analyze_audio.py) into
playable EASY / NORMAL / HARD note charts for the RHYTHM-GAME piano-tile
engine.

Nothing here is specific to any one song - every decision is driven by the
numbers in analysis.json (onset times/strengths/bands, beat/downbeat times,
section labels). Running this script against a different song's
analysis.json produces a different chart with the same code.

Design rules (see project README for the full rationale):
  - Notes come ONLY from real detected onsets - never a fixed-interval grid.
  - Each difficulty has a target note density and is built by taking the
    highest-priority onsets (onset strength + a bonus for landing on a
    beat/downbeat) up to that density, then walking them in time order and
    enforcing playability limits (min gap between notes, max consecutive
    same-lane taps, no unplayable stacks).
  - Lane (0-3) is primarily driven by the onset's dominant frequency band
    (bass -> lane 0 .. treble -> lane 3), not randomness, so the chart
    tracks the actual instrumentation instead of being arbitrary.
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

DIFFICULTY_CONFIG = {
    "easy": {
        "density_per_sec": 1.05,
        "min_gap_global": 0.28,
        "min_gap_lane": 0.50,
        "max_consecutive_lane": 2,
        "hold_threshold": 0.90,
        "hold_convert_prob": 0.55,
        "chord_prob": 0.0,
        "beat_bonus": 0.45,
        "downbeat_bonus": 0.70,
        "candidate_pool_mult": 1.3,
    },
    "normal": {
        "density_per_sec": 2.15,
        "min_gap_global": 0.15,
        "min_gap_lane": 0.28,
        "max_consecutive_lane": 2,
        "hold_threshold": 0.70,
        "hold_convert_prob": 0.40,
        "chord_prob": 0.10,
        "beat_bonus": 0.25,
        "downbeat_bonus": 0.40,
        "candidate_pool_mult": 1.4,
    },
    "hard": {
        "density_per_sec": 3.70,
        "min_gap_global": 0.095,
        "min_gap_lane": 0.16,
        "max_consecutive_lane": 3,
        "hold_threshold": 0.55,
        "hold_convert_prob": 0.30,
        "chord_prob": 0.22,
        "beat_bonus": 0.12,
        "downbeat_bonus": 0.22,
        "candidate_pool_mult": 1.6,
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


def build_priorities(onsets, beat_times, downbeat_times, cfg):
    scored = []
    for o in onsets:
        pri = o["strength"]
        if nearest_dist(o["time"], downbeat_times) <= 0.06:
            pri += cfg["downbeat_bonus"]
        elif nearest_dist(o["time"], beat_times) <= 0.06:
            pri += cfg["beat_bonus"]
        scored.append((pri, o))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored


def generate_difficulty(name, analysis, seed):
    cfg = DIFFICULTY_CONFIG[name]
    duration = analysis["duration_sec"]
    usable_end = duration - OUTRO_BUFFER_SEC
    onsets = [o for o in analysis["onsets"] if o["time"] < usable_end]
    beat_times = analysis["beat_times"]
    downbeat_times = analysis["downbeat_times"]
    sections = analysis["sections"]

    target_count = int(cfg["density_per_sec"] * duration)
    scored = build_priorities(onsets, beat_times, downbeat_times, cfg)
    pool_size = min(len(scored), int(target_count * cfg["candidate_pool_mult"]))
    pool = sorted((o for _, o in scored[:pool_size]), key=lambda o: o["time"])

    rng = random.Random(seed)
    lane_free_time = [0.0] * LANE_COUNT
    global_last_time = -999.0
    last_lane = -1
    consecutive = 0
    notes = []

    def pick_lane(base_band, at_time, avoid=None):
        nonlocal last_lane, consecutive
        lane = base_band
        if avoid is not None and lane == avoid:
            lane = (lane + 1) % LANE_COUNT
        if lane == last_lane and consecutive >= cfg["max_consecutive_lane"]:
            choices = [l for l in range(LANE_COUNT) if l != last_lane and l != avoid]
            lane = rng.choice(choices)
        return lane

    for o in pool:
        t = o["time"]
        lane = pick_lane(o["band"], t)

        if t < lane_free_time[lane]:
            continue  # lane still busy (e.g. mid-hold)
        is_chord_partner_of_prev = notes and abs(notes[-1]["time"] - t) < 0.02
        if not is_chord_partner_of_prev and (t - global_last_time) < cfg["min_gap_global"]:
            continue

        is_hold = (
            o.get("sustain", 0.0) >= cfg["hold_threshold"]
            and o["source"] == "harm"
            and rng.random() < cfg["hold_convert_prob"]
        )
        note = {"time": round(t, 3), "lane": lane, "type": "hold" if is_hold else "tap"}
        if is_hold:
            dur = min(o["sustain"], usable_end - t)
            if dur < 0.15:
                is_hold = False
                note["type"] = "tap"
            else:
                note["duration"] = round(dur, 3)

        notes.append(note)
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
            and nearest_dist(t, downbeat_times) <= 0.06
            and section_at(t, sections) in HIGH_ENERGY_SECTIONS
            and o["strength"] > 0.7
            and rng.random() < cfg["chord_prob"]
        )
        if can_chord:
            other_lanes = [l for l in range(LANE_COUNT) if l != lane and t >= lane_free_time[l]]
            if other_lanes:
                lane2 = rng.choice(other_lanes)
                notes.append({"time": round(t, 3), "lane": lane2, "type": "tap"})
                lane_free_time[lane2] = t + cfg["min_gap_lane"]

    notes.sort(key=lambda n: (n["time"], n["lane"]))
    return notes


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

    summary = {}
    for i, diff in enumerate(["easy", "normal", "hard"]):
        notes = generate_difficulty(diff, analysis, seed=args.seed + i)
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
