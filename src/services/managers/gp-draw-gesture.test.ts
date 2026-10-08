/**
 * gp-draw-gesture.test.ts — the Grease Pencil draw / erase pointer state machine (gp-draw-gesture.ts): mouse / pen
 * presses are the pencil's (consumed), fingers are claimed but never stopped (the camera pinches), a second finger
 * takes the stroke back, a lost pointer can never leave a stroke stuck, pen pressure + the pen's eraser end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GpDrawGesture, type GpDrawGestureHandlers, type GpGesturePointer, type GpGestureSample } from './gp-draw-gesture';

type Ev = GpGesturePointer & { stopped: boolean; prevented: boolean };

function ev(init: Partial<GpGesturePointer> = {}): Ev {
  const e = {
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, altKey: false,
    clientX: 10, clientY: 20, pressure: 0.5,
    stopped: false, prevented: false,
    stopImmediatePropagation() { e.stopped = true; },
    preventDefault() { e.prevented = true; },
    ...init,
  } as Ev;
  return e;
}

function setup(beginResult = true) {
  const log: string[] = [];
  const samples: GpGestureSample[] = [];
  const claimed = new Set<object>();
  const captured = new Set<number>();
  let lastErase: boolean | null = null;
  const handlers: GpDrawGestureHandlers = {
    begin: (s, erase) => { log.push('begin'); samples.push(s); lastErase = erase; return beginResult; },
    move: (s) => { log.push('move'); samples.push(s); },
    end: () => { log.push('end'); },
    cancel: () => { log.push('cancel'); },
  };
  const g = new GpDrawGesture({
    capture: (id) => { captured.add(id); },
    release: (id) => { captured.delete(id); },
    claim: (e) => { claimed.add(e); },
  }, () => handlers);
  return { g, log, samples, claimed, captured, erase: () => lastErase };
}

describe('GpDrawGesture — mouse / pen', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('a left press starts a stroke and is consumed; moves add samples; the lift ends it', () => {
    const down = ev();
    t.g.down(down);
    expect(t.log).toEqual(['begin']);
    expect(down.stopped).toBe(true);
    expect(down.prevented).toBe(true);
    expect(t.captured.has(1)).toBe(true);
    const mv = ev({ clientX: 30 });
    t.g.move(mv);
    expect(mv.stopped).toBe(true);
    t.g.up(ev({ buttons: 0 }));
    expect(t.log).toEqual(['begin', 'move', 'end']);
    expect(t.captured.size).toBe(0);
    expect(t.g.state).toBe('idle');
  });

  it('a mouse draws at full pressure (it reports 0.5 while pressed); a pen keeps its pressure, clamped above 0', () => {
    t.g.down(ev({ pressure: 0.5 }));
    expect(t.samples[0].pressure).toBe(1);
    t.g.up(ev({ buttons: 0 }));
    t.g.down(ev({ pointerId: 2, pointerType: 'pen', pressure: 0.3 }));
    expect(t.samples[1].pressure).toBeCloseTo(0.3, 6);
    t.g.move(ev({ pointerId: 2, pointerType: 'pen', pressure: 0 }));
    expect(t.samples[2].pressure).toBe(GpDrawGesture.MIN_PEN_PRESSURE);
  });

  it('Alt+left (orbit), middle and right buttons pass through untouched', () => {
    for (const init of [{ altKey: true }, { button: 1, buttons: 4 }, { button: 2, buttons: 2 }]) {
      const e = ev(init);
      t.g.down(e);
      expect(e.stopped).toBe(false);
      expect(e.prevented).toBe(false);
    }
    expect(t.log).toEqual([]);
  });

  it("the pen's eraser end erases whatever the tool", () => {
    t.g.down(ev({ pointerType: 'pen', button: 5, buttons: 32 }));
    expect(t.log).toEqual(['begin']);
    expect(t.erase()).toBe(true);
    t.g.move(ev({ pointerType: 'pen', buttons: 32 }));     // still held (eraser bit) → a sample, not a missed up
    expect(t.log).toEqual(['begin', 'move']);
  });

  it('a declined press (begin → false: the ray missed the plane) passes on and starts nothing', () => {
    const d = setup(false);
    const e = ev();
    d.g.down(e);
    expect(e.stopped).toBe(false);
    expect(d.g.state).toBe('idle');
    d.g.move(ev());
    expect(d.log).toEqual(['begin']);
  });

  it('a move with no button held ends the stroke (a missed up never leaves it stuck)', () => {
    t.g.down(ev());
    t.g.move(ev({ buttons: 0 }));
    expect(t.log).toEqual(['begin', 'end']);
    expect(t.g.state).toBe('idle');
  });

  it('pointercancel and lostpointercapture end (and keep) the stroke', () => {
    t.g.down(ev());
    t.g.cancel(ev());
    expect(t.log).toEqual(['begin', 'end']);
    t.g.down(ev());
    t.g.lostCapture({ pointerId: 1 });
    expect(t.log).toEqual(['begin', 'end', 'begin', 'end']);
    t.g.lostCapture({ pointerId: 1 });                     // after the end: no-op
    expect(t.log.length).toBe(4);
  });

  it('another pointer cannot start a second stroke or move the first', () => {
    t.g.down(ev());
    t.g.down(ev({ pointerId: 2, pointerType: 'pen' }));
    t.g.move(ev({ pointerId: 2, pointerType: 'pen' }));
    expect(t.log).toEqual(['begin']);
  });

  it('coalesced samples are all used (capped, newest kept)', () => {
    t.g.down(ev());
    const list = Array.from({ length: 20 }, (_, i) => ev({ clientX: i }));
    t.g.move(ev({ getCoalescedEvents: () => list }));
    const moves = t.samples.slice(1);
    expect(moves).toHaveLength(GpDrawGesture.MAX_SAMPLES);
    expect(moves[moves.length - 1].clientX).toBe(19);
  });

  it('reset() (leaving draw mode) ends a live stroke normally', () => {
    t.g.down(ev());
    t.g.reset();
    expect(t.log).toEqual(['begin', 'end']);
    expect(t.g.state).toBe('idle');
  });
});

describe('GpDrawGesture — touch', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });
  const finger = (id: number, init: Partial<GpGesturePointer> = {}) =>
    ev({ pointerId: id, pointerType: 'touch', isPrimary: id === 1, pressure: 0.4, ...init });

  it('a finger draws (full pressure) but is never stopped — only claimed, so the camera still tracks it', () => {
    const d = finger(1);
    t.g.down(d);
    expect(t.log).toEqual(['begin']);
    expect(d.stopped).toBe(false);
    expect(t.claimed.has(d)).toBe(true);
    expect(t.samples[0].pressure).toBe(1);
    const m = finger(1, { clientX: 50 });
    t.g.move(m);
    expect(m.stopped).toBe(false);
    t.g.up(finger(1, { buttons: 0 }));
    expect(t.log).toEqual(['begin', 'move', 'end']);
  });

  it('a second finger takes the stroke back and nothing draws until every finger lifts', () => {
    t.g.down(finger(1));
    t.g.move(finger(1, { clientX: 40 }));
    t.g.down(finger(2));
    expect(t.log).toEqual(['begin', 'move', 'cancel']);
    expect(t.g.state).toBe('blocked');
    t.g.move(finger(1, { clientX: 60 }));                  // the pinch: no paint
    t.g.up(finger(2, { buttons: 0 }));
    expect(t.g.state).toBe('blocked');                      // one finger still down
    t.g.down(finger(3, { isPrimary: false }));
    expect(t.log).toEqual(['begin', 'move', 'cancel']);
    t.g.up(finger(3, { buttons: 0 }));
    t.g.up(finger(1, { buttons: 0 }));
    expect(t.g.state).toBe('idle');
    t.g.down(finger(1));                                     // a fresh touch draws again
    expect(t.log).toEqual(['begin', 'move', 'cancel', 'begin']);
  });

  it('a primary finger after a missed up starts fresh (stale ids are dropped)', () => {
    t.g.down(finger(7, { isPrimary: false }));               // a stray finger that never lifted (never draws)
    t.g.down(finger(1));
    expect(t.g.touchCount).toBe(1);
    expect(t.log).toEqual(['begin']);
  });
});
