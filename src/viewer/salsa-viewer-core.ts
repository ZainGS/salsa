/**
 * SalsaViewerCore — framework-free 3D + raster viewer runtime.
 *
 * Phase 1: 3D primitives + particles.
 * Phase 2: TextureLibrary textures on meshes.
 * Phase 3: GLTF mesh geometry restore.
 * Phase 4: Raster layer compositing.
 */

import { SceneGraph } from '../scene-graph/core/scene-graph';
import { Renderer3D } from '../renderer/3d/renderer-3d';
import { Camera3D } from '../renderer/3d/camera-3d';
import { RasterCompositor, LayerBlendMode, CompositorLayerInfo } from '../renderer/raster/core/raster-compositor';
import { TextureLibrary } from '../services/texture-library';
import { unpackProject } from '../services/persistence/project-package';
import { unzipSync, strFromU8 } from 'fflate';
import { parseGLB } from '../renderer/3d/gltf-importer';
import { ViewerSceneDeserializer } from './scene-deserializer';
import { Mesh3D } from '../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { ParticleEmitter3D } from '../scene-graph/shapes/particle-emitter-3d';
import { Node } from '../scene-graph/shapes/base/node';

export class SalsaViewerCore {
  private canvas: HTMLCanvasElement;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private renderer3D!: Renderer3D;
  private textureLib!: TextureLibrary;
  private compositor!: RasterCompositor;
  private sceneGraph = new SceneGraph();
  private deserializer = new ViewerSceneDeserializer();

  // Depth buffer for 3D
  private depthTex: GPUTexture | null = null;
  private depthTexW = 0;
  private depthTexH = 0;

  // Raster layer state
  private _layerTextures: Array<{ texture: GPUTexture; meta: any }> = [];
  private _rasterCompositeTex: GPUTexture | null = null;
  private _rasterW = 0;
  private _rasterH = 0;
  private _hasRaster = false;

  // Background quad pipeline (raster → screen)
  private _quadPipeline: GPURenderPipeline | null = null;
  private _quadVB: GPUBuffer | null = null;
  private _quadIB: GPUBuffer | null = null;
  private _quadSampler: GPUSampler | null = null;
  private _quadBGL: GPUBindGroupLayout | null = null;

