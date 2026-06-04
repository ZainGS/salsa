/**
 * Mesh geometry generators — procedural 3D primitives.
 *
 * All generators produce vertex data in the 3D vertex format:
 *   position(vec3) + normal(vec3) + uv(vec2) + tangent(vec4) = 48 bytes per vertex
 *
 * Tangent .xyz = object-space tangent direction.
 * Tangent .w   = handedness: +1 or -1 (sign(cross(N,T)·B)).
 *
 * Returns { vertices: Float32Array, indices: Uint32Array }.
 * Winding order: counter-clockwise (CCW) front faces.
 */

export interface MeshGeometry {
  /** Interleaved vertex data: [px,py,pz, nx,ny,nz, u,v, tx,ty,tz,tw, ...] */
  vertices: Float32Array;
  /** Triangle indices (uint32). */
  indices: Uint32Array;
  /**
   * Explicit vertex format tag. When set, Mesh3D.setGeometry() trusts this
   * value instead of inferring the stride from array length.
   *   '8float'  = legacy: pos(3)+normal(3)+uv(2), no tangent — setGeometry will compute tangents
   *   '12float' = current: pos(3)+normal(3)+uv(2)+tangent(4)
   */
  format?: '8float' | '12float';
  /**
   * Optional per-vertex RGBA colors (4 floats per vertex, same count as vertices.length / FLOATS_PER_VERT).
   * Set by EditMesh.compile() when vertex painting is active. The renderer uses a second vertex
   * buffer slot for these — pipeline switches to the vertex-color variant when present.
   */
  vertexColors?: Float32Array;
}

/** Number of floats per vertex: 3 (pos) + 3 (normal) + 2 (uv) + 4 (tangent) = 12 */
export const FLOATS_PER_VERT = 12;

// ── Box (Cube) ───────────────────────────────────────────────────

export function generateBox(
  width = 1, height = 1, depth = 1,
): MeshGeometry {
  const hw = width / 2, hh = height / 2, hd = depth / 2;

  // 6 faces × 4 verts = 24 vertices, 6 faces × 2 tris × 3 = 36 indices
  const vertices = new Float32Array(24 * FLOATS_PER_VERT);
  const indices = new Uint32Array(36);

  // Define each face: normal, 4 corners (CCW), and analytical tangent (U direction)
  const faceData: { n: number[]; v: number[][]; t: number[] }[] = [
    // Front (+Z) — U along +X
    { n: [0, 0, 1],  v: [[-hw,-hh,hd],[hw,-hh,hd],[hw,hh,hd],[-hw,hh,hd]],   t: [1,0,0] },
    // Back (-Z) — U along -X
    { n: [0, 0,-1],  v: [[hw,-hh,-hd],[-hw,-hh,-hd],[-hw,hh,-hd],[hw,hh,-hd]], t: [-1,0,0] },
    // Top (+Y) — U along +X
    { n: [0, 1, 0],  v: [[-hw,hh,hd],[hw,hh,hd],[hw,hh,-hd],[-hw,hh,-hd]],   t: [1,0,0] },
    // Bottom (-Y) — U along +X
    { n: [0,-1, 0],  v: [[-hw,-hh,-hd],[hw,-hh,-hd],[hw,-hh,hd],[-hw,-hh,hd]], t: [1,0,0] },
    // Right (+X) — U along -Z
    { n: [1, 0, 0],  v: [[hw,-hh,hd],[hw,-hh,-hd],[hw,hh,-hd],[hw,hh,hd]],   t: [0,0,-1] },
    // Left (-X) — U along +Z
    { n: [-1, 0, 0], v: [[-hw,-hh,-hd],[-hw,-hh,hd],[-hw,hh,hd],[-hw,hh,-hd]], t: [0,0,1] },
  ];

  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];

  let vi = 0;
  let ii = 0;

  for (const face of faceData) {
    const baseVert = vi / FLOATS_PER_VERT;
    for (let j = 0; j < 4; j++) {
      const p = face.v[j];
      vertices[vi++] = p[0]; vertices[vi++] = p[1]; vertices[vi++] = p[2];          // pos
      vertices[vi++] = face.n[0]; vertices[vi++] = face.n[1]; vertices[vi++] = face.n[2]; // normal
      vertices[vi++] = uvs[j][0]; vertices[vi++] = uvs[j][1];                       // uv
      vertices[vi++] = face.t[0]; vertices[vi++] = face.t[1]; vertices[vi++] = face.t[2]; vertices[vi++] = 1.0; // tangent
    }
    indices[ii++] = baseVert;
    indices[ii++] = baseVert + 1;
    indices[ii++] = baseVert + 2;
    indices[ii++] = baseVert;
    indices[ii++] = baseVert + 2;
    indices[ii++] = baseVert + 3;
  }

  return { vertices, indices, format: '12float' };
}

// ── Sphere (UV Sphere) ──────────────────────────────────────────

