// ── World generation — stylized ROCKS (park / pond-side / apron) ─────────────────────────────────────────────────
// The city's rocks used to be one jittered OCTAHEDRON each (Accum3D.blob: 6 verts, 8 tris, radial normals), merged
// into a single flat-grey layer and set ON the grass with their widest point at ground level — so they read as
// floating primitive placeholders. This module replaces them with a small, fixed, SEEDED pool of real rock
// archetypes, GPU-instanced like the trees:
//   · SHAPE — a geodesic icosphere deformed by 3-octave value noise (irregular mass), squashed (wider than tall),
//     with 2–4 random PLANAR CUTS (vertices past a plane are pulled onto it) so they get the flat fractured faces of
//     real stone instead of reading as blobs. Archetypes: boulder · flat slab · fused cluster (2–3 stones) · pebbles.
//   · SHADING — smooth normals across the big forms, SPLIT where the dihedral angle is over ~40° (so the cut faces
//     keep a crisp edge), a per-archetype hue (warm / cool / neutral grey), and on most archetypes a MOSS cap: the
//     upward-facing faces go to a second, green layer. The contact darkening is the shared foliage BASE AO + ground
//     blend (foliageShade; the ramp's denominator is the rock's height), so no new shader.
//   · GROUNDING — every archetype is built with its local origin ON the ground line and 15–30 % of its height BELOW
//     it (sunk, never floating), a small baked tilt, and the faces that end up fully underground are dropped.
//   · PLACEMENT — rockCluster(): one big stone plus a few small ones around it, sizes on a power law; the biome
//     prefers pond edges.
// Layer names keep the `world:rocks` / `world:apron-rocks` PREFIX (`world:rocks-<variant>[-moss]`), so the distance
// tier (PROPS_LOD), camera-occluder and collision rules — all prefix regexes — classify them as before.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { LayoutPreviewLayer, InstanceXform } from './types';
import { Accum3D } from './meshbuild';
import { makeRng, type Rng } from './util';

type V3 = [number, number, number];

export type RockKind = 'boulder' | 'slab' | 'cluster' | 'pebbles';

/** One archetype of the pool. Geometry is CANONICAL: metres, footprint ~1 m across (instance scale = size in
 *  metres x units-per-metre), origin on the ground line, +Y up. `moss` is null for bare archetypes. */
export interface RockVariant {
    id: string;
    kind: RockKind;
    tone: [number, number, number];
    stone: MeshGeometry;
    moss: MeshGeometry | null;
    /** Height above the ground line (canonical metres, footprint = 1). */
    height: number;
    /** Depth below the ground line (canonical metres, > 0). */
    sink: number;
    /** Triangles of stone + moss. */
    tris: number;
}

/** A placed rock: world position (on the ground; the drape lifts it onto the terrain), yaw, footprint size in
 *  METRES, and the variant index into rockVariants(). */
export interface RockPlacement { x: number; y: number; z: number; ry: number; size: number; v: number }

// Stone tones (stylized, not photoreal): warm grey, cool grey, neutral, a darker blue-grey. Moss = soft sage.
const WARM: [number, number, number] = [0.60, 0.56, 0.51];
const COOL: [number, number, number] = [0.52, 0.55, 0.59];
const NEUTRAL: [number, number, number] = [0.57, 0.57, 0.56];
const DARK: [number, number, number] = [0.45, 0.47, 0.50];
export const ROCK_MOSS_COLOR: [number, number, number] = [0.42, 0.52, 0.31];
/** The ground the base AO bleeds toward (park / meadow grass). */
const GRASS_TINT: [number, number, number] = [0.34, 0.45, 0.25];

// ── Geometry helpers ──────────────────────────────────────────────────────────────────────────────────────────
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A geodesic icosphere: each icosahedron face split `freq` times along every edge (20·freq² triangles). Shared
 *  vertices are welded so the deformation stays watertight. */
