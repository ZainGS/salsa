// src/scene-graph/circle.ts
// Represents a circle with a specific radius, fill color, and stroke.

import { Shape } from './shape';

export class Circle extends Shape {
    private radius: number;

    constructor(radius: number, fillColor: string = 'transparent', strokeColor: string = 'black', strokeWidth: number = 1) {
        super(fillColor, strokeColor, strokeWidth);
        this.radius = radius;
    }

    draw(ctx: CanvasRenderingContext2D) {
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);

        if (this._fillColor !== 'transparent') {
            ctx.fillStyle = this._fillColor;
            ctx.fill();
        }

        if (this._strokeWidth > 0) {
            ctx.strokeStyle = this._strokeColor;
            ctx.lineWidth = this._strokeWidth;
            ctx.stroke();
        }
    }

    containsPoint(x: number, y: number): boolean {
        return Math.sqrt(x * x + y * y) <= this.radius;
    }

    protected calculateBoundingBox() {
        this.boundingBox = {
            x: this.x - this.radius,
            y: this.y - this.radius,
            width: this.radius * 2,
            height: this.radius * 2,
        };
    }
}