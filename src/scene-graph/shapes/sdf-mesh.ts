/**
 * SDF metaballs → mesh. Compose organic, blobby, BRANCHING forms (creatures, slime, coral, clouds) from signed
 * distance primitives that SMOOTHLY fuse where they meet — the technique box-modeling and revolve/tube can't do.
 *
 * Pipeline: evaluate a combined signed-distance field (spheres/capsules/… blended with a polynomial smooth-min) on
 * a uniform grid, extract the f=0 isosurface with NAIVE SURFACE NETS (smooth, one vertex per straddling cell),
 * take normals from the field GRADIENT (smooth for free), then UNWRAP into a PER-BLOB ATLAS: each triangle is
 * assigned to the blob it sits on and each blob gets its own packed UV island (seams land at the blob fusions —
 * the anatomy's hidden creases). Pure / CPU / unit-testable. Output is an indexed 8-float MeshGeometry
 * (setGeometry computes tangents).
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { simplifyMesh } from './mesh-simplify';

export type V3 = [number, number, number];

/** One signed-distance primitive. `a` = centre (or capsule segment start); `b` = capsule segment end; `radius` =
 *  sphere/capsule/torus-tube/box-rounding; `radii` = ellipsoid radii or box half-extents; `R` = torus major radius.
 *  `op:'subtract'` carves a cavity; `blend` = smooth-fuse radius (0 = a hard min). */
export interface SdfBlob {
  shape: 'sphere' | 'capsule' | 'ellipsoid' | 'box' | 'torus';
  a: V3;
  b?: V3;
  radius?: number;
  radii?: V3;
  R?: number;
  op?: 'union' | 'subtract';
  blend?: number;
}

// ── vector helpers ──
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Two unit vectors perpendicular to `n` (and to each other) — a stable frame for a chart projection. */
function orthoBasis(n: V3): [V3, V3] {
  const seed: V3 = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t = norm(cross(seed, n));
  return [t, norm(cross(n, t))];
}

/** A blob's NATURAL local UV for point `p` — the projection that flattens THAT primitive with least distortion:
 *  capsule/torus wrap cylindrically around their axis, sphere/ellipsoid map lat-long, box uses its dominant face.
 *  Returned UVs are un-normalised (any range); the packer rescales each chart to its atlas cell by bbox. */
function blobUV(blob: SdfBlob, p: V3): [number, number] {
  switch (blob.shape) {
    case 'capsule': {
      const a = blob.a, b = blob.b ?? blob.a;
      const axis = norm(sub(b, a));
      const [t1, t2] = orthoBasis(axis);
      const d = sub(p, a);
      return [Math.atan2(dot(d, t2), dot(d, t1)), dot(d, axis)];   // u = angle around, v = distance along
    }
    case 'torus': {
      const d = sub(p, blob.a);
      const rho = Math.hypot(d[0], d[2]) - (blob.R ?? 0.4);
      return [Math.atan2(d[2], d[0]), Math.atan2(d[1], rho)];      // u = around ring, v = around tube
    }
    case 'box': {
      const d = sub(p, blob.a), ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
      if (ax >= ay && ax >= az) return [d[2], d[1]];               // dominant-face planar
      if (ay >= az) return [d[0], d[2]];
      return [d[0], d[1]];
    }
    case 'sphere':
    case 'ellipsoid':
    default: {
      const d = sub(p, blob.a), l = len(d) || 1;
      // LAMBERT equal-area cylindrical: v = sin(latitude) = dy/l (NOT asin, which is equirectangular and
      // pinches hard at the poles). Equal-area → uniform texel density from pole to pole → far less cap pinch.
      return [Math.atan2(d[2], d[0]), d[1] / l];
    }
  }
}

/** Shelf-pack squares (one per atlas island) into the unit square, maximising the common scale via binary
 *  search so a BIGGER island (more surface area) gets a BIGGER cell — instead of every part getting an equal
 *  grid slot, which starved big torsos and wasted space on tiny ears. Sides are normalised so the largest is 1;
 *  the packer then finds the largest scale at which a next-fit shelf layout still fits [0,1]². Deterministic
 *  (no RNG). Returns a rect {x, y, s} per input index (s = packed side in [0,1]). */
