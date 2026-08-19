// Central tuning constants for the rhythm engine.
// Nothing here is specific to any one song - only gameplay feel.
export const JUDGE_WINDOWS_MS = {
  PERFECT: 45,
  GREAT: 90,
  GOOD: 140,
  MISS: 180, // beyond this the note is simply not judged as a hit
};

export const JUDGE_SCORE_WEIGHT = {
  PERFECT: 1.0,
  GREAT: 0.7,
  GOOD: 0.4,
  MISS: 0.0,
};

export const LANE_COUNT = 4;
export const LANE_KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"];

// Seconds a note takes to travel from the top of the lane to the judgement
// line. Bigger = notes fall slower / more reaction time. Raised from 1.6
// to 1.8 for more general breathing room; combined with the pre-roll
// lead-in in main.js (PRE_ROLL_SEC), this is what lets even the chart's
// very first note get a real look before it's judged. Purely a rendering
// constant - js/game.js never reads it, so this never touches judge timing.
export const NOTE_TRAVEL_SEC = 1.8;

// Max achievable score (classic rhythm-game convention: always normalized
// to the same ceiling regardless of how many notes a chart has).
export const MAX_SCORE = 1000000;

export const RANK_THRESHOLDS = [
  { rank: "S", min: 0.95 },
  { rank: "A", min: 0.90 },
  { rank: "B", min: 0.80 },
  { rank: "C", min: 0.60 },
  { rank: "D", min: 0.0 },
];
