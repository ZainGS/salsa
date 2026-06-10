/**
 * MeshEditOverlayRenderer — always-on-top wireframe, face fills, and vertex dots
 * for mesh edit mode (vertex / face / edge selection).
 *
 * Rendering model:
 *   - depthCompare: 'always', depthWriteEnabled: false  (floats above scene geometry)
 *   - alpha blending (same blend state as GizmoRenderer)
 *   - Three pipelines sharing the gizmo WGSL shader:
 *       _triPipeline      ('triangle-list') — face fills + billboard vertex dots
 *       _linePipeline     ('line-list', depthCompare:'always')  — solid front edges
 *       _lineRearPipeline ('line-list', depthCompare:'greater') — stippled rear edges
 *   - Vertex format: position(vec3) + color(vec4) = 28 bytes (GIZMO_VERTEX_STRIDE)
 *   - Uniform: VP matrix + identity model matrix (vertices are world-space)
 *
 * Usage (called from Renderer3D.drawMeshes):
 *   renderer.setMeshEditOverlayRenderer(new MeshEditOverlayRenderer(device, fmt));
 *   renderer.setMeshEditDataProvider(() => ({ mesh, selection, mode }));
 *   // overlay draws automatically each frame when data provider returns non-null
 */

import { GIZMO_VERTEX_SHADER, GIZMO_FRAGMENT_SHADER, GIZMO_VERTEX_STRIDE, GIZMO_UNIFORM_SIZE } from './shaders/gizmo-shaders';
import type { Camera3D } from './camera-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { EditSelection } from '../../services/managers/mesh-edit-manager';
import type { MeshEditSelectionMode } from '../../services/managers/mesh-edit-pointer-controller';

// Fragment shader for rear (occluded) edges: 4-pixel diagonal stipple pattern.
// Uses (x+y) % 8 so horizontal, vertical, and diagonal lines all look dashed.
const REAR_EDGE_FRAG_SHADER = /* wgsl */`
struct In {
  @builtin(position) pos:   vec4<f32>,
  @location(0)       color: vec4<f32>,
}
@fragment fn fs_stipple(in: In) -> @location(0) vec4<f32> {
  if ((u32(in.pos.x) + u32(in.pos.y)) % 8u < 4u) { discard; }
  return vec4<f32>(in.color.rgb, in.color.a * 0.55);
}
`;

// ── Colors ───────────────────────────────────────────────────────────────────

const C_UNSEL_EDGE:  readonly [number, number, number, number] = [0.65, 0.65, 0.65, 0.5];
const C_SEL_EDGE:    readonly [number, number, number, number] = [1.0, 0.55, 0.0,  1.0];
const C_SEAM_EDGE:   readonly [number, number, number, number] = [0.9, 0.15, 0.15, 1.0];
const C_UNSEL_VERT:  readonly [number, number, number, number] = [1.0, 0.72, 0.4, 0.85];
const C_SEL_VERT:    readonly [number, number, number, number] = [1.0, 0.55, 0.0,  1.0];
const C_SEL_FACE:    readonly [number, number, number, number] = [1.0, 0.55, 0.0,  0.25];
/** UV cross-highlight tint (cyan): shown when hovering in the UV canvas pane. */
const C_HOVER_FACE:  readonly [number, number, number, number] = [0.3, 0.85, 1.0,  0.20];

/** World-space half-size of a vertex dot billboard quad. */
const VERT_HALF = 0.008;
/** Selected vertex is drawn 1.5× larger. */
const VERT_HALF_SEL = VERT_HALF * 1.5;

// ── Public types ─────────────────────────────────────────────────────────────

export interface MeshEditDrawData {
  mesh: Mesh3D;
  selection: EditSelection | null;
  mode: MeshEditSelectionMode;
  /** Face indices to tint as UV cross-highlight (from UV canvas hover or island hover). */
  hoveredFaces?: Set<number>;
}

// ── Renderer ─────────────────────────────────────────────────────────────────

export class MeshEditOverlayRenderer {
  private readonly device: GPUDevice;
  private readonly _bgl:           GPUBindGroupLayout;
  private readonly _triPipe:       GPURenderPipeline;
  private readonly _linePipe:      GPURenderPipeline;
  private readonly _lineRearPipe:  GPURenderPipeline;
  private readonly _uniBuf:    GPUBuffer;

  private _triBuf:  GPUBuffer | null = null;
  private _triCap = 0;
  private _lineBuf: GPUBuffer | null = null;
  private _lineCap = 0;

  constructor(device: GPUDevice, swapChainFormat: GPUTextureFormat) {
    this.device  = device;
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

    const vertState: GPUVertexState = {
      module: vertMod, entryPoint: 'vs_main',
      buffers: [{
        arrayStride: GIZMO_VERTEX_STRIDE,
        attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x4' },
        ],
      }],
    };

