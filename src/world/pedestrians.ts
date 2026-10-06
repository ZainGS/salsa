// ── World generation — pedestrians (the static crowd) ───────────────────────────────────────────
// Medium-poly MANNEQUINS (mannequin.ts: faceless heads, real clothes cuts, hair, shoes, bags, open / closed umbrellas)
// standing, strolling, chatting, sitting and waiting around the city — merged per palette colour → a handful of
// draws. Placement follows a FOOTFALL FIELD (busy by the station, landmarks, shops, junctions and the shotengai;
// thinner at night) and the shared pavement plan (street-slots.ts): nobody stands inside a parked car, a tree, a
// vending machine or a shopfront; people gather where people gather (bus stops, benches, vending machines, stalls,
// signal corners). Position-hash deterministic, canal-skipping, region-filterable, count-capped. The MOVING crowd is
// the traffic sim (traffic.ts walkers) — these anchors are the standing half of the same street.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { stationEntrances } from './station-entrances';
import { inLocalCorridor, inCrossingZone } from './local-line';
import { cityMetresPerUnit } from './types';
import { hash2, pointInPolygon } from './util';
import { Accum3D } from './meshbuild';
import { makeWaterTest, cellLevelAt } from './elevation';
import { bridgeDecks, deckAt, deckSurfaceY } from './bridge-deck';
import { regionAt } from './layout';
import { streetPlan, pavementLift, BENCH_SEAT_M, type Slot } from './street-slots';
import { streetDims } from './street-layout';
import { emitPerson, personLook, archetypeIndex, pedShadeColor, armHold, poseLeadSide, PED_PALETTE, PED_SHADE, PV_COUNT, type PedColor, type PersonSink, type Pose } from './mannequin';
import type { CrowdPerson, CrowdMeta, CrowdGeometry } from './crowd-live';
import type { PersonLook } from './mannequin';
import { buildPedestriansInstanced } from './crowd-instanced';

/** Hard cap on the baked crowd — `pedestrianDensity` scales toward it, never past it. */
export const STATIC_CROWD_CAP = 4000;

/** NEAR / FAR TWINS (the E2 mechanism — Mesh3D.lodTwinRole): every static person is baked TWICE, the HIGH mannequin
 *  (~2k tris: smooth head + ears, fingers, lapels, hems) into the NEAR twin layers and the cheap one (~0.7k) into the
 *  FAR twin layers; the renderer draws the near twin only for crowd chunks within this many METRES of the camera
 *  (perspective + distance LOD on; ortho / LOD off = far twins). Same names, same colours → every name rule holds. */
export const PED_NEAR_M = 30;
/** Cell size (metres) of the crowd twins' shared grid — coarse, so the ~25 palette colours × 2 twins stay a few
 *  hundred meshes (a near cell draws its HIGH people out to PED_NEAR_M past its edge). */
export const PED_TWIN_CELL_M = 110;
/** P9 third tier: past this many METRES the static crowd swaps its cheap mannequins for the cheapest ones (lod 2,
 *  mannequin DETAIL_XLO). The cheap bake becomes the MID tier (between PED_NEAR_M and this); distance LOD off / ortho
 *  without screen LOD still draws the mid tier, as before. World param `propTwins: false` = the two-tier crowd. */
export const PED_XFAR_M = 100;

