import { Group } from './base/group';
import { InteractionService } from '../../services/interaction-service';

/**
 * MeshGroup3D is a scene-graph container used to organize 3D meshes.
 * It does not render geometry by itself; it only transforms children.
 */
export class MeshGroup3D extends Group {
  /** Whether the group is collapsed in an outliner/hierarchy view. */
  public collapsed: boolean = false;

  /**
   * THIN WRAPPER — a container selected + transformed AS A UNIT, never expanded to its children. Selecting it
   * does NOT walk its (potentially thousands of) descendants into a selection set; the gizmo uses
   * {@link cachedBounds} and transforms write THIS node's own transform (which the scene graph composes into
   * every child via parentChainMatrix — no per-child iteration). Used for the placed City object: one outliner
   * item, O(1) select, translate/rotate as a whole.
   */
  public thinWrapper = false;
  /** Local aggregate AABB of all descendant geometry, cached at build so the gizmo/selection box sizes itself
   *  without scanning children. Combined with this node's transform for the world-space box. */
  public cachedBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null = null;

  /**
   * Group-level 3D transform tracking. These accumulate the cumulative transform
   * applied via setPosition/setScale/setRotation so that each call can compute a
   * delta and propagate it to child meshes. They are NOT serialized — children's
   * individual transforms encode the persistent state.
   */
  public groupPos3D:   [number, number, number] = [0, 0, 0];
  public groupScale3D: [number, number, number] = [1, 1, 1];
  public groupRot3D:   [number, number, number] = [0, 0, 0];

  constructor(interactionService: InteractionService) {
    super(interactionService);
    this._name = '3D Group';
  }

  public override getType(): string {
    return '3DMeshGroup';
  }

  /**
   * When true, {@link toJSON} emits a LIGHTWEIGHT marker with NO children — the subtree is PROCEDURAL (the placed
   * City), regenerable from its world params, so baking its thousands of meshes into the saved document is both
   * pure waste AND the eager `sceneGraph.toJSON()` walk over it is a periodic multi-hundred-ms AUTOSAVE FREEZE
   * (worse the more tiles). Same principle as params-only character persistence (60 MB → 96 KB).
   */
  public documentSkipChildren = false;

  /** For a {@link documentSkipChildren} procedural container (the City): the PARAMS to regenerate it from on load
   *  (seed + world params + placement transform). This — a few hundred bytes — is ALL the save needs; the actual
   *  geometry is rebuilt from it. `null` until the owner (WorldManager) stamps it. */
  public worldParams: unknown = null;

  public override toJSON(): any {
    if (this.documentSkipChildren) {
      // Match Node.toJSON's field shape (so the host parses it), minus the expensive `children.map(toJSON)`.
      // `worldParams` rides along so the procedural content can be regenerated on load (params-only persistence).
      return {
        type: this.getType(), name: this.name,
        x: this.x, y: this.y, scaleX: this.scaleX, scaleY: this.scaleY, rotation: this.rotation,
        zIndex: this.zIndex, visible: this.visible, locked: this.locked,
        collapsed: this.collapsed, proceduralContent: true, worldParams: this.worldParams, children: [],
      };
    }
    return { ...super.toJSON(), collapsed: this.collapsed };
  }

  /**
   * Mesh3D children return empty world-space bounding polygons (they are culled by the
   * 3D camera, not the 2D viewport). The base Group.recalculateSize() would see no
   * points, compute NaN as the world centre, and corrupt every child's x/y to NaN.
   */
  public override recalculateSize(): void {}

  /**
   * 8 WORLD-space corners of {@link cachedBounds} under this node's current transform, in the SAME
   * bit-indexed order as {@link import('./mesh-3d').Mesh3D.obbCorners} (bit0=X, bit1=Y, bit2=Z; 0=min, 1=max).
   * Lets the gizmo + selection box treat the thin-wrapper container exactly like a mesh — sized from cached
   * bounds, no per-child scan. `null` until bounds are cached. localMatrix is the composed WORLD matrix
   * (parentChain × local), so the box follows the container's translate/rotate for free.
   */
  public get obbCorners(): [number, number, number][] | null {
    const b = this.cachedBounds;
    if (!b) return null;
    const m = this.localMatrix;
    const out: [number, number, number][] = [];
    for (let ci = 0; ci < 8; ci++) {
      const x = ci & 1 ? b.maxX : b.minX;
      const y = ci & 2 ? b.maxY : b.minY;
      const z = ci & 4 ? b.maxZ : b.minZ;
      out.push([
        m[0] * x + m[4] * y + m[8]  * z + m[12],
        m[1] * x + m[5] * y + m[9]  * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      ]);
    }
    return out;
  }

  /** Object-space (untransformed) corners of {@link cachedBounds}, same bit-indexed order as {@link obbCorners}. */
  public get obbLocalCorners(): [number, number, number][] | null {
    const b = this.cachedBounds;
    if (!b) return null;
    const out: [number, number, number][] = [];
    for (let ci = 0; ci < 8; ci++) {
      out.push([ci & 1 ? b.maxX : b.minX, ci & 2 ? b.maxY : b.minY, ci & 4 ? b.maxZ : b.minZ]);
    }
    return out;
  }
}
