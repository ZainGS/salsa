import { mat4, vec3 } from "gl-matrix";

export class InteractionService {
    
    private zoomFactor: number = 1;
    private panOffset: { x: number, y: number } = { x: 0, y: 0 };

    // Affine transformation matrix (4x4 matrix for 3D transformations, but used in 2D context)
    private worldMatrix: mat4 = mat4.create(); // Identity matrix by default
    private _canvas: HTMLCanvasElement;

    constructor(canvas: HTMLCanvasElement) { 
        this._canvas = canvas; 
        this.updateWorldMatrix();
    }

    getAspectRatio() {
        return this.canvas.width/this.canvas.height;
    }
    
    get canvas(): HTMLCanvasElement {
        return this._canvas;
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
    }
    
    public getZoomFactor(): number {
        return this.zoomFactor;
    }

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
    }

    getWorldMatrix(): mat4 {
        return this.worldMatrix;
    }
}