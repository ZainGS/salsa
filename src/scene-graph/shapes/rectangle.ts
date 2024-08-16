// src/scene-graph/rectangle.ts
// Represents a rectangle with a specific width, height, fill color, and stroke.

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

    containsPoint(x: number, y: number): boolean {
        const zoomFactor = this._interactionService.getZoomFactor(); 
        const panOffset = this._interactionService.getPanOffset(); 
        
        // Adjust the point (x, y) based on inverse zoom factor and pan offset:
        // We basically have to map just the click back to the original coordinate space.
        // This avoids the need to manually adjust the shape's coordinates AND 
        // dimensions for zoom and pan in every interaction check. 
        // Instead, we adjust the click position and compare it against the unchanged shape bounds.
        // We can consistently use the shape's original coordinates and dimensions, ensuring that 
        // all checks (e.g., hit tests, collision detection) are performed in a unified space.
        // If we mapped the shape to the zoomed/panned coordinate space instead, it would have looked like this:
        /*
                // Apply pan offset and zoom factor to shape's bounds
                const adjustedX = this.x * zoomFactor + panOffset.x;
                const adjustedY = this.y * zoomFactor + panOffset.y;
                const adjustedWidth = this.width * zoomFactor;
                const adjustedHeight = this.height * zoomFactor;
        */
       // See? We would've had to account for the adjusted width & height as well...
       // We would've had to consistently apply the zoom and pan transforms to both the click position AND the shape. 
       // Hurray for simply mapping the click position back to the original space!!!!!!!!!!!!!!
        
        const adjustedX = (x - panOffset.x) / zoomFactor;
        const adjustedY = (y - panOffset.y) / zoomFactor;
        
        return adjustedX >= this.x && adjustedX <= this.x + this.width &&
               adjustedY >= this.y && adjustedY <= this.y + this.height;
    }

    protected calculateBoundingBox() {
        console.log(this._interactionService);
        const zoomFactor = this._interactionService.getZoomFactor(); 
        const panOffset = this._interactionService.getPanOffset(); 
    
        // Adjust the bounding box position and size based on zoom and pan
        const adjustedX = (this.x - panOffset.x) * zoomFactor;
        const adjustedY = (this.y - panOffset.y) * zoomFactor;
        const adjustedWidth = this._width * zoomFactor;
        const adjustedHeight = this._height * zoomFactor;
    
        this._boundingBox = {
            x: adjustedX - this._strokeWidth / 2,
            y: adjustedY - this._strokeWidth / 2,
            width: adjustedWidth + this._strokeWidth,
            height: adjustedHeight + this._strokeWidth,
        };
    }

}