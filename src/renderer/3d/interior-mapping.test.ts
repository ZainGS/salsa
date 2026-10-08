/**
 * INTERIOR MAPPING — CPU mirror of the window shader's fake-room ray trace (mesh3d-shaders.ts: uvWorldAxes +
 * windowShade's cell frame + roomTrace), checked against a GROUND-TRUTH world-space ray trace into a real box
 * placed behind a real facade built by the real facade builder (Accum3D.wallsWin).
 *
 * The bug this guards (polish round 7): the old frame used T = cross(up, N), which points AGAINST u on every
 * wallsWin face, so the horizontal parallax was MIRRORED (the room slid the wrong way as the camera strafed), and
 * the box was the window OPENING in unit-less half-window units with a depth of ~1 window width, not a room.
 *
 * ★ If you change the WGSL frame / roomTrace math, change the mirror below with it (the source-lock test pins it).
 */
import { describe, it, expect } from 'vitest';
import { Accum3D } from '../../world/meshbuild';
import { FLOATS_PER_VERT } from './mesh-generators';
import { generateMeshFs } from './shaders/mesh-fs-generate';
import { meshFsAllKey } from './shaders/mesh-fs-key';

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const nrm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const fract = (x: number): number => x - Math.floor(x);

interface Tri { P: V3[]; UV: [number, number][]; N: V3 }

/** Every triangle of a built geometry (pos / uv / vertex normal of vertex 0 — facade faces are flat). */
function trisOf(acc: Accum3D): Tri[] {
  const g = acc.geometry();
  const out: Tri[] = [];
  const at = (i: number) => { const o = i * FLOATS_PER_VERT, v = g.vertices; return { p: [v[o], v[o + 1], v[o + 2]] as V3, n: [v[o + 3], v[o + 4], v[o + 5]] as V3, uv: [v[o + 6], v[o + 7]] as [number, number] }; };
  for (let k = 0; k < g.indices.length; k += 3) {
    const a = at(g.indices[k]), b = at(g.indices[k + 1]), c = at(g.indices[k + 2]);
    out.push({ P: [a.p, b.p, c.p], UV: [a.uv, b.uv, c.uv], N: a.n });
  }
  return out;
}

/** What dpdx/dpdy give the shader on a triangle: the exact affine Jacobian dP/du, dP/dv (uvWorldAxes). */
function uvAxes(t: Tri): [V3, V3] {
  const e1 = sub(t.P[1], t.P[0]), e2 = sub(t.P[2], t.P[0]);
  const d1 = [t.UV[1][0] - t.UV[0][0], t.UV[1][1] - t.UV[0][1]], d2 = [t.UV[2][0] - t.UV[0][0], t.UV[2][1] - t.UV[0][1]];
  const det = d1[0] * d2[1] - d1[1] * d2[0];
  return [mul(sub(mul(e1, d2[1]), mul(e2, d1[1])), 1 / det), mul(sub(mul(e2, d1[0]), mul(e1, d2[0])), 1 / det)];
}
/** World position of a uv on a triangle's plane (affine). */
function worldAt(t: Tri, u: number, v: number): V3 {
  const [Pu, Pv] = uvAxes(t);
  return add(t.P[0], add(mul(Pu, u - t.UV[0][0]), mul(Pv, v - t.UV[0][1])));
}

