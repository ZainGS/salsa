/**
 * RasterManager — Delegate for all raster-mode operations.
 *
 * Handles:
 *  - Raster drawing enable/disable
 *  - Brush settings, presets, grain, stabilization
 *  - Flood fill / paint bucket
 *  - Raster selection & transform
 *  - Raster layer management (add/delete/reorder/blend/opacity/clipping)
 *  - Raster undo/redo
 *  - Dithering (global + per-layer)
 *  - Frame link animation
 *  - Raster text tool
 *  - Magic wand, select-by-color
 *  - Flip/rotate/scale convenience
 *
 * Frogmarks can access this via `shapeManager.raster`.
 */

import type { ManagerContext } from './manager-context';
import type { RasterDrawingService } from '../raster-drawing-service';
import type { RasterSelectionService } from '../raster-selection-service';
import type { RasterMoveService } from '../raster-move-service';
import type { RasterTextService, RasterTextState } from '../raster-text-service';
import type { RasterLayerManager } from '../raster-layer-manager';
import type { WebGPURenderer } from '../../renderer/core/webgpu-renderer';
import { hexToRgba } from '../../utils/color';
import { FloodFillEngine, type FloodFillOptions } from '../../renderer/raster/tools/flood-fill-engine';
import { LayerBlendMode } from '../../renderer/raster/core/raster-compositor';
import { DitherConfig, DitherAlgorithm, DitherColorMode, defaultDitherConfig, DitherEngine } from '../../renderer/raster/effects/dither-engine';
import type { DualBrushSettings, DualBrushBlendOp, ColorJitter, WetEdgeSettings, StrokeTextureSettings, StabilizationMethod, BrushStabilization } from '../../renderer/raster/brushes/brush-preset';
import type { FrameLinkAnimation, FrameLinkAnimationType, FrameLinkLoopMode } from '../../animation';
import { DEFAULT_FRAME_LINK_ANIMATION } from '../../animation';

export class RasterManager {
    private ctx: ManagerContext;
    private _rasterDrawingService?: RasterDrawingService;
    private _rasterSelectionService?: RasterSelectionService;
    private _rasterMoveService?: RasterMoveService;
    private _rasterTextService?: RasterTextService;
    private _floodFillEngine?: FloodFillEngine;

    constructor(ctx: ManagerContext) {
        this.ctx = ctx;
    }

    // ── Injected services (set by ShapeManager during init) ─────────

    setDrawingService(svc: RasterDrawingService): void { this._rasterDrawingService = svc; }
    setSelectionService(svc: RasterSelectionService): void { this._rasterSelectionService = svc; }
    setMoveService(svc: RasterMoveService): void { this._rasterMoveService = svc; }
    setTextService(svc: RasterTextService): void { this._rasterTextService = svc; }

    private get renderer(): WebGPURenderer { return this.ctx.webgpuRenderer; }
    private get layerMgr(): RasterLayerManager | undefined { return this.ctx.rasterLayerManager; }

    // ── Enable / Disable ─────────────────────────────────────────────

    enableDrawing(): void {
        this._rasterSelectionService?.disable();
        this._rasterMoveService?.disable();
        this._rasterDrawingService?.enable();
        this.renderer?.setRenderMode('raster');
        this.ctx.beginInteractive();
    }

    disableDrawing(): void {
        this._rasterDrawingService?.disable();
    }

    enableSelection(tool: 'rect' | 'ellipse' | 'lasso' | 'magic-wand' = 'rect'): void {
        const info = this._rasterSelectionService?.getSelectionInfo();
        if (info?.isTransforming) this._rasterSelectionService?.commitTransform();
        this._rasterDrawingService?.disable();
        this._rasterMoveService?.disable();
        this._rasterSelectionService?.setTool(tool);
        this._rasterSelectionService?.enable();
        this.renderer?.setRenderMode('raster');
    }

    disableSelection(): void {
        const info = this._rasterSelectionService?.getSelectionInfo();
        if (info?.isTransforming) this._rasterSelectionService?.commitTransform();
        this._rasterSelectionService?.disable();
    }

