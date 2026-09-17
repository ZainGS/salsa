// C6 (2026-09-13): the PackagingHost implementation, moved VERBATIM out of the ShapeManager facade
// to live beside the packaging module it serves (the recreate2DShape/"relocation buys isolation" stance).
// `sm` is the facade: every `sm.X` below is a coupling the move made explicit. The hooks bridge the
// rigid-panel box hierarchy, dieline live-texture layers, surface-paint sessions, creator staging, and
// persistence to the scene graph + raster engine.
import type ShapeManager from '../services/shape-manager';
import type { PackagingHost, PackagingMarker, PackagingPersistEntry } from './packaging-manager';
import { LayerManager } from '../services/layer-manager';
import { PackagingComposite } from './packaging-composite';
import { createCDKit, rebuildCDKitUnderRoot, setCDKitScrub, setCDPieceArt, setCDTrayClear, setCDTrayCardFold, removeCDKit, CD_MM_TO_WORLD, type CDKitHost, type CDKitState, type CDPieceMaterial } from './cd/cd-kit';
import { cdComponentView, CD_ALL_PIECES, type CDPiece, type CDComponent } from './cd/cd-kit-assembly';
import { cdPrintSpec, CD_PRINT_PIECES, type CDPrintSpec } from './cd/cd-print';
import { buildPrintPdf, rgbaToRgb } from './print-pdf';
import { SceneAuthoringAPI } from '../services/scene-authoring-api';
import { PACKAGING_ENABLED } from '../services/persistence/shell-storage';
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Shape } from "../scene-graph/shapes/base/shape";
import { Node } from "../scene-graph/shapes/base/node";
import { recreateNode, type Shape2DRestoreDeps } from "../services/shape-serializer";
import { hexToRgba } from "../utils/color";
import { PatternDrawingService } from "../services/drawing/pattern-drawing-service";
import { InteractionService } from "../services/interaction-service";
import { Scribble } from "../scene-graph/shapes/scribble";
import { Highlight } from "../scene-graph/shapes/highlight";
import { Text } from "../scene-graph/shapes/text";
import { Section } from "../scene-graph/shapes/section";
import { WebGPURenderer, type PlacementResizeHandle, type PlacementHandleHit } from "../renderer/core/webgpu-renderer";
import { Group } from "../scene-graph/shapes/base/group";
import { EventEmitter } from "../renderer/util/event-emitter";
import { Line, ArrowheadStyle } from "../scene-graph/shapes/line";
import { SDFText } from "../scene-graph/shapes/sdf-text/sdf-text";
import { StickyNote } from "../scene-graph/shapes/sticky-note";
import { Pattern } from "../scene-graph/shapes/pattern";
import { StampDrawingService } from "../services/drawing/stamp-drawing-service";
import { PathEditService } from "../services/drawing/path-edit-service";
import { PathNode, type PathAnchor } from "../scene-graph/shapes/path-node";
import { Polygon, PolygonPreset } from "../scene-graph/shapes/polygon";
import { parseSVGPath } from "../scene-graph/core/svg-path";
import { RasterDrawingService } from "../services/raster-drawing-service";
import { RasterSelectionService } from "../services/raster-selection-service";
import { RasterMoveService } from "../services/raster-move-service";
import { RasterTextService, RasterTextState } from '../services/raster-text-service';
import { RasterLayerManager } from '../services/raster-layer-manager';
import { LayerBlendMode, RasterCompositor, type CompositorLayerInfo } from '../renderer/raster/core/raster-compositor';
import { DitherConfig, DitherAlgorithm, DitherColorMode, defaultDitherConfig, DitherEngine } from '../renderer/raster/effects/dither-engine';
import { TextEffectEngine, TextEffectType, TextEffectConfig, TextEffectParams, TextCaptureConfig, ChromaticAberrationParams, GlowParams, WaveParams, GlitchParams, OutlineParams, CustomShaderParams, CustomShaderCompileResult, defaultChromaticAberration, defaultGlow, defaultWave, defaultGlitch, defaultOutline, defaultCustomShader } from '../renderer/raster/effects/text-effect-engine';
import { Stamp } from "../scene-graph/shapes/stamp";
import { SpeechBalloon, SpeechBalloonOptions, TailSide, BalloonStyle } from "../scene-graph/shapes/speech-balloon";
import { LiveTextNode, LiveTextOptions } from "../scene-graph/shapes/live-text";
import { PanelLayout, PanelLayoutOptions, PanelTemplate, PanelDef } from "../scene-graph/shapes/panel-layout";
import { DualBrushSettings, DualBrushBlendOp, ColorJitter, WetEdgeSettings, StrokeTextureSettings, StabilizationMethod, BrushStabilization, BleedSettings, SmudgeSettings } from '../renderer/raster/brushes/brush-preset';
import { FloodFillEngine, FloodFillOptions } from '../renderer/raster/tools/flood-fill-engine';
import { DocumentPersistence, DocumentManifest, DocumentSavePayload, DocumentInfo, AutoSaveConfig, isOPFSAvailable } from '../services/persistence/document-persistence';
import { DocumentStateCoordinator } from '../services/persistence/document-state-coordinator';
import { PixelFormat, isFormatSupported } from '../services/persistence/pixel-codec';
import { packProject as _packProject, unpackProject as _unpackProject } from '../services/persistence/project-package';
import { packFrogcart, unpackFrogcart, type FrogcartMeta, type FrogcartManifest, type FrogcartPlayerConfig } from '../services/persistence/frogcart';
import { mat4, vec4 } from 'gl-matrix';
import { Mesh3D, Mesh3DConfig, MeshPrimitive } from '../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D, InstanceOverride } from '../scene-graph/shapes/array-group-3d';
import { Modifier } from '../scene-graph/shapes/modifiers';
import { ParticleEmitter3D } from '../scene-graph/shapes/particle-emitter-3d';
import { Camera3D, Camera3DConfig } from '../renderer/3d/camera-3d';
import { OrbitController, OrbitControllerConfig } from '../renderer/3d/orbit-controller';
import { Renderer3D, PS1Config, DEFAULT_PS1_CONFIG, WOBBLE_PRESET, POCKET_PRESET, FogConfig, DEFAULT_FOG_CONFIG, PostProcessConfig, HighlightStyle } from '../renderer/3d/renderer-3d';
import { Material3D, applyMaterialPatch, type SceneWind3D } from '../renderer/3d/material-3d';
import { MeshGeometry } from '../renderer/3d/mesh-generators';
import { booleanMesh, type Tri, type BooleanOp } from '../scene-graph/shapes/mesh-boolean';
import { simplifyGeometry } from '../scene-graph/shapes/mesh-simplify';
import { deriveViewRules } from '../services/managers/view-state';
import { RasterManager } from '../services/managers/raster-manager';
import { TextManager } from '../services/managers/text-manager';
import { AnimationManager } from '../services/managers/animation-manager';
import { Scene3DManager } from '../services/managers/scene3d-manager';
import { WorldManager } from '../services/managers/world-manager';
import { BuildingManager } from '../services/managers/building-manager';
import { BlockManager } from '../services/managers/block-manager';
import type { BuildingParams, BuildingMeta } from '../world/building';
import { buildScatterLayers, buildScatterSurface, PARK_RULES, type ScatterRules } from '../world/ground-scatter';
import { FoliageManager } from '../services/managers/foliage-manager';
import { VendingManager } from '../services/managers/vending-manager';
import { BikeRackManager } from '../services/managers/bike-rack-manager';
import { BollardManager } from '../services/managers/bollard-manager';
import { LampPostManager } from '../services/managers/lamp-post-manager';
import { TrashBinManager } from '../services/managers/trash-bin-manager';
import { CrateManager } from '../services/managers/crate-manager';
import { VentManager } from '../services/managers/vent-manager';
import { ABoardManager } from '../services/managers/a-board-manager';
import { StallManager } from '../services/managers/stall-manager';
import type { ProcTransform, ProceduralObjectManager } from '../services/managers/procedural-object-manager';
import { creator3DTypes, creator3DSchema, creator3DDefaults, type CreatorParamSchema } from '../services/managers/creator-registry';
import { decalQuadGeometry, decalPlacement, type DecalSource, type DecalHit, type V3 } from '../services/managers/decal-geometry';
import { GarpManager, GARP_BLANK_LAYER } from '../services/managers/garp-manager';
import { aboardGarpPool, aboardSkinKey } from '../world/a-board';
import { addZonelessListener, removeZonelessListener } from '../renderer/util/zoneless-listeners';
import type { FoliageParams, FoliageMeta } from '../world/foliage';
import type { FaceBlinkConfig, LegIdleMode } from '../services/managers/scene3d-manager';
import type { HairParams } from '../services/managers/hair-generator';
import type { SnapVizData } from '../services/managers/transform-controller-3d';
import type { Submesh3D } from '../scene-graph/shapes/mesh-3d';
import { DrawingToolManager } from '../services/managers/drawing-tool-manager';
import { MeshPaintManager } from '../services/managers/mesh-paint-manager';
import { MeshEditManager } from '../services/managers/mesh-edit-manager';
import type { UVIsland } from '../scene-graph/shapes/edit-mesh';
import { UVEditorSession, UVCanvasRenderer } from '../services/managers/uv-canvas-renderer';
import type { UVSelectionMode } from '../services/managers/uv-canvas-renderer';
import { UVEditManager } from '../services/managers/uv-edit-manager';
import { UVPaintController, UVBrushSettings } from '../services/managers/uv-paint-controller';
import { RasterTextureManager } from '../renderer/raster/raster-texture-manager';
import { LiveTextureMode } from '../services/managers/live-texture-mode';
import { LiveTextManager } from '../services/managers/live-text-manager';
import { DecalManager } from '../services/managers/decal-manager';
import { ShellUIManager } from '../services/managers/shell-ui-manager';
import { UIManager } from '../services/managers/ui-manager';
import { MeshEditPointerController, type MeshEditSelectionMode } from '../services/managers/mesh-edit-pointer-controller';
import { PersistenceManager as PersistenceManagerDelegate } from '../services/managers/persistence-manager';
import type { ManagerContext } from '../services/managers/manager-context';
import { EphemeraService } from '../services/ephemera/ephemera-service';
import { EphemeraOverlay } from '../services/ephemera/ephemera-overlay';
import { GROUND_SURFACES, resolveGroundRecipe, type GroundSurfaceName, type GroundSurfaceSpec } from '../world/ground-surfaces';
import type { EphemeraElement, EphemeraElementSheet, IEphemeraGenerator, EphemeraCategory, EphemeraPlacement } from '../services/ephemera/ephemera-types';

