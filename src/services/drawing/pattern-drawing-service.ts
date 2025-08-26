// src/services/drawing/pattern-drawing-service.ts
import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Pattern } from "../../scene-graph/shapes/pattern";
import { RGBA } from "../../types/rgba";
import { InteractionService } from "../interaction-service";
import cursorUrl from '../../assets/washitape.cur?url';
import { PatternAtlas } from "../../renderer/caches/texture-cache/pattern-atlas";
import { CacheService } from "../cache-service";
import { TextureArrayAtlas } from "../../renderer/caches/texture-cache/texture-array-atlas";

export class PatternDrawingService {
  private interactionService: InteractionService;
  private cacheService: CacheService;
  private sceneGraph: SceneGraph;
  private renderStrategy: RenderStrategy;
  private currentPattern: Pattern | null = null;
  public  isDrawing: boolean = false;
  private strokeColor: RGBA = { r: .6, g: .6, b: .6, a: 1 };
  private textureKey: string = "";              // URL / key for the atlas
  private strokeWidth: number = 3;
  public  isEnabled: boolean = false;
  private shapeFactory: ShapeFactory;
  public device: GPUDevice;

  private startDrawingBound = (event: PointerEvent) => this.startDrawing(event);
  private updateDrawingBound = (event: PointerEvent) => this.updateDrawing(event);
  private finishDrawingBound = () => this.finishDrawing();

  constructor(
    interactionService: InteractionService,
    sceneGraph: SceneGraph,
    renderStrategy: RenderStrategy,
    shapeFactory: ShapeFactory,
    device: GPUDevice,
    cacheService: CacheService
  ) {
    this.interactionService = interactionService;
    this.cacheService = cacheService;
    this.sceneGraph = sceneGraph;
    this.renderStrategy = renderStrategy;
    this.shapeFactory = shapeFactory;
    this.device = device;
    this.attachEventListeners();
  }

  public enable() {
    this.isEnabled = true;
    this.interactionService.clearSelectedNodes();
  }

  public disable() {
    this.isEnabled = false;
  }

  public setTextureKey(textureKey: string) {
    this.textureKey = textureKey; // this is the atlas key / URL
  }

  private eventListenersAttached = false;

  private attachEventListeners() {
    if (this.eventListenersAttached) return;

    const canvas = this.interactionService.canvas;
    canvas.addEventListener("pointerdown", this.startDrawingBound);
    canvas.addEventListener("pointermove", this.updateDrawingBound);
    canvas.addEventListener("pointerup", this.finishDrawingBound);

    this.eventListenersAttached = true;
  }

  public reinitializeEventListeners() {
    const canvas = this.interactionService.canvas;

    canvas.removeEventListener("pointerdown", this.startDrawingBound);
    canvas.removeEventListener("pointermove", this.updateDrawingBound);
    canvas.removeEventListener("pointerup", this.finishDrawingBound);

    this.eventListenersAttached = false;
    this.attachEventListeners();
  }

  // NOTE: no async/await, no per-pattern texture load here
  private startDrawing(event: PointerEvent) {
    if (!this.isEnabled || this.isDrawing || event.button !== 0) return;

    this.interactionService.updateWorldMatrix();
    const { x, y } = this.interactionService.toWorldCoords(event);

    // Create the pattern shape
    this.currentPattern = this.shapeFactory.createPattern(
      x, y,
      x + 0.001, y + 0.001,
      this.strokeColor,
      this.strokeWidth,          // use configured stroke width
      this.textureKey,              // keep passing it if your factory expects it
      this.device
    );

    // IMPORTANT: tell the renderer which atlas key to use
    // (Pattern class should have `textureKey: string` for the atlas path)
    this.currentPattern.textureKey = this.textureKey;

    this.sceneGraph.root.addChild(this.currentPattern);
    this.isDrawing = true;
    this.interactionService.beginInteractive();
  }

  private updateDrawing(event: PointerEvent) {

  if(this.isEnabled) {
    this.interactionService.canvas.style.cursor = `url('${cursorUrl}'), crosshair`;
  }

  if (!this.isDrawing || !this.currentPattern) return;

  requestAnimationFrame(() => {
    const { x, y } = this.interactionService.toWorldCoords(event);
    
    // Get the original start point (world coordinates)
    const startX = this.currentPattern!.x1;
    const startY = this.currentPattern!.y1;
    
    // Use updateEndpoints to recalculate center properly
    this.currentPattern!.updateEndpoints(startX, startY, x, y);
    
    this.interactionService.requestRender();
  });
}

  private finishDrawing() {
    this.isDrawing = false;
    this.currentPattern = null;
    this.interactionService.endInteractive();
    this.interactionService.onSceneGraphChanged.emit();
  }

  public getAtlas(): TextureArrayAtlas {
    return this.cacheService.textureArrayAtlas;
  }
}