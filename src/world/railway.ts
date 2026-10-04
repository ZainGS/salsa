// ── World generation — elevated railway (railway-upgrade.md R1.1–R1.4, R2.1, R2.3) ─────────────────────────────
// The Tokyo set-piece at REAL scale: a double-track concrete VIADUCT over a grid street (deck ~7.5 m up, ~10 m
// wide, 1.2 m box girder with fascia drip lips), rigid-frame PORTAL piers standing on the two pavements with a cap
// beam across the road (T piers where there is no street under the line), solid parapets with noise-barrier runs,
// ballasted track on sleepers (slab track through stations) with I-profile rails at 1.067 m gauge / 4 m centres,
// an overhead CATENARY on portal masts, and ELEVATED STATIONS (side platforms, canopy, tactile + edge lines,
// benches, name boards, lights, a stair down the cross-street pavement with the ticket-gate hall under it). Metro
// entrance kiosks on junction pavements ride in the same build group (metro.ts).
//
// Spaces: see rail-layout.ts — deck parts follow the WARPED centreline's rigid frame, ground parts (columns, stairs)
// stand at warp(layout point); every rail layer is noWarp (already in render space) + BAKED (routed with no height
// field). Whole-city infrastructure (not region-filtered). Deterministic.
//
// Layer names ↔ tiers (world-manager DETAIL / PROPS / STRUCTURE regexes), on purpose:
//   · world:rail-fine-*    — sleepers, rails, catenary masts + wires: FINE detail (distance-culled near-only)
//   · world:rail-stn-prop  — platform benches / gates / hand rails: PROPS
//   · every other world:rail-* (deck, piers, parapets, ballast, platform, canopy …): STRUCTURE (never distance-hide)
//   · world:rail-train*    — the train only (its visibility belongs to the traffic system)

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { Accum3D, chipExtrude, edgeChipSpec, EDGE_CHIP_NEAR_M, catenary, type ChipSpec } from './meshbuild';
import { makeElevation } from './elevation';
import { makeDomainWarpInto } from './warp';
import { hash2 } from './util';
import { metalScaleFor } from './types';
import { METAL_PAINTED } from './palette';
import { buildParkedTrain } from './train';
import { buildMetro } from './metro';
import { buildArcade } from './rail-arcade';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

// ★ INTERFACE (docs/specs/railway-upgrade.md): the line / tracks / stations live in rail-layout.ts (pure) and are
//   re-exported here — railwayLine(p) { rx, z0, z1, deckY, tracks, trackOffsets, railTopY, gaugeU, contactY, path, … },
//   railFrameAt / railTrackPath (render-space, noWarp), railStations(p) { z, halfLen, side }.
export { railwayLine, railFrameAt, railTrackPath, railPathNormal, railStations, railPlatformCars, railLayout, railReservations, railViaductMode, claimViaductLots, arcadeStrip, RAIL_M, RAIL_TOP_M, ARC_M } from './rail-layout';
export type { RailLine, RailFrame, RailStation, RailPier, RailStair, RailLayout, RailLineParams, RailViaduct, ArcadeBay } from './rail-layout';
import { railwayLine, railFrameAt, railPathNormal, railStations, railLayout, RAIL_M, ARC_M, type RailLine } from './rail-layout';

type V3 = [number, number, number];
type RGB = [number, number, number];

const CONCRETE: RGB = [0.60, 0.59, 0.56];      // piers + cap beams (fair-faced concrete)
const CONCRETE_STAIN: RGB = [0.40, 0.40, 0.38];// splash-zone / drip stain
const DECK: RGB = [0.52, 0.52, 0.50];          // deck girder
const PARAPET: RGB = [0.66, 0.65, 0.62];
const BALLAST: RGB = [0.40, 0.38, 0.35];
const SLAB: RGB = [0.56, 0.55, 0.52];
const SLEEPER: RGB = [0.50, 0.49, 0.46];       // pre-stressed concrete sleepers
const STEEL: RGB = [0.42, 0.42, 0.44];
const RAIL_HEAD: RGB = [0.55, 0.55, 0.57];
const MAST: RGB = [0.46, 0.48, 0.47];          // galvanised steel
const WIRE: RGB = [0.20, 0.18, 0.16];          // copper / bronze, weathered dark
const BARRIER: RGB = [0.62, 0.66, 0.66];       // noise-barrier panels
const PLATFORM: RGB = [0.62, 0.61, 0.58];
const EDGE_WHITE: RGB = [0.90, 0.90, 0.86];
const TACTILE: RGB = [0.86, 0.68, 0.10];
const CANOPY: RGB = [0.72, 0.73, 0.74];
const HALL: RGB = [0.78, 0.76, 0.72];
const GLASS: RGB = [0.34, 0.44, 0.50];
const SIGN: RGB = [0.95, 0.96, 0.94];
const LAMP: RGB = [1.0, 0.98, 0.92];
const PROP: RGB = [0.34, 0.36, 0.38];

/** The SKY-TRAIN's multi-segment route (the cyber suite): a polyline that WEAVES across the city and runs
 *  dead-straight +X through the MEGATOWER's portal at its centre. Shared by the static guideway build AND the
 *  traffic sim's path-following train. Null unless `holograms` is on. */
export function skywayPath(graph: WorldGraph): { pts: [number, number][]; y: number } | null {
    const p = graph.params;
    if (!(p.holograms ?? false)) return null;
    const mt = graph.landmarks.find(l => l.type === 'megatower');
    const R = p.radius, s = R / 10;
    // P10.A1: a neighbour tile's skyway weaves across ITS square (tile origin), not the centre city.
    const ox = p.tileOrigin?.[0] ?? 0, oz = p.tileOrigin?.[1] ?? 0;
    const c: [number, number] = mt ? [mt.center[0] - ox, mt.center[1] - oz] : [0, 0];
    // Bent approach → straight portal segment (through c along +X) → bent exit. The bends are the "weave".
    const pts: [number, number][] = [
        [-R * 1.06, c[1] * 0.2 - R * 0.30],
        [c[0] - R * 0.35, c[1]],
        [c[0] + R * 0.35, c[1]],
        [R * 1.06, c[1] * 0.2 + R * 0.30],
    ];
    if (ox || oz) for (const q of pts) { q[0] += ox; q[1] += oz; }
    return { pts, y: p.groundY + 0.8 * s };
}

