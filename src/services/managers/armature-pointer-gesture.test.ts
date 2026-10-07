/**
 * armature-pointer-gesture.test.ts — TOUCH-9: the armature overlay's pointer state machine (DOM-free).
 *  - mouse: pick-on-down, the drag starts at once; a miss lets the press through; hover coalesced to one per frame;
 *  - finger: picked on the press, the drag starts after a frame or 8 px, FROM the press point; a quick tap selects;
 *  - a 2nd finger cancels (restore) and blocks until every finger lifts; pointercancel cancels; lost capture ends;
 *  - bone placement: mouse on the press, finger on a tap (release within the slop), never after a pinch.
 */
import { describe, it, expect } from 'vitest';
import { ArmaturePointerGesture, type ArmGestureHandlers, type ArmGesturePointer } from './armature-pointer-gesture';

type T = { kind: 'joint' | 'place' };

function setup(opts: { hit?: T | null } = {}) {
  const log: string[] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const captured = new Set<number>();
  let hit: T | null = opts.hit === undefined ? { kind: 'joint' } : opts.hit;
  const touches: boolean[] = [];
  const h: ArmGestureHandlers<T> = {
    pick: (x, y, _r, touch) => { touches.push(touch); log.push(`pick ${x},${y}`); return hit; },
    isTap: (t) => t.kind === 'place',
    tap: (_t, x, y) => log.push(`tap ${x},${y}`),
    pendingMove: (_t, x, y) => log.push(`preview ${x},${y}`),
    begin: (_t, x, y) => { log.push(`begin ${x},${y}`); return true; },
    move: (x, y) => log.push(`move ${x},${y}`),
    end: () => log.push('end'),
    cancel: () => log.push('cancel'),
    hover: (x, y) => log.push(`hover ${x},${y}`),
    claim: () => log.push('claim'),
  };
  const g = new ArmaturePointerGesture<T>({
    measure: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    capture: (id) => captured.add(id),
    release: (id) => captured.delete(id),
    requestFrame: (cb) => { frames.set(++nextFrame, cb); return nextFrame; },
    cancelFrame: (id) => { frames.delete(id); },
  }, h);
  const flush = () => { const fs = [...frames.values()]; frames.clear(); fs.forEach(f => f()); };
  const ev = (init: Partial<ArmGesturePointer>): ArmGesturePointer => ({
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, altKey: false, clientX: 0, clientY: 0,
    preventDefault: () => {}, ...init,
  } as ArmGesturePointer);
  const finger = (id: number, x: number, y: number, extra: Partial<ArmGesturePointer> = {}) =>
    ev({ pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, ...extra });
  return { g, log, flush, ev, finger, captured, touches, setHit: (t: T | null) => { hit = t; } };
}

describe('ArmaturePointerGesture — mouse (unchanged semantics)', () => {
  it('picks on the press and starts the drag at once; moves drive it; up ends it', () => {
    const { g, log, ev, captured } = setup();
    expect(g.down(ev({ clientX: 10, clientY: 20 }))).toBe(true);
    expect(g.state).toBe('dragging');
    expect(captured.has(1)).toBe(true);
    g.move(ev({ clientX: 15, clientY: 25 }));
    g.up(ev({ clientX: 15, clientY: 25, buttons: 0 }));
    expect(log).toEqual(['pick 10,20', 'begin 10,20', 'move 15,25', 'end']);
    expect(g.state).toBe('idle');
    expect(captured.size).toBe(0);
  });

  it('a miss lets the press through (not taken); Alt / right button never pick', () => {
    const { g, log, ev } = setup({ hit: null });
    expect(g.down(ev({}))).toBe(false);
    expect(g.down(ev({ altKey: true }))).toBe(false);
    expect(g.down(ev({ button: 2 }))).toBe(false);
    expect(log).toEqual(['pick 0,0']);
  });

  it('hover is coalesced to one per frame and never runs during a drag', () => {
    const { g, log, ev, flush } = setup();
    g.move(ev({ clientX: 1, clientY: 1, buttons: 0 }));
    g.move(ev({ clientX: 2, clientY: 2, buttons: 0 }));
    g.move(ev({ clientX: 3, clientY: 3, buttons: 0 }));
    flush();
    expect(log).toEqual(['hover 3,3']);
    log.length = 0;
    g.move(ev({ clientX: 4, clientY: 4, buttons: 0 }));
    g.down(ev({ clientX: 4, clientY: 4 }));   // the press drops the pending hover
    flush();
    expect(log).toEqual(['pick 4,4', 'begin 4,4']);
  });

  it('bone placement acts on the mouse PRESS (a tap target never drags)', () => {
    const { g, log, ev } = setup({ hit: { kind: 'place' } });
    expect(g.down(ev({ clientX: 7, clientY: 8 }))).toBe(true);
    expect(g.state).toBe('idle');
    expect(log).toEqual(['pick 7,8', 'tap 7,8']);
  });

  it('a move with no button held ends a drag whose up was missed', () => {
    const { g, log, ev } = setup();
    g.down(ev({}));
    g.move(ev({ clientX: 5, buttons: 0 }));
    expect(log.at(-1)).toBe('end');
    expect(g.state).toBe('idle');
  });
});

