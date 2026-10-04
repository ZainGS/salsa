import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { packDualQuatSkin, skinMatrixForTS, DQS_MARKER } from './dual-quat-skin';
import { generateBodyResult, BODY_POSES } from '../../services/managers/body-generator';
import { skinPositions, posedJointWorld, type SkinnedMeshData } from '../../services/managers/skin-deform-metrics';

const rigid = (axis: vec3, deg: number, t: vec3, s = 1) =>
  mat4.fromRotationTranslationScale(mat4.create(), quat.setAxisAngle(quat.create(), axis, (deg * Math.PI) / 180), t, [s, s, s]) as Float32Array;

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => {
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
};

describe('dual-quaternion skinning (audit 2026-09-28 C1 Phase 3)', () => {
  it('packs a rigid (+uniform scale) matrix and decodes it back exactly (single influence)', () => {
    const m = rigid(vec3.normalize(vec3.create(), [1, 2, 3]), 70, [0.3, -1.2, 2], 1.7);
    const packed = packDualQuatSkin(m)!;
    expect(packed).not.toBeNull();
    expect(packed[15]).toBe(DQS_MARKER);
    close(skinMatrixForTS(packed, [0, 0, 0, 0], [1, 0, 0, 0]), m, 1e-5);
  });

  it('plain matrices still blend LINEARLY (m[3][3] = 1 → the old path, unchanged)', () => {
    const a = rigid([0, 0, 1], 0, [0, 0, 0]), b = rigid([0, 0, 1], 90, [1, 0, 0]);
    const buf = new Float32Array([...a, ...b]);
    const got = skinMatrixForTS(buf, [0, 1, 0, 0], [0.5, 0.5, 0, 0]);
    const want = new Float32Array(16);
    for (let e = 0; e < 16; e++) want[e] = 0.5 * a[e] + 0.5 * b[e];
    close(got, want);
  });

  it('refuses non-uniform scale or shear (caller falls back to linear for that frame)', () => {
    const ns = mat4.fromRotationTranslationScale(mat4.create(), quat.create(), [0, 0, 0], [1, 2, 1]) as Float32Array;
    expect(packDualQuatSkin(ns)).toBeNull();
    const shear = mat4.create() as Float32Array; shear[4] = 0.5;   // col1 leans into col0
    expect(packDualQuatSkin(shear)).toBeNull();
  });

  it('a 50/50 blend of 0° and 90° keeps its SCALE (rigid) — the whole point; linear shrinks it', () => {
    const a = rigid([0, 0, 1], 0, [0, 0, 0]), b = rigid([0, 0, 1], 90, [0, 0, 0]);
    const plain = new Float32Array([...a, ...b]);
    const lbs = skinMatrixForTS(plain, [0, 1, 0, 0], [0.5, 0.5, 0, 0]);
    const dqs = skinMatrixForTS(packDualQuatSkin(plain)!, [0, 1, 0, 0], [0.5, 0.5, 0, 0]);
    const colLen = (m: Float32Array) => Math.hypot(m[0], m[1], m[2]);
    expect(colLen(lbs)).toBeCloseTo(Math.SQRT1_2, 4);           // LBS: 0.707 — the volume loss
    expect(colLen(dqs)).toBeCloseTo(1, 5);                      // DQS: stays 1
  });

  it('the shader mirror agrees with the independent CPU DQS in skin-deform-metrics on the real posed body', () => {
    const r = generateBodyResult({ seamBlend: 0.5 });
    const m: SkinnedMeshData = {
      vertices: r.geometry.vertices, stride: 12, posOffset: 0, indices: r.geometry.indices,
      jointIndices: r.skinning.jointIndices, jointWeights: r.skinning.jointWeights, jointNames: r.skinning.jointNames,
      jointParents: r.skinning.jointParents!, jointLocalPositions: r.skinning.jointLocalPositions!,
      inverseBindMatrices: r.skinning.inverseBindMatrices,
    };
    const pose = BODY_POSES['Relaxed'] as never;
    const reference = skinPositions(m, pose, 'dqs');
    // Build the skin buffer the renderer would upload, pack it, and skin every vertex through the shader mirror.
    const world = posedJointWorld(m, pose);
    const skin = new Float32Array(world.length * 16);
    world.forEach((w, j) => skin.set(mat4.multiply(mat4.create(), w, m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4), j * 16));
    const packed = packDualQuatSkin(skin)!;
    let maxErr = 0;
    const n = m.vertices.length / 12;
    for (let i = 0; i < n; i++) {
      const sm = skinMatrixForTS(packed, m.jointIndices.subarray(i * 4, i * 4 + 4), m.jointWeights.subarray(i * 4, i * 4 + 4));
      const p = vec3.transformMat4(vec3.create(), [m.vertices[i * 12], m.vertices[i * 12 + 1], m.vertices[i * 12 + 2]], sm as unknown as mat4);
      for (let c = 0; c < 3; c++) maxErr = Math.max(maxErr, Math.abs(p[c] - reference[i * 3 + c]));
    }
    expect(maxErr).toBeLessThan(1e-4);
  });
});
