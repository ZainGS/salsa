// src/renderer/renderer.ts
// Manages the rendering loop and handles the drawing of shapes on the canvas.

import { SceneGraph } from '../scene-graph/scene-graph';
import { Node } from '../scene-graph/node';
import { Shape } from '../scene-graph/shape';

export class Renderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private sceneGraph: SceneGraph;
    private dirtyRegions: { x: number; y: number; width: number; height: number }[] = [];

    constructor(canvas: HTMLCanvasElement, sceneGraph: SceneGraph) {
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('2d')!;
        if (!this.ctx) {
            throw new Error("2D rendering context not supported or not found.");
        }
        this.sceneGraph = sceneGraph;

        this.setupEventListeners();
    }

    // Start the rendering loop manually
    public start() {
        this.startRenderingLoop();
    }

    private startRenderingLoop() {
        const renderLoop = () => {
            this.updateDirtyRegions(); // Determine what needs to be redrawn
            this.clearDirtyRegions(); // Clear only the dirty regions
            this.redrawDirtyRegions(); // Redraw the dirty regions

            requestAnimationFrame(renderLoop);
        };

        requestAnimationFrame(renderLoop);
    }

    private updateDirtyRegions() {
        this.dirtyRegions = []; // Clear previous dirty regions

        // Traverse the scene graph and collect dirty regions
        this.collectDirtyRegions(this.sceneGraph.root);
    }

    private collectDirtyRegions(node: Node) {
        if (node instanceof Shape && node.isShapeDirty() && node.getBoundingBox()) {
            this.dirtyRegions.push(node.getBoundingBox()!);
        }

        // Recursively collect dirty regions from children
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
        // Redraw only the shapes within the dirty regions
        this.redrawNode(this.sceneGraph.root);
    }

    private redrawNode(node: Node) {
        if (node instanceof Shape && node.isShapeDirty()) {
            node.render(this.ctx);
            node.resetDirtyFlag();
        }

        // Recursively redraw children
        for (const child of node.children) {
            this.redrawNode(child);
        }
    }

    private setupEventListeners() {
        this.canvas.addEventListener('click', this.handleClick.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
    }

    private handleClick(event: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        this.dispatchEvent('click', x, y, event);
    }

    private handleMouseMove(event: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        this.dispatchEvent('mousemove', x, y, event);
    }

    private dispatchEvent(eventType: string, x: number, y: number, event: MouseEvent) {
        const nodes = this.getNodesAtPoint(this.sceneGraph.root, x, y);
        for (const node of nodes) {
            if (eventType === 'click' && node.onClick) {
                node.onClick(event);
            }
            // Add more event types as needed
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