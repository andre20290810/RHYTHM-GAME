// Playback via a plain HTMLAudioElement.
//
// The previous Web Audio API (AudioContext) implementation still produced
// no sound on real iPhone Safari even after adding an unlock() step, so
// this is intentionally the simplest thing that reliably works on iOS:
// a single <audio> element whose .play() is called synchronously from
// inside a real user-gesture click handler (see main.js - no `await`
// happens before that call). audio.currentTime is the game's timing clock,
// exactly as suggested - no AudioContext is required for playback.
export class AudioEngine {
  constructor() {
    this.element = document.createElement("audio");
    this.element.preload = "auto";
    this.element.playsInline = true;
    this.element.setAttribute("playsinline", "true");
    this.element.setAttribute("webkit-playsinline", "true");
    this.element.style.display = "none";
    document.body.appendChild(this.element);
    this._src = null;
  }

  /** Safe to call anytime (no gesture needed) - just points the element at a URL and starts buffering. */
  setSource(url) {
    if (this._src === url) return;
    this._src = url;
    this.element.src = url;
    this.element.load();
  }

  /**
   * Starts playback. MUST be called synchronously from inside a user-gesture
   * event handler (click/touchend), with no `await` before this call, or
   * iOS Safari will silently refuse to play. Returns the native play()
   * Promise - resolves once audio is actually audible, rejects otherwise
   * (e.g. NotAllowedError if not really inside a gesture, NotSupportedError
   * if the format/codec failed).
   */
  playFromGesture() {
    this.element.currentTime = 0;
    return this.element.play();
  }

  pause() {
    this.element.pause();
  }

  resume() {
    return this.element.play();
  }

  stop() {
    this.element.pause();
    try {
      this.element.currentTime = 0;
    } catch (e) {
      /* not seekable yet, ignore */
    }
  }

  get currentTime() {
    return this.element.currentTime;
  }

  get duration() {
    return Number.isFinite(this.element.duration) ? this.element.duration : 0;
  }

  get playing() {
    return !this.element.paused && !this.element.ended;
  }
}
