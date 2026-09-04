/**
 * Camera math for the cinematic-camera system (docs/specs/cinematic-cameras.md).
 *
 * Pure / CPU / unit-testable. Two jobs:
 *  1. deriveCameraPose — turn a CameraNode's world matrix into the render camera's (eye, forward, up).
 *  2. frustumCorners / FRUSTUM_EDGES — the wireframe the gizmo draws to show what a camera sees.
 * No gl-matrix dependency; a plain column-major number[16] world matrix in, plain vectors out.
 */

export type Vec3 = [number, number, number];

export interface CameraPose { eye: Vec3; forward: Vec3; up: Vec3; }
export interface CameraSettings {
  fov: number;                                 // vertical FOV in radians (perspective)
  projection: 'perspective' | 'orthographic';
  orthoSize?: number;                          // half-height in world units (orthographic)
  near: number;
  far: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Derive (eye, forward, up) from a column-major 4×4 world matrix. Camera convention = looks down its local −Z
 * (the OpenGL/glTF convention), up = local +Y. So a node you rotate with the gizmo aims the camera.
 * Column-major layout: X-axis = m[0..2], Y = m[4..6], Z = m[8..10], translation = m[12..14].
 */
export function deriveCameraPose(worldMatrix: ArrayLike<number>): CameraPose {
  const m = worldMatrix;
  return {
    eye: [m[12], m[13], m[14]],
    forward: norm([-m[8], -m[9], -m[10]]),     // −Z axis
    up: norm([m[4], m[5], m[6]]),              // +Y axis
  };
}

/** The 8 world-space frustum corners: near [TL,TR,BR,BL] then far [TL,TR,BR,BL]. Ortho → a box (near size = far). */
export function frustumCorners(pose: CameraPose, s: CameraSettings, aspect: number): Vec3[] {
  const forward = norm(pose.forward);
  const right = norm(cross(forward, pose.up));
  const up = cross(right, forward);            // re-orthogonalized up
  let nh: number, nw: number, fh: number, fw: number;
  if (s.projection === 'orthographic') {
    const os = s.orthoSize ?? 1;
    nh = fh = os; nw = fw = os * aspect;
  } else {
    const t = Math.tan(s.fov / 2);
    nh = t * s.near; nw = nh * aspect;
    fh = t * s.far;  fw = fh * aspect;
  }
  const nc = add(pose.eye, scale(forward, s.near));
  const fc = add(pose.eye, scale(forward, s.far));
  const corner = (c: Vec3, w: number, h: number, sx: number, sy: number): Vec3 =>
    add(add(c, scale(right, sx * w)), scale(up, sy * h));
  return [
    corner(nc, nw, nh, -1, 1), corner(nc, nw, nh, 1, 1), corner(nc, nw, nh, 1, -1), corner(nc, nw, nh, -1, -1),
    corner(fc, fw, fh, -1, 1), corner(fc, fw, fh, 1, 1), corner(fc, fw, fh, 1, -1), corner(fc, fw, fh, -1, -1),
  ];
}

/** The 12 frustum edges as index pairs into the 8 corners: near loop, far loop, 4 connectors. */
export const FRUSTUM_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],   // near rect
  [4, 5], [5, 6], [6, 7], [7, 4],   // far rect
  [0, 4], [1, 5], [2, 6], [3, 7],   // connectors
];

/** Convenience: frustum edges as world-space line segments (for a line-list draw). */
export function frustumLineSegments(pose: CameraPose, s: CameraSettings, aspect: number): [Vec3, Vec3][] {
  const c = frustumCorners(pose, s, aspect);
  return FRUSTUM_EDGES.map(([a, b]) => [c[a], c[b]] as [Vec3, Vec3]);
}
