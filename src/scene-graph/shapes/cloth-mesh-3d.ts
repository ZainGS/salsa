/**
 * ClothMesh3D — a 3D cloth / fabric mesh node.
 *
 * Extends Mesh3D so it participates in the same scene graph, picking,
 * gizmos, and serialization pipeline as any other 3D mesh. The extra
 * fields (clothConfig, physicsConfig, simState) survive save / reload
 * so the user can re-open the Cloth Builder modal and re-edit the cloth.
 *
 * Phase 1: flat export, no physics (ClothGeometryBuilder → geometry baked in).
 * Phase 2: ClothSimulator produces simState.positions.
 * Phase 3: ClothSolidifier extrudes thickness.
 */

import { Mesh3D } from './mesh-3d';
import { InteractionService } from '../../services/interaction-service';
import type { MeshGeometry } from '../../renderer/3d/mesh-generators';

// ── Config types ────────────────────────────────────────────────────────────

/**
 * A user-defined constraint between two arbitrary vertices.
 * restLength = 0 → full stitch (vertices pulled flush together).
 * restLength > 0 → gather (vertices pulled to a fixed distance).
 * Stored in world units; compute from flatPositions * fraction in the UI.
 */
export interface StitchConstraint {
  /** Dense vertex index A. */
  a: number;
  /** Dense vertex index B. */
  b: number;
  /** Target rest length in world units. 0 = fully stitched. */
  restLength: number;
  /**
   * Fold direction hint for fresh simulations starting from the flat rest pose.
   * 'front' — pleat curls toward the cloth's front face (+Y).
   * 'back'  — pleat curls toward the back face (-Y).
   * Has no effect when the sim continues from an existing simulated pose.
   */
  side?: 'front' | 'back';
}

/**
 * A spatial wind emitter that adds per-vertex forces during live simulation.
 * Supports sphere and box shapes, optional linear falloff, and pulsing.
 */
export interface WindZone {
  /** Unique ID (nanoid). Used for UI management. */
  id: string;
  shape: 'sphere' | 'box';
  center: [number, number, number];
  /** Sphere radius (world units). Only used when shape = 'sphere'. */
  radius?: number;
  /** Box half-extents [x, y, z] (world units). Only used when shape = 'box'. */
  halfExtents?: [number, number, number];
  /** Wind acceleration vector (world units/s²) at full strength. */
  windVec: [number, number, number];
  /** How strength falls off from center to edge. 'none' = uniform strength. */
  falloff: 'none' | 'linear';
  /**
   * Oscillation period in seconds (0 or omitted = constant).
   * Strength follows 0.5 + 0.5 * sin(2π * t / period + phase).
   */
  pulsePeriod?: number;
  /** Phase offset in radians for the pulse oscillation. Default 0. */
  pulsePhase?: number;
}

export interface ClothGridConfig {
  /** Number of quad columns. */
  cols: number;
  /** Number of quad rows. */
  rows: number;
  /** World-unit edge length of each quad cell. */
  cellSize: number;
  /**
   * Subdivision factor applied internally by the geometry builder (1 = off).
   * Each coarse cell is split into N×N fine cells, giving the simulation
   * N² more vertices per cell without changing the editor grid layout.
   * Clamped to [1, 8]. Changing this value invalidates stitches and
   * bendStiffnessMap (clear them before calling setClothConfig).
   */
  subdivisions?: number;
  /**
   * Corner rounding in cells (0 = sharp corners).
   * Build-time: cells within the quarter-circle at each corner are deactivated,
   * producing a staircase approximation. Arc-vertex insertion is a Phase 2 addition.
   */
  cornerRadius: number;
  /** Flat array [row * cols + col] — which quads are active (true = exists). */
  activeCells: boolean[];
  /**
   * Slot indices (`col + row * (cols+1)`) of pinned vertices (zero inverse-mass).
   * Slot indices are stable across activeCells changes; dense vertex indices are not.
   * Use Scene3DManager.getClothVertexSlot(meshId, col, row) to obtain a slot index.
   */
  pinnedVertices: number[];
  /**
   * User-defined vertex-to-vertex constraints (stitches, gathers, seams).
   * Indices reference dense vertex indices from the current grid layout.
   * Cleared automatically when the grid topology changes (cols/rows/activeCells).
   */
  stitches?: StitchConstraint[];
  /**
   * Per-vertex bend stiffness multiplier (0.0 = floppy, 1.0 = full stiffness).
   * Length must equal vertexCount from buildClothGeometry.
   * When omitted or shorter than vertexCount, remaining vertices default to 1.0.
   */
  bendStiffnessMap?: number[];
}

export interface ClothPhysicsConfig {
  /** Gravity magnitude (m/s²) downward. Default 9.8. */
  gravity: number;
  /** Velocity retention per integration step (0–1). Default 0.98. */
  damping: number;
  /** Number of constraint-solve iterations per step (20–60). Default 30. */
  stiffness: number;
  /** Solidification thickness (world units). 0 = surface-only cloth. */
  thickness: number;
  /** When true, wall boundary gets a half-cylinder profile (rounded hem look). */
  solidifyRounded: boolean;
  /** Optional constant wind acceleration vector (world units/s²). */
  wind?: { x: number; y: number; z: number };
}

