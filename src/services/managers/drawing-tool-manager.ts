/**
 * DrawingToolManager — Delegate for vector drawing tools and shape creation.
 *
 * Handles:
 *  - Enable/disable drawing tools (scribble, line, highlight, text, eraser, pattern, stamp, polygon, section, panning)
 *  - Tool color/property setters
 *  - Shape creation (rectangle, circle, triangle, line, arrow, sticky note, polygon, etc.)
 *  - Preview shape lifecycle (set, move, confirm)
 *  - Image import to raster layers
 *
 * Frogmarks can access this via `shapeManager.drawing`.
 */

import type { ManagerContext } from './manager-context';
import type { LineDrawingService } from '../drawing/line-drawing-service';
import type { ScribbleDrawingService } from '../drawing/scribble-drawing-service';
import type { TextDrawingService } from '../drawing/text-drawing-service';
import type { SdfTextDrawingService } from '../drawing/sdftext-drawing-service';
import type { EraserService } from '../drawing/eraser-service';
import type { HighlightDrawingService } from '../drawing/highlight-drawing-service';
import type { PatternDrawingService } from '../drawing/pattern-drawing-service';
import type { StampDrawingService } from '../drawing/stamp-drawing-service';
import type { SectionDrawingService } from '../drawing/section-drawing-service';
import type { PolygonDrawingService } from '../drawing/polygon-drawing-service';
import type { RasterLayerManager } from '../raster-layer-manager';
import { hexToRgba } from '../../utils/color';
import { RGBA } from '../../types/rgba';
import { Shape } from '../../scene-graph/shapes/base/shape';
import { Node } from '../../scene-graph/shapes/base/node';
import { ShapeType } from '../../enums/shape-type';
import { Line, ArrowheadStyle } from '../../scene-graph/shapes/line';
import { PolygonPreset } from '../../scene-graph/shapes/polygon';

export class DrawingToolManager {
    private ctx: ManagerContext;
    private shapeColor: RGBA = hexToRgba('#FFFFFF');
    private currentPreviewShape: Shape | null = null;
    public defaultPolygonSides: number = 6;

    // Services — injected by ShapeManager after construction
    private _lineDrawingService!: LineDrawingService;
    private _scribbleDrawingService!: ScribbleDrawingService;
    private _textDrawingService!: TextDrawingService;
    private _eraserService!: EraserService;
    private _highlightDrawingService!: HighlightDrawingService;
    private _patternDrawingService!: PatternDrawingService;
    private _stampDrawingService!: StampDrawingService;
    private _sectionDrawingService!: SectionDrawingService;
    private _polygonDrawingService!: PolygonDrawingService;

    constructor(ctx: ManagerContext) {
        this.ctx = ctx;
    }

    // ── Service injection ────────────────────────────────────────────

    setLineDrawingService(svc: LineDrawingService): void { this._lineDrawingService = svc; }
    setScribbleDrawingService(svc: ScribbleDrawingService): void { this._scribbleDrawingService = svc; }
    setTextDrawingService(svc: TextDrawingService): void { this._textDrawingService = svc; }
    setEraserService(svc: EraserService): void { this._eraserService = svc; }
    setHighlightDrawingService(svc: HighlightDrawingService): void { this._highlightDrawingService = svc; }
    setPatternDrawingService(svc: PatternDrawingService): void { this._patternDrawingService = svc; }
    setStampDrawingService(svc: StampDrawingService): void { this._stampDrawingService = svc; }
    setSectionDrawingService(svc: SectionDrawingService): void { this._sectionDrawingService = svc; }
    setPolygonDrawingService(svc: PolygonDrawingService): void { this._polygonDrawingService = svc; }

    // ── Enable / Disable Tools ───────────────────────────────────────

    enableScribbleDrawing(): void { this._scribbleDrawingService.enable(); this.ctx.beginInteractive(); }
    disableScribbleDrawing(): void { this._scribbleDrawingService.disable(); this.ctx.endInteractive(); }
    enableSectionDrawing(): void { this._sectionDrawingService.enable(); this.ctx.beginInteractive(); }
    disableSectionDrawing(): void { this._sectionDrawingService.disable(); this.ctx.endInteractive(); }
    enableHighlightDrawing(): void { this._highlightDrawingService.enable(); }
    disableHighlightDrawing(): void { this._highlightDrawingService.disable(); }
    enableTextDrawing(): void { this._textDrawingService.enable(); }
    disableTextDrawing(): void { this._textDrawingService.disable(); }
    isTextDrawingInProgress(): boolean { return this._textDrawingService.isUserTyping(); }
    enableLineDrawing(): void { this._lineDrawingService.enable(); }
    disableLineDrawing(): void { this._lineDrawingService.disable(); }
    enableEraserTool(): void { this._eraserService.enable(); }
    disableEraserTool(): void { this._eraserService.disable(); }
    enablePatternDrawing(): void { this._patternDrawingService.enable(); }
    disablePatternDrawing(): void { this._patternDrawingService.disable(); }
    enableStampDrawing(): void { this._stampDrawingService.enable(); }
    disableStampDrawing(): void { this._stampDrawingService.disable(); }
    enablePanningTool(): void { this.ctx.interactionService.isPanToolSelected = true; }
    disablePanningTool(): void { this.ctx.interactionService.isPanToolSelected = false; }

