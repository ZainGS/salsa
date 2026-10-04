/**
 * clothing-audit-harness.ts — pose a real procedural body + its garments/hair on the CPU and MEASURE how they hold up
 * (clothing/hair audit 2026-09-28). Test-support code shared by the audit reports and the clothing regression gate.
 *
 * Skinning goes through `skinMatrixForTS` — the TS mirror of the GPU's WGSL blend, verified against an independent CPU
 * dual-quaternion implementation — so what's measured is what the GPU draws.
 *
 * Two failure kinds:
 *   • POKE-THROUGH — body vertices covered by a garment at rest (inside it) that end up > 3 mm OUTSIDE it when posed.
 *   • TEAR — garment triangles that stretch > 2× their rest area ("stretched") or flip inside-out ("folded").
 */

import { mat4, vec3 } from 'gl-matrix';
import { generateBodyResult, BODY_POSES } from './body-generator';
import { buildBodyFitFrom } from './scene3d-character';
import {
  generateTop, generateBottom, generateShoe, generateSock, generateUndershirt, generateUnderpants,
  clothingPresetNames, clothingPreset, defaultUndershirtParams, defaultUnderpantsParams, type BodyFit,
} from './clothing-generator';
import { posedJointWorld, measureDeformation, type SkinnedMeshData, type PoseRotations } from './skin-deform-metrics';
import { packDualQuatSkin, skinMatrixForTS } from '../../renderer/3d/dual-quat-skin';

/** A rotation quaternion about one axis (body-generator convention: half-angle, [x,y,z,w]). */
export const q = (axis: 'x' | 'y' | 'z', deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360, s = Math.sin(h);
  return [axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0, Math.cos(h)];
};

export type AuditConfig = { label: string; seamBlend: number; method: 'linear' | 'dualQuat' };
/** NEW = what new characters get (seam blend 0.5 + dual quaternion); CLASSIC = saved characters (0 + linear). */
export const CONFIGS: AuditConfig[] = [
  { label: 'NEW (seam 0.5 + DQS)', seamBlend: 0.5, method: 'dualQuat' },
  { label: 'CLASSIC', seamBlend: 0, method: 'linear' },
];

/** A generated body + the BodyFit garments are fitted against. */
export function bodyFor(cfg: AuditConfig, shape: Partial<Parameters<typeof generateBodyResult>[0]> = {}) {
  const r = generateBodyResult({ ...shape, seamBlend: cfg.seamBlend });
  const m: SkinnedMeshData = {
    vertices: r.geometry.vertices, stride: 12, posOffset: 0, indices: r.geometry.indices,
    jointIndices: r.skinning.jointIndices, jointWeights: r.skinning.jointWeights, jointNames: r.skinning.jointNames,
    jointParents: r.skinning.jointParents!, jointLocalPositions: r.skinning.jointLocalPositions!,
    inverseBindMatrices: r.skinning.inverseBindMatrices,
  };
  const fit: BodyFit = buildBodyFitFrom({
    verts: r.geometry.vertices, ji: r.skinning.jointIndices, jw: r.skinning.jointWeights, indices: r.geometry.indices,
    joints: r.skinning.jointNames.map((name, i) => ({
      index: i, name, parentIndex: r.skinning.jointParents![i],
      inverseBindMatrix: r.skinning.inverseBindMatrices.subarray(i * 16, i * 16 + 16),
    })),
    armSurface: r.armSurface, legSurface: r.legSurface, torsoSurface: r.torsoSurface,
  });
  return { r, m, fit };
}

/** Skin positions + normals of a mesh bound to the body skeleton, exactly as the GPU would. */
export function skinAll(m: SkinnedMeshData, verts: Float32Array, ji: ArrayLike<number>, jw: ArrayLike<number>, pose: PoseRotations, method: AuditConfig['method']) {
  const world = posedJointWorld(m, pose);
  const skin = new Float32Array(world.length * 16);
  world.forEach((w, j) => skin.set(mat4.multiply(mat4.create(), w, m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4), j * 16));
  const buf = method === 'dualQuat' ? (packDualQuatSkin(skin) ?? skin) : skin;
  const n = verts.length / 12;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
  const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) { jj[k] = ji[i * 4 + k]; ww[k] = jw[i * 4 + k]; }
    const sm = skinMatrixForTS(buf, jj, ww) as unknown as mat4;
    const p = vec3.transformMat4(vec3.create(), [verts[i * 12], verts[i * 12 + 1], verts[i * 12 + 2]], sm);
    const nn = [verts[i * 12 + 3], verts[i * 12 + 4], verts[i * 12 + 5]];
    const nx = sm[0] * nn[0] + sm[4] * nn[1] + sm[8] * nn[2];
    const ny = sm[1] * nn[0] + sm[5] * nn[1] + sm[9] * nn[2];
    const nz = sm[2] * nn[0] + sm[6] * nn[1] + sm[10] * nn[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    P.set(p, i * 3); N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l;
  }
  return { P, N };
}

