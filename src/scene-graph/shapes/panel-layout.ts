/**
 * PanelLayout — manga/comic page panel structure.
 *
 * A PanelLayout is a Group that manages a grid of Panel nodes.
 * Each Panel is a rectangular clipping region with configurable
 * borders, gutters, and bleed margins.
 *
 * Features:
 *  • Grid-based panel creation (rows × columns)
 *  • Irregular panel splits (horizontal/vertical dividers)
 *  • Gutter width between panels
 *  • Bleed margin (artwork extends beyond trim)
 *  • Panel border rendering (customizable width + color)
 *  • Panel reordering (reading order for export)
 *  • Page templates (standard manga layouts)
 *  • Each panel can clip its children
 *
 * Usage:
 *   const layout = shapeFactory.createPanelLayout(x, y, pageW, pageH, {
 *     rows: 3, cols: 2, gutterWidth: 0.02,
 *   });
 */

import { Group } from './base/group';
import { Rectangle } from './rectangle';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';

export interface PanelDef {
  /** Unique panel id. */
  id: string;
  /** Grid position: row start (0-indexed). */
  row: number;
  /** Grid position: column start (0-indexed). */
  col: number;
  /** Number of rows this panel spans. */
  rowSpan: number;
  /** Number of columns this panel spans. */
  colSpan: number;
  /** Reading order (1-indexed, for export and numbering). */
  readingOrder: number;
}

export interface PanelLayoutOptions {
  /** Number of rows in the grid. */
  rows?: number;
  /** Number of columns in the grid. */
  cols?: number;
  /** Gutter width between panels (world units). */
  gutterWidth?: number;
  /** Bleed margin outside page bounds (world units). */
  bleedMargin?: number;
  /** Panel border width (world units). */
  borderWidth?: number;
  /** Panel border color. */
  borderColor?: RGBA;
  /** Page background color. */
  backgroundColor?: RGBA;
  /** Whether to show bleed guides. */
  showBleedGuides?: boolean;
  /** Whether to show gutter guides. */
  showGutterGuides?: boolean;
  /** Panel definitions (overrides rows/cols grid). */
  panels?: PanelDef[];
  /** Template preset name. */
  template?: PanelTemplate;
}

export type PanelTemplate =
  | 'grid-2x2'
  | 'grid-3x2'
  | 'grid-2x3'
  | 'manga-4-panel'
  | 'manga-action'
  | 'manga-dialog'
  | 'full-page'
  | 'two-strip'
  | 'three-strip'
  | 'custom';

const DEFAULT_BORDER: RGBA = { r: 0, g: 0, b: 0, a: 1 };
const DEFAULT_BG: RGBA = { r: 1, g: 1, b: 1, a: 1 };

let panelIdCounter = 0;
function makePanelId(): string {
  return `panel-${++panelIdCounter}-${Date.now().toString(36)}`;
}

export class Panel extends Group {
  readonly border: Rectangle;
  readonly clipRect: Rectangle;
  panelDef: PanelDef;

  /** The computed bounds in page-local space (set by PanelLayout.layout). */
  bounds: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };

  constructor(
    interaction: InteractionService,
    def: PanelDef,
    borderColor: RGBA,
    borderWidth: number,
  ) {
    super(interaction);
    this.panelDef = { ...def };

    // Border rectangle (rendered)
    this.border = new Rectangle(0, 0, 1, 1,
      { r: 0, g: 0, b: 0, a: 0 }, // transparent fill — only stroke
      borderColor,
      borderWidth,
      interaction,
    );
    this.border.finalizeInitialization();

    // Clip rectangle (invisible — used for clipping children during export)
    this.clipRect = new Rectangle(0, 0, 1, 1,
      { r: 0, g: 0, b: 0, a: 0 },
      { r: 0, g: 0, b: 0, a: 0 },
      0,
      interaction,
    );
    this.clipRect.finalizeInitialization();

    this.addChild(this.border);
  }

  /** Update panel size and position from computed bounds. */
  updateBounds(x: number, y: number, w: number, h: number): void {
    this.bounds = { x, y, w, h };

    // Position the panel group
    this.x = x + w / 2;
    this.y = y + h / 2;
    this.updateLocalMatrix();

    // Size the border
    this.border.scaleX = w;
    this.border.scaleY = h;
    this.border.updateLocalMatrix();
    this.border.markDirty();

    // Size the clip rect
    this.clipRect.scaleX = w;
    this.clipRect.scaleY = h;
    this.clipRect.updateLocalMatrix();

    this.markDirty();
    this.recalculateSize();
  }

  getType(): string {
    return 'Panel';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      type: this.getType(),
      panelDef: this.panelDef,
      bounds: this.bounds,
    };
  }
}

