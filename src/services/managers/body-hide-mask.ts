/**
 * body-hide-mask.ts — the BODY-HIDING MASK (clothing fit round 2, 2026-10-04): don't draw the body triangles that the
 * character's opaque garments fully ENCLOSE. The classic game fix for skin poking through clothes: a knee that pushes
 * through the trouser fabric on a deep bend, or a skin vertex in the armpit crease, simply isn't drawn, so the garment
 * surface behind it shows instead. Garments are closed shells around the limbs/torso, so hiding the skin they enclose
 * never opens a hole: wherever the skin would have poked out, the garment's own outer surface is right behind it.
 *
 * ENCLOSED (at rest, bind space) = every ray from just under the skin vertex (INSET below the surface, so a vertex that
 * already pokes out by a millimetre or two still counts) into its outward hemisphere (cone ≤ CONE_DEG off the normal)
 * hits a garment triangle within the ray length. Openings take care of themselves:
 *   - a skirt's thighs see out through the hem, a tank top's armpit through the arm hole → drawn;
 *   - near a cuff / waistband / neckline the grazing rays escape through the gap → a margin of drawn skin there that grows
 *     with the garment's looseness (a loose sleeve keeps a wider band than a tight sock);
 *   - only GARMENTS occlude (the body itself never does), so skin is hidden only behind cloth.
 * A body triangle is hidden when all three of its vertices are enclosed.
 *
 * Pure (no scene / GPU): Scene3DCharacter calls it after a garment changes and hands the result to the body mesh as
 * degenerate triangles in its DRAW index list (SkinnedMesh3D.renderIndices). geometry.indices stays the full body, so
 * every CPU consumer (garment fit, picking, export, arm clearance) is unchanged.
 */

import { mat4, quat } from 'gl-matrix';
import { packDualQuatSkin, skinMatrixForTS } from '../../renderer/3d/dual-quat-skin';

/** A garment as the mask sees it: 12-float interleaved vertices (position at 0..2) + its triangle list. */
export interface MaskGarment { verts: Float32Array; indices: Uint32Array }

export interface BodyMaskOptions {
    /** Ray origin depth under the skin (m, × scale). */
    inset?: number;
    /** Ray length (m, × scale): a ray that travels this far without meeting cloth has escaped. */
    reach?: number;
    /** Half-angle of the ray cone around the vertex normal (degrees). Steeper rays find openings sooner. */
    coneDeg?: number;
    /** Rays per vertex. */
    rays?: number;
    /** Body size factor (1 = a 1.7 m character); scales inset / reach / the candidate radius. */
    scale?: number;
}

// CONE_DEG: swept 45 / 60 / 75 / 86 — 60 hid the knee in a run's deep bend (live-frame knee skin 510 → 3 px) with no new
// see-through holes over the ROM + locomotion sweep; wider cones let grazing rays out of a loose tube and lost the knee.
const INSET = 0.005, REACH = 0.3, CONE_DEG = 60, RAYS = 24, CANDIDATE_R = 0.12;
/** Skin within this of a garment's open edge is always drawn (openEdgeBand; m, × scale). */
const HEM_MARGIN = 0.05;
/** In a probe pose the cloth along the skin normal may stand off at most this much further than at rest (m, × scale).
 *  Generous: a slim knee moves ~4 cm inside a loose trouser tube in a plain stride (2.5 cm un-hid the whole knee). */
const GAPE = 0.1;
/** An open garment edge with ANOTHER garment piece this close is a hidden seam, not an opening (openEdgeBand; m). */
const SEAM_R = 0.035;
/** How far behind a poking skin vertex the cloth may be and still count as covering it (m). */
const POKE_BACK = 0.06;
/** A probe-pose garment triangle stretched past this × its rest area tears (unhideNearTears), and the skin within
 *  TEAR_MARGIN of it (m, × scale) stays drawn. */
const TEAR_STRETCH = 3.5, TEAR_MARGIN = 0.05;

/** Uniform grid of triangles for first-hit ray queries (3D DDA over the cells, Möller–Trumbore per triangle). */
export class TriRayGrid {
    private readonly tri: Float32Array;          // 9 floats / triangle (a, b, c)
    private readonly cellStart: Int32Array;      // CSR: cell → [start, end) in cellTris
    private readonly cellTris: Int32Array;
    private readonly stamp: Int32Array;          // per-triangle "already tested this ray"
    private rayId = 0;
    private readonly min: [number, number, number];
    private readonly n: [number, number, number];
    private readonly inv: number;
    readonly triCount: number;

