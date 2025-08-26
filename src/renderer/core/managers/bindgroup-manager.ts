// bind-group-manager.ts
import { CacheService } from "../../../services/cache-service";
import { PipelineManager } from "./pipeline-manager";

export class BindGroupManager {
  private device: GPUDevice;
  private cacheService: CacheService | null = null;
  public pipelineManager: PipelineManager | null = null;

  public sharedShapeBindGroup!: GPUBindGroup;
  public sharedLineBindGroup!: GPUBindGroup;
  public sharedScribbleBindGroup!: GPUBindGroup;
  public sharedHighlightBindGroup!: GPUBindGroup;
  public sharedBoundingBoxBindGroup!: GPUBindGroup;
  public sharedCaretBindGroup!: GPUBindGroup;
  public sharedSdfTextBindGroup!: GPUBindGroup;
  // public sharedPatternBindGroup!: GPUBindGroup; // Uniform buffer (group 0)
  // public sharedPatternTextureBindGroup!: GPUBindGroup; // Textures and sampler (group 1)
  public backgroundBindGroup!: GPUBindGroup;
  public sharedTexturedBindGroup!: GPUBindGroup;

  constructor(device: GPUDevice, pipelineManager: PipelineManager) {
    this.device = device;
    this.pipelineManager = pipelineManager;
  }

  public setCacheService(cacheService: CacheService) {
    this.cacheService = cacheService;
  }

