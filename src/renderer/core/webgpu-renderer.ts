import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { GPUPipelineCache } from './gpu-pipeline-cache';
import { GpuFrameTimer } from './gpu-frame-timer';
import { createGpuDeviceHandle, unwrapDevice, type GpuDeviceHandle } from './gpu-device-handle';
import { GpuDeviceStatusTracker, requestSalsaDevice, requestSalsaDeviceWithRetry, WebGPUUnavailableError, describeWebGPUUnavailable,
  showWebGPUOverlay, hideWebGPUOverlay, sweepGpuFields, type SalsaDevice, type GpuDeviceStatusInfo, type GpuDeviceStatusListener } from './gpu-device-recovery';
import { resolveGpuCaps, computeCanvasBacking, gpuJson, DESKTOP_CAPS, type GpuCaps, type GpuTier } from './gpu-capabilities';
import { detectGpuTierNow, recordGpuDeviceLoss, recordGpuError, readLastGpuLoss, readPersistedGpuCrumbs, getGpuCrumbs, getGpuErrors,
  getOpenGpuOps, isGpuSafeModeStored, gpuCrumb, type GpuAdapterFacts, type GpuLossRecord, type GpuCrumb, type GpuErrorRecord } from './gpu-diagnostics';
import { TextEffectEngine } from '../raster/effects/text-effect-engine';
import { ResolutionScaler, sanitizeResolutionScale, type ResolutionScaleSettings, type ResolutionScaleState } from './resolution-scaler';
import { DEFAULT_TEMPORAL_AA, sanitizeTemporalAA, type TemporalAASettings, type TemporalAAState } from '../3d/temporal-aa';
import { WebGPURenderStrategy } from "../render-strategies/webgpu-render-strategy";
import { addZonelessListener, removeZonelessListener } from "../util/zoneless-listeners";
import { Node } from "../../scene-graph/shapes/base/node";
import { InteractionService } from '../../services/interaction-service';
import { mat4, vec3, vec4 } from "gl-matrix";
import { Shape } from "../../scene-graph/shapes/base/shape";
import { LineDrawingService } from "../../services/drawing/line-drawing-service";
import { ScribbleDrawingService } from "../../services/drawing/scribble-drawing-service";
import { EraserService } from "../../services/drawing/eraser-service";
import { HighlightDrawingService } from "../../services/drawing/highlight-drawing-service";
import { PatternDrawingService } from "../../services/drawing/pattern-drawing-service";
import { CacheService } from "../../services/cache-service";
import { TextDrawingService } from "../../services/drawing/text-drawing-service";
import { Rectangle } from "../../scene-graph/shapes/rectangle";
import { Scribble } from "../../scene-graph/shapes/scribble";
import { Highlight as HighlightShape } from "../../scene-graph/shapes/highlight";
import { Line } from "../../scene-graph/shapes/line";
import { Pattern } from "../../scene-graph/shapes/pattern";
import { BindGroupManager } from "./managers/bindgroup-manager";
import { PipelineManager } from "./managers/pipeline-manager";
import { RasterTextureManager } from "../raster/raster-texture-manager";
import { Section } from "../../scene-graph/shapes/section";
import { SectionDrawingService } from "../../services/drawing/section-drawing-service";
import { Group } from "../../scene-graph/shapes/base/group";
import { SDFText } from "../../scene-graph/shapes/sdf-text/sdf-text";
import { StagingContainer } from "../util/staging-container";
import { StrokesStagingBuffer } from "../caches/buffers/strokes-staging-buffer";
import { SdfTextDrawingService } from "../../services/drawing/sdftext-drawing-service";
import { ScalingSide } from "../util/interaction-types";
import { getScalingSide, isNearRotationHandle, canvasPxToWorld, HIT } from "../util/handles";
import { canvasPixelRatio } from "../util/canvas-pixel-ratio";
import { CURSORS, ShapeDimensions, Vec2 } from "../../types/interaction";
import { pointInPolygon, polygonsIntersect } from "../util/geometry";
import { SelectionService } from "../../services/selection-service";

import { CaretManager } from "../../services/drawing/caret-manager";
import { SelectionHighlightManager } from "../../services/drawing/selection-highlight-manager";
import { OverlayDotManager, DotInstance } from "../../services/drawing/overlay-dot-manager";
import { ConnectorService } from "../../services/connector-service";
import { aabbOverlaps, getWorldAABB, viewportAABB } from "../util/aabb";

/** Minimal contract so the renderer can draw the raster-text preview
 *  without importing the concrete RasterTextService (which itself imports
 *  WebGPURenderer, creating a circular dependency). */
import { RasterInteractionController } from './raster-interaction-controller';

export interface IRasterTextPreviewProvider {
  getPreviewTexture(): GPUTexture | null;
  getPreviewInfo(): { destX: number; destY: number; width: number; height: number } | null;
}
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
import { RasterCompositor, LayerBlendMode } from "../raster/core/raster-compositor";
import type { CompositorLayerInfo } from "../raster/core/raster-compositor";
import { onRasterCompositeDirty } from "../raster/core/raster-composite-dirty";
import { setRasterUndoTierBudget } from "../raster/core/raster-undo-budget";
import type { FrameLinkAnimation } from '../../animation';
import { RasterSelectionEngine } from "../raster/selection/raster-selection-engine";
import { SelectionOverlayRenderer } from "../raster/selection/selection-overlay-renderer";
import type { SelectionOverlayState } from "../raster/selection/selection-overlay-renderer";
import { LiveTextNode } from "../../scene-graph/shapes/live-text";
import { Renderer3D } from '../3d/renderer-3d';
import { MeshFsPipelines } from '../3d/mesh-fs-pipelines';
import { Camera3D } from '../3d/camera-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import { GpRenderer3D } from '../3d/gp-renderer-3d';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { RenderListIndex, RL_2D, RL_3D, RL_SKELETON, type RenderListNode } from './render-list-index';
import { RD, rdColorLoad, rdDepthLoad, rdCanvasAlphaMode } from '../3d/render-debug';
import { pickCanvasFormat, readbackToRgba, FALLBACK_CANVAS_FORMAT } from './canvas-format';

/** WebGPURenderer.captureRealFrame result: the raw pixels the renderer produced (RGBA order, alpha as stored, i.e.
 *  premultiplied) and where they were read: 'swapchain' = the canvas texture itself at the end of the frame;
 *  'lastFrameTex' / 'postProcessOutput' = the texture that frame copied to the canvas (fallback). */
export interface RealFrameReadback {
  rgba: Uint8ClampedArray; width: number; height: number; format: GPUTextureFormat;
  source: 'swapchain' | 'lastFrameTex' | 'postProcessOutput';
}
/** One raster layer of the composition list (RasterLayerManager → renderer). `animated`: the layer has cels (its
 *  per-layer dither cache keeps one entry per cel texture — layer-dither-cache.ts, perf E5). */
export interface RasterCompositionEntry {
  id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean;
  ditherConfig?: import('../raster/effects/dither-engine').DitherConfig; frameLinkAnimation?: FrameLinkAnimation;
  animated?: boolean;
}

/** WebGPURenderer.getRenderDebugStatus: read-only facts a render-debug bisect needs (is the lo-res path on, ...). */
export interface RenderDebugStatus {
  /** The scale the 3D scene renders at now (getResolutionScale().current; 1 = native) and the scaler mode. */
  resolutionScale: number; resolutionMode: string;
  /** The lo-res target the 3D scene renders into this frame, or null on the native path. dynamic = resolution scaling /
   *  TAA (upscaled + depth upsampled), not the PS1 look. */
  loResPath: { width: number; height: number; dynamic: boolean } | null;
  temporalAA: boolean;
  /** MSAA is not used: every pass and pipeline is single-sampled. */
  msaaSampleCount: 1;
  canvas: { width: number; height: number };
  swapChainFormat: GPUTextureFormat; canvasAlphaMode: GPUCanvasAlphaMode; canvasCopySrc: boolean;
}
interface RealShotPending {
  buf: GPUBuffer; w: number; h: number; padded: number; format: GPUTextureFormat; source: RealFrameReadback['source'];
  waiters: { resolve: (r: RealFrameReadback) => void; reject: (e: unknown) => void }[];
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function isOffscreen(c: any): c is OffscreenCanvas {
  return typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas;
}

function get2dCtx(c: HTMLCanvasElement | OffscreenCanvas): Ctx2D {
  if (isOffscreen(c)) {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Offscreen 2D context unavailable');
    return ctx;
  } else {
    const ctx = (c as HTMLCanvasElement).getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    return ctx;
  }
}

const RENDER = {
  throttleMs: 2,
  indirectCommandStrideBytes: 5 * 4, // 5 uint32s = 20 bytes
} as const;

type DragData = {
  primary: Node;
  rect: DOMRect;
  dragOffset: Vec2;         // world delta from primary center to cursor
  nodes: (Shape|Group)[];   // top-level selection snapshot
  x0: Float32Array;         // initial x per node
  y0: Float32Array;         // initial y per node
  primaryX0: number;               
  primaryY0: number;              
  initialGroupChildPositions: Map<Group, Vec2>;
  invParentAtDrag: mat4[];
};

type RotatingData = {
  initialMouseAngle: number;
  initialRotation: number;
};

type ScalingData = {
  side: ScalingSide;
  anchorWorld: Vec2;        // fixed point during scaling
  initial: ShapeDimensions & { baseW: number; baseH: number; scaleX: number; scaleY: number }; // { x, y, width, height }
  prevCenter: Vec2;         // track center drift during scaling
};

type EndpointDragData = {
  line: Line;
  which: 'start' | 'end';
};

type PlacementDragData = {
  layerId: string;
  placementId: string;
  startWorldX: number;
  startWorldY: number;
  placementX0: number;
  placementY0: number;
};

export type PlacementResizeHandle = 'TL' | 'TC' | 'TR' | 'ML' | 'MR' | 'BL' | 'BC' | 'BR';
export type PlacementHandleHit =
  | { kind: 'resize'; layerId: string; placementId: string; handle: PlacementResizeHandle; anchorX: number; anchorY: number }
  | { kind: 'rotate'; layerId: string; placementId: string; centerX: number; centerY: number; startAngle: number; startRotation: number };

type PlacementResizeDragData = {
  layerId: string; placementId: string;
  handle: PlacementResizeHandle;
  anchorX: number; anchorY: number;
};
type PlacementRotateDragData = {
  layerId: string; placementId: string;
  centerX: number; centerY: number;
  startAngle: number; startRotation: number;
};

type Mode =
  | { kind: 'idle' }
  | { kind: 'panning'; lastClient: Vec2; rect: DOMRect }
  | { kind: 'dragging'; data: DragData }
  | { kind: 'boxSelecting'; startCanvas: Vec2; rect: DOMRect; draw?: boolean }
  | { kind: 'rotating'; data: RotatingData }
  | { kind: 'scaling'; data: ScalingData }
  | { kind: 'endpointDragging'; data: EndpointDragData }
  | { kind: 'draggingPlacement'; data: PlacementDragData }
  | { kind: 'resizingPlacement'; data: PlacementResizeDragData }
  | { kind: 'rotatingPlacement'; data: PlacementRotateDragData };

// src/renderer/webgpu-renderer.ts
export class WebGPURenderer {

  // Simple state machine for renderer modes
  public mode: Mode = { kind: 'idle' };

  public reactiveCursors: boolean = false;
  private cursorAssets = [
      pointerExcitedCursorUrl,
      pointerHappyCursorUrl,
      pointerOCursorUrl,
      pointerSadCursorUrl,
      pointerWinkCursorUrl,
      pointerTongueCursorUrl,
      pointerSleepCursorUrl,
      pointerLoveCursorUrl,
      pointerRageCursorUrl
      // pointerCursorUrl,
  ];

  getRandomCursor(): string {
    if(this.reactiveCursors) {
      const randomIndex = Math.floor(Math.random() * this.cursorAssets.length);
      const randomCursorUrl = this.cursorAssets[randomIndex];
      return `url('${randomCursorUrl}'), auto`;
    }
      return `url('${pointerCursorUrl}'), auto`;
  }

  applyRandomCursor(): void {
      this.canvas.style.cursor = this.getRandomCursor();
  }

  // Core Setup
  public canvas!: HTMLCanvasElement;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  /** The canvas (swap-chain) format: 'bgra8unorm' until initWebGPU picks the device's preferred one (canvas-format.ts,
   *  CRASH-6). Chosen ONCE per renderer, before any pipeline exists; every canvas / lastFrameTex target reads it. */
  private swapChainFormat: GPUTextureFormat = FALLBACK_CANVAS_FORMAT;
  /** True once initWebGPU chose the format (a re-init keeps it: the pipelines were built for it). */
  private _canvasFormatChosen = false;

  // Resolves once initWebGPU() has acquired the device + configured the
  // context. Lets the host (e.g. the Shell UI) await WebGPU readiness without
  // racing against the async adapter/device request.
  private _readyResolve?: () => void;
  private readonly _readyPromise: Promise<void> = new Promise<void>(res => { this._readyResolve = res; });

  private renderList: Node[] = [];
  public renderListDirty = true;

  // Flat list of every Shape in the scene graph, rebuilt only when the tree STRUCTURE changes
  // (shapes added/removed). During drag/pan/scale the list of shapes is identical — only the
  // viewport filter and sort need to re-run, not the full O(N nodes) tree walk.
  private _flatShapes: Shape[] = [];
  private _flatShapesDirty = true;

  // ── Step 2 (engine-roadmap; performance-plan §P13 "Step 2"): per-kind render lists ──
  // With `split` on, _flatShapes / renderList hold only the nodes the 2D strategy can act on, and the 3D kinds live in
  // their own lists (built by the same structure walk, same zIndex order), so the per-frame 2D steps (beginFrame, the
  // caret / text-selection collectors, the below / above-raster split) and the 3D draw filters never loop over the
  // whole city. `incremental` = the structure walk merges new nodes into the previous order instead of re-sorting.
  // Both off = the old single list (A/B reference): setFrameScanOptions({ splitRenderList, incrementalRenderList }).
  private _rlSplit = true;
  /** The 3D getTypes the 2D strategy's beginFrame skips (keep in sync with WebGPURenderStrategy.beginFrame). */
  private static readonly _TYPES_3D = new Set(['3DMesh', '3DMeshGroup', '3DArrayGroup', '3DClothMesh', 'GpObject3D', 'ParticleEmitter3D']);
  private readonly _rlIndex = new RenderListIndex<Node & RenderListNode>((n) => this._rlClassify(n));
  /** Every 3D-list node (zIndex order, all visibility) — the 3D counterpart of _flatShapes. */
  private _flat3D: Shape[] = [];
  /** The 3D lists as of the last render-list rebuild (visible at that rebuild, like the old render list). */
  private readonly _rl3DMeshes: Mesh3D[] = [];
  private _rl3DSkinned = new Uint8Array(64);      // parallel to _rl3DMeshes: 1 = SkinnedMesh3D
  private readonly _rl3DEmitters: ParticleEmitter3D[] = [];
  private readonly _rl3DGp: GpObject3D[] = [];
  private _frameMeshEditHides = false;            // this frame's meshEditHidesContent (the 3D filters read it)
  private _rlSkeletonMap: Map<string, Skeleton3D> | null = null;
  private _rlSkeletonMapVer = -1;
  private _rlClassify(n: Node): number {
    if (n instanceof Skeleton3D) return RL_SKELETON;
    if (!(n instanceof Shape)) return 0;
    if (!this._rlSplit) return RL_2D;
    if (n instanceof Mesh3D || n instanceof ParticleEmitter3D || n instanceof GpObject3D) {
      // A 3D node whose type the strategy doesn't treat as 3D would draw a 2D selection box when selected: keep it in both.
      return WebGPURenderer._TYPES_3D.has(n.getType()) ? RL_3D : (RL_3D | RL_2D);
    }
    // Mesh / array groups: no consumer reads them from the render list (the 3D passes take their meshes, the strategy
    // skips the 3D types), so they are in no list — this also drops their 2D viewport-cull box from every rebuild.
    if (n instanceof MeshGroup3D && WebGPURenderer._TYPES_3D.has(n.getType())) return 0;
    return RL_2D;
  }
  /** Step 2 A/B switches (all on by default). Changing one re-walks the scene on the next frame. */
  public setFrameScanOptions(o: { splitRenderList?: boolean; incrementalRenderList?: boolean }): { splitRenderList: boolean; incrementalRenderList: boolean } {
    if (o.splitRenderList !== undefined && !!o.splitRenderList !== this._rlSplit) {
      this._rlSplit = !!o.splitRenderList;
      this._rlIndex.reset();
      this._flat3D = []; this._rl3DMeshes.length = 0; this._rl3DEmitters.length = 0; this._rl3DGp.length = 0;
    }
    if (o.incrementalRenderList !== undefined) this._rlIndex.incremental = !!o.incrementalRenderList;
    this._flatShapesDirty = true; this.renderListDirty = true; this.scheduleRender();
    return this.getFrameScanOptions();
  }
  public getFrameScanOptions(): { splitRenderList: boolean; incrementalRenderList: boolean } {
    return { splitRenderList: this._rlSplit, incrementalRenderList: this._rlIndex.incremental };
  }
  /** Diagnostics: list sizes + the structure-walk counters. */
  public getRenderListStats(): { list2D: number; flat2D: number; flat3D: number; meshes3D: number; emitters3D: number; gp3D: number; walks: number; merged: number; fullSorts: number; lastAdded: number; lastRemoved: number; lastNodes: number } {
    return { list2D: this.renderList.length, flat2D: this._flatShapes.length, flat3D: this._flat3D.length, meshes3D: this._rl3DMeshes.length,
      emitters3D: this._rl3DEmitters.length, gp3D: this._rl3DGp.length, ...this._rlIndex.stats };
  }

  /** Pre-render callbacks (called at the start of each render frame). */
  private preRenderCallbacks: Array<() => boolean> = [];

  /** Get the canvas element. */
  public getCanvas(): HTMLCanvasElement { return this.canvas; }

  /**
   * Register a callback to run before each render frame.
   * Return `true` to request another frame (e.g. for damping).
   */
  public addPreRenderCallback(cb: () => boolean, label?: string): void {
    if (!this.preRenderCallbacks.includes(cb)) this.preRenderCallbacks.push(cb);
    if (label) this._cbLabels.set(cb, label);
  }

  // ── Per-frame CPU profile (opt-in; salsaWorld.callbackStats()) ──
  // Why: "armature Play drops 60 → 40 fps" — the pre-render callbacks (springs / IK / idle / gizmos / orbit) are
  // plain JS run every frame, invisible to frameStats() (which times the 3D draw). With profiling on, each callback's
  // time is averaged (EMA) by label, plus the whole render() CPU time and the real frame interval.
  private _cbLabels = new WeakMap<() => boolean, string>();
  private _cbProfile: Map<string, { ms: number; calls: number }> | null = null;
  private _frameProfile = { renderMs: 0, intervalMs: 0, last: 0 };
  /** Turn per-frame callback profiling on/off (off = zero overhead). */
  public setCallbackProfiling(on: boolean): void { this._cbProfile = on ? new Map() : null; this._frameProfile = { renderMs: 0, intervalMs: 0, last: 0 }; }
  /** The profile: per labelled callback avg ms (EMA), render() CPU ms, frame interval ms (1000/fps). */
  public getCallbackProfile(): { callbacks: Record<string, number>; renderMs: number; frameIntervalMs: number; fps: number } | null {
    if (!this._cbProfile) return null;
    const callbacks: Record<string, number> = {};
    for (const [k, v] of [...this._cbProfile].sort((a, b) => b[1].ms - a[1].ms)) callbacks[k] = Math.round(v.ms * 100) / 100;
    const iv = this._frameProfile.intervalMs;
    return { callbacks, renderMs: Math.round(this._frameProfile.renderMs * 100) / 100, frameIntervalMs: Math.round(iv * 10) / 10, fps: iv > 0 ? Math.round(1000 / iv) : 0 };
  }

  /** Remove a pre-render callback. */
  public removePreRenderCallback(cb: () => boolean): void {
    const idx = this.preRenderCallbacks.indexOf(cb);
    if (idx >= 0) this.preRenderCallbacks.splice(idx, 1);
  }

  /** Callbacks run once per frame right AFTER the raster layers were composited (both the main and the foreground
   *  composite are submitted by then), whether or not this frame composited anything. The raster brush's stroke
   *  prediction (BRUSH-4) draws its provisional tail into the layer in a pre-render callback and takes it back
   *  here, so the tail is on screen for exactly this frame and never in a layer between frames. */
  private postRasterCompositeCallbacks: Array<() => void> = [];
  public addPostRasterCompositeCallback(cb: () => void): void {
    if (!this.postRasterCompositeCallbacks.includes(cb)) this.postRasterCompositeCallbacks.push(cb);
  }
  public removePostRasterCompositeCallback(cb: () => void): void {
    const idx = this.postRasterCompositeCallbacks.indexOf(cb);
    if (idx >= 0) this.postRasterCompositeCallbacks.splice(idx, 1);
  }

  /** How many pre-render callbacks are registered (diagnostic: watch for leaks — a number that climbs
   *  as you enter/leave modes or regen means a callback isn't being removed). */
  public getPreRenderCallbackCount(): number { return this.preRenderCallbacks.length; }

  // User-Application State
  private pipelineManager: PipelineManager | null = null;
  private cacheService: CacheService | null = null;
  public lineDrawingService: LineDrawingService | null = null;
  public patternDrawingService: PatternDrawingService | null = null;
  public scribbleDrawingService: ScribbleDrawingService | null = null;
  public sectionDrawingService: SectionDrawingService | null = null;
  public highlightDrawingService: HighlightDrawingService | null = null;
  public textDrawingService: TextDrawingService | null = null;
  public sdfTextDrawingService: SdfTextDrawingService | null = null;
  public rasterDrawingService: import('../../services/raster-drawing-service').RasterDrawingService | null = null;
  public rasterSelectionService: import('../../services/raster-selection-service').RasterSelectionService | null = null;
  public rasterMoveService: import('../../services/raster-move-service').RasterMoveService | null = null;
  public stampDrawingService: StampDrawingService | null = null;
  public polygonDrawingService: PolygonDrawingService | null = null;
  public eraserService: EraserService | null = null;
  public interactionService: InteractionService;
  public selectionService!: SelectionService;  

  // Shape & World 
  public sceneGraph!: SceneGraph;

  // Multisample Anti-Aliasing
  // private msaaTexture!: GPUTexture;
  // private msaaTextureView!: GPUTextureView;
  
  public webGPURenderStrategy!: WebGPURenderStrategy;
  private rasterTextureManager?: RasterTextureManager;
  private _rasterPaintEngine?: RasterPaintEngine;
  private _rasterCompositor?: RasterCompositor;
  private _rasterSelectionEngine?: RasterSelectionEngine;
  private _selectionOverlayRenderer?: SelectionOverlayRenderer;
  private _renderer3D?: Renderer3D;
  private _gpRenderer3D?: GpRenderer3D;
  // Per-frame 3D draw-list scratch — draw3DMeshes/Particles/Gp used to .filter() the ~700-node city list
  // into fresh arrays EVERY frame (steady GC churn scaling with mesh count). These persistent arrays are
  // length-reset + refilled each frame instead. Safe: every consumer reads them synchronously within the
  // same frame (setSelectableMeshes stores _allMeshesScratch but drawSelectionGizmoIfActive reads it same
  // frame and .filter-copies it; the draw fns never stash their param).
  private readonly _allMeshesScratch: Mesh3D[] = [];
  private readonly _regularMeshesScratch: Mesh3D[] = [];
  private readonly _skinnedMeshesScratch: SkinnedMesh3D[] = [];
  private readonly _emittersScratch: ParticleEmitter3D[] = [];
  private readonly _gpObjsScratch: GpObject3D[] = [];
  // P9: the frame's render-list copies (below-raster / visible / above-raster) — a tiled city's ~13 k-node list was
  // filtered / sliced into three fresh arrays EVERY frame (~0.35 MB/frame). Same synchronous-consumer rule as above.
  private readonly _belowRasterScratch: Node[] = [];
  private readonly _visibleNodesScratch: Node[] = [];
  private readonly _aboveRasterScratch: Node[] = [];
  private _gpDrawOverlay: {
    hoveredTri: [number,number,number, number,number,number, number,number,number] | null;
    planeQuad: {
      corners: [[number,number,number],[number,number,number],[number,number,number],[number,number,number]];
      fillColor:   [number,number,number,number];
      borderColor: [number,number,number,number];
    } | null;
  } | null = null;
  private _floatingQuadVB?: GPUBuffer;
  private _floatingQuadIB?: GPUBuffer;
  // List of raster layers to composite in order (back-to-front)
  private rasterCompositionList?: Array<RasterCompositionEntry>;
  // Optional foreground raster layer list (layers above the 3D divider)
  private rasterForegroundList?: Array<RasterCompositionEntry>;
  // Foreground composite output texture
  private rasterTextureFG?: GPUTexture;

  // Setter to update composition list from external managers
  public setRasterCompositionList(list: Array<RasterCompositionEntry>) {
    this.rasterCompositionList = list;
    // Clear the foreground list — if the caller is using the flat (non-split) path,
    // any stale rasterForegroundList from a previous 3D-divider split would otherwise
    // stay and composite on top of 3D meshes, hiding them.
    this.rasterForegroundList = undefined;
    this.retainLayerDitherCaches();
    this.scheduleRender();
  }

  /** Free the per-layer dither caches of layers that are no longer listed (deleted / replaced on a document load). */
  private retainLayerDitherCaches(): void {
    if (!this._rasterCompositor) return;
    const ids = this._retainIds;   // (E8: reused — this runs on every timeline frame change)
    ids.clear();
    const a = this.rasterCompositionList, b = this.rasterForegroundList;
    if (a) for (let i = 0; i < a.length; i++) ids.add(a[i].id);
    if (b) for (let i = 0; i < b.length; i++) ids.add(b[i].id);
    this._rasterCompositor.retainLayerDitherCaches(ids);
  }
  private readonly _retainIds = new Set<string>();

  // ── E8 (2026-10-09): the per-render compositor inputs and raster-quad bind groups are reused, not rebuilt ──
  private readonly _compPoolMain: CompositorLayerInfo[] = [];
  private readonly _compOutMain: CompositorLayerInfo[] = [];
  private readonly _compPoolFG: CompositorLayerInfo[] = [];
  private readonly _compOutFG: CompositorLayerInfo[] = [];
  private _rasterQuadBG: { bg: GPUBindGroup; tex: GPUTexture; buf: GPUBuffer; sampler: GPUSampler; pipeline: GPURenderPipeline } | null = null;
  private _rasterQuadBGFG: { bg: GPUBindGroup; tex: GPUTexture; buf: GPUBuffer; sampler: GPUSampler; pipeline: GPURenderPipeline } | null = null;

  /** The composition list as compositor layers (layers without a texture — a blank cel — left out), written into
   *  reused objects: `pool` keeps one object per slot, `out` is the returned list. */
  private _fillCompositorLayers(list: ReadonlyArray<RasterCompositionEntry>, pool: CompositorLayerInfo[], out: CompositorLayerInfo[]): CompositorLayerInfo[] {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (!l.texture) continue;
      let c = pool[n];
      if (!c) c = pool[n] = { texture: l.texture, blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true };
      c.texture = l.texture;
      c.blendMode = l.blendMode ?? LayerBlendMode.Normal;
      c.opacity = l.opacity ?? 1.0;
      c.clipped = l.clipped ?? false;
      c.visible = l.visible ?? true;
      c.ditherConfig = l.ditherConfig;
      c.cacheKey = l.id;   // the layer's own dither cache
      c.cacheCels = l.animated === true;   // E5: one dither cache entry per cel
      c.frameLinkAnimation = l.frameLinkAnimation;
      out[n++] = c;
    }
    out.length = n;
    return out;
  }

