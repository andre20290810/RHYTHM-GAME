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
    if (note.type === "hold") {
      note.state = grade === "MISS" ? "missed" : "holding";
      if (note.state === "holding") this.activeHold[lane] = note;
    } else {
      note.state = "hit";
    }
    this._recordJudge(grade);
    this.lastJudge = { grade, lane, atSec: currentTime };
    return grade;
  }

  laneUp(lane, currentTime) {
    const hold = this.activeHold[lane];
    if (!hold || hold.state !== "holding") return;
    const tailTime = hold.time + hold.duration;
    if (currentTime < tailTime - RELEASE_TOLERANCE_SEC) {
      hold.state = "broken";
      this._recordJudge("MISS");
      this.lastJudge = { grade: "MISS", lane, atSec: currentTime };
    } else {
      hold.state = "completed";
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
