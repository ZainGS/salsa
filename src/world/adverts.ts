// ── World generation — ADVERTS: the GARP signage pool (docs/ui/garp.md §Adverts) ─────────────────────
// The user's own images on the city's advertising signage (the dense real-image kanban / billboards of a Shibuya
// street). PURE + worker-safe: the city generator (main thread OR the tile Worker) only ever sees an
// {@link AdvertCatalog} — plain JSON metadata (ids, buckets, lit flags, aspects, page-cell rects), never pixels.
//
// Model:
//   · Every image lives in one of four ASPECT BUCKETS (portrait kanban · landscape billboard · square · fascia
//     strip). Services pack each bucket's images into 512² PAGES (a fixed grid of padded cells per bucket, each
//     image STRETCHED to its cell, edge pixels bled into the padding). A page is ONE GARP texture: pool
//     `salsa/signage`, slot `sheet`, skin `<bucket>-<page>` (so a page resolves to a GARP atlas layer by NAME).
//   · Every sign face the building generator emits is classified by its OWN aspect ({@link advertBucketFor}) and
//     picks an image of that bucket by a deterministic hash (rendezvous — adding an image only re-picks the signs
//     it now wins). The face's UVs COVER-CROP the image to the sign's real aspect, centred ({@link coverCropUV}).
//   · Faces merge per (page, lit) → one mesh per page per detail cell; lit = backlit (glows at night through the
//     city glow table), unlit = a poster (lit by the scene).
//   · No catalog / an empty bucket → the sign keeps its procedural colour box + lettering, byte-identical to
//     before (saved cities regenerate unchanged). No RNG stream is consumed here — picks are pure hashes.
//   · SHOP IMAGES (persona-polish C4) ride the same pool as two more buckets that no sign ever classifies into:
//     'interior' (the back wall of a recessed shop room seen through clear glass — real parallax) and 'poster'
//     (sheets on the inside of the shop glass). An empty shop bucket → the shader's procedural shelves, untouched.

import { Accum3D } from './meshbuild';
import type { LayoutPreviewLayer } from './types';

type V3 = [number, number, number];

export type AdvertBucket = 'portrait' | 'landscape' | 'square' | 'fascia' | 'interior' | 'poster';
/** Stable bucket order (page planning walks it — never reorder, or saved pages re-pack differently; new buckets
 *  APPEND). */
export const ADVERT_BUCKETS: readonly AdvertBucket[] = ['portrait', 'landscape', 'square', 'fascia', 'interior', 'poster'];
/** The SIGN buckets (a sign face classifies into one of these by aspect — {@link advertBucketFor}). */
export const SIGN_BUCKETS: readonly AdvertBucket[] = ['portrait', 'landscape', 'square', 'fascia'];
/** The SHOP-WINDOW buckets (persona-polish C4): shop interiors + posters on the glass. Never picked by a sign. */
export type ShopImageBucket = 'interior' | 'poster';
export const SHOP_BUCKETS: readonly ShopImageBucket[] = ['interior', 'poster'];
export const isShopBucket = (b: unknown): b is ShopImageBucket => b === 'interior' || b === 'poster';

export const SIGNAGE_POOL_ID = 'salsa/signage';
export const SIGNAGE_SLOT = 'sheet';
/** Page size (the GARP atlas resolution) + padding per cell side, in px. */
export const ADVERT_PAGE_PX = 512;
export const ADVERT_PAD_PX = 4;

/** Cells per page, per bucket. The cell shape matches the bucket's nominal aspect, so an image keeps its
 *  resolution where it matters: portrait 128×512 (1:4), landscape 512×256 (2:1), square 256², fascia 512×128 (4:1). */
export const ADVERT_PAGE_GRID: Readonly<Record<AdvertBucket, { cols: number; rows: number }>> = {
    portrait: { cols: 4, rows: 1 },
    landscape: { cols: 1, rows: 2 },
    square: { cols: 2, rows: 2 },
    fascia: { cols: 1, rows: 4 },
    interior: { cols: 1, rows: 2 },   // 512×256 (2:1) — a shop's back wall, cover-cropped to each bay
    poster: { cols: 3, rows: 2 },     // 170×256 (~1:1.5) — A-series posters
};

