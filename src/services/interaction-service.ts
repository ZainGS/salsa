import { mat4, vec4 } from "gl-matrix";
import { ViewportBounds } from "../renderer/util/viewport-bounds";
import { Node } from "../scene-graph/shapes/base/node";
import { Shape } from "../scene-graph/shapes/base/shape";
import { Rectangle } from "../scene-graph/shapes/rectangle";
import { EventEmitter } from "../renderer/util/event-emitter";
import { Group } from "../scene-graph/shapes/base/group";

export class InteractionService {
    
    private zoomFactor: number = 1;
    private panOffset: { x: number, y: number } = { x: 0, y: 0 };
    public maxGlobalZIndex: number = 1;
    public depthTexture!: GPUTexture;
    public depthTextureView!: GPUTextureView;

    // Affine transformation matrix (4x4 matrix for 3D transformations, but used in 2D context)
    private worldMatrix: mat4 = mat4.create(); // Identity matrix by default
    private _canvas: HTMLCanvasElement;
    public viewportBounds!: ViewportBounds;  // Added viewport bounds

    // Current selected node from mouse events in webgpu-renderer
    public selectedNodes: Set<Node> = new Set();
    public boxSelectPreview: Rectangle | null = null;
    public onSelectionChanged = new EventEmitter<string[]>(); // list of selected node IDs
    public onSceneGraphChanged = new EventEmitter<void>();

    public onRequestRender = new EventEmitter<void>();
    public onBeginInteractive = new EventEmitter<void>();
    public onEndInteractive = new EventEmitter<void>();
    public onRequestBackgroundRender = new EventEmitter<void>();
    /** Fires after every pan or zoom — use to sync illustration-mode camera. */
    public onViewportChanged = new EventEmitter<void>();

    requestRender()        { this.onRequestRender.emit(); }
    beginInteractive()     { this.onBeginInteractive.emit(); }
    endInteractive()       { this.onEndInteractive.emit(); }
    requestBackgroundRender() { this.onRequestBackgroundRender.emit() } 

    // flags for tool panel, panning, etc. overrides
    isPanToolSelected: boolean = false;
    /** When true, the 2D box-select drag is suppressed (e.g. during 3D armature / weight paint mode). */
    suppressBoxSelect: boolean = false;
    /**
     * When set, a drag on the canvas DRAWS a rectangle (reusing the box-select preview's
     * marching-ants box) instead of selecting nodes, and on release calls this with the drawn
     * WORLD rect ({x,y} = top-left, w/h ≥ 0). Used by the LiveText tool's click-drag create —
     * the handler decides click vs drag (e.g. a tiny rect → place a default-size node). Set it
     * when the text tool activates, clear it (null) when it deactivates.
     */
    rectDrawCallback: ((rect: { x: number; y: number; w: number; h: number }, clientX: number, clientY: number) => void) | null = null;
    /** Id of the LiveText node currently hovered while in rect-draw (text) mode — the renderer
     *  highlights it among the discoverability outlines. null = none. */
    hoveredLiveTextId: string | null = null;

    /**
     * Active vector layer for POINTER INTERACTIVITY. A vector shape is hit-testable (click,
     * marquee, hover) only if it has no layerId (unassigned → always live) or its layerId equals
     * this. null = no vector layer active → every layer-tagged vector shape is inert (clicks fall
     * through to raster paint / 3D orbit beneath). Mirrors ShapeManager._activeVectorLayerId; set
     * via shapeManager.setActiveVectorLayer(). Interactivity only — shapes still render normally.
     */
    activeVectorLayerId: string | null = null;

    /**
     * The active-vector-layer interactivity rule, in one place. A thing (scene-graph node OR
     * ephemera placement) is pointer-interactive iff it has no layerId (unassigned → always live)
     * or its layerId matches the active vector layer. null active layer → everything layer-tagged
     * is inert. Used by SelectionService.isInteractable (nodes), the marquee filter, and the
     * ephemera hit-tests (placements) so all three stay consistent.
     */
    public isVectorLayerInteractive(layerId: string | null | undefined): boolean {
        return !layerId || layerId === this.activeVectorLayerId;
    }