export class PanelLayout extends Group {
  private panels: Panel[] = [];
  private pageWidth: number;
  private pageHeight: number;

  // Grid config
  rows: number;
  cols: number;
  gutterWidth: number;
  bleedMargin: number;
  borderWidth: number;
  borderColor: RGBA;
  backgroundColor: RGBA;
  showBleedGuides: boolean;
  showGutterGuides: boolean;
  templateName: PanelTemplate;

  // Page background
  readonly pageBg: Rectangle;

  // Panel definitions (can be overridden for irregular layouts)
  private panelDefs: PanelDef[];

  constructor(
    interaction: InteractionService,
    pageWidth: number,
    pageHeight: number,
    options: PanelLayoutOptions = {},
  ) {
    super(interaction);

    // Panels render underneath raster layers so illustrations
    // can be drawn on top of the panel structure.
    this.renderBelowRaster = true;

    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.rows = options.rows ?? 3;
    this.cols = options.cols ?? 2;
    this.gutterWidth = options.gutterWidth ?? 0.02;
    this.bleedMargin = options.bleedMargin ?? 0.01;
    this.borderWidth = options.borderWidth ?? 0.004;
    this.borderColor = options.borderColor ? { ...options.borderColor } : { ...DEFAULT_BORDER };
    this.backgroundColor = options.backgroundColor ? { ...options.backgroundColor } : { ...DEFAULT_BG };
    this.showBleedGuides = options.showBleedGuides ?? true;
    this.showGutterGuides = options.showGutterGuides ?? true;
    this.templateName = options.template ?? 'custom';

    // Page background rect
    this.pageBg = new Rectangle(0, 0, 1, 1, this.backgroundColor, { r: 0, g: 0, b: 0, a: 0 }, 0, interaction);
    this.pageBg.scaleX = pageWidth;
    this.pageBg.scaleY = pageHeight;
    this.pageBg.finalizeInitialization();
    this.addChild(this.pageBg);

    // Build panel definitions
    if (options.panels) {
      this.panelDefs = options.panels.map(p => ({ ...p }));
    } else if (options.template && options.template !== 'custom') {
      this.panelDefs = PanelLayout.getTemplateDefinitions(options.template);
      const tmpl = PanelLayout.getTemplateGridSize(options.template);
      this.rows = tmpl.rows;
      this.cols = tmpl.cols;
    } else {
      this.panelDefs = this.generateGridDefs();
    }

    this.rebuildPanels();
    this.layout();
  }

  // ── Layout ────────────────────────────────────────────────────────

  /** Rebuild panel Group nodes from definitions. */
  private rebuildPanels(): void {
    // Remove old panels
    for (const p of this.panels) {
      this.removeChild(p);
    }
    this.panels = [];

    // Create new panels
    for (const def of this.panelDefs) {
      const panel = new Panel(this._interactionService, def, this.borderColor, this.borderWidth);
      this.panels.push(panel);
      this.addChild(panel);
    }
  }

  /** Compute and apply panel positions from the grid layout. */
  layout(): void {
    const pw = this.pageWidth;
    const ph = this.pageHeight;
    const gw = this.gutterWidth;
    const bw = this.bleedMargin;

    // Inner area (inside bleed)
    const innerX = -pw / 2 + bw;
    const innerY = -ph / 2 + bw;
    const innerW = pw - bw * 2;
    const innerH = ph - bw * 2;

    // Cell size
    const cellW = (innerW - gw * (this.cols - 1)) / this.cols;
    const cellH = (innerH - gw * (this.rows - 1)) / this.rows;

    for (const panel of this.panels) {
      const def = panel.panelDef;
      const x = innerX + def.col * (cellW + gw);
      const y = innerY + def.row * (cellH + gw);
      const w = cellW * def.colSpan + gw * (def.colSpan - 1);
      const h = cellH * def.rowSpan + gw * (def.rowSpan - 1);
      panel.updateBounds(x, y, w, h);
    }

    this.markDirty();
    this.recalculateSize();
  }

