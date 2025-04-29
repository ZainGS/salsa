import { Shape } from "../../../scene-graph/shapes/base/shape";
import { InteractionService } from "../../../services/interaction-service";
import { LegacyDataRegistry } from "../cache-registry/legacy-data-registry";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { GpuUniformCache } from "./gpu-uniform-cache";

export class PatternLegacyUniformCache extends GpuUniformCache<Shape> {
  private interactionService: InteractionService;

  constructor(
    initialBufferSize: number,
    device: GPUDevice,
    registry: LegacyDataRegistry<Shape>,
    interactionService: InteractionService
  ) {
    super(device, registry);
    this.dynamicUniformBuffer = device.createBuffer({
      size: initialBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.interactionService = interactionService;
  }

  public allocate(shape: Shape): number {
    let offset = this.registry.get(shape)?.uniformOffset;
    if (offset === undefined) {
      offset =
        this.unallocatedOffsets.pop() ?? this.currentOffset;

      if (offset === undefined) return 0;

      if (offset === this.currentOffset) {
        this.currentOffset += this.ALIGNMENT;
        if (this.currentOffset > this.dynamicUniformBuffer!.size) {
          this.resizeBuffer(this.dynamicUniformBuffer!.size * 2);
        }
      }

      this.registry.set('shape', shape, { uniformOffset: offset });
    }

    const uniformData = this.getShapeUniformData(shape);
    this.writeUniform(offset, uniformData);
    return offset;
  }

  public update(shape: Shape): void {
    const offset = this.registry.get(shape)?.uniformOffset;
    if (offset === undefined) return;
    const uniformData = this.getShapeUniformData(shape);
    this.writeUniform(offset, uniformData);
  }

  private getShapeUniformData(shape: Shape): Float32Array {
    const canvas = this.interactionService.canvas;
    const resolution = new Float32Array([canvas.width, canvas.height, 0, 0]);
    const worldMatrix = this.interactionService.getWorldMatrix();
    const localMatrix = shape.localMatrix;
    const colorSource = ["Scribble", "Line", "Highlight"].includes(shape.getType?.())
      ? shape.strokeColor
      : shape.fillColor;
    const shapeColor = new Float32Array([colorSource.r, colorSource.g, colorSource.b, colorSource.a]);
    const uniformData = new Float32Array(192);
    uniformData.set(resolution, 0);
    uniformData.set(worldMatrix, 4);
    uniformData.set(localMatrix, 20);
    uniformData.set(shapeColor, 36);

    return uniformData;
  }

  private resizeBuffer(newSize: number) {
    const newBuffer = this.device.createBuffer({
      size: newSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
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
