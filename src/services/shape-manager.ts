/**
 * TODO: Implement APIs via Feature Managers to expose different core systems 
 * ShapeManager handles shape CRUD and registry-level updates.
 * FlowchartingManager handles smart arrows, node linking, and snapping points. 
 * CollaborationManager handles presence, pointer syncing, WebSocket relays, locks, etc.
 * AIStreamManager manages streaming AI inference into buffers/registries.
 * SDFTextManager (or FontManager) handles SDF texture atlases, typesetting, caret, line wrapping, etc.
 * See: feature-managers.txt
 */

import { LayerManager } from './layer-manager';
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Shape } from "../scene-graph/shapes/base/shape";
import { Node } from "../scene-graph/shapes/base/node";
import { RGBA } from "../types/rgba";
import { LineDrawingService } from "./drawing/line-drawing-service";
import { ScribbleDrawingService } from "./drawing/scribble-drawing-service";
import { TextDrawingService } from "./drawing/text-drawing-service";
import { hexToRgba } from "../utils/color";
import { EraserService } from "./drawing/eraser-service";
import { HighlightDrawingService } from "./drawing/highlight-drawing-service";
import { PatternDrawingService } from "./drawing/pattern-drawing-service";
import { ShapeType } from "../enums/shape-type";
import { InteractionService } from "./interaction-service";
import { Scribble } from "../scene-graph/shapes/scribble";
import { Highlight } from "../scene-graph/shapes/highlight";
import { Text } from "../scene-graph/shapes/text";
import { SectionDrawingService } from "./drawing/section-drawing-service";
import { Section } from "../scene-graph/shapes/section";
import { WebGPURenderer } from "../renderer/core/webgpu-renderer";
import { Group } from "../scene-graph/shapes/base/group";
import { EventEmitter } from "../renderer/util/event-emitter";
import { Line, ArrowheadStyle } from "../scene-graph/shapes/line";
import { SdfTextDrawingService } from "./drawing/sdftext-drawing-service";
import { SDFText } from "../scene-graph/shapes/sdf-text/sdf-text";
import { CacheService } from "./cache-service";
import { StickyNote } from "../scene-graph/shapes/sticky-note";
import { Pattern } from "../scene-graph/shapes/pattern";
import { StampDrawingService } from "./drawing/stamp-drawing-service";
import { PolygonDrawingService } from "./drawing/polygon-drawing-service";
import { PolygonPreset } from "../scene-graph/shapes/polygon";
import { RasterDrawingService } from "./raster-drawing-service";
import { RasterSelectionService } from "./raster-selection-service";
import { RasterMoveService } from "./raster-move-service";
import { RasterTextService, RasterTextState } from './raster-text-service';
import { RasterLayerManager } from './raster-layer-manager';
import { OnionSkinConfig } from '../animation';
import { ConnectorService, SnapResult } from './connector-service';
import { LayerBlendMode } from '../renderer/raster/core/raster-compositor';
import { DitherConfig, DitherAlgorithm, DitherColorMode, defaultDitherConfig, DitherEngine } from '../renderer/raster/effects/dither-engine';
import { TextEffectEngine, TextEffectType, TextEffectConfig, TextEffectParams, TextCaptureConfig, ChromaticAberrationParams, GlowParams, WaveParams, GlitchParams, OutlineParams, CustomShaderParams, CustomShaderCompileResult, defaultChromaticAberration, defaultGlow, defaultWave, defaultGlitch, defaultOutline, defaultCustomShader } from '../renderer/raster/effects/text-effect-engine';
import type { FrameLinkAnimation, FrameLinkAnimationType, FrameLinkLoopMode } from '../animation';
import { DEFAULT_FRAME_LINK_ANIMATION } from '../animation';
import { initWasm } from '../wasm/wasm-bindings';
import { Stamp } from "../scene-graph/shapes/stamp";
import { SpeechBalloon, SpeechBalloonOptions, TailSide, BalloonStyle } from "../scene-graph/shapes/speech-balloon";
import { LiveTextNode, LiveTextOptions } from "../scene-graph/shapes/live-text";
import { PanelLayout, PanelLayoutOptions, PanelTemplate, PanelDef } from "../scene-graph/shapes/panel-layout";
import { DualBrushSettings, DualBrushBlendOp, ColorJitter, WetEdgeSettings, StrokeTextureSettings, StabilizationMethod, BrushStabilization } from '../renderer/raster/brushes/brush-preset';
import { FloodFillEngine, FloodFillOptions } from '../renderer/raster/tools/flood-fill-engine';
import { DocumentPersistence, DocumentManifest, DocumentSavePayload, DocumentInfo, AutoSaveConfig, isOPFSAvailable } from './persistence/document-persistence';

class ShapeManager {
    private shapeFactory: ShapeFactory;
    private sceneGraph!: SceneGraph;
    private static instance: ShapeManager; // Singleton instance
    public lineDrawingService!: LineDrawingService;
    public patternDrawingService!: PatternDrawingService;
    public scribbleDrawingService!: ScribbleDrawingService;
    public textDrawingService!: TextDrawingService;
    public sdfTextDrawingService!: SdfTextDrawingService;
    public highlightDrawingService!: HighlightDrawingService;
    public sectionDrawingService!: SectionDrawingService;
    public interactionService!: InteractionService;
    public eraserService!: EraserService;
    public stampDrawingService!: StampDrawingService;
    public polygonDrawingService!: PolygonDrawingService;
    public rasterDrawingService!: RasterDrawingService;
    public rasterSelectionService?: RasterSelectionService;
    public rasterMoveService?: RasterMoveService;
    private rasterTextService?: RasterTextService;
    private connectorService?: ConnectorService;
    private shapeColor: RGBA = hexToRgba('#FFFFFF');
    private currentPreviewShape: Shape | null = null;
    /** Number of sides for the next regular polygon created via the toolbar. */
    public defaultPolygonSides: number = 6;
    private layerManager!: LayerManager;
    private webgpuRenderer!: WebGPURenderer;
    private rasterLayerManager?: RasterLayerManager;
    private floodFillEngine?: FloodFillEngine;
    private textEffectEngine?: TextEffectEngine;
    private persistence?: DocumentPersistence;
    private currentDocId: string = 'default';
    private currentDocName: string = 'Untitled';
    private _isRestoring = false;

    // --- rAF glue to the renderer ---
    private scheduleRender() { this.webgpuRenderer?.scheduleRender(); }
    private beginInteractive() { this.webgpuRenderer?.beginInteractive(); }
    private endInteractive() { this.webgpuRenderer?.endInteractive(); }

    /** Sync the renderer's animation frame counter from the timeline (for procedural displacement). */
    private syncRendererFrame(): void {
        if (this.webgpuRenderer) {
            this.webgpuRenderer.currentAnimationFrame =
                this.rasterLayerManager?.getTimeline().getCurrentFrame() ?? 1;
        }
    }

    private constructor(
        shapeFactory: ShapeFactory, 
        sceneGraph: SceneGraph, 
        lineDrawingService: LineDrawingService, 
        scribbleDrawingService: ScribbleDrawingService,
        textDrawingService: TextDrawingService,
        sdfTextDrawingService: SdfTextDrawingService,
        eraserService: EraserService,
        highlightDrawingService: HighlightDrawingService,
        patternDrawingService: PatternDrawingService,
        stampDrawingService: StampDrawingService,
        rasterDrawingService: RasterDrawingService | undefined,
        sectionDrawingService: SectionDrawingService,
        interactionService: InteractionService,
        webgpuRenderer: WebGPURenderer
    ) {
        this.shapeFactory = shapeFactory;
        this.sceneGraph = sceneGraph;
        this.lineDrawingService = lineDrawingService;
        this.scribbleDrawingService = scribbleDrawingService;
        this.textDrawingService = textDrawingService;
        this.sdfTextDrawingService = sdfTextDrawingService;
        this.highlightDrawingService = highlightDrawingService;
        this.eraserService = eraserService;
        this.patternDrawingService = patternDrawingService;
        this.stampDrawingService = stampDrawingService;
        this.webgpuRenderer = webgpuRenderer;
        if (rasterDrawingService) this.rasterDrawingService = rasterDrawingService;
            this.interactionService = interactionService;
            this.sectionDrawingService = sectionDrawingService;

            // Wire the selection guard so Shape.select() can check line-tool state
            // without importing ShapeManager (which would create a circular dependency).
            Shape.selectionGuard = () => this.lineDrawingService.isEnabled;

            // create layer manager around sceneGraph
            this.layerManager = new LayerManager(this.sceneGraph);
            // create raster-layer manager using GPU device from renderer
            try {
                const device = this.webgpuRenderer.getDevice();
                // Use illustration pixel size (matches artboard aspect ratio) if available
                const size = this.webgpuRenderer.getIllustrationPixelSize?.() ?? this.webgpuRenderer.getRasterTextureSize?.() ?? { w: 1024, h: 768 };
                // pass a composition callback so the renderer receives ordered textures
                this.rasterLayerManager = new RasterLayerManager(device, size.w, size.h, (list) => {
                    try { 
                        this.webgpuRenderer.setRasterCompositionList(list); 
                    } 
                    catch(e) { /* ignore */ }
                });
                this.webgpuRenderer.setRasterLayerManager(this.rasterLayerManager);
                // Create selection service (needs renderer + interaction service)
                this.rasterSelectionService = new RasterSelectionService(this.interactionService, this.webgpuRenderer);
                this.webgpuRenderer.setRasterSelectionService(this.rasterSelectionService);
                this.rasterMoveService = new RasterMoveService(this.interactionService, this.webgpuRenderer);
                this.webgpuRenderer.setRasterMoveService(this.rasterMoveService);
                console.log('RasterLayerManager created in ShapeManager');
                // Initialize WASM module for error diffusion dithering (non-blocking)
                initWasm().catch(e => console.warn('WASM init failed (error diffusion will be unavailable):', e));
            } 
            catch (e) {
                // ignore if device not available yet
                this.rasterLayerManager = undefined as any;
                console.log('RasterLayerManager NOT created in ShapeManager');
                console.log(e);
            }

            // Create connector service for flowcharting / smart arrows
            this.connectorService = new ConnectorService(this.sceneGraph);
            this.lineDrawingService.setConnectorService(this.connectorService);
            this.webgpuRenderer.setConnectorService(this.connectorService);

            // Create polygon drawing service (freeform polygon tool)
            this.polygonDrawingService = new PolygonDrawingService(
                this.interactionService, this.sceneGraph, this.shapeFactory
            );

            // Auto-update bound connectors when the scene graph changes
            this.interactionService.onSceneGraphChanged.subscribe(() => {
                this.connectorService?.updateBoundConnectors();
            });
    }

    // Public method to get the singleton instance
    static getInstance(
            shapeFactory?: ShapeFactory, 
            sceneGraph?: SceneGraph, 
            lineDrawingService?: LineDrawingService, 
            scribbleDrawingService?: ScribbleDrawingService,
            textDrawingService?: TextDrawingService,
            sdfTextDrawingService?: SdfTextDrawingService,
            eraserService?: EraserService,
            highlightDrawingService?: HighlightDrawingService,
            patternDrawingService?: PatternDrawingService,
            stampDrawingService?: StampDrawingService,
            rasterDrawingService?: RasterDrawingService,
            sectionDrawingService?: SectionDrawingService,
            interactionService?: InteractionService,
            webgpuRenderer?: WebGPURenderer
        ): ShapeManager 
    {
        if (!ShapeManager.instance) {
            if (!shapeFactory) throw new Error("ShapeFactory must be provided on first call!");
            if (!sceneGraph) throw new Error("SceneGraph must be provided on first call!");
            if (!lineDrawingService) throw new Error("Line Drawing Service must be provided on first call!");
            if (!scribbleDrawingService) throw new Error("Scribble Drawing Service must be provided on first call!");
            if (!highlightDrawingService) throw new Error("Highlight Drawing Service must be provided on first call!");
            if (!textDrawingService) throw new Error("Text Drawing Service must be provided on first call!");
            if (!sdfTextDrawingService) throw new Error("SDF Text Drawing Service must be provided on first call!");
            if (!eraserService) throw new Error("Eraser Service must be provided on first call!");
            if (!patternDrawingService) throw new Error("Pattern Drawing Service must be provided on first call!");
            if (!interactionService) throw new Error("Interaction Service must be provided on first call!");
            if (!sectionDrawingService) throw new Error("SectionDrawingService must be provided on first call!");
            if (!webgpuRenderer) throw new Error("WebGPURenderer must be provided on first call!");
            if (!stampDrawingService) throw new Error("Stamp Drawing Service must be provided on first call!");

            ShapeManager.instance = new ShapeManager(shapeFactory, sceneGraph, lineDrawingService, 
                scribbleDrawingService, textDrawingService, sdfTextDrawingService, 
                eraserService, highlightDrawingService, patternDrawingService, stampDrawingService, rasterDrawingService,
                sectionDrawingService, interactionService, webgpuRenderer);
        }
        return ShapeManager.instance;
    }

    public enableRasterDrawing() {
        this.rasterSelectionService?.disable();
        this.rasterMoveService?.disable();
        this.rasterDrawingService?.enable();
        this.webgpuRenderer?.setRenderMode('raster');
        this.beginInteractive();
    }

    public disableRasterDrawing() {
        this.rasterDrawingService?.disable();
    }

    /** Enable selection tool mode (disables drawing). */
    public enableRasterSelection(tool: 'rect' | 'ellipse' | 'lasso' | 'magic-wand' = 'rect') {
        // Commit any in-progress transform before switching
        const info = this.rasterSelectionService?.getSelectionInfo();
        if (info?.isTransforming) this.rasterSelectionService?.commitTransform();
        this.rasterDrawingService?.disable();
        this.rasterMoveService?.disable();
        this.rasterSelectionService?.setTool(tool);
        this.rasterSelectionService?.enable();
        this.webgpuRenderer?.setRenderMode('raster');
    }

    /** Disable selection tool mode. */
    public disableRasterSelection() {
        const info = this.rasterSelectionService?.getSelectionInfo();
        if (info?.isTransforming) this.rasterSelectionService?.commitTransform();
        this.rasterSelectionService?.disable();
    }

    /** Enable the raster move/grab tool (translates the active layer's pixels). */
    public enableRasterMove() {
        const info = this.rasterSelectionService?.getSelectionInfo();
        if (info?.isTransforming) this.rasterSelectionService?.commitTransform();
        this.rasterDrawingService?.disable();
        this.rasterSelectionService?.disable();
        this.rasterMoveService?.enable();
        this.webgpuRenderer?.setRenderMode('raster');
    }

    /** Disable the raster move/grab tool. */
    public disableRasterMove() {
        this.rasterMoveService?.disable();
    }

    // ── Flood Fill / Paint Bucket ─────────────────────────────────────

    /**
     * Fill a contiguous region with color (paint bucket tool).
     *
     * The fill starts at (x, y) in texel coordinates and expands to all
     * connected pixels whose color is within `tolerance` of the seed pixel.
     *
     * Options:
     *  - `tolerance` (0–255): color similarity threshold. 0 = exact match only.
     *  - `gapClosing` (0–5): close small gaps in lineart before filling (pixels).
     *  - `contiguous` (true/false): fill only the connected region (true) or all
     *    similar-color pixels on the layer (false, like "fill by color").
     *  - `referenceLayerId`: use another layer's pixels to determine the fill
     *    boundary, but actually paint on the active layer. This is the standard
     *    manga workflow: ink on one layer, flat-fill on a separate layer below.
     *
     * @returns `true` if any pixels were filled, `false` if the click was out
     *          of bounds or the region was empty.
     *
     * Example:
     * ```ts
     * await shapeManager.floodFill(120, 80, '#FF6B9D', {
     *   tolerance: 32,
     *   gapClosing: 2,
     *   referenceLayerId: inkLayerId,
     * });
     * ```
     */
    public async floodFill(
        x: number,
        y: number,
        colorHex: string,
        options?: {
            tolerance?: number;
            gapClosing?: number;
            contiguous?: boolean;
            referenceLayerId?: string;
        },
    ): Promise<boolean> {
        if (!this.rasterLayerManager) return false;
        const device = this.webgpuRenderer.getDevice();
        if (!device) return false;

        if (!this.floodFillEngine) {
            this.floodFillEngine = new FloodFillEngine(device);
        }

        // Get the active layer's texture
        const activeLayerId = this.rasterLayerManager.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = this.rasterLayerManager.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;

        // Parse hex color to RGBA 0-1 (hexToRgba already returns 0-1 range)
        const rgba = hexToRgba(colorHex);
        const color: [number, number, number, number] = [
            rgba.r, rgba.g, rgba.b, rgba.a ?? 1,
        ];

        // Resolve reference texture if specified
        let referenceTexture: GPUTexture | undefined;
        if (options?.referenceLayerId) {
            const refLayer = this.rasterLayerManager.getLayerById(options.referenceLayerId);
            referenceTexture = refLayer?.texture ?? undefined;
        }

        // Get selection mask if active
        const selMask = this.rasterSelectionService?.getSelectionInfo()?.hasSelection
            ? (this.rasterSelectionService as any)?.engine?.getMaskTexture() ?? undefined
            : undefined;

        const result = await this.floodFillEngine.fill(activeLayer.texture, {
            x: Math.floor(x),
            y: Math.floor(y),
            color,
            tolerance: options?.tolerance ?? 32,
            gapClosing: options?.gapClosing ?? 0,
            contiguous: options?.contiguous ?? true,
            referenceTexture,
            selectionMask: selMask,
        });

        if (result) {
            this.scheduleRender();
        }
        return result;
    }

    /**
     * Convert world-space coordinates to texel (pixel) coordinates on the raster canvas.
     * Returns null if illustration mode is not active or texture size is unavailable.
     */
    public worldToTexel(worldX: number, worldY: number): { tx: number; ty: number } | null {
        const texSize = this.webgpuRenderer.getRasterTextureSize?.();
        if (!texSize) return null;
        const bounds = this.webgpuRenderer.getIllustrationBounds?.();
        const worldW = bounds?.width ?? 2.0;
        const worldH = bounds?.height ?? 2.0;
        const hw = worldW / 2;
        const hh = worldH / 2;
        const tx = Math.floor(((worldX + hw) / worldW) * texSize.w);
        const ty = Math.floor(((hh - worldY) / worldH) * texSize.h);
        return { tx, ty };
    }

    /**
     * Flood-fill at a world-space position (convenience wrapper).
     * Automatically converts world coordinates to texel coordinates.
     *
     * ```ts
     * // In a pointer event handler:
     * const { x, y } = interactionService.toWorldCoords(event);
     * await shapeManager.floodFillWorld(x, y, '#ff0000', { tolerance: 32 });
     * ```
     */
    public async floodFillWorld(
        worldX: number,
        worldY: number,
        colorHex: string,
        options?: {
            tolerance?: number;
            gapClosing?: number;
            contiguous?: boolean;
            referenceLayerId?: string;
        },
    ): Promise<boolean> {
        const texel = this.worldToTexel(worldX, worldY);
        if (!texel) return false;
        return this.floodFill(texel.tx, texel.ty, colorHex, options);
    }

    /**
     * Fill the entire current selection with a solid color.
     * If no selection is active, fills the entire layer.
     */
    public async fillSelection(colorHex: string): Promise<boolean> {
        if (!this.rasterLayerManager) return false;
        const device = this.webgpuRenderer.getDevice();
        if (!device) return false;

        if (!this.floodFillEngine) {
            this.floodFillEngine = new FloodFillEngine(device);
        }

        const activeLayerId = this.rasterLayerManager.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = this.rasterLayerManager.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;

        const rgba = hexToRgba(colorHex);
        const color: [number, number, number, number] = [
            rgba.r, rgba.g, rgba.b, rgba.a ?? 1,
        ];

        // Fill the whole layer — non-contiguous, tolerance=255 fills everything
        const result = await this.floodFillEngine.fill(activeLayer.texture, {
            x: 0,
            y: 0,
            color,
            tolerance: 255,
            gapClosing: 0,
            contiguous: false,
            selectionMask: this.rasterSelectionService?.getSelectionInfo()?.hasSelection
                ? (this.rasterSelectionService as any)?.engine?.getMaskTexture() ?? undefined
                : undefined,
        });

        if (result) this.scheduleRender();
        return result;
    }

    // ── Raster Text Tool ─────────────────────────────────────────────