  /** The raster-quad bind group for `tex` (cached while the texture, world buffer, sampler and pipeline are the same). */
  private _rasterQuadBindGroup(fg: boolean, tex: GPUTexture, buf: GPUBuffer): GPUBindGroup {
    const pm = this.pipelineManager!;
    const pipeline = pm.getRasterPipeline();
    const sampler = pm.getTexturedSampler();
    const c = fg ? this._rasterQuadBGFG : this._rasterQuadBG;
    if (c && c.tex === tex && c.buf === buf && c.sampler === sampler && c.pipeline === pipeline) return c.bg;
    const bg = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: tex.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: buf } },
    ]});
    const e = { bg, tex, buf, sampler, pipeline };
    if (fg) this._rasterQuadBGFG = e; else this._rasterQuadBG = e;
    return bg;
  }

  /** BRUSH-5 incremental composite in force this frame (the switch, minus the render-debug kill switch). */
  private _dirtyCompositingOn(): boolean {
    return WebGPURenderer.rasterDirtyCompositing && !(RD.on && RD.f.noRasterDirtyCompositing);
  }

  /** Set the split composition lists (background + foreground) for 3D divider support. */
  public setRasterCompositionListSplit(
    background: Array<RasterCompositionEntry>,
    foreground: Array<RasterCompositionEntry>,
  ) {
    this.rasterCompositionList = background;
    this.rasterForegroundList = foreground.length > 0 ? foreground : undefined;
    this.retainLayerDitherCaches();
    this.scheduleRender();
  }

  /** Current animation frame (1-indexed). Updated by ShapeManager on frame changes. */
  public currentAnimationFrame: number = 1;

  public stagingBuffer!: StrokesStagingBuffer;
  private bindGroupManager!: BindGroupManager;

  private patternSampler!: GPUSampler;
  private caretManager!: CaretManager;
  private selectionHighlightManager!: SelectionHighlightManager;
  private overlayDotManager!: OverlayDotManager;
  private _rasterTextService: IRasterTextPreviewProvider | null = null;
  public _connectorService: ConnectorService | null = null;

  /** Last known cursor position in world space (updated on pointermove). */
  public _cursorWorldX = 0;
  public _cursorWorldY = 0;
  /** UI System (docs/specs/ui-system.md) pointer hook. Set by ShapeManager; null (and its methods no-op) unless
   *  interactive preview is enabled, so normal editing is completely unaffected. onDown returns true when the UI
   *  layer consumed the click (it hit an interactive shape / the layer is modal); onMove returns a cursor or null. */
  public _uiPointerHandler: { onDown(worldX: number, worldY: number, canvasX: number, canvasY: number): boolean; onMove(worldX: number, worldY: number, canvasX: number, canvasY: number): string | null } | null = null;
  /** Wire (or clear with null) the UI System pointer hook. worldX/Y = artboard space (2D shapes); canvasX/Y = CSS px (3D-mesh pick). */
  public setUIPointerHandler(h: { onDown(worldX: number, worldY: number, canvasX: number, canvasY: number): boolean; onMove(worldX: number, worldY: number, canvasX: number, canvasY: number): string | null } | null): void { this._uiPointerHandler = h; }
  /** UI System keyboard hook — returns true when the UI consumed the key (Tab focus / Enter-Space activate / bound key). */
  public _uiKeyHandler: ((key: string, shift: boolean) => boolean) | null = null;
  public setUIKeyHandler(h: ((key: string, shift: boolean) => boolean) | null): void { this._uiKeyHandler = h; }
  /** UI System modal-dim provider — returns the scrim colour+alpha to draw over the world this frame, or null. */
  private _uiScrimProvider: (() => import('../../ui/ui-types').UIOverlayState | null) | null = null;
  private _uiScrimColorBuf: GPUBuffer | null = null;
  private _uiScrimBindGroup: GPUBindGroup | null = null;
  private _uiScrimBoundBlurTex: GPUTexture | null = null;
  private _uiScrimSampler: GPUSampler | null = null;
  private _uiBlurDummyTex: GPUTexture | null = null;
  private _uiBlurTexA: GPUTexture | null = null;
  private _uiBlurTexB: GPUTexture | null = null;
  private _uiBlurW = 0;
  private _uiBlurH = 0;
  private _uiBlurParamBufs: GPUBuffer[] = [];
  /** This frame's cached scrim state (computed once at frame start; used by the blur prep + the scrim draw). */
  private _uiScrimFrame: import('../../ui/ui-types').UIOverlayState | null = null;
  public setUIScrimProvider(p: (() => import('../../ui/ui-types').UIOverlayState | null) | null): void { this._uiScrimProvider = p; }
  /** UI-kit overlay (docs/ui/persona-ui-kit.md): draws HUD / menu widgets + kit transitions onto the FINAL swapchain
   *  image after post-processing — full canvas resolution, untouched by TAAU / resolution scaling / bloom / grade.
   *  Returns true while it animates (the renderer schedules another frame). */
  private _uiKitDrawer: ((device: GPUDevice, encoder: GPUCommandEncoder, view: GPUTextureView, w: number, h: number, format: GPUTextureFormat, cssToDevice: number, generation: number) => boolean) | null = null;
  public setUIKitOverlayDrawer(fn: ((device: GPUDevice, encoder: GPUCommandEncoder, view: GPUTextureView, w: number, h: number, format: GPUTextureFormat, cssToDevice: number, generation: number) => boolean) | null): void { this._uiKitDrawer = fn; this.scheduleRender(); }

  // Groups with modified child objects that need a bbox recalc on mouseup
  public pendingGroupBounds = new Set<Group>();

  // background resources (persistent)
  private bgResBuf!: GPUBuffer;        // vec4{width,height,0,0} (16B)
  private bgInvWorldBuf!: GPUBuffer;   // mat4 (64B)
  private bgBgColorBuf!: GPUBuffer;    // vec4 (16B)
  private bgDotColorBuf!: GPUBuffer;   // vec4 (16B)
  private bgGridBuf!: GPUBuffer;       // 2× vec4 (32B): color(rgb,opacity) + config(visible,spacing,lineWidthPx,_)
  private bgBindGroup!: GPUBindGroup;
  private gridOverlayBindGroup!: GPUBindGroup;  // top-overlay grid pass (above raster/vector/3D)
  private bgQuadVB!: GPUBuffer;

  // Visible 2D canvas grid (artboard-space; drawn by the background shader, pans/zooms with the canvas).
  private _canvasGridVisible = false;
  private _canvasGridVisibleOverride = true;  // render-only context gate (e.g. hide in 3D mode); NOT persisted
  private _scene3dVisible = true;
  /** Master 3D-scene visibility (the Frogmarks "3D Scene" layer eye icon). false → skip the entire 3D
   *  pass; scene state is untouched, so toggling back on restores it exactly. Render-only — Frogmarks
   *  persists the layer toggle on its side and re-applies it on load. */
  public get scene3DVisible(): boolean { return this._scene3dVisible; }
  public setScene3DVisible(v: boolean): void { this._scene3dVisible = v; this.scheduleRender(); }
  private _canvasGridColor: [number, number, number] = [0.5, 0.5, 0.55];
  private _canvasGridOpacity = 0.35;
  private _canvasGridCells = 16;        // number of grid cells across the document (artboard space)
  private _canvasGridLineWidth = 1.2;   // line half-width in device pixels
  public bgDirty = { res: true, matrix: true, colors: true };
  private _tmpInv = mat4.create();

  // Bound event handlers stored as stable references for proper add/remove
  private _boundPointerDown = this.handlePointerDown.bind(this);
  private _boundPointerMove = this.handlePointerMove.bind(this);
  private _boundPointerUp = this.handlePointerUp.bind(this);
  private _boundWheel = this.handleWheel.bind(this);
  private _boundPointerCancel = (e: PointerEvent) => this._interaction.handlePointerCancel(e);
  /** C1: pointer/wheel/key input lives in RasterInteractionController; the members it reaches back into
   *  are `public` below (relocation, not decoupling — same stance as DocumentStateCoordinator). */
  private _interaction = new RasterInteractionController(this);
  
  // rAF scheduler (inside WebGPURenderer)
  private rafId: number | null = null;
  private needsFrame = false;       // set when something changed
  // Perf stats (for the optional stats HUD): last frame's CPU encode time + recent render timestamps for FPS.
  private _lastFrameMs = 0;
  private _frameStamps: number[] = [];
  private _gpuName: string | null = null;
  private _framesRendered = 0;
  /** Frames rendered this session (the device-lost read-back shadow only refreshes after something drew). */
  public get framesRendered(): number { return this._framesRendered; }
  /** Record a frame's CPU duration + timestamp (called around each render). */
  private _noteFrame(ms: number): void {
    this._lastFrameMs = ms;
    const now = performance.now();
    this._frameStamps.push(now);
    this._framesRendered++;
    // keep the last ~1s window
    while (this._frameStamps.length && now - this._frameStamps[0] > 1000) this._frameStamps.shift();
  }
  /** Perf timing for the stats HUD. `frameMs` = the last frame's CPU encode time; `fps` = render rate over the
   *  last second (0 when idle — this renderer draws on demand, so it only ticks while something changes). */
  public getRenderTiming(): { frameMs: number; fps: number; gpuName: string | null } {
    const now = performance.now();
    const recent = this._frameStamps.filter(t => now - t <= 1000).length;
    return { frameMs: this._lastFrameMs, fps: recent, gpuName: this._gpuName };
  }

  // ── RESOLUTION SCALING (docs/ui/performance.md §Resolution scaling) ──
  // The ResolutionScaler decides the 3D scene's render scale (off / fixed / auto); the GpuFrameTimer measures the GPU
  // frame time it steers by. The setting is a per-machine VIEWPORT preference (localStorage), never document data:
  // the right scale depends on this GPU and this monitor, not on the scene.
  private readonly _resScaler = new ResolutionScaler();
  private _gpuTimer: GpuFrameTimer | null = null;
  private _gpuMs: number | null = null;       // smoothed GPU frame time while timing runs
  private _gpuTimingLease = 0;                // performance.now() until which a stats readout keeps timing on
  /** Frames forced to full resolution (snapshots / thumbnails / video export wait on a settled frame). Also forces
   *  the frame into lastFrameTex (perf audit C1: no direct-to-canvas frame while a read-back waits on it). */
  private _fullResHold = 0;
  private _frameScaled = false;      // this frame renders below native (set per frame before the 3D pass)
  private _submittedScaled = false;  // ... as of the last submitted frame (waitForFrameSettled skips such frames)
  /** Perf audit C1: the last submitted frame went straight into the canvas texture (lastFrameTex not written —
   *  waitForFrameSettled skips such frames, like scaled ones). */
  private _submittedDirect = false;
  /** A direct frame mispredicted the post chain (FXAA / effects would have run): the next frame renders offscreen. */
  private _forceOffscreenNext = false;
  /**
   * Perf audit C1 + C2: frames that need nothing from lastFrameTex render straight into the canvas texture, and the
   * last post / FXAA pass writes straight into it (no full-screen copy either way). false = the original path: every
   * frame into lastFrameTex, then (post-processed and) copied to the canvas. Session-wide kill switch.
   */
  public static directPresent = true;
  static readonly RES_SCALE_PREF_KEY = 'salsa.viewport.resolutionScale';
  private _resPrefLoaded = false;
  private _loadResolutionPref(): void {
    if (this._resPrefLoaded) return;
    this._resPrefLoaded = true;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WebGPURenderer.RES_SCALE_PREF_KEY) : null;
      if (raw) this._resScaler.set(sanitizeResolutionScale(JSON.parse(raw)));
    } catch { /* storage blocked / bad JSON: keep the defaults */ }
  }
  /** Set the resolution scaling (merged onto the current setting). `persist` false = this session only. */
  public setResolutionScale(patch: Partial<ResolutionScaleSettings>, persist = true): ResolutionScaleState {
    this._loadResolutionPref();
    const s = this._resScaler.set(patch ?? {});
    if (persist) { try { localStorage.setItem(WebGPURenderer.RES_SCALE_PREF_KEY, JSON.stringify(s)); } catch { /* storage blocked */ } }
    this.scheduleRender();
    return this.getResolutionScale();
  }
  /** The setting plus what it is doing now: `current` = the scale the 3D scene renders at, `gpuMs` = smoothed GPU ms. */
  public getResolutionScale(): ResolutionScaleState {
    this._loadResolutionPref();
    const r3 = this._renderer3D;
    return { ...this._resScaler.settings, current: r3 ? r3.dynamicResolutionScale : this._resScaler.scale(), gpuMs: this._gpuMs,
      timing: this._gpuTimer?.supported ? 'timestamp' : 'estimate' };
  }
  /** Keep GPU timing on for `ms` (a perf readout polls this; timing otherwise runs only in auto mode). */
  public leaseGpuTiming(ms = 3000): void {
    const until = performance.now() + Math.max(0, ms);
    if (until > this._gpuTimingLease) this._gpuTimingLease = until;
  }
  /** Smoothed GPU frame time (ms) while timing runs, else null. */
  public getGpuFrameMs(): number | null { return this._gpuMs; }
  private _onGpuSample = (ms: number, source: 'timestamp' | 'estimate'): void => {
    this._gpuMs = this._gpuMs == null ? ms : this._gpuMs + (ms - this._gpuMs) * 0.1;
    if (source === 'timestamp') this._renderer3D?.noteCullGpuMs(ms);   // GPU culling auto mode (performance-plan §P15)
    if (this._resScaler.sample(ms, performance.now())) this.scheduleRender();
  };
  /** Per frame, before the 3D pass: decide the scale and whether the timer runs. */
  // ── TEMPORAL AA / UPSCALING (engine-roadmap step 6; temporal-aa.ts, docs/ui/performance.md) ──
  // Like resolution scaling, a per-machine VIEWPORT preference (localStorage), never document data.
  static readonly TAA_PREF_KEY = 'salsa.viewport.temporalAA';
  private _taaSettings: TemporalAASettings = { ...DEFAULT_TEMPORAL_AA };
  private _taaPrefLoaded = false;
  private _taaSettleLeft = 0;          // settle frames still to render after the last requested frame
  private _taaExternal = true;         // the next frame was requested by something other than the settle loop
  /** Frames rendered after the view stops so the jittered history converges (edges, dither fades). */
  static TAA_SETTLE_FRAMES = 32;
  private _loadTemporalPref(): void {
    if (this._taaPrefLoaded) return;
    this._taaPrefLoaded = true;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WebGPURenderer.TAA_PREF_KEY) : null;
      if (raw) this._taaSettings = sanitizeTemporalAA(JSON.parse(raw));
    } catch { /* storage blocked / bad JSON: keep the defaults */ }
  }
  /** Set temporal AA / upscaling (merged onto the current setting). `persist` false = this session only. */
  public setTemporalAA(patch: Partial<TemporalAASettings>, persist = true): TemporalAAState {
    this._loadTemporalPref();
    const prevMode = this._taaSettings.mode;
    this._taaSettings = sanitizeTemporalAA(patch ?? {}, this._taaSettings);
    if (persist) { try { localStorage.setItem(WebGPURenderer.TAA_PREF_KEY, JSON.stringify(this._taaSettings)); } catch { /* storage blocked */ } }
    if (prevMode !== this._taaSettings.mode) this._renderer3D?.resetTemporalHistory();
    this.scheduleRender();
    return this.getTemporalAA();
  }
  /** The setting plus what it did on the last 3D frame (active, why not, the internal scale). */
  public getTemporalAA(): TemporalAAState {
    this._loadTemporalPref();
    const st = this._renderer3D?.getTemporalStatus() ?? { active: false, reason: this._taaSettings.mode === 'off' ? 'off' as const : 'ok' as const, renderScale: 1, samples: 16, velocityDraws: 0 };
    return { ...this._taaSettings, ...st };
  }
  /** After a TAA frame: keep rendering a few frames once the view stops, so the history converges. */
  private _temporalSettle(): void {
    const ext = this._taaExternal;   // set by every scheduleRender since the last settle request
    this._taaExternal = false;
    if (!this._renderer3D?.temporalActive) { this._taaSettleLeft = 0; return; }
    this._taaSettleLeft = ext ? WebGPURenderer.TAA_SETTLE_FRAMES : this._taaSettleLeft - 1;
    if (this._taaSettleLeft > 0) { this.scheduleRender(); this._taaExternal = false; }
  }

  private _applyResolutionScale(r3d: { setUserResolutionScale(s: number): void } | null): void {
    this._loadResolutionPref();
    const auto = this._resScaler.settings.mode === 'auto';
    if (!this._gpuTimer && this.device) { this._gpuTimer = new GpuFrameTimer(this.device); this._gpuTimer.onResult = this._onGpuSample; }
    // (the GPU culling auto mode needs GPU timestamps too while the GPU scene runs a city: Renderer3D.wantsGpuTiming)
    const timing = auto || performance.now() < this._gpuTimingLease || !!this._renderer3D?.wantsGpuTiming();
    this._gpuTimer?.setEnabled(timing && !this._captureMode);
    this._renderer3D?.setGpuTimerSource(!this._gpuTimer || !this._gpuTimer.enabled ? 'none' : this._gpuTimer.supported ? 'timestamp' : 'estimate');
    if (!timing) this._gpuMs = null;
    const full = this._fullResHold > 0 || !!this._captureMode || (RD.on && RD.f.forceFullRes);   // exports / snapshots always render at native size (and render debug forceFullRes)
    r3d?.setUserResolutionScale(full ? 1 : this._resScaler.scale());
    // Temporal AA: exports / snapshots render natively (no jitter, no history) with FXAA standing in.
    this._loadTemporalPref();
    this._renderer3D?.setTemporalFrame(this._taaSettings, full, this._resScaler.settings.mode !== 'off');
    this._frameScaled = !full && (this._resScaler.scale() < 1 || !!this._renderer3D?.temporalActive);
  }
  private live = false;             // on/off switch for the loop
  private _suspended = false;       // hard stop: a foreign owner (the Shell UI)
                                    // holds the canvas; block ALL rendering,
                                    // including the on-demand scheduleRender path
  private minFrameGapMs = 0;        // set to 2 if you want light throttling
  private lastRAFTime = 0;
  private interactiveCount = 0;     // >0 while drawing/dragging, etc.

  private onRAF = (t: number) => {
    this.rafId = null;
    if (!this.live) return;

    // optional micro-throttle
    if (this.minFrameGapMs && (t - this.lastRAFTime) < this.minFrameGapMs) {
      this.requestTick();
      return;
    }
    this.lastRAFTime = t;

    // An interactive lease (beginInteractive — e.g. the ANIMATED hover outline) means "draw every vsync":
    // the on-demand path's re-arm (scheduleRender's rAF body) is unreachable while this live loop holds rafId,
    // so without this line a lease renders exactly ONE frame and time-driven effects freeze between mouse events.
    if (this.interactiveCount > 0) this.needsFrame = true;

    if (this.needsFrame && !this._suspended) {
      this.needsFrame = false;
      const _t0 = performance.now(); this._renderLive(); this._noteFrame(performance.now() - _t0);
    }

    // stay alive: if something else marks needsFrame before next vsync,
    // we’ll draw it; otherwise we’ll spin very cheaply.
    this.requestTick();
  };

  // rAF scheduler
  public scheduleRender() {
    this._taaExternal = true;      // temporal AA settle: a real request restarts the settle count
    if (this._suspended) return;   // Shell UI owns the canvas — block all draws
    if (this._deviceLost) { this.needsFrame = true; return; }   // device lost: the recovery schedules the next frame
    // Mark that a frame is wanted. CRITICAL: when the rAF loop is live (play()),
    // requestTick() keeps `rafId` permanently pending, so the early-return below
    // would otherwise drop every on-demand render — and onRAF only draws when
    // `needsFrame` is set. Setting it here lets the live loop service this request.
    this.needsFrame = true;
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this._suspended) return;
      this.needsFrame = false;
      const _t0 = performance.now(); this._renderLive(); this._noteFrame(performance.now() - _t0);
      if (this.interactiveCount > 0) this.scheduleRender();
    });
  }
  /** A LIVE (on-screen) frame: pipelines still compiling are skipped rather than compiled synchronously
   *  (GPUPipelineCache live-frame scope — docs/specs/performance-plan.md P2). One-shot captures call render()
   *  directly, outside the scope, so they compile what they need and never read back a half-drawn image. */
  private _renderLive(): void {
    // A frame requested before the GPU device / canvas context exist (an early scheduleRender during async init —
    // e.g. a pipeline-ready or deferred-work callback) must be a no-op, not a crash (ensureLastFrameTex → device
    // undefined). The init path schedules the first real frame once the device is ready.
    if (!this.device || !this.context || this._deviceLost) { this.needsFrame = true; return; }
    const cache = GPUPipelineCache.peek(this.device);
    if (!cache) { void this.render(); return; }
    cache.beginFrame();
    let p: Promise<void>;
    try { p = this.render(); } catch (e) { cache.endFrame(); throw e; }
    p.then(() => cache.endFrame(), () => cache.endFrame());
  }
  public beginInteractive() { this.interactiveCount++; this.scheduleRender(); }
  public endInteractive()   { this.interactiveCount = Math.max(0, this.interactiveCount-1); this.scheduleRender(); }

  public play() {
    if (this.live) return;
    this.live = true;
    this.requestTick();
  }
  public pause() {
    this.live = false;
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  /** Hard-stop ALL rendering (loop + on-demand scheduleRender) because a
   *  foreign owner — the Shell UI — has taken over the shared canvas. Unlike
   *  pause(), this also blocks the on-demand path, so editor pointer/resize
   *  events can't repaint over the shell. */
  public suspendRendering() {
    this._suspended = true;
    this.live = false;
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  /** Release the hard-stop and repaint once. Pair with suspendRendering().
   *  Also re-asserts our canvas-context configuration: the Shell UI borrows the
   *  same context and may reconfigure it (e.g. dropping the COPY_DST usage the
   *  compositor needs), which would otherwise leave the editor canvas black. */
  public resumeRendering() {
    // Only act when we were actually suspended (the Shell UI had taken over).
    // For a normal editor load that never touched the shell, do nothing — the
    // editor owns its own render flow and we must not interfere.
    if (!this._suspended) return;
    this._suspended = false;
    // The shell reconfigured our shared context (it can drop the COPY_DST usage
    // the compositor needs); re-assert our configuration before resuming.
    try {
      this.context.configure({
        device: unwrapDevice(this.device),
        format: this.swapChainFormat,
        usage: this._contextUsage(),
        alphaMode: this._contextAlphaMode(),
      });
    } catch { /* context may not be ready yet */ }
    // setCanvasSize was a no-op while suspended (UI-16): catch up on any resize / DPR / caps change made meanwhile
    // (the cached CSS + backing size makes this free when nothing changed).
    if (this.device && this.canvas) this.setCanvasSize(this.getDevice());
    this.scheduleRender();
  }

  /** True while rendering is hard-suspended (Shell UI owns the canvas). */
  public get isSuspended(): boolean { return this._suspended; }

  private requestTick() {
    if (this.rafId == null && this.live) this.rafId = requestAnimationFrame(this.onRAF);
  }

  constructor(canvas: HTMLCanvasElement, interactionService: InteractionService) {
      // Core Setup
      this.initializeCanvas(canvas);
      this.interactionService = interactionService;

      this.renderListDirty = true;
      interactionService.onSceneGraphChanged.subscribe(()=> {
          this._flatShapesDirty = true;  // tree structure changed — re-walk on next rebuild
          this.renderListDirty = true;
          this.scheduleRender();
        }
      );
      interactionService.onRequestRender.subscribe(() => this.scheduleRender());
      interactionService.onBeginInteractive.subscribe(() => this.beginInteractive());
      interactionService.onEndInteractive.subscribe(() => this.endInteractive());
      interactionService.onRequestBackgroundRender.subscribe(() => { 
          if (!this.backgroundPatternFixed) {
              this.bgDirty.matrix = true; 
          }
          this.renderListDirty = true; 
      })

      window.addEventListener('keydown', this.handleKeyDown.bind(this));

      this.canvas.addEventListener('mouseleave', () => {
        if (this.mode.kind !== 'idle') {
          this.mode = { kind: 'idle' };
          this.interactionService.boxSelectPreview = null;
          // this.canvas.style.cursor = 'default';
        }
      });
      window.addEventListener('blur', () => {
        if (this.mode.kind !== 'idle') {
          this.mode = { kind: 'idle' };
          this.interactionService.boxSelectPreview = null;
          // if(!this.eraserService?.isErasing) {
          //   this.canvas.style.cursor = 'default';
          // }
        }
      });
  }

  public testRasterPipeline() {
    if (!this.rasterTexture || !this.device) return;
    
    // Create test pattern - diagonal red stripes
    const w = this.canvas.width;
    const h = this.canvas.height;
    const data = new Uint8Array(w * h * 4);
    
    // Checkerboard: opaque squares and transparent squares so background shows through
    const cellSize = 20;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);
        const isOpaque = ((cx + cy) & 1) === 0;
        if (isOpaque) {
          // opaque white
          data[i] = 15;
          data[i + 1] = 15;
          data[i + 2] = 15;
          data[i + 3] = 255;
        } else {
          // fully transparent
          data[i] = 38;
          data[i + 1] = 38;
          data[i + 2] = 38;
          data[i + 3] = 0;
        }
      }
    }
    
    this.device.queue.writeTexture(
      { texture: this.rasterTexture },
      data,
      { bytesPerRow: w * 4 },
      { width: w, height: h }
    );
    
    this.setRenderMode('raster');
    this.scheduleRender();
  }

  // Flag to ensure we only seed the raster test once per texture life
  private rasterTestSeeded: boolean = false;

  // world matrix uniform for raster pipeline
  private rasterWorldBuf?: GPUBuffer;
  private rasterWorldQuadVB?: GPUBuffer;
  private rasterWorldQuadIB?: GPUBuffer;

  // Create or update the raster texture from a RasterCanvas
  public uploadRasterCanvas(raster: import('../raster/raster-canvas').RasterCanvas) {
    if (!this.device) return;
    if (!this.rasterTextureManager) this.rasterTextureManager = new RasterTextureManager(this.device);
    const tex = this.rasterTextureManager.uploadRasterCanvas(raster);
    this.setRasterTexture(tex);
  }

  // --- convenience wrappers for external UI clients ---
  public enableRasterMode() { this.setRenderMode('raster'); }
  public disableRasterMode() { this.setRenderMode('vector'); }

  public getRasterTextureSize(): { w:number, h:number } | null {
    if (!this.rasterTextureManager) {
      return this.getIllustrationPixelSize();
    }
    return this.rasterTextureManager.getTextureSize();
  }

  public initializeRasterTexture() {
    if (!this.device) return;
    if (!this.rasterTextureManager) {
      this.rasterTextureManager = new RasterTextureManager(this.device);
    }

    // Create the new paint engine alongside the legacy texture manager
    if (!this._rasterPaintEngine) {
      this._rasterPaintEngine = new RasterPaintEngine(this.device, () => this.scheduleRender());
    }

    // Create the compositor for multi-layer blending
    if (!this._rasterCompositor) {
      this._rasterCompositor = new RasterCompositor(this.device);
      // An error-diffusion layer dither landed / a deferred global one can run: composite again (weak: never keeps
      // the renderer alive).
      const selfR = new WeakRef(this);
      this._rasterCompositor.requestRender = () => selfR.deref()?.scheduleRender();
    }
    // BRUSH-5: a layer write reported AFTER the frame that would have shown it still gets a frame (only while the
    // incremental composite is on — off, nothing about scheduling changes). Weak: never keeps the renderer alive.
    if (!this._rasterDirtyUnsub) {
      const self = new WeakRef(this);
      const unsub = onRasterCompositeDirty(() => {
        const r = self.deref();
        if (!r) { unsub(); return; }
        if (r._dirtyCompositingOn()) r.scheduleRender();
      });
      this._rasterDirtyUnsub = unsub;
    }

    // Wire the global paper grain manager (NOT brush grain) to the compositor
    // so paper texture is applied as a post-process on the final composited output.
    if (this._rasterPaintEngine && this._rasterCompositor) {
      this._rasterCompositor.setGrainManager(this._rasterPaintEngine.paperGrainManager);
    }

    // Create the selection engine
    if (!this._rasterSelectionEngine) {
      this._rasterSelectionEngine = new RasterSelectionEngine(this.device, () => this.scheduleRender());
    }

    // Create the selection overlay renderer
    if (!this._selectionOverlayRenderer) {
      this._selectionOverlayRenderer = new SelectionOverlayRenderer(this.device);
    }

    if (!this.rasterTexture) {
      // Use illustration pixel size (matches artboard aspect ratio) instead of raw canvas size
      const { w: texW, h: texH } = this.getIllustrationPixelSize();
      this.rasterTexture = this.rasterTextureManager.ensureTexture(texW, texH);
      
        // Seed an initial blank snapshot asynchronously so the first stroke can be undone
        this.rasterTextureManager.initializeWithBlankSnapshot?.().catch((e:any) => {
          console.warn('initializeWithBlankSnapshot failed:', e);
        });

      // Point the paint engine at the active layer texture (if layer manager exists),
      // otherwise fall back to the rasterTexture (no multi-layer).
      const paintTarget = this.getActiveLayerTexture() ?? this.rasterTexture;
      this._rasterPaintEngine.setActiveTexture(paintTarget);
      this._rasterSelectionEngine?.setActiveTexture(paintTarget);
      this._rasterPaintEngine.initializeSnapshots().catch((e: any) => {
        console.warn('RasterPaintEngine snapshot init failed:', e);
      });
    }
  }

  /** Public accessor for the new raster paint engine (for RasterDrawingService). */
  public get rasterPaintEngine(): RasterPaintEngine | undefined {
    return this._rasterPaintEngine;
  }

  /** Public accessor for the raster selection engine. */
  public get rasterSelectionEngine(): RasterSelectionEngine | undefined {
    return this._rasterSelectionEngine;
  }

  /** Public accessor for the raster compositor (for dither/effects configuration). */
  public get rasterCompositor(): RasterCompositor | undefined {
    return this._rasterCompositor;
  }

  // Undo/Redo for raster
  public async rasterPushSnapshot(): Promise<void> {
    if (!this.rasterTextureManager) return;
    await this.rasterTextureManager.pushSnapshot();
  }

  // Dispatch GPU brush into raster texture (exposed to services). Mode: 'paint'|'erase'|'clear'
