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
          this.onLaneUp(lane);
        }
      };
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
      el.addEventListener("pointerleave", release);
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
    this.onLaneUp(lane);
  }

  destroy() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
  }
}