/** The sky-train's GUIDEWAY: a glowing maglev beam floating along the skyway polyline (no piers — it's the
 *  future). Routed heightless like the viaduct (`rail-` prefix). Empty unless `holograms` is on. */
export function buildSkyway(graph: WorldGraph): LayoutPreviewLayer[] {
    const sky = skywayPath(graph);
    if (!sky) return [];
    const s = graph.params.radius / 10, gy = graph.params.groundY;
    const beam = new Accum3D();
    const by = sky.y - 0.045 * s;   // just under the train belly
    for (let i = 0; i < sky.pts.length - 1; i++) beam.beam([sky.pts[i][0], by, sky.pts[i][1]], [sky.pts[i + 1][0], by, sky.pts[i + 1][1]], 0.012 * s, 4);
    // noWarp: the guideway follows its OWN polyline; the sky-train (also unwarped) rides the same line exactly.
    return [{ name: 'world:rail-sky', color: [0.30, 0.90, 1.0], y: gy, geometry: beam.geometry(), emissive: 1.2, opacity: 0.8, noWarp: true }];
}

// ── Sweeps along the deck frame ───────────────────────────────────────────────────────────────────────────────

/** Stations of the centreline over [za, zb]: the path samples inside + the two ends, each with its mitred normal. */
interface Run { z: number[]; C: V2[]; N: V2[]; T: V2[]; s: number[] }
function runOf(line: RailLine, za: number, zb: number, stride = 1): Run | null {
    if (!(zb - za > 1e-6)) return null;
    const z: number[] = [], C: V2[] = [], N: V2[] = [], T: V2[] = [], s: number[] = [];
    const push = (zz: number, c: V2, n: V2, t: V2): void => {
        s.push(C.length ? s[s.length - 1] + Math.hypot(c[0] - C[C.length - 1][0], c[1] - C[C.length - 1][1]) : 0);
        z.push(zz); C.push(c); N.push(n); T.push(t);
    };
    const f0 = railFrameAt(line, za); push(za, [f0.x, f0.z], [f0.nx, f0.nz], [f0.tx, f0.tz]);
    line.pathZ.forEach((pz, i) => {
        if (pz <= za + 1e-7 || pz >= zb - 1e-7 || i % stride) return;
        const nn = railPathNormal(line, i); push(pz, line.path[i], nn, [-nn[1], nn[0]]);
    });
    const f1 = railFrameAt(line, zb); push(zb, [f1.x, f1.z], [f1.nx, f1.nz], [f1.tx, f1.tz]);
    return { z, C, N, T, s };
}

/** Sweep a 2D profile — points (off, dy): off along the frame normal, dy up from `y0` — along a run. CCW when
 *  closed (solid on the left, like chipExtrude); an OPEN profile is walked so its outward side is on the right.
 *  Flat per-edge normals, mitred joints (no cracks at the bends), UV = (arc length, profile length) in world units.
 *  `caps` closes the two ends (closed convex profiles only). */
function sweep(acc: Accum3D, run: Run | null, profile: V2[], y0: number, closed: boolean, caps = false): void {
    if (!run || profile.length < 2) return;
    const np = profile.length, ne = closed ? np : np - 1, ns = run.z.length;
    const P = (i: number, q: V2): V3 => [run.C[i][0] + run.N[i][0] * q[0], y0 + q[1], run.C[i][1] + run.N[i][1] * q[0]];
    let v = 0;
    for (let j = 0; j < ne; j++) {
        const a = profile[j], b = profile[(j + 1) % np];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        if (l < 1e-9) continue;
        const n2: V2 = [dy / l, -dx / l];
        const ids: [number, number][] = [];
        for (let i = 0; i < ns; i++) {
            const nl = Math.hypot(run.N[i][0], run.N[i][1]) || 1;
            const nrm = norm([run.N[i][0] / nl * n2[0], n2[1], run.N[i][1] / nl * n2[0]]);
            ids.push([acc.vertex(P(i, a), nrm, run.s[i], v), acc.vertex(P(i, b), nrm, run.s[i], v + l)]);
        }
        for (let i = 0; i + 1 < ns; i++) {
            const pa = P(i, a), pb = P(i, b), pd = P(i + 1, a);
            const fn = cross(sub(pb, pa), sub(pd, pa));
            const want = [run.N[i][0] * n2[0], n2[1], run.N[i][1] * n2[0]];
            const [a0, b0] = ids[i], [a1, b1] = ids[i + 1];
            if (fn[0] * want[0] + fn[1] * want[1] + fn[2] * want[2] >= 0) { acc.triangle(a0, b0, b1); acc.triangle(a0, b1, a1); }
            else { acc.triangle(a0, b1, b0); acc.triangle(a0, a1, b1); }
        }
        v += l;
    }
    if (closed && caps) for (const end of [0, ns - 1]) {
        const t = run.T[end], dir: V3 = end ? [t[0], 0, t[1]] : [-t[0], 0, -t[1]];
        const ring = profile.map(q => acc.vertex(P(end, q), dir, q[0], q[1]));
        for (let k = 1; k + 1 < np; k++) {
            const pa = P(end, profile[0]), pb = P(end, profile[k]), pc = P(end, profile[k + 1]);
            const fn = cross(sub(pb, pa), sub(pc, pa));
            if (fn[0] * dir[0] + fn[1] * dir[1] + fn[2] * dir[2] >= 0) acc.triangle(ring[0], ring[k], ring[k + 1]);
            else acc.triangle(ring[0], ring[k + 1], ring[k]);
        }
    }
}

/** A chipped (or clean, spec = null) straight bar per run segment, built along the MITRED reference line at offset
 *  `ref` so consecutive pieces meet with sub-millimetre gaps. `profile` is relative to (ref, y0). Near / far twins
 *  come from the same call, so their UVs match exactly. */
