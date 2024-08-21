// src/scene-graph/text.ts
import { RenderStrategy } from '../renderer/render-strategies/render-strategy';
import { RGBA } from '../types/rgba';
import { rgbaToCssString } from '../utils/color';
import { Shape } from './shapes/shape';

export class Text extends Shape {
    private text: string;
    private font: string;
    private textAlign: CanvasTextAlign;
    private textBaseline: CanvasTextBaseline;

    constructor(
        renderStrategy: RenderStrategy, 
        text: string,
        font: string = '16px Arial',
        color: RGBA = {r: 0, g: 0, b: 0, a: 1},
        textAlign: CanvasTextAlign = 'left',
        textBaseline: CanvasTextBaseline = 'alphabetic'
    ) {
        super(renderStrategy, color, {r: 0, g: 0, b: 0, a: 0});
        this.text = text;
        this.font = font;
        this.textAlign = textAlign;
        this.textBaseline = textBaseline;
    }

    protected getScaleFactors(): [number, number] {
        return [1, 1];
    }

    draw(ctx: CanvasRenderingContext2D) {
        ctx.font = this.font;
        ctx.fillStyle = rgbaToCssString(this._fillColor);
        ctx.textAlign = this.textAlign;
        ctx.textBaseline = this.textBaseline;
        ctx.fillText(this.text, 0, 0);
    }

    containsPoint(x: number, y: number): boolean {
        // Placeholder logic for hit detection on text (can be more complex)
        x = x;
        y = y;
        return false;
    }
}