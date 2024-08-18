// src/scene-graph/diamond.ts
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';
import { mat4, vec3 } from 'gl-matrix';

export class Diamond extends Shape {
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
        this._interactionService = interactionService;
        this._width = width;
        this._height = height;
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

        // Check if the point is within the diamond's bounds in local space
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;

        // Diamond hit test: check if point lies within the diamond shape
        return (
            Math.abs(point[0] / halfWidth) + Math.abs(point[1] / halfHeight) <= 1
        );
    }

    protected calculateBoundingBox() {
        const zoomFactor = this._interactionService.getZoomFactor();
        const panOffset = this._interactionService.getPanOffset();

        // Adjust the bounding box position and size based on zoom and pan
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