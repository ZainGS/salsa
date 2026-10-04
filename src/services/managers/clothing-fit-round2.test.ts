/**
 * Clothing fit round 2 (2026-10-04) — the gates for docs/specs/clothing-generation.md §16:
 *   1. BODY-HIDING MASK (body-hide-mask.ts): it hides skin under every outfit, and opens no see-through hole (the view
 *      seeing background / other skin where hidden skin was) over the 26 ROM poses + every Walk / Run / Jump / Land frame;
 *   2. KNEE: no knee skin shows through trousers in a deep run bend (knee 90–115°) and the Run cycle — with the mask;
 *   3. LAYER ORDER (garment-layers.ts): a long top's hem sits OUTSIDE the skirt / trouser waistband after layering;
 *   4. HEM SWING (skirt-swing.ts): bounded whatever the input, outward only, settles;
 *   5. LINING: every garment preset is wound outward (the GPU front face = the outside), so Material3D.clothLining
 *      darkens only the inside.
 */
import { describe, it, expect } from 'vitest';
import { bodyFor, CONFIGS, skinAll, q, ROM_POSES, ALL_GARMENTS } from './clothing-audit-harness';
import { generateTop, generateBottom, clothingPreset, type BottomParams, type TopParams } from './clothing-generator';
import { buildLocomotionClips } from './default-locomotion';
import { computePoseVerifiedHideMask, countHidden, maskedIndices, TriRayGrid } from './body-hide-mask';
import { measureMaskHoles, measureVisibility, coveredBodyTris } from './clothing-visibility';
import { layerOver, LAYER_GAP } from './garment-layers';
import { HemSwing, buildHemSwing, applyHemSwing, MAX_LAG, MAX_FLARE } from './skirt-swing';
import type { PoseRotations } from './skin-deform-metrics';

const cfg = CONFIGS[0];
const B = bodyFor(cfg);
const { r, m, fit } = B;
const rig = { names: m.jointNames, parents: m.jointParents, inverseBind: m.inverseBindMatrices, method: 'dualQuat' as const };
const bodyMask = { verts: r.geometry.vertices, indices: r.geometry.indices, ji: m.jointIndices, jw: m.jointWeights };
type G = ReturnType<typeof generateTop>;
const maskG = (g: G) => ({ verts: g.geometry.vertices, indices: g.geometry.indices, ji: g.jointIndices, jw: g.jointWeights });

function clipPoses(names: string[], every = 2): Record<string, PoseRotations> {
    const joints = m.jointNames.map((name, i) => ({ name, localPosition: [m.jointLocalPositions[i * 3], m.jointLocalPositions[i * 3 + 1], m.jointLocalPositions[i * 3 + 2]] as [number, number, number] }));
    const out: Record<string, PoseRotations> = {};
    for (const clip of buildLocomotionClips(joints, {})) {
        if (!names.includes(clip.name)) continue;
        for (let f = clip.startFrame; f < clip.endFrame; f += every) {
            const pose: PoseRotations = [];
            for (const t of clip.tracks) {
                if (t.channel !== 'rotation') continue;
                const k = t.keyframes.find((kf) => kf.frame === f);
                if (k) pose.push({ joint: m.jointNames[t.jointIndex], q: k.value as number[] });
            }
            out[`${clip.name} f${f}`] = pose;
        }
    }
    return out;
}
const DEEP_RUN: Record<string, PoseRotations> = {
    'deep run 90': [{ joint: 'upperleg_L', q: q('x', -70) }, { joint: 'lowerleg_L', q: q('x', 90) }, { joint: 'upperleg_R', q: q('x', 35) }, { joint: 'lowerleg_R', q: q('x', 100) }],
    'deep run 110': [{ joint: 'upperleg_L', q: q('x', -50) }, { joint: 'lowerleg_L', q: q('x', 115) }, { joint: 'upperleg_R', q: q('x', 30) }, { joint: 'lowerleg_R', q: q('x', 80) }],
};