// ── CPU MIRROR of the WGSL (windowShade frame + roomTrace) ──
interface Hit { p: V3; face: number; dist: number }
function roomTrace(ro: V3, rd0: V3, xLo: number, xHi: number, depth: number): Hit {
  const rd: V3 = [rd0[0], rd0[1], Math.min(rd0[2], -0.08)];
  const sx = (rd[0] >= 0 ? 1 : -1) * Math.max(Math.abs(rd[0]), 1e-5);
  const sy = (rd[1] >= 0 ? 1 : -1) * Math.max(Math.abs(rd[1]), 1e-5);
  const tx = ((sx > 0 ? xHi : xLo) - ro[0]) / sx;
  const ty = ((sy > 0 ? 1 : 0) - ro[1]) / sy;
  const tz = -depth / rd[2];
  const t = Math.max(Math.min(tx, ty, tz), 0);
  const h = add(ro, mul(rd, t));
  let face = 0;
  if (tz <= Math.min(tx, ty)) face = 3; else if (ty <= tx) face = sy > 0 ? 1 : 2;
  return { p: [2 * (h[0] - xLo) / Math.max(xHi - xLo, 1e-4) - 1, 2 * h[1] - 1, 2 * h[2]], face, dist: t };
}
interface Frame { /** unit (snapped) box axes */ Tu: V3; Tv: V3; Nf: V3; cellH: number; aspect: number; ro: V3; rd: V3; xLo: number; xHi: number; cellOrigin: V3 }
const smoothstep = (a: number, b: number, x: number): number => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
/** windowShade's frame. `noise` = uvWorldAxes' derivative-noise estimate (0 = exact derivatives, as on the CPU). */
function shaderFrame(t: Tri, uv: [number, number], freq: number, cam: V3, openPlan: boolean, noise = 0): Frame {
  let [Tu, Tv] = uvAxes(t);
  const worldPos = worldAt(t, uv[0], uv[1]);
  const N = nrm(t.N);
  const Vv = nrm(sub(cam, worldPos));
  const Nf = dot(Vv, N) < 0 ? mul(N, -1) : N;
  const T0 = cross(N, [0, 1, 0]);
  const Ta: V3 = dot(T0, T0) > 1e-6 ? nrm(T0) : [1, 0, 0];
  const Ba = cross(Ta, N);
  if (dot(Tu, Tu) < 1e-24 || dot(Tv, Tv) < 1e-24) { Tu = Ta; Tv = Ba; }
  const cellH = Math.max(len(Tv) / freq, 1e-6);
  const aspMeas = Math.min(Math.max(len(Tu) / Math.max(len(Tv), 1e-12), 0.2), 5.0);
  const aspect = aspMeas + (0.85 - aspMeas) * smoothstep(0.004, 0.02, noise);
  let Uh = nrm(Tu), Vh = nrm(Tv);
  const cu = dot(Uh, Ta), cv = dot(Vh, Ba);
  const dirOk = noise < 0.3;
  if (Math.abs(cu) > 0.9 || !dirOk) Uh = mul(Ta, dirOk ? Math.sign(cu) : 1);
  if (Math.abs(cv) > 0.9 || !dirOk) Vh = mul(Ba, dirOk ? Math.sign(cv) : 1);
  const r = mul(Vv, -1);
  const gb = dot(Uh, Vh), ru = dot(r, Uh), rv = dot(r, Vh);
  const gdet = Math.max(1 - gb * gb, 1e-6);
  const rd = nrm([(ru - gb * rv) / gdet, (rv - gb * ru) / gdet, dot(r, Nf)]);
  const f: [number, number] = [fract(uv[0] * freq), fract(uv[1] * freq)];
  const ro: V3 = [f[0] * aspect, f[1], 0];
  const cellUV: [number, number] = [Math.floor(uv[0] * freq) / freq, Math.floor(uv[1] * freq) / freq];
  return { Tu: Uh, Tv: Vh, Nf, cellH, aspect, ro, rd, xLo: openPlan ? -aspect : 0, xHi: openPlan ? 2 * aspect : aspect, cellOrigin: worldAt(t, cellUV[0], cellUV[1]) };
}
/** The mirror's box hit mapped back to WORLD (the room the shader draws, as a physical place). */
function mirrorWorldHit(F: Frame, h: Hit): V3 {
  const xm = F.xLo + (h.p[0] + 1) * 0.5 * (F.xHi - F.xLo), ym = (h.p[1] + 1) * 0.5, zm = h.p[2] * 0.5;
  return add(F.cellOrigin, add(mul(nrm(F.Tu), xm * F.cellH), add(mul(nrm(F.Tv), ym * F.cellH), mul(F.Nf, zm * F.cellH))));
}

