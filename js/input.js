import { LANE_KEYS } from "./constants.js";

// Unifies PC keyboard (D/F/J/K) and touch/mouse input (Pointer Events).
// Pointer Events natively carry a distinct pointerId per finger, so multiple
// lanes can be held down simultaneously without any extra multitouch code.
export class InputController {
  constructor(laneElements, { onLaneDown, onLaneUp }) {
    this.laneElements = laneElements;
    this.onLaneDown = onLaneDown;
    this.onLaneUp = onLaneUp;
    this.activePointers = new Map(); // pointerId -> lane
    this.keyLaneDown = new Set();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);

    laneElements.forEach((el, lane) => {
      el.style.touchAction = "none";
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.activePointers.set(e.pointerId, lane);
        this.onLaneDown(lane);
      });
      const release = (e) => {
        if (this.activePointers.has(e.pointerId)) {
          this.activePointers.delete(e.pointerId);
          this.onLaneUp(lane, e.type);
        }
      };
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
      el.addEventListener("pointerleave", release);

      // Belt-and-suspenders for iOS Safari: its long-press-to-select and
      // callout-menu gesture recognizers can preempt a held finger before
      // (or independently of) pointer events. touch-action/user-select in
      // CSS covers most of this, but touchstart/touchmove must also be
      // preventDefault()-ed here - which requires an explicit non-passive
      // listener, since the browser default for touch listeners is passive
      // (preventDefault() is silently ignored otherwise). contextmenu is
      // blocked the same way as a final fallback against the callout menu.
      el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
      el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
      el.addEventListener("contextmenu", (e) => e.preventDefault());
    });
  }

  _onKeyDown(e) {
    const lane = LANE_KEYS.indexOf(e.code);
    if (lane === -1 || e.repeat) return;
    this.keyLaneDown.add(lane);
    this.onLaneDown(lane);
  }

  _onKeyUp(e) {
    const lane = LANE_KEYS.indexOf(e.code);
    if (lane === -1) return;
    this.keyLaneDown.delete(lane);
    this.onLaneUp(lane, "keyup");
  }

  destroy() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
  }
}
