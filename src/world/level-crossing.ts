// ── World generation — LEVEL CROSSING (fumikiri) timing (railway-upgrade R3.2) ─────────────────────────────────────
// Pure + deterministic: when a crossing must close for a train (its DEMAND), and how the warning lamps and barrier
// arms follow that demand. The WorldTraffic ticker owns the state per crossing, the local-line builder owns the
// geometry (local-line-build.ts), the unit tests step both against train.ts stepTrainRun.
//
//   demand on  → the alternating red lamps start flashing at once (the bell would ring) → after `lampLead` seconds the
//                arms swing down over `lower` seconds → fully down before the train's front reaches the road.
//   demand off → (the train's rear has cleared the road + a margin) lamps stop, arms rise over `raise` seconds.
//
// Demand = the consist overlaps the crossing's zone (the street band measured along the track, + a margin), or its
// front is approaching and its ESTIMATED arrival (dwell left + time to cover the gap at its acceleration toward the
// cruise speed — never slower than reality, so the estimate errs early) is under `warn` seconds. A train that will
// stop at a station short of the crossing does not close it until it is about to leave that station. Reversing at a
// terminus counts the direction it will leave in.

import type { TrainRunPlan, TrainRunState } from './train';

export const XING_TIMING = {
    warn: 11,        // s — close when the front is this far (in time) from the road
    lampLead: 2.5,   // s — lamps flash alone before the arms start down
    lower: 4.0,      // s — arm travel down
    raise: 4.0,      // s — arm travel up
} as const;

/** One crossing's live state. `arm` 0 = up (open) … 1 = down (closed). */
export interface CrossingState { demand: boolean; since: number; arm: number; lamps: boolean }
export function crossingStart(): CrossingState { return { demand: false, since: 0, arm: 0, lamps: false }; }

/** Is the crossing closed to road users (lamps flashing or an arm not fully up)? */
export function crossingClosed(cs: CrossingState): boolean { return cs.lamps || cs.arm > 0.02; }

/** Time (s) to cover `d` from speed `v0`, accelerating at `a` toward `vmax` (no braking — an early estimate). */
export function travelTime(d: number, v0: number, a: number, vmax: number): number {
    if (d <= 0) return 0;
    const v = Math.max(0, Math.min(vmax, v0));
    if (a <= 0) return v > 1e-9 ? d / v : Infinity;
    const dAcc = (vmax * vmax - v * v) / (2 * a);
    if (d <= dAcc) return (-v + Math.sqrt(v * v + 2 * a * d)) / a;
    return (vmax - v) / a + (d - dAcc) / vmax;
}

/** The next stop the consist CENTRE is heading for (a station, else the terminus) — stepTrainRun's own rule. */
function nextTarget(st: TrainRunState, plan: TrainRunPlan, dir: 1 | -1): { s: number; term: boolean } {
    if (dir > 0) { for (const x of plan.stops) if (x > st.s + 1e-7) return { s: x, term: false }; return { s: plan.hi, term: true }; }
    for (let i = plan.stops.length - 1; i >= 0; i--) if (plan.stops[i] < st.s - 1e-7) return { s: plan.stops[i], term: false };
    return { s: plan.lo, term: true };
}

/** Does this consist (centre state `st` on `plan`, half-length `half`) need the crossing whose zone spans arc
 *  [zoneLo, zoneHi] closed now? `margin` pads the zone (units). */
export function trainDemand(st: TrainRunState, plan: TrainRunPlan, half: number, zoneLo: number, zoneHi: number, margin: number, warn: number = XING_TIMING.warn): boolean {
    const atHi = st.s >= plan.hi - 1e-6, atLo = st.s <= plan.lo + 1e-6;
    const dir: 1 | -1 = st.dwell > 0 && atHi ? -1 : st.dwell > 0 && atLo ? 1 : st.dir;
    const lo = st.s - half, hi = st.s + half;
    if (hi > zoneLo - margin && lo < zoneHi + margin) return true;                 // on (or just at) the crossing
    const front = st.s + dir * half;
    const gap = dir > 0 ? zoneLo - margin - front : front - (zoneHi + margin);
    if (gap < 0) return false;                                                       // it has passed
    const tgt = nextTarget(st, plan, dir);
    const frontAtTgt = tgt.s + dir * half;
    const stopsShort = dir > 0 ? frontAtTgt < zoneLo - margin : frontAtTgt > zoneHi + margin;
    // Moving toward a stop short of the crossing: it will dwell there first (the dwell, not the gap, sets the time).
    if (stopsShort && Math.abs(tgt.s - st.s) > 1e-6) return false;
    const eta = st.dwell + travelTime(gap, st.dwell > 0 ? 0 : st.v, plan.accel, plan.cruise);
    return eta < warn;
}

/** Advance one crossing by `dt` for this frame's demand. */
export function stepCrossing(cs: CrossingState, demand: boolean, dt: number): void {
    if (demand !== cs.demand) { cs.demand = demand; cs.since = 0; }
    else cs.since += dt;
    cs.lamps = demand;
    const target = demand && cs.since >= XING_TIMING.lampLead ? 1 : demand ? cs.arm : 0;
    if (target > cs.arm) cs.arm = Math.min(target, cs.arm + dt / XING_TIMING.lower);
    else if (target < cs.arm) cs.arm = Math.max(target, cs.arm - dt / XING_TIMING.raise);
}

/** The lamp pair that is lit at `time` while flashing (0 = the 'a' lamps, 1 = 'b'): ~50 alternations a minute. */
export function lampPhase(time: number): 0 | 1 {
    return (Math.floor(time / 0.6) & 1) as 0 | 1;
}