  // ── Panel management ──────────────────────────────────────────────

  /** Get all panels in reading order. */
  getPanels(): Panel[] {
    return [...this.panels].sort((a, b) => a.panelDef.readingOrder - b.panelDef.readingOrder);
  }

  /** Get a panel by id. */
  getPanel(panelId: string): Panel | undefined {
    return this.panels.find(p => p.panelDef.id === panelId);
  }

  /** Get the number of panels. */
  getPanelCount(): number {
    return this.panels.length;
  }

  /** Get panel definitions for serialization. */
  getPanelDefs(): PanelDef[] {
    return this.panelDefs.map(d => ({ ...d }));
  }

  /**
   * Split a panel horizontally (into top and bottom halves).
   * The original panel becomes the top half.
   */
  splitPanelHorizontal(panelId: string): string | null {
    const idx = this.panelDefs.findIndex(d => d.id === panelId);
    if (idx === -1) return null;
    const def = this.panelDefs[idx];
    if (def.rowSpan < 2) return null; // can't split a 1-row panel

    const newSpan = Math.floor(def.rowSpan / 2);
    const remainSpan = def.rowSpan - newSpan;

    // Shrink original
    def.rowSpan = newSpan;

    // Create new panel below
    const newDef: PanelDef = {
      id: makePanelId(),
      row: def.row + newSpan,
      col: def.col,
      rowSpan: remainSpan,
      colSpan: def.colSpan,
      readingOrder: this.panelDefs.length + 1,
    };
    this.panelDefs.push(newDef);

    this.rebuildPanels();
    this.layout();
    return newDef.id;
  }

  /**
   * Split a panel vertically (into left and right halves).
   */
  splitPanelVertical(panelId: string): string | null {
    const idx = this.panelDefs.findIndex(d => d.id === panelId);
    if (idx === -1) return null;
    const def = this.panelDefs[idx];
    if (def.colSpan < 2) return null;

    const newSpan = Math.floor(def.colSpan / 2);
    const remainSpan = def.colSpan - newSpan;

    def.colSpan = newSpan;

    const newDef: PanelDef = {
      id: makePanelId(),
      row: def.row,
      col: def.col + newSpan,
      rowSpan: def.rowSpan,
      colSpan: remainSpan,
      readingOrder: this.panelDefs.length + 1,
    };
    this.panelDefs.push(newDef);

    this.rebuildPanels();
    this.layout();
    return newDef.id;
  }

  /**
   * Merge two adjacent panels into one.
   * The second panel is removed and the first expands to fill the space.
   */
  mergePanels(panelIdA: string, panelIdB: string): boolean {
    const a = this.panelDefs.find(d => d.id === panelIdA);
    const b = this.panelDefs.find(d => d.id === panelIdB);
    if (!a || !b) return false;

    // Check adjacency: same row, adjacent columns
    if (a.row === b.row && a.rowSpan === b.rowSpan && a.col + a.colSpan === b.col) {
      a.colSpan += b.colSpan;
    }
    // Same column, adjacent rows
    else if (a.col === b.col && a.colSpan === b.colSpan && a.row + a.rowSpan === b.row) {
      a.rowSpan += b.rowSpan;
    } else {
      return false; // not adjacent
    }

    // Remove panel B
    const bIdx = this.panelDefs.indexOf(b);
    this.panelDefs.splice(bIdx, 1);

    this.rebuildPanels();
    this.layout();
    return true;
  }

  /** Remove a panel by id. */
  removePanel(panelId: string): boolean {
    const idx = this.panelDefs.findIndex(d => d.id === panelId);
    if (idx === -1) return false;
    this.panelDefs.splice(idx, 1);
    this.rebuildPanels();
    this.layout();
    return true;
  }

