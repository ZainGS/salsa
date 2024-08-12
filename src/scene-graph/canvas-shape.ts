// src/scene-graph/canvas-shape.ts
import { RenderStrategy } from '../renderer/render-strategy';
import { Shape } from './shape';

export class CanvasShape extends Shape {
    private ctx: CanvasRenderingContext2D;

    constructor(renderStrategy: RenderStrategy, ctx: CanvasRenderingContext2D, fillColor: string = 'transparent', strokeColor: string = 'black', strokeWidth: number = 1) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this.ctx = ctx;
    }
}