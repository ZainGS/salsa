/**
 * Scene3DGrouping — mesh groups + the outliner surface, extracted from Scene3DManager.
 *
 * Owns the cohesive, low-coupling grouping core: create/delete a MeshGroup3D (delete lifts children to root and
 * is undoable; deleting an ArrayGroup3D deletes its whole same-direction bucket atomically), the group queries,
 * the per-node visibility / name / collapsed setters, and the outliner hierarchy snapshot (`getScene3DHierarchy`,
 * which folds each group-sourced array's N siblings into one entry per (group, direction) bucket).
 *
 * Scope note: the thin-wrapper container machinery (`_selectedThinWrapper`, transform-as-a-unit) and
 * `_expandGroupSelection` are NOT here — they are selection/gizmo concerns and go to Scene3DSelection. This
 * subsystem is GPU-free and unit-testable with a mock ctx. Scene3DManager keeps thin delegating methods so the
 * public API and every caller are unchanged.
 */

import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D, ArrayParams, getArrayInstanceCount } from '../../scene-graph/shapes/array-group-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';
import type { Scene3DHierarchyNode } from './scene3d-manager';

/** Narrow host surface — everything Scene3DGrouping needs from the parent manager beyond the shared ctx. */
export interface Scene3DGroupingHost {
  getMesh(id: string): Mesh3D | null;
  pushUndo(cmd: Command3D): void;
  /** Canonical direction key for an array's spacing (shared with Scene3DArrays) — used to bucket sibling arrays. */
  directionKey(params: ArrayParams): string;
}