// ── GROUND TRUTH: a real box behind the real wall, traced in world space ──
function groundTruth(F: Frame, worldPos: V3, cam: V3, depthStoreys: number): { world: V3; face: number } {
  // box axes (unit): along u, along v, into the wall (-Nf); extents in world units (x: the cells the room spans)
  const U = nrm(F.Tu), V = nrm(F.Tv), W = mul(F.Nf, -1);
  const lo = [F.xLo * F.cellH, 0, 0], hi = [F.xHi * F.cellH, F.cellH, depthStoreys * F.cellH];
  const dir = nrm(sub(worldPos, cam));
  const rel = sub(worldPos, F.cellOrigin);
  // coordinates in the (possibly SHEARED - a sheared uv makes the cell a parallelogram) box basis: Cramer solve
  const det = dot(U, cross(V, W));
  const coords = (x: V3): number[] => [dot(x, cross(V, W)) / det, dot(U, cross(x, W)) / det, dot(U, cross(V, x)) / det];
  const o = coords(rel), d = coords(dir);
  let tExit = Infinity, axis = -1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) continue;
    const tk = ((d[k] > 0 ? hi[k] : lo[k]) - o[k]) / d[k];
    if (tk < tExit) { tExit = tk; axis = k; }
  }
  const face = axis === 2 ? 3 : axis === 1 ? (d[1] > 0 ? 1 : 2) : 0;
  return { world: add(worldPos, mul(dir, tExit)), face };
}

/** A 4-sided building: faces with outward normals along +X, +Z, -X, -Z (whichever order wallsWin walks). */
function facade(cell: number, storeyH: number, storeys: number): Tri[] {
  const acc = new Accum3D();
  const poly: [number, number][] = [[-6, -5], [-6, 5], [6, 5], [6, -5]];
  acc.wallsWin(poly, 0, storeyH * storeys, cell, cell, { rows: [0, storeys] });
  return trisOf(acc);
}

const CELL = 2.5, STOREY = 3.1, DEPTH = 1.4;
const FREQ = 1 / CELL;

