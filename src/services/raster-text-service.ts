/**
 * RasterTextService — manages the raster text tool lifecycle.
 *
 * Workflow:
 *  1. User enables the raster text tool → clicks on the canvas → text entry begins.
 *  2. A floating overlay shows a live preview of what will be stamped.
 *  3. User types, adjusts font/size/color, moves the text position.
 *  4. User presses Enter (or clicks "Commit") → text is stamped onto the active raster layer.
 *  5. User presses Escape → text entry is cancelled.
 *
 * The text is editable during preview but becomes pixels on commit (non-editable).
 */

import { InteractionService } from './interaction-service';
import { WebGPURenderer } from '../renderer/core/webgpu-renderer';
import { RasterTextStamp, TextStampParams } from '../renderer/raster/core/raster-text-stamp';
import { EventEmitter } from '../renderer/util/event-emitter';
import { addZonelessListener, removeZonelessListener } from '../renderer/util/zoneless-listeners';

export interface RasterTextState {
  /** Whether a text entry is currently in progress. */
  isActive: boolean;
  /** Current text content. */
  text: string;
  /** Position in texel space. */
  destX: number;
  destY: number;
  /** Font settings. */
  font: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** Text color [r, g, b, a] in 0-1. */
  color: [number, number, number, number];
  /** Max width for word-wrapping (texels). 0 = no wrap. */
  maxWidth: number;
  /** Line height multiplier. */
  lineHeight: number;
  /** Caret index for editing. */
  caretIndex: number;
}

export class RasterTextService {
  private interactionService: InteractionService;
  private renderer: WebGPURenderer;
  private textStamp: RasterTextStamp | null = null;
  public isEnabled = false;

  // Current text entry state
  private state: RasterTextState = {
    isActive: false,
    text: '',
    destX: 0,
    destY: 0,
    font: 'Arial',
    fontSize: 32,
    bold: false,
    italic: false,
    align: 'left',
    color: [0, 0, 0, 1],
    maxWidth: 0,
    lineHeight: 1.2,
    caretIndex: 0,
  };

  // Preview texture for overlay rendering
  private previewCanvas: OffscreenCanvas | null = null;
  private previewWidth = 0;
  private previewHeight = 0;
  private previewGPUTex: GPUTexture | null = null;

  /** Emitted when text state changes (for UI updates). */
  public onStateChanged = new EventEmitter<RasterTextState>();

  // Bound event handlers
  private handleClickBound = (e: PointerEvent) => this.handleClick(e);
  private handleKeyBound = (e: KeyboardEvent) => this.handleKey(e);

  constructor(interactionService: InteractionService, renderer: WebGPURenderer) {
    this.interactionService = interactionService;
    this.renderer = renderer;
    this.attachListeners();
  }

  // ── Public API ────────────────────────────────────────────────────

  public enable(): void {
    this.isEnabled = true;
    this.interactionService.clearSelectedNodes();
  }

  public disable(): void {
    if (this.state.isActive) {
      this.commit();
    }
    this.isEnabled = false;
  }

  /** Get the current text state (for UI binding). */
  public getState(): Readonly<RasterTextState> {
    return { ...this.state };
  }

  /** Update text properties during preview (font, size, color, etc.). */
  public updateProperties(props: Partial<Pick<RasterTextState,
    'font' | 'fontSize' | 'bold' | 'italic' | 'align' | 'color' | 'maxWidth' | 'lineHeight'
  >>): void {
    Object.assign(this.state, props);
    if (this.state.isActive) {
      this.refreshPreview();
    }
    this.emitState();
  }

  /** Move the text position (in texel space). */
  public setPosition(destX: number, destY: number): void {
    this.state.destX = destX;
    this.state.destY = destY;
    this.emitState();
    this.renderer.scheduleRender();
  }

