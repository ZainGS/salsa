// src/world/blade.test.ts — the `blade` PRIMITIVE + the blade archetypes (foliage-quality.md §3.1 /
// §4 / phase P1). Pins the four things that make a blade a blade rather than a cone:
//   1. it is DETERMINISTIC per seed (scatter fields must be stable across reloads),
//   2. it TAPERS monotonically toward the tip,
//   3. curve / twist / fold actually move vertices and SPLAY normals (no light catch otherwise),
//   4. the clump's blade count scales with density and drops with the LOD level, under a logged cap.
// Plus the integration contract: `tall-grass` is a real archetype, and grass no longer emits cones.

import { describe, it, expect, vi } from 'vitest';
import { Accum3D } from './meshbuild';
import { emitBlade, bladeTuft, BLADE_LOD_SCALE, type BladeParams, type BladeTuftSpec } from './blade';
import { mulberry } from './building-geom';
import { buildFoliage, FOLIAGE_TYPES, FOLIAGE_WIND, BLADE_TYPES, GROUND_PLANTED } from './foliage';
import { buildScatterLayers, PARK_RULES, type ScatterFootprint } from './ground-scatter';
import { makeRng } from './util';

const FLOATS = 12;   // pos3 · nrm3 · uv2 · tangent4 (Accum3D's interleave)
interface Vtx { p: [number, number, number]; n: [number, number, number]; u: number; v: number }
function readVerts(g: { vertices: Float32Array }): Vtx[] {
  const out: Vtx[] = [];
  for (let i = 0; i + FLOATS <= g.vertices.length; i += FLOATS) {
    out.push({
      p: [g.vertices[i], g.vertices[i + 1], g.vertices[i + 2]],
      n: [g.vertices[i + 3], g.vertices[i + 4], g.vertices[i + 5]],
      u: g.vertices[i + 6], v: g.vertices[i + 7],
    });
  }
  return out;
}
const BLADE: BladeParams = { length: 1, width: 0.06, taper: 0.9, curve: 0.4, segments: 5, twist: 0.8, foldAngle: 0.5, lean: 0.3 };
function oneBlade(over: Partial<BladeParams> = {}): { acc: Accum3D; verts: Vtx[]; tipY: number } {
  const acc = new Accum3D();
  const tipY = emitBlade(acc, null, 1, [0, 0, 0], 1, 0, { ...BLADE, ...over });
  return { acc, verts: readVerts(acc.geometry()), tipY };
}
/** Rows keyed by uv.v (the base→tip param), each { L (u=0), C (u=0.5), R (u=1) }. */
function rows(verts: Vtx[]): { v: number; L: Vtx; C: Vtx; R: Vtx }[] {
  const by = new Map<number, Vtx[]>();
  for (const q of verts) { const k = Math.round(q.v * 1e6); const a = by.get(k) ?? []; a.push(q); by.set(k, a); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([k, a]) => ({
    v: k / 1e6, L: a.find(q => q.u === 0)!, C: a.find(q => q.u === 0.5)!, R: a.find(q => q.u === 1)!,
  }));
}
const dist = (a: Vtx, b: Vtx): number => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);

const TUFT: BladeTuftSpec = {
  blades: 40, radius: 0.3, length: 0.8, lengthVar: 0.3, width: 0.03, taper: 0.94,
  curve: 0.3, curveVar: 0.4, segments: 5, twist: 0.9, twistVar: 0.5, foldAngle: 0.5,
  lean: 0.32, leanVar: 0.35, tipStart: 0.6,
};

