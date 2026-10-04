// GarpAtlasBuilder — the GARP texture_2d_array (re)build, extracted from ShapeManager.rebuildGarpAtlas3D
// (performance-plan P3.2e). Two fixes over the old inline loop:
//
//  · COALESCED: overlapping rebuild requests (every _ensure*Garp, every signage add, packVendingCanLabels3D…) share
//    ONE in-flight build plus at most ONE trailing build that starts after it — never N interleaved builds racing
//    their uploads. Every caller's promise resolves after a build that started AFTER its call (so its textures are in).
//  · CACHED: each texture's fitted bitmap is cached by its DecalSource OBJECT (the registry replaces the object when
//    a texture changes), so a rebuild only decodes + fits the textures that actually changed — the old loop
//    re-fetched + re-decoded all ~35 built-in placeholder PNGs on every rebuild. Producers that already hold the
//    pixels (the signage page packer) SEED the cache, skipping the decode entirely.
//
// The upload itself (renderer.uploadGarpAtlas) is unchanged.

import type { DecalSource } from './decal-geometry';
import type { GarpManager } from './garp-manager';

export interface GarpAtlasBuilderDeps {
    garp: GarpManager;
    resolveBitmap: (src: DecalSource) => Promise<ImageBitmap | null>;
    /** Runs first in every build (ShapeManager: SignageController.ensurePacked). */
    beforeBuild?: () => Promise<void>;
    upload: (layers: { layer: number; bitmap: ImageBitmap }[], size: [number, number]) => void;
    /** After the upload (markAtlasClean + markInstancesDirty + scheduleRender). */
    afterUpload: () => void;
}

export class GarpAtlasBuilder {
    private readonly _cache = new Map<DecalSource, { w: number; h: number; bmp: ImageBitmap }>();
    private _running: Promise<void> | null = null;
    private _trailing: Promise<void> | null = null;
    private _size: [number, number] = [512, 512];
    /** Completed builds (diagnostics / tests). */
    builds = 0;

    constructor(private readonly d: GarpAtlasBuilderDeps) {}

    /** Hand the builder pixels it would otherwise decode (e.g. a just-composed signage page). */
    seed(source: DecalSource, bmp: ImageBitmap): void { this._cache.set(source, { w: bmp.width, h: bmp.height, bmp }); }

    /** Request a rebuild at `size`. Coalesced (see header). */
    rebuild(size: [number, number] = [512, 512]): Promise<void> {
        this._size = size;
        if (!this._running) {
            this._running = this._build(size).finally(() => { this._running = null; });
            return this._running;
        }
        return this._trailing ??= this._running.catch(() => {}).then(() => { this._trailing = null; return this.rebuild(this._size); });
    }

    private async _build(size: [number, number]): Promise<void> {
        if (this.d.beforeBuild) await this.d.beforeBuild();
        const build = this.d.garp.textureBuildList();
        const [W, H] = size;
        const results = await Promise.all(build.map(async ({ source, layer }) => {
            const hit = this._cache.get(source);
            if (hit && hit.w === W && hit.h === H) return { layer, bitmap: hit.bmp };
            const bmp = await this.d.resolveBitmap(source);
            if (!bmp) return null;
            // ★ The atlas packs ONE fixed size per pool; an uploaded image is whatever the user's PNG is. Without
            //   this, uploadGarpAtlas SKIPS the mismatch → the fascia renders BLANK (silent). Fit every bitmap to
            //   the atlas size (contain-letterbox → undistorted, whole image) so uploads always show.
            const fitted = await fitBitmapToRect(bmp, W, H);
            this._cache.set(source, { w: fitted.width, h: fitted.height, bmp: fitted });
            return { layer, bitmap: fitted };
        }));
        // Drop cache entries for sources no longer registered (replaced / removed textures).
        const live = new Set(build.map((b) => b.source));
        for (const k of [...this._cache.keys()]) if (!live.has(k)) this._cache.delete(k);
        this.d.upload(results.filter((r): r is { layer: number; bitmap: ImageBitmap } => !!r), size);
        this.builds++;
        this.d.afterUpload();
    }
}

/** Resize a bitmap to exactly w×h, CONTAIN-fit (preserve aspect, transparent letterbox) so the whole image shows
 *  undistorted — the GARP atlas requires one fixed size per pool. No-op when already the target size. */
export async function fitBitmapToRect(bmp: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
    if (bmp.width === w && bmp.height === h) return bmp;
    try {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) return bmp;
        const scale = Math.min(w / bmp.width, h / bmp.height);
        const dw = bmp.width * scale, dh = bmp.height * scale;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
        return await createImageBitmap(canvas);
    } catch { return bmp; }
}
