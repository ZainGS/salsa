// pattern-render-ucache.ts
import { Shape } from "../../../scene-graph/shapes/base/shape";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { GpuUniformCache } from "./gpu-uniform-cache";
import { InteractionService } from "../../../services/interaction-service";
import { BindGroupManager } from "../../core/managers/bindgroup-manager";
import { Pattern } from "../../../scene-graph/shapes/pattern";

export class PatternRenderUniformCache extends GpuUniformCache<Pattern> {
  constructor(
    initialBufferSize: number,
    device: GPUDevice,
    registry: RenderDataRegistry<Pattern>,
    private interactionService: InteractionService,
    private bindGroupManager: BindGroupManager
  ) {
    super(device, registry);
    this.dynamicUniformBuffer = device.createBuffer({
      size: initialBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  }

  public allocate(shape: Pattern): number {
    let offset = this.registry.registryMap.get(shape.id)?.uniformOffset;

    if (offset === undefined) {
      offset = this.currentOffset;
      this.currentOffset += this.ALIGNMENT;
    //   if (this.currentOffset > this.dynamicUniformBuffer!.size) {
    //     this.resizeBuffer(this.dynamicUniformBuffer!.size * 2);
    //   }

      const shapeIndex = offset / this.ALIGNMENT;
      this.registry.set("shape", shape, { uniformOffset: offset, shapeIndex });
    }

    this.writeUniform(offset, this.getUniformData(shape));
    return offset;
  }

  public update(shape: Pattern): void {
    const offset = this.registry.registryMap.get(shape.id)?.uniformOffset;
    if (offset === undefined) return;
    this.writeUniform(offset, this.getUniformData(shape));
  }

  private getUniformData(shape: Pattern): Float32Array {
    const resolution = new Float32Array([
      this.interactionService.canvas.width,
      this.interactionService.canvas.height,
      0,
      0,
    ]);
    const worldMatrix = this.interactionService.getWorldMatrix();
    const localMatrix = shape.localMatrix;
    const patternIndex = shape.patternIndex ?? 0;

    const data = new Float32Array(64);
    data.set(resolution, 0);
    data.set(worldMatrix, 4);
    data.set(localMatrix, 20);
    data[36] = patternIndex;

    return data;
  }

//   private resizeBuffer(newSize: number) {
//     const newBuffer = this.device.createBuffer({
//       size: newSize,
//       usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
//     });

//     const encoder = this.device.createCommandEncoder();
//     encoder.copyBufferToBuffer(this.dynamicUniformBuffer!, 0, newBuffer, 0, this.currentOffset);
//     this.device.queue.submit([encoder.finish()]);
//     this.dynamicUniformBuffer = newBuffer;

//     this.bindGroupManager.recreatePatternBindGroup(
//       this.bindGroupManager.pipelineManager!.getPatternPipeline().getBindGroupLayout(0),
//       newBuffer
//     );
//   }
}
