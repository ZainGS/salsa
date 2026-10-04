import { describe, it, expect } from 'vitest';
import {
  buildSkyDomeClouds, skyDomeCloudDistance, evaluateSkyDome, skyDomeView, packSkyDomeHeader,
  SKY_CLOUD_SECTORS, SKY_CLOUD_SECTORS_LOW, SKY_CLOUD_SECTORS_HIGH, SKY_CLOUD_VEC4_PER, SKY_CLOUD_LOBES, SKY_CLOUD_MAX_REACH,
  SKY_DOME_HEADER_VEC4, SKY_DOME_UNIFORM_FLOATS, type SkyDomeParams,
} from './sky-dome';
import { SKY_DOME_WGSL_FS } from './sky-dome-pass';

const TAU = Math.PI * 2;
const base: SkyDomeParams = {
  zenith: [0.03, 0.04, 0.11], horizon: [0.13, 0.12, 0.24], ground: [0.1, 0.1, 0.2], gradientBias: 0.55,
  glowColor: [1, 0.55, 0.32], glowAmount: 0, glowHeight: 0.12,
  sunDir: [0, -1, 0], sunColor: [1, 0.8, 0.6], sunDisc: 0, sunHalo: 0,
  moonDir: [0, Math.sin(0.42), Math.cos(0.42)], moonColor: [0.96, 0.95, 0.86], moon: 0, moonSize: 0.042, moonHalo: 0.55,
  stars: 0, clouds: 0, cloudLit: [1, 1, 1], cloudShade: [0.5, 0.5, 0.6], cloudRim: [1, 0.9, 0.7], cloudRimAmount: 0.5,
  cloudLightDir: [0, 1, 0], cloudGlow: [0, 0, 0], cloudSeed: 3, cloudCoverage: 0.4, cloudDrift: 0.0025,
};
const dirAt = (az: number, el: number): [number, number, number] => [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
const lum = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('sky dome cloud layout', () => {
  it('has the size the shader reads and is deterministic per seed', () => {
    const a = buildSkyDomeClouds(3, 0.4), b = buildSkyDomeClouds(3, 0.4), c = buildSkyDomeClouds(4, 0.4);
    expect(a.length).toBe(SKY_CLOUD_SECTORS * SKY_CLOUD_VEC4_PER * 4);
    expect(SKY_CLOUD_SECTORS).toBe(SKY_CLOUD_SECTORS_LOW + SKY_CLOUD_SECTORS_HIGH);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(SKY_DOME_UNIFORM_FLOATS).toBe((SKY_DOME_HEADER_VEC4 + SKY_CLOUD_SECTORS * SKY_CLOUD_VEC4_PER) * 4);
    // the WGSL array length matches
    expect(SKY_DOME_WGSL_FS).toContain(`array<vec4<f32>, ${SKY_CLOUD_SECTORS * SKY_CLOUD_VEC4_PER}>`);
  });

  it('coverage 0 is an empty sky; more coverage = more clouds', () => {
    const count = (cov: number): number => { const l = buildSkyDomeClouds(7, cov); let n = 0; for (let s = 0; s < SKY_CLOUD_SECTORS; s++) if (l[s * SKY_CLOUD_VEC4_PER * 4 + 2] > 0) n++; return n; };
    expect(count(0)).toBe(0);
    let lo = 0, hi = 0;
    for (let seed = 1; seed <= 20; seed++) { const l = buildSkyDomeClouds(seed, 0.15), h = buildSkyDomeClouds(seed, 0.9); for (let s = 0; s < SKY_CLOUD_SECTORS; s++) { if (l[s * 24 + 2] > 0) lo++; if (h[s * 24 + 2] > 0) hi++; } }
    expect(hi).toBeGreaterThan(lo);
  });

  it('every cloud stays inside its two-sector lookup window and in its elevation band', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const l = buildSkyDomeClouds(seed, 1);
      for (let s = 0; s < SKY_CLOUD_SECTORS; s++) {
        const o = s * SKY_CLOUD_VEC4_PER * 4;
        if (l[o + 2] <= 0) continue;
        const low = s < SKY_CLOUD_SECTORS_LOW, n = low ? SKY_CLOUD_SECTORS_LOW : SKY_CLOUD_SECTORS_HIGH;
        const baseEl = l[o + 1], cosB = l[o + 3];
        let reach = 0, top = 0;
        for (let k = 0; k < SKY_CLOUD_LOBES; k++) { const q = o + (1 + k) * 4; reach = Math.max(reach, Math.abs(l[q]) + l[q + 2]); top = Math.max(top, l[q + 1] + l[q + 2]); }
        // chart x is flattened by cos(base): the azimuth reach must stay within the neighbour sector
        expect(reach / cosB).toBeLessThanOrEqual(SKY_CLOUD_MAX_REACH * TAU / n + 1e-5);
        expect(baseEl).toBeGreaterThan(0);              // never under the horizon
        if (low) expect(baseEl + top).toBeLessThan(0.42);   // the shader's low-layer elevation gate
        else { expect(baseEl).toBeGreaterThan(0.2); expect(baseEl + top).toBeLessThan(0.95); }
      }
    }
  });

  it('the SDF is negative inside a cloud, positive in clear sky, and flat at the base', () => {
    const l = buildSkyDomeClouds(5, 1);
    let s = 0; while (l[s * 24 + 2] <= 0) s++;
    const o = s * 24, az = l[o], baseEl = l[o + 1];
    const mid = o + 3 * 4;   // the middle lobe
    expect(skyDomeCloudDistance(l, az + l[mid] / l[o + 3], baseEl + l[mid + 1])).toBeLessThan(0);
    expect(skyDomeCloudDistance(l, az, baseEl - 0.01)).toBeGreaterThan(0);   // just under the flat base: outside
    expect(skyDomeCloudDistance(l, az, 1.4)).toBeGreaterThan(0);              // near the zenith: no clouds
  });
});

