/**
 * TROUSER LEG WEB gate (user report 2026-10-04, Play): a sheet of triangles spanned the two ankle cuffs whenever the
 * legs split in a stride. Root cause: the fit-round-2 LAYERING (garment-layers.ts layerOver, trousers over socks /
 * underpants). An inner-hem vertex's normal points at the OTHER leg; its ray hit the other leg's sock, so it read as
 * "inside" that sock, was pushed through it and took its foot / shin weights. The fix is a limb SIDE MASK: a left-limb
 * vertex never layers over (or takes weights from) a right-limb inner surface, and vice versa.
 *
 * Gate, for every trouser / shorts preset x every shoe (and none) x sock presets (and none), with underpants, on the
 * NEW and CLASSIC bodies, layered exactly as Scene3DCharacter / character-parts do it:
 *   1. below the crotch (mid-thigh down), no vertex of one leg carries any weight from the other leg's joints;
 *   2. over walk / run / stride / sit poses and the Walk + Run clips, no triangle wholly below the knee stretches an
 *      edge more than MAX_STRETCH x its rest length (below).
 */
import { describe, it, expect } from 'vitest';
import { bodyFor, CONFIGS, skinAll, ROM_POSES } from './clothing-audit-harness';
import {
    generateBottom, generateSock, generateUnderpants, defaultUnderpantsParams, clothingPresetNames, clothingPreset,
    type BottomParams, type ShoeParams, type SockParams,
} from './clothing-generator';
import { buildLocomotionClips } from './default-locomotion';
import { layerOutfit, limbSidesFromNames } from './garment-layers';
import type { PoseRotations, SkinnedMeshData } from './skin-deform-metrics';

// The web stretched 40-380x; the worst real fold is ~6x (Skinny, just under the knee in the Run clip's deepest bend).
const MAX_STRETCH = 10;
const POSE_NAMES = ['legs: walk', 'legs: run', 'legs: lunge', 'legs: sit', 'legs: splits side', 'legs: side 45', 'combo: run + arm swing'];

function clipPoses(m: SkinnedMeshData, names: string[], every: number): Record<string, PoseRotations> {
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

const trousers = clothingPresetNames('bottom').filter((n) => (clothingPreset('bottom', n) as BottomParams).bottomStyle !== 'skirt');
const shoes: (string | null)[] = [null, ...clothingPresetNames('shoes')];
const socks: (string | null)[] = [null, ...clothingPresetNames('socks')];

describe('trousers: no web between the legs (layering side mask)', () => {
    for (const cfg of CONFIGS) {
        it(`${cfg.label}: every trouser x shoe x sock stays on its own leg`, () => {
            const { m, fit } = bodyFor(cfg);
            const names = m.jointNames, sides = limbSidesFromNames(names);
            const sideOfJoint = (j: number) => (sides.L.has(j) ? 1 : sides.R.has(j) ? 2 : 0);
            const sockY = fit.joints['upperleg_L']!.pos[1], kneeY = fit.joints['lowerleg_L']!.pos[1];
            // 'Below the crotch' = below mid-thigh: above it the inseam fabric legitimately blends hips + both thighs.
            const crotchY = sockY - 0.5 * (sockY - kneeY);
            const poses: Record<string, PoseRotations> = { ...Object.fromEntries(POSE_NAMES.map((n) => [n, ROM_POSES[n]])), ...clipPoses(m, ['Walk', 'Run'], 3) };
            const posed = Object.entries(poses);
            const underpants = generateUnderpants(fit, defaultUnderpantsParams());
            const bad: string[] = [];
            for (const bn of trousers) for (const sn of shoes) for (const kn of socks) {
                const shoe = sn ? clothingPreset('shoes', sn) as ShoeParams : null;
                const raw = generateBottom(fit, clothingPreset('bottom', bn) as BottomParams, shoe);
                const inner = { underpants, ...(kn ? { socks: generateSock(fit, clothingPreset('socks', kn) as SockParams) } : {}) };
                const g = layerOutfit({ bottom: raw, ...inner }, () => false, sides).bottom!;
                const V = g.geometry.vertices, I = g.geometry.indices, ji = g.jointIndices, jw = g.jointWeights;
                const n = V.length / 12;
                const tag = `${bn} + ${sn ?? 'barefoot'} + ${kn ?? 'no socks'}`;
                // 1. Own-leg weights below the crotch. The leg a vertex belongs to = its UV island (legL u < 0.5).
                let crossed = 0, example = '';
                for (let i = 0; i < n; i++) {
                    if (V[i * 12 + 1] > crotchY) continue;
                    const own = V[i * 12 + 6] < 0.5 ? 1 : 2;
                    for (let k = 0; k < 4; k++) {
                        const s = sideOfJoint(ji[i * 4 + k]);
                        if (jw[i * 4 + k] > 1e-4 && s !== 0 && s !== own) {
                            crossed++;
                            if (!example) example = ` e.g. v${i} (${own === 1 ? 'left' : 'right'} leg, y ${V[i * 12 + 1].toFixed(3)}) ${names[ji[i * 4 + k]]} ${jw[i * 4 + k].toFixed(2)}`;
                            break;
                        }
                    }
                }
                if (crossed) bad.push(`${tag}: ${crossed} verts take the other leg's weight${example}`);
                // 2. No triangle below the knee stretches past MAX_STRETCH x rest.
                const rest = skinAll(m, V, ji, jw, [], cfg.method).P;
                const tris: number[] = [];
                for (let t = 0; t < I.length; t += 3) if (Math.max(V[I[t] * 12 + 1], V[I[t + 1] * 12 + 1], V[I[t + 2] * 12 + 1]) < kneeY) tris.push(t);
                let worst = 0, worstAt = '';
                for (const [pn, pose] of posed) {
                    const P = skinAll(m, V, ji, jw, pose, cfg.method).P;
                    for (const t of tris) for (let e = 0; e < 3; e++) {
                        const a = I[t + e], b = I[t + (e + 1) % 3];
                        const r0 = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
                        if (r0 < 1e-4) continue;
                        const s = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]) / r0;
                        if (s > worst) { worst = s; worstAt = pn; }
                    }
                }
                if (worst > MAX_STRETCH) bad.push(`${tag}: a below-knee edge stretches ${worst.toFixed(1)}x in ${worstAt}`);
            }
            expect(bad, bad.slice(0, 12).join('\n')).toEqual([]);
        }, 120_000);
    }
});
