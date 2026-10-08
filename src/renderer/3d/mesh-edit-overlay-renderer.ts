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
import { triangulateFace } from '../../scene-graph/shapes/edit-mesh-render';
import { forEachPointImage, forEachSegmentImage, forEachPolygonImage, mirrorPlanesKey } from '../../scene-graph/shapes/edit-mesh-mirror';

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
/** Sharp (hard) edge — cyan, as Blender draws Mark Sharp (EditMesh.setSharpEdges / sm.setSharpEdges3D). */
const C_SHARP_EDGE:  readonly [number, number, number, number] = [0.2, 0.85, 1.0, 1.0];
// Selection readability (UI review 2026-10-07 §3 #19, Blender's convention): vertex dots only in Vertex mode — black
// unselected / orange selected, each on a contrasting rim so it reads on a dark mesh and a light background alike;
// face dots (the face centres) only in Face mode; a selected face = a light orange fill + a 3 px orange outline; a
// selected edge = 3 px (and in Vertex mode, an edge whose two ends are selected).
const C_UNSEL_VERT:  readonly [number, number, number, number] = [0.04, 0.04, 0.04, 1.0];
const C_UNSEL_RIM:   readonly [number, number, number, number] = [0.92, 0.92, 0.92, 0.85];
const C_SEL_VERT:    readonly [number, number, number, number] = [1.0, 0.55, 0.0,  1.0];
const C_SEL_RIM:     readonly [number, number, number, number] = [0.05, 0.03, 0.0,  0.9];
const C_SEL_FACE:    readonly [number, number, number, number] = [1.0, 0.62, 0.15, 0.38];
const C_SEL_OUTLINE: readonly [number, number, number, number] = [1.0, 0.55, 0.0,  1.0];
/** Chamfer / Bevel guide (dashed bisector through each target) — the knife preview's yellow. */
const C_GUIDE:       readonly [number, number, number, number] = [1.0, 0.9, 0.3, 1.0];
/** The mirror plane handle (sm.setMirrorPlaneHandle3D): a translucent quad + its outline. */
const C_PLANE_FILL:  readonly [number, number, number, number] = [0.35, 0.75, 1.0, 0.14];
const C_PLANE_EDGE:  readonly [number, number, number, number] = [0.35, 0.75, 1.0, 0.95];
/** A plane mirror's COPY side (edit-mesh-mirror.ts images): the same overlay colours at this fraction of their alpha. */
const MIRROR_COPY_ALPHA = 0.4;
/** UV cross-highlight tint (cyan): shown when hovering in the UV canvas pane. */
const C_HOVER_FACE:  readonly [number, number, number, number] = [0.3, 0.85, 1.0,  0.20];

/** World-space half-size of a vertex dot billboard quad — the fallback when the viewport height is unknown (tests);
 *  with it, the screen sizes below (CSS-independent device pixels) are used. */
const VERT_HALF = 0.008;
/** Screen half-sizes in pixels: vertex dot core / rim, selected vertex core / rim, face dot core / rim, thick edge. */
const PX_VERT = 3, PX_VERT_RIM = 4.5, PX_VERT_SEL = 4, PX_VERT_SEL_RIM = 5.5;
const PX_FACE = 2.5, PX_FACE_RIM = 3.5;
const PX_EDGE_HALF = 1.5;   // a 3 px selected edge / face outline

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
  /** Chamfer / Bevel tool guides: world-space segment endpoints (xyz pairs, a line list — the tool already dashed
   *  them), drawn on top in {@link C_GUIDE}. */
  guides?: Float32Array | null;
  /** The transform gizmo on the selection (Edit Mesh element transforms, docs/specs/edit-mesh-topology.md §11): drawn
   *  by the renderer's gizmo at `center` (world), oriented by `rotation` (null = world axes), on top of the overlay.
   *  Absent / null = no gizmo (nothing selected, no gizmo mode, a modal G / R / S running). */
  gizmo?: MeshEditGizmoDraw | null;
  /** The mirror plane handle's quad (sm.setMirrorPlaneHandle3D): 4 world-space corners (xyz × 4, around the quad),
   *  drawn as a translucent fill + outline. Absent / null = hidden. */
  mirrorPlane?: Float32Array | null;
}

