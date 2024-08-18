// src/scene-graph/canvas-shape.ts
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';

export class CanvasShape extends Shape {
    private ctx: CanvasRenderingContext2D;

    constructor(renderStrategy: RenderStrategy, ctx: CanvasRenderingContext2D, fillColor: RGBA = {r:0,g:0,b:0,a:0}, strokeColor: RGBA = {r:0,g:0,b:0,a:1}, strokeWidth: number = 1) {
        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this.ctx = ctx;
    }

    protected getScaleFactors(): [number, number] {
        return [1, 1];
    }
}