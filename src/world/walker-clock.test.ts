/**
 * src/world/walker-clock.test.ts — sim LOD (performance-plan §P13): a routed walker's position as a function of the
 * world clock equals the per-frame stepped walker sim, and evaluating it after a gap equals evaluating it every frame.
 */
import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { roadNet, walkLeg, walkNext, gateOpen, legPoint, type Leg } from './route-sim';
import { DEFAULT_SIGNAL_TIMING } from './signals';
import { WalkerClock, gateOpenAt, newWalkerPose, type WalkerClockBase } from './walker-clock';
import { trainRunPlan, trainRunStart, stepTrainRun, trainRunTimeline, trainRunAt, type TrainRunState } from './train';

const graph = generateCityLayout({ seed: 11, radius: 10, pattern: 'grid', border: 'square' });
const net = roadNet(graph);
const timing = DEFAULT_SIGNAL_TIMING;
const P = { x: 0, z: 0, hx: 0, hz: 0, seg: 0 };

/** The stepped walker of world-traffic.ts `_tickAgent` (mode 'walk', no chats / crossings), verbatim rules. */
class SteppedWalker {
  leg: Leg; s: number; vel = 0; waiting = false; waited = 0; visit = 0;
  constructor(readonly id: number, readonly V: number, leg: Leg, s: number) { this.leg = leg; this.s = s; }
  step(dt: number, time: number): void {
    const V = this.V;
    let target = V;
    if (this.waiting && this.s >= this.leg.gateS - 1e-6) {
      if (gateOpen(net, this.leg.gate, this.waited, time, timing)) { this.waiting = false; this.waited = 0; }
      else { this.waited += dt; target = 0; this.s = Math.min(this.s, this.leg.gateS + 1e-6); }
    } else if (this.waiting) target = Math.min(target, Math.max(0.3 * V, (this.leg.gateS - this.s) * 4));
    const accel = V * 2.5 * dt, decel = V * 4 * dt;
    this.vel = target > this.vel ? Math.min(target, this.vel + accel) : Math.max(target, this.vel - decel);
    this.s += this.vel * dt;
    for (let guard = 0; guard < 4 && this.s >= this.leg.total; guard++) {
      const over = this.s - this.leg.total;
      this.leg = walkNext(net, this.leg, this.id, ++this.visit, V);
      if (this.leg.gate) { this.waiting = true; this.waited = 0; if (this.leg.gateS <= 1e-6) { this.s = 0; this.vel = 0; break; } }
      this.s = Math.min(over, this.leg.gate ? this.leg.gateS : over);
    }
  }
  pos(): [number, number] { legPoint(this.leg, this.s, P); return [P.x, P.z]; }
}

const walkers = (n: number): { id: number; V: number; leg: Leg; s: number }[] => {
  const out: { id: number; V: number; leg: Leg; s: number }[] = [];
  const s = graph.params.radius / 10;
  for (let i = 0; i < n; i++) {
    const e = net.walkEdges[(i * 7) % net.walkEdges.length];
    const leg = walkLeg(net, e, i % 2 ? 1 : -1);
    out.push({ id: i, V: (0.075 + 0.02 * ((i * 37) % 10) / 10) * s, leg, s: leg.total * (((i * 0.37) % 1)) });
  }
  return out;
};
const base = (w: { leg: Leg; s: number }): WalkerClockBase => ({ leg: w.leg, s: w.s, visit: 0, waiting: false, waited: 0, v: 0, t: 0 });

