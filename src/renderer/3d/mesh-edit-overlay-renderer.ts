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

import { PipelineSet, type PipelineHandle } from '../core/gpu-pipeline-cache';
import { GIZMO_VERTEX_SHADER, GIZMO_FRAGMENT_SHADER, GIZMO_VERTEX_STRIDE, GIZMO_UNIFORM_SIZE } from './shaders/gizmo-shaders';
import type { Camera3D } from './camera-3d';
import { RD } from './render-debug';
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
  /** Draw the edge wireframe over the 3D mesh. Defaults to true (omit/undefined → shown).
   *  The UV editor's "Wireframe" toggle sets this false in UV/paint mode so the model isn't
   *  caged in white edges while painting. Selected-edge highlights ride this pass too, but in
   *  UV/paint mode selection is null, so nothing useful is lost when it's off. */
  showWireframe?: boolean;
}

// ── Renderer ─────────────────────────────────────────────────────────────────

export class MeshEditOverlayRenderer {
  private readonly device: GPUDevice;
  private readonly _bgl:           GPUBindGroupLayout;
  // P2: non-blocking cache handles; draw() is skipped until all three compiled.
  private readonly _pipes: PipelineSet;
  private readonly _triPipe:       PipelineHandle<GPURenderPipeline>;
  private readonly _linePipe:      PipelineHandle<GPURenderPipeline>;
  private readonly _lineRearPipe:  PipelineHandle<GPURenderPipeline>;
  private readonly _uniBuf:    GPUBuffer;

  private _triBuf:  GPUBuffer | null = null;
  private _triCap = 0;
  private _lineBuf: GPUBuffer | null = null;
  private _lineCap = 0;

  // PERF (audit 5.13): persistent staging arrays for the per-frame vertex
  // uploads — sized alongside the vertex buffers and reused while capacity
  // suffices, so pointer-move vertex drags stop allocating a fresh
  // Float32Array (and, with the 1.5x headroom below, stop recreating GPU
  // buffers) on every frame.
  private _triScratch:  Float32Array | null = null;
  private _lineScratch: Float32Array | null = null;
  private readonly _uniScratch = new Float32Array(32);   // VP + identity model staging
  // The single uniform buffer is created once in the constructor and never
  // recreated, so its bind group can be built once and reused (audit 5.13).
  private readonly _uniBG: GPUBindGroup;

