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
    for (const { a, b, c, d } of this.planes) {
      // "Positive vertex" = AABB corner maximising dot(plane.normal, corner)
      const px = a >= 0 ? maxX : minX;
      const py = b >= 0 ? maxY : minY;
      const pz = c >= 0 ? maxZ : minZ;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }
}
