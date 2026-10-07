/**
 * Pipeline3D — WebGPU render pipelines for 3D mesh rendering.
 *
 * Self-contained 3D pipeline manager. Creates and manages:
 *  - Opaque mesh pipeline (depth write ON, depth compare LESS)
 *  - Transparent mesh pipeline (depth write OFF, depth compare LESS, alpha blend)
 *  - Untextured variant (no texture bind group)
 *
 * Uses the same depth24plus-stencil8 format as the 2D renderer
 * so both can share the same render pass when compositing 2D+3D.
 */

import {
  MESH3D_VERTEX_SHADER,
  MESH3D_FRAGMENT_SHADER,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED,
  MESH3D_VERTEX_SHADER_VERTEX_COLOR,
  MESH3D_FRAGMENT_SHADER_SHADOW_MODERN,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN,
  // §3.1 plain (pattern-stripped) fragment variants
  MESH3D_FRAGMENT_SHADER_PLAIN,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN,
  MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN_SHADOW_MODERN,
  SSR_RESOLVE_SHADER,
  SSR_POST_SHADER,
} from './shaders/mesh3d-shaders';
import {
  SHADOW_VERTEX_SHADER,
  SKINNED_SHADOW_VERTEX_SHADER,
} from './shaders/shadow-shaders';
import { SSAO_PREPASS_SHADER, SSAO_PEEL_PREPASS_SHADER } from './shaders/ssao-shaders';
import {
  SKINNED_MESH3D_VERTEX_SHADER_TEXTURED,
  SKINNED_MESH3D_VERTEX_SHADER_UNTEXTURED,
  SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT,
  SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT_UNLIT,
  SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED,
  SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED,
  SKINNED_MESH3D_FRAGMENT_SHADER_WEIGHT_PAINT,
  SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED_PLAIN,
  SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN,
} from './shaders/skinning-shaders';
import { FLOATS_PER_VERT } from './mesh-generators';
import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle, type PipelinePriority } from '../core/gpu-pipeline-cache';
import { specialiseMeshFragment, VB_TEXTURED, VB_NOCULL, VB_PATTERNED, VB_SHADOW } from './shader-variants';
import { noteTwinSource, packedTwin } from './vertex-pack';
import { MESH3D_FS_TINY } from './shaders/mesh3d-tiny-fs';
import { rdMeshFragmentCode } from './render-debug';

/** RENDER DEBUG tinyMeshFS: every mesh / skinned-mesh fragment module goes through this (unchanged when off). */
const meshFS = (code: string): string => rdMeshFragmentCode(code, MESH3D_FS_TINY);

/** Background-compile priority of the specialised shader variants (step 8): after the common set, before the rare. */
export const VARIANT_PRIORITY: PipelinePriority = PIPELINE_PRIORITY.COMMON + 0.5;

/** One specialised fragment variant (shader-variants.ts): its cache handle, request time and compile wall time. */
interface VariantEntry { h: PipelineHandle<GPURenderPipeline>; key: number; base: number; fast: boolean; t0: number; ms: number; requested: boolean }

/** Byte stride per vertex — derived from FLOATS_PER_VERT so the two stay in sync. */
export const MESH3D_VERTEX_STRIDE = FLOATS_PER_VERT * Float32Array.BYTES_PER_ELEMENT;

/**
 * Byte stride per skinned vertex.
 * Layout: position(12) + normal(12) + uv(8) + tangent(16) + joints-uint8x4(4) + weights-f32x4(16) + pad(4) = 72
 */
export const SKINNED_MESH3D_VERTEX_STRIDE = 72;

/** One GRANULARLY-compiled pipeline (docs/specs/performance-plan.md P2): an accessor over a GPUPipelineCache
 *  handle. Registered during construction (cheap — shader-module creation only, no compile). Calling it returns the
 *  pipeline, or NULL while it is still compiling asynchronously INSIDE a live frame (the caller skips that draw and
 *  the cache schedules a redraw when it lands). Outside a live frame (captures, tests) it compiles synchronously.
 *  `warmAllAsync` queues every pipeline for a background compile at idle priority. */
type PipeAccessor = (() => GPURenderPipeline | null) & { handle: PipelineHandle<GPURenderPipeline> };

/** Pipelines only an editing tool / opt-in feature uses — warmed after the common set. */
const RARE_PIPELINES = [
  'overlayTexturedPipeline', 'postOverlayTexturedPipeline', 'opaqueVertexColorPipeline',
  'skinnedWeightPaintPipeline', 'skinnedWeightPaintUnlitPipeline',
  'ssaoPrepassPipeline', 'ssaoPeelPrepassPipeline', 'ssrResolvePipeline', 'ssrHealPipeline', 'ssrFeatherPipeline',
] as const;

export class Pipeline3D {
  private device: GPUDevice;
  private swapChainFormat: GPUTextureFormat;

  // EVERY render pipeline below is a LAZY ACCESSOR: calling it compiles that ONE pipeline on first use (behind the
  // loading screen, for whatever the scene actually draws) and caches it; warmAllAsync() compiles the rest in the
  // background. Registered via _reg() during construction — see PipeEntry + docs/specs/pipeline-warmup.md.
  // Pipelines — base (no shadows)
  private _opaqueTextured!: PipeAccessor;
  private _overlayTextured!: PipeAccessor;   // always-on-top textured (depthCompare 'always') — the info card
  private _postOverlayTextured!: PipeAccessor;   // color-only clone (no depth) — drawn AFTER post-processing
  private _opaqueUntextured!: PipeAccessor;
  private _transparentTextured!: PipeAccessor;
  private _transparentUntextured!: PipeAccessor;
  private _transparentTexturedNoCull!: PipeAccessor;     // doubleSided transparent (both faces draw)
  private _transparentUntexturedNoCull!: PipeAccessor;

  // Pipelines — no back-face culling (used by preview renderers and double-sided materials)
  private _opaqueTexturedNoCull!: PipeAccessor;
  private _opaqueUntexturedNoCull!: PipeAccessor;

  // Pipeline — vertex color (EditMesh paint; two vertex buffer slots)
  private _opaqueVertexColor!: PipeAccessor;

  // Pipelines — skinned (LBS) opaque
  private _skinnedOpaqueTextured!: PipeAccessor;
  private _skinnedOpaqueUntextured!: PipeAccessor;
  private _skinnedWeightPaint!: PipeAccessor;
  private _skinnedWeightPaintUnlit!: PipeAccessor;