  /** Commit (stamp) the text onto the active raster layer. */
  public commit(): void {
    if (!this.state.isActive || !this.state.text.trim()) {
      this.cancel();
      return;
    }

    this.ensureTextStamp();
    const engine = this.renderer.rasterPaintEngine;
    const target = engine?.getActiveTexture();
    if (!target || !this.textStamp) {
      this.cancel();
      return;
    }

    // Push undo snapshot before stamping
    engine?.snapshotManager.pushSnapshot(target).catch(console.warn);
    // Also push to the layer manager's per-layer undo stack (rasterUndo reads from there)
    const layerMgr = (this.renderer as any).rasterLayerManager;
    const selectedId = layerMgr?.getSelectedLayerId?.();
    if (selectedId && layerMgr) {
      layerMgr.pushSnapshotForLayer(selectedId);
    }

    // Stamp text onto the layer
    this.textStamp.stamp(target, this.buildStampParams());

    // Clean up
    this.clearPreview();
    this.state.isActive = false;
    this.state.text = '';
    this.state.caretIndex = 0;
    this.emitState();
    this.renderer.scheduleRender();
  }

  /** Cancel text entry without stamping. */
  public cancel(): void {
    this.clearPreview();
    this.state.isActive = false;
    this.state.text = '';
    this.state.caretIndex = 0;
    this.emitState();
    this.renderer.scheduleRender();
  }

  /** Get the preview texture for overlay rendering (if any). */
  public getPreviewTexture(): GPUTexture | null {
    return this.previewGPUTex;
  }

  /** Get the preview dimensions. */
  public getPreviewInfo(): { destX: number; destY: number; width: number; height: number } | null {
    if (!this.state.isActive || !this.previewGPUTex) return null;
    return {
      destX: this.state.destX,
      destY: this.state.destY,
      width: this.previewWidth,
      height: this.previewHeight,
    };
  }

  public destroy(): void {
    this.removeListeners();
    this.clearPreview();
    this.textStamp?.destroy();
  }

  // ── Event handling ────────────────────────────────────────────────

  private attachListeners(): void {
    const canvas = this.interactionService.canvas;
    addZonelessListener(canvas, 'pointerdown', this.handleClickBound);
    window.addEventListener('keydown', this.handleKeyBound);
  }

  private removeListeners(): void {
    const canvas = this.interactionService.canvas;
    removeZonelessListener(canvas, 'pointerdown', this.handleClickBound);
    window.removeEventListener('keydown', this.handleKeyBound);
  }

  private handleClick(e: PointerEvent): void {
    if (!this.isEnabled || e.button !== 0) return;

    const texel = this.toTexelCoords(e);

    if (this.state.isActive) {
      // If clicking far away from text, commit and start fresh
      this.commit();
    }

    // Start new text entry at click position
    this.state.isActive = true;
    this.state.text = '';
    this.state.caretIndex = 0;
    this.state.destX = texel.x;
    this.state.destY = texel.y;
    this.emitState();
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.isEnabled || !this.state.isActive) return;

    const ctrl = e.ctrlKey || e.metaKey;

