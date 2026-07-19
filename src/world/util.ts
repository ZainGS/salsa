// ── World generation — seeded RNG + 2D geometry ────────────────────────────────────────────────
// Pure, dependency-free helpers. Determinism lives here: every random value in the world flows from
// `makeRng(seed)`, so the same seed reproduces the same city exactly.

import type { V2, BorderShape, DistrictType } from './types';

// ── Seeded RNG (mulberry32 — tiny, fast, good enough for layout) ─────────────────────────────────
export interface Rng {
    next(): number;                      // [0,1)
    range(min: number, max: number): number;
    int(min: number, max: number): number;   // inclusive
    chance(p: number): boolean;
    pick<T>(arr: T[]): T;
}

export function makeRng(seed: number): Rng {
    let s = (seed >>> 0) || 1;
    const next = (): number => {
        s |= 0; s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        range: (min, max) => min + (max - min) * next(),
        int: (min, max) => min + Math.floor(next() * (max - min + 1)),
        chance: (p) => next() < p,
        pick: (arr) => arr[Math.floor(next() * arr.length) % arr.length],
    };
}

/** Deterministic hash of two ints + a salt → [0,1). For per-cell decisions independent of draw order. */
export function hash2(x: number, y: number, salt = 0): number {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(salt | 0, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth VALUE NOISE in [0,1] — bilinear + smoothstep over an integer hash2 grid. THE single shared
 *  implementation: the elevation drape, the domain warp and the layout terraces all sample it, and they must
 *  stay bit-exact relative to each other so terrain / warp / terrace patches keep lining up. Do NOT fork or
 *  "improve" this math — any change shifts every draped/warped world. */
export function valueNoise2D(x: number, z: number, seed: number): number {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed), c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
    const top = a + (b - a) * u, bot = c + (d - c) * u;
    return top + (bot - top) * v;
}

// ── Shared per-graph lookups ─────────────────────────────────────────────────────────────────────
/** Block-indexed lookups every composer needs (the active-region filter / district character / the frontage
 *  reference centroid). Built ONCE per graph object and memoized in a WeakMap — streets / biome / landmarks /
 *  signage / awnings used to each rebuild identical Maps from scratch on every pass. Safe to cache: blocks'
 *  id / region / district / poly are fixed once generateCityLayout returns (composers never mutate them), and
 *  a fresh generation or a structured-clone (worker) is a new object → a fresh cache entry. */
export interface GraphLookups {
    /** block id → region id (-1 = unassigned / layoutOnly graphs). */
    regionByBlock: Map<number, number>;
    /** block id → district character ('mixed' when unassigned). */
    distByBlock: Map<number, DistrictType>;
    /** block id → block centroid (building frontages face AWAY from it → the street). */
    blockCentroid: Map<number, V2>;
}
type LookupGraph = { blocks: { id: number; poly: V2[]; region?: number; district?: DistrictType }[] };
const lookupCache = new WeakMap<LookupGraph, GraphLookups>();
export function graphLookups(graph: LookupGraph): GraphLookups {
    let l = lookupCache.get(graph);
    if (!l) {
        l = {
            regionByBlock: new Map(graph.blocks.map(b => [b.id, b.region ?? -1])),
            distByBlock: new Map(graph.blocks.map(b => [b.id, b.district ?? 'mixed'])),
            blockCentroid: new Map(graph.blocks.map(b => [b.id, centroid(b.poly)])),
        };
        lookupCache.set(graph, l);
    }
    return l;
}

// ── Vector helpers ───────────────────────────────────────────────────────────────────────────────
export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
export const cross2 = (a: V2, b: V2): number => a[0] * b[1] - a[1] * b[0];
export const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lenV = (a: V2): number => Math.hypot(a[0], a[1]);

// ── Polygon helpers ────────────────────────────────────────────────────────────────────────────
/** Signed area (shoelace). > 0 = CCW. */
export function signedArea(poly: V2[]): number {
    let s = 0;
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s * 0.5;
}
export const polyArea = (poly: V2[]): number => Math.abs(signedArea(poly));

export function centroid(poly: V2[]): V2 {
    let x = 0, y = 0;
    for (const p of poly) { x += p[0]; y += p[1]; }
    const n = poly.length || 1;
    return [x / n, y / n];
}

/** Clip segment a→b to a CONVEX polygon (CCW): parametric clip of [t0,t1] against each edge half-plane.
 *  Returns the inside sub-segment, or null when fully outside. (Roads/rails must not escape the city border.) */
export function clipSegmentToConvex(a: V2, b: V2, poly: V2[]): [V2, V2] | null {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const ex = q[0] - p[0], ey = q[1] - p[1];
        // inside = left of the edge (CCW): cross(e, point - p) >= 0
        const f0 = ex * (a[1] - p[1]) - ey * (a[0] - p[0]);
        const fd = ex * dy - ey * dx;                       // how f changes along the segment
        if (Math.abs(fd) < 1e-12) { if (f0 < 0) return null; continue; }   // parallel: fully in or out of this edge
        const t = -f0 / fd;
        if (fd > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
        if (t0 > t1) return null;
    }
    return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
}

/** Pick a building's STREET FRONTAGE edge: among the near-longest edges, prefer the one facing AWAY from `ref`
 *  (the block centre → the street side), with a small deterministic jitter so identical lots don't all pick the
 *  same edge. Fixes "every building faces the same direction". */
export function frontageEdge(foot: V2[], ref: V2 | null, jitterSeed: number): { a: V2; b: V2; len: number } {
    let maxLen = 0;
    for (let i = 0; i < foot.length; i++) maxLen = Math.max(maxLen, dist(foot[i], foot[(i + 1) % foot.length]));
    let best = { a: foot[0], b: foot[1 % foot.length], len: 0 };
    let bestScore = -Infinity;
    for (let i = 0; i < foot.length; i++) {
        const a = foot[i], b = foot[(i + 1) % foot.length], len = dist(a, b);
        if (len < maxLen * 0.72) continue;   // only the long-ish edges are candidate frontages
        const mid: V2 = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
        const away = ref ? dist(mid, ref) : 0;
        const score = len + away * 0.6 + hash2(jitterSeed + i * 17.3, mid[0] * 31.7 + mid[1] * 13.1, 0x5eed) * maxLen * 0.25;
        if (score > bestScore) { bestScore = score; best = { a, b, len }; }
    }
    return best;
}

/** Farthest vertex distance from the origin — used to size the radial structure so it covers the border. */
export function maxRadius(poly: V2[]): number {
    let m = 0;
    for (const p of poly) m = Math.max(m, Math.hypot(p[0], p[1]));
    return m;
}

export function bounds(poly: V2[]): { min: V2; max: V2 } {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const p of poly) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); }
    return { min: [minx, miny], max: [maxx, maxy] };
}

