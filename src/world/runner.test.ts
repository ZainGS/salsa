// src/world/runner.test.ts — the `runner` PRIMITIVE and the real IVY / VINE archetypes
// (foliage-quality.md §3.4 / §4, phase P3). Pins the things that make ivy read as ivy rather than as a
// spray of blobs on a plane:
//   1. ★ TWO PATH SOURCES, ONE MODEL — an authored point list IS a runner centreline (and the smoothed
//      spine passes exactly through the user's points), while area mode GROWS the same kind of path,
//   2. growth CLINGS (every non-hanging point sits on the host surface, offset by the leaf thickness),
//   3. branching really adds runners; the coverage FRONTIER thins the mass toward the region edge,
//   4. leaves are spaced at `leafSpacing` and ★ SHRINK toward the growing tip (young growth is small),
//   5. ★ HANG — once past the top edge, gravity takes over and the runner droops downward,
//   6. the wind is graded by ATTACHMENT (clinging ≈ still, free tips swing), not by height,
//   7. `ivy`/`vine` keep their type names but no longer emit the old random blobs, and the new params
//      round-trip through `resolveFoliageParams` / `buildFoliage`.

import { describe, it, expect, vi } from 'vitest';
import { Accum3D } from './meshbuild';
import { polySpine, cfSub, cfLen, cfDot, type V3 } from './curve-frame';
import { bladeWidthProfile } from './blade';
import {
    buildRunners, growRunners, pathRunners, resolveRunner, wallHost, coverageAt, tangentUp,
    RUNNER_LOD_SCALE, MAX_RUNNERS, MAX_RUNNER_LEAVES, type RunnerAccum, type RunnerSpec, type RunnerPath,
} from './runner';
import { mulberry } from './building-geom';
import { buildFoliage, resolveFoliageParams, FOLIAGE_TYPES, FOLIAGE_WIND, RUNNER_TYPES, BLADE_TYPES, FLOWER_TYPES, GROUND_PLANTED } from './foliage';

const FLOATS = 12;   // pos3 · nrm3 · uv2 · tangent4 (Accum3D's interleave)
interface Vtx { p: V3; n: V3; u: number; v: number }
function readVerts(g: { vertices: Float32Array }): Vtx[] {
    const out: Vtx[] = [];
    for (let i = 0; i + FLOATS <= g.vertices.length; i += FLOATS) {
        out.push({ p: [g.vertices[i], g.vertices[i + 1], g.vertices[i + 2]], n: [g.vertices[i + 3], g.vertices[i + 4], g.vertices[i + 5]], u: g.vertices[i + 6], v: g.vertices[i + 7] });
    }
    return out;
}

/** A 2 m × 2 m wall on the +Z face, x ∈ [−1, 1], y ∈ [0, 2] — the same convention `buildFoliage` uses. */
const WALL = wallHost({ origin: [-1, 0, 0], right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1], width: 2, height: 2 });

/** All six channels present (the shape `buildFoliage` uses), so a test can assert on any of them. */
interface FullAccum { stem: Accum3D; leaf: Accum3D; tip: Accum3D; stemFree: Accum3D; leafFree: Accum3D; tipFree: Accum3D }
function accum(): FullAccum {
    return { stem: new Accum3D(), leaf: new Accum3D(), tip: new Accum3D(), stemFree: new Accum3D(), leafFree: new Accum3D(), tipFree: new Accum3D() };
}
const SPEC = (over: Partial<RunnerSpec> = {}): RunnerSpec => resolveRunner({
    runnerCount: 6, maxLength: 1.2, stepSize: 0.08, branchChance: 0, coverage: 1, leafDensity: 1,
    leafSpacing: 0.08, leafSize: 0.06, leafSizeVar: 0, ...over,
});
function grow(over: Partial<RunnerSpec> = {}, seed = 5) {
    const acc = accum();
    const r = buildRunners(acc, { mode: 'area', host: WALL }, SPEC(over), mulberry(seed));
    return { acc, r };
}

