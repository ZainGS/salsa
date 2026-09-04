import type { ManagerContext } from '../services/managers/manager-context';
import type { LiveTextureMode } from '../services/managers/live-texture-mode';
import type { EphemeraService } from '../services/ephemera/ephemera-service';
import { RasterTextureManager } from '../renderer/raster/raster-texture-manager';
import { LayerBlendMode, RasterCompositor, type CompositorLayerInfo } from '../renderer/raster/core/raster-compositor';

/** Collaborators the packaging compositor needs that don't live on {@link ManagerContext}. */
export interface PackagingCompositeHost {
    readonly liveTexture: LiveTextureMode;   // box panels sample the composite via linkProvider/syncAll
    readonly ephemera: EphemeraService;      // vector-proxy render reads a layer's ephemera placements
}

/**
 * Packaging box-panel COMPOSITE machinery: each package's layer stack composites into one offscreen target the
 * box panels sample (via LiveTextureMode), and vector/ephemera layers rasterize into proxy textures first.
 * Extracted from ShapeManager. Takes {@link ManagerContext} (rasterLayerManager + renderer + scheduleRender) +
 * a narrow {@link PackagingCompositeHost}. The private `_pkg*` methods are the originals VERBATIM (reached via
 * the getters/bridges below); the public API + accessors at the end are the seam the facade / PackagingManager
 * host adapter / UV-paint packaging session call.
 */
export class PackagingComposite {
    constructor(private readonly ctx: ManagerContext, private readonly host: PackagingCompositeHost) {}

    // ── Bridges so the moved method bodies stay byte-for-byte identical ─
    private get rasterLayerManager() { return this.ctx.rasterLayerManager; }
    private get webgpuRenderer() { return this.ctx.webgpuRenderer; }
    private scheduleRender(): void { this.ctx.scheduleRender(); }
    private get _liveTexture(): LiveTextureMode { return this.host.liveTexture; }
    private get _ephemera(): EphemeraService { return this.host.ephemera; }

    private readonly _pkgComposites = new Map<string, {
        mgr: RasterTextureManager;
        panelIds: string[];
        getStack: () => { layerIds: string[] };
        /** Monotonic recomposite counter + last-recomposite timestamp (salsaPkgStackProbe diagnostic). */
        recomposites: number;
        lastRecompositeTick: number;
    }>();

    /** Resolve the package that owns `layerId`: its `packageOwnerId` tag first, then a scan of the
     *  LIVE composites for a stack containing the id (survives package-id drift after a rebuild). */
    private _pkgResolveOwningPackage(layerId: string): string | null {
        const tagged = this.rasterLayerManager?.getLayerById(layerId)?.packageOwnerId;
        if (tagged && this._pkgComposites.has(tagged)) return tagged;
        for (const [pkgId, entry] of this._pkgComposites) {
            if (entry.getStack().layerIds.includes(layerId)) return pkgId;
        }
        return null;
    }
    /** vector layerId → raster proxy manager (its rasterized ephemera placements). */
    private readonly _pkgVectorProxies = new Map<string, RasterTextureManager>();
    private _pkgCompositor?: RasterCompositor;
    private _pkgStrokeRecompositeLast = 0;   // stroke-move recomposite throttle (~30 fps)
    private readonly _pkgVectorDirtyTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Doc-raster pixel size (the space the layers, net UVs, and composite all share). */
    private _pkgDocSize(): { w: number; h: number } {
        const rlm = this.rasterLayerManager;
        if (rlm) {
            for (const meta of rlm.getLayers()) {
                if (meta.type !== 'layer') continue;
                const sz = rlm.getLayerById(meta.id)?.manager?.getTextureSize?.();
                if (sz && sz.w > 0 && sz.h > 0) return sz;
            }
        }
        return this.webgpuRenderer?.getIllustrationPixelSize?.() ?? { w: 1024, h: 768 };
    }

    private _pkgLinkComposite(packageId: string, panelMeshIds: string[], getStack: () => { layerIds: string[] }): void {
        const device = this.webgpuRenderer?.getDevice();
        if (!device || !this.rasterLayerManager) return;
        let entry = this._pkgComposites.get(packageId);
        if (!entry) {
            entry = { mgr: new RasterTextureManager(device), panelIds: [], getStack, recomposites: 0, lastRecompositeTick: 0 };
            this._pkgComposites.set(packageId, entry);
        }
        entry.getStack = getStack;
        entry.panelIds = [...panelMeshIds];
        // Panels sample the COMPOSITE target (provider re-resolves per sync → target reallocation
        // on doc-resize self-heals like layer links do).
        const provider = () => this._pkgComposites.get(packageId)?.mgr.getTexture() ?? null;
        for (const id of panelMeshIds) this._liveTexture.linkProvider(id, provider);
        this._pkgRecomposite(packageId);
        // Vector proxies render async (SVG decode) → recomposite again when they land.
        void this._pkgRefreshVectorProxies(packageId).then(ok => { if (ok) this._pkgRecomposite(packageId); });
    }

