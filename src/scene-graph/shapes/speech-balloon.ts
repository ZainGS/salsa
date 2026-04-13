/**
 * SpeechBalloon — a manga/comic speech balloon with auto-sizing body and tail.
 *
 * Composed of:
 *  • A Polygon body whose outline varies by style (rounded-rect, ellipse, cloud, burst, thought)
 *  • An SDFText node for the dialog text (or LiveTextNode when HTML-in-Canvas is available)
 *  • A Polygon tail child (triangle pointer, or circle dots for thought style)
 *
 * The body auto-sizes to fit the text content.
 * The tail can be attached to any side (top, right, bottom, left) and
 * its position along that edge can be adjusted (0–1).
 *
 * Writing mode: supports both horizontal-tb (standard) and vertical-rl
 * (manga-style vertical text, top-to-bottom, right-to-left columns).
 */

import { Group } from './base/group';
import { Polygon } from './polygon';
import { SDFText } from './sdf-text/sdf-text';
import { LiveTextNode } from './live-text';
import { InteractionService } from '../../services/interaction-service';
import { CacheService } from '../../services/cache-service';
import { RGBA } from '../../types/rgba';

export type TailSide = 'top' | 'right' | 'bottom' | 'left';

export type BalloonStyle = 'ellipse' | 'rounded-rect' | 'cloud' | 'burst' | 'thought';

export interface SpeechBalloonOptions {
  /** Dialog text content. */
  text?: string;
  /** Font family. */
  font?: string;
  /** Font size in SDF atlas units. */
  fontSize?: number;
  /** Line height multiplier. */
  lineHeight?: number;
  /** Text color. */
  textColor?: RGBA;
  /** Balloon background color. */
  fillColor?: RGBA;
  /** Balloon stroke color. */
  strokeColor?: RGBA;
  /** Stroke width. */
  strokeWidth?: number;
  /** Writing direction: 'horizontal-tb' (standard) or 'vertical-rl' (manga). */
  writingMode?: 'horizontal-tb' | 'vertical-rl';
  /** Which edge the tail points from. */
  tailSide?: TailSide;
  /** Tail position along the edge (0 = start, 1 = end). */
  tailPosition?: number;
  /** Tail length in world units. */
  tailLength?: number;
  /** Tail width in world units. */
  tailWidth?: number;
  /** Whether to show the tail. */
  showTail?: boolean;
  /** Balloon visual style. */
  style?: BalloonStyle;
  /** Minimum width in world units. */
  minWidth?: number;
  /** Minimum height in world units. */
  minHeight?: number;
  /** Maximum width in world units (text wraps beyond this). */
  maxWidth?: number;
}

const DEFAULT_FILL: RGBA = { r: 1, g: 1, b: 1, a: 1 };
const DEFAULT_STROKE: RGBA = { r: 0, g: 0, b: 0, a: 1 };
const DEFAULT_TEXT_COLOR: RGBA = { r: 0, g: 0, b: 0, a: 1 };

// ── Outline generators (return points centered at origin) ──────────

/** Number of segments for curved outlines. */
const ARC_SEGMENTS = 8;

function generateRoundedRect(w: number, h: number, r: number): { x: number; y: number }[] {
  const hw = w / 2, hh = h / 2;
  r = Math.min(r, hw, hh);
  const pts: { x: number; y: number }[] = [];
  // 4 arcs, each ARC_SEGMENTS points
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const a = Math.PI / 2 * (i / ARC_SEGMENTS);
    pts.push({ x: hw - r + Math.cos(a) * r, y: hh - r + Math.sin(a) * r }); // top-right
  }
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const a = Math.PI / 2 + Math.PI / 2 * (i / ARC_SEGMENTS);
    pts.push({ x: -hw + r + Math.cos(a) * r, y: hh - r + Math.sin(a) * r }); // top-left
  }
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const a = Math.PI + Math.PI / 2 * (i / ARC_SEGMENTS);
    pts.push({ x: -hw + r + Math.cos(a) * r, y: -hh + r + Math.sin(a) * r }); // bottom-left
  }
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const a = 3 * Math.PI / 2 + Math.PI / 2 * (i / ARC_SEGMENTS);
    pts.push({ x: hw - r + Math.cos(a) * r, y: -hh + r + Math.sin(a) * r }); // bottom-right
  }
  return pts;
}

