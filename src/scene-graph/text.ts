// src/scene-graph/text.ts
import { RenderStrategy } from '../renderer/render-strategy';
import { Shape } from './shape';

export class Text extends Shape {
    private text: string;
    private font: string;
    private textAlign: CanvasTextAlign;
    private textBaseline: CanvasTextBaseline;

    constructor(
        renderStrategy: RenderStrategy, 
        text: string,
        font: string = '16px Arial',
        color: string = 'black',
        textAlign: CanvasTextAlign = 'left',
        textBaseline: CanvasTextBaseline = 'alphabetic'
    ) {
        super(renderStrategy, color, 'transparent');
        this.text = text;
        this.font = font;
        this.textAlign = textAlign;
        this.textBaseline = textBaseline;
    }

    draw(ctx: CanvasRenderingContext2D) {
        ctx.font = this.font;
        ctx.fillStyle = this._fillColor;
        ctx.textAlign = this.textAlign;
        ctx.textBaseline = this.textBaseline;
        ctx.fillText(this.text, 0, 0);
    }

    containsPoint(x: number, y: number): boolean {
        // Placeholder logic for hit detection on text (can be more complex)
        return false;
    }
}