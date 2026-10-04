// ── World generation — a tiny 3D geometry accumulator ───────────────────────────────────────────
// Builds merged low-poly (PS1-flavoured) meshes for the Biome + Street composers: cones (foliage), prisms
// (trunks / buildings), blobs (rocks). Everything appends into one MeshGeometry so a whole family of props is
// ONE draw call. Smooth-ish normals keep it compact; the retro material carries the faceted look.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../renderer/3d/mesh-generators';
import type { V2 } from './types';
import { triangulate, hash2 } from './util';

type V3 = [number, number, number];

/** Optional extras for {@link Accum3D.wallsWin}. All default to the original behaviour when omitted. */
export interface WallsWinOpts {
    /** Explicit v extent in CELLS [bottom, top] (e.g. storey indices) instead of 0..round(height/cellH). */
    rows?: [number, number];
    /** Per-edge u offset in WHOLE cells (edge i = poly[i]→poly[i+1]). Shifts the shader's cell ids only. */
    uOffset?: number[];
    /** Per-edge skip mask — true = emit nothing for that edge (the caller draws it another way, e.g. a party wall). */
    skip?: boolean[];
}

export class Accum3D {
    // Growable TYPED backing (was number[] — boxed doubles + a full copy in geometry()). Vertices are stored
    // directly in the final interleaved 12-float layout (pos3 · nrm3 · uv2 · 1,0,0,1) so geometry() is one slice.
    private verts = new Float32Array(1024);   // ~4KB start, doubles on overflow
    private vCount = 0;                       // vertices written
    private idxArr = new Uint32Array(1024);
    private iCount = 0;                       // indices written

    private vert(p: V3, n: V3, u = 0, v = 0): number {
        const i = this.vCount;
        let o = i * FLOATS_PER_VERT;
        if (o + FLOATS_PER_VERT > this.verts.length) {
            let cap = this.verts.length * 2;
            while (o + FLOATS_PER_VERT > cap) cap *= 2;
            const next = new Float32Array(cap); next.set(this.verts); this.verts = next;
        }
        const vs = this.verts;
        vs[o++] = p[0]; vs[o++] = p[1]; vs[o++] = p[2];
        vs[o++] = n[0]; vs[o++] = n[1]; vs[o++] = n[2];
        vs[o++] = u; vs[o++] = v;
        vs[o++] = 1; vs[o++] = 0; vs[o++] = 0; vs[o] = 1;
        this.vCount = i + 1;
        if (this._partOpen > 0) this._recLocal(p, n, u, v);   // P20: the open part's exact (f64) local copy
        return i;
    }
    private tri(a: number, b: number, c: number): void {
        let o = this.iCount;
        if (o + 3 > this.idxArr.length) {
            const next = new Uint32Array(this.idxArr.length * 2); next.set(this.idxArr); this.idxArr = next;
        }
        const ix = this.idxArr;
        ix[o++] = a; ix[o++] = b; ix[o] = c;
        this.iCount += 3;
    }
    // ── P20 PROP PARTS (performance-plan §P20; world/prop-instancing.ts) ─────────────────────────────────────────
    // A builder brackets ONE repeated prop (a pole, a signal head, a car's trim) with beginPart / endPart, giving the
    // prop's rigid frame (origin + yaw). Only recorded while a streamed TILE build runs (setPartRecording, a module
    // flag the tile build sets around its synchronous builder calls) — every other build pays nothing and its output
    // is unchanged. The tile build then turns repeated parts into canonical geometry + instance transforms.
    private _parts: number[] | null = null;
    private _partOpen = 0;
    // The open part's frame (origin, unit +Z in XZ) and every part vertex in that frame, in DOUBLE precision, taken as
    // the builder emits it (before the f32 store): a prop's local copy is then the same to ~1e-14 wherever it stands,
    // so identical props quantise to identical canonical bytes in every tile (world positions in f32 would not).
    private _pf = [0, 0, 0, 0, 1];
    private _pl: Float64Array | null = null;
    private _plN = 0;
    /** Start a prop part at `o`, its local +Z along `fwd` (XZ; [0, 1] = no turn). Nested calls fold into the outer
     *  part. Purely bookkeeping: the emitted geometry is the same with or without it. */
    beginPart(o: V3, fwd: V2 = [0, 1]): void {
        if (!PART_REC.on) return;
        if (this._partOpen++ > 0) return;
        const L = Math.hypot(fwd[0], fwd[1]), fx = L > 1e-12 ? fwd[0] / L : 0, fz = L > 1e-12 ? fwd[1] / L : 1;
        this._pf = [o[0], o[1], o[2], fx, fz];
        (this._parts ??= []).push(this.vCount, -1, this.iCount, -1, o[0], o[1], o[2], fx, fz, this._plN);
    }
    /** P20: inside a part (recording on and a beginPart not yet closed). */
    get inPart(): boolean { return this._partOpen > 0; }
    /** P20: close the open part and start the next at the same frame — a prop whose pieces deform apart under the drape
     *  (a pole on the pavement and its arm over the road) is several parts. No-op outside a part. */
    nextPart(o?: V3, fwd?: V2): void {
        if (this._partOpen !== 1) return;
        const P = this._parts!, k = P.length - PART_STRIDE;
        const oo: V3 = o ?? [P[k + 4], P[k + 5], P[k + 6]], ff: V2 = fwd ?? [P[k + 7], P[k + 8]];
        this.endPart();
        this.beginPart(oo, ff);
    }
    /** Close the part opened by beginPart. */
    endPart(): void {
        if (!PART_REC.on || this._partOpen === 0) return;
        if (--this._partOpen > 0) return;
        const P = this._parts!, k = P.length - PART_STRIDE;
        P[k + 1] = this.vCount; P[k + 3] = this.iCount;
    }
    /** local = Rᵀ (p − o), R = [X = (fz, 0, −fx), Y, Z = (fx, 0, fz)]; 8 doubles a vertex (pos, normal, uv). */
    private _recLocal(p: V3, n: V3, u: number, v: number): void {
        const [ox, oy, oz, fx, fz] = this._pf;
        let a = this._pl;
        if (!a || this._plN + 8 > a.length) { const b = new Float64Array(Math.max(1024, (a?.length ?? 0) * 2)); if (a) b.set(a); this._pl = a = b; }
        const dx = p[0] - ox, dy = p[1] - oy, dz = p[2] - oz, k = this._plN;
        a[k] = dx * fz - dz * fx; a[k + 1] = dy; a[k + 2] = dx * fx + dz * fz;
        a[k + 3] = n[0] * fz - n[2] * fx; a[k + 4] = n[1]; a[k + 5] = n[0] * fx + n[2] * fz;
        a[k + 6] = u; a[k + 7] = v;
        this._plN = k + 8;
    }

    get triCount(): number { return this.iCount / 3; }
    get vertCount(): number { return this.vCount; }
    get indexCount(): number { return this.iCount; }   // for recording per-object sub-ranges within a merged mesh
    get empty(): boolean { return this.iCount === 0; }

    /** Push ONE explicit vertex (position / normal / uv) and return its index. The escape hatch for sweeps
     *  that need ANALYTIC normals + UVs no shape helper can express — the foliage `blade` primitive folds and
     *  twists its cross-section, so its normals must be computed, not derived from a face. */
    vertex(p: V3, n: V3, u = 0, v = 0): number { return this.vert(p, n, u, v); }
    /** Emit one triangle from indices returned by {@link vertex}. */
    triangle(a: number, b: number, c: number): void { this.tri(a, b, c); }

    /** P20 AUTO PARTS: while a streamed tile builds, every obox / prism / beam of this accumulator that is not already
     *  inside a part is one part of its own (building detail — railing posts, brackets, plant — repeats one primitive at
     *  fixed sizes). A frame: the primitive's own centre / foot, +Z along its horizontal axis. */
    autoParts = false;
    /** Should this primitive call open an auto part (and so the caller close it)? */
    protected _autoOpen(o: V3, fwd: V2): boolean {
        if (!this.autoParts || this._partOpen !== 0 || !PART_REC.on) return false;
        this.beginPart(o, fwd);
        return true;
    }

