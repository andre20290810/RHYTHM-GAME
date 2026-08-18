import { LANE_COUNT, NOTE_TRAVEL_SEC } from "./constants.js";

const LANE_COLORS = ["#4fd1ff", "#8f7bff", "#ff7bd0", "#ffd166"];

// Draws the playfield onto a canvas that sits ABOVE the background video and
// the semi-transparent lane overlay (see index.html/css). This module only
// draws notes/judgement line - the lane columns themselves are plain CSS
// elements so the "background video -> translucent lanes -> notes/UI"
// stacking order required by the design is just normal DOM z-index.
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.judgeLineRatio = 0.86; // judge line at 86% of playfield height
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

  draw(currentTime, game) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // judgement line
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, this.judgeY);
    ctx.lineTo(this.width, this.judgeY);
    ctx.stroke();

    for (const note of game.notes) {
      if (note.state === "hit" || note.state === "missed" || note.state === "completed" || note.state === "broken") {
        continue;
      }
      const color = LANE_COLORS[note.lane % LANE_COLORS.length];
      const x = note.lane * this.laneWidth;

      if (note.type === "hold") {
        const headY = this.yForTime(note.time, currentTime);
        const tailY = this.yForTime(note.time + note.duration, currentTime);
        if (tailY > -40) {
          const top = Math.min(headY, tailY);
          const bottom = Math.max(headY, tailY, top + 18);
          ctx.fillStyle = hexToRgba(color, note.state === "holding" ? 0.85 : 0.55);
          roundRect(ctx, x + this.laneWidth * 0.12, top, this.laneWidth * 0.76, bottom - top, 12);
          ctx.fill();
        }
        continue;
      }

      const y = this.yForTime(note.time, currentTime);
      if (y < -30 || y > this.height + 30) continue;
      ctx.fillStyle = color;
      roundRect(ctx, x + this.laneWidth * 0.12, y - 16, this.laneWidth * 0.76, 32, 10);
      ctx.fill();
    }
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

function hexToRgba(hex, alpha) {
  const v = hex.replace("#", "");
  const r = parseInt(v.substring(0, 2), 16);
  const g = parseInt(v.substring(2, 4), 16);
  const b = parseInt(v.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
