import { LANE_COUNT, NOTE_TRAVEL_SEC } from "./constants.js";

// Glowing crystal-tile palette per lane - white/blue/violet, not flat
// neon bars. Kept to a fill + one glow pass per note so this stays cheap
// enough for 60fps on iPhone Safari even over a busy background video.
const LANE_PALETTES = [
  { core: "rgba(200,220,255,0.42)", rim: "rgba(225,238,255,0.95)", glow: "rgba(150,190,255,0.55)", spark: "rgba(255,255,255,0.95)" },
  { core: "rgba(190,205,255,0.42)", rim: "rgba(215,225,255,0.95)", glow: "rgba(140,170,255,0.55)", spark: "rgba(255,255,255,0.95)" },
  { core: "rgba(205,195,255,0.42)", rim: "rgba(228,220,255,0.95)", glow: "rgba(180,150,255,0.55)", spark: "rgba(255,255,255,0.95)" },
  { core: "rgba(225,215,255,0.42)", rim: "rgba(240,232,255,0.95)", glow: "rgba(200,175,255,0.55)", spark: "rgba(255,255,255,0.95)" },
];

// Draws the playfield onto a canvas that sits ABOVE the background video
// and the lane dividers, but BELOW the tap-key DOM elements (see
// index.html/css). Notes are drawn as glowing crystal tiles that get a
// little brighter as they approach the judge line, so "how close am I"
// reads clearly even over a bright, busy video background.
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

    for (const note of game.notes) {
      if (note.state === "hit" || note.state === "missed" || note.state === "completed" || note.state === "broken") {
        continue;
      }
      const palette = LANE_PALETTES[note.lane % LANE_PALETTES.length];
      const x = note.lane * this.laneWidth;

      if (note.type === "hold") {
        const headY = this.yForTime(note.time, currentTime);
        const tailY = this.yForTime(note.time + note.duration, currentTime);
        if (tailY > -50) {
          const top = Math.min(headY, tailY);
          const bottom = Math.max(headY, tailY, top + 22);
          this._drawTile(x, top, bottom - top, palette, note.state === "holding" ? 1 : 0.6, false);
        }
        continue;
      }

      const y = this.yForTime(note.time, currentTime);
      if (y < -36 || y > this.height + 36) continue;
      this._drawTile(x, y - 18, 36, palette, 1, true);
    }

    this._drawJudgeLine(comboTier);
  }

  _proximityBoost(centerY) {
    // 0 at spawn -> 1 right at the judge line, eased so the last ~35% of
    // the fall is where the brightening becomes noticeable.
    const t = 1 - Math.min(1, Math.max(0, Math.abs(centerY - this.judgeY) / this.judgeY));
    return Math.max(0, t - 0.4) / 0.6;
  }

  _drawTile(x, y, h, palette, alphaMul, withSpark) {
    const ctx = this.ctx;
    const w = this.laneWidth * 0.82;
    const px = x + (this.laneWidth - w) / 2;
    const boost = this._proximityBoost(y + h / 2);

    ctx.save();
    ctx.globalAlpha = alphaMul;

    // outer glow
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 12 + boost * 10;
    const grad = ctx.createLinearGradient(px, y, px, y + h);
    grad.addColorStop(0, palette.core);
    grad.addColorStop(0.5, `rgba(255,255,255,${0.10 + boost * 0.12})`);
    grad.addColorStop(1, palette.core);
    ctx.fillStyle = grad;
    roundRect(ctx, px, y, w, h, 10);
    ctx.fill();

    // bright rim
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.6 + boost * 0.8;
    ctx.strokeStyle = palette.rim;
    roundRect(ctx, px, y, w, h, 10);
    ctx.stroke();

    // small crystal spark in the center
    if (withSpark) {
      const cx = px + w / 2;
      const cy = y + h / 2;
      const r = 3 + boost * 2.5;
      ctx.globalAlpha = 0.55 + boost * 0.4;
      ctx.fillStyle = palette.spark;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.6, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r * 0.6, cy);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  _drawJudgeLine(comboTier) {
    const ctx = this.ctx;
    const h = 3 + comboTier * 0.6;
    const glowH = 26 + comboTier * 4;

    ctx.save();

    // soft glow band behind the line
    const bandGrad = ctx.createLinearGradient(0, this.judgeY - glowH / 2, 0, this.judgeY + glowH / 2);
    bandGrad.addColorStop(0, "rgba(180,200,255,0)");
    bandGrad.addColorStop(0.5, `rgba(200,210,255,${0.10 + comboTier * 0.03})`);
    bandGrad.addColorStop(1, "rgba(180,200,255,0)");
    ctx.fillStyle = bandGrad;
    ctx.fillRect(0, this.judgeY - glowH / 2, this.width, glowH);

    // crisp silver -> blue-violet light line
    const lineGrad = ctx.createLinearGradient(0, 0, this.width, 0);
    lineGrad.addColorStop(0, "rgba(150,180,255,0.35)");
    lineGrad.addColorStop(0.5, "rgba(240,244,255,0.95)");
    lineGrad.addColorStop(1, "rgba(190,150,255,0.45)");
    ctx.shadowColor = "rgba(210,220,255,0.8)";
    ctx.shadowBlur = 8 + comboTier * 2;
    ctx.fillStyle = lineGrad;
    ctx.fillRect(0, this.judgeY - h / 2, this.width, h);
    ctx.shadowBlur = 0;

    // a brighter point where each lane crosses the line
    for (let i = 0; i <= LANE_COUNT; i++) {
      const cx = i * this.laneWidth;
      const r = 5 + comboTier * 1.2;
      const dotGrad = ctx.createRadialGradient(cx, this.judgeY, 0, cx, this.judgeY, r);
      dotGrad.addColorStop(0, "rgba(255,255,255,0.9)");
      dotGrad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = dotGrad;
      ctx.beginPath();
      ctx.arc(cx, this.judgeY, r, 0, Math.PI * 2);
      ctx.fill();
    }

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
