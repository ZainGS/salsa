/**
 * src/world/adverts.test.ts — ADVERTS (the GARP signage pool, docs/ui/garp.md §Adverts): bucket classification by
 * aspect, page packing, cover-crop UVs, the deterministic pick, face orientation, the EMPTY-POOL fallback being
 * byte-identical to the procedural city, and adverts actually reaching the city's sign faces.
 */
import { describe, it, expect } from 'vitest';
import {
    advertBucketFor, planAdvertPages, advertCellPx, buildAdvertCatalog, coverCropUV, pickAdvert, AdvertSink,
    advertGarpForLayerName, advertLayerTag, ADVERT_PAGE_GRID, ADVERT_PAGE_PX, ADVERT_PAD_PX, SIGNAGE_POOL_ID, SIGNAGE_SLOT,
    type AdvertBucket, type AdvertCatalog,
} from './adverts';
import { buildBuilding } from './building';
import { buildStreets } from './streets';
import { buildSignage } from './signage';
import { generateCityLayout } from './layout';
import type { LayoutParams, LayoutPreviewLayer } from './types';

const img = (id: string, bucket: AdvertBucket, lit = true, aspect = 1) => ({ id, bucket, lit, aspect });
const CAT_ALL: AdvertCatalog = buildAdvertCatalog([
    img('p1', 'portrait', true, 0.3), img('p2', 'portrait', false, 0.25),
    img('l1', 'landscape', true, 2), img('s1', 'square', false, 1), img('f1', 'fascia', true, 6),
])!;

describe('bucket classification by aspect (w / h)', () => {
    it('kanban / square / billboard / fascia', () => {
        expect(advertBucketFor(1, 4)).toBe('portrait');
        expect(advertBucketFor(1, 3)).toBe('portrait');
        expect(advertBucketFor(0.62, 2.6)).toBe('portrait');   // a blade sign
        expect(advertBucketFor(1, 1)).toBe('square');
        expect(advertBucketFor(4, 3)).toBe('square');
        expect(advertBucketFor(16, 9)).toBe('landscape');
        expect(advertBucketFor(3, 1)).toBe('landscape');
        expect(advertBucketFor(6, 1)).toBe('fascia');
        expect(advertBucketFor(12, 1)).toBe('fascia');
        expect(advertBucketFor(1, 0)).toBe('fascia');          // degenerate → widest, never throws
    });
});

describe('page packing', () => {
    it('fills each bucket page row-major, in add order, one bucket per page', () => {
        const ims = [img('a', 'portrait'), img('b', 'square'), img('c', 'portrait'), img('d', 'portrait'), img('e', 'portrait'), img('f', 'portrait')];
        const { pages, slot } = planAdvertPages(ims);
        expect(pages.map(p => [p.skin, p.ids])).toEqual([
            ['portrait-0', ['a', 'c', 'd', 'e']], ['portrait-1', ['f']], ['square-0', ['b']],
        ]);
        expect(slot.get('f')).toEqual({ page: 1, cell: 0 });
        expect(pages[0].key).toBe('signage/portrait/0');
    });

    it('cells tile the page exactly; inner rects are padded and never overlap', () => {
        for (const bucket of ['portrait', 'landscape', 'square', 'fascia'] as AdvertBucket[]) {
            const { cols, rows } = ADVERT_PAGE_GRID[bucket];
            let area = 0;
            const inners = [];
            for (let c = 0; c < cols * rows; c++) {
                const { outer, inner } = advertCellPx(bucket, c);
                area += outer.w * outer.h;
                expect(inner.x - outer.x).toBe(ADVERT_PAD_PX);
                expect(outer.x + outer.w - (inner.x + inner.w)).toBeCloseTo(ADVERT_PAD_PX, 6);
                inners.push(inner);
            }
            expect(area).toBeCloseTo(ADVERT_PAGE_PX * ADVERT_PAGE_PX, 3);
            for (let i = 0; i < inners.length; i++) for (let j = i + 1; j < inners.length; j++) {
                const a = inners[i], b = inners[j];
                const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
                expect(overlap, `${bucket} cells ${i}/${j}`).toBe(false);
            }
        }
    });

    it('cell shapes match the bucket (portrait tall, fascia wide)', () => {
        const p = advertCellPx('portrait', 0).outer, f = advertCellPx('fascia', 0).outer;
        expect(p.h / p.w).toBe(4);
        expect(f.w / f.h).toBe(4);
    });

    it('the catalog rect is the inner cell in page UV', () => {
        const cat = buildAdvertCatalog([img('x', 'landscape'), img('y', 'landscape')])!;
        const y = cat.entries.find(e => e.id === 'y')!;
        expect(y.skin).toBe('landscape-0');
        const { inner } = advertCellPx('landscape', 1);
        expect(y.rect).toEqual([inner.x / 512, inner.y / 512, (inner.x + inner.w) / 512, (inner.y + inner.h) / 512]);
        expect(buildAdvertCatalog([])).toBeNull();
    });
});

