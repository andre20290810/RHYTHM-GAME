import { AudioEngine } from "./audioEngine.js";
import { loadCatalog, loadManifest, loadChart } from "./songCatalog.js";
import { RhythmGame } from "./game.js";
import { Renderer } from "./renderer.js";
import { InputController } from "./input.js";
import { DebugPanel } from "./debugPanel.js";

const screens = {
  title: document.getElementById("screen-title"),
  select: document.getElementById("screen-select"),
  play: document.getElementById("screen-play"),
  result: document.getElementById("screen-result"),
};

// The title screen's own looping background video - entirely separate
// from the per-song R2 background video used in #screen-play (different
// element, different manifest, never touches audio.mp3 or the game's own
// background video state). Always muted; this is picture-only.
const titleBgVideo = document.getElementById("title-bg-video");

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle("active", key === name);
  }
  if (name === "title") {
    // Always restart from 0 on (re)entering the title screen, so the loop
    // begins cleanly every time rather than resuming mid-loop.
    try {
      titleBgVideo.currentTime = 0;
    } catch (e) {
      /* not seekable yet (metadata still loading) - fine, it starts at 0 anyway */
    }
    titleBgVideo.muted = true;
    const p = titleBgVideo.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } else {
    titleBgVideo.pause();
  }
}

const debugPanel = new DebugPanel();
const audioEngine = new AudioEngine();
debugPanel.bindAudio(audioEngine.element);

const canvas = document.getElementById("notes-canvas");
const renderer = new Renderer(canvas);
const laneElements = Array.from(document.querySelectorAll("#lanes-overlay .lane"));
const touchZones = Array.from(document.querySelectorAll("#touch-zones .touch-zone"));
const judgePads = Array.from(document.querySelectorAll("#judge-pads .judge-pad"));
const screenPlayEl = document.getElementById("screen-play");

let currentManifest = null;
let currentDifficulty = "NORMAL";
let currentChart = null;
let game = null;
let rafId = null;
let paused = false;
let input = null;

// Silent, visual-only "get ready" lead-in shown before real playback
// begins - see loop()'s pre-roll handling for the full explanation. Never
// changes note.time, judge windows, or audio.currentTime's role as the
// judge basis; only delays when audio.currentTime starts advancing.
const PRE_ROLL_SEC = 1.5;
let preRollRemainingSec = null; // null = not in the pre-roll phase
let preRollLastFrameMs = null;

const bgVideo = document.getElementById("bg-video");
const bgFallback = document.getElementById("bg-fallback");
// Enforced in JS too - never rely on the HTML `muted` attribute alone. The
// video is picture-only; audio.mp3 (via AudioEngine) is the only audible
// source and the only timing master.
bgVideo.muted = true;
bgVideo.volume = 0;

bgVideo.addEventListener("error", () => {
  const code = bgVideo.error ? bgVideo.error.code : "?";
  console.error("[bg-video] load/playback error, falling back to CSS background", bgVideo.error);
  debugPanel.setVideoError(`error event (MediaError code ${code})`);
  bgVideo.style.display = "none";
  bgFallback.style.display = "block";
});
bgVideo.addEventListener("playing", () => {
  bgFallback.style.display = "none";
});

async function init() {
  try {
    const catalog = await loadCatalog();
    currentManifest = await loadManifest(catalog[0]);
    // The song title is already shown large in the background artwork itself
    // (see #select-bg) - no need to print it again as a separate UI label.
    // Start buffering immediately (no gesture required just to load bytes -
    // only the later .play() call needs to be inside a tap handler).
    audioEngine.setSource(currentManifest.audioUrl);
    debugPanel.checkMp3Status(currentManifest.audioUrl);

    if (currentManifest.backgroundUrl) {
      bgVideo.src = currentManifest.backgroundUrl;
      debugPanel.bindVideo(bgVideo, currentManifest.backgroundUrl);
    } else {
      bgVideo.style.display = "none";
      bgFallback.style.display = "block";
    }
  } catch (err) {
    showAudioError(err.message);
  }

  // Kick off the title screen's own looping background video - muted
  // autoplay doesn't need a user gesture, so this can start right away
  // rather than waiting for the first tap.
  showScreen("title");

  input = new InputController(touchZones, {
    onLaneDown: (lane) => handleLaneDown(lane),
    onLaneUp: (lane) => handleLaneUp(lane),
  });
}

