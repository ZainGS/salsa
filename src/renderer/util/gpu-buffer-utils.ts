export class GpuBufferUtils {
    static readonly MAX_CHUNK_SIZE = 256 * 1024;
  
    static writeBuffer(
        queue: GPUQueue,
        buffer: GPUBuffer,
        dstOffset: number,
        src: ArrayBuffer,
        srcOffset: number,
        totalBytes: number
    ) {
        queue.writeBuffer(buffer, dstOffset, src, srcOffset, totalBytes);
    }

    static writeBufferInChunks(
        queue: GPUQueue,
        buffer: GPUBuffer,
        dstOffset: number,
        src: ArrayBuffer,
        srcOffset: number,
        totalBytes: number
    ) {
        let remaining = totalBytes;
        while (remaining > 0) {
        const chunkSize = Math.min(remaining, GpuBufferUtils.MAX_CHUNK_SIZE);
        queue.writeBuffer(buffer, dstOffset, src, srcOffset, chunkSize);
        dstOffset += chunkSize;
        srcOffset += chunkSize;
        remaining -= chunkSize;
        }
    }

    static writeVertexAndIndexBuffers(
        queue: GPUQueue,
        vertexBuffer: GPUBuffer,
        indexBuffer: GPUBuffer,
        vertexData: Float32Array,
        vertexOffset: number,
        vertexCount: number,
        indexData: Uint16Array,
        indexOffset: number,
        indexCount: number,
        useChunks = false
    ) {
        const write = useChunks ? GpuBufferUtils.writeBufferInChunks : GpuBufferUtils.writeBuffer;

        write(queue, vertexBuffer, vertexOffset * 4, vertexData.buffer as ArrayBuffer, vertexData.byteOffset + vertexOffset * 4, vertexCount * 4);
        write(queue, indexBuffer, indexOffset * 2, indexData.buffer as ArrayBuffer, indexData.byteOffset + indexOffset * 2, indexCount * 2);
    }

    static ensureBufferCapacity<T extends Float32Array | Uint16Array>(
        queue: GPUQueue,
        oldBuffer: GPUBuffer,
        oldData: T,
        currentOffset: number,
        required: number,
        bytesPerElement: number,
        createBuffer: (newSize: number) => GPUBuffer,
        useChunks = false
        ): { buffer: GPUBuffer; data: T } {
        if (required < oldData.length) return { buffer: oldBuffer, data: oldData };

        const newSize = Math.max(oldData.length * 2, required);
        const newData = new (oldData.constructor as { new(size: number): T })(newSize);
        newData.set(oldData.subarray(0, currentOffset));

        const newBuffer = createBuffer(newSize);
        const bytesUsed = currentOffset * bytesPerElement;
        const writer = useChunks ? this.writeBufferInChunks : this.writeBuffer;

        writer(queue, newBuffer, 0, newData.buffer as ArrayBuffer, 0, bytesUsed);

        oldBuffer.destroy();
        return { buffer: newBuffer, data: newData };
    }

    static createVertexBuffer(size: number, device: GPUDevice): GPUBuffer {
        return device.createBuffer({
            size: size * 4, // Converting element counts into byte sizes; Each Float32 (a 32-bit float) is 4 bytes.
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
    }

    static createIndexBuffer(size: number, device: GPUDevice): GPUBuffer {
        return device.createBuffer({
            size: size * 2, // Converting element counts into byte sizes; Each Uint16 (16-bit unsigned integer) is 2 bytes. 
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
    }

    // For debugging buffer contents:
    static async dumpGpuBuffer(device: GPUDevice, buffer: GPUBuffer, size: number) {
        const readback = device.createBuffer({
          size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
        device.queue.submit([encoder.finish()]);
      
        await readback.mapAsync(GPUMapMode.READ);
        const copy = readback.getMappedRange();
        console.log(new Float32Array(copy)); // or Uint16Array depending on usage
    }
}