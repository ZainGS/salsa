import { MeshGroup3D } from './mesh-group-3d';
import { InteractionService } from '../../services/interaction-service';

/** Per-copy randomization applied on top of computed array positions. Seed-based, fully deterministic. */
export interface RandomizeParams {
  seed: number;
  /** Maximum position jitter per axis in world units (signed random applied in ±amp range). */
  positionAmp: [number, number, number];
  /** Maximum extra rotation per axis in degrees. */
  rotationAmp: [number, number, number];
  /** Maximum scale deviation: 0 = none, 0.5 = ±50%, 1.0 = 0–200%. */
  scaleAmp: number;
}

export interface LinearArrayParams {
  mode: 'linear';
  countX: number;
  spacing: [number, number, number];
  /** 'absolute' = world units (default); 'relative' = multiples of source AABB size per axis. */
  spacingMode?: 'absolute' | 'relative';
  randomize?: RandomizeParams;
  /**
   * ID of a scene mesh that defines the per-step transform increment.
   * Each copy i gets (D^i × srcMatrix) where D = offsetMesh.localMatrix × inv(srcMatrix).
   * When set, `spacing` and `spacingMode` are ignored.
   */
  objectOffsetId?: string;
  /** When true, bakeArrayMerged3D inserts oriented bridge boxes between copies to close inter-copy gaps. */
  gapFill?: boolean;
  /** Vertex weld distance threshold (world units) used by bakeArrayMerged3D. Default 0.001. */
  weldThreshold?: number;
}

export interface GridArrayParams {
  mode: 'grid';
  countX: number;
  spacingX: [number, number, number];
  countY: number;
  spacingY: [number, number, number];
  /** When true, both axes start at 1 — axis-aligned rows are excluded (diagonal handle mode). */
  diagonalOnly?: boolean;
  /** 'absolute' = world units (default); 'relative' = multiples of source AABB size per axis. */
  spacingMode?: 'absolute' | 'relative';
  randomize?: RandomizeParams;
}

export interface RadialArrayParams {
  mode: 'radial';
  /** Number of ring copies (source is not counted). */
  count: number;
  radius: number;
  axis: 'x' | 'y' | 'z';
  /** Arc angle in degrees. 360 = full ring. */
  arcDeg: number;
  /** World-space center of the ring, fixed at creation time. */
  center: [number, number, number];
}

/**
 * EXPLICIT array: an arbitrary list of per-instance positions (not a linear/grid/radial pattern). The source
 * geometry sits at the origin; each instance is placed at its `offset` and yawed by the matching `instanceOverrides`
 * rotation. This is the vehicle for PROCEDURAL instancing (e.g. a Block's juliet balconies across many buildings —
 * one canonical geometry + N arbitrary window transforms → one node, one instanced draw). `offsets` are absolute
 * positions; `computeArrayOffsets` makes them source-relative like the other modes.
 */
export interface ExplicitArrayParams {
  mode: 'explicit';
  offsets: [number, number, number][];
}

export type ArrayParams = LinearArrayParams | GridArrayParams | RadialArrayParams | ExplicitArrayParams;

/**
 * Per-instance transform override for a single slot in an ArrayGroup3D.
 * All fields are optional — omitting a field leaves that aspect unchanged from the source.
 */
export interface InstanceOverride {
  /** Additional local-space rotation applied on top of the source rotation, in degrees (XYZ Euler). */
  rotationEulerDeg?: [number, number, number];
  /** Per-axis scale multiplier. [1, 1, 1] = no change; [2, 1, 1] = double width. */
  scale?: [number, number, number];
  /** Set to false to skip rendering this instance (zero-scale trick, no geometry drawn). */
  visible?: boolean;
}

/** Three orthonormal columns representing a mesh's local orientation in world space. */
export interface LocalBasis3 {
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
}

/**
 * ArrayGroup3D — scene-graph container for a parametric repeat array.
 *
 * The source mesh lives externally in the scene root (referenced by sourceId).
 * All children are copies that share the source's geometry pool slot via
 * geometryKeyOverride = "array-src:{sourceId}". Source is never a child.
 */
export class ArrayGroup3D extends MeshGroup3D {
  readonly sourceId: string;
  arrayParams: ArrayParams;
  /** Per-instance transform overrides. Key = 0-based instance index (source not counted). */
  instanceOverrides?: Map<number, InstanceOverride>;

  constructor(interactionService: InteractionService, sourceId: string, params: ArrayParams) {
    super(interactionService);
    this.sourceId = sourceId;
    this.arrayParams = { ...params };
    this._name = 'Repeat';
  }

  override getType(): string {
    return '3DArrayGroup';
  }

  override toJSON(): any {
    return {
      ...super.toJSON(),
      type: '3DArrayGroup',
      sourceId: this.sourceId,
      arrayParams: this.arrayParams,
      ...(this.instanceOverrides?.size
        ? { instanceOverrides: [...this.instanceOverrides.entries()] }
        : {}),
    };
  }
}