document.getElementById("btn-start").addEventListener("click", () => {
  // Best-effort "prime" of the media element on the very first tap: some
  // iOS Safari versions mark an element as user-activated only after its
  // FIRST play() call happens inside a real gesture, which then makes a
  // LATER programmatic play() (e.g. after choosing a difficulty) behave
  // more reliably too. Errors here are ignored - the real, authoritative
  // play() attempt (with full error handling) happens in startGame().
  try {
    const p = audioEngine.element.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    audioEngine.element.pause();
    audioEngine.element.currentTime = 0;
  } catch (e) {
    /* ignore - startGame() will surface any real failure */
  }
  showScreen("select");
});

document.getElementById("btn-back-title").addEventListener("click", () => showScreen("title"));

// Only one song exists today, so these don't switch anything yet - they're
// wired so a future song list can plug real logic into
// selectPreviousSong()/selectNextSong() without touching the button
// markup, styling, or feedback animation again.
function songNavTapFeedback(btn) {
  btn.classList.remove("tapped");
  void btn.offsetWidth; // restart the CSS transition
  btn.classList.add("tapped");
  setTimeout(() => btn.classList.remove("tapped"), 220);
}
function selectPreviousSong() {
  // No-op for now - only one song is available. A future catalog with
  // multiple songs would update currentManifest/select-bg/song-nav state
  // here and re-render the select screen.
}
function selectNextSong() {
  // No-op for now - see selectPreviousSong().
}
document.getElementById("btn-song-prev").addEventListener("click", (e) => {
  songNavTapFeedback(e.currentTarget);
  selectPreviousSong();
});
document.getElementById("btn-song-next").addEventListener("click", (e) => {
  songNavTapFeedback(e.currentTarget);
  selectNextSong();
});

document.querySelectorAll(".btn-diff").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentDifficulty = btn.dataset.diff;
    startGame();
  });
});

document.getElementById("btn-pause").addEventListener("click", () => setPaused(true));
document.getElementById("btn-resume").addEventListener("click", () => setPaused(false));
document.getElementById("btn-quit").addEventListener("click", () => {
  setPaused(false);
  document.getElementById("pause-overlay").classList.add("hidden");
  stopGame();
  showScreen("select");
});

document.getElementById("btn-retry").addEventListener("click", () => startGame());
document.getElementById("btn-to-select").addEventListener("click", () => showScreen("select"));
document.getElementById("btn-audio-error-back").addEventListener("click", () => {
  hideAudioError();
  showScreen("select");
});

function showAudioError(detail) {
  document.getElementById("audio-error-detail").textContent = detail || "";
  document.getElementById("audio-error-overlay").classList.remove("hidden");
}
function hideAudioError() {
  document.getElementById("audio-error-overlay").classList.add("hidden");
}

// NOTE: this function is NOT async at the top - audioEngine.playFromGesture()
// (which calls the native <audio>.play()) must be the very first thing it
// does, called synchronously from the click handler above with zero
// `await`s in between. iOS Safari requires the real DOM play() call to be
// a direct, synchronous consequence of the user gesture; wrapping it in an
// async function and awaiting other work first is exactly what silently
// broke playback in the previous (AudioContext-based) version.
function startGame() {
  hideAudioError();

  let playPromise;
  try {
    playPromise = audioEngine.playFromGesture();
  } catch (syncErr) {
    debugPanel.setPlayResult(`sync throw: ${syncErr}`);
    showAudioError(`楽曲の再生開始に失敗しました: ${syncErr}`);
    return;
  }

  if (!playPromise || typeof playPromise.then !== "function") {
    // Very old browsers: play() returns undefined, nothing to await.
    debugPanel.setPlayResult("no promise returned (legacy browser) - assuming started");
    onPlaybackStarted();
    return;
  }

  playPromise
    .then(() => {
      debugPanel.setPlayResult("resolved (playing)");
      // The promise resolving IS the real iOS unlock already happening -
      // holding here, immediately, at the very start of the track (rather
      // than after the chart JSON below finishes loading) keeps the
      // silent pre-roll from being preceded by an audible blip of the
      // song's first fraction of a second. resume() later reuses this
      // same unlock, exactly like the existing pause/resume feature does.
      // (Pausing any earlier, before this promise settles, is not safe:
      // some browsers reject an in-flight play() with AbortError if
      // pause() is called before it resolves.)
      audioEngine.pause();
      audioEngine.element.currentTime = 0;
      onPlaybackStarted();
    })
    .catch((err) => {
      debugPanel.setPlayResult(`rejected: ${err && err.name}: ${err && err.message}`);
      audioEngine.pause();
      showAudioError(`楽曲の再生に失敗しました (${err && err.name}): ${err && err.message}`);
    });
}

