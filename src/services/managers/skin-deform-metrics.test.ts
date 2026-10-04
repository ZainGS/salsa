import { describe, it, expect } from 'vitest';
import { generateBodyResult, BODY_POSES } from './body-generator';
import { measureDeformation, skinPositions, type SkinnedMeshData } from './skin-deform-metrics';

function meshData(): SkinnedMeshData {
  const r = generateBodyResult();
  return {
    vertices: r.geometry.vertices, stride: 12, posOffset: 0, indices: r.geometry.indices,
    jointIndices: r.skinning.jointIndices, jointWeights: r.skinning.jointWeights, jointNames: r.skinning.jointNames,
    jointParents: r.skinning.jointParents!, jointLocalPositions: r.skinning.jointLocalPositions!,
    inverseBindMatrices: r.skinning.inverseBindMatrices,
  };
}

describe('skin deformation metric (audit 2026-09-28 C1)', () => {
  it.each(['lbs', 'dqs'] as const)('%s: the rest pose reproduces the rest positions (skinning math matches the bind)', (method) => {
    const m = meshData();
    const rest = skinPositions(m, [], method);
    let maxErr = 0;
    for (let i = 0; i < rest.length / 3; i++) {
      for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(rest[i * 3 + k] - m.vertices[i * 12 + k]));
    }
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('deformation report (set SKIN_BASELINE_OUT=path to write the table) — see docs/specs/character-skin-weights.md', async () => {
    const m = meshData();
    const regions: Record<string, string[]> = {
      armpitL: ['chest', 'clavicle_L', 'shoulder_L'],
      elbowL: ['shoulder_L', 'lowerarm_L'],
      hipL: ['hips', 'upperleg_L'],
      kneeL: ['upperleg_L', 'lowerleg_L'],
    };
    const poses: Record<string, typeof BODY_POSES[string]> = {
      Relaxed: BODY_POSES['Relaxed'], 'A-pose': BODY_POSES['A-pose'],
      elbow90: [{ joint: 'lowerarm_L', q: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] }],
      sit: [{ joint: 'upperleg_L', q: [Math.sin(-Math.PI / 4), 0, 0, Math.cos(-Math.PI / 4)] },
            { joint: 'lowerleg_L', q: [Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)] }],
    };
    const influences = new Map<number, number>();
    for (let v = 0; v < m.jointWeights.length / 4; v++) {
      let n = 0; for (let k = 0; k < 4; k++) if (m.jointWeights[v * 4 + k] > 1e-4) n++;
      influences.set(n, (influences.get(n) ?? 0) + 1);
    }
    const rows: string[] = [`influences per vertex: ${[...influences].sort().map(([n, c]) => `${n}:${c}`).join(' ')}`];
    for (const [pn, pose] of Object.entries(poses)) {
      for (const [rn, region] of Object.entries(regions)) {
        const r = measureDeformation(m, pose as never, region);
        rows.push(`${pn.padEnd(8)} ${rn.padEnd(8)} tris=${r.tris} collapsed=${r.collapsed} stretched=${r.stretched} folded=${r.folded} min=${r.minRatio.toFixed(3)} p5=${r.p5Ratio.toFixed(3)}`);
      }
    }
    // vitest hides console output of passing tests — write the table when asked (SKIN_BASELINE_OUT=path).
    if (process.env.SKIN_BASELINE_OUT) (await import('node:fs')).writeFileSync(process.env.SKIN_BASELINE_OUT, rows.join('\n'));
    expect(rows.length).toBeGreaterThan(1);
  });
});
