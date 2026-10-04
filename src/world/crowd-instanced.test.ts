/**
 * src/world/crowd-instanced.test.ts — performance-plan P12, the INSTANCED static crowd (crowd-instanced.ts).
 *
 * Pins: the person records are deterministic and are exactly the baked build's people (same anchors, facing, pose,
 * height, mirroring, umbrella); a lazily built near / mid cell emits EXACTLY the baked near / mid triangles of its
 * people (positions + normals, per colour, in emission order) with the per-vertex palette code of that colour; every
 * person has one xfar copy whose palette slots decode to its own colours; the xfar variant key names one geometry; the
 * cells are tile-aligned; and the build's per-tile payload is small.
 */
import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildPedestrians, staticCrowd, staticPersonSpec } from './pedestrians';
import {
    buildPedestriansInstanced, CrowdCellBuilder, crowdPeopleOf, crowdCellJob, buildCrowdCell, adoptCrowdCell, recordInput, xfarVariant, personSlots, clearXfarVariantCache, drapeCrowdRecords,
    CREC_STRIDE, CREC_X, CREC_Z, CREC_Y, CREC_POSE, CREC_FLIP, CREC_CX, CREC_CZ, CREC_DY, CROWD_POSES, CROWD_CELLS_PER_TILE, crowdBuildBytes,
    SLOT_TOP, SLOT_HAIR, SLOT_LEGS, SLOT_SHOES, SLOT_BAG, SLOT_COLLAR,
} from './crowd-instanced';
import { unpackCrowdSlot, crowdPaletteIndex, CROWD_PALETTE, CROWD_SLOT_BASE, crowdCodeIndex } from '../renderer/3d/crowd-palette';
import { PED_PALETTE } from './mannequin';
import type { CrowdGeometry } from './crowd-live';
import type { CrowdRecords, LayoutPreviewLayer } from './types';

const opts = { seed: 5, radius: 10, pattern: 'grid', border: 'square' } as const;
const graph = generateCityLayout({ ...opts });
const layers = buildPedestriansInstanced(graph, null);
const rec = layers.find(L => L.crowdRecords)!.crowdRecords!;

describe('crowd palette', () => {
    it('the renderer table is PED_PALETTE (names, order, values)', () => {
        const keys = Object.keys(PED_PALETTE);
        expect(CROWD_PALETTE.map(e => e[0])).toEqual(keys);
        for (const [n, r, g, b] of CROWD_PALETTE) expect([r, g, b]).toEqual(PED_PALETTE[n]);
        expect(CROWD_PALETTE.length).toBeLessThan(CROWD_SLOT_BASE);
    });
});

describe('instanced crowd records', () => {
    it('are the baked build\'s people: same anchors, facing, pose, origin height and mirroring', () => {
        const people = staticCrowd(graph, null);
        expect(rec.n).toBe(people.length);
        people.forEach((pp, i) => {
            const sp = staticPersonSpec(graph.params, pp, i), o = i * CREC_STRIDE, inp = recordInput(rec, i);
            expect(rec.recs[o + CREC_X]).toBe(pp.x); expect(rec.recs[o + CREC_Z]).toBe(pp.z); expect(rec.recs[o + CREC_Y]).toBe(sp.y);
            expect(CROWD_POSES[rec.recs[o + CREC_POSE]]).toBe(sp.pose);
            expect(rec.recs[o + CREC_FLIP] > 0).toBe(sp.flip);
            expect(inp.look).toEqual(sp.look);
            expect(inp.umb).toBe(sp.umb);
            expect(inp.f).toEqual(pp.face);
        });
    });

    it('are deterministic (two builds of the same city: identical records + copies)', () => {
        const again = buildPedestriansInstanced(generateCityLayout({ ...opts }), null);
        const r2 = again.find(L => L.crowdRecords)!.crowdRecords!;
        expect(Array.from(r2.recs)).toEqual(Array.from(rec.recs));
        const strip = (Ls: LayoutPreviewLayer[]): unknown[] => Ls.filter(L => L.crowdInst).map(L => [L.name, L.instanceKey, L.instances]);
        expect(strip(again)).toEqual(strip(layers));
    });

    it('cells are tile-aligned (CROWD_CELLS_PER_TILE per 2R) and every person sits in its cell', () => {
        const cell = (2 * graph.params.radius) / CROWD_CELLS_PER_TILE;
        expect(rec.cell).toBeCloseTo(cell, 9);
        for (let i = 0; i < rec.n; i++) {
            const o = i * CREC_STRIDE, cx = rec.recs[o + CREC_CX], x = rec.recs[o + CREC_X] + graph.params.radius;
            expect(x).toBeGreaterThanOrEqual(cx * cell - 1e-9); expect(x).toBeLessThan((cx + 1) * cell + 1e-9);
            expect(rec.recs[o + CREC_CZ]).toBe(Math.floor((rec.recs[o + CREC_Z] + graph.params.radius) / cell));
        }
    });

    it('the drape fills a rigid per-person offset (height tier at the feet; deck people on the smooth field)', () => {
        const r: CrowdRecords = { ...rec, recs: rec.recs.slice(), draped: false };
        drapeCrowdRecords(r, (x) => x * 0.01, () => 7, null);
        for (let i = 0; i < r.n; i++) {
            const o = i * CREC_STRIDE, deck = r.recs[o + 15] > 0;
            expect(r.recs[o + CREC_DY]).toBeCloseTo(deck ? 7 : r.recs[o + CREC_X] * 0.01, 12);
        }
        const before = r.recs.slice();
        drapeCrowdRecords(r, () => 99, () => 99, null);   // idempotent
        expect(Array.from(r.recs)).toEqual(Array.from(before));
    });
});

