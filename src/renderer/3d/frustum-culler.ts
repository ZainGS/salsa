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
  /** Six clip planes: left, right, bottom, top, near, far. */
  private planes: [Plane, Plane, Plane, Plane, Plane, Plane];

  private constructor(planes: [Plane, Plane, Plane, Plane, Plane, Plane]) {
    this.planes = planes;
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
    const m = vp as Float32Array;

    // Rows of the matrix (mathematical rows, not gl-matrix columns)
    const r0 = [m[0], m[4], m[8],  m[12]];
    const r1 = [m[1], m[5], m[9],  m[13]];
    const r2 = [m[2], m[6], m[10], m[14]];
    const r3 = [m[3], m[7], m[11], m[15]];

    const makePlane = (a: number, b: number, c: number, d: number): Plane => {
      const len = Math.sqrt(a * a + b * b + c * c) || 1;
      return { a: a / len, b: b / len, c: c / len, d: d / len };
    };

    const planes: [Plane, Plane, Plane, Plane, Plane, Plane] = [
      makePlane(r3[0]+r0[0], r3[1]+r0[1], r3[2]+r0[2], r3[3]+r0[3]), // left
      makePlane(r3[0]-r0[0], r3[1]-r0[1], r3[2]-r0[2], r3[3]-r0[3]), // right
      makePlane(r3[0]+r1[0], r3[1]+r1[1], r3[2]+r1[2], r3[3]+r1[3]), // bottom
      makePlane(r3[0]-r1[0], r3[1]-r1[1], r3[2]-r1[2], r3[3]-r1[3]), // top
      makePlane(r2[0],        r2[1],        r2[2],        r2[3]),        // near (WebGPU z≥0)
      makePlane(r3[0]-r2[0], r3[1]-r2[1], r3[2]-r2[2], r3[3]-r2[3]), // far
    ];

    return new FrustumCuller(planes);
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
