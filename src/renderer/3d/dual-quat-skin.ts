/**
 * dual-quat-skin.ts — dual-quaternion skinning (DQS) support (audit 2026-09-28 C1 Phase 3).
 *
 * Linear blend skinning (LBS) averages joint MATRICES, and an average of two rotations is not a rotation — it shrinks,
 * which is why elbows/knees/hips lose volume and pinch when bent. DQS blends the joints' rotation+translation as dual
 * quaternions instead, which stays rigid: joints keep their volume (measured: collapsed triangles 24 → 9 on the default
 * body — docs/specs/character-skin-weights.md).
 *
 * ── How it rides the existing GPU buffer (no new binding / layout change) ──
 * A skeleton's skin buffer is `array<mat4x4<f32>>`, one per joint. In DQS mode each 16-float slot is PACKED as:
 *   col0 = real (rotation) quaternion (x,y,z,w) · col1 = dual quaternion · col2.x = uniform scale · col3.w = 2.0 MARKER
 * A real affine skin matrix always has col3.w (m[3][3]) = 1, so the shader tells the two apart per buffer — see
 * SKIN_BLEND_WGSL. The shared WGSL `skinMatrixFor` returns an ordinary mat4 either way, so every skinning call site
 * (body / clothes / hair, outline, shadow) is unchanged below it.
 *
 * DQS only represents rotation + translation + UNIFORM scale. If any joint's skin matrix has non-uniform scale or
 * shear, {@link packDualQuatSkin} returns null and the caller uploads plain matrices (linear) for that frame — correct,
 * just not volume-preserving.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

/** The col3.w marker value that flags a DQS-packed slot (a real affine matrix has 1 there). */
export const DQS_MARKER = 2;

export type SkinningMethod = 'linear' | 'dualQuat';

const _m = mat4.create(), _r = quat.create(), _t = vec3.create(), _s = vec3.create(), _tq = quat.create(), _d = quat.create();

/**
 * Pack a skeleton's column-major skin matrices (16 floats/joint) into the DQS layout. Returns null — meaning "upload
 * the plain matrices (linear)" — if any joint has non-uniform scale or shear. `out` is reused when it's the right size.
 */