    private _pkgUnlinkComposite(packageId: string): void {
        const entry = this._pkgComposites.get(packageId);
        if (!entry) return;
        for (const id of entry.panelIds) this._liveTexture.unlinkProvider(id);
        entry.mgr.destroy?.();
        this._pkgComposites.delete(packageId);
        this.scheduleRender();
    }

    /** Recomposite a package's stack into its offscreen target NOW (order + visibility + opacity +
     *  blend all re-read live). Cheap: one compositor pass over the package's few layers. */
    private _pkgRecomposite(packageId: string): void {
        const entry = this._pkgComposites.get(packageId);
        const rlm = this.rasterLayerManager;
        const device = this.webgpuRenderer?.getDevice();
        if (!entry || !rlm || !device) return;
        const size = this._pkgDocSize();
        entry.mgr.ensureTexture(size.w, size.h);
        const out = entry.mgr.getTexture();
        if (!out) return;
        if (!this._pkgCompositor) this._pkgCompositor = new RasterCompositor(device);   // no grain/dither wiring
        const layers: CompositorLayerInfo[] = [];
        for (const layerId of entry.getStack().layerIds) {
            const l = rlm.getLayerById(layerId);
            if (!l) continue;
            const kind = l.type ?? 'layer';
            let tex: GPUTexture | null = null;
            if (kind === 'vector' || kind === 'ephemera') tex = this._pkgVectorProxies.get(layerId)?.getTexture() ?? null;
            else if (kind === 'layer') tex = l.manager?.getTexture?.() ?? l.texture ?? null;
            if (!tex) continue;
            layers.push({
                texture: tex,
                blendMode: l.blendMode ?? LayerBlendMode.Normal,
                opacity: l.opacity ?? 1,
                clipped: false,
                visible: l.visible ?? true,
            });
        }
        this._pkgCompositor.composite(layers, out);   // zero visible layers → clears (kraft shows)
        entry.recomposites++;
        entry.lastRecompositeTick = (typeof performance !== 'undefined' ? performance.now() : Date.now()) | 0;
        this._liveTexture.syncAll();                  // provider may resolve a NEW target (first alloc / resize)
        this.scheduleRender();
    }

    /** Re-render EVERY vector layer proxy of a package (SVG placements → proxy texture). */
    private async _pkgRefreshVectorProxies(packageId: string): Promise<boolean> {
        const entry = this._pkgComposites.get(packageId);
        const rlm = this.rasterLayerManager;
        if (!entry || !rlm) return false;
        let any = false;
        for (const layerId of entry.getStack().layerIds) {
            const t = rlm.getLayerById(layerId)?.type;
            if (t === 'vector' || t === 'ephemera') { await this._pkgRenderVectorProxy(layerId); any = true; }
        }
        return any;
    }

