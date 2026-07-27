// src/world/planting.test.ts — the VESSEL PLANTING arrangement and the rebuilt `potted` · `planter` ·
// `window-box` archetypes (foliage-quality.md §4 vessel types, phase P4v). These were the last three
// types on the old construction: a correct vessel topped by ONE `foliageClump` blob. What is pinned:
//   1. the ARRANGEMENT — more than one distinct plant, laid out focal / filler / trailing, not a blob,
//   2. roots stay INSIDE the vessel footprint and on the soil plane; nothing floats or pokes out,
//   3. ★ the window box SPILLS — trailing geometry hangs BELOW the box bottom on the FRONT (+Z) face,
//   4. ★ `bloom` now makes real `whorl` flower heads (petals + a disc), not `foliageBloom` specks,
//   5. the VESSEL shapes themselves are untouched (the pot frustum / the boxes),
//   6. the hanging-spill WIND fix: a lifted geometry frame + a saturated ramp, world position unmoved,
//   7. determinism per seed, the LOD bands, and both caps warning instead of truncating silently.

import { describe, it, expect, vi } from 'vitest';
import { Accum3D } from './meshbuild';
import { mulberry } from './building-geom';
import type { V3 } from './curve-frame';
import {
    plantingArrangement, emitSoil, PLANTING_LOD_SCALE, MAX_PLANTS_PER_VESSEL, MAX_VESSEL_LEAVES,
    type PlantingAccum, type PlantingSpec, type VesselTop,
} from './planting';
import {
    buildFoliage, liftGeometryY, FOLIAGE_TYPES, FOLIAGE_WIND, GROUND_PLANTED,
    VESSEL_TYPES, VESSEL_SOIL_COLOR, SPILL_WIND_HEIGHT,
} from './foliage';
import type { LayoutPreviewLayer } from './types';

const FLOATS = 12;   // pos3 · nrm3 · uv2 · tangent4 (Accum3D's interleave)
const tris = (g: { indices: ArrayLike<number> }): number => g.indices.length / 3;

function points(g: { vertices: Float32Array }, dy = 0): V3[] {
    const out: V3[] = [];
    for (let i = 0; i + FLOATS <= g.vertices.length; i += FLOATS) out.push([g.vertices[i], g.vertices[i + 1] + dy, g.vertices[i + 2]]);
    return out;
}
/** Every vertex of a layer, in the plant's own space (undoing any wind-lift instance transform). */
const worldPoints = (L: LayoutPreviewLayer): V3[] => points(L.geometry, L.instances?.[0]?.y ?? 0);

function build(partial: Parameters<typeof buildFoliage>[0]) {
    const { layers, meta } = buildFoliage(partial);
    return {
        layers, meta,
        by: (n: string) => layers.find(l => l.name === `foliage:${n}`),
        tris: layers.reduce((s, L) => s + tris(L.geometry), 0),
        /** Vertices of every layer whose name passes `keep`, in plant space. */
        pts: (keep: (n: string) => boolean): V3[] => layers.filter(l => keep(l.name.replace('foliage:', ''))).flatMap(worldPoints),
    };
}
const ATTACHED = (n: string): boolean => !n.endsWith('-free') && n !== 'vessel' && n !== 'soil';
const FREE = (n: string): boolean => n.endsWith('-free');

