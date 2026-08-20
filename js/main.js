import { AudioEngine } from "./audioEngine.js";
import { loadCatalog, loadManifest, loadChart } from "./songCatalog.js";
import { RhythmGame } from "./game.js";
import { Renderer } from "./renderer.js";
import { InputController } from "./input.js";
import { DebugPanel } from "./debugPanel.js";
import { setupOpeningAB } from "./openingAB.js";

const screens = {
  title: document.getElementById("screen-title"),
  songlist: document.getElementById("screen-songlist"),
  select: document.getElementById("screen-select"),
  play: document.getElementById("screen-play"),
  result: document.getElementById("screen-result"),
};

// The TITLE/menu world's own looping background video - entirely separate
// from the per-song R2 background video used in #screen-play (different
// element, different manifest, never touches audio.mp3 or the game's own
// background video state). Always muted; this is picture-only. Lives in a
// shared layer (#menu-bg-layer, see index.html) OUTSIDE of #screen-title
// itself so the exact same element/src keeps playing, uninterrupted,
// while navigating between TITLE and the song list - it is never
// destroyed or recreated on that transition.
const titleBgVideo = document.getElementById("title-bg-video");
const menuBgLayer = document.getElementById("menu-bg-layer");

// Diagnostics only (visible with ?debug=1) - previously this video had NO
// error/stall observability at all, which is exactly why a real-device
// playback failure could happen with zero trace. None of this affects
// playback itself.
titleBgVideo.addEventListener("error", () => {
  const code = titleBgVideo.error ? titleBgVideo.error.code : "?";
  console.error("[title-bg-video] load/playback error", titleBgVideo.error);
  debugPanel?.setTitleVideoError(`error event (MediaError code ${code})`);
});
titleBgVideo.addEventListener("stalled", () => debugPanel?.setTitleVideoError("stalled event"));

// iOS Safari can reject an autoplay-without-gesture play() call for
// reasons that have nothing to do with the file itself (e.g. transient
// resource contention right at page load). The previous version silently
// swallowed this rejection with no retry and no trace. This retries once,
// the moment the element itself reports it has enough data to actually
// play - by then whatever caused the first rejection has normally
// resolved. Muted+playsinline video is exempt from the "real gesture
// required" autoplay policy, so this retry is not a policy violation.
function playTitleBgVideo() {
  const p = titleBgVideo.play();
  if (p && typeof p.catch === "function") {
    p.then(() => debugPanel?.setTitleVideoError("none (playing)")).catch((err) => {
      debugPanel?.setTitleVideoError(`play() rejected: ${err && err.name}: ${err && err.message} - retrying on canplay`);
      const retry = () => {
        const p2 = titleBgVideo.play();
        if (p2 && typeof p2.catch === "function") {
          p2.then(() => debugPanel?.setTitleVideoError("none (playing after retry)"))
            .catch((err2) => debugPanel?.setTitleVideoError(`retry also rejected: ${err2 && err2.name}: ${err2 && err2.message}`));
        }
      };
      if (titleBgVideo.readyState >= 3) retry();
      else titleBgVideo.addEventListener("canplay", retry, { once: true });
    });
  }
}

// ---------- OPENING loading overlay ----------
// Covers STEP 1 only for as long as the background video genuinely isn't
// ready to render a frame yet - never a fixed timer, never a fabricated
// percentage. Progress comes only from real signals the video element
// itself exposes: readyState's tier (HAVE_NOTHING..HAVE_ENOUGH_DATA) plus,
// once duration is known, how much of the file is actually buffered.
const titleLoadingOverlay = document.getElementById("title-loading-overlay");
const titleLoadingBarFill = document.getElementById("title-loading-bar-fill");
const titleLoadingPct = document.getElementById("title-loading-pct");

// Coarse floor per readyState tier - matches how the rest of this file
// already treats readyState>=2 (HAVE_CURRENT_DATA) as "can actually paint
// a frame now" (see isVideoActive()/beginPlayTransition() for the per-song
// background video's identical bar).
const READY_STATE_PROGRESS = [0, 20, 45, 70, 92];

function computeOpeningVideoProgress() {
  const rs = titleBgVideo.readyState;
  let pct = READY_STATE_PROGRESS[Math.min(rs, READY_STATE_PROGRESS.length - 1)];
  if (Number.isFinite(titleBgVideo.duration) && titleBgVideo.duration > 0 && titleBgVideo.buffered.length > 0) {
    const bufferedEnd = titleBgVideo.buffered.end(titleBgVideo.buffered.length - 1);
    const bufferedFrac = Math.min(1, bufferedEnd / titleBgVideo.duration);
    pct = Math.max(pct, Math.round(bufferedFrac * 92));
  }
  return pct;
}

