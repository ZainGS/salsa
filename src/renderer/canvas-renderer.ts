// Handles the Scene Graph drawn onto the Canvas element, Canvas rendering, and Events.

import { SceneGraph } from '../scene-graph/scene-graph';
import { Node } from '../scene-graph/node';
import { Shape } from '../scene-graph/shapes/shape';

export class CanvasRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private sceneGraph: SceneGraph;
    private dirtyRegions: { x: number; y: number; width: number; height: number }[] = [];
    private draggingShape: Shape | null = null;
    private offsetX: number = 0;
    private offsetY: number = 0;
    private isDragging: boolean = false;

    constructor(canvas: HTMLCanvasElement, sceneGraph: SceneGraph) {
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('2d')!;
        if (!this.ctx) {
            throw new Error("2D rendering context not supported or not found.");
        }
        this.sceneGraph = sceneGraph;

        this.setupEventListeners();
    }

    public start() {
        this.startRenderingLoop();
    }

    private startRenderingLoop() {
        const renderLoop = () => {
            this.updateDirtyRegions();
            this.clearDirtyRegions();
            this.redrawDirtyRegions();

            requestAnimationFrame(renderLoop);
        };

        requestAnimationFrame(renderLoop);
    }

    private updateDirtyRegions() {
        this.dirtyRegions = [];
        this.collectDirtyRegions(this.sceneGraph.root);
    }

    private collectDirtyRegions(node: Node) {
        if (node instanceof Shape && node.isShapeDirty()) {
            if (node.getPreviousBoundingBox()) {
                // Add the previous bounding box to the dirty regions.
                // Clearing these out will prevent trailing when dragging.
                this.dirtyRegions.push(node.getPreviousBoundingBox()!);
            }
            if (node.getBoundingBox()) {
                // Add the current bounding box to the dirty regions
                this.dirtyRegions.push(node.getBoundingBox()!);
            }
        }

        for (const child of node.children) {
            this.collectDirtyRegions(child);
        }
    }

    private clearDirtyRegions() {
        for (const region of this.dirtyRegions) {
            this.ctx.clearRect(region.x, region.y, region.width, region.height);
        }
    }

    private redrawDirtyRegions() {
        this.redrawNode(this.sceneGraph.root);
    }

    private redrawNode(node: Node) {
        if (node instanceof Shape && node.isShapeDirty()) {
            node.render(this.ctx);
            node.resetDirtyFlag();
        }

        for (const child of node.children) {
            this.redrawNode(child);
        }
    }

    private setupEventListeners() {
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
    }

    private handleMouseDown(event: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const nodes = this.getNodesAtPoint(this.sceneGraph.root, x, y);
        if (nodes.length > 0) {
            this.draggingShape = nodes[0] as Shape;
            this.offsetX = x - this.draggingShape.x;
            this.offsetY = y - this.draggingShape.y;
            this.isDragging = false; // Reset dragging flag
        }
    }

    private handleMouseMove(event: MouseEvent) {
        if (this.draggingShape) {
            const rect = this.canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;

            // Update previousBoundingBox before moving the shape
            this.draggingShape.markDirty(); // Mark as dirty to ensure the previous state is saved

            // Now update the position
            this.draggingShape.x = x - this.offsetX;
            this.draggingShape.y = y - this.offsetY;

            this.isDragging = true; // Indicate that dragging is occurring
        }
    }

    private handleMouseUp(event: MouseEvent) {
        if (this.draggingShape) {
            if (!this.isDragging) {
                // Only fire click event if no dragging occurred
                const rect = this.canvas.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;
                this.dispatchEvent('click', x, y, event);
            }
            this.draggingShape = null;
        }
    }

    private dispatchEvent(eventType: string, x: number, y: number, event: MouseEvent) {
        const nodes = this.getNodesAtPoint(this.sceneGraph.root, x, y);
        for (const node of nodes) {
            if (eventType === 'click' && node.onClick) {
                node.onClick(event);
            }
        }
    }

    private getNodesAtPoint(node: Node, x: number, y: number): Node[] {
        let nodes: Node[] = [];

        if (node.containsPoint(x, y)) {
            nodes.push(node);
        }

        for (const child of node.children) {
            nodes = nodes.concat(this.getNodesAtPoint(child, x, y));
        }

        return nodes;
    }
}