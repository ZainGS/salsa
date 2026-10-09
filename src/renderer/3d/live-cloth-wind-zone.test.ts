/**
 * live-cloth-wind-zone.test.ts — resolveWindZone (audit 2026-10-09, cloth inspector): the live sim reads flat
 * pulsePeriod (seconds) / pulsePhase (radians) and falloff 'none' | 'linear'; older Frogmarks saves stored a numeric
 * falloff and a nested pulse { period: frames, phase: 0–1 } that the sim never read.
 */
import { describe, it, expect } from 'vitest';
import { resolveWindZone, WIND_ZONE_FRAMES_PER_SECOND } from './live-cloth-simulation';
import type { WindZone } from '../../scene-graph/shapes/cloth-mesh-3d';

const base: WindZone = { id: 'z', shape: 'sphere', center: [0, 0, 0], radius: 1, windVec: [0, 5, 0], falloff: 'none' };

describe('resolveWindZone', () => {
  it('a current zone passes through unchanged (same object)', () => {
    const z: WindZone = { ...base, falloff: 'linear', pulsePeriod: 2, pulsePhase: Math.PI };
    expect(resolveWindZone(z)).toBe(z);
    expect(resolveWindZone(base)).toBe(base);
  });

  it('an older save: numeric falloff = uniform (what it did); nested pulse frames / fraction = seconds / radians', () => {
    const old = { ...base, falloff: 1, pulse: { period: 120, phase: 0.25 } } as unknown as WindZone;
    const r = resolveWindZone(old);
    expect(r.falloff).toBe('none');
    expect(r.pulsePeriod).toBeCloseTo(120 / WIND_ZONE_FRAMES_PER_SECOND, 9);
    expect(r.pulsePhase).toBeCloseTo(Math.PI / 2, 9);
  });

  it('flat fields win over a stale nested pulse (pulse switched off later = pulsePeriod 0)', () => {
    const z = { ...base, pulsePeriod: 0, pulsePhase: 0, pulse: { period: 60, phase: 0 } } as unknown as WindZone;
    expect(resolveWindZone(z).pulsePeriod).toBe(0);
  });
});