  // Pipelines — shadow-enabled (opaque only; transparent geometry skips shadows)
  private _opaqueTexturedShadow!: PipeAccessor;
  private _opaqueTexturedNoCullShadow!: PipeAccessor;
  private _opaqueUntexturedNoCullShadow!: PipeAccessor;
  private _opaqueUntexturedShadow!: PipeAccessor;

  // §3.1 PLAIN (pattern-stripped) opaque variants — identical to the above but with the pattern block compiled out.
  // Meshes with no pattern/window/ground/shade/normal-map (characters, plain props) route here; output is identical.
  private _opaqueTexturedPlain!: PipeAccessor;
  private _opaqueUntexturedPlain!: PipeAccessor;
  private _opaqueTexturedNoCullPlain!: PipeAccessor;
  private _opaqueUntexturedNoCullPlain!: PipeAccessor;
  private _opaqueTexturedPlainShadow!: PipeAccessor;
  private _opaqueUntexturedPlainShadow!: PipeAccessor;
  private _opaqueTexturedNoCullPlainShadow!: PipeAccessor;
  private _opaqueUntexturedNoCullPlainShadow!: PipeAccessor;
  private _skinnedOpaqueTexturedPlain!: PipeAccessor;
  private _skinnedOpaqueUntexturedPlain!: PipeAccessor;
  private _skinnedFaceMultiply!: PipeAccessor;

  // Granular lazy-pipeline registry: every _reg() call pushes one entry here. Its accessor compiles on first use;
  // warmAllAsync() compiles whichever entries are still un-compiled, off the main thread.
  private _pipeEntries: { handle: PipelineHandle<GPURenderPipeline>; priority: PipelinePriority }[] = [];
  private readonly _cache: GPUPipelineCache;
  private _warmPromise: Promise<void> | null = null;

  // Shadow pass (depth-only) pipeline
  private _shadowPassPipeline!: PipeAccessor;
  private _skinnedShadowPipeline!: PipeAccessor;
  // SSAO geometry prepass — writes world position to an rgba32float G-buffer (reuses the shadow-pass layout).
  private _ssaoPrepassPipeline!: PipeAccessor;
  // SSR depth-peel prepass — second-nearest surface (discards fragments at/in front of the front layer).
  private _ssaoPeelPrepassPipeline!: PipeAccessor;
  // Deferred SSR resolve — fullscreen half-res trace into the reflection texture (Stage 3b).
  private _ssrResolvePipeline!: PipeAccessor;
  // Reflection post passes (Stage 3b Phase B): hole/serration HEAL + perimeter edge FEATHER.
  private _ssrHealPipeline!: PipeAccessor;
  private _ssrFeatherPipeline!: PipeAccessor;

  // Bind group layouts (needed to create bind groups externally)
  private _meshBGL!: GPUBindGroupLayout;      // group 0: instances + scene
  private _textureBGL!: GPUBindGroupLayout;    // group 1: diffuse texture + sampler
  private _shadowBGL!: GPUBindGroupLayout;     // group 2: depth texture + comparison sampler
  private _pipelineLayoutTextured!: GPUPipelineLayout;
  private _pipelineLayoutUntextured!: GPUPipelineLayout;
  private _pipelineLayoutShadowTextured!: GPUPipelineLayout;
  private _pipelineLayoutShadowUntextured!: GPUPipelineLayout;
  private _pipelineLayoutShadowPass!: GPUPipelineLayout;
  private _skinBGL!: GPUBindGroupLayout;               // group N: skinMatrices storage buffer
  private _weightPaintBGL!: GPUBindGroupLayout;        // group N: per-vertex heat colors storage buffer
  private _pipelineLayoutSkinnedTextured!: GPUPipelineLayout;   // [mesh, texture, skin]
  private _pipelineLayoutSkinnedUntextured!: GPUPipelineLayout; // [mesh, skin]
  private _pipelineLayoutSkinnedWeightPaint!: GPUPipelineLayout; // [mesh, skin, weightPaint]

  // Reusable samplers for textures
  private _nearestSampler!: GPUSampler;  // PS1 = nearest-neighbor
  private _linearSampler!: GPUSampler;   // bilinear filtering
  private _filterMode: 'nearest' | 'linear' = 'nearest';
  private _shadowSampler!: GPUSampler;   // comparison sampler for PCF shadow lookup

