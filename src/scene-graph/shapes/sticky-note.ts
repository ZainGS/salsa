// src/scene-graph/shapes/sticky-note.ts
import { Group } from "./base/group";
import { Rectangle } from "../shapes/rectangle";
import { SDFText } from "../shapes/sdf-text/sdf-text";
import { InteractionService } from "../../services/interaction-service";
import { mat4 } from "gl-matrix";
import { CacheService } from "../../services/cache-service";

type NoteColor = { r:number; g:number; b:number; a:number };

export class StickyNote extends Group {
  readonly bg: Rectangle;
  readonly text: SDFText;
  readonly signature?: SDFText;

  padding = 0.18;          // (all sides) world units (~px/64)
  extraBottomPad = 0;   // reserved empty space under signature
  signatureGap = 0.12;     // gap between content text and signature

  minWidth = 1.0;               // fixed width mode baseline
  maxWidth = 1.0;               // clamp width if you allow drag-widen
  minHeight = 1.0;

  cornerRadius = 0.12;
  color: NoteColor;

  fixedWidth = true;            // MVP: fixed width + auto height
  private _targetWidth = this.minWidth;

  constructor(interaction: InteractionService, 
    cache: CacheService, 
    textValue = "New note", 
    color: NoteColor = {r:1.0,g:0.98,b:0.65,a:1}, 
    signatureText?: string) {
    super(interaction);

    this.color = color;

    // Background rect (center-anchored in your system)
    this.bg = new Rectangle(0, 0, 1, 1, color, undefined, 1, interaction);
    this.bg.finalizeInitialization();
    //this.bg.rounded = true;
    //this.bg.cornerRadius = this.cornerRadius;

    // SDF text node (rendered on top)
    this.text = new SDFText(textValue, 12, cache.getSdfAtlas(), { r: 0, g: 0, b: 0, a: 1 }, interaction, 'Arial');
    this.text.align = "left";
    this.text.valign = "top";
    this.text.fontSize = 18;                // pick a nice default
    this.text.setMaxWidth(this.minWidth - this.padding*2); // wrap rule
    this.text.onChange = () => this.layout();              // reflow on edits

    // Optional signature
    if (signatureText && signatureText.length) {
      this.signature = new SDFText(signatureText, 12, cache.getSdfAtlas(), { r:0, g:0, b:0, a:0.5 }, interaction, "Arial");
      this.signature.align = "left"; this.signature.valign = "top";
      this.signature.fontSize = 16;      // smaller than body text
      this.signature.setMaxWidth(this.minWidth - this.padding*2);
      this.signature.onChange = () => this.layout();
    }

    // Compose
    this.addChild(this.bg);
    this.addChild(this.text);
    if (this.signature) this.addChild(this.signature);

    // First layout
    this.layout();

    // Keep group bounds in sync so hit-testing/selection boxes are crisp
    this.recalculateSize();
  }

  /** Call whenever text changes or width changes */
  /** Reflow text + signature and resize the rect. */
  layout() {
    const contentW = this.fixedWidth ? this._targetWidth - this.padding*2 : undefined;
    if (contentW) {
      this.text.setMaxWidth(contentW);
      this.signature?.setMaxWidth(contentW);
    }

    const mainSize = this.text.getMeasuredSize();          // world units
    const sigSize  = this.signature ? this.signature.getMeasuredSize() : { width: 0, height: 0 };

    const width = this.fixedWidth
      ? this._targetWidth
      : Math.min(this.maxWidth, Math.max(mainSize.width, sigSize.width) + this.padding*2);

    // The rect must fit:
    // top padding + main text + (optional gap + signature) + bottom padding + extra bottom space
    const bodyBlockH = mainSize.height;
    const sigBlockH  = this.signature ? (this.signatureGap + sigSize.height) : 0;
    const naturalH   = this.padding + bodyBlockH + sigBlockH + this.padding + this.extraBottomPad;

    const height = Math.max(this.minHeight, naturalH);

    // Drive rect by scale (unit quad)
    this.bg.scaleX = width;
    this.bg.scaleY = height;
    this.bg.updateLocalMatrix();
    this.bg.markDirty();

    // Place main text at top-left inside padding
    this.text.x = -width/2  + this.padding;
    this.text.y =  height/2 - this.padding; // top edge
    this.text.updateLocalMatrix();

    // Place signature anchored to bottom-left
    if (this.signature) {
      // signature's TOP-LEFT should sit above bottom padding+extra by its own height
      // bottom edge in local = -height/2
      const sigTopY = -height/2 + this.padding + this.extraBottomPad + sigSize.height;
      this.signature.x = -width/2 + this.padding;
      this.signature.y = sigTopY;
      this.signature.updateLocalMatrix();
    }

    this.updateLocalMatrix();
    this.markDirty();
    this.recalculateSize();
  }

  /** Public API */
  setText(t: string) { this.text.setText(t); this.layout(); }
  setSignatureText(t: string) {  // convenient mutator
    if (!this.signature) return;
    this.signature.setText(t);
    this.layout();
  }

  setColor(c: NoteColor) { this.color = c; this.bg.fillColor = c; this.bg.markDirty(); }

  /** If you allow horizontal resizing by user */
  setWidth(w: number) {
    this._targetWidth = Math.max(this.minWidth, Math.min(this.maxWidth, w));
    this.layout();
  }

  /** Group’s selection box should be the bg bounds */
  override recalculateSize() {
    // If your Group computes from children already, this may be unnecessary.
    super.recalculateSize();
  }

  getType(): string {
        return "Sticky Note";
  }

  toJSON() {
    return {
      ...super.toJSON(),
      type: this.getType(),
      padding: this.padding,
      extraBottomPad: this.extraBottomPad,
      signatureGap: this.signatureGap,
      minWidth: this.minWidth,
      maxWidth: this.maxWidth,
      minHeight: this.minHeight,
      color: this.color,
      fixedWidth: this.fixedWidth,
      targetWidth: this["_targetWidth"],
      signatureText: this.signature ? this.signature.text : undefined,
      text: this.text.text,
    };
  }

  override getWorldSpaceBoundingBoxPolygon() {
    return this.bg.getWorldSpaceBoundingBoxPolygon(true);
  }
}