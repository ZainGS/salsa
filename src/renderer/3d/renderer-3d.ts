/**
 * Renderer3D — Draws Mesh3D nodes into an existing WebGPU render pass.
 *
 * Self-contained 3D rendering system. Does NOT own the render pass —
 * the main WebGPURenderer creates the render pass and calls Renderer3D
 * to inject 3D draw calls at the appropriate point in the frame.
 *
 * This keeps the 3D system fully decoupled: you can use it alongside
 * the 2D renderer, or standalone in a 3D-only application.
 *
 * PS1 aesthetic controls:
 *  - vertexJitter: 0–1 (vertex position snapping intensity)
 *  - snapGridSize: pixel grid resolution for jitter (e.g. 160 for PS1)
 *  - colorDepth: quantization levels (32 = 5-bit/channel, 0 = disabled)
 */

import { mat4, vec3 } from 'gl-matrix';
import { Camera3D } from './camera-3d';
import { Pipeline3D, MESH3D_VERTEX_STRIDE, SKINNED_MESH3D_VERTEX_STRIDE } from './pipeline-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { Material3D, encodeMaterialFlags } from './material-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { ArrayGroup3D, computeArrayOffsets, getArrayInstanceCount, LocalBasis3 } from '../../scene-graph/shapes/array-group-3d';
import { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';
import { GizmoRenderer, GizmoMode, GizmoAxis, ArrayGizmoData, ArrayHandleHit, FaceHandleData } from './gizmo-renderer';
import { GhostPreviewRenderer, GhostPreviewData } from './ghost-preview-renderer';
import { MeshEditOverlayRenderer, type MeshEditDrawData } from './mesh-edit-overlay-renderer';
import { FrustumCuller } from './frustum-culler';
import { OutlinePass } from './outline-pass';
import { MeshHighlightPass } from './mesh-highlight-pass';
import { BloomPass, createBloomCapturePipeline } from './bloom-pass';
import {
  PARTICLE_VERTEX_SHADER,
  PARTICLE_FRAGMENT_SHADER,
  PARTICLE_SCENE_UNIFORM_SIZE,
  PARTICLE_INSTANCE_STRIDE,
} from './shaders/particle-shaders';

export interface Light3DConfig {
  direction: [number, number, number];
  color: [number, number, number];
  intensity: number;
}

export interface PS1Config {
  /** Vertex jitter strength (0 = off, 1 = full). */
  vertexJitter: number;
  /** Snap grid size in virtual pixels (e.g. 160 for authentic PS1). 0 = off. */
  snapGridSize: number;
  /** Affine texture mapping strength (0 = perspective-correct, 1 = full affine). */
  affineStrength: number;
  /** Color quantization levels per channel (32 = 5-bit PS1, 0 = off). */
  colorDepth: number;
}

export const DEFAULT_PS1_CONFIG: PS1Config = {
  vertexJitter: 0,
  snapGridSize: 0,
  affineStrength: 0,
  colorDepth: 0,
};

/** PS1 aesthetic preset — pass to setPS1() to enable the retro look. */
export const PS1_PRESET: PS1Config = {
  vertexJitter: 0.6,
  snapGridSize: 160,
  affineStrength: 1.0,
  colorDepth: 32,
};

/** Size of the SceneUniforms struct in bytes (must match WGSL).
 * viewProjection:  mat4x4 = 64 bytes (floats  0-15)
 * cameraPosition:  vec4   = 16 bytes (floats 16-19)
 * ambientColor:    vec4   = 16 bytes (floats 20-23)
 * lightDirection:  vec4   = 16 bytes (floats 24-27)
 * lightColor:      vec4   = 16 bytes (floats 28-31)
 * ps1Config:       vec4   = 16 bytes (floats 32-35)
 * resolution:      vec4   = 16 bytes (floats 36-39)
 * lightSpaceMatrix:mat4x4 = 64 bytes (floats 40-55)
 * shadowParams:    vec4   = 16 bytes (floats 56-59)  .y=bias .z=mapSize
 * Total = 240 bytes → pad to 256 (16-byte aligned)
 */
const SCENE_UNIFORM_SIZE_PADDED = 256;

/** Size of one MeshInstance in the storage buffer (must match WGSL struct stride). */
// modelMatrix(64) + normalMatrix(64) + diffuse(16) + specular(16) + emissive(16)
// + textureIndex(4) + normalMapIndex(4) + _pad0(4) + _pad1(4) = 192 bytes
const MESH_INSTANCE_STRIDE = 192;

export class Renderer3D {
  private device: GPUDevice;
  private pipeline: Pipeline3D;
  private camera: Camera3D;

  // Scene config
  private _ambientColor: [number, number, number] = [0.15, 0.15, 0.2];
  private _ambientIntensity = 1.0;
  private _light: Light3DConfig = {
    direction: [0.3, -0.8, -0.5],
    color: [1, 1, 1],
    intensity: 1.0,
  };
  private _ps1: PS1Config = { ...DEFAULT_PS1_CONFIG };

  // GPU buffers
  private sceneUniformBuffer: GPUBuffer;
  private instanceStorageBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private meshBindGroup: GPUBindGroup | null = null;
  // Tracks which buffer the cached bind group is bound to; null = needs recreation.
  private _meshBindGroupBuffer: GPUBuffer | null = null;

  // Instance upload dirty tracking — avoid re-uploading every frame when nothing moved.
  private _instancesDirty = true;
  private _instanceCount = 0;
  private _instanceDataBuf: Float32Array | null = null;

  // Maps each mesh ID to its slot in the instance storage buffer (single-material meshes only).
  // Populated during uploadMeshInstances. Used by the draw loop so frustum-culled
  // opaque/transparent entries carry the correct buffer index for instanced draws.
  private _meshInstanceSlots = new Map<string, number>();
  // For multi-material meshes: mesh ID → array of slot indices (one per submesh).
  private _meshSubmeshSlots = new Map<string, number[]>();

  // GPU-instanced array groups: no Mesh3D copies — renderer computes transforms from params.
  private _arrayGroups: ArrayGroup3D[] = [];
  private _arrayGroupLocalBases = new Map<string, LocalBasis3>();
  // groupId → first instance buffer slot (instances are contiguous, immediately after source slot)
  private _arrayGroupFirstSlot = new Map<string, number>();
  // groupId → source localMatrixVersion at last upload (change detection for re-upload)
  private _arrayGroupSourceVers = new Map<string, number>();

  // Pre-allocated scene uniform staging buffer (256 bytes, reused every frame).
  private _sceneUniformsData = new Float32Array(SCENE_UNIFORM_SIZE_PADDED / 4);

  // Geometry pool: all mesh vertex/index data packed into two shared GPUBuffers.
  // Eliminates N×(setVertexBuffer + setIndexBuffer) state switches per frame;
  // callers use (firstIndex, baseVertex) in drawIndexed to address each mesh's slice.
  private _geomVB: GPUBuffer | null = null;
  private _geomIB: GPUBuffer | null = null;
  private _geomVBCap = 0;  // allocated byte capacity
  private _geomIBCap = 0;
  private _geomAllocs = new Map<string, { baseVertex: number; firstIndex: number; indexCount: number }>();
  private _geomPoolIds: string[] = [];  // ordered mesh IDs at last pool build (change detection)

  // Two-level world AABB cache for getMeshWorldAABB3D.
  // Local AABB (from vertex scan) is stable until geometry changes (gpuDirty).
  // World AABB is stable until the model matrix changes (localMatrixVersion).
  private _meshAABBCache = new Map<string, {
    lMinX: number; lMinY: number; lMinZ: number;
    lMaxX: number; lMaxY: number; lMaxZ: number;
    wMinX: number; wMinY: number; wMinZ: number;
    wMaxX: number; wMaxY: number; wMaxZ: number;
    matVersion: number;
  }>();

  // Per-mesh vertex buffer overrides (e.g. ClothSimulator.poseVertexBuf).
  // When present, the override is used in place of the internal vertex buffer
  // for all draw calls, while the internal buffer still provides index data.
  private _vertexBufferOverrides = new Map<string, GPUBuffer>();
  private _vcColorBuffers = new Map<string, GPUBuffer>();  // per-mesh color VBs for VC pipeline

  // Frustum culling
  private _frustumCulling = true;

  // When true, use cullMode:'none' pipelines so both faces are always visible.
  // Used by ClothPreviewRenderer; has no effect on the main canvas renderer.
  public forceDoubleSided = false;

  /**
   * Register an external vertex buffer for a mesh that replaces the internally
   * managed one for all draw calls. Pass null to revert to the internal buffer.
   * Used by live cloth simulation: ClothSimulator.poseVertexBuf (STORAGE|VERTEX)
   * is written by the pose compute pass each frame, so the renderer always draws
   * fresh cloth positions without a CPU readback roundtrip.
   */
  setVertexBufferOverride(meshId: string, buf: GPUBuffer | null): void {
    if (buf) this._vertexBufferOverrides.set(meshId, buf);
    else     this._vertexBufferOverrides.delete(meshId);
  }

  // Shadow mapping
  private _shadowsEnabled = false;
  private _shadowMapSize = 2048;
  private _shadowHalfExtent = 15;
  private _shadowBias = 0.002;
  private _shadowTexture: GPUTexture | null = null;
  private _shadowTextureView: GPUTextureView | null = null;
  private _shadowBindGroup: GPUBindGroup | null = null;
  private _shadowDirty = true;

  // Default 1×1 textures used as bind group placeholders
  private _defaultWhiteTex: GPUTexture | null = null;
  private _defaultFlatNormalTex: GPUTexture | null = null;

  // Per-mesh texture bind group cache: avoids device.createBindGroup every frame per mesh.
  // Entry invalidated when diffuse or normalMap texture reference changes.
  private _texBindGroupCache = new Map<string, { bg: GPUBindGroup; diffuse: GPUTexture | null; normal: GPUTexture | null }>();

  // Shared texture atlas: all TextureLibrary textures packed into one texture_2d_array.
  // Enables same-geometry meshes with different library textures to batch into one draw call.
  // Layer 0 = white default. Layers 1..N = library textures (same format + dimensions only).
  private _atlasTexture:        GPUTexture | null = null;
  private _normalAtlasTexture:  GPUTexture | null = null;
  private _atlasLayerMap        = new Map<string, number>(); // textureLibraryId → layer index
  private _normalAtlasLayerMap  = new Map<string, number>(); // normalMapLibraryId → layer index
  private _atlasBindGroup:      GPUBindGroup | null = null;
  private _atlasDirty = true;

  // ── Particle system ────────────────────────────────────────────────────────
  // Pipeline + buffers are created lazily on first drawParticles() call.
  private _particlePipeline:      GPURenderPipeline | null = null;
  private _particleBGL0:          GPUBindGroupLayout | null = null;
  private _particleBGL1:          GPUBindGroupLayout | null = null;
  private _particleSceneUniBuf:   GPUBuffer | null = null; // viewProj + cameraRight + cameraUp
  private _particleInstBuf:       GPUBuffer | null = null; // STORAGE compact particle data
  private _particleInstBufCap     = 0;                     // max particles the buffer can hold
  private _particleBindGroup0:    GPUBindGroup | null = null;
  private _particleTexBG:         GPUBindGroup | null = null;
  private _particleTexBGAtlas:    GPUTexture  | null = null; // atlas reference at last BG creation

  // ── Bloom pass ─────────────────────────────────────────────────────────────
  private _bloomPass:            BloomPass | null = null;
  private _bloomCapturePipeline: GPURenderPipeline | null = null;

  // ── Skinned mesh rendering ─────────────────────────────────────────────────
  // Per-mesh skinned vertex buffer (72-byte stride: standard 48 + joints + weights + pad).
  private _skinnedVBs = new Map<string, GPUBuffer>();
  // Per-mesh index buffer (uint32, mirrors geometry.indices).
  private _skinnedIBs = new Map<string, GPUBuffer>();
  // Per-mesh skin-matrix storage buffer (array<mat4x4f>, one mat per joint).
  private _skinMatBufs = new Map<string, { buf: GPUBuffer; jointCount: number }>();
  // Per-mesh skin bind group (single entry: skinMatrices storage buffer).
  private _skinBGs = new Map<string, GPUBindGroup>();
  // Separate small instance buffer for skinned meshes (one slot per skinned mesh).
  private _skinnedInstBuf: GPUBuffer | null = null;
  private _skinnedInstCap = 0;
  private _skinnedMeshBG: GPUBindGroup | null = null;
  private _skinnedMeshBGBuf: GPUBuffer | null = null;

  // Per-mesh normal matrix cache: inverse-transpose of model matrix.
  // Recomputed only when localMatrixVersion changes — avoids mat4.invert + mat4.transpose
  // for every mesh in the scene whenever any single mesh moves.
  private _normalMatCache = new Map<string, { matVersion: number; floats: Float32Array }>();

  // Gizmo rendering
  private _gizmoRenderer?: GizmoRenderer;
  private _meshEditOverlay?: MeshEditOverlayRenderer;
  private _meshEditDataFn?: () => MeshEditDrawData | null;
  private _selectedMeshIds: Set<string> = new Set();
  private _hoveredMeshIds:  Set<string> = new Set();
  private _gizmoMode: GizmoMode = 'move';
  private _hoveredAxis: GizmoAxis = null;
  private _draggingAxis: GizmoAxis = null;
  private _hoveredCorner: number | null = null;

  // Bone overlay (for selected SkinnedMesh3D)
  private _boneOverlaySkeleton: Skeleton3D | null = null;
  private _hoveredJointIdx: number | null = null;
  private _selectedJointIdx: number | null = null;

  // Array gizmo state — set by Scene3DManager when an ArrayGroup3D is selected
  private _arrayGizmoData: ArrayGizmoData | null = null;
  private _arrayHandleHovered: ArrayHandleHit = null;

  // Array Tool — ghost preview + face handles
  private _ghostPreviewRenderer: GhostPreviewRenderer | null = null;
  private _ghostPreviewData: GhostPreviewData | null = null;
  private _faceHandleData: FaceHandleData | null = null;

  // Outline pass (global screen-space Sobel)
  private _outlinePass: OutlinePass | null = null;
  // Per-mesh hover/selection highlight
  private _highlightPass: MeshHighlightPass | null = null;
  private _swapChainFormat: GPUTextureFormat;

  constructor(device: GPUDevice, camera: Camera3D, swapChainFormat: GPUTextureFormat = 'bgra8unorm') {
    this.device = device;
    this.camera = camera;
    this._swapChainFormat = swapChainFormat;
    this.pipeline = new Pipeline3D(device, swapChainFormat);
    this._highlightPass = new MeshHighlightPass(device, this.pipeline.meshBindGroupLayout, swapChainFormat);
    this._ghostPreviewRenderer = new GhostPreviewRenderer(device, swapChainFormat);

    // Create scene uniform buffer (updated every frame)
    this.sceneUniformBuffer = device.createBuffer({
      size: SCENE_UNIFORM_SIZE_PADDED,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ── Public configuration ───────────────────────────────────────

  get ps1Config(): PS1Config { return this._ps1; }
  set ps1Config(c: PS1Config) { this._ps1 = { ...c }; }

  setPS1(partial: Partial<PS1Config>): void {
    Object.assign(this._ps1, partial);
  }

  setAmbientLight(r: number, g: number, b: number, intensity = 1): void {
    this._ambientColor = [r, g, b];
    this._ambientIntensity = intensity;
  }

  setDirectionalLight(dx: number, dy: number, dz: number, r = 1, g = 1, b = 1, intensity = 1): void {
    // Normalize direction
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    this._light = {
      direction: [dx / len, dy / len, dz / len],
      color: [r, g, b],
      intensity,
    };
  }

  setCamera(camera: Camera3D): void {
    this.camera = camera;
  }

  getCamera(): Camera3D {
    return this.camera;
  }

  // ── Frustum culling toggle ─────────────────────────────────────

  get frustumCulling(): boolean { return this._frustumCulling; }
  set frustumCulling(v: boolean) { this._frustumCulling = v; }

  // ── Shadow mapping ─────────────────────────────────────────────

  get shadowsEnabled(): boolean { return this._shadowsEnabled; }

  enableShadows(mapSize = 2048, halfExtent = 15, bias = 0.002): void {
    this._shadowMapSize = mapSize;
    this._shadowHalfExtent = halfExtent;
    this._shadowBias = bias;

    this._shadowTexture?.destroy();
    this._shadowTexture = this.device.createTexture({
      size: [mapSize, mapSize, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._shadowTextureView = this._shadowTexture.createView();
    this._shadowBindGroup = this.device.createBindGroup({
      layout: this.pipeline.shadowBindGroupLayout,
      entries: [
        { binding: 0, resource: this._shadowTextureView },
        { binding: 1, resource: this.pipeline.shadowSampler },
      ],
    });
    this._shadowsEnabled = true;
  }

  disableShadows(): void {
    this._shadowTexture?.destroy();
    this._shadowTexture = null;
    this._shadowTextureView = null;
    this._shadowBindGroup = null;
    this._shadowsEnabled = false;
  }

  // ── Outline pass ───────────────────────────────────────────────

  get outlineEnabled(): boolean { return !!this._outlinePass; }

  enableOutlines(color?: [number, number, number, number], threshold?: number): void {
    if (!this._outlinePass) {
      this._outlinePass = new OutlinePass(this.device, this.pipeline.meshBindGroupLayout, this._swapChainFormat);
    }
    if (color)     this._outlinePass.color     = color;
    if (threshold !== undefined) this._outlinePass.threshold = threshold;
  }

  setOutlineColor(r: number, g: number, b: number, a = 1): void {
    if (this._outlinePass) this._outlinePass.color = [r, g, b, a];
  }

  setOutlineThreshold(t: number): void {
    if (this._outlinePass) this._outlinePass.threshold = t;
  }

  disableOutlines(): void {
    this._outlinePass?.destroy();
    this._outlinePass = null;
  }

  // ── Bloom pass ────────────────────────────────────────────────

  get bloomEnabled(): boolean { return !!this._bloomPass; }

  enableBloom(threshold?: number, intensity?: number): void {
    if (!this._bloomPass) {
      this._bloomPass = new BloomPass(this.device, this._swapChainFormat);
    }
    if (threshold !== undefined) this._bloomPass.threshold = threshold;
    if (intensity  !== undefined) this._bloomPass.intensity  = intensity;
  }

  disableBloom(): void {
    this._bloomPass?.destroy();
    this._bloomPass = null;
    this._bloomCapturePipeline = null;
  }

  setBloomThreshold(t: number): void { if (this._bloomPass) this._bloomPass.threshold = t; }
  setBloomIntensity(v: number): void { if (this._bloomPass) this._bloomPass.intensity  = v; }

  // ── Texture atlas helpers ──────────────────────────────────────

  /**
   * Return the atlas layer index for a TextureLibrary entry, or -1 if not found.
   * Used by drawParticles() to resolve animTextures IDs to layer indices.
   */
  getAtlasLayerIndex(textureLibraryId: string): number {
    return this._atlasLayerMap.get(textureLibraryId) ?? -1;
  }

  // ── Default placeholder textures ───────────────────────────────

  private getDefaultWhiteTex(): GPUTexture {
    if (!this._defaultWhiteTex) {
      this._defaultWhiteTex = this.device.createTexture({
        size: [1, 1, 1], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this._defaultWhiteTex },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 }, [1, 1, 1],
      );
    }
    return this._defaultWhiteTex;
  }

  private createTextureBindGroup(mesh: Mesh3D): GPUBindGroup {
    const diffuseTex = mesh.diffuseTexture ?? this.getDefaultWhiteTex();
    const normalTex  = mesh.normalMapTexture ?? this.getDefaultFlatNormalTex();
    const cached = this._texBindGroupCache.get(mesh.id);
    if (cached && cached.diffuse === diffuseTex && cached.normal === normalTex) {
      return cached.bg;
    }
    // texture_2d_array views work on 1-layer textures (size [w, h, 1]) too.
    const bg = this.device.createBindGroup({
      layout: this.pipeline.textureBindGroupLayout,
      entries: [
        { binding: 0, resource: diffuseTex.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: this.pipeline.nearestSampler },
        { binding: 2, resource: normalTex.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: this.pipeline.nearestSampler },
      ],
    });
    this._texBindGroupCache.set(mesh.id, { bg, diffuse: diffuseTex, normal: normalTex });
    return bg;
  }

  /** Evict a mesh's texture bind group cache entry (call when mesh is removed or its texture changes). */
  evictTextureBindGroup(meshId: string): void {
    this._texBindGroupCache.delete(meshId);
  }

  private getDefaultFlatNormalTex(): GPUTexture {
    if (!this._defaultFlatNormalTex) {
      this._defaultFlatNormalTex = this.device.createTexture({
        size: [1, 1, 1], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      // Flat normal in tangent space: (0,0,1) encoded as (128,128,255) → no perturbation
      this.device.queue.writeTexture(
        { texture: this._defaultFlatNormalTex },
        new Uint8Array([128, 128, 255, 255]),
        { bytesPerRow: 4 }, [1, 1, 1],
      );
    }
    return this._defaultFlatNormalTex;
  }

  // ── Gizmo accessors ────────────────────────────────────────────

  /** Call whenever any mesh transform or material changes outside of gpuDirty (e.g. gizmo drag). */
  markInstancesDirty(): void { this._instancesDirty = true; }

  /** Register GPU-instanced array groups — renderer computes instance transforms from params. */
  setArrayGroups(groups: ArrayGroup3D[], localBases?: Map<string, LocalBasis3>): void {
    this._arrayGroups = groups;
    this._arrayGroupLocalBases = localBases ?? new Map();
    this._instancesDirty = true;
  }

  setGizmoRenderer(gr: GizmoRenderer): void { this._gizmoRenderer = gr; }
  getGizmoRenderer(): GizmoRenderer | undefined { return this._gizmoRenderer; }

  setMeshEditOverlayRenderer(r: MeshEditOverlayRenderer | undefined): void { this._meshEditOverlay = r; }
  setMeshEditDataProvider(fn: (() => MeshEditDrawData | null) | undefined): void { this._meshEditDataFn = fn; }

  setSelectedMeshIds(ids: Set<string>): void { this._selectedMeshIds = new Set(ids); }
  getSelectedMeshIds(): Set<string> { return this._selectedMeshIds; }

  setHoveredMeshIds(ids: Set<string>): void { this._hoveredMeshIds = new Set(ids); }
  getHoveredMeshIds(): Set<string> { return this._hoveredMeshIds; }

  setGizmoMode(mode: GizmoMode): void { this._gizmoMode = mode; }
  getGizmoMode(): GizmoMode { return this._gizmoMode; }

  setHoveredGizmoAxis(axis: GizmoAxis): void { this._hoveredAxis = axis; }
  getHoveredGizmoAxis(): GizmoAxis { return this._hoveredAxis; }

  setDraggingAxis(axis: GizmoAxis): void { this._draggingAxis = axis; }
  getDraggingAxis(): GizmoAxis { return this._draggingAxis; }

  setHoveredCorner(idx: number | null): void { this._hoveredCorner = idx; }
  getHoveredCorner(): number | null { return this._hoveredCorner; }

  // Array gizmo
  setArrayGizmoData(data: ArrayGizmoData | null): void { this._arrayGizmoData = data; }
  getArrayGizmoData(): ArrayGizmoData | null { return this._arrayGizmoData; }
  setArrayHandleHovered(v: ArrayHandleHit): void { this._arrayHandleHovered = v; }
  getArrayHandleHovered(): ArrayHandleHit { return this._arrayHandleHovered; }

  // Array Tool — ghost preview + face handles
  setGhostPreviewData(data: GhostPreviewData | null): void { this._ghostPreviewData = data; }
  setFaceHandleData(data: FaceHandleData | null): void { this._faceHandleData = data; }

  // Bone overlay
  setBoneOverlaySkeleton(skel: Skeleton3D | null): void { this._boneOverlaySkeleton = skel; }
  getBoneOverlaySkeleton(): Skeleton3D | null { return this._boneOverlaySkeleton; }
  setHoveredJoint(idx: number | null): void { this._hoveredJointIdx = idx; }
  getHoveredJoint(): number | null { return this._hoveredJointIdx; }
  setSelectedJoint(idx: number | null): void { this._selectedJointIdx = idx; }
  getSelectedJoint(): number | null { return this._selectedJointIdx; }

  // ── Frame rendering ────────────────────────────────────────────

  /**
   * Draw all Mesh3D nodes into the given render pass.
   * Call this from the main renderer's render loop at the 3D draw point.
   */
  drawMeshes(pass: GPURenderPassEncoder, meshes: Mesh3D[], canvasWidth: number, canvasHeight: number): void {
    if (meshes.length === 0) return;

    // Update camera aspect
    this.camera.aspect = canvasWidth / canvasHeight;

    // Upload scene uniforms
    this.uploadSceneUniforms(canvasWidth, canvasHeight);

    // Ensure instance storage buffer is large enough.
    // Multi-material meshes occupy one slot per submesh; array instances add N slots per group.
    const regularSlots = meshes.reduce((n, m) => n + Math.max(1, m.submeshes.length), 0);
    const arraySlots = this._arrayGroups.reduce((n, g) => n + getArrayInstanceCount(g.arrayParams), 0);
    const totalSlots = regularSlots + arraySlots;
    this.ensureInstanceBuffer(totalSlots);

    // Upload per-mesh transform/material instance data.
    // Must run before _ensureGeomPool so it can still see gpuDirty flags
    // (it uses anyGpuDirty as one upload trigger).
    this.uploadMeshInstances(meshes);

    // Capture which vertex-colored (EditMesh) meshes need their GPU buffers re-uploaded.
    // Must run before _ensureGeomPool because that call clears gpuDirty as a side effect.
    const vcDirtyIds = new Set(
      meshes.filter(m => m.gpuDirty && !!m.vertexColors).map(m => m.id),
    );

    // Rebuild shared geometry pool if mesh list or any geometry changed.
    // Clears gpuDirty on uploaded meshes as a side effect.
    if (!this._ensureGeomPool(meshes)) return;

    // Re-upload standalone VB overrides + color VBs for dirty EditMesh meshes.
    // Also create on first encounter (no entry yet in _vcColorBuffers).
    for (const m of meshes) {
      if (m.vertexColors && (vcDirtyIds.has(m.id) || !this._vcColorBuffers.has(m.id))) {
        this._uploadVCBuffers(m);
      }
    }

    // Recreate bind group only when instance buffer capacity grew (reference changed).
    if (!this.meshBindGroup || this._meshBindGroupBuffer !== this.instanceStorageBuffer) {
      this.meshBindGroup = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.instanceStorageBuffer! } },
          { binding: 1, resource: { buffer: this.sceneUniformBuffer } },
        ],
      });
      this._meshBindGroupBuffer = this.instanceStorageBuffer;
    }

    // Sort: opaque first (front-to-back), transparent last (back-to-front).
    // Also apply frustum culling when enabled.
    // DrawEntry carries an optional submesh for multi-material meshes.
    type DrawEntry = { mesh: Mesh3D; idx: number; submesh?: import('../../scene-graph/shapes/mesh-3d').Submesh3D };
    const opaque: DrawEntry[] = [];
    const transparent: DrawEntry[] = [];

    const culler = this._frustumCulling
      ? FrustumCuller.fromViewProjection(this.camera.getViewProjectionMatrix())
      : null;

    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (culler) {
        const bb = this.getMeshWorldAABB3D(m);
        if (bb && !culler.testAABB(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ)) continue;
      }
      if (m.submeshes.length > 0) {
        // Multi-material: one draw entry per submesh.
        const slots = this._meshSubmeshSlots.get(m.id);
        for (let si = 0; si < m.submeshes.length; si++) {
          const sub = m.submeshes[si];
          const idx = slots?.[si] ?? 0;
          if (sub.material.opacity < 1) transparent.push({ mesh: m, idx, submesh: sub });
          else opaque.push({ mesh: m, idx, submesh: sub });
        }
      } else {
        // Single-material: idx = slot in the geometryKey-sorted instance buffer.
        const idx = this._meshInstanceSlots.get(m.id) ?? i;
        if (m.material.opacity < 1) transparent.push({ mesh: m, idx });
        else opaque.push({ mesh: m, idx });
      }
    }

    // Add GPU-instanced array group draw entries (no Mesh3D copies — instances computed from params).
    // Each instance uses the source mesh's geometry; slots are contiguous immediately after source slot.
    for (const group of this._arrayGroups) {
      const firstSlot = this._arrayGroupFirstSlot.get(group.id);
      if (firstSlot === undefined) continue;
      const sourceMesh = meshes.find(m => m.id === group.sourceId);
      if (!sourceMesh || sourceMesh.submeshes.length > 0) continue;
      const N = getArrayInstanceCount(group.arrayParams);
      for (let i = 0; i < N; i++) {
        const idx = firstSlot + i;
        if (sourceMesh.material.opacity < 1) transparent.push({ mesh: sourceMesh, idx });
        else opaque.push({ mesh: sourceMesh, idx });
      }
    }

    // For shadow and outline passes: deduplicate multi-submesh meshes so each
    // mesh's full geometry is drawn once (not once per submesh).
    const opaqueForPasses: DrawEntry[] = [];
    {
      const seen = new Set<string>();
      for (const e of opaque) {
        if (e.submesh) {
          if (!seen.has(e.mesh.id)) {
            seen.add(e.mesh.id);
            // Use the first submesh slot's idx for the transform; no submesh → full geometry.
            opaqueForPasses.push({ mesh: e.mesh, idx: e.idx });
          }
        } else {
          opaqueForPasses.push(e);
        }
      }
    }

    // Shared VB/IB stay bound for all passes. VB slot 0 switches only for cloth overrides.
    const sharedVB = this._geomVB!;
    const sharedIB = this._geomIB!;

    // Helper: draw one mesh (or an instanced group) using the geometry pool.
    // instanceCount > 1 requires all instances to be contiguous in the storage buffer,
    // which is guaranteed by the geometryKey sort in uploadMeshInstances.
    // Pass a submesh to restrict the draw to that submesh's index range.
    const drawMesh = (enc: GPURenderPassEncoder, mesh: Mesh3D, firstInstance: number,
                      activeVBRef: { vb: GPUBuffer }, instanceCount = 1,
                      submesh?: import('../../scene-graph/shapes/mesh-3d').Submesh3D) => {
      const alloc = this._geomAllocs.get(mesh.id);
      if (!alloc) return;
      const override = this._vertexBufferOverrides.get(mesh.id);
      const targetVB = override ?? sharedVB;
      if (targetVB !== activeVBRef.vb) {
        enc.setVertexBuffer(0, targetVB);
        activeVBRef.vb = targetVB;
      }
      if (submesh) {
        enc.drawIndexed(submesh.indexCount, instanceCount,
          alloc.firstIndex + submesh.indexOffset,
          override ? 0 : alloc.baseVertex, firstInstance);
      } else {
        enc.drawIndexed(alloc.indexCount, instanceCount, alloc.firstIndex,
          override ? 0 : alloc.baseVertex, firstInstance);
      }
    };

    // Outline depth pre-pass: camera-view depth into outline texture, then Sobel.
    // Submitted before the main pass so the edge texture is ready for the composite quad.
    if (this._outlinePass) {
      this._outlinePass.ensureTextures(canvasWidth, canvasHeight);
      this._outlinePass.updateParams();

      const outlineEncoder = this.device.createCommandEncoder();

      const depthPrePass = outlineEncoder.beginRenderPass({
        colorAttachments: [{
          view:       this._outlinePass.normalTexView,
          clearValue: { r: 0.5, g: 0.5, b: 1.0, a: 1.0 },
          loadOp:  'clear',
          storeOp: 'store',
        }],
        depthStencilAttachment: {
          view: this._outlinePass.depthTexView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      depthPrePass.setPipeline(this._outlinePass.depthNormalPipeline);
      depthPrePass.setBindGroup(0, this.meshBindGroup!);
      depthPrePass.setVertexBuffer(0, sharedVB);
      depthPrePass.setIndexBuffer(sharedIB, 'uint32');
      const outlineVBRef = { vb: sharedVB };
      for (const { mesh, idx } of [...opaqueForPasses, ...transparent]) {
        drawMesh(depthPrePass, mesh, idx, outlineVBRef);
      }
      depthPrePass.end();

      this._outlinePass.runSobelPass(outlineEncoder);
      this.device.queue.submit([outlineEncoder.finish()]);
    }

    // Shadow pre-pass: depth-only render into shadow map using its own command encoder.
    // Submitted before the main pass draws so the GPU executes it first.
    if (this._shadowsEnabled && this._shadowTextureView && this._shadowBindGroup) {
      const shadowEncoder = this.device.createCommandEncoder();
      const shadowPass = shadowEncoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: this._shadowTextureView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      shadowPass.setPipeline(this.pipeline.shadowPassPipeline);
      shadowPass.setBindGroup(0, this.meshBindGroup!);
      shadowPass.setVertexBuffer(0, sharedVB);
      shadowPass.setIndexBuffer(sharedIB, 'uint32');
      const shadowVBRef = { vb: sharedVB };
      // Shadow pass uses one pipeline (no texture grouping needed) — group by geometryKey only.
      // Uses opaqueForPasses (deduplicated: one entry per mesh, full geometry per mesh).
      let ssi = 0;
      while (ssi < opaqueForPasses.length) {
        const geoKey = opaqueForPasses[ssi].mesh.geometryKey;
        let ssj = ssi + 1;
        while (ssj < opaqueForPasses.length && opaqueForPasses[ssj].mesh.geometryKey === geoKey) ssj++;
        let sk = 0;
        const sGroupLen = ssj - ssi;
        while (sk < sGroupLen) {
          const subStart  = ssi + sk;
          const firstSlot = opaqueForPasses[subStart].idx;
          let subLen = 1;
          while (sk + subLen < sGroupLen &&
                 opaqueForPasses[subStart + subLen].idx === firstSlot + subLen) {
            subLen++;
          }
          drawMesh(shadowPass, opaqueForPasses[subStart].mesh, firstSlot, shadowVBRef, subLen);
          sk += subLen;
        }
        ssi = ssj;
      }
      shadowPass.end();
      this.device.queue.submit([shadowEncoder.finish()]);
    }

    // Separate single-material and multi-submesh opaque entries.
    // Single-material entries can be batched by geometryKey; multi-submesh cannot.
    // Vertex-colored (EditMesh) meshes go to a separate list — they use a different pipeline.
    const opaqueVC     = opaque.filter(e => !e.submesh && !!e.mesh.vertexColors);
    const opaqueSimple = opaque.filter(e => !e.submesh && !e.mesh.vertexColors);
    const opaqueMulti  = opaque.filter(e => !!e.submesh);

    // Sort single-material opaque meshes by (pipelineKey, geometryKey, textureRef) so:
    //   1. Pipeline switches are minimized (untextured before textured, etc.)
    //   2. Same-geometry instances are adjacent → enables batched instanced draws
    //   3. Same-texture instances within a geometry group are adjacent → single bind group per group
    if (opaqueSimple.length > 1) {
      opaqueSimple.sort((a, b) => {
        const pipelineKeyOf = (m: Mesh3D) =>
          ((m.material.hasTexture || m.material.hasNormalMap) ? 1 : 0) |
          ((this.forceDoubleSided || !!m.material.doubleSided) ? 2 : 0);
        const pDiff = pipelineKeyOf(a.mesh) - pipelineKeyOf(b.mesh);
        if (pDiff !== 0) return pDiff;
        return a.mesh.geometryKey.localeCompare(b.mesh.geometryKey);
      });
    }

    // Set shared VB/IB once for the main pass — only VB slot 0 switches for overrides.
    pass.setVertexBuffer(0, sharedVB);
    pass.setIndexBuffer(sharedIB, 'uint32');
    const mainVBRef = { vb: sharedVB };

    if (opaqueSimple.length > 0) {
      // Group consecutive entries sharing the same geometry + pipeline + texture into one
      // instanced drawIndexed call. Falls back to individual draws when frustum culling
      // breaks slot contiguity within a group.
      let oi = 0;
      while (oi < opaqueSimple.length) {
        const lead = opaqueSimple[oi].mesh;
        const geoKey     = lead.geometryKey;
        const useTexture = lead.material.hasTexture || lead.material.hasNormalMap;
        const noCull     = this.forceDoubleSided || !!lead.material.doubleSided;
        const leadDiff   = lead.diffuseTexture;
        const leadNorm   = lead.normalMapTexture;
        // A mesh is "atlas mode" when its texture is packed into the shared atlas
        // (identified by textureLibraryId). Atlas meshes all share one bind group
        // and can batch across different textures — textureIndex selects the layer.
        const leadIsAtlas = useTexture && !!lead.textureLibraryId && this._atlasLayerMap.has(lead.textureLibraryId);

        // Scan forward while same group (geometry + pipeline + texture mode all match)
        let oj = oi + 1;
        while (oj < opaqueSimple.length) {
          const m = opaqueSimple[oj].mesh;
          if (m.geometryKey !== geoKey) break;
          if ((m.material.hasTexture || m.material.hasNormalMap) !== useTexture) break;
          if ((this.forceDoubleSided || !!m.material.doubleSided) !== noCull) break;
          if (useTexture) {
            const mIsAtlas = !!m.textureLibraryId && this._atlasLayerMap.has(m.textureLibraryId);
            if (mIsAtlas !== leadIsAtlas) break; // can't mix atlas and standalone in one group
            if (!mIsAtlas && (m.diffuseTexture !== leadDiff || m.normalMapTexture !== leadNorm)) break;
            // atlas meshes: no texture-based break — they all share the atlas bind group
          }
          oj++;
        }

        // Set pipeline + bind groups once for the whole group
        if (useTexture) {
          pass.setPipeline(noCull
            ? this.pipeline.opaqueTexturedNoCullPipeline
            : this._shadowsEnabled
              ? this.pipeline.opaqueTexturedShadowPipeline
              : this.pipeline.opaqueTexturedPipeline);
          pass.setBindGroup(0, this.meshBindGroup);
          // Atlas meshes share one bind group; standalone meshes get per-mesh bind group
          const texBG = (leadIsAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(lead);
          pass.setBindGroup(1, texBG);
          if (!noCull && this._shadowsEnabled) pass.setBindGroup(2, this._shadowBindGroup!);
        } else {
          pass.setPipeline(noCull
            ? this.pipeline.opaqueUntexturedNoCullPipeline
            : this._shadowsEnabled
              ? this.pipeline.opaqueUntexturedShadowPipeline
              : this.pipeline.opaqueUntexturedPipeline);
          pass.setBindGroup(0, this.meshBindGroup);
          if (!noCull && this._shadowsEnabled) pass.setBindGroup(1, this._shadowBindGroup!);
        }

        // Split the group into maximal contiguous sub-runs of instance slots.
        // Frustum culling may remove members mid-group, creating gaps in the slot sequence.
        let k = 0;
        const groupLen = oj - oi;
        while (k < groupLen) {
          const subStart  = oi + k;
          const firstSlot = opaqueSimple[subStart].idx;
          let subLen = 1;
          while (k + subLen < groupLen &&
                 opaqueSimple[subStart + subLen].idx === firstSlot + subLen) {
            subLen++;
          }
          drawMesh(pass, opaqueSimple[subStart].mesh, firstSlot, mainVBRef, subLen);
          k += subLen;
        }

        oi = oj;
      }
    }

    // Draw multi-material opaque submesh entries (one draw call per submesh, no batching).
    for (const { mesh, idx, submesh } of opaqueMulti) {
      const mat  = submesh!.material;
      const noCull = this.forceDoubleSided || !!mat.doubleSided;
      const useTexture = mat.hasTexture || mat.hasNormalMap;
      if (useTexture) {
        const texId = submesh!.textureLibraryId ?? '';
        const isAtlas = !!texId && this._atlasLayerMap.has(texId);
        pass.setPipeline(noCull
          ? this.pipeline.opaqueTexturedNoCullPipeline
          : this._shadowsEnabled
            ? this.pipeline.opaqueTexturedShadowPipeline
            : this.pipeline.opaqueTexturedPipeline);
        pass.setBindGroup(0, this.meshBindGroup);
        const texBG = (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(mesh);
        pass.setBindGroup(1, texBG);
        if (!noCull && this._shadowsEnabled) pass.setBindGroup(2, this._shadowBindGroup!);
      } else {
        pass.setPipeline(noCull
          ? this.pipeline.opaqueUntexturedNoCullPipeline
          : this._shadowsEnabled
            ? this.pipeline.opaqueUntexturedShadowPipeline
            : this.pipeline.opaqueUntexturedPipeline);
        pass.setBindGroup(0, this.meshBindGroup);
        if (!noCull && this._shadowsEnabled) pass.setBindGroup(1, this._shadowBindGroup!);
      }
      drawMesh(pass, mesh, idx, mainVBRef, 1, submesh);
    }

    // Draw vertex-colored (EditMesh) opaque meshes — one draw per mesh, no batching.
    // Uses a two-slot vertex layout: slot 0 = standard geometry (standalone VB override,
    // baseVertex=0), slot 1 = per-vertex rgba float32x4 color buffer.
    if (opaqueVC.length > 0) {
      pass.setPipeline(this.pipeline.opaqueVertexColorPipeline);
      pass.setBindGroup(0, this.meshBindGroup!);
      for (const { mesh, idx } of opaqueVC) {
        const colorBuf = this._vcColorBuffers.get(mesh.id);
        if (!colorBuf) continue;
        pass.setVertexBuffer(1, colorBuf);
        drawMesh(pass, mesh, idx, mainVBRef);
      }
    }

    // Draw transparent meshes (single-material and multi-submesh)
    if (transparent.length > 0) {
      for (const { mesh, idx, submesh } of transparent) {
        const alloc = this._geomAllocs.get(mesh.id);
        if (!alloc) continue;

        const mat = submesh?.material ?? mesh.material;
        const useTexture = mat.hasTexture || mat.hasNormalMap;
        if (useTexture) {
          pass.setPipeline(this.pipeline.transparentTexturedPipeline);
          pass.setBindGroup(0, this.meshBindGroup);
          const texId = submesh?.textureLibraryId ?? mesh.textureLibraryId ?? '';
          const isAtlas = !!texId && this._atlasLayerMap.has(texId);
          const texBG   = (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(mesh);
          pass.setBindGroup(1, texBG);
        } else {
          pass.setPipeline(this.pipeline.transparentUntexturedPipeline);
          pass.setBindGroup(0, this.meshBindGroup);
        }

        drawMesh(pass, mesh, idx, mainVBRef, 1, submesh);
      }
    }

    // Composite outline edges on top of all meshes (before gizmo)
    if (this._outlinePass) {
      this._outlinePass.drawComposite(pass);
    }

    // Per-mesh hover highlight outline (hover only — selection uses AABB box below)
    if (this._highlightPass && this.meshBindGroup) {
      const hoverOnly = [...this._hoveredMeshIds].filter(id => !this._selectedMeshIds.has(id));

      const toEntries = (ids: string[]) => ids.flatMap(id => {
        const pair = [...opaqueSimple, ...opaqueVC, ...transparent].find(p => p.mesh.id === id);
        if (!pair) return [];
        const alloc = this._geomAllocs.get(pair.mesh.id);
        if (!alloc) return [];
        const hasOverride = this._vertexBufferOverrides.has(pair.mesh.id);
        return [{
          vertex:      this._vertexBufferOverrides.get(pair.mesh.id) ?? sharedVB,
          index:       sharedIB,
          indexCount:  alloc.indexCount,
          firstIndex:  alloc.firstIndex,
          baseVertex:  hasOverride ? 0 : alloc.baseVertex,
          instanceIdx: pair.idx,
        }];
      });

      const hoverEntries = toEntries(hoverOnly);
      if (hoverEntries.length > 0) {
        this._highlightPass.writeParams('hover', [0.45, 0.85, 1.0, 0.80], 0.05);
        this._highlightPass.draw(pass, this.meshBindGroup, 'hover', hoverEntries);
      }
    }

    // Ghost preview (Array Tool) — translucent instanced copies, depth-tested, no depth write
    if (this._ghostPreviewRenderer) {
      this._ghostPreviewRenderer.update(this._ghostPreviewData);
      if (this._ghostPreviewData) {
        this._ghostPreviewRenderer.draw(pass, this.camera);
      }
    }

    // Resolve edit mode state once — used to suppress selection box + gizmo below
    const editData = this._meshEditOverlay && this._meshEditDataFn ? this._meshEditDataFn() : null;
    const inEditMode = editData !== null;

    if (!inEditMode && this._gizmoRenderer) {
      if (this._arrayGizmoData) {
        // Array gizmo replaces transform gizmo when an ArrayGroup3D is selected
        this._gizmoRenderer.drawArrayGizmo(
          pass, this._arrayGizmoData, this.camera, this._arrayHandleHovered,
        );
      } else if (this._selectedMeshIds.size > 0) {
        const selectedMeshes = meshes.filter(m => this._selectedMeshIds.has(m.id));
        if (selectedMeshes.length > 0) {
          // AABB bounding box wireframe + corner handles
          this._gizmoRenderer.drawSelectionBox(pass, selectedMeshes, this.camera, this._hoveredCorner);
          // Transform gizmo
          this._gizmoRenderer.drawGizmo(
            pass, selectedMeshes, this.camera,
            this._gizmoMode, this._hoveredAxis,
            canvasWidth, canvasHeight,
            this._draggingAxis,
          );
        }
      }
    }

    // Bone overlay for selected skinned mesh (always-visible, after gizmo)
    if (this._gizmoRenderer && this._boneOverlaySkeleton) {
      this._gizmoRenderer.drawBoneOverlay(
        pass, this._boneOverlaySkeleton, this.camera,
        this._hoveredJointIdx, this._selectedJointIdx,
      );
    }

    // Array Tool face handles (depth=always — always visible on top of scene)
    if (this._gizmoRenderer && this._faceHandleData) {
      this._gizmoRenderer.drawFaceHandles(pass, this._faceHandleData, this.camera);
    }

    // Mesh edit overlay — wireframe, face fills, vertex/edge highlights
    if (editData) this._meshEditOverlay!.draw(pass, editData, this.camera);
  }

  // ── Particle rendering ─────────────────────────────────────────

  /**
   * Draw billboard particles from all visible ParticleEmitter3D nodes.
   * Call this from the main render pass after drawMeshes() (transparent pass is already done,
   * particles blend on top of all opaque and transparent mesh geometry).
   *
   * Pipeline is created lazily on first call. All emitters are packed into one GPU storage
   * buffer and issued as separate draw(6, count, 0, firstInstance) calls — one per emitter.
   */
  drawParticles(pass: GPURenderPassEncoder, emitters: ParticleEmitter3D[], canvasWidth: number, canvasHeight: number): void {
    void canvasWidth; void canvasHeight; // reserved for future per-particle screen-space effects

    // Build GPU data for every visible emitter, resolving animated texture layers.
    // Must happen after drawMeshes() so the atlas layer map is current.
    const visible = emitters.filter(e => e.visible);
    for (const e of visible) {
      const animIds = e.config.animTextures;
      const animLayers = animIds && animIds.length > 0
        ? animIds.map(id => {
            const layer = this.getAtlasLayerIndex(id);
            return layer >= 0 ? layer : 0;
          })
        : [];
      e.buildGPUData(animLayers);
    }

    const active = visible.filter(e => e.activeCount > 0);
    if (active.length === 0) return;

    if (!this._particlePipeline) this._initParticlePipeline();

    // Pack all active emitters' compact GPU data into one STORAGE buffer.
    const totalParticles = active.reduce((s, e) => s + e.activeCount, 0);
    const totalBytes     = totalParticles * PARTICLE_INSTANCE_STRIDE;

    if (!this._particleInstBuf || this._particleInstBufCap < totalBytes) {
      this._particleInstBuf?.destroy();
      this._particleInstBufCap = Math.ceil(totalBytes * 1.5);
      this._particleInstBuf = this.device.createBuffer({
        size:  this._particleInstBufCap,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: 'ParticleInstBuf',
      });
      this._particleBindGroup0 = null;
    }

    const firstInstances: number[] = [];
    let writeOffset = 0;
    for (const e of active) {
      firstInstances.push(writeOffset / PARTICLE_INSTANCE_STRIDE);
      const byteLen = e.activeCount * PARTICLE_INSTANCE_STRIDE;
      this.device.queue.writeBuffer(
        this._particleInstBuf!, writeOffset,
        e.gpuData.buffer, e.gpuData.byteOffset, byteLen,
      );
      writeOffset += byteLen;
    }

    this._writeParticleSceneUniforms();

    if (!this._particleBindGroup0) {
      this._particleBindGroup0 = this.device.createBindGroup({
        layout: this._particleBGL0!,
        entries: [
          { binding: 0, resource: { buffer: this._particleInstBuf! } },
          { binding: 1, resource: { buffer: this._particleSceneUniBuf! } },
        ],
      });
    }

    // ── Bloom capture + blur (before main pass draws) ──────────────
    if (this._bloomPass) {
      this._bloomPass.ensureTextures(canvasWidth, canvasHeight);
      if (!this._bloomCapturePipeline) {
        this._bloomCapturePipeline = createBloomCapturePipeline(
          this.device, this._particleBGL0!, this._particleBGL1!,
        );
      }
      const atlasTex = this._atlasTexture ?? this.getDefaultWhiteTex();
      this._bloomPass.captureAndBlur(
        this._particleInstBuf!,
        this._particleSceneUniBuf!,
        this._particleBGL0!,
        this._particleBGL1!,
        this._bloomCapturePipeline,
        active,
        firstInstances,
        this.pipeline.nearestSampler,
        atlasTex,
      );
    }

    // ── Main pass draw ─────────────────────────────────────────────
    pass.setPipeline(this._particlePipeline!);
    pass.setBindGroup(0, this._particleBindGroup0!);
    pass.setBindGroup(1, this._getParticleTexBindGroup());

    for (let i = 0; i < active.length; i++) {
      pass.draw(6, active[i].activeCount, 0, firstInstances[i]);
    }

    // ── Bloom composite (additive, drawn after particles) ──────────
    if (this._bloomPass) {
      this._bloomPass.drawComposite(pass, this.pipeline.nearestSampler);
    }
  }

  private _initParticlePipeline(): void {
    const device = this.device;

    this._particleBGL0 = device.createBindGroupLayout({
      label: 'ParticleBGL0',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX,   buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX,   buffer: { type: 'uniform' } },
      ],
    });

    this._particleBGL1 = device.createBindGroupLayout({
      label: 'ParticleBGL1',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this._particlePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._particleBGL0, this._particleBGL1] }),
      vertex: {
        module:     device.createShaderModule({ code: PARTICLE_VERTEX_SHADER }),
        entryPoint: 'vs_particle',
      },
      fragment: {
        module:     device.createShaderModule({ code: PARTICLE_FRAGMENT_SHADER }),
        entryPoint: 'fs_particle',
        targets: [{
          format: this._swapChainFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive:    { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less' },
    });

    this._particleSceneUniBuf = device.createBuffer({
      size:  PARTICLE_SCENE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'ParticleSceneUniforms',
    });
  }

  private _writeParticleSceneUniforms(): void {
    const vp   = this.camera.getViewProjectionMatrix() as Float32Array;
    const view = this.camera.getViewMatrix()           as Float32Array;
    // gl-matrix stores column-major; the camera right vector is row 0 of the view matrix:
    // right = (view[0], view[4], view[8]), up = (view[1], view[5], view[9])
    const data = new Float32Array(PARTICLE_SCENE_UNIFORM_SIZE / 4);
    data.set(vp, 0);
    data[16] = view[0]; data[17] = view[4]; data[18] = view[8];  data[19] = 0;
    data[20] = view[1]; data[21] = view[5]; data[22] = view[9];  data[23] = 0;
    this.device.queue.writeBuffer(this._particleSceneUniBuf!, 0, data);
  }

  private _getParticleTexBindGroup(): GPUBindGroup {
    const atlasTex = this._atlasTexture ?? this.getDefaultWhiteTex();
    if (!this._particleTexBG || this._particleTexBGAtlas !== atlasTex) {
      this._particleTexBGAtlas = atlasTex;
      this._particleTexBG = this.device.createBindGroup({
        layout: this._particleBGL1!,
        entries: [
          { binding: 0, resource: atlasTex.createView({ dimension: '2d-array' }) },
          { binding: 1, resource: this.pipeline.nearestSampler },
        ],
      });
    }
    return this._particleTexBG;
  }

  // ── Private helpers ────────────────────────────────────────────

  private computeLightSpaceMatrix(): Float32Array {
    const d = this._light.direction;
    const dist = this._shadowHalfExtent * 4;
    const eye = vec3.fromValues(-d[0] * dist, -d[1] * dist, -d[2] * dist);
    const center = vec3.fromValues(0, 0, 0);
    const up = Math.abs(d[1]) > 0.99
      ? vec3.fromValues(1, 0, 0)
      : vec3.fromValues(0, 1, 0);

    const view = mat4.create();
    mat4.lookAt(view, eye, center, up);

    const he = this._shadowHalfExtent;
    const proj = mat4.create();
    mat4.ortho(proj, -he, he, -he, he, 0.1, dist * 2);

    const lsm = mat4.create();
    mat4.multiply(lsm, proj, view);
    return lsm as Float32Array;
  }

  getMeshWorldAABB3D(mesh: Mesh3D): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
    const geom = mesh.geometry;
    if (!geom || geom.vertices.length === 0) return null;

    const matVersion = mesh.localMatrixVersion;
    const cached     = this._meshAABBCache.get(mesh.id);

    // Full cache hit: geometry unchanged (gpuDirty = false) and matrix unchanged.
    if (!mesh.gpuDirty && cached && cached.matVersion === matVersion) {
      return { minX: cached.wMinX, minY: cached.wMinY, minZ: cached.wMinZ,
               maxX: cached.wMaxX, maxY: cached.wMaxY, maxZ: cached.wMaxZ };
    }

    // Local AABB: O(V) vertex scan only when geometry changed (gpuDirty) or first access.
    let ox0: number, oy0: number, oz0: number;
    let ox1: number, oy1: number, oz1: number;
    if (!mesh.gpuDirty && cached) {
      // Geometry stable — reuse cached local AABB, only redo the 8-corner world transform.
      ox0 = cached.lMinX; oy0 = cached.lMinY; oz0 = cached.lMinZ;
      ox1 = cached.lMaxX; oy1 = cached.lMaxY; oz1 = cached.lMaxZ;
    } else {
      ox0 = Infinity;  oy0 = Infinity;  oz0 = Infinity;
      ox1 = -Infinity; oy1 = -Infinity; oz1 = -Infinity;
      const v = geom.vertices;
      for (let i = 0; i < v.length; i += 12) {
        if (v[i]     < ox0) ox0 = v[i];     if (v[i]     > ox1) ox1 = v[i];
        if (v[i + 1] < oy0) oy0 = v[i + 1]; if (v[i + 1] > oy1) oy1 = v[i + 1];
        if (v[i + 2] < oz0) oz0 = v[i + 2]; if (v[i + 2] > oz1) oz1 = v[i + 2];
      }
    }

    // World AABB: transform 8 local AABB corners through model matrix — O(8).
    const m = mesh.localMatrix as unknown as Float32Array;
    let wx0 = Infinity, wy0 = Infinity, wz0 = Infinity;
    let wx1 = -Infinity, wy1 = -Infinity, wz1 = -Infinity;
    for (let ci = 0; ci < 8; ci++) {
      const cx = ci & 1 ? ox1 : ox0;
      const cy = ci & 2 ? oy1 : oy0;
      const cz = ci & 4 ? oz1 : oz0;
      const wx = m[0]*cx + m[4]*cy + m[8]*cz  + m[12];
      const wy = m[1]*cx + m[5]*cy + m[9]*cz  + m[13];
      const wz = m[2]*cx + m[6]*cy + m[10]*cz + m[14];
      if (wx < wx0) wx0 = wx; if (wx > wx1) wx1 = wx;
      if (wy < wy0) wy0 = wy; if (wy > wy1) wy1 = wy;
      if (wz < wz0) wz0 = wz; if (wz > wz1) wz1 = wz;
    }

    // Cache only when geometry is stable; skip caching for dynamic meshes (cloth etc.)
    if (!mesh.gpuDirty) {
      this._meshAABBCache.set(mesh.id, {
        lMinX: ox0, lMinY: oy0, lMinZ: oz0,
        lMaxX: ox1, lMaxY: oy1, lMaxZ: oz1,
        wMinX: wx0, wMinY: wy0, wMinZ: wz0,
        wMaxX: wx1, wMaxY: wy1, wMaxZ: wz1,
        matVersion,
      });
    }

    return { minX: wx0, minY: wy0, minZ: wz0, maxX: wx1, maxY: wy1, maxZ: wz1 };
  }

  // ── GPU upload helpers ─────────────────────────────────────────

  private uploadSceneUniforms(w: number, h: number): void {
    const data = this._sceneUniformsData;
    const vp = this.camera.getViewProjectionMatrix();
    const pos = this.camera.position;

    // viewProjection mat4x4 (floats 0–15)
    data.set(vp as Float32Array, 0);

    // cameraPosition vec4 (floats 16–19)
    data[16] = pos[0]; data[17] = pos[1]; data[18] = pos[2]; data[19] = 0;

    // ambientColor vec4 (floats 20–23, .a = intensity)
    data[20] = this._ambientColor[0]; data[21] = this._ambientColor[1]; data[22] = this._ambientColor[2];
    data[23] = this._ambientIntensity;

    // lightDirection vec4 (floats 24–27, .w = intensity)
    data[24] = this._light.direction[0]; data[25] = this._light.direction[1]; data[26] = this._light.direction[2];
    data[27] = this._light.intensity;

    // lightColor vec4 (floats 28–31)
    data[28] = this._light.color[0]; data[29] = this._light.color[1]; data[30] = this._light.color[2];
    data[31] = 0;

    // ps1Config vec4 (floats 32–35)
    data[32] = this._ps1.vertexJitter;
    data[33] = this._ps1.snapGridSize;
    data[34] = this._ps1.affineStrength;
    data[35] = this._ps1.colorDepth;

    // resolution vec4 (floats 36–39)
    data[36] = w;
    data[37] = h;
    data[38] = 0;
    data[39] = 0;

    // lightSpaceMatrix mat4x4 (floats 40–55) + shadowParams (floats 56–59)
    if (this._shadowsEnabled) {
      data.set(this.computeLightSpaceMatrix(), 40);
      data[57] = this._shadowBias;
      data[58] = this._shadowMapSize;
    }

    this.device.queue.writeBuffer(this.sceneUniformBuffer, 0, data);
  }

  private ensureInstanceBuffer(count: number): void {
    if (this.instanceCapacity >= count && this.instanceStorageBuffer) return;

    if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();

    this.instanceCapacity = Math.max(count, 16);
    this.instanceStorageBuffer = this.device.createBuffer({
      size: this.instanceCapacity * MESH_INSTANCE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Buffer reference changed — bind group, instance data, and texture atlas must be rebuilt.
    this._instancesDirty = true;
    this._atlasDirty = true;
    this._meshBindGroupBuffer = null;
  }

  private uploadMeshInstances(meshes: Mesh3D[]): void {
    // Avoid re-uploading every frame when nothing has changed.
    const anyGpuDirty = meshes.some(m => m.gpuDirty);
    const regularSlots = meshes.reduce((n, m) => n + Math.max(1, m.submeshes.length), 0);
    const arraySlots = this._arrayGroups.reduce((n, g) => n + getArrayInstanceCount(g.arrayParams), 0);
    const totalSlots = regularSlots + arraySlots;
    // Also check if any array source moved (localMatrixVersion bump) since last upload.
    const anyArrayMoved = this._arrayGroups.some(g => {
      const src = meshes.find(m => m.id === g.sourceId);
      return src ? src.localMatrixVersion !== (this._arrayGroupSourceVers.get(g.id) ?? -1) : false;
    });
    if (!this._instancesDirty && !anyGpuDirty && !anyArrayMoved && totalSlots === this._instanceCount) return;

    // Sort single-material meshes by geometryKey (contiguous same-geometry slots enable
    // batched instanced draws). Multi-submesh meshes sort last — they can't be instanced.
    const sorted = meshes.slice().sort((a, b) => {
      const aMulti = a.submeshes.length > 0 ? 1 : 0;
      const bMulti = b.submeshes.length > 0 ? 1 : 0;
      if (aMulti !== bMulti) return aMulti - bMulti;
      return a.geometryKey.localeCompare(b.geometryKey);
    });

    // Rebuild slot maps. Single-material meshes: one slot each; multi-submesh: one slot per submesh.
    // Array instance slots are assigned immediately after their source mesh's slot so the
    // source + all its instances are contiguous → one batched drawIndexed call.
    this._meshInstanceSlots.clear();
    this._meshSubmeshSlots.clear();
    this._arrayGroupFirstSlot.clear();
    let slotIdx = 0;
    for (const m of sorted) {
      if (m.submeshes.length > 0) {
        const slots: number[] = [];
        for (let si = 0; si < m.submeshes.length; si++) slots.push(slotIdx++);
        this._meshSubmeshSlots.set(m.id, slots);
      } else {
        this._meshInstanceSlots.set(m.id, slotIdx++);
        // Assign array instance slots immediately after source — keeps them contiguous for batching.
        for (const group of this._arrayGroups) {
          if (group.sourceId !== m.id) continue;
          const N = getArrayInstanceCount(group.arrayParams);
          if (N > 0) {
            this._arrayGroupFirstSlot.set(group.id, slotIdx);
            slotIdx += N;
          }
        }
      }
    }

    // Rebuild texture atlas when any material/texture changed.
    // Must run before the per-instance loop so _atlasLayerMap is populated.
    if (this._atlasDirty || anyGpuDirty) this._buildTextureAtlas(sorted);

    const floatsPerInstance = MESH_INSTANCE_STRIDE / 4;
    const needed = totalSlots * floatsPerInstance;

    // Reuse the staging Float32Array to avoid GC pressure.
    if (!this._instanceDataBuf || this._instanceDataBuf.length < needed) {
      this._instanceDataBuf = new Float32Array(needed);
    }
    const data = this._instanceDataBuf;

    const normalMat = mat4.create();
    const dataView  = new DataView(data.buffer);

    // Helper: write one instance slot at the given absolute slot index.
    const writeSlot = (slot: number, m: Mesh3D, mat3d: import('../../renderer/3d/material-3d').Material3D, texId: string, normId: string) => {
      const offset = slot * floatsPerInstance;
      const localMat = m.localMatrix;

      // modelMatrix (16 floats at offset 0)
      data.set(localMat as Float32Array, offset);

      // normalMatrix = inverse-transpose of modelMatrix (16 floats at offset 16)
      const matVer = m.localMatrixVersion;
      let nc = this._normalMatCache.get(m.id);
      if (!nc) {
        nc = { matVersion: -1, floats: new Float32Array(16) };
        this._normalMatCache.set(m.id, nc);
      }
      if (nc.matVersion !== matVer) {
        mat4.invert(normalMat, localMat);
        mat4.transpose(normalMat, normalMat);
        nc.floats.set(normalMat as Float32Array);
        nc.matVersion = matVer;
      }
      data.set(nc.floats, offset + 16);

      // diffuseColor (floats 32-35)
      data[offset + 32] = mat3d.diffuse.r;
      data[offset + 33] = mat3d.diffuse.g;
      data[offset + 34] = mat3d.diffuse.b;
      data[offset + 35] = mat3d.opacity;

      // specularColor (floats 36-39)
      data[offset + 36] = mat3d.specular.r;
      data[offset + 37] = mat3d.specular.g;
      data[offset + 38] = mat3d.specular.b;
      data[offset + 39] = mat3d.shininess;

      // emissiveColor + flags (floats 40-43)
      data[offset + 40] = mat3d.emissive.r;
      data[offset + 41] = mat3d.emissive.g;
      data[offset + 42] = mat3d.emissive.b;
      dataView.setUint32((offset + 43) * 4, encodeMaterialFlags(mat3d), true);

      // textureIndex / normalMapIndex (floats 44-45 as u32; 46-47 = padding)
      const texIdx  = this._atlasLayerMap.get(texId)  ?? 0;
      const normIdx = this._normalAtlasLayerMap.get(normId) ?? 0;
      dataView.setUint32((offset + 44) * 4, texIdx,  true);
      dataView.setUint32((offset + 45) * 4, normIdx, true);
    };

    for (const m of sorted) {
      if (m.submeshes.length > 0) {
        const slots = this._meshSubmeshSlots.get(m.id)!;
        for (let si = 0; si < m.submeshes.length; si++) {
          const sub = m.submeshes[si];
          writeSlot(slots[si], m, sub.material,
            sub.textureLibraryId  ?? '',
            sub.normalMapLibraryId ?? '');
        }
      } else {
        const slot = this._meshInstanceSlots.get(m.id)!;
        writeSlot(slot, m, m.material,
          m.textureLibraryId  ?? '',
          m.normalMapLibraryId ?? '');
      }
    }

    // Write GPU-instanced array group data.
    // Each instance reuses source R+S from source's localMatrix with modified translation.
    // Normal matrix is the same as source (translation doesn't affect inverse-transpose).
    for (const group of this._arrayGroups) {
      const firstSlot = this._arrayGroupFirstSlot.get(group.id);
      if (firstSlot === undefined) continue;
      const source = sorted.find(m => m.submeshes.length === 0 && m.id === group.sourceId);
      if (!source) continue;

      const srcSlot   = this._meshInstanceSlots.get(source.id)!;
      const srcOffset = srcSlot * floatsPerInstance;
      const srcMat    = source.localMatrix as Float32Array;
      const nc        = this._normalMatCache.get(source.id);
      const offsets   = computeArrayOffsets(group.arrayParams, [source.x, source.y, source.z], this._arrayGroupLocalBases.get(group.id));

      for (let i = 0; i < offsets.length; i++) {
        const [dx, dy, dz] = offsets[i];
        const slot   = firstSlot + i;
        const offset = slot * floatsPerInstance;

        // Copy full model matrix from source (inherits scale + rotation)
        data.set(srcMat, offset);
        // Override the translation column
        data[offset + 12] = srcMat[12] + dx;
        data[offset + 13] = srcMat[13] + dy;
        data[offset + 14] = srcMat[14] + dz;

        // Normal matrix: same as source (translation doesn't change inverse-transpose)
        if (nc) data.set(nc.floats, offset + 16);

        // Material + texture: copy the 16 floats from source's slot (offsets 32–47)
        data.copyWithin(offset + 32, srcOffset + 32, srcOffset + 48);
      }

      this._arrayGroupSourceVers.set(group.id, source.localMatrixVersion);
    }

    this.device.queue.writeBuffer(this.instanceStorageBuffer!, 0, data, 0, needed);
    this._instancesDirty = false;
    this._instanceCount = totalSlots;
  }

  /**
   * Build or rebuild the shared texture_2d_array atlas from all TextureLibrary textures
   * referenced by visible meshes. Layer 0 = white default (for untextured / fallback).
   * Only textures with COPY_SRC usage and matching atlas dimensions are packed; others
   * fall back to the standalone per-mesh bind group with textureIndex = 0.
   */
  private _buildTextureAtlas(meshes: Mesh3D[]): void {
    // Destroy stale atlas textures and bind group
    this._atlasTexture?.destroy();
    this._normalAtlasTexture?.destroy();
    this._atlasTexture       = null;
    this._normalAtlasTexture = null;
    this._atlasBindGroup     = null;
    this._atlasLayerMap.clear();
    this._normalAtlasLayerMap.clear();

    // Collect unique library-sourced textures referenced by visible meshes
    const texMap  = new Map<string, GPUTexture>(); // libId → diffuse
    const normMap = new Map<string, GPUTexture>(); // libId → normal
    for (const m of meshes) {
      if (m.textureLibraryId  && m.diffuseTexture)   texMap.set(m.textureLibraryId,  m.diffuseTexture);
      if (m.normalMapLibraryId && m.normalMapTexture) normMap.set(m.normalMapLibraryId, m.normalMapTexture);
    }

    const buildAtlas = (
      srcMap: Map<string, GPUTexture>,
      layerMap: Map<string, number>,
    ): GPUTexture | null => {
      if (srcMap.size === 0) return null;
      const entries = [...srcMap.entries()];
      const firstTex = entries[0][1];
      const W = firstTex.width;
      const H = firstTex.height;
      const numLayers = 1 + entries.length; // layer 0 = white default

      const atlasTex = this.device.createTexture({
        size: [W, H, numLayers],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

      // Layer 0: solid white (diffuse colour shows through when texture not applied)
      const whiteData = new Uint8Array(W * H * 4).fill(255);
      this.device.queue.writeTexture(
        { texture: atlasTex, origin: { x: 0, y: 0, z: 0 } },
        whiteData,
        { offset: 0, bytesPerRow: W * 4, rowsPerImage: H },
        { width: W, height: H, depthOrArrayLayers: 1 },
      );

      // Layers 1..N: copy each library texture (same-format, same-size only)
      let layerIdx = 1;
      const enc = this.device.createCommandEncoder();
      let anySubmit = false;
      for (const [libId, srcTex] of entries) {
        if (srcTex.width === W && srcTex.height === H && srcTex.format === 'rgba8unorm') {
          enc.copyTextureToTexture(
            { texture: srcTex,   mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
            { texture: atlasTex, mipLevel: 0, origin: { x: 0, y: 0, z: layerIdx } },
            { width: W, height: H, depthOrArrayLayers: 1 },
          );
          layerMap.set(libId, layerIdx);
          layerIdx++;
          anySubmit = true;
        }
        // Mismatched size/format: textureIndex stays 0 (white layer), standalone bind group used instead
      }
      if (anySubmit) this.device.queue.submit([enc.finish()]);
      else           enc.finish(); // discard empty encoder

      return atlasTex;
    };

    this._atlasTexture       = buildAtlas(texMap,  this._atlasLayerMap);
    this._normalAtlasTexture = buildAtlas(normMap, this._normalAtlasLayerMap);

    // Build the shared atlas bind group (texture_2d_array).
    // Falls back to 1×1 defaults if no atlas textures were packed.
    const diffView = (this._atlasTexture ?? this.getDefaultWhiteTex()).createView({ dimension: '2d-array' });
    const normView = (this._normalAtlasTexture ?? this.getDefaultFlatNormalTex()).createView({ dimension: '2d-array' });
    this._atlasBindGroup = this.device.createBindGroup({
      layout: this.pipeline.textureBindGroupLayout,
      entries: [
        { binding: 0, resource: diffView },
        { binding: 1, resource: this.pipeline.nearestSampler },
        { binding: 2, resource: normView },
        { binding: 3, resource: this.pipeline.nearestSampler },
      ],
    });

    this._atlasDirty = false;
  }

  /**
   * Ensure the shared geometry pool is up to date.
   * Returns false if there are no meshes with valid geometry.
   *
   * Pool is rebuilt when:
   *  - Any mesh has gpuDirty = true (geometry changed or newly imported)
   *  - Mesh list order/count changed (mesh added or removed)
   *  - Pool has not been built yet
   */
  private _ensureGeomPool(meshes: Mesh3D[]): boolean {
    const anyGpuDirty = meshes.some(m => m.gpuDirty && !!m.geometry);
    const needsRebuild = anyGpuDirty
      || !this._geomVB
      || meshes.length !== this._geomPoolIds.length
      || meshes.some((m, i) => m.id !== this._geomPoolIds[i]);
    if (!needsRebuild) return this._geomAllocs.size > 0;
    return this._fullRebuildGeomPool(meshes);
  }

  private _fullRebuildGeomPool(meshes: Mesh3D[]): boolean {
    // First pass: compute total sizes counting each unique geometry key once.
    // Meshes sharing the same geometryKey (e.g. 10 default spheres) contribute
    // only one copy of their vertex/index data to the pool.
    const keyToSize = new Map<string, { vtxBytes: number; idxBytes: number }>();
    for (const m of meshes) {
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;
      if (!keyToSize.has(m.geometryKey)) {
        keyToSize.set(m.geometryKey, { vtxBytes: g.vertices.byteLength, idxBytes: g.indices.byteLength });
      }
    }
    if (keyToSize.size === 0) return false;

    let totalVtxBytes = 0;
    let totalIdxBytes = 0;
    for (const { vtxBytes, idxBytes } of keyToSize.values()) {
      totalVtxBytes += vtxBytes;
      totalIdxBytes += idxBytes;
    }

    // Grow shared buffers if current capacity is insufficient (1.5× overprovision).
    if (totalVtxBytes > this._geomVBCap) {
      this._geomVB?.destroy();
      this._geomVBCap = Math.ceil(totalVtxBytes * 1.5);
      this._geomVB = this.device.createBuffer({
        size: this._geomVBCap,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'GeomPool VB',
      });
    }
    if (totalIdxBytes > this._geomIBCap) {
      this._geomIB?.destroy();
      this._geomIBCap = Math.ceil(totalIdxBytes * 1.5);
      this._geomIB = this.device.createBuffer({
        size: this._geomIBCap,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: 'GeomPool IB',
      });
    }

    // Second pass: upload each unique geometry once, assign shared allocs to all instances.
    // keyToAlloc maps geometryKey → pool slot so duplicates reuse the same firstIndex/baseVertex.
    const keyToAlloc = new Map<string, { baseVertex: number; firstIndex: number; indexCount: number }>();
    this._geomAllocs.clear();
    this._geomPoolIds = [];
    let vtxByteOffset = 0;
    let idxByteOffset = 0;

    for (const m of meshes) {
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;

      const key = m.geometryKey;
      let alloc = keyToAlloc.get(key);

      if (!alloc) {
        // New unique geometry — upload it to the pool.
        const baseVertex = vtxByteOffset / MESH3D_VERTEX_STRIDE;
        const firstIndex = idxByteOffset / 4;  // uint32 = 4 bytes per index element
        this.device.queue.writeBuffer(
          this._geomVB!, vtxByteOffset,
          g.vertices.buffer, g.vertices.byteOffset, g.vertices.byteLength,
        );
        this.device.queue.writeBuffer(
          this._geomIB!, idxByteOffset,
          g.indices.buffer, g.indices.byteOffset, g.indices.byteLength,
        );
        alloc = { baseVertex, firstIndex, indexCount: g.indices.length };
        keyToAlloc.set(key, alloc);
        vtxByteOffset += g.vertices.byteLength;
        idxByteOffset += g.indices.byteLength;
      }
      // Shared: all instances of the same geometry point to the same pool slot.
      this._geomAllocs.set(m.id, alloc);
      this._geomPoolIds.push(m.id);
      m.gpuDirty = false;
    }

    return this._geomAllocs.size > 0;
  }

  /**
   * Upload (or re-upload) standalone VB override + color VB for an EditMesh that
   * has vertex colors. Called for every mesh where gpuDirty was true before the pool
   * rebuild — gpuDirty being true is the signal that editMesh was recompiled.
   *
   * The standalone VB override ensures drawIndexed is called with baseVertex=0, so
   * @location(4) color indices align 1:1 with the geometry vertex indices (both 0..N-1).
   */
  private _uploadVCBuffers(mesh: Mesh3D): void {
    const g  = mesh.geometry;
    const vc = mesh.vertexColors;
    if (!g || !vc) return;

    // Standalone geometry VB — own allocation so baseVertex = 0 in drawIndexed
    let vb = this._vertexBufferOverrides.get(mesh.id);
    if (!vb || vb.size < g.vertices.byteLength) {
      vb?.destroy();
      vb = this.device.createBuffer({
        size: g.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: `VC-Geom-${mesh.id}`,
      });
      this._vertexBufferOverrides.set(mesh.id, vb);
    }
    this.device.queue.writeBuffer(vb, 0, g.vertices);

    // Color VB — per-vertex rgba float32x4
    let cb = this._vcColorBuffers.get(mesh.id);
    if (!cb || cb.size < vc.byteLength) {
      cb?.destroy();
      cb = this.device.createBuffer({
        size: vc.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: `VC-Color-${mesh.id}`,
      });
      this._vcColorBuffers.set(mesh.id, cb);
    }
    this.device.queue.writeBuffer(cb, 0, vc);
  }

  // ── Skinned mesh rendering ─────────────────────────────────────

  /**
   * Draw SkinnedMesh3D nodes into the given render pass.
   * Call this from the main renderer AFTER drawMeshes() in the same pass.
   * Each mesh must have skeleton, jointIndices, and jointWeights populated.
   */
  drawSkinnedMeshes(
    pass: GPURenderPassEncoder,
    meshes: SkinnedMesh3D[],
    canvasWidth: number,
    canvasHeight: number,
  ): void {
    const visible = meshes.filter(m => m.isEffectivelyVisible() && m.skeleton);
    if (visible.length === 0) return;

    this.camera.aspect = canvasWidth / canvasHeight;
    this.uploadSceneUniforms(canvasWidth, canvasHeight);

    // Ensure dedicated small instance buffer (one slot per skinned mesh).
    const needed = visible.length * MESH_INSTANCE_STRIDE;
    if (!this._skinnedInstBuf || this._skinnedInstCap < needed) {
      this._skinnedInstBuf?.destroy();
      this._skinnedInstCap = Math.max(needed, MESH_INSTANCE_STRIDE * 4);
      this._skinnedInstBuf = this.device.createBuffer({
        size:  this._skinnedInstCap,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this._skinnedMeshBG = null; // force recreation
    }

    // Upload instance data (transform + material) for each skinned mesh.
    this._uploadSkinnedInstances(visible);

    // Recreate mesh bind group when buffer reference changed.
    if (!this._skinnedMeshBG || this._skinnedMeshBGBuf !== this._skinnedInstBuf) {
      this._skinnedMeshBG = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this._skinnedInstBuf! } },
          { binding: 1, resource: { buffer: this.sceneUniformBuffer } },
        ],
      });
      this._skinnedMeshBGBuf = this._skinnedInstBuf;
    }

    for (let i = 0; i < visible.length; i++) {
      const mesh = visible[i];
      if (!mesh.skeleton) continue;

      this._ensureSkinnedVBIB(mesh);
      this._ensureSkinMatBuf(mesh);

      const vb = this._skinnedVBs.get(mesh.id);
      const ib = this._skinnedIBs.get(mesh.id);
      const skinBG = this._skinBGs.get(mesh.id);
      if (!vb || !ib || !skinBG) continue;

      const useTexture = mesh.material.hasTexture || mesh.material.hasNormalMap;
      pass.setVertexBuffer(0, vb);
      pass.setIndexBuffer(ib, 'uint32');

      if (useTexture) {
        pass.setPipeline(this.pipeline.skinnedOpaqueTexturedPipeline);
        pass.setBindGroup(0, this._skinnedMeshBG!);
        pass.setBindGroup(1, this.createTextureBindGroup(mesh));
        pass.setBindGroup(2, skinBG);
      } else {
        pass.setPipeline(this.pipeline.skinnedOpaqueUntexturedPipeline);
        pass.setBindGroup(0, this._skinnedMeshBG!);
        pass.setBindGroup(1, skinBG);
      }

      pass.drawIndexed(mesh.geometry.indices.length, 1, 0, 0, i);
    }
  }

  /** Upload transform + material data for skinned meshes into the skinned instance buffer. */
  private _uploadSkinnedInstances(meshes: SkinnedMesh3D[]): void {
    const floatsPerInst = MESH_INSTANCE_STRIDE / 4;
    const data     = new Float32Array(meshes.length * floatsPerInst);
    const dataView = new DataView(data.buffer);
    const normalMat = mat4.create();

    for (let i = 0; i < meshes.length; i++) {
      const m  = meshes[i];
      const off = i * floatsPerInst;

      // modelMatrix (floats 0–15)
      data.set(m.localMatrix as Float32Array, off);

      // normalMatrix = inverse-transpose of model (floats 16–31)
      let nc = this._normalMatCache.get(m.id);
      if (!nc) { nc = { matVersion: -1, floats: new Float32Array(16) }; this._normalMatCache.set(m.id, nc); }
      const matVer = m.localMatrixVersion;
      if (nc.matVersion !== matVer) {
        mat4.invert(normalMat, m.localMatrix);
        mat4.transpose(normalMat, normalMat);
        nc.floats.set(normalMat as Float32Array);
        nc.matVersion = matVer;
      }
      data.set(nc.floats, off + 16);

      // diffuse (floats 32–35)
      data[off + 32] = m.material.diffuse.r;
      data[off + 33] = m.material.diffuse.g;
      data[off + 34] = m.material.diffuse.b;
      data[off + 35] = m.material.opacity;

      // specular (floats 36–39)
      data[off + 36] = m.material.specular.r;
      data[off + 37] = m.material.specular.g;
      data[off + 38] = m.material.specular.b;
      data[off + 39] = m.material.shininess;

      // emissive + flags (floats 40–43)
      data[off + 40] = m.material.emissive.r;
      data[off + 41] = m.material.emissive.g;
      data[off + 42] = m.material.emissive.b;
      dataView.setUint32((off + 43) * 4, encodeMaterialFlags(m.material), true);

      // textureIndex / normalMapIndex / pad (uint32 at floats 44–47)
      dataView.setUint32((off + 44) * 4, 0, true);
      dataView.setUint32((off + 45) * 4, 0, true);
    }

    this.device.queue.writeBuffer(this._skinnedInstBuf!, 0, data);
  }

  /** Build or refresh the per-mesh skinned vertex buffer (72-byte stride). */
  private _ensureSkinnedVBIB(mesh: SkinnedMesh3D): void {
    const numVerts = mesh.geometry.vertices.length / 12;
    if (!mesh.skinDirty && this._skinnedVBs.has(mesh.id)) return;

    // Build interleaved 72-byte buffer.
    const STRIDE = SKINNED_MESH3D_VERTEX_STRIDE;
    const buf = new ArrayBuffer(numVerts * STRIDE);
    const f32 = new Float32Array(buf);
    const u8  = new Uint8Array(buf);

    for (let v = 0; v < numVerts; v++) {
      const floatBase = v * (STRIDE / 4);  // 18 floats per vertex
      const byteBase  = v * STRIDE;

      // Standard 12 floats: position(3) + normal(3) + uv(2) + tangent(4)
      for (let f = 0; f < 12; f++) {
        f32[floatBase + f] = mesh.geometry.vertices[v * 12 + f];
      }

      // Joint indices as uint8 at byte offset 48–51
      u8[byteBase + 48] = mesh.jointIndices[v * 4 + 0] ?? 0;
      u8[byteBase + 49] = mesh.jointIndices[v * 4 + 1] ?? 0;
      u8[byteBase + 50] = mesh.jointIndices[v * 4 + 2] ?? 0;
      u8[byteBase + 51] = mesh.jointIndices[v * 4 + 3] ?? 0;

      // Joint weights as float32 at byte offset 52 (float index floatBase + 13)
      f32[floatBase + 13] = mesh.jointWeights[v * 4 + 0] ?? 0;
      f32[floatBase + 14] = mesh.jointWeights[v * 4 + 1] ?? 0;
      f32[floatBase + 15] = mesh.jointWeights[v * 4 + 2] ?? 0;
      f32[floatBase + 16] = mesh.jointWeights[v * 4 + 3] ?? 0;
      // floatBase + 12 covers bytes 48–51 (joint indices, written via u8 above — leave as is)
      // floatBase + 17 covers bytes 68–71 (padding — stays zero)
    }

    const vb = this.device.createBuffer({
      size:  buf.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vb, 0, buf);
    this._skinnedVBs.get(mesh.id)?.destroy();
    this._skinnedVBs.set(mesh.id, vb);

    const idxData = mesh.geometry.indices;
    const ib = this.device.createBuffer({
      size:  idxData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(ib, 0, idxData.buffer, idxData.byteOffset, idxData.byteLength);
    this._skinnedIBs.get(mesh.id)?.destroy();
    this._skinnedIBs.set(mesh.id, ib);

    mesh.skinDirty = false;
  }

  /** Ensure the per-mesh skin-matrix GPU buffer is sized correctly and upload current matrices. */
  private _ensureSkinMatBuf(mesh: SkinnedMesh3D): void {
    const skel = mesh.skeleton!;
    const jointCount = skel.data.joints.length;
    const byteSize   = jointCount * 64; // 16 floats × 4 bytes per mat4

    let entry = this._skinMatBufs.get(mesh.id);
    if (!entry || entry.jointCount !== jointCount) {
      entry?.buf.destroy();
      const skinBuf = this.device.createBuffer({
        size:  Math.max(byteSize, 64),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      entry = { buf: skinBuf, jointCount };
      this._skinMatBufs.set(mesh.id, entry);

      // (Re)create the bind group for this mesh's skin buffer.
      const bg = this.device.createBindGroup({
        layout: this.pipeline.skinBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: skinBuf } }],
      });
      this._skinBGs.set(mesh.id, bg);
    }

    this.device.queue.writeBuffer(entry.buf, 0, skel.skinMatrices);
    skel.matricesDirty = false;
  }

  // ── Cleanup ────────────────────────────────────────────────────

  destroy(): void {
    this.sceneUniformBuffer.destroy();
    this.instanceStorageBuffer?.destroy();
    this._shadowTexture?.destroy();
    this._defaultWhiteTex?.destroy();
    this._defaultFlatNormalTex?.destroy();
    this._outlinePass?.destroy();
    this._geomVB?.destroy();
    this._geomIB?.destroy();
    this._atlasTexture?.destroy();
    this._normalAtlasTexture?.destroy();
    this._particleSceneUniBuf?.destroy();
    this._particleInstBuf?.destroy();
    this._bloomPass?.destroy();
    this._geomAllocs.clear();
    this._meshInstanceSlots.clear();
    this._atlasLayerMap.clear();
    this._normalAtlasLayerMap.clear();
    this._texBindGroupCache.clear();
    this._meshAABBCache.clear();
    this._normalMatCache.clear();
    this._gizmoRenderer?.destroy();
    // Skinned mesh buffers
    this._skinnedVBs.forEach(b => b.destroy());
    this._skinnedIBs.forEach(b => b.destroy());
    this._skinMatBufs.forEach(e => e.buf.destroy());
    this._skinnedInstBuf?.destroy();
  }
}
