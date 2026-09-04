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
} from './shaders/mesh3d-shaders';
import {
  SHADOW_VERTEX_SHADER,
} from './shaders/shadow-shaders';
import { SSAO_PREPASS_SHADER } from './shaders/ssao-shaders';
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

/** Byte stride per vertex — derived from FLOATS_PER_VERT so the two stay in sync. */
export const MESH3D_VERTEX_STRIDE = FLOATS_PER_VERT * Float32Array.BYTES_PER_ELEMENT;

/**
 * Byte stride per skinned vertex.
 * Layout: position(12) + normal(12) + uv(8) + tangent(16) + joints-uint8x4(4) + weights-f32x4(16) + pad(4) = 72
 */
export const SKINNED_MESH3D_VERTEX_STRIDE = 72;

/** One GRANULARLY-compiled pipeline: its descriptor + the compiled result (null until first use). Every pipeline
 *  is registered as an entry during construction (cheap — shader-module creation only, no compile); it is compiled
 *  sync on first getter access (`_reg` returns a lazy accessor), OR ahead of time off the main thread by
 *  `warmAllAsync`. This makes a 4-primitive scene compile only the 2-4 pipelines it actually draws behind the
 *  loading screen, not all ~29 — the rest warm in the background. See docs/specs/pipeline-warmup.md. */
type PipeEntry = { descriptor: GPURenderPipelineDescriptor; pipeline: GPURenderPipeline | null };

export class Pipeline3D {
  private device: GPUDevice;
  private swapChainFormat: GPUTextureFormat;

  // EVERY render pipeline below is a LAZY ACCESSOR: calling it compiles that ONE pipeline on first use (behind the
  // loading screen, for whatever the scene actually draws) and caches it; warmAllAsync() compiles the rest in the
  // background. Registered via _reg() during construction — see PipeEntry + docs/specs/pipeline-warmup.md.
  // Pipelines — base (no shadows)
  private _opaqueTextured!: () => GPURenderPipeline;
  private _overlayTextured!: () => GPURenderPipeline;   // always-on-top textured (depthCompare 'always') — the info card
  private _postOverlayTextured!: () => GPURenderPipeline;   // color-only clone (no depth) — drawn AFTER post-processing
  private _opaqueUntextured!: () => GPURenderPipeline;
  private _transparentTextured!: () => GPURenderPipeline;
  private _transparentUntextured!: () => GPURenderPipeline;
  private _transparentTexturedNoCull!: () => GPURenderPipeline;     // doubleSided transparent (both faces draw)
  private _transparentUntexturedNoCull!: () => GPURenderPipeline;

  // Pipelines — no back-face culling (used by preview renderers and double-sided materials)
  private _opaqueTexturedNoCull!: () => GPURenderPipeline;
  private _opaqueUntexturedNoCull!: () => GPURenderPipeline;

  // Pipeline — vertex color (EditMesh paint; two vertex buffer slots)
  private _opaqueVertexColor!: () => GPURenderPipeline;

  // Pipelines — skinned (LBS) opaque
  private _skinnedOpaqueTextured!: () => GPURenderPipeline;
  private _skinnedOpaqueUntextured!: () => GPURenderPipeline;
  private _skinnedWeightPaint!: () => GPURenderPipeline;
  private _skinnedWeightPaintUnlit!: () => GPURenderPipeline;

  // Pipelines — shadow-enabled (opaque only; transparent geometry skips shadows)
  private _opaqueTexturedShadow!: () => GPURenderPipeline;
  private _opaqueTexturedNoCullShadow!: () => GPURenderPipeline;
  private _opaqueUntexturedNoCullShadow!: () => GPURenderPipeline;
  private _opaqueUntexturedShadow!: () => GPURenderPipeline;

  // §3.1 PLAIN (pattern-stripped) opaque variants — identical to the above but with the pattern block compiled out.
  // Meshes with no pattern/window/ground/shade/normal-map (characters, plain props) route here; output is identical.
  private _opaqueTexturedPlain!: () => GPURenderPipeline;
  private _opaqueUntexturedPlain!: () => GPURenderPipeline;
  private _opaqueTexturedNoCullPlain!: () => GPURenderPipeline;
  private _opaqueUntexturedNoCullPlain!: () => GPURenderPipeline;
  private _opaqueTexturedPlainShadow!: () => GPURenderPipeline;
  private _opaqueUntexturedPlainShadow!: () => GPURenderPipeline;
  private _opaqueTexturedNoCullPlainShadow!: () => GPURenderPipeline;
  private _opaqueUntexturedNoCullPlainShadow!: () => GPURenderPipeline;
  private _skinnedOpaqueTexturedPlain!: () => GPURenderPipeline;
  private _skinnedOpaqueUntexturedPlain!: () => GPURenderPipeline;