  // Animation
  private _rafId: number | null = null;
  private _preRenderCallbacks: Array<() => boolean> = [];
  private _particleTickCb: (() => boolean) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(): Promise<boolean> {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    this.device = await adapter.requestDevice();

    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
    if (!this.context) return false;

    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });

    const cam = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0], autoNear: true });   // near tracks orbit distance (docs/specs/depth-precision.md)
    this.renderer3D = new Renderer3D(this.device, cam, this.format);
    this.textureLib = new TextureLibrary(this.device);
    this.compositor = new RasterCompositor(this.device);

    return true;
  }

  /**
   * Cheaply extract the embedded JPEG thumbnail from a .frogmarks blob without
   * fully parsing the scene. Returns null if none present.
   */
  static async peekThumbnailFromBlob(blob: Blob): Promise<string | null> {
    try {
      const buf = await blob.arrayBuffer();
      const entries = unzipSync(new Uint8Array(buf), { filter: f => f.name === 'manifest.json' });
      const raw = entries['manifest.json'];
      if (!raw) return null;
      const envelope = JSON.parse(strFromU8(raw));
      return (envelope?.document?.thumbnail as string | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async loadUrl(url: string): Promise<void> {
    const blob = await fetch(url).then(r => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      return r.blob();
    });
    await this.loadBlob(blob);
  }

  async loadBlob(blob: Blob): Promise<void> {
    const data = await unpackProject(blob);

    // ── Reset state ──────────────────────────────────────────────────
    this.sceneGraph.root.children = [];
    this._particleTickCb = null;
    this._preRenderCallbacks = [];
    this._disposeRasterLayers();
    this._hasRaster = false;

    // ── Phase 1: Scene graph from scene.json ─────────────────────────
    const sceneJson = (data.docPayload as any).sceneGraphJSON as string | null;
    if (sceneJson) {
      const parsed = JSON.parse(sceneJson);
      this.deserializer.buildSceneGraph(this.sceneGraph.root, parsed.root);
    }

    // Register particle tick if any emitters exist
    this._walkNodes(this.sceneGraph.root, node => {
      if (node instanceof ParticleEmitter3D) {
        this._ensureParticleTick();
        return false;
      }
      return true;
    });

    // ── Phase 2: TextureLibrary textures on meshes ───────────────────
    if (data.textureLibrary) {
      await this.textureLib.restoreFromJSON(data.textureLibrary);
      this._applyTextureLibraryToMeshes();
    }

    // ── Phase 3: GLTF mesh geometry ──────────────────────────────────
    if (data.nodes3d.length > 0) {
      await this._restoreGltfMeshes(data.nodes3d, data.models3d);
    }

    // ── Phase 4: Raster layers ────────────────────────────────────────
    const manifest = data.docPayload.manifest;
    const canvasW  = manifest.canvasWidth  ?? 1920;
    const canvasH  = manifest.canvasHeight ?? 1080;
    if (data.docPayload.layers && data.docPayload.layers.length > 0) {
      await this._restoreRasterLayers(data.docPayload, canvasW, canvasH);
    }

    this.scheduleRender();
  }

  resize(): void {
    const dpr = window.devicePixelRatio ?? 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width  = Math.round(rect.width  * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.scheduleRender();
  }

  scheduleRender(): void {
    if (this._rafId != null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._render();
    });
  }

  destroy(): void {
    if (this._rafId != null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._disposeRasterLayers();
    this._rasterCompositeTex?.destroy();
    this._quadVB?.destroy();
    this._quadIB?.destroy();
    this.depthTex?.destroy();
    this.compositor.destroy();
    this.textureLib.destroy();
    this.renderer3D?.destroy();
    this.device?.destroy();
  }

  // ── Phase 2: TextureLibrary ───────────────────────────────────────

  private _applyTextureLibraryToMeshes(): void {
    this._walkNodes(this.sceneGraph.root, node => {
      if (node instanceof Mesh3D) {
        if (node.textureLibraryId) {
          const tex = this.textureLib.getTexture(node.textureLibraryId);
          if (tex) {
            node.diffuseTexture = tex;
            node.material.hasTexture = true;
            node.gpuDirty = true;
          }
        }
        if (node.normalMapLibraryId) {
          const tex = this.textureLib.getTexture(node.normalMapLibraryId);
          if (tex) {
            node.normalMapTexture = tex;
            node.gpuDirty = true;
          }
        }
      }
      return true;
    });
  }

  // ── Phase 3: GLTF geometry restore ───────────────────────────────

  private async _restoreGltfMeshes(
    nodes3d: any[],
    models3d: Map<string, ArrayBuffer>,
  ): Promise<void> {
    // Build a quick lookup: node id → Mesh3D node
    const meshById = new Map<string, Mesh3D>();
    this._walkNodes(this.sceneGraph.root, node => {
      if (node instanceof Mesh3D) meshById.set((node as any).id ?? '', node);
      return true;
    });

    for (const state of nodes3d) {
      if (!state.glbMeshId) continue;
      const glbBuf = models3d.get(state.glbMeshId);
      if (!glbBuf) continue;

      const mesh = meshById.get(state.id);
      if (!mesh) continue;

      try {
        const results = await parseGLB(glbBuf);
        if (results.length === 0) continue;
        const r = results[0];
        mesh.setGeometry(r.geometry);

        // Apply embedded diffuse texture if the mesh has no library texture
        if (r.diffuseImage && !mesh.diffuseTexture) {
          const gpuTex = this.device.createTexture({
            size: [r.diffuseImage.width, r.diffuseImage.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          });
          this.device.queue.copyExternalImageToTexture(
            { source: r.diffuseImage },
            { texture: gpuTex },
            [r.diffuseImage.width, r.diffuseImage.height],
          );
          mesh.diffuseTexture = gpuTex;
          mesh.material.hasTexture = true;
          mesh.gpuDirty = true;
        }
      } catch (e) {
        console.warn('[SalsaViewer] GLTF restore failed for', state.id, e);
      }
    }
  }

  // ── Phase 4: Raster layers ────────────────────────────────────────

  private async _restoreRasterLayers(
    docPayload: any,
    canvasW: number,
    canvasH: number,
  ): Promise<void> {
    this._disposeRasterLayers();
    this._rasterW = canvasW;
    this._rasterH = canvasH;

    const manifest = docPayload.manifest;
    const layerPixels: Map<string, ArrayBuffer> = new Map(
      (docPayload.layers ?? []).map((l: any) => [l.id, l.pixelData as ArrayBuffer]),
    );

    for (const entry of (manifest.layers ?? [])) {
      // Skip non-paintable layer types (3d-scene dividers, folders, reference)
      if (entry.type === '3d-scene' || entry.type === 'folder') continue;

      const pixelData = layerPixels.get(entry.id);
      if (!pixelData || pixelData.byteLength === 0) continue;

      const tex = this.device.createTexture({
        size: [canvasW, canvasH],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
      });

      // Upload raw RGBA pixel data (bytesPerRow must be multiple of 256)
      const bytesPerRow = canvasW * 4;
      const alignedBPR = Math.ceil(bytesPerRow / 256) * 256;
      if (alignedBPR === bytesPerRow) {
        // Fast path: row size already aligned
        this.device.queue.writeTexture(
          { texture: tex },
          pixelData,
          { bytesPerRow },
          { width: canvasW, height: canvasH },
        );
      } else {
        // Slow path: pad rows to 256-byte alignment via staging buffer
        const stagingBuf = this.device.createBuffer({
          size: alignedBPR * canvasH,
          usage: GPUBufferUsage.COPY_SRC,
          mappedAtCreation: true,
        });
        const dst = new Uint8Array(stagingBuf.getMappedRange());
        const src = new Uint8Array(pixelData);
        for (let row = 0; row < canvasH; row++) {
          dst.set(src.subarray(row * bytesPerRow, (row + 1) * bytesPerRow), row * alignedBPR);
        }
        stagingBuf.unmap();
        const enc = this.device.createCommandEncoder();
        enc.copyBufferToTexture(
          { buffer: stagingBuf, bytesPerRow: alignedBPR },
          { texture: tex },
          { width: canvasW, height: canvasH },
        );
        this.device.queue.submit([enc.finish()]);
        stagingBuf.destroy();
      }

      this._layerTextures.push({ texture: tex, meta: entry });
    }

    if (this._layerTextures.length > 0) {
      this._ensureRasterCompositeTex(canvasW, canvasH);
      this._hasRaster = true;
    }
  }

  private _ensureRasterCompositeTex(w: number, h: number): void {
    if (
      this._rasterCompositeTex &&
      this._rasterCompositeTex.width === w &&
      this._rasterCompositeTex.height === h
    ) return;
    this._rasterCompositeTex?.destroy();
    this._rasterCompositeTex = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  private _compositeRasterLayers(): void {
    if (!this._hasRaster || !this._rasterCompositeTex) return;

    const layers: CompositorLayerInfo[] = this._layerTextures
      .filter(l => l.meta.visible !== false)
      .map(l => ({
        texture: l.texture,
        blendMode: (Number.isFinite(Number(l.meta.blendMode)) ? Number(l.meta.blendMode) : LayerBlendMode.Normal) as LayerBlendMode,
        opacity: l.meta.opacity ?? 1,
        clipped: l.meta.clipped ?? false,
        visible: true,
      }));

    if (layers.length > 0) {
      this.compositor.composite(layers, this._rasterCompositeTex);
    }
  }

  private _disposeRasterLayers(): void {
    for (const l of this._layerTextures) l.texture.destroy();
    this._layerTextures = [];
  }

  // ── Render ────────────────────────────────────────────────────────

  private _render(): void {
    // Pre-render callbacks (particle tick, etc.)
    this._preRenderCallbacks = this._preRenderCallbacks.filter(cb => cb());

    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return;

    // Recreate depth texture on resize
    if (!this.depthTex || this.depthTexW !== w || this.depthTexH !== h) {
      this.depthTex?.destroy();
      this.depthTex = this.device.createTexture({
        size: [w, h],
        format: 'depth24plus-stencil8',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthTexW = w;
      this.depthTexH = h;
    }

    // Phase 4: composite raster layers (compute — outside render pass)
    if (this._hasRaster) {
      this._compositeRasterLayers();
    }

    const swapTex = this.context.getCurrentTexture();
    const encoder = this.device.createCommandEncoder();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: swapTex.createView(),
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    });

    // Draw raster as background quad
    if (this._hasRaster && this._rasterCompositeTex) {
      this._drawRasterQuad(pass);
    }

    // Draw 3D meshes + particles
    const meshes    = this._collectMeshes();
    const particles = this._collectParticles();
    if (meshes.length > 0) this.renderer3D.drawMeshes(pass, meshes, w, h);
    if (particles.length > 0) this.renderer3D.drawParticles(pass, particles, w, h);

    pass.end();
    this.device.queue.submit([encoder.finish()]);

    if (this._preRenderCallbacks.length > 0) this.scheduleRender();
  }

  // ── Background quad pipeline ──────────────────────────────────────

  private _drawRasterQuad(pass: GPURenderPassEncoder): void {
    if (!this._rasterCompositeTex) return;
    this._ensureQuadPipeline();

    const bg = this.device.createBindGroup({
      layout: this._quadBGL!,
      entries: [
        { binding: 0, resource: this._rasterCompositeTex.createView() },
        { binding: 1, resource: this._quadSampler! },
      ],
    });

    pass.setPipeline(this._quadPipeline!);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._quadVB!);
    pass.setIndexBuffer(this._quadIB!, 'uint16');
    pass.drawIndexed(6);
  }

  private _ensureQuadPipeline(): void {
    if (this._quadPipeline) return;

    // pos.xy (NDC) + uv.xy — interleaved, 16 bytes/vertex
    const verts = new Float32Array([
    //   x,   y,   u,   v
      -1.0, -1.0,  0.0,  1.0,
       1.0, -1.0,  1.0,  1.0,
       1.0,  1.0,  1.0,  0.0,
      -1.0,  1.0,  0.0,  0.0,
    ]);
    this._quadVB = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this._quadVB, 0, verts);

    const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this._quadIB = this.device.createBuffer({
      size: idx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this._quadIB, 0, idx);

    this._quadSampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
    });

    const code = /* wgsl */`
      struct V { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
      @vertex fn vs(@location(0) xy: vec2<f32>, @location(1) uv: vec2<f32>) -> V {
        return V(vec4<f32>(xy, 0.999, 1.0), uv);
      }
      @group(0) @binding(0) var tex: texture_2d<f32>;
      @group(0) @binding(1) var samp: sampler;
      @fragment fn fs(v: V) -> @location(0) vec4<f32> {
        return textureSample(tex, samp, v.uv);
      }
    `;
    const mod = this.device.createShaderModule({ code });

    this._quadBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    this._quadPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._quadBGL] }),
      vertex: {
        module: mod, entryPoint: 'vs',
        buffers: [{
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
          ],
        }],
      },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: this.format }] },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private _collectMeshes(): Mesh3D[] {
    const out: Mesh3D[] = [];
    this._walkNodes(this.sceneGraph.root, node => {
      if (node instanceof MeshGroup3D) return true;
      if (node instanceof Mesh3D && node.visible) out.push(node);
      return true;
    });
    return out;
  }

  private _collectParticles(): ParticleEmitter3D[] {
    const out: ParticleEmitter3D[] = [];
    this._walkNodes(this.sceneGraph.root, node => {
      if (node instanceof ParticleEmitter3D && node.visible) out.push(node);
      return true;
    });
    return out;
  }

  private _ensureParticleTick(): void {
    if (this._particleTickCb) return;
    let lastTime = performance.now();
    this._particleTickCb = () => {
      const now = performance.now();
      const dt  = Math.min((now - lastTime) / 1000, 0.1);
      lastTime  = now;
      this._walkNodes(this.sceneGraph.root, node => {
        if (node instanceof ParticleEmitter3D) node.tick(dt);
        return true;
      });
      this.scheduleRender();
      return true;
    };
    this._preRenderCallbacks.push(this._particleTickCb);
  }

  private _walkNodes(node: Node, visitor: (n: Node) => boolean): void {
    for (const child of node.children) {
      if (visitor(child)) this._walkNodes(child, visitor);
    }
  }
}