describe('emitBlade — the swept strip (foliage-quality.md §3.1)', () => {
  it('emits a 3-column strip (left · fold ridge · right) with v running base → tip', () => {
    const { verts } = oneBlade();
    expect(verts.length).toBeGreaterThan(0);
    for (const q of verts) expect([0, 0.5, 1]).toContain(q.u);
    const R = rows(verts);
    expect(R.length).toBe(BLADE.segments + 1);
    expect(R[0].v).toBeCloseTo(0, 6);
    expect(R[R.length - 1].v).toBeCloseTo(1, 6);
    for (let i = 1; i < R.length; i++) expect(R[i].v).toBeGreaterThan(R[i - 1].v);
    // Base is PLANTED at the root (the wind grading assumes it) — the whole base row sits within a
    // cross-section's thickness of y = 0, and the returned height is the tip.
    for (const q of [R[0].L, R[0].C, R[0].R]) expect(Math.abs(q.p[1])).toBeLessThan(BLADE.width);
    expect(oneBlade().tipY).toBeGreaterThan(BLADE.length * 0.5);
  });

  it('TAPERS monotonically: every row is narrower than the one below it', () => {
    const { verts } = oneBlade({ foldAngle: 0, taper: 0.9 });   // flat → |R−L| is exactly the width
    const R = rows(verts);
    const widths = R.map(r => dist(r.L, r.R));
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThan(widths[i - 1]);
    expect(widths[0]).toBeCloseTo(BLADE.width, 4);
    expect(widths[widths.length - 1]).toBeLessThan(BLADE.width * 0.15);   // taper 0.9 → ~a point
    // taper 0 keeps a constant-width strap; taper 1 goes all the way to a point.
    const flat = rows(oneBlade({ foldAngle: 0, taper: 0 }).verts).map(r => dist(r.L, r.R));
    for (const w of flat) expect(w).toBeCloseTo(BLADE.width, 4);
    const point = rows(oneBlade({ foldAngle: 0, taper: 1 }).verts).map(r => dist(r.L, r.R));
    expect(point[point.length - 1]).toBeLessThan(1e-4);
  });

  it('CURVE arcs the spine over — more curve = a lower, further-reaching tip', () => {
    const up = oneBlade({ curve: 0 }), over = oneBlade({ curve: 1 });
    expect(up.tipY).toBeGreaterThan(over.tipY);
    const tipOf = (r: ReturnType<typeof rows>) => r[r.length - 1].C.p;
    const a = tipOf(rows(up.verts)), b = tipOf(rows(over.verts));
    expect(Math.hypot(b[0], b[2])).toBeGreaterThan(Math.hypot(a[0], a[2]));   // reaches further out
    expect(up.verts.map(q => q.p[0])).not.toEqual(over.verts.map(q => q.p[0]));
  });

  it('TWIST rotates the cross-section along the spine (vertices AND normals move)', () => {
    const none = oneBlade({ twist: 0 }).verts, spun = oneBlade({ twist: 2 }).verts;
    expect(none.length).toBe(spun.length);
    let movedP = 0, movedN = 0;
    for (let i = 0; i < none.length; i++) {
      if (dist(none[i], spun[i]) > 1e-4) movedP++;
      if (Math.hypot(none[i].n[0] - spun[i].n[0], none[i].n[1] - spun[i].n[1], none[i].n[2] - spun[i].n[2]) > 1e-4) movedN++;
    }
    expect(movedP).toBeGreaterThan(0);
    expect(movedN).toBeGreaterThan(0);
    // With no twist the cross-section frame is carried unrotated → the base normal survives to the tip.
    const R0 = rows(none);
    const n0 = R0[0].C.n, nT = R0[R0.length - 1].C.n;
    const spunR = rows(spun);
    const dotFlat = n0[0] * nT[0] + n0[1] * nT[1] + n0[2] * nT[2];
    const dotSpun = spunR[0].C.n[0] * spunR[spunR.length - 1].C.n[0] + spunR[0].C.n[1] * spunR[spunR.length - 1].C.n[1] + spunR[0].C.n[2] * spunR[spunR.length - 1].C.n[2];
    expect(dotSpun).toBeLessThan(dotFlat);   // twisted = base and tip normals diverge
  });

  it('FOLD splays the two halves onto different normals (the light catch a flat card cannot give)', () => {
    for (const r of rows(oneBlade({ foldAngle: 0 }).verts)) {
      expect(r.L.n[0]).toBeCloseTo(r.R.n[0], 6);   // flat: one normal across the whole strip
      expect(r.L.n[1]).toBeCloseTo(r.R.n[1], 6);
      expect(r.L.n[2]).toBeCloseTo(r.R.n[2], 6);
    }
    const folded = rows(oneBlade({ foldAngle: 0.6 }).verts);
    for (const r of folded) {
      const d = r.L.n[0] * r.R.n[0] + r.L.n[1] * r.R.n[1] + r.L.n[2] * r.R.n[2];
      expect(d).toBeLessThan(Math.cos(2 * 0.6) + 1e-3);   // splayed by ~2× the fold half-angle
      expect(d).toBeGreaterThan(Math.cos(2 * 0.6) - 1e-3);
      // ...and the ridge sits proud of the chord between the two edges.
      const mid: [number, number, number] = [(r.L.p[0] + r.R.p[0]) / 2, (r.L.p[1] + r.R.p[1]) / 2, (r.L.p[2] + r.R.p[2]) / 2];
      expect(Math.hypot(r.C.p[0] - mid[0], r.C.p[1] - mid[1], r.C.p[2] - mid[2])).toBeGreaterThan(0);
    }
    // Every normal is unit length (the shading layer divides by nothing).
    for (const q of oneBlade({ foldAngle: 0.6 }).verts) expect(Math.hypot(q.n[0], q.n[1], q.n[2])).toBeCloseTo(1, 5);
  });

  it('splits into the leaf + tip accumulators at tipStart (the upper-portion colour gradient)', () => {
    const lo = new Accum3D(), hi = new Accum3D();
    emitBlade(lo, hi, 0.6, [0, 0, 0], 1, 0, BLADE);
    const loV = readVerts(lo.geometry()), hiV = readVerts(hi.geometry());
    expect(loV.length).toBeGreaterThan(0);
    expect(hiV.length).toBeGreaterThan(0);
    for (const q of loV) expect(q.v).toBeLessThanOrEqual(0.6 + 1e-6);
    for (const q of hiV) expect(q.v).toBeGreaterThanOrEqual(0.6 - 1e-6);
    // The boundary row is duplicated into both strips → no seam.
    expect(loV.some(q => Math.abs(q.v - 0.6) < 1e-6)).toBe(true);
    expect(hiV.some(q => Math.abs(q.v - 0.6) < 1e-6)).toBe(true);
  });
});

