// src/scene-graph/rectangle.ts
// Represents a rectangle with a specific width, height, fill color, and stroke.

import { mat4, vec3, vec4 } from 'gl-matrix';
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Rectangle extends Shape {
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
        console.log(interactionService);
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this._interactionService = interactionService;
        this._width = width;
        this._height = height;
        this.calculateBoundingBox(); // Calculate initial bounding box
        
    }

    get width() {
        return this._width;
    }

    get height() {
        return this._height;
    }


    // Adjust the click point (x, y) based on inverse world matrix:
    // We basically have to map just the click back from screen-space to the shape's coordinate space.
    // This avoids the need to manually adjust the shape's coordinates AND 
    // dimensions for zoom and pan in every interaction check. 
    // Instead, we adjust the click position and compare it against the unchanged shape bounds.
    // We can consistently use the shape's actual stored coordinates and dimensions, ensuring that 
    // all checks (e.g., hit tests, collision detection) are performed in a unified space.
    // If we mapped the shape to the zoomed/panned coordinate space instead, it would have looked like this:
    /*
            // Apply pan offset and zoom factor to shape's bounds
            const adjustedX = this.x * zoomFactor + panOffset.x;
            const adjustedY = this.y * zoomFactor + panOffset.y;
            const adjustedWidth = this.width * zoomFactor;
            const adjustedHeight = this.height * zoomFactor;
    */
    // See? We would've had to account for the adjusted width & height rendered as well...
    // We would've had to consistently apply the zoom and pan transforms to both the click position AND 
    // the shape. Hurray for simply mapping the click position back to the original space!!!!!!!!!!!     
    containsPoint(x: number, y: number): boolean {
        // Get the inverse of the worldMatrix to map the point back to the original space
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, this._interactionService.getWorldMatrix());
    
        // Transform the point using the inverse worldMatrix
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseWorldMatrix);
    
        // Perform the hit test using the shape's original coordinates
        return point[0] >= this.x && point[0] <= this.x + this.width &&
               point[1] >= this.y && point[1] <= this.y + this.height;
    }

    protected calculateBoundingBox() {
        const originalBoundingBox = {
            x: this.x - this._strokeWidth / 2,
            y: this.y - this._strokeWidth / 2,
            width: this._width + this._strokeWidth,
            height: this._height + this._strokeWidth,
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
    
        this._boundingBox = {
            x: topLeft[0],
            y: topLeft[1],
            width: bottomRight[0] - topLeft[0],
            height: bottomRight[1] - topLeft[1],
        };
    }

}