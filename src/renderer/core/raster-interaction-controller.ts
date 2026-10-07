// C1 slice 1 (2026-09-13): the raster-canvas INPUT cluster, moved VERBATIM out of webgpu-renderer.ts
// (handleKeyDown / handleWheel / handlePointerDown / handlePointerMove / handlePointerUp + the group,
// section, and coordinate helpers only they call). `r` is the renderer: every `this.r.X` below is a
// coupling the move made explicit — decoupling (per-mode handler strategy) is slice 2, later.
// See docs/specs/render-layer-extraction-map.md.
import type { WebGPURenderer } from './webgpu-renderer';
import { WebGPURenderStrategy } from "../render-strategies/webgpu-render-strategy";
import { Node } from "../../scene-graph/shapes/base/node";
import { InteractionService } from '../../services/interaction-service';
import { mat4, vec3, vec4 } from "gl-matrix";
import { Shape } from "../../scene-graph/shapes/base/shape";
import { LineDrawingService } from "../../services/drawing/line-drawing-service";
import { ScribbleDrawingService } from "../../services/drawing/scribble-drawing-service";
import { EraserService } from "../../services/drawing/eraser-service";
import { HighlightDrawingService } from "../../services/drawing/highlight-drawing-service";
import { PatternDrawingService } from "../../services/drawing/pattern-drawing-service";
import { TextDrawingService } from "../../services/drawing/text-drawing-service";
import { Rectangle } from "../../scene-graph/shapes/rectangle";
import { Scribble } from "../../scene-graph/shapes/scribble";
import { Highlight as HighlightShape } from "../../scene-graph/shapes/highlight";
import { Line } from "../../scene-graph/shapes/line";
import { Pattern } from "../../scene-graph/shapes/pattern";
import { Section } from "../../scene-graph/shapes/section";
import { SectionDrawingService } from "../../services/drawing/section-drawing-service";
import { Group } from "../../scene-graph/shapes/base/group";
import { SDFText } from "../../scene-graph/shapes/sdf-text/sdf-text";
import { SdfTextDrawingService } from "../../services/drawing/sdftext-drawing-service";
import { ScalingSide } from "../util/interaction-types";
import { getScalingSide, isNearRotationHandle, canvasPxToWorld, HIT } from "../util/handles";
import { CURSORS, ShapeDimensions, Vec2 } from "../../types/interaction";
import { pointInPolygon, polygonsIntersect } from "../util/geometry";
import { SelectionService } from "../../services/selection-service";
import { CaretManager } from "../../services/drawing/caret-manager";
import { SelectionHighlightManager } from "../../services/drawing/selection-highlight-manager";
import { OverlayDotManager, DotInstance } from "../../services/drawing/overlay-dot-manager";
import { ConnectorService } from "../../services/connector-service";
import { StampDrawingService } from "../../services/drawing/stamp-drawing-service";
import { PolygonDrawingService } from "../../services/drawing/polygon-drawing-service";
import panningCursorUrl from '../../assets/grabbing.cur?url';
import drawingCursorUrl from '../../assets/drawing.cur?url';
import grabbingCursorUrl from '../../assets/grabbing.cur?url';
import highlighterCursorUrl from '../../assets/highlighter.cur?url';
import pointerExcitedCursorUrl from '../../assets/pointer_excited.cur?url';
import pointerHappyCursorUrl from '../../assets/pointer_happy.cur?url';
import pointerOCursorUrl from '../../assets/pointer_o.cur?url';
import pointerSadCursorUrl from '../../assets/pointer_sad.cur?url';
import pointerWinkCursorUrl from '../../assets/pointer_wink.cur?url';
import pointerTongueCursorUrl from '../../assets/pointer_tongue.cur?url';
import pointerSleepCursorUrl from '../../assets/pointer_sleep.cur?url';
import pointerLoveCursorUrl from '../../assets/pointer_love.cur?url';
import pointerRageCursorUrl from '../../assets/pointer_rage.cur?url';
import pointerCursorUrl from '../../assets/pointer.cur?url';
import { RasterLayerManager } from "../../services/raster-layer-manager";
import { RasterPaintEngine } from "../raster/core/raster-paint-engine";
import { RasterSelectionEngine } from "../raster/selection/raster-selection-engine";
import { SelectionOverlayRenderer } from "../raster/selection/selection-overlay-renderer";
import type { SelectionOverlayState } from "../raster/selection/selection-overlay-renderer";
import { LiveTextNode } from "../../scene-graph/shapes/live-text";
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { canvasPixelRatio } from '../util/canvas-pixel-ratio';

/** One pointerdown, for the double-click test. */
export interface PressSample { t: number; type: string; x: number; y: number }

/** TOUCH-5: is `cur` the second press of a double-click after `prev`? Within `thresholdMs`, from the SAME kind of
 *  pointer and — for touch — within `touchSlopPx` of the first tap. (Two fingers landing together used to read as a
 *  double-click: any two pointerdowns within 300 ms counted.) The mouse rule is unchanged: time only. A press that
 *  lands while another finger is down never gets here (it becomes a pinch). */
export function isDoubleClickPress(prev: PressSample, cur: PressSample, thresholdMs = 300, touchSlopPx = 40): boolean {
    if (!((cur.t - prev.t) < thresholdMs)) return false;
    if (cur.type !== prev.type) return false;
    if (cur.type === 'touch' && Math.hypot(cur.x - prev.x, cur.y - prev.y) > touchSlopPx) return false;
    return true;
}

export class RasterInteractionController {
    constructor(private r: WebGPURenderer) {}

    /** P1 undo (editing-loop-polish.md): watch-set snapshot taken at pointer-down when a transform
     *  gesture starts; committed as ONE command at the very end of handlePointerUp (after section
     *  drop-in/out + pending-group recalcs, so those reparents land inside the same command). */
    private _undoToken: import('../../services/vector-object-undo').UndoCaptureToken | null = null;

    private beginUndoCapture(seeds: Iterable<Node>): void {
        this._undoToken = this.r.interactionService.vectorUndo.begin(this.r.sceneGraph.root, seeds);
    }

    // ── TOUCH (TOUCH-5 / TOUCH-7, docs/ui/touch-controls.md) ─────────────────────────────────────────────────
    // Fingers are tracked by pointerId. Only the FIRST finger drives the select / drag / box / pan gesture; a 2nd
    // finger CANCELS that gesture (reverting a half-done move / scale / rotate) and turns into a 2D PINCH-zoom +
    // two-finger PAN around the finger midpoint. The mouse / pen path is unchanged (no pointerType 'touch').

    /** Hit-radius multiplier for the 2D transform handles / line endpoints under a finger (TOUCH-8). */
    static TOUCH_HIT_SCALE = 2;
    /** Active touch pointers (client coords). */
    private _touches = new Map<number, { x: number; y: number }>();
    /** The finger driving the current single-pointer gesture (null = none / not touch). */
    private _primaryTouchId: number | null = null;
    /** Two-finger gesture state: the midpoint + spread at the last step. `nav` false = a 3D orbit controller owns the
     *  multi-finger gesture (the 2D view must not ALSO zoom / pan), so the fingers are just swallowed until lifted. */
    private _pinch: { mx: number; my: number; dist: number; nav: boolean } | null = null;
    /** Pointer type + position of the last pointerdown (the double-click test). */
    private _lastClickType = '';
    private _lastClickX = 0;
    private _lastClickY = 0;

    /** True while a two-finger 2D gesture (or a swallowed 3D-owned one) is in progress. */
    get isPinching(): boolean { return this._pinch !== null; }

    /** Backing-store pixels per CSS pixel AS BACKED (the pan units are backing pixels × 2 — see
     *  InteractionService.adjustPan). The real `canvas.width / rect.width`, NOT window.devicePixelRatio: the mobile
     *  backing store is DPR-capped (TIER-1), so a DPR-2 tablet backs at 1.5. Shared rule: canvasPixelRatio(). */
    private _cssToBacking(rect: { width: number }): number {
        return canvasPixelRatio(this.r.canvas, 1, rect.width);
    }

    /** PAN the 2D view by a CSS-pixel screen delta so the content follows the finger exactly (any devicePixelRatio).
     *  Also used by the 3D orbit controller's ortho touch pan (illustration-synced views). */
    public touchPan2D(dxCss: number, dyCss: number): void {
        if (dxCss === 0 && dyCss === 0) return;
        const k = this._cssToBacking(this.cacheRect()) * 2;
        this.r.interactionService.adjustPan(dxCss * k, dyCss * k, this.r.illustrationMode, this.r.illustrationBounds);
        if (!this.r.backgroundPatternFixed) this.r.bgDirty.matrix = true;
        this.r.renderListDirty = true;
        this.r.scheduleRender();
    }

