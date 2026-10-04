// ── SignageController — the host API behind ADVERTS (docs/ui/garp.md §Adverts) ────────────────────────
// Owns the browser half of the GARP signage pool: decoding + normalising uploaded images, PACKING each bucket's
// images into padded 512² pages (the GARP atlas resolution), and nudging the city to rebuild. The pure halves live
// in world/adverts.ts (buckets, page plan, cover crop, pick) and signage-library.ts (the persisted image list).
// ShapeManager forwards its `*Signage*3D` methods straight here (no scene3d hop).

import type { GarpManager } from './garp-manager';
import type { DecalSource } from './decal-geometry';
import type { SignageImage } from './signage-library';
import {
    ADVERT_BUCKETS, ADVERT_BUCKET_INFO, ADVERT_PAGE_GRID, ADVERT_PAGE_PX, SIGN_BUCKETS, SHOP_BUCKETS, advertBucketFor, advertCellPx, isAdvertBucket, isShopBucket,
    type AdvertBucket, type AdvertPage, type ShopImageBucket,
} from '../../world/adverts';
import { advertPageOps, normaliseUploadOps, paintSheetOps, type SheetPlan } from '../workers/atlas-sheet-ops';
import type { AtlasComposeJob, AtlasComposeResult } from '../workers/atlas-jobs';

export interface SignageControllerDeps {
    garp: GarpManager;
    /** Decode a DecalSource to a bitmap (ShapeManager's shared decal resolver). */
    resolveBitmap: (src: DecalSource) => Promise<ImageBitmap | null>;
    /** Rebuild the GARP atlas (ShapeManager.rebuildGarpAtlas3D — it calls {@link SignageController.ensurePacked} first). */
    rebuildAtlas: () => Promise<void>;
    /** Rebuild the city so the new catalog shows (WorldManager.refreshAdverts). */
    refreshCity: () => void;
    /** OFF-THREAD sheet composer (atlas-lane composeAtlasSheet). Omitted / rejecting → the main-thread <canvas> path
     *  (the same pure ops from atlas-sheet-ops.ts, so the layout is identical). ImageBitmap sources are transferred. */
    compose?: (job: AtlasComposeJob) => Promise<AtlasComposeResult>;
    /** Hand a just-composed page bitmap to the atlas builder (skips its re-decode of the page's data URL). */
    seedBitmap?: (src: DecalSource, bmp: ImageBitmap) => void;
}

/** One item of {@link SignageController.addMany}. */
export interface SignageAddItem { bucket: AdvertBucket | 'auto'; source: string; opts?: AddSignageOptions }
type AddResult = { id: string | null; bucket: AdvertBucket | null; errors: string[] };

/** A row of the host's Adverts panel. */
export interface SignageImageInfo { id: string; bucket: AdvertBucket; lit: boolean; aspect: number; name?: string; dataUrl: string }
/** A bucket descriptor for the panel (one drop zone each). */
export interface SignageBucketInfo {
    bucket: AdvertBucket; label: string; aspect: string; minAspect: number; maxAspect: number;
    recommendedPx: [number, number]; perPage: number; cellPx: [number, number]; count: number;
}
export interface AddSignageOptions {
    /** Backlit (glows at night) — default true (signs are lightboxes); false = an unlit poster. */
    lit?: boolean;
    /** Display name for the panel. */
    name?: string;
    /** Rebuild the city afterwards (default true; batched — several adds in a row rebuild once). */
    regen?: boolean;
}

/** Longest side an uploaded image is stored at (the largest page cell is 512 px — this keeps crops sharp and the
 *  document small). */
const MAX_STORE_PX = 1024;

export class SignageController {
    private _packedSig = '';
    private _packing: Promise<void> | null = null;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    /** add / addMany calls in flight — the debounced city refresh is HELD while > 0, so a host loop of awaited adds
     *  (each slower than the 400 ms debounce) rebuilds the city ONCE after the last one, not once per image. */
    private _busy = 0;
    /** Per page key: the cell ids last composed + the source object registered for them (skip unchanged pages). */
    private readonly _pageDone = new Map<string, { ids: string; src: DecalSource }>();

    constructor(private readonly d: SignageControllerDeps) {}

    private get lib() { return this.d.garp.signage; }

