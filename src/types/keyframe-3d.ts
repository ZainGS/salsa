/**
 * Keyframe types and interpolation utilities for 3D mesh animation.
 *
 * Tracks are per-property arrays of { frame, value, easing } entries.
 * Interpolation is applied at render time by reading the current frame
 * from the timeline and calling sampleTrack() per property.
 */

export type KeyframeEasing = 'step' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

export interface Keyframe<T> {
  frame: number;
  value: T;
  easing: KeyframeEasing;
}

export type Vec3Value = [number, number, number];
export type Vec4Value = [number, number, number, number];

export interface Mesh3DKeyframeTracks {
  position?: Keyframe<Vec3Value>[];
  rotation?: Keyframe<Vec3Value>[];   // [rx, ry, rz] in radians
  scale?: Keyframe<Vec3Value>[];
  diffuseColor?: Keyframe<Vec4Value>[];  // [r, g, b, a]
  opacity?: Keyframe<number>[];
  visible?: Keyframe<boolean>[];
  /** CAMERA NODES only: vertical FOV in radians, for an in-shot zoom. Sampled while previewing/looking through the
   *  camera; ignored on non-camera meshes. */
  fov?: Keyframe<number>[];
  /** Per-shape-name weight tracks for blend shape animation. Key = blend shape name. */
  blendWeights?: Record<string, Keyframe<number>[]>;
}

export type TrackName = keyof Mesh3DKeyframeTracks;

/** Keyframe tracks for the 3D camera. */
export interface Camera3DKeyframeTracks {
  /** Camera world-space position [x, y, z]. */
  position?: Keyframe<Vec3Value>[];
  /** Camera look-at target [x, y, z]. */
  target?: Keyframe<Vec3Value>[];
  /** Vertical field of view in degrees (perspective mode only). */
  fov?: Keyframe<number>[];
}

export type CameraTrackName = keyof Camera3DKeyframeTracks;

// ── Interpolation helpers ──────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Cubic bezier easing (CSS-style) ───────────────────────────────
// Precomputed coefficients for B(t) = at³ + bt² + ct, with P0=(0,0), P3=(1,1).

function makeCubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
  const cx = 3 * p1x,           bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y,           by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const derivX  = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton's method to find t for a given x, then evaluate y(t)
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) break;
      const d = derivX(t);
      if (Math.abs(d) < 1e-7) break;
      t -= err / d;
    }
    return sampleY(Math.max(0, Math.min(1, t)));
  };
}

const EASE_IN     = makeCubicBezier(0.42, 0,    1.0,  1.0);
const EASE_OUT    = makeCubicBezier(0.0,  0,    0.58, 1.0);
const EASE_IN_OUT = makeCubicBezier(0.42, 0,    0.58, 1.0);

function applyEasing(t: number, easing: KeyframeEasing): number {
  switch (easing) {
    case 'ease-in':     return EASE_IN(t);
    case 'ease-out':    return EASE_OUT(t);
    case 'ease-in-out': return EASE_IN_OUT(t);
    default:            return t; // linear
  }
}

export function interpolateScalar(a: number, b: number, t: number, easing: KeyframeEasing): number {
  if (easing === 'step') return a;
  return lerp(a, b, applyEasing(t, easing));
}

export function interpolateVec3(a: Vec3Value, b: Vec3Value, t: number, easing: KeyframeEasing): Vec3Value {
  if (easing === 'step') return [a[0], a[1], a[2]];
  const et = applyEasing(t, easing);
  return [lerp(a[0], b[0], et), lerp(a[1], b[1], et), lerp(a[2], b[2], et)];
}

export function interpolateVec4(a: Vec4Value, b: Vec4Value, t: number, easing: KeyframeEasing): Vec4Value {
  if (easing === 'step') return [a[0], a[1], a[2], a[3]];
  const et = applyEasing(t, easing);
  return [lerp(a[0], b[0], et), lerp(a[1], b[1], et), lerp(a[2], b[2], et), lerp(a[3], b[3], et)];
}