function mkAcc(): PlantingAccum & { all: Accum3D[] } {
    const a = { woody: new Accum3D(), leaf: new Accum3D(), tip: new Accum3D(), petal: new Accum3D(), centre: new Accum3D(), stem: new Accum3D(), stemFree: new Accum3D(), leafFree: new Accum3D(), tipFree: new Accum3D(), soil: new Accum3D() };
    return { ...a, all: Object.values(a) };
}
const TOP: VesselTop = { centre: [0, 0.25, 0], halfX: 0.45, halfZ: 0.11, round: false };
const SPEC = (over: Partial<PlantingSpec> = {}): PlantingSpec => ({
    layout: 'row', density: 0.6, height: 0.4, bloom: false, spill: 0.5, spillDir: [0, 1],
    spillSpread: 1.25, card: false, ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('plantingArrangement — the layout rule (§4 vessel types)', () => {
    it('places MORE THAN ONE plant for a row/group, with a taller FOCAL and smaller filler', () => {
        for (const layout of ['row', 'group'] as const) {
            const r = plantingArrangement(mkAcc(), TOP, SPEC({ layout }), mulberry(11));
            expect(r.plants.length, layout).toBeGreaterThan(1);
            // The focal is emitted first and is the biggest thing in the vessel.
            const focal = r.plants[0];
            for (const p of r.plants.slice(1)) expect(p.scale).toBeLessThan(focal.scale);
        }
    });

    it('a `single` layout is exactly ONE specimen (a pot holds one plant, not a bouquet)', () => {
        const r = plantingArrangement(mkAcc(), { ...TOP, halfZ: 0.45, round: true }, SPEC({ layout: 'single' }), mulberry(11));
        expect(r.plants.length).toBe(1);
    });

    it('picks a DIFFERENT specimen for different seeds (the pot is not always the same plant)', () => {
        const kinds = new Set<string>();
        for (let seed = 1; seed <= 12; seed++) {
            const r = plantingArrangement(mkAcc(), { ...TOP, halfZ: 0.45, round: true }, SPEC({ layout: 'single' }), mulberry(seed * 0x9e3779b1));
            kinds.add(r.plants[0].kind);
        }
        expect(kinds.size).toBeGreaterThan(1);
    });

    it('EVERY root lands inside the vessel footprint (nothing is planted over the rim)', () => {
        for (let seed = 1; seed <= 8; seed++) {
            const r = plantingArrangement(mkAcc(), TOP, SPEC({ layout: 'row', density: 1 }), mulberry(seed * 7919));
            for (const p of r.plants) {
                expect(Math.abs(p.x), `seed ${seed} ${p.kind}`).toBeLessThanOrEqual(TOP.halfX + 1e-6);
                expect(Math.abs(p.z), `seed ${seed} ${p.kind}`).toBeLessThanOrEqual(TOP.halfZ + 1e-6);
            }
        }
    });

    it('a row places its TRAILING plants at the OUTWARD rim and its uprights behind them', () => {
        const r = plantingArrangement(mkAcc(), TOP, SPEC({ layout: 'row', spillDir: [0, 1] }), mulberry(5));
        const trail = r.plants.filter(p => p.trailing), up = r.plants.filter(p => !p.trailing);
        expect(trail.length).toBeGreaterThan(0);
        for (const t of trail) expect(t.z).toBeGreaterThan(0);                     // the FRONT (+Z) face
        for (const u of up) expect(u.z).toBeLessThan(Math.max(...trail.map(t => t.z)));
    });

    it('`spill: 0` plants NO trailing plants at all (and emits no free/hanging geometry)', () => {
        const acc = mkAcc();
        const r = plantingArrangement(acc, TOP, SPEC({ spill: 0 }), mulberry(5));
        expect(r.plants.some(p => p.trailing)).toBe(false);
        expect(r.low).toBeGreaterThanOrEqual(TOP.centre[1] - 0.01);
        for (const a of [acc.stemFree, acc.leafFree, acc.tipFree]) expect(a.empty).toBe(true);
    });

    it('is DETERMINISTIC: the same seed rebuilds the arrangement vertex-for-vertex', () => {
        const run = (seed: number): { v: Float32Array; kinds: string } => {
            const acc = mkAcc();
            const r = plantingArrangement(acc, TOP, SPEC(), mulberry(seed));
            return { v: acc.leaf.geometry().vertices, kinds: r.plants.map(p => p.kind).join() };
        };
        const a = run(3), b = run(3), c = run(4);
        expect(Array.from(a.v)).toEqual(Array.from(b.v));
        expect(a.kinds).toBe(b.kinds);
        expect(Array.from(c.v)).not.toEqual(Array.from(a.v));
    });
});

describe('emitSoil — you never see into an empty vessel', () => {
    it('fills a ROUND vessel with a disc that covers the whole opening', () => {
        const acc = new Accum3D();
        const top: VesselTop = { centre: [0, 0.3, 0], halfX: 0.2, halfZ: 0.2, round: true };
        emitSoil(acc, top);
        const P = points(acc.geometry());
        expect(P.length).toBeGreaterThan(3);
        let far = 0;
        for (const p of P) { expect(p[1]).toBeCloseTo(0.3, 6); far = Math.max(far, Math.hypot(p[0], p[2])); }
        expect(far).toBeGreaterThanOrEqual(0.2);      // reaches the rim
    });

    it('fills a RECTANGULAR vessel with a slab spanning both half-extents', () => {
        const acc = new Accum3D();
        emitSoil(acc, TOP);
        const P = points(acc.geometry());
        expect(Math.max(...P.map(p => Math.abs(p[0])))).toBeGreaterThanOrEqual(TOP.halfX);
        expect(Math.max(...P.map(p => Math.abs(p[2])))).toBeGreaterThanOrEqual(TOP.halfZ);
        expect(Math.max(...P.map(p => p[1]))).toBeCloseTo(TOP.centre[1], 6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the rebuilt vessel types — potted · planter · window-box', () => {
    it('keeps their type names (existing scenes and saves upgrade on reload)', () => {
        for (const t of ['potted', 'planter', 'window-box'] as const) {
            expect(FOLIAGE_TYPES).toContain(t);
            expect(VESSEL_TYPES.has(t)).toBe(true);
            expect(GROUND_PLANTED.has(t)).toBe(false);          // a vessel plant never touches world soil
        }
        expect(VESSEL_TYPES.size).toBe(3);
    });

    it('still emits the VESSEL geometry unchanged — the pot frustum and both boxes', () => {
        // The pot: an 8-sided frustum + bottom cap + rim ring, base on y = 0, `size`-scaled.
        const pot = build({ type: 'potted', size: 1.2, seed: 4 }).by('vessel')!;
        const pp = points(pot.geometry);
        expect(tris(pot.geometry)).toBe(38);
        expect(Math.min(...pp.map(p => p[1]))).toBeCloseTo(0, 5);
        expect(Math.max(...pp.map(p => p[1]))).toBeCloseTo(1.2 * 0.32, 5);        // ph = size × 0.32
        expect(Math.max(...pp.map(p => Math.hypot(p[0], p[2])))).toBeCloseTo(1.2 * 0.24, 5);

        // The planter + window box: one `obox` each (12 tris), same dimensions as before the rebuild.
        for (const [type, hx, hy, hz] of [
            ['planter', Math.max(0.28, 1.2 * 0.3), 1.2 * 0.2 / 2, Math.max(0.28, 1.2 * 0.3) * 0.72],
            ['window-box', 1.0 / 2, 0.22 / 2, 0.28 / 2],
        ] as const) {
            const v = build({ type, size: 1.2, width: 1, seed: 4 }).by('vessel')!;
            const vp = points(v.geometry);
            expect(tris(v.geometry), type).toBe(12);
            expect(Math.max(...vp.map(p => Math.abs(p[0]))), type).toBeCloseTo(hx, 5);
            expect(Math.max(...vp.map(p => p[1])), type).toBeCloseTo(hy * 2, 5);
            expect(Math.max(...vp.map(p => Math.abs(p[2]))), type).toBeCloseTo(hz, 5);
        }
    });

    it('emits a SOIL layer just below the rim, in its own dark colour', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            const b = build({ type, seed: 4 });
            const soil = b.by('soil');
            expect(soil, type).toBeDefined();
            expect(soil!.color).toEqual(VESSEL_SOIL_COLOR);
            const vy = Math.max(...points(b.by('vessel')!.geometry).map(p => p[1]));
            const sy = Math.max(...points(soil!.geometry).map(p => p[1]));
            expect(sy, type).toBeLessThan(vy);                  // below the rim…
            expect(sy, type).toBeGreaterThan(vy * 0.7);         // …but near the top, not at the bottom
        }
        expect(build({ type: 'bush' }).by('soil')).toBeUndefined();   // ground-planted types have no vessel
    });

    it('is a COMPOSITION, not one blob: several distinct plant layers, and far more than the old clump', () => {
        for (const type of ['planter', 'window-box'] as const) {
            const b = build({ type, seed: 4, bloom: true });
            // Real stems/limbs + real petals + a whorl disc — a `foliageClump` mound could emit none of these.
            const kinds = b.layers.map(l => l.name.replace('foliage:', ''));
            expect(kinds, type).toContain('bloom');
            expect(kinds, type).toContain('center');
            expect(kinds.filter(k => k !== 'vessel' && k !== 'soil').length, type).toBeGreaterThan(3);
            expect(b.tris, type).toBeGreaterThan(600);          // the old construction was 172–414 tris total
        }
    });

    it('keeps every ATTACHED plant above the vessel BOTTOM and rooted at the soil plane', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            for (const seed of [2, 5, 9]) {
                const b = build({ type, seed, bloom: true });
                const P = b.pts(ATTACHED);
                expect(P.length, type).toBeGreaterThan(0);
                // Nothing anchored pokes out of the bottom of the vessel…
                expect(Math.min(...P.map(p => p[1])), `${type}/${seed}`).toBeGreaterThanOrEqual(-1e-6);
                // …and nothing is planted outside the vessel's own footprint (the meta the host places by).
                const fx = Math.max(...b.meta.footprint.map(f => Math.abs(f[0])));
                const fz = Math.max(...b.meta.footprint.map(f => Math.abs(f[1])));
                for (const p of P) {
                    expect(Math.abs(p[0]), `${type}/${seed} x`).toBeLessThanOrEqual(fx + 1e-3);
                    expect(Math.abs(p[2]), `${type}/${seed} z`).toBeLessThanOrEqual(fz + 1e-3);
                }
            }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('★ the window-box SPILL — the signature look', () => {
    it('hangs trailing geometry BELOW the box bottom, on the OUTWARD (+Z / front) face', () => {
        for (const seed of [1, 4, 7]) {
            const b = build({ type: 'window-box', seed, width: 1.2 });
            const free = b.pts(FREE);
            expect(free.length, `seed ${seed}`).toBeGreaterThan(0);
            const below = free.filter(p => p[1] < 0);
            expect(below.length, `seed ${seed} spill below the box`).toBeGreaterThan(0);
            // …and the spill is at the FRONT: every hanging vertex is on the +Z side of the box centre.
            for (const p of below) expect(p[2], `seed ${seed}`).toBeGreaterThan(0);
            expect(Math.min(...free.map(p => p[1])), `seed ${seed}`).toBeLessThan(-0.1);
        }
    });

    it('scales with the `spill` param, and `spill: 0` removes the hanging half entirely', () => {
        const low = (spill: number): number => Math.min(0, ...build({ type: 'window-box', seed: 4, spill }).pts(FREE).map(p => p[1]));
        expect(low(1)).toBeLessThan(low(0.5));
        expect(low(0.5)).toBeLessThan(low(0.15));
        const none = build({ type: 'window-box', seed: 4, spill: 0 });
        expect(none.layers.some(l => l.name.endsWith('-free'))).toBe(false);
        expect(Math.min(...none.pts(() => true).map(p => p[1]))).toBeGreaterThanOrEqual(-1e-6);
    });

    it('respects `width` as the RUN LENGTH — a longer box plants a longer row', () => {
        const n = (width: number): number => build({ type: 'window-box', seed: 4, width }).by('vessel')!.geometry.vertices[0];
        expect(Math.abs(n(2))).toBeCloseTo(1, 5);       // the box really is `width` long
        const short = build({ type: 'window-box', seed: 4, width: 0.5 });
        const long = build({ type: 'window-box', seed: 4, width: 2.4 });
        expect(long.tris).toBeGreaterThan(short.tris);
    });

    it('a `potted` trailing specimen spills too — but radially, not toward one face', () => {
        // seed 2 picks the trailing recipe (see the per-seed variety test above).
        const b = build({ type: 'potted', seed: 2 });
        const free = b.pts(FREE);
        expect(free.length).toBeGreaterThan(0);
        expect(Math.min(...free.map(p => p[1]))).toBeLessThan(0.3);   // below the pot rim
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('★ bloom drives real WHORL flower heads, not sphere specks (§5)', () => {
    it('emits petals AND a whorl centre disc — `foliageBloom` specks emit neither', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            const on = build({ type, seed: 6, bloom: true });
            const off = build({ type, seed: 6, bloom: false });
            expect(on.by('bloom'), type).toBeDefined();
            // The disc/eye is emitted ONLY by `emitWhorl` — a blob speck has no centre channel at all.
            expect(on.by('center'), type).toBeDefined();
            expect(tris(on.by('center')!.geometry), type).toBeGreaterThan(0);
            expect(off.by('center'), type).toBeUndefined();
        }
    });

    it('the petals are swept STRIPS (many tris per head), not a handful of blob specks', () => {
        const on = build({ type: 'planter', seed: 6, bloom: true });
        // The old `foliageBloom(…, n = 8)` path emitted 8 blobs ≈ 64 tris. A real whorl is far richer.
        expect(tris(on.by('bloom')!.geometry)).toBeGreaterThan(120);
        // Petals carry the library's highest translucency + the petal-hue backlight.
        expect(on.by('bloom')!.foliageShade!.translucency).toBeGreaterThan(0.4);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('★ the hanging-spill WIND fix', () => {
    const wb = () => build({ type: 'window-box', seed: 4 });

    it('lifts the free layers into POSITIVE local Y and puts them back with an instance transform', () => {
        const b = wb();
        for (const L of b.layers.filter(l => l.name.endsWith('-free'))) {
            const dy = L.instances?.[0]?.y ?? 0;
            expect(dy, L.name).toBeLessThan(0);                       // the layer is translated back down
            const raw = points(L.geometry);
            // Every vertex the shader sees is above the ramp's zero — so the spill can actually move.
            expect(Math.min(...raw.map(p => p[1])), L.name).toBeGreaterThan(0);
            // …and the world position is unchanged: raw + dy is the real plant-space geometry.
            expect(Math.min(...raw.map(p => p[1] + dy)), L.name).toBeLessThan(0);
            expect(L.instances!.length).toBe(1);
            expect(L.instances![0].x).toBe(0);
            expect(L.instances![0].z).toBe(0);
        }
    });

    it('saturates the height ramp over the spill, so hanging geometry sways UNIFORMLY and MOST', () => {
        const b = wb();
        const leaf = b.by('leaf')!, free = b.by('leaf-free')!;
        expect(free.wind!.height).toBe(SPILL_WIND_HEIGHT);
        // Every hanging vertex is past the ramp's saturation point → grade 1 everywhere on the spill.
        expect(Math.min(...points(free.geometry).map(p => p[1]))).toBeGreaterThan(SPILL_WIND_HEIGHT);
        expect(leaf.wind!.height).toBeCloseTo(Math.max(0.05, b.meta.height), 6);   // uprights keep the real ramp
        // Free-hanging foliage moves more than the anchored half, and the tips move most of all.
        expect(free.wind!.amount).toBeGreaterThan(leaf.wind!.amount);
        expect(b.by('tip-free')!.wind!.amount).toBeGreaterThan(free.wind!.amount);
    });

    it('leaves the vessel and the soil essentially still (ceramic and dirt do not sway)', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            const b = build({ type, seed: 4 });
            for (const n of ['vessel', 'soil']) {
                const L = b.by(n)!;
                expect(L.wind!.amount, `${type}/${n}`).toBeLessThan(b.by('leaf')!.wind!.amount * 0.1);
                expect(L.foliageShade, `${type}/${n}`).toBeUndefined();   // opaque: no transmission
            }
        }
    });

    it('leaves the CLIMBER free layers alone — they were never below their own base', () => {
        const ivy = build({ type: 'ivy', seed: 4 });
        for (const L of ivy.layers.filter(l => l.name.endsWith('-free'))) {
            expect(L.instances, L.name).toBeUndefined();
            expect(L.wind!.height).toBeCloseTo(Math.max(0.05, ivy.meta.height), 6);
        }
    });

    it('liftGeometryY moves ONLY Y, by exactly dy', () => {
        const acc = new Accum3D();
        acc.obox([1, 2, 3], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.5, 0.5, 0.5);
        const before = points(acc.geometry());
        const after = points(liftGeometryY(acc.geometry(), 0.75));
        expect(after.length).toBe(before.length);
        for (let i = 0; i < before.length; i++) {
            expect(after[i][0]).toBeCloseTo(before[i][0], 6);
            expect(after[i][1]).toBeCloseTo(before[i][1] + 0.75, 6);
            expect(after[i][2]).toBeCloseTo(before[i][2], 6);
        }
    });

    it('a window box is floppier than a planter, and every vessel layer still carries wind', () => {
        expect(FOLIAGE_WIND['window-box'][0]).toBeLessThan(FOLIAGE_WIND['planter'][0]);
        expect(FOLIAGE_WIND['window-box'][1]).toBeGreaterThan(FOLIAGE_WIND['planter'][1]);
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            for (const L of build({ type, bloom: true, seed: 4 }).layers) {
                expect(L.wind, `${type}/${L.name}`).toBeDefined();
                expect(L.wind!.amount).toBeGreaterThan(0);
                expect(L.wind!.stiffness).toBe(FOLIAGE_WIND[type][0]);
            }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('shading — vessel plants are real geometry and never ground-blended', () => {
    it('is never alpha-cut in `card` mode (it would eat the real blades and petals)', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            for (const L of build({ type, render: 'card', bloom: true, seed: 4 }).layers) {
                expect(L.leafCard, `${type}/${L.name}`).toBeFalsy();
            }
        }
    });

    it('gets no ground bleed (a plant in a pot is not planted in the world)', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            const b = build({ type, seed: 4 });
            expect(b.by('leaf')!.foliageShade!.groundBlend).toBe(0);
            expect(b.by('leaf')!.foliageShade!.translucency).toBeGreaterThan(0.6);   // real leaves transmit
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('LOD + caps (§2.5 / §7)', () => {
    it('LOD thins the arrangement — fewer plants AND lighter plants', () => {
        const at = (lod: number) => build({ type: 'window-box', seed: 4, plantLod: lod, width: 1.6 });
        const t0 = at(0).tris, t1 = at(1).tris, t2 = at(2).tris;
        expect(t1).toBeLessThan(t0);
        expect(t2).toBeLessThan(t1);
        expect(t2).toBeLessThan(t0 * 0.5);
        // …and the plant COUNT itself drops with the band table.
        const n = (lod: number): number => plantingArrangement(mkAcc(), TOP, SPEC({ lodLevel: lod }), mulberry(4)).plants.length;
        expect(n(2)).toBeLessThan(n(0));
        expect(PLANTING_LOD_SCALE[0]).toBe(1);
        expect(PLANTING_LOD_SCALE[2]).toBeLessThan(PLANTING_LOD_SCALE[1]);
    });

    it('keeps the SPILL alive at every LOD band (thinning it away would delete the look)', () => {
        for (const lod of [0, 1, 2]) {
            const b = build({ type: 'window-box', seed: 4, plantLod: lod });
            expect(b.pts(FREE).some(p => p[1] < 0), `lod ${lod}`).toBe(true);
        }
    });

    it('CAPS the plant count and WARNS (density loss is never silent)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        try {
            const r = plantingArrangement(mkAcc(), TOP, SPEC({ plants: 40, maxPlants: 4 }), mulberry(4));
            expect(r.plants.length).toBeLessThanOrEqual(4);
            expect(warn).toHaveBeenCalled();
            expect(String(warn.mock.calls[0][0])).toContain('[planting]');
        } finally { warn.mockRestore(); }
    });

    it('CAPS the total leaf count and WARNS, dropping whole plants rather than overshooting', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        try {
            const r = plantingArrangement(mkAcc(), TOP, SPEC({ density: 1, plants: 8 }), mulberry(4));
            const capped = plantingArrangement(mkAcc(), TOP, SPEC({ density: 1, plants: 8, maxLeaves: 12 }), mulberry(4));
            expect(capped.truncated).toBe(true);
            expect(capped.plants.length).toBeLessThan(r.plants.length);
            expect(warn.mock.calls.some(c => String(c[0]).includes('leaf budget'))).toBe(true);
        } finally { warn.mockRestore(); }
        expect(MAX_PLANTS_PER_VESSEL).toBeGreaterThan(0);
        expect(MAX_VESSEL_LEAVES).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildFoliage — the three types stay deterministic and well-formed', () => {
    it('rebuilds identically for the same seed, and differently for another', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            const a = build({ type, seed: 8, bloom: true }), b = build({ type, seed: 8, bloom: true });
            const c = build({ type, seed: 9, bloom: true });
            expect(a.layers.map(l => l.name), type).toEqual(b.layers.map(l => l.name));
            for (let i = 0; i < a.layers.length; i++) {
                expect(Array.from(a.layers[i].geometry.vertices), `${type}/${a.layers[i].name}`)
                    .toEqual(Array.from(b.layers[i].geometry.vertices));
            }
            const flat = (x: typeof a): number[] => x.layers.flatMap(l => Array.from(l.geometry.vertices));
            expect(flat(c), type).not.toEqual(flat(a));
        }
    });

    it('reports a measured height/footprint that actually contains the arrangement', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            const b = build({ type, seed: 3, bloom: true });
            const P = b.pts(n => n !== 'vessel' && !n.endsWith('-free'));
            // Tolerance: a petal/leaf STRIP is `width/2` wider than the spine end its reach is measured
            // from (`bladeReach`), so the measured height can trail the outermost vertex by a hair.
            expect(b.meta.height, type).toBeGreaterThanOrEqual(Math.max(...P.map(p => p[1])) - 0.01);
            expect(b.meta.type).toBe(type);
            expect(b.meta.footprint.length).toBe(4);
        }
    });

    it('`plantCount` overrides the arrangement size', () => {
        const few = plantingArrangement(mkAcc(), TOP, SPEC({ plants: 2 }), mulberry(4));
        const many = plantingArrangement(mkAcc(), TOP, SPEC({ plants: 6 }), mulberry(4));
        expect(many.plants.length).toBeGreaterThan(few.plants.length);
        expect(build({ type: 'planter', seed: 4, plantCount: 5 }).tris)
            .toBeGreaterThan(build({ type: 'planter', seed: 4, plantCount: 1 }).tris);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ THE VESSEL QUALITY BAR (user report: "planter / potted / window-box are below the standard of the
// rebuilt grass / flowers / ivy / trees"). The arrangement MODEL was right; the numbers under it were not:
//   · `potted` planted EXACTLY ONE plant (layout 'single'), dead centre, so `density` moved nothing and a
//     ring of bare soil showed round the rim — a twig in a bucket,
//   · `plantShrub` ran its canopy at 0.42 × density against the freestanding `bush`'s full density, on 2–4
//     stems against 4–7, with leaves 0.13 × size — a tenth of a same-size bush's leaf mass,
//   · `plantGrass` emitted 7–16 blades against `grass-tuft`'s 30–60 at the same size,
//   · `plantFlower` emitted ONE bare spine (branches 0) with 2–4 leaves and a single 6–10-petal head,
//   · `plantTrailing` spilled 2–4 see-through strands, and the uprights ate the vessel leaf budget before
//     the trailers were planted at all, so the window box's signature spill was being truncated.
// These pin the floor so it cannot silently regress back.
describe('★ vessel quality floor — a vessel holds real LEAF MASS', () => {
    const VEG = (n: string): boolean => n !== 'vessel' && n !== 'soil';
    /** Worst-case vegetation tri count over a seed/bloom/render sweep — the floor, not a lucky seed. */
    const worstVeg = (type: 'potted' | 'planter' | 'window-box', density: number, keep = VEG): number => {
        let lo = Infinity;
        for (let seed = 1; seed <= 8; seed++) for (const bloom of [false, true]) for (const render of ['card', 'chunky'] as const) {
            const b = build({ type, size: 1, width: 1, density, seed, bloom, render });
            lo = Math.min(lo, b.layers.filter(l => keep(l.name.replace('foliage:', ''))).reduce((s, L) => s + tris(L.geometry), 0));
        }
        return lo;
    };

    it('every vessel type carries substantial foliage at ANY seed (the old build managed 254 tris)', () => {
        // A same-size standalone `bush` is ~2670 tris — the standard these three were failing to meet.
        expect(worstVeg('potted', 0.8)).toBeGreaterThan(1800);
        expect(worstVeg('planter', 0.8)).toBeGreaterThan(1800);
        expect(worstVeg('window-box', 0.8)).toBeGreaterThan(3000);
        // …and even at the BOTTOM of the density range it is a plant, not a sprig.
        expect(worstVeg('potted', 0.2)).toBeGreaterThan(700);
        expect(worstVeg('window-box', 0.2)).toBeGreaterThan(1200);
    });

    it('`density` really runs sparse → LUSH (count AND per-plant leaf mass)', () => {
        for (const type of ['potted', 'planter', 'window-box'] as const) {
            const lean = build({ type, seed: 4, density: 0.15, bloom: true }).tris;
            const lush = build({ type, seed: 4, density: 1, bloom: true }).tris;
            expect(lush / lean, type).toBeGreaterThan(1.8);
        }
    });

    it('a POT is a composition too — not one specimen marooned in the middle', () => {
        for (const seed of [1, 3, 5, 8]) {
            const b = build({ type: 'potted', seed, density: 0.8 });
            // More than one plant layer's worth of distinct channels, and a real spill over the rim.
            expect(b.layers.some(l => l.name.endsWith('-free')), `seed ${seed}`).toBe(true);
        }
        // The arrangement itself: a pot's GROUP rule plants a focal + fillers + a trailer.
        const r = plantingArrangement(mkAcc(), { centre: [0, 0.25, 0], halfX: 0.2, halfZ: 0.2, round: true },
            SPEC({ layout: 'group', density: 0.8, spillSpread: Math.PI * 2 }), mulberry(3));
        expect(r.plants.length).toBeGreaterThan(2);
        expect(r.plants.some(p => p.trailing)).toBe(true);
    });

    it('plants FILL the footprint — fillers reach the rim, they do not huddle in the centre', () => {
        const top: VesselTop = { centre: [0, 0.25, 0], halfX: 0.3, halfZ: 0.3, round: true };
        let reachedRim = 0, runs = 0;
        for (let seed = 1; seed <= 8; seed++) {
            const r = plantingArrangement(mkAcc(), top, SPEC({ layout: 'group', density: 1 }), mulberry(seed * 7717));
            const fillers = r.plants.filter(p => !p.trailing).slice(1);
            expect(fillers.length).toBeGreaterThan(0);
            runs++;
            if (fillers.some(p => Math.hypot(p.x / top.halfX, p.z / top.halfZ) > 0.45)) reachedRim++;
            // …and every root is still INSIDE the vessel.
            for (const p of r.plants) {
                expect(Math.abs(p.x)).toBeLessThanOrEqual(top.halfX + 1e-6);
                expect(Math.abs(p.z)).toBeLessThanOrEqual(top.halfZ + 1e-6);
            }
        }
        expect(reachedRim).toBe(runs);
        // Fillers are still clearly smaller than the focal (the layout rule is unchanged).
        const r = plantingArrangement(mkAcc(), top, SPEC({ layout: 'group', density: 1 }), mulberry(21));
        for (const p of r.plants.filter(p => !p.trailing).slice(1)) expect(p.scale).toBeLessThan(r.plants[0].scale);
    });

    it('★ the window box is visibly FULL and SPILLING — the hanging half is never starved', () => {
        // Worst case over the sweep, counting ONLY the free/hanging layers.
        expect(worstVeg('window-box', 0.8, n => n.endsWith('-free'))).toBeGreaterThan(800);
        expect(worstVeg('window-box', 1, n => n.endsWith('-free'))).toBeGreaterThan(1000);
        const lean = worstVeg('window-box', 0.2, n => n.endsWith('-free'));
        expect(worstVeg('window-box', 1, n => n.endsWith('-free'))).toBeGreaterThan(lean * 1.8);
    });

    it('the leaf budget RESERVES a share for the trailing plants (uprights used to eat it all)', () => {
        // A deliberately tight budget: the uprights plant first, so without the reserve the trailers got nothing.
        const spec = SPEC({ layout: 'row', density: 1, spill: 0.5, maxLeaves: 220 });
        const r = plantingArrangement(mkAcc(), TOP, spec, mulberry(6));
        const trailers = r.plants.filter(p => p.trailing);
        expect(trailers.length).toBeGreaterThan(0);
        for (const t of trailers) expect(t.leaves).toBeGreaterThan(4);
        expect(MAX_VESSEL_LEAVES).toBeGreaterThanOrEqual(1400);   // headroom for a genuinely full planter
    });
});
