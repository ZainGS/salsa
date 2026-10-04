/**
 * FrustumCuller — CPU-side AABB-vs-frustum test for 3D mesh visibility.
 *
 * Extracts the 6 frustum planes from a view-projection matrix and tests
 * whether an axis-aligned bounding box (AABB) is partially or fully inside.
 *
 * WebGPU NDC: z ∈ [0, 1], so the near plane is extracted differently from OpenGL.
 *
 * Usage:
 *   const culler = FrustumCuller.fromViewProjection(camera.getViewProjectionMatrix());
 *   if (!culler.testAABB(min, max)) continue; // skip this mesh
 */

import { mat4 } from 'gl-matrix';

/** A frustum plane in the form ax + by + cz + d ≥ 0 (inside half-space). */
interface Plane {
  a: number; b: number; c: number; d: number;
}

export class FrustumCuller {
  /** Six clip planes: left, right, bottom, top, near, far. Pre-allocated + rewritten in place each frame. */
  private planes: [Plane, Plane, Plane, Plane, Plane, Plane] = [
    { a: 0, b: 0, c: 0, d: 0 }, { a: 0, b: 0, c: 0, d: 0 }, { a: 0, b: 0, c: 0, d: 0 },
    { a: 0, b: 0, c: 0, d: 0 }, { a: 0, b: 0, c: 0, d: 0 }, { a: 0, b: 0, c: 0, d: 0 },
  ];

  /** Write one plane (normalized) in place — no allocation. */
  private static setPlane(p: Plane, a: number, b: number, c: number, d: number): void {
    const len = Math.sqrt(a * a + b * b + c * c) || 1;
    p.a = a / len; p.b = b / len; p.c = c / len; p.d = d / len;
  }

  /** Extract the 6 planes from a view-projection matrix INTO this culler's pre-allocated planes — allocation-free,
   *  so a single persistent culler can be reused every frame (was `fromViewProjection` allocating 4 arrays + 6
   *  plane objects + the culler EVERY frame while culling is on — city + character). */
  setFromViewProjection(vp: mat4 | Float32Array): this {
    const m = vp as Float32Array;
    // Rows (mathematical): r_i = [m[i], m[i+4], m[i+8], m[i+12]]. Inlined — no r0..r3 arrays.
    const r00 = m[0], r01 = m[4], r02 = m[8],  r03 = m[12];
    const r10 = m[1], r11 = m[5], r12 = m[9],  r13 = m[13];
    const r20 = m[2], r21 = m[6], r22 = m[10], r23 = m[14];
    const r30 = m[3], r31 = m[7], r32 = m[11], r33 = m[15];
    FrustumCuller.setPlane(this.planes[0], r30 + r00, r31 + r01, r32 + r02, r33 + r03); // left
    FrustumCuller.setPlane(this.planes[1], r30 - r00, r31 - r01, r32 - r02, r33 - r03); // right
    FrustumCuller.setPlane(this.planes[2], r30 + r10, r31 + r11, r32 + r12, r33 + r13); // bottom
    FrustumCuller.setPlane(this.planes[3], r30 - r10, r31 - r11, r32 - r12, r33 - r13); // top
    FrustumCuller.setPlane(this.planes[4], r20,       r21,       r22,       r23);       // near (WebGPU z≥0)
    FrustumCuller.setPlane(this.planes[5], r30 - r20, r31 - r21, r32 - r22, r33 - r23); // far
    return this;
  }

  /**
   * Build a FrustumCuller from a column-major view-projection matrix
   * (as returned by gl-matrix mat4).
   *
   * gl-matrix column-major layout:
   *   m[0..3]  = column 0  (first column)
   *   m[4..7]  = column 1
   *   m[8..11] = column 2
   *   m[12..15]= column 3
   *
   * "Row i" in mathematical notation = [ m[i], m[i+4], m[i+8], m[i+12] ]
   *
   * Plane extraction (Gribb & Hartmann, WebGPU depth convention 0..1):
   *   Left:   row3 + row0
   *   Right:  row3 - row0
   *   Bottom: row3 + row1
   *   Top:    row3 - row1
   *   Near:   row2          (z ≥ 0  in NDC → near = row2 alone)
   *   Far:    row3 - row2
   */
  static fromViewProjection(vp: mat4 | Float32Array): FrustumCuller {
    return new FrustumCuller().setFromViewProjection(vp);
  }

