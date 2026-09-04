import { describe, it, expect } from 'vitest';
import { generateCaseShell, CD_CASE_SHELL } from './cd-case-geometry';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

const W = 125, H = 142, D = CD_CASE_SHELL.depth;

function bounds(g: { vertices: Float32Array }) {
  let minZ = Infinity, maxZ = -Infinity, maxX = 0, maxY = 0;
  const n = g.vertices.length / FLOATS_PER_VERT;
  for (let i = 0; i < n; i++) {
    const o = i * FLOATS_PER_VERT;
    maxX = Math.max(maxX, Math.abs(g.vertices[o]));
    maxY = Math.max(maxY, Math.abs(g.vertices[o + 1]));
    minZ = Math.min(minZ, g.vertices[o + 2]); maxZ = Math.max(maxZ, g.vertices[o + 2]);
  }
  return { minZ, maxZ, maxX, maxY };
}

describe('generateCaseShell — shallow open tray', () => {
  it('is a hollow tray: spans the footprint and the full depth (floor + rim, not a flat slab)', () => {
    const g = generateCaseShell(W, H, D, -1, false);
    expect(g.format).toBe('12float');
    const b = bounds(g);
    expect(b.maxX).toBeCloseTo(W / 2, 3);
    expect(b.maxY).toBeCloseTo(H / 2, 3);
    expect(b.maxZ - b.minZ).toBeCloseTo(D, 3);   // has depth (the inset), not zero-thickness
  });

  it('has a THICK rim — inner-perimeter verts (wall thickness), not a single-quad wall', () => {
    const g = generateCaseShell(W, H, D, -1, false, false);
    const n = g.vertices.length / FLOATS_PER_VERT;
    let hasInner = false;
    for (let i = 0; i < n; i++) {
      const o = i * FLOATS_PER_VERT, x = Math.abs(g.vertices[o]), y = Math.abs(g.vertices[o + 1]);
      // a vert on the inner perimeter (footprint minus one wall thickness) → the rim has depth
      if (Math.abs(x - (W / 2 - CD_CASE_SHELL.wall)) < 1e-3 || Math.abs(y - (H / 2 - CD_CASE_SHELL.wall)) < 1e-3) { hasInner = true; break; }
    }
    expect(hasInner).toBe(true);
  });

  it('floorSide flips which face is solid', () => {
    const back = bounds(generateCaseShell(W, H, D, -1, false));   // floor at -D/2
    const front = bounds(generateCaseShell(W, H, D, 1, false));   // floor at +D/2
    expect(back.minZ).toBeCloseTo(-D / 2, 3);
    expect(front.maxZ).toBeCloseTo(D / 2, 3);
  });

  it('withTabs adds geometry (the 4 retainer semicircles)', () => {
    const plain = generateCaseShell(W, H, D, 1, false).vertices.length;
    const tabbed = generateCaseShell(W, H, D, 1, true).vertices.length;
    expect(tabbed).toBeGreaterThan(plain);
  });

  it('withSpine corrugates the left wall (ridges protrude past the footprint edge)', () => {
    const plain = generateCaseShell(W, H, D, -1, false, false, false);
    const spined = generateCaseShell(W, H, D, -1, false, false, true);
    const minX = (g: { vertices: Float32Array }): number => {
      let m = Infinity; const n = g.vertices.length / FLOATS_PER_VERT;
      for (let i = 0; i < n; i++) m = Math.min(m, g.vertices[i * FLOATS_PER_VERT]);
      return m;
    };
    expect(minX(spined)).toBeLessThan(minX(plain));   // ribs stick out beyond -W/2
  });

  it('withHub adds the centre gripper rosette rising above the tray floor', () => {
    const plain = generateCaseShell(W, H, D, -1, false, false);
    const hubbed = generateCaseShell(W, H, D, -1, false, true);
    expect(hubbed.vertices.length).toBeGreaterThan(plain.vertices.length);
    // the rosette lives near the CENTRE and rises off the floor (z > -D/2) — the plain shell has no centre verts.
    const centreRaised = (g: { vertices: Float32Array }): boolean => {
      const n = g.vertices.length / FLOATS_PER_VERT;
      for (let i = 0; i < n; i++) { const o = i * FLOATS_PER_VERT; if (Math.hypot(g.vertices[o], g.vertices[o + 1]) < 6 && g.vertices[o + 2] > -D / 2 + 0.5) return true; }
      return false;
    };
    expect(centreRaised(plain)).toBe(false);
    expect(centreRaised(hubbed)).toBe(true);
  });
});
