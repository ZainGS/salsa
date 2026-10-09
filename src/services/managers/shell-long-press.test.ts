import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShellLongPress, LONG_PRESS_MS, LONG_PRESS_SLOP_CSS, LONG_PRESS_CLICK_WINDOW_MS, type LongPressPointer } from './shell-long-press';

const ptr = (o: Partial<LongPressPointer> = {}): LongPressPointer => ({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 200, ...o });

function setup() {
  const onLongPress = vi.fn();
  const lp = new ShellLongPress({ onLongPress, now: () => Date.now() });
  return { lp, onLongPress };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('ShellLongPress', () => {
  it('a touch held 500 ms on a tile fires once, with the press position', () => {
    const { lp, onLongPress } = setup();
    lp.down(ptr(), 'cart-1');
    expect(lp.pending).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledWith({ id: 'cart-1', clientX: 100, clientY: 200, pointerType: 'touch' });
    vi.advanceTimersByTime(5000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('pen too; a mouse, a secondary button or a press off any tile never long-presses', () => {
    const { lp, onLongPress } = setup();
    lp.down(ptr({ pointerType: 'pen' }), 'a'); vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    lp.down(ptr({ pointerType: 'mouse' }), 'a'); vi.advanceTimersByTime(LONG_PRESS_MS);
    lp.down(ptr({ button: 2 }), 'a'); vi.advanceTimersByTime(LONG_PRESS_MS);
    lp.down(ptr(), null); vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('a small wobble keeps it; moving past the slop (a scroll / drag) cancels it', () => {
    const { lp, onLongPress } = setup();
    lp.down(ptr(), 'a');
    lp.move({ pointerId: 1, clientX: 100 + LONG_PRESS_SLOP_CSS - 2, clientY: 200 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    lp.down(ptr(), 'a');
    lp.move({ pointerId: 2, clientX: 400, clientY: 200 });   // another finger: ignored
    lp.move({ pointerId: 1, clientX: 100, clientY: 200 + LONG_PRESS_SLOP_CSS + 1 });
    expect(lp.pending).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('releasing early is a tap: nothing fires and its click is not swallowed', () => {
    const { lp, onLongPress } = setup();
    lp.down(ptr(), 'a');
    vi.advanceTimersByTime(200);
    lp.up({ pointerId: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(lp.swallowClick()).toBe(false);
  });

  it('after a long-press the release click is swallowed once; a later tap is not', () => {
    const { lp } = setup();
    lp.down(ptr(), 'a');
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    lp.up({ pointerId: 1 });
    expect(lp.swallowClick()).toBe(true);
    expect(lp.swallowClick()).toBe(false);
    lp.down(ptr(), 'a');
    lp.up({ pointerId: 1 });
    expect(lp.swallowClick()).toBe(false);
  });

  it('a browser that sends no click after the long-press does not eat a tap much later', () => {
    const { lp } = setup();
    lp.down(ptr(), 'a');
    vi.advanceTimersByTime(LONG_PRESS_MS);
    lp.up({ pointerId: 1 });
    vi.advanceTimersByTime(LONG_PRESS_CLICK_WINDOW_MS + 1);
    expect(lp.swallowClick()).toBe(false);
  });

  it('contextmenu: a right-click opens it; the browser\'s own long-press beating our timer claims the press (no double open)', () => {
    const { lp, onLongPress } = setup();
    // right-click (mouse: no long-press tracking) → open
    lp.down(ptr({ pointerType: 'mouse', button: 2 }), 'a');
    expect(lp.claimContextMenu()).toBe(true);
    // Android: contextmenu at ~450 ms, before our timer
    lp.down(ptr(), 'a');
    vi.advanceTimersByTime(450);
    expect(lp.claimContextMenu()).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
    lp.up({ pointerId: 1 });
    expect(lp.swallowClick()).toBe(true);
    // our timer first, then the browser's contextmenu → not opened again
    lp.down(ptr(), 'a');
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(lp.claimContextMenu()).toBe(false);
  });

  it('cancel() drops a pending press', () => {
    const { lp, onLongPress } = setup();
    lp.down(ptr(), 'a');
    lp.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
