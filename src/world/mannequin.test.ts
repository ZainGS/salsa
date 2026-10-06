// src/world/mannequin.test.ts — the Persona-style crowd mannequin (polish round 4, medium-poly pass R6.4): adult
// proportions, faceless heads, flat colour-block shading, feet on the ground in every pose, the walker gait (thighs +
// shins with a knee curve, arms + hands), and the triangle budgets (2026-09-30 fidelity pass: HIGH static ≈ 2.5k avg / ≤ 3.4k worst,
// FAR twin ≈ 0.85k / ≤ 1.1k, walkers ≤ 3.4k).
import { describe, it, expect } from 'vitest';
import { Accum3D } from './meshbuild';
import { ARCHETYPES, PED_PALETTE, PED_SHADE, armHold, armPivot, emitPerson, headFraction, kneePivot, legPivot, personLook, walkerParts, type PersonSink, type Pose } from './mannequin';
import { crowdLayer, staticPose } from './pedestrians';
import { kneeFlexCurve, walkerSink } from '../services/managers/world-traffic';

const U = 1 / 15;
const looks = ARCHETYPES.flatMap((_, i) => Array.from({ length: 8 }, (_, s) => personLook(i, s)));

function staticTris(i: number, pose: Pose = 'stand', lod: 0 | 1 = 1): number {
    const a = new Accum3D(), look = looks[i];
    const sink: PersonSink = { top: () => a, skin: () => a, hair: () => a, leg: () => a, shoes: () => a, skirt: () => a, bag: () => a, umbrella: () => null, collar: () => a, extra: () => a };
    emitPerson(sink, { o: [0, 0, 0], f: [1, 0], u: U }, look, { lod, pose });
    return a.triCount;
}
function walkerTris(i: number, umb: 'vinyl' | null = null): number {
    const p = walkerParts(looks[i], U, umb);
    return p.body.reduce((n, b) => n + b.acc.triCount, 0) + p.leg.accL.triCount + p.leg.accR.triCount + (p.arm.accL?.triCount ?? 0) + (p.arm.accR?.triCount ?? 0)
        + (p.shin ? p.shin.accL.triCount + p.shin.accR.triCount : 0) + (p.shoe ? p.shoe.accL.triCount + p.shoe.accR.triCount : 0)
        + (p.hand.accL?.triCount ?? 0) + (p.hand.accR?.triCount ?? 0);
}
/** Every vertex of one static person (metres, feet at y = 0), optionally only one part. */
function personVerts(look: ReturnType<typeof personLook>, pose: Pose, part?: keyof PersonSink, extra: Record<string, unknown> = {}): Float32Array {
    const a = new Accum3D(), none = new Accum3D();
    const pick = (k: keyof PersonSink): Accum3D => !part || part === k ? a : none;
    const sink: PersonSink = { top: () => pick('top'), skin: () => pick('skin'), hair: () => pick('hair'), leg: () => pick('leg'), shoes: () => pick('shoes'), skirt: () => pick('skirt'),
        bag: () => pick('bag'), umbrella: () => pick('umbrella'), collar: () => pick('collar'), extra: () => pick('extra') };
    emitPerson(sink, { o: [0, 0, 0], f: [1, 0], u: 1 }, look, { lod: 1, pose, ...extra });
    return a.geometry().vertices;
}
const minY = (v: Float32Array): number => { let m = Infinity; for (let i = 1; i < v.length; i += 12) m = Math.min(m, v[i]); return m; };

