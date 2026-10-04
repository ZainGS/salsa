/**
 * P11 (docs/specs/performance-plan.md, docs/specs/occlusion-culling.md): CPU software OCCLUSION culling.
 *
 * Each frame the renderer rasterises a few big OCCLUDERS (the city's building walls) into a small depth buffer from
 * the camera it is about to draw with, then drops every main-pass mesh / instanced group whose world box lies wholly
 * behind them. Same frame, same view-projection matrix: there is no latency, so nothing can pop in late while the
 * camera turns.
 *
 * CONSERVATIVE BY CONSTRUCTION (the rules that make it artefact-free):
 *  - An occluder marks a pixel only when the pixel's whole square lies inside ONE convex occluder polygon (all four
 *    corners inside; a coplanar triangle pair sharing an edge is merged into its quad first, so a wall quad has no
 *    hole along its diagonal). Gaps between occluders, sub-pixel slivers and silhouettes are never marked.
 *  - The stored depth is the polygon's FARTHEST view depth over that pixel square (1/w is affine in screen space, so
 *    its minimum over the square is at a corner).
 *  - A box is hidden only when EVERY pixel its projection touches is marked and nearer than the box's nearest point
 *    (view depth is linear in world space, so a box's nearest depth is at one of its corners). A box crossing the near
 *    plane is always visible. Pixels off screen are skipped (that part of the box is outside the view anyway).
 *  - Depth is the clip w (the view distance), compared with a small relative margin.
 * So a pixel of a "hidden" box can only be on screen where an opaque occluder is drawn in front of it. The only
 * inputs that must hold are that the occluders are really drawn (opaque, depth-writing, no discard) with the matrix
 * given to begin().
 *
 * Pure (no WebGPU): unit-tested in occlusion-culler.test.ts.
 */

/** Occluder triangles in WORLD space, 9 floats per triangle, plus the quads merged from coplanar pairs. */
export interface OccluderGeometry {
  /** Convex polygons in world space: `polys[i]` = flat xyz list (3 or 4 vertices). */
  polys: Float32Array[];
  /** World box of all polygons (for a cheap frustum skip). */
  box: [number, number, number, number, number, number];
}

const NEAR_EPS = 1e-6;

/**
 * Build an occluder's world-space polygons from an indexed triangle mesh (`stride` floats per vertex, position first)
 * transformed by the column-major `m` (null = identity). Consecutive triangles that share an edge, are coplanar and
 * form a convex quad are merged (Accum3D emits a quad as two consecutive triangles). Degenerate triangles are dropped.
 * `minArea` (world units²) drops polygons too small to matter as occluders.
 */
export function buildOccluderGeometry(vertices: ArrayLike<number>, indices: ArrayLike<number>, stride: number,
                                      m: ArrayLike<number> | null, minArea = 0, first = 0, count = indices.length): OccluderGeometry {
  const W = (i: number, out: number[]): void => {
    const b = i * stride, x = vertices[b], y = vertices[b + 1], z = vertices[b + 2];
    if (!m) { out.push(x, y, z); return; }
    out.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
  };
  const polys: Float32Array[] = [];
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const end = Math.min(indices.length, first + count);
  const tri = (q: number): number[] => { const p: number[] = []; W(indices[q], p); W(indices[q + 1], p); W(indices[q + 2], p); return p; };
  const normalArea = (p: number[]): [number, number, number, number] => {
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    return [nx / (l || 1), ny / (l || 1), nz / (l || 1), l * 0.5];
  };
  const push = (p: number[]): void => {
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
      if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2];
    }
    polys.push(new Float32Array(p));
  };
  let q = first - (first % 3);
  while (q + 2 < end) {
    const a = tri(q), na = normalArea(a);
    if (!(na[3] > 1e-12)) { q += 3; continue; }
    if (q + 5 < end) {
      const b = tri(q + 3), nb = normalArea(b);
      const quad = nb[3] > 1e-12 && mergeQuad(a, na, b, nb);
      if (quad) { if (na[3] + nb[3] >= minArea) push(quad); q += 6; continue; }
    }
    if (na[3] >= minArea) push(a);
    q += 3;
  }
  return { polys, box: [x0, y0, z0, x1, y1, z1] };
}