    constructor(meshes: MaskGarment[], private readonly cell = 0.04) {
        let nt = 0;
        for (const m of meshes) nt += (m.indices.length / 3) | 0;
        this.triCount = nt;
        this.tri = new Float32Array(nt * 9);
        let t = 0;
        const mn: [number, number, number] = [Infinity, Infinity, Infinity], mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (const m of meshes) {
            const V = m.verts, I = m.indices;
            for (let i = 0; i + 2 < I.length; i += 3, t++) {
                for (let k = 0; k < 3; k++) {
                    const o = I[i + k] * 12;
                    for (let a = 0; a < 3; a++) {
                        const v = V[o + a];
                        this.tri[t * 9 + k * 3 + a] = v;
                        if (v < mn[a]) mn[a] = v;
                        if (v > mx[a]) mx[a] = v;
                    }
                }
            }
        }
        if (nt === 0) { mn[0] = mn[1] = mn[2] = 0; mx[0] = mx[1] = mx[2] = 0; }
        this.inv = 1 / cell;
        this.min = [mn[0] - cell, mn[1] - cell, mn[2] - cell];
        this.n = [0, 1, 2].map((a) => Math.max(1, Math.ceil((mx[a] - mn[a] + 2 * cell) * this.inv))) as [number, number, number];
        const cells = this.n[0] * this.n[1] * this.n[2];
        const counts = new Int32Array(cells + 1);
        const forCells = (ti: number, fn: (c: number) => void) => {
            const T = this.tri, o = ti * 9;
            const lo = [0, 1, 2].map((a) => Math.floor((Math.min(T[o + a], T[o + 3 + a], T[o + 6 + a]) - this.min[a]) * this.inv));
            const hi = [0, 1, 2].map((a) => Math.floor((Math.max(T[o + a], T[o + 3 + a], T[o + 6 + a]) - this.min[a]) * this.inv));
            for (let z = Math.max(0, lo[2]); z <= Math.min(this.n[2] - 1, hi[2]); z++)
                for (let y = Math.max(0, lo[1]); y <= Math.min(this.n[1] - 1, hi[1]); y++)
                    for (let x = Math.max(0, lo[0]); x <= Math.min(this.n[0] - 1, hi[0]); x++) fn((z * this.n[1] + y) * this.n[0] + x);
        };
        for (let i = 0; i < nt; i++) forCells(i, (c) => { counts[c + 1]++; });
        for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
        this.cellStart = counts;
        this.cellTris = new Int32Array(counts[cells]);
        const fill = counts.slice(0, cells);
        for (let i = 0; i < nt; i++) forCells(i, (c) => { this.cellTris[fill[c]++] = i; });
        this.stamp = new Int32Array(nt).fill(-1);
    }

    /** Distance to the first triangle (either side) along the unit ray o + t·d, t in (0, maxT]; Infinity if none. */
    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
        if (this.triCount === 0) return Infinity;
        const id = ++this.rayId;
        const inv = this.inv, n = this.n, mn = this.min;
        // Clip the ray to the grid box.
        let t0 = 0, t1 = maxT;
        const o = [ox, oy, oz], d = [dx, dy, dz];
        for (let a = 0; a < 3; a++) {
            const lo = mn[a], hi = mn[a] + n[a] * this.cell;
            if (Math.abs(d[a]) < 1e-12) { if (o[a] < lo || o[a] > hi) return Infinity; continue; }
            let ta = (lo - o[a]) / d[a], tb = (hi - o[a]) / d[a];
            if (ta > tb) { const s = ta; ta = tb; tb = s; }
            if (ta > t0) t0 = ta;
            if (tb < t1) t1 = tb;
            if (t0 > t1) return Infinity;
        }
        const p = [o[0] + d[0] * t0, o[1] + d[1] * t0, o[2] + d[2] * t0];
        const c = [0, 1, 2].map((a) => Math.min(n[a] - 1, Math.max(0, Math.floor((p[a] - mn[a]) * inv))));
        const step = [0, 1, 2].map((a) => (d[a] > 0 ? 1 : d[a] < 0 ? -1 : 0));
        const tMax = [0, 1, 2].map((a) => (step[a] === 0 ? Infinity : (mn[a] + (c[a] + (step[a] > 0 ? 1 : 0)) * this.cell - o[a]) / d[a]));
        const tDel = [0, 1, 2].map((a) => (step[a] === 0 ? Infinity : this.cell / Math.abs(d[a])));
        let best = Infinity;
        const T = this.tri;
        for (;;) {
            const ci = (c[2] * n[1] + c[1]) * n[0] + c[0];
            for (let k = this.cellStart[ci]; k < this.cellStart[ci + 1]; k++) {
                const ti = this.cellTris[k];
                if (this.stamp[ti] === id) continue;
                this.stamp[ti] = id;
                const b = ti * 9;
                const e1x = T[b + 3] - T[b], e1y = T[b + 4] - T[b + 1], e1z = T[b + 5] - T[b + 2];
                const e2x = T[b + 6] - T[b], e2y = T[b + 7] - T[b + 1], e2z = T[b + 8] - T[b + 2];
                const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (Math.abs(det) < 1e-14) continue;
                const id2 = 1 / det;
                const sx = ox - T[b], sy = oy - T[b + 1], sz = oz - T[b + 2];
                const u = (sx * px + sy * py + sz * pz) * id2;
                if (u < 0 || u > 1) continue;
                const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
                const v = (dx * qx + dy * qy + dz * qz) * id2;
                if (v < 0 || u + v > 1) continue;
                const tt = (e2x * qx + e2y * qy + e2z * qz) * id2;
                if (tt > 1e-6 && tt <= maxT && tt < best) best = tt;
            }
            // A hit inside this cell's span is final (later cells are farther).
            const tExit = Math.min(tMax[0], tMax[1], tMax[2]);
            if (best <= tExit || tExit > t1) return best <= maxT ? best : Infinity;
            const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
            c[a] += step[a];
            if (c[a] < 0 || c[a] >= n[a]) return best <= maxT ? best : Infinity;
            tMax[a] += tDel[a];
        }
    }
}