  /** Update reading order for all panels. */
  setReadingOrder(orderedPanelIds: string[]): void {
    for (let i = 0; i < orderedPanelIds.length; i++) {
      const def = this.panelDefs.find(d => d.id === orderedPanelIds[i]);
      if (def) def.readingOrder = i + 1;
    }
    // Update panel nodes
    for (const panel of this.panels) {
      const def = this.panelDefs.find(d => d.id === panel.panelDef.id);
      if (def) panel.panelDef.readingOrder = def.readingOrder;
    }
  }

  // ── Config ────────────────────────────────────────────────────────

  setGutterWidth(gw: number): void {
    this.gutterWidth = Math.max(0, gw);
    this.layout();
  }

  setBleedMargin(bm: number): void {
    this.bleedMargin = Math.max(0, bm);
    this.layout();
  }

  setBorderWidth(bw: number): void {
    this.borderWidth = Math.max(0, bw);
    for (const p of this.panels) {
      p.border.strokeWidth = bw;
      p.border.markDirty();
    }
  }

  setBorderColor(color: RGBA): void {
    this.borderColor = { ...color };
    for (const p of this.panels) {
      p.border.strokeColor = color;
      p.border.markDirty();
    }
  }

  setBackgroundColor(color: RGBA): void {
    this.backgroundColor = { ...color };
    this.pageBg.fillColor = color;
    this.pageBg.markDirty();
  }

  setPageSize(width: number, height: number): void {
    this.pageWidth = width;
    this.pageHeight = height;
    this.pageBg.scaleX = width;
    this.pageBg.scaleY = height;
    this.pageBg.updateLocalMatrix();
    this.pageBg.markDirty();
    this.layout();
  }

  getPageSize(): { width: number; height: number } {
    return { width: this.pageWidth, height: this.pageHeight };
  }

  /** Apply a template preset. */
  applyTemplate(template: PanelTemplate): void {
    this.templateName = template;
    if (template === 'custom') return;
    const tmpl = PanelLayout.getTemplateGridSize(template);
    this.rows = tmpl.rows;
    this.cols = tmpl.cols;
    this.panelDefs = PanelLayout.getTemplateDefinitions(template);
    this.rebuildPanels();
    this.layout();
  }

  // ── Guide data (for overlay rendering) ────────────────────────────

  /**
   * Get bleed guide lines as world-space rectangles.
   * Frogmarks renders these as dashed outlines.
   */
  getBleedGuideRect(): { x: number; y: number; w: number; h: number } {
    return {
      x: -this.pageWidth / 2 + this.bleedMargin,
      y: -this.pageHeight / 2 + this.bleedMargin,
      w: this.pageWidth - this.bleedMargin * 2,
      h: this.pageHeight - this.bleedMargin * 2,
    };
  }

  /**
   * Get gutter center lines (for rendering gutter guides).
   * Returns arrays of horizontal and vertical line positions.
   */
  getGutterGuides(): { horizontal: number[]; vertical: number[] } {
    const gw = this.gutterWidth;
    const bw = this.bleedMargin;
    const innerW = this.pageWidth - bw * 2;
    const innerH = this.pageHeight - bw * 2;
    const cellW = (innerW - gw * (this.cols - 1)) / this.cols;
    const cellH = (innerH - gw * (this.rows - 1)) / this.rows;
    const startX = -this.pageWidth / 2 + bw;
    const startY = -this.pageHeight / 2 + bw;

    const horizontal: number[] = [];
    for (let r = 1; r < this.rows; r++) {
      horizontal.push(startY + r * cellH + (r - 0.5) * gw);
    }

    const vertical: number[] = [];
    for (let c = 1; c < this.cols; c++) {
      vertical.push(startX + c * cellW + (c - 0.5) * gw);
    }

    return { horizontal, vertical };
  }

  // ── Serialization ─────────────────────────────────────────────────

