// src/world/foliage-shading.test.ts — the SHARED foliage shading + motion layer (foliage-quality.md §2,
// phases S1 WIND + S2 TRANSLUCENCY/GROUND-BLEND/BASE-AO).
//
// Three things are pinned here:
//  1. The flag ENCODING — bits 19 (windSway) / 20 (foliageShade) must match the WGSL decode
//     (`flags & 524288u` / `flags & 1048576u` in mesh3d-shaders.ts + shadow-shaders.ts) and must not
//     collide with the neighbouring pattern-slot flags texOverBase(15)/boardShade(16)/radialFade(17)/
//     groundShade(18) — they all REPURPOSE the same instance slots.
//  2. The 8:8:8 colour packing that makes six scalars + two colours fit in the eight repurposed floats.
//  3. The per-type knobs `buildFoliage` / `buildScatterLayers` emit — grass floppy, hedge stiff, trunks
//     and vessels barely move and never transmit, mineral scatter props get no wind at all.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MATERIAL, encodeMaterialFlags, packRGB8, unpackRGB8,
  resolveSceneWind, DEFAULT_SCENE_WIND, type Material3D,
} from '../renderer/3d/material-3d';
import { buildFoliage, FOLIAGE_WIND, GROUND_PLANTED, FOLIAGE_TYPES, transmitTint } from './foliage';
import { buildScatterLayers, PARK_RULES, type ScatterFootprint } from './ground-scatter';
import { makeRng } from './util';

const WIND_BIT = 524288;    // bit 19 — must match the WGSL decode
const FOLIAGE_BIT = 1048576; // bit 20 — must match the WGSL decode
const TEX_OVER_BASE_BIT = 32768; // 15
const BOARD_BIT = 65536;         // 16
const RADIAL_BIT = 131072;       // 17
const GROUND_BIT = 262144;       // 18

describe('foliage material flags — windSway (bit 19) + foliageShade (bit 20)', () => {
  it('encodes windSway as bit 19 and foliageShade as bit 20', () => {
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, windSway: true }) & WIND_BIT).toBe(WIND_BIT);
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, foliageShade: true }) & FOLIAGE_BIT).toBe(FOLIAGE_BIT);
    // The two are independent: either alone, or both together.
    const both = encodeMaterialFlags({ ...DEFAULT_MATERIAL, windSway: true, foliageShade: true });
    expect(both & WIND_BIT).toBe(WIND_BIT);
    expect(both & FOLIAGE_BIT).toBe(FOLIAGE_BIT);
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, windSway: true }) & FOLIAGE_BIT).toBe(0);
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, foliageShade: true }) & WIND_BIT).toBe(0);
  });

  it('is off by default and collides with NO other flag bit (incl. the pattern-slot siblings 15-18)', () => {
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL }) & (WIND_BIT | FOLIAGE_BIT)).toBe(0);
    const everythingElse: Material3D = {
      ...DEFAULT_MATERIAL,
      hasTexture: true, hasNormalMap: true, renderStyle: 'cel-hd',
      alphaCutout: true, hairSheen: true, rimEnabled: true, sparkleEnabled: true,
      sparkleStar: true, leafCard: true, glassEnhance: true, patternMode: 'waves',
      texOverBase: true, boardShade: true, radialFade: true, groundShade: true,
    };
    expect(encodeMaterialFlags(everythingElse) & (WIND_BIT | FOLIAGE_BIT)).toBe(0);
    // Adding them is a pure OR — overwrites nothing.
    const withFoliage = encodeMaterialFlags({ ...everythingElse, windSway: true, foliageShade: true });
    expect(withFoliage).toBe(encodeMaterialFlags(everythingElse) | WIND_BIT | FOLIAGE_BIT);
    // ...and the bit values themselves are disjoint from 15/16/17/18.
    for (const other of [TEX_OVER_BASE_BIT, BOARD_BIT, RADIAL_BIT, GROUND_BIT]) {
      expect(WIND_BIT & other).toBe(0);
      expect(FOLIAGE_BIT & other).toBe(0);
    }
    expect(WIND_BIT & FOLIAGE_BIT).toBe(0);
  });

  it('round-trips the full S1+S2 param payload through JSON', () => {
    const mat: Material3D = {
      ...DEFAULT_MATERIAL,
      diffuse: { r: 0.28, g: 0.46, b: 0.2, a: 1 },
      windSway: true, windStiffness: 1.2, windHeight: 0.9, windAmount: 1,
      foliageShade: true, translucency: 0.7, translucencyColor: [0.66, 0.92, 0.36],
      groundBlend: 0.35, groundTint: [0.28, 0.30, 0.18], baseAOAmount: 0.35,
    };
    const round = JSON.parse(JSON.stringify(mat)) as Material3D;
    expect(round.windSway).toBe(true);
    expect(round.windStiffness).toBe(1.2);
    expect(round.windHeight).toBe(0.9);
    expect(round.windAmount).toBe(1);
    expect(round.foliageShade).toBe(true);
    expect(round.translucency).toBe(0.7);
    expect(round.translucencyColor).toEqual([0.66, 0.92, 0.36]);
    expect(round.groundBlend).toBe(0.35);
    expect(round.groundTint).toEqual([0.28, 0.30, 0.18]);
    expect(round.baseAOAmount).toBe(0.35);
    expect(encodeMaterialFlags(round) & (WIND_BIT | FOLIAGE_BIT)).toBe(WIND_BIT | FOLIAGE_BIT);
    // The scalar params never touch the flag word (only the two booleans do).
    expect(encodeMaterialFlags(round)).toBe(encodeMaterialFlags({ ...DEFAULT_MATERIAL, windSway: true, foliageShade: true }));
  });
});

