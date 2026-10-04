// src/world/branch.test.ts — the `branch` PRIMITIVE and the rebuilt WOODY archetypes
// (foliage-quality.md §3.5 / §3.6 / §4, phase P4). Pins the things that make a woody plant read as a
// plant rather than as a blob on a stick:
//   1. RECURSION — the limb count is exactly Σ splitCount^level per stem, and it is deterministic,
//   2. TIPS are returned, they sit at the ends of real swept limbs, and length/radius DECAY monotonically,
//   3. leaf masses land AT THE TIPS (not one ball at the centre) — the whole point of §3.5,
//   4. ★ the canopy silhouette is NOT a sphere (per-azimuth extent varies far more than a clump does),
//   5. ★ the hedge is a clipped SHELL — leaves sit on the box surface, the interior is empty,
//   6. the four rebuilt types keep their names, are seed-deterministic, and no longer emit the old
//      single-`foliageClump` construction,
//   7. LOD thins limbs AND leaves, and both caps warn instead of silently truncating.

import { describe, it, expect, vi } from 'vitest';
import { Accum3D } from './meshbuild';
import { mulberry } from './building-geom';
import type { V3 } from './curve-frame';
import {
    emitBranch, emitCanopy, emitClumpCrown, emitLeafCluster, emitHedgeShell, emitSprigCrown, leafBudget, resolveBranch,
    DEFAULT_CANOPY, DEFAULT_CLUMP_CROWN, DEFAULT_HEDGE_SHELL, DEFAULT_LEAF, DEFAULT_SPRIG_CROWN, CLUMP_CARD_U0, MAX_CLUMP_CARDS_PER_PLANT,
    BRANCH_LOD_SCALE, LEAF_LOD_SCALE, MAX_LIMBS_PER_PLANT, MAX_LEAVES_PER_PLANT,
    type BranchSpec, type CanopySpec, type HedgeShellSpec,
} from './branch';
import { buildFoliage, foliageClump, resolveFoliageParams, BRANCH_TYPES, FOLIAGE_WIND, FOLIAGE_TYPES } from './foliage';

const FLOATS = 12;   // pos3 · nrm3 · uv2 · tangent4 (Accum3D's interleave)
function points(g: { vertices: Float32Array }): V3[] {
    const out: V3[] = [];
    for (let i = 0; i + FLOATS <= g.vertices.length; i += FLOATS) out.push([g.vertices[i], g.vertices[i + 1], g.vertices[i + 2]]);
    return out;
}
const tris = (g: { indices: ArrayLike<number> }): number => g.indices.length / 3;

/** A perfectly regular skeleton — no jitter anywhere, so counts and decays are exact. */
const RIGID = (over: Partial<BranchSpec> = {}): BranchSpec => resolveBranch({
    levels: 2, splitCount: 3, splitCountVar: 0, splitAngleVar: 0, lengthVar: 0,
    length: 1, startRadius: 0.05, gnarl: 0, wander: 0, upBias: 0, lean: 0, ...over,
});