function packSquaresShelf(rawSides: number[]): { x: number; y: number; s: number }[] {
  const maxSide = Math.max(...rawSides, 1e-9);
  const sides = rawSides.map(s => s / maxSide);
  const order = sides.map((_, i) => i).sort((a, b) => sides[b] - sides[a]);   // tallest first
  const attempt = (scale: number): { x: number; y: number; s: number }[] | null => {
    const rects: { x: number; y: number; s: number }[] = new Array(sides.length);
    let x = 0, y = 0, rowH = 0;
    for (const i of order) {
      const s = sides[i] * scale;
      if (s > 1.0001) return null;
      if (x + s > 1.0001) { x = 0; y += rowH; rowH = 0; }   // wrap to a new shelf
      if (y + s > 1.0001) return null;
      rects[i] = { x, y, s };
      x += s; if (s > rowH) rowH = s;
    }
    return rects;
  };
  let lo = 0, hi = 1;
  let best = attempt(1e-4) ?? sides.map(() => ({ x: 0, y: 0, s: 1e-4 }));   // tiny-scale fallback always fits
  for (let it = 0; it < 26; it++) {
    const mid = (lo + hi) / 2;
    const r = attempt(mid);
    if (r) { best = r; lo = mid; } else hi = mid;
  }
  return best;
}

// ── SDF primitives ──
const sdSphere = (p: V3, c: V3, r: number): number => len(sub(p, c)) - r;
function sdCapsule(p: V3, a: V3, b: V3, r: number): number {
  const pa = sub(p, a), ba = sub(b, a);
  const h = clamp01(dot(pa, ba) / (dot(ba, ba) || 1e-9));
  return len([pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h]) - r;
}
function sdEllipsoid(p: V3, c: V3, r: V3): number {
  const q: V3 = [(p[0] - c[0]), (p[1] - c[1]), (p[2] - c[2])];
  const k0 = len([q[0] / r[0], q[1] / r[1], q[2] / r[2]]);
  const k1 = len([q[0] / (r[0] * r[0]), q[1] / (r[1] * r[1]), q[2] / (r[2] * r[2])]);
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : k0 - 1;
}
function sdBox(p: V3, c: V3, half: V3, round: number): number {
  const q: V3 = [Math.abs(p[0] - c[0]) - half[0], Math.abs(p[1] - c[1]) - half[1], Math.abs(p[2] - c[2]) - half[2]];
  const outside = len([Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)]);
  const inside = Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0);
  return outside + inside - round;
}
function sdTorus(p: V3, c: V3, R: number, r: number): number {
  const q: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  return len([Math.hypot(q[0], q[2]) - R, q[1], 0]) - r;
}

function sdfOf(blob: SdfBlob, p: V3): number {
  const r = blob.radius ?? 0.2;
  switch (blob.shape) {
    case 'sphere':    return sdSphere(p, blob.a, r);
    case 'capsule':   return sdCapsule(p, blob.a, blob.b ?? blob.a, r);
    case 'ellipsoid': return sdEllipsoid(p, blob.a, blob.radii ?? [r, r, r]);
    case 'box':       return sdBox(p, blob.a, blob.radii ?? [r, r, r], 0);
    case 'torus':     return sdTorus(p, blob.a, blob.R ?? 0.4, r);
    default:          return sdSphere(p, blob.a, r);
  }
}

/** Polynomial smooth-min: blends two distances so their surfaces fuse over radius `k`. k≤0 → a hard min. */
function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return (b + (a - b) * h) - k * h * (1 - h);
}

/** The combined field: smooth-union every blob (subtract blobs carve cavities). */
export function evalField(blobs: SdfBlob[], p: V3): number {
  let d = 1e9;
  for (const blob of blobs) {
    const db = sdfOf(blob, p), k = blob.blend ?? 0;
    if (blob.op === 'subtract') d = -smin(-d, db, k);   // smooth subtract = smax(d, -db)
    else d = smin(d, db, k);
  }
  return d;
}

/** World-space AABB of the blobs (+ blend + a margin), so the sampling grid encloses the whole surface. */
function fieldBounds(blobs: SdfBlob[]): { min: V3; max: V3 } {
  const min: V3 = [1e9, 1e9, 1e9], max: V3 = [-1e9, -1e9, -1e9];
  const grow = (p: V3, pad: number): void => {
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i] - pad); max[i] = Math.max(max[i], p[i] + pad); }
  };
  for (const blob of blobs) {
    const r = blob.radius ?? 0.2, k = blob.blend ?? 0;
    const rad = blob.shape === 'ellipsoid' || blob.shape === 'box' ? Math.max(...(blob.radii ?? [r, r, r])) + (blob.shape === 'box' ? 0 : 0)
      : blob.shape === 'torus' ? (blob.R ?? 0.4) + r : r;
    grow(blob.a, rad + k);
    if (blob.b) grow(blob.b, rad + k);
  }
  return { min, max };
}

