import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateBodyResult, BODY_POSES } from './body-generator';
import { measureDeformation, type SkinnedMeshData } from './skin-deform-metrics';
import { seamBlendWeights, packTwoInfluences } from './skin-seam-blend';

function meshData(seamBlend: number): SkinnedMeshData {
  const r = generateBodyResult({ seamBlend });
  return {
    vertices: r.geometry.vertices, stride: 12, posOffset: 0, indices: r.geometry.indices,
    jointIndices: r.skinning.jointIndices, jointWeights: r.skinning.jointWeights, jointNames: r.skinning.jointNames,
    jointParents: r.skinning.jointParents!, jointLocalPositions: r.skinning.jointLocalPositions!,
    inverseBindMatrices: r.skinning.inverseBindMatrices,
  };
}
const hashOf = (m: SkinnedMeshData) =>
  createHash('sha256').update(Buffer.from(m.jointIndices.buffer)).update(Buffer.from(m.jointWeights.buffer)).digest('hex').slice(0, 16);

describe('seam blend — joint smoothness (audit 2026-09-28 C1 Phase 1)', () => {
  it('seamBlend 0 (the default + every saved character) is the classic weights, bit-identical', () => {
    const classic = meshData(0);
    expect(hashOf(meshData(0))).toBe(hashOf(classic));
    expect(hashOf(meshData(NaN))).toBe(hashOf(classic));          // junk → classic, never garbage
    // …and classic still only ever uses 2 influences (what the generator has always produced)
    for (let v = 0; v < classic.jointWeights.length / 4; v++) {
      expect(classic.jointWeights[v * 4 + 2]).toBe(0);
      expect(classic.jointWeights[v * 4 + 3]).toBe(0);
    }
  });

  it('pins the classic output (so a later edit to the generator can\'t silently change saved characters)', () => {
    expect(hashOf(meshData(0))).toMatchSnapshot();
  });

  it('0.5 produces valid weights: ≤4 influences, each vertex sums to 1, no NaN', () => {
    const m = meshData(0.5);
    let multi = 0;
    for (let v = 0; v < m.jointWeights.length / 4; v++) {
      let sum = 0, n = 0;
      for (let k = 0; k < 4; k++) {
        const w = m.jointWeights[v * 4 + k];
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
        sum += w; if (w > 1e-6) n++;
      }
      expect(sum).toBeCloseTo(1, 5);
      if (n > 2) multi++;
    }
    expect(multi).toBeGreaterThan(0);                               // the seam vertices really gained influences
  });

  it('only SEAM vertices change — everything else keeps its classic weights exactly', () => {
    const c = meshData(0), s = meshData(0.5);
    const n = c.jointWeights.length / 4;
    let changed = 0;
    for (let v = 0; v < n; v++) {
      const same = [0, 1, 2, 3].every((k) => c.jointIndices[v * 4 + k] === s.jointIndices[v * 4 + k] || c.jointWeights[v * 4 + k] === 0)
        && [0, 1, 2, 3].every((k) => Math.abs(c.jointWeights[v * 4 + k] - s.jointWeights[v * 4 + k]) < 1e-6);
      if (!same) changed++;
    }
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(n * 0.25);                         // a targeted fix, not a global smear
  });

  it('stops the armpit/elbow folding (the measured result in docs/specs/character-skin-weights.md)', () => {
    const classic = meshData(0), smooth = meshData(0.5);
    const armpit = ['chest', 'clavicle_L', 'shoulder_L'], elbow = ['shoulder_L', 'lowerarm_L'];
    // The spec was measured with the ORIGINAL Relaxed arms (qz ±77, elbow qy ±10) — pinned here so the documented
    // numbers stay reproducible; the current, more natural Relaxed (pose-authoring.relaxedStance) is checked below.
    const h = (d: number) => Math.sin((d * Math.PI) / 360), c = (d: number) => Math.cos((d * Math.PI) / 360);
    const poses: Record<string, unknown> = {
      ...BODY_POSES,
      'Relaxed (spec)': [
        { joint: 'shoulder_L', q: [0, 0, h(-77), c(-77)] }, { joint: 'shoulder_R', q: [0, 0, h(77), c(77)] },
        { joint: 'lowerarm_L', q: [0, h(-10), 0, c(-10)] }, { joint: 'lowerarm_R', q: [0, h(10), 0, c(10)] },
      ],
    };
    const f = (m: SkinnedMeshData, pose: string, region: string[]) =>
      measureDeformation(m, poses[pose] as never, region, classic).folded;
    // classic reference (so this test documents the before/after, not just the after)
    expect(f(classic, 'Relaxed (spec)', armpit)).toBe(16);
    expect(f(classic, 'A-pose', armpit)).toBe(12);
    // with the seam blend
    expect(f(smooth, 'Relaxed (spec)', armpit)).toBeLessThanOrEqual(4);
    expect(f(smooth, 'Relaxed (spec)', elbow)).toBeLessThanOrEqual(4);
    expect(f(smooth, 'Relaxed', armpit)).toBeLessThanOrEqual(4);   // the current stance too
    expect(f(smooth, 'Relaxed', elbow)).toBeLessThanOrEqual(4);
    expect(f(smooth, 'A-pose', armpit)).toBe(0);
    expect(f(smooth, 'A-pose', elbow)).toBe(0);
  });

  it('packTwoInfluences / amount<=0 are identical (the classic path is the old loop)', () => {
    const j0 = [1, 2], w0 = [0.7, 1], j1 = [3, 0], w1 = [0.3, 0];
    expect(seamBlendWeights(2, [0, 1, 1], j0, w0, j1, w1, 4, 0)).toEqual(packTwoInfluences(2, j0, w0, j1, w1));
    expect(seamBlendWeights(2, [0, 1, 1], j0, w0, j1, w1, 4, -1)).toEqual(packTwoInfluences(2, j0, w0, j1, w1));
  });
});
