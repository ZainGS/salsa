import { describe, it, expect } from 'vitest';
import { generateRoundedSlab, generateSprite, FLOATS_PER_VERT } from './mesh-generators';

// The rounded-rect SLAB backs the 3D landmark info card (rounded silhouette so the card's bubbly shape has no square
// corners for the back to peek through). These pin the geometry contract the renderer + spin animation rely on:
// valid indices, extrusion along Z, in-bounds front UVs, the same V-flip as the flat sprite, and that the silhouette
// actually rounds the corners (no vertex sits in the extreme corner of the bounding rectangle).
describe('generateRoundedSlab', () => {
  const CORNER_SEGMENTS = 5;
  const N = 4 * (CORNER_SEGMENTS + 1);   // outline points

  it('has a valid, in-bounds index buffer and the 12-float format', () => {
    const g = generateRoundedSlab(2, 1, 0.1, 0.2, CORNER_SEGMENTS);
    const vertCount = g.vertices.length / FLOATS_PER_VERT;
    expect(Number.isInteger(vertCount)).toBe(true);
    expect(g.indices.length % 3).toBe(0);
    for (const i of g.indices) expect(i).toBeLessThan(vertCount);
    expect(g.format).toBe('12float');
  });

  it('extrudes along Z by ±depth/2 and stays within ±width/2 and ±height/2', () => {
    const w = 3, h = 1.5, d = 0.2;
    const g = generateRoundedSlab(w, h, d, 0.3, CORNER_SEGMENTS);
    let minZ = Infinity, maxZ = -Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let v = 0; v < g.vertices.length / FLOATS_PER_VERT; v++) {
      const o = v * FLOATS_PER_VERT;
      maxX = Math.max(maxX, Math.abs(g.vertices[o]));
      maxY = Math.max(maxY, Math.abs(g.vertices[o + 1]));
      minZ = Math.min(minZ, g.vertices[o + 2]);
      maxZ = Math.max(maxZ, g.vertices[o + 2]);
    }
    expect(maxX).toBeLessThanOrEqual(w / 2 + 1e-6);
    expect(maxY).toBeLessThanOrEqual(h / 2 + 1e-6);
    expect(minZ).toBeCloseTo(-d / 2);
    expect(maxZ).toBeCloseTo(d / 2);
  });

  it('rounds the corners: no vertex reaches the extreme rectangle corner', () => {
    const w = 2, h = 2, r = 0.4;
    const g = generateRoundedSlab(w, h, 0.1, r, CORNER_SEGMENTS);
    const hw = w / 2, hh = h / 2;
    for (let v = 0; v < g.vertices.length / FLOATS_PER_VERT; v++) {
      const o = v * FLOATS_PER_VERT;
      const near = Math.abs(g.vertices[o]) > hw - 1e-3 && Math.abs(g.vertices[o + 1]) > hh - 1e-3;
      expect(near).toBe(false);   // a rounded rect never puts a vertex in the square corner
    }
  });

  it('front face carries in-range V-flipped UVs (top → v≈0), matching the sprite convention', () => {
    const g = generateRoundedSlab(2, 1, 0.1, 0.2, CORNER_SEGMENTS);
    // Front fan = center + N outline verts (the first 1+N verts). Check their UVs are in [0,1] and V-flipped.
    for (let v = 0; v < 1 + N; v++) {
      const o = v * FLOATS_PER_VERT;
      const y = g.vertices[o + 1], u = g.vertices[o + 6], vv = g.vertices[o + 7];
      expect(u).toBeGreaterThanOrEqual(-1e-6); expect(u).toBeLessThanOrEqual(1 + 1e-6);
      expect(vv).toBeGreaterThanOrEqual(-1e-6); expect(vv).toBeLessThanOrEqual(1 + 1e-6);
      if (y > 0.4) expect(vv).toBeLessThan(0.5);   // top of card → small v (upright)
    }
    // Sanity: flat sprite still uses the same V-flip (BL vert v=1).
    expect(generateSprite(2, 1).vertices[6 + 1]).toBeCloseTo(1);
  });
});