function generateEllipse(w: number, h: number): { x: number; y: number }[] {
  const hw = w / 2, hh = h / 2;
  const n = ARC_SEGMENTS * 4;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({ x: Math.cos(a) * hw, y: Math.sin(a) * hh });
  }
  return pts;
}

function generateCloud(w: number, h: number): { x: number; y: number }[] {
  // Scalloped edge: bumps along an elliptical path
  const hw = w / 2, hh = h / 2;
  const bumps = Math.max(8, Math.round((w + h) * 12));
  const bumpDepth = Math.min(w, h) * 0.08;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < bumps; i++) {
    const a = (2 * Math.PI * i) / bumps;
    // Alternate in/out for scallop
    const inOut = (i % 2 === 0) ? 1 : 1 - bumpDepth / Math.min(hw, hh);
    pts.push({ x: Math.cos(a) * hw * inOut, y: Math.sin(a) * hh * inOut });
  }
  return pts;
}

function generateBurst(w: number, h: number): { x: number; y: number }[] {
  // Spiky starburst
  const hw = w / 2, hh = h / 2;
  const spikes = 12;
  const innerScale = 0.7;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (2 * Math.PI * i) / (spikes * 2);
    const scale = (i % 2 === 0) ? 1 : innerScale;
    pts.push({ x: Math.cos(a) * hw * scale, y: Math.sin(a) * hh * scale });
  }
  return pts;
}

function generateThought(w: number, h: number): { x: number; y: number }[] {
  // Thought bubble = cloud-like bumpy ellipse (same as cloud but softer bumps)
  const hw = w / 2, hh = h / 2;
  const bumps = Math.max(10, Math.round((w + h) * 14));
  const bumpDepth = Math.min(w, h) * 0.05;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < bumps; i++) {
    const a = (2 * Math.PI * i) / bumps;
    const bumpPhase = Math.sin(a * bumps / 2) * bumpDepth;
    pts.push({
      x: Math.cos(a) * (hw + bumpPhase),
      y: Math.sin(a) * (hh + bumpPhase),
    });
  }
  return pts;
}

/** Generate outline points for a given style. */
function generateOutlinePoints(
  style: BalloonStyle,
  w: number,
  h: number,
): { x: number; y: number }[] {
  switch (style) {
    case 'rounded-rect': return generateRoundedRect(w, h, Math.min(w, h) * 0.15);
    case 'ellipse':      return generateEllipse(w, h);
    case 'cloud':        return generateCloud(w, h);
    case 'burst':        return generateBurst(w, h);
    case 'thought':      return generateThought(w, h);
    default:             return generateRoundedRect(w, h, Math.min(w, h) * 0.15);
  }
}

// ── Thought-bubble trailing dots (circle polygons) ─────────────────

function generateCirclePolygon(cx: number, cy: number, r: number, segs = 12): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

// ═══════════════════════════════════════════════════════════════════

export class SpeechBalloon extends Group {
  /** The balloon body outline (Polygon, regenerated per style/size). */
  readonly bg: Polygon;
  /** The tail triangle (Polygon with 3 vertices). Hidden when showTail is false. */
  readonly tailPoly: Polygon;
  /** SDFText child for dialog text. */
  readonly textNode: SDFText;

  /**
   * Optional LiveTextNode for HTML-in-Canvas rendering.
   * When set, this is used for text rendering + effects instead of SDFText.
   * Set by ShapeManager.createSpeechBalloon() when the API is available.
   */
  private _liveTextNode: LiveTextNode | null = null;

  // Layout config
  padding = 0.08;
  balloonFillColor: RGBA;
  balloonStrokeColor: RGBA;
  balloonStrokeWidth: number;
  writingMode: 'horizontal-tb' | 'vertical-rl';

  // Tail config
  tailSide: TailSide;
  tailPosition: number; // 0–1 along edge
  tailLength: number;
  tailWidth: number;
  showTail: boolean;

  // Style
  balloonStyle: BalloonStyle;

  // Size constraints
  minWidth: number;
  minHeight: number;
  maxWidth: number;

  // Cached body dimensions (for tail math)
  private _bodyW = 0;
  private _bodyH = 0;

