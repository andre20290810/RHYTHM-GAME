#!/usr/bin/env python3
"""
Turns a song-agnostic analysis.json (produced by analyze_audio.py) into
playable EASY / NORMAL / HARD note charts for the RHYTHM-GAME piano-tile
engine.

Nothing here is specific to any one song - every decision is driven by the
numbers in analysis.json (onset times/strengths/categories/bands, the
beat/downbeat/8th/16th subdivision grid, bar-level repeated-pattern
clusters, section labels). Running this script against a different song's
analysis.json produces a different chart with the same code.

Design (v4 - percussion stays onset-first, harmonic goes phrase-first):
  PERCUSSIVE (kick/snare/perc_other) - unchanged from v3:
  - Selection is driven PRIMARILY by each onset's position on the rhythm
    grid (analysis.json's grid_class: downbeat/beat/8th/16th/off_grid) and
    its musical category, not by raw onset strength percentiles alone. A
    percussive onset has a real physical attack, so ITS OWN onset time is
    the musically meaningful moment - see onset_time_for_chart() for the
    selective quantization policy (snap only when the onset is close
    enough to its grid point to be measurement jitter; a deliberately
    pushed/pulled backbeat or a syncopated kick keeps its raw timing).
  - EASY = the song's rhythmic skeleton: kicks/snares on a downbeat/beat.
  - NORMAL = EASY, unchanged, PLUS the 8th-note groove layer and
    section-level percussive accents in the chorus/climax.
  - HARD = NORMAL, unchanged, PLUS meaningful 16th-note fills and
    deliberately off-grid kick/snare hits (real syncopation).

  HARMONIC (pads/vocals/sustained/atmospheric material) - v4 redesign:
  - This material frequently has NO clean attack at all (reverb, pads,
    long sustains), so treating "onset time" as automatically the right
    note time - the v3 approach - falls apart on ambient-leaning tracks.
    analyze_audio.py's resolve_phrase_anchor() instead evaluates, per
    harmonic phrase, THREE candidate moments (its own onset if any, its
    local RMS peak, its RMS-weighted phrase center) and scores each one on
    grid alignment AND local energy/phrase-presence together - never grid
    distance alone - keeping whichever is most musically natural. The
    chosen time is already fully resolved (grid-snapped, or deliberately
    left off-grid for a genuinely prominent moment) by the time it reaches
    this file, in analysis.json's harmonic_phrases[].
  - This applies to ALL harmonic phrases, not just ambient-labelled ones -
    a non-ambient section's vocal/pad accents get the same treatment,
    since even a driven section's harmonic layer rarely has a clean attack
    either. Percussive selection is completely unaffected.
  - Ambient bars (analysis.json's bars[].is_ambient) get a DELIBERATELY
    thinner harmonic layer at every difficulty - see AMBIENT_HARMONIC_
    GRID_LEVELS/HARMONIC_COMPOSITE_FLOOR/AMBIENT_PER_BAR_CAP below: EASY
    keeps only the strongest downbeat per ambient bar, NORMAL adds beat-
    level accents, HARD adds a capped handful of 8th-level accents and
    NEVER mechanically fills 16ths there. A quiet passage is allowed to
    stay quiet - "no note here" is an accepted, intended outcome, not a
    coverage gap.
  - Harmonic notes are always LOWER priority than kick/snare in a
    concurrency conflict (see musical_priority()) - percussion is the
    rhythmic backbone, harmonic notes are accents layered on top of it,
    never the other way around.
  - Repeated rhythmic phrases (see analysis.json's bar pattern_id/bar_slot)
    get a CONSISTENT lane the first time a given (pattern, slot, kick-or-
    snare-or-other) combination is placed, and reuse that lane on every
    later repeat - so a recurring figure maps to a recognizable finger
    pattern instead of re-randomizing lanes every repetition.
  - There is no note-count or notes-per-second target for either source.
    Each difficulty is built from a QUALITY-based candidate pool, and note
    count is whatever survives that pool plus the playability spacing
    rules - never a number to hit.
  - Long sustained harmonic phrases become hold notes instead of a burst
    of taps.
  - Chords (two simultaneous lanes) are reserved for strong downbeats in
    high-energy sections and are rationed per difficulty.
  - No note is ever placed after the song's usable end (outro buffer).
  - HOLD/tap concurrency rules (ALLOWED_HOLD_TAP_COMBOS) are applied LAST,
    exactly as before - none of the above changes how concurrent input is
    capped.
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
    },
    "normal": {
        "min_gap_global": 0.15,
        "min_gap_lane": 0.28,
        "max_consecutive_lane": 2,
        "hold_threshold": 0.70,
        "hold_convert_prob": 0.40,
        "chord_prob": 0.10,
        "downbeat_window": 0.07,
    },
    "hard": {
        "min_gap_global": 0.095,
        "min_gap_lane": 0.16,
        "max_consecutive_lane": 3,
        "hold_threshold": 0.55,
        "hold_convert_prob": 0.30,
        "chord_prob": 0.22,
        "downbeat_window": 0.10,
    },
}

OUTRO_BUFFER_SEC = 1.2
LANE_COUNT = 4
HIGH_ENERGY_SECTIONS = {"chorus", "climax"}

# How close an onset must be to its classified grid point (analysis.json's
# grid_class/grid_time/grid_offset) to be treated as measurement jitter and
# SNAPPED onto the grid, expressed as a fraction of the classification
# tolerance analyze_audio.py itself used to call it "on this grid level" in
# the first place (see classify_grid_position there). Anything further off
# than this - while still being *classified* as e.g. "beat" for selection
# purposes - keeps its own raw timing: a deliberately pushed/pulled
# backbeat or a syncopated kick is never dragged onto the grid. This is a
# conservative default (snap only the closest half of "on grid"); it is a
# selective policy, never a blanket quantize-everything pass.
SNAP_FRACTION = 0.5

# A note only actually needs a finger down during its judgeable window, not
# forever - mirrors JUDGE_WINDOWS_MS.GOOD from js/constants.js (140ms) as
# the "still a real hit, not a miss" window. Not importable across the
# JS/Python boundary, so kept in sync by hand; the game's own judge windows
# are never touched by this script, this is only how playability is
# estimated here.
GOOD_WINDOW_SEC = 0.14
# Mirrors RELEASE_TOLERANCE_SEC from js/game.js - releasing this close to a
# hold's tail still counts as a clean finish, so the lane is "in use" a
# little past its nominal end too.
RELEASE_TOLERANCE_SEC = 0.10
# Which (concurrent-holds, concurrent-taps) combinations a player may ever
# be asked for at once - see enforce_concurrency_cap(). A HOLD already ties
# up a hand for its whole duration, so at most one extra tap is fair while
# one HOLD is active, and none at all while two HOLDs are active; pure taps
# alone may stack up to 3 (a full chord), but 4 lanes at once never happens
# since nothing in this set sums past 3.
#   allowed:  tap / tap+tap / tap+tap+tap / HOLD / HOLD+tap / HOLD+HOLD
#   forbidden: HOLD+tap+tap, HOLD+HOLD+tap, HOLD+HOLD+HOLD, any 4-lane combo
ALLOWED_HOLD_TAP_COMBOS = {(0, 1), (0, 2), (0, 3), (1, 0), (1, 1), (2, 0)}


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


# Mirrors the tolerance fractions in analyze_audio.py's classify_grid_
# position() - SNAP_FRACTION of these is how close an onset must be to its
# grid point to actually get snapped (see onset_time_for_chart()).
def snap_tolerances(bpm):
    beat_period = 60.0 / bpm if bpm > 0 else 0.5
    return {
        "downbeat": beat_period * 0.18 * SNAP_FRACTION,
        "beat": beat_period * 0.18 * SNAP_FRACTION,
        "8th": beat_period * 0.5 * 0.22 * SNAP_FRACTION,
        "16th": beat_period * 0.25 * 0.30 * SNAP_FRACTION,
        "off_grid": 0.0,
    }


def onset_time_for_chart(o, tolerances):
    """The TIME this PERCUSSIVE onset's note is actually placed at: the
    exact grid time if the onset is close enough to be measurement jitter
    around a hit that WAS played on the grid, otherwise the onset's own raw
    detected time. Never touches o["time"] itself - that stays the raw
    measurement for provenance/offset-diagnostics. Harmonic candidates
    don't go through this - analysis.json's harmonic_phrases[].time is
    already fully resolved by resolve_phrase_anchor()."""
    gc = o.get("grid_class", "off_grid")
    if gc == "off_grid":
        return o["time"]
    tol = tolerances.get(gc, 0.0)
    if abs(o.get("grid_offset", 0.0)) <= tol:
        return o["grid_time"]
    return o["time"]


# Which grid levels a HARMONIC candidate is eligible at, split by whether
# its bar is ambient - ambient bars get a visibly thinner harmonic layer at
# every difficulty (see the module docstring); 16th-level harmonic
# candidates are never eligible in an ambient bar at any difficulty ("no
# mechanical 16th filling" in a quiet passage).
AMBIENT_HARMONIC_GRID_LEVELS = {
    "easy": {"downbeat"},
    "normal": {"downbeat", "beat"},
    "hard": {"downbeat", "beat", "8th"},
}
NORMAL_REGION_HARMONIC_GRID_LEVELS = {
    "easy": {"downbeat", "beat"},
    "normal": {"downbeat", "beat", "8th"},
    "hard": {"downbeat", "beat", "8th", "16th", "off_grid"},
}
# A harmonic candidate's own composite_score (see resolve_phrase_anchor in
# analyze_audio.py - grid alignment + local energy + phrase presence, NOT
# just onset strength) must clear this floor to be eligible. Ambient bars
# use a HIGHER floor than non-ambient ones at every difficulty - a quiet
# passage should only ever surface its most unmistakably present moments.
HARMONIC_COMPOSITE_FLOOR = {
    "easy": {"ambient": 0.55, "normal_region": 0.50},
    "normal": {"ambient": 0.48, "normal_region": 0.42},
    "hard": {"ambient": 0.45, "normal_region": 0.35},
}
# Hard per-bar cap on ambient-bar harmonic candidates for EASY/HARD (ties
# to "downbeat-only skeleton" / "a capped handful of 8th accents" - NORMAL
# has no explicit cap since the beat grid's own 4-per-bar ceiling already
# keeps it sparse).
AMBIENT_PER_BAR_CAP = {"easy": 1, "hard": 2}


def qualifies_percussive(layer, o, sections, thresholds):
    gc = o["grid_class"]
    cat = o["category"]
    strong = o["strength"] >= thresholds["strong"]
    medium = o["strength"] >= thresholds["medium"]
    floor_ok = o["strength"] >= thresholds["floor"]

    if layer == "easy":
        # The song's rhythmic skeleton: kicks/snares that land squarely on
        # a downbeat or beat - EASY alone should still let you feel the
        # song's basic pulse, not just "fewer random hits".
        return (cat == "kick" and gc in ("downbeat", "beat")) or (cat == "snare" and gc in ("downbeat", "beat"))
    if layer == "normal":
        # EASY's skeleton plus the 8th-note groove layer (the classic
        # "and"-of-the-beat kick/snare pattern) and chorus/climax section
        # accents from other percussive hits.
        return (
            (cat in ("kick", "snare") and gc == "8th")
            or (cat == "perc_other" and gc in ("beat", "8th") and strong and section_at(o["time"], sections) in HIGH_ENERGY_SECTIONS)
        )
    # hard
    if not floor_ok:
        return False
    # Meaningful 16th-note fills/detail, PLUS deliberately off-grid
    # kick/snare hits (real syncopation) - never every remaining weak
    # onset, still gated by a category/strength floor.
    return (
        (cat in ("kick", "snare") and gc == "16th")
        or (cat in ("kick", "snare") and gc == "off_grid" and medium)
        or (cat == "perc_other" and gc in ("beat", "8th", "16th") and strong)
    )


def qualifies_harmonic(layer, o):
    gc = o["grid_class"]
    region = "ambient" if o["is_ambient"] else "normal_region"
    levels = (AMBIENT_HARMONIC_GRID_LEVELS if o["is_ambient"] else NORMAL_REGION_HARMONIC_GRID_LEVELS)[layer]
    if gc == "off_grid" and layer != "hard":
        return False  # off-grid harmonic accents only ever appear at HARD
    if gc not in levels:
        return False
    return o["composite_score"] >= HARMONIC_COMPOSITE_FLOOR[layer][region]


def apply_ambient_harmonic_cap(layer, onsets, pool):
    cap = AMBIENT_PER_BAR_CAP.get(layer)
    if not cap:
        return pool
    by_bar = {}
    for i in pool:
        o = onsets[i]
        if o["category"] == "harmonic" and o["is_ambient"]:
            by_bar.setdefault(o["bar_index"], []).append(i)
    drop = set()
    for idxs in by_bar.values():
        if len(idxs) > cap:
            ranked = sorted(idxs, key=lambda i: -onsets[i]["composite_score"])
            drop.update(ranked[cap:])
    return [i for i in pool if i not in drop]


def build_candidate_pool(layer, onsets, used, sections, thresholds):
    """Onsets eligible to be ADDED at this layer. Percussive entries are
    keyed by RHYTHMIC ROLE (grid position + musical category), never by
    picking "the next N strongest" onsets. Harmonic entries (already
    phrase-resolved in analyze_audio.py) are keyed by grid level + their
    own composite musical-naturalness score, with ambient bars held to a
    visibly stricter standard. Already-used indices (placed in a lower
    layer) are excluded so a higher layer only ever adds NEW notes on top."""
    pool = []
    for i, o in enumerate(onsets):
        if i in used:
            continue
        if o["category"] == "harmonic":
            qualifies = qualifies_harmonic(layer, o)
        else:
            qualifies = qualifies_percussive(layer, o, sections, thresholds)
        if qualifies:
            pool.append(i)
    return apply_ambient_harmonic_cap(layer, onsets, pool)


# Priority order for resolving a 3+-lane conflict (see enforce_concurrency_
# cap): higher number = more important = kept; the loser is dropped.
#   1. downbeat / strong kick
#   2. major snare
#   3. phrase_start
#   4. other strong musical accent
#   5. auxiliary / fine onset
_PRIORITY_CHORD_SYNTHETIC = -1  # a chord's decorative 2nd note - sacrificed first
_PRIORITY_AUXILIARY = 1


def musical_priority(onset, thresholds):
    """Higher = more musically important = wins a 3+-lane conflict.
    Percussion is always the rhythmic backbone: kick/snare outrank every
    harmonic candidate unconditionally, so a harmonic accent can never
    bump a kick/snare hit out of the chart, only fill the space around
    it."""
    if onset is None:
        return _PRIORITY_CHORD_SYNTHETIC
    if onset["category"] == "kick":
        return 5 if onset["grid_class"] == "downbeat" else 4.5
    if onset["category"] == "snare":
        return 4
    if onset["category"] == "harmonic":
        return 2.5 if onset["grid_class"] == "downbeat" else 2.0
    if onset.get("phrase_start"):
        return 3
    if onset["strength"] >= thresholds["strong"]:
        return 2
    return _PRIORITY_AUXILIARY


def note_active_window(note):
    """[start, end) during which a lane must have a finger down for this
    note - a tap needs one only around its judge window, a hold needs one
    for its whole duration (plus a little slack at both ends)."""
    if note["type"] == "hold":
        return note["time"] - GOOD_WINDOW_SEC, note["time"] + note["duration"] + RELEASE_TOLERANCE_SEC
    return note["time"] - GOOD_WINDOW_SEC, note["time"] + GOOD_WINDOW_SEC


def enforce_concurrency_cap(notes, note_onset_ids, is_new, onsets, thresholds):
    """Drops notes so that no instant ever asks the player for a
    (concurrent-holds, concurrent-taps) combination outside
    ALLOWED_HOLD_TAP_COMBOS - counting a tap's judge window AND a hold's
    whole duration (start through RELEASE_TOLERANCE_SEC past its tail) as
    "this lane is occupied".

    notes/note_onset_ids/is_new are already time-sorted and share indices.
    Locked notes (is_new[i] is False) are NEVER dropped - a higher
    difficulty layer must not undo what a lower one already committed.
    When a locked note's own arrival would itself violate the allowed
    combo (because new-layer notes are occupying lanes around it), THIS
    layer's own new notes are evicted one at a time, weakest musical
    priority first, until the combo is valid again; a new-vs-new conflict
    is only resolved the same way when the new candidate outranks the
    weakest active. A dropped candidate's onset id is intentionally left
    in `used` (see build_layer) so it is never reconsidered at a higher
    difficulty either - it already lost this conflict against the very
    notes that persist into every higher layer.
    Returns the filtered (notes, note_onset_ids, is_new, dropped_count)."""
    active = []  # [{lane, end, priority, removable, idx, type}]
    removed = set()

    def priority_of(idx):
        oid = note_onset_ids[idx]
        onset = onsets[oid] if oid is not None else None
        return musical_priority(onset, thresholds)

    def combo_of(entries, cand_type):
        holds = sum(1 for a in entries if a["type"] == "hold") + (1 if cand_type == "hold" else 0)
        taps = sum(1 for a in entries if a["type"] == "tap") + (1 if cand_type == "tap" else 0)
        return holds, taps

    for idx, note in enumerate(notes):
        start, end = note_active_window(note)
        lane = note["lane"]
        active = [a for a in active if a["end"] > start and a["idx"] not in removed]
        others = [a for a in active if a["lane"] != lane]

        locked = not is_new[idx]
        this_priority = priority_of(idx) if not locked else float("inf")
        cur_others = others
        while combo_of(cur_others, note["type"]) not in ALLOWED_HOLD_TAP_COMBOS:
            removable = sorted((a for a in cur_others if a["removable"]), key=lambda a: a["priority"])
            if not removable:
                break
            weakest = removable[0]
            if not locked and this_priority <= weakest["priority"]:
                break
            removed.add(weakest["idx"])
            active = [a for a in active if a["idx"] != weakest["idx"]]
            cur_others = [a for a in cur_others if a["idx"] != weakest["idx"]]

        if combo_of(cur_others, note["type"]) not in ALLOWED_HOLD_TAP_COMBOS:
            if locked:
                # Can't drop a locked note and couldn't free enough room
                # (e.g. two locked notes are themselves the conflict) - by
                # construction this shouldn't happen since locked notes
                # already satisfied the rule among themselves when they
                # were built, but skip adding to `active` rather than lose
                # the note if it somehow does.
                pass
            else:
                removed.add(idx)
                continue

        active.append({
            "lane": lane, "end": end, "priority": priority_of(idx),
            "removable": is_new[idx], "idx": idx, "type": note["type"],
        })

    kept_notes, kept_ids, kept_is_new = [], [], []
    for idx, note in enumerate(notes):
        if idx in removed:
            continue
        kept_notes.append(note)
        kept_ids.append(note_onset_ids[idx])
        kept_is_new.append(is_new[idx])
    return kept_notes, kept_ids, kept_is_new, len(removed)


def pattern_key(o):
    """Identity used to remember/reuse a lane for a repeated rhythmic
    phrase (see analysis.json's bar pattern_id/bar_slot, built in
    analyze_audio.py's build_bar_patterns()). Grouped by kick/snare/other
    so a kick and a snare that happen to share a 16th-slot across
    repetitions don't fight over the same remembered lane."""
    if o.get("pattern_id", -1) < 0 or o.get("bar_slot", -1) < 0:
        return None
    cat = o["category"]
    group = "kick" if cat == "kick" else ("snare" if cat == "snare" else "other")
    return (o["pattern_id"], o["bar_slot"], group)


def build_layer(layer, prev_notes, prev_note_onset_ids, onsets, used, sections,
                 thresholds, pattern_lane_memory, seed):
    """Replays prev_notes (locked, never modified) in time order interleaved
    with this layer's new candidate onsets, applying spacing/hold/chord
    rules from this layer's config only to the NEW candidates. Returns the
    combined note list (superset of prev_notes) and the updated used-id set."""
    cfg = LAYER_CONFIG[layer]
    rng = random.Random(seed)
    candidate_ids = build_candidate_pool(layer, onsets, used, sections, thresholds)

    timeline = []
    for note, onset_id in zip(prev_notes, prev_note_onset_ids):
        timeline.append((note["time"], "locked", note, onset_id))
    for i in candidate_ids:
        chart_t = onsets[i]["_chart_time"]
        timeline.append((chart_t, "candidate", onsets[i], i))
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
    is_new = []
    new_used = set(used)

    def pick_band_lane(base_band, avoid=None):
        nonlocal last_lane, consecutive
        lane = base_band
        if avoid is not None and lane == avoid:
            lane = (lane + 1) % LANE_COUNT
        if lane == last_lane and consecutive >= cfg["max_consecutive_lane"]:
            choices = [l for l in range(LANE_COUNT) if l != last_lane and l != avoid]
            lane = rng.choice(choices)
        return lane

    def pick_lane(o):
        # Reuse the lane already established for this repeated rhythmic
        # phrase (see pattern_key) whenever one exists and it wouldn't
        # break the max-consecutive-same-lane rule; otherwise fall back to
        # the normal dominant-frequency-band pick, and remember the choice
        # for the NEXT repetition of this same (pattern, slot) - "the same
        # or a recognizable similar lane pattern", not forced monotony.
        pkey = pattern_key(o)
        remembered = pattern_lane_memory.get(pkey) if pkey else None
        if remembered is not None and not (remembered == last_lane and consecutive >= cfg["max_consecutive_lane"]):
            return pkey, remembered
        lane = pick_band_lane(o["band"])
        return pkey, lane

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
            is_new.append(False)
            continue

        o = obj
        pkey, lane = pick_lane(o)
        if t < lane_free_time[lane]:
            # remembered/preferred lane isn't free right now - one retry
            # against the plain band-based pick before giving up on this
            # onset entirely (spacing rules below still apply either way).
            lane = pick_band_lane(o["band"])
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
        is_new.append(True)
        new_used.add(onset_id)
        if pkey and pkey not in pattern_lane_memory:
            pattern_lane_memory[pkey] = lane
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
            and o["grid_class"] == "downbeat"
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
                is_new.append(True)
                lane_free_time[lane2] = t + cfg["min_gap_lane"]

    combined = list(zip(notes, note_onset_ids, is_new))
    combined.sort(key=lambda p: (p[0]["time"], p[0]["lane"]))
    notes_sorted = [n for n, _, _ in combined]
    ids_sorted = [i for _, i, _ in combined]
    is_new_sorted = [w for _, _, w in combined]

    # Final pass: no instant may require a (holds, taps) combination outside
    # ALLOWED_HOLD_TAP_COMBOS (tap judge windows + hold durations combined).
    # Only THIS layer's own new candidates (is_new_sorted[i] is True) can
    # ever be dropped here - notes carried in from a lower difficulty are
    # never touched, preserving EASY subset NORMAL subset HARD. This is the
    # LAST step applied, exactly as before the rhythm redesign.
    notes_sorted, ids_sorted, is_new_sorted, dropped = enforce_concurrency_cap(
        notes_sorted, ids_sorted, is_new_sorted, onsets, thresholds,
    )
    return notes_sorted, ids_sorted, new_used, dropped


def wrap_harmonic_candidate(p):
    """Adapts one already phrase-resolved analysis.json harmonic_phrases[]
    entry into the same onset-shaped dict build_layer()'s generic timeline
    machinery expects, so percussive onsets and harmonic candidates can
    share one unified candidate list/index space. `time` is already fully
    resolved (grid-snapped, or a deliberately kept off-grid moment) by
    resolve_phrase_anchor() - no further quantization happens here."""
    return {
        "time": p["time"],
        "_chart_time": p["time"],
        "band": p["band"],
        "category": "harmonic",
        "grid_class": p["grid_class"],
        "sustain": p["sustain"],
        "source": "harm",
        "phrase_start": False,
        "strength": p["composite_score"],
        "composite_score": p["composite_score"],
        "pattern_id": p["pattern_id"],
        "bar_index": p["bar_index"],
        "bar_slot": p["bar_slot"],
        "is_ambient": p["is_ambient"],
    }


def generate_all_difficulties(analysis, base_seed):
    duration = analysis["duration_sec"]
    usable_end = duration - OUTRO_BUFFER_SEC
    # Percussive candidates: real attacks, still selected/quantized by
    # their own onset time (see qualifies_percussive/onset_time_for_chart).
    # Harmonic-category raw onsets are EXCLUDED here - they're superseded
    # entirely by the phrase-resolved harmonic_phrases below.
    percussive_onsets = [
        o for o in analysis["onsets"]
        if o["time"] < usable_end and o["category"] in ("kick", "snare", "perc_other")
    ]
    sections = analysis["sections"]

    tolerances = snap_tolerances(analysis["bpm"])
    for o in percussive_onsets:
        o["_chart_time"] = onset_time_for_chart(o, tolerances)

    # Percentile thresholds are computed from PERCUSSIVE onset strength
    # only - harmonic candidates are gated by their own composite_score
    # scale instead (see HARMONIC_COMPOSITE_FLOOR), which measures
    # something different (grid alignment + phrase presence, not raw
    # onset strength) and would skew this distribution if mixed in.
    strengths = [o["strength"] for o in percussive_onsets]
    thresholds = {
        "strong": percentile(strengths, 75),
        "medium": percentile(strengths, 55),
        "floor": percentile(strengths, 30),
    }

    harmonic_candidates = [
        wrap_harmonic_candidate(p) for p in analysis.get("harmonic_phrases", [])
        if p["time"] < usable_end
    ]
    onsets = percussive_onsets + harmonic_candidates

    used = set()
    notes, ids = [], []
    results = {}
    conflicts = {}
    pattern_lane_memory = {}
    for layer_i, layer in enumerate(["easy", "normal", "hard"]):
        notes, ids, used, dropped = build_layer(
            layer, notes, ids, onsets, used, sections,
            thresholds, pattern_lane_memory, seed=base_seed + layer_i,
        )
        results[layer] = list(notes)  # snapshot - "hard" continues building on this list
        conflicts[layer] = dropped
    return results, thresholds, conflicts


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

    results, thresholds, conflicts = generate_all_difficulties(analysis, base_seed=args.seed)

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
        summary[diff]["concurrency_conflicts_resolved"] = conflicts[diff]

    print(json.dumps(summary, ensure_ascii=False, indent=2), file=sys.stderr)
