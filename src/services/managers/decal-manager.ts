import type { ManagerContext } from './manager-context';
import type { Scene3DManager } from './scene3d-manager';
import type { EphemeraService } from '../ephemera/ephemera-service';
import { decalQuadGeometry, decalPlacement, type DecalSource, type DecalHit, type V3 } from './decal-geometry';
import { resolveDecalBitmap } from './decal-source';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';

/** Collaborators the decal subsystem needs that don't live on {@link ManagerContext}. */
export interface DecalManagerHost {
    readonly scene3d: Scene3DManager;      // container/mesh create + pick + camera + setMeshTexture + screenToMeshUV
    readonly ephemera: EphemeraService;    // for the shared resolveDecalBitmap
    /** The SHARED per-mesh paint-texture map (owned by the facade — UV-paint + procedural restore also write it).
     *  Mode-B decal stamps reuse it so decals stack on existing paint. */
    readonly uvPaintTextures: Map<string, RasterTextureManager>;
}

/**
 * DECALS Mode A — floating textured quads laid on a 3D surface + the interactive place-tool. A decal is a
 * thin-wrapper container whose quad child carries the placement transform (see decal-geometry). Extracted from
 * ShapeManager. Takes {@link ManagerContext} + a narrow {@link DecalManagerHost}. Method bodies are the originals
 * verbatim, reached through the getters/bridges below. Mode B (stamp-into-texture) lives here too — it reuses the
 * SHARED `uvPaintTextures` map (host-supplied, facade-owned). `cityMetresPerUnit` (city helper) and the shared
 * `_resolveDecalBitmap` impl (used by GARP + Mode-B baking) stay in the facade.
 */
export class DecalManager {
    constructor(private readonly ctx: ManagerContext, private readonly host: DecalManagerHost) {}

