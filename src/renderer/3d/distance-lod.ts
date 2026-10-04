/**
 * DISTANCE LOD helpers (polish-round-3 R6.1). A mesh with `drawDistance > 0` stops drawing once the CAMERA is farther
 * than that from its world AABB — measured to the box's NEAREST point, so a chunk the camera stands in is at 0.
 * Hysteretic, so a mesh sitting on the threshold never flickers: it hides past `far` and shows again only inside
 * `far * DISTANCE_LOD_SHOW`.
 */

/** Show-again fraction of the draw distance (the hysteresis band is 10 %). */
export const DISTANCE_LOD_SHOW = 0.9;

/** Squared distance from point p to the AABB (0 inside it). */
export function aabbDistanceSq(px: number, py: number, pz: number,
    minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return dx * dx + dy * dy + dz * dz;
}

/** The next hidden-state for a mesh at squared distance `d2` with draw distance `far` (> 0). */
export function distanceLodHidden(d2: number, far: number, wasHidden: boolean): boolean {
  if (wasHidden) { const s = far * DISTANCE_LOD_SHOW; return d2 >= s * s; }
  return d2 > far * far;
}

/** Draw-distance multiplier for a perspective camera's vertical FOV (radians): 1 at the default 45°, smaller for a
 *  wider lens (things look smaller on screen, so they drop sooner), larger for a zoomed-in one. Clamped to 0.25..4. */
export function fovDistanceScale(fov: number): number {
  const t = Math.tan(Math.min(Math.max(fov, 0.05), 3.0) / 2);
  return Math.min(4, Math.max(0.25, Math.tan(Math.PI / 8) / t));
}

/** ORTHO SCREEN-SIZE LOD (performance-plan P1.2). An orthographic camera's position says nothing about how big things
 *  are on screen; its zoom does, and it is the same for every mesh. This is the distance at which the reference 45-degree
 *  perspective lens shows the same view half-height (`orthoSize`), i.e. the distance at which a mesh looks as big as
 *  it does in the ortho view. Distance LOD compares it with each mesh's draw distance (size x zoom, uniform across the
 *  view), so the 45-degree perspective tuning of drawDistance / nearTwin carries over unchanged. */
export function orthoLodDistance(orthoSize: number): number {
  return Math.max(0, orthoSize) / Math.tan(Math.PI / 8);
}

/** NEAR/FAR TWIN selection (E2 + P9): whether a twin of `role` draws, given the camera-near states for the first
 *  threshold (`near1`, lodTwinDist) and the second (`near2`, lodTwinDist2). 1 = near · 2 = far · 3 = mid (between the
 *  two thresholds) · 4 = xfar (past the second). Exactly one role of a family draws for any pair of states. */
export function twinDraws(role: number, near1: boolean, near2: boolean): boolean {
  switch (role) {
    case 1: return near1;
    case 2: return !near1;
    case 3: return !near1 && near2;
    case 4: return !near2;
    default: return true;
  }
}