/** RAYS unit directions in the +Z hemisphere within the cone (a Fibonacci spiral — even, deterministic). */
function coneDirs(count: number, coneDeg: number): Float32Array {
    const out = new Float32Array(count * 3), cMin = Math.cos((coneDeg * Math.PI) / 180);
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
        const z = 1 - (1 - cMin) * ((i + 0.5) / count);   // cos(theta) from ~1 down to cMin (uniform over the cap)
        const r = Math.sqrt(Math.max(0, 1 - z * z)), ph = i * ga;
        out[i * 3] = r * Math.cos(ph); out[i * 3 + 1] = r * Math.sin(ph); out[i * 3 + 2] = z;
    }
    return out;
}

/**
 * Per-vertex enclosure (1 = every cone ray from under the skin meets a garment). `bodyVerts` = 12-float interleaved
 * (position 0..2, normal 3..5), bind space, same space as the garments.
 */
export function enclosedBodyVerts(bodyVerts: Float32Array, garments: MaskGarment[], opts: BodyMaskOptions = {}, only?: Uint8Array): Uint8Array {
    const nb = (bodyVerts.length / 12) | 0;
    const out = new Uint8Array(nb);
    const live = garments.filter((g) => g.indices.length >= 3 && g.verts.length >= 36);
    if (!live.length || nb === 0) return out;
    const s = opts.scale ?? 1;
    const inset = (opts.inset ?? INSET) * s, reach = (opts.reach ?? REACH) * s, candR = CANDIDATE_R * s;
    const dirs = coneDirs(opts.rays ?? RAYS, opts.coneDeg ?? CONE_DEG);
    const grid = new TriRayGrid(live, Math.max(0.02, 0.04 * s));
    // Candidates: body verts with a garment vertex within candR (cheap bucket test on the garment verts).
    const inv = 1 / candR, buckets = new Set<string>();
    for (const g of live) for (let i = 0; i < g.verts.length; i += 12) buckets.add(`${Math.floor(g.verts[i] * inv)},${Math.floor(g.verts[i + 1] * inv)},${Math.floor(g.verts[i + 2] * inv)}`);
    const near = (x: number, y: number, z: number) => {
        const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) if (buckets.has(`${cx + a},${cy + b},${cz + c}`)) return true;
        return false;
    };
    for (let v = 0; v < nb; v++) {
        const o = v * 12;
        const px = bodyVerts[o], py = bodyVerts[o + 1], pz = bodyVerts[o + 2];
        let nx = bodyVerts[o + 3], ny = bodyVerts[o + 4], nz = bodyVerts[o + 5];
        const nl = Math.hypot(nx, ny, nz);
        if ((only && !only[v]) || nl < 1e-8 || !near(px, py, pz)) continue;
        nx /= nl; ny /= nl; nz /= nl;
        // Frame (t, b, n).
        const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
        let tx = ay * nz - 0 * ny, ty = 0 * nx - ax * nz, tz = ax * ny - ay * nx;
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
        const ox = px - nx * inset, oy = py - ny * inset, oz = pz - nz * inset;
        let all = true;
        for (let k = 0; k < dirs.length; k += 3) {
            const a = dirs[k], b = dirs[k + 1], c = dirs[k + 2];
            const dx = tx * a + bx * b + nx * c, dy = ty * a + by * b + ny * c, dz = tz * a + bz * b + nz * c;
            if (grid.raycast(ox, oy, oz, dx, dy, dz, reach) === Infinity) { all = false; break; }
        }
        if (all) out[v] = 1;
    }
    return out;
}

/** Body triangles to hide: all three vertices enclosed. Returns one flag per triangle. */
export function computeBodyHideMask(bodyVerts: Float32Array, bodyIndices: Uint32Array, garments: MaskGarment[], opts: BodyMaskOptions = {}): Uint8Array {
    return trisOf(enclosedBodyVerts(bodyVerts, garments, opts), bodyIndices);
}

