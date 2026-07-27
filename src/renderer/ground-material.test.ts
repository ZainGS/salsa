/**
 * src/renderer/ground-material.test.ts — the procedural GROUND material flag (Material3D bit 18,
 * `groundShade`, procedural-ground.md P1 = ashlar limestone). The mesh3d fragment shader decodes the
 * exact same bit (flags & 262144u) and repurposes the pattern instance slots
 * (patternColor = grout rgb + width, patternParams = tile/jitter/mode) — so this pins the encoding and
 * guarantees no collision with the neighbouring pattern-slot flags texOverBase(15)/boardShade(16)/radialFade(17).
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_MATERIAL, encodeMaterialFlags, applyMaterialPatch, type Material3D } from '../renderer/3d/material-3d';

const GROUND_BIT = 262144; // bit 18 — must match the WGSL decode in mesh3d-shaders.ts
const TEX_OVER_BASE_BIT = 32768; // bit 15
const BOARD_BIT = 65536;         // bit 16
const RADIAL_BIT = 131072;       // bit 17

describe('procedural ground material — groundShade (bit 18, ashlar limestone)', () => {
  it('encodes groundShade as bit 18 (262144)', () => {
    const flags = encodeMaterialFlags({ ...DEFAULT_MATERIAL, groundShade: true });
    expect(flags & GROUND_BIT).toBe(GROUND_BIT);
  });

  it('is off by default and does not collide with any other flag bit', () => {
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL }) & GROUND_BIT).toBe(0);
    const everythingElse: Material3D = {
      ...DEFAULT_MATERIAL,
      hasTexture: true, hasNormalMap: true, renderStyle: 'cel-hd',
      alphaCutout: true, hairSheen: true, rimEnabled: true, sparkleEnabled: true,
      sparkleStar: true, leafCard: true, glassEnhance: true, patternMode: 'waves',
      texOverBase: true, boardShade: true, radialFade: true,
    };
    // groundShade must not already be set by any other flag...
    expect(encodeMaterialFlags(everythingElse) & GROUND_BIT).toBe(0);
    // ...and adding it is a pure OR (overwrites nothing).
    const withGround = encodeMaterialFlags({ ...everythingElse, groundShade: true });
    expect(withGround).toBe(encodeMaterialFlags(everythingElse) | GROUND_BIT);
  });

  it('does not overlap the sibling pattern-slot flags 15/16/17', () => {
    expect(GROUND_BIT & TEX_OVER_BASE_BIT).toBe(0);
    expect(GROUND_BIT & BOARD_BIT).toBe(0);
    expect(GROUND_BIT & RADIAL_BIT).toBe(0);
    // A pure ground material sets bit 18 and none of 15/16/17.
    const g = encodeMaterialFlags({ ...DEFAULT_MATERIAL, groundShade: true });
    expect(g & TEX_OVER_BASE_BIT).toBe(0);
    expect(g & BOARD_BIT).toBe(0);
    expect(g & RADIAL_BIT).toBe(0);
  });

  it('round-trips the ashlar-limestone param set (slot payload) through JSON', () => {
    // The values applyGroundMaterial3D writes for the 'limestone' preset. UNITS ARE METRES: the shader
    // derives world-metres-per-uv from fragment derivatives, so no plane extent is baked in here.
    const mat: Material3D = {
      ...DEFAULT_MATERIAL,
      diffuse: { r: 0.80, g: 0.74, b: 0.62, a: 1 },
      groundShade: true,
      groundGrout: { r: 0.47, g: 0.45, b: 0.41, a: 0.015 },   // 15 mm grout width, METRES
      groundTile: [0.9, 0.6],                                 // 900 mm × 600 mm landscape pavers, METRES
      groundJitter: 1,
      groundMode: 0,
    };
    const round = JSON.parse(JSON.stringify(mat)) as Material3D;
    expect(round.groundShade).toBe(true);
    expect(round.groundGrout).toEqual({ r: 0.47, g: 0.45, b: 0.41, a: 0.015 });
    expect(round.groundTile).toEqual([0.9, 0.6]);
    expect(round.groundMode).toBe(0);
    expect(encodeMaterialFlags(round) & GROUND_BIT).toBe(GROUND_BIT);
  });
});

describe('procedural ground P2 — weathering masks + profiles', () => {
  // The name→index map applyGroundMaterial3D uses (must match the WGSL gr_profile switch).
  const WEATHER: Record<string, number> = { new: 0, worn: 1, ancient: 2, mossy: 3, dirty: 4 };

  it('encodes the weather profile + mask knobs + wear path into the material and round-trips through JSON', () => {
    const mat: Material3D = {
      ...DEFAULT_MATERIAL,
      groundShade: true,
      groundGrout: { r: 0.47, g: 0.45, b: 0.41, a: 0.015 },
      groundTile: [0.9, 0.6], groundJitter: 1, groundMode: 0,
      groundWeather: 2,                        // ancient
      groundWearPath: [0.5, 0.5, 0.4],         // uv center + radius (the demo track)
      groundEdge: 1.3, groundWear: 0.8, groundMoss: 0.9, groundDirt: 0.9,
      groundMossTint: [0.30, 0.42, 0.22],
    };
    const round = JSON.parse(JSON.stringify(mat)) as Material3D;
    expect(round.groundWeather).toBe(2);
    expect(round.groundWearPath).toEqual([0.5, 0.5, 0.4]);
    expect(round.groundEdge).toBe(1.3);
    expect(round.groundWear).toBe(0.8);
    expect(round.groundMoss).toBe(0.9);
    expect(round.groundDirt).toBe(0.9);
    expect(round.groundMossTint).toEqual([0.30, 0.42, 0.22]);
    // P2 rides the SAME groundShade bit — no new flag, no regression on the sibling pattern-slot bits.
    expect(encodeMaterialFlags(round) & GROUND_BIT).toBe(GROUND_BIT);
    expect(encodeMaterialFlags(round)).toBe(encodeMaterialFlags({ ...DEFAULT_MATERIAL, groundShade: true }));
  });

  it('maps the 5 weather profiles to 5 distinct indices (new/worn/ancient/mossy/dirty)', () => {
    const idx = Object.values(WEATHER);
    expect(idx).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(idx).size).toBe(5);                       // all distinct
    expect(WEATHER.worn).toBe(1);                            // default profile is 'worn'
    // Each profile encodes a distinct groundWeather value on the material.
    const values = (['new', 'worn', 'ancient', 'mossy', 'dirty'] as const).map((w) => {
      const m: Material3D = { ...DEFAULT_MATERIAL, groundShade: true, groundWeather: WEATHER[w] };
      return (JSON.parse(JSON.stringify(m)) as Material3D).groundWeather;
    });
    expect(values).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(values).size).toBe(5);
  });

  it('P2 fields are absent by default (a plain material is not weathered) and add no flag bit', () => {
    const plain = DEFAULT_MATERIAL;
    expect(plain.groundWeather).toBeUndefined();
    expect(plain.groundWearPath).toBeUndefined();
    // groundShade bit is the ONLY thing distinguishing a ground material — P2 fields never touch flags.
    const g = encodeMaterialFlags({ ...DEFAULT_MATERIAL, groundShade: true, groundWeather: 4, groundWearPath: [0.1, 0.2, 0.3] });
    expect(g).toBe(encodeMaterialFlags({ ...DEFAULT_MATERIAL, groundShade: true }));
    expect(g & GROUND_BIT).toBe(GROUND_BIT);
  });
});

describe('procedural ground P3/P4 — surface tilers (radial/border) + grass', () => {
  // The name→groundMode map applyGroundMaterial3D uses (must match the WGSL groundSurface dispatch).
  const SURFACE: Record<string, number> = { ashlar: 0, radialMedallion: 1, borderStrip: 2, grass: 3 };

  it('maps the 4 surfaces to 4 distinct groundMode values (ashlar/radial/border/grass)', () => {
    expect(Object.values(SURFACE)).toEqual([0, 1, 2, 3]);
    expect(new Set(Object.values(SURFACE)).size).toBe(4);
    expect(SURFACE.ashlar).toBe(0);                          // P1 default surface
  });

  it('encodes the radialMedallion param set (ring spacing + wedge count in groundTile) and round-trips', () => {
    const mat: Material3D = {
      ...DEFAULT_MATERIAL,
      groundShade: true,
      groundGrout: { r: 0.47, g: 0.45, b: 0.41, a: 0.001 },
      groundTile: [0.6, 16],                                 // [ringSpacing METRES, wedgeCount]
      groundJitter: 1,
      groundMode: SURFACE.radialMedallion,
      groundWeather: 1,
    };
    const round = JSON.parse(JSON.stringify(mat)) as Material3D;
    expect(round.groundMode).toBe(1);
    expect(round.groundTile).toEqual([0.6, 16]);
    // P3 rides the SAME groundShade bit — no new flag.
    expect(encodeMaterialFlags(round) & GROUND_BIT).toBe(GROUND_BIT);
    expect(encodeMaterialFlags(round)).toBe(encodeMaterialFlags({ ...DEFAULT_MATERIAL, groundShade: true }));
  });

  it('encodes the borderStrip param set (stone length + row width in groundTile)', () => {
    const mat: Material3D = {
      ...DEFAULT_MATERIAL, groundShade: true, groundMode: SURFACE.borderStrip, groundTile: [0.9, 1.0],
    };
    const round = JSON.parse(JSON.stringify(mat)) as Material3D;
    expect(round.groundMode).toBe(2);
    expect(round.groundTile).toEqual([0.9, 1.0]);
    expect(encodeMaterialFlags(round) & GROUND_BIT).toBe(GROUND_BIT);
  });

  it('encodes the grass param set (green tint + dirt tint) and round-trips', () => {
    const mat: Material3D = {
      ...DEFAULT_MATERIAL,
      diffuse: { r: 0.30, g: 0.44, b: 0.20, a: 1 },          // grass green
      groundShade: true,
      groundMode: SURFACE.grass,
      groundDirtTint: [0.40, 0.31, 0.20],                    // P4 bare dirt-path colour
      groundWeather: 1,
      groundWearPath: [0.5, 0.5, 0.4],                       // the demo dirt track
    };
    const round = JSON.parse(JSON.stringify(mat)) as Material3D;
    expect(round.groundMode).toBe(3);
    expect(round.groundDirtTint).toEqual([0.40, 0.31, 0.20]);
    expect(round.diffuse).toEqual({ r: 0.30, g: 0.44, b: 0.20, a: 1 });
    expect(round.groundWearPath).toEqual([0.5, 0.5, 0.4]);
    expect(encodeMaterialFlags(round) & GROUND_BIT).toBe(GROUND_BIT);
  });

  it('P3/P4 add no flag bit and leave P1/P2 defaults intact', () => {
    // groundDirtTint / groundMode 1-3 never touch the flag word.
    for (const mode of [0, 1, 2, 3]) {
      const g = encodeMaterialFlags({ ...DEFAULT_MATERIAL, groundShade: true, groundMode: mode, groundDirtTint: [0.4, 0.3, 0.2] });
      expect(g).toBe(encodeMaterialFlags({ ...DEFAULT_MATERIAL, groundShade: true }));
    }
    // A plain material is still not a ground / not weathered / not tiled.
    expect(DEFAULT_MATERIAL.groundMode).toBeUndefined();
    expect(DEFAULT_MATERIAL.groundDirtTint).toBeUndefined();
    expect(encodeMaterialFlags(DEFAULT_MATERIAL) & GROUND_BIT).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ "Apply Ground does nothing (until you click Scatter)" — the DIRTY-FLAG contract.
//
// The material WAS being set; the GPU just never saw it. `applyGroundMaterial3D` flagged the mesh
// `gpuDirty`, which means "the GEOMETRY changed". Both instance-upload fast paths
// (uploadMeshInstances' transforms/material path and `_tryIncrementalInstances`) deliberately skip
// unmoved RESIDENT meshes, so nothing ever rewrote the slot's material floats + the repurposed ground
// pattern slots — and the geometry-pool pass cleared `gpuDirty` the same frame, so the change was lost
// for good. Adding the scatter group later forced a full repack, which is why it "appeared" then.
// `materialDirty` is the flag both upload paths actually watch for a material-only change.
describe('a MATERIAL-ONLY ground change reaches the GPU (bug: Apply Ground did nothing)', () => {
  const mesh = (): { material: Material3D; materialDirty: boolean; gpuDirty: boolean } =>
    ({ material: { ...DEFAULT_MATERIAL }, materialDirty: false, gpuDirty: false });

  it('flags materialDirty (the repack-only flag), NOT gpuDirty', () => {
    const m = mesh();
    applyMaterialPatch(m, { groundShade: true, groundMode: 0, groundTile: [0.9, 0.6] });
    expect(m.materialDirty).toBe(true);
    expect(m.gpuDirty).toBe(false);          // a material edit must never trigger a geometry-pool rebuild
  });

  it('leaves the mesh carrying every slot value the renderer uploads for a ground surface', () => {
    const m = mesh();
    applyMaterialPatch(m, {
      diffuse: { r: 0.8, g: 0.74, b: 0.62, a: 1 },
      groundShade: true, groundMode: 0, groundJitter: 1,
      groundGrout: { r: 0.47, g: 0.45, b: 0.41, a: 0.015 },
      groundTile: [0.9, 0.6], groundWeather: 2, groundWearPath: [0.5, 0.5, 0.4],
      patternMode: 'none', boardShade: false, texOverBase: false,
    });
    // Exactly the fields _writePatternSlots reads for the groundShade branch (floats 48–55 + 36–39).
    expect(encodeMaterialFlags(m.material) & GROUND_BIT).toBe(GROUND_BIT);
    expect(m.material.groundGrout).toEqual({ r: 0.47, g: 0.45, b: 0.41, a: 0.015 });
    expect(m.material.groundTile).toEqual([0.9, 0.6]);
    expect(m.material.groundJitter).toBe(1);
    expect(m.material.groundWeather).toBe(2);
    expect(m.material.groundWearPath).toEqual([0.5, 0.5, 0.4]);
    // …and the mutually-exclusive pattern-slot consumers are cleared (a mesh is a ground tile OR a panel).
    expect(m.material.boardShade).toBe(false);
    expect(m.material.texOverBase).toBe(false);
    expect(m.materialDirty).toBe(true);
  });

  it('a SECOND apply re-flags the mesh after the renderer consumed the first', () => {
    const m = mesh();
    applyMaterialPatch(m, { groundShade: true, groundMode: 0 });
    m.materialDirty = false;                 // renderer repacked the slot
    applyMaterialPatch(m, { groundMode: 3, diffuse: { r: 0.3, g: 0.44, b: 0.2, a: 1 } });
    expect(m.materialDirty).toBe(true);
    expect(m.material.groundMode).toBe(3);
    expect(m.material.groundShade).toBe(true);   // a patch MERGES, it never resets the material
  });
});
