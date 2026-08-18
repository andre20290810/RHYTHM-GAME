import { LANE_COUNT, NOTE_TRAVEL_SEC } from "./constants.js";

// Quiet, low-saturation crystal palette per lane - thin glass shards, not
// bright neon bars. Kept to a fill + one soft glow pass per note so this
// stays cheap enough for 60fps on iPhone Safari.
const LANE_PALETTES = [
  { core: "rgba(180,200,255,0.22)", rim: "rgba(220,230,255,0.55)", glow: "rgba(150,175,255,0.32)" },
  { core: "rgba(200,190,255,0.20)", rim: "rgba(225,220,255,0.55)", glow: "rgba(180,165,255,0.30)" },
  { core: "rgba(215,195,255,0.18)", rim: "rgba(230,220,255,0.55)", glow: "rgba(195,175,255,0.28)" },
  { core: "rgba(235,235,250,0.20)", rim: "rgba(248,248,255,0.60)", glow: "rgba(220,225,255,0.32)" },
];

// Draws the playfield onto a canvas that sits ABOVE the background and the
// hairline lane dividers (see index.html/css). This module only draws
// notes and the judge-line "membrane of light" - the lane columns and tap
// pads are plain CSS elements so the "background -> translucent lanes ->
// notes/UI" stacking order is just normal DOM z-index.
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    // Must stay in sync with the `top: 82%` on .judge-pad in css/style.css.
    this.judgeLineRatio = 0.82;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.laneWidth = this.width / LANE_COUNT;
    this.judgeY = this.height * this.judgeLineRatio;
  }

  yForTime(time, currentTime) {
    const progress = (time - currentTime) / NOTE_TRAVEL_SEC; // 1 at spawn, 0 at judge line
    return this.judgeY * (1 - progress);
  }

  draw(currentTime, game, comboTier = 0) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this._drawJudgeLine(comboTier);

    for (const note of game.notes) {
      if (note.state === "hit" || note.state === "missed" || note.state === "completed" || note.state === "broken") {
        continue;
      }
      const palette = LANE_PALETTES[note.lane % LANE_PALETTES.length];
      const x = note.lane * this.laneWidth;

      if (note.type === "hold") {
        const headY = this.yForTime(note.time, currentTime);
        const tailY = this.yForTime(note.time + note.duration, currentTime);
        if (tailY > -40) {
          const top = Math.min(headY, tailY);
          const bottom = Math.max(headY, tailY, top + 18);
          this._drawShard(x, top, bottom - top, palette, note.state === "holding" ? 1 : 0.55);
        }
        continue;
      }

      const y = this.yForTime(note.time, currentTime);
      if (y < -30 || y > this.height + 30) continue;
      this._drawShard(x, y - 15, 30, palette, 1);
    }
  }

  _drawShard(x, y, h, palette, alphaMul) {
    const ctx = this.ctx;
    const w = this.laneWidth * 0.62;
    const px = x + (this.laneWidth - w) / 2;
    ctx.save();
    ctx.globalAlpha = alphaMul;
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 7;
    const grad = ctx.createLinearGradient(px, y, px, y + h);
    grad.addColorStop(0, palette.core);
    grad.addColorStop(1, "rgba(255,255,255,0.04)");
    ctx.fillStyle = grad;
    roundRect(ctx, px, y, w, h, 9);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = palette.rim;
    roundRect(ctx, px, y, w, h, 9);
    ctx.stroke();
    ctx.restore();
  }

  _drawJudgeLine(comboTier) {
    const ctx = this.ctx;
    const h = 10 + comboTier * 1.5;
    const grad = ctx.createLinearGradient(0, this.judgeY - h / 2, 0, this.judgeY + h / 2);
    grad.addColorStop(0, "rgba(220,230,255,0)");
    grad.addColorStop(0.5, `rgba(225,232,255,${0.16 + comboTier * 0.05})`);
    grad.addColorStop(1, "rgba(220,230,255,0)");
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, this.judgeY - h / 2, this.width, h);
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
