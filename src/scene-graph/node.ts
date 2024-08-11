// Node.ts
export class Node {
    public children: Node[] = [];
    public x: number = 0;
    public y: number = 0;
    public rotation: number = 0;
    public scaleX: number = 1;
    public scaleY: number = 1;
    public visible: boolean = true;

    constructor() {}

    // Add a child node
    addChild(child: Node) {
        this.children.push(child);
    }

    // Remove a child node
    removeChild(child: Node) {
        this.children = this.children.filter(c => c !== child);
    }

    // Render this node and its children
    render(ctx: CanvasRenderingContext2D) {
        if (!this.visible) return;

        ctx.save();

        // Apply transformations
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rotation);
        ctx.scale(this.scaleX, this.scaleY);

        // Render the current node (override in subclasses)
        this.draw(ctx);

        // Render children
        this.children.forEach(child => child.render(ctx));

        ctx.restore();
    }

    // Draw method to be overridden by subclasses
    draw(ctx: CanvasRenderingContext2D) {
        // No-op for the base Node class
    }
}