/**
 * body-v2-preview.ts — test-support contact-sheet rendering for the v2 body (node only: PNG via node:zlib).
 * Like pose-preview.renderPosePNG (orthographic, yaw 0 = the FRONT, 90 = the left side), plus:
 *   • SMOOTH shading from the skinned vertex normals (what the engine draws) or flat (per-triangle) shading;
 *   • an optional WIREFRAME overlay on the visible triangles (to judge edge loops);
 *   • per-vertex colours (garments over the body) and multiple meshes per tile (body + garments).
 */
import { encodePNG } from '../services/managers/pose-preview';
import type { SkinnedMeshData } from '../services/managers/skin-deform-metrics';
import type { BodyV2GenResult } from './body-v2-generator';


export interface SheetView { label: string; yaw: number; pitch?: number; cy: number; h: number; cx?: number; cz?: number }
export interface SheetMesh { P: Float32Array; N?: Float32Array; indices: Uint32Array; color?: [number, number, number]; vertColor?: Uint8Array }
export interface SheetOpts { tile?: number; cols?: number; wire?: boolean; flat?: boolean }

/** Render `tiles` (each = one view of a set of meshes) into one PNG grid. */
export function renderSheet(tiles: { view: SheetView; meshes: SheetMesh[] }[], opts: SheetOpts = {}): Uint8Array {
  const tile = opts.tile ?? 360, cols = Math.min(opts.cols ?? 3, tiles.length), rows = Math.ceil(tiles.length / cols);
  const W = tile * cols, Hh = tile * rows;
  const rgb = new Uint8Array(W * Hh * 3);
  for (let i = 0; i < W * Hh; i++) { rgb[i * 3] = 236; rgb[i * 3 + 1] = 238; rgb[i * 3 + 2] = 242; }
  const z = new Float32Array(W * Hh).fill(-Infinity);
  const L = norm3([-0.35, 0.55, 0.76]);
  tiles.forEach(({ view: v, meshes }, ti) => {
    const ox = (ti % cols) * tile, oy = Math.floor(ti / cols) * tile;
    const scale = (tile * 0.94) / v.h;
    const ya = (v.yaw * Math.PI) / 180, pa = ((v.pitch ?? 0) * Math.PI) / 180;
    const cyw = Math.cos(ya), syw = Math.sin(ya), cp = Math.cos(pa), sp = Math.sin(pa);
    const rot = (x: number, y: number, zz: number): [number, number, number] => {
      const rx = x * cyw - zz * syw, rz = x * syw + zz * cyw;
      return [rx, y * cp + rz * sp, -y * sp + rz * cp];
    };
    for (const m of meshes) {
      const n = m.P.length / 3, S = new Float32Array(n * 3), NS = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const [rx, ry, rz] = rot(m.P[i * 3] - (v.cx ?? 0), m.P[i * 3 + 1] - v.cy, m.P[i * 3 + 2] - (v.cz ?? 0));
        S[i * 3] = ox + tile / 2 + rx * scale; S[i * 3 + 1] = oy + tile / 2 - ry * scale; S[i * 3 + 2] = rz;
        if (m.N) { const q = rot(m.N[i * 3], m.N[i * 3 + 1], m.N[i * 3 + 2]); NS[i * 3] = q[0]; NS[i * 3 + 1] = q[1]; NS[i * 3 + 2] = q[2]; }
      }
      const base = m.color ?? [226, 190, 168];
      for (let t = 0; t < m.indices.length; t += 3) {
        const a = m.indices[t], b = m.indices[t + 1], c = m.indices[t + 2];
        const ax = S[a * 3], ay = S[a * 3 + 1], bx = S[b * 3], by = S[b * 3 + 1], cx = S[c * 3], cy = S[c * 3 + 1];
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-9) continue;
        // flat face normal (view space), facing the camera
        const ux = bx - ax, uy = -(by - ay), uz = (S[b * 3 + 2] - S[a * 3 + 2]) * scale, wx = cx - ax, wy = -(cy - ay), wz = (S[c * 3 + 2] - S[a * 3 + 2]) * scale;
        let fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx; const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
        const flip = fz < 0;
        if (flip) { fx = -fx; fy = -fy; fz = -fz; }
        const x0 = Math.max(ox, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(ox + tile - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(oy, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(oy + tile - 1, Math.ceil(Math.max(ay, by, cy)));
        const ca = m.vertColor ? [m.vertColor[a * 3], m.vertColor[a * 3 + 1], m.vertColor[a * 3 + 2]] : base;
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
          const qx = px + 0.5, qy = py + 0.5;
          const w0 = ((bx - qx) * (cy - qy) - (by - qy) * (cx - qx)) / area;
          const w1 = ((cx - qx) * (ay - qy) - (cy - qy) * (ax - qx)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const d = w0 * S[a * 3 + 2] + w1 * S[b * 3 + 2] + w2 * S[c * 3 + 2];
          const o = py * W + px; if (d <= z[o]) continue; z[o] = d;
          let nx = fx, ny = fy, nz = fz;
          if (m.N && !opts.flat) {
            nx = w0 * NS[a * 3] + w1 * NS[b * 3] + w2 * NS[c * 3];
            ny = w0 * NS[a * 3 + 1] + w1 * NS[b * 3 + 1] + w2 * NS[c * 3 + 1];
            nz = w0 * NS[a * 3 + 2] + w1 * NS[b * 3 + 2] + w2 * NS[c * 3 + 2];
            const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
            if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }   // a back face seen through a hole: shade it, don't hide it
          }
          const lam = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
          let shade = 0.32 + 0.68 * lam;
          if (opts.wire) {
            // edge distance in pixels ≈ barycentric × the opposite altitude
            const e = Math.min(w0 * Math.abs(area) / Math.hypot(cx - bx, cy - by), w1 * Math.abs(area) / Math.hypot(ax - cx, ay - cy), w2 * Math.abs(area) / Math.hypot(bx - ax, by - ay));
            if (e < 0.6) shade *= 0.55;
          }
          rgb[o * 3] = ca[0] * shade; rgb[o * 3 + 1] = ca[1] * shade; rgb[o * 3 + 2] = ca[2] * shade;
        }
      }
    }
    const gy = Math.round(oy + tile / 2 + v.cy * scale);
    if (gy >= oy && gy < oy + tile) for (let px = ox; px < ox + tile; px++) { const o = gy * W + px; if (z[o] === -Infinity) { rgb[o * 3] = 150; rgb[o * 3 + 1] = 150; rgb[o * 3 + 2] = 160; } }
    for (let py = oy; py < oy + tile; py++) { const o = py * W + ox; rgb[o * 3] = 190; rgb[o * 3 + 1] = 190; rgb[o * 3 + 2] = 200; }
    for (let px = ox; px < ox + tile; px++) { const o = oy * W + px; rgb[o * 3] = 190; rgb[o * 3 + 1] = 190; rgb[o * 3 + 2] = 200; }
  });
  return encodePNG(W, Hh, rgb);
}

