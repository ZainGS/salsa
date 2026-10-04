// ── World generation — terraces (discrete elevation) ────────────────────────────────────────────
// Where the ground steps between terrace levels, this draws the RETAINING WALL — a real one: the face turned
// toward the low side, a lighter coping slab on top, weep-hole drain pipes, a darker stain along the foot (or a
// wet band at a canal's waterline), and a chain-link fence on posts along the top — and, on some walls, a
// Japanese hillside STAIR: ~18 cm risers climbing ALONG the wall on the pavement (the pavement is too narrow to
// climb straight at the wall), solid treads, a side wall, a top landing that opens through the wall onto the
// terrace, and a 1.1 m handrail on posts. The raise of the ground + buildings is the elevation post-transform.
//
// ★ WHERE a wall goes is derived, not assumed: every lot line (cell edge ± streetBandHalf — the only lines the
// ground level can change on) is scanned, the actual ground level is compared just either side, and a wall is
// built wherever they differ. That one rule gives the ordinary terrace walls, the embankment walls of a canal,
// and the TAPERED side walls along a road ramp (ramp surface on one side, the lot on the other), and never puts a
// wall where there is no step (e.g. across a ramp's foot, or into a perpendicular street). Walls/stairs are built
// with the level baked into Y (drape 'smooth'), split on the ground lattice so their feet meet the ground.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { metalScaleFor, cityMetresPerUnit } from './types';
import { METAL_PAINTED } from './palette';
import { Accum3D, chipExtrude, edgeChipSpec, EDGE_CHIP_NEAR_M, type ChipSpec } from './meshbuild';
import { terraceStep, streetBandHalf, cellLevelAt, rampLevelAt, canalWaterY } from './elevation';
import { groundTess, bakedGroundAt } from './ground-mesh';
import { hash2, pointInPolygon } from './util';

type V3 = [number, number, number];
const WALL: [number, number, number] = [0.52, 0.50, 0.47];    // concrete retaining wall
const CAP: [number, number, number] = [0.66, 0.64, 0.60];     // coping slab (lighter, fresher concrete)
const STAIN: [number, number, number] = [0.38, 0.37, 0.34];   // damp foot / run-off stain
const WET: [number, number, number] = [0.24, 0.26, 0.25];     // canal waterline (algae-dark wet stone)
const DRAIN: [number, number, number] = [0.20, 0.20, 0.21];   // weep-hole pipe stubs
const STEP: [number, number, number] = [0.62, 0.61, 0.58];    // granite steps (B6: tread + riser, one slab per step)
const NOSING: [number, number, number] = [0.17, 0.17, 0.18];  // dark anti-slip nosing strip
const NOSING_Y: [number, number, number] = [0.80, 0.63, 0.12]; // yellow nosing (some flights)
const RAIL: [number, number, number] = [0.28, 0.28, 0.31];    // metal railing
const MESH: [number, number, number] = [0.46, 0.48, 0.47];    // galvanised chain-link

/** One piece of wall between two points on a lot line: `lo*`/`hi*` are the baked ground heights (above
 *  groundY) on the low and high side at each end; `n` = unit normal toward the LOW side. */
interface WallPiece { a: V2; b: V2; loA: number; loB: number; hiA: number; hiB: number; loLevel: number; hiLevel: number }
interface WallRun { pieces: WallPiece[]; n: V2; e: V2; constant: boolean }

