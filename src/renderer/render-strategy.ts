import { Node } from '../scene-graph/node';

// src/rendering/render-strategy.ts
export interface RenderStrategy {
    render(node: Node, ctxOrEncoder: CanvasRenderingContext2D | GPURenderPassEncoder, pipeline?: GPURenderPipeline): void;
}