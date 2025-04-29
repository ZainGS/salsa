import { mat4 } from "gl-matrix";
import { RenderDataRegistry } from "../renderer/caches/cache-registry/render-data-registry";
import { BoundingBoxRenderGeometryCache } from "../renderer/caches/geometry-cache/bounding-box-render-gcache";
import { ShapesRenderGeometryCache } from "../renderer/caches/geometry-cache/shapes-render-gcache";
import { StrokeShape, StrokesRenderGeometryCache } from "../renderer/caches/geometry-cache/strokes-render-gcache";
import { ShapesRenderUniformCache } from "../renderer/caches/uniform-cache/shapes-render-ucache";
import { Shape } from "../scene-graph/shapes/base/shape";
import { InteractionService } from "./interaction-service";
import { BoundingBoxRenderUniformCache } from "../renderer/caches/uniform-cache/bounding-box-render-ucache";
import { BindGroupManager } from "../renderer/core/managers/bindgroup-manager";
import { PipelineManager } from "../renderer/core/managers/pipeline-manager";
import { HighlightsRenderGeometryCache } from "../renderer/caches/geometry-cache/highlights-render-gcache";
import { HighlightsRenderUniformCache } from "../renderer/caches/uniform-cache/highlights-render-ucache";
import { StrokesRenderUniformCache } from "../renderer/caches/uniform-cache/strokes-render-ucache";
import { Pattern } from "../scene-graph/shapes/pattern";
import { PatternTextureCache } from "../renderer/caches/texture-cache/pattern-render-tcache";
import { PatternRenderUniformCache } from "../renderer/caches/uniform-cache/pattern-render-ucache";
import { PatternLegacyUniformCache } from "../renderer/caches/uniform-cache/pattern-legacy-ucache";
import { PatternLegacyGeometryCache } from "../renderer/caches/geometry-cache/pattern-legacy-gcache";
import { LegacyDataRegistry } from "../renderer/caches/cache-registry/legacy-data-registry";
import { Line } from "../scene-graph/shapes/line";

export class CacheService {
  public readonly shapeRegistry: RenderDataRegistry<Shape>;
  public readonly boundingBoxRegistry: RenderDataRegistry<Shape>;
  public readonly strokeRegistry: RenderDataRegistry<StrokeShape>;
  public readonly lineRegistry: RenderDataRegistry<Line>;
  public readonly highlightRegistry: RenderDataRegistry<StrokeShape>;
  public readonly patternRegistry: RenderDataRegistry<Pattern>;
  public readonly legacyPatternRegistry: LegacyDataRegistry<Shape>;

  public readonly shapeUniformCache: ShapesRenderUniformCache;
  public readonly boundingBoxUniformCache: BoundingBoxRenderUniformCache;
  public readonly strokeUniformCache: StrokesRenderUniformCache;
  public readonly lineUniformCache: StrokesRenderUniformCache;
  public readonly highlightUniformCache: StrokesRenderUniformCache;
  // public readonly patternUniformCache: PatternRenderUniformCache;
  public readonly patternLegacyUniformCache: PatternLegacyUniformCache;

  public readonly shapeGeometryCache: ShapesRenderGeometryCache;
  public readonly boundingBoxGeometryCache: BoundingBoxRenderGeometryCache;
  public readonly strokeGeometryCache: StrokesRenderGeometryCache;
  public readonly lineGeometryCache: StrokesRenderGeometryCache;
  public readonly highlightGeometryCache: StrokesRenderGeometryCache;
  public readonly patternGeometryCache: ShapesRenderGeometryCache;
  public readonly patternLegacyGeometryCache: PatternLegacyGeometryCache;

  public readonly patternTextureCache: PatternTextureCache;

  public readonly caretUniformBuffer: GPUBuffer;

  // public readonly worldMatrixBuffer: GPUBuffer;
  // public readonly identityMatrixBuffer: GPUBuffer;

  public lastUploadedWorldMatrixVersion = -1;
  public identityMatrixBufferOffset = 0;

  public bindGroupManager!: BindGroupManager;

  constructor(
    device: GPUDevice,
    interactionService: InteractionService,
    bindGroupManager: BindGroupManager,
    pipelineManager: PipelineManager
  ) {

    this.bindGroupManager = bindGroupManager;

    // Registries
    this.shapeRegistry = new RenderDataRegistry<Shape>();
    this.boundingBoxRegistry = new RenderDataRegistry<Shape>();
    this.strokeRegistry = new RenderDataRegistry<StrokeShape>();
    this.lineRegistry = new RenderDataRegistry<Line>();
    this.highlightRegistry = new RenderDataRegistry<StrokeShape>();
    this.patternRegistry = new RenderDataRegistry<Pattern>();
    this.legacyPatternRegistry = new LegacyDataRegistry<Pattern>();
    
    // Uniform Caches
    const uniformBufferSize = 1600000;
    this.shapeUniformCache = new ShapesRenderUniformCache(
      uniformBufferSize,
      device,
      this.shapeRegistry,
      interactionService,
      bindGroupManager
    );

    this.strokeUniformCache = new StrokesRenderUniformCache(
      uniformBufferSize,
      device,
      this.strokeRegistry,
      interactionService,
      bindGroupManager
    );

    this.lineUniformCache = new StrokesRenderUniformCache(
      uniformBufferSize,
      device,
      this.lineRegistry,
      interactionService,
      bindGroupManager
    );

    this.boundingBoxUniformCache = new BoundingBoxRenderUniformCache(
      uniformBufferSize,
      device,
      this.boundingBoxRegistry,
      interactionService,
      bindGroupManager
    );

    this.highlightUniformCache = new StrokesRenderUniformCache(
      uniformBufferSize,
      device,
      this.highlightRegistry,
      interactionService,
      bindGroupManager
    );

    // this.patternUniformCache = new PatternRenderUniformCache(
    //   uniformBufferSize,
    //   device,
    //   this.patternRegistry,
    //   interactionService,
    //   bindGroupManager
    // );

    this.patternLegacyUniformCache = new PatternLegacyUniformCache(1600000,
      device,
      this.legacyPatternRegistry,
      interactionService);

    // Geometry Caches
    this.shapeGeometryCache = new ShapesRenderGeometryCache(device, this.shapeRegistry);
    this.boundingBoxGeometryCache = new BoundingBoxRenderGeometryCache(device, this.boundingBoxRegistry);
    this.strokeGeometryCache = new StrokesRenderGeometryCache(device, this.strokeRegistry);
    this.lineGeometryCache = new StrokesRenderGeometryCache(device, this.lineRegistry);
    this.highlightGeometryCache = new StrokesRenderGeometryCache(device, this.highlightRegistry);
    this.patternGeometryCache = new ShapesRenderGeometryCache(device, this.patternRegistry);
    this.patternLegacyGeometryCache = new PatternLegacyGeometryCache(device, this.legacyPatternRegistry);

    // Texture Caches
    this.patternTextureCache = new PatternTextureCache(device);

    // Carets buffer (e.g. max 256 carets × 32 bytes = 8192 bytes)
    this.caretUniformBuffer = device.createBuffer({
      size: 8192,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Global Buffers
    // this.worldMatrixBuffer = device.createBuffer({
    //   size: 64,
    //   usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    // });

    // const identity = new Float32Array(16);
    // mat4.identity(identity);

    // this.identityMatrixBuffer = device.createBuffer({
    //   size: identity.byteLength,
    //   usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    //   mappedAtCreation: true,
    // });

    // new Float32Array(this.identityMatrixBuffer.getMappedRange()).set(identity);
    // this.identityMatrixBuffer.unmap();
  }
}
