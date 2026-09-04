/**
 * GizmoRenderer — Draws transform gizmos (move/rotate/scale) for selected 3D meshes.
 *
 * The gizmo is rendered in world space at the centroid of the selected meshes,
 * scaled to a constant screen-space size based on camera distance.
 *
 * Gizmo is drawn after all 3D meshes with depth compare = 'always' so it is
 * always visible regardless of mesh occlusion (standard behavior for editor gizmos).
 *
 * Also provides CPU-side hit testing for axis/plane picking during drag.
 */

import { mat4, vec3, vec4 } from 'gl-matrix';
import { Camera3D } from './camera-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { IKChain } from '../../types/armature-3d';
import {
  GIZMO_VERTEX_SHADER,
  GIZMO_FRAGMENT_SHADER,
  GIZMO_VERTEX_STRIDE,
  GIZMO_UNIFORM_SIZE,
} from './shaders/gizmo-shaders';

// ── Types ──────────────────────────────────────────────────────────

export type GizmoMode = 'move' | 'rotate' | 'scale' | null;

/** Which handle is currently hit/dragged on an array gizmo. */
export type ArrayHandleHit = 'x' | 'y' | 'radius' | null;

/** A hit on an IK handle — identifies both the chain and which handle was hit. */
export interface IKHandleHit {
  chainId: string;
  /** 'target' = IK end-effector sphere; 'pole' = pole vector sphere. */
  handleType: 'target' | 'pole';
}

/** Data needed to draw and hit-test an array gizmo (linear, grid, or radial). */
export interface ArrayGizmoData {
  /** ID of the ArrayGroup3D this gizmo belongs to. */
  groupId: string;
  mode: 'linear' | 'grid' | 'radial';

  // ── Linear / Grid X-arm ────────────────────────────────────────────────
  /** World-space position of the source mesh. */
  sourcePos: [number, number, number];
  /** World-space position of the X drag handle (source + countX * spacingX). */
  handlePos: [number, number, number];
  /** Unit-vector in the X spacing direction. */
  axisDir: [number, number, number];
  /** Number of copies along X (not counting source). */
  countX: number;
  /** Current X spacing vector. */
  currentSpacing: [number, number, number];

  // ── Grid Y-arm (grid mode only) ────────────────────────────────────────
  /** World-space position of the Y drag handle (source + countY * spacingY). */
  handlePosY?: [number, number, number];
  /** Unit-vector in the Y spacing direction. */
  axisDirY?: [number, number, number];
  /** Number of copies along Y. */
  countY?: number;
  /** Current Y spacing vector. */
  currentSpacingY?: [number, number, number];

  // ── Radial (radial mode only) ──────────────────────────────────────────
  /** World-space center of the ring. */
  radialCenter?: [number, number, number];
  /** Current ring radius. */
  currentRadius?: number;
  /** Arc covered in degrees (360 = full ring). */
  arcDeg?: number;
  /** Rotation axis (world mode). */
  radialAxis?: 'x' | 'y' | 'z';
  /** Total instance count including source. */
  totalCount?: number;
  /** Local-mode ring tangent (sin component for x/y axis; cos for z). When absent, world axis is used. */
  radialTangent?: [number, number, number];
  /** Local-mode ring bitangent (cos component for x/y axis; sin for z). */
  radialBitangent?: [number, number, number];
  /** Ring plane normal — used for radius drag plane projection. */
  radialNormal?: [number, number, number];
}

// ── Face handles (Array Tool hover mode) ──────────────────────────────────────

/** A single face handle arrow shown on the hovered mesh when the Array Tool is active. */
export interface FaceHandle {
  /** Unique ID, e.g. 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz' | 'pxpz' | etc. */
  id: string;
  /** World-space tip position of the handle (slightly beyond the AABB face). */
  pos: [number, number, number];
  /** Unit direction the handle points outward from the mesh. */
  dir: [number, number, number];
  /**
   * 'primary' = cardinal axes (bright, large).
   * 'secondary' = diagonal (Grid mode only, smaller, orange).
   */
  tier: 'primary' | 'secondary';
}

/** All face handles + hover state for the current frame. */
export interface FaceHandleData {
  handles: FaceHandle[];
  /** ID of the currently hovered handle, or null. */
  hoveredId: string | null;
  /** World-space OBB/AABB center — used to draw axis lines from center → handle. */
  center: [number, number, number];
}

// ── Gizmo axis ────────────────────────────────────────────────────────────────

/** Which axis/plane the mouse is over or dragging on. */
export type GizmoAxis =
  | 'x' | 'y' | 'z'      // single-axis (move/scale) or arc (rotate)
  | 'xy' | 'xz' | 'yz'   // plane (move mode only)
  | null;

// ── Colors ────────────────────────────────────────────────────────

const COL_X: [number, number, number, number] = [1, 0.2, 0.2, 1];
const COL_Y: [number, number, number, number] = [0.2, 1, 0.2, 1];
const COL_Z: [number, number, number, number] = [0.3, 0.5, 1, 1];
const COL_HOVER: [number, number, number, number] = [1, 0.9, 0.1, 1];
const COL_PLANE_X: [number, number, number, number] = [1, 0.2, 0.2, 0.35];
const COL_PLANE_Y: [number, number, number, number] = [0.2, 1, 0.2, 0.35];
const COL_PLANE_Z: [number, number, number, number] = [0.3, 0.5, 1, 0.35];
const COL_PLANE_HOVER: [number, number, number, number] = [1, 0.9, 0.1, 0.5];
const COL_SEL_EDGE:        [number, number, number, number] = [0.3, 0.6, 1.0, 0.85];
const COL_SEL_CORNER:      [number, number, number, number] = [0.65, 0.70, 0.78, 1.0];
const COL_SEL_CORNER_HOVER:[number, number, number, number] = [1.0,  0.9,  0.1,  1.0];

// ── GPU buffer limits ──────────────────────────────────────────────

const MAX_GIZMO_VERTS = 4096;
const MAX_GIZMO_IDXS  = 12288;
// Array gizmo: linear/grid arms + sphere handles + radial arc (up to 64 segments)
const MAX_ARRAY_GIZMO_VERTS = 4096;
const MAX_ARRAY_GIZMO_IDXS  = 16384;
// Face handles: up to 10 handles × (shaft prism 8v/36i + sphere ~42v/240i)
const MAX_FACE_HANDLE_VERTS = 1024;
const MAX_FACE_HANDLE_IDXS  = 4096;
// Selection box: 12 edge prisms (8v+36i each) + 8 corner spheres (~42v+240i each) per mesh
const MAX_SEL_BOX_VERTS = 8192;
const MAX_SEL_BOX_IDXS  = 49152;
// Ground grid: up to ~100 lines each axis × 2 dirs × 2 verts = ~808; round up generously
const MAX_GRID_VERTS = 2048;
// Vertex-snap viz: 2 rings (48 segs × 6 verts) + up to 40 candidate squares (6 verts each)
const MAX_SNAP_VIZ_VERTS = 2048;

/**
 * Vertex-snap "double-circle" viz (drawn by drawSnapViz, on top of everything). World positions +
 * screen-pixel radii — same shape as the controller's SnapVizData (structural).
 */
export interface SnapViz3D {
  centerWorld: [number, number, number];
  innerPx: number;
  outerPx: number;
  candidates: { world: [number, number, number]; depthT: number; active: boolean }[];
}

// ── Geometry builder helpers ───────────────────────────────────────

type Color4 = [number, number, number, number];

function pushVert(verts: number[], x: number, y: number, z: number, c: Color4): void {
  verts.push(x, y, z, c[0], c[1], c[2], c[3]);
}

/**
 * Append an arrow (shaft cylinder + cone tip) along the given axis.
 * Everything is in gizmo-local space where 1 unit = gizmoScale in world space.
 */
function addArrow(
  verts: number[],
  idxs: number[],
  axis: 'x' | 'y' | 'z',
  color: Color4,
  segments = 8,
): void {
  const shaftLen = 0.78;
  const shaftR   = 0.04;
  const coneBaseR = 0.12;
  const coneStart = 0.78;
  const tipLen    = 1.0;

  // Basis vectors for each axis
  const [ax, ay, az] = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const [tx, ty, tz] = axis === 'x' ? [0, 1, 0] : axis === 'y' ? [1, 0, 0] : [1, 0, 0];
  const [bx, by, bz] = axis === 'x' ? [0, 0, 1] : axis === 'y' ? [0, 0, 1] : [0, 1, 0];

  const N = segments;
  const base = verts.length / 7;

  // Shaft: two rings at along=0 and along=shaftLen
  for (let ring = 0; ring < 2; ring++) {
    const along = ring === 0 ? 0 : shaftLen;
    for (let i = 0; i <= N; i++) {
      const theta = (i / N) * Math.PI * 2;
      const cos = Math.cos(theta) * shaftR;
      const sin = Math.sin(theta) * shaftR;
      pushVert(verts,
        ax * along + tx * cos + bx * sin,
        ay * along + ty * cos + by * sin,
        az * along + tz * cos + bz * sin,
        color);
    }
  }
  const ringStride = N + 1;
  for (let i = 0; i < N; i++) {
    const a = base + i, b = base + ringStride + i;
    idxs.push(a, b, a + 1, a + 1, b, b + 1);
  }

  // Cone base ring
  const coneBase = base + ringStride * 2;
  for (let i = 0; i <= N; i++) {
    const theta = (i / N) * Math.PI * 2;
    const cos = Math.cos(theta) * coneBaseR;
    const sin = Math.sin(theta) * coneBaseR;
    pushVert(verts,
      ax * coneStart + tx * cos + bx * sin,
      ay * coneStart + ty * cos + by * sin,
      az * coneStart + tz * cos + bz * sin,
      color);
  }

  // Cone tip
  const tipIdx = coneBase + (N + 1);
  pushVert(verts, ax * tipLen, ay * tipLen, az * tipLen, color);

  for (let i = 0; i < N; i++) {
    idxs.push(tipIdx, coneBase + i, coneBase + i + 1);
  }
  // Cone base cap (close it off)
  const capCenter = tipIdx + 1;
  pushVert(verts, ax * coneStart, ay * coneStart, az * coneStart, color);
  for (let i = 0; i < N; i++) {
    idxs.push(capCenter, coneBase + i + 1, coneBase + i);
  }
}

/**
 * Append a scale cube at the end of an arrow shaft.
 */
function addScaleCube(
  verts: number[],
  idxs: number[],
  axis: 'x' | 'y' | 'z',
  color: Color4,
  segments = 8,
): void {
  // Shaft (same as arrow)
  const shaftLen = 0.78;
  const shaftR   = 0.04;
  const [ax, ay, az] = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const [tx, ty, tz] = axis === 'x' ? [0, 1, 0] : axis === 'y' ? [1, 0, 0] : [1, 0, 0];
  const [bx, by, bz] = axis === 'x' ? [0, 0, 1] : axis === 'y' ? [0, 0, 1] : [0, 1, 0];

  const N = segments;
  const base = verts.length / 7;

  for (let ring = 0; ring < 2; ring++) {
    const along = ring === 0 ? 0 : shaftLen;
    for (let i = 0; i <= N; i++) {
      const theta = (i / N) * Math.PI * 2;
      const cos = Math.cos(theta) * shaftR;
      const sin = Math.sin(theta) * shaftR;
      pushVert(verts,
        ax * along + tx * cos + bx * sin,
        ay * along + ty * cos + by * sin,
        az * along + tz * cos + bz * sin,
        color);
    }
  }
  const ringStride = N + 1;
  for (let i = 0; i < N; i++) {
    const a = base + i, b = base + ringStride + i;
    idxs.push(a, b, a + 1, a + 1, b, b + 1);
  }

  // Cube centered at along=0.88, half size=0.12
  const cubeBase = verts.length / 7;
  const center = 0.88;
  const half   = 0.12;
  const signs: [number, number, number][] = [
    [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
    [-1, -1,  1], [1, -1,  1], [-1, 1,  1], [1, 1,  1],
  ];
  for (const [sx, sy, sz] of signs) {
    pushVert(verts,
      ax * (center + sz * half) + tx * sx * half + bx * sy * half,
      ay * (center + sz * half) + ty * sx * half + by * sy * half,
      az * (center + sz * half) + tz * sx * half + bz * sy * half,
      color);
  }
  const faceIdxs = [
    0, 1, 2, 1, 3, 2,
    4, 6, 5, 5, 6, 7,
    0, 4, 1, 1, 4, 5,
    2, 3, 6, 3, 7, 6,
    0, 2, 4, 2, 6, 4,
    1, 5, 3, 5, 7, 3,
  ];
  for (const fi of faceIdxs) idxs.push(cubeBase + fi);
}

/**
 * Append a partial washer arc around the given axis.
 *
 * sweepAngle controls how much of the circle to draw (default 3π/2 = 270°,
 * the Spline-style open arc). The ring has wall thickness so it reads clearly
 * from any camera angle.
 */
function addRotateRing(
  verts: number[],
  idxs: number[],
  axis: 'x' | 'y' | 'z',
  color: Color4,
  segments = 40,
  sweepAngle = Math.PI * 1.5,  // 270° — leaves one quadrant open
): void {
  const radius = 1.0;
  const halfW  = 0.028;
  const halfT  = 0.025;
  const innerR = radius - halfW;
  const outerR = radius + halfW;

  const [ax, ay, az] = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const base = verts.length / 7;

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * sweepAngle;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    let bx: number, by: number, bz: number;
    if (axis === 'x')      { bx = 0; by = cos; bz = sin; }
    else if (axis === 'y') { bx = cos; by = 0; bz = sin; }
    else                   { bx = cos; by = sin; bz = 0; }

    pushVert(verts, bx * innerR + ax * halfT, by * innerR + ay * halfT, bz * innerR + az * halfT, color);
    pushVert(verts, bx * innerR - ax * halfT, by * innerR - ay * halfT, bz * innerR - az * halfT, color);
    pushVert(verts, bx * outerR + ax * halfT, by * outerR + ay * halfT, bz * outerR + az * halfT, color);
    pushVert(verts, bx * outerR - ax * halfT, by * outerR - ay * halfT, bz * outerR - az * halfT, color);
  }

  for (let i = 0; i < segments; i++) {
    const a = base + i * 4;
    const b = a + 4;
    idxs.push(a+0, a+2, b+0,  b+0, a+2, b+2);
    idxs.push(a+1, b+1, a+3,  b+1, b+3, a+3);
    idxs.push(a+2, a+3, b+2,  a+3, b+3, b+2);
    idxs.push(a+0, b+0, a+1,  a+1, b+0, b+1);
  }
}

