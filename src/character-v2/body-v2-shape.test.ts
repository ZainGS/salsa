/**
 * body-v2 SHAPE gates — the geometry / proportion fixes of the body-v2@2 adversarial review (group G1, 2026-10-05;
 * docs/specs/character-v2.md "body-v2@2 review fixes — G1"). Every gate here FAILS on the pre-review generator
 * (measured, see the spec) and holds over the bases, every per-base slider range end and the risky corners:
 *   • legs never touch / cross: plane sections L ∩ R = 0 and the gap ≥ 2·legClearance(t) (bind, Relaxed, the idle
 *     weight shift; the generator AND the blended asset);
 *   • the hip → thigh outline has no notch; the bust's side silhouette no shelf; no sliver torso rings;
 *   • a natural shoulder slope (Relaxed); arms / hands reach mid-thigh; real-sized feet that continue the leg; a rigid
 *     shin when the foot bends;
 *   • headSize scales the head uniformly; no jaw ledge at any headShape; a ≥ 12 mm under-chin strip; a thicker masc neck;
 *   • a natural fem waist; an exactly mirror-symmetric mesh (the right hand's fingers);
 *   • normals continuous in the params; UV islands upright, non-mirrored, low-distortion, with UV tangents;
 *   • the head frame v1's face / hair placement expects (landmarks.head.v1Box = v1's headRegionBBoxOf box).
 */
import { describe, it, expect } from 'vitest';
import { BODY_POSES, generateBodyResult, NEW_BODY_DEFAULTS } from '../services/managers/body-generator';
import { headRegionBBoxOf } from '../services/managers/body-fit';
import { q } from '../services/managers/clothing-audit-harness';
import { weightShift } from '../services/managers/pose-authoring';
import type { PoseRotations, SkinnedMeshData } from '../services/managers/skin-deform-metrics';
import { generateBodyV2, legClearance, type BodyV2GenParams, type BodyV2GenResult } from './body-v2-generator';
import {
  BODY_V2_BASES, BODY_V2_SLIDERS, sliderParamValue, getBodyV2Asset, bodyV2Weights, bodyV2Vertices, bodyV2JointLocal, bodyV2InverseBinds,
  type BodyV2Base, type BodyV2Sliders,
} from './body-v2-asset';
import { meshOf } from './body-v2-preview';
import { proportions } from './body-v2-poses';
import * as M from './body-v2-shape-metrics';

const BASES = ['fem', 'masc'] as const;
const relaxed = BODY_POSES['Relaxed'] as PoseRotations;
const shift = (s: 'L' | 'R'): PoseRotations => [...relaxed, ...Object.entries(weightShift(s, 4)).map(([joint, qq]) => ({ joint, q: qq }))];
const def = (n: string) => BODY_V2_SLIDERS.find((d) => d.name === n)!;
/** Generator params of a base with some sliders at normalised values (the per-base ranges). */
const at = (base: BodyV2Base, s: Partial<Record<string, number>>): BodyV2GenParams => {
  const p: BodyV2GenParams = { ...BODY_V2_BASES[base] };
  for (const [k, x] of Object.entries(s)) (p as unknown as Record<string, number>)[k] = sliderParamValue(def(k), base, x!);
  return p;
};
/** Every slider at its range ends + the risky corners + seeded random combos, per base. */
function sweep(base: BodyV2Base): [string, BodyV2GenParams][] {
  const out: [string, BodyV2GenParams][] = [['base', { ...BODY_V2_BASES[base] }]];
  for (const d of BODY_V2_SLIDERS) for (const x of [-1, 1]) out.push([`${d.name} ${x}`, at(base, { [d.name]: x })]);
  for (const [k, c] of Object.entries({
    'lt+1 hw-1': { limbThick: 1, hipWidth: -1 }, 'lt+1 hw+1': { limbThick: 1, hipWidth: 1 }, 'lt-1 hw-1': { limbThick: -1, hipWidth: -1 },
    'tt+1 sw-1': { torsoThick: 1, shoulderWidth: -1 }, 'tt-1 sw+1': { torsoThick: -1, shoulderWidth: 1 }, 'tt+1 lt+1 hw-1': { torsoThick: 1, limbThick: 1, hipWidth: -1 },
    'bust+1 tt+1': { bust: 1, torsoThick: 1 }, 'hs+1 hsh-1': { headSize: 1, headShape: -1 }, 'hs-1 hsh-1': { headSize: -1, headShape: -1 },
  })) out.push([k, at(base, c)]);
  let s = base === 'fem' ? 99991 : 77773;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 12; i++) { const c: Record<string, number> = {}; for (const d of BODY_V2_SLIDERS) c[d.name] = rnd() * 2 - 1; out.push([`random ${i}`, at(base, c)]); }
  return out;
}
const cache = new Map<string, BodyV2GenResult>();
const gen = (p: BodyV2GenParams): BodyV2GenResult => { const k = JSON.stringify(p); let r = cache.get(k); if (!r) { r = generateBodyV2(p); cache.set(k, r); } return r; };
const stature = (m: SkinnedMeshData) => { const { lo, hi } = M.yBounds(M.restP(m)); return hi - lo; };

