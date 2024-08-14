import { RenderStrategy } from "../renderer/render-strategies/render-strategy";

// src/scene-graph/node.ts
export class Node {
    public children: Node[] = [];
    public x: number = 0;
    public y: number = 0;
    public rotation: number = 0;
    public scaleX: number = 1;
    public scaleY: number = 1;
    public visible: boolean = true;
    public renderStrategy?: RenderStrategy;

    // Event handlers
    public onClick?: (event: MouseEvent) => void;
    public onMouseOver?: (event: MouseEvent) => void;
    public onMouseOut?: (event: MouseEvent) => void;

    constructor(renderStrategy?: RenderStrategy) {
        this.renderStrategy = renderStrategy;
    }

    // Add a child node
    addChild(child: Node) {
        this.children.push(child);
    }

    // Remove a child node
    removeChild(child: Node) {
        this.children = this.children.filter(c => c !== child);
    }

    // Delegate rendering to the strategy
    public render(ctxOrEncoder: CanvasRenderingContext2D | GPURenderPassEncoder, pipeline?: GPURenderPipeline) {
        this.renderStrategy?.render(this, ctxOrEncoder, pipeline);
    }

    // Check if a point is within this node (override in subclasses)
    containsPoint(x: number, y: number): boolean {
        return false;
    }
}