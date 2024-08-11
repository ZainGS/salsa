// Rectangle.ts
import { Node } from './node';

export class Rectangle extends Node {
    public width: number;
    public height: number;
    public fillColor: string;
    public strokeColor: string;
    public strokeWidth: number;

    constructor(width: number, height: number, fillColor: string = 'black', strokeColor: string = 'black', strokeWidth: number = 0) {
        super();
        this.width = width;
        this.height = height;
        this.fillColor = fillColor;
        this.strokeColor = strokeColor;
        this.strokeWidth = strokeWidth;
    }

    draw(ctx: CanvasRenderingContext2D) {
        ctx.fillStyle = this.fillColor;
        ctx.fillRect(0, 0, this.width, this.height);

        if (this.strokeWidth > 0) {
            ctx.strokeStyle = this.strokeColor;
            ctx.lineWidth = this.strokeWidth;
            ctx.strokeRect(0, 0, this.width, this.height);
        }
    }
}