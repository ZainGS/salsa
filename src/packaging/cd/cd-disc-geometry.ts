/**
 * src/packaging/cd/cd-disc-geometry.ts
 *
 * The CD DISC — a thin 3D annulus (top + bottom rings, outer rim, centre-hole wall) matching the Shell UI's
 * CartridgeViewer CD. The TOP ring (+Z) is the label/front (normal +Z, disc-mapped UVs for cover art); the
 * BOTTOM ring (-Z) is the playing side. Rendered with the `renderStyle:'cd'` material (Zucconi diffraction
 * rainbow + a printed label composited on the front face only — the front/back split comes from the normal
 * sign). Standard CD = 120 mm Ø (outer R 60) / 15 mm hub hole (inner R 7.5) / ~1.2 mm thick. 12-float format.
 *
 * Units are the caller's (mm here); the kit applies the mm→world scale. Ported from shell-cartridge.buildCD.
 */

import { type MeshGeometry, FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

/** Standard CD disc metrics (mm). */
export const CD_DISC = { outerR: 60, innerR: 7.5, thickness: 1.2 } as const;

/**
 * A thin 3D CD annulus facing ±Z. `segments` = radial subdivisions (≥3). Both flat rings carry disc-mapped UVs
 * (uv = 0.5 + p/(2·R)) so the diffraction rainbow (radial) and the front label both map correctly; front verts
 * have normal +Z, back verts -Z (that sign is what the CD shader uses to put the label on the front only).
 */
export function generateCDDisc(outerR = CD_DISC.outerR, innerR = CD_DISC.innerR, segments = 72, thickness = CD_DISC.thickness): MeshGeometry {
  const R = outerR, rHole = innerR, hd = thickness / 2;
  const segs = Math.max(3, Math.floor(segments));
  const TAU = Math.PI * 2;
  const verts: number[] = [];
  const idx: number[] = [];
  const push = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number): number => {
    verts.push(px, py, pz, nx, ny, nz, u, v, 1, 0, 0, 1);   // tangent +X (unused by the CD shader)
    return verts.length / FLOATS_PER_VERT - 1;
  };
  const uvx = (x: number): number => x / R * 0.5 + 0.5;
  const uvy = (y: number): number => -y / R * 0.5 + 0.5;   // v-flip → label prints upright

  // Top ring (+Z) — the front/label face.
  const ti: number[] = [], to: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU, c = Math.cos(a), s = Math.sin(a);
    ti.push(push(c * rHole, s * rHole, hd, 0, 0, 1, uvx(c * rHole), uvy(s * rHole)));
    to.push(push(c * R, s * R, hd, 0, 0, 1, uvx(c * R), uvy(s * R)));
  }
  for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; idx.push(ti[i], to[i], to[j], ti[i], to[j], ti[j]); }

  // Bottom ring (-Z) — the playing side (disc UVs too, so the rainbow radius is correct on the back).
  const bi: number[] = [], bo: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU, c = Math.cos(a), s = Math.sin(a);
    bi.push(push(c * rHole, s * rHole, -hd, 0, 0, -1, uvx(c * rHole), uvy(s * rHole)));
    bo.push(push(c * R, s * R, -hd, 0, 0, -1, uvx(c * R), uvy(s * R)));
  }
  for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; idx.push(bi[i], bo[j], bo[i], bi[i], bi[j], bo[j]); }

  // Outer rim (outward normal) + inner hole wall (inward normal).
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const o0 = push(c0 * R, s0 * R, hd, c0, s0, 0, uvx(c0 * R), uvy(s0 * R));
    const o1 = push(c1 * R, s1 * R, hd, c1, s1, 0, uvx(c1 * R), uvy(s1 * R));
    const o2 = push(c0 * R, s0 * R, -hd, c0, s0, 0, uvx(c0 * R), uvy(s0 * R));
    const o3 = push(c1 * R, s1 * R, -hd, c1, s1, 0, uvx(c1 * R), uvy(s1 * R));
    idx.push(o0, o2, o1, o1, o2, o3);
    const k0 = push(c0 * rHole, s0 * rHole, hd, -c0, -s0, 0, uvx(c0 * rHole), uvy(s0 * rHole));
    const k1 = push(c1 * rHole, s1 * rHole, hd, -c1, -s1, 0, uvx(c1 * rHole), uvy(s1 * rHole));
    const k2 = push(c0 * rHole, s0 * rHole, -hd, -c0, -s0, 0, uvx(c0 * rHole), uvy(s0 * rHole));
    const k3 = push(c1 * rHole, s1 * rHole, -hd, -c1, -s1, 0, uvx(c1 * rHole), uvy(s1 * rHole));
    idx.push(k0, k1, k2, k1, k3, k2);
  }

  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx), format: '12float' };
}
