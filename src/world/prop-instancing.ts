// ── P20 lighter tiles: INSTANCED PROPS (performance-plan §P20) ─────────────────────────────────────────────────────
// A streamed full tile bakes every repeated street prop (utility poles, signal heads, lamp posts, parked cars' trim,
// vending machines, benches, bollards, cabinets) into merged per-material meshes, and the P9 far twin bakes each one
// again. Most of those props are the SAME shape: a few variants placed hundreds of times. This pass turns them into
// one canonical geometry per variant plus an instance transform per copy, drawn as one GPU-instanced ArrayGroup.
//
// How it stays exact:
//   · The builders only MARK each prop (Accum3D.beginPart / endPart: the vertex + index range and the prop's rigid
//     frame — origin + yaw). The geometry they emit is unchanged.
//   · BEFORE the drape, each part is moved into its frame (local = Rᵀ(p − o)) and quantised (positions 1/65536 unit,
//     normals 1/32768, uv 1/65536). Parts with identical quantised data are one VARIANT — across tiles too: the
//     variant's content hash is its `instanceKey`, so every tile's copies share ONE GPU geometry allocation.
//   · AFTER the drape (the real height + warp field, per vertex), each part's transform is FITTED to its own draped
//     vertices: translation + the yaw rotation + a height SHEAR (y += gx·x + gz·z, which is exactly what the per-vertex
//     height drape does to a small prop on a sloped field, normals included: the shear's inverse-transpose is the
//     drape's normal tilt). A part is instanced only when every vertex of the instanced copy lands within `tolPos` of
//     its baked position and every normal within `tolNrm`; otherwise it stays baked. So the instanced city is the baked
//     city to within ~1 mm, by construction, and the test (prop-instancing.test.ts) re-checks it vertex for vertex.
//   · Near / far twins (P9) pair part by part (the far twin accumulator records the same parts): a copy is instanced
//     only when both its twins are, and the near / far instanced groups hold the same transforms, so they make the
//     same twin decision (the renderer tests the instances' origin box for both).
//   · What is left of each merged layer keeps its ORIGINAL bounds (twin / LOD decisions unchanged) and, for procedural
//     ground layers, its original uv scale (a one-triangle `groundUvSample` reproducing it exactly).
// Pure (no DOM / WebGPU) → runs in the tile worker. A/B: TileBuildOptions.propInstancing (WorldManager.P20).

import type { LayoutPreviewLayer } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { PART_STRIDE } from './meshbuild';
import { groundUvWorldScale } from '../renderer/3d/ground-uv-scale';

const F = 12;   // MESH3D vertex stride (floats)

export interface PropInstancingOptions {
    /** Max |instanced − baked| per vertex position component, world units (default ~1 mm at the city scale). */
    tolPos: number;
    /** Max |instanced − baked| per (unit) normal component. */
    tolNrm: number;
    /** A variant needs at least this many accepted copies. */
    minCopies: number;
    /** Parts (near twin) with fewer vertices stay baked (an instance slot costs ~240 B on the GPU). */
    minVerts: number;
    /** A variant must save at least this many bytes (its copies' baked geometry − its canonical − the instance
     *  slots): every variant is one more instanced group (a draw + a per-frame group visit), so small ones stay baked. */
    minSaveBytes: number;
    /** Diagnostics: called with every near part's fit residuals (max |Δp| world units, max |Δn|) — accepted or not. */
    onResidual?: (layer: string, pos: number, nrm: number) => void;
}
export const PROP_INSTANCING_DEFAULTS: PropInstancingOptions = { tolPos: 1e-3 / 15, tolNrm: 0.02, minCopies: 4, minVerts: 16, minSaveBytes: 96 << 10 };

