// src/scene-graph/polygon.ts
// Represents a polygon defined by a series of points.

import { Shape } from './shape';

export class Polygon extends Shape {
    private points: { x: number; y: number }[];

    constructor(points: { x: number; y: number }[], fillColor: string = 'transparent', strokeColor: string = 'black', strokeWidth: number = 1) {
        super(fillColor, strokeColor, strokeWidth);
        this.points = points;
    }

    draw(ctx: CanvasRenderingContext2D) {
        if (this.points.length < 2) return;

        ctx.beginPath();
        ctx.moveTo(this.points[0].x, this.points[0].y);

        for (let i = 1; i < this.points.length; i++) {
            ctx.lineTo(this.points[i].x, this.points[i].y);
        }

        ctx.closePath();

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
        // Basic point-in-polygon test (not very accurate but a placeholder)
        // More accurate algorithms can be implemented here
        let inside = false;
        for (let i = 0, j = this.points.length - 1; i < this.points.length; j = i++) {
            const xi = this.points[i].x, yi = this.points[i].y;
            const xj = this.points[j].x, yj = this.points[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    protected calculateBoundingBox() {
        const minX = Math.min(...this.points.map(p => p.x));
        const minY = Math.min(...this.points.map(p => p.y));
        const maxX = Math.max(...this.points.map(p => p.x));
        const maxY = Math.max(...this.points.map(p => p.y));

        this.boundingBox = {
            x: this.x + minX,
            y: this.y + minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }
}