/**
 * Body mesh TOPOLOGY stability across body params — the "shin web" regression (Polish Round 6).
 *
 * Bug: for hipFront ≈ 0.636–0.660 (incl. the auto Play character, seed 20260930 → hipFront 0.652) weldAccum fused a
 * mirrored L/R calf-ring vertex pair that both sat within the weld eps of x = 0. The right shin's faces were then
 * stitched onto a vertex skinned to lowerleg_L, so the moment the legs moved apart (Walk/Run) those faces stretched
 * into a pale triangular web between the shins. Fix: the weld is keyed by side (L/R/centre) — see weldAccum.
 *
 * Invariants checked over a fine hipFront sweep × other params × randomizer bodies:
 *  - vertex + triangle count are PARAM-INDEPENDENT (the weld must never drop/fuse a vert for some slider values),
 *  - the triangle SET is identical to the default body's (same topology, only positions change),
 *  - no triangle joins verts bound to OPPOSITE legs' lower-leg/foot joints,
 *  - no vertex bound to lowerleg_* sits above the knee band,
 *  - in a scissored STRIDE (legs apart, plain LBS) no lower-leg/foot edge stretches (the web only tears when posed).
 */
import { describe, it, expect } from 'vitest';
import { generateBodyResult, type BodyParams } from './body-generator';
import { randomCharacterParams } from './character-randomizer';

type Body = ReturnType<typeof generateBodyResult>;

const vals = (a: number, b: number, n: number): number[] => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));

/** Dominant (heaviest) joint of each vertex. */
function dominantJoints(b: Body): Int32Array {
  const s = b.skinning!, n = b.geometry.vertices.length / 12, out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) if (s.jointWeights[i*4+k] > bw) { bw = s.jointWeights[i*4+k]; best = s.jointIndices[i*4+k]; }
    out[i] = best;
  }
  return out;
}

/** World rest position of a joint (identity rotations → sum of local offsets up the chain). */
function jointWorld(b: Body, name: string): [number, number, number] {
  const s = b.skinning!;
  let j = s.jointNames.indexOf(name); const w: [number, number, number] = [0, 0, 0];
  while (j >= 0) { w[0] += s.jointLocalPositions![j*3]; w[1] += s.jointLocalPositions![j*3+1]; w[2] += s.jointLocalPositions![j*3+2]; j = s.jointParents![j]; }
  return w;
}

/** Linear-blend skin the rest mesh with upperleg_L pitched +deg and upperleg_R −deg about X (identity rest rotations,
 *  so each leg joint's skin transform is just a rotation about its chain's hip pivot). Returns posed xyz per vertex. */
function skinScissor(b: Body, deg: number): Float32Array {
  const s = b.skinning!, names = s.jointNames, v = b.geometry.vertices, n = v.length / 12, out = new Float32Array(n * 3);
  const pivots: Record<string, { piv: [number, number, number]; a: number }> = {};
  for (const [side, sign] of [['L', 1], ['R', -1]] as const) {
    const piv = jointWorld(b, 'upperleg_' + side), a = sign * deg * Math.PI / 180;
    for (const jn of ['upperleg_', 'lowerleg_', 'foot_']) pivots[jn + side] = { piv, a };
  }
  for (let i = 0; i < n; i++) {
    const x = v[i*12], y = v[i*12+1], z = v[i*12+2];
    let px = 0, py = 0, pz = 0;
    for (let k = 0; k < 4; k++) {
      const w = s.jointWeights[i*4+k]; if (w <= 0) continue;
      const pv = pivots[names[s.jointIndices[i*4+k]]];
      if (!pv) { px += w*x; py += w*y; pz += w*z; continue; }
      const dy = y - pv.piv[1], dz = z - pv.piv[2], c = Math.cos(pv.a), sn = Math.sin(pv.a);
      px += w * x; py += w * (pv.piv[1] + dy*c - dz*sn); pz += w * (pv.piv[2] + dy*sn + dz*c);
    }
    out[i*3] = px; out[i*3+1] = py; out[i*3+2] = pz;
  }
  return out;
}

const triKey = (a: number, b: number, c: number): string => [a, b, c].sort((x, y) => x - y).join(',');
const triSet = (b: Body): Set<string> => {
  const idx = b.geometry.indices, s = new Set<string>();
  for (let t = 0; t < idx.length; t += 3) s.add(triKey(idx[t], idx[t+1], idx[t+2]));
  return s;
};

