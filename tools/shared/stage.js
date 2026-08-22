// Shared dev-only helpers for the note-design/implementation prototypes
// under tools/. Re-exports real production constants and copies the real
// yForTime()/judge-line formulas straight from js/renderer.js so every
// prototype's "gap in pixels" math can never silently drift from what the
// actual game renders. Nothing here is imported by production code.
import { LANE_COUNT, NOTE_TRAVEL_SEC } from "../../js/constants.js";

export { LANE_COUNT, NOTE_TRAVEL_SEC };

// Matches renderer.js's this.judgeLineRatio = 0.82.
export const JUDGE_RATIO = 0.82;

// The real, tightest worst-case moments extracted directly from
// songs/devil-in-the-fire/charts/hard.json (verified via direct Python
// analysis of the chart JSON - never invented, never widened):
//   pair: tightest same-lane consecutive pair (global minimum dt).
//   triplet: a real consecutive same-lane triplet with small individual
//     gaps (79.610-79.447=0.163s, 79.935-79.610=0.325s).
//   adjacentSimultaneous: a real same-time, different-lane pair.
//   holdWithAdjacent: a real HOLD plus the real adjacent taps that fall
//     around it in other lanes.
export const REAL_CHART = {
  pair: { lane: 0, times: [69.288, 69.451] },
  triplet: { lane: 2, times: [79.447, 79.610, 79.935] },
  adjacentSimultaneous: {
    notes: [
      { lane: 0, time: 24.787 },
      { lane: 1, time: 24.787 },
    ],
  },
  holdWithAdjacent: {
    hold: { lane: 1, time: 65.863, duration: 0.813 },
    adjacentTaps: [
      { lane: 2, time: 65.863 },
      { lane: 2, time: 66.305 },
      { lane: 0, time: 66.644 },
    ],
  },
  // The single longest real HOLD in hard.json (1.103s), with the real
  // adjacent-lane taps that fall during it AND a same-lane follow-up tap
  // just 0.092s after the hold ends - verified via direct analysis of
  // hard.json, not synthesized/widened.
  longHoldWithTaps: {
    hold: { lane: 2, time: 96.131, duration: 1.103 },
    taps: [
      { lane: 0, time: 96.572 },
      { lane: 3, time: 96.943 },
      { lane: 3, time: 97.135 },
      { lane: 2, time: 97.326 },
    ],
  },
};

// Builds a real-physics stage for a WxH canvas: judgeY/laneW derived the
// same way renderer.js derives them, yForTime() copied verbatim from
// renderer.js's this.yForTime(time, currentTime).
export function makeStage(W, H) {
  const judgeY = H * JUDGE_RATIO;
  const laneW = W / LANE_COUNT;

  function yForTime(time, currentTime) {
    const progress = (time - currentTime) / NOTE_TRAVEL_SEC;
    return judgeY * (1 - progress);
  }

  function laneCenterX(lane) {
    return lane * laneW + laneW / 2;
  }

  // 0 (far from judge line) .. 1 (exactly on the judge line) - used to
  // drive the same kind of closeness-based glow boost renderer.js uses.
  function closenessFor(y) {
    return 1 - Math.min(1, Math.max(0, Math.abs(y - judgeY) / judgeY));
  }

  function drawStage(ctx, activeLanes = [], bgColor = "#050608") {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    // lane dividers
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let i = 1; i < LANE_COUNT; i++) {
      const bx = i * laneW;
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, H);
      ctx.stroke();
    }

    // judge line
    ctx.strokeStyle = "rgba(255,210,160,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, judgeY);
    ctx.lineTo(W, judgeY);
    ctx.stroke();

    // judge pads (52px ring, matches css/style.css's tap-key sizing)
    const activeSet = new Set(activeLanes);
    for (let i = 0; i < LANE_COUNT; i++) {
      const cx = laneCenterX(i);
      const active = activeSet.has(i);
      ctx.beginPath();
      ctx.arc(cx, judgeY, 26, 0, Math.PI * 2);
      ctx.strokeStyle = active ? "rgba(255,190,120,0.85)" : "rgba(255,255,255,0.18)";
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.stroke();
    }
  }

  return { judgeY, laneW, yForTime, laneCenterX, closenessFor, drawStage };
}

// ---------- fractal "lightning bolt" generator (dev-only VFX helper,
// reused across several prior prototypes; kept here since some of this
// round's files still import it) ----------
export function generateBolt(x0, y0, x1, y1, displace, detail, rng) {
  const r = rng || Math.random;
  if (displace < detail) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];
  const mx = (x0 + x1) / 2 + (r() * 2 - 1) * displace;
  const my = (y0 + y1) / 2 + (r() * 2 - 1) * displace;
  const left = generateBolt(x0, y0, mx, my, displace / 2, detail, r);
  const right = generateBolt(mx, my, x1, y1, displace / 2, detail, r);
  return left.slice(0, -1).concat(right);
}

export function strokeBoltPath(ctx, points) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}