export interface ClothSimState {
  /**
   * Post-simulation vertex positions (x,y,z per vertex, same count as geometry).
   * Stored as a plain number[] so JSON.stringify / JSON.parse work without helpers.
   */
  positions: number[];
  /** True once a simulation run has been accepted and positions are post-sim. */
  isSimulated: boolean;
  /** Which simulation preset produced these positions. */
  simulationMode: 'hang' | 'drape' | 'none';
}

export interface ClothLiveConfig {
  /** When true, cloth simulation runs every render frame via Scene3DManager.tickLiveCloths(). */
  enabled: boolean;
  /**
   * Simulation steps dispatched per render frame.
   * Managed automatically by LiveClothSimulationImpl (auto-tunes 4 → 2 after convergence).
   * Stored here for serialization; runtime reads from the live handle.
   */
  stepsPerFrame: number;
  /**
   * Spatial wind emitters evaluated per-vertex each frame.
   * Only active during live simulation (enableLiveCloth / cloth builder preview).
   */
  windZones?: WindZone[];
}

export const DEFAULT_CLOTH_LIVE: ClothLiveConfig = {
  enabled: false,
  stepsPerFrame: 4,
};

export const DEFAULT_CLOTH_GRID: ClothGridConfig = {
  cols: 8,
  rows: 10,
  cellSize: 0.1,
  cornerRadius: 0,
  activeCells: [],
  pinnedVertices: [],
};

export const DEFAULT_CLOTH_PHYSICS: ClothPhysicsConfig = {
  gravity: 9.8,
  damping: 0.98,
  stiffness: 30,
  thickness: 0,
  solidifyRounded: false,
};

// ── Node class ───────────────────────────────────────────────────────────────

export class ClothMesh3D extends Mesh3D {
  readonly clothConfig: ClothGridConfig;
  readonly physicsConfig: ClothPhysicsConfig;
  readonly simState: ClothSimState;
  readonly liveConfig: ClothLiveConfig;

  constructor(
    interactionService: InteractionService,
    x: number,
    y: number,
    z: number,
    geometry: MeshGeometry,
    clothConfig: ClothGridConfig,
    physicsConfig: ClothPhysicsConfig,
    simState: ClothSimState,
    liveConfig?: ClothLiveConfig,
  ) {
    super(interactionService, x, y, z, { geometry, material: { doubleSided: true } });
    this.clothConfig   = clothConfig;
    this.physicsConfig = physicsConfig;
    this.simState      = simState;
    this.liveConfig    = liveConfig ?? { ...DEFAULT_CLOTH_LIVE };
    this._name         = 'Cloth';
  }

  /** Replace the grid config. `clothConfig` is `readonly` to callers (it must be swapped wholesale, never mutated
   *  field-by-field), so this typed setter is the ONE sanctioned write — it lets Scene3DManager drop the
   *  `(node as any).clothConfig = …` readonly-bypass casts (§5.2). */
  setClothConfig(config: ClothGridConfig): void {
    (this as { clothConfig: ClothGridConfig }).clothConfig = config;
  }

  /** Replace the live-sim config (wind zones, enabled, …). See {@link setClothConfig} for the readonly rationale. */
  setLiveConfig(config: ClothLiveConfig): void {
    (this as { liveConfig: ClothLiveConfig }).liveConfig = config;
  }

  /** Replace the physics config. See {@link setClothConfig} for the readonly rationale. */
  setPhysicsConfig(config: ClothPhysicsConfig): void {
    (this as { physicsConfig: ClothPhysicsConfig }).physicsConfig = config;
  }

  /** Replace the simulation state (positions / isSimulated / mode). See {@link setClothConfig} for the rationale. */
  setSimState(state: ClothSimState): void {
    (this as { simState: ClothSimState }).simState = state;
  }

  override getType(): string {
    return '3DClothMesh';
  }

  override toJSON(): any {
    const base = super.toJSON();
    return {
      ...base,
      type: '3DClothMesh',
      clothConfig: {
        ...this.clothConfig,
        activeCells:      Array.from(this.clothConfig.activeCells),
        pinnedVertices:   [...this.clothConfig.pinnedVertices],
        stitches:         this.clothConfig.stitches ? [...this.clothConfig.stitches] : undefined,
        bendStiffnessMap: this.clothConfig.bendStiffnessMap ? Array.from(this.clothConfig.bendStiffnessMap) : undefined,
      },
      physicsConfig: { ...this.physicsConfig },
      simState: {
        positions:      Array.from(this.simState.positions),
        isSimulated:    this.simState.isSimulated,
        simulationMode: this.simState.simulationMode,
      },
      liveConfig: {
        ...this.liveConfig,
        windZones: this.liveConfig.windZones ? [...this.liveConfig.windZones] : undefined,
      },
    };
  }
}
