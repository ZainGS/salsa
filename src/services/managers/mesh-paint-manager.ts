/**
 * MeshPaintManager — CPU/GPU mesh texture painting.
 *
 * Supports painting directly onto a Mesh3D's UV-mapped texture:
 *   1. On enterMeshPaintMode(), allocates a CPU Uint8Array + GPU texture.
 *   2. Each paintDab() interpolates UV coords via barycentric weights from the
 *      MeshPicker hit, stamps a soft round brush into the CPU buffer, then
 *      uploads the dirty rect to the GPU via device.queue.writeTexture().
 *   3. endStroke() snapshots the CPU buffer for undo (max 20 snapshots).
 *
 * Phase 1 only — vertex color support and multi-layer compositing come later.
 */

import type { ManagerContext } from './manager-context';
import type { PickResult } from '../../renderer/3d/mesh-picker';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

export class MeshPaintManager {
  private ctx: ManagerContext;

  private _activeMesh: Mesh3D | null = null;

  // Brush state
  private _brushR = 0;
  private _brushG = 0;
  private _brushB = 0;
  private _brushA = 255;
  private _brushRadius = 16;
  private _brushHardness = 1.0;

  // Undo snapshots (full CPU buffer copies)
  private _undoStack: Uint8Array[] = [];
  private _redoStack: Uint8Array[] = [];
  private static readonly MAX_UNDO = 20;

  // Dirty rect for batched GPU upload
  private _dirtyX0 = 0;
  private _dirtyY0 = 0;
  private _dirtyX1 = 0;
  private _dirtyY1 = 0;
  private _hasDirty = false;

  // Pre-allocated staging buffer — reused across dabs to avoid per-dab heap alloc.
  private _stagingBuf: Uint8Array | null = null;

  // Original diffuseTexture saved on enterMeshPaintMode so it can be restored.
  private _savedDiffuse: GPUTexture | null = null;