// ── Naive Surface Nets (Lysenko-style cube-edge tables) ──────────
const CUBE_EDGES = new Int32Array(24);
const EDGE_TABLE = new Int32Array(256);
(() => {
  let k = 0;
  for (let i = 0; i < 8; i++) for (let j = 1; j <= 4; j <<= 1) { const p = i ^ j; if (i <= p) { CUBE_EDGES[k++] = i; CUBE_EDGES[k++] = p; } }
  for (let i = 0; i < 256; i++) {
    let em = 0;
    for (let j = 0; j < 24; j += 2) { const a = !!(i & (1 << CUBE_EDGES[j])), b = !!(i & (1 << CUBE_EDGES[j + 1])); em |= a !== b ? (1 << (j >> 1)) : 0; }
    EDGE_TABLE[i] = em;
  }
})();

/**
 * Polygonize `blobs` into a mesh. `resolution` = grid cells per axis (clamped 8..96 — the field is O(res³) to
 * sample). `decimate` ∈ (0,1) = QEM-simplify the CLOSED mesh to that fraction of triangles BEFORE unwrapping
 * (curvature-adaptive: flat flanks collapse, joints keep detail) — leaner render/memory/save, same silhouette.
 * Returns an indexed 8-float MeshGeometry with gradient normals. Empty if there's no surface.
 */
export function generateSdfMesh(blobs: SdfBlob[], resolution = 48, decimate?: number): MeshGeometry {
  const empty: MeshGeometry = { vertices: new Float32Array(0), indices: new Uint32Array(0), format: '8float' };
  if (!blobs.length) return empty;

  const { min, max } = fieldBounds(blobs);
  const N = Math.max(8, Math.min(96, Math.round(resolution)));   // cells/axis
  const S = N + 1;                                                // samples/axis
  const cell: V3 = [(max[0] - min[0]) / N || 1e-6, (max[1] - min[1]) / N || 1e-6, (max[2] - min[2]) / N || 1e-6];
  const worldAt = (i: number, j: number, k: number): V3 => [min[0] + i * cell[0], min[1] + j * cell[1], min[2] + k * cell[2]];

  // Sample the field at every grid corner.
  const field = new Float32Array(S * S * S);
  const si = (i: number, j: number, k: number): number => i + j * S + k * S * S;
  for (let k = 0; k < S; k++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) field[si(i, j, k)] = evalField(blobs, worldAt(i, j, k));

  // One vertex per straddling cell.
  const cellVert = new Int32Array(N * N * N).fill(-1);
  const ci = (i: number, j: number, k: number): number => i + j * N + k * N * N;
  const positions: V3[] = [];
  const cornerOffset = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];

  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const grid = new Float32Array(8);
    let mask = 0;
    for (let g = 0; g < 8; g++) {
      const o = cornerOffset[g];
      const v = field[si(x + o[0], y + o[1], z + o[2])];
      grid[g] = v;
      if (v < 0) mask |= 1 << g;
    }
    if (mask === 0 || mask === 0xff) continue;
    const edgeMask = EDGE_TABLE[mask];
    const v: V3 = [0, 0, 0];
    let eCount = 0;
    for (let e = 0; e < 12; e++) {
      if (!(edgeMask & (1 << e))) continue;
      const e0 = CUBE_EDGES[e << 1], e1 = CUBE_EDGES[(e << 1) + 1];
      const g0 = grid[e0], g1 = grid[e1], d = g0 - g1;
      if (Math.abs(d) < 1e-9) continue;
      const t = g0 / d;
      eCount++;
      for (let axis = 0, bit = 1; axis < 3; axis++, bit <<= 1) {
        const a = e0 & bit, b = e1 & bit;
        if (a !== b) v[axis] += a ? 1 - t : t;
        else v[axis] += a ? 1 : 0;
      }
    }
    if (eCount === 0) continue;
    const s = 1 / eCount;
    cellVert[ci(x, y, z)] = positions.length;
    positions.push([min[0] + (x + v[0] * s) * cell[0], min[1] + (y + v[1] * s) * cell[1], min[2] + (z + v[2] * s) * cell[2]]);
  }

  // Quads: for the 3 edges from each cell's base corner that cross, connect the 4 cells sharing that edge.
  const quads: [number, number, number, number][] = [];
  const stride = [1, N, N * N];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = cellVert[ci(x, y, z)];
    if (c < 0) continue;
    const base = field[si(x, y, z)];
    for (let axis = 0; axis < 3; axis++) {
      const o = cornerOffset[1 << axis];
      const other = field[si(x + o[0], y + o[1], z + o[2])];
      if ((base < 0) === (other < 0)) continue;                 // no crossing on this edge
      const iu = (axis + 1) % 3, iv = (axis + 2) % 3;
      const xu = [x, y, z][iu], xv = [x, y, z][iv];
      if (xu === 0 || xv === 0) continue;                       // need the 3 neighbour cells to exist
      const du = stride[iu], dv = stride[iv], m = ci(x, y, z);
      const a = c, b1 = cellVert[m - du], b2 = cellVert[m - du - dv], b3 = cellVert[m - dv];
      if (b1 < 0 || b2 < 0 || b3 < 0) continue;
      // winding: flip based on which side is inside so faces point outward
      if (base < 0) quads.push([a, b1, b2, b3]);
      else quads.push([a, b3, b2, b1]);
    }
  }

  if (!positions.length) return empty;

  // Triangulate the surface-nets quads, then (optionally) DECIMATE the CLOSED mesh BEFORE unwrapping — no UV
  // seams exist yet, so QEM edge-collapse is clean; the per-blob atlas is then built on the leaner topology.
  let tris: [number, number, number][] = [];
  for (const [a, b, c, d] of quads) { tris.push([a, b, c]); tris.push([a, c, d]); }
  let pos: V3[] = positions;
  if (decimate && decimate > 0 && decimate < 1) {
    const s = simplifyMesh(pos, tris, decimate);
    pos = s.positions; tris = s.tris;
  }

  // Gradient normals (central differences) at the FINAL (possibly decimated) vertex positions.
  const eps: V3 = [cell[0] * 0.5, cell[1] * 0.5, cell[2] * 0.5];
  const normals = pos.map((p): V3 => {
    const nx = evalField(blobs, [p[0] + eps[0], p[1], p[2]]) - evalField(blobs, [p[0] - eps[0], p[1], p[2]]);
    const ny = evalField(blobs, [p[0], p[1] + eps[1], p[2]]) - evalField(blobs, [p[0], p[1] - eps[1], p[2]]);
    const nz = evalField(blobs, [p[0], p[1], p[2] + eps[2]]) - evalField(blobs, [p[0], p[1], p[2] - eps[2]]);
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  });

  return unwrapPerBlobAtlas(pos, tris, normals, blobs);
}

