/**
 * Phase 2 compatibility (docs/specs/character-v2.md "body-v2@2"): the v1 clothing generator fits garments on the v2@2
 * body through the same BodyFit it builds for v1 (body-fit.buildBodyFitFrom over the body + its armSurface /
 * legSurface / torsoSurface). Phase 2 authors the garment templates by running the v1 generator ONCE on this body.
 *   • every v1 garment slot builds on both v2@2 bases (finite, non-empty, skinned to the 20 joints);
 *   • poke-through (body skin > 3 mm outside the garment) and garment tears (> 2× stretch / folds) over the deformation
 *     poses, v2@2 vs the same garment on v1's new body (clothing-audit-harness.measureGarment) — reported + gated;
 *   • outfit sheets (CHARV2_SHEETS=<dir>): garments_<base>.png.
 */
import { describe, it, expect } from 'vitest';
import { buildBodyFitFrom } from '../services/managers/body-fit';
import {
  generateTop, generateBottom, generateShoe, generateSock, generateUndershirt, generateUnderpants, clothingPreset,
  defaultUndershirtParams, defaultUnderpantsParams, type BodyFit,
} from '../services/managers/clothing-generator';
import { skinAll, grid, dominant, measureGarment, CONFIGS } from '../services/managers/clothing-audit-harness';
import { measureDeformation, type SkinnedMeshData, type PoseRotations } from '../services/managers/skin-deform-metrics';
import { BODY_POSES } from '../services/managers/body-generator';
import { generateBodyV2, type BodyV2GenResult } from './body-v2-generator';
import { BODY_V2_BASES } from './body-v2-asset';
import { meshOf, renderSheet, bounds, type SheetMesh } from './body-v2-preview';
import { DEFORM_POSES } from './body-v2-poses';

type Built = { geometry: { vertices: Float32Array; indices: Uint32Array }; jointIndices: Uint8Array; jointWeights: Float32Array };
type Build = (f: BodyFit) => Built;
export const GARMENTS: [string, Build][] = [
  ['top:Tee', (f) => generateTop(f, clothingPreset('top', 'Tee') as never)],
  ['top:Long Sleeve', (f) => generateTop(f, clothingPreset('top', 'Long Sleeve') as never)],
  ['bottom:Skirt', (f) => generateBottom(f, clothingPreset('bottom', 'Skirt') as never)],
  ['bottom:Pants', (f) => generateBottom(f, clothingPreset('bottom', 'Pants') as never)],
  ['bottom:Skinny', (f) => generateBottom(f, clothingPreset('bottom', 'Skinny') as never)],
  ['undershirt:default', (f) => generateUndershirt(f, defaultUndershirtParams())],
  ['underpants:default', (f) => generateUnderpants(f, defaultUnderpantsParams())],
  ['socks:Knee High', (f) => generateSock(f, clothingPreset('socks', 'Knee High') as never)],
  ['shoes:Sneaker', (f) => generateShoe(f, clothingPreset('shoes', 'Sneaker') as never)],
];

/** The v1 BodyFit of a v2 body — exactly what clothing-audit-harness.bodyFor / Scene3DCharacter build for v1. */
export function v2BodyFit(r: BodyV2GenResult): BodyFit {
  return buildBodyFitFrom({
    verts: r.geometry.vertices, ji: r.skinning.jointIndices, jw: r.skinning.jointWeights, indices: r.geometry.indices,
    joints: r.skinning.jointNames.map((name, i) => ({ index: i, name, parentIndex: r.skinning.jointParents![i], inverseBindMatrix: r.skinning.inverseBindMatrices.subarray(i * 16, i * 16 + 16) })),
    armSurface: r.armSurface, legSurface: r.legSurface, torsoSurface: r.torsoSurface,
  });
}

