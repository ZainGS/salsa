// src/scene-graph/diamond.ts
// Represents a diamond with a specific width, height, fill color, and stroke.

import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class Diamond extends Shape {
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

    containsPoint(px: number, py: number): boolean {
        // Calculate the center of the diamond
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
    
        // Calculate the absolute distances from the point to the center
        const dx = Math.abs(px - centerX);
        const dy = Math.abs(py - centerY);
    
        // Calculate the height-to-width ratio
        const h2w = this.height / this.width;
    
        // For a point to be inside the diamond:
        // dx / (width / 2) + dy / (height / 2) <= 1
        return (dx / (this.width / 2) + dy / (this.height / 2)) <= 1;
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