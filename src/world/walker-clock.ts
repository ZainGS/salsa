/**
 * WALKER CLOCK (engine-roadmap step 1, performance-plan.md §P13): a routed walker's position as a FUNCTION OF THE WORLD
 * CLOCK instead of per-frame stepping.
 *
 * The rules are the per-frame walker sim's (world-traffic.ts `_tickAgent`, mode 'walk'), written in continuous time:
 *   - the route is the same leg chain: `walkNext(net, leg, id, ++visit, speed)` at every corner (deterministic);
 *   - cruise at the walker's speed V; from a stop, accelerate at 2.5·V/s;
 *   - on a gated leg (a zebra waiting for the green man, a turn-round beat), the approach envelope
 *     v ≤ max(0.3·V, 4·d) (d = distance to the gate): v follows 4·d down to 0.3·V, then creeps to the gate;
 *   - at the gate: pass at once if it is open (green with enough time left, `gateOpen`), else stop and wait until it
 *     opens (computed exactly from the signal phase clock, signals.ts), then accelerate again;
 *   - a gate at the very start of a leg (gateS = 0) stops the walker instantly, as the stepped sim does;
 *   - a HOLD (a chat, a closed level crossing): brake at 4·V/s to a stop, hold, then accelerate.
 *
 * The motion between two stops is a short list of analytic segments (constant speed, constant acceleration, the
 * exponential 4·d approach), so `eval(t)` is O(1) inside a run and O(events) across a gap: a walker frozen in the fog
 * for a minute costs nothing while frozen and lands, when evaluated again, exactly where the clock says. Because a run
 * is built only from the previous run's end state (never from the query times), evaluating every frame, every half
 * second or once after a long gap gives the SAME positions (tested in walker-clock.test.ts).
 */
import { walkNext, legPoint, type RoadNet, type Leg } from './route-sim';
import { signalCycle, SIGNAL_BUCKETS, type SignalTiming } from './signals';

/** Where a walker clock starts from (a spawn, a rebase after a chat / a visit / a level-crossing hold). */
export interface WalkerClockBase {
  leg: Leg; s: number; visit: number;
  /** On a gated leg, not yet through its gate. */
  waiting: boolean;
  /** Seconds already waited at the gate (when at it). */
  waited: number;
  /** Speed at `t` (world units / s). */
  v: number;
  /** World-clock time of this state (seconds). */
  t: number;
  /** Brake to a stop and hold until this time (a chat). Infinity = until rebased again (a closed level crossing). */
  holdUntil?: number;
  /** With an infinite hold: stop at this distance ahead (along the route; a level crossing's stop line). */
  stopIn?: number;
}

/** A walker's state at a time. */
export interface WalkerPose {
  leg: Leg; s: number; visit: number; waiting: boolean; waited: number;
  x: number; z: number; hx: number; hz: number; v: number;
  /** Holding (a chat / a crossing) or waiting at a gate. */
  stopped: boolean;
}

export function newWalkerPose(leg: Leg): WalkerPose {
  return { leg, s: 0, visit: 0, waiting: false, waited: 0, x: 0, z: 0, hx: 1, hz: 0, v: 0, stopped: false };
}

const enum SegKind { Const = 0, Acc = 1, Exp = 2, Hold = 3 }
interface Seg { kind: SegKind; t0: number; dur: number; x0: number; v0: number; a: number; G: number }

/** One stop-to-stop stretch: the legs it covers, its segments and how it ends. */
interface Run {
  t0: number; tEnd: number;
  legs: Leg[]; off: number[]; visit0: number;
  segs: Seg[];
  /** The gate leg index (waiting on it until `xGate`) or -1. */
  gateIdx: number; xGate: number; tArrive: number;
  /** How the next run starts. */
  next: WalkerClockBase | null;
}

/** Acceleration from a stop and the stepped sim's braking rate, as multiples of the walker speed. */
export const WALKER_ACCEL = 2.5;
export const WALKER_DECEL = 4;
/** The approach envelope v = APPROACH_K · d, floored at APPROACH_FLOOR · V (world-traffic.ts `_tickAgent`). */
export const APPROACH_K = 4;
export const APPROACH_FLOOR = 0.3;
/** How far ahead (seconds of cruising) one run looks for a gate before ending at a leg boundary. */
const HORIZON_S = 45;
const MAX_LEGS = 24;

