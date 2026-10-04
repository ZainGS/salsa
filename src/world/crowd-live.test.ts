/**
 * src/world/crowd-live.test.ts — Round 7: the LIVE near-field crowd (crowd-live.ts + the builder metadata).
 *
 * Pins: every static-crowd triangle belongs to exactly one (person, part) range; the ranges survive the spatial
 * chunk split (a person never straddles two cells); the live rig at envelope 0 reproduces the static vertices
 * EXACTLY (no visible swap on promotion / demotion); the idle channels are deterministic, desynchronised and zero at
 * envelope 0; the promotion selection has hysteresis + a budget; and the per-frame idle update does not allocate.
 */

import { describe, it, expect } from 'vitest';
import { PerformanceObserver } from 'node:perf_hooks';
import { generateCityLayout } from './layout';
import { buildPedestrians } from './pedestrians';
import { chunkCityLayers } from './chunking';
import {
    type CrowdGeometry, type CrowdPerson, evalIdle, holdNoise, selectLive, extractPart, degenerateRange, rotYXZ, rigGroupOf,
    rigFrames, poseRig, makeIdleContext, buildIdleContext, CH_COUNT, RG_COUNT, RIG_STRIDE, RG_HEAD, CH_HYAW,
} from './crowd-live';

const graph = generateCityLayout({ seed: 5, radius: 10, pattern: 'grid', border: 'square', instancedCrowd: false });
const layers = buildPedestrians(graph);
const geo = (i: number): CrowdGeometry => layers[i].geometry as CrowdGeometry;

describe('static crowd — per-person part ranges', () => {
    it('every layer carries crowd metadata whose ranges tile its index buffer exactly', () => {
        expect(layers.length).toBeGreaterThan(4);
        for (const L of layers) {
            const g = L.geometry as CrowdGeometry, m = g.crowd!;
            expect(m, L.name).toBeTruthy();
            let at = 0;
            for (let r = 0; r < m.ranges.length; r += 4) {
                expect(m.ranges[r + 2], L.name).toBe(at);            // contiguous, in index order
                expect(m.ranges[r + 3] % 3).toBe(0);                  // whole triangles
                at += m.ranges[r + 3];
            }
            expect(at, L.name).toBe(g.indices.length);                // nothing unowned
        }
    });

    it("a person's ranges in one layer are contiguous (one run per person) and the ref vertex is the range's first", () => {
        for (const L of layers) {
            const m = (L.geometry as CrowdGeometry).crowd!, seen = new Set<number>();
            let last = -1;
            for (let r = 0; r < m.ranges.length; r += 4) {
                const p = m.ranges[r];
                if (p !== last) { expect(seen.has(p), `${L.name} person ${p} split`).toBe(false); seen.add(p); last = p; }
                const vi = L.geometry.indices[m.ranges[r + 2]] * 12;
                expect(m.refs[(r / 4) * 3]).toBe(L.geometry.vertices[vi]);
            }
        }
    });

    it('records pivots, holds and conversation groups; deterministic per seed', () => {
        const people = geo(0).crowd!.people;
        expect(people.length).toBeGreaterThan(100);
        for (const p of people) {
            expect(p.piv.length).toBe(18);
            expect(p.piv.every(Number.isFinite)).toBe(true);
            expect(p.piv[4]).toBeGreaterThan(p.piv[1]);   // neck above the hip
        }
        const groups = people.filter(p => p.group >= 0);
        expect(groups.length).toBeGreaterThan(4);
        const again = buildPedestrians(generateCityLayout({ seed: 5, radius: 10, pattern: 'grid', border: 'square', instancedCrowd: false }));
        expect(Array.from((again[0].geometry as CrowdGeometry).crowd!.ranges)).toEqual(Array.from(geo(0).crowd!.ranges));
        expect((again[0].geometry as CrowdGeometry).crowd!.people.map(p => p.pose + p.holdR + p.group)).toEqual(people.map(p => p.pose + p.holdR + p.group));
    });
});

