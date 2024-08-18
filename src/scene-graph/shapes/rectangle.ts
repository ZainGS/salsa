// src/scene-graph/rectangle.ts
// Represents a rectangle with a specific width, height, fill color, and stroke.

import { mat4, vec3, vec4 } from 'gl-matrix';
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Rectangle extends Shape {
    private _width!: number;
    private _height!: number;
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
        this.width = width;
        this.height = height;
        this.calculateBoundingBox(); // Calculate initial bounding box
        
    }

    protected getScaleFactors(): [number, number] {
        console.log(this.width);
        console.log(this.height);
        return [this.width, this.height];
    }

    get width() {
        return this._width;
    }

    set width(newWidth: number) {
        //mat4.scale(this.localMatrix,this.localMatrix,[newWidth,1,1]);
        this._width = newWidth;
        this.updateLocalMatrix();
        this.calculateBoundingBox();
    }

    get height() {
        return this._height;
    }

    set height(newHeight: number) {
        //mat4.scale(this.localMatrix,this.localMatrix,[1,newHeight,1]);
        this._height = newHeight;
        this.updateLocalMatrix();
        this.calculateBoundingBox();
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
    
        // Check if the point is within the rectangle's bounds in local space
        const halfWidth = this.width/2/ aspectRatio; // Assuming width is in NDC space
        const halfHeight = this.height/2; // Assuming height is in NDC space
        
        return (
            point[0] >= -halfWidth &&
            point[0] <= halfWidth &&
            point[1] >= -halfHeight &&
            point[1] <= halfHeight
        );
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