// src/scene-graph/line.ts
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Line extends Shape {
    private _x1: number;
    private _y1: number;
    private _x2: number;
    private _y2: number;
    private _interactionService: InteractionService;

    constructor(renderStrategy: RenderStrategy, 
        x1: number, 
        y1: number, 
        x2: number, 
        y2: number, 
        strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
        strokeWidth: number = 1,
        interactionService: InteractionService) {

        super(renderStrategy, {r:0,g:0,b:0,a:0}, strokeColor, strokeWidth);
        this._x1 = x1;
        this._y1 = y1;
        this._x2 = x2;
        this._y2 = y2;
        this._interactionService = interactionService;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    protected getScaleFactors(): [number, number] {
        return [this.x2-this.x1 , this.y2-this.y1];
    }

    get x1() {
        return this._x1;
    }

    get y1() {
        return this._y1;
    }

    get x2() {
        return this._x2;
    }

    get y2() {
        return this._y2;
    }

    containsPoint(px: number, py: number): boolean {
        const zoomFactor = this._interactionService.getZoomFactor();
        const panOffset = this._interactionService.getPanOffset();

        // Adjust the point (px, py) based on zoom factor and pan offset
        const adjustedX = (px - panOffset.x) / zoomFactor;
        const adjustedY = (py - panOffset.y) / zoomFactor;

        // Calculate the distance of the point to the line
        const distance = Math.abs((this._x2 - this._x1) * (this._y1 - adjustedY) - (this._x1 - adjustedX) * (this._y2 - this._y1)) /
                        Math.sqrt((this._x2 - this._x1) ** 2 + (this._y2 - this._y1) ** 2);

        // Consider the line width (strokeWidth) for hit testing
        return distance <= this._strokeWidth / 2;
    }

    protected calculateBoundingBox() {
        const zoomFactor = this._interactionService.getZoomFactor();
        const panOffset = this._interactionService.getPanOffset();

        // Adjust the bounding box position and size based on zoom and pan
        const adjustedX1 = (this._x1 - panOffset.x) * zoomFactor;
        const adjustedY1 = (this._y1 - panOffset.y) * zoomFactor;
        const adjustedX2 = (this._x2 - panOffset.x) * zoomFactor;
        const adjustedY2 = (this._y2 - panOffset.y) * zoomFactor;

        // Calculate the bounding box around the line
        this._boundingBox = {
            x: Math.min(adjustedX1, adjustedX2) - this._strokeWidth / 2,
            y: Math.min(adjustedY1, adjustedY2) - this._strokeWidth / 2,
            width: Math.abs(adjustedX2 - adjustedX1) + this._strokeWidth,
            height: Math.abs(adjustedY2 - adjustedY1) + this._strokeWidth,
        };
    }
}