function chipRun(acc: Accum3D, wear: Accum3D | null, run: Run | null, ref: number, y0: number, profile: V2[], chip: boolean[], spec: ChipSpec | null): void {
    if (!run) return;
    const M = (i: number): V3 => [run.C[i][0] + run.N[i][0] * ref, y0, run.C[i][1] + run.N[i][1] * ref];
    let u0 = 0;
    for (let i = 0; i + 1 < run.z.length; i++) {
        const a = M(i), b = M(i + 1), d = sub(b, a), L = Math.hypot(d[0], d[1], d[2]);
        if (L < 1e-9) continue;
        const along: V3 = [d[0] / L, d[1] / L, d[2] / L], ua: V3 = [along[2], 0, -along[0]];
        chipExtrude(acc, a, along, ua, [0, 1, 0], L, profile, { closed: true, chip, spec, wear, caps: [i === 0, i + 2 === run.z.length], endChips: [i === 0, i + 2 === run.z.length], u0 });
        u0 += L;
    }
}

const mirror = (pr: V2[]): V2[] => pr.map(q => [-q[0], q[1]] as V2).reverse();
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** [a, b] minus the given holes → the remaining sub-ranges (sorted). */
function cutRanges(a: number, b: number, holes: [number, number][]): [number, number][] {
    let out: [number, number][] = [[a, b]];
    for (const [h0, h1] of holes) {
        const next: [number, number][] = [];
        for (const [x0, x1] of out) {
            if (h1 <= x0 || h0 >= x1) { next.push([x0, x1]); continue; }
            if (h0 > x0) next.push([x0, h0]);
            if (h1 < x1) next.push([h1, x1]);
        }
        out = next;
    }
    return out.filter(([x0, x1]) => x1 - x0 > 1e-6);
}

/** Merge several geometries into one (12-float layout). */
function mergeGeos(geos: (MeshGeometry | null)[]): MeshGeometry | null {
    const list = geos.filter((g): g is MeshGeometry => !!g && g.indices.length > 0);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    let nv = 0, ni = 0; for (const g of list) { nv += g.vertices.length; ni += g.indices.length; }
    const vertices = new Float32Array(nv), indices = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const g of list) {
        vertices.set(g.vertices, ov); const base = ov / 12;
        for (let i = 0; i < g.indices.length; i++) indices[oi + i] = g.indices[i] + base;
        ov += g.vertices.length; oi += g.indices.length;
    }
    return { vertices, indices, format: '12float' } as MeshGeometry;
}

// ── The build ─────────────────────────────────────────────────────────────────────────────────────────────────

export function buildRailway(graph: WorldGraph, includeTrain = true): LayoutPreviewLayer[] {
    const p = graph.params;
    const out: LayoutPreviewLayer[] = [];
    if (p.railway ?? true) out.push(...buildViaduct(graph));
    // The PARKED train (train.ts — the same EMU cars as the moving consists). Skipped when the traffic sim runs its
    // own moving trains (the ticker also hides any 'rail-train*' mesh while it runs).
    if ((p.railway ?? true) && includeTrain) out.push(...buildParkedTrain(p, railwayLine(p), railStations(p)));
    // Metro entrances ride in the same (transit) build group; their own toggle (metro.ts).
    out.push(...buildMetro(graph));
    return out;
}

