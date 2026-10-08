/**
 * Pipeline3D — WebGPU render pipelines for 3D mesh rendering.
 *
 * Self-contained 3D pipeline manager. Owns the bind group / pipeline layouts, the shared vertex paths and states of
 * the mesh pipelines, and the pipelines that do not shade meshes (shadow casters, SSAO / SSR prepasses and resolves,
 * weight paint). The MESH pipelines are the specialised (axis x feature key) pipelines of the shader split
 * (mesh-fs-pipelines.ts; docs/specs/shader-split.md): each mesh fragment module is generated for the features its
 * meshes use. The fixed uber-shader pipelines were removed in shader-split phase 4 (2026-10-08).
 *
 * Uses the same depth24plus-stencil8 format as the 2D renderer
 * so both can share the same render pass when compositing 2D+3D.
 */

import {
  MESH3D_VERTEX_SHADER,
  MESH3D_VERTEX_SHADER_VERTEX_COLOR,
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
  SKINNED_MESH3D_FRAGMENT_SHADER_WEIGHT_PAINT,
} from './shaders/skinning-shaders';
import { FLOATS_PER_VERT } from './mesh-generators';
import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle, type PipelinePriority } from '../core/gpu-pipeline-cache';
import { noteTwinSource, packedTwin } from './vertex-pack';
import { MESH3D_FS_TINY } from './shaders/mesh3d-tiny-fs';
import { rdMeshFragmentCode } from './render-debug';
import { MeshFsPipelines, type MeshFsAxis } from './mesh-fs-pipelines';
import { meshFsBaseKey, type MeshFsKey } from './shaders/mesh-fs-key';

/** RENDER DEBUG tinyMeshFS: every generated mesh fragment module goes through this (unchanged when off). */
const meshFS = (code: string): string => rdMeshFragmentCode(code, MESH3D_FS_TINY);

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
  'skinnedWeightPaintPipeline', 'skinnedWeightPaintUnlitPipeline',
  'ssaoPrepassPipeline', 'ssaoPeelPrepassPipeline', 'ssrResolvePipeline', 'ssrHealPipeline', 'ssrFeatherPipeline',
] as const;

export class Pipeline3D {
  private device: GPUDevice;
  private swapChainFormat: GPUTextureFormat;

  // EVERY render pipeline below is a LAZY ACCESSOR: calling it compiles that ONE pipeline on first use (behind the
  // loading screen, for whatever the scene actually draws) and caches it; warmAllAsync() compiles the rest in the
  // background. Registered via _reg() during construction — see PipeEntry + docs/specs/pipeline-warmup.md.
  // (The mesh pipelines are not here: the shader split's MeshFsPipelines registers them per (axis, key) on first use.)

  // Pipelines — skinned weight paint (the weight-paint tool)
  private _skinnedWeightPaint!: PipeAccessor;
  private _skinnedWeightPaintUnlit!: PipeAccessor;

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
    // SHADER SPLIT (mesh-fs-pipelines.ts): the generated (axis x key) mesh pipelines; nothing is registered until used.
    this._meshFs = new MeshFsPipelines(device, this._cache, (axis, key, fs, label) => this._describeMeshFs(axis, key, fs, label), meshFS);
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
  get shadowPassPipeline(): GPURenderPipeline | null { return this._shadowPassPipeline(); }
  get skinnedShadowPipeline(): GPURenderPipeline | null { return this._skinnedShadowPipeline(); }
  get ssaoPrepassPipeline(): GPURenderPipeline | null { return this._ssaoPrepassPipeline(); }
  get ssaoPeelPrepassPipeline(): GPURenderPipeline | null { return this._ssaoPeelPrepassPipeline(); }
  get ssrResolvePipeline(): GPURenderPipeline | null { return this._ssrResolvePipeline(); }
  get ssrHealPipeline(): GPURenderPipeline | null { return this._ssrHealPipeline(); }
  get ssrFeatherPipeline(): GPURenderPipeline | null { return this._ssrFeatherPipeline(); }

  get skinnedWeightPaintPipeline(): GPURenderPipeline | null { return this._skinnedWeightPaint(); }
  get skinnedWeightPaintUnlitPipeline(): GPURenderPipeline | null { return this._skinnedWeightPaintUnlit(); }
  get weightPaintBindGroupLayout(): GPUBindGroupLayout { return this._weightPaintBGL; }

