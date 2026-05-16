import { MeshGroup3D } from './mesh-group-3d';
import { InteractionService } from '../../services/interaction-service';

export interface LinearArrayParams {
  mode: 'linear';
  countX: number;
  spacing: [number, number, number];
}

export interface GridArrayParams {
  mode: 'grid';
  countX: number;
  spacingX: [number, number, number];
  countY: number;
  spacingY: [number, number, number];
  /** When true, both axes start at 1 — axis-aligned rows are excluded (diagonal handle mode). */
  diagonalOnly?: boolean;
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

export type ArrayParams = LinearArrayParams | GridArrayParams | RadialArrayParams;

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

  if (params.mode === 'linear') {
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
  if (params.mode === 'linear') return params.countX;
  if (params.mode === 'radial') return params.count;
  const { countX, countY, diagonalOnly } = params;
  return diagonalOnly ? countX * countY : (countX + 1) * (countY + 1) - 1;
}
