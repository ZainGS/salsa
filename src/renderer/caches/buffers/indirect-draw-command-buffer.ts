import { Shape } from "../../../scene-graph/shapes/base/shape";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { RenderData } from "../cache-registry/render-data";

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
  private type: 'shape' | 'stroke' | 'highlight' | 'pattern' | 'line';

  constructor(device: GPUDevice, registry: RenderDataRegistry<Shape>, type: 'shape' | 'stroke' | 'highlight' | 'pattern' | 'line', maxCommands = 1024) {
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
    const data = this.registry.get(shape);
    // console.log(data);
    if (!data || !data.geometryOffset) {
      console.warn(`No render data found for shape ${shape.id}`);
      return;
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
      baseVertex: data.geometryOffset.vertexOffset / 2, // Convert from float32 offset to vertex index (2 floats per vertex)
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

    const flatData = new Uint32Array(this.commands.length * 5);
    for (let i = 0; i < this.commands.length; i++) {
      const cmd = this.commands[i];
      const base = i * 5;
      flatData[base + 0] = cmd.indexCount;
      flatData[base + 1] = cmd.instanceCount;
      flatData[base + 2] = cmd.firstIndex;
      flatData[base + 3] = cmd.baseVertex;
      flatData[base + 4] = cmd.firstInstance;
    }

    this.device.queue.writeBuffer(
      this.commandBuffer,
      0,                    // start at the beginning of the GPU buffer
      flatData.buffer,      // write from the underlying ArrayBuffer
      flatData.byteOffset,  // offset into that buffer (usually 0)
      flatData.byteLength   // total bytes to write
    );
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
