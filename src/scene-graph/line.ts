// src/scene-graph/line.ts
// Represents a line between two points.

import { Shape } from './shape';

export class Line extends Shape {
    private startX: number;
    private startY: number;
    private endX: number;
    private endY: number;

    constructor(startX: number, startY: number, endX: number, endY: number, strokeColor: string = 'black', strokeWidth: number = 1) {
        super('transparent', strokeColor, strokeWidth);
        this.startX = startX;
        this.startY = startY;
        this.endX = endX;
        this.endY = endY;
    }

    draw(ctx: CanvasRenderingContext2D) {
        ctx.beginPath();
        ctx.moveTo(this.startX, this.startY);
        ctx.lineTo(this.endX, this.endY);
        ctx.strokeStyle = this._strokeColor;
        ctx.lineWidth = this._strokeWidth;
        ctx.stroke();
    }

    containsPoint(x: number, y: number): boolean {
        // Simple point-line distance check (placeholder logic)
        const dx = this.endX - this.startX;
        const dy = this.endY - this.startY;
        const len = Math.sqrt(dx * dx + dy * dy);
        const distance = Math.abs(dy * x - dx * y + this.endX * this.startY - this.endY * this.startX) / len;
        return distance < this._strokeWidth / 2;
    }

    protected calculateBoundingBox() {
        const minX = Math.min(this.startX, this.endX);
        const minY = Math.min(this.startY, this.endY);
        const maxX = Math.max(this.startX, this.endX);
        const maxY = Math.max(this.startY, this.endY);

        this.boundingBox = {
            x: this.x + minX,
            y: this.y + minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }

}