/** 0.25 … ~2.5 people-per-slot multiplier at a point: the FOOTFALL FIELD. Exported for tests + the walker spawner. */
export function footfallField(graph: WorldGraph): (x: number, z: number) => number {
    const p = graph.params, s = p.radius / 10;
    const hot: { c: V2; r: number; w: number }[] = [];
    for (const lm of graph.landmarks) hot.push({ c: lm.entrance ?? lm.center, r: (lm.type === 'station' ? 3.2 : 2.0) * s, w: lm.type === 'station' ? 1.6 : 0.6 });
    if (graph.plaza && graph.plaza.length >= 3) hot.push({ c: [0, 0], r: 2.4 * s, w: 0.7 });
    // Station entrances (railway-upgrade R2.2): the elevated line's stair feet, the metro kiosks, the local line's platforms.
    for (const e of stationEntrances(graph)) hot.push({ c: [e.x, e.z], r: (e.kind === 'rail' ? 1.8 : 1.2) * s, w: e.kind === 'rail' ? 0.9 : 0.6 });
    const junctions = graph.intersections.filter(it => it.type === 'cross').map(it => it.pos);
    const night = p.nightMode ? 0.55 : 1;
    const commercial = graph.lots.filter(l => l.zone === 'commercial').map(l => l.center);
    return (x, z) => {
        let f = 0.35;
        for (const h of hot) { const d = Math.hypot(x - h.c[0], z - h.c[1]); if (d < h.r) f += h.w * (1 - d / h.r) * (1 - d / h.r); }
        for (const j of junctions) { const d = Math.hypot(x - j[0], z - j[1]); if (d < 0.6 * s) { f += 0.5 * (1 - d / (0.6 * s)); break; } }
        for (const c of commercial) { if (Math.abs(x - c[0]) < 0.45 * s && Math.abs(z - c[1]) < 0.45 * s) { f += 0.45; break; } }
        return f * night;
    };
}

/** Rain → ~70% carry an umbrella (clear vinyl mostly — very Tokyo — plus navy / red). */
export function umbrellaFor(weather: string | undefined, h: number, h2: number): PedColor | null {
    if (weather !== 'rain' || h > 0.7) return null;
    return h2 < 0.6 ? 'vinyl' : h2 < 0.85 ? 'umbNavy' : h2 < 0.93 ? 'umbRed' : 'black';
}

export interface StaticPerson {
    x: number; z: number; face: V2; pose: Pose; kind: 'stroll' | 'group' | 'window' | 'wait' | 'seat' | 'vend' | 'stall' | 'crowd' | 'lean' | 'rail';
    /** 'rail' people (at a bridge parapet): the rail top above their feet + its distance ahead, METRES. */
    rail?: { y: number; d: number };
    /** Set when the person stands on a canal BRIDGE DECK: the deck's baked surface height (above groundY) under
     *  their feet. Such people drape on the SMOOTH field only, like the deck (see buildPedestrians). */
    deckY?: number;
    /** Conversation GROUP id (the ring a 'group' person stands in) — the live crowd turns their heads to the speaker. */
    group?: number;
}

