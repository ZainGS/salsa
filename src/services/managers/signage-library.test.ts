/**
 * signage-library.test.ts — ADVERTS persistence (docs/ui/garp.md §Adverts): the image list rides the GARP save,
 * the derived `salsa/signage` page pool is re-built (never saved), layers resolve synchronously, the doc-load
 * clear drops everything, and the world-gen catalog follows the library.
 */
import { describe, it, expect } from 'vitest';
import { GarpManager, GARP_BLANK_LAYER } from './garp-manager';
import { SignageLibrary } from './signage-library';
import { SIGNAGE_POOL_ID, SIGNAGE_SLOT } from '../../world/adverts';

const URL = (n: number) => `data:image/png;base64,${n}`;

describe('SignageLibrary', () => {
    it('adds with stable ids, toggles lit, removes, bumps version, caches the catalog', () => {
        const lib = new SignageLibrary();
        const a = lib.add({ bucket: 'portrait', lit: true, aspect: 0.3, dataUrl: URL(1) });
        const b = lib.add({ bucket: 'square', lit: false, aspect: 1, dataUrl: URL(2), name: 'b.png' });
        expect([a.id, b.id]).toEqual(['ad-1', 'ad-2']);
        const v = lib.version, c1 = lib.catalog();
        expect(lib.catalog()).toBe(c1);                        // cached
        expect(lib.setLit(b.id, true)).toBe(true);
        expect(lib.version).toBeGreaterThan(v);
        expect(lib.catalog()!.entries.find(e => e.id === b.id)!.lit).toBe(true);
        expect(lib.remove(a.id)).toBe(true);
        expect(lib.remove('nope')).toBe(false);
        expect(lib.add({ bucket: 'fascia', lit: true, aspect: 6, dataUrl: URL(3) }).id).toBe('ad-3');   // ids never reused
        lib.clear();
        expect(lib.catalog()).toBeNull();
    });
    it('restore drops malformed rows and keeps ids unique after', () => {
        const lib = new SignageLibrary();
        lib.restore({ v: 1, share: 0.4, images: [
            { id: 'ad-7', bucket: 'landscape', lit: true, aspect: 2, dataUrl: URL(1) },
            { id: 'x', bucket: 'nonsense', lit: true, aspect: 1, dataUrl: URL(2) },
            null,
        ] });
        expect(lib.list().map(i => i.id)).toEqual(['ad-7']);
        expect(lib.share).toBe(0.4);
        expect(lib.add({ bucket: 'square', lit: true, aspect: 1, dataUrl: URL(3) }).id).toBe('ad-8');
    });
});

describe('GarpManager + signage', () => {
    const seed = (m: GarpManager) => {
        m.signage.add({ bucket: 'portrait', lit: true, aspect: 0.3, dataUrl: URL(1) });
        for (let i = 0; i < 5; i++) m.signage.add({ bucket: 'portrait', lit: i % 2 === 0, aspect: 0.25, dataUrl: URL(10 + i) });
        m.signage.add({ bucket: 'fascia', lit: false, aspect: 6, dataUrl: URL(2) });
        return m.syncSignagePool();
    };

    it('syncSignagePool derives one skin per page with a real (non-blank) atlas layer, synchronously', () => {
        const m = new GarpManager();
        const pages = seed(m);
        expect(pages.map(p => p.skin)).toEqual(['portrait-0', 'portrait-1', 'fascia-0']);
        const pool = m.getPool(SIGNAGE_POOL_ID)!;
        expect(pool.skins.map(s => s.name)).toEqual(['portrait-0', 'portrait-1', 'fascia-0']);
        for (const pg of pages) expect(m.layerForSkinName(SIGNAGE_POOL_ID, pg.skin, SIGNAGE_SLOT)).not.toBe(GARP_BLANK_LAYER);
        expect(m.listPools().map(p => p.id)).not.toContain(SIGNAGE_POOL_ID);   // hidden from the Skins panel
        expect(m.hasContent()).toBe(true);
    });

    it('a page that disappears frees its texture; layers of surviving pages never change', () => {
        const m = new GarpManager();
        seed(m);
        const keep = m.layerForSkinName(SIGNAGE_POOL_ID, 'portrait-0', SIGNAGE_SLOT);
        const fas = m.signage.list().find(i => i.bucket === 'fascia')!;
        m.signage.remove(fas.id);
        m.syncSignagePool();
        expect(m.layerForSkinName(SIGNAGE_POOL_ID, 'fascia-0', SIGNAGE_SLOT)).toBe(GARP_BLANK_LAYER);
        expect(m.layerForSkinName(SIGNAGE_POOL_ID, 'portrait-0', SIGNAGE_SLOT)).toBe(keep);
        expect(m.textureBuildList().map(t => t.key)).not.toContain('signage/fascia/0');
        for (const im of [...m.signage.list()]) m.signage.remove(im.id);
        m.syncSignagePool();
        expect(m.getPool(SIGNAGE_POOL_ID)).toBeUndefined();
        expect(m.hasContent()).toBe(false);
    });

    it('persistence round trip: images saved, derived pages NOT saved, re-derived on restore', () => {
        const m = new GarpManager();
        seed(m);
        m.signage.setShare(0.75);
        m.registerTexture('signage/portrait/0', { kind: 'image', dataUrl: 'data:packed' });   // what the packer does
        const json = JSON.parse(JSON.stringify(m.serialize()));
        expect(json.pools.map((p: { id: string }) => p.id)).not.toContain(SIGNAGE_POOL_ID);
        expect(Object.keys(json.textures).some((k: string) => k.startsWith('signage/'))).toBe(false);
        expect(json.signage.images).toHaveLength(7);

        const r = new GarpManager();
        r.restore(json);
        expect(r.signage.list().map(i => [i.id, i.bucket, i.lit, i.aspect])).toEqual(m.signage.list().map(i => [i.id, i.bucket, i.lit, i.aspect]));
        expect(r.signage.share).toBe(0.75);
        expect(r.getPool(SIGNAGE_POOL_ID)!.skins.map(s => s.name)).toEqual(['portrait-0', 'portrait-1', 'fascia-0']);
        expect(r.layerForSkinName(SIGNAGE_POOL_ID, 'portrait-1', SIGNAGE_SLOT)).not.toBe(GARP_BLANK_LAYER);
        expect(r.signage.catalog()).toEqual(m.signage.catalog());   // the city regenerates identically
    });

    it('document-load clear drops the images too (stale-registry rule)', () => {
        const m = new GarpManager();
        seed(m);
        m.clear();
        expect(m.signage.empty).toBe(true);
        expect(m.signage.catalog()).toBeNull();
    });

    it('saves without signage keep their old shape', () => {
        const m = new GarpManager();
        expect(m.serialize()).toEqual({ pools: [], textures: {} });
    });
});
