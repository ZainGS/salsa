// src/scene-graph/polygon.ts
// Represents a polygon defined by a series of points.

import { RenderStrategy } from '../renderer/render-strategy';
import { RGBA } from '../types/rgba';
import { Shape } from './shape';

export class Polygon extends Shape {
    private _points: { x: number; y: number }[];

    constructor(renderStrategy: RenderStrategy, points: { x: number; y: number }[], fillColor: RGBA = {r:0,g:0,b:0,a:0}, strokeColor: RGBA = {r:0,g:0,b:0,a:1}, strokeWidth: number = 1) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this._points = points;
    }

    get points() {
        return this._points;
    }

    containsPoint(x: number, y: number): boolean {
        // Basic point-in-polygon test (not very accurate but a placeholder)
        // More accurate algorithms can be implemented here
        let inside = false;
        for (let i = 0, j = this._points.length - 1; i < this._points.length; j = i++) {
            const xi = this._points[i].x, yi = this._points[i].y;
            const xj = this._points[j].x, yj = this._points[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    protected calculateBoundingBox() {
        const minX = Math.min(...this._points.map(p => p.x));
        const minY = Math.min(...this._points.map(p => p.y));
        const maxX = Math.max(...this._points.map(p => p.x));
        const maxY = Math.max(...this._points.map(p => p.y));

        this._boundingBox = {
            x: this.x + minX,
            y: this.y + minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }
}