function norm3(a: [number, number, number]): [number, number, number] { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// ── shared helpers for the v2 sheets / metrics ──
export function meshOf(r: BodyV2GenResult | import('../renderer/3d/gltf-importer').GltfSkinnedResult): SkinnedMeshData {
  return {
    vertices: r.geometry.vertices, stride: 12, posOffset: 0, indices: r.geometry.indices, jointIndices: r.skinning.jointIndices,
    jointWeights: r.skinning.jointWeights, jointNames: r.skinning.jointNames, jointParents: r.skinning.jointParents!,
    jointLocalPositions: r.skinning.jointLocalPositions!, inverseBindMatrices: r.skinning.inverseBindMatrices,
  };
}
export function bounds(P: Float32Array) { let lo = Infinity, hi = -Infinity; for (let i = 1; i < P.length; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); } return { lo, hi }; }
export function stance(P: Float32Array): SheetView[] {
  const { lo, hi } = bounds(P), cy = (lo + hi) / 2, h = (hi - lo) * 1.06, uy = hi - (hi - lo) * 0.24, uh = (hi - lo) * 0.42;
  return [{ label: 'front', yaw: 0, cy, h }, { label: 'side', yaw: 90, cy, h }, { label: '3/4', yaw: 35, pitch: 6, cy, h },
    { label: 'back', yaw: 180, cy, h }, { label: 'upper front', yaw: 0, cy: uy, h: uh }, { label: 'upper 3/4', yaw: -38, pitch: 8, cy: uy, h: uh }];
}