    const fragState: GPUFragmentState = {
      module: fragMod, entryPoint: 'fs_main',
      targets: [{
        format: swapChainFormat,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    };

    const depthStencil: GPUDepthStencilState = {
      format: 'depth24plus-stencil8',
      depthWriteEnabled: false,
      depthCompare: 'always',
    };

    this._triPipe = device.createRenderPipeline({
      layout, vertex: vertState, fragment: fragState, depthStencil,
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    this._linePipe = device.createRenderPipeline({
      layout, vertex: vertState, fragment: fragState, depthStencil,
      primitive: { topology: 'line-list', cullMode: 'none' },
    });

    // Rear-edge pipeline: only fires where fragment depth > scene depth (edge is occluded).
    // Uses a diagonal stipple pattern to clearly distinguish hidden edges from visible ones.
    const rearFragMod = device.createShaderModule({ code: REAR_EDGE_FRAG_SHADER });
    this._lineRearPipe = device.createRenderPipeline({
      layout,
      vertex: vertState,
      fragment: {
        module: rearFragMod, entryPoint: 'fs_stipple',
        targets: [{
          format: swapChainFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'greater',
      },
      primitive: { topology: 'line-list', cullMode: 'none' },
    });
  }

  // ── Main draw call ────────────────────────────────────────────────────────

  draw(pass: GPURenderPassEncoder, data: MeshEditDrawData, camera: Camera3D): void {
    const { mesh, selection, mode } = data;
    const em = mesh.editMesh;
    if (!em) return;

    // Upload VP + identity model
    const vp = camera.getViewProjectionMatrix();
    const uData = new Float32Array(32);
    uData.set(vp as Float32Array, 0);
    uData[16] = 1; uData[21] = 1; uData[26] = 1; uData[31] = 1; // identity model
    this.device.queue.writeBuffer(this._uniBuf, 0, uData);

    // Camera right/up for billboard vertex dots
    // gl-matrix column-major view matrix: right=(m[0],m[4],m[8]), up=(m[1],m[5],m[9])
    const vm = camera.getViewMatrix();
    const rx = vm[0], ry = vm[4], rz = vm[8];
    const ux = vm[1], uy = vm[5], uz = vm[9];

    // Object → world space helper
    const lm = mesh.localMatrix as Float32Array;
    const toW = (ox: number, oy: number, oz: number): [number, number, number] => [
      lm[0]*ox + lm[4]*oy + lm[8]*oz  + lm[12],
      lm[1]*ox + lm[5]*oy + lm[9]*oz  + lm[13],
      lm[2]*ox + lm[6]*oy + lm[10]*oz + lm[14],
    ];

    const triV: number[] = [];
    const lineV: number[] = [];

    // ── 0. UV cross-highlight hover tint ──────────────────────────────────
    if (data.hoveredFaces) {
      for (const fi of data.hoveredFaces) {
        const face = em.faces[fi];
        if (!face) continue;
        const wv: [number, number, number][] = [];
        let hi = face.halfEdge;
        for (let guard = 0; guard < 64; guard++) {
          const v = em.vertices[em.halfEdges[hi].vertex];
          wv.push(toW(v.x, v.y, v.z));
          hi = em.halfEdges[hi].next;
          if (hi === face.halfEdge) break;
        }
        if (wv.length < 3) continue;
        const w0 = wv[0];
        for (let i = 1; i < wv.length - 1; i++) {
          pushV(triV, w0,    C_HOVER_FACE);
          pushV(triV, wv[i], C_HOVER_FACE);
          pushV(triV, wv[i + 1], C_HOVER_FACE);
        }
      }
    }

    // ── 1. Face fills (selected faces, triangle-list) ─────────────────────
    if (mode === 'face' && selection) {
      for (const fi of selection.faces) {
        const face = em.faces[fi];
        if (!face) continue;
        const wv: [number, number, number][] = [];
        let hi = face.halfEdge;
        for (let guard = 0; guard < 64; guard++) {
          const v = em.vertices[em.halfEdges[hi].vertex];
          wv.push(toW(v.x, v.y, v.z));
          hi = em.halfEdges[hi].next;
          if (hi === face.halfEdge) break;
        }
        if (wv.length < 3) continue;
        const w0 = wv[0];
        for (let i = 1; i < wv.length - 1; i++) {
          pushV(triV, w0,    C_SEL_FACE);
          pushV(triV, wv[i], C_SEL_FACE);
          pushV(triV, wv[i + 1], C_SEL_FACE);
        }
      }
    }

    // ── 2. Vertex billboard quads (all vertices) ──────────────────────────
    for (let vi = 0; vi < em.vertices.length; vi++) {
      const v = em.vertices[vi];
      const [wx, wy, wz] = toW(v.x, v.y, v.z);
      const isSel = mode === 'vertex' && !!selection?.vertices.has(vi);
      const col   = isSel ? C_SEL_VERT : C_UNSEL_VERT;
      const h     = isSel ? VERT_HALF_SEL : VERT_HALF;
      // Four corners of the billboard quad
      const x0 = wx + (-rx - ux) * h, y0 = wy + (-ry - uy) * h, z0 = wz + (-rz - uz) * h;
      const x1 = wx + ( rx - ux) * h, y1 = wy + ( ry - uy) * h, z1 = wz + ( rz - uz) * h;
      const x2 = wx + (-rx + ux) * h, y2 = wy + (-ry + uy) * h, z2 = wz + (-rz + uz) * h;
      const x3 = wx + ( rx + ux) * h, y3 = wy + ( ry + uy) * h, z3 = wz + ( rz + uz) * h;
      // Two triangles (CCW): (bl, br, tl), (br, tr, tl)
      triV.push(x0, y0, z0, col[0], col[1], col[2], col[3]);
      triV.push(x1, y1, z1, col[0], col[1], col[2], col[3]);
      triV.push(x2, y2, z2, col[0], col[1], col[2], col[3]);
      triV.push(x1, y1, z1, col[0], col[1], col[2], col[3]);
      triV.push(x3, y3, z3, col[0], col[1], col[2], col[3]);
      triV.push(x2, y2, z2, col[0], col[1], col[2], col[3]);
    }

    // ── 3. Edge wireframe (unique edges, line-list) ───────────────────────
    for (let hi = 0; hi < em.halfEdges.length; hi++) {
      const he = em.halfEdges[hi];
      if (he.twin >= 0 && he.twin < hi) continue; // skip duplicate of each pair
      const vTo   = em.vertices[he.vertex];
      const vFrom = em.vertices[em.halfEdges[he.prev].vertex];
      const wTo   = toW(vTo.x, vTo.y, vTo.z);
      const wFrom = toW(vFrom.x, vFrom.y, vFrom.z);
      const isSel  = mode === 'edge' && !!selection?.edges.has(hi);
      const col    = isSel ? C_SEL_EDGE : he.isSeam ? C_SEAM_EDGE : C_UNSEL_EDGE;
      lineV.push(wFrom[0], wFrom[1], wFrom[2], col[0], col[1], col[2], col[3]);
      lineV.push(wTo[0],   wTo[1],   wTo[2],   col[0], col[1], col[2], col[3]);
    }

    // ── Upload and draw tri geometry ──────────────────────────────────────
    if (triV.length > 0) {
      const bytes = triV.length * 4;
      if (!this._triBuf || this._triCap < bytes) {
        this._triBuf?.destroy();
        this._triCap  = Math.max(bytes, 512 * GIZMO_VERTEX_STRIDE);
        this._triBuf  = this.device.createBuffer({ size: this._triCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      this.device.queue.writeBuffer(this._triBuf, 0, new Float32Array(triV));
      const bg = this.device.createBindGroup({ layout: this._bgl, entries: [{ binding: 0, resource: { buffer: this._uniBuf } }] });
      pass.setPipeline(this._triPipe);
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, this._triBuf);
      pass.draw(triV.length / 7);
    }

    // ── Upload and draw line geometry ─────────────────────────────────────
    if (lineV.length > 0) {
      const bytes = lineV.length * 4;
      if (!this._lineBuf || this._lineCap < bytes) {
        this._lineBuf?.destroy();
        this._lineCap  = Math.max(bytes, 256 * GIZMO_VERTEX_STRIDE);
        this._lineBuf  = this.device.createBuffer({ size: this._lineCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      this.device.queue.writeBuffer(this._lineBuf, 0, new Float32Array(lineV));
      const bg = this.device.createBindGroup({ layout: this._bgl, entries: [{ binding: 0, resource: { buffer: this._uniBuf } }] });

      // Front/visible edges — always-on-top solid lines (existing behaviour).
      pass.setPipeline(this._linePipe);
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, this._lineBuf);
      pass.draw(lineV.length / 7);

      // Rear/occluded edges — stippled dashes only where depth test fails.
      pass.setPipeline(this._lineRearPipe);
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, this._lineBuf);
      pass.draw(lineV.length / 7);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy(): void {
    this._uniBuf.destroy();
    this._triBuf?.destroy();
    this._lineBuf?.destroy();
  }
}

// ── Module-private helper ─────────────────────────────────────────────────────

function pushV(
  arr: number[],
  w: [number, number, number],
  col: readonly [number, number, number, number],
): void {
  arr.push(w[0], w[1], w[2], col[0], col[1], col[2], col[3]);
}