/** The convex border silhouette. `radius` = half-size; square spans ±radius, the rest are circumradius Ngons. CCW. */
export function borderPolygon(shape: BorderShape, radius: number, sides: number, rot = 0): V2[] {
    if (shape === 'square') return [[radius, radius], [-radius, radius], [-radius, -radius], [radius, -radius]];
    const n = shape === 'hexagon' ? 6 : shape === 'octagon' ? 8 : Math.max(8, sides | 0);
    const off = shape === 'hexagon' ? Math.PI / 6 : shape === 'octagon' ? Math.PI / 8 : 0;
    const out: V2[] = [];
    for (let i = 0; i < n; i++) { const a = rot + off + (i / n) * Math.PI * 2; out.push([Math.cos(a) * radius, Math.sin(a) * radius]); }
    return out;
}

/** Segment p1→p2 intersected with the infinite line A→B (assumes they cross; used inside the clipper). */
function lineIntersect(p1: V2, p2: V2, A: V2, B: V2): V2 {
    const d1 = sub(p2, p1), d2 = sub(B, A);
    const denom = cross2(d1, d2);
    if (Math.abs(denom) < 1e-12) return p1;
    const t = cross2(sub(A, p1), d2) / denom;
    return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

/** Sutherland–Hodgman: clip any simple `subject` polygon to the CONVEX, CCW `clip` polygon. May return []. */
export function clipConvex(subject: V2[], clip: V2[]): V2[] {
    let out = subject.slice();
    const n = clip.length;
    for (let e = 0; e < n && out.length; e++) {
        const A = clip[e], B = clip[(e + 1) % n];
        const dir = sub(B, A);
        const inside = (p: V2): boolean => cross2(dir, sub(p, A)) >= -1e-9;   // left of A→B (CCW interior)
        const input = out; out = [];
        for (let i = 0; i < input.length; i++) {
            const cur = input[i], prev = input[(i - 1 + input.length) % input.length];
            const ci = inside(cur), pi = inside(prev);
            if (ci) { if (!pi) out.push(lineIntersect(prev, cur, A, B)); out.push(cur); }
            else if (pi) { out.push(lineIntersect(prev, cur, A, B)); }
        }
    }
    return out;
}

function pointInTri(p: V2, a: V2, b: V2, c: V2): boolean {
    const d1 = cross2(sub(b, a), sub(p, a));
    const d2 = cross2(sub(c, b), sub(p, b));
    const d3 = cross2(sub(a, c), sub(p, c));
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
}

/** Ear-clipping triangulation of a SIMPLE polygon (convex or not, no holes). Returns index triples into `poly`.
 *  ROBUSTNESS: `cap()` feeds raw clipConvex output, which can carry near-duplicate seam vertices and collinear
 *  runs — those used to stall the ear scan and silently drop the whole cap (a missing roof/floor). Now the ring
 *  is dedup/collinear-filtered first (tolerances RELATIVE to the polygon's own scale), and if the clipper still
 *  stalls the residual ring is fan-filled instead of dropped. */
export function triangulate(poly: V2[]): number[] {
    const n = poly.length;
    if (n < 3) return [];
    const bb = bounds(poly);
    const span = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]) || 1;
    const dupEps = span * 1e-7;          // consecutive vertices closer than this are numeric duplicates
    const colEps = span * span * 1e-9;   // |cross| below this = collinear (2× a sliver triangle's area)
    // Drop consecutive near-duplicates (including the wrap pair last≈first).
    const V: number[] = [];
    for (let i = 0; i < n; i++) {
        const pt = poly[i], q = V.length ? poly[V[V.length - 1]] : null;
        if (q && Math.abs(pt[0] - q[0]) <= dupEps && Math.abs(pt[1] - q[1]) <= dupEps) continue;
        V.push(i);
    }
    while (V.length > 1) {
        const f = poly[V[0]], l = poly[V[V.length - 1]];
        if (Math.abs(f[0] - l[0]) <= dupEps && Math.abs(f[1] - l[1]) <= dupEps) V.pop(); else break;
    }
    // Drop collinear straight-throughs / needle spikes (repeat until stable — removals can expose new ones).
    let changed = true;
    while (changed && V.length > 3) {
        changed = false;
        for (let i = 0; i < V.length && V.length > 3;) {
            const a = poly[V[(i - 1 + V.length) % V.length]], m = poly[V[i]], c = poly[V[(i + 1) % V.length]];
            if (Math.abs(cross2(sub(m, a), sub(c, a))) <= colEps) { V.splice(i, 1); changed = true; }
            else i++;
        }
    }
    if (V.length < 3) return [];
    if (signedArea(poly) < 0) V.reverse();   // normalise to CCW so a convex vertex has cross > 0
    const tris: number[] = [];
    let guard = 0;
    while (V.length > 3 && guard++ < n * n + 16) {
        let ear = false;
        for (let i = 0; i < V.length; i++) {
            const i0 = V[(i - 1 + V.length) % V.length], i1 = V[i], i2 = V[(i + 1) % V.length];
            const a = poly[i0], b = poly[i1], c = poly[i2];
            if (cross2(sub(b, a), sub(c, a)) <= 1e-12) continue;   // reflex/collinear
            let contains = false;
            for (let k = 0; k < V.length; k++) {
                const vi = V[k]; if (vi === i0 || vi === i1 || vi === i2) continue;
                if (pointInTri(poly[vi], a, b, c)) { contains = true; break; }
            }
            if (contains) continue;
            tris.push(i0, i1, i2); V.splice(i, 1); ear = true; break;
        }
        if (!ear) break;   // stalled — fan-fill the residual below instead of dropping it
    }
    if (V.length === 3) tris.push(V[0], V[1], V[2]);
    else if (V.length > 3) {
        // FAN FALLBACK: the residual ring is non-simple or numerically degenerate — ear clipping can't finish.
        // Fan from its first vertex: possibly imperfect triangles on a truly self-intersecting residual, but a
        // filled cap always beats the old silent hole.
        for (let i = 1; i + 1 < V.length; i++) tris.push(V[0], V[i], V[i + 1]);
    }
    return tris;
}

