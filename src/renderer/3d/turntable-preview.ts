/**
 * turntable-preview — pure planning math for animated library thumbnails (animation-library-and-triggers.md §8).
 *
 * A library "thumbnail" is a short rotating loop: as the clip plays, a camera orbits the character, so the strip
 * shows both the MOTION and the pose from every side. This module is the GPU-free brain — the frame/angle schedule,
 * a bounding sphere from joint positions, and the orbit camera pose that frames that sphere. Scene3DManager drives
 * the actual render+readback per step; keeping this pure makes the "which frame, which angle, where's the camera"
 * decisions unit-testable without a GPU.
 */

export interface TurntableStep {
  /** Clip frame to pose the skeleton at for this step. */
  frame: number;
  /** Camera yaw (radians about +Y) for this step. */
  yaw: number;
}

export interface TurntablePlanOptions {
  frames: number;          // number of steps (each becomes one strip cell)
  clipStartFrame: number;
  clipEndFrame: number;
  turns?: number;          // full camera revolutions across the whole strip (default 1)
}

/**
 * The per-step schedule: `frames` steps, the clip's frame swept once (× nothing extra) across the strip while the
 * camera yaw sweeps `turns` full revolutions. A single-frame clip (start === end) yields a static pose that still
 * rotates. `frames` is clamped to ≥ 1.
 */
export function planTurntable(opts: TurntablePlanOptions): TurntableStep[] {
  const n = Math.max(1, Math.floor(opts.frames));
  const turns = opts.turns ?? 1;
  const span = opts.clipEndFrame - opts.clipStartFrame;
  const out: TurntableStep[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / n;                       // [0,1) so the last step doesn't duplicate the first (loops)
    out.push({ frame: opts.clipStartFrame + t * span, yaw: t * turns * Math.PI * 2 });
  }
  return out;
}

/**
 * Bounding sphere (center + radius) over a set of points — e.g. a skeleton's joint world positions, a cheap stand-in
 * for the character's extent. Center is the AABB midpoint; radius is the farthest point from it (tight enough for
 * framing). Empty input → origin, radius 1 (so framing never divides by zero).
 */
export function boundsCenterRadius(points: readonly [number, number, number][]): { center: [number, number, number]; radius: number } {
  if (points.length === 0) return { center: [0, 0, 0], radius: 1 };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of points) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let radius = 0;
  for (const [x, y, z] of points) {
    const dx = x - center[0], dy = y - center[1], dz = z - center[2];
    radius = Math.max(radius, Math.hypot(dx, dy, dz));
  }
  return { center, radius: radius || 1 };
}

/**
 * Camera pose orbiting `center` at the given `yaw` (about +Y) and `pitch` (radians, positive tilts the camera up so it
 * looks slightly down), pulled back far enough that a sphere of `radius` fits a vertical FOV of `fovY` with `margin`
 * padding (1.0 = exact fit, 1.3 = comfortable). Returns eye `position` + `target` (= center) for `uiSetCamera`.
 */
export function orbitCameraPose(
  center: [number, number, number], radius: number, yaw: number, pitch: number, fovY: number, margin = 1.3,
): { position: [number, number, number]; target: [number, number, number] } {
  const halfFov = Math.max(0.01, fovY / 2);
  const dist = (Math.max(radius, 1e-4) / Math.sin(halfFov)) * margin;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const offset: [number, number, number] = [
    Math.sin(yaw) * cp * dist,
    sp * dist,
    Math.cos(yaw) * cp * dist,
  ];
  return {
    position: [center[0] + offset[0], center[1] + offset[1], center[2] + offset[2]],
    target: [center[0], center[1], center[2]],
  };
}
