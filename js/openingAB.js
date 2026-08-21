// ---------- DEV-ONLY: OPENING A/B background video comparison ----------
// Temporary feature so the two candidate TITLE background videos (and, per
// each one, its own brand title) can be compared side by side on a real
// iPhone before one is picked for good. Everything this feature needs
// lives in this one file, plus one small HTML block (#opening-ab-switch in
// index.html) and one CSS block (the ".opening-ab-*" rules in
// css/style.css) - nothing outside those three places knows this feature
// exists. To remove it later: delete the setupOpeningAB import + its one
// call site in js/main.js, delete the #opening-ab-switch block in
// index.html, delete the .opening-ab-* rules in css/style.css, delete this
// file (and hardcode whichever OPENING won back into index.html/CSS). No
// song-name/game-logic branching anywhere else in the codebase is touched
// by this feature.
// bgmSrc: each OPENING's own TITLE BGM track - two DISTINCT audio files,
// never the shared assets/audio/title-bgm.mp3 (that file is now unused by
// either OPENING; kept in place, not deleted). See getCurrentBgmSrc()
// below for how js/main.js reads this without any "if opening === ..." of
// its own.
const OPENINGS = {
  A: {
    src: "assets/video/title-loop.mp4", // previous/existing TITLE background video (unchanged, not deleted)
    // No baked-in letterboxing in this file's own frame content (verified
    // by sampling frames) - plain `cover`, no extra zoom needed.
    zoomClass: null,
    titleLines: ["Memories", "Of", "ALEXIA"],
    bgmSrc: "assets/audio/opening-a-bgm.mp3", // "Velvet Circuitry"
  },
  B: {
    src: "assets/video/opening-loop.mov", // newly added OPENING loop video
    // This file is a ReplayKit screen recording with ~12% solid-black bars
    // baked into the top/bottom of its own pixel content (measured, not
    // guessed - see the .opening-zoom-b rule in css/style.css). This class
    // zooms in just enough to crop those bars out of view.
    zoomClass: "opening-zoom-b",
    titleLines: ["Legend", "Of", "KIVA"],
    bgmSrc: "assets/audio/opening-b-bgm.mp3", // "CODE NAME: KILLVAPH"
  },
};

/**
 * Wires up the small OPENING A/B switch UI shown in a corner of the TITLE
 * screen. Only ever reassigns #title-bg-video's `src`/zoom class (the same
 * <video> element is reused, never recreated/duplicated) and the STEP 2
 * brand title's three text lines, plus calls back into js/main.js for the
 * two things only it can do (re-run the real-signal loading watch, and
 * reset TITLE to STEP 1). Never touches audioEngine, chart/judge/score
 * state, or any screen other than TITLE.
 *
 * @param {{restartOpeningVideoLoading: Function, playTitleBgVideo: Function, resetTitleToStep1: Function}} deps
 */
export function setupOpeningAB({ restartOpeningVideoLoading, playTitleBgVideo, resetTitleToStep1 }) {
  const videoEl = document.getElementById("title-bg-video");
  const switchEl = document.getElementById("opening-ab-switch");
  const screenTitleEl = document.getElementById("screen-title");
  const titleLineEls = [
    document.querySelector(".title-line-1"),
    document.querySelector(".title-line-2"),
    document.querySelector(".title-line-3"),
  ];
  if (!videoEl || !switchEl) return { getCurrentBgmSrc: () => OPENINGS.A.bgmSrc };

  // Matches index.html's initial title-bg-video src (opening-loop.mov).
  let current = "B";

  // js/main.js's playTitleBgm() calls this to find which BGM track the
  // currently-selected OPENING wants (see OPENINGS[key].bgmSrc above) -
  // the only thing it needs to know from this module, so it never has to
  // branch on "A"/"B" itself.
  const getCurrentBgmSrc = () => OPENINGS[current].bgmSrc;

  function updateButtons() {
    switchEl.querySelectorAll(".opening-ab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.opening === current);
    });
  }

  // Sets the STEP 2 brand title's text (and, via #screen-title's
  // data-opening attribute, which font css/style.css applies - see the
  // OPENING B title-font rules there) to the currently selected OPENING.
  // Safe to call any time (even while STEP 1/logo is hidden) - it only
  // ever changes text content/an attribute, never opacity/visibility,
  // which stays governed entirely by #screen-title's existing .step2 CSS.
  function updateBrandTitle() {
    const lines = OPENINGS[current].titleLines;
    titleLineEls.forEach((el, i) => {
      if (el && lines[i] != null) el.textContent = lines[i];
    });
    if (screenTitleEl) screenTitleEl.dataset.opening = current;
  }

  function selectOpening(key) {
    const opening = OPENINGS[key];
    if (!opening || key === current) return;
    current = key;
    updateButtons();
    updateBrandTitle();

    // Always compare from the same clean baseline: background video +
    // TAP TO START only, logo hidden, TITLE BGM stopped - see the A/B
    // switch spec (item 8 of the request this feature implements).
    resetTitleToStep1();

    videoEl.pause();
    // Reassigning .src and calling .load() on the SAME <video> element -
    // never a new element, never the `controls` attribute, so there is
    // still nothing for iOS Safari to draw a native play button/controls
    // over after switching.
    videoEl.src = opening.src;
    videoEl.load();
    videoEl.muted = true;
    videoEl.currentTime = 0;
    videoEl.classList.toggle("opening-zoom-b", opening.zoomClass === "opening-zoom-b");
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
  updateBrandTitle();
  // index.html's #title-bg-video already ships with the OPENING B src, so
  // apply B's zoom class up front to match (selectOpening() only runs on
  // an actual switch, not on this initial matching state).
  videoEl.classList.toggle("opening-zoom-b", OPENINGS[current].zoomClass === "opening-zoom-b");

  return { getCurrentBgmSrc };
}
