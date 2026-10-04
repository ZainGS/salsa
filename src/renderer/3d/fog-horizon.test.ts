import { describe, it, expect } from 'vitest';
import {
  computeFogEye, defaultFogHorizon, fogClassCulled, fogHorizonActive, fogHorizonDiff, fogHorizonEdge, fogHorizonFlags,
  sanitizeFogHorizon, DEFAULT_FOG_HORIZON, FOG_HORIZON_ATTACH, FOG_HORIZON_COARSE, FOG_HORIZON_FADE, FOG_HORIZON_FAST,
  FOG_HORIZON_HARD, FOG_HORIZON_OUTLINE_CUT,
} from './fog-horizon';
import { packSceneUniforms } from './scene-uniforms';
import { mat4 } from 'gl-matrix';

describe('fog horizon settings', () => {
  it('defaults are off / today (fade 15 m, dither, outlines on)', () => {
    expect(defaultFogHorizon()).toEqual({ buildingsOnly: false, includeAttachments: false, fadeM: 15, fadeStyle: 'dither', silhouetteOutlines: true });
    expect(fogHorizonDiff(defaultFogHorizon())).toBeNull();
  });
  it('sanitize merges, clamps and ignores bad values; reset starts from the defaults', () => {
    const s = sanitizeFogHorizon({ buildingsOnly: true, fadeM: 9999, fadeStyle: 'nope', silhouetteOutlines: 'x' } as never);
    expect(s).toEqual({ ...DEFAULT_FOG_HORIZON, buildingsOnly: true, fadeM: 500 });
    expect(sanitizeFogHorizon({ fadeM: -3 }, s).fadeM).toBe(0);
    expect(sanitizeFogHorizon({ reset: true, includeAttachments: true } as never, s)).toEqual({ ...DEFAULT_FOG_HORIZON, includeAttachments: true });
  });
  it('the diff holds only the non-default fields (what a document saves)', () => {
    expect(fogHorizonDiff(sanitizeFogHorizon({ buildingsOnly: true, fadeStyle: 'dither-coarse' }))).toEqual({ buildingsOnly: true, fadeStyle: 'dither-coarse' });
  });
  it('active only with Hard edge + linear fog', () => {
    expect(fogHorizonActive(true, { mode: 'linear' })).toBe(true);
    expect(fogHorizonActive(false, { mode: 'linear' })).toBe(false);
    expect(fogHorizonActive(true, { mode: 'exponential' })).toBe(false);
    expect(fogHorizonActive(true, { mode: 'off' })).toBe(false);
  });
  it('the fog edge is where the linear factor reaches 1 (min width 0.001 like the shader)', () => {
    expect(fogHorizonEdge({ near: 3, far: 10 })).toBe(10);
    expect(fogHorizonEdge({ near: 10, far: 10 })).toBeCloseTo(10.001, 9);
    expect(fogHorizonEdge({ near: 12, far: 10 })).toBeCloseTo(12.001, 9);
  });
  it('flags: 0 when inactive; fast path always when active; fade only with buildingsOnly and a band', () => {
    const s = sanitizeFogHorizon({ buildingsOnly: true, fadeStyle: 'dither-coarse', includeAttachments: true });
    expect(fogHorizonFlags(false, s, 1)).toBe(0);
    expect(fogHorizonFlags(false, s, 1, false)).toBe(0);
    // Hard edge on but the rules inactive (exp fog): only the HARD bit (noFog 'hardEdge' meshes still skip the fog)
    expect(fogHorizonFlags(false, s, 1, true)).toBe(FOG_HORIZON_HARD);
    expect(fogHorizonFlags(true, defaultFogHorizon(), 1)).toBe(FOG_HORIZON_FAST | FOG_HORIZON_HARD);
    expect(fogHorizonFlags(true, s, 1)).toBe(FOG_HORIZON_FAST | FOG_HORIZON_FADE | FOG_HORIZON_COARSE | FOG_HORIZON_ATTACH | FOG_HORIZON_HARD);
    expect(fogHorizonFlags(true, s, 0) & FOG_HORIZON_FADE).toBe(0);
    // the outline cut bit follows silhouetteOutlines (the renderer sets fogCut under the same condition)
    expect(fogHorizonFlags(true, defaultFogHorizon(), 1) & FOG_HORIZON_OUTLINE_CUT).toBe(0);
    expect(fogHorizonFlags(true, sanitizeFogHorizon({ silhouetteOutlines: false }), 1) & FOG_HORIZON_OUTLINE_CUT).toBe(FOG_HORIZON_OUTLINE_CUT);
    expect(fogHorizonFlags(false, sanitizeFogHorizon({ silhouetteOutlines: false }), 1)).toBe(0);
  });
  it('class culling: other always, attachments unless included, buildings never', () => {
    const on = sanitizeFogHorizon({ buildingsOnly: true }), withA = sanitizeFogHorizon({ buildingsOnly: true, includeAttachments: true });
    expect([0, 1, 2].map((c) => fogClassCulled(c, on))).toEqual([false, true, true]);
    expect([0, 1, 2].map((c) => fogClassCulled(c, withA))).toEqual([false, false, true]);
    expect([0, 1, 2].map((c) => fogClassCulled(c, defaultFogHorizon()))).toEqual([false, false, false]);
  });
});