export interface PropInstancingStats {
    layers: number; parts: number; accepted: number; rejectedFit: number; rejectedShape: number; rejectedVariant: number;
    variants: number; instances: number; bytesBefore: number; bytesAfter: number;
    /** Diagnostics (set it to {} to fill): rejected parts by layer + reason. */
    why?: Record<string, number>;
    /** Diagnostics (set it to {} to fill): per instanced layer (near twin name) — parts, copies, variants, bytes before /
     *  left baked / canonical (canonical bytes count per layer; shared ones more than once). */
    perLayer?: Record<string, { parts: number; instances: number; variants: number; before: number; rest: number; canon: number }>;
}
export const newPropInstancingStats = (): PropInstancingStats => ({ layers: 0, parts: 0, accepted: 0, rejectedFit: 0, rejectedShape: 0, rejectedVariant: 0, variants: 0, instances: 0, bytesBefore: 0, bytesAfter: 0 });

type Geo = MeshGeometry & { parts?: Float64Array; partLocal?: Float64Array; bounds?: Float32Array };
/** Floats per copy in LayoutPreviewLayer.propXf: translation (3), column-major model 3×3 (9), normal 3×3 (9). */
export const PROP_XF_STRIDE = 21;
/** Copy `i` of a propXf array as { t, m, nm } (tests / diagnostics). */
export function propXfAt(xf: Float32Array, i: number): { t: [number, number, number]; m: number[]; nm: number[] } {
    const o = i * PROP_XF_STRIDE;
    return { t: [xf[o], xf[o + 1], xf[o + 2]], m: Array.from(xf.subarray(o + 3, o + 12)), nm: Array.from(xf.subarray(o + 12, o + 21)) };
}

interface PartSnap {
    v0: number; v1: number; i0: number; i1: number;
    fx: number; fz: number;          // the frame's +Z (unit, XZ)
    ok: boolean;                     // a closed, self-contained part
    key: string;                     // the quantised canonical's content key ('' = empty part)
    l0: number;                      // its first vertex in `lc`
    lc: Float64Array | null;         // the layer's partLocal (the builder's frame-local copy)
    ix: Uint32Array | null;          // the layer's indices (pre-drape: indices never change)
    canon: Float32Array | null;      // quantised local vertices (12-float) — built only for a variant that is kept
    idx: Uint32Array | null;         // indices rebased to the part
}
/** The content key of the canonical `buildCanon` would make, computed WITHOUT building it (most parts are never kept):
 *  a 64-bit hash of the quantised INTEGERS (round(v·Q) — the canonical's values are a function of exactly these; the
 *  tangent is a constant) and the rebased indices. Equal keys ⇔ equal canonical bytes (up to a 2⁻⁶⁴ collision, which
 *  the fit against each copy's own draped vertices would reject). */