/**
 * Body verts within `margin` of a garment's OPEN EDGE (a hem, cuff, neckline or waistband rim: an edge only one garment
 * triangle uses, after welding the ring seams' duplicate verts). A hem moves differently from the skin it sits on (a
 * shorts leg gapes when the knee comes up, a cuff slides), so the skin just inside an opening is always drawn.
 */
export function openEdgeBand(bodyVerts: Float32Array, garments: MaskGarment[], margin: number): Uint8Array {
    const nb = (bodyVerts.length / 12) | 0, out = new Uint8Array(nb);
    if (margin <= 0) return out;
    const pts: number[] = [], ptComp: number[] = [], ptN: number[] = [];
    // Every garment vertex, labelled with its connected PIECE (garment × welded component), to tell a real opening from
    // a hidden SEAM: a sleeve tube's open top edge tucked against the shirt's torso (the armpit) has the INSIDE of another
    // piece within SEAM_R, so it isn't an opening; a hem is (the other shorts leg's hem beside it is an edge too, so it
    // doesn't count).
    const allV: number[] = [], allC: number[] = [], allB: number[] = [], allN: number[] = [];
    let compBase = 0;
    for (const g of garments) {
        const V = g.verts, I = g.indices, weld = new Map<string, number>(), id = new Int32Array(V.length / 12);
        for (let i = 0; i < id.length; i++) {
            const k = `${Math.round(V[i * 12] * 1e4)},${Math.round(V[i * 12 + 1] * 1e4)},${Math.round(V[i * 12 + 2] * 1e4)}`;
            let w = weld.get(k); if (w === undefined) { w = i; weld.set(k, i); } id[i] = w;
        }
        const par = new Int32Array(id.length).map((_, i) => i);
        const find = (x: number): number => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
        const edges = new Map<string, [number, number, number]>();
        for (let t = 0; t + 2 < I.length; t += 3) for (let e = 0; e < 3; e++) {
            const a = id[I[t + e]], b = id[I[t + (e + 1) % 3]];
            if (a === b) continue;
            const ra = find(a), rb = find(b); if (ra !== rb) par[ra] = rb;
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            const cur = edges.get(key); if (cur) cur[2]++; else edges.set(key, [a, b, 1]);
        }
        const onEdge = new Uint8Array(id.length);
        for (const [a, b, c] of edges.values()) if (c === 1) { onEdge[a] = 1; onEdge[b] = 1; }
        for (let i = 0; i < id.length; i++) { allV.push(V[i * 12], V[i * 12 + 1], V[i * 12 + 2]); allC.push(compBase + find(id[i])); allB.push(onEdge[id[i]]); allN.push(V[i * 12 + 3], V[i * 12 + 4], V[i * 12 + 5]); }
        for (const [a, b, c] of edges.values()) {
            if (c !== 1) continue;
            const comp = compBase + find(a);
            const ax = V[a * 12], ay = V[a * 12 + 1], az = V[a * 12 + 2], bx = V[b * 12], by = V[b * 12 + 1], bz = V[b * 12 + 2];
            const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / (margin * 0.4)));
            const nx = V[a * 12 + 3] + V[b * 12 + 3], ny = V[a * 12 + 4] + V[b * 12 + 4], nz = V[a * 12 + 5] + V[b * 12 + 5], nl = Math.hypot(nx, ny, nz) || 1;
            for (let s = 0; s <= steps; s++) { const f = s / steps; pts.push(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f); ptComp.push(comp); ptN.push(nx / nl, ny / nl, nz / nl); }
        }
        compBase += id.length;
    }
    // Drop seam points (another piece within SEAM_R).
    {
        const inv = 1 / SEAM_R, cells = new Map<string, number[]>();
        for (let i = 0; i < allV.length; i += 3) {
            const k = `${Math.floor(allV[i] * inv)},${Math.floor(allV[i + 1] * inv)},${Math.floor(allV[i + 2] * inv)}`;
            let a = cells.get(k); if (!a) { a = []; cells.set(k, a); } a.push(i);
        }
        const seamOf = new Uint8Array(pts.length / 3);
        for (let p = 0; p < pts.length; p += 3) {
            const x = pts[p], y = pts[p + 1], z = pts[p + 2], comp = ptComp[p / 3];
            const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
            let seam = false;
            search: for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
                for (const i of cells.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
                    if (allB[i / 3] || (allV[i] - x) ** 2 + (allV[i + 1] - y) ** 2 + (allV[i + 2] - z) ** 2 > SEAM_R * SEAM_R) continue;
                    // Covered = the other surface lies OUT in front of this edge (along its normal) and faces the same way.
                    const pn = [ptN[p], ptN[p + 1], ptN[p + 2]];
                    const out = (allV[i] - x) * pn[0] + (allV[i + 1] - y) * pn[1] + (allV[i + 2] - z) * pn[2];
                    const ql = Math.hypot(allN[i], allN[i + 1], allN[i + 2]) || 1;
                    const same = (allN[i] * pn[0] + allN[i + 1] * pn[1] + allN[i + 2] * pn[2]) / ql;
                    if ((allC[i / 3] !== comp || out > 0.003) && out > 0.002 && same > 0.3) { seam = true; break search; }
                }
            }
            seamOf[p / 3] = seam ? 1 : 0;
        }
        // An armhole cut is MOSTLY covered; the odd sample where the covering panel thins out shouldn't open a 5 cm band:
        // an edge sample counts as a seam when most edge samples within SEAM_R of it are.
        const keep: number[] = [];
        for (let p = 0; p < pts.length; p += 3) {
            let s = seamOf[p / 3];
            if (!s) {
                let n = 0, k = 0;
                for (let q = 0; q < pts.length; q += 3) {
                    if ((pts[q] - pts[p]) ** 2 + (pts[q + 1] - pts[p + 1]) ** 2 + (pts[q + 2] - pts[p + 2]) ** 2 > SEAM_R * SEAM_R) continue;
                    n++; k += seamOf[q / 3];
                }
                if (k * 2 > n) s = 1;
            }
            if (!s) keep.push(pts[p], pts[p + 1], pts[p + 2]);
        }
        pts.length = 0; pts.push(...keep);
    }
    if (!pts.length) return out;
    const inv = 1 / margin, cells = new Map<string, number[]>();
    for (let i = 0; i < pts.length; i += 3) {
        const k = `${Math.floor(pts[i] * inv)},${Math.floor(pts[i + 1] * inv)},${Math.floor(pts[i + 2] * inv)}`;
        let a = cells.get(k); if (!a) { a = []; cells.set(k, a); } a.push(i);
    }
    const m2 = margin * margin;
    for (let v = 0; v < nb; v++) {
        const x = bodyVerts[v * 12], y = bodyVerts[v * 12 + 1], z = bodyVerts[v * 12 + 2];
        const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
        search: for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
            for (const i of cells.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
                if ((pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2 + (pts[i + 2] - z) ** 2 <= m2) { out[v] = 1; break search; }
            }
        }
    }
    return out;
}