  constructor(ctx: ManagerContext) {
    this.ctx = ctx;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  get activeMesh(): Mesh3D | null { return this._activeMesh; }
  get isActive(): boolean { return this._activeMesh !== null; }

  // ── Mode control ──────────────────────────────────────────────────────────

  /**
   * Enter paint mode on `mesh`. Allocates CPU/GPU paint resources if not yet
   * present. The paint texture is set as the mesh's diffuse texture so
   * brush dabs appear immediately in the renderer.
   */
  enterMeshPaintMode(mesh: Mesh3D, texSize = 1024): void {
    this.exitMeshPaintMode();
    this._activeMesh = mesh;

    if (!mesh.paintBuffer) {
      this._allocatePaintTexture(mesh, texSize);
    }

    // Save original diffuse so it can be restored via restoreOriginalTexture().
    this._savedDiffuse = mesh.diffuseTexture ?? null;
    // Override the mesh's diffuse channel with our paint texture.
    mesh.diffuseTexture = mesh.paintTexture;
    mesh.gpuDirty = true;
    this.ctx.scheduleRender();
  }

  /** Exit paint mode. Paint result is kept on the mesh as its diffuse texture. */
  exitMeshPaintMode(): void {
    if (!this._activeMesh) return;
    this._activeMesh = null;
    this._savedDiffuse = null;
    this._undoStack = [];
    this._redoStack = [];
    this._hasDirty = false;
  }

  /**
   * Restore the mesh's original diffuse texture (the one present before
   * enterMeshPaintMode was called). No-op if no texture was saved or paint
   * mode is not active.
   */
  restoreOriginalTexture(): void {
    if (!this._activeMesh) return;
    this._activeMesh.diffuseTexture = this._savedDiffuse;
    this._activeMesh.material.hasTexture = this._savedDiffuse !== null;
    this._activeMesh.gpuDirty = true;
    this.ctx.scheduleRender();
  }

  /** True if the mesh had a diffuse texture before entering paint mode. */
  get hasSavedDiffuse(): boolean { return this._savedDiffuse !== null; }

  // ── Brush settings ────────────────────────────────────────────────────────

  /** Set brush color as 0–255 RGBA. */
  setBrushColor(r: number, g: number, b: number, a = 255): void {
    this._brushR = r; this._brushG = g; this._brushB = b; this._brushA = a;
  }

  /** Brush radius in texels. */
  setBrushRadius(px: number): void {
    this._brushRadius = Math.max(1, Math.round(px));
  }

  /** 0 = feathered falloff to transparent edge, 1 = hard opaque disc. */
  setBrushHardness(h: number): void {
    this._brushHardness = Math.max(0, Math.min(1, h));
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  /**
   * Stamp a brush dab at the surface UV coordinates from a MeshPicker hit.
   * Call on pointerdown and each pointermove during a stroke.
   */
  paintDab(hit: PickResult): void {
    const mesh = this._activeMesh;
    if (!mesh || !mesh.paintBuffer) return;

    const uvU = this._interpUV(hit, 0);
    const uvV = this._interpUV(hit, 1);

    this._stampBrush(mesh, uvU, uvV);
  }

  /**
   * Call on pointerup (end of stroke) to push the current buffer state onto
   * the undo stack.
   */
  endStroke(): void {
    const mesh = this._activeMesh;
    if (!mesh?.paintBuffer) return;
    this._pushUndo(mesh.paintBuffer);
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  get canUndo(): boolean { return this._undoStack.length > 0; }
  get canRedo(): boolean { return this._redoStack.length > 0; }

  undo(): void {
    const mesh = this._activeMesh;
    if (!mesh?.paintBuffer || !this.canUndo) return;
    this._redoStack.push(mesh.paintBuffer.slice());
    const prev = this._undoStack.pop()!;
    mesh.paintBuffer.set(prev);
    this._uploadFull(mesh);
  }

  redo(): void {
    const mesh = this._activeMesh;
    if (!mesh?.paintBuffer || !this.canRedo) return;
    this._undoStack.push(mesh.paintBuffer.slice());
    const next = this._redoStack.pop()!;
    mesh.paintBuffer.set(next);
    this._uploadFull(mesh);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _allocatePaintTexture(mesh: Mesh3D, texSize: number): void {
    const device = this.ctx.webgpuRenderer.getDevice();

    const buf = new Uint8Array(texSize * texSize * 4).fill(255); // white opaque
    mesh.paintBuffer  = buf;
    mesh.paintTexSize = texSize;

    const tex = device.createTexture({
      size:   [texSize, texSize, 1],
      format: 'rgba8unorm',
      usage:  GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.writeTexture(
      { texture: tex },
      buf,
      { bytesPerRow: texSize * 4 },
      [texSize, texSize, 1],
    );

    mesh.paintTexture = tex;
  }

  private _interpUV(hit: PickResult, channel: 0 | 1): number {
    const mesh = this._activeMesh!;
    const { vertices: verts, indices: idxs } = mesh.geometry;
    const stride = FLOATS_PER_VERT;
    const tri = hit.triangleIndex;
    const i0 = idxs[tri * 3]     * stride;
    const i1 = idxs[tri * 3 + 1] * stride;
    const i2 = idxs[tri * 3 + 2] * stride;
    // UV sits at byte-offset 6/7 within each vertex (pos=0-2, normal=3-5, uv=6-7)
    const uv0 = verts[i0 + 6 + channel];
    const uv1 = verts[i1 + 6 + channel];
    const uv2 = verts[i2 + 6 + channel];
    const w0 = 1 - hit.baryU - hit.baryV;
    return w0 * uv0 + hit.baryU * uv1 + hit.baryV * uv2;
  }

  private _stampBrush(mesh: Mesh3D, uvU: number, uvV: number): void {
    const buf = mesh.paintBuffer!;
    const sz  = mesh.paintTexSize;
    const br  = this._brushRadius;
    const texX = Math.round(uvU * sz);
    const texY = Math.round((1 - uvV) * sz); // Y-flip: UV origin bottom-left, buffer top-left

    const x0 = Math.max(0, texX - br);
    const x1 = Math.min(sz - 1, texX + br);
    const y0 = Math.max(0, texY - br);
    const y1 = Math.min(sz - 1, texY + br);

    const cr = this._brushR, cg = this._brushG, cb = this._brushB, ca = this._brushA;
    const rSq = br * br;
    const hard = this._brushHardness;

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px - texX, dy = py - texY;
        const dSq = dx * dx + dy * dy;
        if (dSq > rSq) continue;

        // Falloff: linear from hardness to 0 at the edge when hardness < 1.
        const t = hard >= 1 ? 1 : Math.max(0, 1 - Math.sqrt(dSq) / br * (1 - hard));
        const srcA = (ca / 255) * t;
        if (srcA <= 0) continue;

        const idx    = (py * sz + px) * 4;
        const dstA   = buf[idx + 3] / 255;
        const outA   = srcA + dstA * (1 - srcA);
        if (outA > 0) {
          buf[idx]     = Math.round((cr * srcA + buf[idx]     / 255 * dstA * (1 - srcA)) / outA * 255);
          buf[idx + 1] = Math.round((cg * srcA + buf[idx + 1] / 255 * dstA * (1 - srcA)) / outA * 255);
          buf[idx + 2] = Math.round((cb * srcA + buf[idx + 2] / 255 * dstA * (1 - srcA)) / outA * 255);
          buf[idx + 3] = Math.round(outA * 255);
        }
      }
    }

    this._expandDirty(x0, y0, x1, y1);
    this._flushDirty(mesh);
  }

  private _ensureStagingBuf(needed: number): Uint8Array {
    if (!this._stagingBuf || this._stagingBuf.byteLength < needed) {
      this._stagingBuf = new Uint8Array(needed);
    }
    return this._stagingBuf;
  }

  private _flushDirty(mesh: Mesh3D): void {
    if (!this._hasDirty || !mesh.paintTexture || !mesh.paintBuffer) return;
    const device = this.ctx.webgpuRenderer.getDevice();
    const x0 = this._dirtyX0, y0 = this._dirtyY0;
    const w  = this._dirtyX1 - x0 + 1;
    const h  = this._dirtyY1 - y0 + 1;
    const sz = mesh.paintTexSize;
    const rowBytes = w * 4;
    const region = this._ensureStagingBuf(rowBytes * h).subarray(0, rowBytes * h);
    for (let row = 0; row < h; row++) {
      const srcOff = ((y0 + row) * sz + x0) * 4;
      region.set(mesh.paintBuffer.subarray(srcOff, srcOff + rowBytes), row * rowBytes);
    }
    device.queue.writeTexture(
      { texture: mesh.paintTexture, origin: { x: x0, y: y0, z: 0 } },
      region,
      { bytesPerRow: rowBytes },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    this._hasDirty = false;
    this.ctx.scheduleRender();
  }

  private _uploadFull(mesh: Mesh3D): void {
    if (!mesh.paintTexture || !mesh.paintBuffer) return;
    const device = this.ctx.webgpuRenderer.getDevice();
    const sz = mesh.paintTexSize;
    device.queue.writeTexture(
      { texture: mesh.paintTexture },
      mesh.paintBuffer,
      { bytesPerRow: sz * 4 },
      [sz, sz, 1],
    );
    this.ctx.scheduleRender();
  }

  private _expandDirty(x0: number, y0: number, x1: number, y1: number): void {
    if (!this._hasDirty) {
      this._dirtyX0 = x0; this._dirtyY0 = y0;
      this._dirtyX1 = x1; this._dirtyY1 = y1;
      this._hasDirty = true;
    } else {
      if (x0 < this._dirtyX0) this._dirtyX0 = x0;
      if (y0 < this._dirtyY0) this._dirtyY0 = y0;
      if (x1 > this._dirtyX1) this._dirtyX1 = x1;
      if (y1 > this._dirtyY1) this._dirtyY1 = y1;
    }
  }

  private _pushUndo(buf: Uint8Array): void {
    this._undoStack.push(buf.slice());
    if (this._undoStack.length > MeshPaintManager.MAX_UNDO) this._undoStack.shift();
    this._redoStack = [];
  }
}