describe('chunked crowd layers keep whole people', () => {
    it('remaps the ranges onto each cell (same triangles, person never split across cells)', () => {
        const src = buildPedestrians(graph);
        const cells = chunkCityLayers(src, { minCell: 0.4, targetTris: 400 });
        expect(cells.length).toBeGreaterThan(src.length);   // it did split
        // original triangle positions per (person, part) — keyed through the shared people array
        const key = (p: number, part: number, name: string): string => `${name}|${p}|${part}`;
        const orig = new Map<string, number[]>();
        for (const L of src) {
            const g = L.geometry as CrowdGeometry, m = g.crowd!;
            for (let r = 0; r < m.ranges.length; r += 4) {
                const pos: number[] = [];
                for (let i = m.ranges[r + 2]; i < m.ranges[r + 2] + m.ranges[r + 3]; i++) pos.push(g.vertices[g.indices[i] * 12], g.vertices[g.indices[i] * 12 + 1]);
                orig.set(key(m.ranges[r], m.ranges[r + 1], L.name + ':' + L.nearTwin?.role), pos);
            }
        }
        const cellOfPerson = new Map<string, string>();
        let checked = 0;
        for (const L of cells) {
            const g = L.geometry as CrowdGeometry, m = g.crowd!;
            expect(m, L.name).toBeTruthy();
            let at = 0;
            for (let r = 0; r < m.ranges.length; r += 4) {
                expect(m.ranges[r + 2]).toBe(at); at += m.ranges[r + 3];
                const pos: number[] = [];
                for (let i = m.ranges[r + 2]; i < m.ranges[r + 2] + m.ranges[r + 3]; i++) pos.push(g.vertices[g.indices[i] * 12], g.vertices[g.indices[i] * 12 + 1]);
                expect(pos).toEqual(orig.get(key(m.ranges[r], m.ranges[r + 1], L.name + ':' + L.nearTwin?.role)));
                // (both twins of a person share the SAME cell — exactly one of them draws there)
                const pk = `${m.ranges[r]}`, c = cellOfPerson.get(pk);
                if (c !== undefined) expect(c, 'person straddles two cells').toBe(L.chunk ?? '');
                cellOfPerson.set(pk, L.chunk ?? '');
                checked++;
            }
            expect(at).toBe(g.indices.length);
        }
        expect(checked).toBe(orig.size);
    }, 30000);   // both twins of ~500 HIGH + far mannequins (the full parallel suite is slow)
});

/** Apply one rig transform (x, y, z, ry, rz, rx → T·Ry·Rx·Rz, Mesh3D order) to a rebased vertex. */
function place(R: Float64Array, rg: number, v: Float32Array, i: number, out: Float64Array): void {
    const o = rg * RIG_STRIDE;
    rotYXZ(R[o + 3], R[o + 5], R[o + 4], v[i], v[i + 1], v[i + 2], out, 0);
    out[0] += R[o]; out[1] += R[o + 1]; out[2] += R[o + 2];
}

describe('live rig at t0 reproduces the static person exactly', () => {
    it('lifted parts placed by poseRig(env = 0) land on the static vertices (every person of a layer set)', () => {
        const people = geo(0).crowd!.people, ctx = makeIdleContext();
        const ch = new Float32Array(CH_COUNT), R = new Float64Array(RG_COUNT * RIG_STRIDE), tmp = new Float64Array(3), w = new Float64Array(3);
        let worst = 0, n = 0;
        // the "render" geometry = the static one shifted by the build → render offset (drape / warp stand-in)
        const shiftedCache = new Map<object, CrowdGeometry>();
        const shiftedOf = (g: CrowdGeometry): CrowdGeometry => {
            let sg = shiftedCache.get(g);
            if (!sg) {
                sg = { ...g, vertices: g.vertices.slice() };
                for (let i = 0; i < sg.vertices.length; i += 12) { sg.vertices[i] += 0.013; sg.vertices[i + 1] += 0.021; sg.vertices[i + 2] -= 0.017; }
                shiftedCache.set(g, sg);
            }
            return sg;
        };
        for (let pi = 0; pi < people.length; pi += 7) {
            const P = people[pi];
            const piv = new Float64Array(RG_COUNT * 3), rel = new Float64Array(RG_COUNT * 3);
            rigFrames(P, 0.013, 0.021, -0.017, piv, rel);   // an arbitrary build → render offset (drape / warp)
            evalIdle(P, ctx, 12.34, 0, ch);
            poseRig(P.yaw, piv, rel, ch, R, tmp);
            for (const L of layers) {
                const g = L.geometry as CrowdGeometry, m = g.crowd!;
                const byRg: number[][] = Array.from({ length: RG_COUNT }, () => []);
                for (let r = 0; r < m.ranges.length; r += 4) if (m.ranges[r] === pi) byRg[rigGroupOf(P, m.ranges[r + 1])].push(m.ranges[r + 2], m.ranges[r + 3]);
                for (let rg = 0; rg < RG_COUNT; rg++) {
                    if (!byRg[rg].length) continue;
                    const shifted = shiftedOf(g);
                    const part = extractPart(shifted, byRg[rg], piv.subarray(rg * 3, rg * 3 + 3), P.yaw);
                    // triangle-for-triangle: the part's k-th index ↔ the source ranges' k-th index
                    let k = 0;
                    for (let r = 0; r < byRg[rg].length; r += 2) for (let i = byRg[rg][r]; i < byRg[rg][r] + byRg[rg][r + 1]; i++, k++) {
                        place(R, rg, part.vertices, part.indices[k] * 12, w);
                        const sv = shifted.vertices, si = shifted.indices[i] * 12;
                        worst = Math.max(worst, Math.abs(w[0] - sv[si]), Math.abs(w[1] - sv[si + 1]), Math.abs(w[2] - sv[si + 2]));
                        n++;
                    }
                }
            }
        }
        expect(n).toBeGreaterThan(1000);
        expect(worst).toBeLessThan(2e-6);   // float rounding only (world units; ≈ 0.03 mm)
    });

    it('a non-zero envelope actually moves the head (and only by a subtle amount)', () => {
        const people = geo(0).crowd!.people, P = people.find(p => p.pose !== 'sit')!;
        const ch = new Float32Array(CH_COUNT), ctx = makeIdleContext();
        let maxYaw = 0;
        for (let t = 0; t < 30; t += 0.25) { evalIdle(P, ctx, t, 1, ch); maxYaw = Math.max(maxYaw, Math.abs(ch[CH_HYAW])); }
        expect(maxYaw).toBeGreaterThan(0.05);
        expect(maxYaw).toBeLessThan(0.9);
        void RG_HEAD;
    });
});

