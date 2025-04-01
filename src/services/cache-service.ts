import { mat4 } from "gl-matrix";
import { RenderDataRegistry } from "../renderer/caches/cache-registry/render-data-registry";
import { BoundingBoxRenderGeometryCache } from "../renderer/caches/geometry-cache/bounding-box-render-gcache";
import { ShapesRenderGeometryCache } from "../renderer/caches/geometry-cache/shapes-render-gcache";
import { StrokesRenderGeometryCache } from "../renderer/caches/geometry-cache/strokes-render-gcache";
import { ShapesRenderUniformCache } from "../renderer/caches/uniform-cache/shapes-render-ucache";
import { Shape } from "../scene-graph/shapes/base/shape";
import { InteractionService } from "./interaction-service";

export class CacheService {
  private static instance: CacheService;

  private device!: GPUDevice;
  private interactionService!: InteractionService;

  private shapeRegistry!: RenderDataRegistry<Shape>;
  private boundingBoxRegistry!: RenderDataRegistry<Shape>;
  private strokeRegistry!: RenderDataRegistry<Shape>;

  public shapeUniformCache!: ShapesRenderUniformCache;
  public boundingBoxUniformCache!: ShapesRenderUniformCache;

  public shapeGeometryCache!: ShapesRenderGeometryCache;
  public boundingBoxGeometryCache!: BoundingBoxRenderGeometryCache;
  public strokeGeometryCache!: StrokesRenderGeometryCache;

  public worldMatrixBuffer!: GPUBuffer;
  public lastUploadedWorldMatrixVersion = -1;

  public identityMatrixBuffer!: GPUBuffer;
  public identityMatrixBufferOffset = 0;

  private constructor() {}

  public static getInstance(interactionService?: InteractionService): CacheService {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
      CacheService.instance.interactionService = interactionService!;
    }
    return CacheService.instance;
  }

  public initialize(device: GPUDevice) {
    this.device = device;
    
    this.initRegistries();
    this.initUniformCaches();
    this.initGeometryCaches();
    this.initWorldMatrixBuffer();
    this.initIdentityMatrixBuffer();
  }

  private initRegistries() {
    this.shapeRegistry = new RenderDataRegistry<Shape>();
    this.boundingBoxRegistry = new RenderDataRegistry<Shape>();
    this.strokeRegistry = new RenderDataRegistry<Shape>();
  }

  private initUniformCaches() {
    const bufferSize = 1600000;
    this.shapeUniformCache = new ShapesRenderUniformCache(bufferSize, this.device, this.shapeRegistry, this.interactionService);
    this.boundingBoxUniformCache = new ShapesRenderUniformCache(bufferSize, this.device, this.boundingBoxRegistry, this.interactionService);
  }

  private initGeometryCaches() {
    this.shapeGeometryCache = new ShapesRenderGeometryCache(this.device, this.shapeRegistry);
    this.boundingBoxGeometryCache = new BoundingBoxRenderGeometryCache(this.device, this.boundingBoxRegistry);
    this.strokeGeometryCache = new StrokesRenderGeometryCache(this.device, this.strokeRegistry);
  }

  private initWorldMatrixBuffer() {
    this.worldMatrixBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private initIdentityMatrixBuffer() {
    const identity = new Float32Array(16);
    mat4.identity(identity);

    this.identityMatrixBuffer = this.device.createBuffer({
      size: identity.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });

    new Float32Array(this.identityMatrixBuffer.getMappedRange()).set(identity);
    this.identityMatrixBuffer.unmap();
  }
}