/** Every static person's anchor (pure; exported for the overlap tests). */
export function staticCrowd(graph: WorldGraph, keep?: ((region: number) => boolean) | null): StaticPerson[] {
    const p = graph.params;
    if (!(p.pedestrians ?? true)) return [];
    const s = p.radius / 10, u = 1 / cityMetresPerUnit(p.radius);
    const H = (a: number, b: number, salt: number): number => hash2(a, b, (p.seed ^ salt) >>> 0);
    const plan = streetPlan(graph);
    const border = graph.border;
    // ★ E5/S13: a person over a canal stands ON A BRIDGE DECK or not at all. The deck is tested by its real span
    // and parapet line (bridge-deck.ts), clear of the balustrade, and the person keeps the deck's surface height —
    // they used to be accepted anywhere in the deck quad and then draped with the FULL elevation, which over a
    // canal cell is the trench level: the "people standing in the water under the bridge".
    const decks = bridgeDecks(graph), parapet = 0.012 * s;
    const isWater = makeWaterTest(graph);
    const ok = (x: number, z: number): boolean =>
        (!!deckAt(decks, x, z, parapet) || (!isWater(x, z) && (border.length < 3 || pointInPolygon([x, z], border)))) &&
        !plan.inBuilding(x, z) && (!keep || keep(regionAt(graph, x, z) ?? -1)) &&
        !(graph.localLine && (inLocalCorridor(graph.localLine, x, z, 0.3 * u) || inCrossingZone(graph.localLine, x, z, 0.5)));   // (R3.2) off the local line's tracks + crossings
    // A road that runs DOWN IN a canal trench (the canal-side streets are excavated with the canal) carries nobody:
    // only a road whose middle is dry land or a bridge deck has a pavement to stand on.
    const sunkAt = (x: number, z: number): boolean => cellLevelAt(graph, x, z) < 0 && !deckAt(decks, x, z);
    const roadDry = (R: { a: V2; b: V2 }): boolean => !sunkAt((R.a[0] + R.b[0]) * 0.5, (R.a[1] + R.b[1]) * 0.5);
    const dens = Math.max(0.1, p.pedestrianDensity ?? 1);
    const CAP = Math.min(STATIC_CROWD_CAP, Math.round(900 * dens));
    const field = footfallField(graph);
    const out: StaticPerson[] = [];
    const add = (x: number, z: number, face: V2, kind: StaticPerson['kind'], pose: Pose = 'stand', rail?: StaticPerson['rail'], group?: number): boolean => {
        if (out.length >= CAP || !ok(x, z)) return false;
        const on = deckAt(decks, x, z, parapet);
        const pp: StaticPerson = on ? { x, z, face, pose, kind, deckY: deckSurfaceY(on.deck, on.t, on.w) } : { x, z, face, pose, kind };
        if (rail) pp.rail = rail;
        if (group !== undefined) pp.group = group;
        out.push(pp); return true;
    };
    // A shop DOOR within r of (along) on a side — wall-leaners keep clear of the doorways.
    const nearDoor = (ri: number, side: 1 | -1, along: number, r: number): boolean =>
        plan.onSide(ri, side).some(sl => sl.kind === 'entrance' && Math.abs(sl.along - along) < sl.half + r);
    // Keep a person clear of every reserved thing on their side of the road (trees, poles, machines, bikes, stalls…).
    const clearOf = (ri: number, side: 1 | -1, along: number, off: number, r: number): boolean => {
        for (const sl of plan.onSide(ri, side)) {
            if (sl.kind === 'entrance' || sl.kind === 'driveway' || sl.band === 'road') continue;
            if (Math.abs(sl.along - along) < sl.half + r && Math.abs(sl.off - off) < 0.03 * s + r) return false;
        }
        return true;
    };
    const ring = (cx: number, cz: number, n: number, seed: number, kind: StaticPerson['kind']): void => {
        const r = 0.024 * s * (n > 2 ? 1.15 : 1);   // ~0.35 m — conversational distance
        const a0 = H(seed, 1, 0x61a3) * Math.PI * 2;
        for (let k = 0; k < n; k++) {
            const a = a0 + (k / n) * Math.PI * 2, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
            add(x, z, [-Math.cos(a), -Math.sin(a)], kind, 'stand', undefined, seed);   // everyone faces the middle of the group
        }
    };

    // 1) GATHERING POINTS first (they're the story of the street): bus stops, benches, vending machines, stalls.
    for (const sl of plan.of('busstop')) {
        const R = plan.roads[sl.ri]!, face: V2 = [-R.pp[0] * sl.side, -R.pp[1] * sl.side];
        const n = Math.round((1 + H(sl.ri, 1, 0xb057) * 3) * Math.min(1.6, field(sl.x, sl.z)));
        for (let k = 0; k < n; k++) {
            const al = sl.along + (k - (n - 1) / 2) * 0.03 * s + 0.07 * s, off = sl.off + 0.012 * s;
            const [x, z] = plan.at(sl.ri, sl.side, al, off);
            add(x, z, face, 'wait');
        }
    }
    const seat = (sl: Slot, extraAlong: number): void => {
        const R = plan.roads[sl.ri]!, face: V2 = [-R.pp[0] * sl.side, -R.pp[1] * sl.side];
        const n = H(sl.ri, Math.round(sl.along * 100), 0x5ea7) < 0.55 ? 1 : H(sl.ri, 3, 0x5ea8) < 0.5 ? 2 : 0;
        for (let k = 0; k < n; k++) {
            const al = sl.along + extraAlong + (n === 2 ? (k - 0.5) * 0.04 * s : (H(sl.ri, 5, 0x5ea9) - 0.5) * 0.03 * s);
            const [x, z] = plan.at(sl.ri, sl.side, al, sl.off - 0.004 * s);
            add(x, z, face, 'seat', 'sit');
        }
    };
    for (const sl of plan.of('bench')) seat(sl, 0);
    for (const sl of plan.of('busstop')) seat(sl, 0);
    for (const sl of plan.of('vending')) {
        if (H(sl.ri, Math.round(sl.along * 100), 0x7e4d) > 0.35 * field(sl.x, sl.z)) continue;
        const R = plan.roads[sl.ri]!, out2: V2 = [R.pp[0] * sl.side, R.pp[1] * sl.side];
        const al = sl.along + (H(sl.ri, 9, 0x7e4e) - 0.5) * sl.half, off = sl.off - 0.045 * s;
        if (!clearOf(sl.ri, sl.side, al, off, 0.004 * s)) continue;
        const [x, z] = plan.at(sl.ri, sl.side, al, off);
        add(x, z, out2, 'vend');   // facing the machine (toward the building line)
    }
    for (const sl of plan.of('stall')) {
        const R = plan.roads[sl.ri]!, out2: V2 = [R.pp[0] * sl.side, R.pp[1] * sl.side];
        const n = 1 + (H(sl.ri, 11, 0x57a1) < 0.5 * field(sl.x, sl.z) ? 1 : 0);
        for (let k = 0; k < n; k++) {
            const [x, z] = plan.at(sl.ri, sl.side, sl.along + (k - (n - 1) / 2) * 0.04 * s, plan.side(sl.ri, sl.side)!.walkC - 0.01 * s);
            add(x, z, out2, 'stall');
        }
    }

    // 2) SIGNAL CROSSINGS — small crowds waiting at the kerb end of the zebras of 4-way (signalled) junctions,
    //    facing across the road they are about to cross (street-layout's set-back crossings).
    const SD = streetDims(p), zc = SD.cwStart + SD.cwDepth * 0.5;
    plan.roads.forEach((R) => {
        if (!R || !roadDry(R)) return;
        for (const end of [0, 1] as const) {
            if ((end === 0 ? R.armsA : R.armsB) < 4 || R.len < 2 * zc) continue;
            const node: V2 = end === 0 ? R.a : R.b;
            if (cellLevelAt(graph, node[0], node[1]) < 0) continue;   // a bridged junction has no zebra to wait at
            for (const side of [1, -1] as const) {
                const S = R.sides[side], f = field(node[0], node[1]);
                const n = Math.min(4, Math.floor(H(R.ri * 4 + end * 2 + (side > 0 ? 1 : 0), 0, 0xc0e1) * 2.4 * f));
                const across: V2 = [-R.pp[0] * side, -R.pp[1] * side];
                for (let k = 0; k < n; k++) {
                    const dz = ((k % 2) - 0.5) * SD.cwDepth * 0.45 + (H(R.ri, k + end * 8, 0xc0e2) - 0.5) * 0.02 * s;
                    const al = end === 0 ? zc + dz : R.len - zc - dz;
                    const off = S.kerbC + ((k / 2) | 0) * 0.026 * s;
                    if (!clearOf(R.ri, side, al, off, 0.006 * s)) continue;
                    const [x, z] = plan.at(R.ri, side, al, off);
                    add(x, z, across, 'crowd');
                }
            }
        }
    });

    // 3) STROLLERS + chatting GROUPS + WINDOW SHOPPERS along the pavements (walk band, clear of every reserved slot).
    plan.roads.forEach((R) => {
        if (!R || R.klass === 'ring' || !roadDry(R)) return;
        const a0 = R.mouthA + 0.04 * s, a1 = R.len - R.mouthB - 0.04 * s;
        if (a1 <= a0) return;
        for (const side of [1, -1] as const) {
            const S = R.sides[side], walkHalf = Math.max(0.004 * s, (S.frontIn - S.kerbOut) * 0.5);
            const n = Math.floor((a1 - a0) * dens / (0.1 * s));
            for (let i = 0; i < n; i++) {
                const al = a0 + (a1 - a0) * (i + H(R.ri * 2 + (side > 0 ? 1 : 0), i, 0x71c3)) / n;
                const [cx, cz] = plan.at(R.ri, side, al, S.walkC);
                const f = field(cx, cz);
                const roll = H(R.ri * 2 + (side > 0 ? 1 : 0), i, 0x9ed1);
                if (roll > Math.min(0.75, 0.13 * f)) continue;
                const kindRoll = H(R.ri * 2 + (side > 0 ? 1 : 0), i, 0x44a7);
                if (kindRoll < 0.2 && S.frontIn - S.kerbOut > 0.02 * s) {             // a GROUP of 2–4 chatting
                    const off = S.walkC;
                    if (!clearOf(R.ri, side, al, off, 0.03 * s)) continue;
                    ring(cx, cz, 2 + ((H(R.ri, i, 0x2b7c) * 3) | 0), R.ri * 131 + i, 'group');
                } else if (kindRoll < 0.42 && S.zone === 'commercial') {             // WINDOW SHOPPING, facing the shopfront
                    // … or LEANING back on the wall between the doors, facing the street (waiting for someone)
                    const lean = H(R.ri * 2 + (side > 0 ? 1 : 0), i, 0x1ea7) < 0.3 && !nearDoor(R.ri, side, al, 0.03 * s);
                    const off = lean ? S.frontOut - 0.011 * s : S.frontOut - 0.022 * s;
                    if (!clearOf(R.ri, side, al, off, 0.006 * s)) continue;
                    const [x, z] = plan.at(R.ri, side, al, off);
                    if (lean) add(x, z, [-R.pp[0] * side, -R.pp[1] * side], 'lean', 'lean');
                    else add(x, z, [R.pp[0] * side, R.pp[1] * side], 'window');
                } else {                                                              // STROLLER, facing up or down the street
                    const off = S.walkC + (H(R.ri, i, 0x0f0f) - 0.5) * walkHalf;
                    if (!clearOf(R.ri, side, al, off, 0.006 * s)) continue;
                    const [x, z] = plan.at(R.ri, side, al, off), dir = H(R.ri, i, 0x2468) < 0.5 ? 1 : -1;
                    add(x, z, [R.d[0] * dir, R.d[1] * dir], 'stroll');
                }
            }
        }
    });

    // 4) The SHOTENGAI corridor is BUSY (the pedestrian street): strollers, groups, and shoppers at the stall rows.
    const sg = graph.shotengai;
    if (sg && (!keep || keep(sg.region))) {
        const dx = sg.spine[1][0] - sg.spine[0][0], dz = sg.spine[1][1] - sg.spine[0][1], L = Math.hypot(dx, dz) || 1;
        const d: V2 = [dx / L, dz / L], px = -d[1], pz = d[0], n = Math.floor(L * dens / (0.07 * s));
        for (let i = 0; i < n; i++) {
            if (H(i, 7, 0x5e0f) > 0.55) continue;
            const t = (i + 0.5) / n, lane = H(i, 8, 0x66d2) - 0.5, u2 = lane * sg.width * 0.78;
            const x = sg.spine[0][0] + dx * t + px * u2, z = sg.spine[0][1] + dz * t + pz * u2;
            const kr = H(i, 9, 0x1948);
            if (kr < 0.18) ring(x, z, 2 + ((H(i, 10, 0x3b7a) * 3) | 0), 9000 + i, 'group');
            else if (Math.abs(lane) > 0.36) add(x, z, [px * Math.sign(lane), pz * Math.sign(lane)], 'window');   // at the stalls
            else add(x, z, H(i, 12, 0x3b7b) < 0.5 ? d : [-d[0], -d[1]], 'stroll');
        }
    }

    // 5) The PLAZA: a few groups and loiterers.
    if (graph.plaza && graph.plaza.length >= 3) {
        const R = p.radius * p.plazaRadius;
        for (let i = 0; i < Math.round(16 * dens); i++) {
            const ang = H(i, 11, 0x0f5a) * Math.PI * 2, r = Math.sqrt(H(i, 12, 0x7d31)) * R * 0.85;
            const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
            if (!pointInPolygon([x, z], graph.plaza)) continue;
            if (H(i, 13, 0x24bd) < 0.3) ring(x, z, 2 + ((H(i, 14, 0x59c6) * 3) | 0), 7000 + i, 'group');
            else { const a = H(i, 15, 0x59c7) * Math.PI * 2; add(x, z, [Math.cos(a), Math.sin(a)], 'stroll'); }
        }
    }
    // 6) BRIDGE PARAPETS: a few people at the rail of a canal bridge, leaning over it to look at the water.
    decks.forEach((dk, di) => {
        for (const side of [1, -1] as const) {
            if (H(di, side > 0 ? 1 : 2, 0x7a11) > 0.55) continue;
            const w = side * (dk.wHalf - 0.02 * s);
            if (Math.abs(w) < dk.carriageHalf + 0.01 * s) continue;   // no footway wide enough
            const n = 1 + (H(di, side > 0 ? 3 : 4, 0x7a12) < 0.35 ? 1 : 0);
            for (let k = 0; k < n; k++) {
                const t = 0.3 + 0.4 * H(di * 4 + k, side > 0 ? 5 : 6, 0x7a13);
                const x = dk.c[0] + dk.d[0] * (t * 2 - 1) * dk.half + dk.p[0] * w, z = dk.c[1] + dk.d[1] * (t * 2 - 1) * dk.half + dk.p[1] * w;
                // the balustrade's top rail: 0.045·s above the footway, at wHalf − 0.006·s (water.ts addArchBridge)
                add(x, z, [dk.p[0] * side, dk.p[1] * side], 'rail', 'rail', { y: 0.045 * s / u, d: (0.02 - 0.006) * s / u });
            }
        }
    });
    return out;
}

