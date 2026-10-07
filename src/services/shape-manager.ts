/**
 * TODO: Implement APIs via Feature Managers to expose different core systems 
 * ShapeManager handles shape CRUD and registry-level updates.
 * FlowchartingManager handles smart arrows, node linking, and snapping points. 
 * CollaborationManager handles presence, pointer syncing, WebSocket relays, locks, etc.
 * AIStreamManager manages streaming AI inference into buffers/registries.
 * SDFTextManager (or FontManager) handles SDF texture atlases, typesetting, caret, line wrapping, etc.
 * Uses the delegate-manager pattern — domain logic lives in managers under src/services/managers/.
 */

import { splitPassStats } from '../renderer/3d/pass-stats';
import { GPUPipelineCache, type PipelineWarmupStatus } from '../renderer/core/gpu-pipeline-cache';
import { getWorkerJobService, type WorkerJobProgress, type WorkerJobStats } from './workers/worker-job-service';
import { LayerManager } from './layer-manager';
import { PackagingManager, type PackagingMarker, type PackagingPersistEntry } from '../packaging/packaging-manager';
import { createPackagingHost } from '../packaging/packaging-host-impl';
import { PackagingComposite } from '../packaging/packaging-composite';
import { createCDKit, rebuildCDKitUnderRoot, setCDKitScrub, setCDPieceArt, setCDTrayClear, setCDTrayCardFold, removeCDKit, CD_MM_TO_WORLD, type CDKitHost, type CDKitState, type CDPieceMaterial } from '../packaging/cd/cd-kit';
import { cdComponentView, CD_ALL_PIECES, type CDPiece, type CDComponent } from '../packaging/cd/cd-kit-assembly';
import { cdPrintSpec, CD_PRINT_PIECES, type CDPrintSpec } from '../packaging/cd/cd-print';
import { buildPrintPdf, rgbaToRgb } from '../packaging/print-pdf';
import { SceneAuthoringAPI } from './scene-authoring-api';
import { AssetLibrary } from './assets/asset-library';
import { OpfsAssetBackend } from './assets/asset-store-opfs';
import type { AssetProvider, AssetRecord } from './assets/asset-types';
import type { AnimLibraryEntry } from './managers/animation-library';
import { PACKAGING_ENABLED } from './persistence/shell-storage';
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Shape } from "../scene-graph/shapes/base/shape";
import { Node } from "../scene-graph/shapes/base/node";
import { recreateNode, type Shape2DRestoreDeps } from "./shape-serializer";
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

/** The duck-typed color surface of legacy 2D shapes (rect/circle/scribble/…): mutable fill + stroke. Narrower
 *  than `any` for setNodeFillColor/getNodeFillColor — shapes that lack a field simply read/write undefined. */
interface ColoredShape { fillColor?: RGBA; strokeColor?: RGBA; }
import { Pattern } from "../scene-graph/shapes/pattern";
import { StampDrawingService } from "./drawing/stamp-drawing-service";
import { PolygonDrawingService } from "./drawing/polygon-drawing-service";
import { PathEditService } from "./drawing/path-edit-service";
import { PathNode, type PathAnchor } from "../scene-graph/shapes/path-node";
import { Polygon, PolygonPreset } from "../scene-graph/shapes/polygon";
import { parseSVGPath } from "../scene-graph/core/svg-path";
import { RasterDrawingService } from "./raster-drawing-service";
import { RasterSelectionService } from "./raster-selection-service";
import { RasterMoveService } from "./raster-move-service";
import { RasterTextService, RasterTextState } from './raster-text-service';
import { RasterLayerManager } from './raster-layer-manager';
import { OnionSkinConfig } from '../animation';
import { ConnectorService, SnapResult } from './connector-service';
import { LayerBlendMode, RasterCompositor, type CompositorLayerInfo } from '../renderer/raster/core/raster-compositor';
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
import { DocumentStateCoordinator, type RestoreIssue } from './persistence/document-state-coordinator';
import { createBlankDocumentPayload } from './persistence/blank-document';
import { PixelFormat, isFormatSupported } from './persistence/pixel-codec';
import { packProject as _packProject, unpackProject as _unpackProject } from './persistence/project-package';
import { runWhenIdle } from './persistence/idle-gate';
import { DeviceRecoveryCoordinator, gpuOnlyFromRestorePayload } from './persistence/device-recovery-coordinator';
import { gpuPixelEpoch, bumpGpuPixelEpoch } from '../renderer/raster/gpu-pixel-epoch';
import { sweepGpuFields, type GpuDeviceStatusInfo, type GpuDeviceStatusListener } from '../renderer/core/gpu-device-recovery';
import { packFrogcart, unpackFrogcart, type FrogcartMeta, type FrogcartManifest, type FrogcartPlayerConfig } from './persistence/frogcart';
import { mat4, vec4 } from 'gl-matrix';
import { Mesh3D, Mesh3DConfig, MeshPrimitive } from '../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D, InstanceOverride } from '../scene-graph/shapes/array-group-3d';
import { Modifier } from '../scene-graph/shapes/modifiers';
import { ParticleEmitter3D } from '../scene-graph/shapes/particle-emitter-3d';
import { Camera3D, Camera3DConfig } from '../renderer/3d/camera-3d';
import { OrbitController, OrbitControllerConfig } from '../renderer/3d/orbit-controller';
import { Renderer3D, PS1Config, DEFAULT_PS1_CONFIG, WOBBLE_PRESET, POCKET_PRESET, FogConfig, DEFAULT_FOG_CONFIG, PostProcessConfig, HighlightStyle } from '../renderer/3d/renderer-3d';
import { STREAM_HITCH, STREAM_HITCH_LIMITS, streamHitchStats, resetStreamHitchStats, type StreamHitchOptions } from '../renderer/3d/stream-hitch';
import { shadowQualitySpec, shadowQualityShown, type ShadowQualityPreset } from '../renderer/3d/shadow-quality';
import type { FogHorizonSettings } from '../renderer/3d/fog-horizon';
import { Material3D, applyMaterialPatch, type SceneWind3D, type SkinRampSettings } from '../renderer/3d/material-3d';
import type { ScriptBehavior } from './scripting/script-types';
import { exportCharacterPreset, applyCharacterPreset, CHARACTER_PRESET_VERSION, type CharacterPresetHost } from './managers/character-preset';
import type { ScriptSnippet } from './scripting/script-context-dts';
import { MeshGeometry } from '../renderer/3d/mesh-generators';
import { booleanMesh, type Tri, type BooleanOp } from '../scene-graph/shapes/mesh-boolean';
import { simplifyGeometry } from '../scene-graph/shapes/mesh-simplify';
import { deriveViewRules } from './managers/view-state';
import { buildCreatureBlobs, buildCreatureSkeleton, creatureEyes } from './managers/creature-generator';

// ── Domain-specific delegate managers ────────────────────────────────
import { RasterManager } from './managers/raster-manager';
import { TextManager } from './managers/text-manager';
import { AnimationManager } from './managers/animation-manager';
import { Scene3DManager } from './managers/scene3d-manager';
import { StructureVersion } from './structure-version';
import { WorldManager } from './managers/world-manager';
import { WorldCrowd } from './managers/world-crowd';
import type { SceneBudget3D, SceneBudgetLimits3D } from './managers/scene3d-manager';
import { groupBoundsStats } from './managers/group-bounds';
import { BuildingManager } from './managers/building-manager';
import { BlockManager } from './managers/block-manager';
import type { BuildingParams, BuildingMeta } from '../world/building';
import { buildScatterLayers, buildScatterSurface, PARK_RULES, type ScatterRules } from '../world/ground-scatter';
import { makeRng } from '../world/util';
import { FoliageManager } from './managers/foliage-manager';
import { VendingManager } from './managers/vending-manager';
import { BikeRackManager } from './managers/bike-rack-manager';
import { BollardManager } from './managers/bollard-manager';
import { LampPostManager } from './managers/lamp-post-manager';
import { TrashBinManager } from './managers/trash-bin-manager';
import { CrateManager } from './managers/crate-manager';
import { VentManager } from './managers/vent-manager';
import { ABoardManager } from './managers/a-board-manager';
import { StallManager } from './managers/stall-manager';
import { CharacterV2Manager, scene3dCharacterV2Host } from '../character-v2';
import type { VendingParams, VendingMeta } from '../world/vending';
import type { ProcTransform, ProceduralObjectManager } from './managers/procedural-object-manager';
import { creator3DTypes, creator3DSchema, creator3DDefaults, type CreatorParamSchema } from './managers/creator-registry';
import { decalQuadGeometry, decalPlacement, type DecalSource, type DecalHit, type V3 } from './managers/decal-geometry';
import { resolveDecalBitmap } from './managers/decal-source';
import { GarpManager, GARP_BLANK_LAYER } from './managers/garp-manager';
import { SignageController, type AddSignageOptions, type SignageImageInfo, type SignageBucketInfo, type SignageAddItem } from './managers/signage-controller';
import { GarpAtlasBuilder } from './managers/garp-atlas-builder';
import { composeAtlasSheet, atlasComposeSupported } from './workers/atlas-lane';
import { garpGridSheetOps, paintSheetOps, vendingLabelSheetOps, type SheetPlan } from './workers/atlas-sheet-ops';
import type { AdvertBucket, ShopImageBucket } from '../world/adverts';
import { mergeObjectStyle, isEmptyStyle, type ObjectStyle, type ObjectStylePatch } from './managers/object-style';
import { pickSkin, type GarpPool } from '../world/garp';
import { VENDING_BRANDS, vendingGarpPool, vendingSkinKey, vendingShellGeometry, vendingProductsGeometry, VENDING_BODY_UV_REGIONS,
    VENDING_LABEL_CELLS, VENDING_LABEL_PAD, vendingLabelCell } from '../world/vending';
import { crateGarpPool, crateSkinKey, CRATE_SKIN_NAMES } from '../world/crate';
import { binGarpPool, binSkinKey } from '../world/trash-bin';
import { ventGarpPool, ventSkinKey } from '../world/vent';
import { aboardGarpPool, aboardSkinKey } from '../world/a-board';
import { stallGarpPool, stallSkinKey } from '../world/stall';
import { posterGarpPool, posterSkinKey } from '../world/poster';
import { warningGarpPool, warningSkinKey } from '../world/road-sign';
import { cityMetresPerUnit as worldMetresPerUnit } from '../world/types';
import { dropRuntimeNodesFromSceneJSON } from './managers/play-auto-player';
import { addZonelessListener, removeZonelessListener } from '../renderer/util/zoneless-listeners';
import type { FoliageParams, FoliageMeta } from '../world/foliage';
import type { FaceBlinkConfig, LegIdleMode } from './managers/scene3d-manager';
import type { EyeParams } from './managers/eye-generator';
import {
    defaultFaceFeatureParams, FACE_EXPRESSION_NAMES, BROW_STYLES, NOSE_STYLES,
    type FaceFeatureParams, type FaceExpressionName, type ExpressionWeights, type BrowStyle, type NoseStyle,
} from './managers/face-features';
import type { HairParams } from './managers/hair-generator';
import { hairStyleList, hairStylePreset } from './managers/hair-generator';
import type { ClothingParams } from './managers/clothing-generator';
import { randomCharacterParams } from './managers/character-randomizer';
import type { AttachmentType, AttachmentParams, AttachmentPlacement } from './managers/attachment-generator';
import type { SnapVizData } from './managers/transform-controller-3d';
import type { Submesh3D } from '../scene-graph/shapes/mesh-3d';
import { DrawingToolManager } from './managers/drawing-tool-manager';
import { debugLog } from './debug-log';
import { MeshPaintManager } from './managers/mesh-paint-manager';
import { MeshEditManager } from './managers/mesh-edit-manager';
import type { UVIsland } from '../scene-graph/shapes/edit-mesh';
import { UVEditorSession, UVCanvasRenderer } from './managers/uv-canvas-renderer';
import type { UVSelectionMode } from './managers/uv-canvas-renderer';
import { UVEditManager } from './managers/uv-edit-manager';
import { UVPaintController, UVBrushSettings } from './managers/uv-paint-controller';
import { UVPaintSessionController } from './managers/uv-paint-session';
import { RasterTextureManager } from '../renderer/raster/raster-texture-manager';
import { LiveTextureMode } from './managers/live-texture-mode';
import { LiveTextManager } from './managers/live-text-manager';
import { DecalManager } from './managers/decal-manager';
import { ShellUIManager } from './managers/shell-ui-manager';
import { UIManager } from './managers/ui-manager';
import { UIFormOverlay } from '../ui/ui-form-overlay';
import { UI_KIT_PRESETS } from '../ui/kit/kit-presets';
import { KIT_SCHEMA, KIT_KIND_LABELS, KIT_COLOR_TOKENS, KIT_ANCHORS, KIT_INTROS } from '../ui/kit/kit-schema';
import { UI_KIT_TRANSITIONS, UI_KIT_CLIPS, type UIKitWidget, type UIKitKind, type UIKitClip, type UIKitTransitionType, type UIKitPropSpec } from '../ui/kit/kit-types';
import { UISoundPlayer } from '../ui/ui-sound';
import type { UIStateMachine, UILayerData, UIEvent, UIValue, ShapeInteractionProps, TransitionAnimation, HtmlFormElement } from '../ui/ui-types';
import { MeshEditPointerController, type MeshEditSelectionMode } from './managers/mesh-edit-pointer-controller';
import { isPointerEventClaimed } from '../renderer/util/pointer-claims';
import { PersistenceManager as PersistenceManagerDelegate } from './managers/persistence-manager';
import type { ManagerContext } from './managers/manager-context';
import type { ResolutionScaleSettings, ResolutionScaleState } from '../renderer/core/resolution-scaler';
import type { TemporalAASettings, TemporalAAState } from '../renderer/3d/temporal-aa';
import type { CityLodStats } from './managers/world-lod-settings';
import type { SimLodSettings, SimLodStats } from '../world/sim-lod';
import { EphemeraService } from './ephemera/ephemera-service';
import { EphemeraOverlay } from './ephemera/ephemera-overlay';
import { GROUND_SURFACES, resolveGroundRecipe, type GroundSurfaceName, type GroundSurfaceSpec } from '../world/ground-surfaces';
import type { EphemeraElement, EphemeraElementSheet, IEphemeraGenerator, EphemeraCategory, EphemeraPlacement } from './ephemera/ephemera-types';
import {
    getTouchSmoothing as _getTouchSmoothing, setTouchSmoothing as _setTouchSmoothing,
    getStrokePrediction as _getStrokePrediction, setStrokePrediction as _setStrokePrediction,
    type TouchSmoothing,
} from '../renderer/raster/brushes/brush-input-settings';
import { runStrokePredictionSelfTest as _runStrokePredictionSelfTest, type StrokePredictionSelfTestReport } from '../renderer/raster/brushes/stroke-prediction-selftest';
import { markRasterCompositeDirty as _markRasterCompositeDirty } from '../renderer/raster/core/raster-composite-dirty';
import { rasterContentSeq as _rasterContentSeq } from '../renderer/raster/raster-content-version';
import { vectorSceneObject as _vectorSceneObject } from './persistence/vector-scene-json';
import {
    setRenderDebug as _setRenderDebug, getRenderDebug as _getRenderDebug, encodeRealFramePNG as _encodeRealFramePNG,
    RENDER_DEBUG_FLAGS, type RenderDebugFlags, type RealScreenshot,
} from '../renderer/3d/render-debug';

// Re-exported so existing importers (and the host) keep one obvious entry point; the table itself lives
// in src/world so the CITY generator can read it too (services may import world, never the reverse).
export { GROUND_SURFACES, type GroundSurfaceName, type GroundSurfaceSpec };

/** The CreatorStage's neutral studio background — a soft light-grey vertical gradient (product-shot look).
 *  A local copy of packaging's STUDIO_STAGE_BG, typed as ArmatureBgOptions, so the stage stays decoupled
 *  from the packaging module. */
const CREATOR_STAGE_BG: import('../types/armature-3d').ArmatureBgOptions = {
    mode: 'gradient',
    color1: [0.945, 0.950, 0.965, 1],
    color2: [0.775, 0.795, 0.835, 1],
};

/** Engine-roadmap step 3 A/B switches (see ShapeManager.setStep3Options3D). */
export interface Step3Options3D {
    incrementalTileBounds: boolean; cachedGroupBounds: boolean; collisionCells: boolean; runBoxes: boolean;
    slicedUploads: boolean; crowdCellsInWorker: boolean; crowdPrefetchLead: boolean; overlaysFogCulled: boolean;
    backdropFollowsWindow: boolean; refreshReattached: boolean; orthoViewCentre: boolean; pruneGroupBoxCache: boolean;
    /** Step 3b (performance-plan §P13 "Step 3b"). */
    incrementalCollisionGrid: boolean; slicedReassembly: boolean; packInstances: boolean; scopedBackdropLod: boolean;
}
/** Step 2 A/B switches (see ShapeManager.setFrameScanOptions3D). */
export interface FrameScanOptions3D {
    splitRenderList: boolean; incrementalRenderList: boolean; incrementalDrawOrder: boolean; prewarmNewOnly: boolean;
    cachedSkeletonSync: boolean; cachedRenderStats: boolean; iterativeSceneWalk: boolean; coalesceStructureBumps: boolean;
}

class ShapeManager {
    private shapeFactory: ShapeFactory;
    public sceneGraph!: SceneGraph;
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
    public vending!: VendingManager;
    public bikeRacks!: BikeRackManager;
    public bollards!: BollardManager;
    public lampPosts!: LampPostManager;
    public trashBins!: TrashBinManager;
    public crates!: CrateManager;
    public vents!: VentManager;
    public aBoards!: ABoardManager;
    public stalls!: StallManager;
    /** Character v2 (docs/specs/character-v2.md, docs/ui/character-v2.md): frozen Persona base body + blend-shape sliders.
     *  `sm.characterV2.create()` / `.setSlider(id, name, v)` / `.getSliders(id)` / `.toHandle(id)`; console: `salsaCharV2`. */
    public characterV2!: CharacterV2Manager;
    /** typeId → its manager, for the generic creator dispatch (createCreator3D / setCreatorParams3D / …). */
    private readonly _creators = new Map<string, ProceduralObjectManager<unknown, unknown>>();
    public drawing!: DrawingToolManager;
    public persist!: PersistenceManagerDelegate;
    public meshPaint!: MeshPaintManager;
    public meshEdit!: MeshEditManager;
    public shell!: ShellUIManager;
    /** UI System (docs/specs/ui-system.md) — interactive menus/HUDs via a pure state machine. Phase 1: core interaction. */
    public ui!: UIManager;
    private _meshEditPointerController!: MeshEditPointerController;
    public readonly _uvSessions = new Map<string, UVEditorSession>();
    private _uvEdit!: UVEditManager;
    private _liveTexture!: LiveTextureMode;
    private _liveText!: LiveTextManager;   // LiveTextNode management (extracted); constructed in the ctor (needs the ManagerContext)
    private _decalMgr!: DecalManager;      // Decals Mode A (floating quads + place-tool), extracted; ctor-constructed
    /** The UV/3D paint SESSION subsystem (audit C7): owns the shared controller, per-mesh paint
     *  textures/canvases, and character↔packaging session state. Lazy (needs `this`). */
    private _uvPaintSess?: UVPaintSessionController;
    public get uvPaint(): UVPaintSessionController { return this._uvPaintSess ??= new UVPaintSessionController(this); }
    private get _uvPaintCanvases() { return this.uvPaint.canvases; }
    /** Per-mesh GPU paint texture (paintable + sampleable) backing the mesh diffuse. */
    private get _uvPaintTextures() { return this.uvPaint.textures; }
    /** UV-paint textures on PROCEDURAL prop children, pending re-apply AFTER the props regenerate on load (keyed
     *  `containerId:childName`). Populated during the meshTextures restore, consumed after restoreProceduralFromSave3D. */
    private readonly _pendingProcTextures = new Map<string, ArrayBuffer>();
    /** Serializes garment paint RE-TINTs per rig key (so a fast colour drag can't desync the moving
     *  background colour — each re-tint applies in order, after the previous one lands). */
    private readonly _retintChain = new Map<string, Promise<unknown>>();
    public get _uvPaintController(): UVPaintController | undefined { return this.uvPaint.controller; }
    /** WHICH kind of paint session is live on the single shared `_uvPaintController`. There is only one
     *  controller, so a 'character' session (garment/hair/decal, keyed by mesh id) and a 'packaging'
     *  session (the box dieline layer, keyed by layer id) can never coexist — but their teardown state
     *  (`_uvPaintDoubleSided`, `_uvPaintOpenedEditor`) is per-mesh and DIFFERENT, so a blind disarm/arm
     *  applied the wrong session's restore to the wrong mesh. This tag makes the owner explicit: a package
     *  disarm must only tear down a package session, and each arm fully exits any prior session first. */
    public get _paintSessionKind(): 'character' | 'packaging' | null { return this.uvPaint.kind; }

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
    public pathEditService!: PathEditService;
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
    public webgpuRenderer!: WebGPURenderer;
    public rasterLayerManager?: RasterLayerManager;
    /** Canonical document pixel size set via setDocumentSize(). null = infinite canvas. */
    private _documentSizePx: { w: number; h: number } | null = null;
    private floodFillEngine?: FloodFillEngine;
    private textEffectEngine?: TextEffectEngine;
    private persistence?: DocumentPersistence;
    private currentDocId: string = 'default';
    private currentDocName: string = 'Untitled';
    private _isRestoring = false;
    private _ephemera: EphemeraService = new EphemeraService();

    // ── Ephemera SVG overlay (live non-destructive placement rendering) — extracted to EphemeraOverlay ──
    private _ephemeraOverlay!: EphemeraOverlay;   // constructed in the ctor (needs the ManagerContext)

    /** Warm all 3D render pipelines in the background now (createRenderPipelineAsync, off the main thread). Safe to
     *  call from the Frogmarks SHELL at mount — the device persists across the shell→illustration route, so every
     *  illustration open (including the first) then hits already-hot pipelines. Idempotent. See
     *  docs/specs/pipeline-warmup.md. */
    public bootAndWarm(): void { this.webgpuRenderer?.warmPipelinesNow(); }

    // ── P2.3 shader-compile status (docs/ui/performance.md) ──
    /** Shader/pipeline compile status for a "Preparing shaders… n/m" toast: `pending` queued or compiling, `total`
     *  requested so far, `compiled`, `failed`, `waitingDraws` (pending ones a frame already skipped — content is
     *  visibly missing while > 0), `ready` (= pending 0). Before the GPU device exists: all zero, ready. */
    public getPipelineWarmup3D(): PipelineWarmupStatus {
        const dev = this._deviceOrNull();
        const c = dev ? GPUPipelineCache.peek(dev) : null;
        return c ? c.status() : { pending: 0, total: 0, compiled: 0, failed: 0, waitingDraws: 0, ready: true };
    }
    // ── P3.1 worker-job progress (docs/ui/performance.md §Worker jobs) — for a host loading overlay ──
    /** Live background-work snapshot: `{ queued, running, done, total, active, jobs: [{ id, kind, label, priority, p,
     *  running }] }`. `done/total` count since the service last went idle (a loading fraction); `label` is a short
     *  human string ('Building city', 'Updating city', 'City tile', 'Generating character', 'Packing images', 'Saving'). */
    public getWorkerJobProgress3D(): WorkerJobProgress { return getWorkerJobService().progress(); }
    /** Subscribe to worker-job progress (coalesced, ≤ 1 call per microtask; fires on enqueue / start / progress /
     *  finish, then once with `active: false` when everything settles). Returns an unsubscribe function. */
    public onWorkerJobProgress3D(listener: (p: WorkerJobProgress) => void): () => void { return getWorkerJobService().onProgress(listener); }
    /** Diagnostics: live workers per lane, the hardware cap, totals and per-kind timings (runs / worker / fallback / ms). */
    public getWorkerJobStats3D(): WorkerJobStats { return getWorkerJobService().stats(); }

    /** Subscribe to compile-status changes (coalesced, at most one call per microtask). Safe to call before the
     *  device is ready — it attaches once it is. Returns an unsubscribe function. */
    public onPipelineWarmup3D(listener: (s: PipelineWarmupStatus) => void): () => void {
        let off: (() => void) | null = null, dead = false;
        const attach = () => {
            const dev = this._deviceOrNull();
            if (dead || !dev) return;
            const c = GPUPipelineCache.for(dev);
            off = c.onStatus(listener);
            listener(c.status());
        };
        if (this._deviceOrNull()) attach();
        else void this.webgpuRenderer?.whenReady().then(attach);
        return () => { dead = true; off?.(); };
    }
    /** Resolves when no pipeline is queued or compiling (e.g. before a scripted capture). */
    public async whenPipelinesReady3D(): Promise<void> {
        await this.webgpuRenderer?.whenReady();
        const dev = this._deviceOrNull();
        if (dev) await GPUPipelineCache.for(dev).whenIdle();
    }
    private _deviceOrNull(): GPUDevice | null {
        try { return (this.webgpuRenderer?.getDevice() as GPUDevice | undefined) ?? null; } catch { return null; }
    }

    // --- rAF glue to the renderer ---
    public scheduleRender() { this.webgpuRenderer?.scheduleRender(); }
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

            // Path NODE EDITOR (docs/specs/vector-paths.md P2) — edit committed PathNode anchors/handles.
            this.pathEditService = new PathEditService(
                this.interactionService, this.sceneGraph, this.shapeFactory
            );
            // Double-click a committed Path on canvas enters the editor engine-side — EXCEPT while the
            // pen tool is enabled (its dblclick means "close the polygon", not "edit").
            this.pathEditService.autoEnterGate = () => !(this.polygonDrawingService?.isEnabled ?? false);

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
            sceneStructureVersion: () => this.getSceneStructureVersion(),
            bumpSceneStructure: () => { this._bumpStructure(); this.scheduleRender(); },
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
        // Ephemera SVG overlay + placement interaction (extracted). Facade keeps the `_ephemera` registry
        // delegators + shared `_activeVectorLayerId` + rasterize-to-layer glue; this owns overlay render + hit-test.
        this._ephemeraOverlay = new EphemeraOverlay(ctx, {
            ephemera: this._ephemera,
            markPackageVectorLayerDirty: (layerId) => this._pkgComposite.vectorLayerDirty(layerId),
            meshEditFocusHidesContent: () => this.scene3d?.meshEditFocusHidesContent?.() ?? false,
        });
        // Let the free3D artboard-texture capture composite ephemera (a DOM overlay, not in the GPU frame) onto the
        // captured raster+vectors canvas, framed to the artboard — so the quad shows all three layers.
        ctx.webgpuRenderer.setArtboardEphemeraCompositor((canvas, outW, outH) => {
            const b = ctx.webgpuRenderer.getIllustrationBounds?.();
            const c2d = canvas.getContext('2d') as CanvasRenderingContext2D | null;
            if (b && c2d && this._ephemeraOverlay?.hasVisiblePlacements()) this._ephemeraOverlay.rasterizePlacements(c2d, b.width, b.height, outW, outH);
        });
        // LiveTextNode management (extracted). Facade keeps the TextEffectEngine + custom-shader methods +
        // thin delegators; this owns create/style/edit/flatten + the edit-session state.
        this._liveText = new LiveTextManager(ctx, {
            getActiveVectorLayerId: () => this._activeVectorLayerId,
            getTextEffectEngine: () => this.getTextEffectEngine(),
        });
        // Decals Mode A (floating-quad decals + interactive place-tool), extracted. Facade keeps Mode B (UV-coupled),
        // cityMetresPerUnit, and the shared _resolveDecalBitmap bridge.
        this._decalMgr = new DecalManager(ctx, { scene3d: this.scene3d, ephemera: this._ephemera, uvPaintTextures: this._uvPaintTextures });
        this.world = new WorldManager(this.scene3d);
        this.scene3d.playWetness = () => this.world.playWetness;   // Play landing dust: splashes on a wet street (2026-10-04)
        // P5.W4: a city build starting = the built-in GARP placeholder skins are needed in a few seconds (its reassembly
        // instantiates vending / clutter) → pre-encode their PNGs OFF-THREAD meanwhile (no-op once done / registered).
        this.world.onCityBuildStateChange.subscribe(({ building }) => { if (building) this._prewarmGarpPlaceholders(); });
        // ADVERTS (docs/ui/garp.md §Adverts): every city build pulls the signage catalog from the GARP library.
        this.world.setAdvertsProvider(() => this._garp.signage.catalog());
        // Play is scale-correct in a city (Round 4): the controller's metre defaults (height, speeds, jump, camera
        // follow) and the auto default player's size convert with the city's metres-per-unit. null = no city = 1.
        this.scene3d.setPlayMetresPerUnitProvider(() => (this.world.getCityContainerId() ? this.cityMetresPerUnit() : null));
        // GARP (docs/specs/city-props-garp.md §2): scene instantiation resolves an instanced layer's per-copy skin
        // NAME → dedicated-GARP-atlas layer through this. It lazily registers the vending pool on first use (sync →
        // layers are assigned in the SAME call the city instantiates in, so fascias get correct textureIndex even
        // though the atlas bitmaps upload asynchronously afterwards).
        this.scene3d.setGarpLayerResolver((pool, slot, x, z, seed, skin) => {
            if (pool === 'salsa/vending') this._ensureVendingGarp();   // idempotent (missing OR old-version → re-seed)
            if (pool === 'salsa/crate') this._ensureCrateGarp();       // built-in crate-label placeholders
            this._ensureClutterGarp(pool);                             // bin/vent/a-board/stall/poster placeholders
            if (skin) return this._garp.layerForSkinName(pool, skin, slot);   // explicit skin (non-city consumers)
            const p = this._garp.getPool(pool);                               // else position-hash over the RUNTIME pool
            const chosen = p ? pickSkin(p, x, z, seed) : null;               //  → user-added variants are eligible
            return chosen ? this._garp.skinLayer(pool, chosen, slot) : GARP_BLANK_LAYER;
        });
        this.buildings = new BuildingManager(this.scene3d);   // Building Creator (constructed AFTER world so its transform-sync registers second)
        this.blocks = new BlockManager(this.scene3d);         // Neighborhood Blocks (many buildings + cross-building instancing)
        this.foliage = new FoliageManager(this.scene3d);      // Foliage Creator (freestanding foliage)
        this.vending = new VendingManager(this.scene3d);      // Vending Creator (a standalone editable machine)
        this.bikeRacks = new BikeRackManager(this.scene3d);   // Bike Rack Creator (minimal-manager template)
        this.bollards = new BollardManager(this.scene3d);     // Bollard Creator
        this.lampPosts = new LampPostManager(this.scene3d);   // Lamp Post Creator (banners reuse windSway)
        this.trashBins = new TrashBinManager(this.scene3d);   // Trash Bin Creator (street clutter, GARP-ready)
        this.crates = new CrateManager(this.scene3d);         // Crate Stack Creator (produce/shipping clutter)
        this.vents = new VentManager(this.scene3d);           // Ground Vent Creator (grate / box)
        this.aBoards = new ABoardManager(this.scene3d);       // A-Board Creator (folding sidewalk sign)
        this.stalls = new StallManager(this.scene3d);         // Produce Stall Creator (market stall + awning)
        this.characterV2 = new CharacterV2Manager(scene3dCharacterV2Host(this.scene3d));   // Character v2 (params-only marker persistence)
        // ★ Generic creator dispatch: typeId → its ProceduralObjectManager, so ONE host API + ONE
        // schema-driven panel (docs/specs/creator-modes.md §5.2) drives every procedural creator. Register a
        // new creator here + its schema in creator-registry.ts and it works through createCreator3D/… with no
        // per-type host code. The keys MUST match the typeIds in CREATOR_3D_DEFS.
        this._creators.set('vending', this.vending);
        this._creators.set('foliage', this.foliage);
        this._creators.set('building', this.buildings);
        this._creators.set('bike-rack', this.bikeRacks);
        this._creators.set('bollard', this.bollards);
        this._creators.set('lamp-post', this.lampPosts);
        this._creators.set('trash-bin', this.trashBins);
        this._creators.set('crate', this.crates);
        this._creators.set('vent', this.vents);
        this._creators.set('a-board', this.aBoards);
        this._creators.set('stall', this.stalls);
        // New creator objects + blocks START with the Environment style (each then keeps its own, persisted).
        const envDefault = () => this.scene3d.environmentStyle;
        for (const m of this._creators.values()) m.defaultStyle = envDefault;
        this.blocks.defaultStyle = envDefault;
        // DEV harness for the generic creator system + focus stage (try it before Frogmarks wires the panel):
        //   salsaCreator.types()                 → registered typeIds
        //   salsaCreator.add('vending')          → create + enter the focus stage, returns the id
        //   salsaCreator.set(id, { cansPerShelf: 6 })  → live-edit
        //   salsaCreator.stage(id) / .exit()     → enter / leave the focus stage
        //   salsaCreator.schema('vending')       → the panel schema
        if (typeof window !== 'undefined') {
            (window as unknown as { salsaCreator?: unknown }).salsaCreator = {
                types: () => this.creatorTypes3D(),
                schema: (typeId: string) => this.creatorParamSchema3D(typeId),
                add: (typeId: string, params?: Record<string, unknown>) => {
                    const r = this.createCreator3D(typeId, params);
                    if (r) this.enterCreatorStage3D(r.id);
                    return r?.id ?? null;
                },
                set: (id: string, params: Record<string, unknown>) => this.setCreatorParams3D(id, params),
                get: (id: string) => this.getCreatorParams3D(id),
                stage: (id: string) => this.enterCreatorStage3D(id),
                exit: () => this.exitCreatorStage3D(),
                remove: (id: string) => this.removeCreator3D(id),
            };
            // DEV harness for decals (docs/specs/decals.md, Mode A). `demo` drops one at eye height facing +Z
            // so you can see it render + texture without a raycast; real placement is placeDecalAtScreen3D on
            // a canvas click. `ephemera()` lists source typeIds to try.
            (window as unknown as { salsaDecal?: unknown }).salsaDecal = {
                demo: (typeId: string, params: Record<string, unknown> = {}) =>
                    this.placeDecal3D({ kind: 'ephemera', typeId, params }, { hitPoint: [0, 1.5, 0], faceNormal: [0, 0, 1] }, { size: 1 }),
                image: (dataUrl: string) =>
                    this.placeDecal3D({ kind: 'image', dataUrl }, { hitPoint: [0, 1.5, 0], faceNormal: [0, 0, 1] }, { size: 1 }),
                // The TOOL: click a wall to PRIME (outline+ghost), click again to place. `size` is world units
                // (~0.15 ≈ a 2 m poster in the 15 m/unit city). salsaDecal.tool(salsaDecal.ephemera()[0]); salsaDecal.off()
                tool: (typeId: string, params: Record<string, unknown> = {}, size = 0.15) => this.enterDecalPlaceMode3D({ kind: 'ephemera', typeId, params }, { size }),
                imageTool: (dataUrl: string, size = 0.15) => this.enterDecalPlaceMode3D({ kind: 'image', dataUrl }, { size }),
                off: () => this.exitDecalPlaceMode3D(),
                ephemera: () => this._ephemera.getCategories().flatMap((c) => this._ephemera.getGeneratorsByCategory(c.id).map((g) => g.typeId)),
                list: () => this.listDecals3D(),
                size: (id: string, s: number) => this.setDecalSize3D(id, s),
                rotate: (id: string, r: number) => this.setDecalRotation3D(id, r),
                remove: (id: string) => this.removeDecal3D(id),
                // Mode B (baked): stamp a decal INTO a mesh's texture (curves/wraps, no z-fight). stampDemo drops a
                // grey box and bakes an ephemera decal onto its front-face UV centre. salsaDecal.stampDemo(salsaDecal.ephemera()[0])
                stampDemo: async (typeId: string, params: Record<string, unknown> = {}) => {
                    const box = this.createBox3D(0, 1, 0, 1.4, 1.4, 1.4, { roughness: 1 });
                    box.setDiffuseColor(0.58, 0.60, 0.66, 1);
                    await this.stampDecalAtUV3D(box.id, { kind: 'ephemera', typeId, params }, 0.5, 0.5, { size: 0.4 });
                    return box.id;
                },
                stampUV: (meshId: string, typeId: string, u = 0.5, v = 0.5, size = 0.3) =>
                    this.stampDecalAtUV3D(meshId, { kind: 'ephemera', typeId, params: {} }, u, v, { size }),
            };
            // DEV harness for SSAO (docs/specs/ssao.md). `debug()` toggles it on + shows the raw AO buffer — the
            // ONLY reliable way to verify occlusion (composited into ambient it just reads as "slightly dimmer").
            // Watch for: NO bright halos at building silhouettes (normal reconstruction) + NO near→far bleed (blur).
            //   salsaSSAO.debug()  → grey AO view; salsaSSAO.on(); salsaSSAO.off(); salsaSSAO.set({radius:0.9})
            (window as unknown as { salsaSSAO?: unknown }).salsaSSAO = {
                on:    (cfg: Record<string, number> = {}) => this.scene3d.setSSAO3D(true, cfg),
                off:   () => { this.scene3d.setSSAODebug3D(false); this.scene3d.setSSAO3D(false); },
                set:   (cfg: Record<string, number>) => this.scene3d.setSSAO3D(true, cfg),
                debug: (on = true) => { this.scene3d.setSSAO3D(true); this.scene3d.setSSAODebug3D(on); },
                config: () => this.scene3d.ssao3D,
            };
            // DEV harness for GARP (docs/specs/city-props-garp.md §2). `demo(n)` drops a ROW of n instanced boxes,
            // each wearing a position-hashed skin from a 2-skin ephemera pool — verifies the dedicated GARP atlas +
            // shader select + per-instance textureIndex end to end. `pools()` lists registered pools.
            //   salsaGarp.demo(6)   → returns the source mesh id; adjacent boxes should show DIFFERENT textures
            (window as unknown as { salsaGarp?: unknown }).salsaGarp = {
                demo: (n = 6) => this.garpDemo3D(n),
                vending: (n = 6) => this.garpVendingDemo3D(n),   // the multi-slot COORDINATED consumer (fascia+products)
                pools: () => this._garp.listPools(),
                rebuild: (w = 512, h = 512) => this.rebuildGarpAtlas3D([w, h]),
                // Add a user vending fascia variant from an image data URL, then REGENERATE the city to see it
                // (selection is position-hashed over the runtime pool). e.g. salsaGarp.addVendingSkin('coke', myDataUrl)
                // (body only — the backdrop + can labels fall back to the pool defaults; add cans with packCans/pickCans)
                addVendingSkin: (name: string, dataUrl: string) =>
                    this.addGarpSkin3D('salsa/vending', name, { body: { kind: 'image', dataUrl } }),
                // Can designs → a skin's `labels` sheet (1–8 image data URLs), then regenerate the city.
                packCans: (skin: string, dataUrls: string[]) => this.packVendingCanLabels3D(skin, dataUrls),
                // Same, from a FILE PICKER (multi-select PNGs): salsaGarp.pickCans('red') → then regenerate the city.
                pickCans: (skin: string) => new Promise<string[]>((resolve) => {
                    const input = document.createElement('input');
                    input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
                    input.onchange = async () => {
                        const files = [...(input.files ?? [])];
                        const urls = await Promise.all(files.map((f) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); })));
                        resolve(await this.packVendingCanLabels3D(skin, urls));
                    };
                    input.click();
                }),
                labelTemplate: () => this.vendingLabelTemplate3D(),   // a PNG data URL of the sheet layout
                // Save a paint-preview mesh (from paintBody) as a new variant, using its tagged pool/slot. Regenerate
                // the city to see it. (Bridge 2 — the same call the UV Paint "Save as skin variant" button makes.)
                saveVendingSkin: (meshId: string, name: string) => this.saveMeshAsGarpSkin3D(meshId, name),
                removeVendingSkin: (name: string) => this.removeGarpSkin3D('salsa/vending', name),   // then regenerate the city
                // ADVERTS: salsaGarp.demoAdverts() adds generated test images to every bucket; pickAdverts('auto')
                // opens a file dialog; adverts() lists; clearAdverts() resets. The city rebuilds by itself.
                demoAdverts: async () => (await this.addSignageImages3D(SignageController.demoImages().map((d) => ({ bucket: d.bucket, source: d.dataUrl, opts: { lit: d.lit } })))).map((r) => r.id),   // ONE pack/atlas/city rebuild
                pickAdverts: (bucket: AdvertBucket | 'auto' = 'auto') => new Promise<(string | null)[]>((resolve) => {
                    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
                    inp.onchange = async () => {
                        const items: SignageAddItem[] = [];
                        for (const f of Array.from(inp.files ?? [])) {
                            const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });
                            items.push({ bucket, source: url, opts: { name: f.name } });
                        }
                        resolve((await this.addSignageImages3D(items)).map((r) => r.id));   // batched: one rebuild
                    };
                    inp.click();
                }),
                adverts: () => this.listSignageImages3D().map(({ dataUrl: _d, ...r }) => r),
                clearAdverts: () => this.clearSignage3D(),
                // SHOP WINDOWS (C4): generated shop-interior + poster test images; shopImages() lists; clearShopImages() resets.
                demoShopImages: async () => (await this.addSignageImages3D(SignageController.demoShopImages().map((d) => ({ bucket: d.bucket, source: d.dataUrl, opts: { lit: d.lit } })))).map((r) => r.id),
                shopImages: () => this.listShopImages3D().map(({ dataUrl: _d, ...r }) => r),
                clearShopImages: () => this.clearShopImages3D(),
                // Bridge 1 — paint the body skin on the ACTUAL machine shell (its unwrap). Returns the mesh id; paint
                // it (3D + UV pane), then salsaGarp.saveVendingSkin(id, 'name'), or salsaGarp.cancelPaint().
                paintBody: () => this.paintVendingBody3D(),
                cancelPaint: () => this.cancelGarpPaint3D(),
            };
        }

        // Shell UI — WebGPU dashboard home screen. Its Illustrations
        // dashboard is a view over existing documents, so wire a document
        // source that bridges to DocumentPersistence (project id === docId).
        this.ui = new UIManager(ctx);
        // Route canvas pointer input to the UI System (no-op unless interactive preview is enabled).
        this.webgpuRenderer.setUIPointerHandler({
            onDown: (x, y, cx, cy) => this.ui.pointerDown(x, y, cx, cy),
            onMove: (x, y, cx, cy) => this.ui.pointerMove(x, y, cx, cy),
        });
        this.webgpuRenderer.setUIKeyHandler((key, shift) => this.ui.handleKey(key, shift));
        this.webgpuRenderer.setUIScrimProvider(() => this.ui.getActiveOverlay());
        this.ui.attachKitOverlay(this.webgpuRenderer);   // UI kit: screen-space HUD/menu widgets, post-process immune
        // World-control effects (Phase 3): freezeWorld/setWorldSpeed scale the 3D world clock + all animation
        // players; setCamera moves the 3D camera. 2D keyframe playback is host-driven — hosts observing the
        // effectHook can pause their own timelines.
        this.ui.setWorldControlHook({
            setFrozen: (frozen) => this.scene3d.uiSetWorldSpeed3D(frozen ? 0 : 1),
            setSpeed: (speed) => this.scene3d.uiSetWorldSpeed3D(speed),
            setCamera: (position, target, durationMs) => this.scene3d.uiSetCamera3D(position, target, durationMs),
            playAnimation: (targetId, clipId, loop, blendFrames) => this._uiPlayAnimation(targetId, clipId, loop, blendFrames),
            stopAnimation: (targetId) => { this._uiClipPlayers.get(targetId)?.player.stop(); },
            pauseAnimation: (targetId) => { this._uiClipPlayers.get(targetId)?.player.pause(); },
            seekAnimation: (targetId, frame) => this._uiSeekAnimation(targetId, frame),
        });
        // Delete/Backspace deletes the selected 2D shapes (the renderer owns the key listener; this owns teardown).
        // A host with its own Edit › Delete routing takes the key over via setDeleteKeyHandler (same guards apply).
        ctx.webgpuRenderer.setDeleteSelectedHandler(() => this._runDeleteKey());
        // Ctrl+D duplicates them (serializer round-trip + undo recording live here). A host with its own Edit › Duplicate
        // (3D meshes through the 3D duplicate) takes the key over via setDuplicateKeyHandler (same guards apply).
        ctx.webgpuRenderer.setDuplicateSelectedHandler(() => this._runDuplicateKey());
        // Canvas swap (Frogmarks route change): re-bind the manager-owned canvas listeners — the polygon pen
        // tool and the path node editor attach to the OLD canvas otherwise and silently go dead.
        ctx.webgpuRenderer.onCanvasReinitialized = () => {
            this.polygonDrawingService?.reinitializeEventListeners();
            this.pathEditService?.reinitializeEventListeners();
            // 3D orbit controller + armature bone-drag listeners bound to the OLD canvas — re-bind them too, else
            // free3D pan/zoom/orbit is dead after a Shell→illustration navigation (canvas swap) until a mode toggle.
            this.scene3d.reattachCanvasListeners3D();
        };
        // Vector-layer stamping at the FACTORY choke point: every 2D creation path (this facade's creators,
        // sm.drawing.*, and all drag-to-draw services) gets the active-vector-layer (?? document default) stamp.
        this.shapeFactory.setLayerStampProvider(() => this._targetVectorLayerId());
        // 3D-mesh UI targets: pick a mesh at the canvas point (CSS px + CSS-space canvas size) → its node id.
        this.ui.setMeshPicker((cx, cy) => {
            const canvas = this.interactionService.canvas;
            return this.scene3d.pick3D(cx, cy, canvas.clientWidth, canvas.clientHeight)?.meshId ?? null;
        });
        // Ephemera placements as interactive UI targets (they aren't scene-graph nodes — the id is the placement id).
        this.ui.setEphemeraAdapter({
            pickAt: (wx, wy) => this._ephemeraOverlay.hitTestEphemeraPlacement(wx, wy)?.placementId ?? null,
            has: (id) => this._findPlacementById(id) !== null,
            setVisible: (id, visible) => { const f = this._findPlacementById(id); if (f) { this._ephemera.updatePlacement(f.layerId, id, { visible }); this.scheduleRender(); } },
            isVisible: (id) => this._findPlacementById(id)?.placement.visible ?? true,
        });
        // Play-mode trigger volumes auto-dispatch into the active UI state machine (enterVolume/exitVolume
        // transitions → goToState / setVariable / playAnimation / … with zero host glue), then forward the raw
        // event to any host handler set via setTriggerHandler3D. See docs/specs/play-mode.md.
        this.scene3d.setTriggerHandler3D((e) => {
            if (e.type === 'enter') this.ui.volumeEnter(e.id); else this.ui.volumeExit(e.id);
            this._playTriggerHostHandler?.(e);
        });
        // "Use" a nearby interactable → dispatch an `interact` transition into the active UI state machine, then
        // forward to any host handler.
        this.scene3d.setInteractHandler3D((id) => {
            this.ui.interact(id);
            this._playInteractHostHandler?.(id);
        });
        // Publish player movement as UI-machine variables each Play tick (§4.3). Change-gated (the runtime
        // already ignores unchanged/undeclared, but rounding speed avoids re-firing float-threshold transitions
        // every frame). A creator declares `player.speed` etc. and conditions transitions on them.
        // The change-gate cache is per (run, layer): a value cached in run 1 / on another layer was never re-published,
        // so a transition conditioned on e.g. player.grounded=true never fired in run 2 (bug-hunt 2026-10-01).
        const resetPlayerParams = () => { this._lastPlayerParams = { speed: -1, moving: false, grounded: false, airborne: false, rising: false }; this._lastPlayerParamsLayer = null; };
        this.scene3d.onPlayStateChanged.subscribe(resetPlayerParams);
        this.scene3d.setPlayerParamHandler((loco) => {
            const active = this.ui.activeUILayerId;
            if (!active) return;
            if (active !== this._lastPlayerParamsLayer) {
                resetPlayerParams(); this._lastPlayerParamsLayer = active;
                // first tick on this layer: publish the booleans too (the false defaults above would gate them out)
                for (const k of ['moving', 'grounded', 'airborne', 'rising'] as const) { this.ui.setUIVariable(active, `player.${k}`, loco[k]); this._lastPlayerParams[k] = loco[k]; }
            }
            const speed = Math.round(loco.planarSpeed * 10) / 10;
            if (speed !== this._lastPlayerParams.speed) { this.ui.setUIVariable(active, 'player.speed', speed); this._lastPlayerParams.speed = speed; }
            const set = (k: 'moving' | 'grounded' | 'airborne' | 'rising') => {
                if (loco[k] !== this._lastPlayerParams[k]) { this.ui.setUIVariable(active, `player.${k}`, loco[k]); this._lastPlayerParams[k] = loco[k]; }
            };
            set('moving'); set('grounded'); set('airborne'); set('rising');
        });
        // Script Behaviors: bridge ctx.getVar/setVar/emit to the ACTIVE UI layer's machine, so scripts and the UI
        // state machine share variables (a script computes; a machine transition reacts — and vice-versa). emit surfaces
        // a custom UIEvent to onUIEvent subscribers. See docs/specs/script-behaviors.md §9.
        this.scene3d.setScriptVarBridge({
            get: (name) => { const l = this.ui.activeUILayerId; return l ? this.ui.getUIVariable(l, name) : null; },
            set: (name, v) => { const l = this.ui.activeUILayerId; if (l) this.ui.setUIVariable(l, name, v); },
            emit: (event) => this.ui.emitCustom(event),
        });
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
        // A sync that RE-POINTS a mesh at a different GPUTexture also evicts the 3D renderer's
        // cached texture bind group for that mesh, so the very next draw rebuilds it against the
        // new object (the cache self-validates by texture ref too — this closes any stale window).
        this._liveTexture.onRepoint = (meshId) => {
            this.webgpuRenderer?.peekRenderer3D()?.evictTextureBindGroup(meshId);
        };
        // Packaging box-panel composite machinery (extracted). Needs the live-texture links (panels sample the
        // composite) + ephemera (vector-proxy render reads placements); both are constructed above / field-init.
        this._pkgComposite = new PackagingComposite(ctx, { liveTexture: this._liveTexture, ephemera: this._ephemera });
        this._initDeviceRecovery();   // GPU device-lost recovery (docs/ui/device-recovery.md)
        this._meshEditPointerController = new MeshEditPointerController(
            this.scene3d,
            this.meshEdit,
            (cmd) => this.scene3d.pushCommand3D(cmd),
            () => ctx.scheduleRender(),
            { isAdditive: () => this.interactionService.additiveSelect3D === true },   // TOUCH-10 additive latch
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
            isBusy: () => this.scene3d.isPlayModeActive() || this.ui.interactive || this._uiPlayerMode || !!this.webgpuRenderer?.isDeviceLost,   // same gate as _createPersistence
            busyEpoch: () => this._persistBusyEpoch(),
            onSaveDeferred: () => this._notifyPersistDeferred('save'),
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
                // PROCEDURAL GROUND (procedural-ground P1) — drop a large plane + apply the ashlar limestone
                // material so it can be eyeballed with zero Frogmarks wiring. `salsaGround()` or
                // `salsaGround({ size: 30, tileMm: 450, groutMm: 12 })`.
                // P2 adds `weather` ('new'|'worn'|'ancient'|'mossy'|'dirty') + a default demo WEAR TRACK
                // (a worn center patch) so the weathering reads on the standalone plane: `salsaGround({ weather: 'ancient' })`.
                // P3/P4 add `surface` ('ashlar'|'radialMedallion'|'borderStrip'|'grass'); grass carves a demo dirt
                // path via the default wear track: `salsaGround({ surface: 'grass' })`.
                // P6 widens `surface` to the whole material library — see GROUND_SURFACES:
                // ashlar · brick · granite · slate · sandstone · radialMedallion · borderStrip · grass ·
                // asphalt · concrete · dirt · cobble · plank.  `salsaGroundNames()` lists them.
                (window as unknown as Record<string, unknown>).salsaGround = (opts?: { size?: number; surface?: GroundSurfaceName;
                        tileMm?: number; groutMm?: number; tint?: [number, number, number]; wedges?: number; ringMm?: number; dirtTint?: [number, number, number];
                        weather?: 'new' | 'worn' | 'ancient' | 'mossy' | 'dirty'; wearPath?: [number, number, number] }) => {
                    const size = opts?.size ?? 20;
                    const surface = opts?.surface ?? 'ashlar';
                    const m = inst.createPlane3D(0, 0, 0, size, size);
                    m.name = `Ground (${surface})`;
                    inst.applyGroundMaterial3D(m.id, { extentMeters: size, surface, tileMm: opts?.tileMm, groutMm: opts?.groutMm, tint: opts?.tint,
                        wedges: opts?.wedges, ringMm: opts?.ringMm, dirtTint: opts?.dirtTint,
                        weather: opts?.weather, wearPath: opts?.wearPath ?? [0.5, 0.5, 0.4] });   // demo worn patch (uv center + radius)
                    inst.scheduleRender();
                    console.log('[salsaGround]', m.id);
                    return m.id;
                };
                // ★ THE WHOLE LIBRARY AT ONCE (P6). Lays every surface out on a grid of tiles so the set can be
                // reviewed — and compared against each other — in a single screenshot instead of one call per
                // material. `salsaGroundLibrary()` · `salsaGroundLibrary({ tile: 8, weather: 'new' })`.
                // Pass `only: ['asphalt','dirt']` to lay out just a couple while tuning them.
                (window as unknown as Record<string, unknown>).salsaGroundLibrary = (opts?: { tile?: number; gap?: number;
                        weather?: 'new' | 'worn' | 'ancient' | 'mossy' | 'dirty'; only?: GroundSurfaceName[] }) => {
                    const names = (opts?.only ?? (Object.keys(GROUND_SURFACES) as GroundSurfaceName[]));
                    const tile = opts?.tile ?? 10;
                    const gap = opts?.gap ?? 1.5;
                    const cols = Math.ceil(Math.sqrt(names.length));
                    const step = tile + gap;
                    const originX = -((cols - 1) * step) / 2;
                    const originZ = -((Math.ceil(names.length / cols) - 1) * step) / 2;
                    const ids: string[] = [];
                    names.forEach((surface, i) => {
                        const x = originX + (i % cols) * step;
                        const z = originZ + Math.floor(i / cols) * step;
                        const m = inst.createPlane3D(x, 0, z, tile, tile);
                        m.name = `Ground (${surface})`;
                        // NB: no wearPath here — the demo worn track is great for showing off weathering on ONE
                        // plane and terrible for judging a material against its neighbours.
                        inst.applyGroundMaterial3D(m.id, { surface, weather: opts?.weather ?? 'worn' });
                        ids.push(m.id);
                    });
                    inst.scheduleRender();
                    // Print the ROW-MAJOR grid so a review screenshot is self-identifying (position → name).
                    const gridRows: string[] = [];
                    for (let row = 0; row * cols < names.length; row++) gridRows.push(`  row ${row}: ` + names.slice(row * cols, row * cols + cols).join(' · '));
                    console.log(`[salsaGroundLibrary] ${names.length} surfaces on a ${cols}-col grid (back row = row 0):\n` + gridRows.join('\n'));
                    return ids;
                };
                /** The surface names a picker should offer. */
                (window as unknown as Record<string, unknown>).salsaGroundNames = () => Object.keys(GROUND_SURFACES);
                // PROCEDURAL GROUND (P3 composed plaza) — the region composition is MULTI-MESH, not per-fragment: a
                // disc medallion (radialMedallion) + an ashlar limestone field + a border FRAME ring (4 borderStrip
                // strips). `salsaGroundPlaza()` drops all three so the composed limestone plaza is demoable.
                (window as unknown as Record<string, unknown>).salsaGroundPlaza = (opts?: { size?: number; wedges?: number }) => {
                    const size = opts?.size ?? 30;
                    const ids: string[] = [];
                    // Ashlar limestone FIELD (the plaza floor).
                    const field = inst.createPlane3D(0, 0, 0, size, size);
                    field.name = 'Plaza field (ashlar)';
                    inst.applyGroundMaterial3D(field.id, { extentMeters: size, surface: 'ashlar', weather: 'worn' });
                    ids.push(field.id);
                    // Radial MEDALLION centrepiece (a plane centred at the origin; rings tile about its uv centre).
                    const dSize = size * 0.42;
                    const disc = inst.createPlane3D(0, 0.01, 0, dSize, dSize);   // +1 cm to avoid z-fight with the field
                    disc.name = 'Plaza medallion (radial)';
                    inst.applyGroundMaterial3D(disc.id, { extentMeters: dSize, surface: 'radialMedallion', wedges: opts?.wedges ?? 16, ringMm: 600, weather: 'worn' });
                    ids.push(disc.id);
                    // Border FRAME — 4 thin strips around the field edge; left/right yawed 90° so stones run the length.
                    const bw = size * 0.09;                                      // band width
                    const half = size / 2;
                    const strips: { x: number; z: number; yaw: number }[] = [
                        { x: 0, z: half - bw / 2, yaw: 0 },                      // top
                        { x: 0, z: -half + bw / 2, yaw: 0 },                     // bottom
                        { x: half - bw / 2, z: 0, yaw: Math.PI / 2 },            // right
                        { x: -half + bw / 2, z: 0, yaw: Math.PI / 2 },           // left
                    ];
                    for (const s of strips) {
                        const st = inst.createPlane3D(s.x, 0.02, s.z, size, bw);  // long axis (uv.x) = size
                        st.setRotation3D(0, s.yaw, 0);
                        st.name = 'Plaza border (strip)';
                        inst.applyGroundMaterial3D(st.id, { extentMeters: size, surface: 'borderStrip', tileMm: 900, weather: 'worn' });
                        ids.push(st.id);
                    }
                    inst.scheduleRender();
                    console.log('[salsaGroundPlaza]', ids);
                    return ids;
                };
                // PROCEDURAL GROUND SCATTER (P5, §7) — drop a GRASS ground with a worn dirt track + scatter
                // mask-driven props over it (flowers/pebbles/twigs/tall-grass/bushes/rocks). The shared-mask
                // payoff: flowers + grass visibly THIN over the wear track (fewer where the material draws bare
                // dirt). `salsaGroundScatter()` or `salsaGroundScatter({ size: 30, seed: 7 })`. Vegetation
                // geometry is deliberately low-poly (a later quality pass). Returns { groundId, scatterId }.
                (window as unknown as Record<string, unknown>).salsaGroundScatter = (opts?: { size?: number; seed?: number; surface?: 'grass' | 'ashlar' }) => {
                    const size = opts?.size ?? 24;
                    const wearPath: [number, number, number] = [0.5, 0.5, 0.4];   // worn track (uv center + radius)
                    const m = inst.createPlane3D(0, 0, 0, size, size);
                    m.name = 'Ground (scatter)';
                    inst.applyGroundMaterial3D(m.id, { extentMeters: size, surface: opts?.surface ?? 'grass', weather: 'worn', wearPath });
                    const scatterId = inst.scatterOnGround3D(m.id, { seed: opts?.seed ?? 7, wearPath });
                    inst.scheduleRender();
                    console.log('[salsaGroundScatter]', { groundId: m.id, scatterId, wind: inst.sceneWind3D });
                    return { groundId: m.id, scatterId };
                };
                // SCENE WIND (foliage-quality S1) — tune the shared vegetation motion live:
                // `salsaWind()` reads it back · `salsaWind({ strength: 0.15 })` a stiff breeze ·
                // `salsaWind({ dirDeg: 90, speed: 2 })` · `salsaWind({ strength: 0 })` dead calm.
                // Drives EVERY windSway material at once (all 11 foliage types + the P5 scatter
                // flowers/tall-grass/bushes), colour pass AND shadow pass.
                (window as unknown as Record<string, unknown>).salsaWind = (opts?: { dirDeg?: number; strength?: number; speed?: number }) => {
                    const w = opts ? inst.setSceneWind3D(opts) : inst.sceneWind3D;
                    console.log('[salsaWind]', w);
                    return w;
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
                // PAINT-CHAIN PROBE (permanent diagnostic) — `salsaPkgPaintProbe()` dumps every texture
                // IDENTITY in the Package-Creator paint chain: what the paint engine WRITES, what the
                // layer manager currently OWNS, what LiveTextureMode RESOLVED onto each panel, and what
                // the 3D renderer actually has BOUND for panel 0 — plus sync counters. Any identity
                // mismatch between columns is the "paint never reaches the box" bug, made visible.
                (window as unknown as Record<string, unknown>).salsaPkgPaintProbe = () => inst.pkgPaintProbe();
                // STACK PROBE (permanent diagnostic) — `salsaPkgStackProbe()` dumps the active package's
                // layer STACK (per layer: kind, visibility, opacity, systemOwner/packageOwnerId, whether a
                // vector layer has a rasterized PROXY + its placement count) + the composite target id and
                // recomposite counter. Diagnoses "vector ephemera never appear on the box": a vector layer
                // with hasProxy=false / proxyPlacementCount=0 / a stale recomposite tick localizes the break.
                (window as unknown as Record<string, unknown>).salsaPkgStackProbe = () => inst.pkgStackProbe();
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
        if (info?.isTransforming) void this.rasterSelectionService?.commitTransform();
        this.rasterDrawingService?.disable();
        this.rasterMoveService?.disable();
        this.rasterSelectionService?.setTool(tool);
        this.rasterSelectionService?.enable();
        this.webgpuRenderer?.setRenderMode('raster');
    }

    /** Disable selection tool mode. */
    public disableRasterSelection() {
        const info = this.rasterSelectionService?.getSelectionInfo();
        if (info?.isTransforming) void this.rasterSelectionService?.commitTransform();
        this.rasterSelectionService?.disable();
    }

    /** Enable the raster move/grab tool (translates the active layer's pixels). */
    public enableRasterMove() {
        const info = this.rasterSelectionService?.getSelectionInfo();
        if (info?.isTransforming) void this.rasterSelectionService?.commitTransform();
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
            ? this.rasterSelectionService.getMaskTexture() ?? undefined
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
                ? this.rasterSelectionService.getMaskTexture() ?? undefined
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
        this._setRasterEraserLease(false);
    }

    public disableRasterTool() {
        this.rasterDrawingService?.disable();
        this._setRasterEraserLease(false);
    }

    /** The raster eraser tool's interactive (render-loop) lease: ONE while the eraser is on. enableRasterEraserTool /
     *  enableRasterClearEraserTool used to take a NEW lease on every call (each eraser click, style change, rail E)
     *  and only disableRasterEraserTool returned one, so switching to a brush leaked it (render every vsync). */
    private _rasterEraserLeaseHeld = false;
    private _setRasterEraserLease(hold: boolean): void {
        if (hold === this._rasterEraserLeaseHeld) return;
        this._rasterEraserLeaseHeld = hold;
        if (hold) this.beginInteractive(); else this.endInteractive();
    }

    public setRasterBrushSize(size: number) {
        this.rasterDrawingService?.setBrushRadiusPx(size);
    }

    /** Raster brush smoothing for FINGER strokes (docs/ui/touch-controls.md §5): 'light' (default) caps the brush's
     *  stabilizer at ~16.7 ms of lag, 'off' = no smoothing, 'normal' = the brush's own value. Pen + mouse always use
     *  the brush's value. Per machine (localStorage); applies from the next stroke. */
    public setTouchSmoothing(mode: TouchSmoothing): void { _setTouchSmoothing(mode); }
    public getTouchSmoothing(): TouchSmoothing { return _getTouchSmoothing(); }
    /** Raster stroke prediction for touch + pen (getPredictedEvents → a provisional tail shown for one frame, never
     *  committed). On by default; per machine (localStorage). Mouse strokes never predict. */
    public setStrokePrediction(on: boolean): void { _setStrokePrediction(on); }
    public getStrokePrediction(): boolean { return _getStrokePrediction(); }
    /** ON-DEVICE check of stroke prediction (OFF by default since 2026-10-06, when the predicted tail hid the committed
     *  stroke on a tablet GPU): runs the real brush pipeline on this device's GPU against a private scratch texture —
     *  the same stroke with and without a predicted tail — and reports whether taking the tail back restores the
     *  committed stroke exactly, plus any GPU validation error. No document is touched. `report.ok` (and
     *  `report.summary`, one line per brush) says whether setStrokePrediction(true) is safe on this device. Null
     *  before the renderer has a GPU device. */
    public async runStrokePredictionSelfTest(): Promise<StrokePredictionSelfTestReport | null> {
        const device = this.webgpuRenderer?.getDevice?.();
        return device ? _runStrokePredictionSelfTest(device) : null;
    }

    /** BRUSH-5 (docs/specs/mobile-parity.md §3): re-composite the 2D raster layers only when, and only where, they
     *  changed (a persistent composite + dirty rects) instead of blending every layer from scratch every frame.
     *  OFF by default for now; off = the full composite, exactly as before. Session-wide (all renderers). */
    public setRasterDirtyCompositing(on: boolean): void {
        WebGPURenderer.rasterDirtyCompositing = !!on;
        this.webgpuRenderer?.rasterCompositor?.invalidateIncremental();
        this.scheduleRender();
    }
    public getRasterDirtyCompositing(): boolean { return WebGPURenderer.rasterDirtyCompositing; }
    /** Tell the incremental raster composite that layer pixels changed outside Salsa's own tools (a host that writes
     *  a layer texture itself). `rect` in document texels (max-exclusive); omitted = the whole canvas. */
    public markRasterLayersDirty(rect?: { x0: number; y0: number; x1: number; y1: number }): void {
        _markRasterCompositeDirty(rect ?? null);
    }

    public setRasterBrushColor(color: string) {
        this.rasterDrawingService?.setBrushColor(hexToRgba(color));
    }

    // Raster-specific eraser helpers (do not conflict with the scribble eraser service)
    public enableRasterEraserTool() {
        this.rasterDrawingService?.setEraserMode('erase');
        this.rasterDrawingService?.enable();
        this._setRasterEraserLease(true);
    }

    public enableRasterClearEraserTool() {
        this.rasterDrawingService?.setEraserMode('clear');
        this.rasterDrawingService?.enable();
        this._setRasterEraserLease(true);
    }

    public disableRasterEraserTool() {
        this.rasterDrawingService?.setEraserMode('paint');
        this.rasterDrawingService?.disable();
        this._setRasterEraserLease(false);
    }

    // Stroke event subscription helpers
    public onRasterStrokeStart(listener: (v: any) => void) { return this.rasterDrawingService?.onStrokeStart.subscribe(listener); }
    public onRasterStrokeUpdate(listener: (v: any) => void) { return this.rasterDrawingService?.onStrokeUpdate.subscribe(listener); }
    public onRasterStrokeEnd(listener: (v: any) => void) { return this.rasterDrawingService?.onStrokeEnd.subscribe(listener); }
    /** TOUCH-5: a raster stroke was TAKEN BACK (a second finger made it a pinch, or a pen took over from a resting
     *  finger): its pixels are already restored and it has no onRasterStrokeEnd — nothing to save, upload or undo.
     *  `{ timestamp, began }` (began false = it never painted). */
    public onRasterStrokeCancel(listener: (v: any) => void) { return this.rasterDrawingService?.onStrokeCancel.subscribe(listener); }
    /** Abandon the live raster stroke the same way (pixels put back, no undo entry, no stroke end). False when none. */
    public cancelRasterStroke(): boolean { return this.rasterDrawingService?.cancelActiveStroke() ?? false; }

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
        const ok = await this.webgpuRenderer.rasterUndo();
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
        const ok = await this.webgpuRenderer.rasterRedo();
        if (ok) this.scheduleRender();
        return ok;
    }

    public rasterPushSnapshot(): void {
        const selectedId = this.rasterLayerManager?.getSelectedLayerId();
        if (selectedId && this.rasterLayerManager) {
            this.rasterLayerManager.pushSnapshotForLayer(selectedId);
            return;
        }
        void this.webgpuRenderer?.rasterPushSnapshot();
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

    public addRasterLayer(name: string = 'Layer', opts?: { visible?: boolean; systemOwner?: string; packageOwnerId?: string }) {
        const l = this.rasterLayerManager?.addLayer(name, opts);
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
        void this.getSelectionEngine()?.selectRect({ x, y, w, h }, feather);
    }

    /** Create an elliptical selection inside the given bounding rect. */
    public rasterSelectEllipse(x: number, y: number, w: number, h: number, feather: number = 0): void {
        void this.getSelectionEngine()?.selectEllipse({ x, y, w, h }, feather);
    }

    /** Create a lasso (freeform polygon) selection. Points are [{x,y},...] in texel coords. */
    public rasterSelectLasso(points: Array<{ x: number; y: number }>): void {
        void this.getSelectionEngine()?.selectLasso(points);
    }

    /** Select the entire canvas. */
    public rasterSelectAll(): void {
        void this.getSelectionEngine()?.selectAll();
    }

    /** Deselect all (clear selection). */
    public rasterDeselectAll(): void {
        void this.getSelectionEngine()?.deselectAll();
    }

    /** Invert the selection. */
    public rasterInvertSelection(): void {
        void this.getSelectionEngine()?.invertSelection();
    }

    /** Delete selected pixels (set to transparent). */
    public rasterDeleteSelection(): void {
        void this.getSelectionEngine()?.deleteSelection();
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
        void this.getSelectionEngine()?.beginTransform();
    }

    /** Update the in-progress transform (call during drag). */
    public rasterUpdateTransform(dx: number, dy: number, scaleX?: number, scaleY?: number, rotation?: number): void {
        this.getSelectionEngine()?.updateTransform(dx, dy, scaleX, scaleY, rotation);
    }

    /** Commit the transform (stamp floating pixels at new position). */
    public rasterCommitTransform(): void {
        void this.getSelectionEngine()?.commitTransform();
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

    /** PICK a brush (what a brush-list click should call): activates the preset AND leaves the raster eraser tool's
     *  erase mode, so a brush picked after the eraser paints instead of erasing. setActiveBrushPreset only swaps the
     *  preset (used for live edits of the active brush, which must not drop erase mode). */
    public selectRasterBrushPreset(id: string): boolean {
        const ok = this.rasterDrawingService
            ? this.rasterDrawingService.selectBrushPreset(id)
            : this.setActiveBrushPreset(id);
        if (ok) this._setRasterEraserLease(false);
        return ok;
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

    /**
     * Set the dither EDGE/BOUNDARY effects (2026-09-15) on the global config — how the pattern
     * behaves near the layer's CONTENT edge (where the painted alpha ends: a stroke's outline,
     * a filled shape's rim).
     *
     * - `width`: px band the effects ramp across. **0 disables all three** (the default).
     * - `fade` (0–1): the dither fades back to the original toward the edge (pattern dissolves).
     * - `shrink` (-1..1): dot-size ramp at the edge. POSITIVE shrinks the dots until they vanish
     *   at the boundary — direction-aware (rev 4): it shrinks whichever color currently forms the
     *   dots, on either side of the Bias 50% midpoint. NEGATIVE grows them into a solid rim (the
     *   outline effect). Suggested slider: -100%..+100%, default 0.
     * - `density` (0–1): whole cells/dots drop out stochastically toward the edge (per-cell hash,
     *   so halftone dots disappear as units; for noise/blue-noise this folds into coverage).
     *
     * `mode` picks WHICH boundary the effects ramp toward: `'content'` (default) = the painted
     * alpha boundary — stroke outlines, blob rims, erased holes (the nearest no-paint gap);
     * `'canvas'` = the document border only (cheapest — no sampling); `'both'` = nearest of the two.
     *
     * Ordered (GPU) algorithms only — error-diffusion algorithms ignore these settings.
     * Per-layer: pass the same `edgeWidth`/`edgeFade`/`edgeShrink`/`edgeDensity`/`edgeMode` fields
     * through `setLayerDitherConfig`. Effects combine freely (e.g. shrink 0.7 + fade 0.4).
     *
     * ```ts
     * sm.setDitherEdgeEffects({ width: 24, shrink: 1 });          // classic halftone dot fade-out
     * sm.setDitherEdgeEffects({ width: 40, fade: 0.6, density: 0.5 });
     * sm.setDitherEdgeEffects({ width: 60, fade: 1, mode: 'canvas' });   // vignette-style border fade
     * sm.setDitherEdgeEffects({ width: 0 });                      // off
     * ```
     */
    public setDitherEdgeEffects(opts: { width?: number; fade?: number; shrink?: number; density?: number; mode?: 'content' | 'canvas' | 'both'; seed?: number }): void {
        const cfg = this.getDitherConfig();
        if (opts.width !== undefined) cfg.edgeWidth = Math.max(0, Math.min(512, opts.width));
        if (opts.fade !== undefined) cfg.edgeFade = Math.max(0, Math.min(1, opts.fade));
        if (opts.shrink !== undefined) cfg.edgeShrink = Math.max(-1, Math.min(1, opts.shrink));   // signed: negative = grow
        if (opts.density !== undefined) cfg.edgeDensity = Math.max(0, Math.min(1, opts.density));
        if (opts.mode !== undefined) cfg.edgeMode = opts.mode;
        if (opts.seed !== undefined) cfg.edgeSeed = Math.floor(opts.seed);
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

    /** Structural-change counter (see ManagerContext.sceneStructureVersion). Step 2 (services/structure-version.ts):
     *  bumps are COALESCED — any number of structure notifications between two reads advance it once, at the read —
     *  so the version-keyed caches (getAllMeshes, the array sync list, collision, sim-LOD bodies…) re-walk at most
     *  once per batch of changes. A reader always sees a new value after any change since its previous read. */
    private readonly _structureVersion = new StructureVersion();
    /** Step 2 A/B: coalesce structure bumps between reads (default on). Off = every notification increments. */
    static get coalesceStructureBumps(): boolean { return ShapeManager._coalesce; }
    static set coalesceStructureBumps(v: boolean) { ShapeManager._coalesce = v; }
    private static _coalesce = true;
    getSceneStructureVersion(): number { return this._structureVersion.read(); }
    private _bumpStructure(): void {
        this._structureVersion.coalesce = ShapeManager._coalesce;
        this._structureVersion.bump();
    }

    public emitSceneGraphChanged() {
        // Bump BEFORE any early return so batched / mid-restore structural changes still invalidate
        // any cached mesh lists. Over-invalidation is harmless; a missed bump would risk a stale cache.
        this._bumpStructure();
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

    /** Select 2D shapes by id (an outliner row click). Replaces the selection unless `additive` (shift-click). */
    public selectNodesByIds(nodeIds: string[], additive = false): void {
        if (!additive) this.interactionService.clearSelectedNodes();
        for (const id of nodeIds) {
            const node = this.sceneGraph.findNodeById(id);
            if (node && !(node instanceof Mesh3D) && !(node instanceof MeshGroup3D)) this.interactionService.selectNode(node);
        }
        this.scheduleRender();
    }

    public setNodeFillColor(layerId: string, newColor: RGBA) {
        const node = this.sceneGraph.findNodeById(layerId) as Shape;
        if (!node) return;

        const type = node.getType?.();
        if (type === 'Scribble') {
            (node as ColoredShape).strokeColor = newColor;
        } else if (type === 'Sticky Note') {
            // single source of truth: use the class API
            (node as unknown as StickyNote).setColor(newColor);  // updates bg + marks dirty
        } else {
            (node as ColoredShape).fillColor = newColor;
        }
        this.emitSceneGraphChanged();
    }

    public getNodeFillColor(layerId: string): RGBA {
        const node = this.sceneGraph.findNodeById(layerId) as Shape;
        if (!node) return { r: 1, g: 1, b: 1, a: 1 };

        const type = node.getType?.();
        if (type === 'Scribble') return (node as ColoredShape).strokeColor ?? { r: 1, g: 1, b: 1, a: 1 };
        if (type === 'Sticky Note') return (node as unknown as StickyNote).bg.fillColor;
        return (node as ColoredShape).fillColor ?? { r: 1, g: 1, b: 1, a: 1 };
    }

    createRectangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ) {
        const rectangle = this.shapeFactory.createRectangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        this._stampVectorLayer(rectangle);
        this.sceneGraph.root.addChild(rectangle);
        this.emitSceneGraphChanged();
        return rectangle;   // (was void) — return the node so authoring/AI callers get its id
    }

    createCircle(
        x: number, y: number, radius: number, strokeColor: RGBA, strokeWidth: number
    ) {
        const circle = this.shapeFactory.createCircle(x, y, radius, this.shapeColor, strokeColor, strokeWidth);
        this._stampVectorLayer(circle);
        this.sceneGraph.root.addChild(circle);
        this.emitSceneGraphChanged();
        return circle;
    }

    /** Create a Bézier Path from anchors (ABSOLUTE coords + optional in/out handle offsets — the pen tool's
     *  data model, docs/specs/vector-paths.md). Closed paths fill even-odd; open paths render as a stroke.
     *  Editable afterwards via the node editor (enterPathEdit / double-click). */
    createPath(
        anchors: PathAnchor[], closed: boolean, strokeColor: RGBA, strokeWidth: number
    ) {
        const path = this.shapeFactory.createPath(anchors, closed, this.shapeColor, strokeColor, strokeWidth);
        this._stampVectorLayer(path);
        this.sceneGraph.root.addChild(path);
        this.emitSceneGraphChanged();
        return path;
    }

    createTriangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ) {
        const triangle = this.shapeFactory.createTriangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        this._stampVectorLayer(triangle);
        this.sceneGraph.root.addChild(triangle);
        this.emitSceneGraphChanged();
        return triangle;
    }

    createLine(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number) {
        const line = this.shapeFactory.createLine(x1, y1, x2, y2, strokeColor, strokeWidth);
        this._stampVectorLayer(line);
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
        this._stampVectorLayer(line);
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
        this._stampVectorLayer(note);
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
        this._stampVectorLayer(balloon);
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
    public get renderer3D(): Renderer3D {
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

    // ── VIEW STATE: target × camera mode (docs/specs/free-camera-and-scene-targets.md, docs/ui/…) ────────────
    // The two-axis view model. All NON-DESTRUCTIVE (view/intent flags, never a data conversion). Frogmarks drives
    // its panel/tool visibility off `onViewStateChanged3D` + `getViewRules3D()`; the engine handles the camera.
    /** Set camera mode: 'ortho2D' | 'perspective2D' | 'free3D' (orbit/pan/dolly). Works in both targets. */
    public setCameraMode3D(mode: import('./managers/view-state').CameraMode): void { this.scene3d.setCameraMode3D(mode); }
    /** Set target: 'illustration' (X×Y composite output) | 'scene' (interactive 3D world). */
    public setTarget3D(target: import('./managers/view-state').ViewTarget): void { this.scene3d.setTarget3D(target); }
    /** illustration × free3D: show/hide the live artboard "frame" floating in 3D. */
    public setArtboardFrameVisible3D(on: boolean): void { this.scene3d.setArtboardFrameVisible3D(on); }
    /** illustration × free3D: show/hide the 2D illustration TEXTURED onto the artboard plane (raster + vectors,
     *  transparent). Default on. Captured once per free3D entry. See docs/specs/textured-artboard.md. */
    public setArtboardTextured3D(on: boolean): void { this.scene3d.setArtboardTextured3D(on); }
    public get isArtboardTextured3D(): boolean { return this.scene3d.isArtboardTextured3D; }
    /** The current { target, cameraMode, poses, showArtboardFrame }. */
    public getViewState3D(): import('./managers/view-state').ViewState { return this.scene3d.getViewState3D(); }
    /** The DERIVED rules for the current view state (twoDComposite / twoDToolsActive / freeNavigation / projection /
     *  artboardFrame / outputIsArtboard …). Frogmarks uses this to show/hide panels + tools. */
    public getViewRules3D(): import('./managers/view-state').ViewRules { return deriveViewRules(this.scene3d.getViewState3D()); }
    /** Fires whenever target/cameraMode/artboard-frame changes — subscribe to re-read getViewRules3D() and swap UI. */
    public get onViewStateChanged3D(): import('../renderer/util/event-emitter').EventEmitter<void> { return this.scene3d.onViewStateChanged; }

    // ── Play mode (scene target — the ▶ button) ──────────────────────────────────────────────────────────────
    /** Enter Play mode: a first-person character controller drives the camera via a fixed-timestep game loop.
     *  Non-destructive (camera-only; restored on exit). Feed input with setPlayInput3D. */
    public enterPlayMode3D(opts?: { start?: [number, number, number]; config?: Partial<import('../game/character-controller').CharacterConfig>; keyboard?: boolean; mouseLook?: boolean; gamepad?: boolean; collision?: boolean; playerMeshId?: string }): void { this.scene3d.enterPlayMode3D(opts); }
    /** Exit Play mode → restore the pre-play camera + edit view. */
    public exitPlayMode3D(): void { this.scene3d.exitPlayMode3D(); }
    public get isPlaying3D(): boolean { return this.scene3d.isPlaying3D; }
    /** Feed per-frame intent while playing: { forward, right, look } ∈ [-1,1], { jump } = the jump BUTTON held (Round 8:
     *  the press edge jumps, releasing early shortens it; keep it true while held), { lookYaw, lookPitch } direct
     *  mouse-look radian deltas. */
    public setPlayInput3D(input: Partial<import('../game/character-controller').CharacterInput>): void { this.scene3d.setPlayInput3D(input); }
    /** Assign the mesh Play drives as the "Player" avatar (null to clear). Third-person follows it; first-person
     *  hides it. Follow distance/height come from the CharacterConfig (thirdPersonDistance/thirdPersonHeight). */
    public setPlayerObject3D(meshId: string | null): void { this.scene3d.setPlayerObject3D(meshId); }
    public get playerObjectId3D(): string | null { return this.scene3d.playerObjectId3D; }
    // Play settings (polish-round-3 T5; docs/ui/play-mode.md §Play settings). Persisted with the document; live while playing.
    /** First-person PLAYER HEIGHT (camera eye height above the feet). World units, or METRES when `metresPerUnit` is
     *  given (pass `cityMetresPerUnit()` in a city doc). null = automatic (1.6 m in world units / 0.9 × the Player avatar). */
    public setPlayerEyeHeight3D(height: number | null, metresPerUnit?: number): void { this.scene3d.playSettings.setEyeHeight(height, metresPerUnit); }
    /** The set eye height (units, or metres with `metresPerUnit`), or null = automatic. */
    public getPlayerEyeHeight3D(metresPerUnit?: number): number | null { return this.scene3d.playSettings.getEyeHeight(metresPerUnit); }
    /** The eye height used when none is set (world units) — a slider's initial value. */
    public getDefaultPlayerEyeHeight3D(): number { return this.scene3d.getDefaultPlayerEyeHeight3D(); }
    /** Third-person Play with no Player set spawns a runtime default animated character (never saved). Default on. */
    public setAutoDefaultPlayer3D(on: boolean): void { this.scene3d.playSettings.setAutoDefaultPlayer(on); }
    public getAutoDefaultPlayer3D(): boolean { return this.scene3d.playSettings.autoDefaultPlayer; }
    /** Player RUN SPEED in metres / second (Round 8: Shift toggles into it; Play starts walking). The full-input speed
     *  of the run gait; an analog stick scales it. Scene-scale independent (converted with the city's metres-per-unit in
     *  a city). null = default (5.2 m/s). Persisted as globalScene.play.moveSpeed only when non-default (an older save's
     *  value keeps meaning "full-input run speed"); live while playing. */
    public setPlayerMoveSpeed3D(metresPerSecond: number | null): void { this.scene3d.playSettings.setMoveSpeed(metresPerSecond); }
    /** The effective player run speed in m/s (the default 5.2 when unset). */
    public getPlayerMoveSpeed3D(): number { return this.scene3d.playSettings.getMoveSpeed(); }
    /** Player WALK SPEED in m/s (Round 8) — the default gait's full-input speed. null = default (1.6 m/s). Never above
     *  the run speed. Persisted as globalScene.play.walkSpeed only when non-default; live while playing. */
    public setPlayerWalkSpeed3D(metresPerSecond: number | null): void { this.scene3d.playSettings.setWalkSpeed(metresPerSecond); }
    /** The effective walk speed in m/s. */
    public getPlayerWalkSpeed3D(): number { return this.scene3d.playSettings.getWalkSpeed(); }
    /** Third-person follow DISTANCE in metres (R6.2). null = automatic (2.6 x the avatar height, else 4.5 m). Converted
     *  with the city's metres-per-unit in a city. Persisted as globalScene.play.cameraDistance; live while playing. */
    public setPlayCameraDistance3D(metres: number | null): void { this.scene3d.playSettings.setCameraDistance(metres); }
    /** The set third-person follow distance in metres, or null = automatic. */
    public getPlayCameraDistance3D(): number | null { return this.scene3d.playSettings.getCameraDistance(); }
    /** Third-person vertical FIELD OF VIEW in degrees (R6.2; default 72, clamped 30-110). null = default. Persisted as
     *  globalScene.play.fovDeg; live while playing. First-person keeps the editor camera's FOV. */
    public setPlayCameraFov3D(deg: number | null): void { this.scene3d.playSettings.setFov(deg); }
    public getPlayCameraFov3D(): number { return this.scene3d.playSettings.getFov(); }
    /** JUMP VARIETY (2026-10-03, default on): each jump picks one of the runtime default jump variants (tuck / reach /
     *  swing / stride / hop / the classic; weighted by standing / walking / running and tap / hold, never the same twice
     *  running). An authored Jump clip is never replaced. Persisted as globalScene.play.jumpVariety (only when off). */
    public setPlayJumpVariety3D(on: boolean): void { this.scene3d.playSettings.setJumpVariety(on); }
    public getPlayJumpVariety3D(): boolean { return this.scene3d.playSettings.jumpVariety; }
    /** MOTION LOOSENESS 0..1 (2026-10-03, default 0.5): the secondary motion over the runtime default gaits (upper-body
     *  follow-through on starts / stops, per-cycle arm variation, head drift); 0 = the clips exactly. null = default.
     *  Persisted as globalScene.play.motionLooseness; live while playing. */
    public setPlayMotionLooseness3D(v: number | null): void { this.scene3d.playSettings.setMotionLooseness(v); }
    public getPlayMotionLooseness3D(): number { return this.scene3d.playSettings.getMotionLooseness(); }
    /** WALK STYLE (2026-10-03, default 'natural'): 'natural' = the runtime default Walk (heel-to-toe roll, the pelvis
     *  highest at mid-stance); 'stomp' = the runtime Stomp clip (a heavy, flat-footed tread — e.g. wading through swamp
     *  water). Swaps only the engine's runtime Walk, never an authored one; live while playing. Persisted as
     *  globalScene.play.walkStyle (only when 'stomp'). Per-avatar alternative: setPlayerLocomotionSet3D({ walk: 'Stomp' }). */
    public setPlayWalkStyle3D(style: 'natural' | 'stomp'): void { this.scene3d.playSettings.setWalkStyle(style); }
    public getPlayWalkStyle3D(): 'natural' | 'stomp' { return this.scene3d.playSettings.walkStyle; }
    /** LANDING DUST (2026-10-04, default on): stylised dust puffs on jump landings (sized by Land / Land Deep / Land
     *  Soft), tiny puffs at each foot strike while running on dry ground, splashes on a wet street (city rain / wet
     *  sheen); coloured by the ground, lit + fogged by the scene, scaled to the avatar. Live while playing. Persisted as
     *  globalScene.play.landingDust (only when off). */
    public setPlayLandingDust3D(on: boolean): void { this.scene3d.playSettings.setLandingDust(on); }
    public getPlayLandingDust3D(): boolean { return this.scene3d.playSettings.landingDust; }
    /** IDLE VARIETY (2026-10-04, default on): standing still, the runtime Stand idle now and then plays a random one-shot
     *  variant (look around, stretch, check the wrist, foot tap, adjust glasses with a glasses charm) — seeded, never the
     *  same twice running, cancelled at once by any input. Never over an authored Idle clip. Live while playing.
     *  Persisted as globalScene.play.idleVariety (only when off). */
    public setPlayIdleVariety3D(on: boolean): void { this.scene3d.playSettings.setIdleVariety(on); }
    public getPlayIdleVariety3D(): boolean { return this.scene3d.playSettings.idleVariety; }
    /** Diagnostics: the Play dust (bursts emitted by kind since Play started, live particles) and the idle variants
     *  played this session (null outside an engine-driven Play avatar). */
    public getPlayPolishStats3D(): { dust: Record<string, number>; dustLive: number; idleVariants: string[]; idleVariant: string | null } {
        return this.scene3d.getPlayPolishStats3D();
    }
    /** Walk / run state (true = running). Round 8: Play starts WALKING; Shift (a press) or L3 / Y on a gamepad toggles it. */
    public getPlayerRunning3D(): boolean { return this.scene3d.getPlayerRunning3D(); }
    /** Force walk (false) / run (true); live while playing and carried to the next Play run. */
    public setPlayerRunning3D(running: boolean): void { this.scene3d.setPlayerRunning3D(running); }
    /** Fires with the new state whenever walk/run changes (for a HUD badge). */
    public get onPlayerRunChanged3D(): import('../renderer/util/event-emitter').EventEmitter<boolean> { return this.scene3d.onPlayerRunChanged; }
    /** Sneak state while playing (Round 8: Ctrl held, or C / gamepad B toggled). False when not playing. */
    public getPlayerSneaking3D(): boolean { return this.scene3d.getPlayerSneaking3D(); }
    /** Toggle-style sneak from the host (e.g. an on-screen button); resets every Play run. No-op when not playing. */
    public setPlayerSneaking3D(on: boolean): void { this.scene3d.setPlayerSneaking3D(on); }
    /** TOUCH-3 "Navigate" lock (docs/ui/touch-controls.md): true = one finger orbits the 3D camera in every mode
     *  (City / Edit Mesh / paint included); two fingers then pan + pinch. Persists across mode switches. */
    public setTouchNavigate3D(on: boolean): void { this.scene3d.setTouchNavigate3D(on); }
    public getTouchNavigate3D(): boolean { return this.scene3d.getTouchNavigate3D(); }
    /** Frame the mesh under a client (CSS) point, or everything when nothing is there (what a touch double-tap does). */
    public frameAtClient3D(clientX: number, clientY: number): boolean { return this.scene3d.frameAtClient3D(clientX, clientY); }
    /** TOUCH-10 (docs/ui/touch-controls.md §3c): the ADDITIVE-SELECT latch — while on, a 3D select press / tap adds to
     *  the selection like Shift (object select, and vertex / edge / face select in Edit Mesh). A tablet has no Shift. */
    public setAdditiveSelect3D(on: boolean): void { this.interactionService.additiveSelect3D = !!on; }
    public getAdditiveSelect3D(): boolean { return this.interactionService.additiveSelect3D === true; }
    /** TOUCH-10: the SNAP latch — while on, 3D gizmo drags snap (grid / angle / scale step / vertex) like holding Ctrl. */
    public setSnapToggle3D(on: boolean): void { this.interactionService.snapLatch3D = !!on; }
    public getSnapToggle3D(): boolean { return this.interactionService.snapLatch3D === true; }
    /** TOUCH-10 "Frame selected": in Edit Mesh the selected vertices / edges / faces (else the whole mesh), otherwise
     *  the selected meshes (else everything). False when nothing could be framed (e.g. in the armature, whose camera
     *  follows the 2D view zoom). */
    public frameSelected3D(padding = 1.4): boolean {
        const id = this.meshEdit.activeMeshId;
        if (!id) return this.scene3d.frameSelection3D(padding);
        const b = this.meshEdit.selectionWorldBounds(id);
        if (!b) return false;
        // A single vertex / a flat selection has no extent: keep at least a tenth of the whole mesh in view.
        const all = this.meshEdit.selectionWorldBounds(id, true) ?? b;
        const minHalf = 0.05 * Math.max(all.maxX - all.minX, all.maxY - all.minY, all.maxZ - all.minZ, 1e-3);
        const grow = (lo: number, hi: number): [number, number] => {
            const c = (lo + hi) / 2, h = Math.max((hi - lo) / 2, minHalf);
            return [c - h, c + h];
        };
        const [minX, maxX] = grow(b.minX, b.maxX), [minY, maxY] = grow(b.minY, b.maxY), [minZ, maxZ] = grow(b.minZ, b.maxZ);
        return this.scene3d.frameWorldBounds3D({ minX, minY, minZ, maxX, maxY, maxZ }, padding);
    }
    /** Whether a capture-phase 3D tool (UV paint, the armature) claimed this pointer event — it then lets the press
     *  through for the camera's pinch / orbit, but no other tool (a mesh pick) may act on it. */
    public isPointerEventClaimed3D(e: object): boolean { return isPointerEventClaimed(e); }
    /** True while an armature drag (joint / tail / joint gizmo / IK handle) or a finger press about to become one, or
     *  an Edit Mesh vertex drag, owns a pointer — hosts can skip per-move UI work (change detection). */
    public isEditDragActive3D(): boolean {
        return this.scene3d.isArmatureDragActive3D() || this._meshEditPointerController.isBusy;
    }
    /** Fires with the new sneak state (for a HUD badge). */
    public get onPlayerSneakChanged3D(): import('../renderer/util/event-emitter').EventEmitter<boolean> { return this.scene3d.onPlayerSneakChanged; }
    /** The active gait while playing: 'walk' | 'run' | 'sneak' (null when not playing). */
    public getPlayerGait3D(): 'walk' | 'run' | 'sneak' | null { return this.scene3d.getPlayerGait3D(); }
    /** Live camera numbers while playing (mode, current + target distance, FOV, yaw, pitch, body facing), else null. */
    public getPlayCameraState3D() { return this.scene3d.getPlayCameraState3D(); }
    /** The engine locomotion animator's live state (idle/move/jump/fall, weights, walk-run mix), else null. */
    public getPlayerAnimationState3D() { return this.scene3d.getPlayerAnimationState3D(); }
    /** The auto default player's mesh id while it is in the scene (third-person Play), else null. */
    public get autoPlayerId3D(): string | null { return this.scene3d.autoPlayer.meshId; }
    /** Wire the avatar's walk/idle/run/jump/fall clips + a handler the Play loop calls with a clip name on each
     *  locomotion transition (the host plays it on the avatar). Pass (null, null) to disable. See game/locomotion.ts. */
    public setPlayerAnimation3D(clips: import('../game/locomotion').LocomotionClips | null, handler: ((clipName: string) => void) | null): void { this.scene3d.setPlayerAnimation3D(clips, handler); }

    /** Bind the Play-mode locomotion slots (idle/walk/run/jump/fall) to Animation Library entries or clip
     *  names/ids on the avatar. The engine self-wires crossfading playback — the walk animates with no host
     *  code. Pass null to clear. (docs/specs/animation-library-and-triggers.md §4.4) */
    public setPlayerLocomotionSet3D(set: { idle?: string; walk?: string; run?: string; jump?: string; fall?: string; jumps?: string[] } | null): void { this.scene3d.setPlayerLocomotionSet3D(set); }
    public getPlayerLocomotionSet3D() { return this.scene3d.getPlayerLocomotionSet3D(); }
    /** Enable/disable the 1D locomotion blend tree (continuous idle↔walk↔run mix by speed) — object to tune walk/run
     *  speeds, `true` for defaults, null/false for discrete crossfades. Requires a locomotion set. */
    public setPlayerLocomotionBlend3D(cfg: Partial<import('../game/locomotion').LocomotionBlendConfig> | boolean | null): void { this.scene3d.setPlayerLocomotionBlend3D(cfg); }
    public getPlayerLocomotionBlend3D() { return this.scene3d.getPlayerLocomotionBlend3D(); }
    /** Layer a masked overlay clip (wave/aim) over the Player's locomotion — drives only `region`'s joints
     *  ('upperBody'/'lowerBody'/'arms'/'head' or explicit joint names). `clip` = library entry id/clip id/name; null clears. */
    public setPlayerAnimationOverlay3D(clip: string | null, region: import('./managers/anim-retarget').RegionMask = 'upperBody', opts?: { mode?: 'replace' | 'additive'; weight?: number }): void { this.scene3d.setPlayerAnimationOverlay3D(clip, region, opts); }
    public getPlayerAnimationOverlay3D() { return this.scene3d.getPlayerAnimationOverlay3D(); }
    /** Render an animated turntable preview of a clip on a skeleton → PNG-data-URL frames for an Animation Library
     *  thumbnail (the host plays them as a loop or lays them out as a strip). Non-destructive; the clip must already be
     *  on the skeleton (apply a library entry first via applyLibraryEntry3D). Returns null if skeleton/clip not found. */
    public captureAnimationPreview3D(skeletonId: string, clipRef: string, opts?: { frames?: number; size?: number; turns?: number; pitchDeg?: number; margin?: number; isolate?: boolean; fps?: number }) { return this.scene3d.captureAnimationPreview3D(skeletonId, clipRef, opts); }
    /** Set Play-mode trigger volumes — scene zones (box/sphere) that fire enter/exit as the player walks through.
     *  The primitive for doors/plates/checkpoints/level-transitions. See docs/specs/play-mode.md + game/trigger-volumes.ts. */
    public setTriggerVolumes3D(volumes: import('../game/trigger-volumes').TriggerVolume[]): void { this.scene3d.setTriggerVolumes3D(volumes); }
    /** Handler called with each trigger enter/exit during Play — wire to game logic or the UI state machine. */
    /** Last-published player.* values (change-gate for the UI-variable publisher). */
    private _lastPlayerParams: { speed: number; moving: boolean; grounded: boolean; airborne: boolean; rising: boolean } =
        { speed: -1, moving: false, grounded: false, airborne: false, rising: false };
    private _lastPlayerParamsLayer: string | null = null;

    private _playTriggerHostHandler: ((event: import('../game/trigger-volumes').TriggerEvent) => void) | null = null;
    /** Optional RAW trigger handler (enter/exit events) for custom game logic. Runs IN ADDITION to the built-in
     *  auto-dispatch into the active UI state machine — you don't need this just to drive UI transitions. */
    public setTriggerHandler3D(handler: ((event: import('../game/trigger-volumes').TriggerEvent) => void) | null): void { this._playTriggerHostHandler = handler; }

    private _playInteractHostHandler: ((targetId: string) => void) | null = null;
    /** Register the interactables the player can "use" (F key while playing, or `playerInteract3D()`). On use, an
     *  `interact` transition auto-dispatches into the active UI state machine. See docs/specs/play-mode.md. */
    public setInteractables3D(items: import('../game/interaction').Interactable[]): void { this.scene3d.setInteractables3D(items); }
    /** The nearest in-range interactable to the player (for a "Press F" prompt) while playing, or null. */
    public nearestInteractable3D(): string | null { return this.scene3d.nearestInteractable3D(); }
    /** Fire "use" on the nearest interactable now — bind to a custom key instead of the built-in F. */
    public playerInteract3D(): void { this.scene3d.playerInteract3D(); }
    /** Optional RAW interact handler (the interactable id) — runs IN ADDITION to the UI auto-dispatch. */
    public setInteractHandler3D(handler: ((targetId: string) => void) | null): void { this._playInteractHostHandler = handler; }
    /** Trigger volumes currently containing the player (for an interact key). */
    public triggersContainingPlayer3D(): string[] { return this.scene3d.triggersContainingPlayer3D(); }
    /** Fires on enter/exit Play — subscribe to toggle the ▶/⏹ button + input capture. */
    public get onPlayStateChanged3D(): import('../renderer/util/event-emitter').EventEmitter<void> { return this.scene3d.onPlayStateChanged; }

    /** Toggle the EDITOR WASD-fly camera (only active in free3D edit mode). Aim by orbit-drag; W/S fly, A/D
     *  strafe, E/Space up, Q down, Shift boost. Bind to a "Fly" toolbar toggle. Off by default. */
    public setFlyEnabled3D(on: boolean): void { this.scene3d.setFlyEnabled3D(on); }
    public get isFlyEnabled3D(): boolean { return this.scene3d.isFlyEnabled3D; }

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

    // ── Scene bounds / framing queries (for programmatic / AI authoring — keep content in the artboard) ──

    /** 8 world-space corners of a mesh's bounding box. Prefers the cached OBB corners (respect rotation + modifiers);
     *  falls back to computing them fresh from local geometry × world matrix if the mesh hasn't been drawn yet. */
    private _meshWorldCorners3D(id: string): [number, number, number][] | null {
        const mesh = this.getMesh3D(id);
        if (!mesh) return null;
        if (mesh.obbCorners) return mesh.obbCorners;
        const v = mesh.geometry.vertices as ArrayLike<number>;
        const stride = mesh.vertexCount > 0 ? v.length / mesh.vertexCount : 0;
        if (!stride) return null;
        let ox0 = Infinity, oy0 = Infinity, oz0 = Infinity, ox1 = -Infinity, oy1 = -Infinity, oz1 = -Infinity;
        for (let i = 0; i < v.length; i += stride) {
            const x = v[i], y = v[i + 1], z = v[i + 2];
            if (x < ox0) ox0 = x; if (x > ox1) ox1 = x;
            if (y < oy0) oy0 = y; if (y > oy1) oy1 = y;
            if (z < oz0) oz0 = z; if (z > oz1) oz1 = z;
        }
        const m = mesh.localMatrix as unknown as ArrayLike<number>;
        const out: [number, number, number][] = [];
        for (let ci = 0; ci < 8; ci++) {
            const cx = ci & 1 ? ox1 : ox0, cy = ci & 2 ? oy1 : oy0, cz = ci & 4 ? oz1 : oz0;
            out.push([
                m[0] * cx + m[4] * cy + m[8] * cz + m[12],
                m[1] * cx + m[5] * cy + m[9] * cz + m[13],
                m[2] * cx + m[6] * cy + m[10] * cz + m[14],
            ]);
        }
        return out;
    }

    /** World-space AABB over all listed 3D meshes: {min,max,center,size,count}. Null if the scene has no meshes.
     *  Projection-agnostic — a VOLUME, useful for "keep new objects within the existing footprint". */
    public getSceneBounds3D(): { min: [number, number, number]; max: [number, number, number]; center: [number, number, number]; size: [number, number, number]; count: number } | null {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, count = 0;
        for (const { id } of this.getAllMeshesForAnimation3D()) {
            const corners = this._meshWorldCorners3D(id);
            if (!corners) continue;
            count++;
            for (const [X, Y, Z] of corners) {
                if (X < x0) x0 = X; if (X > x1) x1 = X;
                if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
                if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
            }
        }
        if (!count) return null;
        return {
            min: [x0, y0, z0], max: [x1, y1, z1],
            center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
            size: [x1 - x0, y1 - y0, z1 - z0], count,
        };
    }

    /** Is a mesh currently inside the rendered frame? Projection-AWARE (the camera's view-projection matrix encodes
     *  ortho vs perspective), so callers never need the projection math. True if the mesh's box overlaps the NDC frame. */
    public isMeshInView3D(id: string): boolean {
        const corners = this._meshWorldCorners3D(id);
        if (!corners) return false;
        const vp = this.getCamera3D().getViewProjectionMatrix() as unknown as ArrayLike<number>;
        let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity, anyFront = false;
        for (const [X, Y, Z] of corners) {
            const cw = vp[3] * X + vp[7] * Y + vp[11] * Z + vp[15];
            if (cw <= 0) continue;   // behind the camera (perspective); ortho has w=1 so this never trips
            anyFront = true;
            const ndx = (vp[0] * X + vp[4] * Y + vp[8] * Z + vp[12]) / cw;
            const ndy = (vp[1] * X + vp[5] * Y + vp[9] * Z + vp[13]) / cw;
            if (ndx < nx0) nx0 = ndx; if (ndx > nx1) nx1 = ndx;
            if (ndy < ny0) ny0 = ndy; if (ndy > ny1) ny1 = ndy;
        }
        return anyFront && nx1 >= -1 && nx0 <= 1 && ny1 >= -1 && ny0 <= 1;
    }

    /** The illustration artboard the caller should author within — in the SAME world units meshes use. Everything a
     *  programmatic/AI caller needs to place content in-frame at the right scale:
     *  - `center` — the world point the frame is centred on (place content around this).
     *  - `upAxis: 'y'` — screen-up is +Y (the illustration camera looks down −Z); build vertical things along +Y.
     *  - `min`/`max` — the world-space rectangle visible in the frame (keep object bounds inside this to stay on-canvas).
     *  - `recommendedScale` — the scale a UNIT primitive (size ~1) should get to read at ~10% of the frame height.
     *  Null if the illustration camera has never been synced (no active frame). */
    public getArtboardInfo3D(): {
        center: [number, number, number]; upAxis: 'y'; recommendedScale: number;
        min: [number, number, number]; max: [number, number, number];
        worldWidth: number; worldHeight: number; pixelWidth: number; pixelHeight: number;
        projection: 'perspective' | 'orthographic';
    } | null {
        // The artboard is a FIXED world rectangle centred at the origin (setDocumentSize: worldH=2,
        // worldW=2·aspect) — zoom/pan only move the CAMERA over it. We deliberately anchor to this fixed frame,
        // NOT the transient viewport (1/zoom), so content sized/placed against it survives save→reload: pan/zoom
        // is not persisted, and reload re-fits to the artboard. (Bug: earlier this used the pan/zoom-derived
        // centre + 1/zoom half-height, so fitToFrame baked the build-time zoom and content came back huge.)
        const b = this.webgpuRenderer.getIllustrationBounds?.();
        if (!b) return null;   // no artboard (infinite canvas / not illustration mode)
        const px = this.webgpuRenderer.getIllustrationPixelSize?.();
        const halfW = b.width / 2, halfH = b.height / 2;   // fixed world half-extents, zoom-independent
        const recommendedScale = b.height * 0.1;           // ~10% of the fixed artboard height (zoom-independent)
        return {
            center: [0, 0, 0], upAxis: 'y', recommendedScale,
            min: [-halfW, -halfH, 0], max: [halfW, halfH, 0],
            worldWidth: b.width, worldHeight: b.height,
            pixelWidth: px?.w ?? 0, pixelHeight: px?.h ?? 0,
            projection: this.scene3d.getGlobalScene3DSettings().projection,
        };
    }

    /** Scale + centre ALL 3D content so its bounding box fits inside the illustration frame (with `padding` < 1 =
     *  margin). The guaranteed "compose in-bounds" escape hatch: build at any scale/position, then call this and
     *  everything lands centred and framed. Returns false if there's no content or no active frame. */
    public fitContentToArtboard3D(padding = 0.9): boolean {
        const bounds = this.getSceneBounds3D();
        const art = this.getArtboardInfo3D();
        if (!bounds || !art) return false;
        const halfW = (art.max[0] - art.min[0]) / 2, halfH = (art.max[1] - art.min[1]) / 2;
        const [sx, sy] = bounds.size;
        const sFit = Math.min(sx > 1e-6 ? (2 * halfW * padding) / sx : Infinity, sy > 1e-6 ? (2 * halfH * padding) / sy : Infinity);
        if (!isFinite(sFit) || sFit <= 0) return false;
        const [ccx, ccy, ccz] = bounds.center;
        const [fx, fy, fz] = art.center;
        for (const { id } of this.getAllMeshesForAnimation3D()) {
            const mesh = this.getMesh3D(id);
            if (!mesh) continue;
            mesh.setPosition3D(fx + (mesh.x - ccx) * sFit, fy + (mesh.y - ccy) * sFit, fz + (mesh.z - ccz) * sFit);
            mesh.setScale3D(mesh.scaleX * sFit, mesh.scaleY * sFit, mesh.scaleZ * sFit);
        }
        this.scheduleRender();
        return true;
    }

    /** T7.2 — "RETURN TO THE SCENE" (the 3D fit button beside the zoom controls): frame all VISIBLE scene content
     *  from the current view direction, ignoring far decoration (sky stars/moon, void grid, apron, border glow).
     *  In City mode it frames the CITY. Returns false when there's nothing to frame. Alias: resetView3D. */
    public frameScene3D(padding: number = 1.1): boolean {
        if (this.world?.cityMode && this.world.frameCity(padding)) return true;
        return this.scene3d.frameScene3D({ padding });
    }
    /** Alias of {@link frameScene3D}. */
    public resetView3D(padding: number = 1.1): boolean { return this.frameScene3D(padding); }

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

    /** Host hide / show of the nav gizmo (Toggle UI, viewer mode). Sticky: modes that create the gizmo later keep it
     *  hidden until `setViewGizmoHidden3D(false)`. The gizmo also hides on its own while its canvas is detached or
     *  has no size, and is disposed when the renderer swaps to another canvas (host route change). */
    public setViewGizmoHidden3D(hidden: boolean): void {
        this.scene3d.setViewGizmoHidden(hidden);
    }

    /** True while the nav gizmo exists and is displayed. */
    public isViewGizmoVisible3D(): boolean {
        return this.scene3d.isViewGizmoVisible();
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

    /**
     * Apply the PROCEDURAL GROUND material (procedural-ground.md §2, P1 = ashlar limestone) to a mesh.
     * A shader-generated stone-paver floor — per-tile jittered tint + macro cloud + grout seams + polished
     * edge wear + a height→normal relief + per-tile roughness — with NO stored textures (params only, so it
     * round-trips via Mesh3D.toJSON). Sets the `groundShade` flag (bit 18) + the repurposed pattern slots and
     * clears the exclusive flags (patternMode / boardShade / texOverBase — a mesh is a ground tile OR a panel).
     *
     * ★ UNITS ARE METRES, not UV. The shader recovers world-metres-per-uv-unit from fragment derivatives
     * (gr_uvMetres in mesh3d-shaders), so a 600 mm paver is 600 mm on a plane, on a cube face, and under
     * any non-uniform scale — and grout is the same width along both axes. This replaced an mm→UV
     * conversion against a caller-declared `extentMeters` (default 20), which produced two bugs: applying
     * the material to a mesh that never declares its size tiled it against a fictional 20 m plane, and a
     * single UV grout width rendered thicker on whichever axis the mesh was stretched along.
     * `extentMeters` is accepted and ignored, so existing callers keep compiling.
     */
    /** The procedural surface-material catalog (stone family, grass, dirt, wood plank, cobble, …). Names for
     *  {@link applyGroundMaterial3D} / the AI's setSurfaceMaterial. */
    public surfaceMaterials3D(): string[] { return Object.keys(GROUND_SURFACES); }

    public applyGroundMaterial3D(meshId: string, opts?: { surface?: GroundSurfaceName;
            tileMm?: number; groutMm?: number; tint?: [number, number, number]; extentMeters?: number;
            wedges?: number; ringMm?: number; dirtTint?: [number, number, number];
            weather?: 'new' | 'worn' | 'ancient' | 'mossy' | 'dirty'; wearPath?: [number, number, number]; mossTint?: [number, number, number];
            /** METRES PER WORLD UNIT, for a mesh belonging to a scaled world (the city is a diorama at
             *  1 unit = 15 m). Omit for a standalone mesh authored 1 unit = 1 m with a 0..1-region uv.
             *  Also switches the P2 masks to a world coordinate and drops the edge/corner term. */
            metersPerUnit?: number }): boolean {
        const m = this.scene3d.getMesh(meshId);
        if (!m) return false;
        // ONE source of truth for the recipe arithmetic — the city generator resolves the same way.
        const r = resolveGroundRecipe(opts?.surface, { tileMm: opts?.tileMm, groutMm: opts?.groutMm,
            tint: opts?.tint, wedges: opts?.wedges, ringMm: opts?.ringMm });
        // P2 WEATHERING (procedural-ground §5): profile name → index; scales the four usage-biased masks.
        const WEATHER: Record<string, number> = { new: 0, worn: 1, ancient: 2, mossy: 3, dirty: 4 };
        const weather = WEATHER[opts?.weather ?? 'worn'] ?? 1;
        // ★ MATERIAL-ONLY change → `materialDirty` (see applyMaterialPatch). Flagging `gpuDirty` here was the
        // "Apply Ground does nothing until you click Scatter" bug: the instance-upload fast/incremental paths
        // skip unmoved RESIDENT meshes, so the new ground slots never reached the GPU, and the geometry pass
        // cleared the flag the same frame.
        applyMaterialPatch(m, {
            diffuse: { r: r.tint[0], g: r.tint[1], b: r.tint[2], a: 1 },
            roughness: r.rough, metalness: 0,
            // NOTE: renderStyle is deliberately NOT set — the groundShade branch only computes the base albedo and
            // falls through to the render-style dispatch, so a surface composes with Cel/Toon/etc. Forcing 'default'
            // here used to silently wipe the user's chosen style on Apply Surface.
            groundShade: true,
            groundGrout: { r: r.seam[0], g: r.seam[1], b: r.seam[2], a: r.groutM },   // seam colour; .a = grout width in METRES
            groundTile: r.tile,
            groundJitter: r.jitter,
            groundMode: r.mode,
            groundWorldScale: opts?.metersPerUnit ?? 0,   // 0 = a standalone plane: 1 unit = 1 m, uv IS a 0..1 region
            groundDirtTint: opts?.dirtTint ?? [0.40, 0.31, 0.20],     // P4 bare-path brown (grass mode packs it into the seam slot)
            groundWeather: weather,                                    // 0=new 1=worn 2=ancient 3=mossy 4=dirty
            groundWearPath: opts?.wearPath ?? [0, 0, 0],              // [cx,cy,radiusUv]; radius 0 = noise-only
            groundMossTint: opts?.mossTint ?? [0.30, 0.42, 0.22],    // stored for round-trip; shader constant for now
            patternMode: 'none', boardShade: false, texOverBase: false,
        });
        this.scheduleRender();
        return true;
    }

    /** Remove the procedural SURFACE MATERIAL from a mesh: clears the `groundShade` flag (bit 18) — the sole gate
     *  the shader tests — and resets the base colour/roughness to the material defaults that applyGroundMaterial3D
     *  overwrote. Any diffuse/normal TEXTURE is left intact: because the diffuse texture multiplies OVER the surface
     *  (not replaced by it), clearing the surface leaves a textured mesh showing just its texture (at the default
     *  base). Mirrors applyGroundMaterial3D so a "Clear Surface" control can undo an "Apply Surface". Returns false
     *  if the mesh is gone. NOTE: the base colour resets to the default grey (the pre-surface colour wasn't stored —
     *  Apply had already overwritten it with the surface tint). */
    public clearGroundMaterial3D(meshId: string): boolean {
        const m = this.scene3d.getMesh(meshId);
        if (!m) return false;
        applyMaterialPatch(m, {
            groundShade: false,
            diffuse: { r: 0.8, g: 0.8, b: 0.8, a: 1 },   // DEFAULT_MATERIAL base — texture (if any) multiplies over this
            roughness: 0.5,
        });
        this.scheduleRender();
        return true;
    }

    // ── Procedural GROUND SCATTER (procedural-ground.md §7, P5) ───────────────────────────────────
    private _groundScatterGroups = new Map<string, MeshGroup3D>();

    /**
     * Scatter mask-driven instanced props (flowers / pebbles / twigs / tall-grass clumps / bushes / rocks)
     * over a ground mesh. Density is driven by the SAME weathering masks the ground MATERIAL uses (§1 "one
     * mask, two consumers") — flowers + grass visibly THIN over the wear track, more grass/bush grow in the
     * moist edges. Reuses the shared GPU-instancing path (one canonical geometry + a transform buffer per
     * prop type → a handful of nodes, not thousands of loose meshes). Returns the scatter group id (or null
     * if the mesh doesn't resolve). Vegetation geometry is deliberately LOW-POLY — a later quality pass.
     *
     * @param groundMeshId  the ground plane / deck to scatter over (its world footprint = the scatter rect).
     * @param rules         optional per-type density multipliers + a `wearPath` (defaults to the mesh's own
     *                      material `groundWearPath`, so material + scatter share the track) + a `reject`.
     */
    public scatterOnGround3D(groundMeshId: string, rules?: ScatterRules): string | null {
        const m = this.scene3d.getMesh(groundMeshId);
        if (!m) return null;
        const g = m.geometry;
        if (!g || !g.vertices.length || !g.indices.length) return null;
        // ★ Sample the REAL SURFACE, in the mesh's OWN LOCAL space (bug fix). What this replaced took the local
        // XZ AABB, transformed 4 corners and re-AABB'd them into ONE flat world rectangle at a single `y` — so a
        // rotated / scaled / tilted / non-flat ground got its props laid out on a flat plane, world-up, that then
        // stayed behind whenever the mesh moved. Sampling locally means the scatter group can simply be PARENTED
        // to the mesh: the ground's transform composes into every instance for free (see below).
        // `worldScale` converts the metre-denominated spacing + prop sizes into that local space, so the field
        // still reads as real plants at real spacing whatever the mesh's scale.
        const mtx = m.localMatrix as unknown as Float32Array;
        const col = (i: number): number => Math.hypot(mtx[i], mtx[i + 1], mtx[i + 2]);
        const worldScale = Math.max(1e-6, (col(0) + col(4) + col(8)) / 3);
        const surface = buildScatterSurface(g.vertices, g.indices, { stride: 12, worldScale });
        if (!surface) return null;
        // Share the material's wear track by default (radius 0 → noise-only). Explicit rules.wearPath wins.
        const matPath = m.material.groundWearPath;
        const wearPath = rules?.wearPath ?? (matPath && matPath[2] > 1e-4 ? matPath : null) ?? [0.5, 0.5, 0.4];
        const merged: ScatterRules = { ...PARK_RULES, ...rules, wearPath };
        const seed = (rules?.seed ?? 0x5ca77e2) >>> 0;
        const { layers } = buildScatterLayers(surface, merged, makeRng(seed));
        if (!layers.length) return null;
        const cx = surface.minX + surface.sizeX * 0.5, cz = surface.minZ + surface.sizeZ * 0.5;
        const extent = Math.max(surface.sizeX, surface.sizeZ) * worldScale;
        // ★ PARENT the scatter under the ground mesh's node: moving / rotating / scaling the ground now CARRIES
        // its foliage, with no re-scatter and no per-instance bookkeeping (scene-graph parentChainMatrix does it).
        const group = this.scene3d.addGroundScatterGroup('ground-scatter', layers, [cx, surface.y, cz], extent, m);
        this._groundScatterGroups.set(group.id, group);
        return group.id;
    }

    /** Remove a scatter group created by {@link scatterOnGround3D}. Returns false if the id is unknown. */
    public clearGroundScatter3D(groupId: string): boolean {
        const group = this._groundScatterGroups.get(groupId);
        if (!group) return false;
        this.scene3d.removeGroundScatterGroup(group);
        this._groundScatterGroups.delete(groupId);
        this.scheduleRender();
        return true;
    }

    /** Create a cylinder at (x, y, z). */
    /** Surface of revolution: spin a 2D `profile` silhouette ([radius, y] points, bottom→top) around the Y axis into
     *  a smooth solid — vases, columns, goblets, bottles, finials, smooth tapered spikes. Exact at any radialSegments
     *  (the profile IS the shape). Persisted params-only (regenerates on load). */
    public createRevolve3D(x: number, y: number, z: number, profile: [number, number][], radialSegments = 24, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'revolve', profile, radialSegments, material });
    }

    /** Tube / loft: sweep a circular cross-section of varying radius along a `path` spine ([x,y,z] points) — horns,
     *  tentacles, tree branches, pipes, cables. `radii` = the radius at each path point (single value = constant).
     *  Rotation-minimizing frames avoid twist. Persisted params-only (regenerates on load). */
    public createTube3D(x: number, y: number, z: number, path: [number, number, number][], radii: number[], radialSegments = 12, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'tube', path, radii, radialSegments, material });
    }

    /** Metaballs / SDF: compose an ORGANIC blobby/branching surface from `blobs` (spheres/capsules/… that smoothly
     *  fuse) — the technique for creatures, slime, coral, clouds that box-modeling can't do. `resolution` = grid
     *  cells (8..96; higher = smoother but O(res³)). Persisted params-only (regenerates on load). */
    public createMetaballMesh3D(x: number, y: number, z: number, blobs: import('../scene-graph/shapes/sdf-mesh').SdfBlob[], resolution = 48, material?: Partial<Material3D>, decimate?: number): Mesh3D {
        // decimate ∈ (0,1) = QEM-simplify to that fraction of triangles (leaner render/memory/save). Persisted.
        return this.createMesh3D(x, y, z, { primitive: 'metaball', blobs, resolution, material, decimate });
    }

    /** Procedural CREATURE — a parametric quadruped/biped (dog/cat/horse/lizard/generic) built as smooth-fused
     *  metaballs. `params.species` picks proportions; everything is overridable. When `params.rigged`, also builds a
     *  matching bone skeleton and BINDS the mesh (→ a SkinnedMesh with the same id + a queryable skeleton via
     *  getSkeletonIdForMesh3D) so it can be posed/animated with the rigging tools. Returns the mesh. */
    public createCreature3D(params: import('./managers/creature-generator').CreatureParams, x = 0, y = 0, z = 0, resolution = 56, material?: Partial<Material3D>): Mesh3D {
        // Creatures come out DENSE from surface nets (~12k tris) — decimate to a lean default (0.4 → ~40%) unless
        // the caller overrides. Runs BEFORE rig/displace, so the bind + skin weights use the simplified topology.
        const dec = params.decimate ?? 0.4;
        const mesh = this.createMetaballMesh3D(x, y, z, buildCreatureBlobs(params), resolution, material, dec > 0 && dec < 1 ? dec : undefined);
        // Skin/scale/fur relief — applied BEFORE rigging so the bake feeds the bind (mesh.geometry includes it).
        if (params.roughness && params.roughness > 0) {
            this.addDisplaceModifier3D(mesh.id, { strength: params.roughness, frequency: 3, seed: params.seed ?? 0 });
        }
        // Eyes — small dark spheres on the head (a fused metaball body can't carry a second material). Separate
        // meshes; they don't follow a posed skeleton (v1). Default on; pass eyes:false to omit.
        if (params.eyes !== false) {
            const eyeMat: Partial<Material3D> = { diffuse: { r: 0.04, g: 0.04, b: 0.05, a: 1 }, roughness: 0.25 };
            for (const e of creatureEyes(params)) this.createSphere3D(x + e.pos[0], y + e.pos[1], z + e.pos[2], e.radius, 10, eyeMat);
        }
        if (params.rigged) {
            const skelId = this.createEmptySkeleton3D('creature');
            const joints = buildCreatureSkeleton(params);
            const skelIdx: number[] = [];
            joints.forEach(j => {
                // Root carries the mesh offset (x,y,z); children are parent-relative (offset cancels in the delta) —
                // so every joint's WORLD position matches the mesh's world verts for proximity binding.
                const local: [number, number, number] = j.parent < 0
                    ? [j.pos[0] + x, j.pos[1] + y, j.pos[2] + z]
                    : [j.pos[0] - joints[j.parent].pos[0], j.pos[1] - joints[j.parent].pos[1], j.pos[2] - joints[j.parent].pos[2]];
                skelIdx.push(this.addBone3D(skelId, j.parent < 0 ? -1 : skelIdx[j.parent], local, j.name));
            });
            this.bindMeshToSkeleton3D(mesh.id, skelId);
        }
        return mesh;
    }

    public createCylinder3D(x: number, y: number, z: number, radius = 0.5, height = 1, radialSegments = 16, material?: Partial<Material3D>, radiusTop?: number): Mesh3D {
        // radius = BOTTOM radius; radiusTop (optional) = TOP radius. radiusTop:0 = a cone, radiusTop<radius = a
        // truncated cone / smooth taper (a proper tapered spike), omitted = a straight cylinder. The generator
        // (generateCylinder) is a surface of revolution, so this is exact at any radialSegments — no stepped extrudes.
        return this.createMesh3D(x, y, z, { primitive: 'cylinder', radius, height, radialSegments, material, radiusTop });
    }

    /** Create a torus at (x, y, z). */
    public createTorus3D(x: number, y: number, z: number, radius = 0.5, tubeRadius = 0.2, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh3D(x, y, z, { primitive: 'torus', radius, tubeRadius, material });
    }

    // ── CINEMATIC CAMERAS — placeable camera NODES (docs/specs/cinematic-cameras.md) ─────────────────────────
    // Distinct from createCamera3D() above, which swaps the live RENDER camera. A CameraNode is a scene OBJECT
    // (a marker mesh) whose transform defines a shot — you place/keyframe/sequence it, then preview through it.
    /** Create a placeable CAMERA NODE at (x,y,z) — a small marker mesh whose TRANSFORM defines the shot (rotate
     *  the gizmo to aim; camera looks down its local −Z). Keyframe it like any object to move it; preview it with
     *  lookThroughCamera3D; sequence cameras on the timeline (P3). Returns the node id. */
    public createCameraNode3D(x: number, y: number, z: number, opts?: { name?: string; fov?: number; projection?: 'perspective' | 'orthographic'; near?: number; far?: number }): string {
        const settings: import('../scene-graph/camera-math').CameraSettings = {
            fov: opts?.fov ?? Math.PI / 4, projection: opts?.projection ?? 'perspective', near: opts?.near ?? 0.1, far: opts?.far ?? 100,
        };
        const mesh = this.createMesh3D(x, y, z, {
            primitive: 'box', width: 0.2, height: 0.14, depth: 0.28, isCamera: true, cameraSettings: settings,
            material: { diffuse: { r: 0.14, g: 0.15, b: 0.2, a: 1 }, roughness: 0.5, metalness: 0 },
        });
        mesh.name = opts?.name ?? `Camera ${this.listCameraNodes3D().length}`;   // includes the one just added
        return mesh.id;
    }
    /** Every placeable camera node in the scene. */
    public listCameraNodes3D(): { id: string; name: string; projection: string }[] {
        return this.scene3d.getAllMeshes().filter(m => m.isCamera).map(m => ({ id: m.id, name: m.name, projection: m.cameraSettings?.projection ?? 'perspective' }));
    }
    /** Patch a camera node's settings (fov/projection/near/far). */
    public setCameraNodeSettings3D(id: string, patch: Partial<import('../scene-graph/camera-math').CameraSettings>): boolean {
        const m = this.getMesh3D(id);
        if (!m || !m.isCamera) return false;
        m.setCameraSettings({ ...(m.cameraSettings ?? { fov: Math.PI / 4, projection: 'perspective', near: 0.1, far: 100 }), ...patch });
        this.scheduleRender();
        return true;
    }
    /** Delete a camera node. */
    public deleteCameraNode3D(id: string): void { this.deleteMesh3D(id); }
    /** Keyframe a camera node's FOV (radians) at a frame for an in-shot zoom — thin wrapper over the generic
     *  keyframe setter on the 'fov' track (undoable). Only meaningful on a camera node. */
    public setCameraFovKeyframe3D(id: string, frame: number, fovRadians: number, easing: 'step' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' = 'linear'): boolean {
        return this.setMeshKeyframe3D(id, 'fov', frame, fovRadians, easing);
    }
    /** Attach a HOST-supplied image (e.g. the frog-on-a-cloud) as a camera's billboard marker — it follows the
     *  camera and auto-hides in the shot. Salsa provides the mechanism; Frogmarks provides the asset. Replaces any
     *  existing marker. `size`/`offsetY` in world units. See docs/ui/cinematic-cameras.md. */
    public setCameraMarkerSprite3D(id: string, source: File | Blob | ImageBitmap, opts?: { size?: number; offsetY?: number }): Promise<boolean> {
        return this.scene3d.setCameraMarkerSprite3D(id, source, opts);
    }
    /** Remove a camera's marker sprite (back to the plain box). */
    public removeCameraMarkerSprite3D(id: string): void { this.scene3d.removeCameraMarkerSprite3D(id); }

    // ── CD JEWEL-CASE KIT (docs/specs/cd-jewel-case-designer.md) ──────────────────────────────────────────────
    // A CDKit is the "Complete" view — a root group holding the lid/tray shells + disc + art planes, driven by
    // ONE scrub (closed → lid-open → exploded). The pure geometry/layout lives in src/packaging/cd/*; here is the
    // thin scene adapter (mirrors the PackagingHost pattern). Browser-gated (visual) — pure cores are unit-tested.
    private _cdKits = new Map<string, CDKitState>();
    private _cdKitHostCache: CDKitHost | null = null;
    private get _cdKitHost(): CDKitHost {
        if (this._cdKitHostCache) return this._cdKitHostCache;
        // Emit a FULL material (explicit defaults) so re-applying one on a toggle fully replaces the prior state.
        const toMat = (m: CDPieceMaterial): Partial<Material3D> => ({
            diffuse: m.diffuse, opacity: m.opacity ?? 1, roughness: m.roughness ?? 0.5, metalness: m.metalness ?? 0,
            doubleSided: m.doubleSided ?? false, rimEnabled: m.rimEnabled ?? false, glassEnhance: m.glassEnhance ?? false,
            renderStyle: m.cd ? 'cd' : m.unlit ? 'unlit' : 'default',
        });
        this._cdKitHostCache = {
            createRoot: (name) => {
                const g = this.scene3d.createCityContainer(name);   // thin-wrapper: Outliner shows ONE node
                g.worldParams = { kind: 'cdkit' };                  // keep the City manager from adopting it
                g.scaleX = g.scaleY = g.scaleZ = CD_MM_TO_WORLD;    // children author in mm
                return g.id;
            },
            createMesh: (geometry, material, name, parentId) => {
                const mesh = new Mesh3D(this.interactionService, 0, 0, 0, { primitive: 'custom', geometry, material: toMat(material) });
                mesh.name = name; mesh.gpuDirty = true;
                (this.sceneGraph.findNodeById(parentId) ?? this.sceneGraph.root).addChild(mesh);
                this.emitSceneGraphChanged();
                return mesh.id;
            },
            setTransform: (id, posMm, rotRad) => {
                const n = this.sceneGraph.findNodeById(id) as Mesh3D | null;
                if (!n) return;
                n.setXYZ(posMm[0], posMm[1], posMm[2]);
                n.rotationX = rotRad[0]; n.rotationY = rotRad[1]; n.rotation = rotRad[2];
                n.updateLocalMatrix();
                this.scene3d.notifyMeshTransformsChanged3D();       // arm the transforms-only GPU fast path
            },
            // Route art uploads through the UV-paint texture store (keyed by mesh id) so they persist for FREE via
            // the existing meshTextures path: a CD piece is a named child of a documentSkipChildren+worldParams
            // container, so _procMeshKey saves it as `__proc__:rootId:pieceName` and _restoreProceduralMeshTextures
            // re-attaches it after the kit rebuilds on load.
            setTexture: (id, source) => this._uploadCDPieceTexture(id, source as File | Blob | ImageBitmap),
            setMaterial: (id, material) => {
                const mesh = this.sceneGraph.findNodeById(id) as Mesh3D | null;
                if (!mesh) return;
                Object.assign(mesh.material, toMat(material));
                mesh.materialDirty = true; mesh.gpuDirty = true;
                this.scheduleRender();
            },
            setGeometry: (id, geometry) => {
                const mesh = this.sceneGraph.findNodeById(id) as Mesh3D | null;
                if (!mesh) return;
                mesh.setGeometry(geometry);
                mesh.gpuDirty = true;
                this.scheduleRender();
            },
            removeNode: (id) => this.scene3d.disposePackagingSubtree(id),
        };
        return this._cdKitHostCache;
    }

    /** Upload an image onto a CD piece via the UV-paint texture store (so it round-trips through save/load). */
    private async _uploadCDPieceTexture(meshId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        const device = this.webgpuRenderer?.getDevice();
        const mesh = this.scene3d?.getMesh(meshId);
        if (!device || !mesh) return false;
        try {
            const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
            let mgr = this._uvPaintTextures.get(meshId);
            if (!mgr) { mgr = new RasterTextureManager(device); this._uvPaintTextures.set(meshId, mgr); }
            const tex = mgr.ensureTexture(bitmap.width, bitmap.height);
            device.queue.copyExternalImageToTexture({ source: bitmap, flipY: false }, { texture: tex }, [bitmap.width, bitmap.height]);
            bumpGpuPixelEpoch('none', tex);   // GPU-only pixels changed (device-lost shadow; incremental autosave: this texture)
            mesh.diffuseTexture = tex; mesh.material.hasTexture = true; mesh.gpuDirty = true;
            this.scheduleRender();
            return true;
        } catch (e) { console.warn('[CDKit] upload piece texture failed', e); return false; }
    }

    /** Stamp the kit root's worldParams marker so the structure + scrub survive a document save (the pieces are
     *  regenerated on load; only the root node persists — like packaging). */
    private _stampCDKit(state: CDKitState): void {
        const root = this.sceneGraph.findNodeById(state.rootId) as MeshGroup3D | null;
        if (root) root.worldParams = { kind: 'cdkit', entry: { scrub: state.scrub, clearTray: state.clearTray } };
    }

    /** Rebuild every saved CD kit after a document load (scan cdkit-marked roots → regenerate pieces + apply scrub).
     *  Called inside restoreProceduralFromSave3D so it runs BEFORE the proc-texture re-apply that restores the art. */
    public restoreCDKitsFromSave3D(): number {
        if (!this.scene3d) return 0;
        let n = 0;
        for (const root of this.scene3d.getRootMeshGroups()) {
            const wp = root.worldParams as { kind?: string; entry?: { scrub?: number; clearTray?: boolean } } | undefined;
            if (wp?.kind !== 'cdkit' || this._cdKits.has(root.id)) continue;
            root.scaleX = root.scaleY = root.scaleZ = CD_MM_TO_WORLD;   // re-assert mm scale (idempotent)
            const state = rebuildCDKitUnderRoot(this._cdKitHost, root.id, wp.entry?.scrub ?? 0, undefined, wp.entry?.clearTray ?? false);
            this._cdKits.set(root.id, state);
            n++;
        }
        if (n) { this._syncCDGlassRefraction(); this.scheduleRender(); }
        return n;
    }

    /** Create a CD jewel-case kit at (x,y,z) — the whole Complete assembly (case + disc + art pieces). `clearTray`
     *  gives the all-clear case instead of the black tray. Returns the root id + per-piece node ids. */
    public createCDKit3D(x = 0, y = 0, z = 0, opts?: { clearTray?: boolean }): { rootId: string; pieces: Record<CDPiece, string> } {
        const state = createCDKit(this._cdKitHost, undefined, opts?.clearTray ?? false);
        const root = this.sceneGraph.findNodeById(state.rootId) as MeshGroup3D | null;
        root?.setXYZ(x, y, z);
        this._cdKits.set(state.rootId, state);
        this._stampCDKit(state);
        this._syncCDGlassRefraction();
        this.scheduleRender();
        return { rootId: state.rootId, pieces: { ...state.pieces } };
    }
    /** Turn screen-space glass refraction on only while a CD kit exists. City glazing also sets glassEnhance, so
     *  refraction is scoped by this scene flag (resolution.w) to avoid changing the city's look. */
    private _syncCDGlassRefraction(): void {
        this.renderer3D.setGlassRefraction(this._cdKits.size > 0);
    }
    /** Toggle the case between the classic black tray and all-clear. */
    public setCDTrayClear3D(rootId: string, clear: boolean): boolean {
        const s = this._cdKits.get(rootId);
        if (!s) return false;
        setCDTrayClear(this._cdKitHost, s, clear);
        this._stampCDKit(s);   // persist the choice
        this.scheduleRender();
        return true;
    }
    /** Whether a kit is all-clear (clear tray). */
    public isCDTrayClear3D(rootId: string): boolean { return this._cdKits.get(rootId)?.clearTray ?? false; }
    /** Fold the tray card's spine flaps (0 flat → 1 folded 90°). Used by the Tray Card view's own fold slider;
     *  in Complete view the flaps auto-straighten with the open scrub. */
    public setCDTrayCardFold3D(rootId: string, fold: number): boolean {
        const s = this._cdKits.get(rootId);
        if (!s) return false;
        setCDTrayCardFold(this._cdKitHost, s, fold);
        return true;
    }
    /** Current tray-card fold (0..1). */
    public getCDTrayCardFold3D(rootId: string): number { return this._cdKits.get(rootId)?.trayCardFold ?? 0; }
    /** Scrub the Complete assembly: 0 = closed case → lid opens → 1 = exploded. */
    public setCDKitScrub3D(rootId: string, t: number): boolean {
        const s = this._cdKits.get(rootId);
        if (!s) return false;
        setCDKitScrub(this._cdKitHost, s, t);
        this._stampCDKit(s);   // persist the new scrub
        return true;
    }
    /** Map an uploaded image onto one printed piece (frontInsert / trayCard / disc / booklet). */
    public setCDPieceArt3D(rootId: string, piece: CDPiece, source: File | Blob | ImageBitmap): Promise<boolean> {
        const s = this._cdKits.get(rootId);
        if (!s) return Promise.resolve(false);
        return setCDPieceArt(this._cdKitHost, s, piece, source);
    }
    /** Delete a CD kit (whole subtree). */
    public deleteCDKit3D(rootId: string): boolean {
        const s = this._cdKits.get(rootId);
        if (!s) return false;
        if (this._cdDesigner?.rootId === rootId) this.exitCDDesigner3D();
        const root = this.sceneGraph.findNodeById(rootId);
        const savedParent = root?.parent ?? this.sceneGraph.root;

        // Detach (NOT destroy): removeCDKit → disposePackagingSubtree removes the subtree from the graph and evicts
        // GPU caches, but KEEPS the node objects, geometry, and each piece's uv-paint art texture alive. So undo can
        // re-add the exact same kit (same ids → art re-links for free) and just re-mark the pieces dirty to rebuild
        // the evicted caches. Mirrors scene3d deleteMesh's detach-and-evict + undo.
        const detach = () => {
            removeCDKit(this._cdKitHost, s);
            this._cdKits.delete(rootId);
            this._syncCDGlassRefraction();   // turn refraction back off if that was the last kit
        };
        const reattach = () => {
            if (!root) return;
            savedParent.addChild(root);
            for (const pieceId of Object.values(s.pieces)) {
                const m = this.sceneGraph.findNodeById(pieceId) as Mesh3D | null;
                if (m) m.gpuDirty = true;   // rebuild the GPU caches evicted on delete
            }
            this._cdKits.set(rootId, s);
            this._syncCDGlassRefraction();   // first kit back → glass refraction on
            this.emitSceneGraphChanged();
            this.scheduleRender();
        };

        detach();
        if (root) this.scene3d.pushCommand3D({ description: 'Delete CD Kit', undo: reattach, redo: detach });
        return true;
    }

    // ── CD DESIGNER MODE (the creator-mode shell: isolate → stage → component targeting) ──────────────────────
    // Mirrors the Package Creator: enter isolates the scene to the kit, frames+orbits it, and starts on the
    // "Complete" component (scrub opens/explodes). The component dropdown switches to a single piece — hides the
    // others, lays that piece flat-on, and frames it for art upload. Browser-gated; component logic is unit-tested.
    private _cdDesigner: { rootId: string; component: CDComponent } | null = null;
    private _cdIsoMemory: Map<string, boolean> | null = null;

    /** Enter the CD designer for a kit: 3D on, isolate the scene to it, frame it, start on Complete. */
    public enterCDDesigner3D(rootId: string): boolean {
        const state = this._cdKits.get(rootId);
        if (!state) return false;
        this.scene3DVisible = true;
        this.webgpuRenderer?.setArtboardClipEnabled(false);   // the 3D kit extends past any flat-doc rect
        this._cdIsolateTo(rootId);
        this.interactionService.suppressBoxSelect = true;
        this._cdDesigner = { rootId, component: 'complete' };
        this._applyCDComponent(state, 'complete');
        this.scheduleRender();
        return true;
    }

    /** Leave the CD designer: restore the assembly + scene, stop orbit. */
    public exitCDDesigner3D(): void {
        if (!this._cdDesigner) return;
        const state = this._cdKits.get(this._cdDesigner.rootId);
        if (state) this._cdRestoreAssembly(state);   // un-flatten any focused piece, show all pieces
        this.scene3d.exitMeshOrbit3D();
        this.webgpuRenderer?.setArtboardClipEnabled(true);
        this.interactionService.suppressBoxSelect = false;
        this._cdRestoreIsolation();
        this._cdDesigner = null;
        this.scheduleRender();
    }

    /** Switch the active component: 'complete' (assembly + scrub) or one printed piece (isolated, flat-on, the
     *  art-upload target). */
    public setCDActiveComponent3D(component: CDComponent): boolean {
        if (!this._cdDesigner) return false;
        const state = this._cdKits.get(this._cdDesigner.rootId);
        if (!state) return false;
        this._cdDesigner.component = component;
        this._applyCDComponent(state, component);
        return true;
    }

    public get isCDDesignerActive3D(): boolean { return this._cdDesigner !== null; }
    public getCDActiveComponent3D(): CDComponent | null { return this._cdDesigner?.component ?? null; }
    public getCDDesignerRootId3D(): string | null { return this._cdDesigner?.rootId ?? null; }
    /** The node id of the current art-upload target (the focused piece), or null in Complete. */
    public getCDActivePieceNode3D(): string | null {
        if (!this._cdDesigner) return null;
        const view = cdComponentView(this._cdDesigner.component);
        const state = this._cdKits.get(this._cdDesigner.rootId);
        return view.focusPiece && state ? state.pieces[view.focusPiece] : null;
    }

    private _applyCDComponent(state: CDKitState, component: CDComponent): void {
        const view = cdComponentView(component);
        const visSet = new Set(view.visiblePieces);
        for (const piece of CD_ALL_PIECES) {
            const n = this.sceneGraph.findNodeById(state.pieces[piece]);
            if (n) n.forEachDeep(d => { d.visible = visSet.has(piece); });
        }
        if (view.focusPiece) {
            // Editing one piece: lay it flat at the kit origin, facing the camera, and frame it.
            const pid = state.pieces[view.focusPiece];
            // The Tray Card view shows it FLAT by default (fold 0) — its own slider folds the flaps from there.
            if (view.focusPiece === 'trayCard') setCDTrayCardFold(this._cdKitHost, state, 0);
            const n = this.sceneGraph.findNodeById(pid) as Mesh3D | null;
            if (n) { n.setXYZ(0, 0, 0); n.rotationX = 0; n.rotationY = 0; n.rotation = 0; n.updateLocalMatrix(); this.scene3d.notifyMeshTransformsChanged3D(); }
            this.scene3d.enterGroupOrbit3D(pid, { azimuth: 0, elevation: 0.12, padding: 1.25 });   // near flat-on
        } else {
            // Complete: reposition every piece at the current scrub, frame the whole kit 3/4.
            setCDKitScrub(this._cdKitHost, state, state.scrub);
            this.scene3d.enterGroupOrbit3D(state.rootId, { azimuth: Math.PI * 0.15, elevation: 0.9, padding: 1.6 });
        }
        this.emitSceneGraphChanged();
        this.scheduleRender();
    }

    /** Show all pieces + re-apply the assembly pose (undo a single-piece flatten). */
    private _cdRestoreAssembly(state: CDKitState): void {
        for (const piece of CD_ALL_PIECES) {
            const n = this.sceneGraph.findNodeById(state.pieces[piece]);
            if (n) n.forEachDeep(d => { d.visible = true; });
        }
        setCDKitScrub(this._cdKitHost, state, state.scrub);
        this.emitSceneGraphChanged();
    }

    /** Hide every top-level scene object except the kit (remember prior visibility for restore). */
    private _cdIsolateTo(keepRootId: string): void {
        this._cdRestoreIsolation();
        const mem = new Map<string, boolean>();
        for (const child of [...this.sceneGraph.root.children]) {
            const cid = (child as unknown as { id: string }).id;
            if (cid === keepRootId) continue;
            mem.set(cid, (child as unknown as { visible: boolean }).visible);
            child.forEachDeep(d => { d.visible = false; });
        }
        this._cdIsoMemory = mem;
        this.emitSceneGraphChanged();
    }
    private _cdRestoreIsolation(): void {
        if (!this._cdIsoMemory) return;
        for (const [id, vis] of this._cdIsoMemory) {
            const n = this.sceneGraph.findNodeById(id);
            if (n) n.forEachDeep(d => { d.visible = vis; });
        }
        this._cdIsoMemory = null;
        this.emitSceneGraphChanged();
    }

    // ── CD PRINT EXPORT (docs/specs/cd-jewel-case-designer.md §4) ─────────────────────────────────────────────
    // Render one printed piece's uploaded art onto a canvas at its EXACT dieline size + DPI (default 300), so the
    // output is print-correct. Marks (crop/fold/bleed/safe) are optional — off = the clean print art, on = a proof.
    // The engine emits PNG blobs; the HOST muxes them into a print PDF (jsPDF / a print service), like the
    // cinematic export hands off frames. Pure sizing/marks live in cd-print.ts (unit-tested).
    /** Render one printed piece onto a white canvas at its exact print pixel size (shared by the PNG + PDF paths). */
    private async _renderCDPrintCanvas(rootId: string, piece: CDPiece, opts?: { marks?: boolean; dpi?: number }):
        Promise<{ canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D; spec: CDPrintSpec } | null> {
        const state = this._cdKits.get(rootId);
        if (!state) return null;
        let spec: CDPrintSpec;
        try { spec = cdPrintSpec(piece, opts?.dpi ?? 300); } catch { return null; }   // not a printed piece
        const canvas = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(spec.widthPx, spec.heightPx)
            : Object.assign(document.createElement('canvas'), { width: spec.widthPx, height: spec.heightPx });
        const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d') as CanvasRenderingContext2D | null;
        if (!ctx) return null;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, spec.widthPx, spec.heightPx);
        // Draw the uploaded art (stored in the UV-paint texture store), scaled to fill the dieline.
        const mgr = this._uvPaintTextures.get(state.pieces[piece]);
        if (mgr?.getTexture()) {
            try {
                const bmp = await createImageBitmap(await mgr.exportToBlob('image/png'));
                ctx.drawImage(bmp, 0, 0, spec.widthPx, spec.heightPx);
            } catch (e) { console.warn('[CDKit] print: art draw failed', e); }
        }
        if (opts?.marks) this._drawCDPrintMarks(ctx, spec);
        return { canvas, ctx, spec };
    }

    /** Export one printed piece (frontInsert / trayCard / disc / booklet) as a print-ready PNG. Null for a kit that
     *  doesn't exist or a non-printed piece. */
    public async exportCDPiecePrint3D(rootId: string, piece: CDPiece, opts?: { marks?: boolean; dpi?: number }): Promise<Blob | null> {
        const r = await this._renderCDPrintCanvas(rootId, piece, opts);
        if (!r) return null;
        return 'convertToBlob' in r.canvas
            ? (r.canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' })
            : new Promise<Blob>(res => (r.canvas as HTMLCanvasElement).toBlob(b => res(b!), 'image/png'));
    }

    /** Export the whole kit as ONE print-ready multi-page PDF (spec §4): one page per printed piece, each page
     *  sized to the piece's REAL millimetre dieline (print at "actual size" reproduces it 1:1), the art embedded
     *  losslessly at the render DPI (default 300). `marks: true` bakes crop/fold/bleed/safe guides in (a proof);
     *  omit for the clean files a print partner wants. Null when the kit doesn't exist / nothing renders. */
    public async exportCDKitPrintPDF3D(rootId: string, opts?: { marks?: boolean; dpi?: number; title?: string }): Promise<Blob | null> {
        const pages: import('../packaging/print-pdf').PrintPdfPage[] = [];
        for (const piece of CD_PRINT_PIECES) {
            const r = await this._renderCDPrintCanvas(rootId, piece, opts);
            if (!r) continue;
            const data = r.ctx.getImageData(0, 0, r.spec.widthPx, r.spec.heightPx);
            pages.push({
                rgb: rgbaToRgb(data.data, r.spec.widthPx, r.spec.heightPx),
                widthPx: r.spec.widthPx, heightPx: r.spec.heightPx,
                widthMm: r.spec.widthMm, heightMm: r.spec.heightMm,
            });
        }
        if (!pages.length) return null;
        const bytes = buildPrintPdf(pages, { title: opts?.title ?? 'CD Print Set', producer: 'Salsa CD Designer' });
        return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
    }

    private _drawCDPrintMarks(ctx: CanvasRenderingContext2D, spec: CDPrintSpec): void {
        ctx.lineWidth = Math.max(1, Math.round(spec.dpi / 150));
        for (const m of spec.marks) {
            ctx.strokeStyle = m.color;
            for (const [a, b] of m.lines) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
            for (const ci of m.circles) { ctx.beginPath(); ctx.arc(ci.cx, ci.cy, ci.r, 0, Math.PI * 2); ctx.stroke(); }
        }
    }

    /** Export ALL four printed pieces as print-ready PNGs + their physical size. The host assembles the print PDF. */
    public async exportCDKitPrintSet3D(rootId: string, opts?: { marks?: boolean; dpi?: number }): Promise<{ piece: CDPiece; blob: Blob; widthMm: number; heightMm: number; dpi: number }[]> {
        const out: { piece: CDPiece; blob: Blob; widthMm: number; heightMm: number; dpi: number }[] = [];
        for (const piece of CD_PRINT_PIECES) {
            const blob = await this.exportCDPiecePrint3D(rootId, piece, opts);
            if (blob) { const spec = cdPrintSpec(piece, opts?.dpi ?? 300); out.push({ piece, blob, widthMm: spec.widthMm, heightMm: spec.heightMm, dpi: spec.dpi }); }
        }
        return out;
    }
    /** Preview the render camera THROUGH a camera node (null = restore the edit camera). Static — re-call after
     *  moving the camera to refresh. */
    public lookThroughCamera3D(id: string | null): void { this.scene3d.lookThroughCamera3D(id); }
    /** The camera node currently being looked through (or null). */
    public get lookThroughCameraId3D(): string | null { return this.scene3d.lookThroughCameraId3D; }

    // ── Cinematic camera CUTS + timeline preview (docs/specs/cinematic-cameras.md §3-4) ──────────────────────
    /** Add/replace the cut at `frame` → "from here, the timeline shows camera `cameraId`". */
    public setCameraCut3D(frame: number, cameraId: string): void { this.scene3d.setCameraCut3D(frame, cameraId); }
    /** Remove the cut at `frame`. */
    public removeCameraCut3D(frame: number): void { this.scene3d.removeCameraCut3D(frame); }
    /** The current cut list (frame-sorted, read-only). Read on SAVE to persist. */
    public getCameraCuts3D(): readonly { frame: number; cameraId: string }[] { return this.scene3d.getCameraCuts3D(); }
    /** Replace the whole cut list — the LOAD path (restore a saved document). Not undoable; fires onCameraCutsChanged3D. */
    public setCameraCuts3D(cuts: { frame: number; cameraId: string }[]): void { this.scene3d.setCameraCuts3D(cuts); }
    /** Remove every cut (undoable). */
    public clearCameraCuts3D(): void { this.scene3d.clearCameraCuts3D(); }
    /** Fires whenever the cut list changes — user edit, UNDO/REDO, or a camera deletion. Refresh the timeline
     *  "Cameras" lane off this instead of polling. */
    public get onCameraCutsChanged3D(): import('../renderer/util/event-emitter').EventEmitter<void> { return this.scene3d.onCameraCutsChanged; }
    /** Toggle previewing the animation THROUGH the placed cameras (cuts drive which camera each frame). */
    public setPreviewThroughCameras3D(on: boolean): void { this.scene3d.setPreviewThroughCameras3D(on); }
    /** Whether cut-driven camera preview is on. */
    public get previewThroughCameras3D(): boolean { return this.scene3d.previewThroughCameras3D; }
    /** P4 video export: deterministically render the cut sequence through the placed cameras, one PNG Blob per frame
     *  to `onFrame` (the host muxes them to WebM/MP4). Returns clip metadata. See docs/specs/cinematic-cameras.md §7. */
    public exportCinematicFrames3D(
        opts: import('./managers/cinematic-export').CinematicExportOptions,
        onFrame: (frame: Blob, index: number, total: number) => void | Promise<void>,
    ): Promise<{ frameCount: number; fps: number; width: number; height: number; durationSec: number }> {
        return this.scene3d.exportCinematicFrames3D(opts, onFrame);
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

    /** Extract a mesh's triangles in WORLD space (position only) for CSG. */
    private _meshWorldTris3D(mesh: Mesh3D): Tri[] {
        const g = mesh.geometry;
        const m = mesh.localMatrix as unknown as ArrayLike<number>;
        const V = g.vertices, stride = g.format === '8float' ? 8 : 12;
        const tp = (idx: number): [number, number, number] => {
            const o = idx * stride, x = V[o], y = V[o + 1], z = V[o + 2];
            return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        };
        const tris: Tri[] = [], idc = g.indices;
        for (let k = 0; k < idc.length; k += 3) tris.push({ a: tp(idc[k]), b: tp(idc[k + 1]), c: tp(idc[k + 2]) });
        return tris;
    }

    /** Boolean CSG between two meshes → a NEW mesh (union / subtract / intersect). `subtract` removes B from A.
     *  Inputs should be closed/manifold solids. By default the operands are consumed (deleted); pass
     *  `keepOperands:true` to keep them. Returns the new mesh id, or null on failure / empty result. */
    public booleanMesh3D(idA: string, idB: string, op: BooleanOp, opts?: { keepOperands?: boolean }): string | null {
        const A = this.getMesh3D(idA), B = this.getMesh3D(idB);
        if (!A || !B) return null;
        const trisA = this._meshWorldTris3D(A), trisB = this._meshWorldTris3D(B);
        const CAP = 40000;   // BSP CSG is superlinear — guard against a pathological hang on huge meshes
        if (trisA.length > CAP || trisB.length > CAP) { console.warn(`[ShapeManager] booleanMesh3D: mesh too large (${trisA.length}/${trisB.length} tris > ${CAP}) — skipped`); return null; }
        const res = booleanMesh(trisA, trisB, op);
        if (!res.positions.length) return null;
        const n = res.positions.length;
        const verts = new Float32Array(n * 8);
        for (let i = 0; i < n; i++) {
            const p = res.positions[i], nr = res.normals[i], o = i * 8;
            verts[o] = p[0]; verts[o + 1] = p[1]; verts[o + 2] = p[2];
            verts[o + 3] = nr[0]; verts[o + 4] = nr[1]; verts[o + 5] = nr[2];
            verts[o + 6] = 0; verts[o + 7] = 0;
        }
        const indices = new Uint32Array(n);
        for (let i = 0; i < n; i++) indices[i] = i;
        const mesh = this.createCustomMesh3D(0, 0, 0, { vertices: verts, indices, format: '8float' }, A.material);
        if (opts?.keepOperands !== true) { this.deleteMesh3D(idA); this.deleteMesh3D(idB); }
        return mesh.id;
    }

    /**
     * QEM-DECIMATE a mesh in place: keep ~`targetRatio` (0..1) of its triangles. Curvature-adaptive (flat areas
     * collapse, detail is preserved) — leaner render/memory/save with the same silhouette. Great on dense
     * metaball/creature/boolean geometry. Destructive but UNDOABLE (Ctrl-Z restores the dense mesh). UVs are
     * dropped (re-unwrap with autoUnwrap3D if the mesh is textured). Returns true if it simplified anything.
     */
    public simplifyMesh3D(meshId: string, targetRatio: number): boolean {
        const mesh = this.getMesh3D(meshId);
        if (!mesh) return false;
        const before = mesh.geometry;
        if (!before || before.indices.length < 12) return false;
        const simplified = simplifyGeometry(before, targetRatio);
        if (simplified.indices.length === 0 || simplified.indices.length >= before.indices.length) return false;   // nothing gained
        // Snapshot the CURRENT geometry (independent typed-array copies) so undo restores the dense mesh exactly.
        const snap: MeshGeometry = { vertices: before.vertices.slice(), indices: before.indices.slice(), format: before.format };
        const apply = (g: MeshGeometry): void => { mesh.setGeometry(g); this.scheduleRender(); };
        apply(simplified);
        this.scene3d.pushCommand3D({ description: 'Decimate mesh', undo: () => apply(snap), redo: () => apply(simplified) });
        return true;
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
     * enterBonePlacementMode3D), or null.  Re-read after every sceneGraphChanged event.
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

    // ── Animation Library (docs/specs/animation-library-and-triggers.md, Phase A) ──────────────────
    // Promote authored clips/poses into a reusable, cross-skeleton library, then apply any entry to any
    // creature via joint-name retargeting. Host UI: docs/ui/animation-library.md.

    /** Promote a clip into the Animation Library → entry id (null if the clip isn't found). */
    public addClipToLibrary3D(clipId: string, opts?: { name?: string; tags?: string[] }): string | null {
        return this.scene3d.addClipToLibrary3D(clipId, opts);
    }
    /** Promote a pose into the Animation Library → entry id. */
    public addPoseToLibrary3D(skeletonId: string, poseId: string, opts?: { name?: string; tags?: string[] }): string | null {
        return this.scene3d.addPoseToLibrary3D(skeletonId, poseId, opts);
    }
    /** All Animation Library entries (copies) for the host panel. */
    public getAnimationLibrary3D() { return this.scene3d.getAnimationLibrary3D(); }
    /** Apply a library entry to a skeleton (joint-name retarget) → new clip/pose id (null on fail / zero matches). */
    public applyLibraryEntry3D(entryId: string, targetSkeletonId: string, opts?: { rename?: string }): string | null {
        return this.scene3d.applyLibraryEntry3D(entryId, targetSkeletonId, opts);
    }
    /** Preflight compatibility {matched, missing[]} of applying an entry to a skeleton (UI chip). */
    public libraryCompatibility3D(entryId: string, skeletonId: string): { matched: number; missing: string[] } | null {
        return this.scene3d.libraryCompatibility3D(entryId, skeletonId);
    }
    public removeLibraryEntry3D(entryId: string): boolean { return this.scene3d.removeLibraryEntry3D(entryId); }
    public renameLibraryEntry3D(entryId: string, name: string): boolean { return this.scene3d.renameLibraryEntry3D(entryId, name); }
    /** Override a library entry's rig-type label ('humanoid' | 'creature' | …). Filter/grouping only. */
    public setLibraryEntryRigType3D(entryId: string, rigType: string): boolean { return this.scene3d.setLibraryEntryRigType3D(entryId, rigType); }
    /** A skeleton's coarse rig type (joint-signature classification) — pre-filter the panel to likely-fit entries. */
    public getSkeletonRigType3D(skeletonId: string): string | null { return this.scene3d.getSkeletonRigType3D(skeletonId); }
    /** Export the Animation Library as JSON (cross-document reuse). */
    public exportAnimationLibrary3D(): string { return this.scene3d.exportAnimationLibrary3D(); }
    /** Import an Animation Library JSON. `merge` appends (fresh ids); default replaces. Returns new entry ids. */
    public importAnimationLibrary3D(json: string, opts?: { merge?: boolean }): string[] {
        return this.scene3d.importAnimationLibrary3D(json, opts);
    }

    /** Set the render style on a mesh ('default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' | 'unlit'). */
    public setRenderStyle3D(nodeId: string, style: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' | 'unlit'): boolean {
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
    /** "Is a character body" — a v1 procedural body OR a Character v2 body (docs/specs/character-v2.md review fixes).
     *  Use it where the UI means "a character" (hide Bind Mesh, outliner character grouping); isProceduralBody3D keeps
     *  meaning "has v1 bodyParams" (the v1 creator panel). */
    public isCharacterBody3D(meshId: string): boolean { return this.scene3d.isCharacterBody3D(meshId); }
    public isCharacterBodySkeleton3D(skeletonId: string): boolean { return this.scene3d.isCharacterBodySkeleton3D(skeletonId); }

    /** Destroy + drop a mesh's uv-paint texture (frees its GPUTexture). The `_uvPaintTextures` map is the SOLE owner
     *  (DecalManager only reads/creates), so this is the one place that frees them. Use ONLY at true removals — NOT
     *  the regen "move" (old→new id) at ~7710, where the manager is reused. */
    private _disposeUvPaintTexture(meshId: string): void {
        const m = this._uvPaintTextures.get(meshId);
        if (m) { m.destroy(); this._uvPaintTextures.delete(meshId); }
    }
    /** Destroy + clear every uv-paint texture (e.g. on document reload, before the new doc's textures load). */
    private _disposeAllUvPaintTextures(): void {
        for (const m of this._uvPaintTextures.values()) m.destroy();
        this._uvPaintTextures.clear();
    }

    /** Delete a mesh by node ID. */
    public deleteMesh3D(nodeId: string): boolean {
        // If this node belongs to a package (root group, a panel, or a hinge pivot), delete the WHOLE package
        // through the packaging manager so it tears down properly — unlinks live textures, removes the composite,
        // deletes the hidden dieline/stack layers, and disposes the subtree. The generic delete would orphan all of
        // that (and even lift the panels to the scene root). See deleteMeshGroup3D for the group-node entry.
        if (this._cdKits.has(nodeId)) return this.deleteCDKit3D(nodeId);
        const pkgId = this._packaging?.isPackageNode(nodeId);
        if (pkgId) { this._packaging!.remove(pkgId); return true; }
        // Free any uv-paint texture(s) owned by this mesh (+ procedural parts) before deleting — else the GPUTexture
        // leaks AND a dead entry gets written into every save (B1/B2, eval 2026-09-02).
        this._disposeUvPaintTexture(nodeId);
        for (const partId of this.scene3d.getProceduralBodyParts(nodeId)) this._disposeUvPaintTexture(partId);
        return this.scene3d.deleteMesh(nodeId);
    }

    // DISABLED (2026-08-18): deliberately NOT exposing a bulk scene-clear to the AI — an AI misreading "make me X"
    // as "start fresh" could wipe hours of a user's work irreversibly. Clearing the scene is a USER action (the
    // "New" button), never an AI decision. Left commented for reference; do not re-expose without an undo/confirm gate.
    // public clearScene3D(): number {
    //     this.beginSceneGraphBatch3D();
    //     let n = 0;
    //     try {
    //         for (const { id } of this.getAllMeshesForAnimation3D()) {
    //             if (this.deleteMesh3D(id)) n++;
    //         }
    //     } finally { this.endSceneGraphBatch3D(); }
    //     return n;
    // }

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
        for (const id of [bodyMeshId, ...this.scene3d.getProceduralBodyParts(bodyMeshId)]) this._disposeUvPaintTexture(id);   // destroy, not just drop (B1)
        return this.scene3d.deleteProceduralBody(bodyMeshId);
    }

    public _packaging?: PackagingManager;
    /** rAF handle for the Package-Creator ambience ticker (animated stage bg while the mode is active). */
    public _creatorTickRaf = 0;
    /** Package-Creator FULL-SCENE isolation memory: top-level scene object id → its visibility before
     *  the mode hid everything except the edited box. null when not isolating. */
    public _packagingIsoMemory: Map<string, boolean> | null = null;
    /** Package-Creator STAGE LIGHTING memory: the scene's ambient + key light captured on enter and
     *  swapped for neutral studio light (the default ambient is blue-tinted → a white box reads
     *  lavender); restored on exit. null when not staged. */
    public _stagePrevLight: { ambient: { color: [number, number, number]; intensity: number }; directional: ReturnType<ShapeManager['getLight3D']> } | null = null;

    // ── CreatorStage (procedural creators: vending / bike-rack / bollard / foliage) ──────────────────
    // A focus stage for the creator system, built from the SAME public scene primitives packaging's stage
    // uses (enterGroupOrbit3D, studio bg/lighting, view gizmo, drift, ambience tick) but with its OWN state
    // so it touches NO packaging code — packaging keeps its bespoke stage. See docs/specs/creator-modes.md
    // §5.3. Fields mirror the packaging stage's memory (isolation / rotation / bg / lighting / ticker).
    private _creatorStageNodeId: string | null = null;
    private _creatorStageIso: Map<string, boolean> | null = null;
    private _creatorStageSavedRot: { id: string; rx: number; ry: number; rz: number } | null = null;
    private _creatorStagePrevBg: import('../types/armature-3d').ArmatureBgOptions | null = null;
    private _creatorStagePrevLight: { ambient: { color: [number, number, number]; intensity: number }; directional: ReturnType<ShapeManager['getLight3D']> } | null = null;
    private _creatorStageTickRaf = 0;
    /**
     * Optional Packaging module — `sm.packaging?.create('simpleBox', {width,height,depth})`,
     * `.setFoldAmount(id, 0..1)`, `.fold(id)`, `.setDimensions(id, params)`. Gated by
     * `PACKAGING_ENABLED` (returns null when off — the module is fully removable). The box is a
     * RIGID-PANEL node hierarchy (root container + 6 flat panel meshes under per-panel hinge pivots);
     * folding rotates the pivot nodes (pure transforms — no geometry re-upload). See docs/specs/packaging-system.md.
     */
    private _authoring?: SceneAuthoringAPI;
    /** The curated, stable AI/programmatic scene-authoring façade (see scene-authoring-api.ts + docs/specs/
     *  god-object-status-and-mcp.md §5). Lazily created; the AI contract lives here, decoupled from this god-object. */
    public get authoring(): SceneAuthoringAPI { return this._authoring ??= new SceneAuthoringAPI(this); }

    private _assets?: AssetLibrary;
    /** The account-global **Shared Asset Library** (docs/specs/shared-asset-library.md): assets authored in any
     *  creator, reusable in every Illustration. OPFS-backed, cross-document. `await sm.assets.init()` before the
     *  first `list()`. Domains register providers here — anim-clip/pose are wired (instantiate = retarget onto a
     *  skeleton; pass `{ skeletonId }` as the target). To preview an entry, instantiate it then capture via
     *  captureAnimationPreview3D. */
    public get assets(): AssetLibrary {
        if (!this._assets) {
            const lib = new AssetLibrary(new OpfsAssetBackend());
            const animProvider = (kind: 'anim-clip' | 'pose'): AssetProvider<AnimLibraryEntry> => ({
                kind,
                meta: (e) => ({ animKind: e.kind, rigType: e.rigType, sourceRig: e.sourceRig, jointCount: e.jointManifest?.length ?? 0, durationFrames: e.clip?.endFrame }),
                instantiate: (e, target) => {
                    const skelId = typeof target.skeletonId === 'string' ? target.skeletonId : null;
                    return skelId ? this.scene3d.applyLibraryEntryObject3D(e, skelId) : null;
                },
                // thumbnail omitted: it needs a live target skeleton — the host captures a preview with
                // captureAnimationPreview3D AFTER instantiate (see docs/ui/animation-library.md).
            });
            lib.registerProvider(animProvider('anim-clip'));
            lib.registerProvider(animProvider('pose'));
            // `preset` provider — bridges the EXISTING procedural-creator framework (creator-registry +
            // ProceduralObjectManager) to the library: a preset is {typeId, params}; instantiate re-creates the
            // creator object in the open scene via createCreator3D. So any creator's output becomes a reusable asset.
            const presetProvider: AssetProvider<{ typeId: string; params: Record<string, unknown> }> = {
                kind: 'preset',
                meta: (p) => ({ creatorType: p.typeId }),
                instantiate: (p, target) => this.createCreator3D(p.typeId, p.params, target.transform as Partial<ProcTransform> | undefined)?.id ?? null,
            };
            lib.registerProvider(presetProvider);
            // `character` provider — a full character preset ({body, hair, clothing, renderStyle} from exportCharacter3D)
            // as a reusable asset. instantiate is ASYNC: regenerate a rigged body from the preset's body params, then
            // apply the rest. Folds the bespoke Character creator into the same author-once/reuse-everywhere loop.
            const characterProvider: AssetProvider<{ kind?: string; body?: unknown; hair?: unknown; clothing?: Record<string, unknown>; renderStyle?: string }> = {
                kind: 'character',
                meta: (p) => ({ hasHair: !!p.hair, clothingSlots: Object.keys(p.clothing ?? {}), renderStyle: p.renderStyle ?? 'default' }),
                instantiate: async (p, target) => {
                    const t = target.transform as { x?: number; y?: number; z?: number } | undefined;
                    const { meshId } = await this.createProceduralBody3D((p.body ?? {}) as never, t?.x ?? 0, t?.y ?? 0, t?.z ?? 0);
                    if (meshId) await this.importCharacter3D(meshId, p as object);
                    return meshId ?? null;
                },
            };
            lib.registerProvider(characterProvider);
            // `material` provider — a saved surface recipe ({surface, params}) from the procedural-material catalog.
            // Unlike the others, it APPLIES to an existing mesh (`target.meshId`) rather than creating a node, so it
            // returns the affected mesh id (provenance links the material to the mesh it's on). Proves the provider
            // abstraction generalizes beyond node-creating kinds.
            const materialProvider: AssetProvider<{ surface: string; params?: Record<string, unknown> }> = {
                kind: 'material',
                meta: (p) => ({ surface: p.surface }),
                instantiate: (p, target) => {
                    const meshId = typeof target.meshId === 'string' ? target.meshId : null;
                    if (!meshId) return null;
                    return this.applyGroundMaterial3D(meshId, { surface: p.surface as never, ...(p.params ?? {}) }) ? meshId : null;
                },
            };
            lib.registerProvider(materialProvider);
            // Record provenance so the document remembers which global assets it instantiated (L3, update-detection).
            lib.setInstantiateHook((record, docLocalId) => this.scene3d.recordAssetReference({
                docLocalId, globalId: record.id, version: record.version, kind: record.kind, name: record.name,
            }));
            this._assets = lib;
        }
        return this._assets;
    }

    /** The document's GLOBAL-asset provenance, resolved against the live library — for a "linked assets" panel. Each
     *  entry reports where its record resolves (`global`/`embedded`/`dangling`) and whether a newer version exists. */
    public async assetDocumentReferences3D(): Promise<Array<{ docLocalId: string; globalId: string; name: string; kind: string; source: string; updateAvailable: boolean }>> {
        const out: Array<{ docLocalId: string; globalId: string; name: string; kind: string; source: string; updateAvailable: boolean }> = [];
        for (const r of this.scene3d.listAssetReferences()) {
            const res = await this.assets.resolveReference({ globalId: r.globalId, version: r.version }, r.embedded ?? null);
            out.push({ docLocalId: r.docLocalId, globalId: r.globalId, name: r.name, kind: r.kind, source: res.source, updateAvailable: res.updateAvailable });
        }
        return out;
    }

    /** Promote a clip straight to the GLOBAL Shared Asset Library (one call — no doc-library staging). Returns the
     *  new global AssetRecord, or null if the clip isn't found. Reuse it in any Illustration via
     *  `sm.assets.instantiate(record.id, { skeletonId })`. */
    public async promoteClipToGlobal3D(clipId: string, opts?: { name?: string; tags?: string[] }): Promise<AssetRecord | null> {
        const entry = this.scene3d.buildLibraryEntryFromClip3D(clipId, opts);
        if (!entry) return null;
        return this.assets.promote('anim-clip', entry, { name: opts?.name ?? entry.name, tags: opts?.tags ?? entry.tags });
    }
    /** Promote a pose straight to the GLOBAL Shared Asset Library (see {@link promoteClipToGlobal3D}). */
    public async promotePoseToGlobal3D(skeletonId: string, poseId: string, opts?: { name?: string; tags?: string[] }): Promise<AssetRecord | null> {
        const entry = this.scene3d.buildLibraryEntryFromPose3D(skeletonId, poseId, opts);
        if (!entry) return null;
        return this.assets.promote('pose', entry, { name: opts?.name ?? entry.name, tags: opts?.tags ?? entry.tags });
    }

    /** Promote a procedural-creator config to the GLOBAL library as a reusable `preset` asset (typeId + params).
     *  Reuse in any Illustration via `sm.assets.instantiate(id, { transform })` (re-creates the object). Null if the
     *  typeId isn't a registered creator. */
    public async savePresetToLibrary3D(typeId: string, params: Record<string, unknown>, opts?: { name?: string; tags?: string[] }): Promise<AssetRecord | null> {
        if (!this.creatorTypes3D().some((t) => t.typeId === typeId)) return null;
        return this.assets.promote('preset', { typeId, params }, { name: opts?.name ?? typeId, tags: opts?.tags });
    }
    /** Promote an EXISTING creator object (by node id) to the library — reads its live params. Null if the node isn't
     *  a managed creator object. */
    public async promoteCreatorToLibrary3D(nodeId: string, opts?: { name?: string; tags?: string[] }): Promise<AssetRecord | null> {
        const typeId = this.creatorTypeOf3D(nodeId);
        const params = this.getCreatorParams3D(nodeId) as Record<string, unknown> | null;
        if (!typeId || !params) return null;
        return this.savePresetToLibrary3D(typeId, params, { name: opts?.name ?? typeId, tags: opts?.tags });
    }
    /** Promote a full character (body + hair + clothing + render style) to the GLOBAL library as a reusable
     *  `character` asset. `bodyMeshId` defaults to the first procedural body. Reuse via `sm.assets.instantiate` —
     *  it regenerates the rigged character in the scene. Null if there's no character to export. */
    public async promoteCharacterToLibrary3D(bodyMeshId?: string, opts?: { name?: string; tags?: string[] }): Promise<AssetRecord | null> {
        let payload: { kind?: string };
        try { payload = JSON.parse(this.exportCharacter3D(bodyMeshId)); } catch { return null; }
        if (!payload || payload.kind !== 'salsa-character') return null;
        return this.assets.promote('character', payload, { name: opts?.name ?? 'Character', tags: opts?.tags });
    }
    /** Promote a surface-material recipe (a `surfaceMaterials3D()` name + optional param overrides) to the GLOBAL
     *  library as a reusable `material` asset. Reuse via `sm.assets.instantiate(id, { meshId })` (applies it to that
     *  mesh). Null if `surface` isn't a catalog material. */
    public async saveMaterialToLibrary3D(surface: string, params?: Record<string, unknown>, opts?: { name?: string; tags?: string[] }): Promise<AssetRecord | null> {
        if (!this.surfaceMaterials3D().includes(surface)) return null;
        return this.assets.promote('material', { surface, ...(params ? { params } : {}) }, { name: opts?.name ?? surface, tags: opts?.tags });
    }

    public get packaging(): PackagingManager | null {
        if (!PACKAGING_ENABLED) return null;
        // C6 (2026-09-13): the ~540-line PackagingHost literal moved beside the packaging module —
        // src/packaging/packaging-host-impl.ts createPackagingHost(this). Same wide-host stance as C1:
        // the members it reaches were flipped public; this facade keeps only the lazy construction.
        return this._packaging ??= new PackagingManager(createPackagingHost(this));
    }

    // ── PACKAGE LAYER-STACK COMPOSITE controller (Part 1/2) ─────────────────────────────────────
    // The box live-textures from a COMPOSITE of the package's tagged layer stack (order +
    // visibility + opacity + blend), built by the SAME RasterCompositor class the artboard uses —
    // a dedicated instance so the box never inherits the artboard's paper-grain/dither post.
    // Vector layers contribute through raster PROXY textures (their ephemera placements rasterized
    // via the existing OffscreenCanvas SVG path); proxies re-render on placement change events.

    /** packageId → composite target + wiring. The provider linked into LiveTextureMode resolves
     *  through this map, so re-links/reallocations self-heal on the next sync. */
    // ── Packaging composite (box-panel layer-stack compositor + vector proxies) — extracted to PackagingComposite ──
    public _pkgComposite!: PackagingComposite;   // ctor-constructed (needs ManagerContext + _liveTexture / _ephemera)

    /**
     * Create the packaging 'Dieline' raster layer: SYSTEM-owned (`systemOwner:'packaging'` — the host
     * Layers panel filters it out) and composite-HIDDEN (visible=false — it never draws on the artboard;
     * the box panels sample the layer's GPUTexture directly via LiveTextureMode, not the composite).
     * The layer starts TRANSPARENT: panel materials use `texOverBase`, so empty = kraft cardboard and
     * strokes composite over it. Painting still works while hidden — both the UV-paint controller and
     * the flat raster tools write the layer texture itself; `visible` only gates the 2D compositor.
     */
    /** Restore every top-level object the Package-Creator full-scene isolation hid, to its prior
     *  visibility. No-op when nothing is isolated. */
    public _restorePackagingIsolation(): void {
        if (!this._packagingIsoMemory) return;
        for (const [id, vis] of this._packagingIsoMemory) {
            const n = this.sceneGraph.findNodeById(id);
            if (n) n.forEachDeep(d => { d.visible = vis; });
        }
        this._packagingIsoMemory = null;
        this.emitSceneGraphChanged();
        this.scheduleRender();
    }

    public _addPackagingDielineLayer(packageOwnerId?: string): string | null {
        // Tag ownership at BIRTH when the target package is known (creator-mode path) — the stack
        // migration re-tags anyway, but a birth tag means the by-NAME reuse in ensureDielineLayerInfo
        // can never hand this layer to a different package in the window before migration runs.
        return this.addRasterLayer('Dieline', { visible: false, systemOwner: 'packaging', ...(packageOwnerId ? { packageOwnerId } : {}) })?.id ?? null;
    }

    /** Adopt an EXISTING layer as the packaging dieline (saved-id or named-'Dieline' reuse): ensure the
     *  system flag + composite-hidden state so legacy layers behave like freshly created ones.
     *  ★A layer already PACKAGE-OWNED (`packageOwnerId`) is structurally excluded from the artboard
     *  composite, so its `visible` flag means STACK visibility — force-hiding it here made every
     *  creator RE-ENTER drop the base layer out of the box composite (paint written but never shown,
     *  bare board on screen). Only legacy/untagged layers still get composite-hidden. */
    public _tagPackagingLayer(layerId: string): void {
        const rlm = this.rasterLayerManager;
        const l = rlm?.getLayerById(layerId);
        if (!rlm || !l) return;
        let changed = false;
        if (l.systemOwner !== 'packaging') { rlm.setSystemOwner(layerId, 'packaging'); changed = true; }
        if (l.visible && !l.packageOwnerId) { rlm.setVisibility(layerId, false); changed = true; }
        if (changed) this.emitSceneGraphChanged();
    }

    /** Fill a raster layer opaque WHITE. Kept as an optional host hook (`fillLayerWhite`) — NO LONGER
     *  called on fresh Dieline layers: those stay TRANSPARENT and the panel material composites them
     *  over the kraft base (`texOverBase`). A user who wants a white background fills white themselves.
     *  One render-pass clear (the layer texture always has RENDER_ATTACHMENT usage). */
    public _fillRasterLayerWhite(layerId: string): void {
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
        _markRasterCompositeDirty(null, layer.texture);   // BRUSH-5: layer pixels changed (autosave: this layer)
        this.scheduleRender();
    }

    // ── Package-Creator paint-chain PROBE (permanent diagnostic; window.salsaPkgPaintProbe) ──

    /** Monotonic identity tags for GPUTexture objects (GPU labels aren't reliably set). */
    private _texTagSeq = 0;
    private readonly _texTags = new WeakMap<object, string>();
    private _texTag(t: unknown): string {
        if (!t || typeof t !== 'object') return '(none)';
        let tag = this._texTags.get(t as object);
        if (!tag) {
            const label = (t as { label?: unknown }).label;
            tag = `tex#${++this._texTagSeq}` + (typeof label === 'string' && label ? `(${label})` : '');
            this._texTags.set(t as object, tag);
            // Stamp the tag as the GPU label too (when unset) so it shows in GPU debuggers/validation errors.
            try { if (typeof label === 'string' && !label) (t as { label: string }).label = tag; } catch { /* readonly */ }
        }
        return tag;
    }

    /**
     * Dump every texture IDENTITY in the Package-Creator paint chain (window `salsaPkgPaintProbe()`):
     * per panel — the linked layer id, the layer MANAGER's live texture, the reassignable
     * `layer.texture` snapshot, what the mesh samples, and what the 3D renderer has BOUND (its
     * cached bind group's diffuse); plus the armed paint session's WRITE target and LiveTextureMode
     * sync counters. Every column should show the SAME tex#N while painting — any mismatch is the
     * "paint never reaches the box" bug, located.
     */
    public pkgPaintProbe(): Record<string, unknown> {
        const pkg = this._packaging ?? null;
        const st = pkg?.getCreatorState() ?? null;
        const target = st?.packageId ? pkg?.get(st.packageId) ?? null : null;
        const engine = this._uvPaintController?.debugState() ?? null;
        const r3d = this.webgpuRenderer?.peekRenderer3D() ?? null;
        const panels = (target?.box.panels ?? []).map((p, i) => {
            const res = this._liveTexture.debugResolve(p.meshId);
            return {
                i,
                meshId: p.meshId,
                layerId: res?.layerId ?? null,
                managerTex: this._texTag(res?.managerTex),
                snapshotTex: this._texTag(res?.snapshotTex),
                meshTex: this._texTag(res?.meshTex),
                hasTexture: res?.hasTexture ?? false,
                rendererBound: this._texTag(r3d?.getBoundDiffuseTexture(p.meshId) ?? null),
            };
        });
        const engineTag = engine ? this._texTag(engine.engineTex) : '(no session)';
        const out: Record<string, unknown> = {
            creatorActive: st?.active ?? false,
            packageId: st?.packageId ?? null,
            dielineLayerId: st?.dielineLayerId ?? null,
            paintSession: engine ? {
                armedMeshId: engine.meshId,
                engineWriteTex: engineTag,
                managerTex: this._texTag(engine.managerTex),
                engineMatchesManager: engine.engineTex === engine.managerTex,
            } : null,
            panel0BoundMatchesEngineWrite:
                !!engine && panels.length > 0 && panels[0].rendererBound === engineTag,
            panels,
            sync: {
                syncAllCalls: this._liveTexture.syncAllCalls,
                syncResolutions: this._liveTexture.syncResolutions,
                repoints: this._liveTexture.repoints,
                lastSyncAllAt: this._liveTexture.lastSyncAllAt,
            },
        };
        if (typeof console !== 'undefined') {
            console.table?.(panels);
            console.log('[salsaPkgPaintProbe]', out);
        }
        return out;
    }

    /**
     * Dump the ACTIVE package's LAYER STACK (window `salsaPkgStackProbe()`) — the diagnostic for
     * "vector ephemera never composite onto the dieline/box". Per stack layer: id, name, kind,
     * visible, opacity, systemOwner, packageOwnerId, and for VECTOR layers whether a rasterized
     * PROXY exists (`hasProxy`) + its live placement count (`proxyPlacementCount`). Plus the
     * composite target's texture id, whether the composite is linked, and its recomposite counter +
     * last tick. Reading the dump: a package vector layer that shows on the artboard but not the box
     * should have `hasProxy=true` + `proxyPlacementCount>0` and the composite's `recomposites` should
     * ADVANCE after a placement change — if the vector row is absent from the stack, the layer isn't
     * package-tagged; if `hasProxy=false`, the change event never reached the compositor.
     */
    public pkgStackProbe(): Record<string, unknown> {
        const pkg = this._packaging ?? null;
        const st = pkg?.getCreatorState() ?? null;
        const packageId = st?.packageId ?? null;
        const target = packageId ? pkg?.get(packageId) ?? null : null;
        const rlm = this.rasterLayerManager;
        const entry = packageId ? this._pkgComposite.getComposite(packageId) : null;
        const layers = (target?.layers ?? []).map((layerId, i) => {
            const l = rlm?.getLayerById(layerId);
            const kind = (l?.type === 'vector' || l?.type === 'ephemera') ? 'vector'
                : (l?.type ?? 'layer') === 'layer' ? 'raster' : (l?.type ?? 'unknown');
            const proxy = this._pkgComposite.getVectorProxy(layerId);
            const placements = kind === 'vector' ? this._ephemera.getPlacementsForLayer(layerId) : [];
            return {
                i,
                id: layerId,
                name: l?.name ?? '(missing)',
                kind,
                visible: l?.visible ?? false,
                opacity: l?.opacity ?? 1,
                active: layerId === target?.activeLayerId,
                systemOwner: l?.systemOwner ?? null,
                packageOwnerId: l?.packageOwnerId ?? null,
                hasProxy: kind === 'vector' ? !!proxy : undefined,
                proxyPlacementCount: kind === 'vector' ? placements.filter(p => p.visible).length : undefined,
            };
        });
        const out: Record<string, unknown> = {
            creatorActive: st?.active ?? false,
            packageId,
            compositeLinked: !!entry,
            compositeTargetTex: this._texTag(entry?.mgr.getTexture() ?? null),
            recomposites: entry?.recomposites ?? 0,
            lastRecompositeTick: entry?.lastRecompositeTick ?? 0,
            panelCount: target?.box.panels.length ?? 0,
            layers,
        };
        if (typeof console !== 'undefined') {
            console.table?.(layers);
            console.log('[salsaPkgStackProbe]', out);
        }
        return out;
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
        // In a city: real human size (1.7 m) and, for the origin / illustration-centre default, spawned on the floor the
        // camera is looking at (Scene3DManager.resolveCharacterSpawn3D / _applySceneCharacterScale). Unchanged elsewhere.
        const [sx, sy, sz] = this.scene3d.resolveCharacterSpawn3D([x, y, z]);
        return this.scene3d.createProceduralBody3D(params, sx, sy, sz);
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
        rimLight?: boolean;          // per-character rim light (setCharacterRimLight3D); omit → unchanged (off)
        matte?: boolean;             // matte cel skin + cloth (setCharacterMatte3D); omit → unchanged (off = glossy specular)
        face?: Partial<FaceFeatureParams> | false;   // face kit (brows / mouth / nose / shading); omit → the defaults, false → eyes only
    }): Promise<{ meshId: string; skeletonId: string; nodeIds: string[] }> {
        // In a city the character is built at real human size (1.7 m, every part: the body transform carries the
        // skeleton + overlays) and a default position (none / origin / the 2D illustration centre) becomes the floor the
        // camera is looking at. Outside a city: unchanged (the generated size at `position`).
        const [x, y, z] = this.scene3d.resolveCharacterSpawn3D(opts.position);
        this.beginSceneGraphBatch3D();
        try {
            // Garments FIRST, then hair (fitted against all of them): hair-first regenerated the hair once per new
            // garment, and shoes-after-bottom regenerated the bottom (it piles onto the shoes) — ~5 redundant
            // generator runs. Body + garments + hair are generated in ONE 'character' worker job (performance-plan
            // P3.2d) and PRIMED, so the setters below only wrap + upload (any input mismatch just generates here).
            const garments = [opts.top, opts.undershirt, opts.underpants, opts.socks, opts.shoes, opts.bottom]
                .filter((g): g is ClothingParams => !!g);
            const { meshId, skeletonId } = await this.scene3d.createProceduralCharacter3D({ body: opts.body, garments, hair: opts.hair ?? null }, x, y, z);
            try {
                this.ensureFace3D(meshId);
                const exprId = this.createFaceExpression3D(meshId, opts.expressionName ?? 'Neutral');
                if (exprId && opts.eyes) this.setFaceExpressionProcedural3D(meshId, exprId, opts.eyes);
                for (const g of garments) this.setClothingParams3D(meshId, g);   // socks under shoes; bottom onto shoes
                if (opts.hair) this.setHairParams3D(meshId, opts.hair);
            } finally {
                this.scene3d.clearPrimedCharacterParts3D(meshId);
            }
            if (opts.skinTone) this.setSkinTone3D(meshId, opts.skinTone);
            if (opts.face !== false) this.setFaceFeatures3D(meshId, { ...(opts.face ?? {}), enabled: opts.face?.enabled ?? true });   // after hair + skin (brow colour, fringe)
            if (opts.rimLight !== undefined) this.setCharacterRimLight3D(meshId, opts.rimLight);
            if (opts.matte !== undefined) this.scene3d.setCharacterMatte3D(meshId, opts.matte);
            // The 3D nodes this character added (flat siblings under root): body + face decal + hair + any of
            // the 6 garment slots. Returned so the host pushes just these into its mesh/outliner lists — no full
            // re-scan. Fetch each with getMesh3D(id) / getNode3D(id).
            const nodeIds = [
                meshId,
                this.scene3d.getEyesMeshId(meshId),
                ...this.scene3d.faceKit.getFaceKitMeshIds(meshId),
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

    /** Parameters for a NEW random character (seeded; same seed → same character) — eyes ≈0.4×0.2 with no bottom
     *  lash, hair cards with 6 cap layers, rim light on, uncropped top, bottoms' looseness ≥ 0.016; colours/styles
     *  random. Pass the result to createFullCharacter3D (tweak any field first), or use createRandomCharacter3D.
     *  See docs/ui/character-creator.md "Random character". */
    public randomCharacterParams3D(seed?: number, body?: Partial<import('./managers/body-generator').BodyParams>): import('./managers/character-randomizer').RandomCharacterParams {
        return randomCharacterParams(seed, body);
    }
    /** Create a NEW random character in one call (randomCharacterParams3D → createFullCharacter3D). `body` merges
     *  over the random body shape (e.g. the host's body sliders). */
    public async createRandomCharacter3D(opts: { seed?: number; position?: [number, number, number]; body?: Partial<import('./managers/body-generator').BodyParams> } = {}): Promise<{ meshId: string; skeletonId: string; nodeIds: string[] }> {
        const p = randomCharacterParams(opts.seed, opts.body);
        return this.createFullCharacter3D({ ...p, position: opts.position });
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

    // ── Character scale (2026-10-04; docs/ui/character-creator.md "Scaling a character") ──
    /** A character's size: uniform `scale` (1 = generated size), standing `height` (world units) / `heightMetres`,
     *  `restHeight` (at scale 1), the metres per unit used and the scene's own (null outside a city). null = not a body. */
    public getCharacterScale3D(bodyMeshId: string): { scale: number; height: number; heightMetres: number; restHeight: number; metresPerUnit: number; sceneMetresPerUnit: number | null } | null {
        return this.scene3d.getCharacterScale3D(bodyMeshId);
    }
    /** Scale the WHOLE character (body, skeleton, clothes, hair, face, eyes, charms, springs) uniformly — no regeneration,
     *  feet kept on the ground, saved with the document, undoable; Play's camera / capsule / stride follow. */
    public setCharacterScale3D(bodyMeshId: string, scale: number): boolean { return this.scene3d.setCharacterScale3D(bodyMeshId, scale); }
    /** Scale a character to stand `height` tall (metres by default — the city's scale in a city, else 1 unit = 1 m). */
    public setCharacterHeight3D(bodyMeshId: string, height: number, unit: 'metres' | 'units' = 'metres'): number | null { return this.scene3d.setCharacterHeight3D(bodyMeshId, height, unit); }
    /** "Fit to city": scale a character to `metres` (default 1.7 m) at the scene's metre scale. Returns the new scale. */
    public fitCharacterToScene3D(bodyMeshId: string, metres?: number): number | null { return this.scene3d.fitCharacterToScene3D(bodyMeshId, metres); }

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

    // ── Vending machines (standalone creator objects) ──
    public createVending3D(params?: Partial<VendingParams>, transform?: Partial<ProcTransform>): { id: string; meta: VendingMeta } { return this.vending.create(params, transform); }
    public setVendingParams3D(id: string, params: Partial<VendingParams>): boolean { return this.vending.setParams(id, params); }
    public getVendingParams3D(id: string): VendingParams | null { return this.vending.getParams(id); }
    public isVending3D(id: string): boolean { return this.vending.isVending(id); }
    public frameVending3D(id: string): boolean { return this.vending.frame(id); }
    public removeVending3D(id: string): boolean { return this.vending.remove(id); }
    public listVending3D(): { id: string; name: string; brand: string }[] { return this.vending.list(); }
    public vendingBrandNames3D(): string[] { return this.vending.brandNames(); }
    public setVendingTransform3D(id: string, t: Partial<ProcTransform>): boolean { return this.vending.setTransform(id, t); }
    public setVendingScale3D(id: string, unitsPerMetre: number): boolean { return this.vending.setScale(id, unitsPerMetre); }

    // ── Creator registry + generic dispatch: ONE panel + ONE API for every creator (creator-modes.md §5.2) ──
    // The schema drives the panel; these methods drive the lifecycle by typeId, so a host never writes
    // per-creator glue — pick a typeId from creatorTypes3D(), render creatorParamSchema3D(typeId), spawn with
    // createCreator3D(typeId), and push slider changes through setCreatorParams3D(id, …).
    public creatorTypes3D(): { typeId: string; label: string }[] { return creator3DTypes(); }
    public creatorParamSchema3D(typeId: string): CreatorParamSchema[] { return creator3DSchema(typeId); }
    public creatorDefaults3D(typeId: string): Record<string, unknown> { return creator3DDefaults(typeId); }

    /** Create a creator object of `typeId` (defaults filled from its schema if `params` omitted). Auto-frames.
     *  Returns the new node id, or null if the typeId is not registered. */
    public createCreator3D(typeId: string, params?: Record<string, unknown>, transform?: Partial<ProcTransform>): { id: string } | null {
        const m = this._creators.get(typeId);
        if (!m) return null;
        return { id: m.createFromParams(params ?? creator3DDefaults(typeId), transform ?? {}) };
    }
    /** The registered creator typeId that owns `id`, or null (also the "is this an editable creator?" gate). */
    public creatorTypeOf3D(id: string): string | null {
        for (const [typeId, m] of this._creators) if (m.isManaged(id)) return typeId;
        return null;
    }
    public isCreator3D(id: string): boolean { return this.creatorTypeOf3D(id) !== null; }
    /** Live-edit any creator's params by node id (routes to the owning manager). */
    public setCreatorParams3D(id: string, partial: Record<string, unknown>): boolean {
        return this._creatorOwning(id)?.setParams(id, partial) ?? false;
    }
    public getCreatorParams3D(id: string): unknown | null { return this._creatorOwning(id)?.getParams(id) ?? null; }
    public removeCreator3D(id: string): boolean { return this._creatorOwning(id)?.remove(id) ?? false; }
    public frameCreator3D(id: string): boolean { return this._creatorOwning(id)?.frame(id) ?? false; }
    private _creatorOwning(id: string): ProceduralObjectManager<unknown, unknown> | null {
        for (const m of this._creators.values()) if (m.isManaged(id)) return m;
        return null;
    }

    // ── DECALS (Mode A) — floating-quad decals + place-tool, extracted to DecalManager ──
    /** Place a decal from a resolved surface hit (world hitPoint + face normal). Returns the container id. */
    public placeDecal3D(source: DecalSource, hit: DecalHit, opts: { size?: number; rotation?: number; metresPerUnit?: number } = {}): string {
        return this._decalMgr.placeDecal3D(source, hit, opts);
    }
    /** Raycast a screen point and place a decal on the surface under it. */
    public placeDecalAtScreen3D(source: DecalSource, clientX: number, clientY: number, rect: DOMRect, opts: { size?: number; rotation?: number; metresPerUnit?: number } = {}): string | null {
        return this._decalMgr.placeDecalAtScreen3D(source, clientX, clientY, rect, opts);
    }
    /** Enter the Decal place-tool (select-then-place; live hover ghost). */
    public enterDecalPlaceMode3D(source: DecalSource, opts: { size?: number; rotation?: number; metresPerUnit?: number } = {}): boolean {
        return this._decalMgr.enterDecalPlaceMode3D(source, opts);
    }
    public exitDecalPlaceMode3D(): void { this._decalMgr.exitDecalPlaceMode3D(); }
    public get decalPlaceModeActive(): boolean { return this._decalMgr.decalPlaceModeActive; }
    /** Metres per WORLD UNIT for the active city — a host panel converts a "Size (m)" slider to units with
     *  this (`units = metres / cityMetresPerUnit()`), or passes `metresPerUnit` to the place/size calls.
     *  Uses the current city's radius; ~15 for a default radius-10 city, and no city → the same default.
     *  Named without a `3D` suffix to match the Frogmarks call site (`sm.cityMetresPerUnit?.()`). */
    public cityMetresPerUnit(): number { return worldMetresPerUnit(this.world?.params?.radius ?? 10); }
    /** Live-resize the active tool ghost. */
    public setDecalToolSize3D(size: number, metresPerUnit?: number): void { this._decalMgr.setDecalToolSize3D(size, metresPerUnit); }
    public setDecalToolRotation3D(rotation: number): void { this._decalMgr.setDecalToolRotation3D(rotation); }
    public isDecal3D(id: string): boolean { return this._decalMgr.isDecal3D(id); }
    public listDecals3D(): { id: string; source: DecalSource }[] { return this._decalMgr.listDecals3D(); }
    public removeDecal3D(id: string): boolean { return this._decalMgr.removeDecal3D(id); }
    public setDecalSize3D(id: string, size: number, metresPerUnit?: number): boolean { return this._decalMgr.setDecalSize3D(id, size, metresPerUnit); }
    public setDecalRotation3D(id: string, rotation: number): boolean { return this._decalMgr.setDecalRotation3D(id, rotation); }
    public setDecalSource3D(id: string, source: DecalSource): Promise<boolean> { return this._decalMgr.setDecalSource3D(id, source); }
    /** Shared with GARP skin resolution + Mode-B baking → the impl lives in decal-source.ts (dep: EphemeraService). */
    private _resolveDecalBitmap(source: DecalSource): Promise<ImageBitmap | null> {
        return resolveDecalBitmap(source, this._ephemera);
    }
    // ── GARP — Grouped Asset Randomizer Pool (docs/specs/city-props-garp.md §2) ───────────────────────
    // The dedicated GARP registry (pools + textures + session-local atlas layers). Pure/no-GPU; the atlas
    // itself is built by resolving each texture's DecalSource → bitmap (reusing the decal path) and uploading
    // into the renderer's dedicated GARP texture_2d_array.
    private readonly _garp = new GarpManager();

    /** The GARP registry (pools, textures, skin→layer). Consumers (vending, future props) ask it for the atlas
     *  layer a placed object's chosen skin resolves to, then set it as a mesh `garpLayer` / per-instance override. */
    public get garp(): GarpManager { return this._garp; }

    /** Register the CITY's vending GARP pool + build its atlas. Idempotent (the resolver calls it once, on the
     *  first city with a vending body). The built-in `body` skins are SOLID BRAND-COLOUR placeholders (so default
     *  machines read like the old solid-coloured cabinets); real brand art is host content (Frogmarks) supplied
     *  later via registerGarpPool3D (key `vending/<brand>/body`). Registration is SYNCHRONOUS (assigns atlas layers
     *  immediately, so the resolver is correct this frame); the atlas bitmap upload is async and re-renders. */
    private _ensureVendingGarp(): void {
        const pool = vendingGarpPool();
        // Re-register when MISSING or an OLD version (a save from before the body-shell unwrap restores a v1
        // `fascia` pool → machines would resolve blank; re-seeding migrates it to the current `body` contract).
        const existing = this._garp.getPool('salsa/vending');
        if (existing && existing.version >= pool.version) {
            // ★ Upgrade by SLOT, not version (addSkin bumps version per added skin, so a saved pool with user skins
            //   is "newer" yet can predate the `labels` slot). Add the slot + placeholder sheets IN PLACE, keeping skins.
            if (!existing.slots.includes('labels') && !this._prewarmCapture) this._upgradeVendingLabelsSlot(existing);
            return;
        }
        const textures: Record<string, DecalSource> = {};
        VENDING_BRANDS.forEach((b, i) => {
            // `body` = a solid brand colour; `products` = a soft LIT back wall (the backdrop behind the cans);
            // `labels` = a placeholder can sheet. All placeholders until the host registers real art.
            textures[vendingSkinKey(b.name, 'body')]     = { kind: 'image', dataUrl: this._solidColorDataUrl(b.body) };
            textures[vendingSkinKey(b.name, 'products')] = { kind: 'image', dataUrl: this._vendingBackdropUrl(b.glow) };
            textures[vendingSkinKey(b.name, 'labels')]   = { kind: 'image', dataUrl: this._vendingPlaceholderLabelsUrl(i) };
        });
        // The pool DEFAULTS (for body-only user variants — see vendingGarpPool.defaults).
        textures[vendingSkinKey('_default', 'products')] = { kind: 'image', dataUrl: this._vendingBackdropUrl([0.92, 0.94, 0.96]) };
        textures[vendingSkinKey('_default', 'labels')]   = { kind: 'image', dataUrl: this._vendingPlaceholderLabelsUrl(0) };
        if (this._prewarmCapture) return;               // P5.W4 prewarm: only the drawn canvases were wanted
        this.registerGarpPool3D(pool, textures);        // sync → layers assigned
        // Both `body` and `products` are now instanced on city machines → both live (default). (products = the flat
        // display panel behind the glass.)
        void this.rebuildGarpAtlas3D([512, 512]);       // async → pixels + re-render
    }

    /** Add the `labels` slot (+ placeholder can sheets) to an OLDER registered vending pool, keeping every skin.
     *  Built-in brand skins get their own placeholder sheet; user skins use the pool default. */
    private _upgradeVendingLabelsSlot(existing: GarpPool): void {
        const builtIn = new Map(VENDING_BRANDS.map((b, i) => [b.name, i] as const));
        const textures: Record<string, DecalSource> = { [vendingSkinKey('_default', 'labels')]: { kind: 'image', dataUrl: this._vendingPlaceholderLabelsUrl(0) } };
        const skins = existing.skins.map((sk) => {
            const bi = builtIn.get(sk.name);
            if (bi === undefined || sk.slots.labels) return sk;
            const key = vendingSkinKey(sk.name, 'labels');
            textures[key] = { kind: 'image', dataUrl: this._vendingPlaceholderLabelsUrl(bi) };
            return { ...sk, slots: { ...sk.slots, labels: key } };
        });
        this.registerGarpPool3D({
            ...existing, slots: [...existing.slots, 'labels'], skins,
            defaults: { ...(existing.defaults ?? {}), labels: vendingSkinKey('_default', 'labels') },
        }, textures);
        void this.rebuildGarpAtlas3D([512, 512]);
    }

    /** A 512² LIT BACK WALL for the vending backdrop placeholder: a soft vertical gradient from `tint` to near-white. */
    private _vendingBackdropUrl(tint: [number, number, number]): string {
        return this._garpSkinUrl('backdrop:' + tint.join(','), (ctx) => {
            const c = (k: number) => `rgb(${Math.round((tint[0] * k + (1 - k)) * 255)}, ${Math.round((tint[1] * k + (1 - k)) * 255)}, ${Math.round((tint[2] * k + (1 - k)) * 255)})`;
            const g = ctx.createLinearGradient(0, 0, 0, 512);
            g.addColorStop(0, c(0.25)); g.addColorStop(1, c(0.7));
            ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512);
        });
    }

    /** Draw a vending LABEL SHEET (the 4×2 `labels` layout, vendingLabelCell): per cell, `art` paints the label rect,
     *  the padding around it is BLED from the same art (so filtering never pulls in a neighbour), and the rim band
     *  gets a silver gradient (the can's neck + top sample it). Returns a 512² PNG data URL. */
    private _drawVendingLabelSheet(art: (ctx: CanvasRenderingContext2D, cell: number, x: number, y: number, w: number, h: number) => void, placeholderKey?: string): string {
        if (placeholderKey) return this._placeholderPng(placeholderKey, (ctx) => this._paintVendingLabelSheet(ctx, art));
        const S = 512;
        const canvas = document.createElement('canvas'); canvas.width = S; canvas.height = S;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';
        this._paintVendingLabelSheet(ctx, art);
        return canvas.toDataURL('image/png');
    }
    private _paintVendingLabelSheet(ctx: CanvasRenderingContext2D, art: (ctx: CanvasRenderingContext2D, cell: number, x: number, y: number, w: number, h: number) => void): void {
        const S = 512, pad = VENDING_LABEL_PAD * S;
        for (let i = 0; i < VENDING_LABEL_CELLS; i++) {
            const { cell, rim, label } = vendingLabelCell(i);
            const [x0, y0, x1, y1] = [cell[0] * S - pad, cell[1] * S - pad, cell[2] * S + pad, cell[3] * S + pad];   // unpadded cell
            const [lx, ly, lw, lh] = [label[0] * S, label[1] * S, (label[2] - label[0]) * S, (label[3] - label[1]) * S];
            // Bleed: the art stretched over the whole unpadded cell first, then drawn exactly into the label rect.
            ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
            art(ctx, i, x0, y0, x1 - x0, y1 - y0);
            ctx.restore();
            ctx.save(); ctx.beginPath(); ctx.rect(lx, ly, lw, lh); ctx.clip();
            art(ctx, i, lx, ly, lw, lh);
            ctx.restore();
            // Rim band (+ the padding above it): brushed aluminium.
            const ry0 = y0, ry1 = rim[3] * S;
            const g = ctx.createLinearGradient(x0, 0, x1, 0);
            g.addColorStop(0, '#8d9096'); g.addColorStop(0.45, '#e4e6ea'); g.addColorStop(1, '#9a9da3');
            ctx.fillStyle = g; ctx.fillRect(x0, ry0, x1 - x0, ry1 - ry0);
        }
    }

    /** Placeholder can labels for built-in brand `brandIdx`: 8 bold two-tone cans (a hue per cell, rotated per brand). */
    private _vendingPlaceholderLabelsUrl(brandIdx: number): string {
        const HUES = ['#e8453c', '#2f7fd6', '#f2c230', '#4caf6a', '#f08bb6', '#8a5cd6', '#f07a2a', '#3cc6c8'];
        return this._drawVendingLabelSheet((ctx, cell, x, y, w, h) => {
            const base = HUES[(cell + brandIdx * 3) % HUES.length], accent = HUES[(cell + brandIdx * 3 + 4) % HUES.length];
            ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
            ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y + h * 0.30, w, h * 0.16);             // a white band
            ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x + w * 0.5, y + h * 0.62, w * 0.26, 0, Math.PI * 2); ctx.fill();   // a logo disc
            ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(x + w * 0.2, y + h * 0.36, w * 0.6, h * 0.04);   // a "name" bar
        }, 'labels:' + brandIdx);
    }

    /** Generic: register a GARP `pool` with drawn placeholder skins (`draws` maps skin KEY → a 512² canvas draw fn).
     *  Idempotent (skips when a same-or-newer version is registered). The host swaps in real art via registerGarpPool3D. */
    private _ensureGarpPool(pool: GarpPool, draws: Record<string, (ctx: CanvasRenderingContext2D) => void>): void {
        const existing = this._garp.getPool(pool.id);
        if (existing && existing.version >= pool.version) return;
        const textures: Record<string, DecalSource> = {};
        for (const key of Object.keys(draws)) textures[key] = { kind: 'image', dataUrl: this._garpSkinUrl('skin:' + key, draws[key]) };
        if (this._prewarmCapture) return;   // P5.W4 prewarm: only the drawn canvases were wanted
        this.registerGarpPool3D(pool, textures);
        void this.rebuildGarpAtlas3D([512, 512]);
    }
    /** A 512² PNG data URL from a canvas draw callback (built-in GARP placeholder skins), cached by `key`. */
    private _garpSkinUrl(key: string, draw: (ctx: CanvasRenderingContext2D) => void): string {
        return this._placeholderPng(key, draw);
    }

    // ── P5.W4: built-in GARP placeholder PNGs, pre-encoded OFF the main thread ─────────────────────────────────
    // The first city of a session registers the built-in vending / crate / clutter pools from INSIDE its reassembly
    // (the GARP layer resolver), and every placeholder skin was a 512² canvas → toDataURL('image/png') there: ~70 ms
    // per pool family of synchronous PNG encode. Now, when a city build STARTS, the same draws are captured (no
    // registration) and encoded in the 'atlas' worker (composeAtlasSheet: the drawn bitmap, PNG-encoded) into a
    // per-recipe cache, one family per frame; by the time the reassembly asks, the URLs are ready. A miss (no worker
    // support, or the build won the race) encodes synchronously exactly as before. Same pixels either way (a 1:1
    // bitmap copy of the same draw; PNG is lossless) — only the encoder's byte stream may differ.
    private readonly _placeholderUrls = new Map<string, string>();
    /** Non-null while a prewarm captures draws: the ensure*Garp paths draw, queue the canvas, and skip registration. */
    private _prewarmCapture: Array<{ key: string; canvas: HTMLCanvasElement }> | null = null;
    private _prewarmStarted = false;
    /** One built-in 512² placeholder PNG: the cache, else draw + encode now (or, in a prewarm, queue the canvas). */
    private _placeholderPng(key: string, draw: (ctx: CanvasRenderingContext2D) => void): string {
        const hit = this._placeholderUrls.get(key);
        if (hit) return hit;
        const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
        const ctx = canvas.getContext('2d'); if (ctx) draw(ctx);
        if (this._prewarmCapture) { this._prewarmCapture.push({ key, canvas }); return ''; }
        const url = canvas.toDataURL('image/png');
        this._placeholderUrls.set(key, url);
        return url;
    }
    /** Pre-encode every not-yet-registered built-in placeholder skin off-thread (once per session; see above). */
    private _prewarmGarpPlaceholders(): void {
        if (this._prewarmStarted || typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined' || !atlasComposeSupported()) return;
        this._prewarmStarted = true;
        // One pool family per frame: draw (cheap canvas fills) → snapshot → the atlas worker encodes.
        const families: Array<() => void> = [
            () => this._ensureVendingGarp(), () => this._ensureCrateGarp(),
            ...['salsa/bin', 'salsa/vent', 'salsa/aboard', 'salsa/stall', 'salsa/poster', 'salsa/warning'].map(id => () => this._ensureClutterGarp(id)),
        ];
        const step = (): void => {
            const fam = families.shift();
            if (!fam) return;
            const cap: Array<{ key: string; canvas: HTMLCanvasElement }> = [];
            this._prewarmCapture = cap;
            try { fam(); } catch { /* a draw failed → that family encodes on demand */ } finally { this._prewarmCapture = null; }
            for (const { key, canvas } of cap) {
                void createImageBitmap(canvas).then(bmp => composeAtlasSheet(
                    { plan: { width: canvas.width, height: canvas.height, ops: [{ t: 'img', src: 0, x: 0, y: 0, w: canvas.width, h: canvas.height }] }, sources: [bmp], encode: { mime: 'image/png' } },
                    { priority: 'background', label: 'Preparing props' }))
                    .then(r => { if (r.dataUrl && !this._placeholderUrls.has(key)) this._placeholderUrls.set(key, r.dataUrl); })
                    .catch(() => { /* encodes on demand */ });
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    /** Register the built-in CRATE-label pool + placeholder skins (drawn wood-crate faces). Idempotent. The host
     *  replaces these with real art via registerGarpPool3D('salsa/crate', …). Mirrors _ensureVendingGarp. */
    private _ensureCrateGarp(): void {
        const pool = crateGarpPool();
        const existing = this._garp.getPool('salsa/crate');
        if (existing && existing.version >= pool.version) return;
        const textures: Record<string, DecalSource> = {};
        // Whole-crate BODY colours (GARP reskins the ENTIRE face, not a label): plain wood · produce red · cargo blue.
        const stamp: Record<string, [number, number, number]> = { plain: [0.52, 0.37, 0.22], fruit: [0.58, 0.26, 0.22], cargo: [0.22, 0.31, 0.46] };
        for (const n of CRATE_SKIN_NAMES) textures[crateSkinKey(n)] = { kind: 'image', dataUrl: this._crateSkinDataUrl(stamp[n] ?? [0.52, 0.37, 0.22]) };
        if (this._prewarmCapture) return;               // P5.W4 prewarm: only the drawn canvases were wanted
        this.registerGarpPool3D(pool, textures);        // sync → atlas layers assigned
        void this.rebuildGarpAtlas3D([512, 512]);       // async → pixels + re-render
    }

    /** Built-in placeholder skins for the street-clutter pools (bin/vent/a-board/stall/poster). Drawn, idempotent;
     *  the host swaps in real stylised art via registerGarpPool3D('<poolId>', …). */
    private _ensureClutterGarp(poolId: string): void {
        const S = 512;
        const rgb = (c: [number, number, number]): string => `rgb(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0})`;
        if (poolId === 'salsa/bin') {
            const bin = (bg: [number, number, number]) => (x: CanvasRenderingContext2D): void => {
                x.fillStyle = rgb(bg); x.fillRect(0, 0, S, S);
                x.fillStyle = 'rgba(255,255,255,0.16)'; x.fillRect(0, S * 0.34, S, S * 0.1);            // ID band
                x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, S * 0.78, S, S * 0.06);                 // base shadow
            };
            this._ensureGarpPool(binGarpPool(), { [binSkinKey('municipal')]: bin([0.17, 0.33, 0.21]), [binSkinKey('recycle')]: bin([0.16, 0.28, 0.46]), [binSkinKey('brand')]: bin([0.5, 0.14, 0.14]) });
        } else if (poolId === 'salsa/vent') {
            const grate = (x: CanvasRenderingContext2D): void => {
                x.fillStyle = 'rgb(18,19,21)'; x.fillRect(0, 0, S, S);
                x.fillStyle = 'rgb(120,124,128)'; for (let i = 0; i < 10; i++) x.fillRect(20 + i * 48, 20, 30, S - 40);   // bars
            };
            this._ensureGarpPool(ventGarpPool(), { [ventSkinKey('grate')]: grate, [ventSkinKey('drain')]: grate, [ventSkinKey('utility')]: grate });
        } else if (poolId === 'salsa/aboard') {
            const board = (hdr: [number, number, number]) => (x: CanvasRenderingContext2D): void => {
                x.fillStyle = 'rgb(240,230,205)'; x.fillRect(0, 0, S, S);
                x.fillStyle = rgb(hdr); x.fillRect(0, 0, S, S * 0.2);                                   // header bar
                x.fillStyle = 'rgba(60,44,26,0.7)'; for (let i = 0; i < 6; i++) x.fillRect(40, S * 0.3 + i * 52, S * (0.4 + 0.06 * (i % 3)), 14);  // "text" lines
            };
            this._ensureGarpPool(aboardGarpPool(), { [aboardSkinKey('menu')]: board([0.14, 0.12, 0.11]), [aboardSkinKey('sale')]: board([0.6, 0.16, 0.16]), [aboardSkinKey('coffee')]: board([0.34, 0.22, 0.12]) });
        } else if (poolId === 'salsa/stall') {
            const stripe = (a: [number, number, number]) => (x: CanvasRenderingContext2D): void => {
                for (let i = 0; i < S; i += 64) { x.fillStyle = (i / 64) % 2 ? rgb(a) : 'rgb(245,240,232)'; x.fillRect(i, 0, 64, S); }
            };
            this._ensureGarpPool(stallGarpPool(), { [stallSkinKey('stripe-red')]: stripe([0.62, 0.16, 0.16]), [stallSkinKey('stripe-green')]: stripe([0.16, 0.42, 0.26]), [stallSkinKey('gingham')]: stripe([0.2, 0.3, 0.5]) });
        } else if (poolId === 'salsa/poster') {
            const poster = (a: [number, number, number], b: [number, number, number]) => (x: CanvasRenderingContext2D): void => {
                x.fillStyle = rgb(a); x.fillRect(0, 0, S, S);
                x.fillStyle = rgb(b); x.beginPath(); x.moveTo(0, S * 0.28); x.lineTo(S, S * 0.5); x.lineTo(S, S * 0.72); x.lineTo(0, S * 0.5); x.closePath(); x.fill();
                x.fillStyle = 'rgba(255,255,255,0.85)'; x.fillRect(S * 0.2, S * 0.72, S * 0.6, S * 0.12);   // title band
            };
            this._ensureGarpPool(posterGarpPool(), { [posterSkinKey('gig')]: poster([0.85, 0.18, 0.30], [0.1, 0.1, 0.12]), [posterSkinKey('notice')]: poster([0.95, 0.93, 0.85], [0.2, 0.35, 0.6]), [posterSkinKey('ad')]: poster([0.15, 0.6, 0.55], [0.95, 0.8, 0.2]) });
        } else if (poolId === 'salsa/warning') {
            // Yellow warning diamond with a black border + a simple pictogram glyph. The canonical face is a 45°
            // diamond, so the art is drawn AXIS-ALIGNED on the square texture and the geometry rotates it 45°.
            const warn = (glyph: (x: CanvasRenderingContext2D) => void) => (x: CanvasRenderingContext2D): void => {
                x.fillStyle = 'rgb(245,196,0)'; x.fillRect(0, 0, S, S);                                  // amber field
                x.strokeStyle = 'rgb(20,20,22)'; x.lineWidth = S * 0.06; x.strokeRect(S * 0.06, S * 0.06, S * 0.88, S * 0.88);   // border
                x.fillStyle = 'rgb(20,20,22)'; x.strokeStyle = 'rgb(20,20,22)'; glyph(x);
            };
            const ped = (x: CanvasRenderingContext2D): void => { x.beginPath(); x.arc(S * 0.5, S * 0.34, S * 0.07, 0, 7); x.fill(); x.lineWidth = S * 0.05; x.beginPath(); x.moveTo(S * 0.5, S * 0.42); x.lineTo(S * 0.5, S * 0.66); x.moveTo(S * 0.5, S * 0.5); x.lineTo(S * 0.4, S * 0.62); x.moveTo(S * 0.5, S * 0.5); x.lineTo(S * 0.6, S * 0.62); x.moveTo(S * 0.5, S * 0.66); x.lineTo(S * 0.42, S * 0.8); x.moveTo(S * 0.5, S * 0.66); x.lineTo(S * 0.58, S * 0.8); x.stroke(); };
            const cons = (x: CanvasRenderingContext2D): void => { x.beginPath(); x.moveTo(S * 0.5, S * 0.3); x.lineTo(S * 0.72, S * 0.72); x.lineTo(S * 0.28, S * 0.72); x.closePath(); x.fillStyle = 'rgb(20,20,22)'; x.fill(); };   // heap
            const curve = (x: CanvasRenderingContext2D): void => { x.lineWidth = S * 0.08; x.beginPath(); x.moveTo(S * 0.42, S * 0.78); x.quadraticCurveTo(S * 0.42, S * 0.4, S * 0.62, S * 0.4); x.quadraticCurveTo(S * 0.82, S * 0.4, S * 0.62, S * 0.24); x.stroke(); };
            const bang = (x: CanvasRenderingContext2D): void => { x.font = `bold ${S * 0.6}px sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('!', S * 0.5, S * 0.54); };
            this._ensureGarpPool(warningGarpPool(), { [warningSkinKey('pedestrian')]: warn(ped), [warningSkinKey('construction')]: warn(cons), [warningSkinKey('curve')]: warn(curve), [warningSkinKey('generic')]: warn(bang) });
        }
    }

    /** A 512×512 crate face in `base` colour — the WHOLE face is the crate (plank bands + a frame), so a GARP skin
     *  reskins the entire crate. No label patch (that read as a grey square floating on every face). */
    private _crateSkinDataUrl(base: [number, number, number]): string {
        return this._placeholderPng('crate:' + base.join(','), (ctx) => {
            const c = (m: number): string => `rgb(${Math.round(Math.min(255, base[0] * 255 * m))},${Math.round(Math.min(255, base[1] * 255 * m))},${Math.round(Math.min(255, base[2] * 255 * m))})`;
            ctx.fillStyle = c(1);   ctx.fillRect(0, 0, 512, 512);                             // crate body, full face
            ctx.strokeStyle = c(0.58); ctx.lineWidth = 10;
            for (let y = 48; y < 512; y += 96) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke(); }  // plank gaps
            ctx.strokeStyle = c(0.48); ctx.lineWidth = 18; ctx.strokeRect(14, 14, 484, 484); // crate frame / corner battens
        });
    }

    /** A 512×512 solid-colour PNG data URL — the built-in body-skin placeholders (a flat brand colour). */
    private _solidColorDataUrl(rgb: [number, number, number]): string {
        return this._placeholderPng('solid:' + rgb.join(','), (ctx) => {
            ctx.fillStyle = `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
            ctx.fillRect(0, 0, 512, 512);
        });
    }

    // ── ADVERTS — the GARP signage pool (docs/ui/garp.md §Adverts) ─────────────────────────────────────
    // The user's own images on the city's sign faces. Forwarded straight to the SignageController (browser half:
    // decode / pack / rebuild); the image list lives in the GARP registry (persisted in garp.json).
    private _signageCtl: SignageController | null = null;
    private get _signage(): SignageController {
        return this._signageCtl ??= new SignageController({
            garp: this._garp,
            resolveBitmap: (src) => this._resolveDecalBitmap(src),
            rebuildAtlas: () => this.rebuildGarpAtlas3D([512, 512]),
            refreshCity: () => this.world.refreshAdverts(),
            compose: (job) => composeAtlasSheet(job, { priority: 'visible' }),   // page packing + normalise OFF-THREAD
            seedBitmap: (src, bmp) => this._garpAtlas.seed(src, bmp),
        });
    }
    /** Add an advert image to a bucket ('auto' = by the image's aspect). Packs, rebuilds the atlas and (batched)
     *  the city. Returns the new id (null + errors on failure). */
    public addSignageImage3D(bucket: AdvertBucket | 'auto', source: string, opts?: AddSignageOptions): Promise<{ id: string | null; bucket: AdvertBucket | null; errors: string[] }> {
        return this._signage.add(bucket, source, opts);
    }
    /** BATCH add: the same per-item results as addSignageImage3D in a loop, but ONE re-pack + atlas rebuild + city
     *  rebuild for the whole batch (any bucket, incl. the shop-window ones). */
    public addSignageImages3D(items: readonly SignageAddItem[]): Promise<{ id: string | null; bucket: AdvertBucket | null; errors: string[] }[]> {
        return this._signage.addMany(items);
    }
    /** Remove an advert image (re-packs; the city rebuilds). False when the id is unknown. */
    public removeSignageImage3D(id: string, regen = true): Promise<boolean> { return this._signage.remove(id, regen); }
    /** Backlit (glows at night) vs an unlit poster, per image. False when the id is unknown. */
    public setSignageImageLit3D(id: string, lit: boolean, regen = true): boolean { return this._signage.setLit(id, lit, regen); }
    /** Every advert image (panel rows: id, bucket, lit, aspect, name, dataUrl thumbnail), in add order. */
    public listSignageImages3D(): SignageImageInfo[] { return this._signage.list(); }
    /** Force a re-pack + atlas rebuild (normally automatic). */
    public packSignage3D(): Promise<void> { return this._signage.pack(); }
    /** The four buckets (label, aspect range, recommended size, images per page, cell px, current count). */
    public signageBuckets3D(): SignageBucketInfo[] { return this._signage.buckets(); }
    /** Fraction 0..1 of eligible city signs that show an image (default 1); the rest keep procedural lettering. */
    public setSignageShare3D(share: number, regen = true): void { this._signage.setShare(share, regen); }
    public getSignageShare3D(): number { return this._signage.share; }
    /** Remove every advert image (the city returns to procedural signs). Shop-window images stay. */
    public clearSignage3D(regen = true): Promise<void> { return this._signage.clear(regen); }

    // ── SHOP WINDOWS (persona-polish C4; docs/ui/garp.md §Shop windows) ─────────────────────────────────
    // Shop-interior + poster images on the city's shopfront glass. Same pool / storage / packing / persistence as the
    // adverts (two extra buckets no sign classifies into); forwarded straight to the SignageController.
    /** Add a shop-window image: 'interior' (a shop's back wall, seen with real parallax through clear glass) or
     *  'poster' (a sheet on the inside of the glass). Returns the new id (null + errors on failure). */
    public addShopImage3D(bucket: ShopImageBucket, source: string, opts?: AddSignageOptions): Promise<{ id: string | null; bucket: AdvertBucket | null; errors: string[] }> {
        return this._signage.addShop(bucket, source, opts);
    }
    /** Remove a shop-window image (re-packs; the city rebuilds). False when the id is unknown. */
    public removeShopImage3D(id: string, regen = true): Promise<boolean> { return this._signage.remove(id, regen); }
    /** Lit (glows at night with the shop) vs unlit, per image. */
    public setShopImageLit3D(id: string, lit: boolean, regen = true): boolean { return this._signage.setLit(id, lit, regen); }
    /** Every shop-window image (panel rows), in add order. */
    public listShopImages3D(): SignageImageInfo[] { return this._signage.listShop(); }
    /** The two shop buckets (label, aspect range, recommended size, images per page, cell px, current count). */
    public shopImageBuckets3D(): SignageBucketInfo[] { return this._signage.shopBuckets(); }
    /** Fraction 0..1 of shop bays that show a shop image (default 1); the rest keep the procedural interior. */
    public setShopImageShare3D(share: number, regen = true): void { this._signage.setShopShare(share, regen); }
    public getShopImageShare3D(): number { return this._signage.shopShare; }
    /** Remove every shop-window image (shops return to the procedural interiors). */
    public clearShopImages3D(regen = true): Promise<void> { return this._signage.clearShop(regen); }

    /** Remove a user (or built-in) skin from a GARP pool, then rebuild — for the panel's delete/iterate action.
     *  Returns validation problems. Regenerate the city to drop it from machines (position hash re-picks). */
    public async removeGarpSkin3D(poolId: string, skinName: string): Promise<string[]> {
        const errs = this._garp.removeSkin(poolId, skinName);
        await this.rebuildGarpAtlas3D([512, 512]);
        this.renderer3D.markInstancesDirty();
        return errs;
    }

    /** Declare whether a pool `slot` renders in-world yet (drives the host's "not shown in-city" badge). Slots
     *  are live by default; a host wiring a custom pool's consumer marks its slots — the engine marks vending's. */
    public setGarpSlotLive3D(poolId: string, slot: string, live: boolean): void {
        this._garp.setSlotLive(poolId, slot, live);
    }

    /** The UV REGIONS of a slot's authoring canvas — one labelled rect (0..1, y-down like an image) per surface the
     *  square maps to. The host draws these as overlays so the user knows which patch lands where. A slot with a
     *  non-trivial UNWRAP (the vending `body` shell → six face regions, front-dominant) returns those; a plain
     *  0→1-quad slot (e.g. `products`, a banner) returns a single full-canvas region. */
    public garpSlotRegions3D(poolId: string, slot: string): { label: string; u0: number; v0: number; u1: number; v1: number }[] {
        if (poolId === 'salsa/vending' && slot === 'body') {
            return VENDING_BODY_UV_REGIONS.map((r) => ({ label: r.label, u0: r.rect[0], v0: r.rect[1], u1: r.rect[2], v1: r.rect[3] }));
        }
        if (poolId === 'salsa/vending' && slot === 'labels') {
            // The 8 can-label areas of the packed sheet (the rim band above each is drawn by the packer).
            return Array.from({ length: VENDING_LABEL_CELLS }, (_, i) => {
                const l = vendingLabelCell(i).label;
                return { label: `can ${i + 1}`, u0: l[0], v0: l[1], u1: l[2], v1: l[3] };
            });
        }
        return [{ label: '(full)', u0: 0, v0: 0, u1: 1, v1: 1 }];
    }

    /** Register a GARP pool + its skin-slot textures (each an ephemera/upload {@link DecalSource}, resolved
     *  lazily). Returns validation problems ([] = OK). Call {@link rebuildGarpAtlas3D} afterwards to build pixels. */
    public registerGarpPool3D(pool: GarpPool, textures: Record<string, DecalSource>): string[] {
        const errs = this._garp.registerPool(pool);
        for (const [key, source] of Object.entries(textures)) this._garp.registerTexture(key, source);
        return errs;
    }

    /** Resolve every registered GARP texture (ephemera render / uploaded image → bitmap, via the decal path) and
     *  (re)build the dedicated GARP atlas. `size` is the one fixed resolution the atlas packs (mismatches skipped).
     *  Async because ephemera rasterises through an <img>. Safe to re-run; drops to the 1×1 placeholder if empty. */
    public rebuildGarpAtlas3D(size: [number, number] = [512, 512]): Promise<void> {
        // COALESCED + per-source bitmap CACHE (garp-atlas-builder.ts, perf-plan P3.2e): overlapping requests share one
        // in-flight build + one trailing build; only changed textures are decoded / fitted.
        return this._garpAtlas.rebuild(size);
    }
    private _garpAtlasBuilder: GarpAtlasBuilder | null = null;
    private get _garpAtlas(): GarpAtlasBuilder {
        return this._garpAtlasBuilder ??= new GarpAtlasBuilder({
            garp: this._garp,
            resolveBitmap: (src) => this._resolveDecalBitmap(src),
            beforeBuild: () => this._signage.ensurePacked(),   // ADVERTS: pack any changed / restored signage pages first
            upload: (layers, sz) => this.renderer3D.uploadGarpAtlas(layers, sz),
            afterUpload: () => {
                this._garp.markAtlasClean();
                this.renderer3D.markInstancesDirty();   // re-pack so any garpLayer meshes pick up their atlas layer
                this.scheduleRender();
            },
        });
    }

    /** Compose a sheet OFF-THREAD ('atlas' lane), falling back to the main-thread canvas `legacy` painter on failure. */
    private async _composeSheetDataUrl(plan: SheetPlan, bitmaps: ImageBitmap[], legacy: () => string | null): Promise<string | null> {
        if (atlasComposeSupported()) {
            try {
                // Clone-send (no transfer) so the legacy path still has the bitmaps if the job fails.
                const r = await composeAtlasSheet(
                    { plan, sources: bitmaps, encode: { mime: 'image/png' } }, { priority: 'interactive', transfer: false });
                if (r.dataUrl) return r.dataUrl;
            } catch { /* legacy */ }
        }
        return legacy();
    }

    /**
     * Add a user-authored SKIN (a texture per slot) to an existing GARP pool, then rebuild the atlas — the
     * "save as GARP variant" bridge (docs/ui/garp.md). Each slot's source is a {@link DecalSource}:
     *   · `{ kind: 'image', dataUrl }` — an uploaded image, a 2D-raster-doc export, or a mesh-texture readback
     *     (see {@link exportMeshTextureDataUrl3D}); · `{ kind: 'ephemera', typeId, params }` — a generator.
     * Surface-AGNOSTIC: draw on the 2D raster doc, paint in UV mode, or upload — all end here as a DecalSource.
     * The new variant is eligible on every pooled instance from the NEXT (re)generation (selection is by position
     * hash over the runtime pool). Returns validation problems ([] = OK).
     */
    /**
     * PACK the user's CAN DESIGNS into a skin's `labels` sheet (docs/specs/vending-machine-redesign.md): 1–8 image data
     * URLs, one per can design → one 512² sheet (4×2 cells, padded, rim bands drawn), registered as `skinName`'s
     * `labels` texture, atlas rebuilt. Each image is STRETCHED to its label cell (author at 1:2 portrait for no
     * distortion; sizes needn't match); fewer than 8 repeat to fill the cells. Keeps the skin's other slots. A NEW
     * skin name is refused (a skin needs a `body`, which has no default) — add it with addGarpSkin3D first, or use a
     * built-in brand name (red / blue / cyan). Returns problems ([] = OK).
     */
    public async packVendingCanLabels3D(skinName: string, images: string[]): Promise<string[]> {
        this._ensureVendingGarp();
        const prev = this._garp.getPool('salsa/vending')?.skins.find((sk) => sk.name === skinName);
        // A skin must have a body (the pool defaults only products + labels) — don't register a half skin.
        if (!prev) return [`no vending skin "${skinName}" — add it first (addGarpSkin3D with a body), or use a built-in brand`];
        const bitmaps = (await Promise.all(images.slice(0, VENDING_LABEL_CELLS).map((u) => this._resolveDecalBitmap({ kind: 'image', dataUrl: u }))))
            .filter((b): b is ImageBitmap => !!b);
        if (!bitmaps.length) return ['no readable images'];
        // Composed OFF-THREAD from the pure vendingLabelSheetOps plan (same cells / rims as _drawVendingLabelSheet).
        const sheet = (await this._composeSheetDataUrl(vendingLabelSheetOps(bitmaps.length), bitmaps,
            () => this._drawVendingLabelSheet((ctx, cell, x, y, w, h) => ctx.drawImage(bitmaps[cell % bitmaps.length], x, y, w, h)))) ?? '';
        const key = `salsa/vending/${skinName}/labels`;
        this._garp.registerTexture(key, { kind: 'image', dataUrl: sheet });
        const errs = this._garp.addSkin('salsa/vending', { ...prev, slots: { ...prev.slots, labels: key } });
        await this.rebuildGarpAtlas3D([512, 512]);
        return errs;
    }

    /** Generic sheet packer: `images` (data URLs) into a `cols`×`rows` grid on a `size`² canvas, each STRETCHED to its
     *  cell with `padPx` of bled padding per side (no filtering bleed between cells). Returns a PNG data URL, or null
     *  if no image could be read. For other props with many small varied items (books, snacks, signs). */
    public async packGarpSheet3D(images: string[], cols: number, rows: number, size = 512, padPx = 4): Promise<string | null> {
        const bitmaps = (await Promise.all(images.map((u) => this._resolveDecalBitmap({ kind: 'image', dataUrl: u })))).filter((b): b is ImageBitmap => !!b);
        if (!bitmaps.length) return null;
        // One pure plan (bleed into the padding, then the art inset), painted off-thread or by the canvas fallback.
        const plan = garpGridSheetOps(bitmaps.length, cols, rows, size, padPx);
        return this._composeSheetDataUrl(plan, bitmaps, () => {
            if (typeof document === 'undefined') return null;
            const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            paintSheetOps(ctx, plan.ops, bitmaps);
            return canvas.toDataURL('image/png');
        });
    }

    /** A blank TEMPLATE for the vending can-label sheet (512² PNG data URL): each cell's label area with its number
     *  and a dashed safe area, the rim bands in grey — so a user can see the layout (their own PNGs go in
     *  packVendingCanLabels3D as separate 1:2 images; this is a guide, not required). */
    public vendingLabelTemplate3D(): string {
        return this._drawVendingLabelSheet((ctx, cell, x, y, w, h) => {
            ctx.fillStyle = '#f4f4f6'; ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = '#9aa0aa'; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
            ctx.strokeRect(x + w * 0.1, y + h * 0.06, w * 0.8, h * 0.88);
            ctx.setLineDash([]); ctx.fillStyle = '#6a7080'; ctx.font = `bold ${Math.round(w * 0.3)}px sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(cell + 1), x + w / 2, y + h / 2);
        });
    }

    public async addGarpSkin3D(poolId: string, skinName: string, slotSources: Record<string, DecalSource>): Promise<string[]> {
        const slots: Record<string, string> = {};
        for (const [slot, source] of Object.entries(slotSources)) {
            const key = `${poolId}/${skinName}/${slot}`;   // unique, stable texture key for this skin's slot
            this._garp.registerTexture(key, source);
            slots[slot] = key;
        }
        const errs = this._garp.addSkin(poolId, { name: skinName, slots });
        await this.rebuildGarpAtlas3D([512, 512]);
        this.renderer3D.markInstancesDirty();
        return errs;
    }

    /** Spawn a standalone, paintable copy of the vending BODY shell (with its real front-dominant unwrap) at the
     *  origin and enter UV Paint on it — so you can paint the skin on the ACTUAL 3D form + its UV pane, then
     *  {@link addGarpSkin3D} (via `saveVendingSkin`) to register it. The preview mesh is PLAIN-textured (NOT garpTex)
     *  so your strokes show live; the exported texture then feeds the `body` slot, which shares this unwrap. Returns
     *  the mesh id (pass it to `saveVendingSkin`). NOTE: with the current unwrap only the FRONT is a paintable region
     *  (sides/top are a single corner texel) — a full per-face unwrap is needed to paint distinct side/top art. */
    // ── Skins ↔ UV Paint bridges (docs/ui/garp.md §Bridges) ────────────────────────────────────────────
    // Bridge 1 (Skins → UV Paint): spawn a temporary paintable preview of a pool slot's canonical geometry (its
    // real unwrap), TAG it with (poolId, slot), and enter UV Paint. Bridge 2 (UV Paint → Skins): the host reads the
    // tag (garpPaintTargetOf3D) to show a "Save as skin variant" button, then saveMeshAsGarpSkin3D commits it.
    private readonly _garpPaintTargets = new Map<string, { poolId: string; slot: string }>();
    private _garpPaintPreviewId: string | null = null;

    /** The canonical LOCAL geometry a pool slot is painted against (its real unwrap), or null if the slot has no
     *  3D form to paint on (a plain 0→1 quad slot is authored on the flat canvas, not here). Extend per pool. */
    private _garpSlotGeometry(poolId: string, slot: string): MeshGeometry | null {
        if (poolId === 'salsa/vending' && slot === 'body') return vendingShellGeometry({}, 1);      // 1:1 metres
        if (poolId === 'salsa/vending' && slot === 'products') return vendingProductsGeometry({}, 1);  // flat display panel
        return null;
    }

    /**
     * BRIDGE 1 — spawn a temporary, paintable preview of `poolId`/`slot`'s canonical geometry (its real per-face
     * unwrap) and enter UV Paint on it, so the user paints the skin on the actual 3D form. The preview is PLAIN-
     * textured (not garpTex) so strokes show live, `excludeFromDocument` (never persisted), and TAGGED so the UV
     * Paint panel can offer "Save as skin variant". Returns the mesh id, or null if the slot has no 3D form. Tear
     * down with {@link saveMeshAsGarpSkin3D} (saves + disposes) or {@link cancelGarpPaint3D} (discards).
     */
    public paintGarpSlot3D(poolId: string, slot: string): string | null {
        const geometry = this._garpSlotGeometry(poolId, slot);
        if (!geometry) return null;
        this._disposeGarpPaintPreview();   // one preview at a time
        const mesh = this.createCustomMesh3D(0, 0.9, 0, geometry, { roughness: 0.6, doubleSided: true });
        mesh.excludeFromDocument = true;
        this._garpPaintTargets.set(mesh.id, { poolId, slot });
        this._garpPaintPreviewId = mesh.id;
        this.enterUVPaintMode3D(mesh.id);
        this.scheduleRender();
        return mesh.id;
    }
    /** Convenience: paint the vending `body` slot on the machine shell. */
    public paintVendingBody3D(): string | null { return this.paintGarpSlot3D('salsa/vending', 'body'); }

    /** BRIDGE 2 query — is `meshId` a paint-target for a GARP pool slot (so the UV Paint panel shows "Save as skin
     *  variant")? Returns the pool/slot + the pool's display name, or null. Only meshes spawned by {@link paintGarpSlot3D}
     *  are tagged today; a future "any pooled prop is a paint target" can register more tags here. */
    public garpPaintTargetOf3D(meshId: string): { poolId: string; slot: string; poolName: string } | null {
        const t = this._garpPaintTargets.get(meshId);
        if (!t) return null;
        return { poolId: t.poolId, slot: t.slot, poolName: this._garp.getPool(t.poolId)?.name ?? t.poolId };
    }

    /** BRIDGE 2 commit — export the painted mesh's texture and add it as a new skin (named `skinName`) to the pool/
     *  slot the mesh is tagged for, then tear down the preview. Unpainted sibling slots fall back to the pool default
     *  (so a body-only save still validates). Returns validation problems; regenerate the city to see it applied. */
    public async saveMeshAsGarpSkin3D(meshId: string, skinName: string): Promise<string[]> {
        const t = this._garpPaintTargets.get(meshId);
        if (!t) return [`mesh ${meshId} is not a GARP paint target`];
        const dataUrl = await this.exportMeshTextureDataUrl3D(meshId);
        if (!dataUrl) return [`no paint texture on mesh ${meshId}`];
        const errs = await this.addGarpSkin3D(t.poolId, skinName, { [t.slot]: { kind: 'image', dataUrl } });
        this._disposeGarpPaintPreview();
        return errs;
    }

    /** BRIDGE 1/2 cancel — discard the current paint preview without saving (exits UV Paint + removes the temp mesh). */
    public cancelGarpPaint3D(): void { this._disposeGarpPaintPreview(); }

    private _disposeGarpPaintPreview(): void {
        const id = this._garpPaintPreviewId;
        if (!id) return;
        this._garpPaintPreviewId = null;
        this._garpPaintTargets.delete(id);
        if (this.isUVPaintActive3D(id)) this.exitUVPaintMode3D();
        this.deleteMesh3D(id);
        this.scheduleRender();
    }

    /** Export a UV-painted / textured mesh's CURRENT texture as a PNG data URL — the readback the "save current
     *  paint as a GARP variant" flow uses (feed the result to {@link addGarpSkin3D} as `{kind:'image', dataUrl}`).
     *  Null if the mesh has no tracked paint texture (only meshes painted/uploaded via the UV-paint path have one). */
    public async exportMeshTextureDataUrl3D(meshId: string): Promise<string | null> {
        const mgr = this.getUVPaintTexture3D(meshId);
        if (!mgr) return null;
        const blob = await mgr.exportToBlob('image/png');
        return await this._blobToDataUrl(blob);
    }

    /** Export the ACTIVE 2D raster layer as a PNG data URL — the **"Use canvas"** GARP-authoring path (docs/ui/garp.md).
     *  Draw a logo in the 2D document (full fill/bucket/layer/import tools), then capture the active layer → feed the
     *  result to {@link addGarpSkin3D} as `{kind:'image', dataUrl}`. Null if there's no raster doc / no selected layer. */
    public async exportActiveLayerDataUrl(): Promise<string | null> {
        const id = this.rasterLayerManager?.getSelectedLayerId();
        if (!id) return null;
        const layer = this.rasterLayerManager!.getLayerById(id);
        if (!layer?.manager) return null;
        const blob = await layer.manager.exportToBlob('image/png');
        return await this._blobToDataUrl(blob);
    }

    private _blobToDataUrl(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = () => reject(r.error ?? new Error('FileReader failed'));
            r.readAsDataURL(blob);
        });
    }

    /**
     * DEV harness (docs/specs/city-props-garp.md §2, verification-first): register a 2-skin pool from ephemera,
     * build the GARP atlas, and drop a ROW of `count` instanced boxes — each wearing a POSITION-HASHED skin via
     * pickSkin → skinLayer → per-instance textureIndex. Verifies the whole path (dedicated atlas + shader select +
     * per-instance skin) end to end, before Frogmarks builds any panel. Adjacent boxes should differ; the row is
     * deterministic per position (re-run drops the same skins). Reachable via `salsaGarp.demo()`.
     */
    public async garpDemo3D(count = 6): Promise<string | null> {
        // Pull ONE ephemera per CATEGORY so the skins look distinct (the first N in a single category tend to be
        // variants of one motif — e.g. all barcodes — which hides the per-instance variation even when it works).
        const distinct = this._ephemera.getCategories()
            .map((c) => this._ephemera.getGeneratorsByCategory(c.id)[0]?.typeId)
            .filter((t): t is string => !!t);
        if (distinct.length < 2) return null;
        const skinTypeIds = distinct.slice(0, 4);   // up to 4 visibly-different skins
        const pool: GarpPool = {
            id: 'salsa/garp-demo', name: 'garp-demo', version: 1, size: [512, 512], slots: ['skin'],
            skins: skinTypeIds.map((_, i) => ({ name: `skin${i}`, slots: { skin: `garp-demo-${i}` } })),
        };
        const textures: Record<string, DecalSource> = {};
        skinTypeIds.forEach((typeId, i) => { textures[`garp-demo-${i}`] = { kind: 'ephemera', typeId, params: {} }; });
        this.registerGarpPool3D(pool, textures);
        await this.rebuildGarpAtlas3D([512, 512]);

        // A row of boxes, spaced along x. Instance 0 = the source mesh (carries garpLayer); 1..N-1 = the array.
        const gap = 1.1, x0 = -((count - 1) * gap) / 2, y = 1, z = 0, seed = 1;
        const skinAt = (x: number) => pickSkin(pool, x, z, seed);
        const assigned: string[] = [];
        const layerAt = (x: number): number => {
            const skin = skinAt(x);
            assigned.push(skin?.name ?? '∅');
            return skin ? this._garp.skinLayer(pool.id, skin, 'skin') : 0;
        };
        const src = this.createBox3D(x0, y, z, 0.8, 1.4, 0.5, { hasTexture: true, garpTex: true, roughness: 1, metalness: 0 });
        src.name = 'garp-demo';
        src.garpLayer = layerAt(x0);
        src.gpuDirty = true;
        if (count > 1) {
            const offsets = Array.from({ length: count - 1 }, (_, k) => [(k + 1) * gap, 0, 0] as [number, number, number]);
            const arr = new ArrayGroup3D(this.interactionService, src.id, { mode: 'explicit', offsets });
            arr.name = `garp-demo ×${count}`;
            const overrides = new Map<number, InstanceOverride>();
            for (let k = 0; k < count - 1; k++) overrides.set(k, { textureIndex: layerAt(x0 + (k + 1) * gap) });
            arr.instanceOverrides = overrides;
            (src.parent ?? this.sceneGraph.root).addChild(arr);
            this.scene3d.registerRestoredArrayGroups();
        }
        this.renderer3D.markInstancesDirty();
        this.emitSceneGraphChanged();
        this.scheduleRender();
        // Numeric proof of per-instance variation, independent of whether the eye can tell the skins apart.
        // eslint-disable-next-line no-console
        console.log(`[garp] ${pool.skins.length} skins (${skinTypeIds.join(', ')}) → boxes L→R:`, assigned.join(' '));
        return src.id;
    }

    /**
     * DEV harness (docs/specs/city-props-garp.md §2) — the VENDING consumer, proving the piece the box demo can't:
     * MULTI-SLOT COORDINATION. Registers the real vending pool (one skin per brand, each with a `fascia` + a
     * `products` texture), builds the atlas, and drops a ROW of `count` machines. Each machine picks ONE skin by
     * position hash, and its fascia + products BOTH come from that skin — a machine can never wear a red fascia
     * over a blue product grid. Cabinet is tinted by the brand so the coordinated set reads at a glance; the
     * console logs each machine's brand. Reachable via `salsaGarp.vending()`.
     *
     * NOTE: this uses one mesh per panel (per-mesh garpLayer), NOT the city's merged/instanced placement — wiring
     * GARP into the actual city means rewiring furniture.ts's merge-emit into instancing (a separate task).
     */
    public async garpVendingDemo3D(count = 6): Promise<string | null> {
        const ephIds = this._ephemera.getCategories()
            .map((c) => this._ephemera.getGeneratorsByCategory(c.id)[0]?.typeId)
            .filter((t): t is string => !!t);
        if (ephIds.length < 2) return null;
        const pool = vendingGarpPool();

        // Give each brand a COORDINATED pair of textures (a fascia + a products motif). Different brands draw
        // from different ephemera so the whole skin varies; the pairing is FIXED per brand → coordination.
        const textures: Record<string, DecalSource> = {};
        VENDING_BRANDS.forEach((b, i) => {
            textures[vendingSkinKey(b.name, 'body')]     = { kind: 'ephemera', typeId: ephIds[(i * 2) % ephIds.length], params: {} };
            textures[vendingSkinKey(b.name, 'products')] = { kind: 'ephemera', typeId: ephIds[(i * 2 + 1) % ephIds.length], params: {} };
        });
        this.registerGarpPool3D(pool, textures);
        await this.rebuildGarpAtlas3D([512, 512]);

        // A row of machines, each = a body box + a products panel (both GARP-textured from the machine's ONE chosen
        // skin — a machine never mixes brands). Real metres, 1 world unit = 1 m.
        const gap = 1.4, x0 = -((count - 1) * gap) / 2, seed = 7, W = 0.84, H = 1.8, D = 0.6, fz = D * 0.5 + 0.01;
        const chosen: string[] = [];
        let firstId: string | null = null;
        for (let i = 0; i < count; i++) {
            const x = x0 + i * gap;
            const skin = pickSkin(pool, x, 0, seed);
            chosen.push(skin?.name ?? '∅');
            const bodyLayer     = skin ? this._garp.skinLayer(pool.id, skin, 'body')     : 0;
            const productsLayer = skin ? this._garp.skinLayer(pool.id, skin, 'products') : 0;

            // createBox3D adds each mesh to the scene root automatically. The whole body box wears the skin.
            const body = this.createBox3D(x, H * 0.5, 0, W, H, D, { hasTexture: true, garpTex: true, roughness: 0.6 });
            body.garpLayer = bodyLayer;
            const products = this.createBox3D(x, H * 0.46, fz, W * 0.78, H * 0.40, 0.02, { hasTexture: true, garpTex: true });
            products.garpLayer = productsLayer;
            for (const m of [body, products]) m.gpuDirty = true;
            firstId ??= body.id;
        }
        this.renderer3D.markInstancesDirty();
        this.emitSceneGraphChanged();
        this.scheduleRender();
        // eslint-disable-next-line no-console
        console.log(`[garp] vending — machines L→R by brand:`, chosen.join(' '), '· body+products of each share one brand');
        return firstId;
    }

    /** Mode B — stamp decal into meshId texture at UV (u,v) (the UV-pane path). See DecalManager. */
    public stampDecalAtUV3D(meshId: string, source: DecalSource, u: number, v: number, opts?: { size?: number; rotation?: number }): Promise<boolean> {
        return this._decalMgr.stampDecalAtUV3D(meshId, source, u, v, opts);
    }
    /** Mode B — stamp decal where the user clicked on meshId in the 3D viewport (raycast → UV → stamp). */
    public stampDecalAtScreen3D(meshId: string, source: DecalSource, clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, opts?: { size?: number; rotation?: number }): Promise<boolean> {
        return this._decalMgr.stampDecalAtScreen3D(meshId, source, clientX, clientY, rect, opts);
    }

    /** Regenerate every decal from a loaded save's markers (called by restoreProceduralFromSave3D). */
    public restoreDecalsFromSave3D(): number { return this._decalMgr.restoreDecalsFromSave3D(); }

    /** True while a creator focus stage is active. */
    public get creatorStageActive(): boolean { return this._creatorStageNodeId !== null; }
    /** The node the creator stage is focused on, or null. */
    public get creatorStageNodeId(): string | null { return this._creatorStageNodeId; }

    /**
     * Enter the CREATOR STAGE on a creator object (a thin-wrapper container id, e.g. from createCreator3D):
     * isolate it, flatten its rotation, swap in the studio background + neutral light, and frame + orbit it
     * with a soft drift-in. Mirrors the Package Creator stage's sequence but on its own state — packaging is
     * untouched. Returns false if the node is unknown. Idempotent: exits a prior stage first.
     *
     * Sequence (see creator-modes.md §5.3): isolate → flatten → studio bg → frame+orbit → stage hygiene.
     */
    public enterCreatorStage3D(nodeId: string): boolean {
        const node = this.sceneGraph.findNodeById(nodeId) as (import('../scene-graph/shapes/mesh-group-3d').MeshGroup3D | null);
        if (!node) return false;
        if (this._creatorStageNodeId) this.exitCreatorStage3D();

        // 1 · ISOLATE — hide every top-level scene object except this node's subtree (remembering visibility).
        const iso = new Map<string, boolean>();
        for (const child of [...this.sceneGraph.root.children]) {
            const cid = (child as unknown as { id: string }).id;
            if (cid === nodeId) continue;
            iso.set(cid, (child as unknown as { visible: boolean }).visible);
            child.forEachDeep((d) => { d.visible = false; });
        }
        this._creatorStageIso = iso;
        this.emitSceneGraphChanged();

        // 2 · FLATTEN — zero the object's rotation so it presents square to the studio camera (remember it).
        const nn = node as unknown as { rotationX: number; rotationY: number; rotation: number; forEachDeep: (fn: (d: unknown) => void) => void };
        this._creatorStageSavedRot = { id: nodeId, rx: nn.rotationX, ry: nn.rotationY, rz: nn.rotation };
        nn.rotationX = 0; nn.rotationY = 0; nn.rotation = 0;
        nn.forEachDeep((d) => { const m = d as { updateLocalMatrix?: () => void }; m.updateLocalMatrix?.(); });
        this.scene3d.notifyMeshTransformsChanged3D();

        // 3 · STUDIO BACKGROUND — capture the user's focus bg, swap in the neutral studio gradient.
        this._creatorStagePrevBg = this.getMeshEditBgMode3D();

        // 4 · FRAME + ORBIT — turn the 3D pass on, uncrop, and claim the camera for a measured 3/4 orbit.
        this.scene3DVisible = true;
        this.webgpuRenderer?.setArtboardClipEnabled(false);
        this.scene3d.enterGroupOrbit3D(nodeId, { azimuth: Math.PI * 0.18, elevation: 1.0, padding: 1.7 });
        this.setMeshEditBgMode3D(CREATOR_STAGE_BG);   // after enterGroupOrbit3D turned the focus bg on

        // 5 · STAGE HYGIENE — mirrors packaging beginCreatorStage (own state): suppress box-select, clear
        // hover/selection, view gizmo, capture+swap studio lighting, drift-in, ambience ticker.
        this.interactionService.suppressBoxSelect = true;
        this.scene3d.setHoveredMesh(null);
        this.scene3d.clearSelection();
        this.scene3d.enableViewGizmo();
        if (!this._creatorStagePrevLight && !this.scene3d.iblEnabled3D) {
            this._creatorStagePrevLight = { ambient: this.renderer3D.ambientConfig, directional: this.getLight3D() };
            this.setAmbientLight3D(1, 1, 1, 0.6);
            const d = this._creatorStagePrevLight.directional.direction;
            this.renderer3D.setDirectionalLight(d[0], d[1], d[2], 1, 1, 1, 0.9);
        }
        this.scene3d.driftOrbitIn3D(450);
        if (!this._creatorStageTickRaf && typeof requestAnimationFrame !== 'undefined') {
            let last = 0;
            const tick = (now: number): void => {
                if (now - last >= 33) { last = now; this.scheduleRender(); }
                this._creatorStageTickRaf = requestAnimationFrame(tick);
            };
            this._creatorStageTickRaf = requestAnimationFrame(tick);
        }

        this._creatorStageNodeId = nodeId;
        this.scheduleRender();
        return true;
    }

    /** Exit the creator stage, restoring everything {@link enterCreatorStage3D} changed (reverse order). */
    public exitCreatorStage3D(): void {
        if (!this._creatorStageNodeId) return;

        // Release the camera + re-crop (before restoring, so the resync sees the restored scene).
        this.scene3d.exitMeshOrbit3D();
        this.webgpuRenderer?.setArtboardClipEnabled(true);

        // Restore rotation.
        if (this._creatorStageSavedRot) {
            const r = this._creatorStageSavedRot;
            const n = this.sceneGraph.findNodeById(r.id) as unknown as { rotationX: number; rotationY: number; rotation: number; forEachDeep: (fn: (d: unknown) => void) => void } | null;
            if (n) {
                n.rotationX = r.rx; n.rotationY = r.ry; n.rotation = r.rz;
                n.forEachDeep((d) => { const m = d as { updateLocalMatrix?: () => void }; m.updateLocalMatrix?.(); });
                this.scene3d.notifyMeshTransformsChanged3D();
            }
            this._creatorStageSavedRot = null;
        }

        // Restore isolation (uniform per-subtree, matching the isolate stamp).
        if (this._creatorStageIso) {
            for (const [id, vis] of this._creatorStageIso) {
                const n = this.sceneGraph.findNodeById(id);
                if (n) n.forEachDeep((d) => { d.visible = vis; });
            }
            this._creatorStageIso = null;
            this.emitSceneGraphChanged();
        }

        // Restore studio background.
        if (this._creatorStagePrevBg) { this.setMeshEditBgMode3D(this._creatorStagePrevBg); this._creatorStagePrevBg = null; }

        // End stage hygiene (mirror of packaging endCreatorStage).
        this.interactionService.suppressBoxSelect = false;
        if (this._creatorStagePrevLight) {
            const a = this._creatorStagePrevLight.ambient, dl = this._creatorStagePrevLight.directional;
            this.setAmbientLight3D(a.color[0], a.color[1], a.color[2], a.intensity);
            this.renderer3D.setDirectionalLight(dl.direction[0], dl.direction[1], dl.direction[2], dl.color[0], dl.color[1], dl.color[2], dl.intensity);
            this._creatorStagePrevLight = null;
        }
        this.scene3d.cancelOrbitDrift3D();
        if (this._creatorStageTickRaf && typeof cancelAnimationFrame !== 'undefined') {
            cancelAnimationFrame(this._creatorStageTickRaf);
            this._creatorStageTickRaf = 0;
        }

        this._creatorStageNodeId = null;
        this.scheduleRender();
    }
    public restoreFoliageFromSave3D(): number { return this.foliage.restoreFromSave(); }

    /** Drop the procedural-creator registries (foliage/building/vending/… + blocks) BEFORE a document restore, so an
     *  in-session reload re-adopts the restored containers instead of skipping them as "already managed" — the
     *  stale-registry bug that left a reloaded creator object a bare, wrong-scaled thin wrapper. Registry-only (the
     *  incoming sceneGraph restore replaces the nodes). Mirrors packaging/decals clearForDocumentLoad. */
    public clearProceduralRegistriesForLoad(): void {
        for (const m of this._creators.values()) m.clearForDocumentLoad();
        this.blocks.clearForDocumentLoad();   // standalone (not a ProceduralObjectManager) — same stale-registry fix
    }

    /**
     * ★ The ONE unconditional "forget the previous document" step, run at the top of every restore (audit 2026-09-28
     * P6). Each registry here survived a document load because its restore only ran when the new doc HAD that data —
     * so a doc without characters / CD kits / GARP pools / UI layers kept the previous doc's, and the next save wrote
     * them into this one. Add any new Map-holding registry HERE rather than special-casing its restore.
     */
    public clearDocumentRegistriesForLoad(): void {
        // FIRST: leave City mode + drop the previous doc's world (graph, traffic, streaming, in-flight builds). Its
        // exitCityMode lighting hand-back is then overwritten by the settings reset below (bug-hunt 2026-10-01).
        try { this.world?.clearForDocumentLoad(); } catch (e) { console.warn('[load] world reset failed', e); }
        // The previous doc's UV editor / UV paint (sessions keyed by its mesh ids): a host that left the document
        // without closing it kept the mesh-edit orbit + wavy focus background up in the next one (mobile-parity 7.2).
        if (this._uvSessions.size > 0 || this.uvPaint.isActive()) {
            try { this.closeAllUVEditors3D(); } catch (e) { console.warn('[load] UV editor reset failed', e); }
        }
        this.scene3d?.clearForDocumentLoad3D();          // Play stop, character rigs, kitbash catalog + baked parts, GLB store
        this.scene3d?.resetGlobalScene3DSettingsForLoad(); // fog/PS1/SSAO/… back to defaults before the doc's own
        this.world?.resetStyleForLoad();                   // the previous doc's city look (restoreFromSave sets the new one)
        this._cdKits.clear();                            // restoreCDKitsFromSave3D skipped ids it already "had"
        this.characterV2?.clearForDocumentLoad();         // Character v2 records (rebuilt from markers by restoreProceduralFromSave3D)
        this._garp.clear();
        this.ui.restore([]);                             // UI layers (only cleared when the new doc had some)
        this._uiStopAllClipPlayers();
        this._uiSound?.stopAll();                        // previous doc's (looping) UI sounds kept playing
        this.interactionService?.clearSelectedNodes();   // the 2D selection held the previous doc's (detached) nodes
        // Brush presets are per-document (brushes.json): the load only merged into the library, so the previous doc's
        // custom brushes appeared in this one and were saved into it (mobile-parity 7.2). Built-ins only from here.
        this.getRasterPaintEngine()?.resetPresetsForDocumentLoad();
    }

    /** Regenerate ALL procedural objects (City + buildings + foliage) from a loaded save's params-only markers.
     *  Call this ONCE after a document finishes loading — it replaces calling `world.restoreFromSave()` +
     *  `restoreBuildingsFromSave3D()` + `restoreFoliageFromSave3D()` separately (so none is forgotten). Order matters
     *  (City first, then its sub-objects). Returns what was restored. */
    public restoreProceduralFromSave3D(): { city: boolean; buildings: number; blocks: number; foliage: number; vending: number; packaging: number; cdKits: number } {
        // Perf diagnostic (gated via debug-log's enableConsoleDebug): per-step timing of the procedural regen so we
        // can see where a document-load freeze lives. `city` measures only the SYNCHRONOUS centre build — the
        // neighbor tiles build async off-thread and finish later. Timing is cheap; only the log below is gated.
        const _now = (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
        const _steps: [string, number][] = [];
        let _mark = _now();
        const _lapStep = (name: string): void => { const n = _now(); _steps.push([name, n - _mark]); _mark = n; };
        const city = this.world.restoreFromSave(); _lapStep('city(sync centre)');
        const blocks = this.blocks.restoreFromSave(); _lapStep('blocks');
        // Restore EVERY registered procedural creator by iterating the `_creators` registry — buildings, foliage,
        // vending, bike-rack, bollard, lamp-post, trash-bin, crate, vent, a-board, stall. Hand-listing a subset here
        // silently dropped trash-bin/crate/vent/a-board/stall on load (their geometry vanished); iterating the
        // registry is also future-proof — a newly-registered creator is restored automatically.
        const counts = new Map<string, number>();
        for (const [typeId, m] of this._creators) { counts.set(typeId, m.restoreFromSave()); _lapStep('creator:' + typeId); }
        const buildings = counts.get('building') ?? 0;
        const foliage = counts.get('foliage') ?? 0;
        const vending = counts.get('vending') ?? 0;
        this.restoreDecalsFromSave3D(); _lapStep('decals');
        // Packages are self-describing markers too (worldParams.kind==='packaging'). Re-adopt them
        // from the scene graph here — eager, independent of the scene3dJSON packaging array — so
        // getAll()/isPackageNode() work the instant a document loads (📦 icon / delete / Package Mode
        // on select), not only after the user enters creator mode. Idempotent: safe alongside the
        // restoreFromJSON path in restoreDocumentState (already-registered packages are skipped).
        const packaging = this.packaging?.restoreFromSave() ?? 0;   // getter → instantiates the manager so markers adopt even on an untouched reload
        _lapStep('packaging');
        // CD kits are self-describing markers too (worldParams.kind==='cdkit') — rebuild pieces here (BEFORE the
        // proc-texture re-apply that restores uploaded art onto them by container id + piece name).
        const cdKits = this.restoreCDKitsFromSave3D(); _lapStep('cdKits');
        // Character v2 markers (worldParams.kind==='characterV2') → rebuild the bodies (async: the asset bake is cached).
        void this.characterV2.restoreFromSave().catch((e) => console.warn('[load] character v2 restore failed', e));
        const _total = _steps.reduce((s, [, ms]) => s + ms, 0);
        debugLog(`[Salsa][load] restoreProceduralFromSave3D breakdown — TOTAL ${Math.round(_total)}ms:\n` +
            _steps.filter(([, ms]) => ms >= 0.5).sort((a, b) => b[1] - a[1]).map(([n, ms]) => `    ${Math.round(ms)}ms  ${n}`).join('\n'));
        return { city, buildings, blocks, foliage, vending, packaging, cdKits };
    }

    // ── Neighborhood Blocks (Tier-2 instancing — many buildings drawn from a few shared geometries) ──
    public createBlock3D(transform?: { x?: number; y?: number; z?: number; ry?: number }, opts?: { starter?: boolean | number }): string { return this.blocks.create(transform, opts); }

    // ── Environment styling (2026-09-29) — render style / toon shadows / rim on regenerated objects, PERSISTED ──────
    // Each call takes a PATCH: a value sets that field, `null` clears it (back to the generator's own look).
    // renderStyle: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'.
    /** A whole neighborhood BLOCK's look (every building in it). Saved with the block. False if not a block. */
    public setBlockStyle3D(id: string, patch: ObjectStylePatch): boolean { return this.blocks.setStyle(id, patch); }
    public getBlockStyle3D(id: string): ObjectStyle | null { return this.blocks.getStyle(id); }
    /** A CREATOR object's look (building / foliage / vending / bench-type props…). Saved with it. False if unknown. */
    public setCreatorStyle3D(id: string, patch: ObjectStylePatch): boolean { return this._creatorOwning(id)?.setStyle(id, patch) ?? false; }
    public getCreatorStyle3D(id: string): ObjectStyle | null { return this._creatorOwning(id)?.getStyle(id) ?? null; }
    /** The CITY's look (was render-style-only and lost on reload). Saved with the city; carries to new cities. */
    public setCityStyle3D(patch: ObjectStylePatch): void { this.world.setStyle(patch); }
    public getCityStyle3D(): ObjectStyle { return this.world.getStyle(); }
    /** The ENVIRONMENT style: applies the patch to the city + every block + every creator object at once, and NEW
     *  ones start with it. Characters and plain meshes are untouched. Saved with the document. */
    public setEnvironmentStyle3D(patch: ObjectStylePatch): void {
        const next = mergeObjectStyle(this.scene3d.environmentStyle, patch);
        this.scene3d.environmentStyle = isEmptyStyle(next) ? undefined : next;
        this.world.setStyle(patch);
        for (const id of this.blocks.ids()) this.blocks.setStyle(id, patch);
        for (const m of this._creators.values()) for (const id of m.ids()) m.setStyle(id, patch);
        this.scheduleRender();
    }
    public getEnvironmentStyle3D(): ObjectStyle { return { ...(this.scene3d.environmentStyle ?? {}) }; }

    // ── PERFORMANCE (docs/ui/performance.md §Resolution scaling / §LOD settings; the City panel's Performance group) ──
    /** RESOLUTION SCALING: render the 3D scene at a fraction of the canvas and upscale it (UI, gizmos and text stay
     *  full size). mode 'off' (default) | 'fixed' (always `scale`) | 'auto' (keep the GPU frame time under `targetMs`
     *  between `minScale` and `maxScale`). A per-machine viewport preference (localStorage), never saved in documents.
     *  Exports, thumbnails and video frames always render at full resolution. */
    public setResolutionScale3D(opts: Partial<ResolutionScaleSettings>): ResolutionScaleState { return this.webgpuRenderer.setResolutionScale(opts); }
    /** The resolution-scaling setting + `current` (the scale the 3D scene renders at now) + `gpuMs` (smoothed). */
    public getResolutionScale3D(): ResolutionScaleState { return this.webgpuRenderer.getResolutionScale(); }
    /** TEMPORAL AA / UPSCALING (engine-roadmap step 6; docs/ui/performance.md §Temporal anti-aliasing and upscaling):
     *  mode 'off' (default) | 'taa' (native-resolution TAA instead of FXAA) | 'taau' (render the 3D scene at `scale`,
     *  default 0.65, or at the resolution-scaling scale when that is Fixed / Auto, and reconstruct full size); `sharpen`
     *  0..1; `retroOff` (default true: PS1 / pixel looks keep TAA off); `inkOff` (default false). A per-machine viewport
     *  preference (localStorage), never saved in documents. Exports and snapshots render natively with FXAA. */
    public setTemporalAA3D(opts: Partial<TemporalAASettings>): TemporalAAState { return this.webgpuRenderer.setTemporalAA(opts); }
    /** The temporal AA setting + `active` / `reason` (why it is off: 'off' | 'retro' | 'ink' | 'capture' | 'compiling'),
     *  `renderScale` (the internal scale of the last TAA frame), `samples` and `velocityDraws`. */
    public getTemporalAA3D(): TemporalAAState { return this.webgpuRenderer.getTemporalAA(); }

    /** ENGINE-ROADMAP STEP 2 A/B switches (docs/ui/performance.md §Editor overhead; all default ON, a per-session
     *  setting, never saved). Each one switches a per-frame / per-structure-change scan back to the old code path:
     *   - splitRenderList: the 2D steps see only 2D nodes, the 3D draws read cached per-kind lists;
     *   - incrementalRenderList: a structure walk merges new nodes into the previous zIndex order (no full sort);
     *   - incrementalDrawOrder: the main pass draw rank merges new meshes by numeric key codes (no string re-sort);
     *   - prewarmNewOnly: a roster change queues only pipeline names not queued before (no per-mesh strings);
     *   - cachedSkeletonSync: the character skeleton sync loops over the skinned meshes only;
     *   - cachedRenderStats: getRenderStats3D sums cached per-mesh figures;
     *   - iterativeSceneWalk: getAllMeshes / getAllSkeletons share one stack walk per structure version;
     *   - coalesceStructureBumps: structure notifications between two reads of the structure version count once. */
    public setFrameScanOptions3D(o: Partial<FrameScanOptions3D>): FrameScanOptions3D {
        const wr = this.webgpuRenderer as unknown as { setFrameScanOptions?: (o: object) => unknown } | undefined;
        if (o.splitRenderList !== undefined || o.incrementalRenderList !== undefined) wr?.setFrameScanOptions?.({ splitRenderList: o.splitRenderList, incrementalRenderList: o.incrementalRenderList });
        if (o.incrementalDrawOrder !== undefined || o.prewarmNewOnly !== undefined) this.renderer3D.setStructureOptions({ incrementalDrawOrder: o.incrementalDrawOrder, prewarmNewOnly: o.prewarmNewOnly });
        const S2 = Scene3DManager.STEP2;
        if (o.cachedSkeletonSync !== undefined) S2.cachedSkeletonSync = !!o.cachedSkeletonSync;
        if (o.cachedRenderStats !== undefined) S2.cachedRenderStats = !!o.cachedRenderStats;
        if (o.iterativeSceneWalk !== undefined) S2.iterativeSceneWalk = !!o.iterativeSceneWalk;
        if (o.coalesceStructureBumps !== undefined) { ShapeManager.coalesceStructureBumps = !!o.coalesceStructureBumps; this.getSceneStructureVersion(); }
        this.scheduleRender();
        return this.getFrameScanOptions3D();
    }
    public getFrameScanOptions3D(): FrameScanOptions3D {
        const wr = this.webgpuRenderer as unknown as { getFrameScanOptions?: () => { splitRenderList: boolean; incrementalRenderList: boolean } } | undefined;
        const a = wr?.getFrameScanOptions?.() ?? { splitRenderList: false, incrementalRenderList: false };
        const b = this.renderer3D.setStructureOptions({});
        const S2 = Scene3DManager.STEP2;
        return { ...a, ...b, cachedSkeletonSync: S2.cachedSkeletonSync, cachedRenderStats: S2.cachedRenderStats, iterativeSceneWalk: S2.iterativeSceneWalk, coalesceStructureBumps: ShapeManager.coalesceStructureBumps };
    }
    /** ENGINE-ROADMAP STEP 3 A/B switches (docs/ui/performance.md §Lighter tiles; all default ON, per session, never
     *  saved). Each one switches a step-3 change back to the old code path:
     *   - incrementalTileBounds: the City gizmo bounds after a tile settles fold cached per-geometry boxes, in slices;
     *   - cachedGroupBounds: every cacheGroupBounds call folds cached per-geometry boxes (no whole-vertex walk);
     *   - collisionCells: Play collision rays inside a ready collision cell walk its merged BVH (built in a worker);
     *   - runBoxes: full tiles / the centre carry the cells' per-256-triangle run boxes (build-side: new builds);
     *   - slicedUploads: ≤ Renderer3D.UPLOAD_FRAME_BUDGET (4 MB) of geometry written a frame, big ones in slices;
     *   - crowdCellsInWorker: the instanced crowd's near / mid cells build in the 'near' worker lane;
     *   - crowdPrefetchLead: those cells prefetch ahead by a second of the camera's travel;
     *   - overlaysFogCulled: road paint / wear / gutters / storefronts are culled past the fog horizon's Far;
     *   - backdropFollowsWindow: the apron / void grid / border glow are rebuilt around the window's focus tile;
     *   - refreshReattached: a re-attached tile / restored centre takes the current glow / style at once;
     *   - orthoViewCentre: under ortho the tile window centres on the view centre, not the far-off eye;
     *   - pruneGroupBoxCache: the renderer's array-group box cache drops the entries of groups that left.
     *  Step 3b (§P13 "Step 3b"):
     *   - incrementalCollisionGrid: the Play collision broadphase adds / removes / re-cells only the meshes that
     *     changed on a structure change (collision-snapshot.ts) instead of rebuilding it (same query answers);
     *   - slicedReassembly: a streamed tile's group is wrapped, warmed and attached in slices inside the per-frame
     *     budget (WorldManager._reassembleSlice), entering the scene complete;
     *   - packInstances: the world worker sends a tile's instance lists as typed arrays (packed-instances.ts), unpacked
     *     per layer by those slices (the tile's worker-message task no longer rebuilds ~8 k objects; new builds);
     *   - scopedBackdropLod: the backdrop swap (focus-tile change) applies the LOD to its own groups instead of making
     *     the next LOD frame re-walk and re-stamp the whole world. */
    public setStep3Options3D(o: Partial<Step3Options3D>): Step3Options3D {
        if (o.incrementalTileBounds !== undefined) WorldManager.STEP3.incrementalTileBounds = !!o.incrementalTileBounds;
        if (o.runBoxes !== undefined) WorldManager.STEP3.runBoxes = !!o.runBoxes;
        if (o.cachedGroupBounds !== undefined) Scene3DManager.STEP3.cachedGroupBounds = !!o.cachedGroupBounds;
        if (o.collisionCells !== undefined) Scene3DManager.STEP3.collisionCells = !!o.collisionCells;
        if (o.slicedUploads !== undefined) Renderer3D.slicedUploads = !!o.slicedUploads;
        if (o.crowdCellsInWorker !== undefined) WorldCrowd.inWorker = !!o.crowdCellsInWorker;
        if (o.crowdPrefetchLead !== undefined) WorldCrowd.LEAD_S = o.crowdPrefetchLead ? 1.0 : 0;
        if (o.backdropFollowsWindow !== undefined) WorldManager.STEP3.backdropFollowsWindow = !!o.backdropFollowsWindow;
        if (o.refreshReattached !== undefined) WorldManager.STEP3.refreshReattached = !!o.refreshReattached;
        if (o.orthoViewCentre !== undefined) WorldManager.STEP3.orthoViewCentre = !!o.orthoViewCentre;
        if (o.pruneGroupBoxCache !== undefined) Renderer3D.pruneGroupBoxCache = !!o.pruneGroupBoxCache;
        if (o.incrementalCollisionGrid !== undefined) Scene3DManager.STEP3B.incrementalCollisionGrid = !!o.incrementalCollisionGrid;
        if (o.slicedReassembly !== undefined) WorldManager.STEP3B.slicedReassembly = !!o.slicedReassembly;
        if (o.packInstances !== undefined) WorldManager.STEP3B.packInstances = !!o.packInstances;
        if (o.scopedBackdropLod !== undefined) WorldManager.STEP3B.scopedBackdropLod = !!o.scopedBackdropLod;
        if (o.overlaysFogCulled !== undefined && !!o.overlaysFogCulled !== WorldManager.STEP3.overlaysFogCulled) {
            WorldManager.STEP3.overlaysFogCulled = !!o.overlaysFogCulled;
            this.world?.restampLod();
        }
        this.scheduleRender();
        return this.getStep3Options3D();
    }
    public getStep3Options3D(): Step3Options3D {
        return {
            incrementalTileBounds: WorldManager.STEP3.incrementalTileBounds, cachedGroupBounds: Scene3DManager.STEP3.cachedGroupBounds,
            collisionCells: Scene3DManager.STEP3.collisionCells, runBoxes: WorldManager.STEP3.runBoxes, slicedUploads: Renderer3D.slicedUploads,
            crowdCellsInWorker: WorldCrowd.inWorker, crowdPrefetchLead: WorldCrowd.LEAD_S > 0, overlaysFogCulled: WorldManager.STEP3.overlaysFogCulled,
            backdropFollowsWindow: WorldManager.STEP3.backdropFollowsWindow, refreshReattached: WorldManager.STEP3.refreshReattached,
            orthoViewCentre: WorldManager.STEP3.orthoViewCentre, pruneGroupBoxCache: Renderer3D.pruneGroupBoxCache,
            incrementalCollisionGrid: Scene3DManager.STEP3B.incrementalCollisionGrid, slicedReassembly: WorldManager.STEP3B.slicedReassembly,
            packInstances: WorldManager.STEP3B.packInstances, scopedBackdropLod: WorldManager.STEP3B.scopedBackdropLod,
        };
    }
    /** Step 3 diagnostics: Play collision (cells, rays, hood; null outside Play), geometry uploads (last / max MB a frame,
     *  geometries being sliced), the tile-bounds walk, the crowd cell builds. */
    public getStep3Stats3D(): { collision: unknown; uploads: unknown; bounds: typeof groupBoundsStats; crowd: unknown } {
        const pool = this.renderer3D.getGeomPoolStats();
        return {
            collision: this.scene3d.getCollisionStats3D(),
            uploads: { lastMB: pool.uploadLastMB, maxMB: pool.uploadMaxMB, slicing: pool.slicing, slicedGeoms: pool.slicedGeoms, budgetMB: Renderer3D.UPLOAD_FRAME_BUDGET / 1048576 },
            bounds: { ...groupBoundsStats },
            crowd: (this.world as unknown as { _crowd?: { stats: unknown } } | undefined)?._crowd?.stats ?? null,
        };
    }
    /** P16 STREAMING HITCHES (performance-plan §P16, docs/ui/performance.md §Streaming hitches): A/B switches, all on by
     *  default, per session (never saved). `indexedSlotFree` (coalesced, size-bucketed instance-slot free space),
     *  `slicedGroupPacks` (new array groups packed under a per-frame instance budget, nearest in view first, not drawn
     *  until packed), `deferredEviction` (a removed tile detaches at once, its renderer cleanup runs under a per-frame
     *  time budget), `uploadLedger` (instance + geometry writes share one per-frame byte budget, no geometry write over
     *  2 MB, fresh geometry never written whole by a compaction), `lodStampMemo` (LOD tier lookups once per name; a
     *  world restamp skips groups already stamped), `snapshotMeshVersion` (the Play collision snapshot trusts a
     *  member by its own geometry version). Returns the options after the patch. */
    public setStreamHitchOptions3D(o: Partial<StreamHitchOptions>): StreamHitchOptions {
        for (const k of Object.keys(STREAM_HITCH) as (keyof StreamHitchOptions)[]) if (o[k] !== undefined) STREAM_HITCH[k] = !!o[k];
        this.scheduleRender();
        return this.getStreamHitchOptions3D();
    }
    public getStreamHitchOptions3D(): StreamHitchOptions { return { ...STREAM_HITCH }; }
    /** P16 diagnostics: group packs deferred, deferred evictions (done / max queued / flushed by a re-attach), the
     *  upload ledger's bytes, LOD stamp skips + memo hits, the collision snapshot's last sync; `reset` zeroes them. */
    public getStreamHitchStats3D(reset = false): typeof streamHitchStats & { evictPending: number; limits: typeof STREAM_HITCH_LIMITS; snapshotSync: unknown } {
        const out = { ...streamHitchStats, evictPending: this.renderer3D.pendingEvictions, limits: { ...STREAM_HITCH_LIMITS },
            snapshotSync: (this.scene3d.getCollisionStats3D() as { snapshotSync?: unknown } | null)?.snapshotSync ?? null };
        if (reset) resetStreamHitchStats();
        return out;
    }
    /** STEP 3 BUDGETS: this frame's drawn triangles / draw calls (every pass that ran), the resident geometry MB, the
     *  instanced copies, and the keys over budget + a one-line `warning` for a HUD (null when within). Defaults: 3 M
     *  triangles, 2 k draw calls, 500 MB of geometry, 200 k instances. Cheap: poll it with the stats HUD. */
    public getSceneBudget3D(): SceneBudget3D { return this.scene3d.getSceneBudget3D(); }
    /** Set the budgets (a patch; 0 = no limit for that key; null = the defaults). Session setting, never saved. */
    public setSceneBudget3D(limits: Partial<SceneBudgetLimits3D> | null): SceneBudgetLimits3D { return this.scene3d.setSceneBudget3D(limits); }
    /** Play collision diagnostics (collision cells, rays through cells vs the per-mesh path, the hood). Null outside Play. */
    public getCollisionStats3D(): ReturnType<Scene3DManager['getCollisionStats3D']> { return this.scene3d.getCollisionStats3D(); }
    /** Play camera occluders (camera-occluders.ts): 'auto' | 'block' (the camera pulls in for it, like a wall) |
     *  'ignore' (the camera passes through it, like a lamp post). Persisted on the mesh. */
    public setMeshCameraBlock3D(meshId: string, mode: 'auto' | 'block' | 'ignore'): boolean { return this.scene3d.setMeshCameraBlock3D(meshId, mode); }
    public getMeshCameraBlock3D(meshId: string): 'auto' | 'block' | 'ignore' | null { return this.scene3d.getMeshCameraBlock3D(meshId); }
    /** How the Play camera treats a mesh right now: hard (pulls in) or soft (passed through), and the rule that decided. */
    public getCameraOccluderClass3D(meshId: string): ReturnType<Scene3DManager['getCameraOccluderClass3D']> { return this.scene3d.getCameraOccluderClass3D(meshId); }

    /** Step 2 diagnostics: render-list sizes + structure-walk counters, draw-rank / prewarm counters, structure version. */
    public getFrameScanStats3D(): { renderList: unknown; structure: unknown; structureVersion: number; structureBumps: number } {
        const wr = this.webgpuRenderer as unknown as { getRenderListStats?: () => unknown } | undefined;
        return { renderList: wr?.getRenderListStats?.() ?? null, structure: this.renderer3D.getStructureStats(), structureVersion: this._structureVersion.peek(), structureBumps: this._structureVersion.bumps };
    }
    /** SHADOW QUALITY PRESET (engine-roadmap step 7, performance-plan P14; docs/ui/performance.md §Shadow quality):
     *  'low' | 'medium' | 'high' | 'ultra' sets the PCF kernel, the cascade count + size + refresh and the far map's size
     *  + refresh together (shadow-quality.ts). In City mode it is the city LOD settings' `shadow.quality` (saved with the
     *  city; the same as setCityLodSettings3D({ shadow: { quality } })); outside a city it writes the scene's own shadow
     *  settings (map size and cascades are saved with the document's global settings; the PCF kernel is per session). */
    public setShadowQualityPreset3D(q: ShadowQualityPreset): { quality: ShadowQualityPreset | 'custom'; scope: 'city' | 'scene' } {
        if (this.world.cityMode) { this.world.setLodSettings({ shadow: { quality: q } }); return this.getShadowQualityPreset3D(); }
        const sp = shadowQualitySpec(q), r3 = this.renderer3D;
        r3.setShadowQuality(sp.pcf === '3x3' ? 1 : 0);
        r3.setShadowMapSize(sp.farMapSize);
        r3.setShadowCascades({ cascades: sp.cascades, mapSize: sp.cascadeMapSize, updateInterval: sp.cascadeInterval });
        this._sceneShadowQuality = q;
        this.scheduleRender();
        return this.getShadowQualityPreset3D();
    }
    private _sceneShadowQuality: ShadowQualityPreset = 'high';
    /** The preset in use ('custom' once a setting it owns was changed on its own) and where it lives. */
    public getShadowQualityPreset3D(): { quality: ShadowQualityPreset | 'custom'; scope: 'city' | 'scene' } {
        if (this.world.cityMode) return { quality: this.world.getLodSettingsView().shadow.qualityShown, scope: 'city' };
        const q = this._sceneShadowQuality, sp = shadowQualitySpec(q), r3 = this.renderer3D, c = r3.shadowCascades;
        const same = sp.cascades === c.cascades && (!r3.shadowsEnabled || sp.farMapSize === r3.shadowMapSize) && (c.cascades === 1 || sp.cascadeMapSize === c.mapSize);
        return { quality: same ? shadowQualityShown(q, r3.shadowPcfRadius === 1 ? '3x3' : '5x5', c.cascades) : 'custom', scope: 'scene' };
    }
    /** P14 A/B switches (per session, never saved; all default on): `farRanges` (the far shadow map's casters
     *  submit only their sub-mesh runs inside the light box / shadow reach), `cascadeCache` (near cascades keep a
     *  cached static layer and redraw only the dynamic casters), `cascadeSlackTexels` (how far the cascade box may
     *  lag before it re-centres; 0 = every texel), `sunStepDeg` (the shadow maps follow the sun in steps of this angle;
     *  0 = every change), `joinDefer` (a static caster new to a cached static layer is drawn with the dynamic casters
     *  until enough have joined: streamed tiles no longer re-render the static layers one by one), `farStaticCache`
     *  (the P4.2 far-map cache). Returns the current values. */
    public setShadowCacheOptions3D(o: Partial<{ farRanges: boolean; cascadeCache: boolean; cascadeSlackTexels: number; sunStepDeg: number; joinDefer: boolean; farStaticCache: boolean }>): { farRanges: boolean; cascadeCache: boolean; cascadeSlackTexels: number; sunStepDeg: number; joinDefer: boolean; farStaticCache: boolean } {
        const R = Renderer3D, r3 = this.renderer3D;
        if (o.farRanges !== undefined) R.shadowRangeCulling = !!o.farRanges;
        if (o.cascadeCache !== undefined) R.cascadeStaticCache = !!o.cascadeCache;
        if (typeof o.cascadeSlackTexels === 'number' && isFinite(o.cascadeSlackTexels)) R.CASCADE_FOLLOW_SLACK_TEXELS = Math.max(0, Math.min(1024, o.cascadeSlackTexels));
        if (typeof o.sunStepDeg === 'number' && isFinite(o.sunStepDeg)) R.SUN_SHADOW_STEP_DEG = Math.max(0, Math.min(5, o.sunStepDeg));
        if (o.joinDefer !== undefined) R.staticJoinDefer = !!o.joinDefer;
        if (o.farStaticCache !== undefined) r3.shadowStaticCache = !!o.farStaticCache;
        this.scheduleRender();
        return { farRanges: R.shadowRangeCulling, cascadeCache: R.cascadeStaticCache, cascadeSlackTexels: R.CASCADE_FOLLOW_SLACK_TEXELS, sunStepDeg: R.SUN_SHADOW_STEP_DEG, joinDefer: R.staticJoinDefer, farStaticCache: r3.shadowStaticCache };
    }
    /** P14 diagnostics: far-map cache counters (static re-renders and why, dynamic-layer passes, direct renders, caster
     *  counts, triangles) + near-cascade counters (static re-renders, dynamic composites, re-centres, list sizes). */
    public getShadowCacheStats3D(): ReturnType<Renderer3D['getShadowCacheStatsP14']> { return this.renderer3D.getShadowCacheStatsP14(); }
    /** P15 GPU-DRIVEN main pass (performance-plan.md §P15; per session, never saved; default OFF): `enabled` = the main
     *  pass's batched opaque segment is culled on the GPU (frustum, distance LOD, fog horizon) over a persistent record
     *  table and drawn from a render bundle of indirect draws; `lean` = the CPU then skips building the camera lists
     *  nobody reads; `mdi` = use Chrome's experimental multi-draw-indirect when the device has it and the draw order
     *  has few state buckets. Returns the current values (+ whether the device has multi-draw and the cull compiled). */
    public setGpuDriven3D(o: Parameters<Renderer3D['setGpuDriven']>[0]): ReturnType<Renderer3D['setGpuDriven']> { const r = this.renderer3D.setGpuDriven(o); this.scheduleRender(); return r; }
    /** Step 8 (performance-plan §P21): the specialised mesh shader variants: `{ enabled }` switches them (A/B; same
     *  pixels), `{ max }` caps the variant keys; returns the keys in use, compiled / pending pipelines and compile ms. */
    public setShaderVariants3D(o: Parameters<Renderer3D['setShaderVariants']>[0] = {}): ReturnType<Renderer3D['setShaderVariants']> { const r = this.renderer3D.setShaderVariants(o); this.scheduleRender(); return r; }
    public getShaderVariants3D(): ReturnType<Renderer3D['setShaderVariants']> { return this.renderer3D.setShaderVariants({}); }
    /** SHADER SPLIT phase 1 (docs/specs/shader-split.md; docs/ui/gpu-diagnostics.md): `{ enabled }` / `{ mode: 'on' |
     *  'off' | 'auto' }` switches it per machine (localStorage salsa.shaderSplit; reload for the full effect), `bisect`
     *  ('none' | 'noTexSample' | 'minimal') picks the RENDER-1 bisect keys, and the test knobs `forceFallback` /
     *  `noFallback` / `slowCompileMs` exercise the fallback and hold paths. Returns the state + keys, compiled / pending
     *  pipelines, sizes, compile ms and the exact / fallback / held selection counters. */
    // (phase 2: also `noStandIn` (shadow stand-in off), `maxKeys` (key cap, session), `exclude` (families on today's
    // pipelines, per machine: 'patterns' | 'windows' | 'adScreens' | 'ground' | 'water' | 'leaf' | 'triplanar' | 'phase2'),
    // `clearJournal`; the result adds standIn / widened / exactKeys / maxKeys / journal / exclude.)
    // (phase 3, 2026-10-07: ON BY DEFAULT on every tier; 'auto' = on. The ROLLBACK is `{ mode: 'off' }` (or
    // `{ enabled: false }`, or render debug noShaderSplit), then reload; `{ mode: 'auto' }` undoes it. The result adds
    // uberModules / uberPipelines: uber-shader modules created / replaced uber pipelines compiled, 0 while split.)
    public setShaderSplit3D(o: Parameters<Renderer3D['setShaderSplit']>[0] = {}): ReturnType<Renderer3D['setShaderSplit']> { const r = this.renderer3D.setShaderSplit(o); this.scheduleRender(); return r; }
    public getShaderSplit3D(): ReturnType<Renderer3D['setShaderSplit']> { return this.renderer3D.setShaderSplit({}); }
    /** P15 diagnostics: records / draw order / buckets, the GPU-reported counters (one frame late, `age`), rebuilds,
     *  bundle re-records, uploads, the draw mode and CPU ms. */
    public getGpuDrivenStats3D(): ReturnType<Renderer3D['getGpuDrivenStats']> { return this.renderer3D.getGpuDrivenStats(); }
    /** GPU CULLING MODE (docs/ui/performance.md §GPU-driven rendering): 'auto' (default: per frame the GPU path when
     *  the frame is CPU-bound, the classic CPU path when it is GPU-bound) / 'on' / 'off' (the CPU path exactly). A
     *  per-machine preference (localStorage), never document data. Returns what getGpuCullingMode3D returns. */
    public setGpuCullingMode3D(mode: Parameters<Renderer3D['setGpuCullingMode']>[0]): ReturnType<Renderer3D['setGpuCullingMode']> { const r = this.renderer3D.setGpuCullingMode(mode); this.scheduleRender(); return r; }
    /** The mode, the active path ('gpu' / 'cpu') and why (`reason`, `reasonText` e.g. 'CPU-bound'), the auto
     *  controller's state (switches, the last decision and its inputs) and the sub-bundle omission counters. */
    public getGpuCullingMode3D(): ReturnType<Renderer3D['getGpuCullingMode']> { return this.renderer3D.getGpuCullingMode(); }
    /** P15 verification: the next GPU-driven frame's verdicts vs the CPU path's lists (missing = an error). */
    public verifyGpuDriven3D(): ReturnType<Renderer3D['verifyGpuDriven']> { this.scheduleRender(); return this.renderer3D.verifyGpuDriven(); }
    /** CITY LOD SETTINGS: per-family draw-distance multipliers, global multiplier, aerial bias, zoom tiers, twin
     *  distances, shadow options (PCF / slack / cascades), debug tint. Live (no regen); saved with the city, opt-in. */
    public setCityLodSettings3D(patch: Parameters<WorldManager['setLodSettings']>[0]): ReturnType<WorldManager['setLodSettings']> { return this.world.setLodSettings(patch); }
    /** The LOD settings + the family table (multiplier, draw distance in units and metres) + cascades + F. */
    public getCityLodSettings3D(): ReturnType<WorldManager['getLodSettingsView']> { return this.world.getLodSettingsView(); }
    /** Live LOD readout: per-family shown / LOD-hidden / zoom-hidden counts + triangles, this frame's renderer
     *  counters (fps, GPU ms, triangles, draw calls, culled, LOD-hidden) and the current render scale. Calling it keeps
     *  GPU timing on for 3 s (a polling panel gets GPU ms without auto scaling). */
    public getCityLodStats3D(): CityLodStats {
        const wr = this.webgpuRenderer, r3 = this.renderer3D;
        wr.leaseGpuTiming(3000);
        const fs = r3.getFrameStats3D(), t = wr.getRenderTiming(), res = wr.getResolutionScale();
        const ps = splitPassStats(fs);
        return {
            families: this.world.getLodStats(id => r3.isArrayGroupLodHidden(id)),
            frame: { fps: t.fps, gpuMs: wr.getGpuFrameMs(), cpuMs: t.frameMs, trisDrawn: fs.trisDrawn, trisVisible: fs.trisVisible, drawCalls: fs.drawCalls,
                meshesCulled: fs.meshesCulled, groupsCulled: fs.groupsCulled, lodHidden: fs.lodHidden, lodTrisHidden: fs.lodTrisHidden, shadowTris: fs.shadowTris,
                trisMain: ps.tris.main, trisShadow: ps.tris.shadow, trisOther: ps.tris.other, drawsMain: ps.draws.main, drawsShadow: ps.draws.shadow, drawsOther: ps.draws.other },
            resolution: { mode: res.mode, current: res.current },
        };
    }
    /** SIMULATION LOD (performance-plan §P13, docs/ui/performance.md §Simulation LOD): merge a patch into the
     *  sim-LOD settings — `enabled` (the A/B switch), the band radii `nearM` / `midM` (metres), the rates `midHz` /
     *  `farHz` / `offscreenHz` (0 = frozen) and `fogFreeze`. Live; saved with the city LOD settings (non-default
     *  fields only). Also reachable as `setCityLodSettings3D({ sim })`. */
    public setSimLod3D(patch: Parameters<WorldManager['setSimLod']>[0]): ReturnType<WorldManager['setSimLod']> { return this.world.setSimLod(patch); }
    /** The sim-LOD settings (a copy). */
    public getSimLod3D(): SimLodSettings { return { ...this.scene3d.simLod.settings }; }
    /** Sim-LOD readout: things per band (near / mid / far / offscreen / frozen) and updates done / skipped in each
     *  system's last pass (walkers, cars, trains, otherMovers, liveCrowd, characters, springs), summed in `total`. */
    public getSimLodStats3D(): SimLodStats { return this.scene3d.simLod.stats(); }
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

    /** Bevel (chamfer) a vertex — cut the corner off into a small cap face. `amount` 0..1 along each incident edge. */
    public bevelVertex3D(meshId: string, vertexIndex: number, amount: number): boolean {
        return this.meshEdit.bevelVertex(meshId, vertexIndex, amount);
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
    public ensureUVPaintCanvas3D(meshId: string, size = 1024): HTMLCanvasElement | null { return this.uvPaint.ensureCanvas(meshId, size); }
    public commitUVTexture3D(meshId: string): void { this.uvPaint.commitCanvasTexture(meshId); }

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
                bumpGpuPixelEpoch('none', tex);   // GPU-only pixels changed (device-lost shadow; incremental autosave: this texture)
                mesh.diffuseTexture = tex; mesh.material.hasTexture = true; mesh.gpuDirty = true;
                if (mesh.isClothing) mesh.material.alphaCutout = true;   // re-enable cutout holes (harmless on opaque paint)
            } catch (e) { console.warn('[ClothPaint] restore texture failed for', key, e); }
        }
    }

    // ── UV/3D paint SESSION — extracted (uv-paint-session.ts, audit C7); thin delegators. ──
    public enterUVPaintMode3D(meshId: string, uvRenderer?: UVCanvasRenderer | null, opts?: UVBrushSettings): void { this.uvPaint.enterCharacter(meshId, uvRenderer, opts); }
    public exitUVPaintMode3D(): void { this.uvPaint.exit(); }
    public _armPackagingSurfacePaint(meshIds: string[], layerId: string, hooks: {
        readbackTexMgr: () => RasterTextureManager | null;
        onBeforeStroke?: () => void; onStrokeMove?: () => void; onStrokeEnd?: () => void;
    }): boolean { return this.uvPaint.armPackagingSurfacePaint(meshIds, layerId, hooks); }
    public setGarmentEraseStyle3D(style: 'burn' | 'clean' | 'cutout'): void { this.uvPaint.setGarmentEraseStyle(style); }
    public getGarmentEraseStyle3D(): 'burn' | 'clean' | 'cutout' { return this.uvPaint.getGarmentEraseStyle(); }
    public setUVPaintBrush3D(opts: UVBrushSettings): void { this.uvPaint.setBrush(opts); }
    public isUVPaintActive3D(meshId?: string): boolean { return this.uvPaint.isActive(meshId); }
    /** The paint texture manager for a mesh, if any (used by persistence). */
    public getUVPaintTexture3D(meshId: string): RasterTextureManager | null { return this.uvPaint.getTexture(meshId); }

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

    // ── Face kit: brows / mouth / nose / blush / hair shadow + expressions (face-features.ts; character-creator.md §2.6) ──
    /** The new-character face-kit params (seed a Face panel). */
    public getDefaultFaceFeatures3D(): FaceFeatureParams { return defaultFaceFeatureParams(); }
    /** Patch a character's face kit — live (call on every slider change). The first call turns the kit on for a face
     *  that never had it (e.g. a character saved before the kit). `{ enabled: false }` hides it (params kept). Persists. */
    public setFaceFeatures3D(bodyMeshId: string, patch: Partial<FaceFeatureParams>): boolean { return this.scene3d.faceKit.setFaceFeatures(bodyMeshId, patch); }
    /** A character's face-kit params (a copy), or null if the kit was never turned on for it. */
    public getFaceFeatures3D(bodyMeshId: string): FaceFeatureParams | null { return this.scene3d.faceKit.getFaceFeatures(bodyMeshId); }
    /** Show an expression: 'neutral' | 'smile' | 'open' | 'frown' | 'surprised' | 'default' (the resting one), or a blend
     *  of weights ({ smile: 0.6, open: 0.3 }). `blendMs` (default 180, 0 = snap), `weight` (scales a named one), `holdMs`
     *  (then back to rest). Runtime only — the RESTING expression is the `expression` param. False without a face kit. */
    public setCharacterExpression3D(bodyMeshId: string, expr: FaceExpressionName | ExpressionWeights | 'default', opts?: { blendMs?: number; weight?: number; holdMs?: number }): boolean {
        return this.scene3d.faceKit.setCharacterExpression(bodyMeshId, expr, opts);
    }
    /** The current expression ({ name: dominant, weights }), or null without a face kit. */
    public getCharacterExpression3D(bodyMeshId: string): { name: FaceExpressionName; weights: ExpressionWeights } | null { return this.scene3d.faceKit.getCharacterExpression(bodyMeshId); }
    /** The expression names (for a picker). */
    public getCharacterExpressionNames3D(): FaceExpressionName[] { return [...FACE_EXPRESSION_NAMES]; }
    /** The option lists for the Face panel's dropdowns. */
    public getFaceFeatureOptions3D(): { browStyles: BrowStyle[]; noseStyles: NoseStyle[]; expressions: FaceExpressionName[] } {
        return { browStyles: [...BROW_STYLES], noseStyles: [...NOSE_STYLES], expressions: [...FACE_EXPRESSION_NAMES] };
    }
    /** A quick brow raise (e.g. on a reaction); `amount` ~0.3–0.6. */
    public pulseCharacterBrows3D(bodyMeshId: string, amount = 0.45): void { this.scene3d.faceKit.pulseBrows(bodyMeshId, amount); }

    // ── Procedural hair (chunky low-poly; presets + sliders) ─────────────────────
    /** Default hairstyle params (the "Twintails" reference) to seed a slider panel. */
    public getDefaultHairParams3D(): HairParams { return this.scene3d.getDefaultHairParams(); }
    /** The anime hair STYLE presets (hairMode 'locks'; docs/ui/character-creator.md "Hair styles") for a style picker. */
    public getHairStyles3D(): { name: string; label: string }[] { return hairStyleList(); }
    /** Full HairParams for a style preset (`lockSeed` varies the per-lock jitter); null for an unknown name. */
    public getHairStylePreset3D(name: string, lockSeed = 0): HairParams | null { return hairStylePreset(name, lockSeed); }
    /** Apply a style preset to a body's hair, keeping its colours (root / tip / gradient / fade) unless `keepColors` is false. */
    public applyHairStyle3D(bodyMeshId: string, name: string, keepColors = true): boolean {
        const cur = this.getHairParams3D(bodyMeshId);
        const pre = hairStylePreset(name, cur?.lockSeed ?? 0);
        if (!pre) return false;
        if (keepColors && cur) { pre.rootColor = cur.rootColor; pre.tipColor = cur.tipColor; pre.gradient = cur.gradient; pre.tipFade = cur.tipFade; }
        this.setHairParams3D(bodyMeshId, pre);
        return true;
    }
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
     * Play a clip ONCE over the character's idle — the idle keeps moving everything the clip doesn't (breathing, sway,
     * weight shift), the clip crossfades in/out, and its eye events fire. Turns the idle on for the clip if it was off.
     * Works in armature mode too (a "Play with idle" option). `clip` = clip name ('Wave') or id. False if not found.
     */
    public playClipOverIdle3D(bodyMeshId: string, clip: string): boolean { return this.scene3d.animation.playClipOverIdle(bodyMeshId, clip); }
    /** Whether a character is currently playing a clip over its idle (or an idle break). */
    public isPlayingOverIdle3D(bodyMeshId: string): boolean { return this.scene3d.animation.isPlayingOverIdle(bodyMeshId); }
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
        // Now covers EVERY part (was body + eyes + hair + top/bottom only — shoes/socks/base layers were missed) and
        // re-packs the material flags + persists (was gpuDirty only).
        this.scene3d.setCharacterRimLight3D(bodyMeshId, on);
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
                if (mesh.isClothing) mesh.material.alphaCutout = true;
            }
        }
        mesh.gpuDirty = true;
        // ★ If a live CHARACTER paint session was painting the mesh we just regenerated, it is now bound to
        // a DESTROYED mesh id — every stroke resolves getMesh(oldId) → null and surface painting silently
        // stops. The UV islands are stable across regen (see the method note) and we just moved the texture
        // onto newId, so re-arm the session on the rebuilt mesh, preserving the UV pane if one was attached.
        if (this._paintSessionKind === 'character' && this._uvPaintController?.activeMeshId() === oldId) {
            this.enterUVPaintMode3D(newId, this._uvPaintController.activePane());
        }
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
        bumpGpuPixelEpoch('none', tex);   // GPU-only pixels changed (device-lost shadow; incremental autosave: this texture)
        mesh.diffuseTexture = tex; mesh.material.hasTexture = true; mesh.gpuDirty = true;
        this.scheduleRender();
    }
    /** Clear a part's uploaded/painted texture override → revert to its generated colour (gradient / skin
     *  tone) or, for the eyes, the active expression. */
    public clearPartTexture3D(meshId: string): void {
        this._disposeUvPaintTexture(meshId);   // destroy the GPUTexture, not just drop the ref (B1)
        this.scene3d.reapplyPartColor(meshId);
        this.scheduleRender();
    }
    /** Remove a body's garment for one slot. */
    public removeClothing3D(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): void { this.scene3d.removeClothing(bodyMeshId, slot); }
    /** HIDE BODY UNDER CLOTHES (clothing fit round 2, docs/ui/character-creator.md §4): skin the character's opaque garments
     *  fully cover (and keep covering through the probe poses) isn't drawn, so it can't poke through. Default on;
     *  persisted per garment (`hideBody` in its params). */
    public getHideBodyUnderClothes3D(bodyMeshId: string): boolean { return (this.scene3d as any).getHideBodyUnderClothes?.(bodyMeshId) ?? true; }
    public setHideBodyUnderClothes3D(bodyMeshId: string, on: boolean): void { (this.scene3d as any).setHideBodyUnderClothes?.(bodyMeshId, on); }
    /** SKIRT HEM SWING (Play): 0 = off, 1 = default, up to 1.5; null when the character has no skirt. Persisted as the
     *  bottom's `hemSwing`. */
    public getSkirtSwing3D(bodyMeshId: string): number | null { return (this.scene3d as any).getSkirtSwing?.(bodyMeshId) ?? null; }
    public setSkirtSwing3D(bodyMeshId: string, amount: number): void { (this.scene3d as any).setSkirtSwing?.(bodyMeshId, amount); }
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
    /** Export `bodyMeshId` (or the first procedural body) as a JSON character preset string — the COMPLETE look
     *  (v2, audit 2026-09-28 C2): body, skin tone, hair, every clothing slot, charms, procedural eyes, render style.
     *  (Hand-drawn face textures are PNGs and ride the document save, not a preset.) */
    public exportCharacter3D(bodyMeshId?: string): string {
        const id = bodyMeshId ?? this._firstProceduralBody3D();
        if (!id) return JSON.stringify({ kind: 'salsa-character', version: CHARACTER_PRESET_VERSION, body: null, hair: null, clothing: {} });
        return JSON.stringify(exportCharacterPreset(this._characterPresetHost(), id));
    }
    /** Apply a JSON character preset (from exportCharacter3D) to a body — REPLACES the look: every clothing slot is
     *  applied or removed, charms replaced, eyes replaced. Old v1 presets still import (their missing sections — skin,
     *  charms, face — are left as they are). */
    public async importCharacter3D(bodyMeshId: string, preset: string | object): Promise<void> {
        await applyCharacterPreset(this._characterPresetHost(), bodyMeshId, preset);
    }
    private _characterPresetHost(): CharacterPresetHost {
        return {
            getBodyParams: (id) => this.getBodyParams3D(id),
            setBodyParams: (id, params) => this.setBodyParams3D(id, params),
            getSkinTone: (id) => this.getSkinTone3D(id),
            setSkinTone: (id, hex) => this.setSkinTone3D(id, hex),
            getHairParams: (id) => this.getHairParams3D(id),
            setHairParams: (id, params) => this.setHairParams3D(id, params),
            removeHair: (id) => this.removeHair3D(id),
            getClothingParams: (id, slot) => this.getClothingParams3D(id, slot),
            setClothingParams: (id, params) => this.setClothingParams3D(id, params),
            removeClothing: (id, slot) => this.removeClothing3D(id, slot),
            listAttachments: (id) => this.listAttachments3D(id),
            addAttachment: (id, type, placement, params) => this.addAttachment3D(id, type, placement, params),
            removeAttachment: (aid) => this.removeAttachment3D(aid),
            getFaceExpressions: (id) => this.getFaceExpressions3D(id),
            ensureFace: (id) => this.ensureFace3D(id),
            createFaceExpression: (id, name) => this.createFaceExpression3D(id, name),
            deleteFaceExpression: (id, e) => this.deleteFaceExpression3D(id, e),
            setFaceExpressionProcedural: (id, e, params) => this.setFaceExpressionProcedural3D(id, e, params),
            setActiveFaceExpression: (id, e) => this.setActiveFaceExpression3D(id, e),
            setFaceBlinkExpression: (id, e) => this.setFaceBlinkExpression3D(id, e),
            setFaceBlinkConfig: (id, cfg) => this.setFaceBlinkConfig3D(id, cfg),
            getFaceFeatures: (id) => this.getFaceFeatures3D(id),
            setFaceFeatures: (id, params) => { this.setFaceFeatures3D(id, params); },
            getRenderStyle: (id) => this.scene3d.getMesh(id)?.material.renderStyle ?? 'default',
            setRenderStyle: (id, style) => this.setRenderStyle3D(id, style as Parameters<ShapeManager['setRenderStyle3D']>[1]),
        };
    }
    /** The first procedural body mesh id in the scene, or null (convenience for export with no id). */
    private _firstProceduralBody3D(): string | null {
        for (const m of this.scene3d.getAllMeshes()) if (m.isProceduralBody) return m.id;
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

    /**
     * Leave UV editing / UV paint completely, whatever mesh it was opened on: exits paint (surface input, the idle
     * pause, double-sided restore) and closes EVERY open UV editor session, so the mesh-edit orbit + focus background
     * come down (unless full mesh-edit mode is active). The host's one "close the UV editor" call: closing by the
     * CURRENT selection's id missed the session when the selection had moved while the editor was open, leaving the
     * wavy background and the orbit up (mobile-parity 7.2). Idempotent.
     */
    public closeAllUVEditors3D(): void {
        this.exitUVPaintMode3D();
        for (const id of [...this._uvSessions.keys()]) this.closeUVEditor3D(id);
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
        const r = new UVCanvasRenderer(canvas);
        r.maxDpr = this.webgpuRenderer?.getGpuCaps?.().maxDpr ?? Infinity;   // mobile tier: the pane's DPR is capped like the main canvas
        return r;
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

    /** Shade faces smooth / flat (Blender's Shade Smooth / Flat). Omit fIdxSet → the face selection, or every face
     *  when none is selected. Undoable. See docs/specs/edit-mesh-topology.md. */
    public setFacesSmooth3D(meshId: string, fIdxSet: Set<number> | null, smooth: boolean): boolean {
        return this.meshEdit.setFacesSmooth(meshId, fIdxSet, smooth);
    }

    /** Mark / clear sharp (hard) edges by half-edge index — smooth shading never blends across them. Undoable. */
    public setSharpEdges3D(meshId: string, halfEdgeIndices: number[], sharp: boolean): boolean {
        return this.meshEdit.setSharpEdges(meshId, halfEdgeIndices, sharp);
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

    /** Add a DISPLACE modifier — push vertices along their normals (or an axis) by a noise field (surface roughness /
     *  relief: rocks, asteroids, gnarled trunks). Works best after a Subdivision modifier. Returns the stack index. */
    public addDisplaceModifier3D(meshId: string, params?: { strength?: number; frequency?: number; seed?: number; octaves?: number; direction?: 'normal' | 'x' | 'y' | 'z' }): number {
        return this.meshEdit.addDisplaceModifier(meshId, params);
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
        // The host-facing signature is a friendly flat bag; ArrayParams is a per-mode union, so this is a
        // boundary NARROWING cast (updateArrayParams3D merges only the fields valid for the group's mode).
        this.scene3d.updateArrayParams3D(groupId, params as Partial<import('../scene-graph/shapes/array-group-3d').ArrayParams>);
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

    /** Upload/apply a diffuse texture to a mesh — the HOST-FACING path (a user clicking "Upload"). Routes through
     *  the texture LIBRARY so the mesh gets a `textureLibraryId`: (1) the texture PERSISTS across save/reload (a raw
     *  `setMeshTexture` upload sets only a live GPUTexture + `hasTexture` — no persistent reference — so it was lost
     *  on reload AND read as "None" by any inspector keying off the library id); (2) it round-trips + de-dupes via
     *  the library. Internal transient uploads (text signs, sprites, decals) still call `scene3d.setMeshTexture`
     *  directly and are unaffected. Returns true on success (keeps the old boolean contract). */
    public async setMeshTexture3D(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        return (await this.scene3d.uploadAndApplyTexture(nodeId, source)) !== null;
    }

    /** Remove texture from a mesh. */
    public clearMeshTexture3D(nodeId: string): boolean {
        return this.scene3d.clearMeshTexture(nodeId);
    }

    /** Set the diffuse/normal TEXTURE UV tiling (repeat) + optional offset (pan) on a mesh. tiling [1,1] maps the
     *  image once across the mesh's UVs; larger values repeat it (smaller features), which fixes a texture looking
     *  "squashed" on a non-square face — e.g. tile the thin side of a flattened cube more on its long axis. Applies
     *  ONLY to the sampled image (not procedural surface materials). Returns false if the mesh is gone. */
    public setMeshTextureTiling3D(meshId: string, tileX: number, tileY: number, offsetX = 0, offsetY = 0): boolean {
        const m = this.scene3d.getMesh(meshId);
        if (!m) return false;
        applyMaterialPatch(m, { textureTiling: [tileX, tileY], textureOffset: [offsetX, offsetY] });
        this.scheduleRender();
        return true;
    }

    /** Current diffuse/normal texture UV transform as [tileX, tileY, offsetX, offsetY] (defaults [1,1,0,0]).
     *  Null if the mesh is gone. */
    public getMeshTextureTiling3D(meshId: string): [number, number, number, number] | null {
        const m = this.scene3d.getMesh(meshId);
        if (!m) return null;
        const t = m.material.textureTiling ?? [1, 1];
        const o = m.material.textureOffset ?? [0, 0];
        return [t[0], t[1], o[0], o[1]];
    }

    /** Toggle WORLD-SPACE TRIPLANAR projection for a mesh's diffuse texture. When on, the image is sampled by world
     *  position on 3 axis planes (blended by the normal) so texel density stays constant however the mesh is scaled
     *  — the fix for a texture squashing on a stretched/flattened mesh, no per-face UV needed. In this mode
     *  `textureTiling.x` acts as TILES PER WORLD UNIT (set it via setMeshTextureTiling3D). Returns false if the mesh
     *  is gone. (v1: diffuse only; normal map keeps UV sampling.) */
    public setMeshTriplanar3D(meshId: string, enabled: boolean): boolean {
        const m = this.scene3d.getMesh(meshId);
        if (!m) return false;
        applyMaterialPatch(m, { worldTriplanar: enabled });
        this.scheduleRender();
        return true;
    }

    /** Whether a mesh uses world-space triplanar diffuse projection. Null if the mesh is gone. */
    public getMeshTriplanar3D(meshId: string): boolean | null {
        const m = this.scene3d.getMesh(meshId);
        if (!m) return null;
        return !!m.material.worldTriplanar;
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
     * sm.setMeshMaterial(myMesh.id, myMesh.material);
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
        this._mirrorEnvFromRenderer();
        this.scheduleRender();
    }

    /** Set the ambient light. */
    public setAmbientLight3D(r: number, g: number, b: number, intensity = 1): void {
        this.renderer3D.setAmbientLight(r, g, b, intensity);
        this._mirrorEnvFromRenderer();
        this.scheduleRender();
    }

    /** The scene ENVIRONMENT owner (sun/ambient/fog now; sky/reflections/height-fog later). See environment-and-reflections.md. */
    public get environment3D() { return this.scene3d.environment3D; }

    /** Patch the procedural-sky preset + re-bake it into image-based lighting (ambient becomes sky-driven). Opt-in P1. */
    public setSky3D(sky: Parameters<typeof this.scene3d.setSky3D>[0], intensity = 1.0): void { this.scene3d.setSky3D(sky, intensity); }
    /** The current procedural-sky preset. */
    public getSky3D() { return this.scene3d.getSky3D(); }
    /** Bake the current procedural-sky preset into IBL without changing any sky params. */
    public applyProceduralSkyIBL(intensity = 1.0): void { this.scene3d.applyProceduralSkyIBL(intensity); }
    /** Apply a named atmosphere preset (sky + key light) and bake it into IBL — one-tap golden-hour/sunset/night/etc. */
    public applySkyPreset3D(name: Parameters<typeof this.scene3d.applySkyPreset3D>[0], intensity = 1.0): void { this.scene3d.applySkyPreset3D(name, intensity); }
    /** All available sky-preset keys (for a picker). */
    public listSkyPresets3D() { return this.scene3d.listSkyPresets3D(); }
    /** Undo the procedural sky/preset — restore the sun/ambient/IBL from before the first preset (true undo to the
     *  scene's own look), falling back to engine defaults if nothing was captured. What a "Clear sky" button calls. */
    public resetSky3D(): void { this.scene3d.resetSky3D(); }
    /** Reflection strength 0..1 — balance cubemap specular against diffuse ambient, independently. No re-bake. */
    public setIBLSpecularIntensity3D(v: number): void { this.scene3d.setIBLSpecularIntensity3D(v); }
    /** Diffuse sky-ambient strength, independent of reflections. */
    public setIBLDiffuseIntensity3D(v: number): void { this.scene3d.setIBLDiffuseIntensity3D(v); }
    /** Current (diffuse, specular) IBL intensities — for two sliders. */
    public getIBLIntensities3D() { return this.scene3d.getIBLIntensities3D(); }
    /** Bake ONLY the specular reflection cube from the current sky (diffuse ambient untouched). */
    public bakeSpecularOnlyIBL(): void { this.scene3d.bakeSpecularOnlyIBL(); }
    /** Turn off crisp reflections while keeping the diffuse sky ambient. */
    public clearSpecularIBL3D(): void { this.scene3d.clearSpecularIBL3D(); }
    /** Patch SSR / reflections config (P2): `{ ssr: true }` makes surfaces reflect the on-screen SCENE (over the
     *  cubemap fallback), plus ssrMaxSteps/ssrStride/ssrThickness/ssrIntensity/ssrMaxRoughness knobs. */
    public setSSR3D(reflections: Parameters<typeof this.scene3d.setSSR3D>[0]): void { this.scene3d.setSSR3D(reflections); }
    /** Current reflections config. */
    public getReflections3D() { return this.scene3d.getReflections3D(); }
    /** SSR debug view — reflective fragments show the ray-hit UV (red=u, green=v) instead of the reflected colour. */
    public setSSRDebug3D(on: boolean): void { this.scene3d.setSSRDebug3D(on); }
    /** Depth-peeling escape hatch (engine debug — not persisted): false reverts the backface-fill to the
     *  single-layer heuristic. For A/B-ing fill artifacts only; leave on otherwise. */
    public setSSRDepthPeeling3D(on: boolean): void { this.scene3d.setSSRDepthPeeling3D(on); }
    /** Deferred-SSR escape hatch (engine debug — not persisted): false reverts to the inline per-fragment
     *  trace. For A/B-ing resolve-pass artifacts only; leave on otherwise. */
    public setSSRDeferred3D(on: boolean): void { this.scene3d.setSSRDeferred3D(on); }
    /** Set a mesh's PBR roughness (0 = mirror-smooth, 1 = fully rough). Mutates the material safely (never reassign
     *  `mesh.material` — it's getter-only). For a roughness slider. */
    public setMeshRoughness3D(meshId: string, v: number): void { this.setMeshMaterial(meshId, { roughness: Math.max(0, Math.min(1, v)) }); }
    /** Set a mesh's PBR metalness (0 = dielectric, 1 = metal). For a metalness slider. */
    public setMeshMetalness3D(meshId: string, v: number): void { this.setMeshMaterial(meshId, { metalness: Math.max(0, Math.min(1, v)) }); }

    /** Per-object MATTE override: skip environment-specular reflections for this mesh (force a metal to read matte
     *  despite its metalness — dielectrics already skip env specular). Independent of the scene-wide reflection scale;
     *  persists with the mesh material. Pass `on=false` to restore normal reflections. */
    public setMeshNoEnvReflection3D(meshId: string, on: boolean): void {
        const mesh = this.scene3d.getMesh(meshId);
        if (!mesh) return;
        mesh.material.noEnvReflection = on;
        mesh.materialDirty = true; mesh.gpuDirty = true;
        this.scheduleRender();
    }

    /** Per-object NO FOG (Material3D.noFog, docs/specs/fog-horizon.md): `true` = this mesh ignores the scene fog
     *  entirely (no fog, height fog or aerial haze; never culled, faded or outline-cut by the fog horizon) — for sky
     *  domes, clouds, backdrops, UI-like props; `'hardEdge'` = only while Hard fog edge is on (the city's sky / cloud
     *  layers default to this); `false` = fogged as usual. Material-only (no geometry rebuild); persists with the mesh
     *  material. Returns false if the mesh is gone. */
    public setMeshNoFog3D(meshId: string, mode: boolean | 'hardEdge'): boolean {
        const m = this.scene3d.getMesh(meshId);
        if (!m) return false;
        applyMaterialPatch(m, { noFog: mode === 'hardEdge' ? 'hardEdge' : !!mode });
        this.scheduleRender();
        return true;
    }
    /** A mesh's no-fog setting (false when unset), or null if the mesh is gone. */
    public getMeshNoFog3D(meshId: string): boolean | 'hardEdge' | null {
        const m = this.scene3d.getMesh(meshId);
        return m ? (m.material.noFog ?? false) : null;
    }

    /** P4b: make this mesh THE planar mirror — a true mirrored re-render of the scene (back faces included,
     *  pixel-exact, works in ortho and perspective). One reflector per scene: the first flagged mesh wins.
     *  The mirror plane is the mesh's local +Z face (a flat panel's front); persists with the mesh material.
     *  Pass `on=false` to demote it back to a normal (SSR/cubemap) surface. */
    public setMeshPlanarReflector3D(meshId: string, on: boolean): void {
        const mesh = this.scene3d.getMesh(meshId);
        if (!mesh) return;
        mesh.material.planarReflector = on;
        mesh.materialDirty = true; mesh.gpuDirty = true;
        this.scheduleRender();
    }

    /** Mirror the renderer's resolved lighting/fog into the environment owner. Called after the direct-to-renderer
     *  lighting setters below (which bypass scene3d) so `environment3D.state` stays an accurate reflection. P0 = pure
     *  mirror; no re-apply, no behaviour change. */
    private _mirrorEnvFromRenderer(): void {
        const l = this.renderer3D.lightConfig, a = this.renderer3D.ambientConfig;
        this.scene3d.environment3D.recordSun(l.direction, l.color, l.intensity);
        this.scene3d.environment3D.recordAmbient(a.color, a.intensity);
        this.scene3d.environment3D.recordFog(this.renderer3D.fogConfig);
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
        this._mirrorEnvFromRenderer();
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
        this._mirrorEnvFromRenderer();
        this.scheduleRender();
    }

    /** Set just the key-light colour 0..1 (preserves direction + intensity) — for a colour swatch. */
    public setLightColor3D(r: number, g: number, b: number): void {
        const c = this.renderer3D.lightConfig;
        this.renderer3D.setDirectionalLight(c.direction[0], c.direction[1], c.direction[2], r, g, b, c.intensity);
        this._mirrorEnvFromRenderer();
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
        this._mirrorEnvFromRenderer();
        this.scheduleRender();
    }

    /** HARD FOG EDGE (2026-10-01): `true` = only the plain fog draws (aerial haze + height fog are suppressed, not
     *  cleared) so linear near/far give a sharp cutoff, and a city stops rescaling / replacing the fog. Turning it off
     *  hands the fog back to the city (re-applies its time-of-day fog). Saved with the document's global settings. */
    public setFogHardEdge3D(on: boolean): void {
        this.renderer3D.fogHardEdge = !!on;
        this.world?.onFogHardEdgeChanged();
        this.scheduleRender();
    }
    public getFogHardEdge3D(): boolean { return this.renderer3D.fogHardEdge; }

    /** FOG HORIZON (docs/specs/fog-horizon.md, docs/ui/city-quality.md "Fog horizon"): merge a patch into the fog-horizon
     *  settings (`{ reset: true }` = the defaults first) and return them. `buildingsOnly` stops every non-building
     *  family at the fog's Far (silhouette skyline), `includeAttachments` keeps signs / awnings / rooftop equipment in
     *  it, `fadeM` (metres, 0 = pop) and `fadeStyle` ('dither' | 'dither-coarse') shape the dissolve band, and
     *  `silhouetteOutlines` = false keeps the post ink outlines off fog-coloured pixels. Live (no regen); applies only
     *  while Hard edge is on and the fog is linear. Saved with the document's global settings (only non-default fields). */
    public setFogHorizon3D(patch: Partial<FogHorizonSettings> & { reset?: boolean }): FogHorizonSettings {
        const r = this.renderer3D.setFogHorizon(patch ?? {});
        this.scheduleRender();
        return r;
    }
    /** The fog-horizon settings (a copy). */
    public getFogHorizon3D(): FogHorizonSettings { return this.renderer3D.fogHorizon; }

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

    /** Configure the HOVER-OUTLINE look — the animated "hover halo" traced around any hovered mesh. patternMode 0 =
     *  flat ring (default, unchanged), 1 = scrolling stripes, 2 = dots, 3 = checker; `glow`>1 catches bloom. */
    public setHoverOutlineStyle3D(style: Partial<HighlightStyle>): void { this.scene3d.setHoverOutlineStyle3D(style); }
    public get hoverOutlineStyle3D(): HighlightStyle { return this.scene3d.hoverOutlineStyle3D; }

    /** Assign a PERSISTENT per-object outline to a mesh — its own colour + optional scrolling pattern (patternMode
     *  1 stripes / 2 dots / 3 checker; primary = `color`, secondary = `patternColor`, `speed` scrolls, `glow`>1
     *  catches bloom; `width` is the model-space thickness). Persists across save/reload. v1: regular meshes only
     *  (skinned characters need the skinned-outline follow-up). Returns false if the mesh is gone. */
    public setMeshOutline3D(meshId: string, style: Partial<HighlightStyle>): boolean { return this.scene3d.setMeshOutline3D(meshId, style); }
    /** Remove a persistent outline from a mesh. */
    public clearMeshOutline3D(meshId: string): boolean { return this.scene3d.setMeshOutline3D(meshId, null); }
    /** E3 CHARACTER OUTLINES: outline every procedural character (body + clothes + hair) now and every one created
     *  later; null = off (default). Scenery is never outlined. Returns the number of characters updated. Persists. */
    public setCharacterOutlines3D(style: Partial<HighlightStyle> | null): number { return this.scene3d.setCharacterOutlines3D(style); }
    public getCharacterOutlines3D(): Partial<HighlightStyle> | null { return this.scene3d.getCharacterOutlines3D(); }
    /** The mesh's persistent outline style, or null if none. */
    public getMeshOutline3D(meshId: string): HighlightStyle | null { return this.scene3d.getMeshOutline3D(meshId); }
    /** STACKED outlines — extra rings OUTSIDE the mesh's outline, inner → outer (e.g. red outline + white ring:
     *  `setMeshOutlineRings3D(id, [{ color: [1,1,1,1], width: 0.02 }])`). Each ring's `width` = its own thickness;
     *  other fields default to the main outline's. [] / null clears. Persists. Needs setMeshOutline3D set first. */
    public setMeshOutlineRings3D(meshId: string, rings: Partial<HighlightStyle>[] | null): boolean { return this.scene3d.setMeshOutlineRings3D(meshId, rings); }
    /** The extra outline rings (inner → outer), [] if none. */
    public getMeshOutlineRings3D(meshId: string): HighlightStyle[] { return this.scene3d.getMeshOutlineRings3D(meshId); }

    /** Global "skin softness" — wrapped/half-Lambert diffuse strength 0..1 applied to soft-lit materials (the
     *  procedural body skin by default). 0 = normal Lambert (hard shading), 1 = flattest anime look. Persists. */
    public setSoftLightingStrength3D(v: number): void { this.scene3d.setSoftLightStrength3D(v); }
    public getSoftLightingStrength3D(): number { return this.scene3d.getSoftLightStrength3D(); }
    /** Toggle soft (wrapped) diffuse lighting on one mesh's material. */
    public setMeshSoftLighting3D(meshId: string, on: boolean): boolean { return this.scene3d.setMeshSoftLighting3D(meshId, on); }

    // ── Skin toon-ramp (character-shading Part A) ────────────────────
    /** Flip a body's skin between 'classic' (smooth) and 'ramp' (banded anime skin). Opt-in per character, live. */
    public setSkinShadingMode3D(meshId: string, mode: 'classic' | 'ramp'): boolean { return this.scene3d.setSkinShadingMode3D(meshId, mode); }
    public getSkinShadingMode3D(meshId: string): 'classic' | 'ramp' { return this.scene3d.getSkinShadingMode3D(meshId); }
    /** The scene-global skin toon-ramp look (bands / softness / shadowFloor / warm shadowTint). Merged + clamped. Persists. */
    public setSkinRampSettings3D(patch: Partial<SkinRampSettings>): void { this.scene3d.setSkinRampSettings3D(patch); }
    public getSkinRampSettings3D(): SkinRampSettings { return this.scene3d.getSkinRampSettings3D(); }
    /** Sketch render style PAPER amount 0..1 (scene-wide): 1 = off-white paper + colour wash, 0 = full colour + pencil
     *  hatching. Default 0.75 (the original). Suggested UI: a "Paper" slider shown when a mesh uses Sketch. Persists. */
    public setSketchPaper3D(amount: number): void { this.scene3d.setSketchPaper3D(amount); }
    /** TOON SHADOWS — the scene-wide look for `toonShadow` materials in the Cel / Cel-HD styles: `bands` (1–4),
     *  `softness` (0–0.5), `shadowValue` (0–1, how bright the shadow is), `shadowTint` (rgb multiplier — a cool lavender
     *  = anime shadows), `saturation` (0–1). Merge-style; persists. docs/specs/film-look-and-toon-shadows.md §B. */
    public setToonShadows3D(patch: Partial<import('../renderer/3d/material-3d').ToonShadowSettings>): void { this.scene3d.setToonShadows3D(patch); }
    public getToonShadows3D(): import('../renderer/3d/material-3d').ToonShadowSettings { return this.scene3d.getToonShadows3D(); }
    /** Opt one mesh into toon shadows (visible in Cel / Cel-HD). Persists on the material. */
    public setMeshToonShadow3D(meshId: string, on: boolean): boolean { return this.scene3d.setMeshToonShadow3D(meshId, on); }
    /** WHICH meshes get the PS1 colour depth + dither: 'all' (default, the original) or 'optIn' (only meshes opted in
     *  with setMeshRetroColor3D / setCharacterRetroColor3D). Persists with the document (PS1Config.colorScope). */
    public setRetroColorScope3D(scope: 'all' | 'optIn'): void { this.renderer3D.setPS1({ colorScope: scope }); this.scheduleRender(); }
    public getRetroColorScope3D(): 'all' | 'optIn' { return this.renderer3D.ps1Config.colorScope ?? 'all'; }
    /** Opt one mesh in/out of the retro colour (used when the scope is 'optIn'). Persists. False if the mesh is gone. */
    public setMeshRetroColor3D(meshId: string, on: boolean): boolean { return this.scene3d.materials.setMeshRetroColor(meshId, on); }
    public getMeshRetroColor3D(meshId: string): boolean { return this.scene3d.materials.getMeshRetroColor(meshId); }
    /** Retro colour on a whole character (body + clothes + hair + charms); regenerated parts inherit it. Returns count. */
    public setCharacterRetroColor3D(bodyMeshId: string, on: boolean): number { return this.scene3d.materials.setCharacterRetroColor(bodyMeshId, on); }
    /** Toon shadows on a whole character (body + hair + every garment). */
    public setCharacterToonShadows3D(bodyMeshId: string, on: boolean): void { this.scene3d.setCharacterToonShadows3D(bodyMeshId, on); }
    /** MATTE (visual-polish item 10): the character's skin and every garment without specular — matte cel skin + cloth
     *  instead of glossy plastic highlights in Cel / Cel-HD (hair keeps its sheen) — now and whenever a garment is
     *  regenerated. Stored on the body, persists. New random characters get it on; saved characters keep theirs
     *  (absent = off). False if the id is gone. */
    public setCharacterMatte3D(bodyMeshId: string, on: boolean): boolean { return this.scene3d.setCharacterMatte3D(bodyMeshId, on); }
    public getCharacterMatte3D(bodyMeshId: string): boolean { return this.scene3d.getCharacterMatte3D(bodyMeshId); }
    /** PLAY CHARACTER OUTLINES (item 10): while Play runs, characters with no outline of their own (and the scene's
     *  character outlines off) get the default thin ink line — runtime only. New documents: on; documents saved before
     *  it existed: off. Persists with the document; takes effect at the next Play. */
    public setPlayCharacterOutlines3D(on: boolean): void { this.scene3d.setPlayCharacterOutlines3D(on); }
    public getPlayCharacterOutlines3D(): boolean { return this.scene3d.getPlayCharacterOutlines3D(); }
    /** RIM LIGHT look for `rimEnabled` materials (setCharacterRimLight3D / material.rimEnabled): `strength` (0 = the
     *  original built-in rim, up to 2), `width` (0–1, how far in from the edge), `hardness` (0 soft … 1 crisp toon
     *  edge), `color`. Merge-style; persists. */
    public setRimLight3D(patch: Partial<import('../renderer/3d/material-3d').RimLightSettings>): void { this.scene3d.setRimLight3D(patch); }
    public getRimLight3D(): import('../renderer/3d/material-3d').RimLightSettings { return this.scene3d.getRimLight3D(); }
    public getSketchPaper3D(): number { return this.scene3d.getSketchPaper3D(); }

    // ── Character skinning method (audit 2026-09-28 C1 Phase 3) ─────────
    /** 'linear' (original) or 'dualQuat' (volume-preserving joints). Pass a skeleton id or any mesh of the character
     *  (body / clothes / hair) — the whole character switches together. New procedural bodies are 'dualQuat'. */
    public setSkinningMethod3D(id: string, method: 'linear' | 'dualQuat'): boolean { return this.scene3d.setSkinningMethod3D(id, method); }
    public getSkinningMethod3D(id: string): 'linear' | 'dualQuat' | null { return this.scene3d.getSkinningMethod3D(id); }

    // ── Script Behaviors (docs/specs/script-behaviors.md) ────────────────
    /** Attach/replace a node's behavior source (TS or JS). Runs Play-only + non-destructive; compiled at Play start. */
    public setScriptBehavior3D(nodeId: string, source: string, opts?: { enabled?: boolean; name?: string }): void { this.scene3d.setScriptBehavior3D(nodeId, source, opts); }
    public getScriptBehavior3D(nodeId: string): ScriptBehavior | null { return this.scene3d.getScriptBehavior3D(nodeId); }
    public removeScriptBehavior3D(nodeId: string): boolean { return this.scene3d.removeScriptBehavior3D(nodeId); }
    public setScriptEnabled3D(nodeId: string, enabled: boolean): boolean { return this.scene3d.setScriptEnabled3D(nodeId, enabled); }
    public listScriptBehaviors3D(): ScriptBehavior[] { return this.scene3d.listScriptBehaviors3D(); }
    /** Transpile-check a source without attaching it — for the editor's inline error list. */
    public validateScript3D(source: string): { ok: boolean; error?: { message: string; line?: number } } { return this.scene3d.validateScript3D(source); }
    /** The ambient `.d.ts` to load into the code editor (Monaco extraLib) for script IntelliSense. */
    public getScriptContextTypes3D(): string { return this.scene3d.getScriptContextTypes3D(); }
    /** Starter behavior templates for the editor's snippet picker. */
    public getScriptSnippets3D(): ScriptSnippet[] { return this.scene3d.getScriptSnippets3D(); }

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
     * // FILM look (grain + colour fringing + halation on the bloom) — docs/specs/film-look-and-toon-shadows.md:
     * sm.setPostProcessing3D({ film: { enabled: true, grain: 0.06, grainSize: 1.5, aberration: 0.0025, halation: 0.35 } });
     * // Disable all:
     * sm.setPostProcessing3D({ bloom: { enabled: false }, vignette: { enabled: false }, colorGrade: { enabled: false }, film: { enabled: false } });
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

    // ── Scene WIND (foliage-quality.md §2.1 — the shared motion layer) ────────────────────────────
    /** Set the scene-level wind that drives every `windSway` material (all foliage + the ground-scatter
     *  vegetation, colour pass AND shadow pass). Partial patch — omitted fields keep their value.
     *  `dirDeg` = heading over the world XZ plane (0 = +X, 90 = +Z) · `strength` = tip travel in local units
     *  at windAmount 1 · `speed` = time multiplier. Defaults to a gentle breeze. */
    public setSceneWind3D(w: { dirDeg?: number; strength?: number; speed?: number }): SceneWind3D {
        this.renderer3D.setSceneWind(w);
        this.scheduleRender();
        return this.renderer3D.sceneWind;
    }
    /** The current scene wind (see {@link setSceneWind3D}). */
    public get sceneWind3D(): SceneWind3D { return this.renderer3D.sceneWind; }

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
    /** Coarse slot index for pins (-1 = cutout). Frogmarks cloth-builder feature-detects this; it existed only on
     *  Scene3DManager, so the host's cutout check silently never ran (bug-hunt 2026-10-01). */
    public getClothVertexSlot(meshId: string, col: number, row: number): number | null {
        return this.scene3d.getClothVertexSlot(meshId, col, row);
    }
    /** Fine dense vertex index for stitches (-1 = cutout). See getClothVertexSlot. */
    public getClothVertexDenseIndex(meshId: string, col: number, row: number): number | null {
        return this.scene3d.getClothVertexDenseIndex(meshId, col, row);
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

    /** All particle emitters in the scene — the outliner listing (each is a scene-graph node with
     *  position/visibility/id; pair with the canvas icon click-select + gizmo move). */
    public getParticleEmitters3D(): import('../scene-graph/shapes/particle-emitter-3d').ParticleEmitter3D[] {
        return this.scene3d.getAllParticleEmitters();
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
     * Paint a mesh's diffuse texture directly with the Canvas 2D API via a draw callback — full control
     * over pixels (rounded rects, shadows, rotated/gradient content) without the HTML/CSS subset or the
     * experimental HTML-in-Canvas browser flag. Not persisted (a callback isn't serializable); use for
     * transient overlays. Sprite geometry flips V, so draw upright.
     */
    public setCanvasTexture3D(
        meshId: string,
        width: number,
        height: number,
        draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    ): Promise<boolean> {
        return this.scene3d.setCanvasTexture3D(meshId, width, height, draw);
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

    /** Delete a 3D mesh group (children are lifted to root). Supports undo.
     *  EXCEPTION: a package root group is deleted through the packaging manager (full teardown — live-texture
     *  unlink, composite removal, hidden dieline/stack layer deletion, subtree disposal) instead of the generic
     *  lift-children-to-root path, which would strand the panels in the scene and orphan the package's layers. */
    public deleteMeshGroup3D(groupId: string): boolean {
        if (this._cdKits.has(groupId)) return this.deleteCDKit3D(groupId);
        const pkgId = this._packaging?.isPackageNode(groupId);
        if (pkgId) { this._packaging!.remove(pkgId); return true; }
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
    /** All mesh ids of one character (body + eye decal + hair + garments + attachments) — fan out whole-character
     *  outliner ops (select/hide/delete all) over these, since a "Character" outliner node is a virtual group. */
    public characterPartIds3D(bodyId: string): string[] { return this.scene3d.characterPartIds3D(bodyId); }
    /** If a mesh is a character part, the body it belongs to; else null. */
    public overlayBodyOf3D(meshId: string): string | null { return this.scene3d.overlayBodyOf3D(meshId); }

    // ── 3D Normal Maps ───────────────────────────────────────────────

    /** Upload/apply a normal map to a mesh — HOST-FACING path. Routes through the library (like setMeshTexture3D)
     *  so it gets a `normalMapLibraryId` → persists across reload + reads as set. Returns true on success. */
    public async setMeshNormalMap3D(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        return (await this.scene3d.uploadAndApplyNormalMap(nodeId, source)) !== null;
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

    // ── 2D vector OBJECT undo (P1, editing-loop-polish.md) ──────────
    // Move / rotate / scale / group / ungroup / delete of 2D shapes. Raster strokes, path-anchor
    // edits, and 3D transforms have their own stacks; host buttons should check these getters.

    get canUndo2DShapes(): boolean { return this.interactionService.vectorUndo.canUndo; }
    get canRedo2DShapes(): boolean { return this.interactionService.vectorUndo.canRedo; }
    get undoDescription2DShapes(): string | null { return this.interactionService.vectorUndo.undoDescription; }
    get redoDescription2DShapes(): string | null { return this.interactionService.vectorUndo.redoDescription; }

    public undo2DShapes(): boolean { return this.interactionService.vectorUndo.undo(); }
    public redo2DShapes(): boolean { return this.interactionService.vectorUndo.redo(); }

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
        return this._liveText.createLiveText(x, y, options);
    }

    /** Create a LiveTextNode as a FIXED FRAME from a drawn WORLD-space rectangle. */
    public createLiveTextInRect(rect: { x: number; y: number; w: number; h: number }, options?: LiveTextOptions): LiveTextNode {
        return this._liveText.createLiveTextInRect(rect, options);
    }

    /** Install (or clear, with null) a rect-draw callback for the LiveText click-drag create. */
    public setRectDrawCallback(cb: ((rect: { x: number; y: number; w: number; h: number }, clientX: number, clientY: number) => void) | null): void {
        this._liveText.setRectDrawCallback(cb);
    }

    /** Set the effect chain on a LiveTextNode. */
    public setLiveTextEffects(nodeId: string, effects: TextEffectConfig[]): void {
        this._liveText.setLiveTextEffects(nodeId, effects);
    }

    /** Update the text content of a LiveTextNode. */
    public setLiveTextContent(nodeId: string, text: string): void {
        this._liveText.setLiveTextContent(nodeId, text);
    }

    /** Update styling properties on a LiveTextNode. */
    public setLiveTextStyle(nodeId: string, style: Partial<LiveTextOptions>): void {
        this._liveText.setLiveTextStyle(nodeId, style);
    }

    /** Enter edit mode on a LiveTextNode (focus the hidden DOM element). */
    public beginLiveTextEditing(nodeId: string): void {
        this._liveText.beginLiveTextEditing(nodeId);
    }

    /** Enter edit mode AND place the caret where the user clicked (HTML-in-Canvas caret handshake). */
    public enterLiveTextEditingAt(nodeId: string, clientX: number, clientY: number): void {
        this._liveText.enterLiveTextEditingAt(nodeId, clientX, clientY);
    }

    /** Exit edit mode on a LiveTextNode. Text is synced back from the DOM. */
    public endLiveTextEditing(nodeId: string): void {
        this._liveText.endLiveTextEditing(nodeId);
    }

    /** Flatten a LiveTextNode onto the active raster layer (destroys the node, bakes its pixels). */
    public flattenLiveText(nodeId: string): Promise<boolean> {
        return this._liveText.flattenLiveText(nodeId);
    }

    /** Get a LiveTextNode by ID. Returns null if not found or not a LiveTextNode. */
    public getLiveTextNode(nodeId: string): LiveTextNode | null {
        return this._liveText.getLiveTextNode(nodeId);
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
        const node = this.getLiveTextNode(nodeId);
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
        const node = this.getLiveTextNode(nodeId);
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
        const node = this.getLiveTextNode(nodeId);
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
        _markRasterCompositeDirty(null, activeLayer.texture);   // BRUSH-5: layer pixels changed (autosave: this layer)
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
        this._stampVectorLayer(layout);
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

    // ── Path node editor (docs/specs/vector-paths.md P2) ──
    /** Enter node-edit mode on a committed Path shape: shows anchors + handles, drag to reshape, double-click
     *  a segment to insert a point, Delete removes the selected anchor, Escape/click-away exits. */
    public enterPathEdit(shapeId: string): boolean {
        const node = this.sceneGraph.findNodeById(shapeId);
        if (!(node instanceof PathNode)) return false;
        this.pathEditService.enter(node);
        return true;
    }
    public exitPathEdit(): void { this.pathEditService.exit(); }
    public get isPathEditActive(): boolean { return this.pathEditService?.active ?? false; }
    /** The Path being edited (null when inactive) — for a host anchor-inspector panel. */
    public getPathEditTarget(): PathNode | null { return this.pathEditService?.editingPath ?? null; }
    /** Fires on enter/exit and after every anchor mutation (null = exited). */
    public onPathEdited(cb: (path: PathNode | null) => void): void { this.pathEditService.onEdited = cb; }

    // ── P3: SVG path import + Polygon→Path convert (docs/specs/vector-paths.md) ──

    /**
     * Import SVG `<path d="...">` data as editable Path shapes — one PathNode per subpath, curves kept
     * as true Béziers (quadratics elevated, arcs converted; handles land on the anchors for the node
     * editor). SVG y grows DOWN and world y grows UP, so geometry is y-flipped; the group's bbox is
     * uniformly scaled to `width` world units (aspect preserved) and centered at (x, y) — default
     * viewport center, width 1. Shapes are stamped to the active vector layer like any creation.
     * Throws on malformed data. Returns the created nodes (empty array for e.g. a lone moveto).
     */
    public importSVGPath(d: string, opts?: {
        x?: number; y?: number; width?: number;
        fillColor?: RGBA; strokeColor?: RGBA; strokeWidth?: number;
    }): PathNode[] {
        const subs = parseSVGPath(d);
        if (!subs.length) return [];

        // Group bbox in SVG space (anchors + handle tips, so curve extents count).
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of subs) for (const a of s.anchors) {
            const grow = (px: number, py: number) => {
                if (px < minX) minX = px; if (px > maxX) maxX = px;
                if (py < minY) minY = py; if (py > maxY) maxY = py;
            };
            grow(a.x, a.y);
            if (a.in) grow(a.x + a.in.x, a.y + a.in.y);
            if (a.out) grow(a.x + a.out.x, a.y + a.out.y);
        }
        const bw = maxX - minX, bh = maxY - minY;
        const scale = (opts?.width ?? 1) / (bw > 1e-12 ? bw : bh > 1e-12 ? bh : 1);
        const bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;
        const [vcx, vcy] = this.interactionService.getViewportCenter();
        const cx = opts?.x ?? vcx, cy = opts?.y ?? vcy;

        const fill = opts?.fillColor ?? { r: 0.85, g: 0.85, b: 0.85, a: 1 };
        const stroke = opts?.strokeColor ?? { r: 0.6, g: 0.6, b: 0.6, a: 1 };
        const sw = opts?.strokeWidth ?? 0.01;

        const flipPt = (h: { x: number; y: number } | undefined | null) =>
            h ? { x: h.x * scale, y: -h.y * scale } : undefined;
        const created: PathNode[] = [];
        for (const s of subs) {
            const anchors: PathAnchor[] = s.anchors.map((a) => ({
                x: cx + (a.x - bcx) * scale,
                y: cy - (a.y - bcy) * scale,      // y-flip: SVG-down → world-up
                in: flipPt(a.in),
                out: flipPt(a.out),
                kind: a.kind,
            }));
            const path = this.shapeFactory.createPath(anchors, s.closed, fill, stroke, sw);
            this.sceneGraph.root.addChild(path);
            created.push(path);
        }
        this.interactionService.onSceneGraphChanged.emit();
        this.scheduleRender();
        return created;
    }

    /**
     * Convert a committed Polygon into an editable Path (corner anchors at its points) — same outline,
     * same fill/stroke/layer/transform/z-order, ready for the node editor. The Polygon is removed.
     * Returns the new PathNode, or null if the id isn't a Polygon (or has < 3 points).
     */
    public convertPolygonToPath(shapeId: string): PathNode | null {
        const node = this.sceneGraph.findNodeById(shapeId);
        if (!(node instanceof Polygon) || node.points.length < 3) return null;

        const anchors: PathAnchor[] = node.points.map((p) => ({ x: p.x, y: p.y, kind: 'corner' as const }));
        const path = this.shapeFactory.createPath(anchors, true, node.fillColor, node.strokeColor, node.strokeWidth);

        // Preserve identity-adjacent state — the factory stamped the ACTIVE layer; the original's wins.
        path.layerId = node.layerId;
        path.visible = node.visible;
        path.x = node.x; path.y = node.y;
        path.rotation = node.rotation;
        path.scaleX = node.scaleX; path.scaleY = node.scaleY;

        const parent = node.parent ?? this.sceneGraph.root;
        const idx = parent.children.indexOf(node);
        this.interactionService.deselectNode(node);
        parent.removeChild(node);
        parent.addChild(path);
        // Keep the converted shape at the original z-order slot (addChild appends).
        if (idx >= 0 && idx < parent.children.length - 1) {
            parent.children.splice(parent.children.indexOf(path), 1);
            parent.children.splice(idx, 0, path);
        }
        this.interactionService.onSceneGraphChanged.emit();
        this.scheduleRender();
        return path;
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
            this._stampVectorLayer(this.currentPreviewShape);
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
            if(this.currentPreviewShape.fillColor !== this.shapeColor)
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
        // Runtime-only nodes (the Play auto default player: body, skeleton, face decal, hair, garments) never reach a
        // document, even when a save lands mid-Play (they're only in the graph while playing).
        dropRuntimeNodesFromSceneJSON(scene.root, new Set(this.scene3d.autoPlayer.runtimeNodeIds()));
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
     * The VECTOR (2D) scene graph only: getSceneGraphJSON() without the 3D nodes (meshes, mesh groups / procedural
     * markers, array groups, emitters, skeletons, grease pencil) and without the texture library. For a host that
     * keeps the 3D scene elsewhere — Frogmarks' cloud save stores each mesh as its own blob. Loads with
     * setSceneGraphJSON. Only the 2D nodes are serialized (no 3D geometry cost). See persistence/vector-scene-json.ts.
     */
    public getSceneGraphJSON2D(): string {
        return JSON.stringify(_vectorSceneObject(this.sceneGraph.root));
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

    /** Load a serialized scene graph. Errors are logged and swallowed by default (host-facing behaviour);
     *  `opts.rethrow` re-raises them — the document-restore path uses it so a failed scene-graph load is recorded as
     *  a restore issue (and blocks autosave) instead of silently loading an empty board. */
    public async setSceneGraphJSON(jsonString: string, opts?: { rethrow?: boolean }): Promise<void> {
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
            if (opts?.rethrow) throw error;
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
    
        // Detach existing children PROPERLY — removeChild unregisters each subtree from the
        // scene graph's id map. The old `children = []` wipe left STALE nodeMap entries, so a
        // findNodeById during post-restore regeneration could resolve to a detached pre-restore
        // node — the package regen then built its pivots into that dead tree and its panel meshes
        // fell back to the scene root (caught by the P6 round-trip drive, 2026-09-15).
        for (const child of [...targetNode.children]) targetNode.removeChild(child);
    
        // Recursively recreate child nodes and attach them to the target node
        if (sourceData.children) {
            sourceData.children.forEach((childData: any) => {
                const newChild = this.recreateNode(childData);
                if (newChild) targetNode.addChild(newChild);
            });
        }
    }

    /** The collaborators {@link recreate2DShape} needs — assembled from this facade's own service fields. */
    private _shape2DRestoreDeps(): Shape2DRestoreDeps {
        return {
            shapeFactory: this.shapeFactory,
            eraserService: this.eraserService,
            patternDrawingService: this.patternDrawingService,
            stampDrawingService: this.stampDrawingService,
            sdfTextDrawingService: this.sdfTextDrawingService,
            getTextEffectEngine: () => this.getTextEffectEngine(),
            webgpuRenderer: this.webgpuRenderer,
            interactionService: this.interactionService,
        };
    }

    private recreateNode(data: any): Node | null {
        return recreateNode(data, this._shape2DRestoreDeps());
    }

    /**
     * P2 (editing-loop-polish.md): duplicate the selected 2D shapes/groups via the serializer
     * round-trip (toJSON → recreateNode with ids STRIPPED deep, so fresh ones mint), offset ~16 px
     * at the current zoom, attached to each source's own parent (duplicating inside a group or
     * section stays inside it). The copies end up selected and recorded as ONE 'Duplicate shapes'
     * undo command on the 2D object stack. 3D nodes are skipped (`duplicateMesh3D` owns those);
     * package nodes are skipped (procedural content with its own manager). Ctrl+D routes here.
     * Returns the new copies (empty when nothing eligible was selected).
     */
    /** Top-level selected 2D shapes/groups: ancestors win over selected descendants; 3D nodes and
     *  package nodes are excluded. Shared by duplicate / align / distribute / flip (P2/P4). */
    private _topLevelSelected2D(): (Shape | Group)[] {
        const sel = this.interactionService.selectedNodes;
        return Array.from(sel).filter((node) => {
            for (let p = node.parent; p; p = p.parent) if (sel.has(p)) return false;
            return true;
        }).filter((n): n is Shape | Group =>
            (n instanceof Shape || n instanceof Group)
            && !(n instanceof Mesh3D) && !(n instanceof MeshGroup3D)
            && !(n instanceof ArrayGroup3D) && !(n instanceof ParticleEmitter3D)
            && !['SkinnedMesh3D', 'Skeleton3D'].includes((n as Shape).getType?.() ?? '')
            && !(this.packaging?.isPackageNode((n as Shape).id) ?? null)
        );
    }

    public duplicateSelectedShapes(): Node[] {
        const topLevel = this._topLevelSelected2D();
        if (topLevel.length === 0) return [];

        const token = this.interactionService.vectorUndo.begin(this.sceneGraph.root, []);

        // ~16 px offset at the current zoom, converted to world units.
        const p0 = this.webgpuRenderer.canvasPxToWorld(0, 0);
        const p1 = this.webgpuRenderer.canvasPxToWorld(16, 16);
        const dx = p1[0] - p0[0], dy = p1[1] - p0[1];

        const stripIds = (d: any): void => {
            if (!d || typeof d !== 'object') return;
            delete d.id;
            if (Array.isArray(d.children)) d.children.forEach(stripIds);
        };

        const copies: Node[] = [];
        for (const src of topLevel) {
            const data = (src as Shape).toJSON();
            stripIds(data);
            const copy = this.recreateNode(data);
            if (!copy) continue;
            copy.x = src.x + dx;
            copy.y = src.y + dy;
            copy.updateLocalMatrix();
            (src.parent ?? this.sceneGraph.root).addChild(copy);
            copies.push(copy);
        }
        if (copies.length === 0) return [];

        this.interactionService.clearSelectedNodes();
        for (const c of copies) this.interactionService.selectNode(c);
        this.interactionService.vectorUndo.commit(token, 'Duplicate shapes', copies);
        this.scheduleRender();
        this.emitSceneGraphChanged();
        return copies;
    }

    // ── P4 (editing-loop-polish.md): align / distribute / flip over the selection bounds ────────
    // Facade methods for host buttons; every one records ONE undo command on the 2D object stack.
    // Bounds come from getWorldSpaceBoundingBoxPolygon (the marquee's own world-AABB source), so
    // rotated shapes, groups, scribbles, and lines all measure correctly.

    /** World-space AABB of one shape via its selection-box polygon. */
    private _worldAABB2D(n: Shape | Group): { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number } {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of n.getWorldSpaceBoundingBoxPolygon(true)) {
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
        if (!isFinite(minX)) {   // degenerate polygon — fall back to the node's world position
            const m = n.localMatrix as unknown as Float32Array;
            minX = maxX = m[12]; minY = maxY = m[13];
        }
        return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    }

    /** Translate a node by a WORLD-space delta (converted through the inverse parent chain, so it
     *  is exact under transformed parents — deltas only feel the linear part of the matrix). */
    private _moveByWorldDelta2D(n: Shape | Group, dwx: number, dwy: number): void {
        if (dwx === 0 && dwy === 0) return;
        const inv = mat4.invert(mat4.create(), n.parentChainMatrix);
        const lx = inv ? inv[0] * dwx + inv[4] * dwy : dwx;
        const ly = inv ? inv[1] * dwx + inv[5] * dwy : dwy;
        n.x += lx;
        n.y += ly;
        n.updateLocalMatrix();
        n.markDirty();
    }

    /**
     * Align the selected 2D shapes over the selection's union bounds (world space, y-up: 'top' is
     * the greatest y). One shape aligns against nothing and returns false. Undo: "Align shapes".
     */
    public alignSelectedShapes(mode: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom'): boolean {
        const shapes = this._topLevelSelected2D();
        if (shapes.length < 2) return false;
        const boxes = shapes.map((s) => this._worldAABB2D(s));
        const union = boxes.reduce((u, b) => ({
            minX: Math.min(u.minX, b.minX), minY: Math.min(u.minY, b.minY),
            maxX: Math.max(u.maxX, b.maxX), maxY: Math.max(u.maxY, b.maxY),
        }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
        const uc = { x: (union.minX + union.maxX) / 2, y: (union.minY + union.maxY) / 2 };

        const token = this.interactionService.vectorUndo.begin(this.sceneGraph.root, shapes);
        shapes.forEach((s, i) => {
            const b = boxes[i];
            let dx = 0, dy = 0;
            switch (mode) {
                case 'left':    dx = union.minX - b.minX; break;
                case 'centerX': dx = uc.x - b.cx; break;
                case 'right':   dx = union.maxX - b.maxX; break;
                case 'top':     dy = union.maxY - b.maxY; break;
                case 'middleY': dy = uc.y - b.cy; break;
                case 'bottom':  dy = union.minY - b.minY; break;
            }
            this._moveByWorldDelta2D(s, dx, dy);
        });
        const changed = this.interactionService.vectorUndo.commit(token, 'Align shapes');
        this.scheduleRender();
        this.emitSceneGraphChanged();
        return changed;
    }

    /**
     * Distribute the selected 2D shapes so their CENTERS are evenly spaced along `axis` (world
     * space). Needs 3+ shapes; the outermost two stay put. Undo: "Distribute shapes".
     */
    public distributeSelectedShapes(axis: 'x' | 'y'): boolean {
        const shapes = this._topLevelSelected2D();
        if (shapes.length < 3) return false;
        const entries = shapes
            .map((s) => ({ s, b: this._worldAABB2D(s) }))
            .sort((p, q) => axis === 'x' ? p.b.cx - q.b.cx : p.b.cy - q.b.cy);
        const first = entries[0].b, last = entries[entries.length - 1].b;
        const start = axis === 'x' ? first.cx : first.cy;
        const end = axis === 'x' ? last.cx : last.cy;
        const step = (end - start) / (entries.length - 1);

        const token = this.interactionService.vectorUndo.begin(this.sceneGraph.root, shapes);
        entries.forEach(({ s, b }, i) => {
            const target = start + step * i;
            if (axis === 'x') this._moveByWorldDelta2D(s, target - b.cx, 0);
            else this._moveByWorldDelta2D(s, 0, target - b.cy);
        });
        const changed = this.interactionService.vectorUndo.commit(token, 'Distribute shapes');
        this.scheduleRender();
        this.emitSceneGraphChanged();
        return changed;
    }

    /**
     * Flip the selected 2D shapes across the selection's center axis ('horizontal' mirrors
     * left↔right, 'vertical' top↔bottom). A single shape mirrors in place. Matrix-transformed
     * shapes get exact mirroring (position reflected, rotation negated, scale axis negated); Lines
     * mirror their endpoints (their transform must stay identity); world-space-geometry shapes
     * (Scribble/Highlight) get position mirroring only — their stroke content is world-baked.
     * Undo: "Flip shapes".
     */
    public flipSelectedShapes(axis: 'horizontal' | 'vertical'): boolean {
        const shapes = this._topLevelSelected2D();
        if (shapes.length === 0) return false;
        const boxes = shapes.map((s) => this._worldAABB2D(s));
        const union = boxes.reduce((u, b) => ({
            minX: Math.min(u.minX, b.minX), minY: Math.min(u.minY, b.minY),
            maxX: Math.max(u.maxX, b.maxX), maxY: Math.max(u.maxY, b.maxY),
        }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
        const CX = (union.minX + union.maxX) / 2, CY = (union.minY + union.maxY) / 2;
        const h = axis === 'horizontal';

        const token = this.interactionService.vectorUndo.begin(this.sceneGraph.root, shapes);
        for (const s of shapes) {
            if (s.getType?.() === 'Line') {
                // Lines keep identity scale by contract — mirror the endpoints themselves, in the
                // line's LOCAL frame (its x/y translation shifts the axis; rotation is 0 for lines).
                const line = s as unknown as { x1: number; y1: number; x2: number; y2: number;
                    updateStartPoint(x: number, y: number): void; updateEndPoint(x: number, y: number): void };
                const ax = 2 * (CX - s.x), ay = 2 * (CY - s.y);
                const [sx, sy] = h ? [ax - line.x1, line.y1] : [line.x1, ay - line.y1];
                const [ex, ey] = h ? [ax - line.x2, line.y2] : [line.x2, ay - line.y2];
                line.updateStartPoint(sx, sy);
                line.updateEndPoint(ex, ey);
                s.markDirty();
                continue;
            }
            // Reflect the node's world position across the axis.
            const m = s.localMatrix as unknown as Float32Array;
            const dwx = h ? 2 * CX - m[12] - m[12] : 0;
            const dwy = h ? 0 : 2 * CY - m[13] - m[13];
            this._moveByWorldDelta2D(s, dwx, dwy);
            // Mirror the shape's own content: M∘T∘R∘S = T'∘R(-θ)∘S(∓). Scribble/Highlight skip
            // this — their stroke points are world-baked (getScaleFactors [1,1]), so a negated
            // scale would not render. NOTE: usesWorldSpaceBoundingBox is NOT the discriminator —
            // PathNode/Polygon report true (world-space BBOX) yet transform via localMatrix.
            if (!['Scribble', 'Highlight'].includes(s.getType?.() ?? '')) {
                s.rotation = -s.rotation;
                if (h) s.scaleX = -(s.scaleX ?? 1);
                else s.scaleY = -(s.scaleY ?? 1);
                s.updateLocalMatrix();
                s.markDirty();
            }
        }
        const changed = this.interactionService.vectorUndo.commit(token, 'Flip shapes');
        this.scheduleRender();
        this.emitSceneGraphChanged();
        return changed;
    }

    /** Host override for the Delete / Backspace shortcut (null = the default {@link deleteSelectedShapes}). */
    private _deleteKeyHandler: (() => void) | null = null;
    /**
     * Route the engine's Delete / Backspace shortcut through the host's own Edit › Delete, so the key and the menu do
     * exactly the same thing (mobile-parity 7.2: the key unlinked a selected 3D mesh raw — no 3D undo, no character /
     * UV-texture teardown, a stale outliner — while the menu ran the full teardown). The engine's guards still apply
     * (typing, a selected text shape, Play, a creator mode owning input). Pass null to restore the default.
     */
    public setDeleteKeyHandler(fn: (() => void) | null): void { this._deleteKeyHandler = fn; }
    /** The engine's Delete / Backspace hook: the host's route when it set one, else the 2D shape delete. */
    private _runDeleteKey(): void {
        if (this._deleteKeyHandler) this._deleteKeyHandler();
        else this.deleteSelectedShapes();
    }

    /** Host override for the Ctrl+D shortcut (null = the default {@link duplicateSelectedShapes}). */
    private _duplicateKeyHandler: (() => void) | null = null;
    /**
     * Route the engine's Ctrl+D shortcut through the host's own Edit › Duplicate, so the key and the menu do exactly the
     * same thing (mobile-parity 7.2, the Delete fix's twin): 3D nodes sit in the 2D selection too, and the engine's
     * default only duplicates 2D shapes — a selected mesh has to go through the host's 3D duplicate (duplicateMesh3D:
     * 3D undo, characters, instance groups, the outliner). The engine's guards still apply (typing, Play, a creator
     * mode owning input) and a held Ctrl+D runs once. Pass null to restore the default.
     */
    public setDuplicateKeyHandler(fn: (() => void) | null): void { this._duplicateKeyHandler = fn; }
    /** The engine's Ctrl+D hook: the host's route when it set one, else the 2D shape duplicate. */
    private _runDuplicateKey(): void {
        if (this._duplicateKeyHandler) this._duplicateKeyHandler();
        else this.duplicateSelectedShapes();
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

        // ★ PACKAGES are not plain nodes. A package owns a panel subtree, live-texture links per panel, a
        // set of hidden tagged layer-stack layers, a running fold animation frame, and creator/stage state.
        // Unhooking just the scene node left every one of those alive — the package stayed registered
        // (getAll() still listed it), its layers lingered invisibly, and it could come back on reload. That
        // is why the Delete button "did nothing". Route them through the manager's own teardown, which
        // removes the subtree itself, and drop them from the generic path below.
        const pkg = this.packaging;
        const handled = new Set<unknown>();
        if (pkg) {
            const done = new Set<string>();
            for (const node of selected) {
                const id = (node as { id?: string }).id;
                if (!id) continue;
                const pkgId = pkg.isPackageNode(id);
                if (!pkgId || done.has(pkgId)) { if (pkgId) handled.add(node); continue; }
                done.add(pkgId);
                handled.add(node);
                pkg.remove(pkgId);
            }
        }
        // ★ Always a NEW array: `remaining` must not alias `selected` — the `selected.length = 0;
        // selected.push(...remaining)` below empties an alias first and then pushes nothing, turning
        // every non-package delete into a silent no-op (found by the P1 undo drive, 2026-09-14).
        const remaining = selected.filter(n => !handled.has(n));
        if (!remaining.length) {
            this.interactionService.clearSelectedNodes();
            this.scheduleRender();
            this.endInteractive();
            return;
        }
        selected.length = 0;
        selected.push(...remaining);

        // P1 undo (editing-loop-polish.md): snapshot before detaching. The command RETAINS the node
        // instances, so Ctrl+Z re-attaches the originals (GPU caches re-allocate on next render).
        // Packages are excluded — they were torn down above via their own manager (regenerating content).
        const undoToken = this.interactionService.vectorUndo.begin(this.sceneGraph.root, selected);

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
        this.interactionService.vectorUndo.commit(undoToken, 'Delete shapes');
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

    /** List the 2D vector shapes at the scene root (id + name), excluding 3D meshes/groups. For authoring/AI
     *  read-back (the 2D counterpart of getAllMeshesForAnimation3D). */
    /** List 2D vector shapes for an outliner / read-back — everything in the scene graph that is NOT 3D, walked
     *  recursively so shapes inside 2D groups appear (with `parentId` = the group, for an indented tree).
     *  `layerId` filters to one vector layer's shapes (a shape with NO layerId is a legacy/unassigned shape and is
     *  included in every layer's listing, mirroring the hit-test gate). Delete via selection + deleteSelectedShapes,
     *  or select programmatically with selectNodesByIds. */
    public getVectorShapes(layerId?: string): { id: string; name: string; type: string; layerId?: string; visible: boolean; parentId?: string }[] {
        const out: { id: string; name: string; type: string; layerId?: string; visible: boolean; parentId?: string }[] = [];
        const walk = (nodes: readonly unknown[], parentId?: string): void => {
            for (const c of nodes as (Shape & { children?: unknown[] })[]) {
                if (c instanceof Mesh3D || c instanceof MeshGroup3D) continue;
                // Skip construction scaffolding: the polygon tool's rubber-band/marker lines (isStaging) and
                // click-to-place ghosts (isPreview) are transient — listing them floods the outliner.
                if ((c as { isStaging?: boolean }).isStaging || (c as { isPreview?: boolean }).isPreview) continue;
                const shapeLayer = (c as { layerId?: string }).layerId;
                if (!layerId || shapeLayer === undefined || shapeLayer === layerId) {
                    out.push({
                        id: (c as { id?: string }).id ?? '',
                        name: c.name ?? '',
                        type: (c as { getType?: () => string }).getType?.() ?? 'Shape',
                        layerId: shapeLayer,
                        visible: (c as { visible?: boolean }).visible ?? true,
                        parentId,
                    });
                }
                if (Array.isArray(c.children) && c.children.length) walk(c.children, (c as { id?: string }).id);
            }
        };
        walk(this.sceneGraph.root.children);
        return out;
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
            || this._liveText.editingLiveTextId != null;
    }

    /** Returns the node ID of the LiveTextNode currently being edited, or null. */
    public getEditingLiveTextId(): string | null {
        return this._liveText.editingLiveTextId;
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

        if (!node || (node as Shape).getType() !== 'SDFText') return;

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
        // Reads only this layer (it used to read back + encode EVERY layer and keep one: N read-backs per call).
        return this.rasterLayerManager.exportLayerToBlob(layerId, type);
    }

    /**
     * Export one animation CEL's pixels as a Blob — that cel's own texture, not the frame on screen
     * (`exportRasterLayerToBlob` of an animated layer is not per cel). For a host's per-cel upload. Null for an
     * unknown / blank cel.
     */
    public async exportRasterCelToBlob(celId: string, type: 'image/webp' | 'image/png' = 'image/webp'): Promise<Blob | null> {
        return this.rasterLayerManager?.exportCelToBlob(celId, type) ?? null;
    }

    /**
     * Per-layer / per-cel CONTENT VERSIONS for a host that keeps its own copy of the raster pixels (Frogmarks' cloud
     * upload; docs/ui/document-persistence.md "Cloud"). Each value is an opaque string that changes when anything
     * writes that layer's / cel's pixels — a stroke, fill, undo / redo, paste, transform, text stamp, move, clear,
     * filter, merge, duplicate, import, load — or when its texture is replaced (resize, device recovery). Every pixel
     * writer already reports through `markRasterCompositeDirty` / `bumpGpuPixelEpoch` (raster-content-version.ts); a
     * write whose target is unknown changes EVERY version (fail safe). Paint layers only (no folders / vector layers /
     * 3D divider). `seq` = the global write count: unchanged = nothing was written since.
     *
     * Compare with the version you read just BEFORE your last export of that layer / cel; a different string = upload
     * again. Cheap (no GPU work): fine to call on every save.
     */
    public getRasterContentVersions(): { seq: number; layers: Record<string, string>; cels: Record<string, string> } {
        const v = this.rasterLayerManager?.getContentVersions() ?? { layers: {}, cels: {} };
        return { seq: _rasterContentSeq(), layers: v.layers, cels: v.cels };
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
        // (A 0×0 canvas — not laid out yet — would make every layer texture invalid; keep the current size then.)
        if (canvas && canvas.width > 0 && canvas.height > 0 && this.rasterLayerManager) {
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

    /**
     * Export the illustration artboard as a TRANSPARENT PNG. Renders the 2D content (raster + vector shapes) with a
     * transparent clear at artboard framing, so no-content / no-background areas are transparent (lines float) —
     * unlike captureDocumentBoundsToBlob, which bakes in the opaque canvas background. Ephemera compositing is a
     * follow-up (they render on a DOM overlay, not the GPU frame — see docs/specs/textured-artboard.md).
     * Frames the artboard for a full-res, fully-on-canvas capture, then restores the user's view.
     */
    public async exportIllustrationTransparentPNG(maxSize = 2048): Promise<Blob> {
        if (!this.webgpuRenderer) throw new Error('Renderer not initialised');
        const docSize = this._documentSizePx;
        if (!docSize || !this.interactionService) return this.webgpuRenderer.snapshotToBlob(maxSize);   // infinite canvas → opaque fallback

        const prevPan = { ...this.interactionService.getPanOffset() };   // getPanOffset returns the live object — copy it
        const prevZoom = this.interactionService.getZoomFactor();
        this.fitArtboard();
        try {
            const scissor = this.webgpuRenderer.getArtboardScissor();
            if (!scissor) return this.webgpuRenderer.snapshotToBlob(maxSize);
            const aspect = docSize.w / docSize.h;
            let outW: number, outH: number;
            if (aspect >= 1) { outW = Math.min(maxSize, docSize.w); outH = Math.round(outW / aspect); }
            else { outH = Math.min(maxSize, docSize.h); outW = Math.round(outH * aspect); }
            const canvas = await this.webgpuRenderer.captureArtboardRegionCanvas(scissor, outW, outH, { transparent: true, skip3D: true });
            // Composite ephemera (a DOM overlay, not in the GPU frame) on top, framed to the artboard.
            const eb = this.webgpuRenderer.getIllustrationBounds?.();
            if (eb && this._ephemeraOverlay?.hasVisiblePlacements()) {
                const ectx = (canvas as OffscreenCanvas | HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null;
                if (ectx) this._ephemeraOverlay.rasterizePlacements(ectx, eb.width, eb.height, outW, outH);
            }
            return await new Promise<Blob>((res, rej) => {
                if ('convertToBlob' in canvas) (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' }).then(res, rej);
                else (canvas as HTMLCanvasElement).toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png');
            });
        } finally {
            this.interactionService.setPanOffset(prevPan.x, prevPan.y);
            this.interactionService.setZoom(prevZoom);
            this.scheduleRender();
        }
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
            } else if (e.type === 'playback-state-changed') {
                this.scheduleRender();   // the onion skin is skipped while playing — redraw it once playback stops
            }
        });
        timeline.play();
    }

    /** Pause playback. */
    public pause(): void {
        this.rasterLayerManager?.getTimeline().pause();
        this.scheduleRender();
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
    /** Every DocumentPersistence instance is built here so they ALL get the state provider + busy predicate (four of
     *  the five creation sites used to skip the predicate, so a stroke-debounced save could still fire mid-Play). */
    private _createPersistence(config?: Partial<AutoSaveConfig>): DocumentPersistence {
        const p = new DocumentPersistence(config);
        // Incremental autosave (docs/ui/document-persistence.md): an AUTOMATIC save serves raster layers / cels /
        // painted textures unchanged since their last read-back from the cache (content keys let the writer skip
        // their files); an explicit save (saveNow) reads everything fresh and writes every file.
        p.setStateProvider((o) => this.docState.gather(false, { reusePixels: !o?.explicit }));
        // Don't AUTO-save a transient frame: Play mode (walked-to positions, mid-stride pose) — and, since audit
        // 2026-09-28 P11, UI preview / Player mode too, where playAnimation / seekAnimation pose skeletons and a
        // save would persist the scrubbed pose over the authored one. Autosave resumes (and saves) once they end.
        // + device lost: a save gathered then would read back a dead device (raster layers fail, painted textures go
        // missing); the recovery's restore runs under the load guard and saves resume after it.
        p.setBusyPredicate(() => this.scene3d.isPlayModeActive() || this.ui.interactive || this._uiPlayerMode || !!this.webgpuRenderer?.isDeviceLost);
        p.setBusyEpochProvider(() => this._persistBusyEpoch());   // a loss + recovery during the gather → re-save
        p.setDeferredCallback(() => this._notifyPersistDeferred('save'));
        // Timeline playback: a save reads back every layer + cel and PNG-encodes them — a hitch mid-animation. The
        // TIMED / stroke autosaves wait until playback stops (then run once); explicit and tab-hide saves don't wait.
        p.setDeferPredicate(() => !!this.rasterLayerManager?.getTimeline().isPlaying());
        return p;
    }

    public enableAutoSave(
        docId: string,
        docName: string = 'Untitled',
        config?: Partial<AutoSaveConfig>,
    ): void {
        this.currentDocId = docId;
        this.currentDocName = docName;
        // Destroy the previous instance first — otherwise its interval keeps firing forever, saving from a stale
        // provider and (being a different object) dodging the load guard in restoreDocumentState. (audit P1/P9)
        const prev = this.persistence;
        prev?.destroy();
        this.persistence = this._createPersistence(config);
        // Keep what the previous instance knows is on disk (e.g. the document loadDocument just read): the first
        // automatic save then writes only what changed. Re-validated against the disk on every save.
        this.persistence.inheritWriteRecord(prev);
        this.persistence.startAutoSave();
    }

    /** Stop auto-saving (engine stays initialized for manual saves). Also drops an automatic save that is still
     *  pending (stroke debounce / trailing / deferred): it used to fire after the host had moved on — e.g. while the
     *  next document loaded — and write into whichever document id was current then. Save first (saveDocument) if
     *  the pending change must be kept. */
    public disableAutoSave(): void {
        this.persistence?.stopAutoSave();
        this.persistence?.cancelPendingSaves();
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
            this.persistence = this._createPersistence();
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
            this.persistence = this._createPersistence();
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

        // Point saves at the doc being loaded BEFORE restoring: the on-screen state belongs to this doc from here on.
        // (Setting it after meant any save during/after a failed restore wrote the new doc's content into the OLD
        // doc's directory. A failed restore now blocks saving instead — see restoreDocumentState.) audit P1
        this.currentDocId = docId;
        this.currentDocName = payload.manifest.name;
        try {
            await this.restoreDocumentState(payload);
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
            this.persistence = this._createPersistence();
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
            this.persistence = this._createPersistence();
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
     * Replace whatever document is open with a NEW, BLANK one — the ShapeManager outlives every document, so a host
     * opening a new (never saved) document must call this first, or the previous document's content stays on screen
     * and its next save writes it into the new document (new-document audit 2026-10-06).
     *
     * It runs the same full-replacement restore as opening a saved document (saves are suspended meanwhile, a pending
     * save of the previous document finishes first) with an empty payload: no 2D shapes or 3D nodes, the default
     * 'Background' + 'Vector' layers, no animation, default dither / canvas grid / global 3D settings, and every
     * per-document registry cleared (world / city, characters v1 + v2, kitbash, decals, GARP, UI layers, scripts,
     * animation library, texture library, GLB store, UV-paint textures, ephemera, procedural creators), plus empty undo
     * stacks and no selection. A save block left by a previous partial load is lifted.
     *
     * @param docId The new document's id: saves go there from now on. Omitted = no document id yet (saves are skipped
     *              until enableAutoSave / loadDocument / setCurrentDocId sets one) — never the previous document's.
     * @param name  The new document's name (default 'Untitled').
     * @param opts.documentSize Bounded artboard size in pixels; null / omitted = infinite canvas.
     */
    public async startBlankDocument(docId?: string, name = 'Untitled', opts: { documentSize?: { w: number; h: number } | null } = {}): Promise<void> {
        // A floating raster paste / transform of the previous document must not be stamped onto the new one's layer,
        // and its selection mask must not carry over: put the pixels back, then drop the selection.
        const rasterSel = this.getSelectionEngine();
        rasterSel?.cancelTransform();
        try { await rasterSel?.deselectAll(); } catch (e) { console.warn('[startBlankDocument] raster deselect failed', e); }
        // Synchronously followed by restoreDocumentState's suspend(): no save can start in between, and a save already
        // running gathered its manifest (and so its doc id) before this line.
        this.currentDocId = docId ?? '';
        this.currentDocName = name;
        const layerSize = this.rasterLayerManager?.getCanvasSize();
        await this.restoreDocumentState(createBlankDocumentPayload(this.currentDocId, name, {
            documentSize: opts.documentSize ?? null,
            canvasSize: layerSize && layerSize.w > 0 && layerSize.h > 0 ? layerSize : undefined,
        }));
        this.interactionService?.clearSelectedNodes();
        this.scene3d?.clearSelection();
        this.scheduleRender();
    }

    /**
     * Put the shared engine back into the plain 2D editing VIEW (mobile-parity 7.3c). The ShapeManager outlives every
     * route, so a 3D camera mode or edit mode the illustration editor left on carried into the next screen: a free3D
     * camera re-attached its orbit controller to a BOARD's canvas and owned its pan / zoom (cameraOwnsView blocked the
     * 2D wheel / drag / pinch), the 3D workspace backdrop replaced the board's background, Play kept running and
     * Edit Mesh kept suppressing box-select. A host that boots the engine for a non-3D screen (board, package editor,
     * cart player) calls this on entry; an editor calls it when it is left.
     *
     * Exits Play, the UI player mode, Edit Mesh (+ its pointer handlers), every UV editor / UV paint, the creator / CD
     * stage, bone placement / weight paint / Grease Pencil draw / decal placement, the armature overlay, any mesh /
     * group orbit and camera look-through / preview; drops the 3D pointer controllers, the hover and the selection;
     * then sets the view to the default (illustration × ortho2D, no remembered poses), which releases the orbit
     * controller, the nav gizmo and fly and hands pan / zoom back to the 2D view. No document content changes beyond
     * what those exits restore (Play's pre-Play transforms, a stage's saved rotation); nothing is saved. Idempotent.
     */
    public resetTo2DEditingView(): void {
        const step = (what: string, fn: () => void): void => {
            try { fn(); } catch (e) { console.warn('[resetTo2DEditingView] ' + what + ' failed', e); }
        };
        const s3 = this.scene3d;
        step('Play', () => { if (s3?.isPlaying3D) this.exitPlayMode3D(); });
        step('UI player', () => { if (this._uiPlayerMode) this.exitUIPlayerMode(); });
        step('Edit Mesh', () => { this.detachMeshEditPointerHandlers(); if (this.isMeshEditMode3D) this.exitMeshEditMode3D(); });
        step('UV editor', () => { if (this._uvSessions.size > 0 || this.uvPaint.isActive()) this.closeAllUVEditors3D(); });
        step('creator stage', () => this.exitCreatorStage3D());
        step('CD designer', () => this.exitCDDesigner3D());
        if (s3) {
            step('bone placement', () => { if (s3.isBonePlacementModeActive3D()) s3.exitBonePlacementMode3D(); });
            step('weight paint', () => s3.exitWeightPaintMode3D());
            step('Grease Pencil', () => { s3.exitGpDrawMode(); s3.exitGpFaceSelectMode(); });
            step('decal placement', () => this.exitDecalPlaceMode3D());
            step('3D view', () => s3.resetToDefaultView3D());
        }
        this.scheduleRender();
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
        // A host-reported stroke may have changed GPU-only pixels (device-lost shadow; over-counting is safe). It was
        // painted on the selected layer (its current texture — the displayed cel when animated): the incremental
        // autosave re-reads that one (the brush pipeline already reported the exact texture it wrote; this is the
        // backstop). No selected layer → every texture counts as changed.
        bumpGpuPixelEpoch('full', this.rasterLayerManager?.getSelectedLayerTexture() ?? null);
        this.persistence?.notifyStrokeEnd();
    }

    /** Incremental autosave counters (docs/ui/document-persistence.md): GPU read-backs vs cache hits for raster
     *  layers / cels / painted textures, saves that wrote vs found nothing to write, the files the last write wrote,
     *  and `unnotedChanges` (non-zero = some pixel writer did not report its write; caught by the verification read). */
    public getAutoSaveStats(): {
        pixels: { readbacks: number; reused: number; meshExports: number; meshReused: number; unnotedChanges: number };
        writes: { writes: number; unchanged: number; filesWritten: number; filesSkipped: number } | null;
        lastWrittenFiles: string[];
    } {
        return {
            pixels: { ...this.docState.pixelReadStats },
            writes: this.persistence ? { ...this.persistence.writeStats } : null,
            lastWrittenFiles: this.persistence?.lastWrittenFiles.slice() ?? [],
        };
    }

    /** How long an automatic save may go on serving unchanged pixels from its cache before it reads every layer / cel
     *  / painted texture again and compares (the safety net for a pixel writer that forgot to report). 0 = never.
     *  Default 10 minutes. */
    public setAutoSavePixelVerifyInterval(ms: number): void {
        this.docState.pixelVerifyIntervalMs = Math.max(0, ms | 0);
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
        return this.scene3d.getAllSkeletons().filter(s => !s.excludeFromDocument).map(s => this.scene3d!.serializeSkeletonForSave(s));
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
        if (m.isProceduralBody) {
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
        // ★ An export made during Play / UI preview / Player mode is DEFERRED until it ends (bug-hunt 2026-10-01, the
        // G2 follow-up): gathering then would pack the in-game frame. Same rule + reasoning as DocumentPersistence.saveNow
        // (see idle-gate.ts): Stop restores the editor state, so a gather right after Stop is the editor state. A document
        // load while waiting rejects (IdleGateStaleError) instead of exporting the other document.
        const epoch = this._docLoadEpoch;
        return runWhenIdle(() => this._isEditorBusyForPersist(), () => this._packProjectNow(), {
            isStale: () => this._docLoadEpoch !== epoch,
            busyEpoch: () => this._persistBusyEpoch(),
            onDeferred: () => this._notifyPersistDeferred('export'),
        });
    }

    /** True while a gather would capture a transient frame (3D Play, UI preview, Player mode) — the persistence gate. */
    private _isEditorBusyForPersist(): boolean {
        return !!(this.scene3d?.isPlayModeActive?.() || this.ui?.interactive || this._uiPlayerMode || this.webgpuRenderer?.isDeviceLost);
    }
    /** Bumped by every document restore (the deferred-export stale check). */
    private _docLoadEpoch = 0;
    /** Moves when a busy period starts that a gather could span unnoticed (a GPU device loss + recovery). */
    private _persistBusyEpoch(): number { return this.webgpuRenderer?.getDeviceStatus?.().lostCount ?? 0; }

    // ── GPU device-lost recovery (docs/ui/device-recovery.md) ──────────────────────────────────────────────────────
    // WebGPURenderer stops rendering on a loss and gets a new device; the DeviceRecoveryCoordinator (installed here as
    // its recovery handler) snapshots the document from CPU data + the read-back shadow, lets the renderer rebuild every
    // GPU owner, and restores the snapshot through the normal document restore. The forwards below are the host API.
    private _deviceRecovery?: DeviceRecoveryCoordinator;

    /** GPU device status: 'ok' | 'lost' | 'recovering' | 'failed' | 'unavailable', loss / recovery counters, and what
     *  the last recovery could not bring back. */
    public getDeviceStatus(): GpuDeviceStatusInfo { return this.webgpuRenderer.getDeviceStatus(); }
    /** Subscribe to every device status change (lost → recovering → ok | failed). Returns the unsubscribe function. */
    public onDeviceStatusChange(fn: GpuDeviceStatusListener): () => void { return this.webgpuRenderer.onDeviceStatusChange(fn); }
    /** Subscribe to device LOSSES only (the 'lost' transition). Returns the unsubscribe function. */
    public onDeviceLost(fn: GpuDeviceStatusListener): () => void {
        return this.webgpuRenderer.onDeviceStatusChange((info) => { if (info.status === 'lost') fn(info); });
    }
    /** GPU diagnostics (mobile-parity CRASH-10; docs/ui/gpu-diagnostics.md): the capability tier + why, the per-machine
     *  caps in force, adapter info, device limits + features, the canvas backing size, the device status, the last
     *  device loss (persisted: survives a reload), breadcrumbs, still-open GPU operations and uncaptured GPU errors.
     *  JSON-safe, for a host "GPU info" panel / copy-to-clipboard. */
    public getGpuDiagnostics3D(): ReturnType<WebGPURenderer['getGpuDiagnostics']> { return this.webgpuRenderer.getGpuDiagnostics(); }
    /** RENDER DEBUG (docs/ui/gpu-diagnostics.md "Render debug"; mobile-parity RENDER-1): bisect switches that each skip
     *  one 3D pass / feature or force a diagnostic mode (solid magenta, unlit, clear-instead-of-load, ...). All default
     *  OFF (no change to the frame). Merges `patch`; `{ reset: true }` switches everything off first. Kept per machine
     *  in localStorage `salsa.renderDebug` so it survives reloads (removed once all are off). Returns the flags. */
    public setRenderDebug3D(patch: Partial<RenderDebugFlags> & { reset?: boolean } = {}): RenderDebugFlags {
        const r = _setRenderDebug(patch);
        this.scheduleRender();
        return r;
    }
    public getRenderDebug3D(): RenderDebugFlags { return _getRenderDebug(); }
    /** Every flag off (and the stored set removed). */
    public resetRenderDebug3D(): RenderDebugFlags { return this.setRenderDebug3D({ reset: true }); }
    /** The flags in display / suggested bisect order with short labels (for a host menu). */
    public getRenderDebugFlagList3D(): ReadonlyArray<{ key: keyof RenderDebugFlags; label: string }> { return RENDER_DEBUG_FLAGS; }
    /** Read-only facts for a bisect: the resolution scale in force (getResolutionScale3D().current) and mode, whether
     *  the 3D scene is on the lo-res path (and its size), TAA, MSAA (never: 1), canvas size / format / alpha mode. */
    public getRenderDebugStatus3D(): ReturnType<WebGPURenderer['getRenderDebugStatus']> { return this.webgpuRenderer.getRenderDebugStatus(); }
    /** A REAL screenshot: the next frame's canvas (swap-chain) texture read back at the end of that frame — after
     *  every pass, the post copy, the info card and the UI kit — i.e. exactly what is handed to the browser to
     *  present (it cannot see the browser / OS compositor). `opaque` (default true) writes alpha 255. */
    public async captureCanvasPNG3D(opts: { opaque?: boolean } = {}): Promise<RealScreenshot> {
        const frame = await this.webgpuRenderer.captureRealFrame();
        const png = await _encodeRealFramePNG(frame, opts.opaque !== false);
        return { ...png, width: frame.width, height: frame.height, source: frame.source, format: frame.format, flags: _getRenderDebug() };
    }
    /** Retry a recovery (e.g. after 'failed', or with autoRecoverDevice off). Resolves true when rendering is back. */
    public recoverDevice(): Promise<boolean> { return this.webgpuRenderer.recoverDevice(); }
    /** Automatic recovery on loss (default on). */
    public setAutoRecoverDevice(on: boolean): void { this.webgpuRenderer.autoRecoverDevice = !!on; }
    /** TEST HOOK: destroy the device as if the GPU process had reset (the same path a real loss takes). */
    public simulateDeviceLoss(): void { this.webgpuRenderer.simulateDeviceLoss(); }
    /** Read back the GPU-only document data now (raster layers, cels, painted textures) so a loss right after can't
     *  cost it. Saves do this too; a timer does it every `ms` (default 60 s, 0 = off) while something draws. */
    public refreshDeviceReadbackShadow(): Promise<boolean> { return this._deviceRecovery?.refreshShadow() ?? Promise.resolve(false); }
    public setDeviceReadbackShadowInterval(ms: number): void { this._deviceRecovery?.setShadowInterval(ms); }
    /** True when the read-back shadow matches the GPU exactly (no raster / painted-texture edit since it was taken):
     *  a loss right now would cost nothing. */
    public isDeviceReadbackShadowCurrent(): boolean { return this._deviceRecovery?.shadowCurrent ?? false; }

    /** A save / export asked for while the editor is busy (Play, UI preview, Player mode, device lost) waits until it
     *  is idle. Subscribe for a host notice ("Export will finish when you stop Play"); called once per waiting request
     *  with what waits and why. Returns the unsubscribe function. */
    public onPersistDeferred(fn: (info: { kind: 'save' | 'export'; reason: 'play' | 'ui-preview' | 'player' | 'device-lost' }) => void): () => void {
        this._persistDeferredListeners.add(fn);
        return () => { this._persistDeferredListeners.delete(fn); };
    }
    private readonly _persistDeferredListeners = new Set<(info: { kind: 'save' | 'export'; reason: 'play' | 'ui-preview' | 'player' | 'device-lost' }) => void>();
    private _notifyPersistDeferred(kind: 'save' | 'export'): void {
        const reason = this.webgpuRenderer?.isDeviceLost ? 'device-lost' as const
            : this.scene3d?.isPlayModeActive?.() ? 'play' as const
            : this._uiPlayerMode ? 'player' as const : 'ui-preview' as const;
        console.info(`[Salsa] ${kind} deferred until the editor is idle (${reason})`);
        for (const fn of [...this._persistDeferredListeners]) { try { fn({ kind, reason }); } catch (e) { console.warn('[Salsa] onPersistDeferred listener threw', e); } }
    }

    /** True while the device-lost recovery's own restore runs (it puts back the SAME document). */
    private _deviceRestoreActive = false;

    /** After a document restore the GPU holds exactly the payload's pixels: that is an exact read-back shadow. */
    private _seedDeviceShadowFromRestore(payload: DocumentSavePayload, clean: boolean): void {
        const rec = this._deviceRecovery;
        if (!rec) return;
        if (!clean) { rec.seedShadow(null); return; }
        const rlm = this.rasterLayerManager;
        const layerIds = (rlm?.getLayerMetadata() ?? []).map((l) => l.id);
        const celIds: string[] = [];
        for (const l of rlm?.getLayerMetadata() ?? []) if (l.animationType === 'animated') for (const c of rlm!.getCels(l.id)) celIds.push(c.id);
        rec.seedShadow(gpuOnlyFromRestorePayload(payload, gpuPixelEpoch(), rlm ? rlm.getCanvasSize() : null, layerIds, celIds));
    }

    private _initDeviceRecovery(): void {
        const r = this.webgpuRenderer;
        if (!r || typeof r.setDeviceRecoveryHandler !== 'function') return;
        const rec = this._deviceRecovery = new DeviceRecoveryCoordinator({
            leaveTransientModes: () => { if (this.scene3d?.isPlayModeActive()) this.scene3d.exitPlayMode3D(); },
            gather: (gpuOnly) => this.docState.gather(true, { gpuOnly }),
            readBackGpuOnly: () => this.docState.gatherGpuOnly(),
            hasGpuOnlyContent: () => (this.rasterLayerManager?.getLayers().some((l) => (l.type ?? 'layer') === 'layer') ?? false)
                || this._uvPaintTextures.size > 0
                || (this.scene3d?.getFaceTextureExports().some((f) => !f.procedural) ?? false),
            gpuPixelEpoch: () => gpuPixelEpoch(),
            restore: async (payload) => {
                this._deviceRestoreActive = true;
                try { await this.restoreDocumentState(payload); } finally { this._deviceRestoreActive = false; }
            },
            resetManagersForNewDevice: () => this._resetManagersForNewDevice(),
            captureRuntime: () => this._captureDeviceRuntime(),
            applyRuntime: (s) => this._applyDeviceRuntime(s as ReturnType<ShapeManager['_captureDeviceRuntime']>),
            listContent: () => new Set<object>(this.scene3d?.getAllMeshes() ?? []),
            resetSurvivors: (before) => {
                for (const m of this.scene3d?.getAllMeshes() ?? []) {
                    if (!before.has(m)) continue;   // created by the restore on the new device
                    m.gpuVertexBuffer = null; m.gpuIndexBuffer = null;
                    m.diffuseTexture = null; m.normalMapTexture = null; m.paintTexture = null;
                    m.gpuDirty = true;
                }
            },
            deviceHealthy: () => !r.isDeviceLost,
        });
        r.setDeviceRecoveryHandler((install) => rec.recover(install));
        // Raster layer textures: re-created blank on the new device BEFORE the raster engines re-bind (order 60) and the
        // restore re-uploads their pixels — the layer stack must never point at a dead texture (setSize copies from it).
        r.registerGpuResourceOwner('raster-layers', () => { this.rasterLayerManager?.recreateTexturesForNewDevice(); }, 40);
    }

    /** Manager-held GPU objects that outlive a document load (the restore re-creates the document's own). */
    private _resetManagersForNewDevice(): string[] {
        const lost: string[] = [];
        const step = (name: string, fn: () => void) => { try { fn(); } catch (e) { lost.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); } };
        // Lazily created engines: dropped → re-created on the new device at next use.
        step('raster engines', () => {
            this.floodFillEngine = undefined;
            this.textEffectEngine = undefined;
            (this.text as unknown as { _textEffectEngine?: unknown })._textEffectEngine = undefined;
            (this._pkgComposite as unknown as { _pkgCompositor?: unknown })._pkgCompositor = undefined;
            if (this._uvPaintSess) (this._uvPaintSess as unknown as { controller?: unknown }).controller = undefined;
        });
        // Owners whose old-device buffers / textures are all lazily re-created (sweep = null them).
        step('raster move', () => { if (this.rasterMoveService) sweepGpuFields(this.rasterMoveService); });
        step('raster text', () => {
            const rts = this.rasterTextService as unknown as Record<string, unknown> | undefined;
            if (!rts) return;
            sweepGpuFields(rts);
            for (const k of Object.keys(rts)) {   // its lazily made stamp engine captured the old resources
                const v = rts[k] as { destroy?: unknown } | null;
                if (v && typeof v === 'object' && v.constructor?.name === 'RasterTextStamp') rts[k] = undefined;
            }
        });
        step('mesh paint', () => { if (this.meshPaint) sweepGpuFields(this.meshPaint); });
        step('3D managers', () => { lost.push(...this.scene3d.resetGpuResourcesForDeviceLoss()); });
        // UV-paint textures are document content: the restore disposes + rebuilds them (from the snapshot's PNGs).
        return lost;
    }

    /** View state a document restore doesn't carry: the live camera + orbit pose, City mode, UI preview / Player mode. */
    /** A recovery's runtime view state not yet re-applied (its city is still rebuilding): a second loss before then
     *  must keep THAT state — the live camera then is still the pre-reveal one. */
    private _pendingDeviceRuntime: ReturnType<ShapeManager['_captureDeviceRuntimeNow']> | null = null;
    private _captureDeviceRuntime(): ReturnType<ShapeManager['_captureDeviceRuntimeNow']> {
        return this._pendingDeviceRuntime ?? this._captureDeviceRuntimeNow();
    }
    private _captureDeviceRuntimeNow() {
        const plain = (o: unknown, keys?: string[]): Record<string, unknown> => {
            const out: Record<string, unknown> = {};
            if (!o) return out;
            const rec = o as Record<string, unknown>;
            for (const k of keys ?? Object.keys(rec)) {
                const v = rec[k];
                if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
                else if (v instanceof Float32Array || v instanceof Float64Array) out[k] = Array.from(v);
            }
            return out;
        };
        const orbit = this.scene3d?.getOrbitController?.();
        return {
            cam: plain(this.webgpuRenderer.peekRenderer3D()?.getCamera()),
            orbit: plain(orbit, ['radius', 'azimuth', 'elevation', 'minRadius', 'maxRadius', 'minElevation', 'maxElevation']),
            cityMode: !!this.world?.cityMode,
            // City traffic is a runtime toggle (a rebuild restarts it): keep a host's "traffic off" through the rebuild.
            trafficOff: !!this.world?.cityMode && !this.world.isBuildingCity() && !this.world.trafficRunning,   // (mid-build: not started yet)
            // the build that ENTERS City mode (its reveal frames the camera); an edit rebuild keeps the user's view
            cityBuilding: !!this.world?.cityMode && this.world.isBuildingCity() && (this.world as unknown as { _pendingCityEnter?: boolean })._pendingCityEnter === true,
            // The city's params (or the in-flight build's): a loss during the FIRST build has no city marker in the
            // document yet, so re-entering without them would build the default city (devlost drive 'build').
            cityParams: this.world?.cityMode ? (() => {
                const w = this.world as unknown as { _inflightFullParams?: () => unknown; params: unknown };
                const p = w._inflightFullParams?.() ?? w.params;
                try { return p ? JSON.parse(JSON.stringify(p)) as Record<string, unknown> : null; } catch { return null; }
            })() : null,
            uiInteractive: !!this.ui?.interactive, playerMode: this._uiPlayerMode,
        };
    }

    private _applyDeviceRuntime(s: ReturnType<ShapeManager['_captureDeviceRuntime']> | null): void {
        if (!s) return;
        const put = (o: unknown, st: Record<string, unknown>) => {
            if (!o) return;
            const rec = o as Record<string, unknown>;
            for (const [k, v] of Object.entries(st)) {
                const cur = rec[k];
                if (Array.isArray(v) && (cur instanceof Float32Array || cur instanceof Float64Array) && cur.length === v.length) cur.set(v);
                else if (typeof v !== 'object') rec[k] = v;
            }
            for (const k of ['_viewDirty', '_projDirty', '_vpDirty']) if (k in rec) rec[k] = true;
        };
        const applyView = () => {
            put(this.webgpuRenderer.peekRenderer3D()?.getCamera(), s.cam);
            put(this.scene3d?.getOrbitController?.(), s.orbit);
            this.scheduleRender();
        };
        // City mode: the restore exits it and rebuilds the city (async); re-entering joins that build, and the city's
        // own framing runs when it lands — so the pre-loss view goes back once more after the build.
        if (s.cityMode && this.world) {
            if (!this.world.cityMode) {
                // Restored from the city marker (built or building) → resume / join it; no city came back (lost mid
                // first build) → build the one that was building.
                const resume = this.world.hasWorld || this.world.isBuildingCity() || !s.cityParams;
                this.world.enterCityMode(resume ? undefined : s.cityParams as Parameters<WorldManager['enterCityMode']>[0]);
            }
            // Wait for the rebuild (its reveal frames the camera), also when the restore re-entered City mode itself
            // (tiled worlds) — the build may start a moment after the restore returns, so wait up to 1.5 s to see one.
            const t0 = Date.now();
            let seen = false;
            this._pendingDeviceRuntime = s;
            const wait = () => {
                if (this.webgpuRenderer.isDeviceLost || this._pendingDeviceRuntime !== s) return;   // lost again: the next recovery re-applies s
                // (the city's orbit controller is re-created by its enter tail at the reveal: wait for it too)
                const busy = this.world.isBuildingCity() || this.world.isUpdatingCity()
                    || (Object.keys(s.orbit).length > 0 && !this.scene3d?.getOrbitController?.())
                    // a tiled world frames itself once its streamed tiles settle (WorldManager._onTilesSettled)
                    || (this.world as unknown as { _reframeAfterTiles?: boolean })._reframeAfterTiles === true;
                if (busy) seen = true;
                if ((busy || (!seen && Date.now() - t0 < 1500)) && Date.now() - t0 < 120_000) { setTimeout(wait, 100); return; }
                this._pendingDeviceRuntime = null;
                if (s.trafficOff && this.world.trafficRunning) this.world.stopTraffic();
                // Lost during the city's own (first) build: the pose captured then was the pre-city one (orbit limits
                // included) — let the city's framing stand, as it would have without the loss.
                console.log(`[Salsa][gpu] city back after the recovery (${Date.now() - t0} ms, build seen: ${seen}); view ${s.cityBuilding ? 'left to the city framing' : 're-applied'}`);
                if (!s.cityBuilding) { applyView(); setTimeout(() => { if (!this.webgpuRenderer.isDeviceLost) applyView(); }, 300); }   // + once after the reveal's own framing frame
            };
            setTimeout(wait, 100);
        }
        applyView();
        if (s.playerMode && !this._uiPlayerMode) this.enterUIPlayerMode();
        else if (s.uiInteractive && !this.ui.interactive) this.ui.setInteractive(true);
    }

    private async _packProjectNow(): Promise<Blob> {
        // ★ The package IS the autosave payload (audit 2026-09-28 P4). This used to hand-assemble its own subset — it
        // dropped UV paint / face textures, baked parts, packaging and GARP, and re-serialized 3D nodes without the
        // procedural-child filter (so they came back LOOSE). Gathering with forceAll3D includes every model + the
        // texture library, so the export holds exactly what autosave persists.
        // Do NOT run payload._onWriteComplete: it clears the 3D dirty flags, and an export is not an OPFS save —
        // clearing them made the NEXT autosave skip heavy parts, so an unsaved texture could be lost on tab close.
        const payload = await this.gatherDocumentState(true);

        // Capture a small thumbnail (256px JPEG) and embed in the manifest (best-effort). 256 is plenty for a
        // gallery/slot preview and is ~4x smaller than 512 — the manifest is stored RAW (not gzipped), so the
        // thumbnail is the one bit of preview data that isn't otherwise compressed.
        try {
            const thumbBlob = await this.captureDocumentBoundsToBlob('jpeg', 256);
            payload.manifest.thumbnail = await new Promise<string>((res, rej) => {
                const reader = new FileReader();
                reader.onload = () => res(reader.result as string);
                reader.onerror = rej;
                reader.readAsDataURL(thumbBlob);
            });
        } catch { /* thumbnail is optional */ }

        return _packProject(payload);
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
    // ── .frogcart — the distributable interactive-scene package (docs/specs/ui-system.md §Packaging) ──

    /** True while Player mode is active (interactive UI on, editing input suppressed). */
    private _uiPlayerMode = false;
    public get isUIPlayerModeActive(): boolean { return this._uiPlayerMode; }

    /** Export the current project as a `.frogcart` Blob — the full project package wrapped with the frogcart
     *  manifest, the pre-parsed state machines, and the Player config (spec §Export API). The host triggers the
     *  download / upload. */
    public async exportFrogcart(meta: FrogcartMeta, playerConfig?: Partial<FrogcartPlayerConfig>): Promise<Blob> {
        const scenePackage = await this.packProject();
        const stateMachineJSON = this.ui.listUILayers().length ? JSON.stringify(this.ui.serialize()) : null;
        // Bundle registered sounds (fetch each URL's bytes) so playSound actions work in the standalone Player.
        const sounds: import('./persistence/frogcart').FrogcartSound[] = [];
        for (const { assetId, url } of this._uiSound?.getRegisteredSounds() ?? []) {
            try {
                const blob = await (await fetch(url)).blob();
                sounds.push({ assetId, bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'audio/mpeg' });
            } catch { console.warn(`[frogcart] could not bundle sound '${assetId}' (${url}) — skipping`); }
        }
        return packFrogcart({ scenePackage, meta, stateMachineJSON, playerConfig, sounds });
    }

    /** Load a `.frogcart`: restores the FULL project (scene, 3D, textures, UI layers) and returns the manifest +
     *  player config so the host (editor or Player) can apply canvas size / initial state / chrome. Does NOT
     *  auto-enter Player mode — call `enterUIPlayerMode(config.initialState)` when hosting playback. */
    public async importFrogcart(file: File | Blob): Promise<{ manifest: FrogcartManifest; playerConfig: FrogcartPlayerConfig }> {
        const { manifest, playerConfig, scenePackage, sounds } = await unpackFrogcart(file);
        await this.unpackProject(scenePackage);
        // Re-register bundled audio as object URLs — the cart's playSound actions work with no host wiring.
        if (sounds.length && typeof URL !== 'undefined' && URL.createObjectURL) {
            for (const s of sounds) {
                this.registerUISound(s.assetId, URL.createObjectURL(new Blob([s.bytes as unknown as BlobPart], { type: s.mime })));
            }
        }
        return { manifest, playerConfig };
    }

    /** Enter PLAYER mode: live UI interactivity on, editor box-select suppressed, and (optionally) jump the
     *  active UI layer to an initial state (the Player passes playerConfig.initialState / a deep-link state). */
    public enterUIPlayerMode(initialStateId?: string): void {
        this._uiPlayerMode = true;
        this.ui.setInteractive(true);
        this.interactionService.suppressBoxSelect = true;
        if (initialStateId && this.ui.activeUILayerId) this.ui.goToState(this.ui.activeUILayerId, initialStateId);
        this.scheduleRender();
    }

    /** Leave Player mode: interactivity off (hover/focus cleared), editing input restored. */
    public exitUIPlayerMode(): void {
        this._uiPlayerMode = false;
        this.ui.setInteractive(false);
        this.interactionService.suppressBoxSelect = false;
        this._uiStopAllClipPlayers();
        this._uiSound?.stopAll();   // bug-hunt 2026-10-01: a looping playSound kept playing in the editor after Stop
        this.scheduleRender();
    }

    // ── UI-driven clip players — the playAnimation/stopAnimation/pauseAnimation/seekAnimation actions ──
    // One player per action targetId; targetId = a Skeleton3D node id, or a SkinnedMesh3D id (skeleton resolved).

    private readonly _uiClipPlayers = new Map<string, {
        player: import('../renderer/3d/animation-player-3d').AnimationPlayer3D;
        clip: import('../types/armature-3d').SkeletonAnimClip;
    }>();

    /** Resolve an action targetId + optional clipId to a skeleton + clip (clipId matches clip.id or clip.name;
     *  omitted = the skeleton's first clip). Null when the target has no skeleton or no matching clip. */
    private _uiResolveClip(targetId: string, clipId?: string):
        { skeletonId: string; clip: import('../types/armature-3d').SkeletonAnimClip } | null {
        const skeletonId = this.scene3d.getSkeleton(targetId) ? targetId
            : ((this.sceneGraph.findNodeById(targetId) as { skeletonId?: string | null } | null)?.skeletonId ?? null);
        if (!skeletonId) return null;
        const clips = this.scene3d.getSkeletonClips3D(skeletonId);
        const clip = clipId ? (clips.find((c) => c.id === clipId || c.name === clipId) ?? null) : (clips[0] ?? null);
        return clip ? { skeletonId, clip } : null;
    }

    private _uiPlayAnimation(targetId: string, clipId?: string, loop?: boolean, blendFrames?: number): void {
        const found = this._uiResolveClip(targetId, clipId);
        if (!found) return;
        const rec = this._uiClipPlayers.get(targetId);
        if (rec && rec.clip.id === found.clip.id) {   // same clip → RESUME in place (play after pause)
            if (loop != null) rec.player.loop = loop;
            rec.player.play();
            return;
        }
        // Crossfade (P2, §4.1): if something is already playing on this target and a blend was requested,
        // capture the current on-screen pose and ramp INTO the new clip out of it (no snap). Otherwise a
        // plain fresh player. Reuses the NLA sample/blend primitives — no second mixer.
        const wantBlend = (blendFrames ?? 0) > 0 && !!rec;
        const fromPose = wantBlend ? this.scene3d.snapshotSkeletonPose3D(found.skeletonId) : null;
        rec?.player.destroy();   // different clip → fresh player
        const player = fromPose
            ? this.scene3d.playSkeletonClipBlended(found.skeletonId, found.clip, fromPose, blendFrames!)
            : this.scene3d.playSkeletonClip(found.skeletonId, found.clip);
        player.loop = loop ?? true;
        // One-shot chaining (§4.2): a non-looping clip that reaches its end fires `animationFinished` into
        // the active UI state machine (dispatch is a no-op if no UI layer is active).
        if (loop === false) player.onStop(() => this.ui.animationFinished(targetId, found.clip.id));
        this._uiClipPlayers.set(targetId, { player, clip: found.clip });
        player.play();
    }

    private _uiSeekAnimation(targetId: string, frame: number): void {
        let rec = this._uiClipPlayers.get(targetId);
        if (!rec) {   // seek without a prior play: create the player paused (poses the skeleton at the frame)
            const found = this._uiResolveClip(targetId);
            if (!found) return;
            rec = { player: this.scene3d.playSkeletonClip(found.skeletonId, found.clip), clip: found.clip };
            this._uiClipPlayers.set(targetId, rec);
        }
        rec.player.seek(frame);
    }

    private _uiStopAllClipPlayers(): void {
        for (const rec of this._uiClipPlayers.values()) rec.player.destroy();
        this._uiClipPlayers.clear();
    }

    public async unpackProject(file: File | Blob): Promise<void> {
        // One restore path (audit 2026-09-28 P4): the package unpacks to a full document payload (v2 = the autosave
        // files; v1 = the legacy subset, whose scene3d.json has the same shape) and restores exactly like an autosave
        // load — same order, same load guard, same failure reporting. This used to restore the document and THEN
        // wipe + re-add every mesh itself, which destroyed the procedural geometry the restore had just regenerated.
        const output = await _unpackProject(file);
        await this.restoreDocumentState(output.docPayload);
    }

    /** A STABLE persistence key for a UV-painted mesh that's a child of a PROCEDURAL container (a worldParams
     *  marker that regenerates its geometry on load, so the child's mesh id changes each time). Keyed by
     *  `containerId:childName` — both survive regeneration — so the paint re-applies to the fresh child. Null for a
     *  non-procedural mesh (its own id is stable, so it persists by id like normal). */
    private _procMeshKey(meshId: string): string | null {
        const mesh = this.scene3d?.getMesh(meshId);
        if (!mesh) return null;
        let node: unknown = mesh.parent;
        while (node instanceof MeshGroup3D) {
            if (node.documentSkipChildren && node.worldParams) return `${node.id}:${mesh.name ?? meshId}`;
            node = node.parent;
        }
        return null;
    }

    /** Re-apply UV-paint textures saved with a `__proc__:containerId:childName` key onto PROCEDURAL prop children,
     *  AFTER {@link restoreProceduralFromSave3D} has regenerated them (their mesh ids are fresh, so we resolve by
     *  container id + child name). Same shape as the general meshTextures restore, but keyed to survive regen. */
    private async _restoreProceduralMeshTextures(procBlobs: Map<string, ArrayBuffer>): Promise<void> {
        const device = this.webgpuRenderer?.getDevice();
        if (!device || !this.scene3d) return;
        const roots = this.scene3d.getRootMeshGroups();
        for (const [key, buf] of procBlobs) {
            const sep = key.indexOf(':');
            if (sep < 0 || !buf.byteLength) continue;
            const containerId = key.slice(0, sep), childName = key.slice(sep + 1);
            const container = roots.find((g) => g.id === containerId);
            if (!container) continue;
            let found: Mesh3D | undefined;
            container.forEachDeep((n) => { if (!found && n instanceof Mesh3D && n.name === childName) found = n; });
            if (!found) continue;
            const mesh = found;
            try {
                const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
                let mgr = this._uvPaintTextures.get(mesh.id);
                if (!mgr) { mgr = new RasterTextureManager(device); this._uvPaintTextures.set(mesh.id, mgr); }
                const tex = mgr.ensureTexture(bitmap.width, bitmap.height);
                device.queue.copyExternalImageToTexture({ source: bitmap, flipY: false }, { texture: tex }, [bitmap.width, bitmap.height]);
                bumpGpuPixelEpoch('none', tex);   // GPU-only pixels changed (device-lost shadow; incremental autosave: this texture)
                mesh.diffuseTexture = tex; mesh.material.hasTexture = true; mesh.gpuDirty = true;
            } catch (e) { console.warn('[UVPaint] restore procedural texture failed for', key, e); }
        }
        this.scheduleRender();
    }

    // ── Document save/load orchestration — extracted to DocumentStateCoordinator (audit C2) ──
    // The coordinator reaches public facade surface via `this` (type-only import, no cycle) and the
    // private state below via the hooks bag. Lazily constructed; both entry points keep their names.
    private _docState?: DocumentStateCoordinator;
    private get docState(): DocumentStateCoordinator {
        return this._docState ??= new DocumentStateCoordinator(this, {
            getSceneGraph: () => this.sceneGraph,
            getWebgpuRenderer: () => this.webgpuRenderer,
            getRasterLayerManager: () => this.rasterLayerManager,
            scheduleRender: () => this.scheduleRender(),
            syncRendererFrame: () => this.syncRendererFrame(),
            uvPaintTextures: this._uvPaintTextures,
            pendingProcTextures: this._pendingProcTextures,
            ephemera: this._ephemera,
            garp: this._garp,
            packagingIfCreated: () => this._packaging,
            clearDecalRecords: () => this._decalMgr.clearForDocumentLoad(),
            procMeshKey: (id) => this._procMeshKey(id),
            buildMeshState: (m) => this._buildMeshState(m),
            disposeAllUvPaintTextures: () => this._disposeAllUvPaintTextures(),
            restoreClothingTextures: (b) => this._restoreClothingTextures(b),
            restoreProceduralMeshTextures: (m) => this._restoreProceduralMeshTextures(m),
            backfillUnassignedVectorLayers: () => this._backfillUnassignedVectorLayers(),
            setRestoring: (v) => { this._isRestoring = v; },
            getDocumentSizePx: () => this._documentSizePx,
            getDocIdentity: () => ({ id: this.currentDocId, name: this.currentDocName }),
            getPixelFormat: () => this.persistence?.getConfig().pixelFormat ?? 'png',
            upgradePixelFormatToPng: () => { this.persistence?.setConfig({ pixelFormat: 'png' }); },
            onGpuOnlyGathered: (d) => this._deviceRecovery?.noteGpuOnly(d),   // the device-lost read-back shadow
        });
    }

    private async gatherDocumentState(forceAll3D = false): Promise<DocumentSavePayload> {
        return this.docState.gather(forceAll3D);
    }

    /**
     * Restore a full document state from a persistence payload.
     * @internal
     */
    private async restoreDocumentState(payload: DocumentSavePayload): Promise<void> {
        // ★ Load guard (audit 2026-09-28 P1). EVERY load path funnels through here (loadDocument, restoreDocument,
        // unpackProject, the persist delegate), so this is the one place saves are fenced off: suspend() cancels a
        // pending debounced save, waits out one already writing, and blocks auto + explicit saves until resume().
        // Without it, a stroke-debounce / interval save firing during the async restore snapshotted a half-built
        // scene and wrote it to disk.
        const guarded = [this.persistence, this.persist?.persistenceInstance]
            .filter((p, i, a): p is DocumentPersistence => !!p && a.indexOf(p) === i);
        await Promise.all(guarded.map((p) => p.suspend()));
        try {
            // A deferred packProject() for the previous document must not pack this one. A device-lost recovery's
            // restore puts back the SAME document, so an export waiting for it must survive (docs/ui/device-recovery.md).
            if (!this._deviceRestoreActive) { this._docLoadEpoch++; this._pendingDeviceRuntime = null; }   // (another document: drop a recovery's pending view)
            const report = await this.docState.restore(payload);
            this._seedDeviceShadowFromRestore(payload, report.issues.length === 0);
            // Restored animated live-text nodes reappear without going through createLiveText, so their continuous-
            // render lease was never acquired → they rendered frozen until selected. Re-acquire it here.
            this._liveText.reconcileLiveTextAnimationLeases();
            // audit P2: restore steps swallow their own errors so the rest of the doc still loads — but whatever a
            // failed step owned is now missing from memory, and autosave would erase it from disk too. Block saving
            // when any such step failed (a clean restore lifts an earlier block).
            this._lastRestoreIssues = report.issues;
            const blocking = report.issues.filter((i) => i.blocksSave);
            const reason = blocking.length
                ? `${blocking.length} part(s) of this document failed to load (${blocking.map((i) => i.area).join(', ')}) — ` +
                  'autosave is paused so the copy on disk is not overwritten'
                : null;
            for (const p of guarded) p.setSaveBlocked(reason);
        } catch (e) {
            // The scene is now PARTIAL. Autosaving it would overwrite the good copy on disk, so block saving until
            // a successful load (or new document) — the host can read getSaveBlockedReason() to tell the user.
            const reason = `document restore failed: ${e instanceof Error ? e.message : String(e)}`;
            this._lastRestoreIssues = [{ area: 'document', message: reason, blocksSave: true }];
            for (const p of guarded) p.setSaveBlocked(reason);
            this._deviceRecovery?.seedShadow(null);   // the GPU holds a partial document: no exact shadow
            throw e;
        } finally {
            for (const p of guarded) p.resume();
        }
    }

    /** Non-null when saving is blocked because the last document restore failed (the scene on screen is partial,
     *  so autosave is off to protect the copy on disk). Show it to the user; call clearSaveBlock() to override. */
    public getSaveBlockedReason(): string | null { return this.persistence?.saveBlocked ?? null; }
    /** Every restore step that failed during the last document load (empty = clean). `blocksSave` marks the ones
     *  whose data is missing from memory — the reason autosave is paused. For a "some parts didn't load" notice. */
    public getLastRestoreIssues(): RestoreIssue[] { return this._lastRestoreIssues.slice(); }
    private _lastRestoreIssues: RestoreIssue[] = [];
    /** Deliberately re-enable saving after a failed restore (e.g. the user chose "keep what loaded"). */
    public clearSaveBlock(): void {
        this.persistence?.setSaveBlocked(null);
        this.persist?.persistenceInstance?.setSaveBlocked(null);
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
        return this._ephemeraOverlay.getDefaultPlacementSize(typeId);
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
    /** Fires (coalesced per microtask) whenever the layer LIST changes structurally — add / remove /
     *  reorder / rename / visibility / blend / opacity. The host Layers panel should subscribe and,
     *  inside its own change-detection zone, re-read getLayers()/getVectorLayers() to refresh. Without
     *  this, vector-layer add/delete only surfaces in the panel after an unrelated interaction (e.g. a
     *  canvas click) happens to trigger the host's change detection, because vector layers carry no GPU
     *  texture and so don't move the renderer's composition callback. */
    public get onLayerStructureChanged(): import('../renderer/util/event-emitter').EventEmitter<void> {
        return this.rasterLayerManager!.onLayerStructureChanged;
    }

    public addVectorLayer(name = 'Vector'): string | null {
        if (!this.rasterLayerManager) return null;
        return this.rasterLayerManager.addVectorLayer(name);
    }

    /** Remove a vector layer and all its ephemera placements. */
    public removeVectorLayer(layerId: string): boolean {
        this._ephemera.deleteAllPlacementsForLayer(layerId);
        this._ephemeraOverlay.invalidateCache();
        return this.rasterLayerManager?.removeVectorLayer(layerId) ?? false;
    }

    /** Get all vector layers in the stack. `systemOwner`/`packageOwnerId` let the host FILTER
     *  package-owned vector layers out of the normal Layers panel (they belong to a package's stack
     *  and appear only in its layer list) — mirrors the raster `getRasterLayers()` filter. */
    public getVectorLayers(): Array<{ id: string; name: string; visible: boolean; systemOwner?: string; packageOwnerId?: string }> {
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
        this._ephemeraOverlay.setEphemeraOverlayCanvas(canvas);
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
        const p = this._ephemera.addPlacement(layerId, typeId, params, x, y, width, height, rotation, opacity);
        if (p) {
            this._pkgComposite.vectorLayerDirty(layerId);   // package vector layer → refresh its box composite
            this.scheduleRender();                // ★ draw the overlay NOW: its render is a post-frame callback, so
        }                                         //   without a scheduled frame the placement only appears on the next
        return p;                                 //   frame a mouse-move happens to trigger ("Place on Canvas" lag).
    }

    /** Update position, size, rotation, opacity, or params of an existing placement. */
    public updateEphemeraPlacement(
        layerId: string,
        placementId: string,
        updates: Partial<Pick<EphemeraPlacement, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'visible' | 'params' | 'blendMode' | 'glow' | 'feather'>>,
    ): boolean {
        const ok = this._ephemera.updatePlacement(layerId, placementId, updates);
        if (ok) { this._pkgComposite.vectorLayerDirty(layerId); this.scheduleRender(); }   // redraw the overlay (post-frame callback)
        return ok;
    }

    /** Remove a single placement from an ephemera layer. */
    public deleteEphemeraPlacement(layerId: string, placementId: string): boolean {
        const ok = this._ephemera.deletePlacement(layerId, placementId);
        if (ok) { this._pkgComposite.vectorLayerDirty(layerId); this.scheduleRender(); }   // redraw the overlay so the removed placement clears
        return ok;
    }

    /** Get all placements on an ephemera layer. */
    public getEphemeraPlacementsForLayer(layerId: string): EphemeraPlacement[] {
        return this._ephemera.getPlacementsForLayer(layerId);
    }

    // ── Placement hit-testing & interaction ───────────────────────────

    private _activeVectorLayerId: string | null = null;   // shared with 2D shape layer-tagging (createRectangle et al.)
    /** The vector layer a newly-created (or legacy unassigned) shape belongs to: the active one, else the document's
     *  DEFAULT vector layer. So every vector shape has a real layer home and is gated by that layer's selection —
     *  like ephemera — instead of being unassigned/always-selectable. Undefined only when the doc has no vector layer. */
    private _targetVectorLayerId(): string | undefined {
        return this._activeVectorLayerId ?? this.rasterLayerManager?.getDefaultVectorLayerId() ?? undefined;
    }
    /** Stamp the owning vector layer onto a freshly-created shape (no-op if the doc has no vector layer). */
    private _stampVectorLayer(target: { layerId?: string }): void {
        const layerId = this._targetVectorLayerId();
        if (layerId) target.layerId = layerId;
    }
    /** Assign the default vector layer to any TOP-LEVEL shape that has no layerId (legacy docs). Idempotent. */
    private _backfillUnassignedVectorLayers(): void {
        const defaultId = this.rasterLayerManager?.getDefaultVectorLayerId();
        if (!defaultId) return;
        let changed = false;
        for (const n of this.sceneGraph.root.children) {
            if (!(n instanceof Shape) || n.layerId !== undefined) continue;
            // 2D vector shapes only — 3D nodes are Shapes too but live outside the vector-layer
            // system; stamping them made a LOAD change the next save (caught by the P6 round-trip
            // drive, 2026-09-15).
            if (n instanceof Mesh3D || n instanceof MeshGroup3D || n instanceof ArrayGroup3D
                || n instanceof ParticleEmitter3D
                || ['Skeleton3D', 'SkinnedMesh3D', 'GpObject3D'].includes(n.getType?.() ?? '')) continue;
            n.layerId = defaultId; changed = true;
        }
        if (changed) this.emitSceneGraphChanged();
    }

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

    // ── UI System (docs/specs/ui-system.md — Phase 1) ─────────────────────────────────────────────────────────
    // Interactive menus/HUDs: a `ui-layer` runs a pure state machine that toggles layer/shape visibility, navigates
    // between named states, and surfaces events to the host. Delegates to `this.ui` (UIManager).
    /** Create a UI layer (a behavior container; NOT a Layers-list row — managed from the dedicated UI panel).
     *  Returns the layer id + makes it active. */
    public createUILayer(name?: string): string { return this.ui.createUILayer(name); }
    /** Every UI layer's data (for listing them in the UI panel). */
    public listUILayers(): UILayerData[] { return this.ui.listUILayers(); }
    /** Get a UI layer's data. */
    public getUILayer(layerId: string): UILayerData | null { return this.ui.getUILayer(layerId); }
    /** Update UI layer props (name = rename, passThroughPointer, backgroundOverlay dim colour, visible). */
    public updateUILayer(layerId: string, updates: Partial<Pick<UILayerData, 'name' | 'passThroughPointer' | 'backgroundOverlay' | 'visible'>>): void { this.ui.updateUILayer(layerId, updates); this.scheduleRender(); }
    /** Delete a UI layer (the ✕ on the UI panel tab). Returns true if it existed. */
    public deleteUILayer(layerId: string): boolean { const ok = this.ui.deleteUILayer(layerId); if (ok) this.scheduleRender(); return ok; }
    /** The active UI layer (the one shape-interaction defaults target); null if none. */
    public get activeUILayerId(): string | null { return this.ui.activeUILayerId; }
    /** Make a UI layer the active one (the selected tab in the UI panel). */
    public setActiveUILayer(layerId: string): void { this.ui.setActiveUILayer(layerId); }
    /** Install the state machine on a UI layer (enters its initial state). */
    public setStateMachine(layerId: string, machine: UIStateMachine): void { this.ui.setStateMachine(layerId, machine); }
    /** The state machine currently on a UI layer. */
    public getStateMachine(layerId: string): UIStateMachine | null { return this.ui.getStateMachine(layerId); }
    /** Programmatically move a UI layer to a named state. */
    public goToUIState(layerId: string, stateId: string, animation?: TransitionAnimation): void { this.ui.goToState(layerId, stateId, animation); }
    /** The active state id of a UI layer. */
    public getCurrentUIState(layerId: string): string | null { return this.ui.getCurrentState(layerId); }
    /** The back-stack of a UI layer. */
    public getUIStateHistory(layerId: string): string[] { return this.ui.getStateHistory(layerId); }
    /** Read a UI scene variable. */
    public getUIVariable(layerId: string, variableId: string): UIValue | null { return this.ui.getUIVariable(layerId, variableId); }
    /** Set a UI scene variable (fires any variable-watch transitions). */
    public setUIVariable(layerId: string, variableId: string, value: UIValue): void { this.ui.setUIVariable(layerId, variableId, value); }
    /** Locate an ephemera placement by its (globally unique) id → its owning layer + record, or null. */
    private _findPlacementById(id: string): { layerId: string; placement: EphemeraPlacement } | null {
        for (const [layerId, list] of this._ephemera.getAllPlacements()) {
            const placement = list.find((p) => p.id === id);
            if (placement) return { layerId, placement };
        }
        return null;
    }
    /** Subscribe to VIEWPORT selection changes — the selected shape ids. This is how the UI panel's "SHAPE
     *  INTERACTIONS" section knows which shape to wire: subscribe, and when exactly one id is selected show the
     *  make-interactive controls. Fires for BOTH scene-graph node selection AND ephemera placement selection (they
     *  live in separate systems), so an ephemera registers just like a vector shape. Returns an unsubscribe fn.
     *  (A raster PIXEL region is not a node/placement and cannot be a UI target.) */
    public onShapeSelectionChanged(cb: (selectedIds: string[]) => void): () => void {
        const emit = () => cb(this.getSelectedShapeIds());
        const s1 = this.interactionService.onSelectionChanged.subscribe(emit);
        const s2 = this._ephemeraOverlay.onPlacementSelectionChanged.subscribe(emit);
        return () => { s1.unsubscribe(); s2.unsubscribe(); };
    }
    /** The currently selected shape ids in the viewport — scene-graph nodes + the selected ephemera placement. */
    public getSelectedShapeIds(): string[] {
        const ids = [...this.interactionService.selectedNodes].map((n) => (n as Shape).id);
        const p = this._ephemeraOverlay.getSelectedPlacement();
        if (p) ids.push(p.placementId);
        return ids;
    }
    /** Attach interaction props to a shape (any layer). Defaults to the active UI layer. */
    public setShapeInteraction(props: ShapeInteractionProps, layerId?: string): void { this.ui.setShapeInteraction(props, layerId); }
    /** Remove a shape's interaction props. */
    public clearShapeInteraction(shapeId: string, layerId?: string): void { this.ui.clearShapeInteraction(shapeId, layerId); }
    /** Get a shape's interaction props. */
    public getShapeInteraction(shapeId: string, layerId?: string): ShapeInteractionProps | null { return this.ui.getShapeInteraction(shapeId, layerId); }
    /** Simulate/dispatch a click on an interactive shape (also driven by the canvas pointer hit-test when interactive). */
    public clickUIShape(shapeId: string, layerId?: string): void { this.ui.clickShape(shapeId, layerId); }
    /** Turn live UI interactivity on/off (preview/play mode). OFF by default so editing is never intercepted. */
    public setUIInteractive(on: boolean): void {
        // Lazily stand up the HTML-form DOM overlay on first preview (needs the live canvas + document).
        if (on && !this._uiFormOverlay && typeof document !== 'undefined' && this.interactionService.canvas) {
            this._uiFormOverlay = new UIFormOverlay(this.interactionService.canvas, {
                onInput: (elementId, value) => this.ui.handleFormInput(elementId, value),
                onSubmit: (formId) => this.ui.submitForm(formId),
            });
            this.ui.setFormAdapter(this._uiFormOverlay);
        }
        this.ui.setInteractive(on);
        if (!on) this._uiStopAllClipPlayers();   // leaving preview: kill UI-driven clip playback (no orphan RAFs)
        this.scheduleRender();
    }
    private _uiFormOverlay: UIFormOverlay | null = null;

    // ── UI sound (playSound/stopSound/setVolume actions) ──
    private _uiSound: UISoundPlayer | null = null;
    private _uiSoundPlayer(): UISoundPlayer {
        if (!this._uiSound) { this._uiSound = new UISoundPlayer(); this.ui.setSoundAdapter(this._uiSound); }
        return this._uiSound;
    }
    /** Register a playable URL (object/data URL) for a sound assetId — machines then play it by id. */
    public registerUISound(assetId: string, url: string): void { this._uiSoundPlayer().register(assetId, url); }
    public unregisterUISound(assetId: string): void { this._uiSound?.unregister(assetId); }
    /** AssetIds with a registered URL (for the authoring panel's sound picker). */
    public listUISounds(): string[] { return this._uiSound?.listSounds() ?? []; }
    /** Play a registered UI sound by id (Frogmarks Player's postMessage 'playSound' command calls this — it was a
     *  phantom API before bug-hunt 2026-10-01, so the command silently no-op'd). */
    public playUISound(assetId: string, volume?: number, loop?: boolean): void { this._uiSound?.play(assetId, volume, loop); }
    /** Raster selection feather (px of soft edge) — the Frogmarks feather slider calls this (was a phantom API). */
    public setRasterSelectionFeather(px: number): void { this.rasterSelectionService?.setFeather(px); }

    // ── HTML forms (Phase 4) ──
    /** Add (or replace, by id) a native form control on a UI layer's machine. Defaults to the active UI layer. */
    public addHtmlFormElement(element: HtmlFormElement, layerId?: string): void { this.ui.addHtmlFormElement(element, layerId); }
    /** Remove a form control by id. */
    public removeHtmlFormElement(elementId: string, layerId?: string): void { this.ui.removeHtmlFormElement(elementId, layerId); }
    /** Current DOM value of a mounted form element (checkbox → boolean). */
    public getUIFormValue(elementId: string): string | boolean | null { return this.ui.getFormValue(elementId); }
    /** Submit a form programmatically (gathers values → formSubmit event + trigger). */
    public submitUIForm(formId: string): void { this.ui.submitForm(formId); }
    /** Re-anchor the form overlay to the canvas (the host calls this after a canvas resize/move). */
    public repositionUIForms(): void { this._uiFormOverlay?.reposition(); }
    /** Whether live UI interactivity is currently on. */
    public get uiInteractive(): boolean { return this.ui.interactive; }
    /** Advance UI timers — the host calls this each frame while in interactive preview (no-op otherwise). */
    public tickUI(dtMs: number): void { this.ui.tick(dtMs); }

    // ── UI KIT (screen-space HUD / menu / transition pieces — docs/ui/persona-ui-kit.md) ──
    /** Insertable single-piece presets [{id, label, kind}]. */
    public listUIKitPresets(): { id: string; label: string; kind: string }[] { return UI_KIT_PRESETS.map((p) => ({ id: p.id, label: p.label, kind: p.kind })); }
    /** Every kind's property schema (generic panel controls) + labels, transitions and clips. */
    public getUIKitSchema(): { kinds: Record<string, { label: string; props: UIKitPropSpec[] }>; transitions: string[]; clips: string[]; colorTokens: string[]; anchors: string[]; intros: string[] } {
        const kinds: Record<string, { label: string; props: UIKitPropSpec[] }> = {};
        for (const k of Object.keys(KIT_SCHEMA) as UIKitKind[]) kinds[k] = { label: KIT_KIND_LABELS[k], props: KIT_SCHEMA[k] };
        return { kinds, transitions: [...UI_KIT_TRANSITIONS], clips: [...UI_KIT_CLIPS], colorTokens: [...KIT_COLOR_TOKENS], anchors: [...KIT_ANCHORS], intros: [...KIT_INTROS] };
    }
    /** Insert a preset on a UI layer (default: the active one; a "UI Kit" layer is created when there is none). */
    public insertUIKitPreset(presetId: string, layerId?: string): UIKitWidget | null { const w = this.ui.insertKitPreset(presetId, layerId); this.scheduleRender(); return w; }
    /** Insert a demo: 'hud' (new "Persona HUD" layer) or 'pause' (pause menu; merged into a HUD demo layer). */
    public insertUIKitDemo(kind: 'hud' | 'pause'): { layerId: string; widgetIds: string[] } { const r = this.ui.insertKitDemo(kind); this.scheduleRender(); return r; }
    public addUIKitWidget(kind: UIKitKind, layerId?: string): UIKitWidget { return this.ui.addKitWidget(kind, layerId); }
    /** A layer's kit widgets (live objects — edit through updateUIKitWidget). */
    public getUIKitWidgets(layerId?: string): UIKitWidget[] { return this.ui.listKitWidgets(layerId); }
    public getUIKitWidget(id: string): UIKitWidget | null { return this.ui.findKitWidget(id)?.widget ?? null; }
    /** Patch a widget (top-level fields; `props` merges key by key). */
    public updateUIKitWidget(id: string, patch: Partial<Omit<UIKitWidget, 'id' | 'props'>> & { props?: Record<string, number | string | boolean> }): boolean { return this.ui.updateKitWidget(id, patch); }
    public removeUIKitWidget(id: string): boolean { return this.ui.removeKitWidget(id); }
    /** Play a clip on a widget (intro | slide | pop | punch | drop | spin | shake | wobble | pulse). */
    public playUIKitClip(id: string, clip?: string): void { this.ui.playKitClip(id, (clip ?? 'intro') as UIKitClip); }
    /** Preview a kit transition (slash | shatter | stripeBurst | panelSlide | zoomPunch) — works in edit mode too. */
    public previewUIKitTransition(type: string, durationMs?: number): void { this.ui.previewKitTransition(type as UIKitTransitionType, durationMs); }
    /** Menu helpers (Player / host buttons): move the shown menu's selection, activate the selected item. */
    public uiKitMenuMove(delta: number, menuId?: string): number | null { return this.ui.kitMenuMove(delta, menuId); }
    public uiKitMenuActivate(menuId?: string): boolean { return this.ui.kitMenuActivate(menuId); }
    /** Freeze the kit's UI clock at ms (frame-sequence capture); null = live. */
    public setUIKitClock(ms: number | null): void { this.ui.kit.setClock(ms); this.scheduleRender(); }
    /** Subscribe to UI events (state/variable changes, custom emitEvent). Returns an unsubscribe fn. */
    public onUIEvent(cb: (e: UIEvent) => void): () => void { return this.ui.onUIEvent(cb); }

    public getSelectedPlacement(): { layerId: string; placementId: string } | null {
        return this._ephemeraOverlay.getSelectedPlacement();
    }

    public selectPlacement(layerId: string, placementId: string): void {
        this._ephemeraOverlay.selectPlacement(layerId, placementId);
    }

    public clearPlacementSelection(): void {
        this._ephemeraOverlay.clearPlacementSelection();
    }

    /** Hit-test world-space point against all visible ephemera placements (topmost, rotation-aware). */
    public hitTestEphemeraPlacement(worldX: number, worldY: number): { layerId: string; placementId: string; x: number; y: number } | null {
        return this._ephemeraOverlay.hitTestEphemeraPlacement(worldX, worldY);
    }

    /** Move a placement to a new position (called by the renderer drag handler). */
    public movePlacementTo(layerId: string, placementId: string, newX: number, newY: number): void {
        this._ephemeraOverlay.movePlacementTo(layerId, placementId, newX, newY);
    }

    /** Hit-test the transform handles of the currently selected placement (called by the renderer). */
    public hitTestPlacementHandle(wx: number, wy: number): PlacementHandleHit | null {
        return this._ephemeraOverlay.hitTestPlacementHandle(wx, wy);
    }

    /** Apply a resize drag: recomputes x/y/width/height while pinning the anchor corner/edge. */
    public applyPlacementResize(layerId: string, placementId: string, handle: PlacementResizeHandle, anchorX: number, anchorY: number, dragX: number, dragY: number): void {
        this._ephemeraOverlay.applyPlacementResize(layerId, placementId, handle, anchorX, anchorY, dragX, dragY);
    }

    /** Apply a rotate drag: updates rotation from angular delta around the placement center. */
    public applyPlacementRotate(layerId: string, placementId: string, centerX: number, centerY: number, startAngle: number, startRotation: number, dragX: number, dragY: number): void {
        this._ephemeraOverlay.applyPlacementRotate(layerId, placementId, centerX, centerY, startAngle, startRotation, dragX, dragY);
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