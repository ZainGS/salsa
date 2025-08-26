// src/services/drawing/stamp-drawing-service.ts
import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Stamp } from "../../scene-graph/shapes/stamp";
import { RGBA } from "../../types/rgba";
import { InteractionService } from "../interaction-service";
import { CacheService } from "../cache-service";
import { TextureArrayAtlas } from "../../renderer/caches/texture-cache/texture-array-atlas";
import cursorUrl from '../../assets/stamp.cur?url';

export class StampDrawingService {
  private interactionService: InteractionService;
  private cacheService: CacheService;
  private sceneGraph: SceneGraph;
  private renderStrategy: RenderStrategy;
  private fillColor: RGBA = { r: 1, g: 1, b: 1, a: 1 };
  private textureKey: string = "";
  private stampSize: number = 64; // Default size
  public isEnabled: boolean = false;
  private shapeFactory: ShapeFactory;
  public device: GPUDevice;

  private clickStampBound = (event: PointerEvent) => this.clickStamp(event);
  private moveStampBound = (event: PointerEvent) => this.moveStamp(event);

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
    this.textureKey = textureKey;
  }

  public setStampSize(size: number) {
    this.stampSize = size;
  }

  public setFillColor(color: RGBA) {
    this.fillColor = color;
  }

  private eventListenersAttached = false;

  private attachEventListeners() {
    if (this.eventListenersAttached) return;

    const canvas = this.interactionService.canvas;
    canvas.addEventListener("pointerdown", this.clickStampBound);
    canvas.addEventListener("pointermove", this.moveStampBound);
    this.eventListenersAttached = true;
  }

  public reinitializeEventListeners() {
    const canvas = this.interactionService.canvas;
    canvas.removeEventListener("pointerdown", this.clickStampBound);
    this.eventListenersAttached = false;
    this.attachEventListeners();
  }

  private moveStamp(event: PointerEvent) {
    if(this.isEnabled) {
        this.interactionService.canvas.style.cursor = `url('${cursorUrl}'), crosshair`;
    }
  }

  private clickStamp(event: PointerEvent) {
    if (!this.isEnabled || event.button !== 0) return;

    this.interactionService.updateWorldMatrix();
    const { x, y } = this.interactionService.toWorldCoords(event);

    // Create the stamp shape
    const stamp = this.shapeFactory.createStamp(
      x, y,
      this.stampSize, this.stampSize,
      this.textureKey,
      this.fillColor
    );

    this.sceneGraph.root.addChild(stamp);
    this.interactionService.onSceneGraphChanged.emit();
  }

  public getAtlas(): TextureArrayAtlas {
    return this.cacheService.textureArrayAtlas;
  }
}