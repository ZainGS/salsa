// src/world/ground-scatter.test.ts — P5 SCATTER (procedural-ground.md §7): the CPU weathering masks
// (mirror of the P2 WGSL), the blue-noise placer, and the mask-driven scatter density.

import { describe, it, expect } from 'vitest';
import { pgHash21, pgVnoise, fbm2, edgeMask, wearMask, moistMask, dirtMask } from './ground-masks';
import {
  poissonDisc, poissonOnSurface, buildScatterLayers, buildScatterSurface, footprintSurface, alignEuler,
  PARK_RULES, type ScatterFootprint, type ScatterSurface,
} from './ground-scatter';
import { makeRng } from './util';

describe('ground-masks — CPU mirror of the P2 weathering WGSL', () => {
  it('pgHash21 / pgVnoise / fbm2 are deterministic and in [0,1]', () => {
    for (let i = 0; i < 200; i++) {
      const x = (i * 12.34) % 40 - 20, y = (i * 7.77) % 40 - 20;
      const h1 = pgHash21(x, y), h2 = pgHash21(x, y);
      expect(h1).toBe(h2);
      expect(h1).toBeGreaterThanOrEqual(0);
      expect(h1).toBeLessThanOrEqual(1);
      const n = pgVnoise(x, y);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      const f = fbm2(x, y);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('all four masks stay within [0,1] across the uv square', () => {
    for (let v = 0; v <= 1.0001; v += 0.05) {
      for (let u = 0; u <= 1.0001; u += 0.05) {
        const em = edgeMask(u, v);
        expect(em.edge).toBeGreaterThanOrEqual(0); expect(em.edge).toBeLessThanOrEqual(1);
        expect(em.corner).toBeGreaterThanOrEqual(0); expect(em.corner).toBeLessThanOrEqual(1);
        const w = wearMask(u, v, [0.5, 0.5, 0.4]);
        expect(w).toBeGreaterThanOrEqual(0); expect(w).toBeLessThanOrEqual(1);
        const m = moistMask(u, v, em.edge, 1);
        expect(m).toBeGreaterThanOrEqual(0); expect(m).toBeLessThanOrEqual(1);
        const d = dirtMask(u, v, em.edge, em.corner);
        expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(1);
      }
    }
  });

  it('edgeMask is ~1 at the uv border and ~0 in the interior', () => {
    expect(edgeMask(0.0, 0.5).edge).toBeGreaterThan(0.9);
    expect(edgeMask(0.5, 0.0).edge).toBeGreaterThan(0.9);
    expect(edgeMask(0.5, 0.5).edge).toBeLessThan(0.05);
    // corner extreme is strongest where TWO borders meet
    expect(edgeMask(0.0, 0.0).corner).toBeGreaterThan(edgeMask(0.0, 0.5).corner);
  });

  it('wearMask RESPONDS to a wear PATH — high on the track, lower away, off when radius 0', () => {
    const center = wearMask(0.5, 0.5, [0.5, 0.5, 0.4]);
    const away = wearMask(0.05, 0.05, [0.5, 0.5, 0.4]);
    expect(center).toBeGreaterThan(0.8);
    expect(center).toBeGreaterThan(away);
    // radius 0 → noise-only (no path contribution) → the SAME as a null path
    expect(wearMask(0.5, 0.5, [0.5, 0.5, 0])).toBe(wearMask(0.5, 0.5, null));
  });
});

describe('poissonDisc — blue-noise placer (§7 "never a grid")', () => {
  it('every accepted pair is at least minDist apart (the min-distance property)', () => {
    const rng = makeRng(123);
    const minDist = 0.5;
    const pts = poissonDisc(10, 10, minDist, rng);
    expect(pts.length).toBeGreaterThan(20);
    // check pairwise (n is small enough for O(n^2) here)
    const eps = 1e-6;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i][0] - pts[j][0], dz = pts[i][1] - pts[j][1];
        expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(minDist - eps);
      }
    }
  });

  it('all points fall inside the footprint rect', () => {
    const pts = poissonDisc(8, 5, 0.4, makeRng(9));
    for (const [x, z] of pts) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(8);
      expect(z).toBeGreaterThanOrEqual(0); expect(z).toBeLessThan(5);
    }
  });

  it('is seed-stable (same seed → identical point set) and seed-sensitive', () => {
    const a = poissonDisc(10, 10, 0.5, makeRng(42));
    const b = poissonDisc(10, 10, 0.5, makeRng(42));
    expect(b).toEqual(a);
    const c = poissonDisc(10, 10, 0.5, makeRng(43));
    expect(c).not.toEqual(a);
  });
});

