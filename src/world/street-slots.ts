// ── World generation — STREET SLOTS (the shared pavement plan) ──────────────────────────────────
// Every kerb-side family used to place itself with its own fixed offset and its own RNG: parked cars sat 2/3 on the
// footway, trees / static people / walkers / furniture landed on top of each other, and nothing checked whether a
// point was inside a shopfront. This module plans the pavement ONCE per graph, so biome (trees), furniture and
// pedestrians — three composers that run separately, possibly in workers — all see the SAME reservation.
//
//   carriageway │ KERB band            │ WALK band │ FRONTAGE band        │ building line
//   parked cars │ trees, poles, lamps, │ walkers,  │ vending runs, bins,  │ (measured per side from the
//   (road band) │ benches, bike racks  │ strollers │ A-boards, crates     │  real lot polygons)
//
// PURE + deterministic (position/index hashes only, no running RNG) and INDEPENDENT of the region filter and of the
// family toggles (streetTrees / parkedCars / …): toggling one family never moves another, and a region-filtered
// rebuild is a subset of the full one. Composers apply `keep` + their own toggle when EMITTING.
//
// Built from the layout alone (roads + lots + intersections). It must NOT read anything a later composer stamps
// (`lot.door`, `lot.variety`, `builtH`) — biome runs before streets, so the plan would differ between composers.

import type { WorldGraph, V2, Zone, RoadClass } from './types';
import { hash2, pointInPolygon, bounds } from './util';
import { cellLevelAt } from './elevation';
import { inShotengai } from './shotengai';
import { streetDims } from './street-layout';
import { railReservations, railLayout, METRO_HALF_LEN_M, METRO_HALF_W_M } from './rail-layout';
import { cityMetresPerUnit } from './types';
import { inLocalCorridor, crossingSin, LOCAL_M } from './local-line';

/** EXTRA pavement lift on top of the terrain field, in world units per `s`. The 15 cm kerb itself is already in
 *  makeElevation (street-layout's pavement index lifts every draped / baked point on a pavement), so this stays 0 —
 *  it exists so a future offset has ONE place to live instead of each composer. */
export const PAVEMENT_LIFT = 0;   // ★ keep 0: makeElevation (the drape + lift every composer uses) now includes the kerb (street-layout.ts pavementIndex().lift)
export function pavementLift(params: { radius: number }): number { return PAVEMENT_LIFT * (params.radius / 10); }

/** Street-bench seat height (m) — furniture builds the bench to it, the static crowd sits people on it. */
export const BENCH_SEAT_M = 0.42;

export type Band = 'kerb' | 'walk' | 'front' | 'road';
export type SlotKind =
    | 'lamp' | 'pole' | 'busstop' | 'entrance' | 'driveway' | 'tree' | 'planter' | 'potted' | 'bench'
    | 'bikerow' | 'parked' | 'vending' | 'bin' | 'aboard' | 'crate' | 'stall' | 'roadworks' | 'postbox' | 'cabinet'
    | 'nobori' | 'bikewall' | 'metro';

/** One reserved thing on the pavement. `along` = distance from road.a; `off` = distance from the centreline to the
 *  item's centre (always positive; `side` says which side). `half` = half-length along the road. */
export interface Slot {
    kind: SlotKind; ri: number; side: 1 | -1; band: Band;
    along: number; half: number; off: number;
    x: number; z: number;
    /** A free per-slot hash (0..1) for variety (car type, colour, crate count…). */
    h: number;
    /** Kind-specific integer (vehicle type index, vending machine count, clutter variant…). */
    n: number;
    zone: Zone | null;
}

/** Pavement geometry for one side of one road (offsets from the centreline, world units). */
export interface StreetSide {
    side: 1 | -1;
    frontage: number;      // the building line (lot edge); = kerb + default depth where no lot fronts
    hasLots: boolean;      // built lots front this side
    zone: Zone | null;     // dominant fronting zone
    kerbIn: number; kerbOut: number; kerbC: number;
    frontIn: number; frontOut: number; frontC: number;
    walkC: number;
}

export interface StreetRoad {
    ri: number; klass: RoadClass;
    a: V2; b: V2; d: V2; pp: V2; len: number;
    /** Along-distance excluded at each end (junction mouth + zebra); 0 at a straight pass-through node. */
    mouthA: number; mouthB: number;
    /** Number of distinct arms at each end node (1 = dead end, 2 = pass-through/corner, 3 = tee, 4 = cross). */
    armsA: number; armsB: number;
    sides: { [k: string]: StreetSide };
}

export interface StreetPlan {
    s: number; half: number;
    roads: (StreetRoad | null)[];
    slots: Slot[];
    of(kind: SlotKind): Slot[];
    side(ri: number, side: 1 | -1): StreetSide | null;
    /** True when [along−halfLen, along+halfLen] on (ri, side, band) is unclaimed. */
    free(ri: number, side: 1 | -1, band: Band, along: number, halfLen: number): boolean;
    /** Every slot on one road side (sorted by along) — the obstacles a walker's lane bends around. */
    onSide(ri: number, side: 1 | -1): Slot[];
    /** Layout point at (along, off) on a road side. */
    at(ri: number, side: 1 | -1, along: number, off: number): V2;
    /** The building line at one along-position (null when nothing is built there) — for props that stand against it. */
    frontageAt(ri: number, side: 1 | -1, along: number): number | null;
    /** Point-in-any-built-lot (the "never inside a shopfront" guard every composer shares). */
    inBuilding(x: number, z: number): boolean;
}

const BUILT: ReadonlySet<Zone> = new Set<Zone>(['residential', 'commercial', 'civic']);
const cache = new WeakMap<WorldGraph, StreetPlan>();

/** The pavement plan for a graph — built once per graph object (memoized), identical for every caller. */
export function streetPlan(graph: WorldGraph): StreetPlan {
    let pl = cache.get(graph);
    if (!pl) { pl = buildPlan(graph); cache.set(graph, pl); }
    return pl;
}

