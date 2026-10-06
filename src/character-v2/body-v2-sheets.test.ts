/**
 * body-v2@2 CONTACT SHEETS (runs only with CHARV2_SHEETS=<dir>):
 *   CHARV2_SHEETS=out npx vitest run src/character-v2/body-v2-sheets.test.ts
 * Smooth-shaded (+ wireframe) renders, posed with dual-quaternion skinning exactly as the GPU does
 * (clothing-audit-harness.skinAll). yaw 0 = the FRONT, 90 = the left side. Files (see sheets.txt in the output):
 *   • stance_<base>.png        — Relaxed: v2@1 | v2@2 pairs, front / side / 3/4 / back;
 *   • upper_<base>.png (+_wire) — chest / shoulders close-up: v2@1 | v2@2, front / 3/4 / side / back;
 *   • tpose_<base>_wire.png    — the rest pose with the wireframe (edge loops, the arm socket);
 *   • deform_<group>.png       — the deformation poses: v1 new | v2@2 fem | v2@2 masc, zoomed on the joint.
 */
import { describe, it } from 'vitest';
import { BODY_POSES, generateBodyResult, NEW_BODY_DEFAULTS } from '../services/managers/body-generator';
import { skinAll } from '../services/managers/clothing-audit-harness';
import { posedJointWorld, type PoseRotations, type SkinnedMeshData } from '../services/managers/skin-deform-metrics';
import { generateBodyV2 } from './body-v2-generator';
import { BODY_V2_BASES, BODY_V2_AT1_BASES } from './body-v2-asset';
import { renderSheet, meshOf, bounds, type SheetView, type SheetMesh } from './body-v2-preview';
import { DEFORM_POSES } from './body-v2-poses';

const pose = (m: SkinnedMeshData, p: PoseRotations): SheetMesh => {
  const { P, N } = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, p, 'dualQuat');
  return { P, N, indices: m.indices };
};
/** Stand the posed mesh on y = 0 (the two generators' soles sit at different heights). */
const ground = (s: SheetMesh, dy?: number): SheetMesh => {
  const { lo } = bounds(s.P), d = dy ?? -lo, P = new Float32Array(s.P);
  for (let i = 1; i < P.length; i += 3) P[i] += d;
  return { ...s, P };
};