/** First time ≥ `t` a walker's gate is open (`gateOpen` in route-sim.ts, solved instead of polled). */
export function gateOpenAt(net: RoadNet, gate: Leg['gate'], tArrive: number, timing: SignalTiming): number {
  if (!gate) return tArrive;
  if ('delay' in gate) return tArrive + gate.delay;
  const sig = net.nodes[gate.node]?.signal;
  if (!sig) return tArrive;
  const C = signalCycle(timing), g = timing.green, m = Math.min(gate.minGreen, g * 0.8);
  let tc = (tArrive + sig.bucket * C / SIGNAL_BUCKETS) % C; if (tc < 0) tc += C;
  if (gate.axis === 1) { tc -= C / 2; if (tc < 0) tc += C; }
  // green with remaining = g - tc ≥ m  ⇔  tc ≤ g - m   (signalState: green while tc < g)
  if (tc < g && g - tc >= m) return tArrive;
  return tArrive + (C - tc);
}

export class WalkerClock {
  private _run: Run;
  private _seg = 0;
  private _legI = 0;
  /** Runs built so far (diagnostics: how much a gap cost). */
  runsBuilt = 0;

  constructor(private readonly net: RoadNet, private readonly timing: () => SignalTiming, readonly id: number, readonly speed: number, base: WalkerClockBase) {
    this._run = this._build(base);
  }

  /** Restart from a new state (a chat hold, a visit return, a crossing hold / release, a timing change). */
  rebase(base: WalkerClockBase): void { this._run = this._build(base); this._seg = 0; this._legI = 0; }

  /** The state at world time `t` (monotonic; an earlier `t` is clamped to the current run's start). */
  eval(t: number, out: WalkerPose): WalkerPose {
    let r = this._run;
    for (let guard = 0; guard < 10000 && t >= r.tEnd && r.next; guard++) { r = this._run = this._build(r.next); this._seg = 0; this._legI = 0; }
    const tt = Math.max(r.t0, Math.min(t, r.tEnd));
    // segment (cursor forward; queries are monotonic)
    let si = this._seg;
    if (si >= r.segs.length || r.segs[si].t0 > tt) si = 0;
    while (si < r.segs.length - 1 && tt >= r.segs[si].t0 + r.segs[si].dur) si++;
    this._seg = si;
    let x = 0, v = 0, hold = false;
    if (r.segs.length) {
      const g = r.segs[si], tau = Math.max(0, Math.min(g.dur, tt - g.t0));
      switch (g.kind) {
        case SegKind.Const: x = g.x0 + g.v0 * tau; v = g.v0; break;
        case SegKind.Acc: x = g.x0 + g.v0 * tau + 0.5 * g.a * tau * tau; v = g.v0 + g.a * tau; break;
        case SegKind.Exp: { const d0 = g.G - g.x0, d = d0 * Math.exp(-APPROACH_K * tau); x = g.G - d; v = APPROACH_K * d; break; }
        default: x = g.x0; v = 0; hold = true; break;
      }
    }
    // leg of chain distance x
    let li = this._legI;
    if (li >= r.legs.length || r.off[li] > x + 1e-12) li = 0;
    while (li < r.legs.length - 1 && x >= r.off[li + 1] - 1e-12) li++;
    this._legI = li;
    const leg = r.legs[li], s = x - r.off[li];
    out.leg = leg; out.s = s; out.visit = r.visit0 + li; out.v = v;
    out.waiting = li === r.gateIdx && x < r.xGate + 1e-9 && r.gateIdx >= 0;
    out.waited = out.waiting && tt >= r.tArrive ? tt - r.tArrive : 0;
    out.stopped = hold;
    legPoint(leg, s, LP);
    out.x = LP.x; out.z = LP.z; out.hx = LP.hx; out.hz = LP.hz;
    return out;
  }

