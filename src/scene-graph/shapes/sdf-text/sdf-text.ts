import { mat4, vec3, vec4 } from "gl-matrix";
import { InteractionService } from "../../../services/interaction-service";
import { RGBA } from "../../../types/rgba";
import { Shape } from "../base/shape";
import { SDFTextAtlas } from "./sdf-text-atlas";

export class SDFText extends Shape {
    public text: string;
    public font: string;
    public fontSize: number = 12;
    private sdfAtlas: SDFTextAtlas;
    private glyphQuads: GlyphQuad[] = [];
    public sdfThreshold: number = 0.5;
    public outlineColor: RGBA = {r: 1, g:1, b:1, a:0};
    public smoothing: number=  10;
    public outlineWidth: number = 0;
    public isTyping: boolean = false;
    private pxToWorldX: number;
    private pxToWorldY: number;
    public lineHeight = 1.5;

    constructor(
        text: string,
        fontSize: number = 16,
        sdfAtlas: SDFTextAtlas,
        color: RGBA = { r: 0, g: 0, b: 0, a: 1 },
        interactionService: InteractionService,
        font: string = 'Arial'
    ) {
        super(color, { r: 0, g: 0, b: 0, a: 0 }, 1, interactionService);

        this.pxToWorldX =  2.0 / this._interactionService.canvas.width;
        this.pxToWorldY =  1.0 / this._interactionService.canvas.height;

        this.text = text;
        this.fontSize = fontSize;
        this.font = font;
        this.sdfAtlas = sdfAtlas;

        this.localMatrix = mat4.create();
        // mat4.scale(this.localMatrix, this.localMatrix, [this.pxToWorld, this.pxToWorld, 1]);

        this.generateGlyphQuads();
    }

    private generateGlyphQuads() {
        this.glyphQuads = [];

        let penX = 0, penY = 0;
        const lineStep = this.fontSize * (this.lineHeight*3);

        for (const ch of this.text) {
            if (ch === '\n') { // next line
            penX = 0;
            penY += lineStep;
            continue;
            }

            const g = this.sdfAtlas.addCharacter(ch, this.fontSize, this.font);

            this.glyphQuads.push({
                x: penX + g.bearingX,
                y: penY - g.bearingY, // pixel space (+Y down)
                width      : g.width,
                height     : g.height,
                atlasX     : g.atlasX,
                atlasY     : g.atlasY,
                atlasWidth : g.width,
                atlasHeight: g.height
            });

            penX += g.advance;
        }

        this.calculateBoundingBox();
    }


    public getGeometryVertices(): Float32Array {
        const verts: number[] = [];
        const atlasSize = this.sdfAtlas.getAtlasSize();

        for (const q of this.glyphQuads) {
            const xL =  q.x               * this.pxToWorldX;
            const xR = (q.x + q.width)    * this.pxToWorldX;
            const yT =  q.y               * this.pxToWorldY; // top
            const yB = (q.y + q.height)   * this.pxToWorldY; // bottom

            const uL =  q.atlasX / atlasSize;
            const vT =  q.atlasY / atlasSize;
            const uR = (q.atlasX + q.atlasWidth ) / atlasSize;
            const vB = (q.atlasY + q.atlasHeight) / atlasSize;

            verts.push(
                xL, yB, uL, vB,   // BL
                xR, yB, uR, vB,   // BR
                xL, yT, uL, vT,   // TL
                xR, yT, uR, vT    // TR
            );
        }
        return new Float32Array(verts);
    }

    calculateBoundingBox() {
        if (!this.glyphQuads.length) {
            this.boundingBox = { x: 0, y: 0, width: 0, height: 0 };
            return;
        }

        let maxX = 0, maxY = 0;
        for (const q of this.glyphQuads) {
            maxX = Math.max(maxX, q.x + q.width);
            maxY = Math.max(maxY, q.y + q.height);
        }

        this.boundingBox = {
            x: 0,
            y: 0,                            // top = 0
            width :  maxX * this.pxToWorldX, // positive
            height:  maxY * -this.pxToWorldY // positive
        };
    }