  // Granular lazy-pipeline registry: every _reg() call pushes one entry here. Its accessor compiles on first use;
  // warmAllAsync() compiles whichever entries are still un-compiled, off the main thread.
  private _pipeEntries: PipeEntry[] = [];
  private _warmPromise: Promise<void> | null = null;

  // Shadow pass (depth-only) pipeline
  private _shadowPassPipeline!: () => GPURenderPipeline;
  // SSAO geometry prepass — writes world position to an rgba32float G-buffer (reuses the shadow-pass layout).
  private _ssaoPrepassPipeline!: () => GPURenderPipeline;

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
    this.createLayouts();
    // createPipelines() only REGISTERS pipelines (via _reg) — it builds shader modules + descriptors but compiles
    // nothing. Each pipeline compiles lazily on first getter access, or in bulk via warmAllAsync().
    this.createPipelines();
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
  get opaqueTexturedPipeline(): GPURenderPipeline { return this._opaqueTextured(); }
  get overlayTexturedPipeline(): GPURenderPipeline { return this._overlayTextured(); }
  get postOverlayTexturedPipeline(): GPURenderPipeline { return this._postOverlayTextured(); }
  get opaqueUntexturedPipeline(): GPURenderPipeline { return this._opaqueUntextured(); }
  get transparentTexturedPipeline(): GPURenderPipeline { return this._transparentTextured(); }
  get transparentUntexturedPipeline(): GPURenderPipeline { return this._transparentUntextured(); }
  get transparentTexturedNoCullPipeline(): GPURenderPipeline { return this._transparentTexturedNoCull(); }
  get transparentUntexturedNoCullPipeline(): GPURenderPipeline { return this._transparentUntexturedNoCull(); }
  get opaqueTexturedNoCullPipeline(): GPURenderPipeline { return this._opaqueTexturedNoCull(); }
  get opaqueUntexturedNoCullPipeline(): GPURenderPipeline { return this._opaqueUntexturedNoCull(); }

  get opaqueTexturedShadowPipeline(): GPURenderPipeline { return this._opaqueTexturedShadow(); }
  get opaqueTexturedNoCullShadowPipeline(): GPURenderPipeline { return this._opaqueTexturedNoCullShadow(); }
  get opaqueUntexturedNoCullShadowPipeline(): GPURenderPipeline { return this._opaqueUntexturedNoCullShadow(); }
  get opaqueUntexturedShadowPipeline(): GPURenderPipeline { return this._opaqueUntexturedShadow(); }
  get opaqueTexturedPlainPipeline(): GPURenderPipeline { return this._opaqueTexturedPlain(); }
  get opaqueUntexturedPlainPipeline(): GPURenderPipeline { return this._opaqueUntexturedPlain(); }
  get opaqueTexturedNoCullPlainPipeline(): GPURenderPipeline { return this._opaqueTexturedNoCullPlain(); }
  get opaqueUntexturedNoCullPlainPipeline(): GPURenderPipeline { return this._opaqueUntexturedNoCullPlain(); }
  get opaqueTexturedPlainShadowPipeline(): GPURenderPipeline { return this._opaqueTexturedPlainShadow(); }
  get opaqueUntexturedPlainShadowPipeline(): GPURenderPipeline { return this._opaqueUntexturedPlainShadow(); }
  get opaqueTexturedNoCullPlainShadowPipeline(): GPURenderPipeline { return this._opaqueTexturedNoCullPlainShadow(); }
  get opaqueUntexturedNoCullPlainShadowPipeline(): GPURenderPipeline { return this._opaqueUntexturedNoCullPlainShadow(); }
  get skinnedOpaqueTexturedPlainPipeline(): GPURenderPipeline { return this._skinnedOpaqueTexturedPlain(); }
  get skinnedOpaqueUntexturedPlainPipeline(): GPURenderPipeline { return this._skinnedOpaqueUntexturedPlain(); }
  get shadowPassPipeline(): GPURenderPipeline { return this._shadowPassPipeline(); }
  get ssaoPrepassPipeline(): GPURenderPipeline { return this._ssaoPrepassPipeline(); }

  get skinnedOpaqueTexturedPipeline(): GPURenderPipeline { return this._skinnedOpaqueTextured(); }
  get skinnedOpaqueUntexturedPipeline(): GPURenderPipeline { return this._skinnedOpaqueUntextured(); }
  get skinnedWeightPaintPipeline(): GPURenderPipeline { return this._skinnedWeightPaint(); }
  get skinnedWeightPaintUnlitPipeline(): GPURenderPipeline { return this._skinnedWeightPaintUnlit(); }
  get opaqueVertexColorPipeline(): GPURenderPipeline { return this._opaqueVertexColor(); }
  get weightPaintBindGroupLayout(): GPUBindGroupLayout { return this._weightPaintBGL; }

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