    enableMove(): void {
        const info = this._rasterSelectionService?.getSelectionInfo();
        if (info?.isTransforming) this._rasterSelectionService?.commitTransform();
        this._rasterDrawingService?.disable();
        this._rasterSelectionService?.disable();
        this._rasterMoveService?.enable();
        this.renderer?.setRenderMode('raster');
    }

    disableMove(): void { this._rasterMoveService?.disable(); }

    enableTool(): void {
        this._rasterDrawingService?.setEraserMode('paint');
        this._rasterDrawingService?.enable();
    }

    disableTool(): void { this._rasterDrawingService?.disable(); }

    enableEraserTool(): void {
        this._rasterDrawingService?.setEraserMode('erase');
        this._rasterDrawingService?.enable();
        this.ctx.beginInteractive();
    }

    enableClearEraserTool(): void {
        this._rasterDrawingService?.setEraserMode('clear');
        this._rasterDrawingService?.enable();
        this.ctx.beginInteractive();
    }

    disableEraserTool(): void {
        this._rasterDrawingService?.setEraserMode('paint');
        this._rasterDrawingService?.disable();
        this.ctx.endInteractive();
    }

    // ── Brush settings ───────────────────────────────────────────────

    setBrushSize(size: number): void { this._rasterDrawingService?.setBrushRadiusPx(size); }
    setBrushColor(color: string): void { this._rasterDrawingService?.setBrushColor(hexToRgba(color)); }

    // ── Stroke events ────────────────────────────────────────────────

    onStrokeStart(listener: (v: any) => void) { return this._rasterDrawingService?.onStrokeStart.subscribe(listener); }
    onStrokeUpdate(listener: (v: any) => void) { return this._rasterDrawingService?.onStrokeUpdate.subscribe(listener); }
    onStrokeEnd(listener: (v: any) => void) { return this._rasterDrawingService?.onStrokeEnd.subscribe(listener); }

    getTextureSize(): { w: number; h: number } | null {
        return this.renderer?.getRasterTextureSize?.() ?? null;
    }

    // ── Undo / Redo ──────────────────────────────────────────────────

    async undo(): Promise<boolean> {
        const selectedId = this.layerMgr?.getSelectedLayerId();
        if (selectedId && this.layerMgr) {
            const ok = await this.layerMgr.undoForLayer(selectedId);
            if (ok) this.ctx.scheduleRender();
            return !!ok;
        }
        if (!this.renderer) return false;
        const ok = await (this.renderer as any).rasterUndo?.();
        if (ok) this.ctx.scheduleRender();
        return ok;
    }

    async redo(): Promise<boolean> {
        const selectedId = this.layerMgr?.getSelectedLayerId();
        if (selectedId && this.layerMgr) {
            const ok = await this.layerMgr.redoForLayer(selectedId);
            if (ok) this.ctx.scheduleRender();
            return !!ok;
        }
        if (!this.renderer) return false;
        const ok = await (this.renderer as any).rasterRedo?.();
        if (ok) this.ctx.scheduleRender();
        return ok;
    }

    pushSnapshot(): void {
        const selectedId = this.layerMgr?.getSelectedLayerId();
        if (selectedId && this.layerMgr) { this.layerMgr.pushSnapshotForLayer(selectedId); return; }
        (this.renderer as any)?.rasterPushSnapshot?.();
    }

    pushSnapshotForLayer(id: string) { return this.layerMgr?.pushSnapshotForLayer(id) ?? false; }
    async undoLayer(id: string) { return await (this.layerMgr?.undoForLayer(id) ?? false); }
    async redoLayer(id: string) { return await (this.layerMgr?.redoForLayer(id) ?? false); }

    // ── Layer management ─────────────────────────────────────────────

    getLayers() { return this.layerMgr?.getLayers() ?? []; }

    addLayer(name = 'Layer') {
        const l = this.layerMgr?.addLayer(name);
        this.ctx.emitSceneGraphChanged();
        return l;
    }