function trisOf(enc: Uint8Array, bodyIndices: Uint32Array): Uint8Array {
    const nt = (bodyIndices.length / 3) | 0, hide = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) hide[t] = enc[bodyIndices[t * 3]] & enc[bodyIndices[t * 3 + 1]] & enc[bodyIndices[t * 3 + 2]];
    return hide;
}

// ── Pose-verified mask ────────────────────────────────────────────────────────────────────────────────────────────
// Enclosed AT REST is not enough: a garment that moves differently from the skin under it in a pose (a shorts leg
// lifting off the thigh in a squat, the front of the hip crease folding as the knee comes up) uncovers skin the rest
// mask hid, and the viewer sees THROUGH the body there. So a vertex is hidden only if it stays enclosed in a set of
// PROBE poses that span what characters are animated through (stride, deep run bend, high knee, squat, arms up /
// forward, a bend + twist). Skin that leaves the cloth in any of them stays drawn (it may poke, as before the mask).

/** A skinned mesh as the mask sees it (bind space). */
export interface MaskSkinned extends MaskGarment { ji: ArrayLike<number>; jw: ArrayLike<number> }
/** The skeleton: joint names, parents, inverse bind matrices (16 per joint, column-major) and the skinning blend. */
export interface MaskRig { names: readonly string[]; parents: ArrayLike<number>; inverseBind: Float32Array; method: 'linear' | 'dualQuat' }
type Q = [number, number, number, number];
type ProbePose = { joint: string; q: Q }[];
const qa = (axis: 'x' | 'y' | 'z', deg: number): Q => {
    const h = (deg * Math.PI) / 360, s = Math.sin(h);
    return [axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0, Math.cos(h)];
};
/** Conventions (body-generator): thigh forward = x−, knee bend = x+, arm L raise = z+, arm L forward = y−. */
export const MASK_PROBE_POSES: Record<string, ProbePose> = {
    'stride L': [{ joint: 'upperleg_L', q: qa('x', -45) }, { joint: 'lowerleg_L', q: qa('x', 35) }, { joint: 'upperleg_R', q: qa('x', 30) }, { joint: 'lowerleg_R', q: qa('x', 45) }],
    'stride R': [{ joint: 'upperleg_R', q: qa('x', -45) }, { joint: 'lowerleg_R', q: qa('x', 35) }, { joint: 'upperleg_L', q: qa('x', 30) }, { joint: 'lowerleg_L', q: qa('x', 45) }],
    'walk L': [{ joint: 'upperleg_L', q: qa('x', -28) }, { joint: 'lowerleg_L', q: qa('x', 8) }, { joint: 'upperleg_R', q: qa('x', 22) }, { joint: 'lowerleg_R', q: qa('x', 30) }],
    'walk R': [{ joint: 'upperleg_R', q: qa('x', -28) }, { joint: 'lowerleg_R', q: qa('x', 8) }, { joint: 'upperleg_L', q: qa('x', 22) }, { joint: 'lowerleg_L', q: qa('x', 30) }],
    'run L': [{ joint: 'upperleg_L', q: qa('x', -75) }, { joint: 'lowerleg_L', q: qa('x', 110) }, { joint: 'upperleg_R', q: qa('x', 35) }, { joint: 'lowerleg_R', q: qa('x', 100) }],
    'run R': [{ joint: 'upperleg_R', q: qa('x', -75) }, { joint: 'lowerleg_R', q: qa('x', 110) }, { joint: 'upperleg_L', q: qa('x', 35) }, { joint: 'lowerleg_L', q: qa('x', 100) }],
    'squat': [{ joint: 'upperleg_L', q: qa('x', -115) }, { joint: 'upperleg_R', q: qa('x', -115) }, { joint: 'lowerleg_L', q: qa('x', 135) }, { joint: 'lowerleg_R', q: qa('x', 135) }],
    'kick L': [{ joint: 'upperleg_L', q: qa('x', -95) }, { joint: 'upperleg_R', q: qa('x', 40) }, { joint: 'lowerleg_R', q: qa('x', 40) }],
    'kick R': [{ joint: 'upperleg_R', q: qa('x', -95) }, { joint: 'upperleg_L', q: qa('x', 40) }, { joint: 'lowerleg_L', q: qa('x', 40) }],
    'legs apart': [{ joint: 'upperleg_L', q: qa('z', 40) }, { joint: 'upperleg_R', q: qa('z', -40) }],
    'arms up': [{ joint: 'shoulder_L', q: qa('z', 80) }, { joint: 'shoulder_R', q: qa('z', -80) }],
    'arms forward': [{ joint: 'shoulder_L', q: qa('y', -80) }, { joint: 'shoulder_R', q: qa('y', 80) }, { joint: 'lowerarm_L', q: qa('y', -90) }, { joint: 'lowerarm_R', q: qa('y', 90) }],
    'arms down': [{ joint: 'shoulder_L', q: qa('z', -70) }, { joint: 'shoulder_R', q: qa('z', 70) }],
    'bend + twist': [{ joint: 'lowerback', q: qa('x', 20) }, { joint: 'spine', q: qa('x', 20) }, { joint: 'chest', q: qa('y', 25) }],
};