/**
 * Append a thin rectangular prism between two world-space points.
 * Used for selection-box wireframe edges. thickness is in world units.
 */
function addEdgePrism(
  verts: number[],
  idxs: number[],
  p1: [number, number, number],
  p2: [number, number, number],
  thickness: number,
  color: Color4,
): void {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], dz = p2[2] - p1[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return;
  const d: [number, number, number] = [dx / len, dy / len, dz / len];

  // Perpendicular basis for square cross-section
  const ref: [number, number, number] = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u0 = d[1] * ref[2] - d[2] * ref[1];
  let u1 = d[2] * ref[0] - d[0] * ref[2];
  let u2 = d[0] * ref[1] - d[1] * ref[0];
  const ul = Math.sqrt(u0 * u0 + u1 * u1 + u2 * u2);
  u0 /= ul; u1 /= ul; u2 /= ul;
  const v0 = d[1] * u2 - d[2] * u1;
  const v1 = d[2] * u0 - d[0] * u2;
  const v2 = d[0] * u1 - d[1] * u0;

  const h = thickness * 0.5;
  const base = verts.length / 7;
  const corners: [number, number, number][] = [
    [-u0 - v0, -u1 - v1, -u2 - v2],
    [ u0 - v0,  u1 - v1,  u2 - v2],
    [ u0 + v0,  u1 + v1,  u2 + v2],
    [-u0 + v0, -u1 + v1, -u2 + v2],
  ];

  for (const end of [p1, p2]) {
    for (const [cx, cy, cz] of corners) {
      pushVert(verts, end[0] + cx * h, end[1] + cy * h, end[2] + cz * h, color);
    }
  }

  for (let i = 0; i < 4; i++) {
    const a = base + i, b = base + (i + 1) % 4;
    const c = base + 4 + i, dd = base + 4 + (i + 1) % 4;
    idxs.push(a, c, b,  b, c, dd);
  }
  idxs.push(base + 0, base + 1, base + 2,  base + 0, base + 2, base + 3);
  idxs.push(base + 4, base + 6, base + 5,  base + 4, base + 7, base + 6);
}

/**
 * Append a UV sphere centered at (cx, cy, cz).
 * latSegs=5, lonSegs=8 produces a smooth-enough sphere at small sizes.
 */
function addUvSphere(
  verts: number[],
  idxs: number[],
  cx: number, cy: number, cz: number,
  radius: number,
  color: Color4,
  latSegs = 5,
  lonSegs = 8,
): void {
  const base = verts.length / 7;
  pushVert(verts, cx, cy + radius, cz, color);                     // top pole

  for (let lat = 1; lat < latSegs; lat++) {
    const phi = (lat / latSegs) * Math.PI;
    const y = Math.cos(phi) * radius;
    const r = Math.sin(phi) * radius;
    for (let lon = 0; lon < lonSegs; lon++) {
      const theta = (lon / lonSegs) * Math.PI * 2;
      pushVert(verts, cx + Math.cos(theta) * r, cy + y, cz + Math.sin(theta) * r, color);
    }
  }

  pushVert(verts, cx, cy - radius, cz, color);                     // bottom pole
  const bottomPole = base + 1 + (latSegs - 1) * lonSegs;

  // Top cap
  for (let lon = 0; lon < lonSegs; lon++) {
    idxs.push(base, base + 1 + lon, base + 1 + (lon + 1) % lonSegs);
  }
  // Middle bands
  for (let lat = 0; lat < latSegs - 2; lat++) {
    for (let lon = 0; lon < lonSegs; lon++) {
      const a = base + 1 + lat * lonSegs + lon;
      const b = base + 1 + lat * lonSegs + (lon + 1) % lonSegs;
      const c = base + 1 + (lat + 1) * lonSegs + lon;
      const dd = base + 1 + (lat + 1) * lonSegs + (lon + 1) % lonSegs;
      idxs.push(a, b, c,  b, dd, c);
    }
  }
  // Bottom cap
  const lastRingBase = base + 1 + (latSegs - 2) * lonSegs;
  for (let lon = 0; lon < lonSegs; lon++) {
    idxs.push(bottomPole, lastRingBase + (lon + 1) % lonSegs, lastRingBase + lon);
  }
}

/**
 * Append a small square quad near the gizmo origin for plane translation.
 * Lives in the plane spanned by the two non-axis directions.
 */
function addPlaneHandle(
  verts: number[],
  idxs: number[],
  plane: 'xy' | 'xz' | 'yz',
  color: Color4,
): void {
  const s  = 0.22; // square size
  const off = 0.25; // offset from origin
  let corners: [number, number, number][];
  if (plane === 'xy') {
    corners = [[off, off, 0], [off + s, off, 0], [off + s, off + s, 0], [off, off + s, 0]];
  } else if (plane === 'xz') {
    corners = [[off, 0, off], [off + s, 0, off], [off + s, 0, off + s], [off, 0, off + s]];
  } else {
    corners = [[0, off, off], [0, off + s, off], [0, off + s, off + s], [0, off, off + s]];
  }
  const base = verts.length / 7;
  for (const [x, y, z] of corners) pushVert(verts, x, y, z, color);
  idxs.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// ── Build full gizmo geometry ──────────────────────────────────────

function buildGizmoGeometry(mode: GizmoMode, hovered: GizmoAxis, dragging: GizmoAxis = null): {
  verts: Float32Array;
  idxs: Uint32Array;
  vertCount: number;
  idxCount: number;
} {
  const verts: number[] = [];
  const idxs: number[]  = [];

  const cx = hovered === 'x' ? COL_HOVER : COL_X;
  const cy = hovered === 'y' ? COL_HOVER : COL_Y;
  const cz = hovered === 'z' ? COL_HOVER : COL_Z;

  if (mode === 'move') {
    addArrow(verts, idxs, 'x', cx);
    addArrow(verts, idxs, 'y', cy);
    addArrow(verts, idxs, 'z', cz);
    addPlaneHandle(verts, idxs, 'xy', hovered === 'xy' ? COL_PLANE_HOVER : COL_PLANE_Z);
    addPlaneHandle(verts, idxs, 'xz', hovered === 'xz' ? COL_PLANE_HOVER : COL_PLANE_Y);
    addPlaneHandle(verts, idxs, 'yz', hovered === 'yz' ? COL_PLANE_HOVER : COL_PLANE_X);
  } else if (mode === 'scale') {
    addScaleCube(verts, idxs, 'x', cx);
    addScaleCube(verts, idxs, 'y', cy);
    addScaleCube(verts, idxs, 'z', cz);
  } else {
    // rotate — when actively dragging, show only the active arc
    const showX = dragging === null || dragging === 'x';
    const showY = dragging === null || dragging === 'y';
    const showZ = dragging === null || dragging === 'z';
    if (showX) addRotateRing(verts, idxs, 'x', cx);
    if (showY) addRotateRing(verts, idxs, 'y', cy);
    if (showZ) addRotateRing(verts, idxs, 'z', cz);
  }

  const vertCount = verts.length / 7;
  const idxCount  = idxs.length;
  const vf = new Float32Array(MAX_GIZMO_VERTS * 7);
  const vi = new Uint32Array(MAX_GIZMO_IDXS);
  vf.set(verts, 0);
  vi.set(idxs, 0);
  return { verts: vf, idxs: vi, vertCount, idxCount };
}

/**
 * Compute the 8 world-space AABB corners that tightly enclose all OBB corners
 * of the provided meshes. Returns null if no mesh has valid OBB corners.
 * Bit convention: bit0=X, bit1=Y, bit2=Z; 0=min, 1=max (matches Mesh3D.obbCorners).
 */
function computeCombinedAABBCorners(meshes: Mesh3D[]): [number, number, number][] | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  for (const mesh of meshes) {
    const c = mesh.obbCorners;
    if (!c) continue;
    for (const [x, y, z] of c) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      any = true;
    }
  }
  if (!any) return null;
  const corners: [number, number, number][] = [];
  for (let ci = 0; ci < 8; ci++) {
    corners.push([ci & 1 ? maxX : minX, ci & 2 ? maxY : minY, ci & 4 ? maxZ : minZ]);
  }
  return corners;
}

const BOX_EDGES: [number, number][] = [
  [0,1],[2,3],[4,5],[6,7],  // X-parallel
  [0,2],[1,3],[4,6],[5,7],  // Y-parallel
  [0,4],[1,5],[2,6],[3,7],  // Z-parallel
];

/**
 * Build world-space selection box geometry.
 * Single mesh: oriented bounding box (OBB) with 8 corner handles.
 * Multiple meshes: one unified world-AABB enclosing all mesh OBBs, no corner handles.
 */
function buildSelectionBoxGeometry(
  meshes: Mesh3D[],
  thickness: number,
  hoveredCorner: number | null,
): { verts: Float32Array; idxs: Uint32Array; vertCount: number; idxCount: number } {
  const verts: number[] = [];
  const idxs: number[]  = [];

  if (meshes.length > 1) {
    // Unified AABB around all meshes — one box, no corner handles
    const c = computeCombinedAABBCorners(meshes);
    if (c) {
      for (const [a, b] of BOX_EDGES) addEdgePrism(verts, idxs, c[a], c[b], thickness, COL_SEL_EDGE);
    }
  } else {
    for (const mesh of meshes) {
      const c = mesh.obbCorners;
      if (!c || c.length < 8) continue;
      for (const [a, b] of BOX_EDGES) addEdgePrism(verts, idxs, c[a], c[b], thickness, COL_SEL_EDGE);
      const sphereR = thickness * 2.2;
      for (let ci = 0; ci < 8; ci++) {
        const col = ci === hoveredCorner ? COL_SEL_CORNER_HOVER : COL_SEL_CORNER;
        addUvSphere(verts, idxs, c[ci][0], c[ci][1], c[ci][2], sphereR, col);
      }
    }
  }

  const vertCount = verts.length / 7;
  const idxCount  = idxs.length;
  const vf = new Float32Array(MAX_SEL_BOX_VERTS * 7);
  const vi = new Uint32Array(MAX_SEL_BOX_IDXS);
  if (vertCount > 0) { vf.set(verts, 0); vi.set(idxs, 0); }
  return { verts: vf, idxs: vi, vertCount, idxCount };
}

// ── Bone overlay ──────────────────────────────────────────────────

const COL_BONE:          Color4 = [0.80, 0.70, 0.50, 0.85];
const COL_BONE_EDGE:     Color4 = [0.18, 0.13, 0.06, 0.75];
// Spring bones (dynamic hair/cloth) draw LIGHT BLUE so you can tell at a glance which bones jiggle.
const COL_SPRING_BONE:      Color4 = [0.45, 0.72, 1.00, 0.85];
const COL_SPRING_BONE_EDGE: Color4 = [0.10, 0.26, 0.55, 0.75];
const COL_JOINT:         Color4 = [0.55, 0.75, 1.00, 1.00];
const COL_JOINT_HOVER:   Color4 = [1.00, 0.85, 0.10, 1.00];
const COL_JOINT_SELECTED:Color4 = [0.10, 1.00, 0.85, 1.00];
const COL_ROOT_JOINT:    Color4 = [1.00, 0.65, 0.20, 1.00];
// Tail handle sphere (leaf joints only) — light gray; turns yellow on hover
const COL_TAIL:          Color4 = [0.85, 0.85, 0.85, 0.90];

const COL_IK_IDLE:    Color4 = [1.00, 0.78, 0.10, 1.00]; // gold
const COL_IK_HOVER:   Color4 = [1.00, 1.00, 0.20, 1.00]; // bright yellow
const COL_IK_DRAG:    Color4 = [1.00, 1.00, 1.00, 1.00]; // white

const COL_POLE_IDLE:  Color4 = [0.20, 0.80, 1.00, 1.00]; // cyan
const COL_POLE_HOVER: Color4 = [0.60, 0.95, 1.00, 1.00]; // light cyan
const COL_POLE_DRAG:  Color4 = [1.00, 1.00, 1.00, 1.00]; // white
const COL_POLE_LINE:  Color4 = [0.20, 0.80, 1.00, 0.55]; // semi-transparent cyan

const MAX_BONE_VERTS      = 8192;
const MAX_BONE_IDXS       = 32768;
const MAX_BONE_EDGE_VERTS = 4096;
const MAX_IK_VERTS        = 2048;
const MAX_IK_IDXS         = 8192;

/**
 * Diamond-shaped "bone stick" from parent world position to child world position.
 * Produces 6 verts and 8 triangles (24 indices).
 */