describe('buildScatterLayers — mask-driven density + node economy', () => {
  const footprint: ScatterFootprint = { minX: -12, minZ: -12, sizeX: 24, sizeZ: 24, y: 0 };

  it('collapses thousands of instances into a handful of LAYERS (one instanced draw per type)', () => {
    const { layers, total } = buildScatterLayers(footprint, { ...PARK_RULES }, makeRng(7));
    // One layer per prop type, except a MULTI-COLOUR prop which splits into sibling layers over the same
    // transform list (P2: flowers → petals · eye · stem). Still a handful of instanced draws.
    expect(layers.length).toBeLessThanOrEqual(9);
    expect(total).toBeGreaterThan(200);                 // but MANY instances placed
    for (const L of layers) {
      expect(L.geometry.vertices.length).toBeGreaterThan(0);
      expect(L.transforms.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = buildScatterLayers(footprint, { ...PARK_RULES }, makeRng(5));
    const b = buildScatterLayers(footprint, { ...PARK_RULES }, makeRng(5));
    expect(b.total).toBe(a.total);
    expect(b.layers.map(l => l.transforms.length)).toEqual(a.layers.map(l => l.transforms.length));
  });

  it('DENSITY responds to the shared wear mask — flowers THIN over the worn track', () => {
    const path: [number, number, number] = [0.5, 0.5, 0.35];   // worn disc at the centre
    const { layers } = buildScatterLayers(footprint, { ...PARK_RULES, wearPath: path }, makeRng(11));
    const flowers = layers.find(l => l.name === 'scatter:flowers');
    expect(flowers).toBeTruthy();
    // Fraction of flowers that landed inside the worn disc vs the disc's share of the footprint area.
    const r = path[2], discArea = Math.PI * r * r, totalArea = 1;   // in uv units
    let inDisc = 0;
    for (const t of flowers!.transforms) {
      const u = (t.x - footprint.minX) / footprint.sizeX, v = (t.z - footprint.minZ) / footprint.sizeZ;
      if (Math.hypot(u - path[0], v - path[1]) < r) inDisc++;
    }
    const flowerFracInDisc = inDisc / flowers!.transforms.length;
    const areaFrac = discArea / totalArea;
    // thinned: flowers are UNDER-represented in the worn disc relative to its area
    expect(flowerFracInDisc).toBeLessThan(areaFrac * 0.6);
  });

  it('a zero multiplier disables a type', () => {
    const { layers } = buildScatterLayers(footprint, { ...PARK_RULES, rocks: 0, flowers: 0 }, makeRng(3));
    expect(layers.find(l => l.name === 'scatter:rocks')).toBeUndefined();
    expect(layers.find(l => l.name === 'scatter:flowers')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ SURFACE scatter (bug fix): props GROW OUT OF THE MESH, they are not laid on a flat world rectangle.
// What this replaces took the geometry's local XZ AABB, transformed 4 corners, re-AABB'd them in XZ and
// used ONE `y` for every prop — so a rotated / scaled / tilted / non-flat ground got a flat, world-up,
// stay-behind carpet. Now: triangle-AREA-WEIGHTED sampling of the real triangles, an interpolated surface
// NORMAL per sample, and the transforms are emitted in the MESH's OWN LOCAL SPACE so parenting the scatter
// group to the ground mesh makes it follow every later move/rotate/scale for free.

/** A `rows × rows` grid mesh in the 12-float interleave (pos3 · nrm3 · uv2 · tan4), heights from `h(x,z)`,
 *  optionally pushed through a 3×3 matrix (a rotation × uniform scale) so the surface is genuinely tilted. */
function grid(rows: number, size: number, h: (x: number, z: number) => number, M?: number[]): { vertices: Float32Array; indices: Uint32Array } {
  const n = rows + 1;
  const V = new Float32Array(n * n * 12);
  const xf = (x: number, y: number, z: number): [number, number, number] => M
    ? [M[0] * x + M[3] * y + M[6] * z, M[1] * x + M[4] * y + M[7] * z, M[2] * x + M[5] * y + M[8] * z]
    : [x, y, z];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u = i / rows, v = j / rows;
    const x = (u - 0.5) * size, z = (v - 0.5) * size;
    const e = size / rows * 0.5;
    // Central-difference normal of the height field, then the same 3×3 (valid: M is a rotation × uniform scale).
    const nx0 = -(h(x + e, z) - h(x - e, z)) / (2 * e), nz0 = -(h(x, z + e) - h(x, z - e)) / (2 * e);
    const nl = Math.hypot(nx0, 1, nz0);
    const P = xf(x, h(x, z), z), N = xf(nx0 / nl, 1 / nl, nz0 / nl);
    const nn = Math.hypot(N[0], N[1], N[2]);
    const o = (j * n + i) * 12;
    V[o] = P[0]; V[o + 1] = P[1]; V[o + 2] = P[2];
    V[o + 3] = N[0] / nn; V[o + 4] = N[1] / nn; V[o + 5] = N[2] / nn;
    V[o + 6] = u; V[o + 7] = v;
  }
  const I: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < rows; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    I.push(a, c, b, b, c, d);
  }
  return { vertices: V, indices: new Uint32Array(I) };
}

/** The instance's UP axis, using the SAME Euler order Shape.updateLocalMatrix applies (Y → X → Z). */
function upOf(t: { ry: number; rx: number; rz: number }): [number, number, number] {
  const D = Math.PI / 180, psi = t.ry * D, phi = t.rx * D, th = t.rz * D;
  const st = Math.sin(th), ct = Math.cos(th), sf = Math.sin(phi), cf = Math.cos(phi), sp = Math.sin(psi), cp = Math.cos(psi);
  return [-st * cp + ct * sf * sp, ct * cf, st * sp + ct * sf * cp];
}

/** Shortest distance from `p` to the surface's triangle soup (barycentric lattice probe, brute force). */
function distToSurface(s: ScatterSurface, p: readonly [number, number, number]): number {
  let best = Infinity;
  for (let t = 0; t < s.triCount; t++) {
    const o = t * 9;
    for (let i = 0; i <= 4; i++) for (let j = 0; i + j <= 4; j++) {
      const b1 = i / 4, b2 = j / 4, b0 = 1 - b1 - b2;
      const d = Math.hypot(
        s.pos[o] * b0 + s.pos[o + 3] * b1 + s.pos[o + 6] * b2 - p[0],
        s.pos[o + 1] * b0 + s.pos[o + 4] * b1 + s.pos[o + 7] * b2 - p[1],
        s.pos[o + 2] * b0 + s.pos[o + 5] * b1 + s.pos[o + 8] * b2 - p[2],
      );
      if (d < best) best = d;
    }
  }
  return best;
}

describe('★ scatter grows out of the MESH SURFACE (not a flat world rectangle)', () => {
  // A rippled ground, rotated 25° about X and scaled 1.6× — the exact case that used to fail.
  const a = 25 * Math.PI / 180, k = 1.6;
  const ROT = [k, 0, 0, 0, k * Math.cos(a), k * Math.sin(a), 0, -k * Math.sin(a), k * Math.cos(a)];
  const ripple = (x: number, z: number): number => Math.sin(x * 0.5) * 0.6 + Math.cos(z * 0.4) * 0.4;

  it('every sample lies ON the mesh surface for a rotated + scaled + NON-FLAT mesh', () => {
    const g = grid(10, 16, ripple, ROT);
    const s = buildScatterSurface(g.vertices, g.indices)!;
    expect(s.triCount).toBe(200);
    const pts = poissonOnSurface(s, 0.9, makeRng(4));
    expect(pts.length).toBeGreaterThan(50);
    // The lattice probe is coarse, so allow ~half a cell; the OLD flat-rectangle placement was metres out.
    const cell = (16 / 10) * k * 0.6;
    for (const p of pts) expect(distToSurface(s, [p.x, p.y, p.z])).toBeLessThan(cell);
    // …and the y really varies (the old code used a SINGLE y for the whole field).
    const ys = pts.map(p => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.5);
  });

  it('keeps the BLUE-NOISE min-distance property in real 3D space, not just in XZ', () => {
    const g = grid(8, 12, ripple, ROT);
    const s = buildScatterSurface(g.vertices, g.indices)!;
    const minDist = 1.1;
    const pts = poissonOnSurface(s, minDist, makeRng(21));
    expect(pts.length).toBeGreaterThan(20);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y, pts[i].z - pts[j].z);
      expect(d).toBeGreaterThanOrEqual(minDist - 1e-6);
    }
  });

  it('is AREA-weighted over the real triangles and deterministic per seed', () => {
    const g = grid(6, 10, () => 0);
    const s = buildScatterSurface(g.vertices, g.indices)!;
    expect(s.area).toBeCloseTo(100, 3);
    const a1 = poissonOnSurface(s, 0.8, makeRng(9));
    const a2 = poissonOnSurface(s, 0.8, makeRng(9));
    expect(a2.map(p => p.x)).toEqual(a1.map(p => p.x));
    expect(poissonOnSurface(s, 0.8, makeRng(10)).map(p => p.x)).not.toEqual(a1.map(p => p.x));
  });

  it('★ alignToSurface TRUE grows perpendicular to a TILTED plane, FALSE grows straight up', () => {
    const tilt = 30 * Math.PI / 180;
    const M = [1, 0, 0, 0, Math.cos(tilt), Math.sin(tilt), 0, -Math.sin(tilt), Math.cos(tilt)];
    const s = buildScatterSurface(grid(6, 14, () => 0, M).vertices, grid(6, 14, () => 0, M).indices)!;
    const N = [M[3], M[4], M[5]] as const;                            // the tilted plane's normal (image of ŷ)
    const dot = (u: readonly number[], v: readonly number[]): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

    const aligned = buildScatterLayers(s, { ...PARK_RULES, wearPath: null, alignToSurface: true }, makeRng(6));
    const upright = buildScatterLayers(s, { ...PARK_RULES, wearPath: null, alignToSurface: false }, makeRng(6));
    for (const [set, axis, label] of [[aligned, N, 'aligned'], [upright, [0, 1, 0] as const, 'upright']] as const) {
      const T = set.layers.find(l => l.name === 'scatter:tallGrass')!.transforms;
      expect(T.length, label).toBeGreaterThan(10);
      // ±8° of lean jitter rides on top of either basis, so ~cos(9°) ≈ 0.987 is the floor.
      const mean = T.reduce((acc, t) => acc + dot(upOf(t), axis), 0) / T.length;
      expect(mean, label).toBeGreaterThan(0.97);
    }
    // …and they really are different bases: aligned props are nowhere near world-up on a 30° plane.
    const A = aligned.layers.find(l => l.name === 'scatter:tallGrass')!.transforms;
    expect(A.reduce((acc, t) => acc + upOf(t)[1], 0) / A.length).toBeLessThan(0.93);   // ≈ cos 30° = 0.866
  });

  it('alignEuler maps local +Y onto the requested normal for any yaw (world-up ⇒ no tilt)', () => {
    for (const yaw of [0, 37, 145, 300]) {
      const flat = alignEuler(0, 1, 0, yaw);
      expect(flat.rx).toBeCloseTo(0, 9); expect(flat.rz).toBeCloseTo(0, 9);
      for (const n of [[0.3, 0.9, -0.31], [-0.5, 0.7, 0.51], [0.62, 0.78, 0]]) {
        const l = Math.hypot(n[0], n[1], n[2]);
        const N = [n[0] / l, n[1] / l, n[2] / l];
        const e = alignEuler(N[0], N[1], N[2], yaw);
        const up = upOf({ ry: yaw, rx: e.rx, rz: e.rz });
        expect(up[0]).toBeCloseTo(N[0], 6);
        expect(up[1]).toBeCloseTo(N[1], 6);
        expect(up[2]).toBeCloseTo(N[2], 6);
      }
    }
  });

  it('★ emits transforms in the MESH LOCAL space, so PARENTING makes the field follow the mesh', () => {
    // The scatter group is a CHILD of the ground mesh, so the host transform composes into every instance —
    // which is only correct if the placement never baked a world matrix into the transforms.
    const g = grid(6, 10, ripple);
    const s = buildScatterSurface(g.vertices, g.indices)!;
    const { layers } = buildScatterLayers(s, { ...PARK_RULES, wearPath: null }, makeRng(13));
    const T = layers.flatMap(l => l.transforms);
    expect(T.length).toBeGreaterThan(20);
    for (const t of T) {
      expect(Math.abs(t.x)).toBeLessThanOrEqual(5 + 1e-6);      // the mesh's own local extent (size 10)
      expect(Math.abs(t.z)).toBeLessThanOrEqual(5 + 1e-6);
      expect(t.y).toBeLessThanOrEqual(1.01);                    // …the local height field, not a world y
    }
    // Composing a host rotate+scale keeps every prop ON the (identically transformed) surface.
    const rot = 0.6, K = 1.4;
    const M = [K, 0, 0, 0, K * Math.cos(rot), K * Math.sin(rot), 0, -K * Math.sin(rot), K * Math.cos(rot)];
    const moved = buildScatterSurface(grid(6, 10, ripple, M).vertices, g.indices)!;
    for (const t of T.slice(0, 40)) {
      expect(distToSurface(moved, [
        M[0] * t.x + M[3] * t.y + M[6] * t.z, M[1] * t.x + M[4] * t.y + M[7] * t.z, M[2] * t.x + M[5] * t.y + M[8] * t.z,
      ])).toBeLessThan((10 / 6) * K * 0.7);
    }
  });

  it('uses the mesh UVs for the shared masks when it has them, else the planar projection', () => {
    const g = grid(4, 8, () => 0);
    expect(buildScatterSurface(g.vertices, g.indices)!.hasUv).toBe(true);
    const flat = grid(4, 8, () => 0);
    for (let i = 6; i < flat.vertices.length; i += 12) { flat.vertices[i] = 0; flat.vertices[i + 1] = 0; }
    const noUv = buildScatterSurface(flat.vertices, flat.indices)!;
    expect(noUv.hasUv).toBe(false);
    for (const p of poissonOnSurface(noUv, 0.7, makeRng(2))) {
      expect(p.u).toBeGreaterThanOrEqual(0); expect(p.u).toBeLessThanOrEqual(1);
      expect(p.v).toBeGreaterThanOrEqual(0); expect(p.v).toBeLessThanOrEqual(1);
    }
  });

  it('the flat ScatterFootprint still works (one quad) and still thins over the WEAR track', () => {
    const fp: ScatterFootprint = { minX: -12, minZ: -12, sizeX: 24, sizeZ: 24, y: 3 };
    const s = footprintSurface(fp);
    expect(s.triCount).toBe(2);
    expect(s.area).toBeCloseTo(576, 3);
    const path: [number, number, number] = [0.5, 0.5, 0.35];
    const { layers } = buildScatterLayers(fp, { ...PARK_RULES, wearPath: path }, makeRng(11));
    const F = layers.find(l => l.name === 'scatter:flowers')!;
    for (const t of F.transforms) expect(t.y).toBeCloseTo(3, 6);     // still on the plane
    let inDisc = 0;
    for (const t of F.transforms) {
      const u = (t.x - fp.minX) / fp.sizeX, v = (t.z - fp.minZ) / fp.sizeZ;
      if (Math.hypot(u - path[0], v - path[1]) < path[2]) inDisc++;
    }
    expect(inDisc / F.transforms.length).toBeLessThan(Math.PI * path[2] * path[2] * 0.6);
  });

  it('worldScale converts metre spacing + prop size into the mesh local units', () => {
    // A ground mesh scaled 4× in the world: local spacing must SHRINK 4× so the WORLD spacing is unchanged.
    const g = grid(6, 10, () => 0);
    const one = buildScatterSurface(g.vertices, g.indices, { worldScale: 1 })!;
    const four = buildScatterSurface(g.vertices, g.indices, { worldScale: 4 })!;
    const n1 = buildScatterLayers(one, { ...PARK_RULES, wearPath: null }, makeRng(8)).total;
    const n4 = buildScatterLayers(four, { ...PARK_RULES, wearPath: null }, makeRng(8)).total;
    expect(n4).toBeGreaterThan(n1 * 4);                         // 4× denser per local unit = same per world metre
    const meanScale = (s: ScatterSurface): number => {
      const T = buildScatterLayers(s, { ...PARK_RULES, wearPath: null }, makeRng(8)).layers.flatMap(l => l.transforms);
      return T.reduce((a, t) => a + t.scale, 0) / T.length;
    };
    expect(meanScale(four)).toBeCloseTo(meanScale(one) / 4, 2);  // …and props are 4× smaller locally = same size
  });
});
