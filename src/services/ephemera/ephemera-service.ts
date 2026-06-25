import type {
  IEphemeraGenerator,
  EphemeraElement,
  EphemeraElementSheet,
  EphemeraCategory,
  EphemeraPlacement,
} from './ephemera-types';
import { EPHEMERA_CATEGORIES } from './ephemera-types';
import { decorateEphemeraSvg } from './svg-effects';

// ── Phase 1 generators ────────────────────────────────────────────────────
import { BarcodeCode128Generator }      from './generators/barcode-code128';
import { GlobeOrthographicGenerator }   from './generators/globe-orthographic';
import { CrosshairGenerator }           from './generators/crosshair';
import { WarningLabelGenerator }        from './generators/warning-label';
import { SerialStringGenerator }        from './generators/serial-string';
import { MotionLinesGenerator }         from './generators/motion-lines';

// ── Phase 2 generators ────────────────────────────────────────────────────
import { BarcodeEAN13Generator }        from './generators/barcode-ean13';
import { BarcodeUPCAGenerator }         from './generators/barcode-upca';
import { GlobeMollweideGenerator }      from './generators/globe-mollweide';
import { RegistrationMarksGenerator }   from './generators/registration-marks';
import { WaveformGenerator }            from './generators/waveform';
import { GeometricFrameGenerator }      from './generators/geometric-frame';
import { StarsSparklesGenerator }       from './generators/stars-sparkles';

// ── Retro polish kit ──────────────────────────────────────────────────────
import { WornEdgesGenerator }           from './generators/worn-edges';
import { MediaIconsGenerator }          from './generators/media-icons';
import { HoloSealGenerator }            from './generators/holo-seal';
import { BadgeGenerator }               from './generators/badge';
import { MemphisGenerator }             from './generators/memphis';
import { HalftoneGenerator }            from './generators/halftone';
import { ScanlineGenerator }            from './generators/scanline';
import { RainbowStripGenerator }        from './generators/rainbow-strip';
import { WireframeGenerator }           from './generators/wireframe';

const ALL_GENERATORS: IEphemeraGenerator[] = [
  // Barcodes (1D)
  new BarcodeCode128Generator(),
  new BarcodeEAN13Generator(),
  new BarcodeUPCAGenerator(),
  // Globe
  new GlobeOrthographicGenerator(),
  new GlobeMollweideGenerator(),
  // Crosshair
  new CrosshairGenerator(),
  // Warning Labels
  new WarningLabelGenerator(),
  // Serial Strings
  new SerialStringGenerator(),
  // Motion Lines
  new MotionLinesGenerator(),
  // Phase 2
  new RegistrationMarksGenerator(),
  new WaveformGenerator(),
  new GeometricFrameGenerator(),
  new StarsSparklesGenerator(),
  // Retro polish kit
  new WornEdgesGenerator(),
  new MediaIconsGenerator(),
  new HoloSealGenerator(),
  new BadgeGenerator(),
  new MemphisGenerator(),
  new HalftoneGenerator(),
  new ScanlineGenerator(),
  new RainbowStripGenerator(),
  new WireframeGenerator(),
];

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const DEFAULT_SHEET_ID = 'default';

/** File format tag for .ephemera import/export. */
const EPHEMERA_FORMAT = 'frogmarks-ephemera';

export class EphemeraService {
  private _generators = new Map<string, IEphemeraGenerator>();
  private _sheets: EphemeraElementSheet[] = [];
  /** Placements keyed by ephemera layerId. */
  private _placements = new Map<string, EphemeraPlacement[]>();

  constructor() {
    for (const g of ALL_GENERATORS) {
      this._generators.set(g.typeId, g);
    }
    this._sheets.push({
      id: DEFAULT_SHEET_ID,
      name: 'Default Sheet',
      elements: [],
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    });
  }

  // ── Registry ─────────────────────────────────────────────────────────────

  getCategories(): EphemeraCategory[] {
    const used = new Set(ALL_GENERATORS.map(g => g.categoryId));
    return EPHEMERA_CATEGORIES.filter(c => used.has(c.id));
  }

  getGeneratorsByCategory(categoryId: string): IEphemeraGenerator[] {
    return ALL_GENERATORS.filter(g => g.categoryId === categoryId);
  }

  getGenerator(typeId: string): IEphemeraGenerator | undefined {
    return this._generators.get(typeId);
  }

  getDefaultParams(typeId: string): Record<string, unknown> {
    return this._generators.get(typeId)?.getDefaultParams() ?? {};
  }

  // ── Generation ───────────────────────────────────────────────────────────

  generate(typeId: string, params: Record<string, unknown>): string {
    const gen = this._generators.get(typeId);
    if (!gen) return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>';
    return gen.generate(params);
  }

  // ── Sheet management ─────────────────────────────────────────────────────

  getSheets(): EphemeraElementSheet[] {
    return this._sheets;
  }