describe('idle channels', () => {
    const people = geo(0).crowd!.people;
    it('are exactly zero at envelope 0 and deterministic', () => {
        const a = new Float32Array(CH_COUNT), b = new Float32Array(CH_COUNT), ctx = makeIdleContext();
        for (const P of people.slice(0, 50)) {
            evalIdle(P, ctx, 7.7, 0, a);
            expect(Array.from(a).every(v => v === 0)).toBe(true);
            evalIdle(P, ctx, 7.7, 1, a); evalIdle(P, ctx, 7.7, 1, b);
            expect(Array.from(a)).toEqual(Array.from(b));
        }
    });
    it('are desynchronised between people and smooth in time (no pops)', () => {
        const ctx = makeIdleContext(), a = new Float32Array(CH_COUNT), b = new Float32Array(CH_COUNT);
        evalIdle(people[0], ctx, 5, 1, a); evalIdle(people[1], ctx, 5, 1, b);
        expect(Array.from(a)).not.toEqual(Array.from(b));
        const worst = { d: 0, at: '' };
        const grouped = people.map((q, i) => i).filter(i => people[i].group >= 0).slice(0, 24);
        for (const pi of [...people.slice(0, 40).map((_, i) => i), ...grouped]) {
            const P = people[pi];
            if (P.group >= 0) buildIdleContext(people, pi, people.map((q, i) => i).filter(i => people[i].group === P.group), ctx);
            else { ctx.groupN = 0; ctx.nLook = 0; }
            let prev = new Float32Array(CH_COUNT); evalIdle(P, ctx, 0, 1, prev);
            for (let t = 1 / 60; t < 20; t += 1 / 60) {
                evalIdle(P, ctx, t, 1, a);
                for (let c = 0; c < CH_COUNT; c++) {
                    const d = Math.abs(a[c] - prev[c]);
                    if (d > worst.d) { worst.d = d; worst.at = `${P.pose} ch ${c} @${t.toFixed(2)}`; }
                }
                prev.set(a);
            }
        }
        expect(worst.d, worst.at).toBeLessThan(0.04);   // ≤ 0.04 rad (or world units) per 60 Hz frame — no snaps
    });
    it('holdNoise stays in [-1, 1] and holds between transitions', () => {
        for (let t = 0; t < 50; t += 0.37) { const v = holdNoise(3, 9, t, 3, 0.3); expect(v).toBeGreaterThanOrEqual(-1); expect(v).toBeLessThanOrEqual(1); }
    });
    it('group listeners turn toward the other members', () => {
        const members = people.map((p, i) => ({ p, i })).filter(q => q.p.group >= 0);
        const g0 = members[0].p.group, ring = members.filter(q => q.p.group === g0).map(q => q.i);
        const ctx = makeIdleContext();
        buildIdleContext(people, ring[0], ring, ctx);
        expect(ctx.groupN).toBe(ring.length);
        expect(ctx.nLook).toBe(Math.min(4, ring.length - 1));
        // ring members face the middle → the others are within ±~75° of straight ahead
        for (let k = 0; k < ctx.nLook; k++) expect(Math.abs(ctx.look[k])).toBeLessThanOrEqual(0.75 + 1e-6);
    });
});