/**
 * Compute per-instance position offsets (dx, dy, dz) relative to source world position.
 * Source position is needed only for radial mode (ring is centered at a fixed world point).
 *
 * @param localBasis  Optional local orientation for radial mode. When provided, the ring
 *                    is spanned by the mesh's local axes instead of the world axes, so the
 *                    array orbits around the source's own axis rather than a world axis.
 */
export function computeArrayOffsets(
  params: ArrayParams,
  sourcePos: [number, number, number],
  localBasis?: LocalBasis3,
): Array<[number, number, number]> {
  const offsets: Array<[number, number, number]> = [];

  if (params.mode === 'explicit') {
    for (const o of params.offsets) {
      offsets.push([o[0] - sourcePos[0], o[1] - sourcePos[1], o[2] - sourcePos[2]]);   // source-relative, like radial
    }
  } else if (params.mode === 'linear') {
    for (let i = 1; i <= params.countX; i++) {
      offsets.push([i * params.spacing[0], i * params.spacing[1], i * params.spacing[2]]);
    }
  } else if (params.mode === 'grid') {
    const { countX, spacingX, countY, spacingY, diagonalOnly } = params;
    const startI = diagonalOnly ? 1 : 0;
    for (let iy = startI; iy <= countY; iy++) {
      for (let ix = startI; ix <= countX; ix++) {
        if (ix === 0 && iy === 0) continue;
        offsets.push([
          ix * spacingX[0] + iy * spacingY[0],
          ix * spacingX[1] + iy * spacingY[1],
          ix * spacingX[2] + iy * spacingY[2],
        ]);
      }
    }
  } else if (params.mode === 'radial') {
    const { count, radius, axis, arcDeg, center } = params;
    const angleStep = count > 0 ? arcDeg / count : 0;

    // The ring lies in the plane spanned by tangent (t) and bitangent (bt).
    // World mode: use fixed world axes. Local mode: use the mesh's local axes.
    let t: [number, number, number];
    let bt: [number, number, number];
    if (localBasis) {
      if (axis === 'y')      { t = localBasis.x; bt = localBasis.z; }
      else if (axis === 'x') { t = localBasis.y; bt = localBasis.z; }
      else                   { t = localBasis.x; bt = localBasis.y; }
    } else {
      if (axis === 'y')      { t = [1, 0, 0]; bt = [0, 0, 1]; }
      else if (axis === 'x') { t = [0, 1, 0]; bt = [0, 0, 1]; }
      else                   { t = [1, 0, 0]; bt = [0, 1, 0]; }
    }

    for (let i = 0; i < count; i++) {
      const rad = i * angleStep * Math.PI / 180;
      const s = Math.sin(rad), c = Math.cos(rad);
      // z-axis ring: cos→tangent, sin→bitangent. x/y: sin→tangent, cos→bitangent.
      const [pa, pb] = axis === 'z' ? [c, s] : [s, c];
      const rx = radius * (pa * t[0] + pb * bt[0]);
      const ry = radius * (pa * t[1] + pb * bt[1]);
      const rz = radius * (pa * t[2] + pb * bt[2]);
      offsets.push([
        center[0] + rx - sourcePos[0],
        center[1] + ry - sourcePos[1],
        center[2] + rz - sourcePos[2],
      ]);
    }
  }

  return offsets;
}

/** Total number of array instances for a group (source mesh not counted). */
export function getArrayInstanceCount(params: ArrayParams): number {
  if (params.mode === 'explicit') return params.offsets.length;
  if (params.mode === 'linear') return params.countX;
  if (params.mode === 'radial') return params.count;
  const { countX, countY, diagonalOnly } = params;
  return diagonalOnly ? countX * countY : (countX + 1) * (countY + 1) - 1;
}

/**
 * Convert relative spacing to absolute world-unit spacing.
 * `sourceAABBSize` = [width, height, depth] of the source mesh in world space.
 * No-op if spacingMode is 'absolute' or absent.
 */
export function resolveArraySpacing(
  params: ArrayParams,
  sourceAABBSize: [number, number, number],
): ArrayParams {
  if (params.mode === 'linear' && params.spacingMode === 'relative') {
    const [sx, sy, sz] = sourceAABBSize;
    const [spx, spy, spz] = params.spacing;
    return { ...params, spacing: [spx * sx, spy * sy, spz * sz] };
  }
  if (params.mode === 'grid' && params.spacingMode === 'relative') {
    const [sx, sy, sz] = sourceAABBSize;
    const [xpx, xpy, xpz] = params.spacingX;
    const [ypx, ypy, ypz] = params.spacingY;
    return {
      ...params,
      spacingX: [xpx * sx, xpy * sy, xpz * sz],
      spacingY: [ypx * sx, ypy * sy, ypz * sz],
    };
  }
  return params;
}

/**
 * Deterministic per-instance random value in [-1, 1].
 * `seed` comes from RandomizeParams, `idx` is the instance index (0-based), `ch` is the channel (0–6).
 */
export function hashRand(seed: number, idx: number, ch: number): number {
  let h = (seed * 1664525 + idx * 22695477 + ch * 1013904223) | 0;
  h ^= h >>> 16; h ^= h << 7; h ^= h >>> 4;
  return ((h >>> 1) / 0x7fffffff) * 2 - 1;
}
