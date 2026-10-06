// ── World generation — ROUTED traffic (cars + walkers over the intersection graph) ──────────────
// Cars used to drive the 24 longest straight runs and loop, SHRINKING to a dot over the first/last 4% of every run
// (runs also split at terrace steps, so they shrank mid-street); walkers ping-ponged and flipped 180° on the spot.
// Here both route over the real road graph: at every junction a car goes straight / left / right and follows its lane
// through the turn on a smooth curve; a walker keeps to its pavement, turns the corner on its own side, or crosses
// on the zebra — waiting for the green man at signalled junctions (the crowds at the crossings). Cars stop at the stop
// line on red and at T-junction stop signs. Nothing shrinks: a car only fades out at a genuine dead end (the map
// border) and fades back in at another border entry.
//
// PURE + deterministic (hash-driven choices, no RNG state): the WorldTraffic ticker owns meshes, the car-yield scan
// and the per-frame transforms; this module owns the routes. The unit tests step agents here without a renderer.

import type { WorldGraph, V2 } from './types';
import { hash2, pointInPolygon } from './util';
import { cellLevelAt, inRamp } from './elevation';
import { inShotengai } from './shotengai';
import { streetPlan, streetPlanData, adoptStreetPlan, type StreetPlan, type StreetPlanData } from './street-slots';
import { signalledJunctions, signalState, DEFAULT_SIGNAL_TIMING, type SignalTiming } from './signals';
import { streetDims } from './street-layout';
import { bridgeDecks, deckAt } from './bridge-deck';

// HANDEDNESS: for a travel direction d, R(d) = (−d.z, d.x) is the DRIVER'S RIGHT in this right-handed y-up world
// (forward × up). Japan drives on the LEFT, so a car's lane centre is at −R(d)·lane and its kerb is on its left.
// (The pre-2026-09-29 runs used +R — right-hand traffic, contradicting their own comment and the road paint's stop bars.)

/** Where a car's front bumper stops on red: from the junction centre, just behind the zebra (the shared street
 *  cross-section — roadpaint's stop bar sits 2.2 m further out). Returned as the distance beyond the kerb corner. */
export function stopBack(graph: { params: WorldGraph['params'] }): number {
    const D = streetDims(graph.params);
    return D.cwStart + D.cwDepth + 0.04 * D.s - D.half;
}

export interface RNode {
    pos: V2;
    out: number[];            // directed edges leaving this node
    arms: V2[];               // unit directions of EVERY road arm here (incl. impassable ones — a zebra still crosses them)
    signal: { bucket: number; axis0: V2 } | null;
    /** T-junction: the stem arm (traffic arriving FROM the stem must stop). */
    stem: V2 | null;
}
export interface REdge {
    id: number; ri: number; from: number; to: number; rev: number;
    a: V2; b: V2; d: V2; len: number;
    forward: boolean;         // travels road.a → road.b
    car: boolean; walk: boolean; arterial: boolean;
}
export interface RoadNet {
    s: number; half: number; lane: number;
    /** Stop-line setback beyond the kerb corner (see stopBack) and the zebra centre's distance from the node. */
    stopBack: number; zebra: number;
    nodes: RNode[]; edges: REdge[];
    carEdges: number[]; walkEdges: number[];
    /** Car edges that START at a dead end (border entries) — where faded-out cars re-enter. */
    entries: number[];
    plan: StreetPlan;
    /** Ground a walker can stand on: dry land, or a bridge deck over a canal (never the trench / water beside it). */
    dry: (x: number, z: number) => boolean;
}

const netCache = new WeakMap<WorldGraph, { net: RoadNet; lights: boolean }>();
/** The routing network for a graph (memoized per graph object — rebuilt if `trafficLights` was toggled on it, since
 *  a selective regen keeps the graph but changes which junctions are signalled). */
export function roadNet(graph: WorldGraph): RoadNet {
    const lights = !!graph.params.trafficLights;
    let n = netCache.get(graph);
    if (!n || n.lights !== lights) { n = { net: buildNet(graph), lights }; netCache.set(graph, n); }
    return n.net;
}

