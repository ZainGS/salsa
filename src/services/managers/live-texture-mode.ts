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
  /** meshId → live texture PROVIDER (the Part-1 package layer STACK: panels sample a COMPOSITE
   *  target that is not itself a raster layer). A provider link supersedes any layerId link for
   *  the same mesh; syncs resolve the provider on every call (zero-copy, ref-compared like layers). */
  private readonly _providerLinks = new Map<string, () => GPUTexture | null>();

  // ── Diagnostics (salsaPkgPaintProbe) ──────────────────────────────────────
  /** Total syncAll() calls since construction. */
  public syncAllCalls = 0;
  /** Total individual _sync() resolutions run (links × syncs + link-time syncs). */
  public syncResolutions = 0;
  /** How many syncs actually RE-POINTED a mesh at a different texture object. */
  public repoints = 0;
  /** Timestamp (ms) of the last syncAll() call. 0 = never. */
  public lastSyncAllAt = 0;

  /**
   * Fired whenever a sync RE-POINTS a mesh's diffuse texture at a DIFFERENT GPUTexture object
   * (never for content-only changes, which need no rebind). The host uses it to evict the 3D
   * renderer's per-mesh texture bind-group cache entry so the very next draw rebuilds the bind
   * group against the new texture — the cache also self-validates by texture ref, so this is
   * belt-and-braces, but it removes any window where a stale bind could be reused.
   */
  public onRepoint: ((meshId: string, tex: GPUTexture | null) => void) | null = null;

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
   * Link a live texture PROVIDER to `meshId` (the package layer-stack composite target). The
   * provider is re-resolved on every sync, so target reallocations (doc resize) self-heal exactly
   * like layer links. Supersedes any layerId link for the same mesh. Immediately syncs.
   */
  linkProvider(meshId: string, provider: () => GPUTexture | null): void {
    this._providerLinks.set(meshId, provider);
    this._sync(meshId);
  }

  /**
   * Remove the live link for `meshId` (layerId AND provider) and clear its diffuse texture.
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
    this._providerLinks.delete(meshId);
  }

  /** Remove ONLY the provider link for `meshId` — the mesh falls back to its layerId link (if any)
   *  on the same sync. Used when a package's layer stack collapses back to the single-layer path. */
  unlinkProvider(meshId: string): void {
    if (!this._providerLinks.delete(meshId)) return;
    this._sync(meshId);
  }

  /** Sync every linked mesh from its raster layer / provider.  Call after each stroke. */
  syncAll(): void {
    this.syncAllCalls++;
    this.lastSyncAllAt = Date.now();
    // Union of both link maps (a mesh may hold a layer link shadowed by a provider link).
    for (const meshId of this._links.keys()) if (!this._providerLinks.has(meshId)) this._sync(meshId);
    for (const meshId of this._providerLinks.keys()) this._sync(meshId);
  }

  isLinked(meshId: string): boolean { return this._links.has(meshId) || this._providerLinks.has(meshId); }
  isProviderLinked(meshId: string): boolean { return this._providerLinks.has(meshId); }
  getLinkedLayerId(meshId: string): string | null { return this._links.get(meshId) ?? null; }

  /**
   * DIAGNOSTIC resolve for one linked mesh (salsaPkgPaintProbe) — returns every identity in the
   * chain WITHOUT mutating anything: the linked layer id, the layer manager's live texture, the
   * reassignable `layer.texture` snapshot, and what the mesh currently samples. Null when unlinked.
   */
  debugResolve(meshId: string): {
    layerId: string;
    managerTex: GPUTexture | null;
    snapshotTex: GPUTexture | null;
    meshTex: GPUTexture | null;
    hasTexture: boolean;
  } | null {
    const mesh = this._getMesh(meshId);
    const provider = this._providerLinks.get(meshId);
    if (provider) {
      const tex = provider();
      return {
        layerId: '(composite provider)',
        managerTex: tex, snapshotTex: null,
        meshTex: mesh?.diffuseTexture ?? null,
        hasTexture: mesh?.material.hasTexture ?? false,
      };
    }
    const layerId = this._links.get(meshId);
    if (!layerId) return null;
    const layer = this.getRasterLayerManager()?.getLayerById(layerId);
    return {
      layerId,
      managerTex: layer?.manager?.getTexture?.() ?? null,
      snapshotTex: layer?.texture ?? null,
      meshTex: mesh?.diffuseTexture ?? null,
      hasTexture: mesh?.material.hasTexture ?? false,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _sync(meshId: string): void {
    this.syncResolutions++;
    const provider = this._providerLinks.get(meshId);
    const layerId = this._links.get(meshId);
    if (!provider && !layerId) return;
    const mesh = this._getMesh(meshId);
    if (!mesh) return;
    // ★Resolve through the layer MANAGER's live GPUTexture first, falling back to the layer.texture
    // snapshot field. The two are normally the same object, but `layer.texture` is a REASSIGNABLE
    // field (the timeline cel swap writes celTexture/undefined into it; it can also be momentarily
    // unset on adopted/restored layers) while the PAINT engine — pane strokes AND 3D-surface
    // strokes — always writes `manager.getTexture()`. Sampling the snapshot field let the two
    // diverge: the pane readback (manager) showed the paint while the mesh (layer.texture) sampled
    // a blank/stale texture forever — the packaging "paint never reaches the box" bug. A linked
    // layer is a PAINT SURFACE, so the manager's texture is the correct source of truth.
    // A PROVIDER link (package layer-stack composite) short-circuits the layer resolution.
    let tex: GPUTexture | null;
    if (provider) {
      tex = provider();
    } else {
      const rlm = this.getRasterLayerManager();
      const layer = rlm?.getLayerById(layerId!);
      tex = layer?.manager?.getTexture?.() ?? layer?.texture ?? null;
    }
    // Early-out only when BOTH the texture reference AND the derived flag already agree — a stale
    // hasTexture=false with the right texture bound (a null-at-link that later resolved) previously
    // hit the ref-equality early-out and never self-healed (mesh stayed on the untextured pipeline).
    if (tex === mesh.diffuseTexture && mesh.material.hasTexture === (tex !== null)) return;
    const repointed = tex !== mesh.diffuseTexture;
    mesh.diffuseTexture = tex;
    mesh.material.hasTexture = tex !== null;
    mesh.gpuDirty = true;
    if (repointed) {
      this.repoints++;
      // Tell the host so the renderer's per-mesh texture bind group is evicted immediately —
      // the next draw rebuilds it against the NEW texture object (no stale-bind window).
      this.onRepoint?.(meshId, tex);
    }
  }

  private _getMesh(meshId: string): Mesh3D | null {
    const node = this.sceneGraph.findNodeById(meshId);
    return node instanceof Mesh3D ? node : null;
  }
}
