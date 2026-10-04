/**
 * Clothing + hair MEASURED audit (2026-09-28) — runs only with AUDIT_OUT=<file> (it's a report, not a gate):
 *   AUDIT_OUT=out.txt npx vitest run src/services/managers/clothing-hair-audit.test.ts
 *
 * Poses a real generated body + its garments + hair on the CPU through the SAME skinning math the GPU uses
 * (skinMatrixForTS — verified against an independent CPU dual-quat implementation), then measures:
 *   • CLOTHING poke-through — body vertices covered by a garment at rest (inside it) that end up OUTSIDE it (> 3 mm)
 *     when posed. That's skin showing through the fabric.
 *   • HAIR penetration — head-skinned (rigid) hair vertices that end up > 4 mm INSIDE the torso / shoulders / arms
 *     when the head turns, tilts or looks down.
 * For both the NEW-character config (seamBlend 0.5 + dual quaternion) and the CLASSIC one (0 + linear).
 */
import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { generateBodyResult, BODY_POSES } from './body-generator';
import { buildBodyFitFrom } from './scene3d-character';
import {
  generateTop, generateBottom, generateShoe, generateSock, generateUndershirt, generateUnderpants,
  clothingPresetNames, clothingPreset, type BodyFit,
} from './clothing-generator';
import { generateHair, DEFAULT_HAIR_PARAMS, type HeadFrame, type HairParams } from './hair-generator';
import { posedJointWorld, type SkinnedMeshData, type PoseRotations } from './skin-deform-metrics';
import { packDualQuatSkin, skinMatrixForTS } from '../../renderer/3d/dual-quat-skin';

const OUT = process.env.AUDIT_OUT;
const q = (axis: 'x' | 'y' | 'z', deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360, s = Math.sin(h);
  return [axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0, Math.cos(h)];
};
const POSES: Record<string, PoseRotations> = {
  rest: [],
  Relaxed: BODY_POSES['Relaxed'] as unknown as PoseRotations,
  'A-pose': BODY_POSES['A-pose'] as unknown as PoseRotations,
  armsUp: [{ joint: 'shoulder_L', q: q('z', 70) }, { joint: 'shoulder_R', q: q('z', -70) }],
  elbow90: [...(BODY_POSES['Relaxed'] as unknown as PoseRotations), { joint: 'lowerarm_L', q: q('y', 90) }, { joint: 'lowerarm_R', q: q('y', -90) }],
  walk: [{ joint: 'upperleg_L', q: q('x', -30) }, { joint: 'upperleg_R', q: q('x', 25) }, { joint: 'lowerleg_R', q: q('x', 35) }],
  sit: [{ joint: 'upperleg_L', q: q('x', -90) }, { joint: 'upperleg_R', q: q('x', -90) },
        { joint: 'lowerleg_L', q: q('x', 90) }, { joint: 'lowerleg_R', q: q('x', 90) }],
  twist: [{ joint: 'spine', q: q('y', 35) }, { joint: 'chest', q: q('y', 20) }],
  // head poses (hair)
  lookL: [{ joint: 'head', q: q('y', 60) }], lookR: [{ joint: 'head', q: q('y', -60) }],
  lookDown: [{ joint: 'head', q: q('x', 30) }, { joint: 'neck', q: q('x', 15) }],
  tiltL: [{ joint: 'head', q: q('z', 25) }], tiltR: [{ joint: 'head', q: q('z', -25) }],
};

type Cfg = { label: string; seamBlend: number; method: 'linear' | 'dualQuat' };
const CONFIGS: Cfg[] = [{ label: 'NEW (seam 0.5 + DQS)', seamBlend: 0.5, method: 'dualQuat' }, { label: 'CLASSIC', seamBlend: 0, method: 'linear' }];