    enablePolygonDrawing(): void { this._polygonDrawingService.enable(); }
    disablePolygonDrawing(): void { this._polygonDrawingService.disable(); }
    get isPolygonDrawing(): boolean { return this._polygonDrawingService?.isEnabled ?? false; }
    get isPolygonDrawingInProgress(): boolean { return this._polygonDrawingService?.isDrawing ?? false; }
    setPolygonDrawingColors(fill: RGBA, stroke: RGBA, strokeWidth: number): void { this._polygonDrawingService.setColors(fill, stroke, strokeWidth); }

    // ── Color / Property Setters ─────────────────────────────────────

    setStrokeColor(color: string): void { this._scribbleDrawingService.setStrokeColor(hexToRgba(color)); }
    setHighlightColor(color: string): void { this._highlightDrawingService.setStrokeColor(hexToRgba(color)); }
    setShapeColor(color: string): void { this.shapeColor = hexToRgba(color); }
    getShapeColor(): RGBA { return this.shapeColor; }
    setTextColor(color: string): void { this._textDrawingService.setTextColor(hexToRgba(color)); }
    setStrokeWidth(width: number): void { this._scribbleDrawingService.setStrokeWidth(width * .005); }
    setStampTexture(textureKey: string): void { this._stampDrawingService.setTextureKey(textureKey); }
    setStampSize(size: number): void { this._stampDrawingService.setStampSize(size); }
    setStampColor(color: string): void { this._stampDrawingService.setFillColor(hexToRgba(color)); }
    setPattern(pattern: string): void { this._patternDrawingService.setTextureKey(pattern); }

    // ── Shape Creation ───────────────────────────────────────────────

    createRectangle(x: number, y: number, w: number, h: number): void {
        const shape = this.ctx.shapeFactory.createRectangle(x, y, w, h, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1);
        this.ctx.sceneGraph.root.addChild(shape);
        this.ctx.emitSceneGraphChanged();
    }

    createCircle(x: number, y: number, radius: number): void {
        const shape = this.ctx.shapeFactory.createCircle(x, y, radius, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1);
        this.ctx.sceneGraph.root.addChild(shape);
        this.ctx.emitSceneGraphChanged();
    }

    createTriangle(x: number, y: number, w: number, h: number): void {
        const shape = this.ctx.shapeFactory.createTriangle(x, y, w, h, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1);
        this.ctx.sceneGraph.root.addChild(shape);
        this.ctx.emitSceneGraphChanged();
    }

    createLine(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number) {
        const shape = this.ctx.shapeFactory.createLine(x1, y1, x2, y2, strokeColor, strokeWidth);
        this.ctx.sceneGraph.root.addChild(shape);
        this.ctx.emitSceneGraphChanged();
        return shape;
    }

    createArrow(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number, arrowStart: ArrowheadStyle = 'none', arrowEnd: ArrowheadStyle = 'closedCircle', arrowSize = 6) {
        const line = this.ctx.shapeFactory.createLine(x1, y1, x2, y2, strokeColor, strokeWidth);
        line.arrowStart = arrowStart;
        line.arrowEnd = arrowEnd;
        line.arrowSize = arrowSize;
        line.markDirty();
        this.ctx.sceneGraph.root.addChild(line);
        this.ctx.emitSceneGraphChanged();
        return line;
    }

    setArrowheads(shapeId: string, arrowStart?: ArrowheadStyle, arrowEnd?: ArrowheadStyle, arrowSize?: number): void {
        const node = this.ctx.sceneGraph.findNodeById(shapeId);
        if (node instanceof Line) {
            if (arrowStart !== undefined) node.arrowStart = arrowStart;
            if (arrowEnd !== undefined) node.arrowEnd = arrowEnd;
            if (arrowSize !== undefined) node.arrowSize = arrowSize;
            node.markDirty();
            this.ctx.scheduleRender();
        }
    }