describe('bladeTuft — the radial clump recipe (§4 "grass tuft")', () => {
  it('is DETERMINISTIC per seed and seed-sensitive', () => {
    const build = (seed: number) => { const a = new Accum3D(); const r = bladeTuft(a, null, TUFT, mulberry(seed)); return { g: a.geometry(), r }; };
    const a = build(7), b = build(7), c = build(8);
    expect(Array.from(b.g.vertices)).toEqual(Array.from(a.g.vertices));
    expect(Array.from(b.g.indices)).toEqual(Array.from(a.g.indices));
    expect(b.r).toEqual(a.r);
    expect(Array.from(c.g.vertices)).not.toEqual(Array.from(a.g.vertices));
  });

  it('emits exactly `blades` blades at LOD 0 and fewer at each LOD band', () => {
    const count = (lodLevel: number): number => bladeTuft(new Accum3D(), null, { ...TUFT, lodLevel }, mulberry(3)).blades;
    expect(count(0)).toBe(40);
    expect(count(1)).toBe(Math.round(40 * BLADE_LOD_SCALE[1]));
    expect(count(2)).toBe(Math.round(40 * BLADE_LOD_SCALE[2]));
    expect(count(1)).toBeLessThan(count(0));
    expect(count(2)).toBeLessThan(count(1));
    // ...and fewer blades really is less geometry.
    const geomFor = (lodLevel: number) => { const a = new Accum3D(); bladeTuft(a, null, { ...TUFT, lodLevel }, mulberry(3)); return a.triCount; };
    expect(geomFor(1)).toBeLessThan(geomFor(0));
    expect(geomFor(2)).toBeLessThan(geomFor(1));
  });

  it('CAPS the blade count and LOGS the truncation (density loss is never silent, §7)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = bladeTuft(new Accum3D(), null, { ...TUFT, blades: 500, maxBlades: 20 }, mulberry(1));
    expect(r.blades).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/capped/i);
    warn.mockClear();
    bladeTuft(new Accum3D(), null, { ...TUFT, blades: 10, maxBlades: 20 }, mulberry(1));
    expect(warn).not.toHaveBeenCalled();   // under the cap → no noise
    warn.mockRestore();
  });

  it('reports the clump height from the tallest blade tip (the wind grading denominator)', () => {
    const r = bladeTuft(new Accum3D(), null, TUFT, mulberry(5));
    expect(r.height).toBeGreaterThan(TUFT.length * 0.3);
    expect(r.height).toBeLessThanOrEqual(TUFT.length * 1.4);
  });
});