  getSheet(id: string): EphemeraElementSheet | undefined {
    return this._sheets.find(s => s.id === id);
  }

  createSheet(name: string): EphemeraElementSheet {
    const sheet: EphemeraElementSheet = {
      id: makeId(),
      name,
      elements: [],
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    };
    this._sheets.push(sheet);
    return sheet;
  }

  renameSheet(id: string, name: string): boolean {
    const sheet = this._sheets.find(s => s.id === id);
    if (!sheet) return false;
    sheet.name = name;
    sheet.modifiedAt = Date.now();
    return true;
  }

  deleteSheet(id: string): boolean {
    if (id === DEFAULT_SHEET_ID) return false;
    const idx = this._sheets.findIndex(s => s.id === id);
    if (idx === -1) return false;
    this._sheets.splice(idx, 1);
    return true;
  }

  // ── Element management ───────────────────────────────────────────────────

  addElement(
    typeId: string,
    params: Record<string, unknown>,
    label?: string,
    sheetId: string = DEFAULT_SHEET_ID,
  ): EphemeraElement | null {
    const sheet = this._sheets.find(s => s.id === sheetId);
    if (!sheet) return null;
    const gen = this._generators.get(typeId);
    if (!gen) return null;

    const el: EphemeraElement = {
      id: makeId(),
      typeId,
      label: label ?? gen.displayName,
      params: { ...params },
      svg: gen.generate(params),
      createdAt: Date.now(),
    };
    sheet.elements.push(el);
    sheet.modifiedAt = Date.now();
    return el;
  }

  updateElement(
    sheetId: string,
    elementId: string,
    params: Record<string, unknown>,
    label?: string,
  ): boolean {
    const sheet = this._sheets.find(s => s.id === sheetId);
    if (!sheet) return false;
    const el = sheet.elements.find(e => e.id === elementId);
    if (!el) return false;
    const gen = this._generators.get(el.typeId);
    if (!gen) return false;

    el.params = { ...params };
    el.svg = gen.generate(params);
    if (label !== undefined) el.label = label;
    sheet.modifiedAt = Date.now();
    return true;
  }

  deleteElement(sheetId: string, elementId: string): boolean {
    const sheet = this._sheets.find(s => s.id === sheetId);
    if (!sheet) return false;
    const idx = sheet.elements.findIndex(e => e.id === elementId);
    if (idx === -1) return false;
    sheet.elements.splice(idx, 1);
    sheet.modifiedAt = Date.now();
    return true;
  }

  duplicateElement(sheetId: string, elementId: string): EphemeraElement | null {
    const sheet = this._sheets.find(s => s.id === sheetId);
    if (!sheet) return null;
    const el = sheet.elements.find(e => e.id === elementId);
    if (!el) return null;

    const copy: EphemeraElement = {
      ...el,
      id: makeId(),
      label: el.label + ' copy',
      params: { ...el.params },
      createdAt: Date.now(),
    };
    sheet.elements.push(copy);
    sheet.modifiedAt = Date.now();
    return copy;
  }

  moveElement(fromSheetId: string, toSheetId: string, elementId: string): boolean {
    const from = this._sheets.find(s => s.id === fromSheetId);
    const to   = this._sheets.find(s => s.id === toSheetId);
    if (!from || !to) return false;
    const idx = from.elements.findIndex(e => e.id === elementId);
    if (idx === -1) return false;
    const [el] = from.elements.splice(idx, 1);
    to.elements.push(el);
    from.modifiedAt = Date.now();
    to.modifiedAt   = Date.now();
    return true;
  }

  // ── Canvas placements (Phase 3) ──────────────────────────────────────────

  getPlacementsForLayer(layerId: string): EphemeraPlacement[] {
    return this._placements.get(layerId) ?? [];
  }

  getAllPlacements(): Map<string, EphemeraPlacement[]> {
    return this._placements;
  }

  addPlacement(
    layerId: string,
    typeId: string,
    params: Record<string, unknown>,
    x: number,
    y: number,
    width: number,
    height: number,
    rotation = 0,
    opacity = 1,
  ): EphemeraPlacement | null {
    const gen = this._generators.get(typeId);
    if (!gen) return null;

    const placement: EphemeraPlacement = {
      id: makeId(),
      layerId,
      typeId,
      params: { ...params },
      svg: gen.generate(params),
      x, y, width, height,
      rotation,
      opacity,
      blendMode: 'source-over',
      visible: true,
    };

    if (!this._placements.has(layerId)) this._placements.set(layerId, []);
    this._placements.get(layerId)!.push(placement);
    return placement;
  }

  updatePlacement(
    layerId: string,
    placementId: string,
    updates: Partial<Pick<EphemeraPlacement, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'visible' | 'params' | 'blendMode' | 'glow' | 'feather'>>,
  ): boolean {
    const list = this._placements.get(layerId);
    if (!list) return false;
    const p = list.find(x => x.id === placementId);
    if (!p) return false;

    Object.assign(p, updates);
    // Re-generate (from params) + re-decorate (glow/feather) if any of those changed. Always start
    // from the base generation so decoration never double-wraps.
    if (updates.params !== undefined || updates.glow !== undefined || updates.feather !== undefined) {
      const gen = this._generators.get(p.typeId);
      if (gen) p.svg = decorateEphemeraSvg(gen.generate(p.params), p.glow, p.feather);
    }
    return true;
  }