describe('crowd mannequin — Persona NPC proportions', () => {
    it('adult proportions: a small head (~1/7.5 of height), long legs (hip ≥ 52 %), narrow shoulders', () => {
        for (const l of looks) {
            expect(1 / headFraction(l)).toBeGreaterThan(7.0);
            expect(1 / headFraction(l)).toBeLessThan(8.3);
            expect(legPivot(l, 1)[1] / l.heightM).toBeGreaterThan(0.52);
            expect(Math.abs(armPivot(l, 1)[2])).toBeLessThan(0.19);   // shoulder joint half-width (m)
        }
    });

    it('is deterministic per (archetype, seed) and covers the wardrobe (suits, skirts, coats, yukata, hats)', () => {
        expect(JSON.stringify(personLook(3, 17))).toBe(JSON.stringify(personLook(3, 17)));
        expect(looks.some(l => l.garment === 'robe')).toBe(true);
        expect(looks.some(l => l.garment === 'coat')).toBe(true);
        expect(looks.some(l => l.skirt)).toBe(true);
        expect(looks.some(l => l.hat !== 'none')).toBe(true);
        expect(looks.some(l => l.phone)).toBe(true);
        for (const l of looks) for (const c of [l.top, l.legs, l.shoes, l.hair, l.bagColor, l.hatColor, l.skirt, l.collar]) if (c) expect(PED_PALETTE[c]).toBeDefined();
    });

    it('budgets: HIGH static ≈ 2.5k (≤ 3.4k worst pose), the FAR twin ≈ 0.85k (≤ 1.1k), walkers ≤ 3.4k (≤ 3.5k with an umbrella)', () => {
        let sum = 0, sumHi = 0;
        for (let i = 0; i < looks.length; i++) {
            sum += staticTris(i); sumHi += staticTris(i, 'stand', 0);
            for (const pose of ['phone', 'clasp', 'stride', 'sit', 'rest', 'talk', 'lean', 'rail'] as const) {
                expect(staticTris(i, pose)).toBeLessThan(1100);
                expect(staticTris(i, pose, 0)).toBeLessThan(3400);
            }
            expect(walkerTris(i)).toBeLessThan(3400);
            expect(walkerTris(i, 'vinyl')).toBeLessThan(3500);
        }
        expect(sumHi / looks.length).toBeLessThan(2800);
        expect(sumHi / looks.length).toBeGreaterThan(1800);   // HIGH: smooth heads + ears, fingers, lapels, hems, hair volume
        expect(sum / looks.length).toBeLessThan(950);
        expect(sum / looks.length).toBeGreaterThan(500);   // FAR twin: still a real body — heads, shoulders, calves, hands, shoes
    });

    it('feet stay on the ground in every standing pose (bent knees, strides and wall-leans sink the body to the lower foot)', () => {
        for (const l of looks.slice(0, 40)) for (const pose of ['stand', 'phone', 'clasp', 'stride', 'rest', 'talk', 'lean', 'rail'] as const) {
            const y = minY(personVerts(l, pose, undefined, pose === 'rail' ? { rail: { y: 0.675, d: 0.21 } } : {}));
            expect(y).toBeGreaterThan(-0.03);
            expect(y).toBeLessThan(0.02);
        }
    });

    it('wardrobe detail: short sleeves bare the forearm, sneakers / pumps / geta, pleated + pencil skirts, ponytails, open jackets', () => {
        expect(looks.some(l => l.sleeve === 'short')).toBe(true);
        expect(looks.some(l => l.sleeve === 'wide' && l.garment === 'robe')).toBe(true);
        for (const s of ['sneaker', 'pump', 'loafer', 'dress', 'geta'] as const) expect(looks.some(l => l.shoe === s)).toBe(true);
        for (const c of ['pleat', 'pencil'] as const) expect(looks.some(l => l.skirt && l.skirtCut === c)).toBe(true);
        expect(looks.some(l => l.hairStyle === 'pony')).toBe(true);
        expect(looks.some(l => l.open && l.garment === 'jacket')).toBe(true);
        // more skin on a short-sleeved blouse than the same look with long sleeves
        const b = looks.find(l => l.sleeve === 'short')!;
        expect(personVerts(b, 'stand', 'skin').length).toBeGreaterThan(personVerts({ ...b, sleeve: 'long' }, 'stand', 'skin').length);
    });

    it('a CLOSED umbrella hangs furled at the side (tip near the ground, nothing over the head)', () => {
        const l = looks.find(x => x.bag === 'none' && !x.phone)!;
        const v = personVerts(l, 'stand', 'umbrella', { umbrella: 'vinyl', umbrellaClosed: true });
        expect(v.length).toBeGreaterThan(0);
        let maxY = -Infinity; for (let i = 1; i < v.length; i += 12) maxY = Math.max(maxY, v[i]);
        expect(minY(v)).toBeLessThan(0.1);
        expect(maxY).toBeLessThan(l.heightM * 0.6);
        const open = personVerts(l, 'stand', 'umbrella', { umbrella: 'vinyl' });
        let top = -Infinity; for (let i = 1; i < open.length; i += 12) top = Math.max(top, open[i]);
        expect(top).toBeGreaterThan(l.heightM);   // open: the canopy over the head
    });

    it('faceless: the head is plain skin; the hair shell leaves the face open (no hair in front of the face centre)', () => {
        const hair = new Accum3D(), none = new Accum3D();
        const look = { ...personLook(0, 1), hairStyle: 'long' as const, hat: 'none' as const };
        emitPerson({ top: () => none, skin: () => none, hair: () => hair, leg: () => none, shoes: () => none, skirt: () => null, bag: () => none, umbrella: () => null, collar: () => null },
            { o: [0, 0, 0], f: [1, 0], u: 1 }, look, { lod: 0 });
        const v = hair.geometry().vertices, k = look.heightM / 1.7;
        for (let i = 0; i < v.length; i += 12) {
            // Face zone: forward of the skull centre, below the fringe, above the chin, near the midline.
            const fwd = v[i], y = v[i + 1], z = v[i + 2];
            const inFace = fwd > 0.06 && y < 1.585 * k + 0.01 && y > 1.585 * k - 0.09 && Math.abs(z) < 0.035;
            expect(inFace).toBe(false);
        }
    });
});