export function generateSphere(
  radius = 0.5, widthSegments = 16, heightSegments = 12,
): MeshGeometry {
  const ws = Math.max(3, widthSegments);
  const hs = Math.max(2, heightSegments);

  const vertCount = (ws + 1) * (hs + 1);
  const idxCount = ws * hs * 6;
  const vertices = new Float32Array(vertCount * FLOATS_PER_VERT);
  const indices = new Uint32Array(idxCount);

  let vi = 0;
  for (let y = 0; y <= hs; y++) {
    const v = y / hs;
    const phi = v * Math.PI;
    for (let x = 0; x <= ws; x++) {
      const u = x / ws;
      const theta = u * 2 * Math.PI;

      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);

      // Tangent = dPos/dTheta (normalized, U direction along longitude)
      const tx = -Math.sin(theta);
      const tz =  Math.cos(theta);
      // ty = 0 for equatorial tangent; normalized length = 1

      vertices[vi++] = nx * radius; vertices[vi++] = ny * radius; vertices[vi++] = nz * radius; // pos
      vertices[vi++] = nx;          vertices[vi++] = ny;          vertices[vi++] = nz;           // normal
      vertices[vi++] = u;           vertices[vi++] = v;                                           // uv
      vertices[vi++] = tx;          vertices[vi++] = 0;           vertices[vi++] = tz; vertices[vi++] = 1.0; // tangent
    }
  }

  let ii = 0;
  for (let y = 0; y < hs; y++) {
    for (let x = 0; x < ws; x++) {
      const a = y * (ws + 1) + x;
      const b = a + ws + 1;
      indices[ii++] = a;     indices[ii++] = b;     indices[ii++] = a + 1;
      indices[ii++] = a + 1; indices[ii++] = b;     indices[ii++] = b + 1;
    }
  }

  return { vertices, indices, format: '12float' };
}

// ── Plane ────────────────────────────────────────────────────────

export function generatePlane(
  width = 1, height = 1, widthSegments = 1, heightSegments = 1,
): MeshGeometry {
  const ws = Math.max(1, widthSegments);
  const hs = Math.max(1, heightSegments);

  const vertCount = (ws + 1) * (hs + 1);
  const idxCount = ws * hs * 6;
  const vertices = new Float32Array(vertCount * FLOATS_PER_VERT);
  const indices = new Uint32Array(idxCount);

  // Plane is XZ (Y-up). U increases along +X, V increases along -Z.
  // Tangent = (1,0,0), w = +1.
  let vi = 0;
  for (let iy = 0; iy <= hs; iy++) {
    const v = iy / hs;
    const y = (v - 0.5) * height;
    for (let ix = 0; ix <= ws; ix++) {
      const u = ix / ws;
      const x = (u - 0.5) * width;
      vertices[vi++] = x; vertices[vi++] = 0; vertices[vi++] = -y; // pos
      vertices[vi++] = 0; vertices[vi++] = 1; vertices[vi++] = 0;  // normal
      vertices[vi++] = u; vertices[vi++] = v;                       // uv
      vertices[vi++] = 1; vertices[vi++] = 0; vertices[vi++] = 0; vertices[vi++] = 1.0; // tangent
    }
  }

  let ii = 0;
  for (let iy = 0; iy < hs; iy++) {
    for (let ix = 0; ix < ws; ix++) {
      const a = iy * (ws + 1) + ix;
      const b = a + ws + 1;
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1;
      indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1;
    }
  }

  return { vertices, indices, format: '12float' };
}

// ── Sprite (XY plane, camera-facing) ─────────────────────────────

export function generateSprite(width = 1, height = 1): MeshGeometry {
  const hw = width / 2, hh = height / 2;
  const vertices = new Float32Array(4 * FLOATS_PER_VERT);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  // XY plane, normal +Z, tangent +X, CCW winding from +Z
  const vData: [number, number, number, number][] = [
    [-hw, -hh, 0, 0], // BL: u=0, v=0
    [ hw, -hh, 1, 0], // BR: u=1, v=0
    [ hw,  hh, 1, 1], // TR: u=1, v=1
    [-hw,  hh, 0, 1], // TL: u=0, v=1
  ];

  let vi = 0;
  for (const [px, py, u, v] of vData) {
    vertices[vi++] = px; vertices[vi++] = py; vertices[vi++] = 0;
    vertices[vi++] = 0;  vertices[vi++] = 0;  vertices[vi++] = 1;
    vertices[vi++] = u;  vertices[vi++] = v;
    vertices[vi++] = 1;  vertices[vi++] = 0;  vertices[vi++] = 0; vertices[vi++] = 1;
  }

  return { vertices, indices, format: '12float' };
}

// ── Cylinder / Cone ──────────────────────────────────────────────