function grow(over: Partial<BranchSpec> = {}, seed = 7) {
    const acc = new Accum3D();
    const r = emitBranch(acc, RIGID(over), { base: [0, 0, 0] }, mulberry(seed));
    return { acc, r };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('emitBranch — recursive limbs (§3.5)', () => {
    it('emits exactly Σ splitCount^level limbs, and splitCount^levels TIPS', () => {
        for (const [levels, splitCount] of [[0, 3], [1, 2], [2, 3], [3, 2]] as const) {
            const { r } = grow({ levels, splitCount });
            let limbs = 0;
            for (let k = 0; k <= levels; k++) limbs += splitCount ** k;
            expect(r.limbs, `levels=${levels} split=${splitCount}`).toBe(limbs);
            expect(r.tips.length).toBe(splitCount ** levels);
            expect(r.depth).toBe(levels);
            for (const t of r.tips) expect(t.depth).toBe(levels);
        }
    });

    it('a MULTI-STEM fan multiplies the whole skeleton (the bush construction)', () => {
        const one = grow({ stems: 1, levels: 1, splitCount: 2 }).r;
        const five = grow({ stems: 5, levels: 1, splitCount: 2 }).r;
        expect(one.limbs).toBe(3);
        expect(five.limbs).toBe(15);
        expect(five.tips.length).toBe(10);
        // Stems really fan: the tips are spread around the base, not stacked on one axis.
        const az = five.tips.map(t => Math.atan2(t.p[2], t.p[0]));
        expect(Math.max(...az) - Math.min(...az)).toBeGreaterThan(2);
    });

    it('every TIP sits at the end of a real swept limb (leaf masses go where foliage belongs)', () => {
        const { acc, r } = grow({ levels: 2, splitCount: 3 });
        const P = points(acc.geometry());
        expect(P.length).toBeGreaterThan(0);
        for (const t of r.tips) {
            // …a tube ring exists within a whisker of the reported tip.
            let best = Infinity;
            for (const p of P) best = Math.min(best, Math.hypot(p[0] - t.p[0], p[1] - t.p[1], p[2] - t.p[2]));
            expect(best).toBeLessThanOrEqual(t.radius * 1.6 + 1e-6);
        }
    });

    it('length AND radius decay MONOTONICALLY with depth (a twig is never fatter than its parent)', () => {
        let prevLen = Infinity, prevRad = Infinity;
        for (const levels of [0, 1, 2, 3]) {
            const { r } = grow({ levels, splitCount: 1, attachStart: 1, lengthDecay: 0.6, radiusDecay: 0.6 });
            const t = r.tips[0];
            expect(t.length).toBeLessThan(prevLen);
            expect(t.radius).toBeLessThan(prevRad);
            prevLen = t.length; prevRad = t.radius;
        }
    });

    it('gnarl + upBias bend a limb: it is NOT a straight beam, and it curves toward the light', () => {
        // A straight limb from a vertical axis ends dead above its base; a gnarled one wanders off it.
        // Averaged over seeds, because any single limb's bend is a random draw that can land near zero.
        const lateral = (gnarl: number): number => {
            let sum = 0;
            for (let seed = 1; seed <= 6; seed++) {
                const t = grow({ levels: 0, gnarl, upBias: 0 }, seed).r.tips[0];
                sum += Math.hypot(t.p[0], t.p[2]);
            }
            return sum / 6;
        };
        expect(lateral(0)).toBeLessThan(1e-9);
        expect(lateral(0.9)).toBeGreaterThan(0.08);
        // upBias lifts a SIDEWAYS limb back up (phototropism), so its tip is higher.
        const flat = emitBranch(new Accum3D(), RIGID({ levels: 0, upBias: 0 }), { base: [0, 0, 0], axis: [1, 0, 0] }, mulberry(3));
        const lifted = emitBranch(new Accum3D(), RIGID({ levels: 0, upBias: 0.8 }), { base: [0, 0, 0], axis: [1, 0, 0] }, mulberry(3));
        expect(lifted.tips[0].p[1]).toBeGreaterThan(flat.tips[0].p[1] + 0.1);
    });

    it('is DETERMINISTIC per seed (spec.seed builds its own rng)', () => {
        const a = new Accum3D(), b = new Accum3D(), c = new Accum3D();
        const spec = resolveBranch({ levels: 2, splitCount: 3, seed: 42 });
        emitBranch(a, spec, { base: [0, 0, 0] }, mulberry(1));
        emitBranch(b, spec, { base: [0, 0, 0] }, mulberry(999));      // caller rng is IGNORED when seed is set
        emitBranch(c, resolveBranch({ levels: 2, splitCount: 3, seed: 43 }), { base: [0, 0, 0] }, mulberry(1));
        expect(Array.from(a.geometry().vertices)).toEqual(Array.from(b.geometry().vertices));
        expect(Array.from(a.geometry().vertices)).not.toEqual(Array.from(c.geometry().vertices));
    });

    it('LOD thins the split count, and the limb CAP warns instead of truncating silently (§7)', () => {
        expect(BRANCH_LOD_SCALE[0]).toBe(1);
        const near = grow({ levels: 3, splitCount: 3, lodLevel: 0 }).r;
        const mid = grow({ levels: 3, splitCount: 3, lodLevel: 1 }).r;
        const far = grow({ levels: 3, splitCount: 3, lodLevel: 2 }).r;
        expect(mid.limbs).toBeLessThan(near.limbs);
        expect(far.limbs).toBeLessThan(mid.limbs);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const capped = grow({ levels: 5, splitCount: 4, maxLimbs: 25 }).r;
        expect(capped.limbs).toBeLessThanOrEqual(25);      // the cap is HARD, never overshot
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0][0])).toContain('limb budget');
        warn.mockRestore();
        expect(MAX_LIMBS_PER_PLANT).toBeGreaterThan(100);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
/** Per-azimuth max radial extent about the point cloud's own XZ centre → the SILHOUETTE profile. */
function silhouetteCV(P: readonly V3[], bins = 16): number {
    let cx = 0, cz = 0;
    for (const p of P) { cx += p[0]; cz += p[2]; }
    cx /= P.length; cz /= P.length;
    const maxR = new Array<number>(bins).fill(0);
    for (const p of P) {
        const dx = p[0] - cx, dz = p[2] - cz;
        const a = Math.atan2(dz, dx) + Math.PI;
        maxR[Math.min(bins - 1, Math.floor((a / (Math.PI * 2)) * bins))] = Math.max(maxR[Math.min(bins - 1, Math.floor((a / (Math.PI * 2)) * bins))], Math.hypot(dx, dz));
    }
    const mean = maxR.reduce((s, v) => s + v, 0) / bins;
    const varr = maxR.reduce((s, v) => s + (v - mean) ** 2, 0) / bins;
    return Math.sqrt(varr) / (mean || 1);
}

describe('emitLeafCluster + emitCanopy — leaf masses AT THE TIPS (§3.5 / §3.6)', () => {
    const CAN = (over: Partial<CanopySpec> = {}): CanopySpec => ({ ...DEFAULT_CANOPY, gapChance: 0, innerGap: 0, ...over });

    it('every leaf lands inside a cluster envelope AT a tip — never at the plant centre', () => {
        const skel = new Accum3D(), leaf = new Accum3D(), tip = new Accum3D();
        const r = emitBranch(skel, RIGID({ levels: 2, splitCount: 3, length: 1 }), { base: [0, 0, 0] }, mulberry(4));
        const spec = CAN({ radius: 0.16, sizeVar: 0, tipPush: 0.3, mode: 'chunky', density: 1 });
        const c = emitCanopy(leaf, tip, r.tips, spec, mulberry(4));
        expect(c.clusters).toBe(r.tips.length);
        expect(c.leaves).toBeGreaterThan(0);
        const reach = spec.radius * 1.6 + 0.4 * Math.max(...r.tips.map(t => t.length));
        for (const p of [...points(leaf.geometry()), ...points(tip.geometry())]) {
            let best = Infinity;
            for (const t of r.tips) best = Math.min(best, Math.hypot(p[0] - t.p[0], p[1] - t.p[1], p[2] - t.p[2]));
            expect(best).toBeLessThan(reach);
        }
    });

    it('★ the canopy silhouette is NOT a sphere — far more azimuthal variance than one clump', () => {
        const skel = new Accum3D(), leaf = new Accum3D(), tip = new Accum3D();
        const r = emitBranch(skel, resolveBranch({ levels: 3, splitCount: 3, length: 1, splitAngle: 0.5 }), { base: [0, 0, 0] }, mulberry(11));
        emitCanopy(leaf, tip, r.tips, { ...DEFAULT_CANOPY, mode: 'chunky', density: 0.7, irregular: 0.7, sizeVar: 0.45, radius: 0.18 }, mulberry(11));
        const canopy = [...points(leaf.geometry()), ...points(tip.geometry())];

        // The construction this replaced: ONE flattened foliageClump — a lumpy but essentially round ball.
        const bl = new Accum3D(), bt = new Accum3D();
        foliageClump(bl, bt, 0, 1, 0, 0.8, 1, mulberry(11), { flatten: 0.9 });
        const blob = [...points(bl.geometry()), ...points(bt.geometry())];

        const cvCanopy = silhouetteCV(canopy), cvBlob = silhouetteCV(blob);
        expect(cvBlob).toBeLessThan(0.12);                     // a clump really is round (≈0.085)
        expect(cvCanopy).toBeGreaterThan(0.25);                // the canopy really is not (≈0.55)
        expect(cvCanopy).toBeGreaterThan(cvBlob * 3);
    });

    it('a cluster is HOLLOW + irregular: an outer-shell bias plus a lobed, non-spherical envelope', () => {
        const round = new Accum3D(), lobed = new Accum3D();
        emitLeafCluster(round, null, [0, 0, 0], { ...DEFAULT_CANOPY, mode: 'chunky', density: 1, irregular: 0, flatten: 1 }, mulberry(2), 1);
        emitLeafCluster(lobed, null, [0, 0, 0], { ...DEFAULT_CANOPY, mode: 'chunky', density: 1, irregular: 1, flatten: 1 }, mulberry(2), 1);
        const rad = (a: Accum3D): number[] => points(a.geometry()).map(p => Math.hypot(p[0], p[1], p[2]));
        const spread = (v: number[]): number => Math.max(...v) - Math.min(...v);
        expect(spread(rad(lobed))).toBeGreaterThan(spread(rad(round)));
        // Outer-shell bias: the mean placement radius is well past half the envelope.
        const rr = rad(round);
        expect(rr.reduce((s, v) => s + v, 0) / rr.length).toBeGreaterThan(Math.max(...rr) * 0.45);
    });

    it('gaps leave tips BARE (see-through to a shadowed interior) and interior tips thin first', () => {
        const skel = new Accum3D();
        const r = emitBranch(skel, resolveBranch({ levels: 3, splitCount: 3 }), { base: [0, 0, 0] }, mulberry(9));
        const full = emitCanopy(new Accum3D(), null, r.tips, CAN({ mode: 'chunky' }), mulberry(9));
        const gappy = emitCanopy(new Accum3D(), null, r.tips, { ...DEFAULT_CANOPY, mode: 'chunky', gapChance: 0.35, innerGap: 0.4 }, mulberry(9));
        expect(full.clusters).toBe(r.tips.length);
        expect(gappy.clusters).toBeLessThan(full.clusters);
        expect(gappy.clusters).toBeGreaterThan(0);
    });

    it('BOTH render modes work: chunky = blobs, blade = real swept emitBlade leaves', () => {
        const chunky = new Accum3D(), blade = new Accum3D();
        const tipsOne = [{ p: [0, 1, 0] as V3, dir: [0, 1, 0] as V3, depth: 1, radius: 0.01, length: 0.3 }];
        emitCanopy(chunky, null, tipsOne, CAN({ mode: 'chunky', density: 1 }), mulberry(6));
        emitCanopy(blade, null, tipsOne, CAN({ mode: 'blade', density: 1, leaf: DEFAULT_LEAF }), mulberry(6));
        expect(tris(chunky.geometry())).toBeGreaterThan(0);
        expect(tris(blade.geometry())).toBeGreaterThan(0);
        expect(tris(chunky.geometry()) % 8).toBe(0);           // octahedron blobs
        expect(tris(blade.geometry())).toBeGreaterThan(tris(chunky.geometry()));
    });

    it('LOD thins the leaf count, and the leaf CAP warns (§7)', () => {
        expect(LEAF_LOD_SCALE[0]).toBe(1);
        const count = (lod: number): number => emitLeafCluster(new Accum3D(), null, [0, 0, 0], { ...DEFAULT_CANOPY, mode: 'chunky', density: 1, lodLevel: lod }, mulberry(1)).leaves;
        expect(count(1)).toBeLessThan(count(0));
        expect(count(2)).toBeLessThan(count(1));

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const skel = new Accum3D();
        const r = emitBranch(skel, resolveBranch({ levels: 3, splitCount: 3 }), { base: [0, 0, 0] }, mulberry(5));
        const c = emitCanopy(new Accum3D(), null, r.tips, CAN({ mode: 'chunky', density: 1 }), mulberry(5), [0, 0, 0], leafBudget(12));
        expect(c.leaves).toBe(12);
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0][0])).toContain('leaf budget');
        warn.mockRestore();
        expect(MAX_LEAVES_PER_PLANT).toBeGreaterThan(100);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
/** Signed distance to a rounded box centred at (0, h, 0) with half-extents (hx, hy, hz). */
function roundedBoxSD(p: V3, hx: number, hy: number, hz: number, rd: number): number {
    const q = [Math.abs(p[0]) - (hx - rd), Math.abs(p[1] - hy) - (hy - rd), Math.abs(p[2]) - (hz - rd)];
    const m = [Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)];
    return Math.hypot(m[0], m[1], m[2]) + Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0) - rd;
}

describe('emitHedgeShell — a MANICURED hedge is a clipped SHELL, not a row of spheres (P4)', () => {
    const SHELL = (over: Partial<HedgeShellSpec> = {}): HedgeShellSpec =>
        ({ ...DEFAULT_HEDGE_SHELL, width: 3, height: 1, depth: 0.6, mode: 'chunky', core: false, sprigs: 0, leafDensity: 40, ...over });

    it('★ leaves lie on the SHELL of the box — essentially nothing is deep inside', () => {
        const leaf = new Accum3D(), tip = new Accum3D();
        const spec = SHELL();
        const r = emitHedgeShell(leaf, tip, spec, mulberry(3));
        expect(r.leaves).toBeGreaterThan(30);
        const P = [...points(leaf.geometry()), ...points(tip.geometry())];
        const hx = spec.width / 2, hy = spec.height / 2, hz = spec.depth / 2;
        const deep = P.filter(p => roundedBoxSD(p, hx, hy, hz, spec.round) < -0.3 * Math.min(hx, hy, hz)).length;
        expect(deep / P.length).toBeLessThan(0.05);            // ≈0.025 — only blob jitter reaching in

        // …whereas the construction it replaced (a row of solid `foliageClump` mounds) fills the volume.
        const bl = new Accum3D(), bt = new Accum3D();
        const R = hz;
        for (let k = 0; k <= 5; k++) foliageClump(bl, bt, -hx + spec.width * (k / 5), R * 0.7, 0, R, 0.6, mulberry(3), { flatten: 0.95 });
        const B = [...points(bl.geometry()), ...points(bt.geometry())];
        const deepOld = B.filter(p => roundedBoxSD(p, hx, hy, hz, spec.round) < -0.3 * Math.min(hx, hy, hz)).length;
        expect(deepOld / B.length).toBeGreaterThan(0.3);       // ≈0.55 of a solid row is wasted interior
        expect(deepOld / B.length).toBeGreaterThan((deep / P.length) * 8);
    });

    it('respects `width` as the RUN LENGTH and keeps the cut plane flat-ish along it', () => {
        for (const width of [1, 5]) {
            const leaf = new Accum3D();
            const spec = SHELL({ width });
            emitHedgeShell(leaf, null, spec, mulberry(8));
            const P = points(leaf.geometry());
            const xs = P.map(p => p[0]);
            expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(width * 0.85);
            // BOXY silhouette: every x-slab reaches nearly the same depth (a row of spheres scallops).
            const slabs = 6, maxZ = new Array<number>(slabs).fill(0);
            for (const p of P) {
                const k = Math.min(slabs - 1, Math.floor(((p[0] + width / 2) / width) * slabs));
                maxZ[k] = Math.max(maxZ[k], Math.abs(p[2]));
            }
            const mean = maxZ.reduce((s, v) => s + v, 0) / slabs;
            for (const v of maxZ) expect(Math.abs(v - mean) / mean).toBeLessThan(0.2);
        }
    });

    it('sprigs ESCAPE the clipped plane, and the optional core is ONE cheap box (12 tris)', () => {
        const bare = new Accum3D(), sprigged = new Accum3D();
        const spec = SHELL({ sprigs: 0 });
        const a = emitHedgeShell(bare, null, spec, mulberry(2));
        const b = emitHedgeShell(sprigged, null, SHELL({ sprigs: 6, sprigLength: 0.3 }), mulberry(2));
        expect(a.sprigs).toBe(0);
        expect(b.sprigs).toBe(6);
        expect(b.height).toBeGreaterThan(spec.height);          // they poke past the cut

        const noCore = new Accum3D(), withCore = new Accum3D();
        emitHedgeShell(noCore, null, SHELL({ core: false }), mulberry(4));
        emitHedgeShell(withCore, null, SHELL({ core: true }), mulberry(4));
        expect(tris(withCore.geometry()) - tris(noCore.geometry())).toBe(12);
    });

    it('cost scales with AREA, and LOD + the leaf cap behave (§7)', () => {
        const at = (over: Partial<HedgeShellSpec>) => emitHedgeShell(new Accum3D(), null, SHELL(over), mulberry(1)).leaves;
        expect(at({ width: 6 })).toBeGreaterThan(at({ width: 3 }) * 1.4);
        expect(at({ lodLevel: 1 })).toBeLessThan(at({ lodLevel: 0 }));
        expect(at({ lodLevel: 2 })).toBeLessThan(at({ lodLevel: 1 }));

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const r = emitHedgeShell(new Accum3D(), null, SHELL(), mulberry(1), leafBudget(9));
        expect(r.leaves).toBe(9);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the four rebuilt WOODY archetypes (§4, P4)', () => {
    const layersOf = (over = {}) => buildFoliage(over).layers;
    const layer = (over: object, name: string) => layersOf(over).find(l => l.name === name);
    const totalTris = (over: object): number => layersOf(over).reduce((s, l) => s + tris(l.geometry as { indices: ArrayLike<number> }), 0);

    it('keeps the FOUR type names (existing scenes and saves upgrade on reload)', () => {
        expect([...BRANCH_TYPES].sort()).toEqual(['bush', 'hedge', 'shrub', 'small-tree']);
        for (const t of BRANCH_TYPES) expect(FOLIAGE_TYPES).toContain(t);
    });

    it('bush · shrub · small-tree now carry a real recursive SKELETON (not a beam, not nothing)', () => {
        // The old constructions were: bush = no trunk at all, shrub/small-tree = ONE 4/5-sided beam
        // (≤ ~16 tris). A recursive skeleton is an order of magnitude more.
        for (const type of ['bush', 'shrub', 'small-tree'] as const) {
            const trunk = layer({ type }, 'foliage:trunk');
            expect(trunk, type).toBeDefined();
            expect(tris(trunk!.geometry as { indices: ArrayLike<number> }), type).toBeGreaterThan(100);
        }
    });

    it('★ small-tree: leaf mass sits at the TIPS, so the canopy is off-centre-lumpy, not one ball', () => {
        const ls = layersOf({ type: 'small-tree', size: 4 });
        const P = [...points((ls.find(l => l.name === 'foliage:leaf')!.geometry as { vertices: Float32Array })),
                   ...points((ls.find(l => l.name === 'foliage:tip')!.geometry as { vertices: Float32Array }))];
        expect(silhouetteCV(P)).toBeGreaterThan(0.12);
        // The canopy floats ABOVE the ground on a trunk — no leaves down at the base.
        const lowest = Math.min(...P.map(p => p[1]));
        expect(lowest).toBeGreaterThan(0.35);
        // …and there is no single dominant central mass: leaves reach well out from the axis.
        expect(Math.max(...P.map(p => Math.hypot(p[0], p[2])))).toBeGreaterThan(0.6);
    });

    it('bush fans MULTIPLE stems from the base, shrub stands on ONE short woody base', () => {
        // Widest XZ span of the woody geometry AT the ground: a multi-stem fan is far wider than a
        // single trunk's own base ring.
        const baseSpan = (type: 'bush' | 'shrub' | 'small-tree'): number => {
            const g = layer({ type }, 'foliage:trunk')!.geometry as { vertices: Float32Array };
            const P = points(g).filter(p => Math.abs(p[1]) < 0.02);
            let m = 0;
            for (const a of P) for (const b of P) m = Math.max(m, Math.hypot(a[0] - b[0], a[2] - b[2]));
            return m;
        };
        expect(baseSpan('bush')).toBeGreaterThan(0.15);
        expect(baseSpan('shrub')).toBeLessThan(0.12);
        expect(baseSpan('small-tree')).toBeLessThan(0.15);     // one trunk, not a thicket
    });

    it('hedge: leaves on the SHELL of a clipped box, and CHEAPER than the old row of mounds', () => {
        const ls = layersOf({ type: 'hedge', width: 4 });
        expect(ls.find(l => l.name === 'foliage:trunk')).toBeUndefined();   // no visible limb structure
        const P = [...points(ls.find(l => l.name === 'foliage:leaf')!.geometry as { vertices: Float32Array }),
                   ...points(ls.find(l => l.name === 'foliage:tip')!.geometry as { vertices: Float32Array })];
        const hx = 2, hy = Math.min(1.2, 1.2 * 0.85) / 2, hz = Math.min(0.6, 1.2 * 0.5);
        const deep = P.filter(p => roundedBoxSD(p, hx, hy, hz, 0.1) < -0.3 * Math.min(hy, hz)).length;
        expect(deep / P.length).toBeLessThan(0.06);            // the core box is the only interior geometry

        // The OLD construction, rebuilt here for the comparison: ceil(w / (R·0.95)) + 1 solid mounds.
        const bl = new Accum3D(), bt = new Accum3D();
        const R = 0.6, nC = Math.max(2, Math.ceil(4 / (R * 0.95)));
        for (let k = 0; k <= nC; k++) foliageClump(bl, bt, -2 + 4 * (k / nC), R * 0.7, 0, R, 0.6, mulberry(1), { flatten: 0.95, tipFrac: 0.2 });
        const oldTris = tris(bl.geometry()) + tris(bt.geometry());
        expect(totalTris({ type: 'hedge', width: 4 })).toBeLessThan(oldTris);
    });

    it('is DETERMINISTIC per seed, and the seed really changes the plant', () => {
        for (const type of BRANCH_TYPES) {
            const a = buildFoliage({ type, seed: 5 }).layers.map(l => Array.from((l.geometry as { vertices: Float32Array }).vertices));
            const b = buildFoliage({ type, seed: 5 }).layers.map(l => Array.from((l.geometry as { vertices: Float32Array }).vertices));
            const c = buildFoliage({ type, seed: 6 }).layers.map(l => Array.from((l.geometry as { vertices: Float32Array }).vertices));
            expect(a, type).toEqual(b);
            expect(a, type).not.toEqual(c);
        }
    });

    it('BOTH render modes still work, and `card` now means REAL leaves (never alpha-cut)', () => {
        for (const type of BRANCH_TYPES) {
            for (const render of ['chunky', 'card'] as const) {
                const leaf = layer({ type, render }, 'foliage:leaf');
                expect(leaf, `${type}/${render}`).toBeDefined();
                expect(tris(leaf!.geometry as { indices: ArrayLike<number> })).toBeGreaterThan(0);
                // Real swept geometry must NOT be alpha-cut by the leafCard silhouette (it would eat it).
                if (render === 'card') expect(leaf!.leafCard, `${type}/card`).toBeFalsy();
            }
        }
    });

    it('branchLod thins the whole plant (limbs AND leaves)', () => {
        for (const type of BRANCH_TYPES) {
            const near = totalTris({ type, branchLod: 0 });
            const mid = totalTris({ type, branchLod: 1 });
            const far = totalTris({ type, branchLod: 2 });
            expect(mid, type).toBeLessThan(near);
            expect(far, type).toBeLessThanOrEqual(mid);
        }
    });

    it('the new woody params round-trip and actually change the geometry', () => {
        const p = resolveFoliageParams({ type: 'small-tree', branchLevels: 2, branchSplit: 4, stemCount: 3, branchGnarl: 0.8, canopyIrregular: 0.9, leafGaps: 0.4, hedgeSprigs: 9, branchLod: 1 });
        expect(p.branchLevels).toBe(2); expect(p.branchSplit).toBe(4); expect(p.stemCount).toBe(3);
        expect(p.branchGnarl).toBe(0.8); expect(p.canopyIrregular).toBe(0.9); expect(p.leafGaps).toBe(0.4);
        const base = totalTris({ type: 'small-tree' });
        expect(totalTris({ type: 'small-tree', branchLevels: 1 })).toBeLessThan(base);
        expect(totalTris({ type: 'small-tree', branchSplit: 4 })).toBeGreaterThan(base);
        expect(totalTris({ type: 'bush', stemCount: 9 })).toBeGreaterThan(totalTris({ type: 'bush', stemCount: 3 }));
        expect(totalTris({ type: 'hedge', hedgeSprigs: 20 })).toBeGreaterThan(totalTris({ type: 'hedge', hedgeSprigs: 0 }));
    });

    it('★ WIND: limbs move WITH the leaves they carry, and the tips are floppiest (§2.1)', () => {
        const tree = layersOf({ type: 'small-tree' });
        const trunk = tree.find(l => l.name === 'foliage:trunk')!;
        const leaf = tree.find(l => l.name === 'foliage:leaf')!;
        const tip = tree.find(l => l.name === 'foliage:tip')!;
        // ★ REVISED from "a trunk barely moves" (×0.1). Leaf masses sit at the TIPS of the twigs, so a
        // trunk at ×0.1 against leaves at ×1 made the foliage SHEAR OFF the ends of its own branches in a
        // breeze — invisible on the old blob trees, glaring once the limbs are real swept tubes. The base
        // is kept planted by the height GRADE (exponent ~2.2), which is the right tool for it; the amount
        // only sets how far the outer limbs travel, and they must track their own leaves.
        expect(trunk.wind!.amount).toBeCloseTo(FOLIAGE_WIND['small-tree'][1] * 0.45, 6);
        expect(trunk.wind!.amount, 'limbs must not lag their leaves badly enough to shear')
            .toBeGreaterThan(leaf.wind!.amount * 0.35);
        expect(trunk.wind!.amount, 'but wood still moves less than foliage').toBeLessThan(leaf.wind!.amount);
        expect(tip.wind!.amount).toBeGreaterThan(leaf.wind!.amount * 1.3);
        // A clipped hedge is the stiffest thing in the library and travels least of the woody types.
        expect(FOLIAGE_WIND['hedge'][0]).toBe(3.0);
        for (const t of ['bush', 'shrub', 'small-tree'] as const) {
            expect(FOLIAGE_WIND[t][0], t).toBeLessThan(FOLIAGE_WIND['hedge'][0]);
            expect(FOLIAGE_WIND[t][1], t).toBeGreaterThan(FOLIAGE_WIND['hedge'][1]);
        }
        // Wind height is the MEASURED plant height, not the nominal size.
        expect(leaf.wind!.height).toBe(buildFoliage({ type: 'small-tree' }).meta.height);
    });

    it('translucency: chunky blobs keep the blob-era value, real card leaves transmit more', () => {
        const chunky = layer({ type: 'bush', render: 'chunky' }, 'foliage:leaf')!;
        const card = layer({ type: 'bush', render: 'card' }, 'foliage:leaf')!;
        expect(card.foliageShade!.translucency!).toBeGreaterThan(chunky.foliageShade!.translucency!);
        // Ground-planted either way (§2.3).
        expect(chunky.foliageShade!.groundBlend!).toBeGreaterThan(0);
        expect(card.foliageShade!.groundBlend!).toBeGreaterThan(0);
    });

    it('meta stays sane: measured height, a footprint that contains the plant', () => {
        for (const type of BRANCH_TYPES) {
            const { layers, meta } = buildFoliage({ type, size: 2, width: 2 });
            expect(meta.type).toBe(type);
            expect(meta.height).toBeGreaterThan(0.4);
            const hx = Math.max(...meta.footprint.map(f => Math.abs(f[0])));
            const hz = Math.max(...meta.footprint.map(f => Math.abs(f[1])));
            for (const l of layers) {
                for (const p of points(l.geometry as { vertices: Float32Array })) {
                    expect(p[1], type).toBeLessThanOrEqual(meta.height + 1e-6);
                    expect(Math.abs(p[0]), type).toBeLessThanOrEqual(hx + 1e-6);
                    expect(Math.abs(p[2]), type).toBeLessThanOrEqual(hz + 1e-6);
                }
            }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('emitSprigCrown — small leaf cards grown ON twigs (§3.6b)', () => {
    /** A street-tree-sized skeleton (the `small-tree` recipe numbers at 7 m). */
    const TREE = (): BranchSpec => resolveBranch({
        levels: 3, splitCount: 3, splitCountVar: 1, splitAngle: 0.5, lengthDecay: 0.62, radiusDecay: 0.58,
        length: 3.5, startRadius: 0.26, tipTaper: 0.6, gnarl: 0.4, wander: 0.42, upBias: 0.6, attachStart: 0.42,
        segments: 5, sides: 5,
    });
    function crown(seed = 3) {
        const wood = new Accum3D(), leaf = new Accum3D(), tip = new Accum3D();
        const rnd = mulberry(seed);
        const b = emitBranch(wood, TREE(), { base: [0, 0, 0] }, rnd);
        const r = emitSprigCrown(wood, leaf, tip, b, DEFAULT_SPRIG_CROWN, rnd, [0, 0, 0], leafBudget(4200));
        return { wood, leaf, tip, b, r };
    }
    /** Cards come out as 4 vertices each: base-left, base-right, top-right, top-left. */
    const cards = (a: Accum3D): V3[][] => {
        const p = points(a.geometry()), out: V3[][] = [];
        for (let i = 0; i + 4 <= p.length; i += 4) out.push(p.slice(i, i + 4));
        return out;
    };
    const segDist = (p: V3, a: V3, b: V3): number => {
        const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-12;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / L2));
        return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
    };

    it('grows MANY SMALL cards (not a few half-metre leaves)', () => {
        const { leaf, tip, r } = crown();
        expect(r.cards).toBeGreaterThan(1200);
        expect(tris(leaf.geometry()) + tris(tip.geometry())).toBe(r.cards * 2);   // 2 tris per card
        for (const c of [...cards(leaf), ...cards(tip)]) {
            const edge = Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1], c[3][2] - c[0][2]);
            expect(edge).toBeLessThan(DEFAULT_SPRIG_CROWN.cardSize * (1 + DEFAULT_SPRIG_CROWN.cardSizeVar) + 1e-6);
        }
    });

    it('★ every card is ATTACHED — its stem sits on a twiglet or a limb, never floating beside one', () => {
        const { wood, leaf, tip, b } = crown();
        // Wood the leaves may hang from: every limb spine (sampled) + every twiglet ribbon (appended after the
        // limb tubes as 4-vertex quads; its centreline runs base-midpoint → end-midpoint).
        const segs: [V3, V3][] = [];
        for (const sp of b.spines) {
            let prev = sp.a;
            for (let i = 1; i <= 12; i++) {
                const t = i / 12, it = 1 - t;
                const q: V3 = [0, 1, 2].map((k) => it * it * sp.a[k] + 2 * it * t * sp.c[k] + t * t * sp.e[k]) as V3;
                segs.push([prev, q]); prev = q;
            }
        }
        const limbVerts = new Accum3D();
        emitBranch(limbVerts, TREE(), { base: [0, 0, 0] }, mulberry(3));
        const wp = points(wood.geometry()).slice(limbVerts.vertCount);
        const mid = (a: V3, c: V3): V3 => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
        for (let i = 0; i + 4 <= wp.length; i += 4) segs.push([mid(wp[i], wp[i + 1]), mid(wp[i + 2], wp[i + 3])]);
        let worst = 0;
        for (const c of [...cards(leaf), ...cards(tip)]) {
            const base = mid(c[0], c[1]);
            let d = Infinity;
            for (const [s0, s1] of segs) d = Math.min(d, segDist(base, s0, s1));
            worst = Math.max(worst, d);
        }
        // The stem is 12% of a card up from its base edge: ≤ ~3 cm off the wood it hangs from.
        expect(worst).toBeLessThan(0.04);
    });

    it('is deterministic, and the crown fills OUT past the bare skeleton', () => {
        const a = crown(5), c = crown(5);
        expect(Array.from(a.leaf.geometry().vertices)).toEqual(Array.from(c.leaf.geometry().vertices));
        expect(a.r.radius).toBeGreaterThan(a.b.radius);
    });

    it('LOD: fewer, larger cards — the crown keeps its coverage', () => {
        const run = (lod: number) => {
            const wood = new Accum3D(), leaf = new Accum3D(), rnd = mulberry(2);
            const b = emitBranch(wood, { ...TREE(), lodLevel: lod }, { base: [0, 0, 0] }, rnd);
            return emitSprigCrown(wood, leaf, null, b, { ...DEFAULT_SPRIG_CROWN, lodLevel: lod }, rnd, [0, 0, 0], leafBudget(4200));
        };
        const near = run(0), mid = run(1);
        expect(mid.cards).toBeLessThan(near.cards);
        expect(mid.cards).toBeGreaterThan(near.cards * 0.2);
    });

    it("`leafStyle: 'sprig'` routes a card-render small-tree through it: alpha-cut leafCard layers", () => {
        const { layers } = buildFoliage({ type: 'small-tree', render: 'card', size: 7, leafStyle: 'sprig', seed: 4 });
        const leafy = layers.filter((L) => /leaf|tip/.test(L.name));
        expect(leafy.length).toBeGreaterThan(0);
        for (const L of leafy) expect(L.leafCard, `${L.name} not alpha-cut`).toBe(true);
        // …and the default (blade) path is untouched: real swept leaves are never alpha-cut.
        const blade = buildFoliage({ type: 'small-tree', render: 'card', size: 7, seed: 4 }).layers.filter((L) => /leaf|tip/.test(L.name));
        for (const L of blade) expect(L.leafCard).toBe(false);
    });
});

describe('emitClumpCrown — a few dense cluster cards per clump, spherised normals (§3.6c, polish-round-3 T4)', () => {
    const TREE = (over: Partial<BranchSpec> = {}): BranchSpec => resolveBranch({
        levels: 3, splitCount: 3, splitCountVar: 1, splitAngle: 0.5, lengthDecay: 0.62, radiusDecay: 0.58,
        length: 3.5, startRadius: 0.26, tipTaper: 0.6, gnarl: 0.4, wander: 0.42, upBias: 0.6, attachStart: 0.42,
        segments: 5, sides: 5, ...over,
    });
    function crown(seed = 3, lod = 0) {
        const wood = new Accum3D(), leaf = new Accum3D(), tip = new Accum3D();
        const rnd = mulberry(seed);
        const b = emitBranch(wood, TREE({ lodLevel: lod }), { base: [0, 0, 0] }, rnd);
        const r = emitClumpCrown(leaf, tip, b, { ...DEFAULT_CLUMP_CROWN, lodLevel: lod }, rnd, [0, 0, 0], leafBudget(MAX_CLUMP_CARDS_PER_PLANT));
        return { wood, leaf, tip, b, r };
    }
    /** Interleaved vertex attributes: position, normal, uv. */
    const verts = (a: Accum3D): { p: V3; n: V3; uv: [number, number] }[] => {
        const v = a.geometry().vertices, out: { p: V3; n: V3; uv: [number, number] }[] = [];
        for (let i = 0; i + FLOATS <= v.length; i += FLOATS) out.push({ p: [v[i], v[i + 1], v[i + 2]], n: [v[i + 3], v[i + 4], v[i + 5]], uv: [v[i + 6], v[i + 7]] });
        return out;
    };

    it('a MODERATE number of LARGE cards (not thousands of small ones), 2 tris each', () => {
        const { leaf, tip, r } = crown();
        expect(r.clumps).toBeGreaterThan(10);
        expect(r.cards).toBe(r.clumps * DEFAULT_CLUMP_CROWN.cardsPerClump);
        expect(r.cards).toBeLessThan(1200);                                          // the sprig crown's is > 1 200
        expect(tris(leaf.geometry()) + tris(tip.geometry())).toBe(r.cards * 2);
        // Cards are clump-sized: the edge is ~ cardScale × the fitted clump radius, tens of centimetres, not 0.1 m.
        const all = [...verts(leaf), ...verts(tip)];
        const edge = Math.hypot(all[1].p[0] - all[0].p[0], all[1].p[1] - all[0].p[1], all[1].p[2] - all[0].p[2]);
        expect(edge).toBeGreaterThan(0.4);
    });

    it('marks every card as a CLUMP card through its UV range (u in [2, 3]) — no material flag bit needed', () => {
        const { leaf, tip } = crown();
        for (const v of [...verts(leaf), ...verts(tip)]) {
            expect(v.uv[0]).toBeGreaterThanOrEqual(CLUMP_CARD_U0);
            expect(v.uv[0]).toBeLessThanOrEqual(CLUMP_CARD_U0 + 1);
            expect(v.uv[1]).toBeGreaterThanOrEqual(0);
            expect(v.uv[1]).toBeLessThanOrEqual(1);
        }
    });

    it('★ SPHERISED normals: they point OUT of the crown (one soft volume), not every which way', () => {
        const { leaf, tip } = crown();
        const all = [...verts(leaf), ...verts(tip)];
        const c = all.reduce((a, v) => [a[0] + v.p[0], a[1] + v.p[1], a[2] + v.p[2]] as V3, [0, 0, 0] as V3).map((x) => x / all.length);
        let sum = 0;
        for (const v of all) {
            const d: V3 = [v.p[0] - c[0], v.p[1] - c[1], v.p[2] - c[2]];
            const L = Math.hypot(d[0], d[1], d[2]) || 1;
            sum += (v.n[0] * d[0] + v.n[1] * d[1] + v.n[2] * d[2]) / L;
        }
        // Random card normals (what a card cloud has without the bend) average ~0 here; flipped-outward ~0.5.
        expect(sum / all.length).toBeGreaterThan(0.6);
    });

    it('clumps sit AT the branch ends: every card is near a terminal limb', () => {
        const { leaf, tip, b, r } = crown();
        const ends = b.spines.filter((sp) => sp.terminal).flatMap((sp) => [0.4, 0.7, 1].map((t) => {
            const it = 1 - t;
            return [0, 1, 2].map((k) => it * it * sp.a[k] + 2 * it * t * sp.c[k] + t * t * sp.e[k]) as V3;
        }));
        let worst = 0;
        for (const v of [...verts(leaf), ...verts(tip)]) {
            let d = Infinity;
            for (const e of ends) d = Math.min(d, Math.hypot(v.p[0] - e[0], v.p[1] - e[1], v.p[2] - e[2]));
            worst = Math.max(worst, d);
        }
        expect(worst).toBeLessThan(r.clumpRadius * 2.6);
    });

    it('is deterministic, and fills OUT past the bare skeleton', () => {
        const a = crown(5), c = crown(5);
        expect(Array.from(a.leaf.geometry().vertices)).toEqual(Array.from(c.leaf.geometry().vertices));
        expect(a.r.radius).toBeGreaterThan(a.b.radius);
    });

    it('LOD: a thinned skeleton grows fewer, BIGGER clumps — the crown keeps its coverage', () => {
        const near = crown(3, 0), mid = crown(3, 1);
        expect(mid.r.cards).toBeLessThan(near.r.cards);
        expect(mid.r.clumpRadius).toBeGreaterThanOrEqual(near.r.clumpRadius);
        // Coverage ~ Σ card area: the mid crown keeps a good share of the near one's.
        const area = (x: ReturnType<typeof crown>) => x.r.cards * x.r.clumpRadius * x.r.clumpRadius;
        expect(area(mid)).toBeGreaterThan(area(near) * 0.6);
    });

    it("`leafStyle: 'clump'` routes a card-render small-tree through it: alpha-cut, gently translucent leaf layers", () => {
        const { layers } = buildFoliage({ type: 'small-tree', render: 'card', size: 7, leafStyle: 'clump', seed: 4 });
        const leafy = layers.filter((L) => /leaf|tip/.test(L.name));
        expect(leafy.length).toBeGreaterThan(0);
        for (const L of leafy) {
            expect(L.leafCard, `${L.name} not alpha-cut`).toBe(true);
            // A crown VOLUME: "a little" translucency, well under the single-leaf-thick sprig's 0.72+.
            expect(L.foliageShade!.translucency).toBeLessThan(0.5);
        }
    });
});
