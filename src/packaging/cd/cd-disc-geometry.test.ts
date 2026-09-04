import { describe, it, expect } from 'vitest';
import { generateCDDisc, CD_DISC } from './cd-disc-geometry';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

describe('generateCDDisc — thin 3D CD', () => {
  const seg = 72;
  const g = generateCDDisc(CD_DISC.outerR, CD_DISC.innerR, seg);
  const vcount = g.vertices.length / FLOATS_PER_VERT;
  const vert = (i: number) => {
    const o = i * FLOATS_PER_VERT;
    return { x: g.vertices[o], y: g.vertices[o + 1], z: g.vertices[o + 2], nx: g.vertices[o + 3], ny: g.vertices[o + 4], nz: g.vertices[o + 5], u: g.vertices[o + 6], v: g.vertices[o + 7] };
  };

  it('is a valid 12-float mesh with front (+Z) and back (-Z) face verts', () => {
    expect(g.format).toBe('12float');
    expect(vcount).toBeGreaterThan(0);
    let front = 0, back = 0;
    for (let i = 0; i < vcount; i++) { const n = vert(i).nz; if (n > 0.5) front++; else if (n < -0.5) back++; }
    expect(front).toBeGreaterThan(0);   // the label side
    expect(back).toBeGreaterThan(0);    // the playing side
  });

  it('spans the disc radius in XY and the thickness in Z', () => {
    let maxR = 0, minNonHubR = Infinity, maxZ = -Infinity, minZ = Infinity;
    for (let i = 0; i < vcount; i++) {
      const p = vert(i); const r = Math.hypot(p.x, p.y);
      maxR = Math.max(maxR, r);
      if (r > 1e-4) minNonHubR = Math.min(minNonHubR, r);
      maxZ = Math.max(maxZ, p.z); minZ = Math.min(minZ, p.z);
    }
    expect(maxR).toBeCloseTo(CD_DISC.outerR, 3);        // outer edge
    expect(minNonHubR).toBeCloseTo(CD_DISC.innerR, 3);  // centre hole
    expect(maxZ - minZ).toBeCloseTo(CD_DISC.thickness, 3);
  });

  it('front verts carry disc-mapped label UVs (centre 0.5, edge on the border)', () => {
    // a +Z outer-edge vert → u near 0 or 1, v near 0.5 (the label image circumscribes the disc)
    let checked = false;
    for (let i = 0; i < vcount && !checked; i++) {
      const p = vert(i);
      if (p.nz > 0.5 && Math.abs(Math.hypot(p.x, p.y) - CD_DISC.outerR) < 1e-3 && Math.abs(p.y) < 1e-3) {
        expect(Math.abs(p.u - 0.5)).toBeCloseTo(0.5, 2);   // u ≈ 0 or 1
        expect(p.v).toBeCloseTo(0.5, 2);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });

  it('clamps segments to a sane minimum', () => {
    expect(() => generateCDDisc(60, 7.5, 1)).not.toThrow();
  });
});