  constructor(
    interaction: InteractionService,
    cache: CacheService,
    options: SpeechBalloonOptions = {},
  ) {
    super(interaction);

    const {
      text = '',
      font = 'Arial',
      fontSize = 90,
      lineHeight = 1.25,
      textColor = DEFAULT_TEXT_COLOR,
      fillColor = DEFAULT_FILL,
      strokeColor = DEFAULT_STROKE,
      strokeWidth = 2,
      writingMode = 'horizontal-tb',
      tailSide = 'bottom',
      tailPosition = 0.3,
      tailLength = 0.15,
      tailWidth = 0.08,
      showTail = true,
      style = 'rounded-rect',
      minWidth = 0.3,
      minHeight = 0.2,
      maxWidth = 1.5,
    } = options;

    this.balloonFillColor = { ...fillColor };
    this.balloonStrokeColor = { ...strokeColor };
    this.balloonStrokeWidth = strokeWidth;
    this.writingMode = writingMode;
    this.tailSide = tailSide;
    this.tailPosition = tailPosition;
    this.tailLength = tailLength;
    this.tailWidth = tailWidth;
    this.showTail = showTail;
    this.balloonStyle = style;
    this.minWidth = minWidth;
    this.minHeight = minHeight;
    this.maxWidth = maxWidth;

    // Body polygon (initial placeholder — rebuilt in layout())
    this.bg = new Polygon(
      [{ x: 0, y: 0 }],
      fillColor, strokeColor, strokeWidth, interaction,
    );
    this.bg.finalizeInitialization();

    // Tail polygon (initial placeholder — rebuilt in rebuildTail())
    this.tailPoly = new Polygon(
      [{ x: 0, y: 0 }],
      fillColor, { r: strokeColor.r, g: strokeColor.g, b: strokeColor.b, a: strokeColor.a }, strokeWidth, interaction,
    );
    this.tailPoly.finalizeInitialization();

    // Text node
    this.textNode = new SDFText(text, fontSize, cache.getSdfAtlas(), textColor, interaction, font);
    this.textNode.font = font;
    this.textNode.fontSize = fontSize;
    this.textNode.lineHeight = lineHeight;
    this.textNode.writingMode = writingMode;
    this.textNode.align = 'left';
    this.textNode.valign = 'top';
    this.textNode.setMaxWidth(maxWidth - this.padding * 2);
    this.textNode.onChange = () => this.layout();

    // Compose children: body, tail, then text (text on top)
    this.addChild(this.bg);
    this.addChild(this.tailPoly);
    this.addChild(this.textNode);

    this.layout();
    this.recalculateSize();
  }

  // ── Layout engine ─────────────────────────────────────────────────

  /** Reflow text, resize body polygon, and rebuild tail. */
  layout(): void {
    const contentW = this.maxWidth - this.padding * 2;
    this.textNode.setMaxWidth(contentW);

    const measured = this.textNode.getMeasuredSize();
    const bodyW = Math.max(this.minWidth, Math.min(this.maxWidth, measured.width + this.padding * 2));
    const bodyH = Math.max(this.minHeight, measured.height + this.padding * 2);
    this._bodyW = bodyW;
    this._bodyH = bodyH;

    // Regenerate body outline for current style/size
    const outlinePoints = generateOutlinePoints(this.balloonStyle, bodyW, bodyH);
    this.bg.setPoints(outlinePoints);
    this.bg.fillColor = this.balloonFillColor;
    this.bg.strokeColor = this.balloonStrokeColor;
    this.bg.strokeWidth = this.balloonStrokeWidth;
    this.bg.markDirty();

    // Position text at top-left inside padding
    this.textNode.x = -bodyW / 2 + this.padding;
    this.textNode.y = bodyH / 2 - this.padding;
    this.textNode.updateLocalMatrix();

    // Rebuild tail
    this.rebuildTail();

    this.updateLocalMatrix();
    this.markDirty();
    this.recalculateSize();
  }

  // ── Tail geometry ─────────────────────────────────────────────────

  /** Rebuild the tail polygon from current config. */
  private rebuildTail(): void {
    if (!this.showTail) {
      this.tailPoly.visible = false;
      return;
    }

    this.tailPoly.visible = true;

    if (this.balloonStyle === 'thought') {
      // Thought bubbles use trailing dots instead of a triangle tail
      this.rebuildThoughtDots();
      return;
    }

    const pts = this.computeTailTriangle();
    if (pts.length === 3) {
      this.tailPoly.setPoints(pts);
      this.tailPoly.fillColor = this.balloonFillColor;
      this.tailPoly.strokeColor = this.balloonStrokeColor;
      this.tailPoly.strokeWidth = this.balloonStrokeWidth;
      this.tailPoly.markDirty();
    }
  }

