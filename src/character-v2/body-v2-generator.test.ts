/**
 * body-v2@2 generator gates (docs/specs/character-v2.md, "body-v2@2"):
 *   • topology: a closed, consistently-oriented 2-manifold per part (body, digits, feet); the triangle budget; the
 *     limb / torso resolution; CONSTANT across a slider sweep (vertex order, indices, UVs' split, weights);
 *   • determinism (byte-identical re-runs); weights ≤ 4 influences, normalised, param-independent;
 *   • the 20-joint v1 skeleton (names, parents, identity rest rotations);
 *   • clean UVs: islands don't overlap, no wrapped (smeared) seam triangle, roughly area-proportional;
 *   • the v1 clothing contract: armSurface / legSurface / torsoSurface ring sizes + the underpants' index structure.
 */
import { describe, it, expect } from 'vitest';
import { generateBodyResult } from '../services/managers/body-generator';
import { generateBodyV2, BODY_V2_GEN_DEFAULTS, TORSO_COLS, LIMB_SIDES, KNEE_SLOT0_DEG, type BodyV2GenParams, type BodyV2GenResult } from './body-v2-generator';
import { BODY_V2_BASES, BODY_V2_SLIDERS } from './body-v2-asset';
import { meshOf } from './body-v2-preview';
import { weightAsymmetry } from './body-v2-poses';

const posKey = (V: Float32Array, i: number) => `${V[i * 12]},${V[i * 12 + 1]},${V[i * 12 + 2]}`;

/** Weld by exact position; every undirected edge must be used by exactly 2 triangles, in opposite directions. */
function manifoldReport(r: BodyV2GenResult): { boundary: number; nonManifold: number; misoriented: number; degenerate: number } {
  const V = r.geometry.vertices, I = r.geometry.indices;
  const id = new Map<string, number>(), w = new Int32Array(V.length / 12);
  for (let i = 0; i < w.length; i++) { const k = posKey(V, i); let x = id.get(k); if (x === undefined) { x = id.size; id.set(k, x); } w[i] = x; }
  const edges = new Map<string, number[]>();   // "a,b" (a<b) → list of directions (+1 a→b, −1 b→a)
  let degenerate = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = w[I[t]], b = w[I[t + 1]], c = w[I[t + 2]];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = p < q ? `${p},${q}` : `${q},${p}`;
      let e = edges.get(k); if (!e) { e = []; edges.set(k, e); }
      e.push(p < q ? 1 : -1);
    }
  }
  let boundary = 0, nonManifold = 0, misoriented = 0;
  for (const e of edges.values()) {
    if (e.length === 1) boundary++;
    else if (e.length > 2) nonManifold++;
    else if (e[0] === e[1]) misoriented++;
  }
  return { boundary, nonManifold, misoriented, degenerate };
}

const SWEEP: Partial<BodyV2GenParams>[] = [];
{
  const ranges: [keyof BodyV2GenParams, number, number][] = [
    ['legLength', 0.95, 1.5], ['torsoLength', 0.85, 1.2], ['headSize', 0.95, 1.4], ['limbThick', 0.75, 1.35], ['torsoThick', 0.75, 1.3],
    ['bust', 0, 2], ['waist', 0.72, 1.25], ['hipWidth', 0.82, 1.3], ['hipFront', 0.75, 1.25], ['shoulderWidth', 0.85, 1.35], ['buttSize', 0.3, 1.7], ['headShape', 0, 1],
  ];
  for (const [k, a, b] of ranges) for (const x of [a, (a + b) / 2, b]) SWEEP.push({ [k]: x });
  // combined extremes (deterministic pseudo-random corners)
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < 24; i++) { const p: Partial<BodyV2GenParams> = {}; for (const [k, a, b] of ranges) (p as Record<string, number>)[k] = a + (b - a) * rnd(); SWEEP.push(p); }
  // the per-base range ends (body-v2@3: each base's slider ±1 — some lie outside the shared envelope above, e.g. masc
  // shoulderWidth 1.51, legLength 1.52, headSize 0.75; fem waist 0.66, torsoThick 0.70, limbThick 0.73)
  for (const b of ['fem', 'masc'] as const) for (const d of BODY_V2_SLIDERS) for (const v of [d.range[b].min, d.range[b].max]) SWEEP.push({ ...BODY_V2_BASES[b], [d.name]: v });
}

