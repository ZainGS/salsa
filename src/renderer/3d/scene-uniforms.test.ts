import { describe, it, expect } from 'vitest';
import { vec3, vec4, mat4 } from 'gl-matrix';
import {
    packSceneUniforms, selectNearestPointLights, computeLightSpaceMatrix,
    MAX_POINT_LIGHTS, type PointLight3D, type ScenePackParams,
} from './scene-uniforms';

function baseParams(over: Partial<ScenePackParams> = {}): ScenePackParams {
    return {
        vp: mat4.create() as Float32Array,
        camPos: [1, 2, 3],
        orthographic: false,
        ambientColor: [0.1, 0.2, 0.3], ambientIntensity: 0.9,
        light: { direction: [0.5, -1, 0.25], color: [1, 0.9, 0.8], intensity: 1.4 },
        ps1: { vertexJitter: 0.3, snapGridSize: 160, affineStrength: 0.7, colorDepth: 32 },
        w: 800, h: 600,
        shadowMinLight: 0.42, glassRefraction: 1,
        lightSpaceMatrix: null,
        shadowPcfRadius: 1, effBias: 0.005, shadowMapSize: 1024, shadowSoftness: 2.5,
        fog: { color: [0.6, 0.7, 0.8], mode: 'linear', near: 5, far: 50, density: 0.1 },
        aerialFog: 0.35,
        pointLights: [],
        wind: { dirDeg: 90, strength: 0.06, speed: 1.5 },
        glassQuality: 1,
        timeSec: 123.5,
        ...over,
    };
}

describe('packSceneUniforms — the SceneUniforms float-offset contract', () => {
    it('packs camera, ambient, light, ps1, resolution, fog, wind, ps1b at their WGSL offsets', () => {
        const data = new Float32Array(204);
        packSceneUniforms(data, baseParams());
        // cameraPosition vec4 (16–19), .w = ortho flag
        expect([...data.slice(16, 20)]).toEqual([1, 2, 3, 0]);
        // ambient (20–23)
        expect(data[20]).toBeCloseTo(0.1); expect(data[23]).toBeCloseTo(0.9);
        // light dir + intensity (24–27), color (28–31, w=0)
        expect(data[25]).toBeCloseTo(-1); expect(data[27]).toBeCloseTo(1.4);
        expect(data[28]).toBeCloseTo(1); expect(data[31]).toBe(0);
        // ps1 (32–35)
        expect([...data.slice(32, 36)].map((v) => +v.toFixed(3))).toEqual([0.3, 160, 0.7, 32]);
        // resolution (36–39): w, h, shadow floor, glass refraction
        expect([...data.slice(36, 40)].map((v) => +v.toFixed(3))).toEqual([800, 600, 0.42, 1]);
        // fog color (60–62) + params (64–67, linear = 1)
        expect(data[60]).toBeCloseTo(0.6); expect(data[64]).toBe(5); expect(data[65]).toBe(50); expect(data[67]).toBe(1);
        // wind rides lightCounts.yzw (73–75): heading in RADIANS
        expect(data[73]).toBeCloseTo(Math.PI / 2); expect(data[74]).toBeCloseTo(0.06); expect(data[75]).toBeCloseTo(1.5);
        // ps1Config2 (68–71): dither off → 0, uvQ off → 0, time, glass
        expect(data[68]).toBe(0); expect(data[69]).toBe(0);
        expect(data[70]).toBeCloseTo(123.5); expect(data[71]).toBe(1);
    });

    it('ortho flag, fog-mode encodings, and dither/uvQ gating', () => {
        const data = new Float32Array(204);
        packSceneUniforms(data, baseParams({ orthographic: true, fog: { color: [0, 0, 0], mode: 'exponential', near: 0, far: 1, density: 0.2 } }));
        expect(data[19]).toBe(1);
        expect(data[67]).toBe(2);
        packSceneUniforms(data, baseParams({ fog: { color: [0, 0, 0], mode: 'off', near: 0, far: 1, density: 0 } }));
        expect(data[67]).toBe(0);
        // dither enabled uses strength (default 0.5 when unset); zero strength disables
        packSceneUniforms(data, baseParams({ ps1: { vertexJitter: 0, snapGridSize: 0, affineStrength: 0, colorDepth: 32, dither: true, uvQuantize: true } }));
        expect(data[68]).toBe(0.5); expect(data[69]).toBe(64);
        packSceneUniforms(data, baseParams({ ps1: { vertexJitter: 0, snapGridSize: 0, affineStrength: 0, colorDepth: 32, dither: true, ditherStrength: 0 } }));
        expect(data[68]).toBe(0);
    });

    it('aerialFog lands in fogColor.w (63) — written LAST, overriding the fog block zero', () => {
        const data = new Float32Array(204);
        packSceneUniforms(data, baseParams({ aerialFog: 0.35 }));
        expect(data[63]).toBeCloseTo(0.35);
        packSceneUniforms(data, baseParams({ aerialFog: 0 }));
        expect(data[63]).toBe(0);
    });

    it('shadow block (40–59) written only with a matrix; otherwise left untouched (stale-ok contract)', () => {
        const data = new Float32Array(204).fill(7);
        const lsm = new Float32Array(16).fill(0.5);
        packSceneUniforms(data, baseParams({ lightSpaceMatrix: lsm }));
        expect(data[40]).toBe(0.5); expect(data[55]).toBe(0.5);
        expect([...data.slice(56, 60)].map((v) => +v.toFixed(4))).toEqual([1, 0.005, 1024, 2.5]);
        // No matrix → block untouched (the shaders don't read it when shadows are off)
        const data2 = new Float32Array(204).fill(7);
        packSceneUniforms(data2, baseParams({ lightSpaceMatrix: null }));
        expect(data2[40]).toBe(7); expect(data2[56]).toBe(7);
    });

    it('point lights: count at 72, 2 vec4s per light from 76; empty slots zero radius+intensity', () => {
        const data = new Float32Array(204).fill(9);
        const pl = (x: number): PointLight3D => ({ pos: [x, 1, 2], radius: 4, color: [1, 0, 0], intensity: 2 });
        packSceneUniforms(data, baseParams({ pointLights: [pl(10), pl(20)] }));
        expect(data[72]).toBe(2);
        expect([...data.slice(76, 84)]).toEqual([10, 1, 2, 4, 1, 0, 0, 2]);
        expect([...data.slice(84, 92)]).toEqual([20, 1, 2, 4, 1, 0, 0, 2]);
        // slot 2 (empty): only radius (+3) and intensity (+7) forced to 0 — the shader gates on those
        expect(data[76 + 2 * 8 + 3]).toBe(0);
        expect(data[76 + 2 * 8 + 7]).toBe(0);
    });
});

