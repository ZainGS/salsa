import { mat4 } from "gl-matrix";
import { Shape } from "../../../scene-graph/shapes/base/shape";
import { BindGroupManager } from "../../core/managers/bindgroup-manager";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { InteractionService } from "../../../services/interaction-service";

export class BoundingBoxRenderUniformCache {
  private readonly ALIGNMENT = 256;
  private currentOffset = 0;

  private localMatrixBuffer: GPUBuffer;
  private worldMatrixBuffer: GPUBuffer;

  constructor(
    initialSize: number,
    private device: GPUDevice,
    private registry: RenderDataRegistry<Shape>,
    private interactionService: InteractionService,
    private bindGroupManager: BindGroupManager
  ) {
    this.localMatrixBuffer = device.createBuffer({
      size: initialSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.worldMatrixBuffer = device.createBuffer({
      size: 64, // just one mat4x4<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  } 

  public allocate(shape: Shape): number {
    const entry = this.registry.registryMap.get(shape.id);
    let offset = entry?.uniformOffset;

    if (offset === undefined) {
      offset = Math.ceil(this.currentOffset / this.ALIGNMENT) * this.ALIGNMENT;
      this.currentOffset = offset + this.ALIGNMENT;

      this.registry.set('shape', shape, {
        uniformOffset: offset,
        shapeIndex: offset / this.ALIGNMENT // ensure `firstInstance` is valid
      });
    }

    this.update(shape);
    return offset;
  }

  public update(shape: Shape): void {
    const entry = this.registry.registryMap.get(shape.id);
    if (!entry) return;

    const offset = entry.uniformOffset!;

    const matrix = shape.usesWorldSpaceBoundingBox()
      ? mat4.identity(new Float32Array(16)) // identity if we're in world space already
      : shape.localMatrix;

    const fullStruct = new Float32Array(64); // 64 floats = 256 bytes
    fullStruct.set(new Float32Array(matrix), 0); // Fill only the first mat4

    this.device.queue.writeBuffer(
      this.localMatrixBuffer,
      offset,
      fullStruct
    );

    // this.device.queue.writeBuffer(
    //   this.localMatrixBuffer,
    //   offset,
    //   new Float32Array(shape.localMatrix)
    // );
  }

  /**
   * Release the bounding-box uniform slot for a deleted shape.
   */
  public deallocate(shape: Shape): void {
    this.registry.registryMap.delete(shape.id);
  }

  public updateWorldMatrix(): void {
    this.device.queue.writeBuffer(
      this.worldMatrixBuffer,
      0,
      new Float32Array(this.interactionService.getWorldMatrix())
    );
  }

  public getLocalBuffer(): GPUBuffer {
    return this.localMatrixBuffer;
  }

  public getWorldBuffer(): GPUBuffer {
    return this.worldMatrixBuffer;
  }
}