function bodyFor(cfg: Cfg) {
  const r = generateBodyResult({ seamBlend: cfg.seamBlend });
  const m: SkinnedMeshData = {
    vertices: r.geometry.vertices, stride: 12, posOffset: 0, indices: r.geometry.indices,
    jointIndices: r.skinning.jointIndices, jointWeights: r.skinning.jointWeights, jointNames: r.skinning.jointNames,
    jointParents: r.skinning.jointParents!, jointLocalPositions: r.skinning.jointLocalPositions!,
    inverseBindMatrices: r.skinning.inverseBindMatrices,
  };
  const fit: BodyFit = buildBodyFitFrom({
    verts: r.geometry.vertices, ji: r.skinning.jointIndices, jw: r.skinning.jointWeights,
    joints: r.skinning.jointNames.map((name, i) => ({ index: i, name, parentIndex: r.skinning.jointParents![i],
      inverseBindMatrix: r.skinning.inverseBindMatrices.subarray(i * 16, i * 16 + 16) })),
    armSurface: r.armSurface, legSurface: r.legSurface, torsoSurface: r.torsoSurface,
  });
  return { r, m, fit };
}

/** Skin positions + normals of an arbitrary mesh bound to the body skeleton, exactly as the GPU would. */
function skinAll(m: SkinnedMeshData, verts: Float32Array, ji: ArrayLike<number>, jw: ArrayLike<number>, pose: PoseRotations, method: Cfg['method']) {
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
    const nx = sm[0] * nn[0] + sm[4] * nn[1] + sm[8] * nn[2], ny = sm[1] * nn[0] + sm[5] * nn[1] + sm[9] * nn[2], nz = sm[2] * nn[0] + sm[6] * nn[1] + sm[10] * nn[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    P.set(p, i * 3); N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l;
  }
  return { P, N };
}

/** Spatial hash for nearest-point queries. */
function grid(P: Float32Array, cell = 0.03) {
  const map = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < P.length / 3; i++) { const k = key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); }
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

function garments(fit: BodyFit): { name: string; g: { geometry: { vertices: Float32Array }; jointIndices: Uint8Array; jointWeights: Float32Array } }[] {
  const out: ReturnType<typeof garments> = [];
  const safe = (name: string, f: () => any) => { try { const g = f(); if (g?.geometry?.vertices?.length) out.push({ name, g }); } catch (e) { out.push({ name: `${name} (THREW: ${(e as Error).message})`, g: null as never }); } };
  for (const n of clothingPresetNames('top')) safe(`top:${n}`, () => generateTop(fit, clothingPreset('top', n) as never));
  for (const n of clothingPresetNames('bottom')) safe(`bottom:${n}`, () => generateBottom(fit, clothingPreset('bottom', n) as never));
  for (const n of clothingPresetNames('shoes')) safe(`shoes:${n}`, () => generateShoe(fit, clothingPreset('shoes', n) as never));
  for (const n of clothingPresetNames('socks')) safe(`socks:${n}`, () => generateSock(fit, clothingPreset('socks', n) as never));
  for (const n of clothingPresetNames('undershirt')) safe(`undershirt:${n}`, () => generateUndershirt(fit, clothingPreset('undershirt', n) as never));
  for (const n of clothingPresetNames('underpants')) safe(`underpants:${n}`, () => generateUnderpants(fit, clothingPreset('underpants', n) as never));
  return out;
}