/** Host-facing bucket descriptions (width / height aspect ranges; `recommendedPx` = a good authoring size). */
export const ADVERT_BUCKET_INFO: Readonly<Record<AdvertBucket, { label: string; minAspect: number; maxAspect: number; nominal: string; recommendedPx: [number, number] }>> = {
    portrait: { label: 'Vertical kanban', minAspect: 0, maxAspect: 0.6, nominal: '1:3 – 1:4', recommendedPx: [256, 1024] },
    square: { label: 'Square', minAspect: 0.6, maxAspect: 1.4, nominal: '1:1', recommendedPx: [512, 512] },
    landscape: { label: 'Billboard / screen', minAspect: 1.4, maxAspect: 4, nominal: '16:9 – 3:1', recommendedPx: [1024, 512] },
    fascia: { label: 'Shop fascia strip', minAspect: 4, maxAspect: Infinity, nominal: '~6:1', recommendedPx: [1536, 256] },
    interior: { label: 'Shop interior', minAspect: 1, maxAspect: 3, nominal: '3:2 – 2:1', recommendedPx: [1024, 512] },
    poster: { label: 'Window poster', minAspect: 0.4, maxAspect: 1, nominal: '1:1.4', recommendedPx: [512, 724] },
};

/** The bucket for a sign (or image) of width `w` × height `h` — classified by aspect w/h. */
export function advertBucketFor(w: number, h: number): AdvertBucket {
    const a = h > 0 ? w / h : Infinity;
    if (a < ADVERT_BUCKET_INFO.portrait.maxAspect) return 'portrait';
    if (a < ADVERT_BUCKET_INFO.square.maxAspect) return 'square';
    if (a < ADVERT_BUCKET_INFO.landscape.maxAspect) return 'landscape';
    return 'fascia';
}

export const isAdvertBucket = (b: unknown): b is AdvertBucket => typeof b === 'string' && (ADVERT_BUCKETS as readonly string[]).includes(b);

/** GARP skin name + texture key of a bucket's page. */
export const advertPageSkin = (bucket: AdvertBucket, page: number): string => `${bucket}-${page}`;
export const advertPageKey = (bucket: AdvertBucket, page: number): string => `signage/${bucket}/${page}`;

/** A cell's pixel rect on its page: `outer` (the whole cell, padding included — the bleed target) and `inner` (where
 *  the image is drawn, inset by the padding). */
export function advertCellPx(bucket: AdvertBucket, cell: number, size = ADVERT_PAGE_PX, pad = ADVERT_PAD_PX): { outer: { x: number; y: number; w: number; h: number }; inner: { x: number; y: number; w: number; h: number } } {
    const { cols, rows } = ADVERT_PAGE_GRID[bucket];
    const cw = size / cols, ch = size / rows;
    const x = (cell % cols) * cw, y = Math.floor(cell / cols) * ch;
    return { outer: { x, y, w: cw, h: ch }, inner: { x: x + pad, y: y + pad, w: cw - 2 * pad, h: ch - 2 * pad } };
}

export interface AdvertPage { bucket: AdvertBucket; page: number; skin: string; key: string; ids: string[] }

/** Assign every image a (page, cell): buckets in {@link ADVERT_BUCKETS} order, images in list order, filling each
 *  page's cells row-major. Deterministic from the list alone (the library's add order). */
export function planAdvertPages(images: readonly { id: string; bucket: AdvertBucket }[]): { pages: AdvertPage[]; slot: Map<string, { page: number; cell: number }> } {
    const pages: AdvertPage[] = [];
    const slot = new Map<string, { page: number; cell: number }>();
    for (const bucket of ADVERT_BUCKETS) {
        const per = ADVERT_PAGE_GRID[bucket].cols * ADVERT_PAGE_GRID[bucket].rows;
        const ids = images.filter(im => im.bucket === bucket).map(im => im.id);
        for (let i = 0; i < ids.length; i++) {
            const page = Math.floor(i / per), cell = i % per;
            if (cell === 0) pages.push({ bucket, page, skin: advertPageSkin(bucket, page), key: advertPageKey(bucket, page), ids: [] });
            pages[pages.length - 1].ids.push(ids[i]);
            slot.set(ids[i], { page, cell });
        }
    }
    return { pages, slot };
}

/** One placeable image as world-gen sees it. `rect` = the image's INNER cell on its page, in page UV (0..1, y-down —
 *  v=0 is the image top). `aspect` = the source image's width / height (for the cover crop). */
export interface AdvertEntry { id: string; bucket: AdvertBucket; lit: boolean; aspect: number; skin: string; rect: [number, number, number, number] }
/** What the city generator receives (via `LayoutParams.adverts`). `share` = fraction of eligible signs that show an
 *  image (the rest keep their procedural lettering), 0..1. `shopShare` = the same for shop windows (interior /
 *  poster buckets); absent = 1. */
