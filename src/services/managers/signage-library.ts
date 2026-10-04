// ── SignageLibrary — the ADVERTS image list of the GARP signage pool (docs/ui/garp.md §Adverts) ──────
// Pure registry (no DOM / GPU): the user's advert images, each with its aspect BUCKET, a Lit flag and its source
// aspect, in ADD ORDER (the order pages are planned in — see planAdvertPages). Owned by GarpManager so it rides
// the GARP save (garp.json → `signage`) and the document-load clear for free. The packed PAGES are derived from
// this list (re-packed on load), so only the images are persisted — never the pages, never an atlas layer.

import { buildAdvertCatalog, isAdvertBucket, type AdvertBucket, type AdvertCatalog } from '../../world/adverts';

export interface SignageImage {
    id: string;
    bucket: AdvertBucket;
    /** Backlit (glows at night like the neon signs) vs an unlit poster. */
    lit: boolean;
    /** Source width / height (drives the cover crop onto each sign's real aspect). */
    aspect: number;
    /** The (possibly downscaled) image as a data URL — the packer's input + the host's thumbnail. */
    dataUrl: string;
    name?: string;
}

/** The persisted form (inside garp.json). `shopShare` (persona-polish C4, the shop-window image share) is written
 *  only when it differs from 1. */
export interface SignageLibraryJSON { v: 1; share: number; images: SignageImage[]; shopShare?: number }

export class SignageLibrary {
    private _images: SignageImage[] = [];
    private _share = 1;
    private _shopShare = 1;
    private _next = 1;
    private _version = 0;
    private _catalog: { v: number; cat: AdvertCatalog | null } | null = null;

    /** Bumps on EVERY change (images, lit flags, share) — the page-pool version + catalog cache key. */
    get version(): number { return this._version; }
    get empty(): boolean { return this._images.length === 0; }
    /** Fraction (0..1) of eligible city signs that show an image; the rest keep their procedural lettering. */
    get share(): number { return this._share; }

    /** Fraction (0..1) of eligible shop-window bays that show a shop image (interior / poster buckets). */
    get shopShare(): number { return this._shopShare; }

    list(): readonly SignageImage[] { return this._images; }
    get(id: string): SignageImage | undefined { return this._images.find(im => im.id === id); }

    /** Append an image (a fresh stable id unless one is given — restore). Returns the stored record. */
    add(img: Omit<SignageImage, 'id'> & { id?: string }): SignageImage {
        const id = img.id && !this.get(img.id) ? img.id : `ad-${this._next++}`;
        const rec: SignageImage = { id, bucket: img.bucket, lit: !!img.lit, aspect: img.aspect > 0 && Number.isFinite(img.aspect) ? img.aspect : 1, dataUrl: img.dataUrl, ...(img.name ? { name: img.name } : {}) };
        this._images.push(rec);
        this._bumpFrom(id);
        this._changed();
        return rec;
    }
    remove(id: string): boolean {
        const n = this._images.length;
        this._images = this._images.filter(im => im.id !== id);
        if (this._images.length === n) return false;
        this._changed();
        return true;
    }
    setLit(id: string, lit: boolean): boolean {
        const im = this.get(id);
        if (!im || im.lit === !!lit) return !!im;
        im.lit = !!lit;
        this._changed();
        return true;
    }
    setShare(share: number): void {
        const v = Math.max(0, Math.min(1, Number.isFinite(share) ? share : 1));
        if (v === this._share) return;
        this._share = v;
        this._changed();
    }
    setShopShare(share: number): void {
        const v = Math.max(0, Math.min(1, Number.isFinite(share) ? share : 1));
        if (v === this._shopShare) return;
        this._shopShare = v;
        this._changed();
    }
    clear(): void {
        this._images = []; this._share = 1; this._shopShare = 1; this._next = 1;
        this._changed();
    }
    /** Remove every image of the given buckets (the Adverts panel clears the sign buckets, the Shop Windows panel
     *  the shop buckets). True when anything was removed. */
    clearBuckets(buckets: readonly AdvertBucket[]): boolean {
        const n = this._images.length;
        this._images = this._images.filter(im => !buckets.includes(im.bucket));
        if (this._images.length === n) return false;
        this._changed();
        return true;
    }

    /** The world-gen catalog (null when empty → the city stays procedural). Cached per version. */
    catalog(): AdvertCatalog | null {
        if (this._catalog?.v !== this._version) this._catalog = { v: this._version, cat: buildAdvertCatalog(this._images, this._share, this._shopShare) };
        return this._catalog.cat;
    }

    serialize(): SignageLibraryJSON | null {
        return this._images.length ? { v: 1, share: this._share, images: this._images.map(im => ({ ...im })), ...(this._shopShare !== 1 ? { shopShare: this._shopShare } : {}) } : null;
    }
    /** Replace the list from a {@link serialize} snapshot. Malformed entries are dropped (never throws). */
    restore(data: unknown): void {
        this._images = []; this._share = 1; this._shopShare = 1; this._next = 1;
        const d = data as Partial<SignageLibraryJSON> | null | undefined;
        if (d && Array.isArray(d.images)) {
            for (const im of d.images) {
                if (!im || typeof im.dataUrl !== 'string' || !isAdvertBucket(im.bucket)) continue;
                this._images.push({ id: typeof im.id === 'string' && im.id ? im.id : `ad-${this._next++}`, bucket: im.bucket, lit: !!im.lit,
                    aspect: typeof im.aspect === 'number' && im.aspect > 0 ? im.aspect : 1, dataUrl: im.dataUrl, ...(typeof im.name === 'string' && im.name ? { name: im.name } : {}) });
                this._bumpFrom(this._images[this._images.length - 1].id);
            }
            if (typeof d.share === 'number') this._share = Math.max(0, Math.min(1, d.share));
            if (typeof d.shopShare === 'number') this._shopShare = Math.max(0, Math.min(1, d.shopShare));
        }
        this._changed();
    }

    private _bumpFrom(id: string): void {
        const m = /^ad-(\d+)$/.exec(id);
        if (m) this._next = Math.max(this._next, Number(m[1]) + 1);
    }
    private _changed(): void { this._version++; }
}