public dispatchGpuBrush(cx: number, cy: number, radius: number, color: [number,number,number,number], mode: 'paint'|'erase'|'clear' = 'paint', eraseHard?: boolean) {
    // Paint into the active layer's texture (not the compositor output)
    const targetTex = this.getActiveLayerTexture();
    if (!targetTex || !this.device || !this.rasterTextureManager) return;
    const view = targetTex.createView();
    
    // Get world quad dimensions (what the texture is being stretched to fill)
    let worldQuadW = 2.0;
    let worldQuadH = 2.0;
    if (this.illustrationMode && this.illustrationBounds) {
        worldQuadW = this.illustrationBounds.width;
        worldQuadH = this.illustrationBounds.height;
    }
    
    // Pass world dimensions - shader will compute aspect = world/texture
    // This makes aspectX = 2.0/1669 ≈ 0.0012, aspectY = 2.0/991 ≈ 0.0020
    // The ratio aspectY/aspectX ≈ 1.684 compensates for the texture stretch
    this.rasterTextureManager.dispatchBrushToTexture(
        targetTex, view, cx, cy, radius, color, mode, eraseHard, 
        worldQuadW,   // World quad width (2.0)
        worldQuadH    // World quad height (2.0)
    );
    this.scheduleRender();
}


  public async rasterUndo(): Promise<boolean> {
    if (!this.rasterTextureManager) return false;
    const ok = await this.rasterTextureManager.undo();
    if (ok) {
      // ensure the restored texture is rendered and presented before returning
      this.scheduleRender();
      await this.waitForFrameSettled();
    }
    return ok;
  }

  public async rasterRedo(): Promise<boolean> {
    if (!this.rasterTextureManager) return false;
    const ok = await this.rasterTextureManager.redo();
    if (ok) {
      // ensure the restored texture is rendered and presented before returning
      this.scheduleRender();
      await this.waitForFrameSettled();
    }
    return ok;
  }

  // Force any pending uploads to be flushed to GPU and schedule a render
  public flushRasterUploads() {
    // No-op here since uploads happen synchronously via uploadRasterCanvas or dispatch
    this.scheduleRender();
  }

  // (previous overload removed - dispatchGpuBrush consolidated above)

  private handleKeyDown(event: KeyboardEvent) { this._interaction.handleKeyDown(event); }

  /** Host hook for the Delete/Backspace shortcut (wired by ShapeManager → deleteSelectedShapes, which owns the
   *  GPU-cache dealloc + package routing this renderer can't reach). */
  public _deleteSelectedHandler: (() => void) | null = null;
  public setDeleteSelectedHandler(fn: (() => void) | null): void { this._deleteSelectedHandler = fn; }

  /** Host hook for the Ctrl+D shortcut (wired by ShapeManager → duplicateSelectedShapes — the
   *  serializer round-trip + undo recording live there, out of this renderer's reach). */
  public _duplicateSelectedHandler: (() => void) | null = null;
  public setDuplicateSelectedHandler(fn: (() => void) | null): void { this._duplicateSelectedHandler = fn; }

  /** Called at the end of reinitialize() (canvas swap) so ShapeManager-owned canvas listeners re-bind. */
  public onCanvasReinitialized: (() => void) | null = null;

  private initializeCanvas(newCanvas: HTMLCanvasElement) {
      // Canvas is used for textureView in renderPassDescriptor, 
      // Mouse Events, background pipeline, etc.
      this.canvas = newCanvas;
      // Pointer Event Listeners (use stable bound references for proper removal). Registered ZONELESS so
      // canvas input doesn't wake Angular's change detector on every event (see zoneless-listeners.ts).
      addZonelessListener(this.canvas, 'pointerdown', this._boundPointerDown);
      addZonelessListener(this.canvas, 'pointermove', this._boundPointerMove);
      addZonelessListener(this.canvas, 'pointerup', this._boundPointerUp);
      addZonelessListener(this.canvas, 'wheel', this._boundWheel, { passive: false });
      // TOUCH-5: a cancelled pointer ends (reverts) the gesture; the canvas consumes finger gestures itself (2D
      // pinch / pan, 3D orbit) so the browser must not pan / zoom the page under it.
      addZonelessListener(this.canvas, 'pointercancel', this._boundPointerCancel);
      if (this.canvas.style) this.canvas.style.touchAction = 'none';
  }

  // Method to get the GPUDevice
  public getDevice(): GPUDevice {
      return this.device;
  }

  /** The WebGPU canvas context. Borrowed (read-only) by the Shell UI so it
   *  can render to the same swapchain while the main render loop is paused. */
  public getCanvasContext(): GPUCanvasContext {
      return this.context;
  }

  /** The swapchain texture format, for building shell pipelines that target
   *  the same canvas. */
  public getSwapChainFormat(): GPUTextureFormat {
      return this.swapChainFormat;
  }

  /** True while the rAF render loop is running. Lets the Shell UI know
   *  whether it needs to resume the main renderer on teardown. */
  public get isLive(): boolean {
      return this.live;
  }

  /** Resolves once WebGPU is initialized (device acquired + context
   *  configured). Resolves immediately if init already completed. The host
   *  awaits this before mounting the Shell UI (which borrows the device). */
  public whenReady(): Promise<void> {
      return this.device ? Promise.resolve() : this._readyPromise;
  }

  // ── GPU DEVICE LOSS + RECOVERY (docs/ui/device-recovery.md) ─────────────────────────────────────────────────────────
  // On loss the render loop stops (no per-frame throws against a dead device) and, with autoRecoverDevice on, the
  // renderer asks for a new adapter + device, re-points the device HANDLE every owner holds, rebuilds its own GPU
  // resources (fresh Renderer3D / GpRenderer3D, raster engines, swept lazy buffers), runs the registered owner hooks (the
  // 2D stack, ShapeManager's managers) and, through the recovery handler ShapeManager installs, restores the document
  // content from its CPU snapshot. Status changes go to onDeviceStatusChange (sm.onDeviceStatusChange for the host).

  /**
   * BRUSH-5 (docs/specs/mobile-parity.md §3): composite the 2D raster layers INCREMENTALLY — keep the composited
   * result and re-composite only when a layer changed, and only its dirty rect (RasterCompositor.compositeIncremental
   * + raster-composite-dirty.ts) — instead of copying and blending every layer from scratch every frame.
   * ON by default since 2026-10-09 (perf E2: a timeline playing with 3D motion re-composited every layer every frame,
   * 14–27 ms GPU at 1080p). false = the full composite every frame, exactly as before. Kill switches:
   * sm.setRasterDirtyCompositing(false) (this session) and the render-debug flag noRasterDirtyCompositing
   * (sm.setRenderDebug3D({ noRasterDirtyCompositing: true }) — persists per machine). Session-wide.
   */
  public static rasterDirtyCompositing = true;
  private _rasterDirtyUnsub: (() => void) | null = null;

  /** Is the onion skin going to draw into the composited output this frame? (same gates as applyOnionSkinOverlay) */
  private _onionSkinActive(): boolean {
    const mgr = this.rasterLayerManager;
    if (!mgr) return false;
    const config = mgr.getOnionSkinConfig();
    if (!config.enabled || (config.framesBefore <= 0 && config.framesAfter <= 0)) return false;
    return mgr.isAnimationEnabled() && !mgr.getTimeline().isPlaying();
  }

  /** Show the built-in overlay when WebGPU is unavailable at start-up / a recovery fails. Set false before
   *  startWebGPURendering to render your own (getDeviceStatus / onDeviceStatusChange carry the same information). */
  public static showDeviceOverlays = true;
  /** Recover automatically when the device is lost (false = wait for recoverDevice()). */
  public autoRecoverDevice = true;
  private _deviceHandle: GpuDeviceHandle | null = null;
  private readonly _deviceStatus = new GpuDeviceStatusTracker();
  private _deviceLost = false;
  private _wasLiveBeforeLoss = false;
  private _intentionalDeviceDestroy = false;
  private _recoveryPromise: Promise<boolean> | null = null;
  private _recoveryHandler: ((install: () => Promise<void>) => Promise<string[] | void>) | null = null;
  private readonly _gpuOwners: Array<{ name: string; order: number; rebuild: (device: GPUDevice) => void | Promise<void> }> = [];

  /** The device status (ok / lost / recovering / failed / unavailable) plus loss + recovery counters. */
  public getDeviceStatus(): GpuDeviceStatusInfo { return this._deviceStatus.info; }
  /** Subscribe to device status changes; returns the unsubscribe function. */
  public onDeviceStatusChange(fn: GpuDeviceStatusListener): () => void { return this._deviceStatus.subscribe(fn); }
  /** True from the loss until the recovery finished (rendering is stopped meanwhile). */
  public get isDeviceLost(): boolean { return this._deviceLost; }
  /** How many times the device was replaced (0 = the first device). Owners can compare it to drop cached objects. */
  public get deviceGeneration(): number { return this._deviceHandle?.generation ?? 0; }

  /**
   * Register an owner of long-lived GPU objects to rebuild after a device loss. `rebuild` runs once the new device is
   * in place (the handle already points at it) and must replace every GPU object the owner kept. Lower `order` runs
   * first (the renderer's own resources run before all of them; the 2D stack = 10, ShapeManager managers = 50).
   * Returns an unregister function.
   */
  public registerGpuResourceOwner(name: string, rebuild: (device: GPUDevice) => void | Promise<void>, order = 100): () => void {
    const rec = { name, order, rebuild };
    this._gpuOwners.push(rec);
    this._gpuOwners.sort((a, b) => a.order - b.order);
    return () => { const i = this._gpuOwners.indexOf(rec); if (i >= 0) this._gpuOwners.splice(i, 1); };
  }

  /** ShapeManager installs this: it snapshots the document, calls `install()` (new device + every GPU resource) and
   *  restores the document content. Returns what could not be recovered. Null = infrastructure-only recovery. */
  public setDeviceRecoveryHandler(fn: ((install: () => Promise<void>) => Promise<string[] | void>) | null): void { this._recoveryHandler = fn; }

  /** TEST HOOK: destroy the current device as if the GPU process had reset (a real loss takes the same path). */
  public simulateDeviceLoss(): void { try { this._deviceHandle?.current.destroy(); } catch { /* already lost */ } }

  private _rasterOwnerRegistered = false;
  /** The raster engines (paint / composite / selection) re-initialise after the layer textures are re-created (the
   *  RasterLayerManager owner runs at order 40), so they bind the new active layer texture, never the dead one. */
  private _registerRasterEngineOwner(): void {
    if (this._rasterOwnerRegistered) return;
    this._rasterOwnerRegistered = true;
    this.registerGpuResourceOwner('raster-engines', () => { if (this.rasterDrawingService) this.initializeRasterTexture(); }, 60);
    // Temporal AA: the history / velocity targets live on the (rebuilt) Renderer3D; a recovered device starts the
    // accumulation over (the setting itself lives here and is re-applied every frame).
    this.registerGpuResourceOwner('temporal-aa', () => { this._renderer3D?.resetTemporalHistory(); this._taaSettleLeft = 0; }, 70);
  }

  // ── GPU CAPABILITY TIER + CAPS (gpu-capabilities.ts; mobile-parity CRASH-8 / CRASH-3 / CRASH-10; docs/ui/gpu-diagnostics.md) ──
  // A PER-MACHINE layer resolved from the adapter + environment at start-up and again before every device rebuild
  // (a crash loop switches to the 'safe' tier there). It clamps renderer switches; it never writes document settings.
  private _gpuTier: GpuTier = 'desktop';
  private _gpuTierReasons: string[] = [];
  private _gpuCaps: GpuCaps = { ...DESKTOP_CAPS };
  private _adapter: GPUAdapter | null = null;
  private _adapterInfo: GpuAdapterFacts | null = null;
  private _indirectFirstInstance = true;
  private _gpuTierLogged = false;
  private _gpuErrorsLogged = 0;
  private readonly _prevSessionCrumbs = readPersistedGpuCrumbs();

  /** Resolve the tier + caps for a (new) device and apply them. Logs the tier once per page load (and on a change). */
  private _resolveGpuCaps(got: SalsaDevice, phase: 'start-up' | 'recovery'): void {
    this._adapter = got.adapter;
    this._adapterInfo = got.adapterInfo ?? null;
    this._indirectFirstInstance = got.indirectFirstInstance !== false;
    const prevTier = this._gpuTier;
    const t = detectGpuTierNow(this._adapterInfo);
    this._gpuTier = t.tier; this._gpuTierReasons = t.reasons;
    const caps = resolveGpuCaps(t.tier, { indirectFirstInstance: this._indirectFirstInstance });
    this.applyGpuCaps(caps, false);   // (no live renderer / resize here: the rebuild + the caller handle those)
    if (!this._gpuTierLogged || prevTier !== t.tier) {
      this._gpuTierLogged = true;
      const a = this._adapterInfo;
      console.log(`[Salsa][gpu] tier ${t.tier} (${phase}; ${t.reasons.join(', ')}; adapter ${a ? [a.vendor, a.architecture, a.description].filter(Boolean).join(' / ') || 'hidden' : 'n/a'}`
        + `${this._indirectFirstInstance ? '' : '; no indirect-first-instance'}) caps ${gpuJson(caps)}`);
    }
    gpuCrumb(`tier ${t.tier} (${phase})`);
  }

  /**
   * Apply per-machine caps (normally resolved from the tier; exposed for the host / tests). Sets the engine-wide
   * statics (Renderer3D.caps, TextEffectEngine.htmlInCanvasAllowed, GPUPipelineCache.defaultMaxConcurrentWarm), the
   * live renderer's state and the canvas backing cap. Never touches document settings or stored preferences.
   */
  public applyGpuCaps(caps: GpuCaps, live = true): void {
    const c = { ...caps };
    if (!this._indirectFirstInstance) c.gpuDriven = false;   // the GPU-driven bundles need firstInstance
    this._gpuCaps = c;
    const rc = Renderer3D.caps;
    rc.gpuDriven = c.gpuDriven;
    rc.shadows = c.shadows; rc.ssao = c.ssao; rc.ssr = c.ssr; rc.taa = c.taa; rc.animatedFocusBg = c.animatedFocusBg !== false;
    if (Number.isFinite(c.shaderSplitMaxKeys) && c.shaderSplitMaxKeys > 0) rc.shaderSplitMaxKeys = MeshFsPipelines.maxKeys = Math.floor(c.shaderSplitMaxKeys);
    TextEffectEngine.htmlInCanvasAllowed = c.htmlInCanvas;
    setRasterUndoTierBudget(c.undoMemoryBytes);   // C3: the shared raster undo budget (sm.setUndoMemoryBudget overrides)
    GPUPipelineCache.defaultMaxConcurrentWarm = Math.max(1, Math.floor(c.warmConcurrency));
    const pc = this.device ? GPUPipelineCache.peek(this.device) : null;
    if (pc) pc.maxConcurrentWarm = GPUPipelineCache.defaultMaxConcurrentWarm;
    if (!live) return;
    this._renderer3D?.applyDeviceCaps();
    if (this._canvasSizedFor && this.device) this.setCanvasSize(this.getDevice());   // no-op unless the backing size changes
  }
  /** The caps in force (a copy). */
  public getGpuCaps(): GpuCaps { return { ...this._gpuCaps }; }
  /** The tier in force ('desktop' | 'mobile' | 'safe') and why. */
  public getGpuTier(): { tier: GpuTier; reasons: string[] } { return { tier: this._gpuTier, reasons: this._gpuTierReasons.slice() }; }

  /** Everything a host needs to show / copy a GPU report (docs/ui/gpu-diagnostics.md). */
  public getGpuDiagnostics(): {
    tier: GpuTier; reasons: string[]; caps: GpuCaps; safeMode: boolean;
    adapter: GpuAdapterFacts | null; gpuName: string | null;
    features: string[]; limits: Record<string, number>; adapterLimits: Record<string, number>;
    /** format = the configured swap-chain format; preferredFormat = navigator.gpu.getPreferredCanvasFormat() (they
     *  differ only under the localStorage 'salsa.gpu.canvasFormat' override, CRASH-6). */
    canvas: { cssWidth: number; cssHeight: number; width: number; height: number; windowDpr: number; format: GPUTextureFormat; preferredFormat: GPUTextureFormat | null };
    status: GpuDeviceStatusInfo; lastLoss: GpuLossRecord | null;
    breadcrumbs: GpuCrumb[]; openOps: string[]; errors: GpuErrorRecord[];
    previousSession: { at: number; crumbs: GpuCrumb[]; open: string[] } | null;
  } {
    const lim = (l: GPUSupportedLimits | undefined | null): Record<string, number> => {
      const o: Record<string, number> = {};
      if (!l) return o;
      for (const k in l) { const v = (l as unknown as Record<string, unknown>)[k]; if (typeof v === 'number') o[k] = v; }
      return o;
    };
    let features: string[] = [];
    try { features = this.device ? [...(this.device.features as unknown as Iterable<string>)].sort() : []; } catch { features = []; }
    let rect = { width: 0, height: 0 };
    try { rect = this.canvas?.getBoundingClientRect() ?? rect; } catch { /* no layout */ }
    let preferredFormat: GPUTextureFormat | null = null;
    try { preferredFormat = typeof navigator !== 'undefined' ? navigator.gpu?.getPreferredCanvasFormat() ?? null : null; } catch { /* no WebGPU */ }
    return {
      tier: this._gpuTier, reasons: this._gpuTierReasons.slice(), caps: this.getGpuCaps(), safeMode: isGpuSafeModeStored(),
      adapter: this._adapterInfo ? { ...this._adapterInfo } : null, gpuName: this._gpuName,
      features, limits: lim(this.device?.limits), adapterLimits: lim(this._adapter?.limits),
      canvas: { cssWidth: rect.width, cssHeight: rect.height, width: this.canvas?.width ?? 0, height: this.canvas?.height ?? 0,
        windowDpr: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
        format: this.swapChainFormat, preferredFormat },
      status: this.getDeviceStatus(), lastLoss: readLastGpuLoss(),
      breadcrumbs: getGpuCrumbs(), openOps: getOpenGpuOps(), errors: getGpuErrors(),
      previousSession: this._prevSessionCrumbs,
    };
  }

  private _watchDevice(real: GPUDevice): void {
    real.lost.then((info) => {
      if (this._deviceHandle && this._deviceHandle.current !== real) return;   // a device we already replaced
      if (this._intentionalDeviceDestroy) return;                               // our own teardown, not a loss
      this._onDeviceLost(info.reason ?? 'unknown', info.message ?? '');
    }, () => { /* never rejects */ });
    // CRASH-10: uncaptured GPU errors (validation / out-of-memory / internal) are logged with their class and kept
    // for the diagnostics + the loss record. The browser still logs them too (no preventDefault).
    try {
      real.addEventListener('uncapturederror', (ev: Event) => {
        if (this._deviceHandle && this._deviceHandle.current !== real) return;
        const err = (ev as GPUUncapturedErrorEvent).error as (GPUError & { constructor?: { name?: string } }) | undefined;
        const kind = err?.constructor?.name || 'GPUError';
        const message = err?.message ?? String(err);
        if (recordGpuError(kind, message) && this._gpuErrorsLogged < 20) {
          this._gpuErrorsLogged++;
          console.warn(`[Salsa][gpu] uncaptured ${kind}: ${message}`);
        }
      });
    } catch { /* test doubles without EventTarget */ }
  }

  private _onDeviceLost(reason: string, message: string): void {
    if (this._deviceLost) return;
    this._deviceLost = true;
    console.warn(`[Salsa][gpu] device lost (${reason}): ${message}`);
    // CRASH-10 / CRASH-3: persist what was going on (salsa.gpu.lastLoss) and run the crash-loop guard: 2 losses within
    // 60 s → safe mode (stored), which the rebuild below picks up (_installNewDevice re-resolves the tier).
    try {
      const rec = recordGpuDeviceLoss(reason, message, { adapter: this._adapterInfo, tier: this._gpuTier, caps: this.getGpuCaps() });
      if (rec.open.length) console.warn('[Salsa][gpu] still open at the loss:', rec.open.join(' | '));
      if (rec.safeModeTripped) console.warn('[Salsa][gpu] repeated device loss: switching to SAFE mode (salsa.gpu.safeMode; ?salsaSafe=0 clears it)');
    } catch { /* diagnostics never block the recovery */ }
    // Stop the loop cleanly: no frame is recorded against the dead device (each would throw or log every vsync).
    this._wasLiveBeforeLoss = this.live || this._wasLiveBeforeLoss;
    this.live = false;
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this._deviceStatus.set({ status: 'lost', reason, message, unrecovered: [] });
    if (this.autoRecoverDevice) void this.recoverDevice();
  }

  /**
   * Recover from a device loss: new adapter + device, every GPU resource rebuilt, content restored (via the recovery
   * handler). Resolves true when the canvas renders again; false (status 'failed', overlay shown) when no device
   * could be had or a rebuild step threw. Concurrent calls share one attempt.
   */
  public recoverDevice(): Promise<boolean> {
    if (this._recoveryPromise) return this._recoveryPromise;
    if (!this._deviceLost) return Promise.resolve(true);
    this._recoveryPromise = (async () => {
      this._deviceStatus.set({ status: 'recovering' });
      const t0 = performance.now();
      try {
        const unrecovered = (this._recoveryHandler ? await this._recoveryHandler(() => this._installNewDevice()) : await this._installNewDevice()) || [];
        this._deviceLost = false;
        if (this._wasLiveBeforeLoss) this.play();
        this._wasLiveBeforeLoss = false;
        this.renderListDirty = true; this._flatShapesDirty = true;
        this.scheduleRender();
        hideWebGPUOverlay(this.canvas);
        console.log(`[Salsa][gpu] device recovered in ${Math.round(performance.now() - t0)} ms`);
        this._deviceStatus.set({ status: 'ok', reason: null, message: null, unrecovered: unrecovered as string[] });
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('[Salsa][gpu] device recovery failed:', e);
        this._deviceStatus.set({ status: 'failed', reason: 'recovery-failed', message });
        if (WebGPURenderer.showDeviceOverlays) showWebGPUOverlay(this.canvas, describeWebGPUUnavailable('recovery-failed', message));
        return false;
      } finally {
        this._recoveryPromise = null;
      }
    })();
    return this._recoveryPromise;
  }

  /** New device, handle re-pointed, context reconfigured, own resources, then the registered owners (in order). */
  private async _installNewDevice(): Promise<void> {
    const got = await requestSalsaDeviceWithRetry();
    if (!this._deviceHandle) throw new Error('no device handle');
    this._deviceHandle.retarget(got.device);
    this._gpuName = got.gpuName ?? this._gpuName;
    this._watchDevice(got.device);
    // The caps BEFORE anything is rebuilt (a crash loop has switched the tier to 'safe' by now)
    this._resolveGpuCaps(got, 'recovery');
    // The pipeline cache is keyed by the device object; the handle keeps its identity, so drop the dead cache.
    GPUPipelineCache.forget(this.device);
    this._pipelineWarmScheduled = false; this._pipelineWarmStarted = false;
    this.context.configure({
      device: unwrapDevice(this.device),
      format: this.swapChainFormat,
      usage: this._contextUsage(),
      alphaMode: this._contextAlphaMode(),
    });
    this._rebuildOwnGpuResources();
    for (const o of [...this._gpuOwners]) {
      try { await o.rebuild(this.device); }
      catch (e) { throw new Error(`rebuilding '${o.name}' failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    this.setCanvasSize(this.getDevice());   // TIER-1: a tier change (safe mode) may change the DPR cap (no-op otherwise)
    this._schedulePipelineWarmup();
  }

  /** The renderer's OWN GPU objects. Renderers / engines are re-created (their constructors make their resources);
   *  lazily created buffers + textures are swept (null) and come back on first use; the few eager ones are rebuilt. */
  private _rebuildOwnGpuResources(): void {
    const old3D = this._renderer3D;
    const cam = old3D?.getCamera();
    // Fresh 3D renderers: every pipeline, pass, geometry pool, instance buffer, shadow map, IBL bake and GPU-scene
    // buffer comes back through the constructor (or lazily). The CAMERA object carries over: the orbit / fly / Play
    // controllers hold it. Scene settings are re-applied by the document restore; the per-SESSION switches (never
    // saved) are carried here. GPU-driven / culling-mode / P14 / P16 switches are statics and survive on their own.
    this._renderer3D = undefined;
    this._gpRenderer3D = undefined;
    if (cam) {
      const r3 = this._renderer3D = new Renderer3D(this.device, cam, this.swapChainFormat);
      r3.onDeferredWork = () => this.scheduleRender();
      if (old3D) {
        r3.shadowStaticCache = old3D.shadowStaticCache;   // P14 farStaticCache
        r3.setShadowQuality(old3D.shadowPcfRadius);        // the scene PCF kernel (per session outside a city)
        r3.frustumCulling = old3D.frustumCulling;
        r3.distanceLod = old3D.distanceLod;
        r3.distanceLodScale = old3D.distanceLodScale;
        r3.distanceLodBias = old3D.distanceLodBias;
        r3.orthoScreenLod = old3D.orthoScreenLod;      }
    }
    // Raster engines (paint / composite / selection / overlay): re-created below by initializeRasterTexture.
    this.rasterTextureManager = undefined; this._rasterPaintEngine = undefined; this._rasterCompositor = undefined;
    this._rasterSelectionEngine = undefined; this._selectionOverlayRenderer = undefined; this.rasterTexture = undefined;
    this.rasterCompositionList = undefined; this.rasterForegroundList = undefined;
    this._gpuTimer = null;
    this.bgBindGroup = undefined as unknown as GPUBindGroup;   // ensureBackgroundResources re-creates the bg set
    // Every remaining own field that holds an old-device object (all lazily created: `if (!this.x) this.x = ...`).
    const swept = sweepGpuFields(this, ['device', 'context']);
    if (swept.length) console.log('[Salsa][gpu] renderer fields swept:', swept.join(', '));
    // The eager ones.
    this.stagingBuffer = new StrokesStagingBuffer(this.device);
    this.patternSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    this.interactionService.setDepthTextureView(this.device);
    this.ensureLastFrameTex();
    // (the raster engines re-initialise in the 'raster-engines' owner hook, AFTER the layer textures are re-created)
    this.bgDirty.res = true; this.bgDirty.matrix = true; this.bgDirty.colors = true;
    this.renderListDirty = true; this._flatShapesDirty = true;
  }
  
  public setWebGPURenderStrategy(strategy: WebGPURenderStrategy) {
      this.webGPURenderStrategy = strategy;
  }

  public setSceneGraph(sceneGraph: SceneGraph) {
      this.sceneGraph = sceneGraph;
      this.selectionService = new SelectionService(sceneGraph.root);
      // Gate pointer interactivity (click + marquee) to the active vector layer: a layer-tagged
      // vector shape is hit-testable only when its layer is active; unassigned shapes (no layerId)
      // stay live. null active layer → all layer-tagged vector shapes are inert (clicks fall
      // through to raster paint / 3D orbit). Render is untouched.
      this.selectionService.isInteractable = (n) =>
          this.interactionService.isVectorLayerInteractive(n.layerId);
      this._flatShapesDirty = true;
      this.renderListDirty = true;
  }

  /** QUIET structural change: re-walk the tree into the flat shape list on the next render-list rebuild (what the
   *  onSceneGraphChanged subscription does) WITHOUT a host-facing scene-graph event — engine-internal node churn
   *  (the live crowd's per-person meshes, Scene3DManager.notifySceneStructureChanged3D). */
  public markStructureDirty(): void {
      this._flatShapesDirty = true;
      this.renderListDirty = true;
      this.scheduleRender();
  }

  public setPipelineManager(
      pipelineManager: PipelineManager,
      bindGroupManager: BindGroupManager,
      cacheService: CacheService
  ) {
      this.pipelineManager = pipelineManager;
      this.bindGroupManager = bindGroupManager;
      this.cacheService = cacheService;
      this.caretManager = new CaretManager(this.device, this.cacheService!.caretUniformBuffer);
      this.selectionHighlightManager = new SelectionHighlightManager(this.device, this.cacheService!.selectionHighlightBuffer);
      this.overlayDotManager = new OverlayDotManager(this.device, this.cacheService!.overlayDotBuffer);
      this.bgBindGroup = undefined as any; // force recreate in ensureBackgroundResources()
      this.cachedAtlasVersion = this.cacheService.getSdfAtlas().version; // seed
      this.renderListDirty = true;
  }

  // Setter to assign CacheService
  public setCacheService(service: CacheService) {
      this.cacheService = service;
  }

  /** Get the cache service (for external cache cleanup, e.g. on shape deletion). */
  public getCacheService(): CacheService | null {
      return this.cacheService;
  }

  // Setter to assign LineDrawingService
  public setLineDrawingService(service: LineDrawingService) {
      this.lineDrawingService = service;
  }

  // Setter to assign PatternDrawingService
  public setPatternDrawingService(service: PatternDrawingService) {
      this.patternDrawingService = service;
  }

  // Setter to assign EraserService
  public setEraserService(service: EraserService) {
      this.eraserService = service;
  }

  // Setter to assign ScribbleDrawingService
  public setScribbleDrawingService(service: ScribbleDrawingService) {
      this.scribbleDrawingService = service;
  }

  // Setter to assign SectionDrawingService
  public setSectionDrawingService(service: SectionDrawingService) {
      this.sectionDrawingService = service;
  }

  // Setter to assign HighlightDrawingService
  public setHighlightDrawingService(service: HighlightDrawingService) {
      this.highlightDrawingService = service;
  }

  // Setter to assign TextDrawingService
  public setTextDrawingService(service: TextDrawingService) {
      this.textDrawingService = service;
  }

  // Setter to assign SdfTextDrawingService
  public setSdfTextDrawingService(service: SdfTextDrawingService) {
      this.sdfTextDrawingService = service;
  }

  public setRasterDrawingService(service: import('../../services/raster-drawing-service').RasterDrawingService) {
    this.rasterDrawingService = service;
    this.initializeRasterTexture();
  }

  public setRasterSelectionService(service: import('../../services/raster-selection-service').RasterSelectionService) {
    this.rasterSelectionService = service;
  }

  public setRasterMoveService(service: import('../../services/raster-move-service').RasterMoveService) {
    this.rasterMoveService = service;
  }

  public setStampDrawingService(service: StampDrawingService) {
      this.stampDrawingService = service;
  }

  public setPolygonDrawingService(service: PolygonDrawingService) {
      this.polygonDrawingService = service;
  }

  /** Set the raster text service for preview overlay rendering. */
  public setRasterTextService(service: IRasterTextPreviewProvider) {
      this._rasterTextService = service;
  }

  /** Set the connector service for port indicator rendering. */
  public setConnectorService(service: ConnectorService) {
      this._connectorService = service;
  }
    
  private handleWheel(event: WheelEvent) { this._interaction.handleWheel(event); }
  private handlePointerDown(event: PointerEvent) { this._interaction.handlePointerDown(event); }
  private handlePointerMove(event: PointerEvent) { this._interaction.handlePointerMove(event); }
  private handlePointerUp(event: PointerEvent) { this._interaction.handlePointerUp(event); }

  /** Backing px per CSS px of the main canvas AS BACKED (`canvas.width / CSS width`): the ratio for every CSS ↔
   *  canvas-px conversion. NOT window.devicePixelRatio, which differs once the TIER-1 mobile cap applies (a DPR-2
   *  tablet backs at 1.5); that is only the fallback before layout. Equal to the DPR on desktop (uncapped). */
  public getCanvasPixelRatio(): number { return canvasPixelRatio(this.canvas); }

  /** TOUCH-7: pan the 2D view by a CSS-pixel screen delta (finger-locked at any devicePixelRatio). */
  public touchPan2D(dxCss: number, dyCss: number): void { this._interaction.touchPan2D(dxCss, dyCss); }
  /** TOUCH-7: zoom the 2D view by `ratio` (> 1 = in) around client (x, y). */
  public touchZoom2D(ratio: number, clientX: number, clientY: number): void { this._interaction.touchZoom2D(ratio, clientX, clientY); }

  // ── Onion Skin Overlay ──────────────────────────────────────────

  /**
   * Apply onion skin ghost frames on top of the composited raster output.
   * Reads onion skin config from the layer manager, gathers textures for
   * adjacent frames, and composites them as tinted semi-transparent overlays.
   */
  private applyOnionSkinOverlay(): void {
    if (!this._rasterCompositor || !this.rasterTexture || !this.rasterLayerManager) return;

    const config = this.rasterLayerManager.getOnionSkinConfig();
    if (!config.enabled || (config.framesBefore <= 0 && config.framesAfter <= 0)) return;
    if (!this.rasterLayerManager.isAnimationEnabled()) return;

    const timeline = this.rasterLayerManager.getTimeline();
    // Not while the timeline plays (as in most animation tools): ghosts of neighbouring frames are a drawing aid, and
    // each one costs a full-canvas copy + blend per frame. ShapeManager re-renders when playback stops.
    if (timeline.isPlaying()) return;
    const currentFrame = timeline.getCurrentFrame();
    const frameCount = timeline.getFrameCount();
    const selectedId = this.rasterLayerManager.getSelectedLayerId();

    const onionFrames: Array<{ texture: GPUTexture; opacity: number; tint: [number, number, number] }> = [];

    // Helper: get the best ghost texture for a given frame.
    // Prefers the selected layer's texture, falls back to first animated layer.
    const getGhostTexture = (frame: number): GPUTexture | null => {
      const textures = this.rasterLayerManager!.getLayerTexturesAtFrame(frame);
      // Prefer the selected/active layer
      if (selectedId) {
        const selTex = textures.get(selectedId);
        if (selTex) return selTex;
        // a BLANK frame / blank cel of the selected animated layer (perf audit D1: a blank cel owns no texture) has no
        // ghost — not some other layer's drawing (the static background used to be ghosted there)
        if (timeline.isLayerAnimated(selectedId)) return null;
      }
      // Fallback: first non-null texture
      for (const [, tex] of textures) {
        if (tex) return tex;
      }
      return null;
    };

    // Gather previous frames (furthest first so closest draws on top)
    for (let i = config.framesBefore; i >= 1; i--) {
      const frame = currentFrame - i;
      if (frame < 1) continue;

      const ghostTex = getGhostTexture(frame);
      if (!ghostTex) continue;

      // Opacity falls off with distance
      const falloff = Math.pow(config.opacity, i);

      onionFrames.push({
        texture: ghostTex,
        opacity: falloff,
        tint: config.tintBefore,
      });
    }

    // Gather next frames (closest first)
    for (let i = 1; i <= config.framesAfter; i++) {
      const frame = currentFrame + i;
      if (frame > frameCount) continue;

      const ghostTex = getGhostTexture(frame);
      if (!ghostTex) continue;

      const falloff = Math.pow(config.opacity, i);

      onionFrames.push({
        texture: ghostTex,
        opacity: falloff,
        tint: config.tintAfter,
      });
    }

    if (onionFrames.length > 0) {
      this._rasterCompositor.applyOnionSkin(this.rasterTexture, onionFrames);
    }
  }

  private rasterLayerManager?: RasterLayerManager;
  public setRasterLayerManager(mgr: RasterLayerManager) {
    this.rasterLayerManager = mgr;
    // Register a selection callback so we can redirect painting to the active layer
    mgr.setSelectionCallback((layerTexture, _layerManager) => {
      if (this._rasterPaintEngine && layerTexture) {
        this._rasterPaintEngine.setActiveTexture(layerTexture);
      }
      // Also update the selection engine's target
      this._rasterSelectionEngine?.setActiveTexture(layerTexture);
    });
    // Point the paint engine at the initially-selected layer texture
    const initialTex = mgr.getSelectedLayerTexture();
    if (initialTex && this._rasterPaintEngine) {
      this._rasterPaintEngine.setActiveTexture(initialTex);
      this._rasterPaintEngine.initializeSnapshots().catch(console.warn);
    }
  }

  /** Get the active layer's texture for painting (falls back to rasterTexture). */
  private getActiveLayerTexture(): GPUTexture | null {
    return this.rasterLayerManager?.getSelectedLayerTexture() ?? this.rasterTexture ?? null;
  }

  /**
   * Re-point the paint/selection engines at the currently-selected layer's live
   * texture. Layer textures are reallocated on resize (ensureTexture), which can
   * leave the paint engine holding a stale, no-longer-composited texture — so the
   * brush appears to do nothing. Called at stroke start as a safety net.
   */
  public syncActiveLayerTexture(): void {
    const tex = this.getActiveLayerTexture();
    if (this._rasterPaintEngine && tex) this._rasterPaintEngine.setActiveTexture(tex);
    this._rasterSelectionEngine?.setActiveTexture(tex);
  }

  /** The CSS size + DPR the backing store was last sized for (TIER-1: skip a no-op resize). */
  private _canvasSizedFor: { canvas: HTMLCanvasElement; w: number; h: number; dpr: number } | null = null;

  /** Size the canvas backing store to its CSS box × DPR, under the device caps (TIER-1: mobile DPR ≤ 1.5 and
   *  ≤ ~2.5 MP; desktop uncapped = the old behaviour). Skips everything when nothing changed (the ResizeObserver and
   *  the window resize both call this, and Android's URL bar fires resizes constantly); `force` = always re-apply.
   *  A no-op while SUSPENDED (UI-16): the Shell owns the canvas then and sizes it itself (same caps → same size);
   *  without this the two ResizeObservers fought over canvas.width. resumeRendering()/reinitialize() re-sync. */
  setCanvasSize(device: GPUDevice, force = false) {
    if (this._suspended) return;
    const winDpr = window.devicePixelRatio || 1;
    // Read the canvas's actual rendered size so the pixel buffer matches its
    // CSS container — handles split-view layouts where the canvas is narrower
    // than the window.  Fall back to window dimensions only if the canvas has
    // not been laid out yet (rect is zero, e.g. during first-frame init).
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width  || window.innerWidth;
    const h = rect.height || window.innerHeight;
    const b = computeCanvasBacking(w, h, winDpr, this._gpuCaps);
    const last = this._canvasSizedFor;
    if (!force && last && last.canvas === this.canvas && last.w === w && last.h === h && last.dpr === b.dpr
        && this.canvas.width === b.width && this.canvas.height === b.height) return;
    this._canvasSizedFor = { canvas: this.canvas, w, h, dpr: b.dpr };
    if (this.canvas.width !== b.width) this.canvas.width = b.width;
    if (this.canvas.height !== b.height) this.canvas.height = b.height;

    // DO NOT call rasterLayerManager.setSize here.
    // Raster layer textures hold document pixel data at the document's own
    // resolution; they must never change size because the browser viewport
    // changed (DevTools open/close, window resize, etc.).
    // setSize is only valid when the document size itself changes
    // (setDocumentSize / clearDocumentSize / document load).

    this.interactionService.updateWorldMatrix();
    this.interactionService.setDepthTextureView(device);
    this.interactionService.viewportBounds.markDirty();
    this.bgDirty.res = true;
    this.renderListDirty = true;
    this.ensureLastFrameTex();
    this.scheduleRender();
  }

  // Starting point of WebGPU Setup & Rendering Loop
  public async initialize() {
      await this.initWebGPU();
      
      // Size the pixel buffer to the canvas's CSS container, then keep it in
      // sync.  ResizeObserver fires when the container changes (e.g. split-view
      // activation); the window resize listener catches zoom-level / DevTools.
      // (setCanvasSize is a no-op when nothing changed, so the two sources never resize twice.)
      this.setCanvasSize(this.getDevice(), true);
      this._observeCanvasSize();

      // Instantiate the staging buffer since device is now available
      this.stagingBuffer = new StrokesStagingBuffer(this.getDevice());

      // Pattern cache+sampler setup
      // Create a sampler for pattern textures
      this.patternSampler = this.device.createSampler({
          magFilter: "linear", // How to upscale
          minFilter: "linear", // How to downscale
          addressModeU: "repeat", // Repeat pattern horizontally
          addressModeV: "repeat"  // Repeat pattern vertically
      });
      this.renderListDirty = true;

      this.play();
  }

  private _resizeObserver: ResizeObserver | null = null;
  private _windowResizeBound: (() => void) | null = null;
  /** Watch the CURRENT canvas's size (ResizeObserver) + the window (DPR / zoom changes). Re-called by
   *  reinitialize() for the new canvas (TIER-1: the old observer stayed on the previous canvas). */
  private _observeCanvasSize(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver ??= new ResizeObserver(() => { if (this.device) this.setCanvasSize(this.getDevice()); });
      this._resizeObserver.disconnect();
      this._resizeObserver.observe(this.canvas);
    }
    if (!this._windowResizeBound && typeof window !== 'undefined') {
      this._windowResizeBound = () => { if (this.device) this.setCanvasSize(this.getDevice()); };
      window.addEventListener('resize', this._windowResizeBound);
    }
  }

  public async reinitialize(newCanvas: HTMLCanvasElement) {
  // 0) The editor is reclaiming the canvas, so release any foreign (Shell UI)
  //    hard-suspend. reinitialize() restarts the render loop via play() below,
  //    but play() does NOT clear _suspended — so without this, the loop spins
  //    with every draw blocked (line: `if (this._suspended) return`) and the
  //    restored document never appears (the white-screen-on-reopen bug).
  this._suspended = false;

  // 1) Reset scenegraph — through removeChild, so each subtree leaves the id map too. (`children.length = 0` left every
  //    node of the previous document registered: findNodeById kept resolving detached nodes after a Shell → editor
  //    swap. The host starts the next document with ShapeManager.startBlankDocument, which clears the rest.)
  for (const child of [...this.sceneGraph.root.children]) this.sceneGraph.root.removeChild(child);

  // 2) Swap canvas everywhere that needs it
  const oldCanvas = this.canvas;
  this.interactionService.canvas = newCanvas;

  // 3) Rebind renderer’s own event handlers to the new canvas
  //    (avoid duplicate bindings if called multiple times)
  if (oldCanvas && oldCanvas !== newCanvas) {
    removeZonelessListener(oldCanvas, 'pointerdown', this._boundPointerDown);
    removeZonelessListener(oldCanvas, 'pointermove', this._boundPointerMove);
    removeZonelessListener(oldCanvas, 'pointerup',   this._boundPointerUp);
    removeZonelessListener(oldCanvas, 'wheel',       this._boundWheel);
    removeZonelessListener(oldCanvas, 'pointercancel', this._boundPointerCancel);
  }
  this.initializeCanvas(newCanvas);

  // 4) Rebind drawing tool listeners to the new canvas
  this.eraserService?.reinitializeEventListeners();
  this.highlightDrawingService?.reinitializeEventListeners();
  this.lineDrawingService?.reinitializeEventListeners();
  this.patternDrawingService?.reinitializeEventListeners();
  this.stampDrawingService?.reinitializeEventListeners();
  this.scribbleDrawingService?.reinitializeEventListeners();
  this.sectionDrawingService?.reinitializeEventListeners();
  this.textDrawingService?.reinitializeEventListeners();
  // Tools owned by ShapeManager (polygon pen tool, path node editor) re-bind through this hook —
  // the renderer can't import ShapeManager (circular dep), so the manager registers a callback.
  this.onCanvasReinitialized?.();
  this.sdfTextDrawingService?.reinitializeEventListeners();
  // Freeform polygon tool binds its own pointerdown/move/dblclick to the canvas — re-bind it too,
  // else click-to-place-points is dead after a Shell -> illustration navigation (canvas swap) while
  // presets (which go through the ShapeManager API, not a canvas listener) still work.
  this.polygonDrawingService?.reinitializeEventListeners();
  // Raster tools (brush/pen, marquee selection, move) also bind pointer
  // listeners to the canvas — re-bind them too, else painting/selection are
  // dead after a Shell → illustration navigation (canvas swap).
  this.rasterDrawingService?.reinitializeEventListeners();
  this.rasterSelectionService?.reinitializeEventListeners();
  this.rasterMoveService?.reinitializeEventListeners();

  // 5) Reconfigure the WebGPU context for the new canvas
  this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
  this.context.configure({
    device: unwrapDevice(this.device),
    format: this.swapChainFormat,
    usage: this._contextUsage(),
    alphaMode: this._contextAlphaMode(),
  });

  // 6) Make sure the canvas has the right DPR size and depth buffer
  this.setCanvasSize(this.getDevice(), true);             // (forced: a new canvas / context)
  this._observeCanvasSize();                              // TIER-1: observe the NEW canvas
  this.interactionService.setDepthTextureView(this.device);

  // 7) Mark background + world as dirty so they update next frame
  this.interactionService.updateWorldMatrix();
  this.interactionService.viewportBounds.markDirty();
  this.bgDirty.res = true;
  // Only mark matrix dirty if pattern is not fixed
  if (!this.backgroundPatternFixed) {
      this.bgDirty.matrix = true;
  }
  this.renderListDirty = true;

  // 8) Ensure a frame gets scheduled
  this.scheduleRender();

  // (Optional) If you ever paused the rAF loop, turn it back on:
  if (!this.live) this.play();
}

    private async initWebGPU() {
        
        /* About WebGPU and the navigator.gpu check:
        'navigator' is a property of the global 'window' object of the web browser that provides 
        information about the state of the browser. It includes various properties and methods, like 
        navigator.userAgent or navigator.gpu. When you write navigator.gpu, you're implicitly accessing 
        window.navigator.gpu. The browser's access to the GPU object is facilitated by the WebGPU API, 
        a modern graphics API that allows web applications to directly interact with the GPU for 
        high-performance graphics and compute tasks. The navigator.gpu property is the entry point for the 
        WebGPU API. It provides a GPU object, which you can use to access the GPU capabilities of the user's device.
        This object allows you to create GPU devices, command queues, buffers, textures, shaders, and other resources 
        necessary for rendering graphics or performing compute operations. The browser implements the WebGPU API, including 
        the navigator.gpu interface. This implementation interacts with the underlying operating system's graphics drivers to 
        communicate with the GPU.

        Remember that the browser acts as an abstraction layer between the web application and the underlying graphics hardware. 
        When you call functions on the GPU object, the browser translates these into lower-level graphics API calls 
        (like Vulkan, Direct3D, or Metal) that are executed by the GPU.
        --------------------------------------------------------------------------------------------------------------------------*/
        // Adapter + device through the shared request (docs/ui/device-recovery.md): every recovery requests the same
        // features + limits again. No WebGPU / no adapter (e.g. Chrome Canary's "No available adapters") shows a friendly
        // overlay with the fixes instead of leaving a black canvas; the error still propagates to the caller.
        let got: SalsaDevice;
        try { got = await requestSalsaDevice(); }
        catch (e) {
            const reason = e instanceof WebGPUUnavailableError ? e.reason : 'device-failed';
            const message = e instanceof Error ? e.message : String(e);
            this._deviceStatus.set({ status: 'unavailable', reason, message });
            if (WebGPURenderer.showDeviceOverlays) showWebGPUOverlay(this.canvas, describeWebGPUUnavailable(reason, message));
            throw e;
        }
        this._gpuName = got.gpuName;
        // Every owner gets the STABLE handle, so a recovery re-points one object instead of ~100 captured references.
        this._deviceHandle = createGpuDeviceHandle(got.device);
        this.device = this._deviceHandle.device;
        this._watchDevice(got.device);
        this._resolveGpuCaps(got, 'start-up');   // CRASH-8: the per-machine caps, before any pipeline / renderer exists
        this._deviceStatus.set({ status: 'ok', reason: null, message: null, gpuName: got.gpuName });
        this._registerRasterEngineOwner();

        this.interactionService.setDepthTextureView(this.device);


        /* About GPUCanvasContext:
        Retrieves the WebGPU rendering context for the canvas. This context is specifically designed to allow 
        WebGPU commands to render content onto a <canvas> element.  The context returned is cast to GPUCanvasContext, 
        which is a special type of context for managing the WebGPU rendering pipeline.

        The canvas context is the bridge between the WebGPU rendering pipeline and the HTML canvas. 
        It’s where the WebGPU commands will output the rendered content.

        Note: The swap chain format is the device's PREFERRED canvas format (navigator.gpu.getPreferredCanvasFormat():
        bgra8unorm on desktop Chrome / Windows, rgba8unorm on Android), chosen once here (canvas-format.ts, CRASH-6).
        Any other format makes the compositor convert / copy every frame. Every pipeline + texture that targets the
        canvas or lastFrameTex is built for this.swapChainFormat, and every read-back honours it (readbackToRgba).
        The swap chain format determines how the image data is represented in memory before being displayed on the screen.
        Also, alphaMode: 'premultiplied' is used. This setting indicates how the alpha channel (transparency) is handled. 
        'premultiplied' means that the color values have already been multiplied by the alpha value, which is a common way of 
        handling transparency in rendering.
        --------------------------------------------------------------------------------------------------------------------------*/
        if (!this._canvasFormatChosen) { this.swapChainFormat = pickCanvasFormat(); this._canvasFormatChosen = true; }
        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
        this.context.configure({
            device: unwrapDevice(this.device),
            format: this.swapChainFormat,
            usage: this._contextUsage(),
            alphaMode: this._contextAlphaMode(),
        });

        /* About GPUTextureView and MSAA: 
           Below we set up a texture on the GPU that will be used specifically for MSAA rendering. 
           This texture will hold multiple samples per pixel, according to the sampleCount, to smooth out the final rendered image.
           After creating the texture, the createView call sets up a GPUTextureView. This view is what we'll actually bind to our 
           render pipeline when we want to render content using MSAA. The view acts as a handle to the texture, allowing us to specify 
           how it will be used in rendering operations.

           When you render to the msaaTexture, each pixel in the texture is actually composed of multiple samples. 
           The GPU will calculate the final color of each pixel by averaging these samples.
           Once rendering is complete, the final image with reduced aliasing is typically resolved into a non-MSAA texture 
           (such as the swap chain texture) that can be displayed on the screen.
        ----------------------------------------------------------------------------------------------------------------------------*/
        /*
        this.msaaTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            sampleCount: this.sampleCount,
            format: this.swapChainFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.msaaTextureView = this.msaaTexture.createView();
        */

        // With the device ready, warm the 3D render pipelines during idle so the first 3D mesh (e.g. dropping a
        // cube into a raster doc) or the next document doesn't stall on shader compilation. See below.
        this._schedulePipelineWarmup();

        // Signal any awaiters (e.g. the Shell UI) that the device + context
        // are ready to borrow.
        this._readyResolve?.();
    }

    private _pipelineWarmScheduled = false;
    private _pipelineWarmStarted = false;
    /**
     * Warm all 3D render pipelines NOW, off the main thread (docs/specs/pipeline-warmup.md). Pipelines compile the
     * first time any 3D mesh renders and PERSIST on the device for the whole page-load (reused across the Angular
     * shell↔editor route via reinitialize()), so one background pass makes every later interaction — and every
     * later illustration open — hit already-hot pipelines. Public + idempotent so the host can call it from the
     * SHELL at mount (bootAndWarm), before any illustration is opened, giving the warm the whole shell-browse
     * window to finish. getRenderer3D() only REGISTERS pipelines (no compile); warmPipelinesAsync compiles them
     * via createRenderPipelineAsync. Best-effort — the granular per-pipeline sync getters remain the fallback.
     */
    public warmPipelinesNow(): void {
        if (this._pipelineWarmStarted || !this.device) return;
        this._pipelineWarmStarted = true;
        console.log('[Salsa][warm] warmPipelinesNow fired (bootAndWarm or auto-schedule)');
        try { void this.getRenderer3D().warmPipelinesAsync(); }
        catch { /* the on-demand sync getters still compile what a draw needs */ }
    }

    /** Auto-schedule the warm promptly (short idle timeout) once the device is ready, in case the host never calls
     *  bootAndWarm() explicitly. Stays off the very first paint but won't wait for deep idle. Runs once. */
    private _schedulePipelineWarmup(): void {
        if (this._pipelineWarmScheduled || !this.device) return;
        this._pipelineWarmScheduled = true;
        // P2: a draw skipped because its pipeline was still compiling asks for another frame when it lands (the
        // on-demand render loop would otherwise sit on the incomplete frame until the next input event).
        GPUPipelineCache.for(this.device).onPipelineReady(() => this.scheduleRender());
        if (this.needsFrame) queueMicrotask(() => this.scheduleRender());   // a frame requested before the device existed
        const g = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void; salsaHoldPipelineWarmup?: boolean };
        // mobile-parity UI-17 (d): a host whose own UI is on screen first (the Frogmarks Shell) sets
        // `globalThis.salsaHoldPipelineWarmup = true` BEFORE the device exists and calls bootAndWarm() when that UI is
        // calm, so the ~hundred pipeline compiles do not compete with its first frames. The automatic warm then stands
        // down (read when it fires, so the host can set it any time before); an explicit warmPipelinesNow() still runs.
        const auto = () => { if (!g.salsaHoldPipelineWarmup) this.warmPipelinesNow(); };
        if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(auto, { timeout: 200 });
        else setTimeout(auto, 0);
    }

    private rebuildRenderListIfNeeded() {
      if (!this.renderListDirty) return;

      // Re-walk the full tree only when shapes are added/removed (structure change).
      // During drag, pan, scale or zoom the shape list is identical — only the viewport
      // filter and sort need to re-run on the already-flat list.
      if (this._flatShapesDirty) {
        // PRE-SORT once per STRUCTURE change: the flat list keeps zIndex order, so the per-frame viewport filter
        // below (stable) yields an already-sorted renderList — the old per-PAN-FRAME O(n log n) sort over every
        // shape+mesh (meshes don't even use zIndex; depth-buffer orders them) is skipped on the hot path.
        // Step 2: one walk builds the 2D list and the 3D list (render-list-index.ts), each = the stable zIndex sort
        // of the preorder walk exactly as findAllShapesDeep + sort produced; a small structure change merges the new
        // nodes into the previous order instead of re-sorting the whole tree.
        this._rlIndex.walk(this.sceneGraph.root as Node & RenderListNode);
        this._flatShapes = this._rlIndex.flat2D as unknown as Shape[];
        this._flat3D = this._rlIndex.flat3D as unknown as Shape[];
        this._flatShapesDirty = false;
      }
      if (this._rlSplit) this._rebuild3DLists();

      const viewBox = viewportAABB(this.canvas, this.interactionService.getWorldMatrix());
      const list: typeof this.renderList = [];
      for (const n of this._flatShapes) {
        if (!n.visible) continue;
        // Never viewport-cull staged construction overlays (polygon tool edges/markers, live previews):
        // they're transient, few, and being actively drawn at the cursor — a bbox quirk must not hide them.
        if (!n.isStaging) {
          const bb = getWorldAABB(n);
          if (bb && !aabbOverlaps(viewBox, bb)) continue;
        }
        list.push(n);
      }
      // zIndex can change WITHOUT a structure change (layer reorder). O(n) sortedness check; sort only on violation
      // (and repair the flat list so subsequent frames are cheap again).
      let sorted = true;
      for (let i = 1; i < list.length; i++) if (list[i].zIndex < list[i - 1].zIndex) { sorted = false; break; }
      if (!sorted) {
        this._flatShapes.sort((a, b) => a.zIndex - b.zIndex);
        list.sort((a, b) => a.zIndex - b.zIndex);
      }
      this.renderList = list;

      this.renderListDirty = false;
    }

    /** Step 2: the 3D half of the render-list rebuild — every 3D node, in zIndex order, split by kind. 3D nodes have
     *  no 2D viewport box (getWorldSpaceBoundingBoxPolygon returns [] → never viewport-culled), plus the same zIndex
     *  sortedness repair. HIDDEN nodes stay in the lists (§P15 draw-bug 2026-10-04): the per-frame users
     *  (draw3DMeshes / draw3DParticles / draw3DGp) filter `visible` every frame, so a node shown again with only a
     *  scheduleRender (the eye decal / face kit / Play / script show paths) is drawn at once. Filtering it here kept a
     *  node hidden at the last rebuild out of every frame until an unrelated structure change. */
    private _rebuild3DLists(): void {
      const flat = this._flat3D;
      let sorted = true;
      for (let i = 1; i < flat.length; i++) if (flat[i].zIndex < flat[i - 1].zIndex) { sorted = false; break; }
      if (!sorted) flat.sort((a, b) => a.zIndex - b.zIndex);   // a zIndex edit since the walk (stable, like the old repair)
      const meshes = this._rl3DMeshes, emitters = this._rl3DEmitters, gp = this._rl3DGp;
      if (this._rl3DSkinned.length < flat.length) this._rl3DSkinned = new Uint8Array(Math.max(64, flat.length * 2));
      const sk = this._rl3DSkinned;
      let nm = 0, ne = 0, ng = 0;
      for (let i = 0; i < flat.length; i++) {
        const n = flat[i];
        if (n instanceof Mesh3D) { sk[nm] = n instanceof SkinnedMesh3D ? 1 : 0; meshes[nm++] = n; }
        else if (n instanceof ParticleEmitter3D) emitters[ne++] = n;
        else gp[ng++] = n as unknown as GpObject3D;
      }
      meshes.length = nm; emitters.length = ne; gp.length = ng;
    }

    /** Step 2: does this frame's layer / below-raster filter (the old aboveRaster filter) keep 3D node `n`? */
    private _keep3D(n: Node, hidden: Set<string>, meshEditHides: boolean, checkBelow: boolean): boolean {
      if (n.layerId && (hidden.has(n.layerId) || meshEditHides)) return false;
      return !(checkBelow && n.isRenderBelowRaster());
    }

    private cachedAtlasVersion = -1;
    private _lastCompactedAtVersion = -1;
    private static readonly ATLAS_COMPACT_THRESHOLD = 4096;

    /**
     * If the SDF atlas has grown to ATLAS_COMPACT_THRESHOLD or larger, wipe it and
     * repopulate from live SDFText shapes only. This reclaims space taken by glyphs
     * that belong to deleted or modified text shapes. The atlas resets to 1024 and
     * re-grows naturally to the minimum size required by the current scene.
     * A version guard prevents re-running when live glyphs already fill a large atlas.
     */
    private handleAtlasCompactIfNeeded() {
      if (!this.cacheService) return;
      const atlas = this.cacheService.getSdfAtlas();
      if (atlas.getAtlasSize() < WebGPURenderer.ATLAS_COMPACT_THRESHOLD) return;
      if (atlas.version === this._lastCompactedAtVersion) return;

      atlas.compact();

      this.sceneGraph.root.forEachDeep(n => {
        if (n instanceof SDFText) n.refreshText();
      });

      atlas.bumpVersion();
      this._lastCompactedAtVersion = atlas.version;
    }

    // PERF (audit 5.15): the atlas-version bump fires on every typed character /
    // animated-text frame, and used to walk the WHOLE scene graph to find the
    // handful of SDFText nodes. Reuse the memoized flat shape list instead
    // (findAllShapesDeep is exactly forEachDeep filtered to Shape, and SDFText
    // is a Shape — same node set). The SDFText sub-list is re-derived only when
    // the flat list object itself is replaced (structure change). While the
    // flat list is pending a rebuild (_flatShapesDirty), fall back to the deep
    // walk for correctness — registration on create/destroy was judged too
    // invasive (SDFText construction is scattered across shape-manager).
    private _sdfTextNodes: SDFText[] = [];
    private _sdfTextNodesFrom: unknown = null;
    private collectSdfTextNodes(): SDFText[] {
      if (!this._flatShapesDirty) {
        if (this._sdfTextNodesFrom !== this._flatShapes) {
          this._sdfTextNodes = this._flatShapes.filter((n): n is SDFText => n instanceof SDFText);
          this._sdfTextNodesFrom = this._flatShapes;
        }
        return this._sdfTextNodes;
      }
      const out: SDFText[] = [];
      this.sceneGraph.root.forEachDeep(n => {
        if (n instanceof SDFText) out.push(n);
      });
      return out;
    }

    // Call this once per frame before beginFrame()
    private handleAtlasChangeIfNeeded() {
      if (!this.cacheService) return;
      const atlas = this.cacheService.getSdfAtlas();
      const v = atlas.version;
      if (v === this.cachedAtlasVersion) return;

      // Rebuild SDFText UVs (memoized-list lookup — audit 5.15)
      for (const n of this.collectSdfTextNodes()) {
        n.markDirty();
        n.triggerRerender();
      }

      // Refresh the SDF text bind group to point at the new atlas view
      const sdfLayout = this.pipelineManager!.getSdfTextPipeline().getBindGroupLayout(0);
      this.bindGroupManager.ensureSdfTextBindGroupUpToDate(
        sdfLayout,
        atlas.getAtlasTexture().createView(),
        this.cacheService!.getSdfTextSampler(),
        this.cacheService!.sdfTextUniformCache.getUniformBuffer()!,
        v
      );

      this.renderListDirty = true;
    }

    private canvasBackgroundColor: Float32Array = new Float32Array([0.05, 0.05, 0.05, 1]);

    /**
     * When set, the current render() is a one-off OFFSCREEN CAPTURE, not an on-screen frame (see
     * captureArtboardRegionRGBA / the textured-artboard feature, docs/specs/textured-artboard.md):
     *   - `transparent` → clear to {0,0,0,0} instead of the canvas background, and skip the artboard pattern, so the
     *     captured image has real alpha (lines float; no-content areas are transparent).
     *   - `skip3D`      → skip the 3D mesh/gizmo pass (the artboard preview quad shows 2D content only).
     * Both branches also SKIP presenting to the swapchain, so a capture never disturbs the on-screen frame.
     * Null in all normal rendering, so these branches are inert outside capture.
     */
    private _captureMode: { transparent: boolean; skip3D: boolean } | null = null;

    public async render() {
        if (!this.device || !this.context) return;   // not initialised yet (see _renderLive)
        if (this._deviceLost) { this.needsFrame = true; return; }   // device lost: nothing records until recovery (docs/ui/device-recovery.md)
        // Run pre-render callbacks (orbit controller update, etc.)
        let needsAnotherFrame = false;
        const prof = this._cbProfile;
        const _r0 = prof ? performance.now() : 0;
        this._gpuTimer?.beginFrame();
        const _cull0 = performance.now();   // GPU culling auto mode: this frame's main-thread ms
        this._frameScaled = false;
        if (prof) {
          const fp = this._frameProfile;
          if (fp.last) fp.intervalMs = fp.intervalMs ? fp.intervalMs * 0.9 + (_r0 - fp.last) * 0.1 : _r0 - fp.last;
          fp.last = _r0;
          this.preRenderCallbacks.forEach((cb, i) => {
            const t0 = performance.now();
            if (cb()) needsAnotherFrame = true;
            const dt = performance.now() - t0, key = this._cbLabels.get(cb) ?? `cb#${i}`;
            const e = prof.get(key); if (e) { e.ms = e.ms * 0.9 + dt * 0.1; e.calls++; } else prof.set(key, { ms: dt, calls: 1 });
          });
        } else {
          for (const cb of this.preRenderCallbacks) {
            if (cb()) needsAnotherFrame = true;
          }
        }
        if (needsAnotherFrame) this.scheduleRender();

        this.ensureLastFrameTex();
        /* When the current visible nodes are sent to beginFrame(), we collect the staged scribbles, highlights,
        and lines into separate arrays. These staged shapes (e.g., an in-progress scribble) are rendered at the end of this render() 
        method so they appear visually on top of all other content.

        The beginFrame() method processes finalized (non-staged) shapes and prepares their corresponding
        IndirectDrawCommandBuffers. These buffers hold indirect draw commands, which allow all finalized shapes
        to be rendered in a single batched call using drawIndexedIndirect() in this render() method — improving performance
        since it is a batched and efficient WebGPU draw call..

        In contrast, staged shapes are not included in these command buffers. Instead, they are drawn manually 
        at the end of this render() method using drawIndexed() from the StrokesStagingBuffer, 
        since their geometry is dynamic and may change every frame.

        Finalized content is rendered first, followed by staged content to ensure proper z-order (staged shapes drawn on top).
        ------------------------------------------------------------------------------------------------------------------------*/
        const stagingContainer: StagingContainer = {
            scribbles: [],
            highlights: [],
            lines: [],  
            patterns: []
        };

        const commandEncoder = this.device.createCommandEncoder();    

        // UI System world-blur (Phase 3): when a modal state requests blur, pre-blur LAST frame's scene grab
        // (scene-only, pre-post-process) in its own encoder — submitted before the main pass, so the scrim can
        // composite it. One-frame lag is invisible for a static world behind a modal.
        this._uiScrimFrame = this._uiScrimProvider?.() ?? null;
        const uiWorldBlur = !!this._uiScrimFrame && this._uiScrimFrame.blur > 0.001;

        // SCENE-COLOUR GRAB (perf audit B1 + B2): only kept up to date while something samples it — SSR (inline trace
        // + deferred resolve), glass refraction (the CD kit) or the modal world blur above. Otherwise no grab copy and
        // the overlays draw at the end of the main pass instead of in their own load/store OverlayPass.
        const grabReaders = uiWorldBlur || this._sceneGrab3DReaders();
        const grabNeeded = grabReaders && !this._captureMode;   // (a capture never copies: it would poison the grab)
        if (grabReaders) this._prepareSceneColorGrab();   // lazy texture + refresh a stale grab from the last frame
        // Register the grab (or none → the 3D renderer's 1×1 default) — the setter dedups; also covers a 3D renderer
        // created after the grab texture.
        this._renderer3D?.setSceneColorGrabTexture(this.sceneColorGrabTex ?? null);
        // RENDER DEBUG directToSwapchain: draw straight into the canvas texture (no lastFrameTex, no copy, no post).
        const rdDirect = RD.on && RD.f.directToSwapchain && !this._captureMode;
        // GRAB PRIMING (perf audit C1): a reader JUST turned on but the grab is stale and lastFrameTex does not hold the
        // last on-screen frame to refresh it from (that frame went straight to the canvas, or a capture came in between).
        // This frame then renders OFFSCREEN without being presented (the canvas keeps showing the last frame), with no
        // modal scrim, and its scene-only grab copy feeds the next frame — which is presented. Only on the rising edge:
        // a resize with a reader already on (grab + lastFrameTex both fresh textures) presents as before, so a resize
        // drag never leaves the canvas without frames.
        const primeGrab = grabNeeded && !this._grabNeededPrev && !this._grabFresh && !rdDirect && !!this.sceneColorGrabTex && !(RD.on && RD.f.noSceneGrab);
        if (primeGrab) this._uiScrimFrame = null;   // (its grab must hold the clean scene, like the refresh source)
        if (!this._captureMode) {
            // A reader just turned on: this frame still samples the refreshed PREVIOUS frame (overlays included) —
            // one follow-up frame lets it see this frame's scene-only grab. (A priming frame always needs its follow-up.)
            if ((grabNeeded && !this._grabNeededPrev) || primeGrab) this.scheduleRender();
            this._grabNeededPrev = grabNeeded;
        }
        if (uiWorldBlur && this.sceneColorGrabTex && !primeGrab) {
            this.prepareUIWorldBlur();
        }

        if (rdCanvasAlphaMode() !== this._contextAlpha) {   // render debug forceOpaqueAlpha toggled: re-configure the canvas
          try { this.context.configure({ device: unwrapDevice(this.device), format: this.swapChainFormat, usage: this._contextUsage(), alphaMode: this._contextAlphaMode() }); }
          catch (e) { console.warn('[Salsa][render-debug] canvas alphaMode change failed', e); this._contextAlpha = rdCanvasAlphaMode(); }
        }
        // PRESENT: an on-screen frame acquires the canvas texture; a capture or a priming frame never touches it (an
        // acquired canvas texture is presented even when nothing is drawn into it).
        const present = !this._captureMode && !primeGrab;
        const backTex: GPUTexture | null = present || rdDirect ? this.context.getCurrentTexture() : null;
        // DIRECT TO THE CANVAS (perf audit C1): draw the frame straight into the canvas texture — no lastFrameTex, no
        // full-screen copy — unless something needs it in lastFrameTex: a snapshot / thumbnail / export hold, the grab
        // copy (a reader), the post chain or FXAA (they sample the frame), or a real screenshot of a canvas texture
        // without COPY_SRC. The canvas texture must take the frame's pipelines (format) and render attachments.
        // (Off: the WebGPURenderer.directPresent kill switch, or render debug noDirectPresent — on a device, no code.)
        const canvasTarget = !!backTex && WebGPURenderer.directPresent && !(RD.on && RD.f.noDirectPresent) && backTex.format === this.swapChainFormat &&
          (typeof backTex.usage !== 'number' || (backTex.usage & GPUTextureUsage.RENDER_ATTACHMENT) !== 0);
        const realShotPending = this._realShotWaiters.length > 0 && present;
        const direct = rdDirect || (present && canvasTarget && this._fullResHold === 0 && !grabNeeded && !this._forceOffscreenNext &&
          !(realShotPending && !this._swapchainCopySrc) && !this._postMayRun());
        this._forceOffscreenNext = false;
        // Overlays in the main pass (no reloading OverlayPass) whenever nothing samples the scene grab (B1); render
        // debug inlineOverlays forces it even with a reader on (the overlays then show in reflections / refraction).
        const inlineOverlays = !grabNeeded || (RD.on && RD.f.inlineOverlays);
        const offscreenView = direct ? backTex!.createView() : this.lastFrameTex!.createView();
        let artboard = this.getArtboardScissor();
        // The main pass renders into lastFrameTex (kept for thumbnails / snapshots / the grab, copied or post-processed
        // to the canvas below) — or, on a direct frame, straight into the canvas texture.
        const renderPassDescriptor: GPURenderPassDescriptor = {
          colorAttachments: [{
            view: offscreenView,
            loadOp: 'clear',
            clearValue:
              // Transparent capture: clear to {0,0,0,0} so the readback has real alpha (see _captureMode).
              this._captureMode?.transparent ? { r: 0, g: 0, b: 0, a: 0 } :
              artboard ? {
                r: this.canvasBackgroundColor[0],
                g: this.canvasBackgroundColor[1],
                b: this.canvasBackgroundColor[2],
                a: this.canvasBackgroundColor[3],
              } :
              {
                  r: this.backgroundColor[0],
                  g: this.backgroundColor[1],
                  b: this.backgroundColor[2],
                  a: this.backgroundColor[3],
              },
            storeOp: 'store',
          }],
          depthStencilAttachment: {
            view: this.interactionService.depthTextureView,
            depthLoadOp: "clear",
            depthStoreOp: "store",
            depthClearValue: 1.0,
            stencilLoadOp: "clear",
            stencilStoreOp: "store",
            stencilClearValue: 0
          }
        };
    
        let passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);   // (let: split for particle bloom)
        
        // Render background
        //this.renderBackground(passEncoder);

        // P4.4 (docs/specs/performance-plan.md): when the 3D workspace backdrop paints an opaque full-canvas background
        // over everything drawn before it (free3D, or a 2D mode on the scene target), the 2D raster layers underneath
        // cannot be seen — skip compositing them (a full-document copy + per-layer blend/dither/grain passes EVERY
        // frame while the 3D scene animates) and the artboard/raster draws. Checked live each frame, so the moment the
        // backdrop goes away (back to the illustration, or a capture that turns it off) the layers composite fresh.
        const hidden2DUnder3D = this.scene3DVisible && !this._captureMode && !!this._renderer3D?.focusBgCoversCanvas();
        // If in raster mode, composite raster layers (if provided) into rasterTexture, then draw
        if (hidden2DUnder3D) {
          // nothing: the 3D backdrop (drawArmatureBg, below) covers the canvas
        } else if (this.renderMode === 'raster' && this.pipelineManager) {
          // Compose layers into the rasterTexture if we have a list
          if (this.rasterCompositionList && this.rasterCompositionList.length > 0) {
            // Ensure raster texture exists
            if (!this.rasterTexture && this.rasterTextureManager) {
              const { w: texW, h: texH } = this.getIllustrationPixelSize();
              this.rasterTexture = this.rasterTextureManager.ensureTexture(texW, texH);
            }
            
            if (this._rasterCompositor && this.rasterTexture) {
              // Pass current animation frame to compositor for procedural displacement
              this._rasterCompositor.currentFrame = this.currentAnimationFrame;
              // E5: no per-layer error-diffusion pass starts while the timeline plays
              this._rasterCompositor.playbackActive = !!this.rasterLayerManager?.getTimeline().isPlaying();
              // Use the new GPU compositor with blend modes, opacity, clipping (E8: reused layer objects)
              const compositorLayers = this._fillCompositorLayers(this.rasterCompositionList, this._compPoolMain, this._compOutMain);
              // Check if any layer or global dither uses error diffusion (requires async WASM)
              const globalDitherCfg = this._rasterCompositor.getDitherConfig();
              const needsAsync = RasterCompositor.needsAsyncComposite(compositorLayers, globalDitherCfg);

              if (needsAsync) {
                this._rasterCompositor.invalidateIncremental('main');
                await this._rasterCompositor.compositeAsync(compositorLayers, this.rasterTexture);
              } else if (this._dirtyCompositingOn() && !this._onionSkinActive()) {
                // BRUSH-5: only what changed (nothing at all on an idle frame). The onion skin draws into this
                // output after the composite, so frames with it on take the full path below.
                this._rasterCompositor.compositeIncremental(compositorLayers, this.rasterTexture, 'main');
              } else {
                this._rasterCompositor.invalidateIncremental('main');
                this._rasterCompositor.composite(compositorLayers, this.rasterTexture);
              }

              // ── Onion skin overlay ──
              // After compositing the current frame, overlay ghost frames for
              // adjacent frames so animators can see surrounding drawings.
              this.applyOnionSkinOverlay();
            } else {
              // Fallback: old ad-hoc composition (no blend modes)
              for (const layer of this.rasterCompositionList) {
                if (!layer.texture) continue;
                const compEnc = this.device.createCommandEncoder();
                const compPass = compEnc.beginRenderPass({ colorAttachments: [{ view: this.rasterTexture!.createView(), loadOp: 'load', storeOp: 'store' }] });
                const layout = this.pipelineManager.getRasterPipeline().getBindGroupLayout(0);
                if (!this.rasterWorldBuf) {
                  this.rasterWorldBuf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                  const idMat = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
                  this.device.queue.writeBuffer(this.rasterWorldBuf, 0, idMat.buffer);
                }
                const bg = this.device.createBindGroup({ layout, entries: [
                  { binding: 0, resource: layer.texture.createView() },
                  { binding: 1, resource: this.pipelineManager.getTexturedSampler() },
                  { binding: 2, resource: { buffer: this.rasterWorldBuf } }
                ]});
                compPass.setPipeline(this.pipelineManager.getRasterPipeline());
                compPass.setBindGroup(0, bg);
                const { vb, ib } = this.getRasterTexturedQuad();
                compPass.setVertexBuffer(0, vb);
                compPass.setIndexBuffer(ib, 'uint16');
                compPass.drawIndexed(6, 1, 0, 0, 0);
                compPass.end();
                this.device.queue.submit([compEnc.finish()]);
              }
            }
          }

          // draw the composed rasterTexture (if present)
          // First draw the artboard pattern under the raster content so transparent areas show the checkerboard.
          // Skipped during a transparent capture — the pattern is an opaque fill that would destroy the alpha.
          if (artboard && !this._captureMode?.transparent) {
            passEncoder.setScissorRect(artboard.x, artboard.y, artboard.w, artboard.h);
            this.renderArtboardPattern(passEncoder);
          }

          // ── Pre-raster vector pass: draw below-raster nodes (panels) ──
          // Panel layouts render underneath raster layers so illustrations
          // are drawn on top of the panel structure.
          {
            this.handleAtlasChangeIfNeeded();
            this.rebuildRenderListIfNeeded();
            // (indexed writes + one final length: `length = 0` then push() dropped and regrew the backing store
            // every frame, and for-of allocated an iterator result per node below TurboFan)
            const belowRasterNodes = this._belowRasterScratch, rl = this.renderList;
            let nb = 0;
            for (let i = 0; i < rl.length; i++) if (rl[i].isRenderBelowRaster()) belowRasterNodes[nb++] = rl[i];
            belowRasterNodes.length = nb;
            if (belowRasterNodes.length > 0) {
              this.webGPURenderStrategy.beginFrame(belowRasterNodes, this.stagingBuffer, stagingContainer);
              this.webGPURenderStrategy.uploadDrawCommands();
              this.webGPURenderStrategy.uploadDrawCounts(this.device);
              this.drawVectorShapes(passEncoder);
            }
          }

          // Apply global canvas grain to the raster texture (paper texture effect).
          // In multi-layer mode the compositor already applies it during composite().
          // In single-layer mode we copy paint → display texture and apply grain there
          // so the live paint data is never modified.
          let rasterTexToRender: GPUTexture | undefined = this.rasterTexture;
          if (this.rasterTexture && this._rasterCompositor && this._rasterPaintEngine &&
              this._rasterPaintEngine.paperGrainManager.getGrainTexture() &&
              !(this.rasterCompositionList && this.rasterCompositionList.length > 0)) {
            const tw = this.rasterTexture.width;
            const th = this.rasterTexture.height;
            // Ensure display texture matches paint texture dimensions
            if (!this.rasterDisplayTex || this.rasterDisplayTexW !== tw || this.rasterDisplayTexH !== th) {
              this.rasterDisplayTex?.destroy();
              this.rasterDisplayTex = this.device.createTexture({
                size: [tw, th],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
                       GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
              });
              this.rasterDisplayTexW = tw;
              this.rasterDisplayTexH = th;
            }
            // Copy paint → display
            const grainCopyEnc = this.device.createCommandEncoder();
            grainCopyEnc.copyTextureToTexture(
              { texture: this.rasterTexture }, { texture: this.rasterDisplayTex! },
              { width: tw, height: th },
            );
            this.device.queue.submit([grainCopyEnc.finish()]);
            // Apply grain to display texture (not the live paint)
            this._rasterCompositor.applyGrainOverlay(this.rasterDisplayTex!, tw, th);
            rasterTexToRender = this.rasterDisplayTex;
          }

          //this.testRasterPipeline();
          if (rasterTexToRender) {
            // ensure world buffer exists
            if (!this.rasterWorldBuf) {
              this.rasterWorldBuf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            }
            // write current world matrix so the raster quad rides with pan/zoom
            const worldMatrix = this.interactionService.getWorldMatrix();
            this.device.queue.writeBuffer(this.rasterWorldBuf, 0, (worldMatrix as Float32Array).buffer);

            const bg = this._rasterQuadBindGroup(false, rasterTexToRender, this.rasterWorldBuf);   // (E8: cached)
            passEncoder.setPipeline(this.pipelineManager.getRasterPipeline());
            passEncoder.setBindGroup(0, bg);

            // Use a world-space quad sized to the artboard (or full world) so the vertex shader
            // position is multiplied by the world matrix (pipeline expects clip pos already transformed),
            // but we provide positions in world space so they get transformed properly.
            if (!this.rasterWorldQuadVB) {
              // Default to covering a 2x2 world area centered at origin (can be artboard-sized in illustration mode)
              let w = 2, h = 2;
              if (this.illustrationMode && this.illustrationBounds) { w = this.illustrationBounds.width; h = this.illustrationBounds.height; }
              console.log(`[WebGPURenderer] rasterWorldQuadVB created: worldW=${w} worldH=${h} illustrationMode=${this.illustrationMode} explicitDocSize=${JSON.stringify(this._explicitDocPixelSize)}`);
              const hw = w/2, hh = h/2;
              const verts = new Float32Array([
                -hw, -hh, 0,1,
                 hw, -hh, 1,1,
                -hw,  hh, 0,0,
                 hw,  hh, 1,0,
              ]);
              this.rasterWorldQuadVB = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
              new Float32Array(this.rasterWorldQuadVB.getMappedRange()).set(verts);
              this.rasterWorldQuadVB.unmap();

              const idx = new Uint16Array([0,1,2, 2,1,3]);
              this.rasterWorldQuadIB = this.device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
              new Uint16Array(this.rasterWorldQuadIB.getMappedRange()).set(idx);
              this.rasterWorldQuadIB.unmap();
            }

            passEncoder.setVertexBuffer(0, this.rasterWorldQuadVB!);
            passEncoder.setIndexBuffer(this.rasterWorldQuadIB!, 'uint16');
            passEncoder.drawIndexed(6, 1, 0, 0, 0);
          }

          // ── Raster text preview overlay ──
          this.drawRasterTextPreview(passEncoder);

          // Draw floating layer (lifted / pasted pixels) during a transform
          if (this._rasterSelectionEngine && this.pipelineManager && this.rasterWorldBuf) {
            const floatTex = this._rasterSelectionEngine.getFloatingTexture();
            const floatBounds = this._rasterSelectionEngine.getFloatingBounds();
            const selInfo = this._rasterSelectionEngine.getSelectionInfo();
            if (floatTex && floatBounds && selInfo.isTransforming && selInfo.transform) {
              const texSize = this.getRasterTextureSize?.() ?? { w: this.canvas.width, h: this.canvas.height };
              let worldQuadW = 2.0, worldQuadH = 2.0;
              if (this.illustrationMode && this.illustrationBounds) {
                worldQuadW = this.illustrationBounds.width;
                worldQuadH = this.illustrationBounds.height;
              }

              const tw = texSize.w || 1;
              const th = texSize.h || 1;
              const hw = worldQuadW / 2;
              const hh = worldQuadH / 2;
              const toWorldX = (tx: number) => (tx / tw) * worldQuadW - hw;
              const toWorldY = (ty: number) => hh - (ty / th) * worldQuadH;

              // Apply transform to bounds
              const t = selInfo.transform;
              const bx = floatBounds.x + t.translateX;
              const by = floatBounds.y + t.translateY;
              const bw = floatBounds.w * t.scaleX;
              const bh = floatBounds.h * t.scaleY;

              const x0 = toWorldX(bx);
              const y0 = toWorldY(by);
              const x1 = toWorldX(bx + bw);
              const y1 = toWorldY(by + bh);

              // Build a quad for the floating texture
              const fVerts = new Float32Array([
                x0, y1, 0, 1,  // bottom-left  → UV(0,1)
                x1, y1, 1, 1,  // bottom-right → UV(1,1)
                x0, y0, 0, 0,  // top-left     → UV(0,0)
                x1, y0, 1, 0,  // top-right    → UV(1,0)
              ]);
              if (!this._floatingQuadVB || this._floatingQuadVB.size < fVerts.byteLength) {
                this._floatingQuadVB?.destroy();
                this._floatingQuadVB = this.device.createBuffer({
                  size: Math.max(fVerts.byteLength, 256),
                  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
              }
              this.device.queue.writeBuffer(this._floatingQuadVB, 0, fVerts);

              if (!this._floatingQuadIB) {
                const idx = new Uint16Array([0,1,2, 2,1,3]);
                this._floatingQuadIB = this.device.createBuffer({
                  size: idx.byteLength,
                  usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                  mappedAtCreation: true,
                });
                new Uint16Array(this._floatingQuadIB.getMappedRange()).set(idx);
                this._floatingQuadIB.unmap();
              }

              const layout = this.pipelineManager.getRasterPipeline().getBindGroupLayout(0);
              const bg = this.device.createBindGroup({ layout, entries: [
                { binding: 0, resource: floatTex.createView() },
                { binding: 1, resource: this.pipelineManager.getTexturedSampler() },
                { binding: 2, resource: { buffer: this.rasterWorldBuf } },
              ]});

              passEncoder.setPipeline(this.pipelineManager.getRasterPipeline());
              passEncoder.setBindGroup(0, bg);
              passEncoder.setVertexBuffer(0, this._floatingQuadVB);
              passEncoder.setIndexBuffer(this._floatingQuadIB, 'uint16');
              passEncoder.drawIndexed(6, 1, 0, 0, 0);
            }
          }
          
          // THEN reset scissor for overlays
          if (artboard) {
            passEncoder.setScissorRect(0, 0, this.canvas.width, this.canvas.height);
          }

          // Draw selection overlay (marching ants + transform handles)
          if (this._selectionOverlayRenderer && this._rasterSelectionEngine && this.rasterWorldBuf) {
            const selInfo = this._rasterSelectionEngine.getSelectionInfo();
            if (selInfo.hasSelection || selInfo.isTransforming || selInfo.dragPreview || selInfo.lassoPoints) {
              const texSize = this.getRasterTextureSize?.() ?? { w: this.canvas.width, h: this.canvas.height };
              let worldQuadW = 2.0;
              let worldQuadH = 2.0;
              if (this.illustrationMode && this.illustrationBounds) {
                worldQuadW = this.illustrationBounds.width;
                worldQuadH = this.illustrationBounds.height;
              }
              const overlayState: SelectionOverlayState = {
                bounds: selInfo.bounds,
                dragPreview: selInfo.dragPreview ?? null,
                isTransforming: selInfo.isTransforming,
                transform: selInfo.transform,
                tool: selInfo.tool,
                lassoPoints: selInfo.lassoPoints,
              };
              this._selectionOverlayRenderer.render(
                passEncoder, overlayState,
                texSize.w, texSize.h,
                worldQuadW, worldQuadH,
                this.rasterWorldBuf,
                this.lastFrameTex!.format,
              );
              // Keep requesting frames so marching ants animate
              this.scheduleRender();
            }
          }

          // (Raster-specific overlays done — fall through to vector drawing
          //  so SDF text, shapes, panels, speech balloons render on top.)
        } else {
          // ── Vector-only mode: draw artboard background ──
          if (artboard) passEncoder.setScissorRect(artboard.x, artboard.y, artboard.w, artboard.h);
          this.renderArtboardPattern(passEncoder);
        }
    
        // --- Indirect Rendering Starts ---
        
        // make sure everything that depends on the atlas is up-to-date
        this.handleAtlasCompactIfNeeded();
        this.handleAtlasChangeIfNeeded();

        this.rebuildRenderListIfNeeded();
        const visibleNodes = this._visibleNodesScratch;
        { const rl = this.renderList; for (let i = 0; i < rl.length; i++) visibleNodes[i] = rl[i]; visibleNodes.length = rl.length; }

        if (this.interactionService.boxSelectPreview) {
            visibleNodes.push(this.interactionService.boxSelectPreview);
        }

        // In text-draw mode, draw a green BORDER around every LiveText node so they're easy to
        // find, + a faint fill on the hovered one. Rectangle geometry is fill-only (no stroke),
        // so the border is composed from 4 thin edge bars (rotation-aware). Pooled, 5 slots/node
        // (4 edges + 1 hover fill). Skip the box being typed and any empty box (transient —
        // auto-cleaned — so it never flashes green as it despawns).
        if (this.interactionService.rectDrawCallback) {
            const ltNodes = this.webGPURenderStrategy.getLiveTextNodes();
            const hoverId = this.interactionService.hoveredLiveTextId;
            const border = { r: 0.3, g: 0.85, b: 0.5, a: 0.85 };
            const baseFill = { r: 0.25, g: 0.8, b: 0.45, a: 0.1 };   // faint fill on every box
            const hoverFill = { r: 0.3, g: 0.9, b: 0.5, a: 0.3 };    // brighter on hover
            const getRect = (slot: number, fill: { r: number; g: number; b: number; a: number }): Rectangle => {
                let r = this._liveTextDrawOverlays[slot];
                if (!r) { r = new Rectangle(0, 0, 1, 1, fill, undefined, 1, this.interactionService); r.isPreview = true; this._liveTextDrawOverlays[slot] = r; }
                return r;
            };
            for (let i = 0; i < ltNodes.length; i++) {
                const n = ltNodes[i];
                if (n.isEditing || !n.text.trim()) continue;
                const w = Math.max(0.001, n.width * (n.scaleX ?? 1));
                const h = Math.max(0.001, n.height * (n.scaleY ?? 1));
                const rot = n.rotation ?? 0, cos = Math.cos(rot), sin = Math.sin(rot);
                const t = (n.worldUnitsPerPixel || 0.001) * 2; // ~2px border
                const base = i * 5;
                const edges: [number, number, number, number][] = [
                    [0, -h / 2, w, t], [0, h / 2, w, t], [-w / 2, 0, t, h], [w / 2, 0, t, h],
                ];
                for (let e = 0; e < 4; e++) {
                    const [ox, oy, ew, eh] = edges[e];
                    const er = getRect(base + e, border);
                    er.x = n.x + (ox * cos - oy * sin);
                    er.y = n.y + (ox * sin + oy * cos);
                    er.scaleX = ew; er.scaleY = eh; er.rotation = rot;
                    er.fillColor = border; er.markDirty();
                    visibleNodes.push(er);
                }
                // Faint fill on every box (the discoverability highlight), brighter on hover.
                const hovered = hoverId != null && n.id === hoverId;
                const fr = getRect(base + 4, baseFill);
                fr.x = n.x; fr.y = n.y; fr.scaleX = w; fr.scaleY = h; fr.rotation = rot;
                fr.fillColor = hovered ? hoverFill : baseFill; fr.markDirty();
                visibleNodes.push(fr);
            }
        }

        // Filter nodes that should render above raster (normal) vs below raster (panels).
        // Nodes with no layerId always render. Nodes on a hidden vector layer are excluded.
        // In mesh-edit focus mode with an opaque background, also hide all layer-bound 2D
        // content (vector layers) so only the mesh + background show — 3D meshes carry no
        // layerId, so they're kept.
        const meshEditHidesContent = this.getRenderer3D()?.meshEditHidesContent() ?? false;
        this._frameMeshEditHides = meshEditHidesContent;
        const aboveRasterNodes = this._aboveRasterScratch;
        let na = 0;
        for (let i = 0; i < visibleNodes.length; i++) { const n = visibleNodes[i]; if (
            !n.isRenderBelowRaster() &&
            (!n.layerId || !this._hiddenVectorLayerIds.has(n.layerId)) &&
            !(meshEditHidesContent && n.layerId)
        ) aboveRasterNodes[na++] = n; }
        aboveRasterNodes.length = na;
        // Below-raster nodes were already rendered in the pre-raster pass above

        this.webGPURenderStrategy.beginFrame(aboveRasterNodes, this.stagingBuffer, stagingContainer);
        this.webGPURenderStrategy.uploadDrawCommands();
        this.webGPURenderStrategy.uploadDrawCounts(this.device);

        // ── 3D Mesh pass (depth-tested, drawn before 2D overlays) ──
        const r3d = this.getRenderer3D();
        // Master 3D visibility gate (the Frogmarks "3D Scene" layer eye icon). When off, the ENTIRE 3D
        // pass is skipped — meshes / grid / gizmos / bones / particles / GP / armature-bg + the lo-res
        // blit — so nothing 3D touches the canvas. Scene state is untouched → toggling back on restores
        // it exactly (no per-object visibility bookkeeping needed).
        if (this.scene3DVisible && !this._captureMode?.skip3D) {
        this._applyResolutionScale(r3d);
        r3d.lodViewHeight = this.canvas.height;   // P9: resolution-aware draw distances follow the CANVAS, not the lo-res target
        const loResSize = r3d.getLoResSize(this.canvas.width, this.canvas.height);

        if (loResSize) {
          const [lrW, lrH] = loResSize;
          // The main `passEncoder` is still open on `commandEncoder`, and WebGPU forbids
          // opening a second render pass on the same encoder. So render the lo-res 3D
          // content on its OWN command encoder and submit it first; the blit below (in the
          // still-open main pass) then samples the finished lo-res texture. Queue ordering
          // guarantees the lo-res submission runs before the main one.
          const loResEncoder = this.device.createCommandEncoder();
          const loResPass = r3d.beginLowResRenderPass(loResEncoder, lrW, lrH);
          // RESOLUTION SCALING: the lo-res depth is upsampled into the main pass below, so the overlays (grid, gizmos,
          // mesh-edit handles) can draw in the full-size overlay pass, crisp. The PS1 look keeps them inline.
          const deferLo = r3d.loResIsDynamic() && r3d.lowResDepthBlitReady();
          r3d.drawArmatureBg(loResPass, lrW, lrH);
          this.draw3DMeshes(loResPass, aboveRasterNodes, lrW, lrH, deferLo);
          this.draw3DParticles(loResPass, aboveRasterNodes, lrW, lrH);
          this.draw3DGp(loResPass, aboveRasterNodes, lrW, lrH);
          loResPass.end();
          if (r3d.particleBloomPending) r3d.runLowResParticleBloom(loResEncoder);   // depth-tested particle bloom
          r3d.endLowResScene(loResEncoder, this.canvas.width, this.canvas.height);   // temporal AA: un-jitter + velocity + resolve
          this.device.queue.submit([loResEncoder.finish()]);
          r3d.blitLowResToPass(passEncoder);
          if (deferLo) {
            r3d.blitLowResDepthToPass(passEncoder);
            r3d.applySceneDepthRange(passEncoder, this.canvas.width, this.canvas.height);   // as the native path leaves it
          }
        } else {
          // Normal full-resolution path.
          r3d.drawArmatureBg(passEncoder, this.canvas.width, this.canvas.height);
          // deferOverlays: gizmos/grid/handles draw in the post-grab overlay pass, so reflections/refraction
          // (which sample the scene-colour grab) never show them. With no grab reader they still defer — to the END
          // of this pass (inlineOverlays), so they stay above particles / GP / 2D content exactly as before.
          this.draw3DMeshes(passEncoder, aboveRasterNodes, this.canvas.width, this.canvas.height, true);
          this.draw3DParticles(passEncoder, aboveRasterNodes);
          this.draw3DGp(passEncoder, aboveRasterNodes);
          if (r3d.particleBloomPending) {
            // PARTICLE BLOOM: its capture depth-tests against this pass's depth, which can't be read while the pass is
            // open — end it, run the bloom (capture / blur / additive composite), and resume with load / load.
            passEncoder.end();
            r3d.runParticleBloom(commandEncoder, offscreenView, this.interactionService.depthTextureView);
            passEncoder = commandEncoder.beginRenderPass({
              label: 'MainPassAfterBloom',
              colorAttachments: [{ view: offscreenView, loadOp: 'load', storeOp: 'store' }],
              depthStencilAttachment: {
                view: this.interactionService.depthTextureView,
                depthLoadOp: 'load', depthStoreOp: 'store', stencilLoadOp: 'load', stencilStoreOp: 'store',
              },
            });
            // Restore the state the rest of the main pass inherited: the scene depth range, and the artboard scissor
            // the vector-only branch above set (the raster branch left the full canvas).
            r3d.applySceneDepthRange(passEncoder, this.canvas.width, this.canvas.height);
            if (artboard && !hidden2DUnder3D && !(this.renderMode === 'raster' && this.pipelineManager)) {
              passEncoder.setScissorRect(artboard.x, artboard.y, artboard.w, artboard.h);
            }
          }
        }
        } // end scene3DVisible gate

        // ── Foreground raster pass (layers above the 3D divider) ──
        // Skipped while an opaque mesh-edit focus background is up, so foreground
        // illustration layers don't draw over the clean mesh-editing workspace.
        if (this.renderMode === 'raster' && this.rasterForegroundList && this.rasterForegroundList.length > 0 &&
            this._rasterCompositor && this.pipelineManager && !r3d?.meshEditHidesContent()) {
          const { w: texW, h: texH } = this.getIllustrationPixelSize();
          // Ensure foreground composite texture
          if (!this.rasterTextureFG || this.rasterTextureFG.width !== texW || this.rasterTextureFG.height !== texH) {
            this.rasterTextureFG?.destroy();
            this.rasterTextureFG = this.device.createTexture({
              size: [texW, texH], format: 'rgba8unorm',
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
                     GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
            });
          }
          const fgLayers = this._fillCompositorLayers(this.rasterForegroundList, this._compPoolFG, this._compOutFG);   // (E8: reused)
          if (fgLayers.length > 0) {
            this._rasterCompositor.currentFrame = this.currentAnimationFrame;
            this._rasterCompositor.playbackActive = !!this.rasterLayerManager?.getTimeline().isPlaying();
            const globalDitherCfg = this._rasterCompositor.getDitherConfig();
            const needsAsync = RasterCompositor.needsAsyncComposite(fgLayers, globalDitherCfg);
            if (needsAsync) {
              this._rasterCompositor.invalidateIncremental('fg');
              await this._rasterCompositor.compositeAsync(fgLayers, this.rasterTextureFG);
            } else if (this._dirtyCompositingOn()) {
              this._rasterCompositor.compositeIncremental(fgLayers, this.rasterTextureFG, 'fg');   // BRUSH-5
            } else {
              this._rasterCompositor.invalidateIncremental('fg');
              this._rasterCompositor.composite(fgLayers, this.rasterTextureFG);
            }
            // Draw the FG raster quad (same pipeline, same world transform, separate texture)
            if (this.rasterWorldQuadVB && this.rasterWorldQuadIB && this.rasterWorldBuf) {
              const fgBg = this._rasterQuadBindGroup(true, this.rasterTextureFG, this.rasterWorldBuf);   // (E8: cached)
              passEncoder.setPipeline(this.pipelineManager.getRasterPipeline());
              passEncoder.setBindGroup(0, fgBg);
              passEncoder.setVertexBuffer(0, this.rasterWorldQuadVB);
              passEncoder.setIndexBuffer(this.rasterWorldQuadIB, 'uint16');
              passEncoder.drawIndexed(6, 1, 0, 0, 0);
            }
          }
        }

        // Raster composites (main + foreground) are submitted: run the post-composite hooks (BRUSH-4 prediction
        // takes its provisional tail back out of the layer here).
        if (this.postRasterCompositeCallbacks.length > 0) {
          for (const cb of [...this.postRasterCompositeCallbacks]) {
            try { cb(); } catch (e) { console.warn('post-raster-composite callback failed', e); }
          }
        }

        // UI System modal DIM: darken the world (raster + 3D) BEFORE the UI's own vector shapes, so a pause/modal
        // state dims the scene while the menu drawn just below stays crisp. No-op unless a modal state is active.
        this.renderUIScrim(passEncoder);

        // Draw all above-raster vector shapes (everything except panels)
        this.drawVectorShapes(passEncoder);
    
        // ONE reset for all three categories — they append into the same staging buffers, so per-category
        // resets would overwrite geometry whose draws are already recorded.
        this.stagingBuffer.beginStagingPass();
        this.renderStagingShapes(passEncoder, stagingContainer.scribbles, this.pipelineManager!.getStagingLinePipeline(), s => this.stagingBuffer.appendStroke(s as Scribble));
        this.renderStagingShapes(passEncoder, stagingContainer.lines, this.pipelineManager!.getStagingLinePipeline(), l => this.stagingBuffer.appendLine(l as Line));
        this.renderStagingShapes(passEncoder, stagingContainer.highlights, this.pipelineManager!.getStagingHighlightPipeline(), h => this.stagingBuffer.appendStroke(h as HighlightShape));

        // Reset scissor to full canvas for overlays
        if (artboard) passEncoder.setScissorRect(0, 0, this.canvas.width, this.canvas.height);

        if (this.webGPURenderStrategy.getTexturedCount() > 0) {
          // 1) Build the bind group ONCE per frame with the RIGHT LAYOUT:
          this.bindGroupManager.setTexturedBindGroup(
            this.pipelineManager!.getTexturedPipeline().getBindGroupLayout(0),  // <-- layout
            this.webGPURenderStrategy.getTexturedInstanceBuffer().getBuffer(), // <-- storage buffer
            this.cacheService!.textureArrayAtlas.getView(),                     // <-- texture_2d_array view
            this.pipelineManager!.getTexturedSampler()                          // <-- sampler
          );

          // 2) Draw
          passEncoder.setPipeline(this.pipelineManager!.getTexturedPipeline());
          passEncoder.setBindGroup(0, this.bindGroupManager.sharedTexturedBindGroup);
          const { vb, ib } = this.getTexturedQuad(); // or your unit-quad VB/IB
          passEncoder.setVertexBuffer(0, vb);
          passEncoder.setIndexBuffer(ib, 'uint16');
          passEncoder.drawIndexed(6, this.webGPURenderStrategy.getTexturedCount(), 0, 0, 0);
        }

        // ── LiveTextNode overlays ──
        this.driveLiveTextHtml(); // HTML-in-Canvas: onpaint capture + requestPaint + overlay sync
        this.drawLiveTextNodes(passEncoder);

        // Editing-only overlays (selection highlights, connection-port dots, carets, the 2D grid) are UI aids, not
        // content — skip them all during a capture so exports/previews show just the artwork.
        if (inlineOverlays) {
          // The overlay set in THIS pass, last (same order as the OverlayPass), so no second pass loads the targets.
          // Reset the state a fresh pass would start with (the earlier draws may have changed it).
          passEncoder.setViewport(0, 0, this.canvas.width, this.canvas.height, 0, 1);
          passEncoder.setScissorRect(0, 0, this.canvas.width, this.canvas.height);
          passEncoder.setStencilReference(0);
          this._drawOverlaySet(passEncoder, visibleNodes);
        }
        passEncoder.end();

        // -- SSR / glass-refraction / modal-blur grab: SCENE ONLY --
        // Copied BEFORE the overlay pass below, so gizmos / grids / selection UI / carets never appear in
        // reflections or refraction. Also PRE-post-process now: a reflection that baked in vignette/bloom
        // darkened its corners with the screen's grade -- the raw scene image is the correct source.
        // Only while a reader is on (grabNeeded — never in a capture: it is transparent/no-3D and would poison the
        // next frame).
        if (grabNeeded && this.sceneColorGrabTex && !(RD.on && (RD.f.noSceneGrab || RD.f.directToSwapchain))) {
          commandEncoder.copyTextureToTexture(
            { texture: this.lastFrameTex! },
            { texture: this.sceneColorGrabTex },
            { width: this.canvas.width, height: this.canvas.height, depthOrArrayLayers: 1 }
          );
          this._grabFresh = true;
          // SSR SETTLING: reflections sample the PREVIOUS frame's grab. On this render-on-demand loop, the last
          // frame of an interaction would otherwise freeze on screen showing a reflection of the SECOND-TO-LAST
          // (mid-orbit) frame -- and, recursively, the chain of frames before it (a trail of stale ghost copies
          // that persists at rest). Schedule exactly ONE follow-up frame so the grab converges to the settled
          // view; the follow-up itself doesn't re-schedule, so each burst ends with a single settle frame.
          if (this._renderer3D?.ssrEnabled && !this._ssrSettleFrame) {
            this._ssrSettleFrame = true;
            this.scheduleRender();
          } else {
            this._ssrSettleFrame = false;
          }
        } else if (!this._captureMode) {
          this._grabFresh = false;   // the grab no longer holds the latest frame (refreshed when a reader turns on)
          this._ssrSettleFrame = false;
        }

        // -- Overlay pass (EXCLUDED from the grab): 3D gizmos/grid/handles + 2D selection UI --
        // Same colour/depth targets with load/load -- the on-screen result is identical to drawing these in
        // the main pass; only the grab above no longer sees them. Only while the grab is copied (else inline, above).
        if (!inlineOverlays) {
          const overlayPass = commandEncoder.beginRenderPass({
            label: 'OverlayPass',
            // (load / load / load; render debug clearColorLoads / clearDepthStencilLoads turn them into clears)
            colorAttachments: [{ view: offscreenView, loadOp: rdColorLoad(), storeOp: 'store' }],
            depthStencilAttachment: {
              view: this.interactionService.depthTextureView,
              depthClearValue: 1.0, depthLoadOp: rdDepthLoad(), depthStoreOp: 'store',
              stencilLoadOp: rdDepthLoad(), stencilStoreOp: 'store',
            },
          });
          this._drawOverlaySet(overlayPass, visibleNodes);
          overlayPass.end();
        }

        // Run scene post-processing (FXAA / bloom / color grade / vignette / film) if any effects are active: a
        // processed output texture (copied to the canvas), 'target' (perf audit C2: the LAST pass rendered straight
        // into the canvas texture — no copy), or null when nothing ran (lastFrameTex is copied as is).
        // A direct frame is already in the canvas texture, which cannot be sampled: no post (postProcessMayRun said
        // none would run; a misprediction gets one offscreen re-render). A priming frame is never shown: no post.
        const W = this.canvas.width, H = this.canvas.height;
        let ppOutput: GPUTexture | null = null, ppInCanvas = false;
        if (direct || primeGrab) {
          if (this._renderer3D?.skipPostProcess(W, H) && direct && !rdDirect) { this._forceOffscreenNext = true; this.scheduleRender(); }
        } else if (this._renderer3D) {
          // Into the canvas unless the frame is not presented, or a real screenshot has to read the post output
          // (a canvas texture without COPY_SRC).
          const toCanvas = present && canvasTarget && !(realShotPending && (typeof backTex!.usage === 'number' && (backTex!.usage & GPUTextureUsage.COPY_SRC) === 0));
          if (toCanvas) {
            const r = this._renderer3D.runPostProcessTo(commandEncoder, this.lastFrameTex!, W, H, backTex!.createView());
            if (r === 'target') ppInCanvas = true; else ppOutput = r;
          } else {
            ppOutput = this._renderer3D.runPostProcess(commandEncoder, this.lastFrameTex!, W, H);
          }
        }

        // Present an offscreen frame: copy the post output (or lastFrameTex) to the canvas — unless the post chain
        // already drew into it. lastFrameTex is always preserved unchanged for thumbnail snapshots.
        // A capture renders into lastFrameTex only (for readback) and must NOT present, so the on-screen frame
        // is left untouched (no flicker) — the caller re-renders normally afterwards. Nor does a priming frame.
        if (present && !direct) {
          if (!ppInCanvas) {
            commandEncoder.copyTextureToTexture(
              { texture: ppOutput ?? this.lastFrameTex! },
              { texture: backTex! },
              { width: W, height: H, depthOrArrayLayers: 1 }
            );
          }
          // A focus background (armature / mesh edit) is editor UI: put its unprocessed pixels back so the scene's
          // post effects don't grade it (a light pattern used to wash out to white). Before drawPostOverlays, which
          // clears the depth this reads.
          // (Skipped in the lo-res PS1 mode: its 3D depth lives in the lo-res target, so the main depth is empty and
          // the whole frame would lose its post look.)
          if ((ppOutput || ppInCanvas) && this._renderer3D && (!this._renderer3D.getLoResSize(W, H) || this._renderer3D.loResIsDynamic())) this._renderer3D.restoreFocusBgAfterPost(commandEncoder, this.lastFrameTex!, backTex!.createView(), this.interactionService.depthTextureView);
        }

        // POST-PROCESS-IMMUNE overlays (the landmark info card): drawn directly onto the FINAL swapchain image,
        // AFTER post-processing and the copy — so the card bypasses bloom / colour-grade / vignette and reads the
        // same day & night. lastFrameTex stays untouched (thumbnails don't capture the transient hover card).
        if (backTex && this._renderer3D?.hasPostOverlays()) {
          this._renderer3D.drawPostOverlays(commandEncoder, backTex.createView(), this.interactionService.depthTextureView);
        }

        // UI KIT overlay: last, on the swapchain at native size (post-process immune; skipped in captures).
        let uiKitMore = false;
        if (this._uiKitDrawer && present) {
          try {
            uiKitMore = this._uiKitDrawer(this.device, commandEncoder, backTex!.createView(), this.canvas.width, this.canvas.height,
              this.swapChainFormat, this.canvas.width / Math.max(1, this.canvas.clientWidth || this.canvas.width), this.deviceGeneration);
          } catch (e) { console.warn('[ui-kit] overlay draw failed', e); }
        }

        // RENDER DEBUG real screenshot (captureRealFrame): read back the finished canvas texture in this encoder.
        const realShot = realShotPending
          ? this._encodeRealShot(commandEncoder, backTex!, ppOutput ?? this.lastFrameTex!, direct || ppInCanvas) : null;
        this.device.queue.submit([commandEncoder.finish()]);
        // lastFrameTex now holds an on-screen frame (a stale-grab refresh may copy it) — not after a capture (its
        // transparent / no-3D image) or a direct frame (lastFrameTex untouched).
        this._lastFrameLive = !this._captureMode && !direct;
        this._submittedDirect = direct;
        if (realShot) void this._finishRealShot(realShot);
        if (uiKitMore) this.scheduleRender();
        this._gpuTimer?.endFrame();   // resolution scaling: resolve this frame's GPU timestamps
        this._renderer3D?.noteCullCpuMs(performance.now() - _cull0);   // GPU culling auto mode (performance-plan §P15)
        this._submittedScaled = this._frameScaled;
        if (prof) { const fp = this._frameProfile, d = performance.now() - _r0; fp.renderMs = fp.renderMs ? fp.renderMs * 0.9 + d * 0.1 : d; }   // whole frame CPU (callbacks + encode)

        // Tell anyone waiting that a frame was submitted (for thumbnails)
        this.notifyFrameSubmitted();
        if (!this._captureMode && this.scene3DVisible) this._temporalSettle();   // temporal AA: converge after the view stops

        if(this.cacheService!.getSdfAtlas().version !== this.cachedAtlasVersion) {
          this.cacheService!.getSdfAtlas().sweepRetired();
          this.cacheService!.getSdfAtlas().glyphCompute.sweepComputeTemps(this.device.queue);
        }
    }

    /**
     * Issue GPU draw calls for whatever vector shapes were loaded
     * into the render strategy in the most recent beginFrame() call.
     * Used by both the pre-raster (panels) and post-raster (normal) passes.
     */

    // ── 3D Mesh rendering ─────────────────────────────────────────

    /**
     * Draw Mesh3D nodes from the visible node list (draw3DMeshes, below the render-debug helpers).
     * Initializes Renderer3D lazily on first use.
     */

    /** The overlay set (EXCLUDED from the scene-colour grab): the deferred 3D overlays, then the 2D selection UI
     *  (selection highlights, connection-port dots, carets, the 2D grid; not during a capture). Normally drawn in the
     *  OverlayPass; render debug inlineOverlays draws it at the end of the main pass instead. */
    private _drawOverlaySet(pass: GPURenderPassEncoder, visibleNodes: Node[]): void {
          if (this._overlays3DPending) {
            this._overlays3DPending = false;
            this.draw3DOverlays(pass);
          }
          if (!this._captureMode) {
          // ── Selection highlight overlay (behind carets) ──
          const selHighlights = this.webGPURenderStrategy.collectSelectionHighlights(visibleNodes);
          this.selectionHighlightManager.update(selHighlights);
          this.drawSelectionHighlightInstances(pass);

          // ── Connection-port indicator dots ──
          this.updateConnectionPortDots();
          this.drawOverlayDotInstances(pass);

          // Aggregate carets
          const carets = this.webGPURenderStrategy.collectActiveCarets(visibleNodes);
          this.caretManager.update(carets);

          // Draw the caret instances
          this.drawCaretInstances(pass);

          // 2D canvas grid — drawn LAST so it sits above raster/vector/3D (user-requested layering).
          this.renderGridOverlay(pass);
          }
    }

    // ── RENDER DEBUG: the real screenshot (docs/ui/gpu-diagnostics.md "Render debug") ──
    /** The canvas context also carries COPY_SRC (set by the first captureRealFrame; kept for the session). */
    private _swapchainCopySrc = false;
    private _realShotWaiters: { resolve: (r: RealFrameReadback) => void; reject: (e: unknown) => void }[] = [];
    /** The canvas alpha mode in force ('premultiplied'; render debug forceOpaqueAlpha = 'opaque'). render() re-configures
     *  the context when the flag changes. */
    private _contextAlpha: GPUCanvasAlphaMode = 'premultiplied';
    private _contextAlphaMode(): GPUCanvasAlphaMode { return (this._contextAlpha = rdCanvasAlphaMode()); }
    /** The canvas context usage: RENDER_ATTACHMENT | COPY_DST (+ COPY_SRC once a real screenshot was asked for). */
    private _contextUsage(): number {
        return GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | (this._swapchainCopySrc ? GPUTextureUsage.COPY_SRC : 0);
    }
    /**
     * Read back what the renderer actually produced: the next frame's CANVAS (swap-chain) texture, copied at the end
     * of that frame's command encoder, after every pass that writes it (main + overlay passes, post copy, focus-bg
     * restore, info card, UI kit), right before it is handed to the browser to present. The first call reconfigures
     * the canvas context with COPY_SRC (kept for the session). When the canvas texture cannot be copied (the context
     * was reconfigured without COPY_SRC by a foreign owner), the source the frame copied to the canvas is read instead
     * (the source field says which). Rejects after 5 s without a frame.
     */
    public captureRealFrame(): Promise<RealFrameReadback> {
        if (!this.device || !this.context) return Promise.reject(new Error('the renderer has no GPU device yet'));
        if (!this._swapchainCopySrc) {
            this._swapchainCopySrc = true;
            try {
                this.context.configure({ device: unwrapDevice(this.device), format: this.swapChainFormat, usage: this._contextUsage(), alphaMode: this._contextAlphaMode() });
            } catch (e) {
                this._swapchainCopySrc = false;
                console.warn('[Salsa][render-debug] could not add COPY_SRC to the canvas context; reading the pre-present frame', e);
            }
        }
        return new Promise<RealFrameReadback>((resolve, reject) => {
            const w = { resolve: (r: RealFrameReadback) => { clearTimeout(t); resolve(r); }, reject: (e: unknown) => { clearTimeout(t); reject(e); } };
            const t = setTimeout(() => {
                const i = this._realShotWaiters.indexOf(w);
                if (i >= 0) this._realShotWaiters.splice(i, 1);
                reject(new Error('no frame was rendered within 5 s (renderer suspended or device lost?)'));
            }, 5000);
            this._realShotWaiters.push(w);
            this.scheduleRender();
        });
    }
    public getRenderDebugStatus(): RenderDebugStatus {
        const r3 = this._renderer3D, w = this.canvas?.width ?? 0, h = this.canvas?.height ?? 0;
        const res = this.getResolutionScale();
        const lo = r3 && w > 0 && h > 0 ? r3.getLoResSize(w, h) : null;
        return {
            resolutionScale: res.current, resolutionMode: res.mode,
            loResPath: lo && r3 ? { width: lo[0], height: lo[1], dynamic: r3.loResIsDynamic() } : null,
            temporalAA: !!r3?.temporalActive, msaaSampleCount: 1, canvas: { width: w, height: h },
            swapChainFormat: this.swapChainFormat, canvasAlphaMode: this._contextAlpha, canvasCopySrc: this._swapchainCopySrc,
        };
    }
    private _encodeRealShot(enc: GPUCommandEncoder, backTex: GPUTexture, presentedSrc: GPUTexture, direct: boolean): RealShotPending | null {
        const waiters = this._realShotWaiters; this._realShotWaiters = [];
        try {
            const canCopyCanvas = typeof backTex.usage === 'number' && (backTex.usage & GPUTextureUsage.COPY_SRC) !== 0;
            if (!canCopyCanvas && direct) throw new Error('the canvas texture has no COPY_SRC and directToSwapchain bypasses lastFrameTex');
            const src = canCopyCanvas ? backTex : presentedSrc;
            const source: RealFrameReadback['source'] = canCopyCanvas ? 'swapchain' : presentedSrc === this.lastFrameTex ? 'lastFrameTex' : 'postProcessOutput';
            const w = src.width, h = src.height, padded = Math.ceil(w * 4 / 256) * 256;
            const buf = this.device.createBuffer({ size: padded * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'RealScreenshot' });
            enc.copyTextureToBuffer({ texture: src }, { buffer: buf, bytesPerRow: padded, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
            return { buf, w, h, padded, format: src.format, source, waiters };
        } catch (e) {
            for (const x of waiters) x.reject(e);
            return null;
        }
    }
    private async _finishRealShot(p: RealShotPending): Promise<void> {
        try {
            await p.buf.mapAsync(GPUMapMode.READ);
            const out = readbackToRgba(new Uint8Array(p.buf.getMappedRange()), p.w, p.h, p.padded, p.format);   // B/R swapped only for BGRA
            p.buf.unmap(); p.buf.destroy();
            const r: RealFrameReadback = { rgba: out, width: p.w, height: p.h, format: p.format, source: p.source };
            for (const x of p.waiters) x.resolve(r);
        } catch (e) {
            try { p.buf.destroy(); } catch { /* already gone */ }
            for (const x of p.waiters) x.reject(e);
        }
    }

    private draw3DMeshes(passEncoder: GPURenderPassEncoder, nodes: Node[], w = this.canvas.width, h = this.canvas.height, deferOverlays = false): void {
      // Reused scratch (no per-frame array allocation) — see field docs.
      // P9: indexed writes + one final length (no iterator results; the backing stores are kept across frames)
      const allMeshes = this._allMeshesScratch;
      const regularMeshes = this._regularMeshesScratch;
      const skinnedMeshes = this._skinnedMeshesScratch;
      let nm = 0, nr = 0, ns = 0;
      if (this._rlSplit) {
        // Step 2: the cached 3D mesh list (render-list order) + this frame's visible / layer / below-raster filter —
        // the same set and order the old instanceof scan of the whole frame list produced, without touching 2D nodes.
        const src = this._rl3DMeshes, sk = this._rl3DSkinned, hidden = this._hiddenVectorLayerIds;
        const hides = this._frameMeshEditHides, below = this._rlIndex.any3DBelowRaster, plain = hidden.size === 0 && !hides && !below;
        for (let i = 0; i < src.length; i++) {
          const m = src[i];
          if (!m.visible || (!plain && !this._keep3D(m, hidden, hides, below))) continue;
          allMeshes[nm++] = m;
          if (sk[i]) skinnedMeshes[ns++] = m as SkinnedMesh3D; else regularMeshes[nr++] = m;
        }
      } else {
        for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (n instanceof Mesh3D && n.visible) allMeshes[nm++] = n; }
      }
      allMeshes.length = nm;

      // Lazy-init the 3D renderer — needed even for a ghost-only preview (no committed meshes).
      if (!this._renderer3D) {
        const cam = new Camera3D({ position: [0, 0, 3], target: [0, 0, 0], autoNear: true });   // near tracks orbit distance (docs/specs/depth-precision.md)
        this._renderer3D = new Renderer3D(this.device, cam, this.swapChainFormat);
        this._renderer3D.onDeferredWork = () => this.scheduleRender();   // P4.3: budgeted re-dress continues next frame
      }
      // P1.1: under ortho, every depth-tested 3D draw in this pass (meshes, skinned, particles, GP, artboard, inline
      // overlays) stores depth in [1/3, 1] instead of [0, 1] — see Renderer3D.orthoDepthRemap. No-op in perspective.
      this._renderer3D.applySceneDepthRange(passEncoder, w, h);

      if (allMeshes.length === 0) {
        // No committed meshes → no info card either; drop any stale overlay so it can't reference dead slots.
        this._renderer3D.clearPostOverlays();
        // Stats fix (performance-plan §P15): zero the frame counters + drop the GPU-driven records (else the last
        // static frame's numbers and records stayed forever), and let the skinned path see its roster go empty.
        this._renderer3D.noStaticMeshesThisFrame();
        if (this._renderer3D.skinnedLastCount > 0) this._renderer3D.drawSkinnedMeshes(passEncoder, [], w, h);
        this._renderer3D.drawArtboardTextureIfActive(passEncoder); // the 2D illustration on the artboard plane (CONTENT — stays in the grab)
        if (deferOverlays) { this._overlays3DPending = true; }
        else { this.draw3DOverlays(passEncoder, w, h); }
        return;
      }

      // Split into single-material vs skinned in ONE pass (was two more .filter allocations per frame).
      // (Step 2: the split list already did this while filtering.)
      if (!this._rlSplit) {
        for (let i = 0; i < allMeshes.length; i++) {
          const m = allMeshes[i];
          if (m instanceof SkinnedMesh3D) skinnedMeshes[ns++] = m;
          else regularMeshes[nr++] = m;
        }
      }
      regularMeshes.length = nr; skinnedMeshes.length = ns;

      // The selection box + transform gizmo filter from this (so skinned meshes get one too).
      this._renderer3D.setSelectableMeshes(allMeshes);

      const regularDrew = regularMeshes.length > 0;
      if (regularDrew) {
        this._renderer3D.drawMeshes(passEncoder, regularMeshes, w, h);   // (re)captures always-on-top overlays
      } else {
        this._renderer3D.clearPostOverlays();   // no regular meshes → drawMeshes didn't run → no valid card this frame
        this._renderer3D.noStaticMeshesThisFrame();   // ...so zero its frame counters + drop the GPU-driven records (§P15 stats fix)
      }
      // (an empty roster after a frame with characters still runs once: their stats / shadow / replay list clear)
      if (skinnedMeshes.length > 0 || this._renderer3D.skinnedLastCount > 0) {
        // P1: if drawMeshes just ran, it already uploaded identical scene uniforms this frame → don't repeat the work.
        this._renderer3D.drawSkinnedMeshes(passEncoder, skinnedMeshes, w, h, !regularDrew);
      }
      this._renderer3D.drawArtboardTextureIfActive(passEncoder); // the 2D illustration on the artboard plane (CONTENT — stays in the grab)
      // Overlays (ghost/grid/frames/gizmos/bones/handles/snap-viz): drawn inline for the lo-res path, but
      // DEFERRED to the post-grab overlay pass for the full-res path — the SSR/refraction grab must not see them.
      if (deferOverlays) { this._overlays3DPending = true; }
      else { this.draw3DOverlays(passEncoder, w, h); }
    }

    /** The 3D overlay set — everything that sits ON TOP of scene content but is NOT scene content: ghost
     *  preview, reference grid, artboard/camera frames, selection gizmo, bones, mesh-edit handles, snap viz.
     *  Runs either inline (lo-res armature path) or in the dedicated post-grab overlay pass (full-res path),
     *  with the main pass's depth buffer loaded so depth-tested overlays (grid) still occlude correctly. */
    private draw3DOverlays(passEncoder: GPURenderPassEncoder, w = this.canvas.width, h = this.canvas.height): void {
      if (!this._renderer3D) return;
      // P1.1: the overlay pass depth-tests against the scene depth the main pass stored — same depth range (no-op in
      // perspective; harmless when this runs inline in the main pass, which already set it).
      this._renderer3D.applySceneDepthRange(passEncoder, w, h);
      // Ghost preview over the committed meshes (works even when all meshes are skinned).
      this._renderer3D.drawGhostPreviewIfActive(passEncoder, w, h);
      // Ground reference grid — depth-occluded by meshes (the depth buffer is loaded in the overlay pass).
      this._renderer3D.drawGridIfActive(passEncoder);
      const rdNoGizmo = RD.on && RD.f.noGizmo;   // render debug: no gizmo / selection box / editor frames
      if (!rdNoGizmo) this._renderer3D.drawArtboardFrameIfActive(passEncoder);   // illustration × free3D render frame
      // Play mode (Round 8): none of the editor affordances below are drawn (selection box / gizmo / bone overlay /
      // mesh-edit handles / snap viz / camera frustum / emitter icons) — it's a game view.
      if (this.interactionService.playActive) return;
      if (!rdNoGizmo) {
      this._renderer3D.drawCameraFrustumIfActive(passEncoder);   // selected camera-node frustum
      // Particle-emitter icons (editor affordance — hidden while a creator/Player mode owns input).
      if (!this.interactionService.suppressBoxSelect) this._renderer3D.drawEmitterIconsIfActive(passEncoder, h);
      // Selection box + transform gizmo (regular OR skinned selection).
      this._renderer3D.drawSelectionGizmoIfActive(passEncoder, w, h);
      // Bone overlay (dim + gizmo) — always on top.
      this._renderer3D.drawBoneOverlayIfActive(passEncoder, w, h);
      }
      // Mesh-edit 'dim' focus overlay, then the edit handles on top of the dim.
      this._renderer3D.drawMeshEditDimIfActive(passEncoder, w, h);
      this._renderer3D.drawMeshEditOverlayIfActive(passEncoder, h);
      // Vertex-snap double-circle viz — last (depth-always).
      if (!rdNoGizmo) this._renderer3D.drawSnapVizIfActive(passEncoder, h);
    }

    private draw3DParticles(passEncoder: GPURenderPassEncoder, nodes: Node[], w = this.canvas.width, h = this.canvas.height): void {
      if (!this._renderer3D) return;
      const emitters = this._emittersScratch; emitters.length = 0;
      if (this._rlSplit) {
        const src = this._rl3DEmitters, hidden = this._hiddenVectorLayerIds, hides = this._frameMeshEditHides, below = this._rlIndex.any3DBelowRaster;
        for (let i = 0; i < src.length; i++) { const n = src[i]; if (n.visible && this._keep3D(n, hidden, hides, below)) emitters.push(n); }
      } else {
        for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (n instanceof ParticleEmitter3D && n.visible) emitters.push(n); }
      }
      // Stash for the overlay pass BEFORE the empty early-return: the emitter ICONS + the selection
      // gizmo need the node list even when an emitter currently has zero live particles.
      this._renderer3D.setFrameEmitters(emitters);
      if (emitters.length > 0) this._renderer3D.drawParticles(passEncoder, emitters, w, h);
      // Runtime-only sources (the Play landing dust): registered only while alive, so idle = one length check.
      if (this._renderer3D.hasTransientParticles) this._renderer3D.drawTransientParticles(passEncoder);
    }

    private draw3DGp(passEncoder: GPURenderPassEncoder, nodes: Node[], w = this.canvas.width, h = this.canvas.height): void {
      const gpObjs = this._gpObjsScratch; gpObjs.length = 0;
      if (this._rlSplit) {
        const src = this._rl3DGp, hidden = this._hiddenVectorLayerIds, hides = this._frameMeshEditHides, below = this._rlIndex.any3DBelowRaster;
        for (let i = 0; i < src.length; i++) { const n = src[i]; if (n.visible && this._keep3D(n as unknown as Node, hidden, hides, below)) gpObjs.push(n); }
      } else {
        for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (n instanceof GpObject3D && n.visible) gpObjs.push(n as unknown as GpObject3D); }
      }
      gpObjs.sort((a, b) => a.renderOrder - b.renderOrder);   // in-place sort on the reused array
      const hasOverlay = this._gpDrawOverlay !== null;
      if (gpObjs.length === 0 && !hasOverlay) return;

      if (!this._gpRenderer3D) {
        this._gpRenderer3D = new GpRenderer3D(this.device, this.swapChainFormat);
      }

      const camera = this.getRenderer3D().getCamera();

      if (gpObjs.length > 0) {
        // Build skeleton map from scene graph (Skeleton3D nodes are not in the render list
        // since they extend Node, not Shape — traverse scene root directly).
        // Step 2: the structure walk already collected every Skeleton3D (same nodes, same preorder) — keyed once per
        // walk instead of a forEachDeep of the whole graph every frame. A stroke bound to a skeleton the map doesn't
        // hold (an id changed, or a skeleton attached without a structure notification) falls back to the full walk.
        let skeletons = this._rlSkeletonMap;
        if (!skeletons || this._rlSkeletonMapVer !== this._rlIndex.version) {
          skeletons = this._rlSkeletonMap = new Map<string, Skeleton3D>();
          for (const s of this._rlIndex.skeletons as unknown as Skeleton3D[]) skeletons.set(s.id, s);
          this._rlSkeletonMapVer = this._rlIndex.version;
        }
        let miss = false;
        for (let i = 0; i < gpObjs.length && !miss; i++) { const id = gpObjs[i].skeletonId; if (id && !skeletons.has(id)) miss = true; }
        if (miss) {
          skeletons = new Map<string, Skeleton3D>();
          const all = skeletons;
          this.sceneGraph.root.forEachDeep(n => {
            if (n instanceof Skeleton3D) all.set(n.id, n);
          });
        }
        // The animation timeline's frame picks each layer's keyframe (GpObject3D.getActiveStrokesAllLayers). It read
        // interactionService.currentFrame, which doesn't exist → always frame 0, so a keyframe never showed.
        const frame = this.rasterLayerManager?.getTimeline?.()?.getCurrentFrame?.() ?? 0;
        this._gpRenderer3D.draw(gpObjs, skeletons, camera, passEncoder, w, h, frame);
      }

      if (hasOverlay) {
        this._gpRenderer3D.drawOverlay(this._gpDrawOverlay, camera, passEncoder, w, h);
      }
    }

    /**
     * Get the 3D renderer (creates if not yet initialized).
     * External code (e.g. ShapeManager) can use this to configure PS1 settings,
     * camera, lights, etc.
     */
    /** Called by Scene3DManager to push face-hover / draw-plane overlay data for the next frame. */
    public setGpDrawOverlay(data: typeof this._gpDrawOverlay): void {
      this._gpDrawOverlay = data;
    }

    public getRenderer3D(): Renderer3D {
      if (!this._renderer3D) {
        const cam = new Camera3D({ position: [0, 0, 3], target: [0, 0, 0], autoNear: true });   // near tracks orbit distance (docs/specs/depth-precision.md)
        this._renderer3D = new Renderer3D(this.device, cam, this.swapChainFormat);
        this._renderer3D.onDeferredWork = () => this.scheduleRender();   // P4.3: budgeted re-dress continues next frame
      }
      return this._renderer3D;
    }

    /** The 3D renderer if one has been created — never lazily constructs (unlike getRenderer3D).
     *  For observers/diagnostics (bind-group eviction, salsaPkgPaintProbe) that must not spin up a
     *  whole Renderer3D as a side effect. */
    public peekRenderer3D(): Renderer3D | null {
      return this._renderer3D ?? null;
    }

    /** Replace the 3D renderer with a custom instance. */
    public setRenderer3D(renderer: Renderer3D): void {
      this._renderer3D = renderer;
    }

    private drawVectorShapes(passEncoder: GPURenderPassEncoder): void {
      const { shape, stroke, highlight, boundingBox, line, sdfText } = this.webGPURenderStrategy.getDrawBuffers();
      const { shape: shapeCount,
              stroke: strokeCount,
              highlight: highlightCount,
              boundingBox: boxCount,
              line: lineCount,
              sdfText: sdfTextCount } = this.webGPURenderStrategy.getDrawCounts();
      const commandStride = 5 * 4; // 5 uint32s = 20 bytes

      // Draw shapes (rectangles, circles, sections, diamonds, etc.)
      passEncoder.setPipeline(this.pipelineManager!.getShapePipeline());
      passEncoder.setBindGroup(0, this.bindGroupManager.sharedShapeBindGroup);
      passEncoder.setVertexBuffer(0, this.cacheService!.shapeGeometryCache.getVertexBuffer());
      passEncoder.setIndexBuffer(this.cacheService!.shapeGeometryCache.getIndexBuffer(), 'uint32');
      for (let i = 0; i < shapeCount; i++) {
        passEncoder.drawIndexedIndirect(shape, i * commandStride);
      }

      // Draw strokes (scribbles)
      passEncoder.setPipeline(this.pipelineManager!.getScribblePipeline());
      passEncoder.setBindGroup(0, this.bindGroupManager.sharedScribbleBindGroup);
      passEncoder.setVertexBuffer(0, this.cacheService!.strokeGeometryCache.getVertexBuffer());
      passEncoder.setIndexBuffer(this.cacheService!.strokeGeometryCache.getIndexBuffer(), 'uint32');
      for (let i = 0; i < strokeCount; i++) {
        passEncoder.drawIndexedIndirect(stroke, i * commandStride);
      }

      // Draw lines
      passEncoder.setPipeline(this.pipelineManager!.getLinePipeline());
      passEncoder.setBindGroup(0, this.bindGroupManager.sharedLineBindGroup);
      passEncoder.setVertexBuffer(0, this.cacheService!.lineGeometryCache.getVertexBuffer());
      passEncoder.setIndexBuffer(this.cacheService!.lineGeometryCache.getIndexBuffer(), 'uint32');
      for (let i = 0; i < lineCount; i++) {
        passEncoder.drawIndexedIndirect(line, i * commandStride);
      }

      // Draw SDF Text
      passEncoder.setPipeline(this.pipelineManager!.getSdfTextPipeline());
      passEncoder.setBindGroup(0, this.bindGroupManager.sharedSdfTextBindGroup);
      passEncoder.setVertexBuffer(0, this.cacheService!.sdfTextGeometryCache.getVertexBuffer());
      passEncoder.setIndexBuffer(this.cacheService!.sdfTextGeometryCache.getIndexBuffer(), 'uint32');
      for (let i = 0; i < sdfTextCount; i++) {
        passEncoder.drawIndexedIndirect(sdfText, i * commandStride);
      }

      // Draw highlights
      passEncoder.setPipeline(this.pipelineManager!.getHighlightPipeline());
      passEncoder.setBindGroup(0, this.bindGroupManager.sharedHighlightBindGroup);
      passEncoder.setVertexBuffer(0, this.cacheService!.highlightGeometryCache.getVertexBuffer());
      passEncoder.setIndexBuffer(this.cacheService!.highlightGeometryCache.getIndexBuffer(), 'uint32');
      for (let i = 0; i < highlightCount; i++) {
        passEncoder.setStencilReference(i + 1);
        passEncoder.drawIndexedIndirect(highlight, i * commandStride);
      }

      // Draw bounding boxes
      passEncoder.setPipeline(this.pipelineManager!.getBoundingBoxPipeline());
      passEncoder.setBindGroup(0, this.bindGroupManager.sharedBoundingBoxBindGroup);
      passEncoder.setVertexBuffer(0, this.cacheService!.boundingBoxGeometryCache.getVertexBuffer());
      passEncoder.setIndexBuffer(this.cacheService!.boundingBoxGeometryCache.getIndexBuffer(), 'uint32');
      for (let i = 0; i < boxCount; i++) {
        passEncoder.drawIndexedIndirect(boundingBox, i * commandStride);
      }
    }

    private renderArtboardPattern(pass: GPURenderPassEncoder) {
      this.ensureBackgroundResources();

      // Colors
      if (this.bgDirty.colors) {
        this.device.queue.writeBuffer(this.bgBgColorBuf,  0, this.backgroundColor.buffer);
        if(!this.illustrationMode) {
          this.device.queue.writeBuffer(this.bgDotColorBuf, 0, this.dotColor.buffer);
        } else {
          this.device.queue.writeBuffer(this.bgDotColorBuf, 0, this.backgroundColor.buffer);
        }
        this.bgDirty.colors = false;
      }

      // Resolution (target texture resolution)
      if (this.bgDirty.res) {
        const res = new Float32Array([this.canvas.width, this.canvas.height, 0, 0]);
        this.device.queue.writeBuffer(this.bgResBuf, 0, res);
        this.bgDirty.res = false;
      }

      // IMPORTANT: artboard-local transform
      // We want the pattern to live in artboard space, not screen space.
      // Build a world transform that translates *to* the artboard center,
      // then applies the global worldMatrix so the pattern rides with the artboard.
      // In your current conventions, the artboard is centered at (0,0), so
      // artboard-local == world. That means we can just use the global world matrix.
      // But we do NOT want the "fixed" flag here.
      const worldM = this.interactionService.getWorldMatrix();
      const inv = this.safeInvert(this._tmpInv, worldM) as Float32Array;
      this.device.queue.writeBuffer(this.bgInvWorldBuf, 0, inv.buffer);

      pass.setPipeline(this.pipelineManager!.getBackgroundPipeline());
      pass.setVertexBuffer(0, this.bgQuadVB);
      pass.setBindGroup(0, this.bgBindGroup);
      pass.draw(6, 1, 0, 0);
    }

    private drawCaretInstances(passEncoder: GPURenderPassEncoder) {
      const vertexBuffer = this.getSharedCaretQuad();
      passEncoder.setPipeline(this.pipelineManager!.getCaretPipeline());
      passEncoder.setBindGroup(0, this.cacheService!.bindGroupManager.sharedCaretBindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(4, this.caretManager.getCount(), 0, 0);
    }

    /** Draw translucent selection highlight rectangles behind selected SDF-text. */
    private drawSelectionHighlightInstances(passEncoder: GPURenderPassEncoder) {
      if (this.selectionHighlightManager.getCount() === 0) return;
      const vertexBuffer = this.getSharedCaretQuad(); // same unit quad [0,0]-[1,1]
      passEncoder.setPipeline(this.pipelineManager!.getSelectionHighlightPipeline());
      passEncoder.setBindGroup(0, this.cacheService!.bindGroupManager.sharedSelectionHighlightBindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(4, this.selectionHighlightManager.getCount(), 0, 0);
    }

    /** Draw connection-port indicator circles. */
    private drawOverlayDotInstances(passEncoder: GPURenderPassEncoder) {
      if (this.overlayDotManager.getCount() === 0) return;
      const vertexBuffer = this.getSharedCaretQuad();
      passEncoder.setPipeline(this.pipelineManager!.getOverlayDotPipeline());
      passEncoder.setBindGroup(0, this.cacheService!.bindGroupManager.sharedOverlayDotBindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(4, this.overlayDotManager.getCount(), 0, 0);
    }

    /**
     * Collect connection-port positions from the connector service and upload as dots.
     * Only renders when the line drawing tool is active.
     */
    private updateConnectionPortDots() {
      const worldMatrix = this.interactionService.getWorldMatrix();
      const isEndpointDrag = this.mode.kind === 'endpointDragging';

      // Show endpoint handles when a Line is selected (regardless of tool)
      const sel = this.interactionService.selectedNodes;
      if (sel.size === 1) {
        const node = sel.values().next().value;
        if (node instanceof Line && !this.lineDrawingService?.isEnabled) {
          const endpointColor = { r: 0.3, g: 0.8, b: 1.0, a: 1.0 };
          const hoverColor    = { r: 0.6, g: 1.0, b: 1.0, a: 1.0 };
          const threshold = 0.02;
          const cx = this._cursorWorldX;
          const cy = this._cursorWorldY;

          // Transform local endpoints to world space through localMatrix
          const m = node.localMatrix;
          const wx1 = m[0] * node.x1 + m[4] * node.y1 + m[12];
          const wy1 = m[1] * node.x1 + m[5] * node.y1 + m[13];
          const wx2 = m[0] * node.x2 + m[4] * node.y2 + m[12];
          const wy2 = m[1] * node.x2 + m[5] * node.y2 + m[13];

          const dStart = Math.hypot(wx1 - cx, wy1 - cy);
          const dEnd   = Math.hypot(wx2 - cx, wy2 - cy);
          const dots: DotInstance[] = [
            { worldX: wx1, worldY: wy1, radius: 0.009,
              color: dStart <= threshold && dStart <= dEnd ? hoverColor : endpointColor },
            { worldX: wx2, worldY: wy2, radius: 0.009,
              color: dEnd <= threshold && dEnd < dStart ? hoverColor : endpointColor },
          ];

          // During endpoint drag, also show connection ports on shapes so user can snap
          if (isEndpointDrag && this._connectorService) {
            const allPorts = this._connectorService.getAllConnectionPoints();
            const snapThreshold = this._connectorService.snapThreshold;
            let nearestIdx = -1;
            let nearestDist = Infinity;
            for (let i = 0; i < allPorts.length; i++) {
              const d = Math.hypot(allPorts[i].point.x - cx, allPorts[i].point.y - cy);
              if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
            }
            const portBase  = { r: 0.35, g: 0.65, b: 1.0, a: 0.85 };
            const portHover = { r: 0.6,  g: 0.9,  b: 1.0, a: 1.0  };
            for (let i = 0; i < allPorts.length; i++) {
              dots.push({
                worldX: allPorts[i].point.x,
                worldY: allPorts[i].point.y,
                radius: 0.007,
                color: (i === nearestIdx && nearestDist <= snapThreshold) ? portHover : portBase,
              });
            }
          }

          this.overlayDotManager.update(dots, worldMatrix);
          return;
        }
      }

      // Only show port indicators when the line tool is active
      if (!this.lineDrawingService?.isEnabled || !this._connectorService) {
        this.overlayDotManager.update([], worldMatrix);
        return;
      }

      const cx = this._cursorWorldX;
      const cy = this._cursorWorldY;

      // Only show ports for shapes whose bounding box the cursor overlaps
      // Use a generous expansion so ports near edges are still visible
      const allPorts = this._connectorService.getAllConnectionPoints();

      // Group ports by shape, filter to shapes whose bbox contains the cursor
      const shapePortMap = new Map<string, typeof allPorts>();
      for (const p of allPorts) {
        let arr = shapePortMap.get(p.shapeId);
        if (!arr) { arr = []; shapePortMap.set(p.shapeId, arr); }
        arr.push(p);
      }

      // Find shapes whose bounding box (with padding) contains the cursor
      const bboxPadding = 0.02; // small world-space padding around bbox
      const visiblePorts: typeof allPorts = [];
      for (const [_shapeId, ports] of shapePortMap) {
        // Use the port positions to infer the shape's extent
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of ports) {
          if (p.point.x < minX) minX = p.point.x;
          if (p.point.y < minY) minY = p.point.y;
          if (p.point.x > maxX) maxX = p.point.x;
          if (p.point.y > maxY) maxY = p.point.y;
        }
        // Expand the bbox by padding
        if (cx >= minX - bboxPadding && cx <= maxX + bboxPadding &&
            cy >= minY - bboxPadding && cy <= maxY + bboxPadding) {
          visiblePorts.push(...ports);
        }
      }

      // Find the nearest port to the cursor for hover highlighting
      const snapThreshold = this._connectorService.snapThreshold;
      let nearestIdx = -1;
      let nearestDist = Infinity;
      for (let i = 0; i < visiblePorts.length; i++) {
        const p = visiblePorts[i];
        const d = Math.hypot(p.point.x - cx, p.point.y - cy);
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      }

      const baseColor  = { r: 0.35, g: 0.65, b: 1.0, a: 0.85 };
      const hoverColor = { r: 0.6,  g: 0.9,  b: 1.0, a: 1.0  };

      const dots: DotInstance[] = visiblePorts.map((p, i) => ({
        worldX: p.point.x,
        worldY: p.point.y,
        radius: 0.007,
        color: (i === nearestIdx && nearestDist <= snapThreshold) ? hoverColor : baseColor,
      }));

      this.overlayDotManager.update(dots, worldMatrix);
    }

  private caretQuadBuffer!: GPUBuffer;
  private getSharedCaretQuad(): GPUBuffer {
    if (!this.caretQuadBuffer) {
      const verts = new Float32Array([ 0,0, 0,1, 1,0, 1,1 ]);
      this.caretQuadBuffer = this.device.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      new Float32Array(this.caretQuadBuffer.getMappedRange()).set(verts);
      this.caretQuadBuffer.unmap();
    }
    return this.caretQuadBuffer;
  }

  /**
   * Draw the raster-text preview texture as a floating overlay during text entry.
   * Positions a small quad at the correct texel coordinates within the raster canvas.
   */
  private drawRasterTextPreview(passEncoder: GPURenderPassEncoder) {
    if (!this._rasterTextService || !this.pipelineManager || !this.rasterWorldBuf) return;

    const previewTex = this._rasterTextService.getPreviewTexture();
    const previewInfo = this._rasterTextService.getPreviewInfo();
    if (!previewTex || !previewInfo) return;

    const texSize = this.getRasterTextureSize?.() ?? { w: this.canvas.width, h: this.canvas.height };
    const texW = texSize.w || 1;
    const texH = texSize.h || 1;

    // Compute world-space extent
    const isIll = this.illustrationMode;
    let worldQuadW = 2.0, worldQuadH = 2.0;
    if (isIll && this.illustrationBounds) {
      worldQuadW = this.illustrationBounds.width;
      worldQuadH = this.illustrationBounds.height;
    }

    // Convert texel position to world-space
    const hw = worldQuadW * 0.5;
    const hh = worldQuadH * 0.5;
    const u0 = previewInfo.destX / texW;
    const v0 = previewInfo.destY / texH;
    const u1 = (previewInfo.destX + previewInfo.width) / texW;
    const v1 = (previewInfo.destY + previewInfo.height) / texH;

    const x0 = u0 * worldQuadW - hw;
    const y0 = hh - v0 * worldQuadH;
    const x1 = u1 * worldQuadW - hw;
    const y1 = hh - v1 * worldQuadH;

    // Build a small quad VB for the preview
    const verts = new Float32Array([
      x0, y1, 0, 1,
      x1, y1, 1, 1,
      x0, y0, 0, 0,
      x1, y0, 1, 0,
    ]);

    if (!this._rasterTextPreviewVB) {
      this._rasterTextPreviewVB = this.device.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this._rasterTextPreviewVB, 0, verts);

    const layout = this.pipelineManager.getRasterPipeline().getBindGroupLayout(0);
    const bg = this.device.createBindGroup({ layout, entries: [
      { binding: 0, resource: previewTex.createView() },
      { binding: 1, resource: this.pipelineManager.getTexturedSampler() },
      { binding: 2, resource: { buffer: this.rasterWorldBuf } },
    ]});

    passEncoder.setPipeline(this.pipelineManager.getRasterPipeline());
    passEncoder.setBindGroup(0, bg);
    passEncoder.setVertexBuffer(0, this._rasterTextPreviewVB);

    if (!this._rasterTextPreviewIB) {
      const idx = new Uint16Array([0,1,2, 2,1,3]);
      this._rasterTextPreviewIB = this.device.createBuffer({
        size: idx.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint16Array(this._rasterTextPreviewIB.getMappedRange()).set(idx);
      this._rasterTextPreviewIB.unmap();
    }

    passEncoder.setIndexBuffer(this._rasterTextPreviewIB, 'uint16');
    passEncoder.drawIndexed(6, 1, 0, 0, 0);
  }

  private _rasterTextPreviewVB?: GPUBuffer;
  private _rasterTextPreviewIB?: GPUBuffer;

  // ── LiveTextNode rendering ──

  private _liveTextVB?: GPUBuffer;
  private _liveTextVBCapacity = 0; // max nodes the current VB can hold
  private _liveTextIB?: GPUBuffer;
  // Arc (curved-strip) path: separate VB + a shared index pattern for one strip.
  private _liveTextArcVB?: GPUBuffer;
  private _liveTextArcVBCapacity = 0; // max arc nodes the current arc VB can hold
  private _liveTextArcIB?: GPUBuffer;
  /** Canvas we've bound the HTML-in-Canvas `onpaint` capture handler to (rebinds on swap). */
  private _liveTextPaintCanvas: HTMLCanvasElement | null = null;
  /** Pooled translucent overlay rects drawn over LiveText nodes in text-draw mode. */
  private _liveTextDrawOverlays: Rectangle[] = [];

  /**
   * Drive the HTML-in-Canvas LiveText path each frame:
   *  - Capture each node's live DOM element into its source texture INSIDE `onpaint` (the
   *    only place the element snapshot is fresh) — registered once per canvas.
   *  - `requestPaint()` so onpaint keeps firing (caret blink, IME, effect animation).
   *  - Sync each editable element's transform over its rendered quad (the edit hit region).
   * No-ops on browsers without the experimental API (nodes fall back to OffscreenCanvas).
   */
  private driveLiveTextHtml(): void {
    const canvas = this.canvas as HTMLCanvasElement & {
      requestPaint?: () => void; onpaint?: (() => void) | null;
    };
    if (typeof canvas.requestPaint !== 'function') return;
    const nodes = this.webGPURenderStrategy.getLiveTextNodes();
    if (this._liveTextPaintCanvas !== canvas) {
      canvas.onpaint = () => {
        for (const n of this.webGPURenderStrategy.getLiveTextNodes()) n.captureHtmlSource();
      };
      this._liveTextPaintCanvas = canvas;
    }
    if (nodes.length === 0) return;
    try { canvas.requestPaint(); } catch { /* ignore */ }
    const wm = this.interactionService.getWorldMatrix() as Float32Array;
    const cr = canvas.getBoundingClientRect();
    for (const n of nodes) n.syncOverlayTransform(wm, cr.width, cr.height);
  }

  /**
   * Draw all collected LiveTextNode instances as textured quads.
   * Each node has its own GPU texture (post-effects), drawn at its world position
   * using the existing raster pipeline (pos+uv vertex → texture_2d sample).
   */
  private drawLiveTextNodes(passEncoder: GPURenderPassEncoder): void {
    if (!this.pipelineManager || !this.rasterWorldBuf) return;

    const liveNodes = this.webGPURenderStrategy.getLiveTextNodes();
    if (liveNodes.length === 0) return;

    const pipeline = this.pipelineManager.getRasterPipeline();
    const sampler = this.pipelineManager.getTexturedSampler();
    const worldMatrix = this.interactionService.getWorldMatrix() as Float32Array;

    // Ensure the world matrix uniform is up to date
    this.device.queue.writeBuffer(this.rasterWorldBuf, 0, worldMatrix.buffer);

    // Ensure shared index buffer exists
    if (!this._liveTextIB) {
      const idx = new Uint16Array([0, 1, 2, 2, 1, 3]);
      this._liveTextIB = this.device.createBuffer({
        size: idx.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint16Array(this._liveTextIB.getMappedRange()).set(idx);
      this._liveTextIB.unmap();
    }

    // ── Build per-node vertex data and collect textures ────────
    // Each node = 4 vertices × 4 floats = 16 floats = 64 bytes.
    // We pack all nodes into a single GPU buffer and use byte offsets
    // in setVertexBuffer so each draw reads correct vertex data.
    // (A single shared buffer + per-node writeBuffer inside the draw
    //  loop is incorrect — queue.writeBuffer completes before the
    //  render pass executes, so only the last write would be visible.)
    const FLOATS_PER_NODE = 16; // 4 verts × (pos2 + uv2)
    const BYTES_PER_NODE = FLOATS_PER_NODE * 4; // 64
    const allVerts = new Float32Array(liveNodes.length * FLOATS_PER_NODE);
    const nodeTextures: GPUTexture[] = [];
    const arcDraws: { node: LiveTextNode; tex: GPUTexture }[] = [];
    let drawn = 0;

    for (const node of liveNodes) {
      const tex = node.getCurrentTexture();
      if (!tex) continue;

      // Arc nodes (arcAngle != 0) use the curved-strip path (variable geometry) — defer them.
      if (Math.abs(node.arcAngle) >= 0.5) { arcDraws.push({ node, tex }); continue; }

      // Draw the texture at its RENDER size (what the current capture represents), NOT width/height.
      // While drag-resizing a framed node the capture lags the live frame by a frame, so two things
      // must be avoided: (1) drawing at the frame size STRETCHES the stale texture; (2) the origin
      // shifts each tick (to hold the opposite edge), so the quad must be ANCHORED to the frame edge
      // the text hugs — otherwise the glyphs drift while the capture catches up. The anchor depends
      // on text-align (the lagging texture grows toward the OPPOSITE, empty side); vertical is always
      // top. When renderSize == frame size (static / auto-fit) every case reduces to the full frame.
      const fw = node.width, fh = node.height;             // live frame (logical) size
      const rw = node.renderWidth, rh = node.renderHeight; // texture extent
      let lx: number, rx: number;
      switch (node.align) {
        case 'right':  rx = fw / 2;  lx = rx - rw; break;  // pin RIGHT edge, grow left
        case 'center': lx = -rw / 2; rx = rw / 2;  break;  // pin CENTER, grow both ways
        default:       lx = -fw / 2; rx = lx + rw; break;  // pin LEFT edge, grow right
      }
      const ty = fh / 2;       // frame top (local) — text is top-anchored
      const by = ty - rh;      // grow down by texture height

      const localToWorld = mat4.create();
      mat4.mul(localToWorld, node.parentChainMatrix, node._localMatrix);

      const tl = vec3.transformMat4(vec3.create(), vec3.fromValues(lx, ty, 0), localToWorld);
      const tr = vec3.transformMat4(vec3.create(), vec3.fromValues(rx, ty, 0), localToWorld);
      const bl = vec3.transformMat4(vec3.create(), vec3.fromValues(lx, by, 0), localToWorld);
      const br = vec3.transformMat4(vec3.create(), vec3.fromValues(rx, by, 0), localToWorld);

      const o = drawn * FLOATS_PER_NODE;
      // pos(x,y) + uv(u,v) per vertex, CCW winding
      allVerts[o +  0] = bl[0]; allVerts[o +  1] = bl[1]; allVerts[o +  2] = 0; allVerts[o +  3] = 1;
      allVerts[o +  4] = br[0]; allVerts[o +  5] = br[1]; allVerts[o +  6] = 1; allVerts[o +  7] = 1;
      allVerts[o +  8] = tl[0]; allVerts[o +  9] = tl[1]; allVerts[o + 10] = 0; allVerts[o + 11] = 0;
      allVerts[o + 12] = tr[0]; allVerts[o + 13] = tr[1]; allVerts[o + 14] = 1; allVerts[o + 15] = 0;

      nodeTextures.push(tex);
      drawn++;
    }

    if (drawn === 0 && arcDraws.length === 0) return;

    // (Re)create vertex buffer if the current one is too small
    if (!this._liveTextVB || this._liveTextVBCapacity < drawn) {
      this._liveTextVB?.destroy();
      this._liveTextVBCapacity = Math.max(drawn, 4); // at least 4 nodes
      this._liveTextVB = this.device.createBuffer({
        size: this._liveTextVBCapacity * BYTES_PER_NODE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    // Single writeBuffer with ALL vertex data
    this.device.queue.writeBuffer(
      this._liveTextVB, 0,
      allVerts.buffer, allVerts.byteOffset,
      drawn * BYTES_PER_NODE,
    );

    // ── Draw each node using byte offsets into the packed VB ──
    passEncoder.setPipeline(pipeline);
    passEncoder.setIndexBuffer(this._liveTextIB, 'uint16');

    for (let i = 0; i < drawn; i++) {
      const bg = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: nodeTextures[i].createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer: this.rasterWorldBuf } },
        ],
      });

      passEncoder.setBindGroup(0, bg);
      passEncoder.setVertexBuffer(0, this._liveTextVB, i * BYTES_PER_NODE, BYTES_PER_NODE);
      passEncoder.drawIndexed(6, 1, 0, 0, 0);
    }

    if (arcDraws.length > 0) {
      this.drawArcedLiveTextNodes(passEncoder, arcDraws, pipeline, sampler);
    }
  }

  /**
   * Draw LiveText nodes that have an arc (arcAngle != 0) by bending the flat captured texture
   * onto a subdivided curved strip — Approach A from docs/specs/arc-text.md. The text is captured
   * FLAT (effects + editing happen on the flat element); only the render quad curves, so glyphs
   * follow the arc with a gentle texture warp. Each node = (N+1) columns × 2 verts (top/bottom);
   * all nodes pack into one VB, drawn with a shared index pattern via baseVertex offsets.
   */
  private drawArcedLiveTextNodes(
    passEncoder: GPURenderPassEncoder,
    arcDraws: { node: LiveTextNode; tex: GPUTexture }[],
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
  ): void {
    const N = 24;                       // strip segments
    const VPN = (N + 1) * 2;            // vertices per node (top+bottom per column)
    const FPN = VPN * 4;               // floats per node (pos2 + uv2)

    // Shared index pattern for one strip (CCW, matching the flat quad winding).
    if (!this._liveTextArcIB) {
      const idx = new Uint16Array(N * 6);
      for (let i = 0; i < N; i++) {
        const t0 = 2 * i, b0 = 2 * i + 1, t1 = 2 * i + 2, b1 = 2 * i + 3;
        idx.set([b0, b1, t0, t0, b1, t1], i * 6);
      }
      this._liveTextArcIB = this.device.createBuffer({
        size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true,
      });
      new Uint16Array(this._liveTextArcIB.getMappedRange()).set(idx);
      this._liveTextArcIB.unmap();
    }

    const verts = new Float32Array(arcDraws.length * FPN);
    const tmp = vec3.create();
    for (let k = 0; k < arcDraws.length; k++) {
      const node = arcDraws[k];
      const n = node.node;
      // Align-aware flat layout (same rules as the flat path).
      const fw = n.width, fh = n.height, rw = n.renderWidth, rh = n.renderHeight;
      let lx: number, rx: number;
      switch (n.align) {
        case 'right':  rx = fw / 2;  lx = rx - rw; break;
        case 'center': lx = -rw / 2; rx = rw / 2;  break;
        default:       lx = -fw / 2; rx = lx + rw; break;
      }
      const ty = fh / 2, by = ty - rh;
      const W = rx - lx, midX = (lx + rx) / 2, vCenter = (ty + by) / 2, halfH = rh / 2;
      const arcRad = n.arcAngle * Math.PI / 180;
      const a = Math.abs(arcRad), s = Math.sign(arcRad), R = W / a; // a >= ~0.0087 (0.5°)

      const m = mat4.create();
      mat4.mul(m, n.parentChainMatrix, n._localMatrix);

      const base = k * FPN;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const phi = (t - 0.5) * a;            // magnitude sweep → x = R sin(phi) stays monotonic L→R
        const sinP = Math.sin(phi), cosP = Math.cos(phi);
        const cx = midX + R * sinP;
        const cy = vCenter + s * R * (cosP - 1);
        const upx = s * sinP, upy = cosP;     // unit "up" (radially outward), text top
        // top (v=0) and bottom (v=1) of this column, then to world.
        vec3.transformMat4(tmp, vec3.set(tmp, cx + upx * halfH, cy + upy * halfH, 0), m);
        const vo = base + i * 8;
        verts[vo] = tmp[0]; verts[vo + 1] = tmp[1]; verts[vo + 2] = t; verts[vo + 3] = 0;
        vec3.transformMat4(tmp, vec3.set(tmp, cx - upx * halfH, cy - upy * halfH, 0), m);
        verts[vo + 4] = tmp[0]; verts[vo + 5] = tmp[1]; verts[vo + 6] = t; verts[vo + 7] = 1;
      }
    }

    if (!this._liveTextArcVB || this._liveTextArcVBCapacity < arcDraws.length) {
      this._liveTextArcVB?.destroy();
      this._liveTextArcVBCapacity = Math.max(arcDraws.length, 2);
      this._liveTextArcVB = this.device.createBuffer({
        size: this._liveTextArcVBCapacity * FPN * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this._liveTextArcVB, 0, verts.buffer, verts.byteOffset, arcDraws.length * FPN * 4);

    passEncoder.setPipeline(pipeline);
    passEncoder.setIndexBuffer(this._liveTextArcIB, 'uint16');
    passEncoder.setVertexBuffer(0, this._liveTextArcVB, 0);
    for (let k = 0; k < arcDraws.length; k++) {
      const bg = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: arcDraws[k].tex.createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer: this.rasterWorldBuf! } },
        ],
      });
      passEncoder.setBindGroup(0, bg);
      passEncoder.drawIndexed(N * 6, 1, 0, k * VPN, 0); // baseVertex offsets into this node's strip
    }
  }

    /** Draw one category of staged (in-progress) shapes. Each shape gets its OWN uniform slot + geometry range
     *  via the staging buffer's append API — queue writes all execute before any pass draw, so the old
     *  single-slot flow made every draw show the LAST shape's line (the polygon tool's whole construction
     *  overlay collapsed to one marker edge). Caller runs beginStagingPass() ONCE before all categories. */
    private renderStagingShapes<T extends Shape>(
        passEncoder: GPURenderPassEncoder,
        shapes: T[],
        pipeline: GPURenderPipeline,
        appendMethod: (shape: T) => { firstIndex: number; indexCount: number; baseVertex: number;
            info: { vertexCount: number; indexCount: number; vertexStart: number; indexStart: number; frameIndex: number } },
        ): void {
            if (!shapes.length) return;
            const layout = pipeline.getBindGroupLayout(0);
            passEncoder.setPipeline(pipeline);

            for (const shape of shapes) {
                const slot = this.stagingBuffer.appendUniforms(this.getStrokeUniformData(shape));
                if (slot < 0) { console.warn('renderStagingShapes: staging slots exhausted — overlay truncated'); break; }
                const bindGroup = this.stagingBuffer.createStagingBindGroupAt(layout, slot);
                const d = appendMethod(shape);
                shape._stagingInfo = d.info;   // the commit path (copyToSharedBuffer) reads range offsets from here
                this.stagingBuffer.drawAppended(passEncoder, bindGroup, d);
            }
    }

    private getStrokeUniformData(shape: Shape): Float32Array {
        const canvas = this.interactionService.canvas;
        const resolution = new Float32Array([canvas.width, canvas.height, 0, 0]);
        const worldMatrix = this.interactionService.getWorldMatrix();
        const localMatrix = shape.localMatrix;
        const colorSource = shape.strokeColor;
        const shapeColor = new Float32Array([colorSource.r, colorSource.g, colorSource.b, colorSource.a]);
        const uniformData = new Float32Array(64);
        
        uniformData.set(resolution, 0);       // [0-3]
        uniformData.set(worldMatrix, 4);      // [4-19]
        uniformData.set(localMatrix, 20);     // [20-35]
        uniformData.set(shapeColor, 36);      // [36-39]
        uniformData[40] = shape.strokeWidth; // thickness
        uniformData[63] = 0; // Explicitly set last element
        // [40-63] will remain padded with 0s automatically
        return uniformData;
    }

    getAllVisibleNodesRecursive(node: Node): Node[] {
        const nodes: Node[] = [];
        if (node.visible) nodes.push(node);
    
        for (const child of node.children) {
            nodes.push(...this.getAllVisibleNodesRecursive(child));
        }
    
        return nodes;
    }

    private backgroundColor: Float32Array = new Float32Array([0.1059, 0.1059, 0.1059, 1]); // Default background color
    public setBackgroundColor(r: number, g: number, b: number, a: number = 1.0) {
        this.backgroundColor.set([r, g, b, a]);
        this.bgDirty.colors = true;
        this.scheduleRender();
    }
    public getBackgroundColor() {
        return this.backgroundColor;
    }
    public getBackgroundColorHex(): string {
        return this.rgbaToHex(this.backgroundColor);
    }

    private dotColor: Float32Array = new Float32Array([0.2078, 0.2078, 0.2078, 1]); // Default dot color
    public setDotColor(r: number, g: number, b: number, a: number = 1.0) {
        this.dotColor.set([r, g, b, a]);
        this.bgDirty.colors = true;
        this.scheduleRender();
    }
    public getDotColor() {
        return this.dotColor;
    }
    public getDotColorHex(): string {
        return this.rgbaToHex(this.dotColor);
    }

    // Helper to convert RGBA [0–1] to hex string
    private rgbaToHex(color: Float32Array): string {
        const toHex = (value: number) => {
            const hex = Math.round(value * 255).toString(16).padStart(2, '0');
            return hex;
        };
        const r = toHex(color[0]);
        const g = toHex(color[1]);
        const b = toHex(color[2]);
        return `${r}${g}${b}`;
    }

    private ensureBackgroundResources() {
        if (this.bgBindGroup) return;
        if (!this.pipelineManager) return;

        const device = this.device;

        this.bgResBuf      = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.bgInvWorldBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.bgBgColorBuf  = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.bgDotColorBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.bgGridBuf     = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

        this.bgBindGroup = device.createBindGroup({
            layout: this.pipelineManager!.getBackgroundPipeline().getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.bgResBuf } },
                { binding: 1, resource: { buffer: this.bgInvWorldBuf } },
                { binding: 2, resource: { buffer: this.bgBgColorBuf } },
                { binding: 3, resource: { buffer: this.bgDotColorBuf } },
            ],
        });
        // Grid overlay bind group (its own pipeline/layout: resolution, inverse-world, grid params).
        this.gridOverlayBindGroup = device.createBindGroup({
            layout: this.pipelineManager!.getGridOverlayPipeline().getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.bgResBuf } },
                { binding: 1, resource: { buffer: this.bgInvWorldBuf } },
                { binding: 2, resource: { buffer: this.bgGridBuf } },
            ],
        });
        this._writeCanvasGridUniform();

        // fullscreen quad once
        const verts = new Float32Array([
            -1,-1,  1,-1,  -1, 1,
             1,-1,  1, 1,  -1, 1,
        ]);
        this.bgQuadVB = device.createBuffer({
            size: verts.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.bgQuadVB, 0, verts);
    }

    // ── Visible 2D canvas grid ───────────────────────────────────────
    /** Pack the grid state into the background shader's grid uniform (2× vec4). */
    private _writeCanvasGridUniform(): void {
        if (!this.bgGridBuf) return;
        const d = new Float32Array(8);
        d[0] = this._canvasGridColor[0]; d[1] = this._canvasGridColor[1]; d[2] = this._canvasGridColor[2];
        d[3] = this._canvasGridOpacity;
        d[4] = (this._canvasGridVisible && this._canvasGridVisibleOverride) ? 1 : 0;
        d[5] = 1 / Math.max(1, this._canvasGridCells);  // shader wants normalized spacing = 1 / cells
        d[6] = this._canvasGridLineWidth;
        d[7] = 0;
        this.device.queue.writeBuffer(this.bgGridBuf, 0, d);
    }

    public setCanvasGridVisible(v: boolean): void { this._canvasGridVisible = v; this._writeCanvasGridUniform(); this.scheduleRender(); }
    public getCanvasGridVisible(): boolean { return this._canvasGridVisible; }
    /** Render-only gate (NOT persisted) — e.g. hide the 2D grid while a 3D scene is active. effective = visible && override. */
    public setCanvasGridVisibleOverride(v: boolean): void { this._canvasGridVisibleOverride = v; this._writeCanvasGridUniform(); this.scheduleRender(); }
    public getCanvasGridVisibleOverride(): boolean { return this._canvasGridVisibleOverride; }
    public setCanvasGridColor(r: number, g: number, b: number): void { this._canvasGridColor = [r, g, b]; this._writeCanvasGridUniform(); this.scheduleRender(); }
    public getCanvasGridColor(): [number, number, number] { return [...this._canvasGridColor]; }
    public setCanvasGridOpacity(o: number): void { this._canvasGridOpacity = Math.max(0, Math.min(1, o)); this._writeCanvasGridUniform(); this.scheduleRender(); }
    public getCanvasGridOpacity(): number { return this._canvasGridOpacity; }
    /** Number of grid cells across the document (e.g. 8, 16, 32). Higher = finer grid. */
    public setCanvasGridCells(n: number): void { this._canvasGridCells = Math.max(1, n); this._writeCanvasGridUniform(); this.scheduleRender(); }
    public getCanvasGridCells(): number { return this._canvasGridCells; }

    /**
     * Draw the 2D canvas grid as a TOP overlay — above raster/vector/3D, drawn last in the pass.
     * Artboard-space + alpha-blended, so it pans/zooms with the canvas. No-op unless enabled.
     */
    private renderGridOverlay(pass: GPURenderPassEncoder): void {
        if (!this._canvasGridVisible || !this._canvasGridVisibleOverride || !this.pipelineManager || (RD.on && RD.f.noGrid)) return;
        this.ensureBackgroundResources();
        if (!this.gridOverlayBindGroup) return;
        // Resolution + inverse-world (same artboard transform as the background pattern), written
        // here so the overlay is correct regardless of which background path ran this frame.
        const res = new Float32Array([this.canvas.width, this.canvas.height, 0, 0]);
        this.device.queue.writeBuffer(this.bgResBuf, 0, res);
        const worldM = this.interactionService.getWorldMatrix();
        const inv = this.safeInvert(this._tmpInv, worldM) as Float32Array;
        this.device.queue.writeBuffer(this.bgInvWorldBuf, 0, inv.buffer);
        // Cover the whole viewport (an earlier pass may have left a clipped scissor).
        pass.setScissorRect(0, 0, this.canvas.width, this.canvas.height);
        pass.setPipeline(this.pipelineManager.getGridOverlayPipeline());
        pass.setVertexBuffer(0, this.bgQuadVB);
        pass.setBindGroup(0, this.gridOverlayBindGroup);
        pass.draw(6, 1, 0, 0);
    }

    /**
     * Draw the UI System modal DIM (docs/specs/ui-system.md §backgroundOverlay): a fullscreen quad in the colour the
     * provider returns for the current UI state. No-op unless a modal state is active (provider returns null / α≤0),
     * so it never affects normal editing. Reuses the background fullscreen NDC quad; own tiny colour uniform.
     */
    private _uiBlurDummy(): GPUTexture {
        if (!this._uiBlurDummyTex) {
            this._uiBlurDummyTex = this.device.createTexture({
                size: [1, 1], format: this.swapChainFormat, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'UIBlurDummy',
            });
        }
        return this._uiBlurDummyTex;
    }

    /** Separable Gaussian over the scene grab → _uiBlurTexB (half-res). Own encoder, submitted immediately so it
     *  executes before the main pass that samples it. */
    private prepareUIWorldBlur(): void {
        if (!this.pipelineManager) return;
        const w = Math.max(1, this.canvas.width >> 1), h = Math.max(1, this.canvas.height >> 1);
        if (!this._uiBlurTexA || this._uiBlurW !== w || this._uiBlurH !== h) {
            this._uiBlurTexA?.destroy(); this._uiBlurTexB?.destroy();
            const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
            this._uiBlurTexA = this.device.createTexture({ size: [w, h], format: this.swapChainFormat, usage, label: 'UIBlurA' });
            this._uiBlurTexB = this.device.createTexture({ size: [w, h], format: this.swapChainFormat, usage, label: 'UIBlurB' });
            this._uiBlurW = w; this._uiBlurH = h;
            this._uiScrimBoundBlurTex = null;   // rebind the scrim group to the fresh texture
        }
        if (!this._uiScrimSampler) this._uiScrimSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        if (this._uiBlurParamBufs.length === 0) {
            for (let i = 0; i < 2; i++) this._uiBlurParamBufs.push(this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
        }
        this.device.queue.writeBuffer(this._uiBlurParamBufs[0], 0, new Float32Array([1, 0, 1 / w, 1 / h]));
        this.device.queue.writeBuffer(this._uiBlurParamBufs[1], 0, new Float32Array([0, 1, 1 / w, 1 / h]));
        const pipe = this.pipelineManager.getUIBlurPipeline();
        const bgl = pipe.getBindGroupLayout(0);
        const enc = this.device.createCommandEncoder();
        const passes: Array<[GPUTexture, GPUTexture, GPUBuffer]> = [
            [this.sceneColorGrabTex!, this._uiBlurTexA!, this._uiBlurParamBufs[0]],   // H (also downsamples)
            [this._uiBlurTexA!, this._uiBlurTexB!, this._uiBlurParamBufs[1]],          // V
        ];
        for (const [src, dst, buf] of passes) {
            const bg = this.device.createBindGroup({ layout: bgl, entries: [
                { binding: 0, resource: { buffer: buf } },
                { binding: 1, resource: src.createView() },
                { binding: 2, resource: this._uiScrimSampler },
            ]});
            const rp = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
            rp.setPipeline(pipe);
            rp.setBindGroup(0, bg);
            rp.draw(3);
            rp.end();
        }
        this.device.queue.submit([enc.finish()]);
    }

    private renderUIScrim(pass: GPURenderPassEncoder): void {
        if (!this.pipelineManager) return;
        const c = this._uiScrimFrame;
        if (!c || (c.color[3] <= 0 && c.blur <= 0.001)) return;
        this.ensureBackgroundResources();
        if (!this.bgQuadVB) return;
        if (!this._uiScrimSampler) this._uiScrimSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        const wantBlurTex = (c.blur > 0.001 && this._uiBlurTexB) ? this._uiBlurTexB : this._uiBlurDummy();
        if (!this._uiScrimColorBuf) {
            this._uiScrimColorBuf = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        }
        if (!this._uiScrimBindGroup || this._uiScrimBoundBlurTex !== wantBlurTex) {
            this._uiScrimBindGroup = this.device.createBindGroup({
                layout: this.pipelineManager.getUIScrimPipeline().getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this._uiScrimColorBuf } },
                    { binding: 1, resource: wantBlurTex.createView() },
                    { binding: 2, resource: this._uiScrimSampler },
                ],
            });
            this._uiScrimBoundBlurTex = wantBlurTex;
        }
        const blurW = (c.blur > 0.001 && this._uiBlurTexB) ? c.blur : 0;
        this.device.queue.writeBuffer(this._uiScrimColorBuf, 0, new Float32Array([
            c.color[0], c.color[1], c.color[2], c.color[3],
            c.dir[0], c.dir[1], c.progress, c.soft,
            c.mode, blurW, 0, 0,
        ]));
        pass.setScissorRect(0, 0, this.canvas.width, this.canvas.height);
        pass.setPipeline(this.pipelineManager.getUIScrimPipeline());
        pass.setVertexBuffer(0, this.bgQuadVB);
        pass.setBindGroup(0, this._uiScrimBindGroup);
        pass.draw(6, 1, 0, 0);
    }

    private renderBackground(passEncoder: GPURenderPassEncoder) {
        this.ensureBackgroundResources();

        // update the few small buffers (no re-creation)
        if (this.bgDirty.res) {
            const res = new Float32Array([this.canvas.width, this.canvas.height, 0, 0]);
            this.device.queue.writeBuffer(this.bgResBuf, 0, res);
            this.bgDirty.res = false;
        }

        // world -> local (inverse world): update every frame or behind a version flag
        if (this.bgDirty.matrix || this.backgroundPatternFixed) {
            const worldMatrix = this.backgroundPatternFixed 
                ? mat4.create() // identity matrix (no pan/zoom applied to background)
                : this.interactionService.getWorldMatrix();
            
            const inv = this.safeInvert(this._tmpInv, worldMatrix) as Float32Array;
            this.device.queue.writeBuffer(this.bgInvWorldBuf, 0, inv.buffer);
            this.bgDirty.matrix = false;
        }

        if (this.bgDirty.colors) {
            this.device.queue.writeBuffer(this.bgBgColorBuf,  0, this.backgroundColor.buffer);
            this.device.queue.writeBuffer(this.bgDotColorBuf, 0, this.dotColor.buffer);
            this.bgDirty.colors = false;
        }

        passEncoder.setPipeline(this.pipelineManager!.getBackgroundPipeline());
        passEncoder.setVertexBuffer(0, this.bgQuadVB);
        passEncoder.setBindGroup(0, this.bgBindGroup);
        passEncoder.draw(6, 1, 0, 0);
    }

  // --- Raster mode support ---
  private renderMode: 'vector' | 'raster' = 'vector';
  private rasterTexture?: GPUTexture;
  /** Scratch texture for displaying raster content with grain overlay in single-layer mode.
   *  We can't modify rasterTexture directly because it's the live paint data. */
  private rasterDisplayTex?: GPUTexture;
  private rasterDisplayTexW = 0;
  private rasterDisplayTexH = 0;
  public setRenderMode(mode: 'vector' | 'raster') { this.renderMode = mode; this.scheduleRender(); }
  public setRasterTexture(tex: GPUTexture | undefined) { this.rasterTexture = tex; this.scheduleRender(); }

    public canvasPxToWorld(xCanvas: number, yCanvas: number): Vec2 {
        return canvasPxToWorld(xCanvas, yCanvas, this.canvas, this.interactionService);
    }

    private worldToCanvasPx(wx: number, wy: number): Vec2 {
    // world -> clip (NDC), then to pixels
    // In your system, worldMatrix already maps world -> NDC
    const m = this.interactionService.getWorldMatrix();
    const x = m[0]*wx + m[4]*wy + m[12];
    const y = m[1]*wx + m[5]*wy + m[13];
    // NDC [-1,1] -> pixels
    const cw = this.canvas.width, ch = this.canvas.height;
    const px = (x * 0.5 + 0.5) * cw;
    const py = (-(y * 0.5) + 0.5) * ch;
    return [px, py];
  }

  private _artboardClip = true;
  /** Disable the artboard scissor clip so the viewport is NOT cropped to the document rectangle. The packaging
   *  (3D product) editor uses a fixed document size to size the dieline paint layer, but its 3D box must fill the
   *  whole viewport (orbited/folded it extends past the flat-dieline bounds). Illustrations leave this TRUE, so
   *  their artboard clipping is unchanged. */
  public setArtboardClipEnabled(on: boolean): void { this._artboardClip = on; this.scheduleRender(); }

  public getArtboardScissor(): { x: number; y: number; w: number; h: number } | null {
    if (!this._artboardClip) return null;   // packaging/product 3D workspace → no crop to the doc rect
    if (!this.illustrationMode || !this.illustrationBounds) return null;

    const { width, height } = this.illustrationBounds;
    const hw = width * 0.5, hh = height * 0.5;

    // world corners -> canvas px (floats)
    const corners: Vec2[] = [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]];
    const px = corners.map(([x,y]) => this.worldToCanvasPx(x,y));
    const xs = px.map(p => p[0]), ys = px.map(p => p[1]);

    // float min/max then clamp
    const cw = this.canvas.width, ch = this.canvas.height;
    let x1 = Math.max(0, Math.min(cw, Math.min(...xs)));
    let x2 = Math.max(0, Math.min(cw, Math.max(...xs)));
    let y1 = Math.max(0, Math.min(ch, Math.min(...ys)));
    let y2 = Math.max(0, Math.min(ch, Math.max(...ys)));
    if (x2 <= x1 || y2 <= y1) return null;

    const eps = 1e-6;
    let xi = Math.floor(x1 + eps);
    let yi = Math.floor(y1 + eps);
    let w  = Math.ceil(x2 - eps) - xi;
    let h  = Math.ceil(y2 - eps) - yi;

    // --- bleed in pixels ---
    const padPx = 2;                 // try 1–2 px
    xi = Math.max(0, xi - padPx);
    yi = Math.max(0, yi - padPx);
    w  = Math.min(cw - xi, w + 2*padPx);
    h  = Math.min(ch - yi, h + 2*padPx);

    w = Math.max(1, w);
    h = Math.max(1, h);
    return { x: xi, y: yi, w, h };
  }

    public async waitForFrameSettled(): Promise<void> {
      // The frame below is a LIVE frame (scheduleRender → _renderLive): draws whose pipeline is still compiling are
      // SKIPPED. Snapshot / thumbnail / video-export callers read this frame back, so re-render (bounded) until no
      // skipped draw is left — else a fresh page's capture came out missing meshes / FXAA / outlines / bloom
      // (bug-hunt 2026-10-01). Normally one pass (nothing waiting).
      // RESOLUTION SCALING: the frame read back renders at native size (exports / thumbnails are never scaled).
      this._fullResHold++;
      try {
      for (let pass = 0, scaledSkips = 0; pass < 4; pass++) {
        // ensure a frame will be produced
        this.scheduleRender();

        // wait until this renderer actually submitted a frame (notifyFrameSubmitted() right after queue.submit())
        await this.waitForFrameSubmitted();
        // A frame that STARTED before the hold (still scaled) does not count: wait for the next one (bounded).
        // (Nor does one drawn straight into the canvas: lastFrameTex was not written.)
        if ((this._submittedScaled || this._submittedDirect) && scaledSkips++ < 3) { pass--; continue; }

        // wait until GPU work is done
        await this.device.queue.onSubmittedWorkDone();

        const cache = GPUPipelineCache.peek(this.device);
        if (!cache || cache.status().waitingDraws === 0) break;
        await Promise.race([cache.whenWaitedSettled(), new Promise<void>(r => setTimeout(r, 4000))]);
      }
      } finally {
        this._releaseFullRes();
      }

      // wait one browser frame so the swapchain image is presented (waits one requestAnimationFrame tick)
      await this.nextRAF();
    }

    // --- frame-settle plumbing ---
    private frameSubmittedResolvers: Array<() => void> = [];

    private notifyFrameSubmitted() {
      const q = this.frameSubmittedResolvers.splice(0);
      for (const r of q) r();
      for (const cb of this._postFrameCallbacks) cb();
    }

    // --- post-frame hooks (e.g. ephemera SVG overlay rendering) ---
    private _postFrameCallbacks: Array<() => void> = [];

    /** Register a callback fired after every frame is submitted to the GPU. Returns an unsubscribe fn. */
    public addPostFrameCallback(cb: () => void): () => void {
      this._postFrameCallbacks.push(cb);
      return () => {
        const i = this._postFrameCallbacks.indexOf(cb);
        if (i >= 0) this._postFrameCallbacks.splice(i, 1);
      };
    }

    // --- vector layer filtering (Phase B / Phase D) ---
    /** IDs of vector layers whose nodes should be hidden. Empty = all visible. */
    private _hiddenVectorLayerIds = new Set<string>();

    /** @deprecated No-op. For interactivity gating call shapeManager.setActiveVectorLayer() (flows
     *  via interactionService.activeVectorLayerId → SelectionService.isInteractable); for show/hide
     *  use setVectorLayerVisible(). */
    public setActiveVectorLayerId(_id: string | null): void {}

    /**
     * Show or hide all scene-graph nodes that belong to a specific vector layer.
     * Calling with visible=false hides the layer; visible=true restores it.
     * Nodes with no layerId are always shown regardless.
     */
    public setVectorLayerVisible(layerId: string, visible: boolean): void {
      if (visible) {
        this._hiddenVectorLayerIds.delete(layerId);
      } else {
        this._hiddenVectorLayerIds.add(layerId);
      }
      this.scheduleRender();
    }

    // --- ephemera placement interaction ---
    public _ephemeraHitTester?: (wx: number, wy: number) => { layerId: string; placementId: string; x: number; y: number } | null;
    public _ephemeraUpdateCallback?: (layerId: string, placementId: string, newX: number, newY: number) => void;
    public _ephemeraSelectCallback?: (layerId: string, placementId: string) => void;

    public setEphemeraInteractionCallbacks(
      hitTester: (wx: number, wy: number) => { layerId: string; placementId: string; x: number; y: number } | null,
      onUpdate: (layerId: string, placementId: string, newX: number, newY: number) => void,
      onSelect: (layerId: string, placementId: string) => void,
    ): void {
      this._ephemeraHitTester = hitTester;
      this._ephemeraUpdateCallback = onUpdate;
      this._ephemeraSelectCallback = onSelect;
    }

    public _ephemeraHandleHitTester?: (wx: number, wy: number) => PlacementHandleHit | null;
    public _ephemeraResizeCallback?: (layerId: string, placementId: string, handle: PlacementResizeHandle, anchorX: number, anchorY: number, dragX: number, dragY: number) => void;
    public _ephemeraRotateCallback?: (layerId: string, placementId: string, centerX: number, centerY: number, startAngle: number, startRotation: number, dragX: number, dragY: number) => void;
    public _ephemeraDeselectCallback?: () => void;

    public setEphemeraHandleCallbacks(
      handleHitTester: (wx: number, wy: number) => PlacementHandleHit | null,
      onResize: (layerId: string, placementId: string, handle: PlacementResizeHandle, anchorX: number, anchorY: number, dragX: number, dragY: number) => void,
      onRotate: (layerId: string, placementId: string, centerX: number, centerY: number, startAngle: number, startRotation: number, dragX: number, dragY: number) => void,
      onDeselect: () => void,
    ): void {
      this._ephemeraHandleHitTester = handleHitTester;
      this._ephemeraResizeCallback = onResize;
      this._ephemeraRotateCallback = onRotate;
      this._ephemeraDeselectCallback = onDeselect;
    }

    private waitForFrameSubmitted(): Promise<void> {
      return new Promise<void>(res => this.frameSubmittedResolvers.push(res));
    }

    // Use the canvas’ window if available; fall back to setTimeout in non-DOM envs
    private nextRAF(): Promise<void> {
      const win: any =
        this.canvas?.ownerDocument?.defaultView ??
        (typeof window !== 'undefined' ? window : undefined);

      if (win && typeof win.requestAnimationFrame === 'function') {
        return new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
      }
      // SSR/tests/workers fallback: present "next tick"
      return new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    private lastFrameTex?: GPUTexture;
    private lastFrameSize = { w: 0, h: 0 };
    /** Previous-frame SCENE colour GRAB (scene only, pre-post) for SSR, glass refraction and the UI modal world blur —
     *  the mesh FS samples this (holding last frame's image) while the current frame renders into lastFrameTex, so
     *  there's no read-while-write on one texture. Allocated LAZILY, the first frame a reader is on (B2); dropped on
     *  a resize and re-allocated when next needed. */
    private sceneColorGrabTex?: GPUTexture;
    /** True while the one SSR settle frame (scheduled after the grab copy) is pending — see the grab-copy site. */
    private _ssrSettleFrame = false;
    /** True when draw3DMeshes deferred its overlay set to the post-grab overlay pass this frame. */
    private _overlays3DPending = false;
    /** The grab holds the latest on-screen frame (copied at the end of it). False after a live frame that skipped the
     *  copy (no reader on) — the frame a reader turns on refreshes it from lastFrameTex first. */
    private _grabFresh = false;
    /** lastFrameTex holds a finished on-screen frame (not a capture / a fresh texture / a directToSwapchain frame). */
    private _lastFrameLive = false;
    /** The previous live frame needed the grab (a false → true change schedules one follow-up frame). */
    private _grabNeededPrev = false;
    /** Physical pixel size of the last captured frame (lastFrameTex) — the source region for snapshotRegionToBlob. */
    public getLastFrameSize(): { w: number; h: number } { return { ...this.lastFrameSize }; }
    private ensureLastFrameTex() {
      const w = this.canvas.width, h = this.canvas.height;
      if (!this.lastFrameTex || this.lastFrameSize.w !== w || this.lastFrameSize.h !== h) {
        this.lastFrameTex?.destroy();
        this.lastFrameTex = this.device.createTexture({
          size: [w, h],
          format: this.swapChainFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
        });
        // The grab is re-allocated at the new size the next time a reader needs it (_prepareSceneColorGrab).
        this.sceneColorGrabTex?.destroy();
        this.sceneColorGrabTex = undefined;
        this._renderer3D?.setSceneColorGrabTexture(null);
        this._grabFresh = false;
        this._lastFrameLive = false;
        this.lastFrameSize = { w, h };
      }
    }

    /** Does the 3D scene sample the grab this frame? SSR (inline trace / deferred resolve) or glass refraction, and
     *  only when the 3D pass runs at all. */
    private _sceneGrab3DReaders(): boolean {
      const r3d = this._renderer3D;
      if (!r3d || !this.scene3DVisible || this._captureMode?.skip3D) return false;
      return r3d.ssrEnabled || r3d.glassRefraction;
    }

    /** Perf audit C1: could this frame's post chain (FXAA / bloom / grade / film) run? Decided BEFORE the frame draws
     *  (a direct frame cannot be sampled afterwards), so conservative: FXAA counts when the frame MAY draw a 3D mesh —
     *  any visible one in the cached 3D list (or the list is about to be re-walked, or no split list / 3D renderer yet). */
    private _postMayRun(): boolean {
      const w = this.canvas.width, h = this.canvas.height;
      let may3D = false;
      if (this.scene3DVisible && !this._captureMode?.skip3D) {
        if (!this._rlSplit || this._flatShapesDirty) may3D = true;
        else { const m = this._rl3DMeshes; for (let i = 0; i < m.length; i++) if (m[i].visible) { may3D = true; break; } }
      }
      const r3d = this._renderer3D;
      return r3d ? r3d.postProcessMayRun(w, h, may3D) : may3D;
    }

    /** A reader is on this frame: allocate the grab if needed, and when it is STALE (no copy last frame) fill it from
     *  the last on-screen frame — the readers sample the PREVIOUS frame's grab, which would otherwise be black (a new
     *  texture) or an old frame. Own encoder, submitted now: before the UI blur / lo-res / SSR-resolve submissions
     *  that sample it. (That one frame includes its overlays; this frame's own grab copy is scene only.) */
    private _prepareSceneColorGrab(): void {
      const w = this.canvas.width, h = this.canvas.height;
      if (!this.sceneColorGrabTex) {
        this.sceneColorGrabTex = this.device.createTexture({
          size: [w, h],
          format: this.swapChainFormat,
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
          label: 'SceneColorGrab',
        });
        this._grabFresh = false;
      }
      if (this._grabFresh || !this._lastFrameLive || !this.lastFrameTex) return;
      if (RD.on && (RD.f.noSceneGrab || RD.f.directToSwapchain)) return;
      const enc = this.device.createCommandEncoder({ label: 'SceneGrabRefresh' });
      enc.copyTextureToTexture(
        { texture: this.lastFrameTex }, { texture: this.sceneColorGrabTex },
        { width: w, height: h, depthOrArrayLayers: 1 },
      );
      this.device.queue.submit([enc.finish()]);
      this._grabFresh = true;
    }

    /** End one full-resolution hold; the last one re-renders the (scaled) on-screen view. */
    private _releaseFullRes(): void {
        this._fullResHold = Math.max(0, this._fullResHold - 1);
        if (this._fullResHold === 0 && (this._resScaler.scale() < 1 || this._taaSettings.mode !== 'off')) this.scheduleRender();
    }
    /** RESOLUTION SCALING: snapshots hold full resolution from the settled frame until their read-back is encoded
     *  (else the next live frame, scaled again, could land in lastFrameTex before the copy). */
    public async snapshotToBlob(maxWidth = 300): Promise<Blob> {
        this._fullResHold++;
        try { return await this._snapshotToBlobImpl(maxWidth); } finally { this._releaseFullRes(); }
    }
    private async _snapshotToBlobImpl(maxWidth: number): Promise<Blob> {
        // make sure a fresh frame exists
        await this.waitForFrameSettled();

        // Copies lastFrameTex to a map-read buffer (handling the 256-byte row alignment).
        const w = this.lastFrameSize.w, h = this.lastFrameSize.h;
        const bytesPerPixel = 4;
        const unpadded = w * bytesPerPixel;
        const padded = Math.ceil(unpadded / 256) * 256;

        const readBuf = this.device.createBuffer({
            size: padded * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const enc = this.device.createCommandEncoder();
        enc.copyTextureToBuffer(
            { texture: this.lastFrameTex! },
            { buffer: readBuf, bytesPerRow: padded, rowsPerImage: h },
            { width: w, height: h, depthOrArrayLayers: 1 }
        );
        this.device.queue.submit([enc.finish()]);
        await readBuf.mapAsync(GPUMapMode.READ);

        // Strip the row padding; swap B/R only when the canvas format is BGRA (CRASH-6: Android's is rgba8unorm).
        const rgba = readbackToRgba(new Uint8Array(readBuf.getMappedRange()), w, h, padded, this.lastFrameTex?.format ?? this.swapChainFormat);

        readBuf.unmap();
        readBuf.destroy();

        // Uses a 2D canvas (HTML or Offscreen) to scale to width maxWidth and returns a PNG Blob
        const scale = maxWidth / w;
        const tw = Math.max(1, Math.round(maxWidth));
        const th = Math.max(1, Math.round(h * scale));

        const fullCanvas = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(w, h)
            : Object.assign(document.createElement('canvas'), { width: w, height: h });

        const fctx = get2dCtx(fullCanvas);
        fctx.putImageData(new ImageData(rgba, w, h), 0, 0);

        const thumbCanvas = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(tw, th)
            : Object.assign(document.createElement('canvas'), { width: tw, height: th });

        const tctx = get2dCtx(thumbCanvas);
        tctx.drawImage(fullCanvas as any, 0, 0, w, h, 0, 0, tw, th);

        if ('convertToBlob' in thumbCanvas) {
            return await (thumbCanvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
        }
        return await new Promise<Blob>(res => (thumbCanvas as HTMLCanvasElement).toBlob(b => res(b!), 'image/png'));
    }

  stickyAncestorOf(n: Node | null): Group | null {
    let cur = n?.parent ?? null;
    while (cur) {
      if (cur instanceof Group && cur.getType() === 'Sticky Note') return cur;
      cur = cur.parent;
    }
    return null;
  }

  speechBalloonAncestorOf(n: Node | null): Group | null {
    let cur = n?.parent ?? null;
    while (cur) {
      if (cur instanceof Group && cur.getType() === 'Speech Balloon') return cur;
      cur = cur.parent;
    }
    return null;
  }

  private bakeGroupScaleIntoChildren(g: Group) {
    const sx = g.scaleX ?? 1;
    const sy = g.scaleY ?? 1;
    if (sx === 1 && sy === 1) return;

    // cache current logical size so we can update width/height after resetting scale
    const oldW = g.width;
    const oldH = g.height;

    for (const ch of g.children) {
      if (!(ch instanceof Shape)) continue;

      // push S_g into child local transform
      ch.x *= sx;
      ch.y *= sy;
      ch.scaleX = (ch.scaleX ?? 1) * sx;
      ch.scaleY = (ch.scaleY ?? 1) * sy;

      ch.updateLocalMatrix();
      ch.markDirty?.();
    }

    // parent scale becomes identity; keep its position and rotation unchanged
    g.scaleX = 1;
    g.scaleY = 1;

    // update group’s logical size to match the visual size we just baked
    g.width  = oldW * sx;
    g.height = oldH * sy;

    g.updateLocalMatrix();
    g.calculateBoundingBox();  // updates handle box/visuals only
    g.markDirty();
  }

    
  /** Push this group's scale down to leaves without changing the group's x,y.
   *  Works for nested groups; avoids the "jump" by not calling recalculateSize(). */
  public bakeScaleToLeaves(g: Group): void {
    const sx = g.scaleX ?? 1;
    const sy = g.scaleY ?? 1;
    const oldW = g.width;
    const oldH = g.height;

    if (sx !== 1 || sy !== 1) {
      // 1) Pre-multiply this group's scale into children (matrix-wise: childLocal' = Sg * childLocal)
      for (const ch of g.children) {
        // translate in parent's local axes (transform accessors live on the Node base)
        ch.x *= sx;
        ch.y *= sy;

        // scale the child
        ch.scaleX = (ch.scaleX ?? 1) * sx;
        ch.scaleY = (ch.scaleY ?? 1) * sy;

        ch.updateLocalMatrix();
        if (ch instanceof Shape) ch.markDirty();
      }

      // 2) Normalize this group scale back to 1 **without** moving it
      g.scaleX = 1;
      g.scaleY = 1;

      // 3) Update logical size to match the visual size we just baked (no recenter!)
      g.width  = oldW * sx;
      g.height = oldH * sy;

      g.updateLocalMatrix();
      g.calculateBoundingBox(); // refresh handles only
      g.markDirty();
    }

    // 4) Recurse so any child groups push *their* (now multiplied) scale down to their leaves
    for (const ch of g.children) {
      if (ch instanceof Group) this.bakeScaleToLeaves(ch);
    }
  }

  private worldOf(n: Node): mat4 {
    return mat4.mul(mat4.create(), n.parentChainMatrix, (n as Shape|Group).localMatrix);
  }

  public setFromLocalMatrix(n: Shape|Group, m: mat4) {
    const tx = m[12], ty = m[13];
    const m00 = m[0], m01 = m[1], m10 = m[4], m11 = m[5];
    const sx = Math.hypot(m00, m01) || 1;
    const sy = Math.hypot(m10, m11) || 1;
    const rot = Math.atan2(m01, m00);
    n.x = tx; n.y = ty;
    n.rotation = rot;
    n.scaleX = sx;
    n.scaleY = sy;
    n.updateLocalMatrix();
  }

  public getNodeDepth(node: Node): number {
    let depth = 0;
    let current = node.parent;
    while (current) {
      depth++;
      current = current.parent;
    }
    return depth;
  }

  // Returns the chain from root → leaf for a node
  public buildHitChain(n: Node): Node[] {
    const chain: Node[] = [];
    let cur: Node | null = n;
    while (cur) { chain.unshift(cur); cur = cur.parent; }
    return chain;
  }

  // Highest Group in a chain (closest to root)
  public highestGroupInChain(chain: Node[]): Group | null {
    for (const n of chain) if (n instanceof Group) return n; // first group in root→leaf order
    return null;
  }

  // Return the next deeper node after `from` in the chain (groups or the leaf).
  // If `from` is null, start at the highest group if any, else the leaf.
  public nextDeeperNode(chain: Node[], from: Node | null): Node {
    const highestGroup = this.highestGroupInChain(chain);
    if (!from) return highestGroup ?? chain[chain.length - 1]; // leaf if no group
    const idx = chain.indexOf(from);
    if (idx < 0) return highestGroup ?? chain[chain.length - 1];
    return chain[Math.min(idx + 1, chain.length - 1)];
  }

  safeInvert(out: mat4, m: mat4): mat4 {
    if (!mat4.invert(out, m)) {
      // Fallback to identity; up to you if you want a console.warn here
      mat4.identity(out);
    }
    return out;
  }

  private texturedQuadVB!: GPUBuffer;
  private texturedQuadIB!: GPUBuffer;
  private rasterQuadVB!: GPUBuffer;
  private rasterQuadIB!: GPUBuffer;

  private getTexturedQuad(): { vb: GPUBuffer; ib: GPUBuffer; } {
    if (!this.texturedQuadVB) {
      const verts = new Float32Array([
        -0.5,-0.5, 0,0,
        0.5,-0.5, 1,0,
        -0.5, 0.5, 0,1,
        0.5, 0.5, 1,1,
      ]);
      this.texturedQuadVB = this.device.createBuffer({
        size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true
      });
      new Float32Array(this.texturedQuadVB.getMappedRange()).set(verts);
      this.texturedQuadVB.unmap();

      const idx = new Uint16Array([0,1,2, 2,1,3]);
      this.texturedQuadIB = this.device.createBuffer({
        size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true
      });
      new Uint16Array(this.texturedQuadIB.getMappedRange()).set(idx);
      this.texturedQuadIB.unmap();
    }
    return { vb: this.texturedQuadVB, ib: this.texturedQuadIB };
  }

  private getRasterTexturedQuad(): { vb: GPUBuffer; ib: GPUBuffer; } {
    if (!this.rasterQuadVB) {
      const verts = new Float32Array([
        -1,-1, 0,1,  // bottom-left -> texture bottom (was 0,0)
        1,-1, 1,1,  // bottom-right -> texture bottom (was 1,0)
        -1, 1, 0,0,  // top-left -> texture top (was 0,1)
        1, 1, 1,0,  // top-right -> texture top (was 1,1)
      ]);
      this.rasterQuadVB = this.device.createBuffer({
        size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true
      });
      new Float32Array(this.rasterQuadVB.getMappedRange()).set(verts);
      this.rasterQuadVB.unmap();

      const idx = new Uint16Array([0,1,2, 2,1,3]);
      this.rasterQuadIB = this.device.createBuffer({
        size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true
      });
      new Uint16Array(this.rasterQuadIB.getMappedRange()).set(idx);
      this.rasterQuadIB.unmap();
    }
    return { vb: this.rasterQuadVB, ib: this.rasterQuadIB };
  }

  public illustrationMode: boolean = false;
  public illustrationBounds: { width: number; height: number } | undefined = undefined;
  public backgroundPatternFixed: boolean = false;
  /** When set, overrides the aspect-ratio–derived pixel size from getIllustrationPixelSize(). */
  private _explicitDocPixelSize: { w: number; h: number } | null = null;

  setIllustrationMode(enabled: boolean): void {
    this.illustrationMode = enabled;
    if (this.rasterTextureManager && this.illustrationMode && this.illustrationBounds) {
      const { w, h } = this.getIllustrationPixelSize();
      this.rasterTexture = this.rasterTextureManager.ensureTexture(w, h);
    }
  }

  getIllustrationMode(): boolean {
      return this.illustrationMode;
  }

  getIllustrationBounds(): { width: number; height: number } | undefined {
      return this.illustrationBounds;
  }

  /**
   * Compute the pixel dimensions that the raster texture should have.
   * In illustration mode, this matches the illustration bounds' aspect ratio
   * using the larger canvas dimension as the base. Outside illustration mode,
   * it falls back to the HTML canvas element size.
   */
  public getIllustrationPixelSize(): { w: number; h: number } {
    // Explicit size set via setDocumentSize() takes priority.
    if (this._explicitDocPixelSize) return this._explicitDocPixelSize;

    if (this.illustrationMode && this.illustrationBounds) {
      const { width: bw, height: bh } = this.illustrationBounds;
      const aspect = bw / bh;
      // Use the larger of the two canvas dimensions as the pixel budget,
      // then compute the other dimension from the aspect ratio.
      const maxPx = Math.max(this.canvas.width, this.canvas.height);
      let pw: number, ph: number;
      if (aspect >= 1) {
        // landscape or square illustration
        pw = maxPx;
        ph = Math.round(maxPx / aspect);
      } else {
        // portrait illustration
        ph = maxPx;
        pw = Math.round(maxPx * aspect);
      }
      return { w: pw, h: ph };
    }
    return { w: this.canvas.width, h: this.canvas.height };
  }

  setIllustrationBounds(width: number, height: number): void {
      this.illustrationBounds = { width, height };
      // Invalidate cached world-space quad so it's rebuilt with new dimensions
      this.rasterWorldQuadVB?.destroy();
      this.rasterWorldQuadVB = undefined as any;
      this.rasterWorldQuadIB?.destroy();
      this.rasterWorldQuadIB = undefined as any;

      // Resize the raster output texture to match the illustration aspect ratio
      if (this.rasterTextureManager) {
        const { w, h } = this.getIllustrationPixelSize();
        this.rasterTexture = this.rasterTextureManager.ensureTexture(w, h);
      }
  }

  setBackgroundPatternFixed(fixed: boolean): void {
      this.backgroundPatternFixed = fixed;
  }

  /**
   * Pin the raster-texture pixel size to an exact value, bypassing the
   * aspect-ratio–derived computation in getIllustrationPixelSize().
   * Pass null to revert to the automatic computation.
   */
  setExplicitDocumentPixelSize(size: { w: number; h: number } | null): void {
    this._explicitDocPixelSize = size;
    if (this.rasterTextureManager) {
      const { w, h } = this.getIllustrationPixelSize();
      this.rasterTexture = this.rasterTextureManager.ensureTexture(w, h);
    }
  }

  // Cached GPUTexture for the artboard 2D-content capture fed to the free3D textured-quad (docs/specs/textured-artboard.md).
  private _artboardTex: GPUTexture | null = null;
  private _artboardTexW = 0;
  private _artboardTexH = 0;
  // Optional hook (wired by ShapeManager) to composite ephemera — a DOM overlay, not in the GPU frame — onto the
  // captured artboard canvas before it's uploaded, so the quad shows raster + vectors + ephemera.
  private _artboardCompositor: ((canvas: OffscreenCanvas | HTMLCanvasElement, outW: number, outH: number) => void) | null = null;
  public setArtboardEphemeraCompositor(fn: ((canvas: OffscreenCanvas | HTMLCanvasElement, outW: number, outH: number) => void) | null): void { this._artboardCompositor = fn; }

  /**
   * Capture the artboard's 2D content (raster + vectors + ephemera, transparent, straight alpha) into a GPUTexture
   * for the free3D artboard quad. Renders a transparent capture frame → reads back the artboard region as a canvas →
   * composites ephemera on top (via the compositor hook) → uploads to `_artboardTex`. Straight alpha throughout (the
   * readback un-premultiplies), so the quad draws it with standard "over" blending. Caller sets the artboard framing.
   */
  async captureArtboardToTexture(scissor: { x: number; y: number; w: number; h: number }): Promise<{ texture: GPUTexture; w: number; h: number } | null> {
    const w = Math.max(1, scissor.w), h = Math.max(1, scissor.h);
    const canvas = await this.captureArtboardRegionCanvas(scissor, w, h);   // raster+vectors (self-manages _captureMode)
    this._artboardCompositor?.(canvas, w, h);                               // + ephemera on top (if wired)
    if (!this._artboardTex || this._artboardTexW !== w || this._artboardTexH !== h) {
      this._artboardTex?.destroy();
      this._artboardTex = this.device.createTexture({
        size: [w, h], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this._artboardTexW = w; this._artboardTexH = h;
    }
    this.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: this._artboardTex }, [w, h]);
    return { texture: this._artboardTex, w, h };
  }

  async snapshotRegionToBlob(
    srcX: number, srcY: number, srcW: number, srcH: number,
    outW: number, outH: number,
    mimeType: string = 'image/png',
    quality: number = 0.92,
  ): Promise<Blob> {
    const outCanvas = await this.snapshotRegionToCanvas(srcX, srcY, srcW, srcH, outW, outH);
    if ('convertToBlob' in outCanvas) return (outCanvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
    return new Promise<Blob>(res => (outCanvas as HTMLCanvasElement).toBlob(b => res(b!), mimeType, quality));
  }

  /** Read back a region of lastFrameTex and return it as a 2D canvas scaled to outW×outH (alpha preserved). The
   *  canvas form lets callers composite (e.g. draw ephemera on top) before encoding. `skipWait` = the caller already
   *  rendered the frame to read (a capture) and only needs the GPU to finish — used so captures don't depend on the
   *  rAF loop producing a fresh frame (which lets the loop be suspended during a capture). Default false = thumbnail
   *  path: schedule + wait for a live frame. srcX/Y/W/H are physical canvas px. */
  async snapshotRegionToCanvas(
    srcX: number, srcY: number, srcW: number, srcH: number,
    outW: number, outH: number,
    skipWait = false,
  ): Promise<OffscreenCanvas | HTMLCanvasElement> {
    if (skipWait) return this._snapshotRegionToCanvasImpl(srcX, srcY, srcW, srcH, outW, outH, true);
    this._fullResHold++;   // resolution scaling: see snapshotToBlob
    try { return await this._snapshotRegionToCanvasImpl(srcX, srcY, srcW, srcH, outW, outH, false); } finally { this._releaseFullRes(); }
  }
  private async _snapshotRegionToCanvasImpl(
    srcX: number, srcY: number, srcW: number, srcH: number,
    outW: number, outH: number,
    skipWait = false,
  ): Promise<OffscreenCanvas | HTMLCanvasElement> {
    if (skipWait) await this.device.queue.onSubmittedWorkDone();   // caller's render() already submitted the frame
    else await this.waitForFrameSettled();

    const tw = this.lastFrameSize.w, th = this.lastFrameSize.h;
    srcX = Math.max(0, Math.min(tw - 1, Math.round(srcX)));
    srcY = Math.max(0, Math.min(th - 1, Math.round(srcY)));
    srcW = Math.max(1, Math.min(tw - srcX, Math.round(srcW)));
    srcH = Math.max(1, Math.min(th - srcY, Math.round(srcH)));
    outW = Math.max(1, outW);
    outH = Math.max(1, outH);

    const bytesPerPixel = 4;
    const padded = Math.ceil(srcW * bytesPerPixel / 256) * 256;

    const readBuf = this.device.createBuffer({
      size: padded * srcH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.lastFrameTex!, origin: [srcX, srcY, 0] },
      { buffer: readBuf, bytesPerRow: padded, rowsPerImage: srcH },
      { width: srcW, height: srcH, depthOrArrayLayers: 1 },
    );
    this.device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);

    // Canvas format → RGBA (B/R swapped only for BGRA, CRASH-6). The frame is rendered with "over" blending onto a
    // (possibly transparent) clear, so its alpha is PREMULTIPLIED — un-premultiply to straight alpha here, which
    // canvas/ImageData/PNG expect (fixes dark halos on anti-aliased/semi-transparent edges). No-op for opaque pixels
    // (a=255) → thumbnails unchanged.
    const rgba = readbackToRgba(new Uint8Array(readBuf.getMappedRange()), srcW, srcH, padded, this.lastFrameTex?.format ?? this.swapChainFormat, { unpremultiply: true });
    readBuf.unmap();
    readBuf.destroy();

    const srcCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(srcW, srcH)
      : Object.assign(document.createElement('canvas'), { width: srcW, height: srcH });
    get2dCtx(srcCanvas).putImageData(new ImageData(rgba, srcW, srcH), 0, 0);

    const outCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(outW, outH)
      : Object.assign(document.createElement('canvas'), { width: outW, height: outH });
    get2dCtx(outCanvas).drawImage(srcCanvas as any, 0, 0, srcW, srcH, 0, 0, outW, outH);
    return outCanvas;
  }

  /** Capture the artboard region as a 2D canvas (transparent, raster+vectors) — the canvas form so callers can
   *  composite ephemera on top before encoding. SUSPENDS the rAF loop for the duration so no concurrent loop-driven
   *  render() sees `_captureMode` (which would stall the on-screen frame + risk clobbering shared render state); the
   *  capture is self-contained (renders once, reads back via skipWait). Restores the loop + a normal frame after. */
  async captureArtboardRegionCanvas(
    scissor: { x: number; y: number; w: number; h: number },
    outW: number, outH: number,
    opts: { transparent: boolean; skip3D: boolean } = { transparent: true, skip3D: true },
  ): Promise<OffscreenCanvas | HTMLCanvasElement> {
    const prevSuspended = this._suspended;
    this._suspended = true;          // block loop-driven renders while _captureMode is set (no bleed / re-entrancy)
    this._captureMode = opts;
    try {
      await this.render();           // the ONE capture frame → lastFrameTex (not presented)
      return await this.snapshotRegionToCanvas(scissor.x, scissor.y, scissor.w, scissor.h, outW, outH, /*skipWait*/ true);
    } finally {
      this._captureMode = null;
      this._suspended = prevSuspended;
      if (!prevSuspended) this.scheduleRender();   // restore the on-screen frame (unless the Shell owns the canvas)
    }
  }

}
