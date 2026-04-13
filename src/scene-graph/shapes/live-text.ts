/**
 * LiveTextNode — A scene graph node that renders HTML text as a GPU texture
 * each frame, with optional shader effects that can react to cursor, time, etc.
 *
 * This is the HTML-in-Canvas text rendering path. The node owns a hidden DOM
 * element (a <div> child of the canvas) and captures it as a GPU texture.
 * Effects are applied via compute shaders, and the result is composited
 * into the scene as a textured quad at the node's world position.
 *
 * Falls back to OffscreenCanvas text rendering when HTML-in-Canvas is not available.
 *
 * Lifecycle:
 *  1. Created by ShapeFactory.createLiveText() or as child of SpeechBalloon
 *  2. DOM element created and appended to the canvas (invisible until captured)
 *  3. Each frame during render: capture → apply effects → composite
 *  4. Double-click to edit: focuses the DOM element (browser IME, cursor, selection)
 *  5. Optional: flatten/stamp to raster layer (destructive)
 */

import { mat4, vec3 } from 'gl-matrix';
import { Shape } from './base/shape';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import {
  TextEffectEngine,
  TextEffectConfig,
  TextCaptureConfig,
} from '../../renderer/raster/effects/text-effect-engine';

// ─── Types ──────────────────────────────────────────────────────

export interface LiveTextOptions {
  text?: string;
  font?: string;
  fontSize?: number;
  color?: RGBA;
  bold?: boolean;
  italic?: boolean;
  writingMode?: 'horizontal-tb' | 'vertical-rl';
  maxWidth?: number;
  lineHeight?: number;
  /** Extra padding around text for effects that bleed (glow, outline). */
  padding?: number;
  /** Effect chain applied each frame. */
  effects?: TextEffectConfig[];
}

export interface DynamicUniforms {
  /** Cursor position in UV space (0–1) relative to this node. */
  cursorUV: [number, number];
  /** Current animation time in seconds. */
  time: number;
  /** Whether mouse is pressed (0 or 1). */
  mouseDown: number;
}

// ─── Node ───────────────────────────────────────────────────────

export class LiveTextNode extends Shape {
  // ── Text content & style ──
  private _text: string;
  private _font: string;
  private _fontSize: number;
  private _textColor: RGBA;
  private _bold: boolean;
  private _italic: boolean;
  private _writingMode: 'horizontal-tb' | 'vertical-rl';
  private _maxWidth: number;
  private _lineHeight: number;
  private _padding: number;

  // ── Effect chain ──
  private _effects: TextEffectConfig[] = [];

  /**
   * Pixels-to-world-units conversion factor.
   * Set by ShapeManager from illustration bounds: worldWidth / rasterPixelWidth.
   * Falls back to 1/100 if not set (legacy behavior).
   */
  public worldUnitsPerPixel = 1 / 100;

  // ── Dynamic uniforms (updated per frame by the renderer) ──
  public dynamicUniforms: DynamicUniforms = {
    cursorUV: [0.5, 0.5],
    time: 0,
    mouseDown: 0,
  };

  // ── GPU state ──
  /** The TextEffectEngine instance (set by the renderer/manager) */
  private _engine: TextEffectEngine | null = null;
  /** The current output texture (after effects). Owned by this node. */
  private _currentTexture: GPUTexture | null = null;
  /** Texture dimensions (pixels). */
  private _texWidth = 0;
  private _texHeight = 0;
  /** Whether the text content changed and needs re-capture. */
  private _textDirty = true;
  /** Cached source texture (before effects). */
  private _sourceTexture: GPUTexture | null = null;

  // ── DOM element (for HTML-in-Canvas path) ──
  private _domElement: HTMLDivElement | null = null;
  /** Whether we're using the HTML-in-Canvas path (vs OffscreenCanvas fallback). */
  private _useHtmlCapture = false;

