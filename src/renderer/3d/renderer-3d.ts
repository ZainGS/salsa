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
import { Mesh3D, Submesh3D } from '../../scene-graph/shapes/mesh-3d';
import { ArrayGroup3D, computeArrayOffsets, getArrayInstanceCount, resolveArraySpacing, hashRand, LocalBasis3 } from '../../scene-graph/shapes/array-group-3d';
import { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';
import { GizmoRenderer, GizmoMode, GizmoAxis, ArrayGizmoData, ArrayHandleHit, FaceHandleData, IKHandleHit, type SnapViz3D } from './gizmo-renderer';
import { GhostPreviewRenderer, GhostPreviewData } from './ghost-preview-renderer';
import { MeshEditOverlayRenderer, type MeshEditDrawData } from './mesh-edit-overlay-renderer';
import { WeightPaintVertexOverlayRenderer } from './weight-paint-overlay-renderer';
import { FrustumCuller } from './frustum-culler';
import { OutlinePass } from './outline-pass';
import { MeshHighlightPass } from './mesh-highlight-pass';
import { BloomPass, createBloomCapturePipeline } from './bloom-pass';
import { PostProcessPass, PostProcessConfig, DEFAULT_POST_PROCESS_CONFIG } from './post-process-pass';
export type { PostProcessConfig } from './post-process-pass';
export { DEFAULT_POST_PROCESS_CONFIG } from './post-process-pass';
import { LoFiPass } from './lofi-pass';
import { ArmatureBgPass } from './armature-bg-pass';
import type { ArmatureBgOptions } from '../../types/armature-3d';
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

/** One draw-list entry (a mesh + its instance slot, optionally a submesh). Pooled + reused per frame. */
type RendererDrawEntry = { mesh: Mesh3D; idx: number; submesh?: Submesh3D; count?: number; ord?: number };   // count>1 = one instanced-range entry (opaque array groups) instead of N per-instance entries; ord = cached draw rank

/** World-space axis-aligned bounding box. */
type AABB3 = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };

export interface PS1Config {
  /** Vertex jitter strength (0 = off, 1 = full). */
  vertexJitter: number;
  /** Snap grid size in virtual pixels (e.g. 160 for authentic PS1). 0 = off. */
  snapGridSize: number;
  /** Affine texture mapping strength (0 = perspective-correct, 1 = full affine). */
  affineStrength: number;
  /** Color quantization levels per channel (32 = 5-bit PS1, 0 = off). */
  colorDepth: number;

  // ── Lo-fi render buffer ───────────────────────────────────────────────────
  /** Explicit low-res render target size [w, h]. Takes precedence over renderScale. */
  renderResolution?: [number, number];
  /** Fractional scale of canvas (0.1–1.0). Ignored when renderResolution is set. */
  renderScale?: number;

  // ── Bayer dithering ───────────────────────────────────────────────────────
  /** Enable Bayer dithering (pairs with colorDepth). Default false. */
  dither?: boolean;
  /** Dithering pattern strength, 0–1. Default 0.5. */
  ditherStrength?: number;

  // ── UV quantization ───────────────────────────────────────────────────────
  /** Snap UVs to a fixed grid before texture sampling (PS1 texel crawl). Default false. */
  uvQuantize?: boolean;
  /** Grid resolution for UV snap (default 64). */
  uvQuantizeSteps?: number;
}

export const DEFAULT_PS1_CONFIG: PS1Config = {
  vertexJitter: 0,
  snapGridSize: 0,
  affineStrength: 0,
  colorDepth: 0,
};

export interface FogConfig {
  /** Fog color (RGB 0–1). */
  color: [number, number, number];
  /** Fog mode: 'off' | 'linear' | 'exponential'. */
  mode: 'off' | 'linear' | 'exponential';
  /** Linear fog: distance at which fog starts. */
  near: number;
  /** Linear fog: distance at which fog is fully opaque. */
  far: number;
  /** Exponential fog: density factor. */
  density: number;
}

export const DEFAULT_FOG_CONFIG: FogConfig = {
  color: [0.8, 0.8, 0.8],
  mode: 'off',
  near: 5,
  far: 20,
  density: 0.1,
};

/** Wobble aesthetic preset — pass to setPS1() to enable the retro lo-fi look. */
export const WOBBLE_PRESET: PS1Config = {
  vertexJitter: 0.8,
  snapGridSize: 160,
  affineStrength: 0.6,
  colorDepth: 32,
  renderResolution: [320, 240],
  dither: true,
  ditherStrength: 0.45,
  uvQuantize: true,
  uvQuantizeSteps: 64,
};