describe('grass archetypes — grass-tuft rebuilt, tall-grass added (§4)', () => {
  const leafOf = (partial: Parameters<typeof buildFoliage>[0]) => buildFoliage(partial).layers.find(l => l.name === 'foliage:leaf')!;

  it('registers `tall-grass` as a real type with a wind profile and ground planting', () => {
    expect(FOLIAGE_TYPES).toContain('tall-grass');
    expect(FOLIAGE_TYPES).toContain('grass-tuft');
    expect(FOLIAGE_WIND['tall-grass']).toBeDefined();
    expect(FOLIAGE_WIND['tall-grass'][0]).toBe(1.0);          // floppier even than a grass tuft
    expect(FOLIAGE_WIND['tall-grass'][0]).toBeLessThan(FOLIAGE_WIND['grass-tuft'][0]);
    expect(FOLIAGE_WIND['tall-grass'][1]).toBeGreaterThan(FOLIAGE_WIND['grass-tuft'][1]);
    expect(GROUND_PLANTED.has('tall-grass')).toBe(true);
    expect([...BLADE_TYPES]).toEqual(['grass-tuft', 'tall-grass']);
    // Every registered type still has a wind entry (the S1 table must stay total).
    for (const t of FOLIAGE_TYPES) expect(FOLIAGE_WIND[t], t).toBeDefined();
  });

  it('grass-tuft emits BLADES, not cones', () => {
    const leaf = leafOf({ type: 'grass-tuft' });
    const vs = readVerts(leaf.geometry);
    expect(vs.length).toBeGreaterThan(0);
    // A cone's cap vertices carry an exactly-axial normal (0,±1,0); a swept blade never does.
    for (const q of vs) expect(Math.abs(q.n[0]) + Math.abs(q.n[2])).toBeGreaterThan(0);
    // The blade strip's only u columns are the two edges + the fold ridge.
    for (const q of vs) expect([0, 0.5, 1]).toContain(q.u);
    // v spans the full base→tip range so the tip gradient has something to ramp over.
    expect(Math.min(...vs.map(q => q.v))).toBeCloseTo(0, 6);
    // Real geometry → never alpha-cut into a leaf silhouette, even in card render mode.
    expect(leafOf({ type: 'grass-tuft', render: 'card' }).leafCard).toBeFalsy();
    expect(leafOf({ type: 'tall-grass', render: 'card' }).leafCard).toBeFalsy();
  });

  it('the tuft blade count scales with DENSITY (§4: 30–60 blades)', () => {
    // 12 lower-strip verts per blade (4 rows × 3 columns) at segments 5 / tipStart 0.6.
    const bladeCount = (partial: Parameters<typeof buildFoliage>[0]): number =>
      readVerts(leafOf(partial).geometry).length / 12;
    expect(bladeCount({ type: 'grass-tuft', density: 0 })).toBe(30);
    expect(bladeCount({ type: 'grass-tuft', density: 1 })).toBe(60);
    expect(bladeCount({ type: 'grass-tuft', density: 0.5 })).toBe(45);
    // tall-grass is the FEWER-but-bigger archetype.
    const tall = readVerts(leafOf({ type: 'tall-grass', density: 1 }).geometry).length;
    const short = readVerts(leafOf({ type: 'grass-tuft', density: 1 }).geometry).length;
    expect(tall).toBeLessThan(short);
  });

  it('bladeLod thins a tuft for distance without changing its type', () => {
    const near = readVerts(leafOf({ type: 'grass-tuft', bladeLod: 0 }).geometry).length;
    const mid = readVerts(leafOf({ type: 'grass-tuft', bladeLod: 1 }).geometry).length;
    const far = readVerts(leafOf({ type: 'grass-tuft', bladeLod: 2 }).geometry).length;
    expect(mid).toBeLessThan(near);
    expect(far).toBeLessThan(mid);
  });

  it('blade params bend/twist/fold the geometry (0.5 = the archetype default)', () => {
    const at = (over: Parameters<typeof buildFoliage>[0]) => Array.from(leafOf({ type: 'grass-tuft', ...over }).geometry.vertices);
    const base = at({});
    expect(at({ bladeCurve: 1 })).not.toEqual(base);
    expect(at({ bladeTwist: 0 })).not.toEqual(base);
    expect(at({ bladeFold: 0 })).not.toEqual(base);
    expect(at({ bladeCurve: 0.5, bladeTwist: 0.5, bladeFold: 0.5 })).toEqual(base);   // 0.5 IS the default
  });

  it('blades get the strongest translucency + ground blend (thin geometry, soil-planted)', () => {
    const grass = leafOf({ type: 'grass-tuft' }), bush = leafOf({ type: 'bush' });
    expect(grass.foliageShade!.translucency!).toBeGreaterThan(bush.foliageShade!.translucency!);
    expect(grass.foliageShade!.groundBlend!).toBeGreaterThan(bush.foliageShade!.groundBlend!);
    const tuftTip = buildFoliage({ type: 'tall-grass' }).layers.find(l => l.name === 'foliage:tip')!;
    expect(tuftTip.foliageShade!.translucency!).toBeGreaterThan(grass.foliageShade!.translucency!);
    // windHeight is the tuft's MEASURED height, not the nominal size.
    const { layers, meta } = buildFoliage({ type: 'tall-grass' });
    for (const L of layers) expect(L.wind!.height).toBeCloseTo(Math.max(0.05, meta.height), 6);
    expect(meta.height).toBeGreaterThan(0);
  });
});

