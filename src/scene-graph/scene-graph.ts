// scene-graph.ts
// A hierarchical structure that organizes and manages the nodes (shapes) in the scene. 
// The SceneGraph class holds a root Node that can have child nodes, creating a tree structure.

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