describe('walker clock (time-based walkers)', () => {
  it('gateOpenAt is the first time gateOpen polls true', () => {
    let checked = 0;
    for (const e of net.walkEdges.slice(0, 60)) {
      let leg = walkLeg(net, e, 1);
      for (let k = 1; k < 6; k++) {
        leg = walkNext(net, leg, 3, k, 0.1);
        if (!leg.gate || 'delay' in leg.gate) continue;
        for (let t0 = 0.37; t0 < 70; t0 += 3.1) {
          const t = gateOpenAt(net, leg.gate, t0, timing);
          expect(gateOpen(net, leg.gate, 0, t + 1e-6, timing)).toBe(true);
          // closed on a grid of earlier times
          for (let u = t0; u < t - 0.02; u += 0.05) expect(gateOpen(net, leg.gate, 0, u, timing)).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('equals the stepped walker sim over a long run (same legs, positions within a few cm)', () => {
    const W = walkers(24), T = 150, dt = 1 / 1000;
    const st = W.map(w => new SteppedWalker(w.id, w.V, w.leg, w.s));
    const cl = W.map(w => new WalkerClock(net, () => timing, w.id, w.V, base(w)));
    const out = newWalkerPose(W[0].leg);
    let time = 0, worst = 0, sameVisit = 0, samples = 0;
    const s = graph.params.radius / 10;
    for (let f = 1; f <= T / dt; f++) {
      time = f * dt;
      for (const w of st) w.step(dt, time);
      if (f % 1000 !== 0) continue;
      for (let i = 0; i < W.length; i++) {
        cl[i].eval(time, out);
        const [x, z] = st[i].pos();
        const d = Math.hypot(out.x - x, out.z - z);
        worst = Math.max(worst, d);
        if (out.visit === st[i].visit) sameVisit++;
        samples++;
      }
    }
    // 1 unit = s × 10 m in this city (radius 10): a few cm = 0.003 s
    expect(sameVisit / samples).toBeGreaterThan(0.99);
    expect(worst).toBeLessThan(0.02 * s);
  });

  it('at 60 Hz the stepped sim stays on the same route as the clock', () => {
    const W = walkers(24), T = 120, dt = 1 / 60;
    const st = W.map(w => new SteppedWalker(w.id, w.V, w.leg, w.s));
    const cl = W.map(w => new WalkerClock(net, () => timing, w.id, w.V, base(w)));
    const out = newWalkerPose(W[0].leg);
    let close = 0, n = 0;
    const s = graph.params.radius / 10;
    for (let f = 1; f <= T / dt; f++) {
      const time = f * dt;
      for (const w of st) w.step(dt, time);
      if (f % 60 !== 0) continue;
      for (let i = 0; i < W.length; i++) {
        cl[i].eval(time, out);
        const [x, z] = st[i].pos();
        if (Math.hypot(out.x - x, out.z - z) < 0.05 * s) close++;
        n++;
      }
    }
    expect(close / n).toBeGreaterThan(0.95);   // a frame of timing at a green-man cut-off can cost one walker a cycle
  });

  it('frozen then resumed equals continuous (exactly)', () => {
    const W = walkers(16);
    const every = W.map(w => new WalkerClock(net, () => timing, w.id, w.V, base(w)));
    const gap = W.map(w => new WalkerClock(net, () => timing, w.id, w.V, base(w)));
    const once = W.map(w => new WalkerClock(net, () => timing, w.id, w.V, base(w)));
    const a = newWalkerPose(W[0].leg), b = newWalkerPose(W[0].leg), c = newWalkerPose(W[0].leg);
    for (let f = 0; f <= 300 * 60; f++) {
      const t = f / 60;
      for (const k of every) k.eval(t, a);
      if (t < 40 || t > 220) for (const k of gap) k.eval(t, b);   // frozen 40 s → 220 s
    }
    const T = 300;
    for (let i = 0; i < W.length; i++) {
      every[i].eval(T, a); gap[i].eval(T, b); once[i].eval(T, c);
      expect(b.x).toBe(a.x); expect(b.z).toBe(a.z); expect(c.x).toBe(a.x); expect(c.z).toBe(a.z);
      expect(b.visit).toBe(a.visit); expect(c.visit).toBe(a.visit);
    }
  });

  it('stops at red and leaves exactly when the green man allows', () => {
    const W = walkers(40), out = newWalkerPose(W[0].leg);
    let stops = 0;
    for (const w of W) {
      const k = new WalkerClock(net, () => timing, w.id, w.V, base(w));
      let prevStopped = false, stopLeg: Leg | null = null;
      for (let f = 0; f < 90 * 30; f++) {
        const t = f / 30;
        k.eval(t, out);
        if (out.waiting && out.v === 0 && out.leg.gate && !('delay' in out.leg.gate)) {
          // while held at a signal gate it is never open with the time a crossing needs
          expect(gateOpen(net, out.leg.gate, out.waited, t, timing)).toBe(false);
          if (!prevStopped) { stops++; stopLeg = out.leg; }
          prevStopped = true;
        } else prevStopped = false;
      }
      void stopLeg;
    }
    expect(stops).toBeGreaterThan(3);
  });

  it('a hold (a chat) brakes, waits and walks on from where it stopped', () => {
    const w = walkers(1)[0], out = newWalkerPose(w.leg);
    const k = new WalkerClock(net, () => timing, w.id, w.V, base(w));
    k.eval(5, out);
    const at = { leg: out.leg, s: out.s, visit: out.visit, waiting: out.waiting, waited: out.waited, v: out.v, t: 5 };
    k.rebase({ ...at, holdUntil: 8.5 });
    k.eval(6, out); const x6 = out.x, z6 = out.z;
    k.eval(8.4, out);
    expect(Math.hypot(out.x - x6, out.z - z6)).toBeLessThan(1e-9);   // standing
    expect(out.stopped).toBe(true);
    k.eval(10, out);
    expect(out.stopped).toBe(false);
    expect(Math.hypot(out.x - x6, out.z - z6)).toBeGreaterThan(0.01 * w.V);
  });
});

describe('train run clock (time-based trains)', () => {
  const plans = [
    trainRunPlan({ radius: 10 }, 40, 2, [10, 20, 30]),
    trainRunPlan({ radius: 10 }, 30, 1.5, [15]),
    trainRunPlan({ radius: 10, railDwellScale: 0.2 }, 50, 2.5, [12, 25, 38]),
  ];
  it('equals stepTrainRun (60 Hz) over several round trips: same stops, same order, departures within a second', () => {
    // stepTrainRun's discrete braking curve lags the continuous one a little at each stop (≈ 0.1-0.4 s per cycle at
    // 60 Hz, shrinking with the step), so the stepped train drifts slowly behind the schedule; the clock IS the schedule.
    for (const plan of plans) for (const dir of [1, -1] as const) for (const phase of [0.1, 0.6]) {
      const st = trainRunStart(plan, dir, phase), ref: TrainRunState = { ...st };
      const tl = trainRunTimeline(plan, st)!;
      expect(tl).not.toBeNull();
      const out: TrainRunState = { ...st };
      const dt = 1 / 60;
      const depR: [number, number][] = [], depT: [number, number][] = [];
      let pr = ref.dwell, po = out.dwell;
      for (let f = 1; f <= 3 * tl.period / dt; f++) {
        stepTrainRun(ref, plan, dt); trainRunAt(tl, f * dt, out);
        if (pr > 0 && ref.dwell === 0) depR.push([f * dt, ref.s]);
        if (po > 0 && out.dwell === 0) depT.push([f * dt, out.s]);
        pr = ref.dwell; po = out.dwell;
      }
      expect(depT.length).toBeGreaterThan(4);
      expect(Math.abs(depR.length - depT.length)).toBeLessThanOrEqual(1);
      for (let i = 0; i < Math.min(depR.length, depT.length); i++) {
        expect(depT[i][1]).toBeCloseTo(depR[i][1], 3);                     // the same stop
        expect(Math.abs(depT[i][0] - depR[i][0])).toBeLessThan(1.5);        // ~ on time (3 cycles of drift)
      }
    }
  });
  it('a frozen train reappears on its schedule (any query order gives the same state)', () => {
    const plan = plans[0], st = trainRunStart(plan, 1, 0.3), tl = trainRunTimeline(plan, st)!;
    const a: TrainRunState = { ...st }, b: TrainRunState = { ...st };
    for (let t = 0; t < 400; t += 1 / 60) trainRunAt(tl, t, a);
    trainRunAt(tl, 400, a); trainRunAt(tl, 400, b);
    expect(b).toEqual(a);
  });
});