    /** A vertical prism (n-gon cross-section) from base `c` up by `h`, radii `rx`,`rz`. Used for trunks + buildings. */
    prism(c: V3, rx: number, rz: number, h: number, sides = 4, rot = 0): void {
        if (this._autoOpen(c, [0, 1])) { try { this._prism(c, rx, rz, h, sides, rot); } finally { this.endPart(); } return; }
        this._prism(c, rx, rz, h, sides, rot);
    }
    private _prism(c: V3, rx: number, rz: number, h: number, sides: number, rot: number): void {
        const top = c[1] + h, bot = c[1];
        const ring = (y: number): number[] => {
            const out: number[] = [];
            for (let i = 0; i < sides; i++) {
                const a = rot + (i / sides) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
                out.push(this.vert([c[0] + cx * rx, y, c[2] + cz * rz], [cx, 0, cz], (i / sides), y === top ? 0 : 1));
            }
            return out;
        };
        const b = ring(bot), t = ring(top);
        for (let i = 0; i < sides; i++) { const n = (i + 1) % sides; this.tri(b[i], b[n], t[n]); this.tri(b[i], t[n], t[i]); }
        // caps (flat)
        const capC = (y: number, ny: number): number => this.vert([c[0], y, c[2]], [0, ny, 0], 0.5, 0.5);
        const tc = capC(top, 1), bc = capC(bot, -1);
        for (let i = 0; i < sides; i++) { const n = (i + 1) % sides; this.tri(tc, t[i], t[n]); this.tri(bc, b[n], b[i]); }
    }