/** Skin matrices (16 per joint) of `pose` (absolute local rotations; bind = identity rotations, as the procedural
 *  body is built) for a rig given by its inverse binds. */
function poseSkin(rig: MaskRig, pose: ProbePose): Float32Array {
    const n = rig.names.length, rot = new Map(pose.map((p) => [p.joint, p.q]));
    const bindPos = new Float32Array(n * 3), m = mat4.create();
    for (let j = 0; j < n; j++) {
        mat4.invert(m, rig.inverseBind.subarray(j * 16, j * 16 + 16) as unknown as mat4);
        bindPos[j * 3] = m[12]; bindPos[j * 3 + 1] = m[13]; bindPos[j * 3 + 2] = m[14];
    }
    const world: mat4[] = [], out = new Float32Array(n * 16);
    for (let j = 0; j < n; j++) {
        const p = rig.parents[j] ?? -1, q = rot.get(rig.names[j]);
        const lp: [number, number, number] = p >= 0 ? [bindPos[j * 3] - bindPos[p * 3], bindPos[j * 3 + 1] - bindPos[p * 3 + 1], bindPos[j * 3 + 2] - bindPos[p * 3 + 2]]
            : [bindPos[j * 3], bindPos[j * 3 + 1], bindPos[j * 3 + 2]];
        const local = mat4.fromRotationTranslation(mat4.create(), q ? quat.fromValues(q[0], q[1], q[2], q[3]) : quat.create(), lp);
        world.push(p >= 0 ? mat4.multiply(mat4.create(), world[p], local) : local);
        out.set(mat4.multiply(mat4.create(), world[j], rig.inverseBind.subarray(j * 16, j * 16 + 16) as unknown as mat4), j * 16);
    }
    return out;
}

