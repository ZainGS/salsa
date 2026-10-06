import { describe, it, expect, beforeAll } from 'vitest';
import {
    bakeCrowdArchetype, crowdCharacterParams, crowdArchetypeCandidates, crowdCharClassOf, crowdCharPose,
    CROWD_CHAR_BUDGET, CROWD_CHAR_COUNT, CROWD_CHAR_POSES, CROWD_TOPS, CROWD_TROUSERS, CROWD_SKIRTS, CC_CODE_SKIN, CC_CODE_PHONE, ccSlotCode,
    CC_SLOT_TOP, CC_SLOT_HAIR, CC_SLOT_LEGS, CC_SLOT_SHOES, CC_SLOT_SKIRT, CROWD_TROUSERS_BLOCKED, type CrowdArchetype, type CrowdCharMesh,
} from './crowd-character';
import { SLOT_TOP, SLOT_HAIR, SLOT_LEGS, SLOT_SHOES, SLOT_SKIRT } from './crowd-instanced';
import { CP_COUNT, CP_HEAD, CP_PHONE, PV_COUNT } from './mannequin';

// Bakes are ~0.5–1 s each: bake two archetypes once (a skirt one, a trousers one) in a small pose set.
const POSES = ['stand', 'phone'] as const;
let skirtA: CrowdArchetype, trousersA: CrowdArchetype;
beforeAll(() => {
    skirtA = bakeCrowdArchetype(crowdCharacterParams(1), POSES);
    trousersA = bakeCrowdArchetype(crowdCharacterParams(0), POSES);
}, 120_000);

const meshes = (a: CrowdArchetype): CrowdCharMesh[] => [...a.poses.values()].flatMap((b) => [b.near, b.mid]);
const ALLOWED = new Set([CC_CODE_SKIN, CC_CODE_PHONE, ...[CC_SLOT_TOP, CC_SLOT_HAIR, CC_SLOT_LEGS, CC_SLOT_SHOES, CC_SLOT_SKIRT].map(ccSlotCode)]);

describe('crowd characters — params', () => {
    it('slot numbers are the xfar variant slots (crowd-instanced SLOT_*)', () => {
        expect([CC_SLOT_TOP, CC_SLOT_HAIR, CC_SLOT_LEGS, CC_SLOT_SHOES, CC_SLOT_SKIRT]).toEqual([SLOT_TOP, SLOT_HAIR, SLOT_LEGS, SLOT_SHOES, SLOT_SKIRT]);
    });
    it('are deterministic, constrained and whitelisted', () => {
        for (let i = 0; i < CROWD_CHAR_COUNT; i++) {
            const p = crowdCharacterParams(i);
            expect(crowdCharacterParams(i)).toEqual(p);
            expect(p.body.shoulderWidth!).toBeLessThanOrEqual(1);
            expect(p.body.legLength!).toBeLessThan(1.4);   // slimmer / longer than neutral, short of dollcore
            expect(p.body.headSize!).toBeLessThan(1.25);
            expect([...CROWD_TOPS] as string[]).toContain(p.names.top);
            expect([...(p.cls.skirt ? CROWD_SKIRTS : CROWD_TROUSERS)] as string[]).toContain(p.names.bottom);
            expect(p.hair.hairMode).toBe('locks');
            expect(p.hair.frontDrape).toBe(0);
        }
    });
    it('every class appears and a class lists only its own archetypes', () => {
        const c = crowdCharClassOf(1);
        const cand = crowdArchetypeCandidates(c, 0.3);
        expect(cand.length).toBeGreaterThan(1);
        for (const i of cand) expect(crowdCharClassOf(i)).toEqual(c);
        expect(new Set(cand).size).toBe(cand.length);
    });
    it('trousers classes are not offered while the pant-leg web blocks them (see CROWD_TROUSERS_BLOCKED)', () => {
        if (CROWD_TROUSERS_BLOCKED) expect(crowdArchetypeCandidates(crowdCharClassOf(0), 0.5)).toEqual([]);
        else expect(crowdArchetypeCandidates(crowdCharClassOf(0), 0.5).length).toBeGreaterThan(0);
    });
    it('poses exist for the baked set only', () => {
        for (const p of CROWD_CHAR_POSES) expect(crowdCharPose(p)).not.toBeNull();
        expect(crowdCharPose('sit')).toBeNull();
    });
});