describe('body-v2 shape — legs (review topology#1 / weights#2 / proportions#5)', () => {
  it('the legs never overlap and keep their gap: bind, Relaxed and the idle weight shift, over the sweep', () => {
    const bad: string[] = [];
    for (const base of BASES) for (const [name, p] of sweep(base)) {
      const m = meshOf(gen(p));
      const poses: [string, PoseRotations][] = name === 'base' ? [['bind', []], ['relaxed', relaxed], ['shift L', shift('L')], ['shift R', shift('R')]] : [['bind', []]];
      for (const [pn, pose] of poses) {
        const r = M.legSections(m, M.posedP(m, pose).P, pose, { tol: 0.001 });
        if (r.maxArea > 0 || r.minMargin < 0) bad.push(`${base} ${name} ${pn}: overlap ${(r.maxArea * 1e6).toFixed(0)} mm², gap margin ${(r.minMargin * 1e3).toFixed(1)} mm`);
      }
    }
    expect(bad).toEqual([]);
  }, 120000);

  it('…and on the BLENDED asset (what renders) at the thick-leg / narrow-hip corners', () => {
    for (const base of BASES) {
      const asset = getBodyV2Asset(base);
      for (const s of [{ limbThick: 1, hipWidth: -1 }, { limbThick: 1 }, { hipWidth: -1 }, { limbThick: 0.5, hipWidth: -0.5, torsoThick: 0.7 }, { limbThick: 1, hipWidth: -1, legLength: 1 }] as BodyV2Sliders[]) {
        const w = bodyV2Weights(asset, s), jl = bodyV2JointLocal(asset, w);
        const m: SkinnedMeshData = {
          vertices: bodyV2Vertices(asset, w), stride: 12, posOffset: 0, indices: asset.indices, jointIndices: asset.jointIndices, jointWeights: asset.jointWeights,
          jointNames: asset.jointNames, jointParents: asset.jointParents, jointLocalPositions: jl, inverseBindMatrices: bodyV2InverseBinds(asset.jointParents, jl).inverseBind,
        };
        const r = M.legSections(m, M.restP(m), [], { tol: 0.001 });
        expect(r.maxArea, `${base} ${JSON.stringify(s)} overlap`).toBe(0);
        expect(r.minMargin, `${base} ${JSON.stringify(s)} gap margin`).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120000);

  it('the inner thigh is a smooth curve: no flat wall + step (the inner contour of the thigh bends ≤ 4 mm per ring)', () => {
    for (const base of BASES) for (const [name, p] of sweep(base)) {
      const rings = gen(p).legSurface.L;
      const inner = rings.map((rg) => Math.min(...rg.verts.map((v) => v.p[0])));
      for (let i = 1; i <= 7; i++) expect(Math.abs(inner[i + 1] - 2 * inner[i] + inner[i - 1]), `${base} ${name} ring ${i}`).toBeLessThanOrEqual(0.004);   // r0 … t 0.90
    }
  }, 120000);

  it('the hip → thigh outline has no notch (front contour dip ≤ 2.5 mm from the hip to the knee; review proportions#4)', () => {
    for (const base of BASES) for (const [name, p] of sweep(base)) {
      const r = gen(p), m = meshOf(r), lp = r.skinning.jointLocalPositions!, par = r.skinning.jointParents!;
      const wy = (j: number) => { let y = 0; for (let k = j; k >= 0; k = par[k]) y += lp[k * 3 + 1]; return y; };
      const d = M.hipDent(m, M.restP(m), wy(0) - 0.02 * p.height, wy(15) + 0.02 * p.height);
      expect(d.dent, `${base} ${name} at y ${d.at.toFixed(3)}`).toBeLessThanOrEqual(0.0025);
    }
  }, 120000);
});

describe('body-v2 shape — torso (review topology#4 / #7, proportions#3 / #6 / #11)', () => {
  it('the bust side silhouette turns ≤ 20° per ring up to bust 1.55 and ≤ 25° at bust 2 (the apex is a ring; no shelf)', () => {
    for (const base of BASES) for (const bust of [0, BODY_V2_BASES[base].bust, 1.55, 2]) for (const tt of [BODY_V2_BASES[base].torsoThick, 1.15]) {
      const r = gen({ ...BODY_V2_BASES[base], bust, torsoThick: tt }), R = r.landmarks.rings;
      const t = M.sideProfileTurn(r.torsoSurface, R.W, R.AP);
      expect(Math.abs(t.maxTurn), `${base} bust ${bust} tt ${tt} ring ${t.at}`).toBeLessThanOrEqual(bust <= 1.55 ? 20 : 25);
      expect(R.A, 'the apex ring sits between the under-bust and the armpit').toBeGreaterThan(R.UB);
    }
  });

  it('no sliver torso rings: every column keeps ≥ 5 mm between rings on the bases, ≥ 4 mm over the sweep', () => {
    for (const base of BASES) for (const [name, p] of sweep(base)) {
      const s = M.torsoSpacing(gen(p).torsoSurface);
      expect(s.min, `${base} ${name} ring ${s.ring} col ${s.col}`).toBeGreaterThanOrEqual(name === 'base' ? 0.005 : 0.004);
    }
  }, 120000);

  it('a natural shoulder slope: Relaxed 18–28° on the bases, ≤ 30° at the shoulderWidth / torsoThick ends; the neck keeps its length', () => {
    for (const base of BASES) for (const [name, p] of [['base', BODY_V2_BASES[base]], ...[-1, 1].flatMap((x) => [[`sw ${x}`, at(base, { shoulderWidth: x })], [`tt ${x}`, at(base, { torsoThick: x })]])] as [string, BodyV2GenParams][]) {
      const r = gen(p), m = meshOf(r), { neckBaseX, acromionX } = r.landmarks.shoulder, yJ = r.torsoSurface[r.landmarks.rings.JAW].center[1];
      const slope = M.shoulderSlope(m, M.posedP(m, relaxed).P, neckBaseX + 0.002, acromionX, yJ);
      if (name === 'base') expect(slope, `${base} Relaxed`).toBeGreaterThanOrEqual(18);
      expect(slope, `${base} ${name} Relaxed`).toBeLessThanOrEqual(name === 'base' ? 28 : 30);
      // the neck column at the side (top neck ring → neck base) stays ≥ 2.2 % of the stature
      const col = r.torsoSurface[r.landmarks.rings.JAW].verts[0].p[1] - r.torsoSurface[r.landmarks.rings.NB].verts[0].p[1];
      expect(col / stature(m), `${base} ${name} neck column`).toBeGreaterThanOrEqual(0.022);
    }
  });

  it('a natural waist: front waist / hip 0.60–0.70 (fem), 0.75–0.95 (masc); the fem waist is wider than deep (≥ 1.3)', () => {
    for (const base of BASES) {
      const r = gen(BODY_V2_BASES[base]), pr = proportions(meshOf(r));
      const lim = base === 'fem' ? [0.6, 0.7] : [0.75, 0.95];
      expect(pr.waistW / pr.hipW, base).toBeGreaterThanOrEqual(lim[0]);
      expect(pr.waistW / pr.hipW, base).toBeLessThanOrEqual(lim[1]);
      const w = r.torsoSurface[r.landmarks.rings.W].verts, xs = w.map((v) => v.p[0]), zs = w.map((v) => v.p[2]);
      if (base === 'fem') expect((Math.max(...xs) - Math.min(...xs)) / (Math.max(...zs) - Math.min(...zs))).toBeGreaterThanOrEqual(1.3);
    }
  });
});

describe('body-v2 shape — arms, hands, feet (review proportions#1 / #2, topology#3, weights#5)', () => {
  it('arms straight down: the wrist 0.5–3 % of the stature above the crotch, the fingertips ≥ 5 % below (≥ 3 % at the torsoLength / legLength ends)', () => {
    for (const base of BASES) for (const [name, p] of [['base', BODY_V2_BASES[base]], ...[-1, 1].flatMap((x) => [[`torsoLength ${x}`, at(base, { torsoLength: x })], [`legLength ${x}`, at(base, { legLength: x })]])] as [string, BodyV2GenParams][]) {
      const r = M.reach(meshOf(gen(p)), M.armsDownPose());
      if (name === 'base') {
        expect(r.wristMinusCrotch, `${base} wrist`).toBeGreaterThanOrEqual(0.005);
        expect(r.wristMinusCrotch, `${base} wrist`).toBeLessThanOrEqual(0.03);
      }
      expect(r.tipMinusCrotch, `${base} ${name} fingertips`).toBeLessThanOrEqual(name === 'base' ? -0.05 : -0.03);
    }
  });

  it('the hand is 0.6–0.85 head heights long, and limbThick changes its length by ≤ 16 % over its range', () => {
    for (const base of BASES) {
      const h = M.handAndHead(meshOf(gen(BODY_V2_BASES[base])));
      expect(h.hand / h.head, base).toBeGreaterThanOrEqual(0.6);
      expect(h.hand / h.head, base).toBeLessThanOrEqual(0.85);
      const lo = M.handAndHead(meshOf(gen(at(base, { limbThick: -1 })))).hand, hi = M.handAndHead(meshOf(gen(at(base, { limbThick: 1 })))).hand;
      expect(hi / lo, base).toBeLessThanOrEqual(1.16);
    }
  });

  it('real-sized feet: 0.088–0.10 of the stature long, width / length 0.36–0.46, limbThick changes the length ≤ 16 %', () => {
    for (const base of BASES) {
      const f = M.footSize(meshOf(gen(BODY_V2_BASES[base])));
      expect(f.length / f.H, base).toBeGreaterThanOrEqual(0.088);
      expect(f.length / f.H, base).toBeLessThanOrEqual(0.1);
      expect(f.width / f.length, base).toBeGreaterThanOrEqual(0.36);
      expect(f.width / f.length, base).toBeLessThanOrEqual(0.46);
      const lo = M.footSize(meshOf(gen(at(base, { limbThick: -1 })))).length, hi = M.footSize(meshOf(gen(at(base, { limbThick: 1 })))).length;
      expect(hi / lo, base).toBeLessThanOrEqual(1.16);
    }
  });

  it('the foot continues the leg tube: one body shell + the 20 rigid digits (v2@2: 23 shells, the leg capped at the ankle)', () => {
    const r = gen(BODY_V2_BASES.fem), V = r.geometry.vertices, I = r.geometry.indices;
    const key = (i: number) => `${V[i * 12]},${V[i * 12 + 1]},${V[i * 12 + 2]}`, id = new Map<string, number>();
    const w = new Int32Array(V.length / 12).map((_, i) => { const k = key(i); let x = id.get(k); if (x === undefined) { x = id.size; id.set(k, x); } return x; });
    const par = new Int32Array(id.size).map((_, i) => i);
    const find = (x: number): number => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let t = 0; t < I.length; t += 3) { const a = find(w[I[t]]); par[find(w[I[t + 1]])] = a; par[find(w[I[t + 2]])] = a; }
    const shells = new Set<number>(); for (let i = 0; i < id.size; i++) shells.add(find(i));
    expect(shells.size).toBe(21);
  });

  it('the ANKLE bends at the ankle: the lower shin rides the bone rigidly (≤ 4 mm, ≤ 3°) at plantar 40 / 55, dorsi 30, invert 30, evert 20', () => {
    for (const base of BASES) {
      const r = gen(BODY_V2_BASES[base]), m = meshOf(r), ids = M.ringVertexIds(m, r.legSurface.L.slice(12, 16));
      for (const [n, pose] of [['plantar 40', q('x', 40)], ['plantar 55', q('x', 55)], ['dorsi 30', q('x', -30)], ['invert 30', q('z', 30)], ['evert 20', q('z', -20)]] as const) {
        const s = M.shinRigidity(m, ids, [{ joint: 'foot_L', q: pose }]);
        expect(s.offset, `${base} ${n} offset`).toBeLessThanOrEqual(0.004);
        expect(s.bendDeg, `${base} ${n} bend`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('the mesh is exactly mirror-symmetric in position (the right hand is the left hand mirrored, finger for finger)', () => {
    for (const base of BASES) for (const p of [BODY_V2_BASES[base], at(base, { limbThick: 1, shoulderWidth: -1, headSize: 1 })]) {
      expect(M.mirrorMisses(meshOf(gen(p)), 1e-4, false), base).toBe(0);
    }
  });
});

describe('body-v2 shape — head + neck (review proportions#7 / #8 / #10 / #12 / #13, topology#6, downstream#1)', () => {
  it('headSize scales the head UNIFORMLY (width / height constant, ±1 each change the height ≥ 6 %)', () => {
    for (const base of BASES) {
      const h0 = M.handAndHead(meshOf(gen(BODY_V2_BASES[base]))), lo = M.handAndHead(meshOf(gen(at(base, { headSize: -1 })))), hi = M.handAndHead(meshOf(gen(at(base, { headSize: 1 }))));
      for (const h of [lo, hi]) expect(Math.abs(h.headW / h.head - h0.headW / h0.head), base).toBeLessThan(0.01);
      expect(lo.head / h0.head, base).toBeLessThanOrEqual(0.94);
      expect(hi.head / h0.head, base).toBeGreaterThanOrEqual(1.06);
    }
  });

  it('heads tall (skull): fem 8.1–8.8, masc 9.1–9.9, and the masc reads ≥ 0.6 heads taller', () => {
    const ht = (b: BodyV2Base) => { const h = M.handAndHead(meshOf(gen(BODY_V2_BASES[b]))); return h.H / h.head; };
    expect(ht('fem')).toBeGreaterThanOrEqual(8.1); expect(ht('fem')).toBeLessThanOrEqual(8.8);
    expect(ht('masc')).toBeGreaterThanOrEqual(9.1); expect(ht('masc')).toBeLessThanOrEqual(9.9);
    expect(ht('masc') - ht('fem')).toBeGreaterThanOrEqual(0.6);
  });

  it('no ledge under the jaw at any headShape / headSize (neck top → jaw ring: never > 2 mm inward at < 45°)', () => {
    for (const base of BASES) for (const hsh of [-1, -0.5, 0]) for (const hs of [-1, 0, 1]) {
      const r = gen(at(base, { headShape: hsh, headSize: hs })), top = r.torsoSurface[r.landmarks.rings.JAW].verts, jaw = r.landmarks.head.jawRing, j = r.landmarks.head.joint;
      for (const c of [0, 6, 12, 18]) {
        const rad = (p: number[]) => Math.hypot(p[0] - j[0], p[2] - j[2]);
        const inward = rad(top[c].p) - rad(jaw[c]), rise = jaw[c][1] - top[c].p[1];
        if (inward > 0.002) expect((Math.atan2(rise, inward) * 180) / Math.PI, `${base} headShape ${hsh} headSize ${hs} col ${c}`).toBeGreaterThanOrEqual(45);
      }
    }
  });

  it('the under-chin strip (top neck ring → chin, front) is ≥ 12 mm (v2@2: 6 mm, it stretched > 2× at a 14° nod)', () => {
    for (const base of BASES) for (const hs of [-1, 0, 1]) {
      const r = gen(at(base, { headSize: hs }));
      expect(r.landmarks.head.chinY - r.torsoSurface[r.landmarks.rings.JAW].verts[6].p[1], `${base} headSize ${hs}`).toBeGreaterThanOrEqual(0.012);
    }
  });

  it('the masc neck is visibly thicker than the fem (≥ 1.12× as a share of the stature, ≥ 0.6 of his head width)', () => {
    const nw = (b: BodyV2Base) => {
      const r = gen(BODY_V2_BASES[b]), m = meshOf(r), R = r.landmarks.rings;
      return { w: M.neckWidth(m, M.restP(m), r.torsoSurface[R.NB].center[1] + 0.01, r.torsoSurface[R.JAW].center[1] - 0.005) / stature(m), head: M.handAndHead(m).headW / stature(m) };
    };
    const f = nw('fem'), m = nw('masc');
    expect(m.w / f.w).toBeGreaterThanOrEqual(1.12);
    expect(m.w / m.head).toBeGreaterThanOrEqual(0.6);
  });

  it('the head frame is v1\'s: landmarks.head.v1Box = headRegionBBoxOf on v1\'s anime head, relative to the head joint (≤ 1 mm)', () => {
    const v1 = generateBodyResult({ ...NEW_BODY_DEFAULTS }), s1 = v1.skinning, hi = s1.jointNames.indexOf('head');
    const bb = headRegionBBoxOf(v1.geometry.vertices, s1.jointIndices, s1.jointWeights, hi)!;
    let hy = 0; for (let k = hi; k >= 0; k = s1.jointParents![k]) hy += s1.jointLocalPositions![k * 3 + 1];
    for (const base of BASES) {
      const r = gen({ ...BODY_V2_BASES[base], headSize: 1 }), h = r.landmarks.head;
      expect(Math.abs((h.v1Box.min[1] - h.joint[1]) - (bb.min[1] - hy)), `${base} min`).toBeLessThanOrEqual(0.001);
      expect(Math.abs((h.v1Box.max[1] - h.joint[1]) - (bb.max[1] - hy)), `${base} max`).toBeLessThanOrEqual(0.001);
      // and it scales with the head
      const r2 = gen({ ...BODY_V2_BASES[base], headSize: 1.15 }), h2 = r2.landmarks.head;
      expect((h2.v1Box.max[1] - h2.v1Box.min[1]) / (h.v1Box.max[1] - h.v1Box.min[1])).toBeCloseTo(1.15, 3);
    }
  });
});

describe('body-v2 shape — normals + UVs (review pipeline#3, downstream#2 / #3)', () => {
  it('normals are continuous in the params (no vertex turns > 3° per 0.01 step while moving < 0.1 mm)', () => {
    for (const base of BASES) {
      const B = BODY_V2_BASES[base];
      const pairs: [BodyV2GenParams, BodyV2GenParams][] = [[{ ...B, headShape: 0 }, { ...B, headShape: 0.001 }]];
      for (const [k, a, b] of [['headShape', 0, 1], ['torsoThick', 0.72, 1.3], ['headSize', 0.8, 1.2]] as const) for (let x = a; x < b - 1e-9; x += (b - a) / 12) pairs.push([{ ...B, [k]: x }, { ...B, [k]: x + 0.01 }]);
      for (const [p0, p1] of pairs) expect(M.normalJump(gen(p0).geometry.vertices, gen(p1).geometry.vertices), `${base} ${JSON.stringify(p0)}`).toBeLessThanOrEqual(3);
    }
  }, 120000);

  it('UV islands: none mirrored, the torso / head / limbs read image-down = body-down, anisotropy p99 ≤ 8 and max ≤ 40', () => {
    for (const base of BASES) for (const p of [BODY_V2_BASES[base], at(base, { torsoThick: 1, shoulderWidth: -1 }), at(base, { headSize: 1, bust: 1 })]) {
      for (const s of M.uvIslands(meshOf(gen(p)))) {
        expect(s.mirroredPct, `${base} ${s.dominant}`).toBeLessThanOrEqual(1);
        if (/^(chest|spine|hips|head|neck|upperleg|lowerleg|lowerback)/.test(s.dominant)) expect(s.downDot, `${base} ${s.dominant}`).toBeGreaterThanOrEqual(0.7);
        if (s.tris > 60) {
          expect(s.anisoP99, `${base} ${s.dominant}`).toBeLessThanOrEqual(8);
          expect(s.anisoMax, `${base} ${s.dominant}`).toBeLessThanOrEqual(40);
        }
      }
    }
  });

  it('tangents follow the UVs (T ≈ dP/du, one handedness per island)', () => {
    const r = gen(BODY_V2_BASES.fem), V = r.geometry.vertices, I = r.geometry.indices;
    let aligned = 0, total = 0, wNeg = 0;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
      const e1 = [0, 1, 2].map((k) => V[b * 12 + k] - V[a * 12 + k]), e2 = [0, 1, 2].map((k) => V[c * 12 + k] - V[a * 12 + k]);
      const du1 = V[b * 12 + 6] - V[a * 12 + 6], dv1 = V[b * 12 + 7] - V[a * 12 + 7], du2 = V[c * 12 + 6] - V[a * 12 + 6], dv2 = V[c * 12 + 7] - V[a * 12 + 7];
      const det = du1 * dv2 - du2 * dv1; if (Math.abs(det) < 1e-12) continue;
      const T = [0, 1, 2].map((k) => (dv2 * e1[k] - dv1 * e2[k]) / det), tl = Math.hypot(T[0], T[1], T[2]);
      const vt = [V[a * 12 + 8], V[a * 12 + 9], V[a * 12 + 10]];
      if ((T[0] * vt[0] + T[1] * vt[1] + T[2] * vt[2]) / tl > 0.8) aligned++;
      if (V[a * 12 + 11] < 0) wNeg++;
      total++;
    }
    expect(aligned / total).toBeGreaterThanOrEqual(0.97);
    expect(Math.min(wNeg, total - wNeg) / total).toBeLessThanOrEqual(0.01);   // non-mirrored islands → one handedness
  });

  it('topology stays constant over the per-base sweep (same index buffer, same weights)', () => {
    for (const base of BASES) {
      const ref = gen(BODY_V2_BASES[base]);
      for (const [name, p] of sweep(base)) {
        const r = gen(p);
        expect(r.geometry.vertices.length, `${base} ${name}`).toBe(ref.geometry.vertices.length);
        expect(Buffer.from(r.geometry.indices.buffer).equals(Buffer.from(ref.geometry.indices.buffer)), `${base} ${name}`).toBe(true);
        expect(Buffer.from(r.skinning.jointWeights.buffer).equals(Buffer.from(ref.skinning.jointWeights.buffer)), `${base} ${name}`).toBe(true);
      }
    }
  }, 120000);
});

void legClearance;
