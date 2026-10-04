/**
 * Clothing REGRESSION GATE — every garment preset × the 26-pose range-of-motion sweep on a NEW character (seam blend
 * 0.5 + dual-quaternion). Fails if any garment pokes/tears more than it did when these limits were measured
 * (2026-09-28, after the waist-tear / trouser-seat / undershirt fixes). Limits = measured + a small margin.
 *   poke  = worst % of covered skin showing through (> 3 mm) · mm = worst depth
 *   tear  = worst EXCESS tear: garment % stretched/folded tris MINUS the skin's own % under it (0 = follows the skin)
 * If a change IMPROVES a garment, tighten its row. To see the current numbers: CLOTH_GATE_PRINT=out.json.
 * Full per-pose report: clothing-rom-sweep.test.ts. Method: clothing-audit-harness.ts.
 */
import { describe, it, expect } from 'vitest';
import { ALL_GARMENTS, ROM_POSES, measureGarment } from './clothing-audit-harness';

type Limit = { poke: number; mm: number; tear: number };
const L = (poke: number, mm: number, tear: number): Limit => ({ poke, mm, tear });

// Filled from CLOTH_GATE_PRINT output (measured values rounded UP + margin: poke +2%, mm +5, tear +2%).
const LIMITS: Record<string, Limit> = {
    'top:Tee': L(5, 15, 3),
    'top:Crop': L(8, 14, 7),
    'top:Tank': L(5, 14, 5),
    'top:Long Sleeve': L(6, 25, 6),
    // 2026-10-04 (fit round 2): re-measured after the body's pelvis → thigh weight smoothing (hip-weight-smooth.ts). The
    // SKIN under the bottoms now stretches / folds ~4× less in squat / sit / run (hip-region tris 409 → 94), so this gate's
    // EXCESS tear (garment % − skin %) rose for a few rows although every garment's ABSOLUTE worst tear fell or held
    // (Skirt 14.6 → 11.9 %, Shorts 30.2 → 22.6 %, Pants 10.2 → 7.6 %; body-hip-weights.test.ts pins those).
    'bottom:Skirt': L(5, 10, 9),        // R6.3 leg-follow skirt: was L(8, 21, 2) (rigid skirt); tear 2 → 9 (excess, see above)
    'bottom:Mini Skirt': L(2, 5, 13),   // tear 2 → 13 (excess; absolute 19.2 → 19.2 %)
    'bottom:Shorts': L(12, 30, 20),
    'bottom:Pants': L(11, 56, 10),
    'bottom:Baggy Jeans': L(10, 37, 10),
    'bottom:Wide Leg': L(14, 56, 8),
    'bottom:Skinny': L(11, 56, 10),
    'undershirt:default': L(6, 10, 5),
    'underpants:default': L(4, 19, 4),
    'shoes:Sneaker': L(2, 5, 2),
    'shoes:Flat': L(2, 5, 2),
    'shoes:Sandal': L(2, 5, 2),
    'shoes:High Top': L(2, 5, 2),
    'shoes:Boot': L(2, 5, 2),
    'shoes:Heel': L(2, 5, 2),
    'socks:Crew': L(2, 5, 2),
    'socks:Ankle': L(2, 5, 2),
    'socks:Knee High': L(2, 5, 2),
    'socks:Thigh High': L(2, 10, 3),   // 2026-10-04: ONE vert (0.09 %) 7.8 mm at the top band after the mid-thigh weight change
    'socks:Tube Sock': L(2, 5, 2),
};

describe('clothing regression gate (NEW character, 26 ROM poses)', () => {
  it('no garment pokes through / tears more than its measured limit', async () => {
    const measured: Record<string, Limit> = {};
    const fails: string[] = [];
    for (const [name, build] of ALL_GARMENTS) {
      const { results } = measureGarment(build, ROM_POSES);
      const cells = Object.values(results);
      const m: Limit = {
        poke: Math.max(...cells.map((c) => c.pokePct)),
        mm: Math.max(...cells.map((c) => c.pokeMm)),
        tear: Math.max(...cells.map((c) => (c.stretchPct + c.foldPct) - (c.skinStretchPct + c.skinFoldPct))),
      };
      measured[name] = m;
      const lim = LIMITS[name];
      if (!lim) { fails.push(`${name}: no limit row (new preset? add one)`); continue; }
      for (const k of ['poke', 'mm', 'tear'] as const) {
        if (m[k] > lim[k]) fails.push(`${name}: ${k} ${m[k].toFixed(1)} > limit ${lim[k]}`);
      }
    }
    if (process.env.CLOTH_GATE_PRINT) (await import('node:fs')).writeFileSync(process.env.CLOTH_GATE_PRINT, JSON.stringify(measured, null, 1));
    expect(fails).toEqual([]);
  }, 120_000);
});