/** Pocket aesthetic preset — clean lo-fi, stable verts, low-res buffer. */
export const POCKET_PRESET: PS1Config = {
  vertexJitter: 0,
  snapGridSize: 512,
  affineStrength: 0,
  colorDepth: 256,
  renderResolution: [400, 240],
  dither: false,
  uvQuantize: false,
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
 * fogColor:        vec4   = 16 bytes (floats 60-63)  .rgb=fog color
 * fogParams:       vec4   = 16 bytes (floats 64-67)  .x=near .y=far .z=density .w=mode
 * Total = 272 bytes → pad to 288 (16-byte aligned)
 */
// 72 base floats + lightCounts vec4 + 16 POINT LIGHTS × 2 vec4s (posRadius, colorIntensity) = 204 floats.
const SCENE_UNIFORM_SIZE_PADDED = 816;
const MAX_POINT_LIGHTS = 16;

/** Size of one MeshInstance in the storage buffer (must match the WGSL struct stride in ALL 9 declarations). */
// modelMatrix(64) + normalMatrix(64) + diffuse(16) + specular(16) + emissive(16)
// + textureIndex(4) + normalMapIndex(4) + roughness(4) + metalness(4) = 192
// + patternColor(16) + patternParams(16) = 224 bytes
const MESH_INSTANCE_STRIDE = 224;   // 56 floats; patternColor @48-51, patternParams (freq,angle,scale,spacing) @52-55

/** A geometry-pool allocation: where a unique geometry lives (draw params) + its byte spans (for the free-list). */
type GeomAlloc = { baseVertex: number; firstIndex: number; indexCount: number; vtxBytes: number; idxBytes: number };

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
  private _fog: FogConfig = { ...DEFAULT_FOG_CONFIG };
  // Enhanced-visuals toggles (togglable for perf; default OFF = the current look). Written into free uniform slots.
  private _glassQuality = 0;   // stylized fresnel-glass on glass surfaces (ps1Config2.w)
  private _aerialFog = 0;      // aerial-perspective desaturation strength 0..1 (fogColor.w)

  // GPU buffers
  private sceneUniformBuffer: GPUBuffer;
  private instanceStorageBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private meshBindGroup: GPUBindGroup | null = null;
  // Tracks which buffer the cached bind group is bound to; null = needs recreation.
  private _meshBindGroupBuffer: GPUBuffer | null = null;

  // ── Per-frame draw-list scratch (POOLED — the city renders ~700 meshes EVERY frame; building fresh
  //    DrawEntry objects + filter/Set/spread arrays each frame was steady GC pressure that scaled with
  //    mesh count). The pool grows to the high-water mark and is reused; the lists are length-reset. ──
  private readonly _drawPool: RendererDrawEntry[] = [];
  private _drawPoolN = 0;
  private readonly _opaque: RendererDrawEntry[] = [];
  private readonly _transparent: RendererDrawEntry[] = [];
  private readonly _opaqueForPasses: RendererDrawEntry[] = [];
  private readonly _opaqueVC: RendererDrawEntry[] = [];
  private readonly _opaqueSimple: RendererDrawEntry[] = [];
  // Cached (pipelineKey, geometryKey) draw rank per mesh — rebuilt only on structural change (see the sort site).
  private readonly _drawOrder = new Map<string, number>();
  private _drawOrderDirty = true;
  private _drawOrderDS = false;
  private readonly _opaqueMulti: RendererDrawEntry[] = [];
  private readonly _opaqueSeen = new Set<string>();
  private readonly _meshById = new Map<string | number, Mesh3D>();   // rebuilt per frame in uploadMeshInstances → O(1) array-group source lookups (was meshes.find per group = O(groups×meshes))
  private readonly _vcDirtyIds = new Set<string>();
  /** Reused world-AABB return for the per-frame frustum-cull loop (~700 meshes) — see getMeshWorldAABB3D. */
  private readonly _aabbScratch: AABB3 = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  /** Persistent frustum culler — planes rewritten in place each frame (was a fresh culler + 6 planes/frame). */
  private readonly _culler = new FrustumCuller();
  // Particle draw scratch (only allocates once; particles run every frame during city weather — rain/snow).
  private _particleSceneData: Float32Array | null = null;
  private readonly _particleVisibleScratch: ParticleEmitter3D[] = [];
  private readonly _particleActiveScratch: ParticleEmitter3D[] = [];
  private readonly _particleFirstInstances: number[] = [];
  /** Grab a reused pooled entry (never allocates once warmed) and append it to `list`. */
  private _pushDraw(list: RendererDrawEntry[], mesh: Mesh3D, idx: number, submesh?: Submesh3D, count = 1): void {
    let e = this._drawPool[this._drawPoolN];
    if (e === undefined) { e = { mesh, idx, submesh, count }; this._drawPool[this._drawPoolN] = e; }
    else { e.mesh = mesh; e.idx = idx; e.submesh = submesh; e.count = count; }
    this._drawPoolN++;
    list.push(e);
  }

  // Instance upload dirty tracking — avoid re-uploading every frame when nothing moved.
  private _instancesDirty = true;
  private _transformsDirty = false;                    // transforms-only fast path (city traffic)
  private _slotMatVer = new Map<string | number, number>();   // meshId → localMatrixVersion last written to its slot(s)
  private readonly _fpTouched: number[] = [];          // reused scratch: slots written by the transforms/material fast path this frame (coalesced into upload runs)
  private _shadowUpdateInterval = 1;                   // render the shadow map every N frames
  private _shadowFramesSince = 999;                    // frames since the last shadow render (first frame renders)
  private _shadowMapStale = true;                      // structural change → refresh the map now
  private _instanceCount = 0;
  private _instanceFreeSlots: number[] = [];   // instance slots freed by evicted meshes — reused by the incremental add path (no full repack)
  private _instanceHigh = 0;                    // high-water instance slot (append point when the free list is empty)
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
  // groupId → object-offset mesh localMatrixVersion at last upload
  private _arrayGroupOffsetVers = new Map<string, number>();

  // Source-link feedback: when a source mesh is selected, instance slots for its groups get a faint highlight.
  private _selectedSourceId: string | null = null;
  // Scratch 4×4 matrix used when applying per-instance overrides — pre-allocated to avoid GC.
  private _overrideScratch = mat4.create() as Float32Array;

  // Pre-allocated scene uniform staging buffer (256 bytes, reused every frame).
  private _sceneUniformsData = new Float32Array(SCENE_UNIFORM_SIZE_PADDED / 4);

  // Geometry pool: all mesh vertex/index data packed into two shared GPUBuffers.
  // Eliminates N×(setVertexBuffer + setIndexBuffer) state switches per frame;
  // callers use (firstIndex, baseVertex) in drawIndexed to address each mesh's slice.
  private _geomVB: GPUBuffer | null = null;
  private _geomIB: GPUBuffer | null = null;
  private _geomVBCap = 0;  // allocated byte capacity
  private _geomIBCap = 0;
  private _geomAllocs = new Map<string, GeomAlloc>();
  private _geomPoolIds: string[] = [];  // ordered mesh IDs at last pool build (change detection)
  // APPEND-ONLY pool bookkeeping: geometry is uploaded once per unique geometryKey and never re-uploaded when
  // NEW meshes appear — they append at the tail (or dedupe onto an existing key). This is what lets a city
  // regen / async reveal cost only the NEW geometry instead of re-uploading the whole ~12 MB pool every frame.
  // A geometryKey is REF-COUNTED across the meshes that share it; when the last one is evicted (a streamed tile
  // disposed) its buffer region joins `_geomFree`, and the next append REUSES a fitting free region instead of
  // growing the tail. That keeps the tail bounded under streaming churn → no periodic full-rebuild hitch. A full
  // rebuild (COMPACT) still coalesces fragmentation, but now only on idle / genuine overflow, not mid-pan.
  private _geomKeyAllocs = new Map<string, GeomAlloc>();
  private readonly _geomKeyRefs = new Map<string, number>();   // geometryKey → # of live meshes using it
  private readonly _geomMeshKey = new Map<string, string>();   // meshId → geometryKey (to decrement on evict)
  private _geomFree: Array<{ vtxOff: number; vtxBytes: number; idxOff: number; idxBytes: number }> = [];   // freed regions (paired vtx+idx spans) for reuse
  private _geomVtxTail = 0;   // byte offset where the next vertex append lands
  private _geomIdxTail = 0;   // byte offset where the next index append lands
  private static readonly GEOM_OVERPROVISION = 2.5;   // buffer headroom over live size → appends before a compaction

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

  // Per-array-group world AABB (over all instance positions + canonical extent) for whole-group frustum culling.
  // Cached per source localMatrixVersion. Only 'explicit' groups get a box (city detail); others return null = never
  // group-culled. City-WIDE groups span everything → box never fails the frustum = no-op (safe with detailGrid=0).
  private _agAABBCache = new Map<string, { ver: number; box: [number, number, number, number, number, number] | null }>();

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

  // IBL uniform buffer (160 bytes: 9×vec4 SH coefficients + iblEnabled + iblIntensity + pad)
  private _iblUniformBuffer: GPUBuffer | null = null;
  // Staging data: floats 0-35 = SH coeffs (9×4), 36 = iblEnabled, 37 = iblIntensity, 38-39 = pad
  private _iblData = new Float32Array(40);
  private _iblEnabled = false;
  private _iblIntensity = 1.0;

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
  // Per-SKELETON skin-matrix storage buffer (array<mat4x4f>, one mat per joint). Keyed by skeleton id:
  // the ~9 meshes of one character (body + garments + hair + decal) share ONE buffer + one upload per
  // dirty frame, instead of one buffer + one writeBuffer each.
  private _skinMatBufs = new Map<string, { buf: GPUBuffer; jointCount: number }>();
  // Per-SKELETON skin bind group (single entry: the shared skinMatrices storage buffer).
  private _skinBGs = new Map<string, GPUBindGroup>();
  // Refcounts for the shared per-skeleton buffers: skeletonId → number of meshes registered on it, and
  // meshId → the skeletonId it registered against (so eviction can release the right entry even after
  // the mesh object is gone). The buffer is destroyed only when the LAST mesh using it is evicted.
  private _skelBufRefs = new Map<string, number>();
  private _meshSkelRef = new Map<string, string>();
  // Skeletons whose shared buffer was already uploaded during the current drawSkinnedMeshes call —
  // keeps the upload at ONE writeBuffer per dirty skeleton per frame (matricesDirty itself must stay
  // set until every mesh has drawn; see drawSkinnedMeshes).
  private _skinBufUploaded = new Set<string>();
  // Per-mesh weight-paint color storage buffer + bind group (set when vertexColors is populated).
  private _skinnedVCBufs = new Map<string, GPUBuffer>();
  private _skinnedVCBGs  = new Map<string, GPUBindGroup>();
  // Separate small instance buffer for skinned meshes (one slot per skinned mesh).
  private _skinnedInstBuf: GPUBuffer | null = null;
  private _skinnedInstCap = 0;
  private _skinnedMeshBG: GPUBindGroup | null = null;
  private _skinnedMeshBGBuf: GPUBuffer | null = null;
  // Reused CPU-side scratch for the skinned instance upload (was a fresh Float32Array + DataView + 2 mat4
  // every frame — character-mode churn). Grown only when the mesh count grows; the DataView tracks its buffer.
  private _skinnedInstData: Float32Array | null = null;
  private _skinnedInstDataView: DataView | null = null;
  private readonly _skinnedNormalMat = mat4.create();
  private readonly _skinnedIdent = mat4.create();   // identity (mat4.create() IS identity) — never mutated
  private readonly _skinnedVisibleScratch: SkinnedMesh3D[] = [];
  // Reused scratch for computeLightSpaceMatrix (ran every frame while shadows are on — city + character).
  private readonly _lsmEye = vec3.create();
  private readonly _lsmCenter = vec3.create();   // always origin
  private readonly _lsmUp = vec3.create();
  private readonly _lsmView = mat4.create();
  private readonly _lsmProj = mat4.create();
  private readonly _lsmMatrix = mat4.create();

  // Per-mesh normal matrix cache: inverse-transpose of model matrix.
  // Recomputed only when localMatrixVersion changes — avoids mat4.invert + mat4.transpose
  // for every mesh in the scene whenever any single mesh moves.
  private _normalMatCache = new Map<string, { matVersion: number; floats: Float32Array }>();
  /** Last view matrix digest used for billboard re-upload gating. */
  private _lastBillboardView = new Float32Array(16);
  private _billboardViewDirty = true;

  // Gizmo rendering
  private _gizmoRenderer?: GizmoRenderer;
  private _meshEditOverlay?: MeshEditOverlayRenderer;
  private _meshEditDataFn?: () => MeshEditDrawData | null;
  private _selectedMeshIds:    Set<string> = new Set();
  private _hoveredMeshIds:     Set<string> = new Set();
  private _hoveredArrayGroupId: string | null = null;
  private _gizmoMode: GizmoMode = 'move';
  private _hoveredAxis: GizmoAxis = null;
  private _draggingAxis: GizmoAxis = null;
  private _hoveredCorner: number | null = null;

  // Ground reference grid (Y=0). Spacing tracks the transform snap size (pushed from scene3d-manager).
  private _gridVisible = false;
  private _gridColor: [number, number, number] = [0.42, 0.42, 0.5];
  private _gridOpacity = 0.32;
  private _gridSpacing = 1.0;

  // Vertex-snap viz: pull-based provider (set by scene3d-manager → transform controller's snapViz).
  private _snapVizProvider: (() => SnapViz3D | null) | null = null;

  // Bone overlay (for selected SkinnedMesh3D)
  private _boneOverlaySkeleton: Skeleton3D | null = null;
  private _hoveredJointIdx: number | null = null;
  private _selectedJointIdx: number | null = null;
  private _selectedJointIsTail = false;
  // True while the user is actively placing a bone (between clicks). Suppresses
  // the joint translation gizmo so it doesn't distract during bone drawing.
  private _bonePlacementActive = false;
  private _jointGizmoHoveredAxis: import('./gizmo-renderer').GizmoAxis = null;
  private _jointGizmoDraggingAxis: import('./gizmo-renderer').GizmoAxis = null;
  private _hoveredTailJointIdx: number | null = null;
  // Programmatic joint highlight (set by UI hover, independent of canvas pointer hover)
  private _programmaticHoverJoint: number | null = null;

  // Armature tool mode — controls which joint gizmo renders
  private _armatureToolMode: 'move' | 'rotate' = 'move';

  // IK handle hover/drag state
  private _hoveredIKHandle: IKHandleHit | null = null;
  private _draggingIKHandle: IKHandleHit | null = null;

  // Weight paint overlay
  private _wpVertexOverlay?: WeightPaintVertexOverlayRenderer;
  private _weightPaintActive = false;
  private _weightPaintShowSkeleton = true;
  private _weightPaintUnlit = false;
  private _wpMesh: SkinnedMesh3D | null = null;
  private _wpBrushCenter: [number, number, number] | null = null;
  private _wpBrushRadius = 0;

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

  // ── Armature focus background ──────────────────────────────────────────────
  private _armatureBgPass: ArmatureBgPass | null = null;
  private _armatureBgOpts: ArmatureBgOptions = { mode: 'wavy' };
  private _armatureModeActive = false;

  // ── Mesh-edit / UV focus background ────────────────────────────────────────
  // Same full-screen background system as armature, shown while editing/painting a
  // mesh so the 2D illustration content behind it is hidden for a clean workspace.
  private _meshEditBgActive = false;
  private _meshEditBgOpts: ArmatureBgOptions = { mode: 'wavy' };

  // ── Global scene background (Skybox) ───────────────────────────────────────
  private _sceneBgPass: ArmatureBgPass | null = null;
  private _sceneBgOpts: ArmatureBgOptions = { mode: 'none' };

  // Post-processing stack
  private _postProcessPass: PostProcessPass | null = null;

  // Lo-fi render buffer (PS1/3DS low-res + nearest-neighbor blit)
  private _loFiPass: LoFiPass | null = null;

  constructor(device: GPUDevice, camera: Camera3D, swapChainFormat: GPUTextureFormat = 'bgra8unorm') {
    this.device = device;
    this.camera = camera;
    this._swapChainFormat = swapChainFormat;
    this.pipeline = new Pipeline3D(device, swapChainFormat);
    this._highlightPass = new MeshHighlightPass(device, this.pipeline.meshBindGroupLayout, swapChainFormat);
    this._ghostPreviewRenderer = new GhostPreviewRenderer(device, swapChainFormat);
    this._armatureBgPass = new ArmatureBgPass(device, swapChainFormat);
    this._sceneBgPass = new ArmatureBgPass(device, swapChainFormat);

    // Create scene uniform buffer (updated every frame)
    this.sceneUniformBuffer = device.createBuffer({
      size: SCENE_UNIFORM_SIZE_PADDED,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // IBL uniform buffer — written once when env map changes, otherwise default "no-IBL" state
    this._iblUniformBuffer = device.createBuffer({
      size: 160,  // 9×vec4(16) + iblEnabled(4) + iblIntensity(4) + pad(8)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'IBLUniforms',
    });
    this._writeIBLBuffer();
  }

  // ── Public configuration ───────────────────────────────────────

  get ps1Config(): PS1Config { return this._ps1; }
  set ps1Config(c: PS1Config) { this._ps1 = { ...c }; }

  setPS1(partial: Partial<PS1Config>): void {
    Object.assign(this._ps1, partial);
  }

  get fogConfig(): FogConfig { return this._fog; }

  setFog(config: Partial<FogConfig>): void {
    Object.assign(this._fog, config);
  }

  // ── Enhanced-visuals toggles (default off; live — a uniform flip, no regen) ──
  /** Stylized fresnel sky-reflection on glass surfaces (glass towers/storefronts). */
  setGlassQuality(on: boolean): void { this._glassQuality = on ? 1 : 0; }
  get glassQuality(): boolean { return this._glassQuality > 0.5; }
  /** Aerial-perspective strength 0..1 — distant geometry desaturates + fades to the fog colour (needs fog on). */
  setAerialFog(strength: number): void { this._aerialFog = Math.max(0, Math.min(1, strength)); }
  get aerialFog(): number { return this._aerialFog; }

  setSceneBg(opts: ArmatureBgOptions): void {
    this._sceneBgOpts = opts;
  }

  get sceneBgOptions(): ArmatureBgOptions { return { ...this._sceneBgOpts }; }

  setTextureFilterMode(mode: 'nearest' | 'linear'): void {
    this.pipeline.setFilterMode(mode);
    this._texBindGroupCache.clear();
    this._atlasBindGroup = null;
  }

  // ── IBL / Environment map ──────────────────────────────────────

  get iblEnabled(): boolean { return this._iblEnabled; }

  /**
   * Set an equirectangular HDR or LDR environment map for image-based lighting.
   * Computes SH L0+L1+L2 irradiance coefficients from the ImageData and uploads
   * them to the IBL uniform buffer used by the PBR fragment shaders.
   * @param imageData  RGBA ImageData from a canvas drawImage call
   * @param intensity  IBL contribution scale (default 1.0)
   */
  setEnvironmentMap3D(imageData: ImageData, intensity = 1.0): void {
    this._iblEnabled   = true;
    this._iblIntensity = intensity;
    const sh = this._computeSHCoeffs(imageData);
    // Pack 9 RGB coefficients into 9 vec4 slots (w = 0)
    for (let i = 0; i < 9; i++) {
      this._iblData[i * 4]     = sh[i * 3];
      this._iblData[i * 4 + 1] = sh[i * 3 + 1];
      this._iblData[i * 4 + 2] = sh[i * 3 + 2];
      this._iblData[i * 4 + 3] = 0;
    }
    this._iblData[36] = 1.0;
    this._iblData[37] = intensity;
    this._writeIBLBuffer();
  }

  /** Remove the environment map and fall back to the constant scene.ambientColor. */
  clearEnvironmentMap3D(): void {
    this._iblEnabled = false;
    this._iblData.fill(0);
    this._iblData[36] = 0.0;
    this._iblData[37] = 1.0;
    this._writeIBLBuffer();
  }

  // ── Post-processing ────────────────────────────────────────────

  /** Update one or more post-processing effect settings. */
  setPostProcessing(config: Partial<PostProcessConfig>): void {
    if (!this._postProcessPass) {
      this._postProcessPass = new PostProcessPass(this.device, this._swapChainFormat);
    }
    const pp = this._postProcessPass.config;
    if (config.bloom)      Object.assign(pp.bloom,      config.bloom);
    if (config.colorGrade) Object.assign(pp.colorGrade, config.colorGrade);
    if (config.vignette)   Object.assign(pp.vignette,   config.vignette);
  }

  /** Return the current post-processing configuration (a live reference). */
  getPostProcessConfig(): PostProcessConfig {
    if (!this._postProcessPass) return { ...DEFAULT_POST_PROCESS_CONFIG };
    return this._postProcessPass.config;
  }

  /**
   * Run post-process effects into an output texture.
   * Called by WebGPURenderer after passEncoder.end(), inside the same command encoder.
   * Returns the output GPUTexture (copy this to swapchain instead of srcTex), or null
   * if all effects are disabled (caller keeps using srcTex unchanged).
   */
  runPostProcess(encoder: GPUCommandEncoder, srcTex: GPUTexture, w: number, h: number): GPUTexture | null {
    return this._postProcessPass?.run(encoder, srcTex, w, h) ?? null;
  }

  // ── Lo-fi render buffer ────────────────────────────────────────

  /**
   * Compute the lo-res render dimensions from the current PS1Config.
   * Returns [w, h] when lo-res is active, null when full-res should be used.
   */
  getLoResSize(canvasW: number, canvasH: number): [number, number] | null {
    const { renderResolution, renderScale } = this._ps1;
    if (renderResolution && renderResolution[0] > 0 && renderResolution[1] > 0) {
      return renderResolution;
    }
    if (renderScale && renderScale > 0 && renderScale < 1) {
      return [Math.max(1, Math.round(canvasW * renderScale)), Math.max(1, Math.round(canvasH * renderScale))];
    }
    // DYNAMIC RESOLUTION (piggybacks the PS1 lo-res path, but with a LINEAR upscale so it reads as full-res):
    // while the camera is panning a streamed world, the scene renders at a reduced scale — ~40% less fragment
    // work — and snaps back to native when the view settles. PS1's own lo-res config takes precedence above.
    if (this._dynResScale < 1) {
      return [Math.max(1, Math.round(canvasW * this._dynResScale)), Math.max(1, Math.round(canvasH * this._dynResScale))];
    }
    return null;
  }

  private _dynResScale = 1;
  /** Dynamic-resolution scale (0.25–1). <1 routes 3D through the lo-res buffer with a LINEAR (smooth) upscale —
   *  the "drop render scale while the camera moves" trick. 1 restores native rendering. No-op while a PS1 lo-res
   *  config is active (that path already renders lo-res, deliberately chunky). */
  setDynamicResScale(s: number): void {
    this._dynResScale = Math.min(1, Math.max(0.25, s));
  }

  /**
   * Begin a render pass targeting the lo-res texture.
   * @param encoder  A command encoder. Must NOT be the one with the main render pass
   *                 open (WebGPU forbids two open passes on one encoder) — the caller
   *                 uses a dedicated encoder and submits it before blitting.
   * @param w        Lo-res width (from getLoResSize).
   * @param h        Lo-res height.
   * @param clearColor  Background clear color (default transparent black).
   * @returns A GPURenderPassEncoder — call .end() when all 3D draws are done.
   */
  beginLowResRenderPass(
    encoder: GPUCommandEncoder,
    w: number,
    h: number,
    clearColor: GPUColor = { r: 0, g: 0, b: 0, a: 0 },
  ): GPURenderPassEncoder {
    if (!this._loFiPass) {
      this._loFiPass = new LoFiPass(this.device, this._swapChainFormat);
    }
    // PS1 lo-res = deliberate chunky pixels (nearest); dynamic-resolution lo-res = a perf trick that should be
    // invisible (linear). PS1 config wins when both are active (matches getLoResSize precedence).
    const { renderResolution, renderScale } = this._ps1;
    const ps1LoRes = !!(renderResolution && renderResolution[0] > 0 && renderResolution[1] > 0)
      || !!(renderScale && renderScale > 0 && renderScale < 1);
    this._loFiPass.linearFilter = !ps1LoRes && this._dynResScale < 1;
    return this._loFiPass.beginRenderPass(encoder, w, h, clearColor);
  }

  /**
   * Blit the lo-res 3D result into the active main render pass using nearest-neighbor upscaling.
   * Call this after the lo-res pass has ended, while the main pass is active.
   */
  blitLowResToPass(pass: GPURenderPassEncoder): void {
    this._loFiPass?.blitToRenderPass(pass);
  }

  private _writeIBLBuffer(): void {
    if (this._iblUniformBuffer) {
      this.device.queue.writeBuffer(this._iblUniformBuffer, 0, this._iblData);
    }
  }

  /**
   * Project an equirectangular env map onto L0+L1+L2 SH basis (9 × RGB).
   * Returns Float32Array of 27 floats: [r0,g0,b0, r1,g1,b1, ..., r8,g8,b8].
   * Coefficients are pre-multiplied by Ramamoorthi & Hanrahan (2001) cosine-lobe
   * ZH factors so the GPU evaluation is a direct polynomial in the surface normal.
   */
  private _computeSHCoeffs(imageData: ImageData): Float32Array {
    const { width: W, height: H, data: pixels } = imageData;
    const raw = new Float32Array(27);
    let totalW = 0;

    for (let py = 0; py < H; py++) {
      const theta = Math.PI * (py + 0.5) / H;
      const sinT  = Math.sin(theta);
      const cosT  = Math.cos(theta);
      const dw    = sinT * (Math.PI / H) * (2 * Math.PI / W);  // solid angle per pixel

      for (let px = 0; px < W; px++) {
        const phi = 2 * Math.PI * (px + 0.5) / W;
        // Cartesian direction (Y-up)
        const nx = sinT * Math.sin(phi);
        const ny = cosT;
        const nz = sinT * Math.cos(phi);

        const pi = (py * W + px) * 4;
        // Approximate sRGB → linear
        const r = (pixels[pi]     / 255) ** 2.2;
        const g = (pixels[pi + 1] / 255) ** 2.2;
        const b = (pixels[pi + 2] / 255) ** 2.2;

        // SH basis × A_l cosine convolution (Ramamoorthi & Hanrahan 2001, Table 2)
        // K[] = A_l × SH_normalization for each of the 9 basis polynomials
        const K0 = 0.886227;                // band 0: A0 × Y00_norm
        const K1 = 1.023327;                // band 1: A1 × Y1x_norm
        const K2 = 0.858086;                // band 2 cross: A2 × Y2x_norm (m≠0)
        const K3 = 0.743125;                // band 2: A2 × Y20_norm
        const K4 = 0.429043;                // band 2: A2 × Y22_norm

        const basis = [
          K0,                              // Y00 = constant
          K1 * ny,                         // Y1,-1
          K1 * nz,                         // Y10
          K1 * nx,                         // Y11
          K2 * nx * ny,                    // Y2,-2
          K2 * ny * nz,                    // Y2,-1
          K3 * (3 * nz * nz - 1),          // Y20
          K2 * nx * nz,                    // Y21
          K4 * (nx * nx - ny * ny),        // Y22
        ];

        totalW += dw;
        for (let i = 0; i < 9; i++) {
          const w = basis[i] * dw;
          raw[i * 3]     += r * w;
          raw[i * 3 + 1] += g * w;
          raw[i * 3 + 2] += b * w;
        }
      }
    }

    // Normalize: totalW should equal 4π for a full-sphere equirectangular map
    const norm = (4 * Math.PI) / totalW;
    for (let i = 0; i < raw.length; i++) raw[i] *= norm;
    return raw;
  }

  get ambientConfig(): { color: [number, number, number]; intensity: number } {
    return { color: [...this._ambientColor] as [number, number, number], intensity: this._ambientIntensity };
  }

  get lightConfig(): { direction: [number, number, number]; color: [number, number, number]; intensity: number } {
    return { direction: [...this._light.direction] as [number, number, number], color: [...this._light.color] as [number, number, number], intensity: this._light.intensity };
  }

  get textureFilterMode(): 'nearest' | 'linear' { return this.pipeline.filterMode; }

  get shadowMapSize(): number { return this._shadowMapSize; }
  get shadowHalfExtent(): number { return this._shadowHalfExtent; }
  get shadowBias(): number { return this._shadowBias; }

  /** Diagnostic: geometry-pool occupancy. `liveAllocs` = meshes with a live pool slot (should be ~stable per
   *  regen); `vtxUsedMB`/`vtxCapMB` = append-tail vs buffer size (dead space accumulates until a compaction).
   *  `appendsSinceCompact` (dead-string counter) shows how bloated the pool is since the last full rebuild. */
  getGeomPoolStats(): { liveAllocs: number; appendsSinceCompact: number; vtxUsedMB: number; vtxCapMB: number } {
    return {
      liveAllocs: this._geomAllocs.size,
      appendsSinceCompact: this._geomPoolIds.length,
      vtxUsedMB: +(this._geomVtxTail / 1048576).toFixed(1),
      vtxCapMB: +(this._geomVBCap / 1048576).toFixed(1),
    };
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
    this._shadowMapStale = true;   // the shadow light matrix follows the sun — refresh the throttled map
  }

  /** Up to 16 POINT LIGHTS (street lamps at night) — additive lambert with a smooth radius falloff, applied
   *  in the PBR/cel/cel-hd paths. Pass [] to turn them all off. */
  setPointLights(lights: { pos: [number, number, number]; radius: number; color: [number, number, number]; intensity: number }[]): void {
    this._pointLights = lights.slice(0, MAX_POINT_LIGHTS);
  }
  private _pointLights: { pos: [number, number, number]; radius: number; color: [number, number, number]; intensity: number }[] = [];

  /** PCF penumbra width multiplier (1 = the classic tight 5×5; ~2.5 = soft city-scale shadows). */
  setShadowSoftness(s: number): void { this._shadowSoftness = Math.max(0.5, s); this._shadowMapStale = true; }
  private _shadowSoftness = 1;

  /** PERF COUNTERS for hitch diagnosis (salsaWorld.perf() prints these): cumulative counts of the heavy
   *  events + the last cost of the two expensive rebuilds. A dip correlates with poolRebuilds/atlasRebuilds
   *  climbing; fullRepacks are the cheap-but-not-free middle tier; fastPaths should dominate. */
  private _perf = { renders: 0, fullRepacks: 0, fastPaths: 0, poolRebuilds: 0, lastPoolMs: 0, atlasRebuilds: 0, lastAtlasMs: 0, shadowPasses: 0, appends: 0, warms: 0 };
  getPerfCounters(): { renders: number; fullRepacks: number; fastPaths: number; poolRebuilds: number; lastPoolMs: number; atlasRebuilds: number; lastAtlasMs: number; shadowPasses: number; appends: number; warms: number } {
    return { ...this._perf };
  }

  // Per-FRAME render profile (reset each drawMeshes call). For finding CPU bottlenecks: drawCalls = enc.drawIndexed
  // count across ALL passes; ms* = CPU submission time per phase (NOT GPU execution). If drawCalls is high + msTotal
  // high → draw-call bound; msUpload high → instance processing; msTotal low but fps low → GPU bound. Read via
  // salsaWorld.frameStats().
  private _frame = { drawCalls: 0, meshes: 0, arrayGroups: 0, instances: 0, msTotal: 0, msUpload: 0, msShadow: 0 };
  getFrameStats3D(): { drawCalls: number; meshes: number; arrayGroups: number; instances: number; msTotal: number; msUpload: number; msShadow: number } { return { ...this._frame }; }

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

  /** Resize the directional shadow ortho box (world half-extent) WITHOUT recreating the depth texture — the
   *  texture resolution is `_shadowMapSize`, independent of world coverage. Call when the scene's footprint
   *  changes (e.g. a bigger city) so the whole thing stays inside the shadow frustum. Marks the map stale. */
  setShadowHalfExtent(he: number): void {
    if (he <= 0 || he === this._shadowHalfExtent) return;
    this._shadowHalfExtent = he;
    this._shadowMapStale = true;
  }

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
    this._shadowMapStale = true;
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
        { binding: 1, resource: this.pipeline.activeSampler },
        { binding: 2, resource: normalTex.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: this.pipeline.activeSampler },
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
  markInstancesDirty(): void { this._instancesDirty = true; this._shadowMapStale = true; }

  /** PERF: call when ONLY transforms changed (nothing added/removed, no material/geometry edits) — the
   *  city-traffic tick. Takes a fast path in uploadMeshInstances that rewrites just the model/normal
   *  matrices of moved slots (version-checked) instead of re-sorting + repacking every instance. */
  markTransformsDirty(): void { this._transformsDirty = true; }

  /** Render the shadow map every N rendered frames instead of every frame (1 = every frame). Structural
   *  changes (lights, geometry, adds/removes) force an immediate refresh regardless. City mode uses ~3 —
   *  the whole-scene depth pre-pass is the single biggest GPU cost of an animated diorama. */
  setShadowUpdateInterval(n: number): void { this._shadowUpdateInterval = Math.max(1, n | 0); }

  private _shadowPcfRadius = 0;   // 0 = default (5x5 PCF); 1 = fast 3x3 tier (shadowParams.x)
  /** PCF quality tier: radius 1 = 3x3 (9 taps, ~2.7x cheaper per lit fragment — softer edge, good for city
   *  scale), 2 or 0 = the default 5x5 (25 taps). Purely a uniform — no pipeline rebuild. */
  setShadowQuality(radius: number): void {
    this._shadowPcfRadius = radius === 1 ? 1 : 0;
  }

  private _shadowsSuspended = false;
  private _shadowSuspendCleared = false;
  /** SUSPEND the shadow pass entirely (extreme zoom-out: shadows are sub-pixel but the depth pass still re-draws
   *  the whole scene). While suspended the map is cleared ONCE to "no occluders" (everything lit — correct for a
   *  view where shadows are invisible) and the per-interval full-scene depth render is skipped. Resume marks the
   *  map stale so the next frame re-renders it. */
  setShadowsSuspended(on: boolean): void {
    if (this._shadowsSuspended === on) return;
    this._shadowsSuspended = on;
    if (on) this._shadowSuspendCleared = false;
    else this._shadowMapStale = true;
  }

  /** Register GPU-instanced array groups — renderer computes instance transforms from params. */
  setArrayGroups(groups: ArrayGroup3D[], localBases?: Map<string, LocalBasis3>): void {
    // Dirty ONLY when the SET changed (add/remove/reorder). The sync callback calls this EVERY FRAME with a freshly
    // collected array, but the ArrayGroup OBJECTS are stable in steady state — unconditionally dirtying here rebuilt
    // ALL instance matrices every frame (fine at ~2.8K, a hard 60→30fps cliff once greenery instancing pushed the
    // count to ~21K). Param/override edits + adds already call markInstancesDirty; source MOVEMENT is caught by
    // anyArrayMoved in uploadMeshInstances — so a no-op frame here can safely skip the full rebuild.
    const setChanged = groups.length !== this._arrayGroups.length || groups.some((g, i) => g !== this._arrayGroups[i]);
    const basesChanged = (localBases?.size ?? 0) !== this._arrayGroupLocalBases.size;
    this._arrayGroups = groups;
    this._arrayGroupLocalBases = localBases ?? new Map();
    if (setChanged || basesChanged) this._instancesDirty = true;
  }

  /**
   * When a source mesh is selected, set its ID here so the renderer draws a faint linked-instance
   * highlight on all array groups that reference it. Pass null to clear.
   */
  setSelectedSourceId(id: string | null): void {
    this._selectedSourceId = id;
  }

  setGizmoRenderer(gr: GizmoRenderer): void { this._gizmoRenderer = gr; }
  getGizmoRenderer(): GizmoRenderer | undefined { return this._gizmoRenderer; }

  setMeshEditOverlayRenderer(r: MeshEditOverlayRenderer | undefined): void { this._meshEditOverlay = r; }
  setMeshEditDataProvider(fn: (() => MeshEditDrawData | null) | undefined): void { this._meshEditDataFn = fn; }

  /**
   * Draw the mesh edit overlay (wireframe + handles) if edit mode is active.
   * Called unconditionally from webgpu-renderer after all mesh draws so it renders
   * even when there are no regular (non-skinned) meshes — e.g. after Bind Mesh.
   */
  drawMeshEditOverlayIfActive(pass: GPURenderPassEncoder): void {
    if (!this._meshEditOverlay || !this._meshEditDataFn) return;
    const editData = this._meshEditDataFn();
    if (editData) this._meshEditOverlay.draw(pass, editData, this.camera);
  }

  setSelectedMeshIds(ids: Set<string>): void { this._selectedMeshIds = new Set(ids); }
  getSelectedMeshIds(): Set<string> { return this._selectedMeshIds; }

  /** ALL pickable meshes this frame (regular + skinned) — the selection box/gizmo filters from this
   *  so SKINNED meshes (procedural bodies + their parts) get a box/gizmo too, not just regular meshes. */
  private _selectableMeshes: Mesh3D[] = [];
  setSelectableMeshes(m: Mesh3D[]): void { this._selectableMeshes = m; }

  /** Thin-wrapper container (e.g. the placed City) selected as a UNIT. When set, the gizmo + selection box
   *  draw from ITS cached bounds/transform (via obbCorners/localMatrix), never expanding to its children and
   *  never entering the per-mesh highlight/outline passes. Set by Scene3DManager on thin-wrapper selection. */
  private _selectedGroupTarget: Mesh3D | null = null;
  setSelectedGroupTarget(m: Mesh3D | null): void { this._selectedGroupTarget = m; }
  getSelectedGroupTarget(): Mesh3D | null { return this._selectedGroupTarget; }

  /**
   * Selection box + transform gizmo for the currently-selected mesh(es) — regular OR skinned. Drawn
   * unconditionally after all mesh passes (so it works in skinned-only scenes like a procedural
   * character, where drawMeshes never runs). Suppressed while a mesh is in edit mode.
   */
  drawSelectionGizmoIfActive(pass: GPURenderPassEncoder, canvasWidth: number, canvasHeight: number): void {
    if (!this._gizmoRenderer) return;
    const editData = this._meshEditOverlay && this._meshEditDataFn ? this._meshEditDataFn() : null;
    if (editData) return;
    if (this._arrayGizmoData) {
      this._gizmoRenderer.drawArrayGizmo(pass, this._arrayGizmoData, this.camera, this._arrayHandleHovered);
      return;
    }
    // Thin-wrapper container (City): drawn as a single unit from its cached bounds — box + gizmo at the
    // container's transform, no child expansion. Shares the same gizmo mode/hover/dragging state.
    if (this._selectedGroupTarget) {
      const target = [this._selectedGroupTarget];
      this._gizmoRenderer.drawSelectionBox(pass, target, this.camera, this._hoveredCorner);
      this._gizmoRenderer.drawGizmo(
        pass, target, this.camera, this._gizmoMode, this._hoveredAxis,
        canvasWidth, canvasHeight, this._draggingAxis,
      );
      return;
    }
    if (this._selectedMeshIds.size === 0) return;
    const selectedMeshes = this._selectableMeshes.filter(m => this._selectedMeshIds.has(m.id));
    if (selectedMeshes.length === 0) return;
    this._gizmoRenderer.drawSelectionBox(pass, selectedMeshes, this.camera, this._hoveredCorner);
    this._gizmoRenderer.drawGizmo(
      pass, selectedMeshes, this.camera, this._gizmoMode, this._hoveredAxis,
      canvasWidth, canvasHeight, this._draggingAxis,
    );
  }

  setHoveredMeshIds(ids: Set<string>): void { this._hoveredMeshIds = new Set(ids); }
  getHoveredMeshIds(): Set<string> { return this._hoveredMeshIds; }
  setHoveredArrayGroupId(id: string | null): void { this._hoveredArrayGroupId = id; }

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

  // Array Tool / Character preview — ghost preview + face handles
  setGhostPreviewData(data: GhostPreviewData | null): void { this._ghostPreviewData = data; }
  setFaceHandleData(data: FaceHandleData | null): void { this._faceHandleData = data; }

  /**
   * Draw the translucent ghost preview if one is set. Self-contained (the ghost renderer builds
   * its own viewProj from the camera), so it works even with ZERO committed meshes — that's the
   * Character tool's live body preview before "Generate". Called from draw3DMeshes unconditionally.
   */
  drawGhostPreviewIfActive(pass: GPURenderPassEncoder, canvasWidth: number, canvasHeight: number): void {
    if (!this._ghostPreviewRenderer || !this._ghostPreviewData) return;
    this.camera.aspect = canvasWidth / canvasHeight;
    this._ghostPreviewRenderer.update(this._ghostPreviewData);
    this._ghostPreviewRenderer.draw(pass, this.camera);
  }

  // ── Armature focus background ──────────────────────────────────────────────

  /** Update the visual style of the armature focus mode background. */
  setArmatureBgMode(opts: ArmatureBgOptions): void {
    this._armatureBgOpts = { ...opts };
  }

  getArmatureBgMode(): ArmatureBgOptions { return this._armatureBgOpts; }

  /**
   * Draw the armature focus background (non-dim modes).
   * Call BEFORE drawMeshes / drawSkinnedMeshes so the background sits behind all geometry.
   * No-op if armature mode is not active, mode is 'dim', or mode is 'none'.
   */
  drawArmatureBg(pass: GPURenderPassEncoder, canvasW: number, canvasH: number): void {
    if (this._armatureModeActive) {
      const mode = this._armatureBgOpts.mode;
      if (mode !== 'dim' && mode !== 'none') {
        this._armatureBgPass?.draw(pass, this._armatureBgOpts, canvasW, canvasH);
      }
      return;
    }
    if (this._meshEditBgActive) {
      const mode = this._meshEditBgOpts.mode;
      if (mode !== 'dim' && mode !== 'none') {
        this._armatureBgPass?.draw(pass, this._meshEditBgOpts, canvasW, canvasH);
      }
      return;
    }
    if (this._sceneBgOpts.mode !== 'none') {
      this._sceneBgPass?.draw(pass, this._sceneBgOpts, canvasW, canvasH);
    }
  }

  /** Activate or deactivate the armature focus background, independent of skeleton state. */
  setArmatureModeActive(active: boolean): void { this._armatureModeActive = active; }
  get armatureModeActive(): boolean { return this._armatureModeActive; }

  // ── Mesh-edit / UV focus background ────────────────────────────────────────

  /** Activate/deactivate the mesh-edit focus background (hides the 2D illustration
   *  behind it). Mirrors armature focus mode but for mesh edit / UV paint. */
  setMeshEditModeActive(active: boolean): void { this._meshEditBgActive = active; }
  get meshEditBgActive(): boolean { return this._meshEditBgActive; }

  /** Set the mesh-edit focus background style (same options as armature). */
  setMeshEditBgMode(opts: ArmatureBgOptions): void { this._meshEditBgOpts = { ...opts }; }
  getMeshEditBgMode(): ArmatureBgOptions { return { ...this._meshEditBgOpts }; }

  /** True when the mesh-edit focus background is active AND opaque (wavy/solid/gradient)
   *  — i.e. it fully hides the 2D content, so foreground 2D layers should be skipped too
   *  for a clean workspace. False for 'none'/'dim' (the 2D content stays visible). */
  meshEditHidesContent(): boolean {
    const m = this._meshEditBgOpts.mode;
    return this._meshEditBgActive && m !== 'none' && m !== 'dim';
  }

  /** Draw the mesh-edit 'dim' overlay AFTER meshes (parity with the armature dim mode,
   *  which is a semi-transparent overlay rather than an opaque pre-mesh background). */
  drawMeshEditDimIfActive(pass: GPURenderPassEncoder, canvasW: number, canvasH: number): void {
    if (this._meshEditBgActive && this._meshEditBgOpts.mode === 'dim') {
      this._armatureBgPass?.draw(pass, this._meshEditBgOpts, canvasW, canvasH);
    }
  }

  // Ground reference grid
  /** Push grid render state. `spacing` should be the transform snap size so the grid lines up with snapping. */
  setGridConfig(visible: boolean, color: [number, number, number], opacity: number, spacing: number): void {
    this._gridVisible = visible;
    this._gridColor = color;
    this._gridOpacity = opacity;
    this._gridSpacing = spacing;
  }

  /**
   * Draw the ground grid if enabled. Called unconditionally from webgpu-renderer after all
   * mesh draws (so it's depth-occluded by geometry) and before the bone/edit overlays (so
   * those stay on top) — this also makes it show in an empty scene with zero meshes.
   */
  drawGridIfActive(pass: GPURenderPassEncoder): void {
    if (!this._gridVisible || !this._gizmoRenderer) return;
    this._gizmoRenderer.drawGrid(pass, this.camera, this._gridSpacing, this._gridColor, this._gridOpacity);
  }

  // Vertex-snap viz (double-circle). Pull-based: scene3d-manager wires the provider to the transform
  // controller's live snapViz, so the renderer reads the current candidates each frame.
  setSnapVizProvider(fn: (() => SnapViz3D | null) | null): void { this._snapVizProvider = fn; }

  /** Draw the vertex-snap double-circle viz on top of everything, if a drag is providing it. */
  drawSnapVizIfActive(pass: GPURenderPassEncoder, canvasH: number): void {
    const viz = this._snapVizProvider?.();
    if (viz && this._gizmoRenderer) this._gizmoRenderer.drawSnapViz(pass, this.camera, viz, canvasH);
  }

  // Bone overlay
  setBoneOverlaySkeleton(skel: Skeleton3D | null): void { this._boneOverlaySkeleton = skel; }
  getBoneOverlaySkeleton(): Skeleton3D | null { return this._boneOverlaySkeleton; }

  // Armature declutter: hide spring bones (hair/drape/charm dangles) and/or the regular FK skeleton bones.
  private _showSpringBones = true;
  private _showFkBones = true;
  setBoneVisibility(showSpring: boolean, showFk: boolean): void { this._showSpringBones = showSpring; this._showFkBones = showFk; }
  getBoneVisibility(): { spring: boolean; fk: boolean } { return { spring: this._showSpringBones, fk: this._showFkBones }; }

  /**
   * Draw the dim overlay + bone gizmo if a skeleton overlay is active.
   * Called from webgpu-renderer AFTER all mesh/skinned-mesh draws so it
   * works even when there are no regular (non-skinned) meshes in the scene.
   */
  drawBoneOverlayIfActive(pass: GPURenderPassEncoder, canvasWidth: number, canvasHeight: number): void {
    if (!this._boneOverlaySkeleton) return;
    if (this._armatureBgOpts.mode === 'dim') {
      this._armatureBgPass?.draw(pass, this._armatureBgOpts, canvasWidth, canvasHeight);
    }
    if (this._gizmoRenderer) {
      this._gizmoRenderer.drawBoneOverlay(
        pass, this._boneOverlaySkeleton, this.camera,
        this._hoveredJointIdx, this._selectedJointIdx, this._selectedJointIsTail, this._hoveredTailJointIdx,
        this._weightPaintActive, this._programmaticHoverJoint, this._weightPaintShowSkeleton,
        this._showSpringBones, this._showFkBones,
      );
      // Joint gizmo on the selected head joint — suppressed during weight paint
      // and while actively placing a bone (so it doesn't distract mid-draw).
      if (!this._weightPaintActive && !this._bonePlacementActive && this._selectedJointIdx !== null && !this._selectedJointIsTail) {
        const j = this._boneOverlaySkeleton.data.joints[this._selectedJointIdx];
        if (j) {
          const wp: [number, number, number] = [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]];
          if (this._armatureToolMode === 'rotate') {
            this._gizmoRenderer.drawJointRotateGizmo(pass, wp, this.camera, this._jointGizmoHoveredAxis, this._jointGizmoDraggingAxis);
          } else {
            this._gizmoRenderer.drawJointGizmo(pass, wp, this.camera, this._jointGizmoHoveredAxis, this._jointGizmoDraggingAxis);
          }
        }
      }
    }
    // IK target handles (gold spheres) — drawn after bone overlay so they appear on top.
    if (this._gizmoRenderer && this._boneOverlaySkeleton && !this._weightPaintActive) {
      const chains = (this._boneOverlaySkeleton.data.ikChains ?? []).filter(c => c.enabled);
      if (chains.length > 0) {
        this._gizmoRenderer.drawIKTargets(
          pass, chains, this._boneOverlaySkeleton, this.camera,
          this._hoveredIKHandle, this._draggingIKHandle,
        );
      }
    }

    // Vertex dot overlay — shows all mesh vertices, highlighting those inside the brush radius.
    if (this._weightPaintActive && this._wpMesh && this._wpVertexOverlay) {
      this._wpVertexOverlay.draw(pass, this._wpMesh, this._wpBrushCenter, this._wpBrushRadius, this.camera);
    }
  }
  setHoveredJoint(idx: number | null): void { this._hoveredJointIdx = idx; }
  getHoveredJoint(): number | null { return this._hoveredJointIdx; }
  setSelectedJoint(idx: number | null, isTail = false): void { this._selectedJointIdx = idx; this._selectedJointIsTail = isTail; }
  getSelectedJoint(): number | null { return this._selectedJointIdx; }
  /** Toggle bone-placement state — suppresses the joint gizmo while drawing a bone. */
  setBonePlacementActive(active: boolean): void { this._bonePlacementActive = active; }
  setHoveredTailJoint(idx: number | null): void { this._hoveredTailJointIdx = idx; }
  setJointGizmoHoveredAxis(axis: import('./gizmo-renderer').GizmoAxis): void { this._jointGizmoHoveredAxis = axis; }
  setJointGizmoDraggingAxis(axis: import('./gizmo-renderer').GizmoAxis): void { this._jointGizmoDraggingAxis = axis; }
  getHoveredTailJoint(): number | null { return this._hoveredTailJointIdx; }
  /** Highlight a joint by index regardless of canvas pointer position (for UI list hover). */
  setHighlightJoint(idx: number | null): void { this._programmaticHoverJoint = idx; }

  setArmatureToolMode(mode: 'move' | 'rotate'): void { this._armatureToolMode = mode; }
  setHoveredIKHandle(handle: IKHandleHit | null): void { this._hoveredIKHandle = handle; }
  setDraggingIKHandle(handle: IKHandleHit | null): void { this._draggingIKHandle = handle; }
  setWeightPaintVertexOverlay(r: WeightPaintVertexOverlayRenderer): void { this._wpVertexOverlay = r; }
  setWeightPaintActive(active: boolean): void { this._weightPaintActive = active; }
  setWeightPaintShowSkeleton(show: boolean): void { this._weightPaintShowSkeleton = show; }
  setWeightPaintUnlit(unlit: boolean): void { this._weightPaintUnlit = unlit; }
  setWeightPaintMesh(mesh: SkinnedMesh3D | null): void { this._wpMesh = mesh; }
  setWeightPaintBrushCenter(center: [number, number, number] | null): void { this._wpBrushCenter = center; }
  setWeightPaintBrushRadius(radius: number): void { this._wpBrushRadius = radius; }

  // ── Frame rendering ────────────────────────────────────────────

  /**
   * Draw all Mesh3D nodes into the given render pass.
   * Call this from the main renderer's render loop at the 3D draw point.
   */
  drawMeshes(pass: GPURenderPassEncoder, meshes: Mesh3D[], canvasWidth: number, canvasHeight: number): void {
    if (meshes.length === 0) return;
    this._perf.renders++;   // diagnostic: total mesh renders (delta while moving the mouse = renders/move)
    const _ft0 = performance.now();   // per-frame profile (salsaWorld.frameStats())
    this._frame.drawCalls = 0; this._frame.msShadow = 0; this._frame.msUpload = 0;
    this._frame.meshes = meshes.length;
    this._frame.arrayGroups = this._arrayGroups.length;
    this._frame.instances = this._arrayGroups.reduce((n, g) => n + getArrayInstanceCount(g.arrayParams), 0);

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
    const _tu = performance.now();
    this.uploadMeshInstances(meshes);
    this._frame.msUpload = performance.now() - _tu;

    // Capture which vertex-colored (EditMesh) meshes need their GPU buffers re-uploaded.
    // Must run before _ensureGeomPool because that call clears gpuDirty as a side effect.
    // Reused Set (was new Set(filter().map()) = 2 arrays + a Set every frame; empty for the city).
    const vcDirtyIds = this._vcDirtyIds; vcDirtyIds.clear();
    for (const m of meshes) if (m.gpuDirty && m.vertexColors) vcDirtyIds.add(m.id);

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
          { binding: 2, resource: { buffer: this._iblUniformBuffer! } },
        ],
      });
      this._meshBindGroupBuffer = this.instanceStorageBuffer;
    }

    // Sort: opaque first (front-to-back), transparent last (back-to-front).
    // Also apply frustum culling when enabled.
    // DrawEntry carries an optional submesh for multi-material meshes.
    // Reset the pooled draw lists (reused across frames — no per-frame DrawEntry / array allocation).
    this._drawPoolN = 0;
    const opaque = this._opaque; opaque.length = 0;
    const transparent = this._transparent; transparent.length = 0;

    const culler = this._frustumCulling
      ? this._culler.setFromViewProjection(this.camera.getViewProjectionMatrix())
      : null;

    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (culler) {
        const bb = this.getMeshWorldAABB3D(m, this._aabbScratch);
        if (bb && !culler.testAABB(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ)) continue;
      }
      if (m.submeshes.length > 0) {
        // Multi-material: one draw entry per submesh.
        const slots = this._meshSubmeshSlots.get(m.id);
        for (let si = 0; si < m.submeshes.length; si++) {
          const sub = m.submeshes[si];
          const idx = slots?.[si] ?? 0;
          if (sub.material.opacity < 1) this._pushDraw(transparent, m, idx, sub);
          else this._pushDraw(opaque, m, idx, sub);
        }
      } else {
        // Single-material: idx = slot in the geometryKey-sorted instance buffer.
        const idx = this._meshInstanceSlots.get(m.id) ?? i;
        if (m.material.opacity < 1) this._pushDraw(transparent, m, idx);
        else this._pushDraw(opaque, m, idx);
      }
    }

    // Add GPU-instanced array group draw entries (no Mesh3D copies — instances computed from params).
    // Each instance uses the source mesh's geometry; slots are contiguous immediately after source slot.
    for (const group of this._arrayGroups) {
      const firstSlot = this._arrayGroupFirstSlot.get(group.id);
      if (firstSlot === undefined) continue;
      const sourceMesh = this._meshById.get(group.sourceId);   // O(1) (map built in uploadMeshInstances, which ran earlier this frame)
      if (!sourceMesh || sourceMesh.submeshes.length > 0) continue;
      // Whole-group frustum cull (per-cell chunked groups off-screen skip all instances; city-wide groups span
      // everything → never culls = no-op).
      if (culler) {
        const gb = this._arrayGroupWorldAABB(group, sourceMesh);
        if (gb && !culler.testAABB(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5])) continue;
      }
      const N = getArrayInstanceCount(group.arrayParams);
      if (N <= 0) continue;
      if (sourceMesh.material.opacity < 1) {
        // Transparent instances need per-instance back-to-front ordering — keep one entry each.
        for (let i = 0; i < N; i++) this._pushDraw(transparent, sourceMesh, firstSlot + i);
      } else {
        // OPAQUE: ONE instanced-range entry (count=N) for the whole group. Was N per-instance entries → the entire
        // per-frame draw pipeline (filter/sort/shadow-dedup/batch) ran O(total instances); with the city greenery
        // visible that's ~18K entries EVERY frame = the 60→33fps zoom-in cliff. Depth-test orders opaque, so the
        // slots are already contiguous — one drawMesh(firstSlot, N) draws them all.
        this._pushDraw(opaque, sourceMesh, firstSlot, undefined, N);
      }
    }

    // For shadow and outline passes: deduplicate multi-submesh meshes so each
    // mesh's full geometry is drawn once (not once per submesh). Pooled + reused.
    const opaqueForPasses = this._opaqueForPasses; opaqueForPasses.length = 0;
    {
      const seen = this._opaqueSeen; seen.clear();
      for (const e of opaque) {
        // Instanced detail (greenery / juliet / window-trim — the count>1 array-group ranges) does NOT cast shadows
        // or feed the outline depth pass: at city scale those shadows/edges are invisible, but redrawing ~18K
        // instances into the shadow map (every 3rd frame) is a big GPU cost. The MAIN pass still draws them (visible).
        if ((e.count ?? 1) > 1) continue;
        if (e.submesh) {
          if (!seen.has(e.mesh.id)) {
            seen.add(e.mesh.id);
            // Use the first submesh slot's idx for the transform; no submesh → full geometry.
            this._pushDraw(opaqueForPasses, e.mesh, e.idx);
          }
        } else {
          opaqueForPasses.push(e);
        }
      }
    }
    // Last pool push happened above (opaqueForPasses). Trim the pool to this frame's high-water so stale
    // entries don't PIN removed meshes (holding their geometry) after the scene shrinks. Stable city =
    // length === _drawPoolN → no-op; only a genuine shrink drops (and later regrows) the tail.
    if (this._drawPool.length > this._drawPoolN) this._drawPool.length = this._drawPoolN;

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
      this._frame.drawCalls++;
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
      for (const e of opaqueForPasses) drawMesh(depthPrePass, e.mesh, e.idx, outlineVBRef, e.count ?? 1);   // count>1 = array-group instanced range
      for (const e of transparent)     drawMesh(depthPrePass, e.mesh, e.idx, outlineVBRef);
      depthPrePass.end();

      this._outlinePass.runSobelPass(outlineEncoder);
      this.device.queue.submit([outlineEncoder.finish()]);
    }

    // Shadow pre-pass: depth-only render into shadow map using its own command encoder.
    // Submitted before the main pass draws so the GPU executes it first.
    // THROTTLED: with `setShadowUpdateInterval(n)` the map refreshes every n-th rendered frame — mover
    // shadows lag a frame or two (invisible) while the whole-scene depth render stops eating every frame.
    // Structural changes (_shadowMapStale: lights/geometry/adds) always refresh immediately.
    this._shadowFramesSince++;
    const _ts = performance.now();
    if (this._shadowsSuspended && this._shadowTextureView) {
      // Suspended (extreme zoom-out): clear the map ONCE to depth=1 (no occluders → fully lit), then skip the
      // whole-scene depth pass every frame until resume.
      if (!this._shadowSuspendCleared) {
        this._shadowSuspendCleared = true;
        const clearEnc = this.device.createCommandEncoder();
        clearEnc.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: { view: this._shadowTextureView, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        }).end();
        this.device.queue.submit([clearEnc.finish()]);
      }
    } else if (this._shadowsEnabled && this._shadowTextureView && this._shadowBindGroup
        && (this._shadowMapStale || this._shadowFramesSince >= this._shadowUpdateInterval)) {
      this._shadowFramesSince = 0;
      this._shadowMapStale = false;
      this._perf.shadowPasses++;
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
          const sLead = opaqueForPasses[subStart];
          if ((sLead.count ?? 1) > 1) { drawMesh(shadowPass, sLead.mesh, sLead.idx, shadowVBRef, sLead.count); sk++; continue; }   // instanced-range entry (array group)
          const firstSlot = sLead.idx;
          let subLen = 1;
          while (sk + subLen < sGroupLen &&
                 (opaqueForPasses[subStart + subLen].count ?? 1) === 1 &&
                 opaqueForPasses[subStart + subLen].idx === firstSlot + subLen) {
            subLen++;
          }
          drawMesh(shadowPass, sLead.mesh, firstSlot, shadowVBRef, subLen);
          sk += subLen;
        }
        ssi = ssj;
      }
      shadowPass.end();
      this.device.queue.submit([shadowEncoder.finish()]);
    }
    this._frame.msShadow = performance.now() - _ts;

    // Separate single-material and multi-submesh opaque entries.
    // Single-material entries can be batched by geometryKey; multi-submesh cannot.
    // Vertex-colored (EditMesh) meshes go to a separate list — they use a different pipeline.
    // Editable meshes carry per-vertex colors, which normally routes them to the
    // vertex-color pipeline (no diffuse texture). When one also has a real diffuse
    // texture to show — e.g. a UV-painted texture — render it textured instead so
    // the paint is actually visible while the UV editor keeps the mesh editable.
    // Partition opaque into VC / single-material / multi-submesh in ONE pass (was three .filter passes
    // over ~700 meshes every frame). Pooled lists reused across frames — no per-frame array allocation.
    const showsTexture = (e: { mesh: Mesh3D }) => e.mesh.material.hasTexture && !!e.mesh.diffuseTexture;
    const opaqueVC     = this._opaqueVC;     opaqueVC.length = 0;
    const opaqueSimple = this._opaqueSimple; opaqueSimple.length = 0;
    const opaqueMulti  = this._opaqueMulti;  opaqueMulti.length = 0;
    for (const e of opaque) {
      if ((e.count ?? 1) > 1) opaqueSimple.push(e);   // instanced-range entry (array group) → the count-aware batch path
      else if (e.submesh) opaqueMulti.push(e);
      else if (e.mesh.vertexColors && !showsTexture(e)) opaqueVC.push(e);
      else opaqueSimple.push(e);
    }

    // Sort single-material opaque meshes by (pipelineKey, geometryKey, textureRef) so:
    //   1. Pipeline switches are minimized (untextured before textured, etc.)
    //   2. Same-geometry instances are adjacent → enables batched instanced draws
    //   3. Same-texture instances within a geometry group are adjacent → single bind group per group
    // Plain < > compare (NOT localeCompare — 10-100× slower, and this sort runs on EVERY frame over the
    // whole city; a consistent total order is all the grouping needs).
    if (opaqueSimple.length > 1) {
      // CACHED DRAW RANK: the old inline sort allocated the pipelineKeyOf closure PER COMPARISON and did ~40k
      // geometryKey STRING compares over the whole city EVERY frame (steady GC + CPU). The (pipelineKey,
      // geometryKey) order is stable per mesh — build a rank map once per STRUCTURAL change, then per frame do
      // one Map.get per mesh + a pure numeric sort. Meshes streamed in since the last rebuild rank at the tail
      // (worst case a few extra draw calls until the next structural rebuild — never incorrect).
      if (this._drawOrderDirty || this._drawOrderDS !== this.forceDoubleSided) {
        this._drawOrderDirty = false;
        this._drawOrderDS = this.forceDoubleSided;
        const pipeOf = (m: Mesh3D): number =>
          ((m.material.hasTexture || m.material.hasNormalMap) ? 1 : 0) |
          ((this.forceDoubleSided || !!m.material.doubleSided) ? 2 : 0);
        const tmp = meshes.slice().sort((a, b) => {
          const p = pipeOf(a) - pipeOf(b);
          if (p !== 0) return p;
          const ak = a.geometryKey, bk = b.geometryKey;
          return ak < bk ? -1 : ak > bk ? 1 : 0;
        });
        this._drawOrder.clear();
        for (let i = 0; i < tmp.length; i++) this._drawOrder.set(tmp[i].id, i);
      }
      const ord = this._drawOrder;
      for (const e of opaqueSimple) e.ord = ord.get(e.mesh.id) ?? 0x7fffffff;
      opaqueSimple.sort((a, b) => a.ord! - b.ord!);
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

        // Set pipeline + bind groups once for the whole group. Double-sided (noCull) meshes — the whole
        // world city — now RECEIVE shadows too via the NoCull-shadow pipeline variants.
        if (useTexture) {
          pass.setPipeline(this._shadowsEnabled
            ? (noCull ? this.pipeline.opaqueTexturedNoCullShadowPipeline : this.pipeline.opaqueTexturedShadowPipeline)
            : (noCull ? this.pipeline.opaqueTexturedNoCullPipeline : this.pipeline.opaqueTexturedPipeline));
          pass.setBindGroup(0, this.meshBindGroup);
          // Atlas meshes share one bind group; standalone meshes get per-mesh bind group
          const texBG = (leadIsAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(lead);
          pass.setBindGroup(1, texBG);
          if (this._shadowsEnabled) pass.setBindGroup(2, this._shadowBindGroup!);
        } else {
          pass.setPipeline(this._shadowsEnabled
            ? (noCull ? this.pipeline.opaqueUntexturedNoCullShadowPipeline : this.pipeline.opaqueUntexturedShadowPipeline)
            : (noCull ? this.pipeline.opaqueUntexturedNoCullPipeline : this.pipeline.opaqueUntexturedPipeline));
          pass.setBindGroup(0, this.meshBindGroup);
          if (this._shadowsEnabled) pass.setBindGroup(1, this._shadowBindGroup!);
        }

        // Split the group into maximal contiguous sub-runs of instance slots.
        // Frustum culling may remove members mid-group, creating gaps in the slot sequence.
        let k = 0;
        const groupLen = oj - oi;
        while (k < groupLen) {
          const subStart  = oi + k;
          const lead = opaqueSimple[subStart];
          if ((lead.count ?? 1) > 1) { drawMesh(pass, lead.mesh, lead.idx, mainVBRef, lead.count); k++; continue; }   // instanced-range entry (array group)
          const firstSlot = lead.idx;
          let subLen = 1;
          while (k + subLen < groupLen &&
                 (opaqueSimple[subStart + subLen].count ?? 1) === 1 &&
                 opaqueSimple[subStart + subLen].idx === firstSlot + subLen) {
            subLen++;
          }
          drawMesh(pass, lead.mesh, firstSlot, mainVBRef, subLen);
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
        pass.setPipeline(this._shadowsEnabled
          ? (noCull ? this.pipeline.opaqueTexturedNoCullShadowPipeline : this.pipeline.opaqueTexturedShadowPipeline)
          : (noCull ? this.pipeline.opaqueTexturedNoCullPipeline : this.pipeline.opaqueTexturedPipeline));
        pass.setBindGroup(0, this.meshBindGroup);
        const texBG = (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(mesh);
        pass.setBindGroup(1, texBG);
        if (this._shadowsEnabled) pass.setBindGroup(2, this._shadowBindGroup!);
      } else {
        pass.setPipeline(this._shadowsEnabled
          ? (noCull ? this.pipeline.opaqueUntexturedNoCullShadowPipeline : this.pipeline.opaqueUntexturedShadowPipeline)
          : (noCull ? this.pipeline.opaqueUntexturedNoCullPipeline : this.pipeline.opaqueUntexturedPipeline));
        pass.setBindGroup(0, this.meshBindGroup);
        if (this._shadowsEnabled) pass.setBindGroup(1, this._shadowBindGroup!);
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

      // When hovering a specific ArrayGroup3D, restrict highlight to that group's slot range.
      let hoveredGroupSlotMin = -1, hoveredGroupSlotMax = -1;
      if (this._hoveredArrayGroupId) {
        const first = this._arrayGroupFirstSlot.get(this._hoveredArrayGroupId);
        const grp   = this._arrayGroups.find(g => g.id === this._hoveredArrayGroupId);
        if (first !== undefined && grp) {
          hoveredGroupSlotMin = first;
          hoveredGroupSlotMax = first + getArrayInstanceCount(grp.arrayParams);
        }
      }

      const toEntries = (ids: string[]) => ids.flatMap(id => {
        let pairs = [...opaqueSimple, ...opaqueVC, ...transparent].filter(p => p.mesh.id === id);
        if (pairs.length === 0) return [];
        // Narrow to the hovered group's instance slots when applicable.
        if (hoveredGroupSlotMin >= 0) {
          pairs = pairs.filter(p => p.idx >= hoveredGroupSlotMin && p.idx < hoveredGroupSlotMax);
        }
        if (pairs.length === 0) return [];
        const alloc = this._geomAllocs.get(id);
        if (!alloc) return [];
        const hasOverride = this._vertexBufferOverrides.has(id);
        return pairs.map(pair => ({
          vertex:      this._vertexBufferOverrides.get(id) ?? sharedVB,
          index:       sharedIB,
          indexCount:  alloc.indexCount,
          firstIndex:  alloc.firstIndex,
          baseVertex:  hasOverride ? 0 : alloc.baseVertex,
          instanceIdx: pair.idx,
        }));
      });

      const hoverEntries = toEntries(hoverOnly);
      if (hoverEntries.length > 0) {
        this._highlightPass.writeParams('hover', [0.45, 0.85, 1.0, 0.80], 0.05);
        this._highlightPass.draw(pass, this.meshBindGroup, 'hover', hoverEntries);
      }

      // Source-link feedback: when a source mesh is selected, faintly highlight all linked instances.
      if (this._selectedSourceId && this._highlightPass && this.meshBindGroup) {
        const srcId = this._selectedSourceId;
        const alloc = this._geomAllocs.get(srcId);
        const hasOverride = this._vertexBufferOverrides.has(srcId);
        if (alloc) {
          const linkedEntries: any[] = [];
          for (const group of this._arrayGroups) {
            if (group.sourceId !== srcId) continue;
            const first = this._arrayGroupFirstSlot.get(group.id);
            if (first === undefined) continue;
            const N = getArrayInstanceCount(group.arrayParams);
            for (let i = 0; i < N; i++) {
              linkedEntries.push({
                vertex:      this._vertexBufferOverrides.get(srcId) ?? sharedVB,
                index:       sharedIB,
                indexCount:  alloc.indexCount,
                firstIndex:  alloc.firstIndex,
                baseVertex:  hasOverride ? 0 : alloc.baseVertex,
                instanceIdx: first + i,
              });
            }
          }
          if (linkedEntries.length > 0) {
            this._highlightPass.writeParams('select', [1.0, 0.85, 0.2, 0.35], 0.03);
            this._highlightPass.draw(pass, this.meshBindGroup, 'select', linkedEntries);
          }
        }
      }
    }

    // Ghost preview is drawn by drawGhostPreviewIfActive() at the draw3DMeshes level so it
    // works even with zero committed meshes (e.g. the Character tool's live body preview).

    // Selection box + transform gizmo moved to drawSelectionGizmoIfActive(), called unconditionally
    // by the renderer after ALL mesh passes — so it works in skinned-only scenes (procedural characters),
    // not just when regular meshes exist.

    // Bone overlay (dim + gizmo) is now drawn by drawBoneOverlayIfActive(),
    // called unconditionally from webgpu-renderer after all mesh draws.

    // Array Tool face handles (depth=always — always visible on top of scene)
    if (this._gizmoRenderer && this._faceHandleData) {
      this._gizmoRenderer.drawFaceHandles(pass, this._faceHandleData, this.camera);
    }

    // Mesh edit overlay is drawn by drawMeshEditOverlayIfActive(), called
    // unconditionally from webgpu-renderer after all mesh draws — this ensures
    // handles are visible even when regularMeshes is empty (e.g. after Bind Mesh).
    this._frame.msTotal = performance.now() - _ft0;
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
    const visible = this._particleVisibleScratch; visible.length = 0;
    for (const e of emitters) if (e.visible) visible.push(e);
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

    const active = this._particleActiveScratch; active.length = 0;
    for (const e of visible) if (e.activeCount > 0) active.push(e);
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

    const firstInstances = this._particleFirstInstances; firstInstances.length = 0;
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
        this.pipeline.activeSampler,
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
      this._bloomPass.drawComposite(pass, this.pipeline.activeSampler);
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
    const data = this._particleSceneData ??= new Float32Array(PARTICLE_SCENE_UNIFORM_SIZE / 4);
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
          { binding: 1, resource: this.pipeline.activeSampler },
        ],
      });
    }
    return this._particleTexBG;
  }

  // ── Private helpers ────────────────────────────────────────────

  private computeLightSpaceMatrix(): Float32Array {
    // Allocation-free: this runs every frame while shadows are on (city + character). Reuse persistent scratch.
    const d = this._light.direction;
    const dist = this._shadowHalfExtent * 4;
    const eye = vec3.set(this._lsmEye, -d[0] * dist, -d[1] * dist, -d[2] * dist);
    const up = Math.abs(d[1]) > 0.99
      ? vec3.set(this._lsmUp, 1, 0, 0)
      : vec3.set(this._lsmUp, 0, 1, 0);

    const view = this._lsmView;
    mat4.lookAt(view, eye, this._lsmCenter, up);

    const he = this._shadowHalfExtent;
    const proj = this._lsmProj;
    mat4.ortho(proj, -he, he, -he, he, 0.1, dist * 2);

    mat4.multiply(this._lsmMatrix, proj, view);
    return this._lsmMatrix as Float32Array;
  }

  getMeshWorldAABB3D(mesh: Mesh3D, out?: AABB3): AABB3 | null {
    const geom = mesh.geometry;
    if (!geom || geom.vertices.length === 0) return null;

    const matVersion = mesh.localMatrixVersion;
    const cached     = this._meshAABBCache.get(mesh.id);

    // Full cache hit: geometry unchanged (gpuDirty = false) and matrix unchanged.
    if (!mesh.gpuDirty && cached && cached.matVersion === matVersion) {
      return this._writeAABB(out, cached.wMinX, cached.wMinY, cached.wMinZ,
                                  cached.wMaxX, cached.wMaxY, cached.wMaxZ);
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

    return this._writeAABB(out, wx0, wy0, wz0, wx1, wy1, wz1);
  }

  /** Write an AABB into `out` (reused scratch, hot path) or a fresh object (default — unchanged for
   *  non-hot callers that may hold the result). */
  private _writeAABB(out: AABB3 | undefined, minX: number, minY: number, minZ: number,
                     maxX: number, maxY: number, maxZ: number): AABB3 {
    if (out) { out.minX = minX; out.minY = minY; out.minZ = minZ; out.maxX = maxX; out.maxY = maxY; out.maxZ = maxZ; return out; }
    return { minX, minY, minZ, maxX, maxY, maxZ };
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
      data[56] = this._shadowPcfRadius;  // PCF radius override (shadowParams.x): 0 = default 5x5, 1 = fast 3x3
      data[57] = this._shadowBias;
      data[58] = this._shadowMapSize;
      data[59] = this._shadowSoftness;   // PCF penumbra width multiplier (shadowParams.w)
    }

    // fogColor (floats 60–63) + fogParams (floats 64–67)
    data[60] = this._fog.color[0]; data[61] = this._fog.color[1]; data[62] = this._fog.color[2]; data[63] = 0;
    data[64] = this._fog.near;
    data[65] = this._fog.far;
    data[66] = this._fog.density;
    data[67] = this._fog.mode === 'linear' ? 1 : this._fog.mode === 'exponential' ? 2 : 0;

    // lightCounts vec4 (floats 72–75, .x = point-light count) + POINT LIGHTS (floats 76–203):
    // per light 2 vec4s — (pos.xyz, radius) + (color.rgb, intensity). Street lamps at night.
    data[72] = this._pointLights.length;
    for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
      const o = 76 + i * 8, pl = this._pointLights[i];
      if (pl) {
        data[o] = pl.pos[0]; data[o + 1] = pl.pos[1]; data[o + 2] = pl.pos[2]; data[o + 3] = pl.radius;
        data[o + 4] = pl.color[0]; data[o + 5] = pl.color[1]; data[o + 6] = pl.color[2]; data[o + 7] = pl.intensity;
      } else {
        data[o + 3] = 0; data[o + 7] = 0;
      }
    }

    // ps1Config2 (floats 68–71) — dithering + UV quantization
    const ditherEnabled = this._ps1.dither && (this._ps1.ditherStrength ?? 0.5) > 0;
    data[68] = ditherEnabled ? (this._ps1.ditherStrength ?? 0.5) : 0;
    const uvQEnabled = this._ps1.uvQuantize && (this._ps1.uvQuantizeSteps ?? 64) > 0;
    data[69] = uvQEnabled ? (this._ps1.uvQuantizeSteps ?? 64) : 0;
    data[70] = (performance.now() / 1000) % 3600;   // ps1Config2.z = scene time (s), for the sparkle/glint twinkle
    data[71] = this._glassQuality;                   // ps1Config2.w = stylized-glass toggle (0 off · 1 on)
    data[63] = this._aerialFog;                      // fogColor.w = aerial-perspective strength (0 off · >0 on)

    this.device.queue.writeBuffer(this.sceneUniformBuffer, 0, data);
  }

  private ensureInstanceBuffer(count: number): void {
    if (this.instanceCapacity >= count && this.instanceStorageBuffer) return;

    if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();

    // 50% headroom: every growth is EXPENSIVE (new GPUBuffer + bind-group + a forced full repack re-uploading the
    // whole instance range), and a streamed world's slot count climbs steadily while panning — the old 25% caused
    // dozens of growth-repack stalls per session (perf() showed 56 atlasRebuilds, all buffer growths).
    this.instanceCapacity = Math.max(Math.ceil(count * 1.5), 16);
    this.instanceStorageBuffer = this.device.createBuffer({
      size: this.instanceCapacity * MESH_INSTANCE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Buffer reference changed — bind group, instance data, and texture atlas must be rebuilt.
    this._instancesDirty = true;
    this._atlasDirty = true;
    this._meshBindGroupBuffer = null;
  }

  /** World AABB over a group's instance positions (source + explicit offsets, transformed by the source's parent
   *  chain), expanded by the canonical extent — for whole-group frustum culling. Cached per source-matrix version.
   *  Non-explicit modes (array tool) return null → never group-culled. */
  private _arrayGroupWorldAABB(group: ArrayGroup3D, source: Mesh3D): [number, number, number, number, number, number] | null {
    const ver = source.localMatrixVersion;
    const cached = this._agAABBCache.get(group.id);
    if (cached && cached.ver === ver) return cached.box;
    let box: [number, number, number, number, number, number] | null = null;
    const p = group.arrayParams;
    if (p.mode === 'explicit') {
      let lx0 = source.x, lx1 = source.x, ly0 = source.y, ly1 = source.y, lz0 = source.z, lz1 = source.z;
      for (const o of p.offsets) {
        if (o[0] < lx0) lx0 = o[0]; else if (o[0] > lx1) lx1 = o[0];
        if (o[1] < ly0) ly0 = o[1]; else if (o[1] > ly1) ly1 = o[1];
        if (o[2] < lz0) lz0 = o[2]; else if (o[2] > lz1) lz1 = o[2];
      }
      const m = source.parentChainMatrix as unknown as Float32Array;
      let wx0 = Infinity, wy0 = Infinity, wz0 = Infinity, wx1 = -Infinity, wy1 = -Infinity, wz1 = -Infinity;
      for (let ci = 0; ci < 8; ci++) {
        const cx = ci & 1 ? lx1 : lx0, cy = ci & 2 ? ly1 : ly0, cz = ci & 4 ? lz1 : lz0;
        const wx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
        const wy = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
        const wz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
        if (wx < wx0) wx0 = wx; if (wx > wx1) wx1 = wx;
        if (wy < wy0) wy0 = wy; if (wy > wy1) wy1 = wy;
        if (wz < wz0) wz0 = wz; if (wz > wz1) wz1 = wz;
      }
      const sb = this.getMeshWorldAABB3D(source, this._aabbScratch);
      const mg = sb ? Math.max(sb.maxX - sb.minX, sb.maxY - sb.minY, sb.maxZ - sb.minZ) : 0;
      box = [wx0 - mg, wy0 - mg, wz0 - mg, wx1 + mg, wy1 + mg, wz1 + mg];
    }
    this._agAABBCache.set(group.id, { ver, box });
    return box;
  }

  /** Write a mesh's material floats (32–55) into its instance slot — the UNTEXTURED subset (texIdx=normIdx=0), for the
   *  material-only fast path (border-glow pulse / frost / wet walks touch a few meshes' emissive/colour every frame; a
   *  full repack of ALL slots for that was the real fps sink). Textured / array-source material changes take the full path. */
  private _writeSlotMaterial(data: Float32Array, dv: DataView, offset: number, mm: Mesh3D['material']): void {
    data[offset + 32] = mm.diffuse.r; data[offset + 33] = mm.diffuse.g; data[offset + 34] = mm.diffuse.b; data[offset + 35] = mm.opacity;
    data[offset + 36] = mm.specular.r; data[offset + 37] = mm.specular.g; data[offset + 38] = mm.specular.b; data[offset + 39] = mm.shininess;
    data[offset + 40] = mm.emissive.r; data[offset + 41] = mm.emissive.g; data[offset + 42] = mm.emissive.b;
    dv.setUint32((offset + 43) * 4, encodeMaterialFlags(mm), true);
    dv.setUint32((offset + 44) * 4, 0, true); dv.setUint32((offset + 45) * 4, 0, true);
    data[offset + 46] = mm.roughness ?? 0.5; data[offset + 47] = mm.metalness ?? 0.0;
    const pc = mm.patternColor;
    data[offset + 48] = pc?.r ?? 0; data[offset + 49] = pc?.g ?? 0; data[offset + 50] = pc?.b ?? 0; data[offset + 51] = 0;
    data[offset + 52] = mm.patternFreq ?? 8; data[offset + 53] = mm.patternAngle ?? 0; data[offset + 54] = mm.patternScale ?? 0.5; data[offset + 55] = mm.patternSpacing ?? 0;
  }

  /** Take an instance slot: reuse a freed one, else grow the high-water. Returns -1 if the buffer is full (caller
   *  bails to a full repack, which compacts + grows). */
  private _takeInstanceSlot(): number {
    const f = this._instanceFreeSlots.pop();
    if (f !== undefined) return f;
    if (this._instanceHigh < this.instanceCapacity) return this._instanceHigh++;
    return -1;
  }

  /** Write a NON-billboard mesh's instance slot: model matrix + inverse-transpose normal matrix + material block
   *  (texIdx/normIdx = 0 — the incremental path is gated to textureless meshes so the atlas is untouched). */
  private _writeIncSlot(data: Float32Array, dataView: DataView, normalMat: mat4, slot: number, m: Mesh3D, mat3d: Mesh3D['material']): void {
    const offset = slot * (MESH_INSTANCE_STRIDE / 4);
    data.set(m.localMatrix as Float32Array, offset);
    let nc = this._normalMatCache.get(m.id);
    if (!nc) { nc = { matVersion: -1, floats: new Float32Array(16) }; this._normalMatCache.set(m.id, nc); }
    if (nc.matVersion !== m.localMatrixVersion) {
      mat4.invert(normalMat, m.localMatrix); mat4.transpose(normalMat, normalMat);
      nc.floats.set(normalMat as Float32Array); nc.matVersion = m.localMatrixVersion;
    }
    data.set(nc.floats, offset + 16);
    this._writeSlotMaterial(data, dataView, offset, mat3d);
    this._slotMatVer.set(m.id, m.localMatrixVersion);
  }

  /** Rewrite ONLY a slot's model + inverse-transpose normal matrices (floats 0–31). Safe for RESIDENT meshes
   *  whatever their material: the material/texIdx floats (32+) are left exactly as the last full repack wrote
   *  them. Used by the incremental path for residents that MOVED (packaging re-dimension: setPanelGeometry's
   *  gpuDirty routes the frame here, bypassing the transforms fast path — skipping moved residents drew the
   *  NEW panel geometry with STALE pivot matrices = visible gaps between panels). */
  private _writeIncSlotMatrices(data: Float32Array, normalMat: mat4, slot: number, m: Mesh3D): void {
    const offset = slot * (MESH_INSTANCE_STRIDE / 4);
    data.set(m.localMatrix as Float32Array, offset);
    let nc = this._normalMatCache.get(m.id);
    if (!nc) { nc = { matVersion: -1, floats: new Float32Array(16) }; this._normalMatCache.set(m.id, nc); }
    if (nc.matVersion !== m.localMatrixVersion) {
      mat4.invert(normalMat, m.localMatrix); mat4.transpose(normalMat, normalMat);
      nc.floats.set(normalMat as Float32Array); nc.matVersion = m.localMatrixVersion;
    }
    data.set(nc.floats, offset + 16);
  }

  /** INCREMENTAL instance update (the streaming-pan smoothness fix): append newly-added meshes into freed/high-water
   *  slots and upload ONLY those, instead of re-sorting + re-uploading the ENTIRE instance buffer (the full repack).
   *  Removed meshes already freed their slots in evictMeshCaches. Only valid when nothing needs the sort's contiguity
   *  or the atlas (no array groups / billboards / textures) — the caller gates on that; this bails (→ full repack) on
   *  anything it can't handle, so correctness is always preserved. */
  private _tryIncrementalInstances(meshes: Mesh3D[], anyMatDirty: boolean): boolean {
    const data = this._instanceDataBuf;
    if (!data || !this.instanceStorageBuffer) return false;
    const fpi = MESH_INSTANCE_STRIDE / 4;
    // The CPU shadow must span the whole buffer capacity (the free list can place slots past the last full repack's tail).
    if (data.length < this.instanceCapacity * fpi) {
      const bigger = new Float32Array(this.instanceCapacity * fpi); bigger.set(data); this._instanceDataBuf = bigger;
    }
    const buf = this._instanceDataBuf!;
    const dataView = new DataView(buf.buffer);
    const normalMat = mat4.create();
    const touched: number[] = [];
    for (const m of meshes) {
      const multi = m.submeshes.length > 0;
      // Residency check must catch IN-PLACE structural changes too: a resident mesh whose submesh COUNT changed
      // (or that flipped single↔multi) would keep its stale slots and draw a submesh at slot 0 with garbage data.
      const hadMulti = this._meshSubmeshSlots.get(m.id);
      const hadSingleSlot = this._meshInstanceSlots.get(m.id);
      const hadSingle = hadSingleSlot !== undefined;
      if (multi) {
        if (hadSingle) return false;                                    // single→multi flip → full repack
        if (hadMulti) {
          if (hadMulti.length !== m.submeshes.length) return false;
          // Resident but MOVED (matrix version diff — same check as the transforms fast path): rewrite its
          // matrices in place. Skipping it left stale model matrices whenever this path won (a mesh that
          // moved AND changed geometry in one frame — the packaging panel-gap bug). Matrix-only write keeps
          // textured residents' atlas indices intact.
          if (this._slotMatVer.get(m.id) !== m.localMatrixVersion) {
            for (const s of hadMulti) { this._writeIncSlotMatrices(buf, normalMat, s, m); touched.push(s); }
            this._slotMatVer.set(m.id, m.localMatrixVersion);
          }
          continue;
        }
      } else {
        if (hadMulti) return false;                                     // multi→single flip → full repack
        if (hadSingle) {                                                // resident, unchanged shape
          if (this._slotMatVer.get(m.id) !== m.localMatrixVersion) {    // …but MOVED → rewrite matrices
            this._writeIncSlotMatrices(buf, normalMat, hadSingleSlot!, m); touched.push(hadSingleSlot!);
            this._slotMatVer.set(m.id, m.localMatrixVersion);
          }
          continue;
        }
      }
      if (m.billboard) return false;   // needs per-frame reorient → full/fast path
      if (multi) {
        for (const s of m.submeshes) if (s.textureLibraryId || s.normalMapLibraryId) return false;   // textured → atlas changes → full repack
        const slots: number[] = [];
        for (let si = 0; si < m.submeshes.length; si++) { const slot = this._takeInstanceSlot(); if (slot < 0) return false; slots.push(slot); }
        this._meshSubmeshSlots.set(m.id, slots);
        for (let si = 0; si < slots.length; si++) { this._writeIncSlot(buf, dataView, normalMat, slots[si], m, m.submeshes[si].material); touched.push(slots[si]); }
      } else {
        if (m.textureLibraryId || m.normalMapLibraryId) return false;
        const slot = this._takeInstanceSlot(); if (slot < 0) return false;
        this._meshInstanceSlots.set(m.id, slot);
        this._writeIncSlot(buf, dataView, normalMat, slot, m, m.material); touched.push(slot);
      }
      m.materialDirty = false;
    }
    if (anyMatDirty) {   // rewrite material-dirty EXISTING meshes at their current slot(s)
      for (const m of meshes) {
        if (!m.materialDirty) continue;
        if (m.submeshes.length > 0) { const ss = this._meshSubmeshSlots.get(m.id); if (ss) for (let si = 0; si < ss.length; si++) { this._writeSlotMaterial(buf, dataView, ss[si] * fpi, m.submeshes[si].material); touched.push(ss[si]); } }
        else { const s = this._meshInstanceSlots.get(m.id); if (s !== undefined) { this._writeSlotMaterial(buf, dataView, s * fpi, m.material); touched.push(s); } }
        m.materialDirty = false;
      }
    }
    // Upload only the touched slots as coalesced runs (same trick as the transforms fast path).
    if (touched.length) {
      touched.sort((a, b) => a - b);
      let runLo = touched[0], prev = touched[0];
      for (let i = 1; i < touched.length; i++) {
        const s = touched[i];
        if (s > prev + 256) { this.device.queue.writeBuffer(this.instanceStorageBuffer, runLo * MESH_INSTANCE_STRIDE, buf, runLo * fpi, (prev - runLo + 1) * fpi); runLo = s; }
        prev = s;
      }
      this.device.queue.writeBuffer(this.instanceStorageBuffer, runLo * MESH_INSTANCE_STRIDE, buf, runLo * fpi, (prev - runLo + 1) * fpi);
    }
    let live = 0; for (const m of meshes) live += Math.max(1, m.submeshes.length);
    this._instanceCount = live;                 // structural-change check next frame compares totalSlots to this
    this._drawOrderDirty = true;                // mesh set changed (adds/removals) → rebuild the cached draw rank
    this._perf.fastPaths++;                     // a cheap path, NOT a full repack
    this._transformsDirty = false;              // every moved resident was rewritten above (no array groups /
                                                // billboards here — caller gate), so the pending fast-path work is done
    // NO _shadowMapStale here: forcing a full-scene shadow re-render on EVERY streamed-tile arrival defeated the
    // shadow throttle mid-pan (the largest per-arrival GPU stall). The interval pass picks new tiles up within
    // `_shadowUpdateInterval` frames anyway (≤3 in city mode) — imperceptible for shadows, huge for pan smoothness.
    return true;
  }

  private uploadMeshInstances(meshes: Mesh3D[]): void {
    // id→mesh for this frame — array-group source lookups (here + the draw loop, which runs after) were meshes.find
    // per group = O(groups×meshes); with ~100+ instanced-detail groups that's a real per-frame cost.
    // ONE pass over meshes: build the id→mesh map AND all the per-frame scans (dirty flags + slot count + billboards).
    // These were 5 separate loops/some()/reduce = ~5× the O(meshes) work EVERY frame before the fast-path early-out —
    // with the tiled world's 3467 meshes that alone was ~13ms (msUpload). Material-only changes (glow/frost/wet walks)
    // set materialDirty (NOT gpuDirty — that would rebuild the geom pool + atlas, a multi-second hitch).
    // Rebuild the id→mesh map only when the mesh SET changed (size mismatch, or a structural signal set the draw
    // rank dirty) — 3500 Map.set every frame just to service source lookups was pure steady-state waste. A stale
    // entry is benign: lookups miss (next structural frame rebuilds) or hit a dead mesh whose version reads are
    // harmless.
    const rebuildMap = this._meshById.size !== meshes.length || this._drawOrderDirty;
    if (rebuildMap) this._meshById.clear();
    let anyGpuDirty = false, anyMatDirty = false, hasBillboards = false, regularSlots = 0;
    for (const m of meshes) {
      if (rebuildMap) this._meshById.set(m.id, m);
      if (m.gpuDirty) anyGpuDirty = true;
      if (m.materialDirty) anyMatDirty = true;
      if (m.billboard) hasBillboards = true;
      regularSlots += Math.max(1, m.submeshes.length);
    }
    const arraySlots = this._arrayGroups.reduce((n, g) => n + getArrayInstanceCount(g.arrayParams), 0);
    const totalSlots = regularSlots + arraySlots;
    // Also check if any array source or object-offset mesh moved since last upload.
    const anyArrayMoved = this._arrayGroups.some(g => {
      const src = this._meshById.get(g.sourceId);
      if (src && src.localMatrixVersion !== (this._arrayGroupSourceVers.get(g.id) ?? -1)) return true;
      if (g.arrayParams.mode === 'linear' && g.arrayParams.objectOffsetId) {
        // _meshById was built at the top of this call — meshes.find here was O(groups×meshes) EVERY frame.
        const off = this._meshById.get(g.arrayParams.objectOffsetId);
        if (off && off.localMatrixVersion !== (this._arrayGroupOffsetVers.get(g.id) ?? -1)) return true;
      }
      return false;
    });
    let billboardViewChanged = false;
    if (hasBillboards) {
      const vm = this.camera.getViewMatrix() as Float32Array;
      billboardViewChanged = this._billboardViewDirty;
      if (!billboardViewChanged) {
        for (let i = 0; i < 16; i++) {
          if (vm[i] !== this._lastBillboardView[i]) { billboardViewChanged = true; break; }
        }
      }
      if (billboardViewChanged) {
        this._lastBillboardView.set(vm);
        this._billboardViewDirty = false;
      }
    }
    if (!this._instancesDirty && !anyGpuDirty && !anyArrayMoved && totalSlots === this._instanceCount && !billboardViewChanged) {
      if (!this._transformsDirty && !anyMatDirty) return;
      // FAST PATH (transforms and/or MATERIAL only): the slot maps, atlas and array-instance POSITIONS are all still
      // valid. Rewrite only the moved slots' matrices + the material-dirty slots' material floats, then upload just
      // that range. This handles the traffic tick (transforms) AND the border-glow pulse / frost / wet material walks
      // (which mark a FEW meshes materialDirty) — the latter used to force a full O(all-slots) repack EVERY frame,
      // the real cause of the fps sink amplified by instancing/chunking. Bail on structural / textured / array-source
      // material changes → full repack.
      if (this._instanceDataBuf) {
        const fpi = MESH_INSTANCE_STRIDE / 4;
        const data = this._instanceDataBuf;
        const normalMat = mat4.create();
        const dv = anyMatDirty ? new DataView(data.buffer, data.byteOffset, data.byteLength) : null;
        const touched = this._fpTouched; touched.length = 0;   // slots written this frame → coalesced into upload runs below
        let bail = false;
        for (const m of meshes) {
          const ver = m.localMatrixVersion;
          const moved = this._slotMatVer.get(m.id) !== ver;
          const matD = m.materialDirty;
          if (!moved && !matD) continue;
          if (m.billboard) { bail = true; break; }
          // Textured, or an array-group SOURCE (its material feeds all its instances) → full path. Material-dirty
          // meshes are FEW (the border-glow pulse), so the per-mesh `.some` over groups is cheaper than a per-frame Set.
          if (matD && (m.material.hasTexture || m.material.hasNormalMap || this._arrayGroups.some(g => g.sourceId === m.id))) { bail = true; break; }
          const slots = m.submeshes.length > 0 ? this._meshSubmeshSlots.get(m.id) : undefined;
          const single = slots ? undefined : this._meshInstanceSlots.get(m.id);
          if (!slots && single === undefined) { bail = true; break; }   // unknown mesh → structural change
          let nc = this._normalMatCache.get(m.id);
          if (moved) {
            if (!nc) { nc = { matVersion: -1, floats: new Float32Array(16) }; this._normalMatCache.set(m.id, nc); }
            if (nc.matVersion !== ver) {
              mat4.invert(normalMat, m.localMatrix);
              mat4.transpose(normalMat, normalMat);
              nc.floats.set(normalMat as Float32Array);
              nc.matVersion = ver;
            }
          }
          // Inline the single-slot vs multi-slot write (no per-mesh closure/array alloc — ~200 movers × 60fps).
          const mlm = m.localMatrix as Float32Array;
          if (slots) {
            for (const slot of slots) {
              const offset = slot * fpi;
              if (moved) { data.set(mlm, offset); data.set(nc!.floats, offset + 16); }
              if (matD) this._writeSlotMaterial(data, dv!, offset, m.material);
              touched.push(slot);
            }
          } else {
            const offset = single! * fpi;
            if (moved) { data.set(mlm, offset); data.set(nc!.floats, offset + 16); }
            if (matD) this._writeSlotMaterial(data, dv!, offset, m.material);
            touched.push(single!);
          }
          if (moved) this._slotMatVer.set(m.id, ver);
          if (matD) m.materialDirty = false;
        }
        if (!bail) {
          // Upload only the RUNS of touched slots — NOT one [lo,hi] span. The moved meshes (traffic movers) are
          // scattered across the geometryKey-sorted buffer, so a single span re-uploads the whole ~190k-instance
          // buffer (43 MB) EVERY frame — the ~23ms msUpload zoomed in. Same-archetype movers ARE slot-contiguous,
          // so sorting + coalescing (merging gaps < GAP; a few extra correct slots is cheaper than another
          // writeBuffer) yields ~one run per moving archetype — uploading only the mover blocks, not the static
          // detail between them.
          if (touched.length) {
            touched.sort((a, b) => a - b);
            const GAP = 256;
            let runLo = touched[0], prev = touched[0];
            for (let i = 1; i < touched.length; i++) {
              const s = touched[i];
              if (s > prev + GAP) {
                this.device.queue.writeBuffer(this.instanceStorageBuffer!, runLo * MESH_INSTANCE_STRIDE, data, runLo * fpi, (prev - runLo + 1) * fpi);
                runLo = s;
              }
              prev = s;
            }
            this.device.queue.writeBuffer(this.instanceStorageBuffer!, runLo * MESH_INSTANCE_STRIDE, data, runLo * fpi, (prev - runLo + 1) * fpi);
          }
          this._perf.fastPaths++;
          this._transformsDirty = false;
          return;
        }
      }
      // fall through → full repack
    }

    // INCREMENTAL append/free path (streaming-pan smoothness): a pure structural change (meshes added/removed) with
    // NO array groups / billboards / atlas change / buffer resize can append the new meshes' slots + upload just those
    // — no re-sort, no whole-buffer re-upload. This is the common tiled-streaming case (flat-color tiles, arrays
    // LOD-hidden, traffic off). Bails to the full repack below on anything it can't handle.
    if (this._arrayGroups.length === 0 && !this._instancesDirty && !anyArrayMoved && !this._atlasDirty && !hasBillboards
        && this._tryIncrementalInstances(meshes, anyMatDirty)) {
      return;
    }

    this._perf.fullRepacks++;
    // Sort single-material meshes by geometryKey (contiguous same-geometry slots enable
    // batched instanced draws). Multi-submesh meshes sort last — they can't be instanced.
    // Plain < > compare (NOT localeCompare — 10-100× slower, and this sort runs on every full repack).
    const sorted = meshes.slice().sort((a, b) => {
      const aMulti = a.submeshes.length > 0 ? 1 : 0;
      const bMulti = b.submeshes.length > 0 ? 1 : 0;
      if (aMulti !== bMulti) return aMulti - bMulti;
      const ak = a.geometryKey, bk = b.geometryKey;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
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
      this._slotMatVer.set(m.id, m.localMatrixVersion);   // the transforms-only fast path diffs against this

      if (m.billboard) {
        // Billboard: override model matrix each frame to face the camera.
        // View matrix (column-major): [0,4,8]=right, [1,5,9]=up, [2,6,10]=backward
        const vm = this.camera.getViewMatrix() as Float32Array;
        const lm = localMat as Float32Array;
        // Extract scale from local matrix columns
        const sx = Math.hypot(lm[0], lm[1], lm[2]);
        const sy = Math.hypot(lm[4], lm[5], lm[6]);
        const sz = Math.hypot(lm[8], lm[9], lm[10]);
        // Col 0 = camera right * sx
        data[offset]      = vm[0] * sx; data[offset + 1] = vm[4] * sx;
        data[offset + 2]  = vm[8] * sx; data[offset + 3] = 0;
        // Col 1 = camera up * sy
        data[offset + 4]  = vm[1] * sy; data[offset + 5] = vm[5] * sy;
        data[offset + 6]  = vm[9] * sy; data[offset + 7] = 0;
        // Col 2 = camera backward * sz
        data[offset + 8]  = vm[2] * sz; data[offset + 9]  = vm[6] * sz;
        data[offset + 10] = vm[10] * sz; data[offset + 11] = 0;
        // Col 3 = world position from local matrix
        data[offset + 12] = lm[12]; data[offset + 13] = lm[13];
        data[offset + 14] = lm[14]; data[offset + 15] = 1;

        // Normal matrix = R * S^-1 (inverse-transpose of billboard rotation×scale).
        // For orthonormal R (view rotation), this equals R with columns scaled by 1/s.
        const isx = sx > 0 ? 1 / sx : 1;
        const isy = sy > 0 ? 1 / sy : 1;
        const isz = sz > 0 ? 1 / sz : 1;
        data[offset + 16] = vm[0] * isx; data[offset + 17] = vm[4] * isx;
        data[offset + 18] = vm[8] * isx; data[offset + 19] = 0;
        data[offset + 20] = vm[1] * isy; data[offset + 21] = vm[5] * isy;
        data[offset + 22] = vm[9] * isy; data[offset + 23] = 0;
        data[offset + 24] = vm[2] * isz; data[offset + 25] = vm[6] * isz;
        data[offset + 26] = vm[10] * isz; data[offset + 27] = 0;
        data[offset + 28] = 0; data[offset + 29] = 0; data[offset + 30] = 0; data[offset + 31] = 1;
      } else {
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
      }

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

      // textureIndex / normalMapIndex (floats 44-45 as u32); roughness + metalness (floats 46-47 as f32)
      const texIdx  = this._atlasLayerMap.get(texId)  ?? 0;
      const normIdx = this._normalAtlasLayerMap.get(normId) ?? 0;
      dataView.setUint32((offset + 44) * 4, texIdx,  true);
      dataView.setUint32((offset + 45) * 4, normIdx, true);
      data[offset + 46] = mat3d.roughness ?? 0.5;
      data[offset + 47] = mat3d.metalness ?? 0.0;

      // patternColor (floats 48-51, secondary colour) + patternParams = freq,angle,scale,spacing (52-55)
      const pc = mat3d.patternColor;
      data[offset + 48] = pc?.r ?? 0; data[offset + 49] = pc?.g ?? 0; data[offset + 50] = pc?.b ?? 0; data[offset + 51] = 0;
      data[offset + 52] = mat3d.patternFreq ?? 8;
      data[offset + 53] = mat3d.patternAngle ?? 0;
      data[offset + 54] = mat3d.patternScale ?? 0.5;
      data[offset + 55] = mat3d.patternSpacing ?? 0;
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
      m.materialDirty = false;   // slot repacked — the material-only flag is served
    }

    // Write GPU-instanced array group data.
    // Each instance reuses source R+S from source's localMatrix with modified translation.
    // Normal matrix is the same as source (translation doesn't affect inverse-transpose).
    for (const group of this._arrayGroups) {
      const firstSlot = this._arrayGroupFirstSlot.get(group.id);
      if (firstSlot === undefined) continue;
      const srcM = this._meshById.get(group.sourceId);   // O(1) — was an O(meshes) find PER GROUP on every repack
      const source = srcM && srcM.submeshes.length === 0 ? srcM : undefined;
      if (!source) continue;

      const srcSlot   = this._meshInstanceSlots.get(source.id)!;
      const srcOffset = srcSlot * floatsPerInstance;
      const srcMat    = source.localMatrix as Float32Array;
      const nc        = this._normalMatCache.get(source.id);

      // Resolve relative spacing to absolute world units using the source mesh AABB size.
      let resolvedParams = group.arrayParams;
      if ((group.arrayParams.mode === 'linear' || group.arrayParams.mode === 'grid') &&
          group.arrayParams.spacingMode === 'relative') {
        const aabb = this.getMeshWorldAABB3D(source);
        if (aabb) {
          resolvedParams = resolveArraySpacing(group.arrayParams, [
            aabb.maxX - aabb.minX,
            aabb.maxY - aabb.minY,
            aabb.maxZ - aabb.minZ,
          ]);
        }
      }

      const offsets   = computeArrayOffsets(resolvedParams, [source.x, source.y, source.z], this._arrayGroupLocalBases.get(group.id));

      // Randomize params (linear and grid only; radial uses arc/radius for distribution)
      const rnd = (group.arrayParams.mode === 'linear' || group.arrayParams.mode === 'grid') ? group.arrayParams.randomize : undefined;

      // Object offset mode: D = offsetMesh.localMatrix × inv(srcMat), accum advances by D each copy.
      const objectOffsetId = group.arrayParams.mode === 'linear' ? group.arrayParams.objectOffsetId : undefined;
      let accumMat: Float32Array | null = null;
      let objectOffsetD: Float32Array | null = null;
      if (objectOffsetId) {
        const offM = this._meshById.get(objectOffsetId);
        const offsetMesh = offM && offM.submeshes.length === 0 ? offM : undefined;
        if (offsetMesh) {
          const invSrc = mat4.invert(mat4.create() as Float32Array, srcMat as any) as Float32Array;
          objectOffsetD = mat4.multiply(mat4.create() as Float32Array, offsetMesh.localMatrix as any, invSrc as any) as Float32Array;
          accumMat = new Float32Array(srcMat);
        }
      }

      for (let i = 0; i < offsets.length; i++) {
        const slot   = firstSlot + i;
        const offset = slot * floatsPerInstance;

        // Advance object-offset accumulator first (must happen even for hidden instances).
        if (accumMat && objectOffsetD) {
          mat4.multiply(accumMat as any, objectOffsetD as any, accumMat as any);
        }

        // Position randomize only in standard (non-object-offset) mode.
        let [dx, dy, dz] = offsets[i];
        if (!accumMat && rnd) {
          dx += hashRand(rnd.seed, i, 0) * rnd.positionAmp[0];
          dy += hashRand(rnd.seed, i, 1) * rnd.positionAmp[1];
          dz += hashRand(rnd.seed, i, 2) * rnd.positionAmp[2];
        }

        const baseOv = group.instanceOverrides?.get(i);
        // Merge explicit override with randomize rotation/scale
        let ov = baseOv;
        if (rnd && (rnd.rotationAmp[0] || rnd.rotationAmp[1] || rnd.rotationAmp[2] || rnd.scaleAmp)) {
          const rxr = hashRand(rnd.seed, i, 3) * rnd.rotationAmp[0];
          const ryr = hashRand(rnd.seed, i, 4) * rnd.rotationAmp[1];
          const rzr = hashRand(rnd.seed, i, 5) * rnd.rotationAmp[2];
          const sv  = rnd.scaleAmp ? 1 + hashRand(rnd.seed, i, 6) * rnd.scaleAmp : 1;
          ov = {
            ...baseOv,
            rotationEulerDeg: [
              (baseOv?.rotationEulerDeg?.[0] ?? 0) + rxr,
              (baseOv?.rotationEulerDeg?.[1] ?? 0) + ryr,
              (baseOv?.rotationEulerDeg?.[2] ?? 0) + rzr,
            ],
            scale: [
              (baseOv?.scale?.[0] ?? 1) * sv,
              (baseOv?.scale?.[1] ?? 1) * sv,
              (baseOv?.scale?.[2] ?? 1) * sv,
            ],
          };
        }

        // Hidden instance — zero out upper-left 3×3 so the GPU draws nothing.
        if (ov?.visible === false) {
          data.fill(0, offset, offset + 12);
          data[offset + 15] = 1; // keep valid w
          if (nc) data.set(nc.floats, offset + 16);
          data.copyWithin(offset + 32, srcOffset + 32, srcOffset + 48);
          continue;
        }

        if (accumMat) {
          // Object offset mode: write full accumulated matrix.
          data.set(accumMat, offset);
        } else {
          // Standard mode: copy source matrix and override only the translation column.
          data.set(srcMat, offset);
          if (group.arrayParams.mode === 'explicit') {
            // Explicit offsets are in the source's PARENT space (metres). srcMat is the source's WORLD matrix, so a
            // scaled/rotated parent (e.g. a Block at 0.1 units/m) must transform the offset by the parent chain's
            // upper-3×3 before adding — otherwise the offsets are applied at raw metre scale and instances fly off.
            // (Parent = identity at scene root → no change, so the linear/grid/radial array tool is unaffected.)
            const pcm = source.parentChainMatrix as unknown as Float32Array;
            data[offset + 12] = srcMat[12] + pcm[0] * dx + pcm[4] * dy + pcm[8] * dz;
            data[offset + 13] = srcMat[13] + pcm[1] * dx + pcm[5] * dy + pcm[9] * dz;
            data[offset + 14] = srcMat[14] + pcm[2] * dx + pcm[6] * dy + pcm[10] * dz;
          } else {
            data[offset + 12] = srcMat[12] + dx;
            data[offset + 13] = srcMat[13] + dy;
            data[offset + 14] = srcMat[14] + dz;
          }
        }

        // Per-instance rotation / scale override: post-multiply upper-left 3×3 by override matrix.
        if (ov && (ov.rotationEulerDeg || ov.scale)) {
          const om = this._overrideScratch;
          mat4.identity(om as any);
          const DEG = Math.PI / 180;
          const [rx, ry, rz] = ov.rotationEulerDeg ?? [0, 0, 0];
          if (rx) mat4.rotateX(om as any, om as any, rx * DEG);
          if (ry) mat4.rotateY(om as any, om as any, ry * DEG);
          if (rz) mat4.rotateZ(om as any, om as any, rz * DEG);
          if (ov.scale) mat4.scale(om as any, om as any, ov.scale as any);

          // Multiply: instance_upper3x3 = instance_upper3x3 * om_upper3x3  (local-space post-multiply)
          // Column-major: C_col_j = A * B_col_j
          const a00=data[offset+0], a10=data[offset+1], a20=data[offset+2];
          const a01=data[offset+4], a11=data[offset+5], a21=data[offset+6];
          const a02=data[offset+8], a12=data[offset+9], a22=data[offset+10];
          const om0=om[0], om1=om[1], om2=om[2];
          const om4=om[4], om5=om[5], om6=om[6];
          const om8=om[8], om9=om[9], om10=om[10];

          data[offset+0]  = a00*om0 + a01*om1 + a02*om2;
          data[offset+1]  = a10*om0 + a11*om1 + a12*om2;
          data[offset+2]  = a20*om0 + a21*om1 + a22*om2;
          data[offset+4]  = a00*om4 + a01*om5 + a02*om6;
          data[offset+5]  = a10*om4 + a11*om5 + a12*om6;
          data[offset+6]  = a20*om4 + a21*om5 + a22*om6;
          data[offset+8]  = a00*om8 + a01*om9 + a02*om10;
          data[offset+9]  = a10*om8 + a11*om9 + a12*om10;
          data[offset+10] = a20*om8 + a21*om9 + a22*om10;

          // Recompute normal matrix (inverse-transpose) for this modified instance.
          const nm = this._overrideScratch;
          nm.set(data.subarray(offset, offset + 16));
          nm[3] = 0; nm[7] = 0; nm[11] = 0; nm[15] = 1;
          mat4.invert(nm as any, nm as any);
          mat4.transpose(nm as any, nm as any);
          data.set(nm, offset + 16);
        } else if (accumMat) {
          // Object offset: each instance has a unique full transform — always recompute normal matrix.
          const nm = this._overrideScratch;
          nm.set(accumMat);
          nm[3] = 0; nm[7] = 0; nm[11] = 0; nm[15] = 1;
          mat4.invert(nm as any, nm as any);
          mat4.transpose(nm as any, nm as any);
          data.set(nm, offset + 16);
        } else {
          // Normal matrix: same as source (no override — translation doesn't change inverse-transpose)
          if (nc) data.set(nc.floats, offset + 16);
        }

        // Material + texture: copy the 16 floats from source's slot (offsets 32–47)
        data.copyWithin(offset + 32, srcOffset + 32, srcOffset + 48);
      }

      this._arrayGroupSourceVers.set(group.id, source.localMatrixVersion);
      if (objectOffsetId) {
        const offV = this._meshById.get(objectOffsetId);
        const off = offV && offV.submeshes.length === 0 ? offV : undefined;
        if (off) this._arrayGroupOffsetVers.set(group.id, off.localMatrixVersion);
      }
    }

    this.device.queue.writeBuffer(this.instanceStorageBuffer!, 0, data, 0, needed);
    this._instancesDirty = false;
    this._transformsDirty = false;   // a full repack supersedes any pending fast-path work
    this._instanceCount = totalSlots;
    this._instanceFreeSlots.length = 0;   // repack packed everything contiguous [0, totalSlots) — no holes, no free slots
    this._instanceHigh = totalSlots;      // the incremental append path continues from here
    this._drawOrderDirty = true;          // slot layout changed → rebuild the cached draw rank
  }

  /**
   * Build or rebuild the shared texture_2d_array atlas from all TextureLibrary textures
   * referenced by visible meshes. Layer 0 = white default (for untextured / fallback).
   * Only textures with COPY_SRC usage and matching atlas dimensions are packed; others
   * fall back to the standalone per-mesh bind group with textureIndex = 0.
   */
  private _buildTextureAtlas(meshes: Mesh3D[]): void {
    const atlasT0 = performance.now();
    this._perf.atlasRebuilds++;
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
        { binding: 1, resource: this.pipeline.activeSampler },
        { binding: 2, resource: normView },
        { binding: 3, resource: this.pipeline.activeSampler },
      ],
    });

    this._atlasDirty = false;
    this._perf.lastAtlasMs = performance.now() - atlasT0;
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
    // A RESIDENT mesh flagged gpuDirty = its pooled geometry actually changed (edit/import) → its alloc is
    // stale → full rebuild (rare; the char-editor path). gpuDirty on a NEW (unpooled) mesh just means "needs
    // uploading" — the append path handles that (and clears the flag), so it must NOT force a rebuild.
    let dirtyResident = false;
    let fresh: Mesh3D[] | null = null;
    for (const m of meshes) {
      if (!m.geometry || m.geometry.vertices.length === 0) continue;
      if (this._geomAllocs.has(m.id)) { if (m.gpuDirty) { dirtyResident = true; break; } }
      else (fresh ??= []).push(m);
    }
    // A forced compaction (requested when the camera goes idle after streaming) reclaims the dead space that
    // disposed tiles leave behind — BUT only when there's actually fresh geometry to place or real dead space to
    // reclaim, and never mid-motion (the caller only requests it on idle). This keeps the ~68 ms full re-upload OFF
    // the pan path: it happens once you stop, not while you're moving.
    if (dirtyResident || !this._geomVB || (this._forceCompact && this._compactionWorthwhile())) {
      this._forceCompact = false;
      return this._fullRebuildGeomPool(meshes);
    }
    this._forceCompact = false;
    // The only change is meshes the pool hasn't seen (a regen / async reveal / newly added group). APPEND their
    // geometry at the tail instead of re-uploading the whole pool; compact only if they won't fit. Removed
    // meshes leave their alloc parked (dead space) until the next compaction.
    if (fresh && !this._appendGeometry(fresh)) return this._fullRebuildGeomPool(meshes);   // overflow → compact
    return this._geomAllocs.size > 0;
  }

  private _forceCompact = false;
  /** Request a one-time geometry-pool COMPACTION on the next frame — reclaims the dead space that disposed streamed
   *  tiles leave behind (the append-only pool never shrinks on its own). The world manager calls this when the
   *  camera goes IDLE after streaming, so the ~68 ms full re-upload lands on a still frame, not mid-pan.
   *  NEED-GATED (`_compactionWorthwhile`): honoured only when real fragmented waste has accumulated — it used to
   *  fire UNCONDITIONALLY after every reconcile-settle, so a tiny pan that nudged one edge tile bought a 68 ms
   *  hitch on the pause (the "small back-and-forth pans lag" report). */
  requestGeomCompaction(): void { this._forceCompact = true; }

  /** Compaction is only worth its ~68 ms full re-upload when the free list holds a LOT of fragmented dead space.
   *  With region reuse + coalescing, disposed tiles' space normally gets recycled by the next tiles instead. */
  private _compactionWorthwhile(): boolean {
    let freeVtx = 0;
    for (const f of this._geomFree) freeVtx += f.vtxBytes;
    return freeVtx > Math.max(64 << 20, this._geomVtxTail * 0.25);   // >64 MB or >25% of the used span
  }

  /** Append geometry for meshes the pool hasn't seen — uploading ONLY the new unique geometries, REUSING a freed
   *  region when one fits (else at the tail). Ref-counts each geometryKey across its meshes. Returns false if a new
   *  geometry needs the tail but would overflow (caller compacts via a full rebuild). */
  private _appendGeometry(fresh: Mesh3D[]): boolean {
    // Unique geometryKeys among the fresh meshes that aren't already resident (dedupe within + against pool).
    const newKeys = new Map<string, import('./mesh-generators').MeshGeometry>();
    for (const m of fresh) {
      const key = m.geometryKey;
      if (!this._geomKeyAllocs.has(key) && !newKeys.has(key)) newKeys.set(key, m.geometry!);
    }
    // Pre-check tail overflow for the SUBSET of new geometry that won't find a free region — but the free-list
    // check is per-key, so do it inline and bail (return false → compact) the moment a key needs the tail and
    // won't fit. Anything uploaded before the bail stays valid; the compaction reuploads everything anyway.
    for (const [key, g] of newKeys) {
      const needVtx = g.vertices.byteLength, needIdx = g.indices.byteLength;
      const free = this._takeFreeRegion(needVtx, needIdx);
      let vtxOff: number, idxOff: number;
      if (free) {
        vtxOff = free.vtxOff; idxOff = free.idxOff;
      } else {
        if (this._geomVtxTail + needVtx > this._geomVBCap || this._geomIdxTail + needIdx > this._geomIBCap) return false;
        vtxOff = this._geomVtxTail; idxOff = this._geomIdxTail;
        this._geomVtxTail += needVtx; this._geomIdxTail += needIdx;
      }
      this.device.queue.writeBuffer(this._geomVB!, vtxOff, g.vertices.buffer, g.vertices.byteOffset, needVtx);
      this.device.queue.writeBuffer(this._geomIB!, idxOff, g.indices.buffer, g.indices.byteOffset, needIdx);
      this._geomKeyAllocs.set(key, { baseVertex: vtxOff / MESH3D_VERTEX_STRIDE, firstIndex: idxOff / 4, indexCount: g.indices.length, vtxBytes: needVtx, idxBytes: needIdx });
    }
    for (const m of fresh) {
      const alloc = this._geomKeyAllocs.get(m.geometryKey);
      if (!alloc) continue;
      this._geomAllocs.set(m.id, alloc);
      this._geomPoolIds.push(m.id);
      this._geomMeshKey.set(m.id, m.geometryKey);
      this._geomKeyRefs.set(m.geometryKey, (this._geomKeyRefs.get(m.geometryKey) ?? 0) + 1);
      m.gpuDirty = false;
    }
    this._perf.appends++;
    // NO _shadowMapStale here — appends happen on EVERY streamed-tile arrival, and force-refreshing the shadow map
    // each time bypassed the throttle (a full-scene depth pass every few frames mid-pan). The interval pass picks
    // the new geometry up within `_shadowUpdateInterval` frames (≤3 in city mode).
    return true;
  }

  /** Best-fit a freed region for `needVtx`/`needIdx` bytes; split the remainder back onto the free list. Returns
   *  the region's offsets, or null if none fits (caller uses the tail). */
  private _takeFreeRegion(needVtx: number, needIdx: number): { vtxOff: number; idxOff: number } | null {
    let best = -1, bestWaste = Infinity;
    for (let i = 0; i < this._geomFree.length; i++) {
      const f = this._geomFree[i];
      if (f.vtxBytes < needVtx || f.idxBytes < needIdx) continue;
      const waste = (f.vtxBytes - needVtx) + (f.idxBytes - needIdx);
      if (waste < bestWaste) { best = i; bestWaste = waste; }
    }
    if (best < 0) return null;
    const f = this._geomFree[best];
    this._geomFree.splice(best, 1);
    const vtxOff = f.vtxOff, idxOff = f.idxOff;
    const remVtx = f.vtxBytes - needVtx, remIdx = f.idxBytes - needIdx;   // split: keep the leftover paired span
    // Return ANY non-empty leftover (even one-sided — an all-vtx/no-idx sliver is unusable alone but coalesces
    // back into a usable region when its neighbour frees; dropping it was a slow permanent leak).
    if (remVtx > 0 || remIdx > 0) this._pushFreeRegion(vtxOff + needVtx, remVtx, idxOff + needIdx, remIdx);
    return { vtxOff, idxOff };
  }

  /** Return a region to the free list, COALESCING with any region adjacent in BOTH spans (appends allocate the
   *  vtx+idx spans in lockstep, so neighbours freed together merge back into one). Without merging, streaming
   *  in/out fragments the free list monotonically until nothing fits and the ~68 ms full rebuild fires MID-PAN.
   *  A region that ends up flush against the tails retracts them instead (the pool actually shrinks). */
  private _pushFreeRegion(vtxOff: number, vtxBytes: number, idxOff: number, idxBytes: number): void {
    const free = this._geomFree;
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < free.length; i++) {
        const f = free[i];
        if (f.vtxOff + f.vtxBytes === vtxOff && f.idxOff + f.idxBytes === idxOff) {         // f directly precedes us
          vtxOff = f.vtxOff; idxOff = f.idxOff; vtxBytes += f.vtxBytes; idxBytes += f.idxBytes;
          free.splice(i, 1); merged = true; break;
        }
        if (vtxOff + vtxBytes === f.vtxOff && idxOff + idxBytes === f.idxOff) {             // f directly follows us
          vtxBytes += f.vtxBytes; idxBytes += f.idxBytes;
          free.splice(i, 1); merged = true; break;
        }
      }
    }
    if (vtxOff + vtxBytes === this._geomVtxTail && idxOff + idxBytes === this._geomIdxTail) {
      this._geomVtxTail = vtxOff; this._geomIdxTail = idxOff;   // flush with the tail → retract instead of listing
      return;
    }
    free.push({ vtxOff, vtxBytes, idxOff, idxBytes });
  }

  /** A mesh using `key` was evicted — drop its ref; when the last user is gone, return the key's region to the
   *  free list for reuse (no dead space accumulates → no forced rebuild while streaming). */
  private _releaseGeomKey(key: string): void {
    const n = (this._geomKeyRefs.get(key) ?? 0) - 1;
    if (n > 0) { this._geomKeyRefs.set(key, n); return; }
    this._geomKeyRefs.delete(key);
    const a = this._geomKeyAllocs.get(key);
    if (a) {
      this._geomKeyAllocs.delete(key);
      this._pushFreeRegion(a.baseVertex * MESH3D_VERTEX_STRIDE, a.vtxBytes, a.firstIndex * 4, a.idxBytes);
    }
  }

  /** Evict all per-mesh CPU bookkeeping for removed meshes (group removal). Without this every city regen
   *  leaked hundreds of Map entries (`_geomAllocs`/`_normalMatCache`/`_slotMatVer`/slot maps) — unbounded
   *  growth → GC pressure → periodic frame dips. The buffer's dead space is reclaimed by the next compacting
   *  pool rebuild; this just frees the CPU side + forces a clean repack. */
  evictMeshCaches(ids: Iterable<string>): void {
    let any = false;
    for (const id of ids) {
      any = true;
      const gk = this._geomMeshKey.get(id);   // free-list: drop this mesh's ref on its geometry; last one frees the region
      if (gk !== undefined) { this._geomMeshKey.delete(id); this._releaseGeomKey(gk); }
      this._geomAllocs.delete(id);
      this._normalMatCache.delete(id);
      this._slotMatVer.delete(id);
      // FREE this mesh's instance slot(s) back to the pool so the incremental add path reuses them (no full repack).
      const isl = this._meshInstanceSlots.get(id);
      if (isl !== undefined) this._instanceFreeSlots.push(isl);
      const ssl = this._meshSubmeshSlots.get(id);
      if (ssl) for (const s of ssl) this._instanceFreeSlots.push(s);
      this._meshInstanceSlots.delete(id);
      this._meshSubmeshSlots.delete(id);
      this._drawOrder.delete(id);
      this._drawOrderDirty = true;   // mesh set changed → rebuild the cached draw rank
      // Also the world-AABB (frustum culling populates one PER mesh) and the texture bind group — without
      // these, every city regen leaked ~700 stale AABB entries that were never freed, growing the JS heap
      // over a session → slower + more frequent major GCs (the periodic frame-drops that worsen over time).
      this._meshAABBCache.delete(id);
      this._texBindGroupCache.delete(id);
      // Skinned-mesh GPU buffers (VRAM). Renderer-owned → destroy. Previously freed ONLY on whole-renderer
      // dispose, so every character/skinned-mesh create→delete cycle leaked its VB/IB/skin-matrix buffers.
      this._skinnedVBs.get(id)?.destroy();       this._skinnedVBs.delete(id);
      this._skinnedIBs.get(id)?.destroy();       this._skinnedIBs.delete(id);
      // Skin-matrix buffer + bind group are SHARED per skeleton (refcounted): release this mesh's
      // ref; the last mesh out destroys them. The _meshSkelRef guard makes a double-evict of the
      // same mesh id (delete → redo-delete) a no-op instead of a double-decrement.
      const skelId = this._meshSkelRef.get(id);
      if (skelId !== undefined) { this._meshSkelRef.delete(id); this._releaseSkelBuf(skelId); }
      this._skinnedVCBufs.get(id)?.destroy();     this._skinnedVCBufs.delete(id);
      this._skinnedVCBGs.delete(id);             // GPUBindGroup has no destroy() — GC'd when unreferenced
      this._vcColorBuffers.get(id)?.destroy();   this._vcColorBuffers.delete(id);
      this._vertexBufferOverrides.delete(id);    // buffer owned by ClothSimulator — release ref, don't destroy
    }
    // NO _instancesDirty here: setting it forced a FULL repack on every eviction frame — which is every few frames
    // while panning a streamed world — and the repack zeroes `_instanceFreeSlots`, so the freed slots pushed above
    // were never actually reused (the incremental path was dead on exactly the frames it was built for). Removal
    // needs no repack at all: the freed slots are holes the per-mesh draw loop never reads, `totalSlots !==
    // _instanceCount` routes the next upload through `_tryIncrementalInstances` (which refreshes the count), and
    // anything the incremental path can't represent (arrays/billboards/atlas) still bails to the full repack.
  }

  /** PRE-UPLOAD geometry for meshes that are about to become visible (async city staging). Spreads the GPU
   *  upload across the staging frames so the reveal SWAP is a cheap visibility flip (no big upload, no rebuild).
   *  Returns false if the pool would overflow (caller lets the eventual reveal compact). */
  warmGeometry(meshes: Mesh3D[]): boolean {
    if (!this._geomVB) return false;   // no pool yet — the first build will upload everything anyway
    let fresh: Mesh3D[] | null = null;
    for (const m of meshes) {
      if (m.geometry && m.geometry.vertices.length > 0 && !this._geomAllocs.has(m.id)) (fresh ??= []).push(m);
    }
    if (!fresh) return true;
    const ok = this._appendGeometry(fresh);
    if (ok) this._perf.warms++;
    return ok;
  }

  private _fullRebuildGeomPool(meshes: Mesh3D[]): boolean {
    const t0 = performance.now();
    this._perf.poolRebuilds++;
    this._shadowMapStale = true;   // geometry changed → the throttled shadow map must refresh
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

    // Grow shared buffers when the LIVE data no longer fits — with generous headroom so subsequent regens
    // APPEND (cheap) rather than recompacting. Never shrinks (keeps append room). CLAMP to the device's max buffer
    // size: requesting more (e.g. 2.5× of a 1.3 GB tiled world) makes createBuffer fail → an INVALID buffer that
    // poisons every later write → black canvas. Clamping keeps the pool valid; if the live geometry itself is near
    // the cap, appends just compact more often instead of crashing. (Keeping resident geometry well under this is
    // the streaming budget's job — see _streamBudget's small full-detail radius.)
    const maxBuf = this.device.limits.maxBufferSize || 0x10000000;   // WebGPU guarantees ≥ 256 MB
    if (totalVtxBytes > this._geomVBCap) {
      this._geomVB?.destroy();
      this._geomVBCap = Math.min(Math.ceil(totalVtxBytes * Renderer3D.GEOM_OVERPROVISION), maxBuf);
      this._geomVB = this.device.createBuffer({
        size: this._geomVBCap,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'GeomPool VB',
      });
    }
    if (totalIdxBytes > this._geomIBCap) {
      this._geomIB?.destroy();
      this._geomIBCap = Math.min(Math.ceil(totalIdxBytes * Renderer3D.GEOM_OVERPROVISION), maxBuf);
      this._geomIB = this.device.createBuffer({
        size: this._geomIBCap,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: 'GeomPool IB',
      });
    }

    // Second pass: upload each unique geometry once, assign shared allocs to all instances. Compaction resets
    // the append tails + key map + FREE LIST + ref counts — so any stale allocs / dead space / fragmentation from
    // removed meshes are reclaimed here (a clean, contiguous repack).
    this._geomKeyAllocs.clear();
    this._geomAllocs.clear();
    this._geomKeyRefs.clear();
    this._geomMeshKey.clear();
    this._geomFree = [];
    this._geomPoolIds = [];
    let vtxByteOffset = 0;
    let idxByteOffset = 0;

    for (const m of meshes) {
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;

      const key = m.geometryKey;
      let alloc = this._geomKeyAllocs.get(key);

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
        alloc = { baseVertex, firstIndex, indexCount: g.indices.length, vtxBytes: g.vertices.byteLength, idxBytes: g.indices.byteLength };
        this._geomKeyAllocs.set(key, alloc);
        vtxByteOffset += g.vertices.byteLength;
        idxByteOffset += g.indices.byteLength;
      }
      // Shared: all instances of the same geometry point to the same pool slot.
      this._geomAllocs.set(m.id, alloc);
      this._geomPoolIds.push(m.id);
      this._geomMeshKey.set(m.id, key);
      this._geomKeyRefs.set(key, (this._geomKeyRefs.get(key) ?? 0) + 1);
      m.gpuDirty = false;
    }

    this._geomVtxTail = vtxByteOffset;
    this._geomIdxTail = idxByteOffset;
    this._perf.lastPoolMs = performance.now() - t0;
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

  /** Upload per-vertex heat colors for weight paint mode into a GPU storage buffer. */
  private _ensureSkinnedVCBuf(mesh: SkinnedMesh3D): void {
    const vc = mesh.vertexColors;
    if (!vc) return;
    let buf = this._skinnedVCBufs.get(mesh.id);
    if (!buf || buf.size < vc.byteLength) {
      buf?.destroy();
      buf = this.device.createBuffer({
        size: vc.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: `SkinnedVC-${mesh.id}`,
      });
      this._skinnedVCBufs.set(mesh.id, buf);
      this._skinnedVCBGs.delete(mesh.id);
    }
    this.device.queue.writeBuffer(buf, 0, vc);
    if (!this._skinnedVCBGs.has(mesh.id)) {
      this._skinnedVCBGs.set(mesh.id, this.device.createBindGroup({
        layout: this.pipeline.weightPaintBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: buf } }],
      }));
    }
  }

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
    const visible = this._skinnedVisibleScratch; visible.length = 0;
    for (const m of meshes) if (m.isEffectivelyVisible() && m.skeleton) visible.push(m);
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

    // Fresh draw call → each dirty skeleton's shared skin buffer uploads once below.
    this._skinBufUploaded.clear();

    // Recreate mesh bind group when buffer reference changed.
    if (!this._skinnedMeshBG || this._skinnedMeshBGBuf !== this._skinnedInstBuf) {
      this._skinnedMeshBG = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this._skinnedInstBuf! } },
          { binding: 1, resource: { buffer: this.sceneUniformBuffer } },
          { binding: 2, resource: { buffer: this._iblUniformBuffer! } },
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
      const skinBG = this._skinBGs.get(mesh.skeleton.id);   // shared per-skeleton bind group
      if (!vb || !ib || !skinBG) continue;

      pass.setVertexBuffer(0, vb);
      pass.setIndexBuffer(ib, 'uint32');

      if (mesh.vertexColors) {
        this._ensureSkinnedVCBuf(mesh);
        const vcBG = this._skinnedVCBGs.get(mesh.id);
        if (vcBG) {
          pass.setPipeline(this._weightPaintUnlit
            ? this.pipeline.skinnedWeightPaintUnlitPipeline
            : this.pipeline.skinnedWeightPaintPipeline);
          pass.setBindGroup(0, this._skinnedMeshBG!);
          pass.setBindGroup(1, skinBG);
          pass.setBindGroup(2, vcBG);
        }
      } else {
        const useTexture = mesh.material.hasTexture || mesh.material.hasNormalMap;
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
      }

      pass.drawIndexed(mesh.geometry.indices.length, 1, 0, 0, i);
    }

    // Every dirty skeleton's SHARED skin buffer has now uploaded (once, via _skinBufUploaded), so
    // clear each skeleton's dirty flag once (idempotent across meshes that share one). Clearing
    // earlier — inside _ensureSkinMatBuf — historically starved the 2nd+ mesh sharing a skeleton
    // (e.g. a face decal on a body) back when each mesh owned its own buffer; with the shared
    // buffer the flag must still survive the whole loop so a skeleton first seen mid-loop (its
    // buffer freshly created) uploads correctly before the flag drops here.
    for (const m of visible) { if (m.skeleton) m.skeleton.matricesDirty = false; }
  }

  /** Upload transform + material data for skinned meshes into the skinned instance buffer. */
  private _uploadSkinnedInstances(meshes: SkinnedMesh3D[]): void {
    const floatsPerInst = MESH_INSTANCE_STRIDE / 4;
    const needFloats = meshes.length * floatsPerInst;
    // Reuse a persistent scratch buffer (grow-only) instead of a fresh Float32Array + DataView every frame.
    if (!this._skinnedInstData || this._skinnedInstData.length < needFloats) {
      this._skinnedInstData = new Float32Array(needFloats);
      this._skinnedInstDataView = new DataView(this._skinnedInstData.buffer);
    }
    const data     = this._skinnedInstData;
    const dataView = this._skinnedInstDataView!;
    const normalMat = this._skinnedNormalMat;
    const ident = this._skinnedIdent as Float32Array;   // identity model+normal for skeleton-driven meshes

    for (let i = 0; i < meshes.length; i++) {
      const m  = meshes[i];
      const off = i * floatsPerInst;

      if (m.transformViaSkeleton) {
        // Object transform lives on the skeleton (objectTransform, applied in computeWorldMatrices) →
        // render with an IDENTITY model + normal matrix; applying localMatrix too would double.
        data.set(ident, off);        // modelMatrix (floats 0–15)
        data.set(ident, off + 16);   // normalMatrix = inverse-transpose(identity) = identity
      } else {
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
      }

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

      // textureIndex / normalMapIndex (uint32 at floats 44–45); roughness / metalness (f32 at 46–47)
      dataView.setUint32((off + 44) * 4, 0, true);
      dataView.setUint32((off + 45) * 4, 0, true);
      data[off + 46] = m.material.roughness ?? 0.5;
      data[off + 47] = m.material.metalness ?? 0.0;

      // patternColor (floats 48-51) + patternParams = freq,angle,scale,spacing (52-55)
      const pc = m.material.patternColor;
      data[off + 48] = pc?.r ?? 0; data[off + 49] = pc?.g ?? 0; data[off + 50] = pc?.b ?? 0; data[off + 51] = 0;
      data[off + 52] = m.material.patternFreq ?? 8;
      data[off + 53] = m.material.patternAngle ?? 0;
      data[off + 54] = m.material.patternScale ?? 0.5;
      data[off + 55] = m.material.patternSpacing ?? 0;
    }

    // Write only the used portion (data may be a larger reused scratch buffer).
    this.device.queue.writeBuffer(this._skinnedInstBuf!, 0, data, 0, needFloats);
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

  /** Ensure the SHARED per-skeleton skin-matrix GPU buffer is sized correctly and upload current
   *  matrices (at most once per skeleton per drawSkinnedMeshes call), and register this mesh's
   *  refcount on it (released in evictMeshCaches). */
  private _ensureSkinMatBuf(mesh: SkinnedMesh3D): void {
    const skel = mesh.skeleton!;
    const jointCount = skel.data.joints.length;
    const byteSize   = jointCount * 64; // 16 floats × 4 bytes per mat4

    // Refcount registration: meshId → skeletonId. Handles a mesh re-bound to a different skeleton
    // (release the old entry; last user out destroys it).
    const prevSkel = this._meshSkelRef.get(mesh.id);
    if (prevSkel !== skel.id) {
      if (prevSkel !== undefined) this._releaseSkelBuf(prevSkel);
      this._meshSkelRef.set(mesh.id, skel.id);
      this._skelBufRefs.set(skel.id, (this._skelBufRefs.get(skel.id) ?? 0) + 1);
    }

    let entry = this._skinMatBufs.get(skel.id);
    let isNew = false;
    if (!entry || entry.jointCount !== jointCount) {
      entry?.buf.destroy();
      const skinBuf = this.device.createBuffer({
        size:  Math.max(byteSize, 64),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      entry = { buf: skinBuf, jointCount };
      this._skinMatBufs.set(skel.id, entry);

      // (Re)create the bind group referencing the shared buffer.
      const bg = this.device.createBindGroup({
        layout: this.pipeline.skinBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: skinBuf } }],
      });
      this._skinBGs.set(skel.id, bg);
      isNew = true;
    }

    // Upload when the skeleton changed OR the buffer was just (re)created — but only ONCE per
    // skeleton per draw call (_skinBufUploaded, cleared at the top of drawSkinnedMeshes), since
    // every mesh sharing the skeleton now reads the same buffer. The shared `matricesDirty` flag
    // must still NOT be cleared here: historically, clearing it inside this method starved the
    // 2nd+ mesh sharing a skeleton (e.g. a face decal on a body) of its upload — with the shared
    // buffer the per-call uploaded-set plays that dedupe role, and the flag is cleared once, after
    // all skinned meshes draw, in drawSkinnedMeshes().
    if (isNew || (skel.matricesDirty && !this._skinBufUploaded.has(skel.id))) {
      this.device.queue.writeBuffer(entry.buf, 0, skel.skinMatrices);
      this._skinBufUploaded.add(skel.id);
    }
  }

  /** Drop one mesh's ref on a skeleton's shared skin buffer; destroy buffer + bind group when the
   *  last user is gone. */
  private _releaseSkelBuf(skelId: string): void {
    const n = (this._skelBufRefs.get(skelId) ?? 1) - 1;
    if (n > 0) { this._skelBufRefs.set(skelId, n); return; }
    this._skelBufRefs.delete(skelId);
    this._skinMatBufs.get(skelId)?.buf.destroy();
    this._skinMatBufs.delete(skelId);
    this._skinBGs.delete(skelId);   // GPUBindGroup has no destroy() — GC'd when unreferenced
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
    this._loFiPass?.destroy();
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
    this._skinnedVCBufs.forEach(b => b.destroy());
    this._skinnedInstBuf?.destroy();
  }
}
