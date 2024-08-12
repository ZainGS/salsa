// src/scene-graph/rectangle.ts
// Represents a rectangle with a specific width, height, fill color, and stroke.

import { Shape } from './shape';

export class Rectangle extends Shape {
    private width: number;
    private height: number;

    constructor(width: number, height: number, fillColor: string = 'transparent', strokeColor: string = 'black', strokeWidth: number = 1) {
        super(fillColor, strokeColor, strokeWidth);
        this.width = width;
        this.height = height;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    draw(ctx: CanvasRenderingContext2D) {
        if (this.isDirty) {
            if (this._fillColor !== 'transparent') {
                ctx.fillStyle = this._fillColor;
                ctx.fillRect(0, 0, this.width, this.height);
            }

            if (this._strokeWidth > 0) {
                ctx.strokeStyle = this._strokeColor;
                ctx.lineWidth = this._strokeWidth;
                ctx.strokeRect(0, 0, this.width, this.height);
            }
            this.isDirty = false;
        }
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