describe('sky dome colour (CPU reference)', () => {
  it('runs zenith at the top to the horizon colour at the horizon, fog colour below', () => {
    const top = evaluateSkyDome([0, 1, 0], base), hz = evaluateSkyDome(dirAt(1, 0.0001), base), down = evaluateSkyDome(dirAt(1, -0.5), base);
    for (let i = 0; i < 3; i++) { expect(top[i]).toBeCloseTo(base.zenith[i], 4); expect(hz[i]).toBeCloseTo(base.horizon[i], 1); expect(down[i]).toBeCloseTo(base.ground[i], 4); }
    // continuous across the horizon (no seam where the city's far fog meets the backdrop)
    const a = evaluateSkyDome(dirAt(2, 0.001), base), b = evaluateSkyDome(dirAt(2, -0.001), base);
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.01);
  });

  it('the city glow warms the horizon and fades up the sky', () => {
    const glow = { ...base, glowAmount: 0.6 };
    const hz0 = evaluateSkyDome(dirAt(0.3, 0.02), base), hz1 = evaluateSkyDome(dirAt(0.3, 0.02), glow);
    const up1 = evaluateSkyDome(dirAt(0.3, 0.8), glow), up0 = evaluateSkyDome(dirAt(0.3, 0.8), base);
    expect(hz1[0] - hz0[0]).toBeGreaterThan(0.05);
    expect(up1[0] - up0[0]).toBeLessThan(0.01);
    expect(hz1[0] - hz0[0]).toBeGreaterThan(hz1[2] - hz0[2]);   // warm (more red than blue)
  });

  it('draws a moon disc brighter than its halo, the halo brighter than the sky', () => {
    const p = { ...base, moon: 1 };
    const m = p.moonDir;
    const disc = evaluateSkyDome(m, p);
    const offAz = Math.atan2(m[2], m[0]), offEl = Math.asin(m[1]);
    const halo = evaluateSkyDome(dirAt(offAz, offEl + 0.07), p), sky = evaluateSkyDome(dirAt(offAz, offEl + 0.07), base);
    expect(lum(disc)).toBeGreaterThan(0.8);
    expect(lum(disc)).toBeGreaterThan(lum(halo));
    expect(lum(halo)).toBeGreaterThan(lum(sky) + 0.02);
    expect(evaluateSkyDome(m, { ...p, moon: 0 })).toEqual(evaluateSkyDome(m, base));
  });

  it('the sun disc shows above the horizon only', () => {
    const up = { ...base, sunDisc: 1, sunHalo: 0.5, sunDir: dirAt(0.5, 0.2) as [number, number, number] };
    expect(lum(evaluateSkyDome(up.sunDir, up))).toBeGreaterThan(lum(evaluateSkyDome(dirAt(0.5 + Math.PI, 0.2), up)) + 0.5);
  });
});

describe('sky dome view + uniforms', () => {
  it('builds an orthonormal camera basis (and survives looking straight up)', () => {
    const v = skyDomeView([0, 0, 0], [0, 0, -5], [0, 1, 0], Math.PI / 4, 1.5);
    expect(v.fwd[2]).toBeCloseTo(-1, 6); expect(v.up[1]).toBeCloseTo(1, 6); expect(Math.abs(v.right[0])).toBeCloseTo(1, 6);
    expect(v.tanX / v.tanY).toBeCloseTo(1.5, 6);
    const s = skyDomeView([0, 0, 0], [0, 10, 0], [0, 1, 0], 1, 1);
    expect(s.right.every(Number.isFinite) && s.up.every(Number.isFinite)).toBe(true);
  });

  it('packs the header slots the WGSL struct reads', () => {
    const out = new Float32Array(SKY_DOME_HEADER_VEC4 * 4);
    const v = skyDomeView([0, 0, 0], [1, 0, 0], [0, 1, 0], 1, 2);
    packSkyDomeHeader(out, { ...base, stars: 0.7, clouds: 1, moon: 0.5 }, v, 800, 600, 12.5);
    expect(out[11]).toBeCloseTo(12.5);           // fwd.w = time
    expect(out[12]).toBe(800); expect(out[13]).toBe(600);
    expect(out[19]).toBeCloseTo(0.7);            // zenith.w = stars
    expect(out[31]).toBe(1);                     // glow.w = cloud opacity
    expect(out[43]).toBeCloseTo(0.5);            // moonDir.w = moon
    expect(SKY_DOME_WGSL_FS).not.toContain('`');
  });
});
