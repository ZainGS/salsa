// src/scene-graph/circle.ts
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';
import { mat4, vec3, vec4 } from 'gl-matrix';

export class Circle extends Shape {

    constructor(renderStrategy: RenderStrategy, 
        x: number, 
        y:number,
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
        this.boundingBox.y = x;
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

    protected calculateBoundingBox() {

        // Calculate the bounding box in world space
        const worldRadiusX = (this.width + this._strokeWidth);
        const worldRadiusY = (this.height + this._strokeWidth);
    
        // Calculate the original bounding box in world space based on the circle's position and radius
        const originalBoundingBox = {
            x: this.x - worldRadiusX * this.width,
            y: this.y - worldRadiusY * this.height,
            width: worldRadiusX * 2 * this.width,
            height: worldRadiusY * 2 * this.height,
        };
    
        // Transform the bounding box using the worldMatrix
        const worldMatrix = this._interactionService.getWorldMatrix();
    
        // Top-left corner
        const topLeft = vec4.fromValues(originalBoundingBox.x, originalBoundingBox.y, 0, 1);
        vec4.transformMat4(topLeft, topLeft, worldMatrix);
    
        // Bottom-right corner
        const bottomRight = vec4.fromValues(
            originalBoundingBox.x + originalBoundingBox.width, 
            originalBoundingBox.y + originalBoundingBox.height, 
            0, 1
        );
        vec4.transformMat4(bottomRight, bottomRight, worldMatrix);

        // Update the bounding box with the transformed coordinates
        this._boundingBox = {
            x: topLeft[0],
            y: topLeft[1],
            width: bottomRight[0] - topLeft[0],
            height: bottomRight[1] - topLeft[1],
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