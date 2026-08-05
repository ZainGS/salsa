/**
 * src/services/managers/garp-manager.test.ts — the dedicated GARP registry (docs/specs/city-props-garp.md §2).
 *
 * The load-bearing properties: (1) pools are keyed by their STABLE `id`, not the display name; (2) atlas layers
 * are assigned per session in registration order and never move (nothing serialized ever holds a layer index —
 * a saved city stores skin NAMES only, resolved to layers each session); (3) a pool registered before its skin
 * textures resolve reports NOT-resolved and hands consumers the blank/default layer rather than a race.
 */

import { describe, it, expect } from 'vitest';
import { GarpManager, GARP_BLANK_LAYER } from './garp-manager';
import type { GarpPool } from '../../world/garp';
import type { DecalSource } from './decal-geometry';

const src = (id: string): DecalSource => ({ kind: 'image', dataUrl: `data:image/png;base64,${id}` });

const pool = (over: Partial<GarpPool> = {}): GarpPool => ({
    id: 'salsa/vending', name: 'vending', version: 1, size: [512, 512], slots: ['fascia', 'products'],
    skins: [
        { name: 'pocari', slots: { fascia: 'pocari-fascia', products: 'pocari-cans' } },
        { name: 'coffee', slots: { fascia: 'coffee-fascia', products: 'coffee-cans' } },
    ],
    ...over,
});

describe('GarpManager — stable layer assignment', () => {
    it('assigns layers in registration order, starting after the blank layer, and never moves them', () => {
        const m = new GarpManager();
        const a = m.registerTexture('a', src('a'));
        const b = m.registerTexture('b', src('b'));
        expect(a).toBe(1);                       // 0 is the reserved blank layer
        expect(b).toBe(2);
        expect(m.registerTexture('a', src('a2'))).toBe(1);   // re-register same key → same stable layer
        expect(m.layerOf('a')).toBe(1);
        expect(m.layerOf('nope')).toBe(GARP_BLANK_LAYER);    // unknown key → blank
        expect(m.layerOf(null)).toBe(GARP_BLANK_LAYER);
    });

    it('textureBuildList is layer-ordered so the renderer can upload straight into the array', () => {
        const m = new GarpManager();
        m.registerTexture('x', src('x')); m.registerTexture('y', src('y'));
        expect(m.textureBuildList().map((t) => [t.key, t.layer])).toEqual([['x', 1], ['y', 2]]);
    });
});

describe('GarpManager — pool registry keyed by stable id', () => {
    it('keys pools by id, not display name', () => {
        const m = new GarpManager();
        expect(m.registerPool(pool())).toEqual([]);            // valid → no errors
        expect(m.getPool('salsa/vending')?.name).toBe('vending');
        expect(m.getPool('vending')).toBeUndefined();          // NOT reachable by display name
        expect(m.listPools()[0]).toMatchObject({ id: 'salsa/vending', version: 1 });
        expect(m.listPools()[0].skins).toEqual([{ name: 'pocari' }, { name: 'coffee' }]);   // the LIST, not a count
        expect(m.removePool('salsa/vending')).toBe(true);
        expect(m.getPool('salsa/vending')).toBeUndefined();
    });
});

