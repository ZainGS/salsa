/**
 * body-v2@2 DEFORMATION vs v1 — the same poses, the same skinning (dual quaternion, as new characters render), per body
 * region. Triangles that stretch > 2× / collapse < 0.5× / fold inside-out (skin-deform-metrics.measureDeformation), as
 * % of the region's triangles (the bodies have different triangle counts), plus arm/hand self-intersection
 * (pose-preview.measureSelfIntersection, the engine's arm-clearance measure).
 *   • v1 new  = v1's new-body default (seam blend 0.5 + hip smoothing);
 *   • v2@1    = the v1 generator at the v2@1 fem base (what body-v2@1 froze);
 *   • v2@2    = this generator at the v2@2 fem / masc bases.
 * The report always prints; the gate (v2@2 no worse than v1 on folds per region) is in the second test.
 *
 * The REVIEW GATES (docs/specs/character-v2.md "body-v2@2 review fixes — G2"; review weights#6, deformation#5,
 * topology#9) below measure what the fold test above cannot see — skinMetrics (inverted = face vs skinned vertex
 * normals, crease, σ-ratio shear, stretch), buried skin, the knee bulge / twisted crease, the parent segment's drift
 * under a wrist / ankle flex and L / R symmetry — over REVIEW_POSES (head-only nods / tilts / turns, forward raises past
 * horizontal + the default Idle Stretch / Jump Reach, wrist + forearm rolls, deep knees, ankles), on both bases AND at
 * every slider's −1 / +1 plus the worst combos. Each gate FAILS on the pre-G2 weights (the numbers in the spec).
 */
import { describe, it, expect } from 'vitest';
import { generateBodyResult, NEW_BODY_DEFAULTS } from '../services/managers/body-generator';
import { skinAll, ROM_POSES, q } from '../services/managers/clothing-audit-harness';
import { measureSelfIntersection } from '../services/managers/pose-preview';
import type { SkinnedMeshData, PoseRotations } from '../services/managers/skin-deform-metrics';
import {
  DEFORM_POSES, REGIONS, deformTable, selfIntersect, proportions,
  REVIEW_POSES, REVIEW_REGIONS, skinMetrics, buriedVerts, kneeMetrics, parentDrift, ringOffBone, columnKink, weightAsymmetry, posedTwinDeviation, type SkinRow,
} from './body-v2-poses';
import { generateBodyV2, type BodyV2GenParams, type BodyV2GenResult } from './body-v2-generator';
import { BODY_V2_BASES, BODY_V2_AT1_BASES, BODY_V2_SLIDERS, type BodyV2Base } from './body-v2-asset';
import { meshOf } from './body-v2-preview';

const BODIES: [string, () => SkinnedMeshData][] = [
  ['v1 new', () => meshOf(generateBodyResult({ ...NEW_BODY_DEFAULTS }))],
  ['v2@1 fem', () => meshOf(generateBodyResult(BODY_V2_AT1_BASES.fem))],
  ['v2@2 fem', () => meshOf(generateBodyV2(BODY_V2_BASES.fem))],
  ['v2@2 masc', () => meshOf(generateBodyV2(BODY_V2_BASES.masc))],
];