  // ── run construction ──────────────────────────────────────────────────────────────────────────────────────────
  private _build(b: WalkerClockBase): Run {
    this.runsBuilt++;
    const V = Math.max(1e-6, this.speed), A = WALKER_ACCEL * V, Dd = WALKER_DECEL * V;
    const legs: Leg[] = [b.leg], off: number[] = [-b.s];
    const segs: Seg[] = [];
    const run: Run = { t0: b.t, tEnd: b.t, legs, off, visit0: b.visit, segs, gateIdx: -1, xGate: Infinity, tArrive: Infinity, next: null };
    let t = b.t, x = 0, v = Math.max(0, Math.min(V, b.v));
    const push = (kind: SegKind, dur: number, x0: number, v0: number, a: number, G: number): void => {
      if (dur > 0 || !segs.length) segs.push({ kind, t0: t, dur: Math.max(0, dur), x0, v0, a, G });
    };
    // ── the gate ahead (on this leg while waiting, else the first gated leg of the chain) ──
    let G = Infinity, E = -Infinity, gateIdx = -1, instant = false;
    const virtualStop = b.holdUntil === Infinity && b.stopIn !== undefined;
    if (b.waiting && b.leg.gate) { gateIdx = 0; G = b.leg.gateS - b.s; E = -Infinity; instant = false; }
    const extend = (): boolean => {   // add one leg; true when it carries a gate
      const k = legs.length, prev = legs[k - 1];
      const nl = walkNext(this.net, prev, this.id, b.visit + k, V);
      legs.push(nl); off.push(off[k - 1] + prev.total);
      if (nl.gate) { gateIdx = k; G = off[k] + nl.gateS; E = off[k]; instant = nl.gateS <= 1e-6; return true; }
      return false;
    };
    // ── a HOLD first: brake to a stop (at 4·V/s), hold ──
    let holdUntil = b.holdUntil ?? -Infinity;
    if (holdUntil > t || virtualStop) {
      let stopX = virtualStop ? Math.max(0, b.stopIn!) : (v * v) / (2 * Dd);
      if (G < Infinity && stopX > G) stopX = Math.max(0, G);
      while (off[legs.length - 1] + legs[legs.length - 1].total < stopX && legs.length < MAX_LEGS) if (extend() && G < stopX) { stopX = G; break; }
      if (stopX > 1e-9 && v > 1e-9) {
        const a = -(v * v) / (2 * stopX), dur = v / -a;
        push(SegKind.Acc, dur, 0, v, a, 0); t += dur; x = stopX; v = 0;
      } else { x = stopX; v = 0; }
      if (holdUntil === Infinity) {   // until rebased (the crossing opens)
        push(SegKind.Hold, Infinity, x, 0, 0, 0);
        run.tEnd = Infinity; run.gateIdx = gateIdx; run.xGate = G; return run;
      }
      push(SegKind.Hold, holdUntil - t, x, 0, 0, 0); t = Math.max(t, holdUntil);
      if (G < Infinity && x >= G - 1e-9 && gateIdx >= 0) {   // held AT the gate: it is the arrival
        return this._arrive(run, b, gateIdx, G, t, 0, t, true);
      }
    }
    // ── at the gate already (a clock started while waiting) ──
    if (gateIdx === 0 && G <= 1e-9) return this._arrive(run, b, 0, Math.max(0, G), t, b.leg.gateS <= 1e-6 ? 0 : v, t - Math.max(0, b.waited), false);
    // ── find the stop within the horizon ──
    const horizon = HORIZON_S * V;
    while (G === Infinity && legs.length < MAX_LEGS && off[legs.length - 1] + legs[legs.length - 1].total - x < horizon) if (extend()) break;
    const xEnd = G < Infinity ? G : off[legs.length - 1] + legs[legs.length - 1].total;
    const cap = (xx: number): number => (G === Infinity || xx < E) ? V : Math.min(V, Math.max(APPROACH_FLOOR * V, APPROACH_K * (G - xx)));
    for (let guard = 0; guard < 64 && x < xEnd - 1e-9; guard++) {
      if (instant && x >= E - 1e-12) break;
      const c = cap(x);
      if (v > c + 1e-9) v = c;   // entering a gated leg inside its envelope: drop onto it
      if (v < c - 1e-9) {
        // ACCELERATE until v reaches the cap (cruise / the envelope / the creep floor) or a boundary
        let tau = (V - v) / A;
        if (x < E && G < Infinity) tau = Math.min(tau, (-v + Math.sqrt(v * v + 2 * A * (Math.min(E, xEnd) - x))) / A);
        else if (G < Infinity) {
          const d0 = G - x;
          if (APPROACH_K * d0 > APPROACH_FLOOR * V) {   // meet v = 4·d: 2Aτ² + (A + 4v)τ + (v − 4·d0) = 0
            const qa = 2 * A, qb = A + APPROACH_K * v, qc = v - APPROACH_K * d0;
            tau = Math.min(tau, (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa));
          } else tau = Math.min(tau, (APPROACH_FLOOR * V - v) / A);
          tau = Math.min(tau, (-v + Math.sqrt(v * v + 2 * A * d0)) / A);   // (never past the gate)
        } else tau = Math.min(tau, (-v + Math.sqrt(v * v + 2 * A * (xEnd - x))) / A);
        tau = Math.max(0, tau);
        push(SegKind.Acc, tau, x, v, A, 0);
        x += v * tau + 0.5 * A * tau * tau; v = Math.min(V, v + A * tau); t += tau;
        if (tau <= 1e-12) v = c;   // numerically stuck at a boundary: snap onto the cap
        continue;
      }
      // FOLLOW THE CAP
      const inEnv = G < Infinity && x >= E - 1e-12, d0 = G - x;
      if (!inEnv || APPROACH_K * d0 > V + 1e-12) {
        // cruise: to the end (no gate), to the gated leg's start, or to where the envelope starts to bind
        const xs = G === Infinity ? xEnd : !inEnv ? Math.min(E, xEnd) : G - V / APPROACH_K;
        const dur = Math.max(0, xs - x) / V;
        push(SegKind.Const, dur, x, V, 0, 0); t += dur; x = Math.max(x, xs); v = V;
        continue;
      }
      if (APPROACH_K * d0 > APPROACH_FLOOR * V + 1e-12) {
        const dEnd = APPROACH_FLOOR * V / APPROACH_K, dur = Math.log(d0 / dEnd) / APPROACH_K;
        push(SegKind.Exp, dur, x, APPROACH_K * d0, 0, G); t += dur; x = G - dEnd; v = APPROACH_FLOOR * V;
        continue;
      }
      const dur = d0 / (APPROACH_FLOOR * V);
      push(SegKind.Const, dur, x, APPROACH_FLOOR * V, 0, 0); t += dur; x = G; v = APPROACH_FLOOR * V;
    }
    if (G < Infinity && gateIdx >= 0) return this._arrive(run, b, gateIdx, G, t, instant ? 0 : v, t, false);
    // horizon: the next run starts at the start of the last leg (or its end, at the leg cap)
    const last = legs.length - 1;
    run.tEnd = t;
    run.next = x >= off[last] + legs[last].total - 1e-9
      ? { leg: walkNext(this.net, legs[last], this.id, b.visit + last + 1, V), s: 0, visit: b.visit + last + 1, waiting: false, waited: 0, v, t }
      : { leg: legs[last], s: x - off[last], visit: b.visit + last, waiting: false, waited: 0, v, t };
    // (a horizon end at a leg cap re-derives the next leg: the run's legs array owns legs up to `last` only)
    if (run.next.s === 0 && run.next.leg.gate) { run.next.waiting = true; }
    if (!segs.length) push(SegKind.Const, 0, x, v, 0, 0);
    return run;
  }

