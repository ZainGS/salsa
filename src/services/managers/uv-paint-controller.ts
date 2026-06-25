/**
 * UVPaintController — paint a mesh's texture by brushing directly on its
 * unwrapped UV in the UV-editor pane.
 *
 * Owns a **dedicated** RasterPaintEngine so it never disturbs the illustration
 * paint engine's active texture. On each stroke it maps UV-pane pixels →
 * UV [0,1] → texel coordinates on the mesh's paint texture, dabs with the GPU
 * brush, updates the 3D mesh live (the diffuse texture reference never changes —
 * only its contents), and — throttled — reads the texture back into a CPU canvas
 * that it draws as the UV-pane background so the islands show the paint as you go.
 *
 * Bound to the UV-pane canvas Frogmarks supplies via UVCanvasRenderer. While
 * active it owns pointer input on that canvas (Frogmarks should pause its own
 * UV-pane interaction/draw loop).
 */

import { RasterPaintEngine } from '../../renderer/raster/core/raster-paint-engine';
import type { PointerInput } from '../../renderer/raster/brushes/brush-engine';
import type { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { UVCanvasRenderer, UVEditorSession } from './uv-canvas-renderer';

export interface UVBrushSettings {
  /** Stroke color (0–1 per channel). */
  color?: { r: number; g: number; b: number; a: number };
  /** @deprecated Ignored — brush size now comes from the active shared preset. */
  radius?: number;
  /** Stroke alpha 0–1 (overrides color.a if given). */
  opacity?: number;
  /** Erase instead of paint. */
  erase?: boolean;
}

interface ActiveTarget {
  mesh:       Mesh3D;
  texMgr:     RasterTextureManager;
  session:    UVEditorSession;
  /** UV pane renderer + its canvas. Both null when the pane is hidden and the
   *  user is painting **only on the 3D mesh** — then there's no pointer input or
   *  readback to drive here; the mesh updates live via the texture reference. */
  uvRenderer: UVCanvasRenderer | null;
  canvas:     HTMLCanvasElement | null;
}

/** UV-space distance² above which consecutive stroke samples are treated as a seam /
 *  island jump. Painting across a mesh face edge makes the raycast UV hop to a distant
 *  island; interpolating a line across that gap streaks paint over unrelated islands, so
 *  we break the stroke instead. Tuned for atlas-packed islands; may need adjusting. */
const UV_SEAM_JUMP_SQ = 0.15 * 0.15;

export class UVPaintController {
  private readonly engine: RasterPaintEngine;
  private target: ActiveTarget | null = null;

  /** Called at the start of every stroke. ShapeManager uses it to mirror the live 2D
   *  brush (active preset + color + erase) into this engine, so whatever the shared
   *  brush UI did to the illustration engine is reflected on the mesh. */
  public beforeStroke: (() => void) | null = null;

  private drawing = false;
  /** Last painted UV — used to end the stroke where it actually was (not at a
   *  default 0,0, which made endStroke draw a line to the corner). */
  private lastUV: [number, number] = [0, 0];

  // Throttled readback → pane (single in-flight, coalesced).
  private readonly paneCanvas: HTMLCanvasElement;
  private readbackInFlight = false;
  private readbackPending = false;

  private readonly downBound = (e: PointerEvent) => this.onDown(e);
  private readonly moveBound = (e: PointerEvent) => this.onMove(e);
  private readonly upBound   = (e: PointerEvent) => this.onUp(e);
  // Swallow left-clicks while active so the host's face-select never fires at the
  // end of a paint stroke. (auxclick/middle is a separate event, so pan is unaffected.)
  private readonly clickBound = (e: MouseEvent) => { if (this.target) e.stopImmediatePropagation(); };
  private readonly leaveBound = () => this.onLeave();

  constructor(device: GPUDevice, private readonly scheduleRender: () => void) {
    this.engine = new RasterPaintEngine(device, scheduleRender);
    // The brush library + active brush + color are copied from the 2D illustration
    // engine on enter (syncBrushFrom) so UV/mesh painting uses the SAME brushes. The
    // engine keeps its built-in default presets as a fallback if no sync happens.
    this.engine.setAspectCorrection([1, 1]); // square texture, no squeeze
    this.paneCanvas = document.createElement('canvas');
  }

  isActive(): boolean { return this.target !== null; }
  activeMeshId(): string | null { return this.target?.mesh.id ?? null; }

  /** The dedicated paint engine (own texture + undo). Brush settings are routed here
   *  while UV paint is active via ShapeManager's brush-settings override, so the 2D
   *  brush UI drives it. */
  getEngine(): RasterPaintEngine { return this.engine; }

  /** Copy the full brush library + active brush from another engine (the 2D
   *  illustration engine) so UV/mesh painting uses the same brushes/presets. Color is
   *  applied separately by the caller (the drawing service owns the current color). */
  syncBrushFrom(source: RasterPaintEngine): void {
    try {
      this.engine.importPresets(source.exportAllPresets());
      const activeId = source.getActivePresetId();
      if (activeId) this.engine.setActivePreset(activeId);
    } catch (e) {
      console.warn('[UVPaint] brush sync failed', e);
    }
  }

  /** Activate painting for a mesh's UV session. The mesh's diffuse texture must
   *  already be set to `texMgr`'s texture by the caller. */
  enter(t: ActiveTarget): void {
    this.exit();
    this.target = t;
    const tex = t.texMgr.getTexture();
    this.engine.setActiveTexture(tex);
    void this.engine.initializeSnapshots();
    // Pane pointer input + readback only when a UV pane is present. With no pane
    // (3D-only paint) the surface input drives the stroke API directly.
    if (t.canvas) {
      t.canvas.addEventListener('pointerdown', this.downBound, { capture: true });
      t.canvas.addEventListener('pointermove', this.moveBound, { capture: true });
      t.canvas.addEventListener('pointerup',   this.upBound,   { capture: true });
      t.canvas.addEventListener('click',       this.clickBound, { capture: true });
      t.canvas.addEventListener('pointerleave', this.leaveBound);
      t.canvas.style.cursor = 'crosshair';
    }
    this.scheduleReadback(); // show current texture in the pane immediately (no-op without a pane)
  }

  exit(): void {
    if (!this.target) return;
    if (this.drawing) this.strokeEndUV();
    const c = this.target.canvas;
    if (c) {
      c.removeEventListener('pointerdown', this.downBound, { capture: true } as any);
      c.removeEventListener('pointermove', this.moveBound, { capture: true } as any);
      c.removeEventListener('pointerup',   this.upBound,   { capture: true } as any);
      c.removeEventListener('click',       this.clickBound, { capture: true } as any);
      c.removeEventListener('pointerleave', this.leaveBound);
      c.style.cursor = '';
    }
    this.target.session.paintCursor = null;
    this.target = null;
  }

  /** Programmatic brush update (color + erase). Size/shape now come from the active
   *  preset — UV paint shares the 2D brush library — so `radius` is ignored.
   *  @deprecated prefer the shared brush UI, which routes to this engine. */
  setBrush(s: UVBrushSettings): void {
    if (s.color !== undefined) {
      this.engine.setBrushColor(s.color.r, s.color.g, s.color.b, s.opacity ?? s.color.a ?? 1);
    }
    if (s.erase !== undefined) this.engine.setEraseMode(s.erase ? 1 : null);
  }

  /** Screen-px radius of the active brush for the UV-pane cursor ring — the active
   *  preset's texel size mapped through the current pane zoom. */
  private ringScreenRadius(): number {
    const t = this.target;
    const id = this.engine.getActivePresetId();
    const p: any = id ? this.engine.getPreset(id) : null;
    const texelDiam = (p && (p.maxSize ?? p.minSize)) || 32;
    const texW = t?.texMgr.getTextureSize().w ?? 1024;
    const paneSize = t?.canvas ? Math.min(t.canvas.width, t.canvas.height) * 0.85 : 512;
    const zoom = t?.canvas ? t.session.zoom : 1;
    return Math.max(2, (texelDiam / 2) / texW * (zoom * paneSize));
  }

  // ── Pointer ───────────────────────────────────────────────────────────────

  private onDown(e: PointerEvent): void {
    const t = this.target;
    if (!t || !t.canvas || !t.uvRenderer || e.button !== 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    t.canvas.setPointerCapture(e.pointerId);
    const [px, py] = this.toCanvasPx(e);
    this.setCursorPx(px, py);
    const [u, v] = t.uvRenderer.canvasToUV(px, py, t.session);
    this.strokeBeginUV(u, v, e.pressure || 1);
  }

  private onMove(e: PointerEvent): void {
    const t = this.target;
    if (!t || !t.canvas || !t.uvRenderer) return;
    const [px, py] = this.toCanvasPx(e);
    if (this.drawing) {
      e.stopImmediatePropagation();
      this.setCursorPx(px, py);
      const [u, v] = t.uvRenderer.canvasToUV(px, py, t.session);
      this.strokeMoveUV(u, v, e.pressure || 1);
    } else if (e.buttons === 0) {
      // Hover → brush ring at the cursor + cross-highlight the face under it.
      // Own the event so the host's hover handler never double-fires.
      e.stopImmediatePropagation();
      this.setCursorPx(px, py);
      t.session.hoveredFaceIndex = t.mesh.editMesh
        ? t.uvRenderer.hitTestFace(px, py, t.session, t.mesh.editMesh)
        : null;
      this.renderPane();
      this.scheduleRender(); // 3D mesh face highlight
    }
    // A non-left drag (middle/right held) is left untouched so the host can still
    // pan/zoom the UV pane while paint mode is active.
  }

  /** Place the UV-pane brush ring at a canvas-pixel position, sized to the brush. */
  private setCursorPx(px: number, py: number): void {
    if (this.target) this.target.session.paintCursor = { x: px, y: py, r: this.ringScreenRadius() };
  }

  private onLeave(): void {
    if (!this.target) return;
    this.target.session.paintCursor = null;
    this.renderPane();
  }

  /** Show the UV-pane brush ring from a 3D-mesh hover (mapped to UV), or clear it.
   *  Called by the host while the cursor is over the mesh, not the UV pane — gives
   *  the "hover the mesh → see the spot on the UV" correspondence. */
  setLinkCursorUV(uv: [number, number] | null): void {
    const t = this.target;
    if (!t || !t.uvRenderer) return; // no pane → nothing to draw the ring on
    if (uv) {
      const [x, y] = t.uvRenderer.uvToCanvas(uv[0], uv[1], t.session);
      t.session.paintCursor = { x, y, r: this.ringScreenRadius() };
    } else {
      t.session.paintCursor = null;
    }
    this.renderPane();
  }

  private onUp(e: PointerEvent): void {
    if (!this.drawing) return;
    e.stopImmediatePropagation(); // own the stroke-ending up so the host doesn't act on it
    try { this.target?.canvas?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    this.strokeEndUV();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private toCanvasPx(e: PointerEvent): [number, number] {
    const c = this.target?.canvas;
    if (!c) return [0, 0];
    const rect = c.getBoundingClientRect();
    return [
      (e.clientX - rect.left) * (c.width  / rect.width),
      (e.clientY - rect.top)  * (c.height / rect.height),
    ];
  }

  /** UV [0,1] → brush PointerInput in texel space. */
  private inputFromUV(u: number, v: number, pressure: number): PointerInput {
    const { w, h } = this.target!.texMgr.getTextureSize();
    return { x: u * w, y: v * h, pressure, timestamp: Date.now(), tiltX: 0, tiltY: 0 };
  }

  // ── UV-coordinate stroke API ────────────────────────────────────────────────
  // Drives the shared paint engine + texture from a UV [0,1] coordinate. Used by
  // BOTH the UV-pane pointer handlers above and **3D surface painting**
  // (Scene3DManager raycasts the mesh → UV → these). So a stroke on either view
  // paints the same texture, and both views update via the throttled readback.

  /** Begin a stroke at a UV [0,1] coordinate. The engine's current brush (the active
   *  preset + color + erase, set via the shared brush UI) defines the dab. */
  strokeBeginUV(u: number, v: number, pressure = 1): void {
    if (!this.target) return;
    this.beforeStroke?.(); // mirror the live 2D brush onto this engine before the dab
    this.drawing = true;
    this.lastUV = [u, v];
    this.engine.beginStroke(this.inputFromUV(u, v, pressure));
    this.scheduleRender();
    this.scheduleReadback();
  }

  /** Add a point to the active stroke at a UV [0,1] coordinate. */
  strokeMoveUV(u: number, v: number, pressure = 1): void {
    if (!this.target || !this.drawing) return;
    const du = u - this.lastUV[0], dv = v - this.lastUV[1];
    if (du * du + dv * dv > UV_SEAM_JUMP_SQ) {
      // UV discontinuity — the stroke crossed a seam / hopped to another island. A
      // straight line in texture space between the two would streak across unrelated
      // islands, so end this stroke and restart on the new island.
      this.strokeEndUV();
      this.strokeBeginUV(u, v, pressure);
      return;
    }
    this.lastUV = [u, v];
    this.engine.addStrokePoint(this.inputFromUV(u, v, pressure));
    this.scheduleRender();
    this.scheduleReadback();
  }

  /** Finish the active stroke — ends at the last painted point (passing a default
   *  0,0 here made endStroke draw a line across to the texture corner). */
  strokeEndUV(): void {
    if (!this.target || !this.drawing) return;
    this.drawing = false;
    void this.engine.endStroke(this.inputFromUV(this.lastUV[0], this.lastUV[1], 1));
    this.scheduleRender();
    this.scheduleReadback();
  }

  /** Force the UV pane to redraw with the current texture (e.g. after a session flag
   *  like `faceGuide` changes). No-op without a pane. */
  refreshPane(): void { this.scheduleReadback(); }

  // ── Throttled readback → UV pane ───────────────────────────────────────────

  private scheduleReadback(): void {
    if (!this.target?.uvRenderer) return; // no pane → nothing to read back into; mesh updates via the texture ref
    if (this.readbackInFlight) { this.readbackPending = true; return; }
    this.readbackInFlight = true;
    void this.doReadback();
  }

  private async doReadback(): Promise<void> {
    const t = this.target;
    if (!t) { this.readbackInFlight = false; return; }
    await t.texMgr.readToCanvas(this.paneCanvas);
    this.renderPane();
    this.readbackInFlight = false;
    if (this.readbackPending) { this.readbackPending = false; this.scheduleReadback(); }
  }

  private renderPane(): void {
    const t = this.target;
    if (!t || !t.uvRenderer || !t.mesh.editMesh) return;
    t.uvRenderer.draw(t.session, t.mesh.editMesh, this.paneCanvas);
  }

  destroy(): void {
    this.exit();
    this.engine.destroy();
  }
}
