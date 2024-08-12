// src/scene-graph/circle.ts
// Represents a circle with a specific radius, fill color, and stroke.

import { RenderStrategy } from '../renderer/render-strategy';
import { Shape } from './shape';

export class Circle extends Shape {
    private radius: number;

    constructor(renderStrategy: RenderStrategy, radius: number, fillColor: string = 'transparent', strokeColor: string = 'black', strokeWidth: number = 1) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this.radius = radius;
    }

    containsPoint(x: number, y: number): boolean {
        return Math.sqrt(x * x + y * y) <= this.radius;
    }

    protected calculateBoundingBox() {
        this._boundingBox = {
            x: this.x - this.radius,
            y: this.y - this.radius,
            width: this.radius * 2,
            height: this.radius * 2,
        };
    }
}