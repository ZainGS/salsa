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

/** One queued stroke sample (S2, mobile-parity 7.3b): stamped with the rest of its frame in one dab batch. */
interface UVStrokeSample { u: number; v: number; pressure: number; sizeScale: number; timestamp: number }

/** Where the controller hooks its once-per-frame dab drain: the renderer's pre-render callbacks (so a frame's
 *  samples are stamped right before the frame that shows them). Null = no frame loop → every sample drains at once. */
export interface UVPaintFrameHooks {
  add(cb: () => boolean): void;
  remove(cb: () => boolean): void;
}

/** Start options of a stroke: the PointerEvent's pointerType (a finger gets the touch smoothing cap — BRUSH-4) and
 *  its timeStamp. */
export interface UVStrokeBeginOpts { pointerType?: string; timestamp?: number }

/**
 * S3 (mobile-parity 7.3b): when the UV pane's live readback may run. Pure (the clock is passed in) so it is unit
 * tested. One read in flight at a time; requests while one runs coalesce into one follow-up. While a stroke is live
 * reads start at most every {@link STROKE_INTERVAL_MS} (~9 Hz) and only cover the stroke's region ('rect'); a 'full'
 * request (stroke end, enter, refresh) is never delayed and always reads the whole texture.
 */
export class PaneReadbackGate {
  static readonly STROKE_INTERVAL_MS = 110;
  private inFlight = false;
  private wanted = false;
  private wantedFull = false;
  private lastStart = -Infinity;

  /** Ask for a read (`full` = the whole texture, else the stroke region while drawing). */
  want(full: boolean): void {
    this.wanted = true;
    if (full) this.wantedFull = true;
  }

  /** What to do now: start a read of `start` kind, wait `waitMs` before asking again, or nothing (null). */
  poll(now: number, drawing: boolean): { start: 'full' | 'rect' } | { waitMs: number } | null {
    if (!this.wanted || this.inFlight) return null;
    const full = this.wantedFull || !drawing;
    if (!full) {
      const wait = this.lastStart + PaneReadbackGate.STROKE_INTERVAL_MS - now;
      if (wait > 0) return { waitMs: Math.ceil(wait) };
    }
    this.wanted = false;
    this.wantedFull = false;
    this.inFlight = true;
    this.lastStart = now;
    return { start: full ? 'full' : 'rect' };
  }

  /** The started read finished (or failed). */
  done(): void { this.inFlight = false; }

  /** Drop the queued requests (session exit). A read still in flight stays tracked: the next session's first read
   *  waits for it, so an old read can never land on the pane after a newer one. */
  reset(): void { this.wanted = false; this.wantedFull = false; this.lastStart = -Infinity; }

