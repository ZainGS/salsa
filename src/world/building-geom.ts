// ─────────────────────────────────────────────────────────────────────────────
// Building generator — shared pure geometry helpers (no domain knowledge).
// Imported by building.ts (orchestration) and building-parts.ts (part builders).
// Keeping these here (not in building.ts) avoids a runtime import cycle: building.ts
// imports the part FUNCTIONS from building-parts.ts, and building-parts.ts imports
// only TYPES from building.ts (erased) + these helpers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Accum3D } from './meshbuild';
import type { V2 } from './types';

export type V2L = [number, number];
export type V3L = [number, number, number];

export const LIT: [number, number, number] = [1.0, 0.87, 0.55];   // warm lit-window glass (matches the city)

export const dist2 = (a: V2L, b: V2L): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const nrm2 = (d: V2L): V2L => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
/** Outward unit normal of a CCW polygon edge a→b (matches Accum3D.walls). */
export const outN = (a: V2L, b: V2L): V2L => nrm2([b[1] - a[1], -(b[0] - a[0])]);

export function centroid(poly: V2[]): V2L { let x = 0, z = 0; for (const p of poly) { x += p[0]; z += p[1]; } return [x / poly.length, z / poly.length]; }

/** Axis-aligned bounds of a footprint (half-extents + centre). Buildings are axis-aligned pre-transform. */
export function bbox(poly: V2[]): { hw: number; hd: number; cx: number; cz: number } {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
    return { hw: (maxX - minX) / 2, hd: (maxZ - minZ) / 2, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

/** Miter-offset a convex-ish polygon outward by `amt` (negative = inset). Uniform edge offset. */
export function offsetPoly(poly: V2[], amt: number): V2[] {
    const n = poly.length; const out: V2[] = [];
    for (let i = 0; i < n; i++) {
        const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
        const n1 = outN(prev as V2L, cur as V2L), n2 = outN(cur as V2L, next as V2L);
        let mx = n1[0] + n2[0], mz = n1[1] + n2[1]; const l = Math.hypot(mx, mz) || 1; mx /= l; mz /= l;
        const d = Math.max(0.35, mx * n2[0] + mz * n2[1]);   // 1/cos(half-angle), clamped
        out.push([cur[0] + mx * amt / d, cur[1] + mz * amt / d]);
    }
    return out;
}

/** Offset each EDGE of a polygon by its own distance `d[i]` (edge i = poly[i]→poly[i+1]; + = outward, − = inset),
 *  re-intersecting neighbouring edge lines at every vertex. Used where a uniform offset is wrong: a plinth / parapet
 *  / eave must stay FLUSH on a party wall (d = 0) but project on exposed faces, and the city insets only the STREET
 *  edges of a lot (a fixed setback) so party edges still meet the neighbour. Miter length is clamped (sharp
 *  corners), and near-parallel neighbours fall back to the averaged normal. */
export function offsetPolyEdges(poly: V2[], d: number[]): V2[] {
    const n = poly.length; const out: V2[] = [];
    for (let i = 0; i < n; i++) {
        const ip = (i - 1 + n) % n;
        const a0 = poly[ip] as V2L, a1 = poly[i] as V2L, b1 = poly[(i + 1) % n] as V2L;
        const n1 = outN(a0, a1), n2 = outN(a1, b1);
        const d1 = d[ip] ?? 0, d2 = d[i] ?? 0;
        const det = n1[0] * n2[1] - n1[1] * n2[0];
        if (Math.abs(det) < 0.05) {   // (near-)collinear edges → no unique intersection
            const m = nrm2([n1[0] + n2[0], n1[1] + n2[1]]), dd = (d1 + d2) / 2;
            out.push([a1[0] + m[0] * dd, a1[1] + m[1] * dd]); continue;
        }
        let x = (d1 * n2[1] - n1[1] * d2) / det, z = (n1[0] * d2 - d1 * n2[0]) / det;
        const L = Math.hypot(x, z), maxL = 3 * Math.max(Math.abs(d1), Math.abs(d2)) + 1e-9;
        if (L > maxL) { x *= maxL / L; z *= maxL / L; }
        out.push([a1[0] + x, a1[1] + z]);
    }
    return out;
}

/** A rectangular footprint centred at the origin, wound CCW (outward normals via walls()). */
export function rectFoot(w: number, d: number): V2[] {
    const hw = w / 2, hd = d / 2;
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
}

/** What an edge faces: a STREET (full facade), OPEN ground that is not a street (a back yard / courtyard / alley /
 *  park — gets the utilities: AC, pipes, fire escape), or a PARTY wall shared with the neighbour (plain, nothing
 *  protrudes — it would poke into the next building).
 *  Two more the CITY finds from the ground levels (city-quality B1/B2, S13):
 *   · 'drop'  — a street, but DOWN (or up) a retaining wall: the lot is on a raised terrace. It keeps the street
 *               facade, but the building stands well back from the wall (a walkable strip along its top) and a
 *               door only goes here when the lot has no level street edge.
 *   · 'water' — a canal / pond / water lot (or a road sunk in a canal trench): never the front, never a door, and
 *               the building keeps a walkable strip clear of the railing. */
export type EdgeKind = 'street' | 'open' | 'party' | 'drop' | 'water';
/** A per-edge frontage entry: an EdgeKind, or a boolean (true = street, false = party — the legacy mask). */
export type FrontageMask = (EdgeKind | boolean)[];

export interface Edge { i: number; a: V2L; b: V2L; mid: V2L; dir: V2L; out: V2L; len: number; street: boolean; kind: EdgeKind; }

const kindOf = (v: EdgeKind | boolean | undefined): EdgeKind => v === undefined || v === true ? 'street' : v === false ? 'party' : v;

/** All footprint edges with outward normals + street-facing flag. `frontage` (per-edge) overrides; else all street
 *  (the standalone Building Creator, which has no neighbours). */
export function edgesOf(foot: V2[], frontage?: FrontageMask): Edge[] {
    const out: Edge[] = [];
    for (let i = 0; i < foot.length; i++) {
        const a = foot[i] as V2L, b = foot[(i + 1) % foot.length] as V2L;
        const kind = kindOf(frontage?.[i]);
        out.push({ i, a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dir: nrm2([b[0] - a[0], b[1] - a[1]]), out: outN(a, b), len: dist2(a, b), street: kind === 'street' || kind === 'drop', kind });
    }
    return out;
}

/** The footprint's extent in a local frame (`dir` along, `out` across — typically the front edge's), relative to
 *  `origin`. Lets roofs + rooftop clutter follow the building's REAL orientation and size instead of the world-axis
 *  bbox (which is wrong on rotated / radial lots). */
export function frameExtent(poly: V2[], origin: V2L, dir: V2L, out: V2L): { a0: number; a1: number; o0: number; o1: number } {
    let a0 = Infinity, a1 = -Infinity, o0 = Infinity, o1 = -Infinity;
    for (const p of poly) {
        const dx = p[0] - origin[0], dz = p[1] - origin[1];
        const a = dx * dir[0] + dz * dir[1], o = dx * out[0] + dz * out[1];
        if (a < a0) a0 = a; if (a > a1) a1 = a; if (o < o0) o0 = o; if (o > o1) o1 = o;
    }
    return { a0, a1, o0, o1 };
}

/** Signed area (positive = the CCW winding edgesOf/walls assume). */
export function signedArea(poly: V2[]): number {
    let s = 0;
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
}

/** A small deterministic integer hash (for per-face UV offsets etc.) — no float trig, platform-stable. */
export function ihash(a: number, b = 0): number {
    let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
    return (h ^ (h >>> 16)) >>> 0;
}

/** Minimum front-edge length (metres). Below this the winning "front" is a ROUNDED-CORNER chord, not a real wall —
 *  a floored ~0.9 m door placed there overhangs the short chord and floats off the curving facade ("impossibly thin
 *  doors on curved sides"). avoidTinyFront swaps to the LONGEST street edge so the entrance lands on an actual wall. */
const MIN_FRONT_LEN = 2.0;
export function avoidTinyFront(edges: Edge[], best: Edge): Edge {
    if (best.len >= MIN_FRONT_LEN) return best;
    let longest = best;
    for (const e of edges) if (e.street && e.len > longest.len) longest = e;
    return longest;
}

/** The FRONT edge — the street edge whose outward normal points most toward `want` (default +Z), tie-broken by length. */
export function frontEdge(edges: Edge[], want: V2L = [0, 1]): Edge {
    let best = edges[0], bestScore = -Infinity;
    for (const e of edges) {
        if (!e.street) continue;
        const score = (e.out[0] * want[0] + e.out[1] * want[1]) + e.len * 0.02;
        if (score > bestScore) { bestScore = score; best = e; }
    }
    return avoidTinyFront(edges, best);   // don't put the door on a rounded-corner chord
}

/** Split an edge into `n` equal sub-segments, each { a, b, mid, t } (t = centre param 0..1). */
export function subdivide(e: Edge, n: number): { a: V2L; b: V2L; mid: V2L; len: number }[] {
    const segs: { a: V2L; b: V2L; mid: V2L; len: number }[] = [];
    for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const a: V2L = [e.a[0] + (e.b[0] - e.a[0]) * t0, e.a[1] + (e.b[1] - e.a[1]) * t0];
        const b: V2L = [e.a[0] + (e.b[0] - e.a[0]) * t1, e.a[1] + (e.b[1] - e.a[1]) * t1];
        segs.push({ a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len: dist2(a, b) });
    }
    return segs;
}

/** Point along an edge at param t (0=a, 1=b), offset `off` outward. */
export function edgePt(e: Edge, t: number, off = 0): V2L {
    return [e.a[0] + (e.b[0] - e.a[0]) * t + e.out[0] * off, e.a[1] + (e.b[1] - e.a[1]) * t + e.out[1] * off];
}

/** Place an oriented panel (glass / sign / awning / plate) flush against an edge span, offset `off` outward.
 *  `mid`/`dir`/`out` describe the edge; `len` is the panel width (≤ edge length). */
export function panel(acc: Accum3D, mid: V2L, dir: V2L, out: V2L, y0: number, y1: number, off: number, thick: number, len: number): void {
    const cx = mid[0] + out[0] * off, cz = mid[1] + out[1] * off, cy = (y0 + y1) / 2;
    acc.obox([cx, cy, cz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], len / 2, Math.max(0.02, (y1 - y0) / 2), thick / 2);
}

/** A vertical post (thin oriented box) at a ground point, from y0 to y1. */
export function post(acc: Accum3D, x: number, z: number, y0: number, y1: number, r: number): void {
    acc.beginPart([x, y0, z]);   // P20: a prop part (no-op unless a streamed tile is building) — railing / tank legs repeat
    acc.obox([x, (y0 + y1) / 2, z], [1, 0, 0], [0, 1, 0], [0, 0, 1], r, Math.max(0.02, (y1 - y0) / 2), r);
    acc.endPart();
}

export const darken = (c: [number, number, number], f: number): [number, number, number] => [c[0] * f, c[1] * f, c[2] * f];
export const lighten = (c: [number, number, number], f: number): [number, number, number] => [Math.min(1, c[0] + f), Math.min(1, c[1] + f), Math.min(1, c[2] + f)];

export function mulberry(seed: number): () => number {
    let s = (seed >>> 0) || 1;
    return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