export function buildTerraces(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params;
    if (!graph.levels || p.pattern !== 'grid' || !(p.terraces ?? true)) return [];
    const R = graph.radius, cols = p.gridCols, rows = p.gridRows, cw = 2 * R / cols, ch = 2 * R / rows;
    const step = terraceStep(p), gy = p.groundY, s = R / 10;
    const t = groundTess(graph);
    const band = streetBandHalf(p);
    const ramps = graph.ramps ?? null;
    const eps = 1e-4 * s;
    const levelAt = (x: number, z: number): number => rampLevelAt(ramps, x, z) ?? cellLevelAt(graph, x, z);
    const inBorder = (x: number, z: number): boolean => pointInPolygon([x, z], graph.border);

    // 1) Scan every lot line for level differences → wall runs.
    const runs: WallRun[] = [];
    const scan = (a: V2, b: V2, e: V2, side: V2): void => {
        const ts = [0, ...t.cuts(a, b), 1];
        let cur: WallRun | null = null;
        for (let k = 0; k + 1 < ts.length; k++) {
            const P0: V2 = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
            const P1: V2 = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
            const mx = (P0[0] + P1[0]) * 0.5, mz = (P0[1] + P1[1]) * 0.5;
            const l0 = levelAt(mx - side[0] * eps, mz - side[1] * eps), l1 = levelAt(mx + side[0] * eps, mz + side[1] * eps);
            if (Math.abs(l0 - l1) < 1e-3 || !inBorder(mx, mz)) { cur = null; continue; }
            const n: V2 = l0 < l1 ? [-side[0], -side[1]] : [side[0], side[1]];   // toward the low side
            // Heights nudged just into each side, a hair in from the piece ends (so an end on a split line
            // reads the piece's own region, not the neighbour's).
            const inset = (P: V2, Q: V2): V2 => [P[0] + (Q[0] - P[0]) * 1e-3, P[1] + (Q[1] - P[1]) * 1e-3];
            const q0 = inset(P0, P1), q1 = inset(P1, P0);
            const lowAt = (q: V2): number => bakedGroundAt(t, q[0] + n[0] * eps, q[1] + n[1] * eps, true);
            const highAt = (q: V2): number => bakedGroundAt(t, q[0] - n[0] * eps, q[1] - n[1] * eps, true);
            const piece: WallPiece = { a: P0, b: P1, loA: lowAt(q0), loB: lowAt(q1), hiA: highAt(q0), hiB: highAt(q1), loLevel: Math.min(l0, l1), hiLevel: Math.max(l0, l1) };
            if (!cur || cur.n[0] !== n[0] || cur.n[1] !== n[1]) { cur = { pieces: [], n, e, constant: true }; runs.push(cur); }
            // A run is CONSTANT (a candidate for stairs / drains) when every piece has the same low + high height.
            const ref = cur.pieces[0] ?? piece, same = (u: number, v: number): boolean => Math.abs(u - v) < 1e-6;
            if (!same(piece.loA, ref.loA) || !same(piece.loB, ref.loA) || !same(piece.hiA, ref.hiA) || !same(piece.hiB, ref.hiA)) cur.constant = false;
            cur.pieces.push(piece);
        }
    };
    for (let c = 0; c <= cols; c++) for (const sg of [-1, 1]) {
        const x = -R + c * cw + sg * band;
        if (x <= -R + 1e-6 || x >= R - 1e-6) continue;
        scan([x, -R], [x, R], [0, 1], [1, 0]);
    }
    for (let r = 0; r <= rows; r++) for (const sg of [-1, 1]) {
        const z = -R + r * ch + sg * band;
        if (z <= -R + 1e-6 || z >= R - 1e-6) continue;
        scan([-R, z], [R, z], [1, 0], [0, 1]);
    }

    // 2) Build each run: stairs first (they claim a landing gap in the wall), then the wall + dressing.
    const wall = new Accum3D(), cap = new Accum3D(), stain = new Accum3D(), wet = new Accum3D(), drain = new Accum3D();
    const stair = new Accum3D(), rail = new Accum3D(), fenceRail = new Accum3D(), mesh = new Accum3D();
    const nosing = new Accum3D(), nosingY = new Accum3D(), sideWall = new Accum3D();
    const waterY = canalWaterY(p) - gy;
    const m = 1 / cityMetresPerUnit(R);
    // E2 EDGE WEAR: with a level set, the coping + step surfaces are built TWICE — the clean far twin (exactly the
    // wear-off build) and a chipped near twin with its worn-edge layer — see LayoutPreviewLayer.nearTwin.
    const chipSpec = edgeChipSpec(p.edgeWear, m, 0x7e1);
    const variants: SurfVariant[] = [{ stair, stairWear: null, cap, capWear: null, spec: null }];
    if (chipSpec) {
        // Steps: shallower top-face chips (the anti-slip strip sits 2.5 cm behind the nosing).
        const stepSpec: ChipSpec = { ...chipSpec, notchDepth: Math.min(chipSpec.notchDepth, 0.009 * m), biteDepth: Math.min(chipSpec.biteDepth, 0.014 * m), wearBand: Math.min(chipSpec.wearBand, 0.014 * m), seed: 0x51e };
        variants.push({ stair: new Accum3D(), stairWear: new Accum3D(), cap: new Accum3D(), capWear: new Accum3D(), spec: chipSpec, stepSpec });
    }
    const thick = 0.3 * m, copH = 0.08 * m, over = 0.03 * m;
    const fenceH = 1.1 * m, postR = 0.025 * m, postGap = 2 * m;
    for (const run of runs) {
        const gaps = run.constant ? stairsFor(run, variants, { wall: sideWall, rail, nosing, nosingY }, gy, m, step, (x, z) => t.pave.test(x, z)) : [];
        if (gaps.length) run.pieces = splitRun(run, gaps.flat());
        const open = (u: V2): boolean => gaps.some(([g0, g1]) => {
            const d = (u[0] - run.pieces[0].a[0]) * run.e[0] + (u[1] - run.pieces[0].a[1]) * run.e[1];
            return d > g0 + 1e-9 && d < g1 - 1e-9;
        });
        for (const pc of run.pieces) {
            const mid: V2 = [(pc.a[0] + pc.b[0]) * 0.5, (pc.a[1] + pc.b[1]) * 0.5];
            if (open(mid)) continue;
            const n = run.n, A = pc.a, B = pc.b;
            const h = Math.max(pc.hiA - pc.loA, pc.hiB - pc.loB);
            // FACE (toward the low side), from just below the low ground up to the high ground.
            face(wall, [A[0], gy + pc.loA - 0.006 * s, A[1]], [B[0], gy + pc.loB - 0.006 * s, B[1]], [B[0], gy + pc.hiB, B[1]], [A[0], gy + pc.hiA, A[1]], n);
            // COPING: a lighter slab capping the wall, overhanging the face a little and running back into the terrace.
            const fA: V2 = [A[0] + n[0] * over, A[1] + n[1] * over], fB: V2 = [B[0] + n[0] * over, B[1] + n[1] * over];
            const bA: V2 = [A[0] - n[0] * thick, A[1] - n[1] * thick], bB: V2 = [B[0] - n[0] * thick, B[1] - n[1] * thick];
            const ctA = gy + pc.hiA + copH, ctB = gy + pc.hiB + copH, cbA = gy + pc.hiA - copH, cbB = gy + pc.hiB - copH;
            for (const vr of variants) {
                if (!vr.spec) {   // the clean coping (also the far twin): three quads, exactly the wear-off build
                    face(vr.cap, [fA[0], cbA, fA[1]], [fB[0], cbB, fB[1]], [fB[0], ctB, fB[1]], [fA[0], ctA, fA[1]], n);
                    face(vr.cap, [bA[0], gy + pc.hiA, bA[1]], [bB[0], gy + pc.hiB, bB[1]], [bB[0], ctB, bB[1]], [bA[0], ctA, bA[1]], [-n[0], -n[1]]);
                    vr.cap.quad4([fA[0], ctA, fA[1]], [fB[0], ctB, fB[1]], [bB[0], ctB, bB[1]], [bA[0], ctA, bA[1]]);
                    continue;
                }
                // E2 near twin: the coping as a chipped bar (both top arrises chip; corner chips only where the wall
                // really ends — a stair gap or the run's end).
                const i = run.pieces.indexOf(pc);
                const startEnd = i === 0 || open([(run.pieces[i - 1].a[0] + run.pieces[i - 1].b[0]) * 0.5, (run.pieces[i - 1].a[1] + run.pieces[i - 1].b[1]) * 0.5]);
                const endEnd = i === run.pieces.length - 1 || open([(run.pieces[i + 1].a[0] + run.pieces[i + 1].b[0]) * 0.5, (run.pieces[i + 1].a[1] + run.pieces[i + 1].b[1]) * 0.5]);
                copingBar(vr, [A[0], gy + pc.hiA, A[1]], [B[0], gy + pc.hiB, B[1]], n, thick, over, copH, [startEnd, endEnd]);
            }
            // FOOT: a canal wall gets a dark wet band at the waterline; a street wall a damp stain along its foot.
            const off: V2 = [n[0] * 0.015 * m, n[1] * 0.015 * m];   // 1.5 cm proud of the face (no z-fight)
            if (pc.loLevel < 0) {
                const w0 = Math.max(pc.loA, waterY - 0.1 * m), w1 = Math.min(Math.min(pc.hiA, pc.hiB) - copH, waterY + 0.35 * m);
                if (w1 > w0) face(wet, [A[0] + off[0], gy + w0, A[1] + off[1]], [B[0] + off[0], gy + w0, B[1] + off[1]], [B[0] + off[0], gy + w1, B[1] + off[1]], [A[0] + off[0], gy + w1, A[1] + off[1]], n);
            } else if (h > 0.4 * m) {
                const sh = (lo: number, hi: number): number => lo + Math.min(0.45 * m, (hi - lo) * 0.3);
                face(stain, [A[0] + off[0], gy + pc.loA, A[1] + off[1]], [B[0] + off[0], gy + pc.loB, B[1] + off[1]],
                    [B[0] + off[0], gy + sh(pc.loB, pc.hiB), B[1] + off[1]], [A[0] + off[0], gy + sh(pc.loA, pc.hiA), A[1] + off[1]], n);
            }
        }
        // Run END caps (the wall's thickness shows where it stops at a gap or a corner).
        const ends: [WallPiece, V2, number, number, number][] = [];
        for (let i = 0; i < run.pieces.length; i++) {
            const pc = run.pieces[i];
            const mid: V2 = [(pc.a[0] + pc.b[0]) * 0.5, (pc.a[1] + pc.b[1]) * 0.5];
            if (open(mid)) continue;
            const prevOpen = i === 0 || open([(run.pieces[i - 1].a[0] + run.pieces[i - 1].b[0]) * 0.5, (run.pieces[i - 1].a[1] + run.pieces[i - 1].b[1]) * 0.5]);
            const nextOpen = i === run.pieces.length - 1 || open([(run.pieces[i + 1].a[0] + run.pieces[i + 1].b[0]) * 0.5, (run.pieces[i + 1].a[1] + run.pieces[i + 1].b[1]) * 0.5]);
            if (prevOpen) ends.push([pc, pc.a, pc.loA, pc.hiA, -1]);
            if (nextOpen) ends.push([pc, pc.b, pc.loB, pc.hiB, 1]);
        }
        for (const [, P, lo, hi, dir] of ends) {
            if (hi - lo < 1e-4) continue;
            // The end face shows the wall's thickness; it faces out of the run (−e at the start, +e at the end).
            const n = run.n, Q: V2 = [P[0] - n[0] * thick, P[1] - n[1] * thick];
            for (const vr of variants) face(vr.cap, [P[0], gy + lo, P[1]], [Q[0], gy + lo, Q[1]], [Q[0], gy + hi, Q[1]], [P[0], gy + hi, P[1]], [run.e[0] * dir, run.e[1] * dir]);
        }
        // Weep-hole DRAINS (constant runs only — a ramp wall tapers to nothing) + the chain-link FENCE on top.
        let dist = 0;
        const total = run.pieces.reduce((acc, pc) => acc + Math.hypot(pc.b[0] - pc.a[0], pc.b[1] - pc.a[1]), 0);
        const nPosts = Math.max(1, Math.round(total / postGap));
        const post = total / nPosts;
        let nextPost = 0, nextDrain = 1.2 * m;
        let prevTop: V3 | null = null;
        for (const pc of run.pieces) {
            const L = Math.hypot(pc.b[0] - pc.a[0], pc.b[1] - pc.a[1]);
            const at = (d: number): { P: V2; lo: number; hi: number } => {
                const u = L > 0 ? (d - dist) / L : 0;
                return { P: [pc.a[0] + (pc.b[0] - pc.a[0]) * u, pc.a[1] + (pc.b[1] - pc.a[1]) * u], lo: pc.loA + (pc.loB - pc.loA) * u, hi: pc.hiA + (pc.hiB - pc.hiA) * u };
            };
            while (nextPost <= dist + L + 1e-9) {
                const q = at(nextPost);
                const set: V2 = [q.P[0] - run.n[0] * thick * 0.5, q.P[1] - run.n[1] * thick * 0.5];
                const tall = q.hi - q.lo > 0.5 * m;
                if (tall && !open(q.P)) {
                    const base: V3 = [set[0], gy + q.hi + copH, set[1]];
                    fenceRail.prism(base, postR, postR, fenceH - copH, 4);
                    const top: V3 = [set[0], gy + q.hi + fenceH, set[1]];
                    if (prevTop) {
                        fenceRail.beam(prevTop, top, postR * 0.8, 4);
                        // Chain-link panel between the posts (see-through pattern layer).
                        const lowP: V3 = [prevTop[0], prevTop[1] - fenceH + copH + 0.05 * m, prevTop[2]], lowQ: V3 = [top[0], top[1] - fenceH + copH + 0.05 * m, top[2]];
                        mesh.quad4(lowP, lowQ, [top[0], top[1] - 0.03 * m, top[2]], [prevTop[0], prevTop[1] - 0.03 * m, prevTop[2]]);
                    }
                    prevTop = top;
                } else prevTop = null;
                nextPost += post;
            }
            if (run.constant) while (nextDrain <= dist + L - 0.3 * m) {
                const q = at(nextDrain);
                if (q.hi - q.lo > 1.0 * m && !open(q.P) && pc.loLevel >= 0) {
                    const y = gy + q.lo + Math.min(0.5 * m, (q.hi - q.lo) * 0.3);
                    drain.beam([q.P[0] - run.n[0] * 0.02 * m, y, q.P[1] - run.n[1] * 0.02 * m], [q.P[0] + run.n[0] * 0.12 * m, y, q.P[1] + run.n[1] * 0.12 * m], 0.05 * m, 6);
                }
                nextDrain += 2.5 * m;
            }
            dist += L;
        }
    }

    const metalScale = metalScaleFor(p.radius);   // cycles per WORLD UNIT (the city is a diorama)
    const layers: LayoutPreviewLayer[] = [];
    const L = (name: string, color: [number, number, number], acc: Accum3D, extra: Partial<LayoutPreviewLayer> = {}): void => {
        if (!acc.empty) layers.push({ name, color, y: gy, geometry: acc.geometry(), drape: 'smooth', ...extra });
    };
    const wallPattern: LayoutPreviewLayer['pattern'] = { color: [0.44, 0.42, 0.40], freq: 18, scale: 0.09, mode: 'grid' };   // masonry courses (quad4 UVs)
    L('world:retaining', WALL, wall, { pattern: wallPattern });
    L('world:stair-wall', WALL, sideWall, { pattern: wallPattern });   // B6: the stair's side wall = the retaining wall's material
    const twinD = EDGE_CHIP_NEAR_M * m;
    const far = (key: string): Partial<LayoutPreviewLayer> => chipSpec ? { nearTwin: { key, role: 'far', dist: twinD } } : {};
    const near = (key: string): Partial<LayoutPreviewLayer> => ({ nearTwin: { key, role: 'near', dist: twinD } });
    const capPattern = (k: number): LayoutPreviewLayer['pattern'] => ({ color: [CAP[0] * 0.8 * k, CAP[1] * 0.8 * k, CAP[2] * 0.8 * k], freq: 15, scale: 0.08, mode: 'grid' });
    L('world:retaining-cap', CAP, cap, { pattern: capPattern(1), ...far('terr-cap') });   // slab joints
    L('world:retaining-stain', STAIN, stain);
    L('world:retaining-drain', DRAIN, drain);
    L('world:canal-wet', WET, wet);
    L('world:retaining-rail', RAIL, fenceRail, { metal: { ...METAL_PAINTED, scale: metalScale } });
    L('world:retaining-fence', MESH, mesh, { pattern: { color: [0.30, 0.32, 0.31], freq: 60, scale: 0.35, mode: 'diamonds' }, opacity: 0.55 });
    // B6: the steps get their OWN surface — granite, one slab per step (each step's UVs sit in their own tile, so the
    // ashlar tiler's per-tile tone varies step to step and no joint ever crosses a tread), a contrasting nosing strip
    // with fine anti-slip grooves (the stripes run along the width), and the side wall in the retaining wall's own
    // material. Was the wall's masonry grid at wall scale on every face: a pile of small misaligned cubes.
    const mpu = cityMetresPerUnit(R);
    const stepGround = (tint: [number, number, number]): LayoutPreviewLayer['ground'] => ({ surface: 'granite', tint, tileMm: STAIR_TILE_M * 1000, jitter: 0.9, weather: 'worn', metersPerUnit: mpu });
    L('world:stairs', STEP, stair, { ground: stepGround(STEP), ...far('terr-step') });
    const groove = 1 / (0.011 * m);   // ~1.1 cm groove pitch across the strip (cycles per world unit)
    L('world:stair-nosing', NOSING, nosing, { pattern: { color: [0.07, 0.07, 0.075], freq: groove, scale: 0.35, mode: 'stripes' } });
    L('world:stair-nosing', NOSING_Y, nosingY, { pattern: { color: [0.52, 0.40, 0.07], freq: groove, scale: 0.35, mode: 'stripes' } });
    L('world:stair-rail', RAIL, rail, { metal: { ...METAL_PAINTED, scale: metalScale } });
    if (chipSpec) {
        const vr = variants[1], WEAR = 1.09;   // the worn / freshly broken stone reads a touch lighter
        const lift = (c: [number, number, number]): [number, number, number] => [Math.min(1, c[0] * WEAR), Math.min(1, c[1] * WEAR), Math.min(1, c[2] * WEAR)];
        L('world:retaining-cap', CAP, vr.cap, { pattern: capPattern(1), ...near('terr-cap') });
        L('world:retaining-cap-wear', lift(CAP), vr.capWear!, { pattern: capPattern(WEAR), ...near('terr-cap') });
        L('world:stairs', STEP, vr.stair, { ground: stepGround(STEP), ...near('terr-step') });
        L('world:stairs-wear', lift(STEP), vr.stairWear!, { ground: stepGround(lift(STEP)), ...near('terr-step') });
    }
    return layers;
}