const L = (d: V2): V2 => [-d[1], d[0]];
const dot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];

/** The routing network's PLAIN DATA (structured-cloneable — no `dry` closure, the plan as StreetPlanData). The worker
 *  centre build ships it with the traffic precompute (performance-plan P5.W4); `adoptRoadNet` rebuilds the net. */
export type RoadNetData = Omit<RoadNet, 'plan' | 'dry'> & { plan: StreetPlanData };
/** The plain data of a net built by `roadNet`. */
export function roadNetData(net: RoadNet): RoadNetData {
    const { plan, dry: _dry, ...rest } = net;
    return { ...rest, plan: streetPlanData(plan) };
}
/** Seed `graph`'s net (+ street plan) caches from shipped data of the SAME graph content — what `roadNet(graph)`
 *  would build, without the ~50 ms rebuild on the main thread. */
export function adoptRoadNet(graph: WorldGraph, data: RoadNetData): RoadNet {
    const plan = adoptStreetPlan(graph, data.plan);
    const net: RoadNet = { ...data, plan, dry: makeDry(graph) };
    netCache.set(graph, { net, lights: !!graph.params.trafficLights });
    return net;
}

/** ON a bridge deck = inside its span and between its parapets (bridge-deck.ts), not merely inside the layout quad. */
function makeOnBridge(graph: WorldGraph): (x: number, z: number) => boolean {
    const decks = bridgeDecks(graph);
    return (x, z) => !!deckAt(decks, x, z);
}
/** Ground a walker can stand on: dry land, or a bridge deck over a canal. */
function makeDry(graph: WorldGraph, onBridge = makeOnBridge(graph)): (x: number, z: number) => boolean {
    return (x, z) => cellLevelAt(graph, x, z) >= 0 || onBridge(x, z);
}

function buildNet(graph: WorldGraph): RoadNet {
    const p = graph.params, s = p.radius / 10, half = p.streetWidth * 0.5;
    const plan = streetPlan(graph);
    const border = graph.border;
    const onBridge = makeOnBridge(graph);
    const dry = makeDry(graph, onBridge);
    const inBorder = (x: number, z: number): boolean => border.length < 3 || pointInPolygon([x, z], border);
    // Passable = every sample on land (or a bridge deck) inside the border, and no terrace STEP along it unless a ramp
    // carries the carriageway over it (a car would drive off the retaining-wall cliff; a walker would walk through it).
    const passable = (a: V2, b: V2, cars: boolean): boolean => {
        const N = 14;
        let lvl: number | null = null;
        for (let i = 0; i <= N; i++) {
            const t = i / N, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
            const br = onBridge(x, z);
            if (!br && (cellLevelAt(graph, x, z) < 0 || !inBorder(x, z))) return false;
            if (cars && inShotengai(graph, x, z)) return false;
            if (br || inRamp(graph.ramps, x, z)) continue;
            const l = cellLevelAt(graph, x, z);
            if (lvl === null) lvl = l; else if (l !== lvl) return false;
        }
        return true;
    };

    const nodes: RNode[] = [];
    const nodeIdx = new Map<string, number>();
    const key = (v: V2): string => Math.round(v[0] * 1000) + ',' + Math.round(v[1] * 1000);
    const nodeOf = (v: V2): number => {
        const k = key(v); let i = nodeIdx.get(k);
        if (i === undefined) { i = nodes.length; nodes.push({ pos: [v[0], v[1]], out: [], arms: [], signal: null, stem: null }); nodeIdx.set(k, i); }
        return i;
    };
    const addArm = (n: number, d: V2): void => { const A = nodes[n].arms; if (!A.some(e => dot(e, d) > 0.985)) A.push(d); };
    const edges: REdge[] = [];
    graph.roads.forEach((r, ri) => {
        if (r.klass === 'alley') return;
        const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], len = Math.hypot(dx, dz);
        if (len < 1e-3) return;
        const d: V2 = [dx / len, dz / len];
        const na = nodeOf(r.a), nb = nodeOf(r.b);
        addArm(na, d); addArm(nb, [-d[0], -d[1]]);
        const car = (r.klass === 'arterial' || r.klass === 'street' || r.klass === 'ring') && passable(r.a, r.b, true);
        const walk = passable(r.a, r.b, false);
        if (!car && !walk) return;
        const e0 = edges.length;
        edges.push({ id: e0, ri, from: na, to: nb, rev: e0 + 1, a: r.a, b: r.b, d, len, forward: true, car, walk, arterial: r.klass === 'arterial' });
        edges.push({ id: e0 + 1, ri, from: nb, to: na, rev: e0, a: r.b, b: r.a, d: [-d[0], -d[1]], len, forward: false, car, walk, arterial: r.klass === 'arterial' });
        nodes[na].out.push(e0); nodes[nb].out.push(e0 + 1);
    });
    for (const j of signalledJunctions(graph)) {
        const i = nodeIdx.get(key(j.pos));
        if (i !== undefined) nodes[i].signal = { bucket: j.bucket, axis0: j.axis0 };
    }
    for (const it of graph.intersections) {
        if (it.type !== 'tee') continue;
        const i = nodeIdx.get(key(it.pos)); if (i === undefined) continue;
        const stem = it.arms.find(a => !it.arms.some(b => Math.abs(b[0] + a[0]) < 1e-6 && Math.abs(b[1] + a[1]) < 1e-6));
        if (stem) { const l = Math.hypot(stem[0], stem[1]) || 1; nodes[i].stem = [stem[0] / l, stem[1] / l]; }
    }
    const carEdges = edges.filter(e => e.car).map(e => e.id), walkEdges = edges.filter(e => e.walk).map(e => e.id);
    const carOut = (n: number): number[] => nodes[n].out.filter(e => edges[e].car);
    const entries = carEdges.filter(e => carOut(edges[e].from).length === 1);
    const D = streetDims(p);
    return { s, half, lane: p.streetWidth * 0.22, stopBack: stopBack(graph), zebra: D.cwStart + D.cwDepth * 0.5, nodes, edges, carEdges, walkEdges, entries, plan, dry };
}

