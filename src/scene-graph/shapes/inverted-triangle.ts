// src/scene-graph/inverted-triangle.ts
import { mat4, vec2, vec3 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';

export class InvertedTriangle extends Shape {

    constructor(x: number,
                y: number,
                width: number, 
                height: number, 
                fillColor: RGBA = {r:0,g:0,b:0,a:0}, 
                strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
                strokeWidth: number = 1,
                interactionService: InteractionService) {

        super(fillColor, strokeColor, strokeWidth, interactionService);
        this.width = width;
        this.height = height;
        this._interactionService = interactionService;
        this.x = x;
        this.y = y;
        

        this.boundingBox.x = x;
        this.boundingBox.y = x;
        this.boundingBox.width = this.width;
        this.boundingBox.height = this.height;
    }

    protected getScaleFactors(): [number, number] {
        return [this.scaleX, this.scaleY];
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
    
        // Vertices of the inverted triangle centered at the origin
        const v0 = vec2.fromValues(0.0, -0.5 * this.height);   // Bottom-middle
        const v1 = vec2.fromValues(0.5 * this.width, 0.5 * this.height);    // Top-right
        const v2 = vec2.fromValues(-0.5 * this.width, 0.5 * this.height);   // Top-left
    
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

    public calculateBoundingBox() {
        // Inverted triangle vertices relative to center
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        // Bounding box in world space (centered on x, y)
        this._boundingBox = {
            x: this.x - halfWidth,   // Left-most point
            y: this.y - halfHeight,  // Bottom-most point
            width: this.width,       // Total width
            height: this.height      // Total height
        };
    }

    getType(): string {
        return "Inverted Triangle";
    }

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;
    
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        const vertices = new Float32Array([
            0.0, -halfHeight,   // Bottom-middle
            halfWidth, halfHeight,   // Top-right
            -halfWidth, halfHeight   // Top-left
        ]);
    
        this.cachedVertices = vertices;
        return vertices;
    }
    
    public getGeometryIndices(): Uint16Array {
        if (this.cachedIndices) return this.cachedIndices;
    
        const indices = new Uint16Array([
            0, 1, 2
        ]);
    
        this.cachedIndices = indices;
        return indices;
    }
}