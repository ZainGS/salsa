import { describe, it, expect } from 'vitest';
import { DustSystem, DUST_KINDS, DUST_GPU_FLOATS, DUST_SHAPE_DROP, DUST_SHAPE_PUFF, dustColor, dustFog, footStrikeBetween, landingDustKind, type DustBurst, type DustLighting } from './landing-dust';

const NOON: DustLighting = {
    ambient: [0.5, 0.5, 0.55], ambientIntensity: 0.5, sun: [1, 0.97, 0.9], sunIntensity: 1, sunElevation: 0.85,
    fogMode: 'off', fogColor: [0.7, 0.75, 0.8], fogNear: 0, fogFar: 1, fogDensity: 0, distance: 3,
};
const burst = (kind: DustBurst['kind'], o: Partial<DustBurst> = {}): DustBurst => ({ x: 0, y: 0, z: 0, kind, scale: 1, color: [0.8, 0.75, 0.7], ...o });
/** Max horizontal spread (from the burst point) reached by the particles over `secs`. */
function spread(s: DustSystem, secs: number): number {
    let max = 0;
    for (let i = 0; i < secs * 60; i++) {
        s.tick(1 / 60);
        const g = s.gpuData; if (!g) break;
        for (let k = 0; k < s.activeCount; k++) max = Math.max(max, Math.hypot(g[k * DUST_GPU_FLOATS], g[k * DUST_GPU_FLOATS + 2]));
    }
    return max;
}

describe('landing dust — DustSystem', () => {
    it('ZERO COST when idle: nothing allocated before a burst, released once the last particle dies', () => {
        const s = new DustSystem(1);
        expect(s.allocated).toBe(false);
        for (let i = 0; i < 120; i++) s.tick(1 / 60);
        expect(s.allocated).toBe(false); expect(s.allocations).toBe(0); expect(s.activeCount).toBe(0);
        expect(s.emit(burst('land'))).toBeGreaterThan(0);
        expect(s.allocated).toBe(true);
        for (let i = 0; i < 3 * 60; i++) s.tick(1 / 60);                     // every kind lives < 1 s
        expect(s.allocated).toBe(false); expect(s.count).toBe(0); expect(s.gpuData).toBeNull();
    });

    it('sized by the landing type: Land Deep > Land > Land Soft (count and spread); a step is tiny', () => {
        const n = (k: DustBurst['kind']) => new DustSystem(2).emit(burst(k));
        expect(n('landDeep')).toBe(DUST_KINDS.landDeep.count + (DUST_KINDS.landDeep.core ?? 0));
        expect(n('land')).toBe(DUST_KINDS.land.count);
        expect(n('landSoft')).toBe(DUST_KINDS.landSoft.count);
        expect(n('landDeep')).toBeGreaterThan(n('land'));
        expect(n('land')).toBeGreaterThan(n('landSoft'));
        expect(n('landSoft')).toBeGreaterThan(n('step'));
        const sp = (k: DustBurst['kind']) => { const s = new DustSystem(3); s.emit(burst(k)); return spread(s, 1); };
        expect(sp('landDeep')).toBeGreaterThan(sp('land'));
        expect(sp('land')).toBeGreaterThan(sp('landSoft'));
        expect(sp('landSoft')).toBeGreaterThan(sp('step'));
    });

    it('a splash throws droplets under gravity (shape 2) plus a low spray ring; a dust burst is all puffs', () => {
        const s = new DustSystem(4);
        s.emit(burst('splash'));
        s.tick(1 / 60);
        const shapes = new Uint32Array(s.gpuData!.buffer);
        let drops = 0, puffs = 0;
        for (let k = 0; k < s.activeCount; k++) { const sh = shapes[k * DUST_GPU_FLOATS + 9]; if (sh === DUST_SHAPE_DROP) drops++; else if (sh === DUST_SHAPE_PUFF) puffs++; }
        expect(drops).toBe(DUST_KINDS.splash.drops); expect(puffs).toBe(DUST_KINDS.splash.count);
        // Droplets rise, then fall back below their start (gravity), within their life.
        let maxY = -Infinity, minYLate = Infinity;
        for (let i = 0; i < 25; i++) {
            s.tick(1 / 60);
            for (let k = 0; k < s.activeCount; k++) if (shapes[k * DUST_GPU_FLOATS + 9] === DUST_SHAPE_DROP) {
                const y = s.gpuData![k * DUST_GPU_FLOATS + 1];
                if (i < 10) maxY = Math.max(maxY, y); else minYLate = Math.min(minYLate, y);
            }
        }
        expect(maxY).toBeGreaterThan(0.05);
        const d = new DustSystem(4); d.emit(burst('land')); d.tick(1 / 60);
        const ds = new Uint32Array(d.gpuData!.buffer);
        for (let k = 0; k < d.activeCount; k++) expect(ds[k * DUST_GPU_FLOATS + 9]).toBe(DUST_SHAPE_PUFF);
    });

    it('scales with the character: a 2× giant spreads twice as far, a doll a fraction', () => {
        const at = (scale: number) => { const s = new DustSystem(5); s.emit(burst('land', { scale })); return spread(s, 1); };
        expect(at(2) / at(1)).toBeCloseTo(2, 1);
        expect(at(0.1) / at(1)).toBeCloseTo(0.1, 1);
    });

    it('deterministic for a seed; capped at capacity; rejects bad input', () => {
        const run = (seed: number) => { const s = new DustSystem(seed); s.emit(burst('landDeep', { impact: 1.3 })); s.tick(0.1); return Array.from(s.gpuData!.subarray(0, s.activeCount * DUST_GPU_FLOATS)); };
        expect(run(9)).toEqual(run(9));
        expect(run(9)).not.toEqual(run(10));
        const s = new DustSystem(1, 16);
        for (let i = 0; i < 10; i++) s.emit(burst('landDeep'));
        expect(s.count).toBe(16);
        const b = new DustSystem(1);
        expect(b.emit(burst('land', { scale: 0 }))).toBe(0);
        expect(b.emit(burst('land', { x: NaN }))).toBe(0);
        expect(b.allocated).toBe(false);
    });
});