    /** ZOOM the 2D view by `ratio` (> 1 = in) keeping the content under client (cx, cy) fixed. Also used by the 3D
     *  orbit controller's ortho pinch (illustration-synced views). */
    public touchZoom2D(ratio: number, clientX: number, clientY: number): void {
        if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 1e-4) return;
        const rect = this.cacheRect();
        const k = this._cssToBacking(rect);
        // adjustZoom doubles its point (wheel convention: CSS px from the canvas centre) → pass backing px / 1.
        const mx = (clientX - (rect.left + rect.width / 2)) * k;
        const my = (clientY - (rect.top + rect.height / 2)) * k;
        this.r.interactionService.adjustZoom(ratio - 1, mx, my, this.r.illustrationMode, this.r.illustrationBounds);
        for (const node of this.r.interactionService.selectedNodes) (node as Shape).triggerRerender();
        this.r.renderListDirty = true;
        this.r.scheduleRender();
    }

    /** CANCEL the in-flight single-pointer gesture (a 2nd finger landed / the pointer was cancelled): a move / scale /
     *  rotate / endpoint drag is reverted to its pointer-down snapshot (no undo entry), a marquee is dropped, a pan just
     *  stops. Safe when idle. */
    public cancelActiveGesture(): void {
        const kind = this.r.mode.kind;
        this.r.interactionService.pointerDown = false;
        if (kind === 'idle') { this._undoToken = null; return; }
        if (this._undoToken) {
            const token = this._undoToken;
            this._undoToken = null;
            this.r.interactionService.vectorUndo.revert(token);
        }
        if (kind === 'boxSelecting') this.r.interactionService.boxSelectPreview = null;
        if (kind === 'endpointDragging' || kind === 'draggingPlacement' || kind === 'resizingPlacement' || kind === 'rotatingPlacement') {
            this.r.interactionService.endInteractive();
        }
        this.r.mode = { kind: 'idle' };
        this.r.renderListDirty = true;
        this.r.scheduleRender();
    }

    /** Pointer CANCELLED by the browser (system gesture, palm rejection, the page took the touch). */
    public handlePointerCancel(event: PointerEvent): void {
        if (event.pointerType === 'touch') {
            const id = event.pointerId ?? 0;
            if (!this._touches.has(id)) return;
            this._touches.delete(id);
            if (this._pinch) {
                if (this._touches.size === 0) this._pinch = null;
                else if (this._touches.size >= 2) this._beginPinch();
                return;
            }
            if (id !== this._primaryTouchId) return;
            this._primaryTouchId = null;
        }
        this.cancelActiveGesture();
    }

    private _beginPinch(): void {
        const pts = [...this._touches.values()];
        const a = pts[0], b = pts[1];
        // A 3D orbit controller with touch gestures owns multi-finger input → the 2D view stays put.
        const owned3D = this.r.interactionService.touchGestures3D?.() ?? false;
        this._pinch = { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y), nav: !owned3D };
        this.lastClickTime = 0;            // a pinch is never half of a double-click
    }

    private _pinchMove(): void {
        const p = this._pinch;
        if (!p || this._touches.size < 2) return;
        const pts = [...this._touches.values()];
        const a = pts[0], b = pts[1];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (p.nav && !this.r.interactionService.playActive) {
            this.touchPan2D(mx - p.mx, my - p.my);
            if (p.dist > 0 && dist > 0) this.touchZoom2D(dist / p.dist, mx, my);
        }
        p.mx = mx; p.my = my; p.dist = dist;
    }

  public handleKeyDown(event: KeyboardEvent) {

      // UI System: in interactive preview, the UI gets first crack at keys (Tab focus / Enter-Space activate /
      // author-bound keys like Escape→pause). No-op unless interactive, so editing shortcuts are untouched.
      if (this.r._uiKeyHandler && this.r._uiKeyHandler(event.key, event.shiftKey)) { event.preventDefault(); return; }

      // Play mode (Round 8): no editor shortcut fires while playing — undo / duplicate / group / delete would mutate
      // the scene under the running game (Play's own keys are read by its KeyboardInput).
      if (this.r.interactionService.playActive) return;

      // Don't fire editor shortcuts (g/u below) while the user is typing in a HOST form field — this is a global
      // window listener, so without this a 'g'/'u' typed into a Frogmarks text input would group/ungroup the
      // selected shapes. (The host owns G/R/S transform + Play-movement keys; those it must gate itself.)
      const ae = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

      // P1 undo: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y for 2D vector OBJECT ops. Consumed ONLY when this
      // stack has something to undo/redo — otherwise the event falls through untouched to the host's
      // raster/3D routing. (Path-edit sessions consume their own Ctrl+Z earlier via
      // stopImmediatePropagation, so a path-anchor session never reaches here.)
      if ((event.ctrlKey || event.metaKey) && !event.altKey
          && (event.key === 'z' || event.key === 'Z' || event.key === 'y' || event.key === 'Y')) {
          const vu = this.r.interactionService.vectorUndo;
          const isRedo = event.key === 'y' || event.key === 'Y' || event.shiftKey;
          if (isRedo ? vu.canRedo : vu.canUndo) {
              if (isRedo) vu.redo(); else vu.undo();
              event.preventDefault();
              event.stopImmediatePropagation();
          }
          return;
      }

      // P2 duplicate: Ctrl+D duplicates the selected 2D shapes (a modifier combo, not text input, so
      // this sits BEFORE the text-shape guard — a selected sticky note can be duplicated too). A host with its own
      // Edit › Duplicate takes it over via ShapeManager.setDuplicateKeyHandler (same guards). A HELD Ctrl+D runs
      // once: the auto-repeats stay claimed (no browser bookmark dialog) but duplicate nothing (mobile-parity 7.2).
      if ((event.key === 'd' || event.key === 'D') && (event.ctrlKey || event.metaKey) && !event.altKey
          && this.r._duplicateSelectedHandler
          && this.r.interactionService.selectedNodes.size >= 1
          && !this.r.interactionService.suppressBoxSelect) {
          if (!event.repeat) this.r._duplicateSelectedHandler();
          event.preventDefault();
          return;
      }

      const textShapes = ['Sticky Note', 'SDFText', 'Speech Balloon'];

      if (this.r.interactionService.selectedNodes.size === 1 
          && textShapes.includes(([...this.r.interactionService.selectedNodes][0] as Shape).getType())
      ) { return; }

      if ((event.key === 'g' || event.key === 'G') && this.r.interactionService.selectedNodes.size > 1) {
          this.groupSelectedShapes();
          event.preventDefault();
      }
      else if ((event.key === 'u' || event.key === 'U') && this.r.interactionService.selectedNodes.size >= 1) {
          this.ungroupSelectedShapes();
          event.preventDefault();
      }
      // Delete/Backspace: delete the selected 2D shapes (selectedNodes is the 2D set — 3D mesh selection lives in
      // scene3d and is untouched). Skipped while a creator mode / Player mode owns input (suppressBoxSelect), and
      // the guards above already exempt typing (input fields + a selected text shape).
      else if ((event.key === 'Delete' || event.key === 'Backspace')
          && this.r._deleteSelectedHandler
          && this.r.interactionService.selectedNodes.size >= 1
          && !this.r.interactionService.suppressBoxSelect) {
          this.r._deleteSelectedHandler();
          event.preventDefault();
      }
  }

  public handleWheel(event: WheelEvent) {
    if (this.r.interactionService.playActive) return;   // Play: no 2D zoom
    if (event.ctrlKey) {
      // Prevent the default zoom behavior in the browser
      event.preventDefault(); 

      // Invert to zoom in on scroll up
      const zoomDelta = event.deltaY * -0.001; 

      // Mouse position relative to the canvas center, in BACKING px (adjustZoom doubles it into pan units = backing
      // px × 2, like touchZoom2D). CSS px alone anchored the zoom off the cursor whenever backing ≠ CSS (TIER-1 cap).
      const rect = this.r.canvas.getBoundingClientRect();
      const k = this._cssToBacking(rect);
      const mouseX = (event.clientX - (rect.left + rect.width / 2)) * k;
      const mouseY = (event.clientY - (rect.top  + rect.height / 2)) * k;

      // Adjust the zoom factor and pan offset
      this.r.interactionService.adjustZoom(
          zoomDelta, 
          mouseX, 
          mouseY, 
          this.r.illustrationMode, 
          this.r.illustrationBounds
      );

      // this.r.bgDirty.matrix = true;
      // this.r.renderListDirty = true;

      for (const node of this.r.interactionService.selectedNodes) {
          (node as Shape).triggerRerender();
      }
    }
  }

  // Determines angle the mouse has moved around the shape during shape rotation
  private calculateMouseAngle(mx: number, my: number, s: Shape): number {
    const [wx, wy] = this.r.canvasPxToWorld(mx, my);
    const model = mat4.mul(mat4.create(), s.parentChainMatrix, s.localMatrix);
    const centerW = vec4.transformMat4(vec4.create(), vec4.fromValues(0,0,0,1), model);
    return Math.atan2(wy - centerW[1], wx - centerW[0]);
  }

  private isolatedTarget: Node | null = null;
  private lastClickTime: number = 0;
  
  public handlePointerDown(event: PointerEvent) {
    // TOUCH-5: fingers are tracked by id. A 2nd finger cancels the 1-finger gesture and becomes a pinch / pan;
    // any finger beyond the first while one is busy never starts a select / drag / box.
    const isTouch = event.pointerType === 'touch';
    if (isTouch) {
      this._touches.set(event.pointerId ?? 0, { x: event.clientX, y: event.clientY });
      if (this._pinch) {                                        // a finger joined a pinch: re-seed (no jump)
        if (this._touches.size >= 2) this._beginPinch();
        return;
      }
      if (this._touches.size >= 2) {
        this.cancelActiveGesture();
        this._primaryTouchId = null;
        this._beginPinch();
        return;
      }
      this._primaryTouchId = event.pointerId ?? 0;
    }

    // Track pointer state for shader uniforms
    this.r.interactionService.pointerDown = true;

    // Only schedule render if a mode is entered or selection changes
    const DOUBLE_CLICK_THRESHOLD = 300; // ms
    const now = Date.now();
    // Two pointerdowns within 300 ms are a double-click only from the SAME kind of pointer (a finger tap, then a mouse
    // click is not) and, for touch, near the same spot (two fingers landing together used to read as a double-click).
    const pType = event.pointerType ?? '';
    const isDoubleClick = isDoubleClickPress(
      { t: this.lastClickTime, type: this._lastClickType, x: this._lastClickX, y: this._lastClickY },
      { t: now, type: pType, x: event.clientX, y: event.clientY }, DOUBLE_CLICK_THRESHOLD);
    this.lastClickTime = now;
    this._lastClickType = pType;
    this._lastClickX = event.clientX; this._lastClickY = event.clientY;
    const hitScale = isTouch ? RasterInteractionController.TOUCH_HIT_SCALE : 1;

    // Play mode (Round 8): no 2D pan / select; only a left click reaches the UI system's hook below.
    if (this.r.interactionService.playActive && event.button !== 0) return;

    const rect = this.cacheRect();

    // Middle mouse or Pan tool → start panning
    if (event.button === 1 || this.r.interactionService.isPanToolSelected) {
      this.r.mode = { kind: 'panning', lastClient: [event.clientX, event.clientY], rect };
      event.preventDefault();
      this.r.scheduleRender();
      this.r.interactionService.canvas.style.cursor = `url('${panningCursorUrl}'), crosshair`;
      return;
    }

    if (event.button !== 0) return;

    // UI System (docs/specs/ui-system.md): in interactive preview an active UI layer gets FIRST crack at the click —
    // consuming it when it hit an interactive shape (or the layer is modal). The hook no-ops unless interactivity is
    // enabled, so normal editing is untouched.
    if (this.r._uiPointerHandler) {
      const [uwx, uwy] = this.transformMouseCoordinatesToWorldSpace(event.offsetX, event.offsetY);
      if (this.r._uiPointerHandler.onDown(uwx, uwy, event.offsetX, event.offsetY)) { this.r.scheduleRender(); return; }
    }
    // Play mode (Round 8): the click grabs pointer-lock for mouse-look — never a 2D select / drag / box.
    if (this.r.interactionService.playActive) return;

    // During armature / weight paint mode, suppress 2D box-select entirely. Also suppress whenever a 3D camera
    // owns the view (free3D + the ortho creator modes): you select 3D meshes by click, not a 2D marquee, so a
    // left-drag (which orbits) must not also paint the selection rectangle. cameraOwnsView is the reliable signal —
    // suppressBoxSelect can be cleared by a load-time tool/mode call while free3D is still active.
    if (this.r.interactionService.suppressBoxSelect || this.r.interactionService.cameraOwnsView) return;
    // NOTE: rect-draw mode (LiveText click-drag) is handled DOWN at the box-select entry, so
    // it only fires on EMPTY space — clicking/dragging existing nodes still selects/moves/
    // resizes them normally, and double-click still edits.

    // If a drawing tool is active, clear selection and let the tool handle it
    if (
      this.r.lineDrawingService?.isEnabled ||
      this.r.scribbleDrawingService?.isEnabled ||
      this.r.sectionDrawingService?.isEnabled ||
      this.r.eraserService?.isEnabled ||
      this.r.highlightDrawingService?.isEnabled ||
      this.r.patternDrawingService?.isEnabled ||
      this.r.stampDrawingService?.isEnabled ||
      this.r.polygonDrawingService?.isEnabled ||
      this.r.textDrawingService?.isEnabled ||
      this.r.sdfTextDrawingService?.isEnabled ||
      this.r.rasterDrawingService?.isEnabled ||
      this.r.rasterSelectionService?.isEnabled ||
      this.r.rasterMoveService?.isEnabled
    ) {
      this.r.interactionService.clearSelectedNodes();
      this.r.scheduleRender();
      return;
    }

    // Compute world pos from canvas offsets
    const [mouseX, mouseY] = [event.offsetX, event.offsetY];
    const [worldX, worldY] = this.transformMouseCoordinatesToWorldSpace(mouseX, mouseY);

    // LINE ENDPOINT HANDLE → set endpointDragging mode
    if (this.r.interactionService.selectedNodes.size === 1) {
      const sel = Array.from(this.r.interactionService.selectedNodes)[0];
      if (sel instanceof Line) {
        const endpointThreshold = 0.02 * hitScale;   // TOUCH-8: a finger gets a bigger grab radius
        // Transform local endpoints to world space
        const m = sel.localMatrix;
        const wx1 = m[0] * sel.x1 + m[4] * sel.y1 + m[12];
        const wy1 = m[1] * sel.x1 + m[5] * sel.y1 + m[13];
        const wx2 = m[0] * sel.x2 + m[4] * sel.y2 + m[12];
        const wy2 = m[1] * sel.x2 + m[5] * sel.y2 + m[13];
        const dStart = Math.hypot(wx1 - worldX, wy1 - worldY);
        const dEnd   = Math.hypot(wx2 - worldX, wy2 - worldY);
        const minD = Math.min(dStart, dEnd);
        if (minD <= endpointThreshold) {
          this.beginUndoCapture([sel]);   // P1: line endpoints are in the snapshot (x1..y2)
          this.r.mode = {
            kind: 'endpointDragging',
            data: { line: sel, which: dStart <= dEnd ? 'start' : 'end' },
          };
          this.r.interactionService.beginInteractive();
          this.r.scheduleRender();
          return;
        }
      }
    }

    // ROTATION → set rotating mode
    if (this.r.interactionService.selectedNodes.size === 1) {
      const shape = Array.from(this.r.interactionService.selectedNodes)[0] as Shape;
      if (isNearRotationHandle(shape, [worldX, worldY], hitScale)) {
        const initialMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
        this.beginUndoCapture([shape]);
        this.r.mode = {
          kind: 'rotating',
          data: { initialMouseAngle, initialRotation: shape.rotation }
        };
        this.r.interactionService.beginInteractive();
        return;
      }
    }

    // SCALING → set scaling mode
    if (this.r.interactionService.selectedNodes.size === 1) {
      const shape = Array.from(this.r.interactionService.selectedNodes)[0] as Shape;
      const side = getScalingSide(shape, [worldX, worldY], hitScale);
      if (side) {
        const sx0 = shape.scaleX ?? 1;
        const sy0 = shape.scaleY ?? 1;
        const baseW = shape.width;   // the group’s local width (before scale)
        const baseH = shape.height;  // the group’s local height (before scale)

        const initial: ShapeDimensions & { baseW:number; baseH:number; scaleX:number; scaleY:number } = {
          x: shape.x,
          y: shape.y,
          // effective starting world size along the group’s axes:
          width:  baseW * sx0,
          height: baseH * sy0,
          baseW, baseH,
          scaleX: sx0, scaleY: sy0,
        };
        this.beginUndoCapture([shape]);
        this.r.mode = {
          kind: 'scaling',
          data: {
            side,
            anchorWorld: [worldX, worldY],        
            initial, 
            prevCenter: [shape.x, shape.y]
          }
        };

        return;
      }
    }

    // Selection handles take priority (resize/rotate on selected placement)
    if (this.r._ephemeraHandleHitTester) {
      const handleHit = this.r._ephemeraHandleHitTester(worldX, worldY);
      if (handleHit && this.r.interactionService.isVectorLayerInteractive(handleHit.layerId)) {
        if (handleHit.kind === 'resize') {
          this.r.mode = {
            kind: 'resizingPlacement',
            data: { layerId: handleHit.layerId, placementId: handleHit.placementId, handle: handleHit.handle, anchorX: handleHit.anchorX, anchorY: handleHit.anchorY },
          };
        } else {
          this.r.mode = {
            kind: 'rotatingPlacement',
            data: { layerId: handleHit.layerId, placementId: handleHit.placementId, centerX: handleHit.centerX, centerY: handleHit.centerY, startAngle: handleHit.startAngle, startRotation: handleHit.startRotation },
          };
        }
        this.r.interactionService.beginInteractive();
        this.r.scheduleRender();
        return;
      }
    }

    // Ephemera placement body hit-test (overlay renders above shapes, so check first).
    // Gated by the active vector layer, same as scene-graph shapes: a placement on an inactive
    // layer is inert and the click falls through (to a shape, or to deselect).
    if (this.r._ephemeraHitTester) {
      const hit = this.r._ephemeraHitTester(worldX, worldY);
      if (hit && this.r.interactionService.isVectorLayerInteractive(hit.layerId)) {
        // Selecting a placement clears any scene-graph shape selection — the two selection systems are mutually
        // exclusive (the shape-click path already clears the placement via _ephemeraDeselectCallback below).
        this.r.interactionService.clearSelectedNodes();
        this.r._ephemeraSelectCallback?.(hit.layerId, hit.placementId);
        this.r.mode = {
          kind: 'draggingPlacement',
          data: {
            layerId: hit.layerId,
            placementId: hit.placementId,
            startWorldX: worldX,
            startWorldY: worldY,
            placementX0: hit.x,
            placementY0: hit.y,
          },
        };
        this.r.interactionService.beginInteractive();
        this.r.scheduleRender();
        return;
      }
    }

    // Nothing ephemera-related was hit — clear placement selection
    this.r._ephemeraDeselectCallback?.();

    // // Hit test
    let topNode = this.r.selectionService.findFirstNodeUnderMouse(worldX, worldY);

    const clickedSelected = topNode && this.r.interactionService.selectedNodes.has(topNode) && !event.shiftKey;
    if (clickedSelected) {
      // Do NOT change the selection; keep the whole multi-selection.
      // Just set up dragging with the clicked node as the primary.

      // Build drag data exactly like you do below, but force `primary = topNode`
      const selected = Array.from(this.r.interactionService.selectedNodes);
      const primary = topNode as Node;

      const dragOffset: Vec2 = [
        worldX - primary.x,  // (optional) use world->parent conversion as in note below
        worldY - primary.y,
      ];

      const initialGroupChildPositions = new Map<Group, Vec2>();
      if (primary instanceof Section) {
        primary.forEachDeep((node) => {
          if (node instanceof Group) initialGroupChildPositions.set(node, [node.x, node.y]);
        });
      }

      const nodes = selected.filter(n => n instanceof Shape || n instanceof Group) as (Shape|Group)[];
      const x0 = new Float32Array(nodes.length);
      const y0 = new Float32Array(nodes.length);
      nodes.forEach((n,i) => { x0[i] = n.x; y0[i] = n.y; });

      const invParentAtDrag = nodes.map(n => {
        const inv = mat4.create();
        return this.r.safeInvert(inv, n.parentChainMatrix);
      });

      this.beginUndoCapture(primary instanceof Shape || primary instanceof Group ? [...nodes, primary] : nodes);
      this.r.mode = {
        kind: 'dragging',
        data: {
          primary,
          rect,
          dragOffset,
          nodes,
          x0, y0,
          primaryX0: primary.x,
          primaryY0: primary.y,
          initialGroupChildPositions,
          invParentAtDrag,
        },
      };

      this.r.scheduleRender();
      return; // <- IMPORTANT: skip the rest of the selection-changing code
    }

    // If you clicked SDFText inside a Sticky Note, select the Sticky instead.
    if (topNode) {
      const sticky = this.r.stickyAncestorOf(topNode);
      if (sticky) topNode = sticky;
    }

    // Same for Speech Balloon — select the parent balloon, not the child Polygon/SDFText.
    if (topNode) {
      const balloon = this.r.speechBalloonAncestorOf(topNode);
      if (balloon) topNode = balloon;
    }

    // Selection resolution
    let selectionTarget: Node | null = null;

    if (topNode) {
      if (topNode.locked) return;

      const chain = this.r.buildHitChain(topNode);

      // If we were isolating, but this click is outside that subtree, reset.
      if (this.isolatedTarget && !chain.includes(this.isolatedTarget)) {
        this.isolatedTarget = null;
        this.r.interactionService.clearSelectedNodes();
      }

      if (isDoubleClick) {
        // Initialize to highest group (or leaf) if needed, then go one step deeper.
        if (!this.isolatedTarget || !chain.includes(this.isolatedTarget)) {
          this.isolatedTarget = this.r.highestGroupInChain(chain) ?? topNode;
        }
        this.isolatedTarget = this.r.nextDeeperNode(chain, this.isolatedTarget);
        selectionTarget = this.isolatedTarget;
      } else {
        // Single click: always highest (top-most) group under cursor, else the leaf.
        this.isolatedTarget = this.r.highestGroupInChain(chain) ?? topNode;
        selectionTarget = this.isolatedTarget;
      }
    }

    // Apply selection (shift behavior unchanged)
    if (selectionTarget) {
      if (event.shiftKey) {
        if (this.r.interactionService.selectedNodes.has(selectionTarget)) {
          this.r.interactionService.deselectNode(selectionTarget);
        } else {
          this.r.interactionService.selectNode(selectionTarget);
        }
      } else {
        if (!this.r.interactionService.selectedNodes.has(selectionTarget)) {
          this.r.interactionService.clearSelectedNodes();
          this.r.interactionService.selectNode(selectionTarget);
        }
      }
      this.r.scheduleRender();
    } 
    else {
      // EMPTY SPACE: either DRAW a rect (rect-draw mode, e.g. LiveText click-drag — green box,
      // emits the world rect on release instead of selecting) or BOX SELECT (purple). We reach
      // here only after the node/handle hit-tests above missed, so existing nodes keep normal
      // select/move/resize/double-click behavior even while the text tool is active.
      const isDraw = !!this.r.interactionService.rectDrawCallback;
      if (!event.shiftKey) this.r.interactionService.clearSelectedNodes();
      const [startX, startY] = this.transformMouseCoordinatesToWorldSpace(mouseX, mouseY);
      const previewBox = new Rectangle(
        startX, startY,
        1, 1,
        isDraw ? { r: 0.25, g: 0.8, b: 0.45, a: 0.25 } : { r: 0.6, g: 0.55, b: 0.95, a: 0.25 },
        undefined,
        1,
        this.r.interactionService
      );
      previewBox.isPreview = true;
      previewBox.scaleX = 0.001;
      previewBox.scaleY = 0.001;
      this.r.interactionService.boxSelectPreview = previewBox;
      previewBox.markDirty();

      this.r.mode = { kind: 'boxSelecting', startCanvas: [mouseX, mouseY], rect, draw: isDraw };
      this.r.scheduleRender();
      // this.r.interactionService.canvas.style.cursor = this.r.getRandomCursor();
      return;
    }

    // If something is selected, begin DRAG
    const selected = Array.from(this.r.interactionService.selectedNodes);
    if (selected.length > 0) {
      let primary = selected[0]; // default fallback

      if (topNode && this.r.interactionService.selectedNodes.has(topNode)) {
        primary = topNode; // use the clicked node if it's in the selection
      } else if (selected.length === 1) {
        primary = selected[0]; // single selection case
      } else {
        // Multiple selection but clicked outside - find the best primary
        primary = selected.reduce((best, current) => 
          (current as Shape).zIndex > (best as Shape).zIndex ? current : best
        );
      }

      // Build drag data
      const dragOffset: Vec2 = [worldX - (primary as Node).x, worldY - (primary as Node).y];

      const initialGroupChildPositions = new Map<Group, Vec2>();
      if (primary instanceof Section) {
        primary.forEachDeep((node) => {
          if (node instanceof Group) {
            initialGroupChildPositions.set(node, [node.x, node.y]);
          }
        });
      }

      // Packed arrays for hot path
      const nodes = selected.filter(n => n instanceof Shape || n instanceof Group) as (Shape|Group)[];
      const x0 = new Float32Array(nodes.length);
      const y0 = new Float32Array(nodes.length);
      nodes.forEach((n,i) => { x0[i] = n.x; y0[i] = n.y; });

      // Primary’s initial world position (used to compute delta)
      const primaryX0 = (primary as Node).x;
      const primaryY0 = (primary as Node).y;

      // Precompute world->parentLocal at drag start
      const invParentAtDrag = nodes.map(n => {
        const inv = mat4.create();
        // n.parentChainMatrix == parent's world transform for n
        // (root if no parent)
        return this.r.safeInvert(inv, n.parentChainMatrix);
      });

      this.beginUndoCapture(primary instanceof Shape || primary instanceof Group ? [...nodes, primary] : nodes);
      this.r.mode = {
        kind: 'dragging',
        data: {
          primary, rect, dragOffset, nodes, x0, y0, primaryX0, primaryY0,
          initialGroupChildPositions,
          invParentAtDrag,  // <— pass it along
        }
      };

      this.r.scheduleRender();
    }
  }

  private isDescendantOf(node: Node, group: any): boolean {
      let current = node.parent;
      while (current) {
          if (current === group) return true;
          current = current.parent;
      }
      return false;
  }

    private groupSelectedShapes() {
      if (this.r.interactionService.selectedNodes.size <= 1) {
          console.log("Select at least 2 shapes to group.");
          return;
      }
  
      const selectedNodes = Array.from(this.r.interactionService.selectedNodes);
  
      // Step 1: Only group top-level selected nodes (skip nested ones)
      const topLevelNodes = selectedNodes.filter(node => {
          let current = node.parent;
          while (current) {
              if (this.r.interactionService.selectedNodes.has(current)) return false;
              current = current.parent;
          }
          return true;
      });
  
      const shapesToGroup = topLevelNodes.filter(n => n instanceof Shape || n instanceof Group) as (Shape | Group)[];
  
      if (shapesToGroup.length <= 1) {
          console.log("Select at least 2 top-level shapes/groups to group.");
          return;
      }

      // P1 undo: snapshot before reparenting; the new group rides in via commit's extraSeeds below.
      const undoToken = this.r.interactionService.vectorUndo.begin(this.r.sceneGraph.root, shapesToGroup);

      const group = new Group(this.r.interactionService);
      group.zIndex = Math.max(...shapesToGroup.map(s => s.zIndex)) + 1;
      // Stamp the members' vector layer at CREATION — the load-time backfill used to assign it,
      // which made a save→load→save cycle non-idempotent (P6 round-trip drive, 2026-09-15).
      group.layerId = shapesToGroup.find((s) => s.layerId !== undefined)?.layerId;
  
      // Compute average world position to place new group at center
      const worldPositions: Vec2[] = shapesToGroup.map(node => {
        // Combined matrix translation = world position (the getter composes the parent chain).
        const m = (node as Shape | Group).localMatrix as unknown as Float32Array;
        return [m[12], m[13]] as Vec2;
      });
  
      const avgX = worldPositions.reduce((sum, p) => sum + p[0], 0) / worldPositions.length;
      const avgY = worldPositions.reduce((sum, p) => sum + p[1], 0) / worldPositions.length;

      const avgCenter = vec4.fromValues(avgX, avgY, 0, 1);
      // Convert from world to local (relative to group.parent)
      const inverseParentMatrix = mat4.invert(mat4.create(), group.parentChainMatrix);
      vec4.transformMat4(avgCenter, avgCenter, inverseParentMatrix);

      group.x = avgCenter[0];
      group.y = avgCenter[1];
      group.updateLocalMatrix();

      const inverseGroupMatrix = mat4.invert(mat4.create(), group._localMatrix);

      for (const node of shapesToGroup) {
        const worldMatrix = mat4.mul(mat4.create(), node.parentChainMatrix, node._localMatrix);
        if (node instanceof Group) {
            const offset = vec4.fromValues(0, 0, 0, 1);
            vec4.transformMat4(offset, offset, worldMatrix);
            vec4.transformMat4(offset, offset, inverseGroupMatrix);
        
            node.x = offset[0];
            node.y = offset[1];
            node.updateLocalMatrix();
        
            node.parent?.removeChild(node);
            node.transformMode = "inherit";
            group.addChild(node);
        
            
            // Rebase children of the nested group
            // this.fixNestedGroupChildren(node);
        }
        else {
            // Convert world position into group-local space
            const worldPos = vec4.fromValues(0, 0, 0, 1);
            vec4.transformMat4(worldPos, worldPos, worldMatrix);
            vec4.transformMat4(worldPos, worldPos, inverseGroupMatrix);

            node.x = worldPos[0];
            node.y = worldPos[1];
            node.updateLocalMatrix();

            node.parent?.removeChild(node);
            node.transformMode = "inherit";
            group.addChild(node);
        }
      }
  
      this.r.sceneGraph.root.addChild(group);
      group.recalculateSize();
  
      // Clear visual selection from old shapes
      for (const shape of shapesToGroup) {
          shape.deselect(); // Ensure visual deselection
      }

      this.r.interactionService.clearSelectedNodes();
      this.r.interactionService.selectNode(group);
      this.r.interactionService.vectorUndo.commit(undoToken, 'Group shapes', [group]);
      this.r.interactionService.onSceneGraphChanged.emit();
    }

    fixNestedGroupChildren(group: Group) {
      const inverseGroupMatrix = mat4.invert(mat4.create(), group.localMatrix);
      group.forEachDeep((child) => {
          if (child === group) return;
  
          const localToWorld = (child as Shape).localMatrix;
          const worldPos = vec4.transformMat4(vec4.create(), vec4.fromValues(0, 0, 0, 1), localToWorld);
          const newLocal = vec4.transformMat4(vec4.create(), worldPos, inverseGroupMatrix);
  
          child.x = newLocal[0];
          child.y = newLocal[1];
          child.updateLocalMatrix();
      });
    }

    private ungroupSelectedShapes() {
      const nodes = Array.from(this.r.interactionService.selectedNodes);
      const newlyUngroupedChildren: Node[] = [];

      // P1 undo: the watch set (each group + descendants + ancestors) covers everything ungroup
      // touches; the detached group node is RETAINED by the command, so undo re-attaches the
      // original instance with its id intact.
      const undoToken = this.r.interactionService.vectorUndo.begin(this.r.sceneGraph.root, nodes);

      for (const node of nodes) {
          if (node instanceof Group && node.getType() !== 'Sticky Note' && node.getType() !== 'Speech Balloon') {
              // Children go to the GROUP'S PARENT (root for a top-level group — the classic behavior;
              // the enclosing group when ungrouping a NESTED one, so they stay inside it). Positions are
              // rebased through TRUE world coords, exact at any nesting depth (audit 2026-09-14 — the old
              // world-minus-group subtraction only worked for translate-only, root-level groups).
              const parentNode = node.parent ?? this.r.sceneGraph.root;
              const parentIsRoot = parentNode === this.r.sceneGraph.root;
              const invParent = parentIsRoot ? null
                  : mat4.invert(mat4.create(), (parentNode as Shape | Group).localMatrix);

              // Snapshot: removeChild now splices in place (§3.1) — iterating the live
              // array while removing would skip every other child.
              for (const child of [...node.children]) {
                  // World position BEFORE reparenting (the parent chain is still intact here).
                  const [wx, wy] = this.getWorldPosition(child);

                  node.removeChild(child);
                  parentNode.addChild(child);

                  if (invParent) {
                      const local = vec4.transformMat4(vec4.create(), vec4.fromValues(wx, wy, 0, 1), invParent);
                      child.x = local[0];
                      child.y = local[1];
                  } else {
                      child.x = wx;
                      child.y = wy;
                  }
                  // Compose the vanishing group's OWN rotation/scale into the child so it keeps its
                  // world orientation + size (2026-09-14 — position alone snapped rotated/scaled
                  // groups back on ungroup). Group scale is normally 1 (bakeScaleToLeaves runs at
                  // scale pointer-up), so the multiply is a no-op on the usual path; a non-uniform
                  // group scale over a rotated child is a shear neither TRS can express — nearest fit.
                  if (child instanceof Shape || child instanceof Group) {
                      child.rotation += node.rotation;
                      child.scaleX = (child.scaleX ?? 1) * (node.scaleX ?? 1);
                      child.scaleY = (child.scaleY ?? 1) * (node.scaleY ?? 1);
                  }
                  child.updateLocalMatrix();
                  newlyUngroupedChildren.push(child);
              }

              // Remove the now-empty group
              if (node.parent) {
                  node.parent.removeChild(node);
              }
          }
      }

      // Select the newly ungrouped children
      this.r.interactionService.clearSelectedNodes();
      for (const child of newlyUngroupedChildren) {
          this.r.interactionService.selectNode(child);
      }

      this.r.interactionService.vectorUndo.commit(undoToken, 'Ungroup shapes');
      this.r.interactionService.onSceneGraphChanged.emit();
    }

    private getWorldPosition(node: Node): [number, number] {
      // `localMatrix` is the COMBINED matrix (the getter composes the parent chain) — its translation
      // IS the world position. The old chain × combined product double-counted every ancestor, which
      // happened to cancel in the flat ungroup case but teleported children when ungrouping a group
      // that was still NESTED inside another (audit 2026-09-14).
      const m = (node as Shape | Group).localMatrix as unknown as Float32Array;
      return [m[12], m[13]];
    }

    /* About Transformed Mouse Coordinates:
    The transformMouseCoordinates method takes the mouse coordinates and transforms them from 
    screen space into the shape's coordinate space using the inverse of the worldMatrix. This allows the 
    click detection to occur in the correct space relative to the transformed shapes.

    By inverting the worldMatrix, you effectively reverse the scaling, translation, and any other 
    transformations applied to the shapes, mapping the mouse position back to the original coordinate space of the shapes.

    The transformed coordinates are then used to detect which shape is being clicked and to calculate the offset for dragging.
    -------------------------------------------------------------------------------------------------------------------------*/
    private transformMouseCoordinatesToWorldSpace(x: number, y: number): Vec2 {
        return this.r.canvasPxToWorld(x, y);
    }

  public handlePointerMove(event: PointerEvent) {
    // TOUCH-5/7: a pinch consumes every finger; otherwise only the gesture's own finger drives it.
    if (event.pointerType === 'touch') {
      const id = event.pointerId ?? 0;
      const t = this._touches.get(id);
      if (!t) return;
      t.x = event.clientX; t.y = event.clientY;
      if (this._pinch) { this._pinchMove(); return; }
      if (id !== this._primaryTouchId) return;
    }
    const mouseX = event.offsetX;
    const mouseY = event.offsetY;
    let interacted = false;

    // Always track cursor world position (for connection-port hover dots)
    const [cwx, cwy] = this.r.canvasPxToWorld(mouseX, mouseY);
    this.r._cursorWorldX = cwx;
    this.r._cursorWorldY = cwy;

    // UI System: hover an interactive shape → set its cursor + fire hover/hoverEnd. No-op unless interactive preview
    // is on; only while idle so it never fights an active drag/pan.
    if (this.r._uiPointerHandler && this.r.mode.kind === 'idle') {
      const cur = this.r._uiPointerHandler.onMove(cwx, cwy, mouseX, mouseY);
      if (cur) this.r.canvas.style.cursor = cur;
    }
    // Play mode (Round 8): nothing below applies (2D hover hit-tests, cursor updates, drags) — and it skips a
    // getBoundingClientRect layout read per mouse move under pointer-lock.
    if (this.r.interactionService.playActive && this.r.mode.kind === 'idle') return;

    // Track pointer UV for shader uniforms (cursor-reactive text effects)
    const rect = this.r.canvas.getBoundingClientRect();
    this.r.interactionService.lastPointerUV = [
      Math.max(0, Math.min(1, mouseX / rect.width)),
      Math.max(0, Math.min(1, mouseY / rect.height)),
    ];

    // Text-draw mode hover: while idle (no drag), highlight the LiveText node under the cursor
    // (topmost wins) among the discoverability outlines.
    if (this.r.mode.kind === 'idle' && this.r.interactionService.rectDrawCallback) {
      const ltNodes = this.r.webGPURenderStrategy.getLiveTextNodes();
      let hit: string | null = null;
      for (let i = ltNodes.length - 1; i >= 0; i--) {
        if (ltNodes[i].containsPoint(cwx, cwy)) { hit = ltNodes[i].id; break; }
      }
      if (hit !== this.r.interactionService.hoveredLiveTextId) {
        this.r.interactionService.hoveredLiveTextId = hit;
        this.r.scheduleRender();
      }
    }

    switch (this.r.mode.kind) {
      case 'panning': {
        const [lx, ly] = this.r.mode.lastClient;
        // Pan units are backing px × 2 (adjustPan), so a CSS delta scales by the ACTUAL backing ratio: the bare
        // (delta × 2) moved the content 1/ratio of the pointer, e.g. 2/3 of the finger on a DPR-capped tablet.
        const k = this._cssToBacking(rect) * 2;   // this move's rect (read above)
        const dx = (event.clientX - lx) * k;
        const dy = (event.clientY - ly) * k;

        this.r.interactionService.adjustPan(
            dx, 
            dy, 
            this.r.illustrationMode, 
            this.r.illustrationBounds
        );
        
        if (!this.r.backgroundPatternFixed) {
            this.r.bgDirty.matrix = true;
        }

        this.r.renderListDirty = true;
        
        this.r.mode.lastClient = [event.clientX, event.clientY];
        interacted = true;
        break;
      }

      case 'draggingPlacement': {
        const [wx, wy] = this.r.canvasPxToWorld(mouseX, mouseY);
        const { layerId, placementId, startWorldX, startWorldY, placementX0, placementY0 } = this.r.mode.data;
        const newX = placementX0 + (wx - startWorldX);
        const newY = placementY0 + (wy - startWorldY);
        this.r._ephemeraUpdateCallback?.(layerId, placementId, newX, newY);
        interacted = true;
        break;
      }

      case 'resizingPlacement': {
        const [wx, wy] = this.r.canvasPxToWorld(mouseX, mouseY);
        const { layerId, placementId, handle, anchorX, anchorY } = this.r.mode.data;
        this.r._ephemeraResizeCallback?.(layerId, placementId, handle, anchorX, anchorY, wx, wy);
        interacted = true;
        break;
      }

      case 'rotatingPlacement': {
        const [wx, wy] = this.r.canvasPxToWorld(mouseX, mouseY);
        const { layerId, placementId, centerX, centerY, startAngle, startRotation } = this.r.mode.data;
        this.r._ephemeraRotateCallback?.(layerId, placementId, centerX, centerY, startAngle, startRotation, wx, wy);
        interacted = true;
        break;
      }

      case 'dragging': {
        this.r.renderListDirty = true;
        const [modelX, modelY] = this.r.canvasPxToWorld(event.offsetX, event.offsetY);
        const { primary, dragOffset, initialGroupChildPositions, primaryX0, primaryY0 } = this.r.mode.data;

        const deltaX = modelX - (primaryX0 + dragOffset[0]);
        const deltaY = modelY - (primaryY0 + dragOffset[1]);

        const { nodes, x0, y0, invParentAtDrag } = this.r.mode.data;

        // Unbind connector bindings on first actual move (not just click)
        for (const n of nodes) {
          if (n instanceof Line && (n.startBinding || n.endBinding)) {
            n.startBinding = null;
            n.endBinding = null;
          }
        }
        const dxW = deltaX, dyW = deltaY;

        // Update positions
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const invP = invParentAtDrag[i];
          const dxL = invP[0] * dxW + invP[4] * dyW;
          const dyL = invP[1] * dxW + invP[5] * dyW;
          n.x = x0[i] + dxL;
          n.y = y0[i] + dyL;
          n.updateLocalMatrix();
          n.markDirty();
          
          // Mark ALL ancestor groups for update
          let parent = n.parent;
          while (parent) {
            if (parent instanceof Group) {
              this.r.pendingGroupBounds.add(parent);
              // Also mark the parent's bounding box as needing recalc
              parent.cachedWorldSpaceBoundingPolygon = null;
            }
            parent = parent.parent;
          }
          
          // If the node itself is a group, mark it too
          if (n instanceof Group) {
            this.r.pendingGroupBounds.add(n);
            n.cachedWorldSpaceBoundingPolygon = null;
          }
        }

        // Keep Section children visually fixed
        if (primary instanceof Section) {
          primary.forEachDeep((n) => {
            if (n instanceof Group) {
              const childInitial = initialGroupChildPositions.get(n);
              if (!childInitial) return;
              const inv = mat4.invert(mat4.create(), primary.parentChainMatrix)!; // section's parent
              const dxL = inv[0]*deltaX + inv[4]*deltaY;
              const dyL = inv[1]*deltaX + inv[5]*deltaY;
              n.x = childInitial[0] - dxL;
              n.y = childInitial[1] - dyL;
              n.updateLocalMatrix();
            }
          });
        }

        interacted = true;
        if(nodes.length > 0) { 
          this.r.interactionService.onSceneGraphChanged.emit(); 
        }
        break;
      }

      case 'boxSelecting': {
        const [startXc, startYc] = this.r.mode.startCanvas;
        const [startX, startY] = this.transformMouseCoordinatesToWorldSpace(startXc, startYc);

        const x = event.clientX - this.r.mode.rect.left;
        const y = event.clientY - this.r.mode.rect.top;
        const [endX, endY] = this.transformMouseCoordinatesToWorldSpace(x, y);

        const x1 = Math.min(startX, endX);
        const y1 = Math.min(startY, endY);
        const x2 = Math.max(startX, endX);
        const y2 = Math.max(startY, endY);

        const w = x2 - x1, h = y2 - y1;
        const cx = x1 + w / 2, cy = y1 + h / 2;

        // preview box
        if (!this.r.interactionService.boxSelectPreview) {
          const box = new Rectangle(cx, cy, w, h, { r: 0.6, g: 0.55, b: 0.95, a: 0.25 }, undefined, 1, this.r.interactionService);
          box.isPreview = true;
          this.r.interactionService.boxSelectPreview = box;
          box.markDirty();
        } else {
          const box = this.r.interactionService.boxSelectPreview;
          box.x = cx; box.y = cy; box.scaleX = w; box.scaleY = h; box.markDirty();
        }

        // In rect-DRAW mode (LiveText click-drag) we only show the box — no node selection.
        if (!this.r.mode.draw) {
          // selection polygon (world space)
          const selectionPolygon: Vec2[] = [
            [x1, y1], [x2, y1], [x2, y2], [x1, y2],
          ];

          const allNodes = this.r.selectionService.findAllShapesDeep(this.r.sceneGraph.root);
          const topLevelMatches = allNodes.filter(node => {
            if (this.r.stickyAncestorOf(node)) return false;
            if (this.r.speechBalloonAncestorOf(node)) return false;
            const intersects = polygonsIntersect(node.getWorldSpaceBoundingBoxPolygon(), selectionPolygon);
            if (!intersects) return false;
            if(node.locked) return false;
            // Same active-vector-layer gate as single-click picking: a shape whose layer is
            // inactive is inert, so the marquee can't grab it either.
            if (!this.r.selectionService.isInteractable(node)) return false;
            let cur = node.parent;
            while (cur) {
              if (cur instanceof Group && allNodes.includes(cur)) return false;
              cur = cur.parent;
            }
            return true;
          });

          for (const n of allNodes) n.deselect();
          this.r.interactionService.clearSelectedNodes();
          for (const n of topLevelMatches) { n.select(); this.r.interactionService.selectNode(n); }
        }

        interacted = true;
        break;
      }

      case 'rotating': {
        if (this.r.interactionService.selectedNodes.size === 1) {
          const shape = Array.from(this.r.interactionService.selectedNodes)[0] as Shape;
          const currentMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
          const angleDifference = currentMouseAngle - this.r.mode.data.initialMouseAngle;
          shape.rotation = this.r.mode.data.initialRotation + angleDifference;
          shape.markDirty();
        }
        interacted = true;
        this.r.interactionService.onSceneGraphChanged.emit();
        break;
      }

      case 'scaling': {
        this.r.renderListDirty = true;
        if (this.r.interactionService.selectedNodes.size === 1) {
          const shape = Array.from(this.r.interactionService.selectedNodes)[0] as Shape;
          const { side, initial, prevCenter } = this.r.mode.data;

          const [modelX, modelY] = this.r.canvasPxToWorld(mouseX, mouseY);
          const mouseMovementX = modelX - this.r.mode.data.anchorWorld[0];
          const mouseMovementY = modelY - this.r.mode.data.anchorWorld[1];

          const rot = shape.rotation;
          const cosT = Math.cos(rot), sinT = Math.sin(rot);
          const alongW =  (mouseMovementX * cosT + mouseMovementY * sinT);
          const alongH = (-mouseMovementX * sinT + mouseMovementY * cosT);

          const minW = 0.05, minH = 0.05;

          const apply = (newW: number, newH: number, dxCenter: number, dyCenter: number) => {
            if (shape instanceof Group) {
              const tgtW = Math.max(minW, newW);
              const tgtH = Math.max(minH, newH);

              if (this.r.mode.kind === 'scaling') {
                const sx = (this.r.mode.data.initial.baseW > 0) ? (tgtW / this.r.mode.data.initial.baseW) : 1;
                const sy = (this.r.mode.data.initial.baseH > 0) ? (tgtH / this.r.mode.data.initial.baseH) : 1;

                shape.scaleX = sx;
                shape.scaleY = sy;
              }
            } else if (shape instanceof LiveTextNode) {
              // LiveText resizes its TEXT FRAME, not via scaleX: the box takes the dragged size,
              // the text reflows at its own font size (no glyph scaling), and width/height update
              // this tick so the selection box tracks the drag live (no bake-on-release lag).
              shape.resizeFrameWorld(Math.max(minW, newW), Math.max(minH, newH));
            } else {
              // scaleX/scaleY are a MULTIPLIER on the shape's base size, so divide the target
              // world size by the base. No-op for unit-quad shapes (baseW=1 → scaleX=newW), and
              // correct for real-size shapes like LiveText (baseW=realW → scaleX=newW/realW).
              // The old code (scaleX=newW) assumed baseW=1 and mis-scaled real-size shapes.
              const bW = (this.r.mode.kind === 'scaling' && this.r.mode.data.initial.baseW > 0) ? this.r.mode.data.initial.baseW : 1;
              const bH = (this.r.mode.kind === 'scaling' && this.r.mode.data.initial.baseH > 0) ? this.r.mode.data.initial.baseH : 1;
              shape.scaleX = Math.max(minW, newW) / bW;
              shape.scaleY = Math.max(minH, newH) / bH;
            }

            if (this.r.mode.kind === 'scaling') {
              shape.x = this.r.mode.data.initial.x + dxCenter;
              shape.y = this.r.mode.data.initial.y + dyCenter;
            }

            shape.updateLocalMatrix();
            shape.markDirty();

            if (shape instanceof Group) {
              shape.forEachDeep(ch => {
                if (ch === shape) return;
                ch.updateLocalMatrix();
                if (ch instanceof Shape) ch.triggerRerender();
              });
            }

            // Mark parent groups for update
            let parent = shape.parent;
            while (parent) {
              if (parent instanceof Group) {
                this.r.pendingGroupBounds.add(parent);
              }
              parent = parent.parent;
            }

            // keep Section children visually fixed
            if (shape instanceof Section) {
              const deltaX = shape.x - prevCenter[0];
              const deltaY = shape.y - prevCenter[1];
              for (const child of shape.children) {
                child.x -= deltaX;
                child.y -= deltaY;
                child.updateLocalMatrix();
              }
              if (this.r.mode.kind === 'scaling') {
                this.r.mode.data.prevCenter = [shape.x, shape.y];
              }
            }
          };

          // Handle all scaling sides (keeping your existing logic)
          switch (side) {
            case 'left': {
              const newW = initial.width - alongW;
              const dx = (initial.width - Math.max(minW, newW)) / 2;
              apply(newW, initial.height, dx * cosT, dx * sinT);
              break;
            }
            case 'right': {
              const newW = initial.width + alongW;
              const dx = (Math.max(minW, newW) - initial.width) / 2;
              apply(newW, initial.height, dx * cosT, dx * sinT);
              break;
            }
            case 'top': {
              const newH = initial.height + alongH;
              const dy = (Math.max(minH, newH) - initial.height) / 2;
              apply(initial.width, newH, -dy * sinT, dy * cosT);
              break;
            }
            case 'bottom': {
              const newH = initial.height - alongH;
              const dy = (initial.height - Math.max(minH, newH)) / 2;
              apply(initial.width, newH, -dy * sinT, dy * cosT);
              break;
            }
            case 'topLeft': {
              const newW = initial.width - alongW;
              const newH = initial.height + alongH;
              const dx = (initial.width - Math.max(minW, newW)) / 2;
              const dy = (Math.max(minH, newH) - initial.height) / 2;
              apply(newW, newH, dx * cosT - dy * sinT, dx * sinT + dy * cosT);
              break;
            }
            case 'topRight': {
              const newW = initial.width + alongW;
              const newH = initial.height + alongH;
              const dx = (Math.max(minW, newW) - initial.width) / 2;
              const dy = (Math.max(minH, newH) - initial.height) / 2;
              apply(newW, newH, dx * cosT - dy * sinT, dx * sinT + dy * cosT);
              break;
            }
            case 'bottomLeft': {
              const newW = initial.width - alongW;
              const newH = initial.height - alongH;
              const dx = (initial.width - Math.max(minW, newW)) / 2;
              const dy = (initial.height - Math.max(minH, newH)) / 2;
              apply(newW, newH, dx * cosT - dy * sinT, dx * sinT + dy * cosT);
              break;
            }
            case 'bottomRight': {
              const newW = initial.width + alongW;
              const newH = initial.height - alongH;
              const dx = (Math.max(minW, newW) - initial.width) / 2;
              const dy = (initial.height - Math.max(minH, newH)) / 2;
              apply(newW, newH, dx * cosT - dy * sinT, dx * sinT + dy * cosT);
              break;
            }
          }
          this.r.interactionService.onSceneGraphChanged.emit();
          interacted = true;
        }
        break;
      }

      case 'endpointDragging': {
        const { line, which } = this.r.mode.data;
        const [wx, wy] = this.r.canvasPxToWorld(mouseX, mouseY);
        let ex = wx, ey = wy;

        // Snap to nearest connection port (world space)
        const snap = this.r._connectorService?.findSnapTarget(wx, wy, line.id);
        if (snap) { ex = snap.x; ey = snap.y; }

        // Convert world-space position to line-local space
        const inv = line.getInverseLocalMatrix();
        const lx = inv[0] * ex + inv[4] * ey + inv[12];
        const ly = inv[1] * ex + inv[5] * ey + inv[13];

        if (which === 'start') {
          line.updateStartPoint(lx, ly);
        } else {
          line.updateEndPoint(lx, ly);
        }

        this.r.canvas.style.cursor = 'crosshair';
        this.r.interactionService.onSceneGraphChanged.emit();
        interacted = true;
        break;
      }

      case 'idle': {
        // Idle hover cursor only
        const sel = this.r.interactionService.selectedNodes;
        if (sel.size === 1) {
          const shape = sel.values().next().value as Shape;
          if (shape?.boundingBox) {
            const worldMouse: Vec2 = this.r.canvasPxToWorld(mouseX, mouseY);

            // Line endpoint handle cursor
            if (shape instanceof Line) {
              const endpointThreshold = 0.02;
              const m = shape.localMatrix;
              const wx1 = m[0] * shape.x1 + m[4] * shape.y1 + m[12];
              const wy1 = m[1] * shape.x1 + m[5] * shape.y1 + m[13];
              const wx2 = m[0] * shape.x2 + m[4] * shape.y2 + m[12];
              const wy2 = m[1] * shape.x2 + m[5] * shape.y2 + m[13];
              const dStart = Math.hypot(wx1 - worldMouse[0], wy1 - worldMouse[1]);
              const dEnd   = Math.hypot(wx2 - worldMouse[0], wy2 - worldMouse[1]);
              if (Math.min(dStart, dEnd) <= endpointThreshold) {
                this.r.canvas.style.cursor = 'crosshair';
                this.r.scheduleRender();
                break;
              }
            }

            if (isNearRotationHandle(shape, worldMouse)) {
              this.r.canvas.style.cursor = 'grab';
            } else {
              const side = getScalingSide(shape, worldMouse);
              if(!this.r.eraserService?.isEnabled 
                && !this.r.scribbleDrawingService?.isEnabled
                && !this.r.highlightDrawingService?.isEnabled
                && !this.r.patternDrawingService?.isEnabled
                && !this.r.stampDrawingService?.isEnabled) {
                this.r.canvas.style.cursor = side ? CURSORS[side] : `url('${pointerCursorUrl}'), auto`;
              }
            }
          }
        }
        // Re-render so connection-port dots / endpoint dots update on hover
        if (this.r.lineDrawingService?.isEnabled) {
          this.r.scheduleRender();
        } else if (sel.size === 1) {
          const n = sel.values().next().value;
          if (n instanceof Line) this.r.scheduleRender();
        }
        break;
      }
    }

    if (interacted) {
      for (const node of this.r.interactionService.selectedNodes) {
        if (node instanceof Group) {
          node.forEachDeep(ch => { if (ch instanceof Shape) ch.triggerRerender(); });
        } else if (node instanceof Shape) {
          node.triggerRerender();
        }
      }
      this.r.scheduleRender();
    }
  }

  private getTopLevelSelectedNodes(): Node[] {
    const allNodes = Array.from(this.r.interactionService.selectedNodes);
    return allNodes.filter(node => {
        let current = node.parent;
        while (current) {
            if (this.r.interactionService.selectedNodes.has(current)) {
                return false; // If a parent is selected too, skip this node
            }
            current = current.parent;
        }
        return true;
    });
  }

  private cacheRect(): DOMRect {
    return this.r.canvas.getBoundingClientRect();
  }

  /* When dragging/moving a Group, you need to re-trigger rerender on any child scribbles/highlights/lines that 
      use world space geometry. Otherwise they don't move correctly while dragging. */
  triggerRerenderForStrokesDeep(node: Node) {
    node.forEachDeep(n => {
        if (n instanceof Scribble || n instanceof Highlight || n instanceof Line) {
            (n as Shape).triggerRerender();
        }
    });
  }

  /** When scaling a Section or ungrouping — if the Section/Group moves, 
   * you sometimes need to move its children back into world space correctly. 
   * Again: not just immediate children — all nested children recursively. */
  moveChildrenByDeltaDeep(node: Node, dx: number, dy: number) {
    node.forEachDeep(n => {
        if (n instanceof Shape) {
            n.x += dx;
            n.y += dy;
            n.updateLocalMatrix();
        }
    });
  }

  public handlePointerUp(event: PointerEvent) {
  if (event.pointerType === 'touch') {
    const id = event.pointerId ?? 0;
    if (!this._touches.has(id)) return;
    this._touches.delete(id);
    if (this._pinch) {
      // The pinch ends when its 2nd finger lifts; the remaining finger does nothing until it lifts too (the
      // cancelled 1-finger gesture never resumes mid-air).
      if (this._touches.size === 0) this._pinch = null;
      else if (this._touches.size >= 2) this._beginPinch();   // the finger pair changed: re-seed (no jump)
      return;
    }
    if (id !== this._primaryTouchId) return;
    this._primaryTouchId = null;
  }
  // Track pointer state for shader uniforms
  this.r.interactionService.pointerDown = false;
  if (this.r.interactionService.playActive && this.r.mode.kind === 'idle') return;   // Play (Round 8): nothing to finish

  this.r.renderListDirty = true;
  this.r.scheduleRender();

  // ── Endpoint drag finalization ──
  // Ephemera placement interaction finalization
  if (this.r.mode.kind === 'draggingPlacement' ||
      this.r.mode.kind === 'resizingPlacement' ||
      this.r.mode.kind === 'rotatingPlacement') {
    this.r.mode = { kind: 'idle' };
    this.r.interactionService.endInteractive();
    return;
  }

  if (this.r.mode.kind === 'endpointDragging') {
    const { line, which } = this.r.mode.data;
    const [wx, wy] = this.r.canvasPxToWorld(event.offsetX, event.offsetY);
    const inv = line.getInverseLocalMatrix();
    const snap = this.r._connectorService?.findSnapTarget(wx, wy, line.id);
    if (snap) {
      // Snap position is world-space; convert to local
      const lx = inv[0] * snap.x + inv[4] * snap.y + inv[12];
      const ly = inv[1] * snap.x + inv[5] * snap.y + inv[13];
      if (which === 'start') {
        line.updateStartPoint(lx, ly);
        line.startBinding = { shapeId: snap.shapeId, portId: snap.portId };
      } else {
        line.updateEndPoint(lx, ly);
        line.endBinding = { shapeId: snap.shapeId, portId: snap.portId };
      }
    } else {
      // Not snapped — clear binding for that endpoint
      if (which === 'start') line.startBinding = null;
      else line.endBinding = null;
    }
    this.r.mode = { kind: 'idle' };
    // P1 undo: one 'Edit line' command per endpoint drag (endpoints are in the snapshot).
    if (this._undoToken) {
      const token = this._undoToken;
      this._undoToken = null;
      this.r.interactionService.vectorUndo.commit(token, 'Edit line');
    }
    this.r.interactionService.onSceneGraphChanged.emit();
    this.r.interactionService.endInteractive();
    return;
  }

  const wasDragging = this.r.mode.kind === 'dragging';
  const wasBoxSelecting = this.r.mode.kind === 'boxSelecting';
  const wasScaling = this.r.mode.kind === 'scaling';
  const wasRotating = this.r.mode.kind === 'rotating';
  const dragData = this.r.mode.kind === 'dragging' ? this.r.mode.data : null;
  const dragPrimary = dragData?.primary || null;

  // Clear box select preview if we were box selecting. In rect-DRAW mode, emit the drawn
  // WORLD rect (top-left + size ≥ 0) + the release client coords (for the caret handshake)
  // instead of selecting — the LiveText tool decides click vs drag from the rect size.
  if (wasBoxSelecting) {
    const pb = this.r.interactionService.boxSelectPreview;
    const drawCb = this.r.interactionService.rectDrawCallback;
    if (this.r.mode.kind === 'boxSelecting' && this.r.mode.draw && pb && drawCb) {
      const w = Math.abs(pb.scaleX), h = Math.abs(pb.scaleY);
      drawCb({ x: pb.x - w / 2, y: pb.y - h / 2, w, h }, event.clientX, event.clientY);
    }
    this.r.interactionService.boxSelectPreview = null;
  }

  // Handle scaling normalization first
  if (wasScaling) {
    for (const node of this.r.interactionService.selectedNodes) {
      if (node instanceof Group) {
        this.r.bakeScaleToLeaves(node);
      } else if (node instanceof LiveTextNode) {
        // Fold the scale into the node's width/height so node.width/height = the visual size
        // (and scaleX/scaleY → 1), keeping width/height-based selection UIs in sync.
        node.bakeUserScale();
      }
    }
  }

  // Update all affected parent groups after drag/scale
  if (wasDragging || wasScaling) {
    // Add any groups that were explicitly moved/scaled
    const movedNodes = wasDragging && dragData 
      ? dragData.nodes 
      : Array.from(this.r.interactionService.selectedNodes).filter(n => n instanceof Shape || n instanceof Group) as (Shape|Group)[];
    
    for (const node of movedNodes) {
      let parent = node.parent;
      while (parent) {
        if (parent instanceof Group) {
          this.r.pendingGroupBounds.add(parent);
        }
        parent = parent.parent;
      }
      if (node instanceof Group) {
        this.r.pendingGroupBounds.add(node);
      }
    }

    // Now update all pending groups
    this.updatePendingGroups();
  }

  // Handle Section logic (removing children that moved outside)
  this.handleSectionChildrenAfterMove();

  // Buttons
  if (event.button === 1) {
    // middle mouse
  } else if (event.button === 0) {
    // left mouse - already handled box select preview above
  }

  // Reset mode
  this.r.mode = { kind: 'idle' };
  if(!this.r.eraserService?.isEnabled 
    && !this.r.scribbleDrawingService?.isEnabled
    && !this.r.highlightDrawingService?.isEnabled
    && !this.r.patternDrawingService?.isEnabled
    && !this.r.stampDrawingService?.isEnabled) {
    this.r.canvas.style.cursor = this.r.getRandomCursor();
  }

  // Handle drop-into-section logic
  if (dragPrimary && (dragPrimary instanceof Shape || dragPrimary instanceof Group)) {
    this.handleDropIntoSection(dragPrimary as Shape | Group);
  }

  // P1 undo: diff the pointer-down snapshot against the settled graph (section drop-in/out and
  // group recalcs above are inside the same command) and push ONE undo command if anything moved.
  if (this._undoToken) {
    const token = this._undoToken;
    this._undoToken = null;
    if (wasDragging || wasRotating || wasScaling) {
      this.r.interactionService.vectorUndo.commit(
        token, wasDragging ? 'Move shapes' : wasRotating ? 'Rotate shapes' : 'Scale shapes');
    }
  }
}