  constructor(device: GPUDevice, swapChainFormat: GPUTextureFormat) {
    this.device  = device;
    this._pipes = new PipelineSet(device);
    this._uniBuf = device.createBuffer({
      size:  GIZMO_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vertMod = device.createShaderModule({ code: GIZMO_VERTEX_SHADER });
    const fragMod = device.createShaderModule({ code: GIZMO_FRAGMENT_SHADER });

    this._bgl = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this._uniBG = device.createBindGroup({
      layout: this._bgl,
      entries: [{ binding: 0, resource: { buffer: this._uniBuf } }],
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

    this._triPipe = this._pipes.render({ label: 'MeshEditTri',
      layout, vertex: vertState, fragment: fragState, depthStencil,
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    this._linePipe = this._pipes.render({ label: 'MeshEditLine',
      layout, vertex: vertState, fragment: fragState, depthStencil,
      primitive: { topology: 'line-list', cullMode: 'none' },
    });

    // Rear-edge pipeline: only fires where fragment depth > scene depth (edge is occluded).
    // Uses a diagonal stipple pattern to clearly distinguish hidden edges from visible ones.
    const rearFragMod = device.createShaderModule({ code: REAR_EDGE_FRAG_SHADER });
    this._lineRearPipe = this._pipes.render({ label: 'MeshEditLineRear',
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
    if (!this._pipes.ready()) return;   // P2: overlay appears once its pipelines compiled
    const { mesh, selection, mode } = data;
    const em = mesh.editMesh;
    if (!em) return;

    // Upload VP + identity model (persistent scratch — audit 5.13)
    const vp = camera.getViewProjectionMatrix();
    const uData = this._uniScratch;
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

    const lineV: number[] = [];

    // ── 0–2. Fills + vertex dots (triangle-list) ──────────────────────────
    // TOUCH-9/10 perf: the tri VB (UV hover tint, selected-face fills, one camera-facing quad per vertex) is rebuilt
    // only when something it is made of changed — the camera's right / up axes, the selection, the hover tint, or
    // the edit mesh / local matrix (which the wireframe snapshot below compares exactly when the wireframe is on).
    // It used to be rebuilt every frame through a growing number[] + a tuple per vertex, then copied and uploaded.
    const showWire = data.showWireframe !== false;
    const wireDirty = this._wireframeChanged(em, lm, mode, selection, showWire);
    const geomSame = showWire && !wireDirty;
    if (!this._triInputsSame(rx, ry, rz, ux, uy, uz, mode, selection, data.hoveredFaces) || !geomSame) {
      const fill: number[] = [];
      const fillFaces = (faces: Iterable<number>, col: readonly [number, number, number, number]) => {
        for (const fi of faces) {
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
            pushV(fill, w0,        col);
            pushV(fill, wv[i],     col);
            pushV(fill, wv[i + 1], col);
          }
        }
      };
      // 0. UV cross-highlight hover tint
      if (data.hoveredFaces) fillFaces(data.hoveredFaces, C_HOVER_FACE);
      // 1. Face fills (selected faces)
      if (mode === 'face' && selection) fillFaces(selection.faces, C_SEL_FACE);
      // 2. Vertex billboard quads — mesh-edit mode only (in UV / paint mode, selection === null, the orange vertex
      //    handles are just clutter on the model). Written straight into the staging array.
      const V = em.vertices;
      const total = fill.length + (selection ? V.length * 42 : 0);
      if (!this._triScratch || this._triScratch.length < total) {
        this._triScratch = new Float32Array(Math.max(512 * 7, Math.ceil(total * 1.5)));
      }
      const out = this._triScratch;
      out.set(fill, 0);
      let o = fill.length;
      if (selection) {
        const m = lm;
        for (let vi = 0; vi < V.length; vi++) {
          const v = V[vi];
          if (!v) continue;
          const wx = m[0]*v.x + m[4]*v.y + m[8]*v.z  + m[12];
          const wy = m[1]*v.x + m[5]*v.y + m[9]*v.z  + m[13];
          const wz = m[2]*v.x + m[6]*v.y + m[10]*v.z + m[14];
          const isSel = mode === 'vertex' && selection.vertices.has(vi);
          const col   = isSel ? C_SEL_VERT : C_UNSEL_VERT;
          const h     = isSel ? VERT_HALF_SEL : VERT_HALF;
          // Four corners of the billboard quad; two triangles (CCW): (bl, br, tl), (br, tr, tl)
          const x0 = wx + (-rx - ux) * h, y0 = wy + (-ry - uy) * h, z0 = wz + (-rz - uz) * h;
          const x1 = wx + ( rx - ux) * h, y1 = wy + ( ry - uy) * h, z1 = wz + ( rz - uz) * h;
          const x2 = wx + (-rx + ux) * h, y2 = wy + (-ry + uy) * h, z2 = wz + (-rz + uz) * h;
          const x3 = wx + ( rx + ux) * h, y3 = wy + ( ry + uy) * h, z3 = wz + ( rz + uz) * h;
          o = putV(out, o, x0, y0, z0, col); o = putV(out, o, x1, y1, z1, col); o = putV(out, o, x2, y2, z2, col);
          o = putV(out, o, x1, y1, z1, col); o = putV(out, o, x3, y3, z3, col); o = putV(out, o, x2, y2, z2, col);
        }
      }
      this._triFloats = o;
      this.triBuilds++;
      if (o > 0) {
        const bytes = o * 4;
        if (!this._triBuf || this._triCap < bytes) {
          this._triBuf?.destroy();
          // 1.5x headroom (4-byte aligned) so growth during vertex drags recreates the buffer rarely (audit 5.13).
          this._triCap  = Math.max((Math.ceil(bytes * 1.5) + 3) & ~3, 512 * GIZMO_VERTEX_STRIDE);
          this._triBuf  = this.device.createBuffer({ size: this._triCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        this.device.queue.writeBuffer(this._triBuf, 0, out, 0, o);
      }
    }

    // ── 3. Edge wireframe (unique edges, line-list) ───────────────────────
    // Skipped when the UV editor's "Wireframe" toggle is off (showWireframe === false).
    // P4 (mobile-parity 7.3b): the wireframe doesn't depend on the camera, so its vertex buffer is rebuilt only when
    // something it is made of changed (see _wireframeChanged — an exact compare, no version counters to miss).
    if (wireDirty && showWire) for (let hi = 0; hi < em.halfEdges.length; hi++) {
      const he = em.halfEdges[hi];
      if (he.twin >= 0 && he.twin < hi) continue; // skip duplicate of each pair
      const prevHe = em.halfEdges[he.prev];
      const vTo   = em.vertices[he.vertex];
      const vFrom = prevHe ? em.vertices[prevHe.vertex] : undefined;
      if (!vTo || !vFrom) continue; // degenerate / non-manifold edit mesh (e.g. a procedural soup) — skip
      const wTo   = toW(vTo.x, vTo.y, vTo.z);
      const wFrom = toW(vFrom.x, vFrom.y, vFrom.z);
      const isSel  = mode === 'edge' && !!selection?.edges.has(hi);
      const col    = isSel ? C_SEL_EDGE : he.isSeam ? C_SEAM_EDGE : C_UNSEL_EDGE;
      lineV.push(wFrom[0], wFrom[1], wFrom[2], col[0], col[1], col[2], col[3]);
      lineV.push(wTo[0],   wTo[1],   wTo[2],   col[0], col[1], col[2], col[3]);
    }

    // ── Draw tri geometry (uploaded only when rebuilt, above) ─────────────
    if (this._triFloats > 0 && this._triBuf) {
      pass.setPipeline(this._triPipe.get()!);
      pass.setBindGroup(0, this._uniBG);   // cached — uniform buffer never recreated
      pass.setVertexBuffer(0, this._triBuf);
      pass.draw(this._triFloats / 7);
    }

    // ── Upload (only when rebuilt) and draw line geometry ─────────────────
    if (wireDirty) {
      this._lineFloats = lineV.length;
      if (lineV.length > 0) {
        const bytes = lineV.length * 4;
        if (!this._lineBuf || this._lineCap < bytes) {
          this._lineBuf?.destroy();
          // PERF (audit 5.13): same 1.5x headroom as the tri buffer above.
          this._lineCap  = Math.max((Math.ceil(bytes * 1.5) + 3) & ~3, 256 * GIZMO_VERTEX_STRIDE);
          this._lineBuf  = this.device.createBuffer({ size: this._lineCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        if (!this._lineScratch || this._lineScratch.length < lineV.length) {
          this._lineScratch = new Float32Array(this._lineCap / 4);
        }
        this._lineScratch.set(lineV);
        this.device.queue.writeBuffer(this._lineBuf, 0, this._lineScratch, 0, lineV.length);
      }
    }
    if (this._lineFloats > 0 && this._lineBuf) {
      // Front/visible edges — always-on-top solid lines (existing behaviour).
      pass.setPipeline(this._linePipe.get()!);
      pass.setBindGroup(0, this._uniBG);   // cached — uniform buffer never recreated
      pass.setVertexBuffer(0, this._lineBuf);
      pass.draw(this._lineFloats / 7);

      // Rear/occluded edges — stippled dashes only where depth test fails. (Render debug noRearEdges skips them.)
      if (!(RD.on && RD.f.noRearEdges)) {
      pass.setPipeline(this._lineRearPipe.get()!);
      pass.setBindGroup(0, this._uniBG);
      pass.setVertexBuffer(0, this._lineBuf);
      pass.draw(this._lineFloats / 7);
      }
    }
  }

  // ── Tri cache (fills + vertex dots) ───────────────────────────────────────
  /** Floats in the cached tri VB (0 = nothing to draw). */
  private _triFloats = 0;
  private readonly _tcCam = new Float64Array(6);
  private _tcMode: MeshEditSelectionMode | null = null;
  private _tcHasSel = false;
  private _tcVSel: number[] = [];
  private _tcFSel: number[] = [];
  private _tcHover: number[] | null = null;
  /** Diagnostics / tests: tri VB rebuilds. */
  public triBuilds = 0;

  /** True when the tri VB's non-geometry inputs (camera right / up, mode, selection, hover tint) equal the last
   *  build's — the caller checks the geometry. The snapshot is refreshed when they differ. */
  private _triInputsSame(
    rx: number, ry: number, rz: number, ux: number, uy: number, uz: number,
    mode: MeshEditSelectionMode, selection: EditSelection | null, hovered: Set<number> | undefined,
  ): boolean {
    const C = this._tcCam;
    const vSel = selection && mode === 'vertex' ? selection.vertices : null;
    const fSel = selection && mode === 'face' ? selection.faces : null;
    const setEq = (a: number[], b: Set<number> | null) => (b ? a.length === b.size && a.every(x => b.has(x)) : a.length === 0);
    const same = this.triBuilds > 0
      && C[0] === rx && C[1] === ry && C[2] === rz && C[3] === ux && C[4] === uy && C[5] === uz
      && this._tcMode === mode && this._tcHasSel === !!selection
      && setEq(this._tcVSel, vSel) && setEq(this._tcFSel, fSel)
      && (hovered ? !!this._tcHover && setEq(this._tcHover, hovered) : this._tcHover === null);
    if (!same) {
      C[0] = rx; C[1] = ry; C[2] = rz; C[3] = ux; C[4] = uy; C[5] = uz;
      this._tcMode = mode; this._tcHasSel = !!selection;
      this._tcVSel = vSel ? [...vSel] : [];
      this._tcFSel = fSel ? [...fSel] : [];
      this._tcHover = hovered ? [...hovered] : null;
    }
    return same;
  }

  // ── Wireframe cache (P4) ──────────────────────────────────────────────────
  // The line VB holds world-space edge endpoints + colours: a function of the edit mesh (vertex positions, half-edge
  // topology, seams), the mesh's local matrix, the selection mode + selected edges (edge mode) and the wireframe
  // toggle. Nothing camera-dependent. Each frame those inputs are compared EXACTLY against a snapshot of the last
  // build (no version counters — vertex drags and seam edits write the edit mesh in place), which costs a read of
  // the arrays but none of the build: no per-edge tuples, no number[] growth, no upload.
  /** Floats in the cached line VB (0 = nothing to draw). */
  private _lineFloats = 0;
  private _wfEm: unknown = null;
  private _wfShow = false;
  private _wfEdgeSel = false;
  private readonly _wfLm = new Float64Array(16);
  private _wfVRef: unknown[] = [];
  private _wfPos = new Float64Array(0);
  private _wfHe = new Int32Array(0);
  private _wfSel: number[] = [];
  /** Diagnostics / tests: wireframe VB rebuilds. */
  public wireframeBuilds = 0;

  /** True (and the snapshot refreshed) when the wireframe's inputs differ from the last build's. */
  private _wireframeChanged(
    em: NonNullable<Mesh3D['editMesh']>, lm: Float32Array, mode: MeshEditSelectionMode,
    selection: EditSelection | null, show: boolean,
  ): boolean {
    const edgeSel = mode === 'edge' && !!selection;
    let same = this._wfEm === em && this._wfShow === show && this._wfEdgeSel === edgeSel;
    if (same) for (let i = 0; i < 16; i++) if (this._wfLm[i] !== lm[i]) { same = false; break; }
    const V = em.vertices, H = em.halfEdges;
    if (same && show) {
      if (this._wfVRef.length !== V.length || this._wfHe.length !== H.length * 4) same = false;
      else {
        const P = this._wfPos, R = this._wfVRef;
        for (let i = 0; i < V.length; i++) {
          const v = V[i];
          if (R[i] !== v || (v && (P[i * 3] !== v.x || P[i * 3 + 1] !== v.y || P[i * 3 + 2] !== v.z))) { same = false; break; }
        }
        if (same) {
          const E = this._wfHe;
          for (let i = 0; i < H.length; i++) {
            const he = H[i], o = i * 4;
            if (E[o] !== he.twin || E[o + 1] !== he.prev || E[o + 2] !== he.vertex || E[o + 3] !== (he.isSeam ? 1 : 0)) { same = false; break; }
          }
        }
        if (same && edgeSel) {
          const sel = selection!.edges;
          if (sel.size !== this._wfSel.length) same = false;
          else for (const e of this._wfSel) if (!sel.has(e)) { same = false; break; }
        }
      }
    }
    if (same) return false;
    // Changed → snapshot what this build reads.
    this._wfEm = em; this._wfShow = show; this._wfEdgeSel = edgeSel;
    for (let i = 0; i < 16; i++) this._wfLm[i] = lm[i];
    if (show) {
      if (this._wfPos.length !== V.length * 3) this._wfPos = new Float64Array(V.length * 3);
      this._wfVRef.length = V.length;
      for (let i = 0; i < V.length; i++) {
        const v = V[i];
        this._wfVRef[i] = v;
        if (v) { this._wfPos[i * 3] = v.x; this._wfPos[i * 3 + 1] = v.y; this._wfPos[i * 3 + 2] = v.z; }
      }
      if (this._wfHe.length !== H.length * 4) this._wfHe = new Int32Array(H.length * 4);
      for (let i = 0; i < H.length; i++) {
        const he = H[i], o = i * 4;
        this._wfHe[o] = he.twin; this._wfHe[o + 1] = he.prev; this._wfHe[o + 2] = he.vertex; this._wfHe[o + 3] = he.isSeam ? 1 : 0;
      }
      this._wfSel = edgeSel ? [...selection!.edges] : [];
    } else {
      this._wfVRef.length = 0; this._wfPos = new Float64Array(0); this._wfHe = new Int32Array(0); this._wfSel = [];
    }
    this.wireframeBuilds++;
    return true;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy(): void {
    this._uniBuf.destroy();
    this._triBuf?.destroy();
    this._lineBuf?.destroy();
  }
}

// ── Module-private helper ─────────────────────────────────────────────────────

/** Write one vertex (position + colour, 7 floats) at `o`; returns the next offset. */
function putV(out: Float32Array, o: number, x: number, y: number, z: number, col: readonly [number, number, number, number]): number {
  out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = col[0]; out[o + 4] = col[1]; out[o + 5] = col[2]; out[o + 6] = col[3];
  return o + 7;
}

function pushV(
  arr: number[],
  w: [number, number, number],
  col: readonly [number, number, number, number],
): void {
  arr.push(w[0], w[1], w[2], col[0], col[1], col[2], col[3]);
}
