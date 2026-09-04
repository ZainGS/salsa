import { describe, it, expect } from 'vitest';
import { buildCreatureBlobs, buildCreatureSkeleton, creatureEyes, CREATURE_SPECIES } from './creature-generator';

describe('buildCreatureBlobs', () => {
    it('a default quadruped has a body, 4 legs (+paws), neck, head, snout, ears, tail', () => {
        const blobs = buildCreatureBlobs({ species: 'dog' });
        // 1 body + 4 legs + 4 paws + 1 neck + 1 head + 1 snout + 2 ears + 2 tail = 16
        expect(blobs.length).toBeGreaterThanOrEqual(14);
        expect(blobs.some(b => b.shape === 'capsule')).toBe(true);   // body/legs/neck are capsules
        expect(blobs.some(b => b.shape === 'ellipsoid')).toBe(true);  // head/ears
        for (const b of blobs) expect(b.blend).toBeGreaterThanOrEqual(0);   // everything fuses
    });

    it('every blob sits at/above the ground (feet at y≈0, nothing below)', () => {
        const blobs = buildCreatureBlobs({ species: 'horse' });
        for (const b of blobs) {
            expect(b.a[1]).toBeGreaterThanOrEqual(-1e-6);
            if (b.b) expect(b.b[1]).toBeGreaterThanOrEqual(-1e-6);
        }
    });

    it('legCount:2 yields fewer leg capsules than a quadruped', () => {
        const quad = buildCreatureBlobs({ legCount: 4 }).length;
        const biped = buildCreatureBlobs({ legCount: 2 }).length;
        expect(biped).toBeLessThan(quad);
    });

    it('earSize:0 (lizard) produces no ear blobs', () => {
        const lizard = buildCreatureBlobs({ species: 'lizard' });   // preset earSize 0
        const dog = buildCreatureBlobs({ species: 'dog' });
        expect(lizard.length).toBeLessThan(dog.length);
    });

    it('species presets differ (a horse is longer/taller than a cat)', () => {
        const catBody = buildCreatureBlobs({ species: 'cat' })[0];   // body capsule first
        const horseBody = buildCreatureBlobs({ species: 'horse' })[0];
        const catLen = Math.abs(catBody.b![2] - catBody.a[2]);
        const horseLen = Math.abs(horseBody.b![2] - horseBody.a[2]);
        expect(horseLen).toBeGreaterThan(catLen);
        expect(horseBody.a[1]).toBeGreaterThan(catBody.a[1]);        // horse torso higher (longer legs)
    });

    it('exposes the species list', () => {
        expect(CREATURE_SPECIES).toContain('dog');
        expect(CREATURE_SPECIES).toContain('lizard');
    });
});

describe('buildCreatureSkeleton (auto-rig)', () => {
    it('builds a spine chain + a 2-bone chain per leg + a 2-bone tail', () => {
        const j = buildCreatureSkeleton({ species: 'dog' });   // quadruped
        // pelvis+spine+chest+neck+head (5) + 4 legs × 2 (8) + tail × 2 (2) = 15
        expect(j.length).toBe(15);
        expect(j[0]).toMatchObject({ name: 'pelvis', parent: -1 });   // single root
        expect(j.filter(b => b.parent === -1).length).toBe(1);
        expect(j.some(b => b.name === 'head')).toBe(true);
    });

    it('every joint parent references an EARLIER entry (valid build order)', () => {
        for (const j of [buildCreatureSkeleton({ species: 'horse' }), buildCreatureSkeleton({ species: 'lizard' })]) {
            j.forEach((b, i) => expect(b.parent).toBeLessThan(i));
        }
    });

    it('front-leg bones parent to the chest, back-leg bones to the pelvis', () => {
        const j = buildCreatureSkeleton({ species: 'dog' });
        const chest = j.findIndex(b => b.name === 'chest');
        const pelvis = j.findIndex(b => b.name === 'pelvis');
        const legUppers = j.filter(b => /leg\d+_upper/.test(b.name));
        expect(legUppers.length).toBe(4);
        expect(legUppers.some(b => b.parent === chest)).toBe(true);
        expect(legUppers.some(b => b.parent === pelvis)).toBe(true);
    });

    it('joint positions match the blob anatomy (feet at y≈0, shared derivation)', () => {
        const j = buildCreatureSkeleton({ species: 'dog' });
        for (const b of j) expect(b.pos[1]).toBeGreaterThanOrEqual(-1e-6);
        // the pelvis sits at torso height = legLength + bodyRadius (dog: 0.55 + 0.28)
        expect(j[0].pos[1]).toBeCloseTo(0.55 + 0.28, 5);
    });
});

describe('creature variety + features (Phase 4)', () => {
    it('seed jitters proportions deterministically (same seed → same, different seed → different)', () => {
        const a = buildCreatureBlobs({ species: 'dog', seed: 7 })[0];   // body capsule
        const b = buildCreatureBlobs({ species: 'dog', seed: 7 })[0];
        const c = buildCreatureBlobs({ species: 'dog', seed: 8 })[0];
        const len = (cap: typeof a) => Math.abs(cap.b![2] - cap.a[2]);
        expect(len(a)).toBeCloseTo(len(b), 10);      // deterministic
        expect(len(a)).not.toBeCloseTo(len(c), 4);   // varies by seed
    });

    it('seed keeps mesh + skeleton in sync (both derive from the same jittered anatomy)', () => {
        const body = buildCreatureBlobs({ species: 'dog', seed: 3 })[0];
        const pelvis = buildCreatureSkeleton({ species: 'dog', seed: 3 })[0];
        // torso capsule Y (bodyY) == pelvis joint Y
        expect(body.a[1]).toBeCloseTo(pelvis.pos[1], 6);
    });

    it('creatureEyes returns two symmetric eye positions on the head', () => {
        const eyes = creatureEyes({ species: 'dog' });
        expect(eyes.length).toBe(2);
        expect(eyes[0].pos[0]).toBeCloseTo(-eyes[1].pos[0], 6);   // mirrored on X
        expect(eyes[0].pos[1]).toBeCloseTo(eyes[1].pos[1], 6);
        expect(eyes[0].radius).toBeGreaterThan(0);
    });
});