  constructor(device: GPUDevice, swapChainFormat: GPUTextureFormat = 'bgra8unorm') {
    this.device = device;
    this.swapChainFormat = swapChainFormat;
    this._cache = GPUPipelineCache.for(device);
    this.createLayouts();
    // createPipelines() only REGISTERS pipelines (via _reg) — it builds shader modules + descriptors but compiles
    // nothing. Each pipeline compiles lazily on first getter access, or in bulk via warmAllAsync().
    this.createPipelines();
    // Background-warm order: tools / debug / niche feature variants drain last (docs/specs/performance-plan.md P2.2).
    for (const n of RARE_PIPELINES) { const h = this.handleOf(n); const e = h && this._pipeEntries.find(x => x.handle === h); if (e) e.priority = PIPELINE_PRIORITY.RARE; }
    this._nearestSampler = device.createSampler({
      magFilter: 'nearest',    // PS1: no bilinear filtering
      minFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    this._linearSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
  }

  // ── Public getters ─────────────────────────────────────────────

  // Each getter calls its lazy accessor: the FIRST access compiles just that one pipeline (the fallback if the
  // async warm hasn't reached it yet) and caches it — so a draw only pays for what it actually uses.
  get opaqueTexturedPipeline(): GPURenderPipeline | null { return this._opaqueTextured(); }
  get overlayTexturedPipeline(): GPURenderPipeline | null { return this._overlayTextured(); }
  get postOverlayTexturedPipeline(): GPURenderPipeline | null { return this._postOverlayTextured(); }
  get opaqueUntexturedPipeline(): GPURenderPipeline | null { return this._opaqueUntextured(); }
  get transparentTexturedPipeline(): GPURenderPipeline | null { return this._transparentTextured(); }
  get transparentUntexturedPipeline(): GPURenderPipeline | null { return this._transparentUntextured(); }
  get transparentTexturedNoCullPipeline(): GPURenderPipeline | null { return this._transparentTexturedNoCull(); }
  get transparentUntexturedNoCullPipeline(): GPURenderPipeline | null { return this._transparentUntexturedNoCull(); }
  get opaqueTexturedNoCullPipeline(): GPURenderPipeline | null { return this._opaqueTexturedNoCull(); }
  get opaqueUntexturedNoCullPipeline(): GPURenderPipeline | null { return this._opaqueUntexturedNoCull(); }

  get opaqueTexturedShadowPipeline(): GPURenderPipeline | null { return this._opaqueTexturedShadow(); }
  get opaqueTexturedNoCullShadowPipeline(): GPURenderPipeline | null { return this._opaqueTexturedNoCullShadow(); }
  get opaqueUntexturedNoCullShadowPipeline(): GPURenderPipeline | null { return this._opaqueUntexturedNoCullShadow(); }
  get opaqueUntexturedShadowPipeline(): GPURenderPipeline | null { return this._opaqueUntexturedShadow(); }
  get opaqueTexturedPlainPipeline(): GPURenderPipeline | null { return this._opaqueTexturedPlain(); }
  get opaqueUntexturedPlainPipeline(): GPURenderPipeline | null { return this._opaqueUntexturedPlain(); }
  get opaqueTexturedNoCullPlainPipeline(): GPURenderPipeline | null { return this._opaqueTexturedNoCullPlain(); }
  get opaqueUntexturedNoCullPlainPipeline(): GPURenderPipeline | null { return this._opaqueUntexturedNoCullPlain(); }
  get opaqueTexturedPlainShadowPipeline(): GPURenderPipeline | null { return this._opaqueTexturedPlainShadow(); }
  get opaqueUntexturedPlainShadowPipeline(): GPURenderPipeline | null { return this._opaqueUntexturedPlainShadow(); }
  get opaqueTexturedNoCullPlainShadowPipeline(): GPURenderPipeline | null { return this._opaqueTexturedNoCullPlainShadow(); }
  get opaqueUntexturedNoCullPlainShadowPipeline(): GPURenderPipeline | null { return this._opaqueUntexturedNoCullPlainShadow(); }
  get skinnedOpaqueTexturedPlainPipeline(): GPURenderPipeline | null { return this._skinnedOpaqueTexturedPlain(); }
  get skinnedOpaqueUntexturedPlainPipeline(): GPURenderPipeline | null { return this._skinnedOpaqueUntexturedPlain(); }
  /** Face-kit overlays: skinned textured, MULTIPLY blend, no depth write (Renderer3D.drawSkinnedMeshes). */
  get skinnedFaceMultiplyPipeline(): GPURenderPipeline | null { return this._skinnedFaceMultiply(); }
  get shadowPassPipeline(): GPURenderPipeline | null { return this._shadowPassPipeline(); }
  get skinnedShadowPipeline(): GPURenderPipeline | null { return this._skinnedShadowPipeline(); }
  get ssaoPrepassPipeline(): GPURenderPipeline | null { return this._ssaoPrepassPipeline(); }
  get ssaoPeelPrepassPipeline(): GPURenderPipeline | null { return this._ssaoPeelPrepassPipeline(); }
  get ssrResolvePipeline(): GPURenderPipeline | null { return this._ssrResolvePipeline(); }
  get ssrHealPipeline(): GPURenderPipeline | null { return this._ssrHealPipeline(); }
  get ssrFeatherPipeline(): GPURenderPipeline | null { return this._ssrFeatherPipeline(); }

  get skinnedOpaqueTexturedPipeline(): GPURenderPipeline | null { return this._skinnedOpaqueTextured(); }
  get skinnedOpaqueUntexturedPipeline(): GPURenderPipeline | null { return this._skinnedOpaqueUntextured(); }
  get skinnedWeightPaintPipeline(): GPURenderPipeline | null { return this._skinnedWeightPaint(); }
  get skinnedWeightPaintUnlitPipeline(): GPURenderPipeline | null { return this._skinnedWeightPaintUnlit(); }
  get opaqueVertexColorPipeline(): GPURenderPipeline | null { return this._opaqueVertexColor(); }
  get weightPaintBindGroupLayout(): GPUBindGroupLayout { return this._weightPaintBGL; }

  // ── Step 8: specialised fragment variants (shader-variants.ts; performance-plan §P21) ──────────────────────────
  // The descriptor pieces every opaque mesh pipeline shares (kept from createPipelines for the variant factories).
  private _vsModule!: GPUShaderModule;
  private _vbLayout!: GPUVertexBufferLayout;
  private _opaqueTarget!: GPUColorTargetState;
  private _opaqueDS!: GPUDepthStencilState;
  private readonly _variants = new Map<number, (VariantEntry | undefined)[]>();
  private readonly _variantList: VariantEntry[] = [];

  /** The specialised variant of opaque base `base` (VB_* bits) for material flags `key`, or NULL while it is not
   *  compiled. A miss queues a background compile (VARIANT_PRIORITY) and NEVER blocks or marks a draw as waiting: the
   *  caller draws with the base (uber-shader) pipeline meanwhile, which renders the same pixels. */
  variantPipeline(base: number, key: number, fastPaths: boolean): GPURenderPipeline | null {
    let row = this._variants.get(key);
    if (!row) { row = []; this._variants.set(key, row); }
    const slot = (base & 15) * 2 + (fastPaths ? 1 : 0);
    let e = row[slot];
    if (!e) {
      const tex = (base & VB_TEXTURED) !== 0, nc = (base & VB_NOCULL) !== 0, pat = (base & VB_PATTERNED) !== 0, sh = (base & VB_SHADOW) !== 0;
      const src = tex
        ? (pat ? (sh ? MESH3D_FRAGMENT_SHADER_SHADOW_MODERN : MESH3D_FRAGMENT_SHADER) : (sh ? MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN : MESH3D_FRAGMENT_SHADER_PLAIN))
        : (pat ? (sh ? MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN : MESH3D_FRAGMENT_SHADER_UNTEXTURED) : (sh ? MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN_SHADOW_MODERN : MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN));
      const layout = tex ? (sh ? this._pipelineLayoutShadowTextured : this._pipelineLayoutTextured) : (sh ? this._pipelineLayoutShadowUntextured : this._pipelineLayoutUntextured);
      const label = `MeshVariant:${key >>> 0}:${base}${fastPaths ? 'f' : ''}`;
      const desc = (): GPURenderPipelineDescriptor => ({
        label, layout,
        vertex: { module: this._vsModule, entryPoint: 'vs_main', buffers: [this._vbLayout] },
        fragment: { module: this.device.createShaderModule({ code: meshFS(specialiseMeshFragment(src, key, fastPaths)), label }), entryPoint: 'fs_main', targets: [this._opaqueTarget] },
        primitive: { topology: 'triangle-list', cullMode: nc ? 'none' : 'back', frontFace: 'ccw' },
        depthStencil: this._opaqueDS,
      });
      e = { h: this._cache.render(desc, label), key: key >>> 0, base, fast: fastPaths, t0: 0, ms: -1, requested: false };
      row[slot] = e; this._variantList.push(e);
    }
    if (e.h.ready) { const p = e.h.get(); if (p) noteTwinSource(p, e.h.descriptor()); return p; }   // (P22: twin-able)
    if (!e.requested && !e.h.failed) {
      e.requested = true; e.t0 = performance.now();
      const ent = e;
      void e.h.warm(VARIANT_PRIORITY).then((p) => { if (p) ent.ms = performance.now() - ent.t0; });
    }
    return null;
  }

  /** Step 8 diagnostics: every variant registered so far (key, base, compiled, wall ms from request to ready). */
  variantStats(): { registered: number; ready: number; pending: number; failed: number; list: { key: number; base: number; fast: boolean; ready: boolean; ms: number }[] } {
    let ready = 0, pending = 0, failed = 0;
    const list = this._variantList.map((e) => {
      if (e.h.ready) ready++; else if (e.h.failed) failed++; else if (e.requested) pending++;
      return { key: e.key, base: e.base, fast: e.fast, ready: e.h.ready, ms: Math.round(e.ms) };
    });
    return { registered: this._variantList.length, ready, pending, failed, list };
  }

  get meshBindGroupLayout(): GPUBindGroupLayout { return this._meshBGL; }
  get textureBindGroupLayout(): GPUBindGroupLayout { return this._textureBGL; }
  get shadowBindGroupLayout(): GPUBindGroupLayout { return this._shadowBGL; }
  get skinBindGroupLayout(): GPUBindGroupLayout { return this._skinBGL; }
  get nearestSampler(): GPUSampler { return this._nearestSampler; }
  get activeSampler(): GPUSampler { return this._filterMode === 'linear' ? this._linearSampler : this._nearestSampler; }
  get shadowSampler(): GPUSampler { return this._shadowSampler; }
  get filterMode(): 'nearest' | 'linear' { return this._filterMode; }

  setFilterMode(mode: 'nearest' | 'linear'): void { this._filterMode = mode; }

  // ── Layout creation ────────────────────────────────────────────

  private createLayouts(): void {
    // Group 0: per-mesh instances (storage) + scene uniforms (uniform) + IBL (uniform)
    this._meshBGL = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },  // MeshInstance[]
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },             // SceneUniforms
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },             // IBLUniforms (SH + enabled flag)
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },  // SSAO AO buffer (1×1 white when SSAO off → no-op)
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },          // SSAO sampler (linear clamp)
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },  // scene color (prev frame) for glass refraction; 1×1 when off
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },          // scene-color sampler
        },
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: 'cube' },  // prefiltered specular env cube (1×1×6 dummy when off)
        },
        {
          binding: 8,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },          // IBL cube + LUT sampler (linear, mip-linear, clamp)
        },
        {
          binding: 9,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },    // split-sum BRDF LUT (always valid, baked once)
        },
        {
          binding: 10,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },  // SSR world-position prepass (rgba32float, textureLoad); 1×1 dummy when off
        },
        {
          binding: 11,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },  // SSR depth-peel BACK layer (second-nearest surface); 1×1 dummy when off
        },
        {
          binding: 12,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },  // prepass NORMAL+material target (rgba16float) — deferred SSR resolve input; 1×1 dummy when off
        },
        {
          binding: 13,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },  // deferred SSR REFLECTION texture (colour+fade, half-res) — sampled by the mesh FS; 1×1 dummy when off
        },
        {
          binding: 14,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },  // P4b PLANAR mirror pass result (full-res) — sampled by flagged reflector meshes; 1×1 dummy when off
        },
      ],
    });

    // Group 1: diffuse texture_2d_array + sampler + normal map texture_2d_array + sampler + GARP atlas.
    // All textured draws — both the shared atlas and standalone 1-layer wrappers — use
    // this same layout. Bindings 2/3 use a flat-normal 1×1 default when no normal map is set.
    // Binding 4 = the DEDICATED GARP pool atlas (docs/specs/city-props-garp.md §2): a mesh with the GARP_TEX
    // material flag samples it (via the diffuse sampler) instead of binding 0. Bound on EVERY textured draw
    // (the shader samples it unconditionally, then select()s), so it's never unbound — a 1×1 default when no
    // pool has loaded. No new sampler: it reuses binding 1 (activeSampler), same filtering + rgba8unorm.
    this._textureBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      ],
    });

    this._pipelineLayoutTextured = this.device.createPipelineLayout({
      bindGroupLayouts: [this._meshBGL, this._textureBGL],
    });

    this._pipelineLayoutUntextured = this.device.createPipelineLayout({
      bindGroupLayouts: [this._meshBGL],
    });

    // Group 2: shadow map (depth texture) + PCF comparison sampler
    this._shadowBGL = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'comparison' },
        },
        // persona-polish A2: the NEAR shadow cascades (depth array; a 1-layer dummy when cascades are off).
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d-array' },
        },
        // P6 (performance-plan.md): min/max depth tiles of the far map (3) and the cascades (4) + their params (5) —
        // the exact fully-lit / fully-shadowed PCF shortcut (shadow-minmax.ts).
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    // Textured shadow: [mesh(0), texture(1), shadow(2)]
    this._pipelineLayoutShadowTextured = this.device.createPipelineLayout({
      bindGroupLayouts: [this._meshBGL, this._textureBGL, this._shadowBGL],
    });

    // Untextured shadow: [mesh(0), shadow(1)] — shadow occupies group 1, not 2,
    // because WebGPU forbids gaps in bind group indices and there is no texture group here.
    this._pipelineLayoutShadowUntextured = this.device.createPipelineLayout({
      bindGroupLayouts: [this._meshBGL, this._shadowBGL],
    });

    this._pipelineLayoutShadowPass = this.device.createPipelineLayout({
      bindGroupLayouts: [this._meshBGL],
    });

    // Group N: skin matrices (array<mat4x4f> storage buffer)
    this._skinBGL = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },  // skinMatrices[]
        },
      ],
    });

    // Group N: per-vertex heat colors (array<vec4f> storage buffer) for weight paint
    this._weightPaintBGL = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },  // vertexColors[]
        },
      ],
    });

    // Skinned textured:      [mesh(0), texture(1), skin(2)]
    this._pipelineLayoutSkinnedTextured = this.device.createPipelineLayout({
      bindGroupLayouts: [this._meshBGL, this._textureBGL, this._skinBGL],
    });

    // Skinned untextured:    [mesh(0), skin(1)]
    this._pipelineLayoutSkinnedUntextured = this.device.createPipelineLayout({
      bindGroupLayouts: [this._meshBGL, this._skinBGL],
    });

    // Skinned weight paint:  [mesh(0), skin(1), weightPaint(2)]
    this._pipelineLayoutSkinnedWeightPaint = this.device.createPipelineLayout({
      bindGroupLayouts: [this._meshBGL, this._skinBGL, this._weightPaintBGL],
    });
  }

  // ── Pipeline creation ──────────────────────────────────────────

  /** Register a pipeline for GRANULAR lazy, NON-BLOCKING compilation and return its accessor (see PipeAccessor).
   *  `priority` orders the background warm (COMMON = every 3D scene soon needs it; RARE = tools / debug / niche). */
  private _reg(descriptor: GPURenderPipelineDescriptor, priority: PipelinePriority = PIPELINE_PRIORITY.COMMON): PipeAccessor {
    const h = this._cache.render(descriptor, descriptor.label ?? `Pipeline3D#${this._pipeEntries.length + 1}`);
    this._pipeEntries.push({ handle: h, priority });
    // P22: the compiled pipeline is noted with its descriptor, so the renderer can ask for its packed twin (vertex-pack.ts)
    let noted: GPURenderPipeline | null = null;
    const acc = (() => { const p = h.get(); if (p !== null && p !== noted) { noteTwinSource(p, descriptor); noted = p; } return p; }) as PipeAccessor;
    acc.handle = h;
    return acc;
  }

  /** P22: start compiling the packed twin of every compiled pool pipeline (the base set and the shader variants), so
   *  the renderer can store geometry packed once they are ready (Renderer3D._pkPackOk). */
  requestPackedTwins(): void {
    for (const e of this._pipeEntries) {
      const p = e.handle.ready ? e.handle.get() : null;
      if (p) { noteTwinSource(p, e.handle.descriptor()); packedTwin(this.device, p); }
    }
    for (const v of this._variantList) {
      const p = v.h.ready ? v.h.get() : null;
      if (p) { noteTwinSource(p, v.h.descriptor()); packedTwin(this.device, p); }
    }
  }

  /** The cache handle behind a public getter name (e.g. 'opaqueTexturedPlainShadowPipeline'), or null. */
  handleOf(getterName: string): PipelineHandle<GPURenderPipeline> | null {
    const base = getterName.replace(/Pipeline$/, '');
    const self = this as unknown as Record<string, PipeAccessor | undefined>;
    return (self['_' + base] ?? self['_' + base + 'Pipeline'])?.handle ?? null;
  }

  /** Queue the named pipelines (public getter names) for a background compile at `priority` — e.g. the variants a
   *  just-loaded document will draw (Renderer3D.prewarmForScene). Unknown names are ignored. */
  warmPipelines(getterNames: readonly string[], priority: PipelinePriority = PIPELINE_PRIORITY.DOCUMENT): void {
    for (const n of getterNames) this.handleOf(n)?.warm(priority);
  }

  /** Queue EVERY not-yet-compiled pipeline for a background (createRenderPipelineAsync) compile, drained at idle in
   *  priority order with a small concurrency cap (GPUPipelineCache) so a pipeline a draw is waiting on is never
   *  stuck behind the warm. Idempotent + memoized; resolves when all have settled; never rejects. */
  async warmAllAsync(): Promise<void> {
    return this._warmPromise ??= (async () => {
      const pending = this._pipeEntries.filter(e => !e.handle.ready);
      const t0 = performance.now();
      console.log(`[Salsa][warm] warming ${pending.length} pipelines in background (${this._pipeEntries.length - pending.length} already compiled)…`);
      try {
        await Promise.all(pending.map(e => e.handle.warm(e.priority)));
        console.log(`[Salsa][warm] pipeline warm complete: ${pending.length} compiled in ${Math.round(performance.now() - t0)}ms`);
      } catch (err) { console.warn('[Salsa][warm] pipeline warm failed', err); }
    })();
  }

  private createPipelines(): void {
    const vertexModule          = this.device.createShaderModule({ code: MESH3D_VERTEX_SHADER });
    const fragTexturedModule    = this.device.createShaderModule({ code: meshFS(MESH3D_FRAGMENT_SHADER) });
    const fragUntexturedModule  = this.device.createShaderModule({ code: meshFS(MESH3D_FRAGMENT_SHADER_UNTEXTURED) });
    const shadowPassVertModule  = this.device.createShaderModule({ code: SHADOW_VERTEX_SHADER });
    // Shadow-RECEIVING pipelines use the MODERN fragment shaders (patterns/interiors/relief/point lights/PBR)
    // with shadow sampling substituted in — the legacy gouraud shadow FS predates the whole pattern system and
    // silently downgraded anything that received shadows. The modern VS pairs with them (lightSpacePos is
    // computed in-fragment from worldPos, so no dedicated shadow VS is needed).
    const shadowFragTexModule   = this.device.createShaderModule({ code: meshFS(MESH3D_FRAGMENT_SHADER_SHADOW_MODERN) });
    const shadowFragUntexModule = this.device.createShaderModule({ code: meshFS(MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN) });

    // 3D vertex buffer layout: position(vec3) + normal(vec3) + uv(vec2) + tangent(vec4)
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: MESH3D_VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0,  format: 'float32x3' },  // position
        { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
        { shaderLocation: 2, offset: 24, format: 'float32x2' },  // uv
        { shaderLocation: 3, offset: 32, format: 'float32x4' },  // tangent
      ],
    };

    const opaqueDepthStencil: GPUDepthStencilState = {
      format: 'depth24plus-stencil8',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };

    const transparentDepthStencil: GPUDepthStencilState = {
      format: 'depth24plus-stencil8',
      depthWriteEnabled: false,   // no depth writes for transparent geometry
      depthCompare: 'less',
    };

    const opaqueBlend: GPUColorTargetState = {
      format: this.swapChainFormat,
      // No blending for opaque
    };
    // step 8: the shared pieces of the specialised variants (variantPipeline)
    this._vsModule = vertexModule; this._vbLayout = vertexBufferLayout; this._opaqueTarget = opaqueBlend; this._opaqueDS = opaqueDepthStencil;

    const transparentBlend: GPUColorTargetState = {
      format: this.swapChainFormat,
      blend: {
        color: {
          srcFactor: 'src-alpha',
          dstFactor: 'one-minus-src-alpha',
          operation: 'add',
        },
        alpha: {
          srcFactor: 'one',
          dstFactor: 'one-minus-src-alpha',
          operation: 'add',
        },
      },
    };

    // Opaque + Textured
    this._opaqueTextured = this._reg({
      layout: this._pipelineLayoutTextured,
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: fragTexturedModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: opaqueDepthStencil,
    });

    // Always-on-top textured (the landmark info card): depthCompare 'always' → never occluded; no depth write;
    // both faces (a billboard quad); alpha-blended. Same textured shader/layout as opaque.
    this._overlayTextured = this._reg({
      label: 'OverlayTexturedPipeline',
      layout: this._pipelineLayoutTextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: fragTexturedModule, entryPoint: 'fs_main', targets: [transparentBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
    });

    // POST-PROCESS-IMMUNE overlay: drawn in a standalone pass onto the FINAL (already post-processed) swapchain
    // image, so the info card bypasses bloom / colour-grade / vignette entirely. It has a depth buffer (the scene
    // depth texture, CLEARED at pass start so nothing occludes the card) with depth test+write ON, so a 3D EXTRUDED
    // card self-occludes correctly — only the camera-facing face shows while it spins. cullMode 'none' (both faces
    // considered; depth picks the nearest). A flat 2D card is a single layer and unaffected.
    this._postOverlayTextured = this._reg({
      label: 'PostOverlayTexturedPipeline',
      layout: this._pipelineLayoutTextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: fragTexturedModule, entryPoint: 'fs_main', targets: [transparentBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less' },
    });

    // Opaque + Untextured
    this._opaqueUntextured = this._reg({
      layout: this._pipelineLayoutUntextured,
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: fragUntexturedModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: opaqueDepthStencil,
    });

    // Transparent + Textured
    this._transparentTextured = this._reg({
      layout: this._pipelineLayoutTextured,
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: fragTexturedModule,
        entryPoint: 'fs_main',
        targets: [transparentBlend],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: transparentDepthStencil,
    });

    // Transparent + Untextured
    this._transparentUntextured = this._reg({
      layout: this._pipelineLayoutUntextured,
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: fragUntexturedModule,
        entryPoint: 'fs_main',
        targets: [transparentBlend],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: transparentDepthStencil,
    });

    // Transparent DOUBLE-SIDED variants (cullMode 'none') — so both faces of a transparent doubleSided mesh draw.
    // Without these a transparent doubleSided panel (the CD jewel-case lid) had its back-facing triangles culled, so
    // the far side of the open clear lid rendered nothing. Same states as the single-sided transparent pipelines.
    this._transparentTexturedNoCull = this._reg({
      label: 'TransparentTexturedNoCullPipeline',
      layout: this._pipelineLayoutTextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: fragTexturedModule, entryPoint: 'fs_main', targets: [transparentBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: transparentDepthStencil,
    });
    this._transparentUntexturedNoCull = this._reg({
      label: 'TransparentUntexturedNoCullPipeline',
      layout: this._pipelineLayoutUntextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: fragUntexturedModule, entryPoint: 'fs_main', targets: [transparentBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: transparentDepthStencil,
    });

    // ── Shadow pass: depth-only pipeline ──────────────────────────
    this._shadowPassPipeline = this._reg({
      layout: this._pipelineLayoutShadowPass,
      vertex: {
        module: shadowPassVertModule,
        entryPoint: 'vs_shadow',
        buffers: [vertexBufferLayout],
      },
      // Depth-only (no colour targets); the FS exists only to DISCARD outside a leaf card's silhouette (bit 13),
      // so foliage cards cast leaf-shaped shadows instead of squares. It is a no-op for every other mesh.
      fragment: { module: shadowPassVertModule, entryPoint: 'fs_shadow', targets: [] },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'front',   // front-face cull for Peter-Pan bias compensation
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // ── SSAO geometry prepass: world-position G-buffer (rgba32float) ──
    // Reuses the shadow-pass pipeline layout (group 0 = instances + scene uniforms, no textures) and the
    // shared mesh vertex layout; VS transforms by the CAMERA viewProjection, FS writes world position.
    // SSAO is OFF by default, so this pipeline is usually never used → it's registered like the rest and only
    // compiles if the SSAO getter is hit (or the background warm reaches it).
    const ssaoPrepassModule = this.device.createShaderModule({ code: SSAO_PREPASS_SHADER, label: 'SSAOPrepass' });
    this._ssaoPrepassPipeline = this._reg({
      label: 'SSAOPrepassPipeline',
      layout: this._pipelineLayoutShadowPass,
      vertex:   { module: ssaoPrepassModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      // MRT: world position + (normal, SSR material code) — the second target feeds the deferred SSR resolve.
      fragment: { module: ssaoPrepassModule, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }, { format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    // ── SSR depth-peel prepass: SECOND-nearest surface (backface-fill volume test) ──
    // Same layout + vertex path as the SSAO prepass; the FS reads the FRONT layer at binding 10 (the peel's own
    // bind group binds it REAL — it writes a different target, so no read/write alias) and discards everything
    // at-or-in-front of it. Registered like the rest — compiles on first use.
    const ssaoPeelModule = this.device.createShaderModule({ code: SSAO_PEEL_PREPASS_SHADER, label: 'SSRPeelPrepass' });
    this._ssaoPeelPrepassPipeline = this._reg({
      label: 'SSRPeelPrepassPipeline',
      layout: this._pipelineLayoutShadowPass,
      vertex:   { module: ssaoPeelModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: ssaoPeelModule, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    // ── Deferred SSR resolve (Stage 3b): fullscreen half-res trace → reflection texture ──
    // Reuses the mesh group-0 layout (the resolve bind group provides world-pos/back/normal real + dummies).
    const ssrResolveModule = this.device.createShaderModule({ code: SSR_RESOLVE_SHADER, label: 'SSRResolve' });
    this._ssrResolvePipeline = this._reg({
      label: 'SSRResolvePipeline',
      layout: this._pipelineLayoutShadowPass,
      vertex:   { module: ssrResolveModule, entryPoint: 'vs_main' },
      fragment: { module: ssrResolveModule, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });

    // ── Reflection post passes (Phase B): heal (A→B) + perimeter feather (B→A) ──
    const ssrPostModule = this.device.createShaderModule({ code: SSR_POST_SHADER, label: 'SSRPost' });
    this._ssrHealPipeline = this._reg({
      label: 'SSRHealPipeline',
      layout: this._pipelineLayoutShadowPass,
      vertex:   { module: ssrPostModule, entryPoint: 'vs_main' },
      fragment: { module: ssrPostModule, entryPoint: 'fs_heal', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    this._ssrFeatherPipeline = this._reg({
      label: 'SSRFeatherPipeline',
      layout: this._pipelineLayoutShadowPass,
      vertex:   { module: ssrPostModule, entryPoint: 'vs_main' },
      fragment: { module: ssrPostModule, entryPoint: 'fs_feather', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });

    // ── Shadow-enabled opaque pipelines (group 2 = shadow BGL) ───

    // Untextured shadow: layout = [meshBGL, shadowBGL] — modern VS + modern shadow-receiving FS.
    this._opaqueUntexturedShadow = this._reg({
      layout: this._pipelineLayoutShadowUntextured,
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: shadowFragUntexModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // Textured shadow: layout = [meshBGL, textureBGL, shadowBGL] — modern VS + modern shadow-receiving FS.
    this._opaqueTexturedShadow = this._reg({
      layout: this._pipelineLayoutShadowTextured,
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: shadowFragTexModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // NoCull (double-sided) shadow variants — the WORLD CITY meshes are double-sided, and before these
    // existed they silently fell back to the no-shadow pipelines (the city never RECEIVED its own shadows).
    this._opaqueTexturedNoCullShadow = this._reg({
      layout: this._pipelineLayoutShadowTextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: shadowFragTexModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });
    this._opaqueUntexturedNoCullShadow = this._reg({
      layout: this._pipelineLayoutShadowUntextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: shadowFragUntexModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // Opaque + Textured, no back-face cull (preview / double-sided materials)
    this._opaqueTexturedNoCull = this._reg({
      layout: this._pipelineLayoutTextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: fragTexturedModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // Opaque + Untextured, no back-face cull
    this._opaqueUntexturedNoCull = this._reg({
      layout: this._pipelineLayoutUntextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: fragUntexturedModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // Comparison sampler for PCF shadow lookups
    this._shadowSampler = this.device.createSampler({
      compare: 'less',
      minFilter: 'linear',
      magFilter: 'linear',
    });

    // ── Vertex color pipeline — EditMesh paint ───────────────────
    // Two vertex buffer slots: slot 0 = standard geometry, slot 1 = per-vertex rgba (16 bytes).
    // Uses the untextured layout [meshBGL] — no texture group needed.
    // EditMesh output is un-indexed with standalone VB override (baseVertex=0) so
    // slot-1 color index aligns with slot-0 vertex index directly.
    const vcVertexModule = this.device.createShaderModule({ code: MESH3D_VERTEX_SHADER_VERTEX_COLOR });
    const vcVertexBufferLayouts: GPUVertexBufferLayout[] = [
      vertexBufferLayout,
      {
        arrayStride: 16,  // vec4<f32> = 4 × 4 bytes
        attributes: [
          { shaderLocation: 4, offset: 0, format: 'float32x4' },
        ],
      },
    ];
    this._opaqueVertexColor = this._reg({
      layout: this._pipelineLayoutUntextured,
      vertex: {
        module: vcVertexModule,
        entryPoint: 'vs_main',
        buffers: vcVertexBufferLayouts,
      },
      fragment: {
        module: fragUntexturedModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // ── Skinned mesh pipelines ────────────────────────────────────

    const skinnedVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: SKINNED_MESH3D_VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset:  0, format: 'float32x3' },  // position
        { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
        { shaderLocation: 2, offset: 24, format: 'float32x2' },  // uv
        { shaderLocation: 3, offset: 32, format: 'float32x4' },  // tangent
        { shaderLocation: 4, offset: 48, format: 'uint8x4' },    // jointIndices
        { shaderLocation: 5, offset: 52, format: 'float32x4' },  // jointWeights
      ],
    };

    const skinnedTexVertModule   = this.device.createShaderModule({ code: SKINNED_MESH3D_VERTEX_SHADER_TEXTURED });
    const skinnedUntexVertModule = this.device.createShaderModule({ code: SKINNED_MESH3D_VERTEX_SHADER_UNTEXTURED });
    const skinnedTexFragModule   = this.device.createShaderModule({ code: meshFS(SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED) });
    const skinnedUntexFragModule = this.device.createShaderModule({ code: meshFS(SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED) });

    // Skinned opaque + textured — layout: [mesh(0), texture(1), skin(2)]
    this._skinnedOpaqueTextured = this._reg({
      layout: this._pipelineLayoutSkinnedTextured,
      vertex: {
        module: skinnedTexVertModule,
        entryPoint: 'vs_main',
        buffers: [skinnedVertexBufferLayout],
      },
      fragment: {
        module: skinnedTexFragModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      // Double-sided: procedural/imported skinned meshes can have inconsistent winding; cull-none
      // avoids culling their front faces. Visually identical to cull-back for closed meshes.
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // Skinned opaque + untextured — layout: [mesh(0), skin(1)]
    this._skinnedOpaqueUntextured = this._reg({
      layout: this._pipelineLayoutSkinnedUntextured,
      vertex: {
        module: skinnedUntexVertModule,
        entryPoint: 'vs_main',
        buffers: [skinnedVertexBufferLayout],
      },
      fragment: {
        module: skinnedUntexFragModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      // Double-sided (see skinnedOpaqueTextured) — robust against inconsistent winding.
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // ── Skinned SHADOW pass (E1 tail c): depth-only, skin-deformed — characters cast shadows. ──
    // cullMode 'none' (like all skinned pipelines — hair cards / skirts are single-sided shells, and
    // the front-cull Peter-Pan trick would hollow them out); the zoom-adaptive bias handles acne.
    const skinnedShadowVertModule = this.device.createShaderModule({ code: SKINNED_SHADOW_VERTEX_SHADER, label: 'SkinnedShadowVS' });
    this._skinnedShadowPipeline = this._reg({
      layout: this._pipelineLayoutSkinnedUntextured,
      vertex: { module: skinnedShadowVertModule, entryPoint: 'vs_shadow', buffers: [skinnedVertexBufferLayout] },
      // fog horizon (2026-10-01): a depth-only FS that dissolves fading characters in the fade band (no colour targets)
      fragment: { module: skinnedShadowVertModule, entryPoint: 'fs_skshadow', targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });

    // Skinned weight paint (lit + unlit) — layout: [mesh(0), skin(1), weightPaint(2)]. Used ONLY inside the
    // weight-paint editing tool, so these compile only if that tool's getter is hit (or the warm reaches them).
    const skinnedWPVertModule = this.device.createShaderModule({ code: SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT });
    const skinnedWPFragModule = this.device.createShaderModule({ code: SKINNED_MESH3D_FRAGMENT_SHADER_WEIGHT_PAINT });
    const skinnedWPUnlitVertModule = this.device.createShaderModule({ code: SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT_UNLIT });
    this._skinnedWeightPaint = this._reg({
      layout: this._pipelineLayoutSkinnedWeightPaint,
      vertex: { module: skinnedWPVertModule, entryPoint: 'vs_main', buffers: [skinnedVertexBufferLayout] },
      fragment: { module: skinnedWPFragModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      // Double-sided (see skinnedOpaqueTextured) — robust against inconsistent winding.
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });
    this._skinnedWeightPaintUnlit = this._reg({
      // Unlit variant — same layout, no NdotL calculation.
      layout: this._pipelineLayoutSkinnedWeightPaint,
      vertex: { module: skinnedWPUnlitVertModule, entryPoint: 'vs_main', buffers: [skinnedVertexBufferLayout] },
      fragment: { module: skinnedWPFragModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // ── §3.1 PLAIN (pattern-stripped) opaque pipelines ────────────────────────────────────────────
    // Same descriptors as their full counterparts — only the fragment MODULE differs (the unconditional
    // patternMask x3 / windowsPattern / gr_uvMetres block is compiled OUT). The renderer routes meshes with no
    // pattern/window/ground/shade/normal-map here; output is identical to the full shader for those meshes.
    //
    // Registered like everything else — a plain mesh's first draw compiles only the plain variant(s) it uses.
    const plainFragTex         = this.device.createShaderModule({ code: meshFS(MESH3D_FRAGMENT_SHADER_PLAIN),                label: 'PlainTex' });
    const plainFragUntex       = this.device.createShaderModule({ code: meshFS(MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN),    label: 'PlainUntex' });
    const plainShadowFragTex   = this.device.createShaderModule({ code: meshFS(MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN), label: 'PlainTexShadow' });
    const plainShadowFragUntex = this.device.createShaderModule({ code: meshFS(MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN_SHADOW_MODERN), label: 'PlainUntexShadow' });
    const opaquePlainDesc = (layout: GPUPipelineLayout, frag: GPUShaderModule, cull: GPUCullMode): GPURenderPipelineDescriptor => ({
      layout,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: frag, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });
    const plainSkinnedFragTex   = this.device.createShaderModule({ code: meshFS(SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED_PLAIN),   label: 'PlainSkinnedTex' });
    const plainSkinnedFragUntex = this.device.createShaderModule({ code: meshFS(SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN), label: 'PlainSkinnedUntex' });
    const skinnedPlainDesc = (layout: GPUPipelineLayout, vs: GPUShaderModule, frag: GPUShaderModule): GPURenderPipelineDescriptor => ({
      // Double-sided; skinned meshes have no separate shadow-receiving pipeline.
      layout,
      vertex: { module: vs, entryPoint: 'vs_main', buffers: [skinnedVertexBufferLayout] },
      fragment: { module: frag, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });
    this._opaqueTexturedPlain             = this._reg(opaquePlainDesc(this._pipelineLayoutTextured,         plainFragTex,         'back'));
    this._opaqueTexturedNoCullPlain       = this._reg(opaquePlainDesc(this._pipelineLayoutTextured,         plainFragTex,         'none'));
    this._opaqueUntexturedPlain           = this._reg(opaquePlainDesc(this._pipelineLayoutUntextured,       plainFragUntex,       'back'));
    this._opaqueUntexturedNoCullPlain     = this._reg(opaquePlainDesc(this._pipelineLayoutUntextured,       plainFragUntex,       'none'));
    this._opaqueTexturedPlainShadow       = this._reg(opaquePlainDesc(this._pipelineLayoutShadowTextured,   plainShadowFragTex,   'back'));
    this._opaqueTexturedNoCullPlainShadow = this._reg(opaquePlainDesc(this._pipelineLayoutShadowTextured,   plainShadowFragTex,   'none'));
    this._opaqueUntexturedPlainShadow       = this._reg(opaquePlainDesc(this._pipelineLayoutShadowUntextured, plainShadowFragUntex, 'back'));
    this._opaqueUntexturedNoCullPlainShadow = this._reg(opaquePlainDesc(this._pipelineLayoutShadowUntextured, plainShadowFragUntex, 'none'));
    this._skinnedOpaqueTexturedPlain   = this._reg(skinnedPlainDesc(this._pipelineLayoutSkinnedTextured,   skinnedTexVertModule,   plainSkinnedFragTex));
    this._skinnedOpaqueUntexturedPlain = this._reg(skinnedPlainDesc(this._pipelineLayoutSkinnedUntextured, skinnedUntexVertModule, plainSkinnedFragUntex));
    // FACE KIT overlays (face-features.ts): the plain skinned textured shaders, MULTIPLY-blended over the lit skin.
    // The overlay is unlit (style 6, white) and its texture is a PREMULTIPLIED multiplier m·a, so the blend gives
    // dst·(m·a) + dst·(1 − a) = dst·mix(1, m, a). Destination alpha kept; depth tested, never written.
    this._skinnedFaceMultiply = this._reg({
      ...skinnedPlainDesc(this._pipelineLayoutSkinnedTextured, skinnedTexVertModule, plainSkinnedFragTex),
      fragment: { module: plainSkinnedFragTex, entryPoint: 'fs_main', targets: [{
        format: this.swapChainFormat,
        blend: {
          color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        },
      }] },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less' },
    });
  }

}
