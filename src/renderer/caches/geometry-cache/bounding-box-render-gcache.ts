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

    private currentVertexOffset = 0;

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

    // allocate(shape: Shape, thickness: number = 0.01): number {
    //     if (this.registry.registryMap.get(shape.id)?.geometryOffset) {
    //       return this.registry.registryMap.get(shape.id)!.geometryOffset!.vertexOffset;
    //     }
      
    //     const vertexOffset = [...this.registry.registryMap.entries()].length * this.vertexStride; // crude count of how many allocated
    //     const vertices = shape.getBoundingBoxVertices(thickness);
      
    //     this.device.queue.writeBuffer(this.vertexBuffer, vertexOffset, vertices);
      
    //     this.registry.registryMap.set(shape.id, {
    //       geometryOffset: {
    //         vertexOffset,
    //         indexOffset: 0, // shared index buffer
    //         vertexCount: vertices.length,
    //         indexCount: this.BOUNDING_BOX_INDICES.length
    //       }
    //     });
      
    //     return vertexOffset;
    //   }

    allocate(shape: Shape, thickness: number = 0.01): number {
      const existing = this.registry.registryMap.get(shape.id);
      if (existing?.geometryOffset) {
        return existing.geometryOffset.vertexOffset;
      }
    
      const floatsPerBox = 8 * 2;
    
      if ((this.currentVertexOffset + floatsPerBox) > this.maxBoxes * floatsPerBox) {
        console.warn(`[BoundingBoxRenderGeometryCache] Overflow: maxBoxes exceeded`);
        return -1;
      }
    
      const vertexOffset = this.currentVertexOffset;
      this.currentVertexOffset += floatsPerBox;
    
      const vertices = shape.getBoundingBoxVertices(thickness);
      // const vertices = this.getBoundingBoxTestVertices();
    
      if (vertices.length !== floatsPerBox) {
        console.warn(`Unexpected vertex count: ${vertices.length}, expected ${floatsPerBox}`);
      }
    
      this.device.queue.writeBuffer(this.vertexBuffer, vertexOffset * 4, vertices);
    
      this.registry.set('shape', shape, {
        geometryOffset: {
          vertexOffset,
          indexOffset: 0,
          vertexCount: vertices.length,
          indexCount: this.BOUNDING_BOX_INDICES.length,
        },
      });
    
      return vertexOffset;
    }

    update(shape: Shape, thickness: number = 0.01): void {
        const offset = this.registry.registryMap.get(shape.id)?.geometryOffset;
        if (!offset) return;

        const vertices = shape.getBoundingBoxVertices(thickness);
        // const vertices = this.getBoundingBoxTestVertices();
        this.device.queue.writeBuffer(this.vertexBuffer, offset.vertexOffset * 4, vertices);

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
        return this.registry.registryMap.get(shape.id)?.geometryOffset;
      }

      clear(): void {
        this.registry.registryMap.clear();
        this.currentVertexOffset = 0;
      }

    getBoundingBoxTestVertices(): Float32Array {
      const thickness = 0.05;
      const half = 0.5;

      const testBoundingBoxVertices = new Float32Array([
        // Outer box (slightly bigger)
        -half - thickness, -half - thickness, // 0
        half + thickness, -half - thickness, // 1
        -half - thickness,  half + thickness, // 2
        half + thickness,  half + thickness, // 3

        // Inner box (original size)
        -half, -half, // 4
        half, -half, // 5
        -half,  half, // 6
        half,  half  // 7
      ]);

      return testBoundingBoxVertices;
    }
}