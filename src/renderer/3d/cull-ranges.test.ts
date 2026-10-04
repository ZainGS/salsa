import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { buildCullRanges, selectRanges } from './cull-ranges';
import { FrustumCuller } from './frustum-culler';

function vp(eye: [number, number, number], target: [number, number, number]): Float32Array {
  const proj = mat4.perspectiveZO(mat4.create(), 1.2, 16 / 9, 0.05, 300);
  const view = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
  return mat4.multiply(mat4.create(), proj, view) as Float32Array;
}

/** A row of `n` small boxes (12 triangles each) along +X, emitted object by object like the city builders. */
function row(n: number, stride = 12): { v: Float32Array; i: Uint32Array } {
  const v: number[] = [], idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const x = k * 2, b = v.length / stride;
    for (let c = 0; c < 8; c++) { v.push(x + (c & 1 ? 1 : 0), c & 2 ? 1 : 0, c & 4 ? 1 : 0); for (let p = 3; p < stride; p++) v.push(0); }
    const f = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
    for (const q of f) idx.push(b + q[0], b + q[1], b + q[2], b + q[0], b + q[2], b + q[3]);
  }
  return { v: new Float32Array(v), i: new Uint32Array(idx) };
}

describe('cull ranges', () => {
  it('runs cover the index list exactly, in order, and every box holds its triangles', () => {
    const { v, i } = row(40);
    const r = buildCullRanges(v, i, 12, null, 30);
    expect(r.n).toBe(Math.ceil(480 / 30));
    let at = 0;
    for (let k = 0; k < r.n; k++) {
      expect(r.first[k]).toBe(at); at += r.count[k];
      for (let j = r.first[k]; j < r.first[k] + r.count[k]; j++) {
        const b = i[j] * 12;
        expect(v[b]).toBeGreaterThanOrEqual(r.box[k * 6]); expect(v[b]).toBeLessThanOrEqual(r.box[k * 6 + 3]);
        expect(v[b + 2]).toBeGreaterThanOrEqual(r.box[k * 6 + 2]); expect(v[b + 2]).toBeLessThanOrEqual(r.box[k * 6 + 5]);
      }
    }
    expect(at).toBe(i.length);
  });

  it('applies the model matrix to the boxes', () => {
    const { v, i } = row(2);
    const m = mat4.fromTranslation(mat4.create(), [100, 0, 0]);
    const r = buildCullRanges(v, i, 12, m, 12);
    expect(r.box[0]).toBe(100);
  });

  it('merges adjacent kept runs and keeps every triangle whose run box is in view', () => {
    const { v, i } = row(60);
    const r = buildCullRanges(v, i, 12, null, 12);   // one box per run
    // camera looking at the middle of the row from close by: only part of it is in view
    const c = new FrustumCuller().setFromViewProjection(vp([60, 0.5, 6], [60, 0.5, 0]));
    const out: number[] = [];
    const kept = selectRanges(r, c, out);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(i.length / 3);
    // spans: sorted, non-overlapping, non-adjacent (adjacent ones were merged)
    let tri = 0;
    for (let k = 0; k < out.length; k += 2) {
      if (k > 0) expect(out[k]).toBeGreaterThan(out[k - 2] + out[k - 1]);
      tri += out[k + 1] / 3;
    }
    expect(tri).toBe(kept);
    // no dropped run had a triangle that the frustum test would keep
    const inSpan = (j: number) => { for (let k = 0; k < out.length; k += 2) if (j >= out[k] && j < out[k] + out[k + 1]) return true; return false; };
    for (let k = 0; k < r.n; k++) {
      const o = k * 6;
      const pass = c.testAABB(r.box[o], r.box[o + 1], r.box[o + 2], r.box[o + 3], r.box[o + 4], r.box[o + 5]);
      expect(inSpan(r.first[k])).toBe(pass);
    }
  });

  it('containsBox is true only for boxes wholly inside the frustum', () => {
    const c = new FrustumCuller().setFromViewProjection(vp([0, 0, 10], [0, 0, 0]));
    expect(c.containsBox({ minX: -0.5, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 })).toBe(true);
    expect(c.containsBox({ minX: -50, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 })).toBe(false);
    expect(c.testBox({ minX: -50, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 })).toBe(true);
    // random boxes: containsBox implies every corner inside (testAABB of each corner point)
    let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let t = 0; t < 300; t++) {
      const x = -10 + rnd() * 20, y = -10 + rnd() * 20, z = -30 + rnd() * 35, w = rnd() * 6;
      const b = { minX: x, minY: y, minZ: z, maxX: x + w, maxY: y + w, maxZ: z + w };
      if (!c.containsBox(b)) continue;
      for (let ci = 0; ci < 8; ci++) {
        const px = ci & 1 ? b.maxX : b.minX, py = ci & 2 ? b.maxY : b.minY, pz = ci & 4 ? b.maxZ : b.minZ;
        expect(c.testAABB(px, py, pz, px, py, pz)).toBe(true);
      }
    }
  });
});

describe('cull ranges: blocks and gap merging', () => {
  const mk = () => {
    const { v, i } = row(200);
    return { v, i, r: buildCullRanges(v, i, 12, null, 12, 4) };
  };
  it('block boxes contain their runs', () => {
    const { r } = mk();
    for (let k = 0; k < r.n; k++) {
      const o = Math.floor(k / r.blockRuns) * 6;
      for (let a = 0; a < 3; a++) { expect(r.blockBox[o + a]).toBeLessThanOrEqual(r.box[k * 6 + a]); expect(r.blockBox[o + 3 + a]).toBeGreaterThanOrEqual(r.box[k * 6 + 3 + a]); }
    }
  });
  it('the hierarchical selection keeps exactly the runs that pass (gap 0), and a gap merge only adds dropped runs between kept ones', () => {
    const { r } = mk();
    for (const eye of [[60, 0.5, 6], [200, 0.5, 30], [-20, 0.5, 2], [100, 20, 80]] as [number, number, number][]) {
      const c = new FrustumCuller().setFromViewProjection(vp(eye, [eye[0] + 3, 0.5, 0]));
      const out0: number[] = [], out2: number[] = [];
      const k0 = selectRanges(r, c, out0, 0), k2 = selectRanges(r, c, out2, 2);
      const inS = (out: number[], j: number) => { for (let k = 0; k < out.length; k += 2) if (j >= out[k] && j < out[k] + out[k + 1]) return true; return false; };
      for (let k = 0; k < r.n; k++) {
        const o = k * 6;
        const pass = c.testAABB(r.box[o], r.box[o + 1], r.box[o + 2], r.box[o + 3], r.box[o + 4], r.box[o + 5]);
        expect(inS(out0, r.first[k])).toBe(pass);
        if (pass) expect(inS(out2, r.first[k])).toBe(true);
      }
      expect(k2).toBeGreaterThanOrEqual(k0);
      expect(out2.length).toBeLessThanOrEqual(out0.length);
      // gap merge: every span boundary of out2 is a span boundary of out0 (merging never starts / ends mid-run)
      for (let k = 0; k < out2.length; k += 2) { expect(inS(out0, out2[k])).toBe(true); expect(inS(out0, out2[k] + out2[k + 1] - 1)).toBe(true); }
    }
  });
});