function updateOpeningLoadingUI() {
  const pct = computeOpeningVideoProgress();
  titleLoadingBarFill.style.width = `${pct}%`;
  titleLoadingPct.textContent = `${pct}%`;
}

function isOpeningVideoReady() {
  return titleBgVideo.readyState >= 2; // HAVE_CURRENT_DATA - can paint a frame
}

let openingLoadingResolved = false;
let openingLoadingPollId = null;

// Only ever called once real readiness is confirmed (loadeddata/canplay),
// a genuine load error (nothing more to wait for), or the same kind of
// far-longer-than-normal emergency fallback the per-song background video
// already uses elsewhere in this file - "still loading" is never treated
// as "broken", but a truly stuck load must not block STEP 1 forever.
function finishOpeningLoading() {
  if (openingLoadingResolved) return;
  openingLoadingResolved = true;
  if (openingLoadingPollId) {
    clearInterval(openingLoadingPollId);
    openingLoadingPollId = null;
  }
  titleLoadingBarFill.style.width = "100%";
  titleLoadingPct.textContent = "100%";
  if (!titleLoadingOverlay.classList.contains("hidden")) {
    titleLoadingOverlay.classList.add("fading");
    setTimeout(() => titleLoadingOverlay.classList.add("hidden"), 550);
  }
}

function watchOpeningVideoLoading() {
  if (isOpeningVideoReady()) return; // already ready - the overlay never even shows

  // Brief grace period before actually revealing the overlay, so a
  // normally-fast load never flashes a 0% Loading UI for a single frame -
  // only a genuinely slow load ever becomes visible.
  const graceTimer = setTimeout(() => {
    if (openingLoadingResolved) return;
    titleLoadingOverlay.classList.remove("hidden", "fading");
    updateOpeningLoadingUI();
    openingLoadingPollId = setInterval(updateOpeningLoadingUI, 150);
  }, 200);

  const onSettled = () => {
    clearTimeout(graceTimer);
    finishOpeningLoading();
  };
  titleBgVideo.addEventListener("loadeddata", onSettled, { once: true });
  titleBgVideo.addEventListener("canplay", onSettled, { once: true });
  titleBgVideo.addEventListener("error", onSettled, { once: true });
  setTimeout(onSettled, EMERGENCY_FALLBACK_MS);
}

// Re-runs the exact same real-signal-only loading watch above for a newly
// assigned video src - used only by the OPENING A/B dev switch (see
// js/openingAB.js) when the user picks the other candidate video. Resets
// the one-shot "already resolved" guard and the overlay's visible state
// back to their initial values, then delegates straight to
// watchOpeningVideoLoading() so the grace-period/fast-load-skip/
// percentage-from-readyState logic is never duplicated.
function restartOpeningVideoLoading() {
  openingLoadingResolved = false;
  if (openingLoadingPollId) {
    clearInterval(openingLoadingPollId);
    openingLoadingPollId = null;
  }
  titleLoadingOverlay.classList.add("hidden");
  titleLoadingOverlay.classList.remove("fading");
  titleLoadingBarFill.style.width = "0%";
  titleLoadingPct.textContent = "0%";
  watchOpeningVideoLoading();
}

// ---------- TITLE/menu BGM ----------
// A single persistent <audio> element (never recreated), completely
// separate from `audioEngine` above - it never touches audio.currentTime
// as a judge clock, never plays alongside a song's own audio.mp3, and
// reusing the same element on every play()/pause() call means it can
// never stack overlapping instances. Started synchronously from the
// TAP TO START gesture (see btn-start below) exactly like audioEngine's
// own gesture-unlock pattern; looped while on TITLE/song-list, faded out
// when a song is chosen, and hard-stopped (see startGame()) before any
// real gameplay audio begins.
const titleBgm = document.getElementById("title-bgm");
titleBgm.loop = true;
let titleBgmUnlocked = false; // true once a play() from a real gesture has resolved

function playTitleBgm() {
  titleBgm.volume = 1;
  const p = titleBgm.play();
  if (p && typeof p.catch === "function") {
    p.then(() => { titleBgmUnlocked = true; }).catch(() => {});
  } else {
    titleBgmUnlocked = true;
  }
}

// Hard, immediate stop - the guaranteed "never plays under real gameplay"
// path. Called unconditionally at the start of startGame(), regardless of
// whether a fade-out is still in progress.
function stopTitleBgm() {
  titleBgm.pause();
  titleBgm.currentTime = 0;
  titleBgm.volume = 1;
}

