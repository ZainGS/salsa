// Audit C7 (2026-09-13): the UV/3D PAINT SESSION, extracted VERBATIM from the ShapeManager facade.
// One shared UVPaintController serves two session kinds — 'character' (garment/hair/eye-decal, keyed by
// mesh id, opens a UV editor implicitly) and 'packaging' (the box dieline layer, keyed by layer id, no
// editor). This class owns the controller + the per-mesh paint texture/canvas maps + the per-kind
// teardown state that used to be juggled across the facade. `sm` is the facade (wide host, C1 stance).
import type ShapeManager from '../shape-manager';
import { UVPaintController, UVBrushSettings } from './uv-paint-controller';
import { UVEditorSession, UVCanvasRenderer } from './uv-canvas-renderer';
import { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';

export class UVPaintSessionController {
    constructor(private readonly sm: ShapeManager) {}

    readonly canvases = new Map<string, HTMLCanvasElement>();
    /** Per-mesh GPU paint texture (paintable + sampleable) backing the mesh diffuse. */
    readonly textures = new Map<string, RasterTextureManager>();
    controller?: UVPaintController;
    /** How the eraser behaves on a GARMENT: 'burn' = paint white with the brush's grain/soft edge (the scorched
     *  border) · 'clean' = a sharp grainless white dab · 'cutout' = a real alpha HOLE (distressing/rips). */
    private _eraseStyle: 'burn' | 'clean' | 'cutout' = 'burn';
    /** Mesh whose `doubleSided` we forced off during paint, + its prior value to restore. */
    private _doubleSided: { meshId: string; prev: boolean | undefined } | null = null;
    /** Mesh whose UV editor session paint mode OPENED implicitly (no pre-existing session) —
     *  so exit closes it again. Null if a UV editor was already open before painting (leave it). */
    private _openedEditor: string | null = null;
    /** WHICH kind of paint session is live on the single shared controller (see the facade doc). */
    kind: 'character' | 'packaging' | null = null;

    ensureCanvas(meshId: string, size = 1024): HTMLCanvasElement | null {
        const node = this.sm.sceneGraph.findNodeById(meshId);
        if (!node) return null;
        let canvas = this.canvases.get(meshId);
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.width  = size;
            canvas.height = size;
            this.canvases.set(meshId, canvas);
        }
        return canvas;
    }

    /**
     * Upload the CPU paint canvas for `meshId` to a new GPUTexture and set it
     * as the mesh's diffuse texture.  Call this on pointer-up after strokes.
     */
    commitCanvasTexture(meshId: string): void {
        const node = this.sm.sceneGraph.findNodeById(meshId);
        if (!node) return;
        const canvas = this.canvases.get(meshId);
        if (!canvas) return;
        const device = this.sm.webgpuRenderer?.getDevice();
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

        const mesh = node as import('../../scene-graph/shapes/mesh-3d').Mesh3D;
        mesh.diffuseTexture   = texture;
        mesh.material.hasTexture = true;
        mesh.gpuDirty = true;
        this.sm.scheduleRender();
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
    ensureTexture(meshId: string, size = 1024): RasterTextureManager | null {
        const device = this.sm.webgpuRenderer?.getDevice();
        const mesh = this.sm.scene3d.getMesh(meshId);
        if (!device || !mesh) return null;
        let mgr = this.textures.get(meshId);
        const isNew = !mgr;
        if (!mgr) {
            mgr = new RasterTextureManager(device);
            this.textures.set(meshId, mgr);
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
            const seeded = this.sm.scene3d.seedGarmentPaintTexture(meshId, mgr);
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


    /**
     * Enter UV paint mode for `meshId`: the user brushes on the unwrapped UV in
     * `uvRenderer`'s canvas and paints the mesh texture live. Requires an open UV
     * session (`openUVEditor3D`). The controller owns pointer input on the UV
     * canvas while active — Frogmarks should pause its own UV-pane interaction.
     */
    enterCharacter(meshId: string, uvRenderer?: UVCanvasRenderer | null, opts?: UVBrushSettings): void {
        const mesh = this.sm.scene3d.getMesh(meshId);
        const device = this.sm.webgpuRenderer?.getDevice();
        if (!mesh || !device) return;
        // Fully tear down any prior session (of EITHER kind) before arming this one — the controller's own
        // enter() only clears its target, leaving this manager's per-mesh restore state (double-sided,
        // opened editor) pointing at the OLD mesh, so it would later be applied to the wrong object.
        if (this.controller?.isActive()) this.exit();
        // Ensure the mesh is editable (so the 3D-paint raycast has UVs to read) and
        // a UV session exists — even when the host never opened the UV pane (pane
        // hidden → 3D-only painting). openUVEditor3D is idempotent: it returns the
        // existing session and skips makeEditable if the mesh is already editable.
        // Track whether WE open the editor here: if no session existed before, paint
        // owns it and exit must close it (else the editable wireframe + mesh-edit
        // orbit/background linger after painting ends). If one was already open (the
        // user is UV-editing), leave it for them.
        const editorWasOpen = !!this.sm._uvSessions.get(meshId);
        const session = this.sm.openUVEditor3D(meshId);
        this._openedEditor = editorWasOpen ? null : meshId;
        const texMgr = this.ensureTexture(meshId);
        if (!texMgr) return;
        // A painted surface shares ONE texture across both sides, so a double-sided
        // mesh renders its back as the texture MIRRORED. After orbiting around to the
        // far side that reads as paint landing "on the inside". Force single-sided
        // while painting so only the outward (painted) side ever shows; restore on exit.
        this._doubleSided = { meshId, prev: mesh.material.doubleSided };
        mesh.material.doubleSided = false;
        if (!this.controller) {
            this.controller = new UVPaintController(device, () => this.sm.scheduleRender());
        }
        // uvRenderer omitted → the UV pane is hidden; the user paints only on the
        // 3D mesh (surface input below drives the same texture). With a pane, both
        // views are wired and stay in sync.
        this.controller.enter({
            mesh, texMgr, session,
            uvRenderer: uvRenderer ?? null,
            canvas: uvRenderer?.element ?? null,
        });
        // Share the 2D brush system: seed the UV engine with the current brush library,
        // then mirror the LIVE 2D brush (active preset + color + erase) onto it at the
        // start of every stroke. Reading the illustration engine's state per-stroke makes
        // this robust no matter how the shared brush panel reaches the engine (directly
        // or via sm.* APIs) — whatever it sets on the 2D engine shows up on the mesh.
        const illoEngine = this.sm.rasterDrawingService?.getPaintEngine();
        if (illoEngine) this.controller.syncBrushFrom(illoEngine);
        this.controller.beforeStroke = () => this._mirrorBrush();
        if (opts) this.controller.setBrush(opts);
        // Also paint directly on the 3D mesh: the viewport raycasts the hit to a UV
        // coord and drives the same controller, so a stroke on either view paints
        // the same texture (and both update via the controller's readback).
        this.sm.scene3d.enterSurfacePaintInput(meshId, {
            begin: (u, v, p, s) => this.controller?.strokeBeginUV(u, v, p, s),
            move:  (u, v, p, s) => this.controller?.strokeMoveUV(u, v, p, s),
            end:   () => this.controller?.strokeEndUV(),
            // Hover the mesh → ring on the UV pane at the corresponding spot.
            hover: (uv) => this.controller?.setLinkCursorUV(uv),
        });
        this.kind = 'character';
        this.sm.scheduleRender();
    }

    /** Exit UV paint mode. The painted texture stays on the mesh. */
    exit(): void {
        this.controller?.exit();   // clears the active target → activeMeshId() is null below
        this.sm.scene3d.exitSurfacePaintInput();
        // Restore the mesh's original double-sided setting.
        if (this._doubleSided) {
            const m = this.sm.scene3d.getMesh(this._doubleSided.meshId);
            if (m) m.material.doubleSided = this._doubleSided.prev;
            this._doubleSided = null;
        }
        // Close the UV editor session paint opened implicitly, so the editable WIREFRAME
        // overlay, gizmo suppression, and mesh-edit orbit/background don't linger after
        // painting ends (the bug where exiting clothing paint left the scene in edit
        // mode). Safe from re-entry: the controller is already exited above, so
        // closeUVEditor3D's "still painting this mesh?" guard is false. Null the field
        // FIRST as belt-and-suspenders. (If a UV editor was already open before paint,
        // _uvPaintOpenedEditor is null and we leave the user's session alone.)
        const opened = this._openedEditor;
        this._openedEditor = null;
        if (opened) this.sm.closeUVEditor3D(opened);
        this.kind = null;
        this.sm.scheduleRender();
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
    armPackagingSurfacePaint(meshIds: string[], layerId: string, hooks: {
        /** The whole-stack composite the box samples (packaging owns _pkgComposites). */
        readbackTexMgr: () => RasterTextureManager | null;
        /** Re-sync live-texture links before the first dab (packaging) — runs after the generic brush mirror. */
        onBeforeStroke?: () => void;
        /** Throttled stack recomposite during a stroke (packaging owns the throttle + composite). */
        onStrokeMove?: () => void;
        /** Live-texture sync + final recomposite at stroke end (packaging). */
        onStrokeEnd?: () => void;
    }): boolean {
        // The box is 6 panel meshes sharing ONE dieline layer/texture. Arm the UV paint controller on the
        // first panel as the session/texture holder; the multi-mesh raycast supplies the net UV of whichever
        // panel is hit, so a stroke lands in the correct region of the shared texture regardless of panel.
        const primary = meshIds[0];
        const mesh = primary ? this.sm.scene3d.getMesh(primary) : null;
        const device = this.sm.webgpuRenderer?.getDevice();
        const texMgr = this.sm.rasterLayerManager?.getLayerById(layerId)?.manager ?? null;
        if (!primary || !mesh || !device || !texMgr) return false;
        // Fully exit any prior session first. Without this, a live CHARACTER session's teardown state
        // leaked: `_uvPaintOpenedEditor` was overwritten with null below (dropping the character's editor
        // handle → its editable wireframe + mesh-edit orbit never close), and `_uvPaintDoubleSided` kept
        // pointing at the character mesh, so this package session's exit later restored double-sided on the
        // WRONG object. exitUVPaintMode3D is a safe no-op when nothing is active.
        if (this.controller?.isActive()) this.exit();
        if (!this.controller) {
            this.controller = new UVPaintController(device, () => this.sm.scheduleRender());
        }
        // We never open a UV editor here (would clobber net UVs), so no editor to close on exit.
        this._openedEditor = null;
        // No UV pane → the session is just a state holder (paintCursor). Reuse an open one if any, else
        // a transient one; do NOT register it in _uvSessions (keeps closeUVEditor3D/persistence untouched).
        const session = this.sm._uvSessions.get(primary) ?? new UVEditorSession(primary);
        this.controller.enter({
            mesh, texMgr, session, uvRenderer: null, canvas: null,
            // ★PART-0 ROOT FIX — re-resolve the dieline layer's MANAGER (by layer id, through the
            // LIVE RasterLayerManager) at every stroke begin. The captured `texMgr` above is
            // orphaned whenever the document-restore pipeline rebuilds the layer list under the
            // mode (clearAllLayers + addLayerWithId keeps the ID but swaps the manager object) —
            // the engine then painted an orphaned texture while the panels (LiveTextureMode
            // resolves by layer id) sampled the live one: a freshly created package never showed
            // its paint, while a package re-adopted AFTER a reload (armed post-restore) worked.
            resolveTexMgr: () => this.sm.rasterLayerManager?.getLayerById(layerId)?.manager ?? null,
            // Layer STACK (Part 1): the pane background shows the whole-stack COMPOSITE (what the box shows),
            // while strokes keep writing the ACTIVE layer's own texture. Caller-supplied (packaging owns the
            // composite) so this session code stays packaging-agnostic — the seam the Packaging extraction reuses.
            readbackTexMgr: hooks.readbackTexMgr,
        });
        // Share the live 2D brush (active preset + colour + erase) — same wiring as character paint.
        const illoEngine = this.sm.rasterDrawingService?.getPaintEngine();
        if (illoEngine) this.controller.syncBrushFrom(illoEngine);
        // beforeStroke also re-syncs the live-texture links BEFORE the first dab: the controller has
        // already re-pointed its ENGINE at the layer manager's current texture (strokeBeginUV), so
        // this makes the PANELS sample that same object for the whole stroke — stroke-end-only sync
        // left the entire first stroke after any texture reallocation writing where the box wasn't
        // looking.
        // beforeStroke = mirror the live 2D brush (generic) + the caller's pre-stroke sync (packaging: re-point the
        // box panels at the re-resolved texture for the WHOLE stroke — stroke-end-only sync left the first stroke
        // after a texture reallocation writing where the box wasn't looking).
        this.controller.beforeStroke = () => { this._mirrorBrush(); hooks.onBeforeStroke?.(); };
        // ONE stroke-end contract for BOTH input paths (pane pointer-up + 3D surface-input end both funnel through
        // strokeEndUV → this hook). The caller (packaging host adapter) owns the throttled ~30fps recomposite +
        // final recomposite + live-texture sync — it holds _pkgComposites/_pkgRecomposite. This session code stays
        // packaging-agnostic. Both reset to null on the next controller.exit() (session-scoped, no cross-kind leak).
        this.controller.onStrokeMove = hooks.onStrokeMove ?? null;
        this.controller.onStrokeEnd = hooks.onStrokeEnd ?? null;
        // Paint on the 3D box: raycast ALL panels → the hit panel's net UV → the same controller/texture.
        this.sm.scene3d.enterSurfacePaintInputMulti(meshIds, {
            begin: (u, v, p) => this.controller?.strokeBeginUV(u, v, p),
            move:  (u, v, p) => this.controller?.strokeMoveUV(u, v, p),
            end:   () => this.controller?.strokeEndUV(),   // onStrokeEnd handles the sync
        });
        this.kind = 'packaging';
        this.sm.scheduleRender();
        return true;
    }

    /** Copy the live 2D brush (active preset + color + erase) from the illustration
     *  engine onto the UV paint engine. Called at the start of every UV/mesh stroke so
     *  the shared brush panel's selection drives the dab — regardless of how the panel
     *  reaches the engine. (The UV engine is separate to keep texture/undo isolated.) */
    _mirrorBrush(): void {
        const src = this.sm.rasterDrawingService?.getPaintEngine();   // the 2D illustration engine
        const uv  = this.controller?.getEngine();
        if (!src || !uv) return;
        const erasing  = (this.sm.rasterDrawingService?.getEraseMode() ?? null) !== null;
        const activeId = this.controller?.activeMeshId();
        const activeMesh = activeId ? this.sm.scene3d.getMesh(activeId) : null;
        const isDecal  = !!activeMesh?.isFaceDecal;
        // Packaging panels blend the dieline texture OVER the kraft base (texOverBase), so like the
        // eye decal, erase = a REAL alpha-erase (strokes come off, cardboard shows through) — never
        // the garment paint-white fallback (which would leave white marks on the box).
        const isPackaging = !!activeId && !!this.sm._packaging?.isPackageNode(activeId);
        // 'cutout' (garment only) = a REAL alpha hole; 'clean' = a grainless hard white dab (no burn); 'burn'
        // (default) = white painted with the brush AS-IS (its grain + soft edge make the scorched border).
        const cleanErase  = erasing && !isDecal && this._eraseStyle === 'clean';
        const cutoutErase = erasing && !isDecal && this._eraseStyle === 'cutout';
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
        if (isDecal || isPackaging) {
            // The eye decal is a TRANSPARENT cutout surface, so erase = real alpha-erase (removes the eyes).
            // Packaging dieline: same — alpha-erase reveals the kraft base under the stroke.
            uv.setEraseMode(erasing ? (this.sm.rasterDrawingService?.getEraseMode() ?? null) : null);
            const c = this.sm.rasterDrawingService?.getBrushColor();
            if (c) uv.setBrushColor(c.r, c.g, c.b, c.a ?? 1);
        } else if (cutoutErase) {
            // CUTOUT (distressing / rips): real alpha-erase punches a HOLE. The shader discards it (alphaCutout)
            // so the body shows through. The painted garment texture is otherwise fully opaque, so enabling
            // alphaCutout is harmless for non-cut areas. The brush's soft/grain edge frays the rim.
            uv.setEraseMode(this.sm.rasterDrawingService?.getEraseMode() ?? 1);
            if (activeMesh) { activeMesh.material.alphaCutout = true; activeMesh.gpuDirty = true; }
        } else {
            // Garment 'burn' / 'clean' erase, or normal painting: never a real erase (the diffuse is opaque, so
            // a real erase would read as BLACK). Erase = paint white opaquely; paint = the brush colour.
            uv.setEraseMode(null);
            if (erasing) {
                uv.setBrushColor(1, 1, 1, 1);
            } else {
                const c = this.sm.rasterDrawingService?.getBrushColor();
                if (c) uv.setBrushColor(c.r, c.g, c.b, c.a ?? 1);
            }
        }
    }

    /** How the eraser behaves on a GARMENT in UV/3D paint: `'burn'` (default — white painted with the brush's
     *  grain/soft edge = the scorched border), `'clean'` (a sharp grainless white dab), or `'cutout'` (a real
     *  alpha HOLE — distressing / rips; the body shows through). Wire this to an erase-mode toggle in the paint UI. */
    setGarmentEraseStyle(style: 'burn' | 'clean' | 'cutout'): void { this._eraseStyle = style; }
    getGarmentEraseStyle(): 'burn' | 'clean' | 'cutout' { return this._eraseStyle; }

    /** Update the UV paint brush (color, radius in UV-pane screen px, opacity, erase). */
    setBrush(opts: UVBrushSettings): void {
        this.controller?.setBrush(opts);
    }

    /** Whether UV paint mode is active (optionally restricted to `meshId`). */
    isActive(meshId?: string): boolean {
        if (!this.controller?.isActive()) return false;
        return meshId ? this.controller.activeMeshId() === meshId : true;
    }

    /** The paint texture manager for a mesh, if any (used by persistence). */
    getTexture(meshId: string): RasterTextureManager | null {
        return this.textures.get(meshId) ?? null;
    }
}