    // Enter → commit
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.commit();
      return;
    }

    // Shift+Enter → newline
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      this.insertAtCaret('\n');
      return;
    }

    // Escape → cancel
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
      return;
    }

    // Select All
    if (ctrl && e.key === 'a') {
      e.preventDefault();
      this.state.caretIndex = this.state.text.length;
      return;
    }

    // Backspace
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (this.state.caretIndex > 0) {
        const idx = this.state.caretIndex;
        this.state.text = this.state.text.substring(0, idx - 1) + this.state.text.substring(idx);
        this.state.caretIndex = idx - 1;
        this.refreshPreview();
        this.emitState();
      }
      return;
    }

    // Delete
    if (e.key === 'Delete') {
      e.preventDefault();
      if (this.state.caretIndex < this.state.text.length) {
        const idx = this.state.caretIndex;
        this.state.text = this.state.text.substring(0, idx) + this.state.text.substring(idx + 1);
        this.refreshPreview();
        this.emitState();
      }
      return;
    }

    // Arrow keys
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.state.caretIndex = Math.max(0, this.state.caretIndex - 1);
      this.emitState();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.state.caretIndex = Math.min(this.state.text.length, this.state.caretIndex + 1);
      this.emitState();
      return;
    }

    // Home / End
    if (e.key === 'Home') {
      e.preventDefault();
      this.state.caretIndex = 0;
      this.emitState();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      this.state.caretIndex = this.state.text.length;
      this.emitState();
      return;
    }

    // Printable character
    if (e.key.length === 1 && !ctrl) {
      e.preventDefault();
      this.insertAtCaret(e.key);
      return;
    }
  }

  private insertAtCaret(str: string): void {
    const idx = this.state.caretIndex;
    this.state.text = this.state.text.substring(0, idx) + str + this.state.text.substring(idx);
    this.state.caretIndex = idx + str.length;
    this.refreshPreview();
    this.emitState();
  }

  // ── Preview ───────────────────────────────────────────────────────

  private refreshPreview(): void {
    this.ensureTextStamp();
    if (!this.textStamp || !this.state.text) {
      this.clearPreview();
      this.renderer.scheduleRender();
      return;
    }

    const { canvas, width, height } = this.textStamp.rasterizeText(this.buildStampParams());
    this.previewCanvas = canvas;
    this.previewWidth = width;
    this.previewHeight = height;

    // Upload to GPU for overlay rendering
    this.previewGPUTex?.destroy();
    if (width > 0 && height > 0) {
      this.previewGPUTex = this.renderer.getDevice().createTexture({
        label: 'RasterTextPreview',
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const bitmap = canvas.transferToImageBitmap();
      this.renderer.getDevice().queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.previewGPUTex },
        { width, height },
      );
      bitmap.close();
    } else {
      this.previewGPUTex = null;
    }

    this.renderer.scheduleRender();
  }

  private clearPreview(): void {
    this.previewGPUTex?.destroy();
    this.previewGPUTex = null;
    this.previewCanvas = null;
    this.previewWidth = 0;
    this.previewHeight = 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private ensureTextStamp(): void {
    if (!this.textStamp) {
      this.textStamp = new RasterTextStamp(this.renderer.getDevice());
    }
  }

  private buildStampParams(): TextStampParams {
    return {
      text: this.state.text,
      font: this.state.font,
      fontSize: this.state.fontSize,
      color: this.state.color,
      bold: this.state.bold,
      italic: this.state.italic,
      align: this.state.align,
      maxWidth: this.state.maxWidth || undefined,
      lineHeight: this.state.lineHeight,
      destX: this.state.destX,
      destY: this.state.destY,
    };
  }

  private toTexelCoords(ev: PointerEvent): { x: number; y: number } {
    const world = this.interactionService.toWorldCoords(ev);
    const texSize = this.renderer.getRasterTextureSize?.() ?? {
      w: this.interactionService.canvas.width,
      h: this.interactionService.canvas.height,
    };
    const texW = texSize.w || 1;
    const texH = texSize.h || 1;

    const isIll = this.renderer.getIllustrationMode();
    let worldQuadW = 2.0;
    let worldQuadH = 2.0;

    if (isIll) {
      const ib = this.renderer.getIllustrationBounds();
      if (ib && ib.width > 0 && ib.height > 0) {
        worldQuadW = ib.width;
        worldQuadH = ib.height;
      }
    }

    const hw = worldQuadW * 0.5;
    const hh = worldQuadH * 0.5;

    const u = (world.x + hw) / worldQuadW;
    const v = (hh - world.y) / worldQuadH;

    let tx = Math.floor(u * texW);
    let ty = Math.floor(v * texH);
    tx = Math.max(0, Math.min(texW - 1, tx));
    ty = Math.max(0, Math.min(texH - 1, ty));

    return { x: tx, y: ty };
  }

  private emitState(): void {
    this.onStateChanged.emit({ ...this.state });
  }
}