// Short fade-out used when leaving TITLE/song-list for a song's difficulty
// screen - purely a nicer transition; startGame() still hard-stops the
// element regardless of whether this finishes in time.
function fadeOutTitleBgm(durationMs = 400) {
  if (titleBgm.paused) return;
  const startVolume = titleBgm.volume;
  const startTime = performance.now();
  function step() {
    if (titleBgm.paused) return;
    const t = Math.min(1, (performance.now() - startTime) / durationMs);
    titleBgm.volume = startVolume * (1 - t);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      stopTitleBgm();
    }
  }
  requestAnimationFrame(step);
}

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle("active", key === name);
  }

  // The menu world (video + dim) is shared by TITLE and the song list -
  // shown for both, hidden (and paused) for everything else. This layer
  // itself is never touched by the branches below except to toggle
  // .active; see playTitleBgVideo()/titleBgVideo.pause() for playback.
  menuBgLayer.classList.toggle("active", name === "title" || name === "songlist");

  if (name === "title") {
    // Always restart from 0 on (re)entering the title screen, so the loop
    // begins cleanly every time rather than resuming mid-loop.
    try {
      titleBgVideo.currentTime = 0;
    } catch (e) {
      /* not seekable yet (metadata still loading) - fine, it starts at 0 anyway */
    }
    titleBgVideo.muted = true;
    playTitleBgVideo();

    // Resume the BGM as TITLE BGM too, but only if gesture permission was
    // already established earlier in this session - never call play()
    // outside a real gesture on the very first attempt.
    if (titleBgmUnlocked) {
      titleBgm.currentTime = 0;
      playTitleBgm();
    }
  } else if (name === "songlist") {
    // Deliberately do NOT touch currentTime, and do NOT call pause() -
    // the song list continues the exact same TITLE video/BGM state
    // uninterrupted (it was already playing from the "title" branch
    // above, whether just now or on a previous visit). Just make sure
    // it's actually still playing, in case something else paused it.
    if (titleBgVideo.paused) playTitleBgVideo();
  } else {
    titleBgVideo.pause();
  }
}

const debugPanel = new DebugPanel();
debugPanel.bindTitleVideo(titleBgVideo);
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

// Populated once at startup from songs/index.json (loadCatalog()) - never
// hardcoded song names here. Only entry.enabled === true entries are
// tappable; the rest render as visually inert "locked" cards. Adding a
// future song is purely a data change (flip enabled to true, provide a
// manifest with its own audio/background/charts) - nothing here branches
// on a specific song's name or id.
let catalog = [];

function renderSongList(entries) {
  const container = document.getElementById("songlist-items");
  container.innerHTML = "";
  const sorted = [...entries].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  for (const entry of sorted) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `song-card ${entry.enabled ? "enabled" : "disabled"}`;
    card.disabled = !entry.enabled;

    const titleSpan = document.createElement("span");
    titleSpan.className = "song-card-title";
    titleSpan.textContent = entry.title || entry.id;
    card.appendChild(titleSpan);

    if (!entry.enabled) {
      const tag = document.createElement("span");
      tag.className = "song-card-tag";
      tag.textContent = "COMING SOON";
      card.appendChild(tag);
    } else {
      card.addEventListener("click", () => selectSong(entry));
    }

    container.appendChild(card);
  }
}

// Loads the chosen song's manifest only now (not eagerly at startup) - the
// song list itself only ever needed the lightweight catalog entries above.
async function selectSong(entry) {
  try {
    currentManifest = await loadManifest(entry);
    // Select this song's note visual theme now (falls back to "default"
    // for songs without their own noteTheme) - done once per song select,
    // well before any note is ever drawn, so gameplay never has to branch
    // on the song id itself (see renderer.js's NOTE_THEMES).
    renderer.setNoteTheme(currentManifest.noteTheme);
    // Start buffering immediately (no gesture required just to load bytes -
    // only the later .play() call in startGame() needs to be inside a tap
    // handler).
    audioEngine.setSource(currentManifest.audioUrl);
    debugPanel.checkMp3Status(currentManifest.audioUrl);

    if (currentManifest.backgroundUrl) {
      bgVideo.src = currentManifest.backgroundUrl;
      debugPanel.bindVideo(bgVideo, currentManifest.backgroundUrl);
    } else {
      bgVideo.style.display = "none";
      bgFallback.style.display = "block";
    }

    fadeOutTitleBgm();
    showScreen("select");
  } catch (err) {
    showAudioError(err.message);
  }
}

async function init() {
  try {
    catalog = await loadCatalog();
    renderSongList(catalog);
  } catch (err) {
    showAudioError(err.message);
  }

  // Kick off the title screen's own looping background video - muted
  // autoplay doesn't need a user gesture, so this can start right away
  // rather than waiting for the first tap.
  showScreen("title");
  watchOpeningVideoLoading();
  setupOpeningAB({ restartOpeningVideoLoading, playTitleBgVideo, resetTitleToStep1 });

  input = new InputController(touchZones, {
    onLaneDown: (lane) => handleLaneDown(lane),
    onLaneUp: (lane) => handleLaneUp(lane),
  });
}

