/**
 * crowdStyle 'character' in the instanced crowd (docs/specs/crowd-characters.md Phase 2): the records carry a preferred
 * archetype only when the switch is on (default 'mannequin' = unchanged records + cells); a near / mid cell emits the
 * baked archetype for those people (palette-coded, live-crowd ranges + pivots), the mannequin for the rest; the xfar
 * tier is untouched; the worker job path builds the same cell.
 */
import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import {
    buildPedestriansInstanced, CrowdCellBuilder, crowdPeopleOf, crowdCellJob, buildCrowdCell, adoptCrowdCell, recordInput, crowdClassOfLook,
    CREC_STRIDE, CREC_CHAR, CREC_CX, CREC_CZ,
} from './crowd-instanced';
import { crowdArchetype, crowdArchetypeCandidates, CROWD_CHAR_POSES, CROWD_CHAR_BUDGET } from './crowd-character';
import { rigGroupOf, RG_COUNT } from './crowd-live';
import { CP_COUNT } from './mannequin';
import { FLOATS_PER_VERT } from '../renderer/3d/mesh-generators';
import type { LayoutPreviewLayer } from './types';

const opts = { seed: 5, radius: 10, pattern: 'grid', border: 'square' } as const;
const recOf = (Ls: LayoutPreviewLayer[]) => Ls.find((L) => L.crowdRecords)!.crowdRecords!;
const base = buildPedestriansInstanced(generateCityLayout({ ...opts }), null);
const chars = buildPedestriansInstanced(generateCityLayout({ ...opts, crowdStyle: 'character' }), null);
const rb = recOf(base), rc = recOf(chars);

describe("crowdStyle 'character' — records", () => {
    it("default ('mannequin' / absent): no person carries an archetype", () => {
        for (let i = 0; i < rb.n; i++) expect(rb.recs[i * CREC_STRIDE + CREC_CHAR]).toBe(-1);
    });
    it('on: eligible people carry an archetype of their own class; everything else in the record is unchanged', () => {
        expect(rc.n).toBe(rb.n);
        let n = 0;
        for (let i = 0; i < rc.n; i++) {
            const o = i * CREC_STRIDE, a = rc.recs[o + CREC_CHAR], inp = recordInput(rc, i);
            for (let k = 0; k < CREC_STRIDE; k++) if (k !== CREC_CHAR) expect(rc.recs[o + k]).toBe(rb.recs[o + k]);
            if (a < 0) continue;
            n++;
            expect(CROWD_CHAR_POSES).toContain(inp.pose);
            expect(inp.umb).toBeNull();
            expect(crowdArchetypeCandidates(crowdClassOfLook(inp.look), 0)).toContain(a);
        }
        expect(n).toBeGreaterThan(0);
    });
    it('the xfar tier is the same (mannequin variants) either way', () => {
        const strip = (Ls: LayoutPreviewLayer[]): unknown[] => Ls.filter((L) => L.crowdInst).map((L) => [L.name, L.instanceKey, L.instances]);
        expect(strip(chars)).toEqual(strip(base));
    });
});

describe("crowdStyle 'character' — near / mid cells", () => {
    // the biggest cell holding at least one character person
    const cells = new Map<string, number[]>();
    for (let i = 0; i < rc.n; i++) { const k = rc.recs[i * CREC_STRIDE + CREC_CX] + ',' + rc.recs[i * CREC_STRIDE + CREC_CZ]; (cells.get(k) ?? cells.set(k, []).get(k)!).push(i); }
    const list = [...cells.values()].filter((l) => l.some((i) => rc.recs[i * CREC_STRIDE + CREC_CHAR] >= 0)).sort((a, b) => b.length - a.length)[0];

    it('emit the baked archetype for character people (the live-crowd ranges + pivots stay valid), mannequins for the rest', () => {
        expect(list).toBeTruthy();
        const people = crowdPeopleOf(rc), peopleM = crowdPeopleOf(rb);
        for (const lod of [0, 1] as const) {
            const g = new CrowdCellBuilder(rc, people, list, lod).finish();
            const gm = new CrowdCellBuilder(rb, peopleM, list, lod).finish();
            expect(g.indices.length).not.toBe(gm.indices.length);   // the character people changed the cell
            const nv = g.vertices.length / FLOATS_PER_VERT;
            for (const k of g.indices) expect(k).toBeLessThan(nv);
            const R = g.crowd!.ranges;
            let charTris = 0;
            for (let r = 0; r < R.length; r += 4) {
                const pi = R[r], part = R[r + 1];
                expect(list).toContain(pi);
                expect(part).toBeLessThan(CP_COUNT);
                expect(rigGroupOf(people[pi], part)).toBeLessThan(RG_COUNT);
                expect(R[r + 2] + R[r + 3]).toBeLessThanOrEqual(g.indices.length);
                if (rc.recs[pi * CREC_STRIDE + CREC_CHAR] >= 0) charTris += R[r + 3] / 3;
            }
            expect(charTris).toBeGreaterThan(0);
            // pivots written for every person (non-zero)
            for (const i of list) expect(people[i].piv.some((v) => v !== 0)).toBe(true);
        }
    }, 120_000);
    it('per person: at most the tier budget', () => {
        const people = crowdPeopleOf(rc);
        const one = list.filter((i) => rc.recs[i * CREC_STRIDE + CREC_CHAR] >= 0 && crowdArchetype(rc.recs[i * CREC_STRIDE + CREC_CHAR]).poses.has(recordInput(rc, i).pose)).slice(0, 1);
        if (!one.length) return;
        for (const lod of [0, 1] as const) {
            const g = new CrowdCellBuilder(rc, people, one, lod).finish();
            expect(g.indices.length / 3).toBeLessThanOrEqual(lod === 0 ? CROWD_CHAR_BUDGET.near : CROWD_CHAR_BUDGET.mid);
        }
    }, 60_000);
    it('the worker job builds the identical cell', () => {
        const pA = crowdPeopleOf(rc), pB = crowdPeopleOf(rc);
        const a = new CrowdCellBuilder(rc, pA, list, 0).finish();
        const b = adoptCrowdCell(structuredClone(buildCrowdCell(crowdCellJob(rc, list, 0))), pB, list);
        expect(b.vertices).toEqual(a.vertices);
        expect(b.indices).toEqual(a.indices);
        expect(b.crowd!.ranges).toEqual(a.crowd!.ranges);
        for (const i of list) expect(pB[i].piv).toEqual(pA[i].piv);
    }, 60_000);
});