    /** A thin n-gon prism between two ARBITRARY points a→b — light arms / struts / railings. */
    beam(a: V3, b: V3, r: number, sides = 4): void {
        if (this.autoParts && this._partOpen === 0 && PART_REC.on && this._autoOpen(a, beamPartFwd(a, b))) { try { this._beam(a, b, r, sides); } finally { this.endPart(); } return; }
        this._beam(a, b, r, sides);
    }
    private _beam(a: V3, b: V3, r: number, sides: number): void {
        const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
        if (L < 1e-5) return;
        const t = norm3([d[0] / L, d[1] / L, d[2] / L]);
        const up: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const u = norm3([t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]]);
        const v = norm3([t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]]);
        const ring = (c: V3): number[] => {
            const o: number[] = [];
            for (let i = 0; i < sides; i++) {
                const a2 = (i / sides) * Math.PI * 2, cx = Math.cos(a2), cz = Math.sin(a2);
                const n: V3 = [u[0] * cx + v[0] * cz, u[1] * cx + v[1] * cz, u[2] * cx + v[2] * cz];
                o.push(this.vert([c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r], n));
            }
            return o;
        };
        const ra = ring(a), rb = ring(b);
        for (let i = 0; i < sides; i++) { const n = (i + 1) % sides; this.tri(ra[i], ra[n], rb[n]); this.tri(ra[i], rb[n], rb[i]); }
    }

    /** A cone (n-gon base at `c`, apex up by `h`). Foliage / roofs. */
    cone(c: V3, r: number, h: number, sides = 6, rot = 0): void {
        const apex = this.vert([c[0], c[1] + h, c[2]], [0, 1, 0], 0.5, 1);
        const bc = this.vert([c[0], c[1], c[2]], [0, -1, 0], 0.5, 0.5);
        const ring: number[] = [];
        const slope = r / Math.max(1e-4, h);
        for (let i = 0; i < sides; i++) {
            const a = rot + (i / sides) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
            const nl = Math.hypot(cx, slope, cz) || 1;
            ring.push(this.vert([c[0] + cx * r, c[1], c[2] + cz * r], [cx / nl, slope / nl, cz / nl], i / sides, 0));
        }
        for (let i = 0; i < sides; i++) { const n = (i + 1) % sides; this.tri(ring[i], ring[n], apex); this.tri(bc, ring[n], ring[i]); }
    }

    /** A low-poly blob (octahedron with per-axis radii + a little jitter). Rocks / bushes. */
    blob(c: V3, rx: number, ry: number, rz: number, jitter = 0, seed = 0): void {
        const j = (k: number): number => jitter ? 1 + (frac(Math.sin((seed + k) * 12.9898) * 43758.5453) - 0.5) * 2 * jitter : 1;
        const pts: V3[] = [
            [c[0] + rx * j(1), c[1], c[2]], [c[0] - rx * j(2), c[1], c[2]],
            [c[0], c[1], c[2] + rz * j(3)], [c[0], c[1], c[2] - rz * j(4)],
            [c[0], c[1] + ry * j(5), c[2]], [c[0], c[1] - ry * j(6), c[2]],
        ];
        const v = pts.map(p => this.vert(p, norm3([p[0] - c[0], p[1] - c[1], p[2] - c[2]])));
        const F = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
        for (const f of F) this.tri(v[f[0]], v[f[1]], v[f[2]]);
    }

    /** A SMOOTH ellipsoid (UV sphere) on an arbitrary basis — soft cloud puffs. `ax/ay/az` = unit axes, `rx/rz` the
     *  horizontal radii, `ryTop` / `ryBot` the upper / lower half-heights (a small `ryBot` = a flat cloud base).
     *  Normals are the true ellipsoid normals, so it shades as one soft volume (not facets like `blob`). */
    ellipsoid(c: V3, ax: V3, ay: V3, az: V3, rx: number, ryTop: number, ryBot: number, rz: number, segs = 10, rings = 6): void {
        const base = this.vCount;
        for (let r = 0; r <= rings; r++) {
            const th = (r / rings) * Math.PI;              // 0 = top pole … π = bottom pole
            const cy = Math.cos(th), sy = Math.sin(th);
            const ry = cy >= 0 ? ryTop : ryBot;
            for (let k = 0; k <= segs; k++) {
                const ph = (k / segs) * Math.PI * 2, cx = Math.cos(ph) * sy, cz = Math.sin(ph) * sy;
                const lx = cx * rx, ly = cy * ry, lz = cz * rz;
                const p: V3 = [c[0] + ax[0] * lx + ay[0] * ly + az[0] * lz, c[1] + ax[1] * lx + ay[1] * ly + az[1] * lz, c[2] + ax[2] * lx + ay[2] * ly + az[2] * lz];
                // ellipsoid normal ∝ (x/rx², y/ry², z/rz²) in the local frame
                const nx = cx / Math.max(rx, 1e-6), ny = cy / Math.max(ry, 1e-6), nz = cz / Math.max(rz, 1e-6);
                const n = norm3([ax[0] * nx + ay[0] * ny + az[0] * nz, ax[1] * nx + ay[1] * ny + az[1] * nz, ax[2] * nx + ay[2] * ny + az[2] * nz]);
                this.vert(p, n, k / segs, r / rings);
            }
        }
        const row = segs + 1;
        for (let r = 0; r < rings; r++) for (let k = 0; k < segs; k++) {
            const a = base + r * row + k, b = a + 1, d = a + row, e = d + 1;
            if (r > 0) this.tri(a, d, b);
            if (r < rings - 1) this.tri(b, d, e);
        }
    }

    /** Extrude a polygon's WALLS (each edge → a quad) from `baseY` up by `height`. Outward normals assume CCW input. */
    walls(poly: V2[], baseY: number, height: number, skip?: boolean[]): void {
        const n = poly.length; if (n < 3) return; const topY = baseY + height;
        for (let i = 0; i < n; i++) {
            if (skip?.[i]) continue;   // optional per-edge mask (e.g. party walls drawn elsewhere / not at all)
            const a = poly[i], b = poly[(i + 1) % n];
            const dx = b[0] - a[0], dz = b[1] - a[1], nl = Math.hypot(dx, dz) || 1, nx = dz / nl, nz = -dx / nl;
            // UVs in WORLD units (u = edge length, v = height) so a grid pattern makes evenly-sized windows/floors on any wall.
            const v0 = this.vert([a[0], baseY, a[1]], [nx, 0, nz], 0, 0), v1 = this.vert([b[0], baseY, b[1]], [nx, 0, nz], nl, 0);
            const v2 = this.vert([b[0], topY, b[1]], [nx, 0, nz], nl, height), v3 = this.vert([a[0], topY, a[1]], [nx, 0, nz], 0, height);
            this.tri(v0, v1, v2); this.tri(v0, v2, v3);
        }
    }

    /** walls() with UVs QUANTIZED to whole pattern cells: each face's u spans an INTEGER number of `cellW`
     *  columns and v an integer number of `cellH` rows (stretched by at most half a cell — imperceptible), so
     *  a windows-mode facade can NEVER cut a window at a corner or the roofline. Facets too short for a full
     *  column (chamfer/round corner slivers) map into the window-inset margin (u ∈ [0, 0.2·cellW]) and stay
     *  windowless wall. */
    wallsWin(poly: V2[], baseY: number, height: number, cellW: number, cellH: number, opts?: WallsWinOpts): void {
        const n = poly.length; if (n < 3) return; const topY = baseY + height;
        // v range in CELLS. Default: a whole number of cells from 0 (the original behaviour). `rows` pins the v
        // extent to explicit cell values instead, so a caller can make ONE cell = ONE storey and continue the row
        // count across stacked wall sections (a section starting at storey 3 starts at v = 3 cells).
        const vc0 = opts?.rows ? opts.rows[0] : 0;
        const vc1 = opts?.rows ? opts.rows[1] : Math.max(1, Math.round(height / Math.max(cellH, 1e-6)));
        const vLo = vc0 * cellH, vHi = vc1 * cellH;
        for (let i = 0; i < n; i++) {
            if (opts?.skip?.[i]) continue;
            const a = poly[i], b = poly[(i + 1) % n];
            const dx = b[0] - a[0], dz = b[1] - a[1], nl = Math.hypot(dx, dz) || 1, nx = dz / nl, nz = -dx / nl;
            const uMax = nl < cellW * 0.55 ? cellW * 0.2 : Math.max(1, Math.round(nl / cellW)) * cellW;
            // Whole-cell u OFFSET per face: window PLACEMENT is unchanged (still integer cells from the corner), but
            // the shader's per-cell hashes see different cell ids on every face, so faces with the same spacing stop
            // lighting the identical windows / rooms.
            const u0 = (opts?.uOffset?.[i] ?? 0) * cellW;
            const v0 = this.vert([a[0], baseY, a[1]], [nx, 0, nz], u0, vLo), v1 = this.vert([b[0], baseY, b[1]], [nx, 0, nz], u0 + uMax, vLo);
            const v2 = this.vert([b[0], topY, b[1]], [nx, 0, nz], u0 + uMax, vHi), v3 = this.vert([a[0], topY, a[1]], [nx, 0, nz], u0, vHi);
            this.tri(v0, v1, v2); this.tri(v0, v2, v3);
        }
    }

    /** A hip/pyramid roof: the polygon ring at `baseY` rising to a single apex `height` above its centroid.
     *  Slope UVs (u = distance along the eave, v = up the slope, world units) so roof-tile patterns show on the
     *  faces — tile courses converge toward the apex like a real conical/hipped roof. */
    pyramid(poly: V2[], baseY: number, height: number): void {
        const n = poly.length; if (n < 3) return;
        let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= n; cz /= n;
        let avgR = 0; for (const p of poly) avgR += Math.hypot(p[0] - cx, p[1] - cz); avgR /= n;
        const slant = Math.hypot(height, avgR);
        const apex = this.vert([cx, baseY + height, cz], [0, 1, 0], 0, slant);
        let cum = 0;
        const ring: number[] = [];
        for (let i = 0; i < n; i++) {
            const p = poly[i];
            if (i > 0) cum += Math.hypot(p[0] - poly[i - 1][0], p[1] - poly[i - 1][1]);
            ring.push(this.vert([p[0], baseY, p[1]], norm3([p[0] - cx, Math.max(0.2, height), p[1] - cz]), cum, 0));
        }
        for (let i = 0; i < n; i++) this.tri(ring[i], ring[(i + 1) % n], apex);
    }

    /** A frustum wall connecting a BOTTOM ring (at `yB`) to a same-count TOP ring (at `yT`) — roof slopes / tapers.
     *  Per-face world-unit UVs so tile/grid patterns render on the slopes. */
    frustum(bottom: V2[], top: V2[], yB: number, yT: number): void {
        const n = Math.min(bottom.length, top.length);
        for (let i = 0; i < n; i++) {
            const m = (i + 1) % n;
            const A: V3 = [bottom[i][0], yB, bottom[i][1]], B: V3 = [bottom[m][0], yB, bottom[m][1]];
            const C: V3 = [top[m][0], yT, top[m][1]], D: V3 = [top[i][0], yT, top[i][1]];
            const nr = norm3(cross3([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [D[0] - A[0], D[1] - A[1], D[2] - A[2]]));
            const w = Math.hypot(B[0] - A[0], B[2] - A[2]), hgt = Math.hypot(D[0] - A[0], D[1] - A[1], D[2] - A[2]);
            const a = this.vert(A, nr, 0, 0), b = this.vert(B, nr, w, 0), c = this.vert(C, nr, w, hgt), d = this.vert(D, nr, 0, hgt);
            this.tri(a, b, c); this.tri(a, c, d);
        }
    }

    /** Cap a polygon with a flat horizontal face at height `y` (normal ±Y). Roofs / floors.
     *  Planar world-scaled UVs (pos·0.5, same convention as the flat map) so caps can carry shader patterns. */
    cap(poly: V2[], y: number, ny = 1): void {
        const tris = triangulate(poly); if (!tris.length) return;
        const ring = poly.map(p => this.vert([p[0], y, p[1]], [0, ny, 0], p[0] * 0.5, p[1] * 0.5));
        for (let k = 0; k < tris.length; k += 3) {
            if (ny > 0) this.tri(ring[tris[k]], ring[tris[k + 1]], ring[tris[k + 2]]);
            else this.tri(ring[tris[k]], ring[tris[k + 2]], ring[tris[k + 1]]);
        }
    }

    /** An ORIENTED box (basis ax/ay/az, half-extents hx/hy/hz). Flat per-face normals. Housings / signs / plates.
     *  Faces carry planar WORLD-unit UVs (0..full extent, like walls()) so shader patterns tile evenly on them. */
    obox(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number): void {
        if (this.autoParts && this._partOpen === 0 && PART_REC.on && this._autoOpen(c, oboxPartFwd(ay, az))) { try { this._obox(c, ax, ay, az, hx, hy, hz); } finally { this.endPart(); } return; }
        this._obox(c, ax, ay, az, hx, hy, hz);
    }
    private _obox(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number): void {
        const corner =(sx: number, sy: number, sz: number): V3 => [
            c[0] + ax[0] * sx * hx + ay[0] * sy * hy + az[0] * sz * hz,
            c[1] + ax[1] * sx * hx + ay[1] * sy * hy + az[1] * sz * hz,
            c[2] + ax[2] * sx * hx + ay[2] * sy * hy + az[2] * sz * hz,
        ];
        const neg = (n: V3): V3 => [-n[0], -n[1], -n[2]];
        // face normal + its 4 corners (+ per-face u/v axis indices into the corner signs, and u/v half-extents)
        const faces: [V3, number[][], number, number, number, number][] = [
            [az, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], 0, 1, hx, hy],
            [neg(az), [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], 0, 1, hx, hy],
            [ay, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], 0, 2, hx, hz],
            [neg(ay), [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], 0, 2, hx, hz],
            [ax, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], 2, 1, hz, hy],
            [neg(ax), [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], 2, 1, hz, hy],
        ];
        for (const [n, cs, ui, vi, hu, hv] of faces) {
            const vs = cs.map(s => this.vert(corner(s[0], s[1], s[2]), n, (s[ui] + 1) * hu, (s[vi] + 1) * hv));
            this.tri(vs[0], vs[1], vs[2]); this.tri(vs[0], vs[2], vs[3]);
        }
    }

    /** A flat filled disc at `c` facing `dir` (the round signal lamps). */
    disc(c: V3, dir: V3, r: number, segs = 12): void {
        const n = norm3(dir), up: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const u = norm3(cross3(n, up)), v = norm3(cross3(n, u));
        // Centred radial UVs: centre → (0.5,0.5), rim → the unit circle around it. Lets a shape use the
        // `radialFade` flag (distance from uv-centre) to dissolve softly at its edge — e.g. a lamp light-pool
        // that fades to nothing at the rim instead of a hard sticker edge. Colour-only discs ignore uv.
        const centre = this.vert(c, n, 0.5, 0.5), ring: number[] = [];
        for (let i = 0; i < segs; i++) {
            const a = (i / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), cx = ca * r, cy = sa * r;
            ring.push(this.vert([c[0] + u[0] * cx + v[0] * cy, c[1] + u[1] * cx + v[1] * cy, c[2] + u[2] * cx + v[2] * cy], n, 0.5 + 0.5 * ca, 0.5 + 0.5 * sa));
        }
        for (let i = 0; i < segs; i++) { const m = (i + 1) % segs; this.tri(centre, ring[i], ring[m]); }
    }

    /** A curved half-cylinder HOOD (visor) draping from `up` toward `front`, extruded ±`halfW` along `axis`. */
    hood(c: V3, axis: V3, up: V3, front: V3, r: number, halfW: number, segs = 6): void {
        const arc: V3[] = [];
        for (let i = 0; i <= segs; i++) {
            const a = (i / segs) * Math.PI * 0.62, ca = Math.cos(a), sa = Math.sin(a);
            arc.push([c[0] + (up[0] * ca + front[0] * sa) * r, c[1] + (up[1] * ca + front[1] * sa) * r, c[2] + (up[2] * ca + front[2] * sa) * r]);
        }
        const L = arc.map(p => this.vert([p[0] + axis[0] * halfW, p[1] + axis[1] * halfW, p[2] + axis[2] * halfW], up));
        const R = arc.map(p => this.vert([p[0] - axis[0] * halfW, p[1] - axis[1] * halfW, p[2] - axis[2] * halfW], up));
        for (let i = 0; i < segs; i++) { this.tri(L[i], R[i], R[i + 1]); this.tri(L[i], R[i + 1], L[i + 1]); }
    }

    /** An arbitrary quad a→b→c→d (computed flat normal). Draped retaining walls / ramps.
     *  World-unit UVs (u along a→b, v along a→d) so shader patterns tile evenly (masonry courses on walls). */
    quad4(a: V3, b: V3, c: V3, d: V3): void {
        const nr = norm3(cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]));
        const w = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), h = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
        const va = this.vert(a, nr, 0, 0), vb = this.vert(b, nr, w, 0), vc = this.vert(c, nr, w, h), vd = this.vert(d, nr, 0, h);
        this.tri(va, vb, vc); this.tri(va, vc, vd);
    }

    /** A quad a→b→c→d with EXPLICIT u range (and world-length v). For a surface built from several quads
     *  that must share ONE continuous UV run — a subdivided awning canvas, where `quad4`'s per-quad
     *  world-length u restarts at every bay and collapses a stripe pattern into flat colour. */
    quad4u(a: V3, b: V3, c: V3, d: V3, u0: number, u1: number): void {
        const nr = norm3(cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]));
        const h = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
        const va = this.vert(a, nr, u0, 0), vb = this.vert(b, nr, u1, 0), vc = this.vert(c, nr, u1, h), vd = this.vert(d, nr, u0, h);
        this.tri(va, vb, vc); this.tri(va, vc, vd);
    }

    /** A quad a→b→c→d with EXPLICIT per-corner UVs (each a [u,v]). For an ATLAS UNWRAP where different faces of
     *  one mesh map to different regions of a shared texture — e.g. a GARP prop shell whose front face takes the
     *  whole 0..1 texture and whose sides sample a corner texel. Pass the same [u,v] for all four to flat-fill a
     *  face with one texel. Normal is computed flat from the corners (a→b, a→d). */
    quadUV4(a: V3, b: V3, c: V3, d: V3, ua: V2, ub: V2, uc: V2, ud: V2): void {
        const nr = norm3(cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]));
        const va = this.vert(a, nr, ua[0], ua[1]), vb = this.vert(b, nr, ub[0], ub[1]);
        const vc = this.vert(c, nr, uc[0], uc[1]), vd = this.vert(d, nr, ud[0], ud[1]);
        this.tri(va, vb, vc); this.tri(va, vc, vd);
    }

    /** A quad a→b→c→d with UNIT-square UVs (a=0,0 · b=1,0 · c=1,1 · d=0,1) — for alpha LEAF CARDS: the fragment
     *  maps a procedural leaf silhouette onto the 0..1 UV and alpha-discards outside it. */
    quadUV(a: V3, b: V3, c: V3, d: V3): void {
        const nr = norm3(cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]));
        const va = this.vert(a, nr, 0, 0), vb = this.vert(b, nr, 1, 0), vc = this.vert(c, nr, 1, 1), vd = this.vert(d, nr, 0, 1);
        this.tri(va, vb, vc); this.tri(va, vc, vd);
    }

    /** A LATHE (surface of revolution) around `axis` through `c`. `profile` = [radius, height-along-axis] pairs
     *  walked from the START end (usually the bottom) around the OUTSIDE to the end — outward normals assume that
     *  order. Each profile segment gets its own ring pair so a bevel stays crisp; `smooth` averages the normals at
     *  shared profile points instead (a soft bell / dome). Ends whose radius is > 0 get a flat cap unless
     *  `caps` says otherwise ([start, end]). Street-prop posts, collars, bell heads, lenses, insulators.
     *  Tris = sides·2·(profile.length−1) + a fan per cap. u = around (0..1), v = profile distance (world units). */
    lathe(c: V3, axis: V3, profile: [number, number][], sides = 8, opts: { smooth?: boolean; caps?: [boolean, boolean]; rot?: number } = {}): void {
        const n = profile.length; if (n < 2 || sides < 3) return;
        const A = norm3(axis), ref: V3 = Math.abs(A[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        // u ⟂ A, v = u × A — for A = +Y this is exactly prism()'s (x, z) ring basis, so winding matches it.
        let u = norm3(cross3(ref, A)); if (Math.abs(A[1]) >= 0.9) u = [1, 0, 0];
        const v = norm3(cross3(u, A));
        const rot = opts.rot ?? 0;
        const dirs: V3[] = [];
        for (let i = 0; i < sides; i++) {
            const a = rot + (i / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
            dirs.push([u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa]);
        }
        // 2D segment normals in (radial, axial): tangent (dr, dh) → outward (dh, −dr).
        const segN: [number, number][] = [];
        for (let k = 0; k < n - 1; k++) {
            const dr = profile[k + 1][0] - profile[k][0], dh = profile[k + 1][1] - profile[k][1];
            const l = Math.hypot(dr, dh) || 1; segN.push([dh / l, -dr / l]);
        }
        const nAt = (k: number, end: 0 | 1): [number, number] => {
            const s0 = segN[k];
            if (!opts.smooth) return s0;
            const o = end ? segN[k + 1] : segN[k - 1];
            if (!o) return s0;
            const r = s0[0] + o[0], h = s0[1] + o[1], l = Math.hypot(r, h) || 1; return [r / l, h / l];
        };
        const P = (r: number, h: number, d: V3): V3 => [c[0] + A[0] * h + d[0] * r, c[1] + A[1] * h + d[1] * r, c[2] + A[2] * h + d[2] * r];
        let vAcc = 0;
        for (let k = 0; k < n - 1; k++) {
            const [r0, h0] = profile[k], [r1, h1] = profile[k + 1];
            const segL = Math.hypot(r1 - r0, h1 - h0);
            if (segL < 1e-9) continue;
            const n0 = nAt(k, 0), n1 = nAt(k, 1);
            const ring0: number[] = [], ring1: number[] = [];
            for (let i = 0; i < sides; i++) {
                const d = dirs[i];
                const N0: V3 = [d[0] * n0[0] + A[0] * n0[1], d[1] * n0[0] + A[1] * n0[1], d[2] * n0[0] + A[2] * n0[1]];
                const N1: V3 = [d[0] * n1[0] + A[0] * n1[1], d[1] * n1[0] + A[1] * n1[1], d[2] * n1[0] + A[2] * n1[1]];
                ring0.push(this.vert(P(r0, h0, d), N0, i / sides, vAcc));
                ring1.push(this.vert(P(r1, h1, d), N1, i / sides, vAcc + segL));
            }
            for (let i = 0; i < sides; i++) { const m = (i + 1) % sides; this.tri(ring0[i], ring0[m], ring1[m]); this.tri(ring0[i], ring1[m], ring1[i]); }
            vAcc += segL;
        }
        const caps = opts.caps ?? [true, true];
        const cap = (k: number, sign: 1 | -1): void => {
            const [r, h] = profile[k]; if (r < 1e-9) return;
            const N: V3 = [A[0] * sign, A[1] * sign, A[2] * sign];
            const cc = this.vert(P(0, h, dirs[0]), N, 0.5, 0.5), ring: number[] = [];
            for (let i = 0; i < sides; i++) ring.push(this.vert(P(r, h, dirs[i]), N, 0.5 + 0.5 * Math.cos(i / sides * Math.PI * 2), 0.5 + 0.5 * Math.sin(i / sides * Math.PI * 2)));
            for (let i = 0; i < sides; i++) { const m = (i + 1) % sides; if (sign > 0) this.tri(cc, ring[i], ring[m]); else this.tri(cc, ring[m], ring[i]); }
        };
        if (caps[0]) cap(0, -1);
        if (caps[1]) cap(n - 1, 1);
    }

    /** A round TUBE swept along a polyline `path` (parallel-transport frames, so it never twists). `radius` is one
     *  value or one per path point (a taper). Smooth radial normals; optional flat end caps. Curved lamp arms,
     *  swan necks, cable conduits. Tris = sides·2·(path.length−1) (+ caps). */
    sweep(path: V3[], radius: number | number[], sides = 6, caps: [boolean, boolean] = [false, true]): void {
        const n = path.length; if (n < 2 || sides < 3) return;
        const rAt = (i: number): number => typeof radius === 'number' ? radius : radius[Math.min(i, radius.length - 1)];
        const tan: V3[] = [];
        for (let i = 0; i < n; i++) {
            const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
            tan.push(norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]));
        }
        const t0 = tan[0], ref: V3 = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = norm3(cross3(ref, t0));
        const rings: number[][] = [], ringPos: V3[][] = [];
        for (let i = 0; i < n; i++) {
            const t = tan[i];
            if (i > 0) {   // parallel transport: strip the new tangent's component out of the previous u
                const d = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
                const w: V3 = [u[0] - t[0] * d, u[1] - t[1] * d, u[2] - t[2] * d];
                if (Math.hypot(w[0], w[1], w[2]) > 1e-6) u = norm3(w);
            }
            const v = norm3(cross3(u, t)), r = rAt(i), ring: number[] = [], pos: V3[] = [];
            for (let k = 0; k < sides; k++) {
                const a = (k / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
                const N: V3 = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
                const q: V3 = [path[i][0] + N[0] * r, path[i][1] + N[1] * r, path[i][2] + N[2] * r];
                pos.push(q);
                ring.push(this.vert(q, N, k / sides, i / (n - 1)));
            }
            rings.push(ring); ringPos.push(pos);
        }
        for (let i = 0; i < n - 1; i++) {
            const a = rings[i], b = rings[i + 1];
            for (let k = 0; k < sides; k++) { const m = (k + 1) % sides; this.tri(a[k], a[m], b[m]); this.tri(a[k], b[m], b[k]); }
        }
        const cap = (i: number, sign: 1 | -1): void => {
            const t = tan[i], N: V3 = [t[0] * sign, t[1] * sign, t[2] * sign];
            const cc = this.vert(path[i], N, 0.5, 0.5);
            const ring = ringPos[i].map(p => this.vert(p, N, 0.5, 0.5));
            for (let k = 0; k < sides; k++) { const m = (k + 1) % sides; if (sign > 0) this.tri(cc, ring[k], ring[m]); else this.tri(cc, ring[m], ring[k]); }
        };
        if (caps[0]) cap(0, -1);
        if (caps[1]) cap(n - 1, 1);
    }

    /** An oriented box with CHAMFERED edges (a bevel of width `b` on all 12 edges + the 8 corners): the cheapest
     *  way to make a housing / clamp / cross-arm catch a highlight on its edges instead of reading as a flat
     *  cardboard box. Same basis convention as {@link obox}. 44 tris. `b` is clamped below each half-extent. */
    bevelBox(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number, b: number): void {
        const bb = Math.max(0, Math.min(b, hx * 0.9, hy * 0.9, hz * 0.9));
        if (bb < 1e-9) { this.obox(c, ax, ay, az, hx, hy, hz); return; }
        const H = [hx, hy, hz];
        // A point from per-axis offsets (local coords).
        const pt = (l: [number, number, number]): V3 => [
            c[0] + ax[0] * l[0] + ay[0] * l[1] + az[0] * l[2],
            c[1] + ax[1] * l[0] + ay[1] * l[1] + az[1] * l[2],
            c[2] + ax[2] * l[0] + ay[2] * l[1] + az[2] * l[2],
        ];
        // Local normal vector → world (NOT offset by c).
        const nW = (l: [number, number, number]): V3 => norm3([
            ax[0] * l[0] + ay[0] * l[1] + az[0] * l[2], ax[1] * l[0] + ay[1] * l[1] + az[1] * l[2], ax[2] * l[0] + ay[2] * l[1] + az[2] * l[2]]);
        // The chamfer-box vertex on face `f` (axis index), sign sf, at the corner with signs (s1, s2) on the other two axes.
        const fv = (f: number, sf: number, o1: number, s1: number, o2: number, s2: number): [number, number, number] => {
            const l: [number, number, number] = [0, 0, 0];
            l[f] = sf * H[f]; l[o1] = s1 * (H[o1] - bb); l[o2] = s2 * (H[o2] - bb); return l;
        };
        const quadL = (p0: [number, number, number], p1: [number, number, number], p2: [number, number, number], p3: [number, number, number], nl: [number, number, number]): void => {
            const N = nW(nl);
            const q = [p0, p1, p2, p3].map(p => pt(p));
            // wind so the computed face normal agrees with N
            const fn = cross3([q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]], [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]]);
            const ok = fn[0] * N[0] + fn[1] * N[1] + fn[2] * N[2] >= 0;
            const w = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]), h = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1], q[3][2] - q[0][2]);
            const vs = [this.vert(q[0], N, 0, 0), this.vert(q[1], N, w, 0), this.vert(q[2], N, w, h), this.vert(q[3], N, 0, h)];
            if (ok) { this.tri(vs[0], vs[1], vs[2]); this.tri(vs[0], vs[2], vs[3]); }
            else { this.tri(vs[0], vs[2], vs[1]); this.tri(vs[0], vs[3], vs[2]); }
        };
        const triL = (p0: [number, number, number], p1: [number, number, number], p2: [number, number, number], nl: [number, number, number]): void => {
            const N = nW(nl), q = [p0, p1, p2].map(p => pt(p));
            const fn = cross3([q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]], [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]]);
            const vs = q.map(p => this.vert(p, N, 0, 0));
            if (fn[0] * N[0] + fn[1] * N[1] + fn[2] * N[2] >= 0) this.tri(vs[0], vs[1], vs[2]); else this.tri(vs[0], vs[2], vs[1]);
        };
        // 6 main faces.
        for (let f = 0; f < 3; f++) {
            const o1 = (f + 1) % 3, o2 = (f + 2) % 3;
            for (const sf of [-1, 1]) {
                const nl: [number, number, number] = [0, 0, 0]; nl[f] = sf;
                quadL(fv(f, sf, o1, -1, o2, -1), fv(f, sf, o1, 1, o2, -1), fv(f, sf, o1, 1, o2, 1), fv(f, sf, o1, -1, o2, 1), nl);
            }
        }
        // 12 edge strips: the edge between face (f1, s1) and face (f2, s2), running along the third axis o.
        for (let o = 0; o < 3; o++) {
            const f1 = (o + 1) % 3, f2 = (o + 2) % 3;
            for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
                const a0 = fv(f1, s1, f2, s2, o, -1), a1 = fv(f1, s1, f2, s2, o, 1);
                const b1 = fv(f2, s2, f1, s1, o, 1), b0 = fv(f2, s2, f1, s1, o, -1);
                const nl: [number, number, number] = [0, 0, 0]; nl[f1] = s1; nl[f2] = s2;
                quadL(a0, a1, b1, b0, nl);
            }
        }
        // 8 corner triangles.
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
            const S = [sx, sy, sz];
            triL(fv(0, sx, 1, sy, 2, sz), fv(1, sy, 2, sz, 0, sx), fv(2, sz, 0, sx, 1, sy), [S[0], S[1], S[2]]);
        }
    }

    /** Translate the POSITIONS of every vertex from index `from` on (P12: the instanced crowd's rigid per-person drape
     *  offset, applied right after the person is emitted — the same f32 add the drape pass does per vertex). */
    offsetFrom(from: number, dx: number, dy: number, dz: number): void {
        const vs = this.verts;
        for (let o = from * FLOATS_PER_VERT, e = this.vCount * FLOATS_PER_VERT; o < e; o += FLOATS_PER_VERT) { vs[o] += dx; vs[o + 1] += dy; vs[o + 2] += dz; }
    }
    /** Read-only view of the written interleaved vertices (P12: merging the crowd's per-colour accumulators). */
    get vertexView(): Float32Array { return this.verts.subarray(0, this.vCount * FLOATS_PER_VERT); }
    /** Read-only view of the written indices. */
    get indexView(): Uint32Array { return this.idxArr.subarray(0, this.iCount); }

    geometry(): MeshGeometry {
        // Right-sized COPIES (slice), never views into the capacity buffers — consumers may retain / transfer them.
        const g: MeshGeometry = {
            vertices: this.verts.slice(0, this.vCount * FLOATS_PER_VERT),
            indices: this.idxArr.slice(0, this.iCount),
            format: '12float',
        };
        // P20: closed prop parts ride on the geometry (consumed + removed by the tile build's instancing pass).
        if (this._parts && this._parts.length) {
            const P = this._parts;
            let n = 0;
            for (let k = 0; k < P.length; k += PART_STRIDE) if (P[k + 1] >= 0) n++;
            if (n) {
                const out = new Float64Array(n * PART_STRIDE);
                let o = 0;
                for (let k = 0; k < P.length; k += PART_STRIDE) if (P[k + 1] >= 0) { for (let j = 0; j < PART_STRIDE; j++) out[o + j] = P[k + j]; o += PART_STRIDE; }
                const gp = g as MeshGeometry & { parts?: Float64Array; partLocal?: Float64Array };
                gp.parts = out;
                gp.partLocal = this._pl ? this._pl.slice(0, this._plN) : new Float64Array(0);
            }
        }
        return g;
    }
}

