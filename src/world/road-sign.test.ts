/**
 * src/world/road-sign.test.ts — regulatory + warning road signs.
 *
 * Pins the contract: buildRoadSigns emits pole geometry, real regulatory TEXT specs (drawn from the fixed label
 * set), and a GARP-instanced warning-diamond layer wired to the 'salsa/warning' pool. The warning canonical face
 * is a non-empty 0..1-UV diamond. A regression that dropped the text specs or un-GARP'd the warning layer would
 * quietly turn every road sign back into a blank plate, which no screenshot diff would catch.
 */

import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildRoadSigns, warningGarpPool, warningCanonicalGeometry, WARNING_SKINS } from './road-sign';

const graph = generateCityLayout({ seed: 11, radius: 140, pattern: 'grid', trafficLights: true, streetFurniture: true });

describe('road signs — regulatory text + warning GARP', () => {
  const { layers, textSigns } = buildRoadSigns(graph);

  it('emits pole geometry', () => {
    const pole = layers.find((l) => l.name === 'world:roadsign-pole');
    expect(pole).toBeTruthy();
    expect(pole!.geometry!.vertices.length).toBeGreaterThan(0);
  });

  it('regulatory plates are real TEXT specs from the fixed label set', () => {
    const LABELS = ['NO PARKING', 'ONE WAY', 'DO NOT ENTER', 'SPEED 30'];
    expect(textSigns.length).toBeGreaterThan(0);
    for (const sp of textSigns) {
      expect(LABELS).toContain(sp.label);
      expect(sp.layer.geometry!.vertices.length).toBeGreaterThan(0);   // a real plate quad, not a stub
    }
  });

  it('warning diamonds are a GARP-instanced layer on the salsa/warning pool', () => {
    const warn = layers.find((l) => l.name === 'world:warning');
    expect(warn).toBeTruthy();
    expect(warn!.arrayGroup).toBe(true);
    expect(warn!.instances!.length).toBeGreaterThan(0);
    expect(warn!.garp!.pool).toBe('salsa/warning');
    expect(warn!.drape).toBe('baked');   // pre-lifted → must not be re-draped
  });

  it('the warning pool advertises its skins and the canonical face is a non-empty diamond', () => {
    const pool = warningGarpPool();
    expect(pool.id).toBe('salsa/warning');
    for (const n of WARNING_SKINS) expect(pool.skins.some((sk) => sk.name === n)).toBe(true);
    expect(warningCanonicalGeometry(0.06).vertices.length).toBeGreaterThan(0);
  });

  it('respects the streetFurniture toggle', () => {
    const off = generateCityLayout({ seed: 11, radius: 140, pattern: 'grid', trafficLights: true, streetFurniture: false });
    const r = buildRoadSigns(off);
    expect(r.layers.length).toBe(0);
    expect(r.textSigns.length).toBe(0);
  });
});