describe('cover-crop UVs', () => {
    const R: [number, number, number, number] = [0.2, 0.1, 0.6, 0.9];
    it('same aspect → the whole rect', () => { expect(coverCropUV(R, 2, 2)).toEqual(R); });
    it('image wider than the sign → the sides crop, centred, full height', () => {
        const [u0, v0, u1, v1] = coverCropUV(R, 4, 1);           // keep 1/4 of the width
        expect([v0, v1]).toEqual([0.1, 0.9]);
        expect(u1 - u0).toBeCloseTo(0.1, 9);
        expect((u0 + u1) / 2).toBeCloseTo(0.4, 9);
    });
    it('image taller than the sign → top + bottom crop, centred, full width', () => {
        const [u0, v0, u1, v1] = coverCropUV(R, 0.25, 1);        // keep 1/4 of the height
        expect([u0, u1]).toEqual([0.2, 0.6]);
        expect(v1 - v0).toBeCloseTo(0.2, 9);
        expect((v0 + v1) / 2).toBeCloseTo(0.5, 9);
    });
    it('the crop never leaves the cell', () => {
        for (const ia of [0.1, 0.5, 1, 3, 9]) for (const sa of [0.1, 0.7, 1, 2.5, 12]) {
            const [u0, v0, u1, v1] = coverCropUV(R, ia, sa);
            expect(u0).toBeGreaterThanOrEqual(R[0] - 1e-12); expect(u1).toBeLessThanOrEqual(R[2] + 1e-12);
            expect(v0).toBeGreaterThanOrEqual(R[1] - 1e-12); expect(v1).toBeLessThanOrEqual(R[3] + 1e-12);
            // the shown region has the SIGN's aspect (in image space: du·ia / dv)
            const du = (u1 - u0) / (R[2] - R[0]), dv = (v1 - v0) / (R[3] - R[1]);
            expect(du * ia / dv).toBeCloseTo(sa, 6);
        }
    });
});

describe('deterministic pick', () => {
    it('same (seed, salt) → same image; only its bucket; null for an empty bucket or catalog', () => {
        const a = pickAdvert(CAT_ALL, 'portrait', 42, 7), b = pickAdvert(CAT_ALL, 'portrait', 42, 7);
        expect(a).toBe(b);
        expect(a!.bucket).toBe('portrait');
        expect(pickAdvert(buildAdvertCatalog([img('q', 'square')]), 'portrait', 1, 1)).toBeNull();
        expect(pickAdvert(null, 'square', 1, 1)).toBeNull();
    });
    it('spreads over the bucket', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) seen.add(pickAdvert(CAT_ALL, 'portrait', 9, i)!.id);
        expect(seen).toEqual(new Set(['p1', 'p2']));
    });
    it('rendezvous: adding an image only re-picks the signs it wins', () => {
        const base = buildAdvertCatalog([img('a', 'square'), img('b', 'square'), img('c', 'square')])!;
        const more = buildAdvertCatalog([img('a', 'square'), img('b', 'square'), img('c', 'square'), img('d', 'square')])!;
        let moved = 0;
        for (let i = 0; i < 400; i++) {
            const x = pickAdvert(base, 'square', 5, i)!.id, y = pickAdvert(more, 'square', 5, i)!.id;
            if (x !== y) { moved++; expect(y).toBe('d'); }
        }
        expect(moved).toBeGreaterThan(40);    // ~1/4 go to the new image …
        expect(moved).toBeLessThan(170);      // … the rest keep theirs
    });
    it('share gates the fraction of signs', () => {
        const half = { ...CAT_ALL, share: 0.5 }, none = { ...CAT_ALL, share: 0 };
        let n = 0;
        for (let i = 0; i < 400; i++) if (pickAdvert(half, 'square', 3, i)) n++;
        expect(n).toBeGreaterThan(140); expect(n).toBeLessThan(260);
        expect(pickAdvert(none, 'square', 3, 1)).toBeNull();
    });
});