describe('fog eye', () => {
  it('perspective: exactly the camera position (bit-identical fog)', () => {
    const pos = new Float32Array([1.1, 2.2, 3.3]);
    const e = computeFogEye({ mode: 'perspective', position: pos, target: [0, 0, 0], orthoSize: 5, fov: 1 });
    expect([...e]).toEqual([...pos]);
    // packed: floats 268-270 equal the camera position floats 16-18 bit for bit
    const d = new Float32Array(272);
    packSceneUniforms(d, { ...minimalPack(), camPos: pos, fogEye: e });
    expect([d[268], d[269], d[270]]).toEqual([d[16], d[17], d[18]]);
  });
  it('ortho: the equivalent-perspective eye = where the 2D perspective view puts its camera for the same framing', () => {
    // scene3d-armature _applyIllustrationCamera: ortho at (cx, cy, 10) looking at (cx, cy, 0) with orthoSize = 1/zoom;
    // perspective2D at (cx, cy, orthoSize / tan(fov/2)).
    const fov = Math.PI / 4, orthoSize = 2.5, cx = 0.3, cy = -0.7;
    const e = computeFogEye({ mode: 'orthographic', position: [cx, cy, 10], target: [cx, cy, 0], orthoSize, fov });
    expect(e[0]).toBeCloseTo(cx, 12); expect(e[1]).toBeCloseTo(cy, 12);
    expect(e[2]).toBeCloseTo(orthoSize / Math.tan(fov / 2), 12);
    // independent of the (invisible) ortho dolly distance
    const e2 = computeFogEye({ mode: 'orthographic', position: [cx, cy, 400], target: [cx, cy, 0], orthoSize, fov });
    expect([...e2].map((v) => +v.toFixed(9))).toEqual([...e].map((v) => +v.toFixed(9)));
  });
  it('ortho free-3D orbit: along the view direction, orthoSize / tan(fov/2) back from the target', () => {
    const e = computeFogEye({ mode: 'orthographic', position: [10, 10, 0], target: [0, 0, 0], orthoSize: 1, fov: Math.PI / 4 });
    const d = 1 / Math.tan(Math.PI / 8);
    expect(e[0]).toBeCloseTo(d / Math.SQRT2, 9); expect(e[1]).toBeCloseTo(d / Math.SQRT2, 9); expect(e[2]).toBeCloseTo(0, 9);
  });
});

describe('flags2 (material-3d.ts: the second per-object flags word)', () => {
  it('fog classes map to the fade bits; everything else is 0 (the old lane value)', async () => {
    const { encodeMeshFlags2, FLAGS2_DISTANCE_FADE, FLAGS2_DISTANCE_FADE_ATTACH, FLAGS2_FLOAT } = await import('./material-3d');
    expect(FLAGS2_FLOAT).toBe(28);   // MeshInstance float 28 = normalMatrix column 3 .x
    expect([0, 1, 2].map((c) => encodeMeshFlags2({ fogClass: c }))).toEqual([0, FLAGS2_DISTANCE_FADE_ATTACH, FLAGS2_DISTANCE_FADE]);
    expect(encodeMeshFlags2({})).toBe(0);
    // integer-valued floats survive the f32 store exactly (never a bitcast: the lane is multiplied by 0)
    const f = new Float32Array(1); f[0] = FLAGS2_DISTANCE_FADE | FLAGS2_DISTANCE_FADE_ATTACH; expect(f[0] >>> 0).toBe(3);
  });
  it('Material3D.noFog: bit 2 (always) / bit 3 (under Hard edge); a no-fog mesh never carries the fade bits', async () => {
    const { encodeMeshFlags2, fogCullClass, FLAGS2_NO_FOG, FLAGS2_NO_FOG_HARD_EDGE } = await import('./material-3d');
    expect(FLAGS2_NO_FOG).toBe(4); expect(FLAGS2_NO_FOG_HARD_EDGE).toBe(8);
    expect(encodeMeshFlags2({ fogClass: 2, material: { noFog: true } })).toBe(FLAGS2_NO_FOG);
    expect(encodeMeshFlags2({ fogClass: 1, material: { noFog: 'hardEdge' } })).toBe(FLAGS2_NO_FOG_HARD_EDGE);
    expect(encodeMeshFlags2({ fogClass: 0, material: { noFog: false } })).toBe(0);
    expect(encodeMeshFlags2({ fogClass: 2, material: {} })).toBe(1);
    // the CPU fog cull treats a no-fog mesh as class 0 (always kept)
    expect(fogCullClass({ fogClass: 2, material: { noFog: 'hardEdge' } })).toBe(0);
    expect(fogCullClass({ fogClass: 2, material: {} })).toBe(2);
  });
});

function minimalPack() {
  return {
    vp: mat4.create() as Float32Array, camPos: [0, 0, 0], orthographic: false, ambientColor: [0, 0, 0] as [number, number, number], ambientIntensity: 1,
    light: { direction: [0, -1, 0] as [number, number, number], color: [1, 1, 1] as [number, number, number], intensity: 1 },
    ps1: { vertexJitter: 0, snapGridSize: 0, affineStrength: 0, colorDepth: 0 }, w: 1, h: 1, shadowMinLight: 0, glassRefraction: 0,
    lightSpaceMatrix: null, shadowPcfRadius: 0, effBias: 0, shadowMapSize: 1, shadowSoftness: 1,
    fog: { color: [0, 0, 0] as [number, number, number], mode: 'linear' as const, near: 1, far: 2, density: 0 }, aerialFog: 0, pointLights: [],
    wind: { dirDeg: 0, strength: 0, speed: 0 }, glassQuality: 0, timeSec: 0, softLightStrength: 0,
    skinRamp: { bands: 1, softness: 0, shadowFloor: 0, tintPacked: 0 }, sketchPaper: 0,
    toon: { bands: 1, softness: 0, shadowValue: 0, tintPacked: 0, saturation: 0 }, rim: { strength: 0, width: 0, hardness: 0, colorPacked: 0 },
  };
}