/** The plan's PLAIN DATA (structured-cloneable): everything `assemblePlan` needs to rebuild the same plan object —
 *  the per-road pavement geometry, the slots (in order) and the band claims. performance-plan P5.W4: the worker
 *  centre build ships it with the traffic precompute, so the main thread adopts the plan instead of rebuilding it. */
export interface StreetPlanData {
    s: number; half: number;
    roads: (StreetRoad | null)[];
    slots: Slot[];
    claims: [string, [number, number][]][];
}
const planData = new WeakMap<StreetPlan, StreetPlanData>();
/** The plain data of a plan built (or adopted) by this module. */
export function streetPlanData(plan: StreetPlan): StreetPlanData {
    const d = planData.get(plan);
    if (!d) throw new Error('streetPlanData: not a street-slots plan');
    return d;
}
/** Seed `graph`'s plan cache from shipped data (a structured clone of `streetPlanData` of the SAME graph content) —
 *  the result answers every query exactly like `buildPlan(graph)` would. The lot index (frontageAt / inBuilding) is
 *  rebuilt lazily from the graph on first use. */
export function adoptStreetPlan(graph: WorldGraph, data: StreetPlanData): StreetPlan {
    const pl = assemblePlan(graph, data, null);
    cache.set(graph, pl);
    return pl;
}

/** Built-lot spatial grid (the frontage probes + the inBuilding guard). */
function makeLotIndex(graph: WorldGraph) {
    const p = graph.params, s = p.radius / 10, half = p.streetWidth * 0.5;
    const lots = graph.lots.filter(l => BUILT.has(l.zone) && l.poly.length >= 3).map(l => ({ lot: l, b: bounds(l.poly) }));
    const G = Math.max(0.25 * s, 0.05);
    const grid = new Map<number, number[]>();
    const gk = (ix: number, iz: number): number => ix * 73856093 ^ iz * 19349663;
    lots.forEach((L, i) => {
        for (let ix = Math.floor(L.b.min[0] / G); ix <= Math.floor(L.b.max[0] / G); ix++)
            for (let iz = Math.floor(L.b.min[1] / G); iz <= Math.floor(L.b.max[1] / G); iz++) {
                const k = gk(ix, iz), arr = grid.get(k);
                if (arr) arr.push(i); else grid.set(k, [i]);
            }
    });
    const lotAt = (x: number, z: number): number => {
        const arr = grid.get(gk(Math.floor(x / G), Math.floor(z / G)));
        if (!arr) return -1;
        for (const i of arr) {
            const b = lots[i].b;
            if (x < b.min[0] || x > b.max[0] || z < b.min[1] || z > b.max[1]) continue;
            if (pointInPolygon([x, z], lots[i].lot.poly)) return i;
        }
        return -1;
    };
    const inBuilding = (x: number, z: number): boolean => lotAt(x, z) >= 0;
    const probeMax = 0.45 * s + 0.3 * p.streetWidth;
    const probeStep = Math.max(0.004 * s, probeMax / 90);
    const frontProbe = (a: V2, d: V2, pp: V2, side: number, along: number): { off: number; zone: Zone } | null => {
        const bx = a[0] + d[0] * along, bz = a[1] + d[1] * along;
        for (let o = half * 0.98; o <= half + probeMax; o += probeStep) {
            const i = lotAt(bx + pp[0] * side * o, bz + pp[1] * side * o);
            if (i >= 0) return { off: o, zone: lots[i].lot.zone };
        }
        return null;
    };
    return { lots, lotAt, inBuilding, probeMax, frontProbe };
}
type LotIndex = ReturnType<typeof makeLotIndex>;

/** The plan object over its data (shared by buildPlan and adoptStreetPlan → both answer identically). */
function assemblePlan(graph: WorldGraph, data: StreetPlanData, idx0: LotIndex | null): StreetPlan {
    const { s, half, roads, slots } = data;
    let idx = idx0;
    const lotIdx = (): LotIndex => (idx ??= makeLotIndex(graph));
    const claims = new Map(data.claims);
    const free = (ri: number, side: 1 | -1, band: Band, along: number, hl: number): boolean => {
        const arr = claims.get(ri + '|' + side + '|' + band);
        if (!arr) return true;
        const lo = along - hl, hi = along + hl;
        for (const iv of arr) if (lo < iv[1] && hi > iv[0]) return false;
        return true;
    };
    const at = (ri: number, side: 1 | -1, along: number, off: number): V2 => {
        const R = roads[ri]!;
        return [R.a[0] + R.d[0] * along + R.pp[0] * side * off, R.a[1] + R.d[1] * along + R.pp[1] * side * off];
    };
    const byKind = new Map<SlotKind, Slot[]>();
    for (const sl of slots) { const arr = byKind.get(sl.kind); if (arr) arr.push(sl); else byKind.set(sl.kind, [sl]); }
    const bySide = new Map<string, Slot[]>();
    for (const sl of slots) { const k = sl.ri + '|' + sl.side, arr = bySide.get(k); if (arr) arr.push(sl); else bySide.set(k, [sl]); }
    for (const arr of bySide.values()) arr.sort((x, y) => x.along - y.along);
    const plan: StreetPlan = {
        s, half, roads, slots,
        of: (kind) => byKind.get(kind) ?? [],
        side: (ri, side) => roads[ri]?.sides[side] ?? null,
        free,
        onSide: (ri, side) => bySide.get(ri + '|' + side) ?? [],
        at,
        frontageAt: (ri, side, along) => { const R = roads[ri]; if (!R) return null; const h = lotIdx().frontProbe(R.a, R.d, R.pp, side, along); return h ? h.off : null; },
        inBuilding: (x, z) => lotIdx().inBuilding(x, z),
    };
    planData.set(plan, data);
    return plan;
}

