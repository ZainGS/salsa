// src/scene-graph/inverted-triangle.ts
import { mat4, vec2, vec3 } from 'gl-matrix';
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class InvertedTriangle extends Shape {
    private _width: number;
    private _height: number;
    private _interactionService: InteractionService;

    constructor(renderStrategy: RenderStrategy, 
        width: number, 
        height: number, 
        fillColor: RGBA = {r:0,g:0,b:0,a:0}, 
        strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
        strokeWidth: number = 1,
        interactionService: InteractionService) {

        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this._width = width;
        this._height = height;
        this._interactionService = interactionService;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    protected getScaleFactors(): [number, number] {
        return [this.width, this.height];
    }

    get width() {
        return this._width;
    }

    get height() {
        return this._height;
    }

    containsPoint(x: number, y: number): boolean {
        // Calculate the aspect ratio correction factor
        const aspectRatio = this._interactionService.canvas.width / this._interactionService.canvas.height;
    
        // Invert the local matrix to map the point back to the shape's local space
        const inverseLocalMatrix = mat4.create();
        const success = mat4.invert(inverseLocalMatrix, this.localMatrix);
        if (!success) {
            console.error("Matrix inversion failed");
            return false;
        }
    
        // Transform the point (x, y) from model space to the shape's local space
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseLocalMatrix);
    
        // Apply the aspect ratio correction to the point's x coordinate
        point[0] *= aspectRatio;
    
        // Vertices of the inverted triangle centered at the origin
        const v0 = vec2.fromValues(0.0, -0.5);   // Bottom-middle
        const v1 = vec2.fromValues(0.5, 0.5);    // Top-right
        const v2 = vec2.fromValues(-0.5, 0.5);   // Top-left
    
        const p = vec2.fromValues(point[0], point[1]);
    
        // Barycentric technique to check if the point is inside the inverted triangle
        const dX = p[0] - v2[0];
        const dY = p[1] - v2[1];
        const dX21 = v2[0] - v1[0];
        const dY12 = v1[1] - v2[1];
        const D = dY12 * (v0[0] - v2[0]) + dX21 * (v0[1] - v2[1]);
        const s = dY12 * dX + dX21 * dY;
        const t = (v2[1] - v0[1]) * dX + (v0[0] - v2[0]) * dY;
    
        if (D < 0) return s <= 0 && t <= 0 && s + t >= D;
        return s >= 0 && t >= 0 && s + t <= D;
    }

    protected calculateBoundingBox() {
        const zoomFactor = this._interactionService.getZoomFactor();
        const panOffset = this._interactionService.getPanOffset();

        const adjustedX = (this.x - panOffset.x) * zoomFactor;
        const adjustedY = (this.y - panOffset.y) * zoomFactor;
        const adjustedWidth = this._width * zoomFactor;
        const adjustedHeight = this._height * zoomFactor;

        this._boundingBox = {
            x: adjustedX - this._strokeWidth / 2,
            y: adjustedY - this._strokeWidth / 2,
            width: adjustedWidth + this._strokeWidth,
            height: adjustedHeight + this._strokeWidth,
        };
    }
}