/** A static person's POSE from their spot + a hash roll: people waiting at a bus stop / signal mostly look at their
 *  phones or wait hands-clasped; strollers have paused (phone / weight on one leg / standing); groups and shoppers stand.
 *  Never 'stride': a static person gets the live crowd's idle sway, and a frozen mid-step pose that sways reads as a
 *  broken walk cycle. Walking people are the moving crowd (traffic.ts), not static records. */
export function staticPose(kind: StaticPerson['kind'], seatPose: Pose, r: number): Pose {
    if (seatPose === 'sit') return 'sit';
    switch (kind) {
        case 'lean': return 'lean';
        case 'rail': return 'rail';
        case 'wait': case 'crowd': return r < 0.3 ? 'phone' : r < 0.45 ? 'clasp' : r < 0.8 ? 'rest' : 'stand';
        case 'stroll': return r < 0.4 ? 'phone' : r < 0.75 ? 'rest' : 'stand';
        case 'group': return r < 0.4 ? 'talk' : r < 0.65 ? 'rest' : r < 0.75 ? 'clasp' : r < 0.83 ? 'phone' : 'stand';
        default: return r < 0.25 ? 'clasp' : r < 0.6 ? 'rest' : 'stand';
    }
}

/** Under a shelter / an awning / at a shop the umbrella is furled (carried closed at the side). */
const SHELTERED: ReadonlySet<StaticPerson['kind']> = new Set(['wait', 'window', 'vend', 'stall', 'lean', 'rail']);