function geodesic(freq: number): { P: V3[]; F: [number, number, number][] } {
    const t = (1 + Math.sqrt(5)) / 2;
    const B: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v => norm(v as V3));
    const IF = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P: V3[] = [], F: [number, number, number][] = [], weld = new Map<string, number>();
    const idx = (p: V3): number => {
        const q = norm(p), k = `${Math.round(q[0] * 1e5)},${Math.round(q[1] * 1e5)},${Math.round(q[2] * 1e5)}`;
        let i = weld.get(k);
        if (i === undefined) { i = P.length; P.push(q); weld.set(k, i); }
        return i;
    };
    for (const [a, b, c] of IF) {
        const A = B[a], AB = sub(B[b], A), AC = sub(B[c], A);
        const at = (i: number, j: number): number => idx([A[0] + (AB[0] * i + AC[0] * j) / freq, A[1] + (AB[1] * i + AC[1] * j) / freq, A[2] + (AB[2] * i + AC[2] * j) / freq]);
        for (let i = 0; i < freq; i++) for (let j = 0; i + j < freq; j++) {
            F.push([at(i, j), at(i + 1, j), at(i, j + 1)]);
            if (i + j < freq - 1) F.push([at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
    }
    // Outward winding regardless of the table's convention (centroid · normal > 0 on a sphere about the origin).
    for (const f of F) {
        const n = cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]]));
        if (dot(n, P[f[0]]) < 0) { const s = f[1]; f[1] = f[2]; f[2] = s; }
    }
    return { P, F };
}

