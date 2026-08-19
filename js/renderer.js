import { LANE_COUNT, NOTE_TRAVEL_SEC } from "./constants.js";

// Tap notes are drawn from the user's own arrow-icon artwork (untouched
// pixels - only the on-screen draw size is scaled, aspect ratio locked).
// Loaded once and reused for every note/frame; never re-fetched per draw.
const NOTE_ICON_WIDTH_RATIO = 0.62; // fraction of one lane's width
const ARROW_BLUE_SRC = "assets/notes/note-blue.png";
const ARROW_GREEN_SRC = "assets/notes/note-hit-green.png";

// Per-grade strength of the success flash (icon hold time + sparkle count
// and duration). MISS never reaches this table - see triggerHitEffect().
const HIT_EFFECT_BY_GRADE = {
  PERFECT: { iconSec: 0.32, sparkleSec: 0.48, sparkleCount: 8, glow: 1.0, flashSec: 0.12 },
  GREAT: { iconSec: 0.26, sparkleSec: 0.36, sparkleCount: 6, glow: 0.75, flashSec: 0.08 },
  GOOD: { iconSec: 0.18, sparkleSec: 0.22, sparkleCount: 3, glow: 0.45, flashSec: 0 },
};

function loadImage(src) {
  const img = new Image();
  img.src = src;
  return img;
}

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

    // Preloaded once at startup so drawImage() never re-decodes per frame.
    this.arrowBlueImg = loadImage(ARROW_BLUE_SRC);
    this.arrowGreenImg = loadImage(ARROW_GREEN_SRC);

    // Short-lived success flashes triggered by triggerHitEffect(); each
    // entry is { lane, grade, startTime, cfg }, pruned once fully faded.
    this.hitEffects = [];
  }

  /** Called right after a tap note is judged (grade !== null && !== "MISS"). */
  triggerHitEffect(lane, grade, currentTime) {
    const cfg = HIT_EFFECT_BY_GRADE[grade];
    if (!cfg) return; // MISS (or unknown grade) shows no success flash
    this.hitEffects.push({ lane, grade, startTime: currentTime, cfg });
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

    this._drawLaneDividers(comboTier);

    for (const note of game.notes) {
      if (note.state === "hit" || note.state === "missed" || note.state === "completed" || note.state === "broken") {
        continue;
      }
      const x = note.lane * this.laneWidth;

      if (note.type === "hold") {
        const headY = this.yForTime(note.time, currentTime);
        const tailY = this.yForTime(note.time + note.duration, currentTime);
        // Gate on the HEAD only (same rule as a tap note) - gating on the
        // tail here used to hide the whole note, head included, until the
        // tail's own far-future spawn point, which for any hold longer
        // than NOTE_TRAVEL_SEC meant it popped in with no warning at all.
        if (headY < -60 || tailY > this.height + 60) continue;
        this._drawHoldNote(x, headY, tailY, note, currentTime);
        continue;
      }

      const y = this.yForTime(note.time, currentTime);
      if (y < -44 || y > this.height + 44) continue;
      this._drawFallingArrow(x, y, note, currentTime);
    }

    this._drawHitEffects(currentTime);
    this._drawJudgeLine(comboTier);
  }

  // 4 straight play lanes read as flat; a slight top-narrower / bottom-
  // wider taper on the (thin, quiet) boundary lines gives a sense of depth
  // - "lanes floating in the scene" - without any real 3D transform work.
  // Only the 3 internal boundaries are drawn; the screen edges already
  // frame the outer lanes.
  _drawLaneDividers(comboTier) {
    const ctx = this.ctx;
    const perspective = 0.10; // fraction pulled toward center at the very top
    const centerX = this.width / 2;
    const alpha = 0.14 + comboTier * 0.05;
    ctx.save();
    ctx.strokeStyle = `rgba(215,226,255,${alpha})`;
    ctx.shadowColor = "rgba(160,190,255,0.4)";
    ctx.shadowBlur = 3 + comboTier * 1.5;
    ctx.lineWidth = 1;
    for (let i = 1; i < LANE_COUNT; i++) {
      const bx = i * this.laneWidth;
      const tx = centerX + (bx - centerX) * (1 - perspective);
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.lineTo(bx, this.height);
      ctx.stroke();
    }
    ctx.restore();
  }

  _proximityBoost(centerY) {
    // 0 at spawn -> 1 right at the judge line, eased so the last ~35% of
    // the fall is where the brightening becomes noticeable.
    const t = 1 - Math.min(1, Math.max(0, Math.abs(centerY - this.judgeY) / this.judgeY));
    return Math.max(0, t - 0.4) / 0.6;
  }

  // HOLD notes get their own visual language, not the tap arrow alone and
  // not a plain bar: a blue-arrow HEAD (the same icon as a tap note) with
  // an upward energy ribbon running to a small crystal TAIL marker, so the
  // note reads as "press and hold this far" as soon as any part of it is
  // on screen - not a bare head with zero warning it needs a long press.
  //
  // Gating in draw() only requires the HEAD to be on screen (see the
  // `headY < -60` check there); the ribbon/tail simply get canvas-clipped
  // until they scroll into view on their own, same as any other falling
  // element - no separate visibility bug to introduce here.
  _drawHoldNote(x, headY, tailY, note, currentTime) {
    const ctx = this.ctx;
    const img = this.arrowBlueImg;
    const size = this._arrowDrawSize(img);
    const cx = x + this.laneWidth / 2;
    const holding = note.state === "holding";
    const boost = this._proximityBoost(headY);
    const ribbonW = this.laneWidth * 0.22;
    const bandTop = Math.max(tailY, -4);
    const bandBottom = headY;
    const bandLen = Math.max(1, bandBottom - bandTop);

    ctx.save();

    // the ribbon: a soft vertical gradient, brighter near the head and
    // brighter still while actually being held correctly
    const baseAlpha = holding ? 0.5 : 0.28;
    const ribbonGrad = ctx.createLinearGradient(cx, bandTop, cx, bandBottom);
    ribbonGrad.addColorStop(0, `rgba(150,190,255,${baseAlpha * 0.35})`);
    ribbonGrad.addColorStop(1, `rgba(180,210,255,${baseAlpha})`);
    ctx.fillStyle = ribbonGrad;
    ctx.fillRect(cx - ribbonW / 2, bandTop, ribbonW, bandBottom - bandTop);

    // thin bright core line down the middle
    ctx.strokeStyle = `rgba(230,240,255,${holding ? 0.85 : 0.55})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, bandTop);
    ctx.lineTo(cx, bandBottom);
    ctx.stroke();

    // energy flowing along the ribbon toward the head - 2 soft glints
    // recomputed from a time-based phase each frame, no particle pool
    const flowSpeed = holding ? 2.2 : 1.4;
    for (let i = 0; i < 2; i++) {
      const phase = ((currentTime * flowSpeed + i * 0.5 + note.id * 0.13) % 1 + 1) % 1;
      const py = bandTop + phase * bandLen;
      const pulseGrad = ctx.createRadialGradient(cx, py, 0, cx, py, ribbonW * 1.3);
      pulseGrad.addColorStop(0, `rgba(255,255,255,${holding ? 0.55 : 0.3})`);
      pulseGrad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = pulseGrad;
      ctx.beginPath();
      ctx.arc(cx, py, ribbonW * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // ribbon clipped by the top edge gets a soft fade cap instead of an
    // abrupt cutoff - reads as "this continues upward, keep watching"
    if (tailY < 0) {
      const capLen = Math.min(40, bandLen);
      const capGrad = ctx.createLinearGradient(cx, 0, cx, capLen);
      capGrad.addColorStop(0, `rgba(190,215,255,${holding ? 0.5 : 0.3})`);
      capGrad.addColorStop(1, "rgba(190,215,255,0)");
      ctx.fillStyle = capGrad;
      ctx.fillRect(cx - ribbonW / 2, 0, ribbonW, capLen);
    }

    // a brief, quiet glow the moment the head first enters the screen
    if (headY > -60 && headY < -20 && size) {
      const t = (headY + 60) / 40;
      const r = size.w * (0.9 - 0.3 * t);
      const introGrad = ctx.createRadialGradient(cx, headY, 0, cx, headY, r);
      introGrad.addColorStop(0, `rgba(200,225,255,${0.25 * (1 - t)})`);
      introGrad.addColorStop(1, "rgba(200,225,255,0)");
      ctx.fillStyle = introGrad;
      ctx.beginPath();
      ctx.arc(cx, headY, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // TAIL marker - a small crystal terminal, drawn once it is on screen
    if (tailY >= -20 && tailY <= this.height + 20) {
      const tr = holding ? 7.5 : 6;
      ctx.save();
      ctx.shadowColor = "rgba(190,220,255,0.8)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = `rgba(225,238,255,${holding ? 0.95 : 0.75})`;
      ctx.beginPath();
      ctx.moveTo(cx, tailY - tr);
      ctx.lineTo(cx + tr * 0.62, tailY);
      ctx.lineTo(cx, tailY + tr);
      ctx.lineTo(cx - tr * 0.62, tailY);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // HEAD - the same blue arrow icon as a tap note, brighter and softly
    // pulsing while actively (correctly) held
    if (size) {
      ctx.globalAlpha = 1;
      ctx.shadowColor = holding ? "rgba(180,215,255,0.9)" : "rgba(160,200,255,0.6)";
      ctx.shadowBlur = (holding ? 8 : 4) + boost * (holding ? 9 : 6);
      ctx.drawImage(img, cx - size.w / 2, headY - size.h / 2, size.w, size.h);

      if (holding) {
        const pulse = 0.5 + 0.5 * Math.sin(currentTime * 6 + note.id);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.18 + pulse * 0.14;
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath();
        ctx.arc(cx, headY, size.w * 0.55, 0, Math.PI * 2);
        ctx.fill();

        // weak glow where the held lane meets the judge line
        ctx.globalAlpha = 0.25 + pulse * 0.15;
        const lineGlow = ctx.createRadialGradient(cx, this.judgeY, 0, cx, this.judgeY, size.w * 0.6);
        lineGlow.addColorStop(0, "rgba(210,230,255,0.7)");
        lineGlow.addColorStop(1, "rgba(210,230,255,0)");
        ctx.fillStyle = lineGlow;
        ctx.beginPath();
        ctx.arc(cx, this.judgeY, size.w * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // Arrow's on-screen size for a given lane, aspect ratio locked to the
  // source PNG's own dimensions (no cropping/stretching of the artwork).
  _arrowDrawSize(img) {
    if (!img.naturalWidth) return null; // not decoded yet this frame
    const w = this.laneWidth * NOTE_ICON_WIDTH_RATIO;
    const h = w * (img.naturalHeight / img.naturalWidth);
    return { w, h };
  }

  // Falling tap-note visual: the user's own blue arrow icon plus a quiet
  // Canvas-only glow/afterimage/particle treatment that gets a little
  // stronger as the note nears the judge line. The source image's pixels
  // are never filtered or tinted - only drawImage()'d at a fixed size.
  _drawFallingArrow(x, y, note, currentTime) {
    const img = this.arrowBlueImg;
    const size = this._arrowDrawSize(img);
    if (!size) return;
    const ctx = this.ctx;
    const cx = x + this.laneWidth / 2;
    const cy = y;
    const boost = this._proximityBoost(cy);
    const t = currentTime + note.id; // cheap per-note phase, no stored state

    ctx.save();

    // soft halo behind the icon, brightening on approach
    const haloR = size.w * (0.55 + boost * 0.25);
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, `rgba(150,195,255,${0.22 + boost * 0.22})`);
    halo.addColorStop(1, "rgba(150,195,255,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();

    // short backward (upward) afterimage - two faint ghost copies, cheaper
    // than a blur filter and just as readable as "a light trail"
    ctx.globalAlpha = 0.10;
    ctx.drawImage(img, cx - size.w / 2, cy - size.h * 1.35 - size.h / 2, size.w, size.h);
    ctx.globalAlpha = 0.16;
    ctx.drawImage(img, cx - size.w / 2, cy - size.h * 0.7 - size.h / 2, size.w, size.h);

    // a couple of tiny trailing light particles, cheap deterministic motion
    ctx.globalAlpha = 0.5 + boost * 0.3;
    ctx.fillStyle = "rgba(210,230,255,0.9)";
    for (let i = 0; i < 2; i++) {
      const wobble = Math.sin(t * 5 + i * 2.1) * size.w * 0.12;
      const py = cy - size.h * (0.55 + i * 0.35);
      ctx.beginPath();
      ctx.arc(cx + wobble, py, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // weak pulsating glow layered under the icon center
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    ctx.globalAlpha = 0.12 + boost * 0.18 + pulse * 0.08;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(cx, cy, size.w * 0.18, 0, Math.PI * 2);
    ctx.fill();

    // the icon itself - untouched pixels, size-only scale, glow only
    // right near the judge line so shadowBlur stays rare, not per-frame-always
    ctx.globalAlpha = 1;
    if (boost > 0) {
      ctx.shadowColor = "rgba(160,200,255,0.7)";
      ctx.shadowBlur = 4 + boost * 6;
    }
    ctx.drawImage(img, cx - size.w / 2, cy - size.h / 2, size.w, size.h);

    ctx.restore();
  }

  // Success flashes: the green icon briefly replaces the blue one at the
  // judge line, with a short white flash + star/cross sparkle burst around
  // it. Strength (icon hold time, sparkle count, glow) scales with grade.
  // Nothing is stored across frames beyond the small hitEffects list -
  // each burst is recomputed from (progress, count), never pooled objects.
  _drawHitEffects(currentTime) {
    if (!this.hitEffects.length) return;
    const ctx = this.ctx;
    const img = this.arrowGreenImg;
    const size = this._arrowDrawSize(img);
    this.hitEffects = this.hitEffects.filter((fx) => {
      const elapsed = currentTime - fx.startTime;
      const life = Math.max(fx.cfg.iconSec, fx.cfg.sparkleSec);
      if (elapsed < 0 || elapsed > life) return false;

      const cx = fx.lane * this.laneWidth + this.laneWidth / 2;
      const cy = this.judgeY;

      if (size && elapsed <= fx.cfg.iconSec) {
        const t = elapsed / fx.cfg.iconSec;
        ctx.save();
        ctx.globalAlpha = 1 - t * 0.35;
        ctx.shadowColor = "rgba(170,255,210,0.85)";
        ctx.shadowBlur = 10 * fx.cfg.glow;
        ctx.drawImage(img, cx - size.w / 2, cy - size.h / 2, size.w, size.h);
        ctx.restore();
      }

      if (fx.cfg.flashSec && elapsed <= fx.cfg.flashSec) {
        const t = elapsed / fx.cfg.flashSec;
        ctx.save();
        const r = (size ? size.w : this.laneWidth * 0.5) * (0.3 + t * 0.5);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `rgba(255,255,255,${0.55 * (1 - t)})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (elapsed <= fx.cfg.sparkleSec) {
        this._drawSparkleBurst(cx, cy, elapsed / fx.cfg.sparkleSec, fx.cfg.sparkleCount);
      }

      return true;
    });
  }

  // A handful of small star/cross-shaped glints expanding outward from a
  // success flash, then fading.
  _drawSparkleBurst(cx, cy, progress, count) {
    const ctx = this.ctx;
    const spread = 6 + progress * 26;
    const fade = 1 - progress;
    const colors = ["rgba(255,255,255,0.95)", "rgba(200,230,255,0.9)", "rgba(190,255,220,0.85)"];
    ctx.save();
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + progress * 1.5;
      const px = cx + Math.cos(angle) * spread;
      const py = cy + Math.sin(angle) * spread;
      const r = (1.5 + (i % 3)) * (0.5 + fade * 0.5);
      ctx.globalAlpha = fade;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r * 0.35, py - r * 0.35);
      ctx.lineTo(px + r, py);
      ctx.lineTo(px + r * 0.35, py + r * 0.35);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px - r * 0.35, py + r * 0.35);
      ctx.lineTo(px - r, py);
      ctx.lineTo(px - r * 0.35, py - r * 0.35);
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