describe('landing dust — colour, kind, footsteps', () => {
    it('coloured by the ground, darker at night, fogged with distance', () => {
        const red = dustColor([0.8, 0.2, 0.1], NOON), grey = dustColor([0.5, 0.5, 0.5], NOON);
        expect(red[0] - red[2]).toBeGreaterThan(grey[0] - grey[2] + 0.1);   // a red dirt kicks up reddish dust
        const night = dustColor([0.5, 0.5, 0.5], { ...NOON, sunIntensity: 0.05, sunElevation: 0, ambientIntensity: 0.12, ambient: [0.3, 0.35, 0.5] });
        expect(night[1]).toBeLessThan(grey[1] * 0.5);
        const fogL: DustLighting = { ...NOON, fogMode: 'linear', fogNear: 10, fogFar: 50, fogColor: [0.2, 0.4, 0.9] };
        expect(dustFog({ ...fogL, distance: 5 })).toBe(0);
        expect(dustFog({ ...fogL, distance: 30 })).toBeCloseTo(0.5, 6);
        const far = dustColor([0.5, 0.5, 0.5], { ...fogL, distance: 60 });
        expect(far).toEqual([0.2, 0.4, 0.9]);
        // A splash (the driver passes no ground colour) is a pale, cool water tone.
        const water = dustColor(null, NOON, true);
        expect(water[2]).toBeGreaterThan(water[0]);
    });

    it('the landing clip picks the variant (Land / Land Deep / Land Soft), else the impact; a tiny drop raises none', () => {
        expect(landingDustKind('Land Deep', 1)).toBe('landDeep');
        expect(landingDustKind('Land Soft', 1)).toBe('landSoft');
        expect(landingDustKind('Land', 0.9)).toBe('land');
        expect(landingDustKind('Land', 1.5)).toBe('landDeep');
        expect(landingDustKind(null, 0.4)).toBe('landSoft');
        expect(landingDustKind(null, 1.6)).toBe('landDeep');
        expect(landingDustKind('Land', 0.1)).toBeNull();
    });

    it('foot strikes at gait phase 0 (left, the wrap) and 0.5 (right)', () => {
        expect(footStrikeBetween(0.45, 0.52)).toBe('R');
        expect(footStrikeBetween(0.97, 0.02)).toBe('L');
        expect(footStrikeBetween(0.1, 0.2)).toBeNull();
        expect(footStrikeBetween(0.3, 0.3)).toBeNull();
        expect(footStrikeBetween(NaN, 0.6)).toBeNull();
    });
});
