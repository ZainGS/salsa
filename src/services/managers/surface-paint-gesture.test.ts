import { describe, it, expect } from 'vitest';

import { SurfacePaintGesture, type SurfaceGestureIO, type SurfacePaintHandlers } from './scene3d-surface-paint';
import { isPointerEventClaimed } from '../../renderer/util/pointer-claims';

// mobile-parity 7.3b P1 / P2 / S8: the surface-paint pointer state machine (DOM-free; the canvas IO is mocked).

const RECT = { left: 0, top: 0, width: 100, height: 100 };
type Call = [string, ...unknown[]];

function gestureEnv(opts: { miss?: boolean; wantsHover?: boolean } = {}) {
  const calls: Call[] = [];
  const frames: Array<() => void> = [];
  const captured = new Set<number>();
  let raycasts = 0;
  const io: SurfaceGestureIO = {
    measure: () => RECT,
    uvAt: (x, y) => { raycasts++; return opts.miss ? null : { u: x / 100, v: y / 100, sizeScale: 1 }; },
    capture: (id) => { captured.add(id); },
    release: (id) => { captured.delete(id); },
    requestFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelFrame: (id) => { frames[id - 1] = () => {}; },
  };
  const handlers: SurfacePaintHandlers = {
    begin: (u, v, _p, _s, info) => { calls.push(['begin', u, v, info?.pointerType]); },
    move: (u, v) => { calls.push(['move', u, v]); },
    end: () => { calls.push(['end']); },
    cancel: () => { calls.push(['cancel']); },
    hover: (uv) => { calls.push(['hover', uv]); },
    wantsHover: () => opts.wantsHover ?? true,
  };
  const g = new SurfacePaintGesture(io, () => handlers);
  const runFrames = () => { const fs = frames.splice(0); fs.forEach((f) => f()); };
  return { g, calls, captured, runFrames, raycasts: () => raycasts };
}

let stopped = 0;
function ev(type: string, id: number, x: number, y: number, extra: Record<string, unknown> = {}): PointerEvent {
  return {
    pointerId: id, pointerType: type, isPrimary: true, button: 0, buttons: 1, altKey: false,
    clientX: x, clientY: y, pressure: 0.5, timeStamp: 1000 + x,
    stopImmediatePropagation: () => { stopped++; }, preventDefault: () => {},
    ...extra,
  } as unknown as PointerEvent;
}

