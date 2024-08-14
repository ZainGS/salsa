// The SceneGraph class holds a root Node that can have child nodes (shapes), creating a tree structure.
// The Scene Graph root node may be rendered onto Canvas or via WebGPU;
// this will determine the Render Strategy that is utilized.

import { Node } from './node';
import { RenderStrategy } from '../renderer/render-strategies/render-strategy';

export class SceneGraph {
    public root: Node;

    constructor(renderStrategy: RenderStrategy) {
        this.root = new Node(renderStrategy); // Root node with the specified render strategy
    }

    renderOnCanvas(ctx: CanvasRenderingContext2D) {
        this.root.render(ctx);
    }

    renderOnWebGPU(passEncoder: GPURenderPassEncoder, pipeline: GPURenderPipeline) {
        this.root.render(passEncoder, pipeline);
    }
}