function legProblems(b: Body): string[] {
  const s = b.skinning!, names = s.jointNames, v = b.geometry.vertices, idx = b.geometry.indices;
  const dom = dominantJoints(b);
  const legSide = (j: number): 'L' | 'R' | null => {
    const n = names[j];
    if (n === 'lowerleg_L' || n === 'foot_L') return 'L';
    if (n === 'lowerleg_R' || n === 'foot_R') return 'R';
    return null;
  };
  const kneeY = Math.max(jointWorld(b, 'lowerleg_L')[1], jointWorld(b, 'lowerleg_R')[1]);
  const thighLen = jointWorld(b, 'upperleg_L')[1] - kneeY;
  const out: string[] = [];
  // (a) lower-leg-bound verts stay at/below the knee band (knee ring + a little flare — never up the thigh / at the crotch)
  for (let i = 0; i < dom.length; i++) {
    const n = names[dom[i]];
    if ((n === 'lowerleg_L' || n === 'lowerleg_R') && v[i*12+1] > kneeY + 0.15 * thighLen)
      out.push(`${n} vert #${i} above knee band (y=${v[i*12+1].toFixed(3)}, knee ${kneeY.toFixed(3)})`);
  }
  // (b) a triangle never joins the two lower legs
  for (let t = 0; t < idx.length; t += 3) {
    const sides = [idx[t], idx[t+1], idx[t+2]].map(i => legSide(dom[i]));
    if (sides.includes('L') && sides.includes('R')) out.push(`tri ${idx[t]},${idx[t+1]},${idx[t+2]} joins L+R lower legs`);
  }
  // (c) STRIDE — scissor the legs (Walk/Run contact pose) and require no lower-leg/foot edge stretches. A cross-leg
  // weld is invisible at rest (the fused verts were coincident) but tears into the between-shins web once the legs part.
  const posed = skinScissor(b, 35);
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t+1], idx[t+2]];
    if (!tri.some(i => legSide(dom[i]))) continue;
    for (let e = 0; e < 3; e++) {
      const i = tri[e], j = tri[(e+1) % 3];
      const r = Math.hypot(v[i*12]-v[j*12], v[i*12+1]-v[j*12+1], v[i*12+2]-v[j*12+2]);
      const q = Math.hypot(posed[i*3]-posed[j*3], posed[i*3+1]-posed[j*3+1], posed[i*3+2]-posed[j*3+2]);
      if (q > r * 1.5 + 0.01) out.push(`tri ${tri} lower-leg edge stretches ${r.toFixed(3)} -> ${q.toFixed(3)} in a stride`);
    }
  }
  return out;
}

describe('body leg topology is stable across params (shin-web regression)', () => {
  // Sweeps generate ~1,200 bodies — slow under a loaded full-suite run, hence the explicit per-test timeouts.
  const ref = generateBodyResult();
  const refV = ref.geometry.vertices.length, refT = triSet(ref);

  const check = (label: string, p: Partial<BodyParams>): void => {
    const b = generateBodyResult(p);
    expect(b.geometry.vertices.length, `${label}: vertex count`).toBe(refV);
    const ts = triSet(b);
    expect(ts.size, `${label}: triangle count`).toBe(refT.size);
    for (const k of ts) if (!refT.has(k)) throw new Error(`${label}: triangle ${k} not in the default body's topology`);
    expect(legProblems(b), label).toEqual([]);
  };

  it('the default body is clean', () => { expect(legProblems(ref)).toEqual([]); });

  it('hipFront 0.30 → 1.20 (fine steps, incl. the 0.636–0.660 bad band)', () => {
    for (const hipFront of vals(0.30, 1.20, 226)) check(`hipFront ${hipFront.toFixed(4)}`, { hipFront });
  }, 60_000);

  it('hipFront sweep × other body params', () => {
    const extras: Partial<BodyParams>[] = [
      { hipWidth: 1.3 }, { hipWidth: 0.8 }, { waist: 0.8 }, { limbThick: 1.1 }, { limbThick: 0.7 },
      { legLength: 1.2 }, { buttSize: 1.5 }, { height: 1.1 }, { torsoThick: 1.1 }, { seamBlend: 0.5 },
    ];
    for (const ex of extras) for (const hipFront of vals(0.30, 1.20, 46)) check(`${JSON.stringify(ex)} hipFront ${hipFront.toFixed(3)}`, { hipFront, ...ex });
  }, 60_000);

  it('the randomizer body range (waist 0.75–1.05 × hipFront 0.60–0.90) + randomizer seeds', () => {
    for (const waist of vals(0.75, 1.05, 7)) for (const hipFront of vals(0.60, 0.90, 61)) check(`waist ${waist.toFixed(3)} hipFront ${hipFront.toFixed(3)}`, { waist, hipFront });
    for (const seed of [20260930, 1, 2, 3, 42, 1234, 99999]) {
      const body = randomCharacterParams(seed).body;
      check(`seed ${seed} ${JSON.stringify(body)}`, { ...body, seamBlend: 0.5 });
    }
  }, 60_000);

  it('auto Play character (seed 20260930) sits in the formerly-broken band', () => {
    const hf = randomCharacterParams(20260930).body.hipFront!;
    expect(hf).toBeGreaterThan(0.636);
    expect(hf).toBeLessThan(0.660);
  });
});