describe('AdvertSink faces', () => {
    it('a face is a quad facing n, u running to the viewer\'s right, v=0 at the top, UVs inside the cell', () => {
        const sink = new AdvertSink(buildAdvertCatalog([img('s', 'square', false, 1)]), 1);
        const n: [number, number, number] = [0, 0, 1];
        expect(sink.face([0, 5, 0], n, 2, 2, 11, false, 0.01)).toBe(true);
        const [L] = sink.layers('bldg:', 0, 0.9, 0.14);
        expect(L.name).toBe('bldg:' + advertLayerTag('square-0', false));
        expect(L.garp).toEqual({ pool: SIGNAGE_POOL_ID, slot: SIGNAGE_SLOT, seed: 0, skin: 'square-0' });
        const v = L.geometry.vertices as Float32Array;
        const rect = buildAdvertCatalog([img('s', 'square', false, 1)])!.entries[0].rect;
        for (let i = 0; i < 4; i++) {
            const o = i * 12, x = v[o], y = v[o + 1], z = v[o + 2], u = v[o + 6], vv = v[o + 7];
            expect([v[o + 3], v[o + 4], v[o + 5]]).toEqual([0, 0, 1]);
            expect(z).toBeCloseTo(0.01, 6);                          // lifted off the face
            // facing +z the viewer's right is +x: u grows with x, v shrinks with y (image top = v0)
            expect(u).toBeCloseTo(x > 0 ? rect[2] : rect[0], 6);
            expect(vv).toBeCloseTo(y > 5 ? rect[1] : rect[3], 6);
        }
        // winding is CCW about n (so a single-sided consumer would see it)
        const idx = L.geometry.indices as Uint32Array;
        const p = (k: number) => [v[k * 12], v[k * 12 + 1], v[k * 12 + 2]];
        const [a, b, c] = [p(idx[0]), p(idx[1]), p(idx[2])];
        const cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        expect(cz).toBeGreaterThan(0);
    });
    it('lit + unlit images land in separate layers; forceLit (screens) is always lit', () => {
        const sink = new AdvertSink(buildAdvertCatalog([img('u', 'square', false)]), 1);
        sink.face([0, 0, 0], [1, 0, 0], 1, 1, 1);
        sink.face([0, 0, 0], [1, 0, 0], 1, 1, 2, true);
        expect(sink.layers('bldg:', 0, 1, 0).map(l => l.name).sort()).toEqual(['bldg:sign-advert-lit-square-0', 'bldg:sign-advert-square-0']);
    });
    it('the GARP marker survives the city\'s merge + rename', () => {
        expect(advertGarpForLayerName('world:detail-sign-advert-lit-portrait-3#2,1')).toMatchObject({ skin: 'portrait-3' });
        expect(advertGarpForLayerName('world:detail-sign-b')).toBeNull();
    });
});

// ── the city ───────────────────────────────────────────────────────────────────────────────────────
const CITY = { seed: 7, radius: 10, pattern: 'grid', border: 'square' } as unknown as Partial<LayoutParams>;
const sig = (ls: LayoutPreviewLayer[]): string[] => ls.map(L => {
    const v = L.geometry.vertices as Float32Array;
    let h = 0; for (let i = 0; i < v.length; i += 7) h = (h * 31 + Math.round(v[i] * 1000)) | 0;
    return `${L.name}|${v.length}|${L.geometry.indices.length}|${h}|${JSON.stringify(L.garp ?? null)}`;
});
const cityLayers = (over: Partial<LayoutParams>) => buildStreets(generateCityLayout({ ...CITY, ...over } as Partial<LayoutParams>));

