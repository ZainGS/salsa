/**
 * MeshBVH — axis-aligned bounding volume hierarchy for ray-triangle picking.
 *
 * Built once per mesh in local (object) space. Remains valid across all
 * transforms since the ray is transformed into local space before traversal.
 * Must be rebuilt only when vertex positions change (mesh.gpuDirty = true).
 *
 * Build:    O(N log N)  — centroid median split along longest axis
 * Traverse: O(log N)    — ordered child traversal with early-exit
 *
 * All intersection math uses scalar arithmetic — zero heap allocations during traversal.
 */

import { FLOATS_PER_VERT } from './mesh-generators';

export interface BVHHit {
  /** Ray parameter t at the intersection point (local-space distance along the ray). */
  t: number;
  /** Triangle index: offset = triIndex * 3 into the index buffer. */
  triIndex: number;
}

// Maximum triangles per leaf node. 8 keeps the tree shallow without too many leaf tests.
const LEAF_MAX = 8;
const EPSILON  = 1e-7;

interface BVHNode {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  left:      number;  // child node index, -1 for leaf nodes
  right:     number;  // child node index, -1 for leaf nodes
  triOffset: number;  // index into _triIndices (only used for leaves)
  triCount:  number;  // > 0 = leaf, 0 = internal node
}

export class MeshBVH {

  private readonly _nodes:      BVHNode[];
  private readonly _triIndices: Uint32Array;
  private readonly _verts:      Float32Array;
  private readonly _idxs:       Uint32Array;

  private constructor(
    nodes:      BVHNode[],
    triIndices: number[],
    verts:      Float32Array,
    idxs:       Uint32Array,
  ) {
    this._nodes      = nodes;
    this._triIndices = new Uint32Array(triIndices);
    this._verts      = verts;
    this._idxs       = idxs;
  }

  /**
   * Build a BVH from a mesh's geometry arrays.
   * verts and idxs are stored by reference — do not mutate them after building.
   */
  static build(verts: Float32Array, idxs: Uint32Array): MeshBVH {
    const triCount = idxs.length / 3 | 0;
    const triIndices: number[] = Array.from({ length: triCount }, (_, i) => i);
    const nodes: BVHNode[] = [];
    buildNode(verts, idxs, triIndices, 0, triCount, nodes);
    return new MeshBVH(nodes, triIndices, verts, idxs);
  }

  /**
   * Intersect a local-space ray against the mesh.
   * Returns the closest hit or null. Zero allocations.
   */
  intersect(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
  ): BVHHit | null {
    return this._nodes.length > 0
      ? this._traverseNode(0, ox, oy, oz, dx, dy, dz)
      : null;
  }

  // ── Private traversal ─────────────────────────────────────────────────────

  private _traverseNode(
    idx: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
  ): BVHHit | null {
    const node = this._nodes[idx];

    if (node.triCount > 0) {
      // Leaf — test all triangles in this node
      let bestT   = Infinity;
      let bestTri = -1;
      const end = node.triOffset + node.triCount;
      for (let i = node.triOffset; i < end; i++) {
        const tri  = this._triIndices[i];
        const base = tri * 3;
        const s    = FLOATS_PER_VERT;
        const i0   = this._idxs[base]     * s;
        const i1   = this._idxs[base + 1] * s;
        const i2   = this._idxs[base + 2] * s;
        const t = mtTest(
          ox, oy, oz, dx, dy, dz,
          this._verts[i0], this._verts[i0 + 1], this._verts[i0 + 2],
          this._verts[i1], this._verts[i1 + 1], this._verts[i1 + 2],
          this._verts[i2], this._verts[i2 + 1], this._verts[i2 + 2],
        );
        if (t !== null && t < bestT) { bestT = t; bestTri = tri; }
      }
      return bestTri >= 0 ? { t: bestT, triIndex: bestTri } : null;
    }

    // Internal — test both children, visit the closer one first.
    // If the closer child returns a hit with t ≤ the farther child's entry t,
    // the farther child cannot produce a closer hit → skip it.
    const tL = nodeEntryT(this._nodes[node.left],  ox, oy, oz, dx, dy, dz);
    const tR = nodeEntryT(this._nodes[node.right], ox, oy, oz, dx, dy, dz);

    if (tL === Infinity && tR === Infinity) return null;
    if (tL === Infinity) return this._traverseNode(node.right, ox, oy, oz, dx, dy, dz);
    if (tR === Infinity) return this._traverseNode(node.left,  ox, oy, oz, dx, dy, dz);

    const [firstIdx, secondIdx, tSecond] = tL <= tR
      ? [node.left,  node.right, tR]
      : [node.right, node.left,  tL];

    const firstHit = this._traverseNode(firstIdx, ox, oy, oz, dx, dy, dz);
    if (firstHit && firstHit.t <= tSecond) return firstHit;

    const secondHit = this._traverseNode(secondIdx, ox, oy, oz, dx, dy, dz);
    if (!firstHit)  return secondHit;
    if (!secondHit) return firstHit;
    return firstHit.t <= secondHit.t ? firstHit : secondHit;
  }
}

