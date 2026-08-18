import { LANE_COUNT, NOTE_TRAVEL_SEC } from "./constants.js";

// Crystal/hologram palette per lane - translucent plates with a bright rim,
// not flat black/white bars. Keep it to fill + one glow pass per note so
// this stays cheap enough for 60fps on iPhone Safari.
const LANE_PALETTES = [
  { core: "rgba(95,208,255,0.30)", rim: "rgba(160,225,255,0.95)", glow: "rgba(95,208,255,0.55)" },
  { core: "rgba(140,120,255,0.30)", rim: "rgba(190,175,255,0.95)", glow: "rgba(140,120,255,0.55)" },
  { core: "rgba(190,120,255,0.30)", rim: "rgba(220,180,255,0.95)", glow: "rgba(190,120,255,0.55)" },
  { core: "rgba(230,235,255,0.28)", rim: "rgba(245,248,255,0.95)", glow: "rgba(230,235,255,0.55)" },
];

// Draws the playfield onto a canvas that sits ABOVE the background video and
// the semi-transparent lane overlay (see index.html/css). This module only
// draws notes/judgement glow - the lane columns and judge pads themselves
// are plain CSS elements so the "background video -> translucent lanes ->
// notes/UI" stacking order required by the design is just normal DOM z-index.
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    // Must stay in sync with the `top: 86%` on .judge-pad in css/style.css.
    this.judgeLineRatio = 0.86;
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
          this._drawPlate(x, top, bottom - top, palette, note.state === "holding" ? 1 : 0.6);
        }
        continue;
      }

      const y = this.yForTime(note.time, currentTime);
      if (y < -30 || y > this.height + 30) continue;

      // faint motion trail (single extra translucent copy) for a sense of speed
      this._drawPlate(x, y - 16 - 10, 32, palette, 0.22, false);
      this._drawPlate(x, y - 16, 32, palette, 1, true);
    }
  }

  _drawPlate(x, y, h, palette, alphaMul, withGlow = true) {
    const ctx = this.ctx;
    const w = this.laneWidth * 0.76;
    const px = x + this.laneWidth * 0.12;
    ctx.save();
    ctx.globalAlpha = alphaMul;
    if (withGlow) {
      ctx.shadowColor = palette.glow;
      ctx.shadowBlur = 10;
    }
    const grad = ctx.createLinearGradient(px, y, px, y + h);
    grad.addColorStop(0, palette.core);
    grad.addColorStop(1, "rgba(255,255,255,0.05)");
    ctx.fillStyle = grad;
    roundRect(ctx, px, y, w, h, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = palette.rim;
    roundRect(ctx, px, y, w, h, 10);
    ctx.stroke();
    ctx.restore();
  }

  _drawJudgeLine(comboTier) {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(0, 0, this.width, 0);
    grad.addColorStop(0, "rgba(95,208,255,0.05)");
    grad.addColorStop(0.5, "rgba(200,220,255,0.9)");
    grad.addColorStop(1, "rgba(190,120,255,0.05)");
    ctx.save();
    ctx.shadowColor = "rgba(150,190,255,0.7)";
    ctx.shadowBlur = 6 + comboTier * 3;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, this.judgeY);
    ctx.lineTo(this.width, this.judgeY);
    ctx.stroke();
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