// ---------- OPENING STEP 1 -> STEP 2 ----------
// STEP 1 (page load): background video + TAP TO START only, no logo -
// #screen-title starts WITHOUT the .step2 class (see css/style.css).
// The first tap reveals the logo and relabels the button GAME START but
// does NOT navigate anywhere yet; only a SECOND tap (now reading GAME
// START) proceeds to the song list. Once reached, STEP 2 persists for the
// rest of the session - returning to TITLE from elsewhere (song list's
// 戻る, the difficulty screen's 戻る) always lands back in STEP 2, never
// all the way back to the bare STEP 1 view.
let titleStep2Reached = false;
const tapToStartEl = document.querySelector(".tap-to-start");

function revealTitleStep2() {
  titleStep2Reached = true;
  screens.title.classList.add("step2");
  tapToStartEl.textContent = "GAME START";
}

// Used only by the OPENING A/B dev switch (js/openingAB.js) to return
// TITLE to a clean STEP 1 baseline - background video + TAP TO START
// only, logo hidden, TITLE BGM stopped - so both candidate videos are
// always compared from the same starting state. Never called from any
// normal (non-A/B) gameplay flow.
function resetTitleToStep1() {
  titleStep2Reached = false;
  screens.title.classList.remove("step2");
  tapToStartEl.textContent = "TAP TO START";
  stopTitleBgm();
}

document.getElementById("btn-start").addEventListener("click", () => {
  if (!titleStep2Reached) {
    // Start the TITLE BGM synchronously, inside this real gesture, exactly
    // like audioEngine's own gesture-unlock pattern - must be the first
    // thing done in this branch, no `await` before it.
    playTitleBgm();
    revealTitleStep2();
    return;
  }
  showScreen("songlist");
});

document.getElementById("btn-songlist-back").addEventListener("click", () => showScreen("title"));

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
  // Guaranteed stop, regardless of whether the fade-out started in
  // selectSong() has finished yet - real gameplay must never overlap the
  // TITLE BGM with the song's own audio.mp3.
  stopTitleBgm();

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

  // Promo link is entirely data-driven from the current song's manifest
  // (artistUrl) - never hardcoded per-song here. A future song without an
  // artistUrl set simply doesn't show the button rather than linking
  // nowhere.
  const artistBtn = document.getElementById("btn-artist-page");
  const artistUrl = currentManifest && currentManifest.artistUrl;
  if (artistUrl) {
    artistBtn.href = artistUrl;
    artistBtn.classList.remove("hidden");
  } else {
    artistBtn.classList.add("hidden");
  }

  showScreen("result");
}

// ---------- Portrait-only lock ----------
// Applies to the whole app, every screen, including mid-gameplay. The
// overlay itself (a fixed, full-viewport element - see css/style.css)
// already blocks taps on anything underneath it; the extra work here is
// making sure gameplay actually STOPS progressing while landscape rather
// than merely being visually covered - the audio clock, note positions,
// and background video must not keep advancing behind the overlay, or the
// chart position would visibly jump forward the moment portrait returns.
const landscapeOverlay = document.getElementById("landscape-overlay");

function isLandscape() {
  return window.matchMedia("(orientation: landscape)").matches;
}

function handleOrientationChange() {
  if (isLandscape()) {
    landscapeOverlay.classList.remove("hidden");
    if (screens.play.classList.contains("active") && !paused && game) {
      setPaused(true);
    }
  } else {
    landscapeOverlay.classList.add("hidden");
    // Never auto-resume - if gameplay was paused (whether by this
    // landscape lock or already manually paused), it STAYS paused; the
    // player must tap RESUME explicitly (see setPaused/#pause-overlay).
    // Recompute the canvas/lane/judge-pad scale from the CURRENT portrait
    // dimensions right away, before any resume is possible, so notes are
    // never drawn at a size carried over from the landscape layout.
    if (screens.play.classList.contains("active")) {
      renderer.resize();
    }
  }
}

window.addEventListener("orientationchange", handleOrientationChange);
window.addEventListener("resize", handleOrientationChange);
if (window.matchMedia) {
  const orientationQuery = window.matchMedia("(orientation: landscape)");
  if (orientationQuery.addEventListener) {
    orientationQuery.addEventListener("change", handleOrientationChange);
  } else if (orientationQuery.addListener) {
    orientationQuery.addListener(handleOrientationChange);
  }
}
// Cover the case where the app is first loaded already in landscape.
handleOrientationChange();

init();

// QA hook, inert unless ?debug is in the URL: lets automated tests jump the
// audio clock forward (e.g. to reach end-of-song) instead of waiting the
// full track length in real time. Not used by normal gameplay.
if (new URLSearchParams(location.search).has("debug")) {
  window.__debug = {
    audioEngine,
    bgVideo,
    renderer,
    titleBgm,
    landscapeOverlay,
    getGame: () => game,
    getManifest: () => currentManifest,
    getCatalog: () => catalog,
  };
}
