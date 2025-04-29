import { Shape } from "../../../scene-graph/shapes/base/shape";
import { Pattern } from "../../../scene-graph/shapes/pattern";
import { LegacyDataRegistry } from "../cache-registry/legacy-data-registry";
import { GeometryOffsets } from "../cache-registry/render-data";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { GpuGeometryCache } from "./gpu-geometry-cache";

export class PatternLegacyGeometryCache extends GpuGeometryCache<Shape> {
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;

  private vertexData: Float32Array;
  private indexData: Uint16Array;

  private maxVertices: number;
  private maxIndices: number;

  public vertexOffset: number = 0;
  public indexOffset: number = 0;
  
  private MAX_CHUNK_SIZE = 256 * 1024; // 256 KB

  constructor(device: GPUDevice, registry: LegacyDataRegistry<Shape>, maxVertices = 500_000, maxIndices = 1_000_000) {
    super(device, registry);
    this.maxVertices = maxVertices;
    this.maxIndices = maxIndices;

    this.vertexData = new Float32Array(maxVertices);
    this.indexData = new Uint16Array(maxIndices);

    this.vertexBuffer = this.createVertexBuffer(maxVertices);
    this.indexBuffer = this.createIndexBuffer(maxIndices);
  }

  public allocate(shape: Shape): number {
    const existing = this.registry.get(shape);

    if (existing?.geometryOffset) {
      return 0; // Already allocated
    }

    const vertices = shape.getGeometryVertices(); // Float32Array of x/y positions
    const indices = shape.getGeometryIndices?.(); // Uint16Array or number[]
    const indexArray = indices instanceof Uint16Array ? indices : new Uint16Array(indices ?? []);

    const vCount = vertices!.length;
    const iCount = indexArray.length;

    this.ensureVertexCapacity(this.vertexOffset + vCount);
    this.ensureIndexCapacity(this.indexOffset + iCount);

    const vOffset = this.vertexOffset;
    const iOffset = this.indexOffset;

    this.vertexData.set(vertices!, vOffset);
    this.indexData.set(indexArray, iOffset);

    const byteLength = vertices!.length * 4;
    if (byteLength % 4 !== 0) {
      console.error(`Invalid byte length for shape ${shape.id}:`, byteLength, '(must be multiple of 4)');
    }
    
    this.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      vOffset * 4,
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + vOffset * 4,
      vCount * 4
    );
    
    this.writeBufferInChunks(
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
    return 0;
  }

  public update(shape: Pattern): void {
    const data = this.registry.get(shape);
    const geometryOffsets = data?.geometryOffset;
    if (!geometryOffsets) return;
  
    const newVertices = shape.getGeometryVertices();
    const newIndices = shape.getGeometryIndices();
  
    if (!newVertices || !newIndices) {
      console.warn(`Pattern ${shape.id} has no vertices or indices`);
      return;
    }
  
    // SAFETY CHECK
    if (
      isNaN(geometryOffsets.vertexOffset) ||
      isNaN(geometryOffsets.indexOffset) ||
      isNaN(newVertices.length) ||
      isNaN(newIndices.length)
    ) {
      console.error("Invalid geometry data:", {
        shapeId: shape.id,
        vertexOffset: geometryOffsets.vertexOffset,
        indexOffset: geometryOffsets.indexOffset,
        vertexLength: newVertices.length,
        indexLength: newIndices.length
      });
      return;
    }
  
    if (
      newVertices.length > geometryOffsets.vertexCount ||
      newIndices.length > geometryOffsets.indexCount
    ) {
      console.warn(`Pattern ${shape.id} grew beyond allocated buffer. Skipping update.`);
      return;
    }
  
    this.vertexData.set(newVertices, geometryOffsets.vertexOffset);
    this.indexData.set(newIndices, geometryOffsets.indexOffset);
  
    const vertexByteOffset = geometryOffsets.vertexOffset * 4;
    const indexByteOffset = geometryOffsets.indexOffset * 2;
  
    const vertexSrcOffset = this.vertexData.byteOffset + vertexByteOffset;
    const indexSrcOffset = this.indexData.byteOffset + indexByteOffset;
  
    const vertexSize = newVertices.length * 4;
    const indexSize = newIndices.length * 2;
  
    // More safety logs
    if (
      !Number.isInteger(vertexByteOffset) ||
      !Number.isInteger(vertexSrcOffset) ||
      !Number.isInteger(vertexSize)
    ) {
      console.error("Invalid vertex buffer arguments", {
        vertexByteOffset,
        vertexSrcOffset,
        vertexSize
      });
      return;
    }
  
    this.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      vertexByteOffset,
      this.vertexData.buffer as ArrayBuffer,
      vertexSrcOffset,
      vertexSize
    );
  
    this.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer,
      indexByteOffset,
      this.indexData.buffer as ArrayBuffer,
      indexSrcOffset,
      indexSize
    );
  
    // Update geometry counts
    geometryOffsets.vertexCount = newVertices.length;
    geometryOffsets.indexCount = newIndices.length;
  }

  private ensureVertexCapacity(required: number) {
    if (required >= this.vertexData.length) {
      const newSize = Math.max(this.vertexData.length * 2, required);
      const newVertexData = new Float32Array(newSize);
      newVertexData.set(this.vertexData.subarray(0, this.vertexOffset));
      const newBuffer = this.createVertexBuffer(newSize);

      this.writeBufferInChunks(
        this.device.queue,
        newBuffer,
        0,
        newVertexData.buffer as ArrayBuffer,
        0,
        this.vertexOffset * 4
      );

      this.vertexBuffer.destroy();
      this.vertexBuffer = newBuffer;
      this.vertexData = newVertexData;
    }
  }

  private ensureIndexCapacity(required: number) {
    if (required >= this.indexData.length) {
      const newSize = Math.max(this.indexData.length * 2, required);
      const newIndexData = new Uint16Array(newSize);
      newIndexData.set(this.indexData.subarray(0, this.indexOffset));
      const newBuffer = this.createIndexBuffer(newSize);

      this.writeBufferInChunks(
        this.device.queue,
        newBuffer,
        0,
        newIndexData.buffer as ArrayBuffer,
        0,
        this.indexOffset * 2
      );

      this.indexBuffer.destroy();
      this.indexBuffer = newBuffer;
      this.indexData = newIndexData;
    }
  }

  private createVertexBuffer(size: number): GPUBuffer {
    return this.device.createBuffer({
      size: size * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  private createIndexBuffer(size: number): GPUBuffer {
    return this.device.createBuffer({
      size: size * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
  }

  writeBufferInChunks(
    queue: GPUQueue,
    buffer: GPUBuffer,
    dstOffset: number,
    src: ArrayBuffer,
    srcOffset: number,
    totalBytes: number
  ) {
    let remaining = totalBytes;
    while (remaining > 0) {
      const chunkSize = Math.min(remaining, this.MAX_CHUNK_SIZE);
      queue.writeBuffer(buffer, dstOffset, src, srcOffset, chunkSize);
      dstOffset += chunkSize;
      srcOffset += chunkSize;
      remaining -= chunkSize;
    }
  }

  public getVertexBuffer(): GPUBuffer {
    return this.vertexBuffer;
  }

  public getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  public getOffset(shape: Shape): GeometryOffsets | undefined {
    const entry = this.registry.get(shape);
    if (!entry || !entry.geometryOffset) {
      console.warn(`[ShapeGeometryCache] Offset not found for shape ${shape.id}`);
      return undefined;
    }
    return entry.geometryOffset;
  }
}