    deleteLayer(id: string) {
        const ok = this.layerMgr?.deleteLayer(id) ?? false;
        if (ok) this.ctx.emitSceneGraphChanged();
        return ok;
    }

    selectLayer(id: string) { return this.layerMgr?.selectLayer(id) ?? false; }

    setLayerVisibility(id: string, visible: boolean) {
        const ok = this.layerMgr?.setVisibility(id, visible) ?? false;
        if (ok) this.ctx.emitSceneGraphChanged();
        return ok;
    }

    setLayerBlendMode(id: string, mode: LayerBlendMode): boolean {
        const ok = this.layerMgr?.setBlendMode(id, mode) ?? false;
        if (ok) this.ctx.emitSceneGraphChanged();
        return ok;
    }

    setLayerOpacity(id: string, opacity: number): boolean {
        const ok = this.layerMgr?.setOpacity(id, opacity) ?? false;
        if (ok) this.ctx.emitSceneGraphChanged();
        return ok;
    }

    setLayerClipping(id: string, clipped: boolean): boolean {
        const ok = this.layerMgr?.setClipping(id, clipped) ?? false;
        if (ok) this.ctx.emitSceneGraphChanged();
        return ok;
    }

    setLayerLockTransparency(id: string, locked: boolean): boolean {
        return this.layerMgr?.setLockTransparency(id, locked) ?? false;
    }

    reorderLayers(orderedIds: string[]) {
        this.layerMgr?.reorderLayers(orderedIds);
        this.ctx.emitSceneGraphChanged();
    }

    static get LayerBlendMode() { return LayerBlendMode; }

    // ── Layer Folders ────────────────────────────────────────────────

    addFolder(name = 'Group') {
        const f = this.layerMgr?.addFolder(name);
        this.ctx.emitSceneGraphChanged();
        return f;
    }

    setFolderCollapsed(folderId: string, collapsed: boolean) {
        this.layerMgr?.setFolderCollapsed(folderId, collapsed);
    }

    setLayerParent(layerId: string, parentId: string | null) {
        this.layerMgr?.setLayerParent(layerId, parentId);
        this.ctx.emitSceneGraphChanged();
    }

    deleteFolder(folderId: string) {
        const ok = this.layerMgr?.deleteFolder(folderId) ?? false;
        if (ok) this.ctx.emitSceneGraphChanged();
        return ok;
    }

    // ── 3D Scene ─────────────────────────────────────────────────────

    add3DScene(name = '3D Scene') { return this.layerMgr?.add3DScene(name) ?? ''; }
    remove3DScene() { return this.layerMgr?.remove3DScene() ?? false; }
    get3DScene() { return this.layerMgr?.get3DScene() ?? null; }
    has3DScene() { return this.layerMgr?.has3DScene() ?? false; }

    // Legacy aliases
    add3DDivider(name = '3D Scene') { return this.add3DScene(name); }
    remove3DDivider() { return this.remove3DScene(); }
    get3DDivider() { return this.get3DScene(); }
    has3DDivider() { return this.has3DScene(); }

    // ── Selection & Transform ────────────────────────────────────────

    private getSelectionEngine() { return this.renderer?.rasterSelectionEngine; }

    selectRect(x: number, y: number, w: number, h: number, feather = 0): void { this.getSelectionEngine()?.selectRect({ x, y, w, h }, feather); }
    selectEllipse(x: number, y: number, w: number, h: number, feather = 0): void { this.getSelectionEngine()?.selectEllipse({ x, y, w, h }, feather); }
    selectLasso(points: Array<{ x: number; y: number }>): void { this.getSelectionEngine()?.selectLasso(points); }
    selectAll(): void { this.getSelectionEngine()?.selectAll(); }
    deselectAll(): void { this.getSelectionEngine()?.deselectAll(); }
    invertSelection(): void { this.getSelectionEngine()?.invertSelection(); }
    deleteSelection(): void { this.getSelectionEngine()?.deleteSelection(); }
    async cutSelection(): Promise<void> { await this.getSelectionEngine()?.cutSelection(); }
    async copySelection(): Promise<void> { await this.getSelectionEngine()?.copySelection(); }
    paste(): void { this.getSelectionEngine()?.paste(); }
    beginTransform(): void { this.getSelectionEngine()?.beginTransform(); }
    updateTransform(dx: number, dy: number, scaleX?: number, scaleY?: number, rotation?: number): void { this.getSelectionEngine()?.updateTransform(dx, dy, scaleX, scaleY, rotation); }
    commitTransform(): void { this.getSelectionEngine()?.commitTransform(); }
    cancelTransform(): void { this.getSelectionEngine()?.cancelTransform(); }

