/**
 * Character v2 CONTACT SHEETS for review (runs only with CHARV2_PREVIEW=<dir>):
 *   CHARV2_PREVIEW=out npx vitest run src/character-v2/character-v2-preview.test.ts
 * Everything is rendered from the v2 pipeline (frozen asset + blend weights + bone offsets), not the generator:
 *   • v2_<base>_stance.png — Relaxed stance: front (yaw 0 = the FRONT) / left side / 3/4 / upper front / upper 3/4 / back;
 *   • v2_<base>_walk.png / _run.png — one gait cycle, 16 frames, 3/4 view;
 *   • v2_fem_sliders.png — slider extremes (front), base in the middle of each pair;
 *   • v1_default_stance.png — the v1 new-body default, for comparison.
 */
import { describe, it } from 'vitest';
import { BODY_POSES, generateBodyResult, NEW_BODY_DEFAULTS } from '../services/managers/body-generator';
import { skinAll } from '../services/managers/clothing-audit-harness';
import { renderPosePNG, renderFramesPNG, type View } from '../services/managers/pose-preview';
import type { SkinnedMeshData, PoseRotations } from '../services/managers/skin-deform-metrics';
import { buildLocomotionClips } from '../services/managers/default-locomotion';
import { sampleClipPose } from '../renderer/3d/skeleton-animator';
import { relaxedStance } from '../services/managers/pose-authoring';
import { getBodyV2Asset, bodyV2Weights, bodyV2Vertices, bodyV2JointLocal, bodyV2InverseBinds, type BodyV2Asset, type BodyV2Sliders } from './body-v2-asset';

function v2Mesh(a: BodyV2Asset, sliders: BodyV2Sliders): { m: SkinnedMeshData; V: Float32Array } {
  const w = bodyV2Weights(a, sliders), V = bodyV2Vertices(a, w), J = bodyV2JointLocal(a, w);
  return {
    V, m: {
      vertices: V, stride: 12, posOffset: 0, indices: a.indices, jointIndices: a.jointIndices, jointWeights: a.jointWeights,
      jointNames: a.jointNames, jointParents: a.jointParents, jointLocalPositions: J, inverseBindMatrices: bodyV2InverseBinds(a.jointParents, J).inverseBind,
    },
  };
}
const bounds = (P: Float32Array) => { let lo = Infinity, hi = -Infinity; for (let i = 1; i < P.length; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); } return { lo, hi }; };
function stanceViews(P: Float32Array): View[] {
  const { lo, hi } = bounds(P), cy = (lo + hi) / 2, h = (hi - lo) * 1.08, uy = hi - (hi - lo) * 0.25, uh = (hi - lo) * 0.5;
  return [{ label: 'front', yaw: 0, cy, h }, { label: 'left side', yaw: 90, cy, h }, { label: '3/4', yaw: 35, pitch: 8, cy, h },
    { label: 'upper front', yaw: 0, cy: uy, h: uh }, { label: 'upper 3/4', yaw: -35, pitch: 8, cy: uy, h: uh }, { label: 'back', yaw: 180, cy, h }];
}

describe.skipIf(!process.env.CHARV2_PREVIEW)('character v2 contact sheets', () => {
  it('renders', async () => {
    const fs = await import('node:fs'), path = await import('node:path');
    const dir = process.env.CHARV2_PREVIEW!; fs.mkdirSync(dir, { recursive: true });
    const relaxed = BODY_POSES['Relaxed'] as PoseRotations;
    for (const base of ['fem', 'masc'] as const) {
      const a = getBodyV2Asset(base);
      const { m, V } = v2Mesh(a, {});
      const P = skinAll(m, V, m.jointIndices, m.jointWeights, relaxed, 'dualQuat').P;
      fs.writeFileSync(path.join(dir, `v2_${base}_stance.png`), renderPosePNG(P, m.indices, new Set(), stanceViews(P), 480));
      // Gait: the default clips built on THIS skeleton (as Play does), over the Relaxed stance.
      const joints = a.jointNames.map((name, j) => ({ name, localPosition: [m.jointLocalPositions[j * 3], m.jointLocalPositions[j * 3 + 1], m.jointLocalPositions[j * 3 + 2]] }));
      const rel = new Map(Object.entries(relaxedStance()));
      const bind = {
        rotations: a.jointNames.map((n) => [...(rel.get(n) ?? [0, 0, 0, 1])] as [number, number, number, number]),
        positions: joints.map((j) => j.localPosition as [number, number, number]),
        scales: a.jointNames.map(() => [1, 1, 1] as [number, number, number]),
      };
      const { lo, hi } = bounds(P);
      for (const name of ['Walk', 'Run']) {
        const clip = buildLocomotionClips(joints).find((c) => c.name === name)!;
        const frames: Float32Array[] = [];
        for (let i = 0; i < 16; i++) {
          const s = sampleClipPose(clip, bind, (clip.endFrame * i) / 16);
          const pose: PoseRotations = a.jointNames.map((joint, j) => ({ joint, q: s.rotations[j] }));
          frames.push(skinAll(m, V, m.jointIndices, m.jointWeights, pose, 'dualQuat').P);
        }
        fs.writeFileSync(path.join(dir, `v2_${base}_${name.toLowerCase()}.png`),
          renderFramesPNG(frames, m.indices, { label: '3/4', yaw: 35, pitch: 8, cy: (lo + hi) / 2, h: (hi - lo) * 1.1 }, 220, 8));
      }
    }
    // Slider extremes (fem), front view: −1 | base | +1 per slider.
    const a = getBodyV2Asset('fem');
    const names = ['bust', 'waist', 'hipWidth', 'shoulderWidth', 'torsoThick', 'limbThick', 'legLength', 'torsoLength', 'headSize'] as const;
    const frames: Float32Array[] = [];
    for (const n of names) for (const x of [-1, 0, 1]) {
      const { m, V } = v2Mesh(a, { [n]: x });
      frames.push(skinAll(m, V, m.jointIndices, m.jointWeights, relaxed, 'dualQuat').P);
    }
    const P0 = frames[1], { lo, hi } = bounds(P0);
    fs.writeFileSync(path.join(dir, 'v2_fem_sliders.png'), renderFramesPNG(frames, a.indices, { label: 'front', yaw: 0, cy: (lo + hi) / 2 - 0.05, h: (hi - lo) * 1.25 }, 170, 9));
    fs.writeFileSync(path.join(dir, 'v2_fem_sliders.txt'), `rows of 9 tiles = 3 sliders × (−1, base, +1): ${names.join(', ')}\n`);
    // v1 comparison
    const r = generateBodyResult({ ...NEW_BODY_DEFAULTS });
    const m1: SkinnedMeshData = { vertices: r.geometry.vertices, stride: 12, posOffset: 0, indices: r.geometry.indices, jointIndices: r.skinning.jointIndices, jointWeights: r.skinning.jointWeights, jointNames: r.skinning.jointNames, jointParents: r.skinning.jointParents!, jointLocalPositions: r.skinning.jointLocalPositions!, inverseBindMatrices: r.skinning.inverseBindMatrices };
    const P1 = skinAll(m1, r.geometry.vertices, m1.jointIndices, m1.jointWeights, relaxed, 'dualQuat').P;
    fs.writeFileSync(path.join(dir, 'v1_default_stance.png'), renderPosePNG(P1, m1.indices, new Set(), stanceViews(P1), 480));
  });
});