  // ── Editing state ──
  private _isEditing = false;
  /** Whether the user has manually scaled the node via transform handles.
   *  When true, updateTexture() won't overwrite scaleX/scaleY with texture dims. */
  public _hasUserScale = false;
  /** Guard: suppresses _hasUserScale detection while updateTexture sets scale. */
  private _updatingScaleFromTexture = false;
  /** Overlay textarea used for text input when HTML-in-Canvas is not available. */
  private _overlayTextarea: HTMLTextAreaElement | null = null;
  /** Bound handler refs for cleanup. */
  private _onOverlayInput: (() => void) | null = null;
  private _onOverlayBlur: (() => void) | null = null;
  private _onOverlayKeyDown: ((e: KeyboardEvent) => void) | null = null;
  /** Bound handler for DOM element input (HTML-in-Canvas path). */
  private _onDomInput: (() => void) | null = null;
  /** The parent canvas for re-attaching the DOM element on edit. */
  private _parentCanvas: HTMLCanvasElement | null = null;

  // ── Callbacks ──
  /** Called when text content changes (e.g., for parent SpeechBalloon layout). */
  public onChange?: () => void;

  constructor(
    interactionService: InteractionService,
    options: LiveTextOptions = {},
  ) {
    const color = options.color ?? { r: 0, g: 0, b: 0, a: 1 };
    super(color, { r: 0, g: 0, b: 0, a: 0 }, 0, interactionService);

    this.name = 'Live Text';
    this._text = options.text ?? '';
    this._font = options.font ?? 'Arial';
    this._fontSize = options.fontSize ?? 48;
    this._textColor = { ...color };
    this._bold = options.bold ?? false;
    this._italic = options.italic ?? false;
    this._writingMode = options.writingMode ?? 'horizontal-tb';
    this._maxWidth = options.maxWidth ?? 0;
    this._lineHeight = options.lineHeight ?? 1.2;
    this._padding = options.padding ?? 16;
    this._effects = options.effects ? [...options.effects] : [];

    // Unit quad — actual world dimensions live in scaleX/scaleY, set by
    // the first updateTexture() call before the node enters the scene graph.
    this._width = 1;
    this._height = 1;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Public API — Text Content
  // ═══════════════════════════════════════════════════════════════

  get text(): string { return this._text; }
  set text(value: string) {
    if (this._text === value) return;
    this._text = value;
    this._textDirty = true;
    if (this._domElement) this._domElement.textContent = value;
    this.markDirty();
    this.onChange?.();
  }

  get font(): string { return this._font; }
  set font(value: string) {
    this._font = value;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get fontSize(): number { return this._fontSize; }
  set fontSize(value: number) {
    this._fontSize = value;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get textColor(): RGBA { return this._textColor; }
  set textColor(value: RGBA) {
    this._textColor = { ...value };
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get bold(): boolean { return this._bold; }
  set bold(value: boolean) {
    this._bold = value;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get italic(): boolean { return this._italic; }
  set italic(value: boolean) {
    this._italic = value;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get writingMode(): 'horizontal-tb' | 'vertical-rl' { return this._writingMode; }
  set writingMode(value: 'horizontal-tb' | 'vertical-rl') {
    this._writingMode = value;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get maxWidth(): number { return this._maxWidth; }
  set maxWidth(value: number) {
    this._maxWidth = value;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get lineHeight(): number { return this._lineHeight; }
  set lineHeight(value: number) {
    this._lineHeight = value;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get padding(): number { return this._padding; }
  set padding(value: number) {
    this._padding = value;
    this._textDirty = true;
    this.markDirty();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Public API — Effects
  // ═══════════════════════════════════════════════════════════════

  get effects(): readonly TextEffectConfig[] { return this._effects; }

  /** Returns true if any effect uses time-based or cursor-reactive animation. */
  get needsAnimation(): boolean {
    return this._effects.some(fx =>
      fx.type === 'wave' || fx.type === 'glitch' || fx.type === 'custom' || fx.type === 'chromatic-aberration'
    );
  }

  setEffects(effects: TextEffectConfig[]): void {
    this._effects = [...effects];
    this.markDirty();
  }

  addEffect(effect: TextEffectConfig): void {
    this._effects.push(effect);
    this.markDirty();
  }

  removeEffect(index: number): void {
    this._effects.splice(index, 1);
    this.markDirty();
  }

  clearEffects(): void {
    this._effects = [];
    this.markDirty();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Public API — Editing
  // ═══════════════════════════════════════════════════════════════

  get isEditing(): boolean { return this._isEditing; }

  beginEditing(): void {
    if (this._isEditing) return;
    this._isEditing = true;

    // Attach the DOM element to the canvas for HTML-in-Canvas visual capture
    if (this._domElement && this._parentCanvas) {
      this._domElement.textContent = this._text;
      this.applyDomStyles();
      if (!this._domElement.parentElement) {
        this._parentCanvas.appendChild(this._domElement);
      }
    }

    // Always use the overlay textarea for keyboard input.
    //
    // On the HTML-in-Canvas path, the DOM element inside the canvas is used
    // for *visual capture* only — Chrome's layoutsubtree doesn't give child
    // elements normal focus/input-event behavior. So we create a hidden
    // <textarea> for keyboard input on ALL paths, and sync its content to
    // the DOM element (if present) so the visual capture stays current.
    this.createOverlayTextarea();

    if (this._domElement) {
      // Keep the DOM element content in sync for HTML-in-Canvas capture.
      // The overlay textarea drives input; we mirror changes to the div.
      this._onDomInput = () => {
        if (this._domElement) {
          this._domElement.textContent = this._text;
        }
      };
    }
  }

  endEditing(): void {
    if (!this._isEditing) return;
    this._isEditing = false;
    this._onDomInput = null;

    // Clean up the overlay textarea (syncs final text in removeOverlayTextarea)
    this.removeOverlayTextarea();

    // Sync DOM element for HTML-in-Canvas path, then detach it
    if (this._domElement) {
      this._domElement.textContent = this._text;
      // Remove from canvas so it doesn't interfere with sibling captures
      this._domElement.remove();
    }

    this._textDirty = true;
    this.markDirty();
    this.onChange?.();
  }

  // ── Overlay textarea (fallback text input) ───────────────────

  /**
   * Create a transparent textarea overlaid on the canvas to capture keyboard input.
   *
   * This gives us full browser text editing for free:
   * - IME composition (CJK, Korean, Japanese input methods)
   * - Clipboard (Ctrl+C/V/X)
   * - Undo/redo (Ctrl+Z/Y)
   * - Text selection (Shift+arrows, Ctrl+A)
   * - Mobile virtual keyboards
   *
   * The textarea is invisible — text rendering is still done by the
   * OffscreenCanvas capture → GPU effect pipeline. The textarea is
   * purely an input mechanism.
   */
  private createOverlayTextarea(): void {
    if (this._overlayTextarea) return;

    const ta = document.createElement('textarea');
    ta.value = this._text;

    // Position it off-screen but still focusable (the canvas renders the visual).
    // The textarea must be able to receive focus — using clip-rect to hide it
    // visually while keeping it in the accessibility/focus tree.
    ta.style.cssText = `
      position: fixed;
      left: -9999px;
      top: 0;
      width: 200px;
      height: 100px;
      opacity: 0.01;
      resize: none;
      border: none;
      outline: none;
      padding: 0;
      overflow: hidden;
      white-space: pre-wrap;
      font: ${this._italic ? 'italic ' : ''}${this._bold ? 'bold ' : ''}${this._fontSize}px ${this._font};
    `;

    // Set writing-mode for vertical text IME hint
    if (this._writingMode === 'vertical-rl') {
      ta.style.writingMode = 'vertical-rl';
    }

    document.body.appendChild(ta);
    this._overlayTextarea = ta;

    // ── Event handlers ──

    this._onOverlayInput = () => {
      this._text = ta.value;
      this._textDirty = true;
      this.markDirty();
      this.onChange?.();

      // Mirror to DOM element for HTML-in-Canvas visual capture
      if (this._onDomInput) this._onDomInput();
    };

    this._onOverlayKeyDown = (e: KeyboardEvent) => {
      // Escape → end editing (bubble up to the drawing service too)
      if (e.key === 'Escape') {
        this.endEditing();
        return;
      }
      // Let everything else pass through to the browser's textarea handling
      // This gives us IME, Ctrl+Z, Ctrl+A, etc. for free.
    };

    this._onOverlayBlur = () => {
      // Don't auto-end editing on blur. The textarea can lose focus when the
      // user clicks sidebar controls (font dropdown, color picker, etc.) and
      // we want editing to continue. Editing is ended explicitly by:
      //  - Pressing Escape (handled in _onOverlayKeyDown)
      //  - Clicking the canvas again (handled in Frogmarks' click handler)
      //  - Calling endEditing() from ShapeManager.endLiveTextEditing()
      //
      // We DO re-focus the textarea so the user can keep typing after
      // interacting with sidebar controls.
      setTimeout(() => {
        if (this._isEditing && this._overlayTextarea && document.activeElement !== this._overlayTextarea) {
          // Only refocus if nothing else "important" is focused
          const tag = document.activeElement?.tagName;
          if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
            this._overlayTextarea.focus({ preventScroll: true });
          }
        }
      }, 50);
    };

    ta.addEventListener('input', this._onOverlayInput);
    ta.addEventListener('keydown', this._onOverlayKeyDown);
    ta.addEventListener('blur', this._onOverlayBlur);

    // Focus after a short delay so the originating click event and Angular's
    // change detection both finish before we move focus. Using setTimeout(0)
    // instead of a microtask because Angular zone.js patches Promises.
    setTimeout(() => {
      if (this._overlayTextarea) {
        this._overlayTextarea.focus({ preventScroll: true });
        this._overlayTextarea.setSelectionRange(
          this._overlayTextarea.value.length,
          this._overlayTextarea.value.length,
        );
      }
    }, 0);
  }

  private removeOverlayTextarea(): void {
    if (!this._overlayTextarea) return;

    // Sync final text
    this._text = this._overlayTextarea.value;
    this._textDirty = true;

    // Remove handlers
    if (this._onOverlayInput) this._overlayTextarea.removeEventListener('input', this._onOverlayInput);
    if (this._onOverlayKeyDown) this._overlayTextarea.removeEventListener('keydown', this._onOverlayKeyDown);
    if (this._onOverlayBlur) this._overlayTextarea.removeEventListener('blur', this._onOverlayBlur);

    this._overlayTextarea.remove();
    this._overlayTextarea = null;
    this._onOverlayInput = null;
    this._onOverlayKeyDown = null;
    this._onOverlayBlur = null;

    this.markDirty();
    this.onChange?.();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Engine Integration — called by the renderer each frame
  // ═══════════════════════════════════════════════════════════════

  /** Provide the TextEffectEngine (called once by the renderer/manager). */
  public setEngine(engine: TextEffectEngine): void {
    this._engine = engine;
  }

  /**
   * Initialize the DOM element for HTML-in-Canvas capture.
   * Called by the renderer after the canvas has layoutsubtree set up.
   *
   * @param parentCanvas The <canvas> element to append the div to
   */
  public initDomElement(parentCanvas: HTMLCanvasElement): void {
    if (this._domElement) return;
    this._parentCanvas = parentCanvas;
    this._domElement = document.createElement('div');
    this._domElement.textContent = this._text;
    this.applyDomStyles();
    this._useHtmlCapture = TextEffectEngine.htmlInCanvasAvailable();
    // Don't append yet — only added to the canvas during editing
    // to avoid overlapping sibling DOM elements in the layoutsubtree.
  }

  /** Remove the DOM element (called on destroy). */
  public removeDomElement(): void {
    if (this._domElement) {
      this._domElement.remove();
      this._domElement = null;
    }
    this._parentCanvas = null;
  }

  /**
   * Update the output texture for this frame.
   * Called by the render strategy during scene traversal.
   *
   * @returns true if the texture was updated (re-captured or effects changed)
   */
  public updateTexture(): boolean {
    if (!this._engine) return false;

    // Re-capture source if text changed, or if we're actively editing with
    // HTML-in-Canvas (cursor blink, selection highlights, IME compositing all
    // change the visual state every frame).
    const needsCapture = this._textDirty
      || (this._isEditing && this._useHtmlCapture && this._domElement != null);

    if (needsCapture) {
      this._sourceTexture?.destroy();
      this._sourceTexture = null;

      // Only use HTML-in-Canvas capture when actively editing.
      // Non-editing nodes always use the OffscreenCanvas path to avoid
      // DOM element overlap issues (multiple <div>s stacking in the canvas).
      if (this._isEditing && this._useHtmlCapture && this._domElement) {
        try {
          const result = this._engine.captureElement(this._domElement);
          if (result) {
            this._sourceTexture = result.texture;
            this._texWidth = result.width;
            this._texHeight = result.height;
          }
        } catch {
          // "No cached paint record" — element hasn't been painted yet.
          // This happens on the first frame after adding a child to the canvas.
          // Fall through to OffscreenCanvas path; next frame will succeed.
        }
      }

      // Fallback to OffscreenCanvas
      if (!this._sourceTexture) {
        const result = this._engine.captureText(this.getCaptureConfig());
        this._sourceTexture = result.texture;
        this._texWidth = result.width;
        this._texHeight = result.height;
      }

      // Update node dimensions.
      // We keep _width/_height = 1 (unit quad) and encode the actual world-space
      // dimensions in scaleX/scaleY. This lets the existing scaling handle
      // system work correctly: it reads baseW = _width = 1, computes
      // initial.width = 1 * scaleX = effective size, and sets scaleX = newW
      // after a drag. The _localMatrix scale then gives the correct visual size
      // for rendering (localMatrix vertex = ±0.5 × scale = ±worldSize/2).
      const usedHtmlCapture = this._isEditing && this._useHtmlCapture
        && this._domElement != null;
      const dpr = usedHtmlCapture ? (window.devicePixelRatio || 1) : 1;
      const texWorldW = (this._texWidth / dpr) * this.worldUnitsPerPixel;
      const texWorldH = (this._texHeight / dpr) * this.worldUnitsPerPixel;

      // Only update scaleX/scaleY from the texture if the user hasn't manually
      // scaled the node. We detect manual scaling by checking if _hasUserScale
      // is set (the transform handler sets scaleX/scaleY directly).
      if (!this._hasUserScale) {
        this._updatingScaleFromTexture = true;
        this.scaleX = texWorldW || 0.001;
        this.scaleY = texWorldH || 0.001;
        this._updatingScaleFromTexture = false;
      }

      this._width = 1;
      this._height = 1;
      this.calculateBoundingBox();

      this._textDirty = false;
    }

    if (!this._sourceTexture) return false;

    // Apply effects
    // Don't destroy _currentTexture if it's aliased to _sourceTexture (no-effects path).
    if (this._currentTexture && this._currentTexture !== this._sourceTexture) {
      this._currentTexture.destroy();
    }
    this._currentTexture = null;

    if (this._effects.length > 0) {
      // Inject dynamic uniforms into time-based effects
      const patchedEffects = this.patchEffectsWithDynamicUniforms(this._effects);
      this._currentTexture = this._engine.applyChain(this._sourceTexture, patchedEffects);
    } else {
      // No effects — use source directly (don't destroy it!)
      this._currentTexture = this._sourceTexture;
    }

    return true;
  }

  /** Get the current output texture for rendering. */
  public getCurrentTexture(): GPUTexture | null {
    return this._currentTexture;
  }

  /** Get texture dimensions in pixels. */
  public getTextureDimensions(): { width: number; height: number } {
    return { width: this._texWidth, height: this._texHeight };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Scale override — detect user-initiated scale changes
  // ═══════════════════════════════════════════════════════════════

  public override set scaleX(value: number) {
    super.scaleX = value;
    if (!this._updatingScaleFromTexture) {
      this._hasUserScale = true;
    }
  }
  public override get scaleX(): number { return super.scaleX; }

  public override set scaleY(value: number) {
    super.scaleY = value;
    if (!this._updatingScaleFromTexture) {
      this._hasUserScale = true;
    }
  }
  public override get scaleY(): number { return super.scaleY; }

  // ═══════════════════════════════════════════════════════════════
  //  Shape interface
  // ═══════════════════════════════════════════════════════════════

  getType(): string { return 'LiveText'; }

  protected getScaleFactors(): [number, number] {
    return [1, 1];
  }

  public getGeometryVertices(): Float32Array | null {
    // LiveTextNode doesn't use the standard geometry pipeline —
    // it renders as a textured quad via the LiveTextRenderer.
    return null;
  }

  public getGeometryIndices(): Uint16Array | null {
    return null;
  }

  public calculateBoundingBox(): void {
    const hw = this._width / 2;
    const hh = this._height / 2;
    this.boundingBox.vertices = [
      [-hw, -hh],
      [hw, -hh],
      [-hw, hh],
      [hw, hh],
    ];
  }

  containsPoint(x: number, y: number): boolean {
    const inv = mat4.create();
    if (!mat4.invert(inv, this.localMatrix)) return false;
    const pt = vec3.fromValues(x, y, 0);
    vec3.transformMat4(pt, pt, inv);
    const hw = this._width / 2;
    const hh = this._height / 2;
    return Math.abs(pt[0]) <= hw && Math.abs(pt[1]) <= hh;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Serialization
  // ═══════════════════════════════════════════════════════════════

  public override toJSON(): any {
    return {
      ...super.toJSON(),
      liveTextOptions: {
        text: this._text,
        font: this._font,
        fontSize: this._fontSize,
        color: this._textColor,
        bold: this._bold,
        italic: this._italic,
        writingMode: this._writingMode,
        maxWidth: this._maxWidth,
        lineHeight: this._lineHeight,
        padding: this._padding,
        effects: this._effects,
      },
    };
  }

  static fromJSON(data: any, interactionService: InteractionService): LiveTextNode {
    const node = new LiveTextNode(interactionService, data.liveTextOptions);
    node.x = data.x ?? 0;
    node.y = data.y ?? 0;
    node.rotation = data.rotation ?? 0;
    node.scaleX = data.scaleX ?? 1;
    node.scaleY = data.scaleY ?? 1;
    if (data.id) node.setId(data.id);
    node.finalizeInitialization();
    return node;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Cleanup
  // ═══════════════════════════════════════════════════════════════

  public destroy(): void {
    this.removeOverlayTextarea();
    this.removeDomElement();
    if (this._currentTexture && this._currentTexture !== this._sourceTexture) {
      this._currentTexture.destroy();
    }
    this._sourceTexture?.destroy();
    this._currentTexture = null;
    this._sourceTexture = null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Private helpers
  // ═══════════════════════════════════════════════════════════════

  private getCaptureConfig(): TextCaptureConfig {
    return {
      text: this._text,
      font: this._font,
      fontSize: this._fontSize,
      color: [this._textColor.r, this._textColor.g, this._textColor.b, this._textColor.a],
      bold: this._bold,
      italic: this._italic,
      maxWidth: this._maxWidth > 0 ? this._maxWidth : undefined,
      lineHeight: this._lineHeight,
      writingMode: this._writingMode,
      padding: this._padding,
    };
  }

  private applyDomStyles(): void {
    if (!this._domElement) return;
    const el = this._domElement;
    const c = this._textColor;
    el.style.cssText = `
      position: absolute;
      font: ${this._italic ? 'italic ' : ''}${this._bold ? 'bold ' : ''}${this._fontSize}px ${this._font};
      color: rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a});
      writing-mode: ${this._writingMode};
      line-height: ${this._lineHeight};
      padding: ${this._padding}px;
      ${this._maxWidth > 0 ? `max-width: ${this._maxWidth}px;` : ''}
      white-space: pre-wrap;
      word-wrap: break-word;
      pointer-events: ${this._isEditing ? 'auto' : 'none'};
      user-select: ${this._isEditing ? 'text' : 'none'};
      outline: none;
      background: transparent;
      margin: 0;
      border: 0;
    `;
  }

  /**
   * Inject dynamic uniforms (time, cursor, mouseDown) into effect params.
   * For wave/glitch effects, replaces the `time` field with the current dynamic time.
   */
  private patchEffectsWithDynamicUniforms(effects: TextEffectConfig[]): TextEffectConfig[] {
    return effects.map(fx => {
      const p = { ...fx.params } as any;
      if (fx.type === 'wave' || fx.type === 'glitch') {
        p.time = this.dynamicUniforms.time;
      }
      if (fx.type === 'chromatic-aberration') {
        p.cursorUV = this.dynamicUniforms.cursorUV;
        p.mouseDown = this.dynamicUniforms.mouseDown;
      }
      if (fx.type === 'custom') {
        p.time = this.dynamicUniforms.time;
        p.cursorUV = this.dynamicUniforms.cursorUV;
        p.mouseDown = this.dynamicUniforms.mouseDown;
      }
      return { type: fx.type, params: p };
    });
  }
}
