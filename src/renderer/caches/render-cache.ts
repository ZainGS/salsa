/* RenderCache
Purpose: Caches uniform data for all shapes in one single, large dynamic uniform buffer.
Map: Tracks offsets per shape using Map<Shape, number>.
Data per shape: 160–192 bytes per object, aligned to 256-byte slices.
Reused every frame: Used in the shader via a bind group per shape.*/

import { Shape } from "../../scene-graph/shapes/base/shape";
import { Highlight } from "../../scene-graph/shapes/highlight";
import { Line } from "../../scene-graph/shapes/line";
import { Scribble } from "../../scene-graph/shapes/scribble";
import { InteractionService } from "../../services/interaction-service";

export class RenderCache {

    // For minimizing fragmentation and memory waste
    unallocatedIndices: number[];

    shapeIndexInBufferList: Map<Shape, number>;

    // The most important property to cache; allows us to recreate the scene directly from 
    // the uniform buffer on launch [O(1)] instead of a repeated [O(n)] sceneGraph navigation
    dynamicUniformBuffer: GPUBuffer;

    // Track the current offset for new allocations
    currentOffset: number = 0; // Track the current offset for new allocations
    
    private _device: GPUDevice;
    private _interactionService: InteractionService;

    constructor(initialBufferSize: number, device: GPUDevice, interactionService: InteractionService) {
        this.unallocatedIndices = [];
        this.shapeIndexInBufferList = new Map();
        this._device = device;
        this.dynamicUniformBuffer = device.createBuffer({
            size: initialBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        // Start at the beginning of the buffer
        this.currentOffset = 0; 
        this._interactionService = interactionService;
    }

    // (..., size: number)
    //allocateShape(shape: Shape, size: number): number {
      allocateShape(shape: Shape): number {
        //console.log(size);
        
        // Check if the shape already has an allocated index in the buffer
        let shapeOffset = this.shapeIndexInBufferList.get(shape);
        // console.log("ALLOCATE", shape.constructor.name, shape.id, "→ offset", shapeOffset);
        // If not, allocate new space in the buffer
        if (shapeOffset === undefined) { 
            
            /* Ensure size is padded to a 256 byte multiple; 
            WebGPU uniform buffer offsets must align to 256-byte boundaries
            We have an additional 96 bytes available in each 256-byte slice of the uniform buffer. 
            Since each shape's current uniform data only uses 160 bytes, you can utilize the remaining 
            96 bytes to store additional properties or data without needing to allocate extra memory.
            If un-aligned size was unknown, we could use: const alignedSize = Math.ceil(size / 256) * 256;
            -------------------------------------------------------------------------------------------*/
            const alignedSize = 256;  // We know size is 160 bytes, so aligned size is 256 bytes.

            // Check if we need to resize the buffer
            if (this.currentOffset + alignedSize > this.dynamicUniformBuffer.size) {
                // Double the dynamic uniform buffer size
                this.resizeBuffer(this.dynamicUniformBuffer.size * 2); 
            }   

            // Determine the offset: either reuse a deallocated slice or allocate new space
            shapeOffset = this.unallocatedIndices.length > 0
                ? this.unallocatedIndices.pop() 
                : this.currentOffset;
        
            // Safety check, though offset should never be undefined
            if (shapeOffset === undefined) {
                return 0;  
            }
        
            this.shapeIndexInBufferList.set(shape, shapeOffset);

            // Only increment currentOffset if a new space is allocated
            if (shapeOffset === this.currentOffset) {
                this.currentOffset += alignedSize; 
            }
    
        }
        
        // Write the shape's data into the buffer at the calculated offset
        const shapeUniformData = this.getShapeUniformData(shape);
        this._device.queue.writeBuffer(
            this.dynamicUniformBuffer, 
            shapeOffset, 
            shapeUniformData.buffer, 
            shapeUniformData.byteOffset, 
            shapeUniformData.byteLength
        );
        return shapeOffset;
    }

    deallocateShape(shape: Shape) {
        const offset = this.shapeIndexInBufferList.get(shape);
        if(offset !== undefined) {
            this.unallocatedIndices.push(offset);
            this.shapeIndexInBufferList.delete(shape);
        }
    }

    private getShapeUniformData(shape: Shape): Float32Array {
        
        const canvas = this._interactionService.canvas;

        const resolution = new Float32Array([canvas.width, canvas.height, 0.0, 0.0]);
        const worldMatrix = this._interactionService.getWorldMatrix();
        const localMatrix = shape.localMatrix;
        //const shapeColor = new Float32Array([shape.fillColor.r, shape.fillColor.g, shape.fillColor.b, shape.fillColor.a]);
        //const shapeColor = new Float32Array([91/255,75/255,121/255, shape.fillColor.a]);
        
        // Determine if we should use fillColor or strokeColor
        const color = (shape instanceof Scribble || shape instanceof Line || shape instanceof Highlight) ? shape.strokeColor : shape.fillColor;

        // Convert to Float32Array
        const shapeColor = new Float32Array([color.r, color.g, color.b, color.a]);

        // Combine all data into a single Float32Array
        const uniformData = new Float32Array(192); // 160 bytes / 4 = 40 floats
        uniformData.set(resolution, 0);            // fills 0-3:   vec4<f32>   (4 floats)
        uniformData.set(worldMatrix, 4);           // fills 4-19:  mat4x4<f32> (16 floats)
        uniformData.set(localMatrix, 20);          // fills 20-35: mat4x4<f32> (16 floats)
        uniformData.set(shapeColor, 36);           // fills 36-39: vec4<f32>   (4 floats)

        return uniformData;
    }

    resizeBuffer(newBufferSize: number) {

        // Step 1: Create a new buffer with the larger size
        const newBuffer = this._device.createBuffer({
            size: newBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
    
        // Step 2: Create a command encoder
        const commandEncoder = this._device.createCommandEncoder();
    
        // Step 3: Encode the buffer copy operation
        commandEncoder.copyBufferToBuffer(
            this.dynamicUniformBuffer,  // Source buffer (old)
            0,                          // Source offset
            newBuffer,                  // Destination buffer (new)
            0,                          // Destination offset
            this.currentOffset          // Size of the data to copy
        );
    
        // Step 4: Finish encoding and submit the command buffer
        const commandBuffer = commandEncoder.finish();
        this._device.queue.submit([commandBuffer]);
    
        // Step 5: Replace the old buffer with the new buffer
        this.dynamicUniformBuffer = newBuffer;
    }

    // public clear() {
    //     this.shapeIndexInBufferList.clear();
    //     this.unallocatedIndices = [];
    //     this.currentOffset = 0;
    //     // Fully zero out the buffer (optional, but prevents old data from leaking in)
    //     // Only helps if no shape is still referencing old offsets.
    //     //const zero = new Float32Array(this.dynamicUniformBuffer.size / 4);
    //     //this._device.queue.writeBuffer(this.dynamicUniformBuffer, 0, zero);

    //     this.dynamicUniformBuffer.destroy();
    //     this.dynamicUniformBuffer = this._device.createBuffer({
    //     size: this.dynamicUniformBuffer.size,
    //     usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    //     });
    //   }
}