  /** Register a pipeline for GRANULAR lazy compilation and return its accessor. The accessor compiles this ONE
   *  pipeline on its first call (the sync fallback if the async warm hasn't reached it yet) and caches the result;
   *  warmAllAsync() later compiles whichever entries are still null, off the main thread. */
  private _reg(descriptor: GPURenderPipelineDescriptor): () => GPURenderPipeline {
    const e: PipeEntry = { descriptor, pipeline: null };
    const n = this._pipeEntries.push(e);
    return () => {
      if (e.pipeline) return e.pipeline;
      // A SYNC compile means a draw needed this pipeline before the background warm reached it — i.e. it's paying
      // the compile behind the loading screen. Logged so the load timeline shows exactly what's compiling on-demand.
      const t0 = performance.now();
      e.pipeline = this.device.createRenderPipeline(e.descriptor);
      console.log(`[Salsa][pipe] sync-compiled #${n} "${e.descriptor.label ?? ''}" on demand (+${Math.round(performance.now() - t0)}ms)`);
      return e.pipeline;
    };
  }

  /** Compile every not-yet-compiled pipeline OFF the main thread (createRenderPipelineAsync), so pipelines the
   *  first frame didn't need are ready before the user reaches for them. Idempotent + memoized; never rejects. */
  async warmAllAsync(): Promise<void> {
    return this._warmPromise ??= (async () => {
      const pending = this._pipeEntries.filter(e => !e.pipeline);
      const t0 = performance.now();
      console.log(`[Salsa][warm] warming ${pending.length} pipelines in background (${this._pipeEntries.length - pending.length} already compiled)…`);
      try {
        await Promise.all(pending.map(async e => {
          if (e.pipeline) return;                                   // already compiled (getter beat us)
          const p = await this.device.createRenderPipelineAsync(e.descriptor);
          e.pipeline ??= p;                                         // don't clobber if a getter won the race
        }));
        console.log(`[Salsa][warm] pipeline warm complete: ${pending.length} compiled in ${Math.round(performance.now() - t0)}ms`);
      } catch (err) { console.warn('[Salsa][warm] pipeline warm failed', err); }
    })();
  }

  private createPipelines(): void {
    const vertexModule          = this.device.createShaderModule({ code: MESH3D_VERTEX_SHADER });
    const fragTexturedModule    = this.device.createShaderModule({ code: MESH3D_FRAGMENT_SHADER });
    const fragUntexturedModule  = this.device.createShaderModule({ code: MESH3D_FRAGMENT_SHADER_UNTEXTURED });
    const shadowPassVertModule  = this.device.createShaderModule({ code: SHADOW_VERTEX_SHADER });
    // Shadow-RECEIVING pipelines use the MODERN fragment shaders (patterns/interiors/relief/point lights/PBR)
    // with shadow sampling substituted in — the legacy gouraud shadow FS predates the whole pattern system and
    // silently downgraded anything that received shadows. The modern VS pairs with them (lightSpacePos is
    // computed in-fragment from worldPos, so no dedicated shadow VS is needed).
    const shadowFragTexModule   = this.device.createShaderModule({ code: MESH3D_FRAGMENT_SHADER_SHADOW_MODERN });
    const shadowFragUntexModule = this.device.createShaderModule({ code: MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN });

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
      fragment: undefined,
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
      fragment: { module: ssaoPrepassModule, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
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
    const skinnedTexFragModule   = this.device.createShaderModule({ code: SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED });
    const skinnedUntexFragModule = this.device.createShaderModule({ code: SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED });

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
    const plainFragTex         = this.device.createShaderModule({ code: MESH3D_FRAGMENT_SHADER_PLAIN,                        label: 'PlainTex' });
    const plainFragUntex       = this.device.createShaderModule({ code: MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN,            label: 'PlainUntex' });
    const plainShadowFragTex   = this.device.createShaderModule({ code: MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN,         label: 'PlainTexShadow' });
    const plainShadowFragUntex = this.device.createShaderModule({ code: MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN_SHADOW_MODERN, label: 'PlainUntexShadow' });
    const opaquePlainDesc = (layout: GPUPipelineLayout, frag: GPUShaderModule, cull: GPUCullMode): GPURenderPipelineDescriptor => ({
      layout,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: frag, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });
    const plainSkinnedFragTex   = this.device.createShaderModule({ code: SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED_PLAIN,   label: 'PlainSkinnedTex' });
    const plainSkinnedFragUntex = this.device.createShaderModule({ code: SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN, label: 'PlainSkinnedUntex' });
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
  }

}