export class Scene3DGrouping {
  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DGroupingHost,
  ) {}

  createMeshGroup(name = '3D Group'): MeshGroup3D {
    const g = new MeshGroup3D(this.ctx.interactionService);
    g.name = name;
    const parent = this.ctx.sceneGraph.root;
    parent.addChild(g);
    this.ctx.emitSceneGraphChanged();
    this.ctx.setSelectedNode(g.id);
    this.ctx.scheduleRender();

    this.host.pushUndo({
      description: 'Create group',
      undo: () => {
        g.parent?.removeChild(g);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        parent.addChild(g);
        this.ctx.emitSceneGraphChanged();
      },
    });

    return g;
  }

  /** Delete a mesh group (and un-parent its children to root). Pushes an undo command. */
  deleteMeshGroup(groupId: string): boolean {
    const group = this.getMeshGroup(groupId);
    if (!group) return false;

    // ArrayGroup3D: delete all bucket siblings in one atomic undo entry.
    if (group instanceof ArrayGroup3D) {
      return this._deleteArrayGroupBucket(group);
    }

    const savedParent = group.parent ?? this.ctx.sceneGraph.root;
    const children = [...group.children];

    // Lift children to root before removing the group
    for (const child of children) {
      group.removeChild(child);
      this.ctx.sceneGraph.root.addChild(child);
    }
    group.parent?.removeChild(group);
    this.ctx.emitSceneGraphChanged();
    this.ctx.scheduleRender();

    this.host.pushUndo({
      description: 'Delete group',
      undo: () => {
        // Re-adopt children and re-add group
        for (const child of children) {
          child.parent?.removeChild(child);
          group.addChild(child);
        }
        savedParent.addChild(group);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        for (const child of children) {
          group.removeChild(child);
          this.ctx.sceneGraph.root.addChild(child);
        }
        group.parent?.removeChild(group);
        this.ctx.emitSceneGraphChanged();
      },
    });

    return true;
  }

  private _deleteArrayGroupBucket(representative: ArrayGroup3D): boolean {
    const root = this.ctx.sceneGraph.root;

    // Collect all ArrayGroup3Ds in the same (parentGroup, direction) bucket.
    const source = this.host.getMesh(representative.sourceId);
    const parentGroup = source?.parent;
    let toDelete: ArrayGroup3D[];

    if (parentGroup instanceof MeshGroup3D && !(parentGroup instanceof ArrayGroup3D)) {
      const siblingIds = new Set(
        parentGroup.children
          .filter((c): c is Mesh3D => c instanceof Mesh3D)
          .map(c => c.id),
      );
      const dirKey = this.host.directionKey(representative.arrayParams);
      toDelete = (root.children as ArrayGroup3D[]).filter(
        (n): n is ArrayGroup3D =>
          n instanceof ArrayGroup3D &&
          siblingIds.has(n.sourceId) &&
          this.host.directionKey(n.arrayParams) === dirKey,
      );
    } else {
      toDelete = [representative];
    }

    for (const g of toDelete) g.parent?.removeChild(g);
    this.ctx.emitSceneGraphChanged();
    this.ctx.scheduleRender();

    this.host.pushUndo({
      description: 'Delete array',
      undo: () => {
        for (const g of toDelete) root.addChild(g);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        for (const g of toDelete) g.parent?.removeChild(g);
        this.ctx.emitSceneGraphChanged();
      },
    });

    return true;
  }

  getMeshGroup(groupId: string): MeshGroup3D | null {
    const n = this.ctx.sceneGraph.findNodeById(groupId);
    return n instanceof MeshGroup3D ? n : null;
  }

  getMeshGroups(): MeshGroup3D[] {
    const groups: MeshGroup3D[] = [];
    this.ctx.sceneGraph.root.forEachDeep?.((n: unknown) => {
      if (n instanceof MeshGroup3D) groups.push(n);
    });
    return groups;
  }

  // ── Group outliner helpers ───────────────────────────────────────

  setGroupCollapsed(groupId: string, collapsed: boolean): boolean {
    const group = this.getMeshGroup(groupId);
    if (!group) return false;
    group.collapsed = collapsed;
    this.ctx.emitSceneGraphChanged();
    return true;
  }

  isGroupCollapsed(groupId: string): boolean {
    return this.getMeshGroup(groupId)?.collapsed ?? false;
  }

  setMeshVisible(nodeId: string, visible: boolean): boolean {
    const mesh = this.host.getMesh(nodeId);
    if (!mesh) return false;
    mesh.visible = visible;
    this.ctx.scheduleRender();
    return true;
  }

  isMeshVisible(nodeId: string): boolean {
    return this.host.getMesh(nodeId)?.visible ?? true;
  }

  setGroupVisible(groupId: string, visible: boolean): boolean {
    const group = this.getMeshGroup(groupId);
    if (!group) return false;
    group.visible = visible;
    this.ctx.scheduleRender();
    return true;
  }

  isGroupVisible(groupId: string): boolean {
    return this.getMeshGroup(groupId)?.visible ?? true;
  }

  setMeshName(nodeId: string, name: string): boolean {
    const mesh = this.host.getMesh(nodeId);
    if (!mesh) return false;
    mesh.name = name;
    this.ctx.emitSceneGraphChanged();
    return true;
  }

  getMeshName(nodeId: string): string | null {
    return this.host.getMesh(nodeId)?.name ?? null;
  }

  setGroupName(groupId: string, name: string): boolean {
    const group = this.getMeshGroup(groupId);
    if (!group) return false;
    group.name = name;
    this.ctx.emitSceneGraphChanged();
    return true;
  }

  getGroupName(groupId: string): string | null {
    return this.getMeshGroup(groupId)?.name ?? null;
  }

  /** Lightweight hierarchy descriptor for ONE 3D mesh node (the same shape getScene3DHierarchy emits per mesh
   *  entry), so a host can incrementally push the nodes a new character added instead of re-scanning the whole
   *  hierarchy. Null if the id isn't a root-level mesh node. */
  getScene3DNode(nodeId: string): Scene3DHierarchyNode | null {
    const m = this.host.getMesh(nodeId);
    if (!m) return null;
    return { id: m.id, name: m.name, type: '3DMesh', visible: m.visible, locked: m.locked };
  }

  /**
   * Returns a snapshot hierarchy of 3D nodes for outliner display. Top-level entries are direct children of root
   * that are Mesh3D or MeshGroup3D. Groups include their Mesh3D children. Allocates a new array on every call —
   * cache the result and invalidate on scene-graph-changed events rather than calling this every frame.
   */
  getScene3DHierarchy(): Scene3DHierarchyNode[] {
    const result: Scene3DHierarchyNode[] = [];
    // Track which (parentGroupId:directionKey) buckets have already been emitted so sibling ArrayGroup3Ds (one
    // per group child) appear as a single outliner entry.
    const seenArrayBuckets = new Set<string>();

    for (const child of this.ctx.sceneGraph.root.children) {
      if (child instanceof Mesh3D) {
        result.push({
          id: child.id, name: child.name,
          type: '3DMesh', visible: child.visible, locked: child.locked,
        });
      } else if (child instanceof ArrayGroup3D) {
        const source = this.host.getMesh(child.sourceId);
        const parentGroup = source?.parent;
        if (parentGroup instanceof MeshGroup3D && !(parentGroup instanceof ArrayGroup3D)) {
          // This ArrayGroup3D is one of N siblings for a group-sourced array. Only emit the first one encountered
          // per (parentGroup, direction) bucket.
          const bucketKey = `${parentGroup.id}:${this.host.directionKey(child.arrayParams)}`;
          if (seenArrayBuckets.has(bucketKey)) continue;
          seenArrayBuckets.add(bucketKey);
        }
        result.push({
          id: child.id, name: child.name,
          type: '3DArrayGroup',
          visible: child.visible, locked: child.locked,
          collapsed: child.collapsed, children: [],
          instanceCount: getArrayInstanceCount(child.arrayParams),
        });
      } else if (child instanceof MeshGroup3D) {
        // Thin wrapper (City): ONE leaf item, never expanded — its children are internal world groups.
        if (child.thinWrapper) {
          result.push({
            id: child.id, name: child.name,
            type: '3DMeshGroup', visible: child.visible, locked: child.locked,
            collapsed: true, children: [], thinWrapper: true,
          });
          continue;
        }
        const groupChildren: Scene3DHierarchyNode[] = [];
        for (const gc of child.children) {
          if (gc instanceof Mesh3D) {
            groupChildren.push({
              id: gc.id, name: gc.name,
              type: '3DMesh', visible: gc.visible, locked: gc.locked,
            });
          }
        }
        result.push({
          id: child.id, name: child.name,
          type: '3DMeshGroup',
          visible: child.visible, locked: child.locked,
          collapsed: child.collapsed, children: groupChildren,
        });
      }
    }
    return result;
  }
}
