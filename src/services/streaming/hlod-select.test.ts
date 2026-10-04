import { describe, it, expect } from 'vitest';
import { hlodLevelFor, sanitizeHlod, HLOD_DEFAULTS, HLOD_BAND, HLOD_FOG_IN, HLOD_FOG_OUT, pointBoxDistance, hlodFadeCoverage } from './hlod-select';

// performance-plan P17 — the per-tile HLOD level (mid / far) with hysteresis, the fog rule, the settings clamp.
describe('hlodLevelFor', () => {
    const MID = 80;
    it('mid inside the distance, far past distance × (1 + band); new tiles in the band start mid', () => {
        expect(hlodLevelFor(10, null, MID)).toBe('mid');
        expect(hlodLevelFor(MID * (1 + HLOD_BAND) + 0.01, null, MID)).toBe('far');
        expect(hlodLevelFor(MID * 1.05, null, MID)).toBe('mid');
    });

    it('hysteresis: a tile walking across the threshold changes level once each way, never per step', () => {
        let lv: 'mid' | 'far' | null = null, flips = 0;
        const path: number[] = [];
        for (let d = 40; d <= 120; d += 0.5) path.push(d);
        for (let d = 120; d >= 40; d -= 0.5) path.push(d);
        // jitter ±2 around every step (a camera bobbing at the threshold)
        for (const d of path) for (const j of [0, 2, -2, 1]) { const n = hlodLevelFor(d + j, lv, MID); if (lv && n !== lv) flips++; lv = n; }
        expect(flips).toBe(2);
        // inside the band the previous level holds
        expect(hlodLevelFor(MID * 1.07, 'far', MID)).toBe('far');
        expect(hlodLevelFor(MID * 1.07, 'mid', MID)).toBe('mid');
    });

    it('fog horizon: past Far × FOG_OUT always far; it returns to the distance rule only inside Far × FOG_IN', () => {
        const FAR = 50;
        expect(hlodLevelFor(FAR * HLOD_FOG_OUT + 1, 'mid', 1000, FAR)).toBe('far');
        expect(hlodLevelFor(FAR * (HLOD_FOG_IN + HLOD_FOG_OUT) / 2, 'far', 1000, FAR)).toBe('far');   // in the fog band: held
        expect(hlodLevelFor(FAR * (HLOD_FOG_IN + HLOD_FOG_OUT) / 2, 'mid', 1000, FAR)).toBe('mid');
        expect(hlodLevelFor(FAR * HLOD_FOG_IN - 1, 'far', 1000, FAR)).toBe('mid');   // swaps back while still in the fog (Far < d)
        expect(FAR * HLOD_FOG_IN - 1).toBeGreaterThan(FAR);
        expect(hlodLevelFor(FAR * 2, 'mid', 1000, 0)).toBe('mid');   // fog off → the distance rule only
    });
});

describe('HLOD helpers', () => {
    it('sanitizeHlod clamps and ignores junk', () => {
        const s = sanitizeHlod(HLOD_DEFAULTS, { midTiles: -3, skylineTiles: 99.4, maxTiles: Number.NaN, fade: false, fadeMs: 1e9 } as never);
        expect(s).toEqual({ ...HLOD_DEFAULTS, midTiles: 1, skylineTiles: 24, fade: false, fadeMs: 3000 });
        expect(sanitizeHlod(HLOD_DEFAULTS, null)).toEqual(HLOD_DEFAULTS);
    });
    it('pointBoxDistance and the fade coverage', () => {
        expect(pointBoxDistance(0, 0, 0, -1, -1, -1, 1, 1, 1)).toBe(0);
        expect(pointBoxDistance(5, 0, 0, -1, -1, -1, 1, 1, 1)).toBeCloseTo(4, 12);
        expect(pointBoxDistance(4, 5, 0, -1, -1, -1, 1, 1, 1)).toBeCloseTo(5, 12);
        expect(hlodFadeCoverage(-5, 100)).toBe(0);
        expect(hlodFadeCoverage(50, 100)).toBeCloseTo(0.5, 12);
        expect(hlodFadeCoverage(100, 100)).toBe(1);
        expect(hlodFadeCoverage(0, 0)).toBe(1);
        let prev = -1;
        for (let t = 0; t <= 100; t += 5) { const c = hlodFadeCoverage(t, 100); expect(c).toBeGreaterThanOrEqual(prev); prev = c; }
    });
});
