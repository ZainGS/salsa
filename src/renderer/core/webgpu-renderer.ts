import { SceneGraph } from "../../scene-graph/core/scene-graph";
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
import { CacheService } from "../../services/cache-service";
import { TextDrawingService } from "../../services/drawing/text-drawing-service";
import { Rectangle } from "../../scene-graph/shapes/rectangle";
import { Scribble } from "../../scene-graph/shapes/scribble";
import { Line } from "../../scene-graph/shapes/line";
import { Pattern } from "../../scene-graph/shapes/pattern";
import { BindGroupManager } from "./managers/bindgroup-manager";
import { PipelineManager } from "./managers/pipeline-manager";
import { RasterTextureManager } from "../raster/raster-texture-manager";
import { Section } from "../../scene-graph/shapes/section";
import { SectionDrawingService } from "../../services/drawing/section-drawing-service";
import { Group } from "../../scene-graph/shapes/base/group";
import { StagingContainer } from "../util/staging-container";
import { StrokesStagingBuffer } from "../caches/buffers/strokes-staging-buffer";
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
import { aabbOverlaps, getWorldAABB, viewportAABB } from "../util/aabb";

/** Minimal contract so the renderer can draw the raster-text preview
 *  without importing the concrete RasterTextService (which itself imports
 *  WebGPURenderer, creating a circular dependency). */
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
import type { FrameLinkAnimation } from '../../animation';
import { DitherEngine } from '../raster/effects/dither-engine';
import { RasterSelectionEngine } from "../raster/selection/raster-selection-engine";
import { SelectionOverlayRenderer } from "../raster/selection/selection-overlay-renderer";
import type { SelectionOverlayState } from "../raster/selection/selection-overlay-renderer";
import { LiveTextNode } from "../../scene-graph/shapes/live-text";
import { Renderer3D } from '../3d/renderer-3d';
import { Camera3D } from '../3d/camera-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import { GpRenderer3D } from '../3d/gp-renderer-3d';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';

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
  | { kind: 'boxSelecting'; startCanvas: Vec2; rect: DOMRect }
  | { kind: 'rotating'; data: RotatingData }
  | { kind: 'scaling'; data: ScalingData }
  | { kind: 'endpointDragging'; data: EndpointDragData }
  | { kind: 'draggingPlacement'; data: PlacementDragData }
  | { kind: 'resizingPlacement'; data: PlacementResizeDragData }
  | { kind: 'rotatingPlacement'; data: PlacementRotateDragData };

// src/renderer/webgpu-renderer.ts
export class WebGPURenderer {

  // Simple state machine for renderer modes
  private mode: Mode = { kind: 'idle' };

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
  private canvas!: HTMLCanvasElement;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private swapChainFormat: GPUTextureFormat = 'bgra8unorm';

  private renderList: Node[] = [];
  private renderListDirty = true;

  // Flat list of every Shape in the scene graph, rebuilt only when the tree STRUCTURE changes
  // (shapes added/removed). During drag/pan/scale the list of shapes is identical — only the
  // viewport filter and sort need to re-run, not the full O(N nodes) tree walk.
  private _flatShapes: Shape[] = [];
  private _flatShapesDirty = true;

  /** Pre-render callbacks (called at the start of each render frame). */
  private preRenderCallbacks: Array<() => boolean> = [];

  /** Get the canvas element. */
  public getCanvas(): HTMLCanvasElement { return this.canvas; }

  /**
   * Register a callback to run before each render frame.
   * Return `true` to request another frame (e.g. for damping).
   */
  public addPreRenderCallback(cb: () => boolean): void {
    if (!this.preRenderCallbacks.includes(cb)) this.preRenderCallbacks.push(cb);
  }

  /** Remove a pre-render callback. */
  public removePreRenderCallback(cb: () => boolean): void {
    const idx = this.preRenderCallbacks.indexOf(cb);
    if (idx >= 0) this.preRenderCallbacks.splice(idx, 1);
  }

  // User-Application State
  private pipelineManager: PipelineManager | null = null;
  private cacheService: CacheService | null = null;
  private lineDrawingService: LineDrawingService | null = null;
  private patternDrawingService: PatternDrawingService | null = null;
  private scribbleDrawingService: ScribbleDrawingService | null = null;
  private sectionDrawingService: SectionDrawingService | null = null;
  private highlightDrawingService: HighlightDrawingService | null = null;
  private textDrawingService: TextDrawingService | null = null;
  private sdfTextDrawingService: SdfTextDrawingService | null = null;
  private rasterDrawingService: import('../../services/raster-drawing-service').RasterDrawingService | null = null;
  private rasterSelectionService: import('../../services/raster-selection-service').RasterSelectionService | null = null;
  private rasterMoveService: import('../../services/raster-move-service').RasterMoveService | null = null;
  private stampDrawingService: StampDrawingService | null = null;
  private polygonDrawingService: PolygonDrawingService | null = null;
  private eraserService: EraserService | null = null;
  private interactionService: InteractionService;
  private selectionService!: SelectionService;  

  // Shape & World 
  private sceneGraph!: SceneGraph;

  // Multisample Anti-Aliasing
  // private msaaTexture!: GPUTexture;
  // private msaaTextureView!: GPUTextureView;
  
  private webGPURenderStrategy!: WebGPURenderStrategy;
  private rasterTextureManager?: RasterTextureManager;
  private _rasterPaintEngine?: RasterPaintEngine;
  private _rasterCompositor?: RasterCompositor;
  private _rasterSelectionEngine?: RasterSelectionEngine;
  private _selectionOverlayRenderer?: SelectionOverlayRenderer;
  private _renderer3D?: Renderer3D;
  private _gpRenderer3D?: GpRenderer3D;
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
  private rasterCompositionList?: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: import('../raster/effects/dither-engine').DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>;
  // Optional foreground raster layer list (layers above the 3D divider)
  private rasterForegroundList?: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: import('../raster/effects/dither-engine').DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>;
  // Foreground composite output texture
  private rasterTextureFG?: GPUTexture;

  // Setter to update composition list from external managers
  public setRasterCompositionList(list: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: import('../raster/effects/dither-engine').DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>) {
    this.rasterCompositionList = list;
    // Clear the foreground list — if the caller is using the flat (non-split) path,
    // any stale rasterForegroundList from a previous 3D-divider split would otherwise
    // stay and composite on top of 3D meshes, hiding them.
    this.rasterForegroundList = undefined;
    this.scheduleRender();
  }

  /** Set the split composition lists (background + foreground) for 3D divider support. */
  public setRasterCompositionListSplit(
    background: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: import('../raster/effects/dither-engine').DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>,
    foreground: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: import('../raster/effects/dither-engine').DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>,
  ) {
    this.rasterCompositionList = background;
    this.rasterForegroundList = foreground.length > 0 ? foreground : undefined;
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
  private _connectorService: ConnectorService | null = null;

  /** Last known cursor position in world space (updated on pointermove). */
  private _cursorWorldX = 0;
  private _cursorWorldY = 0;

  // Groups with modified child objects that need a bbox recalc on mouseup
  private pendingGroupBounds = new Set<Group>();

  // background resources (persistent)
  private bgResBuf!: GPUBuffer;        // vec4{width,height,0,0} (16B)
  private bgInvWorldBuf!: GPUBuffer;   // mat4 (64B)
  private bgBgColorBuf!: GPUBuffer;    // vec4 (16B)
  private bgDotColorBuf!: GPUBuffer;   // vec4 (16B)
  private bgBindGroup!: GPUBindGroup;
  private bgQuadVB!: GPUBuffer;
  private bgDirty = { res: true, matrix: true, colors: true };
  private _tmpInv = mat4.create();

  // Bound event handlers stored as stable references for proper add/remove
  private _boundPointerDown = this.handlePointerDown.bind(this);
  private _boundPointerMove = this.handlePointerMove.bind(this);
  private _boundPointerUp = this.handlePointerUp.bind(this);
  private _boundWheel = this.handleWheel.bind(this);
  
  // rAF scheduler (inside WebGPURenderer)
  private rafId: number | null = null;
  private needsFrame = false;       // set when something changed
  private live = false;             // on/off switch for the loop
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

    if (this.needsFrame) {
      this.needsFrame = false;
      this.render();
    }

    // stay alive: if something else marks needsFrame before next vsync,
    // weâ€™ll draw it; otherwise weâ€™ll spin very cheaply.
    this.requestTick();
  };