describe('crowd characters — bake', () => {
    it('is deterministic', () => {
        const b = bakeCrowdArchetype(crowdCharacterParams(1), ['stand']);
        const x = b.poses.get('stand')!, y = skirtA.poses.get('stand')!;
        expect(Array.from(x.near.pos)).toEqual(Array.from(y.near.pos));
        expect(Array.from(x.near.indices)).toEqual(Array.from(y.near.indices));
        expect(Array.from(x.mid.code)).toEqual(Array.from(y.mid.code));
        expect(Array.from(x.pivots)).toEqual(Array.from(y.pivots));
    }, 60_000);
    it('meets the NEAR / MID budgets', () => {
        for (const a of [skirtA, trousersA]) for (const b of a.poses.values()) {
            expect(b.near.tris).toBeLessThanOrEqual(CROWD_CHAR_BUDGET.near);
            expect(b.mid.tris).toBeLessThanOrEqual(CROWD_CHAR_BUDGET.mid);
            expect(b.mid.tris).toBeLessThan(b.near.tris);
        }
    });
    it('the gate: no failing (archetype, pose) pair is emitted, and failures are recorded as dropped', () => {
        for (const a of [skirtA, trousersA]) {
            for (const p of POSES) {
                const pass = a.gate[p].every((c) => c.pass);
                expect(a.poses.has(p)).toBe(pass);
                expect(a.dropped.includes(p)).toBe(!pass);
            }
        }
        expect(skirtA.poses.has('stand')).toBe(true);   // the skirt set passes in the plain stance
        // …and so do trousers now that layering uses the limb side mask (the pants-web fix, garment-layers.ts)
        if (!CROWD_TROUSERS_BLOCKED) expect(trousersA.poses.has('stand'), JSON.stringify(trousersA.gate.stand)).toBe(true);
    });
    it('slot codes cover every vertex; parts / ranges cover every index', () => {
        for (const a of [skirtA, trousersA]) for (const m of meshes(a)) {
            const n = m.pos.length / 3;
            expect(m.code.length).toBe(n); expect(m.part.length).toBe(n); expect(m.nrm.length).toBe(n * 3);
            for (let i = 0; i < n; i++) expect(ALLOWED.has(m.code[i])).toBe(true);
            expect(m.partRanges.length).toBe(CP_COUNT + 1);
            expect(m.partRanges[0]).toBe(0); expect(m.partRanges[CP_COUNT]).toBe(m.indices.length);
            for (let p = 0; p < CP_COUNT; p++) {
                expect(m.partRanges[p + 1]).toBeGreaterThanOrEqual(m.partRanges[p]);
                for (let k = m.partRanges[p]; k < m.partRanges[p + 1]; k++) { expect(m.indices[k]).toBeLessThan(n); expect(m.part[m.indices[k]]).toBe(p); }
            }
        }
    });
    it('no face geometry: the head is only skin + hair (no eyes / face kit), the phone only in the phone pose', () => {
        for (const a of [skirtA, trousersA]) for (const [pose, b] of a.poses) for (const m of [b.near, b.mid]) {
            for (let i = 0; i < m.code.length; i++) {
                if (m.part[i] === CP_HEAD) expect([CC_CODE_SKIN, ccSlotCode(CC_SLOT_HAIR)]).toContain(m.code[i]);
                if (m.code[i] === CC_CODE_PHONE) { expect(pose).toBe('phone'); expect(m.part[i]).toBe(CP_PHONE); }
            }
        }
    });
    it('canonical frame: feet on the ground, ~1.70 m, facing +X, pivots in the body', () => {
        const b = skirtA.poses.get('stand')!, P = b.near.pos;
        let y0 = Infinity, y1 = -Infinity;
        for (let i = 1; i < P.length; i += 3) { y0 = Math.min(y0, P[i]); y1 = Math.max(y1, P[i]); }
        expect(Math.abs(y0)).toBeLessThan(0.03);
        expect(y1).toBeGreaterThan(1.62); expect(y1).toBeLessThan(1.95);   // (+ hair volume)
        expect(b.pivots.length).toBe(PV_COUNT * 3);
        // PV_ARML (index 2) on the left = -Z, PV_ARMR on the right = +Z; the head pivot well above the hips
        expect(b.pivots[2 * 3 + 2]).toBeLessThan(0); expect(b.pivots[3 * 3 + 2]).toBeGreaterThan(0);
        expect(b.pivots[1 * 3 + 1]).toBeGreaterThan(b.pivots[0 * 3 + 1] + 0.3);
    });
});