export interface AdvertCatalog { share: number; entries: AdvertEntry[]; shopShare?: number }

/** Build the world-gen catalog from the library's image list (null when there are no images → procedural city). */
export function buildAdvertCatalog(images: readonly { id: string; bucket: AdvertBucket; lit: boolean; aspect: number }[], share = 1, shopShare = 1): AdvertCatalog | null {
    if (!images.length) return null;
    const { slot } = planAdvertPages(images);
    const entries: AdvertEntry[] = images.map(im => {
        const s = slot.get(im.id)!;
        const { inner } = advertCellPx(im.bucket, s.cell);
        const P = ADVERT_PAGE_PX;
        return { id: im.id, bucket: im.bucket, lit: im.lit, aspect: im.aspect > 0 && Number.isFinite(im.aspect) ? im.aspect : 1,
            skin: advertPageSkin(im.bucket, s.page), rect: [inner.x / P, inner.y / P, (inner.x + inner.w) / P, (inner.y + inner.h) / P] };
    });
    const cat: AdvertCatalog = { share: Math.max(0, Math.min(1, Number.isFinite(share) ? share : 1)), entries };
    if (shopShare !== 1) cat.shopShare = Math.max(0, Math.min(1, Number.isFinite(shopShare) ? shopShare : 1));
    return cat;
}

/** COVER crop: the sub-rect of `rect` that shows the image (stretched across the whole rect) at the SIGN's aspect,
 *  centred — the image fills the sign, and whichever axis overflows is cropped equally from both sides. */
export function coverCropUV(rect: readonly [number, number, number, number], imageAspect: number, signAspect: number): [number, number, number, number] {
    const [u0, v0, u1, v1] = rect;
    const ia = imageAspect > 0 && Number.isFinite(imageAspect) ? imageAspect : 1;
    const sa = signAspect > 0 && Number.isFinite(signAspect) ? signAspect : 1;
    if (ia > sa) {   // image wider than the sign → crop the sides; keep fraction sa/ia of the width
        const f = sa / ia, du = (u1 - u0) * (1 - f) / 2;
        return [u0 + du, v0, u1 - du, v1];
    }
    const f = ia / sa, dv = (v1 - v0) * (1 - f) / 2;   // image taller → crop top + bottom
    return [u0, v0 + dv, u1, v1 - dv];
}

// ── Deterministic pick ──────────────────────────────────────────────────────────────────────────────
const mix32 = (a: number, b: number): number => {
    let h = Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) >>> 0, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
};
const strHash = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
};
const unit = (h: number): number => (h + 0.5) / 4294967296;   // (0,1), never 0 or 1

/** Pick an image of `bucket` for the sign identified by (seed, salt) — or null (no images in the bucket, or the sign
 *  fell outside `share`). WEIGHTED-RENDEZVOUS by image id (like GARP's pickSkin): adding / removing one image only
 *  changes the signs that image wins / loses; every other sign keeps its picture across regens. */
export function pickAdvert(cat: AdvertCatalog | null | undefined, bucket: AdvertBucket, seed: number, salt: number): AdvertEntry | null {
    if (!cat || !cat.entries.length) return null;
    const key = mix32(seed >>> 0, salt >>> 0);
    const share = isShopBucket(bucket) ? (cat.shopShare ?? 1) : cat.share;
    if (share < 1 && unit(mix32(key, 0x5a4e)) >= share) return null;
    let best: AdvertEntry | null = null, bestScore = -Infinity;
    for (const e of cat.entries) {
        if (e.bucket !== bucket) continue;
        const score = 1 / -Math.log(unit(mix32(key, strHash(e.id))));
        if (score > bestScore || (score === bestScore && best && e.id < best.id)) { bestScore = score; best = e; }
    }
    return best;
}

/** The layer-name tag of an advert mesh: `sign-advert-[lit-]<skin>` (the city's name classifiers key off it: the
 *  glow table, the drape tier, the detail-material classifier). */
export const advertLayerTag = (skin: string, lit: boolean): string => `sign-advert-${lit ? 'lit-' : ''}${skin}`;
const TAG_RE = /sign-advert-(?:lit-)?([a-z]+-\d+)/;
/** The GARP marker for a (possibly merged + renamed) advert layer, recovered from its name — null for any other. */
export function advertGarpForLayerName(name: string): { pool: string; slot: string; seed: number; skin: string } | null {
    const m = TAG_RE.exec(name);
    return m ? { pool: SIGNAGE_POOL_ID, slot: SIGNAGE_SLOT, seed: 0, skin: m[1] } : null;
}

