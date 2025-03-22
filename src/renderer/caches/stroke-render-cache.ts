// src/rendering/util/stroke-render-cache.ts

import { Scribble } from "../../scene-graph/shapes/scribble";
import { Highlight } from "../../scene-graph/shapes/highlight";

type StrokeShape = Scribble | Highlight;

interface StrokeOffset {
  vertexOffset: number; // byte offset in vertex buffer
  indexOffset: number;  // index in index buffer
  indexCount: number;
}

export class StrokeRenderCache {
  private device: GPUDevice;

  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;

  private vertexData: Float32Array;
  private indexData: Uint16Array;

  private maxVertices: number;
  private maxIndices: number;

  private vertexOffset: number = 0;
  private indexOffset: number = 0;

  private scribbleOffsets: Map<Scribble, StrokeOffset> = new Map();
  private highlightOffsets: Map<Highlight, StrokeOffset> = new Map();

  public isDirty: boolean = true;

  constructor(device: GPUDevice, maxVertices = 1_000_000, maxIndices = 2_000_000) {
    this.device = device;
    this.maxVertices = maxVertices;
    this.maxIndices = maxIndices;
    this.vertexData = new Float32Array(maxVertices);
    this.indexData = new Uint16Array(maxIndices);

    this.vertexBuffer = this.createVertexBuffer(maxVertices);
    this.indexBuffer = this.createIndexBuffer(maxIndices);
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

  uploadScribbles(scribbles: Scribble[]) {
    for (const scribble of scribbles) {
      this.addStroke(scribble, this.scribbleOffsets, scribble.strokeWidth * 0.005);
    }
  }

  uploadHighlights(highlights: Highlight[]) {
    for (const highlight of highlights) {
      this.addStroke(highlight, this.highlightOffsets, highlight.strokeWidth * 0.035);
    }
  }

  finalizeUploads() {
    this.device.queue.writeBuffer(this.vertexBuffer, 0, this.vertexData, 0, this.vertexOffset);
    this.device.queue.writeBuffer(this.indexBuffer, 0, this.indexData, 0, this.indexOffset);
    this.isDirty = false;
  }

  getVertexBuffer(): GPUBuffer {
    return this.vertexBuffer;
  }

  getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  getScribbleOffset(s: Scribble): StrokeOffset | undefined {
    return this.scribbleOffsets.get(s);
  }

  getHighlightOffset(h: Highlight): StrokeOffset | undefined {
    return this.highlightOffsets.get(h);
  }

  private addStroke<T extends StrokeShape>(
    shape: T,
    offsetsMap: Map<T, StrokeOffset>,
    halfThickness: number
  ) {
    const points = shape.points;
    if (points.length < 2) return;

    const estimatedVertices = points.length * 2;
    const estimatedIndices = (points.length - 1) * 6;

    // Resize if needed
    this.ensureVertexCapacity(estimatedVertices);
    this.ensureIndexCapacity(estimatedIndices);

    const vertexStartIndex = this.vertexOffset / 2; // 2 floats per vertex

    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const curr = points[i];

      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;

      const nx = -(dy / len) * halfThickness;
      const ny = (dx / len) * halfThickness;

      this.vertexData[this.vertexOffset++] = curr.x - nx;
      this.vertexData[this.vertexOffset++] = curr.y - ny;

      this.vertexData[this.vertexOffset++] = curr.x + nx;
      this.vertexData[this.vertexOffset++] = curr.y + ny;

      const baseIndex = i * 2;
      if (i > 0) {
        this.indexData[this.indexOffset++] = vertexStartIndex + baseIndex - 2;
        this.indexData[this.indexOffset++] = vertexStartIndex + baseIndex - 1;
        this.indexData[this.indexOffset++] = vertexStartIndex + baseIndex;

        this.indexData[this.indexOffset++] = vertexStartIndex + baseIndex - 1;
        this.indexData[this.indexOffset++] = vertexStartIndex + baseIndex;
        this.indexData[this.indexOffset++] = vertexStartIndex + baseIndex + 1;
      }
    }

    const totalIndices = 6 * (points.length - 1);
    offsetsMap.set(shape, {
      vertexOffset: vertexStartIndex * 2 * 4, // bytes
      indexOffset: this.indexOffset - totalIndices,
      indexCount: totalIndices,
    });
  }

  private ensureVertexCapacity(required: number) {
    if (this.vertexOffset + required > this.vertexData.length) {
      const newSize = this.vertexData.length * 2;
      const newVertexData = new Float32Array(newSize);
      newVertexData.set(this.vertexData);
      this.vertexData = newVertexData;
      this.vertexBuffer = this.createVertexBuffer(newSize);
      this.maxVertices = newSize;
    }
  }

  private ensureIndexCapacity(required: number) {
    if (this.indexOffset + required > this.indexData.length) {
      const newSize = this.indexData.length * 2;
      const newIndexData = new Uint16Array(newSize);
      newIndexData.set(this.indexData);
      this.indexData = newIndexData;
      this.indexBuffer = this.createIndexBuffer(newSize);
      this.maxIndices = newSize;
    }
  }
}