describe('interior mapping — shader mirror vs ground-truth room', () => {
  const tris = facade(CELL, STOREY, 3);
  const faces = new Map<string, Tri>();
  for (const t of tris) { const n = nrm(t.N); const k = `${Math.round(n[0])},${Math.round(n[2])}`; if (!faces.has(k)) faces.set(k, t); }

  it('the test building has walls facing +X, -X, +Z and -Z', () => {
    expect([...faces.keys()].sort()).toEqual(['-1,0', '0,-1', '0,1', '1,0']);
  });

  for (const [key, t] of faces) {
    for (const openPlan of [false, true]) {
      it(`face n=(${key}) ${openPlan ? 'open-plan' : 'single-bay'}: the drawn room is the real room for cameras left/right/above/below`, () => {
        const n = nrm(t.N);
        const [Tu, Tv] = uvAxes(t);
        const uMid = t.UV.reduce((s, q) => s + q[0], 0) / 3, vMid = 1.5 * CELL;   // a point in the middle storey
        const uv: [number, number] = [(Math.floor(uMid * FREQ) + 0.45) / FREQ, vMid - 0.2];
        const P = worldAt(t, uv[0], uv[1]);
        const right = nrm(Tu), up = nrm(Tv);
        const offsets: [number, number][] = [[0, 0], [5, 0], [-5, 0], [0, 4], [0, -4], [4, 3], [-3, -4], [1.2, 0.4]];
        for (const [ox, oy] of offsets) {
          const cam = add(add(P, mul(n, 7)), add(mul(right, ox), mul(up, oy)));
          const F = shaderFrame(t, uv, FREQ, cam, openPlan);
          const h = roomTrace(F.ro, F.rd, F.xLo, F.xHi, DEPTH);
          const gt = groundTruth(F, P, cam, DEPTH);
          const mw = mirrorWorldHit(F, h);
          expect(len(sub(mw, gt.world))).toBeLessThan(1e-3);
          expect(h.face).toBe(gt.face);
        }
      });
    }
  }

  it('strafing RIGHT reveals the room\'s LEFT side wall (the real-life direction) on every face, noisy derivatives too', () => {
    for (const [, t] of faces) for (const noise of [0, 1]) {
      const n = nrm(t.N);
      const [Tu] = uvAxes(t);
      const viewerRight = nrm(cross(n, [0, 1, 0]).map((x) => -x) as V3);   // facing the wall from outside
      const uMid = t.UV.reduce((s, q) => s + q[0], 0) / 3;
      const uv: [number, number] = [(Math.floor(uMid * FREQ) + 0.5) / FREQ, 1.5 * CELL];
      const P = worldAt(t, uv[0], uv[1]);
      const cam = add(add(P, mul(n, 4)), mul(viewerRight, 6));        // well to the viewer's right
      const F = shaderFrame(t, uv, FREQ, cam, false, noise);   // noise 1 = nominal aspect (close-up fallback)
      const h = roomTrace(F.ro, F.rd, F.xLo, F.xHi, DEPTH);
      expect(h.face).toBe(0);                                          // a side wall...
      const hw = mirrorWorldHit(F, h);
      expect(dot(sub(hw, P), viewerRight)).toBeLessThan(0);            // ...on the viewer's LEFT
      // and the u axis really does run to the viewer's LEFT on wallsWin faces (why the old frame was mirrored)
      expect(dot(nrm(Tu), viewerRight)).toBeLessThan(-0.99);
    }
  });

  it('the OLD frame (T = cross(up, N)) was horizontally mirrored on every wallsWin face', () => {
    for (const [, t] of faces) {
      const n = nrm(t.N);
      const [Tu] = uvAxes(t);
      const Told = nrm(cross([0, 1, 0], n));
      expect(dot(Told, nrm(Tu))).toBeLessThan(-0.99);                 // box +x ran AGAINST +u (the winUV x axis)
    }
  });

  it('sheared / flipped uv layouts and cameras behind the surface still match the ground truth', () => {
    // one hand-made quad per case: u flipped, v flipped, sheared uv, normal pointing away from the camera
    const cases: { uvs: [number, number][]; flipN: boolean }[] = [
      { uvs: [[5, 0], [0, 0], [0, 6], [5, 6]], flipN: false },
      { uvs: [[0, 6], [5, 6], [5, 0], [0, 0]], flipN: false },
      { uvs: [[0, 0], [5, 3], [5, 9], [0, 6]], flipN: false },   // u axis tilted ~31 deg: too far to snap
      { uvs: [[0, 0], [5, 0], [5, 6], [0, 6]], flipN: true },
    ];
    const Pw: V3[] = [[0, 0, 0], [4, 0, 3], [4, 6, 3], [0, 6, 0]];   // a wall 5 wide, 6 tall, facing (-0.6,0,0.8)
    for (const c of cases) {
      const n0 = nrm(cross(sub(Pw[1], Pw[0]), sub(Pw[3], Pw[0])));
      const t: Tri = { P: [Pw[0], Pw[1], Pw[2]], UV: [c.uvs[0], c.uvs[1], c.uvs[2]], N: c.flipN ? mul(n0, -1) : n0 };
      const uv: [number, number] = [2.1, 3.3];
      const P = worldAt(t, uv[0], uv[1]);
      for (const off of [[3, 1], [-3, -2], [0.5, 3]] as [number, number][]) {
        const cam = add(add(P, mul(n0, 6)), add(mul(nrm(sub(Pw[1], Pw[0])), off[0]), [0, off[1], 0]));
        const F = shaderFrame(t, uv, FREQ, cam, false);
        const h = roomTrace(F.ro, F.rd, F.xLo, F.xHi, DEPTH);
        const gt = groundTruth(F, P, cam, DEPTH);
        expect(len(sub(mirrorWorldHit(F, h), gt.world))).toBeLessThan(1e-3);
        expect(h.face).toBe(gt.face);
      }
    }
  });

  it('source lock: the WGSL still carries the mirrored frame + trace', () => {
    const src = generateMeshFs(meshFsAllKey(true, false));   // (the window / interior blocks: the all-features shader)
    expect(src).toContain('let winAx = uvWorldAxes(uv, worldPos);');
    expect(src).toContain('let rd = normalize(vec3<f32>((ru - gb * rv) / gdet, (rv - gb * ru) / gdet, dot(r, Nf)));');
    expect(src).toContain('let aspect = mix(aspMeas, 0.85, smoothstep(0.004, 0.02, uvAx.noise));');
    expect(src).toContain('if (abs(cu) > 0.9 || !dirOk) { Uh = Ta * select(1.0, sign(cu), dirOk); }');
    expect(src).toContain('if (abs(cv) > 0.9 || !dirOk) { Vh = Ba * select(1.0, sign(cv), dirOk); }');
    expect(src).toContain('let ro = vec3<f32>(f.x * aspect, f.y, 0.0);');
    expect(src).toContain('let Nf = select(N, -N, dot(Vv, N) < 0.0);');
    expect(src).toContain('o.p = vec3<f32>(2.0 * (h.x - xLo) / max(xHi - xLo, 1e-4) - 1.0, 2.0 * h.y - 1.0, 2.0 * h.z);');
    expect(src).not.toContain('var T = cross(vec3<f32>(0.0, 1.0, 0.0), N);');
    // uvWorldAxes uses dpdx: it must be called OUTSIDE the patMode branch (uniform control flow)
    expect(src.indexOf('let winAx = uvWorldAxes(uv, worldPos)')).toBeLessThan(src.indexOf('if (patMode == 6u)'));
  });
});

