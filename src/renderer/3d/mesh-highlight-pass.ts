/**
 * MeshHighlightPass — per-mesh silhouette outline for hover and selection.
 *
 * Uses a two-pipeline stencil technique:
 *
 *   Step 1 — Stencil write (setStencilReference(1), _stencilPipeline):
 *     Renders the original mesh silhouette into the stencil buffer using
 *     (compare='always', passOp='replace').  No color or depth writes.
 *     After this step, stencil=1 at every visible pixel of the mesh.
 *
 *   Step 2 — Outline draw (_outlinePipeline):
 *     Renders the same mesh with vertices expanded along their model-space
 *     normals.  Stencil compare='not-equal' (ref=1) masks out the interior,
 *     so only the ring outside the original silhouette is coloured.
 *     cullMode='back' draws the expanded shell's front faces.
 *
 *   Step 3 — Stencil clear (setStencilReference(0), _stencilPipeline):
 *     Re-draws the original mesh with (compare='always', passOp='replace',
 *     ref=0) to reset stencil back to 0, keeping the buffer clean for
 *     subsequent draw calls (hover and select are drawn independently).
 *
 * Two independent param buffers (hover / select) avoid writeBuffer ordering
 * issues when both are drawn in the same render pass.
 */

import { HIGHLIGHT_SHADER, STENCIL_WRITE_SHADER } from './shaders/highlight-shaders';
import { MESH3D_VERTEX_STRIDE } from './pipeline-3d';

const PARAMS_SIZE = 32; // vec4 color (16) + f32 width (4) + 12 pad = 32

export interface HighlightMeshEntry {
  vertex:      GPUBuffer;
  index:       GPUBuffer;
  indexCount:  number;
  firstIndex:  number;
  baseVertex:  number;
  instanceIdx: number;
}

export class MeshHighlightPass {
  private device: GPUDevice;
  private _outlinePipeline: GPURenderPipeline;
  private _stencilPipeline: GPURenderPipeline;
  private _paramsBGL: GPUBindGroupLayout;

  // Two separate buffers so both can be enqueued before the pass begins
  private _hoverBuf:  GPUBuffer;
  private _selectBuf: GPUBuffer;
  private _hoverBG:   GPUBindGroup;
  private _selectBG:  GPUBindGroup;

