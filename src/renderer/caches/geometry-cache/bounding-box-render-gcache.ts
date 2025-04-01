// src/renderer/caches/bounding-box-render-cache.ts
import { Shape } from '../../../scene-graph/shapes/base/shape';
import { GeometryOffsets } from '../cache-registry/render-data';
import { RenderDataRegistry } from '../cache-registry/render-data-registry';
import { GpuGeometryCache } from './gpu-geometry-cache';


export class BoundingBoxRenderGeometryCache extends GpuGeometryCache<Shape> {
    private vertexBuffer: GPUBuffer;
    private indexBuffer: GPUBuffer;

    private maxBoxes: number = 1024;
    private vertexStride: number = 8 * 2 * 4; // 8 vertices, 2 floats, 4 bytes

    private BOUNDING_BOX_INDICES = new Uint16Array([
        0, 1, 4, 4, 1, 5, // Bottom
        2, 3, 6, 6, 3, 7, // Top
        0, 2, 4, 4, 2, 6, // Left
        1, 3, 5, 5, 3, 7  // Right
    ]);

    constructor(device: GPUDevice, registry: RenderDataRegistry<Shape>) {
        super(device, registry);

        this.vertexBuffer = device.createBuffer({
            size: this.maxBoxes * this.vertexStride,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });

        this.indexBuffer = device.createBuffer({
            size: this.BOUNDING_BOX_INDICES.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });

        new Uint16Array(this.indexBuffer.getMappedRange()).set(this.BOUNDING_BOX_INDICES);
        this.indexBuffer.unmap();
    }

    allocate(shape: Shape, thickness: number = 0.01): number {
        if (this.registry.get(shape)?.geometryOffset) {
          return this.registry.get(shape)!.geometryOffset!.vertexOffset;
        }
      
        const vertexOffset = [...this.registry.entries()].length * this.vertexStride; // crude count of how many allocated
        const vertices = shape.getBoundingBoxVertices(thickness);
      
        this.device.queue.writeBuffer(this.vertexBuffer, vertexOffset, vertices);
      
        this.registry.set(shape, {
          geometryOffset: {
            vertexOffset,
            indexOffset: 0, // shared index buffer
            vertexCount: vertices.length,
            indexCount: this.BOUNDING_BOX_INDICES.length
          }
        });
      
        return vertexOffset;
      }

    update(shape: Shape, thickness: number = 0.01): void {
        const offset = this.registry.get(shape)?.geometryOffset;
        if (!offset) return;

        const vertices = shape.getBoundingBoxVertices(thickness);
        this.device.queue.writeBuffer(this.vertexBuffer, offset.vertexOffset, vertices);

        // In case bounding box shape changes
        // ...but it SHOULD be a constant
        // offset.vertexCount = vertices.length;
    }

    getVertexBuffer(): GPUBuffer {
        return this.vertexBuffer;
    }

    getIndexBuffer(): GPUBuffer {
        return this.indexBuffer;
    }

    public getOffset(shape: Shape): GeometryOffsets | undefined {
        return this.registry.get(shape)?.geometryOffset;
      }

    clear(): void {
        this.registry.clear();
    }
}