describe('polySpine — an authored POLYLINE becomes a smooth centreline (§3.4 path source b)', () => {
    const pts: V3[] = [[0, 0, 0], [0.4, 0.2, 0], [0.9, 0.15, 0], [1.4, 0.5, 0]];

    it('passes EXACTLY through every supplied point (an authored path must follow the points)', () => {
        const s = polySpine(pts);
        expect(s.knots.length).toBe(pts.length);
        for (let i = 0; i < pts.length; i++) {
            const q = s.at(s.knots[i]);
            expect(cfLen(cfSub(q, pts[i])), `point ${i}`).toBeLessThan(1e-9);
        }
        // CHORD-LENGTH parameterisation: `t` tracks arclength, which is what lets leaves be spaced in metres.
        let chord = 0;
        for (let i = 0; i + 1 < pts.length; i++) chord += cfLen(cfSub(pts[i + 1], pts[i]));
        expect(s.length).toBeCloseTo(chord, 9);
        const mid = s.knots[1] + (s.knots[2] - s.knots[1]) * 0.5;
        expect(cfLen(cfSub(s.at(mid), pts[1]))).toBeGreaterThan(0.1);   // ...and it really moves between knots
    });

    it('has a continuous unit tangent, and degenerates safely', () => {
        const s = polySpine(pts);
        for (let t = 0; t <= 1.0001; t += 0.05) expect(cfLen(s.tangent(Math.min(1, t)))).toBeCloseTo(1, 6);
        expect(polySpine([[1, 2, 3]]).at(0.5)).toEqual([1, 2, 3]);          // one point
        expect(polySpine([]).at(0)).toEqual([0, 0, 0]);                     // none
        const line = polySpine([[0, 0, 0], [0, 0, 0], [1, 0, 0]]);          // duplicate dropped
        expect(line.knots.length).toBe(2);
        expect(line.at(0.5)[0]).toBeCloseTo(0.5, 6);
    });
});

describe('runner — PATH source: leaves + branches along an explicit point list', () => {
    const pts: V3[] = [[-0.6, 0.9, 0], [-0.2, 1.05, 0], [0.25, 1.0, 0], [0.7, 1.2, 0]];

    it('the runner IS the authored polyline, and its leaves follow it', () => {
        const acc = accum();
        const spec = SPEC({ branchChance: 0, leafSpacing: 0.09, thickness: 0.008 });
        const r = buildRunners(acc, { mode: 'path', points: pts, normal: [0, 0, 1] }, spec, mulberry(2));
        expect(r.runners).toBe(1);
        expect(r.paths[0].pts).toEqual(pts);              // the point list IS the centreline
        expect(r.paths[0].hang.every(h => !h)).toBe(true);
        expect(r.leaves).toBeGreaterThan(8);
        // Every leaf anchor sits ON the authored polyline (within the spline's gentle bow + the stem offset).
        const dSeg = (p: V3): number => {
            let best = Infinity;
            for (let i = 0; i + 1 < pts.length; i++) {
                const ab = cfSub(pts[i + 1], pts[i]), ap = cfSub(p, pts[i]);
                const t = Math.max(0, Math.min(1, cfDot(ap, ab) / cfDot(ab, ab)));
                best = Math.min(best, cfLen([ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t]));
            }
            return best;
        };
        for (const L of r.leafList) expect(dSeg(L.p)).toBeLessThan(0.08);
        // ...and they run the whole length of it, in order.
        expect(Math.min(...r.leafList.map(l => l.p[0]))).toBeLessThan(-0.4);
        expect(Math.max(...r.leafList.map(l => l.p[0]))).toBeGreaterThan(0.5);
    });

    it('optional side branches leave the path and HANG (nothing to cling to)', () => {
        const acc = accum();
        const r = buildRunners(acc, { mode: 'path', points: pts }, SPEC({ branchChance: 1, maxLength: 0.6 }), mulberry(4));
        expect(r.runners).toBeGreaterThan(1);
        const branch = r.paths[1];
        expect(branch.depth).toBe(1);
        expect(branch.hang.every(h => h)).toBe(true);
        expect(branch.pts[branch.pts.length - 1][1]).toBeLessThan(branch.pts[0][1]);   // gravity wins
        expect(acc.leafFree.empty || acc.tipFree.empty).toBe(false);                   // → the FREE channel
    });

    it('BOTH sources run the same downstream — same spec, same leaf machinery', () => {
        // A path traced along the wall produces the same KIND of output as growing over that wall.
        const a = buildRunners(accum(), { mode: 'path', points: pts }, SPEC({ branchChance: 0 }), mulberry(9));
        const b = grow({ runnerCount: 1 }, 9).r;
        for (const r of [a, b]) {
            expect(r.leafList.every(l => l.size > 0)).toBe(true);
            expect(r.leafList.every(l => l.dist >= 0 && l.t >= 0 && l.t <= 1)).toBe(true);
            expect(r.height).toBeGreaterThan(0);
        }
    });
});