  get busy(): boolean { return this.inFlight; }
}

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

  // Throttled readback → pane (single in-flight, coalesced; ~9 Hz region reads mid-stroke — PaneReadbackGate).
  private readonly paneCanvas: HTMLCanvasElement;
  private readonly readGate = new PaneReadbackGate();
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  /** S5: the pane redraw (link-cursor ring, hover, readback) is coalesced to at most one per animation frame. */
  private paneRaf = 0;

  // S2: stroke samples queued for the next frame's dab batch (drained by a pre-render callback).
  private pending: UVStrokeSample[] = [];
  private drainHooked = false;
  private readonly drainBound = (): boolean => { this.drainPending(); return false; };
  /** Without a frame loop (or when it stalls) the queue drains at this size instead of growing. */
  static readonly MAX_PENDING = 64;
  /** S8: the stroke's last timestamp (samples are kept non-decreasing) and size scale. */
  private lastTs = -Infinity;
  private lastSizeScale = 1;
  /** The live stroke's PointerEvent.pointerType (S1) — a seam-jump restart keeps it. */
  private strokePointerType: string | undefined = undefined;
  /** S8: the pane pointer that owns the current pane stroke (null = no pane stroke). */
  private panePointerId: number | null = null;

  private readonly downBound = (e: PointerEvent) => this.onDown(e);
  private readonly moveBound = (e: PointerEvent) => this.onMove(e);
  private readonly upBound   = (e: PointerEvent) => this.onUp(e);
  private readonly cancelBound = (e: PointerEvent) => this.onCancel(e);
  // Swallow left-clicks while active so the host's face-select never fires at the
  // end of a paint stroke. (auxclick/middle is a separate event, so pan is unaffected.)
  private readonly clickBound = (e: MouseEvent) => { if (this.target) e.stopImmediatePropagation(); };
  private readonly leaveBound = () => this.onLeave();

  constructor(device: GPUDevice, private readonly scheduleRender: () => void,
              private readonly frameHooks: UVPaintFrameHooks | null = null) {
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
    this.unhookDrain();
    this.pending = [];
    if (this.readTimer !== null) { clearTimeout(this.readTimer); this.readTimer = null; }
    this.readGate.reset();
    this.onStrokeEnd = null;   // session-scoped — never carry a packaging sync into a character session
    this.onStrokeMove = null;  // session-scoped too (the throttled stack recomposite)
  }

  private bindPane(c: HTMLCanvasElement): void {
    addZonelessListener(c, 'pointerdown', this.downBound, { capture: true });
    addZonelessListener(c, 'pointermove', this.moveBound, { capture: true });
    addZonelessListener(c, 'pointerup',   this.upBound,   { capture: true });
    // S8: a cancelled pointer (OS gesture, palm rejection) or a lost capture ends the stroke — never left stuck.
    addZonelessListener(c, 'pointercancel',      this.cancelBound, { capture: true });
    addZonelessListener(c, 'lostpointercapture', this.cancelBound, { capture: true });
    c.addEventListener('click',       this.clickBound, { capture: true });
    addZonelessListener(c, 'pointerleave', this.leaveBound);
    c.style.cursor = 'crosshair';
  }

  private unbindPane(c: HTMLCanvasElement): void {
    removeZonelessListener(c, 'pointerdown', this.downBound, { capture: true });
    removeZonelessListener(c, 'pointermove', this.moveBound, { capture: true });
    removeZonelessListener(c, 'pointerup',   this.upBound,   { capture: true });
    removeZonelessListener(c, 'pointercancel',      this.cancelBound, { capture: true });
    removeZonelessListener(c, 'lostpointercapture', this.cancelBound, { capture: true });
    c.removeEventListener('click',       this.clickBound, { capture: true });
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
    this.panePointerId = null;
    if (this.paneRaf) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.paneRaf); this.paneRaf = 0; }
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
    // S8: one stroke at a time, owned by one pointer — a second finger / pen (or a 3D-surface stroke already
    // running) never restarts it mid-way.
    if (this.drawing || e.isPrimary === false) return;
    try { t.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    this.paneRect = t.canvas.getBoundingClientRect();   // one layout read per stroke (S8 / P2)
    const [px, py] = this.toCanvasPx(e);
    this.setCursorPx(px, py);
    const [u, v] = t.uvRenderer.canvasToUV(px, py, t.session);
    this.panePointerId = typeof e.pointerId === 'number' ? e.pointerId : null;
    this.strokeBeginUV(u, v, e.pressure || 1, 1, { pointerType: e.pointerType, timestamp: e.timeStamp });
  }

  private onMove(e: PointerEvent): void {
    const t = this.target;
    if (!t || !t.canvas || !t.uvRenderer) return;
    if (this.drawing && this.paneOwnsStroke(e)) {
      e.stopImmediatePropagation();
      // The pointerup was missed (released outside / swallowed) → end here instead of drawing a hover line.
      if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) { this.endPaneStroke(e); return; }
      // S2: every sample the browser coalesced into this event, each with its own timestamp — queued and
      // stamped as one dab batch right before the next frame.
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      const samples: PointerEvent[] = list && list.length ? list : [e];
      let px = 0, py = 0;
      for (const s of samples) {
        [px, py] = this.toCanvasPx(s);
        const [u, v] = t.uvRenderer.canvasToUV(px, py, t.session);
        this.strokeMoveUV(u, v, s.pressure || 1, 1, s.timeStamp);
      }
      this.setCursorPx(px, py);
    } else if (!this.drawing && e.buttons === 0) {
      // Hover → brush ring at the cursor + cross-highlight the face under it.
      // Own the event so the host's hover handler never double-fires.
      e.stopImmediatePropagation();
      this.paneRect = null;   // hover: a fresh rect (layout may have moved between strokes)
      const [px, py] = this.toCanvasPx(e);
      this.setCursorPx(px, py);
      t.session.hoveredFaceIndex = t.mesh.editMesh
        ? t.uvRenderer.hitTestFace(px, py, t.session, t.mesh.editMesh)
        : null;
      this.requestPaneRender();
      this.scheduleRender(); // 3D mesh face highlight
    }
    // A non-left drag (middle/right held) is left untouched so the host can still
    // pan/zoom the UV pane while paint mode is active.
  }

  /** The pane stroke's own pointer (S8) — events from any other pointer are ignored. */
  private paneOwnsStroke(e: PointerEvent): boolean {
    return this.panePointerId !== null && (e.pointerId === undefined || e.pointerId === this.panePointerId);
  }

  /** End the pane stroke for its pointer: release the capture and finish the stroke. */
  private endPaneStroke(e: PointerEvent): void {
    const id = this.panePointerId;
    this.panePointerId = null;
    this.paneRect = null;
    if (id !== null) {
      try { if (this.target?.canvas?.hasPointerCapture?.(id)) this.target.canvas.releasePointerCapture(id); } catch { /* gone */ }
    }
    if (this.drawing) this.strokeEndUV(e.timeStamp);
  }

  /** pointercancel / lostpointercapture on the pane: the stroke ends (never left stuck). */
  private onCancel(e: PointerEvent): void {
    if (!this.paneOwnsStroke(e)) return;
    this.endPaneStroke(e);
  }

  /** Place the UV-pane brush ring at a canvas-pixel position, sized to the brush. */
  private setCursorPx(px: number, py: number): void {
    if (this.target) this.target.session.paintCursor = { x: px, y: py, r: this.ringScreenRadius() };
  }

  private onLeave(): void {
    if (!this.target) return;
    this.target.session.paintCursor = null;
    this.requestPaneRender();
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
      if (!t.session.paintCursor) return;   // already cleared — nothing to redraw
      t.session.paintCursor = null;
    }
    this.requestPaneRender();   // S5: at most one pane redraw per frame, however many moves arrive
  }

  /** Whether a 3D-surface hover has anyone to show the link cursor to (the UV pane is attached). The surface input
   *  skips its per-move hover raycast when this is false (P2). */
  wantsLinkCursor(): boolean { return !!this.target?.uvRenderer; }

  private onUp(e: PointerEvent): void {
    if (!this.drawing || !this.paneOwnsStroke(e)) return;
    e.stopImmediatePropagation(); // own the stroke-ending up so the host doesn't act on it
    this.endPaneStroke(e);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** The pane's client rect, cached for the length of a pane stroke (P2 / S8: no layout read per move). */
  private paneRect: DOMRect | null = null;

  private toCanvasPx(e: { clientX: number; clientY: number }): [number, number] {
    const c = this.target?.canvas;
    if (!c) return [0, 0];
    const rect = this.paneRect ?? c.getBoundingClientRect();
    return [
      (e.clientX - rect.left) * (c.width  / rect.width),
      (e.clientY - rect.top)  * (c.height / rect.height),
    ];
  }

  /** UV [0,1] → brush PointerInput in texel space. `timestamp`: the sample's (already kept non-decreasing). */
  private inputFromUV(u: number, v: number, pressure: number, timestamp: number): PointerInput {
    const { w, h } = this.target!.texMgr.getTextureSize();
    return { x: u * w, y: v * h, pressure, timestamp, tiltX: 0, tiltY: 0 };
  }

  /** S8: the sample's own event time (`e.timeStamp`, not the handling time — queued and coalesced samples keep
   *  their real spacing), kept non-decreasing within a stroke. */
  private eventTime(t?: number): number {
    let ts = (typeof t === 'number' && t > 0 && Number.isFinite(t)) ? t : performance.now();
    if (ts < this.lastTs) ts = this.lastTs;
    this.lastTs = ts;
    return ts;
  }

  private hookDrain(): void {
    if (this.drainHooked || !this.frameHooks) return;
    this.frameHooks.add(this.drainBound);
    this.drainHooked = true;
  }

  private unhookDrain(): void {
    if (!this.drainHooked || !this.frameHooks) return;
    this.frameHooks.remove(this.drainBound);
    this.drainHooked = false;
  }

  // ── UV-coordinate stroke API ────────────────────────────────────────────────
  // Drives the shared paint engine + texture from a UV [0,1] coordinate. Used by
  // BOTH the UV-pane pointer handlers above and **3D surface painting**
  // (Scene3DManager raycasts the mesh → UV → these). So a stroke on either view
  // paints the same texture, and both views update via the throttled readback.

  /** Begin a stroke at a UV [0,1] coordinate. The engine's current brush (the active
   *  preset + color + erase, set via the shared brush UI) defines the dab. */
  strokeBeginUV(u: number, v: number, pressure = 1, sizeScale = 1, opts?: UVStrokeBeginOpts): void {
    this.beginRun(u, v, pressure, sizeScale, opts, true);
  }

  /** Begin a stroke. `mirrorBrush` = run {@link beforeStroke} (the per-stroke 2D brush mirror, a preset JSON clone).
   *  A seam-jump restart passes false: the brush cannot change in the middle of a drag (S7). */
  private beginRun(u: number, v: number, pressure: number, sizeScale: number, opts: UVStrokeBeginOpts | undefined, mirrorBrush: boolean): void {
    if (!this.target) return;
    if (this.drawing) this.strokeEndUV();   // never begin over a live stroke (its undo patch would be lost)
    this.engine.setSizeScale(sizeScale);   // 3D-surface paint passes local UV density so the stroke keeps a constant physical size
    this.lastSizeScale = sizeScale;
    this.strokePointerType = opts?.pointerType;
    // ★RE-RESOLVE the engine's write target from the texture manager on EVERY stroke start.
    // enter() captures texMgr.getTexture() once — but the manager can REALLOCATE its GPUTexture
    // after that (RasterLayerManager.setCanvasSize reallocates EVERY layer texture on a doc/canvas
    // resize and only re-points the ILLUSTRATION engine's selected layer — this dedicated engine
    // and a hidden system layer, e.g. the packaging dieline, are both outside that callback).
    // Without this, every subsequent dab lands in an orphaned/destroyed texture: invisible on the
    // mesh, invisible in the pane, silently dropped from the save.
    this.syncActiveTexture();
    if (mirrorBrush) this.beforeStroke?.(); // mirror the live 2D brush onto this engine before the dab
    this.drawing = true;
    this.lastUV = [u, v];
    this.lastTs = -Infinity;
    this.pending = [];
    // pointerType: a finger stroke gets the touch smoothing cap (brush-input-settings.ts); pen / mouse don't (S1).
    this.engine.beginStroke(this.inputFromUV(u, v, pressure, this.eventTime(opts?.timestamp)), { pointerType: opts?.pointerType });
    this.hookDrain();
    this.scheduleRender();
    this.scheduleReadback();
  }

  /** Add a point to the active stroke at a UV [0,1] coordinate. `timestamp`: the sample's event time (S8).
   *  S2: the sample is QUEUED and stamped with the rest of its frame as one dab batch (see drainPending). */
  strokeMoveUV(u: number, v: number, pressure = 1, sizeScale = 1, timestamp?: number): void {
    if (!this.target || !this.drawing) return;
    this.pending.push({ u, v, pressure, sizeScale, timestamp: this.eventTime(timestamp) });
    // No frame loop to drain us (or rendering stalled) → stamp now rather than let the queue grow.
    if (!this.drainHooked || this.pending.length >= UVPaintController.MAX_PENDING) this.drainPending();
    else this.scheduleRender();
  }

  /**
   * S2: stamp the queued samples as ONE dab batch (one GPU submit) — runs as a pre-render callback, so a frame's
   * samples land right before the frame that shows them. The per-dab size scale can change between samples (3D
   * surface: the local UV density of each hit triangle), so the batch is split into addStrokePoints runs of equal
   * scale inside one outer batch. The seam-jump check runs per sample, exactly as when every sample was stamped on
   * its own.
   */
  private drainPending(): void {
    if (!this.target || !this.drawing || this.pending.length === 0) { this.pending.length = 0; return; }
    const samples = this.pending;
    this.pending = [];
    const engine = this.engine;
    let run: PointerInput[] = [];
    const flushRun = () => { if (run.length) { engine.addStrokePoints(run); run = []; } };
    engine.beginDabBatch();
    let batchOpen = true;
    try {
      for (const s of samples) {
        if (!this.drawing) break;   // (a restart below failed to begin — nothing left to paint into)
        const du = s.u - this.lastUV[0], dv = s.v - this.lastUV[1];
        if (du * du + dv * dv > UV_SEAM_JUMP_SQ) {
          // UV discontinuity — the stroke crossed a seam / hopped to another island. A straight line in texture
          // space between the two would streak across unrelated islands. S7: LIFT the brush inside the same stroke
          // (no line, the stroke stays one undo step, no end/restart readbacks); a stroke-texture preset can't lift
          // (its strip is one polyline), so that one still ends + restarts on the new island — without re-running
          // the per-stroke brush mirror (the brush can't change mid-drag).
          flushRun();
          const runEnd = this.inputFromUV(this.lastUV[0], this.lastUV[1], 1, s.timestamp);   // what a stroke end used
          const next = this.inputFromUV(s.u, s.v, s.pressure, s.timestamp);
          if (engine.liftStroke(runEnd, next, s.sizeScale)) {
            this.lastSizeScale = s.sizeScale;
          } else {
            engine.endDabBatch(); batchOpen = false;
            this.strokeEndUV();
            this.beginRun(s.u, s.v, s.pressure, s.sizeScale, { pointerType: this.strokePointerType, timestamp: s.timestamp }, false);
            engine.beginDabBatch(); batchOpen = true;
          }
          this.lastUV = [s.u, s.v];
          continue;
        }
        if (s.sizeScale !== this.lastSizeScale) { flushRun(); engine.setSizeScale(s.sizeScale); this.lastSizeScale = s.sizeScale; }
        this.lastUV = [s.u, s.v];
        run.push(this.inputFromUV(s.u, s.v, s.pressure, s.timestamp));
      }
      flushRun();
    } catch (e) {
      console.warn('[UVPaint] stroke points failed', e);
    } finally {
      if (batchOpen) engine.endDabBatch();
    }
    this.onStrokeMove?.();   // e.g. the throttled package-stack recomposite (box updates mid-stroke)
    this.scheduleRender();
    this.scheduleReadback();
  }

  /** Finish the active stroke — ends at the last painted point (passing a default
   *  0,0 here made endStroke draw a line across to the texture corner). */
  strokeEndUV(timestamp?: number): void {
    if (!this.target || !this.drawing) return;
    this.drainPending();   // stamp whatever is still queued first
    this.drawing = false;
    this.panePointerId = null;
    this.unhookDrain();
    this.engine.setSizeScale(1);   // clear the 3D density scale so pane / 2D strokes aren't affected
    this.lastSizeScale = 1;
    void this.engine.endStroke(this.inputFromUV(this.lastUV[0], this.lastUV[1], 1, this.eventTime(timestamp)));
    // One stroke-end contract for BOTH input paths (pane pointer-up + 3D surface-input end):
    // refresh the live-texture link → the 3D mesh, then render. See the field docs.
    this.onStrokeEnd?.();
    this.scheduleRender();
    this.scheduleReadback(true);   // S3: the one full read at stroke end (mid-stroke reads cover only the stroke)
  }

  /**
   * Abandon the active stroke (P1: a second finger turned it into a pinch): queued samples are dropped and the
   * texture goes back to its stroke-start pixels — no paint is left and no undo step is made. No-op when not drawing.
   */
  strokeCancelUV(): void {
    if (!this.target || !this.drawing) return;
    this.pending = [];
    this.drawing = false;
    this.panePointerId = null;
    this.unhookDrain();
    this.engine.setSizeScale(1);
    this.lastSizeScale = 1;
    this.engine.cancelStroke();
    this.onStrokeEnd?.();   // the restored texels must reach the live-texture link / package composite too
    this.scheduleRender();
    this.scheduleReadback(true);
  }

  /** Whether a stroke is live (pane or 3D surface). */
  isDrawing(): boolean { return this.drawing; }

  /** Force the UV pane to redraw with the current texture (e.g. after a session flag
   *  like `faceGuide` changes). No-op without a pane. */
  refreshPane(): void { this.scheduleReadback(true); }

  // ── Throttled readback → UV pane ───────────────────────────────────────────

  /** `full`: read the whole texture (stroke end / enter / refresh). Otherwise, mid-stroke, a throttled read of the
   *  stroke's region (S3). */
  private scheduleReadback(full = false): void {
    if (!this.target?.uvRenderer) return; // no pane → nothing to read back into; mesh updates via the texture ref
    this.readGate.want(full);
    this.pumpReadback();
  }

  private pumpReadback(): void {
    if (!this.target?.uvRenderer) return;
    const r = this.readGate.poll(performance.now(), this.drawing);
    if (!r) return;
    if ('waitMs' in r) {
      if (this.readTimer === null) this.readTimer = setTimeout(() => { this.readTimer = null; this.pumpReadback(); }, r.waitMs);
      return;
    }
    void this.doReadback(r.start);
  }

  private async doReadback(kind: 'full' | 'rect'): Promise<void> {
    const t = this.target;
    if (!t) { this.readGate.done(); return; }
    try {
      // Pane background source: the layer-stack COMPOSITE when provided (shows all layers), else
      // the write target itself (the historical single-texture behaviour).
      const src = t.readbackTexMgr?.() ?? t.texMgr;
      // Mid-stroke: only the stroke's region so far (texel space — the composite is doc-sized like the write
      // target). Everything else on the pane canvas is unchanged since the last full read.
      const rect = kind === 'rect' ? this.engine.peekStrokeDirtyRect() : null;
      if (kind === 'full' || rect) await src.readToCanvas(this.paneCanvas, rect);
    } catch (e) {
      console.warn('[UVPaint] pane readback failed', e);
    } finally {
      this.readGate.done();
    }
    this.requestPaneRender();
    this.pumpReadback();   // a request that arrived meanwhile (or the next session's first read)
  }

  /** S5: redraw the pane on the next animation frame (coalesced — many hover / link-cursor moves, one draw). */
  private requestPaneRender(): void {
    if (!this.target?.uvRenderer) return;
    if (typeof requestAnimationFrame !== 'function') { this.renderPane(); return; }
    if (this.paneRaf) return;
    this.paneRaf = requestAnimationFrame(() => { this.paneRaf = 0; this.renderPane(); });
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
