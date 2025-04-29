// src/scene-graph/rectangle.ts
// Represents a rectangle with a specific width, height, fill color, and stroke.

import { mat4, vec3 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';

export class Rectangle extends Shape {

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

        //this.calculateBoundingBox(); // Calculate initial bounding box
        
    }

    protected getScaleFactors(): [number, number] {
        return [this.width, this.height];
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
    // containsPoint(x: number, y: number): boolean {
    //     const point = vec3.fromValues(x, y, 0);
    //     vec3.transformMat4(point, point, this.getInverseLocalMatrix());
    
    //     // Check if the point is within the rectangle's bounds in local space
    //     const halfWidth = this.width / 2;
    //     const halfHeight = this.height / 2;
    
    //     return (
    //         point[0] >= -halfWidth &&
    //         point[0] <= halfWidth &&
    //         point[1] >= -halfHeight &&
    //         point[1] <= halfHeight
    //     );
    // }

    containsPoint(x: number, y: number): boolean {
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, this.getInverseLocalMatrix());
    
        // Use scaleX and scaleY instead of width/height
        const halfWidth = (this.width) / 2;
        const halfHeight = (this.height) / 2;
    
        return (
            point[0] >= -halfWidth &&
            point[0] <= halfWidth &&
            point[1] >= -halfHeight &&
            point[1] <= halfHeight
        );
    }

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;
    
        const halfWidth = .5;
        const halfHeight = .5;
    
        const vertices = new Float32Array([
            -halfWidth, -halfHeight, // Bottom-left
             halfWidth, -halfHeight, // Bottom-right
            -halfWidth,  halfHeight, // Top-left
             halfWidth,  halfHeight  // Top-right
        ]);
    
        this.cachedVertices = vertices;
        return vertices;
    }
    
    public getGeometryIndices(): Uint16Array {
        if (this.cachedIndices) return this.cachedIndices;
    
        const indices = new Uint16Array([
            0, 1, 2, // First triangle (bottom-left, bottom-right, top-left)
            2, 1, 3  // Second triangle (top-left, bottom-right, top-right)
        ]);
    
        this.cachedIndices = indices;
        return indices;
    }

    getType(): string {
        return "Rectangle";
    }
}