export function generateCylinder(
  radiusTop = 0.5, radiusBottom = 0.5, height = 1, radialSegments = 16,
): MeshGeometry {
  const rs = Math.max(3, radialSegments);
  const halfH = height / 2;

  const sideVerts = (rs + 1) * 2;
  const capVerts = (rs + 1) * 2 + 2;
  const totalVerts = sideVerts + capVerts;
  const sideIdxCount = rs * 6;
  const capIdxCount = rs * 3 * 2;
  const totalIdx = sideIdxCount + capIdxCount;

  const vertices = new Float32Array(totalVerts * FLOATS_PER_VERT);
  const indices = new Uint32Array(totalIdx);

  let vi = 0;
  let ii = 0;

  // ── Side ─────────────────────────────────────────────────
  const slope = radiusBottom - radiusTop;
  const sideLen = Math.sqrt(slope * slope + height * height);
  const ny = slope / sideLen;
  const nScale = height / sideLen;

  for (let ring = 0; ring < 2; ring++) {
    const y = ring === 0 ? -halfH : halfH;
    const r = ring === 0 ? radiusBottom : radiusTop;
    for (let i = 0; i <= rs; i++) {
      const u = i / rs;
      const theta = u * 2 * Math.PI;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      vertices[vi++] = cos * r; vertices[vi++] = y; vertices[vi++] = sin * r;
      const nx = cos * nScale, nz = sin * nScale;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      vertices[vi++] = nx / len; vertices[vi++] = ny / len; vertices[vi++] = nz / len;
      vertices[vi++] = u; vertices[vi++] = ring;
      // Tangent along circumference: (-sin, 0, cos)
      vertices[vi++] = -sin; vertices[vi++] = 0; vertices[vi++] = cos; vertices[vi++] = 1.0;
    }
  }

  for (let i = 0; i < rs; i++) {
    const a = i, b = i + rs + 1;
    indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1;
    indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1;
  }

  // ── Top cap ──────────────────────────────────────────────
  const topCenterIdx = vi / FLOATS_PER_VERT;
  vertices[vi++] = 0; vertices[vi++] = halfH; vertices[vi++] = 0;
  vertices[vi++] = 0; vertices[vi++] = 1; vertices[vi++] = 0;
  vertices[vi++] = 0.5; vertices[vi++] = 0.5;
  vertices[vi++] = 1; vertices[vi++] = 0; vertices[vi++] = 0; vertices[vi++] = 1.0;

  for (let i = 0; i <= rs; i++) {
    const theta = (i / rs) * 2 * Math.PI;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    vertices[vi++] = cos * radiusTop; vertices[vi++] = halfH; vertices[vi++] = sin * radiusTop;
    vertices[vi++] = 0; vertices[vi++] = 1; vertices[vi++] = 0;
    vertices[vi++] = cos * 0.5 + 0.5; vertices[vi++] = sin * 0.5 + 0.5;
    vertices[vi++] = -sin; vertices[vi++] = 0; vertices[vi++] = cos; vertices[vi++] = 1.0;
  }

  for (let i = 0; i < rs; i++) {
    indices[ii++] = topCenterIdx;
    indices[ii++] = topCenterIdx + 1 + i;
    indices[ii++] = topCenterIdx + 1 + i + 1;
  }

  // ── Bottom cap ───────────────────────────────────────────
  const botCenterIdx = vi / FLOATS_PER_VERT;
  vertices[vi++] = 0; vertices[vi++] = -halfH; vertices[vi++] = 0;
  vertices[vi++] = 0; vertices[vi++] = -1; vertices[vi++] = 0;
  vertices[vi++] = 0.5; vertices[vi++] = 0.5;
  vertices[vi++] = 1; vertices[vi++] = 0; vertices[vi++] = 0; vertices[vi++] = 1.0;

  for (let i = 0; i <= rs; i++) {
    const theta = (i / rs) * 2 * Math.PI;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    vertices[vi++] = cos * radiusBottom; vertices[vi++] = -halfH; vertices[vi++] = sin * radiusBottom;
    vertices[vi++] = 0; vertices[vi++] = -1; vertices[vi++] = 0;
    vertices[vi++] = cos * 0.5 + 0.5; vertices[vi++] = sin * 0.5 + 0.5;
    vertices[vi++] = -sin; vertices[vi++] = 0; vertices[vi++] = cos; vertices[vi++] = 1.0;
  }

  for (let i = 0; i < rs; i++) {
    indices[ii++] = botCenterIdx;
    indices[ii++] = botCenterIdx + 1 + i + 1;
    indices[ii++] = botCenterIdx + 1 + i;
  }

  return { vertices: vertices.slice(0, vi), indices: indices.slice(0, ii), format: '12float' };
}

// ── Torus ────────────────────────────────────────────────────────

