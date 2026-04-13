/**
 * LiveTextDrawingService — Tool service for creating and editing LiveTextNode instances.
 *
 * When the Text tool is active and HTML-in-Canvas is available, this service
 * handles canvas clicks to create LiveTextNode instances. The browser handles
 * all text editing (IME, cursor, selection) via the hidden DOM element.
 *
 * Keyboard events: delegated to the browser (contentEditable div).
 * Mouse events: click to create / select, double-click to edit.
 */

import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { ShapeFactory } from '../../scene-graph/core/shape-factory';
import { InteractionService } from '../interaction-service';
import { RGBA } from '../../types/rgba';
import { LiveTextNode } from '../../scene-graph/shapes/live-text';
import { TextEffectEngine, TextEffectConfig } from '../../renderer/raster/effects/text-effect-engine';

export class LiveTextDrawingService {
  private interactionService: InteractionService;
  private sceneGraph: SceneGraph;
  private shapeFactory: ShapeFactory;
  private engine: TextEffectEngine | null = null;

  public isEnabled = false;
  private activeNode: LiveTextNode | null = null;

  // Current tool settings
  private currentFont = 'Arial';
  private currentFontSize = 48;
  private currentColor: RGBA = { r: 0, g: 0, b: 0, a: 1 };
  private currentBold = false;
  private currentItalic = false;
  private currentWritingMode: 'horizontal-tb' | 'vertical-rl' = 'horizontal-tb';
  private currentEffects: TextEffectConfig[] = [];
  private currentPadding = 16;

  constructor(
    interactionService: InteractionService,
    sceneGraph: SceneGraph,
    shapeFactory: ShapeFactory,
  ) {
    this.interactionService = interactionService;
    this.sceneGraph = sceneGraph;
    this.shapeFactory = shapeFactory;
    this.attachEventListeners();
  }

  public setEngine(engine: TextEffectEngine): void {
    this.engine = engine;
  }

  enable(): void {
    this.isEnabled = true;
    this.interactionService.clearSelectedNodes();
  }

  disable(): void {
    this.isEnabled = false;
    this.finalizeEditing();
  }

  // ── Event handling ──────────────────────────────────────────────

  private onPointerDownBound = (e: PointerEvent) => this.onPointerDown(e);
  private onKeyDownBound = (e: KeyboardEvent) => this.onKeyDown(e);

  private attachEventListeners(): void {
    const canvas = this.interactionService.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDownBound);
    window.addEventListener('keydown', this.onKeyDownBound);
  }

  public reinitializeEventListeners(): void {
    const canvas = this.interactionService.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDownBound);
    window.removeEventListener('keydown', this.onKeyDownBound);
    this.attachEventListeners();
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.isEnabled) return;

    const { x, y } = this.interactionService.toWorldCoords(e);

    // If clicking on the active node, let the browser handle it (contentEditable)
    if (this.activeNode && this.activeNode.containsPoint(x, y)) {
      return;
    }

    // Finalize current editing
    if (this.activeNode) {
      this.finalizeEditing();
    }

    // Check if clicking on an existing LiveTextNode
    let clickedNode: LiveTextNode | null = null;
    this.sceneGraph.root.forEachDeep((n) => {
      if (n instanceof LiveTextNode && (n as LiveTextNode).containsPoint(x, y)) {
        clickedNode = n as LiveTextNode;
      }
    });

    if (clickedNode !== null) {
      this.activeNode = clickedNode as LiveTextNode;
      (this.activeNode as LiveTextNode).beginEditing();
      this.interactionService.requestRender();
      return;
    }

    // Create a new LiveTextNode at the click position
    const node = this.shapeFactory.createLiveText(x, y, {
      text: '',
      font: this.currentFont,
      fontSize: this.currentFontSize,
      color: { ...this.currentColor },
      bold: this.currentBold,
      italic: this.currentItalic,
      writingMode: this.currentWritingMode,
      padding: this.currentPadding,
      effects: [...this.currentEffects],
    });

    // Wire up the engine
    if (this.engine) node.setEngine(this.engine);

    // Init DOM element for HTML-in-Canvas
    const canvas = this.interactionService.canvas;
    if (TextEffectEngine.htmlInCanvasAvailable()) {
      node.initDomElement(canvas);
    }

    // Add to scene
    this.sceneGraph.root.addChild(node);
    this.activeNode = node;
    node.beginEditing();

    this.interactionService.onSceneGraphChanged.emit();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.isEnabled || !this.activeNode) return;

    // Escape: finalize editing
    if (e.key === 'Escape') {
      this.finalizeEditing();
      return;
    }

    // Enter (without Shift): finalize editing
    if (e.key === 'Enter' && !e.shiftKey) {
      this.finalizeEditing();
      return;
    }

    // All other keys are handled by the browser via the contentEditable div.
    // We just need to mark the node dirty so it re-captures next frame.
    this.activeNode.isDirty = true;
    this.interactionService.requestRender();
  }

  private finalizeEditing(): void {
    if (!this.activeNode) return;

    this.activeNode.endEditing();

    // Remove empty text nodes
    if (this.activeNode.text.trim() === '') {
      this.activeNode.destroy();
      this.sceneGraph.root.removeChild(this.activeNode);
    }

    this.activeNode = null;
    this.interactionService.onSceneGraphChanged.emit();
  }

  // ── Tool property setters ─────────────────────────────────────

  public setFont(font: string): void {
    this.currentFont = font;
    if (this.activeNode) this.activeNode.font = font;
  }

  public setFontSize(size: number): void {
    this.currentFontSize = size;
    if (this.activeNode) this.activeNode.fontSize = size;
  }

  public setTextColor(color: RGBA): void {
    this.currentColor = { ...color };
    if (this.activeNode) this.activeNode.textColor = color;
  }

  public setBold(bold: boolean): void {
    this.currentBold = bold;
    if (this.activeNode) this.activeNode.bold = bold;
  }

  public setItalic(italic: boolean): void {
    this.currentItalic = italic;
    if (this.activeNode) this.activeNode.italic = italic;
  }

  public setWritingMode(mode: 'horizontal-tb' | 'vertical-rl'): void {
    this.currentWritingMode = mode;
    if (this.activeNode) this.activeNode.writingMode = mode;
  }

  public setEffects(effects: TextEffectConfig[]): void {
    this.currentEffects = [...effects];
    if (this.activeNode) this.activeNode.setEffects(effects);
  }

  public getActiveNode(): LiveTextNode | null {
    return this.activeNode;
  }
}
