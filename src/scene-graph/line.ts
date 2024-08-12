// src/scene-graph/line.ts
// Represents a line between two points.

import { RenderStrategy } from '../renderer/render-strategy';
import { Shape } from './shape';

export class Line extends Shape {
    private _startX: number;
    private _startY: number;
    private _endX: number;
    private _endY: number;

    constructor(renderStrategy: RenderStrategy, startX: number, startY: number, endX: number, endY: number, strokeColor: string = 'black', strokeWidth: number = 1) {
        super(renderStrategy, 'transparent', strokeColor, strokeWidth);
        this._startX = startX;
        this._startY = startY;
        this._endX = endX;
        this._endY = endY;
    }

    // Getter methods for startX, startY, endX, and endY
    get startX(): number {
        return this._startX;
    }

    get startY(): number {
        return this._startY;
    }

    get endX(): number {
        return this._endX;
    }

    get endY(): number {
        return this._endY;
    }

    containsPoint(x: number, y: number): boolean {
        // Simple point-line distance check (placeholder logic)
        const dx = this._endX - this._startX;
        const dy = this._endY - this._startY;
        const len = Math.sqrt(dx * dx + dy * dy);
        const distance = Math.abs(dy * x - dx * y + this.endX * this.startY - this.endY * this.startX) / len;
        return distance < this._strokeWidth / 2;
    }

    protected calculateBoundingBox() {
        const minX = Math.min(this._startX, this._endX);
        const minY = Math.min(this._startY, this._endY);
        const maxX = Math.max(this._startX, this._endX);
        const maxY = Math.max(this._startY, this._endY);

        this.boundingBox = {
            x: this.x + minX,
            y: this.y + minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }

}