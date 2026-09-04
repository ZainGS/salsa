/**
 * Scene3DArrays — the Array-tool subsystem (GPU-instanced ArrayGroup3D), extracted from Scene3DManager.
 *
 * Owns the array-group data surface: queries (is/params/source/for-source), per-instance overrides (with undo),
 * the three array creators (linear / grid / radial), live parameter updates, and the per-frame GPU-instance sync
 * loop that feeds the renderer each visible ArrayGroup3D + (in local-orientation mode) a per-source basis so
 * radial rings orbit the source's own axis. The sync list is cached per sceneStructureVersion so a detailed city
 * doesn't pay a full tree walk every frame.
 *
 * Scope note: the two `bake*` methods (ArrayGroup → independent meshes / one welded mesh) stay on the manager for
 * now — they pull in a cluster of module-local geometry-merge helpers + selection-group state and read as a later
 * `Scene3DArrayBake` step, same call made for GLTF import / texture upload. The manager keeps a private
 * `_getArrayGroup` delegator so bake and the gizmo drag are unchanged.
 *
 * Dependencies beyond the shared ctx are a narrow host: resolve a mesh, push undo, and read the transform gizmo's
 * orientation mode (a tangle field, shimmed until Scene3DArmature is extracted). Renderer access goes through ctx.
 * Scene3DManager keeps thin delegating methods so the public API and every caller are unchanged.
 */

import { ArrayGroup3D, ArrayParams, LinearArrayParams, GridArrayParams, RadialArrayParams, LocalBasis3, InstanceOverride } from '../../scene-graph/shapes/array-group-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

/** Narrow host surface — everything Scene3DArrays needs from the parent manager beyond the shared ctx. */
export interface Scene3DArraysHost {
  getMesh(id: string): Mesh3D | null;
  pushUndo(cmd: Command3D): void;
  /** The transform gizmo's orientation mode ('local' makes radial rings orbit the source's own axis). Null when
   *  no transform controller is active. Shimmed until the armature/gizmo tangle is extracted. */
  getTransformOrientationMode(): string | null;
}

