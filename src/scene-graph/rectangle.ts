// src/scene-graph/rectangle.ts
// Represents a rectangle with a specific width, height, fill color, and stroke.

import { RenderStrategy } from '../renderer/render-strategy';
import { Shape } from './shape';

export class Rectangle extends Shape {
    private width: number;
    private height: number;

    constructor(renderStrategy: RenderStrategy, width: number, height: number, fillColor: string = 'transparent', strokeColor: string = 'black', strokeWidth: number = 1) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this.width = width;
        this.height = height;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    containsPoint(x: number, y: number): boolean {
        return x >= this.x && y >= this.y && x <= this.x + this.width && y <= this.y + this.height;
    }

    protected calculateBoundingBox() {
        this.boundingBox = {
            x: this.x - this._strokeWidth / 2,
            y: this.y - this._strokeWidth / 2,
            width: this.width + this._strokeWidth,
            height: this.height + this._strokeWidth,
        };
    }

}