export function packDualQuatSkin(matrices: Float32Array, out?: Float32Array): Float32Array | null {
  const n = matrices.length / 16;
  const dst = out && out.length === matrices.length ? out : new Float32Array(matrices.length);
  for (let j = 0; j < n; j++) {
    const o = j * 16;
    for (let k = 0; k < 16; k++) _m[k] = matrices[o + k];
    mat4.getScaling(_s, _m);
    const sx = _s[0], sy = _s[1], sz = _s[2];
    const tol = 1e-4 * Math.max(1e-8, Math.abs(sx));
    if (!(sx > 1e-8) || Math.abs(sx - sy) > tol || Math.abs(sx - sz) > tol) return null;   // non-uniform / degenerate
    // shear check: columns must stay orthogonal
    const c0 = [_m[0], _m[1], _m[2]], c1 = [_m[4], _m[5], _m[6]], c2 = [_m[8], _m[9], _m[10]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const orthoTol = 1e-4 * sx * sx;
    if (Math.abs(dot(c0, c1)) > orthoTol || Math.abs(dot(c0, c2)) > orthoTol || Math.abs(dot(c1, c2)) > orthoTol) return null;

    mat4.getRotation(_r, _m);
    quat.normalize(_r, _r);
    mat4.getTranslation(_t, _m);
    // dual = 0.5 · (t as a pure quaternion) · r
    quat.multiply(_d, quat.set(_tq, _t[0], _t[1], _t[2], 0), _r);
    dst.fill(0, o, o + 16);
    dst[o] = _r[0]; dst[o + 1] = _r[1]; dst[o + 2] = _r[2]; dst[o + 3] = _r[3];
    dst[o + 4] = 0.5 * _d[0]; dst[o + 5] = 0.5 * _d[1]; dst[o + 6] = 0.5 * _d[2]; dst[o + 7] = 0.5 * _d[3];
    dst[o + 8] = sx;
    dst[o + 15] = DQS_MARKER;
  }
  return dst;
}

/**
 * TypeScript MIRROR of the WGSL `skinMatrixFor` (SKIN_BLEND_WGSL) — same maths, line for line, so the shader's logic
 * is unit-testable (WGSL only compiles in the browser). Given a skin buffer (packed OR plain) and one vertex's 4
 * joints/weights, returns the blended skin matrix (column-major).
 */
export function skinMatrixForTS(buf: Float32Array, joints: ArrayLike<number>, weights: ArrayLike<number>): Float32Array {
  const slot = (j: number) => buf.subarray(joints[j] * 16, joints[j] * 16 + 16);
  const m0 = slot(0);
  const out = new Float32Array(16);
  if (m0[15] < 1.5) {                                          // plain affine matrices → linear blend
    for (let k = 0; k < 4; k++) { const m = slot(k); for (let e = 0; e < 16; e++) out[e] += weights[k] * m[e]; }
    return out;
  }
  const q0 = [m0[0], m0[1], m0[2], m0[3]];
  const r = [0, 0, 0, 0], d = [0, 0, 0, 0];
  let sc = 0;
  for (let k = 0; k < 4; k++) {
    const m = slot(k), w = weights[k];
    const dt = q0[0] * m[0] + q0[1] * m[1] + q0[2] * m[2] + q0[3] * m[3];
    const sw = k === 0 ? w : (dt < 0 ? -w : w);               // keep every rotation in q0's hemisphere
    for (let c = 0; c < 4; c++) { r[c] += sw * m[c]; d[c] += sw * m[4 + c]; }
    sc += w * m[8];
  }
  const len = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
  for (let c = 0; c < 4; c++) { r[c] /= len; d[c] /= len; }
  // t = 2 · (d · conj(r)).xyz
  const [ax, ay, az, aw] = d, [bx, by, bz, bw] = [-r[0], -r[1], -r[2], r[3]];
  const tx = 2 * (aw * bx + ax * bw + ay * bz - az * by);
  const ty = 2 * (aw * by - ax * bz + ay * bw + az * bx);
  const tz = 2 * (aw * bz + ax * by - ay * bx + az * bw);
  const [x, y, z, w] = r;
  out.set([
    (1 - 2 * (y * y + z * z)) * sc, (2 * (x * y + z * w)) * sc, (2 * (x * z - y * w)) * sc, 0,
    (2 * (x * y - z * w)) * sc, (1 - 2 * (x * x + z * z)) * sc, (2 * (y * z + x * w)) * sc, 0,
    (2 * (x * z + y * w)) * sc, (2 * (y * z - x * w)) * sc, (1 - 2 * (x * x + y * y)) * sc, 0,
    tx, ty, tz, 1,
  ]);
  return out;
}

/**
 * The ONE skinning blend used by every skinned shader (skinned mesh, outline/stencil, shadow) — audit C1 Phase 3. It
 * replaces six hand-copied `w.x*skinMatrices[j.x] + …` blocks, so a DQS body, its outline and its shadow can never
 * disagree. Requires a module-scope `skinMatrices: array<mat4x4<f32>>` storage binding (declared by each shader).
 * Mirrors {@link skinMatrixForTS}; keep the two in sync. (No backticks in these comments — this is a template literal.)
 */
export const SKIN_BLEND_WGSL = /* wgsl */`
fn skinQuatMul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
// Blend a vertex's 4 joints. Plain affine skin matrices (m[3][3] == 1) -> linear blend, exactly as before.
// DQS-packed slots (m[3][3] == 2: col0 = rotation quat, col1 = dual quat, col2.x = uniform scale) -> dual-quaternion
// blend, converted back to a mat4 so callers are identical in both modes.
fn skinMatrixFor(j: vec4<u32>, w: vec4<f32>) -> mat4x4<f32> {
  let m0 = skinMatrices[j.x];
  let m1 = skinMatrices[j.y];
  let m2 = skinMatrices[j.z];
  let m3 = skinMatrices[j.w];
  if (m0[3][3] < 1.5) {
    return w.x * m0 + w.y * m1 + w.z * m2 + w.w * m3;
  }
  let q0 = m0[0];
  let s1 = select(w.y, -w.y, dot(q0, m1[0]) < 0.0);
  let s2 = select(w.z, -w.z, dot(q0, m2[0]) < 0.0);
  let s3 = select(w.w, -w.w, dot(q0, m3[0]) < 0.0);
  var r = w.x * q0 + s1 * m1[0] + s2 * m2[0] + s3 * m3[0];
  var d = w.x * m0[1] + s1 * m1[1] + s2 * m2[1] + s3 * m3[1];
  let sc = w.x * m0[2].x + w.y * m1[2].x + w.z * m2[2].x + w.w * m3[2].x;
  let len = max(length(r), 1e-8);
  r = r / len;
  d = d / len;
  let t = 2.0 * skinQuatMul(d, vec4<f32>(-r.xyz, r.w)).xyz;
  let x = r.x; let y = r.y; let z = r.z; let qw = r.w;
  return mat4x4<f32>(
    vec4<f32>(vec3<f32>(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * qw), 2.0 * (x * z - y * qw)) * sc, 0.0),
    vec4<f32>(vec3<f32>(2.0 * (x * y - z * qw), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * qw)) * sc, 0.0),
    vec4<f32>(vec3<f32>(2.0 * (x * z + y * qw), 2.0 * (y * z - x * qw), 1.0 - 2.0 * (x * x + y * y)) * sc, 0.0),
    vec4<f32>(t, 1.0));
}
`;