/** Integer-lattice hash → [0, 1). */
function hash3(x: number, y: number, z: number, s: number): number {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(s | 0, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth 3D value noise in [0, 1). */
function vnoise3(x: number, y: number, z: number, s: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const L = (a: number, b: number, k: number): number => a + (b - a) * k;
    const c = (i: number, j: number, k: number): number => hash3(xi + i, yi + j, zi + k, s);
    return L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
        L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
/** 3-octave fbm, centred on 0 (≈ −0.5..0.5). */
function fbm3(p: V3, s: number): number {
    let a = 0, amp = 0.55, f = 1, tot = 0;
    for (let o = 0; o < 3; o++) { a += amp * vnoise3(p[0] * f, p[1] * f, p[2] * f, s + o * 101); tot += amp; amp *= 0.5; f *= 2.1; }
    return a / tot - 0.5;
}

/** Shape parameters for one stone. */
interface StoneSpec {
    freq: number;          // geodesic frequency (1 = icosahedron, 20 tris; 2 = 80; 3 = 180)
    rx: number; ry: number; rz: number;   // half-extents before normalisation
    noise: number;         // radial noise amplitude (fraction of radius)
    cuts: number;          // planar fracture cuts
    flatTop?: number;      // > 0 = an extra near-horizontal cut that far below the top (slabs)
    sink: number;          // fraction of the height below ground
    tilt: number;          // max baked tilt (radians)
    offset?: V3;           // placement inside a fused cluster (pre-normalisation units)
}

/** Deformed, cut, tilted stone points + faces (not yet grounded). */
function stonePoints(spec: StoneSpec, rng: Rng): { P: V3[]; F: [number, number, number][] } {
    const { P: S, F } = geodesic(spec.freq);
    const ns = Math.floor(rng.next() * 1e6), off: V3 = [rng.next() * 50, rng.next() * 50, rng.next() * 50];
    const P = S.map((d): V3 => {
        const r = 1 + spec.noise * 2 * fbm3([d[0] * 1.3 + off[0], d[1] * 1.3 + off[1], d[2] * 1.3 + off[2]], ns);
        return [d[0] * r * spec.rx, d[1] * r * spec.ry, d[2] * r * spec.rz];
    });
    // PLANAR CUTS: a random plane at 70–88 % of the support in its direction; everything beyond it is pulled (almost)
    // onto it → a flat fractured face with a crisp rim. Normals bias to the sides + top (the bottom is buried).
    const planes: { n: V3; k: number }[] = [];
    for (let c = 0; c < spec.cuts; c++) {
        const a = rng.next() * Math.PI * 2, el = -0.15 + rng.next() * 0.95;
        planes.push({ n: norm([Math.cos(a), el, Math.sin(a)]), k: 0.62 + rng.next() * 0.2 });
    }
    if (spec.flatTop) planes.push({ n: norm([(rng.next() - 0.5) * 0.25, 1, (rng.next() - 0.5) * 0.25]), k: 1 - spec.flatTop });
    for (const pl of planes) {
        let sup = -Infinity;
        for (const p of P) sup = Math.max(sup, dot(p, pl.n));
        const d = sup * pl.k;
        for (const p of P) {
            const e = dot(p, pl.n) - d;
            if (e > 0) { const m = e * 0.97; p[0] -= pl.n[0] * m; p[1] -= pl.n[1] * m; p[2] -= pl.n[2] * m; }
        }
    }
    // Small baked tilt (about X then Z) + cluster offset.
    const tx = (rng.next() - 0.5) * 2 * spec.tilt, tz = (rng.next() - 0.5) * 2 * spec.tilt;
    const cx = Math.cos(tx), sx = Math.sin(tx), cz = Math.cos(tz), sz = Math.sin(tz), o = spec.offset ?? [0, 0, 0];
    for (const p of P) {
        const y1 = p[1] * cx - p[2] * sx, z1 = p[1] * sx + p[2] * cx;
        const x2 = p[0] * cz - y1 * sz, y2 = p[0] * sz + y1 * cz;
        p[0] = x2 + o[0]; p[1] = y2 + o[1]; p[2] = z1 + o[2];
    }
    return { P, F };
}

/** The split-normal threshold: faces meeting at more than this share no normal (a hard edge). */
const HARD_EDGE_COS = Math.cos((40 * Math.PI) / 180);

/**
 * Build one archetype from its stones: ground it (origin on the ground line, `sink` of its height below), drop the
 * fully-buried faces, normalise to a ~1 m footprint, then emit with split normals into a stone and a moss geometry.
 */
function buildVariant(id: string, kind: RockKind, tone: [number, number, number], specs: StoneSpec[], seed: number, mossy: boolean): RockVariant {
    const rng = makeRng(seed);
    const stones = specs.map(s => stonePoints(s, rng));
    // Ground EACH stone on its own: its lowest point + sink·(its height) is the ground line (y = 0), so every stone of
    // a cluster / pebble group is buried by its own 15–30 % — never floating, whatever its size.
    let top = 0, depth = 0, maxR = 0;
    const depths: number[] = [];
    stones.forEach((st, si) => {
        let lo = Infinity, hi = -Infinity;
        for (const p of st.P) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
        const g = lo + (hi - lo) * specs[si].sink;
        for (const p of st.P) { p[1] -= g; maxR = Math.max(maxR, Math.hypot(p[0], p[2])); }
        top = Math.max(top, hi - g); depth = Math.max(depth, g - lo); depths.push(g - lo);
    });
    const k = 0.5 / Math.max(maxR, 1e-6);   // footprint radius 0.5 → ~1 m across
    for (const st of stones) for (const p of st.P) { p[0] *= k; p[1] *= k; p[2] *= k; }
    const height = top * k, sink = depth * k;
    // Seeded moss patchiness (per face centroid).
    const mossSeed = Math.floor(rng.next() * 1e6);
    const stoneAcc = new Accum3D(), mossAcc = new Accum3D();
    stones.forEach((st, si) => {
        const { P, F: F0 } = st, dSi = depths[si] * k;
        // Drop faces that are entirely underground (with a margin below the ground line for sloped terrain).
        const F = F0.filter(f => Math.max(P[f[0]][1], P[f[1]][1], P[f[2]][1]) > -dSi * 0.12);
        const FN: V3[] = [], FA: number[] = [];
        for (const f of F) {
            const c = cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]]));
            const a = Math.hypot(c[0], c[1], c[2]);
            FN.push(a > 1e-12 ? [c[0] / a, c[1] / a, c[2] / a] : [0, 1, 0]); FA.push(a);
        }
        const adj: number[][] = P.map(() => []);
        F.forEach((f, fi) => { adj[f[0]].push(fi); adj[f[1]].push(fi); adj[f[2]].push(fi); });
        // Per-face moss decision: upward-facing + a noise patch, and only above the ground band.
        const isMoss = F.map((f, fi) => {
            if (!mossy) return false;
            const cy = (P[f[0]][1] + P[f[1]][1] + P[f[2]][1]) / 3;
            const c: V3 = [(P[f[0]][0] + P[f[1]][0] + P[f[2]][0]) / 3, cy, (P[f[0]][2] + P[f[1]][2] + P[f[2]][2]) / 3];
            return cy > height * 0.45 && FN[fi][1] > 0.68 + 0.3 * (vnoise3(c[0] * 3, c[1] * 3, c[2] * 3, mossSeed) - 0.4);
        });
        // Emit: a corner's normal = area-weighted mean of the faces around its vertex within 40° of this face.
        // Corners with the same vertex + normal + layer share one emitted vertex.
        const cache = [new Map<string, number>(), new Map<string, number>()];
        F.forEach((f, fi) => {
            const acc = isMoss[fi] ? mossAcc : stoneAcc, cm = cache[isMoss[fi] ? 1 : 0];
            const ids = f.map(vi => {
                let n: V3 = [0, 0, 0];
                for (const gi of adj[vi]) if (dot(FN[gi], FN[fi]) > HARD_EDGE_COS) { n = [n[0] + FN[gi][0] * FA[gi], n[1] + FN[gi][1] * FA[gi], n[2] + FN[gi][2] * FA[gi]]; }
                n = norm(n);
                const key = `${vi}:${Math.round(n[0] * 100)},${Math.round(n[1] * 100)},${Math.round(n[2] * 100)}`;
                let id = cm.get(key);
                if (id === undefined) { id = acc.vertex(P[vi], n, P[vi][0] + P[vi][2], P[vi][1]); cm.set(key, id); }
                return id;
            });
            acc.triangle(ids[0], ids[1], ids[2]);
        });
    });
    const stone = stoneAcc.geometry(), moss = mossAcc.empty ? null : mossAcc.geometry();
    const tris = stone.indices.length / 3 + (moss ? moss.indices.length / 3 : 0);
    return { id, kind, tone, stone, moss, height, sink, tris };
}

