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
        // Calculate the aspect ratio correction factor
        const aspectRatio = this._interactionService.canvas.width / this._interactionService.canvas.height;
    
        // Correct the dimensions of the rectangle for the aspect ratio
        // TODO: Find out exactly why I have to square the dimensions... probably world matrix related.
        const correctedWidth = (this._width / aspectRatio)*this._width;
        const correctedHeight = this._height * this._height;
    
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