describe('foliage colour packing — packRGB8 / fq_unpackRGB', () => {
  it('round-trips rgb through one float to within a quantization step', () => {
    for (const c of [[0, 0, 0], [1, 1, 1], [0.28, 0.30, 0.18], [0.66, 0.92, 0.36], [0.92, 0.86, 0.42]] as [number, number, number][]) {
      const back = unpackRGB8(packRGB8(c));
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i] - c[i])).toBeLessThanOrEqual(1 / 255 + 1e-9);
    }
  });

  it('packs into an f32-EXACT integer (< 2^24) so the shader unpack is lossless', () => {
    const v = packRGB8([1, 1, 1]);
    expect(v).toBe(255 * 65536 + 255 * 256 + 255);
    expect(v).toBeLessThan(2 ** 24);
    expect(Number.isInteger(v)).toBe(true);
    expect(Math.fround(v)).toBe(v);          // exactly representable as f32 (what the uniform slot holds)
    // Mirror of the WGSL fq_unpackRGB integer math.
    const p = v | 0;
    expect([(p >> 16) & 255, (p >> 8) & 255, p & 255]).toEqual([255, 255, 255]);
  });

  it('clamps out-of-range channels instead of corrupting neighbouring bytes', () => {
    expect(unpackRGB8(packRGB8([-2, 0.5, 5]))).toEqual([0, unpackRGB8(packRGB8([0, 0.5, 0]))[1], 1]);
  });
});

describe('scene wind (foliage-quality §2.1)', () => {
  it('defaults to a gentle breeze (never dead-still — static vegetation is the loudest tell)', () => {
    expect(DEFAULT_SCENE_WIND.strength).toBeGreaterThan(0);
    expect(DEFAULT_SCENE_WIND.speed).toBeGreaterThan(0);
  });

  it('merges a partial patch and leaves unspecified fields alone (set/get contract)', () => {
    const a = resolveSceneWind(DEFAULT_SCENE_WIND, { strength: 0.2 });
    expect(a.strength).toBe(0.2);
    expect(a.dirDeg).toBe(DEFAULT_SCENE_WIND.dirDeg);
    expect(a.speed).toBe(DEFAULT_SCENE_WIND.speed);
    const b = resolveSceneWind(a, { dirDeg: 90, speed: 2 });
    expect(b).toEqual({ dirDeg: 90, strength: 0.2, speed: 2 });
    expect(resolveSceneWind(b, {})).toEqual(b);
  });

  it('wraps the heading into 0..360 and clamps strength/speed to >= 0', () => {
    expect(resolveSceneWind(DEFAULT_SCENE_WIND, { dirDeg: -90 }).dirDeg).toBe(270);
    expect(resolveSceneWind(DEFAULT_SCENE_WIND, { dirDeg: 450 }).dirDeg).toBe(90);
    expect(resolveSceneWind(DEFAULT_SCENE_WIND, { strength: -1 }).strength).toBe(0);
    expect(resolveSceneWind(DEFAULT_SCENE_WIND, { speed: -3 }).speed).toBe(0);
    expect(resolveSceneWind(DEFAULT_SCENE_WIND, { strength: NaN }).strength).toBe(DEFAULT_SCENE_WIND.strength);
  });
});