// ── Legs (polyline segments an agent follows) ────────────────────────────────────────────────────
export interface Leg {
    pts: V2[]; cum: number[]; total: number;
    edge: number;
    /** Leg distance where the straight run along `edge` begins (after any junction curve / crossing). */
    sStart: number;
    /** Car stop point (the car CENTRE for a 0-length car — the ticker subtracts the half-length); −1 = no stop. */
    stopS: number;
    stopKind: 'signal' | 'sign' | null;
    /** Walkers: a crossing that must wait for a green (or a delay) — held at leg distance `gateS` (the kerb end of
     *  the zebra; 0 = the leg start). */
    gate: { node: number; axis: 0 | 1; minGreen: number } | { delay: number } | null;
    gateS: number;
    /** Walkers: pavement side (+1 = left of travel) on `edge`. */
    side: 1 | -1;
}

function mkLeg(pts: V2[], edge: number, sStartIdx: number, side: 1 | -1): Leg {
    const clean: V2[] = [];
    for (const q of pts) { const last = clean[clean.length - 1]; if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) clean.push(q); }
    if (clean.length < 2) clean.push([clean[0][0] + 1e-5, clean[0][1]]);
    const cum = [0];
    for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]));
    // sStart = the distance of the point that was pts[sStartIdx] (clean may have dropped duplicates before it).
    let sStart = 0;
    { const target = pts[Math.min(sStartIdx, pts.length - 1)]; let best = Infinity; for (let i = 0; i < clean.length; i++) { const dd = Math.hypot(clean[i][0] - target[0], clean[i][1] - target[1]); if (dd < best) { best = dd; sStart = cum[i]; } } }
    return { pts: clean, cum, total: Math.max(1e-6, cum[cum.length - 1]), edge, sStart, stopS: -1, stopKind: null, gate: null, gateS: 0, side };
}