/** P20: numbers per recorded part — v0, v1, i0, i1, origin xyz, forward xz (unit), offset of its first vertex in
 *  `partLocal` (8 doubles a vertex: the part-frame position, normal, uv). */
export const PART_STRIDE = 10;
/** P20 auto parts: an obox's frame +Z — `az` when the box stands upright (ay = world up, az horizontal: the box then
 *  turns with the yaw), else no turn. */
export function oboxPartFwd(ay: V3, az: V3): V2 {
    const up = Math.abs(ay[1] - 1) < 1e-9 && Math.abs(ay[0]) < 1e-9 && Math.abs(ay[2]) < 1e-9 && Math.abs(az[1]) < 1e-9;
    const h = Math.hypot(az[0], az[2]);
    return up && h > 1e-9 ? [az[0] / h, az[2] / h] : [0, 1];
}
/** P20 auto parts: a beam's frame +Z — its horizontal direction when the beam's own basis uses world up (it then turns
 *  with the yaw), else no turn. */
export function beamPartFwd(a: V3, b: V3): V2 {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz), h = Math.hypot(dx, dz);
    return L > 1e-5 && Math.abs(dy / L) < 0.9 && h > 1e-9 ? [dx / h, dz / h] : [0, 1];
}
/** P20: part recording is on only while a streamed tile builds (see Accum3D.beginPart). */
const PART_REC = { on: false };
/** Turn P20 part recording on / off (the tile build brackets its synchronous builder calls; returns the old state). */
export function setPartRecording(on: boolean): boolean { const was = PART_REC.on; PART_REC.on = on; return was; }
/** Is P20 part recording on (builders may skip part bookkeeping otherwise). */
export function partRecording(): boolean { return PART_REC.on; }
type PartGeo = MeshGeometry & { parts?: Float64Array; partLocal?: Float64Array };
/** P20: carry `src`'s prop parts onto `dst` = src scaled by `k` (positions, about the origin) and lifted by `dy` (the
 *  building merge: metres → world units, dropped to the lot). Normals / uv are unchanged by a uniform scale. */