// ── WINDOW REVEAL (persona polish D2): the recessed opening in front of the glass ──
// CPU mirror of windowReveal (mesh3d-shaders.ts), checked against a world-space trace into a real HOLE (the opening's
// span along u / v, `depth` storeys deep behind the wall plane) on every face of the real facade.
function windowRevealMirror(ro: V3, rd: V3, x0: number, x1: number, y0: number, y1: number, depth: number): [number, number, number] {
  const rz = Math.min(rd[2], -0.08);
  const tg = depth / -rz;
  const tx = rd[0] < -1e-6 ? (x0 - ro[0]) / rd[0] : rd[0] > 1e-6 ? (x1 - ro[0]) / rd[0] : 1e9;
  const ty = rd[1] < -1e-6 ? (y0 - ro[1]) / rd[1] : rd[1] > 1e-6 ? (y1 - ro[1]) / rd[1] : 1e9;
  let face = 0;
  if (Math.min(tx, ty) < tg) face = ty < tx ? (rd[1] > 0 ? 2 : 3) : 1;
  return [face, (ro[0] + rd[0] * tg - x0) / Math.max(x1 - x0, 1e-4), (ro[1] + rd[1] * tg - y0) / Math.max(y1 - y0, 1e-4)];
}
/** Ground truth: trace the camera ray from the wall-plane entry point through a real rectangular hole in world space. */
function revealTruth(F: Frame, worldPos: V3, cam: V3, x0: number, x1: number, y0: number, y1: number, depth: number): { face: number; g: [number, number] } {
  const U = nrm(F.Tu), V = nrm(F.Tv), W = mul(F.Nf, -1), H = F.cellH;
  const dir = nrm(sub(worldPos, cam)), rel = sub(worldPos, F.cellOrigin);
  const o = [dot(rel, U) / H, dot(rel, V) / H, 0], d = [dot(dir, U) / H, dot(dir, V) / H, dot(dir, W) / H];
  const tg = depth / d[2];
  const tx = d[0] < 0 ? (x0 - o[0]) / d[0] : d[0] > 0 ? (x1 - o[0]) / d[0] : Infinity;
  const ty = d[1] < 0 ? (y0 - o[1]) / d[1] : d[1] > 0 ? (y1 - o[1]) / d[1] : Infinity;
  if (Math.min(tx, ty) < tg) return { face: ty < tx ? (d[1] > 0 ? 2 : 3) : 1, g: [0, 0] };
  return { face: 0, g: [(o[0] + d[0] * tg - x0) / (x1 - x0), (o[1] + d[1] * tg - y0) / (y1 - y0)] };
}

