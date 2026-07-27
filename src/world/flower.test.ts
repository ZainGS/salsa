// src/world/flower.test.ts — the `whorl` + `stalk` PRIMITIVES and the real FLOWER archetypes
// (foliage-quality.md §3.2 / §3.3 / §4, phase P2). Pins the things that make a flower a flower rather
// than a sphere on a stick:
//   1. `emitBlade` GENERALISES to petals — width profile, notch, pitch, arbitrary growth frame — while
//      the P1 grass path stays bit-for-bit what it was,
//   2. a whorl's count / rows / pitch really move geometry, deterministically per seed,
//   3. ★ `bloomStart` / `bloomEnd` GATE where florets appear along the stem,
//   4. ★ `bloomScaleCurve` makes apex florets smaller than basal ones (buds at the top),
//   5. branches RECURSE (and are counted),
//   6. the three new archetypes are registered with wind + planting, and `flower-bed` no longer emits
//      the old blob-sphere blooms.

import { describe, it, expect, vi } from 'vitest';
import { Accum3D } from './meshbuild';
import { emitBlade, bladeWidthProfile, bladeReach, type BladeParams } from './blade';
import { emitWhorl, resolveWhorl, MAX_PETALS_PER_WHORL, WHORL_LOD_SCALE, type WhorlSpec } from './whorl';
import { emitStalk, resolveStalk, MAX_FLORETS_PER_STALK, type StalkAccum, type StalkSpec } from './stalk';
import { mulberry } from './building-geom';
import { buildFoliage, FOLIAGE_TYPES, FOLIAGE_WIND, FLOWER_TYPES, BLADE_TYPES, GROUND_PLANTED, petalTint, type FoliageType } from './foliage';
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
function strip(over: Partial<BladeParams> = {}): Vtx[] {
  const acc = new Accum3D();
  emitBlade(acc, null, 1, [0, 0, 0], 1, 0, { ...BLADE, ...over });
  return readVerts(acc.geometry());
}
/** Rows keyed by uv.v, each { L (u=0), C (u=0.5 — the fold ridge), R (u=1) }. */
function rows(verts: Vtx[]): { v: number; L: Vtx; C: Vtx; R: Vtx }[] {
  const by = new Map<number, Vtx[]>();
  for (const q of verts) { const k = Math.round(q.v * 1e6); const a = by.get(k) ?? []; a.push(q); by.set(k, a); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([k, a]) => ({
    v: k / 1e6, L: a.find(q => q.u === 0)!, C: a.find(q => q.u === 0.5)!, R: a.find(q => q.u === 1)!,
  }));
}
const width = (r: { L: Vtx; R: Vtx }): number => Math.hypot(r.L.p[0] - r.R.p[0], r.L.p[1] - r.R.p[1], r.L.p[2] - r.R.p[2]);