export function scalePartsInto(src: MeshGeometry, dst: MeshGeometry, k: number, dy: number): void {
    const s = src as PartGeo;
    if (!s.parts || !s.parts.length) return;
    const P = s.parts.slice();
    for (let j = 0; j < P.length; j += PART_STRIDE) { P[j + 4] *= k; P[j + 5] = P[j + 5] * k + dy; P[j + 6] *= k; }
    const L = s.partLocal ? s.partLocal.slice() : new Float64Array(0);
    for (let j = 0; j < L.length; j += 8) { L[j] *= k; L[j + 1] *= k; L[j + 2] *= k; }
    (dst as PartGeo).parts = P; (dst as PartGeo).partLocal = L;
}
/** P20: the prop parts of `geos` concatenated in order (mergeGeos: vertex / index offsets + the partLocal offset). */
export function mergePartsInto(geos: readonly MeshGeometry[], dst: MeshGeometry): void {
    if (!geos.some(g => (g as PartGeo).parts?.length)) return;
    let np = 0, nl = 0;
    for (const g of geos) { np += (g as PartGeo).parts?.length ?? 0; nl += (g as PartGeo).partLocal?.length ?? 0; }
    const P = new Float64Array(np), L = new Float64Array(nl);
    let po = 0, lo = 0, vb = 0, ib = 0;
    for (const g of geos) {
        const gp = g as PartGeo;
        if (gp.parts) {
            for (let j = 0; j < gp.parts.length; j += PART_STRIDE) {
                for (let q = 0; q < PART_STRIDE; q++) P[po + j + q] = gp.parts[j + q];
                P[po + j] += vb; P[po + j + 1] += vb; P[po + j + 2] += ib; P[po + j + 3] += ib; P[po + j + 9] += lo;
            }
            po += gp.parts.length;
        }
        if (gp.partLocal) { L.set(gp.partLocal, lo); lo += gp.partLocal.length; }
        vb += g.vertices.length / FLOATS_PER_VERT; ib += g.indices.length;
    }
    (dst as PartGeo).parts = P; (dst as PartGeo).partLocal = L;
}
/** P20: run `fn` (one prop's emission) as ONE part on every accumulator in `accs` (frame: origin `o`, +Z along `fwd`).
 *  Structural only — the geometry `fn` emits is unchanged. */