describe.skipIf(!OUT)('clothing + hair measured audit', () => {
  it('writes the report', async () => {
    const rows: string[] = [];
    const clothPoses = ['rest', 'Relaxed', 'A-pose', 'armsUp', 'elbow90', 'walk', 'sit', 'twist'];
    for (const cfg of CONFIGS) {
      const { r, m, fit } = bodyFor(cfg);
      rows.push(`\n=== CLOTHING — ${cfg.label} — cells: poke-through verts (% of covered) / max depth mm ===`);
      rows.push(`${'garment'.padEnd(28)}${'covered'.padStart(8)}  ${clothPoses.map((p) => p.padStart(13)).join('')}`);
      const bodyRest = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, [], cfg.method);
      for (const { name, g } of garments(fit)) {
        if (!g) { rows.push(name); continue; }
        const gv = g.geometry.vertices;
        const gRest = skinAll(m, gv, g.jointIndices, g.jointWeights, [], cfg.method);
        const near = grid(gRest.P);
        // covered body verts: a garment vert within 4 cm and the body is INSIDE it at rest
        const covered: { b: number; gi: number }[] = [];
        for (let b = 0; b < bodyRest.P.length / 3; b++) {
          const [x, y, z] = [bodyRest.P[b * 3], bodyRest.P[b * 3 + 1], bodyRest.P[b * 3 + 2]];
          const gi = near(x, y, z, 0.04); if (gi < 0) continue;
          const d = (x - gRest.P[gi * 3]) * gRest.N[gi * 3] + (y - gRest.P[gi * 3 + 1]) * gRest.N[gi * 3 + 1] + (z - gRest.P[gi * 3 + 2]) * gRest.N[gi * 3 + 2];
          if (d < 0) covered.push({ b, gi });
        }
        const cells: string[] = [];
        for (const pn of clothPoses) {
          const pb = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, POSES[pn], cfg.method);
          const pg = skinAll(m, gv, g.jointIndices, g.jointWeights, POSES[pn], cfg.method);
          const nearP = grid(pg.P);
          let poke = 0, maxD = 0;
          for (const { b } of covered) {
            const [x, y, z] = [pb.P[b * 3], pb.P[b * 3 + 1], pb.P[b * 3 + 2]];
            const gi = nearP(x, y, z, 0.06); if (gi < 0) continue;
            const d = (x - pg.P[gi * 3]) * pg.N[gi * 3] + (y - pg.P[gi * 3 + 1]) * pg.N[gi * 3 + 1] + (z - pg.P[gi * 3 + 2]) * pg.N[gi * 3 + 2];
            if (d > 0.003) { poke++; maxD = Math.max(maxD, d); }
          }
          const pct = covered.length ? (100 * poke / covered.length).toFixed(0) : '-';
          cells.push(`${poke}(${pct}%)/${(maxD * 1000).toFixed(0)}`.padStart(13));
        }
        rows.push(`${name.slice(0, 27).padEnd(28)}${String(covered.length).padStart(8)}  ${cells.join('')}`);
      }

      // ── HAIR ──
      const headIdx = r.skinning.jointNames.indexOf('head');
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < r.geometry.vertices.length / 12; i++) {
        let dom = 0, bw = -1;
        for (let k = 0; k < 4; k++) if (m.jointWeights[i * 4 + k] > bw) { bw = m.jointWeights[i * 4 + k]; dom = m.jointIndices[i * 4 + k]; }
        if (dom !== headIdx || bw <= 0.5) continue;
        for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], r.geometry.vertices[i * 12 + c]); mx[c] = Math.max(mx[c], r.geometry.vertices[i * 12 + c]); }
      }
      const head: HeadFrame = { cx: (mn[0] + mx[0]) / 2, cy: (mn[1] + mx[1]) / 2, cz: (mn[2] + mx[2]) / 2, rx: (mx[0] - mn[0]) / 2, ry: (mx[1] - mn[1]) / 2, rz: (mx[2] - mn[2]) / 2 };
      const hairPoses = ['rest', 'lookL', 'lookR', 'lookDown', 'tiltL', 'tiltR', 'Relaxed'];
      const styles: Record<string, Partial<HairParams>> = {
        'twintails (default)': {},
        'long scalp, no tails': { tailStyle: 'none' as never, scalpLength: 1, lengthBack: 1.6, lengthSide: 1.3 },
        'bob': { tailStyle: 'none' as never, scalpLength: 0.6, lengthBack: 0.8, lengthSide: 0.8 },
        'long to shoulders': { tailStyle: 'none' as never, scalpLength: 1, lengthBack: 3, lengthSide: 3, lengthFront: 1 },
        'front drape': { frontDrape: 1 },
      };
      rows.push(`\n=== HAIR — ${cfg.label} — cells: rigid hair verts inside the body (> 4 mm) / max depth mm ===`);
      rows.push(`${'style'.padEnd(24)}${'rigid'.padStart(7)}  ${hairPoses.map((p) => p.padStart(11)).join('')}`);
      // body verts that hair must not enter: everything NOT on the head/neck
      const neckIdx = r.skinning.jointNames.indexOf('neck');
      for (const [sn, sp] of Object.entries(styles)) {
        let res;
        try { res = generateHair(head, { ...DEFAULT_HAIR_PARAMS, ...sp }, r.geometry.vertices); }
        catch (e) { rows.push(`${sn}: THREW ${(e as Error).message}`); continue; }
        const hv = res.geometry.vertices, hn = hv.length / 12;
        const ji = new Uint8Array(hn * 4), jw = new Float32Array(hn * 4);
        const rigid: number[] = [];
        for (let i = 0; i < hn; i++) { ji[i * 4] = headIdx; jw[i * 4] = 1; if (res.tailVertId[i] < 0) rigid.push(i); }
        const cells: string[] = [];
        for (const pn of hairPoses) {
          const pb = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, POSES[pn], cfg.method);
          const ph = skinAll(m, hv, ji, jw, POSES[pn], cfg.method);
          const near = grid(pb.P);
          let inside = 0, maxD = 0;
          for (const i of rigid) {
            const [x, y, z] = [ph.P[i * 3], ph.P[i * 3 + 1], ph.P[i * 3 + 2]];
            const b = near(x, y, z, 0.05); if (b < 0) continue;
            let dom = 0, bw = -1;
            for (let k = 0; k < 4; k++) if (m.jointWeights[b * 4 + k] > bw) { bw = m.jointWeights[b * 4 + k]; dom = m.jointIndices[b * 4 + k]; }
            if (dom === headIdx || dom === neckIdx) continue;                  // hair on the head/neck is expected
            const d = (x - pb.P[b * 3]) * pb.N[b * 3] + (y - pb.P[b * 3 + 1]) * pb.N[b * 3 + 1] + (z - pb.P[b * 3 + 2]) * pb.N[b * 3 + 2];
            if (d < -0.004) { inside++; maxD = Math.max(maxD, -d); }
          }
          cells.push(`${inside}/${(maxD * 1000).toFixed(0)}`.padStart(11));
        }
        rows.push(`${sn.padEnd(24)}${String(rigid.length).padStart(7)}  ${cells.join('')}`);
      }
    }
    (await import('node:fs')).writeFileSync(OUT!, rows.join('\n'));
    expect(rows.length).toBeGreaterThan(4);
  }, 300_000);
});