  // rAF scheduler
  public scheduleRender() {
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
      if (this.interactiveCount > 0) this.scheduleRender();
    });
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
    // This makes aspectX = 2.0/1669 â‰ˆ 0.0012, aspectY = 2.0/991 â‰ˆ 0.0020
    // The ratio aspectY/aspectX â‰ˆ 1.684 compensates for the texture stretch
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

  private handleKeyDown(event: KeyboardEvent) {

      const textShapes = ['Sticky Note', 'SDFText', 'Speech Balloon'];

      if (this.interactionService.selectedNodes.size === 1 
          && textShapes.includes(([...this.interactionService.selectedNodes][0] as Shape).getType())
      ) { return; }

      if ((event.key === 'g' || event.key === 'G') && this.interactionService.selectedNodes.size > 1) {
          this.groupSelectedShapes();
          event.preventDefault();
      }
      else if ((event.key === 'u' || event.key === 'U') && this.interactionService.selectedNodes.size >= 1) {
          this.ungroupSelectedShapes();
          event.preventDefault();
      }
  }

  private initializeCanvas(newCanvas: HTMLCanvasElement) {
      // Canvas is used for textureView in renderPassDescriptor, 
      // Mouse Events, background pipeline, etc.
      this.canvas = newCanvas;
      // Pointer Event Listeners (use stable bound references for proper removal)
      this.canvas.addEventListener('pointerdown', this._boundPointerDown);
      this.canvas.addEventListener('pointermove', this._boundPointerMove);
      this.canvas.addEventListener('pointerup', this._boundPointerUp);
      this.canvas.addEventListener('wheel', this._boundWheel, { passive: false });
  }

  // Method to get the GPUDevice
  public getDevice(): GPUDevice {
      return this.device;
  }
  
  public setWebGPURenderStrategy(strategy: WebGPURenderStrategy) {
      this.webGPURenderStrategy = strategy;
  }

  public setSceneGraph(sceneGraph: SceneGraph) {
      this.sceneGraph = sceneGraph;
      this.selectionService = new SelectionService(sceneGraph.root);
      this._flatShapesDirty = true;
      this.renderListDirty = true;
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
    
  private handleWheel(event: WheelEvent) {
    if (event.ctrlKey) {
      // Prevent the default zoom behavior in the browser
      event.preventDefault(); 

      // Invert to zoom in on scroll up
      const zoomDelta = event.deltaY * -0.001; 

      // Get mouse position relative to the canvas center (screen-space origin)
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = event.clientX - (rect.left + rect.width / 2);
      const mouseY = event.clientY - (rect.top  + rect.height / 2);

      // Adjust the zoom factor and pan offset
      this.interactionService.adjustZoom(
          zoomDelta, 
          mouseX, 
          mouseY, 
          this.illustrationMode, 
          this.illustrationBounds
      );

      // this.bgDirty.matrix = true;
      // this.renderListDirty = true;

      for (const node of this.interactionService.selectedNodes) {
          (node as Shape).triggerRerender();
      }
    }
  }

  // Determines angle the mouse has moved around the shape during shape rotation
  private calculateMouseAngle(mx: number, my: number, s: Shape): number {
    const [wx, wy] = this.canvasPxToWorld(mx, my);
    const model = mat4.mul(mat4.create(), s.parentChainMatrix, s.localMatrix);
    const centerW = vec4.transformMat4(vec4.create(), vec4.fromValues(0,0,0,1), model);
    return Math.atan2(wy - centerW[1], wx - centerW[0]);
  }

  private isolatedTarget: Node | null = null;
  private lastClickTime: number = 0;
  
  private handlePointerDown(event: PointerEvent) {
    // Track pointer state for shader uniforms
    this.interactionService.pointerDown = true;

    // Only schedule render if a mode is entered or selection changes
    const DOUBLE_CLICK_THRESHOLD = 300; // ms
    const now = Date.now();
    const isDoubleClick = (now - this.lastClickTime) < DOUBLE_CLICK_THRESHOLD;
    this.lastClickTime = now;

    const rect = this.cacheRect();

    // Middle mouse or Pan tool â†’ start panning
    if (event.button === 1 || this.interactionService.isPanToolSelected) {
      this.mode = { kind: 'panning', lastClient: [event.clientX, event.clientY], rect };
      event.preventDefault();
      this.scheduleRender();
      this.interactionService.canvas.style.cursor = `url('${panningCursorUrl}'), crosshair`;
      return;
    }

    if (event.button !== 0) return;

    // During armature / weight paint mode, suppress 2D box-select entirely.
    if (this.interactionService.suppressBoxSelect) return;

    // If a drawing tool is active, clear selection and let the tool handle it
    if (
      this.lineDrawingService?.isEnabled ||
      this.scribbleDrawingService?.isEnabled ||
      this.sectionDrawingService?.isEnabled ||
      this.eraserService?.isEnabled ||
      this.highlightDrawingService?.isEnabled ||
      this.patternDrawingService?.isEnabled ||
      this.stampDrawingService?.isEnabled ||
      this.polygonDrawingService?.isEnabled ||
      this.textDrawingService?.isEnabled ||
      this.sdfTextDrawingService?.isEnabled ||
      this.rasterDrawingService?.isEnabled ||
      this.rasterSelectionService?.isEnabled ||
      this.rasterMoveService?.isEnabled
    ) {
      this.interactionService.clearSelectedNodes();
      this.scheduleRender();
      return;
    }

    // Compute world pos from canvas offsets
    const [mouseX, mouseY] = [event.offsetX, event.offsetY];
    const [worldX, worldY] = this.transformMouseCoordinatesToWorldSpace(mouseX, mouseY);

    // LINE ENDPOINT HANDLE â†’ set endpointDragging mode
    if (this.interactionService.selectedNodes.size === 1) {
      const sel = Array.from(this.interactionService.selectedNodes)[0];
      if (sel instanceof Line) {
        const endpointThreshold = 0.02;
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
          this.mode = {
            kind: 'endpointDragging',
            data: { line: sel, which: dStart <= dEnd ? 'start' : 'end' },
          };
          this.interactionService.beginInteractive();
          this.scheduleRender();
          return;
        }
      }
    }

    // ROTATION â†’ set rotating mode
    if (this.interactionService.selectedNodes.size === 1) {
      const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
      if (isNearRotationHandle(shape, [worldX, worldY])) {
        const initialMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
        this.mode = {
          kind: 'rotating',
          data: { initialMouseAngle, initialRotation: shape.rotation }
        };
        this.interactionService.beginInteractive();
        return;
      }
    }

    // SCALING â†’ set scaling mode
    if (this.interactionService.selectedNodes.size === 1) {
      const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
      const side = getScalingSide(shape, [worldX, worldY]);
      if (side) {
        const sx0 = shape.scaleX ?? 1;
        const sy0 = shape.scaleY ?? 1;
        const baseW = shape.width;   // the groupâ€™s local width (before scale)
        const baseH = shape.height;  // the groupâ€™s local height (before scale)

        const initial: ShapeDimensions & { baseW:number; baseH:number; scaleX:number; scaleY:number } = {
          x: shape.x,
          y: shape.y,
          // effective starting world size along the groupâ€™s axes:
          width:  baseW * sx0,
          height: baseH * sy0,
          baseW, baseH,
          scaleX: sx0, scaleY: sy0,
        };
        this.mode = {
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
    if (this._ephemeraHandleHitTester) {
      const handleHit = this._ephemeraHandleHitTester(worldX, worldY);
      if (handleHit) {
        if (handleHit.kind === 'resize') {
          this.mode = {
            kind: 'resizingPlacement',
            data: { layerId: handleHit.layerId, placementId: handleHit.placementId, handle: handleHit.handle, anchorX: handleHit.anchorX, anchorY: handleHit.anchorY },
          };
        } else {
          this.mode = {
            kind: 'rotatingPlacement',
            data: { layerId: handleHit.layerId, placementId: handleHit.placementId, centerX: handleHit.centerX, centerY: handleHit.centerY, startAngle: handleHit.startAngle, startRotation: handleHit.startRotation },
          };
        }
        this.interactionService.beginInteractive();
        this.scheduleRender();
        return;
      }
    }

    // Ephemera placement body hit-test (overlay renders above shapes, so check first)
    if (this._ephemeraHitTester) {
      const hit = this._ephemeraHitTester(worldX, worldY);
      if (hit) {
        this._ephemeraSelectCallback?.(hit.layerId, hit.placementId);
        this.mode = {
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
        this.interactionService.beginInteractive();
        this.scheduleRender();
        return;
      }
    }

    // Nothing ephemera-related was hit — clear placement selection
    this._ephemeraDeselectCallback?.();

    // // Hit test
    let topNode = this.selectionService.findFirstNodeUnderMouse(worldX, worldY);

    const clickedSelected = topNode && this.interactionService.selectedNodes.has(topNode) && !event.shiftKey;
    if (clickedSelected) {
      // Do NOT change the selection; keep the whole multi-selection.
      // Just set up dragging with the clicked node as the primary.

      // Build drag data exactly like you do below, but force `primary = topNode`
      const selected = Array.from(this.interactionService.selectedNodes);
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
        return this.safeInvert(inv, n.parentChainMatrix);
      });

      this.mode = {
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

      this.scheduleRender();
      return; // <- IMPORTANT: skip the rest of the selection-changing code
    }

    // If you clicked SDFText inside a Sticky Note, select the Sticky instead.
    if (topNode) {
      const sticky = this.stickyAncestorOf(topNode);
      if (sticky) topNode = sticky;
    }

    // Same for Speech Balloon — select the parent balloon, not the child Polygon/SDFText.
    if (topNode) {
      const balloon = this.speechBalloonAncestorOf(topNode);
      if (balloon) topNode = balloon;
    }

    // Selection resolution
    let selectionTarget: Node | null = null;

    if (topNode) {
      if (topNode.locked) return;

      const chain = this.buildHitChain(topNode);

      // If we were isolating, but this click is outside that subtree, reset.
      if (this.isolatedTarget && !chain.includes(this.isolatedTarget)) {
        this.isolatedTarget = null;
        this.interactionService.clearSelectedNodes();
      }

      if (isDoubleClick) {
        // Initialize to highest group (or leaf) if needed, then go one step deeper.
        if (!this.isolatedTarget || !chain.includes(this.isolatedTarget)) {
          this.isolatedTarget = this.highestGroupInChain(chain) ?? topNode;
        }
        this.isolatedTarget = this.nextDeeperNode(chain, this.isolatedTarget);
        selectionTarget = this.isolatedTarget;
      } else {
        // Single click: always highest (top-most) group under cursor, else the leaf.
        this.isolatedTarget = this.highestGroupInChain(chain) ?? topNode;
        selectionTarget = this.isolatedTarget;
      }
    }

    // Apply selection (shift behavior unchanged)
    if (selectionTarget) {
      if (event.shiftKey) {
        if (this.interactionService.selectedNodes.has(selectionTarget)) {
          this.interactionService.deselectNode(selectionTarget);
        } else {
          this.interactionService.selectNode(selectionTarget);
        }
      } else {
        if (!this.interactionService.selectedNodes.has(selectionTarget)) {
          this.interactionService.clearSelectedNodes();
          this.interactionService.selectNode(selectionTarget);
        }
      }
      this.scheduleRender();
    } 
    else {
      // Start BOX SELECT
      if (!event.shiftKey) this.interactionService.clearSelectedNodes();
      const [startX, startY] = this.transformMouseCoordinatesToWorldSpace(mouseX, mouseY);
      const previewBox = new Rectangle(
        startX, startY,
        1, 1,
        { r: 0.6, g: 0.55, b: 0.95, a: 0.25 },
        undefined,
        1,
        this.interactionService
      );
      previewBox.isPreview = true;
      previewBox.scaleX = 0.001;
      previewBox.scaleY = 0.001;
      this.interactionService.boxSelectPreview = previewBox;
      previewBox.markDirty();

      this.mode = { kind: 'boxSelecting', startCanvas: [mouseX, mouseY], rect };
      this.scheduleRender();
      // this.interactionService.canvas.style.cursor = this.getRandomCursor();
      return;
    }

    // If something is selected, begin DRAG
    const selected = Array.from(this.interactionService.selectedNodes);
    if (selected.length > 0) {
      let primary = selected[0]; // default fallback

      if (topNode && this.interactionService.selectedNodes.has(topNode)) {
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

      // Primaryâ€™s initial world position (used to compute delta)
      const primaryX0 = (primary as Node).x;
      const primaryY0 = (primary as Node).y;

      // Precompute world->parentLocal at drag start
      const invParentAtDrag = nodes.map(n => {
        const inv = mat4.create();
        // n.parentChainMatrix == parent's world transform for n
        // (root if no parent)
        return this.safeInvert(inv, n.parentChainMatrix);
      });

      this.mode = {
        kind: 'dragging',
        data: {
          primary, rect, dragOffset, nodes, x0, y0, primaryX0, primaryY0,
          initialGroupChildPositions,
          invParentAtDrag,  // <â€” pass it along
        }
      };

      this.scheduleRender();
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
      if (this.interactionService.selectedNodes.size <= 1) {
          console.log("Select at least 2 shapes to group.");
          return;
      }
  
      const selectedNodes = Array.from(this.interactionService.selectedNodes);
  
      // Step 1: Only group top-level selected nodes (skip nested ones)
      const topLevelNodes = selectedNodes.filter(node => {
          let current = node.parent;
          while (current) {
              if (this.interactionService.selectedNodes.has(current)) return false;
              current = current.parent;
          }
          return true;
      });
  
      const shapesToGroup = topLevelNodes.filter(n => n instanceof Shape || n instanceof Group) as (Shape | Group)[];
  
      if (shapesToGroup.length <= 1) {
          console.log("Select at least 2 top-level shapes/groups to group.");
          return;
      }
  
      const group = new Group(this.interactionService);
      group.zIndex = Math.max(...shapesToGroup.map(s => s.zIndex)) + 1;
  
      // Compute average world position to place new group at center
      const worldPositions: Vec2[] = shapesToGroup.map(node => {
        //const localToWorld = mat4.mul(mat4.create(), node.parentChainMatrix, node.localMatrix);
        const localToWorld = mat4.mul(
          mat4.create(),
          node.parentChainMatrix,
          (node as Shape | Group).localMatrix
        );
        const worldPos = vec4.transformMat4(vec4.create(), vec4.fromValues(0,0,0,1), localToWorld);
        return [worldPos[0], worldPos[1]] as Vec2;
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
  
      this.sceneGraph.root.addChild(group);
      group.recalculateSize();
  
      // Clear visual selection from old shapes
      for (const shape of shapesToGroup) {
          shape.deselect(); // Ensure visual deselection
      }

      this.interactionService.clearSelectedNodes();
      this.interactionService.selectNode(group);
      this.interactionService.onSceneGraphChanged.emit();
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
      const nodes = Array.from(this.interactionService.selectedNodes);
      const newlyUngroupedChildren: Node[] = [];

      for (const node of nodes) {
          if (node instanceof Group && node.getType() != 'Sticky Note' && node.getType() != 'Speech Balloon') {
              // Calculate the group's world position
              const groupWorldPos = this.getWorldPosition(node);

              // Move each immediate child to the scene root
              for (const child of node.children) {
                  // Calculate child's current world position
                  const childWorldPos = this.getWorldPosition(child);
                  
                  // Set new local position relative to scene root
                  child.x = childWorldPos[0] - groupWorldPos[0];
                  child.y = childWorldPos[1] - groupWorldPos[1];
                  child.updateLocalMatrix();

                  // Reparent to root
                  node.removeChild(child);
                  this.sceneGraph.root.addChild(child);
                  newlyUngroupedChildren.push(child);
              }

              // Remove the now-empty group
              if (node.parent) {
                  node.parent.removeChild(node);
              }
          }
      }

      // Select the newly ungrouped children
      this.interactionService.clearSelectedNodes();
      for (const child of newlyUngroupedChildren) {
          this.interactionService.selectNode(child);
      }

      this.interactionService.onSceneGraphChanged.emit();
    }

    private getWorldPosition(node: Node): [number, number] {
      const worldMatrix = mat4.multiply(
          mat4.create(),
          node.parentChainMatrix,
          (node as Shape | Group).localMatrix
      );
      const worldPos = vec4.transformMat4(
          vec4.create(),
          vec4.fromValues(0, 0, 0, 1),
          worldMatrix
      );
      return [worldPos[0], worldPos[1]];
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
        return this.canvasPxToWorld(x, y);
    }

  private handlePointerMove(event: PointerEvent) {
    const mouseX = event.offsetX;
    const mouseY = event.offsetY;
    let interacted = false;

    // Always track cursor world position (for connection-port hover dots)
    const [cwx, cwy] = this.canvasPxToWorld(mouseX, mouseY);
    this._cursorWorldX = cwx;
    this._cursorWorldY = cwy;

    // Track pointer UV for shader uniforms (cursor-reactive text effects)
    const rect = this.canvas.getBoundingClientRect();
    this.interactionService.lastPointerUV = [
      Math.max(0, Math.min(1, mouseX / rect.width)),
      Math.max(0, Math.min(1, mouseY / rect.height)),
    ];

    switch (this.mode.kind) {
      case 'panning': {
        const [lx, ly] = this.mode.lastClient;
        const dx = (event.clientX - lx) * 2;
        const dy = (event.clientY - ly) * 2;

        this.interactionService.adjustPan(
            dx, 
            dy, 
            this.illustrationMode, 
            this.illustrationBounds
        );
        
        if (!this.backgroundPatternFixed) {
            this.bgDirty.matrix = true;
        }

        this.renderListDirty = true;
        
        this.mode.lastClient = [event.clientX, event.clientY];
        interacted = true;
        break;
      }

      case 'draggingPlacement': {
        const [wx, wy] = this.canvasPxToWorld(mouseX, mouseY);
        const { layerId, placementId, startWorldX, startWorldY, placementX0, placementY0 } = this.mode.data;
        const newX = placementX0 + (wx - startWorldX);
        const newY = placementY0 + (wy - startWorldY);
        this._ephemeraUpdateCallback?.(layerId, placementId, newX, newY);
        interacted = true;
        break;
      }

      case 'resizingPlacement': {
        const [wx, wy] = this.canvasPxToWorld(mouseX, mouseY);
        const { layerId, placementId, handle, anchorX, anchorY } = this.mode.data;
        this._ephemeraResizeCallback?.(layerId, placementId, handle, anchorX, anchorY, wx, wy);
        interacted = true;
        break;
      }

      case 'rotatingPlacement': {
        const [wx, wy] = this.canvasPxToWorld(mouseX, mouseY);
        const { layerId, placementId, centerX, centerY, startAngle, startRotation } = this.mode.data;
        this._ephemeraRotateCallback?.(layerId, placementId, centerX, centerY, startAngle, startRotation, wx, wy);
        interacted = true;
        break;
      }

      case 'dragging': {
        this.renderListDirty = true;
        const [modelX, modelY] = this.canvasPxToWorld(event.offsetX, event.offsetY);
        const { primary, dragOffset, initialGroupChildPositions, primaryX0, primaryY0 } = this.mode.data;

        const deltaX = modelX - (primaryX0 + dragOffset[0]);
        const deltaY = modelY - (primaryY0 + dragOffset[1]);

        const { nodes, x0, y0, invParentAtDrag } = this.mode.data;

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
              this.pendingGroupBounds.add(parent);
              // Also mark the parent's bounding box as needing recalc
              parent.cachedWorldSpaceBoundingPolygon = null;
            }
            parent = parent.parent;
          }
          
          // If the node itself is a group, mark it too
          if (n instanceof Group) {
            this.pendingGroupBounds.add(n);
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
          this.interactionService.onSceneGraphChanged.emit(); 
        }
        break;
      }

      case 'boxSelecting': {
        const [startXc, startYc] = this.mode.startCanvas;
        const [startX, startY] = this.transformMouseCoordinatesToWorldSpace(startXc, startYc);

        const x = event.clientX - this.mode.rect.left;
        const y = event.clientY - this.mode.rect.top;
        const [endX, endY] = this.transformMouseCoordinatesToWorldSpace(x, y);

        const x1 = Math.min(startX, endX);
        const y1 = Math.min(startY, endY);
        const x2 = Math.max(startX, endX);
        const y2 = Math.max(startY, endY);

        const w = x2 - x1, h = y2 - y1;
        const cx = x1 + w / 2, cy = y1 + h / 2;

        // preview box
        if (!this.interactionService.boxSelectPreview) {
          const box = new Rectangle(cx, cy, w, h, { r: 0.6, g: 0.55, b: 0.95, a: 0.25 }, undefined, 1, this.interactionService);
          box.isPreview = true;
          this.interactionService.boxSelectPreview = box;
          box.markDirty();
        } else {
          const box = this.interactionService.boxSelectPreview;
          box.x = cx; box.y = cy; box.scaleX = w; box.scaleY = h; box.markDirty();
        }

        // selection polygon (world space)
        const selectionPolygon: Vec2[] = [
          [x1, y1], [x2, y1], [x2, y2], [x1, y2],
        ];

        const allNodes = this.selectionService.findAllShapesDeep(this.sceneGraph.root);
        const topLevelMatches = allNodes.filter(node => {
          if (this.stickyAncestorOf(node)) return false;
          if (this.speechBalloonAncestorOf(node)) return false;
          const intersects = polygonsIntersect(node.getWorldSpaceBoundingBoxPolygon(), selectionPolygon);
          if (!intersects) return false;
          if(node.locked) return false;
          let cur = node.parent;
          while (cur) {
            if (cur instanceof Group && allNodes.includes(cur)) return false;
            cur = cur.parent;
          }
          return true;
        });

        for (const n of allNodes) n.deselect();
        this.interactionService.clearSelectedNodes();
        for (const n of topLevelMatches) { n.select(); this.interactionService.selectNode(n); }

        interacted = true;
        break;
      }

      case 'rotating': {
        if (this.interactionService.selectedNodes.size === 1) {
          const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
          const currentMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
          const angleDifference = currentMouseAngle - this.mode.data.initialMouseAngle;
          shape.rotation = this.mode.data.initialRotation + angleDifference;
          shape.markDirty();
        }
        interacted = true;
        this.interactionService.onSceneGraphChanged.emit();
        break;
      }

      case 'scaling': {
        this.renderListDirty = true;
        if (this.interactionService.selectedNodes.size === 1) {
          const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
          const { side, initial, prevCenter } = this.mode.data;

          const [modelX, modelY] = this.canvasPxToWorld(mouseX, mouseY);
          const mouseMovementX = modelX - this.mode.data.anchorWorld[0];
          const mouseMovementY = modelY - this.mode.data.anchorWorld[1];

          const rot = shape.rotation;
          const cosT = Math.cos(rot), sinT = Math.sin(rot);
          const alongW =  (mouseMovementX * cosT + mouseMovementY * sinT);
          const alongH = (-mouseMovementX * sinT + mouseMovementY * cosT);

          const minW = 0.05, minH = 0.05;

          const apply = (newW: number, newH: number, dxCenter: number, dyCenter: number) => {
            if (shape instanceof Group) {
              const tgtW = Math.max(minW, newW);
              const tgtH = Math.max(minH, newH);

              if (this.mode.kind == 'scaling') {
                const sx = (this.mode.data.initial.baseW > 0) ? (tgtW / this.mode.data.initial.baseW) : 1;
                const sy = (this.mode.data.initial.baseH > 0) ? (tgtH / this.mode.data.initial.baseH) : 1;

                shape.scaleX = sx;
                shape.scaleY = sy;
              }
            } else {
              shape.scaleX = Math.max(minW, newW);
              shape.scaleY = Math.max(minH, newH);
            }

            if (this.mode.kind == 'scaling') {
              shape.x = this.mode.data.initial.x + dxCenter;
              shape.y = this.mode.data.initial.y + dyCenter;
            }

            shape.updateLocalMatrix();
            shape.markDirty();

            if (shape instanceof Group) {
              shape.forEachDeep(ch => {
                if (ch === shape) return;
                ch.updateLocalMatrix();
                (ch as Shape).triggerRerender?.();
              });
            }

            // Mark parent groups for update
            let parent = shape.parent;
            while (parent) {
              if (parent instanceof Group) {
                this.pendingGroupBounds.add(parent);
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
              if (this.mode.kind === 'scaling') {
                this.mode.data.prevCenter = [shape.x, shape.y];
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
          this.interactionService.onSceneGraphChanged.emit();
          interacted = true;
        }
        break;
      }

      case 'endpointDragging': {
        const { line, which } = this.mode.data;
        const [wx, wy] = this.canvasPxToWorld(mouseX, mouseY);
        let ex = wx, ey = wy;

        // Snap to nearest connection port (world space)
        const snap = this._connectorService?.findSnapTarget(wx, wy, line.id);
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

        this.canvas.style.cursor = 'crosshair';
        this.interactionService.onSceneGraphChanged.emit();
        interacted = true;
        break;
      }

      case 'idle': {
        // Idle hover cursor only
        const sel = this.interactionService.selectedNodes;
        if (sel.size === 1) {
          const shape = sel.values().next().value as Shape;
          if (shape?.boundingBox) {
            const worldMouse: Vec2 = this.canvasPxToWorld(mouseX, mouseY);

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
                this.canvas.style.cursor = 'crosshair';
                this.scheduleRender();
                break;
              }
            }

            if (isNearRotationHandle(shape, worldMouse)) {
              this.canvas.style.cursor = 'grab';
            } else {
              const side = getScalingSide(shape, worldMouse);
              if(!this.eraserService?.isEnabled 
                && !this.scribbleDrawingService?.isEnabled
                && !this.highlightDrawingService?.isEnabled
                && !this.patternDrawingService?.isEnabled
                && !this.stampDrawingService?.isEnabled) {
                this.canvas.style.cursor = side ? CURSORS[side] : `url('${pointerCursorUrl}'), auto`;
              }
            }
          }
        }
        // Re-render so connection-port dots / endpoint dots update on hover
        if (this.lineDrawingService?.isEnabled) {
          this.scheduleRender();
        } else if (sel.size === 1) {
          const n = sel.values().next().value;
          if (n instanceof Line) this.scheduleRender();
        }
        break;
      }
    }

    if (interacted) {
      for (const node of this.interactionService.selectedNodes) {
        if (node instanceof Group) {
          node.forEachDeep(ch => (ch as Shape).triggerRerender?.());
        } else {
          (node as Shape).triggerRerender?.();
        }
      }
      this.scheduleRender();
    }
  }

  private getTopLevelSelectedNodes(): Node[] {
    const allNodes = Array.from(this.interactionService.selectedNodes);
    return allNodes.filter(node => {
        let current = node.parent;
        while (current) {
            if (this.interactionService.selectedNodes.has(current)) {
                return false; // If a parent is selected too, skip this node
            }
            current = current.parent;
        }
        return true;
    });
  }

  private cacheRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
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

  /** When scaling a Section or ungrouping â€” if the Section/Group moves, 
   * you sometimes need to move its children back into world space correctly. 
   * Again: not just immediate children â€” all nested children recursively. */
  moveChildrenByDeltaDeep(node: Node, dx: number, dy: number) {
    node.forEachDeep(n => {
        if (n instanceof Shape) {
            n.x += dx;
            n.y += dy;
            n.updateLocalMatrix();
        }
    });
  }

  private handlePointerUp(event: PointerEvent) {
  // Track pointer state for shader uniforms
  this.interactionService.pointerDown = false;

  this.renderListDirty = true;
  this.scheduleRender();

  // â”€â”€ Endpoint drag finalization â”€â”€
  // Ephemera placement interaction finalization
  if (this.mode.kind === 'draggingPlacement' ||
      this.mode.kind === 'resizingPlacement' ||
      this.mode.kind === 'rotatingPlacement') {
    this.mode = { kind: 'idle' };
    this.interactionService.endInteractive();
    return;
  }

  if (this.mode.kind === 'endpointDragging') {
    const { line, which } = this.mode.data;
    const [wx, wy] = this.canvasPxToWorld(event.offsetX, event.offsetY);
    const inv = line.getInverseLocalMatrix();
    const snap = this._connectorService?.findSnapTarget(wx, wy, line.id);
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
      // Not snapped â€” clear binding for that endpoint
      if (which === 'start') line.startBinding = null;
      else line.endBinding = null;
    }
    this.mode = { kind: 'idle' };
    this.interactionService.onSceneGraphChanged.emit();
    this.interactionService.endInteractive();
    return;
  }

  const wasDragging = this.mode.kind === 'dragging';
  const wasBoxSelecting = this.mode.kind === 'boxSelecting';
  const wasScaling = this.mode.kind === 'scaling';
  const dragData = this.mode.kind === 'dragging' ? this.mode.data : null;
  const dragPrimary = dragData?.primary || null;

  // Clear box select preview if we were box selecting
  if (wasBoxSelecting) {
    this.interactionService.boxSelectPreview = null;
  }

  // Handle scaling normalization first
  if (wasScaling) {
    for (const node of this.interactionService.selectedNodes) {
      if (node instanceof Group) {
        this.bakeScaleToLeaves(node);
      }
    }
  }

  // Update all affected parent groups after drag/scale
  if (wasDragging || wasScaling) {
    // Add any groups that were explicitly moved/scaled
    const movedNodes = wasDragging && dragData 
      ? dragData.nodes 
      : Array.from(this.interactionService.selectedNodes).filter(n => n instanceof Shape || n instanceof Group) as (Shape|Group)[];
    
    for (const node of movedNodes) {
      let parent = node.parent;
      while (parent) {
        if (parent instanceof Group) {
          this.pendingGroupBounds.add(parent);
        }
        parent = parent.parent;
      }
      if (node instanceof Group) {
        this.pendingGroupBounds.add(node);
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
  this.mode = { kind: 'idle' };
  if(!this.eraserService?.isEnabled 
    && !this.scribbleDrawingService?.isEnabled
    && !this.highlightDrawingService?.isEnabled
    && !this.patternDrawingService?.isEnabled
    && !this.stampDrawingService?.isEnabled) {
    this.canvas.style.cursor = this.getRandomCursor();
  }

  // Handle drop-into-section logic
  if (dragPrimary && (dragPrimary instanceof Shape || dragPrimary instanceof Group)) {
    this.handleDropIntoSection(dragPrimary as Shape | Group);
  }
}

// 3. NEW method to update all pending groups efficiently
// Also need to fix the updatePendingGroups method in WebGPURenderer to ensure proper order:
private updatePendingGroups(): void {
  if (this.pendingGroupBounds.size === 0) return;

  // Collect all affected groups including ancestors
  const allAffectedGroups = new Set<Group>();
  
  for (const group of this.pendingGroupBounds) {
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
    return this.getNodeDepth(b) - this.getNodeDepth(a);
  });
  
  // Update each group
  for (const group of sortedGroups) {
    // Clear cached world space polygon
    group.cachedWorldSpaceBoundingPolygon = null;
    
    // Recalculate size based on children (this is the existing method that works!)
    group.recalculateSize();
  }

  // Clear the pending set
  this.pendingGroupBounds.clear();
}

// 4. Extracted Section handling logic
// 4. Keep Section handling logic as is
private handleSectionChildrenAfterMove(): void {
  const sectionsChecked = new Set<Section>();

  for (const node of this.interactionService.selectedNodes) {
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
        this.sceneGraph.root.addChild(node);
        node.updateLocalMatrix();
        node.markDirty();
      }
    }
  }

  // Check for Groups that moved out of Sections
  for (const node of this.interactionService.selectedNodes) {
    if (!(node instanceof Group)) continue;

    for (const child of this.selectionService.findAllShapesDeep(node)) {
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
        this.sceneGraph.root.addChild(child);
        child.updateLocalMatrix();
        child.markDirty();
      }
    }
  }

  // Check for Sections that were scaled
  for (const node of this.interactionService.selectedNodes) {
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
        this.sceneGraph.root.addChild(child);
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
this.setFromLocalMatrix(shape as Shape|Group, newLocal);

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
  
      const candidates = this.sceneGraph.root.children.filter(n =>
          n instanceof Shape && n.getType?.() === "Section" && n !== shape
      ) as Section[];
  
      // Find all sections that contain the shapeâ€™s center
      const shapeCenter = [shape.x, shape.y] as [number, number];
      const containingSections = candidates.filter(section =>
          pointInPolygon(shapeCenter, section.getWorldSpaceBoundingBoxPolygon())
      );
  
      // Return topmost by zIndex (if overlapping)
      return containingSections.sort((a, b) => b.zIndex - a.zIndex)[0] || null;
  }

  // â”€â”€ Onion Skin Overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  setCanvasSize(device: GPUDevice) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    // Read the canvas's actual rendered size so the pixel buffer matches its
    // CSS container — handles split-view layouts where the canvas is narrower
    // than the window.  Fall back to window dimensions only if the canvas has
    // not been laid out yet (rect is zero, e.g. during first-frame init).
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width  || window.innerWidth;
    const h = rect.height || window.innerHeight;
    this.canvas.width  = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);

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
      this.setCanvasSize(this.getDevice());
      new ResizeObserver(() => this.setCanvasSize(this.getDevice())).observe(this.canvas);
      window.addEventListener('resize', () => this.setCanvasSize(this.getDevice()));

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

  public async reinitialize(newCanvas: HTMLCanvasElement) {
  // 1) Reset scenegraph :)
  this.sceneGraph.root.children.length = 0;

  // 2) Swap canvas everywhere that needs it
  const oldCanvas = this.canvas;
  this.interactionService.canvas = newCanvas;

  // 3) Rebind rendererâ€™s own event handlers to the new canvas
  //    (avoid duplicate bindings if called multiple times)
  if (oldCanvas && oldCanvas !== newCanvas) {
    oldCanvas.removeEventListener('pointerdown', this._boundPointerDown);
    oldCanvas.removeEventListener('pointermove', this._boundPointerMove);
    oldCanvas.removeEventListener('pointerup',   this._boundPointerUp);
    oldCanvas.removeEventListener('wheel',     this._boundWheel);
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
  this.sdfTextDrawingService?.reinitializeEventListeners();

  // 5) Reconfigure the WebGPU context for the new canvas
  this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
  this.context.configure({
    device: this.device,
    format: this.swapChainFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    alphaMode: 'premultiplied',
  });

  // 6) Make sure the canvas has the right DPR size and depth buffer
  this.setCanvasSize(this.getDevice());                   // <- you had this commented out
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
        if (!navigator.gpu) { throw new Error("WebGPU is not supported on this browser."); }

        /* About the GPUAdapter:
           The GPUAdapter is an interface that provides information about the GPU hardware and 
           allows us to request a GPUDevice to perform rendering or compute operations.
           Not all devices or browsers support WebGPU. By checking for the availability of a GPUAdapter, 
           the application can handle cases where WebGPU isn't supported and potentially provide fallbacks 
           (a different rendering strategy) or inform the user.
        ---------------------------------------------------------------------------------------------------------------------------*/
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) { throw new Error("Failed to request WebGPU adapter."); }
        // this.device = await adapter.requestDevice();

        this.device = await adapter.requestDevice({
            requiredFeatures: ["indirect-first-instance"],
        });

        this.interactionService.setDepthTextureView(this.device);


        /* About GPUCanvasContext:
        Retrieves the WebGPU rendering context for the canvas. This context is specifically designed to allow 
        WebGPU commands to render content onto a <canvas> element.  The context returned is cast to GPUCanvasContext, 
        which is a special type of context for managing the WebGPU rendering pipeline.

        The canvas context is the bridge between the WebGPU rendering pipeline and the HTML canvas. 
        Itâ€™s where the WebGPU commands will output the rendered content.

        Note: The swap chain format we use is bgra8unorm ("blue-green-red-alpha with 8 bits per channel and normalized values"). 
        The swap chain format determines how the image data is represented in memory before being displayed on the screen.
        Also, alphaMode: 'premultiplied' is used. This setting indicates how the alpha channel (transparency) is handled. 
        'premultiplied' means that the color values have already been multiplied by the alpha value, which is a common way of 
        handling transparency in rendering.
        --------------------------------------------------------------------------------------------------------------------------*/
        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
        this.context.configure({
            device: this.device,
            format: this.swapChainFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
            alphaMode: 'premultiplied',
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
    }

    private rebuildRenderListIfNeeded() {
      if (!this.renderListDirty) return;

      // Re-walk the full tree only when shapes are added/removed (structure change).
      // During drag, pan, scale or zoom the shape list is identical — only the viewport
      // filter and sort need to re-run on the already-flat list.
      if (this._flatShapesDirty) {
        this._flatShapes = this.selectionService.findAllShapesDeep(this.sceneGraph.root);
        this._flatShapesDirty = false;
      }

      const viewBox = viewportAABB(this.canvas, this.interactionService.getWorldMatrix());
      this.renderList = this._flatShapes
        .filter(n => {
          const bb = getWorldAABB(n);
          if (!n.visible) return false;
          if (!bb) return true;
          return aabbOverlaps(viewBox, bb);
        })
        .sort((a, b) => a.zIndex - b.zIndex);

      this.renderListDirty = false;
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
        if ((n as any).getType?.() === 'SDFText') {
          (n as any).refreshText?.();
        }
      });

      atlas.bumpVersion();
      this._lastCompactedAtVersion = atlas.version;
    }

    // Call this once per frame before beginFrame()
    private handleAtlasChangeIfNeeded() {
      if (!this.cacheService) return;
      const atlas = this.cacheService.getSdfAtlas();
      const v = atlas.version;
      if (v === this.cachedAtlasVersion) return;

      // Rebuild SDFText UVs
      this.sceneGraph.root.forEachDeep(n => {
        if ((n as any).getType?.() === "SDFText") {
          (n as any).markDirty?.();
          (n as any).triggerRerender?.();
        }
      });

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

    public async render() {
        // Run pre-render callbacks (orbit controller update, etc.)
        let needsAnotherFrame = false;
        for (const cb of this.preRenderCallbacks) {
          if (cb()) needsAnotherFrame = true;
        }
        if (needsAnotherFrame) this.scheduleRender();

        this.ensureLastFrameTex();
        /* When the current visible nodes are sent to beginFrame(), we collect the staged scribbles, highlights,
        and lines into separate arrays. These staged shapes (e.g., an in-progress scribble) are rendered at the end of this render() 
        method so they appear visually on top of all other content.

        The beginFrame() method processes finalized (non-staged) shapes and prepares their corresponding
        IndirectDrawCommandBuffers. These buffers hold indirect draw commands, which allow all finalized shapes
        to be rendered in a single batched call using drawIndexedIndirect() in this render() method â€” improving performance
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

        // For thumbnail:
        // Basically, I render to offscreenView which writes the image onto lastFrameTex 
        // so that i have a persistent copy for the thumbnail generation. 
        // Then, right before submission to the device, I copy lastFrameText to the backTex, 
        // which is the WebGPU context, so the backTex texture is what gets drawn onto the screen?
        const backTex = this.context.getCurrentTexture(); 
        const offscreenView = this.lastFrameTex!.createView();
        let artboard = this.getArtboardScissor();
        // NOTE: render to the OFFSCREEN view, not the swapchain.
        // That way we can persist the texture for the thumbnail.
        const renderPassDescriptor: GPURenderPassDescriptor = {
          colorAttachments: [{
            view: offscreenView,
            loadOp: 'clear',
            clearValue: 
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
    
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        
        // Render background
        //this.renderBackground(passEncoder);

        // If in raster mode, composite raster layers (if provided) into rasterTexture, then draw
        if (this.renderMode === 'raster' && this.pipelineManager) {
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
              // Use the new GPU compositor with blend modes, opacity, clipping
              const compositorLayers: CompositorLayerInfo[] = this.rasterCompositionList
                .filter(l => l.texture)
                .map(l => ({
                  texture: l.texture!,
                  blendMode: l.blendMode ?? LayerBlendMode.Normal,
                  opacity: l.opacity ?? 1.0,
                  clipped: l.clipped ?? false,
                  visible: l.visible ?? true,
                  ditherConfig: l.ditherConfig,
                  frameLinkAnimation: l.frameLinkAnimation,
                }));
              // Check if any layer or global dither uses error diffusion (requires async WASM)
              const globalDitherCfg = this._rasterCompositor.getDitherConfig();
              const needsAsync = DitherEngine.isErrorDiffusion(globalDitherCfg.algorithm) ||
                compositorLayers.some(l => l.ditherConfig?.enabled && DitherEngine.isErrorDiffusion(l.ditherConfig.algorithm));

              if (needsAsync) {
                await this._rasterCompositor.compositeAsync(compositorLayers, this.rasterTexture);
              } else {
                this._rasterCompositor.composite(compositorLayers, this.rasterTexture);
              }

              // â”€â”€ Onion skin overlay â”€â”€
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
          // First draw the artboard pattern under the raster content so transparent areas show the checkerboard
          if (artboard) {
            passEncoder.setScissorRect(artboard.x, artboard.y, artboard.w, artboard.h);
            this.renderArtboardPattern(passEncoder);
          }

          // â”€â”€ Pre-raster vector pass: draw below-raster nodes (panels) â”€â”€
          // Panel layouts render underneath raster layers so illustrations
          // are drawn on top of the panel structure.
          {
            this.handleAtlasChangeIfNeeded();
            this.rebuildRenderListIfNeeded();
            const belowRasterNodes = this.renderList.filter(n => n.isRenderBelowRaster());
            if (belowRasterNodes.length > 0) {
              this.webGPURenderStrategy.beginFrame(belowRasterNodes, this.stagingBuffer, stagingContainer);
              this.webGPURenderStrategy.uploadDrawCommands();
              this.webGPURenderStrategy.uploadDrawCounts(this.device);
              this.drawVectorShapes(passEncoder);
            }
          }

          // Apply global canvas grain to the raster texture (paper texture effect).
          // In multi-layer mode the compositor already applies it during composite().
          // In single-layer mode we copy paint â†’ display texture and apply grain there
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
            // Copy paint â†’ display
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
            const layout = this.pipelineManager.getRasterPipeline().getBindGroupLayout(0);
            // ensure world buffer exists
            if (!this.rasterWorldBuf) {
              this.rasterWorldBuf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            }
            // write current world matrix so the raster quad rides with pan/zoom
            const worldMatrix = this.interactionService.getWorldMatrix();
            this.device.queue.writeBuffer(this.rasterWorldBuf, 0, (worldMatrix as Float32Array).buffer);

            const bg = this.device.createBindGroup({ layout, entries: [
              { binding: 0, resource: rasterTexToRender.createView() },
              { binding: 1, resource: this.pipelineManager.getTexturedSampler() },
              { binding: 2, resource: { buffer: this.rasterWorldBuf } }
            ]});
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

          // â”€â”€ Raster text preview overlay â”€â”€
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
                x0, y1, 0, 1,  // bottom-left  â†’ UV(0,1)
                x1, y1, 1, 1,  // bottom-right â†’ UV(1,1)
                x0, y0, 0, 0,  // top-left     â†’ UV(0,0)
                x1, y0, 1, 0,  // top-right    â†’ UV(1,0)
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

          // (Raster-specific overlays done â€” fall through to vector drawing
          //  so SDF text, shapes, panels, speech balloons render on top.)
        } else {
          // â”€â”€ Vector-only mode: draw artboard background â”€â”€
          if (artboard) passEncoder.setScissorRect(artboard.x, artboard.y, artboard.w, artboard.h);
          this.renderArtboardPattern(passEncoder);
        }
    
        // --- Indirect Rendering Starts ---
        
        // make sure everything that depends on the atlas is up-to-date
        this.handleAtlasCompactIfNeeded();
        this.handleAtlasChangeIfNeeded();

        this.rebuildRenderListIfNeeded();
        const visibleNodes = this.renderList.slice();

        if (this.interactionService.boxSelectPreview) {
            visibleNodes.push(this.interactionService.boxSelectPreview);
        }

        // Filter nodes that should render above raster (normal) vs below raster (panels).
        // Nodes with no layerId always render. Nodes on a hidden vector layer are excluded.
        const aboveRasterNodes = visibleNodes.filter(n =>
            !n.isRenderBelowRaster() &&
            (!n.layerId || !this._hiddenVectorLayerIds.has(n.layerId))
        );
        // Below-raster nodes were already rendered in the pre-raster pass above

        this.webGPURenderStrategy.beginFrame(aboveRasterNodes, this.stagingBuffer, stagingContainer);
        this.webGPURenderStrategy.uploadDrawCommands();
        this.webGPURenderStrategy.uploadDrawCounts(this.device);

        // ── 3D Mesh pass (depth-tested, drawn before 2D overlays) ──
        const r3d = this.getRenderer3D();
        const loResSize = r3d.getLoResSize(this.canvas.width, this.canvas.height);

        if (loResSize) {
          const [lrW, lrH] = loResSize;
          // Draw all 3D content to the lo-res buffer, then blit nearest-neighbor to main pass.
          const loResPass = r3d.beginLowResRenderPass(commandEncoder, lrW, lrH);
          r3d.drawArmatureBg(loResPass, lrW, lrH);
          this.draw3DMeshes(loResPass, aboveRasterNodes, lrW, lrH);
          this.draw3DParticles(loResPass, aboveRasterNodes, lrW, lrH);
          this.draw3DGp(loResPass, aboveRasterNodes, lrW, lrH);
          loResPass.end();
          r3d.blitLowResToPass(passEncoder);
        } else {
          // Normal full-resolution path.
          r3d.drawArmatureBg(passEncoder, this.canvas.width, this.canvas.height);
          this.draw3DMeshes(passEncoder, aboveRasterNodes);
          this.draw3DParticles(passEncoder, aboveRasterNodes);
          this.draw3DGp(passEncoder, aboveRasterNodes);
        }

        // ── Foreground raster pass (layers above the 3D divider) ──
        if (this.renderMode === 'raster' && this.rasterForegroundList && this.rasterForegroundList.length > 0 &&
            this._rasterCompositor && this.pipelineManager) {
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
          const fgLayers: CompositorLayerInfo[] = this.rasterForegroundList
            .filter(l => l.texture)
            .map(l => ({
              texture: l.texture!, blendMode: l.blendMode ?? LayerBlendMode.Normal,
              opacity: l.opacity ?? 1.0, clipped: l.clipped ?? false,
              visible: l.visible ?? true, ditherConfig: l.ditherConfig,
              frameLinkAnimation: l.frameLinkAnimation,
            }));
          if (fgLayers.length > 0) {
            this._rasterCompositor.currentFrame = this.currentAnimationFrame;
            const globalDitherCfg = this._rasterCompositor.getDitherConfig();
            const needsAsync = DitherEngine.isErrorDiffusion(globalDitherCfg.algorithm) ||
              fgLayers.some(l => l.ditherConfig?.enabled && DitherEngine.isErrorDiffusion(l.ditherConfig.algorithm));
            if (needsAsync) {
              await this._rasterCompositor.compositeAsync(fgLayers, this.rasterTextureFG);
            } else {
              this._rasterCompositor.composite(fgLayers, this.rasterTextureFG);
            }
            // Draw the FG raster quad (same pipeline, same world transform, separate texture)
            if (this.rasterWorldQuadVB && this.rasterWorldQuadIB && this.rasterWorldBuf) {
              const layout = this.pipelineManager.getRasterPipeline().getBindGroupLayout(0);
              const fgBg = this.device.createBindGroup({ layout, entries: [
                { binding: 0, resource: this.rasterTextureFG.createView() },
                { binding: 1, resource: this.pipelineManager.getTexturedSampler() },
                { binding: 2, resource: { buffer: this.rasterWorldBuf } },
              ]});
              passEncoder.setPipeline(this.pipelineManager.getRasterPipeline());
              passEncoder.setBindGroup(0, fgBg);
              passEncoder.setVertexBuffer(0, this.rasterWorldQuadVB);
              passEncoder.setIndexBuffer(this.rasterWorldQuadIB, 'uint16');
              passEncoder.drawIndexed(6, 1, 0, 0, 0);
            }
          }
        }

        // Draw all above-raster vector shapes (everything except panels)
        this.drawVectorShapes(passEncoder);
    
        this.renderStagingShapes(passEncoder, stagingContainer.scribbles, this.pipelineManager!.getStagingLinePipeline(), s => this.stagingBuffer.writeStroke(s));
        this.renderStagingShapes(passEncoder, stagingContainer.lines, this.pipelineManager!.getStagingLinePipeline(), l => this.stagingBuffer.writeLine(l));
        this.renderStagingShapes(passEncoder, stagingContainer.highlights, this.pipelineManager!.getStagingHighlightPipeline(), h => this.stagingBuffer.writeStroke(h));

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
        this.drawLiveTextNodes(passEncoder);

        // â”€â”€ Selection highlight overlay (behind carets) â”€â”€
        const selHighlights = this.webGPURenderStrategy.collectSelectionHighlights(visibleNodes);
        this.selectionHighlightManager.update(selHighlights);
        this.drawSelectionHighlightInstances(passEncoder);

        // â”€â”€ Connection-port indicator dots â”€â”€
        this.updateConnectionPortDots();
        this.drawOverlayDotInstances(passEncoder);

        // Aggregate carets
        const carets = this.webGPURenderStrategy.collectActiveCarets(visibleNodes);
        this.caretManager.update(carets);

        // Draw the caret instances
        this.drawCaretInstances(passEncoder);

        passEncoder.end();

        // Run scene post-processing (bloom / color grade / vignette) if any effects are active.
        // Returns the processed output texture, or null when all effects are disabled.
        const ppOutput = this._renderer3D?.runPostProcess(
          commandEncoder, this.lastFrameTex!, this.canvas.width, this.canvas.height,
        ) ?? null;

        // Copy OFFSCREEN to SWAPCHAIN using the COMMAND ENCODER
        // Use the post-processed output when available; otherwise use lastFrameTex directly.
        // lastFrameTex is always preserved unchanged for thumbnail snapshots.
        commandEncoder.copyTextureToTexture(
          { texture: ppOutput ?? this.lastFrameTex! },
          { texture: backTex },
          { width: this.canvas.width, height: this.canvas.height, depthOrArrayLayers: 1 }
        );

        this.device.queue.submit([commandEncoder.finish()]);

        // Tell anyone waiting that a frame was submitted (for thumbnails)
        this.notifyFrameSubmitted();

        if(this.cacheService!.getSdfAtlas().version != this.cachedAtlasVersion) {
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
     * Draw Mesh3D nodes from the visible node list.
     * Initializes Renderer3D lazily on first use.
     */
    private draw3DMeshes(passEncoder: GPURenderPassEncoder, nodes: Node[], w = this.canvas.width, h = this.canvas.height): void {
      const allMeshes = nodes.filter((n): n is Mesh3D => n instanceof Mesh3D && n.visible);
      if (allMeshes.length === 0) return;

      // Lazy-init the 3D renderer
      if (!this._renderer3D) {
        const cam = new Camera3D({ position: [0, 0, 3], target: [0, 0, 0] });
        this._renderer3D = new Renderer3D(this.device, cam, this.swapChainFormat);
      }

      const regularMeshes = allMeshes.filter((m): m is Mesh3D => !(m instanceof SkinnedMesh3D));
      const skinnedMeshes = allMeshes.filter((m): m is SkinnedMesh3D => m instanceof SkinnedMesh3D);

      if (regularMeshes.length > 0) {
        this._renderer3D.drawMeshes(passEncoder, regularMeshes, w, h);
      }
      if (skinnedMeshes.length > 0) {
        this._renderer3D.drawSkinnedMeshes(passEncoder, skinnedMeshes, w, h);
      }
      // Bone overlay (dim + gizmo) — drawn after all geometry so it's always
      // on top, even when only skinned meshes exist (e.g. after Bind Mesh).
      this._renderer3D.drawBoneOverlayIfActive(passEncoder, w, h);
      // Mesh edit overlay — drawn unconditionally so handles appear even when
      // all meshes are skinned (regularMeshes.length === 0 skips drawMeshes).
      this._renderer3D.drawMeshEditOverlayIfActive(passEncoder);
    }

    private draw3DParticles(passEncoder: GPURenderPassEncoder, nodes: Node[], w = this.canvas.width, h = this.canvas.height): void {
      if (!this._renderer3D) return;
      const emitters = nodes.filter((n): n is ParticleEmitter3D => n instanceof ParticleEmitter3D && n.visible);
      if (emitters.length === 0) return;
      this._renderer3D.drawParticles(passEncoder, emitters, w, h);
    }

    private draw3DGp(passEncoder: GPURenderPassEncoder, nodes: Node[], w = this.canvas.width, h = this.canvas.height): void {
      const gpObjs = (nodes.filter(n => n instanceof GpObject3D && n.visible) as unknown as GpObject3D[])
        .sort((a, b) => a.renderOrder - b.renderOrder);
      const hasOverlay = this._gpDrawOverlay !== null;
      if (gpObjs.length === 0 && !hasOverlay) return;

      if (!this._gpRenderer3D) {
        this._gpRenderer3D = new GpRenderer3D(this.device, this.swapChainFormat);
      }

      const camera = this.getRenderer3D().getCamera();

      if (gpObjs.length > 0) {
        // Build skeleton map from scene graph (Skeleton3D nodes are not in the render list
        // since they extend Node, not Shape — traverse scene root directly).
        const skeletons = new Map<string, Skeleton3D>();
        this.sceneGraph.root.forEachDeep(n => {
          if (n instanceof Skeleton3D) skeletons.set(n.id, n);
        });
        const frame = (this.interactionService as any).currentFrame ?? 0;
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
        const cam = new Camera3D({ position: [0, 0, 3], target: [0, 0, 0] });
        this._renderer3D = new Renderer3D(this.device, cam, this.swapChainFormat);
      }
      return this._renderer3D;
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
    let drawn = 0;

    for (const node of liveNodes) {
      const tex = node.getCurrentTexture();
      if (!tex) continue;

      // Quad half-extents in local space (before scale).
      // The _localMatrix already includes translate + rotate + scale,
      // so the visual size = _width/2 * scaleX etc.
      const hw = node.width / 2;
      const hh = node.height / 2;

      const localToWorld = mat4.create();
      mat4.mul(localToWorld, node.parentChainMatrix, node._localMatrix);

      const tl = vec3.transformMat4(vec3.create(), vec3.fromValues(-hw, hh, 0), localToWorld);
      const tr = vec3.transformMat4(vec3.create(), vec3.fromValues(hw, hh, 0), localToWorld);
      const bl = vec3.transformMat4(vec3.create(), vec3.fromValues(-hw, -hh, 0), localToWorld);
      const br = vec3.transformMat4(vec3.create(), vec3.fromValues(hw, -hh, 0), localToWorld);

      const o = drawn * FLOATS_PER_NODE;
      // pos(x,y) + uv(u,v) per vertex, CCW winding
      allVerts[o +  0] = bl[0]; allVerts[o +  1] = bl[1]; allVerts[o +  2] = 0; allVerts[o +  3] = 1;
      allVerts[o +  4] = br[0]; allVerts[o +  5] = br[1]; allVerts[o +  6] = 1; allVerts[o +  7] = 1;
      allVerts[o +  8] = tl[0]; allVerts[o +  9] = tl[1]; allVerts[o + 10] = 0; allVerts[o + 11] = 0;
      allVerts[o + 12] = tr[0]; allVerts[o + 13] = tr[1]; allVerts[o + 14] = 1; allVerts[o + 15] = 0;

      nodeTextures.push(tex);
      drawn++;
    }

    if (drawn === 0) return;

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
  }

    private renderStagingShapes<T extends Shape>(
        passEncoder: GPURenderPassEncoder,
        shapes: T[],
        pipeline: GPURenderPipeline,
        writeMethod: (shape: T) => any
        ): void {
            const layout = pipeline.getBindGroupLayout(0);
            passEncoder.setPipeline(pipeline);

            for (const shape of shapes) {
                const uniformData = this.getStrokeUniformData(shape);
                this.stagingBuffer.writeUniforms(uniformData);
                const bindGroup = this.stagingBuffer.createStagingBindGroup(layout);
                shape._stagingInfo = writeMethod(shape);
                this.stagingBuffer.renderStagingStroke(passEncoder, bindGroup);
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

    // Helper to convert RGBA [0â€“1] to hex string
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

        this.bgBindGroup = device.createBindGroup({
            layout: this.pipelineManager!.getBackgroundPipeline().getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.bgResBuf } },
                { binding: 1, resource: { buffer: this.bgInvWorldBuf } },
                { binding: 2, resource: { buffer: this.bgBgColorBuf } },
                { binding: 3, resource: { buffer: this.bgDotColorBuf } },
            ],
        });

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

    private canvasPxToWorld(xCanvas: number, yCanvas: number): Vec2 {
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

  public getArtboardScissor(): { x: number; y: number; w: number; h: number } | null {
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
    const padPx = 2;                 // try 1â€“2 px
    xi = Math.max(0, xi - padPx);
    yi = Math.max(0, yi - padPx);
    w  = Math.min(cw - xi, w + 2*padPx);
    h  = Math.min(ch - yi, h + 2*padPx);

    w = Math.max(1, w);
    h = Math.max(1, h);
    return { x: xi, y: yi, w, h };
  }

    public async waitForFrameSettled(): Promise<void> {
      // ensure a frame will be produced
      this.scheduleRender();

      // wait until this renderer actually submitted a frame (notifyFrameSubmitted() right after queue.submit())
      await this.waitForFrameSubmitted();

      // wait until GPU work is done
      await this.device.queue.onSubmittedWorkDone();

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

    /** @deprecated No-op retained for API compatibility. Use setVectorLayerVisible() instead. */
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
    private _ephemeraHitTester?: (wx: number, wy: number) => { layerId: string; placementId: string; x: number; y: number } | null;
    private _ephemeraUpdateCallback?: (layerId: string, placementId: string, newX: number, newY: number) => void;
    private _ephemeraSelectCallback?: (layerId: string, placementId: string) => void;

    public setEphemeraInteractionCallbacks(
      hitTester: (wx: number, wy: number) => { layerId: string; placementId: string; x: number; y: number } | null,
      onUpdate: (layerId: string, placementId: string, newX: number, newY: number) => void,
      onSelect: (layerId: string, placementId: string) => void,
    ): void {
      this._ephemeraHitTester = hitTester;
      this._ephemeraUpdateCallback = onUpdate;
      this._ephemeraSelectCallback = onSelect;
    }

    private _ephemeraHandleHitTester?: (wx: number, wy: number) => PlacementHandleHit | null;
    private _ephemeraResizeCallback?: (layerId: string, placementId: string, handle: PlacementResizeHandle, anchorX: number, anchorY: number, dragX: number, dragY: number) => void;
    private _ephemeraRotateCallback?: (layerId: string, placementId: string, centerX: number, centerY: number, startAngle: number, startRotation: number, dragX: number, dragY: number) => void;
    private _ephemeraDeselectCallback?: () => void;

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

    // Use the canvasâ€™ window if available; fall back to setTimeout in non-DOM envs
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
    private ensureLastFrameTex() {
      const w = this.canvas.width, h = this.canvas.height;
      if (!this.lastFrameTex || this.lastFrameSize.w !== w || this.lastFrameSize.h !== h) {
        this.lastFrameTex?.destroy();
        this.lastFrameTex = this.device.createTexture({
          size: [w, h],
          format: this.swapChainFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.lastFrameSize = { w, h };
      }
    }

    public async snapshotToBlob(maxWidth = 300): Promise<Blob> {
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

        const src = new Uint8Array(readBuf.getMappedRange());
        const rgba = new Uint8ClampedArray(w * h * 4);

        // Converts BGRA to RGBA on CPU + strip padding
        let dst = 0;
        for (let y = 0; y < h; y++) {
            const row = y * padded;
            for (let x = 0; x < w; x++) {
            const i = row + x * 4;
            rgba[dst++] = src[i + 2]; // R
            rgba[dst++] = src[i + 1]; // G
            rgba[dst++] = src[i + 0]; // B
            rgba[dst++] = src[i + 3]; // A
            }
        }

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
      if ((cur as any).getType?.() === 'Sticky Note') return cur as Group;
      cur = cur.parent;
    }
    return null;
  }

  speechBalloonAncestorOf(n: Node | null): Group | null {
    let cur = n?.parent ?? null;
    while (cur) {
      if ((cur as any).getType?.() === 'Speech Balloon') return cur as Group;
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

    // update groupâ€™s logical size to match the visual size we just baked
    g.width  = oldW * sx;
    g.height = oldH * sy;

    g.updateLocalMatrix();
    g.calculateBoundingBox();  // updates handle box/visuals only
    g.markDirty();
  }

    
  /** Push this group's scale down to leaves without changing the group's x,y.
   *  Works for nested groups; avoids the "jump" by not calling recalculateSize(). */
  private bakeScaleToLeaves(g: Group): void {
    const sx = g.scaleX ?? 1;
    const sy = g.scaleY ?? 1;
    const oldW = g.width;
    const oldH = g.height;

    if (sx !== 1 || sy !== 1) {
      // 1) Pre-multiply this group's scale into children (matrix-wise: childLocal' = Sg * childLocal)
      for (const ch of g.children) {
        // translate in parent's local axes
        (ch as any).x *= sx;
        (ch as any).y *= sy;

        // scale the child
        (ch as any).scaleX = ((ch as any).scaleX ?? 1) * sx;
        (ch as any).scaleY = ((ch as any).scaleY ?? 1) * sy;

        (ch as Shape).updateLocalMatrix?.();
        (ch as Shape).markDirty?.();
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

  private setFromLocalMatrix(n: Shape|Group, m: mat4) {
    const tx = m[12], ty = m[13];
    const m00 = m[0], m01 = m[1], m10 = m[4], m11 = m[5];
    const sx = Math.hypot(m00, m01) || 1;
    const sy = Math.hypot(m10, m11) || 1;
    const rot = Math.atan2(m01, m00);
    n.x = tx; n.y = ty;
    (n as any).rotation = rot;
    (n as any).scaleX = sx;
    (n as any).scaleY = sy;
    (n as Shape).updateLocalMatrix?.();
  }

  private getNodeDepth(node: Node): number {
    let depth = 0;
    let current = node.parent;
    while (current) {
      depth++;
      current = current.parent;
    }
    return depth;
  }

  // Returns the chain from root â†’ leaf for a node
  private buildHitChain(n: Node): Node[] {
    const chain: Node[] = [];
    let cur: Node | null = n;
    while (cur) { chain.unshift(cur); cur = cur.parent; }
    return chain;
  }

  // Highest Group in a chain (closest to root)
  private highestGroupInChain(chain: Node[]): Group | null {
    for (const n of chain) if (n instanceof Group) return n; // first group in rootâ†’leaf order
    return null;
  }

  // Return the next deeper node after `from` in the chain (groups or the leaf).
  // If `from` is null, start at the highest group if any, else the leaf.
  private nextDeeperNode(chain: Node[], from: Node | null): Node {
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

  private illustrationMode: boolean = false;
  private illustrationBounds: { width: number; height: number } | undefined = undefined;
  private backgroundPatternFixed: boolean = false;
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

  /**
   * Read back a rectangular region of the last rendered frame and return it
   * as a Blob scaled to outW × outH.  Useful for artboard thumbnail capture.
   *
   * srcX/Y/W/H are in physical canvas pixels (matching lastFrameTex dimensions).
   */
  async snapshotRegionToBlob(
    srcX: number, srcY: number, srcW: number, srcH: number,
    outW: number, outH: number,
    mimeType: string = 'image/png',
    quality: number = 0.92,
  ): Promise<Blob> {
    await this.waitForFrameSettled();

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

    const src = new Uint8Array(readBuf.getMappedRange());
    const rgba = new Uint8ClampedArray(srcW * srcH * 4);
    let dst = 0;
    for (let row = 0; row < srcH; row++) {
      const base = row * padded;
      for (let col = 0; col < srcW; col++) {
        const i = base + col * 4;
        // bgra8unorm → RGBA
        rgba[dst++] = src[i + 2];
        rgba[dst++] = src[i + 1];
        rgba[dst++] = src[i + 0];
        rgba[dst++] = src[i + 3];
      }
    }
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

    if ('convertToBlob' in outCanvas) {
      return (outCanvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
    }
    return new Promise<Blob>(res =>
      (outCanvas as HTMLCanvasElement).toBlob(b => res(b!), mimeType, quality),
    );
  }

}
