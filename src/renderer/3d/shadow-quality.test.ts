/** P14 shadow quality presets (shadow-quality.ts) and their place in the city LOD settings (world-lod-settings.ts). */
import { describe, it, expect, vi } from 'vitest';
import { SHADOW_QUALITY_PRESETS, shadowQualitySpec, shadowQualityShown, isShadowQualityPreset, DEFAULT_SHADOW_QUALITY } from './shadow-quality';
import { sanitizeCityLodSettings, cityLodSettingsDiff, defaultCityLodSettings, applyLodRendererSettings, cityLodSettingsView } from '../../services/managers/world-lod-settings';

describe('shadow quality presets', () => {
  it("'high' (the default) is today's city setup exactly", () => {
    expect(DEFAULT_SHADOW_QUALITY).toBe('high');
    expect(shadowQualitySpec('high')).toEqual({ pcf: '5x5', cascades: 2, cascadeMapSize: 2048, cascadeInterval: 2, farMapSize: 2048, farIntervalScale: 1 });
  });
  it('maps each preset to the PCF kernel, cascades, map sizes and refresh, cheapest to best', () => {
    const [lo, me, hi, ul] = SHADOW_QUALITY_PRESETS.map(shadowQualitySpec);
    expect(lo).toMatchObject({ pcf: '3x3', cascades: 1, farMapSize: 1024 });
    expect(me).toMatchObject({ pcf: '3x3', cascades: 2, cascadeMapSize: 1024 });
    expect(ul).toMatchObject({ pcf: '5x5', cascades: 3, farMapSize: 4096, cascadeInterval: 1 });
    const cost = (s: ReturnType<typeof shadowQualitySpec>) => (s.pcf === '5x5' ? 25 : 9) + s.cascades * s.cascadeMapSize / 512 + s.farMapSize / 512 - s.farIntervalScale - s.cascadeInterval;
    expect(cost(lo)).toBeLessThan(cost(me)); expect(cost(me)).toBeLessThan(cost(hi)); expect(cost(hi)).toBeLessThan(cost(ul));
    expect(shadowQualitySpec('nope')).toEqual(shadowQualitySpec('high'));
    expect(isShadowQualityPreset('ultra')).toBe(true); expect(isShadowQualityPreset('custom')).toBe(false);
  });
  it("shows 'custom' once the PCF kernel or the cascade count was changed on its own", () => {
    expect(shadowQualityShown('low', '3x3', 1)).toBe('low');
    expect(shadowQualityShown('low', '5x5', 1)).toBe('custom');
    expect(shadowQualityShown('high', '5x5', 3)).toBe('custom');
  });
});

describe('city LOD settings: shadow.quality', () => {
  it('defaults to high, is saved only when changed, and choosing it writes the PCF kernel', () => {
    expect(defaultCityLodSettings().shadow.quality).toBe('high');
    expect(cityLodSettingsDiff(defaultCityLodSettings())).toBeNull();
    const s = sanitizeCityLodSettings({ shadow: { quality: 'low' } });
    expect(s.shadow).toMatchObject({ quality: 'low', pcf: '3x3' });
    expect(cityLodSettingsDiff(s)).toEqual({ shadow: { pcf: '3x3', quality: 'low' } });
    expect(sanitizeCityLodSettings({ shadow: { quality: 'medium', pcf: '5x5' } }).shadow.pcf).toBe('5x5');   // explicit pcf wins
    expect(sanitizeCityLodSettings({ shadow: { quality: 'bogus' } }).shadow.quality).toBe('high');
    // a save from before P14 (no quality field) restores to the default
    const old = JSON.parse(JSON.stringify(defaultCityLodSettings())); delete old.shadow.quality;
    expect(sanitizeCityLodSettings({}, old).shadow.quality).toBe('high');
    expect(sanitizeCityLodSettings({ reset: true }, s).shadow.quality).toBe('high');
  });
  it('the panel view shows the preset or custom; the renderer gets the far-map refresh scale', () => {
    const s = sanitizeCityLodSettings({ shadow: { quality: 'low' } });
    expect(cityLodSettingsView(s, [], 1, 1, { cascades: 1, nearMetres: 24 }).shadow.qualityShown).toBe('low');
    expect(cityLodSettingsView(s, [], 1, 1, { cascades: 2, nearMetres: 24 }).shadow.qualityShown).toBe('custom');
    const sc = { setShadowQuality3D: vi.fn(), setShadowIntervalScale3D: vi.fn() };
    applyLodRendererSettings(sc, s);
    expect(sc.setShadowQuality3D).toHaveBeenCalledWith(1);
    expect(sc.setShadowIntervalScale3D).toHaveBeenCalledWith(2);
    applyLodRendererSettings(sc, null);
    expect(sc.setShadowIntervalScale3D).toHaveBeenLastCalledWith(1);
  });
});