  // ── THE MESH PIPELINES: the shader split (mesh-fs-pipelines.ts; docs/specs/shader-split.md) ─────────────────────
  // The descriptor pieces of every mesh pipeline axis (vertex paths, targets, depth states; built in createPipelines).
  private _meshFs!: MeshFsPipelines;
  private _vsModule!: GPUShaderModule;
  private _vbLayout!: GPUVertexBufferLayout;
  private _opaqueTarget!: GPUColorTargetState;
  private _opaqueDS!: GPUDepthStencilState;
  private _transparentTarget!: GPUColorTargetState;
  private _transparentDS!: GPUDepthStencilState;
  private _skinnedVbLayout!: GPUVertexBufferLayout;
  private _skinnedTexVS!: GPUShaderModule;
  private _skinnedUntexVS!: GPUShaderModule;
  /** The vertex-colour VS + its two vertex buffers, the face-kit multiply target. */
  private _vcVS!: GPUShaderModule;
  private _vcVbLayouts!: GPUVertexBufferLayout[];
  private _faceMultiplyTarget!: GPUColorTargetState;

  /** The specialised (axis x key) mesh pipelines (shader split). */
  get meshFs(): MeshFsPipelines { return this._meshFs; }

  /** The pipeline descriptor of mesh axis `axis` around generated fragment module `fs`: the layout (from key.tex /
   *  key.shadow), vertex path, blend, depth and cull of that axis (only the fragment module differs per key). */
  private _describeMeshFs(axis: MeshFsAxis, key: MeshFsKey, fs: GPUShaderModule, label: string): GPURenderPipelineDescriptor {
    const skinned = axis === 'skinned' || axis === 'skinnedFaceMultiply';
    if ((skinned || axis === 'vertexColour' || axis === 'postOverlay') && key.shadow) throw new Error(`Pipeline3D: the ${axis} axis has no shadow-receiving pipeline`);
    if ((axis === 'postOverlay' || axis === 'skinnedFaceMultiply') && !key.tex) throw new Error(`Pipeline3D: the ${axis} axis is textured only`);
    if (axis === 'vertexColour' && key.tex) throw new Error('Pipeline3D: the vertexColour axis is untextured only');
    const transparent = axis === 'transparent' || axis === 'transparentNoCull' || axis === 'postOverlay';
    const layout = skinned
      ? (key.tex ? this._pipelineLayoutSkinnedTextured : this._pipelineLayoutSkinnedUntextured)
      : key.tex ? (key.shadow ? this._pipelineLayoutShadowTextured : this._pipelineLayoutTextured)
        : (key.shadow ? this._pipelineLayoutShadowUntextured : this._pipelineLayoutUntextured);
    return {
      label, layout,
      vertex: skinned
        ? { module: key.tex ? this._skinnedTexVS : this._skinnedUntexVS, entryPoint: 'vs_main', buffers: [this._skinnedVbLayout] }
        : axis === 'vertexColour' ? { module: this._vcVS, entryPoint: 'vs_main', buffers: this._vcVbLayouts }
          : { module: this._vsModule, entryPoint: 'vs_main', buffers: [this._vbLayout] },
      fragment: { module: fs, entryPoint: 'fs_main', targets: [axis === 'skinnedFaceMultiply' ? this._faceMultiplyTarget : transparent ? this._transparentTarget : this._opaqueTarget] },
      primitive: { topology: 'triangle-list', cullMode: axis === 'opaque' || axis === 'transparent' || axis === 'vertexColour' ? 'back' : 'none', frontFace: 'ccw' },
      depthStencil: axis === 'postOverlay' ? { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less' }
        : axis === 'skinnedFaceMultiply' ? { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less' }
          : transparent ? this._transparentDS : this._opaqueDS,
    };
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
    const acc = (() => { const p = h.get(); if (p !== null && p !== noted) { noteTwinSource(p, h.descriptor()); noted = p; } return p; }) as PipeAccessor;
    acc.handle = h;
    return acc;
  }

  /** P22: start compiling the packed twin of every compiled pool pipeline (the registered set and the mesh
   *  pipelines), so the renderer can store geometry packed once they are ready (Renderer3D._pkPackOk). */
  requestPackedTwins(): void {
    for (const e of this._pipeEntries) {
      const p = e.handle.ready ? e.handle.get() : null;
      if (p) { noteTwinSource(p, e.handle.descriptor()); packedTwin(this.device, p); }
    }
    for (const { p, desc } of this._meshFs.compiled()) { noteTwinSource(p, desc); packedTwin(this.device, p); }
  }

  /** The cache handle behind a public getter name (e.g. 'shadowPassPipeline'), or null. */
  handleOf(getterName: string): PipelineHandle<GPURenderPipeline> | null {
    const base = getterName.replace(/Pipeline$/, '');
    const self = this as unknown as Record<string, PipeAccessor | undefined>;
    return (self['_' + base] ?? self['_' + base + 'Pipeline'])?.handle ?? null;
  }

  /** Queue the named pipelines (public getter names) for a background compile at `priority` — e.g. the shadow
   *  casters a just-loaded document will draw (Renderer3D.prewarmForScene). Unknown names are ignored. */
  warmPipelines(getterNames: readonly string[], priority: PipelinePriority = PIPELINE_PRIORITY.DOCUMENT): void {
    for (const n of getterNames) this.handleOf(n)?.warm(priority);
  }

  /** Queue EVERY not-yet-compiled pipeline for a background (createRenderPipelineAsync) compile, drained at idle in
   *  priority order with a small concurrency cap (GPUPipelineCache) so a pipeline a draw is waiting on is never
   *  stuck behind the warm. Idempotent + memoized; resolves when all have settled; never rejects. */
  async warmAllAsync(): Promise<void> {
    return this._warmPromise ??= (async () => {
      // The mesh pipelines (shader-split.md §13.2): the U / T BASE fallbacks of the opaque axes (spec §5.3: never
      // *-ALL), then the seen-keys journal; a document's exact keys compile with its pre-warm / first draw.
      for (const axis of ['opaqueNoCull', 'opaque'] as const) for (const tex of [false, true]) this._meshFs.warm(axis, meshFsBaseKey(tex, false, false, false), PIPELINE_PRIORITY.COMMON);
      // the seen-keys journal: the keys this device drew last time, after the BASE fallbacks (spec §5.3)
      const nj = this._meshFs.warmJournal(PIPELINE_PRIORITY.COMMON);
      if (nj > 0) console.log(`[Salsa][shader-split] warming ${nj} journalled keys`);
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
    const shadowPassVertModule  = this.device.createShaderModule({ code: SHADOW_VERTEX_SHADER });

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
    // the mesh pipeline axes (_describeMeshFs)
    this._vsModule = vertexModule; this._vbLayout = vertexBufferLayout; this._opaqueTarget = opaqueBlend; this._opaqueDS = opaqueDepthStencil;
    this._transparentTarget = transparentBlend; this._transparentDS = transparentDepthStencil;

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

    // Comparison sampler for PCF shadow lookups
    this._shadowSampler = this.device.createSampler({
      compare: 'less',
      minFilter: 'linear',
      magFilter: 'linear',
    });

    // ── Vertex color axis — EditMesh paint ───────────────────────
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
    this._vcVS = vcVertexModule; this._vcVbLayouts = vcVertexBufferLayouts;   // (the vertexColour axis)

    // ── Skinned meshes ────────────────────────────────────────────

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
    this._skinnedVbLayout = skinnedVertexBufferLayout; this._skinnedTexVS = skinnedTexVertModule; this._skinnedUntexVS = skinnedUntexVertModule;   // (the skinned axes)

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
      // Double-sided (like every skinned pipeline) — robust against inconsistent winding.
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

    // FACE KIT overlays (face-features.ts; the skinnedFaceMultiply axis): MULTIPLY-blended over the lit skin.
    // The overlay is unlit (style 6, white) and its texture is a PREMULTIPLIED multiplier m·a, so the blend gives
    // dst·(m·a) + dst·(1 − a) = dst·mix(1, m, a). Destination alpha kept; depth tested, never written.
    this._faceMultiplyTarget = {
      format: this.swapChainFormat,
      blend: {
        color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      },
    };
  }

}