/** Position + unit heading on a leg at distance `s` (clamped). */
export function legPoint(leg: Leg, s: number, out: { x: number; z: number; hx: number; hz: number; seg: number }): void {
    const d = Math.max(0, Math.min(leg.total, s));
    let i = 0; while (i < leg.cum.length - 2 && leg.cum[i + 1] < d) i++;
    const a = leg.pts[i], b = leg.pts[i + 1], sl = Math.max(1e-9, leg.cum[i + 1] - leg.cum[i]), t = (d - leg.cum[i]) / sl;
    out.x = a[0] + (b[0] - a[0]) * t; out.z = a[1] + (b[1] - a[1]) * t;
    out.hx = (b[0] - a[0]) / sl; out.hz = (b[1] - a[1]) / sl; out.seg = i;
}

/** Closest point of a leg's polyline to (x, z): its leg distance `s` and the lateral distance `lat` to it. The car
 *  ticker places an obstacle (the Play player) in a car's lane corridor with it. Allocation-free. */
export function legProject(leg: Leg, x: number, z: number, out: { s: number; lat: number }): void {
    let best = Infinity, bs = 0;
    for (let i = 0; i < leg.pts.length - 1; i++) {
        const a = leg.pts[i], b = leg.pts[i + 1], sl = leg.cum[i + 1] - leg.cum[i];
        if (sl <= 1e-9) continue;
        const ux = (b[0] - a[0]) / sl, uz = (b[1] - a[1]) / sl;
        const t = Math.max(0, Math.min(sl, (x - a[0]) * ux + (z - a[1]) * uz));
        const d = Math.hypot(x - a[0] - ux * t, z - a[1] - uz * t);
        if (d < best) { best = d; bs = leg.cum[i] + t; }
    }
    out.s = bs; out.lat = best;
}

/** Junction mouth for a vehicle at a node: the kerb corner, or nothing at a straight pass-through / dead end. */
function carMouth(net: RoadNet, n: number): number {
    const A = net.nodes[n].arms;
    if (A.length === 2 && dot(A[0], A[1]) < -0.985) return 0;
    if (A.length <= 1) return 0.02 * net.s;
    return net.half;
}

/** Quadratic-Bezier lane curve from `p0` (heading d0) to `p1` (heading d1): the lanes' intersection is the control. */
function laneCurve(p0: V2, d0: V2, p1: V2, d1: V2, n: number): V2[] {
    const den = d0[0] * d1[1] - d0[1] * d1[0];
    if (Math.abs(den) < 0.08) return [p0, p1];   // (near) straight through
    const wx = p1[0] - p0[0], wz = p1[1] - p0[1];
    const t = (wx * d1[1] - wz * d1[0]) / den;
    const c: V2 = [p0[0] + d0[0] * t, p0[1] + d0[1] * t];
    const out: V2[] = [];
    for (let i = 0; i <= n; i++) {
        const u = i / n, a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, cc = u * u;
        out.push([a * p0[0] + b * c[0] + cc * p1[0], a * p0[1] + b * c[1] + cc * p1[1]]);
    }
    return out;
}

/** A car's leg onto `edge`: the curve through the junction from where `prev` ended (if any), then the lane down the
 *  edge to the far mouth. Stop line on red (signalled far node) or at a T-junction stop sign (arriving from the stem). */
export function carLeg(net: RoadNet, edge: number, prev: number | null): Leg {
    const e = net.edges[edge], lane = -net.lane, lf = L(e.d);   // −R(d)·lane = the LEFT lane
    const m0 = carMouth(net, e.from), m1 = carMouth(net, e.to);
    const S: V2 = [e.a[0] + e.d[0] * m0 + lf[0] * lane, e.a[1] + e.d[1] * m0 + lf[1] * lane];
    const E: V2 = [e.b[0] - e.d[0] * m1 + lf[0] * lane, e.b[1] - e.d[1] * m1 + lf[1] * lane];
    let pts: V2[] = [S, E], sIdx = 0;
    if (prev !== null) {
        const pe = net.edges[prev], pl = L(pe.d), pm = carMouth(net, pe.to);   // (lane is already negated: left lane)
        const P0: V2 = [pe.b[0] - pe.d[0] * pm + pl[0] * lane, pe.b[1] - pe.d[1] * pm + pl[1] * lane];
        const curve = laneCurve(P0, pe.d, S, e.d, 6);
        pts = [...curve, E]; sIdx = curve.length - 1;
    }
    const leg = mkLeg(pts, edge, sIdx, 1);
    const to = net.nodes[e.to];
    if (to.signal) { leg.stopS = Math.max(leg.sStart, leg.total - net.stopBack); leg.stopKind = 'signal'; }
    else if (to.stem && dot(to.stem, e.d) < -0.95) { leg.stopS = Math.max(leg.sStart, leg.total - 0.06 * net.s); leg.stopKind = 'sign'; }
    return leg;
}