    /** Add an image to a bucket (`'auto'` = classify by the image's own aspect). `source` = a data URL / object URL /
     *  any URL the decal resolver reads. The image is flattened onto white (a sign face is opaque), capped at
     *  1024 px and stored as JPEG. Packs + rebuilds the atlas; rebuilds the city unless `regen:false`. */
    async add(bucket: AdvertBucket | 'auto', source: string, opts: AddSignageOptions = {}): Promise<AddResult> {
        this._busy++;
        try {
            const r = await this._ingest(bucket, source, opts);
            if (!r.id) return r;
            this.d.garp.syncSignagePool();
            await this.pack();
            if (opts.regen !== false) this._scheduleRefresh();
            return r;
        } finally { this._busy--; }
    }

    /** BATCH add (same per-item results as calling {@link add} in a loop): every image is decoded + normalised, then
     *  ONE re-pack, ONE atlas rebuild and (unless every item says `regen:false`) ONE city rebuild — instead of N. */
    async addMany(items: readonly SignageAddItem[]): Promise<AddResult[]> {
        this._busy++;
        try {
            const out: AddResult[] = [];
            for (const it of items) out.push(await this._ingest(it.bucket, it.source, it.opts ?? {}));
            if (out.some(r => r.id)) {
                this.d.garp.syncSignagePool();
                await this.pack();
                if (items.some((it, i) => out[i].id && it.opts?.regen !== false)) this._scheduleRefresh();
            }
            return out;
        } finally { this._busy--; }
    }

    /** Decode + classify + normalise one image and add it to the library (no pack / rebuild). */
    private async _ingest(bucket: AdvertBucket | 'auto', source: string, opts: AddSignageOptions): Promise<AddResult> {
        if (bucket !== 'auto' && !isAdvertBucket(bucket)) return { id: null, bucket: null, errors: [`unknown bucket "${String(bucket)}" (use ${ADVERT_BUCKETS.join(' / ')} or auto)`] };
        const bmp = await this.d.resolveBitmap({ kind: 'image', dataUrl: source });
        if (!bmp || !bmp.width || !bmp.height) return { id: null, bucket: null, errors: ['the image could not be read'] };
        const w = bmp.width, h = bmp.height;
        const b: AdvertBucket = bucket === 'auto' ? advertBucketFor(w, h) : bucket;
        const dataUrl = (await this._normaliseAsync(bmp, source)) ?? source;
        const rec = this.lib.add({ bucket: b, lit: opts.lit ?? true, aspect: w / h, dataUrl, ...(opts.name ? { name: opts.name } : {}) });
        return { id: rec.id, bucket: b, errors: [] };
    }

    /** Normalise OFF-THREAD (the decoded bitmap is transferred → the JPEG encode never blocks); on failure re-decode
     *  `source` and take the main-thread canvas path. */
    private async _normaliseAsync(bmp: ImageBitmap, source: string): Promise<string | null> {
        const plan = normaliseUploadOps(bmp.width, bmp.height, MAX_STORE_PX);
        if (this.d.compose) {
            try {
                const r = await this.d.compose({ plan, sources: [bmp], encode: { mime: 'image/jpeg', quality: 0.9 } });
                if (r.dataUrl) return r.dataUrl;
            } catch { /* fall through */ }
            if (!bmp.width) {   // transferred → detached: decode again for the fallback
                const again = await this.d.resolveBitmap({ kind: 'image', dataUrl: source });
                return again ? this._normalise(again) : null;
            }
        }
        return this._normalise(bmp);
    }

    async remove(id: string, regen = true): Promise<boolean> {
        if (!this.lib.remove(id)) return false;
        this.d.garp.syncSignagePool();
        await this.pack();
        if (regen) this._scheduleRefresh();
        return true;
    }

    /** Toggle backlit vs poster. No re-pack (the pages don't change) — only the city rebuild. */
    setLit(id: string, lit: boolean, regen = true): boolean {
        const ok = this.lib.setLit(id, lit);
        if (ok) { this.d.garp.syncSignagePool(); if (regen) this._scheduleRefresh(); }
        return ok;
    }

    /** Fraction (0..1) of eligible signs that show an image (default 1 = every sign whose bucket has images). */
    setShare(share: number, regen = true): void {
        this.lib.setShare(share);
        this.d.garp.syncSignagePool();
        if (regen) this._scheduleRefresh();
    }
    get share(): number { return this.lib.share; }

