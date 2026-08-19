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

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle("active", key === name);
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

  startBackgroundVideo();

  game = new RhythmGame(currentChart);

  renderer.resize();
  window.addEventListener("resize", () => renderer.resize());

  lastDriftCheckMs = 0;
  loop();
}

// The background video is picture-only and never the timing/audio master:
// audio.mp3 keeps driving the chart via audioEngine.currentTime regardless
// of whether the video loads, plays, or fails. A load/play failure falls
// back to the existing CSS gradient background without stopping the game.
function startBackgroundVideo() {
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
  const p = bgVideo.play();
  if (p && typeof p.catch === "function") {
    p.catch((err) => {
      console.warn("[bg-video] play() rejected, falling back to CSS background", err);
      debugPanel.setVideoError(`play() rejected: ${err && err.name}: ${err && err.message}`);
      bgVideo.style.display = "none";
      bgFallback.style.display = "block";
    });
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
// moment it starts (see startBackgroundVideo), which avoids the jank
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
  const grade = game.laneDown(lane, audioEngine.currentTime);
  if (grade) showJudgePopup(grade);
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

function setPaused(value) {
  paused = value;
  document.getElementById("pause-overlay").classList.toggle("hidden", !value);
  if (value) {
    audioEngine.pause();
    if (isVideoActive()) bgVideo.pause();
    if (rafId) cancelAnimationFrame(rafId);
  } else {
    audioEngine.resume();
    if (isVideoActive()) {
      const p = bgVideo.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
    loop();
  }
}

function stopGame() {
  audioEngine.stop();
  if (isVideoActive()) bgVideo.pause();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function loop() {
  if (paused) return;
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
    getGame: () => game,
    getManifest: () => currentManifest,
  };
}