/** Two triangles sharing exactly one edge, coplanar (same plane within a tight tolerance) and convex together → the
 *  quad's 4 vertices in order; otherwise null. */
function mergeQuad(a: number[], na: number[], b: number[], nb: number[]): number[] | null {
  const dot = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
  if (Math.abs(dot) < 0.99999) return null;
  const same = (i: number, j: number): boolean => {
    const dx = a[i * 3] - b[j * 3], dy = a[i * 3 + 1] - b[j * 3 + 1], dz = a[i * 3 + 2] - b[j * 3 + 2];
    return dx * dx + dy * dy + dz * dz <= 1e-12 * (1 + a[i * 3] * a[i * 3] + a[i * 3 + 2] * a[i * 3 + 2]);
  };
  // find the shared edge
  const map = [-1, -1, -1];
  let shared = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (same(i, j)) { map[i] = j; shared++; }
  if (shared !== 2) return null;
  const lone = map.indexOf(-1);           // a's vertex not on the shared edge
  let bLone = -1;
  for (let j = 0; j < 3; j++) if (!map.includes(j)) bLone = j;
  if (bLone < 0) return null;
  // coplanar: b's lone vertex on a's plane
  const px = b[bLone * 3] - a[0], py = b[bLone * 3 + 1] - a[1], pz = b[bLone * 3 + 2] - a[2];
  const ext = Math.hypot(a[3] - a[0], a[4] - a[1], a[5] - a[2]) + 1e-9;
  if (Math.abs(px * na[0] + py * na[1] + pz * na[2]) > 1e-5 * ext) return null;
  // quad order: lone(a), next(a), bLone, next-next(a)  — the shared edge is (lone+1, lone+2)
  const i1 = (lone + 1) % 3, i2 = (lone + 2) % 3;
  const v = (src: number[], k: number): number[] => [src[k * 3], src[k * 3 + 1], src[k * 3 + 2]];
  const quad = [...v(a, lone), ...v(a, i1), ...v(b, bLone), ...v(a, i2)];
  // convex: every consecutive cross product points along the normal
  for (let k = 0; k < 4; k++) {
    const p0 = k * 3, p1 = ((k + 1) % 4) * 3, p2 = ((k + 2) % 4) * 3;
    const ux = quad[p1] - quad[p0], uy = quad[p1 + 1] - quad[p0 + 1], uz = quad[p1 + 2] - quad[p0 + 2];
    const wx = quad[p2] - quad[p1], wy = quad[p2 + 1] - quad[p1 + 1], wz = quad[p2 + 2] - quad[p1 + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (cx * na[0] + cy * na[1] + cz * na[2] <= 0) return null;
  }
  return quad;
}

export class OcclusionCuller {
  /** Buffer width in pixels (the height follows the view's aspect). */
  width = 256;
  private _w = 0; private _h = 0;
  /** Per pixel: the farthest view depth of a fully covering occluder (Infinity = not covered). */
  private _depth = new Float32Array(0);
  /** Max-depth pyramid: level 0 = _depth, level k = max over 2^k × 2^k pixels. */
  private _mips: Float32Array[] = [];
  private _mipW: number[] = []; private _mipH: number[] = [];
  private _vp = new Float32Array(16);
  private _planes = new Float32Array(24);
  private _rowLo = new Int32Array(0);
  private _rowHi = new Int32Array(0);
  /** Diagnostics for the last frame. */
  stats = { occluderPolys: 0, polysDrawn: 0, pixelsCovered: 0, tested: 0, culled: 0, ms: 0 };

  get bufferWidth(): number { return this._w; }
  get bufferHeight(): number { return this._h; }
  /** The raw depth buffer (tests / debug views). */
  get depth(): Float32Array { return this._depth; }

  /** Start a frame: `vp` = the column-major view-projection the frame renders with (WebGPU clip z 0..1). */
  begin(vp: ArrayLike<number>, viewW: number, viewH: number): void {
    const W = Math.max(8, this.width | 0), H = Math.max(4, Math.round(W * (viewH > 0 && viewW > 0 ? viewH / viewW : 0.6)));
    if (W !== this._w || H !== this._h) {
      this._w = W; this._h = H;
      this._depth = new Float32Array(W * H);
      this._rowLo = new Int32Array(H + 1); this._rowHi = new Int32Array(H + 1);
      this._mips = [this._depth]; this._mipW = [W]; this._mipH = [H];
      let w = W, h = H;
      while (w > 1 || h > 1) { w = Math.max(1, (w + 1) >> 1); h = Math.max(1, (h + 1) >> 1); this._mips.push(new Float32Array(w * h)); this._mipW.push(w); this._mipH.push(h); }
    }
    this._depth.fill(Infinity);
    for (let i = 0; i < 16; i++) this._vp[i] = vp[i];
    // frustum planes (Gribb-Hartmann, WebGPU z 0..1) for the occluder box skip
    const m = this._vp, P = this._planes;
    const set = (k: number, a: number, b: number, c: number, d: number): void => { P[k * 4] = a; P[k * 4 + 1] = b; P[k * 4 + 2] = c; P[k * 4 + 3] = d; };
    set(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);
    set(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);
    set(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);
    set(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);
    set(4, m[2], m[6], m[10], m[14]);
    set(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);
    const s = this.stats; s.occluderPolys = 0; s.polysDrawn = 0; s.pixelsCovered = 0; s.tested = 0; s.culled = 0;
  }

  private _boxInFrustum(b: ArrayLike<number>): boolean {
    const P = this._planes;
    for (let k = 0; k < 6; k++) {
      const a = P[k * 4], bb = P[k * 4 + 1], c = P[k * 4 + 2], d = P[k * 4 + 3];
      if (a * (a >= 0 ? b[3] : b[0]) + bb * (bb >= 0 ? b[4] : b[1]) + c * (c >= 0 ? b[5] : b[2]) + d < 0) return false;
    }
    return true;
  }

  /** Rasterise one occluder (all its polygons). */
  addOccluder(g: OccluderGeometry): void {
    if (!this._boxInFrustum(g.box)) return;
    for (let i = 0; i < g.polys.length; i++) this.addPolygon(g.polys[i]);
  }

  // scratch for clipping
  private _clip: number[] = [];
  private _clip2: number[] = [];
  private _sx: number[] = []; private _sy: number[] = []; private _siw: number[] = [];

  /** Rasterise one convex world-space polygon (flat xyz list). */
  addPolygon(p: ArrayLike<number>): void {
    this.stats.occluderPolys++;
    const m = this._vp, n = (p.length / 3) | 0;
    // to clip space (x, y, z, w)
    const c = this._clip; c.length = 0;
    let anyOut = false, allOut = true;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      c.push(cx, cy, cz, cw);
      if (cz < NEAR_EPS * Math.abs(cw) || cw <= NEAR_EPS) anyOut = true; else allOut = false;
    }
    if (allOut) return;
    let poly = c;
    if (anyOut) {
      // Sutherland-Hodgman against the near plane z_clip >= 0 (WebGPU); the result stays convex
      const o = this._clip2; o.length = 0;
      const k = poly.length / 4;
      for (let i = 0; i < k; i++) {
        const j = (i + 1) % k;
        const az = poly[i * 4 + 2], bz = poly[j * 4 + 2];
        const ain = az >= 0 && poly[i * 4 + 3] > NEAR_EPS, bin = bz >= 0 && poly[j * 4 + 3] > NEAR_EPS;
        if (ain) o.push(poly[i * 4], poly[i * 4 + 1], poly[i * 4 + 2], poly[i * 4 + 3]);
        if (ain !== bin) {
          const t = az / (az - bz);
          const w = poly[i * 4 + 3] + (poly[j * 4 + 3] - poly[i * 4 + 3]) * t;
          if (w > NEAR_EPS) o.push(poly[i * 4] + (poly[j * 4] - poly[i * 4]) * t, poly[i * 4 + 1] + (poly[j * 4 + 1] - poly[i * 4 + 1]) * t, 0, w);
        }
      }
      if (o.length < 12) return;
      poly = o;
    }
    const W = this._w, H = this._h, k = poly.length / 4;
    const sx = this._sx, sy = this._sy, siw = this._siw; sx.length = 0; sy.length = 0; siw.length = 0;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let i = 0; i < k; i++) {
      const w = poly[i * 4 + 3], iw = 1 / w;
      const x = (poly[i * 4] * iw * 0.5 + 0.5) * W, y = (0.5 - poly[i * 4 + 1] * iw * 0.5) * H;
      sx.push(x); sy.push(y); siw.push(iw);
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    // pixel range whose 4 corners may all be inside
    const px0 = Math.max(0, Math.ceil(minx)), px1 = Math.min(W, Math.floor(maxx));     // corner columns
    const py0 = Math.max(0, Math.ceil(miny)), py1 = Math.min(H, Math.floor(maxy));
    if (px1 - px0 < 1 || py1 - py0 < 1) return;
    // orientation (screen space) and 1/w plane: iw = A x + B y + C (affine in screen space for a planar polygon)
    let area = 0;
    for (let i = 0; i < k; i++) { const j = (i + 1) % k; area += sx[i] * sy[j] - sx[j] * sy[i]; }
    if (Math.abs(area) < 1e-9) return;
    const sgn = area > 0 ? 1 : -1;
    // plane through 3 well-spread vertices (0, 1, the last)
    const i0 = 0, i1 = 1, i2 = k - 1;
    const ux = sx[i1] - sx[i0], uy = sy[i1] - sy[i0], uw = siw[i1] - siw[i0];
    const vx = sx[i2] - sx[i0], vy = sy[i2] - sy[i0], vw = siw[i2] - siw[i0];
    const den = ux * vy - uy * vx;
    if (Math.abs(den) < 1e-12) return;
    const A = (uw * vy - uy * vw) / den, B = (ux * vw - uw * vx) / den, Cc = siw[i0] - A * sx[i0] - B * sy[i0];
    this.stats.polysDrawn++;
    // Per corner row y: the corner columns [lo, hi] inside every edge (a convex polygon's inside set on a row is one
    // interval). Edge function e(x) = (xj - xi)(y - yi) - (yj - yi)(x - xi); inside = sgn * e >= 0.
    const lo = this._rowLo, hi = this._rowHi;
    for (let y = py0; y <= py1; y++) {
      let xl = px0, xr = px1;
      for (let i = 0; i < k && xl <= xr; i++) {
        const j = i + 1 === k ? 0 : i + 1;
        const b = (sy[j] - sy[i]) * sgn, a = ((sx[j] - sx[i]) * (y - sy[i]) + (sy[j] - sy[i]) * sx[i]) * sgn;
        // sgn * e = a - b x >= 0
        if (b > 0) { const t = Math.floor(a / b - 1e-6); if (t < xr) xr = t; }
        else if (b < 0) { const t = Math.ceil(a / b + 1e-6); if (t > xl) xl = t; }
        else if (a < 0) { xl = 1; xr = 0; }
      }
      lo[y] = xl; hi[y] = xr;
    }
    // 1/w is affine: its minimum over a pixel square is at the corner picked by the signs of A and B
    const ox = A < 0 ? 1 : 0, oy = B < 0 ? 1 : 0;
    const D = this._depth;
    let covered = 0;
    for (let y = py0; y < py1; y++) {
      const x0 = lo[y] > lo[y + 1] ? lo[y] : lo[y + 1];
      const x1 = (hi[y] < hi[y + 1] ? hi[y] : hi[y + 1]) - 1;   // pixel x covered needs corners x and x + 1
      if (x1 < x0) continue;
      const rowIw = B * (y + oy) + Cc;
      for (let x = x0; x <= x1; x++) {
        const iw = A * (x + ox) + rowIw;
        if (!(iw > 0)) continue;
        const d = 1 / iw;   // the farthest view depth of the polygon over this pixel
        const o = y * W + x;
        if (d < D[o]) { D[o] = d; covered++; }
      }
    }
    this.stats.pixelsCovered += covered;
  }

  /** After the occluders: build the max-depth pyramid. */
  finish(): void {
    for (let l = 1; l < this._mips.length; l++) {
      const src = this._mips[l - 1], sw = this._mipW[l - 1], sh = this._mipH[l - 1];
      const dst = this._mips[l], dw = this._mipW[l], dh = this._mipH[l];
      for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const x0 = x * 2, y0 = y * 2, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        let v = src[y0 * sw + x0];
        const b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
        if (b > v) v = b; if (c > v) v = c; if (d > v) v = d;
        dst[y * dw + x] = v;
      }
    }
  }

  /** false = the world box is hidden behind the occluders (cull it). true = it may be visible. */
  testBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    this.stats.tested++;
    const m = this._vp, W = this._w, H = this._h;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, nearW = Infinity;
    for (let ci = 0; ci < 8; ci++) {
      const x = ci & 1 ? x1 : x0, y = ci & 2 ? y1 : y0, z = ci & 4 ? z1 : z0;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (cw <= NEAR_EPS || cz < 0) return true;   // crosses the near plane / behind the eye → visible
      const iw = 1 / cw;
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) * iw * 0.5 + 0.5) * W;
      const sy = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw * 0.5) * H;
      if (sx < minx) minx = sx; if (sx > maxx) maxx = sx; if (sy < miny) miny = sy; if (sy > maxy) maxy = sy;
      if (cw < nearW) nearW = cw;
    }
    // pixels touched (clamped to the screen: the part off screen is outside the view)
    let px0 = Math.floor(minx), px1 = Math.floor(maxx), py0 = Math.floor(miny), py1 = Math.floor(maxy);
    if (px1 < 0 || py1 < 0 || px0 >= W || py0 >= H) return true;   // off screen: the frustum test decides, not this
    if (px0 < 0) px0 = 0; if (py0 < 0) py0 = 0; if (px1 >= W) px1 = W - 1; if (py1 >= H) py1 = H - 1;
    const lim = nearW * (1 - 1e-4);
    // pick the pyramid level where the range is at most 4 texels a side
    let l = 0;
    while (l + 1 < this._mips.length && ((px1 >> l) - (px0 >> l) > 3 || (py1 >> l) - (py0 >> l) > 3)) l++;
    const mip = this._mips[l], mw = this._mipW[l];
    for (let y = py0 >> l; y <= (py1 >> l); y++) {
      for (let x = px0 >> l; x <= (px1 >> l); x++) {
        if (!(mip[y * mw + x] < lim)) return true;
      }
    }
    this.stats.culled++;
    return false;
  }
}