export function generateTorus(
  radius = 0.5, tube = 0.2, radialSegments = 16, tubularSegments = 24,
): MeshGeometry {
  const rs = Math.max(3, radialSegments);
  const ts = Math.max(3, tubularSegments);

  const vertCount = (rs + 1) * (ts + 1);
  const idxCount = rs * ts * 6;
  const vertices = new Float32Array(vertCount * FLOATS_PER_VERT);
  const indices = new Uint32Array(idxCount);

  let vi = 0;
  for (let j = 0; j <= rs; j++) {
    for (let i = 0; i <= ts; i++) {
      const u = (i / ts) * 2 * Math.PI;
      const v = (j / rs) * 2 * Math.PI;

      const px = (radius + tube * Math.cos(v)) * Math.cos(u);
      const py = tube * Math.sin(v);
      const pz = (radius + tube * Math.cos(v)) * Math.sin(u);

      const cx = radius * Math.cos(u);
      const cz = radius * Math.sin(u);

      const nx = px - cx, ny = py, nz = pz - cz;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

      // Tangent = dPos/dU direction (along the tube ring): (-sin(u), 0, cos(u))
      vertices[vi++] = px; vertices[vi++] = py; vertices[vi++] = pz;
      vertices[vi++] = nx / nlen; vertices[vi++] = ny / nlen; vertices[vi++] = nz / nlen;
      vertices[vi++] = i / ts; vertices[vi++] = j / rs;
      vertices[vi++] = -Math.sin(u); vertices[vi++] = 0; vertices[vi++] = Math.cos(u); vertices[vi++] = 1.0;
    }
  }

  let ii = 0;
  for (let j = 0; j < rs; j++) {
    for (let i = 0; i < ts; i++) {
      const a = j * (ts + 1) + i;
      const b = a + ts + 1;
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1;
      indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1;
    }
  }

  return { vertices, indices, format: '12float' };
}

// ── Ribbon (Catmull-Rom spline + Rotation-Minimizing Frame) ─────────

/**
 * Config for a spline-path ribbon mesh.
 * Control points are in object-local space (the Mesh3D's own origin).
 */
export interface RibbonConfig {
  /** 3D spline control points. Minimum 2; Catmull-Rom interpolates between them. */
  controlPoints: Array<[number, number, number]>;
  /** Ribbon width in world units. */
  width: number;
  /** Curve subdivisions per segment between adjacent control points. Default: 16. */
  segments?: number;
  /**
   * UV U-axis scroll offset (continuous). Each U coordinate is shifted by this value —
   * wrap is handled by the texture sampler's repeat mode. Used for horizontal scrolling.
   */
  uvScrollOffset?: number;
  /**
   * UV V-axis scroll offset (continuous). Each V coordinate is shifted by this value.
   * Used for vertical scrolling across the ribbon's width.
   */
  uvScrollOffsetV?: number;
  /**
   * Extra UV units appended to the end of the ribbon's U range.
   * The U range becomes 0 → (1 + uvEndPadding), giving a small overlap region so
   * a looping scroll does not show a hard seam at the texture boundary.
   * Default: 0 (U goes exactly 0→1).
   */
  uvEndPadding?: number;
  /**
   * Number of times the texture tiles along the ribbon length. Default: 1.
   * With tileCount=N the U coordinate runs from 0 to N instead of 0 to 1,
   * so the sampler repeats the texture N times. Use this to keep text crisp
   * on very long ribbons: put one copy of the text in the HTML, set tileCount
   * to cover the ribbon, and let the GPU handle repetition.
   */
  uvTileCount?: number;
  /**
   * Cross-section frame orientation mode. Default: 'normal' (Rotation-Minimizing Frame).
   * See RibbonPathMode in ribbon-3d.ts for full documentation.
   */
  pathMode?: 'normal' | 'world-up' | 'camera-facing';
  /**
   * World-space camera position. Required for pathMode 'camera-facing' — the frame
   * at each sample is oriented so the ribbon face points toward this position.
   * Ignored in 'normal' and 'world-up' modes.
   */
  cameraPosition?: [number, number, number];
  /**
   * Which faces of the ribbon to render.
   * - `'double'` (default) — both front and back.
   * - `'front'`  — front face only; prevents mirrored text from showing through spirals.
   * - `'back'`   — back face only; useful for inside-of-loop views.
   * Legacy boolean: `true` → `'double'`, `false` → `'front'`.
   */
  doubleSided?: 'double' | 'front' | 'back' | boolean;
  /**
   * When true, the back face receives horizontally mirrored U coordinates so text
   * reads left-to-right from both sides of the ribbon instead of appearing backwards
   * on the inside face. Only meaningful when `doubleSided` is true (default).
   */
  flipRearU?: boolean;
}

/**
 * Generate a double-sided ribbon mesh that follows a Catmull-Rom spline.
 *
 * GEOMETRY:
 *   - Spline is sampled uniformly into (N−1)×segments + 1 points.
 *   - A Rotation-Minimizing Frame (Wang et al. 2008, double-reflection method)
 *     is propagated along the spine so the ribbon does not twist unnecessarily.
 *   - Each sample yields a left edge (P + N·halfWidth) and right edge (P − N·halfWidth).
 *   - Front faces: CCW when viewed from the frame's binormal B = cross(T, N).
 *   - Back faces:  same geometry, reversed winding and negated normal.
 *
 * UV MAPPING:
 *   - U = normalized arc-length (0 at start → 1 at end) + uvScrollOffset
 *   - V = 0 on one edge, 1 on the other
 *   - Texture tiles along the path, which is ideal for scrolling HTML banners.
 */
