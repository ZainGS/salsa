// src/scene-graph/circle.ts
// Represents a circle with a specific radius, fill color, and stroke.

import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Circle extends Shape {
    private _radius: number;

    constructor(renderStrategy: RenderStrategy, radius: number, fillColor: RGBA = {r:0,g:0,b:0,a:0}, strokeColor: RGBA = {r:0,g:0,b:0,a:1}, strokeWidth: number = 1) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this._radius = radius;
        this.calculateBoundingBox();
    }

    get radius() {
        return this._radius;
    }

    set radius(radius: number) {
        this._radius = radius;
        this.triggerRerender();
    }

    containsPoint(x: number, y: number): boolean {
        const dx = x - this.x;
        const dy = y - this.y;
        return (dx * dx + dy * dy) <= (this.radius * this.radius);
    }

    protected calculateBoundingBox() {
        const diameter = this.radius * 2;
        this._boundingBox = {
            x: this.x - this.radius,
            y: this.y - this.radius,
            width: diameter,
            height: diameter,
        };
    }
}