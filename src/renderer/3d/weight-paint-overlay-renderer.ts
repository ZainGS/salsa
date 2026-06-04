/**
 * WeightPaintVertexOverlayRenderer — small billboard dots at each mesh vertex
 * during weight-paint mode. Dots outside the brush radius are grey; dots inside
 * are highlighted cyan so the user can see exactly which vertices will be painted.
 *
 * Renders with depthCompare:'always' (floats above scene geometry, like gizmos).
 * Vertex format: same as GizmoRenderer (position vec3 + color vec4, 28 bytes).
 */

import { GIZMO_VERTEX_SHADER, GIZMO_FRAGMENT_SHADER, GIZMO_VERTEX_STRIDE, GIZMO_UNIFORM_SIZE } from './shaders/gizmo-shaders';
import type { Camera3D } from './camera-3d';
import type { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';

const FLOATS_PER_VERT_MESH = 12; // pos(3) + normal(3) + uv(2) + tangent(4)

const C_DEFAULT: readonly [number, number, number, number] = [0.50, 0.50, 0.50, 0.60];
const C_IN_BRUSH: readonly [number, number, number, number] = [0.0,  1.0,  0.88, 1.0];

const VERT_HALF = 0.007; // world-space billboard half-size

export class WeightPaintVertexOverlayRenderer {
  private readonly device: GPUDevice;
  private readonly _bgl: GPUBindGroupLayout;
  private readonly _pipe: GPURenderPipeline;
  private readonly _uniBuf: GPUBuffer;

  private _vtxBuf: GPUBuffer | null = null;
  private _vtxCap = 0;

  constructor(device: GPUDevice, swapChainFormat: GPUTextureFormat) {
    this.device = device;
    this._uniBuf = device.createBuffer({
      size:  GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vertMod = device.createShaderModule({ code: GIZMO_VERTEX_SHADER });
    const fragMod = device.createShaderModule({ code: GIZMO_FRAGMENT_SHADER });

    this._bgl = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this._bgl] });

    this._pipe = device.createRenderPipeline({
      layout,
      vertex: {
        module: vertMod, entryPoint: 'vs_main',
        buffers: [{
          arrayStride: GIZMO_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x4' },
          ],
        }],
      },
      fragment: {
        module: fragMod, entryPoint: 'fs_main',
        targets: [{
          format: swapChainFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    });
  }

  draw(
    pass: GPURenderPassEncoder,
    mesh: SkinnedMesh3D,
    brushCenter: [number, number, number] | null,
    brushRadius: number,
    camera: Camera3D,
  ): void {
    const geomVerts = mesh.geometry?.vertices;
    if (!geomVerts || geomVerts.length === 0) return;

    const vertCount = geomVerts.length / FLOATS_PER_VERT_MESH;
    const lm = mesh.localMatrix as Float32Array;

    // Upload VP + identity model
    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData[16] = 1; uData[21] = 1; uData[26] = 1; uData[31] = 1;
    this.device.queue.writeBuffer(this._uniBuf, 0, uData);

    // Camera right/up for camera-facing billboards (view matrix column-major: right=col0, up=col1)
    const vm = camera.getViewMatrix();
    const rx = vm[0], ry = vm[4], rz = vm[8];
    const ux = vm[1], uy = vm[5], uz = vm[9];

    const r2 = brushCenter !== null ? brushRadius * brushRadius : -1;
    const bx = brushCenter ? brushCenter[0] : 0;
    const by = brushCenter ? brushCenter[1] : 0;
    const bz = brushCenter ? brushCenter[2] : 0;

    const triV: number[] = [];

    for (let vi = 0; vi < vertCount; vi++) {
      const ox = geomVerts[vi * FLOATS_PER_VERT_MESH + 0];
      const oy = geomVerts[vi * FLOATS_PER_VERT_MESH + 1];
      const oz = geomVerts[vi * FLOATS_PER_VERT_MESH + 2];
      const wx = lm[0]*ox + lm[4]*oy + lm[8]*oz  + lm[12];
      const wy = lm[1]*ox + lm[5]*oy + lm[9]*oz  + lm[13];
      const wz = lm[2]*ox + lm[6]*oy + lm[10]*oz + lm[14];

      const dx = wx - bx, dy = wy - by, dz = wz - bz;
      const inBrush = r2 >= 0 && (dx*dx + dy*dy + dz*dz) <= r2;
      const col = inBrush ? C_IN_BRUSH : C_DEFAULT;
      const h = VERT_HALF;

      const x0 = wx + (-rx - ux) * h, y0 = wy + (-ry - uy) * h, z0 = wz + (-rz - uz) * h;
      const x1 = wx + ( rx - ux) * h, y1 = wy + ( ry - uy) * h, z1 = wz + ( rz - uz) * h;
      const x2 = wx + (-rx + ux) * h, y2 = wy + (-ry + uy) * h, z2 = wz + (-rz + uz) * h;
      const x3 = wx + ( rx + ux) * h, y3 = wy + ( ry + uy) * h, z3 = wz + ( rz + uz) * h;
      triV.push(x0, y0, z0, col[0], col[1], col[2], col[3]);
      triV.push(x1, y1, z1, col[0], col[1], col[2], col[3]);
      triV.push(x2, y2, z2, col[0], col[1], col[2], col[3]);
      triV.push(x1, y1, z1, col[0], col[1], col[2], col[3]);
      triV.push(x3, y3, z3, col[0], col[1], col[2], col[3]);
      triV.push(x2, y2, z2, col[0], col[1], col[2], col[3]);
    }

    if (triV.length === 0) return;

    const bytes = triV.length * 4;
    if (!this._vtxBuf || this._vtxCap < bytes) {
      this._vtxBuf?.destroy();
      this._vtxCap = Math.max(bytes, 512 * GIZMO_VERTEX_STRIDE);
      this._vtxBuf = this.device.createBuffer({
        size: this._vtxCap,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this._vtxBuf, 0, new Float32Array(triV));

    const bg = this.device.createBindGroup({
      layout: this._bgl,
      entries: [{ binding: 0, resource: { buffer: this._uniBuf } }],
    });
    pass.setPipeline(this._pipe);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._vtxBuf);
    pass.draw(triV.length / 7);
  }

  destroy(): void {
    this._uniBuf.destroy();
    this._vtxBuf?.destroy();
  }
}