describe('runner — AREA growth: crawl · CLING · branch · HANG (§3.4 path source a)', () => {
    it('is DETERMINISTIC per seed and seed-sensitive', () => {
        const a = grow({}, 11), b = grow({}, 11), c = grow({}, 12);
        expect(Array.from(b.acc.leaf.geometry().vertices)).toEqual(Array.from(a.acc.leaf.geometry().vertices));
        expect(b.r.leaves).toBe(a.r.leaves);
        expect(Array.from(c.acc.leaf.geometry().vertices)).not.toEqual(Array.from(a.acc.leaf.geometry().vertices));
    });

    it('★ CLINGS: every non-hanging point is ON the host surface, offset by the leaf thickness', () => {
        const spec = SPEC({ clingOffset: 0.02, maxLength: 0.9 });
        const paths = growRunners(WALL, spec, mulberry(6));
        expect(paths.length).toBeGreaterThan(0);
        let clung = 0;
        for (const path of paths) {
            for (let i = 0; i < path.pts.length; i++) {
                if (path.hang[i]) continue;
                const p = path.pts[i];
                expect(p[2]).toBeCloseTo(spec.clingOffset, 9);          // exactly one leaf-thickness off the wall
                expect(Math.abs(p[0])).toBeLessThanOrEqual(1 + 1e-9);   // ...and inside the 2×2 region
                expect(p[1]).toBeGreaterThanOrEqual(-1e-9);
                expect(p[1]).toBeLessThanOrEqual(2 + 1e-9);
                clung++;
            }
        }
        expect(clung).toBeGreaterThan(20);
        // The steps are real steps: consecutive points are ~stepSize apart.
        const d = cfLen(cfSub(paths[0].pts[1], paths[0].pts[0]));
        expect(d).toBeGreaterThan(spec.stepSize * 0.85);
        expect(d).toBeLessThan(spec.stepSize * 1.15);
    });

    it('BRANCHING increases the runner count (and branches are depth 1)', () => {
        const none = grow({ branchChance: 0, maxLength: 1.4 }, 3).r;
        const bushy = grow({ branchChance: 0.35, maxLength: 1.4 }, 3).r;
        expect(none.paths.every(p => p.depth === 0)).toBe(true);
        expect(bushy.runners).toBeGreaterThan(none.runners);
        expect(bushy.paths.some(p => p.depth === 1)).toBe(true);
        expect(bushy.paths.some(p => p.depth > 1)).toBe(false);        // branchDepth 1 = one level
        expect(bushy.leaves).toBeGreaterThan(none.leaves);
    });

    it('★ HANGS: past the top edge gravity takes over and the runner droops DOWNWARD', () => {
        // Long runners, straight up, no frontier kill → they run off the top of the region.
        const { acc, r } = grow({ runnerCount: 4, maxLength: 4, growthBias: 1, wander: 0.15, coverage: 1, frontier: 0, hangGravity: 0.4 }, 8);
        const hung = r.paths.filter(p => p.hang.some(Boolean));
        expect(hung.length).toBeGreaterThan(0);
        for (const path of hung) {
            const i0 = path.hang.indexOf(true);
            expect(path.pts[i0][1]).toBeGreaterThan(1.5);                          // it went free at the TOP
            const tail = path.pts[path.pts.length - 1];
            if (path.pts.length - i0 > 4) expect(tail[1]).toBeLessThan(path.pts[i0][1]);   // ...and fell
        }
        // Hanging geometry lands in the FREE channels — that split is what the wind grading rides on.
        expect(r.hangingLeaves).toBeGreaterThan(0);
        expect(acc.stemFree.empty).toBe(false);
        expect(acc.leafFree.empty && acc.tipFree.empty).toBe(false);
        // Nothing free is on the wall plane any more.
        for (const path of hung) for (let i = 0; i < path.pts.length; i++) if (path.hang[i] && i > path.hang.indexOf(true) + 1) expect(path.pts[i][1]).toBeLessThan(2.6);
    });

    it('`growthBias` steers the crawl up / along / down the host', () => {
        const top = (b: number): number => Math.max(...grow({ growthBias: b, wander: 0.2, maxLength: 1, runnerCount: 4, seedRow: 0.3 }, 21).r.paths.flatMap(p => p.pts.map(q => q[1])));
        expect(top(1)).toBeGreaterThan(top(0));
        expect(top(0)).toBeGreaterThan(top(-1));
    });
});