    /** Drop every SIGN image (the city goes back to procedural signs). Shop-window images stay (see {@link clearShop}). */
    async clear(regen = true): Promise<void> {
        if (!this.lib.clearBuckets(SIGN_BUCKETS)) return;
        this.d.garp.syncSignagePool();
        await this.pack();
        if (regen) this._scheduleRefresh();
    }

    /** Every SIGN image (the Adverts panel's rows), in add order. */
    list(): SignageImageInfo[] { return this._rows(b => !isShopBucket(b)); }

    /** The sign buckets (the Adverts panel's drop zones). */
    buckets(): SignageBucketInfo[] { return this._bucketRows(SIGN_BUCKETS); }

    // ── SHOP WINDOWS (persona-polish C4): shop-interior + poster images on the shopfront glass ──
    /** Add a shop-window image: 'interior' = the back wall of a recessed shop room behind clear glass, 'poster' = a
     *  sheet on the inside of the glass. Same storage / packing / persistence as the adverts. Default lit = true
     *  (a lit shop glows at night). */
    async addShop(bucket: ShopImageBucket, source: string, opts: AddSignageOptions = {}): Promise<{ id: string | null; bucket: AdvertBucket | null; errors: string[] }> {
        if (!isShopBucket(bucket)) return { id: null, bucket: null, errors: [`unknown shop bucket "${String(bucket)}" (use ${SHOP_BUCKETS.join(' / ')})`] };
        return this.add(bucket, source, opts);
    }
    /** Every shop-window image, in add order. */
    listShop(): SignageImageInfo[] { return this._rows(isShopBucket); }
    /** The shop-window buckets (drop zones of a Shop Windows panel). */
    shopBuckets(): SignageBucketInfo[] { return this._bucketRows(SHOP_BUCKETS); }
    /** Fraction (0..1) of shop bays that show a shop image (default 1). */
    setShopShare(share: number, regen = true): void {
        this.lib.setShopShare(share);
        this.d.garp.syncSignagePool();
        if (regen) this._scheduleRefresh();
    }
    get shopShare(): number { return this.lib.shopShare; }
    /** Drop every shop-window image (shops go back to the procedural interiors). */
    async clearShop(regen = true): Promise<void> {
        if (!this.lib.clearBuckets(SHOP_BUCKETS)) return;
        this.d.garp.syncSignagePool();
        await this.pack();
        if (regen) this._scheduleRefresh();
    }

    private _rows(keep: (b: AdvertBucket) => boolean): SignageImageInfo[] {
        return this.lib.list().filter(im => keep(im.bucket)).map((im: SignageImage) => ({ id: im.id, bucket: im.bucket, lit: im.lit, aspect: im.aspect, ...(im.name ? { name: im.name } : {}), dataUrl: im.dataUrl }));
    }

    private _bucketRows(which: readonly AdvertBucket[]): SignageBucketInfo[] {
        const imgs = this.lib.list();
        return which.map(bucket => {
            const info = ADVERT_BUCKET_INFO[bucket], g = ADVERT_PAGE_GRID[bucket];
            const cell = advertCellPx(bucket, 0);
            return { bucket, label: info.label, aspect: info.nominal, minAspect: info.minAspect, maxAspect: info.maxAspect,
                recommendedPx: info.recommendedPx, perPage: g.cols * g.rows, cellPx: [cell.inner.w, cell.inner.h], count: imgs.filter(im => im.bucket === bucket).length };
        });
    }

    /** Pack every page + rebuild the GARP atlas (normally automatic — for a forced refresh). */
    async pack(): Promise<void> {
        await this.ensurePacked();
        await this.d.rebuildAtlas();
    }

    /** Pack the pages if the library changed since the last pack (called by the atlas rebuild before it resolves
     *  sources, so a restored document's pages are real before the first upload). No atlas rebuild here. */
    async ensurePacked(): Promise<void> {
        const pages = this.d.garp.syncSignagePool();
        const sig = this._sig(pages);
        if (sig === this._packedSig) return;
        if (this._packing) { await this._packing; return this.ensurePacked(); }
        this._packing = (async () => {
            const byId = new Map(this.lib.list().map(im => [im.id, im] as const));
            // Only pages whose cells changed (or whose registered texture is no longer ours — a document load
            // re-seeds placeholders) are recomposed; pages compose concurrently (off-thread when available).
            await Promise.all(pages.map(async (pg) => {
                const ids = pg.ids.join(',');
                const done = this._pageDone.get(pg.key);
                if (done && done.ids === ids && this.d.garp.textureSource(pg.key) === done.src) return;
                const r = await this._drawPage(pg, byId);
                if (!r) return;
                const src: DecalSource = { kind: 'image', dataUrl: r.dataUrl };
                this.d.garp.registerTexture(pg.key, src);
                if (r.bitmap) this.d.seedBitmap?.(src, r.bitmap);
                this._pageDone.set(pg.key, { ids, src });
            }));
            const keep = new Set(pages.map(pg => pg.key));
            for (const k of [...this._pageDone.keys()]) if (!keep.has(k)) this._pageDone.delete(k);
            this._packedSig = sig;
        })();
        try { await this._packing; } finally { this._packing = null; }
    }