  /** Arrival at the gate at time `t` (speed `v`; `tArr` = when the walker got there, for an already-waiting start). */
  private _arrive(run: Run, b: WalkerClockBase, gateIdx: number, G: number, t: number, v: number, tArr: number, held: boolean): Run {
    const leg = run.legs[gateIdx];
    const tOpen = gateOpenAt(this.net, leg.gate, tArr, this.timing());
    run.gateIdx = gateIdx; run.xGate = G; run.tArrive = tArr;
    const s = leg.gateS, visit = b.visit + gateIdx;
    if (tOpen <= t + 1e-9 && !held) {
      run.tEnd = t;
      run.next = { leg, s, visit, waiting: false, waited: 0, v, t };
    } else {
      run.segs.push({ kind: SegKind.Hold, t0: t, dur: Math.max(0, tOpen - t), x0: G, v0: 0, a: 0, G: 0 });
      run.tEnd = Math.max(t, tOpen);
      run.next = { leg, s, visit, waiting: false, waited: 0, v: 0, t: run.tEnd };
    }
    if (!run.segs.length) run.segs.push({ kind: SegKind.Const, t0: t, dur: 0, x0: G, v0: v, a: 0, G: 0 });
    return run;
  }
}

const LP = { x: 0, z: 0, hx: 1, hz: 0, seg: 0 };