describe('runner — LEAVES: spacing, ★ size by AGE, and the new-growth split', () => {
    it('leaves are spaced ~leafSpacing along the runner and alternate sides', () => {
        const acc = accum();
        const spec = SPEC({ leafSpacing: 0.06, leafDensity: 1, branchChance: 0, phyllotaxy: 'alternate' });
        const r = buildRunners(acc, { mode: 'path', points: [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]] }, spec, mulberry(7));
        const list = r.leafList;
        expect(list.length).toBeGreaterThan(12);
        for (let i = 1; i < list.length; i++) {
            expect(list[i].dist - list[i - 1].dist).toBeCloseTo(spec.leafSpacing, 9);        // arclength spacing
            expect(cfLen(cfSub(list[i].p, list[i - 1].p))).toBeCloseTo(spec.leafSpacing, 2); // ...and in 3D
        }
        // `opposite` puts TWO leaves at every node (same distance, two sides) — roughly double the leaves.
        const opp = buildRunners(accum(), { mode: 'path', points: [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]] }, SPEC({ ...spec, phyllotaxy: 'opposite' }), mulberry(7));
        expect(opp.leaves).toBe(list.length * 2);
        expect(opp.leafList[0].dist).toBeCloseTo(opp.leafList[1].dist, 9);
    });

    it('★ leaves SHRINK toward the growing tip (young growth is small)', () => {
        const spec = SPEC({ leafSpacing: 0.05, leafSizeVar: 0, tipScale: 0.3, ageSpan: 0.4, newGrowth: 0.2 });
        const r = buildRunners(accum(), { mode: 'path', points: [[0, 0, 0], [0.6, 0, 0], [1.2, 0, 0]] }, spec, mulberry(1));
        const list = r.leafList;
        const first = list[0], last = list[list.length - 1];
        expect(last.toTip).toBeLessThan(first.toTip);
        expect(last.size).toBeLessThan(first.size * 0.5);            // the tip leaf is a fraction of a mature one
        expect(last.size).toBeGreaterThan(spec.leafSize * spec.tipScale * 0.9);
        for (let i = 1; i < list.length; i++) expect(list[i].size).toBeLessThanOrEqual(list[i - 1].size + 1e-9);
        // Beyond `ageSpan` from the tip a leaf is full size (the growth is OLD there).
        expect(first.size).toBeCloseTo(spec.leafSize, 6);
        // ★ NEW GROWTH near the tip goes to the lighter TIP accumulator (yellow-green vs dark mature).
        const acc = accum();
        buildRunners(acc, { mode: 'path', points: [[0, 0, 0], [0.6, 0, 0], [1.2, 0, 0]] }, spec, mulberry(1));
        expect(acc.tip.empty).toBe(false);
        expect(acc.leaf.empty).toBe(false);
        expect(r.leafList.filter(l => l.young).length).toBeGreaterThan(0);
        for (const l of r.leafList) expect(l.young).toBe(l.toTip < spec.newGrowth);
        // A leaf is a real swept BLADE with the ivy `palmate` silhouette: broad shoulders low, a point on top.
        expect(bladeWidthProfile('palmate', 0.26, 0)).toBeGreaterThan(bladeWidthProfile('palmate', 0, 0));
        expect(bladeWidthProfile('palmate', 0.26, 0)).toBeGreaterThan(bladeWidthProfile('palmate', 1, 0));
        expect(bladeWidthProfile('palmate', 1, 0)).toBeGreaterThan(0);
        for (const q of readVerts(acc.leaf.geometry())) expect([0, 0.5, 1]).toContain(q.u);
    });

    it('★ leafDensity is the CONTINUUM: sparse woody runners → a leaf carpet, one codepath', () => {
        const sparse = grow({ leafDensity: 0.15 }, 15);
        const carpet = grow({ leafDensity: 1 }, 15);
        expect(sparse.r.leaves).toBeLessThan(carpet.r.leaves * 0.5);
        expect(sparse.r.runners).toBe(carpet.r.runners);              // the RUNNERS are identical — only leaves thin
        expect(sparse.acc.stem.empty).toBe(false);                    // the woody stem is still there to be seen
        expect(carpet.acc.leaf.geometry().vertices.length).toBeGreaterThan(sparse.acc.leaf.geometry().vertices.length);
    });
});