const skirt = clothingPreset('bottom', 'Skirt') as BottomParams;
const OUTFITS: Record<string, G[]> = {
    trousers: [generateTop(fit, clothingPreset('top', 'Tee') as TopParams), generateBottom(fit, clothingPreset('bottom', 'Pants') as BottomParams)],
    'long dress': [generateTop(fit, clothingPreset('top', 'Tee') as TopParams), generateBottom(fit, { ...skirt, length: 1.7, flare: 1.7 })],
    mini: [generateTop(fit, clothingPreset('top', 'Crop') as TopParams), generateBottom(fit, clothingPreset('bottom', 'Mini Skirt') as BottomParams)],
    'jacket + shorts': [generateTop(fit, clothingPreset('top', 'Long Sleeve') as TopParams), generateBottom(fit, clothingPreset('bottom', 'Shorts') as BottomParams)],
    'tank + wide leg': [generateTop(fit, clothingPreset('top', 'Tank') as TopParams), generateBottom(fit, clothingPreset('bottom', 'Wide Leg') as BottomParams)],
};
const masks = Object.fromEntries(Object.entries(OUTFITS).map(([k, gs]) => [k, computePoseVerifiedHideMask(bodyMask, r.geometry.indices, gs.map(maskG), rig)]));

function posed(gs: G[], pose: PoseRotations) {
    const pb = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, pose, cfg.method);
    return { pb, pgs: gs.map((g) => ({ P: skinAll(m, g.geometry.vertices, g.jointIndices, g.jointWeights, pose, cfg.method).P, indices: g.geometry.indices })) };
}