describe('ArmaturePointerGesture — finger (TOUCH-9)', () => {
  it('picks on the press with touch=true, claims it, but starts the drag only after 8 px — from the PRESS point', () => {
    const { g, log, finger, touches } = setup();
    g.down(finger(1, 100, 100));
    expect(touches).toEqual([true]);
    expect(g.state).toBe('pending');
    g.move(finger(1, 104, 103));                   // 5 px: still a press
    expect(log).toEqual(['pick 100,100', 'claim']);
    g.move(finger(1, 112, 100));
    expect(log).toEqual(['pick 100,100', 'claim', 'begin 100,100', 'move 112,100']);
    g.up(finger(1, 112, 100, { buttons: 0 }));
    expect(log.at(-1)).toBe('end');
  });

  it('…or after one frame', () => {
    const { g, log, finger, flush } = setup();
    g.down(finger(1, 50, 50));
    flush();
    expect(g.state).toBe('dragging');
    expect(log).toContain('begin 50,50');
  });

  it('a quick tap still selects (begin + end, like a click)', () => {
    const { g, log, finger } = setup();
    g.down(finger(1, 50, 50));
    g.up(finger(1, 50, 50, { buttons: 0 }));
    expect(log).toEqual(['pick 50,50', 'claim', 'begin 50,50', 'end']);
  });

  it('a 2nd finger before the drag starts leaves NOTHING behind; nothing starts until every finger lifts', () => {
    const { g, log, finger, flush } = setup();
    g.down(finger(1, 50, 50));
    expect(g.down(finger(2, 300, 50))).toBe(false);
    flush();                                        // the first-move frame was cancelled
    g.move(finger(1, 90, 50));
    g.up(finger(2, 300, 50, { buttons: 0 }));
    g.move(finger(1, 120, 50));                     // the remaining finger: still blocked
    g.down(finger(3, 10, 10, { isPrimary: false }));
    g.up(finger(3, 10, 10, { buttons: 0 }));
    g.up(finger(1, 120, 50, { buttons: 0 }));
    expect(log).toEqual(['pick 50,50', 'claim']);
    expect(g.state).toBe('idle');
    g.down(finger(1, 5, 5));                        // a fresh press works again
    expect(g.state).toBe('pending');
  });

  it('a 2nd finger during a drag CANCELS it (restore) and the drag never moves again', () => {
    const { g, log, finger } = setup();
    g.down(finger(1, 50, 50));
    g.move(finger(1, 70, 50));
    g.down(finger(2, 300, 50));
    g.move(finger(1, 90, 50));
    g.up(finger(1, 90, 50, { buttons: 0 }));
    g.up(finger(2, 300, 50, { buttons: 0 }));
    expect(log).toEqual(['pick 50,50', 'claim', 'begin 50,50', 'move 70,50', 'cancel']);
    expect(log).not.toContain('end');
  });

  it('pointercancel cancels a drag (restore); lostpointercapture ends it (keeps the result)', () => {
    const a = setup();
    a.g.down(a.finger(1, 0, 0)); a.g.move(a.finger(1, 20, 0));
    a.g.cancel(a.finger(1, 20, 0));
    expect(a.log.at(-1)).toBe('cancel');
    expect(a.g.state).toBe('idle');
    const b = setup();
    b.g.down(b.ev({})); b.g.lostCapture(b.ev({}));
    expect(b.log.at(-1)).toBe('end');
    b.g.lostCapture(b.ev({}));                     // after it ended: a no-op
    expect(b.log.filter(x => x === 'end')).toHaveLength(1);
  });

  it('a finger never hovers', () => {
    const { g, log, finger, flush } = setup({ hit: null });
    g.move(finger(1, 5, 5, { buttons: 0 }));
    flush();
    expect(log).toEqual([]);
  });

  it('bone placement on a finger: a TAP places at the release point; a drag past the slop or a pinch places nothing', () => {
    const a = setup({ hit: { kind: 'place' } });
    a.g.down(a.finger(1, 40, 40));
    a.g.move(a.finger(1, 43, 41));
    a.g.up(a.finger(1, 43, 41, { buttons: 0 }));
    expect(a.log).toEqual(['pick 40,40', 'claim', 'preview 43,41', 'tap 43,41']);
    const b = setup({ hit: { kind: 'place' } });
    b.g.down(b.finger(1, 40, 40)); b.g.move(b.finger(1, 80, 40)); b.g.up(b.finger(1, 40, 40, { buttons: 0 }));
    expect(b.log.some(x => x.startsWith('tap'))).toBe(false);
    const c = setup({ hit: { kind: 'place' } });
    c.g.down(c.finger(1, 40, 40)); c.g.down(c.finger(2, 90, 40)); c.g.up(c.finger(2, 90, 40)); c.g.up(c.finger(1, 40, 40));
    expect(c.log.some(x => x.startsWith('tap'))).toBe(false);
  });

  it('reset ends a live drag and drops a pending press', () => {
    const a = setup();
    a.g.down(a.ev({})); a.g.reset();
    expect(a.log.at(-1)).toBe('end');
    const b = setup();
    b.g.down(b.finger(1, 0, 0)); b.g.reset(); b.flush();
    expect(b.log).toEqual(['pick 0,0', 'claim']);
    expect(b.g.state).toBe('idle');
  });
});
