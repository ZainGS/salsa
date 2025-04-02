// src/scene-graph/polygon.ts
// Represents a polygon defined by a series of points.

import { mat4, vec3 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';

export class Polygon extends Shape {
    private _points: { x: number; y: number }[];
    
    constructor(
        points: { x: number; y: number }[], 
        fillColor: RGBA = {r:0,g:0,b:0,a:0}, 
        strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
        strokeWidth: number = 1,
        interactionService: InteractionService
    ) {
        super(fillColor, strokeColor, strokeWidth, interactionService);
        this._points = points;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    protected getScaleFactors(): [number, number] {
        const minX = Math.min(...this._points.map(p => p.x));
        const minY = Math.min(...this._points.map(p => p.y));
        const maxX = Math.max(...this._points.map(p => p.x));
        const maxY = Math.max(...this._points.map(p => p.y));

        return [maxX-minX, maxY-minY];
    }

    get points() {
        return this._points;
    }

    containsPoint(x: number, y: number): boolean {
        const inverseLocalMatrix = mat4.create();
        if (!mat4.invert(inverseLocalMatrix, this.localMatrix)) return false;
    
        const localPoint = vec3.fromValues(x, y, 0);
        vec3.transformMat4(localPoint, localPoint, inverseLocalMatrix);
    
        let inside = false;
        for (let i = 0, j = this._points.length - 1; i < this._points.length; j = i++) {
            const xi = this._points[i].x;
            const yi = this._points[i].y;
            const xj = this._points[j].x;
            const yj = this._points[j].y;
    
            const intersect = ((yi > localPoint[1]) !== (yj > localPoint[1])) &&
                              (localPoint[0] < (xj - xi) * (localPoint[1] - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
    
        return inside;
    }

    protected calculateBoundingBox(): void {
        const minX = Math.min(...this._points.map(p => p.x));
        const minY = Math.min(...this._points.map(p => p.y));
        const maxX = Math.max(...this._points.map(p => p.x));
        const maxY = Math.max(...this._points.map(p => p.y));
    
        this._boundingBox = {
            x: this.x + minX,
            y: this.y + minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }

    getType(): string {
        return "Polygon";
    }

    public getGeometryVertices(): Float32Array {
        return new Float32Array(); // TODO
    }
    
    public getGeometryIndices(): Uint16Array | null {
        return null; // TODO
    }
}