    /** Get or lazily create the raster text service. */
    private ensureRasterTextService(): RasterTextService {
        if (!this.rasterTextService) {
            this.rasterTextService = new RasterTextService(this.interactionService, this.webgpuRenderer);
            this.webgpuRenderer.setRasterTextService(this.rasterTextService);
        }
        return this.rasterTextService;
    }

    /** Enable the raster text tool (click to place, type to enter text, Enter to stamp). */
    public enableRasterText(): void {
        this.rasterDrawingService?.disable();
        this.rasterSelectionService?.disable();
        this.ensureRasterTextService().enable();
        this.webgpuRenderer?.setRenderMode('raster');
    }

    /** Disable the raster text tool (commits any active text first). */
    public disableRasterText(): void {
        this.rasterTextService?.disable();
    }

    /** Get the current raster text state (for UI binding). */
    public getRasterTextState(): RasterTextState | null {
        return this.rasterTextService?.getState() ?? null;
    }

    /** Update raster text properties during preview (font, size, color, etc.). */
    public updateRasterTextProperties(props: Partial<Pick<RasterTextState,
        'font' | 'fontSize' | 'bold' | 'italic' | 'align' | 'color' | 'maxWidth' | 'lineHeight'
    >>): void {
        this.rasterTextService?.updateProperties(props);
    }

    /** Commit (stamp) the current raster text onto the active layer. */
    public commitRasterText(): void {
        this.rasterTextService?.commit();
    }

    /** Cancel the current raster text entry. */
    public cancelRasterText(): void {
        this.rasterTextService?.cancel();
    }

    /** Subscribe to raster text state changes. Returns unsubscribe handle. */
    public onRasterTextStateChanged(cb: (state: RasterTextState) => void): { unsubscribe: () => void } {
        return this.ensureRasterTextService().onStateChanged.subscribe(cb);
    }

    /** Set the active selection tool ('rect' | 'ellipse' | 'lasso'). */
    public setRasterSelectionTool(tool: 'rect' | 'ellipse' | 'lasso') {
        this.rasterSelectionService?.setTool(tool);
    }

    /** Set the selection mode: 'new' replaces, 'add' unions (Shift), 'subtract' removes (Alt). */
    public setRasterSelectionMode(mode: 'new' | 'add' | 'subtract') {
        this.rasterSelectionService?.setMode(mode);
    }

    /** Get the current selection mode. */
    public getRasterSelectionMode(): 'new' | 'add' | 'subtract' {
        return this.rasterSelectionService?.getMode() ?? 'new';
    }

    // Toggle raster drawing tool only, without changing renderer's render mode.
    // Use this when the UI (Frogmarks) wants to enable the tool but keep
    // rendering in its current mode.
    public enableRasterTool() {
        this.rasterDrawingService?.setEraserMode('paint');
        this.rasterDrawingService?.enable();
    }

    public disableRasterTool() {
        this.rasterDrawingService?.disable();
    }

    public setRasterBrushSize(size: number) {
        this.rasterDrawingService?.setBrushRadiusPx(size);
    }

    public setRasterBrushColor(color: string) {
        this.rasterDrawingService?.setBrushColor(hexToRgba(color));
    }

    // Raster-specific eraser helpers (do not conflict with the scribble eraser service)
    public enableRasterEraserTool() {
        this.rasterDrawingService?.setEraserMode('erase');
        this.rasterDrawingService?.enable();
        this.beginInteractive();
    }

    public enableRasterClearEraserTool() {
        this.rasterDrawingService?.setEraserMode('clear');
        this.rasterDrawingService?.enable();
        this.beginInteractive();
    }

    public disableRasterEraserTool() {
        this.rasterDrawingService?.setEraserMode('paint');
        this.rasterDrawingService?.disable();
        this.endInteractive();
    }

    // Stroke event subscription helpers
    public onRasterStrokeStart(listener: (v: any) => void) { return this.rasterDrawingService?.onStrokeStart.subscribe(listener); }
    public onRasterStrokeUpdate(listener: (v: any) => void) { return this.rasterDrawingService?.onStrokeUpdate.subscribe(listener); }
    public onRasterStrokeEnd(listener: (v: any) => void) { return this.rasterDrawingService?.onStrokeEnd.subscribe(listener); }

    // Provide raster texture size to external clients
    public getRasterTextureSize(): { w:number, h:number } | null {
        if (!this.webgpuRenderer) return null;
        return this.webgpuRenderer.getRasterTextureSize?.() ?? null;
    }

    // Undo/Redo wrappers — route through the selected raster layer when available
    public async rasterUndo(): Promise<boolean> {
        const selectedId = this.rasterLayerManager?.getSelectedLayerId();
        if (selectedId && this.rasterLayerManager) {
            const ok = await this.rasterLayerManager.undoForLayer(selectedId);
            if (ok) this.scheduleRender();
            return !!ok;
        }
        // Fallback: renderer-level undo (no layer manager)
        if (!this.webgpuRenderer) return false;
        const ok = await (this.webgpuRenderer as any).rasterUndo?.();
        if (ok) this.scheduleRender();
        return ok;
    }

    public async rasterRedo(): Promise<boolean> {
        const selectedId = this.rasterLayerManager?.getSelectedLayerId();
        if (selectedId && this.rasterLayerManager) {
            const ok = await this.rasterLayerManager.redoForLayer(selectedId);
            if (ok) this.scheduleRender();
            return !!ok;
        }
        if (!this.webgpuRenderer) return false;
        const ok = await (this.webgpuRenderer as any).rasterRedo?.();
        if (ok) this.scheduleRender();
        return ok;
    }

    public rasterPushSnapshot(): void {
        const selectedId = this.rasterLayerManager?.getSelectedLayerId();
        if (selectedId && this.rasterLayerManager) {
            this.rasterLayerManager.pushSnapshotForLayer(selectedId);
            return;
        }
        (this.webgpuRenderer as any)?.rasterPushSnapshot?.();
    }

    // Raster-layer management
    public getRasterLayers() {
        return this.rasterLayerManager?.getLayers() ?? [];
    }

    // Per-layer snapshot/undo/redo helpers
    public pushSnapshotForRasterLayer(id: string) {
        return this.rasterLayerManager?.pushSnapshotForLayer(id) ?? false;
    }

    public async undoRasterLayer(id: string) {
        return await (this.rasterLayerManager?.undoForLayer(id) ?? false);
    }

    public async redoRasterLayer(id: string) {
        return await (this.rasterLayerManager?.redoForLayer(id) ?? false);
    }

    public addRasterLayer(name: string = 'Layer') {
        const l = this.rasterLayerManager?.addLayer(name);
        this.emitSceneGraphChanged();
        return l;
    }

    public deleteRasterLayer(id: string) {
        const ok = this.rasterLayerManager?.deleteLayer(id) ?? false;
        if (ok) this.emitSceneGraphChanged();
        return ok;
    }

    public selectRasterLayer(id: string) {
        return this.rasterLayerManager?.selectLayer(id) ?? false;
    }

    public setRasterLayerVisibility(id: string, visible: boolean) {
        const ok = this.rasterLayerManager?.setVisibility(id, visible) ?? false;
        if (ok) this.emitSceneGraphChanged();
        return ok;
    }

    // ── Layer Compositor Controls (Phase 2) ──────────────────────────

    /** Set the blend mode for a raster layer. */
    public setRasterLayerBlendMode(id: string, mode: LayerBlendMode): boolean {
        const ok = this.rasterLayerManager?.setBlendMode(id, mode) ?? false;
        if (ok) this.emitSceneGraphChanged();
        return ok;
    }

    /** Set per-layer opacity (0-1). */
    public setRasterLayerOpacity(id: string, opacity: number): boolean {
        const ok = this.rasterLayerManager?.setOpacity(id, opacity) ?? false;
        if (ok) this.emitSceneGraphChanged();
        return ok;
    }

    /** Enable/disable clipping mask (clip to alpha of layer below). */
    public setRasterLayerClipping(id: string, clipped: boolean): boolean {
        const ok = this.rasterLayerManager?.setClipping(id, clipped) ?? false;
        if (ok) this.emitSceneGraphChanged();
        return ok;
    }

    /** Enable/disable lock transparency (paint only where alpha > 0). */
    public setRasterLayerLockTransparency(id: string, locked: boolean): boolean {
        const ok = this.rasterLayerManager?.setLockTransparency(id, locked) ?? false;
        return ok;
    }

    /** Reorder raster layers. Pass an array of layer ids in desired order (bottom-to-top). */
    public reorderRasterLayers(orderedIds: string[]) {
        this.rasterLayerManager?.reorderLayers(orderedIds);
        this.emitSceneGraphChanged();
    }

    /** Get the LayerBlendMode enum for use in Frogmarks UI. */
    public static get LayerBlendMode() {
        return LayerBlendMode;
    }

    // ── Selection & Transform Tools (Phase 3) ───────────────────────

    /** Get the selection engine (if initialized). */
    private getSelectionEngine() {
        return this.webgpuRenderer?.rasterSelectionEngine;
    }

    /** Create a rectangular selection. Coordinates are in texel space. */
    public rasterSelectRect(x: number, y: number, w: number, h: number, feather: number = 0): void {
        this.getSelectionEngine()?.selectRect({ x, y, w, h }, feather);
    }

    /** Create an elliptical selection inside the given bounding rect. */
    public rasterSelectEllipse(x: number, y: number, w: number, h: number, feather: number = 0): void {
        this.getSelectionEngine()?.selectEllipse({ x, y, w, h }, feather);
    }

    /** Create a lasso (freeform polygon) selection. Points are [{x,y},...] in texel coords. */
    public rasterSelectLasso(points: Array<{ x: number; y: number }>): void {
        this.getSelectionEngine()?.selectLasso(points);
    }

    /** Select the entire canvas. */
    public rasterSelectAll(): void {
        this.getSelectionEngine()?.selectAll();
    }

    /** Deselect all (clear selection). */
    public rasterDeselectAll(): void {
        this.getSelectionEngine()?.deselectAll();
    }

    /** Invert the selection. */
    public rasterInvertSelection(): void {
        this.getSelectionEngine()?.invertSelection();
    }

    /** Delete selected pixels (set to transparent). */
    public rasterDeleteSelection(): void {
        this.getSelectionEngine()?.deleteSelection();
    }

    /** Cut selected pixels (copy + delete). */
    public async rasterCutSelection(): Promise<void> {
        await this.getSelectionEngine()?.cutSelection();
    }

    /** Copy selected pixels to clipboard. */
    public async rasterCopySelection(): Promise<void> {
        await this.getSelectionEngine()?.copySelection();
    }

    /** Paste from clipboard (creates a floating selection for transform). */
    public rasterPaste(): void {
        this.getSelectionEngine()?.paste();
    }

    /** Begin transforming the selected pixels (lift into floating layer). */
    public rasterBeginTransform(): void {
        this.getSelectionEngine()?.beginTransform();
    }

    /** Update the in-progress transform (call during drag). */
    public rasterUpdateTransform(dx: number, dy: number, scaleX?: number, scaleY?: number, rotation?: number): void {
        this.getSelectionEngine()?.updateTransform(dx, dy, scaleX, scaleY, rotation);
    }

    /** Commit the transform (stamp floating pixels at new position). */
    public rasterCommitTransform(): void {
        this.getSelectionEngine()?.commitTransform();
    }

    /** Cancel the transform (put pixels back where they were). */
    public rasterCancelTransform(): void {
        this.getSelectionEngine()?.cancelTransform();
    }

    /** Get current selection info (bounds, transform state) for UI rendering. */
    public getRasterSelectionInfo() {
        return this.getSelectionEngine()?.getSelectionInfo() ?? {
            hasSelection: false,
            bounds: null,
            isTransforming: false,
            transform: null,
            dragPreview: null,
        };
    }

    // ── Magic Wand ──────────────────────────────────────────────────

