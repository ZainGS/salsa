import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { InteractionService } from "../../services/interaction-service";
import { RGBA } from "../../types/rgba";
import { Rectangle } from "../shapes/rectangle";
import { Circle } from "../shapes/circle";
import { Triangle } from "../shapes/triangle";
import { InvertedTriangle } from "../shapes/inverted-triangle";
import { Diamond } from "../shapes/diamond";
import { Polygon } from "../shapes/polygon";
import { Line } from "../shapes/line";
import { Scribble } from "../shapes/scribble";
import { Text } from "../shapes/text";

// Example: ShapeFactory could be responsible for creating shapes with all dependencies properly set
export class ShapeFactory {
    private _interactionService: InteractionService;
    private renderStrategy: RenderStrategy;

    constructor(interactionService: InteractionService, renderStrategy: RenderStrategy) {
        this._interactionService = interactionService;
        this.renderStrategy = renderStrategy;
    }

    positionCheck(x: number, y: number): [number, number] {
        if (!x || !y || x==0 || y==0) {
            let center = this._interactionService.getViewportCenter();
            return [center[0], center[1]];
        }
        return [x, y];
    }

    createRectangle(x: number, y: number, width: number, height: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        [x, y] = this.positionCheck(x, y);
        const rect = new Rectangle(
            this.renderStrategy, 
            x,
            y,
            width, 
            height, 
            fillColor, 
            strokeColor, 
            strokeWidth, 
            this._interactionService
        );
        rect.finalizeInitialization(); // Ensure bounding box is calculated after full initialization
        return rect;
    }

    createCircle(x: number, y: number, radius: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        [x, y] = this.positionCheck(x, y);
        const circle = new Circle(
            this.renderStrategy, 
            x,
            y,
            radius, 
            fillColor, 
            strokeColor, 
            strokeWidth, 
            this._interactionService
        );
        circle.finalizeInitialization();
        return circle;
    }

    createTriangle(x: number, y: number, width: number, height: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        [x, y] = this.positionCheck(x, y);
        const triangle = new Triangle(
            this.renderStrategy, 
            x,
            y,
            width, 
            height, 
            fillColor, 
            strokeColor, 
            strokeWidth, 
            this._interactionService
        );
        triangle.finalizeInitialization();
        return triangle;
    }

    createInvertedTriangle(x: number, y: number, width: number, height: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        [x, y] = this.positionCheck(x, y);
        const invertedTriangle = new InvertedTriangle(
            this.renderStrategy, 
            x,
            y,
            width, 
            height, 
            fillColor, 
            strokeColor, 
            strokeWidth, 
            this._interactionService
        );
        invertedTriangle.finalizeInitialization();
        return invertedTriangle;
    }

    createDiamond(x: number, y: number, width: number, height: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        [x, y] = this.positionCheck(x, y);
        const diamond = new Diamond(
            this.renderStrategy, 
            x,
            y,
            width, 
            height, 
            fillColor, 
            strokeColor, 
            strokeWidth, 
            this._interactionService
        );
        diamond.finalizeInitialization();
        return diamond;
    }

    createLine(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number) {
        return new Line(this.renderStrategy, x1, y1, x2, y2, strokeColor, strokeWidth, this._interactionService);
    }

    public createScribble(x: number, y: number, strokeColor: RGBA, strokeWidth: number): Scribble {
        return new Scribble(this.renderStrategy, x, y, strokeColor, strokeWidth, this._interactionService);
    }

    public createText(x: number, y: number, text: string, font: string, strokeColor: RGBA): Text {
        const textShape = new Text(
            this.renderStrategy,
            text,
            font,
            strokeColor,
            "left",
            "alphabetic",
            1,
            this._interactionService
        );
        textShape.x = x;
        textShape.y = y;
        textShape.updateTexture(); // Ensure texture is created
        return textShape;
    }
    

    // FIX THIS to have an x,y origin/center...
    createPolygon(points: { x: number; y: number }[], fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        const polygon = new Polygon(
            this.renderStrategy, 
            points, 
            fillColor, 
            strokeColor, 
            strokeWidth, 
            this._interactionService
        );
        polygon.finalizeInitialization();
        return polygon;
    }
}