// ── Quaternion slerp for rotation tracks ───────────────────────────
// Component-wise lerp of Euler angles wobbles / gimbal-flips on big rotations (e.g. a camera panning 180°). For
// smooth arcs we convert the two Euler keys → quaternions → slerp → back to Euler. Self-contained (no gl-matrix)
// so it stays pure + unit-testable. Euler order MUST match Shape.localMatrix, which applies Ry·Rx·Rz (YXZ), with
// the value laid out [rotationX, rotationY, rotationZ].
type Quat = [number, number, number, number];   // x, y, z, w

/** Hamilton product a·b. */
function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
/** Quaternion for a rotation of `angle` (radians) about a principal axis (0=X, 1=Y, 2=Z). */
function qAxis(axis: 0 | 1 | 2, angle: number): Quat {
  const h = angle / 2, s = Math.sin(h);
  const q: Quat = [0, 0, 0, Math.cos(h)];
  q[axis] = s;
  return q;
}
/** Euler [x,y,z] (YXZ order) → quaternion, i.e. q = qY·qX·qZ (mirrors Ry·Rx·Rz). */
function eulerYXZToQuat(e: Vec3Value): Quat {
  return qMul(qMul(qAxis(1, e[1]), qAxis(0, e[0])), qAxis(2, e[2]));
}
/** Quaternion → Euler [x,y,z] in YXZ order (three.js extraction). */
function quatToEulerYXZ(q: Quat): Vec3Value {
  const [x, y, z, w] = q;
  const m23 = 2 * (y * z - w * x);
  const clamped = Math.max(-1, Math.min(1, m23));
  const ex = Math.asin(-clamped);
  let ey: number, ez: number;
  if (Math.abs(m23) < 0.9999999) {
    ey = Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));   // atan2(m13, m33)
    ez = Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z));   // atan2(m21, m22)
  } else {                                                          // gimbal pole
    ey = Math.atan2(-2 * (x * z - w * y), 1 - 2 * (y * y + z * z));  // atan2(-m31, m11)
    ez = 0;
  }
  return [ex, ey, ez];
}
function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb: Quat = b;
  if (dot < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }   // shortest path
  if (dot > 0.9995) {                                              // nearly parallel → nlerp
    const r: Quat = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const n = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const theta0 = Math.acos(dot), theta = theta0 * t;
  const s1 = Math.sin(theta) / Math.sin(theta0);
  const s0 = Math.cos(theta) - dot * s1;
  return [a[0] * s0 + bb[0] * s1, a[1] * s0 + bb[1] * s1, a[2] * s0 + bb[2] * s1, a[3] * s0 + bb[3] * s1];
}

/** Rotation-track interpolator that slerps (smooth arcs, no gimbal wobble). Drop-in for interpolateVec3 on a
 *  rotation track — used for camera nodes so pans stay smooth. Values are Euler [x,y,z] radians, YXZ order. */
export function interpolateEulerSlerp(a: Vec3Value, b: Vec3Value, t: number, easing: KeyframeEasing): Vec3Value {
  if (easing === 'step') return [a[0], a[1], a[2]];
  const et = applyEasing(t, easing);
  return quatToEulerYXZ(qSlerp(eulerYXZToQuat(a), eulerYXZToQuat(b), et));
}

// ── Track sampler ──────────────────────────────────────────────────

/**
 * Sample a keyframe track at the given frame number.
 * Sorts keyframes by frame, then interpolates between the surrounding pair.
 * Returns null if the track is empty.
 */
