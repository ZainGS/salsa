import { mat4, vec3 } from "gl-matrix";
import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Scribble } from "../../scene-graph/shapes/scribble";
import { Highlight } from "../../scene-graph/shapes/highlight";
import { InteractionService } from "../interaction-service";
import { TouchGestureTracker } from "../../renderer/util/touch-gesture-tracker";
import type { Node } from "../../scene-graph/shapes/base/node";

export class EraserService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    public isErasing: boolean = false;
    public isEnabled: boolean = false;
    private shapeFactory: ShapeFactory;
    private eventListenersAttached = false;
    private lastErasePoint: [number, number] | null = null;
    private pendingEraseScribbles: Set<Scribble | Highlight> = new Set();
    
    public scribbles: (Scribble | Highlight)[] = [];
    public scribblesInView: (Scribble | Highlight)[] = [];

    // TOUCH-5 (docs/ui/touch-controls.md): a finger erase follows one pointer; a second finger (pinch / two-finger
    // pan) ends it and PUTS BACK every scribble this erase removed; `!isPrimary` fingers never erase. Mouse / pen as before.
    private readonly touches = new TouchGestureTracker();
    private erasePointerId: number | null = null;
    private eraseIsTouch = false;
    /** What a FINGER erase removed so far (parent + index), so a pinch can put it back. */
    private erasedThisStroke: Array<{ node: Scribble | Highlight; parent: Node; index: number }> = [];

    private startDrawingBound = (event: PointerEvent) => this.startErasure(event);
    private updateDrawingBound = (event: PointerEvent) => this.updateErasure(event);
    private finishDrawingBound = (event?: PointerEvent) => this.finishErasure(event);
    private cancelDrawingBound = (event: PointerEvent) => {
        this.touches.up(event);
        if (this.isErasing && this.eraseIsTouch && event.pointerId === this.erasePointerId) this.cancelTouchErase();
    };

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
        if (this.eventListenersAttached) return; // Prevent multiple listeners

        const canvas = this.interactionService.canvas;
        canvas.addEventListener("pointerdown", this.startDrawingBound);
        canvas.addEventListener("pointermove", this.updateDrawingBound);
        canvas.addEventListener("pointerup", this.finishDrawingBound);
        canvas.addEventListener("pointercancel", this.cancelDrawingBound);

        this.eventListenersAttached = true;
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
    
        // Remove existing listeners
        canvas.removeEventListener("pointerdown", this.startDrawingBound);
        canvas.removeEventListener("pointermove", this.updateDrawingBound);
        canvas.removeEventListener("pointerup", this.finishDrawingBound);
        canvas.removeEventListener("pointercancel", this.cancelDrawingBound);
        this.touches.reset();

        // Clear the flag so attachEventListeners can run
        this.eventListenersAttached = false;
    
        // Re-attach listeners
        this.attachEventListeners();
    }

    private startErasure(event: PointerEvent) {
        const verdict = this.touches.down(event);
        if (verdict === 'gesture') {
            if (this.isErasing && this.eraseIsTouch) this.cancelTouchErase();
            return;
        }
        if (verdict === 'ignore') return;
        if (!this.isEnabled || this.isErasing || event.button !== 0) return;

        this.interactionService.updateWorldMatrix();
        // Attached only: a stroke taken off by Ctrl+Z stays registered (redo re-attaches the same instance) but can't be erased.
        this.scribblesInView = this.scribbles.filter(s => s.visible && !!s.parent);
        //console.log("reference broken");
        this.isErasing = true;
        this.eraseIsTouch = event.pointerType === 'touch';
        this.erasePointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
        this.erasedThisStroke = [];
        this.lastErasePoint = this.transformMouseCoordinatesToWorldSpace(event.offsetX, event.offsetY);
        this.interactionService.beginInteractive();
    }

    private updateErasure(event: PointerEvent) {
        if (!this.isErasing) return;
        // TOUCH-5: only the erasing finger feeds a finger erase (another finger / a palm never erases along its path).
        if (this.eraseIsTouch && event.pointerId !== this.erasePointerId) return;

        const currentPoint = this.transformMouseCoordinatesToWorldSpace(event.offsetX, event.offsetY);

        if (!this.lastErasePoint) {
            this.lastErasePoint = currentPoint;
            return;
        }

        const scribbleMatrices = new Map<Scribble | Highlight, mat4>();
        this.scribblesInView.forEach(scribble => {
            // Cache inverted matrix if not already cached
            if (!scribbleMatrices.has(scribble)) {
                const inverseMatrix = mat4.create();
                if (mat4.invert(inverseMatrix, scribble.localMatrix)) {
                    scribbleMatrices.set(scribble, inverseMatrix);
                }
            }

            const inverseMatrix = scribbleMatrices.get(scribble)!;

            // Transform the points using the shape's local matrix
            // Transform the last and current erase points once
            const transformedLastPoint = vec3.transformMat4(vec3.create(), vec3.fromValues(this.lastErasePoint![0], this.lastErasePoint![1], 0), inverseMatrix);
            const transformedCurrentPoint = vec3.transformMat4(vec3.create(), vec3.fromValues(currentPoint[0], currentPoint[1], 0), inverseMatrix);
            
            if (scribble.intersectsLine(transformedLastPoint[0], transformedLastPoint[1], transformedCurrentPoint[0], transformedCurrentPoint[1])) {
                this.pendingEraseScribbles.add(scribble);
            } else {
                // If line-based detection fails, use point-based interpolation
                const interpolatedPoints = this.getInterpolatedPoints(this.lastErasePoint!, currentPoint);
                
                interpolatedPoints.forEach(point => {
                    const transformedPoint = vec3.transformMat4(vec3.create(), vec3.fromValues(point[0], point[1], 0), inverseMatrix);
                    if (scribble.containsPoint(transformedPoint[0], transformedPoint[1])) {
                        this.pendingEraseScribbles.add(scribble);
                    }
                });
            }
        });

        this.lastErasePoint = currentPoint;
        
        // Use requestAnimationFrame to batch remove scribbles once per frame
        requestAnimationFrame(() => {
            if (this.pendingEraseScribbles.size > 0) {
                this.scribbles = this.scribbles.filter(s => !this.pendingEraseScribbles.has(s));
                //console.log("reference broken");
                this.pendingEraseScribbles.forEach(scribble => {
                    // TOUCH-5: remember where a finger erase took it from (a pinch puts it back)
                    const parent = scribble.parent;
                    if (this.isErasing && this.eraseIsTouch && parent) {
                        this.erasedThisStroke.push({ node: scribble, parent, index: parent.children.indexOf(scribble) });
                    }
                    this.sceneGraph.root.removeChild(scribble);
                });
                this.pendingEraseScribbles.clear();
                this.interactionService.onSceneGraphChanged.emit();
                this.interactionService.requestRender();
            }
        });
    }

    private finishErasure(event?: PointerEvent) {
        if (event) this.touches.up(event);
        // Another finger lifting doesn't end a finger erase. And only a live erase returns its interactive lease: this
        // ran on EVERY canvas pointerup (any tool), so it ended a lease someone else held (e.g. a raster stroke's).
        if (!this.isErasing) return;
        if (event && this.eraseIsTouch && event.pointerId !== this.erasePointerId) return;
        this.isErasing = false;
        this.eraseIsTouch = false;
        this.erasePointerId = null;
        this.erasedThisStroke = [];
        this.scribblesInView = [];
        this.lastErasePoint = null;
        this.interactionService.endInteractive();
    }

    /** TOUCH-5: a second finger (or pointercancel) during a FINGER erase — the erase ends and every scribble it removed
     *  goes back where it was (same parent, same draw order); queued removals are dropped. */
    private cancelTouchErase(): void {
        this.pendingEraseScribbles.clear();
        const restore = this.erasedThisStroke;
        this.erasedThisStroke = [];
        for (let i = restore.length - 1; i >= 0; i--) {   // reverse: each index is valid again when it is reinserted
            const { node, parent, index } = restore[i];
            if (node.parent) continue;
            parent.addChild(node);
            const kids = parent.children;
            const at = kids.indexOf(node);
            if (at !== -1 && index >= 0 && index < kids.length - 1) { kids.splice(at, 1); kids.splice(index, 0, node); }
            if (!this.scribbles.includes(node)) this.scribbles.push(node);
        }
        this.isErasing = false;
        this.eraseIsTouch = false;
        this.erasePointerId = null;
        this.scribblesInView = [];
        this.lastErasePoint = null;
        this.interactionService.endInteractive();
        if (restore.length > 0) {
            this.interactionService.onSceneGraphChanged.emit();
            this.interactionService.requestRender();
        }
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

    /** offsetX/Y are CSS px: normalise by the CSS size (InteractionService.toWorldCoordsFromCanvas), never the BACKING
     *  size — canvas.width erased at (CSS / backing) of the pointer, i.e. up-left of the finger on a DPR-capped tablet. */
    private transformMouseCoordinatesToWorldSpace(x: number, y: number): [number, number] {
        const w = this.interactionService.toWorldCoordsFromCanvas(x, y);
        return [w.x, w.y];
    }
}
