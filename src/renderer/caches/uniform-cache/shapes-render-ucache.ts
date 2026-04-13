import { Shape } from "../../../scene-graph/shapes/base/shape";
import { InteractionService } from "../../../services/interaction-service";
import { BindGroupManager } from "../../core/managers/bindgroup-manager";
import { GpuBufferUtils } from "../../util/gpu-buffer-utils";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { GpuUniformCache } from "./gpu-uniform-cache";

export class ShapesRenderUniformCache extends GpuUniformCache<Shape> {
  private interactionService: InteractionService;
  private bindGroupManager: BindGroupManager;

  constructor(
    initialBufferSize: number,
    device: GPUDevice,
    registry: RenderDataRegistry<Shape>,
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

  public allocate(shape: Shape): void {
    let offset = this.registry.registryMap.get(shape.id)?.uniformOffset;
    //if (offset !== undefined) return;
    if (offset === undefined) {
      offset =
        this.unallocatedOffsets.pop() ?? this.currentOffset;
      
      if (offset === this.currentOffset) {
        this.currentOffset += this.ALIGNMENT;
        if (this.currentOffset > this.dynamicUniformBuffer!.size) {
          this.resizeBuffer(this.dynamicUniformBuffer!.size * 2);
        }
      }

      const shapeIndex = offset / this.ALIGNMENT;
      this.registry.set('shape', shape, { uniformOffset: offset, shapeIndex });
    }

    const uniformData = this.getShapeUniformData(shape);
    this.writeUniform(offset, uniformData);
    return;
  }

  public update(shape: Shape): void {
    const offset = this.registry.registryMap.get(shape.id)?.uniformOffset;
    if (offset === undefined) return;
    const uniformData = this.getShapeUniformData(shape);
    this.writeUniform(offset, uniformData);
  }

  private getShapeUniformData(shape: Shape): Float32Array {
    const canvas = this.interactionService.canvas;
    const resolution = new Float32Array([canvas.width, canvas.height, 0, 0]);
    const worldMatrix = this.interactionService.getWorldMatrix();
    const localMatrix = shape.localMatrix;
    const colorSource = shape.fillColor;
    const shapeColor = new Float32Array([colorSource.r, colorSource.g, colorSource.b, colorSource.a]);
    const uniformData = new Float32Array(64);
    uniformData.set(resolution, 0);       // [0-3]
    uniformData.set(worldMatrix, 4);      // [4-19]
    uniformData.set(localMatrix, 20);     // [20-35]
    uniformData.set(shapeColor, 36);      // [36-39]
    uniformData[40] = shape.strokeWidth ?? 1; // thickness
    // uniformData[41] = z; // z depth for depth testing
    // [42-63] will remain padded with 0s automatically
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

    const oldBuffer = this.dynamicUniformBuffer!;
    this.dynamicUniformBuffer = newBuffer;
    // Destroy old buffer after GPU copy completes (queued after submit)
    oldBuffer.destroy();

    // Let the manager handle all recreation logic
    this.bindGroupManager.recreateShapeBindGroup(
      this.bindGroupManager.pipelineManager!.getShapePipeline().getBindGroupLayout(0),
      newBuffer
    );
  }

    // For Bounding Boxes:
    private shapeToOffset: Map<Shape, number> = new Map();
    private shapeMatrixVersion: Map<Shape, number> = new Map();
    allocateLocalMatrix(shape: Shape): number {
        const lastVersion = this.shapeMatrixVersion.get(shape);
        const currentVersion = shape.localMatrixVersion;
    
        // If already cached and version hasn't changed, reuse offset
        if (this.shapeToOffset.has(shape) && lastVersion === currentVersion) {
            return this.shapeToOffset.get(shape)!;
        }
    
        let offset: number;
    
        // If shape is already cached but version changed, overwrite existing offset
        if (this.shapeToOffset.has(shape)) {
            offset = this.shapeToOffset.get(shape)!;
        } else {
            // Allocate new aligned offset
            offset = Math.ceil(this.currentOffset / this.ALIGNMENT) * this.ALIGNMENT;
            this.shapeToOffset.set(shape, offset);
            this.currentOffset = offset + this.ALIGNMENT;
        }
    
        // Write the updated matrix
        this.device.queue.writeBuffer(this.dynamicUniformBuffer!, offset, new Float32Array(shape.localMatrix));
    
        // Update the version tracker
        this.shapeMatrixVersion.set(shape, currentVersion);
    
        return offset;
    }
}