describe('walkers — rigid body + swinging legs + FREE arms', () => {
    it('builds both arms for a free-handed look, keeps a held arm (umbrella / phone / briefcase / handlebar) rigid', () => {
        const free = looks.find(l => !l.phone && l.bag !== 'briefcase' && l.bag !== 'tote')!;
        const p = walkerParts(free, U, null);
        expect(p.arm.accL && !p.arm.accL.empty).toBe(true);
        expect(p.arm.accR && !p.arm.accR.empty).toBe(true);
        expect(walkerParts(free, U, 'vinyl').arm.accR).toBeNull();   // the umbrella hand
        const bike = walkerParts(free, U, null, true);
        expect(bike.arm.accL).toBeNull(); expect(bike.arm.accR).toBeNull();
        const phone = looks.find(l => l.phone)!;
        expect(armHold(phone, 'stand', 1, null)).toBe('phone');
        expect(walkerParts(phone, U, null).arm.accR).toBeNull();
    });

    it('walkers get separate shins (knee pivot) + skin hands; shoes split off when they differ from the legs', () => {
        const free = looks.find(l => !l.phone && l.bag !== 'briefcase' && l.bag !== 'tote' && l.garment !== 'robe')!;
        const p = walkerParts(free, U, null);
        expect(p.shin && !p.shin.accL.empty && !p.shin.accR.empty).toBe(true);
        expect(p.hand.accL && !p.hand.accL.empty).toBe(true);
        expect(p.knee!.y).toBeLessThan(0);
        expect(p.knee!.y).toBeCloseTo(kneePivot(free, 1)[1] - legPivot(free, 1)[1], 6);
        const sneak = looks.find(l => l.shoes === 'shirt' && l.legs !== 'shirt' && l.garment !== 'robe')!;
        expect(walkerParts(sneak, U, null).shoe).not.toBeNull();
        const robe = looks.find(l => l.garment === 'robe')!;
        expect(walkerParts(robe, U, null).shin).toBeNull();
    });

    it('the knee curve: straight at heel strike, folded through the swing, a little give on loading', () => {
        expect(kneeFlexCurve(Math.PI / 2)).toBeLessThan(0.05);           // heel strike (leg forward-most)
        expect(kneeFlexCurve(-0.6)).toBeGreaterThan(0.85);               // mid swing
        const load = kneeFlexCurve(Math.PI * 0.75);
        expect(load).toBeGreaterThan(0.1); expect(load).toBeLessThan(0.3);
        expect(kneeFlexCurve(Math.PI + 0.3)).toBeLessThan(0.05);         // late stance: straight
    });

    it('the walking bob comes from the legs: level at rest, the body dips (2–6 cm) at double support', () => {
        const l = looks.find(x => !x.skirt && x.garment !== 'robe')!;
        const kn = walkerParts(l, 1, null).knee!;
        expect(walkerSink(kn, 0, 0, 0, 0)).toBeCloseTo(0, 6);
        const A = 0.4, flex = 1.0;
        const dip = walkerSink(kn, A, flex * kneeFlexCurve(Math.PI / 2), -A, flex * kneeFlexCurve(-Math.PI / 2));
        expect(dip).toBeLessThan(-0.02); expect(dip).toBeGreaterThan(-0.07);
        const mid = walkerSink(kn, 0, flex * kneeFlexCurve(0), 0, flex * kneeFlexCurve(Math.PI));
        expect(mid).toBeGreaterThan(dip);                                  // highest mid-stance
    });

    it('shorter steps in a skirt / yukata', () => {
        const robe = looks.find(l => l.garment === 'robe')!, suit = looks.find(l => !l.skirt && l.garment === 'jacket')!;
        expect(walkerParts(robe, U, null).amp).toBeLessThan(walkerParts(suit, U, null).amp);
    });
});