describe.skipIf(!process.env.AUDIT_DRILL)('drill-down', () => {
  it('pants poke-through by body joint + hair reach', async () => {
    const rows: string[] = [];
    const cfg = CONFIGS[0];
    const { r, m, fit } = bodyFor(cfg);
    const names = r.skinning.jointNames;
    const dom = (w: ArrayLike<number>, j: ArrayLike<number>, i: number) => { let d = 0, bw = -1; for (let k = 0; k < 4; k++) if (w[i * 4 + k] > bw) { bw = w[i * 4 + k]; d = j[i * 4 + k]; } return d; };
    for (const gname of ['Pants', 'Shorts']) {
      const g = generateBottom(fit, clothingPreset('bottom', gname) as never);
      const gv = g.geometry.vertices;
      const bodyRest = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, [], cfg.method);
      const gRest = skinAll(m, gv, g.jointIndices, g.jointWeights, [], cfg.method);
      const near = grid(gRest.P);
      const covered: { b: number; gi: number }[] = [];
      for (let b = 0; b < bodyRest.P.length / 3; b++) {
        const gi = near(bodyRest.P[b * 3], bodyRest.P[b * 3 + 1], bodyRest.P[b * 3 + 2], 0.04); if (gi < 0) continue;
        const d = (bodyRest.P[b * 3] - gRest.P[gi * 3]) * gRest.N[gi * 3] + (bodyRest.P[b * 3 + 1] - gRest.P[gi * 3 + 1]) * gRest.N[gi * 3 + 1] + (bodyRest.P[b * 3 + 2] - gRest.P[gi * 3 + 2]) * gRest.N[gi * 3 + 2];
        if (d < 0) covered.push({ b, gi });
      }
      for (const pn of ['walk', 'sit']) {
        const pb = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, POSES[pn], cfg.method);
        const pg = skinAll(m, gv, g.jointIndices, g.jointWeights, POSES[pn], cfg.method);
        const nearP = grid(pg.P);
        const byJoint = new Map<string, number>(); const gJoint = new Map<string, number>(); const rest2posedPair = new Map<string, number>();
        for (const { b, gi } of covered) {
          const [x, y, z] = [pb.P[b * 3], pb.P[b * 3 + 1], pb.P[b * 3 + 2]];
          const g2 = nearP(x, y, z, 0.06); if (g2 < 0) continue;
          const d = (x - pg.P[g2 * 3]) * pg.N[g2 * 3] + (y - pg.P[g2 * 3 + 1]) * pg.N[g2 * 3 + 1] + (z - pg.P[g2 * 3 + 2]) * pg.N[g2 * 3 + 2];
          if (d <= 0.003) continue;
          const bj = names[dom(m.jointWeights, m.jointIndices, b)], gj = names[dom(g.jointWeights, g.jointIndices, gi)];
          byJoint.set(bj, (byJoint.get(bj) ?? 0) + 1);
          rest2posedPair.set(`body:${bj} <- garment(rest-nearest):${gj}`, (rest2posedPair.get(`body:${bj} <- garment(rest-nearest):${gj}`) ?? 0) + 1);
        }
        rows.push(`${gname} ${pn}: poking body verts by joint ${JSON.stringify(Object.fromEntries(byJoint))}`);
        rows.push(`   pairs ${JSON.stringify(Object.fromEntries(rest2posedPair))}`);
      }
      // garment weight summary
      const gw = new Map<string, number>();
      for (let i = 0; i < gv.length / 12; i++) { const k = names[dom(g.jointWeights, g.jointIndices, i)]; gw.set(k, (gw.get(k) ?? 0) + 1); }
      rows.push(`${gname} garment verts by dominant joint ${JSON.stringify(Object.fromEntries(gw))}`);
    }
    // hair reach
    const headIdx = names.indexOf('head');
    const wp = (nm: string) => { const i = names.indexOf(nm); const inv = mat4.invert(mat4.create(), r.skinning.inverseBindMatrices.subarray(i * 16, i * 16 + 16) as unknown as mat4); return [inv[12], inv[13], inv[14]]; };
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < r.geometry.vertices.length / 12; i++) { if (dom(m.jointWeights, m.jointIndices, i) !== headIdx) continue; for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], r.geometry.vertices[i * 12 + c]); mx[c] = Math.max(mx[c], r.geometry.vertices[i * 12 + c]); } }
    const head: HeadFrame = { cx: (mn[0] + mx[0]) / 2, cy: (mn[1] + mx[1]) / 2, cz: (mn[2] + mx[2]) / 2, rx: (mx[0] - mn[0]) / 2, ry: (mx[1] - mn[1]) / 2, rz: (mx[2] - mn[2]) / 2 };
    rows.push(`joint Y: head ${wp('head')[1].toFixed(3)} neck ${wp('neck')[1].toFixed(3)} chest ${wp('chest')[1].toFixed(3)} shoulder_L ${wp('shoulder_L')[1].toFixed(3)}`);
    for (const [sn, sp] of Object.entries({ 'long scalp': { tailStyle: 'none', scalpLength: 1, lengthBack: 1.6, lengthSide: 1.3 }, 'max long': { tailStyle: 'none', scalpLength: 1, lengthBack: 3, lengthSide: 3, lengthFront: 1 } })) {
      const res = generateHair(head, { ...DEFAULT_HAIR_PARAMS, ...(sp as object) }, r.geometry.vertices);
      let minY = Infinity, n = 0; for (let i = 0; i < res.geometry.vertices.length / 12; i++) { if (res.tailVertId[i] >= 0) continue; n++; minY = Math.min(minY, res.geometry.vertices[i * 12 + 1]); }
      rows.push(`hair ${sn}: rigid verts ${n}, lowest rigid hair Y ${minY.toFixed(3)}`);
    }
    (await import('node:fs')).writeFileSync(process.env.AUDIT_DRILL!, rows.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 300_000);
});