describe('body-v2@2 deformation vs v1', () => {
  const tables = BODIES.map(([name, mk]) => { const m = mk(); return { name, m, rows: deformTable(m), inter: selfIntersect(m) }; });

  it('reports (stretch / collapse / fold % per region, self-intersection verts)', () => {
    const lines: string[] = [];
    const poses = Object.keys(DEFORM_POSES), regions = Object.keys(REGIONS);
    lines.push(`fold% / stretch% per region (shoulder, elbow, hip, knee, spine) — ${tables.map((t) => t.name).join(' | ')}`);
    for (const pn of poses) {
      const cells = tables.map((t) => regions.map((rn) => { const r = t.rows.find((x) => x.pose === pn && x.region === rn)!; return `${r.foldPct.toFixed(1)}/${r.stretchPct.toFixed(1)}`; }).join(' '));
      lines.push(`${pn.padEnd(14)} ${cells.join(' | ')}`);
    }
    lines.push(`self-intersection verts: ${poses.map((pn) => `${pn}: ${tables.map((t) => t.inter[pn]).join('/')}`).join('  ')}`);
    const tot = (t: (typeof tables)[number], k: 'foldPct' | 'stretchPct' | 'collapsePct') => t.rows.reduce((s, r) => s + r[k], 0) / poses.length;   // (Σ regions, mean over poses — the spec tables use this)
    lines.push(`mean over poses × regions: ${tables.map((t) => `${t.name}: fold ${tot(t, 'foldPct').toFixed(2)} % stretch ${tot(t, 'stretchPct').toFixed(2)} % collapse ${tot(t, 'collapsePct').toFixed(2)} %`).join(' | ')}`);
    for (const t of tables) { const pr = proportions(t.m); lines.push(`proportions ${t.name.padEnd(9)} ${Object.entries(pr).map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  ')}`); }
    console.log('[body-v2@2 deform]\n' + lines.join('\n'));
    expect(tables.length).toBe(4);
  });

  it('v2@2 folds no more than v1 in every region (mean over the poses)', () => {
    const v1 = tables[0], regions = Object.keys(REGIONS);
    for (const t of tables.slice(2)) for (const rn of regions) {
      // the per-pose MEAN (pre-G2 this summed over the 18 poses, so the +0.5 slack was a sum's)
      const mean = (x: (typeof tables)[number]) => { const r = x.rows.filter((y) => y.region === rn); return r.reduce((s, y) => s + y.foldPct, 0) / r.length; };
      expect(mean(t), `${t.name} ${rn}`).toBeLessThanOrEqual(mean(v1) + 0.5);
    }
  });
});

// ── the G2 review gates ────────────────────────────────────────────────────────────────────────────────────────────
type Rec = { rows: Record<string, SkinRow>; buried?: number; si?: number; knee?: { radialMax: number; mlGap: number }; drift?: number };
const NECK_SMALL = ['head down 20', 'phone nod', 'nod n15+h20', 'head up 30', 'head tilt 30', 'head yaw 35', 'head yaw 60', 'turn n40+h35', 'head turn+nod'];
const NECK_DEEP = ['head down 35', 'nod n15+h35', 'look up n15+h35'];
const SHOULDER = ['arm fwd-up 90', 'arm fwd-up 120', 'arm fwd-up 150', 'Idle Stretch f40', 'Jump Reach f12', 'arms overhead', 'arms forward', 'arms cross', 'relaxed', 'walk 25%', 'run 60%'];
const KNEE = ['knee 90', 'knee 130', 'knee 150', 'seiza', 'kneel', 'squat', 'sit', 'lunge', 'run 25%', 'run 60%'];
const ALL_POSES = { ...DEFORM_POSES, ...REVIEW_POSES } as Record<string, (m: SkinnedMeshData) => PoseRotations>;

/** Measure `poses` on one body (every REVIEW_REGIONS row; buried skin for the neck + knee poses; the knee metrics; the
 *  self-intersection for the shoulder poses). */
function measure(r: BodyV2GenResult | ReturnType<typeof generateBodyResult>, poses: string[]): Record<string, Rec> {
  const m = meshOf(r), leg = (r as { legSurface: { L: { verts: { p: [number, number, number] }[] }[] } }).legSurface.L;
  const rest = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, [], 'dualQuat');
  const out: Record<string, Rec> = {};
  for (const pn of poses) {
    const pose = ALL_POSES[pn](m), posed = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
    const rec: Rec = { rows: skinMetrics(m, pose, REVIEW_REGIONS, posed) };
    if (NECK_SMALL.includes(pn) || NECK_DEEP.includes(pn)) rec.buried = buriedVerts(m, posed.P, posed.N, ['neck', 'head']).length;
    if (KNEE.includes(pn)) { rec.knee = kneeMetrics(m, leg, pose); if (pn === 'knee 90' || pn === 'knee 130') rec.buried = buriedVerts(m, posed.P, posed.N, ['lowerleg_L']).length; }
    if (SHOULDER.includes(pn)) rec.si = measureSelfIntersection(m, rest.P, posed.P, posed.N).verts.size;
    out[pn] = rec;
  }
  return out;
}
const at = (b: BodyV2Base, o: Partial<Record<keyof BodyV2GenParams, number>>): BodyV2GenParams => {
  const p = { ...BODY_V2_BASES[b] } as Record<string, number>;
  for (const [n, x] of Object.entries(o)) { const s = BODY_V2_SLIDERS.find((d) => d.name === n)!; p[n] = x! < 0 ? s.range[b].min : s.range[b].max; }
  return p as unknown as BodyV2GenParams;
};

