// ── World generation — a tiny 3D geometry accumulator ───────────────────────────────────────────
// Builds merged low-poly (PS1-flavoured) meshes for the Biome + Street composers: cones (foliage), prisms
// (trunks / buildings), blobs (rocks). Everything appends into one MeshGeometry so a whole family of props is
// ONE draw call. Smooth-ish normals keep it compact; the retro material carries the faceted look.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../renderer/3d/mesh-generators';
import type { V2 } from './types';
import { triangulate } from './util';

type V3 = [number, number, number];

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
    get triCount(): number { return this.iCount / 3; }
    get empty(): boolean { return this.iCount === 0; }

    /** A vertical prism (n-gon cross-section) from base `c` up by `h`, radii `rx`,`rz`. Used for trunks + buildings. */
    prism(c: V3, rx: number, rz: number, h: number, sides = 4, rot = 0): void {
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

    /** Extrude a polygon's WALLS (each edge → a quad) from `baseY` up by `height`. Outward normals assume CCW input. */
    walls(poly: V2[], baseY: number, height: number): void {
        const n = poly.length; if (n < 3) return; const topY = baseY + height;
        for (let i = 0; i < n; i++) {
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
    wallsWin(poly: V2[], baseY: number, height: number, cellW: number, cellH: number): void {
        const n = poly.length; if (n < 3) return; const topY = baseY + height;
        const vMax = Math.max(1, Math.round(height / Math.max(cellH, 1e-6))) * cellH;
        for (let i = 0; i < n; i++) {
            const a = poly[i], b = poly[(i + 1) % n];
            const dx = b[0] - a[0], dz = b[1] - a[1], nl = Math.hypot(dx, dz) || 1, nx = dz / nl, nz = -dx / nl;
            const uMax = nl < cellW * 0.55 ? cellW * 0.2 : Math.max(1, Math.round(nl / cellW)) * cellW;
            const v0 = this.vert([a[0], baseY, a[1]], [nx, 0, nz], 0, 0), v1 = this.vert([b[0], baseY, b[1]], [nx, 0, nz], uMax, 0);
            const v2 = this.vert([b[0], topY, b[1]], [nx, 0, nz], uMax, vMax), v3 = this.vert([a[0], topY, a[1]], [nx, 0, nz], 0, vMax);
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
        const corner = (sx: number, sy: number, sz: number): V3 => [
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
        const centre = this.vert(c, n), ring: number[] = [];
        for (let i = 0; i < segs; i++) {
            const a = (i / segs) * Math.PI * 2, cx = Math.cos(a) * r, cy = Math.sin(a) * r;
            ring.push(this.vert([c[0] + u[0] * cx + v[0] * cy, c[1] + u[1] * cx + v[1] * cy, c[2] + u[2] * cx + v[2] * cy], n));
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

    /** A quad a→b→c→d with UNIT-square UVs (a=0,0 · b=1,0 · c=1,1 · d=0,1) — for alpha LEAF CARDS: the fragment
     *  maps a procedural leaf silhouette onto the 0..1 UV and alpha-discards outside it. */
    quadUV(a: V3, b: V3, c: V3, d: V3): void {
        const nr = norm3(cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]));
        const va = this.vert(a, nr, 0, 0), vb = this.vert(b, nr, 1, 0), vc = this.vert(c, nr, 1, 1), vd = this.vert(d, nr, 0, 1);
        this.tri(va, vb, vc); this.tri(va, vc, vd);
    }

    geometry(): MeshGeometry {
        // Right-sized COPIES (slice), never views into the capacity buffers — consumers may retain / transfer them.
        return {
            vertices: this.verts.slice(0, this.vCount * FLOATS_PER_VERT),
            indices: this.idxArr.slice(0, this.iCount),
            format: '12float',
        };
    }
}

const frac = (x: number): number => x - Math.floor(x);
function norm3(v: V3): V3 { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