const normV2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

/** Bevel every corner of a polygon by up to `amount` (each sharp vertex → two, cutting the corner flat). */
export function chamferPolygon(poly: V2[], amount: number): V2[] {
    const n = poly.length; if (n < 3 || amount <= 0) return poly;
    const out: V2[] = [];
    for (let i = 0; i < n; i++) {
        const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
        const tp = normV2(sub(prev, cur)), tn = normV2(sub(next, cur));
        const dP = Math.min(amount, dist(prev, cur) * 0.45), dN = Math.min(amount, dist(next, cur) * 0.45);
        out.push([cur[0] + tp[0] * dP, cur[1] + tp[1] * dP]);
        out.push([cur[0] + tn[0] * dN, cur[1] + tn[1] * dN]);
    }
    return out;
}

/** Round every corner of a polygon (a quadratic-bezier fillet through each vertex — the Shibuya-109 look). */
export function roundPolygon(poly: V2[], amount: number, segs = 3): V2[] {
    const n = poly.length; if (n < 3 || amount <= 0) return poly;
    const out: V2[] = [];
    for (let i = 0; i < n; i++) {
        const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
        const tp = normV2(sub(prev, cur)), tn = normV2(sub(next, cur));
        const dP = Math.min(amount, dist(prev, cur) * 0.45), dN = Math.min(amount, dist(next, cur) * 0.45);
        const A: V2 = [cur[0] + tp[0] * dP, cur[1] + tp[1] * dP], B: V2 = [cur[0] + tn[0] * dN, cur[1] + tn[1] * dN];
        for (let k = 0; k <= segs; k++) {
            const t = k / segs, it = 1 - t, w0 = it * it, w1 = 2 * it * t, w2 = t * t;
            out.push([w0 * A[0] + w1 * cur[0] + w2 * B[0], w0 * A[1] + w1 * cur[1] + w2 * B[1]]);
        }
    }
    return out;
}

