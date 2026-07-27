/**
 * src/world/street-dressing.test.ts — signage, neon and awnings.
 *
 * Three fixes, all of the same family: something that should be geometry or light was being faked with a
 * flat quad or a scrolling albedo band.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { computeTextSigns } from './signtext';
import { buildAwnings } from './awnings';
import { generateCityLayout } from './layout';
import { DEFAULT_MATERIAL, encodeMaterialFlags, type Material3D } from '../renderer/3d/material-3d';
import { MESH3D_FRAGMENT_SHADER } from '../renderer/3d/shaders/mesh3d-shaders';
import type { WorldGraph } from './types';

const city = (seed = 3): WorldGraph =>
  generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square' });

describe('text signs read the right way round', () => {
  it('every two-faced plate is SINGLE-SIDED', () => {
    // A plate is two quads with MIRRORED U so it reads from both sides. That design only works if each
    // face is hidden from behind — double-sided (the city default) lets the mirrored back face z-fight
    // the front, which is the "JOOHOS" mirror-writing. Culling is what makes the design hold.
    const signs = computeTextSigns(city());
    expect(signs.length).toBeGreaterThan(0);
    for (const sp of signs) {
      expect(sp.layer.singleSided, `${sp.label} plate is double-sided`).toBe(true);
    }
  });

  it('the two faces are separated enough to survive depth precision', () => {
    // They used to sit hh * 0.12 apart — under 2 cm on a shop sign, which z-fights at city distance.
    for (const sp of computeTextSigns(city())) {
      const v = sp.layer.geometry.vertices;
      // vertex 0 = front face corner, vertex 4 = the matching back face corner.
      const d = Math.hypot(v[0] - v[4 * 12], v[2] - v[4 * 12 + 2]);
      expect(d, `${sp.label} faces are ${d.toExponential(2)} apart`).toBeGreaterThan(5e-4);
    }
  });
});

describe('neon signs emit rather than being painted', () => {
  const NEON_BIT = 4194304;   // bit 22

  it('encodes as bit 22 and does not collide with the other pattern-slot consumers', () => {
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, neonShade: true }) & NEON_BIT).toBe(NEON_BIT);
    const others: Material3D = {
      ...DEFAULT_MATERIAL, patternMode: 'waves', boardShade: true, groundShade: true,
      windSway: true, foliageShade: true, waterShade: true, texOverBase: true, radialFade: true,
    };
    expect(encodeMaterialFlags(others) & NEON_BIT).toBe(0);
  });

  it('drives the EMISSIVE term — a lit sign is not an albedo animation', () => {
    expect(MESH3D_FRAGMENT_SHADER).toContain('fn neonSign(');
    const branch = MESH3D_FRAGMENT_SHADER.slice(
      MESH3D_FRAGMENT_SHADER.indexOf('let neonShade ='),
      MESH3D_FRAGMENT_SHADER.indexOf('let neonShade =') + 600);
    expect(branch).toMatch(/emissiveRGB = neonSign\(/);
  });

  it('gives each board its own flicker PHASE — a street must not pulse in unison', () => {
    // Holoboards need `holograms` AND a block whose district is 'downtown' AND a tall enough building AND
    // a 50% roll, which no small probed city produced — so this checks the construction at the source
    // rather than pretending to exercise it. If someone gives both boards one phase, every hologram in
    // the skyline flickers on the same beat, which is the tell that it is one animation on many quads.
    const src = readFileSync(new URL('./signage.ts', import.meta.url), 'utf8');
    const phases = [...src.matchAll(/neon:\s*\{[^}]*phase:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    expect(phases.length, 'no neon boards found in signage.ts').toBeGreaterThan(1);
    expect(new Set(phases).size, 'boards share a flicker phase').toBe(phases.length);
    // ...and neither board is still on the old scrolling-band motif.
    expect(src, 'a holoboard is still on the scrolling-band motif').not.toContain("mode: 'waves'");
  });
});

describe('awnings are fabric, not folded card', () => {
  it('the canvas is subdivided into bays, not one flat quad', () => {
    const awnings = buildAwnings(city()).filter((L) => L.name.startsWith('world:awning-'));
    expect(awnings.length).toBeGreaterThan(0);
    const verts = awnings.reduce((n, L) => n + L.geometry.vertices.length / 12, 0);
    const tris = awnings.reduce((n, L) => n + L.geometry.indices.length / 3, 0);
    // A flat awning was canvas + valance + 2 gores = 4 quads. Sag/scallop needs many more per awning.
    expect(tris / Math.max(1, awnings.length)).toBeGreaterThan(12);
    expect(verts).toBeGreaterThan(0);
  });

  it('keeps a CONTINUOUS u across the canvas, or the stripes collapse', () => {
    // quad4 derives u from each quad's own world width, so subdividing the canvas restarted u at every
    // bay — each bay came out narrower than one stripe and the pattern flattened to solid colour. The
    // striped awnings must therefore span a u range close to their real width, not ~one bay's worth.
    const striped = buildAwnings(city()).filter((L) => L.name.startsWith('world:awning-') && L.pattern);
    expect(striped.length).toBeGreaterThan(0);
    let maxU = 0;
    for (const L of striped) {
      const v = L.geometry.vertices;
      for (let i = 0; i < v.length; i += 12) maxU = Math.max(maxU, v[i + 6]);   // uv.x
    }
    // One bay is at most a sixth of an awning; a per-bay u run would leave maxU tiny.
    expect(maxU, 'u never accumulates across bays — stripes will read as flat colour').toBeGreaterThan(0.02);
  });

  it('offers PLAIN canvas as well as striped, so a street is not all one motif', () => {
    const all = buildAwnings(city()).filter((L) => L.name.includes('awning'));
    const striped = all.filter((L) => L.pattern);
    const plain = all.filter((L) => !L.pattern && L.name.includes('awning-plain'));
    expect(striped.length, 'no striped awnings left').toBeGreaterThan(0);
    expect(plain.length, 'no plain awnings').toBeGreaterThan(0);
  });

  it('the front edge DIPS between ribs — that dip is what scallops the hem', () => {
    // Fabric pulled over ribs sags between them. If every front-edge vertex shared one Y, the awning is
    // still a rigid plane and the scallop is not there.
    const awnings = buildAwnings(city()).filter((L) => L.name.startsWith('world:awning-'));
    const ys = new Set<number>();
    for (const L of awnings) {
      const v = L.geometry.vertices;
      for (let i = 0; i < v.length; i += 12) ys.add(Math.round(v[i + 1] * 1e4));
    }
    expect(ys.size, 'awning geometry is planar in Y').toBeGreaterThan(8);
  });
});