describe('body-v2@3 generator — topology', () => {
  const base = generateBodyV2();

  it('is a closed, consistently oriented manifold (no holes, no flipped faces, no slivers)', () => {
    const m = manifoldReport(base);
    expect(m).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0, degenerate: 0 });
  });

  it('has the hero-body budget and resolution (6–12k tris; 24-col torso; 16-gon limbs)', () => {
    const tris = base.geometry.indices.length / 3, verts = base.geometry.vertices.length / 12;
    console.log(`[body-v2@2] ${verts} verts, ${tris} tris (v1: ${generateBodyResult({}).geometry.vertices.length / 12} / ${generateBodyResult({}).geometry.indices.length / 3}); torso rings ${base.torsoSurface.length}, arm rings ${base.armSurface.L.length}, leg rings ${base.legSurface.L.length}`);
    expect(tris).toBeGreaterThanOrEqual(6000);
    expect(tris).toBeLessThanOrEqual(12000);
    for (const rg of base.torsoSurface) expect(rg.verts.length).toBe(TORSO_COLS);
    for (const s of ['L', 'R'] as const) {
      for (const rg of base.armSurface[s]) expect(rg.verts.length).toBe(LIMB_SIDES);
      for (const rg of base.legSurface[s]) expect(rg.verts.length).toBe(LIMB_SIDES);
      expect(base.armSurface[s].length).toBeGreaterThanOrEqual(14);
      expect(base.legSurface[s].length).toBeGreaterThanOrEqual(14);
    }
    expect(base.torsoSurface.length).toBeGreaterThanOrEqual(24);
  });

  it('is the v1 20-joint skeleton (names, parents, identity rest rotations)', () => {
    const v1 = generateBodyResult({}).skinning, v2 = base.skinning;
    expect(v2.jointNames).toEqual(v1.jointNames);
    expect([...v2.jointParents!]).toEqual([...v1.jointParents!]);
    for (let j = 0; j < v2.jointNames.length; j++) expect([...v2.jointLocalRotations!.subarray(j * 4, j * 4 + 4)]).toEqual([0, 0, 0, 1]);
  });

  it('weights: ≤ 4 influences, normalised, ≥ 3 graded loops across every bending joint', () => {
    const { jointWeights: w, jointIndices: ji, jointNames } = base.skinning;
    for (let v = 0; v < w.length / 4; v++) expect(Math.abs(w[v * 4] + w[v * 4 + 1] + w[v * 4 + 2] + w[v * 4 + 3] - 1)).toBeLessThan(1e-5);
    // the child joint's share on each limb ring: ≥ 3 rings strictly between 0.05 and 0.95 across each joint
    const share = (rings: BodyV2GenResult['armSurface']['L'], child: string) => rings.map((rg) => {
      const j = jointNames.indexOf(child);
      let s = 0; for (const vt of rg.verts) s += (vt.j0 === j ? vt.w0 : 0) + (vt.j1 === j ? vt.w1 : 0);
      return s / rg.verts.length;
    });
    for (const s of ['L', 'R'] as const) {
      for (const [rings, child] of [[base.armSurface[s], `lowerarm_${s}`], [base.legSurface[s], `lowerleg_${s}`]] as const) {
        const graded = share(rings, child).filter((x) => x > 0.05 && x < 0.95).length;
        expect(graded, `${child} graded loops`).toBeGreaterThanOrEqual(3);
      }
    }
    // the wrist, the ankle and the neck → head (review topology#9 / weights#1: the spec's "≥ 3 graded loops per bending
    // joint" — the old gate asked 2 for the hand / foot and never looked at the neck, where v2@2 had ONE graded ring):
    // the distinct ring-constant child shares strictly between 0.05 and 0.95 over the whole mesh
    const levels = (joint: string) => {
      const j = jointNames.indexOf(joint), vals = new Set<number>();
      for (let v = 0; v < w.length / 4; v++) { let x = 0; for (let k = 0; k < 4; k++) if (ji[v * 4 + k] === j) x += w[v * 4 + k]; if (x > 0.05 && x < 0.95) vals.add(Math.round(x * 1000)); }
      return vals.size;
    };
    for (const s of ['L', 'R'] as const) for (const child of [`hand_${s}`, `foot_${s}`]) expect(levels(child), `${child} graded loops`).toBeGreaterThanOrEqual(3);
    expect(levels('head'), 'neck → head graded rings').toBeGreaterThanOrEqual(5);
  });

  it('weights are mirror-symmetric: every vertex has an x-mirrored twin whose weights are its own with L ↔ R swapped (review weights#4)', () => {
    const a = weightAsymmetry(meshOf(base));
    expect(a.missing, 'vertices without a mirror twin (the hands included)').toBe(0);
    expect(a.max, 'largest |w − mirror(w)|').toBeLessThan(1e-6);
  });

  it('the knee hinge field faces the true back of the knee: KNEE_SLOT0_DEG = the default body slot 0; the inner and outer sides get the same transition (review topology#2)', () => {
    // slot 0's angle about the knee on the default body (0 = the back, the slot direction = sin·X − cos·Z)
    const ll = (r: BodyV2GenResult, s: 'L' | 'R') => { const jl = r.skinning.jointLocalPositions!, par = r.skinning.jointParents!, o = [0, 0, 0]; for (let j = r.skinning.jointNames.indexOf('lowerleg_' + s); j >= 0; j = par[j]) for (let k = 0; k < 3; k++) o[k] += jl[j * 3 + k]; return o; };
    for (const s of ['L', 'R'] as const) {
      const v0 = base.legSurface[s][8].verts[0].p, c = ll(base, s);
      const ang = (Math.atan2(v0[0] - c[0], -(v0[2] - c[2])) * 180) / Math.PI;
      expect(Math.abs(Math.abs(ang) - KNEE_SLOT0_DEG), `${s} slot 0 at ${ang.toFixed(2)}°`).toBeLessThan(0.5);
    }
    // on both bases, at the t 0.90 / 1.00 / 1.07 rings: the lower-leg share interpolated at the exact inner (−90°) and
    // outer (+90°) sides agrees, and the widest transition (the largest share above the knee) faces the back (±12°)
    for (const p of [BODY_V2_BASES.fem, BODY_V2_BASES.masc]) {
      const r = generateBodyV2(p), c = ll(r, 'L'), names = r.skinning.jointNames, jLL = names.indexOf('lowerleg_L');
      for (const ri of [7, 8, 9]) {
        const vs = r.legSurface.L[ri].verts;
        const a = vs.map((v) => Math.atan2(v.p[0] - c[0], -(v.p[2] - c[2])));
        const wt = vs.map((v) => (v.j0 === jLL ? v.w0 : 0) + (v.j1 === jLL ? v.w1 : 0));
        const at = (target: number) => {
          for (let k = 0; k < vs.length; k++) {
            const k2 = (k + 1) % vs.length; let da = a[k2] - a[k], dt = target - a[k];
            while (da > Math.PI) da -= 2 * Math.PI; while (da <= -Math.PI) da += 2 * Math.PI; while (dt > Math.PI) dt -= 2 * Math.PI; while (dt <= -Math.PI) dt += 2 * Math.PI;
            const f = dt / da; if (f >= 0 && f <= 1) return (1 - f) * wt[k] + f * wt[k2];
          }
          return NaN;
        };
        expect(Math.abs(at(Math.PI / 2) - at(-Math.PI / 2)), `ring ${ri} inner vs outer share`).toBeLessThan(0.02);
        if (ri === 7) { let best = 0; for (let k = 1; k < vs.length; k++) if (wt[k] > wt[best]) best = k; expect(Math.abs(a[best] * 180 / Math.PI), 'the widest transition faces the back').toBeLessThan(12); }
      }
    }
  });

  it('the neck → head grade keeps every classifier: torso rings neck / chest-dominant, the head rows head-dominant (review weights#1)', () => {
    const names = base.skinning.jointNames, iHead = names.indexOf('head');
    for (const [ri, rg] of base.torsoSurface.entries()) for (const v of rg.verts) expect(v.j0 === iHead && v.w0 >= 0.5, `torso ring ${ri} head-dominant`).toBe(false);
    // the head's under-jaw ring (landmarks.head.jawRing) and every vertex above it: head-dominant
    const m = meshOf(base), jawY = Math.min(...base.landmarks.head.jawRing.map((p) => p[1]));
    let n = 0;
    for (let i = 0; i < m.vertices.length / 12; i++) {
      if (m.vertices[i * 12 + 1] < jawY - 1e-6 || Math.abs(m.vertices[i * 12]) > 0.12) continue;
      let hw = 0; for (let k = 0; k < 4; k++) if (m.jointIndices[i * 4 + k] === iHead) hw += m.jointWeights[i * 4 + k];
      const isTorso = base.torsoSurface.some((rg) => rg.verts.some((v) => v.p[0] === m.vertices[i * 12] && v.p[1] === m.vertices[i * 12 + 1] && v.p[2] === m.vertices[i * 12 + 2]));
      if (!isTorso) { expect(hw, `head vertex ${i}`).toBeGreaterThanOrEqual(0.6); n++; }
    }
    expect(n).toBeGreaterThan(200);
    // the face (the mouth row h2 and everything above it: the face kit, the eye decal, the hair head map) stays rigid
    const hj = base.landmarks.head.joint[1], u = base.landmarks.head.unit;
    for (let i = 0; i < m.vertices.length / 12; i++) {
      if (m.vertices[i * 12 + 1] < hj - 0.01 * u) continue;
      let hw = 0; for (let k = 0; k < 4; k++) if (m.jointIndices[i * 4 + k] === iHead) hw += m.jointWeights[i * 4 + k];
      expect(hw, `face vertex ${i}`).toBeGreaterThan(0.9999);
    }
  });

  it('the inner thighs carry only their own leg: no leg-tube vertex takes the other side\'s joints (review weights#2)', () => {
    const names = base.skinning.jointNames, side = names.map((nm) => (nm.endsWith('_L') ? 'L' : nm.endsWith('_R') ? 'R' : ''));
    for (const p of [BODY_V2_BASES.fem, BODY_V2_BASES.masc]) {
      const r = generateBodyV2(p);
      for (const s of ['L', 'R'] as const) for (const rg of r.legSurface[s].slice(1)) for (const v of rg.verts) {
        for (const [j, wt] of [[v.j0, v.w0], [v.j1, v.w1]] as const) if (wt > 0) expect(side[j] === '' || side[j] === s, `${s} leg vertex on ${names[j]}`).toBe(true);
      }
    }
  });

  it('the shoulder pivot follows the armhole for every param set: the joint → armhole-loop inset stays within 15 mm of the base at every slider end (pre-review: 22–48 mm; review weights#3)', () => {
    const inset = (r: BodyV2GenResult) => {
      const jl = r.skinning.jointLocalPositions!, par = r.skinning.jointParents!, names = r.skinning.jointNames;
      const wpos = (nm: string) => { const o = [0, 0, 0]; for (let j = names.indexOf(nm); j >= 0; j = par[j]) for (let k = 0; k < 3; k++) o[k] += jl[j * 3 + k]; return o; };
      const sh = wpos('shoulder_L'), lo = wpos('lowerarm_L'), c = r.armSurface.L[0].center, L = Math.hypot(lo[0] - sh[0], lo[1] - sh[1], lo[2] - sh[2]);
      return ((c[0] - sh[0]) * (lo[0] - sh[0]) + (c[1] - sh[1]) * (lo[1] - sh[1]) + (c[2] - sh[2]) * (lo[2] - sh[2])) / L;
    };
    // per base: every slider at its −1 / +1 (the per-base ranges) and the torsoThick × shoulderWidth corners. Pre-review
    // the pivot ignored torsoThick and this inset ran 3 → 10 cm (fem); G1's pivot follows the armhole bilinearly, so the
    // only drift left is the armhole top's clamp at a narrow shoulderWidth (12.8 mm at fem shoulderWidth −1, pre-review 22; the
    // deformation gates in body-v2-metrics pass there).
    const lines: string[] = [];
    for (const b of ['fem', 'masc'] as const) {
      const s0 = inset(generateBodyV2(BODY_V2_BASES[b]));
      let worst = 0, where = '';
      const cases: Record<string, number>[] = [];
      for (const sl of BODY_V2_SLIDERS) for (const x of [-1, 1]) cases.push({ [sl.name]: x });
      cases.push({ torsoThick: 1, shoulderWidth: -1 }, { torsoThick: -1, shoulderWidth: 1 }, { torsoThick: 1, shoulderWidth: 1 }, { torsoThick: -1, shoulderWidth: -1 });
      for (const c of cases) {
        const q = { ...BODY_V2_BASES[b] } as Record<string, number>;
        for (const [n, x] of Object.entries(c)) { const sl = BODY_V2_SLIDERS.find((d) => d.name === n)!; q[n] = x < 0 ? sl.range[b].min : sl.range[b].max; }
        const d = Math.abs(inset(generateBodyV2(q as unknown as BodyV2GenParams)) - s0);
        if (d > worst) { worst = d; where = JSON.stringify(c); }
        expect(d, `${b} ${JSON.stringify(c)}`).toBeLessThan(0.015);
      }
      lines.push(`${b}: inset ${(s0 * 1000).toFixed(1)} mm, worst drift ${(worst * 1000).toFixed(1)} mm at ${where}`);
    }
    console.log('[body-v2@2] shoulder pivot → armhole inset: ' + lines.join(' | '));
  });

  it('constant topology + weights over a slider sweep (vertex count, indices, UV split, joint weights)', () => {
    const I0 = base.geometry.indices, n0 = base.geometry.vertices.length;
    for (const p of SWEEP) {
      const r = generateBodyV2(p);
      expect(r.geometry.vertices.length, JSON.stringify(p)).toBe(n0);
      expect(Buffer.from(r.geometry.indices.buffer).equals(Buffer.from(I0.buffer)), JSON.stringify(p)).toBe(true);
      expect(Buffer.from(r.skinning.jointIndices.buffer).equals(Buffer.from(base.skinning.jointIndices.buffer)), JSON.stringify(p)).toBe(true);
      expect(Buffer.from(r.skinning.jointWeights.buffer).equals(Buffer.from(base.skinning.jointWeights.buffer)), JSON.stringify(p)).toBe(true);
      const m = manifoldReport(r);
      expect(m.boundary + m.nonManifold + m.misoriented + m.degenerate, JSON.stringify(p)).toBe(0);
    }
  });

  it('is deterministic (byte-identical re-run)', () => {
    const a = generateBodyV2({ ...BODY_V2_GEN_DEFAULTS, bust: 1.3, waist: 0.9 }), b = generateBodyV2({ ...BODY_V2_GEN_DEFAULTS, bust: 1.3, waist: 0.9 });
    expect(Buffer.from(a.geometry.vertices.buffer).equals(Buffer.from(b.geometry.vertices.buffer))).toBe(true);
    expect(Buffer.from(a.skinning.jointWeights.buffer).equals(Buffer.from(b.skinning.jointWeights.buffer))).toBe(true);
    expect(JSON.stringify(a.torsoSurface)).toBe(JSON.stringify(b.torsoSurface));
  });
});

