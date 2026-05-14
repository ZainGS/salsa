/**
 * GpRenderer3D — Grease Pencil render pass.
 *
 * Draw order (called from Renderer3D after particles):
 *   1. drawGpFills()   — flat triangle fills for closed strokes
 *   2. drawGpStrokes() — quad-strip outlines
 *
 * Each stroke draw call:
 *   - Writes the point data into a reusable staging buffer and uploads to a
 *     per-call GPUBuffer (size is bounded by the largest stroke seen so far).
 *   - Writes per-stroke uniforms (viewProj, color, baseWidth, jointIndex, canvas size).
 *   - Calls draw(6 * (pointCount - 1)) — no index buffer needed.
 *
 * Bone parenting:
 *   - If stroke.parentJoint is set and the GpObject3D has a skeletonId, the
 *     renderer passes the joint index into the uniform and binds the skeleton's
 *     skinMatrices storage buffer at group 1.
 *   - If no parent joint: a dummy 1-mat storage buffer is bound instead (the
 *     jointIndex uniform is -1, so the shader skips the transform).
 */

import {
  GP_STROKE_VERTEX, GP_STROKE_FRAGMENT,
  GP_FILL_VERTEX, GP_FILL_FRAGMENT,
  GP_VERTEX_BYTES, GP_STROKE_UNIFORM_BYTES, GP_FILL_UNIFORM_BYTES,
} from './shaders/gp-shaders';
import type { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import type { GpStroke3D, GpPoint } from '../../types/grease-pencil-3d';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { Camera3D } from './camera-3d';

// ── Ear-clipping triangulation (standalone, no Polygon dep) ──────────────

function cross2D(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): boolean {
  const d1 = cross2D(px - ax, py - ay, bx - ax, by - ay);
  const d2 = cross2D(px - bx, py - by, cx - bx, cy - by);
  const d3 = cross2D(px - cx, py - cy, ax - cx, ay - cy);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function earClip(pts: { x: number; y: number }[]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  const idx = Array.from({ length: n }, (_, i) => i);
  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    signedArea += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  if (signedArea < 0) idx.reverse();
  const tris: number[] = [];
  let remaining = idx.length;
  let failSafe = remaining * 2;
  let i = 0;
  while (remaining > 2 && failSafe-- > 0) {
    const a = idx[i % remaining];
    const b = idx[(i + 1) % remaining];
    const c = idx[(i + 2) % remaining];
    const ax = pts[a].x, ay = pts[a].y;
    const bx = pts[b].x, by = pts[b].y;
    const cx = pts[c].x, cy = pts[c].y;
    const isConvex = cross2D(bx - ax, by - ay, cx - bx, cy - by) > 0;
    let isEar = isConvex;
    if (isEar) {
      for (let j = 0; j < remaining; j++) {
        const vi = idx[j];
        if (vi === a || vi === b || vi === c) continue;
        if (pointInTriangle(pts[vi].x, pts[vi].y, ax, ay, bx, by, cx, cy)) {
          isEar = false;
          break;
        }
      }
    }
    if (isEar) {
      tris.push(a, b, c);
      idx.splice((i + 1) % remaining, 1);
      remaining--;
      failSafe = remaining * 2;
    } else {
      i++;
    }
  }
  return tris;
}

// ── Project stroke points to dominant 2D plane for ear-clipping ──────────

function projectTo2D(pts: GpPoint[]): { x: number; y: number }[] {
  // Estimate dominant normal via Newell's method on the first polygon loop.
  let nx = 0, ny = 0, nz = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    nx += (pts[i].y - pts[j].y) * (pts[i].z + pts[j].z);
    ny += (pts[i].z - pts[j].z) * (pts[i].x + pts[j].x);
    nz += (pts[i].x - pts[j].x) * (pts[i].y + pts[j].y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= len; ny /= len; nz /= len;

  // Build two orthogonal tangent vectors in the polygon plane.
  const absNx = Math.abs(nx), absNy = Math.abs(ny), absNz = Math.abs(nz);
  let ux: number, uy: number, uz: number;
  if (absNx <= absNy && absNx <= absNz) { ux = 0; uy = -nz; uz = ny; }
  else if (absNy <= absNz)              { ux = -nz; uy = 0;  uz = nx; }
  else                                  { ux = -ny; uy = nx; uz = 0;  }
  const uLen = Math.sqrt(ux*ux + uy*uy + uz*uz) || 1;
  ux /= uLen; uy /= uLen; uz /= uLen;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  return pts.map(p => ({ x: p.x * ux + p.y * uy + p.z * uz, y: p.x * vx + p.y * vy + p.z * vz }));
}

// ── GpRenderer3D ─────────────────────────────────────────────────────────

export class GpRenderer3D {
  private _device: GPUDevice;
  private _format: GPUTextureFormat;

  private _strokePipeline: GPURenderPipeline | null = null;
  private _fillPipeline:   GPURenderPipeline | null = null;

  // Dummy 1-matrix storage buffer for strokes without bone parenting.
  private _dummySkinBuf: GPUBuffer | null = null;
  private _dummySkinBGL: GPUBindGroupLayout | null = null;
  private _dummySkinBG:  GPUBindGroup | null = null;

  // Per-skeleton GPU buffers for bone-parented strokes (keyed by skeleton.id).
  private _skelBufs = new Map<string, { buf: GPUBuffer; jointCount: number }>();
  private _skelBGs  = new Map<string, GPUBindGroup>();

  // Reusable CPU staging arrays (grow as needed, never shrink).
  private _pointStaging: Float32Array = new Float32Array(0);
  private _fillStaging:  Float32Array = new Float32Array(0);

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this._device = device;
    this._format = format;
    this._buildPipelines();
    this._buildDummySkin();
  }

  // ── Public draw interface ─────────────────────────────────────────────

  /**
   * Draw all GP fills then all GP strokes for the given GP objects.
   * @param gpObjects   All GpObject3D instances in the scene.
   * @param skeletons   Map of skeletonId → Skeleton3D for bone parenting.
   * @param camera      Active camera (for viewProjection).
   * @param passEncoder Active render pass encoder.
   * @param canvasW     Canvas width in pixels.
   * @param canvasH     Canvas height in pixels.
   * @param frame       Current animation frame (for keyframe lookup).
   */
  draw(
    gpObjects: GpObject3D[],
    skeletons: Map<string, Skeleton3D>,
    camera: Camera3D,
    passEncoder: GPURenderPassEncoder,
    canvasW: number,
    canvasH: number,
    frame: number,
  ): void {
    if (!this._strokePipeline || !this._fillPipeline) return;
    const vp = this._getViewProjection(camera, canvasW, canvasH);

    // Fill pass first (under strokes).
    for (const gpObj of gpObjects) {
      if (!gpObj.visible) continue;
      const skeleton = gpObj.skeletonId ? skeletons.get(gpObj.skeletonId) ?? null : null;
      for (const { stroke, layerOpacity } of gpObj.getActiveStrokesAllLayers(frame)) {
        if (stroke.closed && stroke.fillColor && stroke.points.length >= 3) {
          this._drawFill(passEncoder, stroke, skeleton, vp);
        }
      }
    }

    // Stroke pass on top.
    for (const gpObj of gpObjects) {
      if (!gpObj.visible) continue;
      const skeleton = gpObj.skeletonId ? skeletons.get(gpObj.skeletonId) ?? null : null;
      for (const { stroke, layerOpacity } of gpObj.getActiveStrokesAllLayers(frame)) {
        if (stroke.points.length >= 2) {
          this._drawStroke(passEncoder, stroke, layerOpacity, skeleton, vp, canvasW, canvasH);
        }
      }
    }
  }

  // ── Private: stroke draw ──────────────────────────────────────────────

  private _drawStroke(
    enc: GPURenderPassEncoder,
    stroke: GpStroke3D,
    layerOpacity: number,
    skeleton: Skeleton3D | null,
    vp: Float32Array,
    canvasW: number,
    canvasH: number,
  ): void {
    const device = this._device;
    const pts    = stroke.closed
      ? [...stroke.points, stroke.points[0]] // close the loop
      : stroke.points;
    const n = pts.length;
    if (n < 2) return;

    // ── Point buffer ─────────────────────────────────────────────
    const pointBytes = n * GP_VERTEX_BYTES;
    const pointBuf   = device.createBuffer({
      size:  Math.ceil(pointBytes / 4) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const needed = n * 6;
    if (this._pointStaging.length < needed) this._pointStaging = new Float32Array(needed);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const o = i * 6;
      this._pointStaging[o]   = p.x; this._pointStaging[o+1] = p.y; this._pointStaging[o+2] = p.z;
      this._pointStaging[o+3] = p.pressure; this._pointStaging[o+4] = p.opacity;
      this._pointStaging[o+5] = 0;
    }
    device.queue.writeBuffer(pointBuf, 0, this._pointStaging, 0, needed);

    // ── Uniforms ──────────────────────────────────────────────────
    const uniformBuf = device.createBuffer({
      size:  GP_STROKE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const uData = new Float32Array(GP_STROKE_UNIFORM_BYTES / 4);
    uData.set(vp, 0); // viewProjection mat4 at offset 0 (16 floats)
    const c = stroke.color;
    uData[16] = c.r; uData[17] = c.g; uData[18] = c.b; uData[19] = c.a * layerOpacity;
    uData[20] = stroke.baseWidth;
    // jointIndex (i32) at byte 84 → float index 21 (write as int bits)
    const jointIndex = this._resolveJointIndex(stroke, skeleton);
    new Int32Array(uData.buffer)[21] = jointIndex;
    uData[22] = canvasW; uData[23] = canvasH;
    device.queue.writeBuffer(uniformBuf, 0, uData);

    // ── Bind groups ───────────────────────────────────────────────
    const strokeBGL = this._strokePipeline!.getBindGroupLayout(0);
    const bg0 = device.createBindGroup({
      layout: strokeBGL,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: pointBuf   } },
      ],
    });
    const bg1 = this._getSkinBindGroup(skeleton, jointIndex);

    // ── Draw ──────────────────────────────────────────────────────
    enc.setPipeline(this._strokePipeline!);
    enc.setBindGroup(0, bg0);
    enc.setBindGroup(1, bg1);
    enc.draw(6, n - 1, 0, 0);

    // Destroy ephemeral buffers (command is already recorded).
    pointBuf.destroy();
    uniformBuf.destroy();
  }

  // ── Private: fill draw ────────────────────────────────────────────────

  private _drawFill(
    enc: GPURenderPassEncoder,
    stroke: GpStroke3D,
    skeleton: Skeleton3D | null,
    vp: Float32Array,
  ): void {
    const device  = this._device;
    const pts     = stroke.points;

    // Ear-clip in 2D projection.
    const pts2D   = projectTo2D(pts);
    const indices = earClip(pts2D);
    if (indices.length === 0) return;

    // Build vertex buffer: one vec3f per triangle vertex.
    const triCount = indices.length / 3;
    const vCount   = indices.length;
    const needed   = vCount * 3;
    if (this._fillStaging.length < needed) this._fillStaging = new Float32Array(needed);
    for (let i = 0; i < vCount; i++) {
      const p = pts[indices[i]];
      this._fillStaging[i * 3]     = p.x;
      this._fillStaging[i * 3 + 1] = p.y;
      this._fillStaging[i * 3 + 2] = p.z;
    }

    const triBuf = device.createBuffer({
      size:  Math.max(needed * 4, 12),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(triBuf, 0, this._fillStaging, 0, needed);

    // Uniforms.
    const uniformBuf = device.createBuffer({
      size:  GP_FILL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const uData = new Float32Array(GP_FILL_UNIFORM_BYTES / 4);
    uData.set(vp, 0);
    const fc = stroke.fillColor!;
    uData[16] = fc.r; uData[17] = fc.g; uData[18] = fc.b; uData[19] = fc.a;
    const jointIndex = this._resolveJointIndex(stroke, skeleton);
    new Int32Array(uData.buffer)[20] = jointIndex;
    device.queue.writeBuffer(uniformBuf, 0, uData);

    const fillBGL = this._fillPipeline!.getBindGroupLayout(0);
    const bg0 = device.createBindGroup({
      layout: fillBGL,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: triBuf     } },
      ],
    });
    const bg1 = this._getSkinBindGroup(skeleton, jointIndex);

    enc.setPipeline(this._fillPipeline!);
    enc.setBindGroup(0, bg0);
    enc.setBindGroup(1, bg1);
    enc.draw(vCount);

    triBuf.destroy();
    uniformBuf.destroy();
  }

  // ── Private: helpers ──────────────────────────────────────────────────

  private _resolveJointIndex(stroke: GpStroke3D, skeleton: Skeleton3D | null): number {
    if (!stroke.parentJoint || !skeleton) return -1;
    const idx = skeleton.data.joints.findIndex(j => j.name === stroke.parentJoint);
    return idx;
  }

  /** Upload skeleton.skinMatrices to a per-skeleton GPU buffer and return its bind group. */
  private _uploadSkeleton(skeleton: Skeleton3D): GPUBindGroup {
    const jointCount = skeleton.data.joints.length;
    const byteSize   = jointCount * 64;
    let entry = this._skelBufs.get(skeleton.id);
    if (!entry || entry.jointCount !== jointCount) {
      entry?.buf.destroy();
      const buf = this._device.createBuffer({
        size:  Math.max(byteSize, 64),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: `GpSkinBuf_${skeleton.id}`,
      });
      entry = { buf, jointCount };
      this._skelBufs.set(skeleton.id, entry);
      this._skelBGs.set(skeleton.id, this._device.createBindGroup({
        layout: this._dummySkinBGL!,
        entries: [{ binding: 0, resource: { buffer: buf } }],
      }));
    }
    this._device.queue.writeBuffer(entry.buf, 0, skeleton.skinMatrices);
    return this._skelBGs.get(skeleton.id)!;
  }

  private _getSkinBindGroup(skeleton: Skeleton3D | null, jointIndex: number): GPUBindGroup {
    if (skeleton && jointIndex >= 0) return this._uploadSkeleton(skeleton);
    return this._dummySkinBG!;
  }

  private _getViewProjection(camera: Camera3D, w: number, h: number): Float32Array {
    camera.aspect = w / h;
    return camera.getViewProjectionMatrix() as unknown as Float32Array;
  }

  // ── Pipeline creation ─────────────────────────────────────────────────

  private _buildDummySkin(): void {
    const device = this._device;
    // One identity matrix — the shader reads it when jointIndex < 0 (never actually used).
    this._dummySkinBuf = device.createBuffer({
      size:  64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const identity = new Float32Array(16);
    identity[0] = 1; identity[5] = 1; identity[10] = 1; identity[15] = 1;
    device.queue.writeBuffer(this._dummySkinBuf, 0, identity);
  }

  private _buildPipelines(): void {
    const device = this._device;
    const format = this._format;

    const strokeVS = device.createShaderModule({ code: GP_STROKE_VERTEX });
    const strokeFS = device.createShaderModule({ code: GP_STROKE_FRAGMENT });
    const fillVS   = device.createShaderModule({ code: GP_FILL_VERTEX });
    const fillFS   = device.createShaderModule({ code: GP_FILL_FRAGMENT });

    // Bind group layout 0 (stroke): uniform + storage
    const strokeBGL0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform'            } },
        { binding: 1, visibility: GPUShaderStage.VERTEX,                           buffer: { type: 'read-only-storage'   } },
      ],
    });
    // Bind group layout 1 (shared): skinMatrices storage
    const skinBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    const blendAlpha: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    const depthState: GPUDepthStencilState = {
      format: 'depth24plus-stencil8',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    };

    this._strokePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [strokeBGL0, skinBGL] }),
      vertex:    { module: strokeVS, entryPoint: 'vsMain' },
      fragment:  { module: strokeFS, entryPoint: 'fsMain', targets: [{ format, blend: blendAlpha }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState,
    });

    // Fill shares the same skinBGL at group 1.
    const fillBGL0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform'          } },
        { binding: 1, visibility: GPUShaderStage.VERTEX,                           buffer: { type: 'read-only-storage' } },
      ],
    });

    this._fillPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [fillBGL0, skinBGL] }),
      vertex:    { module: fillVS, entryPoint: 'vsMain' },
      fragment:  { module: fillFS, entryPoint: 'fsMain', targets: [{ format, blend: blendAlpha }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState,
    });

    // Build the dummy skin bind group now that skinBGL exists.
    this._dummySkinBGL = skinBGL;
    if (this._dummySkinBuf) {
      this._dummySkinBG = device.createBindGroup({
        layout: skinBGL,
        entries: [{ binding: 0, resource: { buffer: this._dummySkinBuf } }],
      });
    }
  }

  destroy(): void {
    this._dummySkinBuf?.destroy();
    for (const entry of this._skelBufs.values()) entry.buf.destroy();
    this._skelBufs.clear();
    this._skelBGs.clear();
  }
}