describe('P1 SurfacePaintGesture (touch arbitration)', () => {
  it('mouse: starts at once and is consumed; up ends', () => {
    const { g, calls } = gestureEnv();
    stopped = 0;
    g.down(ev('mouse', 1, 10, 10));
    expect(calls[0]).toEqual(['begin', 0.1, 0.1, 'mouse']);
    expect(stopped).toBe(1);
    g.move(ev('mouse', 1, 20, 10));
    expect(calls.some((c) => c[0] === 'move')).toBe(true);
    g.up(ev('mouse', 1, 20, 10, { buttons: 0 }));
    expect(calls[calls.length - 1]).toEqual(['end']);
    expect(g.state).toBe('idle');
  });

  it('touch: NOT consumed (the orbit controller sees the finger); the first dab waits for the next frame', () => {
    const { g, calls, runFrames } = gestureEnv();
    stopped = 0;
    const press = ev('touch', 7, 10, 10);
    g.down(press);
    expect(stopped).toBe(0);
    expect(isPointerEventClaimed(press)).toBe(true);     // …but claimed: raster / mesh-edit tools stand down
    expect(g.state).toBe('pending');
    expect(calls.filter((c) => c[0] === 'begin')).toHaveLength(0);
    runFrames();
    expect(g.state).toBe('drawing');
    expect(calls[0]).toEqual(['begin', 0.1, 0.1, 'touch']);
    g.move(ev('touch', 7, 30, 10));
    expect(stopped).toBe(0);                              // finger moves still reach the orbit controller
    g.up(ev('touch', 7, 30, 10, { buttons: 0 }));
    expect(calls[calls.length - 1]).toEqual(['end']);
  });

  it('touch: a quick tap (up before the first frame) still paints its dab', () => {
    const { g, calls } = gestureEnv();
    g.down(ev('touch', 7, 10, 10));
    g.up(ev('touch', 7, 10, 10, { buttons: 0 }));
    expect(calls.map((c) => c[0])).toEqual(['begin', 'end']);
  });

  it('touch: 8 px of movement starts the stroke before the frame, with the samples since the press', () => {
    const { g, calls } = gestureEnv();
    g.down(ev('touch', 7, 10, 10));
    g.move(ev('touch', 7, 13, 10));                        // < 8 px: still pending, sample queued
    expect(g.state).toBe('pending');
    g.move(ev('touch', 7, 20, 10));                        // ≥ 8 px → begin + the queued samples
    expect(g.state).toBe('drawing');
    expect(calls.map((c) => c[0])).toEqual(['begin', 'move', 'move']);
  });

  it('a second finger before the first dab → a gesture with NO paint at all', () => {
    const { g, calls, runFrames, captured } = gestureEnv();
    g.down(ev('touch', 7, 10, 10));
    const second = ev('touch', 8, 60, 60, { isPrimary: false });
    g.down(second);
    expect(isPointerEventClaimed(second)).toBe(false);   // the gesture finger reaches every handler
    runFrames();
    expect(calls.filter((c) => c[0] === 'begin' || c[0] === 'move' || c[0] === 'cancel')).toHaveLength(0);
    expect(g.state).toBe('blocked');
    expect(captured.size).toBe(0);
  });

  it('a second finger mid-stroke → the stroke is CANCELLED (its paint put back); nothing paints until all lift', () => {
    const { g, calls, runFrames } = gestureEnv();
    g.down(ev('touch', 7, 10, 10)); runFrames();
    g.move(ev('touch', 7, 30, 10));
    g.down(ev('touch', 8, 60, 60, { isPrimary: false }));
    expect(calls.filter((c) => c[0] === 'cancel')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'end')).toHaveLength(0);
    const n = calls.filter((c) => c[0] !== 'hover').length;
    g.move(ev('touch', 7, 40, 10)); g.move(ev('touch', 8, 70, 60, { isPrimary: false }));
    g.up(ev('touch', 8, 70, 60, { isPrimary: false, buttons: 0 }));
    g.move(ev('touch', 7, 50, 10));                        // one finger left: still blocked
    expect(calls.filter((c) => c[0] !== 'hover').length).toBe(n);
    g.up(ev('touch', 7, 50, 10, { buttons: 0 }));
    expect(g.state).toBe('idle');
    g.down(ev('touch', 9, 10, 10)); runFrames();           // a fresh single finger paints again
    expect(calls[calls.length - 1][0]).toBe('begin');
  });

  it('a missed up never leaves the fingers "stuck": the next primary finger starts a new sequence', () => {
    const { g, calls, runFrames } = gestureEnv();
    g.down(ev('touch', 7, 10, 10));
    g.down(ev('touch', 8, 60, 60, { isPrimary: false }));  // blocked; both ups get lost
    g.down(ev('touch', 9, 10, 10));                        // primary again → stale ids dropped
    runFrames();
    expect(g.state).toBe('drawing');
    expect(calls[calls.length - 1][0]).toBe('begin');
  });

  it('non-primary pointers never start a stroke; another pointer cannot steal a live stroke', () => {
    const { g, calls } = gestureEnv();
    g.down(ev('pen', 3, 10, 10, { isPrimary: false }));
    expect(g.state).toBe('idle');
    g.down(ev('mouse', 1, 10, 10));
    g.down(ev('pen', 3, 50, 50));
    g.move(ev('pen', 3, 60, 60));
    expect(calls.filter((c) => c[0] === 'begin')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'move')).toHaveLength(0);
  });

  it('pointercancel / lostpointercapture / a buttonless move end the stroke (never stuck)', () => {
    for (const end of ['cancel', 'lost', 'buttons'] as const) {
      const { g, calls } = gestureEnv();
      g.down(ev('mouse', 1, 10, 10));
      if (end === 'cancel') g.cancel(ev('mouse', 1, 10, 10));
      else if (end === 'lost') g.lostCapture(ev('mouse', 1, 10, 10));
      else g.move(ev('mouse', 1, 12, 10, { buttons: 0 }));
      expect(g.state).toBe('idle');
      expect(calls[calls.length - 1]).toEqual(['end']);
    }
    const { g, calls } = gestureEnv();                     // a pending touch stroke that is cancelled paints nothing
    g.down(ev('touch', 7, 10, 10));
    g.cancel(ev('touch', 7, 10, 10));
    expect(calls).toHaveLength(0);
    expect(g.touchCount).toBe(0);
    expect(g.state).toBe('idle');
  });

  it('P2: no hover raycast when nobody shows the link cursor, for a finger, or during a two-finger gesture', () => {
    const off = gestureEnv({ wantsHover: false });
    off.g.move(ev('mouse', 1, 10, 10, { buttons: 0 }));
    expect(off.raycasts()).toBe(0);
    const on = gestureEnv();
    on.g.move(ev('mouse', 1, 10, 10, { buttons: 0 }));
    expect(on.raycasts()).toBe(1);
    on.g.move(ev('touch', 5, 10, 10, { buttons: 0 }));   // a finger that isn't painting
    expect(on.raycasts()).toBe(1);
    on.g.down(ev('touch', 5, 10, 10));
    on.g.down(ev('touch', 6, 50, 50, { isPrimary: false }));
    const r = on.raycasts();
    on.g.move(ev('touch', 5, 20, 10)); on.g.move(ev('mouse', 1, 30, 10, { buttons: 0 }));
    expect(on.raycasts()).toBe(r);
  });

  it('a press that misses the mesh is let through untouched', () => {
    const { g, calls, captured } = gestureEnv({ miss: true });
    stopped = 0;
    g.down(ev('mouse', 1, 10, 10));
    expect(g.state).toBe('idle');
    expect(stopped).toBe(0);
    expect(captured.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('coalesced samples are raycast, at most MAX_SAMPLES per event, the newest kept', () => {
    const { g, calls } = gestureEnv();
    g.down(ev('mouse', 1, 10, 10));
    const list = Array.from({ length: 10 }, (_, k) => ev('mouse', 1, 11 + k, 10));
    g.move(ev('mouse', 1, 20, 10, { getCoalescedEvents: () => list }));
    const moves = calls.filter((c) => c[0] === 'move');
    expect(moves).toHaveLength(SurfacePaintGesture.MAX_SAMPLES);
    expect(moves[moves.length - 1][1]).toBeCloseTo(0.20);
  });

  it('session exit: a live stroke ends, a pending one is dropped', () => {
    const a = gestureEnv();
    a.g.down(ev('mouse', 1, 10, 10));
    a.g.reset();
    expect(a.calls[a.calls.length - 1]).toEqual(['end']);
    const b = gestureEnv();
    b.g.down(ev('touch', 7, 10, 10));
    b.g.reset();
    b.runFrames();
    expect(b.calls).toHaveLength(0);
  });
});