describe('promotion selection (hysteresis + budget)', () => {
    const n = 6;
    const d2 = new Float32Array(n), iv = new Uint8Array(n).fill(1), live = new Uint8Array(n), want = new Uint8Array(n);
    const order = new Int32Array(n), key = new Float32Array(n);
    it('promotes inside rIn, keeps until rOut, drops beyond', () => {
        d2.set([1, 16, 30, 50, 100, 200].map(v => v));   // distances² ; rIn = 5 (25), rOut = 7 (49)
        selectLive(n, d2, iv, live, 5, 7, 10, want, order, key);
        expect(Array.from(want)).toEqual([1, 1, 0, 0, 0, 0]);
        live.set([1, 1, 1, 1, 0, 0]);   // people 2 + 3 were live: 2 (30 < 49) stays, 3 (50) goes
        selectLive(n, d2, iv, live, 5, 7, 10, want, order, key);
        expect(Array.from(want)).toEqual([1, 1, 1, 0, 0, 0]);
    });
    it('caps at the budget, nearest + in-view first, with a bonus for the already-live', () => {
        d2.set([4, 9, 16, 3, 20, 2]); live.fill(0); iv.set([1, 1, 1, 0, 1, 1]);
        selectLive(n, d2, iv, live, 5, 7, 3, want, order, key);
        expect(Array.from(want)).toEqual([1, 1, 0, 0, 0, 1]);   // #3 is nearest but off-screen → after the visible ones
        live.set([0, 0, 1, 0, 0, 0]); iv.fill(1); d2.set([4, 9, 12, 30, 30, 30]);
        selectLive(n, d2, iv, live, 5, 7, 2, want, order, key);
        expect(Array.from(want)).toEqual([1, 0, 1, 0, 0, 0]);   // live #2 (12·0.64 = 7.7) beats static #1 (9)
    });
});

describe('index degeneration', () => {
    it('hides a range in place and restores it exactly', () => {
        const ix = Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        const b = degenerateRange(ix, 3, 3);
        expect(Array.from(ix)).toEqual([0, 1, 2, 3, 3, 3, 6, 7, 8]);
        ix.set(b, 3);
        expect(Array.from(ix)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });
});

describe('per-frame idle update does not allocate', () => {
    it('evalIdle + poseRig over 40 people × 3000 frames triggers no scavenge', async () => {
        const people: CrowdPerson[] = geo(0).crowd!.people.slice(0, 40);
        const ctxs = people.map(() => makeIdleContext());
        const ch = new Float32Array(CH_COUNT), R = new Float64Array(RG_COUNT * RIG_STRIDE), tmp = new Float64Array(3);
        const piv = people.map(() => new Float64Array(RG_COUNT * 3)), rel = people.map(() => new Float64Array(RG_COUNT * 3));
        people.forEach((p, i) => rigFrames(p, 0, 0, 0, piv[i], rel[i]));
        const sink = new Float64Array(1);   // (a captured `let` double would box → allocate per write)
        const run = (frames: number): void => {
            for (let f = 0; f < frames; f++) {
                const t = f / 60;
                for (let i = 0; i < people.length; i++) {
                    evalIdle(people[i], ctxs[i], t, 1, ch, 0);
                    poseRig(people[i].yaw, piv[i], rel[i], ch, R, tmp);
                    sink[0] += R[3];
                }
            }
        };
        // Warm up so the JIT optimises (interpreted code boxes doubles), then measure; under a loaded parallel test run
        // the optimising compiler can lag, so take the best of a few measurement rounds.
        run(3000);
        const counts: number[] = [];
        for (let round = 0; round < 4; round++) {
            let gcs = 0;
            const obs = new PerformanceObserver(list => { gcs += list.getEntries().length; });
            obs.observe({ entryTypes: ['gc'] });
            run(3000);   // 120k person-updates
            await new Promise(r => setTimeout(r, 30));
            obs.disconnect();
            counts.push(gcs);
            if (gcs === 0) break;
        }
        expect(Number.isFinite(sink[0])).toBe(true);
        expect(Math.min(...counts), `scavenges per round: ${counts.join(',')}`).toBe(0);
    });
});
