import { AudioEngine } from "./audioEngine.js";
import { loadCatalog, loadManifest, loadChart } from "./songCatalog.js";
import { RhythmGame } from "./game.js";
import { Renderer } from "./renderer.js";
import { InputController } from "./input.js";

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

const audioEngine = new AudioEngine();
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

async function init() {
  try {
    const catalog = await loadCatalog();
    currentManifest = await loadManifest(catalog[0]);
    document.getElementById("select-song-title").textContent = currentManifest.title;
    document.getElementById("select-song-sub").textContent =
      `BPM ${Math.round(currentManifest.bpm)} / ${formatTime(currentManifest.durationSec)}`;
  } catch (err) {
    showAudioError(err.message);
  }

  input = new InputController(touchZones, {
    onLaneDown: (lane) => handleLaneDown(lane),
    onLaneUp: (lane) => handleLaneUp(lane),
  });
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

document.getElementById("btn-start").addEventListener("click", async () => {
  // iOS/Safari only allows the AudioContext to start as a direct result of
  // a user gesture - unlock() must run synchronously from this tap, before
  // any other await, or the context can end up permanently suspended.
  try {
    await audioEngine.unlock();
  } catch (err) {
    showAudioError(err.message);
    return;
  }
  showScreen("select");
});

document.getElementById("btn-back-title").addEventListener("click", () => showScreen("title"));

document.querySelectorAll(".btn-diff").forEach((btn) => {
  btn.addEventListener("click", async () => {
    currentDifficulty = btn.dataset.diff;
    await startGame();
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

async function startGame() {
  hideAudioError();

  // Load everything BEFORE switching to the play screen or starting the
  // audio clock. A failed load must never result in a silent playthrough:
  // show AUDIO LOAD ERROR and stop here instead of proceeding.
  try {
    if (!audioEngine.buffer || audioEngine._loadedUrl !== currentManifest.audioUrl) {
      await audioEngine.load(currentManifest.audioUrl);
      audioEngine._loadedUrl = currentManifest.audioUrl;
    }
    currentChart = await loadChart(currentManifest, currentDifficulty);
  } catch (err) {
    showAudioError(err.message);
    return;
  }

  showScreen("play");
  document.getElementById("hud-score").textContent = "0";
  document.getElementById("hud-combo-wrap").classList.remove("show");
  document.getElementById("pause-overlay").classList.add("hidden");
  screenPlayEl.dataset.comboTier = "0";
  paused = false;

  setupBackground();

  game = new RhythmGame(currentChart);

  renderer.resize();
  window.addEventListener("resize", () => renderer.resize());

  audioEngine.play(0);
  loop();
}

function setupBackground() {
  const video = document.getElementById("bg-video");
  const fallback = document.getElementById("bg-fallback");
  if (currentManifest.backgroundUrl) {
    video.src = currentManifest.backgroundUrl;
    video.style.display = "block";
    fallback.style.display = "none";
    video.currentTime = 0;
    video.play().catch(() => {});
  } else {
    video.removeAttribute("src");
    video.style.display = "none";
    fallback.style.display = "block";
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
  pad.classList.add("active");
  const ripple = pad.querySelector(".pad-ripple");
  const particles = pad.querySelector(".pad-particles");
  for (const el of [ripple, particles]) {
    el.classList.remove("show");
    void el.offsetWidth; // restart CSS animation
    el.classList.add("show");
  }
}

function handleLaneDown(lane) {
  if (paused || !game) return;
  laneElements[lane].classList.add("active");
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

function setPaused(value) {
  paused = value;
  document.getElementById("pause-overlay").classList.toggle("hidden", !value);
  if (value) {
    audioEngine.pause();
    if (rafId) cancelAnimationFrame(rafId);
  } else {
    audioEngine.resume();
    loop();
  }
}

function stopGame() {
  audioEngine.stop();
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

  const progress = Math.min(1, currentTime / audioEngine.duration);
  document.getElementById("hud-progress-bar").style.width = `${progress * 100}%`;

  const songEnded = currentTime >= audioEngine.duration - 0.05;
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
    getGame: () => game,
    getManifest: () => currentManifest,
  };
}