/** Spatial hash → nearest point within maxR (or -1). */
export function grid(P: Float32Array, cell = 0.03) {
  const map = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < P.length / 3; i++) {
    const k = key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i);
  }
  return (x: number, y: number, z: number, maxR: number): number => {
    let best = -1, bd = maxR * maxR;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell), rr = Math.ceil(maxR / cell);
    for (let a = -rr; a <= rr; a++) for (let b = -rr; b <= rr; b++) for (let c = -rr; c <= rr; c++) {
      for (const i of map.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
        const d = (P[i * 3] - x) ** 2 + (P[i * 3 + 1] - y) ** 2 + (P[i * 3 + 2] - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };
}

/** The joint with the largest weight on vertex i. */
export const dominant = (jw: ArrayLike<number>, ji: ArrayLike<number>, i: number): number => {
  let d = 0, bw = -1;
  for (let k = 0; k < 4; k++) if (jw[i * 4 + k] > bw) { bw = jw[i * 4 + k]; d = ji[i * 4 + k]; }
  return d;
};

// ── Pose library ──────────────────────────────────────────────────────────────────────────────────────────────────
// Conventions (body-generator qz/qx/qy): arm L raise = z+, arm L forward = y−, L elbow flex = y− (R mirrored);
// thigh forward = x−, knee bend = x+; torso forward = x+; leg L out to the side = z+.
const RELAX = BODY_POSES['Relaxed'] as unknown as PoseRotations;
const withRelax = (extra: PoseRotations): PoseRotations =>
  [...RELAX.filter((b) => !extra.some((e) => e.joint === b.joint)), ...extra];

/** Range-of-motion sweep — the poses a character will realistically be animated through. */
export const ROM_POSES: Record<string, PoseRotations> = {
  'arms: relaxed': RELAX,
  'arms: A-pose': BODY_POSES['A-pose'] as unknown as PoseRotations,
  'arms: up 45': [{ joint: 'shoulder_L', q: q('z', 45) }, { joint: 'shoulder_R', q: q('z', -45) }],
  'arms: overhead': [{ joint: 'shoulder_L', q: q('z', 80) }, { joint: 'shoulder_R', q: q('z', -80) }],
  'arms: forward': [{ joint: 'shoulder_L', q: q('y', -80) }, { joint: 'shoulder_R', q: q('y', 80) }],
  'arms: back': [{ joint: 'shoulder_L', q: q('y', 40) }, { joint: 'shoulder_R', q: q('y', -40) }],
  'arms: cross body': [{ joint: 'shoulder_L', q: q('y', -125) }, { joint: 'shoulder_R', q: q('y', 125) }],
  'elbows: flex 120': withRelax([{ joint: 'lowerarm_L', q: q('y', -120) }, { joint: 'lowerarm_R', q: q('y', 120) }]),
  'elbows: hug': [{ joint: 'shoulder_L', q: q('y', -70) }, { joint: 'shoulder_R', q: q('y', 70) },
    { joint: 'lowerarm_L', q: q('y', -100) }, { joint: 'lowerarm_R', q: q('y', 100) }],
  'legs: walk': withRelax([{ joint: 'upperleg_L', q: q('x', -30) }, { joint: 'upperleg_R', q: q('x', 25) }, { joint: 'lowerleg_R', q: q('x', 35) }]),
  'legs: run': withRelax([{ joint: 'upperleg_L', q: q('x', -60) }, { joint: 'lowerleg_L', q: q('x', 90) },
    { joint: 'upperleg_R', q: q('x', 40) }, { joint: 'lowerleg_R', q: q('x', 60) }]),
  'legs: kick forward': withRelax([{ joint: 'upperleg_L', q: q('x', -90) }]),
  'legs: kick back': withRelax([{ joint: 'upperleg_L', q: q('x', 40) }, { joint: 'lowerleg_L', q: q('x', 30) }]),
  'legs: side 45': withRelax([{ joint: 'upperleg_L', q: q('z', 45) }]),
  'legs: splits side': withRelax([{ joint: 'upperleg_L', q: q('z', 60) }, { joint: 'upperleg_R', q: q('z', -60) }]),
  'legs: knee 130': withRelax([{ joint: 'lowerleg_L', q: q('x', 130) }]),
  'legs: sit': withRelax([{ joint: 'upperleg_L', q: q('x', -90) }, { joint: 'upperleg_R', q: q('x', -90) },
    { joint: 'lowerleg_L', q: q('x', 90) }, { joint: 'lowerleg_R', q: q('x', 90) }]),
  'legs: squat': withRelax([{ joint: 'upperleg_L', q: q('x', -110) }, { joint: 'upperleg_R', q: q('x', -110) },
    { joint: 'lowerleg_L', q: q('x', 130) }, { joint: 'lowerleg_R', q: q('x', 130) }]),
  'legs: lunge': withRelax([{ joint: 'upperleg_L', q: q('x', -80) }, { joint: 'lowerleg_L', q: q('x', 80) },
    { joint: 'upperleg_R', q: q('x', 20) }, { joint: 'lowerleg_R', q: q('x', 90) }]),
  'torso: bend forward': withRelax([{ joint: 'lowerback', q: q('x', 20) }, { joint: 'spine', q: q('x', 25) }, { joint: 'chest', q: q('x', 15) }]),
  'torso: arch back': withRelax([{ joint: 'spine', q: q('x', -20) }, { joint: 'chest', q: q('x', -15) }]),
  'torso: side bend': withRelax([{ joint: 'spine', q: q('z', 20) }, { joint: 'chest', q: q('z', 15) }]),
  'torso: twist': withRelax([{ joint: 'spine', q: q('y', 35) }, { joint: 'chest', q: q('y', 20) }]),
  'combo: run + arm swing': [{ joint: 'shoulder_L', q: q('z', -70) }, { joint: 'shoulder_R', q: q('z', 70) },
    { joint: 'lowerarm_L', q: q('y', -80) }, { joint: 'lowerarm_R', q: q('y', 80) },
    { joint: 'upperleg_L', q: q('x', -60) }, { joint: 'lowerleg_L', q: q('x', 90) },
    { joint: 'upperleg_R', q: q('x', 40) }, { joint: 'lowerleg_R', q: q('x', 60) }],
  'combo: sit + lean': withRelax([{ joint: 'upperleg_L', q: q('x', -90) }, { joint: 'upperleg_R', q: q('x', -90) },
    { joint: 'lowerleg_L', q: q('x', 90) }, { joint: 'lowerleg_R', q: q('x', 90) }, { joint: 'spine', q: q('x', 25) }]),
  'combo: reach up + twist': [{ joint: 'shoulder_L', q: q('z', 80) }, { joint: 'shoulder_R', q: q('z', -80) }, { joint: 'spine', q: q('y', 30) }],
};

type GarmentBuild = (fit: BodyFit) => { geometry: { vertices: Float32Array; indices: Uint32Array }; jointIndices: Uint8Array; jointWeights: Float32Array };

/** Every garment preset in every clothing slot. */
export const ALL_GARMENTS: [string, GarmentBuild][] = [
  ...clothingPresetNames('top').map((n): [string, GarmentBuild] => [`top:${n}`, (f) => generateTop(f, clothingPreset('top', n) as never)]),
  ...clothingPresetNames('bottom').map((n): [string, GarmentBuild] => [`bottom:${n}`, (f) => generateBottom(f, clothingPreset('bottom', n) as never)]),
  // Base layers have no presets — measure their defaults.
  ['undershirt:default', (f) => generateUndershirt(f, defaultUndershirtParams())],
  ['underpants:default', (f) => generateUnderpants(f, defaultUnderpantsParams())],
  ...clothingPresetNames('shoes').map((n): [string, GarmentBuild] => [`shoes:${n}`, (f) => generateShoe(f, clothingPreset('shoes', n) as never)]),
  ...clothingPresetNames('socks').map((n): [string, GarmentBuild] => [`socks:${n}`, (f) => generateSock(f, clothingPreset('socks', n) as never)]),
];

export interface PoseResult {
  /** Body verts showing through the garment. */
  poke: number; pokePct: number; pokeMm: number;
  /** Garment triangles stretched > 2× rest area / flipped inside-out. */
  stretched: number; folded: number;
  /** The same, as % of the garment's triangles — and the SKIN's own % under this garment in this pose. A garment
   *  can't deform better than the skin it follows: garment% ≈ skin% = inherent to the pose, garment% ≫ skin% = a
   *  garment bug. */
  stretchPct: number; foldPct: number; skinStretchPct: number; skinFoldPct: number;
  /** Which body joints the poking skin belongs to (for diagnosis). */
  pokeByJoint: Record<string, number>;
}

/** Measure one garment across a pose set. */
export function measureGarment(build: GarmentBuild, poses: Record<string, PoseRotations>, cfg: AuditConfig = CONFIGS[0]) {
  const { r, m, fit } = bodyFor(cfg);
  const g = build(fit);
  const gv = g.geometry.vertices;
  const names = m.jointNames;
  const gm: SkinnedMeshData = { ...m, vertices: gv, indices: g.geometry.indices, jointIndices: g.jointIndices, jointWeights: g.jointWeights };
  const bodyRest = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, [], cfg.method);
  const gRest = skinAll(m, gv, g.jointIndices, g.jointWeights, [], cfg.method);
  const near = grid(gRest.P);
  const covered: number[] = [];
  for (let b = 0; b < bodyRest.P.length / 3; b++) {
    const gi = near(bodyRest.P[b * 3], bodyRest.P[b * 3 + 1], bodyRest.P[b * 3 + 2], 0.04); if (gi < 0) continue;
    const d = (bodyRest.P[b * 3] - gRest.P[gi * 3]) * gRest.N[gi * 3]
      + (bodyRest.P[b * 3 + 1] - gRest.P[gi * 3 + 1]) * gRest.N[gi * 3 + 1]
      + (bodyRest.P[b * 3 + 2] - gRest.P[gi * 3 + 2]) * gRest.N[gi * 3 + 2];
    if (d < 0) covered.push(b);
  }
  // The body region this garment covers = the joints dominating its covered skin.
  const regionJoints = [...new Set(covered.map((b) => names[dominant(m.jointWeights, m.jointIndices, b)]))];
  const gTris = g.geometry.indices.length / 3;
  const results: Record<string, PoseResult> = {};
  for (const [pn, pose] of Object.entries(poses)) {
    const pb = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, pose, cfg.method);
    const pg = skinAll(m, gv, g.jointIndices, g.jointWeights, pose, cfg.method);
    const nearP = grid(pg.P);
    let poke = 0, maxD = 0;
    const pokeByJoint: Record<string, number> = {};
    for (const b of covered) {
      const [x, y, z] = [pb.P[b * 3], pb.P[b * 3 + 1], pb.P[b * 3 + 2]];
      const gi = nearP(x, y, z, 0.06); if (gi < 0) continue;
      const d = (x - pg.P[gi * 3]) * pg.N[gi * 3] + (y - pg.P[gi * 3 + 1]) * pg.N[gi * 3 + 1] + (z - pg.P[gi * 3 + 2]) * pg.N[gi * 3 + 2];
      if (d > 0.003) {
        poke++; maxD = Math.max(maxD, d);
        const j = names[dominant(m.jointWeights, m.jointIndices, b)];
        pokeByJoint[j] = (pokeByJoint[j] ?? 0) + 1;
      }
    }
    const method = cfg.method === 'dualQuat' ? 'dqs' : 'lbs';
    const tear = measureDeformation(gm, pose, undefined, undefined, method);
    const skin = regionJoints.length ? measureDeformation(m, pose, regionJoints, undefined, method) : null;
    results[pn] = {
      poke, pokePct: covered.length ? (100 * poke) / covered.length : 0, pokeMm: maxD * 1000,
      stretched: tear.stretched, folded: tear.folded, pokeByJoint,
      stretchPct: (100 * tear.stretched) / gTris, foldPct: (100 * tear.folded) / gTris,
      skinStretchPct: skin && skin.tris ? (100 * skin.stretched) / skin.tris : 0,
      skinFoldPct: skin && skin.tris ? (100 * skin.folded) / skin.tris : 0,
    };
  }
  return { covered: covered.length, tris: g.geometry.indices.length / 3, results, garment: g, body: { r, m } };
}
