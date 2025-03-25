import { RenderCache } from "../renderer/caches/render-cache";
import { StrokeRenderCache } from "../renderer/caches/stroke-render-cache";
import { InteractionService } from "./interaction-service";

export class CacheService {
    private static instance: CacheService;
    public strokeRenderCache!: StrokeRenderCache;
    public renderCache!: RenderCache;
    private device!: GPUDevice;
    //public shapeRenderCache!: ShapeRenderCache;

    private interactionService!: InteractionService;
  
    private constructor() {
    }
  
    public static getInstance(interactionService?: InteractionService): CacheService {
      if (!CacheService.instance) {
        CacheService.instance = new CacheService();
        CacheService.instance.interactionService = interactionService!;
      }
      return CacheService.instance;
    }
  
    public initialize(device: GPUDevice) {
      this.device = device;
      this.renderCache = new RenderCache(1600000, device, this.interactionService);
      this.strokeRenderCache = new StrokeRenderCache(device);
      //this.shapeRenderCache = new ShapeRenderCache(device);
    }
  
    // public clear() {
    //   this.renderCache.clear();
    //   this.strokeRenderCache.clear();
    //   // this.strokeRenderCache = new StrokeRenderCache(this.device);
    //   //this.shapeRenderCache.clear();
    // }
  }
  