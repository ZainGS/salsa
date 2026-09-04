/**
 * Scene3DImport — external static-model import (GLB / glTF), extracted from Scene3DManager.
 *
 * Owns the non-skinned GLTF import path: parse a .glb/.gltf buffer, normalize + center the baked geometry to a
 * sensible size, create one Mesh3D per node (single mesh inline, multiple under one MeshGroup3D), upload any
 * embedded diffuse/normal textures, apply morph targets, retain the raw buffer in the model store for save, and
 * push a single undoable command. OBJ import lives in Scene3DPrimitives; SKINNED GLTF import (skeleton +
 * SkinnedMesh3D) stays on the manager with the armature/character code.
 *
 * This is GPU-coupled (texture upload) so it's browser-verified rather than unit-tested. Dependencies beyond the
 * shared ctx are a narrow host: the model store (shared with character/kitbash — kept on the manager), undo,
 * morph-target application (Scene3DBlendShapes), the shared texture-lifetime guard (Scene3DTextures), and the two
 * illustration-viewport hooks. Scene3DManager keeps thin delegating methods so the public API is unchanged.
 */

import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { Material3D } from '../../renderer/3d/material-3d';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import { parseGLB, parseGLTF, GltfMeshResult } from '../../renderer/3d/gltf-importer';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

/** Narrow host surface — everything Scene3DImport needs from the parent manager beyond the shared ctx. */
export interface Scene3DImportHost {
  getModelStore(): Map<string, ArrayBuffer>;
  pushUndo(cmd: Command3D): void;
  applyMorphTargets(mesh: Mesh3D, targets: GltfMeshResult['morphTargets']): void;
  destroyTextureIfUnshared(tex: GPUTexture | null | undefined, exceptMeshId?: string): void;
  isIllustrationSync(): boolean;
  applyIllustrationCamera(): void;
}