function partKey(s: PartSnap): string {
    const Lc = s.lc!, ix = s.ix!, n = s.v1 - s.v0, end = s.l0 + n * 8;
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
    for (let a = s.l0; a < end; a += 8) {
        for (let k = 0; k < 8; k++) {
            const w = Math.round(Lc[a + k] * (k < 3 ? Q_POS : k < 6 ? Q_NRM : Q_UV)) | 0;
            h1 = Math.imul(h1 ^ w, 0x01000193); h2 = Math.imul(h2 ^ w, 0x5bd1e995) ^ (h2 >>> 15);
        }
    }
    for (let i = s.i0; i < s.i1; i++) { const w = ix[i] - s.v0; h1 = Math.imul(h1 ^ w, 0x01000193); h2 = Math.imul(h2 ^ (w + 0x7f4a7c15), 0x5bd1e995) ^ (h2 >>> 15); }
    return `${n}.${s.i1 - s.i0}.${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
}
/** The quantised canonical of a part (its frame-local copy) + its rebased indices. */
function buildCanon(s: PartSnap): void {
    if (s.canon || !s.lc || !s.ix) return;
    const Lc = s.lc, ix = s.ix, n = s.v1 - s.v0, c = new Float32Array(n * F), id = new Uint32Array(s.i1 - s.i0);
    for (let j = 0; j < n; j++) {
        const a = s.l0 + j * 8, b = j * F;
        // (+ 0 turns a −0 into +0: equal integers must give equal bytes, so tiles share the canonical)
        c[b] = Math.round(Lc[a] * Q_POS) / Q_POS + 0;
        c[b + 1] = Math.round(Lc[a + 1] * Q_POS) / Q_POS + 0;
        c[b + 2] = Math.round(Lc[a + 2] * Q_POS) / Q_POS + 0;
        c[b + 3] = Math.round(Lc[a + 3] * Q_NRM) / Q_NRM + 0;
        c[b + 4] = Math.round(Lc[a + 4] * Q_NRM) / Q_NRM + 0;
        c[b + 5] = Math.round(Lc[a + 5] * Q_NRM) / Q_NRM + 0;
        c[b + 6] = Math.round(Lc[a + 6] * Q_UV) / Q_UV + 0;
        c[b + 7] = Math.round(Lc[a + 7] * Q_UV) / Q_UV + 0;
        c[b + 8] = 1; c[b + 9] = 0; c[b + 10] = 0; c[b + 11] = 1;   // the city's constant tangent (no normal maps)
    }
    for (let i = s.i0; i < s.i1; i++) id[i - s.i0] = ix[i] - s.v0;
    s.canon = c; s.idx = id;
}
interface LayerSnap { parts: PartSnap[]; uvScale: [number, number] | null }
/** Per-layer pre-drape snapshots (keyed by layer object). */
export type PropPartSnapshot = Map<LayoutPreviewLayer, LayerSnap>;

const Q_POS = 65536, Q_NRM = 32768, Q_UV = 65536;

/** Does the layer qualify for instancing (look features whose shading depends on the mesh transform are excluded). */
function eligible(L: LayoutPreviewLayer): boolean {
    const g = L.geometry as Geo;
    if (!g?.parts || !g.parts.length) return false;
    if (L.instances || L.instPacked || L.arrayGroup || L.crowdRecords || L.crowdAux || L.crowdInst) return false;
    if ((L.opacity ?? 1) < 1 || L.outlineRanges || L.garp || L.wind || L.foliageShade || L.leafCard) return false;
    return true;
}

/** BEFORE the drape: snapshot every marked part of every eligible layer in its own frame, quantised. */
export function snapshotPropParts(groups: readonly { layers: LayoutPreviewLayer[] }[]): PropPartSnapshot {
    const out: PropPartSnapshot = new Map();
    for (const grp of groups) for (const L of grp.layers) {
        if (!eligible(L)) continue;
        const g = L.geometry as Geo, P = g.parts!, Lc = g.partLocal, ix = g.indices;
        const parts: PartSnap[] = [];
        for (let k = 0; k < P.length; k += PART_STRIDE) {
            const v0 = P[k], v1 = P[k + 1], i0 = P[k + 2], i1 = P[k + 3], l0 = P[k + 9];
            const fx = P[k + 7], fz = P[k + 8];
            const s: PartSnap = { v0, v1, i0, i1, fx, fz, ok: false, key: '', l0, lc: null, ix: null, canon: null, idx: null };
            parts.push(s);
            if (!(Math.abs(Math.hypot(fx, fz) - 1) < 1e-9) || v1 < v0 || i1 < i0 || (i1 - i0) % 3 !== 0) continue;
            if (v1 === v0) { s.ok = i1 === i0; continue; }   // an EMPTY part (a far twin that dropped the whole prop)
            if (!Lc || l0 + (v1 - v0) * 8 > Lc.length) continue;
            let self = true;
            for (let i = i0; i < i1; i++) if (ix[i] < v0 || ix[i] >= v1) { self = false; break; }
            if (!self) continue;
            // the builder's own double-precision frame-local copy (Accum3D._recLocal) is the canonical, quantised; the
            // key is hashed from it directly — the canonical array is built only for a variant that is kept
            s.lc = Lc; s.ix = ix; s.ok = true; s.key = partKey(s);
        }
        out.set(L, { parts, uvScale: null });
    }
    return out;
}

/** Fit part `s` (canonical `c`) to the DRAPED vertices of `v`: an affine map for the positions and a linear map for
 *  the normals, both around the frame's yaw. Null when any vertex / normal misses by more than the tolerances. */
function fitPart(s: PartSnap, c: Float32Array, v: Float32Array, o: PropInstancingOptions, layerName = ''): PartXf | null {
    const n = s.v1 - s.v0, fx = s.fx, fz = s.fz;
    // Positions: a ridge least-squares AFFINE fit W = A·C + t around the frame's yaw R (the ridge only matters along
    // directions the part does not span — a flat plate keeps R there). The drape is smooth at prop scale, so its
    // per-vertex height + warp is affine across one prop to well under a millimetre: the height part is a shear,
    // the warp part a small stretch / rotation in XZ.
    const R = [fz, 0, -fx, 0, 1, 0, fx, 0, fz];   // column-major yaw (local → world)
    const A = ridgeFit(n, c, 0, v, s.v0 * F, R, 1e-10, false);
    if (!A) return null;
    // Normals: their OWN linear map (the per-vertex drape tilts normals by the height gradient but the warp leaves
    // them alone, which no single inverse-transpose reproduces). The renderer writes it as the copy's normal matrix.
    const N = ridgeFit(n, c, 3, v, s.v0 * F + 3, R, 1e-6, true);
    if (!N) return null;
    const xf: PartXf = { m: A.m, t: A.t, nm: N.m };
    if (o.onResidual) { const r = partResidual(s, c, v, xf); o.onResidual(layerName, r[0], r[1]); }
    return checkPart(s, c, v, xf, o) ? xf : null;
}

/** A copy's transform: column-major 3×3 `m` + translation `t`, and the 3×3 normal map `nm`. */
export interface PartXf { m: number[]; t: [number, number, number]; nm: number[] }

/** Ridge least squares for Y ≈ M·X + t over `n` samples (`linear`: no t), regularised toward `M0` with weight `lam`.
 *  Returns column-major M and t, or null when singular / not finite. */
/** X samples: `xs` at xo + j·12 (3 values); Y samples: `ys` at yo + j·12. */
function ridgeFit(n: number, xs: Float32Array, xo: number, ys: Float32Array, yo: number, M0: number[], lam: number, linear: boolean): { m: number[]; t: [number, number, number] } | null {
    let mx0 = 0, mx1 = 0, mx2 = 0, my0 = 0, my1 = 0, my2 = 0;
    if (!linear) {
        for (let j = 0; j < n; j++) { const a = xo + j * F, b = yo + j * F; mx0 += xs[a]; mx1 += xs[a + 1]; mx2 += xs[a + 2]; my0 += ys[b]; my1 += ys[b + 1]; my2 += ys[b + 2]; }
        mx0 /= n; mx1 /= n; mx2 /= n; my0 /= n; my1 /= n; my2 /= n;
    }
    // S = Σ x̃ x̃ᵀ + λI ; B = Σ x̃ ỹᵀ + λ M0ᵀ   (row r of M solves S·m_r = B[:, r])
    let s00 = 0, s01 = 0, s02 = 0, s11 = 0, s12 = 0, s22 = 0;
    let b00 = 0, b01 = 0, b02 = 0, b10 = 0, b11 = 0, b12 = 0, b20 = 0, b21 = 0, b22 = 0;
    for (let j = 0; j < n; j++) {
        const a = xo + j * F, b = yo + j * F;
        const x0 = xs[a] - mx0, x1 = xs[a + 1] - mx1, x2 = xs[a + 2] - mx2, y0 = ys[b] - my0, y1 = ys[b + 1] - my1, y2 = ys[b + 2] - my2;
        s00 += x0 * x0; s01 += x0 * x1; s02 += x0 * x2; s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2;
        b00 += x0 * y0; b01 += x0 * y1; b02 += x0 * y2; b10 += x1 * y0; b11 += x1 * y1; b12 += x1 * y2; b20 += x2 * y0; b21 += x2 * y1; b22 += x2 * y2;
    }
    const S = [s00, s01, s02, s01, s11, s12, s02, s12, s22], B = [b00, b01, b02, b10, b11, b12, b20, b21, b22];
    const mx = [mx0, mx1, mx2], my = [my0, my1, my2];
    for (let p = 0; p < 3; p++) { S[p * 3 + p] += lam; for (let q = 0; q < 3; q++) B[p * 3 + q] += lam * M0[p * 3 + q]; }   // M0 column-major: M0[p*3+q] = M[q][p]
    const inv = inv3(S);
    if (!inv) return null;
    // M[r][p] = Σ_q inv[p][q] · B[q][r]  → column-major m[p*3 + r]
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let r = 0; r < 3; r++) for (let p = 0; p < 3; p++) { let acc = 0; for (let q = 0; q < 3; q++) acc += inv[p * 3 + q] * B[q * 3 + r]; m[p * 3 + r] = acc; }
    const t: [number, number, number] = [my[0], my[1], my[2]];
    for (let r = 0; r < 3; r++) t[r] -= m[r] * mx[0] + m[3 + r] * mx[1] + m[6 + r] * mx[2];
    for (const e of m) if (!Number.isFinite(e)) return null;
    return Number.isFinite(t[0] + t[1] + t[2]) ? { m, t } : null;
}
function inv3(a: number[]): number[] | null {
    const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
    const c0 = a4 * a8 - a5 * a7, c1 = a5 * a6 - a3 * a8, c2 = a3 * a7 - a4 * a6;
    const det = a0 * c0 + a1 * c1 + a2 * c2;
    if (!(Math.abs(det) > 1e-300)) return null;
    const d = 1 / det;
    return [c0 * d, (a2 * a7 - a1 * a8) * d, (a1 * a5 - a2 * a4) * d, c1 * d, (a0 * a8 - a2 * a6) * d, (a2 * a3 - a0 * a5) * d, c2 * d, (a1 * a6 - a0 * a7) * d, (a0 * a4 - a1 * a3) * d];
}

/** Max position / normal error of transform `xf` on part `s` (diagnostics + tests). */
export function partResidual(s: { v0: number; v1: number }, c: Float32Array, v: Float32Array, xf: PartXf): [number, number] {
    const n = s.v1 - s.v0, m = xf.m, t = xf.t, q = xf.nm;
    let ep = 0, en = 0;
    for (let j = 0; j < n; j++) {
        const a = (s.v0 + j) * F, b = j * F, cx = c[b], cy = c[b + 1], cz = c[b + 2];
        ep = Math.max(ep, Math.abs(m[0] * cx + m[3] * cy + m[6] * cz + t[0] - v[a]), Math.abs(m[1] * cx + m[4] * cy + m[7] * cz + t[1] - v[a + 1]), Math.abs(m[2] * cx + m[5] * cy + m[8] * cz + t[2] - v[a + 2]));
        const nx = c[b + 3], ny = c[b + 4], nz = c[b + 5];
        const qx = q[0] * nx + q[3] * ny + q[6] * nz, qy = q[1] * nx + q[4] * ny + q[7] * nz, qz = q[2] * nx + q[5] * ny + q[8] * nz, L = Math.hypot(qx, qy, qz) || 1;
        en = Math.max(en, Math.abs(qx / L - v[a + 3]), Math.abs(qy / L - v[a + 4]), Math.abs(qz / L - v[a + 5]));
    }
    return [ep, en];
}

/** Does transform `xf` put canonical `c` on part `s`'s baked (draped) vertices of `v`, within the tolerances? */
function checkPart(s: PartSnap, c: Float32Array, v: Float32Array, xf: PartXf, o: PropInstancingOptions): boolean {
    const r = partResidual(s, c, v, xf);
    return r[0] <= o.tolPos && r[1] <= o.tolNrm;
}

/** A one-triangle geometry whose groundUvWorldScale (identity model) is exactly `s` (see Mesh3D.groundUvSample). */
function uvScaleSample(s: [number, number]): MeshGeometry {
    const v = new Float32Array(3 * F);
    v.set([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1], 0);
    v.set([s[0], 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1], F);
    v.set([0, 0, s[1], 0, 1, 0, 0, 1, 1, 0, 0, 1], 2 * F);
    return { vertices: v, indices: Uint32Array.of(0, 1, 2), format: '12float' };
}

const geoBytes = (g: MeshGeometry): number => g.vertices.byteLength + (g.indices?.byteLength ?? 0);

/** The layer without the parts in `drop` (vertex / index ranges), indices remapped. Bounds kept from the original. */
function withoutParts(g: Geo, drop: PartSnap[]): Geo {
    drop.sort((a, b) => a.v0 - b.v0);
    const nv = g.vertices.length / F;
    const map = new Int32Array(nv);
    let keepV = 0, d = 0;
    for (let i = 0; i < nv; i++) {
        while (d < drop.length && drop[d].v1 <= i) d++;
        if (d < drop.length && i >= drop[d].v0 && i < drop[d].v1) map[i] = -1; else map[i] = keepV++;
    }
    const vs = new Float32Array(keepV * F), src = g.vertices;
    for (let i = 0; i < nv; i++) { const m = map[i]; if (m >= 0) { const a = i * F, b = m * F; for (let q = 0; q < F; q++) vs[b + q] = src[a + q]; } }
    const ix = g.indices, out = new Uint32Array(ix.length);
    const di = [...drop].sort((a, b) => a.i0 - b.i0);
    let k = 0, n = 0;
    for (let i = 0; i < ix.length; i++) {
        while (k < di.length && di[k].i1 <= i) k++;
        if (k < di.length && i >= di[k].i0 && i < di[k].i1) { i = di[k].i1 - 1; continue; }
        out[n++] = map[ix[i]];
    }
    const res: Geo = { vertices: vs, indices: out.slice(0, n), format: g.format ?? '12float' };
    if (g.bounds) res.bounds = g.bounds;
    return res;
}

/** Strip the part bookkeeping off every geometry (the pass is off, or after it ran). */
export function stripPropParts(groups: readonly { layers: LayoutPreviewLayer[] }[]): void {
    for (const grp of groups) for (const L of grp.layers) { const g = L.geometry as Geo | undefined; if (g && g.parts) { delete g.parts; delete g.partLocal; } }
}

/** AFTER the drape: instance every accepted variant (see the file comment). Mutates `groups` in place. */
export function instancePropParts(groups: { name: string; layers: LayoutPreviewLayer[] }[], snap: PropPartSnapshot,
    opts: Partial<PropInstancingOptions> = {}, stats: PropInstancingStats = newPropInstancingStats()): PropInstancingStats {
    const o: PropInstancingOptions = { ...PROP_INSTANCING_DEFAULTS, ...opts };
    const canonGeo = new Map<string, MeshGeometry>();   // one geometry object per content key in this build
    // the canonical arrays of a content key, built once from the first part of that key (every part of a key quantises
    // to the same bytes; the fit / check against each part's own draped vertices is the arbiter anyway)
    const canonByKey = new Map<string, Float32Array>();
    const canonOf = (s: PartSnap): Float32Array => {
        let c = canonByKey.get(s.key);
        if (!c) { buildCanon(s); c = s.canon!; canonByKey.set(s.key, c); }
        return c;
    };
    const geoFor = (key: string, s: PartSnap): MeshGeometry => {
        let g = canonGeo.get(key);
        if (!g) {
            canonOf(s); buildCanon(s);
            g = { vertices: canonByKey.get(key)!, indices: s.idx!, format: '12float' };
            const c = s.canon!; let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
            for (let i = 0; i < c.length; i += F) { x0 = Math.min(x0, c[i]); x1 = Math.max(x1, c[i]); y0 = Math.min(y0, c[i + 1]); y1 = Math.max(y1, c[i + 1]); z0 = Math.min(z0, c[i + 2]); z1 = Math.max(z1, c[i + 2]); }
            (g as Geo).bounds = Float32Array.of(x0, y0, z0, x1, y1, z1);
            canonGeo.set(key, g);
        }
        return g;
    };
    for (const grp of groups) {
        // twin pairs (near, far) by key; everything else alone
        const units: { near: LayoutPreviewLayer; far: LayoutPreviewLayer | null }[] = [];
        const byKey = new Map<string, LayoutPreviewLayer[]>();
        for (const L of grp.layers) {
            if (!snap.has(L)) continue;
            const tw = L.nearTwin;
            if (tw && (tw.role === 'near' || tw.role === 'far')) (byKey.get(tw.key) ?? byKey.set(tw.key, []).get(tw.key)!).push(L);
            else units.push({ near: L, far: null });
        }
        for (const [, ls] of byKey) {
            const n = ls.filter(L => L.nearTwin!.role === 'near'), f = ls.filter(L => L.nearTwin!.role === 'far');
            if (n.length === 1 && f.length === 1 && snap.get(n[0])!.parts.length === snap.get(f[0])!.parts.length) units.push({ near: n[0], far: f[0] });
        }
        if (!units.length) continue;
        const replace = new Map<LayoutPreviewLayer, LayoutPreviewLayer[]>();
        for (const u of units) {
            const sn = snap.get(u.near)!, sf = u.far ? snap.get(u.far)! : null;
            const gn = u.near.geometry as Geo, gf = u.far ? u.far.geometry as Geo : null;
            stats.layers += u.far ? 2 : 1;
            // the ORIGINAL (draped) uv scale of a procedural-ground layer, kept for what is left and the copies
            const uvN = u.near.ground ? groundUvWorldScale(gn, IDENTITY) : null;
            const uvF = u.far?.ground && gf ? groundUvWorldScale(gf, IDENTITY) : null;
            const variants = new Map<string, { idx: number[]; T: PartXf[] }>();
            // shapes that cannot reach minCopies are never fitted (most of a building's parts are one of a kind)
            const shapeCount = new Map<string, number>();
            for (let k = 0; k < sn.parts.length; k++) {
                const a = sn.parts[k], b = sf ? sf.parts[k] : null;
                if (a.ok && a.v1 > a.v0) { const vk = a.key + '|' + (b ? b.key : ''); shapeCount.set(vk, (shapeCount.get(vk) ?? 0) + 1); }
            }
            for (let k = 0; k < sn.parts.length; k++) {
                stats.parts++;
                const a = sn.parts[k], b = sf ? sf.parts[k] : null;
                if (!a.ok || a.v1 === a.v0 || (b && !b.ok) || (a.v1 - a.v0) < o.minVerts) {
                    stats.rejectedShape++;
                    if (stats.why) { const w = !a.ok ? 'near-not-ok' : a.v1 === a.v0 ? 'near-empty' : b && !b.ok ? 'far-not-ok' : 'small'; const k = u.near.name + ':' + w; stats.why[k] = (stats.why[k] ?? 0) + 1; }
                    continue;
                }
                if ((shapeCount.get(a.key + '|' + (b ? b.key : '')) ?? 0) < o.minCopies) { stats.rejectedVariant++; continue; }
                const fa = fitPart(a, canonOf(a), gn.vertices, o, u.near.name);
                if (!fa) { stats.rejectedFit++; continue; }
                // the far copy must sit on the near copy's transform (one transform list for both groups)
                if (b && b.v1 > b.v0 && !checkPart(b, canonOf(b), gf!.vertices, fa, o)) { stats.rejectedFit++; continue; }
                const vk = a.key + '|' + (b ? b.key : '');
                let V = variants.get(vk); if (!V) { V = { idx: [], T: [] }; variants.set(vk, V); }
                V.idx.push(k);
                V.T.push(fa);
            }
            const dropN: PartSnap[] = [], dropF: PartSnap[] = [];
            const outN: LayoutPreviewLayer[] = [], outF: LayoutPreviewLayer[] = [];
            for (const [, V] of variants) {
                const a0 = sn.parts[V.idx[0]], b0 = sf ? sf.parts[V.idx[0]] : null;
                const perCopy = geoBytesOf(a0) + (b0 ? geoBytesOf(b0) : 0), slots = (b0 && b0.v1 > b0.v0 ? 2 : 1) * 240;
                const save = perCopy * V.T.length - perCopy - slots * V.T.length;
                if (V.T.length < o.minCopies || save < o.minSaveBytes) { stats.rejectedVariant += V.T.length; continue; }
                stats.variants++; stats.instances += V.T.length; stats.accepted += V.T.length;
                for (const k of V.idx) { dropN.push(sn.parts[k]); if (sf) dropF.push(sf.parts[k]); }
                outN.push(instLayer(u.near, geoFor(a0.key, a0), a0.key, V.T, uvN));
                if (u.far && b0 && b0.v1 > b0.v0) outF.push(instLayer(u.far, geoFor(b0.key, b0), b0.key, V.T, uvF));
            }
            const bytes0 = geoBytes(gn) + (gf ? geoBytes(gf) : 0);
            stats.bytesBefore += bytes0;
            if (!outN.length) { stats.bytesAfter += bytes0; continue; }
            const restN = withoutParts(gn, dropN), restF = gf ? withoutParts(gf, dropF) : null;
            const keepN = leftover(u.near, restN, uvN), keepF = u.far && restF ? leftover(u.far, restF, uvF) : null;
            replace.set(u.near, [...(keepN ? [keepN] : []), ...outN]);
            if (u.far) replace.set(u.far, [...(keepF ? [keepF] : []), ...outF]);
            stats.bytesAfter += (restN.indices.length ? geoBytes(restN) : 0) + (restF && restF.indices.length ? geoBytes(restF) : 0);
            if (stats.perLayer) {
                const r = stats.perLayer[u.near.name] ??= { parts: 0, instances: 0, variants: 0, before: 0, rest: 0, canon: 0 };
                r.parts += sn.parts.length; r.instances += outN.reduce((s2, L) => s2 + (L.instances?.length ?? 0), 0); r.variants += outN.length;
                r.before += bytes0; r.rest += (restN.indices.length ? geoBytes(restN) : 0) + (restF && restF.indices.length ? geoBytes(restF) : 0);
                r.canon += [...outN, ...outF].reduce((s2, L) => s2 + geoBytes(L.geometry), 0);
            }
        }
        if (replace.size) grp.layers = grp.layers.flatMap(L => replace.get(L) ?? [L]);
    }
    for (const g of canonGeo.values()) stats.bytesAfter += geoBytes(g);
    stripPropParts(groups);
    return stats;
}

const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const geoBytesOf = (s: PartSnap): number => (s.v1 - s.v0) * F * 4 + (s.i1 - s.i0) * 4;

/** What is left of a merged layer (null when nothing is). */
function leftover(L: LayoutPreviewLayer, g: Geo, uv: [number, number] | null): LayoutPreviewLayer | null {
    if (!g.indices.length) return null;
    const out: LayoutPreviewLayer = { ...L, geometry: g };
    if (uv) out.groundUvSample = uvScaleSample(uv);
    return out;
}

/** One variant's instanced layer: the source layer's look on the canonical geometry, one transform per copy. */
function instLayer(L: LayoutPreviewLayer, geo: MeshGeometry, key: string, T: PartXf[], uv: [number, number] | null): LayoutPreviewLayer {
    // its own typed array per layer (a near and a far layer of one variant may travel in different worker messages,
    // and a buffer transferred with the first would be detached for the second)
    const xf = new Float32Array(T.length * PROP_XF_STRIDE);
    T.forEach((x, i) => { const o = i * PROP_XF_STRIDE; xf[o] = x.t[0]; xf[o + 1] = x.t[1]; xf[o + 2] = x.t[2]; xf.set(x.m, o + 3); xf.set(x.nm, o + 12); });
    const out: LayoutPreviewLayer = { ...L, geometry: geo, propXf: xf, arrayGroup: true, instanceKey: 'p20:' + key, propInst: true, castShadow: L.castShadow ?? true, drape: 'baked' };
    delete out.instances; delete out.instPacked;
    if (uv) out.groundUvSample = uvScaleSample(uv);
    return out;
}

/** Bytes of every layer geometry of `groups` (each geometry object once) — the per-tile budget figure. */
export function tileGeometryBytes(groups: readonly { layers: readonly LayoutPreviewLayer[] }[]): number {
    const seen = new Set<object>();
    let b = 0;
    for (const grp of groups) for (const L of grp.layers) { if (!L.geometry || seen.has(L.geometry)) continue; seen.add(L.geometry); b += geoBytes(L.geometry); }
    return b;
}