describe('lazy near / mid cells reproduce the baked people exactly', () => {
    const baked = buildPedestrians(generateCityLayout({ ...opts, instancedCrowd: false }));
    // (person, colour) → the baked tier's triangle vertices (positions + normals) in emission order
    const bakedTris = (role: 'near' | 'mid'): Map<string, number[]> => {
        const out = new Map<string, number[]>();
        for (const L of baked) {
            if (L.nearTwin?.role !== role) continue;
            const g = L.geometry as CrowdGeometry, m = g.crowd!, colour = L.name.replace(/^world:ped-(deck-)?/, '');
            for (let r = 0; r < m.ranges.length; r += 4) {
                const k = `${m.ranges[r]}|${colour}`;
                let a = out.get(k); if (!a) { a = []; out.set(k, a); }
                for (let t = m.ranges[r + 2]; t < m.ranges[r + 2] + m.ranges[r + 3]; t++) {
                    const vi = g.indices[t] * 12;
                    for (let f = 0; f < 6; f++) a.push(g.vertices[vi + f]);
                }
            }
        }
        return out;
    };
    for (const [lod, role] of [[0, 'near'], [1, 'mid']] as const) {
        it(`tier ${role}: same triangles per (person, colour), palette-coded`, () => {
            const people = crowdPeopleOf(rec);
            const all = Array.from({ length: rec.n }, (_, i) => i);
            const b = new CrowdCellBuilder(rec, people, all, lod);
            while (!b.step(5)) { /* sliced */ }
            const g = b.finish(), m = g.crowd!;
            const mine = new Map<string, number[]>();
            let bad = 0;
            for (let r = 0; r < m.ranges.length; r += 4) {
                const v0 = g.indices[m.ranges[r + 2]] * 12, colour = CROWD_PALETTE[Math.round(g.vertices[v0 + 6])][0];
                const k = `${m.ranges[r]}|${colour}`;
                let a = mine.get(k); if (!a) { a = []; mine.set(k, a); }
                for (let t = m.ranges[r + 2]; t < m.ranges[r + 2] + m.ranges[r + 3]; t++) {
                    const vi = g.indices[t] * 12;
                    if (g.vertices[vi + 6] !== g.vertices[v0 + 6]) bad++;   // one code per range
                    for (let f = 0; f < 6; f++) a.push(g.vertices[vi + f]);
                }
            }
            expect(bad).toBe(0);
            const ref = bakedTris(role);
            expect([...mine.keys()].sort()).toEqual([...ref.keys()].sort());
            let diff = 0;
            for (const [k, a] of ref) { const b2 = mine.get(k); if (!b2 || b2.length !== a.length || b2.some((v, j) => v !== a[j])) diff++; }
            expect(diff).toBe(0);
            // pivots + live metadata as the baked build records them
            const bakedPeople = (baked[0].geometry as CrowdGeometry).crowd!.people;
            people.forEach((p, i) => { expect(p.piv).toEqual(bakedPeople[i].piv); expect(p.holdR).toBe(bakedPeople[i].holdR); expect(p.group).toBe(bakedPeople[i].group); expect(p.yaw).toBeCloseTo(bakedPeople[i].yaw, 12); });
        }, 60000);
    }
});

