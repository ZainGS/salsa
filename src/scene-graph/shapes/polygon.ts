// src/scene-graph/polygon.ts
// Represents a polygon defined by a series of points.

import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Polygon extends Shape {
    private _points: { x: number; y: number }[];
    private _interactionService: InteractionService;

    constructor(
        renderStrategy: RenderStrategy, 
        points: { x: number; y: number }[], 
        fillColor: RGBA = {r:0,g:0,b:0,a:0}, 
        strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
        strokeWidth: number = 1,
        interactionService: InteractionService
    ) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this._points = points;
        this._interactionService = interactionService;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    protected getScaleFactors(): [number, number] {
        const minX = Math.min(...this._points.map(p => p.x));
        const minY = Math.min(...this._points.map(p => p.y));
        const maxX = Math.max(...this._points.map(p => p.x));
        const maxY = Math.max(...this._points.map(p => p.y));

        return [maxX-minX, maxY-minY];
    }

    get points() {
        return this._points;
    }

    containsPoint(x: number, y: number): boolean {
        const zoomFactor = this._interactionService.getZoomFactor();
        const panOffset = this._interactionService.getPanOffset();

        // Adjust the point (x, y) based on zoom factor and pan offset
        const adjustedX = (x - panOffset.x) / zoomFactor;
        const adjustedY = (y - panOffset.y) / zoomFactor;

        // Perform a point-in-polygon test (even-odd rule)
        let inside = false;
        for (let i = 0, j = this._points.length - 1; i < this._points.length; j = i++) {
            const xi = this._points[i].x + this.x;
            const yi = this._points[i].y + this.y;
            const xj = this._points[j].x + this.x;
            const yj = this._points[j].y + this.y;

            const intersect = ((yi > adjustedY) !== (yj > adjustedY)) && 
                              (adjustedX < (xj - xi) * (adjustedY - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    protected calculateBoundingBox() {
        const zoomFactor = this._interactionService.getZoomFactor();
        const panOffset = this._interactionService.getPanOffset();

        const minX = Math.min(...this._points.map(p => p.x));
        const minY = Math.min(...this._points.map(p => p.y));
        const maxX = Math.max(...this._points.map(p => p.x));
        const maxY = Math.max(...this._points.map(p => p.y));

        // Adjust the bounding box position and size based on zoom and pan
        this._boundingBox = {
            x: (this.x + minX - panOffset.x) * zoomFactor,
            y: (this.y + minY - panOffset.y) * zoomFactor,
            width: (maxX - minX) * zoomFactor,
            height: (maxY - minY) * zoomFactor,
        };
    }
}