describe('emitBlade GENERALISED for petals (§3.2 — one sweep, not two)', () => {
  it('keeps the P1 grass behaviour byte-identical when the new options are omitted', () => {
    const bare = strip();
    const explicit = strip({ shape: 'blade', pitch: 0, notch: 0, faceFlip: false });
    expect(explicit.map(q => q.p)).toEqual(bare.map(q => q.p));
    expect(explicit.map(q => q.n)).toEqual(bare.map(q => q.n));
  });

  it('the width PROFILES give each shape its own silhouette', () => {
    // The grass profile tapers monotonically; petals put the BELLY low and end blunt / pointed / notched.
    for (const t of [0.2, 0.5, 0.8]) {
      expect(bladeWidthProfile('blade', t, 0.9)).toBeGreaterThan(bladeWidthProfile('blade', t + 0.15, 0.9));
    }
    expect(bladeWidthProfile('pointed', 1, 0)).toBeCloseTo(0, 6);          // → a point
    expect(bladeWidthProfile('rounded', 1, 0)).toBeGreaterThan(0.2);       // → a blunt, rounded end
    expect(bladeWidthProfile('strap', 1, 0)).toBeGreaterThan(0.7);         // → a near-constant band
    for (const s of ['rounded', 'pointed', 'notched'] as const) {
      const belly = bladeWidthProfile(s, 0.35, 0);
      expect(belly).toBeGreaterThan(bladeWidthProfile(s, 0, 0));           // narrow claw at the base
      expect(belly).toBeGreaterThan(bladeWidthProfile(s, 1, 0));           // ...widest below the middle
    }
    // ...and it reaches the geometry: a rounded petal ends WIDE where a grass blade ends at a point.
    const petal = rows(strip({ shape: 'rounded', foldAngle: 0 }));
    const grass = rows(strip({ shape: 'blade', taper: 1, foldAngle: 0 }));
    expect(width(petal[petal.length - 1])).toBeGreaterThan(width(grass[grass.length - 1]) * 100);
  });

  it('`notch` retracts the tip RIDGE between the two lobes (the heart-shaped end)', () => {
    const flat = rows(strip({ shape: 'notched', notch: 0 }));
    const cut = rows(strip({ shape: 'notched', notch: 1 }));
    const last = (r: typeof flat): number => r[r.length - 1].C.p[1];
    expect(last(cut)).toBeLessThan(last(flat));                            // pulled back down the spine
    expect(rows(strip({ shape: 'rounded', notch: 1 })).map(r => r.C.p[1]))  // ...and only for `notched`
      .toEqual(rows(strip({ shape: 'rounded', notch: 0 })).map(r => r.C.p[1]));
  });

  it('★ `pitch` opens the element from the axis — bud → flat → reflexed', () => {
    const tipOf = (p: number): [number, number, number] => { const r = rows(strip({ pitch: p, curve: 0, lean: 0 })); return r[r.length - 1].C.p; };
    const bud = tipOf(0), flat = tipOf(Math.PI / 2), reflex = tipOf(2.4);
    expect(bud[1]).toBeGreaterThan(flat[1]);                               // a bud stands up
    expect(Math.hypot(flat[0], flat[2])).toBeGreaterThan(Math.hypot(bud[0], bud[2]));   // flat reaches out
    expect(reflex[1]).toBeLessThan(flat[1]);                               // reflexed folds back DOWN
    // The reach helper agrees with the geometry it is derived from (no duplicated spine math).
    const reach = bladeReach({ ...BLADE, curve: 0, lean: 0 });
    expect(bud[1]).toBeCloseTo(reach.up, 6);
  });

  it('`axis` + `out` let an element grow on an arbitrary (tilted) frame, and `faceFlip` flips the face', () => {
    const tilted = rows(strip({ axis: [1, 0, 0], out: [0, 0, 1], curve: 0, lean: 0, pitch: 0, foldAngle: 0 }));
    const tip = tilted[tilted.length - 1].C.p;
    expect(tip[0]).toBeGreaterThan(0.5);                                   // grew along +X, not +Y
    expect(Math.abs(tip[1])).toBeLessThan(1e-6);
    const a = strip({ foldAngle: 0 }), b = strip({ foldAngle: 0, faceFlip: true });
    for (let i = 0; i < a.length; i++) {
      const d = a[i].n[0] * b[i].n[0] + a[i].n[1] * b[i].n[1] + a[i].n[2] * b[i].n[2];
      expect(d).toBeLessThan(0);                                           // every normal reversed
    }
  });
});

const WHORL: WhorlSpec = resolveWhorl({ count: 12, rows: 2, elementLength: 0.08, elementWidth: 0.02, centerRadius: 0.02 });
function whorl(over: Partial<WhorlSpec> = {}, seed = 4): { petals: Accum3D; centre: Accum3D; r: ReturnType<typeof emitWhorl> } {
  const petals = new Accum3D(), centre = new Accum3D();
  const r = emitWhorl(petals, centre, { ...WHORL, ...over }, { base: [0, 0, 0] }, mulberry(seed));
  return { petals, centre, r };
}