function addBoneDiamond(
  verts: number[],
  idxs: number[],
  parent: [number, number, number],
  child:  [number, number, number],
  color:  Color4,
): void {
  const dx = child[0] - parent[0];
  const dy = child[1] - parent[1];
  const dz = child[2] - parent[2];
  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (len < 1e-6) return;

  const ax = dx / len, ay = dy / len, az = dz / len;

  // Perpendicular basis (same as addEdgePrism)
  const ref: [number, number, number] = Math.abs(ax) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ay * ref[2] - az * ref[1];
  let uy = az * ref[0] - ax * ref[2];
  let uz = ax * ref[1] - ay * ref[0];
  const ul = Math.sqrt(ux*ux + uy*uy + uz*uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;

  // Waist ring at 12% of bone length from the parent end
  const t  = len * 0.12;
  const r  = len * 0.10;
  const wx = parent[0] + ax * t;
  const wy = parent[1] + ay * t;
  const wz = parent[2] + az * t;

  const base = verts.length / 7;
  pushVert(verts, parent[0], parent[1], parent[2], color);          // v0 — parent tip
  pushVert(verts, wx + ux*r, wy + uy*r, wz + uz*r, color);         // v1
  pushVert(verts, wx + vx*r, wy + vy*r, wz + vz*r, color);         // v2
  pushVert(verts, wx - ux*r, wy - uy*r, wz - uz*r, color);         // v3
  pushVert(verts, wx - vx*r, wy - vy*r, wz - vz*r, color);         // v4
  pushVert(verts, child[0],  child[1],  child[2],  color);          // v5 — child tip

  // 4 tris from parent to waist ring
  idxs.push(base,   base+1, base+2);
  idxs.push(base,   base+2, base+3);
  idxs.push(base,   base+3, base+4);
  idxs.push(base,   base+4, base+1);
  // 4 tris from waist ring to child
  idxs.push(base+5, base+2, base+1);
  idxs.push(base+5, base+3, base+2);
  idxs.push(base+5, base+4, base+3);
  idxs.push(base+5, base+1, base+4);
}

/** Emit 12 edge line segments (parent→waist × 4, waist ring × 4, waist→child × 4) for a bone diamond. */
function addBoneDiamondEdges(
  verts: number[],
  parent: [number, number, number],
  child:  [number, number, number],
  color:  Color4,
): void {
  const dx = child[0] - parent[0];
  const dy = child[1] - parent[1];
  const dz = child[2] - parent[2];
  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (len < 1e-6) return;

  const ax = dx / len, ay = dy / len, az = dz / len;

  const ref: [number, number, number] = Math.abs(ax) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ay * ref[2] - az * ref[1];
  let uy = az * ref[0] - ax * ref[2];
  let uz = ax * ref[1] - ay * ref[0];
  const ul = Math.sqrt(ux*ux + uy*uy + uz*uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;

  const t  = len * 0.12;
  const r  = len * 0.10;
  const wx = parent[0] + ax * t;
  const wy = parent[1] + ay * t;
  const wz = parent[2] + az * t;

  const w1: [number, number, number] = [wx + ux*r, wy + uy*r, wz + uz*r];
  const w2: [number, number, number] = [wx + vx*r, wy + vy*r, wz + vz*r];
  const w3: [number, number, number] = [wx - ux*r, wy - uy*r, wz - uz*r];
  const w4: [number, number, number] = [wx - vx*r, wy - vy*r, wz - vz*r];

  pushEdge(verts, parent, w1, color); pushEdge(verts, parent, w2, color);
  pushEdge(verts, parent, w3, color); pushEdge(verts, parent, w4, color);
  pushEdge(verts, w1, w2, color);     pushEdge(verts, w2, w3, color);
  pushEdge(verts, w3, w4, color);     pushEdge(verts, w4, w1, color);
  pushEdge(verts, w1, child, color);  pushEdge(verts, w2, child, color);
  pushEdge(verts, w3, child, color);  pushEdge(verts, w4, child, color);
}

function pushEdge(
  verts: number[],
  a: [number, number, number],
  b: [number, number, number],
  col: Color4,
): void {
  verts.push(a[0], a[1], a[2], col[0], col[1], col[2], col[3]);
  verts.push(b[0], b[1], b[2], col[0], col[1], col[2], col[3]);
}

/** Compute the tail sphere world position for a joint from its tailOffset (joint local frame). */
function jointTailWorldPos(j: import('../../types/armature-3d').Joint3D): [number, number, number] {
  const wm = j.worldMatrix;
  const to = j.tailOffset ?? [0, 0.3, 0];
  return [
    wm[0]*to[0] + wm[4]*to[1] + wm[8]*to[2]  + wm[12],
    wm[1]*to[0] + wm[5]*to[1] + wm[9]*to[2]  + wm[13],
    wm[2]*to[0] + wm[6]*to[1] + wm[10]*to[2] + wm[14],
  ];
}

/**
 * Build the full bone overlay geometry for a skeleton.
 * Model space = world space (matrix = identity on draw).
 */
function buildBoneOverlayGeometry(
  skeleton: Skeleton3D,
  jointRadius: number,
  hoveredJoint:         number | null,
  selectedJoint:        number | null,
  selectedJointIsTail:  boolean,
  hoveredTailJoint:     number | null,
  cameraPos:            { readonly [n: number]: number },
  weightPaintMode:      boolean,
  programmaticHoverIdx: number | null,
  showSkeleton:         boolean,
  showSpringBones:      boolean,
  showFkBones:          boolean,
): { verts: Float32Array; idxs: Uint32Array; vertCount: number; idxCount: number; lineVerts: Float32Array; lineVertCount: number } {
  const verts: number[] = [];
  const idxs:  number[] = [];
  const lineV: number[] = [];
  const { joints } = skeleton.data;
  // Joints belonging to an enabled spring chain → their bones draw light blue (dynamic hair/cloth).
  const springJoints = new Set<number>();
  for (const c of skeleton.data.springChains ?? []) if (c.enabled) for (const ji of c.jointIndices) springJoints.add(ji);
  // Per-joint visibility toggle (declutter the armature): spring bones (hair/drape/charm dangles) vs regular FK bones.
  // The selected joint is always drawn (separately, at the end) so it can't be lost behind a hidden category.
  const visible = (idx: number) => (springJoints.has(idx) ? showSpringBones : showFkBones);

  // Weight paint mode: hide all joint sphere handles except the selected one.
  // Bone diamonds are still drawn when showSkeleton is true.
  if (weightPaintMode) {
    if (showSkeleton) {
      // Same diamond collection + back-to-front sort as normal path
      type DiamondEntry = { parent: [number,number,number]; child: [number,number,number]; spring: boolean };
      const diamonds: DiamondEntry[] = [];
      for (const j of joints) {
        if (j.parentIndex < 0) continue;
        const p = joints[j.parentIndex];
        diamonds.push({
          parent: [p.worldMatrix[12], p.worldMatrix[13], p.worldMatrix[14]],
          child:  [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]],
          spring: springJoints.has(j.index),
        });
      }
      for (const j of joints) {
        if (j.children.length > 0) continue;
        diamonds.push({
          parent: [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]],
          child:  jointTailWorldPos(j),
          spring: springJoints.has(j.index),
        });
      }
      const cx = cameraPos[0], cy = cameraPos[1], cz = cameraPos[2];
      diamonds.sort((a, b) => {
        const adx = (a.parent[0] + a.child[0]) * 0.5 - cx;
        const ady = (a.parent[1] + a.child[1]) * 0.5 - cy;
        const adz = (a.parent[2] + a.child[2]) * 0.5 - cz;
        const bdx = (b.parent[0] + b.child[0]) * 0.5 - cx;
        const bdy = (b.parent[1] + b.child[1]) * 0.5 - cy;
        const bdz = (b.parent[2] + b.child[2]) * 0.5 - cz;
        return (bdx*bdx + bdy*bdy + bdz*bdz) - (adx*adx + ady*ady + adz*adz);
      });
      for (const { parent, child, spring } of diamonds) {
        if (spring ? !showSpringBones : !showFkBones) continue;   // visibility toggle
        addBoneDiamond(verts, idxs, parent, child, spring ? COL_SPRING_BONE : COL_BONE);
        addBoneDiamondEdges(lineV, parent, child, spring ? COL_SPRING_BONE_EDGE : COL_BONE_EDGE);
      }
    }
    // Only the selected joint sphere — no other heads or tails
    if (selectedJoint !== null) {
      const sj = joints[selectedJoint];
      if (sj) {
        const r = jointRadius * 1.2;
        addUvSphere(verts, idxs, sj.worldMatrix[12], sj.worldMatrix[13], sj.worldMatrix[14], r, COL_JOINT_SELECTED, 4, 6);
      }
    }
    const vertCount     = verts.length / 7;
    const idxCount      = idxs.length;
    const lineVertCount = lineV.length / 7;
    const vf  = new Float32Array(MAX_BONE_VERTS * 7);
    const vi  = new Uint32Array(MAX_BONE_IDXS);
    const lvf = new Float32Array(MAX_BONE_EDGE_VERTS * 7);
    if (vertCount > 0)     { vf.set(verts, 0); vi.set(idxs, 0); }
    if (lineVertCount > 0) { lvf.set(lineV, 0); }
    return { verts: vf, idxs: vi, vertCount, idxCount, lineVerts: lvf, lineVertCount };
  }

  // Collect all bone diamonds (parent→child and leaf→tail) then sort back-to-front
  // so the fill depth pass writes the nearest bone's depth last, enabling correct edge occlusion.
  type DiamondEntry = { parent: [number,number,number]; child: [number,number,number]; spring: boolean };
  const diamonds: DiamondEntry[] = [];
  for (const j of joints) {
    if (j.parentIndex < 0) continue;
    const p = joints[j.parentIndex];
    diamonds.push({
      parent: [p.worldMatrix[12], p.worldMatrix[13], p.worldMatrix[14]],
      child:  [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]],
      spring: springJoints.has(j.index),
    });
  }
  for (const j of joints) {
    if (j.children.length > 0) continue;
    diamonds.push({
      parent: [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]],
      child:  jointTailWorldPos(j),
      spring: springJoints.has(j.index),
    });
  }
  const cx = cameraPos[0], cy = cameraPos[1], cz = cameraPos[2];
  diamonds.sort((a, b) => {
    const adx = (a.parent[0] + a.child[0]) * 0.5 - cx;
    const ady = (a.parent[1] + a.child[1]) * 0.5 - cy;
    const adz = (a.parent[2] + a.child[2]) * 0.5 - cz;
    const bdx = (b.parent[0] + b.child[0]) * 0.5 - cx;
    const bdy = (b.parent[1] + b.child[1]) * 0.5 - cy;
    const bdz = (b.parent[2] + b.child[2]) * 0.5 - cz;
    return (bdx*bdx + bdy*bdy + bdz*bdz) - (adx*adx + ady*ady + adz*adz); // farthest first
  });
  for (const { parent, child, spring } of diamonds) {
    if (spring ? !showSpringBones : !showFkBones) continue;   // visibility toggle
    addBoneDiamond(verts, idxs, parent, child, spring ? COL_SPRING_BONE : COL_BONE);
    addBoneDiamondEdges(lineV, parent, child, spring ? COL_SPRING_BONE_EDGE : COL_BONE_EDGE);
  }

  // Joint spheres (drawn after bones so they appear on top).
  // Selected joint is drawn last so it always wins when multiple joints share a position.
  for (const j of joints) {
    if (j.index === selectedJoint && !selectedJointIsTail) continue; // drawn separately below
    if (!visible(j.index)) continue;                                 // visibility toggle
    const jx = j.worldMatrix[12], jy = j.worldMatrix[13], jz = j.worldMatrix[14];
    const col = (j.index === hoveredJoint || j.index === programmaticHoverIdx) ? COL_JOINT_HOVER
              : j.parentIndex < 0        ? COL_ROOT_JOINT
              : COL_JOINT;
    addUvSphere(verts, idxs, jx, jy, jz, jointRadius, col, 4, 6);
  }
  // Draw selected head sphere last so it renders on top of any overlapping spheres
  if (selectedJoint !== null && !selectedJointIsTail) {
    const sj = joints[selectedJoint];
    if (sj) {
      addUvSphere(verts, idxs, sj.worldMatrix[12], sj.worldMatrix[13], sj.worldMatrix[14], jointRadius, COL_JOINT_SELECTED, 4, 6);
    }
  }

  // Tail spheres for leaf joints — selected tail drawn last to win any overlap
  const tailRadius = jointRadius * 0.75;
  for (const j of joints) {
    if (j.children.length > 0) continue;
    if (j.index === selectedJoint && selectedJointIsTail) continue; // drawn separately below
    if (!visible(j.index)) continue;                                // visibility toggle
    const [tx, ty, tz] = jointTailWorldPos(j);
    const col = j.index === hoveredTailJoint ? COL_JOINT_HOVER : COL_TAIL;
    addUvSphere(verts, idxs, tx, ty, tz, tailRadius, col, 4, 6);
  }
  // Draw selected tail sphere last so it wins any overlap
  if (selectedJoint !== null && selectedJointIsTail) {
    const sj = joints[selectedJoint];
    if (sj && sj.children.length === 0) {
      const [tx, ty, tz] = jointTailWorldPos(sj);
      addUvSphere(verts, idxs, tx, ty, tz, tailRadius, COL_JOINT_SELECTED, 4, 6);
    }
  }

  const vertCount     = verts.length / 7;
  const idxCount      = idxs.length;
  const lineVertCount = lineV.length / 7;
  const vf  = new Float32Array(MAX_BONE_VERTS * 7);
  const vi  = new Uint32Array(MAX_BONE_IDXS);
  const lvf = new Float32Array(MAX_BONE_EDGE_VERTS * 7);
  if (vertCount > 0)     { vf.set(verts, 0); vi.set(idxs, 0); }
  if (lineVertCount > 0) { lvf.set(lineV, 0); }
  return { verts: vf, idxs: vi, vertCount, idxCount, lineVerts: lvf, lineVertCount };
}

