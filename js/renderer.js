import { LANE_COUNT, NOTE_TRAVEL_SEC } from "./constants.js";

// Every note element (falling tap notes, the HOLD head, and success
// flashes) shares one drawn-not-pasted "crystal shard" shape - a
// horizontal faceted lozenge, not a rounded rectangle, not an arrow icon,
// not an octagon badge. Nothing here is an image; every pixel is Canvas
// path/gradient/stroke/shadowBlur, so it always sits correctly over
// whatever the background video is doing underneath it.
const NOTE_W_RATIO = 0.66; // shard width as a fraction of one lane's width
const NOTE_ASPECT = 0.46; // height = width * this - keeps it "wide, not tall"
const HOLD_RIBBON_W_RATIO = 0.4; // HOLD body width as a fraction of lane width - wide enough to read as a body, not a thin line

// Explicit per-note particle/echo budget so a busy HARD chart can't creep
// this up over time - kept small and fixed regardless of chart density.
// A falling tap note draws at most: 1 halo + MAX_TRAIL_ECHOES shard
// echoes + MAX_TRAIL_PARTICLES light specks + 1 occasional arc flicker +
// the shard core itself (fill/rim/facet/core, 4 draws) - roughly a dozen
// draw calls per note per frame, independent of how many notes are
// on-screen at once. See _drawCrystalNote().
const MAX_TRAIL_ECHOES = 3;
const MAX_TRAIL_PARTICLES = 4;

// Per-grade strength of the success burst (core-flare/ring hold time,
// sparkle/ember count, duration). MISS never reaches this table - see
// triggerHitEffect(). sparkleCount + emberCount is the max particle count
// for a single success burst (PERFECT: 10 + 6 = 16) - short-lived
// (<=0.55s) and only ever one at a time per lane, so this budget is kept
// separate from (and larger than) the continuous per-falling-note one.
const HIT_EFFECT_BY_GRADE = {
  PERFECT: { flareSec: 0.34, ringSec: 0.32, ring2Sec: 0.5, sparkleSec: 0.55, sparkleCount: 10, emberCount: 6, glow: 1.0, flashSec: 0.14 },
  GREAT: { flareSec: 0.27, ringSec: 0.26, ring2Sec: 0, sparkleSec: 0.4, sparkleCount: 7, emberCount: 3, glow: 0.75, flashSec: 0.09 },
  GOOD: { flareSec: 0.18, ringSec: 0.16, ring2Sec: 0, sparkleSec: 0.24, sparkleCount: 4, emberCount: 0, glow: 0.45, flashSec: 0 },
};

// ---------- Per-song note themes ----------
// Selected via manifest.noteTheme (see Renderer.setNoteTheme(), called
// from js/main.js once the current song's manifest is known) - NOT a
// per-song-name branch in the drawing code itself. "default" is the
// original drawn V-shaped crystal shard used everywhere until now
// (Nijiiro Eden and every song without its own theme); its hitColors
// below are copied byte-for-byte from what _drawHitEffects/_drawSparkle
// Burst/_drawEmbers already hardcoded, so the default theme's visuals are
// pixel-identical to before this system existed. A theme with a
// `tapImageSrc` swaps the falling regular-tap-note artwork (and, if
// `themedHoldHead` is set, the HOLD head too) for that image via Canvas
// drawImage - deterministic scale/opacity/glow/sway only, the artwork
// itself is never redrawn or regenerated. HOLD bodies/tails/collar rings
// are NEVER themed, so a HOLD stays unambiguously a HOLD regardless of
// song. `explosiveHit` adds an extra radiating-burst layer on PERFECT/
// GREAT (see _drawRadiantBurst) on top of the shared flare/ring/sparkle/
// ember system every theme already uses.
const NOTE_THEMES = {
  default: {
    tapImageSrc: null,
    hitColors: {
      flareCore: "rgba(235,255,248,",
      flareMid: "rgba(190,255,225,",
      ring: "rgba(205,255,232,0.9)",
      ring2: "rgba(220,255,240,0.85)",
      ringShadow: "rgba(180,255,220,0.8)",
      sparkle: ["rgba(255,255,255,0.95)", "rgba(200,230,255,0.9)", "rgba(190,255,220,0.85)"],
      ember: ["rgba(215,255,235,0.9)", "rgba(200,225,255,0.9)"],
    },
    explosiveHit: false,
  },
  "devil-in-the-fire": {
    // "Blue light veil" - a collection of blue-white light gathering into
    // a dense base and unraveling upward into a long wavering afterglow
    // (see tools/note-proto-v4/light-veil-v1-1.svg, the approved
    // prototype this PNG was rasterized from - deterministic SVG->PNG,
    // no image-generation AI). Drawn at a FIXED pixel width (see
    // tapImageWidthPx) rather than scaled to the lane, per the approved
    // draw-size comparison - deliberately larger than the lane so it
    // reads as a real light effect, not a small icon. tapImageAnchorFrac
    // is how far down the image (as a fraction of its own height) the
    // bright base/judge point sits - measured from the actual asset
    // (brightest-row analysis), not guessed, so the judge point lines up
    // with the note's true (x,y) regardless of draw size.
    tapImageSrc: "assets/notes/devil-in-the-fire-light-veil.png",
    tapImageWidthPx: 128,
    tapImageAnchorFrac: 0.973,
    themedHoldHead: true,
    hitColors: {
      flareCore: "rgba(235,248,255,",
      flareMid: "rgba(140,205,255,",
      ring: "rgba(150,210,255,0.9)",
      ring2: "rgba(190,230,255,0.85)",
      ringShadow: "rgba(110,190,255,0.85)",
      sparkle: ["rgba(255,255,255,0.95)", "rgba(140,200,255,0.9)", "rgba(80,165,255,0.85)"],
      ember: ["rgba(160,220,255,0.9)", "rgba(90,175,255,0.9)"],
    },
    explosiveHit: true,
  },
};

