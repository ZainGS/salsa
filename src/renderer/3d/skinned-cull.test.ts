import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { computeJointBindPositions, computeSkinnedCullRadii, skinnedWorldAABB } from './skinned-cull';

/** A little 3-joint chain (root → mid → tip along +Y) with a vertex cloud around it, 2 influences per vertex. */
function rig() {
  const bindWorld = [mat4.fromTranslation(mat4.create(), [0, 0, 0]), mat4.fromTranslation(mat4.create(), [0, 1, 0]),
    mat4.fromTranslation(mat4.create(), [0, 2, 0])];
  const inv = bindWorld.map((m) => mat4.invert(mat4.create(), m) as Float32Array);
  const verts: number[] = [], ji: number[] = [], jw: number[] = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 400; i++) {
    const y = rnd() * 2.4, x = (rnd() - 0.5) * 0.6, z = (rnd() - 0.5) * 0.6;
    verts.push(x, y, z, 0, 1, 0, 0, 0, 1, 0, 0, 1);   // 12-float stride: pos, normal, uv, tangent
    const a = Math.min(2, Math.floor(y)), b = Math.min(2, a + 1), t = Math.min(1, y - a);
    ji.push(a, b, 0, 0); jw.push(1 - t, t, 0, 0);
  }
  return { bindWorld, inv, verts, ji: new Uint8Array(ji), jw: new Float32Array(jw) };
}

const bp = (r: ReturnType<typeof rig>) => computeJointBindPositions(r.inv);

/** Pose: each joint rotated about a random axis, chained, with a root offset + uniform scale. */
function pose(r: ReturnType<typeof rig>, ang: number, rootT: [number, number, number], scale: number) {
  const world: mat4[] = [];
  for (let j = 0; j < 3; j++) {
    const q = quat.setAxisAngle(quat.create(), vec3.normalize(vec3.create(), [1, 0.3 * j, 0.5]), ang * (j + 1));
    const local = mat4.fromRotationTranslationScale(mat4.create(), q, j === 0 ? rootT : [0, 1, 0], j === 0 ? [scale, scale, scale] : [1, 1, 1]);
    world.push(j === 0 ? local : mat4.multiply(mat4.create(), world[j - 1], local));
  }
  const skin = new Float32Array(48);
  for (let j = 0; j < 3; j++) skin.set(mat4.multiply(mat4.create(), world[j], r.inv[j]) as Float32Array, j * 16);
  return skin;
}

function skinVert(r: ReturnType<typeof rig>, skin: Float32Array, v: number): [number, number, number] {
  const p = [r.verts[v * 12], r.verts[v * 12 + 1], r.verts[v * 12 + 2]];
  const out = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const w = r.jw[v * 4 + k]; if (!w) continue;
    const m = skin.subarray(r.ji[v * 4 + k] * 16);
    out[0] += w * (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]);
    out[1] += w * (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]);
    out[2] += w * (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
  }
  return out as [number, number, number];
}

describe('skinned cull bounds (R6.1)', () => {
  it('contains every linear-blend skinned vertex in arbitrary poses (no pad)', () => {
    const r = rig();
    const cr = computeSkinnedCullRadii(r.verts, 12, r.ji, r.jw, bp(r));
    const box = new Float64Array(6);
    for (const [ang, t, s] of [[0, [0, 0, 0], 1], [0.7, [3, -1, 2], 1], [-1.4, [0, 5, 0], 2.5], [2.9, [-4, 0, 1], 0.4]] as const) {
      const skin = pose(r, ang, t as [number, number, number], s);
      expect(skinnedWorldAABB(skin, bp(r), cr, null, 0, box)).toBe(true);
      for (let v = 0; v < r.verts.length / 12; v++) {
        const p = skinVert(r, skin, v);
        for (let a = 0; a < 3; a++) {
          expect(p[a]).toBeGreaterThanOrEqual(box[a] - 1e-4);
          expect(p[a]).toBeLessThanOrEqual(box[a + 3] + 1e-4);
        }
      }
    }
  });

  it('is reasonably tight at bind pose (not a scene-sized box)', () => {
    const r = rig();
    const cr = computeSkinnedCullRadii(r.verts, 12, r.ji, r.jw, bp(r));
    const box = new Float64Array(6);
    skinnedWorldAABB(pose(r, 0, [0, 0, 0], 1), bp(r), cr, null, 0, box);
    // The cloud spans y 0..2.4 and x/z ±0.3. A vertex blended between two joints must sit inside BOTH joints' balls,
    // so each end overshoots by up to one bone length (1) — loose, but a character-sized box, not a scene-sized one.
    expect(box[4] - box[1]).toBeLessThan(4.5);
    expect(box[3] - box[0]).toBeLessThan(2.5);
  });

  it('skips joints that influence nothing, and a NaN joint', () => {
    const r = rig();
    const jw = new Float32Array(r.jw), ji = new Uint8Array(r.ji);
    for (let v = 0; v < jw.length / 4; v++) { ji[v * 4] = 0; jw[v * 4] = 1; jw[v * 4 + 1] = 0; }   // all on joint 0
    const cr = computeSkinnedCullRadii(r.verts, 12, ji, jw, bp(r));
    expect(cr.radii[0]).toBeGreaterThan(0);
    expect(cr.radii[1]).toBe(-1);
    expect(cr.radii[2]).toBe(-1);
    expect(Array.from(cr.used)).toEqual([0]);
    const skin = pose(r, 0, [0, 0, 0], 1);
    skin[1 * 16 + 12] = NaN;   // unused joint blows up → ignored anyway
    const box = new Float64Array(6);
    expect(skinnedWorldAABB(skin, bp(r), cr, null, 0, box)).toBe(true);
    expect(box.every(Number.isFinite)).toBe(true);
    const none = computeSkinnedCullRadii([], 12, [], [], bp(r));
    expect(skinnedWorldAABB(skin, bp(r), none, null, 0, box)).toBe(false);
  });

  it('applies the model matrix and the relative pad', () => {
    const r = rig();
    const cr = computeSkinnedCullRadii(r.verts, 12, r.ji, r.jw, bp(r));
    const skin = pose(r, 0, [0, 0, 0], 1);
    const a = new Float64Array(6), b = new Float64Array(6), c = new Float64Array(6);
    skinnedWorldAABB(skin, bp(r), cr, null, 0, a);
    skinnedWorldAABB(skin, bp(r), cr, mat4.fromTranslation(mat4.create(), [10, 0, -5]) as Float32Array, 0, b);
    expect(b[0]).toBeCloseTo(a[0] + 10, 4); expect(b[5]).toBeCloseTo(a[5] - 5, 4);
    skinnedWorldAABB(skin, bp(r), cr, null, 0.1, c);
    const ext = Math.max(a[3] - a[0], a[4] - a[1], a[5] - a[2]);
    expect(c[1]).toBeCloseTo(a[1] - 0.1 * ext, 4);
    expect(c[4]).toBeCloseTo(a[4] + 0.1 * ext, 4);
  });
});
