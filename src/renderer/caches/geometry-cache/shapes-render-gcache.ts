import { Shape } from "../../../scene-graph/shapes/base/shape";
import { GpuBufferUtils } from "../../util/gpu-buffer-utils";
import { GeometryOffsets } from "../cache-registry/render-data";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { GpuGeometryCache } from "./gpu-geometry-cache";

export class ShapesRenderGeometryCache extends GpuGeometryCache<Shape> {
  
  private sharedGeometryMap: Map<string, GeometryOffsets> = new Map();
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;

  private vertexData: Float32Array;
  private indexData: Uint16Array;

  public vertexOffset: number = 0;
  public indexOffset: number = 0;

  constructor(device: GPUDevice, registry: RenderDataRegistry<Shape>, maxVertices = 500_000, maxIndices = 1_000_000) {
    super(device, registry);

    this.vertexData = new Float32Array(maxVertices);
    this.indexData = new Uint16Array(maxIndices);

    this.vertexBuffer = GpuBufferUtils.createVertexBuffer(maxVertices, this.device);
    this.indexBuffer = GpuBufferUtils.createIndexBuffer(maxIndices, this.device);
  }

  public allocate(shape: Shape): void {
    const existing = this.registry.registryMap.get(shape.id);
    if (existing?.geometryOffset) {
      return; // Already allocated
    }

    if (shape.getType() != "Polygon") {
      const type = shape.getType();
      if (this.sharedGeometryMap.has(type)) {
        const sharedOffset = this.sharedGeometryMap.get(type)!;
        this.registry.set('shape', shape, { geometryOffset: sharedOffset });
        return;
      }
    
      // First shape of this type → add to global buffer
      const vertices = shape.getGeometryVertices();
      const indices = shape.getGeometryIndices();
    
      const vCount = vertices!.length;
      const iCount = indices!.length;

      ({buffer: this.vertexBuffer, data: this.vertexData} = GpuBufferUtils.ensureBufferCapacity(
        this.device.queue, 
        this.vertexBuffer, 
        this.vertexData, 
        this.vertexOffset,
        this.vertexOffset + vCount,
        4, // bytes per float32
        (size) => GpuBufferUtils.createVertexBuffer(size, this.device)
      ));
  
      ({buffer: this.indexBuffer, data: this.indexData} = GpuBufferUtils.ensureBufferCapacity(
        this.device.queue, 
        this.indexBuffer, 
        this.indexData, 
        this.indexOffset,
        this.indexOffset + iCount,
        2, // bytes per uint16
        (size) => GpuBufferUtils.createIndexBuffer(size, this.device)
      ));

      const vOffset = this.vertexOffset;
      const iOffset = this.indexOffset;
    
      this.vertexData.set(vertices!, vOffset);
      this.indexData.set(indices!, iOffset);
    
      GpuBufferUtils.writeBufferInChunks(
        this.device.queue,
        this.vertexBuffer,
        vOffset * 4,
        this.vertexData.buffer as ArrayBuffer,
        this.vertexData.byteOffset + vOffset * 4,
        vCount * 4
      );

      GpuBufferUtils.writeBufferInChunks(
        this.device.queue,
        this.indexBuffer,
        iOffset * 2,
        this.indexData.buffer as ArrayBuffer,
        this.indexData.byteOffset + iOffset * 2,
        iCount * 2
      );
    
      const offsets: GeometryOffsets = {
        vertexOffset: vOffset,
        indexOffset: iOffset,
        vertexCount: vertices!.length,
        indexCount: indices!.length,
      };
      
      this.sharedGeometryMap.set(type, offsets);
      this.registry.set('shape', shape, { geometryOffset: offsets });
    
      this.vertexOffset += vertices!.length;
      this.indexOffset += indices!.length;
      return;
    }

    const vertices = shape.getGeometryVertices(); // Float32Array of x/y positions
    const indices = shape.getGeometryIndices?.(); // Uint16Array or number[]
    const indexArray = indices instanceof Uint16Array ? indices : new Uint16Array(indices ?? []);

    const vCount = vertices!.length;
    const iCount = indexArray.length;

    ({buffer: this.vertexBuffer, data: this.vertexData} = GpuBufferUtils.ensureBufferCapacity(
      this.device.queue, 
      this.vertexBuffer, 
      this.vertexData, 
      this.vertexOffset,
      this.vertexOffset + vCount,
      4, // bytes per float32
      (size) => GpuBufferUtils.createVertexBuffer(size, this.device)
    ));

    ({buffer: this.indexBuffer, data: this.indexData} = GpuBufferUtils.ensureBufferCapacity(
      this.device.queue, 
      this.indexBuffer, 
      this.indexData, 
      this.indexOffset,
      this.indexOffset + iCount,
      2, // bytes per uint16
      (size) => GpuBufferUtils.createIndexBuffer(size, this.device)
    ));

    const vOffset = this.vertexOffset;
    const iOffset = this.indexOffset;

    this.vertexData.set(vertices!, vOffset);
    this.indexData.set(indexArray, iOffset);

    const byteLength = vertices!.length * 4;
    if (byteLength % 4 !== 0) {
      console.error(`Invalid byte length for shape ${shape.id}:`, byteLength, '(must be multiple of 4)');
    }
    
    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      vOffset * 4,
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + vOffset * 4,
      vCount * 4
    );

    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer,
      iOffset * 2,
      this.indexData.buffer as ArrayBuffer,
      this.indexData.byteOffset + iOffset * 2,
      iCount * 2
    );

    this.registry.set('shape', shape, {
      geometryOffset: {
        vertexOffset: vOffset,
        indexOffset: iOffset,
        vertexCount: vCount,
        indexCount: iCount,
      },
    });


    this.vertexOffset += vCount;
    this.indexOffset += iCount;

    return;
  }

  public update(shape: Shape): void {
    if (shape.getType() != "Polygon") return; // shared shapes never change

    const data = this.registry.registryMap.get(shape.id);
    const geometryOffsets = data?.geometryOffset;
    if (!geometryOffsets) return;
  
    const newVertices = shape.getGeometryVertices()!;
    const newIndices = shape.getGeometryIndices?.()!;
  
    if (
      newVertices.length > geometryOffsets.vertexCount ||
      newIndices.length > geometryOffsets.indexCount
    ) {
      console.warn(`Shape ${shape.id} grew beyond allocated buffer. Skipping update.`);
      return;
    }
  
    this.vertexData.set(newVertices, geometryOffsets.vertexOffset);
    this.indexData.set(newIndices, geometryOffsets.indexOffset);
  
    const byteLength = newVertices.length * 4;
    if (byteLength % 4 !== 0) {
      console.error(`Invalid byte length for shape ${shape.id}:`, byteLength, '(must be multiple of 4)');
    }
    
    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      geometryOffsets.vertexOffset * 4,
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + geometryOffsets.vertexOffset * 4,
      newVertices.length * 4
    );

    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer,
      geometryOffsets.indexOffset * 2,
      this.indexData.buffer as ArrayBuffer,
      this.indexData.byteOffset + geometryOffsets.indexOffset * 2,
      newIndices.length * 2
    );
  
    // Update count in case geometry shrunk
    geometryOffsets.vertexCount = newVertices.length;
    geometryOffsets.indexCount = newIndices.length;
  }

  public getVertexBuffer(): GPUBuffer {
    return this.vertexBuffer;
  }

  public getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  public getOffset(shape: Shape): GeometryOffsets | undefined {
    const entry = this.registry.get(shape.id);
    if (!entry || !entry.geometryOffset) {
      console.warn(`[ShapeGeometryCache] Offset not found for shape ${shape.id}`);
      return undefined;
    }
    return entry.geometryOffset;
  }
}