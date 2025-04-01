// gpu-uniform-cache.ts
// A uniform system concerned only with aligned 256-byte slices and bind groups
import type { RenderDataRegistry } from "../cache-registry/render-data-registry";

export interface GpuBufferOffsets {
  uniformOffset?: number;
}

export abstract class GpuUniformCache<T extends { id: string }> {
  protected device: GPUDevice;
  protected dynamicUniformBuffer?: GPUBuffer;
  
  protected unallocatedOffsets: number[] = [];
  protected currentOffset: number = 0;
  protected readonly ALIGNMENT = 256; // WebGPU requires uniform buffer offsets to be 256-byte aligned

  protected registry: RenderDataRegistry<T>;

  constructor(device: GPUDevice, registry: RenderDataRegistry<T>) {
    this.device = device;
    this.registry = registry;
  }

  public getOffset(obj: T): GpuBufferOffsets | undefined {
    return this.registry.get(obj);
  }

  public deallocate(obj: T): void {
    const existing = this.registry.get(obj);
    const offset = existing?.uniformOffset;
    if (offset !== undefined) this.unallocatedOffsets.push(offset);
    this.registry.delete(obj);
  }

  protected writeUniform(offset: number, data: Float32Array) {
    if (!this.dynamicUniformBuffer) return;
    this.device.queue.writeBuffer(
      this.dynamicUniformBuffer,
      offset,
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
  }

  public getUniformBuffer(): GPUBuffer | undefined {
    return this.dynamicUniformBuffer;
  }

  public abstract allocate(obj: T): number;
  public abstract update(obj: T): void;
}