// ── Ray hit testing ────────────────────────────────────────────────

const HIT_RADIUS_AXIS  = 0.15;
const HIT_RADIUS_RING  = 0.18;
const HIT_RING_INNER   = 0.82;
const HIT_RING_OUTER   = 1.18;
const PLANE_OFF        = 0.22;
const PLANE_SIZE       = 0.28;

/** Transform a world-space ray into gizmo-local space (inverse of gizmo model matrix). */
function toGizmoLocal(
  rayOrigin: vec3,
  rayDir: vec3,
  invModel: mat4,
): { lO: vec3; lD: vec3 } {
  const lO4 = vec4.transformMat4(vec4.create(), vec4.fromValues(rayOrigin[0], rayOrigin[1], rayOrigin[2], 1), invModel);
  const lD4 = vec4.transformMat4(vec4.create(), vec4.fromValues(rayDir[0],    rayDir[1],    rayDir[2],    0), invModel);
  return {
    lO: vec3.fromValues(lO4[0] / lO4[3], lO4[1] / lO4[3], lO4[2] / lO4[3]),
    lD: vec3.normalize(vec3.create(), vec3.fromValues(lD4[0], lD4[1], lD4[2])),
  };
}

/**
 * Ray vs infinite cylinder along the given axis, from t=0 to t=1.
 * Returns the ray t parameter at the closest hit, or null.
 */
function hitAxisCylinder(
  lO: vec3,
  lD: vec3,
  axis: 'x' | 'y' | 'z',
  hitR: number,
): number | null {
  // Component indices orthogonal to the axis
  const [c0, c1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
  const axIdx    = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;

  // Reduce to 2D: the two components perpendicular to the axis
  const ox = lO[c0], oy = lO[c1];
  const dx = lD[c0], dy = lD[c1];

  const a = dx * dx + dy * dy;
  if (a < 1e-8) return null; // ray is parallel to axis

  const b = 2 * (ox * dx + oy * dy);
  const c = ox * ox + oy * oy - hitR * hitR;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  const t  = t1 > 1e-4 ? t1 : t2 > 1e-4 ? t2 : null;
  if (t === null) return null;

  // Check the axis extent is within [0, 1]
  const along = lO[axIdx] + t * lD[axIdx];
  if (along < 0 || along > 1.0) return null;

  return t;
}

/**
 * Ray vs rotate ring (3-D washer perpendicular to the given axis).
 *
 * Tests three surfaces so the ring is hittable from any camera angle:
 *   1. Ring faces  — plane at axis_coord=0, radial dist in [INNER, OUTER]
 *      (works for face-on view, e.g. Z ring when looking down Z)
 *   2. Outer wall  — cylinder at radius=OUTER, |axis_coord| <= HIT_RING_HALF_T
 *      (works for edge-on view, e.g. X/Y rings in illustration mode)
 *
 * Returns the nearest ray t parameter, or null.
 */
const HIT_RING_HALF_T = 0.10; // generous picking half-thickness (visual is 0.04)

function hitRotateRing(
  lO: vec3,
  lD: vec3,
  axis: 'x' | 'y' | 'z',
): number | null {
  const axIdx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const [c0, c1] = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];

  let bestT: number | null = null;
  const tryT = (t: number) => {
    if (t > 1e-4 && (bestT === null || t < bestT)) bestT = t;
  };

  // Test 1: ring faces (face-on view) — plane intersection at axis_coord=0
  const axD = lD[axIdx];
  if (Math.abs(axD) >= 1e-6) {
    const t = -lO[axIdx] / axD;
    if (t > 1e-4) {
      const px = lO[c0] + t * lD[c0];
      const py = lO[c1] + t * lD[c1];
      const dist = Math.sqrt(px * px + py * py);
      if (dist >= HIT_RING_INNER && dist <= HIT_RING_OUTER) tryT(t);
    }
  }

  // Test 2: outer cylinder wall (edge-on view)
  {
    const ox = lO[c0], oy = lO[c1];
    const dx = lD[c0], dy = lD[c1];
    const a = dx * dx + dy * dy;
    if (a >= 1e-8) {
      const b = 2 * (ox * dx + oy * dy);
      const c = ox * ox + oy * oy - HIT_RING_OUTER * HIT_RING_OUTER;
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
          if (t > 1e-4) {
            const ax = lO[axIdx] + t * lD[axIdx];
            if (Math.abs(ax) <= HIT_RING_HALF_T) tryT(t);
          }
        }
      }
    }
  }

  return bestT;
}

/**
 * Ray vs a plane-handle quad lying in the 'ab' plane, offset from origin.
 */
function hitPlane(
  lO: vec3,
  lD: vec3,
  plane: 'xy' | 'xz' | 'yz',
): number | null {
  // The plane handle lies at depth=0 of the third axis
  const normIdx = plane === 'xy' ? 2 : plane === 'xz' ? 1 : 0;
  const axD = lD[normIdx];
  if (Math.abs(axD) < 1e-7) return null;

  const t = -lO[normIdx] / axD;
  if (t < 1e-4) return null;

  const [c0, c1] = plane === 'xy' ? [0, 1] : plane === 'xz' ? [0, 2] : [1, 2];
  const px = lO[c0] + t * lD[c0];
  const py = lO[c1] + t * lD[c1];

  const inRange = (v: number) => v >= PLANE_OFF && v <= PLANE_OFF + PLANE_SIZE;
  if (inRange(px) && inRange(py)) return t;
  return null;
}

// ── GizmoRenderer class ────────────────────────────────────────────

export class GizmoRenderer {
  private device: GPUDevice;
  private swapChainFormat: GPUTextureFormat;

  // Pipeline (shared by both gizmo and selection box — same vertex format)
  private pipeline!: GPURenderPipeline;
  private bgl!: GPUBindGroupLayout;

  // Gizmo GPU buffers (pre-allocated, overwritten each frame)
  private vertexBuffer!: GPUBuffer;
  private indexBuffer!: GPUBuffer;
  private uniformBuffer!: GPUBuffer;

  // Selection box GPU buffers (world-space geometry, model = identity)
  private _selBoxVertBuf!: GPUBuffer;
  private _selBoxIdxBuf!:  GPUBuffer;
  private _selBoxUniBuf!:  GPUBuffer;

  // Bone overlay GPU buffers (world-space geometry, model = identity)
  private _boneVertBuf!:     GPUBuffer;
  private _boneIdxBuf!:      GPUBuffer;
  private _boneUniBuf!:      GPUBuffer;
  private _boneFillPipe!:    GPURenderPipeline; // triangle-list, depth write enabled (for edge occlusion)
  private _boneLinePipe!:    GPURenderPipeline;
  private _boneEdgeVertBuf!: GPUBuffer;

  // Ground grid GPU buffers (world-space line geometry, model = identity, own uniform to avoid aliasing)
  private _gridVertBuf!: GPUBuffer;
  private _gridUniBuf!:  GPUBuffer;
  private _artboardVertBuf!: GPUBuffer;
  private _frustumVertBuf!: GPUBuffer;

  // Textured artboard quad (illustration × free3D): shows the 2D illustration on the artboard plane. Its own
  // pipeline (pos+uv, texture+sampler, PREMULTIPLIED alpha, depth-write so 3D objects occlude it correctly).
  private _artboardTexPipe?: GPURenderPipeline;
  private _artboardTexBgl?: GPUBindGroupLayout;
  private _artboardTexSampler?: GPUSampler;
  private _artboardTexUniBuf?: GPUBuffer;   // vp(64) + model(64) + params(16: opacity)
  private _artboardTexVertBuf?: GPUBuffer;  // 6 verts × (pos3 + uv2) f32

  // Vertex-snap viz GPU buffers (billboard triangles, drawn depth-always so they're on top)
  private _snapVizBuf!:   GPUBuffer;
  private _snapVizUniBuf!: GPUBuffer;

  // Array gizmo GPU buffers (world-space geometry, model = identity)
  private _arrayVertBuf!: GPUBuffer;
  private _arrayIdxBuf!:  GPUBuffer;
  private _arrayUniBuf!:  GPUBuffer;

  // Face handle GPU buffers (Array Tool hover mode)
  private _faceHandleVertBuf!: GPUBuffer;
  private _faceHandleIdxBuf!:  GPUBuffer;
  private _faceHandleUniBuf!:  GPUBuffer;

  // IK target handle GPU buffers (world-space geometry, model = identity)
  private _ikVertBuf!:  GPUBuffer;
  private _ikIdxBuf!:   GPUBuffer;
  private _ikUniBuf!:   GPUBuffer;

  /** Gizmo orientation: 'world' keeps handles world-aligned; 'local' rotates handles with the mesh. */
  orientationMode: 'world' | 'local' = 'world';

  // PERF (audit 5.12): uniform-only bind groups cached per uniform buffer. All
  // gizmo uniform buffers are created exactly once in createBuffers() and never
  // recreated, so each bind group can live for the renderer's lifetime instead
  // of being rebuilt for every overlay sub-draw every frame (10 sites). If a
  // buffer were ever recreated, the identity key would miss and a fresh bind
  // group would be built for the new buffer object.
  private readonly _uniBGCache = new Map<GPUBuffer, GPUBindGroup>();
  private uniformBindGroup(buf: GPUBuffer): GPUBindGroup {
    let bg = this._uniBGCache.get(buf);
    if (!bg) {
      bg = this.device.createBindGroup({
        layout: this.bgl,
        entries: [{ binding: 0, resource: { buffer: buf } }],
      });
      this._uniBGCache.set(buf, bg);
    }
    return bg;
  }

  constructor(device: GPUDevice, swapChainFormat: GPUTextureFormat = 'bgra8unorm') {
    this.device = device;
    this.swapChainFormat = swapChainFormat;
    this.createPipeline();
    this.createBuffers();
  }

  // ── Pipeline creation ──────────────────────────────────────────

