/**
 * T-shirt SIDE-SEAM tear regression (2026-10-03). On a wide torso (Torso Thickness ≳ 1.0 or Shoulder Width ≳ 1.2) the
 * body's arm socket sat OUTBOARD of the deltoid ring, so the arm tube began by folding back inside the torso. A sleeve
 * is the body's arm rings offset outward, so it folded into flaps over the shoulder; and the shirt's side seam under the
 * arm, whose nearest skin was now the buried arm, took the arm's weights and opened a slit when the arm hung down.
 * Fix: body-generator keeps the deltoid ring DELTOID_CLEAR past the socket centre. See docs/specs/clothing-generation.md.
 *   1. the captured arm rings (socket → deltoid → … → wrist) never fold back along the arm, for any torso / shoulder;
 *   2. no torso skin shows through a Tee (ray along the skin normal hits no shirt triangle) at rest, Relaxed and idle.
 */
import { describe, it, expect } from 'vitest';
import { generateBodyResult, NEW_BODY_DEFAULTS, BODY_POSES, type BodyParams } from './body-generator';
import { buildBodyFitFrom } from './scene3d-character';
import { generateTop, defaultTopParams } from './clothing-generator';
import { skinAll, dominant } from './clothing-audit-harness';
import { sampleIdlePose } from './pose-preview';
import type { SkinnedMeshData, PoseRotations } from './skin-deform-metrics';

function rayHits(o: number[], d: number[], P: Float32Array, idx: Uint32Array, maxT: number): boolean {
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const tv = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]];
    const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) / det; if (u < 0 || u > 1) continue;
    const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det; if (v < 0 || u + v > 1) continue;
    const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (tt > -0.002 && tt < maxT) return true;
  }
  return false;
}

/** Torso skin verts (between the hem and the neckline) not covered by the Tee, per pose. */
function exposedUnderTee(shape: Partial<BodyParams>): Record<string, number> {
  const r = generateBodyResult({ ...NEW_BODY_DEFAULTS, ...shape });
  const m: SkinnedMeshData = {
    vertices: r.geometry.vertices, stride: 12, posOffset: 0, indices: r.geometry.indices,
    jointIndices: r.skinning.jointIndices, jointWeights: r.skinning.jointWeights, jointNames: r.skinning.jointNames,
    jointParents: r.skinning.jointParents!, jointLocalPositions: r.skinning.jointLocalPositions!, inverseBindMatrices: r.skinning.inverseBindMatrices,
  };
  const fit = buildBodyFitFrom({
    verts: r.geometry.vertices, ji: r.skinning.jointIndices, jw: r.skinning.jointWeights, indices: r.geometry.indices,
    joints: r.skinning.jointNames.map((name, i) => ({ index: i, name, parentIndex: r.skinning.jointParents![i], inverseBindMatrix: r.skinning.inverseBindMatrices.subarray(i * 16, i * 16 + 16) })),
    armSurface: r.armSurface, legSurface: r.legSurface, torsoSurface: r.torsoSurface,
  });
  const tp = defaultTopParams();
  const top = generateTop(fit, tp);
  const names = m.jointNames, torso = new Set(['hips', 'lowerback', 'spine', 'chest'].map((n) => names.indexOf(n)));
  const hips = fit.joints['hips']!, chest = fit.joints['chest']!, neck = fit.joints['neck']!;
  const hemY = hips.pos[1] + (chest.pos[1] - hips.pos[1]) * tp.hemHeight, neckY = chest.pos[1] + (neck.pos[1] - chest.pos[1]) * tp.necklineHeight;
  const bv = r.geometry.vertices, cand: number[] = [];
  for (let i = 0; i < bv.length / 12; i++) {
    const y = bv[i * 12 + 1];
    if (y > hemY + 0.02 && y < neckY - 0.03 && torso.has(dominant(m.jointWeights, m.jointIndices, i))) cand.push(i);
  }
  const poses: Record<string, PoseRotations> = { rest: [], relaxed: BODY_POSES['Relaxed'] as unknown as PoseRotations };
  for (const t of [0.7, 2.1]) poses[`idle ${t}s`] = sampleIdlePose(m, t);
  const out: Record<string, number> = {};
  for (const [pn, pose] of Object.entries(poses)) {
    const pb = skinAll(m, bv, m.jointIndices, m.jointWeights, pose, 'dualQuat');
    const pg = skinAll(m, top.geometry.vertices, top.jointIndices, top.jointWeights, pose, 'dualQuat');
    out[pn] = cand.filter((i) => !rayHits([pb.P[i * 3], pb.P[i * 3 + 1], pb.P[i * 3 + 2]], [pb.N[i * 3], pb.N[i * 3 + 1], pb.N[i * 3 + 2]], pg.P, top.geometry.indices, 0.08)).length;
  }
  return out;
}

describe('T-shirt side seam on wide torsos (2026-10-03)', () => {
  it('the arm rings never fold back inside the torso (socket → deltoid → … stays outward)', () => {
    const bad: string[] = [];
    for (const torsoThick of [0.6, 0.9, 1.0, 1.1, 1.2, 1.3, 1.6]) for (const shoulderWidth of [0.5, 1, 1.2, 1.4, 1.6, 2]) {
      const r = generateBodyResult({ ...NEW_BODY_DEFAULTS, torsoThick, shoulderWidth });
      for (const s of ['L', 'R'] as const) {
        const rings = r.armSurface[s]!;
        const sign = s === 'L' ? 1 : -1;   // the arms run along ±X
        for (let i = 1; i < rings.length; i++) {
          const step = (rings[i].center[0] - rings[i - 1].center[0]) * sign;
          if (step < 0.005) bad.push(`tt ${torsoThick} sw ${shoulderWidth} ${s}: ring ${i} only ${(step * 100).toFixed(1)} cm past ring ${i - 1}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('default bodies are unchanged by the fix (deltoid stays at 13% of the upper arm)', () => {
    const r = generateBodyResult({ ...NEW_BODY_DEFAULTS });
    expect(r.armSurface.L![1].center[0]).toBeCloseTo(0.110, 3);
  });

  it('no torso skin shows through a Tee at rest / Relaxed / idle on wide torsos', () => {
    const fails: string[] = [];
    // [shape, max exposed verts]. Before the fix the wide shapes showed 2–6 verts. A narrow torso with very wide shoulders
    // keeps 1–2 verts deep in the front armpit crease (where the sleeve cap meets the torso), not the side-seam tear.
    const cases: [Partial<BodyParams>, number][] = [
      [{}, 0], [{ torsoThick: 1.1, shoulderWidth: 1.2 }, 0], [{ torsoThick: 1.2, shoulderWidth: 1.2 }, 0],
      [{ torsoThick: 1.3, shoulderWidth: 1 }, 0], [{ torsoThick: 0.9, shoulderWidth: 1.4 }, 2],
    ];
    for (const [shape, limit] of cases) {
      for (const [pose, n] of Object.entries(exposedUnderTee(shape))) if (n > limit) fails.push(`${JSON.stringify(shape)} ${pose}: ${n} skin verts exposed (limit ${limit})`);
    }
    expect(fails).toEqual([]);
  }, 60_000);
});