/** Positions (+ normals) of a skinned mesh in a pose, blended exactly as the GPU does (skinMatrixForTS). */
function skinMesh(mesh: MaskSkinned, buf: Float32Array, withNormals: boolean): Float32Array {
    const n = (mesh.verts.length / 12) | 0, out = new Float32Array(n * 12);
    const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 4; k++) { jj[k] = mesh.ji[i * 4 + k]; ww[k] = mesh.jw[i * 4 + k]; }
        const s = skinMatrixForTS(buf, jj, ww), o = i * 12, V = mesh.verts;
        const x = V[o], y = V[o + 1], z = V[o + 2];
        out[o] = s[0] * x + s[4] * y + s[8] * z + s[12];
        out[o + 1] = s[1] * x + s[5] * y + s[9] * z + s[13];
        out[o + 2] = s[2] * x + s[6] * y + s[10] * z + s[14];
        if (withNormals) {
            const nx = V[o + 3], ny = V[o + 4], nz = V[o + 5];
            out[o + 3] = s[0] * nx + s[4] * ny + s[8] * nz; out[o + 4] = s[1] * nx + s[5] * ny + s[9] * nz; out[o + 5] = s[2] * nx + s[6] * ny + s[10] * nz;
        }
    }
    return out;
}

/** Clear `enc` for body verts within `margin` (bind space) of a garment triangle that tears in the posed garments
 *  (area > TEAR_STRETCH× rest). */