describe('runner — the COVERAGE FRONTIER (ivy must not end in a straight line)', () => {
    it('the mask is dense in the core and fades at the sides + top, with noise breaking the edge', () => {
        const core = coverageAt(0.5, 0.2, 1), side = coverageAt(0.02, 0.2, 1), top = coverageAt(0.5, 0.98, 1);
        expect(core).toBeGreaterThan(side);
        expect(core).toBeGreaterThan(top);
        expect(coverageAt(0.5, 0.2, 0.2)).toBeLessThan(core);          // the `coverage` knob scales it
        // It is NOISY, not a clean gradient — that is what makes the frontier finger out.
        const row = [];
        for (let i = 0; i < 24; i++) row.push(coverageAt(i / 24, 0.75, 1));
        const mean = row.reduce((a, b) => a + b, 0) / row.length;
        expect(Math.max(...row) - Math.min(...row)).toBeGreaterThan(0.15);
        expect(row.some(v => v > mean) && row.some(v => v < mean)).toBe(true);
    });

    it('leaves are SPARSER at the region edge than in the core', () => {
        const { r } = grow({ runnerCount: 24, maxLength: 2.5, coverage: 0.75, wander: 0.7, leafDensity: 1 }, 31);
        const u = (p: V3): number => (p[0] + 1) / 2;
        const band = (lo: number, hi: number): number => r.leafList.filter(l => u(l.p) >= lo && u(l.p) < hi).length / (hi - lo);
        const edge = (band(0, 0.12) + band(0.88, 1)) / 2;
        const coreBand = band(0.4, 0.6);
        expect(coreBand).toBeGreaterThan(edge * 1.5);
        // ...and the mass does not end in a straight line: the runners' top reach varies a lot.
        const tops = r.paths.map(p => Math.max(...p.pts.map(q => q[1])));
        const mean = tops.reduce((a, b) => a + b, 0) / tops.length;
        expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(mean * 0.25);
    });

    it('higher coverage grows further and denser', () => {
        const thin = grow({ coverage: 0.35, runnerCount: 10, maxLength: 2 }, 17).r;
        const thick = grow({ coverage: 1, runnerCount: 10, maxLength: 2 }, 17).r;
        expect(thick.length).toBeGreaterThan(thin.length);
        expect(thick.leaves).toBeGreaterThan(thin.leaves);
    });
});

