/**
 * DocumentStateCoordinator — the whole-document SAVE/LOAD orchestrator (audit C2 / reorg spec's
 * "DocumentStateCoordinator (LAST)"), extracted VERBATIM from ShapeManager.gatherDocumentState +
 * restoreDocumentState.
 *
 * This is deliberately a RELOCATION, not a decoupling (the recreate2DShape precedent): the
 * orchestration inherently touches every subsystem, so it reaches the facade's PUBLIC surface
 * through `sm` (a type-only import — no runtime cycle) and the facade's PRIVATE state through the
 * `priv` hooks bag that ShapeManager wires with closures. The value is isolation: ~620 lines of
 * restore-critical sequencing in one named module, unit-addressable, and the place where the
 * planned async-restore work (time-slicing restoreProceduralFromSave3D) can land without touching
 * the god-object.
 *
 * ORDERING IS LOAD-BEARING throughout restore(): scene graph → layers → animation → 3D nodes →
 * texture library → mesh textures → face/clothing/hair/attachment rigs → ephemera → GARP →
 * procedural regen → pending proc textures. Comments inline explain each dependency.
 */

import type ShapeManager from '../shape-manager';
import type { DocumentSavePayload, DocumentManifest } from './document-persistence';
import type { PixelFormat } from './pixel-codec';
import type { SceneGraph } from '../../scene-graph/core/scene-graph';
import type { WebGPURenderer } from '../../renderer/core/webgpu-renderer';
import type { RasterLayerManager } from '../raster-layer-manager';
import type { EphemeraService } from '../ephemera/ephemera-service';
import type { GarpManager } from '../managers/garp-manager';
import type { PackagingManager } from '../../packaging/packaging-manager';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D } from '../../scene-graph/shapes/array-group-3d';

/** The facade-PRIVATE state the orchestration needs — wired by ShapeManager with closures/refs. */
export interface DocumentStatePrivate {
    getSceneGraph(): SceneGraph;
    getWebgpuRenderer(): WebGPURenderer;
    getRasterLayerManager(): RasterLayerManager | undefined;
    scheduleRender(): void;
    syncRendererFrame(): void;
    /** Shared UV-paint texture registry (uv paint + decals + procedural restore all write it). */
    uvPaintTextures: Map<string, RasterTextureManager>;
    /** `__proc__:`-keyed textures parked until procedural regen recreates their meshes. */
    pendingProcTextures: Map<string, ArrayBuffer>;
    ephemera: EphemeraService;
    garp: GarpManager;
    /** The packaging manager ONLY if already created — the public getter lazily constructs it,
     *  which a routine save must never trigger. */
    packagingIfCreated(): PackagingManager | undefined;
    /** Reset the decal registry on document load — stale in-session records block marker re-adoption. */
    clearDecalRecords(): void;
    procMeshKey(meshId: string): string | null;
    buildMeshState(m: Mesh3D): unknown;
    disposeAllUvPaintTextures(): void;
    restoreClothingTextures(blobs: Map<string, ArrayBuffer>): Promise<void>;
    restoreProceduralMeshTextures(map: Map<string, ArrayBuffer>): Promise<void>;
    backfillUnassignedVectorLayers(): void;
    /** Suppresses intermediate scene-graph-changed events during restore. */
    setRestoring(v: boolean): void;
    getDocumentSizePx(): { w: number; h: number } | null;
    getDocIdentity(): { id: string; name: string };
    getPixelFormat(): PixelFormat;
    upgradePixelFormatToPng(): void;
}

export class DocumentStateCoordinator {
    constructor(
        private readonly sm: ShapeManager,
        private readonly priv: DocumentStatePrivate,
    ) {}

    /** Shorthand — the original methods read `this.rasterLayerManager` (optional) pervasively. */
    private get rlm(): RasterLayerManager | undefined { return this.priv.getRasterLayerManager(); }

