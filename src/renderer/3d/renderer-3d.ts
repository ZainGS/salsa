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

import { planSpanCompaction, planPoolShrink } from './geom-compaction';
import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle, type PipelinePriority } from '../core/gpu-pipeline-cache';
import { gpuCrumb, gpuCrumbBegin, gpuCrumbEnd } from '../core/gpu-diagnostics';
import { packDualQuatSkin } from './dual-quat-skin';
import { mat4, vec3 } from 'gl-matrix';
import { reflectionMatrix, clipPlaneFor, reflectorPlane, planeTimesMat, obliqueProjectionZO } from './planar-reflection';
import { transformPoint4 } from './ssr-trace';
import { encodeMeshFlags2, FLAGS2_FLOAT as FLAGS2_FLOAT_OFFSET, FLAGS2_DISTANCE_FADE, FLAGS2_HAIR_BAND } from './material-3d';
import { computeFogEye, defaultFogHorizon, fogHorizonActive, fogHorizonEdge, fogHorizonFlags, sanitizeFogHorizon, type FogHorizonSettings } from './fog-horizon';
import { Camera3D } from './camera-3d';
import { Pipeline3D, MESH3D_VERTEX_STRIDE, SKINNED_MESH3D_VERTEX_STRIDE } from './pipeline-3d';
import { variantKeyOfFlags, variantKeyOfMaterial, ShaderVariantIds, VB_TEXTURED, VB_NOCULL, VB_PATTERNED, VB_SHADOW } from './shader-variants';
import { shaderSplitActive, setShaderSplitMode, SHADER_SPLIT, MeshFsPipelines, setShaderSplitExcluded, shaderSplitExcluded, type MeshFsAxis, type MeshFsSplitStats, type ShaderSplitMode } from './mesh-fs-pipelines';
import { meshFsKeyNum, meshFsNumPlainSafe, MESH_FS_G_SHADOW, MESH_FS_G_DEBUG, MESH_FS_G_SSR_INLINE, type MeshFsBisect, type MeshFsFamily } from './shaders/mesh-fs-key';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { Material3D, encodeMaterialFlags, packRGB8, resolveSceneWind, DEFAULT_SCENE_WIND, type SceneWind3D, resolveSkinRamp, DEFAULT_SKIN_RAMP, type SkinRampSettings, resolveToonShadows, DEFAULT_TOON_SHADOWS, type ToonShadowSettings, resolveRimLight, DEFAULT_RIM_LIGHT, type RimLightSettings } from './material-3d';
import { MAX_POINT_LIGHTS, packSceneUniforms, selectNearestPointLights, computeLightSpaceMatrix as computeLSM, cascadeLightBox, cascadeMatrixFromBox, cascadeCentre, type PointLight3D, type CascadePack, type CascadeLightBox } from './scene-uniforms';
import { ShadowRunTester, CasterSig, StaticLayerMembers, copyCascadeBox, cascadeBoxHolds, cascadeDepthMargin, cascadeRefresh, newCascadeCacheState, stepSunDirection, type CascadeCacheState } from './shadow-cache';
import { DEFAULT_SHADOW_CASCADES, sanitizeShadowCascades, cascadeHalfExtents, cascadeBias, type ShadowCascadeSettings } from './shadow-cascades';
import { ShadowMinMax } from './shadow-minmax';
import { RD, renderDebugShadeMode, renderDebugShaderBits, rdColorLoad, rdDepthLoad, rdForceShaderVariants } from './render-debug';
import { shadowLodScreenThreshold, shadowLodThreshold, shadowTexel } from './shadow-lod';
import { Mesh3D, Submesh3D } from '../../scene-graph/shapes/mesh-3d';
import { ArrayGroup3D, computeArrayOffsets, getArrayInstanceCount, resolveArraySpacing, hashRand, LocalBasis3 } from '../../scene-graph/shapes/array-group-3d';
import { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';
import { GizmoRenderer, GizmoMode, GizmoAxis, ArrayGizmoData, ArrayHandleHit, FaceHandleData, IKHandleHit, type SnapViz3D } from './gizmo-renderer';
import { GhostPreviewRenderer, GhostPreviewData } from './ghost-preview-renderer';
import { MeshEditOverlayRenderer, type MeshEditDrawData } from './mesh-edit-overlay-renderer';
import { WeightPaintVertexOverlayRenderer } from './weight-paint-overlay-renderer';
import { FrustumCuller, shadowReachesView, shadowReachesViewBox } from './frustum-culler';
import { computeJointBindPositions, computeJointSpheres, computeSkinnedCullRadii, skinnedAABBFromSpheres, type SkinnedCullRadii } from './skinned-cull';
import { aabbDistanceSq, distanceLodHidden, fovDistanceScale, orthoLodDistance, twinDraws, DISTANCE_LOD_SHOW } from './distance-lod';
import { buildCullClusters, clusterVerdict, HC_PASS, HC_NOREACH, type ClusterTests } from './cull-clusters';
import { OcclusionCuller, OccluderCache, DEFAULT_OCCLUDER_NAMES } from './occlusion-culler';
import { buildCullRanges, selectRanges, type CullRanges, type BoxTester } from './cull-ranges';
import { SlotRangeAllocator } from './instance-slot-allocator';
import { STREAM_HITCH, STREAM_HITCH_LIMITS, streamHitchStats } from './stream-hitch';
import { P20_RENDER } from './lighter-tiles';
import { TILE_LANDING, P22_RENDER } from './tile-landing';
import { poolViewOf, dropPoolView, strideOf, indexSizeOf, packedTwin, constTangentBuffer, twinsPending, setTwinReadyCallback, alignVtx, packVertices, type PoolView } from './vertex-pack';
import { GpuDrivenMain, type GdHost, type GdStats, type GdVerifyResult } from './gpu-scene';
import { GpuCullAuto, GPU_CULL_REASON_TEXT, loadGpuCullingMode, saveGpuCullingMode, sanitizeGpuCullingMode, type GpuCullingMode, type GpuCullPath, type GpuCullReason, type GpuCullAutoState } from './gpu-cull-auto';
import type { GdShadowParams } from './gpu-driven';
import { GD_CODE_TEXTURED, GD_CODE_NOCULL, GD_CODE_PATTERNED, GD_CODE_ATLAS, GD_CODE_VB_OVERRIDE, GD_CODE_PACKED, GD_CODE_VARIANT_MASK, gdBoundReach, setGdBoundReach, type GdFrameParams, type GdBucketRefs } from './gpu-driven';
import { OutlinePass, type OutlineExtras } from './outline-pass';
import { MeshHighlightPass, HighlightStyle, HighlightMeshEntry, outlineLayers, outlineAnimates } from './mesh-highlight-pass';
import { SpriteOutlinePass, type SpriteOutlineDraw } from './sprite-outline-pass';
import { PostBgKeepPass } from './post-bg-keep-pass';
import { groundUvWorldScale, GROUND_UV_SCALE_MARKER } from './ground-uv-scale';
import { SpriteSDFCache, spriteOutlineMode } from './sprite-outline';
import { SilhouetteOutlinePass } from './silhouette-outline-pass';
import { smoothNormalsForOutline } from './outline-geometry';
export type { HighlightStyle } from './mesh-highlight-pass';
import { BloomPass, createBloomCapturePipeline } from './bloom-pass';
import { PostProcessPass, PostProcessConfig, defaultPostProcessConfig } from './post-process-pass';
import { FxaaPass, DEFAULT_ANTI_ALIASING, sanitizeAntiAliasing, type AntiAliasingSettings } from './fxaa-pass';
export type { PostProcessConfig, FilmConfig } from './post-process-pass';
export { DEFAULT_POST_PROCESS_CONFIG } from './post-process-pass';
import { SSAOPass, SSAOConfig, DEFAULT_SSAO_CONFIG } from './ssao-pass';
export type { SSAOConfig } from './ssao-pass';
import { LoFiPass } from './lofi-pass';
import { TemporalAAPass, DEFAULT_TEMPORAL_AA, temporalRenderScale, temporalSamples, temporalJitter, temporalDitherShift, jitterToNdc, unjitterViewProj, invert4, isCameraCut, type TemporalAASettings, type TemporalAAReason, type TaaRigidDraw, type TaaSkinnedDraw } from './temporal-aa';
import { bakePrefilteredCube, bakeBRDFLUTBytes, cubeMipCount } from './ibl-specular-bake';
import { type ProceduralSkyParams, bakeSkyEquirect } from './procedural-sky';
import { IBLGpuBaker } from './ibl-gpu-bake';
import { ArmatureBgPass } from './armature-bg-pass';
import { skyDomeView, type SkyDomeView } from './sky-dome';
import { IncrementalDrawRank } from './draw-order-rank';
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
type RendererDrawEntry = { mesh: Mesh3D; idx: number; submesh?: Submesh3D; count?: number; ord?: number; range?: IndexRange;
  /** P14 LAZY ranges: the mesh's run table, expanded into index sub-ranges only when the far map (frg) / a cached
   *  static cascade layer (crg) actually renders (_expandRanges), not on every frame's list build. */
  frg?: CullRanges; crg?: CullRanges;
  /** P15: the ArrayGroup3D of an instanced-range entry (the GPU scene's object for it); unset for a mesh entry. */
  gdObj?: object };
/** P11 cull ranges: an index sub-range of a single-material mesh (offsets into its own index list). */
type IndexRange = { indexOffset: number; indexCount: number };
/** A batched pass draw (E2 runs); `range` = draw only that index sub-range (P11). */
type PassRun = { mesh: Mesh3D; idx: number; count: number; range?: IndexRange };   // count>1 = one instanced-range entry (opaque array groups) instead of N per-instance entries; ord = cached draw rank

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

  /** WHICH meshes the colour depth + dither apply to: 'all' (default — every mesh, the original behaviour) or
   *  'optIn' (only meshes whose material has `retroColor` — e.g. characters banded, the environment full colour).
   *  Sent to the shaders as a NEGATIVE colorDepth (so any path that doesn't know the scope simply skips it). */
  colorScope?: 'all' | 'optIn';
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
  colorScope: 'all',
};

/** A runtime particle source drawn by Renderer3D.drawTransientParticles (not a scene-graph node): `activeCount`
 *  instances packed in `gpuData` in the particle shader's ParticleInstance layout (12 floats each). */
export interface TransientParticleSource { readonly activeCount: number; readonly gpuData: Float32Array | null; }

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
// 72 base floats + lightCounts vec4 + 16 POINT LIGHTS × 2 vec4s (posRadius, colorIntensity) = 204 floats,
// + skinRampParams vec4 (floats 204-207, the scene-global skin toon-ramp look)
// + styleParams vec4 (floats 208-211: .x Sketch paper, .y toon shadow tint, .z toon saturation)
// + toonParams vec4 (212-215) + rimParams vec4 (216-219) = 220 floats.
/** The edge-outline "threshold" is really the LINE WIDTH in whole pixels (the Sobel pass reads it as a tap radius,
 *  i32). Values under 1 truncated to 0 → no outline at all (the City panel / Phantom Night sent 0.12–0.18 and drew
 *  nothing). Clamp to 1..8 px. */
export function outlineWidthPx(t: number): number { return Math.max(1, Math.min(8, Math.round(Number.isFinite(t) ? t : 1))); }

const SCENE_UNIFORM_SIZE_PADDED = 1088;  // 272 floats (+ heightFog, city-quality P9; + shadow cascades A2; + aerial haze A5; + fog eye, fog horizon)
// MAX_POINT_LIGHTS + PointLight3D + the uniform-packing math moved to scene-uniforms.ts (C1 Part 2).

/** Size of one MeshInstance in the storage buffer (must match the WGSL struct stride in ALL declarations). */
// modelMatrix(64) + normalMatrix(64) + diffuse(16) + specular(16) + emissive(16)
// + textureIndex(4) + normalMapIndex(4) + roughness(4) + metalness(4) = 192
// + patternColor(16) + patternParams(16) = 224
// + uvTransform(16) = 240 bytes
const MESH_INSTANCE_STRIDE = 240;   // 60 floats; patternColor @48-51, patternParams @52-55, uvTransform (tileXY,offXY) @56-59

// First-alloc floor for the instance storage buffer. Growth is expensive (new GPUBuffer + bind-group + full repack),
// and a big-city / streamed-region warm-up climbs from a handful of slots into the thousands — starting at 16 forced
// ~11 doubling-repacks to reach 4k. Seeding a few thousand slots (~896 KB at 224 B/slot) makes a city load in one
// alloc. Growth logic below is unchanged; this only raises the STARTING size.
const INITIAL_INSTANCE_CAPACITY = 4096;

/** A geometry-pool allocation: where a unique geometry lives (draw params) + its byte spans (for the free-list). */
/** A pooled geometry's placement. `pk` (P22 packedVertices): stored packed — 32-byte vertices, 16-bit indices
 *  (vertex-pack.ts); baseVertex / firstIndex are then in those units. vtxBytes / idxBytes are the (padded) spans. */
type GeomAlloc = { baseVertex: number; firstIndex: number; indexCount: number; vtxBytes: number; idxBytes: number; pk?: boolean };
/** A geometry being written in slices (step 3): its reserved region, the bytes it stores (P22 pool view) and how much is in. */
type GeomPartial = { g: import('./mesh-generators').MeshGeometry; v: PoolView; vtxOff: number; idxOff: number; vtxBytes: number; idxBytes: number; vDone: number; iDone: number; lastFrame: number };


/** getMeshWorldAABB3D cache entry: local (geometry) box + world box at `matVersion`. P6: also held on the mesh. */
type MeshAABBEntry = {
  lMinX: number; lMinY: number; lMinZ: number;
  lMaxX: number; lMaxY: number; lMaxZ: number;
  wMinX: number; wMinY: number; wMinZ: number;
  wMaxX: number; wMaxY: number; wMaxZ: number;
  matVersion: number;
  owner: object; dead: boolean; ref: object;
};

/** Per-frame render profile (Renderer3D.getFrameStats3D / salsaWorld.frameStats()). See the field notes at `_frame`. */
export interface FrameStats3D {
  drawCalls: number; meshes: number; arrayGroups: number; instances: number;
  msTotal: number; msUpload: number; msShadow: number;
  /** Meshes / explicit array groups / array instances rejected by the CAMERA frustum this frame. */
  meshesCulled: number; groupsCulled: number; instancesCulled: number;
  /** Triangles: in the scene / surviving the camera cull (main pass) / actually submitted across ALL passes. */
  trisTotal: number; trisVisible: number; trisDrawn: number;
  /** Shadow pass: casters kept / culled by the LIGHT box / dropped because their shadow cannot reach the VIEW, plus
   *  the pass's draw calls + triangles (0 on a throttled frame — the map is refreshed every Nth frame). */
  shadowCasters: number; shadowCulled: number; shadowOffView: number; shadowDrawCalls: number; shadowTris: number;
  /** CPU ms spent building the culled draw lists (camera + light frustum tests). */
  msCull: number;
  /** R6.1 skinned parts: visible (effectively visible, with a skeleton) / drawn in the main pass / culled by the
   *  camera / kept as shadow casters / skeletons whose skin buffer uploaded / skeletons whose idle is paused
   *  (out of view) / main-pass skinned triangles / CPU ms of the whole drawSkinnedMeshes call. */
  skinnedMeshes: number; skinnedDrawn: number; skinnedCulled: number; skinnedShadow: number; skinUploads: number;
  /** Skinned parts dropped by the fog horizon (past the fog edge; also counted in skinnedCulled). */
  skinnedFogHidden: number;
  /** Live skinned parts whose main-pass draw was SKIPPED this frame (pipeline still compiling, or buffers not ready).
   *  >0 = some of a character is missing on screen; not counted in skinnedDrawn (§P15 draw-bug 2026-10-04). */
  skinnedWaiting: number;
  skelAnimCulled: number; skinnedTris: number; msSkinned: number;
  /** R6.1 DISTANCE LOD: meshes + array groups beyond their `drawDistance` from the camera this frame (not drawn in
   *  any pass), and the triangles that saves in the main pass. */
  lodHidden: number; lodTrisHidden: number;
  /** FOG HORIZON (fog-horizon.ts): meshes + array groups culled because they lie wholly past the fog edge and their
   *  family is not part of the silhouette (Buildings only in fog), and the triangles that saves in the main pass. */
  fogHidden: number; fogTrisHidden: number;
  /** persona-polish A2: near-cascade shadow casters (all cascades) / draw calls this frame (0 on a skipped frame) /
   *  cascade renders since start (a counter) / live cascade count. */
  cascadeCasters: number; cascadeDrawCalls: number; cascadePasses: number; cascades: number;
  /** P8 shadow LOD: casters left out of the far map / of the near cascades (summed) because the map's texel is too
   *  coarse for their `shadowFeatureSize`. */
  shadowLodFar: number; shadowLodCascade: number;
  /** P11 PER-PASS submission (draw calls + triangles actually submitted, instanced copies counted) for the static
   *  (non-skinned) meshes. They sum to drawCalls / trisDrawn except the skinned shadow casters (counted here only).
   *  main = the colour pass (opaque + transparent), farShadow = the far shadow map (static + dynamic layers),
   *  cascade = the near cascades, outline = the outline depth-normal prepass, prepass = the SSAO / SSR G-buffer +
   *  depth-peel prepasses, planar = the planar-mirror re-render, other = overlays. 0 for a pass that did not run
   *  this frame (the shadow maps are throttled / cached). Skinned characters' MAIN draws are `skinnedTris`. */
  passMainDraws: number; passMainTris: number; passFarShadowDraws: number; passFarShadowTris: number;
  passCascadeDraws: number; passCascadeTris: number; passOutlineDraws: number; passOutlineTris: number;
  passPrepassDraws: number; passPrepassTris: number; passPlanarDraws: number; passPlanarTris: number;
  passOtherDraws: number; passOtherTris: number;
  /** P11: the far map's / the cascades' submission the LAST frame each one actually rendered (they are throttled
   *  and cached, so the per-frame pass* values above are 0 on most frames). */
  passFarShadowLastDraws: number; passFarShadowLastTris: number; passCascadeLastDraws: number; passCascadeLastTris: number;
  /** P11 OCCLUSION CULL (Renderer3D.occlusionCulling): meshes + groups in the view but wholly behind the building walls
   *  (not drawn in the camera passes), the triangles that saves, and the CPU ms of the occluder raster + tests. */
  occlCulled: number; occlTrisCulled: number; msOccl: number;
  /** P11 CULL RANGES (Renderer3D.rangeCulling): triangles of meshes in the view dropped because their index run lies
   *  outside the frustum (main pass) / outside a near cascade's box (summed over cascades), and the runs' box builds
   *  this frame. */
  rangeTrisCulled: number; rangeTrisCulledCascade: number; rangeBuilds: number;
  /** P14 (performance-plan.md): far shadow map triangles dropped by the sub-mesh ranges this frame (the reach-culled
   *  direct list + the light-box-culled static list, summed); near-cascade counters since start: static-layer
   *  re-renders, dynamic-layer composites, box re-centres (the slack hold let go). */
  rangeTrisCulledShadow: number; cascadeStaticRenders: number; cascadeDynPasses: number; cascadeRecentres: number;
  /** P15 GPU-DRIVEN main pass (Renderer3D.gpuDriven, gpu-scene.ts): 0 = off (the CPU path), 1 = the GPU culls and
   *  draws the main pass while the CPU still builds its full lists (a prepass / overlay / verification reads them),
   *  2 = lean (the CPU skips the camera-pass tail of GPU-culled records). gpuMainDraws / gpuMainTris = the GPU's main
   *  pass draws / triangles of the last READ-BACK frame (GPU-reported, `gpuStatsAge` frames old; also counted into
   *  drawCalls / trisDrawn / passMain*, and in lean mode the GPU's frustum counts into meshesCulled / groupsCulled /
   *  instancesCulled / trisVisible). gpuRecords = live records; msGpuSync = CPU ms of the record sync + uploads. */
  gpuDriven: number; gpuMainDraws: number; gpuMainTris: number; gpuStatsAge: number; gpuRecords: number; msGpuSync: number;
  /** P15: batched-segment entries the CPU drew after the bundle this frame (meshes not placed in it yet). */
  gpuOrphanDraws: number;
}

/** P11: which pass _drawMesh is recording into (per-pass triangle / draw counters). */
const enum PassBucket { Main = 0, FarShadow = 1, Cascade = 2, Outline = 3, Prepass = 4, Planar = 5, Other = 6 }

export class Renderer3D {
  private device: GPUDevice;
  private pipeline: Pipeline3D;
  private camera: Camera3D;

  // Scene config
  // NEUTRAL grey ambient — was blue-biased [0.15,0.15,0.2] ("cool sky" convention), which tinted
  // white/neutral surfaces lavender (surprising in a colour-faithful creative tool). Now equal RGB so
  // what you paint is what you see. Lighting persists per-document, so this only affects NEW scenes.
  private _ambientColor: [number, number, number] = [0.17, 0.17, 0.17];
  private _ambientIntensity = 1.0;
  private _light: Light3DConfig = {
    direction: [0.3, -0.8, -0.5],
    color: [1, 1, 1],
    intensity: 1.0,
  };
  /** P14 (performance-plan.md): the direction the shadow MAPS use. It follows the sun in steps of
   *  SUN_SHADOW_STEP_DEG (a running day cycle re-renders them at a bounded rate); the lighting keeps `_light`. */
  private readonly _shadowDir: [number, number, number] = [0.3, -0.8, -0.5];
  private _ps1: PS1Config = { ...DEFAULT_PS1_CONFIG };
  private _fog: FogConfig = { ...DEFAULT_FOG_CONFIG };
  // Enhanced-visuals toggles (togglable for perf; default OFF = the current look). Written into free uniform slots.
  private _glassQuality = 0;   // stylized fresnel-glass on glass surfaces (ps1Config2.w)
  private _glassRefraction = 0; // screen-space refraction on glassEnhance surfaces (resolution.w) — OFF by default so
                               // the city (whose glazing also sets glassEnhance) is unaffected; the CD kit turns it on
  private _aerialFog = 0;      // aerial-perspective desaturation strength 0..1 (fogColor.w)
  private _softLightStrength = 0.6;   // global wrapped/half-Lambert amount (lightColor.w) for softLighting materials
  private _skinRamp: SkinRampSettings = { ...DEFAULT_SKIN_RAMP };
  /** Sketch style PAPER amount (styleParams.x): 1 = paper + colour wash … 0 = full colour + hatching. 0.75 = original. */
  private _sketchPaper = 0.75;
  /** Scene toon-shadow look (toonShadow materials in Cel) + parameterised rim light (rimEnabled materials). */
  private _toon: ToonShadowSettings = { ...DEFAULT_TOON_SHADOWS, shadowTint: [...DEFAULT_TOON_SHADOWS.shadowTint] as [number, number, number] };
  private _rim: RimLightSettings = { ...DEFAULT_RIM_LIGHT, color: [...DEFAULT_RIM_LIGHT.color] as [number, number, number] };   // scene-global skin toon-ramp look (skinRampParams, floats 204-207)
  // Scene WIND (foliage-quality S1) — drives every `windSway` material's vertex sway, colour AND shadow
  // pass. Lives in the FREE lightCounts.yzw uniform slots (no buffer resize). Defaults to a gentle breeze.
  private _wind: SceneWind3D = { ...DEFAULT_SCENE_WIND };

  // GPU buffers
  private sceneUniformBuffer: GPUBuffer;
  private instanceStorageBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private meshBindGroup: GPUBindGroup | null = null;
  // Parallel to meshBindGroup but with a DUMMY at binding 10 (SSR world-pos), for the prepass that WRITES that buffer.
  private _prepassMeshBG: GPUBindGroup | null = null;
  // For the depth-PEEL prepass: REAL front layer at binding 10 (it reads it), DUMMY at 11 (it writes that buffer).
  private _peelMeshBG: GPUBindGroup | null = null;
  // For the deferred-SSR RESOLVE pass: real 10/11/12, dummy at 13 (it writes the reflection texture).
  private _resolveMeshBG: GPUBindGroup | null = null;
  // For the reflection FEATHER pass: binding 13 = the PING texture (heal wrote A→B; feather reads B, writes A).
  private _reflectionPingBG: GPUBindGroup | null = null;
  // P4b.2: skinned (character) meshes render into the mirror in their own sub-pass — group-0 variant with the
  // mirrored-camera uniforms at binding 1.
  private _planarSkinnedBG: GPUBindGroup | null = null;
  private _planarSkinnedBGBuf: GPUBuffer | null = null;
  // P4b PLANAR mirror: offscreen mirrored render (full-res, swap format) + its own scene-uniform buffer
  // (mirrored + oblique camera) + a group-0 bind group pointing at it. One reflector per scene (v1).
  private _planarMeshBG: GPUBindGroup | null = null;
  private _planarTex: GPUTexture | null = null;
  private _planarDepthTex: GPUTexture | null = null;
  private _planarTexW = 0;
  private _planarTexH = 0;
  private _planarSceneBuf: GPUBuffer | null = null;
  private _planarScratch = new Float32Array(SCENE_UNIFORM_SIZE_PADDED / 4);
  private _planarActive = false;
  private _meshBindGroupPlanarTex: GPUTexture | null = null;
  // Always-on-top overlay meshes (the landmark info card) captured during drawMeshes, drawn AFTER post-processing
  // by drawPostOverlays() so they bypass the post chain. Instance slot idx stays valid for the rest of the frame.
  private _postOverlayEntries: { mesh: Mesh3D; idx: number }[] = [];
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
  /** SHADOW casters — the opaqueForPasses rules, but culled against the LIGHT's ortho box + the shadow-REACH test
   *  (box swept along the sun must touch the camera frustum) instead of the camera box (polish-round-3 Round 5). A
   *  caster just off-screen still throws its shadow INTO the view: the old camera-culled list dropped it (shadows
   *  missing at the screen edges — and with the city chunked per cell that would have become visible popping). */
  private readonly _shadowList: RendererDrawEntry[] = [];
  private readonly _shadowSeen = new Set<string>();
  private readonly _lightCuller = new FrustumCuller();
  /** Cull the shadow list against the light box (true) or reuse the camera-culled pass list (false = the pre-Round-5
   *  behaviour, kept as an A/B toggle: `renderer3D.shadowLightCulling = false`). */
  private _shadowLightCull = true;
  /** Lowest AABB minY seen last frame — the shadow-reach floor (nothing below it can receive a shadow). */
  private _sceneFloorY = NaN;
  private readonly _lightDirN: [number, number, number] = [0, -1, 0];
  get shadowLightCulling(): boolean { return this._shadowLightCull; }
  set shadowLightCulling(v: boolean) { this._shadowLightCull = v; }
  private readonly _opaqueVC: RendererDrawEntry[] = [];
  private readonly _opaqueSimple: RendererDrawEntry[] = [];
  // Cached (pipelineKey, geometryKey) draw rank per mesh — rebuilt only on structural change (see the sort site).
  // Step 2 (performance-plan §P13): kept incrementally — a structure change sorts + merges only the new meshes, by
  // numeric geometry-key codes (draw-order-rank.ts); the ranks equal the old full stable string sort's exactly.
  private readonly _drawOrder = new IncrementalDrawRank<Mesh3D>();
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
    else { e.mesh = mesh; e.idx = idx; e.submesh = submesh; e.count = count; e.range = undefined; e.frg = undefined; e.crg = undefined; e.gdObj = undefined; }
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
  // ── CASCADED SHADOWS (persona-polish A2; see shadow-cascades.ts) ── the original map stays the FAR cascade.
  private _csm: ShadowCascadeSettings = { ...DEFAULT_SHADOW_CASCADES };
  private _cascadeTex: GPUTexture | null = null;            // depth32float array (one layer per near cascade) or a 1x1 dummy
  private _cascadeArrayView: GPUTextureView | null = null;  // P6: stable 2d-array view (bind group + min/max build)
  /** P6 (performance-plan.md): min/max depth tiles of the far map + cascades → the exact PCF shortcut. */
  private _shadowMM: ShadowMinMax | null = null;
  /** P6 A/B switch: false = every shadow-receiving fragment runs the full PCF (the pre-P6 path). */
  static shadowMinMax = true;
  private _cascadeTexKey = '';
  private _cascadeLayerViews: GPUTextureView[] = [];
  private _cascadeCount = 0;                                // near cascades live THIS frame (0 = off)
  private readonly _cascadePack: CascadePack = { count: 0, matrices: new Float32Array(32), mapSize: 2048, band: 0.15, bias: [0, 0] };
  private readonly _cascadePrev = new Float32Array(32);     // last RENDERED matrices (a change = re-render)
  private readonly _cascadeCentreScratch: [number, number, number] = [0, 0, 0];
  private readonly _cascadeCullers = [new FrustumCuller(), new FrustumCuller()];
  /** P8: each near cascade's world-space texel (set by _updateCascades) and the per-frame shadow-LOD thresholds. */
  private readonly _cascadeTexel = [0, 0];
  private readonly _cascadeLodTex = [0, 0];
  private _viewH = 0;
  private readonly _cascadeLists: RendererDrawEntry[][] = [[], []];
  private _cascadeRunsCache: ({ mesh: Mesh3D; idx: number; count: number }[] | null)[] = [null, null];
  private _cascadeSceneBufs: GPUBuffer[] = [];
  private _cascadeMeshBGs: GPUBindGroup[] = [];
  private _cascadeMeshBGFor: GPUBindGroup | null = null;    // the meshBindGroup the clones were made from
  private _cascadeSkinBGs: GPUBindGroup[] = [];
  private _cascadeSkinBGFor: GPUBindGroup | null = null;
  private _cascadeStale = true;
  private _cascadeFramesSince = 999;
  private _sceneTopY = NaN;                                 // highest caster top (last frame) - how far a cascade reaches sunward
  private _meshBGEntries: GPUBindGroupEntry[] | null = null;       // meshBindGroup's entries (cloned for the cascade passes)
  private _skinnedMeshBGEntries: GPUBindGroupEntry[] | null = null;
  private _shadowMapStale = true;                      // structural change → refresh the map now
  // ── P4.2 STATIC FAR-MAP CACHE (docs/specs/performance-plan.md) ──
  // The far map used to re-render EVERY caster every `_shadowUpdateInterval` frames just so movers stayed current.
  // Now casters split into STATIC (rendered into `_shadowStaticTex` only when the static set / light box / sun
  // changes - the set is light-box culled WITHOUT the camera reach test, so a camera-only orbit keeps it valid) and
  // DYNAMIC (recent movers: traffic / walkers / trains, wind-swayed foliage, billboards, skinned characters). A
  // refresh = copy static -> sampled map, then draw only the dynamic casters on top (depthLoadOp load). While the
  // light box itself is moving (pan / zoom / sun sweep) the old direct path runs unchanged (the cache would be
  // invalid every frame anyway). `shadowStaticCache = false` restores the old behaviour exactly (A/B).
  private _shadowCacheOn = true;
  private _shadowStaticTex: GPUTexture | null = null;
  private _shadowStaticView: GPUTextureView | null = null;
  private _shadowStaticValid = false;        // _shadowStaticTex holds the static set at `_shadowStaticSigDrawn`
  private _shadowSampledStatic = false;      // (no-dynamic branch) the sampled map holds exactly the static set
  private _shadowStaticSig = 0;              // this frame's static-caster signature (built in _buildDrawLists)
  private _shadowStaticSigDrawn = NaN;
  private _shadowStaticFramesSince = 999;
  private _shadowLightMoved = false;         // light box centre/size or sun direction changed this frame
  private _shadowQuietFrames = 0;
  private _shadowDynStale = false;           // skinned pose / caster count changed → refresh the dynamic layer now
  private _shadowDynInMap = false;           // the sampled map currently includes dynamic casters
  private _shadowCacheListsBuilt = false;    // this frame's _buildDrawLists produced the static/dynamic lists
  private _shadowCachePath = false;          // last frame took the cached path (routes skinned stale → dynamic only)
  private readonly _shadowStaticList: RendererDrawEntry[] = [];
  private readonly _shadowDynList: RendererDrawEntry[] = [];
  private _shadowStaticRunsCache: { mesh: Mesh3D; idx: number; count: number }[] | null = null;
  private _shadowDynRunsCache: { mesh: Mesh3D; idx: number; count: number }[] | null = null;
  private readonly _casterMotion = new WeakMap<Mesh3D, { v: number; f: number; uid: number }>();
  private _casterUid = 0;
  private _shadowFrameNo = 0;
  private _sigSum = 0;
  private _sigXor = 0;
  private _shadowCacheStats = { staticRenders: 0, dynPasses: 0, directRenders: 0, staticCasters: 0, dynCasters: 0, farTris: 0, staticStale: 0, staticSig: 0, staticCold: 0 };
  private _instanceCount = 0;
  // P5: ONE allocator for every instance slot outside a full repack — single mesh slots AND array-group ranges
  // (instance-slot-allocator.ts). Replaces the old single-slot free list + high-water: a view switch that shows or
  // hides whole array groups now allocates / parks their contiguous ranges instead of forcing the full repack.
  private readonly _slotAlloc = new SlotRangeAllocator();
  /** Active (placed) array groups: groupId → instance count N its range was allocated for. */
  private readonly _arrayGroupSlotCount = new Map<string, number>();
  /** P5 PARKED array groups: hidden since their last pack, their range still holds valid data (owned by the group in
   *  `_slotAlloc`). Re-shown unchanged (same group/source objects, versions and source material stamp) = zero writes. */
  private readonly _parkedGroups = new Map<string, { group: ArrayGroup3D; src: Mesh3D; srcVer: number; offVer: number; mat: Float32Array }>();
  /** setArrayGroups saw a different group SET — the next upload must place / park ranges (incremental path). */
  private _groupSetDirty = false;
  private readonly _gsWant = new Set<string>();
  private readonly _gsPack = new Set<string>();
  private _instanceDataBuf: Float32Array | null = null;
  private _instanceDataView: DataView | null = null;   // P8: cached view over _instanceDataBuf (recreated only on realloc)
  private _whiteLayerScratch: Uint8Array | null = null; // P8: reused all-255 atlas layer-0 buffer (per atlas size)

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
  // geometryKey → the geometry OBJECT whose bytes are resident (P10.B6: a GPU compaction moves resident bytes, so a key
  // shared by two different geometries — a key collision — must be re-uploaded from its first live user, exactly as
  // the CPU full rebuild would, instead of keeping whichever copy was appended first).
  private readonly _geomKeySrc = new Map<string, import('./mesh-generators').MeshGeometry>();
  private _geomFree: Array<{ vtxOff: number; vtxBytes: number; idxOff: number; idxBytes: number }> = [];   // freed regions (paired vtx+idx spans) for reuse
  private _geomVtxTail = 0;   // byte offset where the next vertex append lands
  private _geomIdxTail = 0;   // byte offset where the next index append lands
  private static readonly GEOM_OVERPROVISION = 2.5;   // buffer headroom over live size → appends before a compaction

  // Two-level world AABB cache for getMeshWorldAABB3D.
  // Local AABB (from vertex scan) is stable until geometry changes (gpuDirty).
  // World AABB is stable until the model matrix changes (localMatrixVersion).
  // P6: the entry is also held on the mesh (`Mesh3D._r3Aabb`, validated by owner + liveness) so the per-frame cull
  // skips the map lookup, and a moving mesh's entry is updated in place (it was a fresh object per mover per frame).
  private _meshAABBCache = new Map<string, MeshAABBEntry>();

  // Per-array-group world AABB (over all instance positions + canonical extent) for whole-group frustum culling.
  // Cached per source localMatrixVersion. Only 'explicit' groups get a box (city detail); others return null = never
  // group-culled. City-WIDE groups span everything → box never fails the frustum = no-op (safe with detailGrid=0).
  private _agAABBCache = new Map<string, { ver: number; box: [number, number, number, number, number, number] | null; org: [number, number, number, number, number, number] | null }>();

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
    this._vbOverrideGen++;   // P15: the GPU-driven records re-derive their vertex buffer / base vertex
  }
  private _vbOverrideGen = 0;

  // Shadow mapping
  private _shadowsEnabled = false;
  private _shadowMapSize = 2048;
  private _shadowHalfExtent = 15;   // the BASE box (city/scene sized); the effective box shrinks toward the camera
  private _shadowBias = 0.002;      // the BASE bias (tuned at the base box); the effective bias scales with texel size
  // Zoom-adaptive shadow box (only when _shadowFollowCamera): the effective half-extent shrinks to roughly the
  // visible footprint when zoomed in (→ 2048 texels cover a small area → SHARP shadows) and grows back up to the
  // full base box when zoomed out (→ the whole view still gets shadows). Recomputed each frame in _updateShadowCenter.
  private _effHe = 15;              // effective half-extent used by the light matrix (≤ _shadowHalfExtent)
  private _effBias = 0.002;         // effective bias, scaled to the effective texel size (smaller box → less bias)
  private _shadowTexture: GPUTexture | null = null;
  private _shadowTextureView: GPUTextureView | null = null;
  private _shadowBindGroup: GPUBindGroup | null = null;
  private _shadowDirty = true;

  // Default 1×1 textures used as bind group placeholders
  private _defaultWhiteTex: GPUTexture | null = null;
  private _defaultFlatNormalTex: GPUTexture | null = null;

  // IBL uniform buffer (208 bytes: 9×vec4 SH coefficients + 16 scalars)
  private _iblUniformBuffer: GPUBuffer | null = null;
  // Staging data: floats 0-35 = SH coeffs (9×4); 36 = iblEnabled; 37 = iblIntensity (DIFFUSE); 38 = iblSpecularEnabled;
  // 39 = specularMaxMip; 40 = iblSpecularIntensity; 41 = ssrEnabled; 42 = ssrMaxSteps; 43 = ssrStride;
  // 44 = ssrThickness (fill EDGE-BLUR band); 45 = ssrIntensity; 46 = ssrMaxRoughness; 47 = ssrDebug;
  // 48 = ssrFillBlur (fill INTERNAL blur radius, half-res texels); 49 = ssrEdgeFeather (fill edge ring radius,
  // half-res texels); 50-51 = pad.
  private _iblData = new Float32Array(56);
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
  // E3 (audit P4): incremental-atlas bookkeeping. Layer indices are STABLE for the life of the array
  // texture (meshes carry textureIndex in packed instance records); the texture only reallocates when
  // dimensions change or capacity is exceeded (grown with headroom). `srcByLib` remembers which source
  // GPUTexture each layer was last copied from, so a texture SWAP re-copies its one layer; in-place
  // paint edits are caught via the owning mesh's gpuDirty flag.
  private _atlasSync       = { w: 0, h: 0, capacity: 0, high: 1, srcByLib: new Map<string, GPUTexture>() };
  private _normalAtlasSync = { w: 0, h: 0, capacity: 0, high: 1, srcByLib: new Map<string, GPUTexture>() };
  private _atlasBindGroup:      GPUBindGroup | null = null;
  private _atlasDirty = true;

  // ── GARP atlas (docs/specs/city-props-garp.md §2) ──────────────────────────────────────────
  // A SECOND, DEDICATED texture_2d_array for GARP pool skins — separate from the mesh atlas so that
  // dynamically loaded/unloaded USER pools repack WITHOUT invalidating engine mesh texture indices.
  // A mesh with the GARP_TEX material flag samples THIS array (at its per-instance textureIndex) instead
  // of the diffuse atlas — the select() lives in the fragment shader. ★ It is bound on EVERY textured draw
  // (the shader samples it unconditionally), so it must always be valid: when no pool has loaded it falls
  // back to the 1×1 default-white texture (getDefaultWhiteTex), viewed as a 2d-array. Layer 0 = blank.
  private _garpAtlasTexture: GPUTexture | null = null;

  // ── Particle system ────────────────────────────────────────────────────────
  // Pipeline + buffers are created lazily on first drawParticles() call.
  private _particlePipeline:      PipelineHandle<GPURenderPipeline> | null = null;   // P2: non-blocking cache handle
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
  private _bloomCapturePipeline: PipelineHandle<GPURenderPipeline> | null = null;

  // ── Skinned mesh rendering ─────────────────────────────────────────────────
  // Per-mesh skinned vertex buffer (72-byte stride: standard 48 + joints + weights + pad).
  /** Skinned-part count at the last drawSkinnedMeshes — a change marks the shadow map stale (E1 tail c). */
  private _lastSkinnedCount = 0;
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
  // ── R6.1 SKINNED CULLING (polish-round-3). `_skinnedVisibleScratch` is the LIVE list: every part that is in the
  // camera view OR whose shadow can reach the view (or all visible parts while a planar mirror is live). Only live
  // parts get their instance slot + skin-matrix upload. Per-slot flags (same order as the list / instance slots):
  // bit 1 = draw in the main pass (in view), bit 2 = cast into the shadow map.
  /** Frustum-cull skinned meshes (main pass + shadow reach). false = the old draw-everything path, for A/B tests. */
  skinnedCulling = true;
  /** Skip the procedural idle for characters that are out of view (with a margin) and cast no visible shadow.
   *  The idle is time-based, so it resumes at the right phase. Read by Scene3DAnimation via isSkeletonAnimCulled3D. */
  skinnedAnimCulling = true;
  private _skinnedFlags = new Uint8Array(64);
  private readonly _skCuller = new FrustumCuller();
  /** meshId → bind-space radii + the last world box (cached per pose / model version). */
  private readonly _skCull = new Map<string, { cr: SkinnedCullRadii; skelId: string; verts: unknown; ji: unknown; jw: unknown; bv: number;
    poseVer: number; matVer: number; viaSkel: boolean; ok: boolean; box: Float64Array; flags: number }>();
  /** skeletonId → joint bind positions + this pose's joint spheres (shared by every part on the skeleton). */
  private readonly _skSpheres = new Map<string, { bindPos: Float32Array; poseVer: number; spheres: Float32Array }>();
  /** Skeletons whose every visible part was out of view (with a margin) and cast no visible shadow last frame. */
  private readonly _skelAnimCulled = new Set<string>();
  private readonly _skelLiveScratch = new Set<string>();
  private _lastSkinnedCasters = -1;
  /** R6.1 DISTANCE LOD master switch (Mesh3D.drawDistance). false = draw everything regardless of distance (A/B). */
  distanceLod = true;
  /** Global multiplier on every drawDistance (quality knob: > 1 keeps detail farther). */
  distanceLodScale = 1;
  /** World units ADDED to every drawDistance (before the scale) — the city sets it each frame to the camera's distance
   *  to the city volume, so an aerial overview keeps its detail (the zoom tiers own that case) while at street level
   *  the per-chunk distances apply unchanged. 0 for everything else. Each mesh takes `Mesh3D.drawDistanceBias` (0..1)
   *  of it (P7: sub-metre clutter takes none). */
  distanceLodBias = 0;
  /** P9: take a mesh's local box from its geometry's precomputed `bounds` when it has them (world builds) instead
   *  of scanning the vertices. Needed for the shared near/far twin boxes; false = the old vertex scan (A/B). */
  useGeometryBounds = true;
  /** P9 HIERARCHICAL CULL master switch (cull-clusters.ts): static meshes are grouped into spatial clusters and a
   *  cluster outside the view whose shadow cannot reach it skips its members' per-mesh tests. false = the flat loop. */
  hierarchicalCull = true;
  /** P9 RESOLUTION-AWARE DRAW DISTANCES (performance-plan P7.11): the distance-LOD and twin distances were tuned for
   *  a ~900 px tall view; with this on they scale by (view height / LOD_REF_HEIGHT), clamped to LOD_RES_MIN..MAX, so a
   *  small canvas drops detail sooner (and, with LOD_RES_MAX > 1, a 4K canvas keeps it farther). The height is the
   *  CANVAS's (lodViewHeight, set by the host renderer each frame — never the dynamic-resolution target, so the auto
   *  resolution scaler cannot make LOD pop). false = the fixed distances (A/B). */
  resolutionLod = true;
  /** The presentation canvas height in device pixels (0 = unknown → no scaling). */
  lodViewHeight = 0;
  static LOD_REF_HEIGHT = 900;
  static LOD_RES_MIN = 0.6;
  /** Default 1: distances only SHRINK on a small canvas. Measured (tiled 3x3, 2500x1390, scale 1.54): letting them
   *  grow added +1.5 M tris in Play and +3.3 M from the sky on a view that is already GPU-bound, so growing is opt-in
   *  (e.g. 2 for a 4K quality setting). */
  static LOD_RES_MAX = 1.0;
  /** The resolution factor the draw distances take this frame (1 when off / unknown). */
  get lodResolutionScale(): number {
    if (!this.resolutionLod || !(this.lodViewHeight > 0)) return 1;
    return Math.min(Renderer3D.LOD_RES_MAX, Math.max(Renderer3D.LOD_RES_MIN, this.lodViewHeight / Renderer3D.LOD_REF_HEIGHT));
  }
  /** P9: the draw-list build reads a mesh's cached world box inline and its pool allocation / instance slot from
   *  per-mesh copies (Mesh3D._r3GA / _r3Slot, generation-checked). false = the getMeshWorldAABB3D call + two Map
   *  lookups per mesh (A/B). */
  drawListFastPaths = true;
  private _hcRebuild = true;
  private _hcMissFrames = 0;
  private _hcSerial = -1;
  /** P9: bumped on every _geomAllocs / _meshInstanceSlots change — validates the per-mesh copies (Mesh3D._r3GA /
   *  _r3Slot) the draw-list build reads instead of two string-keyed Map lookups per mesh. */
  private _r3Gen = 0;
  private _hcFloorY = Infinity;
  private readonly _hcTests: ClusterTests = { inView: null, shadows: false, inLight: null, reaches: null };
  private readonly _hcInView = (b: Float64Array): boolean => this._culler.testAABB(b[0], b[1], b[2], b[3], b[4], b[5]);
  private readonly _hcInLight = (b: Float64Array): boolean => this._lightCuller.testAABB(b[0], b[1], b[2], b[3], b[4], b[5]);
  private readonly _hcReaches = (b: Float64Array): boolean => shadowReachesView(this._culler, this._lightDirN, this._hcFloorY, b[0], b[1], b[2], b[3], b[4], b[5]);
  /** FOG HORIZON: the squared cull distance this frame (Infinity = off) and the box test against the fog eye. */
  private _fhCull2 = Infinity;
  private readonly _outlineInvVP = mat4.create();
  private _fogBoxPast(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    const e = this._fogEye, px = e[0], py = e[1], pz = e[2];
    const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
    const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
    const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
    return dx * dx + dy * dy + dz * dz > this._fhCull2;
  }
  /** P9: (re)build the cull clusters over the current mesh roster (static, single-material, resident meshes). */
  private _buildCullClusters(meshes: Mesh3D[]): void {
    const n = buildCullClusters(this, meshes, (m) => this.getMeshWorldAABB3D(m, this._aabbScratch),
      (m) => {
        if (m.cheapBounds || m.submeshes.length > 0 || m.billboard || m.billboardParent || m.gpuDirty) return false;
        const a = this._geomAllocs.get(m.id);
        if (!a) return false;
        m._hcTris = a.indexCount / 3;
        return true;
      }, (m) => m.localMatrixVersion);
    this._hcStats.clustered = n; this._hcStats.builds++;
    this._hcSerial = meshes.length ? meshes[0]._hcB : -1;
  }
  /** P9 diagnostics: meshes clustered at the last build, builds so far, members skipped last frame. */
  readonly _hcStats = { clustered: 0, builds: 0, skipped: 0, fogSkipped: 0 };

  // ── P15 GPU-DRIVEN MAIN PASS (gpu-scene.ts, gpu-driven.ts, performance-plan.md §P15; engine-roadmap step 4) ──
  /** Master switch (default ON since 2026-10-02): the main pass's batched opaque segment (single-material opaque
   *  meshes + opaque instanced groups) is culled by a compute pass over a persistent GPU record table (frustum,
   *  distance LOD with its hysteresis, fog horizon; Phase B: near / far twins, P11 cull ranges; the depth prepasses
   *  reuse it; Phase C: the shadow casters) and drawn from pre-recorded render bundles of drawIndexedIndirect commands
   *  in the CPU path's draw order. Billboards, always-on-top cards and externally driven twins stay CPU-decided
   *  (FORCED records); multi-material, vertex-coloured and transparent meshes and the skinned characters stay on the
   *  CPU path. Pixel-identical to the CPU path; trades CPU for GPU time (performance-plan.md §P15: every record is an
   *  indirect draw, culled ones included, which costs GPU front-end time on D3D12).
   *  false = the CPU path exactly (nothing of the GPU scene runs). Also off when the device cannot build the scene. */
  static gpuDriven = true;
  /** PER-MACHINE CAPS (gpu-capabilities.ts, mobile-parity CRASH-8): what this device may run, applied by WebGPURenderer
   *  at start-up and on every device recovery. They clamp the switches at render time and never change a document
   *  setting or a stored preference (the getters that feed the save keep returning the authored values). */
  static readonly caps = { gpuDriven: true, shaderVariants: true, shadows: true, ssao: true, ssr: true, taa: true, animatedFocusBg: true, shaderSplitMaxKeys: 96 };
  /** The GPU-driven path is on (the switch AND the device cap). */
  static get gpuDrivenActive(): boolean { return Renderer3D.gpuDriven && Renderer3D.caps.gpuDriven; }
  /** P21 shader variants are on (the switch AND the device cap). */
  static get shaderVariantsActive(): boolean {
    // RENDER DEBUG forceShaderVariants (RENDER-1 test): variants on despite the tier cap.
    return Renderer3D.shaderVariants && (Renderer3D.caps.shaderVariants || rdForceShaderVariants());
  }
  /** LEAN: on a frame where no prepass / overlay reads the CPU's camera lists (outlines, SSAO / SSR, a planar mirror,
   *  hover / per-object outlines, the CPU occlusion cull, a verification), the draw-list loop skips the camera-pass
   *  tail (frustum, ranges, pushes) of GPU-culled records. false = the CPU still builds every list (A/B). */
  static gpuDrivenLean = true;
  /** PHASE B PREPASSES: the outline depth + normal pass, the SSAO / SSR G-buffer pass and the SSR depth peel draw the
   *  GPU-culled records from render bundles over the main pass's argument blocks (the same camera frustum), and the
   *  CPU only the rest (multi-material, vertex-coloured, not-yet-placed meshes). Lean mode then stays on with ink
   *  outlines / SSAO / SSR. false = those passes replay the CPU lists (and lean mode turns off while they run). */
  static gpuDrivenPrepasses = true;
  private _gd: GpuDrivenMain | null = null;
  private _gdOn = false;
  private _gdLean = false;
  private _gdStamp = -1;
  private _gdDrew = false;
  private _gdWasOn = false;
  private _gdAtlasSeen = -1;
  private _gdFdsSeen = false;
  /** Phase B: the merged (all-patterned) pipeline choice is in force (GpuDrivenMain.mergePatterned + its pipelines ready). */
  private _gdMergeOk = false;
  /** SHADER SPLIT: the split state the GPU-driven state codes were derived under (a change re-codes them). */
  private _gdSplitSeen = false;
  /** The GPU scene could not be created on this device (no compute / indirect support): the CPU path, for good. */
  private _gdFailed = false;
  /** CRASH-10 breadcrumbs: this renderer submitted its first GPU-driven cull dispatch. */
  private _gdDispatched = false;
  // GPU CULLING MODE (gpu-cull-auto.ts): 'on' / 'off' / 'auto' (default; a per-machine localStorage preference).
  // In 'auto' the controller picks the path each frame from measured CPU / GPU ms. While it picks the CPU path the GPU
  // scene stays WARM: the loop still stamps and re-checks the records and finish() keeps them, the order and the
  // bundles current (no cull dispatch, no lean skip, no GPU shadows), so switching back costs no rebuild and no frame.
  readonly cullAuto = new GpuCullAuto();
  private static _cullModeStatic: GpuCullingMode | null = null;
  private _cullTimer: 'timestamp' | 'estimate' | 'none' = 'none';
  /** This frame: the GPU scene runs but the CPU path draws (auto mode picked the CPU path). */
  private _gdWarm = false;
  /** The path the last frame drew with (a change re-renders the cached shadow layers). */
  private _gdPathLast: GpuCullPath | null = null;
  private _cullPathNow: GpuCullPath = 'gpu';
  private _cullReasonNow: GpuCullReason = 'measuring';
  /** Records below which auto mode does not bother (no city: the paths cost the same). */
  static CULL_AUTO_MIN_RECORDS = 256;
  // Phase C: the GPU decides the records' shadow casters this frame; its inputs; the static layers' bookkeeping
  private _gdShThis = false;
  private readonly _gdShL = new Float32Array(24);
  private readonly _gdShC = [new Float32Array(24), new Float32Array(24)];
  private readonly _gdS: GdShadowParams = { on: false, light: null, casc: [null, null], cascades: 0, ldir: [0, -1, 0], floorY: Infinity, reach: false,
    lodFar: 0, lodC0: 0, lodC1: 0, cache: false, split: false, wind: false, join: false, band: false, bandAttach: false, bandIn: 0 };
  /** Per static layer (far, cascade 0, cascade 1): an epoch mixed into its signature (bumped when the GPU reports a
   *  leaver, or any change with joiner deferral off), the GPU frame of its last commit, the GPU joiners and since when. */
  private readonly _gdShEpoch = [0, 0, 0];
  private readonly _gdShCommit = [-1, -1, -1];
  private readonly _gdShJoiners = [0, 0, 0];
  private readonly _gdShJoinTris = [0, 0, 0];
  private readonly _gdShJoinSince = [-1, -1, -1];
  private readonly _gdPlanes = new Float32Array(24);
  private readonly _gdCam = new Float64Array(3);
  private readonly _gdF: GdFrameParams = { planes: null, cam: this._gdCam, lodOn: false, lodOrtho: false, orthoD2: 0, lodScale: 1, lodBias: 0,
    fogEye: [0, 0, 0], fogCull2: Infinity, fogCullOther: false, fogCullAttach: false };
  private readonly _gdScratchBox: AABB3 = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  /** The renderer side of the GPU scene (closures over this renderer's private state). */
  private _gdHost(): GdHost {
    const r = this;
    const T = GD_CODE_TEXTURED, NC = GD_CODE_NOCULL, PT = GD_CODE_PATTERNED, AT = GD_CODE_ATLAS, VO = GD_CODE_VB_OVERRIDE;
    return {
      device: this.device,
      colorFormat: this._swapChainFormat,
      depthFormat: 'depth24plus-stencil8',
      mdi: this.device.features.has('chromium-experimental-multi-draw-indirect' as GPUFeatureName),
      gen: () => r._r3Gen,
      refresh: (m) => {
        if (m._r3o !== r || m._r3g !== r._r3Gen) { m._r3o = r; m._r3g = r._r3Gen; m._r3GA = r._geomAllocs.get(m.id); m._r3Slot = r._meshInstanceSlots.get(m.id) ?? -1; }
      },
      box: (m) => r.getMeshWorldAABB3D(m, r._gdScratchBox),
      vbOverride: (id) => r._vertexBufferOverrides.get(id),
      vbGen: () => r._vbOverrideGen,
      stateCode: (m) => {
        const mat = m.material, tex = !!(mat.hasTexture || mat.hasNormalMap);
        let c = (tex ? T : 0) | ((r.forceDoubleSided || !!mat.doubleSided) ? NC : 0) | ((r._gdMergeOk || r._usesPatterns(m)) ? PT : 0);
        if (tex && !!m.textureLibraryId && r._atlasLayerMap.has(m.textureLibraryId)) c |= AT;
        if (r._vertexBufferOverrides.has(m.id)) c |= VO;
        else if (r._geomAllocs.get(m.id)?.pk) c |= GD_CODE_PACKED;   // P22: the packed twin + uint16 indices
        // SHADER SPLIT: a covered mesh carries its split key id (bits 5+, with SPLIT_ID_FLAG) instead of a P21 variant id
        const sid = shaderSplitActive() ? r._splitIdOf(Renderer3D.splitKeyOfMesh(m)) : 0;
        if (sid > 0) return c | ((Renderer3D.SPLIT_ID_FLAG | sid) << 5);
        // step 8: the shader-variant id (bits 5+), from the material (this runs before the frame's slot writes)
        if (Renderer3D.shaderVariantsActive && m.submeshes.length === 0) c |= r._svIds.idOf(variantKeyOfMaterial(mat)) << 5;
        return c;
      },
      texKey: (m, code) => ((code & T) && !(code & AT) ? r.createTextureBindGroup(m) : null),
      rankedMeshes: () => r._drawOrder.orderedMeshes(),
      rankOf: (id) => r._drawOrder.get(id),
      rankChanged: () => r._drawOrder.lastChangedMeshes(),
      groups: () => r._arrayGroups,
      groupGen: () => r._groupSetGen,
      groupFirstSlot: (id) => r._arrayGroupFirstSlot.get(id),
      groupSource: (g) => r._meshById.get(g.sourceId),
      groupCount: (g) => getArrayInstanceCount(g.arrayParams),
      groupBox: (g, src) => r._arrayGroupWorldAABB(g, src),
      groupLodHidden: (g) => r._lodHiddenGroups.has(g.id),
      groupOrigin: (g) => r._agAABBCache.get(g.id)?.org ?? null,
      groupTwinNear: (g) => r._lodTwinNearGroups.has(g.id),
      geomBuffers: () => ({ vb: r._geomVB, ib: r._geomIB }),
      shadowFrame: () => r._shadowFrameNo,
      casterUntil: (m) => r._casterUntil(m),
      rankCell: (m) => m._r3RankCell,
      resolve: (code, lead, out: GdBucketRefs) => {
        // exactly the CPU main pass's choice for a group led by `lead` (_drawMainPass)
        const P = r.pipeline, sh = r._shadowsEnabled, noCull = (code & NC) !== 0, pat = (code & PT) !== 0;
        const vid0 = (code >> 5) & GD_CODE_VARIANT_MASK;
        if (vid0 & Renderer3D.SPLIT_ID_FLAG) {
          // SHADER SPLIT: the bucket's generated pipeline (exact, a compiled superset, or null = held). Never the uber
          // shader: a packed bucket draws with that pipeline's twin or waits for it.
          const sp = r._splitPipe(r._splitNums[vid0 & ~Renderer3D.SPLIT_ID_FLAG], noCull ? 'opaqueNoCull' : 'opaque', sh);
          out.pipeline = !(code & GD_CODE_PACKED) || !sp ? sp
            : packedTwin(r.device, sp) ?? packedTwin(r.device, r._splitFallback(r._splitNums[vid0 & ~Renderer3D.SPLIT_ID_FLAG], noCull ? 'opaqueNoCull' : 'opaque', sh));
          out.bg1 = (code & T) ? (((code & AT) && r._atlasBindGroup) ? r._atlasBindGroup : r.createTextureBindGroup(lead)) : (sh ? r._shadowBindGroup : null);
          out.bg2 = (code & T) && sh ? r._shadowBindGroup : null;
          out.bg0 = r.meshBindGroup;
          out.vb = (code & VO) ? (r._vertexBufferOverrides.get(lead.id) ?? r._geomVB) : r._geomVB;
          out.ib = r._geomIB;
          return;
        }
        if (code & T) {
          out.pipeline = sh
            ? (noCull ? (pat ? P.opaqueTexturedNoCullShadowPipeline : P.opaqueTexturedNoCullPlainShadowPipeline)
                      : (pat ? P.opaqueTexturedShadowPipeline : P.opaqueTexturedPlainShadowPipeline))
            : (noCull ? (pat ? P.opaqueTexturedNoCullPipeline : P.opaqueTexturedNoCullPlainPipeline)
                      : (pat ? P.opaqueTexturedPipeline : P.opaqueTexturedPlainPipeline));
          out.bg1 = ((code & AT) && r._atlasBindGroup) ? r._atlasBindGroup : r.createTextureBindGroup(lead);
          out.bg2 = sh ? r._shadowBindGroup : null;
        } else {
          out.pipeline = sh
            ? (noCull ? (pat ? P.opaqueUntexturedNoCullShadowPipeline : P.opaqueUntexturedNoCullPlainShadowPipeline)
                      : (pat ? P.opaqueUntexturedShadowPipeline : P.opaqueUntexturedPlainShadowPipeline))
            : (noCull ? (pat ? P.opaqueUntexturedNoCullPipeline : P.opaqueUntexturedNoCullPlainPipeline)
                      : (pat ? P.opaqueUntexturedPipeline : P.opaqueUntexturedPlainPipeline));
          out.bg1 = sh ? r._shadowBindGroup : null;
          out.bg2 = null;
        }
        // step 8: the bucket's specialised variant once compiled (a bucket = one variant id = one exact flags value);
        // a pipeline change re-records the bundle (gdBucketsChanged)
        const vid = (code >> 5) & GD_CODE_VARIANT_MASK;
        const base = out.pipeline as GPURenderPipeline | null;
        if (vid > 0) { const vp = r._variantPipe(r._svIds.keyOf(vid), (code & T) !== 0, noCull, pat); if (vp) out.pipeline = vp; }
        // P22: a packed bucket draws with the twin (the variant's, or the base pipeline's while that one compiles)
        if (code & GD_CODE_PACKED) out.pipeline = packedTwin(r.device, out.pipeline as GPURenderPipeline | null) ?? packedTwin(r.device, base);
        out.bg0 = r.meshBindGroup;
        out.vb = (code & VO) ? (r._vertexBufferOverrides.get(lead.id) ?? r._geomVB) : r._geomVB;
        out.ib = r._geomIB;
      },
    };
  }

  /** Does a consumer of this frame need the CPU's camera lists (so lean mode must not skip building them)? */
  private _gdListsNeeded(): boolean {
    const pre = !Renderer3D.gpuDrivenPrepasses;   // Phase B: the prepasses draw the GPU set themselves
    return (pre && ((!!this._outlinePass && this._outlinePass.ready()) || this._ssaoEnabled || this._ssrEnabled)) || this._planarActive
      || Renderer3D.occlusionCulling || this._hoveredMeshIds.size > 0 || this._meshOutlines.size > 0 || this._hoverOutlineRanges !== null
      || (this._shadowsEnabled && (!this._shadowLightCull || this._shadowsSuspended)) || (!!this._gd && this._gd.verifyPending);
  }

  /** Start of drawMeshes: is the GPU main pass on this frame (switch on + cull pipeline compiled)? */
  private _gdBegin(): void {
    this._gdDrew = false; this._frame.gpuOrphanDraws = 0; this._gdWarm = false;
    Renderer3D._cullModeLoaded();   // the stored GPU culling mode ('off' clears gpuDriven once, at start-up)
    if (!Renderer3D.gpuDrivenActive) {
      if (this._gdWasOn && this._gd) this._gd.reset();   // stale records must never survive a switch-off
      this._gdWasOn = false; this._gdOn = false;
      const f = this._frame; f.gpuDriven = 0; f.gpuMainDraws = 0; f.gpuMainTris = 0; f.gpuStatsAge = -1; f.gpuRecords = 0; f.msGpuSync = 0;
      return;
    }
    if (!this._gd) {
      if (this._gdFailed) { this._gdOn = false; this._frame.gpuDriven = 0; return; }
      gpuCrumb('gpu-driven create');
      try { this._gd = new GpuDrivenMain(this._gdHost()); }
      catch (e) { this._gdFailed = true; this._gdOn = false; this._frame.gpuDriven = 0; console.warn('[gpu-driven] unavailable on this device, using the CPU path', e); return; }
    }
    const gd = this._gd;
    if (!this._gdWasOn) { gd.reset(); this._gdWasOn = true; }
    this._gdOn = gd.ready;
    if (!this._gdOn) { this._frame.gpuDriven = 0; this._gdWarm = false; return; }
    this._gdStamp = gd.beginFrame();
    // GPU culling mode: 'auto' asks the controller (the GPU scene keeps running WARM on a CPU-path frame)
    const path = this._gdChoosePath();
    this._gdWarm = path === 'cpu';
    if (this._gdPathLast !== null && path !== this._gdPathLast) { this._shadowMapStale = true; this._cascadeStale = true; }   // the cached static layers re-render from the new path's casters
    this._gdPathLast = path;
    this._gdLean = !this._gdWarm && Renderer3D.gpuDrivenLean && !this._gdListsNeeded();
    // Phase B merged pipelines: only once every FULL (patterned) variant the merged buckets need has compiled (reading
    // the getters requests them); until then the CPU path's per-mesh choice, so no plain mesh waits on a pipeline the
    // CPU path would not use. A flip re-derives the buckets.
    let merge = GpuDrivenMain.mergePatterned;
    if (merge) {
      const P = this.pipeline;
      merge = this._shadowsEnabled
        ? !!(P.opaqueTexturedShadowPipeline && P.opaqueTexturedNoCullShadowPipeline && P.opaqueUntexturedShadowPipeline && P.opaqueUntexturedNoCullShadowPipeline)
        : !!(P.opaqueTexturedPipeline && P.opaqueTexturedNoCullPipeline && P.opaqueUntexturedPipeline && P.opaqueUntexturedNoCullPipeline);
    }
    if (merge !== this._gdMergeOk) { this._gdMergeOk = merge; gd.recode(); }
    // SHADER SPLIT: the state codes carry split key ids, so any switch route (sm, localStorage, render debug) re-codes
    const split = shaderSplitActive();
    if (split !== this._gdSplitSeen) { this._gdSplitSeen = split; gd.recode(); }
  }

  /** After the draw-list loop: sync the records, upload, dispatch the cull (own submit, before the main pass). */
  private _gdFinish(meshes: Mesh3D[]): void {
    const gd = this._gd!;
    const t0 = performance.now();
    this._ensureDrawOrder(meshes);
    if (this._perf.atlasRebuilds !== this._gdAtlasSeen || this.forceDoubleSided !== this._gdFdsSeen) {
      this._gdAtlasSeen = this._perf.atlasRebuilds; this._gdFdsSeen = this.forceDoubleSided; gd.recode();
    }
    if (!gd.finish(meshes, this._gdF, this._drawOrder.stats.updates, this._gdS)) { this._gdOn = false; return; }
    if (this._gdWarm) { this._frame.msGpuSync = performance.now() - t0; return; }   // auto mode on the CPU path: records kept current, nothing dispatched
    gd.selectSegments();   // sub-bundles: which ones may draw this frame
    gd.captureVerifyExpect();
    const first = !this._gdDispatched;
    const tok = first ? gpuCrumbBegin('gpu-driven first dispatch') : 0;
    const enc = this.device.createCommandEncoder({ label: 'GdCullEnc' });
    gd.encode(enc);
    this.device.queue.submit([enc.finish()]);
    gd.afterSubmit();
    if (first) {   // CRASH-10: did the GPU finish the first cull dispatch? (still open at a loss = the suspect)
      this._gdDispatched = true;
      this.device.queue.onSubmittedWorkDone().then(() => gpuCrumbEnd(tok), () => gpuCrumbEnd(tok, false));
    }
    this._frame.msGpuSync = performance.now() - t0;
  }

  /** After a GPU-drawn main pass: the GPU-reported counters (last read-back frame) into the frame stats. */
  private _gdAddStats(): void {
    const s = this._gd!.readStats(), f = this._frame;
    f.gpuDriven = this._gdLean ? 2 : 1;
    f.gpuMainDraws = s.draws; f.gpuMainTris = s.tris; f.gpuStatsAge = s.age; f.gpuRecords = s.records;
    f.drawCalls += s.draws; f.trisDrawn += s.tris;
    this._passDraws[PassBucket.Main] += s.draws; this._passTris[PassBucket.Main] += s.tris;
    if (this._gdLean) {   // the CPU skipped the camera tail of GPU-culled records: their frustum verdicts are the GPU's
      f.meshesCulled += s.meshesCulled; f.groupsCulled += s.groupsCulled; f.instancesCulled += s.instancesCulled;
      f.trisVisible += Math.max(0, s.tris - s.forcedTris);
    }
  }

  /** P15: switch the GPU-driven main pass (Renderer3D.gpuDriven / gpuDrivenLean / multi-draw-indirect use). */
  setGpuDriven(o: { enabled?: boolean; lean?: boolean; mdi?: boolean; twins?: boolean; prepasses?: boolean; ranges?: boolean; mergePatterned?: boolean; shadows?: boolean; cpuState?: boolean; subBundles?: boolean; rankCellM?: number; rankPatterned?: boolean; shadowCompact?: boolean; boundReach?: boolean }): { enabled: boolean; lean: boolean; mdi: boolean; twins: boolean; prepasses: boolean; ranges: boolean; mergePatterned: boolean; shadows: boolean; cpuState: boolean; subBundles: boolean; rankCellM: number; rankPatterned: boolean; shadowCompact: boolean; boundReach: boolean; mdiAvailable: boolean; ready: boolean } {
    if (o.enabled !== undefined) Renderer3D.gpuDriven = !!o.enabled;
    if (o.shadowCompact !== undefined) GpuDrivenMain.shadowCompact = !!o.shadowCompact;   // P15: compact dynamic shadow lists (same casters, takes effect next frame)
    if (o.boundReach !== undefined) setGdBoundReach(!!o.boundReach);   // P15: the compact lists' CPU bound keeps the shadow-reach test (a tighter K; same casters)
    if (o.subBundles !== undefined && !!o.subBundles !== GpuDrivenMain.subBundles) { GpuDrivenMain.subBundles = !!o.subBundles; this._gd?.invalidateBundle(); }
    if (o.rankCellM !== undefined && Number.isFinite(o.rankCellM)) Renderer3D.rankCellM = Math.max(0, +o.rankCellM);   // re-ranks on the next frame (both paths)
    if (o.rankPatterned !== undefined) Renderer3D.rankPatterned = !!o.rankPatterned;   // re-ranks on the next frame (both paths)
    if (o.lean !== undefined) Renderer3D.gpuDrivenLean = !!o.lean;
    if (o.mdi !== undefined) GpuDrivenMain.allowMdi = !!o.mdi;
    if (o.prepasses !== undefined) Renderer3D.gpuDrivenPrepasses = !!o.prepasses;
    if (o.cpuState !== undefined) GpuDrivenMain.cpuState = !!o.cpuState;
    if (o.shadows !== undefined && !!o.shadows !== GpuDrivenMain.shadows) { GpuDrivenMain.shadows = !!o.shadows; this._shadowMapStale = true; this._cascadeStale = true; }
    if (o.ranges !== undefined && !!o.ranges !== GpuDrivenMain.ranges) { GpuDrivenMain.ranges = !!o.ranges; this._gd?.reset(); }
    if (o.mergePatterned !== undefined && !!o.mergePatterned !== GpuDrivenMain.mergePatterned) { GpuDrivenMain.mergePatterned = !!o.mergePatterned; this._gd?.reset(); }
    if (o.twins !== undefined && !!o.twins !== GpuDrivenMain.twins) { GpuDrivenMain.twins = !!o.twins; this._gd?.reset(); }   // every forced flag changes
    return { enabled: Renderer3D.gpuDriven, lean: Renderer3D.gpuDrivenLean, mdi: GpuDrivenMain.allowMdi, twins: GpuDrivenMain.twins, prepasses: Renderer3D.gpuDrivenPrepasses, ranges: GpuDrivenMain.ranges, mergePatterned: GpuDrivenMain.mergePatterned, shadows: GpuDrivenMain.shadows, cpuState: GpuDrivenMain.cpuState,
      subBundles: GpuDrivenMain.subBundles, rankCellM: Renderer3D.rankCellM, rankPatterned: Renderer3D.rankPatterned, shadowCompact: GpuDrivenMain.shadowCompact, boundReach: gdBoundReach, mdiAvailable: this.device.features.has('chromium-experimental-multi-draw-indirect' as GPUFeatureName), ready: !!this._gd?.ready };
  }
  /** The GPU culling mode, loaded from the per-machine preference on first use. A stored 'off' switches the
   *  GPU-driven path off (Renderer3D.gpuDriven) once, at load. */
  private static _cullModeLoaded(): GpuCullingMode {
    if (Renderer3D._cullModeStatic === null) {
      Renderer3D._cullModeStatic = loadGpuCullingMode();
      if (Renderer3D._cullModeStatic === 'off') Renderer3D.gpuDriven = false;
    }
    return Renderer3D._cullModeStatic;
  }
  /** This frame's path (start of drawMeshes, the GPU scene ready): 'on' = the GPU path; 'auto' = the controller. */
  private _gdChoosePath(): GpuCullPath {
    const mode = Renderer3D._cullModeLoaded();
    if (mode !== 'auto') { this._cullPathNow = 'gpu'; this._cullReasonNow = 'mode-on'; return 'gpu'; }
    if (this._gd!.recordCount < Renderer3D.CULL_AUTO_MIN_RECORDS) { this._cullPathNow = 'gpu'; this._cullReasonNow = 'headroom'; return 'gpu'; }
    const p = this.cullAuto.decide(performance.now(), this._cullTimer);
    this._cullPathNow = p; this._cullReasonNow = this.cullAuto.reason;
    return p;
  }
  /** GPU CULLING MODE: 'on' = the GPU-driven path always; 'off' = the CPU path exactly (nothing of the GPU scene
   *  runs); 'auto' (default) = per frame, the GPU path when the frame is CPU-bound and the CPU path when it is
   *  GPU-bound (gpu-cull-auto.ts). Stored as a per-machine preference (localStorage) unless `persist` is false. */
  setGpuCullingMode(mode: GpuCullingMode, persist = true): ReturnType<Renderer3D['getGpuCullingMode']> {
    const m = sanitizeGpuCullingMode(mode);
    Renderer3D._cullModeLoaded();
    if (m !== Renderer3D._cullModeStatic) this.cullAuto.reset();
    Renderer3D._cullModeStatic = m;
    Renderer3D.gpuDriven = m !== 'off';
    if (persist) saveGpuCullingMode(m);
    return this.getGpuCullingMode();
  }
  /** The mode, the path drawing right now and why, the auto controller's state (switches, the last decision and its
   *  inputs: CPU / GPU ms medians, the other path's prediction, the budget) and the sub-bundle omission counters. */
  getGpuCullingMode(): { mode: GpuCullingMode; active: GpuCullPath; reason: GpuCullReason; reasonText: string; warm: boolean; ready: boolean;
    timer: 'timestamp' | 'estimate' | 'none'; auto: GpuCullAutoState; subBundles: { on: boolean; segments: number; kept: number; omittedDraws: number; omittedTotal: number } } {
    const mode = Renderer3D._cullModeLoaded();
    const ready = !!this._gd?.ready && !this._gdFailed;
    let active: GpuCullPath = 'gpu', reason: GpuCullReason;
    if (!Renderer3D.gpuDrivenActive) { active = 'cpu'; reason = Renderer3D.gpuDriven ? 'unavailable' : 'mode-off'; }
    else if (!ready || !this._gdOn) { active = 'cpu'; reason = 'unavailable'; }
    else { active = this._cullPathNow; reason = this._cullReasonNow; }
    const st = this._gd?.stats;
    return { mode, active, reason, reasonText: GPU_CULL_REASON_TEXT[reason], warm: this._gdWarm, ready, timer: this._cullTimer, auto: this.cullAuto.state(performance.now()),
      subBundles: { on: GpuDrivenMain.subBundles, segments: st?.segments ?? 0, kept: st?.segKept ?? 0, omittedDraws: st?.segOmitDraws ?? 0, omittedTotal: st?.segOmitTotal ?? 0 } };
  }
  /** WebGPURenderer, per frame: does the auto mode need the GPU frame timer (auto, the GPU scene running a city)? */
  wantsGpuTiming(): boolean {
    return Renderer3D._cullModeLoaded() === 'auto' && Renderer3D.gpuDrivenActive && this._gdOn && !!this._gd && this._gd.recordCount >= Renderer3D.CULL_AUTO_MIN_RECORDS;
  }
  /** WebGPURenderer, per frame: what the GPU frame timer measures this frame. */
  setGpuTimerSource(t: 'timestamp' | 'estimate' | 'none'): void { this._cullTimer = t; }
  /** WebGPURenderer: the main-thread ms of the frame just rendered (drawn on the path this frame chose). */
  noteCullCpuMs(ms: number): void { if (this._gdOn && this._gdPathLast) this.cullAuto.sampleCpu(ms, this._gdPathLast, performance.now()); }
  /** WebGPURenderer: a GPU frame time from the timestamp queries (1-2 frames late). */
  noteCullGpuMs(ms: number): void { if (this._gdOn && this._gdPathLast) this.cullAuto.sampleGpu(ms, this._gdPathLast, performance.now()); }
  /** P15 diagnostics: records, draw order, buckets, the last read-back GPU counters (GPU-reported), rebuilds, bundle
   *  re-records, uploads, the draw mode (bundle / mdi) and the CPU ms of the sync / rebuild / bundle encode. */
  getGpuDrivenStats(): GdStats & { on: boolean; lean: boolean } {
    const s = this._gd ? this._gd.readStats() : null;
    return { ...(s ?? ({} as GdStats)), on: this._gdOn, lean: this._gdLean };
  }
  /** P15 verification: resolves with the next GPU-driven frame's mismatches against the CPU lists (that frame builds
   *  the full lists). missing = drawn by the CPU path, culled by the GPU (an error); extra = the reverse. */
  verifyGpuDriven(): Promise<GdVerifyResult | null> {
    if (!this._gd || !Renderer3D.gpuDrivenActive) return Promise.resolve(null);
    return new Promise((res) => this._gd!.requestVerify(res));
  }
  /** P1.2 ORTHO SCREEN-SIZE LOD: under an orthographic camera, distance LOD (drawDistance + nearTwin) compares each
   *  mesh's draw distance with orthoLodDistance(orthoSize) — the zoom, uniform across the view — instead of turning
   *  off. false = the old behaviour (ortho draws everything, far twins only). */
  orthoScreenLod = true;
  /** P1.1 ORTHO DEPTH RANGE (docs/specs/performance-plan.md). An ortho camera's depth is LINEAR, and the 2D-ortho
   *  illustration camera puts its near plane at the eye, right at the front of a big scene (a city). Nearly every
   *  fragment then stores a depth close to 0, which made the main colour pass ~5x slower on NVIDIA (the coarse depth
   *  cull stops rejecting hidden fragments): 2D ortho ran at 60 ms vs 10 ms for the same view with the stored depth
   *  moved off 0. So under ortho every pass that depth-tests against the scene depth buffer maps NDC depth [0, 1] to
   *  [ORTHO_DEPTH_MIN, 1] with the viewport depth range. Clipping (done on NDC) is untouched, ordering is untouched,
   *  1.0 stays the cleared "nothing drawn" value; only 1/3 of the depth precision is given up (linear, plenty). The
   *  host calls applySceneDepthRange at the start of each such pass. false = the plain [0, 1] (A/B). */
  orthoDepthRemap = true;
  static readonly ORTHO_DEPTH_MIN = 1 / 3;
  /** The viewport minDepth for the scene's depth-tested passes this frame (0 = the plain [0, 1]). */
  sceneDepthRangeMin(): number {
    return this.orthoDepthRemap && this.camera.mode === 'orthographic' ? Renderer3D.ORTHO_DEPTH_MIN : 0;
  }
  /** Set the full-target viewport with this frame's scene depth range on `pass` (no-op for the plain [0, 1], which is
   *  every pass's default). Call before the pass's first depth-tested 3D draw; later draws in the pass inherit it. */
  applySceneDepthRange(pass: GPURenderPassEncoder, w: number, h: number): void {
    const m = this.sceneDepthRangeMin();
    if (m > 0 && w > 0 && h > 0) pass.setViewport(0, 0, w, h, m, 1);
  }
  /** Array groups currently beyond their source's drawDistance (hysteresis state — see Mesh3D.lodHidden). */
  private readonly _lodHiddenGroups = new Set<string>();
  /** P8: array groups (instanced twins) whose camera is currently NEAR — the group-twin hysteresis state. */
  private readonly _lodTwinNearGroups = new Set<string>();
  /** P8 INSTANCED NEAR/FAR TWINS master switch (the far tree crowns). false = near groups always, far never (A/B). */
  static groupTwins = true;
  // Reused scratch for computeLightSpaceMatrix (ran every frame while shadows are on — city + character).
  private readonly _lsmEye = vec3.create();
  private readonly _lsmCenter = vec3.create();   // the shadow-box centre: follows the camera focus, texel-snapped
  private _shadowFollowCamera = true;            // centre the ortho box on the camera focus (vs locked at origin)
  private readonly _lsmUp = vec3.create();
  private readonly _lsmView = mat4.create();
  private readonly _lsmProj = mat4.create();
  private readonly _lsmMatrix = mat4.create();
  // One scratch bag handed to the pure computeLightSpaceMatrix each frame (allocation-free hot path).
  private readonly _lsmScratch = { eye: this._lsmEye, up: this._lsmUp, view: this._lsmView, proj: this._lsmProj, out: this._lsmMatrix };

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
  // Artboard "render frame" outline (illustration × free3D) — see setArtboardFrame / drawArtboardFrameIfActive.
  private _artboardFrameVisible = false;
  private _artboardHalfW = 1;
  private _artboardHalfH = 1;
  private _artboardColor: [number, number, number] = [0.55, 0.62, 0.95];
  private _artboardOpacity = 0.7;

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
  // ALPHA-SHAPED outlines for transparent-textured sprites (sprite-alpha-outlines.md) — a separate pass + a per-texture
  // distance-field cache. Only sprites that spriteOutlineMode routes here ('image' also needs the image to have transparency).
  private _spriteOutlinePass: SpriteOutlinePass | null = null;
  private _spriteSDF: SpriteSDFCache | null = null;
  /** A sprite's distance field was still building last frame — keep frames flowing until it lands. */
  private _spriteSDFPending = false;
  // Screen-space silhouette outline for HOVER (uniform thickness, any angle, no normal tearing — replaces the old
  // expand-normals ring for hover; the 'select' slot still uses the stencil ring above).
  private _silhouettePass: SilhouetteOutlinePass | null = null;
  // Hover outline style — patternMode 0 = flat (default). Set a patterned/animated style via setHoverOutlineStyle.
  private _hoverOutlineStyle: HighlightStyle = { color: [0.45, 0.85, 1.0, 0.85], width: 0.05, thicknessPx: 6, patternMode: 0, patternColor: [1, 1, 1], freq: 20, speed: 1, glow: 1 };

  // PERSISTENT per-object outlines (user-assigned, one style each). Runtime draw cache keyed by mesh id; the
  // persisted source of truth is Mesh3D.outline (scene3d-manager mirrors set/restore into here). Drawn every frame
  // with the same stencil-ring technique as hover/select (drawCustom), one param buffer per outlined mesh.
  private _meshOutlines = new Map<string, HighlightStyle>();
  /** Extra stacked rings per outlined mesh (Mesh3D.outlineRings), inner → outer. */
  private _meshOutlineRings = new Map<string, HighlightStyle[]>();
  // Per-mesh SMOOTHED-normal outline geometry (VB + IB): the inverted-hull shell uses averaged normals so hard
  // edges (cubes, buildings) don't TEAR into gaps. Built lazily from mesh.geometry, cached by id, rebuilt on
  // re-assign, freed on evict/clear. (Skinned meshes keep their own normals — characters are already smooth.)
  private _outlineGeom = new Map<string, { vb: GPUBuffer; ib: GPUBuffer; count: number }>();
  private _dropOutlineGeom(meshId: string): void {
    const e = this._outlineGeom.get(meshId);
    if (e) { e.vb.destroy(); e.ib.destroy(); this._outlineGeom.delete(meshId); }
  }
  private _ensureOutlineGeom(mesh: Mesh3D): { vb: GPUBuffer; ib: GPUBuffer; count: number } | null {
    const cached = this._outlineGeom.get(mesh.id);
    if (cached) return cached;
    const g = mesh.geometry;
    if (!g || !g.vertices || g.vertices.length === 0 || !g.indices || g.indices.length === 0) return null;
    const smooth = smoothNormalsForOutline(g.vertices as Float32Array, 12, 0, 3);
    const vb = this.device.createBuffer({ size: smooth.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vb, 0, smooth);
    const idx = (g.indices instanceof Uint32Array) ? g.indices : new Uint32Array(g.indices as ArrayLike<number>);
    const ib = this.device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ib, 0, idx);
    const e = { vb, ib, count: idx.length };
    this._outlineGeom.set(mesh.id, e);
    return e;
  }
  /** Assign (or clear with null) a persistent outline for a mesh. Drops any cached outline geometry so a re-assign
   *  rebuilds the smoothed shell from the mesh's CURRENT geometry. */
  setMeshOutline(meshId: string, style: HighlightStyle | null, rings?: HighlightStyle[] | null): void {
    this._dropOutlineGeom(meshId);
    if (style) this._meshOutlines.set(meshId, style); else this._meshOutlines.delete(meshId);
    if (style && rings?.length) this._meshOutlineRings.set(meshId, rings); else this._meshOutlineRings.delete(meshId);
  }

  getMeshOutline(meshId: string): HighlightStyle | null { return this._meshOutlines.get(meshId) ?? null; }
  /** True if any persistent outline scrolls (speed !== 0) — the host keeps frames flowing while it does. */
  get hasAnimatedOutline(): boolean {
    for (const s of this._meshOutlines.values()) if (outlineAnimates(s)) return true;
    for (const rs of this._meshOutlineRings.values()) for (const r of rs) if (outlineAnimates(r)) return true;
    return this._spriteSDFPending && this._meshOutlines.size > 0;
  }
  /** Configure the hover outline look (thickness + scrolling pattern + glow). patternMode 0 restores the flat ring.
   *  Caller schedules the redraw (scene3d-manager wrapper). */
  setHoverOutlineStyle(style: Partial<HighlightStyle>): void { Object.assign(this._hoverOutlineStyle, style); }
  get hoverOutlineStyle(): HighlightStyle { return { ...this._hoverOutlineStyle }; }
  /** Whether the hover outline currently animates — the host keeps frames flowing while it does. Gated on
   *  speed ALONE (not patternMode): olPattern scrolls its phase by time*speed for EVERY mode including the
   *  default mode 0 (which is a scrolling diagonal stripe, not flat despite the old comment), so any non-zero
   *  speed animates. The previous `patternMode > 0` gate missed the animating default and let it freeze. */
  get hoverOutlineAnimated(): boolean { return this._hoverOutlineStyle.speed !== 0; }
  /** True when an animated hover outline is ACTUALLY being drawn — an animated style AND a live hover
   *  target (a hovered non-selected mesh, or an explicit sub-range). The outline's animation phase is read
   *  from performance.now() each frame, so with the on-demand renderer it freezes the moment frames stop
   *  scheduling (pointer hovers but doesn't move). The host registers this as a preRenderCallback so the
   *  loop stays alive while an animated outline is on screen. */
  get hoverOutlineActive(): boolean {
    if (!this.hoverOutlineAnimated) return false;
    if (this._hoverOutlineRanges) return true;
    for (const id of this._hoveredMeshIds) if (!this._selectedMeshIds.has(id)) return true;
    return false;
  }
  // Sub-range hover source: outline an arbitrary set of index ranges within merged meshes (ONE landmark's exact
  // silhouette out of the merged world:lm-* meshes). Independent of _hoveredMeshIds (which is the whole-mesh path).
  private _hoverOutlineRanges: { meshId: string; indexStart: number; indexCount: number }[] | null = null;
  /** Outline exact index sub-ranges (e.g. one landmark) with the hover style. Pass null to clear. */
  setHoverOutlineRanges(ranges: { meshId: string; indexStart: number; indexCount: number }[] | null): void {
    this._hoverOutlineRanges = ranges && ranges.length ? ranges : null;
  }
  get hasHoverOutlineRanges(): boolean { return this._hoverOutlineRanges !== null; }
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
  /** Keeps an opaque focus background (armature / mesh edit) out of post-processing — see post-bg-keep-pass.ts. */
  private _postBgKeepPass: PostBgKeepPass | null = null;
  private _sceneBgOpts: ArmatureBgOptions = { mode: 'none' };

  // Post-processing stack
  private _postProcessPass: PostProcessPass | null = null;

  // SSAO — screen-space ambient occlusion (spec docs/specs/ssao.md). Gated: off → nothing allocates or runs.
  private _ssao: SSAOPass | null = null;
  private _ssaoEnabled = false;
  private _ssaoDebug = false;
  private readonly _ssaoConfig: SSAOConfig = { ...DEFAULT_SSAO_CONFIG };
  // AO is sampled in the mesh FS at group(0) binding 3/4. When SSAO is off (or its buffer isn't ready), a 1×1
  // WHITE texture is bound → ambient × 1 = exact no-op. Skinned meshes always bind white (not in the AO prepass).
  private _ssaoWhiteTex: GPUTexture | null = null;
  private _ssaoAOSampler: GPUSampler | null = null;
  private _meshBindGroupAOTex: GPUTexture | null = null;
  // Scene color (previous frame) sampled in the mesh FS at group(0) binding 5/6 for GLASS REFRACTION. The
  // webgpu-renderer copies last frame's swap-chain image into this texture each frame; glass fragments sample
  // it offset by their normal. When no grab texture is set, a 1×1 texture is bound → sampled but the refraction
  // branch only runs for glassEnhance meshes, so it's a harmless bind for everything else.
  private _sceneColorGrabTex: GPUTexture | null = null;      // the live grab (set by webgpu-renderer); null → default
  private _sceneColorDefaultTex: GPUTexture | null = null;   // 1×1 opaque-black fallback (swap-chain format, like the grab)
  private _sceneColorSampler: GPUSampler | null = null;
  private _meshBindGroupSceneTex: GPUTexture | null = null;

  // Prefiltered SPECULAR IBL (P1b) sampled at group 0 binding 7/8/9 in the mesh FS. `_prefilteredCubeTex` is the
  // sky convolved per-roughness (mip chain); `_brdfLutTex` is the environment-independent split-sum LUT (baked once);
  // `_iblCubeSampler` (linear + mip-linear + clamp) serves both. A 1×1×6 dummy cube is bound when specular IBL is off
  // so the layout is always satisfied (the shader only samples it behind `iblSpecularEnabled`). See ibl-specular-bake.ts.
  private _prefilteredCubeTex: GPUTexture | null = null;   // real baked cube (null → bind the dummy)
  private _dummyCubeTex: GPUTexture | null = null;         // 1×1×6 fallback
  private _brdfLutTex: GPUTexture | null = null;           // 1×1 placeholder until specular is first baked (then the real 128²)
  private _brdfLutBaked = false;                           // the real split-sum LUT has been computed
  // P4.1 GPU sky-lighting bake (ibl-gpu-bake.ts). `_shGpuOwned` = SH floats 0-35 of the IBL uniform buffer were
  // written by the GPU (copyBufferToBuffer), so _writeIBLBuffer must NOT overwrite them with the stale CPU mirror.
  // `_pendingSkyBake` = a bake requested while the compute pipelines were still compiling (replayed on ready).
  private _iblGpu: IBLGpuBaker | null = null;
  private _iblGpuTried = false;
  private _shGpuOwned = false;
  private _iblBakeMode: 'auto' | 'cpu' = 'auto';
  private _pendingSkyBake: { sky: ProceduralSkyParams; sunDir: [number, number, number]; intensity: number; diffuse: boolean; specular: boolean; baseSize: number } | null = null;
  private _iblBakeStats = { gpu: 0, cpu: 0, pending: 0, lastPath: 'none' as 'gpu' | 'cpu' | 'pending' | 'none', lastMs: 0 };
  private _iblCubeSampler: GPUSampler | null = null;
  private _meshBindGroupCubeTex: GPUTexture | null = null; // change → rebuild the mesh bind group

  // Screen-space reflections (P2) sampled at group 0 binding 10 in the mesh FS: the SSAO world-position prepass
  // (rgba32float, read via textureLoad — unfilterable) lets a reflective fragment ray-march against scene geometry.
  // SSR reuses the SSAO pass's world-pos G-buffer, so enabling SSR runs that prepass even when AO itself is off.
  private _ssrEnabled = false;
  /** The requested SSR switch before the device cap (re-applied by applyDeviceCaps). */
  private _ssrWanted = false;
  // DEPTH-PEELED backface-fill (default ON with SSR): a second prepass keeps the SECOND-nearest surface so the
  // fill can test exact volume membership (front <= rayDepth <= back). setSSRDepthPeeling(false) = the engine
  // escape hatch back to the single-layer thickness heuristic (debug/A-B only — not persisted, no UI).
  private _ssrDepthPeel = true;
  // #2 ZOOM-STABLE REACH: persisted WORLD reach for reflections; converted to a texel budget per frame (the march
  // budget is measured in screen texels, so a fixed budget shrinks the world reach as the user zooms in —
  // reflections lost faces/interiors at working zoom).
  private _ssrReachWorld = 12.8;
  // ── World clock (UI System freezeWorld/setWorldSpeed): the shader scene time advances at _worldSpeed so
  // time-driven effects (water/neon/holograms) freeze or slow with the world. UI/hover shimmer uses
  // its own wall clock and keeps running.
  private _worldSpeed = 1;
  private _worldTimeAccMs = 0;
  private _worldTimeLast = performance.now();
  // Stage 3b: deferred half-res SSR (trace once per half-res texel in a resolve pass; the mesh FS samples the
  // result). setSSRDeferred(false) = engine escape hatch back to the inline per-fragment trace (debug A/B only).
  private _ssrDeferred = true;
  private _dummyWorldPosTex: GPUTexture | null = null;      // 1×1 rgba32float when the prepass hasn't run
  private _meshBindGroupWorldPosTex: GPUTexture | null = null;
  private _meshBindGroupWorldPosBackTex: GPUTexture | null = null;
  private _meshBindGroupNormalTex: GPUTexture | null = null;
  private _meshBindGroupReflectionTex: GPUTexture | null = null;
  private _dummyHalfFloatTex: GPUTexture | null = null;     // 1×1 rgba16float for bindings 12/13 when off

  // Lo-fi render buffer (PS1/3DS low-res + nearest-neighbor blit)
  private _loFiPass: LoFiPass | null = null;

  // ── TEMPORAL AA / UPSCALING (engine-roadmap step 6; temporal-aa.ts; the glue is in the "Temporal AA" section) ──
  private _taa: TemporalAAPass | null = null;
  private _taaSet: TemporalAASettings = { ...DEFAULT_TEMPORAL_AA };
  private _taaOn = false;                     // this frame renders through the TAA path (decided by setTemporalFrame)
  private _taaReason: TemporalAAReason = 'off';
  private _taaScale = 1;                      // the internal render scale of this TAA frame
  private _taaFrameNo = 0;
  private readonly _taaJit: [number, number] = [0, 0];      // render-target pixels
  private readonly _taaJitNdc: [number, number] = [0, 0];
  private _taaDither = 0;                     // scene float 259 (the dither-fade shift), 0 = off
  private readonly _taaPrevVP = new Float32Array(16);
  private readonly _taaCurVP = new Float32Array(16);
  private readonly _taaJitVP = new Float32Array(16);
  private readonly _taaInvVP = new Float32Array(16);
  private _taaHasPrev = false;
  private _taaVelOn = false;                  // the transforms fast path records movers (prev matrices) this frame
  private readonly _taaMovers: { m: Mesh3D | null; slot: number; sub: number; prev: Float32Array }[] = [];
  private _taaMoverN = 0;
  private readonly _taaRigid: TaaRigidDraw[] = [];
  private readonly _taaSkin: TaaSkinnedDraw[] = [];
  private readonly _taaSkinPrevModel = new Map<string, Float32Array>();
  private _taaSkinFrame = -1;                 // the TAA frame drawSkinnedMeshes last ran in
  private _taaBypassFxaa = false;             // a capture bypassed TAA: FXAA stands in for it
  private _taaVelDraws = 0;

  constructor(device: GPUDevice, camera: Camera3D, swapChainFormat: GPUTextureFormat = 'bgra8unorm') {
    this.device = device;
    this.camera = camera;
    this._swapChainFormat = swapChainFormat;
    this._slotAlloc.onDisown = (owner) => { this._parkedGroups.delete(owner); };   // a parked range was reused → its data is gone
    this.pipeline = new Pipeline3D(device, swapChainFormat);
    this._highlightPass = new MeshHighlightPass(device, this.pipeline.meshBindGroupLayout, swapChainFormat, this.pipeline.skinBindGroupLayout, this.pipeline.textureBindGroupLayout);
    this._silhouettePass = new SilhouetteOutlinePass(device, this.pipeline.meshBindGroupLayout, swapChainFormat);
    this._spriteOutlinePass = new SpriteOutlinePass(device, this.pipeline.meshBindGroupLayout, swapChainFormat);
    this._spriteSDF = new SpriteSDFCache(device);
    this._ghostPreviewRenderer = new GhostPreviewRenderer(device, swapChainFormat);
    this._armatureBgPass = new ArmatureBgPass(device, swapChainFormat);
    this._sceneBgPass = new ArmatureBgPass(device, swapChainFormat);
    this._postBgKeepPass = new PostBgKeepPass(device, swapChainFormat);

    // Create scene uniform buffer (updated every frame)
    this.sceneUniformBuffer = device.createBuffer({
      size: SCENE_UNIFORM_SIZE_PADDED,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // P4b: the planar mirror pass renders with its own (mirrored + oblique) camera uniforms.
    this._planarSceneBuf = device.createBuffer({
      size: SCENE_UNIFORM_SIZE_PADDED,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'PlanarSceneUniforms',
    });

    // IBL uniform buffer — written once when env map changes, otherwise default "no-IBL" state
    this._iblUniformBuffer = device.createBuffer({
      size: 224,  // 9×vec4(16) + 20 scalars(80): IBL(enabled,diffuse,specEnabled,specMaxMip,specIntensity) + SSR params + pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'IBLUniforms',
    });
    this._iblData[40] = 1.0;   // default specular intensity (independent of diffuse); preserved across env-map clears
    // SSR defaults (inert until ssrEnabled=1): 41=off, 42=maxSteps (march reach in half-res texels — steps are
    // strictly ~1 texel), 43=stride (world-scale hint: bias/offPlane eps/world reach cap), 44=thickness, 45=intensity,
    // 46=maxRough
    this._iblData[42] = 160; this._iblData[43] = 0.08; this._iblData[44] = 0.15; this._iblData[45] = 1.0; this._iblData[46] = 0.5;
    this._iblData[48] = 2.0;   // fill internal-blur radius (half-res texels)
    this._iblData[49] = 2.0;   // fill edge-feather ring radius (half-res texels)
    this._iblData[50] = 1.0;   // depth-peeled backface-fill (1 = volume-membership test; see setSSRDepthPeeling)
    this._iblData[51] = 0.35;  // silhouette-shadow fallback opacity (artist slider; see setSSRParams)
    this._iblData[52] = 1.0;   // deferred SSR resolve (Stage 3b) — setSSRDeferred(false) = inline-trace hatch
    this._writeIBLBuffer();
    this._getIBLGpu();   // P4.1: start the async sky-bake compute compiles now, so the first sky bake runs on the GPU
  }

  /** Warm the deferred render pipelines (plain / SSAO / weight-paint) ahead of use, off the main thread.
   *  Constructing this Renderer3D already compiled the core pipelines; this finishes the rest so the first
   *  3D mesh / next document doesn't stall on compilation. See docs/specs/pipeline-warmup.md. */
  warmPipelinesAsync(): Promise<void> {
    const p = this.pipeline.warmAllAsync();
    if (this._shadowsEnabled) this._splitWarmShadowBase(PIPELINE_PRIORITY.COMMON);   // SHADER SPLIT: shadows already on at boot
    return p;
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
  /** Screen-space refraction on glassEnhance surfaces (contents show THROUGH clear plastic). OFF by default; the CD
   *  kit enables it so the lid reads as clear glass — the city's glazing shares the glassEnhance flag but stays put. */
  setGlassRefraction(on: boolean): void { this._glassRefraction = on ? 1 : 0; }
  /** Global soft-lighting (wrapped/half-Lambert) strength 0..1 — only affects materials with the softLighting flag. */
  setSoftLightStrength(s: number): void { this._softLightStrength = Math.max(0, Math.min(1, s)); }
  get softLightStrength(): number { return this._softLightStrength; }
  setSkinRamp(patch: Partial<SkinRampSettings>): void { this._skinRamp = resolveSkinRamp(this._skinRamp, patch); }
  get skinRamp(): SkinRampSettings { return this._skinRamp; }
  /** Sketch style paper amount 0..1 (clamped). */
  setSketchPaper(v: number): void { this._sketchPaper = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.75)); }
  get sketchPaper(): number { return this._sketchPaper; }
  /** COLOURED cast shadows (city-quality L3): the hue the in-shadow floor takes (luminance-normalised in the shader,
   *  so darkness is unchanged). null = neutral grey (the original). */
  private _shadowTint: [number, number, number] | null = null;
  setShadowTint(c: [number, number, number] | null): void {
    this._shadowTint = c && c.every(Number.isFinite) && (c[0] + c[1] + c[2]) > 0 ? [c[0], c[1], c[2]] : null;
  }
  get shadowTint(): [number, number, number] | null { return this._shadowTint ? [...this._shadowTint] as [number, number, number] : null; }
  /** HEIGHT FOG (city-quality P9): density (0 = off), base height (world y), falloff per unit, distance reach.
   *  Needs the regular fog on (it rides the fog block). */
  private _heightFog: [number, number, number, number] = [0, 0, 0, 0];
  setHeightFog(density: number, baseY = 0, falloff = 1, reach = 0.05): void {
    this._heightFog = [Math.max(0, density || 0), baseY, Math.max(1e-4, falloff), Math.max(1e-4, reach)];
  }
  get heightFog(): [number, number, number, number] { return [...this._heightFog] as [number, number, number, number]; }
  /** AERIAL PERSPECTIVE (persona-polish A5): distance haze that fades CONTRAST and tints toward the fog (horizon)
   *  colour — `strength` 0..1 (0 = off, the original), `reach` = world distance at which ~63 % of it has built up,
   *  `contrast` / `tint` = how much of it is contrast loss vs colour shift (0..1). Needs fog on (it rides the fog block). */
  setAerialHaze(strength: number, reach = 20, contrast = 0.6, tint = 0.5): void {
    this._aerialHaze = [Math.max(0, Math.min(1, strength || 0)), Math.max(1e-4, reach), Math.max(0, Math.min(1, contrast)), Math.max(0, Math.min(1, tint))];
  }
  get aerialHaze(): [number, number, number, number] { return [...this._aerialHaze] as [number, number, number, number]; }
  private _aerialHaze: [number, number, number, number] = [0, 20, 0.6, 0.5];
  setToonShadows(patch: Partial<ToonShadowSettings>): void { this._toon = resolveToonShadows(this._toon, patch); }
  get toonShadows(): ToonShadowSettings { return { ...this._toon, shadowTint: [...this._toon.shadowTint] as [number, number, number] }; }
  setRimLight(patch: Partial<RimLightSettings>): void { this._rim = resolveRimLight(this._rim, patch); }
  get rimLight(): RimLightSettings { return { ...this._rim, color: [...this._rim.color] as [number, number, number] }; }
  get glassRefraction(): boolean { return this._glassRefraction > 0.5; }

  /** Scene WIND (foliage-quality §2.1) — direction/strength/speed shared by every `windSway` material.
   *  Partial patch; unspecified fields keep their current value. */
  setSceneWind(patch: Partial<SceneWind3D>): void { this._wind = resolveSceneWind(this._wind, patch); }
  get sceneWind(): SceneWind3D { return { ...this._wind }; }
  /** Aerial-perspective strength 0..1 — distant geometry desaturates + fades to the fog colour (needs fog on). */
  setAerialFog(strength: number): void { this._aerialFog = Math.max(0, Math.min(1, strength)); }
  get aerialFog(): number { return this._aerialFog; }
  /** HARD FOG EDGE (2026-10-01): while on, only the plain linear/exponential fog draws — aerial haze, height fog and
   *  the aerial desaturation are UPLOADED as off (their stored values are untouched, so turning it off restores them),
   *  giving the old sharp near/far cutoff. The city also stops rescaling / replacing the fog (WorldManager). Default off. */
  fogHardEdge = false;
  /** FOG HORIZON settings (docs/specs/fog-horizon.md; sm.setFogHorizon3D): building-only silhouettes past the fog's
   *  Far, the dither fade band, silhouette outlines. Active only while fogHardEdge is on and the fog is linear. */
  private _fogHorizon: FogHorizonSettings = defaultFogHorizon();
  setFogHorizon(patch: Partial<FogHorizonSettings> & { reset?: boolean }): FogHorizonSettings {
    this._fogHorizon = sanitizeFogHorizon(patch, this._fogHorizon);
    return this.fogHorizon;
  }
  get fogHorizon(): FogHorizonSettings { return { ...this._fogHorizon }; }
  /** World units per real metre for the fog-horizon fade band (the city sets it from its scale; 1 elsewhere). */
  fogHorizonUnitsPerMetre = 1;
  /** Whether the fog-horizon rules apply this frame (Hard edge on + linear fog). */
  get fogHorizonActive(): boolean { return fogHorizonActive(this.fogHardEdge, this._fog); }
  /** The FOG EYE this frame (fog-horizon.ts computeFogEye): perspective = the camera position, ortho = the
   *  equivalent-perspective eye. Every fog distance (shader fog, fast path, fade band, outline cut, CPU cull) uses it. */
  readonly _fogEye = new Float64Array(3);
  /** The fog eye (a copy), as packed into the scene uniforms for the last frame. */
  get fogEye(): [number, number, number] { return [this._fogEye[0], this._fogEye[1], this._fogEye[2]]; }
  /** SIM LOD (src/world/sim-lod.ts, performance-plan §P13): the fog-horizon CULL distance (world units, from the fog
   *  eye) while the CPU fog cull is on — Hard edge + linear fog + "Buildings only in fog", no planar mirror — else
   *  Infinity. Movers, crowd poses and character idles past it are frozen: the renderer does not draw them. */
  get simFogEdge(): number {
    const on = this._fogHorizon.buildingsOnly && this.fogHorizonActive && !this._planarActive && Renderer3D.fogHorizonCpuCull;
    return on ? fogHorizonEdge(this._fog) * 1.01 : Infinity;
  }
  /** SIM LOD: a skinned part's world box from the last frame's skinned cull (min xyz, max xyz), or null. */
  skinnedBoxOf(meshId: string): Float64Array | null {
    const e = this._skCull.get(meshId);
    return e && e.ok ? e.box : null;
  }

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
  /** Whether crisp prefiltered-cubemap specular IBL is active (vs the soft SH-probe fallback). */
  get iblSpecularEnabled(): boolean { return this._iblData[38] > 0.5 || !!this._pendingSkyBake?.specular; }
  /** DIFFUSE IBL scale (the SH irradiance on matte surfaces). */
  get iblDiffuseIntensity(): number { return this._iblData[37]; }
  /** SPECULAR (reflection) IBL scale — independent of diffuse. */
  get iblSpecularIntensity(): number { return this._iblData[40]; }
  /** Set the DIFFUSE IBL scale live (no SH re-upload). */
  setIBLDiffuseIntensity(v: number): void { this._iblIntensity = Math.max(0, v); this._iblData[37] = this._iblIntensity; this._writeIBLBuffer(); }
  /** Set the SPECULAR (reflection) IBL scale live — balance reflections against diffuse ambient without a re-bake. */
  setIBLSpecularIntensity(v: number): void { this._iblData[40] = Math.max(0, v); this._writeIBLBuffer(); }

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
    this._shGpuOwned   = false;   // CPU SH wins again (full-buffer writes resume)
    if (this._pendingSkyBake) this._pendingSkyBake.diffuse = false;
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

  /** Remove the DIFFUSE environment map (SH) and fall back to the constant scene.ambientColor. Leaves the SPECULAR
   *  cubemap state (enabled/maxMip/intensity, floats 38-40) UNTOUCHED so the two are independently controllable. */
  clearEnvironmentMap3D(): void {
    this._iblEnabled = false;
    this._shGpuOwned = false;
    if (this._pendingSkyBake) this._pendingSkyBake.diffuse = false;
    for (let i = 0; i < 36; i++) this._iblData[i] = 0;   // zero SH coeffs only
    this._iblData[36] = 0.0;   // iblEnabled off
    this._iblData[37] = 1.0;   // reset diffuse intensity
    this._writeIBLBuffer();
  }

  /**
   * P4.1: bake a procedural sky into BOTH IBL paths - SH9 diffuse (what setEnvironmentMap3D(bakeSkyEquirect(..))
   * computes on the CPU) and the prefiltered specular cube (bakeSpecularIBL) - on the GPU via compute
   * (ibl-gpu-bake.ts), with no readback. Falls back to the CPU reference when compute is unavailable / failed or the
   * mode is forced to 'cpu'. While the compute pipelines are still compiling, the request is held (the previous
   * lighting stays on screen) and replayed the moment they resolve. Returns which path ran.
   */
  bakeSkyLighting(
    sky: ProceduralSkyParams, sunDir: [number, number, number], intensity = 1.0,
    opts: { diffuse?: boolean; specular?: boolean; baseSize?: number } = {},
  ): 'gpu' | 'cpu' | 'pending' {
    const diffuse = opts.diffuse ?? true, specular = opts.specular ?? true, baseSize = opts.baseSize ?? 32;
    const t0 = performance.now();
    const gpu = this._iblBakeMode === 'auto' ? this._getIBLGpu() : null;
    let path: 'gpu' | 'cpu' | 'pending';
    if (gpu && gpu.ready) {
      try { this._runGpuSkyBake(gpu, sky, sunDir, intensity, diffuse, specular, baseSize); path = 'gpu'; }
      catch (e) { console.warn('[IBL] GPU sky bake failed - CPU fallback', e); this._iblBakeMode = 'cpu'; this._runCpuSkyBake(sky, sunDir, intensity, diffuse, specular, baseSize); path = 'cpu'; }
    } else if (gpu && !gpu.failed) {
      const prev = this._pendingSkyBake;
      this._pendingSkyBake = {
        sky: { ...sky }, sunDir: [sunDir[0], sunDir[1], sunDir[2]], intensity: diffuse ? intensity : (prev?.intensity ?? intensity),
        diffuse: diffuse || !!prev?.diffuse, specular: specular || !!prev?.specular, baseSize,
      };
      if (diffuse) { this._iblEnabled = true; this._iblIntensity = intensity; }
      if (!prev) {
        gpu.hurry();
        void gpu.whenReady.then((ok) => {
          const p = this._pendingSkyBake; this._pendingSkyBake = null;
          if (!p || this._iblGpu !== gpu) return;
          if (ok) {
            try { this._runGpuSkyBake(gpu, p.sky, p.sunDir, p.intensity, p.diffuse, p.specular, p.baseSize); }
            catch (e) { console.warn('[IBL] GPU sky bake failed - CPU fallback', e); this._iblBakeMode = 'cpu'; this._runCpuSkyBake(p.sky, p.sunDir, p.intensity, p.diffuse, p.specular, p.baseSize); }
          } else this._runCpuSkyBake(p.sky, p.sunDir, p.intensity, p.diffuse, p.specular, p.baseSize);
          this.onSkyBakeApplied?.();
        });
      }
      path = 'pending';
    } else {
      this._runCpuSkyBake(sky, sunDir, intensity, diffuse, specular, baseSize); path = 'cpu';
    }
    const st = this._iblBakeStats; st[path]++; st.lastPath = path; st.lastMs = +(performance.now() - t0).toFixed(3);
    return path;
  }

  /** Called after a DEFERRED (pipeline-pending) sky bake lands, so the host can schedule a redraw. */
  onSkyBakeApplied: (() => void) | null = null;

  /** 'auto' = GPU compute bake when available (default), 'cpu' = force the CPU reference (A/B + fallback testing). */
  setIBLBakeMode(mode: 'auto' | 'cpu'): void { this._iblBakeMode = mode; }
  /** Bake counters + the main-thread cost of the last bake (ms). */
  getIBLBakeStats(): { gpu: number; cpu: number; pending: number; lastPath: string; lastMs: number; gpuReady: boolean } {
    return { ...this._iblBakeStats, gpuReady: !!this._iblGpu?.ready };
  }
  /** Debug/verification handle for the headless CPU-vs-GPU comparison (null until first use / unsupported). */
  get iblGpuBaker(): IBLGpuBaker | null { return this._getIBLGpu(); }

  /** Lazily create the GPU baker (starts the async pipeline compiles). Null when compute is unsupported. */
  private _getIBLGpu(): IBLGpuBaker | null {
    if (!this._iblGpuTried) {
      this._iblGpuTried = true;
      try { if (IBLGpuBaker.supported(this.device)) this._iblGpu = new IBLGpuBaker(this.device); }
      catch (e) { console.warn('[IBL] GPU baker unavailable - CPU bake', e); this._iblGpu = null; }
    }
    return this._iblGpu && !this._iblGpu.failed ? this._iblGpu : null;
  }

  private _ensureSpecularCubeTex(baseSize: number, mips: number): GPUTexture {
    const cur = this._prefilteredCubeTex;
    if (!cur || cur.width !== baseSize || cur.mipLevelCount !== mips) {
      cur?.destroy();
      this._prefilteredCubeTex = this.device.createTexture({
        size: [baseSize, baseSize, 6], format: 'rgba8unorm-srgb', dimension: '2d', mipLevelCount: mips,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'IBLPrefilteredCube',
      });
    }
    return this._prefilteredCubeTex!;
  }

  private _markSpecularBaked(mips: number): void {
    this._iblData[38] = 1.0;          // iblSpecularEnabled
    this._iblData[39] = mips - 1;     // specularMaxMip
    this._meshBindGroupCubeTex = null;   // force main mesh bind group rebuild with the real cube
    this._skinnedMeshBG = null;          // and the skinned one (its guard only tracks the instance buffer)
  }

  private _runGpuSkyBake(gpu: IBLGpuBaker, sky: ProceduralSkyParams, sunDir: [number, number, number], intensity: number, diffuse: boolean, specular: boolean, baseSize: number): void {
    let cube: { tex: GPUTexture; baseSize: number; mipCount: number; samples: number } | null = null;
    let lut: { tex: GPUTexture; size: number; samples: number } | null = null;
    const mips = cubeMipCount(baseSize);
    if (specular) {
      this._ensureSpecularIBLResources();
      if (!this._brdfLutBaked) {
        const size = 128;
        this._brdfLutTex!.destroy();   // drop the 1x1 placeholder
        this._brdfLutTex = this.device.createTexture({
          size: [size, size], format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'IBLBrdfLUT',
        });
        lut = { tex: this._brdfLutTex, size, samples: 256 };
        this._brdfLutBaked = true;
      }
      cube = { tex: this._ensureSpecularCubeTex(baseSize, mips), baseSize, mipCount: mips, samples: 48 };
    }
    const shDst = diffuse ? this._iblUniformBuffer : null;
    gpu.bake({ sky, sunDir, shDst, cube, lut });
    if (diffuse && shDst) {
      this._iblEnabled = true; this._iblIntensity = intensity; this._shGpuOwned = true;
      this._iblData[36] = 1.0; this._iblData[37] = intensity;
    }
    if (specular) this._markSpecularBaked(mips);
    this._writeIBLBuffer();
  }

  private _runCpuSkyBake(sky: ProceduralSkyParams, sunDir: [number, number, number], intensity: number, diffuse: boolean, specular: boolean, baseSize: number): void {
    if (diffuse) this.setEnvironmentMap3D(bakeSkyEquirect(sky, sunDir) as unknown as ImageData, intensity);
    if (specular) this._bakeSpecularIBLCpu(sky, sunDir, baseSize);
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
    if (config.film)       Object.assign(pp.film,       config.film);
  }

  /** Return the current post-processing configuration (a live reference). */
  getPostProcessConfig(): PostProcessConfig {
    if (!this._postProcessPass) return defaultPostProcessConfig();
    return this._postProcessPass.config;
  }

  /**
   * Run post-process effects into an output texture.
   * Called by WebGPURenderer after passEncoder.end(), inside the same command encoder.
   * Returns the output GPUTexture (copy this to swapchain instead of srcTex), or null
   * if all effects are disabled (caller keeps using srcTex unchanged).
   */
  runPostProcess(encoder: GPUCommandEncoder, srcTex: GPUTexture, w: number, h: number): GPUTexture | null {
    // ANTI-ALIASING (persona-polish A1) runs FIRST, so bloom sees clean edges and film grain is never smeared. Only on
    // frames that actually drew 3D (a pure 2D doc keeps its own crisp vector AA) and never in the lo-res PS1 mode
    // (its chunky pixels are the look).
    let src = srcTex;
    const drew3D = this._drew3DThisFrame; this._drew3DThisFrame = false;
    // Temporal AA replaces FXAA on the frames it resolved; a capture that bypassed TAA gets FXAA in its place.
    const taaDone = this._taaOn && !!this._taa?.resolvedThisFrame;
    if ((this._aa.mode === 'fxaa' || this._taaBypassFxaa) && !taaDone && drew3D && (!this.getLoResSize(w, h) || this.loResIsDynamic()) && !(RD.on && RD.f.noFxaa)) {   // resolution scaling keeps FXAA (render debug: noFxaa skips it)
      this._fxaaPass ??= new FxaaPass(this.device, this._swapChainFormat);
      src = this._fxaaPass.run(encoder, srcTex, w, h, this._aa.quality);
    }
    const out = RD.on && RD.f.noPost ? null : this._postProcessPass?.run(encoder, src, w, h, this._worldTimeSec() % 3600) ?? null;   // time → film grain (render debug: noPost skips it)
    return out ?? (src !== srcTex ? src : null);
  }

  // ── Anti-aliasing (persona-polish A1) ──
  private _aa: AntiAliasingSettings = { ...DEFAULT_ANTI_ALIASING };
  private _fxaaPass: FxaaPass | null = null;
  /** Set by drawMeshes / drawSkinnedMeshes, consumed by runPostProcess (AA only on frames with 3D content). */
  private _drew3DThisFrame = false;
  /** 3D anti-aliasing: mode 'fxaa' (default, quality 'medium') or 'off' (the original, aliased look). */
  setAntiAliasing(s: Partial<AntiAliasingSettings>): void { this._aa = sanitizeAntiAliasing({ ...this._aa, ...s }); }
  get antiAliasing(): AntiAliasingSettings { return { ...this._aa }; }

  /** True while an OPAQUE focus background (armature / mesh-edit: wavy / solid / gradient — not 'dim' / 'none') is
   *  drawn behind the scene. That background is editor UI, so it must not be post-processed (restoreFocusBgAfterPost). */
  focusBgActive(): boolean {
    const opaque = (m: string) => m !== 'dim' && m !== 'none';
    if (this._armatureModeActive) return opaque(this._armatureBgOpts.mode);
    return this._meshEditBgActive && opaque(this._meshEditBgOpts.mode);
  }

  /** After post-processing + the copy to the screen: put the UNPROCESSED frame back wherever no 3D surface was drawn
   *  (the focus background), so bloom / grade / vignette / film only affect the scene. No-op without a focus bg. */
  restoreFocusBgAfterPost(encoder: GPUCommandEncoder, rawFrame: GPUTexture, target: GPUTextureView, depthView: GPUTextureView): void {
    if (!this.focusBgActive() || !this._postBgKeepPass || (RD.on && (RD.f.noBackground3D || RD.f.noPostBgKeep))) return;
    this._postBgKeepPass.run(encoder, rawFrame, target, depthView);
  }

  /** True if any always-on-top overlay (info card) was captured this frame and needs a post-process-immune draw. */
  hasPostOverlays(): boolean {
    return this._postOverlayEntries.length > 0 && !!this.meshBindGroup;
  }

  /** Drop any captured overlays (call when a frame draws no meshes, so a stale card can't reference dead slots). */
  clearPostOverlays(): void {
    this._postOverlayEntries.length = 0;
  }

  /**
   * Push a live update of ONLY these billboard meshes' instance slots (face-camera matrix from
   * billboardScale/billboardSpinY + the material opacity) straight to the GPU, WITHOUT marking them dirty. This is
   * the info-card intro's fast lane: animating grow/spin/fade by dirtying the (billboard) card would bail the
   * transforms fast-path into a FULL instance repack every frame — re-sorting + re-uploading the whole ~40MB buffer
   * (the 60→40fps drop). Here we patch just the card + pill slots, so drawMeshes early-returns and the frame is cheap.
   * A no-op for a mesh whose slot isn't assigned yet (a full repack places it first); computes the SAME matrix as
   * writeSlot, so it's consistent if a repack does happen (e.g. the camera moved that frame).
   */
  refreshBillboards(meshes: Mesh3D[]): void {
    const buf = this._instanceDataBuf, gpu = this.instanceStorageBuffer;
    if (!buf || !gpu) return;
    const fpi = MESH_INSTANCE_STRIDE / 4;
    const vm = this.camera.getViewMatrix() as Float32Array;
    for (let _km = 0; _km < meshes.length; _km++) { const m = meshes[_km];
      const slot = this._meshInstanceSlots.get(m.id);
      if (slot === undefined) continue;   // not placed yet → a full repack will do it
      const offset = slot * fpi;
      if (m.billboardParent) {
        const p = m.billboardParent, plm = p.localMatrix as Float32Array, pbs = p.billboardScale;
        const psx = Math.hypot(plm[0], plm[1], plm[2]) * pbs, psy = Math.hypot(plm[4], plm[5], plm[6]) * pbs, psz = Math.hypot(plm[8], plm[9], plm[10]) * pbs;
        let rx = vm[0], ry = vm[4], rz = vm[8], bx = vm[2], by = vm[6], bz = vm[10];
        const spin = p.billboardSpinY;
        if (spin !== 0) { const ct = Math.cos(spin), st = Math.sin(spin); const nrx = rx * ct + bx * st, nry = ry * ct + by * st, nrz = rz * ct + bz * st; bx = -rx * st + bx * ct; by = -ry * st + by * ct; bz = -rz * st + bz * ct; rx = nrx; ry = nry; rz = nrz; }
        const ux = vm[1], uy = vm[5], uz = vm[9], ox = m.billboardOffset[0], oy = m.billboardOffset[1], oz = m.billboardOffset[2];
        buf[offset] = rx * psx; buf[offset + 1] = ry * psx; buf[offset + 2] = rz * psx; buf[offset + 3] = 0;
        buf[offset + 4] = ux * psy; buf[offset + 5] = uy * psy; buf[offset + 6] = uz * psy; buf[offset + 7] = 0;
        buf[offset + 8] = bx * psz; buf[offset + 9] = by * psz; buf[offset + 10] = bz * psz; buf[offset + 11] = 0;
        buf[offset + 12] = plm[12] + rx * psx * ox + ux * psy * oy + bx * psz * oz;
        buf[offset + 13] = plm[13] + ry * psx * ox + uy * psy * oy + by * psz * oz;
        buf[offset + 14] = plm[14] + rz * psx * ox + uz * psy * oy + bz * psz * oz;
        buf[offset + 15] = 1;
      } else if (m.billboard) {
        const lmx = m.localMatrix as Float32Array, bs = m.billboardScale;
        const sx = Math.hypot(lmx[0], lmx[1], lmx[2]) * bs, sy = Math.hypot(lmx[4], lmx[5], lmx[6]) * bs, sz = Math.hypot(lmx[8], lmx[9], lmx[10]) * bs;
        let rx = vm[0], ry = vm[4], rz = vm[8], bx = vm[2], by = vm[6], bz = vm[10];
        const spinY = m.billboardSpinY;
        if (spinY !== 0) { const ct = Math.cos(spinY), st = Math.sin(spinY); const nrx = rx * ct + bx * st, nry = ry * ct + by * st, nrz = rz * ct + bz * st; bx = -rx * st + bx * ct; by = -ry * st + by * ct; bz = -rz * st + bz * ct; rx = nrx; ry = nry; rz = nrz; }
        buf[offset] = rx * sx; buf[offset + 1] = ry * sx; buf[offset + 2] = rz * sx; buf[offset + 3] = 0;
        buf[offset + 4] = vm[1] * sy; buf[offset + 5] = vm[5] * sy; buf[offset + 6] = vm[9] * sy; buf[offset + 7] = 0;
        buf[offset + 8] = bx * sz; buf[offset + 9] = by * sz; buf[offset + 10] = bz * sz; buf[offset + 11] = 0;
        buf[offset + 12] = lmx[12]; buf[offset + 13] = lmx[13]; buf[offset + 14] = lmx[14]; buf[offset + 15] = 1;
      } else continue;
      buf[offset + 35] = m.material.opacity;   // fade
      this.device.queue.writeBuffer(gpu, slot * MESH_INSTANCE_STRIDE, buf, offset, fpi);
    }
  }

  /**
   * Draw the always-on-top overlay meshes (the landmark info card) in a standalone COLOR-ONLY pass onto `targetView`.
   * Called by WebGPURenderer AFTER runPostProcess + the swapchain copy, so the card is composited over the final,
   * already-post-processed image — it bypasses bloom / colour-grade / vignette and stays crisp day & night. Reuses
   * this frame's mesh bind group + instance buffer + geometry allocations (all still valid within the frame).
   */
  drawPostOverlays(encoder: GPUCommandEncoder, targetView: GPUTextureView, depthView: GPUTextureView): void {
    if (!this.hasPostOverlays()) return;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: rdColorLoad(), storeOp: 'store' }],   // ('load'; render debug clearColorLoads → 'clear')
      // Depth is CLEARED here (not loaded) so nothing in the scene occludes the card; it exists only so a 3D
      // extruded card self-occludes correctly (front face over back while it spins). Reuses the scene depth texture.
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear', depthClearValue: 1.0, depthStoreOp: 'store',
        stencilLoadOp: 'clear', stencilClearValue: 0, stencilStoreOp: 'store',
      },
    });
    const poSplit = shaderSplitActive();
    const postOverlayPipe = poSplit ? null : this.pipeline.postOverlayTexturedPipeline;
    if (!poSplit && !postOverlayPipe) { pass.end(); return; }   // P2: still compiling → the card appears a frame later
    if (postOverlayPipe) pass.setPipeline(postOverlayPipe);
    pass.setBindGroup(0, this.meshBindGroup!);
    const sharedIB = this._geomIB!;
    let poCur: GPURenderPipeline | null = null;
    for (const { mesh, idx } of this._postOverlayEntries) {
      const alloc = this._geomAllocs.get(mesh.id); if (!alloc || alloc.pk) continue;   // (P22: info cards are never packed world geometry)
      if (poSplit) {
        // SHADER SPLIT: the post-overlay axis (the textured FULL shader today: the slot key with tex = true)
        const pk = this._slotKey(idx, true);
        const p = pk >= 0 ? this._splitPipe(pk, 'postOverlay', false) : this.pipeline.postOverlayTexturedPipeline;
        if (!p) continue;   // held: the card appears once its shader lands
        if (p !== poCur) { pass.setPipeline(p); poCur = p; }
      }
      const override = this._vertexBufferOverrides.get(mesh.id);
      pass.setBindGroup(1, this.createTextureBindGroup(mesh));
      pass.setVertexBuffer(0, override ?? this._geomVB!);
      pass.setIndexBuffer(sharedIB, 'uint32');
      pass.drawIndexed(alloc.indexCount, 1, alloc.firstIndex, override ? 0 : alloc.baseVertex, idx);
    }
    pass.end();
  }

  // ── SSAO ───────────────────────────────────────────────────────
  /** Enable/disable SSAO and tune its params. Off (default) allocates nothing and runs no passes. */
  setSSAO(on: boolean, cfg?: Partial<SSAOConfig>): void {
    // ssaoConfig.enabled keeps the AUTHORED value (it is saved); the device cap only gates the pass (CRASH-8)
    this._ssaoEnabled = on && Renderer3D.caps.ssao;
    this._ssaoConfig.enabled = on;
    if (cfg) Object.assign(this._ssaoConfig, cfg, { enabled: on });
    if (this._ssaoEnabled && !this._ssao) this._ssao = new SSAOPass(this.device, this._swapChainFormat);
    if (this._ssao) Object.assign(this._ssao.config, this._ssaoConfig);
  }
  /** Render the raw AO buffer to screen (verification) — draws over the scene while on. */
  setSSAODebug(on: boolean): void { this._ssaoDebug = on; }

  /** Ensure the shared 1×1-white AO texture + linear sampler exist (bound at group 0 binding 3/4 always). */
  private _ensureAOBindResources(): void {
    if (!this._ssaoWhiteTex) {
      this._ssaoWhiteTex = this.device.createTexture({ size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'SSAOWhite' });
      this.device.queue.writeTexture({ texture: this._ssaoWhiteTex }, new Uint8Array([255]), { bytesPerRow: 1, rowsPerImage: 1 }, [1, 1, 1]);
    }
    if (!this._ssaoAOSampler) {
      this._ssaoAOSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', label: 'SSAOAOSampler' });
    }
  }
  /** The AO texture to bind in the mesh group: the real AO buffer when SSAO is on + ready, else 1×1 white. */
  private _aoBindTexture(): GPUTexture {
    this._ensureAOBindResources();
    if (this._ssaoEnabled && this._ssao) {
      const t = this._ssao.aoBlurTexture();
      if (t) return t;
    }
    return this._ssaoWhiteTex!;
  }
  get ssaoConfig(): SSAOConfig { return { ...this._ssaoConfig }; }
  get ssaoEnabled(): boolean { return this._ssaoConfig.enabled; }
  get ssaoDebug(): boolean { return this._ssaoDebug; }

  /** Ensure the 1×1 scene-color fallback + its sampler exist (bound at group 0 binding 5/6 when no grab is set). */
  private _ensureSceneColorResources(): void {
    if (!this._sceneColorDefaultTex) {
      this._sceneColorDefaultTex = this.device.createTexture({ size: [1, 1], format: this._swapChainFormat, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'SceneColorDefault' });
      this.device.queue.writeTexture({ texture: this._sceneColorDefaultTex }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 1]);
    }
    if (!this._sceneColorSampler) {
      this._sceneColorSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', label: 'SceneColorSampler' });
    }
  }
  /** The scene-color texture to bind in the mesh group: the live grab (prev frame) when set, else the 1×1 default. */
  private _sceneColorBindTexture(): GPUTexture {
    this._ensureSceneColorResources();
    if (RD.on && (RD.f.noSceneGrab || RD.f.directToSwapchain)) return this._sceneColorDefaultTex!;   // render debug: no grab (the bind-group cache sees the change)
    return this._sceneColorGrabTex ?? this._sceneColorDefaultTex!;
  }
  /** webgpu-renderer hands us the previous-frame color grab; a change invalidates the cached mesh bind group. */
  setSceneColorGrabTexture(tex: GPUTexture | null): void {
    if (this._sceneColorGrabTex === tex) return;
    this._sceneColorGrabTex = tex;
    this._meshBindGroupSceneTex = null;   // force meshBindGroup rebuild with the new view
  }

  // ── Prefiltered specular IBL (P1b) ─────────────────────────────────────────
  /** Ensure the dummy cube, the (baked-once) BRDF LUT, and the shared IBL sampler exist. */
  private _ensureSpecularIBLResources(): void {
    if (!this._dummyCubeTex) {
      this._dummyCubeTex = this.device.createTexture({
        size: [1, 1, 6], format: 'rgba8unorm', dimension: '2d',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'IBLDummyCube',
      });
      // Fill all 6 faces with mid-grey so an accidental sample is neutral, never black/undefined.
      for (let f = 0; f < 6; f++) {
        this.device.queue.writeTexture({ texture: this._dummyCubeTex, origin: [0, 0, f] }, new Uint8Array([128, 128, 128, 255]), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 1]);
      }
    }
    if (!this._brdfLutTex) {
      // Cheap 1×1 placeholder — the real 128² LUT (~4M-iteration bake) is deferred to the first bakeSpecularIBL so
      // scenes that never use procedural specular pay nothing. Binding 9 is never SAMPLED while specular is off.
      this._brdfLutTex = this.device.createTexture({
        size: [1, 1], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'IBLBrdfLUTPlaceholder',
      });
      this.device.queue.writeTexture({ texture: this._brdfLutTex }, new Uint8Array([255, 0, 0, 255]), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 1]);
    }
    if (!this._iblCubeSampler) {
      this._iblCubeSampler = this.device.createSampler({
        magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge', label: 'IBLCubeSampler',
      });
    }
  }
  /** The cube texture to bind at group 0 binding 7: the real prefiltered sky when baked, else the 1×1×6 dummy. */
  private _specularCubeBindTexture(): GPUTexture {
    this._ensureSpecularIBLResources();
    return this._prefilteredCubeTex ?? this._dummyCubeTex!;
  }

  /** Enable/disable screen-space reflections. Turning it on ensures the SSAO pass exists (SSR reuses its world-pos
   *  prepass) and invalidates the mesh bind groups so the world-pos buffer gets bound. The mesh shader only samples it
   *  when its `ssrEnabled` uniform flag is set — so this is inert until Stage 2 wires the flag. */
  setSSREnabled(on: boolean): void {
    this._ssrWanted = on;
    on = on && Renderer3D.caps.ssr;   // the device cap (CRASH-8); the authored value lives in the environment state
    this._iblData[41] = on ? 1 : 0;   // the shader's ssrEnabled flag (safe to rewrite even if unchanged)
    this._writeIBLBuffer();
    if (this._ssrEnabled === on) return;
    this._ssrEnabled = on;
    if (on && !this._ssao) this._ssao = new SSAOPass(this.device, this._swapChainFormat);
    this._meshBindGroupWorldPosTex = null;   // rebind the real world-pos buffer (or dummy)
    this._skinnedMeshBG = null;
  }
  get ssrEnabled(): boolean { return this._ssrEnabled; }

  /** Set the SSR ray-march tuning (max steps, world step length, hit thickness, intensity 0..1, roughness cutoff,
   *  fill blur/feather texels, WORLD reach, silhouette-shadow opacity). maxSteps is only the pre-first-frame
   *  baseline — the per-frame zoom-stable budget derived from reachWorld overwrites it (see _updateSSRReachBudget). */
  setSSRParams(maxSteps: number, stride: number, thickness: number, intensity: number, maxRoughness: number, fillBlur = 2, edgeFeather = 2, reachWorld = 12.8, fallbackShadow = 0.35): void {
    this._iblData[42] = Math.max(1, maxSteps);
    this._iblData[43] = Math.max(0.001, stride);
    this._iblData[44] = Math.max(0, thickness);
    this._iblData[45] = Math.max(0, intensity);
    this._iblData[46] = Math.max(0, maxRoughness);
    this._iblData[48] = Math.max(0, Math.min(8, fillBlur));
    this._iblData[49] = Math.max(0, Math.min(8, edgeFeather));
    this._iblData[51] = Math.max(0, Math.min(1, fallbackShadow));
    this._ssrReachWorld = Math.max(1, Math.min(64, reachWorld));
    this._writeIBLBuffer();
  }

  /** #2 ZOOM-STABLE REACH: convert the persisted WORLD reach into a texel budget for the CURRENT zoom, capped for
   *  cost (the march is per reflective fragment). Called once per frame while SSR is on — cheap, writes only on
   *  change. Ortho uses the frustum height; perspective uses the eye→target distance as the focus depth. */
  private _updateSSRReachBudget(canvasH: number): void {
    const cam = this.camera;
    let worldPerPixel: number;
    if (cam.mode === 'orthographic') {
      worldPerPixel = (cam.orthoSize * 2) / Math.max(1, canvasH);
    } else {
      const cp = cam.position, ct = cam.target;
      const d = Math.max(0.1, Math.hypot(cp[0] - ct[0], cp[1] - ct[1], cp[2] - ct[2]));
      worldPerPixel = (2 * d * Math.tan(cam.fov / 2)) / Math.max(1, canvasH);
    }
    const worldPerTexel = worldPerPixel * 2;   // the world-pos buffer is half-res
    const eff = Math.max(32, Math.min(384, Math.ceil(this._ssrReachWorld / Math.max(worldPerTexel, 1e-6))));
    if (this._iblData[42] !== eff) { this._iblData[42] = eff; this._writeIBLBuffer(); }
  }
  /** SSR DEBUG: when on, reflective fragments show the ray-HIT UV (red=u, green=v) instead of the reflected colour —
   *  makes the reflection mapping visible so a sign/direction bug is obvious. */
  setSSRDebug(on: boolean): void { this._iblData[47] = on ? 1 : 0; this._writeIBLBuffer(); }

  /** ENGINE ESCAPE HATCH (debug/A-B only — not persisted, no host UI): toggle the depth-peeled backface-fill.
   *  ON (default): a second prepass renders the SECOND-nearest surface and the fill requires proven volume
   *  membership — exact silhouettes, no skimmer trails, angle/scale independent. OFF: single-layer thickness
   *  heuristic (the pre-peel behaviour — solid fills + faint trails). */
  setSSRDepthPeeling(on: boolean): void {
    this._iblData[50] = on ? 1 : 0;
    this._writeIBLBuffer();
    if (this._ssrDepthPeel === on) return;
    this._ssrDepthPeel = on;
    this._meshBindGroupWorldPosBackTex = null;   // rebind the back layer (or dummy)
    this._skinnedMeshBG = null;
  }
  get ssrDepthPeeling(): boolean { return this._ssrDepthPeel; }

  /** ENGINE ESCAPE HATCH (debug/A-B only — not persisted, no host UI): toggle the DEFERRED SSR resolve pass.
   *  ON (default): reflections trace once per half-res texel in a dedicated pass; the mesh FS samples the
   *  result. OFF: the pre-3b inline per-fragment trace (identical algorithm, higher cost). */
  setSSRDeferred(on: boolean): void {
    this._iblData[52] = on ? 1 : 0;
    this._writeIBLBuffer();
    if (this._ssrDeferred === on) return;
    this._ssrDeferred = on;
    this._meshBindGroupReflectionTex = null;   // rebind the reflection texture (or dummy)
    this._skinnedMeshBG = null;
  }
  get ssrDeferred(): boolean { return this._ssrDeferred; }

  /** Advance + read the world clock (seconds). Scaled by setWorldSpeed — 0 freezes shader time in place. */
  private _worldTimeSec(): number {
    const now = performance.now();
    this._worldTimeAccMs += (now - this._worldTimeLast) * this._worldSpeed;
    this._worldTimeLast = now;
    return this._worldTimeAccMs / 1000;
  }
  /** UI System world control: scale world time (1 = normal, 0 = frozen). */
  setWorldSpeed(speed: number): void {
    this._worldTimeSec();               // bank elapsed time at the OLD speed first
    this._worldSpeed = Math.max(0, speed);
  }
  get worldSpeed(): number { return this._worldSpeed; }
  /** UI System setCamera effect: move the eye/target directly (the orbit controller re-syncs on next input). */
  uiSetCamera(position?: [number, number, number], target?: [number, number, number]): void {
    // The position/target SETTERS copy + mark the view dirty (assigning components directly would not).
    if (position) { this.camera.position = position as unknown as import('gl-matrix').vec3; }
    if (target) { this.camera.target = target as unknown as import('gl-matrix').vec3; }
  }
  /** Current eye/target as plain tuples (tween bookkeeping in the scene3d manager). */
  uiGetCamera(): { position: [number, number, number]; target: [number, number, number] } {
    const p = this.camera.position, t = this.camera.target;
    return { position: [p[0], p[1], p[2]], target: [t[0], t[1], t[2]] };
  }

  /** The world-position texture to bind at group 0 binding 10: the real prepass buffer when SSR (or SSAO) has run it,
   *  else a 1×1 rgba32float dummy so the layout is always satisfied. */
  private _worldPosBindTexture(): GPUTexture {
    if (!this._dummyWorldPosTex) {
      this._dummyWorldPosTex = this.device.createTexture({
        size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'SSRWorldPosDummy',
      });
      this.device.queue.writeTexture({ texture: this._dummyWorldPosTex }, new Float32Array([0, 0, 0, 0]), { bytesPerRow: 16, rowsPerImage: 1 }, [1, 1, 1]);
    }
    const real = (this._ssrEnabled || this._ssaoEnabled) ? this._ssao?.worldPosTexture() : null;
    return real ?? this._dummyWorldPosTex;
  }

  /** The depth-peel BACK layer to bind at group 0 binding 11: the real second-surface buffer when the peel pass
   *  runs (SSR + depth peeling on), else the shared 1×1 dummy (.w=0 -> the shader's shell fallback engages). */
  private _worldPosBackBindTexture(): GPUTexture {
    const real = (this._ssrEnabled && this._ssrDepthPeel) ? this._ssao?.worldPosBackTexture() : null;
    return real ?? this._dummyWorldPosTex!;   // _worldPosBindTexture() created the dummy just above
  }

  private _ensureDummyHalfFloat(): GPUTexture {
    if (!this._dummyHalfFloatTex) {
      this._dummyHalfFloatTex = this.device.createTexture({
        size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'SSRHalfFloatDummy',
      });
    }
    return this._dummyHalfFloatTex;
  }
  /** Binding 12: the prepass NORMAL+material target when the prepass runs, else a 1×1 dummy. */
  private _normalBindTexture(): GPUTexture {
    const real = (this._ssrEnabled || this._ssaoEnabled) ? this._ssao?.normalTexture() : null;
    return real ?? this._ensureDummyHalfFloat();
  }
  /** Binding 13: the deferred-SSR REFLECTION texture when the resolve pass runs, else a 1×1 dummy. */
  private _reflectionBindTexture(): GPUTexture {
    const real = (this._ssrEnabled && this._ssrDeferred) ? this._ssao?.reflectionTexture() : null;
    return real ?? this._ensureDummyHalfFloat();
  }
  /** Binding 14: the PLANAR mirror pass result when a reflector is active, else a 1×1 dummy. */
  private _planarBindTexture(): GPUTexture {
    return (this._planarActive && this._planarTex) ? this._planarTex : this._ensureDummyHalfFloat();
  }

  /**
   * Bake the procedural sky into the prefiltered specular cubemap (CPU-side, reusing the tested split-sum bake) and
   * turn on crisp cubemap specular. Event-driven — call when the sky/sun changes, NOT per frame. `sunDir` points
   * toward the sun. Pairs with the SH-diffuse `setEnvironmentMap3D` (call both to drive lighting + reflections from
   * one sky). See docs/specs/environment-and-reflections.md (P1b).
   */
  bakeSpecularIBL(sky: ProceduralSkyParams, sunDir: [number, number, number], baseSize = 32): void {
    this.bakeSkyLighting(sky, sunDir, this._iblIntensity, { diffuse: false, specular: true, baseSize });   // P4.1: GPU when available
  }

  /** CPU reference for the specular cube + BRDF LUT (the P4.1 fallback). */
  private _bakeSpecularIBLCpu(sky: ProceduralSkyParams, sunDir: [number, number, number], baseSize = 32): void {
    this._ensureSpecularIBLResources();
    // Bake the real 128² split-sum BRDF LUT once, on first use (it's environment-independent, so never re-baked).
    if (!this._brdfLutBaked) {
      const size = 128;
      this._brdfLutTex!.destroy();   // drop the 1×1 placeholder
      this._brdfLutTex = this.device.createTexture({
        size: [size, size], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'IBLBrdfLUT',
      });
      this.device.queue.writeTexture({ texture: this._brdfLutTex }, bakeBRDFLUTBytes(size, 256), { bytesPerRow: size * 4, rowsPerImage: size }, [size, size, 1]);
      this._brdfLutBaked = true;
    }
    const mips = cubeMipCount(baseSize);
    const baked = bakePrefilteredCube(sky, sunDir, baseSize, mips, 48);
    this._ensureSpecularCubeTex(baseSize, mips);   // (re)create if the size/mip layout changed
    for (const b of baked) {
      this.device.queue.writeTexture(
        { texture: this._prefilteredCubeTex!, mipLevel: b.mip, origin: [0, 0, b.face] },
        b.data, { bytesPerRow: b.size * 4, rowsPerImage: b.size }, [b.size, b.size, 1],
      );
    }
    this._markSpecularBaked(mips);
    this._writeIBLBuffer();
  }

  /** Turn off cubemap specular (revert to the soft SH-probe reflection). Keeps the SH diffuse untouched. */
  clearSpecularIBL(): void {
    if (this._pendingSkyBake) this._pendingSkyBake.specular = false;
    if (this._prefilteredCubeTex) { this._prefilteredCubeTex.destroy(); this._prefilteredCubeTex = null; }
    this._iblData[38] = 0.0;
    this._writeIBLBuffer();
    this._meshBindGroupCubeTex = null;
    this._skinnedMeshBG = null;
  }

  // ── Lo-fi render buffer ────────────────────────────────────────

  /**
   * Compute the lo-res render dimensions from the current PS1Config.
   * Returns [w, h] when lo-res is active, null when full-res should be used.
   */
  getLoResSize(canvasW: number, canvasH: number): [number, number] | null {
    if (RD.on && RD.f.forceFullRes) return null;   // render debug: native resolution (the host also bypasses TAA + scaling)
    const sz = this._loResSizeRaw(canvasW, canvasH);
    if (!sz) return null;
    // P2: take the lo-res path only once its blit pipeline compiled — until then render full-res (never a blank frame).
    this._loFiPass ??= new LoFiPass(this.device, this._swapChainFormat);
    return this._loFiPass.ready() ? sz : null;
  }
  private _loResSizeRaw(canvasW: number, canvasH: number): [number, number] | null {
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
    // RESOLUTION SCALING (setUserResolutionScale, docs/ui/performance.md) rides the same path; the lower of the two wins.
    // TEMPORAL AA / UPSCALING (temporal-aa.ts) rides the same path, at full size for 'taa' (the scale already folds in
    // the two scales above).
    if (this._taaOn) {
      const s = this._taaScale;
      return [Math.max(1, Math.round(canvasW * s)), Math.max(1, Math.round(canvasH * s))];
    }
    const ds = Math.min(this._dynResScale, this._userResScale);
    if (ds < 1) {
      return [Math.max(1, Math.round(canvasW * ds)), Math.max(1, Math.round(canvasH * ds))];
    }
    return null;
  }

  private _userResScale = 1;
  /** RESOLUTION SCALING (the host's off / fixed / auto setting, driven by WebGPURenderer's ResolutionScaler): the 3D
   *  scene renders at this fraction of the canvas (0.25..1) and is upscaled with the sharpened filter. The UI, gizmos
   *  and text stay full size. Independent of the city's pan-time setDynamicResScale; the lower one applies. */
  setUserResolutionScale(s: number): void { this._userResScale = Math.min(1, Math.max(0.25, s || 1)); }
  /** The scale the 3D scene renders at this frame from the dynamic paths (1 = native; PS1 lo-res not counted). */
  get dynamicResolutionScale(): number { return this._ps1LoResConfigured() ? 1 : this._taaOn ? this._taaScale : Math.min(this._dynResScale, this._userResScale); }
  /** True when the lo-res path is a perf trick (resolution scaling / pan-time scale), not the PS1 look. That path
   *  upsamples depth into the main pass, so overlays, FXAA and the focus-background restore run as on the native path. */
  loResIsDynamic(): boolean { return !this._ps1LoResConfigured() && (this._taaOn || Math.min(this._dynResScale, this._userResScale) < 1); }
  private _ps1LoResConfigured(): boolean {
    const { renderResolution, renderScale } = this._ps1;
    return !!(renderResolution && renderResolution[0] > 0 && renderResolution[1] > 0) || !!(renderScale && renderScale > 0 && renderScale < 1);
  }

  private _dynResScale = 1;
  /** Dynamic-resolution scale (0.25–1). <1 routes 3D through the lo-res buffer with a LINEAR (smooth) upscale —
   *  the "drop render scale while the camera moves" trick. 1 restores native rendering. No-op while a PS1 lo-res
   *  config is active (that path already renders lo-res, deliberately chunky). */
  /** The camera-motion (pan-time) scale in force now (1 = off). */
  get motionResolutionScale(): number { return this._dynResScale; }
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
    this._loFiPass.linearFilter = !ps1LoRes && (this._taaOn || Math.min(this._dynResScale, this._userResScale) < 1);
    this._loFiPass.sharpen = this._loFiPass.linearFilter;   // resolution scaling: sharpened bicubic upscale
    if (this._taaOn) this._taaBeginScene(w, h);   // temporal AA: jitter the camera while the scene records
    return this._loFiPass.beginRenderPass(encoder, w, h, clearColor);
  }

  /**
   * Blit the lo-res 3D result into the active main render pass using nearest-neighbor upscaling.
   * Call this after the lo-res pass has ended, while the main pass is active.
   */
  blitLowResToPass(pass: GPURenderPassEncoder): void {
    if (this._taaOn && this._taa?.blit(pass, this._taaSet.sharpen)) return;   // temporal AA: the resolved frame
    this._loFiPass?.blitToRenderPass(pass);
  }
  /** Resolution scaling: copy the lo-res scene depth into `pass`'s (full-size) depth attachment. False = not ready
   *  (the caller then draws the overlays inline in the lo-res pass, the old behaviour). */
  blitLowResDepthToPass(pass: GPURenderPassEncoder): boolean { return this._loFiPass?.blitDepthToRenderPass(pass) ?? false; }
  /** Resolution scaling: true when the depth upsample is compiled (decided BEFORE the lo-res pass records). */
  lowResDepthBlitReady(): boolean { return this._loFiPass?.depthBlitReady() ?? false; }

  // ── Temporal AA / upscaling (engine-roadmap step 6; temporal-aa.ts, docs/ui/performance.md) ──────────────────────
  /** Per frame, before the 3D pass (WebGPURenderer): the host's setting, whether this frame must render natively
   *  (`bypass`: captures / exports / snapshot holds) and whether resolution scaling (Fixed / Auto) picks the scale. */
  setTemporalFrame(s: TemporalAASettings, bypass: boolean, scalerActive: boolean): void {
    const wasOn = this._taaOn;
    this._taaSet = s;
    let reason: TemporalAAReason = 'ok';
    if (s.mode === 'off' || !Renderer3D.caps.taa) reason = 'off';   // (the device cap: the preference itself is kept)
    else if (bypass) reason = 'capture';
    else if (this._ps1LoResConfigured() || (s.retroOff && this._taaRetroLook())) reason = 'retro';   // the PS1 lo-res look always wins
    else if (s.inkOff && this.outlineEnabled) reason = 'ink';
    else {
      this._loFiPass ??= new LoFiPass(this.device, this._swapChainFormat);
      this._taa ??= new TemporalAAPass(this.device, this._swapChainFormat, MESH3D_VERTEX_STRIDE, SKINNED_MESH3D_VERTEX_STRIDE);
      if (!this._taa.ready() || !this._loFiPass.ready() || !this._loFiPass.depthBlitReady()) reason = 'compiling';
    }
    this._taaOn = reason === 'ok';
    this._taaReason = reason;
    this._taaBypassFxaa = reason === 'capture';
    if (!this._taaOn && wasOn) this.resetTemporalHistory();
    this._taaScale = this._taaOn ? temporalRenderScale(s, this._userResScale, this._dynResScale, scalerActive) : 1;
  }
  /** Drop the temporal history (the next TAA frame starts from the spatial reconstruction). */
  resetTemporalHistory(): void { this._taa?.resetHistory(); this._taaHasPrev = false; }
  /** True while this frame renders through the TAA path. */
  get temporalActive(): boolean { return this._taaOn; }
  /** What the last TAA decision was (getTemporalAA3D). */
  getTemporalStatus(): { active: boolean; reason: TemporalAAReason; renderScale: number; samples: number; velocityDraws: number } {
    return { active: this._taaOn, reason: this._taaReason, renderScale: this._taaOn ? this._taaScale : 1, samples: temporalSamples(this._taaSet.mode), velocityDraws: this._taaVelDraws };
  }
  /** Retro looks that TAA would wash out (vertex snap, ordered dither, global colour quantisation, UV snap). */
  private _taaRetroLook(): boolean {
    const p = this._ps1;
    return (p.vertexJitter > 0 && p.snapGridSize > 0) || (!!p.dither && (p.ditherStrength ?? 0.5) > 0)
      || (p.colorDepth > 0 && p.colorScope !== 'optIn') || (!!p.uvQuantize && (p.uvQuantizeSteps ?? 64) > 0);
  }
  /** Start the jittered scene (beginLowResRenderPass, TAA frames only). */
  private _taaBeginScene(w: number, h: number): void {
    this._taa!.beginFrame();
    this._taaFrameNo++;
    temporalJitter(this._taaFrameNo, temporalSamples(this._taaSet.mode), this._taaJit);
    jitterToNdc(this._taaJit[0], this._taaJit[1], w, h, this._taaJitNdc);
    this._taaDither = temporalDitherShift(this._taaFrameNo);
    this.camera.aspect = w / h;
    this.camera.setProjectionJitter(this._taaJitNdc[0], this._taaJitNdc[1]);
    this._taaVelOn = true;
    this._taaMoverN = 0;
  }
  /** Transforms fast path (TAA frames): `m`'s slot is about to be rewritten; keep the matrix shown last frame. */
  private _taaNoteMove(m: Mesh3D, slot: number, offset: number, sub: number): void {
    if (this._taaMoverN >= 4096) return;
    let r = this._taaMovers[this._taaMoverN];
    if (!r) { r = { m, slot, sub, prev: new Float32Array(16) }; this._taaMovers.push(r); }
    r.m = m; r.slot = slot; r.sub = sub;
    r.prev.set(this._instanceDataBuf!.subarray(offset, offset + 16));
    this._taaMoverN++;
  }
  /**
   * End the jittered scene (the host calls this right after the lo-res pass ends, on the same encoder): un-jitter the
   * camera (the overlays draw crisp), then record the velocity pass and the full-size resolve. No-op off the TAA path.
   */
  endLowResScene(enc: GPUCommandEncoder, outW: number, outH: number): void {
    if (!this._taaOn) return;
    // The jittered view-projection the scene used (the camera still holds the jitter), then the unjittered one.
    this._taaJitVP.set(this.camera.getViewProjectionMatrix() as Float32Array);
    this.camera.setProjectionJitter(0, 0);
    this._taaVelOn = false;
    const taa = this._taa, lo = this._loFiPass;
    const colorTex = lo?.colorTexture, depthTex = lo?.depthTexture;
    if (!taa || !lo || !colorTex || !depthTex) { this._taaMoverN = 0; return; }
    unjitterViewProj(this._taaCurVP, this._taaJitVP, this._taaJitNdc[0], this._taaJitNdc[1]);
    if (!invert4(this._taaInvVP, this._taaCurVP)) { this.resetTemporalHistory(); this._taaMoverN = 0; return; }
    let valid = this._taaHasPrev;
    if (valid && isCameraCut(this._taaPrevVP, this._taaInvVP)) valid = false;
    const prevVP = valid ? this._taaPrevVP : this._taaCurVP;
    const w = lo.width, h = lo.height, dMin = this.sceneDepthRangeMin();
    this._taaBuildVelocityDraws();
    this._taaVelDraws = taa.recordVelocity(enc, lo.depthView!, w, h, dMin, this._taaJitVP, this._taaCurVP, prevVP, this._taaRigid, this._taaSkin);
    this._taaAfterVelocity();
    const up = this._taaSet.mode === 'taau' && this._taaScale < 0.999;
    taa.recordResolve(enc, colorTex, depthTex, {
      invVP: this._taaInvVP, prevVP, curVP: this._taaCurVP, loW: w, loH: h, outW, outH,
      jitterX: this._taaJit[0], jitterY: this._taaJit[1], depthMin: dMin, ortho: this.camera.mode === 'orthographic',
      historyValid: valid, blend: up ? 0.06 : 0.07, motionBlend: 0.2, gamma: 1.25, depthTol: 0.03,
    });
    this._taaPrevVP.set(this._taaCurVP);
    this._taaHasPrev = true;
    if ((this._taaFrameNo & 63) === 0) taa.pruneSkins();
  }
  /** The velocity pass's draw lists: this frame's movers (rigid) and visible skinned parts. */
  private _taaBuildVelocityDraws(): void {
    const rigid = this._taaRigid, sk = this._taaSkin;
    let nr = 0, ns = 0;
    const data = this._instanceDataBuf, vbPool = this._geomVB, ib = this._geomIB, fpi = MESH_INSTANCE_STRIDE / 4;
    if (data && vbPool && ib) {
      for (let i = 0; i < this._taaMoverN; i++) {
        const r = this._taaMovers[i], m = r.m;
        if (!m || !m.visible || m.lodHidden || m.material.opacity < 1) continue;
        const alloc = this._geomAllocs.get(m.id);
        if (!alloc || alloc.pk) continue;   // (P22: movers are never packed; a packed mesh keeps the camera velocity)
        const sub = r.sub >= 0 ? m.submeshes[r.sub] : undefined;
        if (r.sub >= 0 && !sub) continue;
        const override = this._vertexBufferOverrides.get(m.id);
        const o = r.slot * fpi;
        let d = rigid[nr];
        if (!d) { d = { vb: vbPool, ib, indexCount: 0, firstIndex: 0, baseVertex: 0, cur: data, prev: r.prev }; rigid.push(d); }
        d.vb = override ?? vbPool; d.ib = ib;
        d.indexCount = sub ? sub.indexCount : alloc.indexCount;
        d.firstIndex = alloc.firstIndex + (sub ? sub.indexOffset : 0);
        d.baseVertex = override ? 0 : alloc.baseVertex;
        d.cur = data.subarray(o, o + 16); d.prev = r.prev;
        nr++;
      }
    }
    rigid.length = nr;
    if (this._taaSkinFrame === this._taaFrameNo && this._skinnedInstData) {
      const vis = this._skinnedVisibleScratch, flags = this._skinnedFlags, sd = this._skinnedInstData;
      for (let i = 0; i < vis.length; i++) {
        const m = vis[i];
        if (!(flags[i] & 1) || !m.skeleton || m.material.opacity < 1) continue;
        const vb = this._skinnedVBs.get(m.id), sib = this._skinnedIBs.get(m.id), sb = this._skinMatBufs.get(m.skeleton.id);
        if (!vb || !sib || !sb) continue;
        const skin = this._taa!.skinBindGroup(m.skeleton.id, sb.buf, this._skinUploadData(m.skeleton));
        const o = i * fpi, cur = sd.subarray(o, o + 16);
        let prev = this._taaSkinPrevModel.get(m.id);
        if (!prev) { prev = new Float32Array(cur); this._taaSkinPrevModel.set(m.id, prev); }
        let d = sk[ns];
        if (!d) { d = { vb, ib: sib, indexCount: 0, skin, cur, prev }; sk.push(d); }
        d.vb = vb; d.ib = sib; d.indexCount = m.geometry.indices.length; d.skin = skin; d.cur = cur; d.prev = prev;
        ns++;
      }
    }
    sk.length = ns;
  }
  /** After the velocity draws were copied: skinned parts remember this frame's model; drop the mover references. */
  private _taaAfterVelocity(): void {
    for (const d of this._taaSkin) (d.prev as Float32Array).set(d.cur);
    for (let i = 0; i < this._taaMoverN; i++) this._taaMovers[i].m = null;
    this._taaMoverN = 0;
    if (this._taaSkinPrevModel.size > 256) this._taaSkinPrevModel.clear();
  }

  /** Is this array group distance-LOD hidden right now (the per-family LOD stats, world-lod-settings.ts)? */
  isArrayGroupLodHidden(id: string): boolean { return this._lodHiddenGroups.has(id); }

  private _writeIBLBuffer(): void {
    if (this._iblUniformBuffer) {
      // GPU-baked SH (P4.1) lives only in the buffer — write the scalars (floats 36+) and leave floats 0-35 alone.
      if (this._shGpuOwned) this.device.queue.writeBuffer(this._iblUniformBuffer, 144, this._iblData, 36);
      else this.device.queue.writeBuffer(this._iblUniformBuffer, 0, this._iblData);
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
  getGeomPoolStats(): { liveAllocs: number; appendsSinceCompact: number; vtxUsedMB: number; vtxCapMB: number; idxUsedMB: number; idxCapMB: number;
    uploadLastMB: number; uploadMaxMB: number; slicing: number; slicedGeoms: number; maxWriteMB: number; liveMB: number;
    packMode: boolean; packGate: number; packedKeys: number; packedMB: number; packSkips: number } {
    let pkN = 0, pkB = 0;
    for (const a of this._geomKeyAllocs.values()) if (a.pk) { pkN++; pkB += a.vtxBytes + a.idxBytes; }
    return {
      // P22 packedVertices: the pool's mode, the twin gate (0 / 1 compiling / 2 packing), packed geometries + their MB,
      // draws skipped while a twin compiled
      packMode: this._pkMode, packGate: this._pkGate, packedKeys: pkN, packedMB: +(pkB / 1048576).toFixed(1), packSkips: this._pkSkips,
      liveAllocs: this._geomAllocs.size,
      appendsSinceCompact: this._geomPoolIds.length,
      vtxUsedMB: +(this._geomVtxTail / 1048576).toFixed(1),
      vtxCapMB: +(this._geomVBCap / 1048576).toFixed(1),
      idxUsedMB: +(this._geomIdxTail / 1048576).toFixed(1),
      idxCapMB: +(this._geomIBCap / 1048576).toFixed(1),
      // step 3: geometry written in the last frame interval / the most in one interval since resetUploadStats, the
      // geometries being written in slices now and the count ever sliced
      uploadLastMB: +this._upLastMB.toFixed(2), uploadMaxMB: +this._upMaxMB.toFixed(2), slicing: this._geomPartial.size, slicedGeoms: this._upSliced,
      maxWriteMB: +(this._upMaxWrite / 1048576).toFixed(2),
      // the live geometry (used span minus the free list's dead space), vertex + index MB
      liveMB: +((this._geomVtxTail + this._geomIdxTail - this._geomFree.reduce((s, f) => s + f.vtxBytes + f.idxBytes, 0)) / 1048576).toFixed(1),
    };
  }
  /** Step 3 diagnostics: restart the upload maximum (getGeomPoolStats().uploadMaxMB). */
  resetUploadStats(): void { this._upMaxMB = 0; this._upMaxWrite = 0; }

  setAmbientLight(r: number, g: number, b: number, intensity = 1): void {
    this._ambientColor = [r, g, b];
    this._ambientIntensity = intensity;
  }

  setDirectionalLight(dx: number, dy: number, dz: number, r = 1, g = 1, b = 1, intensity = 1): void {
    const prevDir = this._light.direction;
    // Normalize direction
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    this._light = {
      direction: [dx / len, dy / len, dz / len],
      color: [r, g, b],
      intensity,
    };
    if (Renderer3D.SUN_SHADOW_STEP_DEG > 0) {
      // P14: the shadow maps follow the sun in steps (stepSunDirection); a call that leaves the shadow direction where
      // it is (colour / intensity only, a lightning flash, a sub-step move) leaves the maps valid.
      if (stepSunDirection(this._shadowDir, this._light.direction, Renderer3D.SUN_SHADOW_STEP_DEG)) { this._shadowLightMoved = true; this._shadowMapStale = true; this._sunPending = false; }
      else { const d = this._light.direction, c = this._shadowDir; this._sunPending = d[0] !== c[0] || d[1] !== c[1] || d[2] !== c[2]; }
      this._sunCallFrame = this._shadowFrameNo;
      return;
    }
    const sd = this._shadowDir; sd[0] = this._light.direction[0]; sd[1] = this._light.direction[1]; sd[2] = this._light.direction[2];
    if (prevDir[0] !== this._light.direction[0] || prevDir[1] !== this._light.direction[1] || prevDir[2] !== this._light.direction[2]) this._shadowLightMoved = true;   // P4.2
    this._shadowMapStale = true;   // the shadow light matrix follows the sun — refresh the throttled map
  }
  /** P14 A/B: the shadow maps' light direction follows the sun only once it has turned this many degrees (0 = on every
   *  setDirectionalLight call, which also marked the maps stale on colour-only calls: the pre-P14 behaviour). */
  static SUN_SHADOW_STEP_DEG = 0.15;
  /** P14: once the sun has stopped moving for this many frames, a sub-step remainder snaps the shadow direction onto
   *  the exact sun (a still scene never keeps a lagging shadow). */
  static SUN_SETTLE_FRAMES = 8;
  private _sunPending = false;
  private _sunCallFrame = 0;
  /** P14: called per frame (_updateShadowCenter): settle a pending sub-step sun. */
  private _settleSun(): void {
    if (!this._sunPending || this._shadowFrameNo - this._sunCallFrame < Renderer3D.SUN_SETTLE_FRAMES) return;
    this._sunPending = false;
    const d = this._light.direction, c = this._shadowDir;
    if (d[0] === c[0] && d[1] === c[1] && d[2] === c[2]) return;
    c[0] = d[0]; c[1] = d[1]; c[2] = d[2];
    this._shadowLightMoved = true; this._shadowMapStale = true;
  }

  /** Up to 16 POINT LIGHTS (street lamps at night) — additive lambert with a smooth radius falloff, applied
   *  in the PBR/cel/cel-hd paths. Pass [] to turn them all off. */
  setPointLights(lights: PointLight3D[]): void {
    this._candidateLights = [];                        // direct mode: an explicit fixed set → clears any camera-follow candidates
    this._pointLights = lights.slice(0, MAX_POINT_LIGHTS);
    this._lightsFromCandidates = false;                // P5: this is a direct set — empty candidates must NOT wipe it
  }
  /** CAMERA-FOLLOWING point lights: pass the FULL candidate set (e.g. every lit street lamp in the city). Each
   *  frame the renderer keeps only the MAX_POINT_LIGHTS nearest the camera FOCUS, so the fixed light budget is
   *  always spent on lamps on/near screen instead of a static seed-picked subset scattered across the map. []=clear. */
  setCandidatePointLights(lights: PointLight3D[]): void {
    this._candidateLights = lights;
    this._lightSelKey = [1e9, 1e9, 1e9];               // force a re-select next frame
  }
  /** visual-polish #7c: PINNED point lights (the Play player light) — always uploaded, AHEAD of the direct / candidate
   *  set, which keeps the remaining MAX_POINT_LIGHTS - n slots. [] = none (the original upload, bit-identical). */
  setPinnedPointLights(lights: PointLight3D[]): void { this._pinnedLights = lights.slice(0, MAX_POINT_LIGHTS); }
  private _pinnedLights: PointLight3D[] = [];
  private readonly _uploadLights: PointLight3D[] = [];
  private _lightsForUpload(): PointLight3D[] {
    if (!this._pinnedLights.length) return this._pointLights;
    const out = this._uploadLights;
    out.length = 0;
    for (const l of this._pinnedLights) out.push(l);
    for (const l of this._pointLights) { if (out.length >= MAX_POINT_LIGHTS) break; out.push(l); }
    return out;
  }
  private _pointLights: PointLight3D[] = [];
  private _candidateLights: PointLight3D[] = [];
  private _lightSelKey: [number, number, number] = [1e9, 1e9, 1e9];   // camera target at the last nearest-N select (movement throttle)
  private _lightSelDist: number[] = [];   // P6: parallel ground-distance buffer for the bounded nearest-K selection (reused)
  private _lightsFromCandidates = false;  // P5: true when _pointLights was populated by the candidate path (vs a direct setPointLights)
  /** Keep the MAX_POINT_LIGHTS candidate lamps nearest the camera focus. THROTTLED — only re-selects when the focus
   *  has moved (a static camera costs nothing). No-op with no candidates (a direct setPointLights set then stands). */
  private _selectNearestPointLights(): void {
    const cands = this._candidateLights;
    if (cands.length === 0) {
      // P5: candidates went empty (e.g. daytime / left the city). If OUR selection came from candidates, clear it so
      // the shader's point-light loop bound (lightCounts.x = _pointLights.length) drops to 0. A direct setPointLights
      // set is left untouched.
      if (this._lightsFromCandidates && this._pointLights.length) this._pointLights.length = 0;
      return;
    }
    this._lightsFromCandidates = true;
    const t = this.camera.target;
    const dx = t[0] - this._lightSelKey[0], dz = t[2] - this._lightSelKey[2];
    if (dx * dx + dz * dz < 0.25 && this._pointLights.length > 0) return;   // focus barely moved → keep the current pick
    this._lightSelKey = [t[0], t[1], t[2]];
    // The bounded-insertion nearest-K pick itself is pure — extracted to scene-uniforms.ts (C1 Part 2).
    selectNearestPointLights(cands, t[0], t[2], MAX_POINT_LIGHTS, this._pointLights, this._lightSelDist);
  }

  /** PCF penumbra width multiplier (1 = the classic tight 5×5; ~2.5 = soft city-scale shadows). */
  setShadowSoftness(s: number): void { this._shadowSoftness = Math.max(0.5, s); this._shadowMapStale = true; }
  get shadowSoftness(): number { return this._shadowSoftness; }
  private _shadowSoftness = 1;
  /** Shadow darkness 0..1: 0 = barely visible, 1 = fully black. Drives the in-shadow light floor (default 0.4). */
  setShadowStrength(strength: number): void { this._shadowMinLight = 1 - Math.max(0, Math.min(1, strength)); }
  get shadowStrength(): number { return 1 - this._shadowMinLight; }
  private _shadowMinLight = 0.42;   // multiplier applied to lit colour in full shadow (uploaded at resolution.z)

  /** PERF COUNTERS for hitch diagnosis (salsaWorld.perf() prints these): cumulative counts of the heavy
   *  events + the last cost of the two expensive rebuilds. A dip correlates with poolRebuilds/atlasRebuilds
   *  climbing; fullRepacks are the cheap-but-not-free middle tier; fastPaths should dominate. */
  private _perf = { renders: 0, fullRepacks: 0, fastPaths: 0, poolRebuilds: 0, lastPoolMs: 0, atlasRebuilds: 0, lastAtlasMs: 0, shadowPasses: 0, appends: 0, warms: 0, groupPlacements: 0, groupPacks: 0, groupReclaims: 0, poolGrows: 0, instanceGrows: 0, gpuCompactions: 0, poolShrinks: 0, poolReleases: 0 };
  getPerfCounters(): { renders: number; fullRepacks: number; fastPaths: number; poolRebuilds: number; lastPoolMs: number; atlasRebuilds: number; lastAtlasMs: number; shadowPasses: number; appends: number; warms: number; groupPlacements: number; groupPacks: number; groupReclaims: number; poolGrows: number; instanceGrows: number; gpuCompactions: number; poolShrinks: number; poolReleases: number } {
    return { ...this._perf };
  }

  // Per-FRAME render profile (reset each drawMeshes call). For finding CPU bottlenecks: drawCalls = enc.drawIndexed
  // count across ALL passes; ms* = CPU submission time per phase (NOT GPU execution). If drawCalls is high + msTotal
  // high → draw-call bound; msUpload high → instance processing; msTotal low but fps low → GPU bound. Read via
  // salsaWorld.frameStats().
  //
  // CULLING counters (polish-round-3 Round 5): cheap per-frame sums filled by _buildDrawLists / _drawMesh.
  //   meshesCulled / groupsCulled / instancesCulled = what the CAMERA frustum rejected (main + screen-space passes);
  //   trisTotal = every triangle the scene holds this frame (meshes + array instances), trisVisible = what survived
  //   the camera cull (the main pass's opaque + transparent lists), trisDrawn = triangles actually submitted across
  //   ALL passes (main + shadow + SSAO/SSR prepasses + outline depth). shadow* = the shadow pass (culled against the
  //   LIGHT's ortho box + the shadow-reach test, not the camera box — see _buildDrawLists): casters kept / culled /
  //   off-view, its draw calls + triangles.
  private _frame = { drawCalls: 0, meshes: 0, arrayGroups: 0, instances: 0, msTotal: 0, msUpload: 0, msShadow: 0,
    meshesCulled: 0, groupsCulled: 0, instancesCulled: 0, trisTotal: 0, trisVisible: 0, trisDrawn: 0,
    shadowCasters: 0, shadowCulled: 0, shadowOffView: 0, shadowDrawCalls: 0, shadowTris: 0, msCull: 0,
    skinnedMeshes: 0, skinnedDrawn: 0, skinnedCulled: 0, skinnedShadow: 0, skinUploads: 0, skinnedFogHidden: 0, skinnedWaiting: 0, skelAnimCulled: 0, skinnedTris: 0, msSkinned: 0,
    lodHidden: 0, lodTrisHidden: 0, fogHidden: 0, fogTrisHidden: 0, cascadeCasters: 0, cascadeDrawCalls: 0, cascadePasses: 0, cascades: 0,
    shadowLodFar: 0, shadowLodCascade: 0,
    passMainDraws: 0, passMainTris: 0, passFarShadowDraws: 0, passFarShadowTris: 0, passCascadeDraws: 0, passCascadeTris: 0,
    passOutlineDraws: 0, passOutlineTris: 0, passPrepassDraws: 0, passPrepassTris: 0, passPlanarDraws: 0, passPlanarTris: 0,
    passOtherDraws: 0, passOtherTris: 0,
    passFarShadowLastDraws: 0, passFarShadowLastTris: 0, passCascadeLastDraws: 0, passCascadeLastTris: 0,
    occlCulled: 0, occlTrisCulled: 0, msOccl: 0, rangeTrisCulled: 0, rangeTrisCulledCascade: 0, rangeBuilds: 0,
    rangeTrisCulledShadow: 0, cascadeStaticRenders: 0, cascadeDynPasses: 0, cascadeRecentres: 0,
    gpuDriven: 0, gpuMainDraws: 0, gpuMainTris: 0, gpuStatsAge: -1, gpuRecords: 0, msGpuSync: 0, gpuOrphanDraws: 0 };
  getFrameStats3D(): FrameStats3D { return { ...this._frame, cascades: this._cascadeCount }; }
  /** P11 per-pass accumulators (index = PassBucket), copied into `_frame.pass*` at the end of drawMeshes. */
  private _passBucket: PassBucket = PassBucket.Other;
  private readonly _passDraws = new Float64Array(7);
  private readonly _passTris = new Float64Array(7);
  private _flushPassStats(): void {
    const f = this._frame, d = this._passDraws, t = this._passTris;
    f.passMainDraws = d[0]; f.passMainTris = t[0]; f.passFarShadowDraws = d[1]; f.passFarShadowTris = t[1];
    f.passCascadeDraws = d[2]; f.passCascadeTris = t[2]; f.passOutlineDraws = d[3]; f.passOutlineTris = t[3];
    f.passPrepassDraws = d[4]; f.passPrepassTris = t[4]; f.passPlanarDraws = d[5]; f.passPlanarTris = t[5];
    f.passOtherDraws = d[6]; f.passOtherTris = t[6];
    const shOn = this._shadowsEnabled && !this._shadowsSuspended;
    if (d[1] > 0 || !shOn) { f.passFarShadowLastDraws = d[1]; f.passFarShadowLastTris = t[1]; }
    if (d[2] > 0 || !shOn || this._cascadeCount === 0) { f.passCascadeLastDraws = d[2]; f.passCascadeLastTris = t[2]; }
  }
  /** Frame-stats keys that count since start (not per frame): an empty frame keeps them. */
  private static readonly _FRAME_CUMULATIVE = new Set(['cascadePasses', 'cascadeStaticRenders', 'cascadeDynPasses', 'cascadeRecentres']);
  /** Stats fix 2026-10-03 (performance-plan §P15): a frame with NO regular (non-skinned) meshes. drawMeshes does not
   *  run then (the caller skips it, and it returns at once on an empty list), so every per-frame counter kept the LAST
   *  static frame's values: a cleared city followed by one character read as the city (1.9 M tris, 3 k draws, "over
   *  budget"), and the GPU scene kept every record (the departed meshes and their CPU geometry alive) with nothing ever
   *  rebuilding it. This zeroes the frame (drawSkinnedMeshes, if it runs next, fills the skinned part), drops the
   *  GPU-driven records and drains the deferred evictions. Cheap when there is nothing to drop. */
  noStaticMeshesThisFrame(): void {
    const f = this._frame as unknown as Record<string, number>;
    for (const k in f) if (!Renderer3D._FRAME_CUMULATIVE.has(k)) f[k] = 0;
    f.gpuStatsAge = -1;
    this._passDraws.fill(0); this._passTris.fill(0); this._passBucket = PassBucket.Other;
    this._gdDrew = false;
    if (this._gd && this._gd.recordCount > 0) this._gd.reset();
    if (this._evictPending.size) this.drainDeferredEviction(STREAM_HITCH_LIMITS.evictBudgetMs, []);
  }
  /** Forget the GPU-driven scene's records (document load): the next GPU-driven frame rebuilds them from the scene. */
  resetGpuScene(): void { this._gd?.reset(); }
  /** Skinned parts drawn on the last drawSkinnedMeshes call (the caller runs it once more on an empty roster so the
   *  departed characters' stats, shadow and replay list clear). */
  get skinnedLastCount(): number { return this._lastSkinnedCount; }

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
    this._effHe = he;                 // reset the effective box; _updateShadowCenter re-derives it next frame
    this._effBias = this._shadowBias;
    this._shadowMapStale = true;
  }

  enableShadows(mapSize = 2048, halfExtent = 15, bias = 0.002): void {
    this._shadowMapSize = mapSize;
    this._shadowHalfExtent = halfExtent;
    this._shadowBias = bias;
    this._effHe = halfExtent;
    this._effBias = bias;

    this._shadowTexture?.destroy();
    this._shadowTexture = this.device.createTexture({
      size: [mapSize, mapSize, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,   // COPY_DST: P4.2 static-cache copy
    });
    this._shadowTextureView = this._shadowTexture.createView();
    this._dropShadowStaticCache();
    this._cascadeTexKey = '';        // (re)bind the cascade array (or its dummy) with the fresh map
    this._ensureCascadeTexture(this._csm.cascades > 1 ? this._csm.cascades - 1 : 0);
    this._shadowsEnabled = true;
    this._shadowMapStale = true;
    this._splitWarmShadowBase(PIPELINE_PRIORITY.DOCUMENT);   // SHADER SPLIT: the shadow-receiving BASE fallbacks
  }

  // ── Cascaded shadows (persona-polish A2) ──

  /** Configure CASCADED shadows (partial OK): `cascades` 1 = the original single map (default), 2 = + a near cascade,
   *  3 = + near and mid. See shadow-cascades.ts for the fields. Takes effect while shadows are enabled; persists via
   *  the global scene settings (shadows.cascades). */
  setShadowCascades(s: Partial<ShadowCascadeSettings>): void {
    this._csm = sanitizeShadowCascades(s, this._csm);
    if (this._shadowsEnabled) this._ensureCascadeTexture(this._csm.cascades > 1 ? this._csm.cascades - 1 : 0);
    this._cascadeStale = true;
  }
  get shadowCascades(): ShadowCascadeSettings { return { ...this._csm }; }

  /** The cascade depth array for `n` near cascades (n = 0 → a 1x1 one-layer dummy so the shadow bind group stays
   *  complete), and the shadow bind group that binds it at 2. Rebuilds only when the shape changes. */
  private _ensureCascadeTexture(n: number): void {
    const size = n > 0 ? this._csm.mapSize : 1, layers = Math.max(1, n);
    const key = `${size}x${layers}`;
    if (key === this._cascadeTexKey && this._cascadeTex && this._shadowBindGroup) return;
    this._cascadeTex?.destroy();
    this._cascadeTex = this.device.createTexture({
      size: [size, size, layers], format: 'depth32float', label: n > 0 ? 'ShadowCascades' : 'ShadowCascadesDummy',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,   // COPY_SRC: debug readback; COPY_DST: P14 static-layer copy
    });
    this._dropCascadeCache();   // P14: the sampled layers are new (the static layers stay valid, but recomposite)
    this._cascadeLayerViews = [];
    for (let i = 0; i < layers; i++) this._cascadeLayerViews.push(this._cascadeTex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
    this._cascadeTexKey = key;
    this._cascadeStale = true;
    if (n === 0) {   // the dummy must read "fully lit" if anything ever sampled it
      const enc = this.device.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this._cascadeLayerViews[0], depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' } }).end();
      this.device.queue.submit([enc.finish()]);
    }
    this._cascadeArrayView = this._cascadeTex.createView({ dimension: '2d-array' });
    if (this._shadowTextureView) {
      const mm = this._shadowMM ??= new ShadowMinMax(this.device);
      mm.ensure(this._shadowMapSize, size, layers);
      mm.setValid('far', false); mm.setValid('casc', false);   // fresh textures → no shortcut until rebuilt
      this._shadowMMFarDirty = true; this._shadowMMCascDirty = true;
      this._shadowBindGroup = this.device.createBindGroup({
        layout: this.pipeline.shadowBindGroupLayout,
        entries: [
          { binding: 0, resource: this._shadowTextureView },
          { binding: 1, resource: this.pipeline.shadowSampler },
          { binding: 2, resource: this._cascadeArrayView },
          { binding: 3, resource: mm.farView },
          { binding: 4, resource: mm.cascView },
          { binding: 5, resource: { buffer: mm.params } },
        ],
      });
    }
  }

  private _shadowMMFarDirty = true;
  private _shadowMMCascDirty = true;
  /** P6: after this frame's shadow passes, rebuild the min/max tiles of every map that was written (same encoder, so
   *  the main pass sees matching tiles). A map whose rebuild can't run (pipeline compiling) has its shortcut turned
   *  off until one lands; the A/B switch off turns both off. */
  private _recordShadowMinMax(enc: () => GPUCommandEncoder, farWritten: boolean, cascWritten: boolean): void {
    const mm = this._shadowMM;
    if (!mm) return;
    if (farWritten) this._shadowMMFarDirty = true;
    if (cascWritten) this._shadowMMCascDirty = true;
    if (!Renderer3D.shadowMinMax || !this._shadowsEnabled || !this._shadowTextureView) {
      mm.setValid('far', false); mm.setValid('casc', false); this._shadowMMFarDirty = this._shadowMMCascDirty = true;
      mm.flush();
      return;
    }
    if (this._shadowMMFarDirty) { if (mm.record(enc(), 'far', this._shadowTextureView, 1)) this._shadowMMFarDirty = false; }
    const n = this._cascadeCount;
    if (this._shadowMMCascDirty && n > 0 && this._cascadeArrayView) { if (mm.record(enc(), 'casc', this._cascadeArrayView, n)) this._shadowMMCascDirty = false; }
    mm.flush();
  }

  /** Per frame (uploadSceneUniforms, after the far box moved): lay out + snap the near cascades around the camera. */
  private _updateCascades(): void {
    const want = this._shadowsEnabled && !this._shadowsSuspended && this._csm.cascades > 1 ? this._csm.cascades - 1 : 0;
    this._cascadeCount = 0;
    this._cascadePack.count = 0;
    if (want === 0) return;
    this._ensureCascadeTexture(want);
    const cam = this.camera, p = cam.position, t = cam.target;
    const dist = Math.hypot(t[0] - p[0], t[1] - p[1], t[2] - p[2]);
    const hes = cascadeHalfExtents(want, this._effHe, this._csm.nearExtent, dist);
    const ld = this._shadowDir, ll = Math.hypot(ld[0], ld[1], ld[2]) || 1;   // P14: the stepped shadow direction
    const dy = ld[1] / ll;
    const size = this._csm.mapSize, pk = this._cascadePack;
    const top = this._sceneTopY, floor = this._sceneFloorY;
    for (let i = 0; i < hes.length; i++) {
      const he = hes[i];
      const c = cascadeCentre(p, t, he, this._cascadeCentreScratch);
      // Depth: reach UP the sun ray far enough to catch the tallest caster (its shadow can land in the box), and down
      // past the lowest receiver. A low sun (|dy| small) is capped at 8 box-widths so precision stays sane.
      const slope = Math.min(dy < -0.05 ? 1 / -dy : 8, 8);
      const back = he + (Number.isFinite(top) ? Math.max(0, top - c[1]) : 4 * he) * slope;
      const fwd = 2 * he + (Number.isFinite(floor) ? Math.max(0, c[1] - floor) : he) * slope;
      // P14.2 SLACK: keep the previous box (and with it the cached static layer) while the wanted one stays within
      // CASCADE_FOLLOW_SLACK_TEXELS of it and inside its depth range; a re-centre pads the depth range (shadow-cache.ts).
      // Slack 0 = the wanted box every frame, exactly the old matrix.
      const wb = cascadeLightBox(ld, he, c, back, fwd, size, this._cascadeScratch, this._cascadeWant);
      const hb = this._cascadeHeld[i], slack = Math.max(0, Renderer3D.CASCADE_FOLLOW_SLACK_TEXELS) * (2 * he) / Math.max(1, size);
      if (!(this._cascadeHeldOk[i] && cascadeBoxHolds(hb, wb, slack))) {
        copyCascadeBox(hb, wb);
        let range = back + fwd;
        if (slack > 0) { const mg = cascadeDepthMargin(slack, wb.dy); hb.zn -= mg; hb.zf += mg; range += 2 * mg; }
        this._cascadeHeldRange[i] = range;
        if (this._cascadeHeldOk[i]) this._frame.cascadeRecentres++;
        this._cascadeHeldOk[i] = slack > 0;
      }
      cascadeMatrixFromBox(hb, this._cascadeScratch, pk.matrices.subarray(i * 16, i * 16 + 16));
      pk.bias[i] = cascadeBias(he, size, this._cascadeHeldRange[i], this._shadowSoftness);
      if (i < 2) this._cascadeTexel[i] = shadowTexel(he, size);   // P8 shadow LOD
    }
    pk.count = hes.length; pk.mapSize = size; pk.band = this._csm.blend;
    this._cascadeCount = hes.length;
    for (let i = 0; i < hes.length; i++) this._cascadeCullers[i].setFromViewProjection(pk.matrices.subarray(i * 16, i * 16 + 16));
  }
  private readonly _cascadeScratch = { eye: vec3.create(), up: vec3.create(), view: mat4.create(), proj: mat4.create(), out: mat4.create() };

  /** Clone the mesh / skinned group-0 bind groups with the scene uniform (binding 1) pointed at each cascade's own
   *  buffer, whose light matrix is that cascade's (the depth VS reads scene.lightSpaceMatrix). */
  private _ensureCascadeBindGroups(n: number): void {
    while (this._cascadeSceneBufs.length < n) {
      this._cascadeSceneBufs.push(this.device.createBuffer({ size: SCENE_UNIFORM_SIZE_PADDED, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `CascadeScene${this._cascadeSceneBufs.length}` }));
      this._cascadeMeshBGFor = null; this._cascadeSkinBGFor = null;
    }
    const swap = (entries: GPUBindGroupEntry[], buf: GPUBuffer): GPUBindGroupEntry[] =>
      entries.map((e) => (e.binding === 1 ? { binding: 1, resource: { buffer: buf } } : e));
    if (this.meshBindGroup && this._meshBGEntries && this._cascadeMeshBGFor !== this.meshBindGroup) {
      this._cascadeMeshBGs = this._cascadeSceneBufs.map((b) => this.device.createBindGroup({ layout: this.pipeline.meshBindGroupLayout, entries: swap(this._meshBGEntries!, b) }));
      this._cascadeMeshBGFor = this.meshBindGroup;
    }
    if (this._skinnedMeshBG && this._skinnedMeshBGEntries && this._cascadeSkinBGFor !== this._skinnedMeshBG) {
      this._cascadeSkinBGs = this._cascadeSceneBufs.map((b) => this.device.createBindGroup({ layout: this.pipeline.meshBindGroupLayout, entries: swap(this._skinnedMeshBGEntries!, b) }));
      this._cascadeSkinBGFor = this._skinnedMeshBG;
    }
  }

  private readonly _cascadeSceneScratch = new Float32Array(SCENE_UNIFORM_SIZE_PADDED / 4);
  /** Record the near-cascade depth passes into the shared pre-pass encoder (after the far map). */
  private _recordCascadePasses(enc: () => GPUCommandEncoder): void {
    const n = this._cascadeCount;
    if (n === 0 || !this._cascadeTex || this._cascadeLayerViews.length < n || !this.meshBindGroup) return;
    this._cascadeFramesSince++;
    if (this._cascadeSplitLists) { this._recordCascadeCached(enc, n); return; }
    // (split off: the static layers are kept — they stay valid for the static set they hold, and an A/B toggle back
    // composites from them; disableShadows / a size change frees them)
    const pk = this._cascadePack;
    let moved = false;
    for (let k = 0; k < n * 16; k++) if (pk.matrices[k] !== this._cascadePrev[k]) { moved = true; break; }
    if (!(this._cascadeStale || moved || this._cascadeFramesSince >= this._csm.updateInterval)) return;
    this._cascadeStale = false; this._cascadeFramesSince = 0;
    this._cascadePrev.set(pk.matrices);
    this._ensureCascadeBindGroups(n);
    const e = enc();
    const _dc = this._frame.drawCalls;
    for (let i = 0; i < n; i++) {
      const sd = this._cascadeSceneScratch;
      sd.set(this._sceneUniformsData);
      sd.set(pk.matrices.subarray(i * 16, i * 16 + 16), 40);   // lightSpaceMatrix ← this cascade's
      this.device.queue.writeBuffer(this._cascadeSceneBufs[i], 0, sd);
      const pass = e.beginRenderPass({
        label: `ShadowCascade${i}`, colorAttachments: [],
        depthStencilAttachment: { view: this._cascadeLayerViews[i], depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      if (!this._setPipe(pass, this.pipeline.shadowPassPipeline)) this._cascadeStale = true;   // P2: pending → cleared (lit) layer, redo next frame
      pass.setBindGroup(0, this._cascadeMeshBGs[i]);
      this._gdShadowDraw(pass, 3 + 2 * i, this._cascadeMeshBGs[i], 'c' + i);   // P15 Phase C
      this._replayRuns(pass, this._cascadeRunsCache[i] ??= this._buildRuns(this._cascadeLists[i]));
      if (this._cascadeSkinBGs[i]) this._drawSkinnedShadowCasters(pass, this._cascadeSkinBGs[i]);
      pass.end();
    }
    this._frame.cascadeDrawCalls = this._frame.drawCalls - _dc;
    this._frame.cascadePasses++;
  }

  /** P14.2 (performance-plan.md): the near cascades with a cached STATIC layer each. Per cascade (cascadeRefresh):
   *  the static casters are re-rendered into `_cascadeStaticTex` only when the box moved past its slack, the static
   *  set changed or something structural did; each refresh of the dynamic layer copies the static layer into the
   *  sampled one and draws the dynamic casters + skinned characters on top (depth load: the same per-texel minimum as
   *  drawing them all at once, so the map is identical). */
  private _recordCascadeCached(enc: () => GPUCommandEncoder, n: number): void {
    this._ensureCascadeStaticTex(n);
    const pk = this._cascadePack, prev = this._cascadePrev, size = this._csm.mapSize;
    const dynDue = this._cascadeDynStale || this._cascadeFramesSince >= this._csm.updateInterval;
    const stale = this._cascadeStale;
    const skinned = this._skinnedVisibleScratch.length > 0;
    const pipe = this.pipeline.shadowPassPipeline;
    let e: GPUCommandEncoder | null = null, wrote = false, dynFailed = false;
    const _dc = this._frame.drawCalls;
    for (let i = 0; i < n; i++) {
      const st = this._cascadeCache[i];
      let boxChanged = false;
      for (let k = i * 16; k < i * 16 + 16; k++) if (pk.matrices[k] !== prev[k]) { boxChanged = true; break; }
      const hasDyn = this._cascadeDynLists[i].length > 0 || skinned || this._gdShThis;   // (Phase C: the GPU's may exist)
      const sig = this._cascadeSigs[i].value, mem = this._cascadeMembers[i];
      const r = cascadeRefresh(st, boxChanged, sig, stale, hasDyn, dynDue, this._joinDeferOn && (mem.due(this._shadowFrameNo, Renderer3D.STATIC_JOIN_TRIS, Renderer3D.STATIC_JOIN_FRAMES) || this._gdShDue(1 + i, mem.joinTris)));
      if (!r.composite) continue;
      if (!e) { e = enc(); this._ensureCascadeBindGroups(n); }
      const sd = this._cascadeSceneScratch;
      sd.set(this._sceneUniformsData);
      sd.set(pk.matrices.subarray(i * 16, i * 16 + 16), 40);   // lightSpaceMatrix ← this cascade's
      this.device.queue.writeBuffer(this._cascadeSceneBufs[i], 0, sd);
      if (r.renderStatic) {
        const sp = e.beginRenderPass({
          label: `ShadowCascadeStatic${i}`, colorAttachments: [],
          depthStencilAttachment: { view: this._cascadeStaticViews[i], depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        const ok = this._setPipe(sp, pipe);   // P2: pending → a cleared (lit) layer, redone next frame
        sp.setBindGroup(0, this._cascadeMeshBGs[i]);
        if (ok) { this._gdShadowDraw(sp, 3 + 2 * i, this._cascadeMeshBGs[i], 'c' + i); this._replayRuns(sp, this._cascadeRunsCache[i] ??= this._buildRuns(this._expandRanges(this._cascadeLists[i], true, this._cascadeCullers[i], this._cascExp[i]))); }
        sp.end();
        if (ok) this._gdShCommitLayer(e, 1 + i);   // P15 Phase C
        const why = this._cascadeWhy;
        if (!st.valid) why.cold++; else if (stale) why.stale++; else if (boxChanged) why.box++; else why.sig++;   // diagnostics
        st.valid = ok; st.sigDrawn = ok ? (this._joinDeferOn ? this._cascadeSigsAll[i].value : sig) : NaN;
        if (ok && this._joinDeferOn) mem.drawnWith(this._cascadeStaticKeys[i]); else if (!ok) mem.clear();   // P14: the layer now holds every static caster
        if (ok) prev.set(pk.matrices.subarray(i * 16, i * 16 + 16), i * 16);
        this._frame.cascadeStaticRenders++;
      }
      e.copyTextureToTexture({ texture: this._cascadeStaticTex!, origin: { x: 0, y: 0, z: i } }, { texture: this._cascadeTex!, origin: { x: 0, y: 0, z: i } }, [size, size, 1]);
      const pass = e.beginRenderPass({
        label: `ShadowCascade${i}`, colorAttachments: [],
        depthStencilAttachment: { view: this._cascadeLayerViews[i], depthClearValue: 1.0, depthLoadOp: rdDepthLoad(), depthStoreOp: 'store' },   // ('load'; render debug may clear)
      });
      if (hasDyn) {
        const ok = this._setPipe(pass, pipe);
        if (!ok) dynFailed = true;
        pass.setBindGroup(0, this._cascadeMeshBGs[i]);
        if (ok) this._gdShadowDraw(pass, 4 + 2 * i, this._cascadeMeshBGs[i], 'c' + i);   // P15 Phase C
        if (ok && this._cascadeDynLists[i].length) this._replayRuns(pass, this._cascadeDynRunsCache[i] ??= this._buildRuns(this._expandRanges(this._cascadeDynLists[i], true, this._cascadeCullers[i], this._cascExpDyn[i])));   // (joiners carry ranges)
        if (this._cascadeSkinBGs[i]) this._drawSkinnedShadowCasters(pass, this._cascadeSkinBGs[i]);
      }
      pass.end();
      st.dynInMap = hasDyn;
      this._frame.cascadeDynPasses++;
      wrote = true;
    }
    this._cascadeStale = false;   // a failed static render left its layer invalid (cascadeRefresh redoes it)
    if (dynDue) { this._cascadeDynStale = false; this._cascadeFramesSince = 0; }
    if (dynFailed) this._cascadeDynStale = true;
    if (wrote) { this._frame.cascadeDrawCalls = this._frame.drawCalls - _dc; this._frame.cascadePasses++; }
  }

  disableShadows(): void {
    this._cascadeTex?.destroy(); this._cascadeTex = null; this._cascadeTexKey = ''; this._cascadeLayerViews = []; this._cascadeCount = 0; this._cascadePack.count = 0;
    this._cascadeArrayView = null;
    this._dropCascadeStaticTex();   // P14
    this._shadowMM?.setValid('far', false); this._shadowMM?.setValid('casc', false);
    this._shadowTexture?.destroy();
    this._shadowTexture = null;
    this._shadowTextureView = null;
    this._shadowBindGroup = null;
    this._shadowsEnabled = false;
    this._dropShadowStaticCache();
  }

  /** P4.2: free the static far-map cache (re-created on demand at the far map's size). */
  private _dropShadowStaticCache(): void {
    this._shadowStaticTex?.destroy(); this._shadowStaticTex = null; this._shadowStaticView = null;
    this._shadowStaticValid = false; this._shadowSampledStatic = false; this._shadowDynInMap = false;
    this._farMembers.clear();   // P14
  }

  /** P4.2 A/B: cache the STATIC far shadow map (default on) or re-render every caster on the throttle (old). */
  get shadowStaticCache(): boolean { return this._shadowCacheOn; }
  set shadowStaticCache(v: boolean) { if (this._shadowCacheOn === v) return; this._shadowCacheOn = v; this._dropShadowStaticCache(); this._shadowMapStale = true; }
  /** P4.2 diagnostics: static re-renders / dynamic-layer passes / direct (old-path) renders since load, and the last
   *  frame's static + dynamic caster counts. */
  getShadowCacheStats(): { staticRenders: number; dynPasses: number; directRenders: number; staticCasters: number; dynCasters: number; farTris: number; staticStale: number; staticSig: number; staticCold: number; cached: boolean } {
    return { ...this._shadowCacheStats, cached: this._shadowCachePath };
  }

  private _shadowVerify: ((r: { texels: number; diffTexels: number; maxDiff: number; staticCasters: number; dynCasters: number }) => void) | null = null;
  /** P4.2 verification (headless): on the next cached dynamic-layer refresh, ALSO render static + dynamic casters
   *  directly into a scratch map in the same encoder, read both back and compare depth. A correct cache is
   *  bit-identical (diffTexels 0). Resolves null if the cached path doesn't run within ~2 s. */
  debugVerifyShadowCache(): Promise<{ texels: number; diffTexels: number; maxDiff: number; staticCasters: number; dynCasters: number } | null> {
    return new Promise((res) => {
      const t = setTimeout(() => { this._shadowVerify = null; res(null); }, 2000);
      this._shadowVerify = (r) => { clearTimeout(t); res(r); };
      this._shadowDynStale = true;
    });
  }
  private _recordShadowCacheVerify(enc: GPUCommandEncoder): void {
    const done = this._shadowVerify!; this._shadowVerify = null;
    const sz = this._shadowMapSize, dev = this.device;
    const ref = dev.createTexture({ size: [sz, sz, 1], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: ref.createView(), depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    this._setPipe(pass, this.pipeline.shadowPassPipeline);
    pass.setBindGroup(0, this.meshBindGroup!);
    this._gdShadowDraw(pass, 1, this.meshBindGroup, 'far'); this._gdShadowDraw(pass, 2, this.meshBindGroup, 'far');   // P15 Phase C
    this._replayRuns(pass, this._buildRuns(this._shadowStaticList));
    if (this._shadowDynList.length) this._replayRuns(pass, this._buildRuns(this._shadowDynList));
    this._drawSkinnedShadowCasters(pass);
    pass.end();
    const bpr = Math.ceil(sz * 4 / 256) * 256;
    const mk = () => dev.createBuffer({ size: bpr * sz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const bA = mk(), bB = mk();
    enc.copyTextureToBuffer({ texture: this._shadowTexture!, aspect: 'depth-only' }, { buffer: bA, bytesPerRow: bpr, rowsPerImage: sz }, [sz, sz, 1]);
    enc.copyTextureToBuffer({ texture: ref, aspect: 'depth-only' }, { buffer: bB, bytesPerRow: bpr, rowsPerImage: sz }, [sz, sz, 1]);
    const sc = this._shadowStaticList.length, dc = this._shadowDynList.length;
    queueMicrotask(() => {   // after this frame's pre-pass submit
      void Promise.all([bA.mapAsync(GPUMapMode.READ), bB.mapAsync(GPUMapMode.READ)]).then(() => {
        const a = new Float32Array(bA.getMappedRange()), b = new Float32Array(bB.getMappedRange());
        let diff = 0, maxD = 0;
        const row = bpr / 4;
        for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) { const d = Math.abs(a[y * row + x] - b[y * row + x]); if (d > 0) { diff++; if (d > maxD) maxD = d; } }
        bA.unmap(); bB.unmap(); bA.destroy(); bB.destroy(); ref.destroy();
        done({ texels: sz * sz, diffTexels: diff, maxDiff: maxD, staticCasters: sc, dynCasters: dc });
      });
    });
  }

  /** Skinned pose / count changed: the cached path refreshes only the dynamic layer, the old path the whole map. */
  private _skinnedShadowChanged(): void {
    if (this._shadowCachePath) this._shadowDynStale = true; else this._shadowMapStale = true;
  }

  /** P4.2: a caster is DYNAMIC when it moved within the last MOVER_HOLD frames (new meshes start on a short
   *  probation so streaming arrivals / spawned walkers don't churn the static set), sways in the wind, or is a
   *  view-facing billboard. Also assigns the stable per-mesh uid used by the static-set signature. */
  private _casterIsDynamic(m: Mesh3D, windOn: boolean): boolean {
    const until = this._casterUntil(m);
    if (m.billboard || m.billboardParent) return true;
    if (m.hlodFade >= 0) return true;   // P17: an HLOD tier dissolving (fs_shadow dithers it): never in the cached static map
    if (windOn && m.material.windSway) return true;
    if (this._fhBandOn && (m.fogClass === 2 || (m.fogClass === 1 && this._fhBandAttach)) && !m.material.noFog && this._inFadeBand(m)) return true;   // fog horizon P2
    return this._shadowFrameNo <= until;
  }
  /** The motion part of _casterIsDynamic: the last frame `m` counts as a mover (moved within HOLD frames, or a new
   *  caster's PROBATION), updating the bookkeeping (and the stable signature uid in `_lastCasterUid`). P15 Phase C
   *  calls it when a GPU record is written (a matrix change) and keeps the result per record. */
  private _casterUntil(m: Mesh3D): number {
    const HOLD = 1800, PROBATION = 90;
    const fr = this._shadowFrameNo, v = m.localMatrixVersion;
    let r = this._casterMotion.get(m);
    if (!r) { r = { v, f: fr - HOLD + PROBATION, uid: ++this._casterUid }; this._casterMotion.set(m, r); }
    else if (r.v !== v) { r.v = v; r.f = fr; }
    this._lastCasterUid = r.uid;   // P6: the caller's _sigMix reads this instead of a second map lookup
    return r.f + HOLD;
  }
  /** FOG HORIZON P2: the fade band this frame (on / its inner distance / attachments fade too). */
  private _fhBandOn = false;
  private _fhBandIn = 0;
  private _fhBandAttach = false;
  /** Whether a mesh's box reaches into the fade band (its farthest corner past the band's inner edge; boxes wholly
   *  past the fog edge are culled before this is asked). */
  private _inFadeBand(m: Mesh3D): boolean {
    const bb = this.getMeshWorldAABB3D(m, this._fhBandScratch);
    if (!bb) return false;
    return this._boxFarthest(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ) >= this._fhBandIn;
  }
  private readonly _fhBandScratch: AABB3 = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private _boxFarthest(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
    const e = this._fogEye;
    const dx = Math.max(Math.abs(e[0] - minX), Math.abs(e[0] - maxX)), dy = Math.max(Math.abs(e[1] - minY), Math.abs(e[1] - maxY)), dz = Math.max(Math.abs(e[2] - minZ), Math.abs(e[2] - maxZ));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  private _lastCasterUid = 0;
  private _casterUidOf(m: Mesh3D): number {
    let r = this._casterMotion.get(m);
    if (!r) { r = { v: m.localMatrixVersion, f: -1e9, uid: ++this._casterUid }; this._casterMotion.set(m, r); }
    return r.uid;
  }
  private _sigMix(a: number, b: number, c: number): void {
    const k = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x7F4A7C15, 0x85EBCA77) ^ Math.imul((c | 0) + 1, 0xC2B2AE3D)) | 0;
    this._sigSum = (this._sigSum + k) | 0;
    this._sigXor = (this._sigXor ^ Math.imul(k, 0x27D4EB2F)) | 0;
  }

  // ── Outline pass ───────────────────────────────────────────────

  get outlineEnabled(): boolean { return !!this._outlinePass; }

  /** `depthFade` (visual-polish #8): thin + lighten the ink from `near` to `far` world units (null / absent = off, the
   *  constant ink; every call sets it, so a caller re-enabling without it turns it off). */
  enableOutlines(color?: [number, number, number, number], threshold?: number, depthFade?: { near: number; far: number; minAlpha?: number } | null, extras?: OutlineExtras): void {
    if (!this._outlinePass) {
      this._outlinePass = new OutlinePass(this.device, this.pipeline.meshBindGroupLayout, this._swapChainFormat);
    }
    if (color)     this._outlinePass.color     = color;
    if (threshold !== undefined) this._outlinePass.threshold = outlineWidthPx(threshold);
    const df = depthFade && Number.isFinite(depthFade.near) && Number.isFinite(depthFade.far) && depthFade.far > depthFade.near ? depthFade : null;
    this._outlinePass.depthFade = df ? { near: Math.max(0, df.near), far: df.far, minAlpha: Math.max(0, Math.min(1, df.minAlpha ?? 0.25)) } : null;
    this._outlinePass.setExtras(extras);   // visual-polish #3: foliage mode + crease fade (absent = the original ink)
  }

  setOutlineColor(r: number, g: number, b: number, a = 1): void {
    if (this._outlinePass) this._outlinePass.color = [r, g, b, a];
  }

  setOutlineThreshold(t: number): void {
    if (this._outlinePass) this._outlinePass.threshold = outlineWidthPx(t);
  }

  disableOutlines(): void {
    this._outlinePass?.destroy();
    this._outlinePass = null;
  }
  /** The screen-space edge outline's settings, or null when it's off (for persistence). */
  get outlineConfig(): { color: [number, number, number, number]; threshold: number; depthFade?: { near: number; far: number; minAlpha: number } } | null {
    const p = this._outlinePass;
    if (!p) return null;
    const out: { color: [number, number, number, number]; threshold: number; depthFade?: { near: number; far: number; minAlpha: number } } = { color: [p.color[0], p.color[1], p.color[2], p.color[3]], threshold: p.threshold };
    if (p.depthFade) out.depthFade = { ...p.depthFade };   // only when on (saves without it stay byte-identical)
    return out;
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

  /** The particle bloom's settings, or null when it's off (for persistence). */
  get bloomConfig(): { threshold: number; intensity: number } | null {
    const b = this._bloomPass;
    return b ? { threshold: b.threshold, intensity: b.intensity } : null;
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

  /** The GARP atlas as a 2d-array view — the real dedicated array when a pool has loaded, else the 1×1 white
   *  default (viewed as 2d-array). Always valid so binding 4 of the shared texture layout is never unbound. */
  private garpAtlasView(): GPUTextureView {
    return (this._garpAtlasTexture ?? this.getDefaultWhiteTex()).createView({ dimension: '2d-array' });
  }

  /**
   * (Re)build the dedicated GARP texture_2d_array from resolved skin bitmaps. `layers[i].layer` is the stable
   * atlas layer index (from GarpManager — layer 0 reserved blank) and `layers[i].bitmap` its already-resolved
   * image (ephemera render / uploaded image → ImageBitmap|Canvas, resolved services-side via the decal path).
   * All bitmaps MUST be `size`×`size` (one fixed resolution per GARP atlas — like the mesh atlas); mismatches
   * are skipped (that layer stays blank). Rebinds the shared atlas bind group so the next draw samples it.
   * Passing an empty list drops back to the 1×1 placeholder (the no-pools state).
   */
  uploadGarpAtlas(layers: { layer: number; bitmap: ImageBitmap | HTMLCanvasElement }[], size: [number, number]): void {
    this._garpAtlasTexture?.destroy();
    this._garpAtlasTexture = null;

    if (layers.length > 0) {
      const [W, H] = size;
      const numLayers = 1 + Math.max(0, ...layers.map((l) => l.layer)); // layer 0 blank + highest referenced
      const tex = this.device.createTexture({
        size: [W, H, numLayers],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      // Layer 0 = opaque white blank (a GARP mesh whose skin hasn't resolved samples this, not garbage).
      this.device.queue.writeTexture(
        { texture: tex, origin: { x: 0, y: 0, z: 0 } },
        new Uint8Array(W * H * 4).fill(255),
        { offset: 0, bytesPerRow: W * 4, rowsPerImage: H },
        { width: W, height: H, depthOrArrayLayers: 1 },
      );
      for (const { layer, bitmap } of layers) {
        if (layer <= 0) continue;                                    // 0 reserved
        if (bitmap.width !== W || bitmap.height !== H) continue;     // one fixed size per atlas — skip mismatches
        this.device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture: tex, origin: { x: 0, y: 0, z: layer } },
          { width: W, height: H, depthOrArrayLayers: 1 },
        );
      }
      this._garpAtlasTexture = tex;
    }

    // Rebind the shared atlas group + invalidate cached STANDALONE texture bind groups: both reference a GARP
    // view of the texture just destroyed (they rebuild lazily on next draw against the fresh view).
    // (markInstancesDirty in the caller re-packs garpLayer instance data.)
    this._rebindAtlasGroup();
    this._texBindGroupCache.clear();
  }

  /** Rebuild `_atlasBindGroup` from the current diffuse/normal/GARP views (all four textures of group 1). */
  private _rebindAtlasGroup(): void {
    const diffView = (this._atlasTexture ?? this.getDefaultWhiteTex()).createView({ dimension: '2d-array' });
    const normView = (this._normalAtlasTexture ?? this.getDefaultFlatNormalTex()).createView({ dimension: '2d-array' });
    this._atlasBindGroup = this.device.createBindGroup({
      layout: this.pipeline.textureBindGroupLayout,
      entries: [
        { binding: 0, resource: diffView },
        { binding: 1, resource: this.pipeline.activeSampler },
        { binding: 2, resource: normView },
        { binding: 3, resource: this.pipeline.activeSampler },
        { binding: 4, resource: this.garpAtlasView() },   // GARP dedicated atlas (sampled via diffuseSampler)
      ],
    });
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
        // GARP atlas slot — the real dedicated array (a standalone GARP mesh, e.g. a placed prop, samples it).
        // These bind groups are CACHED, and _garpAtlasTexture is destroyed/rebuilt on pool load/unload, so
        // uploadGarpAtlas() clears _texBindGroupCache to force a rebuild against the fresh view.
        { binding: 4, resource: this.garpAtlasView() },
      ],
    });
    this._texBindGroupCache.set(mesh.id, { bg, diffuse: diffuseTex, normal: normalTex });
    return bg;
  }

  /** Evict a mesh's texture bind group cache entry (call when mesh is removed or its texture changes). */
  evictTextureBindGroup(meshId: string): void {
    this._texBindGroupCache.delete(meshId);
  }

  /** DIAGNOSTIC (salsaPkgPaintProbe): the diffuse GPUTexture the CACHED texture bind group for
   *  `meshId` was built against — i.e. what the last textured draw of this mesh actually sampled.
   *  Null when no per-mesh bind group is cached (mesh untextured, never drawn, or atlas-mode). */
  getBoundDiffuseTexture(meshId: string): GPUTexture | null {
    return this._texBindGroupCache.get(meshId)?.diffuse ?? null;
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
  markInstancesDirty(): void { this._instancesDirty = true; this._shadowMapStale = true; this._arraySrcCount = null; }

  /** PERF: call when ONLY transforms changed (nothing added/removed, no material/geometry edits) — the
   *  city-traffic tick. Takes a fast path in uploadMeshInstances that rewrites just the model/normal
   *  matrices of moved slots (version-checked) instead of re-sorting + repacking every instance. */
  markTransformsDirty(): void { this._transformsDirty = true; }

  /** Render the shadow map every N rendered frames instead of every frame (1 = every frame). Structural
   *  changes (lights, geometry, adds/removes) force an immediate refresh regardless. City mode uses ~3 —
   *  the whole-scene depth pre-pass is the single biggest GPU cost of an animated diorama. */
  setShadowUpdateInterval(n: number): void { this._shadowIntervalBase = Math.max(1, n | 0); this._shadowUpdateInterval = Math.max(1, Math.round(this._shadowIntervalBase * this._shadowIntervalScale)); }
  private _shadowIntervalBase = 1;
  private _shadowIntervalScale = 1;
  /** P14 shadow quality presets (shadow-quality.ts): the far map's refresh interval is the scene's own
   *  (setShadowUpdateInterval) times this (1 = unchanged). */
  setShadowIntervalScale(k: number): void { this._shadowIntervalScale = k > 0 && Number.isFinite(k) ? k : 1; this.setShadowUpdateInterval(this._shadowIntervalBase); }
  get shadowIntervalScale(): number { return this._shadowIntervalScale; }
  /** P14: change the far map's resolution, keeping its box and bias (recreates the depth texture; no-op when unchanged
   *  or shadows are off — enableShadows takes the size then). */
  setShadowMapSize(size: number): void {
    const s = Math.min(8192, Math.max(256, Math.round(size)));
    if (!this._shadowsEnabled || s === this._shadowMapSize) return;
    const he = this._shadowHalfExtent, bias = this._shadowBias, effHe = this._effHe, effBias = this._effBias;
    this.enableShadows(s, he, bias);
    this._effHe = effHe; this._effBias = effBias;   // the zoom-adaptive box carries on (_updateShadowCenter re-derives it)
  }

  private _shadowPcfRadius = 0;   // 0 = default (5x5 PCF); 1 = fast 3x3 tier (shadowParams.x)
  /** PCF quality tier: radius 1 = 3x3 (9 taps, ~2.7x cheaper per lit fragment — softer edge, good for city
   *  scale), 2 or 0 = the default 5x5 (25 taps). Purely a uniform — no pipeline rebuild. */
  setShadowQuality(radius: number): void {
    this._shadowPcfRadius = radius === 1 ? 1 : 0;
  }
  /** The PCF tier (1 = 3x3, 0 = 5x5). */
  get shadowPcfRadius(): number { return this._shadowPcfRadius; }

  private _shadowsSuspendedUser = false;
  /** Suspended by the caller (setShadowsSuspended) OR by the device cap (Renderer3D.caps.shadows false: the map is
   *  cleared once to "lit" and no shadow depth pass runs; shadowsEnabled and the document keep the authored value). */
  private get _shadowsSuspended(): boolean { return this._shadowsSuspendedUser || !Renderer3D.caps.shadows; }
  private _shadowSuspendCleared = false;
  /** SUSPEND the shadow pass entirely (extreme zoom-out: shadows are sub-pixel but the depth pass still re-draws
   *  the whole scene). While suspended the map is cleared ONCE to "no occluders" (everything lit — correct for a
   *  view where shadows are invisible) and the per-interval full-scene depth render is skipped. Resume marks the
   *  map stale so the next frame re-renders it. */
  setShadowsSuspended(on: boolean): void {
    if (this._shadowsSuspendedUser === on) return;
    const was = this._shadowsSuspended;
    this._shadowsSuspendedUser = on;
    if (this._shadowsSuspended === was) return;
    if (on) this._shadowSuspendCleared = false;
    else this._shadowMapStale = true;
  }

  /** Apply the per-machine caps (Renderer3D.caps, set by WebGPURenderer.applyGpuCaps) to THIS renderer's live state:
   *  re-gate SSAO / SSR from their authored values, re-derive the GPU-driven state codes, restart the shadow layers. */
  applyDeviceCaps(): void {
    this.setSSAO(this._ssaoConfig.enabled);
    this.setSSREnabled(this._ssrWanted);
    this._gd?.recode();
    if (!Renderer3D.caps.shadows) this._shadowSuspendCleared = false;
    this._shadowMapStale = true; this._cascadeStale = true;
  }

  /** Register GPU-instanced array groups — renderer computes instance transforms from params. */
  /** P15: bumped whenever the array-group SET changes (the GPU-driven records re-derive their order). */
  private _groupSetGen = 0;
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
    // P5: a changed SET (the city zoom tiers show / hide whole groups on a view switch) is placed incrementally — the
    // next upload allocates the new groups' slot ranges and parks the hidden ones (see _syncArrayGroupSlots). Only a
    // local-basis change (radial arrays under the local gizmo) still forces the full repack.
    if (setChanged) { if (this.incrementalArrayGroups) this._groupSetDirty = true; else this._instancesDirty = true; this._arraySrcCount = null; this._groupSetGen++; }
    // Step 3 (P10.D leftover): the per-group world-box cache was keyed by group id and never pruned (streamed tiles'
    // groups piled up, ~10 KB a tile). Once it holds twice the live set, keep only the live groups' entries.
    if (setChanged && Renderer3D.pruneGroupBoxCache && this._agAABBCache.size > 2 * groups.length + 256) {
      const live = new Set<string>(); for (const g of groups) live.add(g.id);
      for (const id of this._agAABBCache.keys()) if (!live.has(id)) this._agAABBCache.delete(id);
    }
    if (basesChanged) { this._instancesDirty = true; this._arraySrcCount = null; }
  }

  /**
   * When a source mesh is selected, set its ID here so the renderer draws a faint linked-instance
   * highlight on all array groups that reference it. Pass null to clear.
   */
  setSelectedSourceId(id: string | null): void {
    this._selectedSourceId = id;
  }

  setGizmoRenderer(gr: GizmoRenderer | undefined): void { this._gizmoRenderer = gr; }
  getGizmoRenderer(): GizmoRenderer | undefined { return this._gizmoRenderer; }

  setMeshEditOverlayRenderer(r: MeshEditOverlayRenderer | undefined): void { this._meshEditOverlay = r; }
  setMeshEditDataProvider(fn: (() => MeshEditDrawData | null) | undefined): void { this._meshEditDataFn = fn; }

  /**
   * Draw the mesh edit overlay (wireframe + handles) if edit mode is active.
   * Called unconditionally from webgpu-renderer after all mesh draws so it renders
   * even when there are no regular (non-skinned) meshes — e.g. after Bind Mesh.
   */
  drawMeshEditOverlayIfActive(pass: GPURenderPassEncoder): void {
    const editData = (RD.on && RD.f.noMeshEditOverlays) ? null : this._meshEditDataForPass(pass);
    this._meshEditDataPass = null; this._meshEditDataMemo = null;   // the overlay is the frame's last reader
    if (!this._meshEditOverlay || !editData) return;
    this._meshEditOverlay.draw(pass, editData, this.camera);
  }

  /** The mesh-edit data provider's result for THIS frame. mobile-parity 7.3b P4: the selection gizmo and the overlay
   *  both need it in the same pass, and the provider (UV hover-face sets, selection lookups) used to run twice per
   *  frame. Memoised by the pass encoder — a new frame is a new encoder. */
  private _meshEditDataPass: GPURenderPassEncoder | null = null;
  private _meshEditDataMemo: MeshEditDrawData | null = null;
  private _meshEditDataForPass(pass: GPURenderPassEncoder): MeshEditDrawData | null {
    if (!this._meshEditOverlay || !this._meshEditDataFn) return null;
    if (this._meshEditDataPass !== pass) {
      this._meshEditDataPass = pass;
      this._meshEditDataMemo = this._meshEditDataFn();
    }
    return this._meshEditDataMemo;
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
  /** This frame's visible particle emitters (stashed by the particle draw each frame) — feeds the
   *  emitter ICONS + lets the selection gizmo anchor on a selected emitter (they aren't meshes). */
  private _frameEmitters: ParticleEmitter3D[] = [];
  setFrameEmitters(emitters: ParticleEmitter3D[]): void { this._frameEmitters = emitters; }

  /** Draw the per-emitter icons (ring + dot, depth-always). Editor affordance — the caller gates it
   *  off in Player/creator modes. Selected emitters highlight via the shared selected-ids set. */
  drawEmitterIconsIfActive(pass: GPURenderPassEncoder, canvasHeight: number): void {
    if (!this._gizmoRenderer || this._frameEmitters.length === 0) return;
    this._gizmoRenderer.drawEmitterIcons(
      pass, this._frameEmitters as unknown as { id: string; localMatrix: mat4 }[],
      this._selectedMeshIds, this.camera, canvasHeight);
  }

  drawSelectionGizmoIfActive(pass: GPURenderPassEncoder, canvasWidth: number, canvasHeight: number): void {
    if (!this._gizmoRenderer) return;
    const editData = this._meshEditDataForPass(pass);   // memoised: the overlay reads the same result below
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
    // Selected particle EMITTERS anchor the gizmo too (the thin-wrapper precedent: not meshes, but the
    // gizmo only reads localMatrix). No selection BOX for them — no OBB; the icon highlight is the box.
    const selectedEmitters = this._frameEmitters.filter(e => this._selectedMeshIds.has(e.id));
    if (selectedMeshes.length === 0 && selectedEmitters.length === 0) return;
    if (selectedMeshes.length > 0) this._gizmoRenderer.drawSelectionBox(pass, selectedMeshes, this.camera, this._hoveredCorner);
    const gizmoTargets = selectedEmitters.length > 0
      ? [...selectedMeshes, ...(selectedEmitters as unknown as Mesh3D[])]
      : selectedMeshes;
    this._gizmoRenderer.drawGizmo(
      pass, gizmoTargets, this.camera, this._gizmoMode, this._hoveredAxis,
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
    if (RD.on && RD.f.noBackground3D) return;   // render debug
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
        this._armatureBgPass?.draw(pass, this._meshEditBgOpts, canvasW, canvasH, mode === 'sky' ? this._skyDomeView(canvasW, canvasH) : null, Renderer3D.caps.animatedFocusBg);
      }
      return;
    }
    if (this._sceneBgOpts.mode !== 'none') {
      this._sceneBgPass?.draw(pass, this._sceneBgOpts, canvasW, canvasH, this._sceneBgOpts.mode === 'sky' ? this._skyDomeView(canvasW, canvasH) : null);
    }
  }
  /** visual-polish #9: the camera basis the SKY DOME backdrop (focus-bg mode 'sky') turns pixels into directions with.
   *  Orthographic views use a nominal 50 deg FOV (parallel rays would paint one flat colour). */
  private _skyDomeView(w: number, h: number): SkyDomeView {
    const c = this.camera;
    return skyDomeView(c.position, c.target, c.up, c.mode === 'perspective' ? c.fov : 50 * Math.PI / 180, w / Math.max(1, h));
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
  /** The mesh-edit focus background is showing AND animates over time ('wavy', unless this machine's caps freeze it —
   *  mobile-parity 7.3b P3), i.e. it needs a frame every vsync. The live-loop holds key on this. */
  get meshEditBgAnimating(): boolean {
    return this._meshEditBgActive && this._meshEditBgOpts.mode === 'wavy' && Renderer3D.caps.animatedFocusBg;
  }

  /** True when the mesh-edit focus background is active AND opaque (wavy/solid/gradient)
   *  — i.e. it fully hides the 2D content, so foreground 2D layers should be skipped too
   *  for a clean workspace. False for 'none'/'dim' (the 2D content stays visible). */
  meshEditHidesContent(): boolean {
    const m = this._meshEditBgOpts.mode;
    return this._meshEditBgActive && m !== 'none' && m !== 'dim';
  }

  /** P4.4 (docs/specs/performance-plan.md): true when drawArmatureBg will paint an OPAQUE full-canvas background over
   *  everything drawn before it this frame — the 3D workspace backdrop (free3D, or a 2D mode on the scene target).
   *  The host then skips compositing + drawing the 2D raster layers underneath (they could not be seen). Conservative:
   *  not in armature mode (its own bg may be 'dim'), and only when the backdrop colours it uses are fully opaque. */
  focusBgCoversCanvas(): boolean {
    if (this._armatureModeActive || !this.meshEditHidesContent() || !this._armatureBgPass) return false;
    const o = this._meshEditBgOpts;
    const a1 = o.color1 ? o.color1[3] : 1, a2 = o.color2 ? o.color2[3] : 1;
    return a1 >= 1 && a2 >= 1;
  }

  /** Draw the mesh-edit 'dim' overlay AFTER meshes (parity with the armature dim mode,
   *  which is a semi-transparent overlay rather than an opaque pre-mesh background). */
  drawMeshEditDimIfActive(pass: GPURenderPassEncoder, canvasW: number, canvasH: number): void {
    if (this._meshEditBgActive && this._meshEditBgOpts.mode === 'dim' && !(RD.on && RD.f.noMeshEditOverlays)) {
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
    if (!this._gridVisible || !this._gizmoRenderer || (RD.on && RD.f.noGrid)) return;
    this._gizmoRenderer.drawGrid(pass, this.camera, this._gridSpacing, this._gridColor, this._gridOpacity);
  }

  /** The illustration artboard "render frame" (illustration × free3D). halfW/halfH in world units (the artboard
   *  is centred at the origin in the XY plane). Toggled + sized by Scene3DManager from the view state. */
  setArtboardFrame(visible: boolean, halfW?: number, halfH?: number, color?: [number, number, number], opacity?: number): void {
    this._artboardFrameVisible = visible;
    if (halfW !== undefined) this._artboardHalfW = halfW;
    if (halfH !== undefined) this._artboardHalfH = halfH;
    if (color) this._artboardColor = color;
    if (opacity !== undefined) this._artboardOpacity = opacity;
  }

  drawArtboardFrameIfActive(pass: GPURenderPassEncoder): void {
    if (!this._artboardFrameVisible || !this._gizmoRenderer) return;
    this._gizmoRenderer.drawArtboardFrame(pass, this.camera, this._artboardHalfW, this._artboardHalfH, this._artboardColor, this._artboardOpacity);
  }

  // The textured artboard: the 2D illustration drawn on the artboard plane in free3D (docs/specs/textured-artboard.md).
  private _artboardTexView: GPUTextureView | null = null;
  private _artboardTexHalfW = 1;
  private _artboardTexHalfH = 1;
  private _artboardTexOpacity = 1;

  /** Set the captured 2D-content texture + artboard half-extents for the free3D artboard quad. `view` null = off. */
  setArtboardTexture(view: GPUTextureView | null, halfW?: number, halfH?: number, opacity?: number): void {
    this._artboardTexView = view;
    if (halfW !== undefined) this._artboardTexHalfW = halfW;
    if (halfH !== undefined) this._artboardTexHalfH = halfH;
    if (opacity !== undefined) this._artboardTexOpacity = opacity;
  }

  drawArtboardTextureIfActive(pass: GPURenderPassEncoder): void {
    if (!this._artboardTexView || !this._gizmoRenderer) return;
    this._gizmoRenderer.drawArtboardTexture(pass, this.camera, this._artboardTexHalfW, this._artboardTexHalfH, this._artboardTexView, this._artboardTexOpacity);
  }

  // Camera-node frustum wireframe (cinematic cameras) — world-space line pairs pushed by Scene3DManager when a
  // camera node is selected (and not being looked-through). Null = nothing to draw.
  private _frustumSegments: [number[], number[]][] | null = null;
  private _frustumColor: [number, number, number] = [1, 0.85, 0.3];
  private _frustumOpacity = 0.9;

  /** Set (or clear, with null) the selected camera node's frustum wireframe. Segments are world-space. */
  setCameraFrustum(segments: [number[], number[]][] | null, color?: [number, number, number], opacity?: number): void {
    this._frustumSegments = segments;
    if (color) this._frustumColor = color;
    if (opacity !== undefined) this._frustumOpacity = opacity;
  }

  drawCameraFrustumIfActive(pass: GPURenderPassEncoder): void {
    if (!this._frustumSegments || !this._gizmoRenderer) return;
    this._gizmoRenderer.drawCameraFrustum(pass, this.camera, this._frustumSegments, this._frustumColor, this._frustumOpacity);
  }

  /** §3.1 uber-shader routing: does this mesh use ANY feature that needs the (unconditional) pattern/window/ground
   *  block in the full fragment shader? If NOT, it can render with the cheaper PLAIN pipeline variant (pattern ALU
   *  compiled out) — output is identical. Conservative: any pattern, shade bit, or normal map keeps it on the full
   *  shader, so only truly-plain meshes (characters, plain props/walls) take the fast path. */
  private _usesPatterns(m: Mesh3D): boolean {
    const mat = m.material;
    return (mat.patternMode !== undefined && mat.patternMode !== 'none')
        || !!mat.hasNormalMap || !!mat.groundShade || !!mat.boardShade || !!mat.waterShade
        || !!mat.foliageShade || !!mat.metalShade || !!mat.neonShade || !!mat.worldTriplanar;
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
  drawMeshes(pass: GPURenderPassEncoder, meshes: Mesh3D[], canvasWidth: number, canvasHeight: number, uploadUniforms = true): void {
    if (meshes.length === 0) { this.noStaticMeshesThisFrame(); return; }
    this._prewarmForScene(meshes, false);   // P2.2: queue the variants this document uses (only when the roster changes)
    this._drew3DThisFrame = true;   // AA gate (runPostProcess)
    this._perf.renders++;   // diagnostic: total mesh renders (delta while moving the mouse = renders/move)
    const _ft0 = performance.now();   // per-frame profile (salsaWorld.frameStats())
    this._frame.drawCalls = 0; this._frame.msShadow = 0; this._frame.msUpload = 0;
    if (this._lastSkinnedCount === 0) { this._frame.skinnedMeshes = 0; this._frame.skinnedDrawn = 0; this._frame.skinnedTris = 0; this._frame.skinnedWaiting = 0; }
    this._frame.trisDrawn = 0; this._frame.shadowDrawCalls = 0; this._frame.shadowTris = 0;
    this._passDraws.fill(0); this._passTris.fill(0); this._passBucket = PassBucket.Other;   // P11 per-pass counters
    this._frame.meshes = meshes.length;
    this._gdBegin();   // P15: GPU-driven main pass on this frame? (before the instance upload: it captures material-dirty meshes)
    this._frame.arrayGroups = this._arrayGroups.length;
    this._frame.instances = this._arrayGroups.reduce((n, g) => n + getArrayInstanceCount(g.arrayParams), 0);

    // Update camera aspect
    this.camera.aspect = canvasWidth / canvasHeight;

    // Zoom-stable reflection reach: re-derive the texel budget from the persisted WORLD reach for this zoom.
    if (this._ssrEnabled) this._updateSSRReachBudget(canvasHeight);

    // Upload scene uniforms (P1: skippable — when drawSkinnedMeshes already ran this frame with the same w/h the
    // data is identical, so the caller can suppress a redundant light-select + shadow-center + writeBuffer).
    if (uploadUniforms) this.uploadSceneUniforms(canvasWidth, canvasHeight);

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
    for (let _km = 0; _km < meshes.length; _km++) { const m = meshes[_km]; if (m.gpuDirty && m.vertexColors) vcDirtyIds.add(m.id); }

    // Rebuild shared geometry pool if mesh list or any geometry changed.
    // Clears gpuDirty on uploaded meshes as a side effect.
    if (!this._ensureGeomPool(meshes)) return;

    // Re-upload standalone VB overrides + color VBs for dirty EditMesh meshes.
    // Also create on first encounter (no entry yet in _vcColorBuffers).
    for (let _km = 0; _km < meshes.length; _km++) { const m = meshes[_km];
      if (m.vertexColors && (vcDirtyIds.has(m.id) || !this._vcColorBuffers.has(m.id))) {
        this._uploadVCBuffers(m);
      }
    }

    // ── C1 Part 2 (2026-09-13): drawMeshes was a ~900-line mega-method; each stage below is a
    // private method holding the ORIGINAL code verbatim, called in the ORIGINAL order. The shared
    // per-frame state (pooled draw lists, batched pass runs) lives in fields; `_passRunsCache` is
    // frame-fresh (reset here, derived lazily from the lists `_buildDrawLists` just filled). ──
    this._ensureMeshBindGroups(canvasWidth, canvasHeight);
    this._buildDrawLists(meshes);
    if (this._gdOn) this._gdFinish(meshes);   // P15: record sync + uploads + the cull dispatch (submitted before the main pass)
    this._passRunsCache = null; this._gdRestRuns = null;
    this._shadowRunsCache = null;
    this._shadowStaticRunsCache = null; this._shadowDynRunsCache = null;
    this._cascadeRunsCache[0] = null; this._cascadeRunsCache[1] = null;
    this._cascadeDynRunsCache[0] = null; this._cascadeDynRunsCache[1] = null;   // P14
    this._recordPrePasses(canvasWidth, canvasHeight);
    this._passBucket = PassBucket.Planar;
    this._drawPlanarReflectionPass(meshes, canvasWidth, canvasHeight);
    this._passBucket = PassBucket.Main;
    this._drawMainPass(pass, meshes);
    if (this._gdDrew) this._gdAddStats();
    this._passBucket = PassBucket.Other;
    this._drawMainOverlays(pass, canvasWidth, canvasHeight);
    this._flushPassStats();


    this._frame.msTotal = performance.now() - _ft0;
  }

  /** drawMeshes stage 1 — (re)build the mesh bind group + its 6 pass-variant siblings when any bound
   *  resource identity changed (buffer growth / AO / scene-color / cube / SSR targets / planar). Verbatim. */
  private _ensureMeshBindGroups(canvasWidth: number, canvasHeight: number): void {
    // Make the SSAO AO buffer exist BEFORE we bind it (so there's no 1-frame lag on enable), then pick the
    // texture to bind: the real AO buffer, or the 1×1 white no-op.
    if ((this._ssaoEnabled || this._ssrEnabled) && this._ssao) this._ssao.ensureTextures(canvasWidth, canvasHeight);
    const aoTex = this._aoBindTexture();
    const sceneColorTex = this._sceneColorBindTexture();
    const cubeTex = this._specularCubeBindTexture();
    const worldPosTex = this._worldPosBindTexture();
    const worldPosBackTex = this._worldPosBackBindTexture();
    const normalTex = this._normalBindTexture();
    const reflectionTex = this._reflectionBindTexture();
    const planarTexBind = this._planarBindTexture();
    // Recreate bind group when the instance buffer grew (reference changed) OR the bound AO texture changed
    // (SSAO toggled / resized) OR the scene-color grab changed OR the specular cube changed (sky (re)baked/cleared)
    // OR the SSR world-pos buffer changed. Binding 3/4 = AO buffer + sampler; 5/6 = scene color (prev frame) + sampler
    // for glass refraction; 7/8/9 = prefiltered specular cube + sampler + BRDF LUT; 10 = SSR world-pos prepass.
    if (!this.meshBindGroup || this._meshBindGroupBuffer !== this.instanceStorageBuffer || this._meshBindGroupAOTex !== aoTex || this._meshBindGroupSceneTex !== sceneColorTex || this._meshBindGroupCubeTex !== cubeTex || this._meshBindGroupWorldPosTex !== worldPosTex || this._meshBindGroupWorldPosBackTex !== worldPosBackTex || this._meshBindGroupNormalTex !== normalTex || this._meshBindGroupReflectionTex !== reflectionTex || this._meshBindGroupPlanarTex !== planarTexBind) {
      const baseEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.instanceStorageBuffer! } },
        { binding: 1, resource: { buffer: this.sceneUniformBuffer } },
        { binding: 2, resource: { buffer: this._iblUniformBuffer! } },
        { binding: 3, resource: aoTex.createView() },
        { binding: 4, resource: this._ssaoAOSampler! },
        { binding: 5, resource: sceneColorTex.createView() },
        { binding: 6, resource: this._sceneColorSampler! },
        { binding: 7, resource: cubeTex.createView({ dimension: 'cube' }) },
        { binding: 8, resource: this._iblCubeSampler! },
        { binding: 9, resource: this._brdfLutTex!.createView() },
      ];
      const hfDummyView = this._ensureDummyHalfFloat().createView();
      this._meshBGEntries = [...baseEntries,
          { binding: 10, resource: worldPosTex.createView() },
          { binding: 11, resource: worldPosBackTex.createView() },
          { binding: 12, resource: normalTex.createView() },
          { binding: 13, resource: reflectionTex.createView() },
          { binding: 14, resource: planarTexBind.createView() }];
      this.meshBindGroup = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: this._meshBGEntries,
      });
      // The world-pos PREPASS writes worldPosTex AND the normal target, so it must NOT bind them (read/write
      // alias in one pass) — dummies at 10/11/12/13. (Only the non-skinned opaque prepass uses it.)
      const dummyView = this._dummyWorldPosTex!.createView();
      this._prepassMeshBG = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: [...baseEntries, { binding: 10, resource: dummyView }, { binding: 11, resource: dummyView },
          { binding: 12, resource: hfDummyView }, { binding: 13, resource: hfDummyView }, { binding: 14, resource: hfDummyView }],
      });
      // The depth-PEEL prepass READS the front layer (real at 10) and WRITES the back one (dummy at 11).
      this._peelMeshBG = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: [...baseEntries, { binding: 10, resource: worldPosTex.createView() }, { binding: 11, resource: dummyView },
          { binding: 12, resource: hfDummyView }, { binding: 13, resource: hfDummyView }, { binding: 14, resource: hfDummyView }],
      });
      // The deferred-SSR RESOLVE pass READS 10/11/12 (+ scene colour) and WRITES the reflection tex (dummy at 13).
      this._resolveMeshBG = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: [...baseEntries, { binding: 10, resource: worldPosTex.createView() }, { binding: 11, resource: worldPosBackTex.createView() },
          { binding: 12, resource: normalTex.createView() }, { binding: 13, resource: hfDummyView }, { binding: 14, resource: hfDummyView }],
      });
      // The FEATHER pass reads the ping buffer at 13 (and writes texture A).
      const pingTex = this._ssao?.reflectionPingTexture();
      this._reflectionPingBG = pingTex ? this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: [...baseEntries, { binding: 10, resource: worldPosTex.createView() }, { binding: 11, resource: worldPosBackTex.createView() },
          { binding: 12, resource: normalTex.createView() }, { binding: 13, resource: pingTex.createView() }, { binding: 14, resource: hfDummyView }],
      }) : null;
      // P4b PLANAR mirror pass: same layout, but binding 1 points at the MIRRORED-camera uniform buffer; 10-14
      // are dummies (the pass writes the planar texture and must not read SSR/planar resources).
      this._planarMeshBG = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: [...baseEntries.filter((en) => en.binding !== 1), { binding: 1, resource: { buffer: this._planarSceneBuf! } },
          { binding: 10, resource: dummyView }, { binding: 11, resource: dummyView },
          { binding: 12, resource: hfDummyView }, { binding: 13, resource: hfDummyView }, { binding: 14, resource: hfDummyView }],
      });
      this._meshBindGroupBuffer = this.instanceStorageBuffer;
      this._meshBindGroupAOTex = aoTex;
      this._meshBindGroupSceneTex = sceneColorTex;
      this._meshBindGroupCubeTex = cubeTex;
      this._meshBindGroupWorldPosTex = worldPosTex;
      this._meshBindGroupWorldPosBackTex = worldPosBackTex;
      this._meshBindGroupNormalTex = normalTex;
      this._meshBindGroupReflectionTex = reflectionTex;
      this._meshBindGroupPlanarTex = planarTexBind;
    }
  }

  /** drawMeshes stage 2 — fill the pooled draw lists: opaque (front-to-back sources), transparent,
   *  array-group instanced ranges, and the shadow/outline dedup list (opaqueForPasses). Verbatim. */
  private _buildDrawLists(meshes: Mesh3D[]): void {
    // Sort: opaque first (front-to-back), transparent last (back-to-front).
    // Also apply frustum culling when enabled.
    // DrawEntry carries an optional submesh for multi-material meshes.
    // Reset the pooled draw lists (reused across frames — no per-frame DrawEntry / array allocation).
    this._drawPoolN = 0;
    const opaque = this._opaque; opaque.length = 0;
    const transparent = this._transparent; transparent.length = 0;

    const _tc0 = performance.now();
    const fs = this._frame;
    fs.meshesCulled = 0; fs.groupsCulled = 0; fs.instancesCulled = 0; fs.trisTotal = 0; fs.trisVisible = 0;
    fs.shadowCasters = 0; fs.shadowCulled = 0; fs.shadowOffView = 0; fs.shadowLodFar = 0; fs.shadowLodCascade = 0;
    const culler = this._frustumCulling
      ? this._culler.setFromViewProjection(this.camera.getViewProjectionMatrix())
      : null;
    // SHADOW list (see _shadowList): built only while a shadow map is live. The light matrix was computed this frame
    // by uploadSceneUniforms (packSceneUniforms -> computeLightSpaceMatrix -> _lsmMatrix). The 6-plane test against it
    // is EXACTLY the hardware clip of the shadow pass (no unclippedDepth), so dropping those casters is invisible.
    const buildShadow = this._shadowLightCull && this._shadowsEnabled && !this._shadowsSuspended;
    const lightCuller = buildShadow && this._frustumCulling ? this._lightCuller.setFromViewProjection(this._lsmMatrix) : null;
    const shadowList = this._shadowList; shadowList.length = 0;
    const shadowSeen = this._shadowSeen; shadowSeen.clear();
    // P4.2 static/dynamic caster split (see _shadowCacheOn).
    this._shadowFrameNo++;
    const cacheLists = buildShadow && this._shadowCacheOn;
    this._shadowCacheListsBuilt = cacheLists;
    const staticList = this._shadowStaticList; staticList.length = 0;
    const dynList = this._shadowDynList; dynList.length = 0;
    this._sigSum = 0; this._sigXor = 0;
    const windOn = this._wind.strength > 0 && this._wind.speed > 0;
    // SHADOW REACH: additionally drop casters whose shadow volume (box swept along the sun down to the scene floor)
    // misses the CAMERA frustum — their shadow cannot land on anything visible. A superset of the old camera-culled
    // shadow list (so no pop the old list did not have) and a subset of the light box (a tiled world's box spans the
    // whole world). Off with a planar mirror live (it shows receivers outside the view).
    const reach = lightCuller && culler && !this._planarActive ? culler : null;
    const ld = this._shadowDir, ll = Math.hypot(ld[0], ld[1], ld[2]) || 1, lightDir = this._lightDirN;   // P14: the stepped shadow direction
    lightDir[0] = ld[0] / ll; lightDir[1] = ld[1] / ll; lightDir[2] = ld[2] / ll;
    const floorY = this._sceneFloorY;
    let nextFloor = Infinity;
    let nextTop = -Infinity;   // persona-polish A2: highest box top (how far the near cascades reach toward the sun)
    // Near CASCADE caster lists (persona-polish A2): every kept shadow caster that also touches cascade i's box.
    const nC = buildShadow ? this._cascadeCount : 0;
    const cLists = this._cascadeLists; cLists[0].length = 0; cLists[1].length = 0;
    const cCull = this._cascadeCullers;
    // P8 SHADOW LOD: a caster whose shadowFeatureSize is below SHADOW_LOD_TEXELS texels of a map is left out of it.
    // Both the map texel AND the screen guard (the feature's size in pixels at the camera's distance to the city
    // volume — 0 at street / roof level) must call the caster too small (shadow-lod.ts).
    const lodPxAng = this.camera.mode === 'orthographic' || !(this._viewH > 0) ? 0 : 2 * Math.tan(this.camera.fov / 2) / this._viewH;
    const lodScreen = shadowLodScreenThreshold(Renderer3D.SHADOW_LOD_SCREEN_PX, this.distanceLodBias, lodPxAng);
    const lodTexFar = Math.min(lodScreen, shadowLodThreshold(Renderer3D.shadowSizeLod, Renderer3D.SHADOW_LOD_TEXELS, shadowTexel(this._effHe, this._shadowMapSize)));
    const lodTexC = this._cascadeLodTex;
    for (let ci = 0; ci < 2; ci++) lodTexC[ci] = Math.min(lodScreen, shadowLodThreshold(Renderer3D.shadowSizeLod, Renderer3D.SHADOW_LOD_TEXELS, this._cascadeTexel[ci]));
    // R6.1 DISTANCE LOD: meshes with a drawDistance drop out (every pass) once the camera is that far from their box.
    // P1.2: an ortho camera's position says nothing about how big things are on screen, its ZOOM does — so under ortho
    // every mesh is "at" orthoLodDistance(orthoSize) (uniform across the view; size x zoom) instead of LOD turning off.
    const lodCam = this.camera;
    const lodOrtho = lodCam.mode === 'orthographic';
    const lodOn = this.distanceLod && (!lodOrtho || this.orthoScreenLod);
    const lodScale = lodOn ? (lodOrtho ? 1 : fovDistanceScale(lodCam.fov)) * this.distanceLodScale * this.lodResolutionScale : 1;
    const lodBias = this.distanceLodBias;
    const cpx = lodCam.position[0], cpy = lodCam.position[1], cpz = lodCam.position[2];
    const orthoD = lodOrtho ? orthoLodDistance(lodCam.orthoSize) : 0, orthoD2 = orthoD * orthoD;
    fs.lodHidden = 0; fs.lodTrisHidden = 0;
    // FOG HORIZON CULL (fog-horizon.ts; Buildings only in fog): a mesh / group whose fog class is not part of the
    // silhouette stops drawing (every pass, its shadow too) once its whole box lies past the fog edge, measured from
    // the fog eye with the true distance (no lens / aerial / resolution scaling: the fog line is a real distance).
    // Its pixels there were the flat fog colour anyway. +1 % keeps vertex sway inside the box. Off while a planar
    // mirror is live (the mirror sees objects the eye's fog hides).
    fs.fogHidden = 0; fs.fogTrisHidden = 0;
    const fhS = this._fogHorizon;
    const fhOn = fhS.buildingsOnly && this.fogHorizonActive && !this._planarActive && Renderer3D.fogHorizonCpuCull;
    const fhCullOther = fhOn, fhCullAttach = fhOn && !fhS.includeAttachments;
    { const c = fhOn ? fogHorizonEdge(this._fog) * 1.01 : Infinity; this._fhCull2 = c * c; }
    // P2 FADE BAND: casters straddling [edge - band, edge] dissolve with the camera distance, so they cannot sit in the
    // cached static shadow map (it is not re-rendered when only the camera moves): they go to the dynamic list.
    { const band = fhOn ? fhS.fadeM * this.fogHorizonUnitsPerMetre : 0, edge = fhOn ? fogHorizonEdge(this._fog) : 0;
      this._fhBandOn = band > 0; this._fhBandIn = Math.max(0, edge - band); this._fhBandAttach = fhCullAttach; }
    // P9 HIERARCHICAL CULL (cull-clusters.ts): static meshes sit in spatial clusters; a cluster outside the view whose
    // shadow cannot reach it rejects its members in a few reads each (visited in order, so the lists are unchanged).
    const hcFrame = this._shadowFrameNo, fastLoop = this.drawListFastPaths;
    // Step 3: with sliced uploads a streamed tile's geometry lands over ~40 frames instead of ~8, so "an append is
    // deferred" is the normal state while streaming — the clusters stay on through it (a member that is not resident
    // yet was never clustered and takes the per-mesh path, as before) and are only REBUILT once the appends caught up.
    const hcOn = this.hierarchicalCull && !!culler && (!this._geomAppendDeferred || Renderer3D.slicedUploads);
    if (hcOn && this._hcRebuild && !this._geomAppendDeferred) { this._hcRebuild = false; this._buildCullClusters(meshes); }
    const hcT = this._hcTests;
    hcT.inView = this._hcInView; hcT.shadows = buildShadow;
    hcT.inLight = lightCuller ? this._hcInLight : null; hcT.reaches = reach ? this._hcReaches : null;
    this._hcFloorY = floorY;
    let hcMiss = 0, hcSkipped = 0, hcFogSkipped = 0;
    const hcFog = hcOn && fhOn && Renderer3D.hcFogReject;
    // P11 OCCLUSION CULL (occlusion-culler.ts; Renderer3D.occlusionCulling, default off): this frame's building walls
    // rasterised into a small CPU depth buffer; a main-pass mesh / group wholly behind them is not drawn (camera passes
    // only: the shadow lists above are built before this test). Same frame + conservative: nothing can pop.
    const occ = culler ? this._beginOcclusion(meshes) : null;
    if (this.occlusionDebugList) this.occlusionDebugList.length = 0;
    fs.occlCulled = 0; fs.occlTrisCulled = 0;
    // P11 CULL RANGES (cull-ranges.ts): a heavy mesh partly in the view / a cascade draws only its runs that are in it.
    fs.rangeTrisCulled = 0; fs.rangeTrisCulledCascade = 0; fs.rangeBuilds = 0; fs.rangeTrisCulledShadow = 0;
    this._rangePoolN = 0; this._rangeBuildBudget = Renderer3D.CULL_RANGE_BUILD_TRIS;
    const rangeOn = Renderer3D.rangeCulling && !this._planarActive && !(this._ps1.vertexJitter > 0);
    // P14.1 FAR-MAP RANGES (shadow-cache.ts ShadowRunTester): a heavy caster partly outside the light box / the shadow
    // reach submits only its runs inside: the direct list against light box ∩ reach, the static list against the light
    // box alone (it must stay valid while only the camera moves). Exact: a run is dropped only when it is clipped
    // anyway (light box) or cannot shadow a visible receiver (reach, the rule the whole-mesh list already uses).
    const farRangeOn = Renderer3D.shadowRangeCulling && !!lightCuller && !this._planarActive && !(this._ps1.vertexJitter > 0);
    const runT = farRangeOn ? this._shadowRunTester.set(lightCuller, reach, lightDir, floorY) : null;
    // P14.2 NEAR-CASCADE STATIC / DYNAMIC SPLIT: cLists[ci] = the cascade's STATIC casters (light box ∩ cascade box, no
    // camera reach test, so turning the camera keeps the cached layer valid), cDyn[ci] = its dynamic ones (reach-culled,
    // redrawn on every refresh on top of a copy of the static layer). Off = the single reach-culled list per cascade.
    const cSplit = nC > 0 && Renderer3D.cascadeStaticCache;
    this._cascadeSplitLists = cSplit;
    const cDyn = this._cascadeDynLists; cDyn[0].length = 0; cDyn[1].length = 0;
    const cSig = this._cascadeSigs; cSig[0].reset(); cSig[1].reset();
    // P14 joiners (StaticLayerMembers): signatures of all static casters / of those already in each cached layer
    this._joinDeferOn = Renderer3D.staticJoinDefer;
    this._farSigAll.reset(); this._farSigKept.reset(); this._farStaticKeys.length = 0; this._farMembers.beginFrame();
    for (let ci = 0; ci < 2; ci++) { this._cascadeSigsAll[ci].reset(); this._cascadeStaticKeys[ci].length = 0; this._cascadeMembers[ci].beginFrame(); }
    // P15 GPU-DRIVEN main pass: this frame's cull inputs for the compute pass (the same locals the rules below use);
    // every mesh / group the loop visits is stamped, forced records get the CPU verdict, and in LEAN mode the camera
    // tail of a GPU-culled record is skipped (the GPU tests it).
    const gd = this._gdOn ? this._gd : null, gdStamp = this._gdStamp, gdLean = gd !== null && this._gdLean;
    if (gd !== null) {
      const F = this._gdF;
      F.planes = culler ? culler.writePlanes(this._gdPlanes) : null;
      this._gdCam[0] = cpx; this._gdCam[1] = cpy; this._gdCam[2] = cpz;
      F.lodOn = lodOn; F.lodOrtho = lodOrtho; F.orthoD2 = orthoD2; F.lodScale = lodScale; F.lodBias = lodBias;
      F.fogEye = this._fogEye; F.fogCull2 = this._fhCull2; F.fogCullOther = fhCullOther; F.fogCullAttach = fhCullAttach;
      F.hcOn = hcOn; F.groupTwins = Renderer3D.groupTwins;   // Phase B: the twin re-seed rule + the group-twin switch
      F.ranges = rangeOn; F.mergeGap = Renderer3D.CULL_RANGE_MERGE_GAP;   // Phase B: P11 cull ranges (range jobs)
      F.cpuState = GpuDrivenMain.cpuState;   // the LOD / twin hysteresis state is the loop's (GD_CTL_CPU_*)
    }
    // P15 PHASE C: the GPU decides the records' shadow casters this frame (the loop skips their shadow section)
    const gdSh = gd !== null && !this._gdWarm && GpuDrivenMain.shadows && buildShadow && gd.shadowReady;
    this._gdShThis = gdSh;
    if (gd !== null) {
      const S = this._gdS;
      S.on = gdSh;
      if (gdSh) {
        S.light = lightCuller ? lightCuller.writePlanes(this._gdShL) : null;
        S.cascades = nC;
        for (let ci = 0; ci < 2; ci++) S.casc[ci] = ci < nC ? cCull[ci].writePlanes(this._gdShC[ci]) : null;
        S.ldir = lightDir; S.floorY = floorY; S.reach = !!reach;
        S.lodFar = lodTexFar; S.lodC0 = lodTexC[0]; S.lodC1 = lodTexC[1];
        S.cache = cacheLists; S.split = cSplit; S.wind = windOn; S.join = this._joinDeferOn;
        S.band = this._fhBandOn; S.bandAttach = this._fhBandAttach; S.bandIn = this._fhBandIn;
      }
    }

    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (m.arraySourceOnly) continue;   // P12: an instanced-crowd group SOURCE (never drawn itself; its copies are)
      const gdRec = gd !== null ? gd.seeMesh(m) : -1;   // P15: stamped (its record index, or -1)
      if (hcOn) {
        const hc = m._hcC;
        if (hc !== null && hc.owner === this && m._hcVer === m.localMatrixVersion && !m.gpuDirty) {
          if (hc.frame !== hcFrame) {
            hc.frame = hcFrame; hc.verdict = clusterVerdict(hc, hcT);
            // FOG HORIZON cluster reject (2026-10-01): the cluster's whole union box past the fog edge x 1.01 -> every
            // member's box is too (a member keeps its build-time box while its matrix version holds, checked below).
            hc.fogPast = hcFog && this._fogBoxPast(hc.box[0], hc.box[1], hc.box[2], hc.box[3], hc.box[4], hc.box[5]);
          }
          const e = m._r3Aabb as MeshAABBEntry | null;
          if (hc.verdict !== HC_PASS && e !== null && e.owner === this && !e.dead && e.ref === m && e.matVersion === m.localMatrixVersion) {
            fs.trisTotal += m._hcTris | 0; fs.meshesCulled++; hcSkipped++;
            if (e.wMinY < nextFloor) nextFloor = e.wMinY;
            if (e.wMaxY > nextTop) nextTop = e.wMaxY;
            // Off view and its shadow misses the view: only the P4.2 static shadow cache still wants it (as the full
            // path below would add it: drawn by its LOD / twin state, opaque, fine enough for the far map, static).
            if (hc.verdict === HC_NOREACH && gdSh && gdRec >= 0 && !m._gdKF) gd!.markNoReach(gdRec);   // P15 Phase C: the GPU's static push
            else if (hc.verdict === HC_NOREACH && cacheLists && m.material.opacity >= 1 && !m.lodHidden
                && !((m.fogClass === 2 ? fhCullOther : m.fogClass === 1 && fhCullAttach) && !m.material.noFog && this._fogBoxPast(e.wMinX, e.wMinY, e.wMinZ, e.wMaxX, e.wMaxY, e.wMaxZ))
                && (m.lodTwinRole === 0 || twinDraws(m.lodTwinRole, m.lodTwinNear, m.lodTwinNear2))
                && !(m.shadowFeatureSize > 0 && m.shadowFeatureSize < lodTexFar) && !this._casterIsDynamic(m, windOn)) {
              const slot = this._meshInstanceSlots.get(m.id) ?? i;
              this._pushDraw(staticList, m, slot);
              this._farStatic(m, this._lastCasterUid, slot, 1, m._hcTris | 0, null);
            }
            continue;
          }
        } else if (m._hcB !== this._hcSerial || (hc !== null && m._hcVer !== m.localMatrixVersion)) hcMiss++;   // new since the build, or a member that moved
        // A twin that sat in a rejected cluster re-seeds its swap state (its pair partner does the same), so two
        // twins of one chunk never come back with different hysteresis histories.
        if (m.lodTwinRole !== 0 && !m.lodTwinExternal && m._hcSeen !== hcFrame - 1) { m.lodTwinNear = false; m.lodTwinNear2 = true; }
        m._hcSeen = hcFrame;
        if (gd !== null) gd.markVisited(m, gdRec);   // P15 Phase B: past the hierarchical cull (GD_CTL_VISITED)
        // FOG HORIZON cluster reject: a member of a cluster wholly past the fog edge whose own class is culled ends
        // exactly where the fog test below would end it (that test runs before the distance LOD / twin updates, so
        // they are skipped either way): the same lists and state, without the box fetch and the per-mesh test.
        // Members of a cullable class only; a building member (class 0) or a no-fog one falls through.
        if (hc !== null && hc.fogPast && hc.frame === hcFrame && hc.owner === this && m._hcVer === m.localMatrixVersion && !m.gpuDirty
            && (m.fogClass === 2 ? fhCullOther : m.fogClass === 1 && fhCullAttach) && !m.material.noFog) {
          const e = m._r3Aabb as MeshAABBEntry | null;
          if (e !== null && e.owner === this && !e.dead && e.ref === m && e.matVersion === m.localMatrixVersion) {
            const t = m._hcTris | 0;
            fs.trisTotal += t; fs.fogHidden++; fs.fogTrisHidden += t; hcFogSkipped++;
            if (e.wMinY < nextFloor) nextFloor = e.wMinY;
            if (e.wMaxY > nextTop) nextTop = e.wMaxY;
            m.fogHidden = true;
            continue;
          }
        }
      }
      if (m._r3o !== this || m._r3g !== this._r3Gen || !fastLoop) {
        m._r3o = this; m._r3g = this._r3Gen;
        const mid = m.id;
        m._r3GA = this._geomAllocs.get(mid); m._r3Slot = this._meshInstanceSlots.get(mid) ?? -1;
      }
      const gdCull = gdRec >= 0 && gd!.syncMesh(m, gdRec, i);   // P15: record re-checked; true = the GPU culls it
      const alloc = m._r3GA as GeomAlloc | undefined;
      // P5: geometry still queued by the time-sliced append → not drawable yet. Keep it out of every list (and so out
      // of the P4.2 static-shadow signature, which then changes when it lands and refreshes the cached map).
      if (!alloc && this._geomAppendDeferred && m.geometry && m.geometry.vertices.length > 0) continue;
      const tris = alloc ? (alloc.indexCount / 3) | 0 : 0;   // P9: an int (a double here was boxed per mesh below TurboFan)
      fs.trisTotal += tris;
      let bb: AABB3 | null = null;
      const lodMesh = lodOn && m.drawDistance > 0;
      if (culler || lightCuller || lodMesh) {
        // P9: inline cache hit (the common case: a static mesh whose entry is current) — getMeshWorldAABB3D's
        // getters + call were ~15 % of the draw-list build in a tiled city.
        const e = m._r3Aabb as MeshAABBEntry | null;
        if (fastLoop && e !== null && e.owner === this && !e.dead && e.ref === m && e.matVersion === m.localMatrixVersion && !m.gpuDirty) {
          const s = this._aabbScratch;
          s.minX = e.wMinX; s.minY = e.wMinY; s.minZ = e.wMinZ; s.maxX = e.wMaxX; s.maxY = e.wMaxY; s.maxZ = e.wMaxZ;
          bb = s;
        } else bb = this.getMeshWorldAABB3D(m, this._aabbScratch);
      }
      if (bb && bb.minY < nextFloor) nextFloor = bb.minY;
      if (bb && bb.maxY > nextTop) nextTop = bb.maxY;
      // FOG HORIZON CULL (see above). Since 2026-10-01 BEFORE the distance LOD / twin updates: a fog-culled mesh's
      // hysteresis state (lodHidden, the twin choice) is held while it is past the fog and picked up where it was when
      // it comes back (both twins of a pair share one box and class, so they are culled together and stay in step).
      // This makes the cluster-level reject above exact (it skips the same updates) and fog-culled meshes cheaper.
      if ((m.fogClass === 2 ? fhCullOther : m.fogClass === 1 && fhCullAttach) && !m.material.noFog) {   // noFog: never fog-culled
        if (!bb) bb = this.getMeshWorldAABB3D(m, this._aabbScratch);
        if (bb && this._fogBoxPast(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ)) { m.fogHidden = true; fs.fogHidden++; fs.fogTrisHidden += tris; continue; }
      }
      if (m.fogHidden) m.fogHidden = false;
      let camD2 = -1;   // P9: camera → box squared distance, computed inline once (aabbDistanceSq / distanceLodHidden, unrolled)
      if (lodMesh && bb) {
        if (lodOrtho) camD2 = orthoD2;
        else {
          const dx = cpx < bb.minX ? bb.minX - cpx : cpx > bb.maxX ? cpx - bb.maxX : 0;
          const dy = cpy < bb.minY ? bb.minY - cpy : cpy > bb.maxY ? cpy - bb.maxY : 0;
          const dz = cpz < bb.minZ ? bb.minZ - cpz : cpz > bb.maxZ ? cpz - bb.maxZ : 0;
          camD2 = dx * dx + dy * dy + dz * dz;
        }
        const far = (m.drawDistance + lodBias * m.drawDistanceBias) * lodScale;
        if (m.lodHidden) { const sh = far * DISTANCE_LOD_SHOW; m.lodHidden = camD2 >= sh * sh; } else m.lodHidden = camD2 > far * far;
        if (m.lodHidden) { fs.lodHidden++; fs.lodTrisHidden += tris; if (gdRec >= 0) gd!.cpuMesh(gdRec, m); continue; }
      } else if (m.lodHidden) m.lodHidden = false;
      // E2 NEAR/FAR TWIN (chipped edges near only): both twins of a chunk share its box, threshold and hysteresis
      // rule (same starting state), so exactly one of them draws. No aerial bias — chips are invisible from the air.
      if (m.lodTwinRole !== 0) {
        if (!bb) bb = this.getMeshWorldAABB3D(m, this._aabbScratch);
        const tb = bb, role = m.lodTwinRole;
        // P9: roles 3 / 4 (mid / xfar of a three-tier family) also track the second threshold; a degraded prop far
        // twin (lodTwinOffNear) yields to its near twin whenever the distance cannot decide (LOD off).
        // P8: the A/B switch Renderer3D.groupTwins = false also keeps the instanced tree crowns' instance 0 (this mesh) near.
        if (m.lodTwinExternal) { /* P12: the owner (world-crowd.ts) set the state */ }
        else if (!lodOn || !tb || (m.lodTwinInstanced && !Renderer3D.groupTwins)) { m.lodTwinNear = m.lodTwinOffNear; m.lodTwinNear2 = true; }
        else {
          const td2 = camD2 >= 0 ? camD2 : lodOrtho ? orthoD2 : aabbDistanceSq(cpx, cpy, cpz, tb.minX, tb.minY, tb.minZ, tb.maxX, tb.maxY, tb.maxZ);
          if (role !== 4) m.lodTwinNear = m.lodTwinDist > 0 ? !distanceLodHidden(td2, m.lodTwinDist * lodScale, !m.lodTwinNear) : m.lodTwinOffNear;
          if (role >= 3) m.lodTwinNear2 = m.lodTwinDist2 > 0 ? !distanceLodHidden(td2, m.lodTwinDist2 * lodScale, !m.lodTwinNear2) : true;
        }
        if (!twinDraws(role, m.lodTwinNear, m.lodTwinNear2)) { fs.lodHidden++; fs.lodTrisHidden += tris; if (gdRec >= 0) gd!.cpuMesh(gdRec, m); continue; }
      }
      if (gdRec >= 0) gd!.cpuMesh(gdRec, m);   // P15: the loop's LOD / twin state for the cull (GD_CTL_CPU_*)
      // Shadow caster (light box) — independent of the camera test. Opaque only; a multi-material mesh is ONE full-
      // geometry entry (the opaqueForPasses dedup rule: first opaque submesh's slot, no submesh).
      let singleSlot = -1;   // P6: the single-material slot, looked up once for both lists
      if (buildShadow && !(gdSh && gdRec >= 0 && !m._gdKF)) {   // P15 Phase C: a GPU record's casters are the GPU's
        if (bb && lightCuller && !(fastLoop ? lightCuller.testBox(bb) : lightCuller.testAABB(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ))) fs.shadowCulled++;
        else {
          const reachOk = !(bb && reach && !(fastLoop ? shadowReachesViewBox(reach, lightDir, floorY, bb) : shadowReachesView(reach, lightDir, floorY, bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ)));
          if (!reachOk) fs.shadowOffView++;
          // The one opaque slot this mesh casts from (multi-material: the first opaque submesh's slot).
          let slot = -1;
          if (m.submeshes.length > 0) {
            const slots = this._meshSubmeshSlots.get(m.id);
            for (let si = 0; si < m.submeshes.length; si++) {
              if (m.submeshes[si].material.opacity < 1) continue;
              if (!shadowSeen.has(m.id)) { shadowSeen.add(m.id); slot = slots?.[si] ?? 0; }
              break;
            }
          } else if (m.material.opacity >= 1) slot = singleSlot = m._r3Slot >= 0 ? m._r3Slot : i;
          const fsz = m.shadowFeatureSize;
          // P8 SHADOW LOD: the far map's texel is too coarse for this caster — it stays out of the far map (and its
          // P4.2 static set / signature) but may still cast into a near cascade fine enough for it.
          const farSkip = slot >= 0 && fsz > 0 && fsz < lodTexFar;
          // One static / dynamic verdict for the P4.2 far cache and the P14 cascade split (_casterIsDynamic also
          // looks up the caster uid of the signatures). Without the split it is asked exactly where P4.2 asked it.
          const isDyn = slot >= 0 && ((cacheLists && !farSkip) || cSplit) ? this._casterIsDynamic(m, windOn) : false;
          const cUid = this._lastCasterUid;
          let whole: RendererDrawEntry | null = null;   // this caster's full-geometry entry (shared by the lists)
          if (farSkip) {
            fs.shadowLodFar++;
            if (reachOk && !cSplit) {
              let ce: RendererDrawEntry | null = null;
              for (let ci = 0; ci < nC; ci++) {
                if (fsz < lodTexC[ci]) { fs.shadowLodCascade++; continue; }
                if (bb && !(fastLoop ? cCull[ci].testBox(bb) : cCull[ci].testAABB(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ))) continue;
                if (ce) cLists[ci].push(ce); else { this._pushDraw(cLists[ci], m, slot); ce = cLists[ci][cLists[ci].length - 1]; }
              }
            }
          } else if (slot >= 0) {
            const rgF = runT !== null && bb && tris >= Renderer3D.CULL_RANGE_MIN_TRIS ? this._rangesFor(m, alloc) : null;
            // (P14.1: a ranged caster carries its run table; the far map's lists are expanded only when it renders)
            if (reachOk) { this._pushDraw(shadowList, m, slot); whole = shadowList[shadowList.length - 1]; if (rgF !== null) whole.frg = rgF; }
            if (cacheLists) {
              if (isDyn) { if (whole !== null) dynList.push(whole); }
              else {
                if (whole !== null) staticList.push(whole);
                else { this._pushDraw(staticList, m, slot); whole = staticList[staticList.length - 1]; if (rgF !== null) whole.frg = rgF; }
                this._farStatic(m, cUid, slot, 1, tris, reachOk ? whole : null);   // cUid == _casterUidOf(m): _casterIsDynamic just looked it up
              }
            }
          }
          // NEAR CASCADES: every caster the far map kept (reach-culled; split: the static ones without the reach test,
          // so the cached static layer does not depend on where the camera looks) that touches the cascade's box.
          if (nC > 0 && slot >= 0 && (cSplit || (reachOk && !farSkip))) {
            for (let ci = 0; ci < nC; ci++) {
              if (fsz > 0 && fsz < lodTexC[ci]) { fs.shadowLodCascade++; continue; }   // P8: too small for this cascade
              if (bb && !(fastLoop ? cCull[ci].testBox(bb) : cCull[ci].testAABB(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ))) continue;
              if (cSplit && isDyn && !reachOk) continue;   // a dynamic caster is redrawn every refresh: reach-culled
              const list = cSplit && isDyn ? cDyn[ci] : cLists[ci];
              const rg = rangeOn && bb && tris >= Renderer3D.CULL_RANGE_MIN_TRIS && !cCull[ci].containsBox(bb) ? this._rangesFor(m, alloc) : null;
              if (cSplit && !isDyn) {
                // a cached static layer: ranges are expanded only when it re-renders (_expandRanges, crg)
                if (whole !== null) list.push(whole); else { this._pushDraw(list, m, slot); whole = list[list.length - 1]; }
                if (rg) whole.crg = rg;
                this._cascStatic(ci, m, cUid, slot, ci + 1, tris, reachOk ? whole : null);
              }
              else if (rg) fs.rangeTrisCulledCascade += tris - this._rangedPush(list, m, slot, rg, cCull[ci]);
              else if (whole !== null) list.push(whole);
              else { this._pushDraw(list, m, slot); whole = list[list.length - 1]; }
            }
          }
        }
      }
      // P15 Phase B: a heavy record's run table (the range job draws only its runs in the view)
      if (gdRec >= 0 && rangeOn && tris >= Renderer3D.CULL_RANGE_MIN_TRIS) gd!.syncRanges(gdRec, this._gdRangeTable(m, alloc, bb, culler));
      if (gdLean && gdCull) continue;   // P15: the GPU culls + draws it
      if (culler && bb && !(fastLoop ? culler.testBox(bb) : culler.testAABB(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ))) { fs.meshesCulled++; continue; }
      if (occ !== null && bb && !occ.testBox(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ) && !this._occlExempt(m)) { fs.occlCulled++; fs.occlTrisCulled += tris; if (this.occlusionDebugList) this.occlusionDebugList.push(m); continue; }
      if (rangeOn && culler && bb && tris >= Renderer3D.CULL_RANGE_MIN_TRIS && m.submeshes.length === 0 && m.material.opacity >= 1 && !culler.containsBox(bb)) {
        const rg = this._rangesFor(m, alloc);
        if (rg) {
          const kept = this._rangedPush(opaque, m, singleSlot >= 0 ? singleSlot : (m._r3Slot >= 0 ? m._r3Slot : i), rg, culler);
          fs.rangeTrisCulled += tris - kept;
          if (kept === 0) fs.meshesCulled++; else { fs.trisVisible += kept; if (gd !== null) { m._gdVis = gdStamp; if (gdRec >= 0) gd.markVis(gdRec); } }
          continue;
        }
      }
      if (gd !== null) { m._gdVis = gdStamp; if (gdRec >= 0) gd.markVis(gdRec); }   // P15: the CPU path draws it this frame
      fs.trisVisible += tris;
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
        const idx = singleSlot >= 0 ? singleSlot : (m._r3Slot >= 0 ? m._r3Slot : i);
        if (m.material.opacity < 1) this._pushDraw(transparent, m, idx);
        else this._pushDraw(opaque, m, idx);
      }
    }

    // Add GPU-instanced array group draw entries (no Mesh3D copies — instances computed from params).
    // Each instance uses the source mesh's geometry; slots are contiguous immediately after source slot.
    for (let _kgroup = 0; _kgroup < this._arrayGroups.length; _kgroup++) { const group = this._arrayGroups[_kgroup];
      const firstSlot = this._arrayGroupFirstSlot.get(group.id);
      if (firstSlot === undefined) continue;
      const sourceMesh = this._meshById.get(group.sourceId);   // O(1) (map built in uploadMeshInstances, which ran earlier this frame)
      if (!sourceMesh || sourceMesh.submeshes.length > 0) continue;
      const N = getArrayInstanceCount(group.arrayParams);
      if (N <= 0) continue;
      const gdGRec = gd !== null ? gd.seeGroup(group, firstSlot, sourceMesh, N) : -1;   // P15: stamped + re-checked
      // P8 INSTANCED NEAR/FAR TWINS (the far tree crowns; Renderer3D.groupTwins): a near group draws only while the
      // camera is within lodTwinDist of its instances' ORIGIN box, the far group otherwise. The two groups of a twin
      // pair hold the identical transforms (chunkCityLayers splits them on one grid), so they test the identical box
      // with the same hysteresis history and exactly one of them draws. Evaluated before every other skip so both
      // stay in lockstep. The far crown is a degraded copy: twins off / distance LOD off / no box → the near group.
      const twinRole = sourceMesh.lodTwinRole;
      if (twinRole !== 0 && sourceMesh.lodTwinExternal) {
        // P12 EXTERNALLY DRIVEN group twin (the instanced crowd's xfar cells, world-crowd.ts): the owner decided.
        if (!twinDraws(twinRole, sourceMesh.lodTwinNear, sourceMesh.lodTwinNear2)) { const ta = this._geomAllocs.get(sourceMesh.id); fs.lodHidden++; fs.lodTrisHidden += ta ? (ta.indexCount / 3) * N : 0; continue; }
      } else if (twinRole === 1 || twinRole === 2) {
        let near = true;
        if (Renderer3D.groupTwins && lodOn && sourceMesh.lodTwinDist > 0) {
          const tbx = this._arrayGroupWorldAABB(group, sourceMesh);
          if (gdGRec >= 0) gd!.groupBox(gdGRec, tbx);   // P15 Phase B: the record's origin box follows the cache
          const ob = this._agAABBCache.get(group.id)?.org;
          if (ob) {
            const was = this._lodTwinNearGroups.has(group.id);
            near = !distanceLodHidden(lodOrtho ? orthoD2 : aabbDistanceSq(cpx, cpy, cpz, ob[0], ob[1], ob[2], ob[3], ob[4], ob[5]), sourceMesh.lodTwinDist * lodScale, !was);
            if (near !== was) { if (near) this._lodTwinNearGroups.add(group.id); else this._lodTwinNearGroups.delete(group.id); }
          }
        }
        if (gdGRec >= 0) gd!.cpuGroupNear(gdGRec, near);   // P15: the loop's twin state for the cull
        if ((twinRole === 1) !== near) { const ta = this._geomAllocs.get(sourceMesh.id); fs.lodHidden++; fs.lodTrisHidden += ta ? (ta.indexCount / 3) * N : 0; continue; }
      }
      const aAlloc = this._geomAllocs.get(sourceMesh.id);
      if (!aAlloc && this._geomAppendDeferred) continue;   // P5: source geometry not resident yet (time-sliced append)
      const gTris = aAlloc ? (aAlloc.indexCount / 3) * N : 0;
      fs.trisTotal += gTris;
      // Whole-group frustum cull (per-cell chunked groups off-screen skip all instances; a city-wide group spans
      // everything → never culls). Also the shadow test, against the light box.
      const lodGroup = lodOn && sourceMesh.drawDistance > 0;
      const gb = culler || lightCuller || lodGroup ? this._arrayGroupWorldAABB(group, sourceMesh) : null;
      if (gdGRec >= 0 && gb !== null) gd!.groupBox(gdGRec, gb);   // P15: the record follows the group's box
      if (lodGroup && gb) {
        const was = this._lodHiddenGroups.has(group.id);
        const hid = distanceLodHidden(lodOrtho ? orthoD2 : aabbDistanceSq(cpx, cpy, cpz, gb[0], gb[1], gb[2], gb[3], gb[4], gb[5]), (sourceMesh.drawDistance + lodBias * sourceMesh.drawDistanceBias) * lodScale, was);
        if (hid !== was) { if (hid) this._lodHiddenGroups.add(group.id); else this._lodHiddenGroups.delete(group.id); }
        if (gdGRec >= 0) gd!.cpuGroupLod(gdGRec, hid);   // P15: the loop's LOD state for the cull
        if (hid) { if (gb[1] < nextFloor) nextFloor = gb[1]; fs.lodHidden++; fs.lodTrisHidden += gTris; continue; }
      } else {
        if (this._lodHiddenGroups.size > 0 && this._lodHiddenGroups.has(group.id)) this._lodHiddenGroups.delete(group.id);
        if (gdGRec >= 0) gd!.cpuGroupLod(gdGRec, false);
      }
      // FOG HORIZON CULL (see the mesh loop): the group's whole box past the fog edge.
      if ((sourceMesh.fogClass === 2 ? fhCullOther : sourceMesh.fogClass === 1 && fhCullAttach) && !sourceMesh.material.noFog) {
        const fb = gb ?? this._arrayGroupWorldAABB(group, sourceMesh);
        if (gdGRec >= 0 && gb === null) gd!.groupBox(gdGRec, fb);
        if (fb && this._fogBoxPast(fb[0], fb[1], fb[2], fb[3], fb[4], fb[5])) { if (fb[1] < nextFloor) nextFloor = fb[1]; fs.fogHidden++; fs.fogTrisHidden += gTris; continue; }
      }
      // Shadow: an opted-in (castsInstancedShadow) opaque group is one instanced-range caster, light-box culled.
      if (gb && gb[1] < nextFloor) nextFloor = gb[1];
      if (gb && gb[4] > nextTop) nextTop = gb[4];
      if (buildShadow && sourceMesh.castsInstancedShadow && sourceMesh.material.opacity >= 1 && !(gdSh && gdGRec >= 0 && !gd!.isForced(gdGRec))) {
        const gfs = sourceMesh.shadowFeatureSize;
        if (gb && lightCuller && !lightCuller.testAABB(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5])) fs.shadowCulled++;
        else if (gfs > 0 && gfs < lodTexFar) {
          // P8 SHADOW LOD (see the mesh loop): out of the far map; the near cascades that can resolve it keep it.
          fs.shadowLodFar++;
          const gReach = !(gb && reach && !shadowReachesView(reach, lightDir, floorY, gb[0], gb[1], gb[2], gb[3], gb[4], gb[5]));
          if (cSplit) this._groupCascades(group, sourceMesh, firstSlot, N, gb, null, gReach, windOn, gfs, gTris);
          else if (gReach) {
            let ce: RendererDrawEntry | null = null;
            for (let ci = 0; ci < nC; ci++) {
              if (gfs < lodTexC[ci]) { fs.shadowLodCascade++; continue; }
              if (gb && !cCull[ci].testAABB(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5])) continue;
              if (ce) cLists[ci].push(ce); else { this._pushDraw(cLists[ci], sourceMesh, firstSlot, undefined, N); ce = cLists[ci][cLists[ci].length - 1]; }
            }
          }
        } else {
          const reachOk = !(gb && reach && !shadowReachesView(reach, lightDir, floorY, gb[0], gb[1], gb[2], gb[3], gb[4], gb[5]));
          let se: RendererDrawEntry | null = null;
          if (!reachOk) fs.shadowOffView++;
          else {
            this._pushDraw(shadowList, sourceMesh, firstSlot, undefined, N);
            se = shadowList[shadowList.length - 1];
            if (!cSplit) {
              for (let ci = 0; ci < nC; ci++) {
                if (gfs > 0 && gfs < lodTexC[ci]) { fs.shadowLodCascade++; continue; }
                if (!gb || cCull[ci].testAABB(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5])) cLists[ci].push(se);
              }
            }
          }
          if (cacheLists) {   // P4.2: wind-swayed groups (trees) are dynamic; the rest join the static set
            if (this._groupCasterDynamic(sourceMesh, gb, windOn)) { if (se) dynList.push(se); }
            else {
              if (se) staticList.push(se); else this._pushDraw(staticList, sourceMesh, firstSlot, undefined, N);
              this._farStatic(group, this._casterUidOf(sourceMesh) ^ 0x5bd1e995, firstSlot * 65599 + N, sourceMesh.localMatrixVersion, gTris, se);
            }
          }
          if (cSplit) this._groupCascades(group, sourceMesh, firstSlot, N, gb, se, reachOk, windOn, gfs, gTris);
        }
      }
      // P22 propCull: an instanced prop group's runs of copies (CPU: spans below; GPU: a range job in instance mode)
      const propTab = P22_RENDER.propCull && group.instanceXf && N >= Renderer3D.PROP_CULL_MIN && sourceMesh.material.opacity >= 1 ? this._propCullTable(group, sourceMesh, N) : null;
      if (gdGRec >= 0) gd!.syncRanges(gdGRec, propTab);
      if (gdLean && gd!.gpuCulls(gdGRec)) continue;   // P15: the GPU culls + draws it
      if (culler && gb && !culler.testAABB(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5])) { fs.groupsCulled++; fs.instancesCulled += N; continue; }
      if (occ !== null && gb && !occ.testBox(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5]) && !this._occlExempt(sourceMesh)) { fs.occlCulled++; fs.occlTrisCulled += gTris; if (this.occlusionDebugList) this.occlusionDebugList.push(group); continue; }
      if (gd !== null) { group._gdVis = gdStamp; if (gdGRec >= 0) gd.markVis(gdGRec); }   // P15: the CPU path draws it
      fs.trisVisible += gTris;
      if (sourceMesh.material.opacity < 1) {
        // Transparent instances need per-instance back-to-front ordering — keep one entry each.
        for (let i = 0; i < N; i++) this._pushDraw(transparent, sourceMesh, firstSlot + i);
      } else {
        // OPAQUE: ONE instanced-range entry (count=N) for the whole group. Was N per-instance entries → the entire
        // per-frame draw pipeline (filter/sort/shadow-dedup/batch) ran O(total instances); with the city greenery
        // visible that's ~18K entries EVERY frame = the 60→33fps zoom-in cliff. Depth-test orders opaque, so the
        // slots are already contiguous — one drawMesh(firstSlot, N) draws them all.
        // P22 propCull: an instanced prop group partly in the view draws only its runs of copies whose box passes
        // (whole runs outside a plane are clipped anyway: the same pixels), as one entry per kept span
        const pt = propTab !== null && culler && gb && !culler.containsAABB(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5]) ? propTab : null;
        if (pt) {
          const sp = this._propSpans, kept = Math.round(selectRanges(pt, culler!, sp, Renderer3D.PROP_CULL_GAP) * 3);   // (its count / 3 → copies)
          for (let s = 0; s < sp.length; s += 2) { this._pushDraw(opaque, sourceMesh, firstSlot + sp[s], undefined, sp[s + 1]); if (gd !== null) opaque[opaque.length - 1].gdObj = group; }
          if (aAlloc) { const cut = (aAlloc.indexCount / 3) * (N - kept); fs.trisVisible -= cut; this._propCulledTris += cut; }
        } else {
          this._pushDraw(opaque, sourceMesh, firstSlot, undefined, N);
          if (gd !== null) opaque[opaque.length - 1].gdObj = group;
        }
      }
    }

    // For shadow and outline passes: deduplicate multi-submesh meshes so each
    // mesh's full geometry is drawn once (not once per submesh). Pooled + reused.
    const opaqueForPasses = this._opaqueForPasses; opaqueForPasses.length = 0;
    {
      const seen = this._opaqueSeen; seen.clear();
      for (let _ke = 0; _ke < opaque.length; _ke++) { const e = opaque[_ke];
        // Instanced detail (greenery / juliet / window-trim — the count>1 array-group ranges) does NOT cast
        // shadows or feed the outline depth pass: at city scale those shadows/edges are invisible, but
        // redrawing ~18K instances into the shadow map (every 3rd frame) is a big GPU cost. The MAIN pass
        // still draws them (visible).
        // ★ EXCEPT when the instanced thing is big enough to matter. A blanket count>1 filter was written
        // when the only instanced content was centimetre-scale building trim; it now also caught the city's
        // TREES, so a park full of 6 m trees cast nothing at all. `castsInstancedShadow` is the opt-in.
        if ((e.count ?? 1) > 1 && !e.mesh.castsInstancedShadow) continue;
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
    // Pre-Round-5 behaviour (toggle off / shadows suspended): the shadow pass replays the camera-culled pass list.
    if (!buildShadow) for (let _ke = 0; _ke < opaqueForPasses.length; _ke++) shadowList.push(opaqueForPasses[_ke]);
    if (!buildShadow) for (let ci = 0; ci < this._cascadeCount; ci++) for (let _ke = 0; _ke < shadowList.length; _ke++) cLists[ci].push(shadowList[_ke]);
    fs.shadowCasters = shadowList.length;
    fs.cascadeCasters = cLists[0].length + cLists[1].length;
    if (gdSh) this._gdShEpochMix();   // P15 Phase C: the GPU casters' leavers / joiners into the static-layer signatures
    if (cacheLists) {
      this._shadowStaticSig = (this._sigSum ^ Math.imul(this._sigXor, 31) ^ Math.imul(staticList.length, 0x01000193)) | 0;
      if (this._joinDeferOn) { this._shadowStaticSig = this._farSigKept.value; this._shadowStaticSigAll = this._farSigAll.value; }   // P14 joiners
    }
    {
      this._farMembers.endFrame(); this._cascadeMembers[0].endFrame(); this._cascadeMembers[1].endFrame();
      this._shadowCacheStats.staticCasters = staticList.length; this._shadowCacheStats.dynCasters = dynList.length;
    }
    this._sceneTopY = nextTop;
    this._sceneFloorY = nextFloor;
   // next frame's shadow-reach floor (Infinity when nothing had bounds → reach test off)
    // P9: rebuild the clusters once enough of the roster is unclustered (new / moved meshes) for 30 frames running.
    this._hcStats.skipped = hcSkipped; this._hcStats.fogSkipped = hcFogSkipped;
    if (hcOn && hcMiss > Math.max(48, meshes.length * 0.03)) { if (++this._hcMissFrames >= 30) { this._hcMissFrames = 0; this._hcRebuild = true; } }
    else this._hcMissFrames = 0;
    fs.msCull = performance.now() - _tc0;
    // Last pool push happened above (opaqueForPasses). Trim the pool to this frame's high-water so stale
    // entries don't PIN removed meshes (holding their geometry) after the scene shrinks. Stable city =
    // length === _drawPoolN → no-op; only a genuine shrink drops (and later regrows) the tail.
    if (this._drawPool.length > this._drawPoolN) this._drawPool.length = this._drawPoolN;
  }

  /** P2 (docs/specs/performance-plan.md): set `p` on the pass, or — when it is still compiling asynchronously —
   *  flag the following _drawMesh / _replayRuns calls as SKIPPED until the next _setPipe. Every setPipeline that
   *  precedes _drawMesh goes through here, so the flag is always re-armed per run. Returns false when pending. */
  private _skipDraws = false;
  private _pipeSkips = 0;
  private _setPipe(pass: GPURenderPassEncoder, p: GPURenderPipeline | null, fallback: GPURenderPipeline | null = null): boolean {
    if (!p) { this._skipDraws = true; this._pipeSkips++; return false; }
    pass.setPipeline(p);
    this._skipDraws = false;
    // P22: the full-format pipeline is bound (a new encoder: nothing else of it is known). `fallback` = a pipeline with
    // the same output whose twin a packed draw may use while `p`'s compiles (a shader variant's base pipeline).
    if (pass !== this._pkEnc) { this._pkEnc = pass; this._pkIbKnown = false; this._pkTanEnc = null; }
    this._pkBase = p; this._pkFb = fallback !== p ? fallback : null; this._pkTwin = false;
    return true;
  }
  // P22 packed draws (CPU path): the pipeline the caller bound with _setPipe (`_pkBase`) and what _drawMesh switched on
  // `_pkEnc` since — its packed twin (`_pkTwin`), the index format (`_pkIb16`, valid while `_pkIbKnown`), the
  // constant-tangent buffer in slot 1 (`_pkTanEnc`). Code that rebinds the pool's buffers itself, or executes a render
  // bundle (which clears the pass state), calls `_pkLost(pass)`; the next draw then binds the format explicitly.
  private _pkEnc: GPURenderPassEncoder | null = null;
  private _pkBase: GPURenderPipeline | null = null;
  private _pkFb: GPURenderPipeline | null = null;
  private _pkTwin = false;
  private _pkIb16 = false;
  private _pkIbKnown = false;
  private _pkTanEnc: GPURenderPassEncoder | null = null;
  /** Draws skipped because a packed twin was still compiling (diagnostics). */
  private _pkSkips = 0;
  /** `pass`'s buffers were rebound / its state cleared by other code: forget what is bound. */
  private _pkLost(pass: GPURenderPassEncoder): void { if (pass === this._pkEnc) { this._pkIbKnown = false; this._pkTanEnc = null; } }
  /** Bind the format of `pk` on `enc` before a pooled draw. False = skip this draw (the twin is compiling). */
  private _pkPrepare(enc: GPURenderPassEncoder, pk: boolean): boolean {
    if (enc !== this._pkEnc) {
      if (!pk) return true;   // an encoder no _setPipe ran on draws as it always did
      this._pkEnc = enc; this._pkBase = null; this._pkFb = null; this._pkTwin = false; this._pkIbKnown = false; this._pkTanEnc = null;
    }
    if (pk !== this._pkTwin) {
      if (pk) {
        const tw = packedTwin(this.device, this._pkBase) ?? (this._pkFb ? packedTwin(this.device, this._pkFb) : null);
        if (!tw) { this._pkSkips++; this.onDeferredWork?.(); return false; }
        enc.setPipeline(tw);
      } else if (this._pkBase) enc.setPipeline(this._pkBase);
      this._pkTwin = pk;
    }
    if (pk && this._pkTanEnc !== enc) { enc.setVertexBuffer(1, constTangentBuffer(this.device)); this._pkTanEnc = enc; }
    if (!this._pkIbKnown || this._pkIb16 !== pk) {
      enc.setIndexBuffer(this._geomIB!, pk ? 'uint16' : 'uint32');
      this._pkIb16 = pk; this._pkIbKnown = true;
    }
    return true;
  }
  /** P2.2 — document-driven warm-up: when the mesh roster changes, queue (DOCUMENT priority, ahead of the generic
   *  common set) every pipeline variant these meshes route to — textured/untextured × plain/patterned × cull ×
   *  shadow-receiving, transparent, skinned, and the shadow casters. Visible meshes already requested theirs at top
   *  priority via the draw itself; this catches the off-screen rest (a character behind the camera, a mirror). */
  private _prewarmSeen = { opaque: -1, skinned: -1, shadows: false };
  /** Step 2: classify each mesh into a 5-bit variant code (no per-mesh string building) and queue only the pipeline
   *  names not already queued for this Pipeline3D. `false` = the old per-mesh name Set (A/B reference). */
  prewarmNewOnly = true;
  private readonly _prewarmQueued = new Set<string>();
  private _prewarmGen = 0;
  private _prewarmFds = false;
  private _prewarmSh = false;
  private _prewarmSplit = false;
  private static _prewarmGenSeq = 0;
  private _prewarmPipe: unknown = null;
  private readonly _prewarmCodes = new Uint8Array(32);
  /** Diagnostics: how many names the last roster change actually queued. */
  private _prewarmLastQueued = 0;
  private _prewarmForScene(meshes: readonly Mesh3D[], skinned: boolean): void {
    const k = skinned ? 'skinned' : 'opaque';
    if (this._prewarmSeen[k] === meshes.length && this._prewarmSeen.shadows === this._shadowsEnabled) return;
    this._prewarmSeen[k] = meshes.length; this._prewarmSeen.shadows = this._shadowsEnabled;
    if (this.prewarmNewOnly) { this._prewarmCoded(meshes, skinned); return; }
    const names = new Set<string>();
    const sh = this._shadowsEnabled ? 'Shadow' : '';
    for (const m of meshes) {
      const T = (m.material.hasTexture || m.material.hasNormalMap) ? 'Textured' : 'Untextured';
      const plain = this._usesPatterns(m) ? '' : 'Plain';
      if (skinned) { names.add(`skinnedOpaque${T}${plain}Pipeline`); continue; }
      const noCull = (this.forceDoubleSided || !!m.material.doubleSided) ? 'NoCull' : '';
      if (m.material.opacity < 1) { names.add(`transparent${T}${noCull}Pipeline`); continue; }
      names.add(`opaque${T}${noCull}${plain}${sh}Pipeline`);
      if (m.submeshes.length > 0) names.add(`opaque${T}${noCull}${sh}Pipeline`);   // multi-material → full variant
    }
    if (sh) names.add(skinned ? 'skinnedShadowPipeline' : 'shadowPassPipeline');
    this.pipeline.warmPipelines([...names], PIPELINE_PRIORITY.DOCUMENT);
  }
  /** The same name set as the loop above, from per-mesh variant bits: 1 textured · 2 plain (no patterns) ·
   *  4 noCull · 8 transparent · 16 has submeshes. Only names not queued before (for this Pipeline3D) are warmed —
   *  warming an already queued / compiled name at the same priority is a no-op. */
  private _prewarmCoded(meshes: readonly Mesh3D[], skinned: boolean): void {
    // The classification generation: a mesh already classified in this generation was queued already, so only the
    // NEW meshes (and ones whose material was set since: setMaterial resets their stamp) are classified. A new
    // Pipeline3D, a shadows toggle or a force-double-sided change starts a new generation (full re-classify).
    const fds = this.forceDoubleSided, sh0 = this._shadowsEnabled, split = shaderSplitActive();
    if (this._prewarmPipe !== this.pipeline || this._prewarmFds !== fds || this._prewarmSh !== sh0 || this._prewarmSplit !== split) {
      this._prewarmPipe = this.pipeline; this._prewarmFds = fds; this._prewarmSh = sh0; this._prewarmSplit = split;
      this._prewarmQueued.clear(); this._prewarmGen = ++Renderer3D._prewarmGenSeq; this._splitBaseDone.clear();
    }
    const gen = this._prewarmGen;
    const seen = this._prewarmCodes; seen.fill(0);
    let any = false;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (m._pwGen === gen) continue;
      const mat = m.material;
      // SHADER SPLIT: a covered mesh warms its generated pipeline(s) instead of the uber pipeline it would never use
      if (split && this._splitPrewarmMesh(m, skinned, fds, sh0)) { m._pwGen = gen; continue; }
      // 1 textured · 2 plain · 4 double-sided (material) · 8 transparent · 16 submeshes
      const c = ((mat.hasTexture || mat.hasNormalMap) ? 1 : 0) | (this._usesPatterns(m) ? 0 : 2)
        | (mat.doubleSided ? 4 : 0) | (mat.opacity < 1 ? 8 : 0) | (m.submeshes.length > 0 ? 16 : 0);
      m._pwGen = gen; m._pwCode = c;
      seen[skinned ? (c & 3) : (fds ? (c | 4) : c)] = 1;
      any = true;
    }
    if (split) this._splitWarmBases();   // the BASE fallback of every axis the new meshes use (after their exact keys)
    if (!any && this._prewarmQueued.size) { this._prewarmLastQueued = 0; return; }
    const sh = this._shadowsEnabled ? 'Shadow' : '';
    const names: string[] = [];
    const add = (n: string) => { if (!this._prewarmQueued.has(n)) { this._prewarmQueued.add(n); names.push(n); } };
    for (let c = 0; c < 32; c++) {
      if (!seen[c]) continue;
      const T = (c & 1) ? 'Textured' : 'Untextured', plain = (c & 2) ? 'Plain' : '';
      if (skinned) { add(`skinnedOpaque${T}${plain}Pipeline`); continue; }
      const noCull = (c & 4) ? 'NoCull' : '';
      if (c & 8) { add(`transparent${T}${noCull}Pipeline`); continue; }
      add(`opaque${T}${noCull}${plain}${sh}Pipeline`);
      if (c & 16) add(`opaque${T}${noCull}${sh}Pipeline`);
    }
    if (sh) add(skinned ? 'skinnedShadowPipeline' : 'shadowPassPipeline');
    this._prewarmLastQueued = names.length;
    if (names.length) this.pipeline.warmPipelines(names, PIPELINE_PRIORITY.DOCUMENT);
  }
  /** Step 2 A/B: incremental draw rank + coded prewarm (both default on). */
  setStructureOptions(o: { incrementalDrawOrder?: boolean; prewarmNewOnly?: boolean }): { incrementalDrawOrder: boolean; prewarmNewOnly: boolean } {
    if (o.incrementalDrawOrder !== undefined) { this._drawOrder.incremental = !!o.incrementalDrawOrder; this._drawOrderDirty = true; }
    if (o.prewarmNewOnly !== undefined) { this.prewarmNewOnly = !!o.prewarmNewOnly; this._prewarmQueued.clear(); this._prewarmPipe = null; this._prewarmSeen.opaque = -1; this._prewarmSeen.skinned = -1; }
    return { incrementalDrawOrder: this._drawOrder.incremental, prewarmNewOnly: this.prewarmNewOnly };
  }
  /** Diagnostics for the structure-change work (draw rank + prewarm). */
  getStructureStats(): { drawRank: { updates: number; merged: number; fullSorts: number; legacy: number; lastAdded: number; lastRemoved: number; size: number; keyCodes: number }; prewarmLastQueued: number; prewarmQueued: number } {
    return { drawRank: { ...this._drawOrder.stats, size: this._drawOrder.size, keyCodes: this._drawOrder.codes.size }, prewarmLastQueued: this._prewarmLastQueued, prewarmQueued: this._prewarmQueued.size };
  }

  /** Draws skipped so far because their pipeline was still compiling (diagnostics). */
  get pipelineSkips(): number { return this._pipeSkips; }

  /** Draw one mesh (or an instanced range) from the shared geometry pool — the former drawMeshes
   *  closure. instanceCount > 1 requires contiguous slots (guaranteed by the geometryKey sort in
   *  uploadMeshInstances). `vbRef` tracks the encoder's bound VB so overrides switch minimally. */
  private _drawMesh(enc: GPURenderPassEncoder, mesh: Mesh3D, firstInstance: number,
                    activeVBRef: { vb: GPUBuffer }, instanceCount = 1,
                    submesh?: { indexOffset: number; indexCount: number }): void {
    if (this._skipDraws) return;      // P2: this run's pipeline is still compiling (async) → skip, never block
    if (instanceCount <= 0) return;   // empty batch run → skip; Dawn warns on a 0-instance draw (and it's a no-op)
    const alloc = this._geomAllocs.get(mesh.id);
    if (!alloc) return;
    // P22: the allocation's format (packed = the twin pipeline + slot-1 tangent + 16-bit indices). Packable geometry is
    // world geometry, which never has a vertex-buffer override.
    if (!this._pkPrepare(enc, alloc.pk === true)) return;
    this._frame.drawCalls++;
    const _dt = ((submesh ? submesh.indexCount : alloc.indexCount) / 3) * instanceCount;
    this._frame.trisDrawn += _dt;
    this._passDraws[this._passBucket]++; this._passTris[this._passBucket] += _dt;   // P11 per-pass counters
    const override = this._vertexBufferOverrides.get(mesh.id);
    const targetVB = override ?? this._geomVB!;
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
  }

  /** E2 (audit P3): ONE precomputed batched run list shared by the outline/shadow/SSAO pre-passes and
   *  the planar pass — geometry-key + contiguous-instance-slot runs over opaqueForPasses. Cached per
   *  frame (drawMeshes resets `_passRunsCache` right after `_buildDrawLists`). */
  private _passRunsCache: { mesh: Mesh3D; idx: number; count: number }[] | null = null;
  private _shadowRunsCache: { mesh: Mesh3D; idx: number; count: number }[] | null = null;
  private _passRuns(): { mesh: Mesh3D; idx: number; count: number }[] {
    return this._passRunsCache ??= this._buildRuns(this._opaqueForPasses);
  }
  /** The shadow pass's batched runs — over the LIGHT-culled caster list (see _shadowList). */
  private _shadowRuns(): { mesh: Mesh3D; idx: number; count: number }[] {
    return this._shadowRunsCache ??= this._buildRuns(this._expandRanges(this._shadowList, false, this._shadowRunTester, this._farExpDirect));
  }
  private readonly _farExpDirect: RendererDrawEntry[] = [];
  private readonly _farExpStatic: RendererDrawEntry[] = [];
  private readonly _farExpDyn: RendererDrawEntry[] = [];
  private readonly _cascExp: RendererDrawEntry[][] = [[], []];
  private readonly _cascExpDyn: RendererDrawEntry[][] = [[], []];
  /** P14 LAZY RANGES: `list` with every entry that carries a run table (frg = far map, crg = cascade: `cascade`)
   *  replaced by its index sub-ranges that pass `t`, in order (into `out`); `list` itself when nothing is ranged.
   *  Runs only on the frames the far map / a cached static cascade layer actually renders. */
  private _expandRanges(list: RendererDrawEntry[], cascade: boolean, t: BoxTester, out: RendererDrawEntry[]): RendererDrawEntry[] {
    let k = 0;
    for (; k < list.length; k++) if (cascade ? list[k].crg : list[k].frg) break;
    if (k === list.length) return list;
    out.length = 0;
    for (let i = 0; i < k; i++) out.push(list[i]);
    let culled = 0;
    for (let i = k; i < list.length; i++) {
      const e = list[i], rg = cascade ? e.crg : e.frg;
      if (!rg || e.range || e.submesh || (e.count ?? 1) !== 1) { out.push(e); continue; }
      const kept = this._rangedPush(out, e.mesh, e.idx, rg, t);
      culled += (rg.first[rg.n - 1] + rg.count[rg.n - 1]) / 3 - kept;
    }
    if (cascade) this._frame.rangeTrisCulledCascade += culled; else this._frame.rangeTrisCulledShadow += culled;
    return out;
  }
  private _buildRuns(opaqueForPasses: RendererDrawEntry[]): PassRun[] {
    const runs: PassRun[] = [];
    let ri = 0;
    while (ri < opaqueForPasses.length) {
      const geoKey = opaqueForPasses[ri].mesh.geometryKey;
      let rj = ri + 1;
      while (rj < opaqueForPasses.length && opaqueForPasses[rj].mesh.geometryKey === geoKey) rj++;
      let rk = 0;
      const groupLen = rj - ri;
      while (rk < groupLen) {
        const subStart = ri + rk;
        const lead = opaqueForPasses[subStart];
        if ((lead.count ?? 1) > 1) { runs.push({ mesh: lead.mesh, idx: lead.idx, count: lead.count! }); rk++; continue; }   // instanced-range entry (array group)
        if (lead.range) { runs.push({ mesh: lead.mesh, idx: lead.idx, count: 1, range: lead.range }); rk++; continue; }   // P11 index sub-range
        const firstSlot = lead.idx;
        let subLen = 1;
        while (rk + subLen < groupLen &&
               (opaqueForPasses[subStart + subLen].count ?? 1) === 1 && !opaqueForPasses[subStart + subLen].range &&
               opaqueForPasses[subStart + subLen].idx === firstSlot + subLen) {
          subLen++;
        }
        runs.push({ mesh: lead.mesh, idx: firstSlot, count: subLen });
        rk += subLen;
      }
      ri = rj;
    }
    return runs;
  }
  /** P15 Phase B: a depth-style camera prepass (outline depth + normal, SSAO / SSR G-buffer, SSR peel). With the GPU
   *  main pass drawing this frame, the GPU-culled records come from a render bundle (gpu-scene.ts drawPrepass) and the
   *  CPU replays only the pass entries the bundle does not cover; otherwise the shared CPU runs, as before. The caller
   *  has set `pipe` (or found it pending: `_skipDraws`) and `bg0`. */
  private _gdReplay(pass: GPURenderPassEncoder, kind: string, pipe: GPURenderPipeline | null, bg0: GPUBindGroup, colorFormats: GPUTextureFormat[], depthFormat: GPUTextureFormat): void {
    const gd = this._gdOn && Renderer3D.gpuDrivenPrepasses && !!this._gd && this._gd.dispatched ? this._gd : null;
    if (gd === null || !gd.drawPrepass(pass, kind, pipe, bg0, colorFormats, depthFormat)) { this._replayRuns(pass); return; }
    // executeBundles cleared the pass state: the CPU remainder re-binds it
    this._pkLost(pass);
    if (pipe) { this._setPipe(pass, pipe); pass.setBindGroup(0, bg0); }
    this._replayRuns(pass, this._gdRestRuns ??= this._buildRuns(this._gdRestList(gd)));
  }
  private _gdRestRuns: PassRun[] | null = null;
  private readonly _gdRest: RendererDrawEntry[] = [];
  private _gdRestList(gd: GpuDrivenMain): RendererDrawEntry[] {
    const out = this._gdRest; out.length = 0;
    const src = this._opaqueForPasses;
    for (let i = 0; i < src.length; i++) { const e = src[i]; if (e.submesh || !gd.prepassDraws((e.gdObj ?? e.mesh) as Mesh3D)) out.push(e); }
    return out;
  }
  /** Replay the shared batched runs into a depth-style pass (shadow / SSAO prepass / outline depth). */
  private _replayRuns(pass: GPURenderPassEncoder, runs: PassRun[] = this._passRuns()): void {
    const sharedVB = this._geomVB!;
    pass.setVertexBuffer(0, sharedVB);
    pass.setIndexBuffer(this._geomIB!, 'uint32');
    this._pkLost(pass);   // P22: the index buffer was rebound
    const vbRef = { vb: sharedVB };
    for (const r of runs) this._drawMesh(pass, r.mesh, r.idx, vbRef, r.count, r.range);
  }

  /** drawMeshes stage 3 — the outline-depth / shadow / SSAO+SSR pre-passes, coalesced into one
   *  submit (E2). Verbatim, including the shadow throttle + suspend states. */
  private _recordPrePasses(canvasWidth: number, canvasHeight: number): void {
    const sharedVB = this._geomVB!;
    const transparent = this._transparent;
    // The pre-passes share ONE command encoder → single submit (E2). Created lazily: a frame with no
    // outline/shadow/SSAO work submits nothing.
    let _prePassEnc: GPUCommandEncoder | null = null;
    const prePassEnc = (): GPUCommandEncoder => _prePassEnc ??= this.device.createCommandEncoder({ label: 'PrePasses' });

    // Outline depth pre-pass: camera-view depth into outline texture, then Sobel.
    // Recorded into the shared pre-pass encoder (submitted below, before the main pass).
    this._skipDraws = false;
    if (this._outlinePass && this._outlinePass.ready() && !(RD.on && RD.f.noDepthPrepass)) {   // P2: skipped (no outline) while its pipelines compile
      this._outlinePass.ensureTextures(canvasWidth, canvasHeight);
      // FOG HORIZON: Silhouette outlines off = no ink past the fog edge (the Sobel pass reads world distance from depth).
      // visual-polish #8: the DEPTH FADE (thinner / lighter ink with distance) reads the same world-from-depth inverse.
      const olFade = this._outlinePass.needsFadeView, olFogCut = !this._fogHorizon.silhouetteOutlines && this.fogHorizonActive;
      const olVP = (olFogCut || olFade) && !!mat4.invert(this._outlineInvVP, this.camera.getViewProjectionMatrix() as unknown as mat4);
      if (olFogCut && olVP) {
        this._outlinePass.fogCut = { eye: this._fogEye, edge: fogHorizonEdge(this._fog), invViewProj: this._outlineInvVP as unknown as Float32Array };
      } else this._outlinePass.fogCut = null;
      this._outlinePass.fadeView = olFade && olVP ? { eye: this.camera.position as unknown as Float32Array, invViewProj: this._outlineInvVP as unknown as Float32Array } : null;
      this._outlinePass.updateParams();

      const outlineEncoder = prePassEnc();

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
      this._passBucket = PassBucket.Outline;
      this._setPipe(depthPrePass, this._outlinePass.depthNormalPipeline);
      depthPrePass.setBindGroup(0, this.meshBindGroup!);
      this._gdReplay(depthPrePass, 'outline', this._outlinePass.depthNormalPipeline, this.meshBindGroup!, ['rgba8unorm'], 'depth32float');   // batched opaque walk (E2) / P15 GPU set
      const outlineVBRef = { vb: sharedVB };
      for (const e of transparent) this._drawMesh(depthPrePass, e.mesh, e.idx, outlineVBRef);
      depthPrePass.end();

      this._outlinePass.runSobelPass(outlineEncoder);
    }

    // Shadow pre-pass: depth-only render into shadow map using its own command encoder.
    // Submitted before the main pass draws so the GPU executes it first.
    // THROTTLED: with `setShadowUpdateInterval(n)` the map refreshes every n-th rendered frame — mover
    // shadows lag a frame or two (invisible) while the whole-scene depth render stops eating every frame.
    // Structural changes (_shadowMapStale: lights/geometry/adds) always refresh immediately.
    this._shadowFramesSince++;
    this._passBucket = PassBucket.FarShadow;
    if (this._shadowMapStale) this._cascadeStale = true;   // structural change → the near cascades refresh too
    this._frame.cascadeDrawCalls = 0;
    const _ts = performance.now();
    // P6: did this frame write the far map / the cascades? (→ rebuild their min/max tiles below)
    const _scs = this._shadowCacheStats;
    const _farW0 = _scs.staticRenders + _scs.dynPasses + _scs.directRenders, _susp0 = this._shadowSuspendCleared, _casc0 = this._frame.cascadePasses;
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
    } else if (this._shadowsEnabled && this._shadowTextureView && this._shadowBindGroup && this._recordCachedFarShadow(prePassEnc)) {
      // P4.2: handled by the static-cache path (static re-render only on change + a dynamic-caster layer)
    } else if (this._shadowsEnabled && this._shadowTextureView && this._shadowBindGroup
        && (this._shadowMapStale || this._shadowFramesSince >= this._shadowUpdateInterval)) {
      this._shadowFramesSince = 0;
      this._shadowMapStale = false;
      this._perf.shadowPasses++;
      this._shadowCacheStats.directRenders++;
      this._shadowDynInMap = true; this._shadowSampledStatic = false;   // the map now holds everything (old path)
      const shadowEncoder = prePassEnc();
      const shadowPass = shadowEncoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: this._shadowTextureView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      // P2: pipeline still compiling → the pass only CLEARS the map (depth 1 = fully lit, never garbage) and the
      // map stays stale so it renders for real the frame the pipeline lands.
      if (!this._setPipe(shadowPass, this.pipeline.shadowPassPipeline)) this._shadowMapStale = true;
      shadowPass.setBindGroup(0, this.meshBindGroup!);
      // Shadow pass uses one pipeline (no texture grouping needed) — batched runs (E2) over the LIGHT-culled
      // caster list (Round 5; `shadowLightCulling = false` -> the camera-culled pass list, the old behaviour).
      const _sdc = this._frame.drawCalls, _stri = this._frame.trisDrawn;
      this._gdShadowDraw(shadowPass, 0, this.meshBindGroup, 'far');   // P15 Phase C: the GPU's direct casters
      this._replayRuns(shadowPass, this._shadowRuns());
      this._frame.shadowDrawCalls = this._frame.drawCalls - _sdc; this._frame.shadowTris = this._frame.trisDrawn - _stri;
      this._shadowCacheStats.farTris += this._frame.shadowTris;
      // E1 tail (c): CHARACTERS cast shadows too — skinned parts replay into the same depth map with
      // the skin-deformed depth pipeline. Uses the LAST drawSkinnedMeshes frame's list/buffers (this
      // pass records before this frame's skinned upload — a 1-frame pose lag, the same tolerance the
      // throttled mover shadows already accept). Guards skip parts whose buffers were evicted.
      this._drawSkinnedShadowCasters(shadowPass);
      shadowPass.end();
    }
    this._passBucket = PassBucket.Cascade;
    this._recordCascadePasses(prePassEnc);   // persona-polish A2: the near cascades (own throttle, own caster lists)
    this._recordShadowMinMax(prePassEnc, _farW0 !== _scs.staticRenders + _scs.dynPasses + _scs.directRenders || (!_susp0 && this._shadowSuspendCleared), _casc0 !== this._frame.cascadePasses);
    this._frame.msShadow = performance.now() - _ts;

    // ── SSAO geometry prepass + AO estimate (own encoder, mirrors the shadow pass) ──────────────────────
    // Renders the same opaque geometry into a world-position G-buffer, then computes + blurs AO into
    // _aoBlurTex. Gated: only runs when SSAO is on. Stage 1 does NOT yet feed lighting — the debug view
    // (drawn at the end of drawMeshes) is how the AO buffer is verified before it touches the ambient term.
    if ((this._ssaoEnabled || this._ssrEnabled) && this._ssao) {
      this._ssao.ensureTextures(canvasWidth, canvasHeight);
      this._passBucket = PassBucket.Prepass;
      const aoEnc = prePassEnc();
      const prepass = aoEnc.beginRenderPass({
        label: 'SSAOPrepass',
        colorAttachments: [
          { view: this._ssao.worldPosTargetView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
          { view: this._ssao.normalTargetView(),   loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
        ],
        depthStencilAttachment: { view: this._ssao.prepassDepthView(), depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      // The same shared batched runs drive BOTH the front prepass and the depth-peel pass (E2).
      this._setPipe(prepass, this.pipeline.ssaoPrepassPipeline);   // P2: pending → cleared G-buffer (no AO / no SSR hits)
      prepass.setBindGroup(0, this._prepassMeshBG ?? this.meshBindGroup!);   // dummies at 10/11 (avoids write/read alias)
      this._gdReplay(prepass, 'ssao', this.pipeline.ssaoPrepassPipeline, this._prepassMeshBG ?? this.meshBindGroup!, ['rgba32float', 'rgba16float'], 'depth24plus');
      prepass.end();

      // ── Depth-peel pass (SSR backface-fill): SECOND-nearest surface ──
      // Re-renders the same opaque geometry; the FS reads the front layer just written (real at binding 10 in
      // _peelMeshBG) and discards fragments at-or-in-front of it, so the depth test keeps the second surface.
      // Gated on SSR + peeling — SSAO-only frames pay nothing.
      if (this._ssrEnabled && this._ssrDepthPeel && this._peelMeshBG) {
        this._ssao.ensurePeelTextures();
        const peelPass = aoEnc.beginRenderPass({
          label: 'SSRPeelPrepass',
          colorAttachments: [{ view: this._ssao.worldPosBackTargetView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
          depthStencilAttachment: { view: this._ssao.peelDepthView(), depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        this._setPipe(peelPass, this.pipeline.ssaoPeelPrepassPipeline);
        peelPass.setBindGroup(0, this._peelMeshBG);
        this._gdReplay(peelPass, 'peel', this.pipeline.ssaoPeelPrepassPipeline, this._peelMeshBG, ['rgba32float'], 'depth24plus');
        peelPass.end();
      }

      // ── Deferred SSR resolve (Stage 3b): fullscreen half-res trace into the reflection texture ──
      // Runs after the G-buffer passes in the same encoder (submitted before the colour pass, so the mesh FS
      // samples this frame's result). Samples the PREVIOUS frame's scene-colour grab, like the inline trace did.
      if (this._ssrEnabled && this._ssrDeferred && this._resolveMeshBG) {
        this._ssao.ensureReflectionTexture();
        const resolvePass = aoEnc.beginRenderPass({
          label: 'SSRResolve',
          colorAttachments: [{ view: this._ssao.reflectionTargetView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
        });
        const ssrResolvePipe = this.pipeline.ssrResolvePipeline;   // P2: pending → reflection texture stays cleared (no reflections)
        if (ssrResolvePipe) {
          resolvePass.setPipeline(ssrResolvePipe);
          resolvePass.setBindGroup(0, this._resolveMeshBG);
          resolvePass.draw(3);
        }
        resolvePass.end();

        // ── Phase B post: HEAL (A→B, majority-gated hole/serration fill) then FEATHER (B→A, perimeter
        // blur at ssrEdgeFeather texels; radius 0 = plain copy so the result always lands back in A). ──
        // meshBindGroup binds texture A at 13 (heal input); _reflectionPingBG binds B (feather input).
        const ssrHealPipe = this.pipeline.ssrHealPipeline, ssrFeatherPipe = this.pipeline.ssrFeatherPipeline;
        if (this.meshBindGroup && this._reflectionPingBG && ssrHealPipe && ssrFeatherPipe) {
          const healPass = aoEnc.beginRenderPass({
            label: 'SSRHeal',
            colorAttachments: [{ view: this._ssao.reflectionPingTargetView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
          });
          healPass.setPipeline(ssrHealPipe);
          healPass.setBindGroup(0, this.meshBindGroup);
          healPass.draw(3);
          healPass.end();
          const featherPass = aoEnc.beginRenderPass({
            label: 'SSRFeather',
            colorAttachments: [{ view: this._ssao.reflectionTargetView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
          });
          featherPass.setPipeline(ssrFeatherPipe);
          featherPass.setBindGroup(0, this._reflectionPingBG);
          featherPass.draw(3);
          featherPass.end();
        }
      }
      // The world-pos G-buffer is now populated (used by SSR). Only compute+blur AO when SSAO itself is on.
      if (this._ssaoEnabled) {
        const camPos = this.camera.position;
        this._ssao.updateAOParams(this.camera.getViewProjectionMatrix() as Float32Array, camPos[0], camPos[1], camPos[2]);
        this._ssao.runAO(aoEnc);
      }
    }

    // Submit the coalesced pre-passes (outline + shadow + SSAO/SSR) as ONE command buffer — they were
    // three separate submits. Ordering within the buffer matches the old submit order exactly.
    // (Cast: TS can't see the assignment inside the prePassEnc() closure and narrows the let to null.)
    const _prePassPending = _prePassEnc as GPUCommandEncoder | null;
    if (_prePassPending) this.device.queue.submit([_prePassPending.finish()]);
  }

  /**
   * P4.2 static far-map cache. Returns false when the cache can't run this frame (toggle off, lists not built,
   * or the light box / sun is moving) → the caller falls through to the old direct path. Otherwise records:
   *   - a STATIC re-render into `_shadowStaticTex` when the static set signature changed (throttled like the old
   *     refresh), the map went stale (structural / light settings), or the cache is cold;
   *   - a DYNAMIC layer: copy static → sampled map, then draw the dynamic casters (+ skinned) with depth LOAD,
   *     every `_shadowUpdateInterval` frames (immediately on a skinned pose change) — the old mover cadence.
   * With no dynamic casters at all, the static set renders straight into the sampled map (no copy, no 2nd texture).
   */
  private _recordCachedFarShadow(prePassEnc: () => GPUCommandEncoder): boolean {
    const volatile = this._shadowLightMoved;
    this._shadowLightMoved = false;
    this._shadowQuietFrames = volatile ? 0 : this._shadowQuietFrames + 1;
    this._shadowStaticFramesSince++;
    const interval = this._shadowUpdateInterval;
    if (!this._shadowCacheOn || !this._shadowCacheListsBuilt || volatile
        || (!this._shadowStaticValid && !this._shadowSampledStatic && this._shadowQuietFrames < interval)) {
      // Moving light box (pan / zoom / sun sweep) or just settled: the old direct path (reach-culled, all casters).
      this._shadowStaticValid = false; this._shadowSampledStatic = false;
      this._shadowCachePath = false;
      return false;
    }
    this._shadowCachePath = true;
    const sigChanged = this._shadowStaticSig !== this._shadowStaticSigDrawn || (this._joinDeferOn && (this._farMembers.due(this._shadowFrameNo, Renderer3D.STATIC_JOIN_TRIS, Renderer3D.STATIC_JOIN_FRAMES) || this._gdShDue(0, this._farMembers.joinTris)));
    const stale = this._shadowMapStale;
    const hasDyn = this._shadowDynList.length > 0 || this._skinnedVisibleScratch.length > 0 || this._gdShThis;   // (Phase C: the GPU's may exist)
    const sizeOk = this._shadowStaticTex && this._shadowStaticTex.width === this._shadowMapSize;
    const throttledSig = sigChanged && this._shadowStaticFramesSince >= interval;
    const pipe = this.pipeline.shadowPassPipeline;

    const renderStatic = (view: GPUTextureView): void => {
      const pass = prePassEnc().beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      const ok = this._setPipe(pass, pipe);
      pass.setBindGroup(0, this.meshBindGroup!);
      const _sdc = this._frame.drawCalls, _stri = this._frame.trisDrawn;
      if (ok) { this._gdShadowDraw(pass, 1, this.meshBindGroup, 'far'); this._replayRuns(pass, this._shadowStaticRunsCache ??= this._buildRuns(this._expandRanges(this._shadowStaticList, false, this._lightCuller, this._farExpStatic))); }
      this._frame.shadowDrawCalls = this._frame.drawCalls - _sdc; this._frame.shadowTris = this._frame.trisDrawn - _stri;
      this._shadowCacheStats.farTris += this._frame.shadowTris;
      pass.end();
      if (ok) this._gdShCommitLayer(prePassEnc(), 0);   // P15 Phase C: the GPU casters drawn into it are its set now
      this._shadowStaticSigDrawn = ok ? (this._joinDeferOn ? this._shadowStaticSigAll : this._shadowStaticSig) : NaN;   // P2 pending → cleared map, retry next frame
      if (ok && this._joinDeferOn) this._farMembers.drawnWith(this._farStaticKeys); else if (!ok) this._farMembers.clear();   // P14: the layer now holds every static caster
      this._shadowMapStale = !ok;
      this._shadowStaticFramesSince = 0;
      this._perf.shadowPasses++;
      this._shadowCacheStats.staticRenders++;
      if (stale) this._shadowCacheStats.staticStale++; else if (sigChanged) this._shadowCacheStats.staticSig++; else this._shadowCacheStats.staticCold++;   // P14 diagnostics: why
    };

    if (!hasDyn) {
      // No movers: the static set IS the map — render it straight into the sampled texture when it changes.
      if (!this._shadowSampledStatic || this._shadowDynInMap || stale || throttledSig) {
        renderStatic(this._shadowTextureView!);
        this._shadowSampledStatic = true; this._shadowDynInMap = false;
        this._shadowStaticValid = false;   // the cache texture (if any) is now behind
        this._shadowFramesSince = 0;
      }
      this._shadowDynStale = false;
      return true;
    }

    let staticDrawn = false;
    if (!sizeOk) {
      this._shadowStaticTex?.destroy();
      this._shadowStaticTex = this.device.createTexture({
        size: [this._shadowMapSize, this._shadowMapSize, 1], format: 'depth32float', label: 'ShadowStaticCache',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this._shadowStaticView = this._shadowStaticTex.createView();
      this._shadowStaticValid = false;
    }
    if (!this._shadowStaticValid || stale || throttledSig) {
      renderStatic(this._shadowStaticView!);
      this._shadowStaticValid = true;
      staticDrawn = true;
    }
    this._shadowSampledStatic = false;
    if (staticDrawn || this._shadowDynStale || this._shadowFramesSince >= interval) {
      const enc = prePassEnc();
      const sz = this._shadowMapSize;
      enc.copyTextureToTexture({ texture: this._shadowStaticTex! }, { texture: this._shadowTexture! }, [sz, sz, 1]);
      const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this._shadowTextureView!, depthClearValue: 1.0, depthLoadOp: rdDepthLoad(), depthStoreOp: 'store' } });   // ('load'; render debug may clear)
      const ok = this._setPipe(pass, pipe);   // P2 pending → retry the layer next frame
      pass.setBindGroup(0, this.meshBindGroup!);
      const _dtri = this._frame.trisDrawn;
      if (ok) this._gdShadowDraw(pass, 2, this.meshBindGroup, 'far');   // P15 Phase C: the GPU's dynamic casters + joiners
      if (ok && this._shadowDynList.length) this._replayRuns(pass, this._shadowDynRunsCache ??= this._buildRuns(this._expandRanges(this._shadowDynList, false, this._shadowRunTester, this._farExpDyn)));
      this._shadowCacheStats.farTris += this._frame.trisDrawn - _dtri;
      this._drawSkinnedShadowCasters(pass);
      pass.end();
      this._shadowDynInMap = true;
      this._shadowFramesSince = 0;
      this._shadowDynStale = !ok;
      if (this._shadowVerify && ok) this._recordShadowCacheVerify(enc);
      this._shadowCacheStats.dynPasses++;
    }
    return true;
  }

  /** E1 tail (c): replay the skinned character parts into the open SHADOW depth pass with the
   *  skin-deformed depth-only pipeline, so characters cast shadows like everything else. Reads the
   *  LAST drawSkinnedMeshes frame's visible list + instance slots (`firstInstance = i` matches that
   *  upload's order) — the pre-passes record before this frame's skinned upload, so poses lag one
   *  frame (invisible; the mover-shadow throttle already accepts more). Every part is re-guarded:
   *  eviction, rebinding, or a deleted skeleton since last frame just skips the part. */
  private _drawSkinnedShadowCasters(pass: GPURenderPassEncoder, meshBG: GPUBindGroup | null = this._skinnedMeshBG): void {
    const list = this._skinnedVisibleScratch;
    if (list.length === 0 || !meshBG) return;
    const flags = this._skinnedFlags;
    let began = false;
    let curSkinBG: GPUBindGroup | null = null;
    for (let i = 0; i < list.length; i++) {
      const mesh = list[i];
      if (!mesh.skeleton || mesh.vertexColors || mesh.isFaceFeatures) continue;   // weight-paint previews + face-kit overlays don't cast
      if (!(flags[i] & 2)) continue;                       // R6.1: in view but its shadow can't matter (or shadows were off)
      const vb = this._skinnedVBs.get(mesh.id);
      const ib = this._skinnedIBs.get(mesh.id);
      const skinBG = this._skinBGs.get(mesh.skeleton.id);
      if (!vb || !ib || !skinBG) continue;
      if (!began) {
        const skShadowPipe = this.pipeline.skinnedShadowPipeline;
        if (!skShadowPipe) return;   // P2: still compiling → characters cast no shadow for a frame or two
        pass.setPipeline(skShadowPipe);
        pass.setBindGroup(0, meshBG);
        began = true;
      }
      if (skinBG !== curSkinBG) { pass.setBindGroup(1, skinBG); curSkinBG = skinBG; }
      pass.setVertexBuffer(0, vb);
      pass.setIndexBuffer(ib, 'uint32');
      pass.drawIndexed(mesh.geometry.indices.length, 1, 0, 0, i);
      this._passDraws[this._passBucket]++; this._passTris[this._passBucket] += mesh.geometry.indices.length / 3;   // P11
    }
  }

  /** drawMeshes stage 4 — the P4b planar-mirror re-render (mirrored + oblique camera into the
   *  planar texture; own encoder + submit). Verbatim. */
  private _drawPlanarReflectionPass(meshes: Mesh3D[], canvasWidth: number, canvasHeight: number): void {
    const sharedVB = this._geomVB!;
    const sharedIB = this._geomIB!;
    const opaqueForPasses = this._opaqueForPasses;
    const transparent = this._transparent;
    // ── P4b PLANAR REFLECTION pass: a true mirror via a mirrored + oblique re-render ──
    // The scene is re-rendered from the camera REFLECTED across the flagged mesh's plane, with an OBLIQUE
    // projection whose near plane IS the mirror plane (the hardware near-clip discards everything behind the
    // mirror — no shader changes). Standard lit pipelines are reused at full fidelity via the NoCull variants
    // (a mirrored world flips triangle winding). The reflector's fragments sample the result at their own
    // screen uv — the sampling contract proven in planar-reflection.ts. ONE reflector per scene (v1).
    {
      const planarReflector = meshes.find((mm) => !!mm.material.planarReflector);
      this._planarActive = !!planarReflector;
      if (planarReflector && this._planarMeshBG) {
        if (!this._planarTex || this._planarTexW !== canvasWidth || this._planarTexH !== canvasHeight) {
          this._planarTex?.destroy(); this._planarDepthTex?.destroy();
          this._planarTex = this.device.createTexture({ size: [canvasWidth, canvasHeight], format: this._swapChainFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'PlanarReflection' });
          this._planarDepthTex = this.device.createTexture({ size: [canvasWidth, canvasHeight], format: 'depth24plus-stencil8', usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'PlanarReflectionDepth' });
          this._planarTexW = canvasWidth; this._planarTexH = canvasHeight;
          this._meshBindGroupPlanarTex = null;   // rebind the fresh texture on the next bind-group build
        }
        // Mirror plane: the reflector's LOCAL +Z face plane, oriented toward the camera (either side works).
        const camP = this.camera.position;
        const plane = reflectorPlane(planarReflector.localMatrix as unknown as Float32Array, [0, 0, 0], [0, 0, 1]);
        const cw = clipPlaneFor(plane.point, plane.normal, [camP[0], camP[1], camP[2]]);
        const refl = reflectionMatrix(plane.point, [cw[0], cw[1], cw[2]]);
        const vm = mat4.multiply(mat4.create(), this.camera.getViewMatrix(), refl as unknown as mat4);
        const vmInv = mat4.invert(mat4.create(), vm);
        const proj = this.camera.getProjectionMatrix();
        const projInv = mat4.invert(mat4.create(), proj);
        if (vmInv && projInv) {
          const pv = planeTimesMat([cw[0], cw[1], cw[2], -cw[3]], vmInv as unknown as Float32Array);
          const pob = obliqueProjectionZO(proj as unknown as Float32Array, projInv as unknown as Float32Array, pv);
          const vpm = mat4.multiply(mat4.create(), pob as unknown as mat4, vm);
          const camM = transformPoint4(refl, [camP[0], camP[1], camP[2]]);
          const pd = this._planarScratch;
          pd.set(this._sceneUniformsData);
          pd.set(vpm as unknown as Float32Array, 0);                          // viewProjection ← mirrored + oblique
          pd[16] = camM[0]; pd[17] = camM[1]; pd[18] = camM[2];               // cameraPosition ← mirrored (.w kept)
          const fe = this._fogEye, feM = transformPoint4(refl, [fe[0], fe[1], fe[2]]);
          pd[268] = feM[0]; pd[269] = feM[1]; pd[270] = feM[2];               // fog eye ← mirrored (fog horizon)
          this.device.queue.writeBuffer(this._planarSceneBuf!, 0, pd);

          const pEnc = this.device.createCommandEncoder();
          const pPass = pEnc.beginRenderPass({
            label: 'PlanarReflection',
            colorAttachments: [{ view: this._planarTex.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
            depthStencilAttachment: { view: this._planarDepthTex!.createView(), depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store', stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store' },
          });
          pPass.setVertexBuffer(0, sharedVB);
          pPass.setIndexBuffer(sharedIB, 'uint32');
          const pRef = { vb: sharedVB };
          const PP = this.pipeline;
          const pSplit = shaderSplitActive();
          for (let _ke = 0; _ke < opaqueForPasses.length; _ke++) { const e = opaqueForPasses[_ke];
            if (e.mesh === planarReflector) continue;   // the mirror does not reflect itself
            const em = e.mesh.material;
            const useTexture = !!(em.hasTexture || em.hasNormalMap);
            const patterned = this._usesPatterns(e.mesh);
            // SHADER SPLIT: the slot key on the opaqueNoCull axis (a PLAIN-routed entry only with a PLAIN-safe key: a
            // multi-material mesh draws its first submesh's slot routed by the MESH material)
            const psk0 = pSplit ? this._slotKey(e.idx, useTexture) : -1;
            const psk = psk0 >= 0 && (patterned || meshFsNumPlainSafe(psk0)) ? psk0 : -1;
            if (psk >= 0) {
              const sp = this._splitPipe(psk, 'opaqueNoCull', this._shadowsEnabled);
              this._setPipe(pPass, sp, sp ? this._splitFallback(psk, 'opaqueNoCull', this._shadowsEnabled) ?? sp : null);
              pPass.setBindGroup(0, this._planarMeshBG);
              if (useTexture) {
                const isAtlas = !!e.mesh.textureLibraryId && this._atlasLayerMap.has(e.mesh.textureLibraryId);
                pPass.setBindGroup(1, (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(e.mesh));
                if (this._shadowsEnabled) pPass.setBindGroup(2, this._shadowBindGroup!);
              } else if (this._shadowsEnabled) pPass.setBindGroup(1, this._shadowBindGroup!);
            } else if (useTexture) {
              this._setPipe(pPass, this._shadowsEnabled
                ? (patterned ? PP.opaqueTexturedNoCullShadowPipeline : PP.opaqueTexturedNoCullPlainShadowPipeline)
                : (patterned ? PP.opaqueTexturedNoCullPipeline : PP.opaqueTexturedNoCullPlainPipeline));
              pPass.setBindGroup(0, this._planarMeshBG);
              const isAtlas = !!e.mesh.textureLibraryId && this._atlasLayerMap.has(e.mesh.textureLibraryId);
              pPass.setBindGroup(1, (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(e.mesh));
              if (this._shadowsEnabled) pPass.setBindGroup(2, this._shadowBindGroup!);
            } else {
              this._setPipe(pPass, this._shadowsEnabled
                ? (patterned ? PP.opaqueUntexturedNoCullShadowPipeline : PP.opaqueUntexturedNoCullPlainShadowPipeline)
                : (patterned ? PP.opaqueUntexturedNoCullPipeline : PP.opaqueUntexturedNoCullPlainPipeline));
              pPass.setBindGroup(0, this._planarMeshBG);
              if (this._shadowsEnabled) pPass.setBindGroup(1, this._shadowBindGroup!);
            }
            this._drawMesh(pPass, e.mesh, e.idx, pRef, e.count ?? 1);
          }
          // P4b.2: TRANSPARENT meshes in the mirror — drawn after the opaques with the NoCull transparent
          // variants (winding flip), reusing the main pass's back-to-front order (sorted for the MAIN camera —
          // an approximation for the mirrored view; subtle blend-order errors accepted v1). Caveat: characters
          // (drawn into the mirror in a later sub-pass) can overdraw glass in front of them.
          for (let _ke = 0; _ke < transparent.length; _ke++) { const e = transparent[_ke];
            if (e.mesh === planarReflector) continue;
            const tm = e.submesh ? e.submesh.material : e.mesh.material;
            const useTexture = !!(tm.hasTexture || tm.hasNormalMap);
            const ptk = pSplit ? this._slotKey(e.idx, useTexture) : -1;   // SHADER SPLIT (today: FULL, so exact)
            if (ptk >= 0) {
              const sp = this._splitPipe(ptk, 'transparentNoCull', false);
              this._setPipe(pPass, sp, sp ? this._splitFallback(ptk, 'transparentNoCull', false) ?? sp : null);
              pPass.setBindGroup(0, this._planarMeshBG);
              if (useTexture) {
                const isAtlas = !!e.mesh.textureLibraryId && this._atlasLayerMap.has(e.mesh.textureLibraryId);
                pPass.setBindGroup(1, (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(e.mesh));
              }
            } else if (useTexture) {
              this._setPipe(pPass, PP.transparentTexturedNoCullPipeline);
              pPass.setBindGroup(0, this._planarMeshBG);
              const isAtlas = !!e.mesh.textureLibraryId && this._atlasLayerMap.has(e.mesh.textureLibraryId);
              pPass.setBindGroup(1, (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(e.mesh));
            } else {
              this._setPipe(pPass, PP.transparentUntexturedNoCullPipeline);
              pPass.setBindGroup(0, this._planarMeshBG);
            }
            this._drawMesh(pPass, e.mesh, e.idx, pRef, e.count ?? 1, e.submesh);
          }
          pPass.end();
          this.device.queue.submit([pEnc.finish()]);
        }
      }
    }
  }

  /** drawMeshes stage 5 — the MAIN colour pass: partition opaque into VC/simple/multi, the cached
   *  draw-rank sort, the batched opaque walk (pipeline/texture grouping + contiguous-slot sub-runs),
   *  then multi-submesh, vertex-colored, and back-to-front transparent draws. Verbatim. */
  /** The batched opaque walk of the main pass (pipeline / texture grouping + contiguous-slot sub-runs) over `opaqueSimple`
   *  (rank-sorted). Verbatim from _drawMainPass (P15: also draws the GPU scene's not-yet-placed meshes). */
  private _drawBatched(pass: GPURenderPassEncoder, opaqueSimple: RendererDrawEntry[], mainVBRef: { vb: GPUBuffer }): void {
    // Group consecutive entries sharing the same geometry + pipeline + texture into one
    // instanced drawIndexed call. Falls back to individual draws when frustum culling
    // breaks slot contiguity within a group.
    let oi = 0;
    while (oi < opaqueSimple.length) {
      const lead = opaqueSimple[oi].mesh;
      const geoKey     = lead.geometryKey;
      const useTexture = lead.material.hasTexture || lead.material.hasNormalMap;
      const noCull     = this.forceDoubleSided || !!lead.material.doubleSided;
      const patterned  = this._usesPatterns(lead);   // §3.1: full-shader vs plain (pattern-stripped) pipeline
      const leadDiff   = lead.diffuseTexture;
      const leadNorm   = lead.normalMapTexture;
      // A mesh is "atlas mode" when its texture is packed into the shared atlas
      // (identified by textureLibraryId). Atlas meshes all share one bind group
      // and can batch across different textures — textureIndex selects the layer.
      const leadIsAtlas = useTexture && !!lead.textureLibraryId && this._atlasLayerMap.has(lead.textureLibraryId);
      const sv = Renderer3D.shaderVariantsActive;
      const vk = sv ? lead._r3VF : -1;   // step 8: the shader-variant key (the exact instance flags, or -1)
      const split = shaderSplitActive();
      const sk = split ? lead._r3FK : -1;   // SHADER SPLIT: the packed key (>= 0 = drawn with a generated pipeline)

      // Scan forward while same group (geometry + pipeline + texture mode all match)
      let oj = oi + 1;
      while (oj < opaqueSimple.length) {
        const m = opaqueSimple[oj].mesh;
        if (m.geometryKey !== geoKey) break;
        if ((m.material.hasTexture || m.material.hasNormalMap) !== useTexture) break;
        if ((this.forceDoubleSided || !!m.material.doubleSided) !== noCull) break;
        if (this._usesPatterns(m) !== patterned) break;   // §3.1: don't batch plain + patterned into one pipeline
        if (sv && m._r3VF !== vk) break;   // step 8: one variant (= one exact flags value) per group
        if (split && m._r3FK !== sk) break;   // SHADER SPLIT: one key per group (and covered / uncovered never mix)
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
      const P = this.pipeline;
      // SHADER SPLIT: a covered group draws ONLY with a generated pipeline (exact / superset / held); the uber getters
      // below are not even read for it (reading one requests its compile).
      const spl = sk >= 0 ? this._splitPipe(sk, noCull ? 'opaqueNoCull' : 'opaque', this._shadowsEnabled) : null;
      const vPipe = sk >= 0 ? spl : this._variantPipe(vk, !!useTexture, noCull, patterned);   // step 8: null = the base pipeline below
      const splFb = spl ? this._splitFallback(sk, noCull ? 'opaqueNoCull' : 'opaque', this._shadowsEnabled) ?? spl : null;   // (P22 twin fallback)
      if (useTexture) {
        const bp = sk >= 0 ? spl : this._shadowsEnabled
          ? (noCull ? (patterned ? P.opaqueTexturedNoCullShadowPipeline : P.opaqueTexturedNoCullPlainShadowPipeline)
                    : (patterned ? P.opaqueTexturedShadowPipeline       : P.opaqueTexturedPlainShadowPipeline))
          : (noCull ? (patterned ? P.opaqueTexturedNoCullPipeline       : P.opaqueTexturedNoCullPlainPipeline)
                    : (patterned ? P.opaqueTexturedPipeline             : P.opaqueTexturedPlainPipeline));
        this._setPipe(pass, vPipe ?? bp, sk >= 0 ? splFb : bp);   // (P22: a packed run falls back to the base pipeline's twin)
        pass.setBindGroup(0, this.meshBindGroup);
        // Atlas meshes share one bind group; standalone meshes get per-mesh bind group
        const texBG = (leadIsAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(lead);
        pass.setBindGroup(1, texBG);
        if (this._shadowsEnabled) pass.setBindGroup(2, this._shadowBindGroup!);
      } else {
        const bp = sk >= 0 ? spl : this._shadowsEnabled
          ? (noCull ? (patterned ? P.opaqueUntexturedNoCullShadowPipeline : P.opaqueUntexturedNoCullPlainShadowPipeline)
                    : (patterned ? P.opaqueUntexturedShadowPipeline       : P.opaqueUntexturedPlainShadowPipeline))
          : (noCull ? (patterned ? P.opaqueUntexturedNoCullPipeline       : P.opaqueUntexturedNoCullPlainPipeline)
                    : (patterned ? P.opaqueUntexturedPipeline             : P.opaqueUntexturedPlainPipeline));
        this._setPipe(pass, vPipe ?? bp, sk >= 0 ? splFb : bp);   // (P22: a packed run falls back to the base pipeline's twin)
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
        if ((lead.count ?? 1) > 1) { this._drawMesh(pass, lead.mesh, lead.idx, mainVBRef, lead.count); k++; continue; }   // instanced-range entry (array group)
        if (lead.range) { this._drawMesh(pass, lead.mesh, lead.idx, mainVBRef, 1, lead.range); k++; continue; }   // P11 index sub-range
        const firstSlot = lead.idx;
        let subLen = 1;
        while (k + subLen < groupLen &&
               (opaqueSimple[subStart + subLen].count ?? 1) === 1 && !opaqueSimple[subStart + subLen].range &&
               opaqueSimple[subStart + subLen].idx === firstSlot + subLen) {
          subLen++;
        }
        this._drawMesh(pass, lead.mesh, firstSlot, mainVBRef, subLen);
        k += subLen;
      }

      oi = oj;
    }
  }
  private readonly _gdOrphanEntries: RendererDrawEntry[] = [];

  /** P15 SPATIAL DRAW RANK: the rank's second key is a square XZ cell of this many metres (× fogHorizonUnitsPerMetre,
   *  the city's scale; 1 unit = 1 m outside a city) around the mesh's box centre, so one cell's records are contiguous
   *  in every pipeline class. The GPU path records one sub-bundle per run of a cell and leaves out the ones that draw
   *  nothing (GpuDrivenMain.subBundles). Both paths read the same rank, so they stay pixel-identical; among the city's
   *  unique geometry keys (`custom:<uuid>`) the old order was arbitrary anyway. Same-geometry meshes still sit
   *  together inside a cell (the CPU path's instanced batches). 0 = the old rank (pipeline class, geometry key). */
  static rankCellM = 80;   // ON by default since 2026-10-03: the spatially coherent order alone cut the CPU path's main pass by 0.5 ms (1300x850) / 0.9-1.1 ms (2500x1390) in the tiled city, same draws (performance-plan §P15 cause runs); sub-bundles stay off
  private _drawOrderCell = -1;
  /** P15: the rank's pipeline class includes the §3.1 plain / full (patterned) shader choice, so plain and patterned
   *  meshes no longer alternate in draw order. Both paths read the rank (ON = OFF by construction). The GPU path then
   *  keeps the cheap plain pipeline for plain meshes without a pipeline switch per alternation: the merged full-shader
   *  bucket (GpuDrivenMain.mergePatterned) cost +5-7 ms of main-pass GPU time in the tiled city (performance-plan §P15
   *  2026-10-03 cause runs). The CPU path's own pipeline switches drop too. false = the old rank. */
  static rankPatterned = true;
  private _drawOrderPat = false;
  /** The rank cell of `m` (1..2^28; 0 = no box or no cell). Read when the rank is rebuilt; stored on the mesh. */
  private _rankCellOf(m: Mesh3D, cs: number): number {
    if (!(cs > 0)) return 0;
    const b = this.getMeshWorldAABB3D(m, this._aabbScratch);
    if (!b) return 0;
    const cx = (b.minX + b.maxX) * 0.5, cz = (b.minZ + b.maxZ) * 0.5;
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return 0;
    const gx = Math.max(-8191, Math.min(8191, Math.floor(cx / cs))) + 8192, gz = Math.max(-8191, Math.min(8191, Math.floor(cz / cs))) + 8192;
    // Z-order (Morton) code of the 14-bit cell coordinates: consecutive cells form compact blocks, so the sub-bundle
    // groups (GpuDrivenMain.SUB_GROUP consecutive cells) are squares, not strips, and a view keeps or drops them whole
    let code = 0;
    for (let b = 13; b >= 0; b--) code = code * 4 + (((gx >> b) & 1) << 1) + ((gz >> b) & 1);
    return code + 1;
  }
  /** The cached draw rank (pipeline class, rank cell, geometry-key code, input position), re-ranked on a structural change. */
  private _ensureDrawOrder(meshes: Mesh3D[]): void {
    const cs = Renderer3D.rankCellM > 0 ? Renderer3D.rankCellM * this.fogHorizonUnitsPerMetre : 0;
    const rp = Renderer3D.rankPatterned;
    // step 8: the shader-variant id joins the pipeline class (rankVariants), whether the variants are on or not, so the
    // A/B switch never changes the draw order (coplanar decals / kerb paint resolve by order: ON = OFF by construction)
    const sv = Renderer3D.rankVariants, svGen = sv ? this._svKeyGen : -1;
    if (this._drawOrderDirty || this._drawOrderDS !== this.forceDoubleSided || this._drawOrderCell !== cs || this._drawOrderPat !== rp || this._drawOrderSv !== svGen) {
      this._drawOrderDirty = false;
      this._drawOrderDS = this.forceDoubleSided;
      this._drawOrderCell = cs;
      this._drawOrderPat = rp;
      this._drawOrderSv = svGen;
      const fds = this.forceDoubleSided;
      const ids = this._svIds;
      const pipeOf = (m: Mesh3D): number => {
        const cell = cs > 0 ? (m._r3RankCell = this._rankCellOf(m, cs)) : (m._r3RankCell = 0);
        return ((((m.material.hasTexture || m.material.hasNormalMap) ? 1 : 0) | ((fds || !!m.material.doubleSided) ? 2 : 0)
          | ((rp && this._usesPatterns(m)) ? 4 : 0) | (sv ? ids.idOf(m._r3VF) * 8 : 0)) * 268435456) + cell;
      };
      this._drawOrder.update(meshes, pipeOf);
    }
  }

  private _drawMainPass(pass: GPURenderPassEncoder, meshes: Mesh3D[]): void {
    const sharedVB = this._geomVB!;
    const sharedIB = this._geomIB!;
    const opaque = this._opaque;
    const transparent = this._transparent;
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
    for (let _ke = 0; _ke < opaque.length; _ke++) { const e = opaque[_ke];
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
    // P15: the GPU scene draws the whole batched segment (its records are this list's superset, in this sort's order)
    const gdDraw = this._gdOn && !!this._gd && this._gd.dispatched;
    if (opaqueSimple.length > 1 && !gdDraw) {
      // CACHED DRAW RANK: the old inline sort allocated the pipelineKeyOf closure PER COMPARISON and did ~40k
      // geometryKey STRING compares over the whole city EVERY frame (steady GC + CPU). The (pipelineKey,
      // geometryKey) order is stable per mesh — build a rank map once per STRUCTURAL change, then per frame do
      // one Map.get per mesh + a pure numeric sort. Meshes streamed in since the last rebuild rank at the tail
      // (worst case a few extra draw calls until the next structural rebuild — never incorrect).
      this._ensureDrawOrder(meshes);
      const ord = this._drawOrder;
      for (let _ke = 0; _ke < opaqueSimple.length; _ke++) { const e = opaqueSimple[_ke]; e.ord = ord.get(e.mesh.id) ?? 0x7fffffff; }
      opaqueSimple.sort((a, b) => a.ord! - b.ord!);
    }

    // Set shared VB/IB once for the main pass — only VB slot 0 switches for overrides.
    pass.setVertexBuffer(0, sharedVB);
    pass.setIndexBuffer(sharedIB, 'uint32');
    this._pkLost(pass);
    const mainVBRef = { vb: sharedVB };

    if (gdDraw && this._gd!.draw(pass)) {
      // P15: one indirect draw per record (bundle) or per bucket (multi-draw); executeBundles cleared the pass state
      this._gdDrew = true;
      pass.setVertexBuffer(0, sharedVB);
      pass.setIndexBuffer(sharedIB, 'uint32');
      this._pkLost(pass);   // (P22)
      // meshes / groups met this frame but not placed in the bundle yet (a throttled full rebuild): the CPU draws them,
      // in rank order, right after the bundle (only their order relative to the bundle differs, for a few frames)
      const orph = this._gdOrphanEntries; orph.length = 0;
      const gd = this._gd!;
      for (let _ke = 0; _ke < opaqueSimple.length; _ke++) { const e = opaqueSimple[_ke]; if (!gd.drawsObject((e.gdObj ?? e.mesh) as Mesh3D)) orph.push(e); }
      if (orph.length > 0) {
        const ord = this._drawOrder;
        for (let _ke = 0; _ke < orph.length; _ke++) { const e = orph[_ke]; e.ord = ord.get(e.mesh.id) ?? 0x7fffffff; }
        orph.sort((a, b) => a.ord! - b.ord!);
        this._drawBatched(pass, orph, mainVBRef);
        this._frame.gpuOrphanDraws = orph.length;
      }
    } else if (opaqueSimple.length > 0) {
      this._drawBatched(pass, opaqueSimple, mainVBRef);
    }

    // Draw multi-material opaque submesh entries (one draw call per submesh, no batching).
    const msplit = opaqueMulti.length > 0 && shaderSplitActive();
    for (const { mesh, idx, submesh } of opaqueMulti) {
      const mat  = submesh!.material;
      const noCull = this.forceDoubleSided || !!mat.doubleSided;
      const useTexture = mat.hasTexture || mat.hasNormalMap;
      // SHADER SPLIT: the submesh's own slot key (today these always draw with the FULL pipelines: any key is exact)
      const msk = msplit ? this._slotKey(idx, !!useTexture) : -1;
      const msp = msk >= 0 ? this._splitPipe(msk, noCull ? 'opaqueNoCull' : 'opaque', this._shadowsEnabled) : null;
      const mspFb = msp ? this._splitFallback(msk, noCull ? 'opaqueNoCull' : 'opaque', this._shadowsEnabled) ?? msp : null;   // (P22 twin fallback)
      if (useTexture) {
        const texId = submesh!.textureLibraryId ?? '';
        const isAtlas = !!texId && this._atlasLayerMap.has(texId);
        if (msk >= 0) this._setPipe(pass, msp, mspFb);
        else this._setPipe(pass, this._shadowsEnabled
          ? (noCull ? this.pipeline.opaqueTexturedNoCullShadowPipeline : this.pipeline.opaqueTexturedShadowPipeline)
          : (noCull ? this.pipeline.opaqueTexturedNoCullPipeline : this.pipeline.opaqueTexturedPipeline));
        pass.setBindGroup(0, this.meshBindGroup);
        const texBG = (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(mesh);
        pass.setBindGroup(1, texBG);
        if (this._shadowsEnabled) pass.setBindGroup(2, this._shadowBindGroup!);
      } else {
        if (msk >= 0) this._setPipe(pass, msp, mspFb);
        else this._setPipe(pass, this._shadowsEnabled
          ? (noCull ? this.pipeline.opaqueUntexturedNoCullShadowPipeline : this.pipeline.opaqueUntexturedShadowPipeline)
          : (noCull ? this.pipeline.opaqueUntexturedNoCullPipeline : this.pipeline.opaqueUntexturedPipeline));
        pass.setBindGroup(0, this.meshBindGroup);
        if (this._shadowsEnabled) pass.setBindGroup(1, this._shadowBindGroup!);
      }
      this._drawMesh(pass, mesh, idx, mainVBRef, 1, submesh);
    }

    // Draw vertex-colored (EditMesh) opaque meshes — one draw per mesh, no batching.
    // Uses a two-slot vertex layout: slot 0 = standard geometry (standalone VB override,
    // baseVertex=0), slot 1 = per-vertex rgba float32x4 color buffer.
    if (opaqueVC.length > 0) {
      const vcSplit = shaderSplitActive();
      if (!vcSplit) this._setPipe(pass, this.pipeline.opaqueVertexColorPipeline);
      pass.setBindGroup(0, this.meshBindGroup!);
      for (const { mesh, idx } of opaqueVC) {
        const colorBuf = this._vcColorBuffers.get(mesh.id);
        if (!colorBuf) continue;
        if (vcSplit) {
          // SHADER SPLIT: the vertex-colour axis (the untextured FULL shader today: the slot key with tex = false)
          const vk = this._slotKey(idx, false);
          this._setPipe(pass, vk >= 0 ? this._splitPipe(vk, 'vertexColour', false) : this.pipeline.opaqueVertexColorPipeline);
        }
        pass.setVertexBuffer(1, colorBuf);
        this._drawMesh(pass, mesh, idx, mainVBRef);
      }
    }

    // Draw transparent meshes (single-material and multi-submesh)
    if (transparent.length > 0) {
      for (const { mesh, idx, submesh } of transparent) {
        const alloc = this._geomAllocs.get(mesh.id);
        if (!alloc) continue;

        const mat = submesh?.material ?? mesh.material;
        const useTexture = mat.hasTexture || mat.hasNormalMap;
        const noCull = this.forceDoubleSided || !!mat.doubleSided;   // both faces for a doubleSided transparent mesh
        // SHADER SPLIT: a covered transparent mesh / submesh draws with its generated pipeline (never shadowed; today's
        // transparent pipelines are FULL, so a submesh's slot key is exact)
        const tsk = shaderSplitActive() ? (submesh ? this._slotKey(idx, !!useTexture) : mesh._r3FK) : -1;
        const tsp = tsk >= 0 ? this._splitPipe(tsk, noCull ? 'transparentNoCull' : 'transparent', false) : null;
        const tspFb = tsp ? this._splitFallback(tsk, noCull ? 'transparentNoCull' : 'transparent', false) ?? tsp : null;   // (P22 twin fallback)
        if (useTexture) {
          this._setPipe(pass, tsk >= 0 ? tsp : noCull ? this.pipeline.transparentTexturedNoCullPipeline : this.pipeline.transparentTexturedPipeline, tspFb);
          pass.setBindGroup(0, this.meshBindGroup);
          const texId = submesh?.textureLibraryId ?? mesh.textureLibraryId ?? '';
          const isAtlas = !!texId && this._atlasLayerMap.has(texId);
          const texBG   = (isAtlas && this._atlasBindGroup) ? this._atlasBindGroup : this.createTextureBindGroup(mesh);
          pass.setBindGroup(1, texBG);
        } else {
          this._setPipe(pass, tsk >= 0 ? tsp : noCull ? this.pipeline.transparentUntexturedNoCullPipeline : this.pipeline.transparentUntexturedPipeline, tspFb);
          pass.setBindGroup(0, this.meshBindGroup);
        }

        this._drawMesh(pass, mesh, idx, mainVBRef, 1, submesh);
      }
    }
  }

  /** drawMeshes stage 6 — in-pass overlays: outline composite, hover/silhouette highlight,
   *  source-link feedback, always-on-top overlay capture, face handles, AO debug view. Verbatim. */
  private _drawMainOverlays(pass: GPURenderPassEncoder, canvasWidth: number, canvasHeight: number): void {
    const sharedVB = this._geomVB!;
    const sharedIB = this._geomIB!;
    const opaqueSimple = this._opaqueSimple;
    const opaqueVC = this._opaqueVC;
    const transparent = this._transparent;
    // Composite outline edges on top of all meshes (before gizmo)
    if (this._outlinePass && this._outlinePass.ready() && !(RD.on && (RD.f.noOutlinePass || RD.f.noDepthPrepass))) {
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
          pk:          alloc.pk === true,   // P22
        }));
      });

      const _hlTime = performance.now() / 1000;
      const hoverEntries = toEntries(hoverOnly);

      // Sub-range hover (one landmark's exact silhouette out of a merged mesh): resolve each {meshId, indexStart,
      // indexCount} to a draw entry using the mesh's geom alloc + its live instance slot.
      if (this._hoverOutlineRanges) {
        const slotOf = new Map<string, number>();
        for (const p of [...opaqueSimple, ...opaqueVC, ...transparent]) if (!slotOf.has(p.mesh.id)) slotOf.set(p.mesh.id, p.idx);
        for (const r of this._hoverOutlineRanges) {
          const alloc = this._geomAllocs.get(r.meshId), slot = slotOf.get(r.meshId);
          if (!alloc || slot === undefined) continue;
          const hasOverride = this._vertexBufferOverrides.has(r.meshId);
          hoverEntries.push({
            vertex:      this._vertexBufferOverrides.get(r.meshId) ?? sharedVB,
            index:       sharedIB,
            indexCount:  r.indexCount,
            firstIndex:  alloc.firstIndex + r.indexStart,
            baseVertex:  hasOverride ? 0 : alloc.baseVertex,
            instanceIdx: slot,
            pk:          alloc.pk === true,   // P22
          });
        }
      }

      if (hoverEntries.length > 0 && this._silhouettePass && !(RD.on && (RD.f.noSilhouetteOutline || RD.f.noHighlight))) {
        // Screen-space silhouette outline: rasterize the mask in a SEPARATE encoder (executes before the main
        // encoder submits, like the SSAO prepass), then composite the band into the open main pass (on top).
        const maskEnc = this.device.createCommandEncoder({ label: 'OutlineMaskEnc' });
        this._silhouettePass.renderMask(maskEnc, this.meshBindGroup, hoverEntries, canvasWidth, canvasHeight);
        this.device.queue.submit([maskEnc.finish()]);
        this._silhouettePass.writeParams(this._hoverOutlineStyle, this._hoverOutlineStyle.thicknessPx, _hlTime);
        this._silhouettePass.composite(pass);
      }

      // Source-link feedback: when a source mesh is selected, faintly highlight all linked instances.
      if (this._selectedSourceId && this._highlightPass && this.meshBindGroup && !(RD.on && RD.f.noHighlight)) {
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
                pk:          alloc.pk === true,   // P22
              });
            }
          }
          if (linkedEntries.length > 0) {
            this._highlightPass.writeParams('select', { color: [1.0, 0.85, 0.2, 0.35], width: 0.03, thicknessPx: 6, patternMode: 0, patternColor: [1, 1, 1], freq: 20, speed: 0, glow: 1 }, canvasWidth, canvasHeight, 0);
            this._highlightPass.draw(pass, this.meshBindGroup, 'select', linkedEntries);
          }
        }
      }

      // Persistent PER-OBJECT outlines (user-assigned): every frame, each outlined mesh gets its OWN style + pattern.
      // Same stencil-ring technique as hover/select, but one param buffer per mesh (drawCustom) so styles don't
      // overwrite each other within a submit. Regular meshes only in v1 (skinned characters render on a separate
      // path — a skinned outline shader is the follow-up).
      if (this._meshOutlines.size > 0) {
        const outlineDraws: { entry: HighlightMeshEntry; paramIndices: number[]; onTop?: boolean }[] = [];
        const spriteDraws: SpriteOutlineDraw[] = [];
        let spritePending = false;
        let opi = 0;
        const seenOutline = new Set<string>();
        // Draw from the SMOOTHED-normal shell (gap-free on hard edges), keeping the mesh's live instance slot for
        // its transform. Scan the pooled draw lists for outlined + visible meshes (one entry per mesh id).
        for (let li = 0; li < 3; li++) {
          const list = li === 0 ? opaqueSimple : li === 1 ? opaqueVC : transparent;
          for (const p of list) {
            const style = this._meshOutlines.get(p.mesh.id);
            if (!style || seenOutline.has(p.mesh.id)) continue;
            seenOutline.add(p.mesh.id);
            // SPRITE outlines (sprite-alpha-outlines.md): a textured sprite whose spriteShape is 'card', or 'image' with its
            // distance field READY, takes the separate sprite pass. Anything else — including an 'image' sprite while
            // its field is still building, or whose image turned out fully opaque — falls through to the hull below.
            const sm = p.mesh as Mesh3D;
            const spMode = this._spriteOutlinePass && sm.diffuseTexture ? spriteOutlineMode(sm, style) : null;
            const size = sm.spriteSize;
            if (spMode && size && sm.diffuseTexture) {
              const base = { instanceIdx: p.idx, width: size[0], height: size[1], onTop: !!style.merge,
                             layers: outlineLayers(style, this._meshOutlineRings.get(p.mesh.id)) };
              if (spMode === 'card') {
                const tt = sm.material.textureTiling, to = sm.material.textureOffset;
                spriteDraws.push({ ...base, mode: 'card', texture: sm.diffuseTexture,
                                   uvTransform: [tt?.[0] ?? 1, tt?.[1] ?? 1, to?.[0] ?? 0, to?.[1] ?? 0] });
                continue;
              }
              const field = this._spriteSDF?.get(sm.diffuseTexture);
              if (field === undefined) spritePending = true;
              if (field) { spriteDraws.push({ ...base, mode: 'image', field }); continue; }
            }
            const og = this._ensureOutlineGeom(p.mesh as Mesh3D);
            if (!og) continue;
            const paramIndices: number[] = [];
            for (const layer of outlineLayers(style, this._meshOutlineRings.get(p.mesh.id))) {
              this._highlightPass.writeCustomParams(opi, layer, canvasWidth, canvasHeight, outlineAnimates(layer) ? _hlTime : 0);
              paramIndices.push(opi++);
            }
            outlineDraws.push({ entry: { vertex: og.vb, index: og.ib, indexCount: og.count, firstIndex: 0, baseVertex: 0, instanceIdx: p.idx }, paramIndices, onTop: !!style.merge });
          }
        }
        if (outlineDraws.length > 0 && !(RD.on && RD.f.noHighlight)) this._highlightPass.drawCustom(pass, this.meshBindGroup, outlineDraws);
        if (spriteDraws.length > 0 && !(RD.on && RD.f.noSilhouetteOutline)) this._spriteOutlinePass!.draw(pass, this.meshBindGroup, spriteDraws, canvasWidth, canvasHeight, _hlTime);
        this._spriteSDFPending = spritePending;
      }
    }

    // ALWAYS-ON-TOP overlays (the landmark info card): NOT drawn here. They are cached and drawn LAST of all —
    // directly onto the final swapchain image AFTER post-processing (see drawPostOverlays) — so the card bypasses
    // bloom / colour-grade / vignette and reads the same day & night. Textured billboard quads; their model matrix
    // is already billboard-reoriented per frame, and their instance slot (p.idx) stays valid for the rest of the frame.
    // Scan the three pooled draw lists IN PLACE — the old `[...opaqueSimple, ...opaqueVC, ...transparent]` spread
    // allocated a fresh combined array (hundreds of entries citywide) every frame just to find the handful of
    // alwaysOnTop overlays (usually only the landmark card). Three plain loops → zero per-frame allocation.
    this._postOverlayEntries.length = 0;
    for (let li = 0; li < 3; li++) {
      const list = li === 0 ? opaqueSimple : li === 1 ? opaqueVC : transparent;
      for (const p of list) {
        const m = p.mesh as Mesh3D;
        if (m.alwaysOnTop && m.diffuseTexture) this._postOverlayEntries.push({ mesh: m, idx: p.idx });
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
    if (this._gizmoRenderer && this._faceHandleData && !(RD.on && RD.f.noGizmo)) {
      this._gizmoRenderer.drawFaceHandles(pass, this._faceHandleData, this.camera);
    }

    // Mesh edit overlay is drawn by drawMeshEditOverlayIfActive(), called
    // unconditionally from webgpu-renderer after all mesh draws — this ensures
    // handles are visible even when regularMeshes is empty (e.g. after Bind Mesh).

    // SSAO debug view: overwrite the scene with the raw AO buffer (verification only). Last draw so it wins.
    if (this._ssaoEnabled && this._ssaoDebug && this._ssao) this._ssao.drawDebug(pass);
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

    // P2: particle pipeline still compiling → no particles this frame (they appear when it lands).
    const particlePipe = this._particlePipeline!.get();
    if (!particlePipe) return;
    // ── Bloom capture + blur (before main pass draws) ──────────────
    this._bloomCapturePipeline ??= createBloomCapturePipeline(this.device, this._particleBGL0!, this._particleBGL1!);
    const bloomCapturePipe = this._bloomPass ? this._bloomCapturePipeline.get() : null;
    const bloomReady = !!(this._bloomPass && bloomCapturePipe && this._bloomPass.ready());   // P2: whole bloom skipped while compiling
    if (this._bloomPass && bloomReady) {
      this._bloomPass.ensureTextures(canvasWidth, canvasHeight);
      const atlasTex = this._atlasTexture ?? this.getDefaultWhiteTex();
      this._bloomPass.captureAndBlur(
        this._particleInstBuf!,
        this._particleSceneUniBuf!,
        this._particleBGL0!,
        this._particleBGL1!,
        bloomCapturePipe!,
        active,
        firstInstances,
        this.pipeline.activeSampler,
        atlasTex,
      );
    }

    // ── Main pass draw ─────────────────────────────────────────────
    pass.setPipeline(particlePipe);
    pass.setBindGroup(0, this._particleBindGroup0!);
    pass.setBindGroup(1, this._getParticleTexBindGroup());

    for (let i = 0; i < active.length; i++) {
      if (active[i].activeCount <= 0) continue;   // no live particles yet → skip; Dawn warns on a 0-instance draw
      pass.draw(6, active[i].activeCount, 0, firstInstances[i]);
    }

    // ── Bloom composite (additive, drawn after particles) ──────────
    if (this._bloomPass && bloomReady) {
      this._bloomPass.drawComposite(pass, this.pipeline.activeSampler);
    }
  }

  // ── Transient particles (Play landing dust, 2026-10-04) ───────────────
  // Runtime-only particle sources that are NOT scene-graph nodes (never saved, no outliner row, no emitter icon):
  // the Play landing dust (game/landing-dust.ts). Drawn with the billboard particle pipeline right after the
  // scene's emitters, from their own instance buffer, never into the particle bloom. The Play loop registers a
  // source only while it has live particles, so an idle scene pays one empty-array check per pass.
  private readonly _transientParticles: TransientParticleSource[] = [];
  private _transientInstBuf: GPUBuffer | null = null;
  private _transientInstCap = 0;
  private _transientBG0: GPUBindGroup | null = null;
  addTransientParticles(src: TransientParticleSource): void { if (!this._transientParticles.includes(src)) this._transientParticles.push(src); }
  removeTransientParticles(src: TransientParticleSource): void { const i = this._transientParticles.indexOf(src); if (i >= 0) this._transientParticles.splice(i, 1); }
  get hasTransientParticles(): boolean { return this._transientParticles.length > 0; }
  /** Draw every registered transient source (call once per scene pass, after drawParticles). */
  drawTransientParticles(pass: GPURenderPassEncoder): void {
    const srcs = this._transientParticles;
    let total = 0;
    for (const s of srcs) if (s.gpuData && s.activeCount > 0) total += s.activeCount;
    if (total === 0) return;
    if (!this._particlePipeline) this._initParticlePipeline();
    const pipe = this._particlePipeline!.get();
    if (!pipe) return;
    const bytes = total * PARTICLE_INSTANCE_STRIDE;
    if (!this._transientInstBuf || this._transientInstCap < bytes) {
      this._transientInstBuf?.destroy();
      this._transientInstCap = Math.max(4096, Math.ceil(bytes * 1.5));
      this._transientInstBuf = this.device.createBuffer({ size: this._transientInstCap, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'TransientParticleInstBuf' });
      this._transientBG0 = null;
    }
    let off = 0;
    for (const s of srcs) {
      if (!s.gpuData || s.activeCount <= 0) continue;
      const n = s.activeCount * PARTICLE_INSTANCE_STRIDE;
      this.device.queue.writeBuffer(this._transientInstBuf, off, s.gpuData.buffer, s.gpuData.byteOffset, n);
      off += n;
    }
    this._writeParticleSceneUniforms();
    this._transientBG0 ??= this.device.createBindGroup({
      layout: this._particleBGL0!,
      entries: [
        { binding: 0, resource: { buffer: this._transientInstBuf } },
        { binding: 1, resource: { buffer: this._particleSceneUniBuf! } },
      ],
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, this._transientBG0);
    pass.setBindGroup(1, this._getParticleTexBindGroup());
    pass.draw(6, total, 0, 0);
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

    this._particlePipeline = GPUPipelineCache.for(device).render({
      label: 'Particles',
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

  /**
   * Move the shadow-box centre to follow the camera focus, snapped to the shadow-map texel grid so the
   * projected texels stay aligned as you pan (otherwise the whole map crawls → shimmering shadow edges).
   * Only re-renders the map when the SNAPPED centre changes (a full texel of pan) — so a still camera keeps
   * the existing throttle, and a panning camera refreshes exactly when it must. Locked at origin when the
   * box already covers the scene (`_shadowFollowCamera=false`) to preserve the old single-scene behaviour.
   */
  private _updateShadowCenter(): void {
    if (!this._shadowsEnabled) return;
    this._settleSun();   // P14

    // ── Zoom-adaptive box size ────────────────────────────────────────────────────────────────────────────────
    // Tune these two in-browser: HE_PER_DIST too small → shadows cut off at the screen edges when zoomed in;
    // too large → less sharpening. MIN_HE is the tightest box (closest zoom). Erring large is safe (never worse
    // coverage than the old full-city box).
    const HE_PER_DIST = 1.1;                       // effective half-extent ≈ this × camera orbit distance
    const MIN_HE = 8;                              // never shrink below this (a handful of buildings)
    let he = this._shadowHalfExtent;               // origin-locked: always the full base box
    if (this._shadowFollowCamera) {
      const p = this.camera.position, t = this.camera.target;
      const dist = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
      he = Math.min(this._shadowHalfExtent, Math.max(MIN_HE, dist * HE_PER_DIST));
    }
    const heChanged = he !== this._effHe;
    if (heChanged) {
      this._effHe = he;
      // Bias scales with the effective texel size (∝ he): a small sharp box needs far less bias, which also cuts
      // the peter-panning (detached shadows) that a fixed large bias causes when zoomed in.
      this._effBias = this._shadowBias * (he / this._shadowHalfExtent);
      this._shadowMapStale = true;                 // box resized → the map must re-render at the new scale
      this._shadowLightMoved = true;               // P4.2: volatile light box → direct path, cache invalid
    }

    if (!this._shadowFollowCamera) return;         // origin-locked: centre stays at 0 (set by setShadowFollowCamera)

    // ── Texel-snapped follow ──────────────────────────────────────────────────────────────────────────────────
    const t = this.camera.target;
    // World-space texel size along the box (the light is near top-down in city view, so world X/Z ≈ light X/Y;
    // snapping world X/Z removes nearly all the shimmer — a light-space snap would be exact at any sun angle).
    const texel = (2 * this._effHe) / this._shadowMapSize;
    const cx = Math.round(t[0] / texel) * texel;
    // Centre the box on the GROUND under the focus, NOT the focus height. The ortho column is slanted along the
    // sun, so if the centre is ABOVE the ground its intersection with the ground plane shifts by an azimuth-
    // dependent amount → the shadowed patch orbits in a ring as the sun rotates (dead-zone bug). Anchoring the
    // centre at y=0 puts the column through the ground at the focus, so coverage stays put at every azimuth.
    const cy = 0;
    const cz = Math.round(t[2] / texel) * texel;
    // P6 (performance-plan.md): re-centre only once the focus has drifted more than SHADOW_FOLLOW_SLACK_TEXELS from
    // the box centre. Every re-centre re-renders the whole far map AND voids the P4.2 static cache, and at street
    // level a texel is ~0.1 m, so walking / flying re-rendered it every 1-4 frames. The centre stays on the same texel
    // lattice (cx/cz are still texel multiples), so every shadow texel lands where it did before; only the box's
    // coverage edge, 100+ m away, trails the focus by at most the slack.
    const slack = texel * Math.max(0, Renderer3D.SHADOW_FOLLOW_SLACK_TEXELS);
    if (slack > 0 && !heChanged && this._lsmCenter[1] === cy && Math.abs(cx - this._lsmCenter[0]) <= slack && Math.abs(cz - this._lsmCenter[2]) <= slack) return;
    if (cx !== this._lsmCenter[0] || cy !== this._lsmCenter[1] || cz !== this._lsmCenter[2]) {
      vec3.set(this._lsmCenter, cx, cy, cz);
      this._shadowMapStale = true;                 // centre moved a texel → refresh the throttled map this frame
      this._shadowLightMoved = true;               // P4.2: panning → direct path, cache invalid
    }
  }

  /** P6: how far (in far-map texels) the camera focus may drift from the far shadow box centre before the box is
   *  re-centred (and the map re-rendered). 0 = re-centre on every texel (the pre-P6 behaviour). */
  static SHADOW_FOLLOW_SLACK_TEXELS = 16;

  /** P8 SHADOW LOD (performance-plan.md P8): leave a caster out of a shadow map (the far map, or one near cascade)
   *  when its `Mesh3D.shadowFeatureSize` is below SHADOW_LOD_TEXELS of that map's texels — the map cannot resolve its
   *  shadow. Only meshes with a feature size (the city's sub-metre classes) are affected. false = every caster in
   *  every map (the pre-P8 behaviour, A/B). */
  static shadowSizeLod = true;
  static SHADOW_LOD_TEXELS = 1;
  /** P8 shadow LOD screen guard: a caster also has to be under this many pixels at the camera's distance to the city
   *  volume (`distanceLodBias`; 0 at street / roof level → nothing is skipped there). */
  static SHADOW_LOD_SCREEN_PX = 2;
  /** P8 SHADER FAST PATHS (scene.cascadeBias.z): bit-identical shortcuts in the main fragment shaders — a facade's
   *  wall pixels skip the interior-mapped window trace, windowsPattern evaluates only the facade's own material and
   *  returns the footprint alone to non-facade patterned meshes. false = the original code paths (A/B). */
  static shaderFastPaths = true;
  /** STEP 8 SPECIALISED SHADER VARIANTS (shader-variants.ts; performance-plan §P21): a batched opaque mesh whose
   *  material flags are in a listed feature family draws with a variant of its fragment shader compiled with those
   *  flags as constants (same pixels; compiled in the background, the uber-shader until ready). false = every mesh
   *  on the uber-shader (A/B). Through setShaderVariants / sm.setShaderVariants3D. */
  static shaderVariants = true;
  /** Step 8: dense ids of the variant keys in use (the draw rank and the GPU-driven state codes carry them). */
  private readonly _svIds = new ShaderVariantIds();
  /** Step 8: bumped when a mesh's variant key changes on a slot write (a look switch): the draw rank re-ranks. */
  private _svKeyGen = 0;
  private _drawOrderSv = -2;
  /** Step 8: the draw rank's pipeline class includes the shader-variant id (same-variant meshes form one run, so the
   *  variants add no pipeline switches by alternation). Independent of shaderVariants (the A/B keeps the order). */
  static rankVariants = true;
  private _svU32: Uint32Array | null = null;
  /** Step 8: the specialised pipeline for a batched opaque draw with variant key `vk` (-1 = none), or null (the
   *  caller uses the base pipeline: no variant, variants off, or still compiling). */
  private _variantPipe(vk: number, tex: boolean, noCull: boolean, pat: boolean): GPURenderPipeline | null {
    if (vk < 0 || !Renderer3D.shaderVariantsActive) return null;
    return this.pipeline.variantPipeline((tex ? VB_TEXTURED : 0) | (noCull ? VB_NOCULL : 0) | (pat ? VB_PATTERNED : 0) | (this._shadowsEnabled ? VB_SHADOW : 0), vk, Renderer3D.shaderFastPaths);
  }
  /** Step 8: switch the shader variants (A/B) and read their state: keys in use, compiled pipelines, compile times. */
  setShaderVariants(o: { enabled?: boolean; max?: number } = {}): { enabled: boolean; capped: boolean; keys: number; max: number; registered: number; ready: number; pending: number; failed: number; list: { key: number; base: number; fast: boolean; ready: boolean; ms: number }[] } {
    if (o.max !== undefined && Number.isFinite(o.max)) this._svIds.max = Math.max(0, Math.floor(o.max));
    if (o.enabled !== undefined && !!o.enabled !== Renderer3D.shaderVariants) {
      Renderer3D.shaderVariants = !!o.enabled;
      this._gd?.recode();   // the GPU-driven state codes carry the variant id
    }
    return { enabled: Renderer3D.shaderVariants, capped: !Renderer3D.caps.shaderVariants, keys: this._svIds.size, max: this._svIds.max, ...this.pipeline.variantStats() };
  }
  // ── SHADER SPLIT phase 1 (mesh-fs-pipelines.ts; docs/specs/shader-split.md) ─────────────────────────────────────
  /** The split is on (localStorage salsa.shaderSplit / sm.setShaderSplit3D / render debug forceShaderSplit). */
  static get shaderSplitActive(): boolean { return shaderSplitActive(); }
  /** GPU-driven state codes: bit 14 of the variant-id field marks a split key id (P21 ids stay below 0x4000). */
  static readonly SPLIT_ID_FLAG = 0x4000;
  /** Dense ids of the packed split keys GPU-driven state codes carry (1..0x3fff; 0 = none). */
  private readonly _splitIds = new Map<number, number>();
  /** id -> packed key (the GPU-driven resolve) */
  private readonly _splitNums: number[] = [-1];
  /** The dense id of packed split key `num` (0 when `num` < 0 or the ids ran out: today's pipelines). */
  private _splitIdOf(num: number): number {
    if (num < 0) return 0;
    let id = this._splitIds.get(num);
    if (id === undefined) {
      if (this._splitNums.length >= Renderer3D.SPLIT_ID_FLAG) return 0;
      id = this._splitNums.length; this._splitNums.push(num); this._splitIds.set(num, id);
    }
    return id;
  }
  /** The packed split key of `m` from its MATERIAL (= the key its slot write derives: the same encode functions and the
   *  same pattern-slot writer for patternParams.z / .w). -1 = today's pipelines (multi-material meshes key per slot). */
  static splitKeyOfMesh(m: Mesh3D): number {
    if (m.submeshes.length > 0) return -1;
    return Renderer3D._splitKeyOfMaterial(m, m.material, m.isFaceFeatures || !!(m.material.hasTexture || m.material.hasNormalMap));
  }
  private static readonly _splitZW = new Float32Array(64);
  /** The packed split key a slot of mesh `m` written with material `mat` gets, on a `tex` layout (the face-kit multiply
   *  axis: only PLAIN-safe keys). */
  private static _splitKeyOfMaterial(m: Mesh3D, mat: Material3D, tex: boolean): number {
    const z = Renderer3D._splitZW; z.fill(0);
    Renderer3D.prototype._writePatternSlots.call(null, z, 0, mat);   // (writes floats 48-59 only; uses no instance state)
    const n = meshFsKeyNum(encodeMaterialFlags(mat), encodeMeshFlags2(m), tex, z[54], z[55]);
    return m.isFaceFeatures && !meshFsNumPlainSafe(n) ? -1 : n;
  }
  private _slotU32: Uint32Array | null = null;
  /** The packed split key of MAIN instance slot `idx` read back from the CPU copy, on a `tex` layout (the draw sites
   *  whose pipeline is not the mesh's own: submeshes, the vertex-colour / post-overlay axes, the planar mirror). */
  private _slotKey(idx: number, tex: boolean): number {
    const d = this._instanceDataBuf;
    if (!d || idx < 0) return -1;
    if (this._slotU32 === null || this._slotU32.buffer !== d.buffer) this._slotU32 = new Uint32Array(d.buffer, d.byteOffset, d.length);
    const o = idx * (MESH_INSTANCE_STRIDE / 4);
    if (o + 59 >= d.length) return -1;
    return meshFsKeyNum(this._slotU32[o + 43], d[o + FLAGS2_FLOAT_OFFSET], tex, d[o + 54], d[o + 55]);
  }
  /** Document pre-warm of one mesh with the split on: queue its key(s) on the axes it draws with; false = it has a key
   *  the split does not cover (the caller queues today's pipelines). Notes the axes for _splitWarmBases. */
  private _splitPrewarmMesh(m: Mesh3D, skinned: boolean, fds: boolean, sh0: boolean): boolean {
    const reg = this.pipeline.meshFs;
    const one = (mat: Material3D, axisMat: Material3D, vc: boolean): boolean => {
      const transparent = axisMat.opacity < 1, nc = fds || !!axisMat.doubleSided;
      const face = skinned && m.isFaceFeatures;
      const axis: MeshFsAxis = face ? 'skinnedFaceMultiply' : skinned ? 'skinned' : transparent ? (nc ? 'transparentNoCull' : 'transparent')
        : vc ? 'vertexColour' : (nc ? 'opaqueNoCull' : 'opaque');
      const tex = face || (!vc && !!(mat.hasTexture || mat.hasNormalMap));
      const k = Renderer3D._splitKeyOfMaterial(m, mat, tex);
      if (k < 0) return false;
      const g = this._splitG(!skinned && !transparent && !vc && sh0);
      reg.warmNum(axis, k, g, PIPELINE_PRIORITY.DOCUMENT);
      this._splitBaseAxes.add(`${axis}|${tex ? 1 : 0}|${g}`);
      return true;
    };
    if (skinned && m.vertexColors) return false;   // a weight-paint preview: its own pipelines
    if (m.submeshes.length > 0) {
      if (skinned) return false;
      let ok = true;
      for (const s of m.submeshes) ok = one(s.material, s.material, false) && ok;
      return ok;
    }
    const vc = !skinned && !!m.vertexColors && !(m.material.hasTexture && !!m.diffuseTexture);
    return one(m.material, m.material, vc);
  }
  /** (axis | tex | g) of the meshes the document pre-warm queued, whose BASE is not queued yet. */
  private readonly _splitBaseAxes = new Set<string>();
  private readonly _splitBaseDone = new Set<string>();
  /** Queue the `*-BASE` fallback of every axis the pre-warmed meshes draw on (once each; DOCUMENT priority, after their
   *  exact keys): the skinned BASE when a character appears, the transparent BASE with the first glass, and so on. */
  private _splitWarmBases(): void {
    for (const id of this._splitBaseAxes) {
      if (this._splitBaseDone.has(id)) continue;
      this._splitBaseDone.add(id);
      const [axis, tex, g] = id.split('|');
      this.pipeline.meshFs.warmBase(axis as MeshFsAxis, tex === '1', Number(g), PIPELINE_PRIORITY.DOCUMENT);
    }
    this._splitBaseAxes.clear();
  }
  /** Shadows on (or on at boot) with the split on: queue the shadow-receiving BASE fallbacks of the opaque axes. */
  private _splitWarmShadowBase(priority: PipelinePriority): void {
    if (!shaderSplitActive()) return;
    for (const axis of ['opaqueNoCull', 'opaque'] as const) for (const tex of [false, true]) this.pipeline.meshFs.warmBase(axis, tex, this._splitG(true), priority);
  }
  /** The scene-global key bits, read from the SAME state the uniforms carry this frame: shadows, the render-debug
   *  uniforms (IBLUniforms.dbgShade / dbgFlags, floats 53 / 54) and the inline SSR trace (ssrEnabled && !ssrDeferred,
   *  floats 41 / 52) - so a key never lacks a block the uniforms switch on. */
  private _splitG(shadow: boolean): number {
    const d = this._iblData;
    return (shadow ? MESH_FS_G_SHADOW : 0) | (d[53] !== 0 || d[54] !== 0 ? MESH_FS_G_DEBUG : 0) | (d[41] > 0.5 && d[52] <= 0.5 ? MESH_FS_G_SSR_INLINE : 0);
  }
  /** The split pipeline for packed key `num` on `axis` (exact, a compiled superset, or null = held). */
  private _splitPipe(num: number, axis: MeshFsAxis, shadow: boolean): GPURenderPipeline | null {
    const reg = this.pipeline.meshFs;
    if (reg.onLanded === null) reg.onLanded = () => this.onDeferredWork?.();
    return reg.pick(axis, num, this._splitG(shadow));
  }
  /** The smallest compiled superset of packed key `num` on `axis` (P22: a packed draw uses its twin while the chosen
   *  pipeline's own twin compiles; same pixels), or null. */
  private _splitFallback(num: number, axis: MeshFsAxis, shadow: boolean): GPURenderPipeline | null {
    return this.pipeline.meshFs.fallbackPipe(axis, num, this._splitG(shadow));
  }
  /** SHADER SPLIT switch + diagnostics. `mode` / `enabled` persist per machine (localStorage salsa.shaderSplit);
   *  `bisect` (spec §7 phase-1 risk) and the test knobs (forceFallback, noFallback, slowCompileMs) are session-only. */
  setShaderSplit(o: { enabled?: boolean; mode?: ShaderSplitMode; bisect?: MeshFsBisect; forceFallback?: boolean; noFallback?: boolean; noStandIn?: boolean; slowCompileMs?: number; maxKeys?: number; exclude?: MeshFsFamily[]; clearJournal?: boolean; resetCounters?: boolean } = {}): { active: boolean; mode: ShaderSplitMode; bisect: MeshFsBisect; forceFallback: boolean; noFallback: boolean; noStandIn: boolean; slowCompileMs: number; exclude: readonly MeshFsFamily[]; journal: number } & MeshFsSplitStats {
    const was = shaderSplitActive();
    if (o.mode !== undefined) setShaderSplitMode(o.mode);
    else if (o.enabled !== undefined) setShaderSplitMode(o.enabled ? 'on' : 'off');
    const reg = this.pipeline.meshFs, opts = reg.opts;
    if (o.bisect !== undefined && o.bisect !== opts.bisect) { opts.bisect = o.bisect; reg.remap(); }
    if (o.forceFallback !== undefined) opts.forceFallback = !!o.forceFallback;
    if (o.noFallback !== undefined) opts.noFallback = !!o.noFallback;
    if (o.noStandIn !== undefined) opts.noStandIn = !!o.noStandIn;
    if (o.slowCompileMs !== undefined && Number.isFinite(o.slowCompileMs)) opts.slowCompileMs = Math.max(0, o.slowCompileMs);
    if (o.maxKeys !== undefined && Number.isFinite(o.maxKeys)) { MeshFsPipelines.maxKeys = Math.max(1, Math.floor(o.maxKeys)); reg.remap(); }   // (this session; the tier cap returns on reload)
    if (o.exclude !== undefined && Array.isArray(o.exclude)) {
      // a family exclusion changes which slots get split keys: re-derive every key (full instance repack) + re-code
      setShaderSplitExcluded(o.exclude);
      this.markInstancesDirty(); this._gd?.recode(); reg.remap();
      this._prewarmSeen.opaque = -1; this._prewarmSeen.skinned = -1;
    }
    if (o.clearJournal) reg.clearJournal();
    if (o.resetCounters) reg.resetCounters();
    if (shaderSplitActive() !== was) { this._prewarmSeen.opaque = -1; this._prewarmSeen.skinned = -1; }   // (the GPU-driven re-code: _gdBegin)
    return { active: shaderSplitActive(), mode: SHADER_SPLIT.mode, bisect: opts.bisect, forceFallback: opts.forceFallback, noFallback: opts.noFallback, noStandIn: opts.noStandIn, slowCompileMs: opts.slowCompileMs, exclude: shaderSplitExcluded(), journal: reg.journal().length, ...reg.stats() };
  }
  /** FOG HORIZON silhouette fast path (fog-horizon.ts FOG_HORIZON_FAST): fogged pixels return the fog colour early
   *  while Hard edge + linear fog are on. Pixel-identical; false = the full shading path (A/B). */
  static fogHorizonFastPath = true;
  /** FOG HORIZON CPU cull (Buildings only in fog: non-silhouette families past the fog edge are not drawn). false =
   *  draw them (the shaders still fog / dissolve them) - the A/B that proves the cull itself is invisible. */
  static fogHorizonCpuCull = true;
  /** A/B: the P9 cluster-level fog reject (a cluster wholly past the fog edge skips its culled-class members without
   *  the per-mesh box fetch + fog test). The draw lists are identical either way (cull-clusters-fog.test.ts). */
  static hcFogReject = true;
  /** P11 OCCLUSION CULL (occlusion-culler.ts). Default OFF (opt-in): main-pass meshes / groups wholly behind this
   *  frame's building walls are not drawn. Conservative + same-frame (unit-tested against a dense ray reference). */
  static occlusionCulling = false;
  /** Occlusion buffer width in pixels (height from the aspect). 256 ≈ 6 screen px per buffer pixel at 1540 wide. */
  static OCCLUSION_WIDTH = 256;
  /** Which meshes act as occluders (by name). They must be opaque, untextured and never dissolved. */
  static OCCLUDER_NAMES: RegExp = DEFAULT_OCCLUDER_NAMES;
  private readonly _occl = new OcclusionCuller();
  private readonly _occlCache = new OccluderCache(12);
  /** P11 diagnostics of the last frame's occlusion pass (occluder polygons, pixels covered, boxes tested / culled). */
  get occlusionStats(): OcclusionCuller['stats'] { return this._occl.stats; }
  /** Verification hook (headless drivers): when an array, each frame it is refilled with the meshes and instanced
   *  groups the occlusion cull dropped. null = off (no cost). */
  occlusionDebugList: Array<Mesh3D | ArrayGroup3D> | null = null;
  /** Build this frame's occlusion buffer, or null when the cull is off / cannot run (ortho, planar mirror live). */
  private _beginOcclusion(meshes: Mesh3D[]): OcclusionCuller | null {
    this._frame.msOccl = 0;
    if (!Renderer3D.occlusionCulling || this.camera.mode === 'orthographic' || this._planarActive) return null;
    const t0 = performance.now();
    const oc = this._occl, re = Renderer3D.OCCLUDER_NAMES;
    oc.width = Renderer3D.OCCLUSION_WIDTH;
    oc.begin(this.camera.getViewProjectionMatrix() as unknown as Float32Array, Math.max(1e-3, this.camera.aspect) * 1000, 1000);
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      // occluder: name-matched, drawn this frame (visible, resident, not LOD / fog hidden), opaque, untextured, no
      // dissolve (fog class 0), a static current geometry
      if (m._r3Occl !== re) { m._r3Occl = re; m._r3IsOccl = re.test(m.name ?? ''); }
      if (!m._r3IsOccl || !m.visible || m.gpuDirty || m.lodHidden || m.fogHidden || m.fogClass !== 0 || m.lodTwinRole !== 0
          || m.material.opacity < 1 || m.material.hasTexture || m.alwaysOnTop || m.submeshes.length > 0 || !this._geomAllocs.has(m.id)) continue;
      const g = this._occlCache.get(m as unknown as import('./occlusion-culler').OccluderSource);
      if (g) oc.addOccluder(g);
    }
    oc.finish();
    this._frame.msOccl = performance.now() - t0;
    return oc.stats.pixelsCovered > 0 ? oc : null;
  }
  /** Meshes the occlusion cull must keep: drawn on top / outlined / selected / hovered (their highlight shows through). */
  private _occlExempt(m: Mesh3D): boolean {
    return m.alwaysOnTop || this._meshOutlines.has(m.id) || this._selectedMeshIds.has(m.id) || this._hoveredMeshIds.has(m.id);
  }
  /** P11 CULL RANGES (cull-ranges.ts). A/B: false = every mesh draws whole (the old lists). Bit-identical either way:
   *  a run is dropped only when its box is wholly outside a clip plane of the pass it was dropped from. */
  static rangeCulling = true;
  /** Triangles per run (the cull granularity; adjacent kept runs merge into one draw). */
  static CULL_RANGE_TRIS = 256;
  /** Meshes under this many triangles draw whole. */
  static CULL_RANGE_MIN_TRIS = 2048;
  /** Kept runs separated by at most this many dropped runs draw as one span (fewer draw calls; the gap is clipped). */
  static CULL_RANGE_MERGE_GAP = 2;
  /** Triangles of run boxes built per frame at most (a first street-level frame in a tiled world would otherwise
   *  scan millions of indices at once); a mesh over budget draws whole until a later frame builds it. */
  static CULL_RANGE_BUILD_TRIS = 400_000;
  private _rangeBuildBudget = 0;
  private readonly _rangePool: IndexRange[] = [];
  private _rangePoolN = 0;
  private readonly _rangeSpans: number[] = [];
  /** The run boxes of `m`, or null (not eligible / moving / over this frame's build budget). Cached on the mesh per
   *  geometry + matrix version; a mesh whose matrix changed in the last 120 frames counts as moving (no ranges). */
  private _rangesFor(m: Mesh3D, alloc: GeomAlloc | undefined): CullRanges | null {
    const geo = m.geometry;
    if (!geo || !alloc || m.gpuDirty || m.submeshes.length > 0 || m.vertexColors || m.alwaysOnTop || m.billboard || m.billboardParent || m.material.windSway
        || alloc.indexCount !== geo.indices.length || this._vertexBufferOverrides.has(m.id)) return null;
    const fr = this._shadowFrameNo, v = m.localMatrixVersion, run = Renderer3D.CULL_RANGE_TRIS;
    const c = m._r3Ranges as { owner: Renderer3D; geo: object; ver: number; frame: number; run: number; r: CullRanges | null } | null;
    if (c && c.owner === this && c.geo === geo && c.run === run) {
      if (c.ver === v) { if (c.r) return c.r; if (fr - c.frame < 120) return null; }
      else { c.ver = v; c.frame = fr; c.r = null; return null; }
    }
    const tris = alloc.indexCount / 3;
    if (tris > this._rangeBuildBudget) return null;
    this._rangeBuildBudget -= tris;
    this._frame.rangeBuilds++;
    const r = buildCullRanges(geo.vertices, geo.indices, 12, m.localMatrix as unknown as Float32Array, run);
    m._r3Ranges = { owner: this, geo, ver: v, frame: fr, run, r };
    return r;
  }
  /** P15 Phase C: draw shadow layer `layer` (gpu-driven.ts GdShLayer) of the GPU casters into a depth pass whose pipeline
   *  (the shadow pipeline, or pending: `_skipDraws`) and bind group 0 (`bg0`) the caller set; re-binds them after. */
  private _gdShadowDraw(pass: GPURenderPassEncoder, layer: number, bg0: GPUBindGroup | null | undefined, bgKey: string): void {
    if (!this._gdShThis || !bg0 || this._skipDraws || !this._gd) return;
    const pipe = this.pipeline.shadowPassPipeline;
    if (!pipe) return;
    if (this._gd.drawShadow(pass, layer, pipe, bg0, bgKey)) { this._pkLost(pass); this._setPipe(pass, pipe); pass.setBindGroup(0, bg0); }   // (P22: the bundle cleared the pass state)
  }
  /** P15 Phase C: static layer `k` (0 far, 1 / 2 cascades) re-rendered with this frame's GPU members: commit them. */
  private _gdShCommitLayer(enc: GPUCommandEncoder, k: number): void {
    if (!this._gdShThis || !this._gd || !this._gd.encodeShadowCommit(enc, k)) return;
    this._gdShCommit[k] = this._gd.frame; this._gdShJoinSince[k] = -1; this._gdShJoiners[k] = 0; this._gdShJoinTris[k] = 0;
  }
  /** P15 Phase C: the GPU's joiners of static layer `k` are due (with the CPU's `cpuTris`): the StaticLayerMembers rule. */
  private _gdShDue(k: number, cpuTris: number): boolean {
    if (!this._gdShThis || this._gdShJoiners[k] === 0) return false;
    return this._gdShJoinTris[k] + cpuTris >= Renderer3D.STATIC_JOIN_TRIS || this._shadowFrameNo - this._gdShJoinSince[k] >= Renderer3D.STATIC_JOIN_FRAMES;
  }
  /** P15 Phase C, per frame: the last read-back leaver / joiner counters (frames after each layer's last commit) bump
   *  that layer's epoch (a leaver: the layer must re-render, like a drawn member leaving the CPU's signature), and the
   *  epochs are mixed into the three static-layer signatures (kept and all alike). Freed records bump every layer. */
  private _gdShEpochMix(): void {
    const gd = this._gd!, st = gd.readStats(), ep = this._gdShEpoch;
    if (gd.takeFreed() > 0) { ep[0]++; ep[1]++; ep[2]++; }
    for (let k = 0; k < 3; k++) {
      if (st.shFrame > this._gdShCommit[k]) {
        if (st.shLeave[k] > 0 || (!this._joinDeferOn && st.shJoin[k] > 0)) ep[k]++;
        this._gdShJoiners[k] = st.shJoin[k]; this._gdShJoinTris[k] = st.shJoinTris[k];
        if (st.shJoin[k] > 0) { if (this._gdShJoinSince[k] < 0) this._gdShJoinSince[k] = this._shadowFrameNo; }
        else this._gdShJoinSince[k] = -1;
      } else { this._gdShJoiners[k] = 0; this._gdShJoinTris[k] = 0; }
    }
    this._farSigKept.mix(0x5a17, ep[0], 7); this._farSigAll.mix(0x5a17, ep[0], 7); this._sigMix(0x5a17, ep[0], 7);
    for (let ci = 0; ci < 2; ci++) { this._cascadeSigs[ci].mix(0x5a17, ep[1 + ci], 8 + ci); this._cascadeSigsAll[ci].mix(0x5a17, ep[1 + ci], 8 + ci); }
  }
  /** P15 Phase B: the run table a GPU range job uses for `m`: its current cached table (the same object the CPU's
   *  camera / shadow lists use), else one built now when the mesh is partly in the view (the CPU path's rule, so the
   *  per-frame build budget goes where the CPU path would spend it), else null (draws whole). */
  private _gdRangeTable(m: Mesh3D, alloc: GeomAlloc | undefined, bb: AABB3 | null, culler: FrustumCuller | null): CullRanges | null {
    const c = m._r3Ranges as { owner: Renderer3D; geo: object; ver: number; run: number; r: CullRanges | null } | null;
    if (c && c.owner === this && c.geo === m.geometry && c.ver === m.localMatrixVersion && c.run === Renderer3D.CULL_RANGE_TRIS && c.r && !m.gpuDirty) return c.r;
    if (culler && bb && culler.testBox(bb) && !culler.containsBox(bb)) return this._rangesFor(m, alloc);
    return null;
  }
  /** Push `m`'s runs that pass `t` into `list` as index-range entries (adjacent runs merged). Returns the triangles kept. */
  /** P4.2 / P14: an instanced caster group is dynamic when it sways in the wind or straddles the fog fade band. */
  private _groupCasterDynamic(src: Mesh3D, gb: ArrayLike<number> | null, windOn: boolean): boolean {
    if (windOn && src.material.windSway) return true;
    return this._fhBandOn && !!gb && (src.fogClass === 2 || (src.fogClass === 1 && this._fhBandAttach)) && !src.material.noFog && this._boxFarthest(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5]) >= this._fhBandIn;   // fog horizon P2
  }
  /** P14 cascade split for an instanced caster group: static groups join every cascade they touch (no reach test) and
   *  its signature; dynamic ones join the dynamic list when their shadow reaches the view. `se` = the group's far-map
   *  entry when it has one (shared). */
  private _groupCascades(key: object, src: Mesh3D, firstSlot: number, N: number, gb: ArrayLike<number> | null, se: RendererDrawEntry | null, reachOk: boolean, windOn: boolean, gfs: number, gTris: number): void {
    const dyn = this._groupCasterDynamic(src, gb, windOn);
    if (dyn && !reachOk) return;
    const n = this._cascadeCount, cCull = this._cascadeCullers, lodTexC = this._cascadeLodTex, fs = this._frame;
    let e = se;
    for (let ci = 0; ci < n; ci++) {
      if (gfs > 0 && gfs < lodTexC[ci]) { fs.shadowLodCascade++; continue; }
      if (gb && !cCull[ci].testAABB(gb[0], gb[1], gb[2], gb[3], gb[4], gb[5])) continue;
      const list = dyn ? this._cascadeDynLists[ci] : this._cascadeLists[ci];
      if (e) list.push(e); else { this._pushDraw(list, src, firstSlot, undefined, N); e = list[list.length - 1]; }
      if (!dyn) this._cascStatic(ci, key, this._casterUidOf(src) ^ 0x5bd1e995, firstSlot * 65599 + N, src.localMatrixVersion + ci * 7919, gTris, reachOk ? e : null);
    }
  }

  /** P14: one static far-map caster (`key` = the mesh or the instanced group): the P4.2 signature, and with joiner
   *  deferral (StaticLayerMembers) the kept signature, or — not in the cached layer yet — a joiner drawn with the
   *  dynamic casters (`dynE` = its reach-culled entry; null when its shadow cannot reach the view). */
  private _farStatic(key: object, a: number, b: number, c: number, tris: number, dynE: RendererDrawEntry | null): void {
    this._sigMix(a, b, c);
    if (!this._joinDeferOn) return;
    this._farSigAll.mix(a, b, c);
    this._farStaticKeys.push(key);
    if (this._farMembers.has(key)) this._farSigKept.mix(a, b, c);
    else { this._farMembers.join(tris, this._shadowFrameNo); if (dynE) this._shadowDynList.push(dynE); }
  }
  /** P14: the same for a static caster of near cascade `ci` (its static list already holds the entry). */
  private _cascStatic(ci: number, key: object, a: number, b: number, c: number, tris: number, dynE: RendererDrawEntry | null): void {
    this._cascadeSigsAll[ci].mix(a, b, c);
    if (!this._joinDeferOn) { this._cascadeSigs[ci].mix(a, b, c); return; }
    this._cascadeStaticKeys[ci].push(key);
    if (this._cascadeMembers[ci].has(key)) this._cascadeSigs[ci].mix(a, b, c);
    else { this._cascadeMembers[ci].join(tris, this._shadowFrameNo); if (dynE) this._cascadeDynLists[ci].push(dynE); }
  }
  /** P14 A/B (tile attach): a static caster that is not in a cached static layer yet (a streamed tile's mesh after its
   *  probation, a crowd cell, a parked car) is drawn with the dynamic casters until the joiners pass STATIC_JOIN_TRIS
   *  or the first has waited STATIC_JOIN_FRAMES, then the static layer re-renders with them all. The map is the same
   *  either way. false = every static-set change re-renders the static layer (the P4.2 behaviour). */
  static staticJoinDefer = true;
  static STATIC_JOIN_TRIS = 200_000;
  static STATIC_JOIN_FRAMES = 120;
  private _joinDeferOn = true;
  private readonly _farMembers = new StaticLayerMembers();
  private readonly _farSigAll = new CasterSig();
  private readonly _farSigKept = new CasterSig();
  private _shadowStaticSigAll = 0;
  private readonly _farStaticKeys: object[] = [];
  private readonly _cascadeMembers = [new StaticLayerMembers(), new StaticLayerMembers()];
  private readonly _cascadeSigsAll = [new CasterSig(), new CasterSig()];
  private readonly _cascadeStaticKeys: object[][] = [[], []];

  // ── P14 (performance-plan.md): far-map ranges + near-cascade static cache ──
  /** P14.1 A/B: range-cull the far shadow map's casters (sub-mesh runs) against the light box / shadow reach. */
  static shadowRangeCulling = true;
  /** P14.2 A/B: near cascades keep a cached STATIC layer and redraw only the dynamic casters on top each refresh.
   *  false = every refresh re-renders every caster (the pre-P14 path). */
  static cascadeStaticCache = true;
  /** P14.2: how far (in cascade texels) the wanted cascade centre may drift before the box re-centres (0 = re-centre
   *  every texel, the pre-P14 behaviour). The coverage edge trails the camera by at most this much. */
  static CASCADE_FOLLOW_SLACK_TEXELS = 64;
  private readonly _shadowRunTester = new ShadowRunTester();
  private _cascadeSplitLists = false;                 // this frame's cascade lists are the split ones
  private readonly _cascadeDynLists: RendererDrawEntry[][] = [[], []];
  private _cascadeDynRunsCache: (PassRun[] | null)[] = [null, null];
  private readonly _cascadeSigs = [new CasterSig(), new CasterSig()];
  private readonly _cascadeCache: CascadeCacheState[] = [newCascadeCacheState(), newCascadeCacheState()];
  private _cascadeDynStale = false;                   // a skinned pose changed: the dynamic layer is due now
  private readonly _cascadeWhy = { cold: 0, stale: 0, box: 0, sig: 0 };   // why the static layers re-rendered (diagnostics)
  private _cascadeStaticTex: GPUTexture | null = null;
  private _cascadeStaticViews: GPUTextureView[] = [];
  private _cascadeStaticKey = '';
  private readonly _cascadeHeld: CascadeLightBox[] = [0, 1].map(() => ({ dx: 0, dy: -1, dz: 0, he: 0, size: 0, sx: 0, sy: 0, zn: 0, zf: 0 }));
  private readonly _cascadeHeldRange = [0, 0];
  private readonly _cascadeHeldOk = [false, false];
  private readonly _cascadeWant: CascadeLightBox = { dx: 0, dy: -1, dz: 0, he: 0, size: 0, sx: 0, sy: 0, zn: 0, zf: 0 };
  /** P14 diagnostics: far-map + cascade cache counters (since load) and this frame's cascade list sizes. */
  getShadowCacheStatsP14(): { far: ReturnType<Renderer3D['getShadowCacheStats']>; farJoiners: number; cascade: { split: boolean; joiners: number[]; staticRenders: number; dynPasses: number; recentres: number; why: { cold: number; stale: number; box: number; sig: number }; staticCasters: number[]; dynCasters: number[]; held: boolean[] } } {
    const f = this._frame, n = this._cascadeCount;
    return { far: this.getShadowCacheStats(), farJoiners: this._farMembers.joiners, cascade: { split: this._cascadeSplitLists, joiners: this._cascadeMembers.slice(0, n).map((m) => m.joiners), staticRenders: f.cascadeStaticRenders, dynPasses: f.cascadeDynPasses, recentres: f.cascadeRecentres, why: { ...this._cascadeWhy },
      staticCasters: this._cascadeLists.slice(0, n).map((l) => l.length), dynCasters: this._cascadeDynLists.slice(0, n).map((l) => l.length), held: this._cascadeHeldOk.slice(0, n) } };
  }
  /** The cascade static-layer array (same size / layers as the cascade array); a rebuild drops every cached layer. */
  private _ensureCascadeStaticTex(n: number): void {
    const size = this._csm.mapSize, key = `${size}x${n}`;
    if (key === this._cascadeStaticKey && this._cascadeStaticTex) return;
    this._cascadeStaticTex?.destroy();
    this._cascadeStaticTex = this.device.createTexture({ size: [size, size, n], format: 'depth32float', label: 'ShadowCascadeStatic', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this._cascadeStaticViews = [];
    for (let i = 0; i < n; i++) this._cascadeStaticViews.push(this._cascadeStaticTex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
    this._cascadeStaticKey = key;
    this._dropCascadeCache();
  }
  private _dropCascadeCache(): void { for (const c of this._cascadeCache) { c.valid = false; c.sigDrawn = NaN; c.dynInMap = false; } for (const m of this._cascadeMembers) m.clear(); }
  private _dropCascadeStaticTex(): void {
    this._cascadeStaticTex?.destroy(); this._cascadeStaticTex = null; this._cascadeStaticViews = []; this._cascadeStaticKey = '';
    this._dropCascadeCache();
  }

  private _rangedPush(list: RendererDrawEntry[], m: Mesh3D, slot: number, rg: CullRanges, t: BoxTester): number {
    const sp = this._rangeSpans;
    const kept = selectRanges(rg, t, sp, Renderer3D.CULL_RANGE_MERGE_GAP);
    for (let k = 0; k < sp.length; k += 2) {
      this._pushDraw(list, m, slot);
      let r = this._rangePool[this._rangePoolN];
      if (r === undefined) { r = { indexOffset: 0, indexCount: 0 }; this._rangePool[this._rangePoolN] = r; }
      this._rangePoolN++;
      r.indexOffset = sp[k]; r.indexCount = sp[k + 1];
      list[list.length - 1].range = r;
    }
    return kept;
  }
  /** A/B: _ensureGeomPool skips resident, clean meshes whose P9 slot cache is current (2026-10-01; identical result). */
  static geomPoolFastSkip = true;
  /** P8 GROUND RELIEF LOD (scene.cascadeBias.w): fade the procedural ground's relief normal out between a 4 and an
   *  8 cm pixel footprint and skip its four height samples beyond (not bit-identical: sub-pixel relief noise goes). */
  static groundReliefLod = false;

  /** Lock the shadow box at origin (box already spans the scene) or let it follow the camera focus. */
  setShadowFollowCamera(on: boolean): void {
    if (this._shadowFollowCamera === on) return;
    this._shadowFollowCamera = on;
    if (!on) vec3.set(this._lsmCenter, 0, 0, 0);   // snap back to the origin-locked box
    this._shadowMapStale = true;
  }

  private computeLightSpaceMatrix(): Float32Array {
    // Pure math in scene-uniforms.ts (C1 Part 2); the renderer owns the persistent scratch + inputs.
    return computeLSM(this._shadowDir, this._effHe, this._lsmCenter, this._lsmScratch);   // P14: the stepped shadow direction
  }

  getMeshWorldAABB3D(mesh: Mesh3D, out?: AABB3): AABB3 | null {
    const geom = mesh.geometry;
    if (!geom || geom.vertices.length === 0) return null;

    const matVersion = mesh.localMatrixVersion;
    let cached = mesh._r3Aabb as MeshAABBEntry | null;
    if (!cached || cached.owner !== this || cached.dead || cached.ref !== mesh) {
      cached = this._meshAABBCache.get(mesh.id) ?? null;
      if (cached) mesh._r3Aabb = cached;
    }

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
    } else if (this.useGeometryBounds && (geom as { bounds?: ArrayLike<number> }).bounds?.length === 6) {
      // P9: PRECOMPUTED bounds (world builds attach them after the drape; near/far twins of one chunk share one
      // union box so their swap decisions agree exactly) — the same box Mesh3D.calculateBoundingBox uses.
      const pre = (geom as { bounds?: ArrayLike<number> }).bounds!;
      ox0 = pre[0]; oy0 = pre[1]; oz0 = pre[2]; ox1 = pre[3]; oy1 = pre[4]; oz1 = pre[5];
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
      if (cached) {
        cached.lMinX = ox0; cached.lMinY = oy0; cached.lMinZ = oz0; cached.lMaxX = ox1; cached.lMaxY = oy1; cached.lMaxZ = oz1;
        cached.wMinX = wx0; cached.wMinY = wy0; cached.wMinZ = wz0; cached.wMaxX = wx1; cached.wMaxY = wy1; cached.wMaxZ = wz1;
        cached.matVersion = matVersion;
      } else {
        const e: MeshAABBEntry = {
          lMinX: ox0, lMinY: oy0, lMinZ: oz0,
          lMaxX: ox1, lMaxY: oy1, lMaxZ: oz1,
          wMinX: wx0, wMinY: wy0, wMinZ: wz0,
          wMaxX: wx1, wMaxY: wy1, wMaxZ: wz1,
          matVersion, owner: this, dead: false, ref: mesh,
        };
        this._meshAABBCache.set(mesh.id, e);
        mesh._r3Aabb = e;
      }
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
    this._viewH = h;                    // P8 shadow LOD: the screen-size guard's pixel angle
    this._selectNearestPointLights();   // camera-follow point lights: pick the nearest-N candidates before writing the uniform
    // Re-centre the shadow box on the camera focus BEFORE the light matrix is computed below, so the map the
    // shadow pass renders this frame and the matrix the main pass samples with agree. Marks the map stale when
    // the (texel-snapped) centre actually moves, so throttled shadows refresh on pan without per-frame cost.
    this._updateShadowCenter();
    this._updateCascades();   // persona-polish A2: near cascades around the camera (after the far box settled)

    // The struct LAYOUT (all float offsets) lives in scene-uniforms.ts packSceneUniforms (C1 Part 2,
    // unit-tested there); this method gathers the live inputs and uploads the packed buffer.
    const data = this._sceneUniformsData;
    computeFogEye(this.camera, this._fogEye);   // fog horizon: the point fog is measured from (perspective = the camera)
    const fhActive = this.fogHorizonActive;
    const fhFade = fhActive && this._fogHorizon.buildingsOnly ? this._fogHorizon.fadeM * this.fogHorizonUnitsPerMetre : 0;
    packSceneUniforms(data, {
      vp: this.camera.getViewProjectionMatrix() as Float32Array,
      camPos: this.camera.position,
      orthographic: this.camera.mode === 'orthographic',
      ambientColor: this._ambientColor, ambientIntensity: this._ambientIntensity,
      light: this._light, ps1: this._ps1, w, h,
      shadowMinLight: this._shadowMinLight, glassRefraction: this._glassRefraction,
      lightSpaceMatrix: this._shadowsEnabled ? this.computeLightSpaceMatrix() : null,
      shadowPcfRadius: this._shadowPcfRadius, effBias: this._effBias,
      shadowMapSize: this._shadowMapSize, shadowSoftness: this._shadowSoftness,
      fog: this._fog, aerialFog: this.fogHardEdge ? 0 : this._aerialFog,
      pointLights: this._lightsForUpload(), wind: this._wind,
      glassQuality: this._glassQuality,
      timeSec: this._worldTimeSec() % 3600,
      softLightStrength: this._softLightStrength,
      skinRamp: {
        bands: this._skinRamp.bands, softness: this._skinRamp.softness,
        shadowFloor: this._skinRamp.shadowFloor, tintPacked: packRGB8(this._skinRamp.shadowTint),
      },
      sketchPaper: this._sketchPaper,
      shadowTintPacked: this._shadowTint ? packRGB8(this._shadowTint) : 0,
      heightFog: this.fogHardEdge ? [0, 0, 1, 0.05] : this._heightFog,
      toon: {
        bands: this._toon.bands, softness: this._toon.softness, shadowValue: this._toon.shadowValue,
        tintPacked: packRGB8(this._toon.shadowTint), saturation: this._toon.saturation,
      },
      rim: { strength: this._rim.strength, width: this._rim.width, hardness: this._rim.hardness, colorPacked: packRGB8(this._rim.color) },
      cascades: this._cascadePack,   // count 0 = off (the shaders sample only the original map)
      aerialHaze: this.fogHardEdge ? [0, 20, 0.6, 0.5] : this._aerialHaze,
      shaderFastPaths: Renderer3D.shaderFastPaths ? 1 : 0,   // P8 (cascadeBias.z)
      groundReliefLod: Renderer3D.groundReliefLod ? 1 : 0,   // P8 (cascadeBias.w)
      fogEye: this._fogEye,                                     // fog horizon (fogEye.xyz)
      fogFade: fhFade,                                          // fog horizon fade band (fogEye.w, world units)
      fogHorizonFlags: fogHorizonFlags(fhActive, this._fogHorizon, fhFade, this.fogHardEdge) & (Renderer3D.fogHorizonFastPath ? ~0 : ~1),   // toonParams.w (0 = inert; HARD alone = noFog 'hardEdge' meshes skip the fog)
      taaDitherShift: this._taaOn ? this._taaDither : 0,     // temporal AA: the dither fades move every frame (cascadeParams.w)
    });
    this.device.queue.writeBuffer(this.sceneUniformBuffer, 0, data);
    // RENDER DEBUG shading mode (render-debug.ts → IBLUniforms.dbgShade, float 53): written only when it changes.
    // (+ the shader debug bits, IBLUniforms.dbgFlags, float 54)
    const dbgShade = RD.on ? renderDebugShadeMode() : 0, dbgBits = RD.on ? renderDebugShaderBits() : 0;
    if (dbgShade !== this._iblData[53] || dbgBits !== this._iblData[54]) { this._iblData[53] = dbgShade; this._iblData[54] = dbgBits; this._writeIBLBuffer(); }
  }

  private ensureInstanceBuffer(count: number): void {
    if (this.instanceCapacity >= count && this.instanceStorageBuffer) return;
    // P5: when the GPU buffer is CONSISTENT (no full repack pending) grow it by a GPU-side copy and keep every slot —
    // the first view that reveals the city's instanced detail used to pay a growth → full repack here.
    if (this.instanceStorageBuffer && this._instanceDataBuf && !this._instancesDirty && this.incrementalArrayGroups) { this._growInstanceBuffer(count); return; }

    if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();

    // 50% headroom: every growth is EXPENSIVE (new GPUBuffer + bind-group + a forced full repack re-uploading the
    // whole instance range), and a streamed world's slot count climbs steadily while panning — the old 25% caused
    // dozens of growth-repack stalls per session (perf() showed 56 atlasRebuilds, all buffer growths).
    this.instanceCapacity = Math.max(Math.ceil(count * 1.5), INITIAL_INSTANCE_CAPACITY);
    this.instanceStorageBuffer = this.device.createBuffer({
      size: this.instanceCapacity * MESH_INSTANCE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,   // COPY_SRC: P5 preserving growth
    });
    // Buffer reference changed — bind group, instance data, and texture atlas must be rebuilt.
    this._instancesDirty = true;
    this._atlasDirty = true;
    this._meshBindGroupBuffer = null;
  }

  /** P5: grow the instance buffer to hold `count` slots (+50%) WITHOUT a repack: copy the old buffer on the GPU, grow
   *  the CPU mirror, rebind (the mesh bind group follows the buffer reference). Slot maps, the allocator's ranges and
   *  the atlas indices all stay valid. The old buffer is destroyed once this frame's work was submitted. */
  private _growInstanceBuffer(count: number): void {
    const old = this.instanceStorageBuffer!, oldCap = this.instanceCapacity;
    this.instanceCapacity = Math.max(Math.ceil(count * 1.5), INITIAL_INSTANCE_CAPACITY);
    this.instanceStorageBuffer = this.device.createBuffer({
      size: this.instanceCapacity * MESH_INSTANCE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const enc = this.device.createCommandEncoder({ label: 'instance grow' });
    enc.copyBufferToBuffer(old, 0, this.instanceStorageBuffer, 0, oldCap * MESH_INSTANCE_STRIDE);
    this.device.queue.submit([enc.finish()]);
    this._retireBuffer(old);
    const fpi = MESH_INSTANCE_STRIDE / 4, cur = this._instanceDataBuf!;
    if (cur.length < this.instanceCapacity * fpi) { const bigger = new Float32Array(this.instanceCapacity * fpi); bigger.set(cur); this._instanceDataBuf = bigger; }
    this._slotAlloc.setCapacity(this.instanceCapacity);
    this._meshBindGroupBuffer = null;
    this._perf.instanceGrows++;
  }

  /** Destroy a replaced GPU buffer only after the work already recorded against it (this frame's encoder) was
   *  submitted and finished — a destroyed buffer in a pending submit is a validation error. */
  private _retireBuffer(b: GPUBuffer): void {
    const q = this.device.queue as GPUQueue & { onSubmittedWorkDone?: () => Promise<void> };
    const kill = (): void => { try { b.destroy(); } catch { /* already gone */ } };
    if (typeof q.onSubmittedWorkDone === 'function') q.onSubmittedWorkDone().then(() => setTimeout(kill, 0), kill);
    else setTimeout(kill, 1000);
  }

  /** P5 A/B switch: false restores the pre-P5 behaviour (a changed array-group SET forces the full repack, buffer
   *  growth re-packs, geometry-pool overflow compacts). `renderer3D.incrementalArrayGroups = false`. */
  incrementalArrayGroups = true;

  /** The cached DataView over the instance staging buffer — the SINGLE source of truth, recreated whenever the
   *  backing Float32Array was reallocated (identity check on `.buffer`). The P8 cache (`_instanceDataView`) went
   *  stale whenever `_instanceDataBuf` was reallocated on a path that forgot to refresh it (the incremental grow),
   *  leaving `data` and the view over DIFFERENT buffers → the Float writes landed but `setUint32` threw
   *  "Offset outside bounds". Deriving the view here makes that class of bug impossible. */
  private _instanceView(): DataView {
    const buf = this._instanceDataBuf!;
    if (!this._instanceDataView || this._instanceDataView.buffer !== buf.buffer) {
      this._instanceDataView = new DataView(buf.buffer);
    }
    return this._instanceDataView;
  }

  /** World AABB over a group's instance positions (source + explicit offsets, transformed by the source's parent
   *  chain), expanded by the canonical extent — for whole-group frustum culling. Cached per source-matrix version.
   *  Non-explicit modes (array tool) return null → never group-culled. */
  // ── P22 propCull (tile-landing.ts P22_RENDER.propCull) ──────────────────────────────────────────────────────────────
  /** Prop groups with at least this many copies cull per run of copies. */
  static PROP_CULL_MIN = 24;
  /** Copies per run (one box each; consecutive copies are spatially close: the builders emit prop by prop). */
  static PROP_CULL_RUN = 4;   // street pose, CPU path: 8 → 7.16 M main tris / 5,770 draws, 4 → 7.00 M / 5,944, 2 → 6.82 M / 6,331
  /** Kept runs separated by at most this many dropped ones merge into one draw (a draw costs more than a few props). */
  static PROP_CULL_GAP = 1;
  private readonly _propSpans: number[] = [];
  private _propCulledTris = 0;
  private readonly _propTabs = new Map<string, { ver: number; n: number; xf: Float32Array; tab: CullRanges | null }>();
  /** The run table of an instanced prop group: runs of PROP_CULL_RUN copies (first / count in COPIES), each box = its
   *  copies' origins (the group's explicit offsets through the parent chain, as _arrayGroupWorldAABB) ± the same
   *  geometry margin as the group box; blocks of 16 runs. Cached per group (source matrix version, count, transforms). */
  private _propCullTable(group: ArrayGroup3D, source: Mesh3D, N: number): CullRanges | null {
    const xf = group.instanceXf!, ver = source.localMatrixVersion;
    const c = this._propTabs.get(group.id);
    if (c && c.ver === ver && c.n === N && c.xf === xf) return c.tab;
    let tab: CullRanges | null = null;
    const p = group.arrayParams;
    if (p.mode === 'explicit' && p.offsets.length >= N) {
      const m = source.parentChainMatrix as unknown as Float32Array;
      const sb = this.getMeshWorldAABB3D(source, this._aabbScratch);
      const mg = sb ? Math.max(sb.maxX - sb.minX, sb.maxY - sb.minY, sb.maxZ - sb.minZ) : 0;
      const run = Math.max(1, Renderer3D.PROP_CULL_RUN | 0), n = Math.ceil(N / run), br = 16, nb = Math.ceil(n / br);
      const first = new Int32Array(n), count = new Int32Array(n), box = new Float64Array(n * 6), blockBox = new Float64Array(nb * 6);
      for (let b = 0; b < nb; b++) { blockBox[b * 6] = blockBox[b * 6 + 1] = blockBox[b * 6 + 2] = Infinity; blockBox[b * 6 + 3] = blockBox[b * 6 + 4] = blockBox[b * 6 + 5] = -Infinity; }
      for (let r = 0; r < n; r++) {
        const i0 = r * run, i1 = Math.min(N, i0 + run);
        first[r] = i0; count[r] = i1 - i0;
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = i0; i < i1; i++) {
          const o = p.offsets[i];
          const wx = m[0] * o[0] + m[4] * o[1] + m[8] * o[2] + m[12], wy = m[1] * o[0] + m[5] * o[1] + m[9] * o[2] + m[13], wz = m[2] * o[0] + m[6] * o[1] + m[10] * o[2] + m[14];
          if (wx < x0) x0 = wx; if (wx > x1) x1 = wx; if (wy < y0) y0 = wy; if (wy > y1) y1 = wy; if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
        }
        const q = r * 6;
        box[q] = x0 - mg; box[q + 1] = y0 - mg; box[q + 2] = z0 - mg; box[q + 3] = x1 + mg; box[q + 4] = y1 + mg; box[q + 5] = z1 + mg;
        const o = Math.floor(r / br) * 6;
        for (let k = 0; k < 3; k++) { if (box[q + k] < blockBox[o + k]) blockBox[o + k] = box[q + k]; if (box[q + 3 + k] > blockBox[o + 3 + k]) blockBox[o + 3 + k] = box[q + 3 + k]; }
      }
      tab = { n, first, count, box, blockRuns: br, blockBox, inst: true };
    }
    if (this._propTabs.size > 8192) this._propTabs.clear();
    this._propTabs.set(group.id, { ver, n: N, xf, tab });
    return tab;
  }
  private _arrayGroupWorldAABB(group: ArrayGroup3D, source: Mesh3D): [number, number, number, number, number, number] | null {
    const ver = source.localMatrixVersion;
    const cached = this._agAABBCache.get(group.id);
    if (cached && cached.ver === ver) return cached.box;
    let box: [number, number, number, number, number, number] | null = null;
    let org: [number, number, number, number, number, number] | null = null;   // P8: instance ORIGINS only (no geometry margin)
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
      org = [wx0, wy0, wz0, wx1, wy1, wz1];
    }
    this._agAABBCache.set(group.id, { ver, box, org });
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
    this._writePatternSlots(data, offset, mm);
  }

  // ── Procedural-ground uv scale (ground-uv-scale.ts) ─────────────────────────────────────────────────────────────
  /** Per mesh: the geometry + 3×3 model part the cached scale was computed for. */
  private _groundUvScaleCache = new Map<string, { geo: unknown; m: number[]; s: [number, number] | null }>();

  /** For an UNTEXTURED procedural-ground mesh, write its world-units-per-uv (computed once from the geometry + the
   *  model matrix already in the slot) into uvTransform (floats 56-59) with the marker, so the shader stops deriving
   *  it per pixel (the noisy / shimmering grout). Call AFTER the slot's model matrix + material floats are written.
   *  Every other mesh returns immediately. Cached per mesh by geometry identity + the 3×3 matrix values. */
  private _writeGroundUvScale(data: Float32Array, offset: number, mesh: Mesh3D): void {
    // FLAGS2 (material-3d.ts: normalMatrix column 3 .x, an integer-valued float the normal transform multiplies by 0).
    // Here because every slot writer calls this after the matrices (and the material-only rewrites too).
    data[offset + FLAGS2_FLOAT_OFFSET] = encodeMeshFlags2(mesh);
    data[offset + FLAGS2_FLOAT_OFFSET + 1] = mesh.hlodFade >= 0 ? mesh.hlodFade : 0;   // P17 HLOD fade coverage (column 3 .y, x 0 like .x)
    // STEP 8: the shader-variant key = the flags exactly as just written to this slot (floats 43, a u32), so a variant
    // pipeline is only ever chosen for a mesh whose instance flags equal its constant. Multi-material meshes: none.
    if (this._svU32 === null || this._svU32.buffer !== data.buffer) this._svU32 = new Uint32Array(data.buffer);
    const svk = mesh.submeshes.length === 0 ? variantKeyOfFlags(this._svU32[(data.byteOffset >> 2) + offset + 43]) : -1;
    if (svk !== mesh._r3VF) { this._svKeyGen++; mesh._r3VF = svk; }
    // SHADER SPLIT: the packed key of the flags + flags2 + pattern params just written (-1 = not covered: today's
    // pipelines; multi-material meshes key per slot at their draw). A face-kit overlay draws on the textured PLAIN
    // multiply pipeline: its key is textured and PLAIN-safe only.
    if (mesh.submeshes.length === 0) {
      const fk = meshFsKeyNum(this._svU32[(data.byteOffset >> 2) + offset + 43], data[offset + FLAGS2_FLOAT_OFFSET],
        mesh.isFaceFeatures || !!(mesh.material.hasTexture || mesh.material.hasNormalMap), data[offset + 54], data[offset + 55]);
      mesh._r3FK = mesh.isFaceFeatures && !meshFsNumPlainSafe(fk) ? -1 : fk;
    } else mesh._r3FK = -1;
    const mm = mesh.material;
    if (!mm.groundShade || mm.hasTexture || mm.hasNormalMap || mm.garpTex) return;
    const geo = mesh.groundUvSample ?? mesh.geometry;   // chunked city ground: the unsplit layer's sample (no seams)
    if (!geo?.vertices?.length || !geo.indices?.length) return;
    const m9 = [data[offset], data[offset + 1], data[offset + 2], data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 8], data[offset + 9], data[offset + 10]];
    let c = this._groundUvScaleCache.get(mesh.id);
    if (!c || c.geo !== geo || c.m.some((x, i) => x !== m9[i])) {
      c = { geo, m: m9, s: groundUvWorldScale(geo, data.subarray(offset, offset + 16)) };
      this._groundUvScaleCache.set(mesh.id, c);
    }
    if (!c.s) return;   // degenerate uv → the shader keeps its per-pixel estimate
    data[offset + 56] = c.s[0]; data[offset + 57] = c.s[1]; data[offset + 58] = GROUND_UV_SCALE_MARKER; data[offset + 59] = 0;
  }

  /** Write the pattern instance slots (floats 48–55). Several features REPURPOSE them, which is why they are
   *  mutually exclusive with patternMode (and each other) per mesh: boardShade (bit 16, packaging paperboard)
   *  → (rimU, rimV, rimStrength, grainAmp) + the panel's dieline-UV rect; groundShade (bit 18) → seam/tile/
   *  jitter/mode; windSway + foliageShade (bits 19/20) → the foliage wind + translucency payload. */
  private _writePatternSlots(data: Float32Array, offset: number, mm: Mesh3D['material']): void {
    // UV transform (floats 56-59): diffuse/normal sample UV = uv * tiling + offset. Independent of the pattern
    // family below (which repurposes 48-55), so written here FIRST — before every early return — so it lands on
    // ground/board/foliage meshes too. Default (1,1,0,0) = map once, no pan.
    const tt = mm.textureTiling, to = mm.textureOffset;
    data[offset + 56] = tt?.[0] ?? 1; data[offset + 57] = tt?.[1] ?? 1;
    data[offset + 58] = to?.[0] ?? 0; data[offset + 59] = to?.[1] ?? 0;
    if (mm.crowdPalette) {
      // CROWD PALETTE (performance-plan P12, crowd-palette.ts): patternColor.xyz = the packed per-instance palette slots
      // (array copies take their own from InstanceOverride.crowdSlots). The crowd draws no pattern (plain shader).
      const cs = mm.crowdSlots;
      data[offset + 48] = cs?.[0] ?? 0; data[offset + 49] = cs?.[1] ?? 0; data[offset + 50] = cs?.[2] ?? 0; data[offset + 51] = 0;
      data[offset + 52] = 8; data[offset + 53] = 0; data[offset + 54] = 0.5; data[offset + 55] = 0;
      return;
    }
    if (mm.windSway || mm.foliageShade) {
      // FOLIAGE (foliage-quality S1/S2, flag bits 19/20) repurposes the slots — see Material3D.windSway:
      //   patternColor  = (translucency, groundBlend, baseAO, packedGroundTint)
      //   patternParams = (windHeight, windStiffness, windAmount, packedTranslucencyColor)
      // The two colours are 8:8:8-packed into a single float each (packRGB8 / fq_unpackRGB) because six
      // scalars + two colours do not fit in the eight repurposed floats. Wind reads patternParams.xyz in
      // the VERTEX stage (incl. the shadow pass); the rest is fragment-side.
      data[offset + 48] = mm.translucency ?? 0;
      data[offset + 49] = mm.groundBlend ?? 0;
      data[offset + 50] = mm.baseAOAmount ?? 0;
      data[offset + 51] = packRGB8(mm.groundTint ?? [0.28, 0.30, 0.18]);
      data[offset + 52] = mm.windHeight ?? 1;
      data[offset + 53] = mm.windStiffness ?? 1.6;
      data[offset + 54] = mm.windSway ? (mm.windAmount ?? 1) : 0;
      data[offset + 55] = packRGB8(mm.translucencyColor ?? [0.62, 0.86, 0.40]);
      return;
    }
    if (mm.metalShade) {
      // METAL (bit 23): patternColor = (tint.rgb, packed streak colour), patternParams = (roughness,
      // streakAmount, grime, scale). See mesh3d-shaders metalSurface.
      const mt = mm.metalTint ?? [0.42, 0.43, 0.46];
      data[offset + 48] = mt[0]; data[offset + 49] = mt[1]; data[offset + 50] = mt[2];
      data[offset + 51] = packRGB8(mm.metalStreak ?? [0.20, 0.20, 0.21]);
      data[offset + 52] = mm.metalRoughness ?? 0.5;
      data[offset + 53] = mm.metalStreakAmount ?? 0.6;
      data[offset + 54] = mm.metalGrime ?? 0.5;
      data[offset + 55] = mm.metalScale ?? 1;
      return;
    }
    if (mm.neonShade) {
      // NEON (bit 22): patternColor = (glow.rgb, packed accent), patternParams = (scanDensity, flicker,
      // scroll, phase). See mesh3d-shaders neonSign.
      const gl = mm.neonGlow ?? [0.35, 0.95, 1.0];
      data[offset + 48] = gl[0]; data[offset + 49] = gl[1]; data[offset + 50] = gl[2];
      data[offset + 51] = packRGB8(mm.neonAccent ?? [1.0, 0.45, 0.9]);
      data[offset + 52] = mm.neonScanDensity ?? 22;
      data[offset + 53] = mm.neonFlicker ?? 0.18;
      data[offset + 54] = mm.neonScroll ?? 0.35;
      data[offset + 55] = mm.neonPhase ?? 0;
      return;
    }
    if (mm.waterShade) {
      // WATER (bit 21): patternColor = (deep.rgb, packed shallow), patternParams = (waveScale, waveSpeed,
      // choppiness, glitter). See mesh3d-shaders waterSurface.
      const d = mm.waterDeep ?? [0.05, 0.20, 0.30];
      data[offset + 48] = d[0]; data[offset + 49] = d[1]; data[offset + 50] = d[2];
      data[offset + 51] = packRGB8(mm.waterShallow ?? [0.28, 0.55, 0.60]);
      data[offset + 52] = mm.waterWaveScale ?? 1.0;
      data[offset + 53] = mm.waterWaveSpeed ?? 1.0;
      data[offset + 54] = mm.waterChoppy ?? 0.5;
      data[offset + 55] = mm.waterGlitter ?? 1.0;
      return;
    }
    if (mm.groundShade) {
      // procedural ground (bit 18) repurposes the slots: patternColor = (seamRGB, groutWidthUv),
      // patternParams = (p0, p1, jitter, groundMode). seam = grout (ashlar/radial/border) OR dirt tint (grass,
      // mode 3 — no grout, so the seam slot carries the P4 dirt-path colour). See mesh3d-shaders groundSurface.
      const g = mm.groundGrout, t = mm.groundTile, mode = mm.groundMode ?? 0;
      if (mode === 3) {
        const d = mm.groundDirtTint;
        data[offset + 48] = d?.[0] ?? 0.40; data[offset + 49] = d?.[1] ?? 0.31; data[offset + 50] = d?.[2] ?? 0.20; data[offset + 51] = 0;
      } else {
        data[offset + 48] = g?.r ?? 0.47; data[offset + 49] = g?.g ?? 0.45; data[offset + 50] = g?.b ?? 0.41; data[offset + 51] = g?.a ?? 0.015;
      }
      // p0/p1 and the grout width are METRES (the shader derives metres-per-uv per fragment) — defaults
      // are a 900 × 600 mm landscape paver, matching applyGroundMaterial3D.
      data[offset + 52] = t?.[0] ?? 0.9; data[offset + 53] = t?.[1] ?? 0.6; data[offset + 54] = mm.groundJitter ?? 1;
      // mode + 100 * round(worldScale * 10): worldScale = METRES PER WORLD UNIT (0 = standalone 1:1 with a
      // 0..1-region uv). Packed into the mode slot because all 8 pattern floats + all 4 specular floats are
      // already spoken for. See Material3D.groundWorldScale.
      data[offset + 55] = mode + 100 * Math.round(Math.max(mm.groundWorldScale ?? 0, 0) * 10);
      // P2 WEATHERING (procedural-ground §5) ALSO repurposes specularColor (floats 36-39) — ground is a
      // dielectric (metalness 0), so PBR spec is unused here: specular.r = weather profile 0-4, specular.gba =
      // wear-path (center uv + radius; radius 0 = noise-only). See mesh3d-shaders groundWeather. diffuse.a stays
      // the output opacity (NOT repurposed — a 0 profile would else make the 'new' look transparent).
      const wp = mm.groundWearPath;
      data[offset + 36] = mm.groundWeather ?? 1;    // default 'worn'
      data[offset + 37] = wp?.[0] ?? 0.5; data[offset + 38] = wp?.[1] ?? 0.5; data[offset + 39] = wp?.[2] ?? 0;
      return;
    }
    if (mm.boardShade && mm.boardUVRect) {
      const r = mm.boardUVRect, ru = mm.boardRimUV;
      data[offset + 48] = ru?.[0] ?? 0.01;              data[offset + 49] = ru?.[1] ?? 0.01;
      data[offset + 50] = mm.boardRimStrength ?? 0.12;  data[offset + 51] = mm.boardGrain ?? 0.08;
      data[offset + 52] = r[0]; data[offset + 53] = r[1]; data[offset + 54] = r[2]; data[offset + 55] = r[3];
      return;
    }
    const pc = mm.patternColor;
    // .a = the 'windows' lit-glow multiplier (visual-polish #8, opt-in: absent -> 0 -> the shader's 1x)
    data[offset + 48] = pc?.r ?? 0; data[offset + 49] = pc?.g ?? 0; data[offset + 50] = pc?.b ?? 0; data[offset + 51] = mm.patternMode === 'windows' ? (mm.windowGlow ?? 0) : 0;
    data[offset + 52] = mm.patternFreq ?? 8; data[offset + 53] = mm.patternAngle ?? 0; data[offset + 54] = mm.patternScale ?? 0.5; data[offset + 55] = mm.patternSpacing ?? 0;
  }

  /** Take an instance slot: reuse a freed one, else grow the high-water. Returns -1 if the buffer is full (caller
   *  bails to a full repack, which compacts + grows). */
  private _takeInstanceSlot(): number {
    return this._slotAlloc.alloc(1);
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
    this._writeGroundUvScale(data, offset, m);   // P5: as the full writer does (slotcheck found appended ground slots at the default uv scale)
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
    this._writeGroundUvScale(data, offset, m);   // P5: the ground uv scale depends on the matrix
  }

  /** INCREMENTAL instance update (the streaming-pan smoothness fix): append newly-added meshes into freed/high-water
   *  slots and upload ONLY those, instead of re-sorting + re-uploading the ENTIRE instance buffer (the full repack).
   *  Removed meshes already freed their slots in evictMeshCaches. Only valid when nothing needs the sort's contiguity
   *  or the atlas (no array groups / billboards / textures) — the caller gates on that; this bails (→ full repack) on
   *  anything it can't handle, so correctness is always preserved. */
  private _tryIncrementalInstances(meshes: Mesh3D[], anyMatDirty: boolean, arraySlots = 0): boolean {
    const data = this._instanceDataBuf;
    if (!data || !this.instanceStorageBuffer) return false;
    // A NEW array-group source needs its instances contiguous after its own slot → only the full repack can do that.
    const arraySources = this._arrayGroups.length ? this._arraySourceCounts() : null;   // sourceId → instance count
    const incDirtySources = this._fpDirtySources; incDirtySources.clear();
    let incMat = 0, incDeferred = false, incAdded = false;
    const fpi = MESH_INSTANCE_STRIDE / 4;
    // The CPU shadow must span the whole buffer capacity (the free list can place slots past the last full repack's tail).
    if (data.length < this.instanceCapacity * fpi) {
      const bigger = new Float32Array(this.instanceCapacity * fpi); bigger.set(data); this._instanceDataBuf = bigger;
    }
    const buf = this._instanceDataBuf!;
    this._slotAlloc.setCapacity(this.instanceCapacity);
    const dataView = this._instanceView();   // always synced to buf's current buffer (see _instanceView) — the "add primitive → drag → mouseup → RangeError" fix
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
          const deferM = !m.gpuDirty && m.materialDirty && incMat >= Renderer3D.MATERIAL_SLOT_BUDGET;   // P4.3 budget
          if (deferM) incDeferred = true;
          if ((m.gpuDirty || m.materialDirty) && !deferM) {
            incMat += hadMulti.length;
            for (let si = 0; si < hadMulti.length; si++) {
              const sub = m.submeshes[si], sm = sub.material;
              if (sm.hasTexture || sm.hasNormalMap) {
                // P4.3: textured → full write of this one slot (atlas indices from the last atlas build) unless the
                // atlas itself is dirty (then only the full repack can rebuild it).
                if (this._atlasDirty) { this._incBailWhy = 'texturedAtlasDirty'; return false; }
                this._writeInstanceSlot(hadMulti[si], m, sm, sub.textureLibraryId ?? '', sub.normalMapLibraryId ?? ''); touched.push(hadMulti[si]);
                continue;
              }
              this._writeSlotMaterial(buf, dataView, hadMulti[si] * fpi, sm); this._writeGroundUvScale(buf, hadMulti[si] * fpi, m); touched.push(hadMulti[si]);
            }
            m.materialDirty = false;
          }
          continue;
        }
      } else {
        if (hadMulti) return false;                                     // multi→single flip → full repack
        if (hadSingle) {                                                // resident, unchanged shape
          if (this._slotMatVer.get(m.id) !== m.localMatrixVersion) {    // …but MOVED → rewrite matrices
            if (arraySources && arraySources.has(m.id)) { this._incBailWhy = 'movedArraySource'; return false; }   // a moved array source → full repack (instances follow it)
            this._writeIncSlotMatrices(buf, normalMat, hadSingleSlot!, m); touched.push(hadSingleSlot!);
            this._slotMatVer.set(m.id, m.localMatrixVersion);
          }
          const deferS = !m.gpuDirty && m.materialDirty && incMat >= Renderer3D.MATERIAL_SLOT_BUDGET;   // P4.3 budget
          if (deferS) incDeferred = true;
          if ((m.gpuDirty || m.materialDirty) && !deferS && arraySources && arraySources.has(m.id)) { incDirtySources.add(m.id); incMat += Math.ceil(arraySources.get(m.id)! / 4); }   // P4.3: its instances copy its material (weighted into the budget)
          // ★ MATERIAL change on a RESIDENT mesh (the "Apply Ground does nothing" bug). This path used to
          // `continue` on any unmoved resident, so a mesh whose MATERIAL changed never had its slot's material
          // floats (+ the repurposed ground/board/foliage pattern slots) rewritten — and because `gpuDirty` is
          // cleared by the geometry-pool pass later the SAME frame, the change was lost for good, until some
          // unrelated structural edit (adding the scatter group) forced a full repack and it "appeared".
          if ((m.gpuDirty || m.materialDirty) && !deferS) {
            incMat++;
            if (m.material.hasTexture || m.material.hasNormalMap) {   // textured → full write of this slot (P4.3), see above
              if (this._atlasDirty) { this._incBailWhy = 'texturedAtlasDirty'; return false; }
              this._writeInstanceSlot(hadSingleSlot!, m, m.material, m.textureLibraryId ?? '', m.normalMapLibraryId ?? '');
            } else { this._writeSlotMaterial(buf, dataView, hadSingleSlot! * fpi, m.material); this._writeGroundUvScale(buf, hadSingleSlot! * fpi, m); }
            touched.push(hadSingleSlot!);
            m.materialDirty = false;
            this._clearPendingGpuDirty(m);
          }
          continue;
        }
      }
      if (m.billboard) { this._incBailWhy = 'newBillboard'; return false; }   // needs per-frame reorient → full/fast path
      // P5: a NEW array source no longer bails — its groups get their own contiguous ranges (_syncArrayGroupSlots,
      // after this loop wrote the source slot their material is copied from). Source + instances never had to be
      // adjacent: every group is its own instanced-range draw entry (firstSlot, N).
      if (!this.incrementalArrayGroups && arraySources && arraySources.has(m.id)) { this._incBailWhy = 'newArraySource'; return false; }   // A/B: old rule
      if (multi) {
        for (const s of m.submeshes) if (s.textureLibraryId || s.normalMapLibraryId) { this._incBailWhy = 'newTextured'; return false; }   // textured → atlas changes → full repack
        const slots: number[] = [];
        for (let si = 0; si < m.submeshes.length; si++) { const slot = this._takeInstanceSlot(); if (slot < 0) return false; slots.push(slot); }
        incAdded = true; this._meshById.set(m.id, m);   // P5: a new array source is visible to _syncArrayGroupSlots this frame
        this._meshSubmeshSlots.set(m.id, slots);
        for (let si = 0; si < slots.length; si++) { this._writeIncSlot(buf, dataView, normalMat, slots[si], m, m.submeshes[si].material); touched.push(slots[si]); }
      } else {
        if (m.textureLibraryId || m.normalMapLibraryId) { this._incBailWhy = 'newTextured'; return false; }
        const slot = this._takeInstanceSlot(); if (slot < 0) { this._incBailWhy = 'capacity'; return false; }
        incAdded = true; this._meshById.set(m.id, m);   // P5: a new array source is visible to _syncArrayGroupSlots this frame
        this._r3Gen++; this._meshInstanceSlots.set(m.id, slot);
        this._writeIncSlot(buf, dataView, normalMat, slot, m, m.material); touched.push(slot);
      }
      m.materialDirty = false;
      this._clearPendingGpuDirty(m);
    }
    if (anyMatDirty) {   // rewrite material-dirty EXISTING meshes at their current slot(s)
      for (const m of meshes) {
        if (!m.materialDirty) continue;
        if (incMat >= Renderer3D.MATERIAL_SLOT_BUDGET && !m.gpuDirty) { incDeferred = true; continue; }   // P4.3 budget
        incMat += Math.max(1, m.submeshes.length);
        if (m.submeshes.length > 0) { const ss = this._meshSubmeshSlots.get(m.id); if (ss) for (let si = 0; si < ss.length; si++) { this._writeSlotMaterial(buf, dataView, ss[si] * fpi, m.submeshes[si].material); this._writeGroundUvScale(buf, ss[si] * fpi, m); touched.push(ss[si]); } }
        else { const s = this._meshInstanceSlots.get(m.id); if (s !== undefined) { this._writeSlotMaterial(buf, dataView, s * fpi, m.material); this._writeGroundUvScale(buf, s * fpi, m); touched.push(s); } }
        if (arraySources && arraySources.has(m.id)) { incDirtySources.add(m.id); incMat += Math.ceil(arraySources.get(m.id)! / 4); }
        m.materialDirty = false;
      }
    }
    // P5: place newly shown array groups / park hidden ones (contiguous slot ranges), BEFORE the re-dress re-pack so
    // a re-shown group of a re-dressed source is packed once, by _repackGroupsOf.
    if (!this._syncArrayGroupSlots(incDirtySources)) { this._incBailWhy = 'groupCapacity'; return false; }
    if (incDirtySources.size) this._repackGroupsOf(incDirtySources);   // P4.3: instanced copies of a re-dressed source
    if (incDeferred) this.onDeferredWork?.();
    // Upload only the touched slots as coalesced runs (same trick as the transforms fast path).
    if (touched.length) {
      touched.sort((a, b) => a - b);
      let runLo = touched[0], prev = touched[0];
      for (let i = 1; i < touched.length; i++) {
        const s = touched[i];
        if (s > prev + 256) { this.device.queue.writeBuffer(this.instanceStorageBuffer, runLo * MESH_INSTANCE_STRIDE, buf, runLo * fpi, (prev - runLo + 1) * fpi); this._noteInstBytes((prev - runLo + 1) * MESH_INSTANCE_STRIDE); runLo = s; }
        prev = s;
      }
      this.device.queue.writeBuffer(this.instanceStorageBuffer, runLo * MESH_INSTANCE_STRIDE, buf, runLo * fpi, (prev - runLo + 1) * fpi);
      this._noteInstBytes((prev - runLo + 1) * MESH_INSTANCE_STRIDE);
    }
    let live = arraySlots, anyGeo = false; for (const m of meshes) { live += Math.max(1, m.submeshes.length); if (m.gpuDirty) anyGeo = true; }
    // P4.3: re-rank only when the mesh SET / geometry changed — this path now also serves the material-only re-dress
    // frames (city day cycle), where re-sorting ~5k draw entries every frame was pure waste.
    if (incAdded || anyGeo || live !== this._instanceCount) this._drawOrderDirty = true;   // mesh set changed (adds/removals) → rebuild the cached draw rank
    this._instanceCount = live;                 // structural-change check next frame compares totalSlots (incl. array slots) to this
    this._perf.fastPaths++;                     // a cheap path, NOT a full repack
    this._transformsDirty = false;              // every moved resident was rewritten above (no array groups /
                                                // billboards here — caller gate), so the pending fast-path work is done
    // NO _shadowMapStale here: forcing a full-scene shadow re-render on EVERY streamed-tile arrival defeated the
    // shadow throttle mid-pan (the largest per-arrival GPU stall). The interval pass picks new tiles up within
    // `_shadowUpdateInterval` frames anyway (≤3 in city mode) — imperceptible for shadows, huge for pan smoothness.
    return true;
  }

  private uploadMeshInstances(meshes: Mesh3D[]): void {
    if (this._evictPending.size) this.drainDeferredEviction(STREAM_HITCH_LIMITS.evictBudgetMs, meshes);   // P16
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
    const rebuildMap = this._meshById.size !== meshes.length || this._drawOrderDirty || this._groupSetDirty;   // P5: group placement reads source presence
    if (rebuildMap) this._meshById.clear();
    let anyGpuDirty = false, anyMatDirty = false, hasBillboards = false, regularSlots = 0;
    const gdMat = this._gdOn && this._gd ? this._gd : null;   // P15: re-read these records' state code / fog flags
    for (let _km = 0; _km < meshes.length; _km++) { const m = meshes[_km];
      if (rebuildMap) this._meshById.set(m.id, m);
      if (m.gpuDirty) anyGpuDirty = true;
      if (m.materialDirty) { anyMatDirty = true; if (gdMat !== null) gdMat.noteMatDirty(m); }
      if (m.billboard || m.billboardParent) hasBillboards = true;   // children ride a billboard → also view-dependent
      regularSlots += Math.max(1, m.submeshes.length);
    }
    const arraySlots = this._arrayGroups.reduce((n, g) => n + getArrayInstanceCount(g.arrayParams), 0);
    const totalSlots = regularSlots + arraySlots;
    // Also check if any array source or object-offset mesh moved since last upload.
    // P5: only PLACED groups — a group being shown this frame (no range yet) is packed fresh by _syncArrayGroupSlots,
    // and a parked one is version-checked there; their stale/absent recorded versions must not force a full repack.
    const anyArrayMoved = this._arrayGroups.some(g => {
      if (!this._arrayGroupFirstSlot.has(g.id)) return false;
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
    if (!this._instancesDirty && !this._groupSetDirty && !this._groupsPending && !anyGpuDirty && !anyArrayMoved && totalSlots === this._instanceCount && !billboardViewChanged) {
      if (!this._transformsDirty && !anyMatDirty) return;
      // FAST PATH (transforms and/or MATERIAL only): the slot maps, atlas and array-instance POSITIONS are all still
      // valid. Rewrite only the moved slots' matrices + the material-dirty slots' material floats, then upload just
      // that range. This handles the traffic tick (transforms) AND the border-glow pulse / frost / wet material walks
      // (which mark a FEW meshes materialDirty) — the latter used to force a full O(all-slots) repack EVERY frame,
      // the real cause of the fps sink amplified by instancing/chunking. Bail on structural / textured / array-source
      // material changes → full repack.
      if (this._fastPathInstances(meshes, anyMatDirty)) return;
      // fall through → full repack
    }

    // INCREMENTAL append/free path (streaming-pan smoothness): a pure structural change (meshes added/removed) with
    // NO array groups / billboards / atlas change / buffer resize can append the new meshes' slots + upload just those
    // — no re-sort, no whole-buffer re-upload. This is the common tiled-streaming case (flat-color tiles, arrays
    // LOD-hidden, traffic off). Bails to the full repack below on anything it can't handle.
    // P4.3: array groups no longer force the full repack — their instance ranges sit untouched in [0, high-water)
    // (the GROUP SET / params changing sets _instancesDirty → full repack, and a new mesh that is an array SOURCE
    // bails inside). This was the city's periodic 30-100 ms spike: every live-crowd promotion / demotion and every
    // streamed add re-sorted + re-wrote ~all instance slots because the city always has instanced greenery.
    if (!this._instancesDirty && !anyArrayMoved && !this._atlasDirty && !hasBillboards
        && this._tryIncrementalInstances(meshes, anyMatDirty, arraySlots)) {
      return;
    }

    this._perf.fullRepacks++;
    this._arraySrcCount = null;   // P4.3: re-derive the source → instance-count map after any full repack
    {   // P4.3 diagnostics: WHY this frame paid a full repack (getRepackReasons)
      const why = this._instancesDirty ? 'instancesDirty' : anyArrayMoved ? 'arrayMoved' : billboardViewChanged ? 'billboardView'
        : this._atlasDirty ? 'atlas' : this._fpBailWhy ? 'fastBail:' + this._fpBailWhy : hasBillboards ? 'structural+billboards' : 'incBail:' + (anyGpuDirty ? 'gpuDirty' : '') + (totalSlots !== this._instanceCount ? 'count' : '') + (this._incBailWhy || '?');
      this._incBailWhy = '';
      this._fpBailWhy = '';
      this._repackWhy[why] = (this._repackWhy[why] ?? 0) + 1;
    }
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
    this._r3Gen++; this._meshInstanceSlots.clear();
    this._meshSubmeshSlots.clear();
    this._arrayGroupFirstSlot.clear();
    this._arrayGroupSlotCount.clear();
    this._placedGroupObj.clear(); this._placedGroupSrc.clear();
    let slotIdx = 0;
    // sourceId → its groups (in _arrayGroups order). Was a scan of EVERY group per mesh = O(meshes × groups) per full
    // repack — which chunking (Round 5: per-cell instanced groups) would have multiplied.
    const groupsBySource = new Map<string, ArrayGroup3D[]>();
    for (const group of this._arrayGroups) {
      const arr = groupsBySource.get(group.sourceId);
      if (arr) arr.push(group); else groupsBySource.set(group.sourceId, [group]);
    }
    for (const m of sorted) {
      if (m.submeshes.length > 0) {
        const slots: number[] = [];
        for (let si = 0; si < m.submeshes.length; si++) slots.push(slotIdx++);
        this._meshSubmeshSlots.set(m.id, slots);
      } else {
        this._r3Gen++; this._meshInstanceSlots.set(m.id, slotIdx++);
        // Assign array instance slots immediately after source — keeps them contiguous for batching.
        for (const group of groupsBySource.get(m.id) ?? []) {
          const N = getArrayInstanceCount(group.arrayParams);
          if (N > 0) {
            this._arrayGroupFirstSlot.set(group.id, slotIdx);
            this._arrayGroupSlotCount.set(group.id, N);
            this._placedGroupObj.set(group.id, group); this._placedGroupSrc.set(group.id, m);   // P5 placement record
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

    // Reuse the staging Float32Array to avoid GC pressure. P8: cache the DataView over it too — recreate only when
    // the backing buffer is reallocated (else every full repack allocated a fresh DataView over the same buffer).
    if (!this._instanceDataBuf || this._instanceDataBuf.length < needed) {
      this._instanceDataBuf = new Float32Array(needed);
      this._instanceDataView = new DataView(this._instanceDataBuf.buffer);
    }
    const data = this._instanceDataBuf;



    for (const m of sorted) {
      if (m.submeshes.length > 0) {
        const slots = this._meshSubmeshSlots.get(m.id)!;
        for (let si = 0; si < m.submeshes.length; si++) {
          const sub = m.submeshes[si];
          this._writeInstanceSlot(slots[si], m, sub.material,
            sub.textureLibraryId  ?? '',
            sub.normalMapLibraryId ?? '');
        }
      } else {
        const slot = this._meshInstanceSlots.get(m.id)!;
        this._writeInstanceSlot(slot, m, m.material,
          m.textureLibraryId  ?? '',
          m.normalMapLibraryId ?? '');
      }
      m.materialDirty = false;   // slot repacked — the material-only flag is served
    }

    // Array-group instances: packed by _packArrayGroupInstances (C1 Part 2 split — verbatim body).
    this._packArrayGroupInstances();

    this.device.queue.writeBuffer(this.instanceStorageBuffer!, 0, data, 0, needed);
    this._instancesDirty = false;
    this._transformsDirty = false;   // a full repack supersedes any pending fast-path work
    this._instanceCount = totalSlots;
    this._slotAlloc.reset(totalSlots, this.instanceCapacity);   // packed contiguous [0, totalSlots) — no holes, nothing parked
    this._parkedGroups.clear();
    this._groupSetDirty = false;
    this._groupsPending = false;          // P16: the full repack placed every group
    this._drawOrderDirty = true;          // slot layout changed → rebuild the cached draw rank
  }

  /** uploadMeshInstances FAST PATH (transforms and/or material only — the traffic tick + the
   *  border-glow/frost/wet walks): rewrite only the moved slots' matrices + material-dirty slots'
   *  floats, upload just the touched runs. Returns false on bail (structural / textured / billboard /
   *  array-source change) → caller falls through to the full repack. Verbatim body (C1 Part 2). */
  private readonly _repackWhy: Record<string, number> = {};
  private _fpBailWhy = '';
  private _arraySrcCount: Map<string, number> | null = null;
  /** sourceId → total instances of its array groups (cached; dropped when the group set / params change). */
  private _arraySourceCounts(): Map<string, number> {
    if (!this._arraySrcCount) {
      const m = new Map<string, number>();
      for (const g of this._arrayGroups) m.set(g.sourceId, (m.get(g.sourceId) ?? 0) + getArrayInstanceCount(g.arrayParams));
      this._arraySrcCount = m;
    }
    return this._arraySrcCount;
  }
  /** P4.3 frame budget for MATERIAL-ONLY slot rewrites (the day-cycle / weather re-dress marks ~every city material
   *  dirty at once): past it the rest stay materialDirty and are written over the next frames (~1-3 frames for a
   *  whole city) instead of one 10-20 ms frame. Moved / geometry-dirty meshes are never deferred. */
  static MATERIAL_SLOT_BUDGET = 1500;
  /** Called when work was deferred to a later frame (budgeted re-dress) so an on-demand host renders again. */
  onDeferredWork: (() => void) | null = null;
  private _incBailWhy = '';
  private readonly _packedRanges: number[] = [];   // [firstSlot, count, ...] from a partial _packArrayGroupInstances
  private readonly _fpDirtySources = new Set<string>();
  /** P5: bring the array-group slot PLACEMENT in line with the current group set, incrementally (no re-sort):
   *  - a placed group that left the set (or lost its source / changed its count) releases its range. It is PARKED
   *    (owned, data kept) when its source slot still exists, so a later re-show costs nothing;
   *  - a group in the set without a range claims its parked range back when nothing it depends on changed (same group
   *    and source objects, source + object-offset matrix versions, source-slot material floats), else allocates a
   *    fresh contiguous range and is packed + uploaded (only its N slots).
   *  Returns false when a range can't be allocated (buffer full / too fragmented) → the caller's full repack compacts.
   *  `skipPack`: sources re-packed right after anyway (re-dress) — their newly placed groups aren't packed twice. */
  private _syncArrayGroupSlots(skipPack: Set<string>): boolean {
    const first = this._arrayGroupFirstSlot, counts = this._arrayGroupSlotCount;
    if (!this._groupSetDirty && first.size === 0 && this._arrayGroups.length === 0) return true;
    const want = this._gsWant; want.clear();
    const fpi = MESH_INSTANCE_STRIDE / 4;
    // Pass 1: groups that should be placed = in the set, single-material source present this frame with a slot, N > 0
    // (exactly the full repack's rule).
    const byId = this._gsById; byId.clear();
    for (const g of this._arrayGroups) {
      const src = this._meshById.get(g.sourceId);
      if (!src || src.submeshes.length > 0 || !this._meshInstanceSlots.has(src.id)) continue;
      if (getArrayInstanceCount(g.arrayParams) <= 0) continue;
      want.add(g.id); byId.set(g.id, g);
    }
    // Pass 2: release placed groups that are no longer wanted, were replaced by another object, or changed count.
    let changed = false;
    for (const [gid, start] of first) {
      const n = counts.get(gid) ?? 0;
      const g = byId.get(gid);
      const placed = this._placedGroupObj.get(gid);
      if (g && g === placed && getArrayInstanceCount(g.arrayParams) === n) continue;
      const src = this._placedGroupSrc.get(gid);   // the source usually hides WITH its group → not in this frame's map
      first.delete(gid); counts.delete(gid); this._placedGroupObj.delete(gid); this._placedGroupSrc.delete(gid); changed = true;
      const srcSlot = src && src.submeshes.length === 0 ? this._meshInstanceSlots.get(src.id) : undefined;   // resident (not evicted)
      if (!g && placed && src && srcSlot !== undefined && n > 0) {   // hidden, data intact → PARK it
        const o = srcSlot * fpi, data = this._instanceDataBuf!;
        const offId = placed.arrayParams.mode === 'linear' ? placed.arrayParams.objectOffsetId : undefined;
        this._parkedGroups.set(gid, {
          group: placed, src, srcVer: this._arrayGroupSourceVers.get(gid) ?? -1,
          offVer: offId ? (this._arrayGroupOffsetVers.get(gid) ?? -1) : -1,
          mat: data.slice(o + 32, o + 60),
        });
        this._slotAlloc.free(start, n, gid);
      } else {
        this._parkedGroups.delete(gid);
        this._slotAlloc.disown(gid);
        this._slotAlloc.free(start, n);
      }
    }
    // Pass 3: place wanted groups that have no range.
    const pack = this._gsPack; pack.clear();
    // P16 slicedGroupPacks: a group that needs a FRESH pack (not a parked reclaim) waits when this frame's packs are past
    // STREAM_HITCH_LIMITS.groupPackInstances, nearest in-view first. A waiting group has no range, so it is not drawn
    // (never with stale slots) and _groupSetDirty keeps the next frames on this path until it is placed.
    const defer = STREAM_HITCH.slicedGroupPacks && this.incrementalArrayGroups ? this._groupPackDeferrals(want, byId, skipPack) : null;
    for (const g of this._arrayGroups) {
      if (!want.has(g.id) || first.has(g.id) || byId.get(g.id) !== g) continue;
      if (defer !== null && defer.has(g.id)) continue;   // P16: packed on a later frame
      const N = getArrayInstanceCount(g.arrayParams);
      const src = this._meshById.get(g.sourceId)!;
      let start = -1;
      const pk = this._parkedGroups.get(g.id);
      if (pk && this._parkedStillValid(pk, g, src, N)) { start = this._slotAlloc.claimOwned(g.id, N); if (start >= 0) this._perf.groupReclaims++; }
      this._parkedGroups.delete(g.id);
      if (start < 0) {
        this._slotAlloc.disown(g.id);
        start = this._slotAlloc.alloc(N);
        if (start < 0 && this.incrementalArrayGroups) {   // full / fragmented → grow (GPU copy, no repack) and retry
          this._growInstanceBuffer(Math.max(this.instanceCapacity, this._slotAlloc.high + N));
          start = this._slotAlloc.alloc(N);
        }
        if (start < 0) return false;
        if (!skipPack.has(g.sourceId)) pack.add(g.id);
      }
      first.set(g.id, start); counts.set(g.id, N); this._placedGroupObj.set(g.id, g); this._placedGroupSrc.set(g.id, src); changed = true;
    }
    this._groupSetDirty = false;
    this._groupsPending = defer !== null && defer.size > 0;   // P16: groups still waiting → this path again next frame
    if (this._groupsPending) { streamHitchStats.groupPacksDeferred += defer!.size; streamHitchStats.groupPackFramesDeferred++; this.onDeferredWork?.(); }
    if (pack.size) {
      this._packArrayGroupInstances(undefined, pack);
      this._perf.groupPacks += pack.size;
      const r = this._packedRanges, data = this._instanceDataBuf!;
      for (let i = 0; i < r.length; i += 2) if (r[i + 1] > 0) { this.device.queue.writeBuffer(this.instanceStorageBuffer!, r[i] * MESH_INSTANCE_STRIDE, data, r[i] * fpi, r[i + 1] * fpi); this._noteInstBytes(r[i + 1] * MESH_INSTANCE_STRIDE); }
    }
    if (changed) this._perf.groupPlacements++;
    return true;
  }
  /** P16 slicedGroupPacks: the wanted, unplaced groups that would need a fresh pack this frame past the instance budget
   *  (null = everything fits). Parked groups that reclaim their range cost nothing and are never deferred; the first
   *  group always goes (a single huge group is never starved). Order: in view first, then by camera distance. */
  private _groupPackDeferrals(want: Set<string>, byId: Map<string, ArrayGroup3D>, skipPack: Set<string>): Set<string> | null {
    const first = this._arrayGroupFirstSlot;
    const budget = STREAM_HITCH_LIMITS.groupPackInstances;
    let need = 0;
    const cands = this._gsCands; cands.length = 0;
    for (const g of this._arrayGroups) {
      if (!want.has(g.id) || first.has(g.id) || byId.get(g.id) !== g) continue;
      const N = getArrayInstanceCount(g.arrayParams);
      const pk = this._parkedGroups.get(g.id);
      if (pk && this._parkedStillValid(pk, g, this._meshById.get(g.sourceId)!, N)) continue;   // a reclaim: no pack
      cands.push(g); need += skipPack.has(g.sourceId) ? 0 : N;
    }
    if (need <= budget) return null;
    const pr = this._gsPrio; pr.clear();
    for (const g of cands) pr.set(g, this._groupUploadPriority(g, this._meshById.get(g.sourceId)!));
    cands.sort((a, b) => pr.get(a)! - pr.get(b)!);
    const out = new Set<string>();
    let used = 0;
    for (const g of cands) {
      const N = skipPack.has(g.sourceId) ? 0 : getArrayInstanceCount(g.arrayParams);
      if (used > 0 && used + N > budget) out.add(g.id); else used += N;
    }
    cands.length = 0; pr.clear();
    return out.size ? out : null;
  }
  private readonly _gsCands: ArrayGroup3D[] = [];
  /** P16: wanted array groups still waiting for their pack (keeps the frames on the incremental path, not the fast one). */
  private _groupsPending = false;
  private readonly _gsPrio = new Map<ArrayGroup3D, number>();
  /** Lower = sooner: an array group's instance box (explicit offsets) or else its source's, as _uploadPriority. */
  private _groupUploadPriority(g: ArrayGroup3D, src: Mesh3D): number {
    const b = g.arrayParams.mode === 'explicit' ? this._arrayGroupWorldAABB(g, src) : null;
    if (!b) return this._uploadPriority(src);
    const e = this.camera?.position;
    const dist = e ? Math.hypot(Math.max(b[0] - e[0], 0, e[0] - b[3]), Math.max(b[1] - e[1], 0, e[1] - b[4]), Math.max(b[2] - e[2], 0, e[2] - b[5])) : 0;
    return this._culler.testAABB(b[0], b[1], b[2], b[3], b[4], b[5]) ? dist : dist + 1e6;
  }
  /** P16 uploadLedger: instance / group-pack bytes written since the last frame's geometry append (they come off the
   *  frame's upload budget before geometry: what is already resident draws first). */
  private _upInst = 0;
  private _noteInstBytes(bytes: number): void { this._upInst += bytes; }
  /** P16: the largest geometry write (the ledger's cap, else the step-3 slice). */
  private _geomSlice(): number { return STREAM_HITCH.uploadLedger ? STREAM_HITCH_LIMITS.writeSliceBytes : Renderer3D.UPLOAD_GEOM_SLICE; }
  /** P16: geometry bytes still allowed this frame interval (sliced uploads on). Ledger: the frame total minus the
   *  instance bytes, never under the geometry floor, minus the geometry already written; else the step-3 budget. */
  private _geomBudgetLeft(): number {
    if (!STREAM_HITCH.uploadLedger) return Math.max(0, Renderer3D.UPLOAD_FRAME_BUDGET - this._upBytes);
    const L = STREAM_HITCH_LIMITS;
    const frame = TILE_LANDING.active ? Math.max(L.frameWriteBytes, TILE_LANDING.writeBytes) : L.frameWriteBytes;   // P22 landingLedger
    return Math.max(0, Math.max(L.geomFloorBytes, frame - this._upInst) - this._upBytes);
  }
  /** groupId → the ArrayGroup3D object its range was placed for (parks it after it leaves the set). */
  private readonly _placedGroupObj = new Map<string, ArrayGroup3D>();
  private readonly _placedGroupSrc = new Map<string, Mesh3D>();
  private readonly _gsById = new Map<string, ArrayGroup3D>();
  /** A parked group's range still equals what a fresh pack would write. */
  private _parkedStillValid(pk: { group: ArrayGroup3D; src: Mesh3D; srcVer: number; offVer: number; mat: Float32Array }, g: ArrayGroup3D, src: Mesh3D, N: number): boolean {
    if (pk.group !== g || pk.src !== src || src.localMatrixVersion !== pk.srcVer) return false;
    if (!this._slotAlloc.hasOwned(g.id, N)) return false;
    const p = g.arrayParams;
    if ((p.mode === 'linear' || p.mode === 'grid') && p.spacingMode === 'relative') return false;   // depends on the source AABB
    if (this._arrayGroupLocalBases.has(g.id)) return false;                                           // radial local basis (per frame)
    const offId = p.mode === 'linear' ? p.objectOffsetId : undefined;
    if (offId) { const off = this._meshById.get(offId); if (!off || off.localMatrixVersion !== pk.offVer) return false; }
    const srcSlot = this._meshInstanceSlots.get(src.id);
    if (srcSlot === undefined) return false;
    const data = this._instanceDataBuf!, o = srcSlot * (MESH_INSTANCE_STRIDE / 4) + 32, m = pk.mat;
    for (let k = 0; k < 28; k++) { const a = data[o + k], b = m[k]; if (a !== b && !(a !== a && b !== b)) return false; }   // material stamp (NaN-safe)
    return true;
  }

  /** Re-pack the array groups of `sources` (material change on their source) and upload just their slot ranges. */
  private _repackGroupsOf(sources: Set<string>): void {
    if (!sources.size) return;
    this._packArrayGroupInstances(sources);
    const fpi = MESH_INSTANCE_STRIDE / 4, r = this._packedRanges, data = this._instanceDataBuf!;
    for (let i = 0; i < r.length; i += 2) if (r[i + 1] > 0) { this.device.queue.writeBuffer(this.instanceStorageBuffer!, r[i] * MESH_INSTANCE_STRIDE, data, r[i] * fpi, r[i + 1] * fpi); this._noteInstBytes(r[i + 1] * MESH_INSTANCE_STRIDE); }
  }
  /** P4.3 diagnostics: full instance repacks since load, by trigger. */
  getRepackReasons(): Record<string, number> { return { ...this._repackWhy }; }

  /** Transforms fast path: touched slots closer than this many slots are uploaded as one run (see the upload loop). */
  static FASTPATH_MERGE_GAP = 256;
  private _fastPathInstances(meshes: Mesh3D[], anyMatDirty: boolean): boolean {
    if (!this._instanceDataBuf) return false;
    const fpi = MESH_INSTANCE_STRIDE / 4;
    const data = this._instanceDataBuf;
    const normalMat = mat4.create();
    const dv = anyMatDirty ? new DataView(data.buffer, data.byteOffset, data.byteLength) : null;
    const touched = this._fpTouched; touched.length = 0;   // slots written this frame → coalesced into upload runs below
    let bail = false;
    // P4.3: a material change on an array-group SOURCE re-packs just that source's groups (was: bail → full repack of
    // every slot — the day-cycle glow walk marks ~every city material dirty, so each re-dress paid a 20-100 ms repack).
    const sources = this._arrayGroups.length ? this._arraySourceCounts() : null;   // sourceId → instance count
    const dirtySources = this._fpDirtySources; dirtySources.clear();
    let matSlots = 0, deferredMat = false;
    for (let _km = 0; _km < meshes.length; _km++) { const m = meshes[_km];
      const ver = m.localMatrixVersion;
      const moved = this._slotMatVer.get(m.id) !== ver;
      const matD = m.materialDirty;
      if (!moved && !matD) continue;
      if (m.billboard || m.billboardParent) { bail = true; this._fpBailWhy = 'billboard'; break; }   // view-dependent → needs the full writeSlot
      if (matD && !moved) {   // P4.3: material-only rewrite → budgeted (the rest stay dirty for the next frame)
        if (matSlots >= Renderer3D.MATERIAL_SLOT_BUDGET) { deferredMat = true; continue; }
        matSlots += Math.max(1, m.submeshes.length);
      }
      if (matD && sources && sources.has(m.id)) { dirtySources.add(m.id); matSlots += Math.ceil(sources.get(m.id)! / 4); }   // its group re-pack counts toward the budget
      const slots = m.submeshes.length > 0 ? this._meshSubmeshSlots.get(m.id) : undefined;
      const single = slots ? undefined : this._meshInstanceSlots.get(m.id);
      if (!slots && single === undefined) { bail = true; this._fpBailWhy = 'unknownMesh'; break; }   // unknown mesh → structural change
      // P4.3: TEXTURED material change → a full write of just this mesh's slot(s) (atlas indices come from the last
      // atlas build, still valid unless the atlas itself is dirty) instead of bailing to the full repack.
      const textured = matD && (slots ? m.submeshes.some((sm) => sm.material.hasTexture || sm.material.hasNormalMap || !!sm.textureLibraryId || !!sm.normalMapLibraryId)
        : (m.material.hasTexture || m.material.hasNormalMap || !!m.textureLibraryId || !!m.normalMapLibraryId));
      if (textured) {
        if (this._atlasDirty) { bail = true; this._fpBailWhy = 'texturedAtlasDirty'; break; }
        if (slots) for (let si = 0; si < slots.length; si++) { const sub = m.submeshes[si]; this._writeInstanceSlot(slots[si], m, sub.material, sub.textureLibraryId ?? '', sub.normalMapLibraryId ?? ''); touched.push(slots[si]); }
        else { this._writeInstanceSlot(single!, m, m.material, m.textureLibraryId ?? '', m.normalMapLibraryId ?? ''); touched.push(single!); }
        this._slotMatVer.set(m.id, ver);
        m.materialDirty = false;
        continue;
      }
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
        for (let si = 0; si < slots.length; si++) {
          const slot = slots[si];
          const offset = slot * fpi;
          if (moved && this._taaVelOn) this._taaNoteMove(m, slot, offset, si);   // temporal AA: last frame's matrix
          if (moved) { data.set(mlm, offset); data.set(nc!.floats, offset + 16); }
          if (matD) this._writeSlotMaterial(data, dv!, offset, m.submeshes[si]?.material ?? m.material);   // per-submesh, as the full repack writes it
          if (moved || matD) this._writeGroundUvScale(data, offset, m as Mesh3D);
          touched.push(slot);
        }
      } else {
        const offset = single! * fpi;
        if (moved && this._taaVelOn) this._taaNoteMove(m, single!, offset, -1);   // temporal AA: last frame's matrix
        if (moved) { data.set(mlm, offset); data.set(nc!.floats, offset + 16); }
        if (matD) this._writeSlotMaterial(data, dv!, offset, m.material);
        if (moved || matD) this._writeGroundUvScale(data, offset, m as Mesh3D);
        touched.push(single!);
      }
      if (moved) this._slotMatVer.set(m.id, ver);
      if (matD) m.materialDirty = false;
    }
    if (!bail && dirtySources.size) this._repackGroupsOf(dirtySources);   // P4.3 (after the source slots were rewritten)
    if (!bail && deferredMat) this.onDeferredWork?.();
    if (!bail) {
      // Upload only the RUNS of touched slots — NOT one [lo,hi] span. The moved meshes (traffic movers) are
      // scattered across the geometryKey-sorted buffer, so a single span re-uploads the whole ~190k-instance
      // buffer (43 MB) EVERY frame — the ~23ms msUpload zoomed in. Same-archetype movers ARE slot-contiguous,
      // so sorting + coalescing (merging gaps < GAP; a few extra correct slots is cheaper than another
      // writeBuffer) yields ~one run per moving archetype — uploading only the mover blocks, not the static
      // detail between them.
      if (touched.length) {
        touched.sort((a, b) => a - b);
        const GAP = Renderer3D.FASTPATH_MERGE_GAP;
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
      return true;
    }
    return false;   // bailed → full repack
  }

  /** Scratch for _writeInstanceSlot's normal-matrix math (allocation-free repack loop). */
  private readonly _wsNormalMat = mat4.create();

  /** Write one instance slot at the given absolute slot index — the former uploadMeshInstances
   *  closure, verbatim (C1 Part 2). Covers the three transform shapes (billboard-overlay child,
   *  billboard, plain) + material floats + atlas indices + pattern slots. */
  private _writeInstanceSlot(slot: number, m: Mesh3D, mat3d: Material3D, texId: string, normId: string): void {
    const floatsPerInstance = MESH_INSTANCE_STRIDE / 4;
    const data = this._instanceDataBuf!;
    const dataView = this._instanceView();   // always synced to `data`'s current buffer (see _instanceView)
    const normalMat = this._wsNormalMat;

    const offset = slot * floatsPerInstance;
    const localMat = m.localMatrix;
    this._slotMatVer.set(m.id, m.localMatrixVersion);   // the transforms-only fast path diffs against this

    if (m.billboardParent) {
      // Billboard-OVERLAY child (the card's header pill): ride the PARENT's billboard basis (same face-camera
      // orientation, spin, and scale) but translated by billboardOffset in the parent's local frame — so it stays
      // glued to the parent's corner and can overhang it. Matrix = parentBillboard × translate(offset).
      const p = m.billboardParent;
      const vm = this.camera.getViewMatrix() as Float32Array;
      const plm = p.localMatrix as Float32Array;
      const pbs = p.billboardScale;   // parent's grow (kept off localMatrix so intro updates stay a cheap slot patch)
      const psx = Math.hypot(plm[0], plm[1], plm[2]) * pbs;
      const psy = Math.hypot(plm[4], plm[5], plm[6]) * pbs;
      const psz = Math.hypot(plm[8], plm[9], plm[10]) * pbs;
      let rx = vm[0], ry = vm[4], rz = vm[8];   // camera right
      let bx = vm[2], by = vm[6], bz = vm[10];  // camera backward
      const spin = p.billboardSpinY;            // inherit the parent's intro spin
      if (spin !== 0) {
        const ct = Math.cos(spin), st = Math.sin(spin);
        const nrx = rx * ct + bx * st, nry = ry * ct + by * st, nrz = rz * ct + bz * st;
        bx = -rx * st + bx * ct; by = -ry * st + by * ct; bz = -rz * st + bz * ct;
        rx = nrx; ry = nry; rz = nrz;
      }
      const ux = vm[1], uy = vm[5], uz = vm[9];   // camera up
      const [ox, oy, oz] = m.billboardOffset;
      // cols 0-2 = parent basis × parent scale (so the pill geometry inherits orientation + grow)
      data[offset]      = rx * psx; data[offset + 1] = ry * psx; data[offset + 2]  = rz * psx; data[offset + 3]  = 0;
      data[offset + 4]  = ux * psy; data[offset + 5] = uy * psy; data[offset + 6]  = uz * psy; data[offset + 7]  = 0;
      data[offset + 8]  = bx * psz; data[offset + 9] = by * psz; data[offset + 10] = bz * psz; data[offset + 11] = 0;
      // col 3 = parent world position + basis·scale·offset
      data[offset + 12] = plm[12] + rx * psx * ox + ux * psy * oy + bx * psz * oz;
      data[offset + 13] = plm[13] + ry * psx * ox + uy * psy * oy + by * psz * oz;
      data[offset + 14] = plm[14] + rz * psx * ox + uz * psy * oy + bz * psz * oz;
      data[offset + 15] = 1;
      // Normal matrix — unlit ignores it; write the (inverse-scaled) basis for consistency, harmless if unused.
      const ipx = psx > 0 ? 1 / psx : 1, ipy = psy > 0 ? 1 / psy : 1, ipz = psz > 0 ? 1 / psz : 1;
      data[offset + 16] = rx * ipx; data[offset + 17] = ry * ipx; data[offset + 18] = rz * ipx; data[offset + 19] = 0;
      data[offset + 20] = ux * ipy; data[offset + 21] = uy * ipy; data[offset + 22] = uz * ipy; data[offset + 23] = 0;
      data[offset + 24] = bx * ipz; data[offset + 25] = by * ipz; data[offset + 26] = bz * ipz; data[offset + 27] = 0;
      data[offset + 28] = 0; data[offset + 29] = 0; data[offset + 30] = 0; data[offset + 31] = 1;
    } else if (m.billboard) {
      // Billboard: override model matrix each frame to face the camera.
      // View matrix (column-major): [0,4,8]=right, [1,5,9]=up, [2,6,10]=backward
      const vm = this.camera.getViewMatrix() as Float32Array;
      const lm = localMat as Float32Array;
      // Extract scale from local matrix columns, times the billboard grow (see billboardScale).
      const bs = m.billboardScale;
      const sx = Math.hypot(lm[0], lm[1], lm[2]) * bs;
      const sy = Math.hypot(lm[4], lm[5], lm[6]) * bs;
      const sz = Math.hypot(lm[8], lm[9], lm[10]) * bs;
      // Camera basis (world space): right = row0, up = row1, backward = row2.
      let rx = vm[0], ry = vm[4], rz = vm[8];   // right
      let bx = vm[2], by = vm[6], bz = vm[10];  // backward
      // Optional intro "spin-in": rotate the right/backward axes about the UP axis. spinY decays to 0 →
      // an ordinary face-camera billboard (so the card settles perfectly flat-on and readable). The extruded
      // slab's depth (local Z) turns into view mid-spin, showing its thickness.
      const spinY = m.billboardSpinY;
      if (spinY !== 0) {
        const ct = Math.cos(spinY), st = Math.sin(spinY);
        const nrx = rx * ct + bx * st, nry = ry * ct + by * st, nrz = rz * ct + bz * st;
        bx = -rx * st + bx * ct; by = -ry * st + by * ct; bz = -rz * st + bz * ct;
        rx = nrx; ry = nry; rz = nrz;
      }
      // Col 0 = right * sx
      data[offset]      = rx * sx; data[offset + 1] = ry * sx;
      data[offset + 2]  = rz * sx; data[offset + 3] = 0;
      // Col 1 = camera up * sy
      data[offset + 4]  = vm[1] * sy; data[offset + 5] = vm[5] * sy;
      data[offset + 6]  = vm[9] * sy; data[offset + 7] = 0;
      // Col 2 = backward * sz
      data[offset + 8]  = bx * sz; data[offset + 9]  = by * sz;
      data[offset + 10] = bz * sz; data[offset + 11] = 0;
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

    // emissive rgb + flags (floats 40-43; WGSL MeshInstance.emissive vec3<f32> + flags u32: the flags lane is declared u32, CLOTH-3)
    data[offset + 40] = mat3d.emissive.r;
    data[offset + 41] = mat3d.emissive.g;
    data[offset + 42] = mat3d.emissive.b;
    dataView.setUint32((offset + 43) * 4, encodeMaterialFlags(mat3d), true);

    // textureIndex / normalMapIndex (floats 44-45 as u32); roughness + metalness (floats 46-47 as f32)
    // ★ GARP: a garpLayer means this mesh samples the DEDICATED GARP atlas (the garpTex flag routes the shader
    //   there) at that layer instead of the diffuse atlas — the non-instanced counterpart to the arrayGroup's
    //   per-instance textureIndex override. arrayGroup copies (repack, ~L3205) still override float 44 per-copy.
    const texIdx  = m.garpLayer !== undefined ? (m.garpLayer >>> 0) : (this._atlasLayerMap.get(texId) ?? 0);
    const normIdx = this._normalAtlasLayerMap.get(normId) ?? 0;
    dataView.setUint32((offset + 44) * 4, texIdx,  true);
    dataView.setUint32((offset + 45) * 4, normIdx, true);
    data[offset + 46] = mat3d.roughness ?? 0.5;
    data[offset + 47] = mat3d.metalness ?? 0.0;

    // patternColor (floats 48-51) + patternParams (52-55) — boardShade repurposes both (see helper)
    this._writePatternSlots(data, offset, mat3d);
    this._writeGroundUvScale(data, offset, m);   // procedural ground: the per-mesh uv scale (floats 56-59)
  }

  /** Write the GPU-instanced array-group slots (source R+S with per-copy translation/overrides/GARP
   *  skins) — the former uploadMeshInstances tail loop, verbatim (C1 Part 2). */
  /** `onlySources` (P4.3): re-pack just the groups of these source meshes (a material change on an array SOURCE in
   *  the fast / incremental paths) and record their slot ranges in `_packedRanges` for a partial upload, instead of
   *  bailing to the full repack. Omitted = every group (the full repack). */
  private _packArrayGroupInstances(onlySources?: Set<string>, onlyGroups?: Set<string>): void {
    const floatsPerInstance = MESH_INSTANCE_STRIDE / 4;
    const data = this._instanceDataBuf!;
    const dataView = this._instanceView();
    const partial = !!(onlySources || onlyGroups);   // P5: `onlyGroups` = just these (newly placed) groups
    if (partial) this._packedRanges.length = 0;
    // Write GPU-instanced array group data.
    // Each instance reuses source R+S from source's localMatrix with modified translation.
    // Normal matrix is the same as source (translation doesn't affect inverse-transpose).
    for (const group of this._arrayGroups) {
      if (onlySources && !onlySources.has(group.sourceId)) continue;
      if (onlyGroups && !onlyGroups.has(group.id)) continue;
      const firstSlot = this._arrayGroupFirstSlot.get(group.id);
      if (firstSlot === undefined) continue;
      if (partial) this._packedRanges.push(firstSlot, getArrayInstanceCount(group.arrayParams));
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

        // P20 instanced props: a full 3×3 (+ optionally its own normal matrix), post-multiplied onto the source's —
        // from the group's typed instanceXf (21 floats a copy: t3 · model 3×3 · normal 3×3) or a per-copy override.
        const gxf = group.instanceXf;
        if (gxf || (ov && ov.affine)) {
          const A: ArrayLike<number> = gxf ?? ov!.affine!, ao = gxf ? i * 21 + 3 : 0;
          const a00=data[offset+0], a10=data[offset+1], a20=data[offset+2];
          const a01=data[offset+4], a11=data[offset+5], a21=data[offset+6];
          const a02=data[offset+8], a12=data[offset+9], a22=data[offset+10];
          const m0 = A[ao], m1 = A[ao + 1], m2 = A[ao + 2], m3 = A[ao + 3], m4 = A[ao + 4], m5 = A[ao + 5], m6 = A[ao + 6], m7 = A[ao + 7], m8 = A[ao + 8];
          data[offset+0]  = a00*m0 + a01*m1 + a02*m2;
          data[offset+1]  = a10*m0 + a11*m1 + a12*m2;
          data[offset+2]  = a20*m0 + a21*m1 + a22*m2;
          data[offset+4]  = a00*m3 + a01*m4 + a02*m5;
          data[offset+5]  = a10*m3 + a11*m4 + a12*m5;
          data[offset+6]  = a20*m3 + a21*m4 + a22*m5;
          data[offset+8]  = a00*m6 + a01*m7 + a02*m8;
          data[offset+9]  = a10*m6 + a11*m7 + a12*m8;
          data[offset+10] = a20*m6 + a21*m7 + a22*m8;
          const nm = this._overrideScratch;
          const N: ArrayLike<number> | undefined = gxf ?? ov!.normal3, no = gxf ? i * 21 + 12 : 0;
          if (N) {
            const s = nc ? nc.floats : null;
            const s00 = s ? s[0] : 1, s10 = s ? s[1] : 0, s20 = s ? s[2] : 0;
            const s01 = s ? s[4] : 0, s11 = s ? s[5] : 1, s21 = s ? s[6] : 0;
            const s02 = s ? s[8] : 0, s12 = s ? s[9] : 0, s22 = s ? s[10] : 1;
            nm.fill(0); nm[15] = 1;
            for (let c = 0; c < 3; c++) {
              const b0 = N[no + c * 3], b1 = N[no + c * 3 + 1], b2 = N[no + c * 3 + 2];
              nm[c * 4]     = s00 * b0 + s01 * b1 + s02 * b2;
              nm[c * 4 + 1] = s10 * b0 + s11 * b1 + s12 * b2;
              nm[c * 4 + 2] = s20 * b0 + s21 * b1 + s22 * b2;
            }
          } else {
            nm.set(data.subarray(offset, offset + 16));
            nm[3] = 0; nm[7] = 0; nm[11] = 0; nm[12] = 0; nm[13] = 0; nm[14] = 0; nm[15] = 1;
            mat4.invert(nm as any, nm as any);
            mat4.transpose(nm as any, nm as any);
          }
          data.set(nm, offset + 16);
        } else
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

        // ★ Material + texture + PATTERN SLOTS: floats 32–55, i.e. through the END of the instance record.
        // This used to stop at 48, leaving the pattern slots (48–55) unwritten for every array instance.
        // Those slots are not optional decoration — several features REPURPOSE them (see _writePatternSlots):
        // windSway/foliageShade store (windHeight, windStiffness, windAmount) and the translucency payload
        // there, and groundShade its tile/grout/mode. The FLAGS live in MeshInstance.flags (float 43, inside 32–47), so
        // the shader believed wind and translucency were enabled and then read zeros — meaning only the
        // SOURCE mesh of each ArrayGroup swayed and transmitted light, and every other instance stood dead
        // still. That is why some city trees moved in the wind and most did not.
        // ★ …and through 59: the uvTransform (tiling + offset, floats 56-59) was never written for array copies, so
        // they sampled with whatever STALE floats the reused staging buffer held at that slot (often 0 → uv × 0 = one
        // texel → a GARP-skinned vending body rendered as a flat colour, and which one depended on slot layout —
        // found by the Round-5 chunking A/B, where re-laid-out slots flipped the look). Copies share the source's.
        data.copyWithin(offset + 32, srcOffset + 32, srcOffset + 60);
        data[offset + FLAGS2_FLOAT_OFFSET] = data[srcOffset + FLAGS2_FLOAT_OFFSET];   // flags2: copies share the source's (fog-horizon fade bits)
        // ★ GARP per-instance SKIN: override the copied textureIndex (float 44, a u32) with THIS instance's
        // atlas layer, so one instanced arrayGroup draw can show a different texture per copy. Scoped here —
        // the rest of the instance record still comes from the source; only the diffuse layer index differs.
        if (ov && ov.textureIndex !== undefined) dataView.setUint32((offset + 44) * 4, ov.textureIndex >>> 0, true);
        // CROWD PALETTE (performance-plan P12): this copy's own palette slots (patternColor.xyz).
        if (ov && ov.crowdSlots) { const cs = ov.crowdSlots; data[offset + 48] = cs[0]; data[offset + 49] = cs[1]; data[offset + 50] = cs[2]; }
      }

      this._arrayGroupSourceVers.set(group.id, source.localMatrixVersion);
      if (objectOffsetId) {
        const offV = this._meshById.get(objectOffsetId);
        const off = offV && offV.submeshes.length === 0 ? offV : undefined;
        if (off) this._arrayGroupOffsetVers.set(group.id, off.localMatrixVersion);
      }
    }
  }

  /**
   * Build or rebuild the shared texture_2d_array atlas from all TextureLibrary textures
   * referenced by visible meshes. Layer 0 = white default (for untextured / fallback).
   * Only textures with COPY_SRC usage and matching atlas dimensions are packed; others
   * fall back to the standalone per-mesh bind group with textureIndex = 0.
   */
  private _buildTextureAtlas(meshes: Mesh3D[]): void {
    const atlasT0 = performance.now();

    // Collect unique library-sourced textures referenced by visible meshes, plus which libIds belong
    // to a gpuDirty mesh this frame (an in-place texture edit — e.g. a UV-paint stroke — keeps the
    // same GPUTexture object, so identity alone can't detect it).
    const texMap  = new Map<string, GPUTexture>(); // libId → diffuse
    const normMap = new Map<string, GPUTexture>(); // libId → normal
    const dirtyDiffuse = new Set<string>();
    const dirtyNormal  = new Set<string>();
    for (const m of meshes) {
      if (m.textureLibraryId  && m.diffuseTexture) {
        texMap.set(m.textureLibraryId,  m.diffuseTexture);
        if (m.gpuDirty) dirtyDiffuse.add(m.textureLibraryId);
      }
      if (m.normalMapLibraryId && m.normalMapTexture) {
        normMap.set(m.normalMapLibraryId, m.normalMapTexture);
        if (m.gpuDirty) dirtyNormal.add(m.normalMapLibraryId);
      }
    }

    const diffuse = this._syncAtlas(this._atlasTexture, this._atlasSync, this._atlasLayerMap, texMap, dirtyDiffuse);
    const normal  = this._syncAtlas(this._normalAtlasTexture, this._normalAtlasSync, this._normalAtlasLayerMap, normMap, dirtyNormal);
    this._atlasTexture       = diffuse.tex;
    this._normalAtlasTexture = normal.tex;

    // The bind group holds VIEWS of the array textures — copying into layers never invalidates it;
    // only a structural reallocation (new GPUTexture) does.
    if (diffuse.structural || normal.structural) {
      this._atlasBindGroup = null;
      this._rebindAtlasGroup();
      this._perf.atlasRebuilds++;   // counts STRUCTURAL rebuilds (the expensive event the HUD watches)
    }

    this._atlasDirty = false;
    this._perf.lastAtlasMs = performance.now() - atlasT0;
  }

  /** E3: bring ONE texture_2d_array atlas in sync with the wanted libId→texture set.
   *  Incremental when possible: existing layers keep their indices; only NEW libIds and layers whose
   *  source changed (texture swap, or an in-place edit flagged via `dirtyLibs`) are copied. The array
   *  texture is reallocated (with capacity headroom, white layer 0 rewritten, ALL layers recopied)
   *  only when: no atlas exists, the reference dimensions changed, or capacity is exceeded. */
  private _syncAtlas(
    tex: GPUTexture | null,
    st: { w: number; h: number; capacity: number; high: number; srcByLib: Map<string, GPUTexture> },
    layerMap: Map<string, number>,
    srcMap: Map<string, GPUTexture>,
    dirtyLibs: Set<string>,
  ): { tex: GPUTexture | null; structural: boolean } {
    if (srcMap.size === 0) {
      if (!tex) return { tex: null, structural: false };
      tex.destroy();
      layerMap.clear();
      st.srcByLib.clear();
      st.w = st.h = st.capacity = 0; st.high = 1;
      return { tex: null, structural: true };
    }

    const entries = [...srcMap.entries()];
    const firstTex = entries[0][1];
    const W = firstTex.width;
    const H = firstTex.height;

    // Count how many NEW packable (dims/format-matching) libIds need layers.
    let newCount = 0;
    for (const [libId, srcTex] of entries) {
      if (!layerMap.has(libId) && srcTex.width === W && srcTex.height === H && srcTex.format === 'rgba8unorm') newCount++;
    }

    const structural = !tex || st.w !== W || st.h !== H || st.high + newCount > st.capacity;
    if (structural) {
      // ── Full (re)build with headroom so steady-state edits never land here again ──
      tex?.destroy();
      layerMap.clear();
      st.srcByLib.clear();
      const needed = 1 + entries.length;                            // layer 0 = white default
      // Grow 1.5× (min +4) capped at the spec-guaranteed 256 array layers.
      st.capacity = Math.min(256, Math.max(needed, Math.ceil(needed * 1.5), 8));
      st.w = W; st.h = H; st.high = 1;

      tex = this.device.createTexture({
        size: [W, H, st.capacity],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

      // Layer 0: solid white (diffuse colour shows through when texture not applied). P8: reuse a
      // scratch buffer across rebuilds — all-255, never mutated; reallocate only when dims change.
      const whiteNeed = W * H * 4;
      let whiteData = this._whiteLayerScratch;
      if (!whiteData || whiteData.length !== whiteNeed) {
        whiteData = new Uint8Array(whiteNeed).fill(255);
        this._whiteLayerScratch = whiteData;
      }
      this.device.queue.writeTexture(
        { texture: tex, origin: { x: 0, y: 0, z: 0 } },
        whiteData,
        { offset: 0, bytesPerRow: W * 4, rowsPerImage: H },
        { width: W, height: H, depthOrArrayLayers: 1 },
      );
      // Fall through: the incremental loop below now copies EVERY packable layer (maps are empty).
    }

    // ── Incremental sync: assign layers to new libIds; re-copy changed sources ──
    const enc = this.device.createCommandEncoder();
    let anyCopy = false;
    for (const [libId, srcTex] of entries) {
      if (!(srcTex.width === st.w && srcTex.height === st.h && srcTex.format === 'rgba8unorm')) continue;
      // Mismatched size/format: textureIndex stays 0 (white layer), standalone bind group used instead.
      let layer = layerMap.get(libId);
      const changed = layer === undefined || st.srcByLib.get(libId) !== srcTex || dirtyLibs.has(libId);
      if (layer === undefined) {
        layer = st.high++;
        layerMap.set(libId, layer);
      }
      if (!changed) continue;
      enc.copyTextureToTexture(
        { texture: srcTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { texture: tex!,   mipLevel: 0, origin: { x: 0, y: 0, z: layer } },
        { width: st.w, height: st.h, depthOrArrayLayers: 1 },
      );
      st.srcByLib.set(libId, srcTex);
      anyCopy = true;
    }
    if (anyCopy) this.device.queue.submit([enc.finish()]);
    else         enc.finish(); // discard empty encoder

    // libIds that vanished keep their (dead) layers until the next structural rebuild — the same
    // parked-dead-space policy the geometry pool uses; indices of live layers must never move.
    return { tex, structural };
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
    const gen = this._r3Gen, fastSkip = Renderer3D.geomPoolFastSkip;
    for (const m of meshes) {
      // 2026-10-01: a resident, clean mesh whose P9 slot cache is current (invalidated by every _geomAllocs /
      // _meshInstanceSlots change via _r3Gen) needs nothing here: the slow test below would find it resident and not
      // dirty too. Skips the geometry getter + id getter + Map lookup for ~13 k meshes a frame in a tiled city. The slow
      // test fills the cache (as the draw-list build does), so meshes the hierarchical cull skips get it too.
      if (fastSkip && m._r3o === this && m._r3g === gen && m._r3GA !== undefined && !m.gpuDirty) continue;
      if (!m.geometry || m.geometry.vertices.length === 0) continue;
      const mid = m.id, ga = this._geomAllocs.get(mid);
      if (ga !== undefined) {
        if (m.gpuDirty) { dirtyResident = true; break; }
        if (fastSkip) { m._r3o = this; m._r3g = gen; m._r3GA = ga; m._r3Slot = this._meshInstanceSlots.get(mid) ?? -1; }
      } else (fresh ??= []).push(m);
    }
    // A forced compaction (requested when the camera goes idle after streaming) reclaims the dead space that
    // disposed tiles leave behind — BUT only when there's actually fresh geometry to place or real dead space to
    // reclaim, and never mid-motion (the caller only requests it on idle). This keeps the ~68 ms full re-upload OFF
    // the pan path: it happens once you stop, not while you're moving.
    if (dirtyResident || !this._geomVB || this._pkRepack) {   // (P22: a packedVertices flip re-places everything)
      this._forceCompact = false;
      return this._fullRebuildGeomPool(meshes);
    }
    if (this._forceCompact && this._compactionWorthwhile()) {
      this._forceCompact = false;
      return this._compactGeomPoolGpu(meshes) ?? this._fullRebuildGeomPool(meshes);   // P10.B6: GPU-side moves first
    }
    this._forceCompact = false;
    // The only change is meshes the pool hasn't seen (a regen / async reveal / newly added group). APPEND their
    // geometry at the tail instead of re-uploading the whole pool; compact only if they won't fit. Removed
    // meshes leave their alloc parked (dead space) until the next compaction.
    // P5: TIME-SLICED — at most GEOM_APPEND_BUDGET bytes of new geometry per frame (the first view that reveals the
    // city's never-drawn detail appended ~145 MB in one frame: ~50 ms of writeBuffer alone). Meshes whose geometry
    // isn't resident yet are left out of the draw lists (see _buildDrawLists) and land over the next frames.
    if (!fresh) this._geomAppendDeferred = false;
    // Step 3 slicedUploads: the frame's upload budget is shared with the warm calls made since the last frame
    // (UPLOAD_FRAME_BUDGET in all), and a geometry bigger than what is left is written in slices over several frames.
    const sliced = Renderer3D.slicedUploads && this.incrementalArrayGroups;
    const budget = sliced ? this._geomBudgetLeft()   // P16: the shared write ledger (or the step-3 geometry budget)
      : this.incrementalArrayGroups ? Renderer3D.GEOM_APPEND_BUDGET : Infinity;
    if (fresh && !this._appendGeometry(fresh, budget)) { this._upEndFrame(); return this._compactGeomPoolGpu(meshes) ?? this._fullRebuildGeomPool(meshes); }   // overflow → compact (P10.B6: on the GPU when it fits)
    this._upEndFrame();
    if (this._geomAppendDeferred || this._geomPartial.size) this.onDeferredWork?.();
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

  /** PARTIAL INDEX UPLOAD: re-send `mesh.geometry.indices[start, start + count)` (already edited IN PLACE by the
   *  caller) to the mesh's pooled index range — a few KB, no pool rebuild (gpuDirty on a resident mesh rebuilds the
   *  whole pool). The live crowd (world-live-crowd.ts) degenerates / restores one person's triangles inside a merged
   *  crowd layer with this. A mesh not resident yet needs nothing (its append uploads the current CPU indices, as does
   *  every later compaction). Also patches the mesh's persistent-outline shell IB when one is cached. Returns whether
   *  anything was written. */
  patchMeshIndices(mesh: Mesh3D, start: number, count: number): boolean {
    const g = mesh.geometry, alloc = this._geomAllocs.get(mesh.id);
    if (!g || count <= 0 || start < 0 || start + count > g.indices.length) return false;
    const idx = g.indices as Uint32Array;
    let wrote = false;
    if (alloc && this._geomIB && alloc.indexCount === idx.length) {
      if (alloc.pk) {
        // P22: a packed allocation holds 16-bit indices — re-pack the (4-byte aligned) covering range and write it
        const s0 = start & ~1, e0 = Math.min(alloc.idxBytes >> 1, (start + count + 1) & ~1), u = new Uint16Array(e0 - s0);
        for (let i = s0; i < e0; i++) u[i - s0] = i < idx.length ? idx[i] : 0;
        this.device.queue.writeBuffer(this._geomIB, (alloc.firstIndex + s0) * 2, u.buffer, 0, u.byteLength);
      } else this.device.queue.writeBuffer(this._geomIB, (alloc.firstIndex + start) * 4, idx.buffer, idx.byteOffset + start * 4, count * 4);
      wrote = true;
    }
    const og = this._outlineGeom.get(mesh.id);
    if (og && og.count === idx.length) { this.device.queue.writeBuffer(og.ib, start * 4, idx.buffer, idx.byteOffset + start * 4, count * 4); wrote = true; }
    return wrote;   // (no shadow refresh: callers swap in geometry that coincides with what they hid)
  }

  /** PARTIAL VERTEX UPLOAD (visual-polish #16): re-send vertices [start, start + count) of `mesh.geometry.vertices`
   *  (edited IN PLACE by the caller, same layout + length) to the mesh's pooled vertex range, without the full pool
   *  rebuild gpuDirty costs. The moving contact blobs (world-mover-shadows.ts) rewrite their quads this way each frame.
   *  The mesh's bounds are NOT refreshed (the caller keeps them fixed, e.g. with unreferenced anchor vertices) and its
   *  geometry key must be its own (not shared). A mesh not resident yet needs nothing (its append uploads the current
   *  CPU vertices, as does every later compaction). Returns whether anything was written. */
  patchMeshVertices(mesh: Mesh3D, start: number, count: number): boolean {
    const g = mesh.geometry, alloc = this._geomAllocs.get(mesh.id);
    if (!g || !alloc || !this._geomVB || count <= 0 || start < 0) return false;
    const v = g.vertices as Float32Array, fpv = MESH3D_VERTEX_STRIDE / 4, st = strideOf(alloc.pk);
    // (P22: the span is padded in pack mode — it must hold the whole vertex array at the allocation's stride)
    if (alloc.vtxBytes < (v.length / fpv) * st || alloc.vtxBytes >= (v.length / fpv) * st + 96 || (start + count) * fpv > v.length || this._geomPartial.has(mesh.geometryKey)) return false;
    if (alloc.pk) {   // P22: re-pack the range (position, normal, uv) into the 32-byte layout
      const pv = packVertices(v.subarray(start * fpv, (start + count) * fpv));
      if (!pv) return false;
      this.device.queue.writeBuffer(this._geomVB, (alloc.baseVertex + start) * st, pv.buffer, 0, pv.byteLength);
      return true;
    }
    this.device.queue.writeBuffer(this._geomVB, alloc.baseVertex * MESH3D_VERTEX_STRIDE + start * MESH3D_VERTEX_STRIDE,
      v.buffer, v.byteOffset + start * MESH3D_VERTEX_STRIDE, count * MESH3D_VERTEX_STRIDE);
    return true;
  }

  /** mobile-parity 7.3d (Mesh Edit vertex drag): `mesh`'s vertex POSITIONS were rewritten in place and re-sent with
   *  patchMeshVertices — drop its cached bounds (the next cull re-scans them; its GPU-driven record re-derives its box)
   *  and refresh the shadow map, as the gpuDirty pool rebuild would have. */
  noteMeshVerticesMoved(mesh: Mesh3D): void {
    const e = this._meshAABBCache.get(mesh.id);
    if (e) { e.dead = true; this._meshAABBCache.delete(mesh.id); }
    mesh._r3Aabb = null;
    mesh._gdKM = -1;
    this._shadowMapStale = true;
  }

  /** Compaction is only worth its ~68 ms full re-upload when the free list holds a LOT of fragmented dead space.
   *  With region reuse + coalescing, disposed tiles' space normally gets recycled by the next tiles instead. */
  private _compactionWorthwhile(): boolean {
    let freeVtx = 0;
    for (const f of this._geomFree) freeVtx += f.vtxBytes;
    if (freeVtx > Math.max(64 << 20, this._geomVtxTail * 0.25)) return true;   // >64 MB or >25% of the used span
    // P10.D4: or the buffers are far bigger than the live geometry (streamed tiles left) → compact + shrink.
    return Renderer3D.geomPoolShrink && planPoolShrink(this._geomVBCap, this._geomVtxTail - freeVtx) !== null;
  }
  /** P10.D4 A/B: release geometry-pool CAPACITY (bug-hunt D-R1). A compaction / rebuild reallocates smaller buffers
   *  once they are > 3× the live geometry, and an EMPTY pool frees its buffers. false = the old never-shrink pool. */
  static geomPoolShrink = true;
  /** P10.D4 A/B: an append that overflows while the free list holds a lot of dead space COMPACTS (GPU moves) instead of
   *  growing the buffers ×1.5 — streaming in a straight line otherwise grew the pool by fragmentation alone. */
  static compactBeforeGrow = true;

  /** Append geometry for meshes the pool hasn't seen — uploading ONLY the new unique geometries, REUSING a freed
   *  region when one fits (else at the tail). Ref-counts each geometryKey across its meshes. Returns false if a new
   *  geometry needs the tail but would overflow (caller compacts via a full rebuild). */
  /** P5: per-frame byte budget for appending new geometry (see _ensureGeomPool). ~5 ms of writeBuffer. */
  static GEOM_APPEND_BUDGET = 16 << 20;
  /** The last append stopped at the budget — meshes are still waiting for their geometry. */
  private _geomAppendDeferred = false;
  private _appendGeometry(fresh: Mesh3D[], budget = Infinity): boolean {
    this._geomAppendDeferred = false;
    const sliced = Renderer3D.slicedUploads && this.incrementalArrayGroups && budget !== Infinity;
    // Unique geometryKeys among the fresh meshes that aren't already resident (dedupe within + against pool).
    let newKeys = new Map<string, import('./mesh-generators').MeshGeometry>();
    for (const m of fresh) {
      const key = m.geometryKey;
      if (!this._geomKeyAllocs.has(key) && !newKeys.has(key)) {
        newKeys.set(key, m.geometry!);
        if (sliced && !this._upPrio.has(key)) this._upPrio.set(key, this._uploadPriority(m));
      }
    }
    // Step 3: a geometry already being written in slices continues first; then the rest nearest-in-view first.
    if (sliced && newKeys.size > 1) {
      const P = this._upPrio, G = this._geomPartial;
      const keys = [...newKeys.keys()].sort((a, b) => (G.has(b) ? 1 : 0) - (G.has(a) ? 1 : 0) || (P.get(a) ?? 0) - (P.get(b) ?? 0));
      const ordered = new Map<string, import('./mesh-generators').MeshGeometry>();
      for (const k of keys) ordered.set(k, newKeys.get(k)!);
      newKeys = ordered;
    }
    // Pre-check tail overflow for the SUBSET of new geometry that won't find a free region — but the free-list
    // check is per-key, so do it inline and bail (return false → compact) the moment a key needs the tail and
    // won't fit. Anything uploaded before the bail stays valid; the compaction reuploads everything anyway.
    // P5: bytes of the keys not placed yet — an overflow GROWS the pool once by all of them (GPU copy) instead of
    // compacting (the full rebuild re-uploads every geometry: ~110-170 ms the first time a view reveals new detail).
    let restVtx = 0, restIdx = 0;
    // (P22: the UNPACKED spans — an upper bound, used only to size growth; packing every waiting key here up front was a
    // 30 ms task in a landing)
    for (const g of newKeys.values()) { restVtx += this._pkMode ? alignVtx(g.vertices.byteLength) : g.vertices.byteLength; restIdx += g.indices.byteLength; }
    let uploaded = 0;
    for (const [key, g] of newKeys) {
      const pv = this._poolView(g);   // P22: the bytes the pool stores (packed or not) and their padded spans
      const needVtx = pv.vtxBytes, needIdx = pv.idxBytes;
      // Step 3: continue (or finish) a geometry that is being written in slices — one slice a frame per geometry.
      const part = sliced ? this._geomPartial.get(key) : undefined;
      if (part) {
        if (part.g !== g || part.v.pk !== pv.pk || part.vtxBytes !== needVtx || part.idxBytes !== needIdx) this._abandonPartial(key);   // replaced meanwhile: start over
        else {
          if (part.lastFrame === this._upFrameNo) { this._geomAppendDeferred = true; continue; }   // its slice for this frame is in
          if (budget - uploaded < Renderer3D.UPLOAD_SLICE_MIN) { this._geomAppendDeferred = true; break; }
          uploaded += this._writePartial(part, Math.min(this._geomSlice(), budget - uploaded));
          if (part.vDone < pv.vb.byteLength || part.iDone < pv.ib.byteLength) { this._geomAppendDeferred = true; continue; }
          this._geomPartial.delete(key);
          this._geomKeyAllocs.set(key, this._poolAlloc(part.vtxOff, part.idxOff, g, pv));
          this._geomKeySrc.set(key, g);
          if (pv.pk) dropPoolView(g);
          restVtx -= needVtx; restIdx -= needIdx;
          continue;
        }
      }
      // Step 3: a geometry over UPLOAD_GEOM_SLICE never goes in one write — it reserves its region now and takes one
      // ≤ UPLOAD_GEOM_SLICE slice a frame (its meshes draw once the last slice is in); smaller ones go whole while the
      // frame's budget lasts.
      const slicing = sliced && needVtx + needIdx > this._geomSlice();
      if (slicing) { if (budget - uploaded < Renderer3D.UPLOAD_SLICE_MIN) { this._geomAppendDeferred = true; break; } }
      else if (sliced ? uploaded + needVtx + needIdx > budget : uploaded > 0 && uploaded + needVtx + needIdx > budget) { this._geomAppendDeferred = true; break; }   // P5: rest next frame
      if (!slicing) uploaded += needVtx + needIdx;
      const free = this._takeFreeRegion(needVtx, needIdx);
      let vtxOff: number, idxOff: number;
      if (free) {
        vtxOff = free.vtxOff; idxOff = free.idxOff;
      } else {
        if (this._geomVtxTail + needVtx > this._geomVBCap || this._geomIdxTail + needIdx > this._geomIBCap) {
          // P10.D4: dead space would absorb the rest → compact (the caller's GPU compaction fits) rather than grow.
          if (Renderer3D.compactBeforeGrow && this._compactionWorthwhile()) {
            let fv = 0, fi = 0;
            for (const f of this._geomFree) { fv += f.vtxBytes; fi += f.idxBytes; }
            if (this._geomVtxTail - fv + restVtx <= this._geomVBCap && this._geomIdxTail - fi + restIdx <= this._geomIBCap) return false;
          }
          if (!this._growGeomPool(this._geomVtxTail + restVtx, this._geomIdxTail + restIdx)) return false;
        }
        vtxOff = this._geomVtxTail; idxOff = this._geomIdxTail;
        this._geomVtxTail += needVtx; this._geomIdxTail += needIdx;
      }
      if (slicing) {   // Step 3: the region is reserved; its bytes go in UPLOAD_GEOM_SLICE pieces, one a frame
        const pt = { g, v: pv, vtxOff, idxOff, vtxBytes: needVtx, idxBytes: needIdx, vDone: 0, iDone: 0, lastFrame: -1 };
        this._geomPartial.set(key, pt);
        this._upSliced++;
        uploaded += this._writePartial(pt, Math.min(this._geomSlice(), budget - uploaded));
        this._geomAppendDeferred = true;
        continue;
      }
      if (needVtx + needIdx > this._upMaxWrite) this._upMaxWrite = needVtx + needIdx;
      this._writePoolView(vtxOff, idxOff, pv);
      this._geomKeyAllocs.set(key, this._poolAlloc(vtxOff, idxOff, g, pv));
      this._geomKeySrc.set(key, g);
      if (pv.pk) dropPoolView(g);
      restVtx -= needVtx; restIdx -= needIdx;
    }
    for (const m of fresh) {
      const alloc = this._geomKeyAllocs.get(m.geometryKey);
      if (!alloc) continue;
      this._r3Gen++; this._geomAllocs.set(m.id, alloc);
      this._geomPoolIds.push(m.id);
      this._geomMeshKey.set(m.id, m.geometryKey);
      this._geomKeyRefs.set(m.geometryKey, (this._geomKeyRefs.get(m.geometryKey) ?? 0) + 1);
      m.gpuDirty = false;
    }
    this._perf.appends++;
    this._upBytes += uploaded;
    // NO _shadowMapStale here — appends happen on EVERY streamed-tile arrival, and force-refreshing the shadow map
    // each time bypassed the throttle (a full-scene depth pass every few frames mid-pan). The interval pass picks
    // the new geometry up within `_shadowUpdateInterval` frames (≤3 in city mode).
    return true;
  }

  /** Step 3 (slicedUploads): a mesh whose instance slot is written but whose GEOMETRY is still waiting for the upload
   *  budget kept `gpuDirty` until the append — and every frame with any gpuDirty mesh took the O(all meshes) incremental
   *  instance path, re-wrote those slots and re-ranked the draw order. With sliced uploads a tile's geometry takes ~40
   *  frames to land, so that cost ran ~5x longer. The slot is final, and the pool finds the mesh by its missing
   *  allocation (not by gpuDirty), so the flag is cleared here. Kept for meshes whose vertex colours / modifiers read it. */
  private _clearPendingGpuDirty(m: Mesh3D): void {
    if (!Renderer3D.slicedUploads || !m.gpuDirty || this._geomAllocs.has(m.id) || m.vertexColors || m.modifiers.length) return;
    m.gpuDirty = false;
  }
  /** Step 3 A/B: prune the array-group world-box cache when the group set changes (false = never pruned, as before). */
  static pruneGroupBoxCache = true;
  // ── Step 3 sliced uploads (performance-plan §P13 "Step 3"; Renderer3D.slicedUploads) ──────────────────────────────
  /** A/B: no geometry is written in one piece over UPLOAD_GEOM_SLICE (4 MB): a bigger one reserves its region and
   *  takes one slice a frame (its meshes draw once the last slice is in); the frame's total (render-time appends + the
   *  warm calls since the last frame, together) stays within UPLOAD_FRAME_BUDGET; nearest-in-view geometry goes first.
   *  false = the P5 / P10.D8 path (one writeBuffer per geometry: an 18 MB layer was one 60-180 ms frame). */
  static slicedUploads = true;
  /** The largest single geometry write (bytes): bigger geometry is sliced across frames. */
  static UPLOAD_GEOM_SLICE = 4 << 20;
  /** Bytes of geometry written per frame interval, all geometries together (the P5 append budget). A 4 MB total was
   *  measured too: streaming then ran at its limit in a street-level fly (tiles waited ~5x longer for their geometry)
   *  and the per-frame cost of meshes waiting outweighed the smaller writes (17-42 long tasks vs 6). */
  static UPLOAD_FRAME_BUDGET = 16 << 20;
  /** A slice is only started with at least this much budget left. */
  static UPLOAD_SLICE_MIN = 256 << 10;
  /** Bytes written since the last render-time append (warm calls between frames count toward the next frame). */
  private _upBytes = 0;
  private _upFrameNo = 0;
  private _upLastMB = 0;
  private _upMaxMB = 0;
  private _upSliced = 0;
  private _upMaxWrite = 0;
  /** Geometry keys being written in slices: the reserved region and how much of each span is in. */
  private readonly _geomPartial = new Map<string, GeomPartial>();
  /** Upload priority per geometry key (computed when first seen): in view first, then by camera distance. */
  private readonly _upPrio = new Map<string, number>();
  /** End of a render-time append: record the interval's bytes, reset the shared budget, drop stalled slices. */
  private _upEndFrame(): void {
    const mb = this._upBytes / 1048576;
    this._upLastMB = mb; if (mb > this._upMaxMB) this._upMaxMB = mb;
    { const S = streamHitchStats, tot = this._upBytes + this._upInst;   // P16 ledger diagnostics
      S.instBytesLast = this._upInst; if (this._upInst > S.instBytesMax) S.instBytesMax = this._upInst; if (tot > S.frameBytesMax) S.frameBytesMax = tot; }
    this._upBytes = 0; this._upInst = 0;
    this._upFrameNo++;
    if (this._upPrio.size > 4096 && !this._geomAppendDeferred) this._upPrio.clear();
    // a sliced geometry nobody asked for in 120 frames (its meshes left before it finished) gives its region back
    if (this._geomPartial.size) for (const [k, pt] of this._geomPartial) if (this._upFrameNo - pt.lastFrame > 120) this._abandonPartial(k);
  }
  /** Write up to `budget` bytes of a sliced geometry (vertices first, then indices). Returns the bytes written. */
  private _writePartial(pt: GeomPartial, budget: number): number {
    pt.lastFrame = this._upFrameNo;
    let left = Math.max(0, Math.floor(budget / 4) * 4), wrote = 0;
    const vb = pt.v.vb, ib = pt.v.ib;   // P22: the stored bytes (packed or not); the spans past them are padding
    if (pt.vDone < vb.byteLength && left > 0) {
      const n = Math.min(left, vb.byteLength - pt.vDone);
      this.device.queue.writeBuffer(this._geomVB!, pt.vtxOff + pt.vDone, vb.buffer, vb.byteOffset + pt.vDone, n);
      pt.vDone += n; left -= n; wrote += n;
      if (n > this._upMaxWrite) this._upMaxWrite = n;
    }
    if (pt.vDone >= vb.byteLength && pt.iDone < ib.byteLength && left > 0) {
      const n = Math.min(left, ib.byteLength - pt.iDone);
      this.device.queue.writeBuffer(this._geomIB!, pt.idxOff + pt.iDone, ib.buffer, ib.byteOffset + pt.iDone, n);
      pt.iDone += n; wrote += n;
      if (n > this._upMaxWrite) this._upMaxWrite = n;
    }
    return wrote;
  }
  // ── P22 packed vertices (tile-landing.ts P22_RENDER.packedVertices; vertex-pack.ts) ─────────────────────────────────
  /** The pool's packing mode: P22_RENDER.packedVertices when the pool was (re)built. With it on every span is padded
   *  to 96 bytes and packable geometry is stored packed; a switch flip re-places the pool (repackGeometryPool). */
  private _pkMode = P22_RENDER.packedVertices;
  private _pkRepack = false;
  /** 0 = the twin pipelines were never requested, 1 = compiling, 2 = ready: geometry is packed only from then on, so
   *  a packed mesh never waits for its pipeline. */
  private _pkGate: 0 | 1 | 2 = 0;
  /** Re-place every pooled geometry under the current packedVertices switch (the next frame rebuilds the pool). */
  repackGeometryPool(): void { this._pkRepack = true; this.onDeferredWork?.(); }
  private _pkPackOk(): boolean {
    if (!this._pkMode) return false;
    if (this._pkGate === 2) return true;
    if (this._pkGate === 0) {
      this._pkGate = 1;
      setTwinReadyCallback(() => { this._gd?.invalidateBundle(); this.onDeferredWork?.(); });   // a landed twin: redraw (+ re-record the GPU bundles)
      this.pipeline.requestPackedTwins(); this._outlinePass?.requestPackedTwins();
    }
    if (twinsPending() === 0) this._pkGate = 2;
    return this._pkGate === 2;
  }
  private _poolView(g: import('./mesh-generators').MeshGeometry): PoolView {
    return poolViewOf(g, this._pkMode, this._pkMode && (g as { packable?: boolean }).packable === true && this._pkPackOk());
  }
  private _poolAlloc(vtxOff: number, idxOff: number, g: import('./mesh-generators').MeshGeometry, v: PoolView): GeomAlloc {
    return { baseVertex: vtxOff / strideOf(v.pk), firstIndex: idxOff / indexSizeOf(v.pk), indexCount: g.indices.length, vtxBytes: v.vtxBytes, idxBytes: v.idxBytes, pk: v.pk };
  }
  private _writePoolView(vtxOff: number, idxOff: number, v: PoolView): void {
    this.device.queue.writeBuffer(this._geomVB!, vtxOff, v.vb.buffer, v.vb.byteOffset, v.vb.byteLength);
    this.device.queue.writeBuffer(this._geomIB!, idxOff, v.ib.buffer, v.ib.byteOffset, v.ib.byteLength);
  }
  /** Byte offsets of an allocation in the pool's buffers. */
  private static _vOff(a: GeomAlloc): number { return a.baseVertex * strideOf(a.pk); }
  private static _iOff(a: GeomAlloc): number { return a.firstIndex * indexSizeOf(a.pk); }
  /** A NEW alloc object for `a` moved to byte offsets (nv, ni) — same format and spans (the GPU compaction). */
  private static _movedAlloc(a: GeomAlloc, nv: number, ni: number): GeomAlloc {
    return { baseVertex: nv / strideOf(a.pk), firstIndex: ni / indexSizeOf(a.pk), indexCount: a.indexCount, vtxBytes: a.vtxBytes, idxBytes: a.idxBytes, pk: !!a.pk };
  }
  private _abandonPartial(key: string): void {
    const pt = this._geomPartial.get(key);
    if (!pt) return;
    this._geomPartial.delete(key);
    this._pushFreeRegion(pt.vtxOff, pt.vtxBytes, pt.idxOff, pt.idxBytes);
  }
  /** Lower = sooner: in view (last frame's frustum) by distance, then out of view by distance + 1e6. */
  private _uploadPriority(m: Mesh3D): number {
    const c = m.obbCorners;
    if (!c || !c.length) return 1e9;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const q of c) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; if (q[2] < z0) z0 = q[2]; if (q[2] > z1) z1 = q[2]; }
    const e = this.camera?.position;
    const dist = e ? Math.hypot(Math.max(x0 - e[0], 0, e[0] - x1), Math.max(y0 - e[1], 0, e[1] - y1), Math.max(z0 - e[2], 0, e[2] - z1)) : 0;
    return this._culler.testAABB(x0, y0, z0, x1, y1, z1) ? dist : dist + 1e6;
  }

  /** P5: grow the geometry pool so its tails can reach `vtxEnd` / `idxEnd` bytes, keeping every resident allocation:
   *  new buffers, one GPU copy of the used spans, old buffers retired after this frame's submit. Every draw reads
   *  `_geomVB` / `_geomIB` fresh, so nothing else needs rebinding. False (→ the caller compacts) when growth is off,
   *  the pool isn't growable, or the device's max buffer size can't hold it. */
  private _growGeomPool(vtxEnd: number, idxEnd: number): boolean {
    if (!this.incrementalArrayGroups || !this._geomVB || !this._geomIB) return false;
    const maxBuf = this.device.limits.maxBufferSize || 0x10000000;
    const grow = (cap: number, end: number): number => end <= cap ? cap : Math.min(Math.ceil(Math.max(end, cap) * 1.5 / 4) * 4, maxBuf);
    const vCap = grow(this._geomVBCap, vtxEnd), iCap = grow(this._geomIBCap, idxEnd);
    if (vCap < vtxEnd || iCap < idxEnd) return false;
    const enc = this.device.createCommandEncoder({ label: 'geom pool grow' });
    if (vCap !== this._geomVBCap) {
      const nb = this.device.createBuffer({ size: vCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label: 'GeomPool VB' });
      if (this._geomVtxTail > 0) enc.copyBufferToBuffer(this._geomVB, 0, nb, 0, Math.ceil(this._geomVtxTail / 4) * 4);
      this._retireBuffer(this._geomVB); this._geomVB = nb; this._geomVBCap = vCap;
    }
    if (iCap !== this._geomIBCap) {
      const nb = this.device.createBuffer({ size: iCap, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label: 'GeomPool IB' });
      if (this._geomIdxTail > 0) enc.copyBufferToBuffer(this._geomIB, 0, nb, 0, Math.ceil(this._geomIdxTail / 4) * 4);
      this._retireBuffer(this._geomIB); this._geomIB = nb; this._geomIBCap = iCap;
    }
    this.device.queue.submit([enc.finish()]);
    this._perf.poolGrows++;
    this._shadowMapStale = true;
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
    this._geomKeySrc.delete(key);
    if (a) {
      this._geomKeyAllocs.delete(key);
      this._pushFreeRegion(Renderer3D._vOff(a), a.vtxBytes, Renderer3D._iOff(a), a.idxBytes);
    }
  }

  /** Evict all per-mesh CPU bookkeeping for removed meshes (group removal). Without this every city regen
   *  leaked hundreds of Map entries (`_geomAllocs`/`_normalMatCache`/`_slotMatVer`/slot maps) — unbounded
   *  growth → GC pressure → periodic frame dips. The buffer's dead space is reclaimed by the next compacting
   *  pool rebuild; this just frees the CPU side + forces a clean repack. */
  evictMeshCaches(ids: Iterable<string>, detachedOnly = false): void {
    let any = false;
    const gone = this._parkedGroups.size ? new Set<string>() : null;   // P5 (see the parked-group release below)
    // P16: `detachedOnly` = the deferred drain (evictMeshCachesDeferred): every id belongs to a mesh no longer in the
    // scene whose own P9 cache was cleared, so no live mesh's cached allocation / slot can change: no generation bump
    // (a bump per drained frame re-resolved ~13 k meshes' caches in the draw-list build).
    const bump = detachedOnly ? 0 : 1;
    for (const id of ids) {
      any = true;
      gone?.add(id);
      if (this._gd) { const gm = this._meshById.get(id); if (gm) this._gd.noteRemoved(gm); }   // P17: its GPU-driven record is dead
      const gk = this._geomMeshKey.get(id);   // free-list: drop this mesh's ref on its geometry; last one frees the region
      if (gk !== undefined) { this._geomMeshKey.delete(id); this._releaseGeomKey(gk); }
      this._r3Gen += bump; this._geomAllocs.delete(id);
      this._normalMatCache.delete(id);
      this._slotMatVer.delete(id);
      this._meshOutlines.delete(id);   // drop any persistent outline for a removed mesh
      this._dropOutlineGeom(id);       // + free its smoothed outline VB/IB
      // FREE this mesh's instance slot(s) back to the pool so the incremental add path reuses them (no full repack).
      const isl = this._meshInstanceSlots.get(id);
      if (isl !== undefined) this._slotAlloc.free(isl, 1);
      const ssl = this._meshSubmeshSlots.get(id);
      if (ssl) for (const s of ssl) this._slotAlloc.free(s, 1);
      this._r3Gen += bump; this._meshInstanceSlots.delete(id);
      this._meshSubmeshSlots.delete(id);
      this._drawOrder.delete(id);
      // mesh set changed → rebuild the cached draw rank. P16: not for a deferred drain — the frame the meshes left the
      // list already re-ranked without them (a re-rank per drained batch was an O(all meshes) update each frame).
      if (!detachedOnly) this._drawOrderDirty = true;
      // Also the world-AABB (frustum culling populates one PER mesh) and the texture bind group — without
      // these, every city regen leaked ~700 stale AABB entries that were never freed, growing the JS heap
      // over a session → slower + more frequent major GCs (the periodic frame-drops that worsen over time).
      { const e = this._meshAABBCache.get(id); if (e) e.dead = true; }   // P6: the copy held on the mesh dies too
      this._meshAABBCache.delete(id);
      this._texBindGroupCache.delete(id);
      this._groundUvScaleCache.delete(id);   // P10.D: held the GEOMETRY of every removed ground mesh (streamed tiles leaked ~2 MB each)
      // Skinned-mesh GPU buffers (VRAM). Renderer-owned → destroy. Previously freed ONLY on whole-renderer
      // dispose, so every character/skinned-mesh create→delete cycle leaked its VB/IB/skin-matrix buffers.
      this._skinnedVBs.get(id)?.destroy();       this._skinnedVBs.delete(id);
      this._skCull.delete(id);                   // R6.1 skinned cull radii + box
      this._skinnedIBs.get(id)?.destroy();       this._skinnedIBs.delete(id);
      this._skBlendVer.delete(id); this._skVBBytes.delete(id); this._skIBBytes.delete(id);   // Phase 1.5 in-place bookkeeping
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
    // P5: a parked array group whose SOURCE was just evicted can never be reclaimed (the source identity check fails)
    // — release its range now instead of holding the slots (and the dead Mesh3D) until the allocator steals it.
    if (any && gone) {
      for (const [gid, pk] of this._parkedGroups) if (gone.has(pk.src.id)) { this._parkedGroups.delete(gid); this._slotAlloc.disown(gid); }
    }
    // P10.D4 (bug-hunt D-R1): the last pooled geometry left (world cleared / every tile streamed out) → free the pool's
    // buffers instead of keeping their peak capacity; the next mesh rebuilds a pool sized to it.
    if (any && Renderer3D.geomPoolShrink && this._geomVB && this._geomAllocs.size === 0 && this._geomKeyAllocs.size === 0) this._releaseGeomPool();
    // NO _instancesDirty here: setting it forced a FULL repack on every eviction frame — which is every few frames
    // while panning a streamed world — and the repack resets the slot allocator, so the freed slots pushed above
    // were never actually reused (the incremental path was dead on exactly the frames it was built for). Removal
    // needs no repack at all: the freed slots are holes the per-mesh draw loop never reads, `totalSlots !==
    // _instanceCount` routes the next upload through `_tryIncrementalInstances` (which refreshes the count), and
    // anything the incremental path can't represent (arrays/billboards/atlas) still bails to the full repack.
  }

  // ── P16 deferred eviction (STREAM_HITCH.deferredEviction; performance-plan §P16) ────────────────────────────────────
  /** Meshes removed from the scene whose renderer cleanup is still queued (insertion order = the drain order). */
  private readonly _evictPending = new Set<Mesh3D>();
  /** P16: queue the per-mesh cleanup of meshes that were just DETACHED from the scene (a streamed tile leaving). They
   *  are not in any later frame's mesh list, so until the drain reaches them their slots / geometry refs only sit
   *  unused (holes the draw loop never reads); `drainDeferredEviction` frees them under a time budget each frame. A
   *  mesh that comes back first (re-attach) is flushed at once (`flushDeferredEviction`), so a resident mesh never
   *  carries a pending eviction. Switch off = evict now (the old path). */
  evictMeshCachesDeferred(meshes: readonly Mesh3D[]): void {
    if (!STREAM_HITCH.deferredEviction) { this.evictMeshCaches(meshes.map((m) => m.id)); return; }
    for (const m of meshes) { m._r3o = null; this._evictPending.add(m); this._gd?.noteRemoved(m); }   // P17: + its GPU-driven record is dead
    if (this._evictPending.size > streamHitchStats.evictQueueMax) streamHitchStats.evictQueueMax = this._evictPending.size;
    this.onDeferredWork?.();
  }
  /** P16: evict these meshes now if they are queued (they are about to re-enter the scene). Returns how many were. */
  flushDeferredEviction(meshes: Iterable<Mesh3D>): number {
    if (!this._evictPending.size) return 0;
    const ids: string[] = [];
    for (const m of meshes) if (this._evictPending.delete(m)) { m._r3o = null; ids.push(m.id); }
    if (ids.length) { this.evictMeshCaches(ids, true); streamHitchStats.evictFlushed += ids.length; }
    return ids.length;
  }
  /** P16: run queued evictions for up to `budgetMs` (Infinity = all). `live` (this frame's mesh list): any queued mesh
   *  that is back in it without a re-attach is flushed first, whatever the budget. Returns the meshes still queued. */
  drainDeferredEviction(budgetMs = STREAM_HITCH_LIMITS.evictBudgetMs, live?: readonly Mesh3D[]): number {
    const q = this._evictPending;
    if (!q.size) return 0;
    if (live) { let back: Mesh3D[] | null = null; for (const m of live) if (q.has(m)) (back ??= []).push(m); if (back) this.flushDeferredEviction(back); }
    const t0 = performance.now();
    const ids: string[] = [];
    let n = 0;
    for (const m of q) {
      q.delete(m); ids.push(m.id); n++;
      if ((n & 63) === 0) {   // evict in batches of 64, checking the clock between them
        this.evictMeshCaches(ids, true); ids.length = 0;
        if (performance.now() - t0 > budgetMs) { streamHitchStats.evictBudgetHits++; break; }
      }
    }
    if (ids.length) this.evictMeshCaches(ids, true);
    streamHitchStats.evictDeferred += n;
    if (q.size) this.onDeferredWork?.();
    return q.size;
  }
  /** P16 diagnostics: meshes waiting for their deferred eviction. */
  get pendingEvictions(): number { return this._evictPending.size; }

  /** PRE-UPLOAD geometry for meshes that are about to become visible (async city staging). Spreads the GPU
   *  upload across the staging frames so the reveal SWAP is a cheap visibility flip (no big upload, no rebuild).
   *  Returns false if the pool would overflow (caller lets the eventual reveal compact). */
  /** P12: whether `m`'s geometry is resident in the pool (drawable). The instanced crowd swaps a cell to a lazily
   *  built tier only once it is (no frame where neither tier draws). */
  hasMeshGeometry(m: Mesh3D): boolean { return this._geomAllocs.has(m.id); }

  /** P12: re-pack the instance slots of these ArrayGroups after their `instanceOverrides` changed (the instanced crowd
   *  hides / shows single people: a cell's tier swap, a live-crowd promotion) and upload just their ranges. A group
   *  that is not placed right now is packed fresh when it is (its parked copy is dropped, so it cannot come back
   *  stale). No full repack. Returns the number of groups re-packed. */
  repackArrayGroups(groups: Iterable<ArrayGroup3D>): number {
    const ids = new Set<string>();
    for (const g of groups) {
      this._parkedGroups.delete(g.id);
      if (this._arrayGroupFirstSlot.has(g.id) && this._placedGroupObj.get(g.id) === g && this._meshInstanceSlots.has(g.sourceId) && this._meshById.has(g.sourceId)) ids.add(g.id);
    }
    if (!ids.size || !this._instanceDataBuf || !this.instanceStorageBuffer || this._instancesDirty) return 0;
    this._packArrayGroupInstances(undefined, ids);
    const fpi = MESH_INSTANCE_STRIDE / 4, r = this._packedRanges, data = this._instanceDataBuf;
    for (let i = 0; i < r.length; i += 2) if (r[i + 1] > 0) { this.device.queue.writeBuffer(this.instanceStorageBuffer, r[i] * MESH_INSTANCE_STRIDE, data, r[i] * fpi, r[i + 1] * fpi); this._noteInstBytes(r[i + 1] * MESH_INSTANCE_STRIDE); }
    return ids.size;
  }

  warmGeometry(meshes: Mesh3D[], budgetBytes = Infinity): boolean {
    // P10.D8: `budgetBytes` caps this call's upload (the first geometry always goes); the rest is appended by the
    // render-time path (GEOM_APPEND_BUDGET per frame) or by a later warm call. Returns false while anything is left.
    let fresh: Mesh3D[] | null = null;
    for (const m of meshes) {
      if (m.geometry && m.geometry.vertices.length > 0 && !this._geomAllocs.has(m.id)) (fresh ??= []).push(m);
    }
    if (!fresh) return true;
    // performance-plan P5.W1: no pool yet (the FIRST city in an empty scene) — seed it with this group instead of
    // bailing, so the rest of the staging appends (and grows) as usual. Bailing left the whole city's geometry to
    // ONE full rebuild in the reveal frame (0.3-2 s of writeBuffer measured in the harness).
    if (!this._geomVB) { const ok = this._fullRebuildGeomPool(fresh); if (ok) this._perf.warms++; return ok; }
    // Step 3: a warm between frames spends the NEXT frame's upload budget (render-time appends + warms ≤ the budget).
    if (Renderer3D.slicedUploads && this.incrementalArrayGroups) {
      const left = this._geomBudgetLeft();   // P16: the shared write ledger (or the step-3 geometry budget)
      if (left <= 0) { this._geomAppendDeferred = true; this.onDeferredWork?.(); return false; }
      budgetBytes = Math.min(budgetBytes, left);
    }
    const ok = this._appendGeometry(fresh, budgetBytes);
    if (ok) this._perf.warms++;
    return ok && !(budgetBytes !== Infinity && this._geomAppendDeferred);
  }

  /** P10.D4: drop the (empty) geometry pool's buffers — retired after this frame's work — and reset its bookkeeping, so
   *  the next `_ensureGeomPool` takes the `!_geomVB` full-rebuild path sized to the geometry that exists then. */
  private _releaseGeomPool(): void {
    if (this._geomVB) this._retireBuffer(this._geomVB);
    if (this._geomIB) this._retireBuffer(this._geomIB);
    this._geomVB = null; this._geomIB = null;
    this._geomVBCap = 0; this._geomIBCap = 0;
    this._geomVtxTail = 0; this._geomIdxTail = 0;
    this._pkMode = P22_RENDER.packedVertices;   // P22: an empty pool takes the current packing mode
    this._geomFree = [];
    this._geomPoolIds = [];
    this._geomKeySrc.clear(); this._geomKeyRefs.clear(); this._geomMeshKey.clear();
    this._geomPartial.clear();   // step 3: the sliced regions went with the buffers
    this._r3Gen++;
    this._perf.poolReleases++;
  }

  /** P10.B6 A/B: compact the geometry pool with GPU buffer copies (no CPU re-upload). false = the full rebuild,
   *  which re-sends every live geometry with writeBuffer — ~1 s of main thread for the ~1.1-1.9 GB pool of a streamed
   *  tiled world (it ran 350 ms after every pan stopped: the idle compaction). */
  static gpuGeomCompaction = true;
  /** Bytes moved per scratch round trip (a pool buffer cannot be both source and destination of one copy). */
  static GEOM_COMPACT_SCRATCH = 64 << 20;
  private _geomScratch: GPUBuffer | null = null;
  /**
   * COMPACT the pool IN PLACE on the GPU: every live geometry (a key some mesh in `meshes` still uses) slides down to
   * a dense prefix through a small scratch buffer — copies in ascending OLD offset order, so a destination never
   * overlaps data not yet moved (each new offset is the sum of the sizes before it, ≤ its old offset). Vertex and
   * index spans compact independently (indices are geometry-local; draws pass baseVertex). Geometry the pool has not
   * seen yet is then appended at the new tail with writeBuffer. The bookkeeping ends exactly as a full rebuild's
   * would (allocs, key refs, mesh keys, pool ids, empty free list, tails). Returns null when it cannot (no pool, the
   * live + new geometry would not fit the current buffers): the caller then takes the full rebuild, which grows them.
   */
  private _compactGeomPoolGpu(meshes: Mesh3D[]): boolean | null {
    if (!Renderer3D.gpuGeomCompaction || !this._geomVB || !this._geomIB) return null;
    const t0 = performance.now();
    const live = new Map<string, GeomAlloc>();
    const fresh = new Map<string, import('./mesh-generators').MeshGeometry>();
    for (const m of meshes) {
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;
      const key = m.geometryKey;
      if (live.has(key) || fresh.has(key)) continue;
      const a = this._geomKeyAllocs.get(key);
      if (a && this._geomKeySrc.get(key) === g) live.set(key, a); else fresh.set(key, g);   // collided / stale → re-upload
    }
    if (!live.size && !fresh.size) return null;
    let needV = 0, needI = 0;
    for (const a of live.values()) { needV += a.vtxBytes; needI += a.idxBytes; }
    for (const g of fresh.values()) { needV += this._pkMode ? alignVtx(g.vertices.byteLength) : g.vertices.byteLength; needI += g.indices.byteLength; }   // (P22: unpacked = an upper bound)
    if (needV > this._geomVBCap || needI > this._geomIBCap) return null;
    type E = { key: string; a: GeomAlloc; ov: number; oi: number; nv: number; ni: number };
    const ents: E[] = [];
    for (const [key, a] of live) ents.push({ key, a, ov: Renderer3D._vOff(a), oi: Renderer3D._iOff(a), nv: 0, ni: 0 });   // P22: per-format offsets
    const SCR = Renderer3D.GEOM_COMPACT_SCRATCH;
    if (!this._geomScratch) this._geomScratch = this.device.createBuffer({ size: SCR, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'GeomPool compaction scratch' });
    const scratch = this._geomScratch;
    const enc = this.device.createCommandEncoder({ label: 'geom pool compaction' });
    let moves = 0;
    const slide = (buf: GPUBuffer, spans: { off: number; size: number }[]): { newOff: number[]; tail: number } => {
      const plan = planSpanCompaction(spans, SCR, STREAM_HITCH.coalescedCompaction);   // P16: adjacent spans move as one run
      for (const [src, dst, size] of plan.moves) {
        enc.copyBufferToBuffer(buf, src, scratch, 0, size);
        enc.copyBufferToBuffer(scratch, 0, buf, dst, size);
      }
      moves += plan.moves.length;
      return plan;
    };
    const vp = slide(this._geomVB, ents.map(e => ({ off: e.ov, size: e.a.vtxBytes })));
    const ip = slide(this._geomIB, ents.map(e => ({ off: e.oi, size: e.a.idxBytes })));
    ents.forEach((e, k) => { e.nv = vp.newOff[k]; e.ni = ip.newOff[k]; });
    let vTail = vp.tail, iTail = ip.tail;
    // P10.D4 SHRINK: the live (+ fresh) geometry is now a dense prefix — when the buffers are > 3× what it needs,
    // move the prefix into smaller buffers (one more GPU copy) and retire the big ones. Streaming then really frees VRAM.
    if (Renderer3D.geomPoolShrink) {
      const sv = planPoolShrink(this._geomVBCap, needV), si = planPoolShrink(this._geomIBCap, needI);
      if (sv !== null) {
        const nb = this.device.createBuffer({ size: sv, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label: 'GeomPool VB' });
        if (vTail > 0) enc.copyBufferToBuffer(this._geomVB, 0, nb, 0, Math.ceil(vTail / 4) * 4);
        this._retireBuffer(this._geomVB); this._geomVB = nb; this._geomVBCap = sv;
      }
      if (si !== null) {
        const nb = this.device.createBuffer({ size: si, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label: 'GeomPool IB' });
        if (iTail > 0) enc.copyBufferToBuffer(this._geomIB, 0, nb, 0, Math.ceil(iTail / 4) * 4);
        this._retireBuffer(this._geomIB); this._geomIB = nb; this._geomIBCap = si;
      }
      if (sv !== null || si !== null) this._perf.poolShrinks++;
    }
    this.device.queue.submit([enc.finish()]);   // queued BEFORE the fresh writeBuffers below (queue order)
    if (P20_RENDER.cheapCompaction) return this._compactBookkeepingP20(meshes, ents, fresh, vTail, iTail, t0, moves);
    // Bookkeeping — the same end state as _fullRebuildGeomPool.
    const srcOf = new Map(this._geomKeySrc);
    this._geomKeyAllocs.clear();
    this._geomPartial.clear();   // step 3: every geometry is re-placed (sliced regions are not live allocations)
    this._geomKeySrc.clear();
    this._r3Gen++; this._geomAllocs.clear();
    this._geomKeyRefs.clear();
    this._geomMeshKey.clear();
    this._geomFree = [];
    this._geomPoolIds = [];
    for (const e of ents) {
      this._geomKeyAllocs.set(e.key, Renderer3D._movedAlloc(e.a, e.nv, e.ni));
      this._geomKeySrc.set(e.key, srcOf.get(e.key)!);
    }
    // P16 uploadLedger: geometry the pool has not seen yet is NOT written here in whole pieces (one compaction frame
    // wrote every fresh geometry at once: up to tens of MB); its meshes stay unallocated and the sliced append places
    // them over the next frames under the write ledger (they are held out of the draw lists until then).
    const holdFresh = STREAM_HITCH.uploadLedger && Renderer3D.slicedUploads && this.incrementalArrayGroups && fresh.size > 0;
    if (!holdFresh) for (const [key, g] of fresh) {
      this._geomKeySrc.set(key, g);
      const pv = this._poolView(g);
      this._writePoolView(vTail, iTail, pv);
      this._geomKeyAllocs.set(key, this._poolAlloc(vTail, iTail, g, pv));
      if (pv.pk) dropPoolView(g);
      vTail += pv.vtxBytes; iTail += pv.idxBytes;
    }
    for (const m of meshes) {
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;
      const key = m.geometryKey, alloc = this._geomKeyAllocs.get(key);
      if (!alloc) continue;   // P16: a held fresh geometry (appended later)
      this._r3Gen++; this._geomAllocs.set(m.id, alloc);
      this._geomPoolIds.push(m.id);
      this._geomMeshKey.set(m.id, key);
      this._geomKeyRefs.set(key, (this._geomKeyRefs.get(key) ?? 0) + 1);
      m.gpuDirty = false;
    }
    this._geomVtxTail = vTail;
    this._geomIdxTail = iTail;
    this._geomAppendDeferred = holdFresh;   // P16: held fresh meshes stay out of the draw lists until appended
    if (holdFresh) this.onDeferredWork?.();
    this._shadowMapStale = true;
    this._perf.poolRebuilds++;
    this._perf.gpuCompactions++;
    this._perf.lastPoolMs = performance.now() - t0;
    this._lastGpuCompaction = { ms: this._perf.lastPoolMs, moves, liveMB: Math.round((vTail + iTail) / 1048576), fresh: fresh.size };
    return this._geomAllocs.size > 0;
  }
  /** The last GPU compaction (diagnostics): CPU ms, copy rounds, live MB after, fresh keys appended. */
  _lastGpuCompaction: { ms: number; moves: number; liveMB: number; fresh: number } | null = null;

  /**
   * P20 cheapCompaction: the GPU compaction's bookkeeping WITHOUT rebuilding the per-mesh maps from scratch. The moved
   * keys get NEW alloc objects (the GPU-driven scene re-reads a record whose alloc object changed — an in-place edit
   * would leave it drawing the old offsets), every mesh already mapped to a live key is re-pointed at its key's new
   * alloc (one Map.set — its key, the key's ref count and the key's source are unchanged), dead keys, their meshes and
   * mapped meshes off this frame's list are dropped, and only meshes the pool has not seen yet are added. The same
   * allocs, refs and residency as the rebuild; `_geomPoolIds` (a diagnostic) restarts empty. See performance-plan §P20.
   */
  private _compactBookkeepingP20(meshes: Mesh3D[], ents: { key: string; a: GeomAlloc; nv: number; ni: number }[],
    fresh: Map<string, import('./mesh-generators').MeshGeometry>, vTail: number, iTail: number, t0: number, moves: number): boolean {
    const allocs = this._geomKeyAllocs, live = new Set<string>();
    for (const e of ents) {
      live.add(e.key);
      allocs.set(e.key, Renderer3D._movedAlloc(e.a, e.nv, e.ni));
    }
    for (const k of [...allocs.keys()]) if (!live.has(k)) { allocs.delete(k); this._geomKeySrc.delete(k); this._geomKeyRefs.delete(k); }
    this._geomPartial.clear();
    this._geomFree = [];
    this._geomPoolIds = [];
    this._r3Gen++;
    // every mapped mesh of this frame's list → its key's new alloc; meshes of dead keys, and mapped meshes not in the
    // list (the rebuild drops them too), leave the maps (an off-list mesh's ref on a live key is released)
    const inList = new Set<string>();
    for (const m of meshes) inList.add(m.id);
    for (const [id, key] of this._geomMeshKey) {
      const a = allocs.get(key);
      if (a && inList.has(id)) { this._geomAllocs.set(id, a); continue; }
      this._geomAllocs.delete(id); this._geomMeshKey.delete(id);
      if (a) { const n = (this._geomKeyRefs.get(key) ?? 1) - 1; if (n > 0) this._geomKeyRefs.set(key, n); else this._geomKeyRefs.delete(key); }
    }
    const holdFresh = STREAM_HITCH.uploadLedger && Renderer3D.slicedUploads && this.incrementalArrayGroups && fresh.size > 0;
    if (!holdFresh) for (const [key, g] of fresh) {
      this._geomKeySrc.set(key, g);
      const pv = this._poolView(g);
      this._writePoolView(vTail, iTail, pv);
      allocs.set(key, this._poolAlloc(vTail, iTail, g, pv));
      if (pv.pk) dropPoolView(g);
      vTail += pv.vtxBytes; iTail += pv.idxBytes;
    }
    // meshes not mapped yet (a new mesh sharing a live key, or a fresh one placed above)
    const meshKey = this._geomMeshKey;
    for (const m of meshes) {
      if (meshKey.has(m.id)) { if (m.gpuDirty && allocs.has(meshKey.get(m.id)!)) m.gpuDirty = false; continue; }
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;
      const key = m.geometryKey, alloc = allocs.get(key);
      if (!alloc) continue;   // P16: a held fresh geometry (appended later)
      this._geomAllocs.set(m.id, alloc);
      meshKey.set(m.id, key);
      this._geomKeyRefs.set(key, (this._geomKeyRefs.get(key) ?? 0) + 1);
      m.gpuDirty = false;
    }
    this._geomVtxTail = vTail;
    this._geomIdxTail = iTail;
    this._geomAppendDeferred = holdFresh;
    if (holdFresh) this.onDeferredWork?.();
    this._shadowMapStale = true;
    this._perf.poolRebuilds++;
    this._perf.gpuCompactions++;
    this._perf.lastPoolMs = performance.now() - t0;
    this._lastGpuCompaction = { ms: this._perf.lastPoolMs, moves, liveMB: Math.round((vTail + iTail) / 1048576), fresh: fresh.size };
    return this._geomAllocs.size > 0;
  }

  private _fullRebuildGeomPool(meshes: Mesh3D[]): boolean {
    const t0 = performance.now();
    this._perf.poolRebuilds++;
    this._geomAppendDeferred = false;   // a full rebuild uploads everything
    this._shadowMapStale = true;   // geometry changed → the throttled shadow map must refresh
    // First pass: compute total sizes counting each unique geometry key once.
    // Meshes sharing the same geometryKey (e.g. 10 default spheres) contribute
    // only one copy of their vertex/index data to the pool.
    // P22: a full rebuild re-places everything, so it is where the packing mode follows its switch
    this._pkMode = P22_RENDER.packedVertices; this._pkRepack = false;
    // (sizes are the UNPACKED spans — an upper bound of the packed ones: no packed copy of the whole pool is ever held)
    const keyToSize = new Map<string, { vtxBytes: number; idxBytes: number }>();
    for (const m of meshes) {
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;
      if (!keyToSize.has(m.geometryKey)) {
        keyToSize.set(m.geometryKey, { vtxBytes: this._pkMode ? alignVtx(g.vertices.byteLength) : g.vertices.byteLength, idxBytes: g.indices.byteLength });
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
    // P10.D4: also REALLOCATE smaller when the buffer is > 3× the live data (a rebuild re-uploads everything anyway).
    const shrinkV = Renderer3D.geomPoolShrink && planPoolShrink(this._geomVBCap, totalVtxBytes) !== null;
    const shrinkI = Renderer3D.geomPoolShrink && planPoolShrink(this._geomIBCap, totalIdxBytes) !== null;
    if (shrinkV || shrinkI) this._perf.poolShrinks++;
    if (totalVtxBytes > this._geomVBCap || shrinkV) {
      this._geomVB?.destroy();
      this._geomVBCap = Math.min(Math.ceil(totalVtxBytes * Renderer3D.GEOM_OVERPROVISION), maxBuf);
      this._geomVB = this.device.createBuffer({
        size: this._geomVBCap,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,   // COPY_SRC: P5 growth
        label: 'GeomPool VB',
      });
    }
    if (totalIdxBytes > this._geomIBCap || shrinkI) {
      this._geomIB?.destroy();
      this._geomIBCap = Math.min(Math.ceil(totalIdxBytes * Renderer3D.GEOM_OVERPROVISION), maxBuf);
      this._geomIB = this.device.createBuffer({
        size: this._geomIBCap,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        label: 'GeomPool IB',
      });
    }

    // Second pass: upload each unique geometry once, assign shared allocs to all instances. Compaction resets
    // the append tails + key map + FREE LIST + ref counts — so any stale allocs / dead space / fragmentation from
    // removed meshes are reclaimed here (a clean, contiguous repack).
    this._geomKeyAllocs.clear();
    this._geomPartial.clear();   // step 3: every geometry is re-placed (sliced regions are not live allocations)
    this._geomKeySrc.clear();
    this._r3Gen++; this._geomAllocs.clear();
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
        // New unique geometry — upload it to the pool (P22: as its pool view: packed or not, spans padded in pack mode).
        const pv = this._poolView(g);
        this._writePoolView(vtxByteOffset, idxByteOffset, pv);
        alloc = this._poolAlloc(vtxByteOffset, idxByteOffset, g, pv);
        if (pv.pk) dropPoolView(g);
        this._geomKeyAllocs.set(key, alloc);
        this._geomKeySrc.set(key, g);
        vtxByteOffset += pv.vtxBytes;
        idxByteOffset += pv.idxBytes;
      }
      // Shared: all instances of the same geometry point to the same pool slot.
      this._r3Gen++; this._geomAllocs.set(m.id, alloc);
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
    uploadUniforms = true,
  ): void {
    const _sk0 = performance.now();
    if (meshes.length > 0) this._drew3DThisFrame = true;   // AA gate (runPostProcess)
    this._prewarmForScene(meshes, true);   // P2.2
    const fs = this._frame;
    const visible = this._skinnedVisibleScratch; visible.length = 0;
    let nVisible = 0;
    for (const m of meshes) if (m.isEffectivelyVisible() && m.skeleton) { visible.push(m); nVisible++; }
    // E1 tail (c): a ROSTER change (spawn/despawn/hide — including down to zero) must refresh the shadow
    // map, or a throttled/static map holds the departed character's silhouette indefinitely. Checked
    // BEFORE the empty early-return so deleting the last character clears its shadow too.
    if (this._shadowsEnabled && nVisible !== this._lastSkinnedCount) this._skinnedShadowChanged();
    this._lastSkinnedCount = nVisible;
    fs.skinnedMeshes = nVisible; fs.skinnedDrawn = 0; fs.skinnedCulled = 0; fs.skinnedShadow = 0;
    fs.skinUploads = 0; fs.skinnedTris = 0; fs.msSkinned = 0; fs.skinnedWaiting = 0;
    if (visible.length === 0) { this._skelAnimCulled.clear(); fs.skelAnimCulled = 0; return; }

    this.camera.aspect = canvasWidth / canvasHeight;
    // P1: drawMeshes already uploaded identical scene uniforms this frame in the mixed-scene path → skip the repeat.
    // (Before the cull: it refreshes the light matrix + camera the cull reads.)
    if (uploadUniforms) this.uploadSceneUniforms(canvasWidth, canvasHeight);

    // R6.1: frustum-cull the parts (in place: `visible` becomes the LIVE list; flags land on each cache entry).
    this._cullSkinned(visible);
    if (visible.length === 0) { fs.msSkinned = performance.now() - _sk0; return; }

    // ── E1: order the parts so consecutive draws share pipeline + skeleton, letting the draw loops
    // below ELIDE redundant setPipeline / setBindGroup calls (a multi-part character used to pay a
    // pipeline set + 2-3 bind-group sets PER PART; now one per group). Opaque + depth-tested → draw
    // order is free; Array.sort is stable (ES2019) so same-key parts keep authoring order. The
    // instance slots upload AFTER this sort, so `firstInstance = i` still maps 1:1 below. ──
    if (visible.length > 1) {
      const rank = (m: SkinnedMesh3D): number =>
        m.vertexColors ? 8
          : ((m.material.hasTexture || m.material.hasNormalMap) ? 4 : 0) | (this._usesPatterns(m) ? 1 : 0);
      visible.sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        const as = a.skeleton!.id, bs = b.skeleton!.id;
        return as < bs ? -1 : as > bs ? 1 : 0;
      });
    }

    // Per-slot flags in the SORTED order (the instance slots below and the shadow replay index by position).
    if (this._skinnedFlags.length < visible.length) this._skinnedFlags = new Uint8Array(Math.max(visible.length, this._skinnedFlags.length * 2));
    const flags = this._skinnedFlags;
    for (let i = 0; i < visible.length; i++) flags[i] = this._skCull.get(visible[i].id)?.flags ?? 3;

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
    if (this._taaVelOn) this._taaSkinFrame = this._taaFrameNo;   // temporal AA: this frame's skinned list is valid

    // Fresh draw call → each dirty skeleton's shared skin buffer uploads once below.
    this._skinBufUploaded.clear();

    // Recreate mesh bind group when buffer reference changed.
    if (!this._skinnedMeshBG || this._skinnedMeshBGBuf !== this._skinnedInstBuf) {
      // Skinned meshes are NOT rendered into the SSAO world-position prepass, so they can't sample a meaningful
      // AO value — bind the 1×1 white no-op at 3/4 (required to satisfy the shared group-0 layout). Characters
      // gaining AO would need them added to the prepass (a later step).
      this._ensureAOBindResources();
      this._ensureSceneColorResources();
      const cubeTex = this._specularCubeBindTexture();   // real baked sky cube, or the 1×1×6 dummy — must satisfy 7/8/9
      // Skinned meshes never set glassEnhance, so refraction never samples this — bind the 1×1 default at 5/6.
      this._skinnedMeshBG = this.device.createBindGroup({
        layout: this.pipeline.meshBindGroupLayout,
        entries: this._skinnedMeshBGEntries = [
          { binding: 0, resource: { buffer: this._skinnedInstBuf! } },
          { binding: 1, resource: { buffer: this.sceneUniformBuffer } },
          { binding: 2, resource: { buffer: this._iblUniformBuffer! } },
          { binding: 3, resource: this._ssaoWhiteTex!.createView() },
          { binding: 4, resource: this._ssaoAOSampler! },
          { binding: 5, resource: this._sceneColorDefaultTex!.createView() },
          { binding: 6, resource: this._sceneColorSampler! },
          { binding: 7, resource: cubeTex.createView({ dimension: 'cube' }) },
          { binding: 8, resource: this._iblCubeSampler! },
          { binding: 9, resource: this._brdfLutTex!.createView() },
          { binding: 10, resource: this._worldPosBindTexture().createView() },   // SSR world-pos (skinned draws in the color pass only)
          { binding: 11, resource: this._worldPosBackBindTexture().createView() },   // SSR depth-peel back layer
          { binding: 12, resource: this._normalBindTexture().createView() },         // prepass normal+material
          // Skinned meshes are NOT in the prepass, so the resolve texture holds the reflection of whatever is
          // BEHIND them — bind the dummy (0) so their SSR branch falls back to the cubemap cleanly instead.
          { binding: 13, resource: this._ensureDummyHalfFloat().createView() },
          { binding: 14, resource: this._ensureDummyHalfFloat().createView() },   // skinned meshes can't be planar mirrors
        ],
      });
      this._skinnedMeshBGBuf = this._skinnedInstBuf;
    }

    // E1 tail (c): a POSE change (idle breathing, clip playback) must refresh the shadow map too —
    // matricesDirty is still set here (cleared at the end of this method, after the skin uploads).
    if (this._shadowsEnabled && !this._shadowMapStale) {
      // With near CASCADES live, a moving pose only refreshes them (every frame, cheap: few casters); the far map picks
      // the pose up on its own throttle - so an animated player no longer redraws the whole city's shadow every frame.
      for (let i = 0; i < visible.length; i++) { if ((flags[i] & 2) && visible[i].skeleton!.matricesDirty) { if (this._cascadeCount > 0) { if (this._cascadeSplitLists) this._cascadeDynStale = true; else this._cascadeStale = true; } else this._skinnedShadowChanged(); break; } }   // P14: split → only the dynamic layer
    }

    // E1 state elision: the sort above put same-(pipeline, skeleton) parts adjacent — only emit the
    // state calls whose value actually changed. Bind-group slots are tracked PER INDEX because the
    // textured path uses (1=texture, 2=skin) while untextured uses (1=skin) — the same skinBG object
    // at a DIFFERENT index still needs a set.
    pass.setBindGroup(0, this._skinnedMeshBG!);   // constant across every skinned draw
    let curPipe: GPURenderPipeline | null = null;
    let curBG1: GPUBindGroup | null = null;
    let curBG2: GPUBindGroup | null = null;
    let faceOverlays: number[] | null = null;
    let skStuck = false;   // a live part skipped for a reason other than a compiling pipeline (see below)
    for (let i = 0; i < visible.length; i++) {
      const mesh = visible[i];
      if (!mesh.skeleton) continue;

      this._ensureSkinnedVBIB(mesh);
      this._ensureSkinMatBuf(mesh);   // live parts only (in view or casting) — a culled character uploads nothing
      if (!(flags[i] & 1)) continue;  // R6.1: shadow-only part — its slot + skin buffer are ready for the replay

      const vb = this._skinnedVBs.get(mesh.id);
      const ib = this._skinnedIBs.get(mesh.id);
      const skinBG = this._skinBGs.get(mesh.skeleton.id);   // shared per-skeleton bind group
      // (No buffers / bind group is not a pipeline wait, so the pipeline cache's ready event can't re-request a frame:
      // ask for one here, or an idle on-demand loop could sit on a frame without this part — performance-plan §P15.)
      if (!vb || !ib || !skinBG) { fs.skinnedWaiting++; skStuck = true; continue; }
      if (mesh.isFaceFeatures) { (faceOverlays ??= []).push(i); continue; }   // face kit: multiplied over the lit skin below

      pass.setVertexBuffer(0, vb);
      pass.setIndexBuffer(ib, 'uint32');

      if (mesh.vertexColors) {
        this._ensureSkinnedVCBuf(mesh);
        const vcBG = this._skinnedVCBGs.get(mesh.id);
        // No VC bind group yet → skip (bug-hunt 2026-10-01): falling through drew with the PREVIOUS part's pipeline +
        // bind groups (or none — a validation error that drops the whole frame).
        if (!vcBG) { fs.skinnedWaiting++; skStuck = true; continue; }
        {
          const p = this._weightPaintUnlit
            ? this.pipeline.skinnedWeightPaintUnlitPipeline
            : this.pipeline.skinnedWeightPaintPipeline;
          if (!p) { fs.skinnedWaiting++; continue; }   // P2: still compiling → skip this part (the cache's ready event re-requests a frame)
          if (p !== curPipe) { pass.setPipeline(p); curPipe = p; }
          if (skinBG !== curBG1) { pass.setBindGroup(1, skinBG); curBG1 = skinBG; }
          if (vcBG !== curBG2) { pass.setBindGroup(2, vcBG); curBG2 = vcBG; }
        }
      } else {
        const useTexture = mesh.material.hasTexture || mesh.material.hasNormalMap;
        const patterned = this._usesPatterns(mesh);   // §3.1: characters are plain → the cheaper skinned pipeline
        // SHADER SPLIT: a covered part draws with its generated pipeline (skinned: never shadow-receiving)
        const ssk = shaderSplitActive() ? mesh._r3FK : -1;
        if (ssk >= 0) {
          const p = this._splitPipe(ssk, 'skinned', false);
          if (!p) { fs.skinnedWaiting++; continue; }   // held: the exact key compiles (draws once it lands)
          if (p !== curPipe) { pass.setPipeline(p); curPipe = p; }
          if (useTexture) {
            const texBG = this.createTextureBindGroup(mesh);
            if (texBG !== curBG1) { pass.setBindGroup(1, texBG); curBG1 = texBG; }
            if (skinBG !== curBG2) { pass.setBindGroup(2, skinBG); curBG2 = skinBG; }
          } else if (skinBG !== curBG1) { pass.setBindGroup(1, skinBG); curBG1 = skinBG; }
        } else if (useTexture) {
          const p = patterned ? this.pipeline.skinnedOpaqueTexturedPipeline : this.pipeline.skinnedOpaqueTexturedPlainPipeline;
          if (!p) { fs.skinnedWaiting++; continue; }   // P2: still compiling → skip this part (draws once it lands)
          if (p !== curPipe) { pass.setPipeline(p); curPipe = p; }
          const texBG = this.createTextureBindGroup(mesh);
          if (texBG !== curBG1) { pass.setBindGroup(1, texBG); curBG1 = texBG; }
          if (skinBG !== curBG2) { pass.setBindGroup(2, skinBG); curBG2 = skinBG; }
        } else {
          const p = patterned ? this.pipeline.skinnedOpaqueUntexturedPipeline : this.pipeline.skinnedOpaqueUntexturedPlainPipeline;
          if (!p) { fs.skinnedWaiting++; continue; }   // P2: still compiling → skip this part (draws once it lands)
          if (p !== curPipe) { pass.setPipeline(p); curPipe = p; }
          if (skinBG !== curBG1) { pass.setBindGroup(1, skinBG); curBG1 = skinBG; }
        }
      }

      // Counted HERE, once the draw is really issued (§P15 draw-bug 2026-10-04): it used to count before the pipeline
      // check, so a character whose skinned pipelines were still compiling read "drawn" in the stats while invisible.
      fs.skinnedDrawn++; fs.skinnedTris += mesh.geometry.indices.length / 3;
      pass.drawIndexed(mesh.geometry.indices.length, 1, 0, 0, i);
    }

    // FACE KIT overlays (face-features.ts): drawn after every opaque skinned part with the MULTIPLY pipeline (no depth
    // write), so brows / mouth / blush / hair shadow darken whatever the skin rendered, in any render style.
    const faceSplit = !!faceOverlays && shaderSplitActive();
    const faceMulPipe = faceOverlays && !faceSplit ? this.pipeline.skinnedFaceMultiplyPipeline : null;
    if (faceOverlays && !faceSplit && !faceMulPipe) fs.skinnedWaiting += faceOverlays.length;   // still compiling (ready event re-requests)
    if (skStuck) this.onDeferredWork?.();
    if (faceOverlays && (faceMulPipe || faceSplit)) {
      if (faceMulPipe) pass.setPipeline(faceMulPipe);
      let fmCur: GPURenderPipeline | null = null;
      for (const i of faceOverlays) {
        const mesh = visible[i];
        if (faceSplit) {
          // SHADER SPLIT: the face-kit multiply axis (the PLAIN skinned textured shader today; _r3FK is the slot key with
          // tex = true, -1 unless PLAIN-safe)
          const p = mesh._r3FK >= 0 ? this._splitPipe(mesh._r3FK, 'skinnedFaceMultiply', false) : this.pipeline.skinnedFaceMultiplyPipeline;
          if (!p) { fs.skinnedWaiting++; continue; }
          if (p !== fmCur) { pass.setPipeline(p); fmCur = p; }
        }
        fs.skinnedDrawn++; fs.skinnedTris += mesh.geometry.indices.length / 3;
        pass.setVertexBuffer(0, this._skinnedVBs.get(mesh.id)!);
        pass.setIndexBuffer(this._skinnedIBs.get(mesh.id)!, 'uint32');
        pass.setBindGroup(1, this.createTextureBindGroup(mesh));
        pass.setBindGroup(2, this._skinBGs.get(mesh.skeleton!.id)!);
        pass.drawIndexed(mesh.geometry.indices.length, 1, 0, 0, i);
      }
    }

    // Persistent PER-OBJECT outlines on SKINNED meshes — grouped by SKELETON so a whole character (body + hair +
    // clothes, all sharing one skeleton) is outlined as ONE union silhouette, not per-part (per-part fills the body
    // where the clothes occlude it). The style comes from whichever part carries mesh.outline (the body, set via the
    // "Character" outliner node). A standalone skinned mesh = a group of one.
    if (this._highlightPass && this._highlightPass.supportsSkinned && this._skinnedMeshBG && !(RD.on && RD.f.noHighlight)) {
      const outlinedSkels = new Map<string, HighlightStyle[]>();   // skeleton → its outline layers (inner → outer)
      for (let i = 0; i < visible.length; i++) {
        const m = visible[i];
        if ((flags[i] & 1) && m.outline && m.skeleton && !outlinedSkels.has(m.skeleton.id)) outlinedSkels.set(m.skeleton.id, outlineLayers(m.outline, m.outlineRings));
      }
      if (outlinedSkels.size > 0) {
        const _skTime = performance.now() / 1000;
        let spi = 0;
        for (const [skelId, layers] of outlinedSkels) {
          const parts: { vb: GPUBuffer; ib: GPUBuffer; indexCount: number; instanceSlot: number; skinBG: GPUBindGroup; texBG: GPUBindGroup }[] = [];
          for (let i = 0; i < visible.length; i++) {
            const mesh = visible[i];
            if (!(flags[i] & 1) || !mesh.skeleton || mesh.skeleton.id !== skelId || mesh.isFaceFeatures) continue;
            const vb = this._skinnedVBs.get(mesh.id);
            const ib = this._skinnedIBs.get(mesh.id);
            const skinBG = this._skinBGs.get(skelId);
            if (!vb || !ib || !skinBG) continue;
            // texBG feeds the stencil's alpha test (group 2) — alpha-cutout hair marks its visible shape, not the card quad.
            parts.push({ vb, ib, indexCount: mesh.geometry.indices.length, instanceSlot: i, skinBG, texBG: this.createTextureBindGroup(mesh) });
          }
          if (parts.length === 0) continue;
          const paramIndices: number[] = [];
          for (const layer of layers) {
            this._highlightPass.writeCustomParamsSkinned(spi, layer, canvasWidth, canvasHeight, outlineAnimates(layer) ? _skTime : 0);
            paramIndices.push(spi++);
          }
          this._highlightPass.drawSkinnedGroupOutline(pass, this._skinnedMeshBG, parts, paramIndices, !!layers[0].merge);
        }
      }
    }

    // ── P4b.2: CHARACTERS IN THE MIRROR ──
    // A second skinned draw into the planar texture (load/load — composites over the static mirror image with
    // correct depth occlusion), using the mirrored-camera uniform buffer at binding 1. Skinned pipelines are
    // already cullMode 'none', so the mirrored winding flip needs no pipeline variants. Weight-paint preview
    // meshes (vertexColors) are skipped — editing state doesn't belong in reflections.
    if (this._planarActive && this._planarTex && this._planarDepthTex && this._planarSceneBuf) {
      if (!this._planarSkinnedBG || this._planarSkinnedBGBuf !== this._skinnedInstBuf) {
        this._ensureAOBindResources();
        this._ensureSceneColorResources();
        const cubeTex2 = this._specularCubeBindTexture();
        const hfDummy = this._ensureDummyHalfFloat().createView();
        this._planarSkinnedBG = this.device.createBindGroup({
          layout: this.pipeline.meshBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this._skinnedInstBuf! } },
            { binding: 1, resource: { buffer: this._planarSceneBuf } },
            { binding: 2, resource: { buffer: this._iblUniformBuffer! } },
            { binding: 3, resource: this._ssaoWhiteTex!.createView() },
            { binding: 4, resource: this._ssaoAOSampler! },
            { binding: 5, resource: this._sceneColorDefaultTex!.createView() },
            { binding: 6, resource: this._sceneColorSampler! },
            { binding: 7, resource: cubeTex2.createView({ dimension: 'cube' }) },
            { binding: 8, resource: this._iblCubeSampler! },
            { binding: 9, resource: this._brdfLutTex!.createView() },
            { binding: 10, resource: this._worldPosBindTexture().createView() },
            { binding: 11, resource: this._worldPosBackBindTexture().createView() },
            { binding: 12, resource: hfDummy },
            { binding: 13, resource: hfDummy },
            { binding: 14, resource: hfDummy },
          ],
        });
        this._planarSkinnedBGBuf = this._skinnedInstBuf;
      }
      const pEnc = this.device.createCommandEncoder();
      const pPass = pEnc.beginRenderPass({
        label: 'PlanarReflectionSkinned',
        colorAttachments: [{ view: this._planarTex.createView(), loadOp: rdColorLoad(), storeOp: 'store' }],   // ('load'; render debug may clear)
        depthStencilAttachment: { view: this._planarDepthTex.createView(), depthClearValue: 1.0, depthLoadOp: rdDepthLoad(), depthStoreOp: 'store', stencilLoadOp: rdDepthLoad(), stencilStoreOp: 'store' },
      });
      // Same E1 elision as the main loop (the sort already grouped the parts).
      pPass.setBindGroup(0, this._planarSkinnedBG!);
      let pPipe: GPURenderPipeline | null = null;
      let pBG1: GPUBindGroup | null = null;
      let pBG2: GPUBindGroup | null = null;
      for (let i = 0; i < visible.length; i++) {
        const mesh = visible[i];
        if (!mesh.skeleton || mesh.vertexColors || mesh.isFaceFeatures) continue;   // (face-kit overlays need the multiply blend)
        const vb = this._skinnedVBs.get(mesh.id);
        const ib = this._skinnedIBs.get(mesh.id);
        const skinBG = this._skinBGs.get(mesh.skeleton.id);
        if (!vb || !ib || !skinBG) continue;
        pPass.setVertexBuffer(0, vb);
        pPass.setIndexBuffer(ib, 'uint32');
        const useTexture = mesh.material.hasTexture || mesh.material.hasNormalMap;
        const patterned = this._usesPatterns(mesh);
        const mk = shaderSplitActive() ? mesh._r3FK : -1;   // SHADER SPLIT: the part's key, as in the main skinned loop
        if (mk >= 0) {
          const p = this._splitPipe(mk, 'skinned', false);
          if (!p) continue;   // held (draws once it lands)
          if (p !== pPipe) { pPass.setPipeline(p); pPipe = p; }
          if (useTexture) {
            const texBG = this.createTextureBindGroup(mesh);
            if (texBG !== pBG1) { pPass.setBindGroup(1, texBG); pBG1 = texBG; }
            if (skinBG !== pBG2) { pPass.setBindGroup(2, skinBG); pBG2 = skinBG; }
          } else if (skinBG !== pBG1) { pPass.setBindGroup(1, skinBG); pBG1 = skinBG; }
        } else if (useTexture) {
          const p = patterned ? this.pipeline.skinnedOpaqueTexturedPipeline : this.pipeline.skinnedOpaqueTexturedPlainPipeline;
          if (!p) continue;   // P2: still compiling → skip
          if (p !== pPipe) { pPass.setPipeline(p); pPipe = p; }
          const texBG = this.createTextureBindGroup(mesh);
          if (texBG !== pBG1) { pPass.setBindGroup(1, texBG); pBG1 = texBG; }
          if (skinBG !== pBG2) { pPass.setBindGroup(2, skinBG); pBG2 = skinBG; }
        } else {
          const p = patterned ? this.pipeline.skinnedOpaqueUntexturedPipeline : this.pipeline.skinnedOpaqueUntexturedPlainPipeline;
          if (!p) continue;   // P2: still compiling → skip
          if (p !== pPipe) { pPass.setPipeline(p); pPipe = p; }
          if (skinBG !== pBG1) { pPass.setBindGroup(1, skinBG); pBG1 = skinBG; }
        }
        pPass.drawIndexed(mesh.geometry.indices.length, 1, 0, 0, i);
      }
      pPass.end();
      this.device.queue.submit([pEnc.finish()]);
    }

    // Every dirty skeleton's SHARED skin buffer has now uploaded (once, via _skinBufUploaded), so
    // clear each skeleton's dirty flag once (idempotent across meshes that share one). Clearing
    // earlier — inside _ensureSkinMatBuf — historically starved the 2nd+ mesh sharing a skeleton
    // (e.g. a face decal on a body) back when each mesh owned its own buffer; with the shared
    // buffer the flag must still survive the whole loop so a skeleton first seen mid-loop (its
    // buffer freshly created) uploads correctly before the flag drops here.
    // (Live parts only: a culled skeleton keeps its dirty flag, so it uploads the moment it comes back.)
    for (const m of visible) { if (m.skeleton) m.skeleton.matricesDirty = false; }
    fs.skinUploads = this._skinBufUploaded.size;
    fs.msSkinned = performance.now() - _sk0;
  }

  /** Whether the renderer culled every visible part of this skeleton last frame (out of view with a margin, no
   *  shadow into the view) — the procedural idle skips such characters (R6.1). False when unknown. */
  isSkeletonAnimCulled3D(skeletonId: string): boolean {
    return this.skinnedAnimCulling && this._skelAnimCulled.has(skeletonId);
  }

  /** R6.1: frustum-cull the skinned parts IN PLACE — `list` keeps only the LIVE parts (in view, or casting a shadow
   *  that can reach the view; all of them while a planar mirror is live), and each kept part's cache entry gets its
   *  flags (1 = main pass, 2 = shadow caster). Also rebuilds `_skelAnimCulled`. No per-frame allocation once warm. */
  private _cullSkinned(list: SkinnedMesh3D[]): void {
    const fs = this._frame;
    const animCulled = this._skelAnimCulled; animCulled.clear();
    const live = this._skelLiveScratch; live.clear();
    this._skFade.clear(); fs.skinnedFogHidden = 0;
    const on = this.skinnedCulling && this._frustumCulling;
    const shadows = this._shadowsEnabled && !this._shadowsSuspended;
    if (!on) {
      for (const m of list) { const e = this._skCull.get(m.id); if (e) e.flags = 3; }
      fs.skinnedShadow = shadows ? list.length : 0;
      fs.skelAnimCulled = 0;
      if (shadows && list.length !== this._lastSkinnedCasters) { this._skinnedShadowChanged(); this._lastSkinnedCasters = list.length; }
      return;
    }
    const culler = this._skCuller.setFromViewProjection(this.camera.getViewProjectionMatrix());
    // Shadow reach (the Round 5 test): the part's box swept along the sun down to the scene floor must touch the view.
    // Off with a planar mirror live (it shows receivers outside the view) or in the old camera-list mode.
    const reach = shadows && this._shadowLightCull && !this._planarActive;
    const ld = this._shadowDir, ll = Math.hypot(ld[0], ld[1], ld[2]) || 1, lightDir = this._lightDirN;
    lightDir[0] = ld[0] / ll; lightDir[1] = ld[1] / ll; lightDir[2] = ld[2] / ll;
    const floorY = this._sceneFloorY;
    const keepAll = this._planarActive;
    // FOG HORIZON (2026-10-01): skinned characters obey "Buildings only in fog" like the city's class-2 meshes: a part
    // whose whole box is past the fog edge x 1.01 (from the fog eye) is dropped from every pass, and while the fade
    // band is live every part dissolves in it (flags2 fade bit, _uploadSkinnedInstances; colour + shadow passes).
    // Never the active Play player, the selection or a no-fog part (_skFogExempt), so the camera cannot lose them.
    const fhS = this._fogHorizon;
    const fhSk = fhS.buildingsOnly && this.fogHorizonActive && !this._planarActive && Renderer3D.fogHorizonCpuCull && Renderer3D.skinnedFogHorizon;
    const fhC = fhSk ? fogHorizonEdge(this._fog) * 1.01 : Infinity, fhC2 = fhC * fhC;
    const fhFadeOn = fhSk && fhS.fadeM > 0;
    const skFade = this._skFade;
    let n = 0, casters = 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const skel = m.skeleton!;
      let flags = 3;
      let animLive = true;
      // Weight-paint previews (vertexColors) and the weight-paint target are never culled (editing state).
      const e = m.vertexColors || m === this._wpMesh ? null : this._skinnedCullEntry(m);
      const fogged = fhSk && !!e && e.ok && !m.material.noFog && !this._skFogExempt(m);
      if (fogged && fhFadeOn) skFade.add(m.id);
      if (fogged && this._skBoxFogDist2(e!.box, 0) > fhC2) {
        // Past the fog: not drawn, no shadow. Its idle keeps running only within a margin (half the part's size) of
        // the edge, so a character walking back in is current (as the off-view margin below).
        const b = e!.box;
        flags = 0;
        fs.skinnedCulled++; fs.skinnedFogHidden++;
        animLive = this._skBoxFogDist2(b, 0.5 * Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2])) <= fhC2;
      } else if (e && e.ok) {
        const b = e.box;
        const inView = culler.testAABB(b[0], b[1], b[2], b[3], b[4], b[5]);
        const casts = shadows && (inView || !reach || shadowReachesView(culler, lightDir, floorY, b[0], b[1], b[2], b[3], b[4], b[5]));
        flags = (inView ? 1 : 0) | (casts ? 2 : 0);
        if (!inView) {
          fs.skinnedCulled++;
          // The idle keeps running inside a margin around the view (half the part's size), so a character walking
          // or turning into view is already current — no stale-pose pop at the screen edge.
          const g = 0.5 * Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
          animLive = casts || culler.testAABB(b[0] - g, b[1] - g, b[2] - g, b[3] + g, b[4] + g, b[5] + g);
        }
      }
      if (e) e.flags = flags;
      else { const old = this._skCull.get(m.id); if (old) old.flags = 3; }
      if (animLive) live.add(skel.id); else animCulled.add(skel.id);
      if (flags & 2) casters++;
      if (flags !== 0 || keepAll) list[n++] = m;
    }
    list.length = n;
    for (const id of live) animCulled.delete(id);   // a skeleton is paused only when ALL its parts are
    fs.skinnedShadow = shadows ? casters : 0;
    fs.skelAnimCulled = animCulled.size;
    // A part entering / leaving the caster set must refresh a throttled shadow map (like the roster check above).
    if (shadows && casters !== this._lastSkinnedCasters) { this._skinnedShadowChanged(); this._lastSkinnedCasters = casters; }
  }

  /** FOG HORIZON skinned: the parts that carry the fade bit this frame (filled by _cullSkinned). */
  private readonly _skFade = new Set<string>();
  /** A/B: false = skinned characters ignore the fog horizon (the pre-2026-10-01 behaviour). */
  static skinnedFogHorizon = true;
  /** Host hook (scene3d-manager, while Play runs): true for every mesh of the active Play player. Such meshes are never
   *  fog-culled or faded, nor is the selection (_selectedMeshIds / the selected group target). */
  fogCullExempt: ((m: Mesh3D) => boolean) | null = null;
  private _skFogExempt(m: Mesh3D): boolean {
    if (this._selectedMeshIds.has(m.id) || this._selectedGroupTarget === m) return true;
    if (this._selectedMeshIds.size > 0 || this._selectedGroupTarget) {   // a selected ancestor (a character's group)
      for (let p = (m as unknown as { parent?: { id?: string; parent?: unknown } | null }).parent; p; p = p.parent as typeof p) {
        if ((p.id && this._selectedMeshIds.has(p.id)) || (p as unknown) === this._selectedGroupTarget) return true;
      }
    }
    return !!this.fogCullExempt?.(m);
  }
  /** Squared distance from the fog eye to a skinned part's box grown by `pad` on every side. */
  private _skBoxFogDist2(b: Float64Array, pad: number): number {
    const e = this._fogEye, px = e[0], py = e[1], pz = e[2];
    const dx = px < b[0] - pad ? b[0] - pad - px : px > b[3] + pad ? px - b[3] - pad : 0;
    const dy = py < b[1] - pad ? b[1] - pad - py : py > b[4] + pad ? py - b[4] - pad : 0;
    const dz = pz < b[2] - pad ? b[2] - pad - pz : pz > b[5] + pad ? pz - b[5] - pad : 0;
    return dx * dx + dy * dy + dz * dz;
  }

  /** The cull entry for a skinned part, with its world box current for this pose. Radii rebuild when the skin data
   *  changes (skinDirty / new arrays / joint count); the box rebuilds only when the pose or model matrix changed. The
   *  joint spheres (pose) are computed once per SKELETON per pose and shared by every part riding it. */
  private _skinnedCullEntry(m: SkinnedMesh3D): { ok: boolean; box: Float64Array; flags: number } {
    const skel = m.skeleton!;
    const joints = skel.data.joints;
    let sk = this._skSpheres.get(skel.id);
    let e = this._skCull.get(m.id);
    const stale = !e || m.skinDirty || e.skelId !== skel.id || e.cr.jointCount !== joints.length
      || e.verts !== m.geometry.vertices || e.ji !== m.jointIndices || e.jw !== m.jointWeights || e.bv !== m.blendVersion;   // (a morph moves the verts)
    if (stale || !sk || sk.bindPos.length !== joints.length * 3) {
      // (Re)derive the skeleton's bind positions too — a skin change may come with a rebind (new inverse binds).
      const ibs: ArrayLike<number>[] = new Array(joints.length);
      for (let j = 0; j < joints.length; j++) ibs[j] = joints[j].inverseBindMatrix;
      for (const j of joints) if (j.index >= 0 && j.index < joints.length) ibs[j.index] = j.inverseBindMatrix;
      const bindPos = computeJointBindPositions(ibs);
      if (!sk) { sk = { bindPos, poseVer: -1, spheres: new Float32Array(joints.length * 4) }; this._skSpheres.set(skel.id, sk); }
      else { sk.bindPos = bindPos; sk.poseVer = -1; }
    }
    if (stale) {
      if (m.skinDirty) this._ensureSkinnedVBIB(m);   // builds the VB once and clears skinDirty (no per-frame rebuild while culled)
      const cr = computeSkinnedCullRadii(m.geometry.vertices, 12, m.jointIndices, m.jointWeights, sk.bindPos);
      if (!e) {
        e = { cr, skelId: skel.id, verts: m.geometry.vertices, ji: m.jointIndices, jw: m.jointWeights, bv: m.blendVersion,
          poseVer: -1, matVer: -1, viaSkel: m.transformViaSkeleton, ok: false, box: new Float64Array(6), flags: 3 };
        this._skCull.set(m.id, e);
      } else {
        e.cr = cr; e.skelId = skel.id; e.verts = m.geometry.vertices; e.ji = m.jointIndices; e.jw = m.jointWeights; e.bv = m.blendVersion; e.poseVer = -1;
      }
    }
    if (sk.poseVer !== skel.poseVersion) {
      sk.spheres = computeJointSpheres(skel.skinMatrices, sk.bindPos, sk.spheres);
      sk.poseVer = skel.poseVersion;
    }
    const ent = e!;
    const viaSkel = m.transformViaSkeleton;
    if (ent.poseVer !== skel.poseVersion || ent.viaSkel !== viaSkel || (!viaSkel && ent.matVer !== m.localMatrixVersion)) {
      // 6 % pad: dual-quat skinning is not strictly a convex blend, plus the one-frame pose lag of the shadow replay.
      ent.ok = skinnedAABBFromSpheres(sk.spheres, ent.cr, viaSkel ? null : (m.localMatrix as unknown as Float32Array), 0.06, ent.box);
      ent.poseVer = skel.poseVersion; ent.matVer = m.localMatrixVersion; ent.viaSkel = viaSkel;
    }
    return ent;
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

      // patternColor (floats 48-51) + patternParams (52-55) — boardShade repurposes both (see helper)
      this._writePatternSlots(data, off, m.material);
      this._writeGroundUvScale(data, off, m);
      // FOG HORIZON (2026-10-01): a skinned part dissolves in the fade band like a class-2 city mesh (see _cullSkinned).
      // (The hair-band bit is a pure look bit, so a banded hair still fades: OR the fade in.)
      if (this._skFade.size > 0 && (data[off + FLAGS2_FLOAT_OFFSET] & ~FLAGS2_HAIR_BAND) === 0 && this._skFade.has(m.id)) data[off + FLAGS2_FLOAT_OFFSET] += FLAGS2_DISTANCE_FADE;
      if (m.faceDepthPull > 0) data[off + FLAGS2_FLOAT_OFFSET + 2] = m.faceDepthPull;   // face kit brows (flags2 bit 6; column 3 .z)
    }

    // Write only the used portion (data may be a larger reused scratch buffer).
    this.device.queue.writeBuffer(this._skinnedInstBuf!, 0, data, 0, needFloats);
  }

  /** Character v2 Phase 1.5 A/B. true = a skinned part's GPU buffers are updated IN PLACE: a blend-shape change
   *  (mesh.blendVersion moved, skinDirty clear) writeBuffers only the dirty vertex range into the existing VB and
   *  leaves the IB alone; a skinDirty rebuild re-writes the existing VB / IB when the byte size is unchanged and only
   *  creates buffers when it grew or shrank. false = the old path: every rebuild re-created both buffers, and a blend
   *  change without skinDirty was turned into a full rebuild. */
  static skinnedInPlaceUploads = true;
  /** meshId → the blendVersion its skinned VB holds / the VB and IB byte sizes (in-place reuse). */
  private readonly _skBlendVer = new Map<string, number>();
  private readonly _skVBBytes = new Map<string, number>();
  private readonly _skIBBytes = new Map<string, number>();
  /** Grow-only staging for a skinned vertex-range upload (72 B per vertex). */
  private _skStage: ArrayBuffer | null = null;
  private readonly _skRange = new Int32Array(2);
  /** Skinned VB/IB upload counters (tests, perf HUD): buffers created / full VB writes / range writes / bytes. */
  readonly skinnedUploadStats = { creates: 0, fullWrites: 0, rangeWrites: 0, bytes: 0 };

  /** Interleave vertices [lo, hi) of a skinned part into the 72-byte layout (written at vertex 0 of `buf`). */
  private _packSkinnedVerts(mesh: SkinnedMesh3D, lo: number, hi: number, buf: ArrayBuffer): void {
    const STRIDE = SKINNED_MESH3D_VERTEX_STRIDE, FPV = STRIDE / 4;  // 18 floats per vertex
    const f32 = new Float32Array(buf, 0, (hi - lo) * FPV);
    const u8  = new Uint8Array(buf, 0, (hi - lo) * STRIDE);
    const src = mesh.geometry.vertices, ji = mesh.jointIndices, jw = mesh.jointWeights;
    for (let v = lo; v < hi; v++) {
      const floatBase = (v - lo) * FPV;
      const byteBase  = (v - lo) * STRIDE;
      // Standard 12 floats: position(3) + normal(3) + uv(2) + tangent(4)
      for (let f = 0; f < 12; f++) f32[floatBase + f] = src[v * 12 + f];
      // Joint indices as uint8 at byte offset 48–51
      u8[byteBase + 48] = ji[v * 4 + 0] ?? 0;
      u8[byteBase + 49] = ji[v * 4 + 1] ?? 0;
      u8[byteBase + 50] = ji[v * 4 + 2] ?? 0;
      u8[byteBase + 51] = ji[v * 4 + 3] ?? 0;
      // Joint weights as float32 at byte offset 52 (float index floatBase + 13)
      f32[floatBase + 13] = jw[v * 4 + 0] ?? 0;
      f32[floatBase + 14] = jw[v * 4 + 1] ?? 0;
      f32[floatBase + 15] = jw[v * 4 + 2] ?? 0;
      f32[floatBase + 16] = jw[v * 4 + 3] ?? 0;
      f32[floatBase + 17] = 0;   // bytes 68–71: padding
    }
  }

  /** Build or refresh the per-mesh skinned vertex buffer (72-byte stride). */
  private _ensureSkinnedVBIB(mesh: SkinnedMesh3D): void {
    const numVerts = mesh.geometry.vertices.length / 12;
    const id = mesh.id, inPlace = Renderer3D.skinnedInPlaceUploads;
    const curVB = this._skinnedVBs.get(id);
    const STRIDE = SKINNED_MESH3D_VERTEX_STRIDE;
    if (!mesh.skinDirty && curVB) {
      const seen = this._skBlendVer.get(id);
      if (seen === undefined || seen === mesh.blendVersion) return;
      // A blend-shape change (Phase 1.5): only the vertex range it moved, into the EXISTING buffer.
      if (inPlace && this._skVBBytes.get(id) === numVerts * STRIDE) {
        const r = this._skRange;
        let lo = 0, hi = numVerts;
        if (mesh.blendRangeSince(seen, r)) { lo = Math.max(0, r[0]); hi = Math.min(numVerts, r[1]); }
        if (hi > lo) {
          const bytes = (hi - lo) * STRIDE;
          if (!this._skStage || this._skStage.byteLength < bytes) this._skStage = new ArrayBuffer(Math.max(bytes, (this._skStage?.byteLength ?? 0) * 2));
          this._packSkinnedVerts(mesh, lo, hi, this._skStage);
          this.device.queue.writeBuffer(curVB, lo * STRIDE, this._skStage, 0, bytes);
          this.skinnedUploadStats.rangeWrites++; this.skinnedUploadStats.bytes += bytes;
        }
        this._skBlendVer.set(id, mesh.blendVersion);
        return;
      }
      // (old path / size mismatch: fall through to the full rebuild)
    }

    // Build interleaved 72-byte buffer.
    const buf = new ArrayBuffer(numVerts * STRIDE);
    this._packSkinnedVerts(mesh, 0, numVerts, buf);

    if (inPlace && curVB && this._skVBBytes.get(id) === buf.byteLength) {
      this.device.queue.writeBuffer(curVB, 0, buf);
    } else {
      const vb = this.device.createBuffer({
        size:  buf.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.skinnedUploadStats.creates++;
      this.device.queue.writeBuffer(vb, 0, buf);
      curVB?.destroy();
      this._skinnedVBs.set(id, vb);
      this._skVBBytes.set(id, buf.byteLength);
    }
    this.skinnedUploadStats.fullWrites++; this.skinnedUploadStats.bytes += buf.byteLength;

    // A body-hiding mask (SkinnedMesh3D.drawIndices, same length) replaces the drawn triangles; geometry.indices otherwise.
    const di = mesh.drawIndices;
    const idxData = di && di.length === mesh.geometry.indices.length ? di : mesh.geometry.indices;
    const curIB = this._skinnedIBs.get(id);
    if (inPlace && curIB && this._skIBBytes.get(id) === idxData.byteLength) {
      this.device.queue.writeBuffer(curIB, 0, idxData.buffer, idxData.byteOffset, idxData.byteLength);
    } else {
      const ib = this.device.createBuffer({
        size:  idxData.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.skinnedUploadStats.creates++;
      this.device.queue.writeBuffer(ib, 0, idxData.buffer, idxData.byteOffset, idxData.byteLength);
      curIB?.destroy();
      this._skinnedIBs.set(id, ib);
      this._skIBBytes.set(id, idxData.byteLength);
    }
    this.skinnedUploadStats.bytes += idxData.byteLength;

    this._skBlendVer.set(id, mesh.blendVersion);
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
      this.device.queue.writeBuffer(entry.buf, 0, this._skinUploadData(skel));
      this._skinBufUploaded.add(skel.id);
    }
  }

  /** Per-skeleton scratch for the dual-quaternion-packed upload (reused every frame — no per-frame allocation). */
  private readonly _dqsScratch = new Map<string, Float32Array>();
  /** The bytes to upload for a skeleton's skin buffer: the plain matrices (linear blend), or — for a 'dualQuat'
   *  skeleton — the DQS packing the shared WGSL skinMatrixFor decodes (dual-quat-skin.ts). Falls back to the plain
   *  matrices for any frame where a joint has non-uniform scale/shear (DQS can't represent it). */
  private _skinUploadData(skel: Skeleton3D): Float32Array {
    if (skel.skinningMethod !== 'dualQuat') { this._dqsScratch.delete(skel.id); return skel.skinMatrices; }
    const scratch = this._dqsScratch.get(skel.id);
    const packed = packDualQuatSkin(skel.skinMatrices, scratch);
    if (!packed) return skel.skinMatrices;
    if (packed !== scratch) this._dqsScratch.set(skel.id, packed);
    return packed;
  }

  /** Drop one mesh's ref on a skeleton's shared skin buffer; destroy buffer + bind group when the
   *  last user is gone. */
  private _releaseSkelBuf(skelId: string): void {
    const n = (this._skelBufRefs.get(skelId) ?? 1) - 1;
    if (n > 0) { this._skelBufRefs.set(skelId, n); return; }
    this._skelBufRefs.delete(skelId);
    this._skinMatBufs.get(skelId)?.buf.destroy();
    this._skinMatBufs.delete(skelId);
    this._dqsScratch.delete(skelId);   // the dual-quat upload scratch goes with the buffer
    this._skSpheres.delete(skelId);    // R6.1 cull spheres
    this._skinBGs.delete(skelId);   // GPUBindGroup has no destroy() — GC'd when unreferenced
  }

  // ── Cleanup ────────────────────────────────────────────────────

  destroy(): void {
    this._gd?.destroy(); this._gd = null;
    this.sceneUniformBuffer.destroy();
    this.instanceStorageBuffer?.destroy();
    this._shadowTexture?.destroy();
    this._defaultWhiteTex?.destroy();
    this._defaultFlatNormalTex?.destroy();
    this._outlinePass?.destroy();
    this._geomVB?.destroy();
    this._geomIB?.destroy();
    this._geomScratch?.destroy(); this._geomScratch = null;
    this._atlasTexture?.destroy();
    this._normalAtlasTexture?.destroy();
    this._particleSceneUniBuf?.destroy();
    this._particleInstBuf?.destroy();
    this._transientInstBuf?.destroy();
    this._bloomPass?.destroy();
    this._fxaaPass?.destroy();
    this._loFiPass?.destroy();
    this._taa?.destroy(); this._taa = null;   // temporal AA history / velocity targets
    this._prefilteredCubeTex?.destroy();   // specular IBL (P1b)
    this._dummyCubeTex?.destroy();
    this._brdfLutTex?.destroy();
    this._iblGpu?.destroy(); this._iblGpu = null; this._pendingSkyBake = null;
    this._shadowStaticTex?.destroy(); this._shadowStaticTex = null;
    this._dummyWorldPosTex?.destroy();     // SSR (P2)
    this._ssaoWhiteTex?.destroy();
    this._sceneColorDefaultTex?.destroy();
    this._r3Gen++; this._geomAllocs.clear();
    this._r3Gen++; this._meshInstanceSlots.clear();
    this._atlasLayerMap.clear();
    this._normalAtlasLayerMap.clear();
    this._texBindGroupCache.clear();
    for (const e of this._meshAABBCache.values()) e.dead = true;
    this._meshAABBCache.clear();
    this._normalMatCache.clear();
    this._gizmoRenderer?.destroy();
    // Skinned mesh buffers
    this._skinnedVBs.forEach(b => b.destroy());
    this._skinnedIBs.forEach(b => b.destroy());
    this._skinnedVBs.clear(); this._skinnedIBs.clear();   // (in-place reuse must never write a destroyed buffer)
    this._skBlendVer.clear(); this._skVBBytes.clear(); this._skIBBytes.clear();
    this._skinMatBufs.forEach(e => e.buf.destroy());
    this._skinnedVCBufs.forEach(b => b.destroy());
    this._skinnedInstBuf?.destroy();
    // bug-hunt 2026-10-01: passes + targets added since destroy() was written (leaked on every viewer teardown).
    this._highlightPass?.destroy(); this._highlightPass = null;
    this._silhouettePass?.destroy(); this._silhouettePass = null;
    this._spriteOutlinePass?.destroy(); this._spriteOutlinePass = null;
    this._postProcessPass?.destroy(); this._postProcessPass = null;
    this._ssao?.destroy(); this._ssao = null;
    this._cascadeTex?.destroy(); this._cascadeTex = null;
    this._shadowMM?.destroy(); this._shadowMM = null;
    for (const b of this._cascadeSceneBufs) b.destroy();
    this._cascadeSceneBufs = [];
    this._planarTex?.destroy(); this._planarTex = null;
    this._planarDepthTex?.destroy(); this._planarDepthTex = null;
    this._garpAtlasTexture?.destroy(); this._garpAtlasTexture = null;
  }
}