/** Everything that decides how one static person is EMITTED (look, pose, umbrella, height, mirroring) — derived from the
 *  person's anchor + index + the build's params by the same hashes for the baked layers (buildPedestrians) and the
 *  instanced crowd's records (crowd-instanced.ts), so the two paths emit exactly the same people. */
export interface StaticPersonSpec {
    /** Per-person hash (0..1) — also the live crowd's idle desync seed. */
    seed: number;
    arch: number;
    /** personLook's variant seed. */
    lookSeed: number;
    look: PersonLook;
    umb: PedColor | null;
    pose: Pose;
    /** The emit origin's Y (ground / bench seat + the bridge deck), world units. */
    y: number;
    flip: boolean;
    /** The umbrella is furled (sheltered spots). */
    closed: boolean;
}
export function staticPersonSpec(p: WorldGraph['params'], pp: StaticPerson, i: number): StaticPersonSpec {
    const gy = p.groundY + pavementLift(p), u = 1 / cityMetresPerUnit(p.radius);
    const seed = hash2(Math.round(pp.x * 997), Math.round(pp.z * 991), (p.seed ^ 0x9e0e) >>> 0);
    const arch = archetypeIndex(seed), lookSeed = Math.floor(seed * 1e6) + i;
    const look = personLook(arch, lookSeed);
    const umb = umbrellaFor(p.weather, hash2(i, 3, (p.seed ^ 0x0b0b) >>> 0), hash2(i, 4, (p.seed ^ 0x0b0c) >>> 0));
    const pose = staticPose(pp.kind, pp.pose, hash2(i, 5, (p.seed ^ 0x9053) >>> 0));
    const sit = pose === 'sit';
    // Seated people sit at the bench seat height (the mannequin puts the hip at 0.47 m·k above T.o).
    const y = (sit ? gy + (BENCH_SEAT_M - 0.47 * look.heightM / 1.7) * u : gy) + (pp.deckY ?? 0);
    const flip = hash2(i, 6, (p.seed ^ 0xf11b) >>> 0) < 0.5, closed = SHELTERED.has(pp.kind);
    return { seed, arch, lookSeed, look, umb, pose, y, flip, closed };
}