describe('flat crowd shading (PED_SHADE)', () => {
    it('crowd layers carry a dimmed diffuse + an emissive lift and no garment pattern', () => {
        const L = crowdLayer('world:ped-navy', 'navy');
        expect(L.color[0]).toBeCloseTo(PED_PALETTE.navy[0] * PED_SHADE.diffuse, 6);
        expect(L.emissive).toBe(PED_SHADE.emissive);
        expect((L as { pattern?: unknown }).pattern).toBeUndefined();
        // Lit vs shadowed contrast (light 1.3 vs 0.3 ambient): flatter than an un-lifted surface.
        const lifted = (1.3 + PED_SHADE.emissive) / (0.3 + PED_SHADE.emissive), plain = (1.3 + 0.05) / (0.3 + 0.05);
        expect(lifted).toBeLessThan(plain * 0.6);
    });

    it('static poses: waiting people look at phones / clasp hands / rest on one leg, strollers pause (never a frozen mid-stride), groups talk, benches sit', () => {
        expect(staticPose('seat', 'sit', 0.5)).toBe('sit');
        expect(staticPose('wait', 'stand', 0.1)).toBe('phone');
        expect(staticPose('crowd', 'stand', 0.4)).toBe('clasp');
        expect(staticPose('crowd', 'stand', 0.6)).toBe('rest');
        for (let r = 0; r < 1; r += 0.01) expect(staticPose('stroll', 'stand', r)).not.toBe('stride');
        expect(staticPose('group', 'stand', 0.2)).toBe('talk');
        expect(staticPose('lean', 'stand', 0.9)).toBe('lean');
        expect(staticPose('rail', 'stand', 0.9)).toBe('rail');
        const pants = looks.find(l => !l.skirt && l.garment !== 'robe' && l.bag === 'none' && !l.phone)!;
        expect(armHold(pants, 'rest', -1, null)).toBe('pocket');
        expect(armHold(pants, 'talk', 1, null)).toBe('talk');
        expect(armHold(pants, 'stand', 1, 'vinyl', true)).toBe('cane');
    });
});