describe('buildFoliage — every existing type emits the shared look', () => {
  const layersOf = (partial: Parameters<typeof buildFoliage>[0]) => {
    const { layers, meta } = buildFoliage(partial);
    return { layers, meta, by: (n: string) => layers.find(l => l.name === n) };
  };

  it('emits wind on EVERY layer of EVERY type, graded by the plant height', () => {
    for (const type of FOLIAGE_TYPES) {
      const { layers, meta } = layersOf({ type, bloom: true, render: 'card' });
      expect(layers.length).toBeGreaterThan(0);
      for (const L of layers) {
        expect(L.wind, `${type}/${L.name}`).toBeDefined();
        expect(L.wind!.amount).toBeGreaterThan(0);
        // windHeight IS the plant's height — the grading denominator the vertex + fragment stages share.
        // ★ ONE documented exception (foliage-quality.md P4v): a VESSEL type's hanging-spill layers are
        // emitted in a LIFTED local frame (geometry pushed up, an instance transform putting it back) and
        // carry a deliberately tiny windHeight so the ramp SATURATES — free-hanging geometry sits below
        // the plant's origin, where the height grade would otherwise pin it to zero sway. See
        // planting.test.ts for the full contract.
        if (L.instances?.length && L.name.endsWith('-free')) {
          expect(L.wind!.height, `${type}/${L.name}`).toBeLessThan(Math.max(0.05, meta.height));
        } else {
          expect(L.wind!.height).toBeCloseTo(Math.max(0.05, meta.height), 6);
        }
        expect(L.wind!.stiffness).toBe(FOLIAGE_WIND[type][0]);
      }
    }
  });

  it('grass is floppy and a hedge is stiff (the per-archetype stiffness contract)', () => {
    expect(FOLIAGE_WIND['grass-tuft'][0]).toBe(1.2);
    expect(FOLIAGE_WIND['hedge'][0]).toBe(3.0);
    expect(FOLIAGE_WIND['grass-tuft'][0]).toBeLessThan(FOLIAGE_WIND['hedge'][0]);
    // ...and grass swings further than a clipped hedge.
    expect(FOLIAGE_WIND['grass-tuft'][1]).toBeGreaterThan(FOLIAGE_WIND['hedge'][1]);
    const grass = layersOf({ type: 'grass-tuft' }).by('foliage:leaf')!;
    const hedge = layersOf({ type: 'hedge' }).by('foliage:leaf')!;
    expect(grass.wind!.stiffness).toBe(1.2);
    expect(hedge.wind!.stiffness).toBe(3.0);
    expect(grass.wind!.amount).toBeGreaterThan(hedge.wind!.amount);
  });

  it('leaf / tip / bloom transmit light; trunk + vessel never do and barely move', () => {
    const tree = layersOf({ type: 'small-tree', bloom: true });
    const leaf = tree.by('foliage:leaf')!, tip = tree.by('foliage:tip')!;
    const trunk = tree.by('foliage:trunk')!, bloom = tree.by('foliage:bloom')!;
    for (const L of [leaf, tip, bloom]) {
      expect(L.foliageShade, L.name).toBeDefined();
      expect(L.foliageShade!.translucency!).toBeGreaterThan(0);
      expect(L.foliageShade!.baseAO!).toBeGreaterThan(0);
    }
    // New growth (tips) glows more than mature leaves — thinner blade.
    expect(tip.foliageShade!.translucency!).toBeGreaterThan(leaf.foliageShade!.translucency!);
    // Opaque wood: no transmission, and a token amount of sway (the trunk is not rigid, just stiff).
    expect(trunk.foliageShade).toBeUndefined();
    expect(trunk.wind!.amount).toBeGreaterThan(0);
    expect(trunk.wind!.amount).toBeLessThan(leaf.wind!.amount * 0.5);

    const pot = layersOf({ type: 'potted' });
    const vessel = pot.by('foliage:vessel')!;
    expect(vessel.foliageShade).toBeUndefined();          // ceramic does not glow
    expect(vessel.wind!.amount).toBeLessThan(pot.by('foliage:leaf')!.wind!.amount * 0.2);
  });

  it('the transmission tint is LIGHTER + more saturated than the diffuse (the anime backlit cue)', () => {
    const leafCol: [number, number, number] = [0.28, 0.46, 0.2];
    const t = transmitTint(leafCol);
    expect(t[1]).toBeGreaterThan(leafCol[1]);            // greener/brighter
    expect(t[0] + t[1] + t[2]).toBeGreaterThan(leafCol[0] + leafCol[1] + leafCol[2]);
    for (const c of t) { expect(c).toBeLessThanOrEqual(1); expect(c).toBeGreaterThanOrEqual(0); }
    const emitted = buildFoliage({ type: 'bush', foliageColor: leafCol, tipColor: [0.44, 0.62, 0.3] })
      .layers.find(l => l.name === 'foliage:leaf')!;
    expect(emitted.foliageShade!.translucencyColor).toEqual(transmitTint([0.44, 0.62, 0.3]));
  });

  it('only GROUND-PLANTED types bleed the ground colour into their base', () => {
    for (const type of FOLIAGE_TYPES) {
      const leaf = buildFoliage({ type }).layers.find(l => l.name === 'foliage:leaf');
      if (!leaf) continue;
      const gb = leaf.foliageShade!.groundBlend ?? 0;
      if (GROUND_PLANTED.has(type)) expect(gb, type).toBeGreaterThan(0);
      else expect(gb, type).toBe(0);
    }
    // Vessel plants + wall climbers don't touch soil.
    expect(GROUND_PLANTED.has('potted')).toBe(false);
    expect(GROUND_PLANTED.has('ivy')).toBe(false);
    expect(GROUND_PLANTED.has('grass-tuft')).toBe(true);
  });
});

