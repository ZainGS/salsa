/**
 * Body HIP / CROTCH weight regression (clothing fit round 2, 2026-10-04). The pelvis rings + crotch bridge were 100 %
 * hips next to a 55 % thigh ring, so a raised thigh folded / stretched that one band (and every garment copying the
 * body weights tore with it). hip-weight-smooth.ts diffuses the pelvis → thigh weights on new (seam-blended) bodies.
 *   1. hip-region skin: stretched (> 2× area) + folded triangles summed over the leg ROM poses — fails if it gets worse;
 *   2. the classic (seamBlend 0) body is untouched (saved characters stay bit-identical) — its count is pinned too;
 *   3. trousers / shorts / skirt absolute worst tear over the ROM sweep (they inherit the fix).
 * Measured: NEW 409 → 102 (run 51 → 15, sit 81 → 25, squat 83 → 30; with the mid-thigh knee share 0.25 → 0.1 that
 * also landed in round 2); CLASSIC 399 (unchanged).
 */
import { describe, it, expect } from 'vitest';
import { bodyFor, CONFIGS, ROM_POSES, measureGarment } from './clothing-audit-harness';
import { measureDeformation } from './skin-deform-metrics';
import { generateBottom, clothingPreset, type BottomParams } from './clothing-generator';

const LEG_POSES = ['legs: run', 'legs: sit', 'legs: squat', 'legs: lunge', 'legs: kick forward', 'legs: walk', 'legs: splits side', 'legs: side 45', 'torso: bend forward', 'torso: twist'];
const HIP = ['hips', 'upperleg_L', 'upperleg_R'];

function hipBad(cfgIdx: number): { total: number; per: Record<string, number> } {
    const cfg = CONFIGS[cfgIdx];
    const { m } = bodyFor(cfg);
    const per: Record<string, number> = {};
    let total = 0;
    for (const pn of LEG_POSES) {
        const d = measureDeformation(m, ROM_POSES[pn], HIP, undefined, cfg.method === 'dualQuat' ? 'dqs' : 'lbs');
        per[pn] = d.stretched + d.folded; total += per[pn];
    }
    return { total, per };
}

describe('body hip / crotch weights (fit round 2)', () => {
    it('new bodies: hip-region skin folds / stretches far less than before (was 409, now 102)', () => {
        const r = hipBad(0);
        expect(r.total, JSON.stringify(r.per)).toBeLessThanOrEqual(106);
        expect(r.per['legs: squat']).toBeLessThanOrEqual(32);
        expect(r.per['legs: run']).toBeLessThanOrEqual(16);
    });

    it('classic (saved) bodies keep their weights exactly (count pinned)', () => {
        expect(hipBad(1).total).toBe(399);
    });

    it('bottoms inherit it: absolute worst tear over the ROM sweep', () => {
        const limits: Record<string, number> = { 'Pants': 8.5, 'Skinny': 8.5, 'Shorts': 24, 'Skirt': 13 };
        const fails: string[] = [];
        for (const [name, lim] of Object.entries(limits)) {
            const { results } = measureGarment((f) => generateBottom(f, clothingPreset('bottom', name) as BottomParams), ROM_POSES);
            const worst = Math.max(...Object.values(results).map((c) => c.stretchPct + c.foldPct));
            if (worst > lim) fails.push(`${name}: worst tear ${worst.toFixed(1)}% > ${lim}`);
        }
        expect(fails).toEqual([]);
    }, 120_000);
});