/** The meshes that may act as occluders: the city's building wall layers (detailed buildings' walls / party walls /
 *  plain ground floors, the plain-building and massing bodies). Opaque, untextured, never dissolved (fog class 0),
 *  drawn every frame. A/B / tuning: Renderer3D.OCCLUDER_NAMES. */
export const DEFAULT_OCCLUDER_NAMES = /^world:(detail-(wall|partywall|wallbase)|bldg-)/;

/** Occluder mesh shape the cache reads (a Mesh3D subset; keeps this module free of the scene graph). */
export interface OccluderSource {
  name: string;
  geometry: { vertices: Float32Array; indices: Uint32Array | Uint16Array | number[] } | null;
  localMatrix: ArrayLike<number>;
  localMatrixVersion: number;
}

/** World-space occluder polygons per mesh, rebuilt only when its geometry or matrix changes. */
export class OccluderCache {
  private _map = new WeakMap<object, { geo: object; ver: number; g: OccluderGeometry }>();
  /** Vertex stride of the meshes' geometry (Mesh3D: 12 floats, position first). */
  constructor(private readonly stride = 12) {}
  get(m: OccluderSource): OccluderGeometry | null {
    const geo = m.geometry;
    if (!geo || geo.vertices.length === 0 || geo.indices.length < 3) return null;
    const e = this._map.get(m);
    if (e && e.geo === geo && e.ver === m.localMatrixVersion) return e.g;
    const g = buildOccluderGeometry(geo.vertices, geo.indices, this.stride, m.localMatrix);
    this._map.set(m, { geo, ver: m.localMatrixVersion, g });
    return g;
  }
}
