// Web Audio playback clock.
// The whole game reads "now" from here (AudioContext.currentTime based),
// never from requestAnimationFrame deltas, so dropped rendering frames
// never desync notes from the music - only the audio clock is the truth.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.gainNode = null;
    this.startedAtCtxTime = 0; // ctx.currentTime when playback started
    this.startOffsetSec = 0; // offset into the track playback started at
    this.playing = false;
    this._pausedAtSec = 0;
  }

  async load(url) {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
    }
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.buffer.duration;
  }

  async unlock() {
    // Must be called from a user-gesture handler (tap/click) for iOS/Safari.
    if (this.ctx && this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  play(fromSec = 0) {
    if (!this.buffer) return;
    this._stopSource();
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.gainNode);
    this.startOffsetSec = fromSec;
    this.startedAtCtxTime = this.ctx.currentTime;
    this.source.start(0, fromSec);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._pausedAtSec = this.currentTime;
    this._stopSource();
    this.playing = false;
  }

  resume() {
    if (this.playing) return;
    this.play(this._pausedAtSec);
  }

  stop() {
    this._stopSource();
    this.playing = false;
    this._pausedAtSec = 0;
  }

  setVolume(v) {
    if (this.gainNode) this.gainNode.gain.value = v;
  }

  _stopSource() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch (e) {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  /** Current playback position in seconds, driven by the audio clock. */
  get currentTime() {
    if (!this.playing) return this._pausedAtSec;
    return this.startOffsetSec + (this.ctx.currentTime - this.startedAtCtxTime);
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }
}
