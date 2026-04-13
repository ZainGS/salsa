import { mat4, vec3, vec4 } from "gl-matrix";
import { InteractionService } from "../../../services/interaction-service";
import { RGBA } from "../../../types/rgba";
import { Shape } from "../base/shape";
import { SDFTextAtlas } from "./sdf-text-atlas";

export class SDFText extends Shape {
    public text: string;
    public font: string;
    public fontSize: number = 120;
    private sdfAtlas: SDFTextAtlas;
    private glyphQuads: GlyphQuad[] = [];
    public sdfThreshold: number = 0.5;
    public outlineColor: RGBA = {r: 1, g:1, b:1, a:0};
    public smoothing: number=  10;
    public outlineWidth: number = 0;
    public isTyping: boolean = false;
    private pxToWorldX: number;
    private pxToWorldY: number;
    public lineHeight = 0.75;

    /**
     * Writing direction. 'horizontal-tb' is standard left-to-right.
     * 'vertical-rl' is top-to-bottom, right-to-left columns (manga style).
     */
    public writingMode: 'horizontal-tb' | 'vertical-rl' = 'horizontal-tb';

    public caretVisible = false;
    public caretIndex = 0;
    public selectionStart = -1;  // -1 = no selection
    public selectionEnd = -1;    // -1 = no selection
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
        fontSize: number = 160,
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
        this.selectionStart = -1;
        this.selectionEnd = -1;
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
        this.selectionStart = -1;
        this.selectionEnd = -1;
        if (this._blinkTimer) { clearInterval(this._blinkTimer); this._blinkTimer = undefined; }
        this.isDirty = true;
    }

    // Sum advances to caret (we keep caret at end for now)
    private computeCaretXPx(): number {
        let penX = 6;
        for (const ch of this.text) {
            if (ch === '\n') { penX = 0; continue; }
            const g = this.sdfAtlas.addCharacter(ch, this.fontSize, this.font);
            penX += g.advance;
        }
        return penX;
    }

    /** Caret rect in LOCAL coordinates (world units), same basis as glyphs */
    public getCaretRect() {
        return this.getCaretRectAtIndex(this.caretIndex);
    }

    /** Caret rect at a specific character index (0 = before first char) */
    public getCaretRectAtIndex(index: number) {
        const i = Math.max(0, Math.min(index, this.caretPositions.length - 1));
        if (this.caretPositions.length === 0) {
            return { x: 0, y: -.0325, height: this.boundingBox.height * 1.1, thickness: 0.0075 };
        }
        const pos = this.caretPositions[i];
        return {
            x: pos.xPx * this.pxToWorldX,
            y: pos.yPx * this.pxToWorldY - 0.0325,
            height: pos.heightPx * Math.abs(this.pxToWorldY) * 1.1,
            thickness: 0.0075
        };
    }

    /** Get the caret index nearest to a local-space X/Y position (in world units). */
    public getCaretIndexAtLocalPos(localX: number, localY: number): number {
        if (this.caretPositions.length === 0) return 0;
        const xPx = localX / this.pxToWorldX;
        const yPx = localY / this.pxToWorldY;

        // Find the line (row) closest to yPx
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < this.caretPositions.length; i++) {
            const cp = this.caretPositions[i];
            // vertical distance: are we on this line?
            const lineTop = cp.yPx;
            const lineBot = cp.yPx + cp.heightPx;
            let dy = 0;
            if (yPx < lineTop) dy = lineTop - yPx;
            else if (yPx > lineBot) dy = yPx - lineBot;
            const dx = Math.abs(xPx - cp.xPx);
            // Prioritize vertical match, then horizontal
            const dist = dy * 10000 + dx;
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        return bestIdx;
    }

    /** Get the caret index nearest to a world-space position. */
    public getCaretIndexAtWorldPos(worldX: number, worldY: number): number {
        const inv = mat4.create();
        if (!mat4.invert(inv, this.localMatrix)) return 0;
        const local = vec3.transformMat4(vec3.create(), vec3.fromValues(worldX, worldY, 0), inv);
        return this.getCaretIndexAtLocalPos(local[0], local[1]);
    }

    /** Returns true if there is an active text selection range. */
    public hasSelection(): boolean {
        return this.selectionStart >= 0 && this.selectionEnd >= 0 && this.selectionStart !== this.selectionEnd;
    }

    /** Get the ordered selection range [start, end). */
    public getSelectionRange(): [number, number] {
        const a = Math.min(this.selectionStart, this.selectionEnd);
        const b = Math.max(this.selectionStart, this.selectionEnd);
        return [Math.max(0, a), Math.min(this.text.length, b)];
    }

    /** Get the selected text substring. */
    public getSelectedText(): string {
        if (!this.hasSelection()) return '';
        const [a, b] = this.getSelectionRange();
        return this.text.substring(a, b);
    }

    /** Get selection highlight rectangles in local (world-unit) coordinates for rendering. */
    public getSelectionRects(): { x: number; y: number; width: number; height: number }[] {
        if (!this.hasSelection()) return [];
        const [selA, selB] = this.getSelectionRange();
        const rects: { x: number; y: number; width: number; height: number }[] = [];

        // caretPositions[0] = before char 0, caretPositions[i+1] = after char i
        // Group by line (same yPx) and emit one rect per line span
        let lineStartIdx = selA;
        while (lineStartIdx < selB) {
            const cpStart = this.caretPositions[lineStartIdx];
            if (!cpStart) break;
            // Find the end of this line within selection
            let lineEndIdx = lineStartIdx + 1;
            while (lineEndIdx < selB) {
                const cpNext = this.caretPositions[lineEndIdx + 1] ?? this.caretPositions[lineEndIdx];
                if (!cpNext || cpNext.yPx !== cpStart.yPx + (this.caretPositions[lineStartIdx + 1]?.yPx === cpStart.yPx ? 0 : 0)) break;
                // stay on same line
                if (this.caretPositions[lineEndIdx].yPx === cpStart.yPx) {
                    lineEndIdx++;
                } else break;
            }
            const cpEnd = this.caretPositions[Math.min(lineEndIdx, this.caretPositions.length - 1)];
            if (cpEnd && cpStart) {
                const x0 = Math.min(cpStart.xPx, cpEnd.xPx) * this.pxToWorldX;
                const x1 = Math.max(cpStart.xPx, cpEnd.xPx) * this.pxToWorldX;
                rects.push({
                    x: x0,
                    y: cpStart.yPx * this.pxToWorldY,
                    width: x1 - x0,
                    height: cpStart.heightPx * Math.abs(this.pxToWorldY)
                });
            }
            lineStartIdx = lineEndIdx;
        }
        return rects;
    }

    /** Clear the selection range. */
    public clearSelection(): void {
        this.selectionStart = -1;
        this.selectionEnd = -1;
    }

    /** Set selection to cover all text. */
    public selectAll(): void {
        this.selectionStart = 0;
        this.selectionEnd = this.text.length;
        this.caretIndex = this.text.length;
    }

    /** Delete the selected text, returns the new text. */
    public deleteSelection(): string {
        if (!this.hasSelection()) return this.text;
        const [a, b] = this.getSelectionRange();
        this.text = this.text.substring(0, a) + this.text.substring(b);
        this.caretIndex = a;
        this.clearSelection();
        this.refreshText();
        this.isDirty = true;
        this.onChange?.();
        return this.text;
    }

    /** Insert text at caret, replacing any selection. Returns the new full text. */
    public insertAtCaret(str: string): string {
        if (this.hasSelection()) {
            const [a, b] = this.getSelectionRange();
            this.text = this.text.substring(0, a) + str + this.text.substring(b);
            this.caretIndex = a + str.length;
            this.clearSelection();
        } else {
            this.text = this.text.substring(0, this.caretIndex) + str + this.text.substring(this.caretIndex);
            this.caretIndex += str.length;
        }
        this.refreshText();
        this.isDirty = true;
        this.onChange?.();
        return this.text;
    }

    /** Move the caret left/right by `delta` chars. If `extend` is true, extend selection. */
    public moveCaret(delta: number, extend: boolean = false): void {
        const oldIndex = this.caretIndex;
        this.caretIndex = Math.max(0, Math.min(this.text.length, this.caretIndex + delta));

        if (extend) {
            // Start a new selection if none exists
            if (this.selectionStart < 0) {
                this.selectionStart = oldIndex;
            }
            this.selectionEnd = this.caretIndex;
        } else {
            // If there was a selection, collapse to the appropriate edge
            if (this.hasSelection()) {
                const [a, b] = this.getSelectionRange();
                this.caretIndex = delta < 0 ? a : b;
            }
            this.clearSelection();
        }
        this.resetBlink();
        this.isDirty = true;
    }

    /** Move caret to the start of the current line. */
    public moveCaretToLineStart(extend: boolean = false): void {
        if (this.caretPositions.length === 0) return;
        const cp = this.caretPositions[this.caretIndex] ?? this.caretPositions[this.caretPositions.length - 1];
        const lineY = cp.yPx;
        // Find the first caret position on this line
        let target = this.caretIndex;
        for (let i = this.caretIndex - 1; i >= 0; i--) {
            if (this.caretPositions[i].yPx === lineY) target = i;
            else break;
        }
        const delta = target - this.caretIndex;
        this.moveCaret(delta, extend);
    }

    /** Move caret to the end of the current line. */
    public moveCaretToLineEnd(extend: boolean = false): void {
        if (this.caretPositions.length === 0) return;
        const cp = this.caretPositions[this.caretIndex] ?? this.caretPositions[this.caretPositions.length - 1];
        const lineY = cp.yPx;
        // Find the last caret position on this line
        let target = this.caretIndex;
        for (let i = this.caretIndex + 1; i < this.caretPositions.length; i++) {
            if (this.caretPositions[i].yPx === lineY) target = i;
            else break;
        }
        const delta = target - this.caretIndex;
        this.moveCaret(delta, extend);
    }

    /** Reset the blink timer (show caret immediately after movement). */
    private resetBlink(): void {
        this.caretVisible = true;
        if (this._blinkTimer) {
            clearInterval(this._blinkTimer);
            this._blinkTimer = window.setInterval(() => {
                this.caretVisible = !this.caretVisible;
                this.isDirty = true;
                this._interactionService.requestRender();
            }, 500);
        }
    }

    private generateGlyphQuads() {
    this.glyphQuads = [];
    this.caretPositions = [];

    if (this.writingMode === 'vertical-rl') {
      this.generateVerticalGlyphQuads();
      return;
    }

    let penX = 0, penY = 0;
    const lineStep = this.fontSize * (this.lineHeight);
    const maxW = this.maxWidthPx; // px, may be undefined

    const adv = (ch: string) => this.sdfAtlas.addCharacter(ch, this.fontSize, this.font).advance;

    const pushGlyph = (ch: string) => {
        const g = this.sdfAtlas.addCharacter(ch, this.fontSize, this.font);
        this.glyphQuads.push({
        x: penX + g.bearingX,
        y: penY - g.bearingY,

        // screen-space quad size (display px):
        width:  g.width,
        height: g.height,

        // UVs must use atlas-space (texels):
        atlasX: g.atlasX,
        atlasY: g.atlasY,
        atlasWidth:  g.texWidth,    // << was g.width (wrong space)
        atlasHeight: g.texHeight,   // << was g.height (wrong space)
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

  /**
   * Vertical text layout: top-to-bottom, right-to-left columns.
   * Used for manga/CJK vertical text.
   *
   * Each character is placed one below the other. When a column
   * reaches maxHeightPx (derived from maxWidthPx or unlimited), a
   * new column starts to the LEFT of the current one.
   *
   * Latin characters and digits are rotated 90° CW by shifting
   * their glyph positions (the GPU renders the same atlas quad,
   * but we lay them out in a rotated manner).
   */
  private generateVerticalGlyphQuads() {
    const colStep = this.fontSize * (this.lineHeight);
    const charStep = this.fontSize * (this.lineHeight);
    const maxH = this.maxWidthPx; // reuse maxWidth as maxHeight for vertical

    let penX = 0; // current column X (starts at 0, grows negative for RTL columns)
    let penY = 0; // current Y position within column

    // caret at start
    this.caretPositions.push({ xPx: penX + colStep / 2, yPx: penY, heightPx: charStep });

    const newColumn = () => {
      penX -= colStep; // next column is to the LEFT
      penY = 0;
      this.caretPositions.push({ xPx: penX + colStep / 2, yPx: penY, heightPx: charStep });
    };

    for (let i = 0; i < this.text.length; i++) {
      const ch = this.text[i];

      if (ch === '\n') {
        newColumn();
        continue;
      }

      // Check column overflow
      if (maxH && penY > 0 && penY + charStep > maxH) {
        newColumn();
      }

      const g = this.sdfAtlas.addCharacter(ch, this.fontSize, this.font);

      // Center the glyph horizontally in the column
      const glyphCenterOffset = (colStep - g.width) / 2;

      this.glyphQuads.push({
        x: penX + glyphCenterOffset,
        y: penY,
        width: g.width,
        height: g.height,
        atlasX: g.atlasX,
        atlasY: g.atlasY,
        atlasWidth: g.texWidth,
        atlasHeight: g.texHeight,
      });

      penY += charStep;
      this.caretPositions.push({ xPx: penX + colStep / 2, yPx: penY, heightPx: charStep });
    }

    // Measure: columns go right-to-left from 0 into negative X.
    // Shift everything so the bounding box starts at (0, 0).
    const minX = penX; // most-left column X
    const totalWidth = -minX + colStep; // total width of all columns
    const totalHeight = Math.max(charStep, ...this.glyphQuads.map(q => q.y + q.height));

    // Shift all positions so leftmost column starts at x=0
    for (const q of this.glyphQuads) {
      q.x -= minX;
    }
    for (const cp of this.caretPositions) {
      cp.xPx -= minX;
    }

    this.measuredPx = { width: totalWidth, height: totalHeight };
    this.calculateBoundingBox();
  }


    public getGeometryVertices(): Float32Array {
        const verts: number[] = [];
        const atlasSize = this.sdfAtlas.getAtlasSize();

        // half-texel inset (in atlas texels)
        const inset = 36; // 36px inset in atlas texels (16px on each side)

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
        const inv = mat4.create();
        if (!mat4.invert(inv, this.localMatrix)) {
            return false; // singular matrix
        }
        const local = vec3.transformMat4(
            vec3.create(),
            vec3.fromValues(worldX, worldY, 0),
            inv
        );

        // boundingBox.height is negative (hPx * -pxToWorldY), so text extends
        // from y=0 downward to y=boundingBox.height (negative).
        return (
            local[0] >= 0 && local[0] <= this.boundingBox.width &&
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

public setLineHeight(newHeight: number) {
  if (this.lineHeight !== newHeight) {
    this.lineHeight = newHeight;
    this.refreshText();
    this.isDirty = true;
    this.onChange?.();
    return;
  }
}

public setFontSize(newFontSize: number) {
  if (this.fontSize !== newFontSize) {
    this.fontSize = newFontSize;
    this.refreshText();
    this.isDirty = true;
    this.onChange?.();
    return;
  }
}

public setFont(newFont: string) {
  if (this.font !== newFont) {
    this.font = newFont;
    this.refreshText();
    this.isDirty = true;
    this.onChange?.();
    return;
  }
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

    public dispose(): void {
        this.endTyping();
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
            smoothing    : this.smoothing,
            maxWidth     : this.maxWidthPx !== undefined ? this.maxWidthPx * this.pxToWorldX : undefined,
            writingMode  : this.writingMode,
        };
    }
}