/** clothing-audit-harness.measureGarment's measure, on any body (it builds v1's own body). */
function measureOn(m: SkinnedMeshData, g: Built, poses: Record<string, PoseRotations>) {
  const gv = g.geometry.vertices, names = m.jointNames;
  const gm: SkinnedMeshData = { ...m, vertices: gv, indices: g.geometry.indices, jointIndices: g.jointIndices, jointWeights: g.jointWeights };
  const bodyRest = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, [], 'dualQuat');
  const gRest = skinAll(m, gv, g.jointIndices, g.jointWeights, [], 'dualQuat');
  const near = grid(gRest.P);
  const covered: number[] = [];
  for (let b = 0; b < bodyRest.P.length / 3; b++) {
    const gi = near(bodyRest.P[b * 3], bodyRest.P[b * 3 + 1], bodyRest.P[b * 3 + 2], 0.04); if (gi < 0) continue;
    const d = (bodyRest.P[b * 3] - gRest.P[gi * 3]) * gRest.N[gi * 3] + (bodyRest.P[b * 3 + 1] - gRest.P[gi * 3 + 1]) * gRest.N[gi * 3 + 1] + (bodyRest.P[b * 3 + 2] - gRest.P[gi * 3 + 2]) * gRest.N[gi * 3 + 2];
    if (d < 0) covered.push(b);
  }
  const out: Record<string, { pokePct: number; stretchPct: number; foldPct: number }> = {};
  for (const [pn, pose] of Object.entries(poses)) {
    const pb = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
    const pg = skinAll(m, gv, g.jointIndices, g.jointWeights, pose, 'dualQuat');
    const nearP = grid(pg.P);
    let poke = 0;
    for (const b of covered) {
      const gi = nearP(pb.P[b * 3], pb.P[b * 3 + 1], pb.P[b * 3 + 2], 0.06); if (gi < 0) continue;
      const d = (pb.P[b * 3] - pg.P[gi * 3]) * pg.N[gi * 3] + (pb.P[b * 3 + 1] - pg.P[gi * 3 + 1]) * pg.N[gi * 3 + 1] + (pb.P[b * 3 + 2] - pg.P[gi * 3 + 2]) * pg.N[gi * 3 + 2];
      if (d > 0.003) poke++;
    }
    const tear = measureDeformation(gm, pose, undefined, undefined, 'dqs'), n = g.geometry.indices.length / 3;
    out[pn] = { pokePct: covered.length ? (100 * poke) / covered.length : 0, stretchPct: (100 * tear.stretched) / n, foldPct: (100 * tear.folded) / n };
  }
  void names; void dominant;
  return { covered: covered.length, out };
}

const POSES = ['relaxed', 'walk 25%', 'run 60%', 'sit', 'squat', 'arms overhead', 'arms forward', 'elbow 120', 'knee 130', 'lunge'] as const;

