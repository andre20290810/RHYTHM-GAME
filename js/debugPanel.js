// Temporary on-screen diagnostics for iOS Safari audio troubleshooting.
// Only active with ?debug=1 in the URL; invisible during normal play.
const READY_STATES = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
const NETWORK_STATES = ["NETWORK_EMPTY", "NETWORK_IDLE", "NETWORK_LOADING", "NETWORK_NO_SOURCE"];

export class DebugPanel {
  constructor() {
    this.enabled = new URLSearchParams(location.search).has("debug");
    this.el = null;
    this.audioEl = null;
    this.videoEl = null;
    this.extra = {};
    if (!this.enabled) return;

    this.el = document.createElement("pre");
    this.el.id = "debug-panel";
    document.body.appendChild(this.el);

    this.extra.userAgent = navigator.userAgent;
    this.extra.audioContextState = "N/A";
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        this.extra.audioContextState = ctx.state;
        // purely diagnostic - never used for playback, closed right away
        ctx.close().catch(() => {});
      }
    } catch (e) {
      this.extra.audioContextState = `error: ${e.message}`;
    }

    setInterval(() => this.render(), 300);
  }

  async checkMp3Status(url) {
    if (!this.enabled) return;
    this.extra.mp3Url = url;
    try {
      const res = await fetch(url, { method: "HEAD" });
      this.extra.mp3HttpStatus = `${res.status} ${res.statusText}`;
    } catch (e) {
      this.extra.mp3HttpStatus = `fetch error: ${e.message}`;
    }
    this.render();
  }

  bindAudio(audioEl) {
    this.audioEl = audioEl;
  }

  bindVideo(videoEl, url) {
    this.videoEl = videoEl;
    this.extra.videoUrl = url;
    this.render();
  }

  setPlayResult(text) {
    this.extra.playResult = text;
    this.render();
  }

  setVideoError(text) {
    this.extra.videoError = text;
    this.render();
  }

  render() {
    if (!this.enabled || !this.el) return;
    const a = this.audioEl;
    const v = this.videoEl;
    const lines = [
      `UA: ${this.extra.userAgent || ""}`,
      `AudioContext.state: ${this.extra.audioContextState}`,
      `MP3 URL: ${this.extra.mp3Url || "(not set yet)"}`,
      `MP3 fetch HTTP status: ${this.extra.mp3HttpStatus || "(pending)"}`,
      `play() result: ${this.extra.playResult || "(not attempted yet)"}`,
      "--- <audio> element ---",
      `readyState: ${a ? `${a.readyState} (${READY_STATES[a.readyState] || "?"})` : "-"}`,
      `networkState: ${a ? `${a.networkState} (${NETWORK_STATES[a.networkState] || "?"})` : "-"}`,
      `duration: ${a ? a.duration : "-"}`,
      `currentTime: ${a ? a.currentTime.toFixed(3) : "-"}`,
      `paused: ${a ? a.paused : "-"}`,
      `muted: ${a ? a.muted : "-"}`,
      `volume: ${a ? a.volume : "-"}`,
      `error: ${a && a.error ? `code ${a.error.code}` : "none"}`,
      "--- <video> background element ---",
      `video URL: ${this.extra.videoUrl || "(none - CSS fallback)"}`,
      `video readyState: ${v ? `${v.readyState} (${READY_STATES[v.readyState] || "?"})` : "-"}`,
      `video networkState: ${v ? `${v.networkState} (${NETWORK_STATES[v.networkState] || "?"})` : "-"}`,
      `video duration: ${v ? v.duration : "-"}`,
      `video currentTime: ${v ? v.currentTime.toFixed(3) : "-"}`,
      `video paused: ${v ? v.paused : "-"}`,
      `video error: ${v && v.error ? `MediaError code ${v.error.code}` : "none"}`,
      `video error (from play()/event): ${this.extra.videoError || "none"}`,
    ];
    this.el.textContent = lines.join("\n");
  }
}
