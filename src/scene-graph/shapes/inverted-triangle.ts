// src/scene-graph/inverted-triangle.ts
// Represents an inverted triangle with a specific width, height, fill color, and stroke.

import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class InvertedTriangle extends Shape {
    private _width: number;
    private _height: number;

    constructor(renderStrategy: RenderStrategy, width: number, height: number, fillColor: RGBA = {r:0,g:0,b:0,a:0}, strokeColor: RGBA = {r:0,g:0,b:0,a:1}, strokeWidth: number = 1) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
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
        // Calculate the vertices of the triangle
        const x1 = this.x;
        const y1 = this.y + this.height;
        const x2 = this.x + this.width / 2;
        const y2 = this.y;
        const x3 = this.x + this.width;
        const y3 = this.y + this.height;

        // Barycentric technique to check if the point is inside the triangle
        const dX = x - x3;
        const dY = y - y3;
        const dX21 = x3 - x2;
        const dY12 = y2 - y3;
        const D = dY12 * (x1 - x3) + dX21 * (y1 - y3);
        const s = dY12 * dX + dX21 * dY;
        const t = (y3 - y1) * dX + (x1 - x3) * dY;

        if (D < 0) return s <= 0 && t <= 0 && s + t >= D;
        return s >= 0 && t >= 0 && s + t <= D;
    }

    protected calculateBoundingBox() {
        this._boundingBox = {
            x: this.x - this._strokeWidth / 2,
            y: this.y - this._strokeWidth / 2,
            width: this._width + this._strokeWidth,
            height: this._height + this._strokeWidth,
        };
    }
}