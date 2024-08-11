// SceneGraph.ts
import { Node } from './node';

export class SceneGraph {
    public root: Node;

    constructor() {
        this.root = new Node(); // Root node
    }

    render(ctx: CanvasRenderingContext2D) {
        this.root.render(ctx);
    }
}