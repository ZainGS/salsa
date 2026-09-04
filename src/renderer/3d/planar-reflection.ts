/**
 * Planar reflections — the pure math core (docs/specs/environment-and-reflections.md, P4).
 *
 * TRUE mirror reflections for flat reflectors (floors, wall mirrors): render the scene a second time from the
 * camera REFLECTED across the mirror plane, into a texture; each reflector fragment then samples that texture at its
 * OWN screen position. Unlike SSR this shows BACK faces (the mirrored render sees them natively), works in ortho and
 * isometric views, and has no screen-space limits — it is exact by construction:
 *
 *   project(VP · M, P) = project(VP, M·P) = project(VP, virtualImage(P)) = the screen position of the mirror
 *   fragment F that shows P   (the virtual image sits on the sightline through F, by the definition of a mirror).
 *
 * So `mirroredViewProj = VP · reflectionMatrix(plane)`, and the reflection texture lines up with the main view
 * pixel-for-pixel — sampling needs no remapping at all.
 *
 * The mirrored render must clip everything BEHIND the mirror plane (it would otherwise leak through as fake
 * reflections); `clipPlaneFor` provides the world-space plane the render pass discards against (Salsa clips in the
 * fragment shader — simpler and pipeline-state-free vs Lengyel oblique-projection clipping).
 *
 * NOTE for the GPU side: a mirrored world flips handedness — triangle winding reverses. Pipelines that cull
 * back faces must flip cull direction for the mirrored pass (pipelines with cullMode 'none' are unaffected).
 *
 * Unit-tested in planar-reflection.test.ts against the same virtual-image analytics as the SSR harness.
 */

import { type Vec3, type Mat4, transformPoint4 } from './ssr-trace';

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Column-major mat4 that reflects world space across the plane through `planePoint` with unit normal `planeNormal`.
 * Householder form: M = I − 2nnᵀ on the linear part, translation 2d·n with d = n·planePoint. Involutory (M·M = I).
 */
export function reflectionMatrix(planePoint: Vec3, planeNormal: Vec3): Float32Array {
  const n = norm3(planeNormal);
  const [nx, ny, nz] = n;
  const d = dot3(n, planePoint);
  // column-major: m[col*4 + row]
  const m = new Float32Array(16);
  m[0] = 1 - 2 * nx * nx; m[4] = -2 * nx * ny;    m[8] = -2 * nx * nz;     m[12] = 2 * d * nx;
  m[1] = -2 * ny * nx;    m[5] = 1 - 2 * ny * ny; m[9] = -2 * ny * nz;     m[13] = 2 * d * ny;
  m[2] = -2 * nz * nx;    m[6] = -2 * nz * ny;    m[10] = 1 - 2 * nz * nz; m[14] = 2 * d * nz;
  m[3] = 0;               m[7] = 0;               m[11] = 0;               m[15] = 1;
  return m;
}

/** Reflect a world point across the plane (reference for tests + host-side uses). */
export function reflectPointAcrossPlane(p: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3 {
  const n = norm3(planeNormal);
  const dist = dot3(n, [p[0] - planePoint[0], p[1] - planePoint[1], p[2] - planePoint[2]] as Vec3);
  return [p[0] - 2 * dist * n[0], p[1] - 2 * dist * n[1], p[2] - 2 * dist * n[2]];
}

/** mirroredVP = viewProj · reflectionMatrix — the camera for the reflection render pass. Column-major product. */
export function mirroredViewProj(viewProj: Mat4, planePoint: Vec3, planeNormal: Vec3): Float32Array {
  const m = reflectionMatrix(planePoint, planeNormal);
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += viewProj[k * 4 + r] * m[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/**
 * The world-space clip plane for the mirrored render pass, as (nx, ny, nz, d) with the KEEP side satisfying
 * `dot(n, p) - d >= 0`. `frontPoint` = any point on the reflective side of the mirror (e.g. the camera position):
 * the returned plane keeps the half-space the ORIGINAL scene occupies in front of the mirror, so the mirrored
 * render discards geometry behind the mirror (which would leak through the surface as a fake reflection).
 * A small bias pushes the plane slightly behind the surface so the reflector's own coplanar geometry doesn't
 * z-fight the clip.
 */
export function clipPlaneFor(planePoint: Vec3, planeNormal: Vec3, frontPoint: Vec3, bias = 1e-3): [number, number, number, number] {
  let n = norm3(planeNormal);
  if (dot3(n, [frontPoint[0] - planePoint[0], frontPoint[1] - planePoint[1], frontPoint[2] - planePoint[2]] as Vec3) < 0) {
    n = [-n[0], -n[1], -n[2]];   // orient toward the reflective side
  }
  return [n[0], n[1], n[2], dot3(n, planePoint) - bias];
}

/** Signed distance of a point to the keep-side of a clip plane from `clipPlaneFor` (>= 0 = kept). Test/CPU mirror
 *  of the fragment-shader discard: the WGSL computes dot(n, worldPos) - d and discards when negative. */
export function clipPlaneSide(plane: readonly [number, number, number, number], p: Vec3): number {
  return plane[0] * p[0] + plane[1] * p[1] + plane[2] * p[2] - plane[3];
}

/** Best-fit plane of a flat reflector mesh from its world transform: `localNormal` is the face normal in mesh-local
 *  space (e.g. [0,1,0] for a box top; [0,0,1] for a panel front), transformed by the normal matrix and re-normalized;
 *  the plane point is the transformed local face center. Pure helper so hosts and tests share one definition. */
export function reflectorPlane(
  modelMatrix: Mat4, localFaceCenter: Vec3, localNormal: Vec3,
): { point: Vec3; normal: Vec3 } {
  const p4 = transformPoint4(modelMatrix, localFaceCenter);
  const point: Vec3 = [p4[0], p4[1], p4[2]];
  // normal via the linear part (assumes uniform-ish scale; renormalized regardless)
  const n: Vec3 = [
    modelMatrix[0] * localNormal[0] + modelMatrix[4] * localNormal[1] + modelMatrix[8] * localNormal[2],
    modelMatrix[1] * localNormal[0] + modelMatrix[5] * localNormal[1] + modelMatrix[9] * localNormal[2],
    modelMatrix[2] * localNormal[0] + modelMatrix[6] * localNormal[1] + modelMatrix[10] * localNormal[2],
  ];
  return { point, normal: norm3(n) };
}