  getType(): string {
    return 'Panel Layout';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      type: this.getType(),
      pageWidth: this.pageWidth,
      pageHeight: this.pageHeight,
      rows: this.rows,
      cols: this.cols,
      gutterWidth: this.gutterWidth,
      bleedMargin: this.bleedMargin,
      borderWidth: this.borderWidth,
      borderColor: this.borderColor,
      backgroundColor: this.backgroundColor,
      showBleedGuides: this.showBleedGuides,
      showGutterGuides: this.showGutterGuides,
      templateName: this.templateName,
      panels: this.panelDefs,
    };
  }

  override getWorldSpaceBoundingBoxPolygon() {
    return this.pageBg.getWorldSpaceBoundingBoxPolygon(true);
  }

  // ── Grid generation helpers ───────────────────────────────────────

  /** Generate a uniform grid of panel definitions. */
  private generateGridDefs(): PanelDef[] {
    const defs: PanelDef[] = [];
    let order = 1;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        defs.push({
          id: makePanelId(),
          row: r, col: c,
          rowSpan: 1, colSpan: 1,
          readingOrder: order++,
        });
      }
    }
    return defs;
  }

  // ── Template definitions ──────────────────────────────────────────

  static getTemplateGridSize(template: PanelTemplate): { rows: number; cols: number } {
    switch (template) {
      case 'grid-2x2': return { rows: 2, cols: 2 };
      case 'grid-3x2': return { rows: 3, cols: 2 };
      case 'grid-2x3': return { rows: 2, cols: 3 };
      case 'manga-4-panel': return { rows: 4, cols: 1 };
      case 'manga-action': return { rows: 3, cols: 2 };
      case 'manga-dialog': return { rows: 4, cols: 2 };
      case 'full-page': return { rows: 1, cols: 1 };
      case 'two-strip': return { rows: 2, cols: 1 };
      case 'three-strip': return { rows: 3, cols: 1 };
      default: return { rows: 3, cols: 2 };
    }
  }

  static getTemplateDefinitions(template: PanelTemplate): PanelDef[] {
    switch (template) {
      case 'manga-4-panel':
        return [
          { id: makePanelId(), row: 0, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 1 },
          { id: makePanelId(), row: 1, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 2 },
          { id: makePanelId(), row: 2, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 3 },
          { id: makePanelId(), row: 3, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 4 },
        ];
      case 'manga-action':
        // Big panel top spanning full width, 2 smaller panels below
        return [
          { id: makePanelId(), row: 0, col: 0, rowSpan: 1, colSpan: 2, readingOrder: 1 },
          { id: makePanelId(), row: 1, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 2 },
          { id: makePanelId(), row: 1, col: 1, rowSpan: 1, colSpan: 1, readingOrder: 3 },
          { id: makePanelId(), row: 2, col: 0, rowSpan: 1, colSpan: 2, readingOrder: 4 },
        ];
      case 'manga-dialog':
        // Alternating wide and narrow panels for dialog sequences
        return [
          { id: makePanelId(), row: 0, col: 0, rowSpan: 1, colSpan: 2, readingOrder: 1 },
          { id: makePanelId(), row: 1, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 2 },
          { id: makePanelId(), row: 1, col: 1, rowSpan: 1, colSpan: 1, readingOrder: 3 },
          { id: makePanelId(), row: 2, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 4 },
          { id: makePanelId(), row: 2, col: 1, rowSpan: 1, colSpan: 1, readingOrder: 5 },
          { id: makePanelId(), row: 3, col: 0, rowSpan: 1, colSpan: 2, readingOrder: 6 },
        ];
      case 'full-page':
        return [
          { id: makePanelId(), row: 0, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 1 },
        ];
      case 'two-strip':
        return [
          { id: makePanelId(), row: 0, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 1 },
          { id: makePanelId(), row: 1, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 2 },
        ];
      case 'three-strip':
        return [
          { id: makePanelId(), row: 0, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 1 },
          { id: makePanelId(), row: 1, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 2 },
          { id: makePanelId(), row: 2, col: 0, rowSpan: 1, colSpan: 1, readingOrder: 3 },
        ];
      default: {
        // For grid-based templates, generate uniform grid
        const size = PanelLayout.getTemplateGridSize(template);
        const defs: PanelDef[] = [];
        let order = 1;
        for (let r = 0; r < size.rows; r++) {
          for (let c = 0; c < size.cols; c++) {
            defs.push({
              id: makePanelId(),
              row: r, col: c,
              rowSpan: 1, colSpan: 1,
              readingOrder: order++,
            });
          }
        }
        return defs;
      }
    }
  }
}
