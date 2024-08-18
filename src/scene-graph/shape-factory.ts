import { RenderStrategy } from "../renderer/render-strategies/render-strategy";
import { InteractionService } from "../services/interaction-service";
import { RGBA } from "../types/rgba";
import { Rectangle } from "./shapes/rectangle";
import { Circle } from "./shapes/circle";
import { Triangle } from "./shapes/triangle";
import { InvertedTriangle } from "./shapes/inverted-triangle";
import { Diamond } from "./shapes/diamond";
import { Polygon } from "./shapes/polygon";

// Example: ShapeFactory could be responsible for creating shapes with all dependencies properly set
export class ShapeFactory {
    private _interactionService: InteractionService;
    private renderStrategy: RenderStrategy;

    constructor(interactionService: InteractionService, renderStrategy: RenderStrategy) {
        this._interactionService = interactionService;
        this.renderStrategy = renderStrategy;
    }

    createRectangle(width: number, height: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        console.log("WIDTH: " + width);
        console.log("HEIGHT: " + height);
        const rect = new Rectangle(
            this.renderStrategy, 
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

    createCircle(radius: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        const circle = new Circle(
            this.renderStrategy, 
            radius, 
            fillColor, 
            strokeColor, 
            strokeWidth, 
            this._interactionService
        );
        circle.finalizeInitialization();
        return circle;
    }

    createTriangle(width: number, height: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        const triangle = new Triangle(
            this.renderStrategy, 
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

    createInvertedTriangle(width: number, height: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        const invertedTriangle = new InvertedTriangle(
            this.renderStrategy, 
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

    createDiamond(width: number, height: number, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        const diamond = new Diamond(
            this.renderStrategy, 
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