    async gather(forceAll3D = false): Promise<DocumentSavePayload> {
        const canvasSize = this.rlm?.getCanvasSize() ?? { w: 1920, h: 1080 };
        const layerMeta = this.rlm?.getLayerMetadata() ?? [];

        // Gather animation state
        let animationState = null;
        const timeline = this.rlm?.getTimeline();
        if (timeline && this.rlm?.isAnimationEnabled()) {
            const ts = timeline.getState();
            const onion = timeline.getOnionSkinConfig();
            const cels: Record<string, Array<{ celId: string; startFrame: number; duration: number; celType: 'key' | 'inbetween' }>> = {};
            for (const layer of layerMeta) {
                if (layer.animationType === 'animated') {
                    const layerCels = this.rlm!.getCels(layer.id);
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
            docId: this.priv.getDocIdentity().id,
            name: this.priv.getDocIdentity().name,
            createdAt: new Date().toISOString(),
            savedAt: new Date().toISOString(),
            canvasWidth: canvasSize.w,
            canvasHeight: canvasSize.h,
            documentSize: this.priv.getDocumentSizePx() ?? null,
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
                systemOwner: l.systemOwner,
                packageOwnerId: l.packageOwnerId,
            })),
            animation: animationState,
            globalDitherConfig: this.sm.getDitherConfig(),
            canvasGrid: {
                visible: this.priv.getWebgpuRenderer().getCanvasGridVisible(),
                color:   this.priv.getWebgpuRenderer().getCanvasGridColor(),
                opacity: this.priv.getWebgpuRenderer().getCanvasGridOpacity(),
                cells:   this.priv.getWebgpuRenderer().getCanvasGridCells(),
            },
            pixelFormat: this.priv.getPixelFormat(),
        };

        // Read pixel data
        const layers = await this.rlm?.exportLayerPixels() ?? [];
        const cels = await this.rlm?.exportCelPixels() ?? [];

        // Gather 3D mesh states — gated on dirty to avoid serializing geometry on every stroke save.
        // packProject() passes forceAll3D=true to always include the full snapshot.
        let scene3dJSON: string | null = null;
        const models3d: Record<string, ArrayBuffer> = {};
        let textureLibrary: { entries: any[] } | null = null;
        let _onWriteComplete: (() => void) | undefined;

        const dirtyMeshIds = this.sm.getDirtyMeshIds3D();
        const has3DChanges = forceAll3D || dirtyMeshIds.length > 0;