  public initBindGroups() {
    if (!this.cacheService) throw new Error("CacheService not yet assigned to BindGroupManager");
    this.sharedShapeBindGroup = this.device.createBindGroup({
      layout: this.pipelineManager!.getShapePipeline().getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: {
          buffer: this.cacheService.shapeUniformCache.getUniformBuffer()!,
        },
      }],
    });

    this.sharedLineBindGroup = this.device.createBindGroup({
      layout: this.pipelineManager!.getLinePipeline().getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: {
          buffer: this.cacheService.lineUniformCache.getUniformBuffer()!,
        },
      }],
    });

    this.sharedScribbleBindGroup = this.device.createBindGroup({
      layout: this.pipelineManager!.getScribblePipeline().getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: {
          buffer: this.cacheService.strokeUniformCache.getUniformBuffer()!,
        },
      }],
    });

    this.sharedHighlightBindGroup = this.device.createBindGroup({
      layout: this.pipelineManager!.getHighlightPipeline().getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: {
          buffer: this.cacheService.highlightUniformCache.getUniformBuffer()!,
        },
      }],
    });

    this.sharedBoundingBoxBindGroup = this.device.createBindGroup({
      layout: this.pipelineManager!.getBoundingBoxPipeline().getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.cacheService.boundingBoxUniformCache.getLocalBuffer() },
        },
        {
          binding: 1,
          resource: { buffer: this.cacheService.boundingBoxUniformCache.getWorldBuffer() },
        },
      ],
    });

    this.sharedCaretBindGroup = this.device.createBindGroup({
      layout: this.pipelineManager!.getCaretPipeline().getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.cacheService!.caretUniformBuffer,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: this.cacheService.boundingBoxUniformCache.getWorldBuffer(), // reuse existing one
          },
        }
      ],
    });

    this.sharedSdfTextBindGroup = this.device.createBindGroup({
            layout: this.pipelineManager!.getSdfTextPipeline().getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.cacheService.sdfTextUniformCache.getUniformBuffer()!,
                    },
                },
                {
                    binding: 1,
                    resource: this.cacheService.getSdfAtlas().getAtlasTexture().createView(),
                },
                {
                    binding: 2,
                    resource: this.cacheService.getSdfTextSampler(),
                },
            ],
        });
  }

  private sdfBindGroupVersion = -1;
  public ensureSdfTextBindGroupUpToDate(
    layout: GPUBindGroupLayout,
    atlasView: GPUTextureView,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
    atlasVersion: number
  ) {
    if (this.sdfBindGroupVersion === atlasVersion && this.sharedSdfTextBindGroup) return;

    this.sharedSdfTextBindGroup = this.device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: atlasView },
        { binding: 2, resource: sampler },
      ]
    });
    this.sdfBindGroupVersion = atlasVersion;
  }
  

  // We can't do this until WebGPU has bindless textures... 
  // public initPatternBindGroups() {
  //   // Pattern Texture + Sampler Bind Group (group 1)
  //   // this.sharedPatternTextureBindGroup = this.device.createBindGroup({
  //   //   layout: this.pipelineManager!.getPatternPipeline().getBindGroupLayout(1),
  //   //   entries: [
  //   //     {
  //   //       binding: 0,
  //   //       resource: this.cacheService.patternTextureCache.getBindlessTextureArrayBinding(), // This should be a `GPUBindingResource` array view
  //   //     },
  //   //     {
  //   //       binding: 1,
  //   //       resource: this.cacheService.patternTextureCache.getSampler(),
  //   //     },
  //   //   ]
  //   // });
  // }

  // Called by the caches when they resize a buffer
  public recreateShapeBindGroup(layout: GPUBindGroupLayout, buffer: GPUBuffer) {
    this.sharedShapeBindGroup = this.device.createBindGroup({
      layout,
      entries: [{
        binding: 0,
        resource: { buffer },
      }],
    });
  }

  // public onUniformBufferResized(buffer: GPUBuffer) {
  //   this.recreateShapeBindGroup(
  //     this.pipelineManager!.getShapePipeline().getBindGroupLayout(0),
  //     buffer
  //   );
  //   this.recreateLineBindGroup(
  //     this.pipelineManager!.getLinePipeline().getBindGroupLayout(0),
  //     buffer
  //   );
  //   this.recreateHighlightBindGroup(
  //     this.pipelineManager!.getHighlightPipeline().getBindGroupLayout(0),
  //     buffer
  //   );
  // }

  public recreateLineBindGroup(layout: GPUBindGroupLayout, buffer: GPUBuffer) {
    this.sharedLineBindGroup = this.device.createBindGroup({
      layout,
      entries: [{
        binding: 0,
        resource: { buffer },
      }],
    });
  }

  public recreateHighlightBindGroup(layout: GPUBindGroupLayout, buffer: GPUBuffer) {
    this.sharedHighlightBindGroup = this.device.createBindGroup({
      layout,
      entries: [{
        binding: 0,
        resource: { buffer },
      }],
    });
  }

  public recreateBoundingBoxBindGroup(layout: GPUBindGroupLayout, buffer: GPUBuffer) {
    this.sharedBoundingBoxBindGroup = this.device.createBindGroup({
      layout,
      entries: [{
        binding: 0,
        resource: { buffer },
      }],
    });
  }

  public recreateSdfTextBindGroup(layout: GPUBindGroupLayout, buffer: GPUBuffer) {
  this.sharedSdfTextBindGroup = this.device.createBindGroup({
    layout,
    entries: [
      {
        binding: 0,
        resource: { buffer },
      },
      {
        binding: 1,
        resource: this.cacheService!.getSdfAtlas().getAtlasTexture().createView(),
      },
      {
        binding: 2,
        resource: this.cacheService!.getSdfTextSampler(),
      },
    ],
  });
}

public setTexturedBindGroup(layout: GPUBindGroupLayout, instBuf: GPUBuffer, texArrView: GPUTextureView, sampler: GPUSampler) {
  this.sharedTexturedBindGroup = this.device.createBindGroup({
    layout,
    entries: [
      { binding:0, resource: { buffer: instBuf } },
      { binding:1, resource: texArrView },
      { binding:2, resource: sampler },
    ]
  });
}

  // public recreatePatternBindGroup(layout: GPUBindGroupLayout, buffer: GPUBuffer) {
  //   this.sharedPatternBindGroup = this.device.createBindGroup({
  //     layout,
  //     entries: [{
  //       binding: 0,
  //       resource: { buffer },
  //     }],
  //   }); 
  // }
}