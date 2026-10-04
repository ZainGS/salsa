/**
 * Round 8 locomotion clips on the REAL procedural body: limb self-intersection over every frame (the engine's own
 * arm-clearance measure — an arm or leg inside the torso / head / other limb), sampled exactly as the Play animator
 * does (against the rest pose). With LOCO_SHEETS=<dir> it also writes a contact sheet per clip (side + 3/4 views) and a
 * report — the pose-preview harness for the gait:
 *   LOCO_SHEETS=out npx vitest run src/services/managers/default-locomotion-pose.test.ts
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { bodyFor, CONFIGS, skinAll } from './clothing-audit-harness';
import { buildLocomotionClips } from './default-locomotion';
import { measureSelfIntersection, renderFramesPNG } from './pose-preview';
import { sampleClipPose } from '../../renderer/3d/skeleton-animator';
import type { PoseRotations } from './skin-deform-metrics';

const g = globalThis as { crypto?: unknown };
g.crypto ??= webcrypto;

describe('locomotion clips on the procedural body (Round 8)', () => {
    const { r, m } = bodyFor(CONFIGS[0]);
    const joints = m.jointNames.map((name, i) => ({ name, localPosition: [m.jointLocalPositions[i * 3], m.jointLocalPositions[i * 3 + 1], m.jointLocalPositions[i * 3 + 2]] as [number, number, number] }));
    const clips = buildLocomotionClips(joints);
    const rest = {
        rotations: m.jointNames.map(() => [0, 0, 0, 1] as [number, number, number, number]),
        positions: joints.map((j) => [...j.localPosition] as [number, number, number]),
        scales: m.jointNames.map(() => [1, 1, 1] as [number, number, number]),
    };
    const poseAt = (clipIdx: number, frame: number): PoseRotations => {
        const s = sampleClipPose(clips[clipIdx], rest, frame);
        return m.jointNames.map((joint, j) => ({ joint, q: s.rotations[j] }));
    };
    const restP = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, [], 'dualQuat');

    it('no limb goes through the body in any frame of any gait / air / crouch clip', () => {
        const rows: string[] = [];
        const fails: string[] = [];
        clips.forEach((c, ci) => {
            let worst = 0, worstF = -1, worstHits = '';
            for (let f = c.startFrame; f <= c.endFrame; f++) {
                const posed = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, poseAt(ci, f), 'dualQuat');
                const inter = measureSelfIntersection(m, restP.P, posed.P, posed.N);
                if (inter.maxMm > worst) { worst = inter.maxMm; worstF = f; worstHits = JSON.stringify(inter.hits); }
            }
            rows.push(`${c.name.padEnd(8)} worst ${worst.toFixed(1)} mm @ f${worstF} ${worstHits}`);
            // Tolerance: a few mm of skin-on-skin contact (inner thighs brushing in the crouch) is contact, not a clip.
            if (worst > 6) fails.push(`${c.name}: ${worst.toFixed(1)} mm @ f${worstF} ${worstHits}`);
        });
        if (process.env.LOCO_SHEETS) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = require('node:fs') as typeof import('node:fs'), path = require('node:path') as typeof import('node:path');
            const dir = process.env.LOCO_SHEETS; fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'loco-report.txt'), rows.join('\n'));
            clips.forEach((c, ci) => {
                const step = Math.max(1, Math.round((c.endFrame - c.startFrame) / 16));
                const frames: Float32Array[] = [];
                for (let f = c.startFrame; f <= c.endFrame; f += step) {
                    // The sheet includes the hips translation (the bob / crouch / squash), which the clip test ignores.
                    const s = sampleClipPose(c, rest, f), lp = Float32Array.from(m.jointLocalPositions);
                    s.positions.forEach((p, j) => lp.set(p, j * 3));
                    frames.push(skinAll({ ...m, jointLocalPositions: lp }, r.geometry.vertices, m.jointIndices, m.jointWeights, poseAt(ci, f), 'dualQuat').P);
                }
                for (const v of [{ label: 'side', yaw: 90, pitch: 4, cy: 0.75, h: 1.95 }, { label: '3q', yaw: 35, pitch: 8, cy: 0.75, h: 1.95 }]) {
                    fs.writeFileSync(path.join(dir, `loco_${c.name}_${v.label}.png`), renderFramesPNG(frames, m.indices, v, 160, 9));
                }
            });
        }
        expect(fails, rows.join('\n')).toEqual([]);
    }, 120_000);
});
