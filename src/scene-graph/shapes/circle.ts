// src/scene-graph/circle.ts
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';
import { mat4, vec2, vec3, vec4 } from 'gl-matrix';

export class Circle extends Shape {
    private _radius!: number;
    private _interactionService: InteractionService;

    constructor(renderStrategy: RenderStrategy, 
        radius: number, 
        fillColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, 
        strokeColor: RGBA = {r: 0, g: 0, b: 0, a: 1}, 
        strokeWidth: number = 1, 
        interactionService: InteractionService) {

        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this._interactionService = interactionService;
        this.radius = radius;
        this.calculateBoundingBox();
    }

    protected getScaleFactors(): [number, number] {
        return [this.radius, this.radius];
    }

    get radius() {
        return this._radius;
    }

    set radius(radius: number) {
        this._radius = radius;
        mat4.scale(this.localMatrix, this.localMatrix, [radius, radius, 0]);
        this.triggerRerender();
    }

    containsPoint(x: number, y: number): boolean {

        // Calculate the aspect ratio correction factor
        const aspectRatio = this._interactionService.canvas.width / this._interactionService.canvas.height;
    
        const inverseMatrix = mat4.create();
        mat4.invert(inverseMatrix, this.localMatrix);
    
        // Transform the point (x, y) from model space to the shape's local space
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseMatrix);

        // Apply the aspect ratio correction to the point's x coordinate
        point[0] *= aspectRatio;
    
        // Calculate the distance from the point to the circle's center in local space
        const dx = point[0];
        const dy = point[1];
    
        const scaledRadius = this.radius; // Assuming radius is in NDC space
    
        // Check if the point is within the adjusted radius of the circle
        return (dx * dx + dy * dy) <= (scaledRadius * scaledRadius);
    }

    protected calculateBoundingBox() {
        // Calculate the original bounding box based on the circle's position and radius
        const originalBoundingBox = {
            x: this.x - this._radius - this._strokeWidth / 2,
            y: this.y - this._radius - this._strokeWidth / 2,
            width: this._radius * 2 + this._strokeWidth,
            height: this._radius * 2 + this._strokeWidth,
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