/**
 * Long-press on a Shell tile (touch / pen): hold ~500 ms without moving more than a few CSS px → `onLongPress` (the
 * Shell opens the cart's Play / Remove sheet). The click the browser fires on release is then swallowed (once, and
 * only for a short while — a browser that sends no click must not eat the NEXT real tap). A `contextmenu` event (a
 * right-click, or the browser's own long-press on Android) can claim the same press, so one gesture never opens the
 * sheet twice. Pure: timers + clock injected (shell-long-press.test.ts).
 */

export const LONG_PRESS_MS = 500;
/** Movement (CSS px) that turns a press into a drag / scroll (no long-press). */
export const LONG_PRESS_SLOP_CSS = 10;
/** After a long-press is released, its trailing click is swallowed within this long. */
export const LONG_PRESS_CLICK_WINDOW_MS = 600;

export interface LongPressPointer {
  pointerId: number;
  pointerType: string;
  button: number;
  clientX: number;
  clientY: number;
}

export interface LongPressFire { id: string; clientX: number; clientY: number; pointerType: string }

type Timer = ReturnType<typeof setTimeout>;

export interface ShellLongPressDeps {
  onLongPress: (f: LongPressFire) => void;
  ms?: number;
  slopCss?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

export class ShellLongPress {
  private press: { pointerId: number; id: string; x: number; y: number; pointerType: string } | null = null;
  private timer: Timer | null = null;
  /** The current / last press fired (or was claimed by a contextmenu). */
  private fired = false;
  private releasedAt: number | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  constructor(private readonly deps: ShellLongPressDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  }

  /** True while a press is held and its timer runs. */
  get pending(): boolean { return this.timer !== null; }

  /** A pointer went down on tile `id` (null = not on a long-pressable tile). Mouse presses never long-press. */
  down(e: LongPressPointer, id: string | null): void {
    this.cancel();
    this.fired = false;
    this.releasedAt = null;
    if (!id || e.pointerType === 'mouse' || e.button > 0) return;
    this.press = { pointerId: e.pointerId, id, x: e.clientX, y: e.clientY, pointerType: e.pointerType };
    this.timer = this.setTimer(() => {
      this.timer = null;
      const p = this.press;
      if (!p) return;
      this.fired = true;
      this.deps.onLongPress({ id: p.id, clientX: p.x, clientY: p.y, pointerType: p.pointerType });
    }, this.deps.ms ?? LONG_PRESS_MS);
  }

  /** Pointer moved (client / CSS px): past the slop it is a drag, not a long-press. */
  move(e: Pick<LongPressPointer, 'pointerId' | 'clientX' | 'clientY'>): void {
    const p = this.press;
    if (!p || p.pointerId !== e.pointerId || !this.timer) return;
    const slop = this.deps.slopCss ?? LONG_PRESS_SLOP_CSS;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > slop) this.cancel();
  }

  /** Pointer up / cancel. */
  up(e: Pick<LongPressPointer, 'pointerId'>): void {
    const p = this.press;
    if (!p || p.pointerId !== e.pointerId) return;
    this.cancel();
    if (this.fired) this.releasedAt = this.now();
  }

  /** Stop a pending long-press (the press stays "not fired"). */
  cancel(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.press = null;
  }

  /**
   * A contextmenu event arrived. Returns true when it should open the sheet (a right-click, or the browser's
   * long-press beating our timer — the press is then claimed so our timer won't open it again), false when this
   * gesture already opened it.
   */
  claimContextMenu(): boolean {
    if (this.fired) return false;
    const held = this.press !== null;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.fired = true;
    // a touch long-press's release follows (its trailing click is swallowed); a mouse right-click has no press here
    this.releasedAt = held ? null : this.now();
    return true;
  }

  /** The click the browser fires for this press: swallow it (once) when the press long-pressed. */
  swallowClick(): boolean {
    if (!this.fired) return false;
    // releasedAt null = the press is still held (its click is the trailing one); else only shortly after the release
    const recent = this.releasedAt === null || this.now() - this.releasedAt <= LONG_PRESS_CLICK_WINDOW_MS;
    this.fired = false;
    this.releasedAt = null;
    return recent;
  }
}
