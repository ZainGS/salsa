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
} from './shaders/mesh3d-shaders';
import {
  SHADOW_VERTEX_SHADER,
} from './shaders/shadow-shaders';
import {
  SKINNED_MESH3D_VERTEX_SHADER_TEXTURED,
  SKINNED_MESH3D_VERTEX_SHADER_UNTEXTURED,
  SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT,
  SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT_UNLIT,
  SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED,
  SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED,
  SKINNED_MESH3D_FRAGMENT_SHADER_WEIGHT_PAINT,
} from './shaders/skinning-shaders';
import { FLOATS_PER_VERT } from './mesh-generators';

/** Byte stride per vertex — derived from FLOATS_PER_VERT so the two stay in sync. */
export const MESH3D_VERTEX_STRIDE = FLOATS_PER_VERT * Float32Array.BYTES_PER_ELEMENT;

/**
 * Byte stride per skinned vertex.
 * Layout: position(12) + normal(12) + uv(8) + tangent(16) + joints-uint8x4(4) + weights-f32x4(16) + pad(4) = 72
 */
export const SKINNED_MESH3D_VERTEX_STRIDE = 72;

export class Pipeline3D {
  private device: GPUDevice;
  private swapChainFormat: GPUTextureFormat;

  // Pipelines — base (no shadows)
  private _opaqueTextured!: GPURenderPipeline;
  private _opaqueUntextured!: GPURenderPipeline;
  private _transparentTextured!: GPURenderPipeline;
  private _transparentUntextured!: GPURenderPipeline;

  // Pipelines — no back-face culling (used by preview renderers and double-sided materials)
  private _opaqueTexturedNoCull!: GPURenderPipeline;
  private _opaqueUntexturedNoCull!: GPURenderPipeline;

  // Pipeline — vertex color (EditMesh paint; two vertex buffer slots)
  private _opaqueVertexColor!: GPURenderPipeline;

  // Pipelines — skinned (LBS) opaque
  private _skinnedOpaqueTextured!: GPURenderPipeline;
  private _skinnedOpaqueUntextured!: GPURenderPipeline;
  private _skinnedWeightPaint!: GPURenderPipeline;
  private _skinnedWeightPaintUnlit!: GPURenderPipeline;

  // Pipelines — shadow-enabled (opaque only; transparent geometry skips shadows)
  private _opaqueTexturedShadow!: GPURenderPipeline;
  private _opaqueTexturedNoCullShadow!: GPURenderPipeline;
  private _opaqueUntexturedNoCullShadow!: GPURenderPipeline;
  private _opaqueUntexturedShadow!: GPURenderPipeline;

  // Shadow pass (depth-only) pipeline
  private _shadowPassPipeline!: GPURenderPipeline;

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

  get opaqueTexturedPipeline(): GPURenderPipeline { return this._opaqueTextured; }
  get opaqueUntexturedPipeline(): GPURenderPipeline { return this._opaqueUntextured; }
  get transparentTexturedPipeline(): GPURenderPipeline { return this._transparentTextured; }
  get transparentUntexturedPipeline(): GPURenderPipeline { return this._transparentUntextured; }
  get opaqueTexturedNoCullPipeline(): GPURenderPipeline { return this._opaqueTexturedNoCull; }
  get opaqueUntexturedNoCullPipeline(): GPURenderPipeline { return this._opaqueUntexturedNoCull; }

  get opaqueTexturedShadowPipeline(): GPURenderPipeline { return this._opaqueTexturedShadow; }
  get opaqueTexturedNoCullShadowPipeline(): GPURenderPipeline { return this._opaqueTexturedNoCullShadow; }
  get opaqueUntexturedNoCullShadowPipeline(): GPURenderPipeline { return this._opaqueUntexturedNoCullShadow; }
  get opaqueUntexturedShadowPipeline(): GPURenderPipeline { return this._opaqueUntexturedShadow; }
  get shadowPassPipeline(): GPURenderPipeline { return this._shadowPassPipeline; }

