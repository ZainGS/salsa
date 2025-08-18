import { Shape } from "../../../scene-graph/shapes/base/shape";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";

export interface IndirectDrawCommand {
  indexCount: number;
  instanceCount: number;
  firstIndex: number;
  baseVertex: number;
  firstInstance: number;
}

export class IndirectDrawCommandBuffer {
  private device: GPUDevice;
  private registry: RenderDataRegistry<Shape>;
  private commandBuffer: GPUBuffer;
  private commands: IndirectDrawCommand[] = [];
  private shapeToCommandIndex: Map<string, number> = new Map();
  private shapesInOrder: Shape[] = [];
  private commandStride = 5 * 4; // 5 uint32 fields
  private maxCommands: number;
  private type: 'shape' | 'stroke' | 'highlight' | 'pattern' | 'line' | 'sdfText';

  constructor(device: GPUDevice, registry: RenderDataRegistry<Shape>, type: 'shape' | 'stroke' | 'highlight' | 'pattern' | 'line' | 'sdfText', maxCommands = 1024) {
    this.device = device;
    this.registry = registry;
    this.type = type;
    this.maxCommands = maxCommands;
    this.commandBuffer = this.device.createBuffer({
      size: this.commandStride * maxCommands,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
  }

  public updateOrAdd(shape: Shape): void {
    //const data = this.registry.get(shape);
    //const data = this.registry.get(shape);
    const data = this.registry.registryMap.get(shape.id);
    if (!data || !data.geometryOffset) {
      console.warn(`No render data found for shape ${shape.id}`);
      return;
    }

    // Calculate baseVertex based on shape type and vertex format
    let baseVertex: number; 
    
    switch (this.type) {
      case 'sdfText':
        // SdfTextRenderGeometryCache stores vertexOffset as *vertex count* (4 floats/vertex),
        // so baseVertex can be used as-is.
        baseVertex = data.geometryOffset.vertexOffset;
        break;
      default:
        // These caches store vertexOffset in *floats* with 2 floats/vertex
        baseVertex = Math.floor(data.geometryOffset.vertexOffset / 2);
        break;
    }

    /** NOTE:
     * baseVertex acts as an offset added to every index value, not in bytes, but in vertex indices. 
     * You store vertex data as Float32Array in [x, y, x, y, ...] format
     * So each vertex is 2 float32 values = 8 bytes = 2 floats
     * But: your vertexOffset is in float32s
     * Your index buffer contains vertex indices, like [0, 1, 2], not byte offsets
     */
    const command: IndirectDrawCommand = {
      indexCount: data.geometryOffset.indexCount,
      instanceCount: 1,
      firstIndex: data.geometryOffset.indexOffset,
      baseVertex: baseVertex, // Convert from float32 offset to vertex index (2 floats per vertex)
      firstInstance: data.shapeIndex! // Corresponds to index in uniform array (uniformOffset / 256)
      // firstInstance: data.uniformOffset! / 256 
      // // idk if i divide or not... it is multiples of 256 bytes
    };

    console.assert(
        data.shapeIndex === data.uniformOffset! / 256,
        `Instance mismatch! shapeIndex=${data.shapeIndex} vs expected=${data.uniformOffset!/256}`
    );
  
    if (this.shapeToCommandIndex.has(shape.id)) {
      const index = this.shapeToCommandIndex.get(shape.id)!;
      this.commands[index] = command;
    } else {
      const index = this.commands.length;
      if (index >= this.maxCommands) {
        console.warn("IndirectDrawCommandBuffer is full. Skipping shape:", shape.id);
        return;
      }
      this.commands.push(command);
      this.shapeToCommandIndex.set(shape.id, index);
    }

    // Replace or insert shape at correct draw index
    const index = this.shapesInOrder.findIndex(s => s.id === shape.id);
    if (index !== -1) {
        this.shapesInOrder[index] = shape;
    } else {
        this.shapesInOrder.push(shape);
    }
  }

  public upload(): void {
    const byteLen = this.commands.length * 20;
    const buf = new ArrayBuffer(byteLen);
    const view = new DataView(buf);
    for (let i = 0; i < this.commands.length; i++) {
      const c = this.commands[i], off = i * 20;
      view.setUint32(off + 0,  c.indexCount,   true);
      view.setUint32(off + 4,  c.instanceCount,true);
      view.setUint32(off + 8,  c.firstIndex,   true);
      view.setInt32 (off + 12, c.baseVertex,   true); // ← signed
      view.setUint32(off + 16, c.firstInstance,true);
    }
    this.device.queue.writeBuffer(this.commandBuffer, 0, buf);
  }

  public getBuffer(): GPUBuffer {
    return this.commandBuffer;
  }

  public get drawCount(): number {
    return this.commands.length;
  }

  public clear(): void {
    this.commands.length = 0;
    this.shapeToCommandIndex.clear();
  }

  public getZIndexAt(i: number): number {
    return this.shapesInOrder[i]?.zIndex ?? 0;
  }
}