function unhideNearTears(bodyVerts: Float32Array, enc: Uint8Array, rest: MaskGarment[], posed: MaskGarment[], margin: number): void {
    const pts: number[] = [];
    rest.forEach((g, gi) => {
        const R = g.verts, P = posed[gi].verts, I = g.indices;
        for (let t = 0; t + 2 < I.length; t += 3) {
            const a = I[t] * 12, b = I[t + 1] * 12, c = I[t + 2] * 12;
            const cr = (V: Float32Array) => {
                const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
                const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
                return [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
            };
            const n0 = cr(R), n1 = cr(P);
            const A0 = Math.hypot(n0[0], n0[1], n0[2]), A1 = Math.hypot(n1[0], n1[1], n1[2]);
            if (A0 < 1e-10) continue;
            // (Tried: counting FOLDED faces too — a fold doubles the cloth, it doesn't open it, and it cost the whole knee.)
            if (A1 > TEAR_STRETCH * A0) pts.push((R[a] + R[b] + R[c]) / 3, (R[a + 1] + R[b + 1] + R[c + 1]) / 3, (R[a + 2] + R[b + 2] + R[c + 2]) / 3);
        }
    });
    if (!pts.length) return;
    const inv = 1 / margin, cells = new Map<string, number[]>();
    for (let i = 0; i < pts.length; i += 3) {
        const k = `${Math.floor(pts[i] * inv)},${Math.floor(pts[i + 1] * inv)},${Math.floor(pts[i + 2] * inv)}`;
        let arr = cells.get(k); if (!arr) { arr = []; cells.set(k, arr); } arr.push(i);
    }
    const m2 = margin * margin;
    for (let v = 0; v < enc.length; v++) {
        if (!enc[v]) continue;
        const x = bodyVerts[v * 12], y = bodyVerts[v * 12 + 1], z = bodyVerts[v * 12 + 2];
        const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
        search: for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
            for (const i of cells.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
                if ((pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2 + (pts[i + 2] - z) ** 2 <= m2) { enc[v] = 0; break search; }
            }
        }
    }
}

/** Distance along each (flagged) vertex's outward normal, from `inset` under the skin, to the first garment triangle;
 *  Infinity past `reach` (a number, or per vertex: that vertex's own limit + `extra`). */
function normalHits(verts: Float32Array, grid: TriRayGrid, inset: number, reach: number | Float32Array, only: Uint8Array, extra = 0): Float32Array {
    const n = (verts.length / 12) | 0, out = new Float32Array(n).fill(Infinity);
    for (let v = 0; v < n; v++) {
        if (!only[v]) continue;
        const o = v * 12, nl = Math.hypot(verts[o + 3], verts[o + 4], verts[o + 5]);
        if (nl < 1e-8) continue;
        const nx = verts[o + 3] / nl, ny = verts[o + 4] / nl, nz = verts[o + 5] / nl;
        const lim = typeof reach === 'number' ? reach : reach[v] + extra;
        if (!(lim < Infinity)) continue;
        out[v] = grid.raycast(verts[o] - nx * inset, verts[o + 1] - ny * inset, verts[o + 2] - nz * inset, nx, ny, nz, lim);
        // Skin poking OUT through the cloth (the case the mask exists for): the cloth is just behind the skin.
        if (out[v] === Infinity && grid.raycast(verts[o] + nx * 0.002, verts[o + 1] + ny * 0.002, verts[o + 2] + nz * 0.002, -nx, -ny, -nz, POKE_BACK) < Infinity) out[v] = 0;
    }
    return out;
}

export type PoseVerifiedMaskOptions = BodyMaskOptions & { poses?: Record<string, ProbePose>; poseRays?: number; hemMargin?: number; poseCone?: boolean };

/**
 * The hide mask, verified in the probe poses — what is hidden:
 *   1. enclosed at rest (every cone ray from under the skin meets cloth: enclosedBodyVerts);
 *   2. not within HEM_MARGIN of a garment's open edge (openEdgeBand: hems, cuffs, necklines, waistbands);
 *   3. in EVERY probe pose (MASK_PROBE_POSES; joints a rig lacks are skipped): the cloth straight out along the posed
 *      normal is no more than GAPE further than at rest — or right behind the skin, where the skin pokes through
 *      (the case the mask exists for) — and no garment triangle within TEAR_MARGIN tears open (stretches past
 *      TEAR_STRETCH× its rest area).
 * A body triangle is hidden when all three vertices are. Measured over the 26 ROM poses + every Walk / Run / Jump / Land
 * frame on five outfits: see-through holes ≤ 8 px of a 260-px view (clothing-fit-round2.test.ts).
 * Pure. createHideMaskJob runs the same thing one pose per step (Scene3DCharacter spreads it over frames).
 */
export function computePoseVerifiedHideMask(body: MaskSkinned, bodyIndices: Uint32Array, garments: MaskSkinned[], rig: MaskRig,
    opts: PoseVerifiedMaskOptions = {}): Uint8Array {
    const job = createHideMaskJob(body, bodyIndices, garments, rig, opts);
    while (!job.step()) { /* run to completion */ }
    return job.result()!;
}

/** The mask as a resumable job: step() does the rest pass, then one probe pose per call; true once finished. */
export function createHideMaskJob(body: MaskSkinned, bodyIndices: Uint32Array, garments: MaskSkinned[], rig: MaskRig,
    opts: PoseVerifiedMaskOptions = {}): { step(): boolean; result(): Uint8Array | null } {
    const s = opts.scale ?? 1, inset = (opts.inset ?? INSET) * s, gape = GAPE * s;
    const poses = Object.values(opts.poses ?? MASK_PROBE_POSES);
    let enc: Uint8Array | null = null, rest0: Float32Array | null = null, next = 0, out: Uint8Array | null = null;
    return {
        result: () => out,
        step(): boolean {
            if (out) return true;
            if (!enc) {
                enc = enclosedBodyVerts(body.verts, garments, opts);
                const band = openEdgeBand(body.verts, garments, (opts.hemMargin ?? HEM_MARGIN) * s);
                for (let i = 0; i < enc.length; i++) if (band[i]) enc[i] = 0;
                // The cloth straight out along the normal, at rest: in a pose it may not stand off further than this +
                // GAPE (a shorts leg lifting off the thigh still "encloses" the skin, but the viewer sees in under it).
                rest0 = normalHits(body.verts, new TriRayGrid(garments, Math.max(0.02, 0.04 * s)), inset, (opts.reach ?? REACH) * s, enc);
                return false;
            }
            let left = 0; for (let i = 0; i < enc.length; i++) left += enc[i];
            if (left && next < poses.length) {
                const pose = poses[next++];
                const skin = poseSkin(rig, pose.filter((p) => rig.names.includes(p.joint)));
                const buf = rig.method === 'dualQuat' ? (packDualQuatSkin(skin) ?? skin) : skin;
                const posedBody = skinMesh(body, buf, true);
                const posedG = garments.map((g) => ({ verts: skinMesh(g, buf, false), indices: g.indices }));
                // (Tried: the full cone-enclosure test again in each pose — it un-hid exactly the skin that pokes OUT through
                // the cloth in that pose, the rays then starting outside it; the normal / poke-back test keeps those hidden.)
                const still = opts.poseCone ? enclosedBodyVerts(posedBody, posedG, { ...opts, rays: opts.poseRays ?? 12 }, enc) : enc;
                const d = normalHits(posedBody, new TriRayGrid(posedG, Math.max(0.02, 0.04 * s)), inset, rest0!, enc, gape);
                for (let i = 0; i < enc.length; i++) enc[i] &= still[i] & (d[i] < Infinity ? 1 : 0);
                // Where the cloth itself TEARS in this pose (a triangle stretched past TEAR_STRETCH× its rest area — the
                // trousers' front hip crease in a deep squat), the skin behind it is what the viewer sees through the slit.
                unhideNearTears(body.verts, enc, garments, posedG, TEAR_MARGIN * s);
                if (next < poses.length) return false;
            }
            out = trisOf(enc, bodyIndices);
            return true;
        },
    };
}
/** The draw index list: `indices` with each hidden triangle collapsed to a degenerate (a, a, a) — same length, so every
 *  draw call's index count is unchanged; the rasteriser drops zero-area triangles for free. */
export function maskedIndices(indices: Uint32Array, hide: Uint8Array): Uint32Array {
    const out = new Uint32Array(indices);
    for (let t = 0; t < hide.length; t++) if (hide[t]) { const a = out[t * 3]; out[t * 3 + 1] = a; out[t * 3 + 2] = a; }
    return out;
}

/** Hidden-triangle count (for reports / tests). */
export function countHidden(hide: Uint8Array): number { let n = 0; for (let i = 0; i < hide.length; i++) n += hide[i]; return n; }
