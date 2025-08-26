import { mat4, vec3 } from 'gl-matrix';
import { Shape } from './base/shape';
import { RGBA } from '../../types/rgba';
import { InteractionService } from '../../services/interaction-service';
import { Node } from '../shapes/base/node';

export class Section extends Shape {
    constructor(
        x: number,
        y: number,
        width: number,
        height: number,
        fillColor: RGBA = { r: 1, g: 1, b: 0.8, a: 0.3 }, // soft yellow transparent
        strokeColor: RGBA = { r: 0.9, g: 0.6, b: 0.1, a: 1 }, // orange border
        strokeWidth: number = 1,
        interactionService: InteractionService
    ) {
        super(fillColor, strokeColor, strokeWidth, interactionService);
        this.transformMode = "translate-only"
        this.width = width;
        this.height = height;
        this.x = x;
        this.y = y;
        this.scaleX = width;
        this.scaleY = height;
    }

    getType(): string { 
        return "Section";
    }

    protected getScaleFactors(): [number, number] {
        return [this.scaleX ?? this.width, this.scaleY ?? this.height];
    }

    containsPoint(x: number, y: number): boolean {
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, this.getInverseLocalMatrix());

        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;

        return (
            point[0] >= -halfWidth &&
            point[0] <= halfWidth &&
            point[1] >= -halfHeight &&
            point[1] <= halfHeight
        );
    }

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;

        const halfWidth = 0.5;
        const halfHeight = 0.5;

        const vertices = new Float32Array([
            -halfWidth, -halfHeight, // Bottom-left
             halfWidth, -halfHeight, // Bottom-right
            -halfWidth,  halfHeight, // Top-left
             halfWidth,  halfHeight  // Top-right
        ]);

        this.cachedVertices = vertices;
        return vertices;
    }

    public getGeometryIndices(): Uint16Array {
        if (this.cachedIndices) return this.cachedIndices;

        const indices = new Uint16Array([
            0, 1, 2,
            2, 1, 3
        ]);

        this.cachedIndices = indices;
        return indices;
    }

    public calculateBoundingBox() {
        const halfWidth = this.scaleX / 2;
        const halfHeight = this.scaleY / 2;
    
        this.boundingBox.x = this.x - halfWidth;
        this.boundingBox.y = this.y - halfHeight;
        this.boundingBox.width = this.scaleX;
        this.boundingBox.height = this.scaleY;
    }
}
