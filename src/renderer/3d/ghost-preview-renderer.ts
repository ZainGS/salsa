/**
 * GhostPreviewRenderer — draws translucent "ghost" copies of a mesh at N world-space positions.
 *
 * Used by the Array Tool to preview linked copies before the user clicks to commit.
 * Geometry is sourced directly from the hovered mesh's vertex/index buffers.
 * Instances are rendered with alpha blending, no depth write, giving a hologram look.
 *
 * Call order each frame:
 *   renderer.setGhostPreview(data) — supply geometry + instance transforms + current alpha
 *   // inside main render pass:
 *   ghostRenderer.draw(pass, camera)
 */

import { mat4 } from 'gl-matrix';
import { Camera3D } from './camera-3d';

// ── WGSL shaders ──────────────────────────────────────────────────────────────

const GHOST_VERTEX_SHADER = /* wgsl */`
struct Uniforms {
  viewProj : mat4x4<f32>,
  alpha    : f32,
  revealY  : f32,
  _pad1    : f32,
  _pad2    : f32,
}
@group(0) @binding(0) var<uniform> uni : Uniforms;

struct VsOut {
  @builtin(position) pos    : vec4<f32>,
  @location(0)       alpha  : f32,
  @location(1)       worldY : f32,
}

@vertex
fn vs(
  // Only position is used — stride = FLOATS_PER_VERT * 4 = 48 bytes, offset 0.
  @location(0) pos : vec3<f32>,
  // Instance model matrix (column-major, 4 columns as vec4).
  @location(1) m0  : vec4<f32>,
  @location(2) m1  : vec4<f32>,
  @location(3) m2  : vec4<f32>,
  @location(4) m3  : vec4<f32>,
) -> VsOut {
  let model = mat4x4<f32>(m0, m1, m2, m3);
  let world = model * vec4<f32>(pos, 1.0);
  var out : VsOut;
  out.pos    = uni.viewProj * world;
  out.alpha  = uni.alpha;
  out.worldY = world.y;
  return out;
}
`;