  get skinnedOpaqueTexturedPipeline(): GPURenderPipeline { return this._skinnedOpaqueTextured; }
  get skinnedOpaqueUntexturedPipeline(): GPURenderPipeline { return this._skinnedOpaqueUntextured; }
  get skinnedWeightPaintPipeline(): GPURenderPipeline { return this._skinnedWeightPaint; }
  get skinnedWeightPaintUnlitPipeline(): GPURenderPipeline { return this._skinnedWeightPaintUnlit; }
  get opaqueVertexColorPipeline(): GPURenderPipeline { return this._opaqueVertexColor; }
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
      ],
    });

    // Group 1: diffuse texture_2d_array + sampler + normal map texture_2d_array + sampler.
    // All textured draws — both the shared atlas and standalone 1-layer wrappers — use
    // this same layout. Bindings 2/3 use a flat-normal 1×1 default when no normal map is set.
    this._textureBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
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
    this._opaqueTextured = this.device.createRenderPipeline({
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

    // Opaque + Untextured
    this._opaqueUntextured = this.device.createRenderPipeline({
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
    this._transparentTextured = this.device.createRenderPipeline({
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
    this._transparentUntextured = this.device.createRenderPipeline({
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

    // ── Shadow pass: depth-only pipeline ──────────────────────────
    this._shadowPassPipeline = this.device.createRenderPipeline({
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

    // ── Shadow-enabled opaque pipelines (group 2 = shadow BGL) ───

    // Untextured shadow: layout = [meshBGL, shadowBGL] — modern VS + modern shadow-receiving FS.
    this._opaqueUntexturedShadow = this.device.createRenderPipeline({
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
    this._opaqueTexturedShadow = this.device.createRenderPipeline({
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
    this._opaqueTexturedNoCullShadow = this.device.createRenderPipeline({
      layout: this._pipelineLayoutShadowTextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: shadowFragTexModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });
    this._opaqueUntexturedNoCullShadow = this.device.createRenderPipeline({
      layout: this._pipelineLayoutShadowUntextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: shadowFragUntexModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // Opaque + Textured, no back-face cull (preview / double-sided materials)
    this._opaqueTexturedNoCull = this.device.createRenderPipeline({
      layout: this._pipelineLayoutTextured,
      vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: fragTexturedModule, entryPoint: 'fs_main', targets: [opaqueBlend] },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // Opaque + Untextured, no back-face cull
    this._opaqueUntexturedNoCull = this.device.createRenderPipeline({
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
    this._opaqueVertexColor = this.device.createRenderPipeline({
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
    this._skinnedOpaqueTextured = this.device.createRenderPipeline({
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
    this._skinnedOpaqueUntextured = this.device.createRenderPipeline({
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

    // Skinned weight paint — layout: [mesh(0), skin(1), weightPaint(2)]
    const skinnedWPVertModule = this.device.createShaderModule({ code: SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT });
    const skinnedWPFragModule = this.device.createShaderModule({ code: SKINNED_MESH3D_FRAGMENT_SHADER_WEIGHT_PAINT });
    this._skinnedWeightPaint = this.device.createRenderPipeline({
      layout: this._pipelineLayoutSkinnedWeightPaint,
      vertex: {
        module: skinnedWPVertModule,
        entryPoint: 'vs_main',
        buffers: [skinnedVertexBufferLayout],
      },
      fragment: {
        module: skinnedWPFragModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      // Double-sided (see skinnedOpaqueTextured) — robust against inconsistent winding.
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });

    // Unlit variant — same layout, no NdotL calculation.
    const skinnedWPUnlitVertModule = this.device.createShaderModule({ code: SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT_UNLIT });
    this._skinnedWeightPaintUnlit = this.device.createRenderPipeline({
      layout: this._pipelineLayoutSkinnedWeightPaint,
      vertex: {
        module: skinnedWPUnlitVertModule,
        entryPoint: 'vs_main',
        buffers: [skinnedVertexBufferLayout],
      },
      fragment: {
        module: skinnedWPFragModule,
        entryPoint: 'fs_main',
        targets: [opaqueBlend],
      },
      // Double-sided (see skinnedOpaqueTextured) — robust against inconsistent winding.
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: opaqueDepthStencil,
    });
  }
}