// ── Free functions (module-private) ──────────────────────────────────────────

/**
 * Recursive BVH builder. Operates on a slice of triIndices[start, end).
 * Sorts the slice in-place by centroid along the longest axis, then splits at the median.
 * Returns the index of the newly created node in the nodes array.
 */
function buildNode(
  verts:      Float32Array,
  idxs:       Uint32Array,
  triIndices: number[],
  start:      number,
  end:        number,
  nodes:      BVHNode[],
): number {
  const count = end - start;

  // Compute AABB for all triangles in this range
  let minX = Infinity,  minY = Infinity,  minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const s = FLOATS_PER_VERT;

  for (let i = start; i < end; i++) {
    const tri = triIndices[i];
    for (let v = 0; v < 3; v++) {
      const vi = idxs[tri * 3 + v] * s;
      const x = verts[vi], y = verts[vi + 1], z = verts[vi + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }

  // Push a placeholder — we'll fill left/right after recursing.
  const nodeIdx = nodes.length;
  nodes.push({ minX, minY, minZ, maxX, maxY, maxZ, left: -1, right: -1, triOffset: start, triCount: 0 });

  if (count <= LEAF_MAX) {
    nodes[nodeIdx].triCount = count;
    return nodeIdx;
  }

  // Split along the longest axis at the centroid median
  const extX = maxX - minX, extY = maxY - minY, extZ = maxZ - minZ;
  const axis = extX >= extY && extX >= extZ ? 0 : extY >= extZ ? 1 : 2;

  // Sort the slice by triangle centroid on the chosen axis
  const slice = triIndices.slice(start, end);
  slice.sort((a, b) => centroid(verts, idxs, s, a, axis) - centroid(verts, idxs, s, b, axis));
  for (let i = 0; i < slice.length; i++) triIndices[start + i] = slice[i];

  const mid = (start + end) >> 1;
  nodes[nodeIdx].left  = buildNode(verts, idxs, triIndices, start, mid, nodes);
  nodes[nodeIdx].right = buildNode(verts, idxs, triIndices, mid,   end, nodes);

  return nodeIdx;
}

/** Average position of a triangle's three vertices along one axis. */
function centroid(verts: Float32Array, idxs: Uint32Array, stride: number, tri: number, axis: number): number {
  const b = tri * 3;
  return (verts[idxs[b] * stride + axis] + verts[idxs[b + 1] * stride + axis] + verts[idxs[b + 2] * stride + axis]) / 3;
}

/**
 * Slab-method ray-AABB test returning the entry distance t along the ray.
 * Returns Infinity if the ray misses or the box is entirely behind the origin.
 * Zero allocations — all arithmetic is scalar.
 */
function nodeEntryT(node: BVHNode, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  let tMin = -Infinity, tMax = Infinity;

  // X slab
  if (Math.abs(dx) < EPSILON) {
    if (ox < node.minX || ox > node.maxX) return Infinity;
  } else {
    const inv = 1 / dx;
    let t1 = (node.minX - ox) * inv;
    let t2 = (node.maxX - ox) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return Infinity;
  }

  // Y slab
  if (Math.abs(dy) < EPSILON) {
    if (oy < node.minY || oy > node.maxY) return Infinity;
  } else {
    const inv = 1 / dy;
    let t1 = (node.minY - oy) * inv;
    let t2 = (node.maxY - oy) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return Infinity;
  }

  // Z slab
  if (Math.abs(dz) < EPSILON) {
    if (oz < node.minZ || oz > node.maxZ) return Infinity;
  } else {
    const inv = 1 / dz;
    let t1 = (node.minZ - oz) * inv;
    let t2 = (node.maxZ - oz) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return Infinity;
  }

  return tMax >= 0 ? Math.max(0, tMin) : Infinity;
}

/**
 * Möller–Trumbore ray-triangle intersection, fully scalar — zero allocations.
 * Returns t (ray parameter at hit) or null on miss. Both faces tested.
 */
function mtTest(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number | null {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;

  const a = e1x * hx + e1y * hy + e1z * hz;
  if (a > -EPSILON && a < EPSILON) return null;

  const f  = 1 / a;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u  = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return null;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v  = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return null;

  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > EPSILON ? t : null;
}