export class Scene3DImport {
  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DImportHost,
  ) {}

  private get _renderer3D() { return this.ctx.webgpuRenderer.getRenderer3D(); }

  /**
   * Parse a GLB ArrayBuffer and create one Mesh3D per node in the scene. Node positions, rotations, and scales
   * from the GLTF hierarchy are applied relative to the given (x, y, z) origin. The raw buffer is retained in the
   * model store so the scene can be serialized.
   */
  async importGltfBuffer(x: number, y: number, z: number, buffer: ArrayBuffer, material?: Partial<Material3D>, groupName?: string): Promise<Mesh3D[]> {
    const results = await parseGLB(buffer);
    return this._createMeshesFromGltf(x, y, z, results, material, buffer, groupName);
  }

  /** Read a .glb/.gltf File and create one Mesh3D per node. Suitable for drag-and-drop or file-picker input. */
  async importGltfFile(x: number, y: number, z: number, file: File | Blob, material?: Partial<Material3D>): Promise<Mesh3D[]> {
    const buffer = await file.arrayBuffer();
    const name   = (file as File).name ?? '';
    const groupName = name.replace(/\.[^.]+$/, '') || '3D Group';
    if (name.endsWith('.gltf')) {
      const text    = new TextDecoder().decode(buffer);
      const results = await parseGLTF(text);
      // Pass an empty buffer for .gltf: the JSON is not a valid GLB and cannot be stored in the model store.
      // Geometry is serialized inline on save instead.
      return this._createMeshesFromGltf(x, y, z, results, material, new ArrayBuffer(0), groupName);
    }
    return this.importGltfBuffer(x, y, z, buffer, material, groupName);
  }

  private async _createMeshesFromGltf(
    ox: number, oy: number, oz: number,
    results: GltfMeshResult[],
    baseMaterial: Partial<Material3D> | undefined,
    rawBuffer: ArrayBuffer,
    groupName?: string,
  ): Promise<Mesh3D[]> {
    if (results.length === 0) return [];
    const device = this.ctx.webgpuRenderer.getDevice();
    const modelStore = this.host.getModelStore();

    // Pre-compute import scale: normalize baked world-space vertices to ~20 units and center the model at the
    // drop point.
    let geoMinX = Infinity, geoMinY = Infinity, geoMinZ = Infinity;
    let geoMaxX = -Infinity, geoMaxY = -Infinity, geoMaxZ = -Infinity;
    for (const r of results) {
      const v = r.geometry.vertices;
      for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
        if (v[i]   < geoMinX) geoMinX = v[i];   if (v[i]   > geoMaxX) geoMaxX = v[i];
        if (v[i+1] < geoMinY) geoMinY = v[i+1]; if (v[i+1] > geoMaxY) geoMaxY = v[i+1];
        if (v[i+2] < geoMinZ) geoMinZ = v[i+2]; if (v[i+2] > geoMaxZ) geoMaxZ = v[i+2];
      }
    }
    const geoSpan = Math.max(geoMaxX - geoMinX, geoMaxY - geoMinY, geoMaxZ - geoMinZ, 0.0001);
    const autoScale = 20 / geoSpan;
    // Center of the combined vertex bounds — pivot so the model center lands at the drop point.
    const geoCX = (geoMinX + geoMaxX) / 2;
    const geoCY = (geoMinY + geoMaxY) / 2;
    const geoCZ = (geoMinZ + geoMaxZ) / 2;

    // Single mesh: inline creation with a dedicated undo entry that cleans up textures and model store.
    if (results.length === 1) {
      const r = results[0];
      const mesh = new Mesh3D(
        this.ctx.interactionService,
        ox + (r.position[0] - geoCX) * autoScale,
        oy + (r.position[1] - geoCY) * autoScale,
        oz + (r.position[2] - geoCZ) * autoScale,
        { primitive: 'custom', geometry: r.geometry, material: baseMaterial },
      );
      mesh.name = r.name;
      mesh.setRotation3D(r.rotation[0], r.rotation[1], r.rotation[2]);
      // Clamp to avoid zero-scale degenerate matrices from GLTF exporters
      mesh.setScale3D(
        Math.max(r.scale[0], 1e-6) * autoScale,
        Math.max(r.scale[1], 1e-6) * autoScale,
        Math.max(r.scale[2], 1e-6) * autoScale,
      );
      if (baseMaterial?.diffuse === undefined) {
        mesh.setDiffuseColor(r.diffuseColor[0], r.diffuseColor[1], r.diffuseColor[2], r.diffuseColor[3]);
      }
      this.applyGltfTextures(mesh, r, device);
      this.host.applyMorphTargets(mesh, r.morphTargets);
      mesh.gpuDirty = true;
      mesh.glbMeshIndex = 0;
      if (rawBuffer.byteLength > 0) modelStore.set(mesh.id, rawBuffer);

      const root = this.ctx.sceneGraph.root;
      root.addChild(mesh);
      this.ctx.emitSceneGraphChanged();
      this.ctx.setSelectedNode(mesh.id);
      this._renderer3D.setSelectedMeshIds(new Set([mesh.id]));
      if (this.host.isIllustrationSync()) this.host.applyIllustrationCamera();
      this.ctx.scheduleRender();

      this.host.pushUndo({
        description: 'Import GLB',
        undo: () => {
          // Keep the GPU textures ALIVE — redo re-adds this exact mesh and must render textured (the old code
          // destroyed them here, so undo→redo showed an untextured mesh). They're freed in dispose() if this
          // command leaves the stack while the mesh is still orphaned.
          modelStore.delete(mesh.id);
          mesh.parent?.removeChild(mesh);
          this.ctx.emitSceneGraphChanged();
        },
        redo: () => {
          if (rawBuffer.byteLength > 0) modelStore.set(mesh.id, rawBuffer);
          mesh.gpuDirty = true;
          root.addChild(mesh);
          this.ctx.emitSceneGraphChanged();
        },
        dispose: () => { if (!mesh.parent) { this.host.destroyTextureIfUnshared(mesh.diffuseTexture, mesh.id); this.host.destroyTextureIfUnshared(mesh.normalMapTexture, mesh.id); } },
      });

      return [mesh];
    }

    // Multiple meshes: create all under one MeshGroup3D with a single undo entry.
    const group = new MeshGroup3D(this.ctx.interactionService);
    group.name = groupName ?? '3D Group';
    const created: Mesh3D[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const mesh = new Mesh3D(
        this.ctx.interactionService,
        ox + (r.position[0] - geoCX) * autoScale,
        oy + (r.position[1] - geoCY) * autoScale,
        oz + (r.position[2] - geoCZ) * autoScale,
        { primitive: 'custom', geometry: r.geometry, material: baseMaterial },
      );
      mesh.name = r.name;
      mesh.setRotation3D(r.rotation[0], r.rotation[1], r.rotation[2]);
      // Clamp to avoid zero-scale degenerate matrices from GLTF exporters
      mesh.setScale3D(
        Math.max(r.scale[0], 1e-6) * autoScale,
        Math.max(r.scale[1], 1e-6) * autoScale,
        Math.max(r.scale[2], 1e-6) * autoScale,
      );
      if (baseMaterial?.diffuse === undefined) {
        mesh.setDiffuseColor(r.diffuseColor[0], r.diffuseColor[1], r.diffuseColor[2], r.diffuseColor[3]);
      }
      this.applyGltfTextures(mesh, r, device);
      this.host.applyMorphTargets(mesh, r.morphTargets);
      mesh.gpuDirty = true;
      mesh.glbMeshIndex = i;
      if (rawBuffer.byteLength > 0) modelStore.set(mesh.id, rawBuffer);
      group.addChild(mesh);
      created.push(mesh);
    }

    const root = this.ctx.sceneGraph.root;
    root.addChild(group);
    this.ctx.emitSceneGraphChanged();
    this.ctx.setSelectedNode(group.id);
    this._renderer3D.setSelectedMeshIds(new Set(created.map(m => m.id)));
    if (this.host.isIllustrationSync()) this.host.applyIllustrationCamera();
    this.ctx.scheduleRender();

    this.host.pushUndo({
      description: 'Import GLB',
      undo: () => {
        // Keep textures alive for redo (see the single-mesh import); free them in dispose() when orphaned.
        for (const m of created) modelStore.delete(m.id);
        group.parent?.removeChild(group);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        root.addChild(group);
        for (const m of created) {
          if (rawBuffer.byteLength > 0) modelStore.set(m.id, rawBuffer);
          m.gpuDirty = true;
        }
        this.ctx.emitSceneGraphChanged();
      },
      dispose: () => { if (!group.parent) for (const m of created) { this.host.destroyTextureIfUnshared(m.diffuseTexture, m.id); this.host.destroyTextureIfUnshared(m.normalMapTexture, m.id); } },
    });

    return created;
  }

  applyGltfTextures(mesh: Mesh3D, r: GltfMeshResult, device: GPUDevice | null): void {
    if (r.diffuseImage && device) {
      const tex = device.createTexture({
        size: [r.diffuseImage.width, r.diffuseImage.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture({ source: r.diffuseImage }, { texture: tex }, [r.diffuseImage.width, r.diffuseImage.height]);
      mesh.diffuseTexture = tex;
      mesh.material.hasTexture = true;
    }
    if (r.normalMapImage && device) {
      const tex = device.createTexture({
        size: [r.normalMapImage.width, r.normalMapImage.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture({ source: r.normalMapImage }, { texture: tex }, [r.normalMapImage.width, r.normalMapImage.height]);
      mesh.normalMapTexture = tex;
      mesh.material.hasNormalMap = true;
      if (!mesh.diffuseTexture && device) {
        const w = device.createTexture({ size: [1,1,1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        device.queue.writeTexture({ texture: w }, new Uint8Array([255,255,255,255]), { bytesPerRow: 4 }, [1,1,1]);
        mesh.diffuseTexture = w;
        mesh.material.hasTexture = true;
      }
    }
  }
}