/** Straight / left / right at the far node of `edge` (weighted 3 : 1 : 1; buses prefer arterials). null = dead end. */
export function carNext(net: RoadNet, edge: number, id: number, visit: number, preferArterial = false): number | null {
    const e = net.edges[edge];
    const opts = net.nodes[e.to].out.filter(o => net.edges[o].car && o !== e.rev);
    if (!opts.length) return null;
    let tot = 0;
    const w = opts.map(o => {
        const c = dot(net.edges[o].d, e.d);
        let wt = c > 0.9 ? 3 : c > -0.5 ? 1 : 0.2;
        if (preferArterial && net.edges[o].arterial) wt *= 4;
        tot += wt; return wt;
    });
    let r = hash2(id, visit, 0x7a11c) * tot;
    for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) return opts[i]; }
    return opts[opts.length - 1];
}

/** Walking offset from the road centreline on one pavement of `edge` (+ bulges around wide kerb / frontage items). */
function walkProfile(net: RoadNet, edge: number, side: 1 | -1): { along: number; off: number }[] {
    const e = net.edges[edge], planSide: 1 | -1 = (e.forward ? side : -side) as 1 | -1;
    const S = net.plan.side(e.ri, planSide);
    const w = S ? S.walkC : net.half + 0.06 * net.s;
    const prof: { along: number; off: number }[] = [];
    if (S) {
        const ramp = 0.03 * net.s;
        for (const sl of net.plan.onSide(e.ri, planSide)) {
            const wide = sl.kind === 'bikerow' || sl.kind === 'busstop' || sl.kind === 'bench' || sl.kind === 'stall' || sl.kind === 'vending';
            if (!wide) continue;
            const off = sl.band === 'kerb' ? Math.max(w, (S.kerbOut + S.frontIn) * 0.5 + 0.004 * net.s) : Math.min(w, S.frontIn - 0.02 * net.s);
            if (Math.abs(off - w) < 1e-6) continue;
            const a0 = e.forward ? sl.along - sl.half : e.len - (sl.along + sl.half), a1 = a0 + sl.half * 2;
            prof.push({ along: a0 - ramp, off: w }, { along: a0, off }, { along: a1, off }, { along: a1 + ramp, off: w });
        }
        prof.sort((a, b) => a.along - b.along);
    }
    return [{ along: -Infinity, off: w }, ...prof, { along: Infinity, off: w }];
}
const walkOff = (net: RoadNet, edge: number, side: 1 | -1): number => walkProfile(net, edge, side)[0].off;

/** Where a pavement corner sits along `edge` from a node: the cross street's walking line at a junction, a short
 *  turn-around at a dead end, nothing at a straight pass-through. */
function cornerAlong(net: RoadNet, n: number, w: number): number {
    const A = net.nodes[n].arms;
    if (A.length === 2 && dot(A[0], A[1]) < -0.985) return 0;
    if (A.length <= 1) return 0.04 * net.s;
    return w;
}

/** A walker's leg down `edge` on pavement `side`, prefixed by `prefix` (a zebra crossing / corner) — from the start
 *  corner to the far corner, bending around wide kerb/frontage items. */