describe.skipIf(!process.env.CHARV2_SHEETS)('body-v2@2 sheets', () => {
  it('renders', async () => {
    const fs = await import('node:fs'), path = await import('node:path');
    const dir = process.env.CHARV2_SHEETS!; fs.mkdirSync(dir, { recursive: true });
    const relaxed = BODY_POSES['Relaxed'] as PoseRotations;
    const notes: string[] = [];
    for (const base of ['fem', 'masc'] as const) {
      const m1 = meshOf(generateBodyResult(BODY_V2_AT1_BASES[base])), m2 = meshOf(generateBodyV2(BODY_V2_BASES[base]));
      const a = ground(pose(m1, relaxed)), b = ground(pose(m2, relaxed));
      const { hi } = bounds(b.P), H = Math.max(hi, bounds(a.P).hi), cy = H / 2, h = H * 1.06;
      const full = (yaw: number, pitch = 0): SheetView => ({ label: '', yaw, pitch, cy, h });
      const tiles = [0, 90, 35, 180].flatMap((yaw) => [{ view: full(yaw, yaw === 35 ? 6 : 0), meshes: [a] }, { view: full(yaw, yaw === 35 ? 6 : 0), meshes: [b] }]);
      fs.writeFileSync(path.join(dir, `stance_${base}.png`), renderSheet(tiles, { tile: 330, cols: 4 }));
      const up = (yaw: number, pitch = 0): SheetView => ({ label: '', yaw, pitch, cy: H * 0.73, h: H * 0.40 });
      const ut = [0, -38, 90, 180].flatMap((yaw) => [{ view: up(yaw, yaw === -38 ? 8 : 0), meshes: [a] }, { view: up(yaw, yaw === -38 ? 8 : 0), meshes: [b] }]);
      fs.writeFileSync(path.join(dir, `upper_${base}.png`), renderSheet(ut, { tile: 360, cols: 4 }));
      fs.writeFileSync(path.join(dir, `upper_${base}_wire.png`), renderSheet(ut, { tile: 360, cols: 4, wire: true }));
      const t = ground(pose(m2, []));
      const tv = (yaw: number, pitch = 0): SheetView => ({ label: '', yaw, pitch, cy: H * 0.78, h: H * 0.42 });
      fs.writeFileSync(path.join(dir, `tpose_${base}_wire.png`), renderSheet([0, -40, 90, 180, 200, -90].map((yaw) => ({ view: tv(yaw, yaw === -40 ? 10 : yaw === 200 ? 20 : 0), meshes: [t] })), { tile: 380, cols: 3, wire: true }));
      const lower = (yaw: number, pitch = 0): SheetView => ({ label: '', yaw, pitch, cy: H * 0.45, h: H * 0.42 });
      fs.writeFileSync(path.join(dir, `lower_${base}.png`), renderSheet([0, 90, 35, 180].flatMap((yaw) => [{ view: lower(yaw), meshes: [a] }, { view: lower(yaw), meshes: [b] }]), { tile: 330, cols: 4 }));
      fs.writeFileSync(path.join(dir, `lower_${base}_wire.png`), renderSheet([0, 90, 35, 180].map((yaw) => ({ view: lower(yaw), meshes: [b] })), { tile: 400, cols: 4, wire: true }));
    }
    // Head / hands / feet close-ups (Relaxed): v2@1 | v2@2 per view, smooth + wire.
    for (const base of ['fem', 'masc'] as const) {
      const m1 = meshOf(generateBodyResult(BODY_V2_AT1_BASES[base])), m2 = meshOf(generateBodyV2(BODY_V2_BASES[base]));
      const a = ground(pose(m1, relaxed)), b = ground(pose(m2, relaxed));
      const at = (m: SkinnedMeshData, s: SheetMesh, jn: string) => { const w = posedJointWorld(m, relaxed)[m.jointNames.indexOf(jn)]; return [w[12], w[13] - bounds(pose(m, relaxed).P).lo, w[14]]; };
      const tile = (m: SkinnedMeshData, s: SheetMesh, jn: string, yaw: number, h: number, dy = 0, pitch = 0) => { const c = at(m, s, jn); return { view: { label: '', yaw, pitch, cx: c[0], cy: c[1] + dy, cz: c[2], h }, meshes: [s] }; };
      for (const wire of [false, true]) {
        const tiles = [0, 90, 35, 180].flatMap((yaw) => [tile(m1, a, 'head', yaw, 0.36, 0.02), tile(m2, b, 'head', yaw, 0.36, 0.02)]);
        fs.writeFileSync(path.join(dir, `head_${base}${wire ? '_wire' : ''}.png`), renderSheet(tiles, { tile: 320, cols: 4, wire }));
        const ht = [[0, 'hand_L'], [90, 'hand_L'], [-90, 'hand_L'], [0, 'foot_L'], [90, 'foot_L'], [200, 'foot_L']].flatMap(([yaw, jn]) =>
          [tile(m1, a, jn as string, yaw as number, 0.2, (jn as string).startsWith('foot') ? -0.03 : -0.05, 10), tile(m2, b, jn as string, yaw as number, 0.2, (jn as string).startsWith('foot') ? -0.03 : -0.05, 10)]);
        fs.writeFileSync(path.join(dir, `hands_feet_${base}${wire ? '_wire' : ''}.png`), renderSheet(ht, { tile: 280, cols: 4, wire }));
      }
    }
    notes.push('head_/hands_feet_<base>.png (+_wire): pairs v2@1 | v2@2; head front / side / 3/4 / back; hand front / out / in, foot front / side / back-3/4.');
    notes.push('stance_/upper_/lower_<base>.png: pairs = v2@1 (left) | v2@2 (right); views front, 3/4 or side, …, back.');
    // Deformation sheets: one row per pose = v1 new | v2@2 fem | v2@2 masc, zoomed on the bending joint (its posed
    // world position), plus a full-body tile of v2@2 fem for context.
    const bodies = [meshOf(generateBodyResult({ ...NEW_BODY_DEFAULTS })), meshOf(generateBodyV2(BODY_V2_BASES.fem)), meshOf(generateBodyV2(BODY_V2_BASES.masc))];
    type Row = [pose: string, joint: string, yaw: number, pitch: number, h: number];
    const groups: [string, Row[]][] = [
      ['arms', [['elbow 120', 'lowerarm_L', 30, 10, 0.32], ['arms overhead', 'shoulder_L', 20, 5, 0.38], ['arms forward', 'shoulder_L', 60, 10, 0.38], ['arms cross', 'shoulder_L', 20, 10, 0.4], ['relaxed', 'shoulder_L', 35, 8, 0.32]]],
      ['legs', [['knee 130', 'lowerleg_L', 75, 5, 0.4], ['squat', 'upperleg_L', 60, 10, 0.55], ['sit', 'upperleg_L', 70, 10, 0.5], ['side split', 'hips', 0, 0, 0.55], ['lunge', 'upperleg_L', 70, 5, 0.6], ['kick forward', 'upperleg_L', 70, 5, 0.5]]],
      ['gait', [['walk 25%', 'hips', 40, 6, 1.0], ['walk 50%', 'hips', 40, 6, 1.0], ['run 25%', 'hips', 40, 6, 1.0], ['run 60%', 'hips', 40, 6, 1.0], ['torso twist', 'chest', 30, 6, 0.6], ['head turn+nod', 'neck', 30, 6, 0.35]]],
    ];
    for (const [g, rows] of groups) for (const wire of [false, true]) {
      const tiles: { view: SheetView; meshes: SheetMesh[] }[] = [];
      for (const [pn, jn, yaw, pitch, hf] of rows) for (const m of bodies) {
        const p = DEFORM_POSES[pn](m), s = pose(m, p);
        const { lo } = bounds(s.P), H = bounds(ground(pose(m, relaxed)).P).hi;
        const jw = posedJointWorld(m, p)[m.jointNames.indexOf(jn)];
        tiles.push({ view: { label: pn, yaw, pitch, cx: hf >= 1 ? 0 : jw[12], cy: hf >= 1 ? H / 2 : jw[13] - lo, cz: hf >= 1 ? 0 : jw[14], h: H * hf }, meshes: [ground(s)] });
      }
      fs.writeFileSync(path.join(dir, `deform_${g}${wire ? '_wire' : ''}.png`), renderSheet(tiles, { tile: 300, cols: 3, wire }));
    }
    notes.push(`deform_<group>.png (+_wire): one row per pose = v1 new | v2@2 fem | v2@2 masc, zoomed on the joint. arms: ${groups[0][1].map((r) => r[0]).join(', ')}; legs: ${groups[1][1].map((r) => r[0]).join(', ')}; gait: ${groups[2][1].map((r) => r[0]).join(', ')}`);
    fs.writeFileSync(path.join(dir, 'sheets.txt'), notes.join('\n') + '\n');
  });
});