/** Split a run's pieces at the given run distances (so a stair landing gap has exact wall ends). */
function splitRun(run: WallRun, at: number[]): WallPiece[] {
    const out: WallPiece[] = [];
    let dist = 0;
    for (const pc of run.pieces) {
        const L = Math.hypot(pc.b[0] - pc.a[0], pc.b[1] - pc.a[1]);
        const cuts = at.filter(d => d > dist + 1e-9 && d < dist + L - 1e-9).map(d => (d - dist) / L).sort((x, y) => x - y);
        const us = [0, ...cuts, 1];
        for (let k = 0; k + 1 < us.length; k++) {
            const u0 = us[k], u1 = us[k + 1];
            const P = (u: number): V2 => [pc.a[0] + (pc.b[0] - pc.a[0]) * u, pc.a[1] + (pc.b[1] - pc.a[1]) * u];
            out.push({ ...pc, a: P(u0), b: P(u1), loA: pc.loA + (pc.loB - pc.loA) * u0, loB: pc.loA + (pc.loB - pc.loA) * u1, hiA: pc.hiA + (pc.hiB - pc.hiA) * u0, hiB: pc.hiA + (pc.hiB - pc.hiA) * u1 });
        }
        dist += L;
    }
    return out;
}

/** A vertical quad a→b (bottom) → c (above b), d (above a) whose normal faces `n` (layout plane). */
function face(acc: Accum3D, a: V3, b: V3, c: V3, d: V3, n: V2): void {
    // quad4's normal is (b−a)×(d−a) = the LEFT perpendicular of a→b; flip the winding when that is not `n`.
    const ex = b[0] - a[0], ez = b[2] - a[2];
    if (-ez * n[0] + ex * n[1] >= 0) acc.quad4(a, b, c, d);
    else acc.quad4(b, a, d, c);
}