/** Collects advert faces for ONE builder (a building, or the city's simple signage pass) and turns them into
 *  per-(page, lit) layers. `seed` identifies the builder; each sign passes its own `salt`. */
export class AdvertSink {
    private readonly accs = new Map<string, { skin: string; lit: boolean; acc: Accum3D }>();
    constructor(private readonly cat: AdvertCatalog | null | undefined, private readonly seed: number) {}

    /** The image this sign would show (null → procedural). Same (salt, bucket) → same pick, so a two-faced blade
     *  sign shows one picture on both faces. */
    pick(w: number, h: number, salt: number): AdvertEntry | null {
        return pickAdvert(this.cat, advertBucketFor(w, h), this.seed, salt);
    }
    /** The image of an explicit `bucket` for (this builder, salt) — the shop-window buckets pick this way. */
    pickIn(bucket: AdvertBucket, salt: number): AdvertEntry | null {
        return pickAdvert(this.cat, bucket, this.seed, salt);
    }
    /** Does the catalog hold any image of `bucket`? (cheap gate before building shop-window geometry) */
    has(bucket: AdvertBucket): boolean { return !!this.cat && this.cat.entries.some(e => e.bucket === bucket); }

    /** Cover the sign face centred at `c` (on the face plane) with normal `n` (unit, horizontal), size `w` × `h`, with
     *  its picked image, `lift` proud of the face. Returns true when an image was placed (the caller then skips the
     *  procedural lettering). `forceLit` = always backlit (LED screens). */
    face(c: V3, n: V3, w: number, h: number, salt: number, forceLit = false, lift = 0.012): boolean {
        if (!(w > 0 && h > 0)) return false;
        const e = this.pick(w, h, salt);
        return !!e && this.place(e, c, n, w, h, forceLit, lift);
    }
    /** {@link face} with an explicit bucket (shop interiors / posters). */
    faceIn(bucket: AdvertBucket, c: V3, n: V3, w: number, h: number, salt: number, forceLit = false, lift = 0.012): boolean {
        if (!(w > 0 && h > 0)) return false;
        const e = this.pickIn(bucket, salt);
        return !!e && this.place(e, c, n, w, h, forceLit, lift);
    }
    /** Place entry `e` as a quad (see {@link face}). */
    place(e: AdvertEntry, c: V3, n: V3, w: number, h: number, forceLit = false, lift = 0.012): boolean {
        if (!(w > 0 && h > 0)) return false;
        const lit = forceLit || e.lit;
        const k = e.skin + (lit ? '|L' : '|U');
        let slot = this.accs.get(k);
        if (!slot) { slot = { skin: e.skin, lit, acc: new Accum3D() }; this.accs.set(k, slot); }
        const [u0, v0, u1, v1] = coverCropUV(e.rect, e.aspect, w / h);
        // right = UP × n: the viewer's right when facing the sign (right-handed, y up) → the image never mirrors.
        const r: V3 = [n[2], 0, -n[0]];
        const hw = w / 2, hh = h / 2;
        const P = (sx: number, sy: number): V3 => [c[0] + r[0] * sx * hw + n[0] * lift, c[1] + sy * hh, c[2] + r[2] * sx * hw + n[2] * lift];
        const a = slot.acc;
        const bl = a.vertex(P(-1, -1), n, u0, v1), br = a.vertex(P(1, -1), n, u1, v1);
        const tr = a.vertex(P(1, 1), n, u1, v0), tl = a.vertex(P(-1, 1), n, u0, v0);
        a.triangle(bl, br, tr); a.triangle(bl, tr, tl);   // CCW about n
        return true;
    }

    get empty(): boolean { return this.accs.size === 0; }

    /** One layer per (page, lit): white base (the image IS the colour), GARP-sampled by page skin. `prefix` = the
     *  builder's layer namespace ('bldg:' / 'world:'). */
    layers(prefix: string, y: number, litEmissive: number, unlitEmissive: number): LayoutPreviewLayer[] {
        const out: LayoutPreviewLayer[] = [];
        for (const { skin, lit, acc } of this.accs.values()) {
            if (acc.empty) continue;
            out.push({ name: prefix + advertLayerTag(skin, lit), color: [1, 1, 1], y, geometry: acc.geometry(),
                emissive: lit ? litEmissive : unlitEmissive, garp: { pool: SIGNAGE_POOL_ID, slot: SIGNAGE_SLOT, seed: 0, skin } });
        }
        return out;
    }
}