// Playback has actually started - now (and only now) load the chart and
// switch to the play screen. A failed chart load stops the audio again
// rather than leaving a silently-running track behind an error screen.
async function onPlaybackStarted() {
  try {
    currentChart = await loadChart(currentManifest, currentDifficulty);
  } catch (err) {
    audioEngine.pause();
    showAudioError(err.message);
    return;
  }

  showScreen("play");
  document.getElementById("hud-score").textContent = "0";
  document.getElementById("hud-combo-wrap").classList.remove("show");
  document.getElementById("pause-overlay").classList.add("hidden");
  screenPlayEl.dataset.comboTier = "0";
  paused = false;

  prepareBackgroundVideo();

  game = new RhythmGame(currentChart);

  renderer.resize();
  window.addEventListener("resize", () => renderer.resize());

  lastDriftCheckMs = 0;
  // See beginPlayTransition(): the silent visual pre-roll (and, at its
  // end, real audio/game playback) does NOT start here anymore - it only
  // starts once the background is confirmed either actually showable or
  // genuinely broken, never on a bare "still loading" guess.
  beginPlayTransition();
}

// How long the lane/HUD/note layer waits after the background reveals
// before it starts fading in - keeps "background first, gameplay UI
// after" instead of both popping in together.
const UI_REVEAL_DELAY_MS = 500;
// Emergency-only last resort: if the browser never fires ANY ready or
// error signal for the video at all (a genuinely stuck load - e.g. a
// dropped connection with nothing surfaced), the screen must not stay
// black forever with no way forward. This is deliberately far longer than
// any normal load and is NOT a "the video is just a bit slow" timeout -
// ordinary slow loading is handled by simply continuing to wait for a
// real ready/error signal, with no cap.
const EMERGENCY_FALLBACK_MS = 10000;

// Choreographs "black -> background video -> game UI -> real playback"
// instead of the old instant cut where lanes/HUD/notes (and even real
// audio.currentTime advancement) could start before the background video
// had confirmed it can actually show a frame. Purely visual/sequencing:
// it never touches note.time or judge windows, and PRE_ROLL_SEC's own
// duration is unchanged - this only decides when that countdown is
// allowed to *begin*. A video that is merely slow to load is waited out
// indefinitely (readyState/loadeddata/canplay); only a genuine failure
// (a play() rejection or the element's own error event) switches over to
// the CSS fallback and continues - "still loading" is never treated as
// "broken".
function beginPlayTransition() {
  screenPlayEl.classList.remove("bg-ready", "ui-ready");

  let settled = false;
  const proceed = () => {
    if (settled) return;
    settled = true;
    screenPlayEl.classList.add("bg-ready");
    setTimeout(() => screenPlayEl.classList.add("ui-ready"), UI_REVEAL_DELAY_MS);
    // Only now does the silent visual pre-roll begin - real audio/game
    // playback follows automatically once it finishes (see loop()).
    preRollRemainingSec = PRE_ROLL_SEC;
    preRollLastFrameMs = null;
    loop();
  };

  if (!isVideoActive()) {
    // No background video configured for this song - the CSS fallback
    // gradient is ready immediately, but still hold for a short beat so
    // the screen doesn't cut straight from black to a fully-lit UI.
    setTimeout(proceed, 150);
    return;
  }

  // Start the background video decoding immediately, invisibly (opacity:0
  // until proceed() runs) - so once it's revealed a moment later it's
  // already playing smoothly instead of popping in mid-start. A genuine
  // play() failure (caught here) moves straight to the CSS fallback and
  // continues - it is not "still loading".
  playBackgroundVideoIfActive().catch(() => proceed());

  if (bgVideo.readyState >= 2) {
    proceed();
    return;
  }
  bgVideo.addEventListener("loadeddata", proceed, { once: true });
  bgVideo.addEventListener("canplay", proceed, { once: true });
  // A native decode/network error is also a genuine failure, not slow
  // loading - move to the CSS fallback and continue.
  bgVideo.addEventListener("error", proceed, { once: true });
  setTimeout(proceed, EMERGENCY_FALLBACK_MS);
}

// The background video is picture-only and never the timing/audio master:
// audio.mp3 keeps driving the chart via audioEngine.currentTime regardless
// of whether the video loads, plays, or fails. A load/play failure falls
// back to the existing CSS gradient background without stopping the game.
//
// This only readies the element (rewound to 0) - it deliberately does NOT
// call .play() here. Actual playback starts moments later via
// beginPlayTransition(), invisibly (opacity:0) at first so it's already
// decoding smoothly by the time it's revealed - see that function for the
// full black -> background -> UI -> real playback sequencing.
function prepareBackgroundVideo() {
  if (!currentManifest.backgroundUrl) {
    bgVideo.style.display = "none";
    bgFallback.style.display = "block";
    return;
  }
  bgFallback.style.display = "block"; // stays visible as a safety net until 'playing' fires
  bgVideo.style.display = "block";
  try {
    bgVideo.currentTime = 0;
  } catch (e) {
    /* not seekable yet (metadata still loading) - fine, it starts at 0 anyway */
  }
}