    /**
     * Magic wand: select all contiguous pixels of similar color at (x, y).
     *
     * This is the "click to select region" tool. It samples the color at the
     * seed pixel and selects all connected pixels within the tolerance.
     *
     * @param x Seed pixel X (texel coordinates)
     * @param y Seed pixel Y (texel coordinates)
     * @param tolerance Color similarity 0–255 (0 = exact match, 32 = standard, 64+ = loose)
     * @param options Additional options (contiguous, referenceLayerId, mode)
     *
     * Example:
     * ```ts
     * await shapeManager.rasterSelectMagicWand(120, 80, 32, {
     *   contiguous: true,
     *   mode: 'add',
     *   referenceLayerId: inkLayerId,
     * });
     * ```
     */
    public async rasterSelectMagicWand(
        x: number, y: number,
        tolerance: number = 32,
        options?: {
            contiguous?: boolean;
            mode?: 'new' | 'add' | 'subtract';
            referenceLayerId?: string;
        },
    ): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        let refTex: GPUTexture | undefined;
        if (options?.referenceLayerId && this.rasterLayerManager) {
            const refLayer = this.rasterLayerManager.getLayerById(options.referenceLayerId);
            refTex = refLayer?.texture ?? undefined;
        }
        await engine.selectMagicWand(
            Math.floor(x), Math.floor(y),
            tolerance,
            options?.contiguous ?? true,
            options?.mode ?? 'new',
            refTex,
        );
        this.scheduleRender();
    }

    /**
     * Select by color: select ALL pixels of a similar color across the entire
     * layer (non-contiguous). Like magic wand but not limited to connected region.
     */
    public async rasterSelectByColor(
        x: number, y: number,
        tolerance: number = 32,
        mode: 'new' | 'add' | 'subtract' = 'new',
    ): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        await engine.selectByColor(Math.floor(x), Math.floor(y), tolerance, mode);
        this.scheduleRender();
    }

    /**
     * Configure the magic wand options on the selection service.
     * These are used when the magic wand is the active selection tool
     * and the user clicks on the canvas.
     */
    public setMagicWandOptions(opts: { tolerance?: number; contiguous?: boolean; referenceLayerId?: string }): void {
        let refTex: GPUTexture | undefined;
        if (opts.referenceLayerId && this.rasterLayerManager) {
            const refLayer = this.rasterLayerManager.getLayerById(opts.referenceLayerId);
            refTex = refLayer?.texture ?? undefined;
        }
        this.rasterSelectionService?.setMagicWandOptions({
            tolerance: opts.tolerance,
            contiguous: opts.contiguous,
            referenceLayerTexture: refTex,
        });
    }

    // ── Transform Convenience Methods ───────────────────────────────

    /**
     * Flip the selection horizontally (mirror left↔right).
     * Must have an active selection. Begins a transform if not already transforming.
     */
    public async rasterFlipHorizontal(): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        const info = engine.getSelectionInfo();
        if (!info.hasSelection) return;

        if (!info.isTransforming) {
            await engine.beginTransform();
        }
        const state = info.transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        engine.updateTransform(
            state.translateX, state.translateY,
            -state.scaleX, state.scaleY,
            state.rotation,
        );
        await engine.commitTransform();
        this.scheduleRender();
    }

    /**
     * Flip the selection vertically (mirror top↔bottom).
     * Must have an active selection.
     */
    public async rasterFlipVertical(): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        const info = engine.getSelectionInfo();
        if (!info.hasSelection) return;

        if (!info.isTransforming) {
            await engine.beginTransform();
        }
        const state = info.transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        engine.updateTransform(
            state.translateX, state.translateY,
            state.scaleX, -state.scaleY,
            state.rotation,
        );
        await engine.commitTransform();
        this.scheduleRender();
    }

    /**
     * Rotate the selection by a fixed angle (degrees).
     * Common values: 90, 180, 270, -90.
     * Must have an active selection.
     */
    public async rasterRotate(degrees: number): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        const info = engine.getSelectionInfo();
        if (!info.hasSelection) return;

        if (!info.isTransforming) {
            await engine.beginTransform();
        }
        const state = info.transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        const radians = (degrees * Math.PI) / 180;
        engine.updateTransform(
            state.translateX, state.translateY,
            state.scaleX, state.scaleY,
            state.rotation + radians,
        );
        await engine.commitTransform();
        this.scheduleRender();
    }

    /**
     * Scale the selection by the given factors.
     * scaleX/scaleY = 1.0 = original, 2.0 = double, 0.5 = half.
     */
    public async rasterScale(scaleX: number, scaleY: number): Promise<void> {
        const engine = this.getSelectionEngine();
        if (!engine) return;
        const info = engine.getSelectionInfo();
        if (!info.hasSelection) return;

        if (!info.isTransforming) {
            await engine.beginTransform();
        }
        const state = info.transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        engine.updateTransform(
            state.translateX, state.translateY,
            state.scaleX * scaleX, state.scaleY * scaleY,
            state.rotation,
        );
        await engine.commitTransform();
        this.scheduleRender();
    }

    // For renderer composition: get ordered visible textures
    public getRasterTexturesForComposition() {
        return this.rasterLayerManager?.getTextureForComposition() ?? [];
    }

    // ── Brush Preset Management (Frogmarks integration) ─────────────

    /** Get the RasterPaintEngine (if initialized). */
    public getRasterPaintEngine() {
        return this.rasterDrawingService?.getPaintEngine();
    }

    /** Get all brush presets. */
    public getBrushPresets() {
        return this.getRasterPaintEngine()?.getPresets() ?? [];
    }

    /** Get a specific brush preset by id. */
    public getBrushPreset(id: string) {
        return this.getRasterPaintEngine()?.getPreset(id);
    }

    /** Set the active brush preset by id. */
    public setActiveBrushPreset(id: string): boolean {
        return this.getRasterPaintEngine()?.setActivePreset(id) ?? false;
    }

    /** Get the active brush preset id. */
    public getActiveBrushPresetId(): string | null {
        return this.getRasterPaintEngine()?.getActivePresetId() ?? null;
    }

    /** Import a brush preset from JSON (from Frogmarks). Returns the new preset id. */
    public importBrushPreset(json: string): string | null {
        try {
            return this.getRasterPaintEngine()?.importPreset(json) ?? null;
        } catch (e) {
            console.warn('Failed to import brush preset:', e);
            return null;
        }
    }

    /** Export a brush preset to JSON (for Frogmarks). */
    public exportBrushPreset(presetId: string): string | null {
        return this.getRasterPaintEngine()?.exportPreset(presetId) ?? null;
    }

    /** Import multiple brush presets from a JSON array. Returns the new ids. */
    public importBrushPresets(json: string): string[] {
        try {
            return this.getRasterPaintEngine()?.importPresets(json) ?? [];
        } catch (e) {
            console.warn('Failed to import brush presets:', e);
            return [];
        }
    }

    /** Export all brush presets as a JSON array string. */
    public exportAllBrushPresets(): string {
        return this.getRasterPaintEngine()?.exportAllPresets() ?? '[]';
    }

    /** Register a new brush preset object directly. */
    public registerBrushPreset(preset: any) {
        this.getRasterPaintEngine()?.registerPreset(preset);
    }

    /** Delete a brush preset by id. */
    public deleteBrushPreset(id: string): boolean {
        return this.getRasterPaintEngine()?.deletePreset(id) ?? false;
    }

    /**
     * Update fields on an existing brush preset (partial merge).
     * Frogmarks uses this to tweak individual settings from the brush editor.
     */
    public updateBrushPreset(id: string, changes: Record<string, any>): boolean {
        return this.getRasterPaintEngine()?.updatePreset(id, changes) ?? false;
    }

    // ── Dual Brush (shape × texture per dab) ──────────────────────────

    /**
     * Configure the dual brush settings on a preset.
     * The dual brush multiplies a second (grunge/grain) texture with the tip shape
     * per dab, creating organic, textured strokes.
     *
     * Example:
     * ```
     * shapeManager.setBrushDualBrush('my-preset-id', {
     *   enabled: true,
     *   textureData: '<base64 png>',
     *   textureSize: 256,
     *   tileMode: 'dab-local',
     *   scale: 1.5,
     *   blendOp: 'multiply',
     *   strength: 0.7,
     *   randomRotation: true,
     * });
     * ```
     */
    public setBrushDualBrush(presetId: string, settings: DualBrushSettings): boolean {
        return this.updateBrushPreset(presetId, { dualBrush: settings });
    }

    // ── Color Jitter (per-dab H/S/B randomization) ────────────────────

    /**
     * Configure color jitter on a preset. Per-dab random variation in hue,
     * saturation, brightness, and opacity. Makes watercolor/gouache look alive.
     *
     * Example:
     * ```
     * shapeManager.setBrushColorJitter('my-preset-id', {
     *   hueJitter: 5,          // ±5 degrees
     *   saturationJitter: 0.1,  // ±10%
     *   brightnessJitter: 0.05, // ±5%
     *   opacityJitter: 0,
     * });
     * ```
     */
    public setBrushColorJitter(presetId: string, jitter: ColorJitter): boolean {
        return this.updateBrushPreset(presetId, { colorJitter: jitter });
    }

    // ── Wet Edges (post-stroke edge darkening) ────────────────────────

    /**
     * Configure wet edges on a preset. Darkens and concentrates pigment at
     * the borders of strokes, simulating watercolor's characteristic wet edges.
     *
     * Example:
     * ```
     * shapeManager.setBrushWetEdges('my-preset-id', {
     *   enabled: true,
     *   edgeDarkness: 0.4,
     *   edgeWidth: 2,
     *   strength: 0.6,
     * });
     * ```
     */
    public setBrushWetEdges(presetId: string, settings: WetEdgeSettings): boolean {
        return this.updateBrushPreset(presetId, { wetEdges: settings });
    }

    /** Get the DualBrushBlendOp enum for use in Frogmarks UI. */
    public static get DualBrushBlendOp(): Record<string, DualBrushBlendOp> {
        return { Multiply: 'multiply', Subtract: 'subtract', Minimum: 'minimum' };
    }

    // ── Stroke Texture Mapping (textured strip along stroke path) ─────

    /**
     * Configure stroke texture mapping on a preset. When enabled, the brush
     * renders a textured strip along the stroke path instead of individual dabs.
     * Ideal for charcoal, crayon, dry marker, and chalk brushes.
     *
     * Example:
     * ```
     * shapeManager.setBrushStrokeTexture('my-preset-id', {
     *   enabled: true,
     *   textureData: '<base64 png>',
     *   textureSize: 256,
     *   texelsPerUnit: 0.5,
     *   edgeSoftness: 0.2,
     * });
     * ```
     */
    public setBrushStrokeTexture(presetId: string, settings: StrokeTextureSettings): boolean {
        return this.updateBrushPreset(presetId, { strokeTexture: settings });
    }

    // ── Brush Grain (per-brush texture, from brush editor) ────────────

    /**
     * Set the per-brush grain that modulates dab alpha during painting.
     * This is the grain you tweak per-brush in the brush editor.
     * Example: `setBrushGrain({ type: 'cold-press', scale: 1.0, strength: 0.5 })`
     * Set type to 'none' to disable.
     */
    public setBrushGrain(settings: { type: string; scale: number; strength: number }): void {
        this.getRasterPaintEngine()?.setBrushGrain(settings as any);
        this.scheduleRender();
    }

    /** Get the current per-brush grain settings. */
    public getBrushGrain(): { type: string; scale: number; strength: number } {
        return this.getRasterPaintEngine()?.getBrushGrain() ?? { type: 'none', scale: 1.0, strength: 0.5 };
    }

    // ── Brush Stabilization ────────────────────────────────────────────

    /**
     * Set the stabilization method and level on a brush preset.
     *
     * Methods:
     *  - `'none'` — No smoothing. Raw input goes directly to the brush engine.
     *  - `'moving-average'` — Weighted average of the last N points. Low latency,
     *    good general-purpose smoothing. The standard for most drawing tools.
     *  - `'predictive'` — Exponential smoothing. Dampens jitter while tracking
     *    fast movements. Good for sketching.
     *  - `'catmull-rom'` — Fits a Catmull-Rom spline through recent points.
     *    Produces the smoothest curves with natural curvature. Best for inking.
     *  - `'pull-string'` — The cursor drags a virtual string; the brush only
     *    moves when the string goes taut. Produces very deliberate, controlled
     *    lines. Set `pullStringLength` for string length in pixels (10–60).
     *
     * Level (0–10): Higher = more smoothing but more latency.
     *  - 0: effectively disabled
     *  - 3: light smoothing (fast sketching)
     *  - 5–6: medium (general inking)
     *  - 8–10: heavy (slow, precise calligraphy)
     *
     * Example:
     * ```ts
     * shapeManager.setBrushStabilization('hard-pen', {
     *   method: 'catmull-rom',
     *   level: 6,
     * });
     *
     * shapeManager.setBrushStabilization('liner', {
     *   method: 'pull-string',
     *   level: 5,
     *   pullStringLength: 40,
     * });
     * ```
     */
    public setBrushStabilization(presetId: string, settings: BrushStabilization): boolean {
        return this.updateBrushPreset(presetId, { stabilization: settings });
    }

    /**
     * Get the stabilization settings for a brush preset.
     * Returns `{ method, level, pullStringLength? }`.
     */
    public getBrushStabilization(presetId: string): BrushStabilization | null {
        const preset = this.getRasterPaintEngine()?.getPreset(presetId);
        return preset?.stabilization ?? null;
    }

    /**
     * Convenience: set stabilization on the currently active brush.
     */
    public setActiveStabilization(settings: BrushStabilization): boolean {
        const id = this.getActiveBrushPresetId();
        if (!id) return false;
        return this.setBrushStabilization(id, settings);
    }

    /**
     * Get stabilization settings for the currently active brush.
     */
    public getActiveStabilization(): BrushStabilization | null {
        const id = this.getActiveBrushPresetId();
        if (!id) return null;
        return this.getBrushStabilization(id);
    }

    /**
     * @deprecated Use setBrushGrain instead. Kept for backward compatibility.
     */
    public setCanvasGrain(settings: { type: string; scale: number; strength: number }): void {
        this.setBrushGrain(settings);
    }

    /** @deprecated Use getBrushGrain instead. */
    public getCanvasGrain(): { type: string; scale: number; strength: number } {
        return this.getBrushGrain();
    }

    // ── Paper Grain (global canvas material) ─────────────────────────

    /**
     * Set the global paper grain — the physical paper/canvas material texture.
     * This is applied as a post-process to the entire canvas, making it look
     * like real textured paper. Independent of per-brush grain.
     * Example: `setPaperGrain({ type: 'cold-press', scale: 1.0, strength: 0.3 })`
     * Set type to 'none' to disable the paper texture.
     */
    public setPaperGrain(settings: { type: string; scale: number; strength: number }): void {
        this.getRasterPaintEngine()?.setPaperGrain(settings as any);
        this.scheduleRender();
    }

    /** Get the current paper grain settings. */
    public getPaperGrain(): { type: string; scale: number; strength: number } {
        return this.getRasterPaintEngine()?.getPaperGrain() ?? { type: 'none', scale: 1.0, strength: 0.3 };
    }

    /** Get the list of available grain type names (for UI dropdowns). */
    public getAvailableGrainTypes(): string[] {
        return this.getRasterPaintEngine()?.getAvailableGrainTypes() ?? ['none'];
    }

    // ── Dithering Effects (non-destructive post-process) ─────────────

    /**
     * Set the **global** dither configuration.
     * The global dither effect is applied non-destructively after all layers
     * are composited (and after per-layer dithering) but before the paper grain overlay.
     *
     * For per-layer dithering, use `setLayerDitherConfig()` instead.
     *
     * Example:
     * ```
     * shapeManager.setDitherConfig({
     *   enabled: true,
     *   algorithm: 'bayer',
     *   colorLevels: 2,
     *   bayerLevel: 2,
     *   halftoneAngle: 45,
     *   halftoneFrequency: 40,
     *   strength: 1.0,
     *   patternScale: 1.0,
     *   perChannel: false,
     * });
     * ```
     */
    public setDitherConfig(config: DitherConfig): void {
        this.webgpuRenderer?.rasterCompositor?.setDitherConfig(config);
        this.scheduleRender();
    }

    /** Get the current dither configuration (returns a copy). */
    public getDitherConfig(): DitherConfig {
        return this.webgpuRenderer?.rasterCompositor?.getDitherConfig() ?? defaultDitherConfig();
    }

    /**
     * Enable or disable dithering without changing other settings.
     * Convenience wrapper — equivalent to updating `config.enabled`.
     */
    public setDitherEnabled(enabled: boolean): void {
        this.webgpuRenderer?.rasterCompositor?.setDitherEnabled(enabled);
        this.scheduleRender();
    }

    /**
     * Quick-switch the dither algorithm.
     * Available: 'bayer' | 'halftone_dot' | 'halftone_line' | 'halftone_diamond' | 'blue_noise' | 'noise'
     */
    public setDitherAlgorithm(algorithm: DitherAlgorithm): void {
        const cfg = this.getDitherConfig();
        cfg.algorithm = algorithm;
        this.setDitherConfig(cfg);
    }

    /** Set the dither strength/blend (0 = original, 1 = fully dithered). */
    public setDitherStrength(strength: number): void {
        const cfg = this.getDitherConfig();
        cfg.strength = Math.max(0, Math.min(1, strength));
        this.setDitherConfig(cfg);
    }

    /** Set number of output color levels per channel (2 = 1-bit, 4 = 2-bit, 256 = no-op). */
    public setDitherColorLevels(levels: number): void {
        const cfg = this.getDitherConfig();
        cfg.colorLevels = Math.max(2, Math.min(256, Math.round(levels)));
        this.setDitherConfig(cfg);
    }

    /** Set the pattern scale (1 = native, 2 = 2× larger pattern, etc.). */
    public setDitherPatternScale(scale: number): void {
        const cfg = this.getDitherConfig();
        cfg.patternScale = Math.max(0.25, Math.min(8, scale));
        this.setDitherConfig(cfg);
    }

    /** Set Bayer matrix level (0 = 2×2, 1 = 4×4, 2 = 8×8, 3 = 16×16, 4 = 32×32). */
    public setDitherBayerLevel(level: number): void {
        const cfg = this.getDitherConfig();
        cfg.bayerLevel = Math.max(0, Math.min(4, Math.round(level)));
        this.setDitherConfig(cfg);
    }

    /** Set halftone screen angle in degrees (0–360). */
    public setDitherHalftoneAngle(degrees: number): void {
        const cfg = this.getDitherConfig();
        cfg.halftoneAngle = degrees % 360;
        this.setDitherConfig(cfg);
    }

    /** Set halftone frequency (cells across the texture width). */
    public setDitherHalftoneFrequency(freq: number): void {
        const cfg = this.getDitherConfig();
        cfg.halftoneFrequency = Math.max(2, Math.min(200, freq));
        this.setDitherConfig(cfg);
    }

    /** Toggle per-channel vs. luminance-only dithering. */
    public setDitherPerChannel(perChannel: boolean): void {
        const cfg = this.getDitherConfig();
        cfg.perChannel = perChannel;
        this.setDitherConfig(cfg);
    }

    /** Get available dither algorithm names for UI dropdowns. */
    public static get DitherAlgorithms(): DitherAlgorithm[] {
        return [
          // GPU ordered (real-time)
          'bayer', 'halftone_dot', 'halftone_line', 'halftone_diamond', 'blue_noise', 'noise',
          // WASM error diffusion (async)
          'floyd_steinberg', 'atkinson', 'jarvis_judice_ninke', 'stucki', 'sierra', 'sierra_lite',
        ];
    }

    /** Check if a given algorithm requires async WASM execution (error diffusion). */
    public static isErrorDiffusion(algorithm: DitherAlgorithm): boolean {
        return DitherEngine.isErrorDiffusion(algorithm);
    }

    // ── Per-Layer Dithering ──────────────────────────────────────────

    /**
     * Set a per-layer dither configuration. The layer is dithered before
     * compositing — independent of other layers and the global dither.
     *
     * Pass `undefined` to remove per-layer dithering from a layer.
     *
     * ```ts
     * shapeManager.setLayerDitherConfig(layerId, {
     *   ...defaultDitherConfig(),
     *   enabled: true,
     *   algorithm: 'halftone_dot',
     *   colorMode: 'duotone',
     *   foregroundColor: [0.1, 0.1, 0.5, 1],
     *   backgroundColor: [1, 0.95, 0.8, 1],
     * });
     * ```
     */
    public setLayerDitherConfig(layerId: string, config: DitherConfig | undefined): boolean {
        const ok = this.rasterLayerManager?.setLayerDitherConfig(layerId, config) ?? false;
        if (ok) this.scheduleRender();
        return ok;
    }

    /** Get the per-layer dither config (copy), or undefined if not set. */
    public getLayerDitherConfig(layerId: string): DitherConfig | undefined {
        return this.rasterLayerManager?.getLayerDitherConfig(layerId);
    }

    // ── Dither Color Controls (convenience wrappers) ─────────────────

    /**
     * Set the global dither color mode.
     * - 'quantize': classic — reduces existing pixel colors to N levels.
     * - 'duotone': maps dithered output to explicit foreground/background colors.
     */
    public setDitherColorMode(mode: 'quantize' | 'duotone'): void {
        const cfg = this.getDitherConfig();
        cfg.colorMode = mode;
        this.setDitherConfig(cfg);
    }

    /**
     * Set the foreground color for duotone dithering (lit/bright areas).
     * RGBA values in 0-1 range.
     */
    public setDitherForegroundColor(r: number, g: number, b: number, a: number = 1): void {
        const cfg = this.getDitherConfig();
        cfg.foregroundColor = [r, g, b, a];
        this.setDitherConfig(cfg);
    }

    /**
     * Set the background color for duotone dithering (dark/shadow areas).
     * RGBA values in 0-1 range.
     */
    public setDitherBackgroundColor(r: number, g: number, b: number, a: number = 1): void {
        const cfg = this.getDitherConfig();
        cfg.backgroundColor = [r, g, b, a];
        this.setDitherConfig(cfg);
    }

    /** Swap the foreground and background dither colors. */
    public swapDitherColors(): void {
        const cfg = this.getDitherConfig();
        const tmp = cfg.foregroundColor;
        cfg.foregroundColor = cfg.backgroundColor;
        cfg.backgroundColor = tmp;
        this.setDitherConfig(cfg);
    }

    /** Toggle the invert pattern flag (swap which areas get foreground vs background).
     *  Note: In duotone mode, prefer `setDitherDuotoneBias()` for continuous control. */
    public setDitherInvertPattern(invert: boolean): void {
        const cfg = this.getDitherConfig();
        cfg.invertPattern = invert;
        this.setDitherConfig(cfg);
    }

    /** Set the tint opacity for duotone mode (0 = original, 1 = full duotone). */
    public setDitherTintOpacity(opacity: number): void {
        const cfg = this.getDitherConfig();
        cfg.tintOpacity = Math.max(0, Math.min(1, opacity));
        this.setDitherConfig(cfg);
    }

    /**
     * Set the duotone coverage bias (0–1). Controls the ratio of FG to BG dots.
     *
     * - 0.0 = all background (no foreground dots visible)
     * - 0.5 = balanced 50/50 coverage (default)
     * - 1.0 = all foreground (solid foreground, no background dots)
     *
     * This replaces the binary invert toggle with continuous control.
     * Values below 0.5 progressively "invert" the pattern; values above 0.5
     * progressively fill it in. Only affects duotone mode.
     *
     * ```ts
     * shapeManager.setDitherDuotoneBias(0.3);  // sparse FG dots (inverted-ish)
     * shapeManager.setDitherDuotoneBias(0.5);  // balanced halftone
     * shapeManager.setDitherDuotoneBias(0.7);  // dense FG dots
     * ```
     */
    public setDitherDuotoneBias(bias: number): void {
        const cfg = this.getDitherConfig();
        cfg.duotoneBias = Math.max(0, Math.min(1, bias));
        this.setDitherConfig(cfg);
    }

    // ── Frame Link Animation API ──────────────────────────────────────

    /**
     * Set the full FrameLinkAnimation config for a layer.
     * Pass `undefined` to remove the animation. Returns false if layer not found.
     *
     * ```ts
     * shapeManager.setLayerFrameLinkAnimation(layerId, {
     *   ...DEFAULT_FRAME_LINK_ANIMATION,
     *   enabled: true,
     *   type: 'wave',
     *   amplitude: 15,
     *   frequency: 4,
     *   speed: 0.2,
     * });
     * ```
     */
    public setLayerFrameLinkAnimation(layerId: string, config: FrameLinkAnimation | undefined): boolean {
        const ok = this.rasterLayerManager?.setLayerFrameLinkAnimation(layerId, config) ?? false;
        if (ok) this.emitSceneGraphChanged();
        return ok;
    }

    /** Get the current FrameLinkAnimation config for a layer (copy), or undefined if not set. */
    public getLayerFrameLinkAnimation(layerId: string): FrameLinkAnimation | undefined {
        return this.rasterLayerManager?.getLayerFrameLinkAnimation(layerId);
    }

    /** Get a fresh default FrameLinkAnimation config (disabled, wave, sensible defaults). */
    public getDefaultFrameLinkAnimation(): FrameLinkAnimation {
        return { ...DEFAULT_FRAME_LINK_ANIMATION };
    }

    /** Enable or disable the frame link animation on a layer. */
    public setLayerFrameLinkEnabled(layerId: string, enabled: boolean): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.enabled = enabled;
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set the animation type (wave, shake, ripple, noise, turbulence). */
    public setLayerFrameLinkType(layerId: string, type: FrameLinkAnimationType): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.type = type;
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set displacement amplitude (strength in texels, 0–100+). */
    public setLayerFrameLinkAmplitude(layerId: string, amplitude: number): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.amplitude = Math.max(0, amplitude);
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set spatial frequency (waves per texture width, 0.1–50+). */
    public setLayerFrameLinkFrequency(layerId: string, frequency: number): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.frequency = Math.max(0.01, frequency);
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set animation speed (phase advance per frame, 0–2+). */
    public setLayerFrameLinkSpeed(layerId: string, speed: number): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.speed = Math.max(0, speed);
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set wave propagation direction (degrees, 0–360). */
    public setLayerFrameLinkDirection(layerId: string, degrees: number): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.direction = degrees % 360;
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set starting phase offset (radians). */
    public setLayerFrameLinkPhase(layerId: string, phase: number): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.phase = phase;
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set loop mode ('free' = continuous, 'loop-to-fit' = one cycle per cel duration). */
    public setLayerFrameLinkLoopMode(layerId: string, mode: FrameLinkLoopMode): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.loopMode = mode;
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set which axes are affected by displacement. */
    public setLayerFrameLinkAxes(layerId: string, displaceX: boolean, displaceY: boolean): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.displaceX = displaceX;
        cfg.displaceY = displaceY;
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set the ripple center (normalized 0–1 for both X and Y). Only used by 'ripple' type. */
    public setLayerFrameLinkRippleCenter(layerId: string, x: number, y: number): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.rippleCenterX = Math.max(0, Math.min(1, x));
        cfg.rippleCenterY = Math.max(0, Math.min(1, y));
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    /** Set turbulence noise parameters (octaves 1–4, lacunarity, persistence). */
    public setLayerFrameLinkNoiseParams(layerId: string, octaves: number, lacunarity: number, persistence: number): boolean {
        const cfg = this.getLayerFrameLinkAnimation(layerId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION };
        cfg.noiseOctaves = Math.max(1, Math.min(4, Math.round(octaves)));
        cfg.noiseLacunarity = Math.max(1, lacunarity);
        cfg.noisePersistence = Math.max(0, Math.min(1, persistence));
        return this.setLayerFrameLinkAnimation(layerId, cfg);
    }

    // Layer management API (UI-friendly wrappers)
    public getLayers() {
        return this.layerManager.getLayers();
    }

    public addLayer(name: string = 'Layer') {
        const layer = this.layerManager.addLayer(name);
        this.emitSceneGraphChanged();
        return layer;
    }

    public deleteLayer(id: string) {
        const ok = this.layerManager.deleteLayer(id);
        if (ok) this.emitSceneGraphChanged();
        return ok;
    }

    public selectLayer(id: string | null) {
        this.layerManager.selectLayer(id);
    }

    public getSelectedLayerId() { return this.layerManager.getSelectedLayerId(); }

    public enableStampDrawing() {
        this.stampDrawingService.enable();
    }

    public disableStampDrawing() {
        this.stampDrawingService.disable();
    }

    public setStampTexture(textureKey: string) {
        this.stampDrawingService.setTextureKey(textureKey);
    }

    public setStampSize(size: number) {
        this.stampDrawingService.setStampSize(size);
    }

    public setStampColor(color: string) {
        this.stampDrawingService.setFillColor(hexToRgba(color));
    }

    private emitSceneGraphChanged() {
        if (this._isRestoring) {
            // During document restore, only schedule a render — don't fire the
            // scene-graph-changed event yet.  A single event is emitted at the
            // very end of restoreDocumentState() to avoid intermediate states
            // where layers haven't been recreated yet.
            this.scheduleRender();
            return;
        }
        this.interactionService.onSceneGraphChanged.emit();
        this.scheduleRender();
    }

    public setBackgroundColor(r: number, g: number, b: number, a: number = 1.0) {
        if (this.webgpuRenderer) {
            this.webgpuRenderer.setBackgroundColor(r, g, b, a);
        }
    }

    public getBackgroundColor() {
        if (this.webgpuRenderer) {
            return this.webgpuRenderer.getBackgroundColorHex();
        }
    }

    public setDotColor(r: number, g: number, b: number, a: number = 1.0) {
        if (this.webgpuRenderer) {
            this.webgpuRenderer.setDotColor(r, g, b, a);
        }
    }
    
    public getDotColor() {
        if (this.webgpuRenderer) {
            return this.webgpuRenderer.getDotColorHex();
        }
    }

    public setSelectedNode(nodeId: string): void {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node && !node.locked) {
            this.interactionService.clearSelectedNodes();
            this.interactionService.selectNode(node);
        }
        this.scheduleRender();
    }

    public addSelectedNode(nodeId: string): void {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node  && !node.locked) {
            this.interactionService.selectNode(node);
        }
        this.scheduleRender();
    }

    public clearSelectedNodes(): void {
        this.interactionService.clearSelectedNodes();
        this.scheduleRender();
    }

    public deselectNode(nodeId: string): void {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            this.interactionService.deselectNode(node);
        }
        this.scheduleRender();
    }

    public setNodeFillColor(layerId: string, newColor: RGBA) {
        const node = this.sceneGraph.findNodeById(layerId) as Shape;
        if (!node) return;

        const type = node.getType?.();
        if (type === 'Scribble') {
            (node as any).strokeColor = newColor;
        } else if (type === 'Sticky Note') {
            // single source of truth: use the class API
            (node as any as StickyNote).setColor(newColor);  // updates bg + marks dirty
        } else {
            (node as any).fillColor = newColor;
        }
        this.emitSceneGraphChanged();
    }

    public getNodeFillColor(layerId: string) {
        const node = this.sceneGraph.findNodeById(layerId) as Shape;
        if (!node) return { r:1,g:1,b:1,a:1 };

        const type = node.getType?.();
        if (type === 'Scribble') return (node as any).strokeColor;
        if (type === 'Sticky Note') return (node as any as StickyNote).bg.fillColor;
        return (node as any).fillColor;
    }

    createRectangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var rectangle = this.shapeFactory.createRectangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(rectangle);
        this.emitSceneGraphChanged();
    }

    createCircle(
        x: number, y: number, radius: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var circle = this.shapeFactory.createCircle(x, y, radius, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(circle);
        this.emitSceneGraphChanged();
    }

    createTriangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var triangle = this.shapeFactory.createTriangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(triangle);
        this.emitSceneGraphChanged();
    }

    createLine(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number) {
        const line = this.shapeFactory.createLine(x1, y1, x2, y2, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(line);
        this.emitSceneGraphChanged();
        return line;
    }

    /** Create a line with arrowheads. */
    createArrow(
        x1: number, y1: number, x2: number, y2: number,
        strokeColor: RGBA, strokeWidth: number,
        arrowStart: ArrowheadStyle = 'none',
        arrowEnd: ArrowheadStyle = 'closedCircle',
        arrowSize: number = 6
    ) {
        const line = this.shapeFactory.createLine(x1, y1, x2, y2, strokeColor, strokeWidth);
        line.arrowStart = arrowStart;
        line.arrowEnd = arrowEnd;
        line.arrowSize = arrowSize;
        line.markDirty();
        this.sceneGraph.root.addChild(line);
        this.emitSceneGraphChanged();
        return line;
    }

    /** Set arrowhead style on a Line shape by ID. */
    setArrowheads(shapeId: string, arrowStart?: ArrowheadStyle, arrowEnd?: ArrowheadStyle, arrowSize?: number): void {
        const node = this.getNodeById(shapeId);
        if (node instanceof Line) {
            if (arrowStart !== undefined) node.arrowStart = arrowStart;
            if (arrowEnd !== undefined) node.arrowEnd = arrowEnd;
            if (arrowSize !== undefined) node.arrowSize = arrowSize;
            node.markDirty();
            this.scheduleRender();
        }
    }

    /** Expose ArrowheadStyle values for UI dropdowns. */
    static get ArrowheadStyles(): ArrowheadStyle[] {
        return ['none', 'triangle', 'closedCircle', 'openCircle'];
    }

    // ── Connector / Flowcharting API ────────────────────────────────

    /** Get the connector service instance (for advanced use). */
    public getConnectorService(): ConnectorService | undefined {
        return this.connectorService;
    }

    /** Set the snap threshold for connection ports (world-space distance). */
    public setSnapThreshold(threshold: number): void {
        if (this.connectorService) this.connectorService.snapThreshold = threshold;
    }

    /** Find the nearest connection port to a world position. */
    public findSnapTarget(worldX: number, worldY: number, excludeShapeId?: string): SnapResult | null {
        return this.connectorService?.findSnapTarget(worldX, worldY, excludeShapeId) ?? null;
    }

    /** Bind a line's start endpoint to a shape's port. */
    public bindLineStart(lineId: string, targetShapeId: string, portId: string): void {
        const node = this.getNodeById(lineId);
        if (node instanceof Line && this.connectorService) {
            this.connectorService.bindStart(node, targetShapeId, portId);
            this.emitSceneGraphChanged();
        }
    }

    /** Bind a line's end endpoint to a shape's port. */
    public bindLineEnd(lineId: string, targetShapeId: string, portId: string): void {
        const node = this.getNodeById(lineId);
        if (node instanceof Line && this.connectorService) {
            this.connectorService.bindEnd(node, targetShapeId, portId);
            this.emitSceneGraphChanged();
        }
    }

    /** Unbind a line's start endpoint. */
    public unbindLineStart(lineId: string): void {
        const node = this.getNodeById(lineId);
        if (node instanceof Line && this.connectorService) {
            this.connectorService.unbindStart(node);
        }
    }

    /** Unbind a line's end endpoint. */
    public unbindLineEnd(lineId: string): void {
        const node = this.getNodeById(lineId);
        if (node instanceof Line && this.connectorService) {
            this.connectorService.unbindEnd(node);
        }
    }

    /** Force-update all bound connectors (call after programmatic shape moves). */
    public updateConnectors(): void {
        this.connectorService?.updateBoundConnectors();
    }

    /** Get all connection points on all shapes (useful for rendering snap indicators). */
    public getAllConnectionPoints(nearWorldX?: number, nearWorldY?: number, radius?: number) {
        return this.connectorService?.getAllConnectionPoints(nearWorldX, nearWorldY, radius) ?? [];
    }

    /** Get connection points for a specific shape. */
    public getShapeConnectionPoints(shapeId: string) {
        const node = this.getNodeById(shapeId);
        if (node instanceof Shape) {
            return node.getConnectionPoints();
        }
        return [];
    }

    /** Set default arrowhead styles for newly drawn lines. */
    public setDefaultArrowheads(arrowStart: ArrowheadStyle, arrowEnd: ArrowheadStyle): void {
        this.lineDrawingService.defaultArrowStart = arrowStart;
        this.lineDrawingService.defaultArrowEnd = arrowEnd;
    }

    createStickyNote(x: number, y: number, text = "New note", color?: RGBA, signatureText?: string) {
        const note = this.shapeFactory.createStickyNote(x, y, text, color ?? {r:1,g:.98,b:.65,a:1}, signatureText);
        this.sceneGraph.root.addChild(note);
        this.interactionService.clearSelectedNodes();
        this.interactionService.selectNode(note);
        this.emitSceneGraphChanged();
    }

    // ── Speech Balloons ──────────────────────────────────────────────

    /**
     * Create a speech balloon and add it to the scene.
     *
     * @param x World X position
     * @param y World Y position
     * @param options Balloon configuration (text, style, tail, writingMode, etc.)
     * @returns The created SpeechBalloon node
     *
     * Example:
     * ```ts
     * const balloon = shapeManager.createSpeechBalloon(0.5, 0.3, {
     *   text: '何だこれ？！',
     *   writingMode: 'vertical-rl',
     *   tailSide: 'bottom',
     *   tailPosition: 0.3,
     *   balloonStyle: 'rounded-rect',
     * });
     * ```
     */
    public createSpeechBalloon(x: number, y: number, options?: SpeechBalloonOptions): SpeechBalloon {
        const balloon = this.shapeFactory.createSpeechBalloon(x, y, options);
        this.sceneGraph.root.addChild(balloon);
        this.interactionService.clearSelectedNodes();
        this.interactionService.selectNode(balloon);
        this.emitSceneGraphChanged();
        return balloon;
    }

    /** Get a speech balloon by node id. */
    public getSpeechBalloon(nodeId: string): SpeechBalloon | null {
        const node = this.sceneGraph.findNodeById(nodeId);
        return node instanceof SpeechBalloon ? node : null;
    }

    /** Update speech balloon text. */
    public setSpeechBalloonText(nodeId: string, text: string): void {
        this.getSpeechBalloon(nodeId)?.setText(text);
        this.scheduleRender();
    }

    /** Update speech balloon writing mode. */
    public setSpeechBalloonWritingMode(nodeId: string, mode: 'horizontal-tb' | 'vertical-rl'): void {
        this.getSpeechBalloon(nodeId)?.setWritingMode(mode);
        this.scheduleRender();
    }

    /** Update the balloon tail configuration. */
    public setSpeechBalloonTail(nodeId: string, side: TailSide, position: number, length?: number): void {
        const balloon = this.getSpeechBalloon(nodeId);
        if (!balloon) return;
        balloon.setTailSide(side);
        balloon.setTailPosition(position);
        if (length !== undefined) balloon.setTailLength(length);
        this.scheduleRender();
    }

    /** Point the balloon tail at a world-space position (auto-computes side). */
    public setSpeechBalloonTailTarget(nodeId: string, worldX: number, worldY: number): void {
        this.getSpeechBalloon(nodeId)?.setTailTipWorld(worldX, worldY);
        this.scheduleRender();
    }

    /** Update balloon visual style. */
    public setSpeechBalloonStyle(nodeId: string, style: BalloonStyle): void {
        this.getSpeechBalloon(nodeId)?.setBalloonStyle(style);
        this.scheduleRender();
    }

    /** Get tail geometry for overlay rendering. */
    public getSpeechBalloonTailPoints(nodeId: string): { x: number; y: number }[] {
        return this.getSpeechBalloon(nodeId)?.getTailPoints() ?? [];
    }

    // ── Text Effects (GPU shader effects on text) ────────────────────

    /**
     * Get or lazily create the text effect engine.
     */
    private getTextEffectEngine(): TextEffectEngine | null {
        const device = this.webgpuRenderer?.getDevice();
        if (!device) return null;
        if (!this.textEffectEngine) {
            this.textEffectEngine = new TextEffectEngine(device);
        }
        return this.textEffectEngine;
    }

    /**
     * Capture styled text to a GPU texture for use with effects.
     *
     * @param config Text styling / content configuration
     * @returns Object with { texture, width, height } or null if device unavailable
     *
     * Example:
     * ```ts
     * const result = shapeManager.captureTextToTexture({
     *   text: 'BOOM!',
     *   font: 'Impact',
     *   fontSize: 120,
     *   color: [1, 0, 0, 1],
     *   bold: true,
     *   padding: 24,
     * });
     * ```
     */
    public captureTextToTexture(config: TextCaptureConfig): { texture: GPUTexture; width: number; height: number } | null {
        return this.getTextEffectEngine()?.captureText(config) ?? null;
    }

    /**
     * Check whether the HTML-in-Canvas API is available (Chrome Canary with flag).
     * When true, `captureElementToTexture()` can capture live DOM elements as GPU textures.
     */
    public isHtmlInCanvasAvailable(): boolean {
        return TextEffectEngine.htmlInCanvasAvailable();
    }

    /**
     * Get the HTML-in-Canvas capture mode.
     *
     * - `'webgpu-native'` — Best path. `GPUQueue.copyElementImageToTexture()` is available.
     * - `'webgl-bridge'`  — `texElementImage2D` available; uses WebGL→WebGPU bridge.
     * - `'none'`          — API not available; use `captureTextToTexture` fallback.
     */
    public getHtmlInCanvasMode(): 'webgpu-native' | 'webgl-bridge' | 'none' {
        return TextEffectEngine.htmlInCanvasMode();
    }

    /**
     * Set up Salsa's canvas for HTML-in-Canvas capture.
     *
     * This adds the `layoutsubtree` attribute and wires up the `onpaint` event.
     * After calling this, you can add HTML elements as direct children of the canvas
     * and capture them as GPU textures with `captureElementToTexture()`.
     *
     * @param onPaint Optional callback invoked each frame with elements whose rendering changed
     * @returns A cleanup function that removes the attribute and handler
     *
     * Example:
     * ```ts
     * const cleanup = shapeManager.setupHtmlInCanvas((changedElements) => {
     *   for (const el of changedElements) {
     *     // Re-capture changed elements...
     *   }
     * });
     *
     * // Add styled HTML as a direct child of the canvas
     * const textEl = document.createElement('div');
     * textEl.style.cssText = 'font: bold 80px Impact; color: red;';
     * textEl.textContent = 'BOOM!';
     * canvas.appendChild(textEl);
     *
     * // Later, capture it
     * const tex = shapeManager.captureElementToTexture(textEl);
     * ```
     */
    public setupHtmlInCanvas(onPaint?: (changedElements: Element[]) => void): (() => void) | null {
        const canvas = this.interactionService?.canvas;
        if (!canvas) return null;
        return TextEffectEngine.setupCanvasForHtmlCapture(canvas, onPaint);
    }

    /**
     * Request a paint event on the next frame (even if no canvas children changed).
     * Useful after programmatically updating a canvas child element.
     */
    public requestHtmlPaint(): void {
        const canvas = this.interactionService?.canvas;
        if (canvas) TextEffectEngine.requestPaint(canvas);
    }

    /**
     * Capture a live DOM element to a GPU texture via the HTML-in-Canvas API.
     * Requires Chrome Canary with chrome://flags/#canvas-draw-element enabled.
     * Returns null if API is unavailable — use captureTextToTexture as fallback.
     *
     * The captured texture includes the full rendered appearance of the element:
     * fonts, colors, borders, backgrounds, child elements — everything the browser paints.
     *
     * Two capture paths (auto-detected):
     *  1. Native WebGPU: `GPUQueue.copyElementImageToTexture()` — zero-copy, best.
     *  2. WebGL bridge:  `texElementImage2D` → render → transfer to WebGPU.
     *
     * IMPORTANT: The element must be a direct child of a `<canvas layoutsubtree>`.
     * Call `setupHtmlInCanvas()` first, then append elements to the canvas.
     *
     * Example:
     * ```ts
     * if (shapeManager.isHtmlInCanvasAvailable()) {
     *   const el = document.querySelector('#speech-text')!;
     *   const result = shapeManager.captureElementToTexture(el);
     *   if (result) {
     *     const effected = shapeManager.applyTextEffect(result.texture, 'chromatic-aberration', {
     *       strength: 0.008, angle: 0,
     *     });
     *   }
     * }
     * ```
     */
    public captureElementToTexture(element: HTMLElement): { texture: GPUTexture; width: number; height: number } | null {
        return this.getTextEffectEngine()?.captureElement(element) ?? null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  LiveTextNode — Interactive HTML-in-Canvas text nodes
    // ═══════════════════════════════════════════════════════════════

    /**
     * Create a LiveTextNode and add it to the scene graph.
     *
     * LiveTextNode renders HTML text as a GPU texture each frame with optional
     * shader effects that can react to cursor position, time, and mouse state.
     *
     * When HTML-in-Canvas is available, text is rendered by the browser (full CSS,
     * IME, CJK, emoji). Otherwise falls back to OffscreenCanvas 2D.
     *
     * @param x World X position
     * @param y World Y position
     * @param options Text content, style, and effect configuration
     * @returns The created LiveTextNode
     *
     * Example:
     * ```ts
     * const node = shapeManager.createLiveText(0, 0, {
     *   text: 'BOOM!',
     *   font: 'Impact',
     *   fontSize: 96,
     *   color: { r: 1, g: 0, b: 0, a: 1 },
     *   bold: true,
     *   padding: 24,
     *   effects: [
     *     { type: 'outline', params: { thickness: 4, color: [0,0,0,1] } },
     *     { type: 'glow', params: { radius: 8, intensity: 2, color: [1, 0.3, 0] } },
     *   ],
     * });
     * ```
     */
    public createLiveText(x: number, y: number, options?: LiveTextOptions): LiveTextNode {
        // Auto-end any previous editing session before creating a new node
        if (this._editingLiveTextId) {
            this.endLiveTextEditing(this._editingLiveTextId);
        }

        const node = this.shapeFactory.createLiveText(x, y, options);

        // Wire up the TextEffectEngine
        const engine = this.getTextEffectEngine();
        if (engine) node.setEngine(engine);

        // Compute world-units-per-pixel from illustration bounds and raster pixel size.
        // This ensures LiveText sizing matches the raster layer (flatten result).
        const illBounds = this.webgpuRenderer?.getIllustrationBounds?.();
        const pixelSize = this.webgpuRenderer?.getIllustrationPixelSize?.();
        const canvas = this.interactionService?.canvas;
        if (illBounds && pixelSize) {
            // worldWidth / rasterPixelWidth (e.g., 1.5 / 963 ≈ 0.00156)
            node.worldUnitsPerPixel = illBounds.width / pixelSize.w;
        } else if (canvas) {
            // Fallback: use canvas dimensions. Visible Y range is ~2 world units at zoom=1.
            node.worldUnitsPerPixel = 2 / canvas.height;
        }

        // Initialize DOM element if HTML-in-Canvas is available
        if (canvas && TextEffectEngine.htmlInCanvasAvailable()) {
            // The HTML-in-Canvas API requires the layoutsubtree attribute
            if (!canvas.hasAttribute('layoutsubtree')) {
                canvas.setAttribute('layoutsubtree', '');
            }
            node.initDomElement(canvas);
            // Request a paint so the element gets a paint record before the next frame
            TextEffectEngine.requestPaint(canvas);
        }

        // Capture the initial texture so dimensions are correct before the node
        // enters the scene graph. Without this the bounding box starts at the
        // constructor defaults (1 × 0.5) and visibly jumps on the next frame.
        node.updateTexture();

        // Add to scene
        this.sceneGraph.root.addChild(node);
        this.interactionService.clearSelectedNodes();
        this.interactionService.selectNode(node);
        this.emitSceneGraphChanged();

        // Start continuous rendering if initial effects need animation
        if (node.needsAnimation) this.webgpuRenderer?.beginInteractive();

        return node;
    }

    /**
     * Set the effect chain on a LiveTextNode.
     *
     * @param nodeId The LiveTextNode's shape ID
     * @param effects Array of effects to apply each frame
     */
    public setLiveTextEffects(nodeId: string, effects: TextEffectConfig[]): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            const wasAnimated = node.needsAnimation;
            node.setEffects(effects);
            const isAnimated = node.needsAnimation;
            // Enter/exit continuous rendering based on whether effects animate
            if (isAnimated && !wasAnimated) this.webgpuRenderer?.beginInteractive();
            if (!isAnimated && wasAnimated) this.webgpuRenderer?.endInteractive();
            this.scheduleRender();
        }
    }

    /**
     * Update the text content of a LiveTextNode.
     */
    public setLiveTextContent(nodeId: string, text: string): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            node.text = text;
            this.scheduleRender();
        }
    }

    /**
     * Update styling properties on a LiveTextNode.
     */
    public setLiveTextStyle(nodeId: string, style: Partial<LiveTextOptions>): void {
        const node = this.findLiveTextNode(nodeId);
        if (!node) return;
        if (style.font !== undefined) node.font = style.font;
        if (style.fontSize !== undefined) node.fontSize = style.fontSize;
        if (style.color !== undefined) node.textColor = style.color;
        if (style.bold !== undefined) node.bold = style.bold;
        if (style.italic !== undefined) node.italic = style.italic;
        if (style.writingMode !== undefined) node.writingMode = style.writingMode;
        if (style.maxWidth !== undefined) node.maxWidth = style.maxWidth;
        if (style.lineHeight !== undefined) node.lineHeight = style.lineHeight;
        if (style.padding !== undefined) node.padding = style.padding;
        this.scheduleRender();
    }

    /**
     * Enter edit mode on a LiveTextNode (focus the hidden DOM element).
     * Browser handles IME, cursor, and text selection natively.
     */
    public beginLiveTextEditing(nodeId: string): void {
        // Auto-end any previous editing session
        if (this._editingLiveTextId && this._editingLiveTextId !== nodeId) {
            this.endLiveTextEditing(this._editingLiveTextId);
        }

        const node = this.findLiveTextNode(nodeId);
        if (node) {
            // Wire onChange so each keystroke schedules a render frame
            node.onChange = () => this.scheduleRender();
            node.beginEditing();
            this._editingLiveTextId = nodeId;
            // Enter continuous rendering mode for the editing session
            // (handles cursor blink, IME composition, HTML-in-Canvas repaints)
            this.webgpuRenderer?.beginInteractive();
        }
    }

    /**
     * Exit edit mode on a LiveTextNode. Text is synced back from the DOM.
     */
    public endLiveTextEditing(nodeId: string): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            node.endEditing();
            node.onChange = undefined;
            if (this._editingLiveTextId === nodeId) {
                this._editingLiveTextId = null;
            }
            // Deselect the node so Frogmarks' next click doesn't
            // mistake it for a hit-test result and re-enter editing
            // instead of creating a new node.
            this.interactionService.deselectNode(node);
            this.webgpuRenderer?.endInteractive();
            this.scheduleRender();
        }
    }

    /**
     * Flatten a LiveTextNode onto the active raster layer at its current position.
     * This destroys the LiveTextNode and bakes its pixels into the raster layer.
     *
     * @param nodeId The LiveTextNode to flatten
     * @returns true if flattened successfully
     */
    public async flattenLiveText(nodeId: string): Promise<boolean> {
        const node = this.findLiveTextNode(nodeId);
        if (!node || !this.rasterLayerManager) return false;
        const device = this.webgpuRenderer?.getDevice();
        if (!device) return false;

        const tex = node.getCurrentTexture();
        if (!tex) return false;

        const activeLayerId = this.rasterLayerManager.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = this.rasterLayerManager.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;

        // Convert world position to texel position
        const texW = activeLayer.texture.width;
        const texH = activeLayer.texture.height;

        // Simple mapping: node center in world → texel coords
        // Assuming illustration bounds centered at origin, texture covers full bounds
        const illBounds = this.webgpuRenderer?.getIllustrationBounds?.();
        const worldW = illBounds?.width ?? 2;
        const worldH = illBounds?.height ?? 2;

        const destX = Math.round(((node.x + worldW / 2) / worldW) * texW - tex.width / 2);
        // World Y is up, texture Y is down — negate node.y
        const destY = Math.round(((-node.y + worldH / 2) / worldH) * texH - tex.height / 2);

        const srcW = Math.min(tex.width, texW - Math.max(0, destX));
        const srcH = Math.min(tex.height, texH - Math.max(0, destY));
        if (srcW <= 0 || srcH <= 0) return false;

        const enc = device.createCommandEncoder();
        enc.copyTextureToTexture(
            { texture: tex, origin: [0, 0, 0] },
            { texture: activeLayer.texture, origin: [Math.max(0, destX), Math.max(0, destY), 0] },
            { width: srcW, height: srcH },
        );
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();

        // End editing if this node was being edited
        if (this._editingLiveTextId === nodeId) {
            this.endLiveTextEditing(nodeId);
        }

        // Remove the LiveTextNode from the scene
        const wasAnimated = node.needsAnimation;
        node.destroy();
        this.sceneGraph.root.removeChild(node);
        if (wasAnimated) this.webgpuRenderer?.endInteractive();
        this.emitSceneGraphChanged();
        this.scheduleRender();
        return true;
    }

    /**
     * Get a LiveTextNode by ID. Returns null if not found or not a LiveTextNode.
     */
    public getLiveTextNode(nodeId: string): LiveTextNode | null {
        return this.findLiveTextNode(nodeId);
    }

    private findLiveTextNode(nodeId: string): LiveTextNode | null {
        let found: LiveTextNode | null = null;
        this.sceneGraph.root.forEachDeep((n) => {
            if (found) return;
            if (n instanceof LiveTextNode && (n as LiveTextNode).id === nodeId) {
                found = n as LiveTextNode;
            }
        });
        return found;
    }

    /**
     * Apply a shader effect to a text texture.
     *
     * @param src Source GPU texture (from captureTextToTexture or any texture)
     * @param effect Effect type
     * @param params Effect-specific parameters
     * @returns Output GPU texture with the effect applied (caller owns it)
     *
     * Example:
     * ```ts
     * const textTex = shapeManager.captureTextToTexture({ text: 'KABOOM!', ... });
     * const effected = shapeManager.applyTextEffect(textTex.texture, 'chromatic-aberration', {
     *   strength: 0.008,
     *   angle: 0.3,
     * });
     * ```
     */
    public applyTextEffect(src: GPUTexture, effect: TextEffectType, params: TextEffectParams): GPUTexture | null {
        return this.getTextEffectEngine()?.apply(src, effect, params) ?? null;
    }

    /**
     * Apply a chain of effects to a text texture.
     * Intermediate textures are destroyed automatically; only the final output is returned.
     *
     * Example:
     * ```ts
     * const result = shapeManager.applyTextEffectChain(textTex.texture, [
     *   { type: 'outline', params: { thickness: 3, color: [0, 0, 0, 1] } },
     *   { type: 'glow', params: { radius: 6, intensity: 2.0, color: [1, 0.5, 0] } },
     *   { type: 'chromatic-aberration', params: { strength: 0.004, angle: 0 } },
     * ]);
     * ```
     */
    public applyTextEffectChain(src: GPUTexture, effects: TextEffectConfig[]): GPUTexture | null {
        return this.getTextEffectEngine()?.applyChain(src, effects) ?? null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  Custom Shaders — User-written WGSL effects
    // ═══════════════════════════════════════════════════════════════

    /**
     * Validate a user-written custom WGSL shader without applying it.
     * Returns compilation status and any error messages for UI display.
     *
     * @param code The WGSL code (effect body or full module)
     * @param rawCode If true, `code` is a complete WGSL module (advanced mode)
     * @returns Compilation result with success flag and error messages
     *
     * Example:
     * ```ts
     * const result = await shapeManager.validateCustomShader(
     *   `let c = textureLoad(src, vec2<i32>(gid.xy), 0);
     *    let grey = dot(c.rgb, vec3<f32>(0.299, 0.587, 0.114));
     *    textureStore(dst, gid.xy, vec4<f32>(vec3(grey), c.a));`
     * );
     * if (!result.success) {
     *   showErrors(result.errors);
     * }
     * ```
     */
    public async validateCustomShader(code: string, rawCode = false): Promise<CustomShaderCompileResult> {
        const engine = this.getTextEffectEngine();
        if (!engine) return { success: false, errors: ['TextEffectEngine not available'] };
        return engine.validateCustomShader(code, rawCode);
    }

    /**
     * Apply a custom WGSL shader to a LiveTextNode's effect chain.
     * Validates first — returns errors if the shader doesn't compile.
     *
     * @param nodeId The LiveTextNode to apply the shader to
     * @param code WGSL effect body (simplified mode) or full module (if rawCode=true)
     * @param rawCode If true, `code` is a complete WGSL module
     * @param params Up to 4 user-defined floats accessible as `u.params` in the shader
     * @returns Compilation result
     *
     * Example (grayscale effect):
     * ```ts
     * const result = await shapeManager.setCustomShader(nodeId,
     *   `let c = textureLoad(src, vec2<i32>(gid.xy), 0);
     *    let grey = dot(c.rgb, vec3<f32>(0.299, 0.587, 0.114));
     *    textureStore(dst, gid.xy, vec4<f32>(vec3(grey), c.a));`
     * );
     * ```
     *
     * Example (cursor-reactive ripple):
     * ```ts
     * const result = await shapeManager.setCustomShader(nodeId, `
     *   let dist = distance(uv, u.cursor);
     *   let ripple = sin(dist * u.params.x - u.time * u.params.y) * u.params.z;
     *   let offset = vec2<i32>(vec2<f32>(f32(dim.x), f32(dim.y)) * vec2<f32>(ripple, 0.0));
     *   let sampleCoord = clamp(vec2<i32>(gid.xy) + offset, vec2<i32>(0), vec2<i32>(i32(dim.x)-1, i32(dim.y)-1));
     *   let c = textureLoad(src, sampleCoord, 0);
     *   textureStore(dst, gid.xy, c);
     * `, false, [40.0, 5.0, 0.01, 0.0]);
     * ```
     */
    public async setCustomShader(
        nodeId: string,
        code: string,
        rawCode = false,
        params?: [number, number, number, number],
    ): Promise<CustomShaderCompileResult> {
        // Validate first
        const validation = await this.validateCustomShader(code, rawCode);
        if (!validation.success) return validation;

        // Apply to the node
        const node = this.findLiveTextNode(nodeId);
        if (!node) return { success: false, errors: ['LiveTextNode not found'] };

        const customEffect: TextEffectConfig = {
            type: 'custom',
            params: {
                ...(rawCode ? { rawCode: code } : { code }),
                params: params ?? [0, 0, 0, 0],
            } as CustomShaderParams,
        };

        // Replace any existing custom effect, keep other effects
        const existingEffects = node.effects.filter(e => e.type !== 'custom');
        node.setEffects([...existingEffects, customEffect]);
        this.scheduleRender();
        return { success: true };
    }

    /**
     * Remove the custom shader from a LiveTextNode (keeps built-in effects).
     */
    public removeCustomShader(nodeId: string): void {
        const node = this.findLiveTextNode(nodeId);
        if (!node) return;
        node.setEffects(node.effects.filter(e => e.type !== 'custom'));
        this.scheduleRender();
    }

    /**
     * Update the user-defined params on an existing custom shader (no recompilation).
     * Useful for sliders/knobs that control the shader in real time.
     *
     * @param nodeId The LiveTextNode
     * @param params 4 floats accessible as `u.params.x/y/z/w` in the shader
     */
    public setCustomShaderParams(nodeId: string, params: [number, number, number, number]): void {
        const node = this.findLiveTextNode(nodeId);
        if (!node) return;
        const effects = [...node.effects];
        for (const fx of effects) {
            if (fx.type === 'custom') {
                (fx.params as CustomShaderParams).params = params;
            }
        }
        node.setEffects(effects);
        this.scheduleRender();
    }

    /**
     * Capture text and immediately apply an effect — convenience one-liner.
     *
     * @returns { texture, width, height } with the effect applied, or null
     *
     * Example:
     * ```ts
     * const result = shapeManager.createEffectedText(
     *   { text: '何だ?!', font: 'Noto Sans JP', fontSize: 80, color: [1,1,1,1], padding: 16 },
     *   [{ type: 'glow', params: { radius: 8, intensity: 2, color: [0.2, 0.6, 1] } }]
     * );
     * ```
     */
    public createEffectedText(
        textConfig: TextCaptureConfig,
        effects: TextEffectConfig[],
    ): { texture: GPUTexture; width: number; height: number } | null {
        const engine = this.getTextEffectEngine();
        if (!engine) return null;

        const captured = engine.captureText(textConfig);
        if (effects.length === 0) return captured;

        const result = engine.applyChain(captured.texture, effects);
        // captured.texture was consumed by applyChain if effects > 0
        return { texture: result, width: captured.width, height: captured.height };
    }

    /**
     * Stamp effected text onto the active raster layer at a texel position.
     * This is a convenience that captures → effects → stamps in one call.
     *
     * @param destX Texel X on the target layer
     * @param destY Texel Y on the target layer
     * @param textConfig Text content/style
     * @param effects Effect chain to apply
     * @returns true if stamped successfully
     *
     * Example:
     * ```ts
     * shapeManager.stampEffectedText(100, 50,
     *   { text: 'POW!', font: 'Impact', fontSize: 96, color: [1,1,0,1], bold: true, padding: 20 },
     *   [
     *     { type: 'outline', params: { thickness: 4, color: [0,0,0,1] } },
     *     { type: 'chromatic-aberration', params: { strength: 0.006, angle: 0.2 } },
     *   ]
     * );
     * ```
     */
    public async stampEffectedText(
        destX: number,
        destY: number,
        textConfig: TextCaptureConfig,
        effects: TextEffectConfig[],
    ): Promise<boolean> {
        if (!this.rasterLayerManager) return false;
        const device = this.webgpuRenderer?.getDevice();
        if (!device) return false;

        const activeLayerId = this.rasterLayerManager.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = this.rasterLayerManager.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;

        const result = this.createEffectedText(textConfig, effects);
        if (!result) return false;

        // Copy the effected text texture onto the layer at (destX, destY)
        const srcW = Math.min(result.width, activeLayer.texture.width - destX);
        const srcH = Math.min(result.height, activeLayer.texture.height - destY);
        if (srcW <= 0 || srcH <= 0) {
            result.texture.destroy();
            return false;
        }

        const enc = device.createCommandEncoder();
        enc.copyTextureToTexture(
            { texture: result.texture, origin: [0, 0, 0] },
            { texture: activeLayer.texture, origin: [destX, destY, 0] },
            { width: srcW, height: srcH },
        );
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();

        result.texture.destroy();
        this.scheduleRender();
        return true;
    }

    // ── Panel Layout ─────────────────────────────────────────────────

    /**
     * Create a panel layout (manga page structure) and add it to the scene.
     *
     * @param x World X center
     * @param y World Y center
     * @param pageWidth Page width in world units
     * @param pageHeight Page height in world units
     * @param options Grid, gutter, template configuration
     * @returns The created PanelLayout node
     *
     * Example:
     * ```ts
     * const layout = shapeManager.createPanelLayout(0, 0, 2, 3, {
     *   template: 'manga-action',
     *   gutterWidth: 0.02,
     *   bleedMargin: 0.01,
     * });
     * ```
     */
    public createPanelLayout(x: number, y: number, pageWidth: number, pageHeight: number, options?: PanelLayoutOptions): PanelLayout {
        const layout = this.shapeFactory.createPanelLayout(x, y, pageWidth, pageHeight, options);
        this.sceneGraph.root.addChild(layout);
        this.interactionService.clearSelectedNodes();
        this.interactionService.selectNode(layout);
        this.emitSceneGraphChanged();
        return layout;
    }

    /**
     * Create a panel layout sized to exactly fill the current illustration bounds.
     * Centers at the origin (0, 0) — matching the illustration artboard.
     *
     * @param options Grid, gutter, template configuration
     * @returns The created PanelLayout node, or null if no illustration bounds are set.
     *
     * Example:
     * ```ts
     * const layout = shapeManager.createPanelLayoutForIllustration({
     *   template: 'manga-4-panel',
     *   gutterWidth: 0.03,
     * });
     * ```
     */
    public createPanelLayoutForIllustration(options?: PanelLayoutOptions): PanelLayout | null {
        const bounds = this.webgpuRenderer?.getIllustrationBounds?.();
        if (!bounds) {
            console.warn('[Salsa] createPanelLayoutForIllustration: no illustration bounds set');
            return null;
        }
        return this.createPanelLayout(0, 0, bounds.width, bounds.height, options);
    }

    /** Get a panel layout by node id. */
    public getPanelLayout(nodeId: string): PanelLayout | null {
        const node = this.sceneGraph.findNodeById(nodeId);
        return node instanceof PanelLayout ? node : null;
    }

    /** Apply a template to a panel layout. */
    public applyPanelTemplate(nodeId: string, template: PanelTemplate): void {
        this.getPanelLayout(nodeId)?.applyTemplate(template);
        this.scheduleRender();
    }

    /** Split a panel horizontally. Returns the new panel id. */
    public splitPanelHorizontal(layoutId: string, panelId: string): string | null {
        const result = this.getPanelLayout(layoutId)?.splitPanelHorizontal(panelId) ?? null;
        this.scheduleRender();
        return result;
    }

    /** Split a panel vertically. Returns the new panel id. */
    public splitPanelVertical(layoutId: string, panelId: string): string | null {
        const result = this.getPanelLayout(layoutId)?.splitPanelVertical(panelId) ?? null;
        this.scheduleRender();
        return result;
    }

    /** Merge two adjacent panels. */
    public mergePanels(layoutId: string, panelIdA: string, panelIdB: string): boolean {
        const result = this.getPanelLayout(layoutId)?.mergePanels(panelIdA, panelIdB) ?? false;
        this.scheduleRender();
        return result;
    }

    /** Remove a panel from the layout. */
    public removePanel(layoutId: string, panelId: string): boolean {
        const result = this.getPanelLayout(layoutId)?.removePanel(panelId) ?? false;
        this.scheduleRender();
        return result;
    }

    /** Set reading order for panels (array of panel ids in order). */
    public setPanelReadingOrder(layoutId: string, orderedPanelIds: string[]): void {
        this.getPanelLayout(layoutId)?.setReadingOrder(orderedPanelIds);
    }

    /** Update panel layout gutter width. */
    public setPanelGutter(layoutId: string, gutterWidth: number): void {
        this.getPanelLayout(layoutId)?.setGutterWidth(gutterWidth);
        this.scheduleRender();
    }

    /** Update panel layout bleed margin. */
    public setPanelBleed(layoutId: string, bleedMargin: number): void {
        this.getPanelLayout(layoutId)?.setBleedMargin(bleedMargin);
        this.scheduleRender();
    }

    /** Get bleed guide rect for overlay rendering. */
    public getPanelBleedGuide(layoutId: string): { x: number; y: number; w: number; h: number } | null {
        return this.getPanelLayout(layoutId)?.getBleedGuideRect() ?? null;
    }

    /** Get gutter guide lines for overlay rendering. */
    public getPanelGutterGuides(layoutId: string): { horizontal: number[]; vertical: number[] } | null {
        return this.getPanelLayout(layoutId)?.getGutterGuides() ?? null;
    }

    /** Get all panels in reading order with their bounds. */
    public getPanelList(layoutId: string): Array<{ id: string; readingOrder: number; bounds: { x: number; y: number; w: number; h: number } }> {
        const layout = this.getPanelLayout(layoutId);
        if (!layout) return [];
        return layout.getPanels().map(p => ({
            id: p.panelDef.id,
            readingOrder: p.panelDef.readingOrder,
            bounds: { ...p.bounds },
        }));
    }

    public enableLineDrawing() {
        this.lineDrawingService.enable();
    }

    public disableLineDrawing() {
        this.lineDrawingService.disable();
    }

    // ── Polygon Drawing ─────────────────────────────────────────────

    /** Enable the freeform polygon drawing tool (click-to-place vertices). */
    public enablePolygonDrawing() {
        this.polygonDrawingService.enable();
    }

    /** Disable the freeform polygon drawing tool. */
    public disablePolygonDrawing() {
        this.polygonDrawingService.disable();
    }

    /** Is the freeform polygon drawing tool currently active? */
    public get isPolygonDrawing(): boolean {
        return this.polygonDrawingService?.isEnabled ?? false;
    }

    /** Is the freeform polygon tool mid-draw (user has placed ≥ 1 vertex)? */
    public get isPolygonDrawingInProgress(): boolean {
        return this.polygonDrawingService?.isDrawing ?? false;
    }

    /** Set colors for the freeform polygon tool. */
    public setPolygonDrawingColors(fill: RGBA, stroke: RGBA, strokeWidth: number) {
        this.polygonDrawingService.setColors(fill, stroke, strokeWidth);
    }

    // ── Polygon Creation (programmatic) ─────────────────────────────

    /**
     * Create a regular (equilateral) polygon and add it to the scene.
     * @param x       World-space center X.
     * @param y       World-space center Y.
     * @param radius  Distance from center to each vertex.
     * @param sides   Number of sides (e.g. 5 = pentagon, 6 = hexagon).
     */
    public createRegularPolygon(
        x: number, y: number, radius: number, sides: number,
        strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: number = 1
    ): void {
        const polygon = this.shapeFactory.createRegularPolygon(
            x, y, radius, sides, this.shapeColor, strokeColor, strokeWidth
        );
        this.sceneGraph.root.addChild(polygon);
        this.emitSceneGraphChanged();
    }

    /**
     * Create a polygon from arbitrary world-space points and add it to the scene.
     * Use this for the freeform polygon commit or for programmatic polygon creation.
     */
    public createPolygonFromPoints(
        points: { x: number; y: number }[],
        strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: number = 1
    ): void {
        const polygon = this.shapeFactory.createPolygon(
            points, this.shapeColor, strokeColor, strokeWidth
        );
        this.sceneGraph.root.addChild(polygon);
        this.emitSceneGraphChanged();
    }

    /**
     * Create a preset polygon shape (parallelogram, chevron, star, etc.) and add it to the scene.
     * @param x       World-space center X.
     * @param y       World-space center Y.
     * @param width   Desired width.
     * @param height  Desired height.
     * @param preset  Preset name (see PolygonPreset type).
     */
    public createPresetPolygon(
        x: number, y: number, width: number, height: number,
        preset: PolygonPreset,
        strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: number = 1
    ): void {
        const polygon = this.shapeFactory.createPresetPolygon(
            x, y, width, height, preset, this.shapeColor, strokeColor, strokeWidth
        );
        this.sceneGraph.root.addChild(polygon);
        this.emitSceneGraphChanged();
    }

    /** Expose PolygonPreset values for UI dropdowns. */
    static get PolygonPresets(): PolygonPreset[] {
        return ['parallelogram', 'trapezoid', 'arrowRight', 'chevron', 'star5', 'star6', 'cross', 'speechBubble'];
    }

    createScribble(x: number, y: number, strokeColor: RGBA, strokeWidth: number) {
        const scribble = this.shapeFactory.createScribble(x, y, strokeColor, strokeWidth);
        this.eraserService.scribbles.push(scribble);
        this.sceneGraph.root.addChild(scribble);
        this.emitSceneGraphChanged();
    }

    public enableScribbleDrawing() {
        this.scribbleDrawingService.enable();
        this.beginInteractive();
    }

    public disableScribbleDrawing() {
        this.scribbleDrawingService.disable();
        this.endInteractive();
    }

    public enableSectionDrawing() {
        this.sectionDrawingService.enable();
        this.beginInteractive();
    }
    
    public disableSectionDrawing() {
        this.sectionDrawingService.disable();
        this.endInteractive();
    }

    public setStrokeWidth(width: number) {
        this.scribbleDrawingService.setStrokeWidth(width*.005);
    }

    createHighlight(x: number, y: number, strokeColor: RGBA, strokeWidth: number) {
        const highlight = this.shapeFactory.createHighlight(x, y, strokeColor, strokeWidth);
        this.eraserService.scribbles.push(highlight);
        this.sceneGraph.root.addChild(highlight);
        this.emitSceneGraphChanged();
    }

    public enableHighlightDrawing() {
        this.highlightDrawingService.enable();
    }

    public disableHighlightDrawing() {
        this.highlightDrawingService.disable();
    }

    public enableTextDrawing() {
        this.textDrawingService.enable();
    }

    public disableTextDrawing() {
        this.textDrawingService.disable();
    }

    public isTextDrawingInProgress(): boolean {
        return this.textDrawingService.isUserTyping();
    }

    public enableEraserTool() {
        this.eraserService.enable();
    }

    public disableEraserTool() {
        this.eraserService.disable();
    }

    public setStrokeColor(color: string) {
        this.scribbleDrawingService.setStrokeColor(hexToRgba(color));
    }

    public setHighlightColor(color: string) {
        this.highlightDrawingService.setStrokeColor(hexToRgba(color));
    }

    public setShapeColor(color: string) {
        this.shapeColor = hexToRgba(color);
    }

    public setTextColor(color: string) {
        this.textDrawingService.setTextColor(hexToRgba(color));
    }

    public enablePatternDrawing() {
        this.patternDrawingService.enable();
    }

    public disablePatternDrawing() {
        this.patternDrawingService.disable();
    }

    public setPattern(pattern: string) {
        this.patternDrawingService.setTextureKey(pattern);
    }

    // Shape Preview
    setPreviewShape(shapeType: ShapeType, event: MouseEvent) {
        // Remove existing preview shape
        if (this.currentPreviewShape) {
            this.sceneGraph.root.removeChild(this.currentPreviewShape);
            this.currentPreviewShape = null;
            this.emitSceneGraphChanged();
            this.endInteractive(); 
        }

        // If shapeType is null, just remove the preview
        if (!shapeType) return;

        const { x, y } = this.interactionService.toWorldCoords(event);

        // Create a new preview shape based on selected type
        switch (shapeType) {
            case ShapeType.Rectangle:
                this.currentPreviewShape = this.shapeFactory.createRectangle(
                    x, y, 1, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            case ShapeType.Circle:
                this.currentPreviewShape = this.shapeFactory.createCircle(
                    x, y, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            case ShapeType.Triangle:
                this.currentPreviewShape = this.shapeFactory.createTriangle(
                    x, y, 1, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            case ShapeType.InverseTriangle:
                this.currentPreviewShape = this.shapeFactory.createInvertedTriangle(
                    x, y, .5, .5, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            case ShapeType.Polygon:
                this.currentPreviewShape = this.shapeFactory.createRegularPolygon(
                    x, y, 0.5, this.defaultPolygonSides, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            // Add other shapes here...
        }

        // Mark it as a preview shape
        if (this.currentPreviewShape) {
            this.currentPreviewShape.isPreview = true;
            this.sceneGraph.root.addChild(this.currentPreviewShape);
            this.beginInteractive();
            this.scheduleRender();
        }
    }

    updatePreviewShapePosition(event: MouseEvent) {
        if (this.currentPreviewShape) {
            const { x, y } = this.interactionService.toWorldCoords(event);
            this.currentPreviewShape.x = x;
            this.currentPreviewShape.y = y;

            // Sync colors if a new one has been selected
            if(this.currentPreviewShape.fillColor != this.shapeColor)
            {
                this.currentPreviewShape.fillColor = this.shapeColor;
            }
            this.scheduleRender();
        }
    }

    confirmPreviewShape() {
        if (this.currentPreviewShape) {
            this.currentPreviewShape.fillColor = this.shapeColor;
            this.currentPreviewShape.isPreview = false; // Convert to actual shape
            this.currentPreviewShape = null;
            this.endInteractive();
        }
        this.emitSceneGraphChanged();
    }

    enablePanningTool() {
        this.interactionService.isPanToolSelected = true;
    }

    disablePanningTool() {
        this.interactionService.isPanToolSelected = false;
    }

    public getSceneGraphJSON(): string {
        return JSON.stringify(this.sceneGraph.toJSON()); // Ensure it calls the proper serialization method
    }

    // New: produce scene graph JSON with inline raster layer data (base64 data URLs)
    // This is a convenience for quick persistence where raster pixels are stored together with scene JSON.
    public async getSceneGraphJSONWithRasterData(imageType: 'image/webp' | 'image/png' = 'image/webp'): Promise<string> {
        const scene = this.sceneGraph.toJSON();

        // If no raster manager, return plain scene
        if (!this.rasterLayerManager) return JSON.stringify(scene);

        try {
            const layers = await this.rasterLayerManager.exportLayersAsDataURLs(imageType);
            // Attach under a top-level property so existing loaders can ignore it if unknown
            (scene as any).rasterLayers = layers.map(l => ({ id: l.id, name: l.name, visible: l.visible, imageData: l.dataUrl, width: l.width, height: l.height }));
        } catch (e) {
            console.warn('getSceneGraphJSONWithRasterData: failed to export raster layers', e);
        }
        return JSON.stringify(scene);
    }

    public async setSceneGraphJSON(jsonString: string): Promise<void> {
        try {
            const data = JSON.parse(jsonString);
            
            // 1. First pass: collect all texture keys from patterns
            const textureKeys = new Set<string>();
            this.collectTextureKeys(data.root, textureKeys);
            
            // 2. Pre-load all textures into the TextureArrayAtlas
            const atlas = this.patternDrawingService.getAtlas();
            
            if (textureKeys.size > 0) {
                const results = await Promise.all(
                    Array.from(textureKeys).map(async (key, index) => {
                        const layer = await atlas.ensure(key);
                        return { key, layer };
                    })
                );
            }
            
            // 3. Now recreate the scene graph - all textures will be ready
            this.updateSceneGraph(this.sceneGraph.root, data.root);
            this.emitSceneGraphChanged();
        } catch (error) {
            console.error("Error loading board:", error);
        }
    }

    // ── Image Import ────────────────────────────────────────────────

    /**
     * Import an image (File, Blob, or ImageBitmap) onto the currently selected layer,
     * replacing its contents. Ideal for pasting clipboard images or drag-and-drop.
     *
     * ```ts
     * // From a file input
     * const file = input.files[0];
     * await shapeManager.importImageToCurrentLayer(file);
     *
     * // From clipboard
     * document.addEventListener('paste', async (e) => {
     *   const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
     *   if (item) await shapeManager.importImageToCurrentLayer(item.getAsFile());
     * });
     * ```
     */
    public async importImageToCurrentLayer(
        source: File | Blob | ImageBitmap,
    ): Promise<boolean> {
        if (!this.rasterLayerManager) return false;
        const activeId = this.rasterLayerManager.getSelectedLayerId();
        if (!activeId) return false;
        return this.importImageToLayer(activeId, source);
    }

    /**
     * Import an image onto a specific layer by ID, replacing its contents.
     */
    public async importImageToLayer(
        layerId: string,
        source: File | Blob | ImageBitmap,
    ): Promise<boolean> {
        if (!this.rasterLayerManager) return false;
        const layer = this.rasterLayerManager.getLayerById(layerId);
        if (!layer) return false;

        try {
            const { w, h } = this.rasterLayerManager.getCanvasSize();
            const raster = await this.decodeImageToRasterCanvas(source, w, h);
            if (!raster) return false;
            const ok = await this.rasterLayerManager.importRasterCanvasToLayer(layerId, raster);
            if (ok) {
                this.scheduleRender();
                this.emitSceneGraphChanged();
            }
            return ok;
        } catch (e) {
            console.warn('[Salsa] importImageToLayer failed:', e);
            return false;
        }
    }

    /**
     * Import an image as a **new** layer (placed above the current selection).
     * Returns the new layer's ID, or null on failure.
     *
     * ```ts
     * const layerId = await shapeManager.importImageAsNewLayer(file, 'Reference Photo');
     * if (layerId) {
     *   shapeManager.setLayerLocked(layerId, true);   // lock so you don't accidentally paint on it
     *   shapeManager.setLayerOpacity(layerId, 0.4);   // dim it so your drawing stands out
     * }
     * ```
     */
    public async importImageAsNewLayer(
        source: File | Blob | ImageBitmap,
        name: string = 'Imported Image',
    ): Promise<string | null> {
        if (!this.rasterLayerManager) return null;

        try {
            const { w, h } = this.rasterLayerManager.getCanvasSize();
            const raster = await this.decodeImageToRasterCanvas(source, w, h);
            if (!raster) return null;
            const result = await this.rasterLayerManager.createLayerFromRasterCanvas(name, raster);
            this.scheduleRender();
            this.emitSceneGraphChanged();
            return result.id;
        } catch (e) {
            console.warn('[Salsa] importImageAsNewLayer failed:', e);
            return null;
        }
    }

    /**
     * Decode a File, Blob, or ImageBitmap into a RasterCanvas with pixel data.
     * If targetW/targetH are provided, the image is placed at its **native
     * resolution** (1:1 pixels, no scaling) centered within a canvas of that
     * size. The surrounding area is left transparent.
     */
    private async decodeImageToRasterCanvas(
        source: File | Blob | ImageBitmap,
        targetW?: number,
        targetH?: number,
    ): Promise<InstanceType<typeof import('../renderer/raster/raster-canvas').RasterCanvas> | null> {
        const { RasterCanvas } = await import('../renderer/raster/raster-canvas');

        let bitmap: ImageBitmap;
        if (source instanceof ImageBitmap) {
            bitmap = source;
        } else {
            bitmap = await createImageBitmap(source);
        }

        const imgW = bitmap.width;
        const imgH = bitmap.height;
        if (!imgW || !imgH) return null;

        // Output dimensions: use target (canvas) size if provided, else native image size
        const outW = targetW && targetH ? targetW : imgW;
        const outH = targetW && targetH ? targetH : imgH;

        // Draw to an OffscreenCanvas (or fallback <canvas>)
        const canvas = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(outW, outH)
            : document.createElement('canvas');
        (canvas as any).width = outW;
        (canvas as any).height = outH;
        const ctx = (canvas as any).getContext('2d') as CanvasRenderingContext2D;
        if (!ctx) return null;

        // Place image at native resolution (no scaling), centered on the canvas
        const offsetX = Math.round((outW - imgW) / 2);
        const offsetY = Math.round((outH - imgH) / 2);
        ctx.drawImage(bitmap as any, offsetX, offsetY);

        const imageData = ctx.getImageData(0, 0, outW, outH);
        const raster = new RasterCanvas(outW, outH);
        raster.getBuffer().set(imageData.data as any);
        return raster;
    }

        // Import raster layers from parsed layer metadata containing data URLs.
        // Each entry should be { id?, name?, imageData: dataUrl, width, height }
        public async importRasterLayersFromDataURLs(layers: Array<{ id?: string; name?: string; imageData?: string; width?: number; height?: number }>) {
            if (!layers || !this.rasterLayerManager) return;

            const canvasCtorAvailable = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';

            for (const l of layers) {
                if (!l.imageData) continue;
                try {
                    // Convert dataURL -> Blob and use the shared decode helper
                    const blob = this.dataURLToBlob(l.imageData);
                    const { w: canvasW, h: canvasH } = this.rasterLayerManager!.getCanvasSize();

                    // Use canvas dimensions so the image is placed at native
                    // resolution centered on the canvas, matching other layers.
                    const raster = await this.decodeImageToRasterCanvas(blob, canvasW, canvasH);
                    if (!raster) {
                        console.warn('importRasterLayersFromDataURLs: failed to decode image for layer', l.name);
                        continue;
                    }

                    // If id provided and layer exists, import into it; else create new layer
                    if (l.id) {
                        const existing = this.rasterLayerManager.getLayerById(l.id);
                        if (existing) {
                            await this.rasterLayerManager.importRasterCanvasToLayer(l.id, raster);
                            continue;
                        }
                    }

                    // create new layer seeded with the raster
                    await this.rasterLayerManager.createLayerFromRasterCanvas(l.name ?? 'Layer', raster);

                } catch (e) {
                    console.warn('Failed to import raster layer', l, e);
                }
            }
            this.emitSceneGraphChanged();
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

    public updateSceneGraph(targetNode: Node, sourceData: any): void {
        if (!targetNode || !sourceData) return;
    
        // Update core properties
        targetNode.x = sourceData.x;
        targetNode.y = sourceData.y;
        targetNode.scaleX = sourceData.scaleX;
        targetNode.scaleY = sourceData.scaleY;
        targetNode.rotation = sourceData.rotation;
        targetNode.zIndex = sourceData.zIndex;
        targetNode.visible = sourceData.visible;
        targetNode.locked = sourceData.locked;
    
        // Clear existing children (optional: optimize to avoid unnecessary clearing)
        targetNode.children = [];
    
        // Recursively recreate child nodes and attach them to the target node
        if (sourceData.children) {
            sourceData.children.forEach((childData: any) => {
                const newChild = this.recreateNode(childData);
                targetNode.addChild(newChild);
            });
        }
    }

    private recreateNode(data: any): Node {
        let node: Node;
        switch (data.type) {
            case "Rectangle":
                node = this.shapeFactory.createRectangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Circle":
                node = this.shapeFactory.createCircle(
                    data.x, data.y, data.radius ?? data.width, // Assuming `width` is used as radius
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Triangle":
                node = this.shapeFactory.createTriangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "InvertedTriangle":
                node = this.shapeFactory.createInvertedTriangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Diamond":
                node = this.shapeFactory.createDiamond(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Line":
                const line = this.shapeFactory.createLine(
                    data.x1, data.y1, data.x2, data.y2, data.strokeColor, data.strokeWidth
                );
                if (data.x1 === data.x2 && data.y1 === data.y2) {
                    line.updateEndPoint(data.x2 + 1e-6, data.y2); // avoid degenerate on load
                }
                if (data.arrowStart) line.arrowStart = data.arrowStart;
                if (data.arrowEnd) line.arrowEnd = data.arrowEnd;
                if (data.arrowSize != null) line.arrowSize = data.arrowSize;
                if (data.startBinding) line.startBinding = data.startBinding;
                if (data.endBinding) line.endBinding = data.endBinding;
                node = line;
                break;
            case "Scribble":
                node = this.shapeFactory.createScribble(
                    data.x, data.y, data.strokeColor, data.strokeWidth
                );
                (node as Scribble).points = data.points;
                (node as Scribble).wasCommitted = false;
                (node as Scribble).isStaging = false;
                this.eraserService.scribbles.push(node as Scribble);
                break;
            case "Highlight": 
                node = this.shapeFactory.createHighlight(
                    data.points[0].x, data.points[0].y, data.strokeColor, data.strokeWidth
                );
                (node as Highlight).points = data.points;
                this.eraserService.scribbles.push(node as Highlight);
                break;
            case "Pattern":
						node = this.shapeFactory.createPattern(
								data.x1, data.y1, data.x2, data.y2,
								data.strokeColor, data.strokeWidth,
								data.textureKey,
								this.patternDrawingService.device
						);
						
						const pattern = node as Pattern;
						const patternAtlas = this.patternDrawingService.getAtlas();
						
						// Since texture was pre-loaded, get the current layer
						const patternLayer = patternAtlas.getLayer(data.textureKey);
						
						// Use the CURRENT atlas layer, not saved data
						pattern.layerIndex = patternLayer >= 0 ? patternLayer : 0;
						pattern.atlasWidth = patternAtlas.getWidth();
						
						if (patternLayer < 0) {
								console.warn(`Pattern texture not found in atlas: ${data.textureKey}`);
						}
						
						break;
						case "Stamp":
							node = this.shapeFactory.createStamp(
									data.x, data.y,
									data.width, data.height,
									data.textureKey,
									data.fillColor || { r: 1, g: 1, b: 1, a: 1 }
							);
							
							const stamp = node as Stamp;
							const atlas = this.stampDrawingService.getAtlas();
							
							// Since texture was pre-loaded, get the current layer
							const layer = atlas.getLayer(data.textureKey);
							
							// Use the CURRENT atlas layer, not saved data
							stamp.layerIndex = layer >= 0 ? layer : 0;
							stamp.atlasWidth = atlas.getWidth();
							stamp.atlasHeight = atlas.getHeight();
							
							if (layer < 0) {
									console.warn(`Stamp texture not found in atlas: ${data.textureKey}`);
							}
							
							break;
            case "SDFText":
                node = this.shapeFactory.createSDFText(
                    data.x, 
                    data.y, 
                    data.text, 
                    data.fontSize,
                    this.sdfTextDrawingService.getSDFAtlas(),
                    data.fillColor || data.strokeColor, // SDFText uses strokeColor primarily
                    data.font
                );
                const sdfTextNode = node as SDFText;
                sdfTextNode.lineHeight = data.lineHeight ?? sdfTextNode.lineHeight;
                sdfTextNode.setText(data.text ?? "TEST");
                sdfTextNode.sdfThreshold = data.sdfThreshold ?? 0.5;
                sdfTextNode.outlineColor = data.outlineColor ?? { r: 0, g: 0, b: 0, a: 0 };
                sdfTextNode.smoothing = data.smoothing ?? 1;
                sdfTextNode.outlineWidth = data.outlineWidth ?? 0;
                if (data.writingMode) sdfTextNode.writingMode = data.writingMode;
                if (data.maxWidth != null && data.maxWidth > 0) {
                    sdfTextNode.setMaxWidth(data.maxWidth);
                }
                sdfTextNode.refreshText();
                break;
            case "Sticky Note": 
                const note = this.shapeFactory.createStickyNote(
                    data.x, data.y, data.text ?? "New note", data.color ?? {r:1,g:.98,b:.65,a:1}, data.signatureText,
										data.font, data.fontSize, data.lineHeight
                );
                note.fixedWidth = data.fixedWidth ?? true;
                if (data.targetWidth) note.setWidth(data.targetWidth);
                node = note;
                break;
            case "Polygon":
                node = this.shapeFactory.createPolygon(
                    data.points, data.fillColor, data.strokeColor, data.strokeWidth
                );
                if (data.presetTag) (node as any).presetTag = data.presetTag;
                break;
            case "Speech Balloon": {
                const balloon = this.shapeFactory.createSpeechBalloon(data.x, data.y, {
                    text: data.text,
                    font: data.font,
                    fontSize: data.fontSize,
                    lineHeight: data.lineHeight,
                    writingMode: data.writingMode,
                    textColor: data.textColor,
                    fillColor: data.fillColor,
                    strokeColor: data.strokeColor,
                    strokeWidth: data.strokeWidth,
                    tailSide: data.tailSide,
                    tailPosition: data.tailPosition,
                    tailLength: data.tailLength,
                    tailWidth: data.tailWidth,
                    showTail: data.showTail,
                    style: data.balloonStyle,
                    minWidth: data.minWidth,
                    minHeight: data.minHeight,
                    maxWidth: data.maxWidth,
                });
                node = balloon;
                break;
            }
            case "LiveText": {
                const ltOpts = data.liveTextOptions ?? {};
                const node2 = this.shapeFactory.createLiveText(data.x ?? 0, data.y ?? 0, {
                    text: ltOpts.text ?? '',
                    font: ltOpts.font,
                    fontSize: ltOpts.fontSize,
                    color: ltOpts.color,
                    bold: ltOpts.bold,
                    italic: ltOpts.italic,
                    writingMode: ltOpts.writingMode,
                    maxWidth: ltOpts.maxWidth,
                    lineHeight: ltOpts.lineHeight,
                    padding: ltOpts.padding,
                    effects: ltOpts.effects,
                });
                // Wire up the TextEffectEngine so the node can render
                const engine = this.getTextEffectEngine();
                if (engine) node2.setEngine(engine);

                // Compute worldUnitsPerPixel (same as createLiveText)
                const illBounds2 = this.webgpuRenderer?.getIllustrationBounds?.();
                const pixelSize2 = this.webgpuRenderer?.getIllustrationPixelSize?.();
                const canvas2 = this.interactionService?.canvas;
                if (illBounds2 && pixelSize2) {
                    node2.worldUnitsPerPixel = illBounds2.width / pixelSize2.w;
                } else if (canvas2) {
                    node2.worldUnitsPerPixel = 2 / canvas2.height;
                }

                // Init DOM element for HTML-in-Canvas
                if (canvas2 && TextEffectEngine.htmlInCanvasAvailable()) {
                    if (!canvas2.hasAttribute('layoutsubtree')) {
                        canvas2.setAttribute('layoutsubtree', '');
                    }
                    node2.initDomElement(canvas2);
                    TextEffectEngine.requestPaint(canvas2);
                }

                // Capture initial texture so dimensions are correct
                node2.updateTexture();

                node = node2;
                break;
            }
            case "Panel Layout": {
                const layout = this.shapeFactory.createPanelLayout(
                    data.x, data.y,
                    data.pageWidth ?? 2, data.pageHeight ?? 3,
                    {
                        rows: data.rows,
                        cols: data.cols,
                        gutterWidth: data.gutterWidth,
                        bleedMargin: data.bleedMargin,
                        borderWidth: data.borderWidth,
                        borderColor: data.borderColor,
                        backgroundColor: data.backgroundColor,
                        showBleedGuides: data.showBleedGuides,
                        showGutterGuides: data.showGutterGuides,
                        panels: data.panels,
                        template: data.templateName,
                    },
                );
                node = layout;
                break;
            }
            case "Group":
                const recreatedChildren = (data.children || []).map((childData: any) =>
                    this.recreateNode(childData)
                );

                node = this.shapeFactory.createGroup(
                    recreatedChildren,
                    data.fillColor || { r: 0, g: 0, b: 0, a: 0 },
                    data.strokeColor || { r: 0, g: 0, b: 0, a: 0 },
                    data.strokeWidth || 1
                );

                (node as Group).clipChildren = data.clipChildren ?? false;
                (node as Group).drawBackground = data.drawBackground ?? false;
                (node as Group).backgroundColor = data.backgroundColor ?? { r: 1, g: 1, b: 1, a: 1 };
                break;
            default:
                node = new Node();
                break;
        }
    
        if (node instanceof Shape && data.id) {
            node.setId(data.id);
        }

        node.name = data.name;
        node.x = data.x;
        node.y = data.y;
        node.scaleX = data.scaleX;
        node.scaleY = data.scaleY;
        node.rotation = data.rotation;
        node.zIndex = data.zIndex;
        node.visible = data.visible;
        node.locked = data.locked;
    
        // Restore children only if not a Group (since Group already handles them)
        if (data.children && data.type !== "Group" && data.type !== "Sticky Note") {
            data.children.forEach((childData: any) => {
                node.addChild(this.recreateNode(childData));
            });
        }
    
        return node;
    }

    public deleteSelectedShapes(): void {
        this.beginInteractive();

        const selected = Array.from(this.interactionService.selectedNodes);
        if (selected.length === 0) { 
            this.endInteractive();
            return;
        }

        // Collect only parents that actually have recalc
        type RecalcParent = { recalculateSize?: () => void };
        const parentsToRecalc = new Set<RecalcParent>();

        for (const node of selected) {
            const p = node.parent as RecalcParent | null;
            if (p && typeof p.recalculateSize === 'function') {
                parentsToRecalc.add(p);
            }
        }

        // Remove deepest first (so children go before their selected parents)
        const depthOf = (n: any) => { let d = 0, p = n.parent; while (p) { d++; p = p.parent; } return d; };
        selected.sort((a, b) => depthOf(b) - depthOf(a));

        // Remove nodes
        for (const node of selected) {
            if (node.parent) {
            node.parent.removeChild(node);
            } else {
            // root child
            this.sceneGraph.root.removeChild(node);
            }

            // Clean up eraser registries for scribbles/highlights
            const type = (node as any as Shape).getType?.();
            if (type === "Scribble" || type === "Highlight") {
            const arr = this.eraserService.scribbles;
            const idx = arr.indexOf(node as any);
            if (idx !== -1) arr.splice(idx, 1);

            const viewArr = this.eraserService.scribblesInView;
            const vidx = viewArr.indexOf(node as any);
            if (vidx !== -1) viewArr.splice(vidx, 1);
            }

            // Deallocate GPU cache entries (uniform slots + registry)
            this.deallocateCacheEntries(node as Shape, type);
        }

        // Recalculate only where supported
        parentsToRecalc.forEach(p => p.recalculateSize!());

        // Clear selection and emit
        this.interactionService.clearSelectedNodes();
        this.endInteractive();
        this.emitSceneGraphChanged();
    }

    /**
     * Release GPU cache entries for a deleted shape:
     *  - Uniform cache slot (recycled for reuse)
     *  - Bounding box uniform + registry entry
     *  - Type-specific registry entry (geometry offsets)
     *
     * Geometry buffer space is pre-allocated and not individually freed,
     * but registry removal prevents stale draw commands and uniform uploads.
     */
    private deallocateCacheEntries(shape: Shape, type?: string): void {
        const cs = this.webgpuRenderer.getCacheService?.();
        if (!cs) return;

        // ── Bounding box (all shape types use this) ──
        cs.boundingBoxUniformCache.deallocate(shape);

        // ── Type-specific uniform cache + registry ──
        switch (type) {
            case 'Scribble':
                cs.strokeUniformCache.deallocate(shape as any);
                // strokeRegistry is shared with the uniform cache — already cleaned
                break;
            case 'Highlight':
                cs.highlightUniformCache.deallocate(shape as any);
                break;
            case 'Line':
                cs.lineUniformCache.deallocate(shape as any);
                break;
            case 'SDFText':
                cs.sdfTextUniformCache.deallocate(shape as any);
                cs.sdfTextRegistry.delete(shape as any);
                break;
            case 'Pattern':
                cs.patternLegacyUniformCache.deallocate(shape as any);
                cs.legacyPatternRegistry.delete(shape as any);
                break;
            default:
                // Rectangle, Circle, Diamond, Triangle, Polygon, InvertedTriangle, Stamp, etc.
                cs.shapeUniformCache.deallocate(shape);
                break;
        }
    }

    public clear(): void {
        // Reset preview shape
        this.currentPreviewShape = null; 
        // Reset drawing services if necessary
        this.lineDrawingService?.disable();
        this.scribbleDrawingService?.disable();
        this.textDrawingService?.disable();
        this.sdfTextDrawingService?.disable();
        this.highlightDrawingService?.disable();
        this.patternDrawingService?.disable();
        this.stampDrawingService?.disable();
        this.eraserService?.disable();
        // Clear scribbles without breaking references
        this.eraserService.scribbles.length = 0;
        this.eraserService.scribblesInView.length = 0;
        this.scheduleRender();
    }    
    
    getNodePosition(nodeId: string) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            return {x: node.x, y: node.y}
        }
    }

    setNodePosition(nodeId: string, x?: number, y?: number) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            node.x = x ?? node.x;
            node.y = y ?? node.y;
        }
        this.emitSceneGraphChanged();
    }

    setNodeVisibility(nodeId: string, visible: boolean) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            node.visible = visible;
        }
        this.emitSceneGraphChanged();
    }

    setNodeLocked(nodeId: string, locked: boolean) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            node.locked = locked;
        }
        this.scheduleRender();
    }

    setNodeName(nodeId: string, name: string = "Untitled") {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            node.name = name;
        }
        this.scheduleRender(); 
    }

    getNodeById(nodeId: string) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            return node;
        }
    }

    // SDF Text Related
    public enableSDFTextDrawing() {
        this.sdfTextDrawingService.enable();
        this.beginInteractive();
    }

    public disableSDFTextDrawing() {
        this.sdfTextDrawingService.disable();
        this.endInteractive();
    }

    public isSDFTextDrawingInProgress(): boolean {
        return this.sdfTextDrawingService.isUserTyping();
    }

    /**
     * Returns true if any text input is currently active (SDF text, legacy canvas text,
     * or raster text tool). Use this to suppress hotkeys while the user is typing.
     *
     * ```ts
     * window.addEventListener('keydown', (e) => {
     *   if (shapeManager.isInputActive()) return; // don't fire hotkeys
     *   // ... handle hotkeys ...
     * });
     * ```
     */
    public isInputActive(): boolean {
        return this.sdfTextDrawingService.isUserTyping()
            || this.textDrawingService.isUserTyping()
            || (this.rasterTextService?.getState()?.isActive ?? false)
            || this._editingLiveTextId != null;
    }

    /** Tracks the node ID of the LiveTextNode currently in edit mode, or null. */
    private _editingLiveTextId: string | null = null;

    /** Returns the node ID of the LiveTextNode currently being edited, or null. */
    public getEditingLiveTextId(): string | null {
        return this._editingLiveTextId;
    }

    public setSDFTextColor(color: string) {
        this.sdfTextDrawingService.setTextColor(hexToRgba(color));
        this.scheduleRender(); 
    }

    public setSDFTextOutlineColor(color: string) {
        this.sdfTextDrawingService.setOutlineColor(hexToRgba(color));
        this.scheduleRender(); 
    }

    public setSDFTextFontSize(size: number) {
        this.sdfTextDrawingService.setFontSize(size);
        this.scheduleRender(); 
    }

    public setSDFTextFont(font: string) {
        this.sdfTextDrawingService.setFont(font);
        this.scheduleRender(); 
    }

    public setSDFTextThreshold(threshold: number) {
        this.sdfTextDrawingService.setSDFThreshold(threshold);
        this.scheduleRender(); 
    }

    public setSDFTextSmoothing(smoothing: number) {
        this.sdfTextDrawingService.setSmoothing(smoothing);
        this.scheduleRender(); 
    }

    public setSDFTextOutlineWidth(width: number) {
        this.sdfTextDrawingService.setOutlineWidth(width);
        this.scheduleRender(); 
    }

    /** Set the max width (world units) for SDF text word-wrapping. 0 or negative = no wrap. */
    public setSDFTextMaxWidth(worldUnits: number) {
        this.sdfTextDrawingService.setMaxWidth(worldUnits);
        this.scheduleRender();
    }

    public updateSDFText(
        nodeId: string,
        props: Partial<{
            text: string;
            font: string;
            fontSize: number;
            lineHeight: number;
            maxWidth: number;
            fill: string | RGBA;
            outline: string | RGBA;
            outlineWidth: number;
            threshold: number;
            smoothing: number;
        }>
    ): void {

        // 1) Locate & type-guard the node
        const node = this.sceneGraph.findNodeById(nodeId);

        if ((node as Shape).getType() === 'Sticky Note') {
            const note = node as StickyNote;
            if (props.text !== undefined) note.setText(props.text);
            if (props.font        !== undefined) note.setFont(props.font);
            if (props.fontSize    !== undefined) note.setFontSize(props.fontSize);
            if (props.lineHeight  !== undefined) note.setLineHeight(props.lineHeight);
            note.markDirty?.();
            this.emitSceneGraphChanged();
            return;
        }

        if (!node || (node as Shape).getType() != 'SDFText') return;

        // 2) Merge the incoming changes
        if (props.font        !== undefined) (node as SDFText).font        = props.font;
        if (props.fontSize    !== undefined) (node as SDFText).fontSize    = props.fontSize;
        if (props.lineHeight  !== undefined) (node as SDFText).lineHeight = props.lineHeight;

        if (props.fill !== undefined) {
            (node as SDFText).strokeColor = typeof props.fill === "string"
                                    ? hexToRgba(props.fill)
                                    : props.fill;
        }

        if (props.outline !== undefined) {
            (node as SDFText).outlineColor = typeof props.outline === "string"
                                    ? hexToRgba(props.outline)
                                    : props.outline;
        }

        if (props.outlineWidth !== undefined) (node as SDFText).outlineWidth = props.outlineWidth;
        if (props.threshold    !== undefined) (node as SDFText).sdfThreshold = props.threshold;
        if (props.smoothing    !== undefined) (node as SDFText).smoothing    = props.smoothing;
        if (props.maxWidth     !== undefined) (node as SDFText).setMaxWidth(props.maxWidth);
        if (props.text        !== undefined) {
            (node as SDFText).setText(props.text)
        } else {
            (node as SDFText).refreshText();
        }
        
        (node as SDFText).isDirty = true;
        this.emitSceneGraphChanged();
    }

    public async waitForFrameSettled(): Promise<void> {
        return this.webgpuRenderer.waitForFrameSettled();
    }

    public async captureThumbnailBlob(maxWidth = 300): Promise<Blob> {
    	return await this.webgpuRenderer.snapshotToBlob(maxWidth);
    }

    /**
     * Export a single raster layer's pixel data as a Blob (WebP or PNG).
     * This is the API Frogmarks should use to push layer data to the backend.
     *
     * @param layerId The raster layer id
     * @param type Image format: 'image/webp' (smaller) or 'image/png' (lossless)
     * @returns Blob containing the full-resolution layer pixels, or null if layer not found
     */
    public async exportRasterLayerToBlob(layerId: string, type: 'image/webp' | 'image/png' = 'image/webp'): Promise<Blob | null> {
        if (!this.rasterLayerManager) return null;
        const blobs = await this.rasterLayerManager.exportLayersAsBlobs(type);
        const match = blobs.find(b => b.id === layerId);
        return match?.blob ?? null;
    }

    /**
     * Export ALL raster layers as Blobs (ordered back-to-front).
     * Convenience method for batch upload to backend.
     *
     * @param type Image format
     * @returns Array of { id, name, visible, blob, width, height }
     */
    public async exportAllRasterLayersAsBlobs(type: 'image/webp' | 'image/png' = 'image/webp'): Promise<Array<{ id: string; name: string; visible: boolean; blob?: Blob; width: number; height: number }>> {
        if (!this.rasterLayerManager) return [];
        return this.rasterLayerManager.exportLayersAsBlobs(type);
    }

    private collectTextureKeys(nodeData: any, textureKeys: Set<string>): void {
        if (nodeData.type === "Pattern" && nodeData.textureKey) {
                textureKeys.add(nodeData.textureKey);
        }
        if (nodeData.type === "Stamp" && nodeData.textureKey) {
                textureKeys.add(nodeData.textureKey);
        }
        
        if (nodeData.children) {
                nodeData.children.forEach((child: any) => 
                        this.collectTextureKeys(child, textureKeys)
                );
        }
    }

    // For Illustration
    public setIllustrationMode(enabled: boolean): void {
        if (this.webgpuRenderer) {
                this.webgpuRenderer.setIllustrationMode(enabled);
        }
        this.scheduleRender();
    }

    public getIllustrationMode(): boolean {
        if (this.webgpuRenderer) {
                return this.webgpuRenderer.getIllustrationMode();
        }
        return false;
    }

    public setIllustrationBounds(width: number, height: number): void {
        if (this.webgpuRenderer) {
            this.webgpuRenderer.setIllustrationBounds(width, height);
            // Resize the layer manager to match the new illustration pixel dimensions
            // so all layers have the correct aspect ratio.
            if (this.rasterLayerManager) {
                const { w, h } = this.webgpuRenderer.getIllustrationPixelSize();
                this.rasterLayerManager.setSize(w, h);
            }
        }
        this.scheduleRender();
    }

    public setBackgroundPatternFixed(fixed: boolean): void {
        if (this.webgpuRenderer) {
                this.webgpuRenderer.setBackgroundPatternFixed(fixed);
        }
        this.scheduleRender();
    }

    // ── Animation API ─────────────────────────────────────────────────

    /**
     * Enable or disable animation mode.
     * When enabled, layers can have per-frame cels and the timeline is active.
     * An illustration is a 1-frame animation — toggling this just reveals the timeline.
     */
    public setAnimationEnabled(enabled: boolean): void {
        this.rasterLayerManager?.setAnimationEnabled(enabled);
    }

    public isAnimationEnabled(): boolean {
        return this.rasterLayerManager?.isAnimationEnabled() ?? false;
    }

    /**
     * Set the current frame (1-indexed). Triggers texture swaps for animated layers
     * and updates the compositor's frame for procedural displacement animations.
     */
    public setCurrentFrame(frame: number): void {
        this.rasterLayerManager?.getTimeline().setCurrentFrame(frame);
        // Sync current frame to renderer for procedural displacement effects
        if (this.webgpuRenderer) {
            this.webgpuRenderer.currentAnimationFrame = frame;
        }
        this.scheduleRender();
    }

    public getCurrentFrame(): number {
        return this.rasterLayerManager?.getTimeline().getCurrentFrame() ?? 1;
    }

    /** Get total frame count. */
    public getFrameCount(): number {
        return this.rasterLayerManager?.getTimeline().getFrameCount() ?? 1;
    }

    /** Set total frame count. */
    public setFrameCount(count: number): void {
        this.rasterLayerManager?.getTimeline().setFrameCount(count);
    }

    /** Set the playback range (1-indexed, inclusive). */
    public setPlayRange(start: number, end: number): void {
        this.rasterLayerManager?.getTimeline().setPlayRange(start, end);
    }

    /** Get the current playback range. */
    public getPlayRange(): { start: number; end: number } {
        const state = this.rasterLayerManager?.getTimeline().getState();
        return { start: state?.playRangeStart ?? 1, end: state?.playRangeEnd ?? 1 };
    }

    /** Get frames per second. */
    public getFps(): number {
        return this.rasterLayerManager?.getTimeline().getFps() ?? 12;
    }

    /** Set frames per second (1-120). */
    public setFps(fps: number): void {
        this.rasterLayerManager?.getTimeline().setFps(fps);
    }

    /** Add frames at the end of the timeline. */
    public addFrames(count: number): void {
        this.rasterLayerManager?.getTimeline().addFrames(count);
    }

    /** Insert a frame at a position (1-indexed). Shifts subsequent frames. */
    public insertFrame(at: number): void {
        this.rasterLayerManager?.getTimeline().insertFrame(at);
    }

    /** Delete a frame at a position. Shifts subsequent frames back. */
    public deleteFrame(at: number): void {
        this.rasterLayerManager?.getTimeline().deleteFrame(at);
    }

    /** Navigate to the next frame. */
    public nextFrame(): void {
        this.rasterLayerManager?.getTimeline().nextFrame();
        this.syncRendererFrame();
        this.scheduleRender();
    }

    /** Navigate to the previous frame. */
    public prevFrame(): void {
        this.rasterLayerManager?.getTimeline().prevFrame();
        this.syncRendererFrame();
        this.scheduleRender();
    }

    /** Start playback. */
    private _playbackUnsub?: () => void;

    public play(): void {
        const timeline = this.rasterLayerManager?.getTimeline();
        if (!timeline) return;
        // Clean up previous listener to avoid accumulating subscriptions
        this._playbackUnsub?.();
        // During playback, schedule renders on every frame change
        this._playbackUnsub = timeline.on((e) => {
            if (e.type === 'frame-changed') {
                this.syncRendererFrame();
                this.scheduleRender();
            }
        });
        timeline.play();
    }

    /** Pause playback. */
    public pause(): void {
        this.rasterLayerManager?.getTimeline().pause();
    }

    /** Stop playback (returns to first frame). */
    public stopPlayback(): void {
        this.rasterLayerManager?.getTimeline().stop();
        this.syncRendererFrame();
        this.scheduleRender();
    }

    /** Toggle play/pause. */
    public togglePlayPause(): void {
        const timeline = this.rasterLayerManager?.getTimeline();
        if (!timeline) return;
        if (timeline.getState().playbackState === 'playing') {
            this.pause();
        } else {
            this.play();
        }
    }

    /**
     * Convert a layer to animated mode (multi-frame cels).
     * The layer's current content becomes the first cel.
     */
    public setLayerAnimated(layerId: string, animated: boolean): boolean {
        return this.rasterLayerManager?.setLayerAnimated(layerId, animated) ?? false;
    }

    /** Check if a layer is in animated mode. */
    public isLayerAnimated(layerId: string): boolean {
        return this.rasterLayerManager?.isLayerAnimated(layerId) ?? false;
    }

    /**
     * Add a new blank cel on the current frame for the specified layer.
     * Returns the cel id or null.
     */
    public addCelAtCurrentFrame(layerId: string): string | null {
        const result = this.rasterLayerManager?.addCelAtCurrentFrame(layerId) ?? null;
        if (result) this.scheduleRender();
        return result;
    }

    /**
     * Add a new blank cel at a specific frame.
     */
    public addCelAtFrame(layerId: string, frame: number): string | null {
        const result = this.rasterLayerManager?.addCelAtFrame(layerId, frame) ?? null;
        if (result) this.scheduleRender();
        return result;
    }

    /** Delete a cel from an animated layer. */
    public deleteCel(layerId: string, celId: string): boolean {
        const result = this.rasterLayerManager?.deleteCel(layerId, celId) ?? false;
        if (result) this.scheduleRender();
        return result;
    }

    /**
     * Set the loop mode for playback.
     * 'none' = play once, 'loop' = repeat, 'ping-pong' = bounce back and forth.
     */
    public setLoopMode(mode: 'none' | 'loop' | 'ping-pong'): void {
        this.rasterLayerManager?.getTimeline().setLoopMode(mode);
    }

    /**
     * Configure onion skinning (ghost frames for animation workflow).
     *
     * Example:
     * ```
     * shapeManager.setOnionSkin({
     *   enabled: true,
     *   framesBefore: 3,
     *   framesAfter: 1,
     *   opacity: 0.25,
     *   tintBefore: [1, 0.2, 0.2],
     *   tintAfter: [0.2, 0.5, 1],
     * });
     * ```
     */
    public setOnionSkin(config: Partial<OnionSkinConfig>): void {
        this.rasterLayerManager?.setOnionSkinConfig(config);
        this.scheduleRender();
    }

    public getOnionSkin(): OnionSkinConfig | null {
        return this.rasterLayerManager?.getOnionSkinConfig() ?? null;
    }

    /**
     * Get the animation timeline state (read-only snapshot).
     * Useful for building timeline UI.
     */
    public getTimelineState() {
        return this.rasterLayerManager?.getTimeline().getState() ?? null;
    }

    /**
     * Subscribe to animation events (frame changes, playback state, etc.).
     * Returns an unsubscribe function.
     */
    public onAnimationEvent(listener: (event: { type: string; frame?: number; layerId?: string; celId?: string }) => void): () => void {
        const timeline = this.rasterLayerManager?.getTimeline();
        if (!timeline) return () => {};
        return timeline.on(listener);
    }

    // ── Cel Operations (duplicate / move / swap) ─────────────────────

    /**
     * Duplicate a cel's pixel data to a target frame.
     * Creates a GPU texture copy — the new cel is an independent drawing.
     * Common workflow: duplicate a key drawing, then modify it slightly.
     *
     * @returns the new cel's id, or null if the source doesn't exist.
     *
     * Example:
     * ```ts
     * const newCelId = shapeManager.duplicateCel(layerId, celId, 5);
     * ```
     */
    public duplicateCel(layerId: string, celId: string, targetFrame: number): string | null {
        return this.rasterLayerManager?.duplicateCel(layerId, celId, targetFrame) ?? null;
    }

    /**
     * Move a cel to a different frame (repositions, no pixel copy).
     * The cel's drawing stays the same, it just appears at a new time.
     * Fails if the target frame is already occupied by another cel.
     */
    public moveCel(layerId: string, celId: string, targetFrame: number): boolean {
        return this.rasterLayerManager?.moveCel(layerId, celId, targetFrame) ?? false;
    }

    /**
     * Swap two cels' positions (exchange their frames).
     * Useful for reordering animation poses.
     */
    public swapCels(layerId: string, celIdA: string, celIdB: string): boolean {
        return this.rasterLayerManager?.swapCels(layerId, celIdA, celIdB) ?? false;
    }

    /**
     * Set how many frames a cel is held for (exposure / hold duration).
     * Duration of 1 = single frame, 2 = held for two frames, etc.
     */
    public setCelDuration(layerId: string, celId: string, duration: number): boolean {
        return this.rasterLayerManager?.setCelDuration(layerId, celId, duration) ?? false;
    }

    /**
     * Mark a cel as 'key' (important pose) or 'inbetween' (transitional).
     * This affects how the cel is displayed in the timeline (◆ vs ○).
     */
    public setCelType(layerId: string, celId: string, type: 'key' | 'inbetween'): boolean {
        return this.rasterLayerManager?.setCelType(layerId, celId, type) ?? false;
    }

    /**
     * Get all cels for a layer. Returns an array of cel metadata
     * (id, startFrame, duration, celType) for building the timeline UI.
     */
    public getCels(layerId: string): Array<{ id: string; startFrame: number; duration: number; celType: 'key' | 'inbetween' }> {
        return this.rasterLayerManager?.getCels(layerId) ?? [];
    }

    // ── Document Persistence (Auto-save / OPFS) ─────────────────────

    /**
     * Check if OPFS-based persistence is available in this browser.
     * Returns false in incognito mode and some older browsers.
     */
    public isAutoSaveAvailable(): boolean {
        return isOPFSAvailable();
    }

    /**
     * Initialize the persistence engine and start auto-saving.
     *
     * Call this once after the renderer and layer manager are ready.
     * The engine saves a full document snapshot (layers, animation,
     * scene graph, brush presets) to the Origin Private File System
     * on a timer and after every stroke.
     *
     * @param docId Unique document identifier (UUID recommended).
     * @param docName Human-readable document name (for the gallery).
     * @param config Optional auto-save configuration.
     *
     * Example:
     * ```ts
     * shapeManager.enableAutoSave('abc-123', 'My Illustration', {
     *   intervalMs: 30000,        // every 30s
     *   strokeDebounceMs: 5000,   // 5s after last stroke
     *   pixelFormat: 'raw',       // fast uncompressed saves
     * });
     * ```
     */
    public enableAutoSave(
        docId: string,
        docName: string = 'Untitled',
        config?: Partial<AutoSaveConfig>,
    ): void {
        this.currentDocId = docId;
        this.currentDocName = docName;
        this.persistence = new DocumentPersistence(config);
        this.persistence.setStateProvider(() => this.gatherDocumentState());
        this.persistence.startAutoSave();
    }

    /** Stop auto-saving (engine stays initialized for manual saves). */
    public disableAutoSave(): void {
        this.persistence?.stopAutoSave();
    }

    /** Update auto-save configuration while running. */
    public setAutoSaveConfig(config: Partial<AutoSaveConfig>): void {
        this.persistence?.setConfig(config);
    }

    /** Get current auto-save configuration. */
    public getAutoSaveConfig(): AutoSaveConfig | null {
        return this.persistence?.getConfig() ?? null;
    }

    /**
     * Subscribe to save lifecycle events (for "Saving..." / "Saved ✓" UI).
     */
    public onSaveEvent(onStart: () => void, onComplete: (success: boolean) => void): void {
        this.persistence?.setSaveCallbacks(onStart, onComplete);
    }

    /**
     * Trigger a manual save now. Returns true if save succeeded.
     * Use this for the "Save" button / Ctrl+S.
     */
    public async saveDocument(): Promise<boolean> {
        if (!this.persistence) {
            this.persistence = new DocumentPersistence();
            this.persistence.setStateProvider(() => this.gatherDocumentState());
        }
        return this.persistence.saveNow();
    }

    /**
     * Load a document from OPFS storage.
     * Restores layers, animation state, scene graph, and brush presets.
     *
     * @returns true if loaded successfully, false if not found or failed.
     */
    public async loadDocument(docId: string): Promise<{
        success: boolean;
        layers: Array<{ id: string; name: string; visible: boolean; locked: boolean; blendMode: any; opacity: number; clipped: boolean; lockTransparency: boolean }>;
    }> {
        if (!this.persistence) {
            this.persistence = new DocumentPersistence();
            this.persistence.setStateProvider(() => this.gatherDocumentState());
        }

        const payload = await this.persistence.loadDocument(docId);
        if (!payload) {
            console.warn('[Salsa loadDocument] No OPFS data found for docId:', docId);
            return { success: false, layers: [] };
        }
        console.log('[Salsa loadDocument] OPFS payload found. Manifest layers:', payload.manifest.layers.length, 'Pixel buffers:', payload.layers.length);

        try {
            await this.restoreDocumentState(payload);
            this.currentDocId = docId;
            this.currentDocName = payload.manifest.name;
            const layers = this.getRasterLayers();
            console.log('[Salsa loadDocument] Restore complete. getRasterLayers() returned:', layers.length, 'layers:', layers.map(l => l.name));
            return {
                success: true,
                layers,
            };
        } catch (e) {
            console.error('[ShapeManager] Failed to restore document:', e);
            return { success: false, layers: [] };
        }
    }

    /**
     * List all saved documents (for a gallery / file picker UI).
     * Returns metadata only — no pixel data is loaded.
     */
    public async listSavedDocuments(): Promise<DocumentInfo[]> {
        if (!this.persistence) {
            this.persistence = new DocumentPersistence();
            this.persistence.setStateProvider(() => this.gatherDocumentState());
        }
        return this.persistence.listDocuments();
    }

    /**
     * Delete a saved document from storage.
     */
    public async deleteSavedDocument(docId: string): Promise<boolean> {
        return this.persistence?.deleteDocument(docId) ?? false;
    }

    /** Set the document name (displayed in the title bar / gallery). */
    public setDocumentName(name: string): void {
        this.currentDocName = name;
    }

    /** Get the current document name. */
    public getDocumentName(): string {
        return this.currentDocName;
    }

    /** Get the current document id. */
    public getDocumentId(): string {
        return this.currentDocId;
    }

    /**
     * Notify the persistence engine that a stroke just ended.
     * This triggers a debounced auto-save. Call this from the
     * brush engine's stroke-end callback.
     */
    public notifyStrokeEnd(): void {
        this.persistence?.notifyStrokeEnd();
    }

    /**
     * Gather the full document state for serialization.
     * This is called by the persistence engine's state provider.
     * @internal
     */
    private async gatherDocumentState(): Promise<DocumentSavePayload> {
        const canvasSize = this.rasterLayerManager?.getCanvasSize() ?? { w: 1920, h: 1080 };
        const layerMeta = this.rasterLayerManager?.getLayerMetadata() ?? [];

        // Gather animation state
        let animationState = null;
        const timeline = this.rasterLayerManager?.getTimeline();
        if (timeline && this.rasterLayerManager?.isAnimationEnabled()) {
            const ts = timeline.getState();
            const onion = timeline.getOnionSkinConfig();
            const cels: Record<string, Array<{ celId: string; startFrame: number; duration: number; celType: 'key' | 'inbetween' }>> = {};
            for (const layer of layerMeta) {
                if (layer.animationType === 'animated') {
                    const layerCels = this.rasterLayerManager!.getCels(layer.id);
                    cels[layer.id] = layerCels.map(c => ({
                        celId: c.id,
                        startFrame: c.startFrame,
                        duration: c.duration,
                        celType: c.celType,
                    }));
                }
            }
            animationState = {
                fps: ts.fps,
                frameCount: ts.frameCount,
                loopMode: ts.loopMode,
                playRangeStart: ts.playRangeStart,
                playRangeEnd: ts.playRangeEnd,
                onionSkin: {
                    enabled: onion.enabled,
                    framesBefore: onion.framesBefore,
                    framesAfter: onion.framesAfter,
                    opacity: onion.opacity,
                    tintBefore: onion.tintBefore as [number, number, number],
                    tintAfter: onion.tintAfter as [number, number, number],
                },
                cels,
            };
        }

        const manifest: DocumentManifest = {
            version: 2,
            docId: this.currentDocId,
            name: this.currentDocName,
            createdAt: new Date().toISOString(),
            savedAt: new Date().toISOString(),
            canvasWidth: canvasSize.w,
            canvasHeight: canvasSize.h,
            layers: layerMeta.map(l => ({
                id: l.id,
                name: l.name,
                visible: l.visible,
                locked: l.locked,
                opacity: l.opacity,
                blendMode: l.blendMode,
                clipped: l.clipped,
                lockTransparency: l.lockTransparency,
                celIds: l.celIds,
                animationType: l.animationType,
                ditherConfig: l.ditherConfig,
                frameLinkAnimation: l.frameLinkAnimation,
            })),
            animation: animationState,
            globalDitherConfig: this.getDitherConfig(),
        };

        // Read pixel data
        const layers = await this.rasterLayerManager?.exportLayerPixels() ?? [];
        const cels = await this.rasterLayerManager?.exportCelPixels() ?? [];

        return {
            manifest,
            sceneGraphJSON: this.getSceneGraphJSON(),
            brushPresetsJSON: this.exportAllBrushPresets(),
            layers,
            cels,
        };
    }

    /**
     * Restore a full document state from a persistence payload.
     * @internal
     */
    private async restoreDocumentState(payload: DocumentSavePayload): Promise<void> {
        // Suppress intermediate scene-graph-changed events during restore.
        // We'll emit a single event at the end when everything is ready.
        this._isRestoring = true;

        try {
            // 1. Restore scene graph (vector shapes)
            if (payload.sceneGraphJSON) {
                await this.setSceneGraphJSON(payload.sceneGraphJSON);
            }

            // 2. Restore brush presets
            if (payload.brushPresetsJSON) {
                try {
                    this.importBrushPresets(payload.brushPresetsJSON);
                } catch (e) {
                    console.warn('[ShapeManager] Failed to restore brush presets:', e);
                }
            }

        // 3. Recreate raster layers from manifest, then upload pixel data
        if (this.rasterLayerManager && payload.manifest.layers.length > 0) {
            // Resize raster textures to match the saved canvas dimensions
            // before creating layers or uploading pixel data.
            const savedW = payload.manifest.canvasWidth;
            const savedH = payload.manifest.canvasHeight;
            if (savedW && savedH) {
                this.rasterLayerManager.setSize(savedW, savedH);
            }

            // Clear existing layers (e.g. the default "Background" layer)
            console.log('[Salsa restore] Clearing layers. Before clear:', this.rasterLayerManager.getLayers().length);
            this.rasterLayerManager.clearAllLayers();
            console.log('[Salsa restore] After clear:', this.rasterLayerManager.getLayers().length);

            // Recreate each layer with its saved ID and metadata
            for (const entry of payload.manifest.layers) {
                console.log('[Salsa restore] Adding layer:', entry.id, entry.name);
                this.rasterLayerManager.addLayerWithId(entry.id, entry.name, {
                    visible: entry.visible,
                    locked: entry.locked,
                    blendMode: entry.blendMode as any,
                    opacity: entry.opacity,
                    clipped: entry.clipped,
                    lockTransparency: entry.lockTransparency,
                    ditherConfig: entry.ditherConfig,
                    frameLinkAnimation: entry.frameLinkAnimation,
                });
            }
            console.log('[Salsa restore] After adding all layers:', this.rasterLayerManager.getLayers().length, this.rasterLayerManager.getLayers().map(l => l.name));

            // Upload pixel data to the recreated layers
            for (const layerData of payload.layers) {
                const ok = this.rasterLayerManager.uploadPixelsToLayer(layerData.id, layerData.pixelData);
                console.log('[Salsa restore] Upload pixels for', layerData.id, '→', ok ? 'OK' : 'FAILED (layer not found)');
            }

            // Select the first layer
            if (payload.manifest.layers.length > 0) {
                this.rasterLayerManager.selectLayer(payload.manifest.layers[0].id);
            }
        } else {
            console.warn('[Salsa restore] Skipped layer restore. rasterLayerManager:', !!this.rasterLayerManager, 'manifest layers:', payload.manifest.layers.length);
        }

        // 4. Restore animation state
        if (payload.manifest.animation && this.rasterLayerManager) {
            const anim = payload.manifest.animation;
            this.setAnimationEnabled(true);
            this.setFps(anim.fps);
            this.setFrameCount(anim.frameCount);
            this.setLoopMode(anim.loopMode as any);
            this.setOnionSkin(anim.onionSkin);

            // Mark layers as animated and restore cel metadata with exact IDs/timing
            for (const layerEntry of payload.manifest.layers) {
                if (layerEntry.animationType === 'animated') {
                    this.setLayerAnimated(layerEntry.id, true);

                    // Restore cels with saved IDs and timing
                    const celMetas = anim.cels?.[layerEntry.id];
                    if (celMetas && celMetas.length > 0) {
                        this.rasterLayerManager.restoreLayerCels(layerEntry.id, celMetas);
                    }
                }
            }

            // Upload cel pixel data
            if (payload.cels && payload.cels.length > 0) {
                for (const celData of payload.cels) {
                    // Find which layer owns this cel
                    for (const [layerId, celArr] of Object.entries(anim.cels)) {
                        if (celArr.some(c => c.celId === celData.celId)) {
                            const ok = this.rasterLayerManager.uploadPixelsToCel(layerId, celData.celId, celData.pixelData);
                            console.log('[Salsa restore] Upload cel pixels', celData.celId, '→', ok ? 'OK' : 'FAILED');
                            break;
                        }
                    }
                }
            }

            // Restore play range (must happen AFTER setFrameCount)
            if (anim.playRangeStart != null && anim.playRangeEnd != null) {
                this.rasterLayerManager.getTimeline().setPlayRange(anim.playRangeStart, anim.playRangeEnd);
            } else {
                // Default: play entire timeline
                this.rasterLayerManager.getTimeline().setPlayRange(1, anim.frameCount);
            }

            // Force texture swap for animated layers now that all cels are uploaded.
            // Without this, animated layers show blank textures until the first frame change.
            this.rasterLayerManager.forceFrameSync();
        }

        // 5. Restore global dither config
        if (payload.manifest.globalDitherConfig) {
            this.setDitherConfig(payload.manifest.globalDitherConfig);
        }

        } finally {
            this._isRestoring = false;
        }

        // Sync the renderer's animation frame counter so procedural effects
        // (frame link animations) render correctly on the first frame.
        this.syncRendererFrame();

        // Single authoritative event — all layers, scene graph, and animation
        // state are fully restored at this point.
        this.interactionService.onSceneGraphChanged.emit();
        this.scheduleRender();
    }
}

