// src/scene-graph/triangle.ts
import { mat4, vec2, vec3, vec4 } from 'gl-matrix';
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Triangle extends Shape {

    private _interactionService: InteractionService;

    constructor(renderStrategy: RenderStrategy, 
        x: number, 
        y: number,
        width: number, 
        height: number, 
        fillColor: RGBA = {r:0,g:0,b:0,a:0}, 
        strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
        strokeWidth: number = 1,
        interactionService: InteractionService) {

        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this.width = width;
        this.height = height;
        this.x = x;
        this.y = y;
        

        this.boundingBox.x = x;
        this.boundingBox.y = x;
        this.boundingBox.width = this.width;
        this.boundingBox.height = this.height;

        this._interactionService = interactionService;
    }

    protected getScaleFactors(): [number, number] {
        return [this.width, this.height]; // Scaling factors based on width and height
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

        
    }
}