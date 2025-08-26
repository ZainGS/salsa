import { InteractionService } from "../../../services/interaction-service";
import { BindGroupManager } from "../../core/managers/bindgroup-manager";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { GpuUniformCache } from "./gpu-uniform-cache";
import { SDFText } from "../../../scene-graph/shapes/sdf-text/sdf-text";

export class SdfTextRenderUniformCache extends GpuUniformCache<SDFText> {
  private interactionService: InteractionService;
  private bindGroupManager: BindGroupManager;

  constructor(
    initialBufferSize: number,
    device: GPUDevice,
    registry: RenderDataRegistry<SDFText>,
    interactionService: InteractionService,
    bindGroupManager: BindGroupManager
  ) {
    super(device, registry);
    this.dynamicUniformBuffer = device.createBuffer({
      size: initialBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.interactionService = interactionService;
    this.bindGroupManager = bindGroupManager;
  }

  public allocate(sdfText: SDFText): void {
    let offset = this.registry.registryMap.get(sdfText.id)?.uniformOffset;
    
    if (offset === undefined) {
      offset = this.unallocatedOffsets.pop() ?? this.currentOffset;
      
      if (offset === this.currentOffset) {
        this.currentOffset += this.ALIGNMENT;
        if (this.currentOffset > this.dynamicUniformBuffer!.size) {
          this.resizeBuffer(this.dynamicUniformBuffer!.size * 2);
        }
      }

      const shapeIndex = offset / this.ALIGNMENT;
      this.registry.set('sdfText', sdfText, { uniformOffset: offset, shapeIndex });
    }

    const uniformData = this.getSdfTextUniformData(sdfText);
    this.writeUniform(offset, uniformData);
  }

  public update(sdfText: SDFText): void {
    const offset = this.registry.registryMap.get(sdfText.id)?.uniformOffset;
    if (offset === undefined) return;
    const uniformData = this.getSdfTextUniformData(sdfText);
    this.writeUniform(offset, uniformData);
  }

  private getSdfTextUniformData(sdfText: SDFText): Float32Array {
    const canvas = this.interactionService.canvas;
    const resolution = new Float32Array([canvas.width, canvas.height, 0, 0]);
    const worldMatrix = this.interactionService.getWorldMatrix();
    //const localMatrix = sdfText.localMatrix;
    const localMatrix = sdfText.getRenderLocalMatrix();
    const textColor = new Float32Array([
      sdfText.fillColor.r, 
      sdfText.fillColor.g, 
      sdfText.fillColor.b, 
      sdfText.fillColor.a
    ]);
    
    const uniformData = new Float32Array(64);
    uniformData.set(resolution, 0);       // [0-3]
    uniformData.set(worldMatrix, 4);      // [4-19]
    uniformData.set(localMatrix, 20);     // [20-35]
    uniformData.set(textColor, 36);       // [36-39]
    
    // SDF-specific parameters
    uniformData[40] = sdfText.fontSize || 16;     // Font size
    uniformData[41] = sdfText.sdfThreshold || 0.5; // SDF threshold for edge detection
    uniformData[42] = sdfText.smoothing || 0.05;   // Edge smoothing
    uniformData[43] = sdfText.outlineWidth || 0;   // Outline width
    
    // Outline color if needed
    if (sdfText.outlineColor) {
      uniformData[44] = sdfText.outlineColor.r;
      uniformData[45] = sdfText.outlineColor.g;
      uniformData[46] = sdfText.outlineColor.b;
      uniformData[47] = sdfText.outlineColor.a;
    }
    // const z = this.interactionService.getZDepthFor?.(sdfText.zIndex ?? 0) ?? 0.5;
    // uniformData[48] = z; // z depth for depth testing
    
    return uniformData;
  }

  private resizeBuffer(newSize: number) {
    const newBuffer = this.device.createBuffer({
      size: newSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    const commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(
      this.dynamicUniformBuffer!,
      0,
      newBuffer,
      0,
      this.currentOffset
    );
    const commandBuffer = commandEncoder.finish();
    this.device.queue.submit([commandBuffer]);
    this.dynamicUniformBuffer = newBuffer;

    // Recreate bind group with new buffer
    this.bindGroupManager.recreateSdfTextBindGroup(
      this.bindGroupManager.pipelineManager!.getSdfTextPipeline().getBindGroupLayout(0),
      newBuffer
    );
  }
}