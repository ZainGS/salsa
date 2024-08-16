import { mat4 } from "gl-matrix";

export class InteractionService {
    
    private zoomFactor: number = 1;
    private panOffset: { x: number, y: number } = { x: 0, y: 0 };

    // Affine transformation matrix (4x4 matrix for 3D transformations, but used in 2D context)
    private worldMatrix: mat4 = mat4.create(); // Identity matrix by default
    private _canvas: HTMLCanvasElement;
    private _aspectRatio: number;

    constructor(canvas: HTMLCanvasElement) { 
        this._canvas = canvas; 
        this._aspectRatio = this._canvas.width/this._canvas.height;
        this.updateWorldMatrix();
    }

    public adjustZoom(delta: number, mouseX: number, mouseY: number) {
        const prevZoomFactor = this.zoomFactor;
        this.zoomFactor = Math.max(0.8, Math.min(3, this.zoomFactor + delta)); // clamp between 0.1 and 10

        // Calculate the zoom scaling factor
        const zoomDelta = this.zoomFactor / prevZoomFactor;

        // Adjust pan offset to zoom towards the mouse position

        const canvasCenterX = this._canvas.width / 2;
        const canvasCenterY = this._canvas.height / 2;

        // Calculate the offset from the center of the canvas
        const offsetX = (mouseX - canvasCenterX) / this.zoomFactor;
        const offsetY = (mouseY - canvasCenterY) / this.zoomFactor;

        // Adjust the pan offset based on the change in zoom level
        this.panOffset.x -= offsetX * (zoomDelta - 1);
        this.panOffset.y -= offsetY * (zoomDelta - 1);

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
        // Reset to identity matrix
        mat4.identity(this.worldMatrix);

        // Apply translation
        mat4.translate(this.worldMatrix, this.worldMatrix, [this.panOffset.x/this._canvas.width*2, -this.panOffset.y/this._canvas.height*2, 0]);

        // Apply aspect ratio scaling
        //mat4.scale(this.worldMatrix, this.worldMatrix, [this._aspectRatio/2, 1.0, 1.0]); 

        // Apply scaling
        mat4.scale(this.worldMatrix, this.worldMatrix, [this.zoomFactor/this._aspectRatio, this.zoomFactor, 1]);
    }

    getWorldMatrix(): mat4 {
        return this.worldMatrix;
    }
}