function buildPlan(graph: WorldGraph): StreetPlan {
    const p = graph.params, s = p.radius / 10, half = p.streetWidth * 0.5;
    const seed = p.seed >>> 0;
    const H = (a: number, b: number, salt: number): number => hash2(a, b, (seed ^ salt) >>> 0);

    // ── Built-lot spatial grid (the frontage probes + the inBuilding guard) ────────────────────────────────
    const lotIndex = makeLotIndex(graph);
    const { lots, inBuilding } = lotIndex;

    // Placement guard shared by all families: land (no canal/bridge deck), inside the border, not the shotengai mall.
    const border = graph.border;
    const okAt = (x: number, z: number): boolean =>
        cellLevelAt(graph, x, z) >= 0 && (border.length < 3 || pointInPolygon([x, z], border)) && !inShotengai(graph, x, z);

    // ── Node analysis: how many arms meet at each road end (junction mouths vs straight pass-throughs) ──
    const nodeKey = (v: V2): string => Math.round(v[0] * 1000) + ',' + Math.round(v[1] * 1000);
    const nodeDirs = new Map<string, V2[]>();
    const addDir = (k: string, d: V2): void => {
        const arr = nodeDirs.get(k) ?? [];
        if (!arr.some(e => e[0] * d[0] + e[1] * d[1] > 0.985)) arr.push(d);
        nodeDirs.set(k, arr);
    };
    for (const r of graph.roads) {
        if (r.klass === 'alley') continue;
        const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], L = Math.hypot(dx, dz);
        if (L < 1e-6) continue;
        addDir(nodeKey(r.a), [dx / L, dz / L]);
        addDir(nodeKey(r.b), [-dx / L, -dz / L]);
    }
    // Junction mouth: the kerb corner, the rounded corner and the set-back ZEBRA (street-layout's shared crossing
    // geometry) + a little standing room — nothing kerb-side lands on a crossing landing. Pass-throughs have none.
    const SD = streetDims(p);
    const zebraEnd = SD.cwStart + SD.cwDepth;
    const mouthFor = (dirs: V2[] | undefined): number => {
        const n = dirs?.length ?? 1;
        if (n === 1) return 0.05 * s;
        if (n === 2 && dirs && dirs[0][0] * dirs[1][0] + dirs[0][1] * dirs[1][1] < -0.985) return 0;
        return Math.max(half + 0.12 * s, zebraEnd + 0.02 * s);
    };

    // ── Per-road pavement geometry ─────────────────────────────────────────────────────────────────────
    const defDepth = Math.max(0.3 * p.streetWidth, 0.06 * s);   // lot inset where no lot fronts (parks/water)
    const { probeMax, frontProbe } = lotIndex;
    const roads: (StreetRoad | null)[] = graph.roads.map((r, ri) => {
        if (r.klass === 'alley') return null;
        const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], len = Math.hypot(dx, dz);
        if (len < 1e-3) return null;
        const d: V2 = [dx / len, dz / len], pp: V2 = [-d[1], d[0]];
        const dA = nodeDirs.get(nodeKey(r.a)), dB = nodeDirs.get(nodeKey(r.b));
        const sides: { [k: string]: StreetSide } = {};
        for (const side of [1, -1] as const) {
            const hits: { off: number; zone: Zone }[] = [];
            for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) { const h = frontProbe(r.a, d, pp, side, len * f); if (h) hits.push(h); }
            hits.sort((x, y) => x.off - y.off);
            const med = hits.length ? hits[hits.length >> 1] : null;
            const frontage = med ? med.off : half + defDepth;
            const D = Math.max(0.03 * s, frontage - half);
            const kd = Math.min(0.05 * s, 0.4 * D), fd = Math.min(0.05 * s, 0.4 * D);
            sides[side] = {
                side, frontage, hasLots: hits.length >= 2, zone: med ? med.zone : null,
                kerbIn: half, kerbOut: half + kd, kerbC: half + kd * 0.5,
                frontIn: frontage - fd, frontOut: frontage, frontC: frontage - fd * 0.5,
                walkC: (half + kd + frontage - fd) * 0.5,
            };
        }
        return { ri, klass: r.klass, a: r.a, b: r.b, d, pp, len, mouthA: mouthFor(dA), mouthB: mouthFor(dB),
            armsA: dA?.length ?? 1, armsB: dB?.length ?? 1, sides };
    });

    // ── Claims ─────────────────────────────────────────────────────────────────────────────────────────
    const claims = new Map<string, [number, number][]>();
    const ck = (ri: number, side: number, band: Band): string => ri + '|' + side + '|' + band;
    const free = (ri: number, side: 1 | -1, band: Band, along: number, hl: number): boolean => {
        const arr = claims.get(ck(ri, side, band));
        if (!arr) return true;
        const lo = along - hl, hi = along + hl;
        for (const iv of arr) if (lo < iv[1] && hi > iv[0]) return false;
        return true;
    };
    const claim = (ri: number, side: 1 | -1, band: Band, along: number, hl: number): void => {
        const k = ck(ri, side, band), arr = claims.get(k);
        if (arr) arr.push([along - hl, along + hl]); else claims.set(k, [[along - hl, along + hl]]);
    };
    const slots: Slot[] = [];
    const at = (ri: number, side: 1 | -1, along: number, off: number): V2 => {
        const R = roads[ri]!;
        return [R.a[0] + R.d[0] * along + R.pp[0] * side * off, R.a[1] + R.d[1] * along + R.pp[1] * side * off];
    };
    const put = (kind: SlotKind, R: StreetRoad, side: 1 | -1, band: Band, along: number, hl: number, off: number, h: number, n = 0, bands: Band[] = [band]): Slot => {
        const [x, z] = at(R.ri, side, along, off);
        const sl: Slot = { kind, ri: R.ri, side, band, along, half: hl, off, x, z, h, n, zone: R.sides[side].zone };
        slots.push(sl);
        for (const b of bands) claim(R.ri, side, b, along, hl);
        return sl;
    };
    // The usable along-range of a road (clear of both junction mouths) with an extra margin.
    const lo = (R: StreetRoad, m: number): number => R.mouthA + m;
    const hi = (R: StreetRoad, m: number): number => R.len - R.mouthB - m;
    const inRange = (R: StreetRoad, along: number, m: number): boolean => along >= lo(R, m) && along <= hi(R, m);
    // railway-upgrade R1.2 / R2.1: nothing on a viaduct pier column or a station stair / ticket hall; nothing TALL
    // (trees, utility poles) under the deck — see rail-layout.ts railReservations (empty when the railway is off).
    const rail = railReservations(graph);
    const local = graph.localLine ?? null;   // railway-upgrade R3.2: the at-grade local line's corridor
    const okSlot = (R: StreetRoad, side: 1 | -1, along: number, off: number): boolean => {
        const [x, z] = at(R.ri, side, along, off);
        return okAt(x, z) && !inBuilding(x, z) && !rail.solidAt(x, z) && !(local && inLocalCorridor(local, x, z, 0.3 * local.u));
    };
    const tallOk = (R: StreetRoad, side: 1 | -1, along: number, off: number): boolean => { const [x, z] = at(R.ri, side, along, off); return !rail.tallAt(x, z); };
    const live = roads.filter((R): R is StreetRoad => !!R);

    // 0) LEVEL CROSSINGS (railway-upgrade R3.2, the at-grade local line) — the crossing's whole stretch of road is
    //    kept clear on BOTH sides and in every band: the boards, the barrier machines + warning masts, the stop lines
    //    and the approach. First, so nothing parks on the tracks or plants a tree under a barrier arm.
    if (local) for (const q of local.crossings) {
        const R = roads[q.ri]; if (!R) continue;
        const sA = crossingSin(q), cosA = Math.sqrt(Math.max(0, 1 - sA * sA)), um = local.u;
        const al = (q.x - R.a[0]) * R.d[0] + (q.z - R.a[1]) * R.d[1];
        const hl = (LOCAL_M.barrier + LOCAL_M.stopLine + 1.0) * um / sA + q.band * cosA / sA;
        for (const side of [1, -1] as const) for (const b of ['kerb', 'walk', 'front', 'road'] as Band[]) claim(R.ri, side, b, al, hl);
    }
    // 1) LAMP POSTS — mirrored from streets.ts (arterials, 1.8·s spacing, the −pp side at half+0.02·s). Not emitted
    //    here (streets owns them); reserved so nothing else lands on a lamp.
    for (const R of live) {
        if (R.klass !== 'arterial') continue;
        const n = Math.max(1, Math.floor(R.len / (1.8 * s)));
        for (let i = 0; i < n; i++) { const al = R.len * (i + 0.5) / n; claim(R.ri, -1, 'kerb', al, 0.035 * s); }
    }
    // 2) UTILITY POLES — arterials on the +pp side (opposite the lamps), ordinary streets on a hashed side. Regular
    //    ~20 m spacing; consecutive poles on one road are strung together by furniture.
    for (const R of live) {
        if (R.klass !== 'arterial' && R.klass !== 'street') continue;
        const side: 1 | -1 = R.klass === 'arterial' ? 1 : (H(R.ri, 3, 0x70e5) < 0.5 ? 1 : -1);
        const sp = (R.klass === 'arterial' ? 1.25 : 1.4) * s;
        const a0 = lo(R, 0.02 * s), a1 = hi(R, 0.02 * s);
        if (a1 - a0 < 0.3 * s) continue;
        const n = Math.max(1, Math.round((a1 - a0) / sp));
        for (let i = 0; i <= n; i++) {
            const al = a0 + (a1 - a0) * i / n, off = R.sides[side].kerbC;
            if (!okSlot(R, side, al, off) || !tallOk(R, side, al, off) || !free(R.ri, side, 'kerb', al, 0.03 * s)) continue;
            put('pole', R, side, 'kerb', al, 0.03 * s, off, H(R.ri, 200 + i, 0x0c0f), i);
        }
    }
    // 3) BUS STOPS — some arterials; the shelter sits in the kerb band, the stop bay keeps parked cars off the kerb.
    for (const R of live) {
        if (R.klass !== 'arterial' || R.len < 1.2 * s || H(R.ri, 0, 0x88c1) >= 0.35) continue;
        const side: 1 | -1 = H(R.ri, 1, 0x2d5e) < 0.5 ? 1 : -1, al = R.len * 0.4, off = R.sides[side].kerbC;
        if (!inRange(R, al, 0.12 * s) || !okSlot(R, side, al, off) || !free(R.ri, side, 'kerb', al, 0.11 * s)) continue;
        put('busstop', R, side, 'kerb', al, 0.11 * s, off, H(R.ri, 2, 0x5b11), 0, ['kerb']);
        claim(R.ri, side, 'road', al, 0.26 * s);
    }
    // 4) ENTRANCES — the middle of each built lot's street-facing edge (≈ where buildStreets puts the door). Keeps
    //    the door approach clear of trees / vending, and anchors A-boards / potted plants / door visits.
    // 5) DRIVEWAYS — some residential lots: no tree and no parked car across the gate.
    const entranceSide = new Map<string, Slot>();   // lot id → its entrance slot
    for (const { lot } of lots) {
        let best: { R: StreetRoad; side: 1 | -1; along: number; len: number } | null = null;
        const n = lot.poly.length;
        for (let k = 0; k < n; k++) {
            // (railway-upgrade R3.1: an arcade bay's door is on its STREET face — a layout-time tag — even when the
            // bay is shorter than it is deep and its cross-street end edge would win the longest-edge rule.)
            if (lot.slot === 'viaduct' && lot.streetEdges && !lot.streetEdges.includes(k)) continue;
            const e0 = lot.poly[k], e1 = lot.poly[(k + 1) % n];
            const ex = e1[0] - e0[0], ez = e1[1] - e0[1], el = Math.hypot(ex, ez);
            if (el < 0.05 * s) continue;
            const mx = (e0[0] + e1[0]) * 0.5, mz = (e0[1] + e1[1]) * 0.5;
            for (const R of live) {
                if (Math.abs((ex * R.d[0] + ez * R.d[1]) / el) < 0.95) continue;   // edge parallel to the road
                const rx = mx - R.a[0], rz = mz - R.a[1];
                const al = rx * R.d[0] + rz * R.d[1], lat = rx * R.pp[0] + rz * R.pp[1];
                const side: 1 | -1 = lat >= 0 ? 1 : -1;
                if (al < 0 || al > R.len || Math.abs(lat) < half * 0.9 || Math.abs(lat) > half + probeMax) continue;
                if (!best || el > best.len) best = { R, side, along: al, len: el };
            }
        }
        if (!best || !inRange(best.R, best.along, 0.02 * s)) continue;
        const { R, side, along } = best;
        const hh = hash2(Math.round(lot.center[0] * 1000), Math.round(lot.center[1] * 1000), (seed ^ 0xe7e1) >>> 0);
        const sl = put('entrance', R, side, 'front', along, 0.03 * s, R.sides[side].frontC, hh, 0, ['front', 'kerb']);
        sl.zone = lot.zone;
        entranceSide.set(lot.id, sl);
        if (lot.zone === 'residential' && hh < 0.35) {
            const dal = along + (hh < 0.17 ? -1 : 1) * Math.min(best.len * 0.3, 0.06 * s);
            if (inRange(R, dal, 0.03 * s)) {
                const dsl = put('driveway', R, side, 'kerb', dal, 0.035 * s, R.sides[side].kerbC, hh, 0, ['kerb', 'road']);
                dsl.zone = lot.zone;
            }
        }
    }
    // 6) STREET TREES — regular PAIRED rows (the same along on both sides) per road class; a slot is only dropped where
    //    something else already claimed the kerb (lamp, pole, bus stop, door, driveway) → gaps read as intentional.
    //    Arterials always get a row; ordinary streets on about half the roads, at a wider pitch. Streets without a
    //    row get the occasional kerb PLANTER instead.
    for (const R of live) {
        if (R.klass !== 'arterial' && R.klass !== 'street') continue;
        const rowed = R.klass === 'arterial' || H(R.ri, 0, 0x7ee1) < 0.5;
        const sp = (R.klass === 'arterial' ? 0.55 : 0.72) * s;
        const a0 = lo(R, 0.06 * s), a1 = hi(R, 0.06 * s);
        if (a1 - a0 < sp * 0.6) continue;
        const n = Math.max(1, Math.floor((a1 - a0) / sp) + 1);
        const pad = ((a1 - a0) - (n - 1) * sp) * 0.5;               // centre the row inside the usable span
        for (let i = 0; i < n; i++) {
            const al = a0 + pad + i * sp;
            for (const side of [1, -1] as const) {
                const S = R.sides[side];
                if (S.zone === null && !S.hasLots && H(R.ri, side, 0x1e3a) < 0.5) continue;   // open (park/water) edge: sparser
                const off = S.kerbC;
                if (!okSlot(R, side, al, off) || !free(R.ri, side, 'kerb', al, 0.035 * s)) continue;
                if (rowed && !tallOk(R, side, al, off)) continue;   // no street tree under the viaduct deck
                if (rowed) put('tree', R, side, 'kerb', al, 0.035 * s, off, H(R.ri * 2 + (side > 0 ? 1 : 0), i, 0x77ee), i);
                else if (S.hasLots && H(R.ri * 2 + (side > 0 ? 1 : 0), i, 0x009c) < 0.22) put('planter', R, side, 'kerb', al, 0.03 * s, off, H(R.ri, i, 0x0ba1), i);
            }
        }
    }
    // 7) BENCHES — a few on arterial kerbs, spread over the usable span between the junction mouths (plus one in
    //    every bus shelter, emitted with the shelter).
    for (const R of live) {
        if (R.klass !== 'arterial') continue;
        const a0 = lo(R, 0.07 * s), a1 = hi(R, 0.07 * s);
        if (a1 <= a0) continue;
        const n = Math.max(1, Math.round((a1 - a0) / (0.6 * s)));
        for (let i = 0; i < n; i++) {
            if (H(R.ri, i, 0x4b1d) > 0.22) continue;
            const side: 1 | -1 = H(R.ri, i, 0x6f2a) < 0.5 ? 1 : -1, al = a0 + (a1 - a0) * (i + 0.5) / n, off = R.sides[side].kerbC;
            if (!okSlot(R, side, al, off) || !free(R.ri, side, 'kerb', al, 0.06 * s)) continue;
            put('bench', R, side, 'kerb', al, 0.06 * s, off, H(R.ri, i, 0x2ee7));
        }
    }
    // 8) BIKE ROWS — racks by the kerb outside shops (commercial / civic frontage), bikes angled shallowly.
    for (const R of live) {
        if (H(R.ri, 0, 0x1b1c) >= 0.4) continue;
        const side: 1 | -1 = H(R.ri, 2, 0x3c11) < 0.5 ? 1 : -1, S = R.sides[side];
        if (S.zone !== 'commercial' && S.zone !== 'civic') continue;
        const al = R.len * (0.28 + H(R.ri, 1, 0x2a2a) * 0.44);
        const n = 3 + ((H(R.ri, 4, 0x5c1d) * 4) | 0), hl = n * 0.02 * s + 0.02 * s;
        if (!inRange(R, al, hl) || !okSlot(R, side, al, S.kerbC) || !free(R.ri, side, 'kerb', al, hl)) continue;
        put('bikerow', R, side, 'kerb', al, hl, S.kerbC, H(R.ri, 5, 0x1bb1), n);
    }
    // 9) PARKED CARS — ON THE ASPHALT at the kerb (never on the footway), ONE side per road (JP streets rarely allow
    //    both), in short runs. Buses / trucks only on arterials (loading bays). `n` = vehicle type index (see
    //    PARKED_TYPES). Never in a bus bay, across a driveway, or at roadworks.
    for (const R of live) {
        if (R.klass !== 'arterial' && R.klass !== 'street') continue;
        const side: 1 | -1 = H(R.ri, 0, 0x51a9) < 0.5 ? 1 : -1;
        const off = parkedOffset(half, s);
        const sp = 0.36 * s, n = Math.floor(R.len / sp);
        for (let i = 0; i < n; i++) {
            const al = (i + 0.5) / n * R.len;
            if (H(R.ri, i, 0x2c07) > 0.42) continue;
            const vt = H(R.ri, i, 0x9911);
            const type = R.klass === 'arterial' && vt < 0.06 ? 4 : R.klass === 'arterial' && vt < 0.16 ? 5
                : (() => { const v2 = H(R.ri, i, 0x5a7c); return v2 < 0.08 ? 2 : v2 < 0.24 ? 1 : v2 < 0.34 ? 3 : 0; })();
            const hl = type === 4 ? 0.34 * s : type === 5 ? 0.25 * s : 0.17 * s;
            // Kept well back from the junctions: a car swinging out past one must be back in lane before the turn.
            if (!inRange(R, al, hl + 0.12 * s) || !free(R.ri, side, 'road', al, hl)) continue;
            const [x, z] = at(R.ri, side, al, off);
            if (!okAt(x, z)) continue;
            put('parked', R, side, 'road', al, hl, off, H(R.ri, i, 0x77f3), type);
        }
    }
    // 10) ROADWORKS — a coned-off patch at the kerb on a few ordinary streets (the only place cones appear).
    for (const R of live) {
        if (R.klass !== 'street' || H(R.ri, 0, 0x0c0e) > 0.06) continue;
        const side: 1 | -1 = H(R.ri, 1, 0x0c0f) < 0.5 ? 1 : -1, al = R.len * (0.35 + H(R.ri, 2, 0x0c10) * 0.3);
        if (!inRange(R, al, 0.12 * s) || !free(R.ri, side, 'road', al, 0.12 * s)) continue;
        const [x, z] = at(R.ri, side, al, parkedOffset(half, s));
        if (!okAt(x, z)) continue;
        put('roadworks', R, side, 'road', al, 0.12 * s, parkedOffset(half, s), H(R.ri, 3, 0x0c11));
    }
    // 11) VENDING RUNS — 2–4 machines shoulder to shoulder AGAINST the building line, facing the pavement, with a
    //     recycling bin at the end (the JP corner-shop / apartment-front run). One near a corner or mid-block per
    //     chosen side, plus the odd second mid-block run. The run slides along to fit between claimed kerb items on a
    //     narrow pavement (the "pinch" rule — never a tree AND a machine at the same spot on a < 2.4 m footway).
    const vendPitch = 0.059 * s, vendDepth = 0.04 * s;
    for (const R of live) {
        for (const side of [1, -1] as const) {
            const S = R.sides[side];
            if (!S.hasLots || S.zone === null) continue;
            for (let run = 0; run < 2; run++) {
                const roll = H(R.ri * 2 + (side > 0 ? 1 : 0), run, 0x9e11);
                if (roll > (run === 0 ? 0.13 : 0.04)) continue;
                const count = 2 + ((H(R.ri, side + run * 7, 0x30bd) * 3) | 0);
                const hl = (count * vendPitch + 0.035 * s) * 0.5;
                const base = run === 0 && roll < 0.065 ? lo(R, hl + 0.03 * s) : R.len * (0.3 + H(R.ri, side + 11 * run, 0x4e77) * 0.4);
                const narrow = S.frontage - half < 0.16 * s;
                let placed = false;
                for (let k = 0; k < 9 && !placed; k++) {
                    const al = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.05 * s;
                    if (!inRange(R, al, hl) || !free(R.ri, side, 'front', al, hl)) continue;
                    if (narrow && !free(R.ri, side, 'kerb', al, hl)) continue;
                    const f0 = frontageAtImpl(R, side, al - hl), f1 = frontageAtImpl(R, side, al + hl), fm = frontageAtImpl(R, side, al);
                    if (f0 == null || f1 == null || fm == null) continue;
                    const fr = Math.min(f0, f1, fm), off = fr - 0.007 * s - vendDepth * 0.5;
                    if (off - vendDepth * 0.5 < S.kerbOut || !okSlot(R, side, al, off)) continue;
                    put('vending', R, side, 'front', al, hl, off, H(R.ri, side + run * 3, 0x9bd1), count, narrow ? ['front', 'kerb'] : ['front']);
                    placed = true;
                }
            }
        }
    }
    // 12) FRONTAGE CLUTTER by the adjacent lot's zone — A-boards / crates / the odd produce stall by COMMERCIAL doors,
    //     potted plants and a bin by RESIDENTIAL doors. Not a flat roll on every pavement any more.
    for (const sl of slots.slice()) {
        if (sl.kind !== 'entrance') continue;
        const R = roads[sl.ri]!, S = R.sides[sl.side], h = sl.h;
        const tryPut = (kind: SlotKind, dal: number, hl: number, off: number, n = 0): boolean => {
            const al = sl.along + dal;
            if (!inRange(R, al, hl) || !free(R.ri, sl.side, 'front', al, hl) || !okSlot(R, sl.side, al, off)) return false;
            if (S.frontage - half < 0.16 * s && !free(R.ri, sl.side, 'kerb', al, hl)) return false;
            put(kind, R, sl.side, 'front', al, hl, off, hash2(sl.ri, Math.round(al * 1000), (seed ^ 0xc1a7) >>> 0), n);
            return true;
        };
        if (sl.zone === 'commercial') {
            if (h < 0.12) tryPut('stall', 0.075 * s * (h < 0.06 ? 1 : -1), 0.065 * s, S.frontIn + 0.004 * s);
            else if (h < 0.62) tryPut('aboard', 0.045 * s * (h < 0.37 ? 1 : -1), 0.012 * s, S.frontC);
            if (h > 0.5 && h < 0.8) tryPut('crate', -0.05 * s, 0.018 * s, S.frontC, 1 + ((h * 97) % 3 | 0));
        } else if (sl.zone === 'residential') {
            if (h > 0.4 && h < 0.85) tryPut('potted', 0.04 * s * (h < 0.62 ? 1 : -1), 0.012 * s, S.frontC);
            if (h > 0.9) tryPut('bin', -0.045 * s, 0.012 * s, S.frontC);
        } else if (sl.zone === 'civic' && h < 0.3) tryPut('bin', 0.05 * s, 0.012 * s, S.frontC);
    }
    // 13) CORNER KIT — red post boxes on the kerb near busy corners (commercial / civic), grey utility cabinets against
    //     the building line just inside the junction mouth.
    for (const R of live) {
        for (const end of [0, 1] as const) {
            if ((end === 0 ? R.armsA : R.armsB) < 3) continue;
            const mouth = end === 0 ? R.mouthA : R.mouthB;
            const al = end === 0 ? mouth + 0.04 * s : R.len - mouth - 0.04 * s;
            const g = H(R.ri, 20 + end, 0x1234), side: 1 | -1 = H(R.ri, 22 + end, 0x1235) < 0.5 ? 1 : -1, S = R.sides[side];
            if (g < 0.16 && (S.zone === 'commercial' || S.zone === 'civic')) {
                if (okSlot(R, side, al, S.kerbC) && free(R.ri, side, 'kerb', al, 0.02 * s)) put('postbox', R, side, 'kerb', al, 0.02 * s, S.kerbC, g);
            } else if (g < 0.26 && S.hasLots) {
                const off = S.frontOut - 0.017 * s;
                if (okSlot(R, side, al, off) && free(R.ri, side, 'front', al, 0.03 * s)) put('cabinet', R, side, 'front', al, 0.03 * s, off, g);
            }
        }
    }
    // 14) FRONTAGE DRESSING (persona-polish D1) — the eye-level life a Japanese shop street has and ours lacked:
    //     NOBORI flag runs beside shop doors, pots flanking doorways, bikes parked against the wall, the odd extra
    //     crate stack / menu board, and residential doorstep gardens. Runs LAST, so no earlier reservation moves;
    //     everything lands in the FRONTAGE band (walkers already bend round it) and passes the same guards as step
    //     12. Per-door rolls hash the entrance position with their own salt (independent of step 12's rolls).
    //     Density by zone: commercial dense, civic a little, residential light. `n` = flag / bike count.
    for (const sl of slots.slice()) {
        if (sl.kind !== 'entrance') continue;
        const R = roads[sl.ri]!, S = R.sides[sl.side];
        const hh = (k: number): number => hash2(Math.round(sl.x * 1000) + k * 7919, Math.round(sl.z * 1000), (seed ^ 0xd1f7) >>> 0);
        const narrow = S.frontage - half < 0.16 * s;
        const tryPut = (kind: SlotKind, dal: number, hl: number, off: number, n = 0): boolean => {
            const al = sl.along + dal;
            if (!inRange(R, al, hl) || !free(R.ri, sl.side, 'front', al, hl) || !okSlot(R, sl.side, al, off)) return false;
            if (narrow && !free(R.ri, sl.side, 'kerb', al, hl)) return false;
            const ns = put(kind, R, sl.side, 'front', al, hl, off, hash2(sl.ri, Math.round(al * 1000), (seed ^ 0xd1f8) >>> 0), n);
            ns.zone = sl.zone;
            return true;
        };
        const band = S.frontOut - S.frontIn;
        const wallOff = S.frontOut - Math.min(0.022 * s, band * 0.55);   // ~0.33 m off the building line (a pot row)
        const bikeOff = S.frontOut - Math.min(0.025 * s, band * 0.6);    // a bike parked parallel to the wall
        const flip = hh(0) < 0.5 ? 1 : -1;                    // which side of the door the flag run takes
        if (sl.zone === 'commercial') {
            // Nobori: 1-3 flags at a 0.9 m pitch, starting just clear of the door approach. Slides outward once if blocked.
            if (hh(1) < 0.72) {
                const n = 1 + ((hh(2) * 3) | 0), hl = n * 0.03 * s;
                for (const d0 of [0.05 * s + hl, 0.11 * s + hl]) if (tryPut('nobori', flip * d0, hl, S.frontC, n)) break;
            }
            // Doorway pots (one each side) on about a third of shops; a bike or two against the wall on others.
            if (hh(3) < 0.34) { tryPut('potted', -flip * 0.042 * s, 0.011 * s, wallOff); tryPut('potted', flip * 0.042 * s, 0.011 * s, wallOff); }
            if (hh(4) < 0.3) { const n = 1 + ((hh(5) * 2) | 0), hl = (0.06 + (n - 1) * 0.058) * s; tryPut('bikewall', -flip * (0.06 * s + hl), hl, bikeOff, n); }
            // A second crate stack or a menu board further along (restaurants / grocers stock the pavement).
            if (hh(6) < 0.28) tryPut('crate', -flip * 0.16 * s, 0.018 * s, S.frontC, 1 + ((hh(7) * 3) | 0));
            else if (hh(6) < 0.5) tryPut('aboard', -flip * 0.15 * s, 0.012 * s, S.frontC);
        } else if (sl.zone === 'residential') {
            // Doorstep garden: a short row of 2-3 pots beside the door; the family bike parked against the wall.
            if (hh(1) < 0.4) { const n = 2 + ((hh(2) * 2) | 0); for (let k = 0; k < n; k++) tryPut('potted', flip * (0.045 + k * 0.026) * s, 0.011 * s, wallOff); }
            if (hh(4) < 0.28) tryPut('bikewall', -flip * 0.11 * s, 0.06 * s, bikeOff, 1);
        } else if (sl.zone === 'civic') {
            if (hh(1) < 0.3) tryPut('nobori', flip * 0.09 * s, 0.03 * s, S.frontC, 1);
            if (hh(3) < 0.3) tryPut('potted', -flip * 0.05 * s, 0.011 * s, wallOff);
        }
    }
    // 14b) COMMERCIAL FILL — shop frontage is continuous, doors are not: walk each commercial side at a ~4.5 m pitch
    //      and drop the odd flag pair / menu board / pot / crate stack wherever the band is still free, so a shopping
    //      street never runs 20 m of bare pavement. Residential sides get nothing here (they stay light).
    for (const R of live) {
        for (const side of [1, -1] as const) {
            const S = R.sides[side];
            if (!S.hasLots || S.zone !== 'commercial') continue;
            const narrow = S.frontage - half < 0.16 * s, pitch = 0.3 * s;
            const a0 = lo(R, 0.06 * s), a1 = hi(R, 0.06 * s);
            const wallOff = S.frontOut - Math.min(0.022 * s, (S.frontOut - S.frontIn) * 0.55);
            for (let i = 0, al = a0 + pitch * 0.5; al < a1; i++, al += pitch) {
                const r = H(R.ri * 2 + (side > 0 ? 1 : 0), i, 0xd1f9);
                const pick: [SlotKind, number, number, number] | null = r < 0.3 ? ['nobori', 0.03 * s * (r < 0.12 ? 2 : 1), S.frontC, r < 0.12 ? 2 : 1]
                    : r < 0.42 ? ['aboard', 0.012 * s, S.frontC, 0] : r < 0.52 ? ['potted', 0.011 * s, wallOff, 0]
                    : r < 0.58 ? ['crate', 0.018 * s, S.frontC, 1 + ((r * 97) % 3 | 0)] : null;
                if (!pick) continue;
                const [kind, hl, off, n] = pick;
                if (!free(R.ri, side, 'front', al, hl) || !okSlot(R, side, al, off)) continue;
                if (narrow && !free(R.ri, side, 'kerb', al, hl)) continue;
                put(kind, R, side, 'front', al, hl, off, H(R.ri, Math.round(al * 1000), 0xd1fa), n).zone = 'commercial';
            }
        }
    }

    // 15) METRO ENTRANCES (railway-upgrade R2.3) — a kiosk over a stair down on the pavement just past a busy junction
    //     mouth (tee / cross, arterial or street), claiming the whole pavement width there. Runs LAST so adding it never
    //     moves another family; reserved whatever the `metroEntrances` toggle (metro.ts applies it when emitting).
    //     Kept clear of the viaduct (and its stations' stairs) and ≥ ~70 m apart; a few per city by radius.
    {
        const mu = 1 / cityMetresPerUnit(p.radius), hl = METRO_HALF_LEN_M * mu, hw = METRO_HALF_W_M * mu;
        const RL = (p.railway ?? true) ? railLayout(graph) : null;
        const cands: { R: StreetRoad; side: 1 | -1; along: number; off: number; end: 0 | 1; score: number }[] = [];
        for (const R of live) {
            if (R.klass !== 'arterial' && R.klass !== 'street') continue;
            for (const end of [0, 1] as const) {
                if ((end === 0 ? R.armsA : R.armsB) < 3) continue;
                const mouth = end === 0 ? R.mouthA : R.mouthB;
                const al = end === 0 ? mouth + 0.03 * s + hl : R.len - mouth - 0.03 * s - hl;
                if (!inRange(R, al, hl)) continue;
                for (const side of [1, -1] as const) {
                    const S = R.sides[side];
                    if (S.frontage - half < 2 * hw + 0.1 * mu) continue;          // the pavement must hold the kiosk
                    const off = (S.kerbOut + S.frontage) / 2;
                    let ok = true;
                    for (const da of [-hl, 0, hl]) for (const dof of [-hw, 0, hw]) {
                        const [x, z] = at(R.ri, side, al + da, off + dof);
                        if (!okAt(x, z) || inBuilding(x, z) || rail.solidAt(x, z) || rail.nearDeck(x, z, 8 * mu)) ok = false;
                    }
                    if (!ok || !free(R.ri, side, 'kerb', al, hl) || !free(R.ri, side, 'walk', al, hl) || !free(R.ri, side, 'front', al, hl)) continue;
                    const zoneBonus = S.zone === 'commercial' ? 0.35 : S.zone === 'civic' ? 0.2 : 0;
                    cands.push({ R, side, along: al, off, end, score: H(R.ri * 2 + end, side, 0x3e70) + zoneBonus + (R.klass === 'arterial' ? 0.25 : 0) });
                }
            }
        }
        cands.sort((a, b) => b.score - a.score);
        const want = Math.max(1, Math.round(3 * (p.radius / 10) ** 2)), minGap = 70 * mu;
        const placed: V2[] = [];
        const stairFeet: V2[] = RL ? RL.stairs.map(st => [st.xTop + st.dir * st.run, st.zp] as V2) : [];
        for (const c of cands) {
            if (placed.length >= want) break;
            const [x, z] = at(c.R.ri, c.side, c.along, c.off);
            if (placed.some(q => Math.hypot(q[0] - x, q[1] - z) < minGap)) continue;
            if (stairFeet.some(q => Math.hypot(q[0] - x, q[1] - z) < 30 * mu)) continue;
            if (!free(c.R.ri, c.side, 'kerb', c.along, hl) || !free(c.R.ri, c.side, 'walk', c.along, hl) || !free(c.R.ri, c.side, 'front', c.along, hl)) continue;
            put('metro', c.R, c.side, 'walk', c.along, hl, c.off, H(c.R.ri, c.end, 0x3e71), c.end, ['kerb', 'walk', 'front']);
            placed.push([x, z]);
        }
    }

    function frontageAtImpl(R: StreetRoad, side: 1 | -1, along: number): number | null {
        const h = frontProbe(R.a, R.d, R.pp, side, along);
        return h ? h.off : null;
    }

    return assemblePlan(graph, { s, half, roads, slots, claims: [...claims] }, lotIndex);
}

/** Parked-car centre offset from the road centreline: on the asphalt, the body's kerb-side flank ~0.2 m off the
 *  kerb face (car half-width 0.06·s). Clamped so a very narrow street still keeps the car on its own half. */
export function parkedOffset(half: number, s: number): number {
    return Math.max(0.065 * s, half - 0.072 * s);
}

/** Vehicle type per parked slot `n` (street-slots step 9). Kept here so furniture (emit) and traffic (swerve) agree. */
export const PARKED_TYPES = ['sedan', 'classic', 'taxi', 'van', 'bus', 'truck'] as const;
