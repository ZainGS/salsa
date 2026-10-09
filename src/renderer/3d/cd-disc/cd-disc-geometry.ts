/**
 * src/renderer/3d/cd-disc/cd-disc-geometry.ts
 *
 * The CD DISC mesh shared by every CD the engine draws: the CD Kit's disc (packaging/cd, 12-float engine mesh, mm) and
 * the Shell's FrogCart discs (shell-cartridge.ts, its own 9-float layout, unit radius) — so one square image maps onto
 * both the same way. A thin 3D annulus: top ring (+Z) = the label / print side, bottom ring (-Z) = the playing side,
 * an outer rim and the centre-hole wall. Every flat ring carries disc-mapped UVs (uv = 0.5 + p / (2 R), v flipped so
 * art prints upright). Standard CD = 120 mm diameter (outer R 60) / 15 mm hole (inner R 7.5) / ~1.2 mm thick; the
 * printable area starts at the stacking ring (R 18): inside it a real disc is clear plastic (CD_DISC_SAFE_R).
 *
 * Moved here from packaging/cd/cd-disc-geometry.ts (which re-exports it); it was itself a port of the Shell's buildCD.
 */

import { type MeshGeometry, FLOATS_PER_VERT } from '../mesh-generators';

/** Standard CD disc metrics (mm). */
export const CD_DISC = { outerR: 60, innerR: 7.5, thickness: 1.2 } as const;

/** Disc printable-area / stacking-ring inner radius (mm): a printed CD leaves the hub inside it clear (no ink). */
export const CD_DISC_SAFE_R = 18;

/** The real hole radius as a fraction of the outer radius (7.5 / 60). */
export const CD_DISC_HOLE_RATIO = CD_DISC.innerR / CD_DISC.outerR;

/** Where the printed art starts, as a fraction of the outer radius (18 / 60): the clear hub ring inside it. Both the
 *  Shell disc and the CD Kit disc mask their label inside this radius, so they stay identical. */
export const CD_DISC_ART_INNER_RATIO = CD_DISC_SAFE_R / CD_DISC.outerR;

/** The Shell FrogCart disc's hole (fraction of its radius). The real CD ratio since 2026-10-09; the old Shell disc
 *  used 0.17 — flip this ONE constant back to 0.17 to restore the old look. */
export const SHELL_CD_HOLE_RATIO = CD_DISC_HOLE_RATIO;

/**
 * A thin 3D CD annulus facing ±Z. `segments` = radial subdivisions (≥3). Both flat rings carry disc-mapped UVs
 * (uv = 0.5 + p/(2·R)) so the diffraction rainbow (radial) and the front label both map correctly; front verts
 * have normal +Z, back verts -Z (that sign is what the CD shaders use to put the label on the front only).
 */
export function generateCDDisc(outerR: number = CD_DISC.outerR, innerR: number = CD_DISC.innerR, segments = 72, thickness: number = CD_DISC.thickness): MeshGeometry {
  const R = outerR, rHole = innerR, hd = thickness / 2;
  const segs = Math.max(3, Math.floor(segments));
  const TAU = Math.PI * 2;
  const verts: number[] = [];
  const idx: number[] = [];
  const push = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number): number => {
    verts.push(px, py, pz, nx, ny, nz, u, v, 1, 0, 0, 1);   // tangent +X (unused by the CD shaders)
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

/** The Shell viewer's vertex layout: pos3, nrm3, uv2, isFront1 (9 floats), 16-bit indices. */
export interface ShellMeshData { verts: Float32Array; indices: Uint16Array }

/**
 * Convert an engine CD mesh (12-float) into the Shell viewer's 9-float layout. isFront = 1 on the top (+Z) ring
 * only — the face the Shell CD shader prints on. Throws when the mesh has too many vertices for 16-bit indices.
 */
export function cdDiscToShellMesh(geo: MeshGeometry): ShellMeshData {
  const src = geo.vertices;
  const n = src.length / FLOATS_PER_VERT;
  if (n > 0xffff) throw new RangeError(`cdDiscToShellMesh: ${n} vertices do not fit 16-bit indices`);
  const verts = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const s = i * FLOATS_PER_VERT, d = i * 9;
    for (let k = 0; k < 8; k++) verts[d + k] = src[s + k];   // pos, normal, uv
    verts[d + 8] = src[s + 5] > 0.5 ? 1 : 0;                  // isFront: the +Z ring
  }
  return { verts, indices: Uint16Array.from(geo.indices) };
}

/** The Shell's unit FrogCart disc (radius 1, thin) in the Shell layout. */
export function buildShellCDMesh(holeRatio: number = SHELL_CD_HOLE_RATIO, segments = 48, thickness = 0.05): ShellMeshData {
  return cdDiscToShellMesh(generateCDDisc(1, holeRatio, segments, thickness));
}