    /** A page's content signature: which images sit in which cells (lit flags don't change pixels). */
    private _sig(pages: AdvertPage[]): string {
        return pages.map(pg => `${pg.key}:${pg.ids.join(',')}`).join('|');
    }

    /** Draw one page: each image STRETCHED to its cell's inner rect, first bled across the whole cell (padding
     *  included) so bilinear filtering never mixes neighbours. Empty cells stay white. */
    private async _drawPage(pg: AdvertPage, byId: Map<string, SignageImage>): Promise<{ dataUrl: string; bitmap: ImageBitmap | null } | null> {
        // The page layout (cell → rects, draw order) is the ONE pure plan both paths paint.
        const urls: string[] = [];
        const cellSrc = pg.ids.map(id => { const im = byId.get(id); if (!im) return -1; urls.push(im.dataUrl); return urls.length - 1; });
        const plan = advertPageOps(pg.bucket, cellSrc);
        if (this.d.compose) {
            // OFF-THREAD: the worker decodes the stored JPEGs, paints, PNG-encodes and returns the GPU-ready bitmap.
            try {
                const r = await this.d.compose({ plan, sources: urls, encode: { mime: 'image/png' }, bitmap: true });
                if (r.dataUrl) return { dataUrl: r.dataUrl, bitmap: r.bitmap };
            } catch { /* fall back to the main-thread canvas */ }
        }
        const dataUrl = await this._paintOnMain(plan, urls);
        return dataUrl ? { dataUrl, bitmap: null } : null;
    }

    /** Main-thread fallback painter: decode the sources, paint the SAME plan on a <canvas>, PNG-encode. */
    private async _paintOnMain(plan: SheetPlan, urls: readonly string[]): Promise<string | null> {
        if (typeof document === 'undefined') return null;
        const images = await Promise.all(urls.map(u => this.d.resolveBitmap({ kind: 'image', dataUrl: u })));
        const canvas = document.createElement('canvas');
        canvas.width = plan.width; canvas.height = plan.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        paintSheetOps(ctx, plan.ops, images);
        return canvas.toDataURL('image/png');
    }

    /** Flatten onto white + cap the longest side → a JPEG data URL (null if no canvas — keep the source). */
    private _normalise(bmp: ImageBitmap): string | null {
        if (typeof document === 'undefined') return null;
        const plan = normaliseUploadOps(bmp.width, bmp.height, MAX_STORE_PX);
        const canvas = document.createElement('canvas');
        canvas.width = plan.width; canvas.height = plan.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        paintSheetOps(ctx, plan.ops, [bmp]);
        return canvas.toDataURL('image/jpeg', 0.9);
    }