describe('emitWhorl — radial elements around an axis (§3.2)', () => {
  it('is DETERMINISTIC per seed and seed-sensitive', () => {
    const a = whorl({}, 7), b = whorl({}, 7), c = whorl({}, 8);
    expect(Array.from(b.petals.geometry().vertices)).toEqual(Array.from(a.petals.geometry().vertices));
    expect(b.r).toEqual(a.r);
    expect(Array.from(c.petals.geometry().vertices)).not.toEqual(Array.from(a.petals.geometry().vertices));
  });

  it('emits `count × rows` petals, and more petals really is more geometry', () => {
    expect(whorl({ count: 12, rows: 1 }).r.petals).toBe(12);
    expect(whorl({ count: 12, rows: 3 }).r.petals).toBe(36);
    expect(whorl({ count: 21, rows: 1 }).r.petals).toBe(21);
    expect(whorl({ count: 21, rows: 1 }).petals.triCount).toBeGreaterThan(whorl({ count: 12, rows: 1 }).petals.triCount);
    // Rows are ROTATED between each other (rowOffset) — a real flower is not one flat ring.
    const stacked = whorl({ rows: 2, rowOffset: 0.5 }), aligned = whorl({ rows: 2, rowOffset: 0 });
    expect(Array.from(stacked.petals.geometry().vertices)).not.toEqual(Array.from(aligned.petals.geometry().vertices));
  });

  it('★ `pitch` is the bloom-state knob: a bud is tall and narrow, a flat flower is wide', () => {
    const bud = whorl({ pitch: 0.15, pitchVar: 0 }), open = whorl({ pitch: 1.45, pitchVar: 0 }), reflex = whorl({ pitch: 2.4, pitchVar: 0 });
    expect(bud.r.top).toBeGreaterThan(open.r.top);
    expect(open.r.radius).toBeGreaterThan(bud.r.radius);
    expect(reflex.r.top).toBeLessThan(open.r.top);
    expect(Array.from(bud.petals.geometry().vertices)).not.toEqual(Array.from(open.petals.geometry().vertices));
  });

  it('emits the CENTRE to its own accumulator (so the eye can carry `centerColor`)', () => {
    const { petals, centre } = whorl({ centerRadius: 0.03, centerSides: 8 });
    expect(centre.triCount).toBe(8);
    expect(petals.triCount).toBeGreaterThan(8);
    expect(whorl({ centerRadius: 0 }).centre.empty).toBe(true);
    // No centre accumulator at all is legal (florets that don't need an eye).
    const only = new Accum3D();
    expect(emitWhorl(only, null, WHORL, { base: [0, 0, 0] }, mulberry(1)).petals).toBe(24);
  });

  it('petal NORMALS face outward/up so the S2 translucency reads, and are unit length', () => {
    const { petals } = whorl({ pitch: 1.4, pitchVar: 0, fold: 0 });
    let up = 0;
    for (const q of readVerts(petals.geometry())) {
      expect(Math.hypot(q.n[0], q.n[1], q.n[2])).toBeCloseTo(1, 5);
      if (q.n[1] > 0) up++;
    }
    expect(up).toBeGreaterThan(0);
  });

  it('thins with the LOD level and CAPS the petal count with a log (§7)', () => {
    expect(whorl({ count: 20, rows: 1, lodLevel: 1 }).r.petals).toBe(Math.round(20 * WHORL_LOD_SCALE[1]));
    expect(whorl({ count: 20, rows: 1, lodLevel: 2 }).r.petals).toBeLessThan(whorl({ count: 20, rows: 1, lodLevel: 1 }).r.petals);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capped = whorl({ count: 500, rows: 1, maxPetals: 12 });
    expect(capped.r.petals).toBe(12);
    expect(String(warn.mock.calls[0][0])).toMatch(/capped/i);
    warn.mockClear();
    whorl({ count: 10, rows: 1, maxPetals: MAX_PETALS_PER_WHORL });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

const STALK: StalkSpec = resolveStalk({
  height: 1, thickness: 0.01, curve: 0.2, bloomStart: 0.55, bloomEnd: 0.9, bloomDensity: 30,
  bloomScaleCurve: 0.7, leaves: 3, branches: 0, terminalCluster: false,
  floret: { count: 4, rows: 1, elementLength: 0.03, elementWidth: 0.02, centerRadius: 0.005 },
});
function stalk(over: Partial<StalkSpec> = {}, seed = 3): { acc: StalkAccum; r: ReturnType<typeof emitStalk> } {
  const acc: StalkAccum = { stem: new Accum3D(), leaf: new Accum3D(), petal: new Accum3D(), centre: new Accum3D() };
  const r = emitStalk(acc, resolveStalk({ ...STALK, ...over }), { base: [0, 0, 0] }, mulberry(seed));
  return { acc, r };
}

describe('emitStalk — elements distributed ALONG an axis (§3.3)', () => {
  it('is DETERMINISTIC per seed and emits a stem, leaves, petals and eyes', () => {
    const a = stalk({}, 5), b = stalk({}, 5);
    expect(Array.from(b.acc.petal.geometry().vertices)).toEqual(Array.from(a.acc.petal.geometry().vertices));
    expect(b.r.florets.length).toBe(a.r.florets.length);
    for (const acc of [a.acc.stem, a.acc.leaf, a.acc.petal, a.acc.centre!]) expect(acc.empty).toBe(false);
    expect(a.r.leaves).toBe(3);
    expect(a.r.petals).toBe(a.r.florets.length * 4);
    expect(a.r.height).toBeGreaterThan(0.8);
  });

  it('★ `bloomStart` / `bloomEnd` GATE where florets appear along the stem', () => {
    const { r } = stalk({ bloomStart: 0.55, bloomEnd: 0.9 });
    expect(r.florets.length).toBeGreaterThan(3);
    for (const f of r.florets) {
      expect(f.t).toBeGreaterThanOrEqual(0.55 - 1e-9);
      expect(f.t).toBeLessThanOrEqual(0.9 + 1e-9);
      // ...and in WORLD height: nothing below the band's foot, nothing above its head.
      expect(f.y).toBeGreaterThanOrEqual(r.bloomY[0] - 1e-6);
      expect(f.y).toBeLessThanOrEqual(r.bloomY[1] + 1e-6);
      expect(f.y).toBeGreaterThanOrEqual(0.55 * STALK.height);   // the arc only ever lifts the band
    }
    // Move the band and the florets move with it — the lowest floret rises, the whole set stays inside.
    const high = stalk({ bloomStart: 0.85, bloomEnd: 1 });
    expect(Math.min(...high.r.florets.map(f => f.y))).toBeGreaterThan(Math.min(...r.florets.map(f => f.y)));
    for (const f of high.r.florets) expect(f.t).toBeGreaterThanOrEqual(0.85 - 1e-9);
    // A terminal-only bloom (the daisy case) puts exactly ONE head at the very tip.
    const daisy = stalk({ bloomStart: 0.95, bloomEnd: 1, bloomDensity: 12, bloomScaleCurve: 0 });
    expect(daisy.r.florets.length).toBe(1);
    expect(daisy.r.florets[0].t).toBeCloseTo(1, 6);
  });

  it('★ `bloomScaleCurve` shrinks florets toward the tip (open below, buds at the apex)', () => {
    const { r } = stalk({ bloomScaleCurve: 0.8, bloomDensity: 30 });
    const low = r.florets[0], high = r.florets[r.florets.length - 1];
    expect(high.scale).toBeLessThan(low.scale * 0.6);
    expect(high.y).toBeGreaterThan(low.y);
    // Monotone in expectation: the top third is smaller than the bottom third on average.
    const third = Math.max(1, Math.floor(r.florets.length / 3));
    const mean = (a: typeof r.florets): number => a.reduce((s, f) => s + f.scale, 0) / a.length;
    expect(mean(r.florets.slice(-third))).toBeLessThan(mean(r.florets.slice(0, third)));
    // ...and 0 = every floret the same size (only the ±12% per-floret jitter remains).
    const flat = stalk({ bloomScaleCurve: 0 }).r.florets;
    for (const f of flat) { expect(f.scale).toBeGreaterThan(0.85); expect(f.scale).toBeLessThan(1.15); }
  });

  it('`terminalCluster` packs extra small buds at the apex', () => {
    const plain = stalk({ terminalCluster: false }).r;
    const capped = stalk({ terminalCluster: true, terminalCount: 5 }).r;
    expect(capped.florets.length).toBe(plain.florets.length + 5);
    const term = capped.florets.filter(f => f.terminal);
    expect(term.length).toBe(5);
    for (const f of term) {
      expect(f.t).toBeLessThanOrEqual(STALK.bloomEnd + 1e-9);
      expect(f.scale).toBeLessThan(0.7);           // buds, not open flowers
    }
  });

  it('`branches` RECURSE into whole sub-stalks (counted, with their own florets)', () => {
    const none = stalk({ branches: 0 }).r;
    const bushy = stalk({ branches: 4 }).r;
    expect(none.branches).toBe(0);
    expect(bushy.branches).toBe(4);
    expect(bushy.florets.filter(f => f.depth === 1).length).toBeGreaterThan(0);
    expect(bushy.florets.length).toBeGreaterThan(none.florets.length);
    expect(bushy.radius).toBeGreaterThan(none.radius);   // branches widen the footprint
    // Branch florets obey the SAME bloom band on their own stalk.
    for (const f of bushy.florets) expect(f.t).toBeGreaterThanOrEqual(STALK.bloomStart - 1e-9);
    // Recursion is one level deep — a branch never branches again.
    expect(bushy.florets.some(f => f.depth > 1)).toBe(false);
  });

  it('thins with the LOD level and CAPS the floret count with a log (§7)', () => {
    const near = stalk({ lodLevel: 0 }).r, far = stalk({ lodLevel: 2 }).r;
    expect(far.florets.length).toBeLessThan(near.florets.length);
    expect(far.petals).toBeLessThan(near.petals);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = stalk({ bloomDensity: 400, maxFlorets: 9 }).r;
    expect(budget.florets.length).toBe(9);
    expect(String(warn.mock.calls[0][0])).toMatch(/budget/i);
    warn.mockClear();
    stalk({ maxFlorets: MAX_FLORETS_PER_STALK });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('flower archetypes — daisy · rapeseed · lavender, and flower-bed rebuilt (§4)', () => {
  const by = (partial: Parameters<typeof buildFoliage>[0], n: string) => buildFoliage(partial).layers.find(l => l.name === n);

  it('registers the three new types with wind, planting and real-geometry shading', () => {
    for (const t of ['daisy', 'rapeseed', 'lavender'] as const) {
      expect(FOLIAGE_TYPES).toContain(t);
      expect(FOLIAGE_WIND[t]).toBeDefined();
      expect(FOLIAGE_WIND[t][0]).toBeGreaterThanOrEqual(1.3);   // floppy stalks (§8 P2)
      expect(FOLIAGE_WIND[t][0]).toBeLessThanOrEqual(1.6);
      expect(GROUND_PLANTED.has(t)).toBe(true);
      expect(FLOWER_TYPES.has(t)).toBe(true);
      expect(BLADE_TYPES.has(t)).toBe(false);                   // a separate set — blades are still blades
    }
    // The taller spikes are stiffer than the little daisy; every type still has a wind entry.
    expect(FOLIAGE_WIND['lavender'][0]).toBeGreaterThan(FOLIAGE_WIND['daisy'][0]);
    expect(FOLIAGE_WIND['rapeseed'][0]).toBeGreaterThan(FOLIAGE_WIND['daisy'][0]);
    for (const t of FOLIAGE_TYPES) expect(FOLIAGE_WIND[t], t).toBeDefined();
  });

  it('petals are REAL geometry: never alpha-cut, highest translucency, petal-hue backlight', () => {
    for (const t of ['daisy', 'rapeseed', 'lavender', 'flower-bed'] as const) {
      const petals = by({ type: t, render: 'card' }, 'foliage:bloom')!;
      const stems = by({ type: t, render: 'card' }, 'foliage:leaf')!;
      expect(petals.leafCard).toBeFalsy();                      // alpha-cutting would eat the petal
      expect(stems.leafCard).toBeFalsy();
      expect(petals.foliageShade!.translucency!).toBeGreaterThan(0.85);
      expect(petals.wind!.amount).toBeGreaterThan(stems.wind!.amount);
    }
    // Petals glow MORE than the strongest blade (they are the thinnest geometry in the library).
    const grass = by({ type: 'grass-tuft' }, 'foliage:tip')!;
    expect(by({ type: 'daisy' }, 'foliage:bloom')!.foliageShade!.translucency!).toBeGreaterThan(grass.foliageShade!.translucency!);
    // A backlit violet lavender stays violet (petalTint), it does not go leaf-green (transmitTint).
    const lav = by({ type: 'lavender' }, 'foliage:bloom')!;
    expect(lav.foliageShade!.translucencyColor).toEqual(petalTint(lav.color as [number, number, number]));
    expect(lav.foliageShade!.translucencyColor![2]).toBeGreaterThan(lav.foliageShade!.translucencyColor![1]);
  });

  it('each archetype gets its signature colours + structure out of the box', () => {
    const daisy = buildFoliage({ type: 'daisy' });
    const petals = daisy.layers.find(l => l.name === 'foliage:bloom')!;
    const eye = daisy.layers.find(l => l.name === 'foliage:center')!;
    expect(Math.min(...petals.color)).toBeGreaterThan(0.85);          // white rays
    expect(eye.color[0]).toBeGreaterThan(0.8); expect(eye.color[2]).toBeLessThan(0.4);   // yellow disc
    expect(daisy.meta.height).toBeGreaterThan(0.5);
    // Rapeseed BRANCHES and lavender does not (§4).
    const stalkOf = (type: 'rapeseed' | 'lavender') => buildFoliage({ type }).layers.find(l => l.name === 'foliage:leaf')!.geometry.vertices.length;
    expect(stalkOf('rapeseed')).toBeGreaterThan(stalkOf('lavender'));
    // Lavender is a NARROW spike, rapeseed a wide branched raceme.
    const spread = (type: FoliageType): number => Math.max(...buildFoliage({ type }).meta.footprint.map(f => Math.abs(f[0])));
    expect(spread('lavender')).toBeLessThan(spread('rapeseed'));
    // The host overrides land (undefined always means "keep the archetype's own value").
    const wide = buildFoliage({ type: 'daisy', petalCount: 24 }).layers.find(l => l.name === 'foliage:bloom')!;
    expect(wide.geometry.vertices.length).toBeGreaterThan(petals.geometry.vertices.length);
    const early = buildFoliage({ type: 'daisy', bloomStart: 0.2, bloomDensity: 30 }).layers.find(l => l.name === 'foliage:bloom')!;
    expect(early.geometry.vertices.length).toBeGreaterThan(petals.geometry.vertices.length);
    // flowerLod thins a flower for distance without changing its type.
    const near = buildFoliage({ type: 'rapeseed', flowerLod: 0 }).layers.find(l => l.name === 'foliage:bloom')!;
    const far = buildFoliage({ type: 'rapeseed', flowerLod: 2 }).layers.find(l => l.name === 'foliage:bloom')!;
    expect(far.geometry.vertices.length).toBeLessThan(near.geometry.vertices.length);
  });

  it('flower-bed no longer emits blob SPHERES — it is stalks + whorls now', () => {
    const bed = buildFoliage({ type: 'flower-bed', bloom: true });
    const petals = bed.layers.find(l => l.name === 'foliage:bloom')!;
    expect(bed.layers.find(l => l.name === 'foliage:center')).toBeDefined();
    expect(bed.layers.find(l => l.name === 'foliage:tip')).toBeUndefined();   // no leaf-mound clump
    // A `blob` sphere carries axis-aligned pole normals and unit-quad UVs; a swept petal strip only ever
    // has the two edge columns + the fold ridge, and its v runs base → tip.
    const vs = readVerts(petals.geometry);
    expect(vs.length).toBeGreaterThan(0);
    for (const q of vs) expect([0, 0.5, 1]).toContain(q.u);
    for (const q of vs) expect(Math.abs(q.n[0]) + Math.abs(q.n[2])).toBeGreaterThan(0);
    expect(Math.min(...vs.map(q => q.v))).toBeCloseTo(0, 6);
    expect(Math.max(...vs.map(q => q.v))).toBeCloseTo(1, 6);
    // The type name survives, so existing scenes/saves upgrade on reload.
    expect(FOLIAGE_TYPES).toContain('flower-bed');
    expect(FLOWER_TYPES.has('flower-bed')).toBe(true);
    expect(bed.meta.type).toBe('flower-bed');
  });
});

describe('P5 ground scatter — the flowers band is real flower geometry', () => {
  const foot: ScatterFootprint = { minX: -10, minZ: -10, sizeX: 20, sizeZ: 20, y: 0 };
  const build = () => buildScatterLayers(foot, { ...PARK_RULES }, makeRng(7));

  it('instances petals · eye · stem over ONE shared transform list', () => {
    const { layers } = build();
    const petals = layers.find(l => l.name === 'scatter:flowers')!;
    const eye = layers.find(l => l.name === 'scatter:flowers:eye')!;
    const stem = layers.find(l => l.name === 'scatter:flowers:stem')!;
    for (const L of [petals, eye, stem]) {
      expect(L.geometry.vertices.length).toBeGreaterThan(0);
      expect(L.transforms.length).toBeGreaterThan(10);
      expect(L.band).toBe(petals.band);                     // one prop → they cull together
      expect(L.leafCard).toBeFalsy();                        // real geometry, never alpha-cut
    }
    expect(eye.transforms).toBe(petals.transforms);          // shared: placement is computed ONCE
    expect(petals.color).not.toEqual(eye.color);
    // Swept petal strips, not a blob head.
    for (const q of readVerts(petals.geometry)) expect([0, 0.5, 1]).toContain(q.u);
    // Wind height is the clump's MEASURED height; petals are the strongest transmitters in the scatter.
    expect(petals.wind!.height).toBeGreaterThan(0.1);
    expect(petals.wind!.height).toBeLessThan(0.6);
    expect(petals.foliageShade!.translucency!).toBeGreaterThan(layers.find(l => l.name === 'scatter:tallGrass')!.foliageShade!.translucency!);
  });

  it('ships a REDUCED LOD variant of every part (§2.5) and stays deterministic', () => {
    for (const n of ['scatter:flowers', 'scatter:flowers:eye', 'scatter:flowers:stem']) {
      const L = build().layers.find(l => l.name === n)!;
      expect(L.lodGeometry).toBeDefined();
      expect(L.lodGeometry!.vertices.length).toBeGreaterThan(0);
      expect(L.lodGeometry!.vertices.length).toBeLessThan(L.geometry.vertices.length);
    }
    const a = build().layers.find(l => l.name === 'scatter:flowers')!;
    const b = build().layers.find(l => l.name === 'scatter:flowers')!;
    expect(Array.from(b.geometry.vertices)).toEqual(Array.from(a.geometry.vertices));
    expect(b.transforms.length).toBe(a.transforms.length);
  });

  it('a zero multiplier drops the flower parts too', () => {
    const { layers } = buildScatterLayers(foot, { ...PARK_RULES, flowers: 0 }, makeRng(3));
    expect(layers.some(l => l.name.startsWith('scatter:flowers'))).toBe(false);
  });
});