  /** Compute the 3 triangle vertices for the tail in local space. */
  private computeTailTriangle(): { x: number; y: number }[] {
    const w = this._bodyW;
    const h = this._bodyH;
    const hw = w / 2;
    const hh = h / 2;
    const pos = this.tailPosition;
    const halfTailW = this.tailWidth / 2;
    const len = this.tailLength;

    switch (this.tailSide) {
      case 'bottom': {
        const cx = -hw + w * pos;
        return [
          { x: cx - halfTailW, y: -hh },
          { x: cx, y: -hh - len },
          { x: cx + halfTailW, y: -hh },
        ];
      }
      case 'top': {
        const cx = -hw + w * pos;
        return [
          { x: cx - halfTailW, y: hh },
          { x: cx, y: hh + len },
          { x: cx + halfTailW, y: hh },
        ];
      }
      case 'left': {
        const cy = hh - h * pos;
        return [
          { x: -hw, y: cy - halfTailW },
          { x: -hw - len, y: cy },
          { x: -hw, y: cy + halfTailW },
        ];
      }
      case 'right': {
        const cy = hh - h * pos;
        return [
          { x: hw, y: cy - halfTailW },
          { x: hw + len, y: cy },
          { x: hw, y: cy + halfTailW },
        ];
      }
    }
  }

  /** For thought style: trailing circle dots leading to the tail tip. */
  private rebuildThoughtDots(): void {
    const tip = this.computeTailTriangle();
    if (tip.length < 2) return;
    const tipPt = tip[1]; // the tip point
    const baseMid = { x: (tip[0].x + tip[2].x) / 2, y: (tip[0].y + tip[2].y) / 2 };

    // 3 decreasing circles from body edge to tip
    const dots: { x: number; y: number }[] = [];
    const baseRadius = Math.min(this._bodyW, this._bodyH) * 0.04;
    for (let i = 0; i < 3; i++) {
      const t = (i + 1) / 4;
      const cx = baseMid.x + (tipPt.x - baseMid.x) * t;
      const cy = baseMid.y + (tipPt.y - baseMid.y) * t;
      const r = baseRadius * (1 - t * 0.5);
      dots.push(...generateCirclePolygon(cx, cy, r));
    }
    this.tailPoly.setPoints(dots.length > 0 ? dots : [{ x: 0, y: 0 }]);
    this.tailPoly.fillColor = this.balloonFillColor;
    this.tailPoly.strokeColor = this.balloonStrokeColor;
    this.tailPoly.strokeWidth = this.balloonStrokeWidth;
    this.tailPoly.markDirty();
  }

  /**
   * Get the tail triangle points in local coordinates.
   * Returns 3 points: [baseLeft, tip, baseRight].
   */
  getTailPoints(): { x: number; y: number }[] {
    if (!this.showTail) return [];
    return this.computeTailTriangle();
  }

  /**
   * Get the world-space tail tip position (for tail dragging / attachment).
   */
  getTailTipWorld(): { x: number; y: number } {
    const pts = this.getTailPoints();
    if (pts.length < 2) return { x: this.x, y: this.y };
    const tip = pts[1]; // tip is the middle point
    return {
      x: this.x + tip.x,
      y: this.y + tip.y,
    };
  }

