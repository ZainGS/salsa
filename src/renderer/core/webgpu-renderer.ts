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
import { RenderCache } from "../caches/cache-registry/legacy-render-cache";
import { CaretManager } from "../../services/drawing/caret-manager";
import { aabbOverlaps, getWorldAABB, viewportAABB } from "../util/aabb";
import { StampDrawingService } from "../../services/drawing/stamp-drawing-service";
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

type Mode =
  | { kind: 'idle' }
  | { kind: 'panning'; lastClient: Vec2; rect: DOMRect }
  | { kind: 'dragging'; data: DragData }
  | { kind: 'boxSelecting'; startCanvas: Vec2; rect: DOMRect }
  | { kind: 'rotating'; data: RotatingData }
  | { kind: 'scaling'; data: ScalingData };

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
    private stampDrawingService: StampDrawingService | null = null;
    private eraserService: EraserService | null = null;
    private interactionService: InteractionService;
    private selectionService!: SelectionService;

    // Shape & World 
    private sceneGraph!: SceneGraph;

    // Multisample Anti-Aliasing
    // private msaaTexture!: GPUTexture;
    // private msaaTextureView!: GPUTextureView;
    
    private webGPURenderStrategy!: WebGPURenderStrategy;
    public stagingBuffer!: StrokesStagingBuffer;
    private bindGroupManager!: BindGroupManager;
    private renderCache!: RenderCache;
    private patternSampler!: GPUSampler;
    private caretManager!: CaretManager;

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
      // we’ll draw it; otherwise we’ll spin very cheaply.
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
            this.renderListDirty = true;
            this.scheduleRender();
          }
        );
        interactionService.onRequestRender.subscribe(() => this.scheduleRender());
        interactionService.onBeginInteractive.subscribe(() => this.beginInteractive());
        interactionService.onEndInteractive.subscribe(() => this.endInteractive());
        interactionService.onRequestBackgroundRender.subscribe(() => { this.bgDirty.matrix = true; this.renderListDirty = true; })

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

    private handleKeyDown(event: KeyboardEvent) {

        const textShapes = ['Sticky Note', 'SDFText'];

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
        // Pointer Event Listeners
        this.canvas.addEventListener('pointerdown', this.handlePointerDown.bind(this));
        this.canvas.addEventListener('pointermove', this.handlePointerMove.bind(this));
        this.canvas.addEventListener('pointerup', this.handlePointerUp.bind(this));
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));
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
        this.bgBindGroup = undefined as any; // force recreate in ensureBackgroundResources()
        this.cachedAtlasVersion = this.cacheService.getSdfAtlas().version; // seed
        this.renderListDirty = true;
    }

    // Setter to assign CacheService
    public setCacheService(service: CacheService) {
        this.cacheService = service;
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

    public setStampDrawingService(service: StampDrawingService) {
        this.stampDrawingService = service;
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
        this.interactionService.adjustZoom(zoomDelta, mouseX, mouseY);
        this.invalidateWorldSpaceCaches();
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
      // Only schedule render if a mode is entered or selection changes
      const DOUBLE_CLICK_THRESHOLD = 300; // ms
      const now = Date.now();
      const isDoubleClick = (now - this.lastClickTime) < DOUBLE_CLICK_THRESHOLD;
      this.lastClickTime = now;

      const rect = this.cacheRect();

      // Middle mouse or Pan tool → start panning
      if (event.button === 1 || this.interactionService.isPanToolSelected) {
        this.mode = { kind: 'panning', lastClient: [event.clientX, event.clientY], rect };
        event.preventDefault();
        this.scheduleRender();
        this.interactionService.canvas.style.cursor = `url('${panningCursorUrl}'), crosshair`;
        return;
      }

      if (event.button !== 0) return;

      // If a drawing tool is active, clear selection and let the tool handle it
      if (
        this.lineDrawingService?.isEnabled ||
        this.scribbleDrawingService?.isEnabled ||
        this.sectionDrawingService?.isEnabled ||
        this.eraserService?.isEnabled ||
        this.highlightDrawingService?.isEnabled ||
        this.patternDrawingService?.isEnabled ||
        this.stampDrawingService?.isEnabled ||
        this.textDrawingService?.isEnabled ||
        this.sdfTextDrawingService?.isEnabled
      ) {
        this.interactionService.clearSelectedNodes();
        this.scheduleRender();
        return;
      }

      // Compute world pos from canvas offsets
      const [mouseX, mouseY] = [event.offsetX, event.offsetY];
      const [worldX, worldY] = this.transformMouseCoordinatesToWorldSpace(mouseX, mouseY);

      // ROTATION → set rotating mode
      if (this.interactionService.selectedNodes.size === 1) {
        const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
        if (isNearRotationHandle(shape, [worldX, worldY])) {
          const initialMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
          this.mode = {
            kind: 'rotating',
            data: { initialMouseAngle, initialRotation: shape.rotation }
          };
          return;
        }
      }

      // SCALING → set scaling mode
      if (this.interactionService.selectedNodes.size === 1) {
        const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
        const side = getScalingSide(shape, [worldX, worldY]);
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

        // Primary’s initial world position (used to compute delta)
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
            invParentAtDrag,  // <— pass it along
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
            if (node instanceof Group && node.getType() != 'Sticky Note') {
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

    switch (this.mode.kind) {
      case 'panning': {
        const [lx, ly] = this.mode.lastClient;
        const dx = (event.clientX - lx) * 2;
        const dy = (event.clientY - ly) * 2;
        this.interactionService.adjustPan(dx, dy);
        this.bgDirty.matrix = true;
        this.invalidateWorldSpaceCaches();
        this.renderListDirty = true;
        
        this.mode.lastClient = [event.clientX, event.clientY];
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

      case 'idle': {
        // Idle hover cursor only
        const sel = this.interactionService.selectedNodes;
        if (sel.size === 1) {
          const shape = sel.values().next().value as Shape;
          if (shape?.boundingBox) {
            const worldMouse: Vec2 = this.canvasPxToWorld(mouseX, mouseY);
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

  private handlePointerUp(event: PointerEvent) {
  this.renderListDirty = true;
  this.scheduleRender();
  
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
  
      // Find all sections that contain the shape’s center
      const shapeCenter = [shape.x, shape.y] as [number, number];
      const containingSections = candidates.filter(section =>
          pointInPolygon(shapeCenter, section.getWorldSpaceBoundingBoxPolygon())
      );
  
      // Return topmost by zIndex (if overlapping)
      return containingSections.sort((a, b) => b.zIndex - a.zIndex)[0] || null;
  }

  setCanvasSize(device: GPUDevice) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.style.width  = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.canvas.width  = Math.floor(window.innerWidth  * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);

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
      
      // Update canvas size when the window is resized
      this.setCanvasSize(this.getDevice());      
      window.addEventListener('resize', () => this.setCanvasSize(this.getDevice()));

      // Instantiate the staging buffer since device is now available
      this.stagingBuffer = new StrokesStagingBuffer(this.getDevice());

      // Pattern cache+sampler setup
      this.renderCache = new RenderCache(160000, this.device, this.interactionService);
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

  // 3) Rebind renderer’s own event handlers to the new canvas
  //    (avoid duplicate bindings if called multiple times)
  if (oldCanvas && oldCanvas !== newCanvas) {
    oldCanvas.removeEventListener('pointerdown', this.handlePointerDown as any);
    oldCanvas.removeEventListener('pointermove', this.handlePointerMove as any);
    oldCanvas.removeEventListener('pointerup',   this.handlePointerUp as any);
    oldCanvas.removeEventListener('wheel',     this.handleWheel as any);
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
  this.bgDirty.matrix = true;
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
        It’s where the WebGPU commands will output the rendered content.

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

      const viewBox = viewportAABB(this.canvas, this.interactionService.getWorldMatrix());
      this.renderList = this.selectionService
        .findAllShapesDeep(this.sceneGraph.root)
        .filter(n => {
          const bb = getWorldAABB(n);
          if (!n.visible) return false;
          if (!bb) return true; // <-- include until bbox is computed
          return aabbOverlaps(viewBox, bb);
        })
        .sort((a, b) => a.zIndex - b.zIndex);
        
      //this.renderListDirty = false;
    }

    private cachedAtlasVersion = -1;
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

    public async render() {
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

        // For thumbnail:
        // Basically, I render to offscreenView which writes the image onto lastFrameTex 
        // so that i have a persistent copy for the thumbnail generation. 
        // Then, right before submission to the device, I copy lastFrameText to the backTex, 
        // which is the WebGPU context, so the backTex texture is what gets drawn onto the screen?
        const backTex = this.context.getCurrentTexture(); 
        const offscreenView = this.lastFrameTex!.createView();

        // NOTE: render to the OFFSCREEN view, not the swapchain.
        // That way we can persist the texture for the thumbnail.
        const renderPassDescriptor: GPURenderPassDescriptor = {
          colorAttachments: [{
            view: offscreenView,
            loadOp: 'clear',
            clearValue: {
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
        this.renderBackground(passEncoder);
    
        // --- Indirect Rendering Starts ---
        // const visibleNodes = this.sceneGraph.root.children
        //     .filter(node => node.visible)
        //     .sort((a, b) => a.zIndex - b.zIndex);
        
        // make sure everything that depends on the atlas is up-to-date
        this.handleAtlasChangeIfNeeded();

        //const visibleNodes = this.getAllVisibleNodesRecursive(this.sceneGraph.root).sort((a, b) => a.zIndex - b.zIndex);
        this.rebuildRenderListIfNeeded();
        const visibleNodes = this.renderList.slice();

        // Z Depth
        // let minZ = Infinity, maxZ = -Infinity;
        // for (const n of visibleNodes) {
        //   if ((n as any).zIndex !== undefined) {
        //     const zi = (n as any).zIndex as number;
        //     if (zi < minZ) minZ = zi;
        //     if (zi > maxZ) maxZ = zi;
        //   }
        // }
        // if (!isFinite(minZ) || !isFinite(maxZ)) { minZ = 0; maxZ = 1; }
        // // make available to caches:
        // (this.interactionService as any).setZRange?.(minZ, maxZ);

        if (this.interactionService.boxSelectPreview) {
            visibleNodes.push(this.interactionService.boxSelectPreview);
        }
        
        this.webGPURenderStrategy.beginFrame(visibleNodes, this.stagingBuffer, stagingContainer);
        this.webGPURenderStrategy.uploadDrawCommands();
        this.webGPURenderStrategy.uploadDrawCounts(this.device);
        const { shape, stroke, highlight, boundingBox, line, sdfText } = this.webGPURenderStrategy.getDrawBuffers();
        const { shape: shapeCount, 
                stroke: strokeCount, 
                highlight: highlightCount, 
                boundingBox: boxCount,
                line: lineCount, 
                sdfText: sdfTextCount } = this.webGPURenderStrategy.getDrawCounts();
        // console.log("Shapes:", shapeCount, "Strokes:", strokeCount, "Highlights:", highlightCount, "Boxes:", boxCount);

        const commandStride = 5 * 4; // 5 uint32s = 20 bytes (20 bytes per draw command)

        // Draw shapes
        passEncoder.setPipeline(this.pipelineManager!.getShapePipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedShapeBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.shapeGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.shapeGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < shapeCount; i++) {
            passEncoder.drawIndexedIndirect(shape, i * commandStride);
        }
        /** If the browser supports drawIndexedIndirectCount,
         *  We can batch all indexed draws in one call, using GPU-provided count — fast, clean, GPU-driven rendering.
         *  If it doesn’t (fallback path),
         *  You loop over draw calls, issuing one drawIndexedIndirect per shape (classic emulation).
         *  It works on all platforms, even without count support. */
        // if ('drawIndexedIndirectCount' in passEncoder) {
        //     console.log("Chrome Canary test working (drawIndexedIndirectCount).");
        //     const countBuffer = this.webGPURenderStrategy.getDrawCountBuffer();
        //     const countOffset = this.webGPURenderStrategy['drawCountBufferOffsets']['shape']; // Offset in bytes (0 for shapes)
        //     (passEncoder as any).drawIndexedIndirectCount(
        //         shape,         // indirectBuffer    (Each indirect draw command is exactly 20 bytes = 5 u32s)
        //         0,             // indirectOffset
        //         countBuffer,   // countBuffer       (shared 16-byte buffer)
        //         countOffset,   // countBufferOffset (0 for 'shape', 4 for 'stroke', etc.)
        //         shapeCount     // maxDrawCount (used to bound GPU-generated count)
        //     );
        // }
        // else {
            
        // }

        // Draw strokes (scribbles)
        passEncoder.setPipeline(this.pipelineManager!.getScribblePipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedScribbleBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.strokeGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.strokeGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < strokeCount; i++) {
            passEncoder.drawIndexedIndirect(stroke, i * commandStride);
        }

        // Draw lines
        passEncoder.setPipeline(this.pipelineManager!.getLinePipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedLineBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.lineGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.lineGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < lineCount; i++) {
            passEncoder.drawIndexedIndirect(line, i * commandStride);
        }

        // if ('drawIndexedIndirectCount' in passEncoder) {
        //     const countBuffer = this.webGPURenderStrategy.getDrawCountBuffer();
        //     const countOffset = this.webGPURenderStrategy['drawCountBufferOffsets']['stroke']; // 4 for strokes
        //     (passEncoder as any).drawIndexedIndirectCount(
        //         stroke,        // indirect buffer
        //         0,             // indirectOffset
        //         countBuffer,   // shared draw count buffer
        //         countOffset,   // byte offset for 'stroke' (4)
        //         strokeCount    // maxDrawCount
        //     );
        // } else {
            
        // }

        // Draw SDF Text
        // const sdfLayout = this.pipelineManager!.getSdfTextPipeline().getBindGroupLayout(0);
        // const atlasTex  = this.cacheService!.getSdfAtlas().getAtlasTexture();
        // this.bindGroupManager.ensureSdfTextBindGroupUpToDate(
        //   sdfLayout,
        //   atlasTex.createView(),
        //   this.cacheService!.getSdfTextSampler(),
        //   this.cacheService!.sdfTextUniformCache.getUniformBuffer()!,
        //   this.cacheService!.getSdfAtlas().version
        // );

        passEncoder.setPipeline(this.pipelineManager!.getSdfTextPipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedSdfTextBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.sdfTextGeometryCache.getVertexBuffer());  
        passEncoder.setIndexBuffer(this.cacheService!.sdfTextGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < sdfTextCount; i++) {
            passEncoder.drawIndexedIndirect(sdfText, i * commandStride);
        }

        // Draw highlights (separate from other strokes)
        passEncoder.setPipeline(this.pipelineManager!.getHighlightPipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedHighlightBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.highlightGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.highlightGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < highlightCount; i++) {
            const zIndex = this.webGPURenderStrategy.highlightDrawCommands.getZIndexAt(i);
            passEncoder.setStencilReference(i+1);
            passEncoder.drawIndexedIndirect(highlight, i * commandStride);
        }

        // if ('drawIndexedIndirectCount' in passEncoder) {
        //     const countBuffer = this.webGPURenderStrategy.getDrawCountBuffer();
        //     const countOffset = this.webGPURenderStrategy['drawCountBufferOffsets']['highlight']; // 8 for highlights
        //     (passEncoder as any).drawIndexedIndirectCount(
        //         highlight,     // indirect buffer for highlight draw commands
        //         0,             // indirectOffset
        //         countBuffer,   // shared draw count buffer
        //         countOffset,   // byte offset for 'highlight' (8)
        //         highlightCount // maxDrawCount
        //     );
        // } else {
            
        // }
    
        this.renderStagingShapes(passEncoder, stagingContainer.scribbles, this.pipelineManager!.getStagingLinePipeline(), s => this.stagingBuffer.writeStroke(s));
        this.renderStagingShapes(passEncoder, stagingContainer.lines, this.pipelineManager!.getStagingLinePipeline(), l => this.stagingBuffer.writeLine(l));
        this.renderStagingShapes(passEncoder, stagingContainer.highlights, this.pipelineManager!.getStagingHighlightPipeline(), h => this.stagingBuffer.writeStroke(h));

        // Draw bounding boxes
        passEncoder.setPipeline(this.pipelineManager!.getBoundingBoxPipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedBoundingBoxBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.boundingBoxGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.boundingBoxGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < boxCount; i++) {
            passEncoder.drawIndexedIndirect(boundingBox, i * commandStride);
        }

        // Draw Patterns
        // passEncoder.setPipeline(this.pipelineManager!.getPatternPipeline());
        // passEncoder.setBindGroup(0, this.bindGroupManager.sharedPatternBindGroup);
        // passEncoder.setBindGroup(1, this.bindGroupManager.sharedPatternTextureBindGroup);
        // passEncoder.setVertexBuffer(0, this.cacheService!.patternGeometryCache.getVertexBuffer());
        // passEncoder.setIndexBuffer(this.cacheService!.patternGeometryCache.getIndexBuffer(), 'uint16');
        // for (let i = 0; i < patternCount; i++) {
        //     passEncoder.drawIndexedIndirect(pattern, i * commandStride);
        // }
        // for (const p of stagingContainer.patterns) {
        //   this.drawPattern(passEncoder, p);
        // }
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

        // Aggregate carets
        const carets = this.webGPURenderStrategy.collectActiveCarets(visibleNodes);
        this.caretManager.update(carets);

        // Draw the caret instances
        this.drawCaretInstances(passEncoder);

        passEncoder.end();

        // Copy OFFSCREEN to SWAPCHAIN using the COMMAND ENCODER
        // That way we persisted the lastFrameTex to grab for the thumbnail and backTex
        // is updated so that the WebGPURenderer can display the current frame.
        commandEncoder.copyTextureToTexture(
          { texture: this.lastFrameTex! },
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

    private drawCaretInstances(passEncoder: GPURenderPassEncoder) {
      const vertexBuffer = this.getSharedCaretQuad();
      passEncoder.setPipeline(this.pipelineManager!.getCaretPipeline());
      passEncoder.setBindGroup(0, this.cacheService!.bindGroupManager.sharedCaretBindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(4, this.caretManager.getCount(), 0, 0);
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
        // const z = this.interactionService.getZDepthFor?.(shape.zIndex ?? 0) ?? 0.5;
        // uniformData[41] = z; // z depth for depth testing
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
        if (this.bgDirty.matrix) {
          const inv = this.safeInvert(this._tmpInv, this.interactionService.getWorldMatrix()) as Float32Array;
          this.device.queue.writeBuffer(this.bgInvWorldBuf, 0, inv); // 64B
          this.bgDirty.matrix = false;
        }

        if (this.bgDirty.colors) {
            this.device.queue.writeBuffer(this.bgBgColorBuf,  0, this.backgroundColor);
            this.device.queue.writeBuffer(this.bgDotColorBuf, 0, this.dotColor);
            this.bgDirty.colors = false;
        }

        passEncoder.setPipeline(this.pipelineManager!.getBackgroundPipeline());
        passEncoder.setVertexBuffer(0, this.bgQuadVB);
        passEncoder.setBindGroup(0, this.bgBindGroup);
        passEncoder.draw(6, 1, 0, 0);
    }

    private canvasPxToWorld(xCanvas: number, yCanvas: number): Vec2 {
        return canvasPxToWorld(xCanvas, yCanvas, this.canvas, this.interactionService);
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
    private ensureLastFrameTex() {
      const w = this.canvas.width, h = this.canvas.height;
      if (!this.lastFrameTex || this.lastFrameSize.w !== w || this.lastFrameSize.h !== h) {
        this.lastFrameTex?.destroy();
        this.lastFrameTex = this.device.createTexture({
          size: [w, h],
          format: this.swapChainFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
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

  // Returns the chain from root → leaf for a node
  private buildHitChain(n: Node): Node[] {
    const chain: Node[] = [];
    let cur: Node | null = n;
    while (cur) { chain.unshift(cur); cur = cur.parent; }
    return chain;
  }

  // Highest Group in a chain (closest to root)
  private highestGroupInChain(chain: Node[]): Group | null {
    for (const n of chain) if (n instanceof Group) return n; // first group in root→leaf order
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

  private invalidateWorldSpaceCaches() {
    if (!this.sceneGraph) return;
    this.sceneGraph.root.forEachDeep(n => {
      // If you have both polygon and AABB caches, clear both.
      (n as any).cachedWorldSpaceBoundingPolygon = null;
      (n as any)._cachedWorldAABB = undefined;
    });
    this.renderListDirty = true;
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

}