// Reassigning video.currentTime forces the decoder to seek to the nearest
// keyframe. On iPhone Safari this is a comparatively expensive, blocking
// operation - doing it every time drift crossed a small 0.2s threshold
// (checked every 500ms) meant the background video was being reseeked
// constantly during normal playback, which is what caused the visible
// stutter/jank reported on real hardware. audio.mp3 remains the only
// timing/judgement master regardless of this setting - this only affects
// how (or whether) the picture-only video is nudged back in sync.
//
// Correction is OFF by default: the video simply free-runs from the
// moment it starts (see playBackgroundVideoIfActive), which avoids the jank
// entirely. A ~4-5 minute track can accumulate aperceptible but usually
// unobtrusive drift this way; if that turns out to matter more than the
// stutter did, flip ENABLE_VIDEO_DRIFT_CORRECTION back on - the threshold
// and interval below are deliberately generous (rare, large corrections
// only) rather than the previous tight/frequent ones.
const ENABLE_VIDEO_DRIFT_CORRECTION = false;
const VIDEO_DRIFT_THRESHOLD_SEC = 1.0; // only correct large, clearly-audible/visible drift
const VIDEO_DRIFT_CHECK_MS = 4000; // checked rarely, never per-frame
let lastDriftCheckMs = 0;

function maybeCorrectVideoDrift(currentTime, nowMs) {
  if (!ENABLE_VIDEO_DRIFT_CORRECTION) return;
  if (!currentManifest.backgroundUrl || bgVideo.style.display === "none") return;
  if (bgVideo.readyState < 2 || bgVideo.paused || bgVideo.seeking) return;
  if (nowMs - lastDriftCheckMs < VIDEO_DRIFT_CHECK_MS) return;
  lastDriftCheckMs = nowMs;
  const drift = Math.abs(bgVideo.currentTime - currentTime);
  if (drift > VIDEO_DRIFT_THRESHOLD_SEC) {
    try {
      bgVideo.currentTime = currentTime;
    } catch (e) {
      /* ignore - will retry on the next check */
    }
  }
}

function comboTierFor(combo) {
  if (combo >= 100) return 4;
  if (combo >= 50) return 3;
  if (combo >= 25) return 2;
  if (combo >= 10) return 1;
  return 0;
}

function triggerPadEffect(lane) {
  const pad = judgePads[lane];
  if (!pad) return;
  const ripple = pad.querySelector(".pad-ripple");
  ripple.classList.remove("show");
  void ripple.offsetWidth; // restart CSS animation
  ripple.classList.add("show");
}

function handleLaneDown(lane) {
  if (paused || !game) return;
  laneElements[lane].classList.add("active");
  judgePads[lane]?.classList.add("active");
  triggerPadEffect(lane);
  // Peek at the note about to be judged (laneDown only tells us the grade,
  // not the note) so the green success-icon swap applies to tap notes only
  // - hold notes keep their existing crystal-tile body (see renderer.js).
  const judgedType = game.pendingByLane[lane][0]?.type;
  const currentTime = audioEngine.currentTime;
  const grade = game.laneDown(lane, currentTime);
  if (grade) {
    showJudgePopup(grade);
    if (judgedType === "tap" && grade !== "MISS") {
      renderer.triggerHitEffect(lane, grade, currentTime);
    }
  }
  updateHud();
}

function handleLaneUp(lane) {
  if (paused || !game) return;
  laneElements[lane].classList.remove("active");
  judgePads[lane]?.classList.remove("active");
  game.laneUp(lane, audioEngine.currentTime);
}

function showJudgePopup(grade) {
  const el = document.getElementById("hud-judge");
  el.textContent = grade;
  el.className = grade;
  void el.offsetWidth; // restart CSS animation
  el.classList.add("show");
}

function updateHud() {
  document.getElementById("hud-score").textContent = Math.round(game.score).toLocaleString();
  const comboWrap = document.getElementById("hud-combo-wrap");
  const comboEl = document.getElementById("hud-combo");
  if (game.combo >= 2) {
    comboEl.textContent = `${game.combo} COMBO`;
    comboWrap.classList.add("show");
  } else {
    comboWrap.classList.remove("show");
  }
  screenPlayEl.dataset.comboTier = String(comboTierFor(game.combo));
}

