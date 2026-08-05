/**
 * src/world/garp.test.ts — the GARP data model + skin selection (docs/specs/city-props-garp.md §2).
 *
 * The load-bearing property is that a skin is picked as ONE coordinated unit, deterministically per object
 * position (so selective regen is idempotent), weighted, with a slot fallback so a half-authored skin
 * degrades instead of rendering a hole.
 */

import { describe, it, expect } from 'vitest';
import { pickSkin, skinSlot, validateGarpPool, type GarpPool } from './garp';

const pool = (over: Partial<GarpPool> = {}): GarpPool => ({
    id: 'salsa/vending-machines', name: 'vending-machines', version: 1, size: [512, 512], slots: ['fascia', 'products'],
    skins: [
        { name: 'pocari', slots: { fascia: 'pocari-fascia', products: 'pocari-cans' } },
        { name: 'coffee', slots: { fascia: 'coffee-fascia', products: 'coffee-cans' }, weight: 2 },
        { name: 'ramune', slots: { fascia: 'ramune-fascia', products: 'ramune-bottles' } },
    ],
    ...over,
});

describe('pickSkin — deterministic, coordinated, weighted', () => {
    it('is deterministic per (position, seed)', () => {
        const p = pool();
        for (const [x, z] of [[3, 7], [12.5, -4], [0, 0]] as const) {
            expect(pickSkin(p, x, z, 5)?.name).toBe(pickSkin(p, x, z, 5)?.name);
        }
    });

    it('returns a WHOLE skin (fascia + products always agree — never mixed)', () => {
        const p = pool();
        for (let x = 0; x < 40; x++) {
            const s = pickSkin(p, x * 1.3, x * 0.7, 9)!;
            // Both slots come from the SAME skin — the brand never crosses.
            expect(s.slots.fascia.split('-')[0]).toBe(s.slots.products.split('-')[0]);
        }
    });

    it('honours weights — the 2× skin is picked ~twice as often', () => {
        const p = pool();
        const counts: Record<string, number> = {};
        for (let x = 0; x < 4000; x++) { const s = pickSkin(p, x * 1.1, (x * 2.3) % 97, 3)!; counts[s.name] = (counts[s.name] ?? 0) + 1; }
        // coffee (weight 2) should sit near 2× pocari/ramune (weight 1). Loose bounds — it's a hash, not RNG.
        expect(counts.coffee).toBeGreaterThan(counts.pocari * 1.4);
        expect(counts.coffee).toBeGreaterThan(counts.ramune * 1.4);
    });

    it('a weight-0 skin is never picked', () => {
        const p = pool({ skins: [
            { name: 'off', slots: { fascia: 'a', products: 'b' }, weight: 0 },
            { name: 'on', slots: { fascia: 'c', products: 'd' } },
        ] });
        for (let x = 0; x < 200; x++) expect(pickSkin(p, x, x * 3, 1)!.name).toBe('on');
    });

    it('single-skin and empty pools', () => {
        expect(pickSkin(pool({ skins: [{ name: 'only', slots: { fascia: 'a', products: 'b' } }] }), 5, 5, 1)!.name).toBe('only');
        expect(pickSkin(pool({ skins: [] }), 5, 5, 1)).toBeNull();
    });

    it('★ REORDERING a pool never reshuffles assignments (stable by skin name, not array index)', () => {
        const p = pool();
        const shuffled = pool({ skins: [p.skins[2], p.skins[0], p.skins[1]] });   // same skins, different order
        for (let x = 0; x < 300; x++) {
            expect(pickSkin(shuffled, x * 1.3, x * 0.9, 4)!.name).toBe(pickSkin(p, x * 1.3, x * 0.9, 4)!.name);
        }
    });

    it('★ ADDING a skin keeps most assignments — a changed cell only ever moves TO the new skin (rendezvous)', () => {
        const p3 = pool();   // pocari / coffee / ramune
        const p4 = pool({ skins: [...pool().skins, { name: 'zzz-new', slots: { fascia: 'zzz-fascia', products: 'zzz-cans' } }] });
        let kept = 0, total = 0;
        for (let i = 0; i < 800; i++) {
            const x = i * 1.3, z = (i * 0.7) % 53;
            const before = pickSkin(p3, x, z, 4)!.name;
            const after = pickSkin(p4, x, z, 4)!.name;
            total++;
            if (before === after) kept++;
            else expect(after).toBe('zzz-new');   // the ONLY allowed change is a cell the new skin now claims
        }
        // Roulette-wheel would reshuffle almost everything; rendezvous keeps the large majority (~3/4).
        expect(kept / total).toBeGreaterThan(0.6);
    });

    it('★ tiny float noise within a grid cell picks the SAME skin (platform-stable, no reskin on regen)', () => {
        const p = pool();
        for (const [x, z] of [[3.0, 7.0], [12.5, -4.25]] as const) {
            const base = pickSkin(p, x, z, 5)!.name;
            expect(pickSkin(p, x + 0.0000003, z - 0.0000004, 5)!.name).toBe(base);   // sub-ULP drift → same cell
        }
    });
});

describe('skinSlot fallback + validation', () => {
    it('falls back to the pool default when a skin omits a slot', () => {
        const p = pool({
            defaults: { products: 'generic-cans' },
            skins: [{ name: 'fascia-only', slots: { fascia: 'x' } }],
        });
        expect(skinSlot(p, p.skins[0], 'fascia')).toBe('x');
        expect(skinSlot(p, p.skins[0], 'products')).toBe('generic-cans');   // default
        expect(skinSlot(p, p.skins[0], 'nope')).toBeNull();
    });

    it('validateGarpPool flags missing slots, duplicates, and empties', () => {
        expect(validateGarpPool(pool())).toEqual([]);
        const bad = validateGarpPool(pool({ skins: [
            { name: 'dup', slots: { fascia: 'a', products: 'b' } },
            { name: 'dup', slots: { fascia: 'c' } },   // missing `products`, duplicate name
        ] }));
        expect(bad.some((e) => /missing slot "products"/.test(e))).toBe(true);
        expect(bad.some((e) => /duplicate skin "dup"/.test(e))).toBe(true);
        expect(validateGarpPool(pool({ skins: [], slots: [] }))).not.toEqual([]);
    });
});