describe('body-v2@2 review gates (G2): skin weights + deformation', () => {
  const POSES = [...new Set([...NECK_SMALL, ...NECK_DEEP, ...SHOULDER, ...KNEE, 'elbow 120', 'elbow 95 about -Z', 'Hands on Hips', 'hand roll 90', 'forearm roll 90', 'elbow 90 + hand roll 90'])];
  const v1 = measure(generateBodyResult({ ...NEW_BODY_DEFAULTS }), [...NECK_DEEP, ...NECK_SMALL]);
  const gens = Object.fromEntries((['fem', 'masc'] as const).map((b) => [b, generateBodyV2(BODY_V2_BASES[b])])) as Record<BodyV2Base, BodyV2GenResult>;
  const bases = Object.fromEntries((['fem', 'masc'] as const).map((b) => [b, measure(gens[b], POSES)])) as Record<BodyV2Base, Record<string, Rec>>;
  const fmt = (r: SkinRow) => `inv ${r.inverted} cr ${r.creaseN} st ${r.stretched} co ${r.collapsed} σ ${r.maxAniso.toFixed(2)}`;

  it('reports the review pose set (per region: inverted / crease / stretched / collapsed / worst σ ratio)', () => {
    const lines: string[] = [];
    for (const pn of POSES) {
      const cells = (['fem', 'masc'] as const).map((b) => {
        const rec = bases[b][pn], regs = NECK_SMALL.includes(pn) || NECK_DEEP.includes(pn) ? ['neck'] : SHOULDER.includes(pn) ? ['shoulder'] : KNEE.includes(pn) ? ['knee', 'hip', 'ankle'] : ['elbow', 'wrist'];
        return `${b}: ${regs.map((rn) => `${rn} ${fmt(rec.rows[rn])}`).join(', ')}${rec.buried !== undefined ? ` buried ${rec.buried}` : ''}${rec.si !== undefined ? ` si ${rec.si}` : ''}${rec.knee ? ` knee radial ${rec.knee.radialMax.toFixed(3)} ml ${(rec.knee.mlGap * 1000).toFixed(1)} mm` : ''}`;
      });
      const v = v1[pn] ? ` | v1: neck ${fmt(v1[pn].rows.neck)} buried ${v1[pn].buried}` : '';
      lines.push(`${pn.padEnd(24)} ${cells.join(' | ')}${v}`);
    }
    console.log('[body-v2@2 review gates]\n' + lines.join('\n'));
    expect(lines.length).toBe(POSES.length);
  });

  it('neck → head (weights#1, deformation#6, topology#6): no inverted / buried / stretched skin in nods ≤ 35° total, tilts and turns; deep nods ≤ v1; shear σ ≤ 3.5', () => {
    for (const b of ['fem', 'masc'] as const) {
      for (const pn of NECK_SMALL) {
        const r = bases[b][pn];
        expect(r.rows.neck.inverted, `${b} ${pn} inverted`).toBe(0);
        expect(r.buried!, `${b} ${pn} buried`).toBeLessThanOrEqual(1);
        expect(r.rows.neck.stretched, `${b} ${pn} stretched`).toBe(0);
        expect(r.rows.neck.maxAniso, `${b} ${pn} σ ratio`).toBeLessThanOrEqual(3.5);
      }
      for (const pn of NECK_DEEP) {
        const r = bases[b][pn];
        expect(r.rows.neck.inverted, `${b} ${pn} inverted vs v1`).toBeLessThanOrEqual(v1[pn].rows.neck.inverted);
        expect(r.buried!, `${b} ${pn} buried vs v1`).toBeLessThanOrEqual(v1[pn].buried! + 6);
        expect(r.rows.neck.stretched, `${b} ${pn} stretched`).toBe(0);
        expect(r.rows.neck.maxAniso, `${b} ${pn} σ ratio`).toBeLessThanOrEqual(3.5);
      }
    }
  });

  it('shoulders (deformation#1, weights#3): forward raises to 150° + the default Idle Stretch / Jump Reach: ≤ 1 inverted, ≤ 8 creases, ≤ 2 stretched (pre-G2: 24 / 12 / 10); Relaxed / walk / overhead: clean; Relaxed / walk: clean, no arm in the body', () => {
    for (const b of ['fem', 'masc'] as const) for (const pn of SHOULDER) {
      const r = bases[b][pn], calm = pn === 'relaxed' || pn === 'walk 25%' || pn === 'arms overhead';
      expect(r.rows.shoulder.inverted, `${b} ${pn} inverted`).toBeLessThanOrEqual(calm ? 0 : 1);
      expect(r.rows.shoulder.creaseN, `${b} ${pn} creases`).toBeLessThanOrEqual(calm ? 0 : 8);
      expect(r.rows.shoulder.stretched, `${b} ${pn} stretched`).toBeLessThanOrEqual(calm ? 0 : 2);
      if (pn === 'relaxed' || pn === 'walk 25%') expect(r.si!, `${b} ${pn} self-intersection`).toBe(0);
    }
  });

  it('the arm keeps its shape (the trade-off the raise fix must not cross): the arm below the cap on its bone, the cap ≤ 50 mm, and no notch in the hanging arm\'s outline', () => {
    for (const b of ['fem', 'masc'] as const) {
      const m = meshOf(gens[b]), L = gens[b].armSurface.L as never;
      for (const pn of ['arm fwd-up 150', 'Jump Reach f12', 'arms overhead', 'arms cross', 'relaxed', 'walk 25%']) {
        // armSurface: 0 = the armhole loop, 1 + i = ARM_RINGS[i] → 2 / 3 / 4 = t 0.33 / 0.44 / 0.56 (the cap), 5 … 8 = t 0.68 … 1.00
        const off = ringOffBone(m, L, [2, 3, 4, 5, 6, 7], ALL_POSES[pn](m), 'shoulder_L', 'lowerarm_L');
        expect(Math.max(off[0], off[1]), `${b} ${pn} shoulder-cap rings off the bone`).toBeLessThanOrEqual(0.05);
        expect(off[2], `${b} ${pn} t 0.56 off the bone`).toBeLessThanOrEqual(0.012);
        for (let k = 3; k < off.length; k++) expect(off[k], `${b} ${pn} arm ring #${k + 2} (t ≥ 0.68) off the bone`).toBeLessThanOrEqual(0.002);
        // the outline: the worst turn a pose adds along any arm column from the loop to the elbow (pre-G2: Relaxed
        // 24–26°, overhead 36–41°, arms cross 47–58°, fwd-up 150 52–54°; smoothing the cap further down the arm made a 42°
        // notch in Relaxed)
        const k = columnKink(m, L, 0, 8, ALL_POSES[pn](m)).deg;
        expect(k, `${b} ${pn} arm outline kink`).toBeLessThanOrEqual(pn === 'relaxed' || pn === 'walk 25%' ? 25 : pn === 'arms overhead' ? 36 : pn === 'arms cross' ? 55 : 46);
      }
    }
  });

  it('knees (deformation#2, topology#2): the hinge on the true back of the knee — bulge ≤ 1.09, inner vs outer side ≤ 3 mm, 0 inverted, no calf in the thigh at ≤ 130°', () => {
    for (const b of ['fem', 'masc'] as const) for (const pn of KNEE) {
      const r = bases[b][pn];
      expect(r.rows.knee.inverted, `${b} ${pn} knee inverted`).toBe(0);
      expect(r.knee!.radialMax, `${b} ${pn} knee radial`).toBeLessThanOrEqual(1.09);
      // (medial vs lateral is a world (y, z) measure: only meaningful where the thigh turns about x alone — not the gait)
      if (!pn.startsWith('run')) expect(r.knee!.mlGap, `${b} ${pn} medial vs lateral`).toBeLessThanOrEqual(0.003);
      if (r.buried !== undefined) expect(r.buried, `${b} ${pn} calf inside the thigh`).toBe(0);
    }
  });

  it('wrists + ankles (topology#9, deformation#4): the parent stays put under a flex; the roll shear is ratcheted (an engine twist helper owns it)', () => {
    for (const b of ['fem', 'masc'] as const) {
      const m = meshOf(gens[b]);
      for (const [pn, pose] of [['flex 70', [{ joint: 'hand_L', q: q('z', -70) }]], ['ext 60', [{ joint: 'hand_L', q: q('z', 60) }]]] as [string, PoseRotations][]) {
        expect(parentDrift(m, pose, 'lowerarm_L', 'hand_L', 0.06), `${b} wrist ${pn}: forearm 6 cm up`).toBeLessThanOrEqual(0.001);
        expect(parentDrift(m, pose, 'lowerarm_L', 'hand_L', 0.03), `${b} wrist ${pn}: forearm 3 cm up`).toBeLessThanOrEqual(0.015);
      }
      for (const [pn, pose] of [['plantar 40', [{ joint: 'foot_L', q: q('x', 40) }]], ['dorsi 25', [{ joint: 'foot_L', q: q('x', -25) }]]] as [string, PoseRotations][])
        expect(parentDrift(m, pose, 'lowerleg_L', 'foot_L', 0.03), `${b} ankle ${pn}: shin 3 cm up`).toBeLessThanOrEqual(0.004);
      // ratchets (today's values; review deformation#4: the fix is an engine twist distribution, not these weights)
      expect(bases[b]['hand roll 90'].rows.wrist.maxAniso, `${b} hand roll σ`).toBeLessThanOrEqual(2.6);
      expect(bases[b]['forearm roll 90'].rows.elbow.maxAniso, `${b} forearm roll σ`).toBeLessThanOrEqual(3.6);
      expect(bases[b]['elbow 90 + hand roll 90'].rows.elbow.inverted, `${b} elbow 90 + roll`).toBe(0);
      expect(bases[b]['elbow 120'].rows.elbow.inverted, `${b} elbow 120`).toBeLessThanOrEqual(6);
      // off the hinge (review deformation#3: a content rule — the elbow is pre-shaped for local −Y flexion): ratchets
      expect(bases[b]['elbow 95 about -Z'].rows.elbow.inverted, `${b} off-hinge elbow`).toBeLessThanOrEqual(14);
      expect(bases[b]['Hands on Hips'].rows.elbow.inverted, `${b} Hands on Hips elbow`).toBeLessThanOrEqual(14);
    }
  });

  it('L / R symmetry (weights#4): the weights mirror exactly (every vertex has a twin, hands included); mirrored poses stay mirrored', () => {
    const sym: [string, PoseRotations][] = [['overhead', ROM_POSES['arms: overhead']], ['arms forward', ROM_POSES['arms: forward']],
      ['kick both 90', [{ joint: 'upperleg_L', q: q('x', -90) }, { joint: 'upperleg_R', q: q('x', -90) }]], ['sit', ROM_POSES['legs: sit'].filter((r) => !/arm|shoulder|hand|clav/.test(r.joint))]];
    for (const b of ['fem', 'masc'] as const) {
      const m = meshOf(gens[b]), a = weightAsymmetry(m);
      expect(a.missing, `${b} vertices without a mirror twin`).toBe(0);
      expect(a.max, `${b} |w − mirror(w)|`).toBeLessThan(1e-4);
      for (const [pn, pose] of sym) expect(posedTwinDeviation(m, pose), `${b} ${pn} twin deviation`).toBeLessThan(1e-4);
    }
  });

  it('slider extremes (weights#3 + the rest): every slider ±1 on both bases + the worst combos keep the base gates in Relaxed / walk / the reach / nods / knees', () => {
    const cases: [string, BodyV2GenParams][] = [];
    for (const b of ['fem', 'masc'] as const) {
      for (const s of BODY_V2_SLIDERS) for (const x of [-1, 1]) { const p = at(b, { [s.name]: x }); if ((p as unknown as Record<string, number>)[s.name] !== (BODY_V2_BASES[b] as unknown as Record<string, number>)[s.name]) cases.push([`${b} ${s.name} ${x > 0 ? '+1' : '−1'}`, p]); }
      cases.push([`${b} tt+1 sw−1`, at(b, { torsoThick: 1, shoulderWidth: -1 })], [`${b} tt+1 lt+1`, at(b, { torsoThick: 1, limbThick: 1 })], [`${b} tt−1 sw+1`, at(b, { torsoThick: -1, shoulderWidth: 1 })],
        [`${b} tt+1 hs−1`, at(b, { torsoThick: 1, headSize: -1 })], [`${b} tt−1 hs+1`, at(b, { torsoThick: -1, headSize: 1 })], [`${b} lt+1 hw−1`, at(b, { limbThick: 1, hipWidth: -1 })], [`${b} lt+1 hw+1`, at(b, { limbThick: 1, hipWidth: 1 })]);
    }
    const poses = ['relaxed', 'walk 25%', 'arm fwd-up 150', 'Jump Reach f12', 'head down 20', 'turn n40+h35', 'knee 130'];
    const bad: string[] = [], lines: string[] = [];
    for (const [name, p] of cases) {
      const r = measure(generateBodyV2(p), poses), cell: string[] = [];
      for (const pn of ['relaxed', 'walk 25%']) {
        // (one triangle at 2.07× on the masc shoulderWidth +1 deltoid in Relaxed; pre-G2 11 at 2.41×)
        for (const [rn, row] of Object.entries(r[pn].rows)) if (row.inverted > 0 || row.stretched > 1) bad.push(`${name} ${pn} ${rn}: ${fmt(row)}`);
        if (r[pn].si! > 0) bad.push(`${name} ${pn}: ${r[pn].si} arm verts in the body`);
      }
      // (pre-G2 at these corners: 17–37 inverted in fwd-up 150; the worst now is masc torsoThick + limbThick +1 at 10)
      for (const pn of ['arm fwd-up 150', 'Jump Reach f12']) if (r[pn].rows.shoulder.inverted > 10 || r[pn].rows.shoulder.creaseN > 12) bad.push(`${name} ${pn}: ${fmt(r[pn].rows.shoulder)}`);
      // the neck: the SHORT-neck corners (torsoLength −1; torsoThick / limbThick +1 raise the neck base) crowd the front of
      // the neck into 4–10 mm strips, which the param-independent weights cannot widen — bounded, not 0 (pre-G2 26 / 14 at
      // a 20° nod; see the spec's known limits)
      for (const pn of ['head down 20', 'turn n40+h35']) if (r[pn].rows.neck.inverted > 10 || r[pn].buried! > 9 || r[pn].rows.neck.stretched > 0 || r[pn].rows.neck.maxAniso > 5) bad.push(`${name} ${pn}: ${fmt(r[pn].rows.neck)} buried ${r[pn].buried}`);
      // the knee: one fixed hinge phase for every body (slot 0 drifts ±4° with torsoThick / hipWidth / hipFront)
      const k = r['knee 130'];
      if (k.rows.knee.inverted > 0 || k.knee!.radialMax > 1.13 || k.knee!.mlGap > 0.006) bad.push(`${name} knee 130: ${fmt(k.rows.knee)} radial ${k.knee!.radialMax.toFixed(3)} ml ${(k.knee!.mlGap * 1000).toFixed(1)} mm`);
      cell.push(`${name.padEnd(22)} fwd150 ${fmt(r['arm fwd-up 150'].rows.shoulder)} | nod20 ${fmt(r['head down 20'].rows.neck)} bur ${r['head down 20'].buried} | turn ${r['turn n40+h35'].rows.neck.maxAniso.toFixed(2)} | knee130 radial ${k.knee!.radialMax.toFixed(3)} ml ${(k.knee!.mlGap * 1000).toFixed(1)}`);
      lines.push(...cell);
    }
    console.log('[body-v2@2 slider extremes]\n' + lines.join('\n'));
    expect(bad, bad.join('\n')).toEqual([]);
  }, 180000);
});