export function partOf<T>(accs: readonly (Accum3D | null | undefined)[], o: V3, fwd: V2, fn: () => T): T {
    if (!PART_REC.on) return fn();
    for (const a of accs) a?.beginPart(o, fwd);
    try { return fn(); } finally { for (const a of accs) a?.endPart(); }
}

const frac = (x: number): number => x - Math.floor(x);
function norm3(v: V3): V3 { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ── E2 EDGE CHIPS (persona-polish-plan.md E2) ─────────────────────────────────────────────────────────
// A BUILD-TIME chipper for the sharp edges of stone / concrete pieces (stair nosings, kerbs, copings, plinths,
// benches, planters). A piece is described as a 2D PROFILE extruded along a straight (possibly sloped) edge; each
// profile corner flagged in `chip` gets an eased arris plus deterministic, position-hashed NOTCHES (short shallow
// chips), occasional BITES (longer, deeper) and optional CORNER chips at the extrusion ends. It is all geometry: no
// material slot, no flag bit, no vertex channel. The edge-distance WEAR shading is baked the same way: a thin band
// beside every chipped corner, plus the chamfer facets themselves, go into a separate `wear` accumulator that the
// caller draws with a slightly lighter tint of the same material.
//
// The same call with `spec: null` emits the CLEAN piece (sharp corners, identical UVs), so a caller builds its far
// twin and its near (chipped) twin from one description and they can never disagree on texture placement.
//
// Creator props: build the prop's stone parts with chipExtrude (a box = a closed 4-point profile), pass
// edgeChipSpec(level, unitsPerMetre, seed) for the level the user picked, and put the `wear` accumulator in a second
// layer (same material, tint x ~1.08). Cost ≈ 40 tris per chip on an open 3-point profile.

/** A hanging cable from `a` to `b`: `segs` straight pieces along a parabola with mid-span `sag`, as 3-sided beams of
 *  radius `r`. Shared by the street power lines (furniture.ts) and the railway catenary messenger (railway.ts). */
export function catenary(wire: Accum3D, a: V3, b: V3, sag: number, segs: number, r: number): void {
    let prev = a;
    for (let i = 1; i <= segs; i++) {
        const t = i / segs, dip = 4 * sag * t * (1 - t);
        const q: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - dip, a[2] + (b[2] - a[2]) * t];
        wire.beam(prev, q, r, 3);
        prev = q;
    }
}

/** Near/far twin distance (metres): chipped twins draw only for chunks within this of the camera. */
export const EDGE_CHIP_NEAR_M = 18;

/** The Look control's three settings (`LayoutParams.edgeWear`). */
export type EdgeWearLevel = 'off' | 'subtle' | 'heavy';

/** Edge-chip sizes. ALL LENGTHS ARE WORLD UNITS (see {@link edgeChipSpec} for the metre-based presets). */
export interface ChipSpec {
    /** Eased arris on every chipped corner all along the edge (0 = sharp between chips). */
    arris: number;
    /** Mean spacing between chips along an edge. */
    every: number;
    /** Notch = a short shallow chip. */
    notchLen: number; notchDepth: number;
    /** Chance [0..1] that a chip is a BITE (longer + deeper) instead of a notch. */
    biteChance: number; biteLen: number; biteDepth: number;
    /** Chance [0..1] that each END of an edge (a corner of the piece) is broken off. */
    endChance: number; endLen: number; endDepth: number;
    /** Width of the worn band beside each chipped corner (into the `wear` accumulator). 0 = no band. */
    wearBand: number;
    /** Mixed into the position hash (different families of pieces chip differently). */
    seed: number;
}

