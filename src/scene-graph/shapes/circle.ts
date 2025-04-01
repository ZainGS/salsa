// src/scene-graph/circle.ts
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';
import { mat4, vec3, vec4 } from 'gl-matrix';

export class Circle extends Shape {

    constructor(renderStrategy: RenderStrategy, 
        x: number, 
        y: number,
        radius: number, 
        fillColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, 
        strokeColor: RGBA = {r: 0, g: 0, b: 0, a: 1}, 
        strokeWidth: number = 1, 
        interactionService: InteractionService) {

        super(renderStrategy, fillColor, strokeColor, strokeWidth, interactionService);
        this._interactionService = interactionService;
        this.width = radius;
        this.height = radius;
        this.x = x;
        this.y = y;
        

        this.boundingBox.x = x;
        this.boundingBox.y = y;
        this.boundingBox.width = this.width;
        this.boundingBox.height = this.height;
    }

    protected getScaleFactors(): [number, number] {
        return [this.width, this.height];
    }

    containsPoint(x: number, y: number): boolean {

        const inverseLocalMatrix = mat4.create();
        mat4.invert(inverseLocalMatrix, this.localMatrix);
    
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseLocalMatrix);
    
        // Calculate the distance from the point to the circle's center in local space
        const dx = point[0];
        const dy = point[1];
    
        // Calculate the scaled radius in both x and y directions
        const scaledRadiusX = this.width / 2;
        const scaledRadiusY = this.height / 2;
    
        // Normalize the dx and dy by the scaled radii
        const normalizedDx = dx / scaledRadiusX;
        const normalizedDy = dy / scaledRadiusY;

        // Check if the point is within the ellipse (adjusted circle)
        return (normalizedDx * normalizedDx + normalizedDy * normalizedDy) <= 1;
    }

    protected calculateBoundingBox(): void {
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        this._boundingBox = {
            x: this.x - halfWidth,
            y: this.y - halfHeight,
            width: this.width,
            height: this.height
        };
    }

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;

        // Circle drawing logic using triangle-list
        // Increase number of segments = smoother circle
        const numSegments = 60;
        const angleStep = (Math.PI * 2) / numSegments;
        const vertices: number[] = [];

        const halfWidth = this.width * 0.5;
        const halfHeight = this.height * 0.5;

        // Create the circle vertices w/ triangle list approach
        for (let i = 0; i < numSegments; i++) {
             // Center circle vertex for current triangle
            vertices.push(0, 0);

            // First & second (next segment) perimeter points of the triangle
            const angle1 = i * angleStep;
            const angle2 = (i + 1) * angleStep;

            vertices.push(Math.cos(angle1) * halfWidth, Math.sin(angle1) * halfHeight);
            vertices.push(Math.cos(angle2) * halfWidth, Math.sin(angle2) * halfHeight);
        }

        this.cachedVertices = new Float32Array(vertices);
        return this.cachedVertices;
    }

    public getGeometryIndices(): Uint16Array {
        if (this.cachedIndices) return this.cachedIndices;

        const numSegments = 60;
        const indices: number[] = [];

        for (let i = 0; i < numSegments; i++) {
            const baseIndex = i * 3;
            indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
        }

        this.cachedIndices = new Uint16Array(indices);
        return this.cachedIndices;
    }

    getType(): string {
        return "Circle";
    }

    toJSON() {
        return {
            ...super.toJSON(),
            type: this.getType(),
            radius: this.width,
        };
    }
}

/* 

NOTES:
For Bounding Box Calculation:
Since the world matrix is applied to the vertex positions in the shader, 
you don't need to manually apply the zoom factor and pan offset in the calculateBoundingBox 
method. Instead, you should directly use the shape's original dimensions and positions.

For Hit Detection:
For hit detection to work correctly in the transformed space, you'll need to apply the inverse of 
the world matrix to the point coordinates before performing the hit test. This will convert the coordinates 
back to the original, untransformed space.

*/