// ── The pool ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Bump when the archetype recipe changes (it keys the shared GPU geometry). */
const POOL_VERSION = 1;
const POOL_SEED = 0x70c4;
let _pool: RockVariant[] | null = null;

/** The fixed, seeded archetype pool (built once, deterministic). Index = RockPlacement.v. */
export function rockVariants(): RockVariant[] { return (_pool ??= buildRockPool()); }

/** Build the pool from its recipe (uncached — rockVariants() memoises it). */
export function buildRockPool(): RockVariant[] {
    const S = (o: Partial<StoneSpec>): StoneSpec => ({ freq: 3, rx: 1, ry: 0.62, rz: 0.85, noise: 0.16, cuts: 3, sink: 0.22, tilt: 0.12, ...o });
    const out: RockVariant[] = [];
    const add = (kind: RockKind, tone: [number, number, number], specs: StoneSpec[], mossy: boolean): void => {
        const i = out.length;
        out.push(buildVariant(`${kind}${i}`, kind, tone, specs, (POOL_SEED + i * 7919) >>> 0, mossy));
    };
    // BOULDERS — irregular, squashed, fractured.
    add('boulder', WARM, [S({ ry: 0.66, cuts: 4 })], true);
    add('boulder', COOL, [S({ ry: 0.55, rz: 0.78, cuts: 4, noise: 0.13 })], true);
    add('boulder', NEUTRAL, [S({ ry: 0.78, rz: 0.9, cuts: 4, noise: 0.12, sink: 0.28 })], false);
    add('boulder', DARK, [S({ ry: 0.5, rz: 0.7, cuts: 4, sink: 0.2 })], true);
    // SLABS — low, broad, a flat (slightly tilted) top.
    add('slab', NEUTRAL, [S({ freq: 3, ry: 0.32, rz: 0.72, cuts: 2, flatTop: 0.22, noise: 0.1, sink: 0.25, tilt: 0.08 })], false);
    add('slab', WARM, [S({ freq: 2, ry: 0.26, rz: 0.6, cuts: 3, flatTop: 0.18, noise: 0.12, sink: 0.25, tilt: 0.1 })], false);
    // FUSED CLUSTERS — a main stone with one or two smaller ones grown into it.
    add('cluster', COOL, [S({ freq: 2, cuts: 3, offset: [-0.35, 0, 0] }), S({ freq: 2, rx: 0.6, ry: 0.42, rz: 0.55, cuts: 2, offset: [0.75, -0.12, 0.2] })], true);
    add('cluster', WARM, [S({ freq: 2, cuts: 3, ry: 0.7, offset: [0, 0, -0.2] }), S({ freq: 2, rx: 0.55, ry: 0.38, rz: 0.5, cuts: 2, offset: [0.8, -0.15, 0.45] }),
        S({ freq: 1, rx: 0.42, ry: 0.3, rz: 0.4, noise: 0.08, cuts: 1, offset: [-0.7, -0.18, 0.55] })], true);
    // PEBBLE GROUPS — 4–5 small faceted stones (icosahedron level: they are tiny).
    const pebbles = (n: number, sd: number): StoneSpec[] => {
        const r = makeRng(sd), out2: StoneSpec[] = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + r.next() * 0.8, d = i === 0 ? 0 : 0.9 + r.next() * 0.9, s = i === 0 ? 0.55 : 0.28 + r.next() * 0.25;
            out2.push(S({ freq: 1, rx: s, ry: s * (0.45 + r.next() * 0.2), rz: s * (0.7 + r.next() * 0.3), noise: 0.08, cuts: 1, sink: 0.3, tilt: 0.25, offset: [Math.cos(a) * d, 0, Math.sin(a) * d] }));
        }
        return out2;
    };
    add('pebbles', NEUTRAL, pebbles(5, 0x51), false);
    add('pebbles', COOL, pebbles(4, 0x52), false);
    return out;
}