    getSelectionInfo() {
        return this.getSelectionEngine()?.getSelectionInfo() ?? {
            hasSelection: false, bounds: null, isTransforming: false, transform: null, dragPreview: null,
        };
    }

    setSelectionTool(tool: 'rect' | 'ellipse' | 'lasso'): void { this._rasterSelectionService?.setTool(tool); }
    setSelectionMode(mode: 'new' | 'add' | 'subtract'): void { this._rasterSelectionService?.setMode(mode); }
    getSelectionMode(): 'new' | 'add' | 'subtract' { return this._rasterSelectionService?.getMode() ?? 'new'; }

    // ── Magic Wand ───────────────────────────────────────────────────

    async selectMagicWand(x: number, y: number, tolerance = 32, options?: {
        contiguous?: boolean; mode?: 'new' | 'add' | 'subtract'; referenceLayerId?: string;
    }): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        let refTex: GPUTexture | undefined;
        if (options?.referenceLayerId && this.layerMgr) {
            const refLayer = this.layerMgr.getLayerById(options.referenceLayerId);
            refTex = refLayer?.texture ?? undefined;
        }
        await engine.selectMagicWand(Math.floor(x), Math.floor(y), tolerance, options?.contiguous ?? true, options?.mode ?? 'new', refTex);
        this.ctx.scheduleRender();
    }

    async selectByColor(x: number, y: number, tolerance = 32, mode: 'new' | 'add' | 'subtract' = 'new'): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        await engine.selectByColor(Math.floor(x), Math.floor(y), tolerance, mode);
        this.ctx.scheduleRender();
    }

    setMagicWandOptions(opts: { tolerance?: number; contiguous?: boolean; referenceLayerId?: string }): void {
        let refTex: GPUTexture | undefined;
        if (opts.referenceLayerId && this.layerMgr) {
            const refLayer = this.layerMgr.getLayerById(opts.referenceLayerId);
            refTex = refLayer?.texture ?? undefined;
        }
        this._rasterSelectionService?.setMagicWandOptions({ tolerance: opts.tolerance, contiguous: opts.contiguous, referenceLayerTexture: refTex });
    }

    // ── Transform convenience ────────────────────────────────────────

    async flipHorizontal(): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        const info = engine.getSelectionInfo();
        if (!info.hasSelection) return;
        if (!info.isTransforming) await engine.beginTransform();
        const s = info.transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        engine.updateTransform(s.translateX, s.translateY, -s.scaleX, s.scaleY, s.rotation);
        await engine.commitTransform();
        this.ctx.scheduleRender();
    }

    async flipVertical(): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        const info = engine.getSelectionInfo();
        if (!info.hasSelection) return;
        if (!info.isTransforming) await engine.beginTransform();
        const s = info.transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        engine.updateTransform(s.translateX, s.translateY, s.scaleX, -s.scaleY, s.rotation);
        await engine.commitTransform();
        this.ctx.scheduleRender();
    }

    async rotate(degrees: number): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        const info = engine.getSelectionInfo();
        if (!info.hasSelection) return;
        if (!info.isTransforming) await engine.beginTransform();
        const s = info.transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        engine.updateTransform(s.translateX, s.translateY, s.scaleX, s.scaleY, s.rotation + (degrees * Math.PI) / 180);
        await engine.commitTransform();
        this.ctx.scheduleRender();
    }

    async scale(scaleX: number, scaleY: number): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        const info = engine.getSelectionInfo();
        if (!info.hasSelection) return;
        if (!info.isTransforming) await engine.beginTransform();
        const s = info.transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        engine.updateTransform(s.translateX, s.translateY, s.scaleX * scaleX, s.scaleY * scaleY, s.rotation);
        await engine.commitTransform();
        this.ctx.scheduleRender();
    }

    getTexturesForComposition() { return this.layerMgr?.getTextureForComposition() ?? []; }

    // ── Flood Fill ───────────────────────────────────────────────────

    async floodFill(x: number, y: number, colorHex: string, options?: {
        tolerance?: number; gapClosing?: number; contiguous?: boolean; referenceLayerId?: string;
    }): Promise<boolean> {
        if (!this.layerMgr) return false;
        const device = this.renderer.getDevice();
        if (!device) return false;
        if (!this._floodFillEngine) this._floodFillEngine = new FloodFillEngine(device);
        const activeLayerId = this.layerMgr.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = this.layerMgr.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;
        const rgba = hexToRgba(colorHex);
        const color: [number, number, number, number] = [rgba.r, rgba.g, rgba.b, rgba.a ?? 1];
        let referenceTexture: GPUTexture | undefined;
        if (options?.referenceLayerId) {
            const refLayer = this.layerMgr.getLayerById(options.referenceLayerId);
            referenceTexture = refLayer?.texture ?? undefined;
        }
        const selMask = this._rasterSelectionService?.getSelectionInfo()?.hasSelection
            ? (this._rasterSelectionService as any)?.engine?.getMaskTexture() ?? undefined : undefined;
        const result = await this._floodFillEngine.fill(activeLayer.texture, {
            x: Math.floor(x), y: Math.floor(y), color,
            tolerance: options?.tolerance ?? 32, gapClosing: options?.gapClosing ?? 0,
            contiguous: options?.contiguous ?? true, referenceTexture, selectionMask: selMask,
        });
        if (result) this.ctx.scheduleRender();
        return result;
    }

    worldToTexel(worldX: number, worldY: number): { tx: number; ty: number } | null {
        const texSize = this.renderer.getRasterTextureSize?.();
        if (!texSize) return null;
        const bounds = this.renderer.getIllustrationBounds?.();
        const worldW = bounds?.width ?? 2.0;
        const worldH = bounds?.height ?? 2.0;
        const hw = worldW / 2, hh = worldH / 2;
        return { tx: Math.floor(((worldX + hw) / worldW) * texSize.w), ty: Math.floor(((hh - worldY) / worldH) * texSize.h) };
    }

    async floodFillWorld(worldX: number, worldY: number, colorHex: string, options?: {
        tolerance?: number; gapClosing?: number; contiguous?: boolean; referenceLayerId?: string;
    }): Promise<boolean> {
        const texel = this.worldToTexel(worldX, worldY);
        if (!texel) return false;
        return this.floodFill(texel.tx, texel.ty, colorHex, options);
    }

    async fillSelection(colorHex: string): Promise<boolean> {
        if (!this.layerMgr) return false;
        const device = this.renderer.getDevice();
        if (!device) return false;
        if (!this._floodFillEngine) this._floodFillEngine = new FloodFillEngine(device);
        const activeLayerId = this.layerMgr.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = this.layerMgr.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;
        const rgba = hexToRgba(colorHex);
        const color: [number, number, number, number] = [rgba.r, rgba.g, rgba.b, rgba.a ?? 1];
        const result = await this._floodFillEngine.fill(activeLayer.texture, {
            x: 0, y: 0, color, tolerance: 255, gapClosing: 0, contiguous: false,
            selectionMask: this._rasterSelectionService?.getSelectionInfo()?.hasSelection
                ? (this._rasterSelectionService as any)?.engine?.getMaskTexture() ?? undefined : undefined,
        });
        if (result) this.ctx.scheduleRender();
        return result;
    }

    // ── Raster Text Tool ─────────────────────────────────────────────

    private ensureTextService(): any {
        // Text service is injected externally
        return this._rasterTextService;
    }

    enableText(): void {
        this._rasterDrawingService?.disable();
        this._rasterSelectionService?.disable();
        this._rasterTextService?.enable();
        this.renderer?.setRenderMode('raster');
    }

    disableText(): void { this._rasterTextService?.disable(); }
    getTextState(): RasterTextState | null { return this._rasterTextService?.getState() ?? null; }

    updateTextProperties(props: Partial<Pick<RasterTextState, 'font' | 'fontSize' | 'bold' | 'italic' | 'align' | 'color' | 'maxWidth' | 'lineHeight'>>): void {
        this._rasterTextService?.updateProperties(props);
    }

    commitText(): void { this._rasterTextService?.commit(); }
    cancelText(): void { this._rasterTextService?.cancel(); }

    onTextStateChanged(cb: (state: RasterTextState) => void): { unsubscribe: () => void } {
        return this._rasterTextService!.onStateChanged.subscribe(cb);
    }

    // ── Brush Presets ────────────────────────────────────────────────

    getPaintEngine() { return this._rasterDrawingService?.getPaintEngine(); }
    getBrushPresets() { return this.getPaintEngine()?.getPresets() ?? []; }
    getBrushPreset(id: string) { return this.getPaintEngine()?.getPreset(id); }
    setActiveBrushPreset(id: string): boolean { return this.getPaintEngine()?.setActivePreset(id) ?? false; }
    getActiveBrushPresetId(): string | null { return this.getPaintEngine()?.getActivePresetId() ?? null; }

    importBrushPreset(json: string): string | null {
        try { return this.getPaintEngine()?.importPreset(json) ?? null; }
        catch { return null; }
    }
    exportBrushPreset(presetId: string): string | null { return this.getPaintEngine()?.exportPreset(presetId) ?? null; }
    importBrushPresets(json: string): string[] {
        try { return this.getPaintEngine()?.importPresets(json) ?? []; }
        catch { return []; }
    }
    exportAllBrushPresets(): string { return this.getPaintEngine()?.exportAllPresets() ?? '[]'; }
    registerBrushPreset(preset: any): void { this.getPaintEngine()?.registerPreset(preset); }
    deleteBrushPreset(id: string): boolean { return this.getPaintEngine()?.deletePreset(id) ?? false; }
    updateBrushPreset(id: string, changes: Record<string, any>): boolean { return this.getPaintEngine()?.updatePreset(id, changes) ?? false; }

    // ── Dual Brush / Color Jitter / Wet Edges / Stroke Texture ──────

    setDualBrush(presetId: string, settings: DualBrushSettings): boolean { return this.updateBrushPreset(presetId, { dualBrush: settings }); }
    setColorJitter(presetId: string, jitter: ColorJitter): boolean { return this.updateBrushPreset(presetId, { colorJitter: jitter }); }
    setWetEdges(presetId: string, settings: WetEdgeSettings): boolean { return this.updateBrushPreset(presetId, { wetEdges: settings }); }
    static get DualBrushBlendOp(): Record<string, DualBrushBlendOp> { return { Multiply: 'multiply', Subtract: 'subtract', Minimum: 'minimum' }; }
    setStrokeTexture(presetId: string, settings: StrokeTextureSettings): boolean { return this.updateBrushPreset(presetId, { strokeTexture: settings }); }

    // ── Brush Grain ──────────────────────────────────────────────────

    setBrushGrain(settings: { type: string; scale: number; strength: number }): void {
        this.getPaintEngine()?.setBrushGrain(settings as any);
        this.ctx.scheduleRender();
    }
    getBrushGrain(): { type: string; scale: number; strength: number } {
        return this.getPaintEngine()?.getBrushGrain() ?? { type: 'none', scale: 1.0, strength: 0.5 };
    }

    // ── Brush Stabilization ──────────────────────────────────────────

    setBrushStabilization(presetId: string, settings: BrushStabilization): boolean { return this.updateBrushPreset(presetId, { stabilization: settings }); }
    getBrushStabilization(presetId: string): BrushStabilization | null {
        const preset = this.getPaintEngine()?.getPreset(presetId);
        return preset?.stabilization ?? null;
    }
    setActiveStabilization(settings: BrushStabilization): boolean {
        const id = this.getActiveBrushPresetId();
        if (!id) return false;
        return this.setBrushStabilization(id, settings);
    }
    getActiveStabilization(): BrushStabilization | null {
        const id = this.getActiveBrushPresetId();
        if (!id) return null;
        return this.getBrushStabilization(id);
    }

    // ── Paper Grain ──────────────────────────────────────────────────

    setPaperGrain(settings: { type: string; scale: number; strength: number }): void {
        this.getPaintEngine()?.setPaperGrain(settings as any);
        this.ctx.scheduleRender();
    }
    getPaperGrain(): { type: string; scale: number; strength: number } {
        return this.getPaintEngine()?.getPaperGrain() ?? { type: 'none', scale: 1.0, strength: 0.3 };
    }
    getAvailableGrainTypes(): string[] { return this.getPaintEngine()?.getAvailableGrainTypes() ?? ['none']; }

    // ── Dithering (global) ───────────────────────────────────────────

    setDitherConfig(config: DitherConfig): void { this.renderer?.rasterCompositor?.setDitherConfig(config); this.ctx.scheduleRender(); }
    getDitherConfig(): DitherConfig { return this.renderer?.rasterCompositor?.getDitherConfig() ?? defaultDitherConfig(); }
    setDitherEnabled(enabled: boolean): void { this.renderer?.rasterCompositor?.setDitherEnabled(enabled); this.ctx.scheduleRender(); }

    setDitherAlgorithm(algorithm: DitherAlgorithm): void { const cfg = this.getDitherConfig(); cfg.algorithm = algorithm; this.setDitherConfig(cfg); }
    setDitherStrength(strength: number): void { const cfg = this.getDitherConfig(); cfg.strength = Math.max(0, Math.min(1, strength)); this.setDitherConfig(cfg); }
    setDitherColorLevels(levels: number): void { const cfg = this.getDitherConfig(); cfg.colorLevels = Math.max(2, Math.min(256, Math.round(levels))); this.setDitherConfig(cfg); }
    setDitherPatternScale(scale: number): void { const cfg = this.getDitherConfig(); cfg.patternScale = Math.max(0.25, Math.min(8, scale)); this.setDitherConfig(cfg); }
    setDitherBayerLevel(level: number): void { const cfg = this.getDitherConfig(); cfg.bayerLevel = Math.max(0, Math.min(4, Math.round(level))); this.setDitherConfig(cfg); }
    setDitherHalftoneAngle(degrees: number): void { const cfg = this.getDitherConfig(); cfg.halftoneAngle = degrees % 360; this.setDitherConfig(cfg); }
    setDitherHalftoneFrequency(freq: number): void { const cfg = this.getDitherConfig(); cfg.halftoneFrequency = Math.max(2, Math.min(200, freq)); this.setDitherConfig(cfg); }
    setDitherPerChannel(perChannel: boolean): void { const cfg = this.getDitherConfig(); cfg.perChannel = perChannel; this.setDitherConfig(cfg); }

    static get DitherAlgorithms(): DitherAlgorithm[] {
        return ['bayer', 'halftone_dot', 'halftone_line', 'halftone_diamond', 'blue_noise', 'noise',
                'floyd_steinberg', 'atkinson', 'jarvis_judice_ninke', 'stucki', 'sierra', 'sierra_lite'];
    }
    static isErrorDiffusion(algorithm: DitherAlgorithm): boolean { return DitherEngine.isErrorDiffusion(algorithm); }

    // ── Per-Layer Dithering ──────────────────────────────────────────

    setLayerDitherConfig(layerId: string, config: DitherConfig | undefined): boolean {
        const ok = this.layerMgr?.setLayerDitherConfig(layerId, config) ?? false;
        if (ok) this.ctx.scheduleRender();
        return ok;
    }
    getLayerDitherConfig(layerId: string): DitherConfig | undefined { return this.layerMgr?.getLayerDitherConfig(layerId); }

    // ── Dither Color Controls ────────────────────────────────────────

    setDitherColorMode(mode: 'quantize' | 'duotone'): void { const cfg = this.getDitherConfig(); cfg.colorMode = mode; this.setDitherConfig(cfg); }
    setDitherForegroundColor(r: number, g: number, b: number, a = 1): void { const cfg = this.getDitherConfig(); cfg.foregroundColor = [r, g, b, a]; this.setDitherConfig(cfg); }
    setDitherBackgroundColor(r: number, g: number, b: number, a = 1): void { const cfg = this.getDitherConfig(); cfg.backgroundColor = [r, g, b, a]; this.setDitherConfig(cfg); }
    swapDitherColors(): void { const cfg = this.getDitherConfig(); const tmp = cfg.foregroundColor; cfg.foregroundColor = cfg.backgroundColor; cfg.backgroundColor = tmp; this.setDitherConfig(cfg); }
    setDitherInvertPattern(invert: boolean): void { const cfg = this.getDitherConfig(); cfg.invertPattern = invert; this.setDitherConfig(cfg); }
    setDitherTintOpacity(opacity: number): void { const cfg = this.getDitherConfig(); cfg.tintOpacity = Math.max(0, Math.min(1, opacity)); this.setDitherConfig(cfg); }
    setDitherDuotoneBias(bias: number): void { const cfg = this.getDitherConfig(); cfg.duotoneBias = Math.max(0, Math.min(1, bias)); this.setDitherConfig(cfg); }

    // ── Frame Link Animation ─────────────────────────────────────────

    setLayerFrameLinkAnimation(layerId: string, config: FrameLinkAnimation | undefined): boolean {
        const ok = this.layerMgr?.setLayerFrameLinkAnimation(layerId, config) ?? false;
        if (ok) this.ctx.emitSceneGraphChanged();
        return ok;
    }
    getLayerFrameLinkAnimation(layerId: string): FrameLinkAnimation | undefined { return this.layerMgr?.getLayerFrameLinkAnimation(layerId); }
    getDefaultFrameLinkAnimation(): FrameLinkAnimation { return { ...DEFAULT_FRAME_LINK_ANIMATION }; }
    setLayerFrameLinkEnabled(layerId: string, enabled: boolean): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.enabled = enabled; return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkType(layerId: string, type: FrameLinkAnimationType): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.type = type; return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkAmplitude(layerId: string, amplitude: number): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.amplitude = Math.max(0, amplitude); return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkFrequency(layerId: string, frequency: number): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.frequency = Math.max(0.01, frequency); return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkSpeed(layerId: string, speed: number): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.speed = Math.max(0, speed); return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkDirection(layerId: string, degrees: number): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.direction = degrees % 360; return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkPhase(layerId: string, phase: number): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.phase = phase; return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkLoopMode(layerId: string, mode: FrameLinkLoopMode): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.loopMode = mode; return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkAxes(layerId: string, displaceX: boolean, displaceY: boolean): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.displaceX = displaceX; cfg.displaceY = displaceY; return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkRippleCenter(layerId: string, x: number, y: number): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.rippleCenterX = Math.max(0, Math.min(1, x)); cfg.rippleCenterY = Math.max(0, Math.min(1, y)); return this.setLayerFrameLinkAnimation(layerId, cfg); }
    setLayerFrameLinkNoiseParams(layerId: string, octaves: number, lacunarity: number, persistence: number): boolean { const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION }; cfg.noiseOctaves = Math.max(1, Math.min(4, Math.round(octaves))); cfg.noiseLacunarity = Math.max(1, lacunarity); cfg.noisePersistence = Math.max(0, Math.min(1, persistence)); return this.setLayerFrameLinkAnimation(layerId, cfg); }
}