/** One build of the step + coping surfaces: the clean one (spec null — also the far twin) or the E2 chipped near
 *  twin (spec set; chamfers + worn bands go to the `*Wear` accumulators). */
interface SurfVariant { stair: Accum3D; stairWear: Accum3D | null; cap: Accum3D; capWear: Accum3D | null; spec: ChipSpec | null; stepSpec?: ChipSpec }

/** A coping bar from a→b (baked 3D ends on the wall line, heights = the high ground there) as a chipped closed
 *  profile: `over` proud of the face (toward `n`), `thick` back into the terrace, ±copH about the top line. */
function copingBar(vr: SurfVariant, a: V3, b: V3, n: V2, thick: number, over: number, copH: number, ends: [boolean, boolean]): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
    if (L < 1e-9) return;
    const along: V3 = [d[0] / L, d[1] / L, d[2] / L];
    // Profile in (ua = n, va = up), CCW: back-bottom → front-bottom → front-top → back-top.
    const prof: V2[] = [[-thick, -copH], [over, -copH], [over, copH], [-thick, copH]];
    // v0 lines the front face's v up with the clean quads' (0 at its bottom) so the slab joints do not jump.
    chipExtrude(vr.cap, a, along, [n[0], 0, n[1]], [0, 1, 0], L, prof, { closed: true, chip: [false, false, true, false], spec: vr.spec,
        wear: vr.capWear, v0: -(thick + over), caps: ends, endChips: ends });
}