export function createPackagingHost(sm: ShapeManager): PackagingHost {
    return {
        // ── rigid-panel node hooks (box-hierarchy.ts drives these) ──
        createGroup: (name, parentNodeId, scale) => {
            const g = new MeshGroup3D(sm.interactionService);
            g.name = name;
            if (scale !== undefined) { g.scaleX = scale; g.scaleY = scale; g.scaleZ = scale; }
            const parent = parentNodeId ? sm.sceneGraph.findNodeById(parentNodeId) : null;
            (parent ?? sm.sceneGraph.root).addChild(g);
            sm.emitSceneGraphChanged();
            return g.id;
        },
        // The package ROOT, created + announced up front the SAME way Building/Foliage/Block are
        // (createCityContainer = a thin-wrapper at root with documentSkipChildren + an immediate
        // scene-graph-changed) so the Outliner shows "Package" the instant it is added. A
        // `worldParams.kind` marker keeps the City manager from adopting this thin-wrapper as the
        // city (the City container is the one with NO kind — same guard buildings use).
        createUnitRoot: (name) => {
            const g = sm.scene3d.createCityContainer(name);
            g.worldParams = { kind: 'packaging' };
            return g.id;
        },
        createPanelMesh: (geom, parentNodeId, name) => {
            const m = new Mesh3D(sm.interactionService, 0, 0, 0, {
                primitive: 'custom', geometry: geom,
                // texOverBase: the dieline live-texture is composited OVER this white base by its
                // alpha (albedo = mix(base, tex.rgb, tex.a)) — a fresh TRANSPARENT dieline layer
                // renders as blank white board, and strokes appear painted directly on it.
                material: { diffuse: { r: 0.96, g: 0.95, b: 0.93, a: 1 }, roughness: 0.92, metalness: 0, doubleSided: true, texOverBase: true },
            });
            m.name = name; m.gpuDirty = true;
            const parent = sm.sceneGraph.findNodeById(parentNodeId) ?? sm.sceneGraph.root;
            parent.addChild(m);
            sm.emitSceneGraphChanged();
            return m.id;
        },
        setNodeTransform: (id, t) => {
            const n = sm.sceneGraph.findNodeById(id) as (Mesh3D | MeshGroup3D) | null;
            if (!n) return;
            if (t.pos) n.setXYZ(t.pos[0], t.pos[1], t.pos[2]);   // one matrix rebuild + subtree dirty walk
            if (t.rotX !== undefined) n.rotationX = t.rotX;
            if (t.rotY !== undefined) n.rotationY = t.rotY;
            if (t.rotZ !== undefined) n.rotation = t.rotZ;
            if (t.scale) { n.scaleX = t.scale[0]; n.scaleY = t.scale[1]; n.scaleZ = t.scale[2]; }   // ROOT-transform restore (fold/dims never scale)
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
            sm.scene3d.notifyMeshTransformsChanged3D();   // markTransformsDirty + scheduleRender
        },
        setPanelGeometry: (meshId: string, geom: MeshGeometry) => sm.scene3d.setGeometry(meshId, geom),
        removeNode: (id) => sm.scene3d.disposePackagingSubtree(id),

        linkLiveTexture: (id, layerId) => sm.linkLiveTexture3D(id, layerId),
        unlinkLiveTexture: (id) => sm.unlinkLiveTexture3D(id),
        exportLayerPng: (layerId) => sm.exportRasterLayerToBlob(layerId, 'image/png'),
        scheduleRender: () => sm.scheduleRender(),
        // ── 3D-paint editor hooks (see PackagingManager.enterEditor) ──
        setDocSize: (w, h) => sm.setDocumentSize(w, h),
        ensureDielineLayer: (existing) => {
            const rlm = sm.rasterLayerManager;
            if (!rlm) return null;
            // Restore path: reuse the saved layer — but only a REAL paint layer (has a texture;
            // folders/dividers or a half-restored layer without one would link the box to nothing
            // and hasTexture=false would route the panels to the untextured pipeline).
            if (existing && rlm.getLayerById(existing)?.texture) {
                sm._tagPackagingLayer(existing);
                return existing;
            }
            return sm._addPackagingDielineLayer();
        },
        frameAndOrbit: (rootNodeId) => {
            // TURN THE 3D SCENE ON — the box is a 3D node hierarchy, and the editor's canvas may have
            // been set up as a flat-2D dieline doc (scene3DVisible false) → the box never draws and Fold
            // looks dead. Entering the packaging editor is inherently 3D, so make the pass render.
            sm.scene3DVisible = true;
            // Don't crop the viewport to the flat-dieline doc rect — the orbited/folded 3D box extends past it.
            sm.webgpuRenderer?.setArtboardClipEnabled(false);
            // enterGroupOrbit3D frames the box container AND claims the camera for orbit (sets
            // _meshEditOrbitCenter) so the 2D illustration auto-sync stops snapping the camera back every
            // frame — which rendered the flat XZ-plane dieline EDGE-ON (invisible). 3/4 top-down default.
            sm.scene3d.enterGroupOrbit3D(rootNodeId, { azimuth: Math.PI * 0.18, elevation: 1.0, padding: 1.7 });
            sm.scheduleRender();
        },
        stopOrbit: () => { sm.scene3d.exitMeshOrbit3D(); sm.webgpuRenderer?.setArtboardClipEnabled(true); },
        armSurfacePaint: (meshIds, layerId) => {
            // Packaging owns the composite + live-texture sync; supply them so the paint session stays
            // agnostic (the inversion that lets UVPaintSessionManager import nothing from packaging).
            // `pkgIdOfArm` is captured ONCE per arm (matches the old inline behavior); readbackTexMgr
            // re-resolves per-call (also matching the old behavior).
            const primary = meshIds[0];
            const pkgIdOfArm = sm._packaging?.isPackageNode(primary) ?? null;
            return sm._armPackagingSurfacePaint(meshIds, layerId, {
                readbackTexMgr: () => { const p = sm._packaging?.isPackageNode(primary); return p ? sm._pkgComposite.getCompositeMgr(p) : null; },
                onBeforeStroke: () => sm.syncLiveTextures3D(),
                onStrokeMove: () => { if (pkgIdOfArm) sm._pkgComposite.recompositeThrottled(pkgIdOfArm); },
                onStrokeEnd: () => {
                    sm.syncLiveTextures3D();
                    if (pkgIdOfArm && sm._pkgComposite.hasComposite(pkgIdOfArm)) sm._pkgComposite.recomposite(pkgIdOfArm);
                },
            });
        },
        // Only tear down a PACKAGING session. Packaging calls this whenever a vector layer goes
        // active and on exiting creator mode; a blind `isActive()` check would also kill an
        // unrelated CHARACTER paint session (garment/hair) that happened to be open.
        disarmSurfacePaint: () => { if (sm._paintSessionKind === 'packaging') sm.exitUVPaintMode3D(); },
        // ── CREATOR-MODE hooks (enterCreatorMode — the mode-in-the-Illustration-editor path) ──
        ensureDielineLayerInfo: (existing, packageId) => {
            const rlm = sm.rasterLayerManager;
            if (!rlm) return null;
            // Same real-paint-layer guard as ensureDielineLayer (must have a texture to link).
            if (existing && rlm.getLayerById(existing)?.texture) {
                sm._tagPackagingLayer(existing);
                return { layerId: existing, fresh: false };
            }
            // Reuse a layer already NAMED 'Dieline' (fixes the duplicate-'Dieline'-layers-on-re-enter
            // symptom) — but only a real paint layer (has a texture; skips folders/dividers), and
            // NEVER one already owned by a DIFFERENT package (packageOwnerId — stealing another
            // box's stack base made every package share one paint surface). Untagged legacy
            // (pre-system-flag) Dieline layers are adopted: tagged + composite-hidden.
            const named = rlm.getLayers().find(l => {
                if (l.name !== 'Dieline' || !rlm.getLayerById(l.id)?.texture) return false;
                const owner = rlm.getLayerById(l.id)?.packageOwnerId;
                return !owner || owner === packageId;
            });
            if (named) {
                sm._tagPackagingLayer(named.id);
                return { layerId: named.id, fresh: false };
            }
            const id = sm._addPackagingDielineLayer(packageId);
            return id ? { layerId: id, fresh: true } : null;
        },
        fillLayerWhite: (layerId) => sm._fillRasterLayerWhite(layerId),
        nodeExists: (id) => !!sm.sceneGraph.findNodeById(id),
        // City-mode enter/exit hygiene: no marquee box-select or hover/selection chrome over the
        // box while orbiting, and the view gizmo up (removed again by exitMeshOrbit3D's
        // disableOrbitControls on exit — same as exitCityMode3D).
        beginCreatorStage: () => {
            sm.interactionService.suppressBoxSelect = true;
            // BUG 3: while creator mode is active the target box is NEVER selected by a click,
            // with ANY modifier. A plain click falls through to surface PAINT; an ALT click is
            // orbit-only (the orbit controller reads the raw pointer — it does not need the pick
            // to select). The manager owns the predicate (isPickSuppressed): it suppresses the
            // creator TARGET's panel/pivot/root ids UNCONDITIONALLY — independent of the pointer
            // modifier AND of the active layer's paintability. Gating on paintability used to
            // LIFT suppression in vector 'place' mode, which let an alt-orbit click select (and
            // snap the gizmo onto) the box — the reported alt-select bug. Suppression does not
            // stop propagation, so place-mode clicks still reach the illustration tools; only
            // the box stops being SELECTABLE by a click. Survives setDimensions rebuilds (the
            // predicate re-resolves the live registry every call).
            sm.interactionService.pickSuppressed3D = (id) => sm._packaging?.isPickSuppressed(id) ?? false;
            sm.scene3d.setHoveredMesh(null);
            sm.scene3d.clearSelection();
            sm.scene3d.enableViewGizmo();
            // §4 STUDIO LIGHTING: even with the neutral default ambient, the scene light may be
            // dim or the user may have tinted it — a product stage wants a bright, neutral,
            // WHITE key + fill so the box shows its true colours. Capture the scene lighting and
            // swap in studio light (white ambient fill + a white key, angle kept); restored on
            // exit. Skipped if an env map/IBL is driving diffuse (the user chose a lit environment).
            if (!sm._stagePrevLight && !sm.scene3d.iblEnabled3D) {
                sm._stagePrevLight = { ambient: sm.renderer3D.ambientConfig, directional: sm.getLight3D() };
                sm.setAmbientLight3D(1, 1, 1, 0.6);                       // soft neutral fill
                const d = sm._stagePrevLight.directional.direction;
                sm.renderer3D.setDirectionalLight(d[0], d[1], d[2], 1, 1, 1, 0.9);   // white key, keep the angle
                sm.scheduleRender();
            }
            // §4.3 camera DRIFT-IN: a ~450ms eased dolly/orbit settle onto the framing that
            // frameAndOrbit just set (runs before beginCreatorStage) instead of a hard cut.
            // Cancels itself on the first pointer/wheel interaction — never fights input.
            sm.scene3d.driftOrbitIn3D(450);
            // OPT-IN ambience ticker: keep the animated stage background (and any time-driven shader
            // effects) moving while the mode is active. The render loop is on-demand by design, so
            // idle frames = frozen wavy bg; this ~30fps tick trades a little GPU for a live-feeling
            // workspace, ONLY inside Package Creator (cancelled on exit — never a background cost).
            if (!sm._creatorTickRaf && typeof requestAnimationFrame !== 'undefined') {
                let last = 0;
                const tick = (now: number): void => {
                    if (now - last >= 33) { last = now; sm.scheduleRender(); }   // ~30fps
                    sm._creatorTickRaf = requestAnimationFrame(tick);
                };
                sm._creatorTickRaf = requestAnimationFrame(tick);
            }
        },
        endCreatorStage: () => {
            sm.interactionService.suppressBoxSelect = false;
            sm.interactionService.pickSuppressed3D = null;   // click-select restored on exit
            // §4 restore the scene lighting the studio stage swapped out.
            if (sm._stagePrevLight) {
                const a = sm._stagePrevLight.ambient, dl = sm._stagePrevLight.directional;
                sm.setAmbientLight3D(a.color[0], a.color[1], a.color[2], a.intensity);
                sm.renderer3D.setDirectionalLight(dl.direction[0], dl.direction[1], dl.direction[2], dl.color[0], dl.color[1], dl.color[2], dl.intensity);
                sm._stagePrevLight = null;
                sm.scheduleRender();
            }
            sm.scene3d.cancelOrbitDrift3D();                 // §4.3: never leave a drift running
            if (sm._creatorTickRaf && typeof cancelAnimationFrame !== 'undefined') {
                cancelAnimationFrame(sm._creatorTickRaf);
                sm._creatorTickRaf = 0;
            }
        },
        // RE-APPLY the panel material contract (board base composited under the dieline via
        // texOverBase). Called by the manager on every panel (re)link: panels RESTORED from a
        // saved document keep their persisted material wholesale (Mesh3D.toJSON) — a legacy
        // pre-texOverBase material multiplies the transparent dieline → a near-BLACK box.
        // §4.2 `board` adds the paperboard READ: preset base colour (white coated / kraft) +
        // faint paper-fiber grain on the BASE (under the artwork composite) + a subtle darkened
        // rim at the panel's UV-rect borders (thick-board edge). Shader flag bit 16; the params
        // ride the pattern instance slots, so patterns and board shading are mutually
        // exclusive on packaging panels (panels never use patterns).
        applyPanelMaterial: (meshId, board) => {
            const m = sm.scene3d.getMesh(meshId);
            if (!m) return;
            const d = board?.diffuse ?? { r: 0.96, g: 0.95, b: 0.93 };   // white board default
            Object.assign(m.material, {
                diffuse: { r: d.r, g: d.g, b: d.b, a: 1 },
                roughness: 0.92, metalness: 0,
                doubleSided: true, texOverBase: true,
                boardShade: !!board,
                boardGrain: board?.grain ?? 0,
                boardRimStrength: board?.rimStrength ?? 0,
                boardUVRect: board?.uvRect,
                boardRimUV: board?.rimUV,
            });
            m.gpuDirty = true;
            sm.scheduleRender();
        },
        // §4.1 STUDIO STAGE hooks — the mode's focus background IS the mesh-edit focus bg
        // (enterGroupOrbit3D activates it); these just swap/read its options so the manager
        // can default to the studio gradient and restore the user's choice on exit.
        setStageBackground: (opts) => {
            sm.scene3d.setMeshEditBgMode3D(opts);
            sm.scheduleRender();
        },
        getStageBackground: () => sm.scene3d.getMeshEditBgMode3D(),
        // §4.1 CONTACT SHADOW — a ground quad with an in-shader radial alpha falloff (material
        // flag bit 17 'radialFade' on the transparent untextured pipeline): black diffuse +
        // zero specular + gouraud style renders a pure soft dark blob, cheaper and simpler
        // than a texture or a shadow-map ground catch. Child of the package ROOT (group-local
        // placement from the manager); excluded from picking, framing and serialization.
        createStageShadow: (parentNodeId, p) => {
            const parent = sm.sceneGraph.findNodeById(parentNodeId);
            if (!(parent instanceof MeshGroup3D)) return null;
            // Unit XZ quad (−1..1), +Y normal, UV 0..1 — the radial fade shapes it into a blob.
            const geom = {
                vertices: new Float32Array([
                    -1, 0, -1, 0, 1, 0, 0, 0,
                     1, 0, -1, 0, 1, 0, 1, 0,
                     1, 0,  1, 0, 1, 0, 1, 1,
                    -1, 0,  1, 0, 1, 0, 0, 1,
                ]),
                indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
                format: '8float' as const,
            };
            const m = new Mesh3D(sm.interactionService, p.x, p.y, p.z, {
                primitive: 'custom', geometry: geom,
                material: {
                    diffuse: { r: 0, g: 0, b: 0, a: 1 },
                    specular: { r: 0, g: 0, b: 0, a: 1 },
                    opacity: 0.34,                       // <1 → transparent pipeline (alpha blend)
                    roughness: 1, metalness: 0,
                    renderStyle: 'gouraud',              // black diffuse + no specular = flat black
                    doubleSided: true,
                    radialFade: true,                    // bit 17: soft radial edge dissolve
                },
            });
            m.name = 'Stage Shadow';
            m.pickable = false;                          // never selectable/paintable
            m.frameExclude = true;                       // never drags the camera framing out
            m.excludeFromDocument = true;                // a stage prop — never serialized
            m.scaleX = p.radiusX; m.scaleZ = p.radiusZ;
            parent.addChild(m);
            m.updateLocalMatrix();
            m.gpuDirty = true;
            sm.scheduleRender();
            return m.id;
        },
        updateStageShadow: (nodeId, p) => {
            const m = sm.scene3d.getMesh(nodeId);
            if (!m) return;
            m.scaleX = p.radiusX; m.scaleZ = p.radiusZ;
            m.setXYZ(p.x, p.y, p.z);                     // rebuilds the local matrix
            m.updateLocalMatrix();
            sm.scene3d.notifyMeshTransformsChanged3D();   // transforms-only fast path
        },
        removeStageShadow: (nodeId) => {
            sm.scene3d.disposePackagingSubtree(nodeId);   // no undo entry, GPU state evicted
            sm.scheduleRender();
        },
        // Creator-mode ISOLATION: hide/show a package root + its whole subtree. The render
        // list checks each MESH's own visible flag (group visibility does not cascade at draw
        // time), so the flag is stamped through the subtree uniformly — restore is uniform too.
        setNodeVisible: (id, visible) => {
            const n = sm.sceneGraph.findNodeById(id);
            if (!n) return;
            n.forEachDeep(d => { d.visible = visible; });   // includes the root itself
            sm.emitSceneGraphChanged();                   // renderList prunes hidden nodes at rebuild
            sm.scheduleRender();
        },
        isNodeVisible: (id) => sm.sceneGraph.findNodeById(id)?.visible ?? true,
        // FULL-SCENE isolation: hide EVERY top-level 3D object except the box being edited
        // (other packages, characters, buildings, the city, loose meshes), remembering prior
        // visibility. Idempotent — restores any prior isolation first (target switch).
        isolateSceneToPackage: (keepRootId) => {
            sm._restorePackagingIsolation();   // clean any prior set (switch) before re-isolating
            const mem = new Map<string, boolean>();
            for (const child of [...sm.sceneGraph.root.children]) {
                const cid = (child as unknown as { id: string }).id;
                if (cid === keepRootId) continue;                          // the edited box stays visible
                mem.set(cid, (child as unknown as { visible: boolean }).visible);
                child.forEachDeep(d => { d.visible = false; });
            }
            sm._packagingIsoMemory = mem;
            sm.emitSceneGraphChanged();
            sm.scheduleRender();
        },
        restoreSceneIsolation: () => sm._restorePackagingIsolation(),
        // ── FIRST-CLASS SCENE OBJECT hooks (addPackage / Outliner integration) ──
        // City thin-wrapper pattern: ONE outliner node; a click on any panel walks up to this
        // wrapper and selects the package AS A UNIT; the gizmo writes the root's transform
        // (composes into all panels). cachedBounds sizes the selection box/gizmo without a
        // per-child scan; bounds refreshes (re-dimension) don't re-notify the scene graph.
        markUnitWrapper: (rootNodeId, localBounds) => {
            const n = sm.sceneGraph.findNodeById(rootNodeId);
            if (!(n instanceof MeshGroup3D)) return;
            if (localBounds) n.cachedBounds = localBounds;
            // City thin-wrapper pattern (§0b): the package root serializes as a LIGHTWEIGHT
            // procedural marker — `documentSkipChildren` skips its panel/pivot subtree from
            // the saved scene graph (the params-only PackagingPersistEntry rebuilds it on
            // load, exactly like the City/building/foliage roots). Without it the panels
            // serialize as loose scene nodes AND the restored root — its thinWrapper flag is
            // NOT serialized on a plain group — shows every panel in the Outliner instead of
            // ONE 'Package'. The proceduralContent restore path (recreateNode) re-applies BOTH
            // flags, so the reloaded box is one selectable unit even before re-adoption runs.
            if (!n.thinWrapper || !n.documentSkipChildren) {
                n.thinWrapper = true;
                n.documentSkipChildren = true;
                sm.emitSceneGraphChanged();
            }
        },
        // Guaranteed final scene-graph flush at the end of package node ASSEMBLY (addPackage /
        // setDimensions rebuild / re-adoption) — the same event the normal mesh-add path fires
        // (createMesh3D → emitSceneGraphChanged), so the Outliner shows the package IMMEDIATELY
        // instead of on the next unrelated scene change. Coalesced during document restore.
        notifySceneGraphChanged: () => sm.emitSceneGraphChanged(),
        // BUG 1: COALESCE the per-node emits fired while a package is assembled (createGroup /
        // createPanelMesh each emit; so does the markUnitWrapper flag-flip) into ONE final
        // scene-graph-changed via the existing scene-graph batch counter. An Outliner that
        // latched the FIRST emit of the burst (pre-mark partial tree) now gets a single emit
        // carrying the fully assembled, thin-wrapper-marked package. Balanced by the manager.
        beginSceneGraphBatch: () => sm.beginSceneGraphBatch3D(),
        endSceneGraphBatch: () => sm.endSceneGraphBatch3D(),
        // ── UNWRAP PANE hooks (attachDielinePane) — reuse the ONE UV paint controller ──
        // Attach the host's pane canvas onto the paint session _armPackagingSurfacePaint set
        // up (same controller/engine/texture — pane strokes and 3D box strokes both paint the
        // dieline layer; the pane background is the throttled texture readback). Guarded so a
        // pane can never attach onto a CHARACTER paint session sharing the controller.
        attachPaintPane: (uvRenderer, onResize) => {
            const c = sm._uvPaintController;
            const active = c?.activeMeshId();
            if (!c || !active || !sm._packaging?.isPackageNode(active)) return null;
            // onResize → DielinePaneHandle.onPaneResize: fires after a pane LAYOUT resize
            // (view-mode switch) re-synced the backing store + re-rendered the pane.
            if (!c.attachPane(uvRenderer, onResize)) return null;
            return (u: number, v: number) => c.paneUVToCanvas(u, v) ?? [0, 0];
        },
        detachPaintPane: () => { sm._uvPaintController?.detachPane(); },
        // ── RE-ADOPTION hooks (reload persistence + orphan dedupe) ──
        reparentNode: (childId, parentId) => {
            const child = sm.sceneGraph.findNodeById(childId);
            const parent = sm.sceneGraph.findNodeById(parentId);
            if (!child || !parent || child.parent === parent) return;
            child.parent?.removeChild(child);
            (parent as MeshGroup3D).addChild(child);
            sm.emitSceneGraphChanged();
        },
        // Read a package ROOT's LIVE local transform so serialize()/the marker capture a
        // whole-box gizmo move/rotate/scale (which calls no packaging API) — recreateNode's
        // '3DMeshGroup' branch does NOT restore a marker's transform, so it must ride the entry
        // and be re-applied on load (the building-marker.transform pattern).
        getNodeTransform: (id) => {
            const n = sm.sceneGraph.findNodeById(id) as (Mesh3D | MeshGroup3D) | null;
            if (!n) return null;
            return {
                x: n.x, y: n.y, z: n.z,
                rotationX: n.rotationX, rotationY: n.rotationY, rotation: n.rotation,
                scaleX: n.scaleX, scaleY: n.scaleY, scaleZ: n.scaleZ,
            };
        },
        layerExists: (layerId) => !!sm.rasterLayerManager?.getLayerById(layerId)?.texture,
        // Every '<Panel> Hinge' pivot group under the root (any depth — pivots nest along the
        // fold chain), with its Mesh3D child and its panel name. Used for id-drift recovery
        // and orphan adoption (name-matched to the template's panel list, so walk order is
        // irrelevant).
        getPackageStructure: (rootId) => {
            const root = sm.sceneGraph.findNodeById(rootId);
            if (!(root instanceof MeshGroup3D)) return null;
            const out: { pivotNodeId: string; meshId: string | null; name: string }[] = [];
            root.forEachDeep(n => {
                if (n === root) return;
                if (n instanceof MeshGroup3D && typeof n.name === 'string' && n.name.endsWith(' Hinge')) {
                    const mesh = (n.children ?? []).find(c => c instanceof Mesh3D) as Mesh3D | undefined;
                    out.push({ pivotNodeId: n.id, meshId: mesh?.id ?? null, name: n.name.slice(0, -' Hinge'.length) });
                }
            });
            return out.length ? out : null;
        },
        // Package-shaped roots not in the live registry: a 'Package'-named / thin-wrapper
        // group holding '* Hinge' pivots — the persisted marker structure. These are
        // restored-but-unadopted boxes; enterCreatorMode adopts them instead of stacking a
        // brand-new box on top.
        findOrphanPackageRoots: (knownIds) => {
            const known = new Set(knownIds);
            const found: string[] = [];
            const scan = (n: Node): void => {
                for (const c of n.children ?? []) {
                    if (c instanceof MeshGroup3D && !known.has(c.id) &&
                        (c.name === 'Package' || (c as MeshGroup3D).thinWrapper)) {
                        let hingePanels = 0;
                        c.forEachDeep(d => {
                            if (d instanceof MeshGroup3D && typeof d.name === 'string' && d.name.endsWith(' Hinge') &&
                                (d.children ?? []).some(x => x instanceof Mesh3D)) hingePanels++;
                        });
                        if (hingePanels > 0) { found.push(c.id); continue; }   // don't descend into a package
                    }
                    scan(c);
                }
            };
            scan(sm.sceneGraph.root);
            return found;
        },
        // SELF-DESCRIBING MARKER (the Building/Foliage pattern): stamp the full persist entry
        // onto the package root's worldParams so it rides through sceneGraphJSON on the
        // documentSkipChildren thin-wrapper and is re-adoptable from the scene graph ALONE.
        stampMarker: (rootId, entry) => {
            const g = sm.sceneGraph.findNodeById(rootId);
            if (g instanceof MeshGroup3D) g.worldParams = { kind: 'packaging', entry } satisfies PackagingMarker;
        },
        // Scan the scene ROOT for package markers — mirrors building-manager.restoreFromSave's
        // getRootMeshGroups() + worldParams.kind scan. Drives PackagingManager.restoreFromSave
        // (eager re-adoption on load, independent of the scene3dJSON packaging array).
        findPackageMarkers: () => {
            const out: { rootId: string; entry: PackagingPersistEntry | null }[] = [];
            for (const g of sm.scene3d.getRootMeshGroups()) {
                const wp = g.worldParams as PackagingMarker | null;
                if (wp?.kind === 'packaging') out.push({ rootId: g.id, entry: wp.entry ?? null });
            }
            return out;
        },
        // BUG 5: delete stray top-level package pivot subtrees a LEGACY (pre-documentSkipChildren)
        // save left LOOSE at the scene root — the "loose Package, Front, Right, Back, Left"
        // symptom. A real package pivot ('<Name> Hinge' group with a panel-mesh child) ALWAYS
        // nests under its 'Package' root, so any such group sitting directly under sceneGraph.root
        // and NOT among the live packages' kept ids is unambiguously a leftover — removed here.
        pruneLoosePackageNodes: (keepIds) => {
            const keep = new Set(keepIds);
            const doomed: (MeshGroup3D | Mesh3D)[] = [];
            for (const c of [...sm.sceneGraph.root.children]) {
                // (a) a loose '<Name> Hinge' pivot group with a panel-mesh child, and
                // (b) a loose PANEL MESH — the document-restore two-deep-nesting flatten drops
                //     panel meshes (root→pkg→pivot→mesh = 3 deep) to the scene ROOT, so they show
                //     as top-level 'Base'/'Front'/… outliner items. Packaging panels are the ONLY
                //     meshes carrying `texOverBase` (createUnitRoot/createPanelMesh), so that flag
                //     is an unambiguous signature — a plain user mesh never has it.
                const isLoosePivot = c instanceof MeshGroup3D && !keep.has(c.id) &&
                    typeof c.name === 'string' && c.name.endsWith(' Hinge') &&
                    (c.children ?? []).some(x => x instanceof Mesh3D);
                const isLoosePanel = c instanceof Mesh3D && !keep.has(c.id) &&
                    (c.material as { texOverBase?: boolean } | undefined)?.texOverBase === true;
                if (isLoosePivot || isLoosePanel) doomed.push(c);
            }
            for (const n of doomed) {
                if (n instanceof MeshGroup3D) sm.scene3d.disposePackagingSubtree(n.id);
                else n.parent?.removeChild(n);
            }
            if (doomed.length) { sm.emitSceneGraphChanged(); sm.scheduleRender(); }
            return doomed.length;
        },
        // ── PACKAGE LAYER STACK hooks (Part 1/2) — ordinary tagged doc layers + the shared
        // 2D compositor machinery, scoped to the package's layers into an offscreen target
        // the panels live-texture from. See the _pkg* composite controller below.
        stack: {
            addRasterLayer: (packageId, name) =>
                sm.addRasterLayer(name, { visible: true, systemOwner: 'packaging', packageOwnerId: packageId })?.id ?? null,
            addVectorLayer: (packageId, name) => {
                const rlm = sm.rasterLayerManager;
                if (!rlm) return null;
                const id = rlm.addVectorLayer(name, { visible: true, systemOwner: 'packaging', packageOwnerId: packageId });
                sm.emitSceneGraphChanged();
                return id;
            },
            adopt: (packageId, layerId) => {
                const rlm = sm.rasterLayerManager;
                const l = rlm?.getLayerById(layerId);
                if (!rlm || !l) return;
                if (l.systemOwner !== 'packaging') rlm.setSystemOwner(layerId, 'packaging');
                rlm.setPackageOwner(layerId, packageId);
                // Once package-tagged the layer is STRUCTURALLY excluded from the artboard
                // composite, so `visible` now means STACK visibility — un-hide the legacy
                // dieline (created composite-hidden) or it would vanish from the box.
                if (!l.visible) rlm.setVisibility(layerId, true);
                sm.emitSceneGraphChanged();
            },
            info: (layerId) => {
                const l = sm.rasterLayerManager?.getLayerById(layerId);
                if (!l) return null;
                const t = l.type ?? 'layer';
                if (t === 'vector' || t === 'ephemera') return { name: l.name, visible: l.visible, opacity: l.opacity ?? 1, kind: 'vector' as const };
                if (t !== 'layer') return null;
                return { name: l.name, visible: l.visible, opacity: l.opacity ?? 1, kind: 'raster' as const };
            },
            setVisible: (layerId, visible) => { sm.rasterLayerManager?.setVisibility(layerId, visible); sm.emitSceneGraphChanged(); },
            setOpacity: (layerId, opacity) => { sm.rasterLayerManager?.setOpacity(layerId, opacity); },
            rename: (layerId, name) => { sm.rasterLayerManager?.renameLayer(layerId, name); sm.emitSceneGraphChanged(); },
            remove: (layerId) => {
                const rlm = sm.rasterLayerManager;
                if (!rlm) return false;
                const l = rlm.getLayerById(layerId);
                const ok = (l?.type === 'vector' || l?.type === 'ephemera') ? rlm.removeVectorLayer(layerId) : rlm.deleteLayer(layerId);
                sm._pkgComposite.dropVectorProxy(layerId);
                if (ok) sm.emitSceneGraphChanged();
                return ok;
            },
            linkComposite: (packageId, panelMeshIds, getStack) => sm._pkgComposite.link(packageId, panelMeshIds, getStack),
            unlinkComposite: (packageId) => sm._pkgComposite.unlink(packageId),
            recomposite: (packageId) => sm._pkgComposite.recomposite(packageId),
            exportPng: async (packageId) => {
                const entry = sm._pkgComposite.getComposite(packageId);
                if (!entry) return null;
                await sm._pkgComposite.refreshVectorProxies(packageId);   // freshest vector proxies
                sm._pkgComposite.recomposite(packageId);
                return entry.mgr.exportToBlob('image/png');
            },
        },
    
    };
}