describe('xfar copies', () => {
    it('every person has exactly one copy, scaled (width, height, width), carrying their own colours', () => {
        const seen = new Uint8Array(rec.n);
        for (const L of layers) {
            if (!L.crowdInst) continue;
            expect(L.name).toMatch(/^world:ped-/);
            expect(L.arrayGroup).toBe(true);
            for (const t of L.instances!) {
                const i = t.pi!;
                expect(seen[i]).toBe(0); seen[i] = 1;
                const look = recordInput(rec, i).look;
                expect(t.sv).toEqual([look.build, look.heightM / 1.7, look.build]);
                const cs = t.cs!;
                expect(unpackCrowdSlot(cs, SLOT_TOP)).toBe(crowdPaletteIndex(look.top));
                expect(unpackCrowdSlot(cs, SLOT_HAIR)).toBe(crowdPaletteIndex(look.hair));
                expect(unpackCrowdSlot(cs, SLOT_LEGS)).toBe(crowdPaletteIndex(look.legs));
                expect(unpackCrowdSlot(cs, SLOT_SHOES)).toBe(crowdPaletteIndex(look.shoes));
                expect(unpackCrowdSlot(cs, SLOT_BAG)).toBe(crowdPaletteIndex(look.bagColor));
                expect(unpackCrowdSlot(cs, SLOT_COLLAR)).toBe(look.collar ? crowdPaletteIndex(look.collar) : 0);
                expect(crowdCodeIndex(CROWD_SLOT_BASE + SLOT_TOP, cs)).toBe(crowdPaletteIndex(look.top));
                expect(crowdCodeIndex(crowdPaletteIndex('skin'), cs)).toBe(crowdPaletteIndex('skin'));
                expect(personSlots(look, recordInput(rec, i).umb)).toEqual(cs);
            }
        }
        expect(seen.every(v => v === 1)).toBe(true);
    });

    it('a variant key names ONE geometry (re-emitted from a cleared cache: identical), all codes valid', () => {
        const L = layers.find(x => x.crowdInst)!;
        const i = L.instances![0].pi!, inp = recordInput(rec, i);
        const a = xfarVariant(inp.look, inp.pose, inp.umb, inp.closed, inp.rail, rec.u);
        clearXfarVariantCache();
        const b = xfarVariant(inp.look, inp.pose, inp.umb, inp.closed, inp.rail, rec.u);
        expect(b).not.toBe(a);
        expect(b.key).toBe(a.key);
        expect(Array.from(b.geometry.vertices)).toEqual(Array.from(a.geometry.vertices));
        expect(Array.from(b.geometry.indices)).toEqual(Array.from(a.geometry.indices));
        for (let o = 6; o < b.geometry.vertices.length; o += 12) {
            const c = b.geometry.vertices[o];
            expect(Number.isInteger(c)).toBe(true);
            expect(c < CROWD_PALETTE.length || (c >= CROWD_SLOT_BASE && c < CROWD_SLOT_BASE + 12)).toBe(true);
        }
    });

    it('far fewer shared variants than people; the per-build payload is small', () => {
        const keys = new Set(layers.filter(L => L.crowdInst).map(L => L.instanceKey));
        expect(keys.size).toBeLessThan(rec.n / 3);
        const b = crowdBuildBytes(layers);
        expect(b.copies).toBe(rec.n);
        expect(b.records + b.slotBytes).toBeLessThan(400 * 1024);
        // the AUX layers never become meshes, carry the footprints for the contact pass, and are never re-chunked
        for (const L of layers.filter(x => x.crowdAux)) { expect(L.chunk).toBeTruthy(); expect(L.geometry.indices.length).toBeGreaterThan(0); }
        for (const L of layers.filter(x => x.crowdInst)) { expect(L.noContact).toBe(true); expect(L.chunk).toBeTruthy(); }
    });

    it('instancedCrowd:false still builds the baked layers (A/B)', () => {
        const b = buildPedestrians(generateCityLayout({ ...opts, instancedCrowd: false }));
        expect(b.some(L => L.crowdRecords || L.crowdInst)).toBe(false);
        expect(b.every(L => (L.geometry as CrowdGeometry).crowd)).toBe(true);
        expect(buildPedestrians(graph).some(L => L.crowdRecords)).toBe(true);
    });
});

describe('step 3: a cell built from its record rows (the near worker job)', () => {
    it('equals the main-thread CrowdCellBuilder exactly: vertices, indices, bounds, ranges, refs, pivots', () => {
        const r2 = { ...rec, recs: rec.recs.slice() };
        drapeCrowdRecords(r2, (x) => 0.01 * x, () => 0.02, (x, z, out) => { out[0] = 0.001 * z; out[1] = -0.001 * x; });   // non-zero offsets
        const peopleA = crowdPeopleOf(r2), peopleB = crowdPeopleOf(r2);
        const cells = new Map<string, number[]>();
        for (let i = 0; i < r2.n; i++) { const k = r2.recs[i * CREC_STRIDE + CREC_CX] + ',' + r2.recs[i * CREC_STRIDE + CREC_CZ]; (cells.get(k) ?? cells.set(k, []).get(k)!).push(i); }
        const lists = [...cells.values()].sort((a, b) => b.length - a.length).slice(0, 3);
        expect(lists.length).toBeGreaterThan(0);
        for (const list of lists) for (const lod of [0, 1] as const) {
            const a = new CrowdCellBuilder(r2, peopleA, list, lod).finish();
            const job = crowdCellJob(r2, list, lod);
            const res = structuredClone(buildCrowdCell(job));   // what crosses the worker boundary
            const b = adoptCrowdCell(res, peopleB, list);
            expect(b.vertices).toEqual(a.vertices);
            expect(b.indices).toEqual(a.indices);
            expect(b.bounds).toEqual(a.bounds);
            expect(b.crowd!.ranges).toEqual(a.crowd!.ranges);
            expect(b.crowd!.refs).toEqual(a.crowd!.refs);
            expect(b.crowd!.people).toBe(peopleB);
            for (const i of list) expect(peopleB[i].piv).toEqual(peopleA[i].piv);
        }
    }, 60000);
});