  constructor(
    device: GPUDevice,
    meshBGL: GPUBindGroupLayout,
    swapChainFormat: GPUTextureFormat,
  ) {
    this.device = device;

    // ── Params bind group layout (hover/select color + width) ──────
    this._paramsBGL = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    const makeParamsBuf = () => device.createBuffer({
      size: PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const makeBG = (buf: GPUBuffer) => device.createBindGroup({
      layout: this._paramsBGL,
      entries: [{ binding: 0, resource: { buffer: buf } }],
    });

    this._hoverBuf  = makeParamsBuf();
    this._selectBuf = makeParamsBuf();
    this._hoverBG   = makeBG(this._hoverBuf);
    this._selectBG  = makeBG(this._selectBuf);

    // ── Stencil-write pipeline ─────────────────────────────────────
    // Renders original mesh (no expansion) with:
    //   - no color writes (writeMask=0)
    //   - no depth writes (depthWriteEnabled=false)
    //   - stencil replace with reference value (set dynamically)
    // Used for both writing stencil=1 and clearing back to stencil=0.
    const stencilMod = device.createShaderModule({ code: STENCIL_WRITE_SHADER });
    const stencilLayout = device.createPipelineLayout({
      bindGroupLayouts: [meshBGL],
    });

    this._stencilPipeline = device.createRenderPipeline({
      layout: stencilLayout,
      vertex: {
        module: stencilMod,
        entryPoint: 'vs_stencil',
        buffers: [{
          arrayStride: MESH3D_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position only
          ],
        }],
      },
      fragment: {
        module: stencilMod,
        entryPoint: 'fs_stencil',
        targets: [{
          format: swapChainFormat,
          writeMask: 0, // write nothing to color buffer
        }],
      },
      // 'none': write stencil for both faces so back-viewed planes/ribbons
      // get a complete stencil footprint and therefore a complete outline ring.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'less-equal', // pass for already-drawn mesh surface
        stencilFront: {
          compare:      'always',
          failOp:       'keep',
          depthFailOp:  'keep',
          passOp:       'replace', // write reference value (1 or 0) to stencil
        },
        stencilBack: {
          compare:      'always',
          failOp:       'keep',
          depthFailOp:  'keep',
          passOp:       'replace',
        },
      },
    });

    // ── Outline draw pipeline ──────────────────────────────────────
    // Renders expanded mesh (vertices pushed along normals) with:
    //   - alpha blending for the outline colour
    //   - stencil not-equal (ref=1): only draws outside the mesh footprint
    //   - cullMode='back': front faces of expanded shell face the camera
    const outlineMod = device.createShaderModule({ code: HIGHLIGHT_SHADER });
    const outlineLayout = device.createPipelineLayout({
      bindGroupLayouts: [meshBGL, this._paramsBGL],
    });

    this._outlinePipeline = device.createRenderPipeline({
      layout: outlineLayout,
      vertex: {
        module: outlineMod,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: MESH3D_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // position
            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
          ],
        }],
      },
      fragment: {
        module: outlineMod,
        entryPoint: 'fs',
        targets: [{
          format: swapChainFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
        stencilFront: {
          compare:     'not-equal', // draw only OUTSIDE the mesh silhouette (stencil=0)
          failOp:      'keep',
          depthFailOp: 'keep',
          passOp:      'keep',
        },
        stencilBack: {
          compare:     'not-equal',
          failOp:      'keep',
          depthFailOp: 'keep',
          passOp:      'keep',
        },
      },
    });
  }

  /**
   * Write params for hover (slot 0) or selection (slot 1) into their respective
   * uniform buffers. Call BEFORE the render pass begins so both writes are
   * enqueued before the command buffer is submitted.
   */
  writeParams(
    slot: 'hover' | 'select',
    color: [number, number, number, number],
    width: number,
  ): void {
    const buf = slot === 'hover' ? this._hoverBuf : this._selectBuf;
    const data = new Float32Array([color[0], color[1], color[2], color[3], width, 0, 0, 0]);
    this.device.queue.writeBuffer(buf, 0, data);
  }

  /**
   * Record highlight draw calls into the given render pass.
   *
   * Three steps per slot:
   *  1. Stencil write (ref=1)  — mark mesh footprint
   *  2. Outline draw (ref=1)   — draw ring where stencil=0
   *  3. Stencil clear (ref=0)  — reset stencil for subsequent slots
   */
  draw(
    pass:          GPURenderPassEncoder,
    meshBindGroup: GPUBindGroup,
    slot:          'hover' | 'select',
    entries:       HighlightMeshEntry[],
  ): void {
    if (entries.length === 0) return;

    const paramsBG = slot === 'hover' ? this._hoverBG : this._selectBG;

    // Step 1: write stencil=1 for the mesh footprint
    pass.setPipeline(this._stencilPipeline);
    pass.setBindGroup(0, meshBindGroup);
    pass.setStencilReference(1);
    for (const e of entries) {
      pass.setVertexBuffer(0, e.vertex);
      pass.setIndexBuffer(e.index, 'uint32');
      pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
    }

    // Step 2: draw expanded outline where stencil!=1 (outside silhouette)
    pass.setPipeline(this._outlinePipeline);
    pass.setBindGroup(0, meshBindGroup);
    pass.setBindGroup(1, paramsBG);
    pass.setStencilReference(1);
    for (const e of entries) {
      pass.setVertexBuffer(0, e.vertex);
      pass.setIndexBuffer(e.index, 'uint32');
      pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
    }

    // Step 3: clear stencil back to 0 so the next slot starts clean
    pass.setPipeline(this._stencilPipeline);
    pass.setBindGroup(0, meshBindGroup);
    pass.setStencilReference(0);
    for (const e of entries) {
      pass.setVertexBuffer(0, e.vertex);
      pass.setIndexBuffer(e.index, 'uint32');
      pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
    }
  }

  destroy(): void {
    this._hoverBuf.destroy();
    this._selectBuf.destroy();
  }
}