export function sampleTrack<T>(
  track: Keyframe<T>[],
  frame: number,
  interpolateFn: (a: T, b: T, t: number, easing: KeyframeEasing) => T,
): T | null {
  if (!track || track.length === 0) return null;
  const sorted = track.slice().sort((a, b) => a.frame - b.frame);
  if (frame <= sorted[0].frame) return sorted[0].value;
  if (frame >= sorted[sorted.length - 1].frame) return sorted[sorted.length - 1].value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const k0 = sorted[i];
    const k1 = sorted[i + 1];
    if (frame >= k0.frame && frame <= k1.frame) {
      const t = (frame - k0.frame) / (k1.frame - k0.frame);
      return interpolateFn(k0.value, k1.value, t, k0.easing);
    }
  }
  return sorted[sorted.length - 1].value;
}

/** Upsert a keyframe into a track array (replace if frame already exists). */
export function setKeyframe<T>(track: Keyframe<T>[], frame: number, value: T, easing: KeyframeEasing = 'linear'): void {
  const idx = track.findIndex(k => k.frame === frame);
  if (idx >= 0) {
    track[idx] = { frame, value, easing };
  } else {
    track.push({ frame, value, easing });
  }
}

/** Remove a keyframe from a track array at the given frame. */
export function removeKeyframe<T>(track: Keyframe<T>[], frame: number): boolean {
  const idx = track.findIndex(k => k.frame === frame);
  if (idx < 0) return false;
  track.splice(idx, 1);
  return true;
}

// ── Frame Link Animation 3D ────────────────────────────────────────
// Procedural per-frame transform applied on top of keyframe values.
// Completely stateless — computed from the frame number each render.

export type FrameLinkAnimation3DType =
  | 'bounce'   // sinusoidal translation along an axis
  | 'sway'     // sinusoidal rotation around an axis
  | 'spin'     // continuous rotation around an axis (linear)
  | 'pulse'    // sinusoidal uniform scale
  | 'shake'    // random per-frame position jitter
  | 'scroll'   // continuous UV texture scroll (ribbon / plane meshes)
  | 'wind';    // sinusoidal wind force for live cloth physics (ClothMesh3D only)

export type FrameLinkAxis3D = 'x' | 'y' | 'z';

export interface FrameLinkAnimation3D {
  enabled: boolean;
  type: FrameLinkAnimation3DType;
  /** Axis affected. For 'pulse' this is ignored (uniform scale). */
  axis: FrameLinkAxis3D;
  /** Peak displacement for 'bounce' (world units), degrees for 'sway',
   *  degrees/frame for 'spin', scale multiplier delta for 'pulse',
   *  world units for 'shake'. */
  amplitude: number;
  /** Frames per full cycle (for sine-based types). Default 24. */
  framesPerCycle: number;
  /** Phase offset in full cycles (0–1). Default 0. */
  phase: number;
}

export const DEFAULT_FRAME_LINK_ANIMATION_3D: FrameLinkAnimation3D = {
  enabled: false,
  type: 'bounce',
  axis: 'y',
  amplitude: 0.1,
  framesPerCycle: 24,
  phase: 0,
};

/**
 * Evaluate a FrameLinkAnimation3D at the given frame.
 *
 * Returns deltas to add on top of keyframed values:
 *   pos      — [dx, dy, dz] translation delta
 *   rot      — [drx, dry, drz] rotation delta in radians
 *   scale    — [dsx, dsy, dsz] scale delta
 *   uvOffset — [du, dv] UV coordinate offset (used by 'scroll' type)
 *   wind     — [wx, wy, wz] wind acceleration in world units/s² (used by 'wind' type
 *              on live ClothMesh3D nodes; zero for all other mesh types)
 */