describe('P5 ground scatter — the tallGrass band is now a blade clump', () => {
  const foot: ScatterFootprint = { minX: -10, minZ: -10, sizeX: 20, sizeZ: 20, y: 0 };
  const build = () => buildScatterLayers(foot, { ...PARK_RULES }, makeRng(7));

  it('emits real blade geometry (instanced, no leaf-card alpha cut) with a measured wind height', () => {
    const L = build().layers.find(l => l.name === 'scatter:tallGrass')!;
    expect(L.leafCard).toBeFalsy();
    const vs = readVerts(L.geometry);
    for (const q of vs) expect([0, 0.5, 1]).toContain(q.u);
    for (const q of vs) expect(Math.abs(q.n[0]) + Math.abs(q.n[2])).toBeGreaterThan(0);
    expect(L.wind!.height).toBeGreaterThan(0.2);
    expect(L.wind!.height).toBeLessThan(1.0);
    // Still ONE canonical geometry + N transforms — never per-blade meshes.
    expect(L.transforms.length).toBeGreaterThan(10);
  });

  it('ships a REDUCED lodGeometry variant for the distance band (§2.5)', () => {
    const L = build().layers.find(l => l.name === 'scatter:tallGrass')!;
    expect(L.lodGeometry).toBeDefined();
    expect(L.lodGeometry!.vertices.length).toBeLessThan(L.geometry.vertices.length);
    expect(L.lodGeometry!.vertices.length).toBeGreaterThan(0);
    // ...and only the GEOMETRY bands carry one (blades P1 + flowers P2) — the mineral/dead placeholder
    // props stay single-variant.
    for (const other of ['scatter:twigs', 'scatter:pebbles', 'scatter:rocks']) {
      expect(build().layers.find(l => l.name === other)!.lodGeometry).toBeUndefined();
    }
  });

  it('stays deterministic for a seed (geometry included)', () => {
    const a = build().layers.find(l => l.name === 'scatter:tallGrass')!;
    const b = build().layers.find(l => l.name === 'scatter:tallGrass')!;
    expect(Array.from(b.geometry.vertices)).toEqual(Array.from(a.geometry.vertices));
    expect(b.transforms.length).toBe(a.transforms.length);
  });
});