describe('selectNearestPointLights — bounded-insertion nearest-K by ground distance', () => {
    const pl = (x: number, z: number): PointLight3D => ({ pos: [x, 5, z], radius: 1, color: [1, 1, 1], intensity: 1 });

    it('keeps the K nearest (XZ only — height ignored), ascending by distance', () => {
        const cands = [pl(10, 0), pl(1, 0), pl(5, 0), pl(2, 0), pl(8, 0)];
        const out: PointLight3D[] = [], dist: number[] = [];
        selectNearestPointLights(cands, 0, 0, 3, out, dist);
        expect(out.map((l) => l.pos[0])).toEqual([1, 2, 5]);
    });

    it('cands ≤ K → passthrough copy; reused arrays are reset between calls', () => {
        const out: PointLight3D[] = [pl(99, 99)], dist: number[] = [123];
        selectNearestPointLights([pl(1, 1), pl(2, 2)], 0, 0, MAX_POINT_LIGHTS, out, dist);
        expect(out.map((l) => l.pos[0])).toEqual([1, 2]);
        selectNearestPointLights([pl(3, 0), pl(1, 0), pl(2, 0), pl(9, 0), pl(8, 0), pl(7, 0), pl(6, 0), pl(5, 0),
                                  pl(4, 0), pl(10, 0), pl(11, 0), pl(12, 0), pl(13, 0), pl(14, 0), pl(15, 0),
                                  pl(16, 0), pl(17, 0)], 0, 0, 2, out, dist);
        expect(out.map((l) => l.pos[0])).toEqual([1, 2]);
    });
});

describe('computeLightSpaceMatrix — cube ortho box around the snapped centre', () => {
    const scratch = () => ({ eye: vec3.create(), up: vec3.create(), view: mat4.create(), proj: mat4.create(), out: mat4.create() });

    it('maps the box centre to clip (0, 0) with depth inside (0, 1)', () => {
        const c = vec3.fromValues(12, 0, -7);
        const m = computeLightSpaceMatrix([0.4, -0.8, 0.45], 10, c, scratch());
        const clip = vec4.transformMat4(vec4.create(), vec4.fromValues(c[0], c[1], c[2], 1), m as unknown as mat4);
        expect(clip[0] / clip[3]).toBeCloseTo(0, 5);
        expect(clip[1] / clip[3]).toBeCloseTo(0, 5);
        const z = clip[2] / clip[3];
        expect(z).toBeGreaterThan(0); expect(z).toBeLessThan(1);
    });

    it('straight-down sun flips the up vector (no degenerate lookAt) and stays finite', () => {
        const m = computeLightSpaceMatrix([0, -1, 0], 15, vec3.fromValues(0, 0, 0), scratch());
        for (let i = 0; i < 16; i++) expect(Number.isFinite((m as unknown as number[])[i])).toBe(true);
    });
});
