// src/scene-graph/triangle.ts
import { mat4, vec2, vec3 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape, warnMatrixInversionFailedOnce } from './base/shape';

export class Triangle extends Shape {

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
        this.x = x;
        this.y = y;
        

        this.boundingBox.x = x;
        this.boundingBox.y = y;
        this.boundingBox.width = this.width;
        this.boundingBox.height = this.height;

        this._interactionService = interactionService;
    }

    protected getScaleFactors(): [number, number] {
        return [this.scaleX, this.scaleY]; // Scaling factors based on width and height
    }

    containsPoint(x: number, y: number): boolean {

        const inverseLocalMatrix = mat4.create();
        const success = mat4.invert(inverseLocalMatrix, this.localMatrix);
        if (!success) {
            warnMatrixInversionFailedOnce(); // §3.13: was per-pointer-move console.error spam
            return false;
        }
    
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseLocalMatrix);
    
        // Perform the barycentric technique to check if the point is inside the triangle
        // Vertices of the triangle centered at the origin
        const v0 = vec2.fromValues(0.0, 0.5 * this.height);    // Top-middle
        const v1 = vec2.fromValues(0.5 * this.width, -0.5 * this.height);   // Bottom-right
        const v2 = vec2.fromValues(-0.5 * this.width, -0.5 * this.height);  // Bottom-left
    
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

    public calculateBoundingBox(): void {
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        this.boundingBox = {
            x: this.x - halfWidth,
            y: this.y - halfHeight,
            width: this.width,
            height: this.height
        };
    }

    getType(): string {
        return "Triangle";
    }

    // public getGeometryVertices(): Float32Array {
    //     if (this.cachedVertices) return this.cachedVertices;
    
    //     const halfWidth = this.width / 2;
    //     const halfHeight = this.height / 2;
    
    //     const vertices = new Float32Array([
    //         0.0, halfHeight,      // Top-middle
    //         halfWidth, -halfHeight,  // Bottom-right
    //         -halfWidth, -halfHeight  // Bottom-left
    //     ]);
    
    //     this.cachedVertices = vertices;
    //     return vertices;
    // }
    
    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;
    
        // Centered triangle pointing upward
        const vertices = new Float32Array([
            0, 0.5,     // Top vertex
            -0.5, -0.5, // Bottom left
            0.5, -0.5   // Bottom right
        ]);
    
        this.cachedVertices = vertices;
        return vertices;
    }

    public getGeometryIndices(): Uint16Array {
        if (this.cachedIndices) return this.cachedIndices;
    
        const indices = new Uint16Array([
            0, 1, 2
        ]);
    
        // Ensure 4-byte alignment (must be even number of Uint16s)
        if ((indices.length * 2) % 4 !== 0) {
            const padded = new Uint16Array(indices.length + 1);
            padded.set(indices);
            this.cachedIndices = padded;
        } else {
            this.cachedIndices = indices;
        }

        return this.cachedIndices;
    }
}