describe('Phase 2 compatibility — v1 garments on the v2@2 body', () => {
  const bodies = (['fem', 'masc'] as const).map((base) => { const r = generateBodyV2(BODY_V2_BASES[base]); return { base, r, m: meshOf(r), fit: v2BodyFit(r) }; });

  it('every garment slot builds on both bases (finite, skinned to the 20 joints)', () => {
    for (const { fit } of bodies) for (const [name, build] of GARMENTS) {
      const g = build(fit);
      expect(g.geometry.indices.length, name).toBeGreaterThan(0);
      for (const x of g.geometry.vertices) expect(Number.isFinite(x), name).toBe(true);
      for (const j of g.jointIndices) expect(j, name).toBeLessThan(20);
    }
  });

  it('pokes + tears over the deformation poses: v2@2 vs v1 (reported; mean poke ≤ max(v1 + 2, 5) %)', () => {
    const rows: string[] = [], bad: string[] = [];
    for (const [name, build] of GARMENTS) {
      const v1 = measureGarment(build, Object.fromEntries(POSES.map((p) => [p, DEFORM_POSES[p](meshOf(measureGarmentBody()))])), CONFIGS[0]);
      const v1Mean = POSES.reduce((s, p) => s + v1.results[p].pokePct, 0) / POSES.length;
      const v1Tear = POSES.reduce((s, p) => s + v1.results[p].stretchPct + v1.results[p].foldPct, 0) / POSES.length;
      const cells: string[] = [`${name.padEnd(20)} v1 poke ${v1Mean.toFixed(2)} % tear ${v1Tear.toFixed(2)} %`];
      for (const { base, m, fit } of bodies) {
        const g = build(fit), r = measureOn(m, g, Object.fromEntries(POSES.map((p) => [p, DEFORM_POSES[p](m)])));
        const mean = POSES.reduce((s, p) => s + r.out[p].pokePct, 0) / POSES.length;
        const tear = POSES.reduce((s, p) => s + r.out[p].stretchPct + r.out[p].foldPct, 0) / POSES.length;
        const worst = POSES.reduce((w, p) => (r.out[p].pokePct > r.out[w].pokePct ? p : w), POSES[0] as string);
        cells.push(`v2@2 ${base} poke ${mean.toFixed(2)} % (worst ${worst} ${r.out[worst].pokePct.toFixed(1)} %) tear ${tear.toFixed(2)} %`);
        // Gate: ≤ max(v1 + 2, 5) % mean poke. NB the measure counts skin 'outside' the NEAREST garment vertex, and with
        // the arms down that is often the sleeve's inner face beside the torso (hidden), so sleeved tops read high.
        if (mean > Math.max(v1Mean + 2, 5)) bad.push(`${name} on ${base}: ${mean.toFixed(2)} % vs v1 ${v1Mean.toFixed(2)} %`);
      }
      rows.push(cells.join(' | '));
    }
    console.log('[body-v2@2 garments]\n' + rows.join('\n'));
    expect(bad).toEqual([]);
  });

  it.skipIf(!process.env.CHARV2_SHEETS)('renders outfit sheets', async () => {
    const fs = await import('node:fs'), path = await import('node:path');
    const dir = process.env.CHARV2_SHEETS!; fs.mkdirSync(dir, { recursive: true });
    const outfits: Record<'fem' | 'masc', string[]> = {
      fem: ['top:Tee', 'bottom:Skirt', 'socks:Knee High', 'shoes:Sneaker'],
      masc: ['top:Tee', 'bottom:Pants', 'shoes:Sneaker'],
    };
    const COL: Record<string, [number, number, number]> = { top: [120, 150, 220], bottom: [90, 90, 105], socks: [40, 40, 48], shoes: [235, 235, 235], undershirt: [235, 235, 240], underpants: [200, 120, 150] };
    for (const { base, m, fit } of bodies) for (const set of [outfits[base], ['undershirt:default', 'underpants:default', 'socks:Knee High'], ['top:Long Sleeve', 'bottom:Skinny', 'shoes:Sneaker']]) {
      const gs = set.map((n) => ({ n, g: GARMENTS.find((x) => x[0] === n)![1](fit) }));
      const tiles: { view: { label: string; yaw: number; pitch?: number; cy: number; h: number }; meshes: SheetMesh[] }[] = [];
      for (const pn of ['relaxed', 'walk 25%', 'run 60%', 'sit', 'arms overhead'] as const) {
        const pose = DEFORM_POSES[pn](m);
        const body = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
        const lo = bounds(body.P).lo, sh = (P: Float32Array) => { const Q = new Float32Array(P); for (let i = 1; i < Q.length; i += 3) Q[i] -= lo; return Q; };
        const meshes: SheetMesh[] = [{ P: sh(body.P), N: body.N, indices: m.indices }];
        for (const { n, g } of gs) { const s = skinAll(m, g.geometry.vertices, g.jointIndices, g.jointWeights, pose, 'dualQuat'); meshes.push({ P: sh(s.P), N: s.N, indices: g.geometry.indices, color: COL[n.split(':')[0]] }); }
        const H = bounds(sh(body.P)).hi;
        for (const yaw of pn === 'relaxed' ? [0, 90, 35, 180] : [35]) tiles.push({ view: { label: pn, yaw, pitch: 6, cy: H / 2, h: H * 1.06 }, meshes });
      }
      const tag = set === outfits[base] ? 'outfit' : set[0].startsWith('under') ? 'baselayers' : 'longsleeve';
      fs.writeFileSync(path.join(dir, `garments_${base}_${tag}.png`), renderSheet(tiles, { tile: 300, cols: 4 }));
    }
  });
});

/** v1's new-body mesh (the one measureGarment fits on), for the v1 pose set's gait frames. */
import { generateBodyResult } from '../services/managers/body-generator';
function measureGarmentBody() { return generateBodyResult({ seamBlend: CONFIGS[0].seamBlend }); }   // = clothing-audit-harness.bodyFor(CONFIGS[0])
void BODY_POSES;
