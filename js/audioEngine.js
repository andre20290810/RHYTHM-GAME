// Web Audio playback clock.
// The whole game reads "now" from here (AudioContext.currentTime based),
// never from requestAnimationFrame deltas, so dropped rendering frames
// never desync notes from the music - only the audio clock is the truth.
//
// iOS Safari only allows an AudioContext to start/resume as a direct
// consequence of a user gesture (tap/click). The context is therefore
// created and resumed EAGERLY inside unlock(), which must be called
// synchronously from the very first tap handler (see main.js's
// "btn-start" listener) - not lazily inside load(), which usually runs
// later after async fetch/decode work and can lose the gesture.
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

  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("この端末のブラウザはWeb Audio APIに対応していません");
      this.ctx = new Ctx();
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Must be called synchronously from a user-gesture handler (tap/click). */
  async unlock() {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    // Some iOS Safari versions only fully unlock the audio pipeline after a
    // buffer has actually been started once inside the gesture; a silent
    // 1-sample buffer is enough and costs nothing audible.
    const primer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = primer;
    src.connect(ctx.destination);
    src.start(0);
  }

  async load(url) {
    this.ensureContext();
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`楽曲ファイルの取得に失敗しました (network error): ${url}`);
    }
    if (!res.ok) {
      throw new Error(`楽曲ファイルの取得に失敗しました (HTTP ${res.status}): ${url}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error(`楽曲ファイルが空です: ${url}`);
    }
    try {
      this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    } catch (e) {
      throw new Error(`楽曲のデコードに失敗しました (decodeAudioData): ${url}`);
    }
    return this.buffer.duration;
  }

  play(fromSec = 0) {
    if (!this.buffer) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
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