/** The Edit Mesh selection gizmo as the renderer draws it. */
export interface MeshEditGizmoDraw {
  center: [number, number, number];
  rotation: Float32Array | null;
  mode: 'move' | 'rotate' | 'scale';
  hovered: 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' | null;
  dragging: 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' | null;
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

  draw(pass: GPURenderPassEncoder, data: MeshEditDrawData, camera: Camera3D, viewportHeight?: number): void {
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
    const bx = vm[2], by = vm[6], bz = vm[10];   // camera back axis (toward the viewer)

    // Screen-size handles: world units per pixel at a point (ortho: constant; perspective: grows with the depth). No
    // viewport height (tests, an old caller) → the old fixed world size.
    const H = viewportHeight && viewportHeight > 0 ? viewportHeight : 0;
    const persp = H > 0 && camera.mode === 'perspective';
    const camPos = persp ? camera.position : null;
    const orthoWpp = H > 0 && !persp ? (2 * camera.orthoSize) / H : 0;
    const perspK = persp ? (2 * Math.tan(Math.max(0.01, camera.fov) * 0.5)) / H : 0;
    const wpp = (x: number, y: number, z: number): number => {
      if (orthoWpp > 0) return orthoWpp;
      if (camPos) return Math.max(1e-6, ((camPos[0] - x) * bx + (camPos[1] - y) * by + (camPos[2] - z) * bz) * perspK);
      return VERT_HALF / PX_VERT;
    };

    // Object → world space helper
    const lm = mesh.localMatrix as Float32Array;
    const toW = (ox: number, oy: number, oz: number): [number, number, number] => [
      lm[0]*ox + lm[4]*oy + lm[8]*oz  + lm[12],
      lm[1]*ox + lm[5]*oy + lm[9]*oz  + lm[13],
      lm[2]*ox + lm[6]*oy + lm[10]*oz + lm[14],
    ];

    const lineV: number[] = [];

    // Plane mirrors (bisect / face mode) of the stack: the overlay shows each element where the modifier output has it
    // — clipped to the real side, plus its reflections (fainter) on the copy side; the discarded part is not drawn.
    const planes = typeof em.mirrorPlanes === 'function' ? em.mirrorPlanes() : [];   // (test doubles: a plain edit mesh)
    const mirrored = planes.length > 0;
    const planesKey = mirrored ? mirrorPlanesKey(planes) : '';
    const faint = (c: readonly [number, number, number, number]): [number, number, number, number] => [c[0], c[1], c[2], c[3] * MIRROR_COPY_ALPHA];

    // ── 0–2. Fills, then (drawn over the wireframe) thick selected edges + dots (triangle-list) ──────────────────
    // TOUCH-9/10 perf: the tri VB is rebuilt only when something it is made of changed — the camera axes / pixel
    // scale, the selection, the hover tint, or the edit mesh / local matrix (which the wireframe snapshot below
    // compares exactly when the wireframe is on). Two ranges: [fills | handles]; the fills go under the wireframe.
    const showWire = data.showWireframe !== false;
    const wireDirty = this._wireframeChanged(em, lm, mode, selection, showWire, planesKey);
    const geomSame = showWire && !wireDirty;
    const scaleKey = orthoWpp > 0 ? orthoWpp : camPos ? perspK : -1;
    if (!this._triInputsSame(rx, ry, rz, ux, uy, uz, mode, selection, data.hoveredFaces, scaleKey,
      camPos ? camPos[0] : 0, camPos ? camPos[1] : 0, camPos ? camPos[2] : 0) || !geomSame) {
      const fill: number[] = [];
      const faceVerts = (fi: number): number[] | null => {
        const face = em.faces[fi];
        if (!face) return null;
        const vs: number[] = [];
        let hi = face.halfEdge;
        for (let guard = 0; guard < 64; guard++) {
          vs.push(em.halfEdges[hi].vertex);
          hi = em.halfEdges[hi].next;
          if (hi === face.halfEdge) break;
        }
        return vs.length >= 3 ? vs : null;
      };
      const fillFaces = (faces: Iterable<number>, col: readonly [number, number, number, number]) => {
        for (const fi of faces) {
          const vs = faceVerts(fi);
          if (!vs) continue;
          // The compile's own triangulation (a concave quad / n-gon fills inside its outline, not as a fan)
          const tri = triangulateFace(em.vertices, vs);
          if (mirrored) {
            // each triangle clipped to the real side + its reflections (fan-filled)
            const fc = faint(col);
            for (let t = 0; t + 2 < tri.length; t += 3) {
              const a = em.vertices[vs[tri[t]]], b = em.vertices[vs[tri[t + 1]]], c = em.vertices[vs[tri[t + 2]]];
              forEachPolygonImage(planes, [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], (poly, img) => {
                const k = poly.length / 3, cc = img ? fc : col;
                for (let j = 1; j + 1 < k; j++) {
                  pushV(fill, toW(poly[0], poly[1], poly[2]), cc);
                  pushV(fill, toW(poly[j * 3], poly[j * 3 + 1], poly[j * 3 + 2]), cc);
                  pushV(fill, toW(poly[j * 3 + 3], poly[j * 3 + 4], poly[j * 3 + 5]), cc);
                }
              });
            }
            continue;
          }
          for (const k of tri) {
            const v = em.vertices[vs[k]];
            pushV(fill, toW(v.x, v.y, v.z), col);
          }
        }
      };
      // 0. UV cross-highlight hover tint
      if (data.hoveredFaces) fillFaces(data.hoveredFaces, C_HOVER_FACE);
      // 1. Face fills (selected faces)
      if (mode === 'face' && selection) fillFaces(selection.faces, C_SEL_FACE);
      const fillFloats = fill.length;

      // 2. Handles — mesh-edit mode only (in UV / paint mode, selection === null, they are clutter on the model).
      const handles: number[] = [];
      const quad = (wx: number, wy: number, wz: number, h: number, col: readonly [number, number, number, number]) => {
        // Four corners of the billboard quad; two triangles (CCW): (bl, br, tl), (br, tr, tl)
        const x0 = wx + (-rx - ux) * h, y0 = wy + (-ry - uy) * h, z0 = wz + (-rz - uz) * h;
        const x1 = wx + ( rx - ux) * h, y1 = wy + ( ry - uy) * h, z1 = wz + ( rz - uz) * h;
        const x2 = wx + (-rx + ux) * h, y2 = wy + (-ry + uy) * h, z2 = wz + (-rz + uz) * h;
        const x3 = wx + ( rx + ux) * h, y3 = wy + ( ry + uy) * h, z3 = wz + ( rz + uz) * h;
        handles.push(x0, y0, z0, col[0], col[1], col[2], col[3], x1, y1, z1, col[0], col[1], col[2], col[3], x2, y2, z2, col[0], col[1], col[2], col[3]);
        handles.push(x1, y1, z1, col[0], col[1], col[2], col[3], x3, y3, z3, col[0], col[1], col[2], col[3], x2, y2, z2, col[0], col[1], col[2], col[3]);
      };
      /** A screen-width band from world p to world q (a 3 px line: WebGPU lines are always 1 px). */
      const band = (p: [number, number, number], q: [number, number, number], col: readonly [number, number, number, number]) => {
        const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
        // perpendicular in the screen plane: edge × camera back axis (an edge along the view: the camera up)
        let px = dy * bz - dz * by, py = dz * bx - dx * bz, pz = dx * by - dy * bx;
        const l = Math.hypot(px, py, pz);
        if (l < 1e-12) { px = ux; py = uy; pz = uz; } else { px /= l; py /= l; pz /= l; }
        const hp = PX_EDGE_HALF * wpp(p[0], p[1], p[2]), hq = PX_EDGE_HALF * wpp(q[0], q[1], q[2]);
        const a = [p[0] - px * hp, p[1] - py * hp, p[2] - pz * hp], b = [p[0] + px * hp, p[1] + py * hp, p[2] + pz * hp];
        const c = [q[0] - px * hq, q[1] - py * hq, q[2] - pz * hq], d = [q[0] + px * hq, q[1] + py * hq, q[2] + pz * hq];
        for (const v of [a, b, c, b, d, c]) handles.push(v[0], v[1], v[2], col[0], col[1], col[2], col[3]);
      };
      const V = em.vertices;
      if (selection) {
        // Thick selected edges: Edge mode = the selected edges; Face mode = the selected faces' outlines; Vertex mode =
        // the edges whose two ends are selected.
        const HE = em.halfEdges;
        const selOutlineCopy = faint(C_SEL_OUTLINE);
        const thick = (hi: number) => {
          const he = HE[hi], prev = HE[he.prev];
          const from = prev ? V[prev.vertex] : undefined, to = V[he.vertex];
          if (!from || !to) return;
          if (!mirrored) { band(toW(from.x, from.y, from.z), toW(to.x, to.y, to.z), C_SEL_OUTLINE); return; }
          forEachSegmentImage(planes, from.x, from.y, from.z, to.x, to.y, to.z, (ax, ay, az, bx, by, bz, img) => {
            band(toW(ax, ay, az), toW(bx, by, bz), img ? selOutlineCopy : C_SEL_OUTLINE);
          });
        };
        if (mode === 'edge') {
          for (const hi of selection.edges) if (HE[hi]) thick(hi);
        } else if (mode === 'face') {
          for (const fi of selection.faces) {
            const face = em.faces[fi];
            if (!face) continue;
            let hi = face.halfEdge;
            for (let guard = 0; guard < 64; guard++) { thick(hi); hi = HE[hi].next; if (hi === face.halfEdge) break; }
          }
        } else if (mode === 'vertex' && selection.vertices.size > 1) {
          for (let hi = 0; hi < HE.length; hi++) {
            const he = HE[hi];
            if (he.twin >= 0 && he.twin < hi) continue;
            const prev = HE[he.prev];
            if (prev && selection.vertices.has(he.vertex) && selection.vertices.has(prev.vertex)) thick(hi);
          }
        }
        // Dots: the vertices in Vertex mode, the face centres in Face mode (each a rim, then the core on top).
        if (mode === 'vertex') {
          const m = lm;
          const dot = (ox: number, oy: number, oz: number, isSel: boolean, img: number) => {
            const wx = m[0]*ox + m[4]*oy + m[8]*oz  + m[12];
            const wy = m[1]*ox + m[5]*oy + m[9]*oz  + m[13];
            const wz = m[2]*ox + m[6]*oy + m[10]*oz + m[14];
            const s = wpp(wx, wy, wz);
            const rim = isSel ? C_SEL_RIM : C_UNSEL_RIM, core = isSel ? C_SEL_VERT : C_UNSEL_VERT;
            quad(wx, wy, wz, (isSel ? PX_VERT_SEL_RIM : PX_VERT_RIM) * s, img ? faint(rim) : rim);
            quad(wx, wy, wz, (isSel ? PX_VERT_SEL : PX_VERT) * s, img ? faint(core) : core);
          };
          for (let vi = 0; vi < V.length; vi++) {
            const v = V[vi];
            if (!v) continue;
            if (mirrored) {
              const isSel = selection.vertices.has(vi);
              forEachPointImage(planes, v.x, v.y, v.z, (x, y, z, img) => dot(x, y, z, isSel, img));
              continue;
            }
            const wx = m[0]*v.x + m[4]*v.y + m[8]*v.z  + m[12];
            const wy = m[1]*v.x + m[5]*v.y + m[9]*v.z  + m[13];
            const wz = m[2]*v.x + m[6]*v.y + m[10]*v.z + m[14];
            const isSel = selection.vertices.has(vi);
            const s = wpp(wx, wy, wz);
            quad(wx, wy, wz, (isSel ? PX_VERT_SEL_RIM : PX_VERT_RIM) * s, isSel ? C_SEL_RIM : C_UNSEL_RIM);
            quad(wx, wy, wz, (isSel ? PX_VERT_SEL : PX_VERT) * s, isSel ? C_SEL_VERT : C_UNSEL_VERT);
          }
        } else if (mode === 'face') {
          for (let fi = 0; fi < em.faces.length; fi++) {
            const vs = faceVerts(fi);
            if (!vs) continue;
            if (mirrored) {
              // the face centre of each image of the face (real side clipped + reflections)
              const isSel = selection.faces.has(fi);
              const pts: number[] = [];
              for (const vi of vs) { const v = V[vi]; pts.push(v.x, v.y, v.z); }
              forEachPolygonImage(planes, pts, (poly, img) => {
                const k = poly.length / 3;
                let px = 0, py = 0, pz = 0;
                for (let j = 0; j < k; j++) { px += poly[j * 3]; py += poly[j * 3 + 1]; pz += poly[j * 3 + 2]; }
                const w = toW(px / k, py / k, pz / k);
                const s = wpp(w[0], w[1], w[2]);
                const rim = isSel ? C_SEL_RIM : C_UNSEL_RIM, core = isSel ? C_SEL_VERT : C_UNSEL_VERT;
                quad(w[0], w[1], w[2], PX_FACE_RIM * s, img ? faint(rim) : rim);
                quad(w[0], w[1], w[2], PX_FACE * s, img ? faint(core) : core);
              });
              continue;
            }
            let cx = 0, cy = 0, cz = 0;
            for (const vi of vs) { const v = V[vi]; cx += v.x; cy += v.y; cz += v.z; }
            const w = toW(cx / vs.length, cy / vs.length, cz / vs.length);
            const isSel = selection.faces.has(fi);
            const s = wpp(w[0], w[1], w[2]);
            quad(w[0], w[1], w[2], PX_FACE_RIM * s, isSel ? C_SEL_RIM : C_UNSEL_RIM);
            quad(w[0], w[1], w[2], PX_FACE * s, isSel ? C_SEL_VERT : C_UNSEL_VERT);
          }
        }
      }
      const total = fillFloats + handles.length;
      if (!this._triScratch || this._triScratch.length < total) {
        this._triScratch = new Float32Array(Math.max(512 * 7, Math.ceil(total * 1.5)));
      }
      const out = this._triScratch;
      out.set(fill, 0);
      out.set(handles, fillFloats);
      this._triFillFloats = fillFloats;
      this._triFloats = total;
      this.triBuilds++;
      if (total > 0) {
        const bytes = total * 4;
        if (!this._triBuf || this._triCap < bytes) {
          this._triBuf?.destroy();
          // 1.5x headroom (4-byte aligned) so growth during vertex drags recreates the buffer rarely (audit 5.13).
          this._triCap  = Math.max((Math.ceil(bytes * 1.5) + 3) & ~3, 512 * GIZMO_VERTEX_STRIDE);
          this._triBuf  = this.device.createBuffer({ size: this._triCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        this.device.queue.writeBuffer(this._triBuf, 0, out, 0, total);
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
      if (mirrored) {
        const isSelM = mode === 'edge' && !!selection?.edges.has(hi);
        const colM   = isSelM ? C_SEL_EDGE : he.isSeam ? C_SEAM_EDGE : he.isSharp ? C_SHARP_EDGE : C_UNSEL_EDGE;
        const colC   = faint(colM);
        forEachSegmentImage(planes, vFrom.x, vFrom.y, vFrom.z, vTo.x, vTo.y, vTo.z, (ax, ay, az, bx, by, bz, img) => {
          const c = img ? colC : colM, a = toW(ax, ay, az), b = toW(bx, by, bz);
          lineV.push(a[0], a[1], a[2], c[0], c[1], c[2], c[3], b[0], b[1], b[2], c[0], c[1], c[2], c[3]);
        });
        continue;
      }
      const wTo   = toW(vTo.x, vTo.y, vTo.z);
      const wFrom = toW(vFrom.x, vFrom.y, vFrom.z);
      const isSel  = mode === 'edge' && !!selection?.edges.has(hi);
      const col    = isSel ? C_SEL_EDGE : he.isSeam ? C_SEAM_EDGE : he.isSharp ? C_SHARP_EDGE : C_UNSEL_EDGE;
      lineV.push(wFrom[0], wFrom[1], wFrom[2], col[0], col[1], col[2], col[3]);
      lineV.push(wTo[0],   wTo[1],   wTo[2],   col[0], col[1], col[2], col[3]);
    }

    // ── Draw the fills (uploaded only when rebuilt, above) — under the wireframe ──
    if (this._triFillFloats > 0 && this._triBuf) {
      pass.setPipeline(this._triPipe.get()!);
      pass.setBindGroup(0, this._uniBG);   // cached — uniform buffer never recreated
      pass.setVertexBuffer(0, this._triBuf);
      pass.draw(this._triFillFloats / 7);
    }

    // ── The mirror plane handle's quad: translucent fill + outline (tiny; every frame while shown) ──
    const mq = data.mirrorPlane;
    if (mq && mq.length >= 12) {
      const floats = (6 + 8) * 7, bytes = floats * 4;
      if (!this._planeBuf) this._planeBuf = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      const o = this._planeScratch;
      let k = 0;
      const c = (i: number, col: readonly [number, number, number, number]) => { k = putV(o, k, mq[i * 3], mq[i * 3 + 1], mq[i * 3 + 2], col); };
      for (const i of [0, 1, 2, 0, 2, 3]) c(i, C_PLANE_FILL);
      for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]]) { c(a, C_PLANE_EDGE); c(b, C_PLANE_EDGE); }
      this.device.queue.writeBuffer(this._planeBuf, 0, o, 0, floats);
      pass.setPipeline(this._triPipe.get()!);
      pass.setBindGroup(0, this._uniBG);
      pass.setVertexBuffer(0, this._planeBuf);
      pass.draw(6);
      pass.setPipeline(this._linePipe.get()!);
      pass.setBindGroup(0, this._uniBG);
      pass.setVertexBuffer(0, this._planeBuf);
      pass.draw(8, 1, 6);
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

    // ── The handles (thick selected edges + dots) — over the wireframe ──
    const handleFloats = this._triFloats - this._triFillFloats;
    if (handleFloats > 0 && this._triBuf) {
      pass.setPipeline(this._triPipe.get()!);
      pass.setBindGroup(0, this._uniBG);
      pass.setVertexBuffer(0, this._triBuf);
      pass.draw(handleFloats / 7, 1, this._triFillFloats / 7);
    }

    // ── 4. Chamfer / Bevel guides (tiny; rebuilt every frame while the tool shows them) ──
    const gl = data.guides;
    if (gl && gl.length >= 6) {
      const nv = Math.floor(gl.length / 3), floats = nv * 7, bytes = floats * 4;
      if (!this._guideBuf || this._guideCap < bytes) {
        this._guideBuf?.destroy();
        this._guideCap = Math.max((Math.ceil(bytes * 1.5) + 3) & ~3, 64 * GIZMO_VERTEX_STRIDE);
        this._guideBuf = this.device.createBuffer({ size: this._guideCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      if (!this._guideScratch || this._guideScratch.length < floats) this._guideScratch = new Float32Array(this._guideCap / 4);
      let o = 0;
      for (let i = 0; i < nv; i++) o = putV(this._guideScratch, o, gl[i * 3], gl[i * 3 + 1], gl[i * 3 + 2], C_GUIDE);
      this.device.queue.writeBuffer(this._guideBuf, 0, this._guideScratch, 0, floats);
      pass.setPipeline(this._linePipe.get()!);
      pass.setBindGroup(0, this._uniBG);
      pass.setVertexBuffer(0, this._guideBuf);
      pass.draw(nv);
    }
  }

  private _guideBuf: GPUBuffer | null = null;
  private _guideCap = 0;
  private _planeBuf: GPUBuffer | null = null;
  private readonly _planeScratch = new Float32Array((6 + 8) * 7);
  private _guideScratch: Float32Array | null = null;

  // ── Tri cache (fills + handles: thick selected edges, dots) ───────────────
  /** Floats in the cached tri VB (0 = nothing to draw); the first `_triFillFloats` are the fills (under the wireframe). */
  private _triFloats = 0;
  private _triFillFloats = 0;
  /** Camera right / up, the pixel scale key and (perspective only) the eye position the handles were sized for. */
  private readonly _tcCam = new Float64Array(10);
  private _tcMode: MeshEditSelectionMode | null = null;
  private _tcHasSel = false;
  private _tcVSel: number[] = [];
  private _tcFSel: number[] = [];
  private _tcESel: number[] = [];
  private _tcHover: number[] | null = null;
  /** Diagnostics / tests: tri VB rebuilds. */
  public triBuilds = 0;

  /** True when the tri VB's non-geometry inputs (camera right / up, the pixel scale, mode, selection, hover tint) equal
   *  the last build's — the caller checks the geometry. The snapshot is refreshed when they differ. A pan in ortho
   *  keeps everything (the eye position only counts in perspective, where the handle size depends on the depth). */
  private _triInputsSame(
    rx: number, ry: number, rz: number, ux: number, uy: number, uz: number,
    mode: MeshEditSelectionMode, selection: EditSelection | null, hovered: Set<number> | undefined,
    scaleKey = -1, ex = 0, ey = 0, ez = 0,
  ): boolean {
    const C = this._tcCam;
    const vSel = selection && mode === 'vertex' ? selection.vertices : null;
    const fSel = selection && mode === 'face' ? selection.faces : null;
    const eSel = selection && mode === 'edge' ? selection.edges : null;
    const setEq = (a: number[], b: Set<number> | null) => (b ? a.length === b.size && a.every(x => b.has(x)) : a.length === 0);
    const same = this.triBuilds > 0
      && C[0] === rx && C[1] === ry && C[2] === rz && C[3] === ux && C[4] === uy && C[5] === uz
      && C[6] === scaleKey && C[7] === ex && C[8] === ey && C[9] === ez
      && this._tcMode === mode && this._tcHasSel === !!selection
      && setEq(this._tcVSel, vSel) && setEq(this._tcFSel, fSel) && setEq(this._tcESel, eSel)
      && (hovered ? !!this._tcHover && setEq(this._tcHover, hovered) : this._tcHover === null);
    if (!same) {
      C[0] = rx; C[1] = ry; C[2] = rz; C[3] = ux; C[4] = uy; C[5] = uz;
      C[6] = scaleKey; C[7] = ex; C[8] = ey; C[9] = ez;
      this._tcMode = mode; this._tcHasSel = !!selection;
      this._tcVSel = vSel ? [...vSel] : [];
      this._tcFSel = fSel ? [...fSel] : [];
      this._tcESel = eSel ? [...eSel] : [];
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
  /** The plane mirrors the wireframe was clipped / reflected through (mirrorPlanesKey; '' = none). */
  private _wfPlanes = '';
  /** Diagnostics / tests: wireframe VB rebuilds. */
  public wireframeBuilds = 0;

  /** True (and the snapshot refreshed) when the wireframe's inputs differ from the last build's. */
  private _wireframeChanged(
    em: NonNullable<Mesh3D['editMesh']>, lm: Float32Array, mode: MeshEditSelectionMode,
    selection: EditSelection | null, show: boolean, planesKey = '',
  ): boolean {
    const edgeSel = mode === 'edge' && !!selection;
    let same = this._wfEm === em && this._wfShow === show && this._wfEdgeSel === edgeSel && this._wfPlanes === planesKey;
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
            if (E[o] !== he.twin || E[o + 1] !== he.prev || E[o + 2] !== he.vertex || E[o + 3] !== edgeFlags(he)) { same = false; break; }
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
    this._wfEm = em; this._wfShow = show; this._wfEdgeSel = edgeSel; this._wfPlanes = planesKey;
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
        this._wfHe[o] = he.twin; this._wfHe[o + 1] = he.prev; this._wfHe[o + 2] = he.vertex; this._wfHe[o + 3] = edgeFlags(he);
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
    this._guideBuf?.destroy();
    this._planeBuf?.destroy();
  }
}

// ── Module-private helper ─────────────────────────────────────────────────────

/** The edge flags the wireframe colours by (seam = 1, sharp = 2) — part of the wireframe cache snapshot. */
function edgeFlags(he: { isSeam: boolean; isSharp?: boolean }): number {
  return (he.isSeam ? 1 : 0) | (he.isSharp ? 2 : 0);
}

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