        if (this.sm.scene3d) {
            // Global scene settings are always serialized — they're tiny and changes
            // to fog/lighting/etc. don't flip the mesh dirty flag.
            const globalScene = this.sm.scene3d.getGlobalScene3DSettings();
            const faceRigs = this.sm.scene3d.serializeFaceRigs();         // anime face/eye expression metadata
            const clothingRigs = this.sm.scene3d.serializeClothingRigs(); // procedural garment params (regenerate on load)
            const hairRigs = this.sm.scene3d.serializeHairRigs();         // procedural hair params (regenerate on load)
            const bodyParams = this.sm.scene3d.serializeBodyParams();     // procedural body params (re-seed the sliders on load)
            const attachments = this.sm.scene3d.serializeAttachments();   // charms/accessories (placement + params; regenerate on load)
            const bakedPartMetas = this.sm.scene3d.serializeBakedParts(); // baked kitbash part metadata (bytes ride in `bakedParts`)
            // ALWAYS serialize nodes + skeletons (+ the light rigs / globalScene) so an incremental save can NEVER
            // drop the 3D scene. The bug: when no 3D mesh was dirty (has3DChanges=false), scene3dJSON was rewritten
            // WITHOUT nodes/skeletons → the body + skeleton (and thus all overlays) were wiped on the next load
            // ("everything gone" after a 2D-only autosave). Only the HEAVY parts (GLB model buffers + texture
            // library) stay gated on dirty — node JSON is light + the debounced save makes this cheap.
            // Params-regenerated content (packages, city) lives under thinWrapper/documentSkipChildren
            // containers and is rebuilt from its marker on load — serializing those meshes here made the
            // 3D restore pass recreate them LOOSE at the scene root (P6 round-trip drive, 2026-09-15).
            const underSkipWrapper = (m: { parent: unknown }): boolean => {
                for (let a = m.parent as { parent?: unknown; documentSkipChildren?: boolean; thinWrapper?: boolean } | null; a; a = a.parent as typeof a) {
                    if (a.documentSkipChildren || a.thinWrapper) return true;
                }
                return false;
            };
            const nodes = this.sm.scene3d.getAllMeshes().filter(m => !m.isFaceDecal && !m.isHair && !m.isClothing && !m.isAttachment && !m.excludeFromDocument && !underSkipWrapper(m)).map(m => this.priv.buildMeshState(m));
            const skeletons = this.sm.scene3d.getAllSkeletons().map(s => this.sm.scene3d!.serializeSkeletonForSave(s));
            // Round floats to 6 decimals as we serialize — skeleton inverse-bind matrices + rotations carry ~15
            // digits of noise ("0.916000000012") that bloat the JSON and gzip poorly. 6 decimals is visually
            // lossless for matrices/quaternions/positions. Guard ≥1e9 (timestamps etc.) so *1e6 can't overflow 2^53.
            const round6 = (_k: string, v: any) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9) ? Math.round(v * 1e6) / 1e6 : v;
            // Packaging registry (params-only, like characters/buildings): the box NODES persist via
            // the scene graph; this re-binds them to the PackagingManager on load (restoreFromJSON) so
            // a reloaded document's packages are editable again instead of orphaned (and enterCreatorMode
            // can't stack a duplicate box on top of a restored one).
            const packaging = this.priv.packagingIfCreated()?.serialize() ?? [];
            scene3dJSON = JSON.stringify({ nodes, skeletons, globalScene, faceRigs, clothingRigs, hairRigs, bodyParams, attachments, bakedPartMetas, ...(packaging.length ? { packaging } : {}) }, round6);
            if (has3DChanges) {
                for (const [id, buf] of this.sm.scene3d.getModelStore().entries()) models3d[id] = buf;
                textureLibrary = this.sm.scene3d.getTextureLibraryData() ?? null;
                _onWriteComplete = () => this.sm.clearDirtyMeshState3D();
            }
        }

        // UV-painted mesh textures → PNG bytes keyed by mesh ID (from the UV paint tool).
        const meshTextures: Record<string, ArrayBuffer> = {};
        for (const [meshId, mgr] of this.priv.uvPaintTextures) {
            if (this.sm.scene3d?.getMesh(meshId)?.isFaceDecal) continue;   // decal texture persists via the face path
            if (!mgr.getTexture()) continue;
            // A garment's mesh id changes every regenerate, so key its paint by the STABLE rig key
            // (`__cloth__:bodyId:slot`) and re-apply it after the garment rebuilds on load (like faces). A
            // PROCEDURAL prop child (creator object — regenerated from a worldParams marker) has the same problem:
            // key it by (container id, child name) via `__proc__:` and re-apply after the prop regenerates on load.
            const clothKey = this.sm.scene3d?.clothingRigKeyForMesh(meshId) ?? null;
            const procKey = clothKey ? null : this.priv.procMeshKey(meshId);
            const key = clothKey ? `__cloth__:${clothKey}` : procKey ? `__proc__:${procKey}` : meshId;
            try {
                const blob = await mgr.exportToBlob('image/png');
                if (blob.size > 0) meshTextures[key] = await blob.arrayBuffer();
            } catch (e) { console.warn('[UVPaint] export texture failed for', meshId, e); }
        }
        // Anime face expression textures → PNG, keyed `__face__:${bodyMeshId}:${exprId}` (rides in meshTextures).
        // PROCEDURAL expressions (eye params) regenerate from params on load (restoreFaceRigs), so skip their PNG —
        // a 1024² face PNG is a big chunk of a character's save. Only hand-authored face textures need to persist.
        for (const { key, mgr, procedural } of this.sm.scene3d?.getFaceTextureExports() ?? []) {
            if (procedural) continue;
            if (!mgr.getTexture()) continue;
            try {
                const blob = await mgr.exportToBlob('image/png');
                if (blob.size > 0) meshTextures[`__face__:${key}`] = await blob.arrayBuffer();
            } catch (e) { console.warn('[Face] export texture failed for', key, e); }
        }

        // Baked kitbash parts (generated garments/hair) → GLB bytes keyed by part id, so they survive reload.
        const bakedParts = this.sm.scene3d ? await this.sm.scene3d.getBakedPartBuffers() : {};

        return {
            manifest,
            sceneGraphJSON: this.sm.getSceneGraphJSONForDocument(),   // 3D-mesh geometry stripped (lives in scene3dJSON) — was duplicating ~MBs/character
            brushPresetsJSON: this.sm.exportAllBrushPresets(),
            layers,
            cels,
            scene3dJSON,
            models3d,
            meshTextures,
            bakedParts,
            textureLibrary,
            ephemeraJSON: this.priv.ephemera ? this.priv.ephemera.serialize() : null,
            // GARP pools + skin sources (user-authored variants MUST survive reload). Sources are DecalSources
            // (ephemera params / image dataUrls) → already JSON-serializable; layers are session-local (not saved).
            garpJSON: this.priv.garp.listPools().length ? this.priv.garp.serialize() : null,
            // UI System layers (state machine + shape interactions). Null when the doc has none.
            uiLayersJSON: this.sm.ui.listUILayers().length ? JSON.stringify(this.sm.ui.serialize()) : null,
            _onWriteComplete,
        };
    }

    async restore(payload: DocumentSavePayload): Promise<void> {
        // Suppress intermediate scene-graph-changed events during restore.
        // We'll emit a single event at the end when everything is ready.
        this.priv.setRestoring(true);
        const _loadT0 = performance.now();
        let _loadMark = _loadT0;
        // Phase timer for the load timeline — logs how long each restore phase took (the overlay stays up the
        // whole time, so the sum ≈ how long the loading screen is shown; see docs/specs/pipeline-warmup.md load trace).
        const _lap = (label: string) => { const now = performance.now(); console.log(`[Salsa][load] ${label}: +${Math.round(now - _loadMark)}ms (${Math.round(now - _loadT0)}ms total)`); _loadMark = now; };
        console.log('[Salsa][load] restoreDocumentState START');

        try {
            // Free the OUTGOING document's painted/uploaded uv-paint textures before loading the new one — this is a
            // full document replacement, and the new doc's meshTextures are recreated below (B1/B2, eval 2026-09-02).
            this.priv.disposeAllUvPaintTextures();
            // Same full-replacement rule for the packaging + decal registries: stale in-session
            // entries block marker re-adoption (P6 round-trip drive, 2026-09-15 — the reloaded
            // package stayed dead; the reloaded attached decal never rebuilt its quad).
            this.priv.packagingIfCreated()?.clearForDocumentLoad();
            this.priv.clearDecalRecords();
            // 1. Restore scene graph (vector shapes)
            if (payload.sceneGraphJSON) {
                await this.sm.setSceneGraphJSON(payload.sceneGraphJSON);
            }
            _lap('scene-graph (2D/vector) restore');

            // 2. Restore brush presets
            if (payload.brushPresetsJSON) {
                try {
                    this.sm.importBrushPresets(payload.brushPresetsJSON);
                } catch (e) {
                    console.warn('[ShapeManager] Failed to restore brush presets:', e);
                }
            }

            // 2b. Restore UI System layers (state machines + shape interactions). Shapes are back (step 1), so the
            // per-shape interaction props re-attach by id; the runtime re-enters its initial state.
            if (payload.uiLayersJSON) {
                try {
                    this.sm.ui.restore(JSON.parse(payload.uiLayersJSON));
                } catch (e) {
                    console.warn('[ShapeManager] Failed to restore UI layers:', e);
                }
            }

        // 3. Restore document size / illustration mode before touching any textures.
        // This ensures the renderer and rasterLayerManager agree on pixel dimensions
        // before layers are created, so that a subsequent setDocumentSize() call from
        // the host app (e.g. reading URL params) hits the same size and is idempotent.
        if (payload.manifest.documentSize) {
            this.sm.setDocumentSize(payload.manifest.documentSize.w, payload.manifest.documentSize.h);
        } else {
            // Older saves or infinite-canvas docs: clear any bounded mode.
            this.sm.clearDocumentSize();
        }

        // 4. Recreate raster layers from manifest, then upload pixel data
        if (this.rlm && payload.manifest.layers.length > 0) {
            // canvasWidth/canvasHeight records the actual pixel dimensions of the saved layer
            // data and may differ from documentSize (e.g. if the host resized the canvas while
            // in illustration mode, causing layers to be downscaled before save).
            // We must resize layers to the saved pixel dimensions BEFORE creating/uploading so
            // that uploadPixelsToLayer uses the correct bytesPerRow — otherwise a stride mismatch
            // causes the "bottom empty, top cut off" visual artifact.
            const savedW = payload.manifest.canvasWidth;
            const savedH = payload.manifest.canvasHeight;
            if (savedW && savedH) {
                this.rlm.setSize(savedW, savedH);
            }

            // Clear existing layers (e.g. the default "Background" layer)
            console.log('[Salsa restore] Clearing layers. Before clear:', this.rlm.getLayers().length);
            this.rlm.clearAllLayers();
            console.log('[Salsa restore] After clear:', this.rlm.getLayers().length);

            // Recreate each layer with its saved ID and metadata
            for (const entry of payload.manifest.layers) {
                if (entry.type === '3d-scene') {
                    this.rlm.add3DDividerWithId(entry.id, entry.name);
                } else if (entry.type === 'vector' || entry.type === 'ephemera') {
                    this.rlm.addVectorLayerWithId(entry.id, entry.name, {
                        visible: entry.visible,
                        systemOwner: entry.systemOwner,
                        packageOwnerId: entry.packageOwnerId,
                    });
                } else {
                    this.rlm.addLayerWithId(entry.id, entry.name, {
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
                        systemOwner: entry.systemOwner,
                        packageOwnerId: entry.packageOwnerId,
                    });
                }
            }
            console.log('[Salsa restore] After adding all layers:', this.rlm.getLayers().length, this.rlm.getLayers().map(l => l.name));

            // Upload pixel data to the recreated layers
            for (const layerData of payload.layers) {
                const ok = this.rlm.uploadPixelsToLayer(layerData.id, layerData.pixelData);
                console.log('[Salsa restore] Upload pixels for', layerData.id, '→', ok ? 'OK' : 'FAILED (layer not found)');
            }

            // After uploading at savedW×savedH, normalize layer textures back to documentSize
            // if they differ. This keeps rasterLayerManager.width/height in sync with
            // _documentSizePx so that the next save's canvasWidth/canvasHeight is correct.
            // ensureTexture copies existing content to the top-left of the new texture.
            const ds = payload.manifest.documentSize;
            if (ds && savedW && savedH && (ds.w !== savedW || ds.h !== savedH)) {
                this.rlm.setSize(ds.w, ds.h);
            }

            // Default-select the highest raster or 3D-scene layer. Layer order is
            // bottom→top (index 0 = Background), so scan from the top of the stack.
            // Folder / vector / ephemera / reference layers are skipped; fall back
            // to the first layer if nothing qualifies.
            if (payload.manifest.layers.length > 0) {
                const top = [...payload.manifest.layers].reverse()
                    .find(l => (l.type ?? 'layer') === 'layer' || l.type === '3d-scene');
                this.rlm.selectLayer((top ?? payload.manifest.layers[0]).id);
            }
        } else {
            console.warn('[Salsa restore] Skipped layer restore. rasterLayerManager:', !!this.rlm, 'manifest layers:', payload.manifest.layers.length);
        }

        // Backfill legacy UNASSIGNED vector shapes onto the default vector layer (layers now exist). They were saved
        // with no layerId → always-selectable; tie them to a layer so they gate by layer selection like ephemera.
        // One-time migration per document — persists on the next save. Shapes with a restored layerId are untouched.
        this.priv.backfillUnassignedVectorLayers();

        // 4. Restore animation state
        if (payload.manifest.animation && this.rlm) {
            const anim = payload.manifest.animation;
            this.sm.setAnimationEnabled(true);
            this.sm.setFps(anim.fps);
            this.sm.setFrameCount(anim.frameCount);
            this.sm.setLoopMode(anim.loopMode as any);
            this.sm.setOnionSkin(anim.onionSkin);

            // Mark layers as animated and restore cel metadata with exact IDs/timing
            for (const layerEntry of payload.manifest.layers) {
                if (layerEntry.animationType === 'animated') {
                    this.sm.setLayerAnimated(layerEntry.id, true);

                    // Restore cels with saved IDs and timing
                    const celMetas = anim.cels?.[layerEntry.id];
                    if (celMetas && celMetas.length > 0) {
                        this.rlm.restoreLayerCels(layerEntry.id, celMetas);
                    }
                }
            }

            // Upload cel pixel data
            if (payload.cels && payload.cels.length > 0) {
                for (const celData of payload.cels) {
                    // Find which layer owns this cel
                    for (const [layerId, celArr] of Object.entries(anim.cels)) {
                        if (celArr.some(c => c.celId === celData.celId)) {
                            const ok = this.rlm.uploadPixelsToCel(layerId, celData.celId, celData.pixelData);
                            console.log('[Salsa restore] Upload cel pixels', celData.celId, '→', ok ? 'OK' : 'FAILED');
                            break;
                        }
                    }
                }
            }

            // Restore play range (must happen AFTER setFrameCount)
            if (anim.playRangeStart != null && anim.playRangeEnd != null) {
                this.rlm.getTimeline().setPlayRange(anim.playRangeStart, anim.playRangeEnd);
            } else {
                // Default: play entire timeline
                this.rlm.getTimeline().setPlayRange(1, anim.frameCount);
            }

            // Force texture swap for animated layers now that all cels are uploaded.
            // Without this, animated layers show blank textures until the first frame change.
            this.rlm.forceFrameSync();
        }

        // 5. Restore global dither config
        if (payload.manifest.globalDitherConfig) {
            this.sm.setDitherConfig(payload.manifest.globalDitherConfig);
        }

        // 5b. Restore the visible 2D canvas grid (per-illustration).
        const cg = payload.manifest.canvasGrid;
        if (cg) {
            this.priv.getWebgpuRenderer().setCanvasGridColor(cg.color[0], cg.color[1], cg.color[2]);
            this.priv.getWebgpuRenderer().setCanvasGridOpacity(cg.opacity);
            this.priv.getWebgpuRenderer().setCanvasGridCells(cg.cells);
            this.priv.getWebgpuRenderer().setCanvasGridVisible(cg.visible);
        }

        // 6. Restore 3D mesh nodes, then re-upload texture library and bind to meshes
        let faceRigStates: any[] = [];       // anime face/eye rigs — rebuilt after meshTextures (needs the eye PNGs)
        let clothingRigStates: any[] = [];   // procedural garments — rebuilt from params after the body/skeleton load
        let hairRigStates: any[] = [];       // procedural hair — rebuilt from params after the body/skeleton load
        let bodyParamStates: any[] = [];     // procedural body params — repopulate the map so live edits merge
        let attachmentStates: any[] = [];    // charms/accessories — rebuilt from placement + params after the body load
        let bakedPartMetaStates: any[] = []; // baked kitbash part metadata — re-register with bytes from payload.bakedParts
        if (payload.scene3dJSON && this.sm.scene3d) {
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
                    this.sm.scene3d.restoreGlobalScene3DSettings(parsed.globalScene);
                }

                // Capture MeshGroup3D hierarchy before clearing child meshes.
                // setSceneGraphJSON (step 1) already restored groups with preserved IDs.
                // After the clear below, groups stay but their children are gone; we use
                // this map to re-add each restored mesh to its original group.
                const childToGroup = new Map<string, MeshGroup3D>();
                for (const node of this.priv.getSceneGraph().root.children) {
                    if (node instanceof MeshGroup3D) {
                        for (const child of node.children) {
                            childToGroup.set((child as any).id, node as MeshGroup3D);
                        }
                    }
                }

                // Preserve ATTACHED DECAL CONTAINERS through the mesh wipe below: the sceneGraph
                // pass restored them as children of their target mesh, but this 3D pass rebuilds
                // every mesh from its own state — the container subtree went down with the old
                // mesh, so attached decals never survived a real reload (P6 round-trip drive,
                // 2026-09-15). Stash by parent-mesh id, re-attach after the rebuild; the marker's
                // quad regenerates later in restoreDecalsFromSave3D.
                const attachedDecalContainers: Array<{ meshId: string; container: MeshGroup3D }> = [];
                this.priv.getSceneGraph().root.forEachDeep((n: any) => {
                    if (n instanceof MeshGroup3D && (n.worldParams as { kind?: string } | null)?.kind === 'decal'
                        && n.parent instanceof Mesh3D) {
                        attachedDecalContainers.push({ meshId: (n.parent as Mesh3D).id, container: n });
                    }
                });
                for (const { container } of attachedDecalContainers) container.parent?.removeChild(container);

                // Clear existing 3D skeletons and meshes first
                for (const s of this.sm.scene3d.getAllSkeletons()) s.parent?.removeChild(s);
                for (const m of this.sm.scene3d.getAllMeshes())    m.parent?.removeChild(m);

                // Restore skeletons before meshes so re-link can find them.
                for (const skelState of skeletons) {
                    this.sm.scene3d.restoreSkeletonState(skelState);
                }
                for (const state of nodes) {
                    const glbBuf = state.glbMeshId ? payload.models3d?.[state.glbMeshId] : undefined;
                    await this.sm.scene3d.restoreMeshState(state, glbBuf);
                }
                // Re-link SkinnedMesh3D.skeleton references by matching skeletonId.
                this.sm.scene3d.relinkSkinnedMeshSkeletons();
                // Default idle/personality clips + poses are stripped from procedural-body skeletons on save
                // (identical across characters) — re-install here, idempotent by name (edits/additions were kept).
                for (const s of this.sm.scene3d.getAllSkeletons()) if (s.isProceduralBody) this.sm.scene3d.installDefaultAnimations(s.id);

                // Re-populate MeshGroup3D containers with the freshly restored meshes.
                // restoreMeshState preserves the serialized mesh ID, so childToGroup lookups work.
                for (const mesh of this.sm.scene3d.getAllMeshes()) {
                    const group = childToGroup.get(mesh.id);
                    if (group) {
                        mesh.parent?.removeChild(mesh);
                        group.addChild(mesh);
                    }
                }

                // Re-attach the stashed decal containers onto the rebuilt target meshes (world
                // anchor as the fallback if a target didn't survive) — see the stash above.
                for (const { meshId, container } of attachedDecalContainers) {
                    const target = this.sm.scene3d.getMesh(meshId);
                    (target ?? this.priv.getSceneGraph().root).addChild(container);
                }

                // Ensure GPU instance sync callback is active for any restored ArrayGroup3D nodes.
                if (this.priv.getSceneGraph().root.children.some(c => c instanceof ArrayGroup3D)) {
                    this.sm.scene3d.registerRestoredArrayGroups();
                }

                // RE-ADOPT persisted packages (params-only pattern): rebuild the packaging registry
                // against the restored nodes, repair panel-mesh parenting (the childToGroup pass above
                // maps only ONE nesting level — package panel meshes sit two deep, under hinge pivots),
                // re-assert geometry/fold from params, and re-link the dieline layer. After this,
                // isPackageNode/getAll/enterCreatorMode all work on restored packages — no duplicate box.
                if (!Array.isArray(parsed) && Array.isArray(parsed.packaging) && parsed.packaging.length) {
                    try {
                        const adopted = this.sm.packaging?.restoreFromJSON(parsed.packaging) ?? 0;
                        if (adopted > 0) console.log(`[Packaging] re-adopted ${adopted} package(s) from the saved document`);
                    } catch (e) {
                        console.warn('[Packaging] package re-adoption failed:', e);
                    }
                }
            } catch (e) {
                console.warn('[ShapeManager] Failed to restore 3D scene:', e);
            }
        }
        // Texture library must be restored AFTER meshes exist so the
        // restoreTextureLibraryData loop can find them via getAllMeshes().
        if (payload.textureLibrary && this.sm.scene3d) {
            try {
                await this.sm.scene3d.restoreTextureLibraryData(payload.textureLibrary);
            } catch (e) {
                console.warn('[ShapeManager] Failed to restore texture library:', e);
            }
        }

        // Restore UV-painted mesh textures onto their meshes. After the texture
        // library so a painted texture wins for any mesh the user painted.
        const faceBlobs = new Map<string, ArrayBuffer>();
        const clothBlobs = new Map<string, ArrayBuffer>();   // key = `${bodyId}:${slot}`; applied after garments rebuild
        this.priv.pendingProcTextures.clear();                    // key = `${containerId}:${childName}`; applied after procedural regen
        if (payload.meshTextures && this.sm.scene3d) {
            const device = this.priv.getWebgpuRenderer().getDevice();
            for (const [meshId, buf] of Object.entries(payload.meshTextures)) {
                if (meshId.startsWith('__face__:'))  { faceBlobs.set(meshId.slice('__face__:'.length), buf); continue; }
                if (meshId.startsWith('__cloth__:')) { clothBlobs.set(meshId.slice('__cloth__:'.length), buf); continue; }
                if (meshId.startsWith('__proc__:'))  { this.priv.pendingProcTextures.set(meshId.slice('__proc__:'.length), buf); continue; }
                const mesh = this.sm.scene3d.getMesh(meshId);
                if (!mesh || !device || !buf.byteLength) continue;
                try {
                    const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
                    let mgr = this.priv.uvPaintTextures.get(meshId);
                    if (!mgr) { mgr = new RasterTextureManager(device); this.priv.uvPaintTextures.set(meshId, mgr); }
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
        if (faceRigStates.length && this.sm.scene3d) {
            try { await this.sm.scene3d.restoreFaceRigs(faceRigStates, faceBlobs); }
            catch (e) { console.warn('[Face] restore rigs failed', e); }
        }

        // Rebuild procedural garments from their params — bodies + skeletons now exist.
        if (clothingRigStates.length && this.sm.scene3d) {
            try { this.sm.scene3d.restoreClothingRigs(clothingRigStates); }
            catch (e) { console.warn('[Clothing] restore rigs failed', e); }
        }

        // Re-apply painted garment textures onto the freshly-rebuilt garments (keyed by rig, not mesh id).
        if (clothBlobs.size && this.sm.scene3d) {
            try { await this.priv.restoreClothingTextures(clothBlobs); }
            catch (e) { console.warn('[ClothPaint] restore textures failed', e); }
        }

        // Rebuild procedural hair from its params — bodies + skeletons now exist.
        if (hairRigStates.length && this.sm.scene3d) {
            try { this.sm.scene3d.restoreHairRigs(hairRigStates); }
            catch (e) { console.warn('[Hair] restore rigs failed', e); }
        }

        // Rebuild charms/accessories from their placement + params — bodies + skeletons now exist.
        if (attachmentStates.length && this.sm.scene3d) {
            try { this.sm.scene3d.restoreAttachments(attachmentStates); }
            catch (e) { console.warn('[Charm] restore attachments failed', e); }
        }

        // Repopulate procedural body params (the body geometry is already restored as a node — this just
        // lets a later live edit merge a single-field change correctly).
        if ((bakedPartMetaStates.length) && this.sm.scene3d) {
            try { this.sm.scene3d.restoreBakedParts(bakedPartMetaStates, payload.bakedParts); }
            catch (e) { console.warn('[Kitbash] restore baked parts failed', e); }
        }

        if (bodyParamStates.length && this.sm.scene3d) {
            try { this.sm.scene3d.restoreBodyParams(bodyParamStates); }
            catch (e) { console.warn('[Body] restore params failed', e); }
        }

        // Restore ephemera placements and sheets.
        if (payload.ephemeraJSON) {
            try {
                this.priv.ephemera.deserialize(payload.ephemeraJSON);
            } catch (e) {
                console.warn('[ShapeManager] Failed to restore ephemera:', e);
            }
        }

        // Restore GARP pools + skin sources BEFORE procedural regen (below) so the city's fascia resolver picks
        // over the saved runtime pool (incl. user variants). Registration is sync → layers correct this frame; the
        // async atlas rebuild fills pixels + re-renders. (Nothing serialized held a layer index — see GarpManager.)
        if (payload.garpJSON) {
            try {
                this.priv.garp.restore(payload.garpJSON as Parameters<GarpManager['restore']>[0]);
                void this.sm.rebuildGarpAtlas3D([512, 512]);
            } catch (e) {
                console.warn('[ShapeManager] Failed to restore GARP pools:', e);
            }
        }

        } finally {
            this.priv.setRestoring(false);
        }

        // A freshly loaded document starts with an EMPTY undo history: the PREVIOUS document's undo stack holds
        // closure commands capturing THAT document's (now-destroyed) meshes, so an Undo after a load would operate
        // on foreign / dead nodes (or resurrect a deleted mesh into the new doc). Clear it so the load itself isn't
        // undoable and no stale command can fire.
        this.sm.clearUndo3D();

        // Procedural content (city / buildings / foliage) persists as lightweight params-only MARKERS. The scene-graph
        // restore above recreates the marker containers (so they appear in the outliner) but NOT their geometry — so
        // without this step a reopened document shows the buildings in the outliner yet renders nothing. Regenerate
        // from the markers here, rather than relying on the host to call restoreProceduralFromSave3D() itself.
        _lap('3D meshes + raster + character overlays restore');
        if (this.sm.scene3d) {
            try {
                const restored = this.sm.restoreProceduralFromSave3D();
                if (restored.city || restored.buildings || restored.blocks || restored.foliage || restored.packaging) {
                    console.log('[Salsa loadDocument] Regenerated procedural content:', restored);
                }
            } catch (e) {
                console.warn('[ShapeManager] Failed to regenerate procedural content on load:', e);
            }
            _lap('★ procedural regen (city/buildings/props) — restoreProceduralFromSave3D');
            // Re-apply UV-paint textures onto the freshly-regenerated PROCEDURAL prop children (keyed by container +
            // child name, not the volatile mesh id) — the fix that makes painting a creator object survive reload.
            if (this.priv.pendingProcTextures.size) {
                try { await this.priv.restoreProceduralMeshTextures(this.priv.pendingProcTextures); }
                catch (e) { console.warn('[UVPaint] restore procedural textures failed:', e); }
                this.priv.pendingProcTextures.clear();
            }
        }

        // Migrate legacy documents (v2 / missing pixelFormat / 'raw') to PNG going forward.
        // The pixel data was already decoded to raw RGBA during load; upgrading the config
        // here ensures the next save encodes as PNG and writes 'png' to the manifest,
        // overriding any 'raw' value that was passed in via enableAutoSave or setPixelFormat.
        if (!payload.manifest.pixelFormat || payload.manifest.pixelFormat === 'raw') {
            this.priv.upgradePixelFormatToPng();
        }

        // P6 (editing-loop-polish.md, 2026-09-15): the later restore passes (skinned/skeleton
        // rebuild, procedural regen, decal re-place) APPEND their nodes, so root-child order
        // drifted from the saved document on every load — reshuffling the outliner and making
        // save→load→save non-idempotent. Re-assert the saved order (stable sort: nodes the save
        // didn't list keep their relative order at the end).
        try {
            if (payload.sceneGraphJSON) {
                const savedOrder: string[] = (JSON.parse(payload.sceneGraphJSON).root?.children ?? [])
                    .map((c: { id?: string }) => c.id)
                    .filter((id: string | undefined): id is string => !!id);
                const rank = new Map(savedOrder.map((id, i) => [id, i]));
                // peekId for Shapes (non-minting); plain `.id` for Node subclasses that store one
                // directly (Skeleton3D) — Shape.id would MINT, so only touch it via peekId.
                const idOf = (n: unknown) => {
                    const o = n as { peekId?(): string | undefined; id?: string };
                    return o.peekId ? o.peekId() : o.id;
                };
                this.sm.sceneGraph.root.children.sort((a, b) =>
                    (rank.get(idOf(a) ?? '') ?? Number.MAX_SAFE_INTEGER) -
                    (rank.get(idOf(b) ?? '') ?? Number.MAX_SAFE_INTEGER));
            }
        } catch { /* ordering is cosmetic — never fail a load over it */ }

        // Sync the renderer's animation frame counter so procedural effects
        // (frame link animations) render correctly on the first frame.
        this.priv.syncRendererFrame();

        // Single authoritative event — all layers, scene graph, and animation
        // state are fully restored at this point.
        _lap('final glue (textures/frame-sync)');
        console.log(`[Salsa][load] ✅ scene applied → onSceneGraphChanged.emit (overlay clears). TOTAL restore = ${Math.round(performance.now() - _loadT0)}ms`);
        this.sm.interactionService.onSceneGraphChanged.emit();
        this.priv.scheduleRender();
    }
}
