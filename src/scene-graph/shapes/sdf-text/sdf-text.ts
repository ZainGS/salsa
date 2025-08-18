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

    public caretVisible = false;
    public caretIndex = 0;
    private _blinkTimer?: number;
    // local (px) caret boundaries between glyphs, including start-of-line and after each glyph
    private caretPositions: { xPx: number; yPx: number; heightPx: number }[] = [];

    public align: 'left'|'center'|'right' = 'left';
    public valign: 'top'|'middle'|'bottom' = 'top';
    public onChange?: () => void;

    private maxWidthPx: number | undefined; // undefined means no wrapping
    private measuredPx: { width: number; height: number } = { width: 0, height: 0 };
    public focusCaret = this.beginTyping.bind(this);

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

    // world units -> px
    public setMaxWidth(worldUnits: number) {
        if (worldUnits <= 0 || !isFinite(worldUnits)) {
            this.maxWidthPx = undefined;
        } else {
            this.maxWidthPx = worldUnits / this.pxToWorldX;
        }
        this.refreshText(); // recompute glyph quads + caret
    }

    // world units
    public getMeasuredSize() {
        return {
            width:  this.measuredPx.width  * this.pxToWorldX,
            height: this.measuredPx.height * Math.abs(this.pxToWorldY)
        };
    }

    public beginTyping() {
        this.isTyping = true;
        this.caretVisible = true;
        this.caretIndex = this.text.length;
        if (!this._blinkTimer) {
            this._blinkTimer = window.setInterval(() => {
            this.caretVisible = !this.caretVisible;
            this.isDirty = true; // make sure a frame runs so caret toggles
            this._interactionService.requestRender();
            }, 500);
        }
        }

    public endTyping() {
        this.isTyping = false;
        this.caretVisible = false;
        if (this._blinkTimer) { clearInterval(this._blinkTimer); this._blinkTimer = undefined; }
        this.isDirty = true;
    }

    // Sum advances to caret (we keep caret at end for now)
    private computeCaretXPx(): number {
        let penX = 12;
        for (const ch of this.text) {
            if (ch === '\n') { penX = 0; continue; }
            const g = this.sdfAtlas.addCharacter(ch, this.fontSize, this.font);
            penX += g.advance;
        }
        return penX;
    }

        /** Caret rect in LOCAL coordinates (world units), same basis as glyphs */
    public getCaretRect() {
        const x = this.computeCaretXPx() * this.pxToWorldX;
        return {
            x,
            y: -.0525, // local Y=0 is top
            height: this.boundingBox.height*1.1, // already in world units (positive)
            thickness: 0.0075 // tweak if too thin
        };
    }

    private generateGlyphQuads() {
    this.glyphQuads = [];
    this.caretPositions = [];

    let penX = 0, penY = 0;
    const lineStep = this.fontSize * (this.lineHeight * 3);
    const maxW = this.maxWidthPx; // px, may be undefined

    const adv = (ch: string) => this.sdfAtlas.addCharacter(ch, this.fontSize, this.font).advance;

    const pushGlyph = (ch: string) => {
        const g = this.sdfAtlas.addCharacter(ch, this.fontSize, this.font);
        this.glyphQuads.push({
        x: penX + g.bearingX,
        y: penY - g.bearingY,
        width: g.width,
        height: g.height,
        atlasX: g.atlasX,
        atlasY: g.atlasY,
        atlasWidth: g.width,
        atlasHeight: g.height
        });
        penX += g.advance;
        this.caretPositions.push({ xPx: penX, yPx: penY, heightPx: lineStep });
    };

    const newline = () => {
        penX = 0;
        penY += lineStep;
        this.caretPositions.push({ xPx: penX, yPx: penY, heightPx: lineStep });
    };

    // caret at start of first line
    this.caretPositions.push({ xPx: penX, yPx: penY, heightPx: lineStep });

    // --- Wrap with fallback ---
    const tokens = this.text.split(/(\s+)/); // keep spaces tokens
    for (const tok of tokens) {
        if (tok === '\n') { newline(); continue; }

        // spaces: collapse if at line start
        if (/\s+/.test(tok)) {
        const spaceW = adv(' ');
        const total = spaceW * tok.length;
        if (!maxW || penX === 0 || penX + total <= maxW) {
            for (let i = 0; i < tok.length; i++) pushGlyph(' ');
        } else {
            newline();
        }
        continue;
    }

    // 1) Try word-fit if wrapping: move to next line before placing word
    let wordWidth = 0;
    for (const ch of tok) wordWidth += adv(ch);
    if (maxW && penX > 0 && penX + wordWidth > maxW) {
      newline();
    }

    // 2) Place characters, breaking mid-word if needed
    for (const ch of tok) {
      const a = adv(ch);
      if (maxW && penX > 0 && penX + a > maxW) {
        newline();
      }
      pushGlyph(ch);
    }
  }

  // measure
  let maxX = 0, maxY = 0;
  for (const q of this.glyphQuads) {
    if (q.x + q.width > maxX) maxX = q.x + q.width;
    if (q.y + q.height > maxY) maxY = q.y + q.height;
  }
  if (this.caretPositions.length) {
    const last = this.caretPositions[this.caretPositions.length - 1];
    if (last.xPx > maxX) maxX = last.xPx;
    if (last.yPx + lineStep > maxY) maxY = last.yPx + lineStep;
  }

  this.measuredPx = { width: Math.max(0, maxX), height: Math.max(0, maxY) };
  this.calculateBoundingBox();  // uses px→world
}


    public getGeometryVertices(): Float32Array {
        const verts: number[] = [];
        const atlasSize = this.sdfAtlas.getAtlasSize();

        // half-texel inset (in atlas texels)
        const inset = 6; // 6px inset in atlas texels (3px on each side)

        for (const q of this.glyphQuads) {
            const xL =  q.x               * this.pxToWorldX;
            const xR = (q.x + q.width)    * this.pxToWorldX;
            const yT =  q.y               * this.pxToWorldY; // top
            const yB = (q.y + q.height)   * this.pxToWorldY; // bottom

            // q.atlasX/Y already point to the INNER rect (start after gutter)
            const uL = (q.atlasX + inset) / atlasSize;
            const vT = (q.atlasY + inset) / atlasSize;
            const uR = (q.atlasX + q.atlasWidth  - inset) / atlasSize;
            const vB = (q.atlasY + q.atlasHeight - inset) / atlasSize;

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
  const wPx = this.measuredPx.width;
  const hPx = this.measuredPx.height;
  this.boundingBox = {
    x: 0,
    y: 0,
    width:  wPx * this.pxToWorldX,
    height: hPx * -this.pxToWorldY // positive world height
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
    this.refreshText();
    this.isDirty = true;
    this.onChange?.();
    return;
  }
  // even if same, still refresh for safety
  this.refreshText();
  this.onChange?.();
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