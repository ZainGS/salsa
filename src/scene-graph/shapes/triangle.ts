// src/scene-graph/triangle.ts
import { mat4, vec2, vec3, vec4 } from 'gl-matrix';
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Triangle extends Shape {
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
        return [this.width, this.height]; // Scaling factors based on width and height
    }

    get width() {
        return this._width;
    }

    get height() {
        return this._height;
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
    
        // Perform the barycentric technique to check if the point is inside the triangle
        // Vertices of the triangle centered at the origin
        const v0 = vec2.fromValues(0.0, 0.5);    // Top-middle
        const v1 = vec2.fromValues(0.5, -0.5);   // Bottom-right
        const v2 = vec2.fromValues(-0.5, -0.5);  // Bottom-left
    
        const p = vec2.fromValues(point[0], point[1]);
    
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

        // Correct the dimensions of the rectangle for the aspect ratio
        // TODO: Find out exactly why I have to square the dimensions... probably world matrix related.
        const correctedWidth = (this._width);
        const correctedHeight = this._height;
    
        // Define the four corners of the rectangle in local space
        const topLeft = vec4.fromValues((this.x - correctedWidth / 2), this.y - correctedHeight / 2, 0, 1);
        const topRight = vec4.fromValues(this.x + correctedWidth / 2, this.y - correctedHeight / 2, 0, 1);
        const bottomLeft = vec4.fromValues((this.x - correctedWidth / 2), this.y + correctedHeight / 2, 0, 1);
        const bottomRight = vec4.fromValues(this.x + correctedWidth / 2, this.y + correctedHeight / 2, 0, 1);
    
        // Transform the corners using the worldMatrix
        const worldMatrix = this._interactionService.getWorldMatrix();
        vec4.transformMat4(topLeft, topLeft, worldMatrix);
        vec4.transformMat4(topRight, topRight, worldMatrix);
        vec4.transformMat4(bottomLeft, bottomLeft, worldMatrix);
        vec4.transformMat4(bottomRight, bottomRight, worldMatrix);

        // Calculate the bounding box by finding the min and max X and Y coordinates
        const minX = Math.min(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
        const maxX = Math.max(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
        const minY = Math.min(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);
        const maxY = Math.max(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);
    
        

        // Update the bounding box with the transformed coordinates
        this._boundingBox = {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }
}