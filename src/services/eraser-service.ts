import { mat4, vec3 } from "gl-matrix";
import { RenderStrategy } from "../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Scribble } from "../scene-graph/shapes/scribble";
import { InteractionService } from "./interaction-service";

export class EraserService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    public isErasing: boolean = false;
    public isEnabled: boolean = false;
    private shapeFactory: ShapeFactory;
    private eventListenersAttached = false;
    private lastErasePoint: [number, number] | null = null;
    private pendingEraseScribbles: Set<Scribble> = new Set();
    
    public scribbles: Scribble[] = [];
    public scribblesInView: Scribble[] = [];

    constructor(
        interactionService: InteractionService,
        sceneGraph: SceneGraph,
        renderStrategy: RenderStrategy,
        shapeFactory: ShapeFactory
    ) {
        this.interactionService = interactionService;
        this.sceneGraph = sceneGraph;
        this.renderStrategy = renderStrategy;
        this.shapeFactory = shapeFactory;
        this.attachEventListeners();
    }

    public enable() {
        this.isEnabled = true;
        const svgCursor = `data:image/svg+xml,` + encodeURIComponent(`
            <svg version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
                width="25px" height="25px" viewBox="0 0 47.375 47.375" style="enable-background:new 0 0 47.375 47.375;"
                xml:space="preserve">
            <g>
                <path fill='#fff' d="M44.538,10.909l-8.616-8.642C34.465,0.805,32.526,0,30.461,0c-2.055,0-3.986,0.799-5.441,2.251L2.851,24.377
                    c-1.457,1.455-2.263,3.391-2.265,5.447c-0.004,2.062,0.797,3.998,2.252,5.451l8.617,8.644c1.455,1.462,3.396,2.269,5.459,2.269
                    c2.056,0,3.986-0.799,5.443-2.252L44.523,21.81c1.457-1.454,2.262-3.388,2.266-5.447C46.792,14.302,45.991,12.364,44.538,10.909z
                    M17.413,38.98c-0.17,0.17-0.365,0.207-0.498,0.207c-0.135,0-0.33-0.037-0.502-0.209l-8.621-8.646
                    c-0.17-0.17-0.205-0.363-0.205-0.498c0-0.134,0.037-0.331,0.209-0.502l6.031-6.02l9.619,9.646L17.413,38.98z M33.45,44.154"/>
            </g>
            </svg>`);

        this.interactionService.canvas.style.cursor = `url("${svgCursor}") 8 20, auto`;
    }

    public disable() {
        this.isEnabled = false;
        this.interactionService.canvas.style.cursor = "default";
    }

    private attachEventListeners() {
        if (this.eventListenersAttached) return;
        
        const canvas = this.interactionService.canvas;
        canvas.addEventListener("mousedown", (event) => this.startErasure(event));
        canvas.addEventListener("mousemove", (event) => this.updateErasure(event));
        canvas.addEventListener("mouseup", () => this.finishErasure());
        
        this.eventListenersAttached = true;
    }

    private startErasure(event: MouseEvent) {
        if (!this.isEnabled || this.isErasing || event.button !== 0) return;

        this.interactionService.updateWorldMatrix();
        this.scribblesInView = this.scribbles.filter(s => s.visible);
        this.isErasing = true;
        this.lastErasePoint = this.transformMouseCoordinatesToWorldSpace(event.offsetX, event.offsetY);
    }

    private updateErasure(event: MouseEvent) {
        if (!this.isErasing) return;

        const currentPoint = this.transformMouseCoordinatesToWorldSpace(event.offsetX, event.offsetY);

        if (!this.lastErasePoint) {
            this.lastErasePoint = currentPoint;
            return;
        }

        this.scribblesInView.forEach(scribble => {
            if (scribble.intersectsLine(this.lastErasePoint![0], this.lastErasePoint![1], currentPoint[0], currentPoint[1])) {
                this.pendingEraseScribbles.add(scribble);
            } else {
                // If line-based detection fails, use point-based interpolation
                // const interpolatedPoints = this.getInterpolatedPoints(this.lastErasePoint!, currentPoint);
                // interpolatedPoints.forEach(point => {
                //     if (scribble.containsPoint(point[0], point[1])) {
                //         this.pendingEraseScribbles.add(scribble);
                //     }
                // });
            }
        });

        this.lastErasePoint = currentPoint;
        
        // Use requestAnimationFrame to batch remove scribbles once per frame
        requestAnimationFrame(() => {
            if (this.pendingEraseScribbles.size > 0) {
                this.scribbles = this.scribbles.filter(s => !this.pendingEraseScribbles.has(s));
                this.pendingEraseScribbles.forEach(scribble => this.sceneGraph.root.removeChild(scribble));
                this.pendingEraseScribbles.clear();
            }
        });
    }

    private finishErasure() {
        this.isErasing = false;
        this.scribblesInView = [];
        this.lastErasePoint = null;
    }

    // private getInterpolatedPoints(start: [number, number], end: [number, number]): [number, number][] {
    //     const points: [number, number][] = [];
    //     const steps = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));

    //     for (let i = 0; i <= steps; i++) {
    //         const x = start[0] + (end[0] - start[0]) * (i / steps);
    //         const y = start[1] + (end[1] - start[1]) * (i / steps);
    //         points.push([x, y]);
    //     }

    //     return points;
    // }

    // Bresenham’s Line Algorithm
    private getInterpolatedPoints(start: [number, number], end: [number, number]): [number, number][] {
        const points: [number, number][] = [];
    
        let x1 = Math.round(start[0]);
        let y1 = Math.round(start[1]);
        let x2 = Math.round(end[0]);
        let y2 = Math.round(end[1]);
    
        let dx = Math.abs(x2 - x1);
        let dy = Math.abs(y2 - y1);
        let sx = x1 < x2 ? 1 : -1;
        let sy = y1 < y2 ? 1 : -1;
        let err = dx - dy;
    
        while (true) {
            points.push([x1, y1]);
    
            if (x1 === x2 && y1 === y2) break;
    
            let e2 = err * 2;
            if (e2 > -dy) {
                err -= dy;
                x1 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y1 += sy;
            }
        }
    
        return points;
    }

    private transformMouseCoordinatesToWorldSpace(x: number, y: number): [number, number] {
        const ndcX = (x / this.interactionService.canvas.width) * 2 - 1;
        const ndcY = (y / this.interactionService.canvas.height) * -2 + 1;

        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());

        const transformed = vec3.fromValues(ndcX, ndcY, 0);
        vec3.transformMat4(transformed, transformed, inverseWorldMatrix);

        return [transformed[0], transformed[1]];
    }
}