// 3. NEW method to update all pending groups efficiently
// Also need to fix the updatePendingGroups method in WebGPURenderer to ensure proper order:
private updatePendingGroups(): void {
  if (this.r.pendingGroupBounds.size === 0) return;

  // Collect all affected groups including ancestors
  const allAffectedGroups = new Set<Group>();
  
  for (const group of this.r.pendingGroupBounds) {
    let current: Node | null = group;
    while (current) {
      if (current instanceof Group) {
        allAffectedGroups.add(current);
      }
      current = current.parent;
    }
  }

  // Sort by depth (deepest first)
  const sortedGroups = Array.from(allAffectedGroups).sort((a, b) => {
    return this.r.getNodeDepth(b) - this.r.getNodeDepth(a);
  });
  
  // Update each group
  for (const group of sortedGroups) {
    // Clear cached world space polygon
    group.cachedWorldSpaceBoundingPolygon = null;
    
    // Recalculate size based on children (this is the existing method that works!)
    group.recalculateSize();
  }

  // Clear the pending set
  this.r.pendingGroupBounds.clear();
}

// 4. Extracted Section handling logic
// 4. Keep Section handling logic as is
private handleSectionChildrenAfterMove(): void {
  const sectionsChecked = new Set<Section>();

  for (const node of this.r.interactionService.selectedNodes) {
    if (!(node instanceof Shape)) continue;
    const parent = node.parent;
    if (parent instanceof Section) {
      if (!sectionsChecked.has(parent)) {
        parent.getWorldSpaceBoundingBoxPolygon(true);
        sectionsChecked.add(parent);
      }
      const parentPolygon = parent.getWorldSpaceBoundingBoxPolygon();
      const shapePolygon = node.getWorldSpaceBoundingBoxPolygon(true);

      if (!polygonsIntersect(parentPolygon, shapePolygon)) {
        parent.removeChild(node);
        node.x += parent.x;
        node.y += parent.y;
        this.r.sceneGraph.root.addChild(node);
        node.updateLocalMatrix();
        node.markDirty();
      }
    }
  }

  // Check for Groups that moved out of Sections
  for (const node of this.r.interactionService.selectedNodes) {
    if (!(node instanceof Group)) continue;

    for (const child of this.r.selectionService.findAllShapesDeep(node)) {
      const parent = child.parent;
      if (!(parent instanceof Section)) continue;

      if (!sectionsChecked.has(parent)) {
        parent.getWorldSpaceBoundingBoxPolygon(true);
        sectionsChecked.add(parent);
      }

      const parentPolygon = parent.getWorldSpaceBoundingBoxPolygon();
      const childPolygon = child.getWorldSpaceBoundingBoxPolygon(true);

      if (!polygonsIntersect(parentPolygon, childPolygon)) {
        parent.removeChild(child);
        child.x += parent.x;
        child.y += parent.y;
        this.r.sceneGraph.root.addChild(child);
        child.updateLocalMatrix();
        child.markDirty();
      }
    }
  }

  // Check for Sections that were scaled
  for (const node of this.r.interactionService.selectedNodes) {
    if (!(node instanceof Section)) continue;
    const section = node;
    const sectionPolygon = section.getWorldSpaceBoundingBoxPolygon(true);
    const children = [...section.children];

    for (const child of children) {
      if (!(child instanceof Shape)) continue;
      const childPolygon = child.getWorldSpaceBoundingBoxPolygon(true);

      if (!polygonsIntersect(sectionPolygon, childPolygon)) {
        section.removeChild(child);
        child.x += section.x;
        child.y += section.y;
        this.r.sceneGraph.root.addChild(child);
        child.updateLocalMatrix();
        child.markDirty();
      }
    }
  }
}

