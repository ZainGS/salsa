/**
 * Scene3DTextures — GPU texture + texture-library subsystem, extracted from Scene3DManager.
 *
 * Owns the diffuse/normal texture surface: upload an image to a mesh (setMeshTexture / setMeshNormalMap), the
 * shared TextureLibrary (upload once, apply by id, snapshot + restore for save/load), and the shared-texture
 * lifetime guard `destroyTextureIfUnshared` (never free a GPUTexture a sibling mesh or the library still holds).
 *
 * This is GPU-coupled (creates GPUTextures on the device), so it is browser-verified rather than unit-tested — the
 * same reason GLTF import and array bake are handled as their own steps. `_applyGltfTextures` stays on the manager
 * with GLTF import (it's import-specific); this subsystem exposes `destroyTextureIfUnshared` for import's dispose
 * paths via a kept manager delegator. Scene3DManager keeps thin delegating methods so the public API and every
 * caller are unchanged.
 */

import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { TextureLibrary } from '../texture-library';
import type { ManagerContext } from './manager-context';

/** Narrow host surface — everything Scene3DTextures needs from the parent manager beyond the shared ctx. */
export interface Scene3DTexturesHost {
  getMesh(id: string): Mesh3D | null;
  getAllMeshes(): Mesh3D[];
}