describe('clothing fit round 2', () => {
    it('the body-hiding mask hides skin under every outfit and opens no see-through hole (ROM + locomotion)', () => {
        const poses = { ...ROM_POSES, ...clipPoses(['Walk', 'Run', 'Jump', 'Land'], 3), ...DEEP_RUN };
        const fails: string[] = [];
        // Hidden triangles measured 2026-10-04 (cone 60°): trousers 446, long dress 255, mini 54, jacket + shorts 299,
        // tank + wide leg 1481 — the floor catches a mask that silently stopped hiding.
        const minHidden: Record<string, number> = { trousers: 300, 'long dress': 150, mini: 20, 'jacket + shorts': 150, 'tank + wide leg': 800 };
        for (const [name, gs] of Object.entries(OUTFITS)) {
            const hide = masks[name];
            if (countHidden(hide) < minHidden[name]) fails.push(`${name}: only ${countHidden(hide)} tris hidden`);
            for (const [pn, pose] of Object.entries(poses)) {
                const { pb, pgs } = posed(gs, pose);
                const h = measureMaskHoles({ P: pb.P, indices: r.geometry.indices }, hide, pgs);
                if (h.holePx > 12) fails.push(`${name} @ ${pn}: ${h.holePx} px see-through`);
            }
        }
        expect(fails).toEqual([]);
    }, 300_000);

    it('trousers: no knee skin through the fabric on a deep run bend or the Run cycle (with the mask)', () => {
        const gs = OUTFITS.trousers, V = r.geometry.vertices, I = r.geometry.indices, kY = fit.joints['lowerleg_L']!.pos[1];
        const cov = coveredBodyTris(V, I, gs.map(maskG), 0.05);
        const knee = new Uint8Array(I.length / 3);
        for (let t = 0; t < knee.length; t++) for (let k = 0; k < 3; k++) if (Math.abs(V[I[t * 3 + k] * 12 + 1] - kY) < 0.06) knee[t] = cov[t];
        const drawn = maskedIndices(I, masks.trousers);
        const fails: string[] = [];
        let before = 0, after = 0;
        for (const [pn, pose] of Object.entries({ ...DEEP_RUN, ...clipPoses(['Run'], 2) })) {
            const { pb, pgs } = posed(gs, pose);
            const a = measureVisibility({ P: pb.P, indices: I }, knee, pgs).exposedPx, b = measureVisibility({ P: pb.P, indices: drawn }, knee, pgs).exposedPx;
            before += a; after += b;
            if (b > 60) fails.push(`${pn}: ${b} px knee skin (unmasked ${a})`);
        }
        expect(fails).toEqual([]);
        expect(after).toBeLessThanOrEqual(before * 0.25 + 10);
    }, 120_000);

    it('layer order: a long top hem ends up outside the skirt / trouser waistband', () => {
        const top = generateTop(fit, { ...(clothingPreset('top', 'Long Sleeve') as TopParams), hemHeight: -0.15 });
        for (const bottom of [generateBottom(fit, skirt), generateBottom(fit, clothingPreset('bottom', 'Pants') as BottomParams)]) {
            const grid = new TriRayGrid([{ verts: bottom.geometry.vertices, indices: bottom.geometry.indices }]);
            // Top verts that are INSIDE the bottom: a ray from the vertex straight out (its normal) meets the bottom.
            const inside = (V: Float32Array) => {
                let n = 0;
                for (let i = 0; i < V.length / 12; i++) {
                    const o = i * 12, nl = Math.hypot(V[o + 3], V[o + 4], V[o + 5]) || 1;
                    if (grid.raycast(V[o], V[o + 1], V[o + 2], V[o + 3] / nl, V[o + 4] / nl, V[o + 5] / nl, 0.03) < Infinity) n++;
                }
                return n;
            };
            const raw = inside(top.geometry.vertices);
            const { garment, moved } = layerOver(top, [bottom]);
            expect(raw, 'the test needs an overlap to start from').toBeGreaterThan(0);
            expect(moved).toBeGreaterThan(0);
            expect(inside(garment.geometry.vertices), `raw ${raw}, moved ${moved}`).toBe(0);
            // Weights stay normalized.
            for (let i = 0; i < garment.jointWeights.length; i += 4) {
                const s = garment.jointWeights[i] + garment.jointWeights[i + 1] + garment.jointWeights[i + 2] + garment.jointWeights[i + 3];
                expect(Math.abs(s - 1)).toBeLessThan(1e-4);
            }
            expect(LAYER_GAP).toBeGreaterThan(0);
        }
    });

    it('hem swing: bounded for any input, outward only, settles at rest', () => {
        const g = generateBottom(fit, { ...skirt, length: 1.7, flare: 1.7 }), V = g.geometry.vertices;
        let top = -Infinity, bot = Infinity; for (let i = 1; i < V.length; i += 12) { top = Math.max(top, V[i]); bot = Math.min(bot, V[i]); }
        const hips = fit.joints['hips']!;
        const d = buildHemSwing(V, [hips.pos[0], top, hips.pos[2]], bot, hips.idx)!;
        expect(d).toBeTruthy();
        const sw = new HemSwing(1.9, 0.32, 1.5);
        const out = new Float32Array(V);
        let worst = 0, px = 0;
        // A sprint, a jump, a teleport, a spin, garbage — 4 s at 60 fps.
        for (let f = 0; f < 240; f++) {
            const t = f / 60;
            px += f < 80 ? 0.12 : f < 120 ? -0.3 : 0;
            const py = f > 140 && f < 160 ? Math.sin(t * 20) : 0;
            const yaw = f > 160 && f < 200 ? t * 12 : 0;
            sw.update(f === 100 ? 1e6 : px, py, 0, Math.cos(yaw), -Math.sin(yaw), Math.sin(yaw), Math.cos(yaw), f === 120 ? NaN : 1 / 60);
            expect(Math.hypot(sw.lx, sw.lz)).toBeLessThanOrEqual(MAX_LAG * 1.2 + 1e-6);
            expect(sw.flare).toBeLessThanOrEqual(MAX_FLARE * 1.2 + 1e-6);
            worst = Math.max(worst, applyHemSwing(d, sw.lx, sw.lz, sw.flare, out));
            for (let e = 0; e < d.vert.length; e += 7) {   // outward (or zero) only, in the horizontal plane
                const v = d.vert[e] * 12;
                expect((out[v] - d.rest[v]) * d.dir[e * 2] + (out[v + 2] - d.rest[v + 2]) * d.dir[e * 2 + 1]).toBeGreaterThanOrEqual(-1e-6);
            }
        }
        expect(worst).toBeLessThanOrEqual(d.amp * (MAX_LAG * 1.2 + MAX_FLARE * 1.2) + 1e-6);
        expect(worst).toBeGreaterThan(0.01);   // it actually swings
        for (let f = 0; f < 600; f++) sw.update(px, 0, 0, 1, 0, 0, 1, 1 / 60);   // standing still → settles
        expect(sw.settled).toBe(true);
    });

    it('lining: every garment preset is wound outward (CCW from outside)', () => {
        const fails: string[] = [];
        for (const [name, build] of ALL_GARMENTS) {
            const g = build(fit), V = g.geometry.vertices, I = g.geometry.indices;
            let bad = 0;
            for (let t = 0; t < I.length; t += 3) {
                const a = I[t] * 12, b = I[t + 1] * 12, c = I[t + 2] * 12;
                const e1 = [V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]], e2 = [V[c] - V[a], V[c + 1] - V[a + 1], V[c + 2] - V[a + 2]];
                const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                const s = n[0] * (V[a + 3] + V[b + 3] + V[c + 3]) + n[1] * (V[a + 4] + V[b + 4] + V[c + 4]) + n[2] * (V[a + 5] + V[b + 5] + V[c + 5]);
                if (s < 0) bad++;
            }
            if (bad) fails.push(`${name}: ${bad} faces wound inward`);
        }
        expect(fails).toEqual([]);
    });
});