  /**
   * Set the tail tip position in world coords. The balloon will compute
   * which side and position the tail should attach to.
   */
  setTailTipWorld(worldX: number, worldY: number): void {
    const dx = worldX - this.x;
    const dy = worldY - this.y;
    const hw = this._bodyW / 2;
    const hh = this._bodyH / 2;

    // Determine which side based on angle from center
    const angle = Math.atan2(dy, dx);
    const absAngle = Math.abs(angle);

    if (absAngle < Math.PI / 4) {
      this.tailSide = 'right';
      this.tailPosition = Math.max(0, Math.min(1, 0.5 - dy / (this._bodyH || 1)));
      this.tailLength = Math.max(0.05, dx - hw);
    } else if (absAngle > 3 * Math.PI / 4) {
      this.tailSide = 'left';
      this.tailPosition = Math.max(0, Math.min(1, 0.5 - dy / (this._bodyH || 1)));
      this.tailLength = Math.max(0.05, -dx - hw);
    } else if (angle > 0) {
      this.tailSide = 'top';
      this.tailPosition = Math.max(0, Math.min(1, (dx + hw) / (this._bodyW || 1)));
      this.tailLength = Math.max(0.05, dy - hh);
    } else {
      this.tailSide = 'bottom';
      this.tailPosition = Math.max(0, Math.min(1, (dx + hw) / (this._bodyW || 1)));
      this.tailLength = Math.max(0.05, -dy - hh);
    }

    this.rebuildTail();
    this.markDirty();
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Get the SDFText node (always present, used as fallback or layout reference). */
  getTextNode(): SDFText { return this.textNode; }

  /** Get the LiveTextNode if HTML-in-Canvas is active. */
  getLiveTextNode(): LiveTextNode | null { return this._liveTextNode; }

  /**
   * Attach a LiveTextNode for HTML-in-Canvas rendering.
   * The LiveTextNode is added as a child (for scene traversal / rendering).
   * SDFText is kept for layout measurement but hidden when LiveTextNode is active.
   */
  setLiveTextNode(node: LiveTextNode): void {
    this._liveTextNode = node;
    node.text = this.textNode.text;
    node.onChange = () => this.layout();
    this.addChild(node);
    // SDFText is still used for layout measurement but we hide it visually
    this.textNode.visible = false;
    this.layout();
  }

  setText(text: string): void {
    this.textNode.setText(text);
    if (this._liveTextNode) this._liveTextNode.text = text;
    this.layout();
  }

  getText(): string {
    return this.textNode.text;
  }

  setFont(font: string): void {
    this.textNode.setFont(font);
    if (this._liveTextNode) this._liveTextNode.font = font;
    this.layout();
  }

  setFontSize(size: number): void {
    this.textNode.setFontSize(size);
    if (this._liveTextNode) this._liveTextNode.fontSize = size;
    this.layout();
  }

  setLineHeight(lh: number): void {
    this.textNode.setLineHeight(lh);
    this.layout();
  }

  setWritingMode(mode: 'horizontal-tb' | 'vertical-rl'): void {
    this.writingMode = mode;
    this.textNode.writingMode = mode;
    this.textNode.refreshText();
    if (this._liveTextNode) this._liveTextNode.writingMode = mode;
    this.layout();
  }

  setTextColor(color: RGBA): void {
    this.textNode.fillColor = color;
    this.textNode.markDirty();
    if (this._liveTextNode) this._liveTextNode.textColor = color;
  }

  setFillColor(color: RGBA): void {
    this.balloonFillColor = { ...color };
    this.bg.fillColor = color;
    this.bg.markDirty();
    this.tailPoly.fillColor = color;
    this.tailPoly.markDirty();
  }

  setStrokeColor(color: RGBA): void {
    this.balloonStrokeColor = { ...color };
    this.bg.strokeColor = color;
    this.bg.markDirty();
    this.tailPoly.strokeColor = color;
    this.tailPoly.markDirty();
  }

  setTailSide(side: TailSide): void {
    this.tailSide = side;
    this.rebuildTail();
    this.markDirty();
  }

  setTailPosition(pos: number): void {
    this.tailPosition = Math.max(0, Math.min(1, pos));
    this.rebuildTail();
    this.markDirty();
  }

  setTailLength(len: number): void {
    this.tailLength = Math.max(0, len);
    this.rebuildTail();
    this.markDirty();
  }

  setShowTail(show: boolean): void {
    this.showTail = show;
    this.rebuildTail();
    this.markDirty();
  }

  setBalloonStyle(style: BalloonStyle): void {
    this.balloonStyle = style;
    this.layout(); // Regenerates outline + tail for new style
  }

  setMaxWidth(w: number): void {
    this.maxWidth = w;
    this.layout();
  }

  // ── Serialization ─────────────────────────────────────────────────

  getType(): string {
    return 'Speech Balloon';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      type: this.getType(),
      text: this.textNode.text,
      font: this.textNode.font,
      fontSize: this.textNode.fontSize,
      lineHeight: this.textNode.lineHeight,
      writingMode: this.writingMode,
      textColor: this.textNode.fillColor,
      fillColor: this.balloonFillColor,
      strokeColor: this.balloonStrokeColor,
      strokeWidth: this.balloonStrokeWidth,
      tailSide: this.tailSide,
      tailPosition: this.tailPosition,
      tailLength: this.tailLength,
      tailWidth: this.tailWidth,
      showTail: this.showTail,
      balloonStyle: this.balloonStyle,
      padding: this.padding,
      minWidth: this.minWidth,
      minHeight: this.minHeight,
      maxWidth: this.maxWidth,
    };
  }

  override getWorldSpaceBoundingBoxPolygon() {
    return this.bg.getWorldSpaceBoundingBoxPolygon(true);
  }
}
