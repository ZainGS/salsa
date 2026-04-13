import { Shape } from "../../../scene-graph/shapes/base/shape";
import { InteractionService } from "../../../services/interaction-service";
import { BindGroupManager } from "../../core/managers/bindgroup-manager";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { GpuUniformCache } from "./gpu-uniform-cache";

export class HighlightsRenderUniformCache extends GpuUniformCache<Shape> {
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

  public allocate(shape: Shape): number {
    let offset = this.registry.registryMap.get(shape.id)?.uniformOffset;
    if (offset !== undefined) return offset;

    offset = this.currentOffset;
    this.currentOffset += this.ALIGNMENT;

    if (this.currentOffset > this.dynamicUniformBuffer!.size) {
      this.resizeBuffer(this.dynamicUniformBuffer!.size * 2);
    }

    const shapeIndex = offset / this.ALIGNMENT;
    this.registry.set("highlight", shape, { uniformOffset: offset, shapeIndex });

    const uniformData = this.getHighlightUniformData(shape);
    this.writeUniform(offset, uniformData);

    return offset;
  }

  public update(shape: Shape): void {
    const offset = this.registry.registryMap.get(shape.id)?.uniformOffset;
    if (offset === undefined) return;

    const uniformData = this.getHighlightUniformData(shape);
    this.writeUniform(offset, uniformData);
  }

  private getHighlightUniformData(shape: Shape): Float32Array {
    const canvas = this.interactionService.canvas;
    const resolution = new Float32Array([canvas.width, canvas.height, 0, 0]);
    const worldMatrix = this.interactionService.getWorldMatrix();
    const localMatrix = shape.localMatrix;
    const colorSource = shape.strokeColor;
    const shapeColor = new Float32Array([colorSource.r, colorSource.g, colorSource.b, colorSource.a]);
    const uniformData = new Float32Array(64);

    uniformData.set(resolution, 0);       // [0-3]
    uniformData.set(worldMatrix, 4);      // [4-19]
    uniformData.set(localMatrix, 20);     // [20-35]
    uniformData.set(shapeColor, 36);      // [36-39]
    uniformData[40] = shape.strokeWidth ?? 1; // [40] = thickness
    // uniformData[41] = z; // z depth for depth testing
    uniformData[63] = 0; // Pad the last slot
    return uniformData;
  }

  private shapeMatrixVersion: Map<Shape, number> = new Map();
  public allocateLocalMatrix(shape: Shape): number {
    const lastVersion = this.shapeMatrixVersion.get(shape);
    const currentVersion = shape.localMatrixVersion;

    if (lastVersion === currentVersion) {
      return this.registry.registryMap.get(shape.id)?.uniformOffset ?? 0;
    }

    const offset = this.registry.registryMap.get(shape.id)?.uniformOffset;
    if (offset === undefined) {
      console.warn("Cannot update local matrix: uniformOffset not found for shape", shape.id);
      return 0;
    }

    const localMatrixByteOffset = offset + 4 * 4 + 16 * 4;
    this.device.queue.writeBuffer(
      this.dynamicUniformBuffer!,
      localMatrixByteOffset,
      new Float32Array(shape.localMatrix)
    );

    this.shapeMatrixVersion.set(shape, currentVersion);
    return offset;
  }

  private resizeBuffer(newSize: number) {
    const newBuffer = this.device.createBuffer({
      size: newSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.dynamicUniformBuffer!, 0, newBuffer, 0, this.currentOffset);
    this.device.queue.submit([encoder.finish()]);
    this.dynamicUniformBuffer = newBuffer;

    // Recreate the bind group for highlights
    this.bindGroupManager.recreateHighlightBindGroup(
      this.bindGroupManager.pipelineManager!.getHighlightPipeline().getBindGroupLayout(0),
      newBuffer
    );
  }
}