/** The Look presets. `unitsPerMetre` = world units per metre (the city is a diorama: 1 / cityMetresPerUnit).
 *  `every` scales the chip spacing (kerbs run for kilometres, so they chip more sparsely than a stair). */
export function edgeChipSpec(level: EdgeWearLevel | undefined, unitsPerMetre: number, seed = 0, every = 1): ChipSpec | null {
    if (level !== 'subtle' && level !== 'heavy') return null;
    const m = unitsPerMetre, h = level === 'heavy';
    return {
        arris: 0.004 * m,
        every: (h ? 0.5 : 1.2) * every * m,
        notchLen: (h ? 0.06 : 0.045) * m, notchDepth: (h ? 0.013 : 0.008) * m,
        biteChance: h ? 0.35 : 0.15, biteLen: (h ? 0.17 : 0.11) * m, biteDepth: (h ? 0.032 : 0.018) * m,
        endChance: h ? 0.85 : 0.45, endLen: (h ? 0.11 : 0.07) * m, endDepth: (h ? 0.03 : 0.018) * m,
        wearBand: (h ? 0.028 : 0.016) * m,
        seed,
    };
}

/** Options for {@link chipExtrude}. */
export interface ChipExtrudeOpts {
    /** Closed profile (a solid bar, CCW in (ua, va)); default false = an OPEN strip (faces meeting at corners). */
    closed?: boolean;
    /** Per profile POINT: chip that corner. The two end points of an open profile are never chipped. */
    chip?: boolean[];
    /** Chip sizes; null / undefined = the CLEAN twin (sharp corners, same UVs). */
    spec?: ChipSpec | null;
    /** Where the chamfer facets + worn bands go (default: `acc` itself, i.e. no separate wear tint). */
    wear?: Accum3D | null;
    /** UV = world length x uvPerUnit (+ u0 along the edge, + v0 around the profile). Default 1 (world units). */
    uvPerUnit?: number; u0?: number; v0?: number;
    /** Closed profiles: cap the start / end (default both). */
    caps?: [boolean, boolean];
    /** Allow corner chips at s = 0 / s = length (default both). Off where the piece continues into a neighbour. */
    endChips?: [boolean, boolean];
    /** UV override from the world position (+ the vertex normal and the station s) — e.g. the city ground's
     *  uv = worldXZ x 0.5 on a kerb top, so the chipped band tiles continuously with the strip beside it. */
    uvAt?: (p: V3, n: V3, s: number) => [number, number];
}

interface ChipEvent { s0: number; s1: number; dA: number; dB: number; kind: 0 | 1 | 2; q: number }   // kind 0 mid · 1 start · 2 end

/**
 * Extrude a 2D `profile` (points in the (ua, va) frame; walk it so the SOLID is on the LEFT, i.e. CCW when closed)
 * from `o` along the unit direction `along` for `length` world units, chipping the flagged corners (see the section
 * header). The frame need not be orthogonal (a sloped coping extrudes along its slope with va = up). Flat faces keep
 * exact flat normals; chamfer facets get per-station normals. Deterministic: chips are hashed from each corner's
 * world position, so a rebuild (or the worker) makes the identical piece.
 */