const GHOST_FRAGMENT_SHADER = /* wgsl */`
struct Uniforms {
  viewProj : mat4x4<f32>,
  alpha    : f32,
  revealY  : f32,
  _pad1    : f32,
  _pad2    : f32,
}
@group(0) @binding(0) var<uniform> uni : Uniforms;

@fragment
fn fs(@location(0) alpha : f32, @location(1) worldY : f32) -> @location(0) vec4<f32> {
  // Spawn reveal: ABOVE the line is already the real character (discard the ghost), BELOW stays ghost,
  // with a bright scan band right at the line. revealY huge (default) = no reveal, full ghost.
  if (worldY > uni.revealY) { discard; }
  let d = uni.revealY - worldY;
  var col = vec3<f32>(0.42, 0.75, 1.0);   // light blue hologram
  var a   = alpha;
  if (d < 0.03) { col = vec3<f32>(0.85, 0.96, 1.0); a = min(1.0, alpha + 0.55); }   // the bright line
  return vec4<f32>(col, a);
}
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const FLOATS_PER_VERT   = 12;    // pos(3) + normal(3) + uv(2) + tangent(4)
const BYTES_PER_VERT    = FLOATS_PER_VERT * 4;
const BYTES_PER_INST    = 64;    // 4×vec4 model matrix
const UNIFORM_SIZE      = 80;    // mat4 (64) + alpha+pad (16)
const MAX_GHOST_VERTS   = 65536;
const MAX_GHOST_INDICES = 131072;
const MAX_GHOST_INSTS   = 128;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GhostInstance {
  x: number; y: number; z: number;
  rx: number; ry: number; rz: number;  // Euler angles in radians (YXZ order)
  sx: number; sy: number; sz: number;
  /** Optional column-major model matrix — used directly if present (overrides the x/rx/sx fields). */
  matrix?: Float32Array;
}

export interface GhostPreviewData {
  /** Raw vertex data from the source mesh (stride = FLOATS_PER_VERT * 4). */
  vertices: Float32Array;
  /** Raw index data from the source mesh. */
  indices:  Uint32Array;
  /** One entry per ghost copy to render (source mesh is not included). */
  instances: GhostInstance[];
  /** 0–1 opacity for the current animation frame. */
  alpha: number;
  /** Spawn reveal: world-Y above which the ghost is discarded (the real character shows). Omit = no reveal. */
  revealY?: number;
  /** Draw on top of everything (depth-compare always) — for the spawn reveal so it overlays the clothed mesh. */
  onTop?: boolean;
}

// ── GhostPreviewRenderer ─────────────────────────────────────────────────────

export class GhostPreviewRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private pipelineOnTop: GPURenderPipeline | null = null;   // depth-always variant for the spawn reveal
  private bgl: GPUBindGroupLayout | null = null;

  private _vertBuf!:  GPUBuffer;
  private _idxBuf!:   GPUBuffer;
  private _instBuf!:  GPUBuffer;
  private _uniBuf!:   GPUBuffer;

  private _currentIndexCount = 0;
  private _currentInstCount  = 0;

  constructor(
    device: GPUDevice,
    swapChainFormat: GPUTextureFormat,
  ) {
    this.device = device;
    this._createBuffers();
    this._createPipeline(swapChainFormat);
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Upload ghost geometry + instance transforms for this frame.
   * Call once per frame before draw(); safe to call with null to clear.
   */
  update(data: GhostPreviewData | null): void {
    if (!data || data.instances.length === 0 || data.vertices.length === 0) {
      this._currentIndexCount = 0;
      this._currentInstCount  = 0;
      return;
    }

    const vertCap = MAX_GHOST_VERTS * BYTES_PER_VERT;
    const idxCap  = MAX_GHOST_INDICES * 4;
    const instCap = MAX_GHOST_INSTS * BYTES_PER_INST;

    // Upload vertex data (clamped to buffer capacity)
    const vertBytes = Math.min(data.vertices.byteLength, vertCap);
    this.device.queue.writeBuffer(this._vertBuf, 0, data.vertices, 0, vertBytes / 4);

    // Upload index data
    const idxBytes = Math.min(data.indices.byteLength, idxCap);
    this.device.queue.writeBuffer(this._idxBuf, 0, data.indices, 0, idxBytes / 4);
    this._currentIndexCount = Math.min(data.indices.length, MAX_GHOST_INDICES);

    // Build and upload instance model matrices
    const instCount = Math.min(data.instances.length, MAX_GHOST_INSTS);
    const instData  = new Float32Array(instCount * 16);
    for (let i = 0; i < instCount; i++) {
      const inst = data.instances[i];
      if (inst.matrix) { instData.set(inst.matrix, i * 16); continue; }   // use the supplied matrix directly
      const { x, y, z, rx, ry, rz, sx, sy, sz } = inst;
      const m = mat4.create();
      mat4.translate(m, m, [x, y, z]);
      mat4.rotateY(m, m, ry);
      mat4.rotateX(m, m, rx);
      mat4.rotateZ(m, m, rz);
      mat4.scale(m, m, [sx, sy, sz]);
      instData.set(m as Float32Array, i * 16);
    }
    this.device.queue.writeBuffer(this._instBuf, 0, instData, 0, instCount * 16);
    this._currentInstCount = instCount;

    // Store alpha + revealY for draw(); viewProj is uploaded in draw() where camera is available.
    this._pendingAlpha   = data.alpha;
    this._pendingRevealY = data.revealY ?? 1e9;   // default = no reveal (nothing discarded)
    this._pendingOnTop   = data.onTop ?? false;
  }

  private _pendingAlpha   = 0;
  private _pendingRevealY = 1e9;
  private _pendingOnTop   = false;

  draw(pass: GPURenderPassEncoder, camera: Camera3D): void {
    const pipeline = this._pendingOnTop ? this.pipelineOnTop : this.pipeline;
    if (!pipeline || !this.bgl || this._currentIndexCount === 0 || this._currentInstCount === 0) return;

    // Build uniform: viewProj + alpha + padding
    const vp  = camera.getViewProjectionMatrix() as Float32Array;
    const uni = new Float32Array(UNIFORM_SIZE / 4);
    uni.set(vp, 0);
    uni[16] = this._pendingAlpha;
    uni[17] = this._pendingRevealY;
    this.device.queue.writeBuffer(this._uniBuf, 0, uni);

    const bg = this.device.createBindGroup({
      layout: this.bgl,
      entries: [{ binding: 0, resource: { buffer: this._uniBuf } }],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._vertBuf);
    pass.setVertexBuffer(1, this._instBuf);
    pass.setIndexBuffer(this._idxBuf, 'uint32');
    pass.drawIndexed(this._currentIndexCount, this._currentInstCount);
  }

  // ── Private ────────────────────────────────────────────────────────

  private _createBuffers(): void {
    const d = this.device;
    this._vertBuf = d.createBuffer({
      size:  MAX_GHOST_VERTS * BYTES_PER_VERT,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'GhostVertBuf',
    });
    this._idxBuf = d.createBuffer({
      size:  MAX_GHOST_INDICES * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: 'GhostIdxBuf',
    });
    this._instBuf = d.createBuffer({
      size:  MAX_GHOST_INSTS * BYTES_PER_INST,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'GhostInstBuf',
    });
    this._uniBuf = d.createBuffer({
      size:  UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'GhostUniBuf',
    });
  }

  private _createPipeline(swapChainFormat: GPUTextureFormat): void {
    const d = this.device;

    this.bgl = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });

    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const vsModule = d.createShaderModule({ code: GHOST_VERTEX_SHADER });
    const fsModule = d.createShaderModule({ code: GHOST_FRAGMENT_SHADER });

    const makePipeline = (depthCompare: GPUCompareFunction) => d.createRenderPipeline({
      layout,
      vertex: {
        module:     vsModule,
        entryPoint: 'vs',
        buffers: [
          {
            // Vertex buffer: stride = FLOATS_PER_VERT * 4, stepMode = 'vertex'
            // Only read position (first 3 floats) at offset 0.
            arrayStride: BYTES_PER_VERT,
            stepMode:    'vertex',
            attributes:  [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
          {
            // Instance buffer: 4×vec4 model matrix columns
            arrayStride: BYTES_PER_INST,
            stepMode:    'instance',
            attributes: [
              { shaderLocation: 1, offset:  0, format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
              { shaderLocation: 3, offset: 32, format: 'float32x4' },
              { shaderLocation: 4, offset: 48, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module:     fsModule,
        entryPoint: 'fs',
        targets: [{
          format: swapChainFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive:    { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare },
    });

    this.pipeline      = makePipeline('less');     // normal ghost (depth-tested) — Array Tool preview
    this.pipelineOnTop = makePipeline('always');   // spawn reveal — draw over the assembled character
  }
}

