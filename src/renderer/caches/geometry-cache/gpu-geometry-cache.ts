// gpu-geometry-cache.ts
// A geometry system concerned with dynamic vertex/index buffer growth and triangle batching

import { LegacyDataRegistry } from "../cache-registry/legacy-data-registry";
import { GeometryOffsets } from "../cache-registry/render-data";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";

export abstract class GpuGeometryCache<T extends {id: string}> {
  protected device: GPUDevice;
  public registry: any;

  constructor(device: GPUDevice, registry: RenderDataRegistry<T> | LegacyDataRegistry<T>) {
    this.device = device;
    this.registry = registry;
  }

  public abstract allocate(obj: T, vertexCount: number, indexCount: number): void;
  public abstract update(obj: T): void;

  public abstract getVertexBuffer(): GPUBuffer;
  public abstract getIndexBuffer(): GPUBuffer;

  public abstract getOffset(obj: T): GeometryOffsets | undefined;
}