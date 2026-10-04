import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import {
  sanitizeTemporalAA, DEFAULT_TEMPORAL_AA, temporalRenderScale, temporalSamples, halton, temporalJitter,
  temporalDitherShift, DITHER_SHIFT_ORDER, jitterToNdc, unjitterViewProj, invert4, isCameraCut, packTaaParams,
  TAA_RESOLVE_FS, TAA_BLIT_FS, TAA_VELOCITY_RIGID_WGSL, TAA_VELOCITY_SKINNED_WGSL,
} from './temporal-aa';
import { Camera3D } from './camera-3d';

describe('temporal AA settings', () => {
  it('defaults to off', () => {
    expect(DEFAULT_TEMPORAL_AA.mode).toBe('off');
    expect(sanitizeTemporalAA(null)).toEqual({ ...DEFAULT_TEMPORAL_AA });
  });
  it('clamps and keeps the base on bad values', () => {
    const s = sanitizeTemporalAA({ mode: 'taau', scale: 0.1, sharpen: 3 });
    expect(s).toMatchObject({ mode: 'taau', scale: 0.5, sharpen: 1 });
    const t = sanitizeTemporalAA({ mode: 'bogus' as never, scale: NaN, retroOff: 'x' as never }, s);
    expect(t).toEqual(s);
    expect(sanitizeTemporalAA({ inkOff: true }).inkOff).toBe(true);
  });
  it('picks the internal scale', () => {
    const taa = sanitizeTemporalAA({ mode: 'taa' }), taau = sanitizeTemporalAA({ mode: 'taau', scale: 0.65 });
    expect(temporalRenderScale(taa, 1, 1, false)).toBe(1);
    expect(temporalRenderScale(taa, 0.75, 1, true)).toBe(0.75);   // resolution scaling still applies to plain TAA
    expect(temporalRenderScale(taau, 1, 1, false)).toBe(0.65);
    expect(temporalRenderScale(taau, 0.8, 1, true)).toBe(0.8);    // Fixed / Auto choose the TAAU scale
    expect(temporalRenderScale(taau, 1, 0.5, false)).toBe(0.5);   // the camera-motion drop still wins when lower
    expect(temporalSamples('taa')).toBe(16);
    expect(temporalSamples('taau')).toBe(32);
  });
});

describe('jitter', () => {
  it('halton(2) / halton(3) radical inverses', () => {
    expect(halton(1, 2)).toBeCloseTo(0.5);
    expect(halton(2, 2)).toBeCloseTo(0.25);
    expect(halton(3, 2)).toBeCloseTo(0.75);
    expect(halton(1, 3)).toBeCloseTo(1 / 3);
    expect(halton(2, 3)).toBeCloseTo(2 / 3);
    expect(halton(4, 3)).toBeCloseTo(1 / 9 + 1 / 3);
  });
  it('stays inside the pixel, repeats every n and averages near the centre', () => {
    const n = 16;
    let sx = 0, sy = 0;
    for (let f = 0; f < n; f++) {
      const [x, y] = temporalJitter(f, n);
      expect(Math.abs(x)).toBeLessThan(0.5);
      expect(Math.abs(y)).toBeLessThan(0.5);
      sx += x; sy += y;
      expect(temporalJitter(f + n, n)).toEqual([x, y]);
    }
    expect(Math.abs(sx / n)).toBeLessThan(0.05);
    expect(Math.abs(sy / n)).toBeLessThan(0.05);
  });
  it('the dither shift visits all 16 offsets every 16 frames', () => {
    expect([...DITHER_SHIFT_ORDER].sort((a, b) => a - b)).toEqual([...Array(16).keys()]);
    const seen = new Set<number>();
    for (let f = 0; f < 16; f++) seen.add(temporalDitherShift(f + 37));
    expect(seen.size).toBe(16);
  });
  it('pixel -> NDC (y up)', () => {
    expect(jitterToNdc(0.5, 0.25, 100, 50)).toEqual([0.01, -0.01]);
  });
});

