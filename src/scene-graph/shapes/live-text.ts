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
  /** Optional filled background behind the text (a label/caption box). Omit/null = none. */
  backgroundColor?: RGBA | null;
  /** Horizontal text alignment (visible when text wraps / with maxWidth). */
  align?: 'left' | 'center' | 'right';
  /**
   * Fixed FRAME size in CSS px (from a drawn box). When frameWidth > 0 the node is a fixed
   * text frame: it stays this size (text wraps at frameWidth, top-aligned, box ≥ this size and
   * only grows if text overflows) instead of auto-fitting to its content. 0 = auto-fit (default).
   */
  frameWidth?: number;
  frameHeight?: number;
  /** Accumulated user scale baked into the size (see LiveTextNode.bakeUserScale). */
  userScaleX?: number;
  userScaleY?: number;
  /** Arc the text along a circular sweep, in degrees (0 = flat). +ve = arch up (∩, rainbow),
   *  −ve = arch down (∪). Render-only quad warp; editing happens on the flat element. */
  arcAngle?: number;
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
  private _backgroundColor: RGBA | null;
  private _align: 'left' | 'center' | 'right';
  /** Arc sweep in degrees (0 = flat). Render-only quad warp; see LiveTextOptions.arcAngle. */
  private _arcAngle = 0;
  /** Fixed frame size in CSS px (0 = auto-fit to content). See LiveTextOptions.frameWidth. */
  private _frameWidth: number;
  private _frameHeight: number;

  /**
   * World size the RENDER QUAD is drawn at — tracks the CURRENT capture, so a stale texture is
   * never stretched onto a just-resized frame (the "text pulled then snaps back" artifact while
   * drag-resizing). Differs from _width/_height only for a framed node mid-resize, where _width
   * (the selection box / hit region) is the LIVE frame size and the capture lags it by a frame.
   */
  private _renderWidth = 0;
  private _renderHeight = 0;

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
  /** Accumulated user scale folded into _width/_height (see bakeUserScale). Keeps the node's
   *  width/height = the VISUAL size with scaleX/scaleY back at 1, so anything reading
   *  node.width/height (incl. external selection UIs) gets the resized size. */
  private _userScaleX = 1;
  private _userScaleY = 1;

  // ── DOM element (for HTML-in-Canvas path) ──
  private _domElement: HTMLDivElement | null = null;
  /** Whether we're using the HTML-in-Canvas path (vs OffscreenCanvas fallback). */
  private _useHtmlCapture = false;
  /** Supersample factor for the HTML capture: the element is laid out NxN larger so its GPU
   *  texture has N× the detail (crisper when displayed/zoomed), then divided back out in
   *  _applySizeFromTexture so the on-canvas size is unchanged. The overlay transform reads
   *  the element's (now N×) natural box, so the hit region compensates automatically. */
  private _captureScale = 2;

  // ── Editing state ──
  private _isEditing = false;
  /** Overlay textarea used for text input when HTML-in-Canvas is not available. */
  private _overlayTextarea: HTMLTextAreaElement | null = null;
  /** Bound handler refs for cleanup. */
  private _onOverlayInput: (() => void) | null = null;
  private _onOverlayBlur: (() => void) | null = null;
  private _onOverlayKeyDown: ((e: KeyboardEvent) => void) | null = null;
  /** Bound handler for DOM element input (HTML-in-Canvas path). */
  private _onDomInput: (() => void) | null = null;
  /** Bound handler for contenteditable input on the inline HTML-in-Canvas element. */
  private _onDomContentInput: (() => void) | null = null;
  // §3.12: tracked setTimeout handles (blur→refocus + initial-focus) so destroy() can
  // cancel them — otherwise a pending callback can touch a destroyed node's textarea.
  private _refocusTimer: ReturnType<typeof setTimeout> | null = null;
  private _focusTimer: ReturnType<typeof setTimeout> | null = null;
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
    this._backgroundColor = options.backgroundColor ?? null;
    this._align = options.align ?? 'left';
    this._frameWidth = options.frameWidth ?? 0;
    this._frameHeight = options.frameHeight ?? 0;
    this._userScaleX = options.userScaleX ?? 1;
    this._userScaleY = options.userScaleY ?? 1;
    this._arcAngle = options.arcAngle ?? 0;
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

  get backgroundColor(): RGBA | null { return this._backgroundColor; }
  set backgroundColor(value: RGBA | null) {
    this._backgroundColor = value ? { ...value } : null;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  get align(): 'left' | 'center' | 'right' { return this._align; }
  set align(value: 'left' | 'center' | 'right') {
    this._align = value;
    this._textDirty = true;
    this.applyDomStyles();
    this.markDirty();
  }

  /** Arc sweep in degrees (0 = flat). Render-only — the capture/edit element stays flat. */
  get arcAngle(): number { return this._arcAngle; }
  set arcAngle(value: number) {
    this._arcAngle = value;
    this.markDirty(); // re-render the warped quad (no re-capture needed)
  }

  get frameWidth(): number { return this._frameWidth; }
  get frameHeight(): number { return this._frameHeight; }
  /** Set a fixed frame size in CSS px (0,0 reverts to auto-fit to content). */
  setFrame(width: number, height: number): void {
    this._frameWidth = Math.max(0, width);
    this._frameHeight = Math.max(0, height);
    this._textDirty = true;
    this.applyDomStyles();
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
  /** True for HTML-in-Canvas nodes. They must be collected for rendering even BEFORE their
   *  first onpaint capture, so the renderer can drive that capture — otherwise "no texture
   *  yet" → not collected → renderer never requestPaints → never captured (a deadlock). */
  get needsHtmlCapture(): boolean { return this._useHtmlCapture; }

  beginEditing(): void {
    if (this._isEditing) return;
    // HTML-in-Canvas: edit inline on the element itself (no blind textarea).
    if (this._useHtmlCapture && this._domElement) { this.enterEditAt(); return; }
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
    // HTML-in-Canvas: keep the element (it's the live display source) — just exit edit mode.
    if (this._useHtmlCapture && this._domElement) {
      window.getSelection()?.removeAllRanges(); // clear so it doesn't bake into the capture
      this._domElement.blur();
      // Direct toggle (not applyDomStyles) so we don't clobber the overlay transform.
      this._domElement.style.pointerEvents = 'none';
      this._domElement.style.userSelect = 'none';
      this._textDirty = true;
      this.markDirty();
      this.onChange?.();
      return;
    }
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
      // §3.12: tracked (and de-duped — repeated blurs reschedule) so destroy() can cancel.
      if (this._refocusTimer != null) clearTimeout(this._refocusTimer);
      this._refocusTimer = setTimeout(() => {
        this._refocusTimer = null;
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
    // §3.12: tracked so destroy() can cancel a still-pending focus.
    if (this._focusTimer != null) clearTimeout(this._focusTimer);
    this._focusTimer = setTimeout(() => {
      this._focusTimer = null;
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
    this._useHtmlCapture = TextEffectEngine.htmlInCanvasAvailable();
    this.applyDomStyles();
    if (this._useHtmlCapture) {
      // HTML-in-Canvas: the element lives in the canvas full-time (invisible, captured each
      // onpaint) and IS the editable surface — no blind textarea. Append now + wire input.
      this._domElement.contentEditable = 'true';
      this._domElement.spellcheck = false;
      this._onDomContentInput = () => {
        const t = this._domElement?.innerText ?? '';
        if (t !== this._text) {
          this._text = t;
          this._textDirty = true;
          this.markDirty();
          this.onChange?.();
        }
      };
      this._domElement.addEventListener('input', this._onDomContentInput);
      parentCanvas.appendChild(this._domElement);
    }
    // (OffscreenCanvas fallback: element is appended only during editing — see beginEditing.)
  }

  /** Remove the DOM element (called on destroy). */
  public removeDomElement(): void {
    if (this._domElement) {
      if (this._onDomContentInput) {
        this._domElement.removeEventListener('input', this._onDomContentInput);
        this._onDomContentInput = null;
      }
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

    if (this._useHtmlCapture && this._domElement) {
      // ── HTML-in-Canvas path ──
      // The SOURCE texture is captured live in the canvas's onpaint handler
      // (captureHtmlSource(), driven by the renderer) — NOT here — because the snapshot
      // is only fresh inside onpaint. Here we just size the node from the latest capture
      // and run the effect chain. We re-run effects every frame because the capture
      // changes each paint (caret blink, IME, selection), which is what makes it "live".
      if (!this._sourceTexture) return false;
      this._applySizeFromTexture();
    } else {
      // ── OffscreenCanvas fallback: re-capture only when the text changes. ──
      if (this._textDirty) {
        this._sourceTexture?.destroy();
        this._sourceTexture = null;
        const result = this._engine.captureText(this.getCaptureConfig());
        this._sourceTexture = result.texture;
        this._texWidth = result.width;
        this._texHeight = result.height;
        this._applySizeFromTexture();
        this._textDirty = false;
      }
    }

    if (!this._sourceTexture) return false;
    this._applyEffects();
    return true;
  }

  /**
   * Capture the live DOM element into the source texture via the confirmed two-step
   * "draw element" API. MUST be called inside the canvas's `onpaint` handler (the snapshot
   * is only current there) — the renderer drives this for every visible HTML LiveText node.
   */
  public captureHtmlSource(): void {
    if (!this._useHtmlCapture || !this._engine || !this._domElement || !this._parentCanvas) return;
    const result = this._engine.captureElement(this._domElement, this._parentCanvas);
    if (!result) return;
    const old = this._sourceTexture;
    this._sourceTexture = result.texture;
    this._texWidth = result.width;
    this._texHeight = result.height;
    // Destroy the previous source unless _currentTexture still aliases it (no-effects
    // path) — in that case the next _applyEffects() will release it when it reassigns.
    if (old && old !== this._currentTexture) old.destroy();
  }

  /**
   * Size the node from the latest source texture. _texWidth/_texHeight are DEVICE pixels
   * (the HTML capture rasterizes at the canvas BACKING resolution, per-axis), so divide by
   * the per-axis backing DPR to get CSS px before converting to world units. We keep the
   * unit-quad model (_width/_height = 1, real size in scaleX/scaleY) unless the user has
   * manually scaled the node.
   */
  private _applySizeFromTexture(): void {
    let dprX = 1, dprY = 1;
    if (this._useHtmlCapture && this._parentCanvas) {
      const cr = this._parentCanvas.getBoundingClientRect();
      dprX = this._parentCanvas.width / Math.max(1, cr.width);
      dprY = this._parentCanvas.height / Math.max(1, cr.height);
    }
    // Divide out the supersample factor so the larger capture maps to the same on-canvas size.
    const ss = this._useHtmlCapture ? this._captureScale : 1;
    // The size the CURRENT texture actually represents. The render quad is drawn at this, so a
    // stale capture is never stretched onto a freshly-resized frame (= the "text pulled then
    // snaps back" artifact while drag-resizing). _texWidth/_texHeight are DEVICE px (per-axis
    // backing DPR), so divide that out before converting to world units.
    this._renderWidth = ((this._texWidth / dprX / ss) * this.worldUnitsPerPixel * this._userScaleX) || 0.001;
    this._renderHeight = ((this._texHeight / dprY / ss) * this.worldUnitsPerPixel * this._userScaleY) || 0.001;

    if (this._frameWidth > 0) {
      // FRAMED: the node's LOGICAL size is the FRAME, not the content — it drives the selection
      // box + hit region and updates LIVE on every resize tick (the capture lags it by a frame,
      // which is exactly why the quad uses _renderWidth/_renderHeight above instead).
      this._width = (this._frameWidth * this.worldUnitsPerPixel * this._userScaleX) || 0.001;
      this._height = (this._frameHeight * this.worldUnitsPerPixel * this._userScaleY) || 0.001;
    } else {
      // AUTO-FIT: the box hugs the content, so logical size == render size.
      this._width = this._renderWidth;
      this._height = this._renderHeight;
    }
    this.calculateBoundingBox();
  }

  /**
   * World size the RENDER QUAD uses — matches the current capture so a stale texture is never
   * stretched onto a just-resized frame. Equals width/height for an auto-fit node; for a framed
   * node mid-resize it's the (one-frame-late) capture size while width/height is the live frame.
   * Falls back to the logical size before the first capture lands.
   */
  get renderWidth(): number { return this._renderWidth || this._width; }
  get renderHeight(): number { return this._renderHeight || this._height; }

  /**
   * Fold the node's current scaleX/scaleY (set by the shared transform handles) INTO _width/
   * _height via _userScale, and reset scaleX/scaleY to 1. The visual size is unchanged, but now
   * node.width/height ARE the visual size — so selection UIs that read width/height (rather than
   * the node's localMatrix) follow the resize. Call when a scale gesture ends.
   */
  public bakeUserScale(): void {
    const sx = this.scaleX ?? 1, sy = this.scaleY ?? 1;
    if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6) return;
    this._userScaleX *= sx;
    this._userScaleY *= sy;
    this.scaleX = 1;
    this.scaleY = 1;
    if (this._texWidth > 0) this._applySizeFromTexture(); else this.applyInitialSize();
    this.updateLocalMatrix();
    this.markDirty();
  }

  /**
   * Resize the TEXT FRAME to a target on-canvas (world) size. This is what the scaling handles
   * drive for a LiveText node: the box becomes the dragged size, the text reflows at its own
   * UI-set font size inside it (it does NOT scale with the box), and width/height update on this
   * very tick so the selection box / overlay track the drag live (no scaleX, so nothing to bake
   * on release). Auto-fit nodes become framed the moment they're first resized.
   */
  public resizeFrameWorld(worldW: number, worldH: number): void {
    const wupp = this.worldUnitsPerPixel || (1 / 100);
    this._frameWidth = Math.max(1, worldW / wupp);
    this._frameHeight = Math.max(1, worldH / wupp);
    // The frame carries the size now — clear any legacy uniform scale so the font stays put.
    this._userScaleX = 1;
    this._userScaleY = 1;
    this.scaleX = 1;
    this.scaleY = 1;
    // Set the on-canvas size immediately (the next capture reproduces exactly this).
    this._width = worldW;
    this._height = worldH;
    this._textDirty = true;
    this.applyDomStyles();
    this.calculateBoundingBox();
    this.updateLocalMatrix();
    this.markDirty();
  }

  /**
   * Pre-size the node immediately on creation (before the first async HTML capture) so it
   * doesn't flash at the default unit size (≈ 1 world unit, often a huge box) for a frame or
   * two. Uses the frame size if framed, else a rough font-based placeholder the capture refines.
   * Requires worldUnitsPerPixel to be set first (createLiveText does this).
   */
  public applyInitialSize(): void {
    const wupp = this.worldUnitsPerPixel;
    if (this._frameWidth > 0) {
      this._width = (this._frameWidth * wupp * this._userScaleX) || 0.001;
      this._height = (this._frameHeight * wupp * this._userScaleY) || 0.001;
    } else {
      this._width = (this._fontSize * wupp * this._userScaleX) || 0.001;
      this._height = (this._fontSize * this._lineHeight * wupp * this._userScaleY) || 0.001;
    }
    // Seed the render size too so the quad has a sane extent until the first capture lands.
    this._renderWidth = this._width;
    this._renderHeight = this._height;
    this.calculateBoundingBox();
  }

  /** Run the effect chain on the source texture into _currentTexture. */
  private _applyEffects(): void {
    if (!this._sourceTexture || !this._engine) return;
    // Don't destroy _currentTexture if it's aliased to _sourceTexture (no-effects path).
    if (this._currentTexture && this._currentTexture !== this._sourceTexture) {
      this._currentTexture.destroy();
    }
    this._currentTexture = null;
    if (this._effects.length > 0) {
      const patchedEffects = this.patchEffectsWithDynamicUniforms(this._effects);
      this._currentTexture = this._engine.applyChain(this._sourceTexture, patchedEffects);
    } else {
      this._currentTexture = this._sourceTexture; // use source directly (don't destroy it!)
    }
  }

  /**
   * Align the editable DOM element over the rendered quad so clicks/caret land on the
   * glyphs the user sees (the element's CSS transform is its hit region — it's ignored for
   * drawing but honored for hit-testing). Called every frame by the renderer with the
   * world→clip matrix and the canvas CSS size. The element's natural box is mapped onto the
   * node's on-screen quad via a full 2D affine (handles translate + scale + rotation).
   */
  public syncOverlayTransform(worldMatrix: Float32Array, cssW: number, cssH: number): void {
    if (!this._useHtmlCapture || !this._domElement) return;
    const el = this._domElement;
    const combined = mat4.create();
    mat4.multiply(combined, worldMatrix, this.localMatrix);
    const toScreen = (lx: number, ly: number): [number, number] => {
      const p = vec3.fromValues(lx, ly, 0);
      vec3.transformMat4(p, p, combined); // → NDC (perspective-divided by glMatrix)
      return [((p[0] + 1) / 2) * cssW, ((1 - p[1]) / 2) * cssH];
    };
    const hw = this._width / 2, hh = this._height / 2;
    const tl = toScreen(-hw, -hh), tr = toScreen(hw, -hh), bl = toScreen(-hw, hh);
    const natW = el.offsetWidth || 1, natH = el.offsetHeight || 1;
    const a = (tr[0] - tl[0]) / natW, b = (tr[1] - tl[1]) / natW;
    const c = (bl[0] - tl[0]) / natH, d = (bl[1] - tl[1]) / natH;
    el.style.transformOrigin = '0 0';
    el.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tl[0]}, ${tl[1]})`;
  }

  /**
   * Enter inline editing on the HTML-in-Canvas path and place the caret where the user
   * clicked (the "caret-on-entry handshake" — Salsa swallows the double-click to decide
   * intent, so the element never sees it). clientX/clientY are viewport coords.
   */
  public enterEditAt(clientX?: number, clientY?: number): void {
    if (!this._useHtmlCapture || !this._domElement) { this.beginEditing(); return; }
    this._isEditing = true;
    const el = this._domElement;
    // Toggle pointer-events DIRECTLY — NOT via applyDomStyles(), which rewrites cssText and
    // would wipe the per-frame overlay transform, snapping the element to 0,0 so the
    // caretPositionFromPoint() below would resolve at the wrong place.
    el.style.pointerEvents = 'auto';
    el.style.userSelect = 'text';
    // Focus must be DEFERRED past the originating click + Angular change detection (else the
    // browser steals focus back to the canvas and typing goes nowhere). AND a just-created
    // node's element may not be focusable for a frame or two — so RETRY across a few rAFs
    // until focus actually lands (a single setTimeout(0) was flaky for just-drawn boxes),
    // then replay the click to place the caret (a no-op for an empty node).
    let frames = 0, held = 0, placed = false;
    const grab = () => {
      if (!this._isEditing || !this._domElement) return;
      if (document.activeElement === this._domElement) {
        held++;
        // Place the caret once, the first time we actually hold focus.
        if (!placed && clientX != null && clientY != null) {
          const sel = window.getSelection();
          const docAny = document as any;
          if (typeof docAny.caretPositionFromPoint === 'function') {
            const cp = docAny.caretPositionFromPoint(clientX, clientY);
            if (cp && sel) { const r = document.createRange(); r.setStart(cp.offsetNode, cp.offset); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
          } else if (typeof docAny.caretRangeFromPoint === 'function') {
            const r = docAny.caretRangeFromPoint(clientX, clientY);
            if (r && sel) { sel.removeAllRanges(); sel.addRange(r); }
          }
          placed = true;
        }
      } else {
        held = 0;
        this._domElement.focus({ preventScroll: true });
      }
      // Keep (re)grabbing for a short window until focus is stably HELD — covers a just-created
      // element not being focusable for a frame or two, and the browser stealing focus back.
      if (++frames < 30 && held < 3) requestAnimationFrame(grab);
    };
    requestAnimationFrame(grab);
    this.markDirty();
  }

  /** Exit inline editing (delegates to endEditing, which is HTML/fallback-aware). */
  public exitEdit(): void { this.endEditing(); }

  /** Get the current output texture for rendering. */
  public getCurrentTexture(): GPUTexture | null {
    return this._currentTexture;
  }

  /** Get texture dimensions in pixels. */
  public getTextureDimensions(): { width: number; height: number } {
    return { width: this._texWidth, height: this._texHeight };
  }

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
    // Set the AABB (x/y/width/height) to the VISUAL size — `_width × scaleX`. The selection box
    // + transform handles read this AABB and do NOT re-apply the node's scaleX/scaleY (other
    // shapes work because their `_width` already IS the scaled size; LiveText keeps `_width`
    // constant with the scale in scaleX). So bake the scale in here, or the box stays put while
    // the visual grows. The local vertices above stay un-scaled for the world-polygon path.
    const sx = this.scaleX ?? 1, sy = this.scaleY ?? 1;
    const vw = this._width * sx, vh = this._height * sy;
    this.boundingBox.x = this.x - vw / 2;
    this.boundingBox.y = this.y - vh / 2;
    this.boundingBox.width = vw;
    this.boundingBox.height = vh;
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
        backgroundColor: this._backgroundColor,
        align: this._align,
        frameWidth: this._frameWidth,
        frameHeight: this._frameHeight,
        userScaleX: this._userScaleX,
        userScaleY: this._userScaleY,
        arcAngle: this._arcAngle,
        effects: this._effects,
        // Size-model marker: 'v2' = scaleX/scaleY are a pure user multiplier (size lives in
        // _width/_height, recomputed from text). Absent = legacy (scaleX/scaleY encoded the
        // visual SIZE) → the loaders reset scale to 1 so it doesn't double-apply.
        sizeModel: 'v2',
      },
    };
  }

  static fromJSON(data: any, interactionService: InteractionService): LiveTextNode {
    const node = new LiveTextNode(interactionService, data.liveTextOptions);
    node.x = data.x ?? 0;
    node.y = data.y ?? 0;
    node.rotation = data.rotation ?? 0;
    // Size-model migration: v2 stores scaleX/scaleY as a user multiplier (size = _width/_height,
    // auto-fit from text). Legacy docs encoded the visual SIZE in scaleX/scaleY — applying that
    // on top of the recomputed _width would multiply it, so reset legacy nodes to 1 and let
    // auto-fit restore the size (they were never truly hand-scaled — scaling was broken pre-v2).
    const isV2 = data.liveTextOptions?.sizeModel === 'v2';
    node.scaleX = isV2 ? (data.scaleX ?? 1) : 1;
    node.scaleY = isV2 ? (data.scaleY ?? 1) : 1;
    if (data.id) node.setId(data.id);
    node.finalizeInitialization();
    return node;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Cleanup
  // ═══════════════════════════════════════════════════════════════

  public destroy(): void {
    // §3.12: cancel pending focus/refocus timers before tearing the overlay down.
    if (this._refocusTimer != null) { clearTimeout(this._refocusTimer); this._refocusTimer = null; }
    if (this._focusTimer != null) { clearTimeout(this._focusTimer); this._focusTimer = null; }
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
    // Supersample on the HTML path: lay the element out ss× larger so the capture has more
    // detail. Pixel dimensions scale by ss; line-height (unitless) and ch/em units (relative
    // to the ss× font) do not. _applySizeFromTexture divides ss back out.
    const ss = this._useHtmlCapture ? this._captureScale : 1;
    // FRAME mode (frameWidth>0): FIXED width AND height — the box is exactly the drawn/dragged
    // size, the text reflows at its own font size inside it (clipped if it overflows), so box
    // size and text size are fully independent. Else AUTO-FIT the box to the content.
    const sizeCss = this._frameWidth > 0
      ? `box-sizing: border-box; width: ${this._frameWidth * ss}px; height: ${this._frameHeight * ss}px; overflow: hidden;`
      : `min-height: ${this._fontSize * ss}px; min-width: 1ch;` +
        (this._maxWidth > 0 ? ` max-width: ${this._maxWidth * ss}px;` : '');
    el.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      font: ${this._italic ? 'italic ' : ''}${this._bold ? 'bold ' : ''}${this._fontSize * ss}px ${this._font};
      color: rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a});
      writing-mode: ${this._writingMode};
      line-height: ${this._lineHeight};
      padding: ${this._padding * ss}px;
      ${sizeCss}
      white-space: pre-wrap;
      word-wrap: break-word;
      text-align: ${this._align};
      pointer-events: ${this._isEditing ? 'auto' : 'none'};
      user-select: ${this._isEditing ? 'text' : 'none'};
      outline: none;
      background: ${this._backgroundColor
        ? `rgba(${Math.round(this._backgroundColor.r * 255)}, ${Math.round(this._backgroundColor.g * 255)}, ${Math.round(this._backgroundColor.b * 255)}, ${this._backgroundColor.a})`
        : 'transparent'};
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