  private createPipeline(): void {
    const vertMod = this.device.createShaderModule({ code: GIZMO_VERTEX_SHADER });
    const fragMod = this.device.createShaderModule({ code: GIZMO_FRAGMENT_SHADER });

    this.bgl = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });

    const vertState: GPUVertexState = {
      module: vertMod,
      entryPoint: 'vs_main',
      buffers: [{
        arrayStride: GIZMO_VERTEX_STRIDE,
        attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // position
          { shaderLocation: 1, offset: 12, format: 'float32x4' }, // color
        ],
      }],
    };
    const fragState: GPUFragmentState = {
      module: fragMod,
      entryPoint: 'fs_main',
      targets: [{
        format: this.swapChainFormat,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    };
    const depthAlways: GPUDepthStencilState = {
      format: 'depth24plus-stencil8',
      depthWriteEnabled: false,
      depthCompare: 'always',
    };

    this.pipeline = this.device.createRenderPipeline({
      layout,
      vertex: vertState,
      fragment: fragState,
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthAlways,
    });

    // Bone fill pipeline: writes depth so edges can depth-test against bone surfaces.
    // Sorted back-to-front draw order ensures the nearest bone's depth wins the buffer.
    this._boneFillPipe = this.device.createRenderPipeline({
      layout,
      vertex: vertState,
      fragment: fragState,
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'always' },
    });

    // Bone edge pipeline: depth-tests against the fill depths written above, so edges
    // are hidden wherever a nearer bone's fill covers them.
    this._boneLinePipe = this.device.createRenderPipeline({
      layout,
      vertex: vertState,
      fragment: fragState,
      primitive: { topology: 'line-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less-equal' },
    });
  }

  private createBuffers(): void {
    this.vertexBuffer = this.device.createBuffer({
      size: MAX_GIZMO_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.indexBuffer = this.device.createBuffer({
      size: MAX_GIZMO_IDXS * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.uniformBuffer = this.device.createBuffer({
      size: GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._selBoxVertBuf = this.device.createBuffer({
      size: MAX_SEL_BOX_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._selBoxIdxBuf = this.device.createBuffer({
      size: MAX_SEL_BOX_IDXS * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this._selBoxUniBuf = this.device.createBuffer({
      size: GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._boneVertBuf = this.device.createBuffer({
      size: MAX_BONE_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._boneIdxBuf = this.device.createBuffer({
      size: MAX_BONE_IDXS * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this._boneUniBuf = this.device.createBuffer({
      size: GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._boneEdgeVertBuf = this.device.createBuffer({
      size: MAX_BONE_EDGE_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._gridVertBuf = this.device.createBuffer({
      size: MAX_GRID_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._gridUniBuf = this.device.createBuffer({
      size: GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Artboard "render frame" (illustration × free3D) — its own small vertex buffer so it never collides with the
    // grid's in a frame where both draw (reusing _gridVertBuf would let the last writeBuffer clobber both draws).
    this._artboardVertBuf = this.device.createBuffer({
      size: 64 * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    // Camera-node frustum wireframe (cinematic cameras) — 12 edges × 2 verts; its own buffer, same reasoning.
    this._frustumVertBuf = this.device.createBuffer({
      size: 64 * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._snapVizBuf = this.device.createBuffer({
      size: MAX_SNAP_VIZ_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._snapVizUniBuf = this.device.createBuffer({
      size: GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._arrayVertBuf = this.device.createBuffer({
      size: MAX_ARRAY_GIZMO_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._arrayIdxBuf = this.device.createBuffer({
      size: MAX_ARRAY_GIZMO_IDXS * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this._arrayUniBuf = this.device.createBuffer({
      size: GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._faceHandleVertBuf = this.device.createBuffer({
      size: MAX_FACE_HANDLE_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._faceHandleIdxBuf = this.device.createBuffer({
      size: MAX_FACE_HANDLE_IDXS * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this._faceHandleUniBuf = this.device.createBuffer({
      size: GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._ikVertBuf = this.device.createBuffer({
      size: MAX_IK_VERTS * GIZMO_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._ikIdxBuf = this.device.createBuffer({
      size: MAX_IK_IDXS * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this._ikUniBuf = this.device.createBuffer({
      size: GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ── Gizmo scale computation ────────────────────────────────────

  /**
   * Compute gizmo world-space scale so it appears constant in screen size.
   * fraction = fraction of screen half-height the gizmo should occupy.
   */
  static computeGizmoScale(camera: Camera3D, gizmoCenter: vec3, fraction = 0.18): number {
    const dist = vec3.distance(camera.position, gizmoCenter);
    if (camera.mode === 'perspective') {
      return dist * Math.tan(camera.fov * 0.5) * fraction;
    }
    return camera.orthoSize * fraction;
  }

  // ── Draw ───────────────────────────────────────────────────────

  /**
   * Draw an AABB bounding box wireframe + corner sphere handles for each
   * selected mesh. Call before drawGizmo so the gizmo draws on top.
   */
  /**
   * Ray-test the 8 OBB corner spheres of the selected meshes.
   * Returns the corner index (0–7, bit-encoded: bit0=X, bit1=Y, bit2=Z) of the nearest hit,
   * or null if no corner is under the cursor.
   */
  hitTestCorner(
    rayOrigin: vec3,
    rayDir: vec3,
    selectedMeshes: Mesh3D[],
    camera: Camera3D,
  ): number | null {
    // Corner handles are only shown/active for a single-mesh selection.
    if (selectedMeshes.length !== 1) return null;

    const center  = this.computeCenter(selectedMeshes);
    const scale   = GizmoRenderer.computeGizmoScale(camera, center);
    // Hit radius = 2× the visual sphere radius for comfortable picking
    const hitR    = scale * 0.018 * 2.2 * 2.0;
    const hitR2   = hitR * hitR;

    let bestT   = Infinity;
    let bestIdx: number | null = null;

    for (const mesh of selectedMeshes) {
      const corners = mesh.obbCorners;
      if (!corners) continue;
      for (let i = 0; i < 8; i++) {
        const [cx, cy, cz] = corners[i];
        const dx = cx - rayOrigin[0];
        const dy = cy - rayOrigin[1];
        const dz = cz - rayOrigin[2];
        const tca = dx * rayDir[0] + dy * rayDir[1] + dz * rayDir[2];
        if (tca < 0) continue;
        const d2 = dx*dx + dy*dy + dz*dz - tca*tca;
        if (d2 > hitR2) continue;
        const t = tca - Math.sqrt(hitR2 - d2);
        if (t > 0 && t < bestT) { bestT = t; bestIdx = i; }
      }
    }
    return bestIdx;
  }

  drawSelectionBox(
    pass: GPURenderPassEncoder,
    selectedMeshes: Mesh3D[],
    camera: Camera3D,
    hoveredCorner: number | null = null,
  ): void {
    if (selectedMeshes.length === 0) return;

    const center = this.computeCenter(selectedMeshes);
    const scale  = GizmoRenderer.computeGizmoScale(camera, center);
    const thickness = scale * 0.018;

    const { verts, idxs, vertCount, idxCount } = buildSelectionBoxGeometry(selectedMeshes, thickness, hoveredCorner);
    if (idxCount === 0) return;

    this.device.queue.writeBuffer(this._selBoxVertBuf, 0, verts, 0, vertCount * 7);
    this.device.queue.writeBuffer(this._selBoxIdxBuf,  0, idxs,  0, idxCount);

    // model = identity (geometry is already in world space)
    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16);  // identity model
    this.device.queue.writeBuffer(this._selBoxUniBuf, 0, uData);

    const bg = this.uniformBindGroup(this._selBoxUniBuf);   // cached (audit 5.12)

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._selBoxVertBuf);
    pass.setIndexBuffer(this._selBoxIdxBuf, 'uint32');
    pass.drawIndexed(idxCount);
  }

  /**
   * Draw a reference grid through the origin: minor lines every `spacing` world units, with
   * brighter axis lines (X=red, Y=green, Z=blue). Uses the bone-edge line pipeline (line-list,
   * depth-tested less-equal, no depth write) so scene geometry occludes it. Alpha from `opacity`.
   *
   * Plane: PERSPECTIVE always uses the XZ ground. ORTHOGRAPHIC orients the grid to the world plane
   * that faces the camera (top→XZ, front→XY, side→ZY), so an axis-aligned ortho view gets flat
   * graph paper instead of an edge-on line. Tie `spacing` to the transform snap size.
   */
  drawGrid(
    pass: GPURenderPassEncoder,
    camera: Camera3D,
    spacing: number,
    color: [number, number, number],
    opacity: number,
  ): void {
    if (opacity <= 0 || spacing <= 0) return;

    const HALF_EXTENT = 10;                                  // grid spans UP TO ±10 world units
    const step = Math.max(spacing, 1e-4);                    // guard against zero/negative spacing
    // Cap the LINE COUNT, not the spacing — so fine grids (< 0.1) still render: the extent shrinks
    // instead of the cells. ≤200 lines/side stays well inside the vertex buffer.
    const n = Math.max(1, Math.min(Math.floor(HALF_EXTENT / step), 200));
    const ext = n * step;                                    // square out to the last full line
    const [r, g, b] = color;
    const axisA = Math.min(1, opacity * 1.6);                // axis lines a touch more solid

    const COL_X: [number, number, number] = [0.95, 0.35, 0.35];
    const COL_Y: [number, number, number] = [0.45, 0.90, 0.45];
    const COL_Z: [number, number, number] = [0.35, 0.50, 0.95];

    // Pick the grid plane (two in-plane axes + their axis-line colors).
    let aAxis: [number, number, number] = [1, 0, 0], bAxis: [number, number, number] = [0, 0, 1]; // XZ ground
    let aCol = COL_X, bCol = COL_Z;
    if (camera.mode === 'orthographic') {
      const dx = camera.target[0] - camera.position[0];
      const dy = camera.target[1] - camera.position[1];
      const dz = camera.target[2] - camera.position[2];
      const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
      if (ay >= ax && ay >= az) {            /* top/bottom → XZ ground (default) */ }
      else if (az >= ax && az >= ay) { aAxis = [1, 0, 0]; bAxis = [0, 1, 0]; aCol = COL_X; bCol = COL_Y; } // front → XY
      else                          { aAxis = [0, 0, 1]; bAxis = [0, 1, 0]; aCol = COL_Z; bCol = COL_Y; } // side → ZY
    }

    const lv: number[] = [];
    const P = (ca: number, cb: number): [number, number, number] =>
      [aAxis[0]*ca + bAxis[0]*cb, aAxis[1]*ca + bAxis[1]*cb, aAxis[2]*ca + bAxis[2]*cb];
    const pushLine = (a0: number, b0: number, a1: number, b1: number,
                      cr: number, cg: number, cbl: number, ca: number): void => {
      const p0 = P(a0, b0), p1 = P(a1, b1);
      lv.push(p0[0], p0[1], p0[2], cr, cg, cbl, ca, p1[0], p1[1], p1[2], cr, cg, cbl, ca);
    };
    for (let i = -n; i <= n; i++) {
      if (i === 0) continue;                                 // axes drawn separately below
      const t = i * step;
      pushLine(t, -ext, t, ext, r, g, b, opacity);           // line parallel to bAxis
      pushLine(-ext, t, ext, t, r, g, b, opacity);           // line parallel to aAxis
    }
    pushLine(-ext, 0, ext, 0, aCol[0], aCol[1], aCol[2], axisA);  // aAxis line
    pushLine(0, -ext, 0, ext, bCol[0], bCol[1], bCol[2], axisA);  // bAxis line

    const vertCount = lv.length / 7;
    if (vertCount === 0 || vertCount > MAX_GRID_VERTS) return;
    this.device.queue.writeBuffer(this._gridVertBuf, 0, new Float32Array(lv), 0, vertCount * 7);

    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16);            // identity model (world space)
    this.device.queue.writeBuffer(this._gridUniBuf, 0, uData);

    const bg = this.uniformBindGroup(this._gridUniBuf);   // cached (audit 5.12)

    pass.setPipeline(this._boneLinePipe);                    // line-list, depth less-equal, no depth write
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._gridVertBuf);
    pass.draw(vertCount);
  }

  /**
   * Draw the ILLUSTRATION artboard as a rectangle outline (the "render frame") in the XY plane at z=0 — a
   * camera safe-frame that shows WHERE the fixed X×Y output is captured while you free-navigate in 3D
   * (illustration × free3D). Same line pipe as the grid; its own vertex buffer (see createBuffers). The uniform
   * (VP + identity model) is identical to the grid's, so sharing _gridUniBuf is safe.
   */
  drawArtboardFrame(pass: GPURenderPassEncoder, camera: Camera3D, halfW: number, halfH: number, color: [number, number, number], opacity: number): void {
    if (opacity <= 0 || halfW <= 0 || halfH <= 0) return;
    const [r, g, b] = color, a = opacity;
    const lv: number[] = [];
    const push = (x0: number, y0: number, x1: number, y1: number): void => {
      lv.push(x0, y0, 0, r, g, b, a, x1, y1, 0, r, g, b, a);
    };
    push(-halfW, -halfH,  halfW, -halfH);   // bottom
    push( halfW, -halfH,  halfW,  halfH);   // right
    push( halfW,  halfH, -halfW,  halfH);   // top
    push(-halfW,  halfH, -halfW, -halfH);   // left
    const vertCount = lv.length / 7;        // 8
    this.device.queue.writeBuffer(this._artboardVertBuf, 0, new Float32Array(lv), 0, vertCount * 7);

    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16);            // identity model (world space)
    this.device.queue.writeBuffer(this._gridUniBuf, 0, uData);
    const bg = this.uniformBindGroup(this._gridUniBuf);

    pass.setPipeline(this._boneLinePipe);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._artboardVertBuf);
    pass.draw(vertCount);
  }

  /** Lazily build the textured-artboard-quad pipeline (pos+uv, texture, premultiplied alpha, depth-write). */
  private _ensureArtboardTexPipe(): void {
    if (this._artboardTexPipe) return;
    const shader = this.device.createShaderModule({ code: `
struct U { vp: mat4x4<f32>, model: mat4x4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOut {
  var o: VOut;
  o.pos = u.vp * u.model * vec4<f32>(p, 1.0);
  o.uv = uv;
  return o;
}
@fragment fn fs_main(i: VOut) -> @location(0) vec4<f32> {
  let c = textureSample(tex, samp, i.uv);
  return vec4<f32>(c.rgb, c.a * u.params.x);   // straight alpha (opacity scales alpha only)
}
` });
    this._artboardTexBgl = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, // vp/model (VS) + opacity (FS)
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this._artboardTexPipe = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._artboardTexBgl] }),
      vertex: {
        module: shader, entryPoint: 'vs_main',
        buffers: [{ arrayStride: 5 * 4, attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
        ] }],
      },
      fragment: {
        module: shader, entryPoint: 'fs_main',
        targets: [{
          format: this.swapChainFormat,
          // STRAIGHT-alpha "over" — the captured texture is un-premultiplied (straight).
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // Depth-write so 3D objects correctly occlude / are occluded by the art plane at z=0.
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this._artboardTexSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this._artboardTexUniBuf = this.device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._artboardTexVertBuf = this.device.createBuffer({ size: 6 * 5 * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  /** Draw the 2D illustration on the artboard plane (z=0) at [±halfW, ±halfH]. `textureView` = the captured 2D
   *  content (premultiplied alpha). UVs flip Y so the texture (row 0 = top) maps upright in world space (+Y up). */
  drawArtboardTexture(pass: GPURenderPassEncoder, camera: Camera3D, halfW: number, halfH: number, textureView: GPUTextureView, opacity: number): void {
    if (opacity <= 0 || halfW <= 0 || halfH <= 0) return;
    this._ensureArtboardTexPipe();
    const v = new Float32Array([
      -halfW,  halfH, 0, 0, 0,
       halfW,  halfH, 0, 1, 0,
       halfW, -halfH, 0, 1, 1,
      -halfW,  halfH, 0, 0, 0,
       halfW, -halfH, 0, 1, 1,
      -halfW, -halfH, 0, 0, 1,
    ]);
    this.device.queue.writeBuffer(this._artboardTexVertBuf!, 0, v);
    const vp = camera.getViewProjectionMatrix();
    const u = new Float32Array(36);
    u.set(vp as Float32Array, 0);
    u.set(mat4.create() as Float32Array, 16);   // identity model (world space)
    u[32] = opacity;
    this.device.queue.writeBuffer(this._artboardTexUniBuf!, 0, u);
    const bg = this.device.createBindGroup({
      layout: this._artboardTexBgl!,
      entries: [
        { binding: 0, resource: { buffer: this._artboardTexUniBuf! } },
        { binding: 1, resource: textureView },
        { binding: 2, resource: this._artboardTexSampler! },
      ],
    });
    pass.setPipeline(this._artboardTexPipe!);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._artboardTexVertBuf!);
    pass.draw(6);
  }

  /**
   * Draw a camera-node FRUSTUM as a wireframe (cinematic cameras) — the 12 edges connecting the near & far
   * rectangles of what that camera sees, so you can aim it while editing. `segments` are pre-computed world-space
   * line pairs (camera-math.frustumLineSegments). Same line pipe / shared uniform as the grid & artboard frame.
   */
  drawCameraFrustum(pass: GPURenderPassEncoder, camera: Camera3D, segments: [number[], number[]][], color: [number, number, number], opacity: number): void {
    if (opacity <= 0 || segments.length === 0) return;
    const [r, g, b] = color, a = opacity;
    const lv: number[] = [];
    for (const [p0, p1] of segments) lv.push(p0[0], p0[1], p0[2], r, g, b, a, p1[0], p1[1], p1[2], r, g, b, a);
    const vertCount = lv.length / 7;
    this.device.queue.writeBuffer(this._frustumVertBuf, 0, new Float32Array(lv), 0, vertCount * 7);

    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16);            // identity model (segments are already world-space)
    this.device.queue.writeBuffer(this._gridUniBuf, 0, uData);
    const bg = this.uniformBindGroup(this._gridUniBuf);

    pass.setPipeline(this._boneLinePipe);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._frustumVertBuf);
    pass.draw(vertCount);
  }

  /**
   * Draw the vertex-snap "double-circle" viz ON TOP of everything (depth-always): two camera-facing
   * billboard rings at the dragged origin (innerPx/outerPx) + a billboard square at each candidate
   * vertex (active = bigger/orange, the rest faded by depthT). `canvasH` maps screen-px → world via
   * computeGizmoScale(fraction = 2·px/h). Built as triangles so it reuses the depth-always pipeline.
   */
  drawSnapViz(pass: GPURenderPassEncoder, camera: Camera3D, viz: SnapViz3D, canvasH: number): void {
    if (canvasH <= 0) return;
    const center = vec3.fromValues(viz.centerWorld[0], viz.centerWorld[1], viz.centerWorld[2]);

    // Camera-facing billboard basis (right, up).
    const fwd = vec3.create();
    vec3.subtract(fwd, camera.target, camera.position);
    vec3.normalize(fwd, fwd);
    let up0 = vec3.fromValues(0, 1, 0);
    if (Math.abs(vec3.dot(fwd, up0)) > 0.99) up0 = vec3.fromValues(0, 0, 1);  // looking straight up/down
    const rt = vec3.create(); vec3.cross(rt, fwd, up0); vec3.normalize(rt, rt);
    const upv = vec3.create(); vec3.cross(upv, rt, fwd); vec3.normalize(upv, upv);
    const rx = rt[0], ry = rt[1], rz = rt[2], ux = upv[0], uy = upv[1], uz = upv[2];

    const v: number[] = [];
    const pushV = (cx: number, cy: number, cz: number, sr: number, su: number, col: number[]): void => {
      v.push(cx + rx*sr + ux*su, cy + ry*sr + uy*su, cz + rz*sr + uz*su, col[0], col[1], col[2], col[3]);
    };

    // Rings (thin annuli) at the dragged origin, sized in screen pixels.
    const ringCol = [1.0, 0.62, 0.18, 0.55];
    const thick = GizmoRenderer.computeGizmoScale(camera, center, (2 * 1.4) / canvasH);  // ~1.4px wide
    const cx = center[0], cy = center[1], cz = center[2];
    const N = 48;
    for (const Rpx of [viz.outerPx, viz.innerPx]) {
      const R = GizmoRenderer.computeGizmoScale(camera, center, (2 * Rpx) / canvasH);
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        pushV(cx,cy,cz, c0*(R-thick), s0*(R-thick), ringCol);
        pushV(cx,cy,cz, c0*(R+thick), s0*(R+thick), ringCol);
        pushV(cx,cy,cz, c1*(R+thick), s1*(R+thick), ringCol);
        pushV(cx,cy,cz, c0*(R-thick), s0*(R-thick), ringCol);
        pushV(cx,cy,cz, c1*(R+thick), s1*(R+thick), ringCol);
        pushV(cx,cy,cz, c1*(R-thick), s1*(R-thick), ringCol);
      }
    }

    // Candidate squares — constant pixel size at each vertex's own depth.
    for (const cand of viz.candidates) {
      const w = vec3.fromValues(cand.world[0], cand.world[1], cand.world[2]);
      const halfPx = cand.active ? 5 : 3;
      const hf = GizmoRenderer.computeGizmoScale(camera, w, (2 * halfPx) / canvasH);
      const col = cand.active ? [1.0, 0.5, 0.0, 1.0] : [1.0, 0.66, 0.2, 0.7 * (1 - cand.depthT)];
      const qx = cand.world[0], qy = cand.world[1], qz = cand.world[2];
      pushV(qx,qy,qz, -hf,-hf, col); pushV(qx,qy,qz, hf,-hf, col); pushV(qx,qy,qz, hf,hf, col);
      pushV(qx,qy,qz, -hf,-hf, col); pushV(qx,qy,qz, hf,hf, col); pushV(qx,qy,qz, -hf,hf, col);
    }

    const vertCount = v.length / 7;
    if (vertCount === 0 || vertCount > MAX_SNAP_VIZ_VERTS) return;
    this.device.queue.writeBuffer(this._snapVizBuf, 0, new Float32Array(v), 0, vertCount * 7);

    const uData = new Float32Array(32);
    uData.set(camera.getViewProjectionMatrix() as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16);  // identity model (geometry already in world space)
    this.device.queue.writeBuffer(this._snapVizUniBuf, 0, uData);

    const bg = this.uniformBindGroup(this._snapVizUniBuf);   // cached (audit 5.12)
    pass.setPipeline(this.pipeline);  // triangle-list, depth-always → draws on top of everything
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._snapVizBuf);
    pass.draw(vertCount);
  }

  /**
   * Draw the gizmo for the given selected meshes.
   * Call this inside an active GPURenderPassEncoder after all mesh draw calls.
   * dragging: the axis currently being dragged (hides other arcs in rotate mode).
   */
  drawGizmo(
    pass: GPURenderPassEncoder,
    selectedMeshes: Mesh3D[],
    camera: Camera3D,
    mode: GizmoMode,
    hovered: GizmoAxis,
    _canvasWidth: number,
    _canvasHeight: number,
    dragging: GizmoAxis = null,
  ): void {
    if (selectedMeshes.length === 0 || mode === null) return;

    const center = this.computeCenter(selectedMeshes);
    const scale  = GizmoRenderer.computeGizmoScale(camera, center);

    // Build model matrix: translate to center, [rotate if local mode], uniform scale
    const model = mat4.create();
    mat4.translate(model, model, center);
    if (this.orientationMode === 'local' && selectedMeshes.length > 0) {
      mat4.multiply(model, model, this.extractRotationMatrix(selectedMeshes[0]));
    }
    mat4.scale(model, model, [scale, scale, scale]);

    // Upload uniforms
    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(model as Float32Array, 16);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uData);

    // Build and upload gizmo geometry
    const { verts, idxs, vertCount, idxCount } = buildGizmoGeometry(mode, hovered, dragging);
    if (idxCount === 0) return;

    this.device.queue.writeBuffer(this.vertexBuffer, 0, verts, 0, vertCount * 7);
    this.device.queue.writeBuffer(this.indexBuffer, 0, idxs, 0, idxCount);

    const bg = this.uniformBindGroup(this.uniformBuffer);   // cached (audit 5.12)

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(idxCount);
  }

  /**
   * Draw the array gizmo: linear (one arm), grid (two arms), or radial (circle arc + shaft).
   * Drawn in world space (model = identity).
   */
  drawArrayGizmo(
    pass: GPURenderPassEncoder,
    data: ArrayGizmoData,
    camera: Camera3D,
    hoveredHandle: ArrayHandleHit,
  ): void {
    const scale      = GizmoRenderer.computeGizmoScale(camera, vec3.fromValues(...data.handlePos));
    const shaftThick = scale * 0.025;
    const sphereR    = scale * 0.10;

    const xLineCol:   Color4 = [0.55, 0.85, 1.0, 0.6];
    const xHandleCol: Color4 = hoveredHandle === 'x' ? [1, 0.9, 0.1, 1] : [0.55, 0.85, 1.0, 1];
    const yLineCol:   Color4 = [0.4, 1.0, 0.5, 0.6];
    const yHandleCol: Color4 = hoveredHandle === 'y' ? [1, 0.9, 0.1, 1] : [0.4, 1.0, 0.5, 1];
    const rLineCol:   Color4 = [0.55, 0.85, 1.0, 0.5];
    const rHandleCol: Color4 = hoveredHandle === 'radius' ? [1, 0.9, 0.1, 1] : [0.55, 0.85, 1.0, 1];

    const verts: number[] = [];
    const idxs:  number[] = [];

    if (data.mode === 'radial' && data.radialCenter && data.currentRadius !== undefined && data.arcDeg !== undefined) {
      const { radialCenter, currentRadius, arcDeg, radialAxis, radialTangent, radialBitangent } = data;
      const ARC_SEGS = 64;
      const stepDeg  = arcDeg / ARC_SEGS;

      const radialPt = (angleDeg: number): [number, number, number] => {
        const rad = angleDeg * Math.PI / 180;
        const s = Math.sin(rad), c = Math.cos(rad);
        if (radialTangent && radialBitangent) {
          // Local orientation: ring spans source's local axes.
          const [pa, pb] = radialAxis === 'z' ? [c, s] : [s, c];
          return [
            radialCenter[0] + currentRadius * (pa * radialTangent[0] + pb * radialBitangent[0]),
            radialCenter[1] + currentRadius * (pa * radialTangent[1] + pb * radialBitangent[1]),
            radialCenter[2] + currentRadius * (pa * radialTangent[2] + pb * radialBitangent[2]),
          ];
        }
        // World orientation fallback
        if (radialAxis === 'y') return [radialCenter[0] + currentRadius * s, radialCenter[1], radialCenter[2] + currentRadius * c];
        if (radialAxis === 'x') return [radialCenter[0], radialCenter[1] + currentRadius * s, radialCenter[2] + currentRadius * c];
        return [radialCenter[0] + currentRadius * c, radialCenter[1] + currentRadius * s, radialCenter[2]];
      };

      for (let i = 0; i < ARC_SEGS; i++) {
        const p0 = radialPt(i * stepDeg);
        const p1 = radialPt((i + 1) * stepDeg);
        addEdgePrism(verts, idxs, p0, p1, shaftThick * 0.7, rLineCol);
      }

      // Shaft from center to angle-0 handle
      addEdgePrism(verts, idxs, radialCenter, data.handlePos, shaftThick, rLineCol);
      addUvSphere(verts, idxs, data.handlePos[0], data.handlePos[1], data.handlePos[2], sphereR, rHandleCol, 5, 8);
    } else {
      // X arm (linear + grid)
      addEdgePrism(verts, idxs, data.sourcePos, data.handlePos, shaftThick, xLineCol);
      addUvSphere(verts, idxs, data.handlePos[0], data.handlePos[1], data.handlePos[2], sphereR, xHandleCol, 5, 8);

      // Y arm (grid only)
      if (data.mode === 'grid' && data.handlePosY) {
        addEdgePrism(verts, idxs, data.sourcePos, data.handlePosY, shaftThick, yLineCol);
        addUvSphere(verts, idxs, data.handlePosY[0], data.handlePosY[1], data.handlePosY[2], sphereR, yHandleCol, 5, 8);
      }
    }

    const vertCount = verts.length / 7;
    const idxCount  = idxs.length;
    if (idxCount === 0) return;

    const vf = new Float32Array(vertCount * 7);
    const vi = new Uint32Array(idxCount);
    vf.set(verts, 0);
    vi.set(idxs, 0);

    this.device.queue.writeBuffer(this._arrayVertBuf, 0, vf, 0, vertCount * 7);
    this.device.queue.writeBuffer(this._arrayIdxBuf,  0, vi, 0, idxCount);

    const vp    = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16);  // identity model (world-space geometry)
    this.device.queue.writeBuffer(this._arrayUniBuf, 0, uData);

    const bg = this.uniformBindGroup(this._arrayUniBuf);   // cached (audit 5.12)

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._arrayVertBuf);
    pass.setIndexBuffer(this._arrayIdxBuf, 'uint32');
    pass.drawIndexed(idxCount);
  }

  /**
   * Ray-sphere test against all array drag handles.
   * Returns which handle was hit ('x', 'y', 'radius') or null.
   * For linear: only 'x'. For grid: 'x' or 'y'. For radial: 'radius'.
   */
  hitTestArrayHandle(
    rayOrigin: vec3,
    rayDir: vec3,
    data: ArrayGizmoData,
    camera: Camera3D,
  ): ArrayHandleHit {
    const testSphere = (pos: [number, number, number]): boolean => {
      const scale = GizmoRenderer.computeGizmoScale(camera, vec3.fromValues(...pos));
      const hitR2 = (scale * 0.10 * 2.2) ** 2;
      const dx = pos[0] - rayOrigin[0];
      const dy = pos[1] - rayOrigin[1];
      const dz = pos[2] - rayOrigin[2];
      const tca = dx * rayDir[0] + dy * rayDir[1] + dz * rayDir[2];
      if (tca < 0) return false;
      return (dx*dx + dy*dy + dz*dz - tca*tca) <= hitR2;
    };

    if (data.mode === 'radial') {
      return testSphere(data.handlePos) ? 'radius' : null;
    }

    // Grid: test Y before X (Y arm is often on top)
    if (data.mode === 'grid' && data.handlePosY && testSphere(data.handlePosY)) return 'y';
    if (testSphere(data.handlePos)) return 'x';
    return null;
  }

  // ── Face handles (Array Tool hover mode) ─────────────────────────

  /**
   * Draw face handle arrows for the Array Tool hover mode.
   * Primary handles (cardinal axes) are bright blue and larger.
   * Secondary handles (diagonals, Grid mode only) are orange and smaller.
   * Rendered with depth compare = 'always' so they're always visible.
   */
  drawFaceHandles(
    pass: GPURenderPassEncoder,
    data: FaceHandleData,
    camera: Camera3D,
  ): void {
    if (data.handles.length === 0) return;

    const verts: number[] = [];
    const idxs:  number[] = [];

    // Use the centroid of all handle positions to compute a representative scale.
    const refPos = vec3.fromValues(...data.handles[0].pos);
    const scale  = GizmoRenderer.computeGizmoScale(camera, refPos);

    // X=red, Y=green, Z=blue (universal 3D editor convention); XZ diagonals=magenta.
    const getAxisColor = (id: string): Color4 => {
      if (id === 'px' || id === 'nx') return [1.00, 0.22, 0.22, 1.0];
      if (id === 'py' || id === 'ny') return [0.22, 0.90, 0.22, 1.0];
      if (id === 'pz' || id === 'nz') return [0.30, 0.55, 1.00, 1.0];
      return [0.85, 0.22, 0.85, 0.85]; // XZ diagonal → magenta
    };

    const [cx, cy, cz] = data.center;

    for (const h of data.handles) {
      const hovered = h.id === data.hoveredId;
      const primary = h.tier === 'primary';

      const shaftLen  = scale * (primary ? 0.35 : 0.22);
      const shaftR    = scale * (primary ? 0.028 : 0.018);
      const sphereR   = scale * (primary ? 0.10  : 0.065);
      const lineR     = scale * 0.010;

      const axisCol   = getAxisColor(h.id);
      const col: Color4     = hovered ? [1, 0.9, 0.1, 1.0] : axisCol;
      const shaftCol: Color4 = hovered
        ? [1, 0.9, 0.1, 0.70]
        : [axisCol[0], axisCol[1], axisCol[2], axisCol[3] * 0.65];
      const lineCol: Color4 = [axisCol[0], axisCol[1], axisCol[2], 0.35];

      const facePos: [number, number, number] = h.pos;
      const tip:     [number, number, number] = [
        h.pos[0] + h.dir[0] * shaftLen,
        h.pos[1] + h.dir[1] * shaftLen,
        h.pos[2] + h.dir[2] * shaftLen,
      ];

      // Thin colored line from OBB/AABB center → face position (axis spoke)
      addEdgePrism(verts, idxs, [cx, cy, cz], facePos, lineR, lineCol);
      // Handle shaft + sphere tip
      addEdgePrism(verts, idxs, facePos, tip, shaftR, shaftCol);
      addUvSphere(verts, idxs, tip[0], tip[1], tip[2], sphereR, col, 5, 8);
    }

    const vertCount = verts.length / 7;
    const idxCount  = idxs.length;
    if (idxCount === 0) return;

    const vf = new Float32Array(vertCount * 7);
    const vi = new Uint32Array(idxCount);
    vf.set(verts, 0);
    vi.set(idxs, 0);

    this.device.queue.writeBuffer(this._faceHandleVertBuf, 0, vf, 0, vertCount * 7);
    this.device.queue.writeBuffer(this._faceHandleIdxBuf,  0, vi, 0, idxCount);

    const vp    = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16);  // identity model (world-space geometry)
    this.device.queue.writeBuffer(this._faceHandleUniBuf, 0, uData);

    const bg = this.uniformBindGroup(this._faceHandleUniBuf);   // cached (audit 5.12)

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._faceHandleVertBuf);
    pass.setIndexBuffer(this._faceHandleIdxBuf, 'uint32');
    pass.drawIndexed(idxCount);
  }

  /**
   * Ray-sphere test against all face handle tips.
   * Returns the ID of the nearest hit handle, or null.
   */
  hitTestFaceHandle(
    rayOrigin: vec3,
    rayDir: vec3,
    data: FaceHandleData,
    camera: Camera3D,
  ): string | null {
    let bestId: string | null = null;
    let bestT = Infinity;

    for (const h of data.handles) {
      const scale  = GizmoRenderer.computeGizmoScale(camera, vec3.fromValues(...h.pos));
      const primary = h.tier === 'primary';
      const shaftLen = scale * (primary ? 0.35 : 0.22);
      const tipPos: [number, number, number] = [
        h.pos[0] + h.dir[0] * shaftLen,
        h.pos[1] + h.dir[1] * shaftLen,
        h.pos[2] + h.dir[2] * shaftLen,
      ];

      const hitR  = scale * (primary ? 0.10 : 0.065) * 2.5;
      const hitR2 = hitR * hitR;
      const dx = tipPos[0] - rayOrigin[0];
      const dy = tipPos[1] - rayOrigin[1];
      const dz = tipPos[2] - rayOrigin[2];
      const tca = dx * rayDir[0] + dy * rayDir[1] + dz * rayDir[2];
      if (tca < 0) continue;
      const d2 = dx*dx + dy*dy + dz*dz - tca*tca;
      if (d2 > hitR2) continue;
      if (tca < bestT) { bestT = tca; bestId = h.id; }
    }

    return bestId;
  }

  // ── Hit testing ─────────────────────────────────────────────────

  /**
   * Test a world-space ray against the gizmo's axes/planes.
   * Returns the nearest hit axis/plane identifier, or null if no hit.
   */
  hitTest(
    rayOrigin: vec3,
    rayDir: vec3,
    selectedMeshes: Mesh3D[],
    camera: Camera3D,
    mode: GizmoMode,
  ): GizmoAxis {
    if (selectedMeshes.length === 0 || mode === null) return null;

    const center = this.computeCenter(selectedMeshes);
    const scale  = GizmoRenderer.computeGizmoScale(camera, center);

    // Gizmo model matrix and its inverse (matches drawGizmo exactly)
    const model = mat4.create();
    mat4.translate(model, model, center);
    if (this.orientationMode === 'local' && selectedMeshes.length > 0) {
      mat4.multiply(model, model, this.extractRotationMatrix(selectedMeshes[0]));
    }
    mat4.scale(model, model, [scale, scale, scale]);
    const invModel = mat4.invert(mat4.create(), model);
    if (!invModel) return null;

    const { lO, lD } = toGizmoLocal(rayOrigin, rayDir, invModel);

    let bestT = Infinity;
    let bestAxis: GizmoAxis = null;

    function tryHit(axis: GizmoAxis, t: number | null): void {
      if (t !== null && t > 0 && t < bestT) {
        bestT = t;
        bestAxis = axis;
      }
    }

    if (mode === 'move' || mode === 'scale') {
      tryHit('x', hitAxisCylinder(lO, lD, 'x', HIT_RADIUS_AXIS));
      tryHit('y', hitAxisCylinder(lO, lD, 'y', HIT_RADIUS_AXIS));
      tryHit('z', hitAxisCylinder(lO, lD, 'z', HIT_RADIUS_AXIS));
      if (mode === 'move') {
        tryHit('xy', hitPlane(lO, lD, 'xy'));
        tryHit('xz', hitPlane(lO, lD, 'xz'));
        tryHit('yz', hitPlane(lO, lD, 'yz'));
      }
    } else {
      // rotate
      tryHit('x', hitRotateRing(lO, lD, 'x'));
      tryHit('y', hitRotateRing(lO, lD, 'y'));
      tryHit('z', hitRotateRing(lO, lD, 'z'));
    }

    return bestAxis;
  }

  // ── Bone overlay ────────────────────────────────────────────────

  /**
   * Draw the bone overlay for a skeleton: bone sticks between parent/child joints,
   * a sphere at each joint, and a tail handle sphere on leaf joints.
   *
   * @param hoveredJointIdx      Head-sphere joint currently under the pointer (or null).
   * @param selectedJointIdx     Selected joint (or null).
   * @param selectedJointIsTail  True when the selection was made by clicking a tail sphere.
   *                             Head sphere stays default color; tail sphere turns cyan.
   * @param hoveredTailJointIdx  Tail-sphere joint currently under the pointer (or null).
   */
  drawBoneOverlay(
    pass: GPURenderPassEncoder,
    skeleton: Skeleton3D,
    camera: Camera3D,
    hoveredJointIdx: number | null,
    selectedJointIdx: number | null,
    selectedJointIsTail = false,
    hoveredTailJointIdx: number | null = null,
    weightPaintMode = false,
    programmaticHoverIdx: number | null = null,
    showSkeleton = true,
    showSpringBones = true,
    showFkBones = true,
  ): void {
    const { joints } = skeleton.data;
    if (joints.length === 0) return;

    // Compute skeleton center for screen-space-consistent joint sphere radius
    let cx = 0, cy = 0, cz = 0;
    for (const j of joints) { cx += j.worldMatrix[12]; cy += j.worldMatrix[13]; cz += j.worldMatrix[14]; }
    const inv = 1 / joints.length;
    const center = vec3.fromValues(cx * inv, cy * inv, cz * inv);
    const jointRadius = GizmoRenderer.computeGizmoScale(camera, center) * 0.07;

    const { verts, idxs, vertCount, idxCount, lineVerts, lineVertCount } = buildBoneOverlayGeometry(
      skeleton, jointRadius, hoveredJointIdx, selectedJointIdx, selectedJointIsTail, hoveredTailJointIdx,
      camera.position, weightPaintMode, programmaticHoverIdx, showSkeleton, showSpringBones, showFkBones,
    );
    if (idxCount === 0) return;

    this.device.queue.writeBuffer(this._boneVertBuf, 0, verts, 0, vertCount * 7);
    this.device.queue.writeBuffer(this._boneIdxBuf,  0, idxs,  0, idxCount);

    const vp    = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16); // identity model — geometry is in world space
    this.device.queue.writeBuffer(this._boneUniBuf, 0, uData);

    const bg = this.uniformBindGroup(this._boneUniBuf);   // cached (audit 5.12)

    // Fill pass — depth write enabled so edges can occlude against bone surfaces.
    pass.setPipeline(this._boneFillPipe);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._boneVertBuf);
    pass.setIndexBuffer(this._boneIdxBuf, 'uint32');
    pass.drawIndexed(idxCount);

    // Edge outline pass (drawn after fill so edges appear on top)
    if (lineVertCount > 0) {
      this.device.queue.writeBuffer(this._boneEdgeVertBuf, 0, lineVerts, 0, lineVertCount * 7);
      pass.setPipeline(this._boneLinePipe);
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, this._boneEdgeVertBuf);
      pass.draw(lineVertCount);
    }
  }

  /**
   * Ray-test joint head spheres and leaf-joint tail spheres for the given skeleton.
   * Returns `{ index, isTail }` for the nearest sphere hit, or null.
   *
   * Head hit radius = 1.8× visual joint radius.
   * Tail hit radius = 1.8× tail visual radius (= 0.75 × head visual radius).
   */
  hitTestJoint(
    rayOrigin: vec3,
    rayDir: vec3,
    skeleton: Skeleton3D,
    camera: Camera3D,
    showSpringBones = true,
    showFkBones = true,
  ): { index: number; isTail: boolean } | null {
    const { joints } = skeleton.data;
    if (joints.length === 0) return null;
    // Hidden bones aren't clickable — mirror the draw-time visibility so you can't select what you can't see.
    const springJoints = new Set<number>();
    for (const c of skeleton.data.springChains ?? []) if (c.enabled) for (const ji of c.jointIndices) springJoints.add(ji);
    const visible = (idx: number) => (springJoints.has(idx) ? showSpringBones : showFkBones);

    let cx = 0, cy = 0, cz = 0;
    for (const j of joints) { cx += j.worldMatrix[12]; cy += j.worldMatrix[13]; cz += j.worldMatrix[14]; }
    const inv = 1 / joints.length;
    const center = vec3.fromValues(cx * inv, cy * inv, cz * inv);
    const visualR     = GizmoRenderer.computeGizmoScale(camera, center) * 0.07;
    const headHitR2   = (visualR * 1.8) ** 2;
    const tailHitR2   = (visualR * 0.75 * 1.8) ** 2;

    let bestT    = Infinity;
    let bestIdx: number | null = null;
    let bestTail = false;

    for (const j of joints) {
      if (!visible(j.index)) continue;   // hidden category → not hit-testable
      // ── Head sphere ──────────────────────────────────────────────────────
      {
        const ox = j.worldMatrix[12] - rayOrigin[0];
        const oy = j.worldMatrix[13] - rayOrigin[1];
        const oz = j.worldMatrix[14] - rayOrigin[2];
        const tca = ox * rayDir[0] + oy * rayDir[1] + oz * rayDir[2];
        if (tca >= 0) {
          const d2 = ox*ox + oy*oy + oz*oz - tca*tca;
          if (d2 <= headHitR2) {
            const t = tca - Math.sqrt(headHitR2 - d2);
            if (t > 0 && t < bestT) { bestT = t; bestIdx = j.index; bestTail = false; }
          }
        }
      }
      // ── Tail sphere (leaf joints only) ───────────────────────────────────
      if (j.children.length === 0) {
        const [tx, ty, tz] = jointTailWorldPos(j);
        const ox = tx - rayOrigin[0];
        const oy = ty - rayOrigin[1];
        const oz = tz - rayOrigin[2];
        const tca = ox * rayDir[0] + oy * rayDir[1] + oz * rayDir[2];
        if (tca >= 0) {
          const d2 = ox*ox + oy*oy + oz*oz - tca*tca;
          if (d2 <= tailHitR2) {
            const t = tca - Math.sqrt(tailHitR2 - d2);
            if (t > 0 && t < bestT) { bestT = t; bestIdx = j.index; bestTail = true; }
          }
        }
      }
    }
    return bestIdx !== null ? { index: bestIdx, isTail: bestTail } : null;
  }

  // ── Helpers ────────────────────────────────────────────────────

  /** Extract pure rotation matrix from a mesh's localMatrix (strips scale and translation). */
  private extractRotationMatrix(mesh: Mesh3D): mat4 {
    const mm = mesh.localMatrix as unknown as Float32Array;
    const c0l = Math.hypot(mm[0], mm[1], mm[2]) || 1;
    const c1l = Math.hypot(mm[4], mm[5], mm[6]) || 1;
    const c2l = Math.hypot(mm[8], mm[9], mm[10]) || 1;
    const rot = mat4.create();
    rot[0] = mm[0]/c0l; rot[1] = mm[1]/c0l; rot[2]  = mm[2]/c0l;
    rot[4] = mm[4]/c1l; rot[5] = mm[5]/c1l; rot[6]  = mm[6]/c1l;
    rot[8] = mm[8]/c2l; rot[9] = mm[9]/c2l; rot[10] = mm[10]/c2l;
    rot[15] = 1;
    return rot;
  }

  /** Compute world-space centroid of the given meshes. */
  computeCenter(meshes: Mesh3D[]): vec3 {
    const c = vec3.create();
    for (const m of meshes) {
      const col = (m.localMatrix as mat4);
      c[0] += col[12]; c[1] += col[13]; c[2] += col[14];
    }
    return vec3.scale(c, c, 1 / meshes.length);
  }

  // ── Joint translate gizmo ─────────────────────────────────────────

  /** Draw a translate gizmo centered at a joint's world position. */
  drawJointGizmo(
    pass: GPURenderPassEncoder,
    worldPos: [number, number, number],
    camera: Camera3D,
    hovered: GizmoAxis,
    dragging: GizmoAxis = null,
  ): void {
    const center = worldPos as unknown as vec3;
    const scale = GizmoRenderer.computeGizmoScale(camera, center);

    const model = mat4.create();
    mat4.translate(model, model, center);
    mat4.scale(model, model, [scale, scale, scale]);

    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(model as Float32Array, 16);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uData);

    const { verts, idxs, vertCount, idxCount } = buildGizmoGeometry('move', hovered, dragging);
    if (idxCount === 0) return;

    this.device.queue.writeBuffer(this.vertexBuffer, 0, verts, 0, vertCount * 7);
    this.device.queue.writeBuffer(this.indexBuffer, 0, idxs, 0, idxCount);

    const bg = this.uniformBindGroup(this.uniformBuffer);   // cached (audit 5.12)

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(idxCount);
  }

  /** Hit-test a joint translate gizmo. Returns the hovered axis or null. */
  hitTestJointGizmo(
    rayOrigin: vec3,
    rayDir: vec3,
    worldPos: [number, number, number],
    camera: Camera3D,
  ): GizmoAxis {
    const center = worldPos as unknown as vec3;
    const scale = GizmoRenderer.computeGizmoScale(camera, center);

    const model = mat4.create();
    mat4.translate(model, model, center);
    mat4.scale(model, model, [scale, scale, scale]);
    const invModel = mat4.invert(mat4.create(), model);
    if (!invModel) return null;

    const { lO, lD } = toGizmoLocal(rayOrigin, rayDir, invModel);

    let bestT = Infinity;
    let bestAxis: GizmoAxis = null;

    function tryHit(axis: GizmoAxis, t: number | null): void {
      if (t !== null && t > 0 && t < bestT) { bestT = t; bestAxis = axis; }
    }

    tryHit('x',  hitAxisCylinder(lO, lD, 'x', HIT_RADIUS_AXIS));
    tryHit('y',  hitAxisCylinder(lO, lD, 'y', HIT_RADIUS_AXIS));
    tryHit('z',  hitAxisCylinder(lO, lD, 'z', HIT_RADIUS_AXIS));
    tryHit('xy', hitPlane(lO, lD, 'xy'));
    tryHit('xz', hitPlane(lO, lD, 'xz'));
    tryHit('yz', hitPlane(lO, lD, 'yz'));

    return bestAxis;
  }

  /** Draw a FK rotate gizmo (three arc rings) at a joint's world position. */
  drawJointRotateGizmo(
    pass: GPURenderPassEncoder,
    worldPos: [number, number, number],
    camera: Camera3D,
    hovered: GizmoAxis,
    dragging: GizmoAxis = null,
  ): void {
    const center = worldPos as unknown as vec3;
    const scale = GizmoRenderer.computeGizmoScale(camera, center);

    const model = mat4.create();
    mat4.translate(model, model, center);
    mat4.scale(model, model, [scale, scale, scale]);

    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(model as Float32Array, 16);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uData);

    const { verts, idxs, vertCount, idxCount } = buildGizmoGeometry('rotate', hovered, dragging);
    if (idxCount === 0) return;

    this.device.queue.writeBuffer(this.vertexBuffer, 0, verts, 0, vertCount * 7);
    this.device.queue.writeBuffer(this.indexBuffer, 0, idxs, 0, idxCount);

    const bg = this.uniformBindGroup(this.uniformBuffer);   // cached (audit 5.12)

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(idxCount);
  }

  /** Hit-test a joint rotate gizmo (arc rings). Returns the hovered axis or null. */
  hitTestJointRotateGizmo(
    rayOrigin: vec3,
    rayDir: vec3,
    worldPos: [number, number, number],
    camera: Camera3D,
  ): GizmoAxis {
    const center = worldPos as unknown as vec3;
    const scale = GizmoRenderer.computeGizmoScale(camera, center);

    const model = mat4.create();
    mat4.translate(model, model, center);
    mat4.scale(model, model, [scale, scale, scale]);
    const invModel = mat4.invert(mat4.create(), model);
    if (!invModel) return null;

    const { lO, lD } = toGizmoLocal(rayOrigin, rayDir, invModel);

    let bestT = Infinity;
    let bestAxis: GizmoAxis = null;

    function tryHit(axis: GizmoAxis, t: number | null): void {
      if (t !== null && t > 0 && t < bestT) { bestT = t; bestAxis = axis; }
    }

    tryHit('x', hitRotateRing(lO, lD, 'x'));
    tryHit('y', hitRotateRing(lO, lD, 'y'));
    tryHit('z', hitRotateRing(lO, lD, 'z'));

    return bestAxis;
  }

  /**
   * Draw IK handles: gold sphere at each chain's target, and (when set) a cyan
   * sphere + thin stick for the pole vector. Uses depthCompare:'always' so handles
   * are visible through geometry.
   */
  drawIKTargets(
    pass: GPURenderPassEncoder,
    chains: IKChain[],
    skeleton: Skeleton3D,
    camera: Camera3D,
    hoveredHandle: IKHandleHit | null,
    draggingHandle: IKHandleHit | null,
  ): void {
    if (chains.length === 0) return;

    // Compute sphere radius from camera distance to the first chain target
    const firstTarget = chains[0].target;
    const center = vec3.fromValues(firstTarget[0], firstTarget[1], firstTarget[2]);
    const baseScale = GizmoRenderer.computeGizmoScale(camera, center);
    const sphereR  = baseScale * 0.085;
    const poleSphR = sphereR * 0.75;
    const lineW    = sphereR * 0.18;

    const verts: number[] = [];
    const idxs: number[] = [];

    for (const chain of chains) {
      // ── IK target sphere ───────────────────────────────────────────────────
      const [tx, ty, tz] = chain.target;
      const tgtHovered  = hoveredHandle?.chainId  === chain.id && hoveredHandle.handleType  === 'target';
      const tgtDragging = draggingHandle?.chainId === chain.id && draggingHandle.handleType === 'target';
      const tgtCol: Color4 = tgtDragging ? COL_IK_DRAG : tgtHovered ? COL_IK_HOVER : COL_IK_IDLE;
      addUvSphere(verts, idxs, tx, ty, tz, sphereR, tgtCol, 5, 8);

      // ── Pole vector sphere + line ──────────────────────────────────────────
      if (chain.poleTarget) {
        const [px, py, pz] = chain.poleTarget;
        const poleHovered  = hoveredHandle?.chainId  === chain.id && hoveredHandle.handleType  === 'pole';
        const poleDragging = draggingHandle?.chainId === chain.id && draggingHandle.handleType === 'pole';
        const poleCol: Color4 = poleDragging ? COL_POLE_DRAG : poleHovered ? COL_POLE_HOVER : COL_POLE_IDLE;
        addUvSphere(verts, idxs, px, py, pz, poleSphR, poleCol, 5, 8);

        // Thin stick from chain anchor to pole target
        const { joints } = skeleton.data;
        let anchorIdx = chain.endJointIdx;
        for (let i = 0; i < chain.chainLength && anchorIdx >= 0; i++) {
          anchorIdx = joints[anchorIdx]?.parentIndex ?? -1;
        }
        if (anchorIdx >= 0 && anchorIdx < joints.length) {
          const wm = joints[anchorIdx].worldMatrix;
          const anchorPos: [number, number, number] = [wm[12], wm[13], wm[14]];
          const polePos:   [number, number, number] = [px, py, pz];
          addEdgePrism(verts, idxs, anchorPos, polePos, lineW, COL_POLE_LINE);
        }
      }
    }

    const vertCount = verts.length / 7;
    const idxCount  = idxs.length;
    if (vertCount === 0 || idxCount === 0) return;

    const vf = new Float32Array(MAX_IK_VERTS * 7);
    const vi = new Uint32Array(MAX_IK_IDXS);
    vf.set(verts, 0);
    vi.set(idxs, 0);

    this.device.queue.writeBuffer(this._ikVertBuf, 0, vf, 0, vertCount * 7);
    this.device.queue.writeBuffer(this._ikIdxBuf,  0, vi, 0, idxCount);

    const vp    = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData.set(mat4.create() as Float32Array, 16);
    this.device.queue.writeBuffer(this._ikUniBuf, 0, uData);

    const bg = this.uniformBindGroup(this._ikUniBuf);   // cached (audit 5.12)

    pass.setPipeline(this._boneFillPipe);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._ikVertBuf);
    pass.setIndexBuffer(this._ikIdxBuf, 'uint32');
    pass.drawIndexed(idxCount);
  }

  /**
   * Ray-test IK handles (target spheres and pole spheres).
   * Returns the nearest hit as an IKHandleHit, or null.
   * Hit radius = 1.8× visual sphere radius.
   */
  hitTestIKTargets(
    rayOrigin: vec3,
    rayDir: vec3,
    chains: IKChain[],
    camera: Camera3D,
  ): IKHandleHit | null {
    if (chains.length === 0) return null;

    const firstTarget = chains[0].target;
    const center = vec3.fromValues(firstTarget[0], firstTarget[1], firstTarget[2]);
    const baseScale = GizmoRenderer.computeGizmoScale(camera, center);
    const tgtR  = baseScale * 0.085;
    const tgtHitR2  = (tgtR  * 1.8) ** 2;
    const poleR = tgtR * 0.75;
    const poleHitR2 = (poleR * 1.8) ** 2;

    let bestT: number = Infinity;
    let bestHit: IKHandleHit | null = null;

    const testSphere = (cx: number, cy: number, cz: number, hitR2: number, hit: IKHandleHit) => {
      const ox = cx - rayOrigin[0];
      const oy = cy - rayOrigin[1];
      const oz = cz - rayOrigin[2];
      const tca = ox * rayDir[0] + oy * rayDir[1] + oz * rayDir[2];
      if (tca < 0) return;
      const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
      if (d2 > hitR2) return;
      const t = tca - Math.sqrt(hitR2 - d2);
      if (t > 0 && t < bestT) { bestT = t; bestHit = hit; }
    };

    for (const chain of chains) {
      const [tx, ty, tz] = chain.target;
      testSphere(tx, ty, tz, tgtHitR2, { chainId: chain.id, handleType: 'target' });

      if (chain.poleTarget) {
        const [px, py, pz] = chain.poleTarget;
        testSphere(px, py, pz, poleHitR2, { chainId: chain.id, handleType: 'pole' });
      }
    }

    return bestHit;
  }

  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.uniformBuffer.destroy();
    this._selBoxVertBuf.destroy();
    this._selBoxIdxBuf.destroy();
    this._selBoxUniBuf.destroy();
    this._boneVertBuf.destroy();
    this._boneIdxBuf.destroy();
    this._boneUniBuf.destroy();
    this._boneEdgeVertBuf.destroy();
    this._gridVertBuf.destroy();
    this._gridUniBuf.destroy();
    this._artboardVertBuf.destroy();
    this._frustumVertBuf.destroy();
    this._snapVizBuf.destroy();
    this._snapVizUniBuf.destroy();
    this._ikVertBuf.destroy();
    this._ikIdxBuf.destroy();
    this._ikUniBuf.destroy();
  }
}
