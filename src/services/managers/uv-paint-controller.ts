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
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';

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
  /** OPTIONAL live re-resolver for the write-target MANAGER itself (not just its texture).
   *  ★PART-0 ROOT FIX: `texMgr` is captured ONCE at enter — but when the session targets a RASTER
   *  LAYER (the packaging dieline), the document-restore pipeline can REBUILD the layer list
   *  (clearAllLayers + addLayerWithId: same layer id, brand-new RasterTextureManager) after the
   *  arm. The captured manager is then ORPHANED: its own texture "agrees with itself" forever, so
   *  the texture-level sync never heals; the engine paints the orphaned texture while the mesh
   *  (whose LiveTextureMode link resolves BY LAYER ID through the live RasterLayerManager) samples
   *  the NEW manager's texture — paint lands but never shows on the box (the fresh-package
   *  "does not live-update while painting" bug; a re-adopted package, armed AFTER the restore
   *  settled, never hits it). Set this to re-resolve the manager by layer id at every stroke
   *  begin; omitted/null = the captured manager is trusted (character mesh paint — those managers
   *  are session-owned and never rebuilt externally). */
  resolveTexMgr?: (() => RasterTextureManager | null) | null;
  /** OPTIONAL pane-background readback source. Default: the WRITE target (`texMgr`). The package
   *  layer STACK points this at the COMPOSITE target's manager so the pane shows the full stack
   *  (all layers + vector proxies) while strokes still write only the ACTIVE layer. Stroke → texel
   *  mapping stays on `texMgr` (write-target texel space); both are doc-sized, so aspect agrees. */
  readbackTexMgr?: (() => RasterTextureManager | null) | null;
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

  /** Called after EVERY finished stroke — pane strokes AND 3D-surface strokes both funnel through
   *  {@link strokeEndUV}, so this is the one stroke-end hook. ShapeManager's packaging arm sets it
   *  to `syncLiveTextures3D` so the box's live-texture link refreshes exactly like a 3D stroke-end
   *  (a pane stroke previously never triggered the sync → the box could show stale content when the
   *  layer texture reference had changed). Cleared on {@link exit} so it never leaks across sessions. */
  public onStrokeEnd: (() => void) | null = null;

  /** Called on every stroke-MOVE sample (pane + 3D strokes). The packaging arm sets it to a
   *  THROTTLED layer-stack recomposite so the box shows the stroke growing live (the composite is
   *  a real GPU pass, so per-dab recompositing would be wasteful — the caller throttles). */
  public onStrokeMove: (() => void) | null = null;

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
  /** The UV pane the active session is wired to, if any — so a caller re-arming the session onto a
   *  regenerated mesh can preserve the pane instead of silently dropping it. */
  activePane(): UVCanvasRenderer | null { return this.target?.uvRenderer ?? null; }

  /** The dedicated paint engine (own texture + undo). Brush settings are routed here
   *  while UV paint is active via ShapeManager's brush-settings override, so the 2D
   *  brush UI drives it. */
  getEngine(): RasterPaintEngine { return this.engine; }

  /** Keep the engine's write target pointed at the texture manager's CURRENT GPUTexture.
   *  No-op when they already agree; on divergence (manager reallocation) the engine is
   *  re-pointed and its undo snapshots re-seeded from the new texture.
   *  ★When the target carries `resolveTexMgr`, the MANAGER itself is re-resolved first — a
   *  document-restore can rebuild the backing raster layer with a brand-new manager under the
   *  same layer id, and re-reading only the CAPTURED manager's texture would keep the engine
   *  writing an orphaned texture forever (see {@link ActiveTarget.resolveTexMgr}). */
  private syncActiveTexture(): void {
    const t = this.target;
    if (!t) return;
    const liveMgr = t.resolveTexMgr?.();
    if (liveMgr && liveMgr !== t.texMgr) t.texMgr = liveMgr;   // captured manager was orphaned/replaced
    const fresh = t.texMgr.getTexture();
    if (fresh && fresh !== this.engine.getActiveTexture()) {
      this.engine.setActiveTexture(fresh);
      void this.engine.initializeSnapshots();
    }
  }

  /** DIAGNOSTIC (salsaPkgPaintProbe): the live identities of the paint session — the mesh the
   *  session is armed on, the engine's current write target, and the manager's current texture. */
  debugState(): { meshId: string; engineTex: GPUTexture | null; managerTex: GPUTexture | null } | null {
    const t = this.target;
    if (!t) return null;
    return {
      meshId: t.mesh.id,
      engineTex: this.engine.getActiveTexture(),
      managerTex: t.texMgr.getTexture(),
    };
  }

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
    this.syncTexAspect();   // pane letterboxes UV [0,1] to the texture's aspect (square = no-op)
    const tex = t.texMgr.getTexture();
    this.engine.setActiveTexture(tex);
    void this.engine.initializeSnapshots();
    // Pane pointer input + readback only when a UV pane is present. With no pane
    // (3D-only paint) the surface input drives the stroke API directly.
    if (t.canvas) this.bindPane(t.canvas);
    this.scheduleReadback(); // show current texture in the pane immediately (no-op without a pane)
  }

  exit(): void {
    if (!this.target) return;
    if (this.drawing) this.strokeEndUV();
    this.detachPane();   // listeners + cursor ring + resize observer (no-op when no pane)
    this.target = null;
    this.onStrokeEnd = null;   // session-scoped — never carry a packaging sync into a character session
    this.onStrokeMove = null;  // session-scoped too (the throttled stack recomposite)
  }

  private bindPane(c: HTMLCanvasElement): void {
    addZonelessListener(c, 'pointerdown', this.downBound, { capture: true });
    addZonelessListener(c, 'pointermove', this.moveBound, { capture: true });
    addZonelessListener(c, 'pointerup',   this.upBound,   { capture: true });
    c.addEventListener('click',       this.clickBound, { capture: true });
    addZonelessListener(c, 'pointerleave', this.leaveBound);
    c.style.cursor = 'crosshair';
  }

  private unbindPane(c: HTMLCanvasElement): void {
    removeZonelessListener(c, 'pointerdown', this.downBound, { capture: true } as any);
    removeZonelessListener(c, 'pointermove', this.moveBound, { capture: true } as any);
    removeZonelessListener(c, 'pointerup',   this.upBound,   { capture: true } as any);
    c.removeEventListener('click',       this.clickBound, { capture: true } as any);
    removeZonelessListener(c, 'pointerleave', this.leaveBound);
    c.style.cursor = '';
  }

  /** Attach (or swap) a UV pane onto the ACTIVE paint target WITHOUT re-entering the session — the
   *  packaging dieline pane arms 3D paint first (no pane) and connects the pane later. Pane strokes
   *  then drive the SAME engine/texture as 3D strokes, and the pane shows the current texture via the
   *  readback immediately. `onResize` (optional) fires after a pane LAYOUT resize re-synced the
   *  backing store + re-rendered — hosts redraw their guide overlay in it (the mapping moved).
   *  Returns false when no paint session is active. */
  attachPane(uvRenderer: UVCanvasRenderer, onResize?: () => void): boolean {
    const t = this.target;
    if (!t) return false;
    this.detachPane();
    this.syncTexAspect();   // texture may have been (re)sized since enter — keep the letterbox honest
    // Late-attached panes (packaging dieline) size their own BACKING STORE from CSS × DPR on every
    // draw — the host only lays the canvas out with CSS. Without this a default 300×150 backing
    // store gets CSS-stretched, skewing the letterbox (and every uvToCanvas consumer) non-square.
    // The setter also installs a ResizeObserver: a pure LAYOUT change (view-mode switch 3D↔Split↔2D
    // remounts/resizes the pane) re-syncs + re-renders IMMEDIATELY — previously the letterbox only
    // caught up on the next paint-driven draw (the pane sat misaligned until mouse-move/zoom).
    uvRenderer.autoBackingStore = true;
    uvRenderer.onLayoutResize = () => { this.renderPane(); onResize?.(); };
    t.uvRenderer = uvRenderer;
    t.canvas = uvRenderer.element;
    this.bindPane(t.canvas);
    // Immediate SYNCED render — don't wait for the async readback to size the letterbox: a stale
    // (or default 300×150) backing store on mount is exactly the misaligned-until-mouse-move bug.
    uvRenderer.syncBackingStore();
    this.renderPane();
    this.scheduleReadback();
    return true;
  }

  /** Push the active texture's aspect (w/h) into the session so the pane letterboxes a non-square
   *  texture (the doc-sized packaging dieline) instead of squeezing it square. All pane mapping
   *  (background, guides via paneUVToCanvas, brush ring, stroke canvasToUV) flows through the
   *  session-aware uvToCanvas/canvasToUV pair, so setting it here keeps every consumer in agreement.
   *  Character UV textures are square → aspect 1 → the historical mapping, unchanged. */
  private syncTexAspect(): void {
    const t = this.target;
    if (!t) return;
    const { w, h } = t.texMgr.getTextureSize();
    if (w > 0 && h > 0) t.session.texAspect = w / h;
  }

  /** Detach the pane wired by {@link attachPane} (listeners + cursor ring + resize observer).
   *  Painting stays active — 3D-surface strokes continue on the same texture. No-op without a pane. */
  detachPane(): void {
    const t = this.target;
    if (!t) return;
    if (t.canvas) this.unbindPane(t.canvas);
    if (t.uvRenderer) {
      t.uvRenderer.onLayoutResize = null;
      t.uvRenderer.autoBackingStore = false;   // disconnects the ResizeObserver (re-enabled on attach)
    }
    t.session.paintCursor = null;
    t.uvRenderer = null;
    t.canvas = null;
  }

  /** Map UV [0,1] → pane canvas px through the attached pane (honours its pan/zoom) — for host guide
   *  overlays (e.g. the packaging dieline guides). Null when no pane is attached. */
  paneUVToCanvas(u: number, v: number): [number, number] | null {
    const t = this.target;
    return t?.uvRenderer ? t.uvRenderer.uvToCanvas(u, v, t.session) : null;
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
    const base = t?.canvas ? Math.min(t.canvas.width, t.canvas.height) * 0.85 : 512;
    // Displayed width of the UV box = base letterboxed to the texture aspect (see UVCanvasRenderer).
    const aspect = t && t.session.texAspect > 0 ? t.session.texAspect : 1;
    const paneW = base * Math.min(1, aspect);
    const zoom = t?.canvas ? t.session.zoom : 1;
    return Math.max(2, (texelDiam / 2) / texW * (zoom * paneW));
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
    // ★RE-RESOLVE the engine's write target from the texture manager on EVERY stroke start.
    // enter() captures texMgr.getTexture() once — but the manager can REALLOCATE its GPUTexture
    // after that (RasterLayerManager.setCanvasSize reallocates EVERY layer texture on a doc/canvas
    // resize and only re-points the ILLUSTRATION engine's selected layer — this dedicated engine
    // and a hidden system layer, e.g. the packaging dieline, are both outside that callback).
    // Without this, every subsequent dab lands in an orphaned/destroyed texture: invisible on the
    // mesh, invisible in the pane, silently dropped from the save.
    this.syncActiveTexture();
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
    this.onStrokeMove?.();   // e.g. the throttled package-stack recomposite (box updates mid-stroke)
    this.scheduleRender();
    this.scheduleReadback();
  }

  /** Finish the active stroke — ends at the last painted point (passing a default
   *  0,0 here made endStroke draw a line across to the texture corner). */
  strokeEndUV(): void {
    if (!this.target || !this.drawing) return;
    this.drawing = false;
    void this.engine.endStroke(this.inputFromUV(this.lastUV[0], this.lastUV[1], 1));
    // One stroke-end contract for BOTH input paths (pane pointer-up + 3D surface-input end):
    // refresh the live-texture link → the 3D mesh, then render. See the field docs.
    this.onStrokeEnd?.();
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
    // Pane background source: the layer-stack COMPOSITE when provided (shows all layers), else
    // the write target itself (the historical single-texture behaviour).
    const src = t.readbackTexMgr?.() ?? t.texMgr;
    await src.readToCanvas(this.paneCanvas);
    this.renderPane();
    this.readbackInFlight = false;
    if (this.readbackPending) { this.readbackPending = false; this.scheduleReadback(); }
  }

  private renderPane(): void {
    const t = this.target;
    if (!t || !t.uvRenderer) return;
    this.syncTexAspect();   // texture may have been resized since attach (doc resize) — cheap re-read
    // editMesh may be null (packaging dieline pane — panels are never made editable, their authored
    // net UVs are the mapping): the renderer then draws background-only (texture + boundary + ring).
    t.uvRenderer.draw(t.session, t.mesh.editMesh ?? null, this.paneCanvas);
  }

  destroy(): void {
    this.exit();
    this.engine.destroy();
  }
}