// Builds the path for ONE slender crystal blade - side -1 is the left
// blade, +1 is the right. Each blade is its own thin, tapered shard
// (pointed at both ends, bulging slightly in the middle) leaning inward
// from an outer-top corner down toward a point near the bottom-center.
// Two of these, mirrored, are what form the note's V silhouette - never
// drawn as a single bare "V" glyph/triangle/arrow. Centered at (cx, cy)
// within the given bounding width/height; callers fill/stroke it.
function shardBladePath(ctx, cx, cy, w, h, side) {
  const topX = cx + side * w * 0.46, topY = cy - h * 0.58;
  const outX = cx + side * w * 0.30, outY = cy - h * 0.02;
  const tipX = cx + side * w * 0.05, tipY = cy + h * 0.6;
  const inX = cx + side * w * 0.11, inY = cy + h * 0.12;
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(outX, outY);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(inX, inY);
  ctx.closePath();
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

    // Short-lived success flashes triggered by triggerHitEffect(); each
    // entry is { lane, grade, startTime, cfg }, pruned once fully faded.
    this.hitEffects = [];

    this.theme = NOTE_THEMES.default;
    this._themeImages = {};
  }

  /** Selects the drawing theme for regular tap notes + success-hit colors
   * (see NOTE_THEMES) - called from js/main.js with the current song's
   * manifest.noteTheme once a song is chosen. Unknown/missing theme names
   * fall back to "default" (the original crystal shard), never throw. */
  setNoteTheme(name) {
    const theme = NOTE_THEMES[name] || NOTE_THEMES.default;
    this.theme = theme;
    if (theme.tapImageSrc && !this._themeImages[theme.tapImageSrc]) {
      const img = new Image();
      img.src = theme.tapImageSrc;
      this._themeImages[theme.tapImageSrc] = img;
    }
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
      this._drawCrystalNote(x, y, note, currentTime);
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

  // HOLD notes get their own visual language, not the tap crystal alone and
  // not a plain bar: the same drawn crystal-shard HEAD (see shardBladePath)
  // as a tap note, plus a small collar ring where an upward energy ribbon
  // attaches and runs to a small crystal TAIL marker - so the note reads
  // as "press and hold this far" as soon as any part of it is on screen,
  // not a bare head with zero warning it needs a long press.
  //
  // Gating in draw() only requires the HEAD to be on screen (see the
  // `headY < -60` check there); the ribbon/tail simply get canvas-clipped
  // until they scroll into view on their own, same as any other falling
  // element - no separate visibility bug to introduce here.
  _drawHoldNote(x, headY, tailY, note, currentTime) {
    const ctx = this.ctx;
    const cx = x + this.laneWidth / 2;
    const holding = note.state === "holding";
    const headBoost = this._proximityBoost(headY);
    const tailBoost = this._proximityBoost(tailY);
    const headW = this.laneWidth * NOTE_W_RATIO;
    const headH = headW * NOTE_ASPECT;
    const ribbonW = this.laneWidth * HOLD_RIBBON_W_RATIO;
    const bandTop = Math.max(tailY, -4);
    const bandBottom = headY;
    const bandLen = Math.max(1, bandBottom - bandTop);

    ctx.save();

    // while correctly held, the whole lane gets a soft vertical energy
    // wash behind everything else - not "a bit brighter", a lane-wide
    // glow that reads instantly as "this lane is active" (item 4)
    if (holding) {
      const laneGlow = ctx.createLinearGradient(cx, bandTop, cx, bandBottom);
      laneGlow.addColorStop(0, "rgba(150,190,255,0.03)");
      laneGlow.addColorStop(1, "rgba(170,205,255,0.16)");
      ctx.fillStyle = laneGlow;
      ctx.fillRect(x + this.laneWidth * 0.06, bandTop, this.laneWidth * 0.88, bandBottom - bandTop);
    }

    // BODY: a wide ribbon with two bright rim edges plus a bright core
    // line - its own silhouette has to read as "long press this far" even
    // before the player notices the head, not just a decorated head with
    // a thin line trailing off (item 2/3)
    const baseAlpha = holding ? 0.62 : 0.32;
    const ribbonGrad = ctx.createLinearGradient(cx, bandTop, cx, bandBottom);
    ribbonGrad.addColorStop(0, `rgba(150,190,255,${baseAlpha * 0.4})`);
    ribbonGrad.addColorStop(1, `rgba(190,205,255,${baseAlpha})`);
    ctx.fillStyle = ribbonGrad;
    ctx.fillRect(cx - ribbonW / 2, bandTop, ribbonW, bandBottom - bandTop);

    ctx.strokeStyle = `rgba(220,235,255,${holding ? 0.75 : 0.42})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - ribbonW / 2, bandTop);
    ctx.lineTo(cx - ribbonW / 2, bandBottom);
    ctx.moveTo(cx + ribbonW / 2, bandTop);
    ctx.lineTo(cx + ribbonW / 2, bandBottom);
    ctx.stroke();

    ctx.strokeStyle = `rgba(235,244,255,${holding ? 0.9 : 0.6})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx, bandTop);
    ctx.lineTo(cx, bandBottom);
    ctx.stroke();

    // energy flowing along the body toward the head - 2 soft glints
    // recomputed from a time-based phase each frame, no particle pool
    const flowSpeed = holding ? 2.6 : 1.4;
    for (let i = 0; i < 2; i++) {
      const phase = ((currentTime * flowSpeed + i * 0.5 + note.id * 0.13) % 1 + 1) % 1;
      const py = bandTop + phase * bandLen;
      const pulseGrad = ctx.createRadialGradient(cx, py, 0, cx, py, ribbonW * 0.9);
      pulseGrad.addColorStop(0, `rgba(255,255,255,${holding ? 0.65 : 0.32})`);
      pulseGrad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = pulseGrad;
      ctx.beginPath();
      ctx.arc(cx, py, ribbonW * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }

    // body clipped by the top edge gets a soft fade cap instead of an
    // abrupt cutoff - reads as "this continues upward, keep watching"
    if (tailY < 0) {
      const capLen = Math.min(40, bandLen);
      const capGrad = ctx.createLinearGradient(cx, 0, cx, capLen);
      capGrad.addColorStop(0, `rgba(190,215,255,${holding ? 0.55 : 0.32})`);
      capGrad.addColorStop(1, "rgba(190,215,255,0)");
      ctx.fillStyle = capGrad;
      ctx.fillRect(cx - ribbonW / 2, 0, ribbonW, capLen);
    }

    // a brief, quiet glow the moment the head first enters the screen
    if (headY > -60 && headY < -20) {
      const t = (headY + 60) / 40;
      const r = headW * (0.9 - 0.3 * t);
      const introGrad = ctx.createRadialGradient(cx, headY, 0, cx, headY, r);
      introGrad.addColorStop(0, `rgba(200,225,255,${0.25 * (1 - t)})`);
      introGrad.addColorStop(1, "rgba(200,225,255,0)");
      ctx.fillStyle = introGrad;
      ctx.beginPath();
      ctx.arc(cx, headY, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // TAIL: an explicit end-gate, not just a small marker - a glowing bar
    // with inward brackets ("here is where it ends") plus a small crystal
    // terminal. Brightens on its own as it nears the judge line, and once
    // RELEASE becomes viable it pulses in sync with a matching flash on
    // the judge line itself, so "let go now" reads as one unmistakable
    // cue (item 3). RELEASE_TOLERANCE_SEC in game.js is untouched - this
    // is a purely visual approach cue, not a judge-timing change.
    if (tailY >= -20 && tailY <= this.height + 20) {
      const gateW = ribbonW * 2.1;
      const releasePulse = tailBoost > 0.55 ? (tailBoost - 0.55) / 0.45 : 0; // 0..1, only in the final approach
      const syncPhase = 0.5 + 0.5 * Math.sin(currentTime * 9);
      const gateAlpha = (holding ? 0.85 : 0.6) + releasePulse * syncPhase * 0.4;

      ctx.save();
      ctx.shadowColor = "rgba(190,220,255,0.85)";
      ctx.shadowBlur = 5 + tailBoost * 8;
      ctx.strokeStyle = `rgba(225,240,255,${gateAlpha})`;
      ctx.lineWidth = 2 + tailBoost;
      ctx.beginPath();
      ctx.moveTo(cx - gateW / 2, tailY);
      ctx.lineTo(cx + gateW / 2, tailY);
      ctx.stroke();
      const bracket = 5 + tailBoost * 3;
      ctx.beginPath();
      ctx.moveTo(cx - gateW / 2, tailY - bracket);
      ctx.lineTo(cx - gateW / 2, tailY + bracket);
      ctx.moveTo(cx + gateW / 2, tailY - bracket);
      ctx.lineTo(cx + gateW / 2, tailY + bracket);
      ctx.stroke();
      ctx.restore();

      const tr = (holding ? 6.5 : 5.5) + tailBoost * 2;
      ctx.save();
      ctx.shadowColor = "rgba(190,220,255,0.8)";
      ctx.shadowBlur = 4 + tailBoost * 6;
      ctx.fillStyle = `rgba(230,240,255,${gateAlpha})`;
      ctx.beginPath();
      ctx.moveTo(cx, tailY - tr);
      ctx.lineTo(cx + tr * 0.62, tailY);
      ctx.lineTo(cx, tailY + tr);
      ctx.lineTo(cx - tr * 0.62, tailY);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // synchronized flash on the judge line itself, right as RELEASE
      // becomes viable - ties the tail and the judge line together
      if (releasePulse > 0) {
        ctx.save();
        ctx.globalAlpha = releasePulse * syncPhase * 0.5;
        const syncGlow = ctx.createRadialGradient(cx, this.judgeY, 0, cx, this.judgeY, headW * 0.55);
        syncGlow.addColorStop(0, "rgba(225,240,255,0.9)");
        syncGlow.addColorStop(1, "rgba(225,240,255,0)");
        ctx.fillStyle = syncGlow;
        ctx.beginPath();
        ctx.arc(cx, this.judgeY, headW * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // a small bright collar ring where the body meets the HEAD - the one
    // shape detail a tap note never has, so a HOLD head is identifiable
    // at a glance even though it shares the same crystal silhouette. For
    // a themedHoldHead theme the head image's own bright base already
    // sits almost exactly at headY (see tapImageAnchorFrac), so the ring
    // belongs right at that base rather than at the default crystal's
    // much shorter headH/2 offset - otherwise it floats far above a tall
    // 128px head image instead of sitting at the collar.
    const themedHead = this.theme.themedHoldHead && this.theme.tapImageSrc;
    const collarY = themedHead ? headY - 4 : headY - headH * 0.5;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `rgba(225,240,255,${holding ? 0.9 : 0.6})`;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.ellipse(cx, collarY, ribbonW * 0.6, ribbonW * 0.26, 0, 0, Math.PI * 2);
    ctx.stroke();

    // HEAD - the same falling-note art as a themed tap note (or the drawn
    // crystal shard for the default theme), brighter and softly pulsing
    // while actively (correctly) held. Its own judge point (see
    // tapImageAnchorFrac) still lands exactly on headY regardless of
    // theme, so the actual hit position/timing is untouched.
    ctx.shadowColor = holding ? "rgba(180,215,255,0.9)" : "rgba(160,200,255,0.6)";
    const headGlowW = themedHead ? this.theme.tapImageWidthPx : headW;
    if (themedHead) {
      this._drawThemedHoldHead(cx, headY, note, currentTime, holding, headBoost);
    } else {
      this._drawShardCore(cx, headY, headW, headH, holding ? 1.7 : 1, headBoost);
    }

    if (holding) {
      const pulse = 0.5 + 0.5 * Math.sin(currentTime * 6 + note.id);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.22 + pulse * 0.18;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(cx, headY, headGlowW * 0.6, 0, Math.PI * 2);
      ctx.fill();

      // glow where the held lane meets the judge line - a clearly
      // stronger baseline than the falling state so "currently holding
      // correctly" is unmistakable, not just "a bit brighter" (item 4)
      ctx.globalAlpha = 0.32 + pulse * 0.2;
      const lineGlow = ctx.createRadialGradient(cx, this.judgeY, 0, cx, this.judgeY, headW * 0.7);
      lineGlow.addColorStop(0, "rgba(210,230,255,0.8)");
      lineGlow.addColorStop(1, "rgba(210,230,255,0)");
      ctx.fillStyle = lineGlow;
      ctx.beginPath();
      ctx.arc(cx, this.judgeY, headW * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // Renders the crystal-shard body: two slender blades (see
  // shardBladePath) leaning inward to a small glowing core where they
  // converge, forming a V silhouette - each blade gets its own glass fill
  // + bright rim + facet shine, so it reads as "two shards", not a single
  // flat glyph. Shared by every note element so a tap note, a HOLD head,
  // and a brighter-while-held HOLD head all read as the same material.
  // glowMul scales the rim glow/line-width (HOLD-while-holding uses a
  // stronger value); alphaBoost is the 0..1 judge-line-proximity term
  // from _proximityBoost().
  _drawShardCore(cx, cy, w, h, glowMul, alphaBoost) {
    const ctx = this.ctx;

    for (const side of [-1, 1]) {
      shardBladePath(ctx, cx, cy, w, h, side);

      const fillGrad = ctx.createLinearGradient(cx + side * w * 0.4, cy - h * 0.5, cx, cy + h * 0.5);
      fillGrad.addColorStop(0, `rgba(210,222,255,${0.16 + alphaBoost * 0.14})`);
      fillGrad.addColorStop(0.6, `rgba(255,255,255,${0.22 + alphaBoost * 0.2})`);
      fillGrad.addColorStop(1, `rgba(180,165,255,${0.20 + alphaBoost * 0.16})`);
      ctx.fillStyle = fillGrad;
      ctx.fill();

      ctx.shadowBlur = (5 + alphaBoost * 9) * glowMul;
      const rimGrad = ctx.createLinearGradient(cx + side * w * 0.46, cy - h * 0.58, cx, cy + h * 0.6);
      rimGrad.addColorStop(0, "rgba(170,200,255,0.85)");
      rimGrad.addColorStop(0.6, "rgba(245,248,255,0.98)");
      rimGrad.addColorStop(1, "rgba(200,175,255,0.9)");
      ctx.strokeStyle = rimGrad;
      ctx.lineWidth = (1.3 + alphaBoost * 0.7) * Math.min(1.4, glowMul);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // a short bright facet highlight along the blade's outer edge
      ctx.globalAlpha = 0.4 + alphaBoost * 0.3;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + side * w * 0.4, cy - h * 0.45);
      ctx.lineTo(cx + side * w * 0.24, cy - h * 0.1);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // small glowing core where the two blades converge, at the bottom
    // point of the V - not centered in the bounding box, right at the tip
    const coreY = cy + h * 0.58;
    const coreR = (2.6 + alphaBoost * 2.2) * Math.min(1.3, glowMul);
    ctx.save();
    ctx.shadowColor = "rgba(255,255,255,0.9)";
    ctx.shadowBlur = 4 + alphaBoost * 6;
    ctx.globalAlpha = 0.6 + alphaBoost * 0.3;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(cx, coreY - coreR);
    ctx.lineTo(cx + coreR * 0.6, coreY);
    ctx.lineTo(cx, coreY + coreR);
    ctx.lineTo(cx - coreR * 0.6, coreY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Falling tap-note visual: a drawn crystal shard (see shardBladePath /
  // _drawShardCore) - two slender blades converging into a V, in
  // blue/blue-violet/silver, translucent, faceted - plus a quiet
  // Canvas-only glow/echo/particle treatment that gets a little stronger
  // as the note nears the judge line. Nothing here is an image; every
  // pixel is path/gradient/stroke.
  _drawCrystalNote(x, y, note, currentTime) {
    if (this.theme.tapImageSrc) {
      const img = this._themeImages[this.theme.tapImageSrc];
      if (img && img.complete && img.naturalWidth) {
        this._drawThemedImageNote(x, y, note, currentTime, img);
        return;
      }
      // Still loading (or failed) - fall through to the default drawn
      // shard below rather than showing nothing for a frame.
    }

    const ctx = this.ctx;
    const cx = x + this.laneWidth / 2;
    const cy = y;
    const boost = this._proximityBoost(cy);
    const w = this.laneWidth * NOTE_W_RATIO;
    const h = w * NOTE_ASPECT;
    const t = currentTime + note.id; // cheap per-note phase, no stored state

    ctx.save();

    // soft halo behind the shard, brightening on approach - keeps it from
    // getting lost against a bright/busy background video
    const haloR = w * (0.62 + boost * 0.32);
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, `rgba(165,195,255,${0.22 + boost * 0.24})`);
    halo.addColorStop(1, "rgba(165,195,255,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();

    // longer upward light trail - MAX_TRAIL_ECHOES fainter/smaller copies
    // of the same shard shape (alternating blue-white / blue-violet), a
    // cheap vector redraw standing in for a blur trail (item 5)
    for (let i = 0; i < MAX_TRAIL_ECHOES; i++) {
      const echoScale = 1 - i * 0.14;
      const echoY = cy - h * (1.0 + i * 0.85);
      ctx.globalAlpha = (0.11 - i * 0.03) * (0.6 + boost * 0.4);
      ctx.fillStyle = i % 2 === 0 ? "rgba(190,210,255,1)" : "rgba(205,190,255,1)";
      for (const side of [-1, 1]) {
        shardBladePath(ctx, cx, echoY, w * echoScale, h * echoScale, side);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // MAX_TRAIL_PARTICLES tiny drifting light specks - fine light debris
    // caught in the shard's wake, deterministic per-note motion so
    // nothing needs to be stored between frames
    for (let i = 0; i < MAX_TRAIL_PARTICLES; i++) {
      const seed = i * 1.7;
      const wobble = Math.sin(t * 4.5 + seed) * w * (0.16 + i * 0.03);
      const py = cy - h * (0.9 + i * 0.55) - Math.abs(Math.sin(t * 2 + seed)) * h * 0.3;
      const r = 0.9 + (i % 2) * 0.6;
      ctx.globalAlpha = (0.32 + boost * 0.3) * (0.55 + 0.45 * Math.sin(t * 6 + seed));
      ctx.fillStyle = i % 2 === 0 ? "rgba(210,225,255,0.9)" : "rgba(200,185,255,0.9)";
      ctx.beginPath();
      ctx.arc(cx + wobble, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // a weak, occasional electric-arc flicker near the shard - only
    // visible a fraction of the time (deterministic per-note/per-time
    // gate, no timer state) so it reads as "weak" rather than a constant
    // buzz around every note
    if (Math.sin(t * 3.3 + note.id * 2.7) > 0.72) {
      const ay = cy - h * 0.1;
      ctx.globalAlpha = 0.35 + boost * 0.25;
      ctx.strokeStyle = "rgba(220,230,255,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.3, ay - h * 0.15);
      ctx.lineTo(cx - w * 0.12, ay + h * 0.08);
      ctx.lineTo(cx - w * 0.02, ay - h * 0.05);
      ctx.moveTo(cx + w * 0.3, ay + h * 0.1);
      ctx.lineTo(cx + w * 0.12, ay - h * 0.08);
      ctx.lineTo(cx + w * 0.02, ay + h * 0.05);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // the shard itself - glow only ramps up near the judge line so
    // shadowBlur stays rare, not a per-frame-always cost
    ctx.shadowColor = "rgba(170,195,255,0.75)";
    this._drawShardCore(cx, cy, w, h, 1, boost);

    ctx.restore();
  }

  // Themed falling tap-note visual for songs with a manifest.noteTheme
  // that sets tapImageSrc (currently DEVIL IN THE FIRE's blue-white
  // "light veil" PNG) - the attached artwork itself, drawn via Canvas
  // drawImage with only deterministic scale/opacity/glow/sway, never
  // redrawn or regenerated. Brightens and sways gently as it nears the
  // judge line. If the theme also sets themedHoldHead, the HOLD head
  // reuses this same art via _drawThemedHoldHead below; the HOLD body/
  // tail/collar ring are still NEVER themed, so a HOLD stays unambiguously
  // a HOLD regardless of song.
  _drawThemedImageNote(x, y, note, currentTime, img) {
    const ctx = this.ctx;
    const cx = x + this.laneWidth / 2;
    const cy = y;
    const boost = this._proximityBoost(cy);
    // Fixed pixel width when the theme specifies one (see the approved
    // draw-size comparison - DEVIL IN THE FIRE's light-veil deliberately
    // draws larger than the lane itself), falling back to the old lane-
    // relative sizing for any theme that doesn't set tapImageWidthPx.
    const w = this.theme.tapImageWidthPx || this.laneWidth * NOTE_W_RATIO;
    const aspect = img.naturalHeight / (img.naturalWidth || 1);
    const h = w * aspect;
    // Where the art's own bright base/judge point sits, as a fraction of
    // its height (measured from the actual asset, not guessed) - so the
    // judge point lands exactly on (cx, cy) regardless of draw size,
    // instead of the image's vertical center landing there.
    const anchorFrac = this.theme.tapImageAnchorFrac ?? 0.5;
    const topY = cy - h * anchorFrac;

    // Gentle per-note sway while falling ("落下中の弱い揺らぎ") - a few
    // px of horizontal drift, deterministic from time+id so nothing needs
    // to be stored between frames.
    const t = currentTime + note.id * 1.7;
    const sway = Math.sin(t * 1.6) * (w * 0.025);

    ctx.save();

    // soft halo behind the light, brightening on approach - same "how
    // close am I" cue every theme uses
    const haloR = w * (0.5 + boost * 0.28);
    const haloY = topY + h * 0.62;
    const halo = ctx.createRadialGradient(cx + sway, haloY, 0, cx + sway, haloY, haloR);
    halo.addColorStop(0, `rgba(120,195,255,${0.16 + boost * 0.18})`);
    halo.addColorStop(1, "rgba(120,195,255,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx + sway, haloY, haloR, 0, Math.PI * 2);
    ctx.fill();

    // restrained afterglow - 2 faint, smaller copies trailing upward from
    // the same anchor point ("控えめな残光"), never a busy multi-echo trail
    for (let i = 0; i < 2; i++) {
      const echoScale = 0.86 - i * 0.14;
      const echoSway = Math.sin(t * 1.6 + i * 0.8) * (w * 0.03);
      const echoCy = cy - h * (0.16 + i * 0.13);
      const echoTopY = echoCy - h * echoScale * anchorFrac;
      ctx.globalAlpha = (0.12 - i * 0.04) * (0.5 + boost * 0.5);
      ctx.drawImage(img, cx + echoSway - (w * echoScale) / 2, echoTopY, w * echoScale, h * echoScale);
    }
    ctx.globalAlpha = 1;

    // a few small drifting particles unraveling upward near the light -
    // deterministic per-note motion, small fixed budget (never stored)
    for (let i = 0; i < 3; i++) {
      const seed = i * 1.9;
      const drift = Math.sin(t * 1.1 + seed) * (w * 0.16);
      const py = topY + h * (0.06 + i * 0.1) - Math.abs(Math.sin(t * 0.7 + seed)) * h * 0.05;
      const r = 1.1 + (i % 2) * 0.6;
      ctx.globalAlpha = (0.3 + boost * 0.25) * (0.5 + 0.5 * Math.sin(t * 3 + seed));
      ctx.fillStyle = i % 2 === 0 ? "rgba(220,240,255,0.9)" : "rgba(180,215,255,0.85)";
      ctx.beginPath();
      ctx.arc(cx + sway + drift, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // the light itself - glow increases only near the judge line, and it
    // brightens/pulses very slightly, mirroring the default theme's own
    // shadowBlur-ramps-on-approach behaviour
    ctx.shadowColor = "rgba(110,190,255,0.75)";
    ctx.shadowBlur = 5 + boost * 12;
    ctx.drawImage(img, cx + sway - w / 2, topY, w, h);
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  // HOLD-head counterpart to _drawThemedImageNote, used only when the
  // theme sets themedHoldHead. Draws the same falling-note artwork
  // anchored the same way (tapImageAnchorFrac keeps the art's own bright
  // base exactly on (cx, headY), the real judge point - untouched by this
  // purely visual reuse), slightly enlarged and with a stronger halo/glow
  // while actively held, so "this HOLD's head" reads as the same light
  // material as a tap note without losing the extra held-state emphasis
  // the default crystal head already had. Falls back to the drawn crystal
  // shard for a frame if the image hasn't finished loading yet.
  _drawThemedHoldHead(cx, headY, note, currentTime, holding, headBoost) {
    const img = this._themeImages[this.theme.tapImageSrc];
    if (!img || !img.complete || !img.naturalWidth) {
      const w = this.laneWidth * NOTE_W_RATIO;
      this._drawShardCore(cx, headY, w, w * NOTE_ASPECT, holding ? 1.7 : 1, headBoost);
      return;
    }

    const ctx = this.ctx;
    const w = (this.theme.tapImageWidthPx || this.laneWidth * NOTE_W_RATIO) * (holding ? 1.08 : 1);
    const aspect = img.naturalHeight / (img.naturalWidth || 1);
    const h = w * aspect;
    const anchorFrac = this.theme.tapImageAnchorFrac ?? 0.5;
    const topY = headY - h * anchorFrac;

    const t = currentTime + note.id * 1.7;
    const sway = Math.sin(t * 1.6) * (w * 0.02);

    const haloR = w * (0.5 + headBoost * 0.3) * (holding ? 1.15 : 1);
    const haloY = topY + h * 0.62;
    const halo = ctx.createRadialGradient(cx + sway, haloY, 0, cx + sway, haloY, haloR);
    halo.addColorStop(0, `rgba(120,195,255,${(holding ? 0.26 : 0.16) + headBoost * 0.18})`);
    halo.addColorStop(1, "rgba(120,195,255,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx + sway, haloY, haloR, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = holding ? "rgba(150,205,255,0.9)" : "rgba(110,190,255,0.75)";
    ctx.shadowBlur = (holding ? 9 : 5) + headBoost * 12;
    ctx.drawImage(img, cx + sway - w / 2, topY, w, h);
    ctx.shadowBlur = 0;
  }

  // Success flashes: the green icon briefly replaces the blue one at the
  // judge line, with a short white flash + star/cross sparkle burst around
  // it. Strength (icon hold time, sparkle count, glow) scales with grade.
  // Nothing is stored across frames beyond the small hitEffects list -
  // each burst is recomputed from (progress, count), never pooled objects.
  // Nothing here is an image overlay - success reads through light alone:
  // a silver-to-blue-green core flare, an expanding ring, a brief white
  // flash, and a star-glint sparkle burst, all pure Canvas draws.
  _drawHitEffects(currentTime) {
    if (!this.hitEffects.length) return;
    const ctx = this.ctx;
    this.hitEffects = this.hitEffects.filter((fx) => {
      const elapsed = currentTime - fx.startTime;
      const life = Math.max(fx.cfg.flareSec, fx.cfg.ringSec, fx.cfg.ring2Sec, fx.cfg.sparkleSec);
      if (elapsed < 0 || elapsed > life) return false;

      const cx = fx.lane * this.laneWidth + this.laneWidth / 2;
      const cy = this.judgeY;

      const hc = this.theme.hitColors;

      if (elapsed <= fx.cfg.flareSec) {
        const t = elapsed / fx.cfg.flareSec;
        const r = this.laneWidth * (0.24 - t * 0.06);
        ctx.save();
        const flareGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        flareGrad.addColorStop(0, `${hc.flareCore}${(1 - t) * 0.9})`);
        flareGrad.addColorStop(0.5, `${hc.flareMid}${(1 - t) * 0.55 * fx.cfg.glow})`);
        flareGrad.addColorStop(1, `${hc.flareMid}0)`);
        ctx.fillStyle = flareGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (elapsed <= fx.cfg.ringSec) {
        const t = elapsed / fx.cfg.ringSec;
        ctx.save();
        const r = this.laneWidth * 0.2 + t * this.laneWidth * 0.5;
        ctx.globalAlpha = (1 - t) * 0.75;
        ctx.strokeStyle = hc.ring;
        ctx.lineWidth = 2.2 * (1 - t) + 0.5;
        ctx.shadowColor = hc.ringShadow;
        ctx.shadowBlur = 6 * fx.cfg.glow;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // a second, larger/slower ring for PERFECT only (ring2Sec is 0 for
      // GREAT/GOOD) - the "double ring" is part of what makes PERFECT
      // read as noticeably more festive than the other grades
      if (fx.cfg.ring2Sec && elapsed <= fx.cfg.ring2Sec) {
        const t = elapsed / fx.cfg.ring2Sec;
        ctx.save();
        const r = this.laneWidth * 0.32 + t * this.laneWidth * 0.85;
        ctx.globalAlpha = (1 - t) * 0.4;
        ctx.strokeStyle = hc.ring2;
        ctx.lineWidth = 1.4 * (1 - t) + 0.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // theme-gated extra layer: the concentrated blue-white light the
      // note carried while falling is released outward in a burst of
      // tapered petal shapes (see _drawRadiantBurst) - PERFECT gets the
      // most (9), GREAT a more restrained amount (5), GOOD/MISS get none
      // at all, on top of (never instead of) the flare/ring/sparkle/ember
      // system every theme already uses. Judge logic/grades are untouched;
      // this only reads fx.grade, already computed by triggerHitEffect().
      if (this.theme.explosiveHit && fx.grade !== "GOOD" && elapsed <= fx.cfg.ringSec) {
        this._drawRadiantBurst(cx, cy, elapsed / fx.cfg.ringSec, fx.grade === "PERFECT" ? 9 : 5, hc);
      }

      if (fx.cfg.flashSec && elapsed <= fx.cfg.flashSec) {
        const t = elapsed / fx.cfg.flashSec;
        ctx.save();
        const r = this.laneWidth * 0.5 * (0.3 + t * 0.5);
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
        // upward-drifting embers, PERFECT/GREAT only (emberCount is 0 for
        // GOOD, which stays deliberately restrained - see item 6)
        if (fx.cfg.emberCount) {
          this._drawEmbers(cx, cy, elapsed / fx.cfg.sparkleSec, fx.cfg.emberCount);
        }
      }

      return true;
    });
  }

  // A handful of small star/cross-shaped glints - a mix of larger and
  // smaller ones ("大小の星型グリント") - expanding outward from a
  // success flash, then fading.
  _drawSparkleBurst(cx, cy, progress, count) {
    const ctx = this.ctx;
    const spread = 6 + progress * 30;
    const fade = 1 - progress;
    const colors = this.theme.hitColors.sparkle;
    ctx.save();
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + progress * 1.6;
      const big = i % 3 === 0;
      const dist = spread * (big ? 1.15 : 0.9);
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;
      const r = (big ? 3.0 : 1.4 + (i % 2) * 0.6) * (0.5 + fade * 0.5);
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

  // A few small embers that drift outward and upward from a success burst
  // (PERFECT/GREAT only), fading as they rise ("一部の粒子が上方向へ舞
  // う"). Positions are recomputed each frame from (progress, i), not
  // stored, so nothing needs a particle pool.
  _drawEmbers(cx, cy, progress, count) {
    const ctx = this.ctx;
    const fade = 1 - progress;
    ctx.save();
    for (let i = 0; i < count; i++) {
      const seed = i * 2.399963; // golden-angle-ish, deterministic spread
      const side = Math.sin(seed) * 1.3; // spread left/right
      const dist = 8 + progress * 30;
      const px = cx + side * dist;
      const py = cy - progress * (18 + (i % 3) * 6) - Math.abs(side) * dist * 0.3;
      const r = 1.0 + (i % 2) * 0.7;
      ctx.globalAlpha = fade * 0.85;
      ctx.fillStyle = this.theme.hitColors.ember[i % 2];
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // The extra "release" layer explosiveHit themes add on top of the
  // shared flare/ring/sparkle/ember system: `count` tapered petals of
  // light shooting outward from the judge point and fading as they go,
  // as if the light the falling note was carrying is being let go all at
  // once ("凝縮していた光が一瞬で解放される"). Colored from the theme's
  // own hitColors (flareCore/flareMid), same palette as everything else
  // in the burst, so PERFECT/GREAT stay visually one family, just louder
  // or quieter (count 9 vs 5 - see the call site in _drawHitEffects).
  // Positions/sizes are pure functions of (progress, i), nothing pooled.
  _drawRadiantBurst(cx, cy, progress, count, hc) {
    const ctx = this.ctx;
    const fade = 1 - progress;
    const reach = this.laneWidth * (0.16 + progress * 0.68);
    const spin = progress * 0.9;
    ctx.save();
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + spin;
      const len = reach * (0.75 + 0.25 * Math.sin(i * 2.1));
      const baseW = this.laneWidth * (0.045 + 0.02 * (i % 2)) * (0.4 + fade * 0.6);
      const tipX = cx + Math.cos(angle) * len;
      const tipY = cy + Math.sin(angle) * len;
      const baseX = cx + Math.cos(angle) * len * 0.18;
      const baseY = cy + Math.sin(angle) * len * 0.18;
      const midX = cx + Math.cos(angle) * len * 0.55;
      const midY = cy + Math.sin(angle) * len * 0.55;
      const perpX = -Math.sin(angle) * baseW;
      const perpY = Math.cos(angle) * baseW;

      ctx.globalAlpha = fade * (i % 2 === 0 ? 0.85 : 0.6);
      const petalGrad = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
      petalGrad.addColorStop(0, `${hc.flareCore}0.9)`);
      petalGrad.addColorStop(0.55, `${hc.flareMid}0.55)`);
      petalGrad.addColorStop(1, `${hc.flareMid}0)`);
      ctx.fillStyle = petalGrad;
      ctx.beginPath();
      ctx.moveTo(baseX + perpX, baseY + perpY);
      ctx.quadraticCurveTo(midX + perpX * 0.4, midY + perpY * 0.4, tipX, tipY);
      ctx.quadraticCurveTo(midX - perpX * 0.4, midY - perpY * 0.4, baseX - perpX, baseY - perpY);
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
