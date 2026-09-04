/**
 * collision-math — pure XZ collision helpers for Play mode (docs/specs/play-mode.md).
 *
 * Kept separate from CharacterController + Scene3DManager so the geometry (wall-slide, step decision) is deterministic
 * and unit-testable; the manager does the raycasting and feeds the hit facts in.
 */

const EPS = 1e-6;

/**
 * Resolve a horizontal move that a wall blocks, sliding along the wall instead of stopping dead.
 *
 * The move goes from (fromX,fromZ) toward (toX,toZ). A ray along the move hit a wall at `blockDist` (from the start),
 * with XZ surface normal (nx,nz). The body has radius `r`. Returns the resolved (x,z): advance up to the wall (minus
 * the radius), then spend the remaining distance sliding along the wall tangent (the component of the move parallel
 * to the wall). No normal → nothing to slide on, so it just stops short.
 */
export function slideAlongWall(
  fromX: number, fromZ: number,
  toX: number, toZ: number,
  blockDist: number, nx: number, nz: number, r: number,
): [number, number] {
  const moveX = toX - fromX, moveZ = toZ - fromZ;
  const len = Math.hypot(moveX, moveZ);
  if (len < EPS) return [toX, toZ];
  const dirX = moveX / len, dirZ = moveZ / len;

  const allowed = Math.max(0, blockDist - r);
  const stopX = fromX + dirX * allowed, stopZ = fromZ + dirZ * allowed;
  const remaining = len - allowed;
  if (remaining <= EPS) return [stopX, stopZ];

  const nlen = Math.hypot(nx, nz);
  if (nlen < EPS) return [stopX, stopZ];
  const ux = nx / nlen, uz = nz / nlen;

  // Slide direction = move projected onto the wall plane (remove the into-wall component).
  const dn = dirX * ux + dirZ * uz;
  let sx = dirX - dn * ux, sz = dirZ - dn * uz;
  const slen = Math.hypot(sx, sz);
  if (slen < EPS) return [stopX, stopZ];   // moving straight into the wall → no tangent
  sx /= slen; sz /= slen;

  return [stopX + sx * remaining, stopZ + sz * remaining];
}

/**
 * Is the ground at the destination a climbable STEP rather than a wall? True when it rises above the feet by more
 * than a hair but no more than `stepHeight` — a curb/stair the character should step up onto (the ground clamp then
 * lifts the feet) instead of being blocked. null ground (a gap / nothing under the destination) is not a step.
 */
export function isClimbableStep(feetY: number, groundAtDest: number | null, stepHeight: number): boolean {
  if (groundAtDest === null) return false;
  const rise = groundAtDest - feetY;
  return rise > 1e-4 && rise <= stepHeight;
}

/**
 * Frame-rate-independent exponential smoothing of `current` toward `target`. `rate` is a 1/second responsiveness
 * (higher = snappier); `dt` is the elapsed seconds. rate ≤ 0 snaps instantly. Used to trail the third-person camera.
 */
export function expSmooth(current: number, target: number, rate: number, dt: number): number {
  if (rate <= 0 || dt <= 0) return dt <= 0 ? current : target;
  const a = 1 - Math.exp(-rate * dt);
  return current + (target - current) * a;
}

/**
 * Clamp a third-person camera distance so it doesn't pass through a wall: if a ray from the pivot toward the camera
 * hit something nearer than the desired distance, pull the camera in to `hitDist − padding` (never closer than
 * `minDist`, so it can't end up inside the character). No hit (hitDist ≥ desired) keeps the desired distance.
 */
export function clampCameraDistance(desired: number, hitDist: number, padding: number, minDist: number): number {
  if (hitDist >= desired) return desired;
  return Math.max(minDist, hitDist - padding);
}