describe('empty pool → the procedural city, byte-identical', () => {
    it('buildBuilding: no catalog == an empty catalog == null', () => {
        for (const archetype of ['zakkyo', 'konbini', 'neon-arcade', 'mall', 'retro-shophouse']) {
            const a = buildBuilding({ archetype, seed: 11 }).layers;
            const b = buildBuilding({ archetype, seed: 11, adverts: { share: 1, entries: [] } }).layers;
            const c = buildBuilding({ archetype, seed: 11, adverts: null }).layers;
            expect(sig(b)).toEqual(sig(a));
            expect(sig(c)).toEqual(sig(a));
        }
    });
    it('the whole detailed streetscape is unchanged', () => {
        expect(sig(cityLayers({ adverts: { share: 1, entries: [] } }))).toEqual(sig(cityLayers({})));
    });
    it('the simple (non-detailed) signage pass is unchanged', () => {
        const g0 = generateCityLayout({ ...CITY, detailedBuildings: false } as Partial<LayoutParams>);
        const g1 = generateCityLayout({ ...CITY, detailedBuildings: false, adverts: { share: 1, entries: [] } } as Partial<LayoutParams>);
        buildStreets(g0); buildStreets(g1);
        expect(sig(buildSignage(g1))).toEqual(sig(buildSignage(g0)));
    });
});

describe('adverts reach the city', () => {
    it('a sign-heavy building swaps lettering for images on every bucket it has', () => {
        const plain = buildBuilding({ archetype: 'zakkyo', seed: 11 }).layers;
        const withAds = buildBuilding({ archetype: 'zakkyo', seed: 11, adverts: CAT_ALL }).layers;
        const ads = withAds.filter(L => /sign-advert/.test(L.name));
        expect(ads.length).toBeGreaterThan(0);
        for (const L of ads) { expect(L.garp?.pool).toBe(SIGNAGE_POOL_ID); expect(L.pattern).toBeUndefined(); }
        const text = (ls: LayoutPreviewLayer[]) => ls.find(L => L.name === 'bldg:sign-text')?.geometry.indices.length ?? 0;
        expect(text(withAds)).toBeLessThan(text(plain));   // lettering skipped where an image went
        // the sign boxes themselves are untouched (the image sits proud of the box face)
        expect(sig(withAds.filter(L => /^bldg:sign(-b|-c)?$/.test(L.name)))).toEqual(sig(plain.filter(L => /^bldg:sign(-b|-c)?$/.test(L.name))));
    });
    it('only buckets with images change: a portrait-only pool leaves wide signs lettered', () => {
        const cat = buildAdvertCatalog([img('p', 'portrait', true, 0.3)])!;
        const ads = buildBuilding({ archetype: 'zakkyo', seed: 11, adverts: cat }).layers.filter(L => /sign-advert/.test(L.name));
        expect(ads.every(L => /portrait-0/.test(L.name))).toBe(true);
    });
    it('the detailed city carries GARP-marked advert layers, deterministic across builds', () => {
        const a = cityLayers({ adverts: CAT_ALL }), b = cityLayers({ adverts: CAT_ALL });
        const ads = a.filter(L => /world:detail-sign-advert/.test(L.name));
        expect(ads.length).toBeGreaterThan(0);
        for (const L of ads) expect(L.garp).toMatchObject({ pool: SIGNAGE_POOL_ID, slot: SIGNAGE_SLOT });
        // ONE-FAMILY-PER-MESH (city-materials.test.ts): an image face claims none of the shared-slot families
        for (const L of ads) for (const f of ['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'] as const) expect((L as unknown as Record<string, unknown>)[f], `${L.name} ${f}`).toBeUndefined();
        expect(sig(b)).toEqual(sig(a));
    });
    it('the simple signage pass puts images on its signs too', () => {
        const g = generateCityLayout({ ...CITY, detailedBuildings: false, adverts: CAT_ALL } as Partial<LayoutParams>);
        buildStreets(g);
        const ads = buildSignage(g).filter(L => /world:sign-advert/.test(L.name));
        expect(ads.length).toBeGreaterThan(0);
        expect(ads.every(L => L.garp?.skin)).toBe(true);
    });
});

