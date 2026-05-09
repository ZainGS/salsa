import { Group } from './base/group';
import { InteractionService } from '../../services/interaction-service';

/**
 * MeshGroup3D is a scene-graph container used to organize 3D meshes.
 * It does not render geometry by itself; it only transforms children.
 */
export class MeshGroup3D extends Group {
  /** Whether the group is collapsed in an outliner/hierarchy view. */
  public collapsed: boolean = false;

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
}
