import { describe, it, expect } from 'vitest';
import { vec3, vec4, mat4 } from 'gl-matrix';
import {
    packSceneUniforms, selectNearestPointLights, computeLightSpaceMatrix, computeCascadeMatrix, cascadeCentre,
    MAX_POINT_LIGHTS, type PointLight3D, type ScenePackParams,
} from './scene-uniforms';
import { cascadeHalfExtents, sanitizeShadowCascades, DEFAULT_SHADOW_CASCADES } from './shadow-cascades';

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
        softLightStrength: 0.6,
        skinRamp: { bands: 2, softness: 0.08, shadowFloor: 0.4, tintPacked: 12345 },
        sketchPaper: 0.75,
        toon: { bands: 2, softness: 0.04, shadowValue: 0.62, tintPacked: 4242, saturation: 0.25 },
        rim: { strength: 0, width: 0.25, hardness: 0.85, colorPacked: 777 },
        ...over,
    };
}

describe('packSceneUniforms — the SceneUniforms float-offset contract', () => {
    it('packs the Sketch paper amount at styleParams.x (float 208), reserved .yzw zeroed', () => {
        const data = new Float32Array(220).fill(9);
        packSceneUniforms(data, baseParams({ sketchPaper: 0.3 }));
        expect(data[208]).toBeCloseTo(0.3);
        expect(data[209]).toBe(4242); expect(data[210]).toBeCloseTo(0.25); expect(data[211]).toBe(0);   // toon tint + saturation
    });
    it('packs toonParams (212-215) and rimParams (216-219)', () => {
        const data = new Float32Array(220);
        packSceneUniforms(data, baseParams({ rim: { strength: 1.2, width: 0.3, hardness: 1, colorPacked: 999 } }));
        expect([...data.slice(212, 216)].map((v) => +v.toFixed(3))).toEqual([2, 0.04, 0.62, 0]);
        expect([...data.slice(216, 220)].map((v) => +v.toFixed(3))).toEqual([1.2, 0.3, 1, 999]);
    });

    it('packs heightFog (220-223) into a 224-float buffer; default off; old 220-float buffers are untouched', () => {
        const d = new Float32Array(224).fill(9);
        packSceneUniforms(d, baseParams());
        expect([...d.slice(220, 224)]).toEqual([0, 0, 0, 0]);
        packSceneUniforms(d, baseParams({ heightFog: [0.5, 1, 2, 0.1] }));
        expect([...d.slice(220, 224)].map((v) => +v.toFixed(3))).toEqual([0.5, 1, 2, 0.1]);
        expect(() => packSceneUniforms(new Float32Array(220), baseParams({ heightFog: [1, 1, 1, 1] }))).not.toThrow();
    });

    it('packs camera, ambient, light, ps1, resolution, fog, wind, ps1b at their WGSL offsets', () => {
        const data = new Float32Array(220);
        packSceneUniforms(data, baseParams());
        // cameraPosition vec4 (16–19), .w = ortho flag
        expect([...data.slice(16, 20)]).toEqual([1, 2, 3, 0]);
        // ambient (20–23)
        expect(data[20]).toBeCloseTo(0.1); expect(data[23]).toBeCloseTo(0.9);
        // light dir + intensity (24–27), color (28–31, w=0)
        expect(data[25]).toBeCloseTo(-1); expect(data[27]).toBeCloseTo(1.4);
        expect(data[28]).toBeCloseTo(1); expect(data[31]).toBeCloseTo(0.6);   // lightColor.rgb + .w = softLightStrength
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
        // skinRampParams (204–207): bands, softness, shadowFloor, packed tint — appended after the point-light array
        expect(data[204]).toBe(2); expect(data[205]).toBeCloseTo(0.08);
        expect(data[206]).toBeCloseTo(0.4); expect(data[207]).toBe(12345);
    });

    it('ortho flag, fog-mode encodings, and dither/uvQ gating', () => {
        const data = new Float32Array(220);
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
        const data = new Float32Array(220);
        packSceneUniforms(data, baseParams({ aerialFog: 0.35 }));
        expect(data[63]).toBeCloseTo(0.35);
        packSceneUniforms(data, baseParams({ aerialFog: 0 }));
        expect(data[63]).toBe(0);
    });

    it('shadow block (40–59) written only with a matrix; otherwise left untouched (stale-ok contract)', () => {
        const data = new Float32Array(220).fill(7);
        const lsm = new Float32Array(16).fill(0.5);
        packSceneUniforms(data, baseParams({ lightSpaceMatrix: lsm }));
        expect(data[40]).toBe(0.5); expect(data[55]).toBe(0.5);
        expect([...data.slice(56, 60)].map((v) => +v.toFixed(4))).toEqual([1, 0.005, 1024, 2.5]);
        // No matrix → block untouched (the shaders don't read it when shadows are off)
        const data2 = new Float32Array(220).fill(7);
        packSceneUniforms(data2, baseParams({ lightSpaceMatrix: null }));
        expect(data2[40]).toBe(7); expect(data2[56]).toBe(7);
    });

    it('point lights: count at 72, 2 vec4s per light from 76; empty slots zero radius+intensity', () => {
        const data = new Float32Array(220).fill(9);
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

describe('shadow cascades (persona-polish A2)', () => {
    const scratch = () => ({ eye: vec3.create(), up: vec3.create(), view: mat4.create(), proj: mat4.create(), out: mat4.create() });
    const ndc = (m: Float32Array, p: [number, number, number]) => {
        const c = vec4.transformMat4(vec4.create(), vec4.fromValues(p[0], p[1], p[2], 1), m as unknown as mat4);
        return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
    };
    it('computeCascadeMatrix: centre lands within one texel of the box centre, depth inside 0..1 (orthoZO)', () => {
        const out = new Float32Array(16);
        const m = computeCascadeMatrix([0.4, -0.8, 0.45], 2, [3, 0.1, -5], 20, 5, 2048, scratch(), out);
        const [x, y, z] = ndc(m, [3, 0.1, -5]);
        expect(Math.abs(x)).toBeLessThan(2 / 2048); expect(Math.abs(y)).toBeLessThan(2 / 2048);
        expect(z).toBeGreaterThan(0); expect(z).toBeLessThan(1);
        // A caster 15 units UP the sun ray from the centre is still inside the depth range (back = 20).
        const d = [0.4, -0.8, 0.45], dl = Math.hypot(0.4, 0.8, 0.45);
        const up: [number, number, number] = [3 - d[0] / dl * 15, 0.1 - d[1] / dl * 15, -5 - d[2] / dl * 15];
        const zu = ndc(m, up)[2];
        expect(zu).toBeGreaterThan(0); expect(zu).toBeLessThan(z);
    });
    it('computeCascadeMatrix is TEXEL-STABLE: a sub-texel camera move leaves a world point on the same texel grid', () => {
        const he = 2, size = 2048, texelNdc = 2 / size;
        const a = computeCascadeMatrix([0.3, -0.9, 0.2], he, [1, 0, 1], 10, 5, size, scratch(), new Float32Array(16));
        const b = computeCascadeMatrix([0.3, -0.9, 0.2], he, [1.0004, 0, 1.0003], 10, 5, size, scratch(), new Float32Array(16));
        const p: [number, number, number] = [1.3, 0, 0.8];
        const pa = ndc(a, p), pb = ndc(b, p);
        // Either identical, or shifted by a whole texel — never a fraction (the shimmer case).
        for (const k of [0, 1]) {
            const shift = (pb[k] - pa[k]) / texelNdc;
            expect(Math.abs(shift - Math.round(shift))).toBeLessThan(1e-3);
        }
    });
    it('cascadeCentre: orbit camera → the target; eye-level camera → ahead of the eye along the horizontal view', () => {
        const o: [number, number, number] = [0, 0, 0];
        expect(cascadeCentre([0, 50, 50], [0, 0, 0], 2, o)).toEqual([0, 0, 0]);
        const c = cascadeCentre([0, 0.1, 0], [0, 0.15, -0.8], 2, o);
        expect(c[0]).toBeCloseTo(0); expect(c[1]).toBeCloseTo(0.1); expect(c[2]).toBeCloseTo(-1.1);
    });
    it('packs the cascade block (224-263) and leaves it off (count 0) by default', () => {
        const d = new Float32Array(264).fill(7);
        packSceneUniforms(d, baseParams());
        expect(d[256]).toBe(0);
        const mats = new Float32Array(32).map((_, i) => i);
        packSceneUniforms(d, baseParams({ cascades: { count: 2, matrices: mats, mapSize: 2048, band: 0.15, bias: [0.001, 0.002] } }));
        expect(d[224]).toBe(0); expect(d[255]).toBe(31);
        expect([...d.slice(256, 260)].map((v) => +v.toFixed(3))).toEqual([2, 2048, 0.15, 0]);
        expect(d[260]).toBeCloseTo(0.001); expect(d[261]).toBeCloseTo(0.002);
    });
    it('fog horizon: fogEye (268-271) defaults to the camera position + band 0; toonParams.w (215) carries the flags; old buffers untouched', () => {
        const d = new Float32Array(272).fill(7);
        packSceneUniforms(d, baseParams());
        expect([...d.slice(268, 272)]).toEqual([1, 2, 3, 0]);   // = camPos, bit-identical perspective fog
        expect(d[215]).toBe(0);                                  // inert by default
        packSceneUniforms(d, baseParams({ fogEye: [4, 5, 6], fogFade: 1.5, fogHorizonFlags: 11 }));
        expect([...d.slice(268, 272)]).toEqual([4, 5, 6, 1.5]);
        expect(d[215]).toBe(11);
        expect([d[16], d[17], d[18]]).toEqual([1, 2, 3]);       // the camera itself is unchanged
        const old = new Float32Array(268).fill(9);
        expect(() => packSceneUniforms(old, baseParams({ fogEye: [4, 5, 6] }))).not.toThrow();
        expect(old.length).toBe(268);
    });
});

describe('cascade layout helpers', () => {
    it('cascadeHalfExtents: fixed near box at street level, grows a little with a low orbit, off when pulled out', () => {
        expect(cascadeHalfExtents(1, 8, 1.6, 0.8)).toEqual([1.6]);
        expect(cascadeHalfExtents(1, 30, 1.6, 8)[0]).toBeCloseTo(3.6);   // low orbit: 0.45 x 8 = 3.6 (< 3 x 1.6)
        expect(cascadeHalfExtents(1, 30, 1.6, 40)).toEqual([]);           // pulled out: the far map alone
        expect(cascadeHalfExtents(1, 2, 1.6, 0.5)).toEqual([]);           // far map already as sharp
        const two = cascadeHalfExtents(2, 8, 1.6, 0.8);
        expect(two[0]).toBeCloseTo(1.6); expect(two[1]).toBeCloseTo(Math.sqrt(1.6 * 8));
        expect(cascadeHalfExtents(0, 8, 1.6, 1)).toEqual([]);
    });
    it('sanitizeShadowCascades clamps and defaults', () => {
        expect(sanitizeShadowCascades({ cascades: 9 as never, mapSize: 99999, blend: 3 })).toMatchObject({ cascades: 3, mapSize: 4096, blend: 0.5 });
        expect(sanitizeShadowCascades(null)).toEqual(DEFAULT_SHADOW_CASCADES);
    });
});