    // ── Pointer state for shader uniforms (UV 0–1, mouseDown flag) ──
    /** Last pointer position in canvas-UV space [0–1, 0–1]. Top-left = (0,0). */
    public lastPointerUV: [number, number] = [0.5, 0.5];
    /** Whether any pointer button is currently pressed. */
    public pointerDown = false;

    constructor(canvas: HTMLCanvasElement) { 
        this._canvas = canvas; 
        this.updateWorldMatrix();
        this.viewportBounds = new ViewportBounds(this);
    }

    setDepthTextureView(device: GPUDevice) {
        this.depthTexture = device.createTexture({
            size: [this.canvas.width, this.canvas.height, 1],  // Ensure size matches color attachment
            format: "depth24plus-stencil8",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureView = this.depthTexture.createView();
    }

    getAspectRatio() {
        return this.canvas.width/this.canvas.height;
    }

    getViewportCenter(): number[] {
        return [
            (this.viewportBounds.maxX + this.viewportBounds.minX) / 2, 
            (this.viewportBounds.maxY + this.viewportBounds.minY) / 2
        ];
    }
    
    get canvas(): HTMLCanvasElement {
        return this._canvas;
    }

    set canvas(canvas: HTMLCanvasElement) {
        this._canvas = canvas;
    }

    /** Converts screen-space mouse coordinates to world coordinates */
    public toWorldCoords(event: MouseEvent): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;

        return this.toWorldCoordsFromCanvas(canvasX, canvasY);
    }

    public toWorldCoordsFromCanvas(canvasX: number, canvasY: number): { x: number; y: number } {
        const ndcX = (canvasX / this.canvas.width) * 2 - 1;
        const ndcY = (canvasY / this.canvas.height) * -2 + 1;
    
        // Convert NDC to world space using inverse world matrix
        const mousePoint = vec4.fromValues(ndcX, ndcY, 0, 1);
        const inverseWorldMatrix = mat4.create();
    
        // Invert the world matrix to get correct world coordinates
        mat4.invert(inverseWorldMatrix, this.getWorldMatrix());
        vec4.transformMat4(mousePoint, mousePoint, inverseWorldMatrix);
    
        return { x: mousePoint[0], y: mousePoint[1] };
    }
    

    public adjustZoom(delta: number, mouseX: number, mouseY: number, illustrationMode?: boolean, illustrationBounds?: { width: number; height: number }) {
    mouseX *= 2;
    mouseY *= 2;

    // Apply zoom change proportionally to the current zoom factor
    const zoomChange = 1 + delta;
    const prevZoomFactor = this.zoomFactor;
    
    let newZoomFactor = this.zoomFactor * zoomChange;
    
    // Apply zoom constraints
    let maxZoom = 20.0;   // allow deep zoom for pixel-level editing
    let minZoom = 0.1;

    newZoomFactor = Math.max(minZoom, Math.min(maxZoom, newZoomFactor));
    
    // If zoom didn't actually change due to constraints, don't do anything
    if (Math.abs(newZoomFactor - this.zoomFactor) < 0.001) {
        return;
    }
    
    this.zoomFactor = newZoomFactor;

    // Calculate the world space position of the mouse before zoom
    const worldMouseX = (mouseX - this.panOffset.x) / prevZoomFactor;
    const worldMouseY = (mouseY - this.panOffset.y) / prevZoomFactor;

    // Calculate the new pan offset so that the world space position under the mouse stays consistent
    let newPanX = mouseX - worldMouseX * this.zoomFactor;
    let newPanY = mouseY - worldMouseY * this.zoomFactor;

    // Apply illustration bounds constraint if needed
    if (illustrationMode && illustrationBounds) {
        const tempPanOffset = { x: this.panOffset.x, y: this.panOffset.y };
        this.panOffset.x = newPanX;
        this.panOffset.y = newPanY;
        
        const constrained = this.constrainPanToIllustrationBounds(0, 0, illustrationBounds);
        newPanX = this.panOffset.x + constrained.dx;
        newPanY = this.panOffset.y + constrained.dy;
        
        // Restore original pan offset before applying the final constrained values
        this.panOffset = tempPanOffset;
    }

    this.panOffset.x = newPanX;
    this.panOffset.y = newPanY;

    // Update the world matrix
    this.updateWorldMatrix();
    
    // Update the Viewport's Transform Cache on next update
    this.viewportBounds.markDirty();
    this.requestRender();
    this.requestBackgroundRender();
}
    
    public getZoomFactor(): number {
        return this.zoomFactor;
    }

    public setPanOffset(x: number, y: number) {
        this.panOffset.x = x;
        this.panOffset.y = y;
        this.updateWorldMatrix();
    }

    public setZoom(factor: number): void {
        this.zoomFactor = Math.max(0.01, factor);
        this.updateWorldMatrix();
        this.viewportBounds.markDirty();
        this.requestRender();
    }

    public adjustPan(dx: number, dy: number, illustrationMode?: boolean, illustrationBounds?: { width: number; height: number }) {
        let effectiveDx = dx;
        let effectiveDy = dy;
        
        // Apply illustration bounds constraint if in illustration mode
        if (illustrationMode && illustrationBounds) {
            const constrained = this.constrainPanToIllustrationBounds(dx, dy, illustrationBounds);
            effectiveDx = constrained.dx;
            effectiveDy = constrained.dy;
        }

        this.panOffset.x += effectiveDx;
        this.panOffset.y += effectiveDy;
        
        this.updateWorldMatrix();
        
        // Update the Viewport's Transform Cache on next update
        this.viewportBounds.markDirty();
    }

    public getPanOffset(): { x: number, y: number } {
        return this.panOffset;
    }

    public updateWorldMatrix() {
        let aspectRatio = this.canvas.width / this.canvas.height;

        // Reset to identity matrix
        mat4.identity(this.worldMatrix);

        // Apply translation
        mat4.translate(this.worldMatrix, this.worldMatrix, [this.panOffset.x/this._canvas.width, -this.panOffset.y/this._canvas.height, 0]);

        // Apply aspect ratio scaling (for X-axis)
        mat4.scale(this.worldMatrix, this.worldMatrix, [1 / aspectRatio, 1, 1]);

        // Apply scaling
        mat4.scale(this.worldMatrix, this.worldMatrix, [this.zoomFactor, this.zoomFactor, 1]);
        //this.viewportBounds.update();
        this.incrementWorldMatrixVersion();
        this.onViewportChanged.emit();
    }

    getWorldMatrix(): mat4 {
        return this.worldMatrix;
    }

    private _worldMatrixVersion = 0;
    get worldMatrixVersion() {
        return this._worldMatrixVersion;
    }

    public incrementWorldMatrixVersion() {
        this._worldMatrixVersion++;
    }

    clearSelectedNodes() {
        // for (const node of this.selectedNodes) {
        //     (node as Shape).deselect();
        // }
        this.selectedNodes.forEach(n => this.deselectNodeRecursively(n));
        this.selectedNodes.clear();
        this.onSelectionChanged.emit([]);
    }

    private deselectNodeRecursively(node: Node) {
        if (node instanceof Shape) {
            node.deselect();
        }
        if (node instanceof Group) {
            for (const child of node.children) {
                this.deselectNodeRecursively(child);
            }
        }
    }

    public selectNode(node: Node): void {
        (node as Shape).select();
        this.selectedNodes.add(node);
        this.onSelectionChanged.emit([...this.selectedNodes].map(n => (n as Shape).id));
    }
    
    public deselectNode(node: Node): void {
        (node as Shape).deselect();
        this.selectedNodes.delete(node);
        this.onSelectionChanged.emit([...this.selectedNodes].map(n => (n as Shape).id));
    }
    
    public toggleNodeSelection(node: Node): void {
        if (this.selectedNodes.has(node)) {
            this.deselectNode(node);
        } else {
            this.selectNode(node);
        }
    }

    public reset(): void {
        //console.log("Resetting InteractionService state...");
    
        // Reset zoom and pan
        this.zoomFactor = 1;
        this.panOffset = { x: 0, y: 0 };
    
        // Reset world matrix
        this.updateWorldMatrix();
    
        // Clear depth texture if it exists (prevents memory leaks)
        // if (this.depthTexture) {
        //     this.depthTexture.destroy();
        //     this.depthTexture = null!;
        // }
        // if (this.depthTextureView) {
        //     this.depthTextureView = null!;
        // }
    
        // Reset viewport bounds
        this.viewportBounds.markDirty();
        
        // Deselect any selected nodes
        this.clearSelectedNodes();
        //console.log("InteractionService reset complete.");
    }

private getViewBoundsInWorldSpace(): { minX: number, maxX: number, minY: number, maxY: number } {
    const aspectRatio = this.canvas.width / this.canvas.height;
    
    // Half viewport size in world space
    const halfViewWidth = 1 / this.zoomFactor / aspectRatio;
    const halfViewHeight = 1 / this.zoomFactor;
    
    // Current center in world space
    const centerX = -this.panOffset.x / this.canvas.width / this.zoomFactor * aspectRatio;
    const centerY = this.panOffset.y / this.canvas.height / this.zoomFactor;
    
    return {
        minX: centerX - halfViewWidth,
        maxX: centerX + halfViewWidth,
        minY: centerY - halfViewHeight,
        maxY: centerY + halfViewHeight
    };
}

private getBleedWorldFromPixels(padPx: number) {
  const aspect = this.canvas.width / this.canvas.height;
  const z = this.zoomFactor;
  const pxPerWorldX = this.canvas.width  * 0.5 * z / aspect;
  const pxPerWorldY = this.canvas.height * 0.5 * z;
  return {
    x: padPx / pxPerWorldX,   // world units to cover padPx in X
    y: padPx / pxPerWorldY,   // world units to cover padPx in Y
  };
}

private constrainPanToIllustrationBounds(
  dx: number, dy: number, illustrationBounds: { width: number; height: number }
): { dx: number; dy: number } {
  const newPanX = this.panOffset.x + dx;
  const newPanY = this.panOffset.y + dy;

  const aspectRatio   = this.canvas.width / this.canvas.height;
  const halfViewWidth = 1 / this.zoomFactor / aspectRatio;
  const halfViewHeight= 1 / this.zoomFactor;

  const newCenterX = -newPanX / this.canvas.width  / this.zoomFactor * aspectRatio;
  const newCenterY =  newPanY / this.canvas.height / this.zoomFactor;

  // illustration bounds (world)
  const minX = -illustrationBounds.width  * 1.5;
  const maxX =  illustrationBounds.width  * 1.5;
  const minY = -illustrationBounds.height * 2;
  const maxY =  illustrationBounds.height * 2;

  // --- bleed in world units (match scissor padPx) ---
  const padPx = 2;
  const bleed = this.getBleedWorldFromPixels(padPx);

  // loosen clamps by bleed
  const minCenterX = (minX - bleed.x) + halfViewWidth;
  const maxCenterX = (maxX + bleed.x) - halfViewWidth;
  const minCenterY = (minY - bleed.y) + halfViewHeight;
  const maxCenterY = (maxY + bleed.y) - halfViewHeight;

  const clampedCenterX = Math.min(maxCenterX, Math.max(minCenterX, newCenterX));
  const clampedCenterY = Math.min(maxCenterY, Math.max(minCenterY, newCenterY));

  const clampedPanX = -clampedCenterX * this.canvas.width * this.zoomFactor / aspectRatio;
  const clampedPanY =  clampedCenterY * this.canvas.height * this.zoomFactor;

  return { dx: clampedPanX - this.panOffset.x, dy: clampedPanY - this.panOffset.y };
}


}