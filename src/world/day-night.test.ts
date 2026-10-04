import { describe, it, expect } from 'vitest';
import { computeDayNight, skyAt, DEFAULT_SKY } from './day-night';

describe('computeDayNight — the daily curves', () => {
    it('noon is full day, midnight full night, with a soft twilight band between', () => {
        const noon = computeDayNight(0.5);
        const midnight = computeDayNight(0);
        expect(noon.day).toBe(1);
        expect(noon.night).toBe(0);
        expect(midnight.day).toBe(0);
        expect(midnight.night).toBe(1);
        const twilight = computeDayNight(0.25);          // sunrise: elev 0 → day = 0.12/0.45 ≈ 0.267
        expect(twilight.day).toBeGreaterThan(0);
        expect(twilight.day).toBeLessThan(1);
    });

    it('the dusk burst peaks at the horizon crossings and vanishes at noon/midnight', () => {
        expect(computeDayNight(0.75).dusk).toBeGreaterThan(0.5);   // sunset
        expect(computeDayNight(0.5).dusk).toBeLessThan(0.01);
        expect(computeDayNight(0).dusk).toBeLessThan(0.01);        // gated by clamp01(day*3) = 0 at night
    });

    it('sun elevation is capped at noon (readable shadows) and the azimuth sweeps the compass', () => {
        const noon = computeDayNight(0.5);
        expect(noon.sunDir[1]).toBeCloseTo(-0.85, 6);              // capped, not straight down
        // Horizontal direction rotates over the day: Z flips across noon, X flips across midnight —
        // together the sweep covers the full compass (the fix for the old pinned-dirZ narrow wedge).
        const morning = computeDayNight(0.33).sunDir;
        const evening = computeDayNight(0.67).sunDir;
        expect(Math.sign(morning[2])).not.toBe(Math.sign(evening[2]));
        expect(Math.sign(computeDayNight(0.3).sunDir[0])).not.toBe(Math.sign(computeDayNight(0.9).sunDir[0]));
        // Direction is ~unit length.
        for (const d of [noon.sunDir, morning, evening]) {
            expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 1);
        }
    });

    it('day is brighter than night; lightning flash lifts both lights', () => {
        expect(computeDayNight(0.5).sunIntensity).toBeGreaterThan(computeDayNight(0).sunIntensity);
        const calm = computeDayNight(0.1);
        const storm = computeDayNight(0.1, { flash: 1 });
        expect(storm.sunIntensity).toBeGreaterThan(calm.sunIntensity);
        expect(storm.ambientIntensity).toBeGreaterThan(calm.ambientIntensity);
    });

    it('weather greys the key light and closes the fog in', () => {
        const clear = computeDayNight(0.5);
        const rain = computeDayNight(0.5, { weather: 'rain' });
        const snow = computeDayNight(0.5, { weather: 'snow' });
        expect(rain.sunIntensity).toBeLessThan(clear.sunIntensity);
        // Rain drags the warm noon key toward grey: red channel drops.
        expect(rain.sunColor[0]).toBeLessThan(clear.sunColor[0]);
        expect(rain.fogFarMult).toBeGreaterThan(clear.fogFarMult); // ramp doubled but far pushed out (lighter haze build)
        expect(snow.fogNearMult).toBeLessThan(clear.fogNearMult);  // winter haze starts closer
    });

    it('street lamps are off by day and ramp on as night deepens', () => {
        expect(computeDayNight(0.5).lampOn).toBe(0);
        expect(computeDayNight(0).lampOn).toBe(1);                 // full night ⇒ full lamps
        const twilightLamp = computeDayNight(0.79).lampOn;         // just after sunset
        expect(twilightLamp).toBeGreaterThanOrEqual(0);
        expect(twilightLamp).toBeLessThanOrEqual(1);
    });
});

describe('skyAt — keyframe lerp around the day', () => {
    it('hits the four keyframes exactly at their phases', () => {
        expect(skyAt(0, DEFAULT_SKY)).toEqual(DEFAULT_SKY.night);
        expect(skyAt(0.25, DEFAULT_SKY)).toEqual(DEFAULT_SKY.dawn);
        expect(skyAt(0.5, DEFAULT_SKY)).toEqual(DEFAULT_SKY.noon);
        expect(skyAt(0.75, DEFAULT_SKY)).toEqual(DEFAULT_SKY.dusk);
    });

    it('midpoints are the average of adjacent keys; t wraps', () => {
        const mid = skyAt(0.375, DEFAULT_SKY);                     // dawn↔noon midpoint
        for (let i = 0; i < 3; i++) {
            expect(mid.top[i]).toBeCloseTo((DEFAULT_SKY.dawn.top[i] + DEFAULT_SKY.noon.top[i]) / 2, 9);
        }
        expect(skyAt(1.25, DEFAULT_SKY)).toEqual(skyAt(0.25, DEFAULT_SKY));
        expect(skyAt(-0.75, DEFAULT_SKY)).toEqual(skyAt(0.25, DEFAULT_SKY));
    });
});

describe('keyFill (persona-polish A4)', () => {
    it('absent / 0 = the original curves exactly', () => {
        expect(computeDayNight(0.5, { keyFill: 0 })).toEqual(computeDayNight(0.5));
    });
    it('by day: a warmer, stronger sun over a lower, less blue fill; night untouched', () => {
        const a = computeDayNight(0.5), b = computeDayNight(0.5, { keyFill: 1 });
        expect(b.sunIntensity).toBeGreaterThan(a.sunIntensity);
        expect(b.ambientIntensity).toBeLessThan(a.ambientIntensity);
        expect(b.sunColor[2] / b.sunColor[0]).toBeLessThan(a.sunColor[2] / a.sunColor[0]);          // warmer key
        expect(b.ambientColor[2] - b.ambientColor[0]).toBeLessThan(a.ambientColor[2] - a.ambientColor[0]);   // less blue fill
        expect(computeDayNight(0.0, { keyFill: 1 })).toEqual(computeDayNight(0.0));
    });
});
