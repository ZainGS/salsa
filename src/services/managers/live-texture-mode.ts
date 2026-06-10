/**
 * LiveTextureMode — Zero-copy sync: raster layer GPUTexture → Mesh3D diffuse.
 *
 * Links a raster layer to a mesh's diffuse channel.  On each syncAll() call the
 * layer's current GPUTexture reference is written to mesh.diffuseTexture and
 * mesh.gpuDirty is set.  Because Renderer3D's texture bind group cache keys on
 * the GPUTexture reference, it automatically picks up the change on the next
 * draw without an explicit eviction.
 *
 * Callers must invoke syncAll() after raster strokes complete.  Sync is always
 * explicit — no internal event subscription.
 */

import type { SceneGraph } from '../../scene-graph/core/scene-graph';
import type { RasterLayerManager } from '../raster-layer-manager';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';

export class LiveTextureMode {
  /** meshId → layerId */
  private readonly _links = new Map<string, string>();

  constructor(
    private readonly sceneGraph: SceneGraph,
    private readonly getRasterLayerManager: () => RasterLayerManager | null,
  ) {}

  /**
   * Link `layerId` to `meshId` as its live diffuse texture.
   * Immediately syncs the texture so the mesh reflects it in the next frame.
   */
  link(meshId: string, layerId: string): void {
    this._links.set(meshId, layerId);
    this._sync(meshId);
  }

  /**
   * Remove the live link for `meshId` and clear its diffuse texture.
   * The mesh reverts to its base material colour.
   */
  unlink(meshId: string): void {
    const mesh = this._getMesh(meshId);
    if (mesh) {
      mesh.diffuseTexture = null;
      mesh.material.hasTexture = false;
      mesh.gpuDirty = true;
    }
    this._links.delete(meshId);
  }

  /** Sync every linked mesh from its raster layer.  Call after each stroke. */
  syncAll(): void {
    for (const meshId of this._links.keys()) this._sync(meshId);
  }

  isLinked(meshId: string): boolean { return this._links.has(meshId); }
  getLinkedLayerId(meshId: string): string | null { return this._links.get(meshId) ?? null; }

  // ── Private ───────────────────────────────────────────────────────────────

  private _sync(meshId: string): void {
    const layerId = this._links.get(meshId);
    if (!layerId) return;
    const mesh = this._getMesh(meshId);
    if (!mesh) return;
    const tex = this.getRasterLayerManager()?.getLayerTexture(layerId) ?? null;
    if (tex === mesh.diffuseTexture) return;
    mesh.diffuseTexture = tex;
    mesh.material.hasTexture = tex !== null;
    mesh.gpuDirty = true;
  }

  private _getMesh(meshId: string): Mesh3D | null {
    const node = this.sceneGraph.findNodeById(meshId);
    return node instanceof Mesh3D ? node : null;
  }
}