describe('GarpManager — addSkin (user-authored variants) + persistence', () => {
    it('addSkin appends a variant, bumps the pool version, and replaces by name', () => {
        const m = new GarpManager();
        m.registerPool(pool());
        m.registerTexture('coke-fascia', src('coke'));
        expect(m.addSkin('salsa/vending', { name: 'coke', slots: { fascia: 'coke-fascia', products: 'coke-fascia' } })).toEqual([]);
        expect(m.getPool('salsa/vending')!.skins.map((s) => s.name)).toContain('coke');
        expect(m.getPool('salsa/vending')!.version).toBe(2);            // bumped from 1
        // Re-adding the same name REPLACES (no duplicate).
        m.addSkin('salsa/vending', { name: 'coke', slots: { fascia: 'coke-fascia', products: 'coke-fascia' } });
        expect(m.getPool('salsa/vending')!.skins.filter((s) => s.name === 'coke')).toHaveLength(1);
        expect(m.addSkin('no/such', { name: 'x', slots: {} })[0]).toMatch(/no pool/);
    });

    it('removeSkin drops the skin + frees its unshared textures; listPools reflects it', () => {
        const m = new GarpManager();
        m.registerPool(pool());
        m.registerTexture('pocari-fascia', src('pf'));
        expect(m.layerOf('pocari-fascia')).not.toBe(GARP_BLANK_LAYER);
        expect(m.removeSkin('salsa/vending', 'pocari')).toEqual([]);
        expect(m.getPool('salsa/vending')!.skins.map((s) => s.name)).not.toContain('pocari');
        expect(m.getPool('salsa/vending')!.version).toBe(2);         // bumped
        expect(m.layerOf('pocari-fascia')).toBe(GARP_BLANK_LAYER);   // its unshared texture was freed
        expect(m.removeSkin('no/such', 'x')[0]).toMatch(/no pool/);
    });

    it('setSlotLive drives listPools per-slot live (default true; engine marks non-wired slots false)', () => {
        const m = new GarpManager();
        m.registerPool(pool());
        const before = m.listPools()[0].slots;
        expect(before).toEqual([{ name: 'fascia', live: true }, { name: 'products', live: true }]);   // default live
        m.setSlotLive('salsa/vending', 'products', false);
        expect(m.listPools()[0].slots.find((s) => s.name === 'products')!.live).toBe(false);
        expect(m.listPools()[0].slots.find((s) => s.name === 'fascia')!.live).toBe(true);
        m.setSlotLive('salsa/vending', 'products', true);            // reversible
        expect(m.listPools()[0].slots.find((s) => s.name === 'products')!.live).toBe(true);
    });

    it('serialize → restore round-trips pools + texture sources (layers reassigned, nothing layer-indexed saved)', () => {
        const a = new GarpManager();
        a.registerPool(pool());
        a.registerTexture('pocari-fascia', src('pf'));
        a.registerTexture('pocari-cans', src('pc'));
        const snap = a.serialize();
        expect(snap.pools).toHaveLength(1);
        expect(Object.keys(snap.textures)).toContain('pocari-fascia');
        // A fresh manager restores identically — the skin resolves to a real (non-blank) layer again.
        const b = new GarpManager();
        b.restore(snap);
        expect(b.getPool('salsa/vending')?.name).toBe('vending');
        expect(b.skinLayer('salsa/vending', pool().skins[0], 'fascia')).toBe(b.layerOf('pocari-fascia'));
        expect(b.layerOf('pocari-fascia')).not.toBe(GARP_BLANK_LAYER);
    });
});

describe('GarpManager — pending state (async texture resolve)', () => {
    it('a pool whose textures are not yet registered is NOT resolved and hands out the blank layer', () => {
        const m = new GarpManager();
        m.registerPool(pool());
        expect(m.poolResolved('salsa/vending')).toBe(false);
        // Consumers picking a skin before textures load get the blank layer, not garbage.
        expect(m.skinLayer('salsa/vending', pool().skins[0], 'fascia')).toBe(GARP_BLANK_LAYER);
    });

    it('becomes resolved once every referenced texture is registered, then hands out real layers', () => {
        const m = new GarpManager();
        const p = pool();
        m.registerPool(p);
        for (const skin of p.skins) for (const slot of p.slots) m.registerTexture(skin.slots[slot], src(skin.slots[slot]));
        expect(m.poolResolved('salsa/vending')).toBe(true);
        expect(m.skinLayer('salsa/vending', p.skins[0], 'fascia')).toBe(m.layerOf('pocari-fascia'));
        expect(m.skinLayer('unknown/pool', p.skins[0], 'fascia')).toBe(GARP_BLANK_LAYER);   // unknown pool → blank
    });

    it('★ a skin whose OWN slot texture is still pending degrades to the pool DEFAULT layer, not a hole', () => {
        const m = new GarpManager();
        // Both skins name their own `products` texture, but a pool default is also provided.
        const p = pool({ defaults: { fascia: 'generic-fascia', products: 'generic-cans' } });
        m.registerPool(p);
        m.registerTexture('generic-fascia', src('gf'));   // only the DEFAULTS have loaded so far
        m.registerTexture('generic-cans', src('gc'));
        // pocari-fascia hasn't loaded → fall back to the default fascia layer (NOT blank layer 0).
        expect(m.skinLayer('salsa/vending', p.skins[0], 'fascia')).toBe(m.layerOf('generic-fascia'));
        expect(m.skinLayer('salsa/vending', p.skins[0], 'fascia')).not.toBe(GARP_BLANK_LAYER);
        // Once the skin's own texture loads, it wins over the default.
        m.registerTexture('pocari-fascia', src('pf'));
        expect(m.skinLayer('salsa/vending', p.skins[0], 'fascia')).toBe(m.layerOf('pocari-fascia'));
    });

    it('a pool default covers a skin that omits a slot, and counts toward resolution', () => {
        const m = new GarpManager();
        const p = pool({ defaults: { products: 'generic-cans' }, skins: [{ name: 'fascia-only', slots: { fascia: 'f' } }] });
        m.registerPool(p);
        m.registerTexture('f', src('f'));
        expect(m.poolResolved('salsa/vending')).toBe(false);      // default texture not registered yet
        m.registerTexture('generic-cans', src('g'));
        expect(m.poolResolved('salsa/vending')).toBe(true);
        expect(m.skinLayer('salsa/vending', p.skins[0], 'products')).toBe(m.layerOf('generic-cans'));   // via default
    });
});