/**
 * PER-BLOB ATLAS UNWRAP. A single projection folds a branching creature's parts onto each other (spherical =
 * overlapping mess). Instead give each SOURCE BLOB its own atlas island: (1) assign each TRIANGLE to the union
 * blob whose surface it sits on (centroid → smallest |sdf|), (2) DUPLICATE shared verts along the assignment
 * boundary so each island is independent — the fusion neck becomes a clean SEAM (geometry stays smooth; both
 * copies keep the same normal, only the UV cuts) + cut each cyclic chart's wrap seam so nothing stretches
 * across an island, (3) project each island with its blob's natural map (capsule→cylindrical, sphere→lat-long),
 * (4) AREA-WEIGHTED pack (island side ∝ √surface-area). Seams land at the blob fusions — the anatomy's hidden
 * creases. Returns 8-float geometry (setGeometry computes tangents).
 */
function unwrapPerBlobAtlas(positions: V3[], tris: [number, number, number][], normals: V3[], blobs: SdfBlob[]): MeshGeometry {
  // Union blobs only own charts (subtract blobs carve cavities — they don't own surface). Fall back to all
  // blobs if everything is a subtract (degenerate) so we never divide by an empty owner set.
  const owners = blobs.map((b, i) => ({ b, i })).filter(x => x.b.op !== 'subtract');
  const ownerSet = owners.length ? owners : blobs.map((b, i) => ({ b, i }));

  const triBlob = tris.map(([i0, i1, i2]) => {
    const p0 = positions[i0], p1 = positions[i1], p2 = positions[i2];
    const cen: V3 = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, (p0[2] + p1[2] + p2[2]) / 3];
    let best = ownerSet[0].i, bestD = Infinity;
    for (const { b, i } of ownerSet) { const dd = Math.abs(sdfOf(b, cen)); if (dd < bestD) { bestD = dd; best = i; } }
    return best;
  });

  // Compact the used charts, then pack them AREA-WEIGHTED: each island's atlas cell scales with its part's
  // SURFACE AREA (side ∝ √area), so a big torso gets a big island and a tiny ear a tiny one — texel density
  // stays even across the creature (and the flat pane reads proportionately) instead of every part getting an
  // equal grid slot.
  const usedCharts = [...new Set(triBlob)].sort((a, b) => a - b);
  const slotOf = new Map<number, number>(); usedCharts.forEach((c, i) => slotOf.set(c, i));
  const chartArea = new Map<number, number>();
  for (let ti = 0; ti < tris.length; ti++) {
    const [i0, i1, i2] = tris[ti];
    const a = positions[i0], b = positions[i1], c = positions[i2];
    const area = 0.5 * len(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    chartArea.set(triBlob[ti], (chartArea.get(triBlob[ti]) ?? 0) + area);
  }
  const rects = packSquaresShelf(usedCharts.map(c => Math.sqrt(Math.max(chartArea.get(c) ?? 0, 1e-9))));

  // Duplicate verts per (originalIndex, chart, seamSide): a vert shared across a CHART boundary gets one copy
  // per island (the fusion seam), AND a vert on a cyclic chart's WRAP SEAM (the back meridian of a cylindrical
  // / lat-long projection) gets cut too — otherwise a triangle straddling u=±π stretches clear across the
  // island (the ~4% "tangled overlap"). A straddling triangle shifts its negative-u corners by +2π so it stays
  // local; those shifted corners become a second copy → the tube UNROLLS flat with the seam at the island edge.
  const cyclicU = (c: number): boolean => {
    const s = blobs[c].shape; return s === 'capsule' || s === 'sphere' || s === 'ellipsoid' || s === 'torus';
  };
  const vmap = new Map<string, number>();
  const outPos: V3[] = [], outNorm: V3[] = [], rawUV: [number, number][] = [], outChart: number[] = [];
  const outIdx: number[] = [];
  for (let ti = 0; ti < tris.length; ti++) {
    const chart = triBlob[ti], tri = tris[ti];
    const uv3 = tri.map(oi => blobUV(blobs[chart], positions[oi]));
    let shift: boolean[] = [false, false, false];
    if (cyclicU(chart)) {
      const us = uv3.map(x => x[0]);
      if (Math.max(...us) - Math.min(...us) > Math.PI) shift = us.map(u => u < 0);   // straddles the wrap seam
    }
    const ids = tri.map((oi, j) => {
      const s = shift[j] ? 1 : 0;
      const key = oi + ':' + chart + ':' + s;
      let ni = vmap.get(key);
      if (ni === undefined) {
        ni = outPos.length; vmap.set(key, ni);
        outPos.push(positions[oi]); outNorm.push(normals[oi]);
        rawUV.push([uv3[j][0] + s * Math.PI * 2, uv3[j][1]]); outChart.push(chart);
      }
      return ni;
    });
    outIdx.push(ids[0], ids[1], ids[2]);
  }

  // Per-chart UV bbox → normalise each island to fill its own cell (with a gutter so brushes don't bleed across
  // islands). Small parts thus get their whole island, not a speck.
  const bbox = new Map<number, [number, number, number, number]>();   // chart → [minU,minV,maxU,maxV]
  for (let i = 0; i < outPos.length; i++) {
    const c = outChart[i], [u, v] = rawUV[i];
    const bb = bbox.get(c);
    if (!bb) bbox.set(c, [u, v, u, v]);
    else { bb[0] = Math.min(bb[0], u); bb[1] = Math.min(bb[1], v); bb[2] = Math.max(bb[2], u); bb[3] = Math.max(bb[3], v); }
  }
  const GUT = 0.06;   // fractional inset of each island within its packed square (stops brush bleed across seams)
  const verts = new Float32Array(outPos.length * 8);
  for (let i = 0; i < outPos.length; i++) {
    const p = outPos[i], n = outNorm[i], o = i * 8;
    const c = outChart[i], slot = slotOf.get(c) ?? 0, bb = bbox.get(c)!, rect = rects[slot] ?? { x: 0, y: 0, s: 1 };
    const du = bb[2] - bb[0] || 1, dv = bb[3] - bb[1] || 1;
    const lu = (rawUV[i][0] - bb[0]) / du, lv = (rawUV[i][1] - bb[1]) / dv;   // 0..1 within the chart
    verts[o] = p[0]; verts[o + 1] = p[1]; verts[o + 2] = p[2];
    verts[o + 3] = n[0]; verts[o + 4] = n[1]; verts[o + 5] = n[2];
    verts[o + 6] = rect.x + rect.s * (GUT + lu * (1 - 2 * GUT));
    verts[o + 7] = rect.y + rect.s * (GUT + lv * (1 - 2 * GUT));
  }
  const indices = new Uint32Array(outIdx);

  return { vertices: verts, indices, format: '8float' };
}
