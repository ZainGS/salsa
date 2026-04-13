import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { InteractionService } from "../../services/interaction-service";
import { RGBA } from "../../types/rgba";
import { Rectangle } from "../shapes/rectangle";
import { Circle } from "../shapes/circle";
import { Triangle } from "../shapes/triangle";
import { InvertedTriangle } from "../shapes/inverted-triangle";
import { Diamond } from "../shapes/diamond";
import { Polygon, PolygonPreset } from "../shapes/polygon";
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
import { Stamp } from "../shapes/stamp";
import { SpeechBalloon, SpeechBalloonOptions } from "../shapes/speech-balloon";
import { PanelLayout, PanelLayoutOptions } from "../shapes/panel-layout";
import { LiveTextNode, LiveTextOptions } from "../shapes/live-text";

// Example: ShapeFactory could be responsible for creating shapes with all dependencies properly set
export class ShapeFactory {
    private _interactionService: InteractionService;
    private _cacheService: CacheService;

    constructor(interactionService: InteractionService, cacheService: CacheService) {
        this._interactionService = interactionService;
        this._cacheService = cacheService;
    }

    positionCheck(x: number, y: number): [number, number] {
        if (x == null || y == null) {
            const center = this._interactionService.getViewportCenter();
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

    createPattern(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number, textureKey: string, device: GPUDevice) {
        return new Pattern(x1, y1, x2, y2, strokeColor, strokeWidth, this._interactionService, textureKey);
    }

    public createScribble(x: number, y: number, strokeColor: RGBA, strokeWidth: number): Scribble {
        return new Scribble(x, y, strokeColor, strokeWidth, this._interactionService);
    }

    public createHighlight(x: number, y: number, strokeColor: RGBA, strokeWidth: number): Highlight {
        return new Highlight(x, y, strokeColor, strokeWidth, this._interactionService);
    }

    createStamp(
        x: number, 
        y: number, 
        width: number, 
        height: number, 
        textureKey: string,
        fillColor: RGBA
    ): Stamp {
        return new Stamp(x, y, width, height, textureKey, this._interactionService, fillColor);
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

    /**
     * Create a regular polygon (equilateral) centered at (x, y).
     * Points are generated in local space centered at (0,0); x/y set via shape position.
     */
    createRegularPolygon(
        x: number, y: number, radius: number, sides: number,
        fillColor: RGBA, strokeColor: RGBA, strokeWidth: number
    ): Polygon {
        const points = ShapeFactory.generateRegularPolygonPoints(radius, sides);
        const polygon = new Polygon(points, fillColor, strokeColor, strokeWidth, this._interactionService);
        polygon.x = x;
        polygon.y = y;
        polygon.finalizeInitialization();
        return polygon;
    }

    /**
     * Create a polygon from a preset name, scaled to width × height, centered at (x, y).
     */
    createPresetPolygon(
        x: number, y: number, width: number, height: number,
        preset: PolygonPreset, fillColor: RGBA, strokeColor: RGBA, strokeWidth: number
    ): Polygon {
        const points = ShapeFactory.generatePresetPoints(preset, width, height);
        const polygon = new Polygon(points, fillColor, strokeColor, strokeWidth, this._interactionService);
        polygon.x = x;
        polygon.y = y;
        polygon.presetTag = preset;
        polygon.finalizeInitialization();
        return polygon;
    }

    // ── Static helpers ──────────────────────────────────────────────

    /** Generate N equidistant points around a circle of given radius. */
    static generateRegularPolygonPoints(radius: number, sides: number): { x: number; y: number }[] {
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < sides; i++) {
            // Start from the top (-π/2) so the first vertex is at 12 o'clock
            const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
            pts.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
        }
        return pts;
    }

    /** Generate points for preset polygon shapes, scaled to width × height and centered at (0,0). */
    static generatePresetPoints(preset: PolygonPreset, w: number, h: number): { x: number; y: number }[] {
        const hw = w / 2, hh = h / 2;
        switch (preset) {
            case 'parallelogram': {
                const skew = w * 0.2;
                return [
                    { x: -hw + skew, y: -hh }, { x: hw,        y: -hh },
                    { x: hw - skew,  y: hh  }, { x: -hw,       y: hh  },
                ];
            }
            case 'trapezoid': {
                const inset = w * 0.15;
                return [
                    { x: -hw + inset, y: -hh }, { x: hw - inset, y: -hh },
                    { x: hw,          y: hh  }, { x: -hw,        y: hh  },
                ];
            }
            case 'arrowRight': {
                const shaft = hh * 0.4;
                const head = hw * 0.4;
                return [
                    { x: -hw,        y: -shaft }, { x: hw - head, y: -shaft },
                    { x: hw - head,  y: -hh    }, { x: hw,        y: 0      },
                    { x: hw - head,  y: hh     }, { x: hw - head, y: shaft  },
                    { x: -hw,        y: shaft  },
                ];
            }
            case 'chevron': {
                const depth = w * 0.2;
                return [
                    { x: -hw,         y: -hh }, { x: hw - depth, y: -hh },
                    { x: hw,          y: 0   }, { x: hw - depth, y: hh  },
                    { x: -hw,         y: hh  }, { x: -hw + depth,y: 0   },
                ];
            }
            case 'star5': {
                return ShapeFactory.generateStarPoints(5, hw, hw * 0.4);
            }
            case 'star6': {
                return ShapeFactory.generateStarPoints(6, hw, hw * 0.5);
            }
            case 'cross': {
                const arm = Math.min(hw, hh) * 0.33;
                return [
                    { x: -arm, y: -hh  }, { x: arm,  y: -hh  },
                    { x: arm,  y: -arm }, { x: hw,   y: -arm },
                    { x: hw,   y: arm  }, { x: arm,  y: arm  },
                    { x: arm,  y: hh   }, { x: -arm, y: hh   },
                    { x: -arm, y: arm  }, { x: -hw,  y: arm  },
                    { x: -hw,  y: -arm }, { x: -arm, y: -arm },
                ];
            }
            case 'speechBubble': {
                // Rounded-ish rectangle with a tail at bottom-left
                const tailW = w * 0.1, tailH = h * 0.2;
                return [
                    { x: -hw,            y: -hh },
                    { x: hw,             y: -hh },
                    { x: hw,             y: hh - tailH },
                    { x: -hw + tailW * 3,y: hh - tailH },
                    { x: -hw + tailW,    y: hh },          // tail tip
                    { x: -hw + tailW * 2,y: hh - tailH },
                    { x: -hw,            y: hh - tailH },
                ];
            }
            default:
                // Fallback: regular hexagon
                return ShapeFactory.generateRegularPolygonPoints(Math.min(hw, hh), 6);
        }
    }

    /** Generate a star with `points` outer tips. */
    private static generateStarPoints(points: number, outerR: number, innerR: number): { x: number; y: number }[] {
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < points * 2; i++) {
            const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
            const r = i % 2 === 0 ? outerR : innerR;
            pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
        }
        return pts;
    }

    public createSDFText(x: number, y: number, text: string, fontSize: number, sdfAtlas: SDFTextAtlas, fillColor: RGBA, font: string = "Arial"): SDFText {
        const sdfText = new SDFText(text, fontSize, sdfAtlas, fillColor, this._interactionService, font);
        sdfText.x = x;
        sdfText.y = y;
        return sdfText;
    }

    public createStickyNote(x: number, y: number, text = "New note", color = {r:1,g:.98,b:.65,a:1}, signatureText?: string, font?: string, fontSize?: number, lineHeight?: number): StickyNote {
        const note = new StickyNote(this._interactionService, this._cacheService, text, color, signatureText, font, fontSize, lineHeight);
        note.x = x; note.y = y;
        note.updateLocalMatrix();
        return note;
    }

    public createSpeechBalloon(x: number, y: number, options?: SpeechBalloonOptions): SpeechBalloon {
        const balloon = new SpeechBalloon(this._interactionService, this._cacheService, options);
        balloon.x = x; balloon.y = y;
        balloon.updateLocalMatrix();
        return balloon;
    }

    public createLiveText(x: number, y: number, options?: LiveTextOptions): LiveTextNode {
        const node = new LiveTextNode(this._interactionService, options);
        node.x = x;
        node.y = y;
        node.finalizeInitialization();
        return node;
    }

    public createPanelLayout(x: number, y: number, pageWidth: number, pageHeight: number, options?: PanelLayoutOptions): PanelLayout {
        const layout = new PanelLayout(this._interactionService, pageWidth, pageHeight, options);
        layout.x = x; layout.y = y;
        layout.updateLocalMatrix();
        return layout;
    }
}