describe('ground P5 scatter — vegetation bands sway + glow, mineral props do not', () => {
  const foot: ScatterFootprint = { minX: -10, minZ: -10, sizeX: 20, sizeZ: 20, y: 0 };
  const build = () => buildScatterLayers(foot, { ...PARK_RULES, wearPath: [0.5, 0.5, 0.4] }, makeRng(7));

  it('gives flowers / tallGrass / bushes wind + translucency', () => {
    const { layers } = build();
    for (const name of ['scatter:flowers', 'scatter:tallGrass', 'scatter:bushes']) {
      const L = layers.find(l => l.name === name);
      expect(L, name).toBeDefined();
      expect(L!.wind, name).toBeDefined();
      expect(L!.wind!.amount).toBeGreaterThan(0);
      expect(L!.wind!.height).toBeGreaterThan(0);
      expect(L!.foliageShade!.translucency!).toBeGreaterThan(0);
      expect(L!.foliageShade!.groundBlend!).toBeGreaterThan(0);
    }
  });

  it('leaves twigs / pebbles / rocks completely inert (no wind, no transmission)', () => {
    const { layers } = build();
    for (const name of ['scatter:twigs', 'scatter:pebbles', 'scatter:rocks']) {
      const L = layers.find(l => l.name === name);
      expect(L, name).toBeDefined();
      expect(L!.wind, name).toBeUndefined();
      expect(L!.foliageShade, name).toBeUndefined();
    }
  });

  it('tall grass is the floppiest band (lowest stiffness, highest amount)', () => {
    const { layers } = build();
    const grass = layers.find(l => l.name === 'scatter:tallGrass')!;
    const bush = layers.find(l => l.name === 'scatter:bushes')!;
    expect(grass.wind!.stiffness).toBeLessThan(bush.wind!.stiffness);
    expect(grass.wind!.amount).toBeGreaterThan(bush.wind!.amount);
    expect(grass.foliageShade!.translucency!).toBeGreaterThan(bush.foliageShade!.translucency!);
  });

  it('the shared look does not disturb the existing placement (transforms still emitted)', () => {
    const { layers, total } = build();
    expect(total).toBeGreaterThan(0);
    for (const L of layers) expect(L.transforms.length).toBeGreaterThan(0);
  });
});