export function walkLeg(net: RoadNet, edge: number, side: 1 | -1, prefix: V2[] = []): Leg {
    const e = net.edges[edge], lf = L(e.d);
    const prof = walkProfile(net, edge, side), w = prof[0].off;
    const c0 = cornerAlong(net, e.from, w), c1 = e.len - cornerAlong(net, e.to, w);
    const P = (al: number, off: number): V2 => [e.a[0] + e.d[0] * al + lf[0] * side * off, e.a[1] + e.d[1] * al + lf[1] * side * off];
    const body: V2[] = [P(c0, w)];
    for (const q of prof) if (q.along > c0 && q.along < c1) body.push(P(q.along, q.off));
    body.push(P(c1, w));
    return mkLeg([...prefix, ...body], edge, prefix.length, side);
}

/** At the far corner of a walker's leg: straight on (crossing the side street if there is one), turn the corner on
 *  this side, cross this street and turn / come back, or (dead end) turn round. Returns the next leg + its gate. */
export function walkNext(net: RoadNet, leg: Leg, id: number, visit: number, crossSpeed: number): Leg {
    const e = net.edges[leg.edge], side = leg.side, T = net.nodes[e.to], lf = L(e.d);
    const w = walkOff(net, leg.edge, side);
    const here = leg.pts[leg.pts.length - 1];
    const opts: { edge: number; side: 1 | -1; wt: number; cross: 'none' | 'side' | 'own'; via: V2[] }[] = [];
    const armOnMySide = T.arms.some(a => dot(a, [lf[0] * side, lf[1] * side]) > 0.9);
    // The ZEBRAS sit set back from the junction (street-layout crossings: cwStart … cwStart+cwDepth along each arm).
    // Crossing our OWN street: walk back along our pavement to its zebra, cross, return to the corner opposite.
    // Crossing the SIDE street: walk out along its pavement to its zebra, cross, come back to our line. The walker
    // waits at the kerb end of the zebra (`gateS`), not at the corner.
    const zc = Math.max(net.zebra, w);
    const ownZebra = (from: V2): V2[] => {
        const a0: V2 = [T.pos[0] - e.d[0] * zc + lf[0] * side * w, T.pos[1] - e.d[1] * zc + lf[1] * side * w];
        const a1: V2 = [T.pos[0] - e.d[0] * zc - lf[0] * side * w, T.pos[1] - e.d[1] * zc - lf[1] * side * w];
        const back: V2 = [from[0] - lf[0] * side * 2 * w, from[1] - lf[1] * side * 2 * w];
        return [from, a0, a1, back];
    };
    const sideZebra = (from: V2, land: V2): V2[] => {
        const s0: V2 = [from[0] + lf[0] * side * (zc - w), from[1] + lf[1] * side * (zc - w)];
        const s1: V2 = [land[0] + lf[0] * side * (zc - w), land[1] + lf[1] * side * (zc - w)];
        return [from, s0, s1, land];
    };
    for (const o of T.out) {
        const oe = net.edges[o];
        if (!oe.walk) continue;
        const c = dot(oe.d, e.d), sideness = dot(oe.d, [lf[0] * side, lf[1] * side]);
        if (o === e.rev) {   // back the way we came, on the OTHER pavement: cross our own street at the zebra
            const via = ownZebra(here);
            if (via.every(q => net.dry(q[0], q[1]))) opts.push({ edge: o, side, wt: 0.35, cross: 'own', via });
        } else if (c > 0.9) {
            // Straight on: across the side street's zebra if it's on our side (else the pavement just continues).
            // ★ E12/S13: not when that side street is sunk in a canal trench (a bridged junction) — its "zebra" would
            // walk the pedestrian out over the water beside the deck. They stay on the deck and carry straight on.
            const w2 = walkOff(net, o, side);
            const land: V2 = [T.pos[0] + e.d[0] * cornerAlong(net, e.to, w2) + lf[0] * side * w2, T.pos[1] + e.d[1] * cornerAlong(net, e.to, w2) + lf[1] * side * w2];
            const zeb = armOnMySide ? sideZebra(here, land) : null;
            const zebOk = !!zeb && zeb.every(q => net.dry(q[0], q[1]));
            opts.push({ edge: o, side, wt: 3, cross: zebOk ? 'side' : 'none', via: zebOk ? zeb! : [here, land] });
        } else if (sideness > 0.9) {
            opts.push({ edge: o, side, wt: 2, cross: 'none', via: [here] });                          // round our own corner
        } else if (sideness < -0.9) {
            const via = ownZebra(here);                                                                    // cross, then turn
            if (via.every(q => net.dry(q[0], q[1]))) opts.push({ edge: o, side: (-side) as 1 | -1, wt: 1.1, cross: 'own', via });
        }
    }
    if (!opts.length || T.arms.length <= 1 || opts.every(o => o.edge === e.rev)) {
        // Dead end: turn round on the same pavement (eased heading + a beat's pause — no instant 180° flip).
        const nl = walkLeg(net, e.rev, (-side) as 1 | -1, [here]);
        nl.gate = { delay: 0.7 };
        return nl;
    }
    let tot = 0; for (const o of opts) tot += o.wt;
    let r = hash2(id, visit, 0x3a1f5) * tot, pick = opts[opts.length - 1];
    for (const o of opts) { r -= o.wt; if (r <= 0) { pick = o; break; } }
    const nl = walkLeg(net, pick.edge, pick.side, pick.via);
    if (pick.cross !== 'none' && pick.via.length >= 3) nl.gateS = Math.hypot(pick.via[1][0] - pick.via[0][0], pick.via[1][1] - pick.via[0][1]);
    if (pick.cross !== 'none') {
        // Crossing the side street = walking parallel to our travel → our axis; our own street = the perpendicular one.
        const dirWalk: V2 = pick.cross === 'side' ? e.d : lf;
        if (T.signal) {
            const axis: 0 | 1 = Math.abs(dot(dirWalk, T.signal.axis0)) > 0.7 ? 0 : 1;
            const len = pick.cross === 'side' ? 2 * w : 2 * w;
            nl.gate = { node: e.to, axis, minGreen: len / Math.max(1e-4, crossSpeed) + 0.6 };
        }
    } else if (pick.edge === e.rev) nl.gate = { delay: 0.7 };
    return nl;
}