    // ── Bridges so the moved method bodies stay byte-for-byte identical ─
    private get scene3d(): Scene3DManager { return this.host.scene3d; }
    private get sceneGraph() { return this.ctx.sceneGraph; }
    private get interactionService() { return this.ctx.interactionService; }
    private get webgpuRenderer() { return this.ctx.webgpuRenderer; }
    private get renderer3D() { return this.ctx.webgpuRenderer.getRenderer3D(); }
    private scheduleRender(): void { this.ctx.scheduleRender(); }
    private emitSceneGraphChanged(): void { this.ctx.emitSceneGraphChanged(); }
    private setMeshTexture3D(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> { return this.scene3d.setMeshTexture(nodeId, source); }
    private _resolveDecalBitmap(source: DecalSource): Promise<ImageBitmap | null> { return resolveDecalBitmap(source, this.host.ephemera); }
    private get _uvPaintTextures(): Map<string, RasterTextureManager> { return this.host.uvPaintTextures; }   // shared, facade-owned

    private _decals = new Map<string, { source: DecalSource; size: number; aspect: number; rotation: number; hit: DecalHit; quadId: string }>();
    private _decalCounter = 0;
    // Decal tool state. `targetMeshId` is the mesh the tool locked onto with the last click — hover only
    // raycasts THAT mesh (cheap), never the whole city per move (which was the hover lag).
    private _decalPlace: { source: DecalSource; size: number; rotation: number; ghostId: string; aspect: number; targetMeshId: string | null } | null = null;
    private _decalPlaceCleanup: (() => void) | null = null;

    /** Decal size in WORLD UNITS. If `metresPerUnit` is given, `size` is treated as METRES and converted (a
     *  city wall is ~15 m/unit, so a 2 m poster = ~0.13 units) — this is how a host panel labelled "Size (m)"
     *  should pass it. Otherwise `size` is world units directly (default 0.2 ≈ a small poster in the city). */
    private _decalWorldSize(opts: { size?: number; metresPerUnit?: number }): number {
        if (opts.metresPerUnit && opts.metresPerUnit > 0) return (opts.size ?? 1.5) / opts.metresPerUnit;
        return opts.size ?? 0.2;
    }

    /** Place a decal from a resolved surface hit (world hitPoint + face normal). Returns the container id. */
    public placeDecal3D(source: DecalSource, hit: DecalHit, opts: { size?: number; rotation?: number; metresPerUnit?: number } = {}): string {
        const size = this._decalWorldSize(opts), rotation = opts.rotation ?? 0;
        const container = this.scene3d.createCityContainer(`Decal ${++this._decalCounter}`);
        container.thinWrapper = true; container.documentSkipChildren = true;
        const quad = this._makeDecalQuad();
        quad.excludeFromDocument = true;   // regenerated from the marker on load
        container.addChild(quad);
        const rec = { source, size, aspect: 1, rotation, hit, quadId: quad.id };
        this._decals.set(container.id, rec);
        this._applyDecalTransform(container.id);
        this.emitSceneGraphChanged();
        this.scheduleRender();
        void this._applyDecalTexture(container.id);
        return container.id;
    }

    /** Convenience: raycast a screen point (incl. decoration) and place a decal on the surface under it. */
    public placeDecalAtScreen3D(source: DecalSource, clientX: number, clientY: number, rect: DOMRect, opts: { size?: number; rotation?: number; metresPerUnit?: number } = {}): string | null {
        const hit = this.scene3d.pickFromClient3D(clientX, clientY, rect, true);
        if (!hit) return null;
        return this.placeDecal3D(source, this._decalHitToward(hit.hitPoint, hit.faceNormal), opts);
    }

    /** Orient a picked hit's normal toward the CAMERA. The picker returns the raw geometric triangle normal
     *  (winding-dependent), which on many surfaces points INTO the object — a decal built from it lands
     *  behind the wall, facing away (visible only from behind). A decal always goes on the side you clicked
     *  from, so flip the normal if it points away from the camera. */
    private _decalHitToward(hitPoint: V3, faceNormal: V3): DecalHit {
        const c = this.scene3d.getCamera().position;
        const dot = faceNormal[0] * (hitPoint[0] - c[0]) + faceNormal[1] * (hitPoint[1] - c[1]) + faceNormal[2] * (hitPoint[2] - c[2]);
        const n: V3 = dot > 0 ? [-faceNormal[0], -faceNormal[1], -faceNormal[2]] : faceNormal;
        return { hitPoint, faceNormal: n };
    }

    /** Enter the Decal TOOL (docs/ui/decals.md). ★ SELECT-then-place, to avoid a full-city raycast on every
     *  hover: a left-click picks the object under the cursor (one full pick) AND places a decal there; after
     *  that, hovering shows a live ghost by raycasting ONLY that locked mesh (cheap). Alt-drag still orbits. */
    public enterDecalPlaceMode3D(source: DecalSource, opts: { size?: number; rotation?: number; metresPerUnit?: number } = {}): boolean {
        this.exitDecalPlaceMode3D();
        const canvas = this.webgpuRenderer?.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return false;
        const ghost = this._makeDecalQuad(true);   // translucent, non-pickable
        ghost.name = 'Decal Ghost'; ghost.pickable = false; ghost.excludeFromDocument = true; ghost.frameExclude = true; ghost.visible = false;
        this.sceneGraph.root.addChild(ghost);
        this._decalPlace = { source, size: this._decalWorldSize(opts), rotation: opts.rotation ?? 0, ghostId: ghost.id, aspect: 1, targetMeshId: null };
        this.emitSceneGraphChanged();
        void this._resolveDecalBitmap(source).then((bmp) => {
            if (!bmp || this._decalPlace?.ghostId !== ghost.id) return;
            this._decalPlace.aspect = bmp.width / Math.max(1, bmp.height);
            void this.setMeshTexture3D(ghost.id, bmp);
        });

        const showGhost = (g: Mesh3D, hit: DecalHit): void => {
            const st = this._decalPlace!;
            const p = decalPlacement(hit.hitPoint, hit.faceNormal, st.size, st.aspect, st.rotation);
            g.setXYZ(p.position[0], p.position[1], p.position[2]);
            g.setRotation3D(p.rotation.rx, p.rotation.ry, p.rotation.rz);
            g.scaleX = p.scaleX; g.scaleY = p.scaleY; g.scaleZ = 1;
            g.updateLocalMatrix(); g.gpuDirty = true; g.visible = true;
        };
        // Hover shows a live ghost on ANY surface. The cheap path raycasts only the LOCKED mesh (the last one
        // the cursor was over); when the cursor leaves it, a THROTTLED full pick re-acquires the new surface.
        // So the ghost follows across objects, but the expensive whole-city raycast runs at most ~8×/sec, not
        // per frame (which was the lag). One click PLACES — no separate select step, so no triple-click.
        let lastFullPick = 0;
        const onMove = (e: PointerEvent): void => {
            const st = this._decalPlace; const g = this.scene3d.getMesh(st?.ghostId ?? '');
            if (!st || !g) return;
            const rect = canvas.getBoundingClientRect();
            let hit: DecalHit | null = null;
            if (st.targetMeshId) {
                const h = this.scene3d.pickMeshFromClient3D(e.clientX, e.clientY, rect, st.targetMeshId);   // cheap: one mesh
                if (h) hit = { hitPoint: h.hitPoint, faceNormal: h.faceNormal };
            }
            if (!hit) {   // off the locked mesh (or none yet) → re-acquire with a throttled full pick
                const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                if (now - lastFullPick >= 120) {
                    lastFullPick = now;
                    const raw = this.scene3d.pickFromClient3D(e.clientX, e.clientY, rect, true);
                    if (raw) { st.targetMeshId = raw.meshId; this.renderer3D.setHoveredMeshIds(new Set([raw.meshId])); hit = { hitPoint: raw.hitPoint, faceNormal: raw.faceNormal }; }
                }
            }
            if (hit) showGhost(g, this._decalHitToward(hit.hitPoint, hit.faceNormal)); else g.visible = false;
            this.scheduleRender();
        };
        const onDown = (e: PointerEvent): void => {
            const st = this._decalPlace;
            if (!st || e.button !== 0 || e.altKey) return;   // alt = orbit
            const rect = canvas.getBoundingClientRect();
            const raw = this.scene3d.pickFromClient3D(e.clientX, e.clientY, rect, true);
            if (!raw) return;                                 // missed geometry → let it through
            e.stopImmediatePropagation(); e.preventDefault();
            st.targetMeshId = raw.meshId;                     // lock hover onto what we just placed on
            this.renderer3D.setHoveredMeshIds(new Set([raw.meshId]));
            this.placeDecal3D(st.source, this._decalHitToward(raw.hitPoint, raw.faceNormal), { size: st.size, rotation: st.rotation });
        };
        addZonelessListener(canvas, 'pointermove', onMove, { capture: true });
        addZonelessListener(canvas, 'pointerdown', onDown, { capture: true });
        this._decalPlaceCleanup = () => {
            removeZonelessListener(canvas, 'pointermove', onMove, { capture: true } as unknown as EventListenerOptions);
            removeZonelessListener(canvas, 'pointerdown', onDown, { capture: true } as unknown as EventListenerOptions);
        };
        return true;
    }

    public exitDecalPlaceMode3D(): void {
        this._decalPlaceCleanup?.(); this._decalPlaceCleanup = null;
        if (this._decalPlace) {
            const g = this.sceneGraph.findNodeById(this._decalPlace.ghostId);
            if (g) { (g.parent ?? this.sceneGraph.root).removeChild(g); this.emitSceneGraphChanged(); }
            this.renderer3D.setHoveredMeshIds(new Set());   // clear the locked-mesh outline
            this._decalPlace = null;
            this.scheduleRender();
        }
    }
    public get decalPlaceModeActive(): boolean { return this._decalPlace !== null; }

    /** Live-resize the tool's ghost. `metresPerUnit` (optional) → `size` is metres, converted to units. */
    public setDecalToolSize3D(size: number, metresPerUnit?: number): void {
        if (!this._decalPlace) return;
        const u = metresPerUnit && metresPerUnit > 0 ? size / metresPerUnit : size;
        if (u > 0) this._decalPlace.size = u;
    }
    public setDecalToolRotation3D(rotation: number): void { if (this._decalPlace) this._decalPlace.rotation = rotation; }

    public isDecal3D(id: string): boolean { return this._decals.has(id); }
    public listDecals3D(): { id: string; source: DecalSource }[] { return [...this._decals].map(([id, r]) => ({ id, source: r.source })); }
    public removeDecal3D(id: string): boolean {
        const g = this.sceneGraph.findNodeById(id);
        if (!g || !this._decals.has(id)) return false;
        this.scene3d.removeFlatColorMeshGroup(g as unknown as MeshGroup3D);
        this._decals.delete(id);
        this.scheduleRender();
        return true;
    }
    public setDecalSize3D(id: string, size: number, metresPerUnit?: number): boolean {
        const rec = this._decals.get(id);
        const u = metresPerUnit && metresPerUnit > 0 ? size / metresPerUnit : size;
        if (!rec || !(u > 0)) return false;
        rec.size = u; this._applyDecalTransform(id); this.scheduleRender();
        return true;
    }
    public setDecalRotation3D(id: string, rotation: number): boolean {
        const rec = this._decals.get(id);
        if (!rec) return false;
        rec.rotation = rotation; this._applyDecalTransform(id); this.scheduleRender();
        return true;
    }
    public async setDecalSource3D(id: string, source: DecalSource): Promise<boolean> {
        const rec = this._decals.get(id);
        if (!rec) return false;
        rec.source = source;
        await this._applyDecalTexture(id);
        return true;
    }

    /** A decal quad: unit geometry, lit, alpha-cut (crisp edges); the ghost variant is translucent. */
    private _makeDecalQuad(ghost = false): Mesh3D {
        return new Mesh3D(this.interactionService, 0, 0, 0, {
            primitive: 'custom', geometry: decalQuadGeometry(),
            material: { diffuse: { r: ghost ? 0.9 : 0.8, g: ghost ? 0.9 : 0.8, b: ghost ? 0.95 : 0.8, a: 1 },
                roughness: 1, metalness: 0, alphaCutout: true, doubleSided: false, ...(ghost ? { opacity: 0.5 } : {}) },
        });
    }
    /** Apply the CHILD quad's placement transform (pos + Mesh3D-order rotation + size/aspect scale) from the
     *  decal's stored hit, and stamp the container's persistence marker. */
    private _applyDecalTransform(id: string): void {
        const rec = this._decals.get(id); const quad = this.scene3d.getMesh(rec?.quadId ?? '');
        if (!rec || !quad) return;
        const p = decalPlacement(rec.hit.hitPoint, rec.hit.faceNormal, rec.size, rec.aspect, rec.rotation);
        quad.setXYZ(p.position[0], p.position[1], p.position[2]);
        quad.setRotation3D(p.rotation.rx, p.rotation.ry, p.rotation.rz);
        quad.scaleX = p.scaleX; quad.scaleY = p.scaleY; quad.scaleZ = 1;
        quad.updateLocalMatrix(); quad.gpuDirty = true;
        const g = this.sceneGraph.findNodeById(id) as (MeshGroup3D | null);
        if (g) g.worldParams = { kind: 'decal', source: rec.source, size: rec.size, aspect: rec.aspect, rotation: rec.rotation,
            hit: { hx: rec.hit.hitPoint[0], hy: rec.hit.hitPoint[1], hz: rec.hit.hitPoint[2], nx: rec.hit.faceNormal[0], ny: rec.hit.faceNormal[1], nz: rec.hit.faceNormal[2] } };
    }

    private async _applyDecalTexture(id: string): Promise<void> {
        const rec = this._decals.get(id);
        if (!rec) return;
        const bmp = await this._resolveDecalBitmap(rec.source);
        if (!bmp || !this._decals.has(id)) return;
        rec.aspect = bmp.width / Math.max(1, bmp.height);
        this._applyDecalTransform(id);      // re-scale to the image aspect
        await this.setMeshTexture3D(rec.quadId, bmp);
        this.scheduleRender();
    }

    /** Regenerate every decal from a loaded save's markers (called by restoreProceduralFromSave3D). */
    public restoreDecalsFromSave3D(): number {
        let n = 0;
        for (const g of this.scene3d.getRootMeshGroups()) {
            const wp = g.worldParams as { kind?: string; source?: DecalSource; size?: number; aspect?: number; rotation?: number;
                hit?: { hx: number; hy: number; hz: number; nx: number; ny: number; nz: number } } | null;
            if (!wp || wp.kind !== 'decal' || !wp.source || !wp.hit || this._decals.has(g.id)) continue;
            g.thinWrapper = true; g.documentSkipChildren = true;
            const quad = this._makeDecalQuad(); quad.excludeFromDocument = true; g.addChild(quad);
            const h = wp.hit;
            const rec = { source: wp.source, size: wp.size ?? 0.6, aspect: wp.aspect ?? 1, rotation: wp.rotation ?? 0,
                hit: { hitPoint: [h.hx, h.hy, h.hz] as V3, faceNormal: [h.nx, h.ny, h.nz] as V3 }, quadId: quad.id };
            this._decals.set(g.id, rec);
            this._applyDecalTransform(g.id);
            void this._applyDecalTexture(g.id);
            n++;
        }
        this._decalCounter = Math.max(this._decalCounter, this._decals.size);
        this.emitSceneGraphChanged();
        return n;
    }

    // ── Decals Mode B — baked into the surface texture (docs/specs/decals.md §5) ──────────────────────────
    // A "decal stamp" composites a full-colour decal image into the TARGET mesh's own paint texture at the clicked
    // UV, lit as part of the surface via texOverBase (curves/wraps perfectly, no z-fight, no transparency ordering).
    // Reuses the UV-paint RasterTextureManager + _resolveDecalBitmap + the pick→UV interpolation; the one genuinely
    // new piece (per the spec) is the full-colour image blit into the texture at a UV rect.

    /** Ensure a DECAL-LAYER paint texture on `meshId`: TRANSPARENT (so texOverBase shows the base surface wherever a
     *  decal isn't) + hasTexture + texOverBase. Reuses/keeps an existing UV-paint texture (so decals stack on paint). */
    private _ensureDecalTexture(meshId: string): RasterTextureManager | null {
        const device = this.webgpuRenderer?.getDevice();
        const mesh = this.scene3d.getMesh(meshId);
        if (!device || !mesh) return null;
        let mgr = this._uvPaintTextures.get(meshId);
        const isNew = !mgr;
        if (!mgr) { mgr = new RasterTextureManager(device); this._uvPaintTextures.set(meshId, mgr); }
        const cur = mgr.getTextureSize();
        const tex = mgr.ensureTexture(cur.w || 1024, cur.h || 1024);
        if (isNew) {
            // A fresh decal LAYER starts TRANSPARENT (unlike UV paint's white clear) so the base surface shows through.
            const enc = device.createCommandEncoder();
            enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] }).end();
            device.queue.submit([enc.finish()]);
        }
        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        mesh.material.texOverBase = true;   // composite the decal texture OVER the base colour by alpha (bit 15)
        mesh.gpuDirty = true;
        return mgr;
    }

    /** Composite `bitmap` into the paint texture at UV (u,v), sized `size` (fraction of texture width) + `rotation`
     *  (radians), preserving the image aspect. Read-modify-write via an OffscreenCanvas (source-over alpha) + snapshot
     *  (undoable). The brush path is alpha-only, so this dedicated colour blit is the new Mode-B piece. */
    private async _stampImageIntoTexture(mgr: RasterTextureManager, bitmap: ImageBitmap, u: number, v: number, size: number, rotation: number): Promise<void> {
        const device = this.webgpuRenderer?.getDevice();
        if (!device) return;
        const { w: W, h: H } = mgr.getTextureSize();
        const canvas = new OffscreenCanvas(W, H);
        await mgr.readToCanvas(canvas);          // current contents — so we composite over, not overwrite
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dw = Math.max(0.01, size) * W;
        const dh = dw * (bitmap.height / Math.max(1, bitmap.width));   // preserve the decal's aspect
        ctx.save();
        ctx.translate(u * W, v * H);
        ctx.rotate(rotation);
        ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);   // source-over: decal alpha composites over the existing pixels
        ctx.restore();
        device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: mgr.ensureTexture(W, H) }, [W, H]);
        await mgr.pushSnapshot();                 // undoable
    }

    /** Mode B — stamp decal `source` into `meshId`'s texture at UV (u,v) (the UV-pane path). `size` = fraction of the
     *  texture width (default 0.25), `rotation` in radians. Returns false if the mesh / source can't resolve. */
    public async stampDecalAtUV3D(meshId: string, source: DecalSource, u: number, v: number, opts?: { size?: number; rotation?: number }): Promise<boolean> {
        const mgr = this._ensureDecalTexture(meshId);
        if (!mgr) return false;
        const bitmap = await this._resolveDecalBitmap(source);
        if (!bitmap) return false;
        await this._stampImageIntoTexture(mgr, bitmap, u, v, opts?.size ?? 0.25, opts?.rotation ?? 0);
        const mesh = this.scene3d.getMesh(meshId);
        if (mesh) mesh.gpuDirty = true;
        this.scheduleRender();
        return true;
    }

    /** Mode B — stamp decal `source` where the user clicked on `meshId` in the 3D viewport (raycast → UV → stamp).
     *  `rect` is the canvas bounding rect. The host calls this on click while its "decal stamp" tool is active. */
    public async stampDecalAtScreen3D(meshId: string, source: DecalSource, clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, opts?: { size?: number; rotation?: number }): Promise<boolean> {
        const uv = this.scene3d.screenToMeshUV3D(clientX, clientY, rect, meshId);
        if (!uv) return false;
        return this.stampDecalAtUV3D(meshId, source, uv.u, uv.v, opts);
    }
}
