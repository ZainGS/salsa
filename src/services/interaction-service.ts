import { mat4, vec4 } from "gl-matrix";
import { ViewportBounds } from "../renderer/util/viewport-bounds";
import { Node } from "../scene-graph/shapes/base/node";
import { Shape } from "../scene-graph/shapes/base/shape";
import { Rectangle } from "../scene-graph/shapes/rectangle";

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

    // flags for tool panel, panning, etc. overrides
    isPanToolSelected: boolean = false;

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
    

    public adjustZoom(delta: number, mouseX: number, mouseY: number) {

        mouseX *=2;
        mouseY *=2;

        // Apply zoom change proportionally to the current zoom factor
        const zoomChange = 1 + delta;
        const prevZoomFactor = this.zoomFactor;
        this.zoomFactor = Math.max(0.25, Math.min(2.25, this.zoomFactor * zoomChange)); // Clamp between 0.25 and 2.25

        // Calculate the world space position of the mouse before zoom
        const worldMouseX = (mouseX - this.panOffset.x) / prevZoomFactor;
        const worldMouseY = (mouseY - this.panOffset.y) / prevZoomFactor;

        // Calculate the new pan offset so that the world space position under the mouse stays consistent
        this.panOffset.x = mouseX - worldMouseX * this.zoomFactor;
        this.panOffset.y = mouseY - worldMouseY * this.zoomFactor;

        // Update the world matrix
        this.updateWorldMatrix();
        
        // Update the Viewport's Transform Cache on next update
        this.viewportBounds.markDirty();
    }
    
    public getZoomFactor(): number {
        return this.zoomFactor;
    }

    // Never called yet... maybe if ability to manually set zoom is added
    public setPanOffset(x: number, y: number) {
        this.panOffset.x = x;
        this.panOffset.y = y;
        this.updateWorldMatrix();
    }

    public adjustPan(dx: number, dy: number) {
        const effectiveDx = dx;
        const effectiveDy = dy;
    
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
        for (const node of this.selectedNodes) {
            (node as Shape).deselect();
        }
        this.selectedNodes.clear();
    }

    public selectNode(node: Node): void {
        (node as Shape).select();
        this.selectedNodes.add(node);
    }
    
    public deselectNode(node: Node): void {
        (node as Shape).deselect();
        this.selectedNodes.delete(node);
    }
    
    public toggleNodeSelection(node: Node): void {
        if (this.selectedNodes.has(node)) {
            this.deselectNode(node);
        } else {
            this.selectNode(node);
        }
    }

    public reset(): void {
        console.log("Resetting InteractionService state...");
    
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
        console.log("InteractionService reset complete.");
    }
}