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

  public override toJSON(): any {
    return { ...super.toJSON(), collapsed: this.collapsed };
  }

  /**
   * Mesh3D children return empty world-space bounding polygons (they are culled by the
   * 3D camera, not the 2D viewport). The base Group.recalculateSize() would see no
   * points, compute NaN as the world centre, and corrupt every child's x/y to NaN.
   */
  public override recalculateSize(): void {}
}