export function generateRibbon(config: RibbonConfig): MeshGeometry {
  const {
    controlPoints: cp, width, segments = 16,
    uvScrollOffset = 0, uvScrollOffsetV = 0, uvEndPadding = 0, uvTileCount = 1,
    pathMode = 'normal', cameraPosition,
    flipRearU = false,
  } = config;

  // Normalise legacy boolean doubleSided to tri-state
  const rawDs = config.doubleSided ?? 'double';
  const sideMode: 'double' | 'front' | 'back' =
    rawDs === true  ? 'double' :
    rawDs === false ? 'front'  :
    (rawDs as 'double' | 'front' | 'back');
  if (cp.length < 2) throw new Error('generateRibbon: need at least 2 control points');

  const halfW = width / 2;
  const numSegs = cp.length - 1;
  const totalSamples = numSegs * segments + 1;

  // ── 1. Sample Catmull-Rom spline ─────────────────────────────────
  const positions: Array<[number, number, number]> = new Array(totalSamples);
  const tangents:  Array<[number, number, number]> = new Array(totalSamples);

  const catmullPos = (P0: [number, number, number], P1: [number, number, number], P2: [number, number, number], P3: [number, number, number], t: number): [number, number, number] => {
    const t2 = t * t, t3 = t2 * t;
    return [
      0.5 * ((2*P1[0]) + (-P0[0]+P2[0])*t + (2*P0[0]-5*P1[0]+4*P2[0]-P3[0])*t2 + (-P0[0]+3*P1[0]-3*P2[0]+P3[0])*t3),
      0.5 * ((2*P1[1]) + (-P0[1]+P2[1])*t + (2*P0[1]-5*P1[1]+4*P2[1]-P3[1])*t2 + (-P0[1]+3*P1[1]-3*P2[1]+P3[1])*t3),
      0.5 * ((2*P1[2]) + (-P0[2]+P2[2])*t + (2*P0[2]-5*P1[2]+4*P2[2]-P3[2])*t2 + (-P0[2]+3*P1[2]-3*P2[2]+P3[2])*t3),
    ];
  };

  const catmullTan = (P0: [number, number, number], P1: [number, number, number], P2: [number, number, number], P3: [number, number, number], t: number): [number, number, number] => {
    const t2 = t * t;
    let dx = 0.5 * ((-P0[0]+P2[0]) + 2*(2*P0[0]-5*P1[0]+4*P2[0]-P3[0])*t + 3*(-P0[0]+3*P1[0]-3*P2[0]+P3[0])*t2);
    let dy = 0.5 * ((-P0[1]+P2[1]) + 2*(2*P0[1]-5*P1[1]+4*P2[1]-P3[1])*t + 3*(-P0[1]+3*P1[1]-3*P2[1]+P3[1])*t2);
    let dz = 0.5 * ((-P0[2]+P2[2]) + 2*(2*P0[2]-5*P1[2]+4*P2[2]-P3[2])*t + 3*(-P0[2]+3*P1[2]-3*P2[2]+P3[2])*t2);
    const dlen = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
    return [dx/dlen, dy/dlen, dz/dlen];
  };

  let prevTan: [number, number, number] | null = null;
  for (let seg = 0; seg < numSegs; seg++) {
    const P0 = cp[Math.max(0, seg - 1)];
    const P1 = cp[seg];
    const P2 = cp[seg + 1];
    const P3 = cp[Math.min(cp.length - 1, seg + 2)];

    for (let j = 0; j < segments; j++) {
      const t = j / segments;
      const idx = seg * segments + j;
      positions[idx] = catmullPos(P0, P1, P2, P3, t);
      let tan = catmullTan(P0, P1, P2, P3, t);
      // Fall back to previous tangent if degenerate (zero-length segment)
      if (prevTan && tan[0] === 0 && tan[1] === 0 && tan[2] === 0) tan = prevTan;
      tangents[idx] = tan;
      prevTan = tan;
    }
  }
  // Final sample (t=1 on last segment)
  {
    const lastSeg = numSegs - 1;
    const P0 = cp[Math.max(0, lastSeg - 1)];
    const P1 = cp[lastSeg];
    const P2 = cp[lastSeg + 1];
    const P3 = cp[Math.min(cp.length - 1, lastSeg + 2)];
    const lastIdx = numSegs * segments;
    positions[lastIdx] = catmullPos(P0, P1, P2, P3, 1);
    let tan = catmullTan(P0, P1, P2, P3, 1);
    if (prevTan && tan[0] === 0 && tan[1] === 0 && tan[2] === 0) tan = prevTan!;
    tangents[lastIdx] = tan;
  }

  // ── 2. Per-sample frame (normal, world-up, or camera-facing) ────────
  const normals:   Array<[number, number, number]> = new Array(totalSamples);
  const binormals: Array<[number, number, number]> = new Array(totalSamples);

  const _setBinormal = (i: number, T: [number,number,number], N: [number,number,number]) => {
    binormals[i] = [T[1]*N[2]-T[2]*N[1], T[2]*N[0]-T[0]*N[2], T[0]*N[1]-T[1]*N[0]];
  };

  if (pathMode === 'world-up') {
    // Width direction = worldY projected perpendicular to tangent (Gram-Schmidt).
    // The ribbon stands upright like a wall. Text never flips on horizontal curves.
    for (let i = 0; i < totalSamples; i++) {
      const T = tangents[i];
      const wu: [number,number,number] = Math.abs(T[1]) < 0.99 ? [0,1,0] : [1,0,0];
      const dot = wu[0]*T[0] + wu[1]*T[1] + wu[2]*T[2];
      let nx = wu[0]-dot*T[0], ny = wu[1]-dot*T[1], nz = wu[2]-dot*T[2];
      const nl = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
      normals[i] = [nx/nl, ny/nl, nz/nl];
      _setBinormal(i, T, normals[i]);
    }

  } else if (pathMode === 'camera-facing' && cameraPosition) {
    // Width direction = cross(viewDir, T). Face normal always points toward camera.
    // Falls back to world-up when T is nearly parallel to the view direction.
    for (let i = 0; i < totalSamples; i++) {
      const T = tangents[i];
      const P = positions[i];
      let vx = cameraPosition[0]-P[0], vy = cameraPosition[1]-P[1], vz = cameraPosition[2]-P[2];
      const vl = Math.sqrt(vx*vx+vy*vy+vz*vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;
      // N = cross(viewDir, T)
      let nx = vy*T[2]-vz*T[1], ny = vz*T[0]-vx*T[2], nz = vx*T[1]-vy*T[0];
      const nl = Math.sqrt(nx*nx+ny*ny+nz*nz);
      if (nl < 1e-6) {
        // T nearly parallel to view — fallback to world-up for this sample
        const wu: [number,number,number] = Math.abs(T[1]) < 0.99 ? [0,1,0] : [1,0,0];
        const dot = wu[0]*T[0] + wu[1]*T[1] + wu[2]*T[2];
        nx = wu[0]-dot*T[0]; ny = wu[1]-dot*T[1]; nz = wu[2]-dot*T[2];
        const nl2 = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
        nx /= nl2; ny /= nl2; nz /= nl2;
      } else { nx /= nl; ny /= nl; nz /= nl; }
      normals[i] = [nx, ny, nz];
      _setBinormal(i, T, normals[i]);
    }

  } else {
    // 'normal' (default): Rotation-Minimizing Frame (Wang et al. 2008, double reflection).
    // The ribbon lies in the path plane and rotates smoothly with curves.
    const T0 = tangents[0];
    let wu: [number, number, number] = Math.abs(T0[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    const d0 = wu[0]*T0[0] + wu[1]*T0[1] + wu[2]*T0[2];
    let nx = wu[0] - d0*T0[0], ny = wu[1] - d0*T0[1], nz = wu[2] - d0*T0[2];
    const nl0 = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    normals[0] = [nx/nl0, ny/nl0, nz/nl0];
    _setBinormal(0, T0, normals[0]);

    for (let i = 0; i < totalSamples - 1; i++) {
      const Pi = positions[i], Pn = positions[i+1];
      const Ti = tangents[i],  Tn = tangents[i+1];
      const Ni = normals[i];

      const v1x = Pn[0]-Pi[0], v1y = Pn[1]-Pi[1], v1z = Pn[2]-Pi[2];
      const c1 = v1x*v1x + v1y*v1y + v1z*v1z;
      const k1 = c1 > 1e-12 ? 2 / c1 : 0;
      const dT1 = v1x*Ti[0] + v1y*Ti[1] + v1z*Ti[2];
      const dN1 = v1x*Ni[0] + v1y*Ni[1] + v1z*Ni[2];
      const rLx = Ti[0]-k1*dT1*v1x, rLy = Ti[1]-k1*dT1*v1y, rLz = Ti[2]-k1*dT1*v1z;
      const rNx = Ni[0]-k1*dN1*v1x, rNy = Ni[1]-k1*dN1*v1y, rNz = Ni[2]-k1*dN1*v1z;

      const v2x = Tn[0]-rLx, v2y = Tn[1]-rLy, v2z = Tn[2]-rLz;
      const c2 = v2x*v2x + v2y*v2y + v2z*v2z;
      let N2x, N2y, N2z;
      if (c2 < 1e-12) { N2x = rNx; N2y = rNy; N2z = rNz; }
      else {
        const k2 = 2 / c2;
        const dN2 = v2x*rNx + v2y*rNy + v2z*rNz;
        N2x = rNx-k2*dN2*v2x; N2y = rNy-k2*dN2*v2y; N2z = rNz-k2*dN2*v2z;
      }
      const nl = Math.sqrt(N2x*N2x + N2y*N2y + N2z*N2z) || 1;
      N2x /= nl; N2y /= nl; N2z /= nl;
      normals[i+1] = [N2x, N2y, N2z];
      _setBinormal(i+1, Tn, normals[i+1]);
    }
  }

  // ── 3. Arc-length parameterization ──────────────────────────────
  const arcL = new Float32Array(totalSamples);
  for (let i = 1; i < totalSamples; i++) {
    const dx = positions[i][0]-positions[i-1][0];
    const dy = positions[i][1]-positions[i-1][1];
    const dz = positions[i][2]-positions[i-1][2];
    arcL[i] = arcL[i-1] + Math.sqrt(dx*dx + dy*dy + dz*dz);
  }
  const totalLen = arcL[totalSamples-1] || 1;

  // ── 4. Build vertex/index arrays ─────────────────────────────────
  // Layout per sample: [FL, FR, BL, BR]  (F=front B=back, L=left R=right)
  // Front normal = +B, Back normal = -B; winding reversed for back.
  // BL/BR vertices are always emitted; only their index triangles vary by sideMode.
  const vertCount = totalSamples * 4;
  const idxCount  = sideMode === 'double' ? (totalSamples - 1) * 12 : (totalSamples - 1) * 6;
  const vertices  = new Float32Array(vertCount * FLOATS_PER_VERT);
  const indices   = new Uint32Array(idxCount);

  let vi = 0;
  for (let i = 0; i < totalSamples; i++) {
    const [px, py, pz] = positions[i];
    const T = tangents[i];
    const N = normals[i];
    const B = binormals[i];
    // U: arc-length fraction scaled by (1 + endPadding) for seamless loop overlap, then shifted.
    // V: 0/1 edge values shifted by uvScrollOffsetV for vertical scrolling.
    const u   = arcL[i] / totalLen * uvTileCount * (1 + uvEndPadding) + uvScrollOffset;
    // Mirror U for back face so text reads left-to-right from both sides.
    const uB  = flipRearU ? uvTileCount * (1 + uvEndPadding) * (1 - arcL[i] / totalLen) - uvScrollOffset : u;
    const v0  = uvScrollOffsetV;
    const v1  = 1 + uvScrollOffsetV;

    const lx = px + N[0]*halfW, ly = py + N[1]*halfW, lz = pz + N[2]*halfW;
    const rx = px - N[0]*halfW, ry = py - N[1]*halfW, rz = pz - N[2]*halfW;

    // Front-left  (normal = +B, tangent = +T, UV.v = 0)
    vertices[vi++]=lx; vertices[vi++]=ly; vertices[vi++]=lz;
    vertices[vi++]=B[0]; vertices[vi++]=B[1]; vertices[vi++]=B[2];
    vertices[vi++]=u; vertices[vi++]=v0;
    vertices[vi++]=T[0]; vertices[vi++]=T[1]; vertices[vi++]=T[2]; vertices[vi++]=1.0;

    // Front-right (normal = +B, tangent = +T, UV.v = 1)
    vertices[vi++]=rx; vertices[vi++]=ry; vertices[vi++]=rz;
    vertices[vi++]=B[0]; vertices[vi++]=B[1]; vertices[vi++]=B[2];
    vertices[vi++]=u; vertices[vi++]=v1;
    vertices[vi++]=T[0]; vertices[vi++]=T[1]; vertices[vi++]=T[2]; vertices[vi++]=1.0;

    // Back-left   (normal = -B, tangent = -T, UV.v = 0)
    vertices[vi++]=lx; vertices[vi++]=ly; vertices[vi++]=lz;
    vertices[vi++]=-B[0]; vertices[vi++]=-B[1]; vertices[vi++]=-B[2];
    vertices[vi++]=uB; vertices[vi++]=v0;
    vertices[vi++]=-T[0]; vertices[vi++]=-T[1]; vertices[vi++]=-T[2]; vertices[vi++]=1.0;

    // Back-right  (normal = -B, tangent = -T, UV.v = 1)
    vertices[vi++]=rx; vertices[vi++]=ry; vertices[vi++]=rz;
    vertices[vi++]=-B[0]; vertices[vi++]=-B[1]; vertices[vi++]=-B[2];
    vertices[vi++]=uB; vertices[vi++]=v1;
    vertices[vi++]=-T[0]; vertices[vi++]=-T[1]; vertices[vi++]=-T[2]; vertices[vi++]=1.0;
  }

  // Indices: for each pair of samples build 2 front tris + 2 back tris
  // Vertex layout at sample i: 4i+0=FL, 4i+1=FR, 4i+2=BL, 4i+3=BR
  let ii = 0;
  for (let i = 0; i < totalSamples - 1; i++) {
    const a = i * 4, b = (i + 1) * 4;
    // Front face (CCW from +B). Omitted in 'back' mode.
    if (sideMode !== 'back') {
      indices[ii++]=a+0; indices[ii++]=a+1; indices[ii++]=b+0;
      indices[ii++]=a+1; indices[ii++]=b+1; indices[ii++]=b+0;
    }
    // Back face (CCW from -B, reversed winding). Omitted in 'front' mode.
    if (sideMode !== 'front') {
      indices[ii++]=a+2; indices[ii++]=b+2; indices[ii++]=a+3;
      indices[ii++]=a+3; indices[ii++]=b+2; indices[ii++]=b+3;
    }
  }

  return { vertices, indices, format: '12float' };
}

// ── Compute Tangents (for custom/imported geometry) ───────────────

/**
 * Takes existing 8-float-per-vertex geometry (pos + normal + uv) and returns
 * a new 12-float-per-vertex MeshGeometry with computed tangents appended.
 *
 * Uses the standard Mikktspace-compatible method:
 *  - Per-triangle tangent/bitangent from UV edge deltas
 *  - Accumulate and average per vertex
 *  - Gram-Schmidt re-orthogonalize against normal
 *  - Compute handedness from bitangent direction
 */
export function computeTangents(geom8: MeshGeometry): MeshGeometry {
  const v8 = geom8.vertices;
  const idx = geom8.indices;
  const stride8 = 8;
  const vertCount = v8.length / stride8;

  const tanSums = new Float32Array(vertCount * 3);
  const biTanSums = new Float32Array(vertCount * 3);

  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];

    const p0x = v8[i0 * 8],     p0y = v8[i0 * 8 + 1], p0z = v8[i0 * 8 + 2];
    const p1x = v8[i1 * 8],     p1y = v8[i1 * 8 + 1], p1z = v8[i1 * 8 + 2];
    const p2x = v8[i2 * 8],     p2y = v8[i2 * 8 + 1], p2z = v8[i2 * 8 + 2];
    const uv0u = v8[i0 * 8 + 6], uv0v = v8[i0 * 8 + 7];
    const uv1u = v8[i1 * 8 + 6], uv1v = v8[i1 * 8 + 7];
    const uv2u = v8[i2 * 8 + 6], uv2v = v8[i2 * 8 + 7];

    const e1x = p1x - p0x, e1y = p1y - p0y, e1z = p1z - p0z;
    const e2x = p2x - p0x, e2y = p2y - p0y, e2z = p2z - p0z;
    const du1 = uv1u - uv0u, dv1 = uv1v - uv0v;
    const du2 = uv2u - uv0u, dv2 = uv2v - uv0v;

    const det = du1 * dv2 - du2 * dv1;
    const f = det !== 0 ? 1 / det : 0;

    const tx = f * (dv2 * e1x - dv1 * e2x);
    const ty = f * (dv2 * e1y - dv1 * e2y);
    const tz = f * (dv2 * e1z - dv1 * e2z);
    const bx = f * (du1 * e2x - du2 * e1x);
    const by = f * (du1 * e2y - du2 * e1y);
    const bz = f * (du1 * e2z - du2 * e1z);

    for (const vi of [i0, i1, i2]) {
      tanSums[vi * 3]     += tx;
      tanSums[vi * 3 + 1] += ty;
      tanSums[vi * 3 + 2] += tz;
      biTanSums[vi * 3]     += bx;
      biTanSums[vi * 3 + 1] += by;
      biTanSums[vi * 3 + 2] += bz;
    }
  }

  const v12 = new Float32Array(vertCount * FLOATS_PER_VERT);
  for (let vi = 0; vi < vertCount; vi++) {
    const o8 = vi * 8;
    const o12 = vi * FLOATS_PER_VERT;
    // Copy pos + normal + uv
    v12[o12]     = v8[o8];     v12[o12 + 1] = v8[o8 + 1]; v12[o12 + 2] = v8[o8 + 2];
    v12[o12 + 3] = v8[o8 + 3]; v12[o12 + 4] = v8[o8 + 4]; v12[o12 + 5] = v8[o8 + 5];
    v12[o12 + 6] = v8[o8 + 6]; v12[o12 + 7] = v8[o8 + 7];

    const nx = v8[o8 + 3], ny = v8[o8 + 4], nz = v8[o8 + 5];
    let tx = tanSums[vi * 3], ty = tanSums[vi * 3 + 1], tz = tanSums[vi * 3 + 2];
    // Gram-Schmidt orthogonalize
    const dot = nx * tx + ny * ty + nz * tz;
    tx -= nx * dot; ty -= ny * dot; tz -= nz * dot;
    const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tlen; ty /= tlen; tz /= tlen;

    // Handedness: sign of cross(N,T) · B
    const bx = biTanSums[vi * 3], by = biTanSums[vi * 3 + 1], bz = biTanSums[vi * 3 + 2];
    const crossX = ny * tz - nz * ty;
    const crossY = nz * tx - nx * tz;
    const crossZ = nx * ty - ny * tx;
    const w = (crossX * bx + crossY * by + crossZ * bz) < 0 ? -1.0 : 1.0;

    v12[o12 + 8] = tx; v12[o12 + 9] = ty; v12[o12 + 10] = tz; v12[o12 + 11] = w;
  }

  return { vertices: v12, indices: geom8.indices, format: '12float' };
}