// Export only the singleton getter function
export default ShapeManager;
export type { DitherConfig, DitherAlgorithm };
export type { DualBrushSettings, DualBrushBlendOp, ColorJitter, WetEdgeSettings, StrokeTextureSettings };
export type { StabilizationMethod, BrushStabilization };
export type { FloodFillOptions } from '../renderer/raster/tools/flood-fill-engine';
export type { AutoSaveConfig, DocumentInfo, DocumentManifest } from './persistence/document-persistence';
export type { SpeechBalloonOptions, TailSide, BalloonStyle } from '../scene-graph/shapes/speech-balloon';
export type { PanelLayoutOptions, PanelTemplate, PanelDef } from '../scene-graph/shapes/panel-layout';
export type { TextEffectType, TextEffectConfig, TextEffectParams, TextCaptureConfig, ChromaticAberrationParams, GlowParams, WaveParams, GlitchParams, OutlineParams } from '../renderer/raster/effects/text-effect-engine';
export { defaultChromaticAberration, defaultGlow, defaultWave, defaultGlitch, defaultOutline } from '../renderer/raster/effects/text-effect-engine';
export type { OnionSkinConfig, LoopMode, PlaybackState, TimelineState } from '../animation';
export type { FrameLinkAnimation, FrameLinkAnimationType, FrameLinkLoopMode } from '../animation';
export { DEFAULT_FRAME_LINK_ANIMATION } from '../animation';