    static get ArrowheadStyles(): ArrowheadStyle[] {
        return ['none', 'closedCircle', 'openCircle', 'triangle', 'open'];
    }

    createStickyNote(x: number, y: number, text = ''): void {
        const note = this.ctx.shapeFactory.createStickyNote(x, y, text);
        this.ctx.sceneGraph.root.addChild(note);
        this.ctx.emitSceneGraphChanged();
    }

    createScribble(x: number, y: number, strokeColor: RGBA, strokeWidth: number): void {
        const scribble = this.ctx.shapeFactory.createScribble(x, y, strokeColor, strokeWidth);
        this._eraserService.scribbles.push(scribble);
        this.ctx.sceneGraph.root.addChild(scribble);
        this.ctx.emitSceneGraphChanged();
    }

    createHighlight(x: number, y: number, strokeColor: RGBA, strokeWidth: number): void {
        const highlight = this.ctx.shapeFactory.createHighlight(x, y, strokeColor, strokeWidth);
        this._eraserService.scribbles.push(highlight);
        this.ctx.sceneGraph.root.addChild(highlight);
        this.ctx.emitSceneGraphChanged();
    }

    createRegularPolygon(x: number, y: number, radius: number, sides: number, strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 1 }, strokeWidth = 1): void {
        const polygon = this.ctx.shapeFactory.createRegularPolygon(x, y, radius, sides, this.shapeColor, strokeColor, strokeWidth);
        this.ctx.sceneGraph.root.addChild(polygon);
        this.ctx.emitSceneGraphChanged();
    }

    createPolygonFromPoints(points: { x: number; y: number }[], strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 1 }, strokeWidth = 1): void {
        const polygon = this.ctx.shapeFactory.createPolygon(points, this.shapeColor, strokeColor, strokeWidth);
        this.ctx.sceneGraph.root.addChild(polygon);
        this.ctx.emitSceneGraphChanged();
    }

    createPresetPolygon(x: number, y: number, width: number, height: number, preset: PolygonPreset, strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 1 }, strokeWidth = 1): void {
        const polygon = this.ctx.shapeFactory.createPresetPolygon(x, y, width, height, preset, this.shapeColor, strokeColor, strokeWidth);
        this.ctx.sceneGraph.root.addChild(polygon);
        this.ctx.emitSceneGraphChanged();
    }

    static get PolygonPresets(): PolygonPreset[] {
        return ['parallelogram', 'trapezoid', 'arrowRight', 'chevron', 'star5', 'star6', 'cross', 'speechBubble'];
    }

    // ── Preview Shape ────────────────────────────────────────────────

    setPreviewShape(shapeType: ShapeType, event: MouseEvent): void {
        if (this.currentPreviewShape) {
            this.ctx.sceneGraph.root.removeChild(this.currentPreviewShape);
            this.currentPreviewShape = null;
            this.ctx.emitSceneGraphChanged();
            this.ctx.endInteractive();
        }
        if (!shapeType) return;
        const { x, y } = this.ctx.interactionService.toWorldCoords(event);
        switch (shapeType) {
            case ShapeType.Rectangle: this.currentPreviewShape = this.ctx.shapeFactory.createRectangle(x, y, 1, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1); break;
            case ShapeType.Circle: this.currentPreviewShape = this.ctx.shapeFactory.createCircle(x, y, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1); break;
            case ShapeType.Triangle: this.currentPreviewShape = this.ctx.shapeFactory.createTriangle(x, y, 1, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1); break;
            case ShapeType.InverseTriangle: this.currentPreviewShape = this.ctx.shapeFactory.createInvertedTriangle(x, y, .5, .5, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1); break;
            case ShapeType.Polygon: this.currentPreviewShape = this.ctx.shapeFactory.createRegularPolygon(x, y, 0.5, this.defaultPolygonSides, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1); break;
        }
        if (this.currentPreviewShape) {
            this.currentPreviewShape.isPreview = true;
            this.ctx.sceneGraph.root.addChild(this.currentPreviewShape);
            this.ctx.beginInteractive();
            this.ctx.scheduleRender();
        }
    }

    updatePreviewShapePosition(event: MouseEvent): void {
        if (this.currentPreviewShape) {
            const { x, y } = this.ctx.interactionService.toWorldCoords(event);
            this.currentPreviewShape.x = x;
            this.currentPreviewShape.y = y;
            if (this.currentPreviewShape.fillColor !== this.shapeColor) this.currentPreviewShape.fillColor = this.shapeColor;
            this.ctx.scheduleRender();
        }
    }

    confirmPreviewShape(): void {
        if (this.currentPreviewShape) {
            this.currentPreviewShape.fillColor = this.shapeColor;
            this.currentPreviewShape.isPreview = false;
            this.currentPreviewShape = null;
            this.ctx.endInteractive();
        }
        this.ctx.emitSceneGraphChanged();
    }

    // ── Image Import ─────────────────────────────────────────────────

    async importImageToCurrentLayer(source: File | Blob | ImageBitmap): Promise<boolean> {
        const rasterLayerManager = this.ctx.rasterLayerManager;
        if (!rasterLayerManager) return false;
        const activeId = rasterLayerManager.getSelectedLayerId();
        if (!activeId) return false;
        return this.importImageToLayer(activeId, source);
    }

    async importImageToLayer(layerId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        const rasterLayerManager = this.ctx.rasterLayerManager;
        if (!rasterLayerManager) return false;
        const layer = rasterLayerManager.getLayerById(layerId);
        if (!layer) return false;
        try {
            const { w, h } = rasterLayerManager.getCanvasSize();
            const raster = await this.decodeImageToRasterCanvas(source, w, h);
            if (!raster) return false;
            const ok = await rasterLayerManager.importRasterCanvasToLayer(layerId, raster);
            if (ok) { this.ctx.scheduleRender(); this.ctx.emitSceneGraphChanged(); }
            return ok;
        } catch { return false; }
    }

    async importImageAsNewLayer(source: File | Blob | ImageBitmap, name = 'Imported Image'): Promise<string | null> {
        const rasterLayerManager = this.ctx.rasterLayerManager;
        if (!rasterLayerManager) return null;
        try {
            const { w, h } = rasterLayerManager.getCanvasSize();
            const raster = await this.decodeImageToRasterCanvas(source, w, h);
            if (!raster) return null;
            const result = await rasterLayerManager.createLayerFromRasterCanvas(name, raster);
            this.ctx.scheduleRender();
            this.ctx.emitSceneGraphChanged();
            return result.id;
        } catch { return null; }
    }

    async importRasterLayersFromDataURLs(layers: Array<{ id?: string; name?: string; imageData?: string; width?: number; height?: number }>): Promise<void> {
        const rasterLayerManager = this.ctx.rasterLayerManager;
        if (!layers || !rasterLayerManager) return;
        for (const l of layers) {
            if (!l.imageData) continue;
            try {
                const blob = this.dataURLToBlob(l.imageData);
                const { w: canvasW, h: canvasH } = rasterLayerManager.getCanvasSize();
                const raster = await this.decodeImageToRasterCanvas(blob, canvasW, canvasH);
                if (!raster) continue;
                if (l.id) {
                    const existing = rasterLayerManager.getLayerById(l.id);
                    if (existing) { await rasterLayerManager.importRasterCanvasToLayer(l.id, raster); continue; }
                }
                await rasterLayerManager.createLayerFromRasterCanvas(l.name ?? 'Layer', raster, l.id);
            } catch (e) { console.warn('Failed to import raster layer', l, e); }
        }
        this.ctx.emitSceneGraphChanged();
    }

    private async decodeImageToRasterCanvas(source: File | Blob | ImageBitmap, targetW?: number, targetH?: number): Promise<any> {
        const { RasterCanvas } = await import('../../renderer/raster/raster-canvas');
        let bitmap: ImageBitmap;
        if (source instanceof ImageBitmap) bitmap = source;
        else bitmap = await createImageBitmap(source);
        const imgW = bitmap.width, imgH = bitmap.height;
        if (!imgW || !imgH) return null;
        const outW = targetW && targetH ? targetW : imgW;
        const outH = targetW && targetH ? targetH : imgH;
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(outW, outH) : document.createElement('canvas');
        (canvas as any).width = outW; (canvas as any).height = outH;
        const ctx = (canvas as any).getContext('2d') as CanvasRenderingContext2D;
        if (!ctx) return null;
        ctx.drawImage(bitmap as any, Math.round((outW - imgW) / 2), Math.round((outH - imgH) / 2));
        const imageData = ctx.getImageData(0, 0, outW, outH);
        const raster = new RasterCanvas(outW, outH);
        raster.getBuffer().set(imageData.data as any);
        return raster;
    }

    private dataURLToBlob(dataurl: string): Blob {
        const parts = dataurl.split(',');
        const header = parts[0];
        const base64 = parts[1];
        const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png';
        const binary = atob(base64);
        const len = binary.length;
        const u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8[i] = binary.charCodeAt(i);
        return new Blob([u8], { type: mime });
    }
}