    private _scheduleRefresh(): void {
        if (typeof setTimeout === 'undefined') { this.d.refreshCity(); return; }
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            if (this._busy > 0) { this._scheduleRefresh(); return; }   // another add is mid-flight → wait for it
            this.d.refreshCity();
        }, 400);
    }

    /** DEV: generated test images (canvas) — a few per bucket, numbered + an arrow, so orientation / crop / pick
     *  are visible in the city. Returns `{ bucket, dataUrl, lit }[]`. */
    static demoImages(): { bucket: AdvertBucket; dataUrl: string; lit: boolean }[] {
        if (typeof document === 'undefined') return [];
        const out: { bucket: AdvertBucket; dataUrl: string; lit: boolean }[] = [];
        const sizes: Record<AdvertBucket, [number, number]> = { portrait: [256, 896], landscape: [960, 480], square: [512, 512], fascia: [1200, 200], interior: [1024, 512], poster: [360, 512] };
        const hues = [0, 45, 130, 200, 280, 330];
        let n = 0;
        for (const bucket of SIGN_BUCKETS) {
            for (let i = 0; i < 3; i++, n++) {
                const [w, h] = sizes[bucket];
                const c = document.createElement('canvas'); c.width = w; c.height = h;
                const g = c.getContext('2d');
                if (!g) continue;
                const hue = hues[n % hues.length];
                const grad = g.createLinearGradient(0, 0, w, h);
                grad.addColorStop(0, `hsl(${hue},85%,55%)`); grad.addColorStop(1, `hsl(${(hue + 60) % 360},85%,30%)`);
                g.fillStyle = grad; g.fillRect(0, 0, w, h);
                g.strokeStyle = '#fff'; g.lineWidth = Math.max(4, Math.min(w, h) * 0.04); g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);
                g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
                const fs = Math.min(w, h) * 0.45;
                g.font = `bold ${Math.round(fs)}px sans-serif`;
                g.fillText(`${'PLSF'[ADVERT_BUCKETS.indexOf(bucket)]}${i + 1}`, w / 2, h / 2);
                // an arrow pointing RIGHT in the top-left corner (a mirrored face would point left)
                const a = Math.min(w, h) * 0.18;
                g.beginPath(); g.moveTo(a * 0.4, a * 0.5); g.lineTo(a * 1.4, a); g.lineTo(a * 0.4, a * 1.5); g.closePath(); g.fill();
                out.push({ bucket, dataUrl: c.toDataURL('image/png'), lit: i !== 2 });
            }
        }
        return out;
    }

    /** DEV: generated SHOP-WINDOW test images (canvas): three shop interiors (lit shelves of products / a counter /
     *  strip lights, with a big label naming the shop) + three posters (a bold word on a colour field). */
    static demoShopImages(): { bucket: ShopImageBucket; dataUrl: string; lit: boolean }[] {
        if (typeof document === 'undefined') return [];
        const out: { bucket: ShopImageBucket; dataUrl: string; lit: boolean }[] = [];
        const shops: [string, string, number][] = [['BOOKS 本', '#f4efe2', 30], ['DRUG 薬', '#eef6f8', 190], ['CAFE カフェ', '#f6e7d4', 25]];
        for (const [label, wall, hue] of shops) {
            const w = 1024, h = 512, c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d'); if (!g) continue;
            g.fillStyle = wall; g.fillRect(0, 0, w, h);
            g.fillStyle = '#ffffff'; for (let x = 60; x < w; x += 240) g.fillRect(x, 10, 150, 14);            // strip lights
            for (let row = 0; row < 4; row++) {                                                                  // shelves
                const y = 110 + row * 92;
                g.fillStyle = '#9a8f80'; g.fillRect(40, y + 70, w - 80, 8);
                for (let x = 48; x < w - 60; x += 22 + ((x * 7 + row * 13) % 11)) {
                    const ph = 40 + ((x * 31 + row * 17) % 30);
                    g.fillStyle = `hsl(${(hue + ((x * 13 + row * 57) % 120) - 60 + 360) % 360},${45 + (x % 30)}%,${45 + ((x * 3) % 25)}%)`;
                    g.fillRect(x, y + 70 - ph, 16, ph);
                }
            }
            g.fillStyle = '#5b4a3a'; g.fillRect(0, h - 70, w, 70);                                                 // counter
            g.fillStyle = '#222'; g.font = 'bold 54px sans-serif'; g.textAlign = 'center'; g.fillText(label, w / 2, 86);
            out.push({ bucket: 'interior', dataUrl: c.toDataURL('image/jpeg', 0.9), lit: true });
        }
        const posters: [string, string, string][] = [['SALE', '#d8342a', '#fff4d0'], ['新発売', '#1f3f8f', '#ffffff'], ['50%', '#f2c230', '#1b1b1b']];
        for (const [txt, bg, fg] of posters) {
            const w = 360, h = 512, c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d'); if (!g) continue;
            g.fillStyle = bg; g.fillRect(0, 0, w, h);
            g.strokeStyle = fg; g.lineWidth = 10; g.strokeRect(18, 18, w - 36, h - 36);
            g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.font = `bold ${txt.length > 3 ? 92 : 120}px sans-serif`; g.fillText(txt, w / 2, h * 0.42);
            g.font = 'bold 36px sans-serif'; g.fillText('OPEN 10-22', w / 2, h * 0.78);
            out.push({ bucket: 'poster', dataUrl: c.toDataURL('image/png'), lit: false });
        }
        return out;
    }
}