describe('window reveal — the recessed opening (D2)', () => {
  const tris = facade(CELL, STOREY, 3);
  const faces = new Map<string, Tri>();
  for (const t of tris) { const n = nrm(t.N); const k = `${Math.round(n[0])},${Math.round(n[2])}`; if (!faces.has(k)) faces.set(k, t); }
  const ins = { x: 0.13, b: 0.30, t: 0.16 }, DEP = 0.25;   // a sash opening, a deep reveal (exercises every face)
  const probe = (t: Tri, fu: number, fv: number, camOff: (F: Frame, w: V3) => V3) => {
    const col = 1, row = 1;
    const uv0 = t.UV[0];
    const uv: [number, number] = [(Math.floor(uv0[0] * FREQ) + col + fu) / FREQ, (row + fv) / FREQ];
    const w = worldAt(t, uv[0], uv[1]);
    const F0 = shaderFrame(t, uv, FREQ, add(w, mul(nrm(t.N), 10)), false);
    const cam = camOff(F0, w);
    const F = shaderFrame(t, uv, FREQ, cam, false);
    const x0 = ins.x * F.aspect, x1 = (1 - ins.x) * F.aspect, y0 = ins.b, y1 = 1 - ins.t;
    return { m: windowRevealMirror(F.ro, F.rd, x0, x1, y0, y1, DEP), gt: revealTruth(F, w, cam, x0, x1, y0, y1, DEP) };
  };
  for (const [key, t] of faces) {
    it(`face n=(${key}): head-on sees glass, strafing reveals the correct jamb, below sees the head soffit, above the sill`, () => {
      // head-on at the opening centre → the glass, straight behind the entry point
      const head = probe(t, 0.5, 0.57, (F, w) => add(w, mul(F.Nf, 12)));
      expect(head.m[0]).toBe(0); expect(head.gt.face).toBe(0);
      expect(head.m[1]).toBeCloseTo(head.gt.g[0], 4); expect(head.m[2]).toBeCloseTo(head.gt.g[1], 4);
      // camera far to the RIGHT (+u) looking at a point near the LEFT jamb → the ray hits that jamb (face 1)
      const right = probe(t, ins.x + 0.03, 0.57, (F, w) => add(w, add(mul(F.Nf, 2), mul(nrm(F.Tu), 8))));
      expect(right.gt.face).toBe(1); expect(right.m[0]).toBe(1);
      // camera far to the right looking at the RIGHT side of the opening → glass, shifted consistently with truth
      const rightG = probe(t, 1 - ins.x - 0.05, 0.57, (F, w) => add(w, add(mul(F.Nf, 4), mul(nrm(F.Tu), 3))));
      expect(rightG.m[0]).toBe(rightG.gt.face);
      if (rightG.gt.face === 0) { expect(rightG.m[1]).toBeCloseTo(rightG.gt.g[0], 4); expect(rightG.m[2]).toBeCloseTo(rightG.gt.g[1], 4); }
      // camera BELOW (street) looking up at the top of the opening → the head soffit (face 2)
      const below = probe(t, 0.5, 1 - ins.t - 0.02, (F, w) => add(w, add(mul(F.Nf, 2), mul(nrm(F.Tv), -8))));
      expect(below.gt.face).toBe(2); expect(below.m[0]).toBe(2);
      // camera ABOVE looking down at the bottom of the opening → the sill reveal (face 3)
      const above = probe(t, 0.5, ins.b + 0.02, (F, w) => add(w, add(mul(F.Nf, 2), mul(nrm(F.Tv), 8))));
      expect(above.gt.face).toBe(3); expect(above.m[0]).toBe(3);
    });
  }
  it('source lock: the WGSL reveal matches the mirror and feeds the glass-plane uv', () => {
    const src = generateMeshFs(meshFsAllKey(true, false));   // (the window / interior blocks: the all-features shader)
    expect(src).toContain('fn windowReveal(ro: vec3<f32>, rd: vec3<f32>, x0: f32, x1: f32, y0: f32, y1: f32, depth: f32) -> vec4<f32> {');
    expect(src).toContain('if (min(tx, ty) < tg) { face = select(1.0, select(3.0, 2.0, rd.y > 0.0), ty < tx); }');
    expect(src).toContain('let rev = windowReveal(ro, rd, ins.x * aspect, (1.0 - ins.x) * aspect, ins.y, 1.0 - ins.z, revDepth);');
  });
});