export function chipExtrude(acc: Accum3D, o: V3, along: V3, ua: V3, va: V3, length: number, profile: V2[], opts: ChipExtrudeOpts = {}): void {
    const np = profile.length; if (np < 2 || !(length > 0)) return;
    const closed = !!opts.closed && np >= 3;
    const spec = opts.spec ?? null, wearAcc = opts.wear ?? acc, uvk = opts.uvPerUnit ?? 1, u0 = opts.u0 ?? 0, v0 = opts.v0 ?? 0;
    const endChips = opts.endChips ?? [true, true];
    const ne = closed ? np : np - 1;   // profile edges
    const dir: V2[] = [], nrm: V2[] = [], len: number[] = [], cum: number[] = [0];
    for (let j = 0; j < ne; j++) {
        const a = profile[j], b = profile[(j + 1) % np], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1e-9;
        dir.push([dx / l, dy / l]); nrm.push([dy / l, -dx / l]); len.push(l); cum.push(cum[j] + l);   // solid on the left → outward = right
    }
    const P3 = (s: number, p: V2): V3 => [o[0] + along[0] * s + ua[0] * p[0] + va[0] * p[1], o[1] + along[1] * s + ua[1] * p[0] + va[1] * p[1], o[2] + along[2] * s + ua[2] * p[0] + va[2] * p[1]];
    const N3 = (n: V2): V3 => norm3([ua[0] * n[0] + va[0] * n[1], ua[1] * n[0] + va[1] * n[1], ua[2] * n[0] + va[2] * n[1]]);
    const eIn = (k: number): number => closed ? (k - 1 + ne) % ne : k - 1;   // edge arriving at corner k
    const eOut = (k: number): number => closed ? k % ne : k;                 // edge leaving corner k
    const chipK: boolean[] = profile.map((_, k) => !!spec && !!opts.chip?.[k] && (closed || (k > 0 && k < np - 1)));
    // ── chip events per corner (position-hashed) → the station list along the edge ──
    const events: ChipEvent[][] = profile.map(() => []);
    const cst: Set<number>[] = profile.map(() => new Set<number>());   // each corner's own stations along the edge
    if (spec) for (let k = 0; k < np; k++) {
        if (!chipK[k]) continue;
        const w = P3(0, profile[k]);
        const qx = Math.round(w[0] * 4096), qy = Math.round(w[1] * 4096), qz = Math.round(w[2] * 4096);
        let ctr = 0;
        const rnd = (): number => hash2(qx + Math.imul(++ctr, 7919), qz ^ Math.imul(qy, 31), spec.seed * 131 + k * 17 + 0x5c1f);
        const ev = events[k];
        const add = (e: ChipEvent): void => { ev.push(e); for (const t of (e.kind === 0 ? [0, 0.25, 0.6, 1] : [0, 0.5, 1])) cst[k].add(Math.min(length, Math.max(0, e.s0 + (e.s1 - e.s0) * t))); };
        if (endChips[0] && rnd() < spec.endChance) {
            const l = spec.endLen * (0.6 + 0.8 * rnd()), d = spec.endDepth * (0.6 + 0.8 * rnd());
            add({ s0: 0, s1: Math.min(l, length * 0.45), dA: d * (0.5 + rnd()), dB: d * (0.5 + rnd()), kind: 1, q: 0.55 });
        }
        if (endChips[1] && rnd() < spec.endChance) {
            const l = spec.endLen * (0.6 + 0.8 * rnd()), d = spec.endDepth * (0.6 + 0.8 * rnd());
            add({ s0: Math.max(length - l, length * 0.55), s1: length, dA: d * (0.5 + rnd()), dB: d * (0.5 + rnd()), kind: 2, q: 0.55 });
        }
        let s = spec.every * (0.2 + 0.9 * rnd());
        while (s < length) {
            const bite = rnd() < spec.biteChance;
            const l = (bite ? spec.biteLen : spec.notchLen) * (0.6 + 0.8 * rnd()), d = (bite ? spec.biteDepth : spec.notchDepth) * (0.6 + 0.8 * rnd());
            if (s + l > length - spec.endLen) break;
            add({ s0: s, s1: s + l, dA: d * (0.45 + 0.9 * rnd()), dB: d * (0.45 + 0.9 * rnd()), kind: 0, q: 0.35 + 0.65 * rnd() });
            s += l + spec.every * (0.3 + 1.4 * rnd());
        }
    }
    // A strip only needs the stations of the corners it touches (a chip on one arris must not dice every face of the
    // bar): the shared edge of two strips moves with ONE corner, so the extra stations on the other strip lie exactly
    // on that edge's straight pieces (collinear T-junctions, no crack).
    const stationsFor = (corners: number[]): number[] => {
        const all = new Set<number>([0, length]);
        for (const c of corners) if (c >= 0) for (const v of cst[c]) all.add(v);
        return [...all].sort((a, b) => a - b).filter((v, i, arr) => i === 0 || v - arr[i - 1] > length * 1e-6);
    };
    // Chip profile over one event, 0..1 (piecewise linear through its station key points: mid 0/.25/.6/1, ends 0/.5/1).
    const shape = (e: ChipEvent, s: number): number => {
        if (s < e.s0 || s > e.s1 || e.s1 <= e.s0) return 0;
        const t = (s - e.s0) / (e.s1 - e.s0);
        if (e.kind === 1) return t < 0.5 ? 1 - (1 - e.q) * t / 0.5 : e.q * (1 - (t - 0.5) / 0.5);
        if (e.kind === 2) return t > 0.5 ? 1 - (1 - e.q) * (1 - t) / 0.5 : e.q * t / 0.5;
        if (t < 0.25) return t / 0.25;
        if (t < 0.6) return 1 + (e.q - 1) * (t - 0.25) / 0.35;
        return e.q * (1 - (t - 0.6) / 0.4);
    };
    // Corner k's two cut depths at station s: A along the incoming edge, B along the outgoing one.
    const depth = (k: number, s: number): [number, number] => {
        let a = spec ? spec.arris : 0, b = a;
        for (const e of events[k]) { const f = shape(e, s); if (f > 0) { a = Math.max(a, spec!.arris + f * e.dA); b = Math.max(b, spec!.arris + f * e.dB); } }
        return [Math.min(a, len[eIn(k)] * 0.42), Math.min(b, len[eOut(k)] * 0.42)];
    };
    const band = spec ? spec.wearBand : 0;
    // ── the expanded profile at one station ──
    // seg kind: 0 main face · 1 worn band · 2 chamfer (corner = which profile corner). v = UV around the profile.
    type Pt = { p: V2; v: number };
    type Seg = { kind: 0 | 1 | 2; edge: number; corner: number };
    const ptCorner: number[] = [];   // the corner each expanded point moves with (-1 = a fixed profile point)
    const expand = (s: number): { pts: Pt[]; seg: Seg[] } => {
        const pts: Pt[] = [], seg: Seg[] = [];
        const rec = ptCorner.length === 0;
        for (let k = 0; k < np; k++) {
            const P = profile[k], last = !closed && k === np - 1;
            if (!chipK[k]) {
                pts.push({ p: P, v: cum[k] }); if (rec) ptCorner.push(-1);
                if (!last) seg.push({ kind: 0, edge: eOut(k), corner: -1 });
                continue;
            }
            const [dA, dB] = depth(k, s);
            const ei = eIn(k), eo = eOut(k), tp = dir[ei], tn = dir[eo];
            const vIn = closed && k === 0 ? cum[ne] : cum[k];   // arc length of corner k measured along its incoming edge
            const bA = band > 0 ? Math.max(0, Math.min(band, len[ei] * 0.48 - dA)) : 0, bB = band > 0 ? Math.max(0, Math.min(band, len[eo] * 0.48 - dB)) : 0;
            const n0 = pts.length;
            if (band > 0) { pts.push({ p: [P[0] - tp[0] * (dA + bA), P[1] - tp[1] * (dA + bA)], v: vIn - dA - bA }); seg.push({ kind: 1, edge: ei, corner: k }); }
            pts.push({ p: [P[0] - tp[0] * dA, P[1] - tp[1] * dA], v: vIn - dA }); seg.push({ kind: 2, edge: -1, corner: k });
            pts.push({ p: [P[0] + tn[0] * dB, P[1] + tn[1] * dB], v: cum[k] + dB });
            if (band > 0) { seg.push({ kind: 1, edge: eo, corner: k }); pts.push({ p: [P[0] + tn[0] * (dB + bB), P[1] + tn[1] * (dB + bB)], v: cum[k] + dB + bB }); }
            if (rec) for (let q = n0; q < pts.length; q++) ptCorner.push(k);
            if (!last) seg.push({ kind: 0, edge: eo, corner: -1 });
        }
        return { pts, seg };
    };
    const memo = new Map<number, { pts: Pt[]; seg: Seg[] }>();
    const rowAt = (s: number): { pts: Pt[]; seg: Seg[] } => { let r = memo.get(s); if (!r) { r = expand(s); memo.set(s, r); } return r; };
    const first = rowAt(0);
    const nPts = first.pts.length, segs = first.seg;
    const tiny = length * 1e-7;
    for (let g = 0; g < segs.length; g++) {
        const { kind, edge, corner } = segs[g];
        const target = kind === 0 ? acc : wearAcc;
        const i0 = g, i1 = (g + 1) % nPts;
        const S = stationsFor([ptCorner[i0], ptCorner[i1]]);
        const rows = S.map(rowAt);
        const width = (si: number): number => { const a = rows[si].pts[i0].p, b = rows[si].pts[i1].p; return Math.hypot(b[0] - a[0], b[1] - a[1]); };
        let live = false;
        for (let si = 0; si < S.length; si++) if (width(si) > tiny) { live = true; break; }
        if (!live) continue;   // degenerate at every station (e.g. a band clamped to zero)
        // Outward 2D normal of this strip at station si (flat faces: the profile edge's; a chamfer: its cut's).
        const n2At = (si: number): V2 => {
            if (edge >= 0) return nrm[edge];
            const a = rows[si].pts[i0].p, b = rows[si].pts[i1].p, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
            if (l > tiny) return [dy / l, -dx / l];
            const na = nrm[eIn(corner)], nb = nrm[eOut(corner)], x = na[0] + nb[0], y = na[1] + nb[1], lb = Math.hypot(x, y) || 1;
            return [x / lb, y / lb];   // zero cut: the corner bisector
        };
        const ids: [number, number][] = [];
        for (let si = 0; si < S.length; si++) {
            const a = rows[si].pts[i0], b = rows[si].pts[i1], N = N3(n2At(si)), u = S[si] * uvk + u0;
            const pa = P3(S[si], a.p), pb = P3(S[si], b.p);
            if (opts.uvAt) {
                const ta = opts.uvAt(pa, N, S[si]), tb = opts.uvAt(pb, N, S[si]);
                ids.push([target.vertex(pa, N, ta[0], ta[1]), target.vertex(pb, N, tb[0], tb[1])]);
            } else ids.push([target.vertex(pa, N, u, a.v * uvk + v0), target.vertex(pb, N, u, b.v * uvk + v0)]);
        }
        for (let si = 0; si + 1 < S.length; si++) {
            if (width(si) <= tiny && width(si + 1) <= tiny) continue;
            const A0 = rows[si].pts[i0].p, B0 = rows[si].pts[i1].p, B1 = rows[si + 1].pts[i1].p, A1 = rows[si + 1].pts[i0].p;
            const pa = P3(S[si], A0), pb = P3(S[si], B0), pd = P3(S[si + 1], A1), pc = P3(S[si + 1], B1);
            // Wind the quad so its geometric normal agrees with the outward normal (the frame may be left-handed).
            const fn = cross3([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pd[0] - pa[0], pd[1] - pa[1], pd[2] - pa[2]]);
            const fn2 = cross3([pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]], [pd[0] - pb[0], pd[1] - pb[1], pd[2] - pb[2]]);
            const want = N3(n2At(si));
            const ok = (fn[0] + fn2[0]) * want[0] + (fn[1] + fn2[1]) * want[1] + (fn[2] + fn2[2]) * want[2] >= 0;
            const [a0, b0] = ids[si], [a1, b1] = ids[si + 1];
            if (ok) { target.triangle(a0, b0, b1); target.triangle(a0, b1, a1); }
            else { target.triangle(a0, b1, b0); target.triangle(a0, a1, b1); }
        }
    }
    // ── end caps (closed profiles): a fan over the expanded ring at s = 0 / s = length ──
    if (closed) {
        const caps = opts.caps ?? [true, true];
        for (const end of [0, 1] as const) {
            if (!caps[end]) continue;
            const s = end ? length : 0, r = rowAt(s);
            const N: V3 = end ? [along[0], along[1], along[2]] : [-along[0], -along[1], -along[2]];
            let cx = 0, cy = 0; for (const q of r.pts) { cx += q.p[0]; cy += q.p[1]; } cx /= r.pts.length; cy /= r.pts.length;
            const pc = P3(s, [cx, cy]);
            const c = acc.vertex(pc, N, cx * uvk + u0, cy * uvk + v0);
            const ring = r.pts.map(q => acc.vertex(P3(s, q.p), N, q.p[0] * uvk + u0, q.p[1] * uvk + v0));
            for (let i = 0; i < ring.length; i++) {
                const j = (i + 1) % ring.length, pa = P3(s, r.pts[i].p), pb = P3(s, r.pts[j].p);
                const fn = cross3([pa[0] - pc[0], pa[1] - pc[1], pa[2] - pc[2]], [pb[0] - pc[0], pb[1] - pc[1], pb[2] - pc[2]]);
                if (Math.hypot(fn[0], fn[1], fn[2]) < tiny * tiny) continue;
                if (fn[0] * N[0] + fn[1] * N[1] + fn[2] * N[2] >= 0) acc.triangle(c, ring[i], ring[j]); else acc.triangle(c, ring[j], ring[i]);
            }
        }
    }
}