// ── SHOP WINDOWS (persona-polish C4): the interior / poster buckets ─────────────────────────────────────
describe('shop-window images (interior + poster buckets)', () => {
    const SHOP = buildAdvertCatalog([img('i1', 'interior', true, 2), img('i2', 'interior', true, 1.5), img('po', 'poster', false, 0.7)])!;
    it('a sign never picks a shop bucket; the shop share gates shop picks only', () => {
        const sink = new AdvertSink(SHOP, 3);
        for (const [w, h] of [[0.6, 2.6], [1, 1], [3, 1], [6, 0.5]]) expect(sink.pick(w, h, 5)).toBeNull();
        expect(sink.pickIn('interior', 5)?.bucket).toBe('interior');
        const none = buildAdvertCatalog([img('i1', 'interior', true, 2)], 1, 0)!;
        expect(new AdvertSink(none, 3).pickIn('interior', 5)).toBeNull();
        expect(none.shopShare).toBe(0);
        expect(SHOP.shopShare).toBeUndefined();   // default 1 is not written
    });
    it('shop pages pack after the sign buckets (existing pages keep their slots)', () => {
        const { pages } = planAdvertPages([img('a', 'poster'), img('b', 'portrait'), img('c', 'interior')]);
        expect(pages.map(p => p.bucket)).toEqual(['portrait', 'interior', 'poster']);
        expect(ADVERT_PAGE_GRID.interior.cols * ADVERT_PAGE_GRID.interior.rows).toBe(2);
    });
    it('an image-interior bay becomes a recessed room behind a clear pane; posters go on the glass', () => {
        const plain = buildBuilding({ archetype: 'konbini', seed: 21 }).layers;
        const withShop = buildBuilding({ archetype: 'konbini', seed: 21, adverts: SHOP }).layers;
        const names = withShop.map(L => L.name);
        expect(names).toContain('bldg:shop-room');
        expect(names).toContain('bldg:shop-glass-pane');
        expect(names.some(n => /sign-advert(-lit)?-interior-0/.test(n))).toBe(true);
        const pane = withShop.find(L => L.name === 'bldg:shop-glass-pane')!;
        expect(pane.opacity).toBeLessThan(0.5);
        // image bays no longer draw the procedural shader cell
        const cells = (ls: LayoutPreviewLayer[]) => ls.find(L => L.name === 'bldg:shop-glass')?.geometry.indices.length ?? 0;
        expect(cells(withShop)).toBeLessThan(cells(plain));
        // the signs are untouched by shop images
        expect(sig(withShop.filter(L => /^bldg:sign/.test(L.name) && !/advert/.test(L.name)))).toEqual(sig(plain.filter(L => /^bldg:sign/.test(L.name))));
        // ONE-FAMILY-PER-MESH for the new layers
        for (const L of withShop.filter(L => /shop-room|shop-glass-pane|interior|poster/.test(L.name))) {
            expect(['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'].filter(f => (L as unknown as Record<string, unknown>)[f] != null), L.name).toEqual([]);
        }
    });
    it('the city keeps the clear pane translucent through the detail merge, deterministically', () => {
        const a = cityLayers({ adverts: SHOP }), b = cityLayers({ adverts: SHOP });
        const panes = a.filter(L => /world:detail-shop-glass-pane/.test(L.name));
        expect(panes.length).toBeGreaterThan(0);
        for (const L of panes) expect(L.opacity).toBeLessThan(0.5);
        expect(a.some(L => /world:detail-sign-advert(-lit)?-interior/.test(L.name))).toBe(true);
        expect(sig(b)).toEqual(sig(a));
    });
});