function isVideoActive() {
  return !!currentManifest.backgroundUrl && bgVideo.style.display !== "none";
}

// Returns a promise so callers that care (see beginPlayTransition) can
// tell a real failure apart from "still loading" - it resolves once
// playback actually starts, and rejects (after switching the display over
// to the CSS fallback itself) only on a genuine play() failure.
function playBackgroundVideoIfActive() {
  if (!isVideoActive()) return Promise.resolve();
  const p = bgVideo.play();
  if (!p || typeof p.catch !== "function") return Promise.resolve();
  return p.catch((err) => {
    console.warn("[bg-video] play() rejected, falling back to CSS background", err);
    debugPanel.setVideoError(`play() rejected: ${err && err.name}: ${err && err.message}`);
    bgVideo.style.display = "none";
    bgFallback.style.display = "block";
    throw err;
  });
}

function setPaused(value) {
  paused = value;
  document.getElementById("pause-overlay").classList.toggle("hidden", !value);
  if (value) {
    audioEngine.pause();
    if (isVideoActive()) bgVideo.pause();
    if (rafId) cancelAnimationFrame(rafId);
    // Don't let the pre-roll countdown "jump forward" by however long the
    // player stayed paused - see the dt calc in loop() below.
    preRollLastFrameMs = null;
  } else {
    // Real playback only actually resumes once any pre-roll countdown has
    // finished (loop() below drives that) - pausing/resuming mid-pre-roll
    // must not skip straight into audible playback.
    if (preRollRemainingSec === null) audioEngine.resume();
    playBackgroundVideoIfActive().catch(() => {});
    loop();
  }
}

function stopGame() {
  audioEngine.stop();
  if (isVideoActive()) bgVideo.pause();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  preRollRemainingSec = null;
  preRollLastFrameMs = null;
}

// Visual-only "get ready" lead-in shown before real playback begins, so
// even the chart's very first note gets a real look before it's judged
// (see PRE_ROLL_SEC). It never touches note.time, the judge windows, or
// audio.currentTime's role as the judge basis - it only delays the moment
// audio.currentTime starts advancing from 0, using the exact same
// pause()-now/resume()-later unlock the pause/resume feature already
// relies on. game.update()/laneDown() are not called during this phase,
// so no note can be judged (missed or hit) before it truly begins.
function loop() {
  if (paused) return;

  if (preRollRemainingSec !== null) {
    const nowMs = performance.now();
    const dt = preRollLastFrameMs === null ? 0 : (nowMs - preRollLastFrameMs) / 1000;
    preRollLastFrameMs = nowMs;
    preRollRemainingSec -= dt;

    if (preRollRemainingSec <= 0) {
      preRollRemainingSec = null;
      preRollLastFrameMs = null;
      audioEngine.resume();
      playBackgroundVideoIfActive().catch(() => {});
    } else {
      renderer.draw(-preRollRemainingSec, game, 0);
      rafId = requestAnimationFrame(loop);
      return;
    }
  }

  const currentTime = audioEngine.currentTime;
  game.update(currentTime);
  const comboTier = comboTierFor(game.combo);
  renderer.draw(currentTime, game, comboTier);
  updateHud();
  maybeCorrectVideoDrift(currentTime, performance.now());

  const progress = audioEngine.duration ? Math.min(1, currentTime / audioEngine.duration) : 0;
  document.getElementById("hud-progress-bar").style.width = `${progress * 100}%`;

  const songEnded = audioEngine.duration > 0 && currentTime >= audioEngine.duration - 0.05;
  if (game.finished || songEnded) {
    finishGame();
    return;
  }
  rafId = requestAnimationFrame(loop);
}

function finishGame() {
  stopGame();
  document.getElementById("result-rank").textContent = game.getRank();
  document.getElementById("result-score").textContent = Math.round(game.score).toLocaleString();
  document.getElementById("result-maxcombo").textContent = game.maxCombo;
  document.getElementById("result-perfect").textContent = game.judgeCounts.PERFECT;
  document.getElementById("result-great").textContent = game.judgeCounts.GREAT;
  document.getElementById("result-good").textContent = game.judgeCounts.GOOD;
  document.getElementById("result-miss").textContent = game.judgeCounts.MISS;
  showScreen("result");
}

init();

// QA hook, inert unless ?debug is in the URL: lets automated tests jump the
// audio clock forward (e.g. to reach end-of-song) instead of waiting the
// full track length in real time. Not used by normal gameplay.
if (new URLSearchParams(location.search).has("debug")) {
  window.__debug = {
    audioEngine,
    bgVideo,
    renderer,
    getGame: () => game,
    getManifest: () => currentManifest,
  };
}
