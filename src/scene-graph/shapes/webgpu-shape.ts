// src/scene-graph/webgpu-shape.ts
/// <reference types="@webgpu/types" />

import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class WebGPUShape extends Shape {
    private device: GPUDevice;
    private vertexBuffer!: GPUBuffer;

    constructor(renderStrategy: RenderStrategy, device: GPUDevice, fillColor: RGBA = {r:0,g:0,b:0,a:1}, strokeColor: RGBA = {r:0,g:0,b:0,a:1}, strokeWidth: number = 1) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this.device = device;
        this.createBuffers(device);
    }

    private createBuffers(device: GPUDevice) {
        const vertices = new Float32Array([
            this.x, this.y,
            this.x + this.boundingBox!.width, this.y,
            this.x + this.boundingBox!.width, this.y + this.boundingBox!.height,
            this.x, this.y + this.boundingBox!.height,
        ]);

        this.vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });

        new Float32Array(this.vertexBuffer.getMappedRange()).set(vertices);
        this.vertexBuffer.unmap();
    }

    public drawWebGPU(passEncoder: GPURenderPassEncoder) {
        passEncoder.setVertexBuffer(0, this.vertexBuffer);
        passEncoder.draw(4, 1, 0, 0);
    }

    public draw(ctx: CanvasRenderingContext2D): void {
        throw new Error("WebGPUShape does not implement drawing on Canvas.");
    }
}