  /**
   * Test whether an AABB defined by [minX,minY,minZ] – [maxX,maxY,maxZ] is
   * visible (intersects or is inside the frustum).
   *
   * Returns false only when the AABB is completely outside at least one plane.
   * False-positives (returns true for corner-case outside geometry) are acceptable.
   */
  testAABB(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): boolean {
    // P9: an indexed loop — `for (const {..} of planes)` allocated an array iterator per call wherever the caller
    // runs below TurboFan (the city's draw-list build calls this ~4 times per mesh per frame).
    const planes = this.planes;
    for (let i = 0; i < planes.length; i++) {
      const pl = planes[i], a = pl.a, b = pl.b, c = pl.c, d = pl.d;
      // "Positive vertex" = AABB corner maximising dot(plane.normal, corner)
      const px = a >= 0 ? maxX : minX;
      const py = b >= 0 ? maxY : minY;
      const pz = c >= 0 ? maxZ : minZ;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }

  /** testAABB for a box OBJECT (P9: the draw-list build's hot calls — six double arguments per call were boxed
   *  below TurboFan; reading the fields here is not). */
  testBox(bx: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): boolean {
    const planes = this.planes;
    for (let i = 0; i < planes.length; i++) {
      const pl = planes[i], a = pl.a, b = pl.b, c = pl.c;
      if (a * (a >= 0 ? bx.maxX : bx.minX) + b * (b >= 0 ? bx.maxY : bx.minY) + c * (c >= 0 ? bx.maxZ : bx.minZ) + pl.d < 0) return false;
    }
    return true;
  }

  /** P15 (gpu-driven.ts): the six normalized planes as 24 floats (a, b, c, d per plane, this culler's order) into
   *  `out` at `offset` — the GPU cull's frustum. Returns `out`. */
  writePlanes<T extends { [i: number]: number }>(out: T, offset = 0): T {
    const planes = this.planes;
    for (let i = 0; i < 6; i++) { const p = planes[i], o = offset + i * 4; out[o] = p.a; out[o + 1] = p.b; out[o + 2] = p.c; out[o + 3] = p.d; }
    return out;
  }

  /** P11: true when the WHOLE box lies inside every plane (its "negative" corner is inside each). Then every part of
   *  it passes, so a caller can skip testing its sub-boxes (cull-ranges.ts). */
  containsBox(bx: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): boolean {
    const planes = this.planes;
    for (let i = 0; i < planes.length; i++) {
      const pl = planes[i], a = pl.a, b = pl.b, c = pl.c;
      if (a * (a >= 0 ? bx.minX : bx.maxX) + b * (b >= 0 ? bx.minY : bx.maxY) + c * (c >= 0 ? bx.minZ : bx.maxZ) + pl.d < 0) return false;
    }
    return true;
  }

  /** containsBox for six numbers. */
  containsAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    const planes = this.planes;
    for (let i = 0; i < planes.length; i++) {
      const pl = planes[i], a = pl.a, b = pl.b, c = pl.c;
      if (a * (a >= 0 ? minX : maxX) + b * (b >= 0 ? minY : maxY) + c * (c >= 0 ? minZ : maxZ) + pl.d < 0) return false;
    }
    return true;
  }

  /** testAABB of `bx` swept by (ex, ey, ez): the union of the box and the box moved by that offset (shadowReachesView). */
  testSweptBox(bx: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, ex: number, ey: number, ez: number): boolean {
    const x0 = Math.min(bx.minX, bx.minX + ex), y0 = Math.min(bx.minY, bx.minY + ey), z0 = Math.min(bx.minZ, bx.minZ + ez);
    const x1 = Math.max(bx.maxX, bx.maxX + ex), y1 = Math.max(bx.maxY, bx.maxY + ey), z1 = Math.max(bx.maxZ, bx.maxZ + ez);
    const planes = this.planes;
    for (let i = 0; i < planes.length; i++) {
      const pl = planes[i], a = pl.a, b = pl.b, c = pl.c;
      if (a * (a >= 0 ? x1 : x0) + b * (b >= 0 ? y1 : y0) + c * (c >= 0 ? z1 : z0) + pl.d < 0) return false;
    }
    return true;
  }
}

/**
 * SHADOW REACH (polish-round-3 Round 5): can a caster with this AABB throw a shadow into `view`?
 *
 * The caster's shadow volume is its box swept along the light's travel direction `d` (unit, d.y < 0) down to the
 * lowest receiver `floorY` (nothing below it can receive). Its AABB = union(box, box + d·len) with
 * len = (maxY - floorY) / -d.y — a CONSERVATIVE bound (it contains the whole swept volume). If that union misses
 * the camera frustum, no visible fragment can be shadowed by this caster, so the shadow pass may skip it.
 * Always true when the sun is near the horizon (|d.y| < 0.05: shadows effectively unbounded) or floorY is unknown.
 * Every caster INSIDE the view passes (the union contains the box), so this never drops what a camera-culled
 * shadow list kept.
 */
export function shadowReachesView(view: FrustumCuller, d: ArrayLike<number>, floorY: number,
    minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  const dy = d[1];
  if (!(dy < -0.05) || !Number.isFinite(floorY)) return true;
  const len = Math.max(0, maxY - floorY) / -dy;
  const ex = d[0] * len, ey = dy * len, ez = d[2] * len;
  return view.testAABB(
    Math.min(minX, minX + ex), Math.min(minY, minY + ey), Math.min(minZ, minZ + ez),
    Math.max(maxX, maxX + ex), Math.max(maxY, maxY + ey), Math.max(maxZ, maxZ + ez));
}

/** shadowReachesView for a box OBJECT (P9; identical result — see testBox). */
export function shadowReachesViewBox(view: FrustumCuller, d: ArrayLike<number>, floorY: number,
    bx: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): boolean {
  const dy = d[1];
  if (!(dy < -0.05) || !Number.isFinite(floorY)) return true;
  const len = Math.max(0, bx.maxY - floorY) / -dy;
  return view.testSweptBox(bx, d[0] * len, dy * len, d[2] * len);
}