/** A crowd layer: the FLAT Persona-NPC look (PED_SHADE — dimmed diffuse + emissive lift, plain colour blocks, no
 *  garment pattern). Shared with the walkers. */
export function crowdLayer(name: string, c: PedColor): Pick<LayoutPreviewLayer, 'name' | 'color' | 'emissive'> {
    return { name, color: pedShadeColor(PED_PALETTE[c]), emissive: PED_SHADE.emissive };
}

export function buildPedestrians(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params;
    if (!(p.pedestrians ?? true)) return [];
    // P12 INSTANCED CROWD (default; world param `instancedCrowd: false` = this baked build, kept for A/B): per-person
    // records + shared xfar variants, the near / mid tiers built lazily around the camera (crowd-instanced.ts).
    if (p.instancedCrowd !== false) return buildPedestriansInstanced(graph, keep);
    const gy = p.groundY + pavementLift(p), s = p.radius / 10, u = 1 / cityMetresPerUnit(p.radius);
    // Two sets of merged layers: people on the ground (FULL drape — terrain + terrace + kerb) and people on a bridge
    // deck, whose height is already baked from the deck (SMOOTH drape, exactly like the deck under them).
    // … and each set twice: the NEAR twin (HIGH mannequins) and the FAR twin (cheap ones) — see PED_NEAR_M.
    const accs = new Map<string, Accum3D>(), deckAccs = new Map<string, Accum3D>();
    const farAccs = new Map<string, Accum3D>(), farDeckAccs = new Map<string, Accum3D>();
    const xAccs = new Map<string, Accum3D>(), xDeckAccs = new Map<string, Accum3D>();   // P9 xfar tier (lod 2)
    const tiers = p.propTwins === false ? [0, 1] as const : [0, 1, 2] as const;
    let onDeck = false, far = false, xfar = false;
    // LIVE-CROWD bookkeeping (crowd-live.ts): per accumulator, the index sub-range of every (person, body part) —
    // emitPerson calls sink.mark(part) at each part boundary; a flush closes the open segment on every accumulator
    // this person has touched. The ranges ride on each output geometry (`geometry.crowd`).
    const segs = new Map<Accum3D, { start: number; out: number[] }>();
    const touched: Accum3D[] = [];
    let curPart = 0, curPerson = 0;
    const flush = (): void => {
        for (const a of touched) {
            const sg = segs.get(a)!, n = a.indexCount - sg.start;
            if (n > 0) sg.out.push(curPerson, curPart, sg.start, n);
            sg.start = a.indexCount;
        }
    };
    const acc = (c: PedColor): Accum3D => {
        const m = xfar ? (onDeck ? xDeckAccs : xAccs) : far ? (onDeck ? farDeckAccs : farAccs) : (onDeck ? deckAccs : accs);
        let a = m.get(c);
        if (!a) { a = new Accum3D(); m.set(c, a); segs.set(a, { start: 0, out: [] }); }
        if (!touched.includes(a)) { segs.get(a)!.start = a.indexCount; touched.push(a); }
        return a;
    };
    const people = staticCrowd(graph, keep);
    const meta: CrowdPerson[] = [];
    people.forEach((pp, i) => {
        onDeck = pp.deckY !== undefined;
        const { seed, look, umb, pose, y, flip, closed } = staticPersonSpec(p, pp, i);
        const sink: PersonSink = {
            top: () => acc(look.top), skin: () => acc('skin'), hair: () => acc(look.hair),
            leg: () => acc(look.legs), shoes: () => acc(look.shoes), skirt: () => look.skirt ? acc(look.skirt) : null,
            bag: () => acc(look.bagColor), umbrella: () => umb ? acc(umb) : null, collar: () => look.collar ? acc(look.collar) : null,
            extra: (c) => acc(c),
            mark: (part) => { flush(); curPart = part; },
        };
        const piv = new Array<number>(PV_COUNT * 3).fill(0);
        for (const lod of tiers) {   // the NEAR twin (HIGH), the FAR (mid) twin, the XFAR tier — the same person, the same pivots
            touched.length = 0; curPerson = i; curPart = 0; far = lod === 1; xfar = lod === 2;
            emitPerson(sink, { o: [pp.x, y, pp.z], f: pp.face, u }, look, {
                pose, umbrella: umb, umbrellaClosed: closed, lod, flip, pivots: piv,
                ...(pp.rail ? { rail: pp.rail } : {}),
            });
            flush();
        }
        const cu = !!(umb && closed);
        meta.push({
            x: pp.x, z: pp.z, yaw: Math.atan2(-pp.face[1], pp.face[0]), pose, kind: pp.kind, group: pp.group ?? -1, seed,
            k: look.heightM / 1.7, u, lead: poseLeadSide(flip),
            holdL: armHold(look, pose, -1, umb, cu), holdR: armHold(look, pose, 1, umb, cu), piv,
        });
    });
    void s;
    const out: LayoutPreviewLayer[] = [];
    const dist = PED_NEAR_M * u, three = tiers.length === 3, dist2 = three ? PED_XFAR_M * u : undefined;
    const sets = [[accs, 'world:ped-', 'near'], [deckAccs, 'world:ped-deck-', 'near'], [farAccs, 'world:ped-', three ? 'mid' : 'far'], [farDeckAccs, 'world:ped-deck-', three ? 'mid' : 'far'],
        [xAccs, 'world:ped-', 'xfar'], [xDeckAccs, 'world:ped-deck-', 'xfar']] as const;
    for (const [m, prefix, role] of sets) for (const [c, a] of m) {
        if (a.empty) continue;
        const geometry: CrowdGeometry = a.geometry();
        geometry.crowd = crowdMetaFor(geometry, segs.get(a)!.out, meta);
        const deck = m === deckAccs || m === farDeckAccs || m === xDeckAccs;
        out.push({ ...crowdLayer(prefix + c, c as PedColor), y: gy, geometry, nearTwin: { key: deck ? 'crowd-deck' : 'crowd', role, dist, cell: PED_TWIN_CELL_M * u, ...(dist2 ? { dist2 } : {}) }, ...(deck ? { drape: 'smooth' as const } : {}) });
    }
    return out;
}

/** The live-crowd metadata for one merged crowd layer: its (person, part, start, count) ranges + each range's
 *  build-space reference vertex (see CrowdMeta). */
function crowdMetaFor(geo: CrowdGeometry, flat: number[], people: CrowdPerson[]): CrowdMeta {
    const ranges = Uint32Array.from(flat), n = ranges.length / 4, refs = new Float32Array(n * 3);
    for (let r = 0; r < n; r++) {
        const vi = geo.indices[ranges[r * 4 + 2]] * 12;
        refs[r * 3] = geo.vertices[vi]; refs[r * 3 + 1] = geo.vertices[vi + 1]; refs[r * 3 + 2] = geo.vertices[vi + 2];
    }
    return { people, ranges, refs };
}