describe('matrix helpers', () => {
  const persp = () => { const c = new Camera3D({ position: [3, 2, 5], target: [0, 0.5, 0] }); c.aspect = 1.6; return c; };
  it('Camera3D jitter is T(j) * P and unjitterViewProj undoes it exactly', () => {
    for (const mode of ['perspective', 'orthographic'] as const) {
      const c = persp(); c.mode = mode;
      const vp0 = Float32Array.from(c.getViewProjectionMatrix() as Float32Array);
      c.setProjectionJitter(0.004, -0.003);
      const vpj = Float32Array.from(c.getViewProjectionMatrix() as Float32Array);
      // a world point lands 0.004 / -0.003 NDC off
      const p = [0.3, 0.7, -0.2, 1];
      const clip = (m: Float32Array) => [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);
      const a = clip(vp0), b = clip(vpj);
      expect(b[0] / b[3] - a[0] / a[3]).toBeCloseTo(0.004, 5);
      expect(b[1] / b[3] - a[1] / a[3]).toBeCloseTo(-0.003, 5);
      expect(b[2] / b[3]).toBeCloseTo(a[2] / a[3], 6);
      const un = unjitterViewProj(new Float32Array(16), vpj, 0.004, -0.003);
      for (let i = 0; i < 16; i++) expect(un[i]).toBeCloseTo(vp0[i], 5);
      c.setProjectionJitter(0, 0);
      const back = c.getViewProjectionMatrix() as Float32Array;
      for (let i = 0; i < 16; i++) expect(back[i]).toBe(vp0[i]);   // cleared jitter = bit-identical
    }
  });
  it('invert4 matches gl-matrix', () => {
    const vp = persp().getViewProjectionMatrix() as Float32Array;
    const a = new Float32Array(16), b = mat4.create();
    expect(invert4(a, vp)).toBe(true);
    mat4.invert(b, vp);
    for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], 3);
    expect(invert4(new Float32Array(16), new Float32Array(16))).toBe(false);
  });
  it('camera cut: a small orbit step is not a cut, a teleport is', () => {
    const c = persp();
    const prev = Float32Array.from(c.getViewProjectionMatrix() as Float32Array);
    const inv = new Float32Array(16);
    c.setPosition(3.05, 2, 5); invert4(inv, c.getViewProjectionMatrix() as Float32Array);
    expect(isCameraCut(prev, inv)).toBe(false);
    c.setPosition(-30, 2, -40); c.setTarget(-60, 0, -80); invert4(inv, c.getViewProjectionMatrix() as Float32Array);
    expect(isCameraCut(prev, inv)).toBe(true);
  });
  it('packs the resolve uniform in the WGSL layout', () => {
    const id = mat4.create() as Float32Array;
    const out = packTaaParams(new Float32Array(64), {
      invVP: id, prevVP: id, curVP: id, loW: 650, loH: 400, outW: 1000, outH: 615, jitterX: 0.25, jitterY: -0.1,
      depthMin: 1 / 3, ortho: true, historyValid: true, blend: 0.1, motionBlend: 0.15, gamma: 1.25, depthTol: 0.03,
    });
    expect([out[0], out[16 + 5], out[32 + 10], out[15]]).toEqual([1, 1, 1, 1]);
    expect([...out.subarray(48, 52)]).toEqual([650, 400, 1000, 615]);
    expect(out[52]).toBeCloseTo(0.25); expect(out[53]).toBeCloseTo(-0.1); expect(out[54]).toBeCloseTo(1 / 3); expect(out[55]).toBe(1);
    expect(out[56]).toBe(1); expect(out[57]).toBeCloseTo(0.1); expect(out[59]).toBeCloseTo(1.25);
    expect(out[60]).toBeCloseTo(0.03); expect(out[61]).toBeCloseTo(0.65);
    // TaaParams = 3 mat4 + 4 vec4 = 64 floats; the shader reads P.a..P.d in that order
    expect(TAA_RESOLVE_FS).toMatch(/invVP:\s*mat4x4f,\s*prevVP:\s*mat4x4f,\s*curVP:\s*mat4x4f,\s*a: vec4f,\s*b: vec4f,\s*c: vec4f,\s*d: vec4f/);
  });
});

describe('WGSL shape', () => {
  it('no backticks in the shader comments and the entry points exist', () => {
    for (const s of [TAA_RESOLVE_FS, TAA_BLIT_FS, TAA_VELOCITY_RIGID_WGSL, TAA_VELOCITY_SKINNED_WGSL]) expect(s.includes('`')).toBe(false);
    expect(TAA_VELOCITY_RIGID_WGSL).toMatch(/fn vs_rigid/);
    expect(TAA_VELOCITY_SKINNED_WGSL).toMatch(/fn vs_skinned/);
    expect(TAA_VELOCITY_SKINNED_WGSL).toMatch(/fn prevSkinMatrixFor/);
    expect(TAA_VELOCITY_SKINNED_WGSL).toMatch(/prevSkinMatrices\[j\.x\]/);
  });
});
