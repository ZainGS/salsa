// Renderer.ts
import { SceneGraph } from '../scene-graph/scene-graph';

export class Renderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private sceneGraph: SceneGraph;

    constructor(canvas: HTMLCanvasElement, sceneGraph: SceneGraph) {
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('2d')!;
        this.sceneGraph = sceneGraph;
        this.startRenderingLoop();
    }

    private startRenderingLoop() {
        const renderLoop = () => {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); // Clear the canvas
            this.sceneGraph.render(this.ctx); // Render the scene graph
            requestAnimationFrame(renderLoop);
        };

        requestAnimationFrame(renderLoop);
    }
}