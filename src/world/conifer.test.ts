/**
 * src/world/conifer.test.ts — the CONIFER archetype, and the drape rules that keep props off a terrace step.
 *
 * The conifer exists because the `branch` primitive grows a broadleaf and cannot be re-tuned into an
 * evergreen: a broadleaf's trunk dissolves into up-curving limbs, a conifer keeps one unbroken leader with
 * whorled tiers angling down. The city shipped a narrowed small-tree as a stand-in; these pin the real one.
 */

import { describe, it, expect } from 'vitest';
import { buildFoliage } from './foliage';
import { drapeLayerGroups } from './drape';
import type { LayoutPreviewLayer } from './types';

const build = (over: Record<string, unknown> = {}): ReturnType<typeof buildFoliage> =>
  buildFoliage({ type: 'conifer', size: 7, density: 0.85, seed: 5, render: 'card', ...over } as never);

const tris = (ls: LayoutPreviewLayer[]): number => ls.reduce((n, L) => n + L.geometry.indices.length / 3, 0);

describe('conifer archetype', () => {
  it('builds real geometry with a leader, needles and new-growth tips', () => {
    const r = build();
    const names = r.layers.map((L) => L.name);
    expect(names).toContain('foliage:trunk');    // the leader + branch tubes
    expect(names).toContain('foliage:leaf');     // needle sprays
    expect(tris(r.layers)).toBeGreaterThan(500);
    expect(r.meta.height).toBeCloseTo(7, 1);
  });

  it('is its own shape, not a narrowed small-tree', () => {
    const conifer = build();
    const broadleaf = buildFoliage({ type: 'small-tree', size: 7, seed: 5, render: 'card' } as never);
    // Different construction → different triangle count and a different footprint. If someone quietly
    // re-points 'conifer' back at the woody path, these converge.
    expect(tris(conifer.layers)).not.toBe(tris(broadleaf.layers));
    expect(conifer.meta.footprint.length).toBeGreaterThan(0);
  });

  it('spread controls the crown width — a cypress is narrower than a spruce', () => {
    const wide = build({ coniferSpread: 0.22 }).meta.footprint;
    const narrow = build({ coniferSpread: 0.08 }).meta.footprint;
    const halfX = (fp: { 0: number }[] | number[][]): number =>
      Math.max(...(fp as number[][]).map((p) => Math.abs(p[0])));
    expect(halfX(narrow as never)).toBeLessThan(halfX(wide as never));
  });

  it('is NOT alpha-cut — leafCard on real needles carves them away', () => {
    // `leafCard` cuts a quad into a leaf silhouette. Conifer needles are real swept blades, so the flag
    // deletes the geometry instead of shaping it — which rendered the city's conifers as bare sticks.
    // The cause was classification: `conifer` was in none of the archetype sets, so `real` was false.
    for (const L of build({ render: 'card' }).layers) {
      if (/leaf|tip/.test(L.name)) expect(L.leafCard, `${L.name} is alpha-cut`).toBeFalsy();
    }
  });

  it('carries real needle MASS, not a stick with two sprays', () => {
    // Measured against a same-height broadleaf: the conifer used to have a foliage:wood triangle ratio of
    // 1.7 vs the broadleaf's 9.3, i.e. mostly visible trunk. Anything under ~3 reads as a dead tree.
    const r = build({ density: 0.85 });
    const needle = r.layers.filter((L) => /leaf|tip/.test(L.name)).reduce((n, L) => n + L.geometry.indices.length / 3, 0);
    const wood = r.layers.filter((L) => /trunk/.test(L.name)).reduce((n, L) => n + L.geometry.indices.length / 3, 0);
    expect(needle / wood, 'conifer is too sparse').toBeGreaterThan(3);
  });

  it('density actually drives needle fullness', () => {
    // It used to move only the branch COUNT, so 0.4 -> 1.0 changed needle mass by 27% — effectively inert.
    const mass = (d: number): number => build({ density: d }).layers
      .filter((L) => /leaf|tip/.test(L.name)).reduce((n, L) => n + L.geometry.indices.length / 3, 0);
    expect(mass(1.0)).toBeGreaterThan(mass(0.4) * 1.5);
  });

  it('stays affordable — a city plants hundreds of these', () => {
    expect(tris(build().layers)).toBeLessThan(9000);
  });

  it('is deterministic per seed', () => {
    expect(tris(build({ seed: 11 }).layers)).toBe(tris(build({ seed: 11 }).layers));
  });
});

describe('drape tiers — a wide prop must never straddle a terrace step', () => {
  const geo = (): LayoutPreviewLayer['geometry'] => ({
    vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1,
                                4, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 0]),
    format: '12float',
  } as never);

  // A step field: everything left of x = 2 is low, right of it is high.
  const step = (x: number): number => (x < 2 ? 0 : 10);

  it('lifts an INSTANCED layer by its transform, leaving the shared geometry untouched', () => {
    // This is the tear-free path: one anchor sample moves the whole prop. It is also required for
    // correctness at all — the canonical geometry sits at the origin, so height-fielding it would move
    // every copy by the height at (0,0).
    const L: LayoutPreviewLayer = {
      name: 'world:tree-broadleaf-0:foliage:leaf', color: [0, 1, 0], y: 0, geometry: geo(),
      instances: [{ x: 0, y: 0, z: 0, ry: 0 }, { x: 4, y: 0, z: 0, ry: 0 }], arrayGroup: true,
    };
    const before = Array.from(L.geometry.vertices);
    drapeLayerGroups([{ name: 'g', layers: [L] }], (x) => step(x), (x) => step(x), (_x, _z, out) => { out[0] = 0; out[1] = 0; });
    expect(L.instances![0].y).toBe(0);      // low side
    expect(L.instances![1].y).toBe(10);     // high side — whole prop moved, nothing sheared
    expect(Array.from(L.geometry.vertices)).toEqual(before);
  });

  it('honours an explicit drape tier over the name-based classification', () => {
    // 'smooth' means the discrete level is already baked per polygon; applying it again would double it.
    const L: LayoutPreviewLayer = { name: 'world:sidewalks', color: [1, 1, 1], y: 0, geometry: geo(), drape: 'smooth' };
    drapeLayerGroups([{ name: 'g', layers: [L] }], (x) => step(x) + 1, () => 1, (_x, _z, out) => { out[0] = 0; out[1] = 0; });
    // Smooth field is a constant 1 everywhere; the discrete step must NOT have been added on top.
    expect(L.geometry.vertices[1]).toBe(1);
    expect(L.geometry.vertices[13]).toBe(1);
  });

  it("'baked' layers are not lifted at all", () => {
    const L: LayoutPreviewLayer = { name: 'anything', color: [1, 1, 1], y: 0, geometry: geo(), drape: 'baked' };
    drapeLayerGroups([{ name: 'g', layers: [L] }], () => 99, () => 99, (_x, _z, out) => { out[0] = 0; out[1] = 0; });
    expect(L.geometry.vertices[1]).toBe(0);
  });
});