  deletePlacement(layerId: string, placementId: string): boolean {
    const list = this._placements.get(layerId);
    if (!list) return false;
    const idx = list.findIndex(x => x.id === placementId);
    if (idx < 0) return false;
    list.splice(idx, 1);
    return true;
  }

  deleteAllPlacementsForLayer(layerId: string): void {
    this._placements.delete(layerId);
  }

  // ── 3D Texture Export ─────────────────────────────────────────────────────

  async exportAs3DTexture(typeId: string, params: Record<string, unknown>, size: number): Promise<Blob> {
    const svg = this.generate(typeId, params);
    const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
    const bitmap = await createImageBitmap(svgBlob, { resizeWidth: size, resizeHeight: size });
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
    return canvas.convertToBlob({ type: 'image/png' });
  }

  // ── Import / Export (.ephemera) ──────────────────────────────────────────

  exportSheet(sheetId: string): Blob | null {
    const sheet = this._sheets.find(s => s.id === sheetId);
    if (!sheet) return null;
    const payload = JSON.stringify({ format: EPHEMERA_FORMAT, version: 1, sheets: [sheet] }, null, 2);
    return new Blob([payload], { type: 'application/json' });
  }

  exportElement(sheetId: string, elementId: string): Blob | null {
    const sheet = this._sheets.find(s => s.id === sheetId);
    if (!sheet) return null;
    const el = sheet.elements.find(e => e.id === elementId);
    if (!el) return null;
    const singleSheet: EphemeraElementSheet = {
      id: makeId(),
      name: sheet.name,
      elements: [el],
      createdAt: sheet.createdAt,
      modifiedAt: sheet.modifiedAt,
    };
    const payload = JSON.stringify({ format: EPHEMERA_FORMAT, version: 1, sheets: [singleSheet] }, null, 2);
    return new Blob([payload], { type: 'application/json' });
  }

  exportAllSheets(): Blob {
    const payload = JSON.stringify({ format: EPHEMERA_FORMAT, version: 1, sheets: this._sheets }, null, 2);
    return new Blob([payload], { type: 'application/json' });
  }

  async importFromBlob(blob: Blob, onConflict: 'merge' | 'new' = 'new'): Promise<EphemeraElementSheet[]> {
    const text = await blob.text();
    const data = JSON.parse(text) as { format?: string; version?: number; sheets: EphemeraElementSheet[] };

    if (data.format !== EPHEMERA_FORMAT) throw new Error('Not a .ephemera file');
    if (!Array.isArray(data.sheets)) throw new Error('Invalid .ephemera: missing sheets array');

    const imported: EphemeraElementSheet[] = [];

    for (const inSheet of data.sheets) {
      // Re-generate IDs to avoid collisions
      const elements: EphemeraElement[] = inSheet.elements.map(el => ({
        ...el,
        id: makeId(),
      }));

      if (onConflict === 'merge') {
        const existing = this._sheets.find(s => s.name === inSheet.name);
        if (existing) {
          existing.elements.push(...elements);
          existing.modifiedAt = Date.now();
          imported.push(existing);
          continue;
        }
      }

      const newSheet: EphemeraElementSheet = {
        id: makeId(),
        name: inSheet.name,
        elements,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      };
      this._sheets.push(newSheet);
      imported.push(newSheet);
    }

    return imported;
  }

  // ── Serialization (project save/load) ────────────────────────────────────

  serialize(): string {
    const placementsObj: Record<string, EphemeraPlacement[]> = {};
    for (const [layerId, list] of this._placements) {
      if (list.length > 0) placementsObj[layerId] = list;
    }
    return JSON.stringify({ version: 2, sheets: this._sheets, placements: placementsObj });
  }

  deserialize(json: string): void {
    try {
      const data = JSON.parse(json) as {
        version: number;
        sheets: EphemeraElementSheet[];
        placements?: Record<string, EphemeraPlacement[]>;
      };
      if (!data.sheets || !Array.isArray(data.sheets)) return;
      this._sheets = data.sheets;
      if (!this._sheets.find(s => s.id === DEFAULT_SHEET_ID)) {
        this._sheets.unshift({
          id: DEFAULT_SHEET_ID,
          name: 'Default Sheet',
          elements: [],
          createdAt: Date.now(),
          modifiedAt: Date.now(),
        });
      }
      this._placements.clear();
      if (data.placements) {
        for (const [layerId, list] of Object.entries(data.placements)) {
          this._placements.set(layerId, list);
        }
      }
    } catch {
      // Silently keep existing state on parse error
    }
  }
}