describe('runner — LOD + caps (§2.5 / §7)', () => {
    it('thins leaves with the LOD level', () => {
        const near = grow({ lodLevel: 0 }, 13).r, mid = grow({ lodLevel: 1 }, 13).r, far = grow({ lodLevel: 2 }, 13).r;
        expect(mid.leaves).toBeLessThan(near.leaves);
        expect(far.leaves).toBeLessThan(mid.leaves);
        expect(RUNNER_LOD_SCALE[0]).toBe(1);
        // The RUNNERS (the silhouette) survive — LOD widens the leaf spacing, it does not delete the plant.
        expect(far.runners).toBe(near.runners);
    });

    it('caps runners and leaves, and LOGS the truncation (never a silent density loss)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const capped = grow({ runnerCount: 40, branchChance: 0.4, maxRunners: 6, maxLength: 2 }, 19).r;
        expect(capped.runners).toBeLessThanOrEqual(6);
        expect(String(warn.mock.calls[0][0])).toMatch(/capped/i);
        warn.mockClear();
        const few = grow({ maxLeaves: 12 }, 19).r;
        expect(few.leaves).toBe(12);
        expect(few.truncated).toBe(true);
        expect(String(warn.mock.calls[0][0])).toMatch(/budget/i);
        warn.mockClear();
        const fine = grow({ maxRunners: MAX_RUNNERS, maxLeaves: MAX_RUNNER_LEAVES }, 19).r;
        expect(fine.truncated).toBe(false);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('the host is an INTERFACE (a plane today, a mesh later) and `tangentUp` works for any of them', () => {
        const hit = WALL.project([0.4, 1.2, 3]);
        expect(cfLen(cfSub(hit.p, [0.4, 1.2, 0]))).toBeLessThan(1e-9);   // projected onto the plane
        expect(hit.inside).toBe(true);
        expect(WALL.project([9, 1, 0]).inside).toBe(false);      // off the region → this is where ivy hangs
        expect(WALL.at(0.5, 0.5).p).toEqual([0, 1, 0]);
        expect(WALL.size).toEqual([2, 2]);
        expect(cfLen(cfSub(tangentUp([0, 0, 1]), [0, 1, 0]))).toBeLessThan(1e-9);   // a wall: "up" is up
        expect(cfLen(tangentUp([0, 1, 0]))).toBeCloseTo(1, 6);   // a floor: still a valid tangent
    });
});

describe('ivy / vine REBUILT on the runner primitive (§4)', () => {
    const by = (partial: Parameters<typeof buildFoliage>[0], n: string) => buildFoliage(partial).layers.find(l => l.name === n);

    it('keeps the type names, and is registered as a real-geometry archetype', () => {
        for (const t of ['ivy', 'vine'] as const) {
            expect(FOLIAGE_TYPES).toContain(t);
            expect(RUNNER_TYPES.has(t)).toBe(true);
            expect(BLADE_TYPES.has(t)).toBe(false);
            expect(FLOWER_TYPES.has(t)).toBe(false);
            expect(GROUND_PLANTED.has(t)).toBe(false);            // attached to a WALL, never planted in soil
            expect(buildFoliage({ type: t }).meta.type).toBe(t);
            // Real swept geometry → never alpha-cut, and the ground bleed stays off.
            const leaf = by({ type: t, render: 'card' }, 'foliage:leaf')!;
            expect(leaf.leafCard).toBeFalsy();
            expect(leaf.foliageShade!.groundBlend).toBe(0);
            expect(leaf.foliageShade!.translucency!).toBeGreaterThan(0.7);   // backlit ivy glows
        }
    });

    it('no longer emits the old random BLOBS — it is swept stems + swept leaves now', () => {
        const { layers, meta } = buildFoliage({ type: 'ivy', seed: 3 });
        const leaf = layers.find(l => l.name === 'foliage:leaf')!;
        const stem = layers.find(l => l.name === 'foliage:stem')!;
        expect(stem).toBeDefined();                                        // ★ the woody runner has its OWN layer
        expect(stem.color).not.toEqual(leaf.color);                        // ...and its own pale colour
        // A `blob` is an octahedron and a leaf CARD is a unit-UV quad; a swept leaf strip only ever carries
        // the two edge columns + the fold ridge, with v running base → tip.
        const vs = readVerts(leaf.geometry);
        expect(vs.length).toBeGreaterThan(60);
        for (const q of vs) expect([0, 0.5, 1]).toContain(q.u);
        expect(Math.min(...vs.map(q => q.v))).toBeCloseTo(0, 6);
        expect(Math.max(...vs.map(q => q.v))).toBeCloseTo(1, 6);
        // The old version sprayed leaves over a flat z ≈ 0..0.11 slab at RANDOM heights with no structure;
        // the new one grows OFF the wall (+Z) and reaches real height.
        expect(Math.min(...vs.map(q => q.p[2]))).toBeGreaterThan(-0.02);
        expect(meta.height).toBeGreaterThan(0.3);
    });

    it('★ AREA width/height + leaf density are the panel knobs, and they reach the geometry', () => {
        const wide = buildFoliage({ type: 'ivy', areaWidth: 4, areaHeight: 1.5, seed: 2 });
        const narrow = buildFoliage({ type: 'ivy', areaWidth: 1, areaHeight: 1.5, seed: 2 });
        const spread = (r: typeof wide): number => Math.max(...r.meta.footprint.map(f => Math.abs(f[0])));
        expect(spread(wide)).toBeGreaterThan(spread(narrow));
        expect(buildFoliage({ type: 'ivy', areaHeight: 3, seed: 2 }).meta.height)
            .toBeGreaterThan(buildFoliage({ type: 'ivy', areaHeight: 1, seed: 2 }).meta.height);
        // Leaf density = the sparse-runner ↔ carpet continuum, on the SAME runners.
        const geo = (d: number): number => buildFoliage({ type: 'ivy', leafDensity: d, seed: 2 }).layers.find(l => l.name === 'foliage:leaf')!.geometry.vertices.length;
        expect(geo(0.15)).toBeLessThan(geo(1) * 0.6);
        // `width` / `size` still work as the area (existing saves carry only those).
        expect(buildFoliage({ type: 'ivy', width: 3, seed: 2 }).meta.footprint[1][0]).toBeCloseTo(1.5, 6);
    });

    it('★ PATH mode: an authored point list drives the same generator', () => {
        const path: [number, number, number][] = [[-0.8, 0.2, 0], [-0.2, 0.6, 0], [0.4, 0.7, 0], [1, 1.1, 0]];
        const { layers, meta } = buildFoliage({ type: 'ivy', ivyMode: 'path', ivyPath: path, seed: 4 });
        const leaf = layers.find(l => l.name === 'foliage:leaf')!;
        expect(leaf.geometry.vertices.length).toBeGreaterThan(0);
        expect(meta.height).toBeGreaterThan(0.7);                     // it followed the path UP
        expect(meta.height).toBeLessThan(1.6);
        // The leaves live along the authored line, not over the whole area.
        const xs = readVerts(leaf.geometry).map(q => q.p[0]);
        expect(Math.min(...xs)).toBeGreaterThan(-1.2);
        expect(Math.max(...xs)).toBeLessThan(1.4);
        // A degenerate path falls back to AREA mode rather than emitting nothing.
        expect(buildFoliage({ type: 'ivy', ivyMode: 'path', ivyPath: [[0, 0, 0]] }).layers.length).toBeGreaterThan(0);
    });

    it('★ WIND is graded by ATTACHMENT, not by height (clinging ivy must not swing like grass)', () => {
        const { layers, meta } = buildFoliage({ type: 'ivy', areaHeight: 1.2, runnerLength: 4, growthBias: 1, coverage: 1, seed: 8 });
        const leaf = layers.find(l => l.name === 'foliage:leaf')!;
        const free = layers.find(l => l.name === 'foliage:leaf-free') ?? layers.find(l => l.name === 'foliage:tip-free')!;
        const stem = layers.find(l => l.name === 'foliage:stem')!;
        expect(free).toBeDefined();
        expect(free.wind!.amount).toBeGreaterThan(leaf.wind!.amount * 10);   // free tips swing, clinging leaves don't
        expect(leaf.wind!.amount).toBeLessThan(0.1);
        expect(stem.wind!.amount).toBeLessThan(leaf.wind!.amount + 1e-9);    // the clinging stem is the stillest thing
        // The height grade is deliberately FLATTENED for climbers (they are attached at every height).
        expect(FOLIAGE_WIND['ivy'][0]).toBeLessThan(1);
        expect(FOLIAGE_WIND['vine'][0]).toBeLessThan(1);
        expect(FOLIAGE_WIND['ivy'][0]).toBeLessThan(FOLIAGE_WIND['grass-tuft'][0]);
        // ...and the S1 contract still holds: ONE windHeight + ONE stiffness for every layer of the plant.
        for (const L of layers) {
            expect(L.wind!.height).toBeCloseTo(Math.max(0.05, meta.height), 6);
            expect(L.wind!.stiffness).toBe(FOLIAGE_WIND['ivy'][0]);
            expect(L.wind!.amount).toBeGreaterThan(0);
        }
    });

    it('the new params ROUND-TRIP and every one of them moves the mesh', () => {
        const p = resolveFoliageParams({
            type: 'ivy', ivyMode: 'path', ivyPath: [[0, 0, 0], [1, 1, 0]], areaWidth: 3, areaHeight: 2,
            leafDensity: 0.4, coverage: 0.9, runnerCount: 7, runnerLength: 2.5, runnerStep: 0.07,
            branchChance: 0.1, growthBias: 0.5, wander: 0.3, leafSpacing: 0.09, leafSize: 0.08,
            leafSizeVar: 0.1, leafDroop: 0.7, phyllotaxy: 'opposite', stemColor: [0.5, 0.4, 0.3], runnerLod: 1,
        });
        expect(p.ivyMode).toBe('path');
        expect(p.ivyPath).toEqual([[0, 0, 0], [1, 1, 0]]);
        expect(p.phyllotaxy).toBe('opposite');
        expect(p.stemColor).toEqual([0.5, 0.4, 0.3]);
        expect(resolveFoliageParams({ type: 'ivy' }).ivyMode).toBeUndefined();   // omitted = the recipe's own value
        const verts = (over: Parameters<typeof buildFoliage>[0]): number =>
            buildFoliage({ type: 'ivy', seed: 6, ...over }).layers.find(l => l.name === 'foliage:leaf')!.geometry.vertices.length;
        const base = verts({});
        expect(verts({ runnerCount: 1 })).toBeLessThan(base);
        expect(verts({ leafSpacing: 0.2 })).toBeLessThan(base);
        expect(verts({ phyllotaxy: 'opposite' })).toBeGreaterThan(base);
        expect(verts({ runnerLod: 2 })).toBeLessThan(base);
        expect(buildFoliage({ type: 'ivy', seed: 6, stemColor: [0.9, 0.1, 0.1] }).layers.find(l => l.name === 'foliage:stem')!.color).toEqual([0.9, 0.1, 0.1]);
    });

    it('`vine` is the same primitive with different numbers (fewer, longer, droopier)', () => {
        const ivy = buildFoliage({ type: 'vine', seed: 5 });
        expect(ivy.layers.find(l => l.name === 'foliage:stem')).toBeDefined();
        const leafV = readVerts(ivy.layers.find(l => l.name === 'foliage:leaf')!.geometry);
        for (const q of leafV) expect([0, 0.5, 1]).toContain(q.u);
        // Vine leaves are bigger and further apart than ivy's (the recipe, not a new code path).
        const bbox = (t: 'ivy' | 'vine'): number => {
            const vs = readVerts(buildFoliage({ type: t, seed: 5 }).layers.find(l => l.name === 'foliage:leaf')!.geometry);
            return vs.length;
        };
        expect(bbox('vine')).toBeLessThan(bbox('ivy'));      // sparser spacing → fewer leaves over the same area
    });
});
