import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { DEFAULT_MATERIAL, encodeMaterialFlags } from './material-3d';
import { packSceneUniforms, type ScenePackParams } from './scene-uniforms';
import { DEFAULT_PS1_CONFIG } from './renderer-3d';
import * as mesh3d from './shaders/mesh3d-shaders';
import { generateMeshFs } from './shaders/mesh-fs-generate';
import { meshFsAllKey } from './shaders/mesh-fs-key';
import * as skinning from './shaders/skinning-shaders';
import * as shadow from './shaders/shadow-shaders';
import { Scene3DMaterials } from '../../services/managers/scene3d-materials';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { ManagerContext } from '../../services/managers/manager-context';

// Retro-colour opt-in (2026-09-29): PS1Config.colorScope 'optIn' → only `retroColor` (bit 31) meshes get the colour
// depth + dither. Scope travels as a NEGATIVE colorDepth; every shader site resolves it per mesh from bit 31.

const RETRO_BIT = 0x80000000;

describe('retro colour — the material flag (bit 31)', () => {
  it('sets bit 31 only when opted in, and stays an unsigned value', () => {
    const on = encodeMaterialFlags({ ...DEFAULT_MATERIAL, retroColor: true });
    expect((on & RETRO_BIT) >>> 0).toBe(RETRO_BIT);
    expect(on).toBeGreaterThan(0);                                            // unsigned, not a negative int
    expect((encodeMaterialFlags(DEFAULT_MATERIAL) & RETRO_BIT) >>> 0).toBe(0);
    // it doesn't disturb any other bit
    const all = { ...DEFAULT_MATERIAL, toonShadow: true, skinRamp: true, softLighting: true };
    expect(encodeMaterialFlags({ ...all, retroColor: true })).toBe((encodeMaterialFlags(all) | RETRO_BIT) >>> 0);
  });
});

describe('retro colour — the scope in the scene uniform', () => {
  const pack = (ps1: ScenePackParams['ps1']) => {
    const data = new Float32Array(220);
    packSceneUniforms(data, {
      vp: mat4.create() as Float32Array, camPos: [0, 0, 0], orthographic: false, ambientColor: [0, 0, 0], ambientIntensity: 1,
      light: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }, ps1, w: 10, h: 10, shadowMinLight: 0.4, glassRefraction: 1,
      lightSpaceMatrix: null, shadowPcfRadius: 1, effBias: 0, shadowMapSize: 1024, shadowSoftness: 1,
      fog: { color: [0, 0, 0], mode: 'linear', near: 1, far: 2, density: 0 }, aerialFog: 0, pointLights: [],
      wind: { dirDeg: 0, strength: 0, speed: 0 }, glassQuality: 1, timeSec: 0, softLightStrength: 0,
      skinRamp: { bands: 2, softness: 0.1, shadowFloor: 0.4, tintPacked: 0 }, sketchPaper: 0.5,
      toon: { bands: 2, softness: 0.04, shadowValue: 0.6, tintPacked: 0, saturation: 0 }, rim: { strength: 0, width: 0.2, hardness: 0.8, colorPacked: 0 },
    } as ScenePackParams);
    return data[35];
  };
  it("'all' (and unset) = the original positive colour depth; 'optIn' = negative", () => {
    expect(pack({ ...DEFAULT_PS1_CONFIG, colorDepth: 3 })).toBe(3);
    expect(pack({ vertexJitter: 0, snapGridSize: 0, affineStrength: 0, colorDepth: 3 })).toBe(3);   // old saves: no field
    expect(pack({ ...DEFAULT_PS1_CONFIG, colorDepth: 3, colorScope: 'optIn' })).toBe(-3);
    expect(pack({ ...DEFAULT_PS1_CONFIG, colorDepth: 0, colorScope: 'optIn' })).toBe(-0);          // off stays off
  });
  it('the defaults carry the scope explicitly (so a document load resets it to all)', () => {
    expect(DEFAULT_PS1_CONFIG.colorScope).toBe('all');
  });
});

describe('retro colour — every shader quantize site resolves the scope per mesh', () => {
  // every shader string + the generated mesh fragment shaders (all features, per layout: the only mesh FS source)
  const src = [...[mesh3d, skinning, shadow].flatMap((m) => Object.values(m).filter((v): v is string => typeof v === 'string')),
    ...[false, true].flatMap((tex) => [false, true].map((sh) => generateMeshFs(meshFsAllKey(tex, sh))))].join('\n');
  it('no site reads the raw colour depth any more (a raw read would ignore the opt-in bit)', () => {
    expect(src).not.toMatch(/let (colorDepth|cd) = scene\.ps1Config\.w;/);
    const sites = src.match(/let (colorDepth|cd) = select\(scene\.ps1Config\.w, -scene\.ps1Config\.w, scene\.ps1Config\.w < 0\.0 && \([^)]*2147483648u\) != 0u\)/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(7);
  });
});

describe('retro colour — materials sub-module', () => {
  const mk = (id: string) => ({ id, material: {} as Record<string, unknown>, materialDirty: false, stateDirty: false }) as unknown as Mesh3D;
  it('opts one mesh or a whole character in, marking them for re-pack + save', () => {
    const body = mk('b'), hair = mk('h'), top = mk('t'), prop = mk('p');
    const byId = new Map([body, hair, top, prop].map((m) => [m.id, m]));
    let renders = 0;
    const mats = new Scene3DMaterials({ scheduleRender: () => { renders++; } } as unknown as ManagerContext, {
      getMesh: (id) => byId.get(id) ?? null, getAllMeshes: () => [...byId.values()], getProceduralBodyParts: (id) => (id === 'b' ? ['h', 't'] : []),
    });
    expect(mats.setCharacterRetroColor('b', true)).toBe(3);
    for (const m of [body, hair, top]) { expect(m.material.retroColor).toBe(true); expect(m.materialDirty).toBe(true); expect(m.stateDirty).toBe(true); }
    expect(prop.material.retroColor).toBeUndefined();
    expect(mats.getMeshRetroColor('h')).toBe(true);
    expect(mats.setMeshRetroColor('missing', true)).toBe(false);
    expect(renders).toBeGreaterThan(0);
  });
});
