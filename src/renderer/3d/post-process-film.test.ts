import { describe, it, expect } from 'vitest';
import { packGradeVigParams, defaultPostProcessConfig, DEFAULT_POST_PROCESS_CONFIG } from './post-process-pass';

describe('post-process FILM look — uniform packing (film-look-and-toon-shadows.md §A)', () => {
  it('film OFF → grade + vignette BOTH apply whenever the pass runs (the original behaviour), no grain/fringing', () => {
    const c = defaultPostProcessConfig();
    c.colorGrade.enabled = true; c.colorGrade.saturation = 0.3;
    c.vignette.enabled = false; c.vignette.intensity = 0.8;   // stored but "off" — the old pass applied it anyway
    const u = packGradeVigParams(new Float32Array(16), c, 12.5);
    expect([u[9], u[10], u[11]]).toEqual([1, 1, 0]);
    expect(u[12]).toBe(0); expect(u[14]).toBe(0);
    expect(u[2]).toBeCloseTo(0.3); expect(u[3]).toBeCloseTo(0.8);
    expect(u[15]).toBeCloseTo(12.5);
  });

  it('film ON → each effect honours its own enable; grain / size / fringing packed', () => {
    const c = defaultPostProcessConfig();
    c.film.enabled = true; c.film.grain = 0.1; c.film.grainSize = 2; c.film.aberration = 0.004;
    c.vignette.enabled = true;
    const u = packGradeVigParams(new Float32Array(16), c, 3);
    expect([u[9], u[10], u[11]]).toEqual([0, 1, 1]);          // grade off, vignette on, film on
    expect(u[12]).toBeCloseTo(0.1); expect(u[13]).toBeCloseTo(2); expect(u[14]).toBeCloseTo(0.004);
  });

  it('defaults: film off; defaultPostProcessConfig is a deep copy (no shared arrays)', () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.film.enabled).toBe(false);
    const a = defaultPostProcessConfig(), b = defaultPostProcessConfig();
    a.film.halationTint[0] = 0; a.colorGrade.tint[0] = 0;
    expect(b.film.halationTint[0]).toBe(1); expect(DEFAULT_POST_PROCESS_CONFIG.colorGrade.tint[0]).toBe(1);
  });
});

// ── Grain hash (bug 2026-09-29: the grain faded after a few minutes) ─────────────────────────────────────────────
// The old hash was fract(sin(dot(cell + frame·k, k2)) · 43758): its argument grew with the frame number to ~1e8,
// where GPU sin() has no precision → near-constant noise → the grain vanished until the hourly clock wrap. The new
// hash is integer (PCG); this JS port mirrors the WGSL u32 maths exactly (Math.imul + >>> 0 = wrapping u32).
import { PP_GRADE_VIG_FS as _GV } from './shaders/post-process-shaders';
function filmHashJS(cx: number, cy: number, frame: number): number {
  let v = (Math.imul(cx, 1973) + Math.imul(cy, 9277) + Math.imul(frame, 26699)) >>> 0;
  v = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  let w = Math.imul(((v >>> ((v >>> 28) + 4)) ^ v) >>> 0, 277803737) >>> 0;
  w = ((w >>> 22) ^ w) >>> 0;
  return w / 4294967295;
}
describe('film grain hash', () => {
  it('the shader hash is integer-based (no sin — it loses precision as time grows)', () => {
    const fn = _GV.slice(_GV.indexOf('fn filmHash'), _GV.indexOf('@fragment'));
    expect(fn).not.toMatch(/\bsin\(/);
    expect(fn).toMatch(/u32/);
  });
  for (const tSec of [0, 90, 600, 3599]) {
    it(`stays evenly random at t = ${tSec}s (frame ${Math.floor(tSec * 24)})`, () => {
      const frame = Math.floor(tSec * 24);
      let sum = 0, sq = 0, same = 0; const N = 64 * 64;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const h = filmHashJS(x, y, frame);
        sum += h; sq += h * h;
        if (Math.abs(h - filmHashJS(x + 1, y, frame)) < 1e-3) same++;
      }
      const mean = sum / N, variance = sq / N - mean * mean;
      expect(mean).toBeGreaterThan(0.45); expect(mean).toBeLessThan(0.55);
      expect(variance).toBeGreaterThan(0.07); expect(variance).toBeLessThan(0.1);   // uniform = 1/12 ≈ 0.083
      expect(same).toBeLessThan(N * 0.01);                                          // neighbours differ
      expect(filmHashJS(10, 10, frame)).not.toBe(filmHashJS(10, 10, frame + 1));   // re-rolls every film frame
    });
  }
});