/** Is a walker's gate open at sim time `time`? */
export function gateOpen(net: RoadNet, gate: Leg['gate'], waited: number, time: number, timing: SignalTiming = DEFAULT_SIGNAL_TIMING): boolean {
    if (!gate) return true;
    if ('delay' in gate) return waited >= gate.delay;
    const sig = net.nodes[gate.node].signal;
    if (!sig) return true;
    const st = signalState(time, sig.bucket, gate.axis, timing);
    return st.lamp === 'green' && st.remaining >= Math.min(gate.minGreen, timing.green * 0.8);
}

/** Car signal logic: should a car whose CENTRE is at leg distance `s` (half-length `hl`, speed `vel`, braking
 *  `brake` world-units/s²) hold at the stop line now? Returns the leg distance to hold at, −1 to proceed (green / past
 *  the line), or −2 = COMMITTED: amber (or a fresh red) caught it too close to stop — clear the junction. */
export function carHoldAt(net: RoadNet, leg: Leg, s: number, hl: number, vel: number, time: number, timing: SignalTiming = DEFAULT_SIGNAL_TIMING, brake = Infinity): number {
    if (leg.stopKind !== 'signal') return -1;
    const hold = leg.stopS - hl;
    if (s > hold + 0.002 * net.s) return -1;   // already past the line — clear the junction
    const e = net.edges[leg.edge], sig = net.nodes[e.to].signal!;
    const axis: 0 | 1 = Math.abs(dot(e.d, sig.axis0)) > 0.7 ? 0 : 1;
    const st = signalState(time, sig.bucket, axis, timing);
    if (st.lamp === 'green') return -1;
    const stopDist = brake === Infinity ? 0 : (vel * vel) / (2 * brake);
    if (st.lamp === 'yellow' && hold - s < Math.max(vel * 0.9, stopDist)) return -2;   // too close to stop — go on the amber
    if (hold - s < stopDist * 0.8) return -2;                                          // physically can't stop in time
    return hold;
}
