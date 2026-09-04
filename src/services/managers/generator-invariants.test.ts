import { describe, it, expect } from 'vitest';
import { generateBodyResult, DEFAULT_BODY_PARAMS, type BodyParams } from './body-generator';
import { validateSkinnedResult } from './generator-invariants';

// §5.3 — the body generator is pure (params → typed arrays, no GPUDevice), so we can pin its structural
// invariants directly: interleave stride, skinning array sizing, finite geometry, blend weights summing to 1,
// in-range joint indices, in-range triangle indices, non-degenerate bounds. This is the safety net that must be
// green BEFORE the god-object extraction moves code around it (docs/specs/god-objects-and-perf.md, Part A).

// A spread of parameter extremes — each must still produce a structurally valid skinned mesh.
const CASES: { name: string; params: Partial<BodyParams> }[] = [
  { name: 'defaults', params: {} },
  { name: 'neutral',  params: { height: 1, limbThick: 1, torsoThick: 1, headSize: 1, legLength: 1, torsoLength: 1 } },
  { name: 'tiny',     params: { height: 0.5, limbThick: 0.5, torsoThick: 0.5, headSize: 0.6 } },
  { name: 'huge',     params: { height: 2, limbThick: 1.8, torsoThick: 1.8, headSize: 1.8, legLength: 2 } },
  { name: 'curvy',    params: { bust: 1.8, waist: 0.6, hipWidth: 1.6, hipFront: 1.5, buttSize: 1.8 } },
  { name: 'flat',     params: { bust: 1, waist: 1, hipWidth: 1, hipFront: 1, buttSize: 0, shoulderWidth: 1.6 } },
  { name: 'leggy',    params: { legLength: 2.2, torsoLength: 0.7 } },
];

describe('§5.3 body generator invariants', () => {
  for (const c of CASES) {
    it(`produces a structurally valid skinned body: ${c.name}`, () => {
      const result = generateBodyResult(c.params);
      const v = validateSkinnedResult(result, `body:${c.name}`);
      // Surface every violation in the failure message, not just the first.
      expect(v.errors, v.errors.join('\n')).toEqual([]);
      expect(v.ok).toBe(true);
      // Sanity on the stats so an empty-but-valid degenerate result can't pass silently.
      expect(v.stats.vertexCount).toBeGreaterThan(100);
      expect(v.stats.triangleCount).toBeGreaterThan(100);
      expect(v.stats.jointCount).toBeGreaterThan(0);
    });
  }

  it('DEFAULT_BODY_PARAMS is itself a valid input', () => {
    const v = validateSkinnedResult(generateBodyResult({ ...DEFAULT_BODY_PARAMS }), 'body:explicit-default');
    expect(v.errors, v.errors.join('\n')).toEqual([]);
  });

  // The validator must actually FAIL on broken data (guards against a vacuous always-true oracle).
  it('rejects a corrupted result (NaN position + broken weights)', () => {
    const good = generateBodyResult({});
    const verts = good.geometry.vertices.slice();
    verts[0] = NaN;                                   // first vertex position → NaN
    const weights = good.skinning.jointWeights.slice();
    weights[0] = 5; weights[1] = 5; weights[2] = 5; weights[3] = 5;   // first vertex weights sum to 20
    const broken = { ...good, geometry: { ...good.geometry, vertices: verts }, skinning: { ...good.skinning, jointWeights: weights } };
    const v = validateSkinnedResult(broken, 'body:corrupted');
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.includes('NaN/Inf'))).toBe(true);
    expect(v.errors.some(e => e.includes('summing to 1'))).toBe(true);
  });
});