/** The STAIR geometry for one constant wall run (the dimensions are real metres via `m`). Returns the run
 *  distance range the top landing occupies (the wall, coping and fence stay open there). */
export const STAIR = { riseM: 0.18, treadM: 0.285, widthM: 1.1, handrailM: 1.1, handrailThickM: 0.05, postGapM: 1.5 } as const;
/** B6: the granite tile size (m) each step's UVs are placed inside (a whole step, tread + riser, fits in one). */
const STAIR_TILE_M = 2.4;   // big, and each face CENTRED in its tile: the tiler's joint jitter never reaches a face

function stairsFor(run: WallRun, variants: SurfVariant[], out: { wall: Accum3D; rail: Accum3D; nosing: Accum3D; nosingY: Accum3D },
    gy: number, m: number, step: number, onPavement: (x: number, z: number) => boolean): [number, number][] {
    const p0 = run.pieces[0], lo = p0.loA, hi = p0.hiA, drop = hi - lo;
    if (p0.loLevel < 0 || drop < step * 0.5) return [];
    const a0 = p0.a, e = run.e, n = run.n;
    const total = run.pieces.reduce((acc, pc) => acc + Math.hypot(pc.b[0] - pc.a[0], pc.b[1] - pc.a[1]), 0);
    if (hash2(Math.round(a0[0] * 97), Math.round(a0[1] * 89), 0x57a1) >= 0.5) return [];
    const nSteps = Math.max(2, Math.round(drop / (STAIR.riseM * m))), rise = drop / nSteps;
    const tread = STAIR.treadM * m, W = STAIR.widthM * m, flight = nSteps * tread, margin = 1.5 * m;
    const need = flight + W + 2 * margin;
    if (total < need) return [];
    const asc = hash2(Math.round(a0[0] * 31), Math.round(a0[1] * 37), 0x2f1d) < 0.5 ? 1 : -1;
    const start = (total - need) * 0.5 + margin;                 // run distance where the structure begins
    // Run distance of ascent coordinate `a` (0 = the flight's foot).
    const dAt = (a: number): number => asc > 0 ? start + a : start + flight + W - a;
    const pt = (d: number, w: number): V2 => [a0[0] + e[0] * d + n[0] * w, a0[1] + e[1] * d + n[1] * w];
    // The flight lands on the PAVEMENT: skip walls whose low side is a park edge, the shotengai or anything else.
    const sw0 = 0.12 * m;
    for (const a of [0, flight * 0.5, flight + W]) for (const w of [0.02 * m, W + sw0]) {
        const q = pt(dAt(a), w);
        if (!onPavement(q[0], q[1])) return [];
    }
    // World point at ascent a, width w (0 = the wall face … W = the open side), height y above groundY.
    const P = (a: number, w: number, y: number): V3 => { const q = pt(dAt(a), w); return [q[0], gy + y, q[1]]; };
    const up: V3 = [0, 1, 0], nW: V3 = [n[0], 0, n[1]], ascW: V3 = [e[0] * asc, 0, e[1] * asc];
    const foot = 0.06 * m;                                        // the first riser runs a little below grade (no gap)
    const tile = STAIR_TILE_M * m;
    const nos = hash2(Math.round(a0[0] * 53), Math.round(a0[1] * 59), 0x0751) < 0.35 ? out.nosingY : out.nosing;
    // B6 STEPS: each step is ONE open profile — its tread (back → nosing) and its riser (nosing → the tread below) —
    // extruded across the flight's width. Only faces that can be seen are built: the inner side sits against the wall
    // face, the outer side behind the stringer, the backs under the next step. Each step's UVs sit in their own granite
    // tile (u across the width, v tread → riser), so the tile's tone changes step to step and no joint crosses a face.
    for (let i = 0; i < nSteps; i++) {
        const yT = lo + (i + 1) * rise, yB = i === 0 ? lo - foot : lo + i * rise;
        const o = P(i * tread, 0, yT);
        const prof: V2[] = [[tread, 0], [0, 0], [0, -(yT - yB)]];
        for (const vr of variants) chipExtrude(vr.stair, o, nW, ascW, up, W, prof, { chip: [false, true, false], spec: vr.stepSpec ?? null,
            wear: vr.stairWear, u0: 2 * i * tile + (tile - W) * 0.5, v0: (tile - tread - (yT - yB)) * 0.5, endChips: [false, false] });
        // NOSING: a dark (or yellow) anti-slip strip set 2.5 cm behind the front edge, 4 cm deep, 3 mm proud.
        // Top + front lip only (4 tris; the 3 mm ends and back never show). UVs in world units, u = depth → the stripes
        // (lines of constant u) run along the width.
        const n0 = i * tread + 0.025 * m, n1 = n0 + 0.04 * m, w0 = 0.03 * m, w1 = W - 0.03 * m, yN = yT + 0.003 * m, dN = n1 - n0, wN = w1 - w0;
        const quadUp = (a: V3, b: V3, c: V3, d: V3, ua: V2, ub: V2, uc: V2, ud: V2): void => {   // wind so the normal is up / out
            const nb = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
            if (nb >= 0) nos.quadUV4(a, b, c, d, ua, ub, uc, ud); else nos.quadUV4(b, a, d, c, ub, ua, ud, uc);
        };
        quadUp(P(n0, w0, yN), P(n1, w0, yN), P(n1, w1, yN), P(n0, w1, yN), [0, 0], [dN, 0], [dN, wN], [0, wN]);
        face(nos, P(n0, w0, yT), P(n0, w1, yT), P(n0, w1, yN), P(n0, w0, yN), [-ascW[0], -ascW[2]]);
    }
    // TOP LANDING: one flat slab at the terrace level, in its own tile.
    for (const vr of variants) {
        const la = P(flight, 0, hi), lb = P(flight, W, hi), lc = P(flight + W, W, hi), ld = P(flight + W, 0, hi);
        const u0 = 2 * nSteps * tile + (tile - W) * 0.5, v0 = (tile - W) * 0.5;
        const up0 = (lb[2] - la[2]) * (ld[0] - la[0]) - (lb[0] - la[0]) * (ld[2] - la[2]);   // y of (b−a)×(d−a)
        if (up0 >= 0) vr.stair.quadUV4(la, lb, lc, ld, [u0, v0], [u0 + W, v0], [u0 + W, v0 + W], [u0, v0 + W]);
        else vr.stair.quadUV4(la, ld, lc, lb, [u0, v0], [u0, v0 + W], [u0 + W, v0 + W], [u0 + W, v0]);
    }
    // SIDE WALL (stringer) along the open side: ONE plain panel in the retaining wall's material, its top 10 cm above
    // the NOSING LINE (the line through the step fronts — was one riser lower, so the lowest treads poked out), flat
    // along the last tread + landing, with a coping on top (chipped like the wall copings in the near twin).
    const sw = 0.12 * m, above = 0.1 * m, slope = rise / tread;
    const topY = (a: number): number => Math.min(hi, lo + rise + a * slope) + above;
    const bot = lo - foot, aFlat = (nSteps - 1) * tread, aEnd = flight + W + sw;
    const wIn = W, wOut = W + sw;
    const knots = [0, aFlat, aEnd];
    const cop = 0.05 * m, cIn = W - 0.02 * m, cOut = W + sw + 0.02 * m;
    for (let k = 0; k + 1 < knots.length; k++) {
        const aA = knots[k], aB = knots[k + 1];
        face(out.wall, P(aA, wOut, bot), P(aB, wOut, bot), P(aB, wOut, topY(aB)), P(aA, wOut, topY(aA)), n);
        face(out.wall, P(aA, wIn, bot), P(aB, wIn, bot), P(aB, wIn, topY(aB)), P(aA, wIn, topY(aA)), [-n[0], -n[1]]);
        for (const vr of variants) {
            if (!vr.spec) {   // clean coping: top + both sides + the two ends (a slope change shows a joint)
                const tA = topY(aA) + cop, tB = topY(aB) + cop, bA = topY(aA) - cop, bB = topY(aB) - cop;
                const q = [P(aA, cOut, tA), P(aB, cOut, tB), P(aB, cIn, tB), P(aA, cIn, tA)];
                const upY = (q[1][2] - q[0][2]) * (q[3][0] - q[0][0]) - (q[1][0] - q[0][0]) * (q[3][2] - q[0][2]);
                if (upY >= 0) vr.cap.quad4(q[0], q[1], q[2], q[3]); else vr.cap.quad4(q[1], q[0], q[3], q[2]);
                face(vr.cap, P(aA, cOut, bA), P(aB, cOut, bB), P(aB, cOut, tB), P(aA, cOut, tA), n);
                face(vr.cap, P(aA, cIn, bA), P(aB, cIn, bB), P(aB, cIn, tB), P(aA, cIn, tA), [-n[0], -n[1]]);
                face(vr.cap, P(aA, cIn, bA), P(aA, cOut, bA), P(aA, cOut, tA), P(aA, cIn, tA), [-ascW[0], -ascW[2]]);
                face(vr.cap, P(aB, cIn, bB), P(aB, cOut, bB), P(aB, cOut, tB), P(aB, cIn, tB), [ascW[0], ascW[2]]);
            } else {
                const ca = P(aA, cIn, topY(aA)), cb = P(aB, cIn, topY(aB));
                const d: V3 = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]], L = Math.hypot(d[0], d[1], d[2]);
                const prof: V2[] = [[0, -cop], [cOut - cIn, -cop], [cOut - cIn, cop], [0, cop]];
                chipExtrude(vr.cap, ca, [d[0] / L, d[1] / L, d[2] / L], nW, up, L, prof, { closed: true, chip: [false, false, true, true], spec: vr.spec, wear: vr.capWear });
            }
        }
    }
    face(out.wall, P(0, wIn, bot), P(0, wOut, bot), P(0, wOut, topY(0)), P(0, wIn, topY(0)), [-ascW[0], -ascW[2]]);   // the foot end
    // The landing's far end: a wall across the landing (wall line to the stringer), in the wall material.
    out.wall.obox(P(flight + W + sw * 0.5, (W + sw) * 0.5 - sw * 0.5, (hi + above + lo - foot) * 0.5), ascW, up, nW,
        sw * 0.5, (hi + above - lo + foot) * 0.5, (W + sw) * 0.5 + sw * 0.5);
    // HANDRAIL: posts every ~1.5 m along the open side, a 5 cm rail 1.1 m above the nosing line / landing.
    const r = STAIR.handrailThickM * 0.5 * m, hR = STAIR.handrailM * m, inset = W - 0.08 * m;
    const len = flight + W, nP = Math.max(2, Math.round(len / (STAIR.postGapM * m)) + 1);
    const stepTop = (a: number): number => a >= flight ? hi : lo + (Math.min(nSteps - 1, Math.floor(a / tread)) + 1) * rise;
    let prev: V3 | null = null;
    for (let k = 0; k < nP; k++) {
        const a = (k / (nP - 1)) * len;
        const railY = Math.min(hi, lo + rise + a * slope) + hR;
        const base = P(a, inset, stepTop(a)), topP = P(a, inset, railY);
        out.rail.prism(base, r, r, railY - stepTop(a), 4);
        if (prev) out.rail.beam(prev, topP, r, 4);
        prev = topP;
    }
    // The wall/coping/fence stay open over the landing so you can walk off it onto the terrace.
    const g0 = Math.min(dAt(flight), dAt(flight + W)), g1 = Math.max(dAt(flight), dAt(flight + W));
    return [[g0, g1]];
}
