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
import { Highlight } from "../shapes/highlight";
import { Text } from "../shapes/text";
import { Pattern } from "../shapes/pattern";
import { Section } from "../shapes/section";
import { Group } from "../shapes/base/group";
import { Shape } from "../shapes/base/shape";
import { SDFText } from "../shapes/sdf-text/sdf-text";
import { SDFTextAtlas } from "../shapes/sdf-text/sdf-text-atlas";
import { StickyNote } from "../shapes/sticky-note";
import { CacheService } from "../../services/cache-service";

// Example: ShapeFactory could be responsible for creating shapes with all dependencies properly set
export class ShapeFactory {
    private _interactionService: InteractionService;
    private _cacheService: CacheService;

    constructor(interactionService: InteractionService, cacheService: CacheService) {
        this._interactionService = interactionService;
        this._cacheService = cacheService;
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
        return new Line(x1, y1, x2, y2, strokeColor, strokeWidth, this._interactionService);
    }

    createPattern(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number, pattern: string, device: GPUDevice) {
        return new Pattern(x1, y1, x2, y2, strokeColor, strokeWidth, this._interactionService, pattern, device);
    }

    public createScribble(x: number, y: number, strokeColor: RGBA, strokeWidth: number): Scribble {
        return new Scribble(x, y, strokeColor, strokeWidth, this._interactionService);
    }

    public createHighlight(x: number, y: number, strokeColor: RGBA, strokeWidth: number): Highlight {
        return new Highlight(x, y, strokeColor, strokeWidth, this._interactionService);
    }

    createGroup(
        children: Shape[] = [],
        fillColor: RGBA = { r: 0, g: 0, b: 0, a: 0 },
        strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 0 },
        strokeWidth: number = 1
    ): Group {
        const group = new Group(
            this._interactionService,
            fillColor,
            strokeColor,
            strokeWidth
        );

        // Add children to the group
        children.forEach(child => {
            group.addChild(child);
        });

        // Recalculate group size after adding children
        group.recalculateSize();
        group.finalizeInitialization();
        
        return group;
    }

    createSection(
        x: number,
        y: number,
        width: number,
        height: number,
        fillColor: RGBA,
        strokeColor: RGBA,
        strokeWidth: number
    ) {
        [x, y] = this.positionCheck(x, y);
        const section = new Section(
            x,
            y,
            width,
            height,
            fillColor,
            strokeColor,
            strokeWidth,
            this._interactionService
        );
        section.finalizeInitialization();
        return section;
    }

    public createText(x: number, y: number, text: string, font: string, fillColor: RGBA, device: GPUDevice): Text {
        const textShape = new Text(
            text,
            font,
            fillColor,
            "left",
            "alphabetic",
            1,
            this._interactionService,
            device
        );
        textShape.x = x;
        textShape.y = y;
        textShape.updateTexture(); // Ensure texture is created
        return textShape;
    }
    

    // FIX THIS to have an x,y origin/center...
    createPolygon(points: { x: number; y: number }[], fillColor: RGBA, strokeColor: RGBA, strokeWidth: number) {
        const polygon = new Polygon(
            
            points, 
            fillColor, 
            strokeColor, 
            strokeWidth, 
            this._interactionService
        );
        polygon.finalizeInitialization();
        return polygon;
    }

    public createSDFText(x: number, y: number, text: string, fontSize: number, sdfAtlas: SDFTextAtlas, fillColor: RGBA, font: string = "Arial"): SDFText {
        const sdfText = new SDFText(text, fontSize, sdfAtlas, fillColor, this._interactionService, font);
        sdfText.x = x;
        sdfText.y = y;
        return sdfText;
    }

    public createStickyNote(x: number, y: number, text = "New note", color = {r:1,g:.98,b:.65,a:1}, signatureText?: string): StickyNote {
        const note = new StickyNote(this._interactionService, this._cacheService, text, color, signatureText);
        note.x = x; note.y = y;
        note.updateLocalMatrix();
        return note;
    }
}