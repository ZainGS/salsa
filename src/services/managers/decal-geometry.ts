// ── Decal geometry + orientation (pure, testable) ───────────────────────────────────────────────
// The maths behind a FLOATING decal quad (docs/specs/decals.md, Mode A): a unit quad that faces +Z in its
// own local space, plus the Euler angles that rotate it so it lies flat on a picked surface — its face along
// the surface normal, its "up" pointing up-on-the-wall so posters hang upright. Kept separate from the scene
// wiring so the tricky rotation extraction can be unit-tested without a GPU.

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';

export type V3 = [number, number, number];

/** Where a decal's image comes from (stored on the decal so it re-resolves on reload — params over pixels).
 *  `ephemera` = an IEphemeraGenerator rasterised via EphemeraService.exportAs3DTexture; `image` = an uploaded
 *  data URL. Both ship from day one. */
export type DecalSource =
    | { kind: 'ephemera'; typeId: string; params: Record<string, unknown> }
    | { kind: 'image'; dataUrl: string };

/** A surface hit sufficient to place a decal (the subset of pick3D's result the placement needs). */
export interface DecalHit { hitPoint: V3; faceNormal: V3; }

/** A unit quad in the local XY plane (±0.5), facing +Z, UV 0..1 with (0,0) at the TOP-LEFT (image-space), so
 *  an applied texture reads upright. Size + aspect are applied via the mesh SCALE (scaleX = width, scaleY =
 *  height), not baked here — so resizing a decal never rebuilds geometry. Format 8float (pos3·nrm3·uv2). */
export function decalQuadGeometry(): MeshGeometry {
    // corner order: BL, BR, TR, TL — CCW seen from +Z, so the +Z face points at the viewer.
    const v = new Float32Array([
        -0.5, -0.5, 0,  0, 0, 1,  0, 1,   // bottom-left
         0.5, -0.5, 0,  0, 0, 1,  1, 1,   // bottom-right
         0.5,  0.5, 0,  0, 0, 1,  1, 0,   // top-right
        -0.5,  0.5, 0,  0, 0, 1,  0, 0,   // top-left
    ]);
    return { vertices: v, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), format: '8float' };
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Euler angles (rx, ry, rz) — for the engine's Y→X→Z order (`R = Ry·Rx·Rz`, see base/shape.ts) — that rotate
 * the local +Z quad so its face aligns to `normal` and its local +Y points up-on-the-plane. `rotation` spins
 * the decal in its own plane (about the normal). Handles the near-vertical-normal gimbal (floor/ceiling) by
 * switching the reference "up" so the roll stays well-defined.
 *
 * Derivation: build an orthonormal frame {T, U, N} (N = normal, U = world-up projected onto the plane, T =
 * the right axis), which IS the rotation matrix's columns; then read the YXZ angles off it:
 *   R[1][2] = -sin(rx) = N.y  ·  R[0..2][2] give ry = atan2(N.x, N.z)  ·  R[1][0..1] give rz = atan2(T.y, U.y).
 */
export function decalOrientation(normal: V3, rotation = 0): { rx: number; ry: number; rz: number } {
    const N = norm(normal);
    // Reference up: world +Y, unless the surface is nearly horizontal (a floor/ceiling), where +Y is parallel
    // to N and the roll is undefined — then reference world −Z so a decal on the ground faces a sensible way.
    const ref: V3 = Math.abs(N[1]) > 0.99 ? [0, 0, -1] : [0, 1, 0];
    const T = norm(cross(ref, N));   // right = ref × N
    const U = cross(N, T);           // up-on-plane = N × T (already unit)
    const rx = Math.asin(clamp(-N[1], -1, 1));
    const ry = Math.atan2(N[0], N[2]);
    const rz = Math.atan2(T[1], U[1]) + rotation;
    return { rx, ry, rz };
}

/** Placement for a decal from a surface hit: where to put it, how to orient it, how big.
 *  @param size  the decal's WIDTH in world units · @param aspect image width/height (height = size/aspect). */
export function decalPlacement(hitPoint: V3, faceNormal: V3, size: number, aspect: number, rotation = 0): {
    position: V3; rotation: { rx: number; ry: number; rz: number }; scaleX: number; scaleY: number;
} {
    const N = norm(faceNormal);
    const eps = Math.max(size * 0.004, 3e-4);             // lift off the surface a hair — flush, no z-fight
    const position: V3 = [hitPoint[0] + N[0] * eps, hitPoint[1] + N[1] * eps, hitPoint[2] + N[2] * eps];
    return { position, rotation: decalOrientation(N, rotation), scaleX: size, scaleY: size / Math.max(aspect, 1e-3) };
}
