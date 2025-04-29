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

  constructor(device: GPUDevice, registry: RenderDataRegistry<T> | any) {
    this.device = device;
    this.registry = registry;
  }

  public getOffset(obj: T): GpuBufferOffsets | undefined {
    return this.registry.registryMap.get(obj.id);
  }

  public deallocate(obj: T): void {
    const existing = this.registry.registryMap.get(obj.id);
    const offset = existing?.uniformOffset;
    if (offset !== undefined) this.unallocatedOffsets.push(offset);
    this.registry.registryMap.delete(obj.id);
  }

  protected writeUniform(offset: number, data: Float32Array) {
    // console.log(`[UNIFORM] Writing to offset ${offset} (instance ${offset/256})`);
    // console.log('Color:', data[36], data[37], data[38], data[39]);
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
    // const shape0 = new Float32Array(64);
    // const shape1 = new Float32Array(64);

    // // Fill in test values:
    // shape0.set([1285, 991, 0, 0], 0); // resolution
    // shape0.set([1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1], 4); // worldMatrix
    // shape0.set([1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1], 20); // localMatrix
    // shape0.set([1, 0, 0, 1], 36); // red

    // shape1.set([1285, 991, 0, 0], 0);
    // shape1.set([1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1], 4);
    // shape1.set([1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1], 20);
    // shape1.set([0, 1, 0, 1], 36); // green

    // const fullData = new Float32Array(64 * 2);
    // fullData.set(shape0, 0);
    // fullData.set(shape1, 64);

    // const testBuffer = this.device.createBuffer({
    //   size: 256 * 2, // 2 shapes
    //   usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    //   mappedAtCreation: true,
    // });

    // new Float32Array(testBuffer.getMappedRange()).set(fullData);
    // testBuffer.unmap();

    // return testBuffer;
  }

  public abstract allocate(obj: T): void;
  public abstract update(obj: T): void;
}