    public override getWorldSpaceBoundingBoxPolygon(): [number, number][] {
        const x0 = 0;
        const x1 = this.boundingBox.width;
        const y0 = 0;                       // top
        const y1 = this.boundingBox.height; // bottom

        const pts = [
            vec4.fromValues(x0, y0, 0, 1),  // TL
            vec4.fromValues(x1, y0, 0, 1),  // TR
            vec4.fromValues(x1, y1, 0, 1),  // BR
            vec4.fromValues(x0, y1, 0, 1)   // BL
        ];

        return pts.map(p => {
            const out = vec4.create();
            vec4.transformMat4(out, p, this.localMatrix);
            return [out[0], out[1]];
        });
    }

    override getBoundingBoxVertices(thickness: number): Float32Array {
        const w = this.boundingBox.width;
        const h = -this.boundingBox.height;

        return new Float32Array([
            // outer
            -thickness,          +thickness,
            w + thickness,      +thickness,
            -thickness,          -(h + thickness),
            w + thickness,      -(h + thickness),

            // inner
            0, 0,
            w, 0,
            0, -h,
            w, -h
        ]);
    }

    protected getScaleFactors(): [number, number] {
        // Return scale factors for the text - similar to Text class
        return [1, 1];
    }

    getType(): string {
        return "SDFText";
    }

    public getGeometryIndices(): Uint16Array {
        if (this.cachedIndices) return this.cachedIndices;
        
        // Generate indices for all glyph quads (each quad = 2 triangles = 6 indices)
        const indices: number[] = [];
        
        for (let i = 0; i < this.glyphQuads.length; i++) {
            const baseIndex = i * 4; // Each quad has 4 vertices
            
            // First triangle (bottom-left, bottom-right, top-left)
            indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
            // Second triangle (top-left, bottom-right, top-right)
            indices.push(baseIndex + 2, baseIndex + 1, baseIndex + 3);
        }
        
        this.cachedIndices = new Uint16Array(indices);
        return this.cachedIndices;
    }

    // Override containsPoint to work with SDF text bounds
    public containsPoint(worldX: number, worldY: number): boolean {
        // world to local
        const local = vec3.transformMat4(
            vec3.create(),
            vec3.fromValues(worldX, worldY, 0),
            mat4.invert(mat4.create(), this.localMatrix)
        );

        return (
            local[0] >= 0 && local[0] <= this.boundingBox.width  &&
            local[1] <= 0 && local[1] >= this.boundingBox.height
        );
    }

    public setText(newText: string) {
        if (this.text !== newText) {
            this.text = newText;
        }
        this.refreshText();
    }

    public refreshText() {
        this.generateGlyphQuads();
        this.clearGeometryCache();
    }

    /** Matrix uploaded to the SDF-text pipeline from the ucache
     *  (own scale removed so glyphs keep a fixed pixel size) */
    public getRenderLocalMatrix(out: mat4 = mat4.create()): mat4 {
        mat4.copy(out, this.localMatrix);
        // premultiply by inverse of this shape’s scale
        const invScale = mat4.fromScaling(mat4.create(),
            [1 / this.scaleX, 1 / this.scaleY, 1]);
        mat4.mul(out, out, invScale);

        return out; // Float32Array<16>
    }

    /**  Serialize only the data needed to recreate the node.
     *   Heavy runtime-only fields (glyphQuads, atlas handles, caches) are omitted
     *   because they are rebuilt on setText() / refreshText() after load.
     */
    public toJSON() {
        return {
            // common shape fields (id, x, y, scale, rotation, etc.)
            ...super.toJSON(),

            // class-specific metadata
            type         : this.getType(),
            text         : this.text,
            font         : this.font,
            fontSize     : this.fontSize,
            lineHeight   : this.lineHeight,

            // visual tuning
            strokeColor  : this.strokeColor,
            outlineColor : this.outlineColor,
            outlineWidth : this.outlineWidth,
            sdfThreshold : this.sdfThreshold,
            smoothing    : this.smoothing
        };
    }
}