export class Scene3DArrays {
  private _agCache: ArrayGroup3D[] | null = null;   // ArrayGroup list per structure version (see ensureSync)
  private _agCacheVer = -1;
  private _syncCb: (() => boolean) | null = null;

  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DArraysHost,
  ) {}

  private get _renderer3D() { return this.ctx.webgpuRenderer.getRenderer3D(); }

  getGroup(groupId: string): ArrayGroup3D | null {
    const n = this.ctx.sceneGraph.findNodeById(groupId);
    return n instanceof ArrayGroup3D ? n : null;
  }

  isArrayGroup3D(nodeId: string): boolean {
    return this.ctx.sceneGraph.findNodeById(nodeId) instanceof ArrayGroup3D;
  }

  getArrayParams3D(groupId: string): ArrayParams | null {
    const n = this.ctx.sceneGraph.findNodeById(groupId);
    return n instanceof ArrayGroup3D ? n.arrayParams : null;
  }

  getArraySourceId(groupId: string): string | null {
    const n = this.ctx.sceneGraph.findNodeById(groupId);
    return n instanceof ArrayGroup3D ? n.sourceId : null;
  }

  /** Return the IDs of all ArrayGroup3D nodes that use `sourceId` as their source mesh. */
  getArrayGroupsForSource(sourceId: string): string[] {
    return (this.ctx.sceneGraph.root.children as unknown[])
      .filter((n): n is ArrayGroup3D => n instanceof ArrayGroup3D && n.sourceId === sourceId)
      .map(g => g.id);
  }

  /** Set a per-instance override for one slot in an array group. Pushes an undo entry. */
  setInstanceOverride(groupId: string, instanceIndex: number, override: InstanceOverride): void {
    const group = this.getGroup(groupId);
    if (!group) return;
    if (!group.instanceOverrides) group.instanceOverrides = new Map();
    const prev = group.instanceOverrides.get(instanceIndex);
    const next = { ...override };
    group.instanceOverrides.set(instanceIndex, next);
    this._renderer3D.markInstancesDirty();
    this.ctx.scheduleRender();
    this.host.pushUndo({
      description: 'Set instance override',
      undo: () => {
        const g = this.getGroup(groupId);
        if (!g) return;
        if (prev === undefined) g.instanceOverrides?.delete(instanceIndex);
        else { if (!g.instanceOverrides) g.instanceOverrides = new Map(); g.instanceOverrides.set(instanceIndex, prev); }
        this._renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
      },
      redo: () => {
        const g = this.getGroup(groupId);
        if (!g) return;
        if (!g.instanceOverrides) g.instanceOverrides = new Map();
        g.instanceOverrides.set(instanceIndex, next);
        this._renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
      },
    });
  }

  /** Remove a per-instance override, restoring the instance to source defaults. Pushes an undo entry. */
  clearInstanceOverride(groupId: string, instanceIndex: number): void {
    const group = this.getGroup(groupId);
    if (!group?.instanceOverrides?.has(instanceIndex)) return;
    const prev = group.instanceOverrides.get(instanceIndex)!;
    group.instanceOverrides.delete(instanceIndex);
    this._renderer3D.markInstancesDirty();
    this.ctx.scheduleRender();
    this.host.pushUndo({
      description: 'Clear instance override',
      undo: () => {
        const g = this.getGroup(groupId);
        if (!g) return;
        if (!g.instanceOverrides) g.instanceOverrides = new Map();
        g.instanceOverrides.set(instanceIndex, prev);
        this._renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
      },
      redo: () => {
        const g = this.getGroup(groupId);
        if (g) { g.instanceOverrides?.delete(instanceIndex); this._renderer3D.markInstancesDirty(); this.ctx.scheduleRender(); }
      },
    });
  }

  /** Return all instance overrides for an array group as a plain array for UI consumption. */
  getInstanceOverrides(groupId: string): Array<{ index: number; override: InstanceOverride }> {
    const group = this.getGroup(groupId);
    if (!group?.instanceOverrides) return [];
    return [...group.instanceOverrides.entries()].map(([index, override]) => ({ index, override }));
  }

  /**
   * Returns all ArrayGroup3D nodes whose source meshes are siblings in the same MeshGroup3D as the source of the
   * given ArrayGroup3D. When the source is not inside a MeshGroup3D, returns just the one group (the common
   * single-mesh case). When a sibling source has multiple arrays (different directions), only the array whose
   * direction matches the reference group's direction is included — so a spacing drag can't corrupt arrays created
   * in other directions on the same source.
   */
  getGroupSiblingArrays(groupId: string): ArrayGroup3D[] {
    const group = this.getGroup(groupId);
    if (!group) return [];
    const source = this.host.getMesh(group.sourceId);
    if (!source || !(source.parent instanceof MeshGroup3D) || source.parent instanceof ArrayGroup3D) {
      return [group];
    }
    const siblingIds = new Set(
      source.parent.children.filter((c): c is Mesh3D => c instanceof Mesh3D).map(c => c.id)
    );

    // Collect candidates grouped by source mesh ID.
    const bySrc = new Map<string, ArrayGroup3D[]>();
    for (const node of this.ctx.sceneGraph.root.children) {
      if (!(node instanceof ArrayGroup3D) || !siblingIds.has(node.sourceId)) continue;
      let list = bySrc.get(node.sourceId);
      if (!list) { list = []; bySrc.set(node.sourceId, list); }
      list.push(node);
    }

    // For each sibling source pick the array that matches the reference group's direction. When only one array
    // exists for that source the match is trivial (no filtering needed).
    const refDir = this.directionKey(group.arrayParams);
    const result: ArrayGroup3D[] = [];
    for (const candidates of bySrc.values()) {
      if (candidates.length === 1) {
        result.push(candidates[0]);
      } else {
        const match = candidates.find(c => this.directionKey(c.arrayParams) === refDir);
        if (match) result.push(match);
      }
    }
    return result;
  }

  /** Canonical direction key for an array's primary spacing vector (used for same-direction matching). */
  directionKey(params: ArrayParams): string {
    if (params.mode === 'radial') return `radial:${params.axis}`;
    if (params.mode === 'grid')   return `grid:${this._dominantAxis(params.spacingX)}`;
    if (params.mode === 'explicit') return 'explicit';
    return `linear:${this._dominantAxis(params.spacing)}`;
  }

  /** Returns the dominant-axis token (+x/-x/+y/-y/+z/-z) for a 3-vector. */
  private _dominantAxis(v: [number, number, number]): string {
    const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
    if (ax >= ay && ax >= az) return v[0] >= 0 ? '+x' : '-x';
    if (ay >= ax && ay >= az) return v[1] >= 0 ? '+y' : '-y';
    return v[2] >= 0 ? '+z' : '-z';
  }

  /**
   * Create a linear array from an existing mesh. The source mesh stays in place; only generated copies are added
   * to the ArrayGroup3D.
   */
  createLinearArray3D(sourceId: string, count = 3, spacing?: [number, number, number]): ArrayGroup3D {
    const source = this.host.getMesh(sourceId);
    if (!source) throw new Error(`createLinearArray3D: mesh ${sourceId} not found`);

    let defaultSpacing: [number, number, number] = [2, 0, 0];
    const worldCorners = source.obbCorners;
    if (worldCorners) {
      let minX = Infinity, maxX = -Infinity;
      for (const [wx] of worldCorners) {
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
      }
      defaultSpacing = [Math.max(0.5, (maxX - minX) * 1.1), 0, 0];
    }
    const actualSpacing = spacing ?? defaultSpacing;

    const params: LinearArrayParams = { mode: 'linear', countX: count, spacing: actualSpacing };
    return this._addArrayGroup(source, params, 'Create array');
  }

  /**
   * Create a grid (NxM) array from an existing mesh. The source stays in place; only generated copies belong to
   * the ArrayGroup3D.
   */
  createGridArray3D(sourceId: string, countX = 2, spacingX?: [number, number, number], countY = 2, spacingY?: [number, number, number], diagonalOnly = false): ArrayGroup3D {
    const source = this.host.getMesh(sourceId);
    if (!source) throw new Error(`createGridArray3D: mesh ${sourceId} not found`);

    let defX: [number, number, number] = [2, 0, 0];
    let defY: [number, number, number] = [0, 0, 2];
    const corners = source.obbCorners;
    if (corners) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [wx, , wz] of corners) {
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
      defX = [Math.max(0.5, (maxX - minX) * 1.1), 0, 0];
      defY = [0, 0, Math.max(0.5, (maxZ - minZ) * 1.1)];
    }
    const actualSpacingX = spacingX ?? defX;
    const actualSpacingY = spacingY ?? defY;

    const params: GridArrayParams = { mode: 'grid', countX, spacingX: actualSpacingX, countY, spacingY: actualSpacingY, diagonalOnly };
    return this._addArrayGroup(source, params, 'Create grid array');
  }

  /**
   * Create a radial array from an existing mesh. The source stays at its current position; `count` ring copies
   * are placed around it.
   */
  createRadialArray3D(sourceId: string, count = 6, radius?: number, axis: 'x' | 'y' | 'z' = 'y', arcDeg = 360): ArrayGroup3D {
    const source = this.host.getMesh(sourceId);
    if (!source) throw new Error(`createRadialArray3D: mesh ${sourceId} not found`);

    let actualRadius = radius ?? 3;
    if (radius === undefined) {
      const corners = source.obbCorners;
      if (corners) {
        let maxR = 0;
        for (const [wx, wy, wz] of corners) {
          const d = Math.sqrt(wx*wx + wy*wy + wz*wz);
          if (d > maxR) maxR = d;
        }
        actualRadius = Math.max(1, maxR * 1.5);
      }
    }

    // Ring is centered at the source's current position.
    const center: [number, number, number] = [source.x, source.y, source.z];

    const params: RadialArrayParams = { mode: 'radial', count, radius: actualRadius, axis, arcDeg, center };
    return this._addArrayGroup(source, params, 'Create radial array');
  }

  /** Shared create tail: parent a new ArrayGroup3D under the scene root, select the source, push undo, ensure the
   *  sync loop is live. All three creators produce identical graph/undo behaviour, differing only in params. */
  private _addArrayGroup(source: Mesh3D, params: ArrayParams, description: string): ArrayGroup3D {
    const group = new ArrayGroup3D(this.ctx.interactionService, source.id, params);

    const root = this.ctx.sceneGraph.root;
    root.addChild(group);

    this._renderer3D.setSelectedMeshIds(new Set([source.id]));
    this.ctx.emitSceneGraphChanged();
    this.ctx.setSelectedNode(group.id);
    this.ctx.scheduleRender();

    this.host.pushUndo({
      description,
      undo: () => {
        root.removeChild(group);
        this._renderer3D.setSelectedMeshIds(new Set([source.id]));
        this.ctx.setSelectedNode(source.id);
        this._renderer3D.setArrayGizmoData(null);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        root.addChild(group);
        this._renderer3D.setSelectedMeshIds(new Set([source.id]));
        this.ctx.setSelectedNode(group.id);
        this.ctx.emitSceneGraphChanged();
      },
    });

    this.ensureSync();
    return group;
  }

  /** Live-update array parameters during gizmo drag or panel change. Rebuilds copy positions and schedules a
   *  render — no undo step. */
  updateArrayParams3D(groupId: string, params: Partial<ArrayParams>): void {
    const group = this.getGroup(groupId);
    if (!group) return;
    Object.assign(group.arrayParams, params);
    // Renderer recomputes instance transforms from updated params on next frame.
    this._renderer3D.markInstancesDirty();
    this.ctx.emitSceneGraphChanged();
    this.ctx.scheduleRender();
  }

  /** Ensure the GPU instance sync callback is active (call after ArrayGroup3D nodes are created or restored). */
  registerRestored(): void { this.ensureSync(); }

  /** Register the per-frame pre-render callback that passes current array groups to the renderer so it can compute
   *  GPU instance transforms without Mesh3D copy objects. Idempotent. */
  ensureSync(): void {
    if (this._syncCb) return;
    this._syncCb = () => {
      // STRUCTURE-VERSION-CACHED: the full deep tree walk ran EVERY frame (O(all nodes) with a detailed city). Now
      // the ArrayGroup LIST is cached per sceneStructureVersion; per frame we only re-check each cached group's
      // parent-chain visibility (LOD/centre-hide flip visible WITHOUT a structure bump, so visibility must stay
      // per-frame — but that's O(groups×depth), not O(all nodes)).
      const sv = this.ctx.sceneStructureVersion();
      if (!this._agCache || this._agCacheVer !== sv) {
        this._agCacheVer = sv;
        const all: ArrayGroup3D[] = [];
        const stack = [...this.ctx.sceneGraph.root.children];
        while (stack.length) {
          const node = stack.pop()!;
          if (node instanceof ArrayGroup3D) all.push(node);
          else if (node instanceof MeshGroup3D) for (const k of node.children) stack.push(k);
        }
        this._agCache = all;
      }
      const groups: ArrayGroup3D[] = [];
      for (const g of this._agCache) {
        let vis = true;
        for (let p: { visible?: boolean; parent?: unknown } | null = g as unknown as { visible?: boolean; parent?: unknown }; p; p = (p.parent ?? null) as { visible?: boolean; parent?: unknown } | null) {
          if (p.visible === false) { vis = false; break; }   // hidden subtree (zoom-culled LOD / centre-hide)
        }
        if (vis) groups.push(g);
      }

      // When the transform gizmo is in local orientation mode, build a basis map so radial instances orbit the
      // source's own axis instead of the world axis.
      let localBases: Map<string, LocalBasis3> | undefined;
      if (this.host.getTransformOrientationMode() === 'local') {
        for (const group of groups) {
          if (group.arrayParams.mode !== 'radial') continue;
          const source = this.host.getMesh(group.sourceId);
          if (!source) continue;
          const m = source.localMatrix as Float32Array;
          const c0 = Math.hypot(m[0], m[1], m[2]) || 1;
          const c1 = Math.hypot(m[4], m[5], m[6]) || 1;
          const c2 = Math.hypot(m[8], m[9], m[10]) || 1;
          if (!localBases) localBases = new Map();
          localBases.set(group.id, {
            x: [m[0] / c0, m[1] / c0, m[2] / c0],
            y: [m[4] / c1, m[5] / c1, m[6] / c1],
            z: [m[8] / c2, m[9] / c2, m[10] / c2],
          });
        }
      }

      this._renderer3D.setArrayGroups(groups, localBases);

      // Source-link feedback: when a source mesh is selected, faintly highlight its instances.
      const selIds = this._renderer3D.getSelectedMeshIds();
      let sourceId: string | null = null;
      if (selIds.size === 1) {
        const [id] = selIds;
        if (groups.some(g => g.sourceId === id)) sourceId = id;
      }
      this._renderer3D.setSelectedSourceId(sourceId);

      return false;
    };
    this.ctx.webgpuRenderer.addPreRenderCallback(this._syncCb);
  }
}
