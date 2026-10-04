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

/**
 * Where the per-tick GROUND ray starts: just above the feet, at the STEP height (R6.2). Anything the ray finds below that
 * is ground the character may stand / step onto (a curb, a stair); anything higher (a bench, a car bonnet, an awning,
 * a tree canopy, a bridge deck, a cloud) is NOT ground — a low obstacle is blocked by the knee wall ray instead.
 *
 * History: the ray first started at y = 1e4 (the topmost surface won: the city player spawned on a cloud and popped
 * onto every canopy); Round 4 lowered it to max(stepHeight, ½ eye height) = 0.8 m, which still let the character pop
 * up 0.8 m onto a bench, and CASCADE up through stacked foliage cards / an awning's valance (each step starts the next
 * probe 0.8 m higher), and a jump's apex put the probe inside a low canopy. `eyeHeight` is accepted for the old call
 * shape and ignored.
 */
export function groundProbeTop(feetY: number, stepHeight: number, _eyeHeight?: number): number {
  return feetY + Math.max(stepHeight, 1e-4);
}

// ── Ray-cast based ground + wall resolution (R6.2) ─────────────────────────────────────────────────────────────────
// Pure over an injected ray caster, so the Play collision rules are unit-testable against a fake box world
// (collision-math.test.ts) while Scene3DManager backs the caster with the BVH mesh picker.

/** A ray hit: distance along the (unit) ray + the world surface normal at the hit. */
export interface RayHit { distance: number; normal: [number, number, number]; }
/** Cast a ray from `origin` along the unit `dir`; return the nearest hit within `maxDist`, or null. */
export type RayCaster = (origin: [number, number, number], dir: [number, number, number], maxDist: number) => RayHit | null;

const HEAD_EPS = 1e-3;

/**
 * The height of the ground the character can STAND on under (x, z), or null when there is none.
 *
 * Casts down from `feetY + stepHeight` (groundProbeTop): nothing above that window is ever ground. A surface above the
 * feet (a step UP) must also have HEADROOM — an upward ray from just above it must travel `headroom` (≈ the body
 * height) without hitting anything. Without room to stand it is not a floor (a foliage card under a canopy, a
 * ledge beneath a low beam), so the search continues BELOW it. A surface at or below the feet is accepted directly
 * (we already stand there, or it is where we fall to). `headroom` ≤ 0 disables the test.
 */
export function sampleStandableGround(
  cast: RayCaster, x: number, z: number, feetY: number, stepHeight: number, headroom: number, maxIter = 6,
): number | null {
  return findStandableGround(cast, x, z, groundProbeTop(feetY, stepHeight), headroom, feetY, maxIter);
}

/**
 * Walk down the column at (x, z) from `fromY` and return the first surface with `headroom` of free space above it.
 * Surfaces at or below `acceptBelowY` skip the headroom test (default −∞ = always test) — the spawn placement uses it
 * with no acceptBelowY so a Play started from the camera never lands on a tree canopy's inner cards.
 */
export function findStandableGround(
  cast: RayCaster, x: number, z: number, fromY: number, headroom: number, acceptBelowY = -Infinity, maxIter = 6,
): number | null {
  let top = fromY;
  for (let i = 0; i < maxIter; i++) {
    const down = cast([x, top, z], [0, -1, 0], Infinity);
    if (!down) return null;
    const y = top - down.distance;
    if (headroom <= 0 || y <= acceptBelowY + HEAD_EPS) return y;
    const up = cast([x, y + HEAD_EPS, z], [0, 1, 0], headroom);
    if (!up) return y;                       // room to stand
    top = y - HEAD_EPS;                      // no room: keep looking beneath this surface
  }
  return null;
}

/** Heights (above the feet) the horizontal wall rays are cast at: KNEE (just over the step height — anything it hits is
 *  too tall to step onto), MID body, and HEAD (a low beam / awning edge / branch at head height blocks you instead of
 *  being walked through). Duplicates collapse for a tiny body. */
export function wallRayHeights(stepHeight: number, eyeHeight: number): number[] {
  const knee = stepHeight * 1.05 + eyeHeight * 0.005;
  const hs = [knee, eyeHeight * 0.5, eyeHeight * 0.95].filter((h, i, a) => h > 0 && a.indexOf(h) === i);
  hs.sort((a, b) => a - b);
  return hs.filter((h, i) => i === 0 || h - hs[i - 1] > 1e-6);
}

/** Wall hits whose normal is this vertical (|ny|) are floors / ramps / ceilings, not walls — a ramp the knee ray grazes
 *  must stay walkable (≈ slopes up to 45°). */
const WALL_MAX_NY = 0.7;

function castWalls(cast: RayCaster, x: number, z: number, feetY: number, heights: number[], dirX: number, dirZ: number, maxDist: number): RayHit | null {
  let best: RayHit | null = null;
  for (const h of heights) {
    const hit = cast([x, feetY + h, z], [dirX, 0, dirZ], maxDist);
    if (!hit || Math.abs(hit.normal[1]) > WALL_MAX_NY) continue;
    if (!best || hit.distance < best.distance) best = hit;
  }
  return best;
}

/**
 * Resolve a horizontal move from (fx,fz) to (tx,tz) for a body of `radius` whose feet are at `feetY`: cast the wall
 * rays (wallRayHeights) along the move; if one hits within reach, stop short and slide along that wall (slideAlongWall),
 * re-casting along the slide so a corner can't be tunnelled. Steps lower than the knee ray pass (the ground clamp then
 * lifts the feet by at most stepHeight).
 */
export function resolveHorizontalMove(
  cast: RayCaster, fx: number, fz: number, tx: number, tz: number, feetY: number, radius: number, stepHeight: number, eyeHeight: number,
): [number, number] {
  const dx = tx - fx, dz = tz - fz;
  const dist = Math.hypot(dx, dz);
  if (dist < EPS) return [tx, tz];
  const dirX = dx / dist, dirZ = dz / dist;
  const heights = wallRayHeights(stepHeight, eyeHeight);
  const hit = castWalls(cast, fx, fz, feetY, heights, dirX, dirZ, dist + radius);
  if (!hit) return [tx, tz];
  const [sx, sz] = slideAlongWall(fx, fz, tx, tz, hit.distance, hit.normal[0], hit.normal[2], radius);
  const sdx = sx - fx, sdz = sz - fz;
  const sdist = Math.hypot(sdx, sdz);
  if (sdist < EPS) return [sx, sz];
  const sdirX = sdx / sdist, sdirZ = sdz / sdist;
  const hit2 = castWalls(cast, fx, fz, feetY, heights, sdirX, sdirZ, sdist + radius);
  if (hit2) {
    const allowed = Math.max(0, hit2.distance - radius);
    return [fx + sdirX * Math.min(allowed, sdist), fz + sdirZ * Math.min(allowed, sdist)];
  }
  return [sx, sz];
}