describe('body-v2@3 generator — UVs', () => {
  const r = generateBodyV2();
  const V = r.geometry.vertices, I = r.geometry.indices;

  it('islands do not overlap, every UV is in [0, 1], no seam triangle wraps across an island', () => {
    const N = 1024, owner = new Int32Array(N * N).fill(-1);
    let overlap = 0, covered = 0, longEdge = 0;
    for (let v = 0; v < V.length / 12; v++) { expect(V[v * 12 + 6]).toBeGreaterThanOrEqual(0); expect(V[v * 12 + 6]).toBeLessThanOrEqual(1); expect(V[v * 12 + 7]).toBeGreaterThanOrEqual(0); expect(V[v * 12 + 7]).toBeLessThanOrEqual(1); }
    for (let t = 0; t < I.length; t += 3) {
      const u = [0, 1, 2].map((k) => [V[I[t + k] * 12 + 6] * N, V[I[t + k] * 12 + 7] * N]);
      for (let k = 0; k < 3; k++) if (Math.hypot(u[k][0] - u[(k + 1) % 3][0], u[k][1] - u[(k + 1) % 3][1]) > N * 0.08) longEdge++;
      const area = (u[1][0] - u[0][0]) * (u[2][1] - u[0][1]) - (u[1][1] - u[0][1]) * (u[2][0] - u[0][0]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(u[0][0], u[1][0], u[2][0]))), x1 = Math.min(N - 1, Math.ceil(Math.max(u[0][0], u[1][0], u[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(u[0][1], u[1][1], u[2][1]))), y1 = Math.min(N - 1, Math.ceil(Math.max(u[0][1], u[1][1], u[2][1])));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5, qy = y + 0.5;
        const w0 = ((u[1][0] - qx) * (u[2][1] - qy) - (u[1][1] - qy) * (u[2][0] - qx)) / area;
        const w1 = ((u[2][0] - qx) * (u[0][1] - qy) - (u[2][1] - qy) * (u[0][0] - qx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 <= 1e-6 || w1 <= 1e-6 || w2 <= 1e-6) continue;
        const o = y * N + x;
        if (owner[o] >= 0) overlap++; else { owner[o] = t; covered++; }
      }
    }
    console.log(`[body-v2@2 UV] atlas coverage ${(100 * covered / (N * N)).toFixed(1)} %, overlapping texels ${overlap} (${(100 * overlap / Math.max(1, covered)).toFixed(3)} %), wrapped edges ${longEdge}`);
    expect(longEdge).toBe(0);
    expect(overlap / covered).toBeLessThan(0.002);
  });

  it('is roughly area-proportional (UV area / surface area within a narrow band for 90 % of the surface; the neck + head island at 1.5² by design)', () => {
    const ratios: [number, number][] = [], headRatios: [number, number][] = [];
    const { jointIndices: ji, jointWeights: jw, jointNames } = r.skinning;
    const dom = (v: number) => { let b = 0, bw = -1; for (let k = 0; k < 4; k++) if (jw[v * 4 + k] > bw) { bw = jw[v * 4 + k]; b = ji[v * 4 + k]; } return jointNames[b]; };
    for (let t = 0; t < I.length; t += 3) {
      const P = [0, 1, 2].map((k) => [V[I[t + k] * 12], V[I[t + k] * 12 + 1], V[I[t + k] * 12 + 2]]);
      const U = [0, 1, 2].map((k) => [V[I[t + k] * 12 + 6], V[I[t + k] * 12 + 7]]);
      const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
      const a3 = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
      const a2 = 0.5 * Math.abs((U[1][0] - U[0][0]) * (U[2][1] - U[0][1]) - (U[1][1] - U[0][1]) * (U[2][0] - U[0][0]));
      if (a3 > 1e-10) (['head', 'neck'].includes(dom(I[t])) && ['head', 'neck'].includes(dom(I[t + 1])) ? headRatios : ratios).push([a2 / a3, a3]);
    }
    ratios.sort((x, y) => x[0] - y[0]);
    const tot = ratios.reduce((s, r2) => s + r2[1], 0);
    const at = (q: number) => { let acc = 0; for (const [rt, a] of ratios) { acc += a; if (acc >= q * tot) return rt; } return ratios[ratios.length - 1][0]; };
    const p5 = at(0.05), p50 = at(0.5), p95 = at(0.95);
    console.log(`[body-v2@2 UV] texel density (area-weighted) p5 ${(p5 / p50).toFixed(2)}× · p95 ${(p95 / p50).toFixed(2)}× of the median`);
    expect(p5 / p50).toBeGreaterThan(0.45);
    expect(p95 / p50).toBeLessThan(2.2);
    // the neck + head island is packed at 1.5× the linear texel density (the face carries the painted detail)
    headRatios.sort((x, y) => x[0] - y[0]);
    const hm = headRatios[Math.floor(headRatios.length / 2)][0];
    expect(hm / p50).toBeGreaterThan(1.5 * 1.5 * 0.7);
    expect(hm / p50).toBeLessThan(1.5 * 1.5 * 1.3);
  });
});

describe('body-v2@3 generator — the v1 clothing contract', () => {
  const r = generateBodyV2();
  it('the underpants index structure: torso ring 0 = 24 verts, leg ring 0 = 16 verts in loop order (crotch at 1–3 / 13–15)', () => {
    const pb = r.torsoSurface[0].verts, L0 = r.legSurface.L[0].verts, R0 = r.legSurface.R[0].verts;
    expect(pb.length).toBe(24);
    expect(pb[6].p[2]).toBeGreaterThan(0);            // front centre
    expect(pb[18].p[2]).toBeLessThan(0);              // back centre
    expect(pb[0].p[0]).toBeGreaterThan(0);            // +X = left
    // L ring 0: index 0 under the front centre, 1–3 the crotch (front → back) near x≈0, 4 under the back centre
    expect(L0[0].p[2]).toBeGreaterThan(0); expect(L0[4].p[2]).toBeLessThan(0);
    expect(L0[1].p[2]).toBeGreaterThan(L0[3].p[2]);
    for (const k of [1, 2, 3]) expect(Math.abs(L0[k].p[0])).toBeLessThan(Math.abs(L0[10].p[0]));
    expect(R0[15].p[2]).toBeGreaterThan(R0[13].p[2]);
    for (const k of [13, 14, 15]) expect(Math.abs(R0[k].p[0])).toBeLessThan(Math.abs(R0[4].p[0]));
  });
});
