import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { OcclusionCuller, buildOccluderGeometry } from './occlusion-culler';

// WebGPU-style perspective (z 0..1) looking down -Z from the origin.
function viewProj(eye: [number, number, number], target: [number, number, number], fovDeg = 60, aspect = 16 / 9): Float32Array {
  const proj = mat4.create(); mat4.perspectiveZO(proj, fovDeg * Math.PI / 180, aspect, 0.05, 500);
  const view = mat4.create(); mat4.lookAt(view, eye, target, [0, 1, 0]);
  const vp = mat4.create(); mat4.multiply(vp, proj, view);
  return vp as Float32Array;
}

/** A wall quad (two triangles, Accum3D order) in the plane z = zc spanning x0..x1, y0..y1. */
function wall(x0: number, x1: number, y0: number, y1: number, zc: number) {
  const v = new Float32Array([x0, y0, zc, x1, y0, zc, x1, y1, zc, x0, y1, zc]);
  const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return buildOccluderGeometry(v, idx, 3, null);
}

/** Exact (dense) reference: is any point of the box visible in front of the wall rectangle? Sampled on a fine grid of
 *  rays through the image; a ray sees the box if it hits the box before the wall (or misses the wall). */
function denseVisible(vp: Float32Array, box: number[], walls: { x0: number; x1: number; y0: number; y1: number; z: number }[], eye: number[]): boolean {
  const inv = mat4.invert(mat4.create(), vp as unknown as mat4)!;
  const N = 220;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const nx = -1 + 2 * i / N, ny = -1 + 2 * j / N;
    const p = [0, 0, 0, 0];
    const q = [nx, ny, 1, 1];
    for (let r = 0; r < 4; r++) p[r] = inv[r] * q[0] + inv[4 + r] * q[1] + inv[8 + r] * q[2] + inv[12 + r] * q[3];
    const far = [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
    const d = [far[0] - eye[0], far[1] - eye[1], far[2] - eye[2]];
    // ray-box slab
    let t0 = 0, t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      const inv_d = 1 / d[a]; let ta = (box[a] - eye[a]) * inv_d, tb = (box[a + 3] - eye[a]) * inv_d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (!(t0 <= t1)) continue;
    let tw = Infinity;
    for (const w of walls) {
      const t = (w.z - eye[2]) / d[2];
      if (t > 0) { const x = eye[0] + d[0] * t, y = eye[1] + d[1] * t; if (x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1) tw = Math.min(tw, t); }
    }
    if (t0 < tw) return true;
  }
  return false;
}

describe('buildOccluderGeometry', () => {
  it('merges a coplanar triangle pair into one convex quad', () => {
    const g = wall(-1, 1, 0, 2, -5);
    expect(g.polys.length).toBe(1);
    expect(g.polys[0].length).toBe(12);
    expect(g.box).toEqual([-1, 0, -5, 1, 2, -5]);
  });
  it('keeps non-coplanar pairs as two triangles and drops degenerate ones', () => {
    const v = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 2, 2, 2]);
    const g = buildOccluderGeometry(v, new Uint32Array([0, 1, 2, 0, 2, 3, 4, 4, 4]), 3, null);
    expect(g.polys.length).toBe(2);
  });
  it('applies the model matrix', () => {
    const m = mat4.fromTranslation(mat4.create(), [10, 0, 0]);
    const g = buildOccluderGeometry(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]), 3, m);
    expect(g.box[0]).toBe(10);
  });
});

describe('OcclusionCuller', () => {
  const eye: [number, number, number] = [0, 1.6, 0];
  const vp = viewProj(eye, [0, 1.6, -10]);

  it('culls a box fully behind a wall that fills its screen footprint, keeps one beside / in front', () => {
    const oc = new OcclusionCuller();
    oc.begin(vp, 1600, 900);
    oc.addOccluder(wall(-20, 20, -1, 30, -5));
    oc.finish();
    expect(oc.testBox(-1, 0, -30, 1, 3, -20)).toBe(false);     // behind the wall
    expect(oc.testBox(-1, 0, -4, 1, 3, -3)).toBe(true);        // in front of it
    expect(oc.testBox(-1, 0, -5.5, 1, 3, -4.5)).toBe(true);    // straddles the wall plane
    expect(oc.testBox(-1, 0, 5, 1, 3, 6)).toBe(true);          // behind the eye
  });

  it('keeps a box visible through a gap between two walls (even a narrow one)', () => {
    const oc = new OcclusionCuller();
    oc.begin(vp, 1600, 900);
    oc.addOccluder(wall(-20, -0.02, -1, 30, -5));
    oc.addOccluder(wall(0.02, 20, -1, 30, -5));
    oc.finish();
    expect(oc.testBox(-0.5, 0, -40, 0.5, 3, -30)).toBe(true);
    // far to one side, wholly behind one wall
    expect(oc.testBox(-6, 0, -40, -4, 3, -30)).toBe(false);
  });

  it('a box peeking over the top of a wall stays visible', () => {
    const oc = new OcclusionCuller();
    oc.begin(vp, 1600, 900);
    oc.addOccluder(wall(-20, 20, -1, 3, -5));
    oc.finish();
    expect(oc.testBox(-1, 0, -30, 1, 40, -20)).toBe(true);
    expect(oc.testBox(-1, 0, -30, 1, 2, -20)).toBe(false);
  });

  it('a wall crossing the near plane (camera beside it) still occludes what is behind it', () => {
    const vp2 = viewProj([0, 1.6, 0], [10, 1.6, -10]);
    const oc = new OcclusionCuller();
    oc.begin(vp2, 1600, 900);
    // wall in the plane z = -2 from x = -50 to 50: half of it is behind the eye
    oc.addOccluder(wall(-50, 50, -1, 30, -2));
    oc.finish();
    expect(oc.testBox(5, 0, -20, 7, 3, -15)).toBe(false);
  });

  it('never culls a box the dense ray reference sees (random walls and boxes)', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let culled = 0;
    for (let trial = 0; trial < 60; trial++) {
      const walls: { x0: number; x1: number; y0: number; y1: number; z: number }[] = [];
      const oc = new OcclusionCuller();
      oc.width = 96 + Math.floor(rnd() * 200);
      oc.begin(vp, 1600, 900);
      const nw = 1 + Math.floor(rnd() * 4);
      for (let i = 0; i < nw; i++) {
        const z = -3 - rnd() * 20, x0 = -15 + rnd() * 20, x1 = x0 + 0.5 + rnd() * 15, y0 = -1, y1 = 0.5 + rnd() * 12;
        walls.push({ x0, x1, y0, y1, z });
        oc.addOccluder(wall(x0, x1, y0, y1, z));
      }
      oc.finish();
      for (let b = 0; b < 12; b++) {
        const cx = -15 + rnd() * 30, cy = rnd() * 6, cz = -4 - rnd() * 50, sx = 0.1 + rnd() * 3, sy = 0.1 + rnd() * 4, sz = 0.1 + rnd() * 3;
        const box = [cx - sx, cy - sy, cz - sz, cx + sx, cy + sy, cz + sz];
        const vis = oc.testBox(box[0], box[1], box[2], box[3], box[4], box[5]);
        if (!vis) {
          culled++;
          expect(denseVisible(vp, box, walls, eye)).toBe(false);
        }
      }
    }
    expect(culled).toBeGreaterThan(20);   // the test is meaningful: plenty of boxes were culled
  });
});