export class Scene3DTextures {
  private _textureLibrary?: TextureLibrary;

  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DTexturesHost,
  ) {}

  async setMeshTexture(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
    const mesh = this.host.getMesh(nodeId);
    if (!mesh) return false;

    const device = this.ctx.webgpuRenderer.getDevice();
    if (!device) return false;

    const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
    const texture = device.createTexture({
      size: [bitmap.width, bitmap.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture },
      [bitmap.width, bitmap.height],
    );

    this.destroyTextureIfUnshared(mesh.diffuseTexture, mesh.id);   // a duplicate may share the old texture
    mesh.diffuseTexture = texture;
    mesh.material.hasTexture = true;
    // materialDirty, NOT gpuDirty: a texture swap changes no geometry. gpuDirty here made EVERY async text-sign
    // bitmap arrival re-upload the whole geometry pool + rebuild the atlas — with ~75 signs resolving one per
    // frame after a regen, that was seconds of ~3fps. (Standalone per-mesh textures aren't in the atlas anyway;
    // the instance repack refreshes the hasTexture flag.)
    mesh.materialDirty = true;
    this.ctx.scheduleRender();
    return true;
  }

  /** Destroy a GPUTexture ONLY if no OTHER live mesh still references it as its diffuse/normal texture.
   *  `duplicateMesh` shares diffuse/normal GPUTextures by reference, so an unconditional `.destroy()` on
   *  delete/clear/swap would free a texture a sibling still renders (use-after-free). This is leak-safe too:
   *  when the LAST holder is torn down the scan finds no other holder → it's freed. O(meshes), but destroys
   *  aren't a hot path. `exceptMeshId` excludes the mesh being torn down (it may still be in the graph). */
  destroyTextureIfUnshared(tex: GPUTexture | null | undefined, exceptMeshId?: string): void {
    if (!tex) return;
    // Never destroy a LIBRARY-owned texture — the library manages its lifetime and other meshes sample it by
    // layer, so freeing it on one mesh's swap/clear/delete would break the atlas for everyone.
    if (this._textureLibrary?.ownsTexture(tex)) return;
    let shared = false;
    this.ctx.sceneGraph.root.forEachDeep((n) => {
      if (shared || !(n instanceof Mesh3D) || n.id === exceptMeshId) return;
      if (n.diffuseTexture === tex || n.normalMapTexture === tex) shared = true;
    });
    if (!shared) tex.destroy();
  }

  clearMeshTexture(nodeId: string): boolean {
    const mesh = this.host.getMesh(nodeId);
    if (!mesh) return false;
    if (mesh.diffuseTexture) {
      this.destroyTextureIfUnshared(mesh.diffuseTexture, mesh.id);   // a duplicate may share it — don't double-free
      mesh.diffuseTexture = null;
    }
    mesh.material.hasTexture = false;
    mesh.materialDirty = true;   // texture-only change (see setMeshTexture)
    this.ctx.scheduleRender();
    return true;
  }

  // ── Texture library ──────────────────────────────────────────────

  getTextureLibrary(): TextureLibrary {
    if (!this._textureLibrary) {
      const device = this.ctx.webgpuRenderer.getDevice();
      if (!device) throw new Error('Scene3DManager: WebGPU device not available');
      this._textureLibrary = new TextureLibrary(device);
    }
    return this._textureLibrary;
  }

  /** Upload a texture to the library and apply it to the given mesh. Returns the library texture ID. */
  async uploadAndApplyTexture(meshId: string, source: File | Blob | ImageBitmap, name?: string): Promise<string | null> {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return null;

    const lib = this.getTextureLibrary();
    const id  = await lib.upload(source, name);
    const tex = lib.getTexture(id);
    if (!tex) return null;

    this.destroyTextureIfUnshared(mesh.diffuseTexture, mesh.id);   // don't free a shared/library-owned old texture
    mesh.diffuseTexture = tex;
    mesh.material.hasTexture = true;
    mesh.textureLibraryId = id;
    mesh.gpuDirty = true;
    this.ctx.scheduleRender();
    return id;
  }

  /** Apply an already-uploaded library texture to a mesh by ID. */
  applyLibraryTexture(meshId: string, textureId: string): boolean {
    const mesh = this.host.getMesh(meshId);
    const tex  = this.getTextureLibrary().getTexture(textureId);
    if (!mesh || !tex) return false;
    mesh.diffuseTexture = tex;
    mesh.material.hasTexture = true;
    mesh.textureLibraryId = textureId;
    mesh.gpuDirty = true;
    this.ctx.scheduleRender();
    return true;
  }

  // ── Texture library data (for save/load) ─────────────────────────

  /** Returns a full texture library snapshot including base64 data URLs. Include this in document save payloads
   *  so textures survive reload. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTextureLibraryData(): { entries: any[] } | null {
    return this._textureLibrary?.toJSONWithData() ?? null;
  }

  /** Restore the texture library from a saved snapshot, then re-apply GPU textures to any meshes whose
   *  textureLibraryId / normalMapLibraryId matches an entry. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async restoreTextureLibraryData(data: { entries: any[] }): Promise<void> {
    const lib = this.getTextureLibrary();
    await lib.restoreFromJSON(data);
    for (const mesh of this.host.getAllMeshes()) {
      if (mesh.textureLibraryId) {
        const tex = lib.getTexture(mesh.textureLibraryId);
        if (tex) {
          mesh.diffuseTexture = tex;
          mesh.material.hasTexture = true;
          mesh.gpuDirty = true;
        }
      }
      if (mesh.normalMapLibraryId) {
        const tex = lib.getTexture(mesh.normalMapLibraryId);
        if (tex) {
          mesh.normalMapTexture = tex;
          mesh.gpuDirty = true;
        }
      }
    }
    this.ctx.scheduleRender();
  }

  // ── Normal maps ──────────────────────────────────────────────────

  /** Upload a normal map texture and apply it to the given mesh. */
  async setMeshNormalMap(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
    const mesh = this.host.getMesh(nodeId);
    if (!mesh) return false;
    const device = this.ctx.webgpuRenderer.getDevice();
    if (!device) return false;

    const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
    const texture = device.createTexture({
      size: [bitmap.width, bitmap.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);

    if (mesh.normalMapTexture) mesh.normalMapTexture.destroy();
    mesh.normalMapTexture = texture;
    mesh.material.hasNormalMap = true;

    // Normal maps require the textured pipeline path (4-binding bind group). Auto-create a white 1×1 diffuse if
    // the mesh has no diffuse texture yet.
    if (!mesh.material.hasTexture) {
      const whiteTex = device.createTexture({
        size: [1, 1, 1], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
      if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
      mesh.diffuseTexture = whiteTex;
      mesh.material.hasTexture = true;
      console.warn(`[Scene3DManager] setMeshNormalMap: mesh "${nodeId}" had no diffuse texture — auto-created 1×1 white diffuse. Assign a real diffuse texture to replace it.`);
    }

    mesh.gpuDirty = true;
    mesh.stateDirty = true;
    this.ctx.scheduleRender();
    return true;
  }

  clearMeshNormalMap(nodeId: string): boolean {
    const mesh = this.host.getMesh(nodeId);
    if (!mesh) return false;
    if (mesh.normalMapTexture) {
      mesh.normalMapTexture.destroy();
      mesh.normalMapTexture = null;
    }
    mesh.normalMapLibraryId = null;
    mesh.material.hasNormalMap = false;
    mesh.gpuDirty = true;
    mesh.stateDirty = true;
    this.ctx.scheduleRender();
    return true;
  }

  async uploadAndApplyNormalMap(meshId: string, source: File | Blob | ImageBitmap, name?: string): Promise<string | null> {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return null;
    const lib = this.getTextureLibrary();
    const id  = await lib.upload(source, name ?? 'normal_map');
    const tex = lib.getTexture(id);
    if (!tex) return null;

    if (mesh.normalMapTexture && mesh.normalMapTexture !== tex) mesh.normalMapTexture.destroy();
    mesh.normalMapTexture = tex;
    mesh.normalMapLibraryId = id;
    mesh.material.hasNormalMap = true;

    if (!mesh.material.hasTexture) {
      const device = this.ctx.webgpuRenderer.getDevice()!;
      const whiteTex = device.createTexture({
        size: [1, 1, 1], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
      if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
      mesh.diffuseTexture = whiteTex;
      mesh.material.hasTexture = true;
      console.warn(`[Scene3DManager] uploadAndApplyNormalMap: mesh "${meshId}" had no diffuse texture — auto-created 1×1 white diffuse. Assign a real diffuse texture to replace it.`);
    }

    mesh.gpuDirty = true;
    mesh.stateDirty = true;
    this.ctx.scheduleRender();
    return id;
  }
}
