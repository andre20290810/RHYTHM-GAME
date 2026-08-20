// ---------- DEV-ONLY: OPENING A/B background video comparison ----------
// Temporary feature so the two candidate TITLE background videos can be
// compared side by side on a real iPhone before one is picked for good.
// Everything this feature needs lives in this one file, plus one small
// HTML block (#opening-ab-switch in index.html) and one CSS block (the
// ".opening-ab-*" rules in css/style.css) - nothing outside those three
// places knows this feature exists. To remove it later: delete the
// setupOpeningAB import + its one call site in js/main.js, delete the
// #opening-ab-switch block in index.html, delete the .opening-ab-* rules
// in css/style.css, delete this file. No song-name/game-logic branching
// anywhere else in the codebase is touched by this feature.
const OPENING_SOURCES = {
  A: "assets/video/title-loop.mp4", // previous/existing TITLE background video (unchanged, not deleted)
  B: "assets/video/opening-loop.mov", // newly added OPENING loop video
};

/**
 * Wires up the small OPENING A/B switch UI shown in a corner of the TITLE
 * screen. Only ever reassigns #title-bg-video's `src` (the same <video>
 * element is reused, never recreated/duplicated) and calls back into
 * js/main.js for the two things only it can do (re-run the real-signal
 * loading watch, and reset TITLE to STEP 1). Never touches audioEngine,
 * chart/judge/score state, or any screen other than TITLE.
 *
 * @param {{restartOpeningVideoLoading: Function, playTitleBgVideo: Function, resetTitleToStep1: Function}} deps
 */
export function setupOpeningAB({ restartOpeningVideoLoading, playTitleBgVideo, resetTitleToStep1 }) {
  const videoEl = document.getElementById("title-bg-video");
  const switchEl = document.getElementById("opening-ab-switch");
  if (!videoEl || !switchEl) return;

  // Matches index.html's initial title-bg-video src (opening-loop.mov).
  let current = "B";

  function updateButtons() {
    switchEl.querySelectorAll(".opening-ab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.opening === current);
    });
  }

  function selectOpening(key) {
    const src = OPENING_SOURCES[key];
    if (!src || key === current) return;
    current = key;
    updateButtons();

    // Always compare from the same clean baseline: background video +
    // TAP TO START only, logo hidden, TITLE BGM stopped - see the A/B
    // switch spec (item 8 of the request this feature implements).
    resetTitleToStep1();

    videoEl.pause();
    // Reassigning .src and calling .load() on the SAME <video> element -
    // never a new element, never the `controls` attribute, so there is
    // still nothing for iOS Safari to draw a native play button/controls
    // over after switching.
    videoEl.src = src;
    videoEl.load();
    videoEl.muted = true;
    videoEl.currentTime = 0;
    playTitleBgVideo();
    restartOpeningVideoLoading();
  }

  switchEl.querySelectorAll(".opening-ab-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // #opening-ab-switch is a sibling of #btn-start (the full-screen TAP
      // TO START tap target), not a descendant, so this isn't strictly
      // needed to avoid double-triggering it - kept anyway as a guard in
      // case the DOM position ever changes.
      e.stopPropagation();
      selectOpening(btn.dataset.opening);
    });
  });

  updateButtons();
}
