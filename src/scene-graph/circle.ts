// Circle.ts
import { Node } from './node';

export class Circle extends Node {
    public radius: number;
    public fillColor: string;
    public strokeColor: string;
    public strokeWidth: number;

    constructor(radius: number, fillColor: string = 'black', strokeColor: string = 'black', strokeWidth: number = 0) {
        super();
        this.radius = radius;
        this.fillColor = fillColor;
        this.strokeColor = strokeColor;
        this.strokeWidth = strokeWidth;
    }

    draw(ctx: CanvasRenderingContext2D) {
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.closePath();

        ctx.fillStyle = this.fillColor;
        ctx.fill();

        if (this.strokeWidth > 0) {
            ctx.strokeStyle = this.strokeColor;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
    }
}