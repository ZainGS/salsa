/**
 * TODO: Implement APIs via Feature Managers to expose different core systems 
 * ShapeManager handles shape CRUD and registry-level updates.
 * FlowchartingManager handles smart arrows, node linking, and snapping points. 
 * CollaborationManager handles presence, pointer syncing, WebSocket relays, locks, etc.
 * AIStreamManager manages streaming AI inference into buffers/registries.
 * SDFTextManager (or FontManager) handles SDF texture atlases, typesetting, caret, line wrapping, etc.
 * Uses the delegate-manager pattern — domain logic lives in managers under src/services/managers/.
 */

import { LayerManager } from './layer-manager';
import { PackagingManager, type PackagingHost } from '../packaging/packaging-manager';
import { PACKAGING_ENABLED } from './persistence/shell-storage';
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
import { WebGPURenderer, type PlacementResizeHandle, type PlacementHandleHit } from "../renderer/core/webgpu-renderer";
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
import { DualBrushSettings, DualBrushBlendOp, ColorJitter, WetEdgeSettings, StrokeTextureSettings, StabilizationMethod, BrushStabilization, BleedSettings, SmudgeSettings } from '../renderer/raster/brushes/brush-preset';
import { FloodFillEngine, FloodFillOptions } from '../renderer/raster/tools/flood-fill-engine';
import { DocumentPersistence, DocumentManifest, DocumentSavePayload, DocumentInfo, AutoSaveConfig, isOPFSAvailable } from './persistence/document-persistence';
import { PixelFormat, isFormatSupported } from './persistence/pixel-codec';
import { packProject as _packProject, unpackProject as _unpackProject } from './persistence/project-package';
import { mat4, vec4 } from 'gl-matrix';
import { Mesh3D, Mesh3DConfig, MeshPrimitive } from '../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D, InstanceOverride } from '../scene-graph/shapes/array-group-3d';
import { Modifier } from '../scene-graph/shapes/modifiers';
import { ParticleEmitter3D } from '../scene-graph/shapes/particle-emitter-3d';
import { Camera3D, Camera3DConfig } from '../renderer/3d/camera-3d';
import { OrbitController, OrbitControllerConfig } from '../renderer/3d/orbit-controller';
import { Renderer3D, PS1Config, DEFAULT_PS1_CONFIG, WOBBLE_PRESET, POCKET_PRESET, FogConfig, DEFAULT_FOG_CONFIG, PostProcessConfig } from '../renderer/3d/renderer-3d';
import { Material3D } from '../renderer/3d/material-3d';
import { MeshGeometry } from '../renderer/3d/mesh-generators';

// ── Domain-specific delegate managers ────────────────────────────────
import { RasterManager } from './managers/raster-manager';
import { TextManager } from './managers/text-manager';
import { AnimationManager } from './managers/animation-manager';
import { Scene3DManager } from './managers/scene3d-manager';
import { WorldManager } from './managers/world-manager';
import { BuildingManager } from './managers/building-manager';
import { BlockManager } from './managers/block-manager';
import type { BuildingParams, BuildingMeta } from '../world/building';
import { FoliageManager } from './managers/foliage-manager';
import type { FoliageParams, FoliageMeta } from '../world/foliage';
import type { FaceBlinkConfig, LegIdleMode } from './managers/scene3d-manager';
import type { EyeParams } from './managers/eye-generator';
import type { HairParams } from './managers/hair-generator';
import type { ClothingParams } from './managers/clothing-generator';
import type { AttachmentType, AttachmentParams, AttachmentPlacement } from './managers/attachment-generator';
import type { SnapVizData } from './managers/transform-controller-3d';
import type { Submesh3D } from '../scene-graph/shapes/mesh-3d';
import { DrawingToolManager } from './managers/drawing-tool-manager';
import { MeshPaintManager } from './managers/mesh-paint-manager';
import { MeshEditManager } from './managers/mesh-edit-manager';
import type { UVIsland } from '../scene-graph/shapes/edit-mesh';
import { UVEditorSession, UVCanvasRenderer } from './managers/uv-canvas-renderer';
import type { UVSelectionMode } from './managers/uv-canvas-renderer';
import { UVEditManager } from './managers/uv-edit-manager';
import { UVPaintController, UVBrushSettings } from './managers/uv-paint-controller';
import { RasterTextureManager } from '../renderer/raster/raster-texture-manager';
import { LiveTextureMode } from './managers/live-texture-mode';
import { ShellUIManager } from './managers/shell-ui-manager';
import { MeshEditPointerController, type MeshEditSelectionMode } from './managers/mesh-edit-pointer-controller';
import { PersistenceManager as PersistenceManagerDelegate } from './managers/persistence-manager';
import type { ManagerContext } from './managers/manager-context';
import { EphemeraService } from './ephemera/ephemera-service';
import type { EphemeraElement, EphemeraElementSheet, IEphemeraGenerator, EphemeraCategory, EphemeraPlacement } from './ephemera/ephemera-types';

class ShapeManager {
    private shapeFactory: ShapeFactory;
    private sceneGraph!: SceneGraph;
    private static instance: ShapeManager; // Singleton instance

    // ── Domain delegate managers (Frogmarks: prefer these over legacy methods) ──
    public raster!: RasterManager;
    public text!: TextManager;
    public animation!: AnimationManager;
    public scene3d!: Scene3DManager;
    /** Procedural world generation (`src/world`) — layout / biome / streets. Bridged to the scene. */
    public world!: WorldManager;
    public buildings!: BuildingManager;
    public blocks!: BlockManager;
    public foliage!: FoliageManager;
    public drawing!: DrawingToolManager;
    public persist!: PersistenceManagerDelegate;
    public meshPaint!: MeshPaintManager;
    public meshEdit!: MeshEditManager;
    public shell!: ShellUIManager;
    private _meshEditPointerController!: MeshEditPointerController;
    private readonly _uvSessions = new Map<string, UVEditorSession>();
    private _uvEdit!: UVEditManager;
    private _liveTexture!: LiveTextureMode;
    private readonly _uvPaintCanvases = new Map<string, HTMLCanvasElement>();
    /** Per-mesh GPU paint texture (paintable + sampleable) backing the mesh diffuse. */
    private readonly _uvPaintTextures = new Map<string, RasterTextureManager>();
    /** Serializes garment paint RE-TINTs per rig key (so a fast colour drag can't desync the moving
     *  background colour — each re-tint applies in order, after the previous one lands). */
    private readonly _retintChain = new Map<string, Promise<unknown>>();
    private _uvPaintController?: UVPaintController;
    /** How the eraser behaves on a GARMENT: 'burn' = paint white with the brush's grain/soft edge (the scorched
     *  border) · 'clean' = a sharp grainless white dab · 'cutout' = a real alpha HOLE (distressing/rips). */
    private _garmentEraseStyle: 'burn' | 'clean' | 'cutout' = 'burn';
    /** Mesh whose `doubleSided` we forced off during paint, + its prior value to restore. */
    private _uvPaintDoubleSided: { meshId: string; prev: boolean | undefined } | null = null;
    /** Mesh whose UV editor session paint mode OPENED implicitly (no pre-existing session) —
     *  so exit closes it again. Null if a UV editor was already open before painting (leave it). */
    private _uvPaintOpenedEditor: string | null = null;

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
    /** Canonical document pixel size set via setDocumentSize(). null = infinite canvas. */
    private _documentSizePx: { w: number; h: number } | null = null;
    private floodFillEngine?: FloodFillEngine;
    private textEffectEngine?: TextEffectEngine;
    private persistence?: DocumentPersistence;
    private currentDocId: string = 'default';
    private currentDocName: string = 'Untitled';
    private _isRestoring = false;
    private _ephemera: EphemeraService = new EphemeraService();

    // ── Ephemera SVG overlay (live non-destructive placement rendering) ──
    private _ephemeraOverlayCtx: CanvasRenderingContext2D | null = null;
    private _ephemeraOverlayCache = new Map<string, { svg: string; img: HTMLImageElement; loaded: boolean }>();
    private _ephemeraOverlayUnsub: (() => void) | null = null;

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
            // In a 3D scene, drop the 2D-artboard viewport clamps (min-zoom + pan bounds) — see InteractionService.
            // Lazy predicate so it always reflects the current document (rasterLayerManager is wired later in ctor).
            this.interactionService.setViewport3DPredicate(() => this.hasRaster3DScene());
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
                // Register split callback for 3D divider (BG/FG compositing)
                this.rasterLayerManager.setCompositionSplitCallback((bg, fg) => {
                    try {
                        this.webgpuRenderer.setRasterCompositionListSplit(bg, fg);
                    } catch(e) { /* ignore */ }
                });
                this.webgpuRenderer.setRasterLayerManager(this.rasterLayerManager);
                // Create selection service (needs renderer + interaction service)
                this.rasterSelectionService = new RasterSelectionService(this.interactionService, this.webgpuRenderer);
                this.webgpuRenderer.setRasterSelectionService(this.rasterSelectionService);
                this.rasterMoveService = new RasterMoveService(this.interactionService, this.webgpuRenderer);
                this.webgpuRenderer.setRasterMoveService(this.rasterMoveService);
                // If the host boot path didn't inject a drawing service, create one
                // here so the brush/pen tool works regardless of wiring (mirrors the
                // selection/move services above). Without this, enableRasterTool()'s
                // `this.rasterDrawingService?.enable()` silently no-ops and the pen
                // appears dead while selection/mesh editing still work.
                if (!this.rasterDrawingService) {
                    this.rasterDrawingService = new RasterDrawingService(this.interactionService, this.webgpuRenderer, this.sceneGraph);
                    this.webgpuRenderer.setRasterDrawingService(this.rasterDrawingService);
                }
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

            // Initialize domain-specific delegate managers
            this.initDelegates();
    }

    /** Wire up all domain delegate managers with the shared context and services. */
    private initDelegates(): void {
        const ctx: ManagerContext = {
            sceneGraph: this.sceneGraph,
            shapeFactory: this.shapeFactory,
            interactionService: this.interactionService,
            webgpuRenderer: this.webgpuRenderer,
            layerManager: this.layerManager,
            rasterLayerManager: this.rasterLayerManager,
            scheduleRender: () => this.scheduleRender(),
            beginInteractive: () => this.beginInteractive(),
            endInteractive: () => this.endInteractive(),
            emitSceneGraphChanged: () => this.emitSceneGraphChanged(),
            sceneStructureVersion: () => this._sceneStructureVersion,
            setSelectedNode: (nodeId: string) => this.setSelectedNode(nodeId),
        };

        this.raster = new RasterManager(ctx);
        if (this.rasterDrawingService) this.raster.setDrawingService(this.rasterDrawingService);
        if (this.rasterSelectionService) this.raster.setSelectionService(this.rasterSelectionService);
        if (this.rasterMoveService) this.raster.setMoveService(this.rasterMoveService);

        this.text = new TextManager(ctx);
        this.text.setSdfTextDrawingService(this.sdfTextDrawingService);
        this.text.setTextDrawingService(this.textDrawingService);

        this.animation = new AnimationManager(ctx);
        this.scene3d = new Scene3DManager(ctx);
        this.world = new WorldManager(this.scene3d);
        this.buildings = new BuildingManager(this.scene3d);   // Building Creator (constructed AFTER world so its transform-sync registers second)
        this.blocks = new BlockManager(this.scene3d);         // Neighborhood Blocks (many buildings + cross-building instancing)
        this.foliage = new FoliageManager(this.scene3d);      // Foliage Creator (freestanding foliage)

        // Shell UI — WebGPU dashboard home screen. Its Illustrations
        // dashboard is a view over existing documents, so wire a document
        // source that bridges to DocumentPersistence (project id === docId).
        this.shell = new ShellUIManager(ctx);
        this.shell.setDocumentSource({
            listProjects: async () => {
                const docs = await this.listSavedDocuments();
                return docs.map(d => ({
                    id: d.docId,
                    name: d.name,
                    lastModified: Date.parse(d.savedAt) || Date.now(),
                    thumbnailDataUrl: d.thumbnail,
                }));
            },
            deleteProject: async (id) => { await this.deleteSavedDocument(id); },
            renameProject: async (id, name) => { await this.renameSavedDocument(id, name); },
            newProjectId: () => crypto.randomUUID(),
        });
        void this.shell.load();

        // Raster timeline play/pause drives the 3D AnimationPlayer when both are active
        this.animation.set3DPlaybackSync((playing) => {
            if (playing) this.scene3d.startSyncedPlayback();
            else this.scene3d.stopSyncedPlayback();
        });

        this.meshPaint = new MeshPaintManager(ctx);
        this.meshEdit = new MeshEditManager(ctx, (cmd) => this.scene3d.pushCommand3D(cmd));
        this._uvEdit  = new UVEditManager(ctx, (cmd) => this.scene3d.pushCommand3D(cmd), (id) => this._uvSessions.get(id) ?? null);
        this._liveTexture = new LiveTextureMode(ctx.sceneGraph, () => ctx.rasterLayerManager ?? null);
        this._meshEditPointerController = new MeshEditPointerController(
            this.scene3d,
            this.meshEdit,
            (cmd) => this.scene3d.pushCommand3D(cmd),
            () => ctx.scheduleRender(),
        );
        // Suppress the transform gizmo's object-selection click while mesh edit
        // OR UV edit is active, so pointer controllers can handle picks uncontested.
        this.scene3d.setMeshEditModeChecker(
            () => this.meshEdit.isEditing || this._uvSessions.size > 0,
        );

        // Supply live edit state to the mesh edit overlay renderer each frame.
        // Handles two independent modes:
        //   • Full mesh-edit mode  → shows selection + seams + UV hover
        //   • UV-only mode         → shows seams + UV hover, no selection overlay
        this.scene3d.setMeshEditDataProvider(() => {
            // ── Full mesh-edit mode ───────────────────────────────────────────
            if (this.meshEdit.isEditing) {
                const meshId = this.meshEdit.activeMeshId;
                if (!meshId) return null;
                const mesh = this.scene3d.getMesh(meshId);
                if (!mesh) return null;

                let hoveredFaces: Set<number> | undefined;
                const uvSession = this._uvSessions.get(meshId);
                if (uvSession?.hoveredFaceIndex != null) {
                    hoveredFaces = this._buildUVHoveredFaces(uvSession);
                }
                return {
                    mesh,
                    selection: this.meshEdit.getSelection(meshId),
                    mode: this._meshEditPointerController.mode,
                    hoveredFaces,
                    // Honour the toggle if a UV editor is open alongside, else always show
                    // edges (you need them to select verts/edges while mesh-editing).
                    showWireframe: uvSession?.showWireframe ?? true,
                };
            }

            // ── UV-only mode (UV editor open, full mesh-edit not active) ──────
            // Renders seam edges and UV hover tint without any selection overlay.
            for (const [meshId, uvSession] of this._uvSessions) {
                const mesh = this.scene3d.getMesh(meshId);
                if (!mesh?.editMesh) continue;
                const hoveredFaces = uvSession.hoveredFaceIndex != null
                    ? this._buildUVHoveredFaces(uvSession)
                    : undefined;
                return {
                    mesh, selection: null, mode: 'face' as const, hoveredFaces,
                    showWireframe: uvSession.showWireframe,   // the "Wireframe" toggle
                };
            }

            return null;
        });

        this.drawing = new DrawingToolManager(ctx);
        this.drawing.setLineDrawingService(this.lineDrawingService);
        this.drawing.setScribbleDrawingService(this.scribbleDrawingService);
        this.drawing.setTextDrawingService(this.textDrawingService);
        this.drawing.setEraserService(this.eraserService);
        this.drawing.setHighlightDrawingService(this.highlightDrawingService);
        this.drawing.setPatternDrawingService(this.patternDrawingService);
        this.drawing.setStampDrawingService(this.stampDrawingService);
        this.drawing.setSectionDrawingService(this.sectionDrawingService);
        this.drawing.setPolygonDrawingService(this.polygonDrawingService);

        this.persist = new PersistenceManagerDelegate(ctx);
        this.persist.setCallbacks({
            gatherDocumentState: () => this.gatherDocumentState(),
            restoreDocumentState: (p) => this.restoreDocumentState(p),
            getSceneGraphJSON: () => this.getSceneGraphJSON(),
            exportAllBrushPresets: () => this.exportAllBrushPresets(),
            importBrushPresets: (j) => this.importBrushPresets(j),
            getDitherConfig: () => this.getDitherConfig(),
            setDitherConfig: (c) => this.setDitherConfig(c),
            getRasterLayers: () => this.getRasterLayers(),
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
            // DEV console hooks (like salsaWorld). `salsaDebug()` → one-shot readout for "why is nothing showing":
            // scene3DVisible, mesh count, packaging boxes + fold, camera. `sm` → the singleton for ad-hoc calls.
            if (typeof window !== 'undefined') {
                const inst = ShapeManager.instance;
                (window as unknown as Record<string, unknown>).sm = inst;
                (window as unknown as Record<string, unknown>).salsaDebug = () => {
                    const meshes = inst.scene3d.getAllMeshes();
                    const cam = inst.getCamera3D();
                    const boxes = inst.packaging?.getAll().map(b => ({ id: b.id, meshId: b.meshId, fold: b.foldAmount, layer: b.dielineLayerId })) ?? [];
                    return {
                        scene3DVisible: inst.scene3DVisible,          // must be true to see any 3D
                        meshCount: meshes.length,                    // 0 = nothing 3D in the scene at all
                        packagingBoxes: boxes,                       // [] = create()/enterEditor never ran
                        cameraTarget: [cam.target[0], cam.target[1], cam.target[2]].map(n => +n.toFixed(2)),
                        cameraPos: [cam.position[0], cam.position[1], cam.position[2]].map(n => +n.toFixed(2)),
                        // Camera/view state — the usual suspects when a mesh exists but doesn't show:
                        camMode: cam.mode, orthoSize: +cam.orthoSize.toFixed(3),
                        near: +cam.near.toFixed(4), far: +cam.far.toFixed(1),
                        orthoOffset: [+(cam.orthoOffsetX ?? 0).toFixed(3), +(cam.orthoOffsetY ?? 0).toFixed(3)],
                        // First mesh's WORLD bounds (via the real render matrix) — is it where the camera looks?
                        firstMeshWorldBounds: (() => {
                            const m = meshes[0];
                            if (!m?.geometry) return null;
                            const w = m.localMatrix as Float32Array;
                            const v = m.geometry.vertices;
                            let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
                            for (let k = 0; k < v.length / 12; k++) {
                                const x = v[k * 12], y = v[k * 12 + 1], z = v[k * 12 + 2];
                                const wx = w[0] * x + w[4] * y + w[8] * z + w[12];
                                const wy = w[1] * x + w[5] * y + w[9] * z + w[13];
                                const wz = w[2] * x + w[6] * y + w[10] * z + w[14];
                                x0 = Math.min(x0, wx); x1 = Math.max(x1, wx);
                                y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
                                z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
                            }
                            return { min: [x0, y0, z0].map(n => +n.toFixed(3)), max: [x1, y1, z1].map(n => +n.toFixed(3)) };
                        })(),
                        drawCalls: inst.scene3d.getFrameStats3D?.()?.drawCalls ?? '?',
                    };
                };
                // Brute-force known-good view: dead top-down ortho over the packaging panels, orthoSize from
                // their ACTUAL world bounds. If this shows the box, the remaining bug is enterGroupOrbit's
                // numbers; if even this doesn't, the panels aren't reaching the render list.
                (window as unknown as Record<string, unknown>).salsaPkgTopView = () => {
                    const all = inst.scene3d.getAllMeshes();
                    if (!all.length) return 'no meshes';
                    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
                    for (const m of all) {
                        if (!m.geometry) continue;
                        const w = m.localMatrix as Float32Array;
                        const v = m.geometry.vertices;
                        for (let k = 0; k < v.length / 12; k++) {
                            const x = v[k * 12], y = v[k * 12 + 1], z = v[k * 12 + 2];
                            const wx = w[0] * x + w[4] * y + w[8] * z + w[12];
                            const wy = w[1] * x + w[5] * y + w[9] * z + w[13];
                            const wz = w[2] * x + w[6] * y + w[10] * z + w[14];
                            x0 = Math.min(x0, wx); x1 = Math.max(x1, wx);
                            y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
                            z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
                        }
                    }
                    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
                    const ext = Math.max(x1 - x0, z1 - z0, y1 - y0, 0.1);
                    const cam = inst.getCamera3D();
                    cam.orthoOffsetX = 0; cam.orthoOffsetY = 0;
                    cam.orthoSize = ext * 0.75;
                    cam.near = 0.001; cam.far = Math.max(100, ext * 10);
                    cam.lookAt(cx, cy + ext * 2, cz + 0.001, cx, cy, cz);   // top-down (tiny Z offset avoids up-vector degeneracy)
                    inst.scene3d.claimCameraForOrbit3D?.([cx, cy, cz]);
                    inst.scheduleRender();
                    return { bounds: { min: [x0, y0, z0], max: [x1, y1, z1] }, orthoSize: cam.orthoSize };
                };
                // DIRECT fold test — bypasses Frogmarks. Run `salsaPkgFold(1)` in the console: if the box folds,
                // Salsa's fold works and the host's Fold button just isn't calling setFoldAmount. If it does NOT
                // fold, the bug is Salsa-side. Same for `salsaPkgDims({width,height,depth,bleed})`.
                (window as unknown as Record<string, unknown>).salsaPkgFold = (amount: number) => {
                    const b = inst.packaging?.getAll()[0];
                    if (!b) return 'no packaging box';
                    inst.packaging!.setFoldAmount(b.id, amount);
                    return `set fold ${amount} on ${b.id}`;
                };
                (window as unknown as Record<string, unknown>).salsaPkgDims = (p: { width?: number; height?: number; depth?: number; bleed?: number }) => {
                    const b = inst.packaging?.getAll()[0];
                    if (!b) return 'no packaging box';
                    inst.packaging!.setDimensions(b.id, { ...b.params, ...p });
                    return `set dims on ${b.id}`;
                };
                // PACKAGE CREATOR MODE — verify in ANY illustration doc with zero Frogmarks wiring:
                // `salsaPkgCreator()` (or `salsaPkgCreator({width:120,height:80,depth:50})`) enters the
                // mode (box + white Dieline layer + orbit + surface paint) and logs the creator state;
                // `salsaPkgCreatorExit()` leaves it (box + artwork stay in the scene). Idempotent —
                // re-running reuses the same box and Dieline layer.
                (window as unknown as Record<string, unknown>).salsaPkgCreator = (params?: { width: number; height: number; depth: number; bleed?: number }) => {
                    const pkg = inst.packaging;
                    if (!pkg) return 'packaging disabled (PACKAGING_ENABLED off)';
                    pkg.enterCreatorMode(params ? { params } : undefined);
                    const st = pkg.getCreatorState();
                    console.log('[salsaPkgCreator]', st);
                    return st;
                };
                (window as unknown as Record<string, unknown>).salsaPkgCreatorExit = () => {
                    const pkg = inst.packaging;
                    if (!pkg) return 'packaging disabled (PACKAGING_ENABLED off)';
                    pkg.exitCreatorMode();
                    return pkg.getCreatorState();
                };
            }
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

    // ── Layer Folders ───────────────────────────────────────────────

    /** Create a folder (organizational group) in the raster layer stack. */
    public addRasterFolder(name = 'Group') {
        const f = this.rasterLayerManager?.addFolder(name);
        this.emitSceneGraphChanged();
        return f;
    }

    /** Set whether a folder is collapsed in the UI. */
    public setRasterFolderCollapsed(folderId: string, collapsed: boolean) {
        this.rasterLayerManager?.setFolderCollapsed(folderId, collapsed);
    }

    /** Move a layer into (or out of) a folder. Pass null parentId to move to root. */
    public setRasterLayerParent(layerId: string, parentId: string | null) {
        this.rasterLayerManager?.setLayerParent(layerId, parentId);
        this.emitSceneGraphChanged();
    }

    /** Delete a folder. Children are promoted to the folder's parent. */
    public deleteRasterFolder(folderId: string) {
        const ok = this.rasterLayerManager?.deleteFolder(folderId) ?? false;
        if (ok) this.emitSceneGraphChanged();
        return ok;
    }

    // ── 3D Scene ─────────────────────────────────────────────────────

    /**
     * Insert a 3D scene into the raster layer stack.
     * Layers below render as background (behind 3D meshes).
     * Layers above render as foreground (on top of 3D meshes).
     */
    public addRaster3DScene(name = '3D Scene') {
        return this.rasterLayerManager?.add3DScene(name) ?? '';
    }

    /** Remove the 3D scene. All layers become background (original behavior). */
    public removeRaster3DScene() {
        return this.rasterLayerManager?.remove3DScene() ?? false;
    }

    /** Get the 3D scene entry, if it exists. */
    public getRaster3DScene() {
        return this.rasterLayerManager?.get3DScene() ?? null;
    }

    /** Check whether a 3D scene exists in the layer stack. */
    public hasRaster3DScene() {
        return this.rasterLayerManager?.has3DScene() ?? false;
    }

    // Legacy aliases
    public addRaster3DDivider(name = '3D Scene') { return this.addRaster3DScene(name); }
    public removeRaster3DDivider() { return this.removeRaster3DScene(); }
    public getRaster3DDivider() { return this.getRaster3DScene(); }
    public hasRaster3DDivider() { return this.hasRaster3DScene(); }

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

    /** Configure paint bleed/diffusion on a preset (watercolor, gouache spread). */
    public setBrushBleed(presetId: string, settings: BleedSettings): boolean {
        return this.updateBrushPreset(presetId, { bleed: settings });
    }

    /** Configure smudge (finger-smear) on a preset. Picks up canvas color and mixes it into the stroke. */
    public setBrushSmudge(presetId: string, settings: SmudgeSettings): boolean {
        return this.updateBrushPreset(presetId, { smudge: settings });
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

    /**
     * Duplicate a layer. The copy is inserted above the source and selected.
     * Returns the new layer id, or null if the layer doesn't exist.
     */
    public async duplicateLayer(layerId: string): Promise<string | null> {
        const newId = await this.rasterLayerManager?.duplicateLayer(layerId) ?? null;
        if (newId) this.emitSceneGraphChanged();
        return newId;
    }

    /**
     * Merge a layer down into the nearest paintable layer below it.
     * Returns the surviving layer id, or null on failure.
     */
    public async mergeLayerDown(layerId: string): Promise<string | null> {
        const survivingId = await this.rasterLayerManager?.mergeLayerDown(layerId) ?? null;
        if (survivingId) this.emitSceneGraphChanged();
        return survivingId;
    }

    /**
     * Resize the document canvas, preserving existing layer pixel content.
     *
     * anchor = 'top-left' (default) — content stays at the top-left corner
     * anchor = 'center'             — content is centred in the new canvas
     *
     * Also updates the artboard bounds and re-fits the viewport.
     */
    public async resizeDocument(
        newW: number,
        newH: number,
        anchor: 'center' | 'top-left' = 'top-left',
    ): Promise<void> {
        if (!this.rasterLayerManager) return;
        await this.rasterLayerManager.resizeCanvas(newW, newH, anchor);
        // Re-establish artboard bounds at the new size
        this._documentSizePx = { w: newW, h: newH };
        if (this.webgpuRenderer) {
            const worldH = 2;
            const worldW = 2 * (newW / newH);
            this.webgpuRenderer.setExplicitDocumentPixelSize({ w: newW, h: newH });
            this.webgpuRenderer.setIllustrationBounds(worldW, worldH);
        }
        this.fitArtboard();
        this.scheduleRender();
    }

    /**
     * Add a reference image overlay layer from a File or Blob.
     * The image is letterbox-fitted to the document size, locked, and set to 50% opacity.
     * Returns the new layer id, or null if loading fails.
     */
    public async addReferenceImageLayer(
        name: string,
        source: File | Blob,
    ): Promise<string | null> {
        if (!this.rasterLayerManager) return null;
        let bitmap: ImageBitmap;
        try {
            bitmap = await createImageBitmap(source);
        } catch {
            return null;
        }
        const id = await this.rasterLayerManager.addReferenceImageLayer(name, bitmap);
        bitmap.close();
        this.emitSceneGraphChanged();
        return id;
    }

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

    private _sceneGraphBatchDepth = 0;
    private _sceneGraphBatchPending = false;

    /** Defer scene-graph-changed events until the matching end, coalescing many sub-changes into ONE
     *  emit. Re-entrant. createFullCharacter3D uses it so spawning a character fires one event, not ~9
     *  (each of which a host listener may answer with an O(N) scan → the "22nd character is slow" bug). */
    public beginSceneGraphBatch3D(): void { this._sceneGraphBatchDepth++; }
    public endSceneGraphBatch3D(): void {
        if (this._sceneGraphBatchDepth > 0) this._sceneGraphBatchDepth--;
        if (this._sceneGraphBatchDepth === 0 && this._sceneGraphBatchPending) {
            this._sceneGraphBatchPending = false;
            this.interactionService.onSceneGraphChanged.emit();
        }
        this.scheduleRender();
    }

    private _sceneStructureVersion = 0;
    /** Monotonic structural-change counter (see ManagerContext.sceneStructureVersion). */
    getSceneStructureVersion(): number { return this._sceneStructureVersion; }

    private emitSceneGraphChanged() {
        // Bump BEFORE any early return so batched / mid-restore structural changes still invalidate
        // any cached mesh lists. Over-invalidation is harmless; a missed bump would risk a stale cache.
        this._sceneStructureVersion++;
        if (this._isRestoring) {
            // During document restore, only schedule a render — don't fire the
            // scene-graph-changed event yet.  A single event is emitted at the
            // very end of restoreDocumentState() to avoid intermediate states
            // where layers haven't been recreated yet.
            this.scheduleRender();
            return;
        }
        if (this._sceneGraphBatchDepth > 0) {
            // Batching (e.g. createFullCharacter3D): defer; one event fires at endSceneGraphBatch3D.
            this._sceneGraphBatchPending = true;
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
            const already = this.interactionService.selectedNodes.size === 1 &&
                            this.interactionService.selectedNodes.has(node);
            if (!already) {
                this.interactionService.clearSelectedNodes();
                this.interactionService.selectNode(node);
            }
        }
        // Sync the 3D renderer gizmo when a 3D node is selected from the outliner.
        // Uses a dedicated method to avoid a ctx.setSelectedNode → setSelectedNode cycle.
        this.scene3d?.syncSelectionFromOutliner(nodeId);
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
        if (this._activeVectorLayerId) rectangle.layerId = this._activeVectorLayerId;
        this.sceneGraph.root.addChild(rectangle);
        this.emitSceneGraphChanged();
    }

    createCircle(
        x: number, y: number, radius: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var circle = this.shapeFactory.createCircle(x, y, radius, this.shapeColor, strokeColor, strokeWidth);
        if (this._activeVectorLayerId) circle.layerId = this._activeVectorLayerId;
        this.sceneGraph.root.addChild(circle);
        this.emitSceneGraphChanged();
    }

    createTriangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var triangle = this.shapeFactory.createTriangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        if (this._activeVectorLayerId) triangle.layerId = this._activeVectorLayerId;
        this.sceneGraph.root.addChild(triangle);
        this.emitSceneGraphChanged();
    }

    createLine(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number) {
        const line = this.shapeFactory.createLine(x1, y1, x2, y2, strokeColor, strokeWidth);
        if (this._activeVectorLayerId) line.layerId = this._activeVectorLayerId;
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
        if (this._activeVectorLayerId) line.layerId = this._activeVectorLayerId;
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
        if (this._activeVectorLayerId) note.layerId = this._activeVectorLayerId;
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
        if (this._activeVectorLayerId) balloon.layerId = this._activeVectorLayerId;
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

    // ── 3D Scene (PS1-style WebGPU rendering) ────────────────────────

    private _orbitController?: OrbitController;

    /** Get the 3D renderer from the main WebGPU renderer (lazy-initialized). */
    private get renderer3D(): Renderer3D {
        return this.webgpuRenderer.getRenderer3D();
    }

    /** Get the 3D camera. */
    public getCamera3D(): Camera3D {
        return this.scene3d.getCamera();
    }

    /**
     * Create and configure a 3D perspective camera.
     * Replaces the current 3D camera on the renderer.
     */
    public createCamera3D(config?: Camera3DConfig): Camera3D {
        return this.scene3d.createCamera(config);
    }

    /** Reset camera to default pose. */
    public resetCamera3D(): void {
        this.scene3d.resetCamera();
    }

    /** Switch projection mode. */
    public setCamera3DMode(mode: 'perspective' | 'orthographic'): void {
        this.scene3d.setCameraMode(mode);
    }

    /** Set camera FOV in degrees. */
    public setCamera3DFOV(degrees: number): void {
        this.scene3d.setFOV(degrees);
    }

    // ── 3D Illustration mode ────────────────────────────────────────

    /**
     * Sync the 3D camera to the 2D viewport for 3D Illustration mode.
     * Call on every pan/zoom change. panX/panY are screen-pixel offsets (panOffset),
     * zoom is the current zoom factor, canvasW/H are canvas pixel dimensions.
     */
    public syncIllustrationCamera3D(panX: number, panY: number, zoom: number, canvasW: number, canvasH: number): void {
        this.scene3d.syncIllustrationCamera(panX, panY, zoom, canvasW, canvasH);
    }

    /**
     * Switch the 3D Illustration mode between 'perspective' and 'orthographic'.
     * Immediately re-syncs the camera using the last syncIllustrationCamera3D params.
     */
    public setIllustrationProjection3D(mode: 'perspective' | 'orthographic'): void {
        this.scene3d.setIllustrationProjection(mode);
    }

    /**
     * Returns the 3D world-space center of the illustration camera's visible area —
     * i.e. the point the illustration camera is looking at.
     * Use this to place new meshes at the center of the visible canvas instead of
     * the world origin (which maps to the top-left corner in illustration mode).
     * Returns null if the illustration camera has never been synced.
     */
    public getIllustrationCenter3D(): [number, number, number] | null {
        return this.scene3d.getIllustrationCenter3D();
    }

    /**
     * Retu
     * rns the recommended uniform scale for a new 3D mesh in illustration mode.
     * In illustration mode 1 world unit = 1 canvas pixel, so unit-scale meshes are
     * invisible. This returns a scale that makes primitives appear ~10% of viewport height.
     * Returns 1 in perspective mode (camera not yet synced).
     */
    public getIllustrationMeshDefaultScale3D(): number {
        return this.scene3d.getIllustrationMeshDefaultScale3D();
    }

    /** Frame all meshes in view. */
    public frameAllMeshes3D(padding: number = 1.25): boolean {
        return this.scene3d.frameAllMeshes(padding);
    }

    /** Frame one mesh in view by node ID. */
    public frameMesh3D(nodeId: string, padding: number = 1.25): boolean {
        return this.scene3d.frameMesh(nodeId, padding);
    }

    /**
     * Enable orbit controls on the 3D camera.
     * Attaches mouse/touch handlers to the canvas.
     */
    public enableOrbitControls(config?: OrbitControllerConfig): OrbitController {
        return this.scene3d.enableOrbitControls(config);
    }

    /** Disable and detach orbit controls (also tears down the view gizmo). */
    public disableOrbitControls(): void {
        this.scene3d.disableOrbitControls();
    }

    /** Show the view gizmo. Requires orbit controls to be active. */
    public enableViewGizmo3D(position?: import('../renderer/3d/view-gizmo').ViewGizmoPosition): void {
        this.scene3d.enableViewGizmo(position);
    }

    /** Hide the view gizmo. */
    public disableViewGizmo3D(): void {
        this.scene3d.disableViewGizmo();
    }

    /** Move the nav gizmo (default top-left). Pass a corner + optional inset to clear the host's toolbars/panels,
     *  e.g. `{ corner: 'top-left', offsetX: 300 }` to sit just right of a left panel. Applies live. */
    public setViewGizmoPosition3D(position: import('../renderer/3d/view-gizmo').ViewGizmoPosition): void {
        this.scene3d.setViewGizmoPosition(position);
    }

    /** Get the current orbit controller (if active). */
    public getOrbitController(): OrbitController | undefined {
        return this.scene3d.getOrbitController();
    }

    // ── 3D Mesh Creation ────────────────────────────────────────

    /** Create a box mesh at (x, y, z). */
    public createBox3D(x: number, y: number, z: number, width = 1, height = 1, depth = 1, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'box', width, height, depth, material });
    }

    /** Create a sphere mesh at (x, y, z). */
    public createSphere3D(x: number, y: number, z: number, radius = 0.5, segments = 16, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'sphere', radius, widthSegments: segments, heightSegments: Math.max(2, segments * 0.75 | 0), material });
    }

    /** Create a ground plane at (x, y, z). */
    public createPlane3D(x: number, y: number, z: number, width = 1, height = 1, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'plane', width, height, material });
    }

    /** Create a cylinder at (x, y, z). */
    public createCylinder3D(x: number, y: number, z: number, radius = 0.5, height = 1, radialSegments = 16, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'cylinder', radius, height, radialSegments, material });
    }

    /** Create a torus at (x, y, z). */
    public createTorus3D(x: number, y: number, z: number, radius = 0.5, tubeRadius = 0.2, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'torus', radius, tubeRadius, material });
    }

    /**
     * Create an editable polygon mesh from a 2D silhouette in the XZ plane.
     * `points` — array of [x, z] pairs (minimum 3). Y is up.
     * `height` — extrusion distance along +Y (default 1; use 0 for a flat cap).
     * The mesh starts with an EditMesh pre-attached — no makeEditable() needed.
     */
    public addPolygonMesh3D(x: number, y: number, z: number, points: [number, number][], height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
        return this.scene3d.createPolygonMesh(x, y, z, points, height, name, material);
    }

    /**
     * Create an editable circle (regular n-gon) mesh extruded along Y.
     * Convenience wrapper around addPolygonMesh3D.
     */
    public addCircleMesh3D(x: number, y: number, z: number, radius = 0.5, segments = 8, height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
        return this.scene3d.createCircleMesh(x, y, z, radius, segments, height, name, material);
    }

    /** Create a mesh from custom geometry. */
    public createCustomMesh3D(x: number, y: number, z: number, geometry: MeshGeometry, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'custom', geometry, material });
    }

    /** Parse an OBJ string and add the resulting mesh to the scene at (x, y, z). */
    public importObjMesh3D(x: number, y: number, z: number, objText: string, material?: Partial<Material3D>): Mesh3D {
        return this.scene3d.importObjMesh(x, y, z, objText, material);
    }

    /** Read a .obj File/Blob, parse it, and add the mesh to the scene at (x, y, z). */
    public importObjFile3D(x: number, y: number, z: number, file: File | Blob, material?: Partial<Material3D>): Promise<Mesh3D> {
        return this.scene3d.importObjFile(x, y, z, file, material);
    }

    /** Parse a GLB ArrayBuffer and create one Mesh3D per node. Returns all created meshes. */
    public importGltfBuffer3D(x: number, y: number, z: number, buffer: ArrayBuffer, material?: Partial<Material3D>): Promise<Mesh3D[]> {
        return this.scene3d.importGltfBuffer(x, y, z, buffer, material);
    }

    /** Read a .glb/.gltf File and create one Mesh3D per node. Returns all created meshes. */
    public importGltfFile3D(x: number, y: number, z: number, file: File | Blob, material?: Partial<Material3D>): Promise<Mesh3D[]> {
        return this.scene3d.importGltfFile(x, y, z, file, material);
    }

    // ── Skinned mesh import ───────────────────────────────────────────────

    /**
     * Parse a GLB ArrayBuffer containing a skinned mesh (skins + JOINTS_0/WEIGHTS_0).
     * Creates one Skeleton3D + one SkinnedMesh3D per skinned primitive in the file.
     * Returns IDs of the created skeleton and mesh nodes.
     */
    public async importSkinnedGltfBuffer3D(
        x: number, y: number, z: number,
        buffer: ArrayBuffer,
        material?: Partial<Material3D>,
    ): Promise<{ skeletonIds: string[]; meshIds: string[] }> {
        const { skeletons, meshes } = await this.scene3d.importSkinnedGltfBuffer(x, y, z, buffer, material);
        return { skeletonIds: skeletons.map(s => s.id), meshIds: meshes.map(m => m.id) };
    }

    /** Read a .glb File containing a skinned mesh. */
    public async importSkinnedGltfFile3D(
        x: number, y: number, z: number,
        file: File | Blob,
        material?: Partial<Material3D>,
    ): Promise<{ skeletonIds: string[]; meshIds: string[] }> {
        const { skeletons, meshes } = await this.scene3d.importSkinnedGltfFile(x, y, z, file, material);
        return { skeletonIds: skeletons.map(s => s.id), meshIds: meshes.map(m => m.id) };
    }

    /**
     * Override a single joint's local rotation (quaternion xyzw) on a Skeleton3D node.
     * Recomputes world matrices and skin matrices immediately.
     * Call scheduleRender() after for the change to appear.
     */
    public setJointRotation3D(skeletonId: string, jointIndex: number, q: [number, number, number, number]): boolean {
        const skel = this.scene3d.getSkeleton(skeletonId);
        if (!skel) return false;
        skel.setJointRotation(jointIndex, q);
        return true;
    }

    /** Get the current local rotation quaternion [x,y,z,w] for a joint. */
    public getJointRotation3D(skeletonId: string, jointIndex: number): [number,number,number,number] | null {
        return this.scene3d.getJointRotation(skeletonId, jointIndex);
    }

    /** Reset a single joint's FK rotation to identity (clears any pose). */
    public resetJointRotation3D(skeletonId: string, jointIndex: number): void {
        this.scene3d.resetJointRotation(skeletonId, jointIndex);
    }

    /** Reset all joints in a skeleton to identity rotation (clears entire pose). */
    public resetAllJointRotations3D(skeletonId: string): void {
        this.scene3d.resetAllJointRotations(skeletonId);
    }

    /**
     * Switch the active armature tool mode.
     * 'move' — drag joint spheres or XYZ arrow gizmo to reposition joints (edits bind pose).
     * 'rotate' — drag arc ring gizmo to apply FK rotation (poses the character for animation).
     */
    public setArmatureToolMode3D(mode: 'move' | 'rotate'): void {
        this.scene3d.setArmatureToolMode(mode);
    }

    public getArmatureToolMode3D(): 'move' | 'rotate' {
        return this.scene3d.getArmatureToolMode();
    }

    /**
     * Create and return an AnimationPlayer3D that drives a SkeletonAnimClip.
     * The returned player starts paused — call player.play() to begin.
     */
    public playSkeletonClip3D(
        skeletonId: string,
        clip: import('../types/armature-3d').SkeletonAnimClip,
    ): import('../renderer/3d/animation-player-3d').AnimationPlayer3D {
        return this.scene3d.playSkeletonClip(skeletonId, clip);
    }

    // ── Non-Linear Animation (NLA) ────────────────────────────────────

    /** Create a new NLA track for the given skeleton. Returns the track ID. */
    public createNLATrack3D(skeletonId: string, name: string, fps = 24, loop = true): string {
        return this.scene3d.createNLATrack3D(skeletonId, name, fps, loop);
    }

    /** Return all NLA tracks belonging to `skeletonId`. */
    public getNLATracks3D(skeletonId: string): import('../types/armature-3d').NLATrack[] {
        return this.scene3d.getNLATracks3D(skeletonId);
    }

    /** Append a clip segment to an NLA track. Returns the new segment index. */
    public addNLASegment3D(
        trackId: string,
        clipId: string,
        startFrame: number,
        opts?: Partial<Omit<import('../types/armature-3d').NLAClipSegment, 'clipId' | 'startFrame'>>,
    ): number {
        return this.scene3d.addNLASegment3D(trackId, clipId, startFrame, opts);
    }

    /** Remove a segment by index from an NLA track. */
    public removeNLASegment3D(trackId: string, segIndex: number): void {
        this.scene3d.removeNLASegment3D(trackId, segIndex);
    }

    /** Patch fields on an existing NLA segment. */
    public updateNLASegment3D(
        trackId: string,
        segIndex: number,
        updates: Partial<import('../types/armature-3d').NLAClipSegment>,
    ): void {
        this.scene3d.updateNLASegment3D(trackId, segIndex, updates);
    }

    /**
     * Start an AnimationPlayer3D that drives the NLA track.
     * The returned player starts paused — call player.play() to begin.
     */
    public playNLATrack3D(trackId: string): import('../renderer/3d/animation-player-3d').AnimationPlayer3D {
        return this.scene3d.playNLATrack3D(trackId);
    }

    /** Stop and destroy the NLA player for the given track. */
    public stopNLATrack3D(trackId: string): void {
        this.scene3d.stopNLATrack3D(trackId);
    }

    /** Evaluate the NLA track at a specific frame without starting a player. */
    public seekNLATrack3D(trackId: string, frame: number): void {
        this.scene3d.seekNLATrack3D(trackId, frame);
    }

    /**
     * Schedule a crossfade between two NLA segments over `durationFrames`.
     * `fromSeg` fades out while `toSeg` fades in.
     */
    public crossfade3D(trackId: string, fromSegIdx: number, toSegIdx: number, durationFrames: number): void {
        this.scene3d.crossfade3D(trackId, fromSegIdx, toSegIdx, durationFrames);
    }

    // ── GLTF / GLB Export ────────────────────────────────────────────

    /**
     * Export all 3D meshes and skeletons in the scene to a self-contained GLB blob.
     *
     * ```ts
     * const result = sm.exportSceneGltf3D();
     * const url = URL.createObjectURL(result.blob);
     * const a = document.createElement('a');
     * a.href = url; a.download = 'scene.glb'; a.click();
     * URL.revokeObjectURL(url);
     * ```
     */
    public exportSceneGltf3D(): import('../renderer/3d/gltf-exporter').GltfExportResult {
        return this.scene3d.exportSceneGltf3D();
    }

    /**
     * Returns the currently selected joint in the active bone overlay, or null.
     * The bone overlay activates automatically when a SkinnedMesh3D is selected.
     */
    public getSelectedJoint3D(): { skeletonId: string; jointIndex: number } | null {
        const jointIndex = this.scene3d.getSelectedJointIndex();
        const skeletonId = this.scene3d.getBoneOverlaySkeletonId();
        if (jointIndex === null || skeletonId === null) return null;
        return { skeletonId, jointIndex };
    }

    /** Clear the active joint selection without deselecting the mesh. */
    public clearSelectedJoint3D(): void {
        this.scene3d.clearJointSelection();
    }

    // ── Skeleton authoring — creation ─────────────────────────────────

    /** Create an empty Skeleton3D with no joints. Returns the skeleton ID. */
    public createEmptySkeleton3D(name?: string): string {
        return this.scene3d.createEmptySkeleton3D(name);
    }

    /** List all skeletons in the scene as flat { id, name } descriptors. Use this to populate skeleton picker dropdowns. */
    public getAllSkeletons3D(): { id: string; name: string }[] {
        return this.scene3d.getAllSkeletons().map(s => ({ id: s.id, name: s.data.name ?? s.name ?? 'Skeleton' }));
    }

    // ── Bone overlay ──────────────────────────────────────────────────

    /**
     * Show the bone overlay for the given skeleton (visible in the viewport
     * regardless of whether the mesh is bound yet).  Pass null to hide.
     * Pass `meshId` to automatically center the camera on that mesh on entry.
     * Call this whenever the Armature panel's active skeleton changes.
     */
    public showBoneOverlay3D(skeletonId: string | null, meshId?: string): void {
        this.scene3d.showBoneOverlay3D(skeletonId, meshId);
    }

    /**
     * Activate the armature focus background immediately, before a skeleton exists.
     * Call this when the Armature panel opens (on the 'Armature' button click) so the
     * wavy background appears right away, not only after the first bone is added.
     * The background deactivates automatically when showBoneOverlay3D(null) is called.
     * Optionally pass `meshId` to frame the camera on the mesh being rigged.
     */
    public enterArmatureMode3D(meshId?: string): void {
        this.scene3d.enterArmatureMode3D(meshId);
    }

    /** ID of the skeleton whose overlay is currently active, or null. */
    public getBoneOverlaySkeletonId3D(): string | null {
        return this.scene3d.getBoneOverlaySkeletonId();
    }

    /**
     * Index of the joint currently selected in the viewport (via click or
     * extrudeJoint3D), or null.  Re-read after every sceneGraphChanged event.
     */
    public getSelectedJointIndex3D(): number | null {
        return this.scene3d.getSelectedJointIndex();
    }

    /**
     * True if the current joint selection was made by clicking a **tail** sphere.
     * Use this to update the Add Bone / Extrude button hints:
     *   - tail selected → "Extend chain from tail"
     *   - head selected → "Branch from this joint"
     * Re-read after every sceneGraphChanged event.
     */
    public getSelectedJointIsTail3D(): boolean {
        return this.scene3d.getSelectedJointIsTail();
    }

    /**
     * Programmatically select a joint.  Emits sceneGraphChanged so the panel
     * can sync.  Pass null to deselect.
     */
    public selectJoint3D(jointIndex: number | null): void {
        this.scene3d.selectJoint(jointIndex);
    }

    /**
     * Enter bone placement mode for a child joint parented to the currently
     * selected joint.  The user's next viewport click places the new bone with
     * its head at the parent's tail and its tail at the click point.
     * Fires sceneGraphChanged — Frogmarks should show a "Click to place joint"
     * hint and read isBonePlacementModeActive3D() to know when to dismiss it.
     */
    public extrudeJoint3D(skeletonId: string): void {
        this.scene3d.extrudeJoint3D(skeletonId);
    }

    /**
     * Project all joint world positions into 2D screen coordinates.
     * Use this each frame to position name-label DOM elements over the canvas.
     * Returns [] if the skeleton is not found.
     */
    public getJointScreenPositions3D(
        skeletonId: string,
        canvasWidth: number,
        canvasHeight: number,
    ): { index: number; name: string; x: number; y: number }[] {
        return this.scene3d.getJointScreenPositions3D(skeletonId, canvasWidth, canvasHeight);
    }

    /**
     * Enter bone placement mode for a skeleton.  The next viewport click will
     * ray-cast to the mesh surface (or a camera-facing plane as fallback) and
     * place a new joint there, parented to the currently selected joint.
     * Fires sceneGraphChanged and automatically exits placement mode.
     * Call isBonePlacementModeActive3D() to show the "click to place" hint.
     */
    public enterBonePlacementMode3D(skeletonId: string): void {
        this.scene3d.enterBonePlacementMode3D(skeletonId);
    }

    /** Cancel bone placement mode without placing a joint. */
    public exitBonePlacementMode3D(): void {
        this.scene3d.exitBonePlacementMode3D();
    }

    /** Returns true while the next viewport click will place a joint. */
    public isBonePlacementModeActive3D(): boolean {
        return this.scene3d.isBonePlacementModeActive3D();
    }

    /**
     * Set the visual background shown in armature focus mode.
     * Use the built-in presets for the named styles, or supply a custom ArmatureBgOptions.
     *
     * @example — named presets (use these for the UI dropdown)
     * import { ARMATURE_BG_WAVY_WATER, ARMATURE_BG_WAVY_SAGE } from '../renderer/3d/armature-bg-pass'
     * shapeManager.setArmatureBgMode3D(ARMATURE_BG_WAVY_WATER)   // "Wavy Water" (default)
     * shapeManager.setArmatureBgMode3D(ARMATURE_BG_WAVY_SAGE)    // "Wavy Sage"
     *
     * @example — custom
     * shapeManager.setArmatureBgMode3D({ mode: 'solid', color1: [0.1, 0.1, 0.12, 1] })
     * shapeManager.setArmatureBgMode3D({ mode: 'gradient',
     *   color1: [0.08, 0.08, 0.10, 1], color2: [0.18, 0.18, 0.22, 1] })
     * shapeManager.setArmatureBgMode3D({ mode: 'dim', dimStrength: 0.6 })
     * shapeManager.setArmatureBgMode3D({ mode: 'none' })
     */
    public setArmatureBgMode3D(opts: import('../types/armature-3d').ArmatureBgOptions): void {
        this.scene3d.setArmatureBgMode3D(opts);
    }

    /**
     * Set the focus-mode background shown while editing/painting a mesh (mesh edit + UV
     * paint). Hides the 2D illustration content behind it for a clean workspace. Same
     * options as armature — reuse the ARMATURE_BG_* presets or pass an ArmatureBgOptions:
     *   shapeManager.setMeshEditBgMode3D(ARMATURE_BG_WAVY_WATER)
     *   shapeManager.setMeshEditBgMode3D({ mode: 'solid', color1: [0.1, 0.1, 0.12, 1] })
     *   shapeManager.setMeshEditBgMode3D({ mode: 'none' })   // show the 2D layers
     */
    public setMeshEditBgMode3D(opts: import('../types/armature-3d').ArmatureBgOptions): void {
        this.scene3d.setMeshEditBgMode3D(opts);
    }

    /** Current mesh-edit / UV focus-mode background style. */
    public getMeshEditBgMode3D(): import('../types/armature-3d').ArmatureBgOptions {
        return this.scene3d.getMeshEditBgMode3D();
    }

    /**
     * Fit the camera to the given mesh so it fills the viewport during armature editing.
     * Call after showBoneOverlay3D to center the view on the mesh being rigged.
     * The camera position is restored when showBoneOverlay3D(null) is called.
     */
    public centerCameraOnMesh3D(meshId: string): void {
        this.scene3d.centerCameraOnMesh3D(meshId);
    }

    /** Hide all meshes except meshId. Saves previous visibility for clearMeshIsolation3D. */
    public isolateMesh3D(meshId: string): void {
        this.scene3d.isolateMesh3D(meshId);
    }

    /** Restore mesh visibility saved by isolateMesh3D. */
    public clearMeshIsolation3D(): void {
        this.scene3d.clearMeshIsolation3D();
    }

    /** The mesh currently isolated (visible alone), or null. */
    public get isolatedMeshId3D(): string | null {
        return this.scene3d?.isolatedMeshId3D ?? null;
    }

    /**
     * Return the joint list for a skeleton. Call after any addBone3D / removeBone3D / moveBone3D
     * to refresh the joint list UI. Returns [] if the skeleton is not found.
     */
    public getSkeletonJoints3D(skeletonId: string): {
        index: number;
        name: string;
        parentIndex: number;
        localPosition: [number, number, number];
        tailOffset: [number, number, number];
        isLeaf: boolean;
    }[] {
        const skel = this.scene3d.getSkeleton(skeletonId);
        if (!skel) return [];
        return skel.data.joints.map(j => ({
            index:         j.index,
            name:          j.name,
            parentIndex:   j.parentIndex,
            localPosition: [...j.localPosition] as [number, number, number],
            tailOffset:    [...j.tailOffset] as [number, number, number],
            isLeaf:        j.children.length === 0,
        }));
    }

    /** Append a joint to a skeleton. Returns the new joint index. */
    public addBone3D(skeletonId: string, parentIndex: number, localPos: [number, number, number], name?: string): number {
        return this.scene3d.addBone3D(skeletonId, parentIndex, localPos, name);
    }

    /** Move a joint's local position. */
    public moveBone3D(skeletonId: string, jointIndex: number, localPos: [number, number, number]): void {
        this.scene3d.moveBone3D(skeletonId, jointIndex, localPos);
    }

    /**
     * Set the visual tail offset for a leaf joint (in the joint's own local frame).
     * This controls where the tail handle sphere and diamond tip appear.
     * The tail has no effect on skinning — it is purely visual.
     */
    public setJointTailOffset3D(skeletonId: string, jointIndex: number, offset: [number, number, number]): void {
        this.scene3d.setJointTailOffset3D(skeletonId, jointIndex, offset);
    }

    /** Remove a joint and all its descendants, re-indexing remaining joints. */
    public removeBone3D(skeletonId: string, jointIndex: number): void {
        this.scene3d.removeBone3D(skeletonId, jointIndex);
    }

    /** Rename a joint. */
    public renameBone3D(skeletonId: string, jointIndex: number, name: string): void {
        this.scene3d.renameBone3D(skeletonId, jointIndex, name);
    }

    /**
     * Auto-bind a Mesh3D to a skeleton using inverse-distance² heat diffusion.
     * Upgrades the mesh to SkinnedMesh3D in-place and computes inverse bind matrices.
     */
    public bindMeshToSkeleton3D(meshId: string, skeletonId: string): boolean {
        return this.scene3d.bindMeshToSkeleton3D(meshId, skeletonId);
    }

    // ── Skeleton authoring — weight paint ─────────────────────────────

    /** Enter weight-paint mode: shows a heatmap for `jointIndex` and saves vertex colors. */
    public enterWeightPaintMode3D(meshId: string, skeletonId: string, jointIndex: number): boolean {
        return this.scene3d.enterWeightPaintMode3D(meshId, skeletonId, jointIndex);
    }

    /** Paint vertex weights — blends toward `targetWeight` with `brushStrength` for the given vertices. */
    public paintWeightDab3D(meshId: string, jointIndex: number, vertexIndices: number[], targetWeight: number, brushStrength: number): void {
        this.scene3d.paintWeightDab3D(meshId, jointIndex, vertexIndices, targetWeight, brushStrength);
    }

    /** Normalize all vertex weights so each vertex's 4 weights sum to 1. */
    public normalizeWeights3D(meshId: string): void {
        this.scene3d.normalizeWeights3D(meshId);
    }

    /** Exit weight-paint mode and restore original vertex colors. */
    public exitWeightPaintMode3D(): void {
        this.scene3d.exitWeightPaintMode3D();
    }

    /** Update brush settings for weight painting. Call whenever the UI sliders change. */
    public setWeightPaintBrush(radius: number, strength: number, targetWeight: number): void {
        this.scene3d.setWeightPaintBrush(radius, strength, targetWeight);
    }

    /** Switch the active weight-paint joint without re-entering the mode. Refreshes the heatmap. */
    public setWeightPaintJoint3D(jointIndex: number): void {
        this.scene3d.setWeightPaintJoint3D(jointIndex);
    }

    /** Whether weight paint mode is currently active. */
    public isWeightPainting3D(): boolean { return this.scene3d.isWeightPainting(); }

    /**
     * Show or hide the bone skeleton (diamond sticks) during weight paint mode.
     * Joint sphere handles are always hidden regardless; only the selected joint shows.
     * Defaults to true (skeleton visible). Call anytime — takes effect on next render.
     */
    public setWeightPaintShowSkeleton(show: boolean): void {
        this.scene3d.setWeightPaintShowSkeleton(show);
    }

    /** Declutter the armature overlay by kind. `showSpring` = hair/drape/charm spring-bone chains; `showFk` = the
     *  regular skeleton bones. Both default visible; view-only (posing/sim unaffected). Wire two toggles to this. */
    public setBoneVisibility3D(showSpring: boolean, showFk: boolean): void {
        this.scene3d.setBoneVisibility(showSpring, showFk);
    }
    public getBoneVisibility3D(): { spring: boolean; fk: boolean } { return this.scene3d.getBoneVisibility(); }

    public setWeightPaintUnlit3D(unlit: boolean): void {
        this.scene3d.setWeightPaintUnlit(unlit);
    }

    // ── IK Chain API ─────────────────────────────────────────────────────────

    /** Add an IK chain to a skeleton. Returns the new chain id. */
    public addIKChain3D(skelId: string, endJointIdx: number, chainLength: number): string {
        return this.scene3d.addIKChain(skelId, endJointIdx, chainLength);
    }

    /** Remove an IK chain by id. Clears ikRotation on affected joints. */
    public removeIKChain3D(skelId: string, chainId: string): void {
        this.scene3d.removeIKChain(skelId, chainId);
    }

    /** Return all IK chains for a skeleton. */
    public getIKChains3D(skelId: string): import('../types/armature-3d').IKChain[] {
        return this.scene3d.getIKChains(skelId);
    }

    /** Move the IK target programmatically (e.g. from panel XYZ inputs). */
    public setIKTarget3D(skelId: string, chainId: string, x: number, y: number, z: number): void {
        this.scene3d.setIKTarget(skelId, chainId, x, y, z);
    }

    /** Enable or disable a chain. Disabling clears ikRotation → joints fall back to FK. */
    public setIKChainEnabled3D(skelId: string, chainId: string, enabled: boolean): void {
        this.scene3d.setIKChainEnabled(skelId, chainId, enabled);
    }

    /** Change the chain length (number of bones) after creation. */
    public setIKChainLength3D(skelId: string, chainId: string, chainLength: number): void {
        this.scene3d.setIKChainLength(skelId, chainId, chainLength);
    }

    /**
     * Set the FK/IK blend weight for a chain (0 = pure FK, 1 = pure IK).
     * Intermediate values slerp between FK pose and FABRIK-solved pose.
     */
    public setIKBlendWeight3D(skelId: string, chainId: string, weight: number): void {
        this.scene3d.setIKBlendWeight(skelId, chainId, weight);
    }

    /** Set the pole vector target world position for a chain. */
    public setPoleTarget3D(skelId: string, chainId: string, x: number, y: number, z: number): void {
        this.scene3d.setPoleTarget(skelId, chainId, x, y, z);
    }

    /** Remove the pole vector from a chain (reverts to unconstrained FABRIK). */
    public clearPoleTarget3D(skelId: string, chainId: string): void {
        this.scene3d.clearPoleTarget(skelId, chainId);
    }

    /**
     * Highlight a joint in the bone overlay by index (e.g. on UI list hover).
     * Pass null to clear. Independent of canvas pointer hover state.
     */
    public highlightJoint3D(jointIndex: number | null): void {
        this.scene3d.highlightJoint3D(jointIndex);
    }

    /**
     * Return vertex indices on `meshId` whose world-space position is within
     * `radius` of the given world point. Useful for brush-based weight painting.
     */
    public getVerticesNearPoint3D(meshId: string, wx: number, wy: number, wz: number, radius: number): number[] {
        return this.scene3d.getVerticesNearPoint3D(meshId, wx, wy, wz, radius);
    }

    // ── Skeleton authoring — clip authoring ───────────────────────────

    /** Create a new animation clip on a skeleton. Returns the clip ID. */
    public createSkeletonClip3D(skeletonId: string, name: string, fps: number, endFrame: number): string {
        return this.scene3d.createSkeletonClip3D(skeletonId, name, fps, endFrame);
    }

    /** Set or update a keyframe on a joint's animation track. */
    public setClipJointKeyframe3D(clipId: string, jointIndex: number, channel: 'translation' | 'rotation' | 'scale', frame: number, value: number[]): void {
        this.scene3d.setClipJointKeyframe3D(clipId, jointIndex, channel, frame, value);
    }

    /** Remove a keyframe from a joint's animation track. */
    public removeClipJointKeyframe3D(clipId: string, jointIndex: number, channel: 'translation' | 'rotation' | 'scale', frame: number): void {
        this.scene3d.removeClipJointKeyframe3D(clipId, jointIndex, channel, frame);
    }

    /** Return all authored clips on a skeleton. */
    public getSkeletonClips3D(skeletonId: string): import('../types/armature-3d').SkeletonAnimClip[] {
        return this.scene3d.getSkeletonClips3D(skeletonId);
    }

    /** Delete an authored clip. */
    public deleteSkeletonClip3D(clipId: string): void {
        this.scene3d.deleteSkeletonClip3D(clipId);
    }

    /** Record all current joint poses as keyframes at `frame` in an existing clip. */
    public recordSkeletonPose3D(skeletonId: string, clipId: string, frame: number): void {
        this.scene3d.recordSkeletonPose3D(skeletonId, clipId, frame);
    }

    // ── IK Keyframe API ───────────────────────────────────────────────

    /**
     * Set or update a keyframe on an IK chain property track.
     *   'target'      → value = [x, y, z]
     *   'poleTarget'  → value = [x, y, z]
     *   'blendWeight' → value = [w]  (0–1)
     */
    public setIKKeyframe3D(
        clipId: string,
        chainId: string,
        property: 'target' | 'poleTarget' | 'blendWeight',
        frame: number,
        value: number[],
    ): void {
        this.scene3d.setIKKeyframe(clipId, chainId, property, frame, value);
    }

    /** Remove a keyframe from an IK chain property track. */
    public removeIKKeyframe3D(
        clipId: string,
        chainId: string,
        property: 'target' | 'poleTarget' | 'blendWeight',
        frame: number,
    ): void {
        this.scene3d.removeIKKeyframe(clipId, chainId, property, frame);
    }

    /**
     * Record the current IK state (target, poleTarget if set, blendWeight)
     * for all enabled chains as keyframes at `frame`.
     */
    public recordIKPose3D(skeletonId: string, clipId: string, frame: number): void {
        this.scene3d.recordIKPose(skeletonId, clipId, frame);
    }

    // ── Bone Constraints ─────────────────────────────────────────────────

    /** Add a constraint to a joint. Returns the constraint index. */
    public addJointConstraint3D(
        skelId: string,
        jointIndex: number,
        constraint: import('../types/armature-3d').JointConstraint,
    ): number {
        return this.scene3d.addJointConstraint(skelId, jointIndex, constraint);
    }

    public removeJointConstraint3D(skelId: string, jointIndex: number, constraintIndex: number): void {
        this.scene3d.removeJointConstraint(skelId, jointIndex, constraintIndex);
    }

    public getJointConstraints3D(skelId: string, jointIndex: number): import('../types/armature-3d').JointConstraint[] {
        return this.scene3d.getJointConstraints(skelId, jointIndex);
    }

    // ── Spring-bone authoring (dynamic hair/cloth) ───────────────────────
    /** Create a spring-bone chain over `jointIndices` (root→tip). Returns the chain id. */
    public createSpringChain3D(skelId: string, jointIndices: number[], params?: Partial<import('../types/armature-3d').SpringChain>): string {
        return this.scene3d.createSpringChain(skelId, jointIndices, params);
    }
    /** Update a spring chain's params (stiffness/drag/gravity/gravityDir/hitRadius/enabled). */
    public setSpringChainParams3D(skelId: string, chainId: string, params: Partial<import('../types/armature-3d').SpringChain>): void {
        this.scene3d.setSpringChainParams(skelId, chainId, params);
    }
    public removeSpringChain3D(skelId: string, chainId: string): void {
        this.scene3d.removeSpringChain(skelId, chainId);
    }
    public getSpringChains3D(skelId: string): import('../types/armature-3d').SpringChain[] {
        return this.scene3d.getSpringChains(skelId);
    }
    /** Add a collider the spring bones bounce off (sphere, or capsule if `tail` set). Returns its index. */
    public addSpringCollider3D(skelId: string, collider: import('../types/armature-3d').SpringCollider): number {
        return this.scene3d.addSpringCollider(skelId, collider);
    }
    public removeSpringCollider3D(skelId: string, index: number): void {
        this.scene3d.removeSpringCollider(skelId, index);
    }
    public getSpringColliders3D(skelId: string): import('../types/armature-3d').SpringCollider[] {
        return this.scene3d.getSpringColliders(skelId);
    }

    // ── Pose Library ─────────────────────────────────────────────────────

    /** Snapshot the skeleton's current FK rotations as a named pose. Returns the new pose ID. */
    public capturePose3D(skelId: string, name: string): string {
        return this.scene3d.capturePose(skelId, name);
    }

    /** Apply a saved pose — sets all joint localRotations and fires sceneGraphChanged. */
    public applyPose3D(skelId: string, poseId: string): void {
        this.scene3d.applyPose(skelId, poseId);
    }

    /** List all saved poses on the skeleton. */
    public getPoses3D(skelId: string): { id: string; name: string; region?: import('../types/armature-3d').AnimRegion }[] {
        return this.scene3d.getPoses(skelId);
    }

    /** Tag a pose's spatial REGION (Left/Right/Top/Bottom/Center) for library filtering; null clears it. */
    public setPoseRegion3D(skelId: string, poseId: string, region: import('../types/armature-3d').AnimRegion | null): void {
        this.scene3d.setPoseRegion(skelId, poseId, region);
    }
    /** Tag a clip's spatial REGION; null clears it. */
    public setClipRegion3D(clipId: string, region: import('../types/armature-3d').AnimRegion | null): void {
        this.scene3d.setClipRegion(clipId, region);
    }
    /** All poses + clips on a skeleton with the given region — drives a Left/Right/Top/Bottom/Center filter UI. */
    public getAnimationsByRegion3D(skelId: string, region: import('../types/armature-3d').AnimRegion): { poses: { id: string; name: string }[]; clips: import('../types/armature-3d').SkeletonAnimClip[] } {
        return this.scene3d.getAnimationsByRegion(skelId, region);
    }

    public renamePose3D(skelId: string, poseId: string, name: string): void {
        this.scene3d.renamePose(skelId, poseId, name);
    }

    public deletePose3D(skelId: string, poseId: string): void {
        this.scene3d.deletePose(skelId, poseId);
    }

    /**
     * Pre-populate a skeleton's Animation Clips + Pose Library with the default idle/personality set
     * (Breathe, Shift Weight, Look Around, Stretch, Scratch Head, Talk Gesture + Wave/Cheer/Thinking/…
     * poses). New procedural bodies get these automatically; call this to BACKFILL an older character.
     * Accepts EITHER a skeleton id OR a body mesh id (whichever you have) — it resolves internally.
     * Idempotent (skips names already present). Returns how many clips + poses were added.
     */
    public installDefaultAnimations3D(skeletonOrBodyMeshId: string): number {
        return this.scene3d.installDefaultAnimations(skeletonOrBodyMeshId);
    }

    /** The skeleton id a body/skinned mesh is bound to, or null. Handy when you only have the body id. */
    public getSkeletonIdForMesh3D(meshId: string): string | null {
        return this.scene3d.getSkeletonIdForMesh(meshId);
    }

    /**
     * Export the current pose as a copy-pasteable text block (per-joint quaternion + Euler degrees) for any
     * joint rotated away from rest — for handing to Claude to bake into a named pose or animation clip.
     * Pose the character in Edit Armature (FK or IK), then call this and copy the returned string. Omit the
     * id to use the skeleton currently shown in the bone overlay. Wire a "Copy pose for Claude" button to it.
     */
    public exportPoseData3D(skeletonId?: string): string {
        return this.scene3d.exportPoseData(skeletonId);
    }

    /**
     * Export the procedural body's proportions (body params + rest bone lengths) as a copy-pasteable block,
     * so a captured pose can be associated with the body it was authored on (hand-on-body poses depend on
     * hip width / arm reach). Pass a body mesh id or skeleton id, or omit to use the bone-overlay skeleton.
     * Pair this with exportPoseData3D in one "Copy pose + body for Claude" button.
     */
    public exportBodyData3D(bodyMeshIdOrSkeletonId?: string): string {
        return this.scene3d.exportBodyData(bodyMeshIdOrSkeletonId);
    }

    /** Names of the built-in default clips (for labelling/filtering the built-ins in the host UI). */
    public getDefaultClipNames3D(): string[] {
        return this.scene3d.getDefaultClipNames();
    }

    // ── Skeleton authoring — retarget ─────────────────────────────────

    /**
     * Copy an animation clip to a different skeleton by matching joint names.
     * Returns the new clip ID on the target skeleton.
     */
    public retargetSkeletonClip3D(clipId: string, targetSkeletonId: string): string {
        return this.scene3d.retargetSkeletonClip3D(clipId, targetSkeletonId);
    }

    /** Set the render style on a mesh ('default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'). */
    public setRenderStyle3D(nodeId: string, style: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'): boolean {
        return this.scene3d.setRenderStyle(nodeId, style);
    }

    /** Get the current render style of a mesh. */
    public getRenderStyle3D(nodeId: string): string | null {
        return this.scene3d.getRenderStyle(nodeId);
    }

    /** Set the render style on a whole procedural character (body + clothing + hair) in ONE call. Returns count. */
    public setCharacterRenderStyle3D(bodyMeshId: string, style: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'): number {
        return this.scene3d.setCharacterRenderStyle(bodyMeshId, style);
    }
    /** Set the render style on every 3D mesh in the scene in ONE call. Returns count. */
    public setRenderStyleAll3D(style: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'): number {
        return this.scene3d.setRenderStyleAll(style);
    }

    /** Set a procedural geometric PATTERN (stripes/dots/diamonds/checker/grid) on a mesh's albedo — analytic +
     *  antialiased in-shader (crisp at any zoom, no shimmer). Primary colour = the mesh's diffuse, `color` = secondary.
     *  Live. `freq` = repeats, `angle` rad, `scale` = stripe width / dot radius (0..1), `spacing` = per-pattern extra. */
    public setMeshPattern3D(meshId: string, opts: {
        mode?: 'none' | 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid';
        color?: { r: number; g: number; b: number };
        freq?: number; angle?: number; scale?: number; spacing?: number;
    }): void { this.scene3d.setMeshPattern(meshId, opts); }
    /** The mesh's current pattern settings (or null). */
    public getMeshPattern3D(meshId: string) { return this.scene3d.getMeshPattern(meshId); }
    /** Named pattern presets (Pinstripe · Stripes · Diagonal · Polka Dots · Micro Dots · Argyle · Harlequin ·
     *  Checkerboard · Gingham · Grid · Graph · None). Returns a `ClothingPattern` — drop it on a garment's `pattern`
     *  field (then `setClothingParams3D`) or onto a mesh via `setMeshPattern3D`. */
    public clothingPatternPresetNames3D(): string[] { return this.scene3d.clothingPatternPresetNames(); }
    public clothingPatternPreset3D(name: string) { return this.scene3d.clothingPatternPreset(name); }

    /**
     * Auto-scale a list of meshes to fit within targetSize world units.
     * Run this after GLTF import when models appear tiny (GLTF uses metres; Salsa uses pixels).
     */
    public autoScaleToFit3D(meshIds: string[], targetSize?: number): void {
        this.scene3d.autoScaleToFit(meshIds, targetSize);
    }

    // ── Outline pass ──────────────────────────────────────────────────

    /** Enable screen-space ink outlines around 3D meshes. */
    public enableOutlines3D(color?: [number, number, number, number], threshold?: number): void {
        this.scene3d.enableOutlines(color, threshold);
    }

    /** Disable screen-space ink outlines. */
    public disableOutlines3D(): void {
        this.scene3d.disableOutlines();
    }

    /** Whether screen-space ink outlines are currently active. */
    public get outlinesEnabled3D(): boolean { return this.scene3d.outlineEnabled; }

    /** Set the outline colour (r, g, b, a in 0–1). */
    public setOutlineColor3D(r: number, g: number, b: number, a = 1): void {
        this.scene3d.setOutlineColor(r, g, b, a);
    }

    /** Set the Sobel edge threshold (lower = more lines; default ≈ 0.0004). */
    public setOutlineThreshold3D(t: number): void {
        this.scene3d.setOutlineThreshold(t);
    }

    /** Core mesh creation — adds to scene graph and selects. */
    private createMesh3D(x: number, y: number, z: number, config: Mesh3DConfig): Mesh3D {
        const mesh = new Mesh3D(this.interactionService, x, y, z, config);
        this.sceneGraph.root.addChild(mesh);
        this.emitSceneGraphChanged();
        this.setSelectedNode(mesh.id);
        this.scheduleRender();
        return mesh;
    }

    /** Get a Mesh3D by node ID. */
    public getMesh3D(nodeId: string): Mesh3D | null {
        return this.scene3d.getMesh(nodeId);
    }

    /** Get all meshes in the scene. */
    public getAllMeshes3D(): Mesh3D[] {
        return this.scene3d.getAllMeshes();
    }

    /**
     * True if the mesh was produced by createProceduralBody3D (it ships pre-rigged with generator
     * weights). The armature panel should hide "Bind Mesh" for these — re-binding clobbers the
     * tube weights with distance-based auto-weights. Also readable directly as `mesh.isProceduralBody`
     * on the objects from getAllMeshes3D().
     */
    public isProceduralBody3D(meshId: string): boolean {
        return this.scene3d.getMesh(meshId)?.isProceduralBody === true;
    }

    /** Skeleton-keyed counterpart of isProceduralBody3D (the armature panel keys off the active
     *  skeleton). Persisted, so it stays correct across save/reload. */
    public isProceduralBodySkeleton3D(skeletonId: string): boolean {
        return this.scene3d.getSkeleton(skeletonId)?.isProceduralBody === true;
    }

    /** Delete a mesh by node ID. */
    public deleteMesh3D(nodeId: string): boolean {
        return this.scene3d.deleteMesh(nodeId);
    }

    /**
     * Part node IDs of a procedural character (hair, clothing, face/eye decal, attachments — everything skinned
     * to the body's skeleton), so the outliner can group them under one "Character" item + cascade-delete them
     * with the body. Excludes the body mesh itself and the skeleton rig; [] if `bodyMeshId` isn't a procedural body.
     */
    public getProceduralBodyParts3D(bodyMeshId: string): string[] {
        return this.scene3d.getProceduralBodyParts(bodyMeshId);
    }

    /**
     * Fully delete a procedural CHARACTER as ONE undoable op — body + all parts + skeleton + every per-body rig
     * and animation-state map. This is the clean cascade delete; prefer it over looping deleteMesh3D (which leaves
     * the skeleton + rig maps orphaned → they'd re-serialize and bloat saves). Also drops the body + parts' painted
     * UV textures so they don't ride in the next save. Returns false if `bodyMeshId` isn't a procedural body.
     * (Undo restores the geometry + all rigs; painted UV textures are NOT undo-tracked — repaint if you undo.)
     */
    public deleteProceduralBody3D(bodyMeshId: string): boolean {
        for (const id of [bodyMeshId, ...this.scene3d.getProceduralBodyParts(bodyMeshId)]) this._uvPaintTextures.delete(id);
        return this.scene3d.deleteProceduralBody(bodyMeshId);
    }

    private _packaging?: PackagingManager;
    /** rAF handle for the Package-Creator ambience ticker (animated stage bg while the mode is active). */
    private _creatorTickRaf = 0;
    /**
     * Optional Packaging module — `sm.packaging?.create('simpleBox', {width,height,depth})`,
     * `.setFoldAmount(id, 0..1)`, `.fold(id)`, `.setDimensions(id, params)`. Gated by
     * `PACKAGING_ENABLED` (returns null when off — the module is fully removable). The box is a
     * RIGID-PANEL node hierarchy (root container + 6 flat panel meshes under per-panel hinge pivots);
     * folding rotates the pivot nodes (pure transforms — no geometry re-upload). See docs/specs/packaging-system.md.
     */
    public get packaging(): PackagingManager | null {
        if (!PACKAGING_ENABLED) return null;
        if (!this._packaging) {
            const host: PackagingHost = {
                // ── rigid-panel node hooks (box-hierarchy.ts drives these) ──
                createGroup: (name, parentNodeId, scale) => {
                    const g = new MeshGroup3D(this.interactionService);
                    g.name = name;
                    if (scale !== undefined) { g.scaleX = scale; g.scaleY = scale; g.scaleZ = scale; }
                    const parent = parentNodeId ? this.sceneGraph.findNodeById(parentNodeId) : null;
                    (parent ?? this.sceneGraph.root).addChild(g);
                    this.emitSceneGraphChanged();
                    return g.id;
                },
                createPanelMesh: (geom, parentNodeId, name) => {
                    const m = new Mesh3D(this.interactionService, 0, 0, 0, {
                        primitive: 'custom', geometry: geom,
                        material: { diffuse: { r: 0.66, g: 0.50, b: 0.34, a: 1 }, roughness: 0.92, metalness: 0, doubleSided: true },
                    });
                    m.name = name; m.gpuDirty = true;
                    const parent = this.sceneGraph.findNodeById(parentNodeId) ?? this.sceneGraph.root;
                    parent.addChild(m);
                    this.emitSceneGraphChanged();
                    return m.id;
                },
                setNodeTransform: (id, t) => {
                    const n = this.sceneGraph.findNodeById(id) as (Mesh3D | MeshGroup3D) | null;
                    if (!n) return;
                    if (t.pos) n.setXYZ(t.pos[0], t.pos[1], t.pos[2]);   // one matrix rebuild + subtree dirty walk
                    if (t.rotX !== undefined) n.rotationX = t.rotX;
                    if (t.rotY !== undefined) n.rotationY = t.rotY;
                    if (t.rotZ !== undefined) n.rotation = t.rotZ;
                    // ★Bump every DESCENDANT MESH's matrix version: the renderer's "did it move?" check watches
                    // each mesh's OWN localMatrixVersion, which does NOT change when a PARENT pivot rotates —
                    // so folds updated the transforms (picking saw them!) but the render never re-uploaded the
                    // slots (box stayed visibly flat until an unrelated rebuild "jumped" it to the real pose).
                    n.forEachDeep(d => { if (d instanceof Mesh3D) d.updateLocalMatrix(); });
                    // ★Arm the renderer's transforms-only fast path. uploadMeshInstances EARLY-RETURNS
                    // (nothing re-uploaded) unless _transformsDirty/_instancesDirty is set — the version
                    // bumps above only tell the fast path WHICH slots moved once it runs. Every other
                    // mover does this (city tick → markTransformsDirty, keyframes → markInstancesDirty);
                    // without it the fold slider updated transforms that never reached the GPU (box
                    // stayed visibly flat until an unrelated full repack "jumped" it to the real pose).
                    this.scene3d.notifyMeshTransformsChanged3D();   // markTransformsDirty + scheduleRender
                },
                setPanelGeometry: (meshId: string, geom: MeshGeometry) => this.scene3d.setGeometry(meshId, geom),
                removeNode: (id) => this.scene3d.disposePackagingSubtree(id),

                linkLiveTexture: (id, layerId) => this.linkLiveTexture3D(id, layerId),
                unlinkLiveTexture: (id) => this.unlinkLiveTexture3D(id),
                exportLayerPng: (layerId) => this.exportRasterLayerToBlob(layerId, 'image/png'),
                scheduleRender: () => this.scheduleRender(),
                // ── 3D-paint editor hooks (see PackagingManager.enterEditor) ──
                setDocSize: (w, h) => this.setDocumentSize(w, h),
                ensureDielineLayer: (existing) => {
                    const rlm = this.rasterLayerManager;
                    if (!rlm) return null;
                    if (existing && rlm.getLayerById(existing)) return existing;   // restore path: reuse the saved layer
                    return this.addRasterLayer('Dieline')?.id ?? null;
                },
                frameAndOrbit: (rootNodeId) => {
                    // TURN THE 3D SCENE ON — the box is a 3D node hierarchy, and the editor's canvas may have
                    // been set up as a flat-2D dieline doc (scene3DVisible false) → the box never draws and Fold
                    // looks dead. Entering the packaging editor is inherently 3D, so make the pass render.
                    this.scene3DVisible = true;
                    // Don't crop the viewport to the flat-dieline doc rect — the orbited/folded 3D box extends past it.
                    this.webgpuRenderer?.setArtboardClipEnabled(false);
                    // enterGroupOrbit3D frames the box container AND claims the camera for orbit (sets
                    // _meshEditOrbitCenter) so the 2D illustration auto-sync stops snapping the camera back every
                    // frame — which rendered the flat XZ-plane dieline EDGE-ON (invisible). 3/4 top-down default.
                    this.scene3d.enterGroupOrbit3D(rootNodeId, { azimuth: Math.PI * 0.18, elevation: 1.0, padding: 1.7 });
                    this.scheduleRender();
                },
                stopOrbit: () => { this.scene3d.exitMeshOrbit3D(); this.webgpuRenderer?.setArtboardClipEnabled(true); },
                armSurfacePaint: (meshIds, layerId) => this._armPackagingSurfacePaint(meshIds, layerId),
                disarmSurfacePaint: () => { if (this._uvPaintController?.isActive()) this.exitUVPaintMode3D(); },
                // ── CREATOR-MODE hooks (enterCreatorMode — the mode-in-the-Illustration-editor path) ──
                ensureDielineLayerInfo: (existing) => {
                    const rlm = this.rasterLayerManager;
                    if (!rlm) return null;
                    if (existing && rlm.getLayerById(existing)) return { layerId: existing, fresh: false };
                    // Reuse a layer already NAMED 'Dieline' (fixes the duplicate-'Dieline'-layers-on-re-enter
                    // symptom) — but only a real paint layer (has a texture; skips folders/dividers).
                    const named = rlm.getLayers().find(l => l.name === 'Dieline' && rlm.getLayerById(l.id)?.texture);
                    if (named) return { layerId: named.id, fresh: false };
                    const id = this.addRasterLayer('Dieline')?.id ?? null;
                    return id ? { layerId: id, fresh: true } : null;
                },
                fillLayerWhite: (layerId) => this._fillRasterLayerWhite(layerId),
                nodeExists: (id) => !!this.sceneGraph.findNodeById(id),
                // City-mode enter/exit hygiene: no marquee box-select or hover/selection chrome over the
                // box while orbiting, and the view gizmo up (removed again by exitMeshOrbit3D's
                // disableOrbitControls on exit — same as exitCityMode3D).
                beginCreatorStage: () => {
                    this.interactionService.suppressBoxSelect = true;
                    this.scene3d.setHoveredMesh(null);
                    this.scene3d.clearSelection();
                    this.scene3d.enableViewGizmo();
                    // OPT-IN ambience ticker: keep the animated stage background (and any time-driven shader
                    // effects) moving while the mode is active. The render loop is on-demand by design, so
                    // idle frames = frozen wavy bg; this ~30fps tick trades a little GPU for a live-feeling
                    // workspace, ONLY inside Package Creator (cancelled on exit — never a background cost).
                    if (!this._creatorTickRaf && typeof requestAnimationFrame !== 'undefined') {
                        let last = 0;
                        const tick = (now: number): void => {
                            if (now - last >= 33) { last = now; this.scheduleRender(); }   // ~30fps
                            this._creatorTickRaf = requestAnimationFrame(tick);
                        };
                        this._creatorTickRaf = requestAnimationFrame(tick);
                    }
                },
                endCreatorStage: () => {
                    this.interactionService.suppressBoxSelect = false;
                    if (this._creatorTickRaf && typeof cancelAnimationFrame !== 'undefined') {
                        cancelAnimationFrame(this._creatorTickRaf);
                        this._creatorTickRaf = 0;
                    }
                },
                // ── FIRST-CLASS SCENE OBJECT hooks (addPackage / Outliner integration) ──
                // City thin-wrapper pattern: ONE outliner node; a click on any panel walks up to this
                // wrapper and selects the package AS A UNIT; the gizmo writes the root's transform
                // (composes into all panels). cachedBounds sizes the selection box/gizmo without a
                // per-child scan; bounds refreshes (re-dimension) don't re-notify the scene graph.
                markUnitWrapper: (rootNodeId, localBounds) => {
                    const n = this.sceneGraph.findNodeById(rootNodeId);
                    if (!(n instanceof MeshGroup3D)) return;
                    if (localBounds) n.cachedBounds = localBounds;
                    if (!n.thinWrapper) {
                        n.thinWrapper = true;
                        this.emitSceneGraphChanged();
                    }
                },
                // ── UNWRAP PANE hooks (attachDielinePane) — reuse the ONE UV paint controller ──
                // Attach the host's pane canvas onto the paint session _armPackagingSurfacePaint set
                // up (same controller/engine/texture — pane strokes and 3D box strokes both paint the
                // dieline layer; the pane background is the throttled texture readback). Guarded so a
                // pane can never attach onto a CHARACTER paint session sharing the controller.
                attachPaintPane: (uvRenderer) => {
                    const c = this._uvPaintController;
                    const active = c?.activeMeshId();
                    if (!c || !active || !this._packaging?.isPackageNode(active)) return null;
                    if (!c.attachPane(uvRenderer)) return null;
                    return (u: number, v: number) => c.paneUVToCanvas(u, v) ?? [0, 0];
                },
                detachPaintPane: () => { this._uvPaintController?.detachPane(); },
            };
            this._packaging = new PackagingManager(host);
        }
        return this._packaging;
    }

    /** Fill a raster layer opaque WHITE. Used for a FRESHLY created Dieline layer only — a box
     *  live-texturing an empty (transparent-black) layer renders BLACK; blank paper must be white.
     *  One render-pass clear (the layer texture always has RENDER_ATTACHMENT usage). */
    private _fillRasterLayerWhite(layerId: string): void {
        const layer = this.rasterLayerManager?.getLayerById(layerId);
        const device = this.webgpuRenderer.getDevice();
        if (!layer?.texture || !device) return;
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{
                view: layer.texture.createView(),
                clearValue: { r: 1, g: 1, b: 1, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.end();
        device.queue.submit([enc.finish()]);
        this.scheduleRender();
    }

    /**
     * Duplicate a mesh. Returns the new copy, already selected and offset slightly from
     * the original. The operation is undo-able via `undo3D()`.
     */
    public duplicateMesh3D(nodeId: string) {
        return this.scene3d.duplicateMesh(nodeId);
    }

    // ── Multi-material submesh API ────────────────────────────────────

    /** Return the submesh slot list for a mesh (empty if single-material). */
    public getMeshSubmeshes3D(meshId: string): Submesh3D[] {
        return this.scene3d.getSubmeshes(meshId);
    }

    /** Update label or material on an existing submesh slot. */
    public setMeshSubmesh3D(meshId: string, slotIndex: number, partial: Partial<Submesh3D>): void {
        this.scene3d.setSubmesh(meshId, slotIndex, partial);
    }

    /** Append a new submesh slot at the end of the list. */
    public appendMeshSubmesh3D(meshId: string, submesh: Submesh3D): void {
        this.scene3d.appendSubmesh(meshId, submesh);
    }

    /** Remove the submesh slot at the given index. */
    public removeMeshSubmesh3D(meshId: string, slotIndex: number): void {
        this.scene3d.removeSubmesh(meshId, slotIndex);
    }

    /** Remove all submesh slots; the mesh reverts to its top-level material. */
    public clearMeshSubmeshes3D(meshId: string): void {
        this.scene3d.clearSubmeshes(meshId);
    }

    // ── Mesh painting API ─────────────────────────────────────────

    /**
     * Enter mesh-paint mode for the given mesh. Allocates a CPU paint buffer
     * and GPU texture (default 1024×1024) and sets the mesh's diffuse channel
     * to the paint texture so dabs appear immediately.
     */
    public enterMeshPaintMode(meshId: string, texSize = 1024): boolean {
        const mesh = this.scene3d.getMesh(meshId);
        if (!mesh) return false;
        this.meshPaint.enterMeshPaintMode(mesh, texSize);
        return true;
    }

    /** Exit mesh-paint mode. The painted texture is kept on the mesh. */
    public exitMeshPaintMode(): void {
        this.meshPaint.exitMeshPaintMode();
    }

    /** Paint a dab at the surface UV hit returned by MeshPicker. */
    public paintMeshDab(hit: import('../renderer/3d/mesh-picker').PickResult): void {
        this.meshPaint.paintDab(hit);
    }

    /** Call on pointer-up to push the completed stroke onto the undo stack. */
    public endMeshPaintStroke(): void {
        this.meshPaint.endStroke();
    }

    /** Set the brush color (0–255 per channel). */
    public setMeshPaintBrushColor(r: number, g: number, b: number, a = 255): void {
        this.meshPaint.setBrushColor(r, g, b, a);
    }

    /** Set the brush radius in texels. */
    public setMeshPaintBrushRadius(px: number): void {
        this.meshPaint.setBrushRadius(px);
    }

    /** Set brush hardness (0 = fully feathered, 1 = hard disc). */
    public setMeshPaintBrushHardness(h: number): void {
        this.meshPaint.setBrushHardness(h);
    }

    /** Undo the last paint stroke. */
    public undoMeshPaint(): void { this.meshPaint.undo(); }

    /** Redo the last undone paint stroke. */
    public redoMeshPaint(): void { this.meshPaint.redo(); }

    get canUndoMeshPaint(): boolean { return this.meshPaint.canUndo; }
    get canRedoMeshPaint(): boolean { return this.meshPaint.canRedo; }

    /**
     * Restore the mesh's original diffuse texture (the one present before
     * enterMeshPaintMode was called). Call this if the user wants to discard
     * the paint session rather than keep it.
     */
    public restoreMeshPaintOriginalTexture(): void { this.meshPaint.restoreOriginalTexture(); }

    /** True when the active paint session can restore a saved diffuse texture. */
    get meshPaintHasSavedDiffuse(): boolean { return this.meshPaint.hasSavedDiffuse; }

    // ── Kitbash library (Phase B) ─────────────────────────────────────────────

    /**
     * Fetch and parse a kitbash part manifest from the given URL.
     * Call once during app init before using createCharacter3D().
     */
    public async loadKitbashLibrary3D(manifestUrl: string): Promise<void> {
        return this.scene3d.loadKitbashManifest(manifestUrl);
    }

    /**
     * Register parts from a pre-parsed array (e.g. from a bundled import or
     * a unit-test fixture). Alternative to loadKitbashLibrary3D when a fetch
     * is not desired.
     */
    public addKitbashParts3D(parts: import('../types/kitbash-3d').KitbashPartMeta[]): void {
        this.scene3d.addKitbashParts(parts);
    }

    /** Return all catalog parts for the given slot. Empty array when no manifest loaded. */
    public getKitbashParts3D(slot: import('../types/kitbash-3d').CharacterSlot): import('../types/kitbash-3d').KitbashPartMeta[] {
        return this.scene3d.getKitbashParts(slot);
    }

    /** All slot types that have at least one part in the catalog. */
    public getKitbashSlots3D(): import('../types/kitbash-3d').CharacterSlot[] {
        return this.scene3d.getKitbashSlots();
    }

    // ── Character assembly (Phase B) ─────────────────────────────────────────

    /**
     * Assemble a character from the given definition, fetching GLBs for each
     * slot from the kitbash library. Returns the character ID.
     *
     * Requires loadKitbashLibrary3D() to have been called first.
     */
    public async createCharacter3D(
        def: import('../types/kitbash-3d').CharacterDefinition,
        x = 0, y = 0, z = 0,
    ): Promise<string> {
        return this.scene3d.createCharacter(def, x, y, z);
    }

    /**
     * PROTOTYPE: generate a procedural humanoid base body from params (no GLB) and add it to the
     * scene as a rigged SkinnedMesh3D. Params: { height, limbThick, torsoThick, headSize, legLength }.
     * Returns the new mesh + skeleton ids. See docs/specs/character-creation-pipeline.md.
     */
    public async createProceduralBody3D(
        params?: Partial<import('./managers/body-generator').BodyParams>,
        x = 0, y = 0, z = 0,
    ): Promise<{ meshId: string; skeletonId: string }> {
        return this.scene3d.createProceduralBody3D(params, x, y, z);
    }

    /**
     * Build a complete character in ONE call with a SINGLE scene-graph event (body + face + procedural
     * eyes + hair + top + bottom + skin tone). Replaces the ~8 separate calls whose individual scene-graph
     * events each triggered an O(N) host scan → the "every new character is slower" growth. Now the Nth
     * character costs the same as the 1st. Apply render style (or any extra step) after, or wrap this plus
     * your own calls in beginSceneGraphBatch3D()/endSceneGraphBatch3D() to keep it all one event.
     */
    public async createFullCharacter3D(opts: {
        body?: Partial<import('./managers/body-generator').BodyParams>;
        position?: [number, number, number];
        expressionName?: string;     // default 'Neutral'
        eyes?: EyeParams;            // procedural eye params (omit → a plain Neutral face)
        hair?: HairParams;
        top?: ClothingParams;        // params.slot should be 'top'
        bottom?: ClothingParams;     // params.slot should be 'bottom'
        shoes?: ClothingParams;      // params.slot should be 'shoes'
        socks?: ClothingParams;      // params.slot should be 'socks'
        undershirt?: ClothingParams; // params.slot should be 'undershirt'
        underpants?: ClothingParams; // params.slot should be 'underpants'
        skinTone?: string;           // hex, e.g. '#e8b89a'
    }): Promise<{ meshId: string; skeletonId: string; nodeIds: string[] }> {
        const [x, y, z] = opts.position ?? [0, 0, 0];
        this.beginSceneGraphBatch3D();
        try {
            const { meshId, skeletonId } = await this.scene3d.createProceduralBody3D(opts.body, x, y, z);
            this.ensureFace3D(meshId);
            const exprId = this.createFaceExpression3D(meshId, opts.expressionName ?? 'Neutral');
            if (exprId && opts.eyes) this.setFaceExpressionProcedural3D(meshId, exprId, opts.eyes);
            if (opts.hair)   this.setHairParams3D(meshId, opts.hair);
            if (opts.top)        this.setClothingParams3D(meshId, opts.top);
            if (opts.bottom)     this.setClothingParams3D(meshId, opts.bottom);
            if (opts.undershirt) this.setClothingParams3D(meshId, opts.undershirt);
            if (opts.underpants) this.setClothingParams3D(meshId, opts.underpants);
            if (opts.socks)      this.setClothingParams3D(meshId, opts.socks);   // under the shoes
            if (opts.shoes)      this.setClothingParams3D(meshId, opts.shoes);
            if (opts.skinTone) this.setSkinTone3D(meshId, opts.skinTone);
            // The 3D nodes this character added (flat siblings under root): body + face decal + hair + any of
            // the 6 garment slots. Returned so the host pushes just these into its mesh/outliner lists — no full
            // re-scan. Fetch each with getMesh3D(id) / getNode3D(id).
            const nodeIds = [
                meshId,
                this.scene3d.getEyesMeshId(meshId),
                this.scene3d.getHairMeshId(meshId),
                this.scene3d.getClothingMeshId(meshId, 'top'),
                this.scene3d.getClothingMeshId(meshId, 'bottom'),
                this.scene3d.getClothingMeshId(meshId, 'undershirt'),
                this.scene3d.getClothingMeshId(meshId, 'underpants'),
                this.scene3d.getClothingMeshId(meshId, 'socks'),
                this.scene3d.getClothingMeshId(meshId, 'shoes'),
            ].filter((id): id is string => !!id);
            return { meshId, skeletonId, nodeIds };
        } finally {
            this.endSceneGraphBatch3D();   // one coalesced onSceneGraphChanged for the whole character
        }
    }

    /** Set a body's skin tone (hex, e.g. '#e8b89a') — live; persists with the document. */
    public setSkinTone3D(bodyMeshId: string, hex: string): void { this.scene3d.setSkinTone(bodyMeshId, hex); }
    /** A body's current skin tone as hex ('#rrggbb'), or null. */
    public getSkinTone3D(bodyMeshId: string): string | null { return this.scene3d.getSkinTone(bodyMeshId); }

    /**
     * Live-edit an existing procedural body: regenerate its geometry + skeleton in place and re-fit all
     * attached overlays (hair, garments, face) to the new shape. Merges over the body's current params,
     * so pass just the changed field(s). Call on each slider change.
     */
    public async setBodyParams3D(bodyMeshId: string, params: Partial<import('./managers/body-generator').BodyParams>): Promise<void> {
        // The body mesh updates IN PLACE (keeps its own texture/style), but the re-fit REGENERATES the
        // hair, garments, and eye decal with new ids — so capture their render-style + texture overrides
        // first and re-apply after, or a body-proportion tweak would silently wipe them.
        const partIds = (): (string | null)[] => [
            this.scene3d.getHairMeshId(bodyMeshId),
            this.scene3d.getClothingMeshId(bodyMeshId, 'top'),
            this.scene3d.getClothingMeshId(bodyMeshId, 'bottom'),
            this.scene3d.getEyesMeshId(bodyMeshId),
        ];
        const before = partIds();
        const caps = before.map(id => ({ style: (id ? this.scene3d.getMesh(id) : null)?.material.renderStyle, mgr: id ? this._uvPaintTextures.get(id) : undefined }));
        await this.scene3d.setBodyParams(bodyMeshId, params);
        const after = partIds();
        before.forEach((oldId, i) => this._carryPartOverrides(oldId, after[i], caps[i].style, caps[i].mgr));
    }
    /** A body's current procedural params (to seed the body sliders), or null. */
    public getBodyParams3D(bodyMeshId: string): import('./managers/body-generator').BodyParams | null {
        return this.scene3d.getBodyParams(bodyMeshId);
    }

    /**
     * Live ghost preview of a procedural body — call on every slider change to show a translucent
     * hologram that updates instantly (no scene node / undo churn) before committing with
     * createProceduralBody3D. Clear with clearProceduralBodyPreview3D().
     */
    public async previewProceduralBody3D(
        params?: Partial<import('./managers/body-generator').BodyParams>,
    ): Promise<void> {
        return this.scene3d.previewProceduralBody3D(params);
    }

    /** Hide the procedural-body ghost preview (e.g. when leaving the Character tool without committing). */
    public clearProceduralBodyPreview3D(): void {
        this.scene3d.clearProceduralBodyPreview();
    }

    // ── Building Creator (procedural buildings; host contract: docs/ui/building-creator.md) ──────────────
    /** Add a new procedural building at (x,y,z). Auto-frames the camera on it (pass frame:false to suppress).
     *  Returns its container node id (host selection handle) + metadata. */
    public createProceduralBuilding3D(params?: Partial<BuildingParams>, x = 0, y = 0, z = 0, opts?: { scale?: number; frame?: boolean }): { id: string; meta: BuildingMeta } {
        return this.buildings.create(params, { x, y, z }, opts);
    }
    /** Set a building's display scale (world units per metre; e.g. 0.1 = 1 unit : 10 m). */
    public setBuildingScale3D(id: string, unitsPerMetre: number): boolean { return this.buildings.setScale(id, unitsPerMetre); }
    /** Set a building's scale by metres-per-unit (the "1 : N" ratio). */
    public setBuildingMetersPerUnit3D(id: string, metresPerUnit: number): boolean { return this.buildings.setMetersPerUnit(id, metresPerUnit); }
    /** Model↔real scale info for the host UI (ratio + real/display dimensions). */
    public getBuildingScaleInfo3D(id: string): import('./managers/building-manager').BuildingScaleInfo | null { return this.buildings.getScaleInfo(id); }
    /** Frame the camera on a building. */
    public frameBuilding3D(id: string): boolean { return this.buildings.frame(id); }
    /** Live-edit a building's params (merge over current) and regenerate in place — same node id, selection kept. */
    public setBuildingParams3D(id: string, params: Partial<BuildingParams>): boolean {
        return this.buildings.setParams(id, params);
    }
    /** Read a building's current params (to seed host sliders). */
    public getBuildingParams3D(id: string): BuildingParams | null { return this.buildings.getParams(id); }
    /** Building metadata (door / sign slots / roof anchor) for the sim + brandable-surface layer. */
    public getBuildingMeta3D(id: string): BuildingMeta | null { return this.buildings.getMeta(id); }
    /** Is this node id a procedural building (→ show the "Edit Building" affordance)? */
    public isProceduralBuilding3D(id: string): boolean { return this.buildings.isBuilding(id); }
    /** Move/rotate a placed building. */
    public setBuildingTransform3D(id: string, t: Partial<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }>): boolean {
        return this.buildings.setTransform(id, t);
    }
    /** Remove a building. */
    public removeBuilding3D(id: string): boolean { return this.buildings.remove(id); }
    /** List all buildings (host outliner / picker). */
    public listBuildings3D(): { id: string; name: string; category: BuildingParams['category']; archetype: string }[] { return this.buildings.list(); }
    /** Available archetype (style) names for the Creator's style picker. */
    public buildingArchetypeNames3D(): string[] { return this.buildings.archetypeNames(); }
    /** The preset params for a named archetype (e.g. to preview a style before applying). */
    public buildingArchetypeParams3D(name: string): Partial<BuildingParams> | null { return this.buildings.archetypeParams(name); }
    /** Regenerate all buildings from a loaded save's markers (params-only persistence). Call after document load. */
    public restoreBuildingsFromSave3D(): number { return this.buildings.restoreFromSave(); }

    // ── Building Editor mode + attached-foliage placement (grid tool; spec: foliage-generator.md item 4) ──
    /** Enter Building Editor mode on a building (frame it + show the ground grid for the foliage placement tool). */
    public enterBuildingEditMode3D(id: string): boolean { return this.buildings.enterEditMode(id); }
    public exitBuildingEditMode3D(): void { this.buildings.exitEditMode(); }
    /** Can a plant of ~`radius` sit at building-local (x,z) without overlapping the building or an existing plant? */
    public canPlaceBuildingFoliage3D(id: string, x: number, z: number, radius?: number): boolean { return this.buildings.canPlaceFoliage(id, x, z, radius); }
    /** Attach a foliage instance to a building at building-local (x,z). Returns its index, or -1 if it overlaps
     *  (pass `{ checkOverlap:false }` to force). Regenerates the building — the foliage travels + persists with it. */
    public addBuildingFoliage3D(id: string, placement: import('../world/building').FoliagePlacement, opts?: { checkOverlap?: boolean }): number { return this.buildings.addFoliage(id, placement, opts); }
    public removeBuildingFoliage3D(id: string, index: number): boolean { return this.buildings.removeFoliage(id, index); }
    public clearBuildingFoliage3D(id: string): boolean { return this.buildings.clearFoliage(id); }
    public getBuildingFoliage3D(id: string): import('../world/building').FoliagePlacement[] { return this.buildings.getFoliage(id); }

    // ── Foliage Creator (freestanding procedural foliage; spec: docs/specs/foliage-generator.md) ──────────
    /** Add a freestanding foliage instance at (x,y,z). Auto-frames. Returns its container node id + metadata. */
    public createProceduralFoliage3D(params?: Partial<FoliageParams>, x = 0, y = 0, z = 0, opts?: { scale?: number; frame?: boolean }): { id: string; meta: FoliageMeta } {
        return this.foliage.create(params, { x, y, z }, opts);
    }
    public setFoliageParams3D(id: string, params: Partial<FoliageParams>): boolean { return this.foliage.setParams(id, params); }
    public getFoliageParams3D(id: string): FoliageParams | null { return this.foliage.getParams(id); }
    public getFoliageMeta3D(id: string): FoliageMeta | null { return this.foliage.getMeta(id); }
    public isProceduralFoliage3D(id: string): boolean { return this.foliage.isFoliage(id); }
    public setFoliageTransform3D(id: string, t: Partial<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }>): boolean { return this.foliage.setTransform(id, t); }
    public setFoliageScale3D(id: string, unitsPerMetre: number): boolean { return this.foliage.setScale(id, unitsPerMetre); }
    public getFoliageScaleInfo3D(id: string): { scale: number; metersPerUnit: number; realHeightM: number; displayHeightUnits: number } | null { return this.foliage.getScaleInfo(id); }
    public frameFoliage3D(id: string): boolean { return this.foliage.frame(id); }
    public removeFoliage3D(id: string): boolean { return this.foliage.remove(id); }
    public listFoliage3D(): { id: string; name: string; type: FoliageParams['type'] }[] { return this.foliage.list(); }
    public foliageTypeNames3D(): string[] { return this.foliage.typeNames(); }
    public restoreFoliageFromSave3D(): number { return this.foliage.restoreFromSave(); }

    /** Regenerate ALL procedural objects (City + buildings + foliage) from a loaded save's params-only markers.
     *  Call this ONCE after a document finishes loading — it replaces calling `world.restoreFromSave()` +
     *  `restoreBuildingsFromSave3D()` + `restoreFoliageFromSave3D()` separately (so none is forgotten). Order matters
     *  (City first, then its sub-objects). Returns what was restored. */
    public restoreProceduralFromSave3D(): { city: boolean; buildings: number; blocks: number; foliage: number } {
        const city = this.world.restoreFromSave();
        const buildings = this.buildings.restoreFromSave();
        const blocks = this.blocks.restoreFromSave();
        const foliage = this.foliage.restoreFromSave();
        return { city, buildings, blocks, foliage };
    }

    // ── Neighborhood Blocks (Tier-2 instancing — many buildings drawn from a few shared geometries) ──
    public createBlock3D(transform?: { x?: number; y?: number; z?: number; ry?: number }, opts?: { starter?: boolean | number }): string { return this.blocks.create(transform, opts); }
    public isBlock3D(id: string): boolean { return this.blocks.isBlock(id); }
    public addBuildingToBlock3D(id: string, params: Partial<BuildingParams>, placement?: { x?: number; y?: number; z?: number; ry?: number }): number { return this.blocks.addBuilding(id, params, placement); }
    public setBlockBuildingPlacement3D(id: string, index: number, placement: { x?: number; y?: number; z?: number; ry?: number }): boolean { return this.blocks.setBuildingPlacement(id, index, placement); }
    public setBlockBuildingParams3D(id: string, index: number, params: Partial<BuildingParams>): boolean { return this.blocks.setBuildingParams(id, index, params); }
    public getBlockBuildingParams3D(id: string, index: number): BuildingParams | null { return this.blocks.getBuildingParams(id, index); }
    public getBlockBuildings3D(id: string): { index: number; archetype: string; category: BuildingParams['category']; placement: { x: number; y: number; z: number; ry: number } }[] { return this.blocks.getBuildings(id); }
    public removeBlockBuilding3D(id: string, index: number): boolean { return this.blocks.removeBuilding(id, index); }
    public setBlockTransform3D(id: string, t: { x?: number; y?: number; z?: number; ry?: number }): boolean { return this.blocks.setTransform(id, t); }
    public setBlockScale3D(id: string, unitsPerMetre: number): boolean { return this.blocks.setScale(id, unitsPerMetre); }
    public removeBlock3D(id: string): boolean { return this.blocks.remove(id); }
    public listBlocks3D(): { id: string; name: string; buildings: number }[] { return this.blocks.list(); }
    public getBlockStats3D(id: string): { buildings: number; distinctInstancedGeometries: number; totalInstances: number } | null { return this.blocks.stats(id); }
    public restoreBlocksFromSave3D(): number { return this.blocks.restoreFromSave(); }

    /** Apply a named preset pose (T-pose / A-pose / Relaxed / Wave) to a procedural-body skeleton. */
    public async applyBodyPose3D(skeletonId: string, poseName: string): Promise<boolean> {
        return this.scene3d.applyBodyPose3D(skeletonId, poseName);
    }

    /** List available preset-pose names for the pose dropdown. */
    public async getBodyPoseNames3D(): Promise<string[]> {
        return this.scene3d.getBodyPoseNames3D();
    }

    /**
     * Swap one slot on a live character without rebuilding the whole character.
     * The old mesh is removed and replaced by the new part's mesh.
     */
    public async swapCharacterSlot3D(
        charId: string,
        slot: import('../types/kitbash-3d').CharacterSlot,
        partId: string,
    ): Promise<void> {
        return this.scene3d.swapCharacterSlot(charId, slot, partId);
    }

    /** Apply a diffuse color tint (0–255 each channel) to one slot's mesh. */
    public setCharacterSlotColor3D(
        charId: string,
        slot: import('../types/kitbash-3d').CharacterSlot,
        r: number, g: number, b: number,
    ): void {
        this.scene3d.setCharacterSlotColor(charId, slot, r, g, b);
    }

    /** Remove a character and all its skeleton + mesh nodes from the scene. */
    public removeCharacter3D(charId: string): void {
        this.scene3d.removeCharacter(charId);
    }

    /** Get the CharacterDefinition for an existing character, or null. */
    public getCharacterDefinition3D(charId: string): import('../types/kitbash-3d').CharacterDefinition | null {
        return this.scene3d.getCharacter(charId)?.definition ?? null;
    }

    /** Get all assembled characters in the scene. */
    public getAllCharacters3D(): import('../types/kitbash-3d').CharacterData[] {
        return this.scene3d.getAllCharacters();
    }

    // ── Grease Pencil 3D API (Phase C) ────────────────────────────────

    /**
     * Create a new Grease Pencil object in the scene. Returns its ID.
     * A default "Layer 1" is added automatically.
     * @param skeletonId  Optional: ID of the Skeleton3D that drives bone-parented strokes.
     */
    public createGpObject3D(name = 'GP Object', skeletonId?: string): string {
        return this.scene3d.createGpObject(name, skeletonId);
    }

    /** Remove a GP object and all its layers/strokes from the scene. */
    public removeGpObject3D(gpId: string): void { this.scene3d.removeGpObject(gpId); }

    /** Add a layer to a GP object. Returns the new layer ID. */
    public addGpLayer3D(gpId: string, name = 'Layer'): string {
        return this.scene3d.addGpLayer(gpId, name);
    }

    /** Remove a layer from a GP object. */
    public removeGpLayer3D(gpId: string, layerId: string): void {
        this.scene3d.removeGpLayer(gpId, layerId);
    }

    /**
     * Begin a new stroke on a GP layer. Returns the strokeId.
     * Call addGpPoint3D() for each pointer event, then endGpStroke3D().
     */
    public beginGpStroke3D(
        gpId: string,
        layerId: string,
        color: { r: number; g: number; b: number; a: number },
        baseWidth: number,
        options?: {
            fillColor?:  { r: number; g: number; b: number; a: number };
            parentJoint?: string;
            closed?:     boolean;
            frame?:      number;
        },
    ): string {
        return this.scene3d.beginGpStroke(gpId, layerId, color, baseWidth, options);
    }

    /** Add a world-space point to the currently active GP stroke. */
    public addGpPoint3D(x: number, y: number, z: number, pressure = 1, opacity = 1): void {
        this.scene3d.addGpPoint(x, y, z, pressure, opacity);
    }

    /**
     * Finalize the active GP stroke.
     * Strokes with fewer than 2 points are discarded automatically.
     */
    public endGpStroke3D(): void { this.scene3d.endGpStroke(); }

    /**
     * Erase GP strokes within `radius` world units of `worldPos` on a layer.
     * Pass `frame` to target a keyframe's stroke list instead of base strokes.
     */
    public eraseGpStrokes3D(
        gpId: string,
        layerId: string,
        worldPos: [number, number, number],
        radius: number,
        frame?: number,
    ): void {
        this.scene3d.eraseGpStrokes(gpId, layerId, worldPos, radius, frame);
    }

    /** Snapshot a layer's current strokes as a keyframe at `frame`. */
    public setGpKeyframe3D(gpId: string, layerId: string, frame: number): void {
        this.scene3d.setGpKeyframe(gpId, layerId, frame);
    }

    /** Remove the keyframe snapshot at `frame` from a layer (falls back to base strokes). */
    public clearGpKeyframe3D(gpId: string, layerId: string, frame: number): void {
        this.scene3d.clearGpKeyframe(gpId, layerId, frame);
    }

    /**
     * Set the render order for a GP object within the GP pass.
     * 0 (default) draws after particles. Negative values draw before particles (background).
     * Higher positive values draw on top within the GP group.
     */
    public setGpRenderOrder3D(gpId: string, order: number): void {
        this.scene3d.setGpRenderOrder(gpId, order);
    }

    /** List all GP objects in the scene. Use on document load to populate the GP panel. */
    public getAllGpObjects3D(): { id: string; name: string; skeletonId?: string }[] {
        return this.scene3d.getAllGpObjectDescriptors();
    }

    /** List all layers for a GP object (id, name, visible, opacity). */
    public getGpLayers3D(gpId: string): { id: string; name: string; visible: boolean; opacity: number }[] {
        return this.scene3d.getGpLayers(gpId);
    }

    /** Show or hide a GP layer. */
    public setGpLayerVisible3D(gpId: string, layerId: string, visible: boolean): void {
        this.scene3d.setGpLayerVisible(gpId, layerId, visible);
    }

    /** Set the opacity of a GP layer (0–1). */
    public setGpLayerOpacity3D(gpId: string, layerId: string, opacity: number): void {
        this.scene3d.setGpLayerOpacity(gpId, layerId, opacity);
    }

    /** Rename a GP object. */
    public renameGpObject3D(gpId: string, name: string): void {
        this.scene3d.renameGpObject(gpId, name);
    }

    /** Rename a layer within a GP object. */
    public renameGpLayer3D(gpId: string, layerId: string, name: string): void {
        this.scene3d.renameGpLayer(gpId, layerId, name);
    }

    // ── GP draw mode ──────────────────────────────────────────────────────────

    /**
     * Enter GP draw or erase mode. Canvas pointer events are hooked automatically.
     *
     * - In `'draw'` mode: pointerdown starts a stroke; pointermove adds world-space
     *   points (snapping to mesh surfaces); pointerup finalises the stroke.
     * - In `'erase'` mode: dragging erases nearby strokes within `eraseRadius`.
     *
     * `depthMode: 'surface'` (default) snaps points to the nearest mesh surface
     * and falls back to the last known depth when the pointer misses. Use
     * `depthMode: 'fixed'` with `depth` (0–1 linear) to draw on a fixed plane.
     *
     * @param gpId      GP object to draw on.
     * @param layerId   Layer within that GP object.
     * @param opts      Optional stroke settings — also settable via setGpDrawSettings3D().
     */
    public enterGpDrawMode3D(
        gpId: string,
        layerId: string,
        opts?: {
            mode?: 'draw' | 'erase';
            color?: { r: number; g: number; b: number; a: number };
            baseWidth?: number;
            fillColor?: { r: number; g: number; b: number; a: number } | null;
            parentJoint?: string | null;
            closed?: boolean;
            eraseRadius?: number;
            depth?: number;
            depthMode?: 'surface' | 'fixed';
        },
    ): void {
        this.scene3d.enterGpDrawMode(gpId, layerId, opts);
    }

    /** Exit GP draw mode and remove canvas pointer listeners. */
    public exitGpDrawMode3D(): void { this.scene3d.exitGpDrawMode(); }

    /** Whether GP draw mode is currently active. */
    public get isGpDrawMode3D(): boolean { return this.scene3d.isGpDrawModeActive(); }

    /** Enter face-select mode: hovering the mesh highlights faces; clicking locks the drawing plane. */
    public enterGpFaceSelectMode3D(): void { this.scene3d.enterGpFaceSelectMode(); }

    /** Exit face-select mode. Does NOT clear the locked drawing plane. */
    public exitGpFaceSelectMode3D(): void { this.scene3d.exitGpFaceSelectMode(); }

    /** Whether GP face-select mode is currently active. */
    public get isGpFaceSelectMode3D(): boolean { return this.scene3d.isGpFaceSelectActive(); }

    /**
     * Update the offset (world units) on the currently locked GP drawing plane.
     * The plane point is re-projected along the face normal by this amount.
     */
    public setGpDrawPlaneOffset3D(offset: number): void { this.scene3d.setGpDrawPlaneOffset(offset); }

    /** Clear the locked GP drawing plane (user must re-select a face before drawing again). */
    public clearGpDrawPlane3D(): void { this.scene3d.clearGpDrawPlane(); }

    /**
     * Read back the currently locked GP drawing plane.
     * Returns null if no face has been selected yet.
     */
    public getGpDrawPlane3D(): { meshId: string; triangleIndex: number; offset: number } | null {
        return this.scene3d.getGpDrawPlane();
    }

    /**
     * Update stroke settings while in GP draw mode (e.g. on color/width slider change).
     * Safe to call before entering draw mode — values persist until overwritten.
     */
    public setGpDrawSettings3D(opts: {
        mode?: 'draw' | 'erase';
        color?: { r: number; g: number; b: number; a: number };
        baseWidth?: number;
        fillColor?: { r: number; g: number; b: number; a: number } | null;
        parentJoint?: string | null;
        closed?: boolean;
        eraseRadius?: number;
        depth?: number;
        depthMode?: 'surface' | 'fixed';
    }): void {
        this.scene3d.setGpDrawSettings(opts);
    }

    // ── EditMesh — Phase 2 modeling API ───────────────────────────────────────

    /**
     * Convert mesh `meshId` to an editable EditMesh. Required before using any
     * edit operation. Idempotent — safe to call if the mesh is already editable.
     * Returns false if the mesh is not found.
     */
    public makeEditable3D(meshId: string): boolean {
        return this.meshEdit.makeEditable(meshId);
    }

    /** Enter mesh edit mode, initializing selection state. */
    public enterMeshEditMode3D(meshId: string): boolean {
        const ok = this.meshEdit.enterEditMode(meshId);
        if (ok) {
            this.scene3d.enableMeshEditOrbit(meshId);
        }
        return ok;
    }

    /** Exit mesh edit mode, clearing selection. */
    public exitMeshEditMode3D(): void {
        this.meshEdit.exitEditMode();
        this.scene3d.disableMeshEditOrbit();
    }

    /** True when a mesh is currently in edit mode. */
    get isMeshEditMode3D(): boolean { return this.meshEdit.isEditing; }

    // ── Selection ─────────────────────────────────────────────────────────────

    public selectVertex3D(meshId: string, vIdx: number, addToSelection = false): void {
        this.meshEdit.selectVertex(meshId, vIdx, addToSelection);
    }

    public selectFace3D(meshId: string, fIdx: number, addToSelection = false): void {
        this.meshEdit.selectFace(meshId, fIdx, addToSelection);
    }

    public clearMeshSelection3D(meshId: string): void {
        this.meshEdit.clearSelection(meshId);
    }

    /** Get the current edit-mode selection for `meshId`. Returns null if not editing. */
    public getEditSelection3D(meshId: string) {
        return this.meshEdit.getSelection(meshId);
    }

    // ── Doc-friendly aliases (match mesh-editing.md naming) ──────────────────

    /** @alias enterMeshEditMode3D */
    public enterEditMode3D(meshId: string): boolean { return this.enterMeshEditMode3D(meshId); }
    /** @alias exitMeshEditMode3D */
    public exitEditMode3D(): void { this.exitMeshEditMode3D(); }
    /** @alias isMeshEditMode3D */
    public isEditing3D(): boolean { return this.isMeshEditMode3D; }
    /** The mesh ID currently in edit mode, or null. */
    public activeMeshId3D(): string | null { return this.meshEdit.activeMeshId; }
    /** @alias selectVertex3D */
    public selectEditVertex3D(meshId: string, vIdx: number, add = false): void { this.selectVertex3D(meshId, vIdx, add); }
    /** @alias selectFace3D */
    public selectEditFace3D(meshId: string, fIdx: number, add = false): void { this.selectFace3D(meshId, fIdx, add); }
    /** @alias clearMeshSelection3D */
    public clearEditSelection3D(meshId: string): void { this.clearMeshSelection3D(meshId); }
    /** @alias moveVertex3D */
    public moveEditVertex3D(meshId: string, vIdx: number, dx: number, dy: number, dz: number): boolean { return this.moveVertex3D(meshId, vIdx, dx, dy, dz); }
    /** @alias extrudeFace3D */
    public extrudeEditFace3D(meshId: string, fIdx: number, distance: number): boolean { return this.extrudeFace3D(meshId, fIdx, distance); }
    /** @alias insetFace3D */
    public insetEditFace3D(meshId: string, fIdx: number, amount: number): boolean { return this.insetFace3D(meshId, fIdx, amount); }
    /** @alias deleteFace3D */
    public deleteEditFace3D(meshId: string, fIdx: number): boolean { return this.deleteFace3D(meshId, fIdx); }
    /** @alias weldVertices3D */
    public weldEditVertices3D(meshId: string, v1: number, v2: number): boolean { return this.weldVertices3D(meshId, v1, v2); }
    /** Return the EditMesh for `meshId`, or null if none. */
    public getEditMesh3D(meshId: string) { return this.getMesh3D(meshId)?.editMesh ?? null; }

    // ── Pointer controller — Salsa-owned canvas interaction for edit mode ─────

    /**
     * Attach canvas pointer handlers for mesh edit mode.
     * Salsa owns all picking logic (face/vertex/edge), cursor management, and
     * vertex drag — Frogmarks only needs to call this once on entering edit mode.
     *
     * `onSelectionChange` is called whenever the selection changes so the panel
     * can refresh its displayed counts and enable/disable operation buttons.
     */
    public attachMeshEditPointerHandlers(
        canvas: HTMLCanvasElement,
        meshId: string,
        onSelectionChange?: () => void,
    ): void {
        this._meshEditPointerController.attach(canvas, meshId, onSelectionChange);
    }

    /** Detach pointer handlers and restore the cursor. Call on exiting edit mode. */
    public detachMeshEditPointerHandlers(): void {
        this._meshEditPointerController.detach();
    }

    /**
     * Switch the active selection mode for the pointer controller.
     * Must be called when the user clicks a mode tab (Vertex / Face / Edge).
     */
    public setMeshEditSelectionMode(mode: MeshEditSelectionMode): void {
        this._meshEditPointerController.setMode(mode);
    }

    // ── Destructive edit operations (all undoable via undo3D / redo3D) ────────

    /** Move vertex `vIdx` by (dx, dy, dz) in object space. */
    public moveVertex3D(meshId: string, vIdx: number, dx: number, dy: number, dz: number): boolean {
        return this.meshEdit.moveVertex(meshId, vIdx, dx, dy, dz);
    }

    /** Extrude face `fIdx` by `distance` units along its face normal. */
    public extrudeFace3D(meshId: string, fIdx: number, distance: number): boolean {
        return this.meshEdit.extrudeFace(meshId, fIdx, distance);
    }

    /** Inset face `fIdx` by `amount` (0 = no inset, 1 = collapse to center). */
    public insetFace3D(meshId: string, fIdx: number, amount: number): boolean {
        return this.meshEdit.insetFace(meshId, fIdx, amount);
    }

    /** Delete face `fIdx`. */
    public deleteFace3D(meshId: string, fIdx: number): boolean {
        return this.meshEdit.deleteFace(meshId, fIdx);
    }

    /** Weld vertex `v2` into `v1` (move v1 to midpoint, remove v2). */
    public weldVertices3D(meshId: string, v1: number, v2: number): boolean {
        return this.meshEdit.weldVertices(meshId, v1, v2);
    }

    // ── Phase 3 — Loop cut, edge dissolve ─────────────────────────────────────

    /**
     * Select an edge by its half-edge index. Clears vertex/face selection.
     * Use addToSelection=true to multi-select edges.
     */
    public selectEdge3D(meshId: string, halfEdgeIdx: number, addToSelection = false): void {
        this.meshEdit.selectEdge(meshId, halfEdgeIdx, addToSelection);
    }

    /**
     * Insert a new edge loop through a chain of quad faces.
     * `t` controls placement along the edge (0=at start vertex, 1=at end vertex, 0.5=midpoint).
     * The loop traverses adjacent quads in both directions from the starting half-edge.
     * Stops at mesh boundaries and non-quad faces. Undoable.
     */
    public loopCut3D(meshId: string, halfEdgeIdx: number, t = 0.5): boolean {
        return this.meshEdit.loopCut(meshId, halfEdgeIdx, t);
    }

    /**
     * Remove the shared edge between two adjacent faces and merge them into one polygon.
     * The half-edge must have a twin (i.e. not be a boundary edge). Undoable.
     */
    public dissolveEdge3D(meshId: string, halfEdgeIdx: number): boolean {
        return this.meshEdit.dissolveEdge(meshId, halfEdgeIdx);
    }

    /**
     * Bevel the edge at `halfEdgeIdx`, replacing it with a quad chamfer strip.
     * `amount` (0–1) controls how far the new vertices slide along adjacent edges.
     * Only works on interior edges. Undoable.
     */
    public bevelEdge3D(meshId: string, halfEdgeIdx: number, amount: number): boolean {
        return this.meshEdit.bevelEdge(meshId, halfEdgeIdx, amount);
    }

    /**
     * Run a smart-project (box/triplanar) UV unwrap on the mesh.
     * Assigns UV coordinates to every vertex by projecting along the dominant
     * normal axis. UVs are normalised into [0, 1]. Undoable.
     */
    public autoUnwrap3D(meshId: string): boolean {
        return this.meshEdit.autoUnwrap(meshId);
    }

    /**
     * Island-aware smart project: each UV island is unwrapped using its own
     * average face normal as the projection axis. Islands will overlap after
     * this call; follow with `packUVIslands3D` to lay them out. Undoable.
     */
    public unwrapIslands3D(meshId: string): boolean {
        return this._uvEdit.unwrapIslands(meshId);
    }

    /**
     * Project every vertex using the normal of `faceIndex` as the projection axis
     * ("Follow Active Face"). Normalises result to [0, 1]. Undoable.
     */
    public followActiveFaceUV3D(meshId: string, faceIndex: number): boolean {
        return this._uvEdit.followActiveFace(meshId, faceIndex);
    }

    /**
     * Shelf-pack all UV islands into [0, 1] UV space with a uniform `margin`.
     * Does not alter island shape; call after any unwrap operation. Undoable.
     */
    public packUVIslands3D(meshId: string, margin = 0.002): boolean {
        return this._uvEdit.packIslands(meshId, margin);
    }

    // ── LiveTextureMode ───────────────────────────────────────────────────────

    /**
     * Link a raster layer to a mesh as its live diffuse texture.
     * From this point on, `syncLiveTextures3D()` pushes the layer's GPUTexture
     * to the mesh's diffuse channel with zero CPU→GPU copies.
     */
    public linkLiveTexture3D(meshId: string, layerId: string): void {
        this._liveTexture.link(meshId, layerId);
        this.scheduleRender();
    }

    /** Remove the live texture link and clear the mesh's diffuse channel. */
    public unlinkLiveTexture3D(meshId: string): void {
        this._liveTexture.unlink(meshId);
        this.scheduleRender();
    }

    /**
     * Sync all linked meshes from their raster layers.
     * Call after each raster stroke completes (pointer-up / stroke-end).
     */
    public syncLiveTextures3D(): void {
        this._liveTexture.syncAll();
        this.scheduleRender();
    }

    /** Returns true if `meshId` has an active live texture link. */
    public isLiveTextureLinked3D(meshId: string): boolean {
        return this._liveTexture.isLinked(meshId);
    }

    /** Returns the layer ID linked to `meshId`, or null if not linked. */
    public getLiveTextureLayerId3D(meshId: string): string | null {
        return this._liveTexture.getLinkedLayerId(meshId);
    }

    // ── UV-space texture painting ─────────────────────────────────────────────

    /**
     * Return (creating if needed) a CPU-side HTMLCanvasElement that backs the
     * mesh's diffuse texture in UV space.  Frogmarks draws strokes onto this
     * canvas using its 2D context (UV [0,1] → pixel: px = u*size, py = v*size),
     * then calls `commitUVTexture3D` on pointer-up to push to GPU.
     *
     * Pass the returned canvas as the `texture` argument of `uvRenderer.draw()`
     * so the UV editor background shows the current paint state.
     */
    public ensureUVPaintCanvas3D(meshId: string, size = 1024): HTMLCanvasElement | null {
        const node = this.sceneGraph.findNodeById(meshId);
        if (!node) return null;
        let canvas = this._uvPaintCanvases.get(meshId);
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.width  = size;
            canvas.height = size;
            this._uvPaintCanvases.set(meshId, canvas);
        }
        return canvas;
    }

    /**
     * Upload the CPU paint canvas for `meshId` to a new GPUTexture and set it
     * as the mesh's diffuse texture.  Call this on pointer-up after strokes.
     */
    public commitUVTexture3D(meshId: string): void {
        const node = this.sceneGraph.findNodeById(meshId);
        if (!node) return;
        const canvas = this._uvPaintCanvases.get(meshId);
        if (!canvas) return;
        const device = this.webgpuRenderer?.getDevice();
        if (!device) return;

        const texture = device.createTexture({
            size:   [canvas.width, canvas.height, 1],
            format: 'rgba8unorm',
            usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture(
            { source: canvas, flipY: false },
            { texture },
            [canvas.width, canvas.height],
        );

        const mesh = node as import('../scene-graph/shapes/mesh-3d').Mesh3D;
        mesh.diffuseTexture   = texture;
        mesh.material.hasTexture = true;
        mesh.gpuDirty = true;
        this.scheduleRender();
    }

    // ── UV-space texture painting (GPU brush) ─────────────────────────────────
    //
    // Paint a mesh's texture by brushing directly on its unwrapped UV in the UV
    // editor pane: islands visible, strokes land on the texture and show live on
    // the 3D mesh. Supersedes the CPU ensureUVPaintCanvas3D/commitUVTexture3D
    // prototype above. See UVPaintController + docs/ui/uv-editor.md.

    /**
     * Lazily create the per-mesh paint texture (paintable + sampleable) and point
     * the mesh's diffuse channel at it. The texture reference is stable, so brush
     * dabs show on the mesh live. Returns the backing texture manager (or null).
     */
    private _ensureUVPaintTexture(meshId: string, size = 1024): RasterTextureManager | null {
        const device = this.webgpuRenderer?.getDevice();
        const mesh = this.scene3d.getMesh(meshId);
        if (!device || !mesh) return null;
        let mgr = this._uvPaintTextures.get(meshId);
        const isNew = !mgr;
        if (!mgr) {
            mgr = new RasterTextureManager(device);
            this._uvPaintTextures.set(meshId, mgr);
        }
        // Preserve an existing (e.g. restored-from-disk) texture's size; only a
        // brand-new manager uses the default size.
        const cur = mgr.getTextureSize();
        const tex = mgr.ensureTexture(cur.w || size, cur.h || size);
        // Start a fresh paint texture as a white canvas — a blank rgba8 texture is
        // transparent black, which the opaque textured shader would draw as a black
        // mesh until painted. (Restored textures already have content; skip.)
        if (isNew) {
            // A garment starts its paint canvas from its CURRENT base+trim colour (so the user paints on
            // top, not over blank white); everything else clears to white.
            const seeded = this.scene3d.seedGarmentPaintTexture(meshId, mgr);
            if (!seeded) {
                const enc = device.createCommandEncoder();
                enc.beginRenderPass({
                    colorAttachments: [{ view: tex.createView(), clearValue: { r: 1, g: 1, b: 1, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
                }).end();
                device.queue.submit([enc.finish()]);
            }
        }
        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        mesh.setDiffuseColor(1, 1, 1, 1);   // paint texture is the surface → show it verbatim (no base-colour multiply)
        mesh.gpuDirty = true;
        return mgr;
    }

    /** Re-apply painted garment textures (keyed `${bodyId}:${slot}`) onto the garments that
     *  `restoreClothingRigs` just rebuilt — their mesh ids are new each load, so resolve via the rig. */
    private async _restoreClothingTextures(clothBlobs: Map<string, ArrayBuffer>): Promise<void> {
        const device = this.webgpuRenderer?.getDevice();
        if (!device || !this.scene3d) return;
        for (const [key, buf] of clothBlobs) {
            const i = key.lastIndexOf(':');
            if (i < 0 || !buf.byteLength) continue;
            const bodyId = key.slice(0, i), slot = key.slice(i + 1) as 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants';
            const meshId = this.scene3d.getClothingMeshId(bodyId, slot);
            const mesh = meshId ? this.scene3d.getMesh(meshId) : null;
            if (!meshId || !mesh) continue;
            try {
                const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
                let mgr = this._uvPaintTextures.get(meshId);
                if (!mgr) { mgr = new RasterTextureManager(device); this._uvPaintTextures.set(meshId, mgr); }
                const tex = mgr.ensureTexture(bitmap.width, bitmap.height);
                device.queue.copyExternalImageToTexture({ source: bitmap, flipY: false }, { texture: tex }, [bitmap.width, bitmap.height]);
                mesh.diffuseTexture = tex; mesh.material.hasTexture = true; mesh.gpuDirty = true;
                if ((mesh as any).isClothing) mesh.material.alphaCutout = true;   // re-enable cutout holes (harmless on opaque paint)
            } catch (e) { console.warn('[ClothPaint] restore texture failed for', key, e); }
        }
    }

    /**
     * Enter UV paint mode for `meshId`: the user brushes on the unwrapped UV in
     * `uvRenderer`'s canvas and paints the mesh texture live. Requires an open UV
     * session (`openUVEditor3D`). The controller owns pointer input on the UV
     * canvas while active — Frogmarks should pause its own UV-pane interaction.
     */
    public enterUVPaintMode3D(meshId: string, uvRenderer?: UVCanvasRenderer | null, opts?: UVBrushSettings): void {
        const mesh = this.scene3d.getMesh(meshId);
        const device = this.webgpuRenderer?.getDevice();
        if (!mesh || !device) return;
        // Ensure the mesh is editable (so the 3D-paint raycast has UVs to read) and
        // a UV session exists — even when the host never opened the UV pane (pane
        // hidden → 3D-only painting). openUVEditor3D is idempotent: it returns the
        // existing session and skips makeEditable if the mesh is already editable.
        // Track whether WE open the editor here: if no session existed before, paint
        // owns it and exit must close it (else the editable wireframe + mesh-edit
        // orbit/background linger after painting ends). If one was already open (the
        // user is UV-editing), leave it for them.
        const editorWasOpen = !!this._uvSessions.get(meshId);
        const session = this.openUVEditor3D(meshId);
        this._uvPaintOpenedEditor = editorWasOpen ? null : meshId;
        const texMgr = this._ensureUVPaintTexture(meshId);
        if (!texMgr) return;
        // A painted surface shares ONE texture across both sides, so a double-sided
        // mesh renders its back as the texture MIRRORED. After orbiting around to the
        // far side that reads as paint landing "on the inside". Force single-sided
        // while painting so only the outward (painted) side ever shows; restore on exit.
        this._uvPaintDoubleSided = { meshId, prev: mesh.material.doubleSided };
        mesh.material.doubleSided = false;
        if (!this._uvPaintController) {
            this._uvPaintController = new UVPaintController(device, () => this.scheduleRender());
        }
        // uvRenderer omitted → the UV pane is hidden; the user paints only on the
        // 3D mesh (surface input below drives the same texture). With a pane, both
        // views are wired and stay in sync.
        this._uvPaintController.enter({
            mesh, texMgr, session,
            uvRenderer: uvRenderer ?? null,
            canvas: uvRenderer?.element ?? null,
        });
        // Share the 2D brush system: seed the UV engine with the current brush library,
        // then mirror the LIVE 2D brush (active preset + color + erase) onto it at the
        // start of every stroke. Reading the illustration engine's state per-stroke makes
        // this robust no matter how the shared brush panel reaches the engine (directly
        // or via sm.* APIs) — whatever it sets on the 2D engine shows up on the mesh.
        const illoEngine = this.rasterDrawingService?.getPaintEngine();
        if (illoEngine) this._uvPaintController.syncBrushFrom(illoEngine);
        this._uvPaintController.beforeStroke = () => this._mirrorBrushToUVEngine();
        if (opts) this._uvPaintController.setBrush(opts);
        // Also paint directly on the 3D mesh: the viewport raycasts the hit to a UV
        // coord and drives the same controller, so a stroke on either view paints
        // the same texture (and both update via the controller's readback).
        this.scene3d.enterSurfacePaintInput(meshId, {
            begin: (u, v, p) => this._uvPaintController?.strokeBeginUV(u, v, p),
            move:  (u, v, p) => this._uvPaintController?.strokeMoveUV(u, v, p),
            end:   () => this._uvPaintController?.strokeEndUV(),
            // Hover the mesh → ring on the UV pane at the corresponding spot.
            hover: (uv) => this._uvPaintController?.setLinkCursorUV(uv),
        });
        this.scheduleRender();
    }

    /** Exit UV paint mode. The painted texture stays on the mesh. */
    public exitUVPaintMode3D(): void {
        this._uvPaintController?.exit();   // clears the active target → activeMeshId() is null below
        this.scene3d.exitSurfacePaintInput();
        // Restore the mesh's original double-sided setting.
        if (this._uvPaintDoubleSided) {
            const m = this.scene3d.getMesh(this._uvPaintDoubleSided.meshId);
            if (m) m.material.doubleSided = this._uvPaintDoubleSided.prev;
            this._uvPaintDoubleSided = null;
        }
        // Close the UV editor session paint opened implicitly, so the editable WIREFRAME
        // overlay, gizmo suppression, and mesh-edit orbit/background don't linger after
        // painting ends (the bug where exiting clothing paint left the scene in edit
        // mode). Safe from re-entry: the controller is already exited above, so
        // closeUVEditor3D's "still painting this mesh?" guard is false. Null the field
        // FIRST as belt-and-suspenders. (If a UV editor was already open before paint,
        // _uvPaintOpenedEditor is null and we leave the user's session alone.)
        const opened = this._uvPaintOpenedEditor;
        this._uvPaintOpenedEditor = null;
        if (opened) this.closeUVEditor3D(opened);
        this.scheduleRender();
    }

    /**
     * Arm 3D-surface painting for a PACKAGING box: left-drag on the box raycasts to its net UV and
     * paints the DIELINE RASTER LAYER — the single source of truth that flat drawing also writes and
     * print export reads. Deliberately mirrors {@link enterUVPaintMode3D} EXCEPT it does NOT call
     * `openUVEditor3D`: the box already carries authored net UVs, and openUVEditor3D would auto-unwrap
     * and CLOBBER that dieline↔panel mapping. No editable mesh is needed — `_screenToMeshUV` reads the
     * baked geometry UVs directly. Unification trick: the UV paint engine is pointed at the dieline
     * layer's OWN RasterTextureManager, so brush dabs (flat via raster tools, or 3D via this path) all
     * land on the one GPUTexture the box samples. Returns false if it couldn't arm. Called by the
     * packaging host adapter; teardown is the shared {@link exitUVPaintMode3D} (no UV editor was opened,
     * so it just exits the controller, ends surface input, and restores double-sided).
     */
    private _armPackagingSurfacePaint(meshIds: string[], layerId: string): boolean {
        // The box is 6 panel meshes sharing ONE dieline layer/texture. Arm the UV paint controller on the
        // first panel as the session/texture holder; the multi-mesh raycast supplies the net UV of whichever
        // panel is hit, so a stroke lands in the correct region of the shared texture regardless of panel.
        const primary = meshIds[0];
        const mesh = primary ? this.scene3d.getMesh(primary) : null;
        const device = this.webgpuRenderer?.getDevice();
        const texMgr = this.rasterLayerManager?.getLayerById(layerId)?.manager ?? null;
        if (!primary || !mesh || !device || !texMgr) return false;
        if (!this._uvPaintController) {
            this._uvPaintController = new UVPaintController(device, () => this.scheduleRender());
        }
        // We never open a UV editor here (would clobber net UVs), so no editor to close on exit.
        this._uvPaintOpenedEditor = null;
        // No UV pane → the session is just a state holder (paintCursor). Reuse an open one if any, else
        // a transient one; do NOT register it in _uvSessions (keeps closeUVEditor3D/persistence untouched).
        const session = this._uvSessions.get(primary) ?? new UVEditorSession(primary);
        this._uvPaintController.enter({ mesh, texMgr, session, uvRenderer: null, canvas: null });
        // Share the live 2D brush (active preset + colour + erase) — same wiring as character paint.
        const illoEngine = this.rasterDrawingService?.getPaintEngine();
        if (illoEngine) this._uvPaintController.syncBrushFrom(illoEngine);
        this._uvPaintController.beforeStroke = () => this._mirrorBrushToUVEngine();
        // Paint on the 3D box: raycast ALL panels → the hit panel's net UV → the same controller/texture.
        // Sync on stroke-end so the flat artboard composite + box both reflect the stroke (shared texture).
        this.scene3d.enterSurfacePaintInputMulti(meshIds, {
            begin: (u, v, p) => this._uvPaintController?.strokeBeginUV(u, v, p),
            move:  (u, v, p) => this._uvPaintController?.strokeMoveUV(u, v, p),
            end:   () => { this._uvPaintController?.strokeEndUV(); this.syncLiveTextures3D(); },
        });
        this.scheduleRender();
        return true;
    }

    /** Copy the live 2D brush (active preset + color + erase) from the illustration
     *  engine onto the UV paint engine. Called at the start of every UV/mesh stroke so
     *  the shared brush panel's selection drives the dab — regardless of how the panel
     *  reaches the engine. (The UV engine is separate to keep texture/undo isolated.) */
    private _mirrorBrushToUVEngine(): void {
        const src = this.rasterDrawingService?.getPaintEngine();   // the 2D illustration engine
        const uv  = this._uvPaintController?.getEngine();
        if (!src || !uv) return;
        const erasing  = (this.rasterDrawingService?.getEraseMode() ?? null) !== null;
        const activeId = this._uvPaintController?.activeMeshId();
        const activeMesh = activeId ? this.scene3d.getMesh(activeId) : null;
        const isDecal  = !!activeMesh?.isFaceDecal;
        // 'cutout' (garment only) = a REAL alpha hole; 'clean' = a grainless hard white dab (no burn); 'burn'
        // (default) = white painted with the brush AS-IS (its grain + soft edge make the scorched border).
        const cleanErase  = erasing && !isDecal && this._garmentEraseStyle === 'clean';
        const cutoutErase = erasing && !isDecal && this._garmentEraseStyle === 'cutout';
        const id = src.getActivePresetId();
        if (id) {
            // Re-copy the active preset EVERY stroke so live edits propagate (size/opacity live in the preset).
            const p = src.getPreset(id);
            if (p) {
                let clone: any; try { clone = JSON.parse(JSON.stringify(p)); } catch { clone = null; }
                if (clone) {
                    if (cleanErase) {   // strip the burn: hard tip, full opacity/flow, no grain
                        if (clone.tip) clone.tip.hardness = 1;
                        if (clone.blending) { clone.blending.opacity = 1; clone.blending.flow = 1; }
                        delete clone.grain;
                    }
                    try { uv.registerPreset(clone); } catch { /* ignore */ }
                }
            }
            uv.setActivePreset(id);
            if (cleanErase) uv.setBrushGrain({ type: 'none', scale: 1, strength: 0 });   // kill any residual grain
        }
        if (isDecal) {
            // The eye decal is a TRANSPARENT cutout surface, so erase = real alpha-erase (removes the eyes).
            uv.setEraseMode(erasing ? (this.rasterDrawingService?.getEraseMode() ?? null) : null);
            const c = this.rasterDrawingService?.getBrushColor();
            if (c) uv.setBrushColor(c.r, c.g, c.b, c.a ?? 1);
        } else if (cutoutErase) {
            // CUTOUT (distressing / rips): real alpha-erase punches a HOLE. The shader discards it (alphaCutout)
            // so the body shows through. The painted garment texture is otherwise fully opaque, so enabling
            // alphaCutout is harmless for non-cut areas. The brush's soft/grain edge frays the rim.
            uv.setEraseMode(this.rasterDrawingService?.getEraseMode() ?? 1);
            if (activeMesh) { activeMesh.material.alphaCutout = true; activeMesh.gpuDirty = true; }
        } else {
            // Garment 'burn' / 'clean' erase, or normal painting: never a real erase (the diffuse is opaque, so
            // a real erase would read as BLACK). Erase = paint white opaquely; paint = the brush colour.
            uv.setEraseMode(null);
            if (erasing) {
                uv.setBrushColor(1, 1, 1, 1);
            } else {
                const c = this.rasterDrawingService?.getBrushColor();
                if (c) uv.setBrushColor(c.r, c.g, c.b, c.a ?? 1);
            }
        }
    }

    /** How the eraser behaves on a GARMENT in UV/3D paint: `'burn'` (default — white painted with the brush's
     *  grain/soft edge = the scorched border), `'clean'` (a sharp grainless white dab), or `'cutout'` (a real
     *  alpha HOLE — distressing / rips; the body shows through). Wire this to an erase-mode toggle in the paint UI. */
    public setGarmentEraseStyle3D(style: 'burn' | 'clean' | 'cutout'): void { this._garmentEraseStyle = style; }
    public getGarmentEraseStyle3D(): 'burn' | 'clean' | 'cutout' { return this._garmentEraseStyle; }

    /** Update the UV paint brush (color, radius in UV-pane screen px, opacity, erase). */
    public setUVPaintBrush3D(opts: UVBrushSettings): void {
        this._uvPaintController?.setBrush(opts);
    }

    /** Whether UV paint mode is active (optionally restricted to `meshId`). */
    public isUVPaintActive3D(meshId?: string): boolean {
        if (!this._uvPaintController?.isActive()) return false;
        return meshId ? this._uvPaintController.activeMeshId() === meshId : true;
    }

    /** The paint texture manager for a mesh, if any (used by persistence). */
    public getUVPaintTexture3D(meshId: string): RasterTextureManager | null {
        return this._uvPaintTextures.get(meshId) ?? null;
    }

    // ── Anime face / eye expressions ────────────────────────────────────────────
    // The body grows a "face decal" (an eyes overlay skinned to the head joint); each expression is
    // its own drawn image. Frogmarks flow: Edit Character → Eyes → create/select a State → draw it.
    // One state can be the "blink" (flashed at an interval). See docs/ui/character-creator.md.
    private _eyeDrawDecalId: string | null = null;   // decal whose UV session has the eye guide on

    /** Ensure a procedural body has a face rig (eye decal). Call before creating expressions. */
    public ensureFace3D(bodyMeshId: string): boolean { return this.scene3d.ensureFace3D(bodyMeshId); }

    /** Create a new expression/state (one drawn eye image). Returns its id; the first becomes active. */
    public createFaceExpression3D(bodyMeshId: string, name?: string): string | null {
        return this.scene3d.createFaceExpression(bodyMeshId, name);
    }
    public deleteFaceExpression3D(bodyMeshId: string, exprId: string): void { this.scene3d.deleteFaceExpression(bodyMeshId, exprId); }
    public renameFaceExpression3D(bodyMeshId: string, exprId: string, name: string): void { this.scene3d.renameFaceExpression(bodyMeshId, exprId, name); }
    /** Show this expression on the face (the held state between blinks). */
    public setActiveFaceExpression3D(bodyMeshId: string, exprId: string): void { this.scene3d.setActiveFaceExpression(bodyMeshId, exprId); }
    /** Mark which expression is the blink frame (null disables blinking). */
    public setFaceBlinkExpression3D(bodyMeshId: string, exprId: string | null): void { this.scene3d.setFaceBlinkExpression(bodyMeshId, exprId); }
    /** Configure blink timing: fixed Ns, or random in [minSec,maxSec]; holdMs = blink duration. */
    public setFaceBlinkConfig3D(bodyMeshId: string, cfg: Partial<FaceBlinkConfig>): void { this.scene3d.setFaceBlinkConfig(bodyMeshId, cfg); }
    /**
     * Auto-blink toggle for eye settings. `opts`: `enabled` (toggle), `minSec`/`maxSec` (blink frequency —
     * a small RANDOM range so it's irregular), `holdMs` (blink speed = eyes-closed time), `doubleProbability`
     * (0–1 chance of a double blink), `doubleGapMinMs`/`doubleGapMaxMs` (random gap between the two blinks).
     * Auto-creates a closed-eye frame for procedural eyes so enabling it just works. Persists with the face rig.
     */
    public setAutoBlink3D(bodyMeshId: string, opts: Partial<FaceBlinkConfig>): void { this.scene3d.setAutoBlink(bodyMeshId, opts); }
    /** List the expressions + active/blink ids + blink config for a body's face (null if no rig). */
    public getFaceExpressions3D(bodyMeshId: string) { return this.scene3d.getFaceExpressions(bodyMeshId); }

    // ── Procedural eyes (the "no drawing" path — generate eyes from sliders) ──
    /** Default procedural-eye params (the "anime girl" preset) for seeding a slider panel. */
    public getDefaultEyeParams3D(): EyeParams { return this.scene3d.getDefaultEyeParams(); }
    /** Generate an expression's eyes from params (live preview — call on every slider change).
     *  Stores the params for re-editing; the baked texture persists as a PNG like a drawn one. */
    public setFaceExpressionProcedural3D(bodyMeshId: string, exprId: string, params: EyeParams): void {
        this.scene3d.setFaceExpressionProcedural(bodyMeshId, exprId, params);
    }
    /** An expression's procedural params, or null if it was freehand-drawn. */
    public getFaceExpressionParams3D(bodyMeshId: string, exprId: string): EyeParams | null {
        return this.scene3d.getFaceExpressionParams(bodyMeshId, exprId);
    }
    /** Point the eyes in a direction (−1..1; x:+right, y:+down) — live look-around for the active
     *  procedural expression. Cheap; call on cursor/target change. No-op for drawn expressions. */
    public setFaceGaze3D(bodyMeshId: string, x: number, y: number): void {
        this.scene3d.setFaceGaze(bodyMeshId, x, y);
    }

    // ── Procedural hair (chunky low-poly; presets + sliders) ─────────────────────
    /** Default hairstyle params (the "Twintails" reference) to seed a slider panel. */
    public getDefaultHairParams3D(): HairParams { return this.scene3d.getDefaultHairParams(); }
    /** Build/update a body's procedural hair from params — live (call on each slider change). */
    public setHairParams3D(bodyMeshId: string, params: HairParams): void {
        // Hair regenerates with a NEW mesh id; carry the user's render style + painted/uploaded texture.
        const oldId = this.scene3d.getHairMeshId(bodyMeshId);
        const oldMesh = oldId ? this.scene3d.getMesh(oldId) : null;
        const style = oldMesh?.material.renderStyle, mgr = oldId ? this._uvPaintTextures.get(oldId) : undefined;
        this.scene3d.setHairParams(bodyMeshId, params);
        this._carryPartOverrides(oldId, this.scene3d.getHairMeshId(bodyMeshId), style, mgr);
    }
    /** A body's current hair params, or null if it has none. */
    public getHairParams3D(bodyMeshId: string): HairParams | null { return this.scene3d.getHairParams(bodyMeshId); }
    /** Remove a body's hair. */
    public removeHair3D(bodyMeshId: string): void { this.scene3d.removeHair(bodyMeshId); }
    /** Enable/disable a character's hair (spring-bone) jiggle. OFF by default so a crowd of idle characters
     *  costs nothing per frame; turn it on for the focused character. Armature edit + skeleton-clip/NLA
     *  playback auto-enable it. */
    public setHairSimulation3D(bodyMeshId: string, on: boolean): void { this.scene3d.setHairSimulation(bodyMeshId, on); }
    /** Toggle a gentle procedural IDLE on a standing character — breathing, weight-shift, sway, a slow head drift —
     *  no keyframes. Layers on the current pose; hair/chains/pendant swing with it (it runs before the spring solve).
     *  Pauses while editing the armature. `intensity` 0..~2 scales the motion (1 = natural). Good default for a
     *  character preview. */
    public setIdleAnimation3D(bodyMeshId: string, on: boolean, intensity = 1): void { this.scene3d.setIdleAnimation(bodyMeshId, on, intensity); }
    /** Whether the character's procedural idle is currently running. */
    public isIdleAnimating3D(bodyMeshId: string): boolean { return this.scene3d.isIdleAnimating(bodyMeshId); }
    /** Set a character's leg idle fidelity: 'fk' (default — free micro weight-shift, feet drift ~cm), 'ik' (feet PINNED
     *  via foot-IK while the pelvis shifts — locked feet, for close-ups/hero chars), or 'none' (legs static). Persists
     *  across idle on/off; a running idle reconfigures immediately. Wire a 3-way toggle to this per character. */
    public setLegIdleMode3D(bodyMeshId: string, mode: LegIdleMode): void { this.scene3d.setLegIdleMode(bodyMeshId, mode); }
    /** A character's current leg idle fidelity (default 'fk'). */
    public getLegIdleMode3D(bodyMeshId: string): LegIdleMode { return this.scene3d.getLegIdleMode(bodyMeshId); }
    /**
     * Configure random IDLE BREAKS (the "alive" multiplier): between the base idle, a random one-shot clip
     * (Stretch / Scratch Head / …) fires every [minSec,maxSec] then settles back. Requires the base idle ON
     * (setIdleAnimation3D). `clips` = eligible clip names (default = the built-in one-shots). enabled:false stops.
     */
    public setIdleBreaks3D(bodyMeshId: string, opts: { enabled?: boolean; minSec?: number; maxSec?: number; clips?: string[] }): void { this.scene3d.setIdleBreaks(bodyMeshId, opts); }
    /**
     * Toggle procedural SQUASH & STRETCH — a volume-preserving torso scale derived from how extended/compressed
     * the body is each frame (reach/arms-up → stretch taller+thinner; crouch → squash shorter+wider). Layers on
     * top of the idle + break clips with no per-clip authoring. `intensity` ~0.04–0.12 (subtle, clamped; default 0.06). Requires
     * the base idle ON (`setIdleAnimation3D`). A "Squash & stretch" checkbox + intensity slider in the panel.
     */
    public setSquashStretch3D(bodyMeshId: string, opts: { enabled?: boolean; intensity?: number }): void { this.scene3d.setSquashStretch(bodyMeshId, opts); }
    /**
     * Play a SPAWN SPIN on a just-generated character — it spins `turns` times and eases to a stop facing front.
     * Call right after the user clicks Generate (and createProceduralBody3D returns the meshId). Runtime-only.
     */
    public playSpawnSpin3D(bodyMeshId: string, opts?: { turns?: number; durationSec?: number }): void { this.scene3d.playSpawnSpin(bodyMeshId, opts); }
    /**
     * SPAWN REVEAL — a POST-step (call AFTER your full character is assembled + scaled, just like playSpawnSpin3D;
     * it includes the spin). A bright line sweeps top→bottom "developing" the character out of a blue hologram.
     * Non-disruptive: takes the body mesh id, never replaces createProceduralBody3D. (v1: ghost is body-shaped.)
     */
    public async playSpawnReveal3D(bodyMeshId: string, opts?: { turns?: number; durationSec?: number }): Promise<void> { return this.scene3d.playSpawnReveal(bodyMeshId, opts); }
    /** Force the 3D view to draw a frame (host render-tick). Salsa already holds the render loop alive internally
     *  while the idle is on, so you normally don't need this — but if the HOST owns the render loop, run your own
     *  rAF loop calling this each frame while `isIdleAnimating3D(bodyId)` is true. (Don't ALSO call beginInteractive —
     *  Salsa does that; double-calling needs matched releases.) */
    public requestRender3D(): void { this.scheduleRender(); }
    /** Run a FULL 3D render NOW, **including the pre-render callbacks** (idle / spring / IK). This is the render path
     *  Edit-Mesh mode uses — unlike `requestRender3D()`/`scheduleRender()` (the on-demand path, which a host that owns
     *  or suspends the canvas can swallow before `render()` ever runs, so the callbacks never fire). **If the HOST
     *  drives the frame loop, call THIS each rAF while `isIdleAnimating3D(bodyId)` is true** — it's the API to trigger
     *  a full render with the idle callback. Re-entrancy-guarded (a no-op if a frame is still in flight). */
    public renderFrame3D(): void {
        if (this._renderingFrame3D) return;
        this._renderingFrame3D = true;
        Promise.resolve(this.webgpuRenderer?.render()).catch(() => {}).finally(() => { this._renderingFrame3D = false; });
    }
    private _renderingFrame3D = false;
    /** Current 3D render rate (frames/sec over the last second) — 0 when the view is idle (on-demand). Use it to
     *  DIAGNOSE the idle: with idle ON, fps>0 = a loop is drawing (any non-motion is a different bug); fps==0 = the
     *  view isn't re-rendering → drive `renderFrame3D()` from a host rAF loop. */
    public getRenderFps3D(): number { return this.scene3d.getRenderStats3D().fps; }
    /** Enable/disable RIM LIGHT (the silhouette back-light glow) on a whole character — the body skin + its
     *  attached parts (face/hair/clothing). A render-style-independent modifier (works on Cel/Cel-HD/PBR);
     *  uses the scene light, so it's strongest when the character is backlit. The "Enable Rim Light" toggle. */
    public setCharacterRimLight3D(bodyMeshId: string, on: boolean): void {
        const ids = [
            bodyMeshId,
            this.scene3d.getEyesMeshId(bodyMeshId),
            this.scene3d.getHairMeshId(bodyMeshId),
            this.scene3d.getClothingMeshId(bodyMeshId, 'top'),
            this.scene3d.getClothingMeshId(bodyMeshId, 'bottom'),
        ];
        for (const id of ids) {
            if (!id) continue;
            const m = this.scene3d.getMesh(id);
            if (m) { m.material.rimEnabled = on; m.gpuDirty = true; }
        }
        this.scheduleRender();
    }
    /** Bake a body's hair to GLB + register it as a kitbash 'hair' part. Returns the part id or null. */
    public bakeHairToPart3D(bodyMeshId: string, name: string): string | null {
        return this.scene3d.bakeHairToPart(bodyMeshId, name);
    }

    // ── Procedural clothing (top + bottom; presets + sliders) ────────────────────
    /** Default params for a slot (top = pink Tee, bottom = Skirt) to seed a slider panel. */
    public getDefaultClothingParams3D(slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): ClothingParams { return this.scene3d.getDefaultClothingParams(slot); }
    /** Named presets for a slot (Tee/Crop/Tank/… ; Skirt/Shorts/Pants/…). */
    public getClothingPresetNames3D(slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): string[] { return this.scene3d.getClothingPresetNames(slot); }
    /** A named preset bundle for a slot to load into the sliders. */
    public getClothingPreset3D(slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants', name: string): ClothingParams { return this.scene3d.getClothingPreset(slot, name); }
    /** Build/update a body's garment for one slot from params — live (call on each slider change). */
    public setClothingParams3D(bodyMeshId: string, params: ClothingParams): void {
        // Regenerating a garment makes a NEW mesh id; carry the user's render style + painted/uploaded
        // texture onto the rebuilt mesh so nudging a slider never silently wipes them.
        const oldId = this.scene3d.getClothingMeshId(bodyMeshId, params.slot);
        const oldMesh = oldId ? this.scene3d.getMesh(oldId) : null;
        const oldParams = this.scene3d.getClothingParams(bodyMeshId, params.slot);   // the colour the paint bg currently is
        const style = oldMesh?.material.renderStyle, mgr = oldId ? this._uvPaintTextures.get(oldId) : undefined;
        this.scene3d.setClothingParams(bodyMeshId, params);
        const newId = this.scene3d.getClothingMeshId(bodyMeshId, params.slot);
        // If this garment is PAINTED and a COLOUR field changed, re-tint the unpainted fabric to the new
        // colour while keeping the strokes (without it, the painted texture's old base is frozen — the carry
        // below re-applies the texture over any new colour). Serialized per garment so a fast colour drag
        // applies the background moves in order. The re-tint writes into the SAME texture object the carry
        // hands the new mesh, so it shows once it lands.
        if (mgr && newId && oldParams && this._garmentColorChanged(oldParams, params)) {
            const key = this.scene3d.clothingRigKeyForMesh(newId) ?? `${bodyMeshId}:${params.slot}`;
            const from = { ...oldParams } as ClothingParams, to = { ...params } as ClothingParams;
            const prev = this._retintChain.get(key) ?? Promise.resolve();
            const next = prev.then(() => this.scene3d.retintGarmentPaint(mgr, from, to)).catch(() => { /* best-effort */ });
            this._retintChain.set(key, next);
        }
        this._carryPartOverrides(oldId, newId, style, mgr);
    }

    /** True if a colour field (the bits `_drawGarmentColorCanvas` reads) differs — i.e. a re-tint is needed. */
    private _garmentColorChanged(a: ClothingParams, b: ClothingParams): boolean {
        return a.baseColor !== b.baseColor || a.trimColor !== b.trimColor
            || a.gradient !== b.gradient || Math.abs(a.trimWidth - b.trimWidth) > 1e-4;
    }

    /** After a hair/garment regenerates (new mesh id), carry the user's render style + painted/uploaded
     *  texture override onto the rebuilt mesh. The UV island layout is fixed, so a painted texture still
     *  maps to the right pieces. */
    private _carryPartOverrides(oldId: string | null, newId: string | null, style: Material3D['renderStyle'] | undefined, mgr: RasterTextureManager | undefined): void {
        if (!newId || newId === oldId) return;
        const mesh = this.scene3d.getMesh(newId);
        if (!mesh) return;
        if (style !== undefined) mesh.material.renderStyle = style;
        if (mgr) {
            if (oldId) this._uvPaintTextures.delete(oldId);
            this._uvPaintTextures.set(newId, mgr);
            const tex = mgr.getTexture();
            if (tex) {
                mesh.diffuseTexture = tex; mesh.material.hasTexture = true; mesh.setDiffuseColor(1, 1, 1, 1);
                // A painted garment may have CUTOUT holes (transparent texels) — keep alpha-test on so they show.
                // Harmless where the paint is opaque (alpha 1 → never discarded). Persists cutouts across regens.
                if ((mesh as any).isClothing) mesh.material.alphaCutout = true;
            }
        }
        mesh.gpuDirty = true;
    }
    /** A body's garment params for a slot, or null if none. */
    public getClothingParams3D(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): ClothingParams | null { return this.scene3d.getClothingParams(bodyMeshId, slot); }
    /** The garment mesh id for a (body, slot) — pass to `enterUVPaintMode3D` to pixel-paint the garment. */
    public getClothingMeshId3D(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): string | null { return this.scene3d.getClothingMeshId(bodyMeshId, slot); }
    /** The hair mesh id for a body (render style / texture upload / paint), or null if no hair. */
    public getHairMeshId3D(bodyMeshId: string): string | null { return this.scene3d.getHairMeshId(bodyMeshId); }
    /** The eyes (face-decal) mesh id for a body, or null if it has no face rig yet (call `ensureFace3D` first). */
    public getEyesMeshId3D(bodyMeshId: string): string | null { return this.scene3d.getEyesMeshId(bodyMeshId); }

    /** Set a part's diffuse from an UPLOADED image (any character part — body/hair/garment/eyes). Tracked,
     *  so it survives the part regenerating (a slider nudge): the texture is re-applied to the rebuilt
     *  mesh automatically. `source` = an already-decoded ImageBitmap / <img> / <canvas>. */
    public setPartTexture3D(meshId: string, source: ImageBitmap | HTMLImageElement | HTMLCanvasElement): void {
        const mesh = this.scene3d.getMesh(meshId);
        const device = this.webgpuRenderer?.getDevice();
        if (!mesh || !device) return;
        let mgr = this._uvPaintTextures.get(meshId);
        if (!mgr) { mgr = new RasterTextureManager(device); this._uvPaintTextures.set(meshId, mgr); }
        const w = Math.max(1, (source as any).width ?? 1024), h = Math.max(1, (source as any).height ?? 1024);
        const tex = mgr.ensureTexture(w, h);
        device.queue.copyExternalImageToTexture({ source, flipY: false }, { texture: tex }, [w, h]);
        mesh.diffuseTexture = tex; mesh.material.hasTexture = true; mesh.gpuDirty = true;
        this.scheduleRender();
    }
    /** Clear a part's uploaded/painted texture override → revert to its generated colour (gradient / skin
     *  tone) or, for the eyes, the active expression. */
    public clearPartTexture3D(meshId: string): void {
        this._uvPaintTextures.delete(meshId);
        this.scene3d.reapplyPartColor(meshId);
        this.scheduleRender();
    }
    /** Remove a body's garment for one slot. */
    public removeClothing3D(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): void { this.scene3d.removeClothing(bodyMeshId, slot); }
    /** Bake a body's garment (slot) to GLB + register it as a kitbash slot part. Returns the part id or null. */
    public bakeClothingToPart3D(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants', name: string): string | null {
        return this.scene3d.bakeClothingToPart(bodyMeshId, slot, name);
    }

    // ── Attachments / charms (chain · pocket · pendant · …) — joint-anchored, skinned to the body ──────────────
    /** Available charm types. */
    public attachmentTypeNames3D(): AttachmentType[] { return this.scene3d.attachmentTypeNames(); }
    /** Default params / placement for a charm type (to seed the UI). */
    public getDefaultAttachmentParams3D(type: AttachmentType): AttachmentParams { return this.scene3d.getDefaultAttachmentParams(type); }
    public getDefaultAttachmentPlacement3D(type: AttachmentType): AttachmentPlacement { return this.scene3d.getDefaultAttachmentPlacement(type); }
    /** Spawn a charm on a body (joint-anchored). Returns its id, or null if the body/joint is missing. */
    public addAttachment3D(bodyMeshId: string, type: AttachmentType, placement?: AttachmentPlacement, params?: AttachmentParams): string | null {
        return this.scene3d.addAttachment(bodyMeshId, type, placement, params);
    }
    /** Live-tune a charm (size/colour/etc.). */
    public setAttachmentParams3D(id: string, params: AttachmentParams): void { this.scene3d.setAttachmentParams(id, params); }
    /** Move a charm (anchor joint + offset + scale). */
    public setAttachmentPlacement3D(id: string, placement: AttachmentPlacement): void { this.scene3d.setAttachmentPlacement(id, placement); }
    /** Current state of one charm (for the editor), or null. */
    public getAttachment3D(id: string) { return this.scene3d.getAttachment(id); }
    /** All charms on a body (id + type + placement + params). */
    public listAttachments3D(bodyMeshId: string) { return this.scene3d.listAttachments(bodyMeshId); }
    /** Remove a charm. */
    public removeAttachment3D(id: string): void { this.scene3d.removeAttachment(id); }
    /** The charm's current mesh id (changes each rebuild), or null — e.g. to pixel-paint it. */
    public getAttachmentMeshId3D(id: string): string | null { return this.scene3d.getAttachmentMeshId(id); }
    /** Spawn a row of `count` belt-loop charms evenly around the waistband (auto-sized/placed). Returns their ids —
     *  pass two of them to a chain's `fromLoop`/`toLoop` to string a wallet chain between them. */
    public addBeltLoops3D(bodyMeshId: string, count = 5, params?: AttachmentParams): string[] { return this.scene3d.addBeltLoops(bodyMeshId, count, params); }
    /** Toggle the SPARKLE / glint on all of a body's metal charms at once (the "make them glisten" checkbox). Twinkles
     *  during any motion (orbit / idle / spring) and scintillates as the view moves. Per-charm: set `params.sparkle`. */
    public setCharacterSparkle3D(bodyMeshId: string, on: boolean, style: 'glint' | 'star' = 'glint'): void { this.scene3d.setCharacterSparkle(bodyMeshId, on, style); }
    /** Enter "click a garment/body to drop a charm there" mode — each click surface-pins a new `type` charm (usually
     *  a `loop`) at the tapped point (it follows that body region). Stays active until `endAttachmentPlacePick3D`.
     *  Pin in the neutral/rest pose. `onPlaced(id)` fires per drop; `onHover(world|null)` tracks the cursor. */
    public beginAttachmentPlacePick3D(bodyMeshId: string, type: AttachmentType, opts?: { params?: AttachmentParams; onPlaced?: (id: string) => void; onHover?: (world: [number, number, number] | null) => void }): void {
        this.scene3d.beginAttachmentPlacePick(bodyMeshId, type, opts);
    }
    /** Exit surface-pin placement mode. */
    public endAttachmentPlacePick3D(): void { this.scene3d.endAttachmentPlacePick(); }
    /** Enter "click two points to string a chain between them" mode — no hoops, no xyz offsets. Click A then B on any
     *  garment/body; a swag chain is strung between the two surface-pinned points and draped onto the cloth. Stays
     *  active for more chains until `endAttachmentPlacePick3D`. `onProgress` drives a click-start/click-end prompt. */
    public beginChainPick3D(bodyMeshId: string, opts?: { params?: AttachmentParams; onPlaced?: (id: string) => void; onProgress?: (phase: 'first' | 'second') => void; onHover?: (world: [number, number, number] | null) => void }): void {
        this.scene3d.beginChainPick(bodyMeshId, opts);
    }
    /** Show a translucent GHOST of a charm at its default placement (or `placement`) that follows the cursor over the
     *  body — call when a charm type is selected so the user sees where it'll land before "Add". */
    public showAttachmentPreview3D(bodyMeshId: string, type: AttachmentType, params?: AttachmentParams, placement?: AttachmentPlacement): void {
        this.scene3d.showAttachmentPreview(bodyMeshId, type, params, placement);
    }
    /** Live-update the pending ghost (colour/size tweak, or switch type). */
    public updateAttachmentPreview3D(params?: Partial<AttachmentParams>, type?: AttachmentType): void { this.scene3d.updateAttachmentPreview(params, type); }
    /** Spawn the real charm at the ghost's current placement (the "Add" action); returns the new id. */
    public commitAttachmentPreview3D(): string | null { return this.scene3d.commitAttachmentPreview(); }
    /** Remove the ghost + stop hover tracking (cancel / after add). */
    public hideAttachmentPreview3D(): void { this.scene3d.hideAttachmentPreview(); }

    // ── Character export / import (portable preset) ──────────────────────────────
    // Save a whole procedural character (body + hair + clothing params + render style) to a portable JSON
    // string and re-apply it to a body. Independent of document persistence — a reliable way to keep a look
    // as a preset or back one up. (Face/eye decals + painted textures are PNG blobs, NOT included here yet —
    // they ride the full document save; v1 covers the procedural generators, which is the bulk of the look.)
    /** Export `bodyMeshId` (or the first procedural body) as a JSON character preset string. */
    public exportCharacter3D(bodyMeshId?: string): string {
        const id = bodyMeshId ?? this._firstProceduralBody3D();
        const body = id ? (this.scene3d.serializeBodyParams().find(b => b.bodyMeshId === id)?.params ?? null) : null;
        const hair = id ? (this.scene3d.serializeHairRigs().find(h => h.bodyMeshId === id)?.params ?? null) : null;
        const clothing: Record<string, ClothingParams> = {};
        if (id) for (const c of this.scene3d.serializeClothingRigs()) if (c.bodyMeshId === id) clothing[c.slot] = c.params;
        const renderStyle = id ? (this.scene3d.getMesh(id)?.material.renderStyle ?? 'default') : 'default';
        return JSON.stringify({ kind: 'salsa-character', version: 1, body, hair, clothing, renderStyle });
    }
    /** Apply a JSON character preset (from exportCharacter3D) to a body. Body first (it regenerates + re-fits),
     *  then hair / clothing / render style. */
    public async importCharacter3D(bodyMeshId: string, preset: string | object): Promise<void> {
        let data: any;
        try { data = typeof preset === 'string' ? JSON.parse(preset) : preset; }
        catch { throw new Error('importCharacter3D: invalid JSON'); }
        if (!data || data.kind !== 'salsa-character') throw new Error('importCharacter3D: not a salsa-character preset');
        if (data.body)             await this.setBodyParams3D(bodyMeshId, data.body);
        if (data.hair)             this.setHairParams3D(bodyMeshId, data.hair);
        if (data.clothing?.top)    this.setClothingParams3D(bodyMeshId, data.clothing.top);
        if (data.clothing?.bottom) this.setClothingParams3D(bodyMeshId, data.clothing.bottom);
        if (data.renderStyle && data.renderStyle !== 'default') this.setRenderStyle3D(bodyMeshId, data.renderStyle);
    }
    /** The first procedural body mesh id in the scene, or null (convenience for export with no id). */
    private _firstProceduralBody3D(): string | null {
        for (const m of this.scene3d.getAllMeshes()) if ((m as any).isProceduralBody) return m.id;
        return null;
    }

    /**
     * Enter "draw eyes" mode for one expression — opens the flat eye canvas in `uvRenderer` (like the
     * UV paint pane) and lets the user draw that expression's eyes live on the face. Reuses the raster
     * brush system; erase removes eyes (transparent). Call exitEyeDrawMode3D() when done.
     */
    public enterEyeDrawMode3D(bodyMeshId: string, exprId: string, uvRenderer?: UVCanvasRenderer | null, opts?: UVBrushSettings): boolean {
        if (!this.scene3d.ensureFace3D(bodyMeshId)) return false;
        const decalId = this.scene3d.getFaceDecalMeshId(bodyMeshId);
        const texMgr  = this.scene3d.getFaceExpressionTextureManager(bodyMeshId, exprId);
        if (!decalId || !texMgr) return false;
        this.scene3d.setActiveFaceExpression(bodyMeshId, exprId);   // live preview of what's being drawn
        this._uvPaintTextures.set(decalId, texMgr);                 // route the paint tool at this expr's texture
        this.enterUVPaintMode3D(decalId, uvRenderer, opts);
        this._eyeDrawDecalId = decalId;
        const s = this.getUVSession3D(decalId);
        if (s) s.faceGuide = true;                                  // anime-eye drawing guides on by default
        this.scene3d.frameFace3D(bodyMeshId);                       // aim the 3D view at the face
        return true;
    }
    /** Exit eye-draw mode (the drawn eyes stay). */
    public exitEyeDrawMode3D(): void {
        if (this._eyeDrawDecalId) {
            const s = this.getUVSession3D(this._eyeDrawDecalId);
            if (s) s.faceGuide = false;
            this._eyeDrawDecalId = null;
        }
        this.exitUVPaintMode3D();
    }

    /** Aim the orbit camera at the character's face (dead-front, framed to the head). */
    public frameFace3D(bodyMeshId: string): boolean { return this.scene3d.frameFace3D(bodyMeshId); }

    /** Toggle the anime-eye drawing guides (symmetry axis + eye line + eye boxes) in the draw pane. */
    public setFaceDrawGuide3D(bodyMeshId: string, on: boolean): void {
        const decalId = this.scene3d.getFaceDecalMeshId(bodyMeshId);
        if (!decalId) return;
        const s = this.getUVSession3D(decalId);
        if (s) s.faceGuide = on;
        this._uvPaintController?.refreshPane();
    }

    /**
     * Copy the diffuse texture from `sourceMeshId` onto every mesh in
     * `targetMeshIds` by reference — no GPU upload, no CPU copy.
     * All targets end up sharing the exact same GPUTexture object, so the
     * renderer batches them into a single draw call when their geometry keys
     * also match (primitives with identical parameters, or ArrayGroup instances).
     *
     * Use this after painting one enemy to stamp the same texture onto the rest:
     *   sm.shareUVTexture3D('enemy-0', ['enemy-1', 'enemy-2', ...]);
     */
    public shareUVTexture3D(sourceMeshId: string, targetMeshIds: string[]): void {
        const src = this.sceneGraph.findNodeById(sourceMeshId) as import('../scene-graph/shapes/mesh-3d').Mesh3D | null;
        if (!src?.diffuseTexture) return;
        for (const id of targetMeshIds) {
            const tgt = this.sceneGraph.findNodeById(id) as import('../scene-graph/shapes/mesh-3d').Mesh3D | null;
            if (!tgt) continue;
            tgt.diffuseTexture    = src.diffuseTexture;
            tgt.material.hasTexture = true;
            tgt.gpuDirty = true;
        }
        this.scheduleRender();
    }

    /** Mark selected half-edges (and their twins) as UV seams. Undoable. */
    public markSeam3D(meshId: string, halfEdgeIndices: number[]): boolean {
        return this.meshEdit.markSeam(meshId, halfEdgeIndices);
    }

    /** Remove seam flag from selected half-edges (and their twins). Undoable. */
    public clearSeam3D(meshId: string, halfEdgeIndices: number[]): boolean {
        return this.meshEdit.clearSeam(meshId, halfEdgeIndices);
    }

    /** Remove all seam flags from the mesh. Undoable. */
    public clearAllSeams3D(meshId: string): boolean {
        return this.meshEdit.clearAllSeams(meshId);
    }

    /**
     * Auto-suggest seams by marking edges whose dihedral angle exceeds `thresholdDeg` (default 60°).
     * Sharp creases are natural UV cut lines. Undoable.
     */
    public suggestSeams3D(meshId: string, thresholdDeg = 60): boolean {
        return this.meshEdit.suggestSeams(meshId, thresholdDeg);
    }

    /**
     * Decompose the mesh into UV islands — connected face groups separated by seam edges.
     * Returns an empty array if the mesh has no EditMesh.
     * Results are recomputed on every call; cache if calling per frame.
     */
    public getUVIslands3D(meshId: string): UVIsland[] {
        return this.getEditMesh3D(meshId)?.computeUVIslands() ?? [];
    }

    // ── UV Editor — session lifecycle ─────────────────────────────────────────

    /**
     * Open the UV editor for `meshId`.
     *
     * Does NOT require `enterMeshEditMode3D` — UV editing is an independent mode.
     * Internally calls `makeEditable3D` if needed, activates the 3D overlay for
     * seam-edge and hover-face rendering, and enables mesh-edit orbit on the camera.
     *
     * Returns the session — pass it to `UVCanvasRenderer.draw()` each frame.
     */
    /**
     * True when a mesh has no usable UV layout yet and should be auto-unwrapped.
     * A fresh primitive has no `uv` on any vertex; a mesh whose UVs are all
     * collapsed to ~a point is likewise unpaintable. Meshes with a real spread-out
     * layout (imported GLTF, or already unwrapped) return false → never clobbered.
     */
    private _meshNeedsUnwrap(meshId: string): boolean {
        const em = this.getEditMesh3D(meshId);
        if (!em) return false;
        let any = false;
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const v of em.vertices) {
            if (!v.uv) continue;
            any = true;
            if (v.uv[0] < uMin) uMin = v.uv[0]; if (v.uv[0] > uMax) uMax = v.uv[0];
            if (v.uv[1] < vMin) vMin = v.uv[1]; if (v.uv[1] > vMax) vMax = v.uv[1];
        }
        if (!any) return true;                 // no UVs at all (fresh primitive)
        const eps = 1e-4;
        return (uMax - uMin) < eps || (vMax - vMin) < eps;  // collapsed/degenerate
    }

    public openUVEditor3D(meshId: string): UVEditorSession {
        if (!this.getEditMesh3D(meshId)) this.makeEditable3D(meshId);
        // Auto-unwrap on first open so a fresh primitive is paintable immediately —
        // no "click Unwrap first" step. Only when the mesh has NO usable UV layout
        // yet: a fresh primitive has no UVs at all; an imported (GLTF) mesh keeps its
        // authored UVs, and an already-unwrapped mesh keeps its layout (re-opening
        // never clobbers either). The "Unwrap Mesh" button stays for manual re-do.
        if (this._meshNeedsUnwrap(meshId)) this.autoUnwrap3D(meshId);
        let session = this._uvSessions.get(meshId);
        if (!session) {
            session = new UVEditorSession(meshId);
            this._uvSessions.set(meshId, session);
        }
        // Activate orbit + suppress transform gizmo for UV mode.
        // (No-op if full mesh edit mode is already active for this mesh.)
        if (!this.meshEdit.isEditing) {
            this.scene3d.enableMeshEditOrbit(meshId);
        }
        this.scheduleRender();
        return session;
    }

    /**
     * Close the UV editor session for `meshId`.
     * Restores normal camera orbit unless full mesh-edit mode is still active.
     */
    public closeUVEditor3D(meshId: string): void {
        // Stop painting if this mesh's UV editor is closing (keeps the texture).
        if (this._uvPaintController?.activeMeshId() === meshId) this.exitUVPaintMode3D();
        this._uvSessions.delete(meshId);
        this._uvPaintCanvases.delete(meshId);
        if (!this.meshEdit.isEditing && this._uvSessions.size === 0) {
            this.scene3d.disableMeshEditOrbit();
        }
        this.scheduleRender();
    }

    /** Return the active UV editor session, or null if not open. */
    public getUVSession3D(meshId: string): UVEditorSession | null {
        return this._uvSessions.get(meshId) ?? null;
    }

    /**
     * Toggle UV-editor display options for a mesh's open session — affects BOTH the 2D UV
     * pane AND the 3D mesh overlay. Wire the UV editor's "Wireframe" / "Islands" checkboxes
     * to this (don't mutate the session object directly — this also schedules a redraw).
     *   • `wireframe` → the white edge wireframe drawn over the 3D mesh + the UV-pane edges.
     *   • `islands`   → island colour fills in the UV pane.
     * No-op if the mesh has no open UV session.
     */
    public setUVDisplay3D(meshId: string, opts: { wireframe?: boolean; islands?: boolean }): void {
        const s = this._uvSessions.get(meshId);
        if (!s) return;
        if (opts.wireframe !== undefined) s.showWireframe = opts.wireframe;
        if (opts.islands   !== undefined) s.showIslands   = opts.islands;
        this._uvPaintController?.refreshPane();   // redraw the 2D pane if one is bound
        this.scheduleRender();                    // redraw the 3D overlay
    }

    /**
     * Create a UVCanvasRenderer bound to `canvas`.
     * Call `renderer.draw(session, editMesh, texture?)` each time the canvas needs refresh.
     */
    public createUVCanvasRenderer(canvas: HTMLCanvasElement): UVCanvasRenderer {
        return new UVCanvasRenderer(canvas);
    }

    /**
     * Render the UV layout of `meshId` to an off-screen canvas at `width × height`
     * pixels and return it.  The caller can call `.toDataURL('image/png')` to export.
     * Returns null if the mesh has no EditMesh or no UV data.
     */
    public exportUVLayout3D(meshId: string, width = 1024, height = 1024): HTMLCanvasElement | null {
        const mesh = this.scene3d.getMesh(meshId);
        const em   = mesh?.editMesh;
        if (!em) return null;

        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;

        // Build a minimal session with wireframe + island fills enabled
        const session = new UVEditorSession(meshId);
        session.showWireframe = true;
        session.showIslands   = true;
        session.panU = 0.5;
        session.panV = 0.5;
        session.zoom = 1.0;

        const renderer = new UVCanvasRenderer(canvas);
        renderer.draw(session, em);
        return canvas;
    }

    // ── UV Editor — cross-highlighting (Phase 7) ──────────────────────────────

    /**
     * Set the hovered face for UV cross-highlighting.
     * Pass null to clear the hover tint.  Call on UV canvas `mousemove` or 3D pick hover.
     * Schedules a render so both panes update immediately.
     */
    private _buildUVHoveredFaces(uvSession: import('./managers/uv-canvas-renderer').UVEditorSession): Set<number> {
        const set = new Set<number>();
        if (uvSession.hoveredFaceIndex == null) return set;
        if (uvSession.islandHoverMode && !uvSession.islandsDirty) {
            const island = uvSession.islands.find(
                isl => isl.faceIndices.includes(uvSession.hoveredFaceIndex!),
            );
            if (island) {
                for (const fi of island.faceIndices) set.add(fi);
            } else {
                set.add(uvSession.hoveredFaceIndex);
            }
        } else {
            set.add(uvSession.hoveredFaceIndex);
        }
        return set;
    }

    public setUVHoverFace3D(meshId: string, faceIndex: number | null): void {
        const session = this._uvSessions.get(meshId);
        if (session) {
            session.hoveredFaceIndex = faceIndex;
            this.scheduleRender();
        }
    }

    /**
     * Toggle island hover mode for a UV session.
     * When enabled, hovering a face tints the entire UV island it belongs to
     * rather than just the single face.
     */
    public setUVIslandHoverMode3D(meshId: string, enabled: boolean): void {
        const session = this._uvSessions.get(meshId);
        if (session) session.islandHoverMode = enabled;
    }

    // ── UV Editor — editing operations (Phase 4) ──────────────────────────────

    /** Translate selected UVs by (du, dv). Undoable. */
    public moveSelectedUVs3D(meshId: string, du: number, dv: number): boolean {
        return this._uvEdit.moveSelected(meshId, du, dv);
    }

    /** Scale selected UVs around their bounding-box centre. Undoable. */
    public scaleSelectedUVs3D(meshId: string, su: number, sv: number): boolean {
        return this._uvEdit.scaleSelected(meshId, su, sv);
    }

    /** Rotate selected UVs around their bounding-box centre. Undoable. */
    public rotateSelectedUVs3D(meshId: string, angleRad: number): boolean {
        return this._uvEdit.rotateSelected(meshId, angleRad);
    }

    /** Mirror selected UVs around their centre on the U or V axis. Undoable. */
    public mirrorSelectedUVs3D(meshId: string, axis: 'u' | 'v'): boolean {
        return this._uvEdit.mirrorSelected(meshId, axis);
    }

    /**
     * Weld selected UV vertices within `threshold` UV units of each other.
     * Snaps pairs to midpoint and clears seam flags on interior edges between them. Undoable.
     */
    public weldSelectedUVs3D(meshId: string, threshold = 0.001): boolean {
        return this._uvEdit.weldSelected(meshId, threshold);
    }

    /**
     * Mark selected edges as UV seams (splits islands at those edges).
     * Only valid when the UV session is in edge selection mode. Undoable.
     */
    public splitSelectedUVs3D(meshId: string): boolean {
        return this._uvEdit.splitSelected(meshId);
    }

    /** Pin selected UV vertices so subsequent unwrap operations leave them fixed. */
    public pinSelectedUVs3D(meshId: string): void { this._uvEdit.pinSelected(meshId); }

    /** Unpin selected UV vertices. */
    public unpinSelectedUVs3D(meshId: string): void { this._uvEdit.unpinSelected(meshId); }

    /** Remove all UV pins from this mesh. */
    public unpinAllUVs3D(meshId: string): void { this._uvEdit.unpinAll(meshId); }

    /**
     * Knife cut — draw a free cut across one or more EditMesh faces.
     *
     * `(x0, y0)` → `(x1, y1)` is the knife line in canvas pixels.
     * `canvasWidth` / `canvasHeight` must match the WebGPU canvas resolution.
     *
     * The method projects all EditMesh vertices through the current camera,
     * finds which face edges the line crosses, then splits those faces.
     * Returns false if no intersections were found or the mesh has no EditMesh.
     * Undoable.
     */
    public knifeCut3D(
        meshId: string,
        x0: number, y0: number,
        x1: number, y1: number,
        canvasWidth: number, canvasHeight: number,
    ): boolean {
        const mesh = this.getMesh3D(meshId);
        if (!mesh?.editMesh) return false;
        const em = mesh.editMesh;

        // Build MVP = viewProjection * modelMatrix
        const vp  = this.getCamera3D().getViewProjectionMatrix();
        const mvp = mat4.multiply(mat4.create(), vp, mesh.localMatrix as unknown as mat4);

        // Project each EditMesh vertex to canvas pixel space
        const clip = vec4.create();
        const screenVerts = em.vertices.map(v => {
            vec4.set(clip, v.x, v.y, v.z, 1);
            vec4.transformMat4(clip, clip, mvp);
            const w = clip[3];
            if (w <= 0) return { x: 0, y: 0, ok: false };
            return {
                x: (clip[0] / w + 1) * 0.5 * canvasWidth,
                y: (1 - clip[1] / w) * 0.5 * canvasHeight,
                ok: true,
            };
        });

        // Collect per-face edge intersections
        type Cut = { vA: number; vB: number; t: number; edgeIdx: number };
        const byCuts = new Map<number, Cut[]>();

        for (let fi = 0; fi < em.faces.length; fi++) {
            const fv = em.getFaceVertices(fi);
            const n  = fv.length;
            for (let k = 0; k < n; k++) {
                const vA = fv[k], vB = fv[(k + 1) % n];
                const sA = screenVerts[vA], sB = screenVerts[vB];
                if (!sA.ok || !sB.ok) continue;

                const t = _seg2DIntersect(x0, y0, x1, y1, sA.x, sA.y, sB.x, sB.y);
                // Skip near-vertex hits to avoid degenerate zero-area faces
                if (t === null || t < 0.001 || t > 0.999) continue;

                if (!byCuts.has(fi)) byCuts.set(fi, []);
                const list = byCuts.get(fi)!;
                if (list.length < 2) list.push({ vA, vB, t, edgeIdx: k });
            }
        }

        // Keep only faces with exactly 2 intersected edges
        const faceCuts = [...byCuts.entries()]
            .filter(([, c]) => c.length === 2)
            .map(([faceIdx, cuts]) => ({ faceIdx, cuts }));

        if (faceCuts.length === 0) return false;
        return this.meshEdit.knifeCut(meshId, faceCuts);
    }

    /**
     * Bridge two open edge loops with a ring of quad faces.
     *
     * `loopA` and `loopB` are ordered vertex-index arrays of equal length (n ≥ 2).
     * Each pair (loopA[i], loopA[i+1], loopB[i+1], loopB[i]) becomes one quad.
     * Both loops are treated as closed rings (index wraps at n).
     *
     * Typical use: select the open boundary ring at each end of a cylinder or arch,
     * pass their vertex indices, and the gap is filled with watertight quads.
     * Undoable.
     */
    public bridgeEdgeLoops3D(meshId: string, loopA: number[], loopB: number[]): boolean {
        return this.meshEdit.bridgeEdgeLoops(meshId, loopA, loopB);
    }

    // ── Phase 2 — Multi-select, flip, merge, subdivide, fill hole, separate ──

    /** Extrude a set of faces along their normals. Omit fIdxSet to use current face selection. */
    public extrudeFaces3D(meshId: string, fIdxSet: Set<number> | null, distance: number): boolean {
        return this.meshEdit.extrudeFaces(meshId, fIdxSet, distance);
    }

    /** Inset a set of faces toward their centroids. Omit fIdxSet to use current face selection. */
    public insetFaces3D(meshId: string, fIdxSet: Set<number> | null, amount: number): boolean {
        return this.meshEdit.insetFaces(meshId, fIdxSet, amount);
    }

    /** Delete a set of faces. Omit fIdxSet to use current face selection. */
    public deleteFaces3D(meshId: string, fIdxSet: Set<number> | null): boolean {
        return this.meshEdit.deleteFaces(meshId, fIdxSet);
    }

    /** Reverse the winding of a set of faces, flipping their normals. Omit fIdxSet to use current selection. */
    public flipFaces3D(meshId: string, fIdxSet: Set<number> | null): boolean {
        return this.meshEdit.flipFaces(meshId, fIdxSet);
    }

    /** Weld all vertices within `threshold` distance. Returns the number removed. */
    public mergeByDistance3D(meshId: string, threshold: number): number {
        return this.meshEdit.mergeByDistance(meshId, threshold);
    }

    /** Subdivide face `fIdx` into quads by inserting a center vertex and per-edge midpoints. */
    public subdivideFace3D(meshId: string, fIdx: number): boolean {
        return this.meshEdit.subdivideFace(meshId, fIdx);
    }

    /** Cap an open boundary loop at `boundaryHalfEdgeIdx` (must have twin === -1). */
    public fillHole3D(meshId: string, boundaryHalfEdgeIdx: number): boolean {
        return this.meshEdit.fillHole(meshId, boundaryHalfEdgeIdx);
    }

    /**
     * Extract the selected faces into a new sibling Mesh3D.
     * Returns the new mesh ID, or null if nothing is selected or the mesh has no EditMesh.
     * Omit fIdxSet to use the current face selection.
     */
    public separateFaces3D(meshId: string, fIdxSet: Set<number> | null): string | null {
        return this.meshEdit.separateFaces(meshId, fIdxSet);
    }

    /**
     * Configure proportional (soft) vertex editing.
     * When enabled, `moveVertex3D` applies a distance-based falloff to all nearby vertices.
     */
    public setProportionalEdit3D(meshId: string, enabled: boolean, radius?: number, falloff?: 'smooth' | 'linear' | 'sharp'): void {
        this.meshEdit.setProportionalEdit(meshId, enabled, radius, falloff);
    }

    // ── Vertex colors ─────────────────────────────────────────────────────────

    /** Paint a single vertex's RGBA color. */
    public paintVertexColor3D(meshId: string, vIdx: number, r: number, g: number, b: number, a: number): boolean {
        return this.meshEdit.paintVertexColor(meshId, vIdx, r, g, b, a);
    }

    /** Paint all vertices of a face with one color. */
    public paintFaceColor3D(meshId: string, fIdx: number, r: number, g: number, b: number, a: number): boolean {
        return this.meshEdit.paintFaceColor(meshId, fIdx, r, g, b, a);
    }

    // ── Modifier stack ────────────────────────────────────────────────────────

    /** Add a mirror modifier. Returns the modifier index. */
    public addMirrorModifier3D(meshId: string, axis: 'x' | 'y' | 'z' = 'x', clipping = true): number {
        return this.meshEdit.addMirrorModifier(meshId, axis, clipping);
    }

    /** Add a subdivision (Catmull-Clark) modifier. Returns the modifier index. */
    public addSubdivisionModifier3D(meshId: string, iterations = 1): number {
        return this.meshEdit.addSubdivisionModifier(meshId, iterations);
    }

    /** Enable or disable a modifier without removing it. */
    public setModifierEnabled3D(meshId: string, index: number, enabled: boolean): void {
        this.meshEdit.setModifierEnabled(meshId, index, enabled);
    }

    /** Remove a modifier from the stack. */
    public removeModifier3D(meshId: string, index: number): void {
        this.meshEdit.removeModifier(meshId, index);
    }

    /** Bake modifier at `index` into the base mesh (destructive, undoable). */
    public applyModifier3D(meshId: string, index: number): boolean {
        return this.meshEdit.applyModifier(meshId, index);
    }

    /** Return serializable modifier state for all modifiers on a mesh. */
    public getModifiers3D(meshId: string): object[] {
        return this.meshEdit.getModifiers(meshId);
    }

    /** Create a 3D mesh group container. */
    public createMeshGroup3D(name = '3D Group') {
        return this.scene3d.createMeshGroup(name);
    }

    /** Get all 3D mesh groups in the scene. */
    public getMeshGroups3D() {
        return this.scene3d.getMeshGroups();
    }

    /** Add a mesh to a 3D group. */
    public addMeshToGroup3D(meshId: string, groupId: string): boolean {
        return this.scene3d.addMeshToGroup(meshId, groupId);
    }

    /** Remove a mesh from its parent group back to root. */
    public removeMeshFromGroup3D(meshId: string): boolean {
        return this.scene3d.removeMeshFromGroup(meshId);
    }

    // ── Array Tool ────────────────────────────────────────────────────

    /**
     * Create a linear repeat array from an existing mesh.
     * The source mesh is moved into an ArrayGroup3D and N linked copies are created.
     * All copies share the source's geometry via the geometry pool — editing the source
     * propagates to all copies automatically.
     * @param sourceId  ID of the mesh to repeat.
     * @param count     Number of copies (not counting the source). Default 3.
     * @param spacing   World-space offset per step. Defaults to source width + 10% gap along X.
     */
    public createLinearArray3D(sourceId: string, count = 3, spacing?: [number, number, number]) {
        return this.scene3d.createLinearArray3D(sourceId, count, spacing);
    }

    /**
     * Create a grid (NxM) array from an existing mesh.
     * countX / countY are copies beyond the source along each axis (source sits at index 0,0).
     * spacingX/Y default to source AABB extent + 10% gap along X and Z.
     */
    public createGridArray3D(
        sourceId: string,
        countX = 2,
        spacingX?: [number, number, number],
        countY = 2,
        spacingY?: [number, number, number],
        diagonalOnly = false,
    ) {
        return this.scene3d.createGridArray3D(sourceId, countX, spacingX, countY, spacingY, diagonalOnly);
    }

    /**
     * Create a radial (ring) array from an existing mesh.
     * count includes the source. The source is placed at angle 0 on the ring.
     * axis is the rotation axis ('y' for a floor ring, 'x'/'z' for a wall ring).
     * arcDeg = 360 for a full ring; less for a partial arc.
     */
    public createRadialArray3D(
        sourceId: string,
        count = 6,
        radius?: number,
        axis: 'x' | 'y' | 'z' = 'y',
        arcDeg = 360,
    ) {
        return this.scene3d.createRadialArray3D(sourceId, count, radius, axis, arcDeg);
    }

    /**
     * Update array parameters live (e.g. from a panel slider).
     * Does not push an undo step — call this while dragging; undo is pushed on release.
     */
    public updateArrayParams3D(groupId: string, params: { countX?: number; spacing?: [number, number, number]; countY?: number; spacingY?: [number, number, number]; radius?: number }): void {
        this.scene3d.updateArrayParams3D(groupId, params as any);
    }

    /**
     * Bake the array into independent meshes (converts ArrayGroup3D → MeshGroup3D).
     * Each copy receives its own geometry data. Undoable.
     */
    public bakeArray3D(groupId: string) {
        return this.scene3d.bakeArray3D(groupId);
    }

    /**
     * Bake an ArrayGroup3D into a single unified Mesh3D — all copies merged and vertex-welded
     * into one contiguous mesh. If `gapFill` is set on the LinearArrayParams, bridge boxes
     * are inserted between copies before welding. Undoable.
     */
    public bakeArrayMerged3D(groupId: string) {
        return this.scene3d.bakeArrayMerged3D(groupId);
    }

    /** Return true if the given node ID is an ArrayGroup3D. */
    public isArrayGroup3D(nodeId: string): boolean {
        return this.scene3d.isArrayGroup3D(nodeId);
    }

    /** Return the current ArrayParams for an ArrayGroup3D, or null if not found. */
    public getArrayParams3D(groupId: string) {
        return this.scene3d.getArrayParams3D(groupId);
    }

    /** Return the sourceId (the template mesh ID) for an ArrayGroup3D, or null if not found. */
    public getArraySourceId(groupId: string): string | null {
        return this.scene3d.getArraySourceId(groupId);
    }

    /** Return the IDs of all ArrayGroup3D nodes whose source is `sourceId`. */
    public getArrayGroupsForSource3D(sourceId: string): string[] {
        return this.scene3d.getArrayGroupsForSource(sourceId);
    }

    /**
     * Set a per-instance override for one slot in an ArrayGroup3D.
     * `instanceIndex` is 0-based (source mesh is not counted).
     * Supports rotation (Euler degrees XYZ), scale multipliers, and visibility.
     * Pushes an undo entry.
     */
    public setInstanceOverride3D(groupId: string, instanceIndex: number, override: InstanceOverride): void {
        this.scene3d.setInstanceOverride(groupId, instanceIndex, override);
    }

    /** Remove a per-instance override, restoring the slot to source defaults. Pushes an undo entry. */
    public clearInstanceOverride3D(groupId: string, instanceIndex: number): void {
        this.scene3d.clearInstanceOverride(groupId, instanceIndex);
    }

    /** Return all instance overrides for an array group (for populating a per-instance panel). */
    public getInstanceOverrides3D(groupId: string): Array<{ index: number; override: InstanceOverride }> {
        return this.scene3d.getInstanceOverrides(groupId);
    }

    // ── Geometry Modifier Stack ────────────────────────────────────────────────
    // CPU geometry transforms on any Mesh3D. Different from EditMesh modifier stack
    // (addMirrorModifier3D etc.) which only operates on edit-mode mesh topology.

    /** Append a geometry modifier (Mirror or Solidify) to any mesh. Live — geometry updates immediately. Pushes undo. */
    public addGeomModifier3D(meshId: string, mod: Modifier): void {
        this.scene3d.addGeomModifier(meshId, mod);
    }

    /** Remove the geometry modifier at `index` from the mesh's stack. Pushes undo. */
    public removeGeomModifier3D(meshId: string, index: number): void {
        this.scene3d.removeGeomModifier(meshId, index);
    }

    /** Merge `partial` fields into the geometry modifier at `index`. Pushes undo. */
    public updateGeomModifier3D(meshId: string, index: number, partial: Partial<Modifier>): void {
        this.scene3d.updateGeomModifier(meshId, index, partial);
    }

    /** Return a snapshot of the mesh's geometry modifier stack. */
    public getGeomModifiers3D(meshId: string): Modifier[] {
        return this.scene3d.getGeomModifiers(meshId);
    }

    /**
     * Activate the Array Tool hover-handle interaction.
     * Hovering a mesh shows face-arrow handles; hovering a handle shows ghost copies.
     * Scroll wheel changes count; click commits the ArrayGroup3D.
     */
    public enableArrayTool(mode: 'line' | 'grid' | 'radial' = 'line', initialCount = 3): void {
        this.scene3d.enableArrayTool(mode, initialCount);
    }

    /** Deactivate the Array Tool and clear all ghost/handle visuals. */
    public disableArrayTool(): void {
        this.scene3d.disableArrayTool();
    }

    /** Switch the active Array Tool mode while it is running. */
    public setArrayToolMode(mode: 'line' | 'grid' | 'radial'): void {
        this.scene3d.setArrayToolMode(mode);
    }

    /** Override the ghost copy count from a panel control. */
    public setArrayToolCount(count: number): void {
        this.scene3d.setArrayToolCount(count);
    }

    /** Current ghost copy count (read back for panel display). */
    public getArrayToolCount(): number {
        return this.scene3d.getArrayToolCount();
    }

    /** Set the radial ring axis. Ghost updates immediately. No-op in line/grid mode. */
    public setArrayToolAxis(axis: 'x' | 'y' | 'z'): void {
        this.scene3d.setArrayToolAxis(axis);
    }

    public getArrayToolAxis(): 'x' | 'y' | 'z' {
        return this.scene3d.getArrayToolAxis();
    }

    /** Set ring radius override. Pass null to restore auto-sizing from mesh AABB. */
    public setArrayToolRadius(r: number | null): void {
        this.scene3d.setArrayToolRadius(r);
    }

    public getArrayToolRadius(): number | null {
        return this.scene3d.getArrayToolRadius();
    }

    /** Set arc span in degrees (1–360). Ghost updates immediately. */
    public setArrayToolArc(deg: number): void {
        this.scene3d.setArrayToolArc(deg);
    }

    public getArrayToolArc(): number {
        return this.scene3d.getArrayToolArc();
    }

    /** Upload/apply a texture to a mesh. */
    public async setMeshTexture3D(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        return this.scene3d.setMeshTexture(nodeId, source);
    }

    /** Remove texture from a mesh. */
    public clearMeshTexture3D(nodeId: string): boolean {
        return this.scene3d.clearMeshTexture(nodeId);
    }

    // ── 3D Mesh Properties ──────────────────────────────────────

    /** Set 3D position of a mesh. */
    public setPosition3D(nodeId: string, x: number, y: number, z: number): void {
        const mesh = this.getMesh3D(nodeId);
        if (mesh) {
            mesh.setPosition3D(x, y, z);
            this.scheduleRender();
        }
    }

    /** Set 3D rotation (Euler angles in radians). */
    public setRotation3D(nodeId: string, rx: number, ry: number, rz: number): void {
        const mesh = this.getMesh3D(nodeId);
        if (mesh) {
            mesh.setRotation3D(rx, ry, rz);
            this.scheduleRender();
        }
    }

    /** Set 3D scale. */
    public setScale3D(nodeId: string, sx: number, sy: number, sz: number): void {
        const mesh = this.getMesh3D(nodeId);
        if (mesh) {
            mesh.setScale3D(sx, sy, sz);
            this.scheduleRender();
        }
    }

    /** Set mesh material. */
    public setMeshMaterial(nodeId: string, material: Partial<Material3D>): void {
        const mesh = this.getMesh3D(nodeId);
        if (mesh) {
            mesh.setMaterial(material);
            this.scheduleRender();
        }
    }

    /** Set mesh diffuse color. */
    public setMeshDiffuseColor(nodeId: string, r: number, g: number, b: number, a = 1): void {
        const mesh = this.getMesh3D(nodeId);
        if (mesh) {
            mesh.setDiffuseColor(r, g, b, a);
            this.scheduleRender();
        }
    }

    /** Set mesh opacity (0–1). Values <1 use the transparent pipeline. */
    public setMeshOpacity(nodeId: string, opacity: number): void {
        const mesh = this.getMesh3D(nodeId);
        if (mesh) {
            mesh.setOpacity(opacity);
            this.scheduleRender();
        }
    }

    /** Change mesh primitive type. */
    public setMeshPrimitive(nodeId: string, primitive: MeshPrimitive, config?: Partial<Mesh3DConfig>): void {
        const mesh = this.getMesh3D(nodeId);
        if (mesh) {
            mesh.setPrimitive(primitive, config);
            this.scheduleRender();
        }
    }

    /** Set custom geometry on a mesh. */
    public setMeshGeometry(nodeId: string, geometry: MeshGeometry): void {
        const mesh = this.getMesh3D(nodeId);
        if (mesh) {
            mesh.setGeometry(geometry);
            this.scheduleRender();
        }
    }

    // ── 3D Scene Configuration (PS1 Aesthetics) ─────────────────

    /** Configure PS1-style rendering parameters. */
    public setPS1Config(config: Partial<PS1Config>): void {
        this.renderer3D.setPS1(config);
        this.scheduleRender();
    }

    /** Get current PS1 rendering config. */
    public getPS1Config(): PS1Config {
        return { ...this.renderer3D.ps1Config };
    }

    /**
     * Apply a named retro rendering preset, configuring all relevant settings at once.
     *
     * - `'wobble'` — 320×240 lo-res buffer, vertex jitter (0.8), affine warp (0.6), 32-level
     *               color depth, Bayer dithering, UV quantization, nearest texture filtering,
     *               linear near/far fog. Set `mesh.material.renderStyle = 'gouraud'` per-mesh.
     * - `'pocket'` — 400×240 lo-res buffer, stable vertices, perspective-correct UVs,
     *               near-full color depth, nearest filtering, soft light-blue ambient fog.
     * - `'off'`    — Resets all lo-fi settings; full-resolution PBR rendering restored.
     *
     * @example
     * sm.setRetroPreset3D('wobble');
     * myMesh.material.renderStyle = 'gouraud';
     * sm.scene3d.updateMeshMaterial(myMesh.id, myMesh.material);
     */
    public setRetroPreset3D(preset: 'wobble' | 'pocket' | 'off'): void {
        if (preset === 'wobble') {
            this.renderer3D.setPS1({ ...WOBBLE_PRESET });
            this.renderer3D.setTextureFilterMode('nearest');
            this.renderer3D.setFog({ mode: 'linear', color: [0, 0, 0], near: 8, far: 20, density: 0.1 });
        } else if (preset === 'pocket') {
            this.renderer3D.setPS1({ ...POCKET_PRESET });
            this.renderer3D.setTextureFilterMode('nearest');
            this.renderer3D.setFog({ mode: 'linear', color: [0.85, 0.9, 1.0], near: 12, far: 30, density: 0.1 });
        } else {
            this.renderer3D.setPS1({ ...DEFAULT_PS1_CONFIG });
            this.renderer3D.setTextureFilterMode('linear');
            this.renderer3D.setFog({ mode: 'off', color: [0.8, 0.8, 0.8], near: 5, far: 20, density: 0.1 });
        }
        this.scheduleRender();
    }

    /** Set the directional light. */
    public setDirectionalLight3D(dx: number, dy: number, dz: number, r = 1, g = 1, b = 1, intensity = 1): void {
        this.renderer3D.setDirectionalLight(dx, dy, dz, r, g, b, intensity);
        this.scheduleRender();
    }

    /** Set the ambient light. */
    public setAmbientLight3D(r: number, g: number, b: number, intensity = 1): void {
        this.renderer3D.setAmbientLight(r, g, b, intensity);
        this.scheduleRender();
    }

    /**
     * Aim the directional ("key") light by SUN POSITION — i.e. the direction the light shines FROM (intuitive for
     * a slider pair or a drag-the-sun gizmo). Preserves the current colour + intensity.
     *  - `azimuthDeg`: compass angle around the vertical axis. **0 = front** (+Z, the camera/face side),
     *    **+90 = the +X side**, **180 = behind**, **-90 / 270 = the -X side**.
     *  - `elevationDeg`: height above the horizon. **0 = level with the character**, **90 = straight overhead**,
     *    negative = from below. (Default light ≈ az -31°, el 54° — high front-ish key.)
     */
    public setLightAngles3D(azimuthDeg: number, elevationDeg: number): void {
        const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180, ce = Math.cos(el);
        // sun position (FROM) = [ce·sin az, sin el, ce·cos az]; the light TRAVELS the opposite way → negate.
        const dx = -ce * Math.sin(az), dy = -Math.sin(el), dz = -ce * Math.cos(az);
        const c = this.renderer3D.lightConfig;
        this.renderer3D.setDirectionalLight(dx, dy, dz, c.color[0], c.color[1], c.color[2], c.intensity);
        this.scheduleRender();
    }

    /** Current key-light state, as the raw travel `direction` AND the sun-position `azimuthDeg`/`elevationDeg`
     *  (for initialising the UI), plus colour + intensity. */
    public getLight3D(): { direction: [number, number, number]; azimuthDeg: number; elevationDeg: number; color: [number, number, number]; intensity: number } {
        const c = this.renderer3D.lightConfig, d = c.direction;
        const fx = -d[0], fy = -d[1], fz = -d[2];   // sun position = −(travel direction)
        const elevationDeg = Math.asin(Math.max(-1, Math.min(1, fy))) * 180 / Math.PI;
        const azimuthDeg = Math.atan2(fx, fz) * 180 / Math.PI;   // 0 at +Z (front), +90 at +X
        return { direction: [d[0], d[1], d[2]], azimuthDeg, elevationDeg, color: [c.color[0], c.color[1], c.color[2]], intensity: c.intensity };
    }

    /** Set just the key-light intensity (preserves direction + colour) — for an intensity slider. */
    public setLightIntensity3D(intensity: number): void {
        const c = this.renderer3D.lightConfig;
        this.renderer3D.setDirectionalLight(c.direction[0], c.direction[1], c.direction[2], c.color[0], c.color[1], c.color[2], intensity);
        this.scheduleRender();
    }

    /** Set just the key-light colour 0..1 (preserves direction + intensity) — for a colour swatch. */
    public setLightColor3D(r: number, g: number, b: number): void {
        const c = this.renderer3D.lightConfig;
        this.renderer3D.setDirectionalLight(c.direction[0], c.direction[1], c.direction[2], r, g, b, c.intensity);
        this.scheduleRender();
    }

    /** Render stats for a perf HUD — visible triangle/vertex/object counts + a per-category triangle breakdown
     *  (body/hair/clothing/charms/face/scenery) so users see WHAT to simplify, plus geometry bytes, GP-stroke
     *  count, and frame timing (`frameMs` = last CPU encode time · `fps` = render rate · `gpuName`). Poll this on a
     *  timer for a live HUD. (Real GPU ms + array-instance multiply are Tier-2 follow-ups.) */
    public getRenderStats3D() { return this.scene3d.getRenderStats3D(); }

    /** Set fog parameters. Pass `{ mode: 'off' }` to disable. */
    public setFog3D(config: Partial<FogConfig>): void {
        this.renderer3D.setFog(config);
        this.scheduleRender();
    }

    /** Get current fog config. */
    public getFog3D(): FogConfig {
        return { ...this.renderer3D.fogConfig };
    }

    /** Set the global scene background (skybox). Use `{ mode: 'none' }` to clear. */
    public setSceneBg3D(opts: import('../types/armature-3d').ArmatureBgOptions): void {
        this.renderer3D.setSceneBg(opts);
        this.scheduleRender();
    }

    /** Return a copy of the current scene background options. */
    public getSceneBg3D(): import('../types/armature-3d').ArmatureBgOptions {
        return this.renderer3D.sceneBgOptions;
    }

    /** Set texture sampling filter: 'nearest' (PS1 pixel art) or 'linear' (smooth). */
    public setTextureFilterMode3D(mode: 'nearest' | 'linear'): void {
        this.renderer3D.setTextureFilterMode(mode);
        this.scheduleRender();
    }

    /** Set an equirectangular environment map for IBL diffuse lighting. Pass null to clear. */
    public setEnvironmentMap3D(imageData: ImageData | null, intensity = 1.0): void {
        this.scene3d.setEnvironmentMap3D(imageData, intensity);
    }

    /** Clear the environment map and revert to ambient-color diffuse. */
    public clearEnvironmentMap3D(): void {
        this.scene3d.clearEnvironmentMap3D();
    }

    /** Whether IBL is currently active. */
    public get iblEnabled3D(): boolean {
        return this.scene3d.iblEnabled3D;
    }

    // ── Post-processing ────────────────────────────────────────────────────────

    /**
     * Configure scene post-processing effects.
     * Pass a partial object — only the provided keys are updated.
     *
     * ```ts
     * sm.setPostProcessing3D({ bloom: { enabled: true, threshold: 0.8, intensity: 1.2 } });
     * sm.setPostProcessing3D({ vignette: { enabled: true, intensity: 0.4 } });
     * sm.setPostProcessing3D({ colorGrade: { enabled: true, saturation: 0.2, contrast: 0.1 } });
     * // Disable all:
     * sm.setPostProcessing3D({ bloom: { enabled: false }, vignette: { enabled: false }, colorGrade: { enabled: false } });
     * ```
     */
    public setPostProcessing3D(config: Parameters<typeof this.scene3d.setPostProcessing3D>[0]): void {
        this.scene3d.setPostProcessing3D(config);
    }

    /** Return the current post-processing configuration. */
    public getPostProcessing3D(): PostProcessConfig {
        return this.scene3d.getPostProcessing3D();
    }

    // ── Blend shapes ──────────────────────────────────────────────────────────

    /**
     * Add a blend shape to a mesh. deltaVertices: 6 floats per vertex (dX dY dZ dNX dNY dNZ).
     * Returns the index of the new shape.
     */
    public addBlendShape3D(meshId: string, name: string, deltaVertices: Float32Array): number {
        return this.scene3d.addBlendShape3D(meshId, name, deltaVertices);
    }

    /** Set the blend weight for a shape (0–1). Evaluates the blend immediately. */
    public setBlendWeight3D(meshId: string, shapeIndex: number, weight: number): void {
        this.scene3d.setBlendWeight3D(meshId, shapeIndex, weight);
    }

    /** Return all blend shapes and their current weights for a mesh. */
    public getBlendShapes3D(meshId: string): { name: string; weight: number }[] {
        return this.scene3d.getBlendShapes3D(meshId);
    }

    /** Remove a blend shape by index. Remaining shapes are re-evaluated. */
    public removeBlendShape3D(meshId: string, shapeIndex: number): void {
        this.scene3d.removeBlendShape3D(meshId, shapeIndex);
    }

    /** Create a sprite (flat textured quad) at the given world position. */
    public createSprite3D(x: number, y: number, z: number, width = 1, height = 1, material?: Partial<Material3D>): import('../scene-graph/shapes/mesh-3d').Mesh3D {
        return this.scene3d.createSprite(x, y, z, width, height, material);
    }

    /** Static re-export of PS1 defaults for UI binding. */
    static get PS1Defaults(): PS1Config {
        return { ...DEFAULT_PS1_CONFIG };
    }

    /** Static re-export of fog defaults for UI binding. */
    static get FogDefaults(): FogConfig {
        return { ...DEFAULT_FOG_CONFIG };
    }

    // ── 3D Picking & Transform Controls ────────────────────────────

    /**
     * Pick the front-most visible Mesh3D under the given canvas pixel.
     * All four values must be in the SAME pixel space (all CSS or all physical).
     * Prefer pickFromClient3D — it handles coordinate scaling automatically.
     */
    public pick3D(mouseX: number, mouseY: number, canvasWidth: number, canvasHeight: number) {
        return this.scene3d.pick3D(mouseX, mouseY, canvasWidth, canvasHeight);
    }

    /**
     * Pick using raw event client coordinates and the canvas bounding rect.
     * This is always correct regardless of devicePixelRatio.
     *
     *   const rect = canvas.getBoundingClientRect();
     *   const hit  = shapeManager.pickFromClient3D(e.clientX, e.clientY, rect);
     */
    public pickFromClient3D(clientX: number, clientY: number, canvasRect: { left: number; top: number; width: number; height: number }) {
        return this.scene3d.pickFromClient3D(clientX, clientY, canvasRect);
    }

    /**
     * Project a 3D world position to 2D canvas pixel coordinates.
     * Use this to position HTML overlay handles (drag handles, labels) over 3D objects.
     *
     * ```ts
     * const canvas = document.querySelector('canvas')!;
     * const screen = shapeManager.projectWorldToScreen3D(wx, wy, wz, canvas.width, canvas.height);
     * if (screen) handle.style.transform = `translate(${screen.x}px, ${screen.y}px)`;
     * ```
     *
     * @returns Screen pixel position + depth (0=near, 1=far), or null if behind the camera.
     */
    public projectWorldToScreen3D(
        x: number, y: number, z: number,
        canvasW: number, canvasH: number,
    ): { x: number; y: number; depth: number } | null {
        return this.scene3d.projectWorldToScreen3D(x, y, z, canvasW, canvasH);
    }

    /**
     * Unproject a canvas pixel + depth value back to a 3D world position.
     * Use this to convert a mouse drag delta into a world-space displacement for drag handles.
     *
     * ```ts
     * // On pointermove: convert current mouse to world, subtract previous world pos → delta
     * const worldPos = shapeManager.unprojectScreenToWorld3D(e.offsetX, e.offsetY, handleDepth, cw, ch);
     * shapeManager.setRibbonControlPoint3D(id, i, worldPos.x, worldPos.y, worldPos.z);
     * ```
     *
     * @param depth  Pass the `depth` returned by projectWorldToScreen3D for the same point,
     *               so the unprojected ray lands on the correct depth plane.
     */
    public unprojectScreenToWorld3D(
        screenX: number, screenY: number, depth: number,
        canvasW: number, canvasH: number,
    ): { x: number; y: number; z: number } {
        return this.scene3d.unprojectScreenToWorld3D(screenX, screenY, depth, canvasW, canvasH);
    }

    /** Enable click-to-select and transform gizmo on the 3D canvas. */
    public enableTransformControls3D(): void {
        this.scene3d.enableTransformControls();
    }

    /** Disable and remove transform controls. */
    public disableTransformControls3D(): void {
        this.scene3d.disableTransformControls();
    }

    /** Switch the active gizmo mode ('move' | 'rotate' | 'scale' | null to hide). */
    public setGizmoMode3D(mode: 'move' | 'rotate' | 'scale' | null): void {
        this.scene3d.setGizmoMode(mode);
    }

    /** Get the active gizmo mode, or null if no gizmo is active. */
    public getGizmoMode3D(): 'move' | 'rotate' | 'scale' | null {
        return this.scene3d.getGizmoMode();
    }

    /** Set gizmo orientation: 'world' keeps handles world-aligned; 'local' rotates handles with the mesh. */
    public setGizmoOrientation3D(mode: 'world' | 'local'): void {
        this.scene3d.setGizmoOrientation(mode);
    }

    /** Get the current gizmo orientation mode. */
    public getGizmoOrientation3D(): 'world' | 'local' {
        return this.scene3d.getGizmoOrientation();
    }

    /** Grid size for Ctrl+drag position snapping (world units). Default 1.0. */
    get snapGridSize3D(): number { return this.scene3d.snapGridSize; }
    set snapGridSize3D(v: number) { this.scene3d.snapGridSize = v; }

    /** Angle increment for Ctrl+drag rotation snapping (radians). Default π/12 (15°). */
    get snapAngle3D(): number { return this.scene3d.snapAngle; }
    set snapAngle3D(v: number) { this.scene3d.snapAngle = v; }

    /** Scale increment for Ctrl+drag scale snapping. Default 0.25. */
    get snapScaleStep3D(): number { return this.scene3d.snapScaleStep; }
    set snapScaleStep3D(v: number) { this.scene3d.snapScaleStep = v; }

    /** True when Ctrl is held and grid snapping is active this frame. */
    get snapActive3D(): boolean { return this.scene3d.snapActive; }

    /**
     * Ctrl+drag snap mode. Persists between drags; Frogmarks exposes as a panel dropdown.
     * - `'grid'` — snap to `snapGridSize3D` increments (default)
     * - `'vertex'` — snap mesh origin to nearest vertex of any non-selected mesh (screen-space 20px threshold)
     * - `'none'` — Ctrl+drag has no snap effect
     */
    get snapMode3D(): 'none' | 'grid' | 'vertex' { return this.scene3d.snapMode; }
    set snapMode3D(m: 'none' | 'grid' | 'vertex') { this.scene3d.snapMode = m; }

    // ── Visible ground grid (Y=0 reference plane) ────────────────────
    // A drawn grid (separate from the snap math above) whose spacing tracks `snapGridSize3D`,
    // so the grid you see is the grid you snap to. All three are properties to match the snap
    // settings, and they're persisted per-illustration in the saved scene (restored on load —
    // the panel just reflects them). (2D canvas grid will follow the same shape on the raster side.)

    /** Show/hide the visible ground reference grid. Default false. */
    get sceneGridVisible3D(): boolean { return this.scene3d.gridVisible; }
    set sceneGridVisible3D(v: boolean) { this.scene3d.gridVisible = v; }

    // ── Enhanced visuals (togglable — default OFF = the current look; live uniform flip, no regen; turn off for perf) ──
    /** Master toggle: stylized fresnel GLASS + AERIAL-PERSPECTIVE fog. Off = the current look (best performance). */
    public setEnhancedVisuals3D(on: boolean): void {
        this.renderer3D.setGlassQuality(on);
        this.renderer3D.setAerialFog(on ? 0.7 : 0);
        this.scheduleRender();
    }
    /** Stylized fresnel sky-reflection on glass surfaces (glass towers / storefronts). */
    public setGlassQuality3D(on: boolean): void { this.renderer3D.setGlassQuality(on); this.scheduleRender(); }
    public get glassQuality3D(): boolean { return this.renderer3D.glassQuality; }
    /** Aerial-perspective strength 0..1 — distant geometry desaturates + fades to the fog colour (needs fog on). */
    public setAerialPerspective3D(strength: number): void { this.renderer3D.setAerialFog(strength); this.scheduleRender(); }
    public get aerialPerspective3D(): number { return this.renderer3D.aerialFog; }

    /** Render-only gate for the 3D ground grid (NOT persisted). Set false to hide it without touching the saved
     *  setting — e.g. while a 2D/vector layer is active. effective visibility = sceneGridVisible3D && this. */
    get sceneGridVisible3DOverride(): boolean { return this.scene3d.gridVisibleOverride; }
    set sceneGridVisible3DOverride(v: boolean) { this.scene3d.gridVisibleOverride = v; }

    /** Minor grid-line color `[r,g,b]` 0..1. The X/Z axis lines stay red/blue. Default a muted gray-blue. */
    get sceneGridColor3D(): [number, number, number] { return this.scene3d.gridColor; }
    set sceneGridColor3D(c: [number, number, number]) { this.scene3d.gridColor = c; }

    /** Grid-line opacity 0..1. Default 0.32. */
    get sceneGridOpacity3D(): number { return this.scene3d.gridOpacity; }
    set sceneGridOpacity3D(v: number) { this.scene3d.gridOpacity = v; }

    // ── Visible 2D canvas grid (artboard-space; the 2D sibling of the scene grid) ─────
    // Drawn by the background shader in artboard space, so it pans/zooms with the canvas
    // (comic-panel / layout / alignment use case). Same property shape as the 3D grid.
    // Sizing is CELL COUNT across the document (intuitive for a UI: "16-cell grid").

    /** Show/hide the visible 2D canvas grid. Default false. */
    get canvasGridVisible(): boolean { return this.webgpuRenderer.getCanvasGridVisible(); }
    set canvasGridVisible(v: boolean) { this.webgpuRenderer.setCanvasGridVisible(v); }

    /** Render-only gate for the 2D canvas grid (NOT persisted). Set false to hide it without touching the saved
     *  setting — e.g. while a 3D scene is active. effective visibility = canvasGridVisible && this. */
    get canvasGridVisibleOverride(): boolean { return this.webgpuRenderer.getCanvasGridVisibleOverride(); }
    set canvasGridVisibleOverride(v: boolean) { this.webgpuRenderer.setCanvasGridVisibleOverride(v); }

    /** Master visibility for the whole 3D scene (the "3D Scene" layer eye icon). Set false to hide ALL
     *  3D output — meshes, grid, gizmos, bones, particles, 3D-GP — in one go, WITHOUT touching any
     *  object's state, so flipping it back on restores the scene exactly. Render-only; persist the
     *  toggle on the Frogmarks side (e.g. with the layer) and re-apply it on load. */
    get scene3DVisible(): boolean { return this.webgpuRenderer?.scene3DVisible ?? true; }
    set scene3DVisible(v: boolean) { this.webgpuRenderer?.setScene3DVisible(v); }

    /** Grid-line color `[r,g,b]` 0..1. Default muted gray-blue. */
    get canvasGridColor(): [number, number, number] { return this.webgpuRenderer.getCanvasGridColor(); }
    set canvasGridColor(c: [number, number, number]) { this.webgpuRenderer.setCanvasGridColor(c[0], c[1], c[2]); }

    /** Grid-line opacity 0..1. Default 0.35. */
    get canvasGridOpacity(): number { return this.webgpuRenderer.getCanvasGridOpacity(); }
    set canvasGridOpacity(v: number) { this.webgpuRenderer.setCanvasGridOpacity(v); }

    /** Number of grid cells across the document (default 16). E.g. a "32-cell grid". */
    get canvasGridCells(): number { return this.webgpuRenderer.getCanvasGridCells(); }
    set canvasGridCells(v: number) { this.webgpuRenderer.setCanvasGridCells(v); }

    /**
     * World-space position of the active vertex snap target during a drag; null otherwise.
     * Convert to canvas coords for the indicator dot: `sm.worldToScreen3D(sm.getSnapTarget3D())`.
     */
    public getSnapTarget3D(): [number, number, number] | null {
        return this.scene3d.getSnapTarget();
    }

    /**
     * Vertex-snap "double-circle" visualization for the current drag, or null when not vertex-snapping.
     * Draw two circles at `centerWorld` (project via `worldToScreen3D`) sized `innerPx`/`outerPx`, and a
     * square at each candidate; `active` is the vertex that will snap (front-most) — fade the rest by `depthT`.
     */
    public getSnapViz3D(): SnapVizData | null {
        return this.scene3d.getSnapViz();
    }

    /** Vertex-snap INNER radius (px) — the snap threshold + inner circle. Default 20. */
    get snapVertexRadiusPx3D(): number { return this.scene3d.snapVertexRadiusPx; }
    set snapVertexRadiusPx3D(v: number) { this.scene3d.snapVertexRadiusPx = v; }
    /** Vertex-snap OUTER radius (px) — candidate squares show inside it. Default 50. */
    get snapCandidateRadiusPx3D(): number { return this.scene3d.snapCandidateRadiusPx; }
    set snapCandidateRadiusPx3D(v: number) { this.scene3d.snapCandidateRadiusPx = v; }

    /**
     * Project a world-space point onto the WebGPU canvas, returning `[canvasX, canvasY]` pixel
     * coordinates. Returns null when the point is behind the camera or the canvas is unavailable.
     *
     * Use for snap indicator dots, drag angle labels, and any other HUD elements that need to
     * track a 3D world position:
     *
     * @example
     * const snap = sm.getSnapTarget3D();
     * if (snap) {
     *   const scr = sm.worldToScreen3D(snap);
     *   if (scr) drawDot(scr[0], scr[1]);
     * }
     *
     * @example
     * // Rotation angle label — previously gizmoCenterWorld had no screen-space equivalent:
     * const info = sm.getDragInfo3D();
     * if (info.gizmoCenterWorld) {
     *   const [cx, cy] = sm.worldToScreen3D(info.gizmoCenterWorld) ?? [0, 0];
     *   showLabel(`${info.angleDeg?.toFixed(1)}°`, cx, cy);
     * }
     */
    public worldToScreen3D(worldPos: [number, number, number]): [number, number] | null {
        return this.scene3d.worldToScreen(worldPos);
    }

    /**
     * Returns live gizmo drag state for rendering a degree readout overlay.
     * Poll this inside your animation loop; `angleDeg` is non-null only
     * during a rotation drag. Project `gizmoCenterWorld` through the camera
     * to get canvas coordinates for positioning the label.
     *
     * @example
     * const info = sm.getDragInfo3D();
     * if (info?.angleDeg !== null) showRotationLabel(info.angleDeg, info.gizmoCenterWorld);
     */
    public getDragInfo3D() {
        return this.scene3d.getDragInfo();
    }

    // ── Viewport transform shortcuts ────────────────────────────────

    /** True while a keyboard-driven transform (G/R/S shortcut) is in progress. */
    get isShortcutActive3D(): boolean { return this.scene3d.isShortcutActive; }
    /** Active shortcut mode, or null when idle. */
    get shortcutMode3D(): 'grab' | 'rotate' | 'scale' | null { return this.scene3d.shortcutMode; }
    /** Axis constraint, or null when unconstrained. */
    get shortcutAxis3D(): 'x' | 'y' | 'z' | null { return this.scene3d.shortcutAxis; }
    /** Numeric input buffer for display (e.g. "-4.5"). */
    get shortcutNumericDisplay3D(): string { return this.scene3d.shortcutNumericDisplay; }

    /**
     * Begin a keyboard-driven transform on the currently selected meshes.
     * Frogmarks calls this from its `@HostListener('document:keydown')` handler
     * when G (grab), R (rotate), or S (scale) is pressed.
     *
     * @example
     * // In Frogmarks keydown handler:
     * if (e.key === 'g') sm.beginTransform3D('grab');
     * if (e.key === 'r') sm.beginTransform3D('rotate');
     * if (e.key === 's') sm.beginTransform3D('scale');
     */
    public beginTransform3D(mode: 'grab' | 'rotate' | 'scale'): void {
        this.scene3d.beginTransform3D(mode);
    }

    /**
     * Lock the active shortcut to a world axis. No-op when no shortcut is active.
     *
     * @example
     * if (e.key === 'x') sm.constrainAxis3D('x');
     */
    public constrainAxis3D(axis: 'x' | 'y' | 'z'): void {
        this.scene3d.constrainAxis3D(axis);
    }

    /**
     * Append one character to the numeric input buffer.
     * Axis must be set first (unconstrained numeric input is a no-op).
     * Accepts digits, '.', and '-' (minus only as the first character).
     *
     * @example
     * // In Frogmarks keydown handler, after axis is set:
     * if (/^[\d.\-]$/.test(e.key)) sm.appendNumericInput(e.key);
     */
    public appendNumericInput(char: string): void {
        this.scene3d.appendNumericInput(char);
    }

    /**
     * Commit the shortcut transform and push an undo record.
     * No-op when no shortcut is active.
     *
     * @example
     * if (e.key === 'Enter') sm.commitTransform3D();
     */
    public commitTransform3D(): void {
        this.scene3d.commitTransform3D();
    }

    /**
     * Cancel the active shortcut (restoring pre-shortcut positions) **or** cancel
     * a gizmo drag that is currently in-flight. Safe to call when neither is active.
     *
     * @example
     * if (e.key === 'Escape') sm.cancelTransform3D();
     */
    public cancelTransform3D(): void {
        this.scene3d.cancelTransform3D();
    }

    /** Get the set of currently selected 3D mesh IDs. */
    public getSelected3DIDs(): Set<string> {
        return this.scene3d.getSelected3DIds();
    }

    /** Programmatically set the selected 3D mesh IDs. */
    public setSelected3DIDs(ids: Set<string>): void {
        this.scene3d.setSelected3DIds(ids);
    }

    /** Clear the 3D selection. */
    public clearSelection3D(): void {
        this.scene3d.clearSelection();
    }

    // ── 3D Keyframe Animation ────────────────────────────────────────

    /** Upload a texture to the shared library and apply it to a mesh. Returns the library ID. */
    public async uploadAndApplyTexture3D(meshId: string, source: File | Blob | ImageBitmap, name?: string): Promise<string | null> {
        return this.scene3d.uploadAndApplyTexture(meshId, source, name);
    }

    /** Apply an already-uploaded library texture to a mesh by its library ID. */
    public applyLibraryTexture3D(meshId: string, textureId: string): boolean {
        return this.scene3d.applyLibraryTexture(meshId, textureId);
    }

    /** Get the shared texture library (lazy-initialized). */
    public getTextureLibrary3D() {
        return this.scene3d.getTextureLibrary();
    }

    // ── 3D Keyframe Animation ────────────────────────────────────────

    /** Set a keyframe on a mesh property track. */
    public setMeshKeyframe3D(meshId: string, property: string, frame: number, value: any, easing: 'step' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' = 'linear'): boolean {
        return this.scene3d.setMeshKeyframe(meshId, property as any, frame, value, easing);
    }

    /** Remove a keyframe from a mesh property track. */
    public removeMeshKeyframe3D(meshId: string, property: string, frame: number): boolean {
        return this.scene3d.removeMeshKeyframe(meshId, property as any, frame);
    }

    /** Get all keyframe tracks for a mesh. */
    public getMeshKeyframeTracks3D(meshId: string) {
        return this.scene3d.getMeshKeyframeTracks(meshId);
    }

    /** Clear all keyframe tracks for a mesh. */
    public clearMeshKeyframeTracks3D(meshId: string): boolean {
        return this.scene3d.clearMeshKeyframeTracks(meshId);
    }

    /** Apply all keyframes for all meshes at the given frame number. */
    public applyAllKeyframesAtFrame3D(frame: number): void {
        this.scene3d.applyAllKeyframesAtFrame(frame);
    }

    /** Sync 3D mesh keyframes to the raster timeline's frame-changed event. */
    public attachKeyframesToTimeline3D(): void {
        this.scene3d.attachKeyframesToTimeline();
    }

    /** Detach 3D keyframes from the raster timeline. */
    public detachKeyframesFromTimeline3D(): void {
        this.scene3d.detachKeyframesFromTimeline();
    }

    /**
     * Snapshot a mesh's current position/rotation/scale as keyframes.
     * If frame is omitted, uses the current raster timeline frame.
     */
    public recordKeyframeForMesh3D(meshId: string, frame?: number): boolean {
        return this.scene3d.recordKeyframeForMesh(meshId, frame);
    }

    /**
     * Record keyframes for every currently selected 3D mesh.
     * Returns the number of meshes keyed. Suitable for a "Record Keyframe (K)" button.
     */
    public recordKeyframesForSelectedMeshes3D(frame?: number): number {
        return this.scene3d.recordKeyframesForSelectedMeshes(frame);
    }

    /**
     * When true, every completed gizmo drag auto-records a keyframe at the current
     * timeline frame for each moved mesh (auto-keying, like Blender / After Effects).
     */
    get autoKey3D(): boolean { return this.scene3d.autoKey3D; }
    set autoKey3D(v: boolean) { this.scene3d.autoKey3D = v; }

    // ── Blend shape weight keyframes ────────────────────────────────

    /** Set a keyframe for a blend shape weight by name. Undoable. */
    public setBlendShapeKeyframe3D(
        meshId: string,
        shapeName: string,
        frame: number,
        weight: number,
        easing: 'step' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' = 'linear',
    ): boolean {
        return this.scene3d.setBlendShapeKeyframe(meshId, shapeName, frame, weight, easing);
    }

    /** Remove a blend shape weight keyframe at the given frame. Undoable. */
    public removeBlendShapeKeyframe3D(meshId: string, shapeName: string, frame: number): boolean {
        return this.scene3d.removeBlendShapeKeyframe(meshId, shapeName, frame);
    }

    /** Get all blend shape weight keyframe tracks for a mesh. Keys = shape names. */
    public getBlendShapeKeyframeTracks3D(meshId: string): Record<string, { frame: number; value: number; easing: string }[]> | null {
        return this.scene3d.getBlendShapeKeyframeTracks(meshId) as any;
    }

    /**
     * Returns all frame numbers where any keyframe track on this mesh has a keyframe.
     * Use this to render per-frame diamond markers on the mesh's timeline row.
     */
    public getMeshKeyframeFrames3D(meshId: string): number[] {
        return this.scene3d.getMeshKeyframeFrames(meshId);
    }

    // ── Camera keyframe animation ─────────────────────────────────────

    /** Set a keyframe on a camera track. `property`: 'position' | 'target' | 'fov'. */
    public setCameraKeyframe3D(
        property: 'position' | 'target' | 'fov',
        frame: number,
        value: [number, number, number] | number,
        easing: 'step' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' = 'linear',
    ): void {
        this.scene3d.setCameraKeyframe(property as any, frame, value, easing as any);
    }

    /** Remove a camera keyframe. */
    public removeCameraKeyframe3D(property: 'position' | 'target' | 'fov', frame: number): boolean {
        return this.scene3d.removeCameraKeyframe(property as any, frame);
    }

    /** Get all camera keyframe tracks. */
    public getCameraKeyframeTracks3D() {
        return this.scene3d.getCameraKeyframeTracks();
    }

    /** Clear all camera keyframe tracks. */
    public clearCameraKeyframeTracks3D(): void {
        this.scene3d.clearCameraKeyframeTracks();
    }

    /**
     * Snapshot the current camera position, target, and FOV as keyframes at `frame`.
     * If frame is omitted, uses the current raster timeline frame.
     */
    public recordCameraKeyframe3D(frame?: number): void {
        this.scene3d.recordCameraKeyframe(frame);
    }

    /**
     * Highlight a 3D mesh with a thin light-blue outline (hover state).
     * Pass null to clear. Call from Outliner list item mouseenter/mouseleave,
     * or let transform controls handle canvas hover automatically.
     */
    public setHoveredMesh3D(id: string | null): void {
        this.scene3d.setHoveredMesh(id);
    }

    public getHoveredMesh3DId(): string | null {
        return this.scene3d.getHoveredMeshId();
    }

    /** Returns true if the mesh has a keyframe on any track at exactly `frame`. */
    public hasMeshKeyframeAtFrame3D(meshId: string, frame: number): boolean {
        return this.scene3d.hasMeshKeyframeAtFrame(meshId, frame);
    }

    /**
     * Flat list of every Mesh3D in the scene (including those inside groups).
     * Use this to build the animation panel's per-mesh rows — not just the selected mesh.
     */
    public getAllMeshesForAnimation3D(): { id: string; name: string }[] {
        return this.scene3d.getAllMeshesForAnimation();
    }

    /**
     * Keyframe track data for every mesh in the scene, in one call.
     * Returns [{ meshId, name, tracks }] where tracks has the same shape as
     * getMeshKeyframeTracks3D() — use this to build per-mesh dope-sheet rows.
     */
    public getAllMeshKeyframeTracks3D(): { meshId: string; name: string; tracks: import('../types/keyframe-3d').Mesh3DKeyframeTracks }[] {
        return this.scene3d.getAllMeshKeyframeTracks();
    }

    /** Create an AnimationPlayer3D that drives keyframe playback via requestAnimationFrame. */
    public createAnimationPlayer3D(config?: { startFrame?: number; endFrame?: number; fps?: number; loop?: boolean }) {
        return this.scene3d.createAnimationPlayer(config);
    }

    /** Get the current AnimationPlayer3D (if one was created). */
    public getAnimationPlayer3D() {
        return this.scene3d.getAnimationPlayer();
    }

    // ── 3D Illustration camera auto-sync ────────────────────────────

    /**
     * Subscribe to the render loop so the 3D illustration camera automatically
     * tracks pan/zoom every frame.  Call once on document load instead of
     * manually calling syncIllustrationCamera3D on every pan/zoom event.
     */
    public enableAutoSyncIllustrationCamera3D(): void {
        this.scene3d.enableAutoSyncIllustrationCamera();
    }

    /** Stop the automatic camera sync started by enableAutoSyncIllustrationCamera3D. */
    public disableAutoSyncIllustrationCamera3D(): void {
        this.scene3d.disableAutoSyncIllustrationCamera();
    }

    // ── Frame Link Animation 3D ──────────────────────────────────────

    /**
     * Set (or update) a procedural frame-link animation on a 3D mesh.
     * The animation runs on top of keyframes — no keyframes needed.
     *
     * Example — make a mesh bounce up and down:
     *   setFrameLinkAnimation3D(id, { enabled: true, type: 'bounce', axis: 'y',
     *                                  amplitude: 0.1, framesPerCycle: 24 });
     */
    public setFrameLinkAnimation3D(meshId: string, anim: Partial<import('../types/keyframe-3d').FrameLinkAnimation3D>): boolean {
        return this.scene3d.setFrameLinkAnimation3D(meshId, anim);
    }

    /** Get the current frame-link animation config for a mesh (null if none). */
    public getFrameLinkAnimation3D(meshId: string): import('../types/keyframe-3d').FrameLinkAnimation3D | null {
        return this.scene3d.getFrameLinkAnimation3D(meshId);
    }

    /** Remove the frame-link animation from a mesh. */
    public removeFrameLinkAnimation3D(meshId: string): boolean {
        return this.scene3d.removeFrameLinkAnimation3D(meshId);
    }

    // ── Cloth meshes ──────────────────────────────────────────────────

    /** Create a new ClothMesh3D and add it to the scene graph. */
    public createClothMesh(
        x: number, y: number, z: number,
        gridConfig?: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothGridConfig>,
        physicsConfig?: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothPhysicsConfig>,
        simulatedPositions?: Float32Array,
        name?: string,
    ) { return this.scene3d.createClothMesh(x, y, z, gridConfig, physicsConfig, simulatedPositions, name); }

    /** Replace grid/physics/pose of an existing ClothMesh3D in-place. */
    public replaceClothMesh(
        meshId: string,
        gridConfig: import('../scene-graph/shapes/cloth-mesh-3d').ClothGridConfig,
        physicsConfig: import('../scene-graph/shapes/cloth-mesh-3d').ClothPhysicsConfig,
        simulatedPositions?: Float32Array,
        mode?: 'hang' | 'drape' | 'none',
    ) { return this.scene3d.replaceClothMesh(meshId, gridConfig, physicsConfig, simulatedPositions, mode); }

    /** Run cloth simulation to steady-state and return final vertex positions. */
    public simulateCloth(
        gridConfig: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothGridConfig>,
        physicsConfig: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothPhysicsConfig>,
        mode: 'hang' | 'drape',
        proxy?: import('./managers/scene3d-manager').DrapeProxy,
        maxSteps?: number,
    ) { return this.scene3d.simulateCloth(gridConfig, physicsConfig, mode, proxy, maxSteps); }

    /** Apply simulated positions to an existing ClothMesh3D without rebuilding its config. */
    public updateClothMeshPose(
        meshId: string,
        simulatedPositions: Float32Array,
        mode?: 'hang' | 'drape' | 'none',
    ) { return this.scene3d.updateClothMeshPose(meshId, simulatedPositions, mode); }

    /** Fetch the grid and physics config for an existing ClothMesh3D. */
    public getClothConfig(meshId: string) { return this.scene3d.getClothConfig(meshId); }

    /** Fetch the cached ClothGeometryResult (constraint graph, inverse masses, slot maps). */
    public getClothGeometryResult(meshId: string) { return this.scene3d.getClothGeometryResult(meshId); }

    /**
     * Convert a vertex grid position to a dense vertex index.
     * Always use this instead of computing `col + row * cols` (cell stride).
     * The correct stride is `cols + 1`, not `cols` — they diverge for every
     * vertex past the first column of row 1 and beyond.
     *
     * Returns -1 if the slot is inactive (corner cutout / hole).
     * Returns null if the mesh is not found.
     *
     * @param col  0 … clothConfig.cols  (vertex column, inclusive)
     * @param row  0 … clothConfig.rows  (vertex row, inclusive)
     */
    public getClothVertexIndex(meshId: string, col: number, row: number) {
        return this.scene3d.getClothVertexIndex(meshId, col, row);
    }

    // ── Live cloth config updates ────────────────────────────────────

    /**
     * Rebuild the cloth from updated grid or physics params and sync the running
     * live simulation. Call this on every UI control change for instant feedback.
     * Pass only the fields that changed; omitted fields keep their current values.
     */
    public setClothConfig(
        meshId: string,
        gridConfig?: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothGridConfig>,
        physicsConfig?: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothPhysicsConfig>,
    ) { return this.scene3d.setClothConfig(meshId, gridConfig, physicsConfig); }

    /**
     * Hot-update physics params (gravity, damping, stiffness, wind) without
     * rebuilding geometry. Safe to call on every slider tick.
     */
    public setClothPhysics(
        meshId: string,
        params: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothPhysicsConfig>,
    ) { return this.scene3d.setClothPhysics(meshId, params); }

    /**
     * Hot-swap pinned vertices without resetting the cloth to flat.
     * The cloth continues simulating — pinned vertices lock immediately.
     * Use this instead of setClothConfig({ pinnedVertices }) for all
     * interactive pin/unpin operations.
     */
    public setClothPinnedVertices(meshId: string, pinnedVertices: number[]) {
        return this.scene3d.setClothPinnedVertices(meshId, pinnedVertices);
    }

    /**
     * Debounced setClothConfig — accumulates rapid UI changes (slider drags)
     * and applies them after `delayMs` of silence (default 150 ms).
     * Each call resets the timer so only the final value triggers a rebuild.
     */
    public setClothConfigDebounced(
        meshId: string,
        gridConfig?: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothGridConfig>,
        physicsConfig?: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothPhysicsConfig>,
        delayMs = 150,
    ) { return this.scene3d.setClothConfigDebounced(meshId, gridConfig, physicsConfig, delayMs); }

    // ── Cloth stitch tool ────────────────────────────────────────────

    /**
     * Begin the interactive stitch tool. Picks vertexA and enables hover preview.
     * @param restLength  0 = full stitch; >0 = pleat gap in world units.
     */
    public beginClothStitchTool(meshId: string, vertexA: number, restLength = 0) {
        return this.scene3d.beginClothStitchTool(meshId, vertexA, restLength);
    }

    /**
     * Call on every pointer-move while stitch tool is active. Resets the live
     * sim with a temporary stitch to vertexB so the cloth previews the gather.
     * No-op if vertexB hasn't changed.
     */
    public previewClothStitch(meshId: string, vertexB: number) {
        return this.scene3d.previewClothStitch(meshId, vertexB);
    }

    /** Commit the previewed stitch as a permanent constraint. */
    public commitClothStitch(meshId: string) {
        return this.scene3d.commitClothStitch(meshId);
    }

    /** Cancel the stitch tool without saving — restores simulation to committed state. */
    public cancelClothStitchTool(meshId: string) {
        return this.scene3d.cancelClothStitchTool(meshId);
    }

    // ── Cloth stitching ──────────────────────────────────────────────

    /**
     * Add a vertex-to-vertex stitch constraint. restLength=0 pulls vertices flush
     * together; restLength>0 creates a gather at the specified world-unit distance.
     * Returns the stitch index in clothConfig.stitches, or null on error.
     */
    public addClothStitch(meshId: string, a: number, b: number, restLength: number) {
        return this.scene3d.addClothStitch(meshId, a, b, restLength);
    }

    /** Remove a stitch by its array index. */
    public removeClothStitch(meshId: string, index: number) {
        return this.scene3d.removeClothStitch(meshId, index);
    }

    /** Remove all stitches from a cloth mesh. */
    public clearClothStitches(meshId: string) {
        return this.scene3d.clearClothStitches(meshId);
    }

    /** Return all stitch constraints for a cloth mesh. */
    public getClothStitches(meshId: string) {
        return this.scene3d.getClothStitches(meshId);
    }

    // ── Cloth bend stiffness ─────────────────────────────────────────

    /**
     * Set the per-vertex bend-stiffness map (values 0–1).
     * 0 = floppy silk, 1 = stiff cardboard. Length = vertexCount.
     * Hot-updates any running live simulation immediately.
     */
    public setClothBendStiffness(meshId: string, map: Float32Array | number[]) {
        return this.scene3d.setClothBendStiffness(meshId, map);
    }

    /** Return the current per-vertex bend-stiffness map. */
    public getClothBendStiffnessMap(meshId: string) {
        return this.scene3d.getClothBendStiffnessMap(meshId);
    }

    // ── Cloth wind zones ─────────────────────────────────────────────

    /**
     * Add a spatial wind zone to a cloth mesh. Active during live simulation only.
     * Returns the zone ID (use it with removeWindZone / updateWindZone).
     */
    public addWindZone(
        meshId: string,
        zone: Omit<import('../scene-graph/shapes/cloth-mesh-3d').WindZone, 'id'>,
    ) { return this.scene3d.addWindZone(meshId, zone); }

    /** Remove a wind zone by ID. */
    public removeWindZone(meshId: string, zoneId: string) {
        return this.scene3d.removeWindZone(meshId, zoneId);
    }

    /** Patch fields of an existing wind zone. */
    public updateWindZone(
        meshId: string,
        zoneId: string,
        patch: Partial<Omit<import('../scene-graph/shapes/cloth-mesh-3d').WindZone, 'id'>>,
    ) { return this.scene3d.updateWindZone(meshId, zoneId, patch); }

    /** Return all wind zones for a cloth mesh. */
    public getWindZones(meshId: string) {
        return this.scene3d.getWindZones(meshId);
    }

    /** Remove all wind zones from a cloth mesh. */
    public clearWindZones(meshId: string) {
        return this.scene3d.clearWindZones(meshId);
    }

    /**
     * Create a LiveClothHandle for live preview in the Cloth Builder modal.
     * Set handle.onPositionsUpdate before use. Always call handle.destroy() on modal close.
     */
    public createLiveClothSim(
        grid: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothGridConfig>,
        physics: Partial<import('../scene-graph/shapes/cloth-mesh-3d').ClothPhysicsConfig>,
        mode: 'hang' | 'drape',
        proxy?: import('./managers/scene3d-manager').DrapeProxy,
    ) { return this.scene3d.createLiveClothSim(grid, physics, mode, proxy); }

    /** Enable persistent live physics for a cloth mesh (for Wind animation in the scene). */
    public enableLiveCloth(meshId: string, stepsPerFrame?: number) {
        return this.scene3d.enableLiveCloth(meshId, stepsPerFrame);
    }

    /** Disable live physics. Pass bakeCurrentPose=true to freeze the cloth in its current shape. */
    public async disableLiveCloth(meshId: string, bakeCurrentPose = false) {
        return this.scene3d.disableLiveCloth(meshId, bakeCurrentPose);
    }

    /**
     * Attach a secondary <canvas> element to receive a live cloth preview.
     * The canvas gets its own WebGPU context and renders the mesh after every
     * updateClothMeshPose() call. Orbit drag is enabled by default.
     *
     * Returns a dispose function — call it when the modal closes.
     *
     * Usage:
     * ```ts
     * const disposePreview = shapeManager.attachClothPreviewCanvas(meshId, canvasEl);
     * // ... on modal close:
     * disposePreview();
     * ```
     */
    public attachClothPreviewCanvas(
        meshId: string,
        canvas: HTMLCanvasElement,
        opts?: { bgColor?: [number, number, number, number]; orbitEnabled?: boolean },
    ): () => void {
        return this.scene3d.attachClothPreviewCanvas(meshId, canvas, opts);
    }

    // ── Particle emitters ────────────────────────────────────────────

    /**
     * Add a CPU-simulated billboard particle emitter to the 3D scene.
     * Returns the emitter's ID. Pass a preset name to start with a tuned configuration:
     *   'dust' | 'sparks' | 'snow' | 'magic'
     * Additional config fields override the preset.
     *
     * Example:
     * ```ts
     * const id = shapeManager.addParticleEmitter3D(0, 0, 0, {}, 'sparks');
     * // later:
     * shapeManager.removeParticleEmitter3D(id);
     * ```
     */
    public addParticleEmitter3D(
        x: number, y: number, z: number,
        config: import('../scene-graph/shapes/particle-emitter-3d').ParticleEmitterConfig = {},
        preset?: import('../scene-graph/shapes/particle-emitter-3d').ParticlePreset,
    ): string {
        return this.scene3d.addParticleEmitter(x, y, z, config, preset);
    }

    /** Remove a particle emitter from the scene by ID. */
    public removeParticleEmitter3D(id: string): void {
        this.scene3d.removeParticleEmitter(id);
    }

    /** Update configuration of an existing particle emitter. */
    public setParticleEmitterConfig3D(
        id: string,
        config: import('../scene-graph/shapes/particle-emitter-3d').ParticleEmitterConfig,
    ): void {
        this.scene3d.setParticleEmitterConfig(id, config);
    }

    /** Get the ParticleEmitter3D node by ID, or null if not found. */
    public getParticleEmitter3D(
        id: string,
    ): import('../scene-graph/shapes/particle-emitter-3d').ParticleEmitter3D | null {
        return this.scene3d.getParticleEmitter(id);
    }

    // ── 3D Bloom pass ────────────────────────────────────────────────

    /** Enable particle bloom glow. `threshold` (0–1) clips dim particles; `intensity` scales brightness. */
    public enableBloom3D(threshold?: number, intensity?: number): void {
        this.scene3d.enableBloom(threshold, intensity);
    }

    /** Disable particle bloom. */
    public disableBloom3D(): void {
        this.scene3d.disableBloom();
    }

    /** Adjust bloom brightness threshold without toggling the pass. */
    public setBloomThreshold3D(t: number): void { this.scene3d.setBloomThreshold(t); }

    /** Adjust bloom intensity multiplier without toggling the pass. */
    public setBloomIntensity3D(v: number): void { this.scene3d.setBloomIntensity(v); }

    // ── 3D Ribbon meshes ─────────────────────────────────────────────

    /**
     * Create a ribbon mesh that follows a Catmull-Rom spline.
     * The ribbon is double-sided and UV-mapped along its arc length,
     * making it ideal for scrolling text banners and 3D path labels.
     *
     * @param x,y,z          World-space origin for the mesh node.
     * @param controlPoints  ≥2 spline control points { x, y, z } in object-local space.
     * @param width          Ribbon width in world units.
     * @param segments       Subdivisions per spline segment (default 16).
     * @param material       Optional material overrides.
     *
     * Example — a simple straight ribbon:
     * ```ts
     * const ribbon = shapeManager.addRibbon3D(0, 0, 0,
     *   [{ x:-1, y:0, z:0 }, { x:0, y:0.3, z:0 }, { x:1, y:0, z:0 }],
     *   0.3,   // 0.3 world-unit wide
     * );
     * await shapeManager.setHtmlTexture3D(ribbon.id,
     *   '<div style="font:bold 48px sans-serif;color:#fff;padding:8px">Hello 3D!</div>',
     * );
     * shapeManager.setFrameLinkAnimation3D(ribbon.id, {
     *   enabled: true, type: 'scroll', axis: 'x', amplitude: 1, framesPerCycle: 60,
     * });
     * ```
     */
    public addRibbon3D(
        x: number, y: number, z: number,
        controlPoints: import('../types/ribbon-3d').RibbonControlPoint[],
        width: number,
        segments = 16,
        material?: Partial<import('../renderer/3d/material-3d').Material3D>,
    ): import('../scene-graph/shapes/mesh-3d').Mesh3D {
        return this.scene3d.addRibbon3D(x, y, z, controlPoints, width, segments, material);
    }

    /**
     * Update the spline path of an existing ribbon mesh.
     * Rebuilds geometry immediately — safe to call every frame for dynamic paths.
     */
    public updateRibbonPath3D(
        meshId: string,
        controlPoints: import('../types/ribbon-3d').RibbonControlPoint[],
    ): boolean {
        return this.scene3d.updateRibbonPath3D(meshId, controlPoints);
    }

    /** Update the width of a ribbon mesh. Rebuilds geometry immediately. */
    public updateRibbonWidth3D(meshId: string, width: number): boolean {
        return this.scene3d.updateRibbonWidth3D(meshId, width);
    }

    /**
     * Update a single control point on a ribbon by index. Rebuilds geometry immediately.
     * Ideal for drag-handle interactions — call on every pointermove rather than
     * rebuilding the full array.
     *
     * ```ts
     * // On drag of handle[i]:
     * shapeManager.setRibbonControlPoint3D(ribbon.id, i, newX, newY, newZ);
     * ```
     */
    public setRibbonControlPoint3D(meshId: string, index: number, x: number, y: number, z: number): boolean {
        return this.scene3d.setRibbonControlPoint3D(meshId, index, x, y, z);
    }

    /**
     * Set UV end-padding: extra UV units added to the end of the ribbon's U range so
     * a looping scroll has a small overlap region instead of a hard seam.
     * Typical values: 0 (none) to 0.1 (10% overlap). Rebuilds geometry immediately.
     */
    public setRibbonEndPadding3D(meshId: string, uvEndPadding: number): boolean {
        return this.scene3d.setRibbonEndPadding3D(meshId, uvEndPadding);
    }

    /**
     * Toggle the "flip rear texture" flag. When true, the back face gets horizontally
     * mirrored U coordinates so text reads correctly from both sides of the ribbon.
     * When false (default), the back face shows the texture backwards.
     */
    public setRibbonFlipRearU3D(meshId: string, flip: boolean): boolean {
        return this.scene3d.setRibbonFlipRearU3D(meshId, flip);
    }

    /**
     * Set which faces of a ribbon are visible.
     * - `'double'` (default) — both front and back visible.
     * - `'front'`  — front face only; prevents mirrored text from showing inside loops/spirals.
     * - `'back'`   — back face only; useful for inside-of-loop views.
     * Legacy boolean: `true` → `'double'`, `false` → `'front'`.
     */
    public setRibbonDoubleSided3D(meshId: string, doubleSided: 'double' | 'front' | 'back' | boolean): boolean {
        return this.scene3d.setRibbonDoubleSided3D(meshId, doubleSided);
    }

    /**
     * Set the path-orientation mode for a ribbon and rebuild its geometry immediately.
     * Switch to `'camera-facing'` so the ribbon face always rotates toward the camera,
     * keeping text readable on spirals or complex paths.
     *
     * - `'normal'`        — Rotation-Minimizing Frame (default). Ribbon lies in path plane.
     * - `'world-up'`      — Width direction is always world-Y; ribbon stands like a wall.
     * - `'camera-facing'` — Face always points at the camera (rebuilt every frame).
     */
    public setRibbonPathMode3D(meshId: string, mode: import('../types/ribbon-3d').RibbonPathMode): boolean {
        return this.scene3d.setRibbonPathMode3D(meshId, mode);
    }

    /**
     * Update the curve subdivision count (smoothness) of a ribbon and rebuild geometry.
     * Higher values produce smoother curves but more triangles.
     * Typical values: 8 (draft) · 16 (standard) · 32 (smooth) · 64 (high quality).
     */
    public updateRibbonSegments3D(meshId: string, segments: number): boolean {
        return this.scene3d.updateRibbonSegments3D(meshId, segments);
    }

    // ── Renderer-side ribbon handle spheres ───────────────────────────────────

    /**
     * Project each ribbon control point into overlay pixel space for canvas overlay drawing.
     *
     * Pass the dimensions of whatever element you draw the handles on — e.g. the canvas
     * element's `width` and `height` properties, or `clientWidth`/`clientHeight`.
     * The returned `{ x, y }` are in that same coordinate space.
     * Use the SAME dimensions when calling beginRibbonHandleDrag3D and moveRibbonHandle3D.
     */
    public getRibbonHandleScreenPositions3D(
        ribbonId: string,
        overlayWidth: number,
        overlayHeight: number,
    ): Array<{ x: number; y: number; index: number } | null> {
        return this.scene3d.getRibbonHandleScreenPositions3D(ribbonId, overlayWidth, overlayHeight);
    }

    /**
     * Begin dragging a ribbon control point by index.
     * Call once on pointerdown.
     * @param overlayWidth  Width of the overlay element in the same pixels as getRibbonHandleScreenPositions3D.
     * @param overlayHeight Height of the overlay element.
     * @returns false if the ribbon or index is invalid.
     */
    public beginRibbonHandleDrag3D(
        ribbonId: string,
        handleIndex: number,
        overlayWidth: number,
        overlayHeight: number,
    ): boolean {
        return this.scene3d.beginRibbonHandleDrag3D(ribbonId, handleIndex, overlayWidth, overlayHeight);
    }

    /**
     * Move a ribbon control point to the current pointer position.
     * Call on every pointermove during a drag.
     * @param offsetX       Pointer X in overlay pixels (e.g. event.offsetX, or clientX − rect.left).
     * @param offsetY       Pointer Y in overlay pixels.
     * @param overlayWidth  Same overlay dimensions as used in beginRibbonHandleDrag3D.
     * @param overlayHeight Same overlay dimensions as used in beginRibbonHandleDrag3D.
     * @returns false if the drag was not started.
     */
    public moveRibbonHandle3D(
        ribbonId: string,
        handleIndex: number,
        offsetX: number, offsetY: number,
        overlayWidth: number, overlayHeight: number,
    ): boolean {
        return this.scene3d.moveRibbonHandle3D(ribbonId, handleIndex, offsetX, offsetY, overlayWidth, overlayHeight);
    }

    /** End a handle drag. Call on pointerup. */
    public endRibbonHandleDrag3D(ribbonId: string, handleIndex: number): void {
        this.scene3d.endRibbonHandleDrag3D(ribbonId, handleIndex);
    }

    /**
     * Set how many times the texture tiles along the ribbon length. Default: 1.
     * Use N>1 to keep complex script (Urdu, Arabic) crisp on long ribbons —
     * put one copy of the text in the HTML and let the GPU tile it N times.
     */
    public setRibbonUvTileCount3D(meshId: string, tileCount: number): boolean {
        return this.scene3d.setRibbonUvTileCount3D(meshId, tileCount);
    }

    public setRibbonShowHandles3D(meshId: string, show: boolean): boolean {
        return this.scene3d.setRibbonShowHandles3D(meshId, show);
    }

    /** Get the stored ribbon data for a mesh (null if not a ribbon). */
    public getRibbonData3D(meshId: string): import('../types/ribbon-3d').RibbonData | null {
        return this.scene3d.getRibbonData3D(meshId);
    }

    /**
     * Compute GPU texture dimensions that perfectly fit a ribbon's aspect ratio.
     *
     * Call this before `setHtmlTexture3D` to get pixel dimensions that match the
     * ribbon's length-to-height ratio at a given quality level, so text fills the
     * ribbon face without distortion.
     *
     * @param meshId       Ribbon mesh node ID.
     * @param targetHeight Desired texture height in pixels (default 128).
     *                     Use 64 for compact ribbons, 256 for large/high-quality ones.
     * @param maxWidth     Upper limit on texture width in pixels (default 2048).
     * @returns `{ width, height }` rounded to nearest power of two, or `null` if not a ribbon.
     *
     * @example
     * ```ts
     * const size = shapeManager.computeRibbonTextureSize3D(ribbon.id) ?? { width: 512, height: 128 };
     * // size → e.g. { width: 1024, height: 128 } for a typical banner ribbon
     * await shapeManager.setHtmlTexture3D(ribbon.id, html, size.width, size.height);
     * ```
     */
    public computeRibbonTextureSize3D(
        meshId: string,
        targetHeight = 128,
        maxWidth = 2048,
    ): { width: number; height: number; fontSize: number } | null {
        return this.scene3d.computeRibbonTextureSize3D(meshId, targetHeight, maxWidth);
    }

    // ── HTML-in-Canvas 3D textures ───────────────────────────────────

    /**
     * Render an HTML string to a GPU texture and apply it to any 3D mesh.
     *
     * Uses the native browser technique: SVG <foreignObject> → <canvas> →
     * createImageBitmap → copyExternalImageToTexture.  No external libraries.
     * The browser's full rendering engine is used, so CSS layout, emoji, RTL
     * text, gradients, and web-safe fonts all work.
     *
     * @param meshId   Target mesh node ID (plane, ribbon, box, etc.).
     * @param html     HTML body content — wrap in a styled <div> for best results.
     * @param width    Texture width in pixels (default 512).
     * @param height   Texture height in pixels (default 128).
     * @param options  { backgroundColor?, containerStyle? }
     *
     * Example:
     * ```ts
     * await shapeManager.setHtmlTexture3D(meshId, `
     *   <div style="
     *     font: bold 64px 'Arial Black', sans-serif;
     *     color: white;
     *     text-shadow: 0 0 12px #0af;
     *     padding: 16px;
     *     background: linear-gradient(90deg,#1a1a2e,#16213e);
     *   ">FROGMARKS 3D</div>
     * `, 512, 128);
     * ```
     */
    public setHtmlTexture3D(
        meshId: string,
        html: string,
        width = 512,
        height = 128,
        options?: import('../renderer/3d/html-texture-3d').HtmlTexture3DOptions,
    ): Promise<boolean> {
        return this.scene3d.setHtmlTexture3D(meshId, html, width, height, options);
    }

    /**
     * Update the HTML content of an existing HTML texture (no resize).
     * Faster than `setHtmlTexture3D` — skips texture recreation.
     * Call `setHtmlTexture3D` first to establish the texture.
     */
    public updateHtmlTexture3D(
        meshId: string,
        html: string,
        options?: import('../renderer/3d/html-texture-3d').HtmlTexture3DOptions,
    ): Promise<boolean> {
        return this.scene3d.updateHtmlTexture3D(meshId, html, options);
    }

    /** Remove the HTML texture from a mesh (destroys GPU texture). */
    public removeHtmlTexture3D(meshId: string): boolean {
        return this.scene3d.removeHtmlTexture3D(meshId);
    }

    /** Returns true if the mesh has an active HTML texture. */
    public hasHtmlTexture3D(meshId: string): boolean {
        return this.scene3d.hasHtmlTexture3D(meshId);
    }

    // ── 3D Group Outliner ────────────────────────────────────────────

    /** Set the collapsed state of a 3D mesh group (for outliner UIs). */
    public setMeshGroupCollapsed3D(groupId: string, collapsed: boolean): boolean {
        return this.scene3d.setGroupCollapsed(groupId, collapsed);
    }

    /** Get the collapsed state of a 3D mesh group. */
    public isMeshGroupCollapsed3D(groupId: string): boolean {
        return this.scene3d.isGroupCollapsed(groupId);
    }

    /** Delete a 3D mesh group (children are lifted to root). Supports undo. */
    public deleteMeshGroup3D(groupId: string): boolean {
        return this.scene3d.deleteMeshGroup(groupId);
    }

    // ── 3D Outliner ──────────────────────────────────────────────────

    public setMeshVisible3D(nodeId: string, visible: boolean): boolean { return this.scene3d.setMeshVisible(nodeId, visible); }
    public isMeshVisible3D(nodeId: string): boolean { return this.scene3d.isMeshVisible(nodeId); }
    public setGroupVisible3D(groupId: string, visible: boolean): boolean { return this.scene3d.setGroupVisible(groupId, visible); }
    public isGroupVisible3D(groupId: string): boolean { return this.scene3d.isGroupVisible(groupId); }
    public setMeshName3D(nodeId: string, name: string): boolean { return this.scene3d.setMeshName(nodeId, name); }
    public getMeshName3D(nodeId: string): string | null { return this.scene3d.getMeshName(nodeId); }
    public setGroupName3D(groupId: string, name: string): boolean { return this.scene3d.setGroupName(groupId, name); }
    public getGroupName3D(groupId: string): string | null { return this.scene3d.getGroupName(groupId); }
    public getScene3DHierarchy() { return this.scene3d.getScene3DHierarchy(); }
    /** Lightweight outliner descriptor for ONE 3D node (same shape getScene3DHierarchy emits per mesh
     *  entry), so a host can push just the new node(s) from createFullCharacter3D's `nodeIds` without a
     *  full getScene3DHierarchy() re-scan. Null if the id isn't a mesh node. */
    public getNode3D(nodeId: string) { return this.scene3d.getScene3DNode(nodeId); }

    // ── 3D Normal Maps ───────────────────────────────────────────────

    public setMeshNormalMap3D(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        return this.scene3d.setMeshNormalMap(nodeId, source);
    }
    public clearMeshNormalMap3D(nodeId: string): boolean { return this.scene3d.clearMeshNormalMap(nodeId); }
    public uploadAndApplyNormalMap3D(meshId: string, source: File | Blob | ImageBitmap, name?: string): Promise<string | null> {
        return this.scene3d.uploadAndApplyNormalMap(meshId, source, name);
    }

    // ── 3D Undo / Redo ───────────────────────────────────────────────

    get canUndo3D(): boolean { return this.scene3d.canUndo3D; }
    get canRedo3D(): boolean { return this.scene3d.canRedo3D; }
    get undoDescription3D(): string | null { return this.scene3d.undoDescription3D; }
    get redoDescription3D(): string | null { return this.scene3d.redoDescription3D; }

    public undo3D(): boolean { return this.scene3d.undo3D(); }
    public redo3D(): boolean { return this.scene3d.redo3D(); }
    public clearUndo3D(): void { this.scene3d.clearUndo3D(); }

    // ── 3D Shadow Mapping ────────────────────────────────────────────

    /** Enable shadow casting and receiving for 3D opaque meshes. */
    public enableShadows3D(mapSize = 1024, halfExtent = 15, bias = 0.002): void {
        this.scene3d.enableShadows(mapSize, halfExtent, bias);
    }

    /** Disable shadow mapping. */
    public disableShadows3D(): void {
        this.scene3d.disableShadows();
    }

    /** Whether shadow mapping is currently active. */
    get shadowsEnabled3D(): boolean { return this.scene3d.shadowsEnabled; }

    // ── 3D Frustum Culling ───────────────────────────────────────────

    /** Toggle CPU-side frustum culling for 3D meshes (default: on). */
    get frustumCulling3D(): boolean { return this.scene3d.frustumCulling; }
    set frustumCulling3D(v: boolean) { this.scene3d.frustumCulling = v; }

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
    public captureElementToTexture(element: HTMLElement, hostCanvas?: HTMLCanvasElement): { texture: GPUTexture; width: number; height: number } | null {
        return this.getTextEffectEngine()?.captureElement(element, hostCanvas) ?? null;
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

        // Pre-size from the frame/font so the node doesn't flash at the default unit size
        // (≈1 world unit) before the first async HTML capture lands.
        node.applyInitialSize();

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
        if (this._activeVectorLayerId) node.layerId = this._activeVectorLayerId;
        this.sceneGraph.root.addChild(node);
        this.interactionService.clearSelectedNodes();
        this.interactionService.selectNode(node);
        this.emitSceneGraphChanged();

        // Start continuous rendering if initial effects need animation
        if (node.needsAnimation) this.webgpuRenderer?.beginInteractive();

        return node;
    }

    /**
     * Create a LiveTextNode as a FIXED FRAME from a drawn WORLD-space rectangle: the box keeps
     * the size you drew (text wraps inside at the current font size and the frame grows only if
     * text overflows) instead of shrinking to its content. Centered on the rect → the frame
     * fills the rect. The font is NOT derived from the box (that made tall/narrow boxes huge) —
     * it uses options.fontSize; pass a derived size yourself if you want box-scaled text.
     * rect.w/h may be negative (dragged up/left).
     */
    public createLiveTextInRect(
        rect: { x: number; y: number; w: number; h: number },
        options?: LiveTextOptions,
    ): LiveTextNode {
        const illBounds = this.webgpuRenderer?.getIllustrationBounds?.();
        const pixelSize = this.webgpuRenderer?.getIllustrationPixelSize?.();
        // World units per pixel — same basis createLiveText uses, so px ↔ world match.
        const wupp = (illBounds && pixelSize) ? (illBounds.width / pixelSize.w) : (1 / 100);
        const frameWidth = Math.max(1, Math.round(Math.abs(rect.w) / wupp));   // CSS px
        const frameHeight = Math.max(1, Math.round(Math.abs(rect.h) / wupp));  // CSS px
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        return this.createLiveText(cx, cy, { ...options, frameWidth, frameHeight });
    }

    /**
     * Install (or clear, with `null`) a rect-draw callback. While set, a canvas drag DRAWS a
     * box (reusing the box-select marching-ants preview) instead of selecting nodes, and on
     * release calls back with the drawn WORLD rect + the release client coords. Use it for the
     * LiveText click-drag create: set it when the text tool activates, clear it (null) when it
     * deactivates. The callback decides click vs drag (a tiny rect → place a default-size node).
     * This avoids the box-select tool competing with the text-box drag.
     */
    public setRectDrawCallback(
        cb: ((rect: { x: number; y: number; w: number; h: number }, clientX: number, clientY: number) => void) | null,
    ): void {
        this.interactionService.rectDrawCallback = cb;
        if (!cb) this.interactionService.hoveredLiveTextId = null;
        this.scheduleRender();
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
        if (style.backgroundColor !== undefined) node.backgroundColor = style.backgroundColor;
        if (style.align !== undefined) node.align = style.align;
        if (style.arcAngle !== undefined) node.arcAngle = style.arcAngle;
        if (style.frameWidth !== undefined || style.frameHeight !== undefined) {
            node.setFrame(style.frameWidth ?? node.frameWidth, style.frameHeight ?? node.frameHeight);
        }
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
     * Enter edit mode AND place the caret where the user clicked — the "caret-on-entry
     * handshake" for the HTML-in-Canvas path. Salsa swallows the double-click to decide
     * intent, so the element never sees it; replaying the viewport coords puts the caret
     * under the cursor. Frogmarks should call this (with the double-click clientX/clientY)
     * instead of beginLiveTextEditing() when entering a LiveText node via a click.
     * Falls back to plain begin-editing on non-HTML-in-Canvas builds.
     */
    public enterLiveTextEditingAt(nodeId: string, clientX: number, clientY: number): void {
        if (this._editingLiveTextId && this._editingLiveTextId !== nodeId) {
            this.endLiveTextEditing(this._editingLiveTextId);
        }
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            node.onChange = () => this.scheduleRender();
            node.enterEditAt(clientX, clientY);
            this._editingLiveTextId = nodeId;
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
            // Auto-remove a node left empty (clicked but never typed, or fully backspaced)
            // so the canvas doesn't accumulate invisible empty text boxes.
            if (!node.text.trim()) {
                this.interactionService.deselectNode(node);
                if (node.parent) node.parent.removeChild(node);
                else this.sceneGraph.root.removeChild(node);
                node.destroy();
                this.webgpuRenderer?.endInteractive();
                this.scheduleRender();
                return;
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
        if (this._activeVectorLayerId) layout.layerId = this._activeVectorLayerId;
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
            if (this._activeVectorLayerId) this.currentPreviewShape.layerId = this._activeVectorLayerId;
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
        const scene: any = this.sceneGraph.toJSON();
        // Include 3D texture library data so plain saves also restore textures
        const texLibData = this.scene3d.getTextureLibraryData();
        if (texLibData && texLibData.entries.length > 0) {
            scene.textureLibrary = texLibData;
        }
        return JSON.stringify(scene);
    }

    /**
     * scene.json for the DOCUMENT save path — getSceneGraphJSON() with the heavy baked geometry + base64 skinning
     * STRIPPED from SkinnedMesh3D nodes. The document also writes scene3d.json (params-only, the 3D source of truth
     * on load), and scene.json's SkinnedMesh3D nodes are IGNORED by the restore anyway (they fall through
     * recreateNode's `default:` → an empty placeholder). So that geometry is pure duplication — ~MBs per character.
     * This keeps the lightweight node stub (id/type/transform/name/flags) so the tree + 2D content restore
     * identically. Plain '3DMesh' nodes are left intact — their geometry IS used by recreateNode + isn't the bloat.
     */
    public getSceneGraphJSONForDocument(): string {
        const scene: any = this.sceneGraph.toJSON();
        const strip = (n: any): void => {
            if (n?.type === 'SkinnedMesh3D') {
                if (n.config) delete n.config.geometry;
                delete n.jointIndicesB64; delete n.jointWeightsB64;
                delete n.blendShapes; delete n.baseVerticesB64; delete n.blendWeights;
            }
            if (n?.children) for (const c of n.children) strip(c);
        };
        if (scene.root) strip(scene.root);
        const texLibData = this.scene3d.getTextureLibraryData();
        if (texLibData && texLibData.entries.length > 0) scene.textureLibrary = texLibData;
        return JSON.stringify(scene);
    }

    /**
     * Lightweight mirror of getSceneGraphJSON for callers that only need the LAYER TREE shape per node —
     * `{ id, name, type, visible, locked, children }` — and not the full document. It walks the live nodes
     * and emits ONLY those fields, so it SKIPS the heavy per-mesh geometry + base64 skinning weights that
     * `SkinnedMesh3D.toJSON()` serializes. Use this instead of getSceneGraphJSON() to rebuild a layer tree
     * without paying O(total verts) every time a character (5 skinned meshes) is added. `type` matches what
     * each node's toJSON emits (so an existing layer-tree builder parses it identically).
     */
    public getSceneStructureJSON(): string {
        const walk = (n: any): any => {
            const gt = typeof n.getType === 'function' ? n.getType() : undefined;
            // SkinnedMesh3D inherits Mesh3D.getType() ('3DMesh') but its toJSON serializes 'SkinnedMesh3D' —
            // detect it by its skeletonId so the type matches the full-JSON shape.
            const type = (gt === '3DMesh' && n.skeletonId !== undefined) ? 'SkinnedMesh3D' : gt;
            return { id: n.id, name: n.name, type, visible: n.visible, locked: n.locked, children: n.children.map(walk) };
        };
        return JSON.stringify({ root: walk(this.sceneGraph.root) });
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

        // Include 3D texture library (base64 data URLs for each texture)
        const texLibData = this.scene3d.getTextureLibraryData();
        if (texLibData && texLibData.entries.length > 0) {
            (scene as any).textureLibrary = texLibData;
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

            // 4. Restore 3D texture library and re-apply GPU textures to meshes
            if (data.textureLibrary) {
                await this.scene3d.restoreTextureLibraryData(data.textureLibrary);
            }

            // 5. Register any restored particle emitters with Scene3DManager
            for (const child of this.sceneGraph.root.children) {
                if (child instanceof ParticleEmitter3D) {
                    this.scene3d.registerRestoredParticleEmitter(child);
                }
            }

            // 6. Ensure GPU instance sync is active if any ArrayGroup3D nodes were restored
            if (this.sceneGraph.root.children.some(c => c instanceof ArrayGroup3D)) {
                this.scene3d.registerRestoredArrayGroups();
            }
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

                    // create new layer seeded with the raster, preserving the caller's id if provided
                    await this.rasterLayerManager.createLayerFromRasterCanvas(l.name ?? 'Layer', raster, l.id);

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
                    backgroundColor: ltOpts.backgroundColor,
                    align: ltOpts.align,
                    frameWidth: ltOpts.frameWidth,
                    frameHeight: ltOpts.frameHeight,
                    userScaleX: ltOpts.userScaleX,
                    userScaleY: ltOpts.userScaleY,
                    arcAngle: ltOpts.arcAngle,
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
                node2.applyInitialSize();

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
            case '3DMesh': {
                const meshConfig: Mesh3DConfig = {
                    primitive: data.primitive ?? 'box',
                    ...(data.config ?? {}),
                    material: data.material,
                };
                // Restore typed arrays from plain-array serialization (custom geometry)
                if (meshConfig.primitive === 'custom' && data.config?.geometry) {
                    const g = data.config.geometry;
                    if (Array.isArray(g.vertices) && Array.isArray(g.indices)) {
                        meshConfig.geometry = {
                            vertices: new Float32Array(g.vertices),
                            indices:  new Uint32Array(g.indices),
                        };
                    } else {
                        // Geometry unrestorable — fall back to box
                        meshConfig.primitive = 'box';
                        delete meshConfig.geometry;
                    }
                }
                const mesh3d = new Mesh3D(this.interactionService, data.x ?? 0, data.y ?? 0, data.z ?? 0, meshConfig);
                // Preserve the saved ID so restoreMeshState can find and update this mesh
                // instead of creating a duplicate when both sceneGraphJSON and scene3dJSON exist.
                if (data.id) mesh3d.setId(data.id);
                if (data.name) mesh3d.name = data.name;
                if (data.rotation    != null) mesh3d.rotation  = data.rotation;
                if (data.rotationX   != null) mesh3d.rotationX = data.rotationX;
                if (data.rotationY   != null) mesh3d.rotationY = data.rotationY;
                if (data.scaleX      != null) mesh3d.scaleX    = data.scaleX;
                if (data.scaleY      != null) mesh3d.scaleY    = data.scaleY;
                if (data.scaleZ      != null) mesh3d.scaleZ    = data.scaleZ;
                if (data.keyframeTracks)     mesh3d.keyframeTracks   = data.keyframeTracks;
                if (data.textureLibraryId)   mesh3d.textureLibraryId = data.textureLibraryId;
                if (Array.isArray(data.modifiers) && data.modifiers.length > 0) {
                    mesh3d.modifiers = data.modifiers;
                    mesh3d.invalidateModifierCache();
                }
                node = mesh3d;
                break;
            }
            case '3DMeshGroup': {
                const meshGroup = new MeshGroup3D(this.interactionService);
                // Preserve saved ID and name so the group survives the scene3d restore pass.
                if (data.id) meshGroup.setId(data.id);
                if (data.name) meshGroup.name = data.name;
                meshGroup.collapsed = data.collapsed ?? false;
                // PROCEDURAL content (the City): the save is a lightweight marker (no children) carrying the params
                // to regenerate from. Restore those + the thin-wrapper flags so WorldManager.restoreFromSave() can
                // rebuild the whole city from them (params-only persistence — see mesh-group-3d.toJSON).
                if (data.proceduralContent) {
                    meshGroup.thinWrapper = true;
                    meshGroup.documentSkipChildren = true;
                    meshGroup.worldParams = data.worldParams ?? null;
                }
                for (const childData of (data.children ?? [])) {
                    meshGroup.addChild(this.recreateNode(childData));
                }
                node = meshGroup;
                break;
            }
            case '3DArrayGroup': {
                const arrayGroup = new ArrayGroup3D(this.interactionService, data.sourceId, data.arrayParams);
                if (data.id) arrayGroup.setId(data.id);
                if (data.name) arrayGroup.name = data.name;
                if (Array.isArray(data.instanceOverrides) && data.instanceOverrides.length > 0) {
                    arrayGroup.instanceOverrides = new Map(data.instanceOverrides);
                }
                // GPU instancing: no copy children — ignore any children saved by older format.
                node = arrayGroup;
                break;
            }
            case 'ParticleEmitter3D': {
                const emitter = new ParticleEmitter3D(
                    this.interactionService,
                    data.x ?? 0, data.y ?? 0, data.z ?? 0,
                    data.config ?? {},
                );
                node = emitter;
                break;
            }
            default:
                console.warn(`[ShapeManager] Unknown node type "${data.type}" — creating empty placeholder. Project may be from a newer version of Salsa.`);
                node = new Node();
                break;
        }

        if (node instanceof Shape && data.id) {
            node.setId(data.id);
        }

        node.name = data.name;
        node.x = data.x;
        node.y = data.y;
        // Size-model migration for LiveText: legacy docs encoded the visual SIZE in scaleX/scaleY;
        // v2 makes them a pure user multiplier (size = _width/_height, auto-fit from text). Reset
        // legacy LiveText to 1 so the saved size doesn't double-apply over the recomputed _width.
        const ltLegacy = node instanceof LiveTextNode && data.liveTextOptions?.sizeModel !== 'v2';
        node.scaleX = ltLegacy ? 1 : data.scaleX;
        node.scaleY = ltLegacy ? 1 : data.scaleY;
        node.rotation = data.rotation;
        node.zIndex = data.zIndex;
        node.visible = data.visible;
        node.locked = data.locked;
    
        // Restore children only if not a type that already handles children internally
        if (data.children && data.type !== "Group" && data.type !== "Sticky Note" && data.type !== "3DMeshGroup" && data.type !== "3DArrayGroup") {
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
            if (this.rasterLayerManager) {
                // When a documentSize is set (bounded illustration mode), layer textures
                // must always stay at documentSize dimensions. Using getIllustrationPixelSize()
                // here would cause layers to shrink when the host calls setExplicitDocumentPixelSize()
                // for canvas resize, corrupting canvasWidth/canvasHeight on the next save.
                const docSize = this._documentSizePx;
                const { w, h } = docSize ?? this.webgpuRenderer.getIllustrationPixelSize();
                this.rasterLayerManager.setSize(w, h);
            }
        }
        this.scheduleRender();
    }

    // ── Document size (bounded artboard) ────────────────────────────

    /**
     * Define a fixed document size in pixels, enabling the bounded-artboard mode.
     *
     * This does three things:
     *  1. Sets the raster layer resolution to exactly widthPx × heightPx.
     *  2. Enables the artboard overlay (checkerboard background, pan constraints).
     *  3. Makes captureDocumentBoundsToBlob() crop to this area for thumbnails.
     *
     * Use clearDocumentSize() to return to infinite-canvas mode.
     */
    public setDocumentSize(widthPx: number, heightPx: number): void {
        if (!this.webgpuRenderer) return;
        const prevSize = this._documentSizePx;
        if (prevSize && (prevSize.w !== widthPx || prevSize.h !== heightPx)) {
            console.warn(`[ShapeManager] setDocumentSize changed: ${prevSize.w}x${prevSize.h} → ${widthPx}x${heightPx}`, new Error('setDocumentSize stack').stack);
        }
        this._documentSizePx = { w: widthPx, h: heightPx };

        // World-unit artboard: height = 2 fills the canvas vertically at zoom=1.
        // Width is derived from the document aspect ratio.
        const worldH = 2;
        const worldW = 2 * (widthPx / heightPx);

        // Lock the renderer's raster texture to the explicit pixel size before
        // setIllustrationBounds() calls getIllustrationPixelSize() internally.
        this.webgpuRenderer.setExplicitDocumentPixelSize({ w: widthPx, h: heightPx });
        this.webgpuRenderer.setIllustrationBounds(worldW, worldH);
        if (!this.webgpuRenderer.getIllustrationMode()) {
            this.webgpuRenderer.setIllustrationMode(true);
        }
        if (this.rasterLayerManager) {
            this.rasterLayerManager.setSize(widthPx, heightPx);
        }
        this.scheduleRender();
    }

    /**
     * Return to infinite-canvas mode: removes the artboard boundary, pan
     * constraints, and checkerboard clip.  Raster layers revert to canvas size.
     */
    public clearDocumentSize(): void {
        if (!this.webgpuRenderer) return;
        this._documentSizePx = null;
        this.webgpuRenderer.setExplicitDocumentPixelSize(null);
        this.webgpuRenderer.setIllustrationMode(false);
        const canvas = this.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (canvas && this.rasterLayerManager) {
            this.rasterLayerManager.setSize(canvas.width, canvas.height);
        }
        this.scheduleRender();
    }

    /**
     * Returns the current document size in pixels, or null for infinite canvas.
     */
    public getDocumentSize(): { w: number; h: number } | null {
        return this._documentSizePx;
    }

    /**
     * Fit the viewport so the artboard is centered and fills ~85% of the canvas.
     *
     * Call this after setDocumentSize() on every create and load to ensure the
     * artboard is always visible with a dark margin around it.
     *
     * Internally: because worldH=2 always maps the artboard height to the canvas
     * height at zoom=1, setting zoom=0.85 gives an 85% fill with equal margins.
     * Pan is reset to (0,0) to centre the artboard.
     */
    public fitArtboard(): void {
        if (!this.interactionService || !this._documentSizePx) return;
        this.interactionService.setPanOffset(0, 0);
        this.interactionService.setZoom(0.85);
        this.scheduleRender();
    }

    /**
     * Capture the document artboard as a Blob for use as a thumbnail.
     *
     * If a document size is set, the output is cropped to the artboard region
     * and scaled to fit within maxSize × maxSize while preserving aspect ratio.
     * If no document size is set (infinite canvas), the full viewport is captured.
     *
     * @param format  'png' (default, lossless) or 'jpeg' (smaller, good for previews).
     * @param maxSize Maximum pixel dimension of the output image (default 2048).
     */
    public async captureDocumentBoundsToBlob(
        format: 'png' | 'jpeg' = 'png',
        maxSize = 2048,
    ): Promise<Blob> {
        if (!this.webgpuRenderer) throw new Error('Renderer not initialised');

        const docSize = this._documentSizePx;
        const scissor = this.webgpuRenderer.getArtboardScissor();

        if (!scissor || !docSize) {
            // Infinite canvas: snapshot the full viewport scaled to maxSize.
            return this.webgpuRenderer.snapshotToBlob(maxSize);
        }

        // Output at document aspect ratio, capped at maxSize.
        const aspect = docSize.w / docSize.h;
        let outW: number, outH: number;
        if (aspect >= 1) {
            outW = Math.min(maxSize, docSize.w);
            outH = Math.round(outW / aspect);
        } else {
            outH = Math.min(maxSize, docSize.h);
            outW = Math.round(outH * aspect);
        }

        return this.webgpuRenderer.snapshotRegionToBlob(
            scissor.x, scissor.y, scissor.w, scissor.h,
            outW, outH,
            `image/${format}`,
        );
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
     *   pixelFormat: 'png',       // default: lossless PNG compression
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

    /** Get the pixel format used for layer/cel compression in this document. */
    public getPixelFormat(): PixelFormat {
        return this.persistence?.getConfig().pixelFormat ?? 'png';
    }

    /** Change the pixel format for future saves of this document. */
    public setPixelFormat(format: PixelFormat): void {
        this.persistence?.setConfig({ pixelFormat: format });
    }

    /** Check whether a pixel format can be encoded by this browser. */
    public isPixelFormatSupported(format: PixelFormat): Promise<boolean> {
        return isFormatSupported(format);
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
        /** True when 3D mesh state was found in OPFS and restored. Frogmarks should skip its own cloud 3D restore when this is true. */
        scene3dRestored: boolean;
    }> {
        if (!this.persistence) {
            this.persistence = new DocumentPersistence();
            this.persistence.setStateProvider(() => this.gatherDocumentState());
        }

        // Loading a document means the editor is taking over the canvas — so
        // release the Shell UI (if it's up) and resume the editor renderer NOW,
        // BEFORE we know whether the document has data. A brand-new project has
        // no OPFS payload yet, and the old code returned early below without ever
        // tearing down the shell → the shell stayed active over the editor and
        // the canvas read blank.
        if (this.shell?.isSceneActive) {
            this.shell.destroyScene();        // stops the shell loop + resumeRendering()
        } else if (this.webgpuRenderer?.isSuspended) {
            this.webgpuRenderer.resumeRendering();
        }

        const payload = await this.persistence.loadDocument(docId);
        if (!payload) {
            console.warn('[Salsa loadDocument] No OPFS data found for docId (new/unsaved document):', docId);
            return { success: false, layers: [], scene3dRestored: false };
        }
        console.log('[Salsa loadDocument] OPFS payload found. Manifest layers:', payload.manifest.layers.length, 'Pixel buffers:', payload.layers.length);

        try {
            await this.restoreDocumentState(payload);
            this.currentDocId = docId;
            this.currentDocName = payload.manifest.name;
            const layers = this.getRasterLayers();
            console.log('[Salsa loadDocument] Restore complete. getRasterLayers() returned:', layers.length, 'layers:', layers.map(l => l.name));
            // (Shell teardown + renderer resume already happened up top, before
            // the payload check, so new/unsaved documents are handled too.)
            return {
                success: true,
                layers,
                scene3dRestored: !!(payload.scene3dJSON),
            };
        } catch (e) {
            console.error('[ShapeManager] Failed to restore document:', e);
            return { success: false, layers: [], scene3dRestored: false };
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

    /**
     * Rename a saved document (rewrites its manifest name). Used by the shell
     * dashboard's project rename. Returns false if the document is missing.
     */
    public async renameSavedDocument(docId: string, name: string): Promise<boolean> {
        if (!this.persistence) {
            this.persistence = new DocumentPersistence();
            this.persistence.setStateProvider(() => this.gatherDocumentState());
        }
        return this.persistence.renameDocument(docId, name);
    }

    /**
     * Resolves once WebGPU is initialized (device ready). The Shell UI host
     * should `await sm.whenWebGPUReady()` before calling
     * `sm.shell.initializeScene(canvas)`, since the shell borrows the device.
     */
    public whenWebGPUReady(): Promise<void> {
        return this.webgpuRenderer?.whenReady() ?? Promise.resolve();
    }

    /**
     * Inject the host's logo image (URL or data URL) as the Shell UI's default
     * hero Billboard3D. Salsa rasterizes it and generates the 3D cutout. Safe
     * to call any time (before or after the shell scene mounts). The image
     * should have a transparent background for a clean cutout silhouette.
     */
    public setShellLogo(src: string): void {
        this.shell?.setLogoBillboard(src);
    }

    /**
     * Shell chrome via HTML-in-Canvas (experimental). The top-right utility
     * cluster (storage / local-model / themes / info icons + panels) mounts
     * automatically. These expose the theme + the persisted model URL.
     * `shellHtmlInCanvasSupported` reports whether it composites in-canvas
     * (Chrome flag/OT on) or falls back to a positioned overlay.
     */
    public setShellTheme(name: 'pinwheel' | 'frog' | 'moon' | 'polygon' | 'prism' | 'lattice'): void { this.shell?.setTheme(name); }
    public getShellThemeName(): string { return this.shell?.getThemeName() ?? 'polygon'; }
    public get shellHtmlInCanvasSupported(): boolean { return this.shell?.htmlInCanvasSupported ?? false; }
    public getShellLocalModelUrl(): string { return this.shell?.getLocalModelUrl() ?? ''; }

    /**
     * The actual canvas the editor renderer draws to. Pass THIS to
     * `sm.shell.initializeScene(...)` rather than re-looking-up the element by
     * id, so the shell is guaranteed to render to the same surface the editor
     * owns (no hidden-canvas mismatch).
     */
    public getRendererCanvas(): HTMLCanvasElement {
        return this.webgpuRenderer.getCanvas();
    }

    /**
     * True if the editor renderer is hard-suspended (the Shell UI owns the
     * canvas). If this is true while the editor is showing, the shell was not
     * torn down — call `sm.shell.destroyScene()`. (loadDocument auto-resumes as
     * a safety net.) Exposed for diagnostics.
     */
    public get isRenderingSuspended(): boolean {
        return this.webgpuRenderer?.isSuspended ?? false;
    }

    /** Force-resume the editor render loop (clears any Shell-UI suspend). */
    public resumeEditorRendering(): void {
        this.webgpuRenderer?.resumeRendering();
        this.webgpuRenderer?.scheduleRender();
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
     * Override the active document id and name without reloading any state.
     *
     * Call this after `unpackProject()` when importing a .frogmarks file as a
     * new illustration (different user or new device), then follow with
     * `sm.persist.saveNow()` to write OPFS data under the new id.
     *
     * @param docId  New document id (e.g. a fresh Frogmarks UUID).
     * @param name   Optional display name — pass undefined to keep the existing name.
     */
    public setCurrentDocId(docId: string, name?: string): void {
        this.currentDocId = docId;
        if (name !== undefined) this.currentDocName = name;
    }

    /**
     * Returns IDs of all 3D mesh nodes whose save-relevant state has changed
     * since the last clearDirtyMeshState3D() call. Use for per-mesh chunked saves.
     */
    public getDirtyMeshIds3D(): string[] {
        return this.scene3d?.getDirtyMeshIds() ?? [];
    }

    /**
     * Clear the stateDirty flag on the given mesh IDs (or all meshes if omitted).
     * Call after a successful save of those meshes.
     */
    public clearDirtyMeshState3D(ids?: string[]): void {
        this.scene3d?.clearMeshDirtyState(ids);
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
    /**
     * Snapshot the current document state — same data that the auto-save uses.
     * Useful for project-package export (e.g. `.frogmarks` ZIP).
     */
    public async snapshotDocument(): Promise<DocumentSavePayload> {
        return this.gatherDocumentState();
    }

    /**
     * Restore a full document state from a previously snapshotted payload.
     * Equivalent to what OPFS auto-save calls internally — safe to call from
     * Frogmarks' .frogmarks load path.
     */
    public async restoreDocument(payload: DocumentSavePayload): Promise<void> {
        return this.restoreDocumentState(payload);
    }

    /**
     * Return all 3D mesh node states as a plain array — suitable for JSON serialization
     * and inclusion in a project archive (e.g. .frogmarks ZIP).
     * Each entry is Mesh3D.toJSON() plus an optional `glbMeshId` field that identifies
     * which GLB buffer (from `getGltfBuffers3D()`) to use when restoring.
     */
    public getScene3DNodeStates(): any[] {
        if (!this.scene3d) return [];
        // Face-decal meshes are rebuilt from the face-rig metadata on load — don't persist them as nodes.
        return this.scene3d.getAllMeshes().filter(m => !m.isFaceDecal && !m.isHair && !m.isClothing && !m.isAttachment && !m.excludeFromDocument).map(m => this._buildMeshState(m));
    }

    /** Serialize all Skeleton3D nodes — paired with getScene3DNodeStates() for project save. */
    public getScene3DSkeletonStates(): any[] {
        if (!this.scene3d) return [];
        return this.scene3d.getAllSkeletons().map(s => this.scene3d!.serializeSkeletonForSave(s));
    }

    /**
     * Serialize a single mesh by ID — same shape as one element of getScene3DNodeStates().
     * Use this instead of getScene3DNodeStates() + filter when saving only dirty meshes,
     * to avoid paying the toJSON() + Array.from() cost for every unchanged mesh.
     */
    public getMeshState3D(meshId: string): any | null {
        if (!this.scene3d) return null;
        const m = this.scene3d.getMesh(meshId);
        if (!m) return null;
        return this._buildMeshState(m);
    }

    private _buildMeshState(m: import('../scene-graph/shapes/mesh-3d').Mesh3D): any {
        const store = this.scene3d!.getModelStore();
        // If this mesh's own buffer is missing (e.g. degraded save cycle), fall back to a
        // sibling mesh in the same MeshGroup3D that does have a buffer stored.  The restore
        // path uses the same GLB source for all group members.
        const glbMeshId = store.has(m.id) ? m.id : this.scene3d!.findGroupMemberGlbId(m.id);
        const s: any = {
            ...m.toJSON(),
            glbMeshId,
            ribbonData:           this.scene3d!.getRibbonData3D(m.id) ?? undefined,
            frameLinkAnimation3D: this.scene3d!.getFrameLinkAnimation3D(m.id) ?? undefined,
        };
        // A PROCEDURAL BODY is fully regenerable from its bodyParams (a handful of numbers) — so DON'T persist the
        // large baked geometry + skinning (~1–2 MB of JSON float arrays per character). Store just the params and
        // rebuild on load (restoreMeshState → generateBodyResult). Shrinks each character from ~MB to ~KB.
        if ((m as any).isProceduralBody) {
            const bp = this.scene3d!.getBodyParams(m.id);
            if (bp) {
                s.bodyParams = bp;
                if (s.config) delete s.config.geometry;
                delete s.jointIndicesB64;
                delete s.jointWeightsB64;
            }
        }
        return s;
    }

    /**
     * Return the raw GLB buffers for all GLTF-imported meshes, keyed by mesh ID.
     * Include these alongside `getScene3DNodeStates()` when saving a project archive.
     */
    public getGltfBuffers3D(): Record<string, ArrayBuffer> {
        if (!this.scene3d) return {};
        const result: Record<string, ArrayBuffer> = {};
        for (const [id, buf] of this.scene3d.getModelStore().entries()) {
            result[id] = buf;
        }
        return result;
    }

    /**
     * Restore 3D mesh nodes from serialized state and (optionally) raw GLB buffers.
     * Call this after restoring the raster/vector state when loading a project archive.
     * @param nodes    Array from `getScene3DNodeStates()` (or equivalent JSON)
     * @param models3d Map of meshId → raw GLB ArrayBuffer (from `getGltfBuffers3D()`)
     */
    public async restoreScene3DNodes(
        nodes: any[],
        models3d: Record<string, ArrayBuffer> = {},
    ): Promise<void> {
        if (!this.scene3d || nodes.length === 0) return;
        // Clear existing 3D meshes
        for (const m of this.scene3d.getAllMeshes()) {
            m.parent?.removeChild(m);
        }
        for (const state of nodes) {
            const glbBuf = state.glbMeshId ? models3d[state.glbMeshId] : undefined;
            await this.scene3d.restoreMeshState(state, glbBuf);
        }
        this.scheduleRender();
    }

    /**
     * Pack the entire current project into a `.frogmarks` ZIP Blob.
     *
     * Bundles:
     *  - Vector scene graph, raster layers, brush presets
     *  - 3D mesh node states + raw GLB buffers for GLTF-imported meshes
     *  - TextureLibrary snapshot (base64 image data for material textures)
     *
     * Frogmarks triggers a download with:
     *   const blob = await shapeManager.packProject();
     *   const a = document.createElement('a');
     *   a.href = URL.createObjectURL(blob);
     *   a.download = `${docName}.frogmarks`;
     *   a.click();
     */
    public async packProject(): Promise<Blob> {
        // gatherDocumentState with no 3D — _packProject uses its own nodes3d/models3d/textureLibrary
        // args for scene3d.json, so including them in docPayload would be redundant serialization.
        const docPayload     = await this.gatherDocumentState(false);
        const nodes3d        = this.scene3d ? this.getScene3DNodeStates() : [];
        const skeletons3d    = this.scene3d ? this.getScene3DSkeletonStates() : [];
        const characters3d   = this.scene3d ? this.scene3d.getScene3DCharacterStates() : [];
        const gpObjects3d    = this.scene3d ? this.scene3d.getScene3DGpStates() : [];
        const models3d       = new Map(Object.entries(this.scene3d ? this.getGltfBuffers3D() : {}));
        const textureLibrary = this.scene3d?.getTextureLibraryData() ?? null;
        const globalScene3d  = this.scene3d?.getGlobalScene3DSettings() ?? null;
        // Procedural character overlay params — without these the bundle restores a BARE body (no hair/clothes).
        const faceRigs       = this.scene3d ? this.scene3d.serializeFaceRigs()     : [];
        const clothingRigs   = this.scene3d ? this.scene3d.serializeClothingRigs() : [];
        const hairRigs       = this.scene3d ? this.scene3d.serializeHairRigs()     : [];
        const bodyParams     = this.scene3d ? this.scene3d.serializeBodyParams()   : [];
        const attachments    = this.scene3d ? this.scene3d.serializeAttachments()  : [];

        // Capture a small thumbnail (256px JPEG) and embed in the manifest (best-effort). 256 is plenty for a
        // gallery/slot preview and is ~4× smaller than 512 — the manifest is stored RAW (not gzipped), so the
        // thumbnail is the one bit of preview data that isn't otherwise compressed.
        try {
            const thumbBlob = await this.captureDocumentBoundsToBlob('jpeg', 256);
            docPayload.manifest.thumbnail = await new Promise<string>((res, rej) => {
                const reader = new FileReader();
                reader.onload = () => res(reader.result as string);
                reader.onerror = rej;
                reader.readAsDataURL(thumbBlob);
            });
        } catch { /* thumbnail is optional */ }

        const ephemeraJSON = this._ephemera ? this._ephemera.serialize() : null;
        const result = await _packProject({ docPayload, nodes3d, skeletons3d, characters3d, gpObjects3d, models3d, textureLibrary, ephemeraJSON, globalScene3d, faceRigs, clothingRigs, hairRigs, bodyParams, attachments });
        // Full snapshot — all mesh state is now persisted in the .frogmarks zip.
        this.clearDirtyMeshState3D();
        return result;
    }

    /**
     * Unpack a `.frogmarks` ZIP file and restore the full project state.
     *
     * Restores:
     *  - Vector scene graph, raster layers, brush presets
     *  - 3D mesh nodes (re-imports GLB geometry for GLTF meshes)
     *  - TextureLibrary (re-uploads GPU textures)
     *
     * @param file   A `.frogmarks` File or Blob (e.g. from a file-picker or OPFS read).
     */
    public async unpackProject(file: File | Blob): Promise<void> {
        const output = await _unpackProject(file);
        await this.restoreDocumentState(output.docPayload);
        if (this.scene3d) {
            // Restore skeletons before meshes so re-link can find them.
            for (const skelState of (output.skeletons3d ?? [])) {
                this.scene3d.restoreSkeletonState(skelState);
            }
            // Meshes must be created before texture library is applied,
            // so that restoreTextureLibraryData can find them via getAllMeshes().
            await this.restoreScene3DNodes(output.nodes3d, Object.fromEntries(output.models3d));
            // Re-link SkinnedMesh3D.skeleton references after all nodes exist.
            this.scene3d.relinkSkinnedMeshSkeletons();
            // Default idle/personality clips + poses are stripped from procedural-body skeletons on save (identical
            // across characters) — re-install here, idempotent by name (edited/renamed/added ones were kept on save).
            for (const s of this.scene3d.getAllSkeletons()) if ((s as any).isProceduralBody) this.scene3d.installDefaultAnimations(s.id);
            // Restore procedural character OVERLAYS from their params (bodies + skeletons now exist + are relinked).
            // WITHOUT this, a loaded bundle shows a BARE body — no hair/clothes/face — which was the bug on both the
            // viewer-bundle and .frogmarks-import paths. (Face eye-textures are PNG blobs that ride meshTextures, not
            // yet in the bundle — a separate gap; the rig + procedural body/hair/clothing params restore here.)
            try { this.scene3d.restoreBodyParams(output.bodyParams); }     catch (e) { console.warn('[Body] restore params failed', e); }
            try { this.scene3d.restoreClothingRigs(output.clothingRigs); } catch (e) { console.warn('[Clothing] restore rigs failed', e); }
            try { this.scene3d.restoreHairRigs(output.hairRigs); }         catch (e) { console.warn('[Hair] restore rigs failed', e); }
            try { this.scene3d.restoreAttachments(output.attachments); }   catch (e) { console.warn('[Charm] restore attachments failed', e); }
            try { await this.scene3d.restoreFaceRigs(output.faceRigs, new Map()); } catch (e) { console.warn('[Face] restore rigs failed', e); }
            // Restore character catalog (references already-restored skeleton/mesh IDs).
            if (output.characters3d?.length) {
                this.scene3d.restoreCharacterStates(output.characters3d);
            }
            // Restore GP objects.
            if (output.gpObjects3d?.length) {
                this.scene3d.restoreGpStates(output.gpObjects3d);
            }
            if (output.textureLibrary) {
                await this.scene3d.restoreTextureLibraryData(output.textureLibrary);
            }
            if (output.globalScene3d) {
                this.scene3d.restoreGlobalScene3DSettings(output.globalScene3d);
            }
        }
        if (output.ephemeraJSON) {
            this._ephemera.deserialize(output.ephemeraJSON);
        }
    }

    private async gatherDocumentState(forceAll3D = false): Promise<DocumentSavePayload> {
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
            version: 3,
            docId: this.currentDocId,
            name: this.currentDocName,
            createdAt: new Date().toISOString(),
            savedAt: new Date().toISOString(),
            canvasWidth: canvasSize.w,
            canvasHeight: canvasSize.h,
            documentSize: this._documentSizePx ?? null,
            layers: layerMeta.map(l => ({
                id: l.id,
                name: l.name,
                type: l.type,
                parentId: l.parentId,
                collapsed: l.collapsed,
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
            canvasGrid: {
                visible: this.webgpuRenderer.getCanvasGridVisible(),
                color:   this.webgpuRenderer.getCanvasGridColor(),
                opacity: this.webgpuRenderer.getCanvasGridOpacity(),
                cells:   this.webgpuRenderer.getCanvasGridCells(),
            },
            pixelFormat: this.persistence?.getConfig().pixelFormat ?? 'png',
        };

        // Read pixel data
        const layers = await this.rasterLayerManager?.exportLayerPixels() ?? [];
        const cels = await this.rasterLayerManager?.exportCelPixels() ?? [];

        // Gather 3D mesh states — gated on dirty to avoid serializing geometry on every stroke save.
        // packProject() passes forceAll3D=true to always include the full snapshot.
        let scene3dJSON: string | null = null;
        const models3d: Record<string, ArrayBuffer> = {};
        let textureLibrary: { entries: any[] } | null = null;
        let _onWriteComplete: (() => void) | undefined;

        const dirtyMeshIds = this.getDirtyMeshIds3D();
        const has3DChanges = forceAll3D || dirtyMeshIds.length > 0;

        if (this.scene3d) {
            // Global scene settings are always serialized — they're tiny and changes
            // to fog/lighting/etc. don't flip the mesh dirty flag.
            const globalScene = this.scene3d.getGlobalScene3DSettings();
            const faceRigs = this.scene3d.serializeFaceRigs();         // anime face/eye expression metadata
            const clothingRigs = this.scene3d.serializeClothingRigs(); // procedural garment params (regenerate on load)
            const hairRigs = this.scene3d.serializeHairRigs();         // procedural hair params (regenerate on load)
            const bodyParams = this.scene3d.serializeBodyParams();     // procedural body params (re-seed the sliders on load)
            const attachments = this.scene3d.serializeAttachments();   // charms/accessories (placement + params; regenerate on load)
            const bakedPartMetas = this.scene3d.serializeBakedParts(); // baked kitbash part metadata (bytes ride in `bakedParts`)
            // ALWAYS serialize nodes + skeletons (+ the light rigs / globalScene) so an incremental save can NEVER
            // drop the 3D scene. The bug: when no 3D mesh was dirty (has3DChanges=false), scene3dJSON was rewritten
            // WITHOUT nodes/skeletons → the body + skeleton (and thus all overlays) were wiped on the next load
            // ("everything gone" after a 2D-only autosave). Only the HEAVY parts (GLB model buffers + texture
            // library) stay gated on dirty — node JSON is light + the debounced save makes this cheap.
            const nodes = this.scene3d.getAllMeshes().filter(m => !m.isFaceDecal && !m.isHair && !m.isClothing && !m.isAttachment && !m.excludeFromDocument).map(m => this._buildMeshState(m));
            const skeletons = this.scene3d.getAllSkeletons().map(s => this.scene3d!.serializeSkeletonForSave(s));
            // Round floats to 6 decimals as we serialize — skeleton inverse-bind matrices + rotations carry ~15
            // digits of noise ("0.916000000012") that bloat the JSON and gzip poorly. 6 decimals is visually
            // lossless for matrices/quaternions/positions. Guard ≥1e9 (timestamps etc.) so *1e6 can't overflow 2^53.
            const round6 = (_k: string, v: any) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9) ? Math.round(v * 1e6) / 1e6 : v;
            scene3dJSON = JSON.stringify({ nodes, skeletons, globalScene, faceRigs, clothingRigs, hairRigs, bodyParams, attachments, bakedPartMetas }, round6);
            if (has3DChanges) {
                for (const [id, buf] of this.scene3d.getModelStore().entries()) models3d[id] = buf;
                textureLibrary = this.scene3d.getTextureLibraryData() ?? null;
                _onWriteComplete = () => this.clearDirtyMeshState3D();
            }
        }

        // UV-painted mesh textures → PNG bytes keyed by mesh ID (from the UV paint tool).
        const meshTextures: Record<string, ArrayBuffer> = {};
        for (const [meshId, mgr] of this._uvPaintTextures) {
            if (this.scene3d?.getMesh(meshId)?.isFaceDecal) continue;   // decal texture persists via the face path
            if (!mgr.getTexture()) continue;
            // A garment's mesh id changes every regenerate, so key its paint by the STABLE rig key
            // (`__cloth__:bodyId:slot`) and re-apply it after the garment rebuilds on load (like faces).
            const clothKey = this.scene3d?.clothingRigKeyForMesh(meshId) ?? null;
            try {
                const blob = await mgr.exportToBlob('image/png');
                if (blob.size > 0) meshTextures[clothKey ? `__cloth__:${clothKey}` : meshId] = await blob.arrayBuffer();
            } catch (e) { console.warn('[UVPaint] export texture failed for', meshId, e); }
        }
        // Anime face expression textures → PNG, keyed `__face__:${bodyMeshId}:${exprId}` (rides in meshTextures).
        // PROCEDURAL expressions (eye params) regenerate from params on load (restoreFaceRigs), so skip their PNG —
        // a 1024² face PNG is a big chunk of a character's save. Only hand-authored face textures need to persist.
        for (const { key, mgr, procedural } of this.scene3d?.getFaceTextureExports() ?? []) {
            if (procedural) continue;
            if (!mgr.getTexture()) continue;
            try {
                const blob = await mgr.exportToBlob('image/png');
                if (blob.size > 0) meshTextures[`__face__:${key}`] = await blob.arrayBuffer();
            } catch (e) { console.warn('[Face] export texture failed for', key, e); }
        }

        // Baked kitbash parts (generated garments/hair) → GLB bytes keyed by part id, so they survive reload.
        const bakedParts = this.scene3d ? await this.scene3d.getBakedPartBuffers() : {};

        return {
            manifest,
            sceneGraphJSON: this.getSceneGraphJSONForDocument(),   // 3D-mesh geometry stripped (lives in scene3dJSON) — was duplicating ~MBs/character
            brushPresetsJSON: this.exportAllBrushPresets(),
            layers,
            cels,
            scene3dJSON,
            models3d,
            meshTextures,
            bakedParts,
            textureLibrary,
            ephemeraJSON: this._ephemera ? this._ephemera.serialize() : null,
            _onWriteComplete,
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

        // 3. Restore document size / illustration mode before touching any textures.
        // This ensures the renderer and rasterLayerManager agree on pixel dimensions
        // before layers are created, so that a subsequent setDocumentSize() call from
        // the host app (e.g. reading URL params) hits the same size and is idempotent.
        if (payload.manifest.documentSize) {
            this.setDocumentSize(payload.manifest.documentSize.w, payload.manifest.documentSize.h);
        } else {
            // Older saves or infinite-canvas docs: clear any bounded mode.
            this.clearDocumentSize();
        }

        // 4. Recreate raster layers from manifest, then upload pixel data
        if (this.rasterLayerManager && payload.manifest.layers.length > 0) {
            // canvasWidth/canvasHeight records the actual pixel dimensions of the saved layer
            // data and may differ from documentSize (e.g. if the host resized the canvas while
            // in illustration mode, causing layers to be downscaled before save).
            // We must resize layers to the saved pixel dimensions BEFORE creating/uploading so
            // that uploadPixelsToLayer uses the correct bytesPerRow — otherwise a stride mismatch
            // causes the "bottom empty, top cut off" visual artifact.
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
                if (entry.type === '3d-scene') {
                    this.rasterLayerManager.add3DDividerWithId(entry.id, entry.name);
                } else if (entry.type === 'vector' || entry.type === 'ephemera') {
                    this.rasterLayerManager.addVectorLayerWithId(entry.id, entry.name, { visible: entry.visible });
                } else {
                    this.rasterLayerManager.addLayerWithId(entry.id, entry.name, {
                        visible: entry.visible,
                        locked: entry.locked,
                        blendMode: entry.blendMode as any,
                        opacity: entry.opacity,
                        clipped: entry.clipped,
                        lockTransparency: entry.lockTransparency,
                        parentId: entry.parentId ?? undefined,
                        collapsed: entry.collapsed,
                        ditherConfig: entry.ditherConfig,
                        frameLinkAnimation: entry.frameLinkAnimation,
                    });
                }
            }
            console.log('[Salsa restore] After adding all layers:', this.rasterLayerManager.getLayers().length, this.rasterLayerManager.getLayers().map(l => l.name));

            // Upload pixel data to the recreated layers
            for (const layerData of payload.layers) {
                const ok = this.rasterLayerManager.uploadPixelsToLayer(layerData.id, layerData.pixelData);
                console.log('[Salsa restore] Upload pixels for', layerData.id, '→', ok ? 'OK' : 'FAILED (layer not found)');
            }

            // After uploading at savedW×savedH, normalize layer textures back to documentSize
            // if they differ. This keeps rasterLayerManager.width/height in sync with
            // _documentSizePx so that the next save's canvasWidth/canvasHeight is correct.
            // ensureTexture copies existing content to the top-left of the new texture.
            const ds = payload.manifest.documentSize;
            if (ds && savedW && savedH && (ds.w !== savedW || ds.h !== savedH)) {
                this.rasterLayerManager.setSize(ds.w, ds.h);
            }

            // Default-select the highest raster or 3D-scene layer. Layer order is
            // bottom→top (index 0 = Background), so scan from the top of the stack.
            // Folder / vector / ephemera / reference layers are skipped; fall back
            // to the first layer if nothing qualifies.
            if (payload.manifest.layers.length > 0) {
                const top = [...payload.manifest.layers].reverse()
                    .find(l => (l.type ?? 'layer') === 'layer' || l.type === '3d-scene');
                this.rasterLayerManager.selectLayer((top ?? payload.manifest.layers[0]).id);
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

        // 5b. Restore the visible 2D canvas grid (per-illustration).
        const cg = payload.manifest.canvasGrid;
        if (cg) {
            this.webgpuRenderer.setCanvasGridColor(cg.color[0], cg.color[1], cg.color[2]);
            this.webgpuRenderer.setCanvasGridOpacity(cg.opacity);
            this.webgpuRenderer.setCanvasGridCells(cg.cells);
            this.webgpuRenderer.setCanvasGridVisible(cg.visible);
        }

        // 6. Restore 3D mesh nodes, then re-upload texture library and bind to meshes
        let faceRigStates: any[] = [];       // anime face/eye rigs — rebuilt after meshTextures (needs the eye PNGs)
        let clothingRigStates: any[] = [];   // procedural garments — rebuilt from params after the body/skeleton load
        let hairRigStates: any[] = [];       // procedural hair — rebuilt from params after the body/skeleton load
        let bodyParamStates: any[] = [];     // procedural body params — repopulate the map so live edits merge
        let attachmentStates: any[] = [];    // charms/accessories — rebuilt from placement + params after the body load
        let bakedPartMetaStates: any[] = []; // baked kitbash part metadata — re-register with bytes from payload.bakedParts
        if (payload.scene3dJSON && this.scene3d) {
            try {
                const parsed = JSON.parse(payload.scene3dJSON);
                // New format: { nodes, skeletons, globalScene }. Old format: flat array of mesh states.
                const nodes: any[]     = Array.isArray(parsed) ? parsed : (parsed.nodes     ?? []);
                const skeletons: any[] = Array.isArray(parsed) ? []     : (parsed.skeletons ?? []);
                faceRigStates          = Array.isArray(parsed) ? []     : (parsed.faceRigs  ?? []);
                clothingRigStates      = Array.isArray(parsed) ? []     : (parsed.clothingRigs ?? []);
                hairRigStates          = Array.isArray(parsed) ? []     : (parsed.hairRigs  ?? []);
                bodyParamStates        = Array.isArray(parsed) ? []     : (parsed.bodyParams ?? []);
                attachmentStates       = Array.isArray(parsed) ? []     : (parsed.attachments ?? []);
                bakedPartMetaStates    = Array.isArray(parsed) ? []     : (parsed.bakedPartMetas ?? []);
                if (!Array.isArray(parsed) && parsed.globalScene) {
                    this.scene3d.restoreGlobalScene3DSettings(parsed.globalScene);
                }

                // Capture MeshGroup3D hierarchy before clearing child meshes.
                // setSceneGraphJSON (step 1) already restored groups with preserved IDs.
                // After the clear below, groups stay but their children are gone; we use
                // this map to re-add each restored mesh to its original group.
                const childToGroup = new Map<string, MeshGroup3D>();
                for (const node of this.sceneGraph.root.children) {
                    if (node instanceof MeshGroup3D) {
                        for (const child of node.children) {
                            childToGroup.set((child as any).id, node as MeshGroup3D);
                        }
                    }
                }

                // Clear existing 3D skeletons and meshes first
                for (const s of this.scene3d.getAllSkeletons()) s.parent?.removeChild(s);
                for (const m of this.scene3d.getAllMeshes())    m.parent?.removeChild(m);

                // Restore skeletons before meshes so re-link can find them.
                for (const skelState of skeletons) {
                    this.scene3d.restoreSkeletonState(skelState);
                }
                for (const state of nodes) {
                    const glbBuf = state.glbMeshId ? payload.models3d?.[state.glbMeshId] : undefined;
                    await this.scene3d.restoreMeshState(state, glbBuf);
                }
                // Re-link SkinnedMesh3D.skeleton references by matching skeletonId.
                this.scene3d.relinkSkinnedMeshSkeletons();
                // Default idle/personality clips + poses are stripped from procedural-body skeletons on save
                // (identical across characters) — re-install here, idempotent by name (edits/additions were kept).
                for (const s of this.scene3d.getAllSkeletons()) if ((s as any).isProceduralBody) this.scene3d.installDefaultAnimations(s.id);

                // Re-populate MeshGroup3D containers with the freshly restored meshes.
                // restoreMeshState preserves the serialized mesh ID, so childToGroup lookups work.
                for (const mesh of this.scene3d.getAllMeshes()) {
                    const group = childToGroup.get(mesh.id);
                    if (group) {
                        mesh.parent?.removeChild(mesh);
                        group.addChild(mesh);
                    }
                }

                // Ensure GPU instance sync callback is active for any restored ArrayGroup3D nodes.
                if (this.sceneGraph.root.children.some(c => c instanceof ArrayGroup3D)) {
                    this.scene3d.registerRestoredArrayGroups();
                }
            } catch (e) {
                console.warn('[ShapeManager] Failed to restore 3D scene:', e);
            }
        }
        // Texture library must be restored AFTER meshes exist so the
        // restoreTextureLibraryData loop can find them via getAllMeshes().
        if (payload.textureLibrary && this.scene3d) {
            try {
                await this.scene3d.restoreTextureLibraryData(payload.textureLibrary);
            } catch (e) {
                console.warn('[ShapeManager] Failed to restore texture library:', e);
            }
        }

        // Restore UV-painted mesh textures onto their meshes. After the texture
        // library so a painted texture wins for any mesh the user painted.
        const faceBlobs = new Map<string, ArrayBuffer>();
        const clothBlobs = new Map<string, ArrayBuffer>();   // key = `${bodyId}:${slot}`; applied after garments rebuild
        if (payload.meshTextures && this.scene3d) {
            const device = this.webgpuRenderer?.getDevice();
            for (const [meshId, buf] of Object.entries(payload.meshTextures)) {
                if (meshId.startsWith('__face__:'))  { faceBlobs.set(meshId.slice('__face__:'.length), buf); continue; }
                if (meshId.startsWith('__cloth__:')) { clothBlobs.set(meshId.slice('__cloth__:'.length), buf); continue; }
                const mesh = this.scene3d.getMesh(meshId);
                if (!mesh || !device || !buf.byteLength) continue;
                try {
                    const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
                    let mgr = this._uvPaintTextures.get(meshId);
                    if (!mgr) { mgr = new RasterTextureManager(device); this._uvPaintTextures.set(meshId, mgr); }
                    const tex = mgr.ensureTexture(bitmap.width, bitmap.height);
                    device.queue.copyExternalImageToTexture(
                        { source: bitmap, flipY: false }, { texture: tex }, [bitmap.width, bitmap.height],
                    );
                    mesh.diffuseTexture = tex;
                    mesh.material.hasTexture = true;
                    mesh.gpuDirty = true;
                } catch (e) {
                    console.warn('[UVPaint] restore texture failed for', meshId, e);
                }
            }
        }

        // Rebuild the anime face rigs (eye decals + per-expression textures) — bodies + eye PNGs now exist.
        if (faceRigStates.length && this.scene3d) {
            try { await this.scene3d.restoreFaceRigs(faceRigStates, faceBlobs); }
            catch (e) { console.warn('[Face] restore rigs failed', e); }
        }

        // Rebuild procedural garments from their params — bodies + skeletons now exist.
        if (clothingRigStates.length && this.scene3d) {
            try { this.scene3d.restoreClothingRigs(clothingRigStates); }
            catch (e) { console.warn('[Clothing] restore rigs failed', e); }
        }

        // Re-apply painted garment textures onto the freshly-rebuilt garments (keyed by rig, not mesh id).
        if (clothBlobs.size && this.scene3d) {
            try { await this._restoreClothingTextures(clothBlobs); }
            catch (e) { console.warn('[ClothPaint] restore textures failed', e); }
        }

        // Rebuild procedural hair from its params — bodies + skeletons now exist.
        if (hairRigStates.length && this.scene3d) {
            try { this.scene3d.restoreHairRigs(hairRigStates); }
            catch (e) { console.warn('[Hair] restore rigs failed', e); }
        }

        // Rebuild charms/accessories from their placement + params — bodies + skeletons now exist.
        if (attachmentStates.length && this.scene3d) {
            try { this.scene3d.restoreAttachments(attachmentStates); }
            catch (e) { console.warn('[Charm] restore attachments failed', e); }
        }

        // Repopulate procedural body params (the body geometry is already restored as a node — this just
        // lets a later live edit merge a single-field change correctly).
        if ((bakedPartMetaStates.length) && this.scene3d) {
            try { this.scene3d.restoreBakedParts(bakedPartMetaStates, payload.bakedParts); }
            catch (e) { console.warn('[Kitbash] restore baked parts failed', e); }
        }

        if (bodyParamStates.length && this.scene3d) {
            try { this.scene3d.restoreBodyParams(bodyParamStates); }
            catch (e) { console.warn('[Body] restore params failed', e); }
        }

        // Restore ephemera placements and sheets.
        if (payload.ephemeraJSON) {
            try {
                this._ephemera.deserialize(payload.ephemeraJSON);
            } catch (e) {
                console.warn('[ShapeManager] Failed to restore ephemera:', e);
            }
        }

        } finally {
            this._isRestoring = false;
        }

        // Procedural content (city / buildings / foliage) persists as lightweight params-only MARKERS. The scene-graph
        // restore above recreates the marker containers (so they appear in the outliner) but NOT their geometry — so
        // without this step a reopened document shows the buildings in the outliner yet renders nothing. Regenerate
        // from the markers here, rather than relying on the host to call restoreProceduralFromSave3D() itself.
        if (this.scene3d) {
            try {
                const restored = this.restoreProceduralFromSave3D();
                if (restored.city || restored.buildings || restored.blocks || restored.foliage) {
                    console.log('[Salsa loadDocument] Regenerated procedural content:', restored);
                }
            } catch (e) {
                console.warn('[ShapeManager] Failed to regenerate procedural content on load:', e);
            }
        }

        // Migrate legacy documents (v2 / missing pixelFormat / 'raw') to PNG going forward.
        // The pixel data was already decoded to raw RGBA during load; upgrading the config
        // here ensures the next save encodes as PNG and writes 'png' to the manifest,
        // overriding any 'raw' value that was passed in via enableAutoSave or setPixelFormat.
        if (!payload.manifest.pixelFormat || payload.manifest.pixelFormat === 'raw') {
            this.persistence?.setConfig({ pixelFormat: 'png' });
        }

        // Sync the renderer's animation frame counter so procedural effects
        // (frame link animations) render correctly on the first frame.
        this.syncRendererFrame();

        // Single authoritative event — all layers, scene graph, and animation
        // state are fully restored at this point.
        this.interactionService.onSceneGraphChanged.emit();
        this.scheduleRender();
    }

    // ── Ephemera ──────────────────────────────────────────────────────

    public getEphemeraCategories(): EphemeraCategory[] {
        return this._ephemera.getCategories();
    }

    public getEphemeraGeneratorsByCategory(categoryId: string): IEphemeraGenerator[] {
        return this._ephemera.getGeneratorsByCategory(categoryId);
    }

    public getEphemeraGenerator(typeId: string): IEphemeraGenerator | undefined {
        return this._ephemera.getGenerator(typeId);
    }

    public getEphemeraDefaultParams(typeId: string): Record<string, unknown> {
        return this._ephemera.getDefaultParams(typeId);
    }

    public generateEphemera(typeId: string, params: Record<string, unknown>): string {
        return this._ephemera.generate(typeId, params);
    }

    /**
     * Returns the world-space width and height that will display this ephemera
     * at its natural SVG pixel size at the current zoom level.
     * Use this as the default W/H when placing via "Place on Canvas".
     */
    public getDefaultPlacementSize(typeId: string): { width: number; height: number } {
        const params = this.getEphemeraDefaultParams(typeId);
        const svgStr = this.generateEphemera(typeId, params);
        const wMatch = svgStr.match(/<svg[^>]+\bwidth="([\d.]+)"/);
        const hMatch = svgStr.match(/<svg[^>]+\bheight="([\d.]+)"/);
        const svgPxW = wMatch ? parseFloat(wMatch[1]) : 160;
        const svgPxH = hMatch ? parseFloat(hMatch[1]) : 160;

        const canvas = this._ephemeraOverlayCtx?.canvas;
        if (!canvas) return { width: 0.5, height: 0.5 };

        const m = this.interactionService.getWorldMatrix() as Float32Array;
        const sx = Math.abs(m[0]) * canvas.width  * 0.5;
        const sy = Math.abs(m[5]) * canvas.height * 0.5;

        return { width: svgPxW / sx, height: svgPxH / sy };
    }

    public getEphemeraSheets(): EphemeraElementSheet[] {
        return this._ephemera.getSheets();
    }

    public createEphemeraSheet(name: string): EphemeraElementSheet {
        return this._ephemera.createSheet(name);
    }

    public renameEphemeraSheet(id: string, name: string): boolean {
        return this._ephemera.renameSheet(id, name);
    }

    public deleteEphemeraSheet(id: string): boolean {
        return this._ephemera.deleteSheet(id);
    }

    public addEphemeraElement(
        typeId: string,
        params: Record<string, unknown>,
        label?: string,
        sheetId?: string,
    ): EphemeraElement | null {
        return this._ephemera.addElement(typeId, params, label, sheetId);
    }

    public updateEphemeraElement(
        sheetId: string,
        elementId: string,
        params: Record<string, unknown>,
        label?: string,
    ): boolean {
        return this._ephemera.updateElement(sheetId, elementId, params, label);
    }

    public deleteEphemeraElement(sheetId: string, elementId: string): boolean {
        return this._ephemera.deleteElement(sheetId, elementId);
    }

    public duplicateEphemeraElement(sheetId: string, elementId: string): EphemeraElement | null {
        return this._ephemera.duplicateElement(sheetId, elementId);
    }

    public moveEphemeraElement(fromSheetId: string, toSheetId: string, elementId: string): boolean {
        return this._ephemera.moveElement(fromSheetId, toSheetId, elementId);
    }

    public exportEphemeraSheet(sheetId: string): Blob | null {
        return this._ephemera.exportSheet(sheetId);
    }

    public exportEphemeraElement(sheetId: string, elementId: string): Blob | null {
        return this._ephemera.exportElement(sheetId, elementId);
    }

    public exportAllEphemeraSheets(): Blob {
        return this._ephemera.exportAllSheets();
    }

    public async importEphemeraFromBlob(blob: Blob, onConflict: 'merge' | 'new' = 'new'): Promise<EphemeraElementSheet[]> {
        return this._ephemera.importFromBlob(blob, onConflict);
    }

    // ── Vector Layer ──────────────────────────────────────────────────

    /** Create a vector layer in the layer stack. Returns its ID. */
    public addVectorLayer(name = 'Vector'): string | null {
        if (!this.rasterLayerManager) return null;
        return this.rasterLayerManager.addVectorLayer(name);
    }

    /** Remove a vector layer and all its ephemera placements. */
    public removeVectorLayer(layerId: string): boolean {
        this._ephemera.deleteAllPlacementsForLayer(layerId);
        this._ephemeraOverlayCache.clear();
        return this.rasterLayerManager?.removeVectorLayer(layerId) ?? false;
    }

    /** Get all vector layers in the stack. */
    public getVectorLayers(): Array<{ id: string; name: string; visible: boolean }> {
        return this.rasterLayerManager?.getVectorLayers() ?? [];
    }

    // ── Ephemera Layer (backwards-compat aliases) ─────────────────────

    /** @deprecated Use addVectorLayer instead. */
    public addEphemeraLayer(name = 'Vector'): string | null { return this.addVectorLayer(name); }
    /** @deprecated Use removeVectorLayer instead. */
    public removeEphemeraLayer(layerId: string): boolean { return this.removeVectorLayer(layerId); }
    /** @deprecated Use getVectorLayers instead. */
    public getEphemeraLayers(): Array<{ id: string; name: string; visible: boolean }> { return this.getVectorLayers(); }

    // ── Ephemera SVG overlay rendering ────────────────────────────────

    /**
     * Set the 2D canvas used to render non-destructive ephemera placements on top
     * of the WebGPU canvas. The caller is responsible for positioning this canvas
     * absolutely over the WebGPU canvas at the same dimensions.
     * Pass null to detach.
     */
    public setEphemeraOverlayCanvas(canvas: HTMLCanvasElement | null): void {
        // Unsubscribe existing post-frame hook
        if (this._ephemeraOverlayUnsub) {
            this._ephemeraOverlayUnsub();
            this._ephemeraOverlayUnsub = null;
        }
        this._ephemeraOverlayCtx = canvas ? canvas.getContext('2d') : null;
        this._ephemeraOverlayCache.clear();

        if (canvas && this.webgpuRenderer) {
            this._ephemeraOverlayUnsub = this.webgpuRenderer.addPostFrameCallback(
                () => this._renderEphemeraOverlay(),
            );
        }
    }

    private _renderEphemeraOverlay(): void {
        const ctx = this._ephemeraOverlayCtx;
        if (!ctx) return;
        const canvas = ctx.canvas;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Suppress the ephemera overlay while the mesh-edit / UV focus background is up
        // (opaque) — it's a separate 2D canvas on top of WebGPU, so it would otherwise
        // float over the clean mesh-editing/painting workspace. Cleared above → blank.
        if (this.scene3d?.meshEditFocusHidesContent?.()) return;

        const allPlacements = this._ephemera.getAllPlacements();
        if (allPlacements.size === 0) return;

        const layers = this.rasterLayerManager?.getLayers() ?? [];
        const worldMatrix = this.interactionService.getWorldMatrix() as Float32Array;
        const w = canvas.width, h = canvas.height;

        // Convert gl-matrix column-major mat4 (world → WebGPU clip space) to
        // a 2D canvas transform (world → screen pixels, y-axis flipped).
        const a =  worldMatrix[0] * 0.5 * w;
        const b = -worldMatrix[1] * 0.5 * h;
        const c =  worldMatrix[4] * 0.5 * w;
        const d = -worldMatrix[5] * 0.5 * h;
        const e = (worldMatrix[12] + 1) * 0.5 * w;
        const f = (1 - worldMatrix[13])  * 0.5 * h;

        ctx.save();
        ctx.setTransform(a, b, c, d, e, f);

        for (const [layerId, placements] of allPlacements) {
            const layerEntry = layers.find(l => l.id === layerId);
            if (!layerEntry?.visible) continue;

            for (const p of placements) {
                if (!p.visible) continue;

                // Get or refresh the cached HTMLImageElement for this placement's SVG.
                let cached = this._ephemeraOverlayCache.get(p.id);
                if (!cached || cached.svg !== p.svg) {
                    if (cached) URL.revokeObjectURL(cached.img.src);
                    const blob = new Blob([p.svg], { type: 'image/svg+xml' });
                    const url = URL.createObjectURL(blob);
                    const img = new Image();
                    const entry = { svg: p.svg, img, loaded: false };
                    img.onload = () => { entry.loaded = true; this.scheduleRender(); };
                    img.src = url;
                    this._ephemeraOverlayCache.set(p.id, entry);
                    cached = entry;
                }
                if (!cached.loaded) continue;

                ctx.save();
                ctx.globalAlpha = p.opacity;
                ctx.globalCompositeOperation = p.blendMode ?? 'source-over';
                ctx.translate(p.x + p.width * 0.5, p.y + p.height * 0.5);
                if (p.rotation !== 0) ctx.rotate(p.rotation * Math.PI / 180);
                ctx.scale(1, -1);
                ctx.drawImage(cached.img, -p.width * 0.5, -p.height * 0.5, p.width, p.height);
                ctx.restore();
            }
        }

        // ── Selection handles ────────────────────────────────────────
        const selLayerId = this._selectedPlacementLayerId;
        const selId = this._selectedPlacementId;
        if (selLayerId && selId) {
            const selPlacements = this._ephemera.getPlacementsForLayer(selLayerId);
            const sp = selPlacements.find(pl => pl.id === selId);
            const selLayer = layers.find(l => l.id === selLayerId);
            if (sp && selLayer?.visible && sp.visible) {
                const HANDLE_PX = 8;
                const ROTATE_OFFSET_PX = 28;
                const hw = (HANDLE_PX / 2) / a;
                const hh = (HANDLE_PX / 2) / Math.abs(d);
                const rotOffY = ROTATE_OFFSET_PX / Math.abs(d);

                const rad = sp.rotation * Math.PI / 180;
                const cos = Math.cos(rad), sin = Math.sin(rad);
                const cx = sp.x + sp.width * 0.5;
                const cy = sp.y + sp.height * 0.5;
                const hw2 = sp.width * 0.5, hh2 = sp.height * 0.5;

                const toWorld = (lx: number, ly: number): [number, number] =>
                    [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];

                // Dashed outline
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(rad);
                ctx.strokeStyle = 'rgba(60, 200, 255, 0.95)';
                ctx.lineWidth = 1.5 / a;
                ctx.setLineDash([4 / a, 3 / a]);
                ctx.strokeRect(-hw2, -hh2, sp.width, sp.height);
                ctx.setLineDash([]);
                ctx.restore();

                // 8 resize handles
                const handleOffsets: [number, number][] = [
                    [-hw2, -hh2], [0, -hh2], [hw2, -hh2],
                    [-hw2, 0],               [hw2, 0],
                    [-hw2, +hh2], [0, +hh2], [hw2, +hh2],
                ];
                for (const [lx, ly] of handleOffsets) {
                    const [wx2, wy2] = toWorld(lx, ly);
                    ctx.save();
                    ctx.translate(wx2, wy2);
                    ctx.rotate(rad);
                    ctx.fillStyle = 'white';
                    ctx.strokeStyle = 'rgba(60, 200, 255, 0.95)';
                    ctx.lineWidth = 1 / a;
                    ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
                    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
                    ctx.restore();
                }

                // Rotation handle: stem + circle
                const [tcx, tcy] = toWorld(0, -hh2);
                const [rotX, rotY] = toWorld(0, -hh2 - rotOffY);
                ctx.beginPath();
                ctx.strokeStyle = 'rgba(60, 200, 255, 0.95)';
                ctx.lineWidth = 1.5 / a;
                ctx.moveTo(tcx, tcy);
                ctx.lineTo(rotX, rotY);
                ctx.stroke();

                ctx.beginPath();
                ctx.fillStyle = 'white';
                ctx.strokeStyle = 'rgba(60, 200, 255, 0.95)';
                ctx.lineWidth = 1 / a;
                ctx.ellipse(rotX, rotY, hw * 1.5, hh * 1.5, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    /** Place an ephemera element on an ephemera layer. Returns the placement. */
    public addEphemeraPlacement(
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
        return this._ephemera.addPlacement(layerId, typeId, params, x, y, width, height, rotation, opacity);
    }

    /** Update position, size, rotation, opacity, or params of an existing placement. */
    public updateEphemeraPlacement(
        layerId: string,
        placementId: string,
        updates: Partial<Pick<EphemeraPlacement, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'visible' | 'params' | 'blendMode' | 'glow' | 'feather'>>,
    ): boolean {
        return this._ephemera.updatePlacement(layerId, placementId, updates);
    }

    /** Remove a single placement from an ephemera layer. */
    public deleteEphemeraPlacement(layerId: string, placementId: string): boolean {
        return this._ephemera.deletePlacement(layerId, placementId);
    }

    /** Get all placements on an ephemera layer. */
    public getEphemeraPlacementsForLayer(layerId: string): EphemeraPlacement[] {
        return this._ephemera.getPlacementsForLayer(layerId);
    }

    // ── Placement hit-testing & interaction ───────────────────────────

    private _activeVectorLayerId: string | null = null;
    private _selectedPlacementLayerId: string | null = null;
    private _selectedPlacementId: string | null = null;

    public setActiveVectorLayer(id: string | null): void {
        this._activeVectorLayerId = id;
        // Mirror onto the shared interaction bus so the renderer's hit-tests gate pointer
        // interactivity to this layer (null = all layer-tagged vector shapes become inert).
        this.interactionService.activeVectorLayerId = id;
        // Anything currently selected that is no longer interactive (a layer-tagged shape whose
        // layer just went inactive) must drop its selection ring — inert means no selection.
        // Unassigned shapes (no layerId) stay live, so they keep their selection.
        const stale = [...this.interactionService.selectedNodes].filter(
            n => n.layerId && n.layerId !== id,
        );
        if (stale.length) {
            for (const n of stale) this.interactionService.deselectNode(n);
            this.scheduleRender();
        }
        // Same for a selected ephemera placement — drop its handles when its layer goes inactive.
        const selP = this.getSelectedPlacement();
        if (selP && !this.interactionService.isVectorLayerInteractive(selP.layerId)) {
            this.clearPlacementSelection();
            this.scheduleRender();
        }
    }
    public getActiveVectorLayerId(): string | null { return this._activeVectorLayerId; }

    /** Show or hide all nodes belonging to a vector layer. Also persists the visible flag on the layer entry. */
    public setVectorLayerVisible(layerId: string, visible: boolean): void {
        this.rasterLayerManager?.setVisibility(layerId, visible);
        this.webgpuRenderer?.setVectorLayerVisible(layerId, visible);
    }

    public getSelectedPlacement(): { layerId: string; placementId: string } | null {
        if (!this._selectedPlacementLayerId || !this._selectedPlacementId) return null;
        return { layerId: this._selectedPlacementLayerId, placementId: this._selectedPlacementId };
    }

    public selectPlacement(layerId: string, placementId: string): void {
        this._selectedPlacementLayerId = layerId;
        this._selectedPlacementId = placementId;
        this.scheduleRender();
    }

    public clearPlacementSelection(): void {
        this._selectedPlacementLayerId = null;
        this._selectedPlacementId = null;
    }

    /**
     * Hit-test world-space point (worldX, worldY) against all visible ephemera placements.
     * Returns the topmost hit, or null. Accounts for placement rotation.
     */
    public hitTestEphemeraPlacement(
        worldX: number,
        worldY: number,
    ): { layerId: string; placementId: string; x: number; y: number } | null {
        const layers = this.rasterLayerManager?.getLayers() ?? [];
        for (const [layerId, placements] of this._ephemera.getAllPlacements()) {
            const layer = layers.find(l => l.id === layerId);
            if (!layer?.visible) continue;
            // Iterate in reverse so topmost placement (last in array) is checked first
            for (let i = placements.length - 1; i >= 0; i--) {
                const p = placements[i];
                if (!p.visible) continue;
                if (this._placementContainsPoint(p, worldX, worldY)) {
                    return { layerId, placementId: p.id, x: p.x, y: p.y };
                }
            }
        }
        return null;
    }

    private _placementContainsPoint(p: EphemeraPlacement, wx: number, wy: number): boolean {
        const cx = p.x + p.width  * 0.5;
        const cy = p.y + p.height * 0.5;
        const dx = wx - cx;
        const dy = wy - cy;
        if (p.rotation === 0) {
            return Math.abs(dx) <= p.width * 0.5 && Math.abs(dy) <= p.height * 0.5;
        }
        const rad = p.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const lx =  dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;
        return Math.abs(lx) <= p.width * 0.5 && Math.abs(ly) <= p.height * 0.5;
    }

    /** Move a placement to a new position (called by the renderer drag handler). */
    public movePlacementTo(layerId: string, placementId: string, newX: number, newY: number): void {
        this._ephemera.updatePlacement(layerId, placementId, { x: newX, y: newY });
        this.scheduleRender();
    }

    /**
     * Hit-test the transform handles of the currently selected placement.
     * Returns a PlacementHandleHit describing which handle was hit, or null.
     * Called by the renderer before the placement body hit-test.
     */
    public hitTestPlacementHandle(wx: number, wy: number): PlacementHandleHit | null {
        if (!this._selectedPlacementLayerId || !this._selectedPlacementId) return null;
        const p = this._ephemera.getPlacementsForLayer(this._selectedPlacementLayerId)
            .find(pl => pl.id === this._selectedPlacementId);
        if (!p || !p.visible) return null;

        // Compute world-space handle half-size (fixed 12 screen-px hit area)
        const HANDLE_HIT_PX = 12;
        const ROTATE_OFFSET_PX = 28;
        const wm = this.interactionService.getWorldMatrix() as Float32Array;
        const cw = this._ephemeraOverlayCtx?.canvas.width ?? this.interactionService.canvas.width;
        const scaleX = wm[0] * 0.5 * cw;
        const ch = this._ephemeraOverlayCtx?.canvas.height ?? this.interactionService.canvas.height;
        const scaleY = Math.abs(wm[5]) * 0.5 * ch;
        const hw = (HANDLE_HIT_PX / 2) / scaleX;
        const hh = (HANDLE_HIT_PX / 2) / scaleY;
        const rotOffY = ROTATE_OFFSET_PX / scaleY;

        const rad = p.rotation * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const cx = p.x + p.width * 0.5;
        const cy = p.y + p.height * 0.5;
        const hw2 = p.width * 0.5, hh2 = p.height * 0.5;

        const toWorld = (lx: number, ly: number): [number, number] =>
            [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];

        // Rotation handle (circle) — check first since it's outside the placement bounds
        const [rotX, rotY] = toWorld(0, -hh2 - rotOffY);
        const dxR = wx - rotX, dyR = wy - rotY;
        const rotRadius = Math.max(hw, hh) * 1.5;
        if (dxR * dxR + dyR * dyR <= rotRadius * rotRadius) {
            return {
                kind: 'rotate',
                layerId: this._selectedPlacementLayerId,
                placementId: this._selectedPlacementId,
                centerX: cx, centerY: cy,
                startAngle: Math.atan2(wy - cy, wx - cx),
                startRotation: p.rotation,
            };
        }

        // Resize handles — AABB test in handle-local (rotated) space
        const resizeHandles: [PlacementResizeHandle, number, number][] = [
            ['TL', -hw2, -hh2], ['TC',    0, -hh2], ['TR', +hw2, -hh2],
            ['ML', -hw2,    0],                      ['MR', +hw2,    0],
            ['BL', -hw2, +hh2], ['BC',    0, +hh2], ['BR', +hw2, +hh2],
        ];
        // Anchor local offsets (opposite corner/edge for each handle)
        const anchorOffsets: Record<PlacementResizeHandle, [number, number]> = {
            'TL': [+hw2, +hh2], 'TC': [0, +hh2], 'TR': [-hw2, +hh2],
            'ML': [+hw2,    0],                   'MR': [-hw2,    0],
            'BL': [+hw2, -hh2], 'BC': [0, -hh2], 'BR': [-hw2, -hh2],
        };

        for (const [handle, lx, ly] of resizeHandles) {
            const [hx, hy] = toWorld(lx, ly);
            const dx = wx - hx, dy = wy - hy;
            // Unrotate test point into the handle's local frame
            const hlx =  dx * cos + dy * sin;
            const hly = -dx * sin + dy * cos;
            if (Math.abs(hlx) <= hw && Math.abs(hly) <= hh) {
                const [ax, ay] = toWorld(...anchorOffsets[handle]);
                return {
                    kind: 'resize',
                    layerId: this._selectedPlacementLayerId,
                    placementId: this._selectedPlacementId,
                    handle, anchorX: ax, anchorY: ay,
                };
            }
        }

        return null;
    }

    /** Apply a resize drag: recomputes x/y/width/height while pinning the anchor corner/edge. */
    public applyPlacementResize(
        layerId: string, placementId: string,
        handle: PlacementResizeHandle,
        anchorX: number, anchorY: number,
        dragX: number, dragY: number,
    ): void {
        const p = this._ephemera.getPlacementsForLayer(layerId).find(pl => pl.id === placementId);
        if (!p) return;

        const MIN_SIZE = 0.005;
        const rad = p.rotation * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);

        // New center = midpoint of fixed anchor and drag point
        const newCx = (anchorX + dragX) * 0.5;
        const newCy = (anchorY + dragY) * 0.5;

        // Compute local half-extents from (drag - new_center) rotated to local space
        const dx = dragX - newCx, dy = dragY - newCy;
        const lx = dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;

        let newW = p.width, newH = p.height;
        if (handle === 'TC' || handle === 'BC') {
            newH = Math.max(MIN_SIZE, Math.abs(ly) * 2);
        } else if (handle === 'ML' || handle === 'MR') {
            newW = Math.max(MIN_SIZE, Math.abs(lx) * 2);
        } else {
            newW = Math.max(MIN_SIZE, Math.abs(lx) * 2);
            newH = Math.max(MIN_SIZE, Math.abs(ly) * 2);
        }

        this._ephemera.updatePlacement(layerId, placementId, {
            x: newCx - newW * 0.5,
            y: newCy - newH * 0.5,
            width: newW,
            height: newH,
        });
        this.scheduleRender();
    }

    /** Apply a rotate drag: updates rotation from angular delta around the placement center. */
    public applyPlacementRotate(
        layerId: string, placementId: string,
        centerX: number, centerY: number,
        startAngle: number, startRotation: number,
        dragX: number, dragY: number,
    ): void {
        const currentAngle = Math.atan2(dragY - centerY, dragX - centerX);
        const delta = (currentAngle - startAngle) * (180 / Math.PI);
        this._ephemera.updatePlacement(layerId, placementId, { rotation: startRotation + delta });
        this.scheduleRender();
    }

    /**
     * Rasterize all visible placements on an ephemera layer onto a target raster layer.
     * Uses a single OffscreenCanvas pass (one undo snapshot).
     */
    public async rasterizeEphemeraLayer(layerId: string, targetLayerId?: string): Promise<boolean> {
        const rlm = this.rasterLayerManager;
        if (!rlm) return false;
        const target = targetLayerId ?? rlm.getSelectedLayerId();
        if (!target) return false;

        const placements = this._ephemera.getPlacementsForLayer(layerId)
            .filter(p => p.visible);
        if (placements.length === 0) return true;

        return rlm.compositeMultipleImagesOntoLayer(target, placements);
    }

    /**
     * Rasterize a single named placement from an ephemera layer.
     */
    public async rasterizeEphemeraPlacement(layerId: string, placementId: string, targetLayerId?: string): Promise<boolean> {
        const rlm = this.rasterLayerManager;
        if (!rlm) return false;
        const target = targetLayerId ?? rlm.getSelectedLayerId();
        if (!target) return false;

        const p = this._ephemera.getPlacementsForLayer(layerId).find(x => x.id === placementId);
        if (!p || !p.visible) return false;

        return rlm.compositeMultipleImagesOntoLayer(target, [p]);
    }

    /**
     * Render an ephemera SVG at the given size and return a PNG Blob for use
     * as a 3D material texture. Size should be a power-of-two (256, 512, 1024, 2048).
     */
    public exportEphemeraAs3DTexture(
        typeId: string,
        params: Record<string, unknown>,
        size: number,
    ): Promise<Blob> {
        return this._ephemera.exportAs3DTexture(typeId, params, size);
    }

    /**
     * Rasterize an ephemera SVG directly onto the active raster layer at the
     * given document coordinates. Uses the same composite path as mergeLayerDown.
     */
    public async stampEphemeraToLayer(
        typeId: string,
        params: Record<string, unknown>,
        x: number,
        y: number,
        stampW: number,
        stampH: number,
        layerId?: string,
    ): Promise<boolean> {
        const rlm = this.rasterLayerManager;
        if (!rlm) return false;
        const targetId = layerId ?? rlm.getSelectedLayerId();
        if (!targetId) return false;
        const svg = this._ephemera.generate(typeId, params);
        return rlm.compositeImageOntoLayer(targetId, svg, x, y, stampW, stampH);
    }

    public serializeEphemera(): string {
        return this._ephemera.serialize();
    }

    public deserializeEphemera(json: string): void {
        this._ephemera.deserialize(json);
    }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * 2D parametric line-segment intersection.
 * Returns the parameter `t` ∈ (0, 1) along the EDGE segment (ex0,ey0)→(ex1,ey1)
 * at which it crosses the KNIFE segment (kx0,ky0)→(kx1,ky1), or null if they
 * do not intersect within both segments.
 *
 * Derivation: solve K_start + s*K_dir = E_start + t*E_dir for s, t.
 * Uses the 2D cross-product (determinant) method.
 */
function _seg2DIntersect(
    kx0: number, ky0: number, kx1: number, ky1: number,
    ex0: number, ey0: number, ex1: number, ey1: number,
): number | null {
    const dkx = kx1 - kx0, dky = ky1 - ky0;
    const dex = ex1 - ex0, dey = ey1 - ey0;
    const denom = dkx * dey - dky * dex;
    if (Math.abs(denom) < 1e-9) return null;  // parallel / collinear
    const dx = ex0 - kx0, dy = ey0 - ky0;
    const s = (dx * dey - dex * dy) / denom;   // parameter along knife
    const t = (dx * dky - dkx * dy) / denom;   // parameter along edge
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return t;
    return null;
}

// Export only the singleton getter function
export default ShapeManager;
export type { DitherConfig, DitherAlgorithm };
export type { DualBrushSettings, DualBrushBlendOp, ColorJitter, WetEdgeSettings, StrokeTextureSettings };
export type { StabilizationMethod, BrushStabilization };
export type { FloodFillOptions } from '../renderer/raster/tools/flood-fill-engine';
export type { AutoSaveConfig, DocumentInfo, DocumentManifest } from './persistence/document-persistence';
export type { PixelFormat } from './persistence/pixel-codec';
export type { SpeechBalloonOptions, TailSide, BalloonStyle } from '../scene-graph/shapes/speech-balloon';
export type { PanelLayoutOptions, PanelTemplate, PanelDef } from '../scene-graph/shapes/panel-layout';
export type { TextEffectType, TextEffectConfig, TextEffectParams, TextCaptureConfig, ChromaticAberrationParams, GlowParams, WaveParams, GlitchParams, OutlineParams } from '../renderer/raster/effects/text-effect-engine';
export { defaultChromaticAberration, defaultGlow, defaultWave, defaultGlitch, defaultOutline, defaultFeather } from '../renderer/raster/effects/text-effect-engine';
export type { OnionSkinConfig, LoopMode, PlaybackState, TimelineState } from '../animation';
export type { FrameLinkAnimation, FrameLinkAnimationType, FrameLinkLoopMode } from '../animation';
export { DEFAULT_FRAME_LINK_ANIMATION } from '../animation';