/** Even-odd ray cast: is point `p` inside simple polygon `poly`? */
export function pointInPolygon(p: V2, poly: V2[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / ((b[1] - a[1]) || 1e-12) + a[0]) inside = !inside;
    }
    return inside;
}

/** Rejection-sample up to `count` points inside a polygon (seeded, deterministic). */
export function scatterInPolygon(poly: V2[], count: number, rng: Rng): V2[] {
    if (count <= 0 || poly.length < 3) return [];
    const b = bounds(poly);
    const out: V2[] = [];
    let tries = 0;
    const maxTries = count * 24 + 16;
    while (out.length < count && tries++ < maxTries) {
        const x = b.min[0] + rng.next() * (b.max[0] - b.min[0]);
        const y = b.min[1] + rng.next() * (b.max[1] - b.min[1]);
        if (pointInPolygon([x, y], poly)) out.push([x, y]);
    }
    return out;
}

/** An annular sector (ring band × angle wedge) as a sampled simple polygon: inner arc + outer arc reversed. */
export function annulusSector(r0: number, r1: number, t0: number, t1: number): V2[] {
    const span = t1 - t0;
    const steps = Math.max(2, Math.ceil(Math.abs(span) / 0.22));
    const out: V2[] = [];
    for (let i = 0; i <= steps; i++) { const t = t0 + (span * i) / steps; out.push([Math.cos(t) * r0, Math.sin(t) * r0]); }   // inner arc
    for (let i = steps; i >= 0; i--) { const t = t0 + (span * i) / steps; out.push([Math.cos(t) * r1, Math.sin(t) * r1]); }   // outer arc (back)
    return out;
}