export function evalFrameLink3D(
  anim: FrameLinkAnimation3D,
  frame: number,
): { pos: Vec3Value; rot: Vec3Value; scale: Vec3Value; uvOffset: [number, number]; wind: Vec3Value } {
  const pos: Vec3Value   = [0, 0, 0];
  const rot: Vec3Value   = [0, 0, 0];
  const scale: Vec3Value = [0, 0, 0];
  const uvOffset: [number, number] = [0, 0];
  const wind: Vec3Value  = [0, 0, 0];
  if (!anim.enabled) return { pos, rot, scale, uvOffset, wind };

  const axisIdx = anim.axis === 'x' ? 0 : anim.axis === 'y' ? 1 : 2;
  const t = frame / Math.max(1, anim.framesPerCycle);
  const angle = (t + anim.phase) * Math.PI * 2;

  switch (anim.type) {
    case 'bounce':
      pos[axisIdx] = Math.sin(angle) * anim.amplitude;
      break;
    case 'sway':
      rot[axisIdx] = Math.sin(angle) * (anim.amplitude * Math.PI / 180);
      break;
    case 'spin':
      // Constant delta per frame — accumulates via += in applyMeshKeyframesAtFrame
      rot[axisIdx] = anim.amplitude * Math.PI / 180;
      break;
    case 'pulse': {
      const delta = Math.sin(angle) * anim.amplitude;
      scale[0] = delta; scale[1] = delta; scale[2] = delta;
      break;
    }
    case 'shake': {
      // Deterministic per-frame jitter using a simple hash
      const h = (n: number) => ((Math.sin(n * 127.1 + frame * 311.7) * 43758.5453) % 1 + 1) % 1;
      pos[0] = (h(0) * 2 - 1) * anim.amplitude;
      pos[1] = (h(1) * 2 - 1) * anim.amplitude;
      pos[2] = (h(2) * 2 - 1) * anim.amplitude;
      break;
    }
    case 'scroll': {
      // Continuous UV scroll: offset = frame / framesPerCycle * amplitude
      // amplitude = UV units scrolled per full framesPerCycle cycle
      // axis 'x' → U scroll, axis 'y' → V scroll, axis 'z' → diagonal
      const offset = t * anim.amplitude;
      if (anim.axis === 'x') uvOffset[0] = offset;
      else if (anim.axis === 'y') uvOffset[1] = offset;
      else { uvOffset[0] = offset; uvOffset[1] = offset; }
      break;
    }
    case 'wind': {
      // Sinusoidal wind gust in the specified axis direction.
      // amplitude = peak force (world units/s²), framesPerCycle = gust frequency.
      // axis 'x' = sideways, 'y' = updraft, 'z' = depth.
      wind[axisIdx] = Math.sin(angle) * anim.amplitude;
      break;
    }
  }
  return { pos, rot, scale, uvOffset, wind };
}

// ── Structured keyframe cloning ──────────────────────────────────────────────
// Shallow-per-value copies used for undo snapshots and per-mesh restore/duplicate. Keyframe values are either
// scalars, small number[] arrays (vec3/vec4), or RGBA sub-objects; structured per-track copies avoid serializing
// the whole tracks map per edit.

export function cloneKeyframeValue<T>(v: T): T {
  if (Array.isArray(v)) return v.slice() as unknown as T;
  if (v && typeof v === 'object') return { ...(v as object) } as T;
  return v;
}

export function cloneKeyframeTrack<T>(track: Keyframe<T>[]): Keyframe<T>[] {
  return track.map(k => ({ frame: k.frame, value: cloneKeyframeValue(k.value), easing: k.easing }));
}

/** Structured deep copy of a mesh's keyframe tracks: fresh map + per-track keyframe copies. */
export function cloneKeyframeTracks(tracks: Mesh3DKeyframeTracks): Mesh3DKeyframeTracks {
  const out: Mesh3DKeyframeTracks = {};
  for (const key of Object.keys(tracks) as (keyof Mesh3DKeyframeTracks)[]) {
    if (key === 'blendWeights') {
      const bw = tracks.blendWeights;
      if (!bw) continue;
      const copy: Record<string, Keyframe<number>[]> = {};
      for (const name of Object.keys(bw)) copy[name] = cloneKeyframeTrack(bw[name]);
      out.blendWeights = copy;
    } else {
      const tr = tracks[key];
      if (tr) (out as Record<string, unknown>)[key] = cloneKeyframeTrack(tr as Keyframe<unknown>[]);
    }
  }
  return out;
}