function buildViaduct(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY;
    const RL = railLayout(graph), line = RL.line, u = line.unitsPerMetre;
    const { z0, z1, deckY } = line;
    const M = (m: number): number => m * u;
    const elev = makeElevation(graph);
    const warp = makeDomainWarpInto(p);
    const W = (x: number, z: number): V2 => { const o: [number, number] = [0, 0]; warp(x, z, o); return [x + o[0], z + o[1]]; };
    const metalScale = metalScaleFor(p.radius);
    const chipSpec = edgeChipSpec(p.edgeWear, u, 0x7a11);
    const twinD = EDGE_CHIP_NEAR_M * u;
    const hs = (a: number, b: number, salt: number): number => hash2(Math.round(a * 1000), Math.round(b * 1000), (p.seed ^ salt) >>> 0);

    const A = (): Accum3D => new Accum3D();
    const pier = A(), pierStain = A(), capFar = A(), capNear = A(), capWear = A();
    const deck = A(), deckStain = A(), drip = A();
    const parapet = A(), copeFar = A(), copeNear = A(), copeWear = A(), barrier = A(), trough = A();
    const ballast = A(), slab = A(), sleeper = A(), rail = A();
    const mast = A(), wire = A();
    const platform = A(), edgeLine = A(), tactile = A(), canopy = A(), lamps = A(), signs = A(), props = A();
    // Ground-level station parts: built in LAYOUT space and blended onto the warped street (see stairs below).
    const gStair = A(), gHall = A(), gGlass = A(), gSign = A(), gProp = A(), gCanopy = A();

    const halfW = M(RAIL_M.deckHalfW), dd = M(RAIL_M.deckDepth);
    const stations = RL.stations;
    const stRanges: [number, number][] = stations.map(st => [st.z - st.halfLen - M(2), st.z + st.halfLen + M(2)]);
    const normalRanges = cutRanges(z0, z1, stRanges);

    // ── Deck: box girder (sloped webs) + cantilever slabs with a fascia DRIP LIP at each edge ──
    // ARCADE (R3.1): the cross walls carry a flat 0.6 m slab (still lipped + drip-grooved at both edges); steel plate
    // girders under it span the cross streets / canals between the arcade runs.
    const arcade = line.mode === 'arcade';
    const slabD = M(ARC_M.slab);
    const lip = M(0.25), cant = arcade ? slabD : M(0.35), fasc = arcade ? M(0.75) : M(0.55);
    const deckProfile: V2[] = arcade ? [
        [-halfW + lip, -slabD], [halfW - lip, -slabD], [halfW - lip, -fasc], [halfW, -fasc],
        [halfW, 0], [-halfW, 0], [-halfW, -fasc], [-halfW + lip, -fasc],
    ] : [
        [-M(2.9), -dd], [M(2.9), -dd], [M(3.4), -cant], [halfW - lip, -cant], [halfW - lip, -fasc], [halfW, -fasc],
        [halfW, 0], [-halfW, 0], [-halfW, -fasc], [-halfW + lip, -fasc], [-halfW + lip, -cant], [-M(3.4), -cant],
    ];
    const whole = runOf(line, z0, z1);
    sweep(deck, whole, deckProfile, deckY, true);
    for (const sd of [1, -1]) {
        // Rain stain down the outer fascia (drip streaks) + the dark drip groove under the cantilever.
        const stain: V2[] = [[sd * (halfW + M(0.004)), -fasc], [sd * (halfW + M(0.004)), -fasc + M(0.3)]];
        sweep(deckStain, whole, sd > 0 ? stain : stain.slice().reverse(), deckY, false);
        const g: V2[] = [[sd * (halfW - lip - M(0.1)), -cant - M(0.004)], [sd * (halfW - lip - M(0.16)), -cant - M(0.004)]];
        sweep(drip, whole, sd > 0 ? g : g.slice().reverse(), deckY, false);
    }
    // Deck end diaphragms (close the girder section at both ends of the span).
    for (const zE of [z0, z1]) {
        const f = railFrameAt(line, zE), ed = arcade ? slabD : dd;
        deck.obox([f.x, deckY - ed / 2, f.z], [f.nx, 0, f.nz], [0, 1, 0], [f.tx, 0, f.tz], halfW, ed / 2, M(0.15));
    }
    // ARCADE: steel plate girders (web + bottom flange, two lines) under the slab over every gap between the runs,
    // bearing 0.6 m onto the end walls.
    const girder = A();
    const gd = M(ARC_M.girder);
    if (arcade) for (const [a, b] of cutRanges(z0, z1, RL.runs.map(r => [r[0] + M(0.6), r[1] - M(0.6)] as [number, number]))) {
        const run = runOf(line, a, b);
        for (const off of [-M(3.0), M(3.0)]) {
            sweep(girder, run, [[off - M(0.1), -slabD - gd], [off + M(0.1), -slabD - gd], [off + M(0.1), -slabD], [off - M(0.1), -slabD]], deckY, true, true);
            sweep(girder, run, [[off - M(0.35), -slabD - gd - M(0.05)], [off + M(0.35), -slabD - gd - M(0.05)], [off + M(0.35), -slabD - gd], [off - M(0.35), -slabD - gd]], deckY, true, true);
        }
    }

    // ── Parapets (normal deck) + noise-barrier runs + cable troughs ──
    const pT = M(RAIL_M.parapetT), pH = M(RAIL_M.parapetH), copeH = M(0.1), copeO = M(0.03);
    const parapetAt = (acc: Accum3D, run: Run | null, outer: number, side: number): void => {
        const body: V2[] = [[outer - pT, 0], [outer, 0], [outer, pH - copeH], [outer - pT, pH - copeH]];
        sweep(acc, run, side > 0 ? body : mirror(body), deckY, true, true);
        // Coping: its own chipped near twin (edge chips, near only).
        const ref = side * (outer - pT / 2), hw = pT / 2 + copeO;
        const cp: V2[] = [[-hw, pH - copeH], [hw, pH - copeH], [hw, pH], [-hw, pH]];
        chipRun(copeFar, null, run, ref, deckY, cp, [false, false, true, true], null);
        if (chipSpec) chipRun(copeNear, copeWear, run, ref, deckY, cp, [false, false, true, true], chipSpec);
    };
    for (const [a, b] of normalRanges) {
        const run = runOf(line, a, b);
        for (const sd of [1, -1]) {
            parapetAt(parapet, run, halfW, sd);
            const tr: V2[] = [[M(3.95), 0], [M(4.4), 0], [M(4.4), M(0.25)], [M(3.95), M(0.25)]];
            sweep(trough, run, sd > 0 ? tr : mirror(tr), deckY, true, true);
        }
        // Noise barriers on some ~30 m runs (either side independently) — the Tokyo elevated look.
        const nb = Math.max(1, Math.round((b - a) / M(30)));
        for (let k = 0; k < nb; k++) {
            const za = a + (b - a) * k / nb, zb = a + (b - a) * (k + 1) / nb;
            for (const sd of [1, -1]) {
                if (hs(za, sd, 0x5b0e) > 0.45) continue;
                const pn: V2[] = [[halfW - pT * 0.7, pH], [halfW - pT * 0.35, pH], [halfW - pT * 0.35, pH + M(RAIL_M.barrierH)], [halfW - pT * 0.7, pH + M(RAIL_M.barrierH)]];
                sweep(barrier, runOf(line, za, zb), sd > 0 ? pn : mirror(pn), deckY, true, true);
            }
        }
    }

    // ── Track bed: ballast on the open line, concrete slab track through stations ──
    const bh = M(RAIL_M.ballastH);
    for (const [a, b] of normalRanges) sweep(ballast, runOf(line, a, b), [[M(3.6), 0], [M(3.2), bh], [-M(3.2), bh], [-M(3.6), 0]], deckY, false);
    for (const [a, b] of stRanges) sweep(slab, runOf(line, a, b), [[M(3.3), 0], [M(3.3), bh], [-M(3.3), bh], [-M(3.3), 0]], deckY, false);

    // ── Sleepers (fine detail) + I-profile rails ──
    const sL = M(RAIL_M.sleeperL) / 2, sW = M(RAIL_M.sleeperW) / 2, sH = M(RAIL_M.sleeperH) / 2;
    const sy = deckY + bh - M(RAIL_M.sleeperSink) + sH;
    const pitch = M(RAIL_M.sleeperPitch);
    const nSl = Math.floor((z1 - z0 - M(1)) / pitch);
    for (let i = 0; i <= nSl; i++) {
        const z = z0 + M(0.5) + i * pitch, f = railFrameAt(line, z);
        for (const off of line.trackOffsets) sleeper.obox([f.x + f.nx * off, sy, f.z + f.nz * off], [f.nx, 0, f.nz], [0, 1, 0], [f.tx, 0, f.tz], sL, sH, sW);
    }
    const railY = deckY + bh - M(RAIL_M.sleeperSink) + M(RAIL_M.sleeperH) + M(RAIL_M.railPad);
    const rh = M(RAIL_M.railH), hh = M(RAIL_M.railHeadHalf);
    const iProfile = (c: number): V2[] => [
        [c - M(0.065), 0], [c + M(0.065), 0], [c + M(0.065), M(0.012)], [c + M(0.008), M(0.03)], [c + M(0.008), rh - M(0.045)],
        [c + hh, rh - M(0.037)], [c + hh, rh], [c - hh, rh], [c - hh, rh - M(0.037)], [c - M(0.008), rh - M(0.045)],
        [c - M(0.008), M(0.03)], [c - M(0.065), M(0.012)],
    ];
    const railRun = runOf(line, z0, z1, 2);   // 6 m chords: < 1 cm off the curve, half the rail triangles
    for (const off of line.trackOffsets) for (const sd of [1, -1]) sweep(rail, railRun, iProfile(off + sd * (line.gaugeU / 2 + hh)), railY, true, true);

    // ── Piers: portal frames (columns on the pavements + cap beam across the road) or T piers ──
    const capTop = arcade ? deckY - slabD - gd - M(0.05) + M(0.05) : deckY - dd + M(0.05), capD = M(1.0);
    for (const pr of RL.piers) {
        const f = railFrameAt(line, pr.z);
        const T3: V3 = [f.tx, 0, f.tz], N3: V3 = [f.nx, 0, f.nz];
        const tops: V3[] = [];
        for (const c of pr.cols) {
            const wc = W(c[0], c[1]);
            const base = gy + elev(c[0], c[1]) - M(0.6), top = capTop - capD + M(0.02);
            const rect = (hx: number, hz: number): V2[] => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [wc[0] + N3[0] * a * hx + T3[0] * b * hz, wc[1] + N3[2] * a * hx + T3[2] * b * hz] as V2);
            const taper = 1 + 0.06;
            pier.frustum(rect(pr.colHx * taper, pr.colHz * taper), rect(pr.colHx, pr.colHz), base, top);
            pierStain.frustum(rect(pr.colHx * taper + M(0.006), pr.colHz * taper + M(0.006)), rect(pr.colHx * 1.045 + M(0.006), pr.colHz * 1.045 + M(0.006)), base + M(0.5), base + M(0.6) + M(0.9));
            tops.push([wc[0], capTop, wc[1]]);
        }
        // Cap beam: along the frame normal, centred on the (warped) deck centre, bevel-chipped bottom edges (near twin).
        const ext = pr.kind === 'portal' ? Math.hypot(tops[1][0] - tops[0][0], tops[1][2] - tops[0][2]) / 2 + pr.colHx + M(0.35) : M(3.3);
        const cx = pr.kind === 'portal' ? (tops[0][0] + tops[1][0]) / 2 : f.x, cz = pr.kind === 'portal' ? (tops[0][2] + tops[1][2]) / 2 : f.z;
        let ax: V3 = pr.kind === 'portal' ? norm([tops[1][0] - tops[0][0], 0, tops[1][2] - tops[0][2]]) : N3;
        if (ax[0] * N3[0] + ax[2] * N3[2] < 0) ax = [-ax[0], 0, -ax[2]];
        const o: V3 = [cx - ax[0] * ext, capTop, cz - ax[2] * ext];
        const hz = pr.colHz + M(0.1);
        const prof: V2[] = [[-hz, -capD], [hz, -capD], [hz, 0], [-hz, 0]];
        const ua: V3 = [ax[2], 0, -ax[0]];
        chipExtrude(capFar, o, ax, ua, [0, 1, 0], 2 * ext, prof, { closed: true, chip: [true, true, false, false], spec: null });
        if (chipSpec) chipExtrude(capNear, o, ax, ua, [0, 1, 0], 2 * ext, prof, { closed: true, chip: [true, true, false, false], spec: chipSpec, wear: capWear });
    }

    // ── Overhead catenary: portal masts every ~45 m, messenger + contact wire per track with droppers ──
    const contactY = line.contactY, sysH = M(RAIL_M.systemHeight);
    const mastOff = halfW - pT - M(0.3), beamY = contactY + sysH + M(0.9);
    const nSpan = Math.max(2, Math.round((z1 - z0) / M(45)));
    const supports: number[] = [];
    for (let i = 0; i <= nSpan; i++) supports.push(z0 + M(1.5) + (z1 - z0 - M(3)) * i / nSpan);
    const mw = M(0.16);
    supports.forEach((z, i) => {
        const f = railFrameAt(line, z), T3: V3 = [f.tx, 0, f.tz], N3: V3 = [f.nx, 0, f.nz];
        const wide = RL.stationAt(z) >= 0 ? RL.stationHalfW - pT - M(0.3) : mastOff;
        for (const sd of [1, -1]) {
            const b: V3 = [f.x + N3[0] * sd * wide, deckY, f.z + N3[2] * sd * wide];
            mast.obox([b[0], (deckY + beamY) / 2 + M(0.1), b[2]], N3, [0, 1, 0], T3, mw, (beamY - deckY) / 2 + M(0.1), mw);
        }
        // The cross beam (a light truss read as a box girder) + a hanger + steady arm over each track.
        mast.obox([f.x, beamY, f.z], N3, [0, 1, 0], T3, wide + mw, M(0.18), M(0.12));
        for (const off of line.trackOffsets) {
            const st = (i % 2 ? 1 : -1) * M(0.2);   // contact-wire stagger (zig-zag across the pantograph)
            const hx = f.x + N3[0] * off, hz = f.z + N3[2] * off;
            mast.beam([hx, beamY - M(0.18), hz], [hx, contactY + M(0.35), hz], M(0.035), 4);
            mast.beam([hx, contactY + M(0.35), hz], [hx + N3[0] * st, contactY, hz + N3[2] * st], M(0.02), 3);
        }
    });
    const wr = M(0.018);
    for (let i = 0; i + 1 < supports.length; i++) {
        const fa = railFrameAt(line, supports[i]), fb = railFrameAt(line, supports[i + 1]);
        for (const off of line.trackOffsets) {
            const sa = (i % 2 ? 1 : -1) * M(0.2), sb = -sa;
            const pa = (f: typeof fa, lat: number, y: number): V3 => [f.x + f.nx * lat, y, f.z + f.nz * lat];
            const mA = pa(fa, off, contactY + sysH), mB = pa(fb, off, contactY + sysH);
            const cA = pa(fa, off + sa, contactY), cB = pa(fb, off + sb, contactY);
            const sag = Math.min(sysH * 0.7, M(0.35));
            catenary(wire, mA, mB, sag, 8, wr);                  // messenger: sags between the supports
            wire.beam(cA, cB, wr, 3);                            // contact wire: level (tensioned), staggered
            for (let k = 1; k < 8; k++) {                        // droppers: messenger → contact
                const t = k / 8, dip = 4 * sag * t * (1 - t);
                const m: V3 = [mA[0] + (mB[0] - mA[0]) * t, mA[1] - dip, mA[2] + (mB[2] - mA[2]) * t];
                const c: V3 = [cA[0] + (cB[0] - cA[0]) * t, contactY, cA[2] + (cB[2] - cA[2]) * t];
                wire.beam(m, c, wr * 0.6, 3);
            }
        }
    }

    // ── Stations (R2.1): station deck wings + parapets, side platforms, canopy, dressing ──
    const pe = M(RAIL_M.platformEdge), po = RL.platformOuter, Wd = RL.stationHalfW, pY = M(RAIL_M.platformAboveDeck);
    stations.forEach((st, si) => {
        const [ra, rb] = stRanges[si];
        const run = runOf(line, ra, rb), prun = runOf(line, st.z - st.halfLen, st.z + st.halfLen);
        for (const sd of [1, -1] as const) {
            const mk = (pr: V2[]): V2[] => sd > 0 ? pr : mirror(pr);
            // Wing slab carrying the platform past the normal deck edge, with its own fascia + stain.
            sweep(deck, run, mk([[halfW - M(0.1), -M(0.45)], [Wd, -M(0.45)], [Wd, 0], [halfW - M(0.1), 0]]), deckY, true, true);
            sweep(deckStain, run, sd > 0 ? [[Wd + M(0.004), -M(0.45)], [Wd + M(0.004), -M(0.2)]] : [[-Wd - M(0.004), -M(0.2)], [-Wd - M(0.004), -M(0.45)]], deckY, false);
            // Station parapet, cut where this side's stair leaves the platform.
            const holes: [number, number][] = RL.stairs.filter(s => s.station === si && s.side === sd).map(s => [s.zp - s.width / 2, s.zp + s.width / 2]);
            for (const [a, b] of cutRanges(ra, rb, holes)) parapetAt(parapet, runOf(line, a, b), Wd, sd);
            // End walls joining the normal parapet to the station parapet.
            for (const zE of [ra, rb]) {
                const f = railFrameAt(line, zE), mid = sd * (halfW + Wd - pT) / 2, hwid = (Wd - halfW + pT) / 2;
                parapet.obox([f.x + f.nx * mid, deckY + (pH - copeH) / 2, f.z + f.nz * mid], [f.nx, 0, f.nz], [0, 1, 0], [f.tx, 0, f.tz], hwid, (pH - copeH) / 2, pT / 2);
            }
            // Platform block, edge line, tactile strip (0.8 m back from the edge).
            sweep(platform, prun, mk([[pe, 0], [po, 0], [po, pY], [pe, pY]]), deckY, true, true);
            sweep(edgeLine, prun, mk([[pe + M(0.12), pY + M(0.004)], [pe, pY + M(0.004)]]), deckY, false);
            sweep(tactile, prun, mk([[pe + M(1.1), pY + M(0.006)], [pe + M(0.8), pY + M(0.006)]]), deckY, false);
            // Canopy over the middle ~65 % of the platform: posts every ~10 m, a thin sloped roof, lights under it.
            const ca = st.z - st.halfLen * 0.65, cb = st.z + st.halfLen * 0.65;
            const roofY = pY + M(3.0);
            sweep(canopy, runOf(line, ca, cb), mk([[pe - M(0.3), roofY - M(0.05)], [po + M(0.1), roofY + M(0.15)], [po + M(0.1), roofY + M(0.3)], [pe - M(0.3), roofY + M(0.1)]]), deckY, true, true);
            const postOff = sd * (po - M(0.9));
            const nPost = Math.max(2, Math.round((cb - ca) / M(10)));
            for (let k = 0; k <= nPost; k++) {
                const f = railFrameAt(line, ca + (cb - ca) * k / nPost);
                canopy.obox([f.x + f.nx * postOff, deckY + pY + M(1.55), f.z + f.nz * postOff], [f.nx, 0, f.nz], [0, 1, 0], [f.tx, 0, f.tz], M(0.1), M(1.55), M(0.1));
            }
            for (let z = ca + M(3); z < cb - M(1); z += M(6)) {
                const f = railFrameAt(line, z), lo = sd * (pe + M(0.7));
                lamps.obox([f.x + f.nx * lo, deckY + roofY - M(0.12), f.z + f.nz * lo], [f.nx, 0, f.nz], [0, 1, 0], [f.tx, 0, f.tz], M(0.08), M(0.035), M(0.6));
            }
            // Station name boards hanging under the canopy, facing the track (lit), + their hangers.
            for (const t of [-0.4, 0.05, 0.45]) {
                const f = railFrameAt(line, st.z + st.halfLen * t * (sd > 0 ? 1 : -1)), so = sd * (pe + M(0.45));
                signs.obox([f.x + f.nx * so, deckY + roofY - M(0.75), f.z + f.nz * so], [f.tx, 0, f.tz], [0, 1, 0], [f.nx, 0, f.nz], M(0.9), M(0.2), M(0.03));
                for (const e of [-1, 1]) props.beam([f.x + f.nx * so + f.tx * e * M(0.7), deckY + roofY - M(0.55), f.z + f.nz * so + f.tz * e * M(0.7)], [f.x + f.nx * so + f.tx * e * M(0.7), deckY + roofY, f.z + f.nz * so + f.tz * e * M(0.7)], M(0.015), 3);
            }
            // Benches along the back of the platform (clear of the stair opening).
            for (let z = st.z - st.halfLen + M(8); z < st.z + st.halfLen - M(6); z += M(14)) {
                if (holes.some(([h0, h1]) => z > h0 - M(3) && z < h1 + M(3))) continue;
                const f = railFrameAt(line, z), bo = sd * (po - M(0.45)), bx = f.x + f.nx * bo, bz = f.z + f.nz * bo;
                const T3: V3 = [f.tx, 0, f.tz], N3: V3 = [f.nx * sd, 0, f.nz * sd];
                props.obox([bx, deckY + pY + M(0.42), bz], T3, [0, 1, 0], N3, M(0.8), M(0.035), M(0.2));
                props.obox([bx + N3[0] * M(0.2), deckY + pY + M(0.66), bz + N3[2] * M(0.2)], T3, [0, 1, 0], N3, M(0.8), M(0.2), M(0.03));
                for (const e of [-0.65, 0.65]) props.obox([bx + T3[0] * M(e), deckY + pY + M(0.2), bz + T3[2] * M(e)], T3, [0, 1, 0], N3, M(0.03), M(0.2), M(0.18));
            }
            // The street-facing station sign on the wing parapet (lit band), away from the stair.
            const sgz = st.z - (holes.length ? Math.sign(holes[0][0] - st.z) || 1 : 1) * M(9);
            const fS = railFrameAt(line, sgz), so = sd * (Wd + M(0.05));
            signs.obox([fS.x + fS.nx * so, deckY + M(0.45), fS.z + fS.nz * so], [fS.tx, 0, fS.tz], [0, 1, 0], [fS.nx, 0, fS.nz], M(3.5), M(0.35), M(0.05));
        }
    });

    // ── Station stairs + ticket-gate halls (ground level, LAYOUT space → blended onto the warped street) ──
    for (const sr of RL.stairs) {
        const d = sr.dir, w2 = sr.width / 2, zp = sr.zp, x0 = sr.xTop;
        const flight = sr.run - M(1.2), rise = sr.topY - sr.footY;
        const n = Math.max(4, Math.ceil(rise / M(0.18)));
        const X: V3 = [d, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1];
        for (let k = 0; k < n; k++) {
            const top = sr.topY - (k + 1) * rise / n, xm = x0 + d * (k + 0.5) * flight / n;
            gStair.obox([xm, top - M(0.2), zp], X, Y, Z, flight / n / 2 + M(0.01), M(0.2), w2);
        }
        gStair.obox([x0 + d * (flight + M(0.6)), sr.footY - M(0.1), zp], X, Y, Z, M(0.6), M(0.12), w2);   // foot landing
        // Stringers (the flight's side walls), soffit and hand rails.
        const top0: V3 = [x0, sr.topY + M(0.05), 0], foot0: V3 = [x0 + d * flight, sr.footY + M(0.05), 0];
        for (const e of [-1, 1]) {
            const zz = zp + e * (w2 + M(0.06));
            gStair.quad4([top0[0], top0[1] - M(0.6), zz], [foot0[0], foot0[1] - M(0.6), zz], [foot0[0], foot0[1] + M(0.15), zz], [top0[0], top0[1] + M(0.15), zz]);
            gProp.beam([x0, sr.topY + M(0.9), zp + e * (w2 - M(0.04))], [x0 + d * flight, sr.footY + M(0.9), zp + e * (w2 - M(0.04))], M(0.025), 4);
        }
        // Stair canopy (covered stair) on three posts.
        const cr = M(2.6);
        gCanopy.quad4([x0, sr.topY + cr, zp - w2 - M(0.2)], [x0 + d * flight, sr.footY + cr, zp - w2 - M(0.2)], [x0 + d * flight, sr.footY + cr, zp + w2 + M(0.2)], [x0, sr.topY + cr, zp + w2 + M(0.2)]);
        for (const t of [0.5, 1]) {
            const xx = x0 + d * flight * t, yy = sr.topY - rise * t;
            for (const e of [-1, 1]) gCanopy.obox([xx, yy + cr / 2, zp + e * (w2 + M(0.1))], X, Y, Z, M(0.05), cr / 2, M(0.05));
        }
        // Ticket-gate hall under the upper flight: solid back + lot-side wall, glazed road-side face, lit sign band
        // over its open street end, a row of ticket gates across the entrance.
        const hL = sr.hallLen, hy = p.groundY + elev(x0 + d * hL / 2, zp), hH = M(3.0);
        const hx0 = x0 + d * M(0.3), hx1 = x0 + d * hL, hxm = (hx0 + hx1) / 2, hLen = Math.abs(hx1 - hx0) / 2;
        const road = Math.sign(RL.stations[sr.station].z - zp) || 1;    // which z side faces the cross-street carriageway
        gHall.obox([hx0, hy + hH / 2, zp], X, Y, Z, M(0.1), hH / 2, w2);                          // back wall
        gHall.obox([hxm, hy + hH, zp], X, Y, Z, hLen + M(0.1), M(0.1), w2 + M(0.08));             // roof
        gHall.obox([hxm, hy + hH / 2, zp - road * w2], X, Y, Z, hLen, hH / 2, M(0.06));          // lot-side wall
        gGlass.obox([hxm, hy + hH * 0.47, zp + road * w2], X, Y, Z, hLen, hH * 0.47, M(0.03));  // glass front
        gHall.obox([hxm, hy + hH * 0.97, zp + road * (w2 + M(0.02))], X, Y, Z, hLen, hH * 0.05, M(0.05));   // glazing head
        gSign.obox([hx1 + d * M(0.05), hy + hH - M(0.3), zp], X, Y, Z, M(0.04), M(0.25), w2);   // lit name band over the gates
        gSign.obox([hxm, hy + hH + M(0.35), zp + road * (w2 + M(0.05))], X, Y, Z, hLen * 0.8, M(0.25), M(0.04));   // road-side sign
        const nG = Math.max(2, Math.floor(sr.width / M(0.6)));
        for (let g = 0; g < nG; g++) {
            const gz = zp - w2 + (g + 0.5) * sr.width / nG;
            gProp.obox([hx1 - d * M(0.8), hy + M(0.5), gz], X, Y, Z, M(0.6), M(0.5), M(0.07));   // gate cabinets
        }
    }
    // Blend map: the stair TOP meets the platform (deck frame), its FOOT stands where its pavement renders (warp).
    const blendGround = (acc: Accum3D): MeshGeometry | null => {
        if (acc.empty) return null;
        const geo = acc.geometry(), v = geo.vertices;
        const ofs = RL.stairs.map(s => {
            const f = railFrameAt(line, s.zp), top: V2 = [f.x + f.nx * s.side * Wd, f.z + f.nz * s.side * Wd], wt = W(s.xTop, s.zp);
            return { s, fx: top[0] - wt[0], fz: top[1] - wt[1] };
        });
        const o: [number, number] = [0, 0];
        for (let i = 0; i < v.length; i += 12) {
            const x = v[i], z = v[i + 2];
            let best = ofs[0], bd = Infinity;
            for (const q of ofs) { const dd2 = Math.abs(z - q.s.zp) + Math.abs(x - q.s.xTop - q.s.dir * q.s.run / 2) * 0.2; if (dd2 < bd) { bd = dd2; best = q; } }
            warp(x, z, o);
            const t = best ? Math.max(0, Math.min(1, (x - best.s.xTop) * best.s.dir / Math.max(1e-6, best.s.run))) : 1;
            v[i] = x + o[0] + (best ? best.fx * (1 - t) : 0);
            v[i + 2] = z + o[1] + (best ? best.fz * (1 - t) : 0);
        }
        return geo;
    };

    // ── Emit ──
    const L: LayoutPreviewLayer[] = [];
    const add = (name: string, color: RGB, geo: MeshGeometry | null, extra: Partial<LayoutPreviewLayer> = {}): void => {
        if (geo && geo.indices.length) L.push({ name, color, y: gy, geometry: geo, noWarp: true, drape: 'baked', ...extra });
    };
    const g = (a: Accum3D): MeshGeometry | null => a.empty ? null : a.geometry();
    const metal = (tint: RGB, extra: Partial<NonNullable<LayoutPreviewLayer['metal']>> = {}): Partial<LayoutPreviewLayer> => ({ metal: { ...METAL_PAINTED, tint, scale: metalScale, ...extra } });
    const joints = (c: RGB, every: number): LayoutPreviewLayer['pattern'] => ({ color: [c[0] * 0.86, c[1] * 0.86, c[2] * 0.86], freq: 1 / (every * u), scale: 0.03, mode: 'grid' });
    const twin = (key: string, role: 'near' | 'far'): Partial<LayoutPreviewLayer> => chipSpec ? { nearTwin: { key, role, dist: twinD } } : {};
    // STRUCTURE tier
    add('world:rail-pier', CONCRETE, g(pier), { pattern: joints(CONCRETE, 1.2) });
    add('world:rail-pier-stain', CONCRETE_STAIN, g(pierStain));
    add('world:rail-pier-cap', CONCRETE, g(capFar), twin('rail-cap', 'far'));
    if (chipSpec) { add('world:rail-pier-cap', CONCRETE, g(capNear), twin('rail-cap', 'near')); add('world:rail-pier-cap-wear', [CONCRETE[0] * 1.08, CONCRETE[1] * 1.08, CONCRETE[2] * 1.08], g(capWear), twin('rail-cap', 'near')); }
    add('world:rail-deck', DECK, g(deck), { pattern: joints(DECK, 6) });
    add('world:rail-deck-stain', CONCRETE_STAIN, g(deckStain));
    add('world:rail-deck-drip', [0.16, 0.16, 0.16], g(drip));
    add('world:rail-parapet', PARAPET, g(parapet), { pattern: joints(PARAPET, 3) });
    add('world:rail-parapet-cope', PARAPET, g(copeFar), twin('rail-cope', 'far'));
    if (chipSpec) { add('world:rail-parapet-cope', PARAPET, g(copeNear), twin('rail-cope', 'near')); add('world:rail-parapet-cope-wear', [PARAPET[0] * 1.08, PARAPET[1] * 1.08, PARAPET[2] * 1.08], g(copeWear), twin('rail-cope', 'near')); }
    add('world:rail-barrier', BARRIER, g(barrier), metal(BARRIER, { streakAmount: 0.5 }));   // one material family per mesh (metal)
    add('world:rail-trough', SLAB, g(trough));
    add('world:rail-ballast', BALLAST, g(ballast), { pattern: { color: [0.30, 0.29, 0.27], freq: 1 / (0.07 * u), scale: 0.45, mode: 'dots' } });
    add('world:rail-slab', SLAB, g(slab));
    // ARCADE (R3.1): the plate girders + the arcade itself (rail-arcade.ts; its layers are already noWarp + baked).
    add('world:rail-arc-girder', [0.36, 0.42, 0.40], g(girder), metal([0.36, 0.42, 0.40], { streakAmount: 0.6 }));
    if (arcade) L.push(...buildArcade(graph, RL, elev));
    // FINE detail tier
    add('world:rail-fine-sleeper', SLEEPER, g(sleeper));
    add('world:rail-fine-rail', RAIL_HEAD, g(rail), metal(STEEL, { roughness: 0.3, grime: 0.2 }));
    add('world:rail-fine-cat-mast', MAST, g(mast), metal(MAST));
    add('world:rail-fine-cat-wire', WIRE, g(wire));
    // Stations (STRUCTURE; lit parts untiered-by-glow; small props PROPS)
    add('world:rail-stn-platform', PLATFORM, g(platform), { pattern: { color: [0.52, 0.51, 0.49], freq: 1 / (0.6 * u), scale: 0.04, mode: 'grid' } });
    add('world:rail-stn-edge', EDGE_WHITE, g(edgeLine));
    add('world:rail-stn-tactile', TACTILE, g(tactile), { pattern: { color: [0.7, 0.54, 0.06], freq: 1 / (0.05 * u), scale: 0.4, mode: 'stripes' } });
    add('world:rail-stn-canopy', CANOPY, mergeGeos([g(canopy), blendGround(gCanopy)]), metal(CANOPY, { streakAmount: 0.4 }));
    add('world:rail-stn-lamplights', LAMP, g(lamps), { emissive: p.nightMode ? 1.0 : 0.6 });
    add('world:rail-stn-sign-lit', SIGN, mergeGeos([g(signs), blendGround(gSign)]), { emissive: p.nightMode ? 1.0 : 0.55 });
    add('world:rail-stn-stair', CONCRETE, blendGround(gStair));
    add('world:rail-stn-hall', HALL, blendGround(gHall));
    add('world:rail-stn-shop-glass', GLASS, blendGround(gGlass), { glass: true });
    add('world:rail-stn-prop', PROP, mergeGeos([g(props), blendGround(gProp)]), metal(PROP));
    return L;
}
