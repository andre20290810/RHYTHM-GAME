import { JUDGE_WINDOWS_MS, JUDGE_SCORE_WEIGHT, MAX_SCORE, RANK_THRESHOLDS, LANE_COUNT } from "./constants.js";

const RELEASE_TOLERANCE_SEC = 0.10; // releasing a hold within this much of the tail still counts as success

function judgeGrade(diffMs) {
  const a = Math.abs(diffMs);
  if (a <= JUDGE_WINDOWS_MS.PERFECT) return "PERFECT";
  if (a <= JUDGE_WINDOWS_MS.GREAT) return "GREAT";
  if (a <= JUDGE_WINDOWS_MS.GOOD) return "GOOD";
  if (a <= JUDGE_WINDOWS_MS.MISS) return "MISS";
  return null;
}

export class RhythmGame {
  constructor(chart) {
    this.notes = chart.notes.map((n, i) => ({
      id: i,
      time: n.time,
      lane: n.lane,
      type: n.type,
      duration: n.duration || 0,
      state: "pending", // pending -> hit/missed | holding -> completed/broken
      grade: null,
    }));
    this.totalNotes = this.notes.length;
    this.activeHold = new Array(LANE_COUNT).fill(null);
    // per-lane pending notes in time order, for O(1)-ish nearest lookup
    this.pendingByLane = Array.from({ length: LANE_COUNT }, () => []);
    this.notes.forEach((n) => this.pendingByLane[n.lane].push(n));

    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.judgeCounts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
    this.lastJudge = null; // for on-screen popup: { grade, lane, atSec }
    this.finished = false;

    // --- temporary real-device diagnostics (dev-only, additive) ---
    this.tapOffsets = []; // signed ms, (actualInputTime - note.time) * 1000, one entry per judged laneDown
    this.holdStats = { started: 0, completed: 0, broken: 0, pointerleaveBroken: 0 };
  }

  _recordJudge(grade) {
    this.judgeCounts[grade]++;
    if (grade === "MISS") {
      this.combo = 0;
    } else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }
    this.score += (MAX_SCORE / this.totalNotes) * JUDGE_SCORE_WEIGHT[grade];
  }

  /** Corrects a judgment already recorded via _recordJudge (e.g. a hold whose
   * head was judged PERFECT but which later breaks early), without double-
   * counting the note against totalNotes. */
  _reviseJudge(oldGrade, newGrade) {
    this.judgeCounts[oldGrade]--;
    this.score -= (MAX_SCORE / this.totalNotes) * JUDGE_SCORE_WEIGHT[oldGrade];
    this.judgeCounts[newGrade]++;
    this.score += (MAX_SCORE / this.totalNotes) * JUDGE_SCORE_WEIGHT[newGrade];
    this.combo = 0;
  }

  getTimingStats() {
    const n = this.tapOffsets.length;
    if (!n) return { avgMs: 0, medianMs: 0, earlyCount: 0, lateCount: 0 };
    const sum = this.tapOffsets.reduce((a, b) => a + b, 0);
    const sorted = [...this.tapOffsets].sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const medianMs = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const earlyCount = this.tapOffsets.filter((v) => v < 0).length;
    const lateCount = this.tapOffsets.filter((v) => v > 0).length;
    return { avgMs: sum / n, medianMs, earlyCount, lateCount };
  }

  /** Call every animation frame with the audio-clock time in seconds. */
  update(currentTime) {
    for (const lane of this.pendingByLane) {
      while (lane.length && lane[0].state === "pending" && currentTime - lane[0].time > JUDGE_WINDOWS_MS.MISS / 1000) {
        const note = lane.shift();
        note.state = "missed";
        note.grade = "MISS";
        this._recordJudge("MISS");
        this.lastJudge = { grade: "MISS", lane: note.lane, atSec: currentTime };
      }
    }
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const hold = this.activeHold[lane];
      if (hold && hold.state === "holding" && currentTime > hold.time + hold.duration) {
        hold.state = "completed";
        this.holdStats.completed++;
        this.activeHold[lane] = null;
      }
    }
    if (this.notes.length && this.notes.every((n) => n.state !== "pending" && n.state !== "holding")) {
      this.finished = true;
    }
  }

  laneDown(lane, currentTime) {
    const queue = this.pendingByLane[lane];
    if (!queue.length || queue[0].state !== "pending") return null;
    const note = queue[0];
    const diffMs = (currentTime - note.time) * 1000;
    const grade = judgeGrade(diffMs);
    if (grade === null) return null; // too early to judge yet, leave pending
    queue.shift();
    note.grade = grade;
    this.tapOffsets.push(diffMs);
    if (note.type === "hold") {
      note.state = grade === "MISS" ? "missed" : "holding";
      if (note.state === "holding") {
        this.activeHold[lane] = note;
        this.holdStats.started++;
      }
    } else {
      note.state = "hit";
    }
    this._recordJudge(grade);
    this.lastJudge = { grade, lane, atSec: currentTime };
    return grade;
  }

  /** @param {string} [reason] - the triggering DOM event type (e.g. "pointerup",
   * "pointercancel", "pointerleave", "keyup"), used only for diagnostics below;
   * does not change which events cause a release. */
  laneUp(lane, currentTime, reason) {
    const hold = this.activeHold[lane];
    if (!hold || hold.state !== "holding") return;
    const tailTime = hold.time + hold.duration;
    if (currentTime < tailTime - RELEASE_TOLERANCE_SEC) {
      hold.state = "broken";
      this._reviseJudge(hold.grade, "MISS");
      hold.grade = "MISS";
      this.holdStats.broken++;
      if (reason === "pointerleave") this.holdStats.pointerleaveBroken++;
      this.lastJudge = { grade: "MISS", lane, atSec: currentTime };
    } else {
      hold.state = "completed";
      this.holdStats.completed++;
    }
    this.activeHold[lane] = null;
  }

  getScoreRatio() {
    return Math.max(0, Math.min(1, this.score / MAX_SCORE));
  }

  getRank() {
    const ratio = this.getScoreRatio();
    return RANK_THRESHOLDS.find((r) => ratio >= r.min).rank;
  }
}
