// src/scene-graph/diamond.ts
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Diamond extends Shape {
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

    containsPoint(px: number, py: number): boolean {
        const zoomFactor = this._interactionService.getZoomFactor();
        const panOffset = this._interactionService.getPanOffset();

        // Adjust the point (px, py) based on zoom factor and pan offset
        const adjustedX = (px - panOffset.x) / zoomFactor;
        const adjustedY = (py - panOffset.y) / zoomFactor;

        // Calculate the center of the diamond
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
    
        // Calculate the absolute distances from the point to the center
        const dx = Math.abs(adjustedX - centerX);
        const dy = Math.abs(adjustedY - centerY);
    
        // For a point to be inside the diamond:
        // dx / (width / 2) + dy / (height / 2) <= 1
        return (dx / (this.width / 2) + dy / (this.height / 2)) <= 1;
    }

    protected calculateBoundingBox() {
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