import { SDFText } from "../../../scene-graph/shapes/sdf-text/sdf-text";
import { GeometryOffsets } from "../cache-registry/render-data";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { GpuGeometryCache } from "./gpu-geometry-cache";
import { GpuBufferUtils } from "../../util/gpu-buffer-utils";

export class SdfTextRenderGeometryCache extends GpuGeometryCache<SDFText> {
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  private vertexData: Float32Array;
  private indexData: Uint16Array;
  public vertexOffset: number = 0; // offset in floats
  public indexOffset: number = 0;  // offset in indices

  constructor(device: GPUDevice, registry: RenderDataRegistry<SDFText>, maxVertices = 100_000, maxIndices = 200_000) {
    super(device, registry);

    this.vertexData = new Float32Array(maxVertices * 4); // x, y, u, v per vertex
    this.indexData = new Uint16Array(maxIndices);

    this.vertexBuffer = GpuBufferUtils.createVertexBuffer(maxVertices * 4, this.device);
    this.indexBuffer = GpuBufferUtils.createIndexBuffer(maxIndices, this.device);
  }

  public allocate(sdfText: SDFText): void {
    const existing = this.registry.registryMap.get(sdfText.id);
    if (existing?.geometryOffset) {
      return; // Already allocated
    }

    // Generate geometry for the text
    const geometry = this.generateTextGeometry(sdfText);
    const vCount = geometry.vertices.length; // number of floats
    const iCount = geometry.indices.length;  // number of indices

    // Ensure buffers are large enough using GpuBufferUtils
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

    const vOffset = this.vertexOffset; // offset in floats
    const iOffset = this.indexOffset; // offset in indices

    // Copy geometry data to our arrays
    this.vertexData.set(geometry.vertices, vOffset);
    this.indexData.set(geometry.indices, iOffset);

    // Upload to GPU using GpuBufferUtils
    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      vOffset * 4, // byte offset
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + vOffset * 4,
      vCount * 4
    );

    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer,
      iOffset * 2, // byte offset
      this.indexData.buffer as ArrayBuffer,
      this.indexData.byteOffset + iOffset * 2,
      iCount * 2
    );

    const floatsPerVertex = 4; // x, y, u, v

    // Store allocation info
    this.registry.set('sdfText', sdfText, {
      geometryOffset: {
        vertexOffset: vOffset / floatsPerVertex, // store as vertex count
        indexOffset: iOffset,
        vertexCount: vCount / floatsPerVertex,   // store as vertex count
        indexCount: iCount,
      },
    });

    this.vertexOffset += vCount;
    this.indexOffset += iCount;
  }

  public update(sdfText: SDFText): void {
    const entry = this.registry.registryMap.get(sdfText.id);
    const oldGeo = entry?.geometryOffset;
    if (!oldGeo) return;

    const geo = this.generateTextGeometry(sdfText);
    const floatsPerVertex = 4;

    // Convert stored vertex counts back to float counts for comparison
    const oldVertexFloatCount = oldGeo.vertexCount * floatsPerVertex;
    const oldIndexCount = oldGeo.indexCount;

    // Check if new geometry fits in existing allocation
    const needsGrow = 
      geo.vertices.length > oldVertexFloatCount ||
      geo.indices.length > oldIndexCount;

    let vOffsetFloats: number; // offset in floats
    let iOffset: number;       // offset in indices

    if (needsGrow) {
      // Allocate new space at the end
      vOffsetFloats = this.vertexOffset;
      iOffset = this.indexOffset;

      // Ensure buffers are large enough using GpuBufferUtils
      ({buffer: this.vertexBuffer, data: this.vertexData} = GpuBufferUtils.ensureBufferCapacity(
        this.device.queue, 
        this.vertexBuffer, 
        this.vertexData, 
        vOffsetFloats,
        vOffsetFloats + geo.vertices.length,
        4, // bytes per float32
        (size) => GpuBufferUtils.createVertexBuffer(size, this.device)
      ));

      ({buffer: this.indexBuffer, data: this.indexData} = GpuBufferUtils.ensureBufferCapacity(
        this.device.queue, 
        this.indexBuffer, 
        this.indexData, 
        iOffset,
        iOffset + geo.indices.length,
        2, // bytes per uint16
        (size) => GpuBufferUtils.createIndexBuffer(size, this.device)
      ));

      // Update registry with new allocation
      entry.geometryOffset = {
        vertexOffset: vOffsetFloats / floatsPerVertex, // store as vertex count
        indexOffset: iOffset,
        vertexCount: geo.vertices.length / floatsPerVertex, // store as vertex count
        indexCount: geo.indices.length,
      };

      // Update global offsets
      this.vertexOffset += geo.vertices.length;
      this.indexOffset += geo.indices.length;
    } else {
      // Reuse existing allocation
      vOffsetFloats = oldGeo.vertexOffset * floatsPerVertex; // convert back to float offset
      iOffset = oldGeo.indexOffset;

      // Update counts in existing allocation
      entry.geometryOffset.vertexCount = geo.vertices.length / floatsPerVertex;
      entry.geometryOffset.indexCount = geo.indices.length;
    }

    // Copy geometry data to arrays
    this.vertexData.set(geo.vertices, vOffsetFloats);
    this.indexData.set(geo.indices, iOffset);

    // Upload to GPU using GpuBufferUtils
    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer, 
      vOffsetFloats * 4, // byte offset
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + vOffsetFloats * 4,
      geo.vertices.length * 4
    );

    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer, 
      iOffset * 2, // byte offset
      this.indexData.buffer as ArrayBuffer,
      this.indexData.byteOffset + iOffset * 2,
      geo.indices.length * 2
    );
  }

  private generateTextGeometry(t: SDFText) {
    return {
      vertices: t.getGeometryVertices(),   // Float32Array
      indices: t.getGeometryIndices()      // Uint16Array
    };
  }

  public getVertexBuffer(): GPUBuffer {
    return this.vertexBuffer;
  }

  public getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  public getOffset(sdfText: SDFText): GeometryOffsets | undefined {
    const entry = this.registry.get(sdfText);
    return entry?.geometryOffset;
  }
}