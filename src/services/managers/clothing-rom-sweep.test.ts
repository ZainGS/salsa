/**
 * Clothing RANGE-OF-MOTION sweep — REPORT (runs only with AUDIT_ROM=<file>). Every garment preset × 26 poses, NEW
 * character config. See clothing-audit-harness.ts for the metrics and docs/specs/clothing-hair-audit-2026-09-28.md.
 *   AUDIT_ROM=rom.txt npx vitest run src/services/managers/clothing-rom-sweep.test.ts
 */
import { describe, it, expect } from 'vitest';
import { ALL_GARMENTS, ROM_POSES, measureGarment } from './clothing-audit-harness';

describe.skipIf(!process.env.AUDIT_ROM)('clothing range-of-motion sweep', () => {
  it('writes the ROM report', async () => {
    const summary: string[] = [
      `=== CLOTHING ROM SWEEP (NEW config: seam 0.5 + DQS) — ${Object.keys(ROM_POSES).length} poses ===`,
      `${'garment'.padEnd(24)}${'worst poke'.padStart(11)}  ${'@ pose'.padEnd(24)}${'>5%'.padStart(4)}   ${'tear: garment% vs skin%'.padEnd(26)}${'@ pose'}`,
    ];
    const detail: string[] = [];
    for (const [name, build] of ALL_GARMENTS) {
      let res;
      try { res = measureGarment(build, ROM_POSES); }
      catch (e) { summary.push(`${name}: THREW ${(e as Error).message}`); continue; }
      const entries = Object.entries(res.results);
      const pick = (f: (c: typeof entries[number][1]) => number) => entries.reduce((a, b) => (f(b[1]) > f(a[1]) ? b : a));
      const wp = pick((c) => c.pokePct);
      // worst EXCESS tear = how much more the garment tears than the skin under it (0 = it just follows the skin)
      const wt = pick((c) => (c.stretchPct + c.foldPct) - (c.skinStretchPct + c.skinFoldPct));
      const bad = entries.filter(([, c]) => c.pokePct > 5).length;
      const t = wt[1];
      const tearCell = `${(t.stretchPct + t.foldPct).toFixed(1)}% vs ${(t.skinStretchPct + t.skinFoldPct).toFixed(1)}%`;
      summary.push(`${name.slice(0, 23).padEnd(24)}${`${wp[1].pokePct.toFixed(0)}%/${wp[1].pokeMm.toFixed(0)}mm`.padStart(11)}  ${wp[0].padEnd(24)}${String(bad).padStart(4)}   ${tearCell.padEnd(26)}${wt[0]}`);
      detail.push(`\n--- ${name} (covered ${res.covered} body verts, ${res.tris} tris) — poke% / depth · stretched · folded · poking skin by joint ---`);
      for (const [pn, c] of entries) {
        detail.push(`  ${pn.padEnd(26)} ${`${c.pokePct.toFixed(0)}%`.padStart(4)} /${c.pokeMm.toFixed(0).padStart(3)}mm   tear ${(c.stretchPct + c.foldPct).toFixed(1).padStart(5)}% (skin ${(c.skinStretchPct + c.skinFoldPct).toFixed(1).padStart(5)}%)   ${c.poke ? JSON.stringify(c.pokeByJoint) : ''}`);
      }
    }
    (await import('node:fs')).writeFileSync(process.env.AUDIT_ROM!, summary.join('\n') + '\n' + detail.join('\n'));
    expect(summary.length).toBeGreaterThan(2);
  }, 900_000);
});