// 5. Extracted drop-into-section logic
// 5. Keep drop-into-section logic as is
private handleDropIntoSection(shape: Shape | Group): void {
  const maybeSection = this.findTopSectionContainingShape(shape as Shape);

  if (maybeSection && maybeSection !== shape.parent) {
    const shapeWorld  = mat4.mul(mat4.create(), shape.parentChainMatrix, shape.localMatrix);
const secWorldInv = mat4.invert(mat4.create(),
  mat4.mul(mat4.create(), maybeSection.parentChainMatrix, maybeSection.localMatrix))!;
const newLocal = mat4.mul(mat4.create(), secWorldInv, shapeWorld);
this.r.setFromLocalMatrix(shape as Shape|Group, newLocal);

shape.parent?.removeChild(shape);
maybeSection.addChild(shape);

    shape.updateLocalMatrix?.();
    shape.triggerRerender?.();
    shape.zIndex = (maybeSection.zIndex ?? 0) + 1;
    shape.markDirty?.();
  }
}

  private findTopSectionContainingShape(shape: Shape): Section | null {
      const shapePolygon = shape.getWorldSpaceBoundingBoxPolygon();
  
      const candidates = this.r.sceneGraph.root.children.filter(n =>
          n instanceof Shape && n.getType?.() === "Section" && n !== shape
      ) as Section[];
  
      // Find all sections that contain the shape’s center
      const shapeCenter = [shape.x, shape.y] as [number, number];
      const containingSections = candidates.filter(section =>
          pointInPolygon(shapeCenter, section.getWorldSpaceBoundingBoxPolygon())
      );
  
      // Return topmost by zIndex (if overlapping)
      return containingSections.sort((a, b) => b.zIndex - a.zIndex)[0] || null;
  }
}
