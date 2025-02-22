// src/scene-graph/line.ts
import { mat4, vec3, vec4 } from 'gl-matrix';
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';

export class Line extends Shape {
    private _x1: number;
    private _y1: number;
    private _x2: number;
    private _y2: number;
    interactionService!: InteractionService;

    constructor(renderStrategy: RenderStrategy, 
        x1: number, 
        y1: number, 
        x2: number, 
        y2: number, 
        strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
        strokeWidth: number = 1,
        interactionService: InteractionService) {

        super(renderStrategy, {r:0,g:0,b:0,a:0}, strokeColor, strokeWidth, interactionService);
        this._x1 = x1;
        this._y1 = y1;
        this._x2 = x2;
        this._y2 = y2;
        this._interactionService = interactionService;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    protected getScaleFactors(): [number, number] {
        return [this.x2-this.x1 , this.y2-this.y1];
    }

    get x1() {
        return this._x1;
    }

    get y1() {
        return this._y1;
    }

    get x2() {
        return this._x2;
    }

    get y2() {
        return this._y2;
    }

    containsPoint(x: number, y: number): boolean {
        const inverseLocalMatrix = mat4.create();
        const success = mat4.invert(inverseLocalMatrix, this.localMatrix);
        if (!success) {
            console.error("Matrix inversion failed");
            return false;
        }
    
    
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseLocalMatrix);
    
        
    
        const localPoint = vec3.create();
        vec3.transformMat4(localPoint, point, inverseLocalMatrix);
    
        // Transform line endpoints to local space
        const start = vec3.fromValues(this._x1, this._y1, 0);
        const end = vec3.fromValues(this._x2, this._y2, 0);
        vec3.transformMat4(start, start, inverseLocalMatrix);
        vec3.transformMat4(end, end, inverseLocalMatrix);
    
        const x1 = start[0], y1 = start[1];
        const x2 = end[0], y2 = end[1];
    
        // Compute vector along the line
        const lineDX = (x2 - x1);
        const lineDY = (y2 - y1);
        const lengthSquared = lineDX * lineDX + lineDY * lineDY;
    
        if (lengthSquared === 0) {
            // Edge case: If the line is just a single point, check distance
            return Math.hypot(localPoint[0] - x1, localPoint[1] - y1) <= (this._strokeWidth / 2);
        }
    
        // Compute projection of the point onto the line segment
        let t = ((localPoint[0] - x1) * lineDX + (localPoint[1] - y1) * lineDY) / lengthSquared;
        t = Math.max(0, Math.min(1, t)); // Clamp to segment
    
        // Find closest point on the line
        const closestX = x1 + t * lineDX;
        const closestY = y1 + t * lineDY;
    
        // Get zoom factor to properly scale stroke width
        const zoomFactor = this._interactionService.getZoomFactor();
        const adjustedStrokeWidth = this._strokeWidth / zoomFactor;
    
        // Check if the transformed point is within stroke width of the closest point
        const distance = Math.hypot(localPoint[0] - closestX, localPoint[1] - closestY);
        return distance <= (adjustedStrokeWidth / 2)*.035;
    }
    
    protected calculateBoundingBox() {
        // Get world matrix (applied later)
        const worldMatrix = this._interactionService.getWorldMatrix();
    
        // Convert stroke width to world space
        const strokeHalfWidth = this._strokeWidth / 2;
    
        // Compute direction of the line
        const dx = this._x2 - this._x1;
        const dy = this._y2 - this._y1;
        const length = Math.sqrt(dx * dx + dy * dy);
    
        // Normalize direction
        const nx = dx / length;
        const ny = dy / length;
    
        // Perpendicular offset vector for stroke width
        const perpX = -ny * strokeHalfWidth;
        const perpY = nx * strokeHalfWidth;
    
        // Compute bounding quad vertices (expand in perpendicular direction)
        const topLeft = vec4.fromValues(this._x1 + perpX, this._y1 + perpY, 0, 1);
        const topRight = vec4.fromValues(this._x2 + perpX, this._y2 + perpY, 0, 1);
        const bottomLeft = vec4.fromValues(this._x1 - perpX, this._y1 - perpY, 0, 1);
        const bottomRight = vec4.fromValues(this._x2 - perpX, this._y2 - perpY, 0, 1);
    
        // Transform bounding box using worldMatrix
        vec4.transformMat4(topLeft, topLeft, worldMatrix);
        vec4.transformMat4(topRight, topRight, worldMatrix);
        vec4.transformMat4(bottomLeft, bottomLeft, worldMatrix);
        vec4.transformMat4(bottomRight, bottomRight, worldMatrix);
    
        // Store bounding box
        this._boundingBox = {
            x: Math.min(topLeft[0], bottomLeft[0]),
            y: Math.min(topLeft[1], topRight[1]),
            width: Math.max(topRight[0], bottomRight[0]) - Math.min(topLeft[0], bottomLeft[0]),
            height: Math.max(bottomLeft[1], bottomRight[1]) - Math.min(topLeft[1], topRight[1]),
            //vertices: [topLeft, topRight, bottomLeft, bottomRight] // Store for rendering
        };
    }
    
    public updateEndPoint(x2: number, y2: number) {
        this._x2 = x2;
        this._y2 = y2;
        this.calculateBoundingBox();
        this.markDirty();
    }
}