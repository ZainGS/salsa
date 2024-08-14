// src/scene-graph/rectangle.ts
// Represents a rectangle with a specific width, height, fill color, and stroke.

import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Rectangle extends Shape {
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
        return x >= this.x && x <= this.x + this.width &&
               y >= this.y && y <= this.y + this.height;
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