/** Variant indices of one kind. */
function variantsOf(kind: RockKind): number[] {
    const out: number[] = [];
    rockVariants().forEach((v, i) => { if (v.kind === kind) out.push(i); });
    return out;
}

/** Truncated power-law (Pareto) sample in [min, max]: most stones small, a few big. */
export function powerLawSize(u: number, min: number, max: number, alpha = 2.2): number {
    const a = 1 - alpha, lo = Math.pow(min, a), hi = Math.pow(max, a);
    return Math.pow(lo + u * (hi - lo), 1 / a);
}

/**
 * A rock CLUSTER at (cx, cz): one big anchor (boulder / slab / fused cluster) plus 1–3 smaller stones or pebble
 * groups around it. Sizes in METRES on a power law; `upm` = world units per metre. `accept(x, z)` rejects points
 * in water / outside the lot. Draws a fixed number of values from `rng` per call (stable streams).
 */
export function rockCluster(out: RockPlacement[], cx: number, cz: number, y: number, rng: Rng, upm: number,
    accept: (x: number, z: number) => boolean, opts: { bigMin?: number; bigMax?: number } = {}): void {
    const kr = rng.next(), vr = rng.next(), big = powerLawSize(rng.next(), opts.bigMin ?? 0.8, opts.bigMax ?? 2.0, 1.6), ry = rng.next() * Math.PI * 2;
    const bigKind: RockKind = kr < 0.5 ? 'boulder' : kr < 0.72 ? 'slab' : 'cluster';
    const vs = variantsOf(bigKind);
    if (accept(cx, cz)) out.push({ x: cx, y, z: cz, ry, size: big, v: vs[Math.floor(vr * vs.length) % vs.length] });
    const n = 1 + Math.floor(rng.next() * 3);
    for (let i = 0; i < n; i++) {
        const a = rng.next() * Math.PI * 2, sr = rng.next(), kind: RockKind = rng.next() < 0.45 ? 'pebbles' : 'boulder', pv = rng.next(), ryi = rng.next() * Math.PI * 2;
        const size = kind === 'pebbles' ? 0.5 + sr * 0.5 : powerLawSize(sr, 0.25, big * 0.55);
        const d = (big * 0.5 + size * 0.45) * (0.85 + rng.next() * 0.5) * upm;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (!accept(x, z)) continue;
        const vk = variantsOf(kind);
        out.push({ x, y, z, ry: ryi, size, v: vk[Math.floor(pv * vk.length) % vk.length] });
    }
}

/**
 * The instanced layers for a set of placements: per used variant, a stone layer `<prefix>-<id>` (its hue) and, if
 * the variant is mossy, `<prefix>-<id>-moss`. Base AO + grass bleed ride the foliage shade (bottom of the rock).
 */
export function rockLayers(placements: RockPlacement[], metresPerUnit: number, prefix: 'world:rocks' | 'world:apron-rocks',
    extra: Partial<LayoutPreviewLayer> = {}): LayoutPreviewLayer[] {
    if (!placements.length) return [];
    const pool = rockVariants(), upm = 1 / metresPerUnit;
    const byV = new Map<number, InstanceXform[]>();
    for (const p of placements) {
        let l = byV.get(p.v);
        if (!l) byV.set(p.v, l = []);
        l.push({ x: p.x, y: p.y, z: p.z, ry: p.ry, s: p.size * upm });
    }
    const layers: LayoutPreviewLayer[] = [];
    for (const [vi, xf] of [...byV].sort((a, b) => a[0] - b[0])) {
        const v = pool[vi];
        const look = {
            y: 0, arrayGroup: true, castShadow: true,
            // The base-AO ramp's denominator is windHeight (no sway: amount 0) → it darkens the bottom ~15 % of the rock.
            wind: { height: Math.max(v.height, 1e-3), stiffness: 1, amount: 0 },
            foliageShade: { translucency: 0, baseAO: 0.5, groundBlend: 0.3, groundTint: GRASS_TINT },
        };
        layers.push({ name: `${prefix}-${v.id}`, color: v.tone, geometry: v.stone, instances: xf.map(t => ({ ...t })),
            instanceKey: `rock:v${POOL_VERSION}:${v.id}:stone`, ...look, ...extra });
        if (v.moss) layers.push({ name: `${prefix}-${v.id}-moss`, color: ROCK_MOSS_COLOR, geometry: v.moss, instances: xf.map(t => ({ ...t })),
            instanceKey: `rock:v${POOL_VERSION}:${v.id}:moss`, ...look, ...extra });
    }
    return layers;
}