    /** Rasterize one package vector layer's ephemera placements into its raster PROXY — the same
     *  OffscreenCanvas SVG path compositeMultipleImagesOntoLayer uses, but into the proxy (clean
     *  transparent base each pass, no undo snapshot). Headless/no-DOM environments no-op. */
    private async _pkgRenderVectorProxy(layerId: string): Promise<void> {
        const rlm = this.rasterLayerManager;
        const device = this.webgpuRenderer?.getDevice();
        if (!rlm || !device || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return;
        const l = rlm.getLayerById(layerId);
        if (!l || !(l.type === 'vector' || l.type === 'ephemera')) return;
        let proxy = this._pkgVectorProxies.get(layerId);
        if (!proxy) { proxy = new RasterTextureManager(device); this._pkgVectorProxies.set(layerId, proxy); }
        const size = this._pkgDocSize();
        const tex = proxy.ensureTexture(size.w, size.h);
        const placements = this._ephemera.getPlacementsForLayer(layerId).filter(p => p.visible);
        const canvas = new OffscreenCanvas(size.w, size.h);
        const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        for (const p of placements) {
            try {
                const svgBlob = new Blob([p.svg], { type: 'image/svg+xml' });
                const bitmap = await createImageBitmap(svgBlob, {
                    resizeWidth: Math.max(1, Math.round(p.width)),
                    resizeHeight: Math.max(1, Math.round(p.height)),
                });
                ctx.save();
                ctx.globalAlpha = p.opacity;
                ctx.globalCompositeOperation = (p.blendMode as GlobalCompositeOperation | undefined) ?? 'source-over';
                if (p.rotation) {
                    ctx.translate(p.x + p.width / 2, p.y + p.height / 2);
                    ctx.rotate(p.rotation * Math.PI / 180);
                    ctx.drawImage(bitmap, -p.width / 2, -p.height / 2, p.width, p.height);
                } else {
                    ctx.drawImage(bitmap, p.x, p.y, p.width, p.height);
                }
                ctx.restore();
                bitmap.close();
            } catch { /* one bad SVG must not kill the layer */ }
        }
        const composited = await createImageBitmap(canvas);
        device.queue.copyExternalImageToTexture(
            { source: composited, flipY: false },
            { texture: tex },
            { width: size.w, height: size.h },
        );
        composited.close?.();
    }

    /** DEBOUNCED vector-layer invalidation (placement add/update/remove/visibility): re-render the
     *  proxy + recomposite ~80 ms after the last change — the documented Part-2 granularity
     *  (change-event driven, not per-frame; a drag recomposites a few times per second and settles
     *  on release). No-op for layers that aren't part of a linked package stack. */
    private _pkgVectorLayerDirty(layerId: string): void {
        // Resolve the owning package: the layer's packageOwnerId tag first, then — belt-and-braces —
        // a scan of the LINKED composites for a stack that actually contains this layer id. The scan
        // covers a package whose id drifted after a dims/style rebuild (the layer's owner tag is
        // re-synced in the manager's _rebuild, but this guarantees the subscription never silently
        // detaches for a layer that IS in a live composite).
        const pkgId = this._pkgResolveOwningPackage(layerId);
        if (!pkgId) return;
        const prev = this._pkgVectorDirtyTimers.get(layerId);
        if (prev) clearTimeout(prev);
        this._pkgVectorDirtyTimers.set(layerId, setTimeout(() => {
            this._pkgVectorDirtyTimers.delete(layerId);
            void this._pkgRenderVectorProxy(layerId).then(() => this._pkgRecomposite(pkgId));
        }, 80));
    }

    // ── Public API (the extraction seam) ──────────────────────────────
    /** Link a package's panels to a fresh composite target + do the first composite (+ async vector proxies). */
    link(packageId: string, panelMeshIds: string[], getStack: () => { layerIds: string[] }): void { this._pkgLinkComposite(packageId, panelMeshIds, getStack); }
    /** Unlink + destroy a package's composite target. */
    unlink(packageId: string): void { this._pkgUnlinkComposite(packageId); }
    /** Recomposite a package's stack into its target NOW. */
    recomposite(packageId: string): void { this._pkgRecomposite(packageId); }
    /** Re-render every vector/ephemera proxy of a package (async SVG decode). */
    refreshVectorProxies(packageId: string): Promise<boolean> { return this._pkgRefreshVectorProxies(packageId); }
    /** Debounced vector-layer invalidation (placement add/update/remove/visibility). No-op off a linked stack. */
    vectorLayerDirty(layerId: string): void { this._pkgVectorLayerDirty(layerId); }
    /** Throttled (~30fps) recomposite for a paint-stroke move — encapsulates the has-check + timestamp gate. */
    recompositeThrottled(packageId: string): void {
        if (!this._pkgComposites.has(packageId)) return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - this._pkgStrokeRecompositeLast < 33) return;
        this._pkgStrokeRecompositeLast = now;
        this._pkgRecomposite(packageId);
    }
    hasComposite(packageId: string): boolean { return this._pkgComposites.has(packageId); }
    getCompositeMgr(packageId: string): RasterTextureManager | null { return this._pkgComposites.get(packageId)?.mgr ?? null; }
    /** The full composite entry (mgr + recomposite counters) — for exportPng + the stack probe. */
    getComposite(packageId: string) { return this._pkgComposites.get(packageId) ?? null; }
    getVectorProxy(layerId: string): RasterTextureManager | null { return this._pkgVectorProxies.get(layerId) ?? null; }
    /** Destroy + forget a layer's vector proxy (on layer removal). */
    dropVectorProxy(layerId: string): void { const p = this._pkgVectorProxies.get(layerId); if (p) { p.destroy?.(); this._pkgVectorProxies.delete(layerId); } }
}
