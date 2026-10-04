/**
 * pose-preview.ts — see and MEASURE a preset pose / animation frame without a browser (pose & animation audit
 * 2026-09-28). Test-support code:
 *   • `renderPosePNG` — a tiny CPU z-buffer rasterizer: the posed body (skinned with the GPU-exact blend via
 *     clothing-audit-harness.skinAll) drawn front / left side / three-quarter, penetrating verts in RED.
 *   • `measureSelfIntersection` — arm/hand skin that has gone INSIDE the torso, head, legs or the other arm.
 *   • `sampleDefaultClip` — a default clip at a frame, sampled exactly like the engine (skeleton-animator
 *     sampleClipPose) on top of the Relaxed stance.
 */
import { deflateSync } from 'node:zlib';
import { skinAll, grid, dominant } from './clothing-audit-harness';
import type { SkinnedMeshData, PoseRotations } from './skin-deform-metrics';
import { buildDefaultClips, DEFAULT_ONESHOT_CLIP_NAMES, defaultRestRotation } from './default-animations';
import { sampleClipPose, rebaseClipRest } from '../../renderer/3d/skeleton-animator';
import { BODY_POSES } from './body-generator';
import { buildLimbCache, limbIntersections, type IntersectReport } from './arm-clearance';

type V3 = [number, number, number];

// ── PNG (RGB, no filter) ─────────────────────────────────────────────────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
export function encodePNG(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

// ── Rasterizer ───────────────────────────────────────────────────────────────────────────────────────────────────
/** One view: camera yaw (deg) orbiting the body, 0 = looking at the FRONT (+Z face), 90 = its left side; `cy`/`h` =
 *  the world height the tile is centred on / spans (m) — full body by default, smaller = zoomed. */
export interface View { label: string; yaw: number; pitch?: number; cy?: number; h?: number }
export const DEFAULT_VIEWS: View[] = [
  { label: 'front', yaw: 0 }, { label: 'left side', yaw: 90 }, { label: '3/4', yaw: 35, pitch: 10 },
  { label: 'upper front', yaw: 0, cy: 1.3, h: 0.95 }, { label: 'upper right-3/4', yaw: -40, pitch: 10, cy: 1.3, h: 0.95 }, { label: 'upper back-3/4', yaw: 150, pitch: 10, cy: 1.3, h: 0.95 },
];

/**
 * Render P (xyz per vert) + triangles into square tiles (3 per row). `red` = verts to paint red (penetrating).
 * Orthographic, Lambert + ambient, two-sided.
 */
export function renderPosePNG(P: Float32Array, indices: Uint32Array, red: Set<number> = new Set(), views = DEFAULT_VIEWS, tile = 380, vertColor?: Uint8Array): Uint8Array {
  const cols = Math.min(3, views.length), rowsN = Math.ceil(views.length / cols);
  const W = tile * cols, H = tile * rowsN;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = 236; rgb[i * 3 + 1] = 238; rgb[i * 3 + 2] = 242; }
  const z = new Float32Array(W * H).fill(-Infinity);
  const n = P.length / 3;
  views.forEach((v, vi) => {
    const ox = (vi % cols) * tile, oy = Math.floor(vi / cols) * tile;
    const cy = v.cy ?? 0.92, scale = (tile * 0.94) / (v.h ?? 1.95);
    const ya = (v.yaw * Math.PI) / 180, pa = ((v.pitch ?? 0) * Math.PI) / 180;
    const cyw = Math.cos(ya), syw = Math.sin(ya), cp = Math.cos(pa), sp = Math.sin(pa);
    const S = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1] - cy, zz = P[i * 3 + 2];
      const rx = x * cyw - zz * syw, rz = x * syw + zz * cyw;
      const ry = y * cp + rz * sp, rz2 = -y * sp + rz * cp;
      S[i * 3] = ox + tile / 2 + rx * scale; S[i * 3 + 1] = oy + tile / 2 - ry * scale; S[i * 3 + 2] = rz2;
    }
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2];
      const ax = S[a*3], ay = S[a*3+1], bx = S[b*3], by = S[b*3+1], cx = S[c*3], cy2 = S[c*3+1];
      const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-9) continue;
      const ux = bx - ax, uy = -(by - ay), uz = (S[b*3+2] - S[a*3+2]) * scale;
      const wx = cx - ax, wy = -(cy2 - ay), wz = (S[c*3+2] - S[a*3+2]) * scale;
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const lam = Math.max(0, nx * -0.35 + ny * 0.55 + nz * 0.76);
      const shade = 0.3 + 0.7 * lam;
      const isRed = red.has(a) || red.has(b) || red.has(c);
      // `vertColor` (rgb per vertex, optional) tints whole meshes — the gait preview's garments.
      const base = isRed ? [235, 40, 40] : vertColor ? [vertColor[a * 3], vertColor[a * 3 + 1], vertColor[a * 3 + 2]] : [226, 190, 168];
      const x0 = Math.max(ox, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(ox + tile - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(oy, Math.floor(Math.min(ay, by, cy2))), y1 = Math.min(oy + tile - 1, Math.ceil(Math.max(ay, by, cy2)));
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const qx = px + 0.5, qy = py + 0.5;
        const w0 = ((bx - qx) * (cy2 - qy) - (by - qy) * (cx - qx)) / area;
        const w1 = ((cx - qx) * (ay - qy) - (cy2 - qy) * (ax - qx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * S[a*3+2] + w1 * S[b*3+2] + w2 * S[c*3+2];
        const o = py * W + px; if (d <= z[o]) continue; z[o] = d;
        rgb[o*3] = base[0] * shade; rgb[o*3+1] = base[1] * shade; rgb[o*3+2] = base[2] * shade;
      }
    }
    const gy = Math.round(oy + tile / 2 + cy * scale);
    if (gy >= oy && gy < oy + tile) for (let px = ox; px < ox + tile; px++) { const o = gy * W + px; rgb[o*3] = 150; rgb[o*3+1] = 150; rgb[o*3+2] = 160; }
    for (let py = oy; py < oy + tile; py++) { const o = py * W + ox; rgb[o*3] = 190; rgb[o*3+1] = 190; rgb[o*3+2] = 200; }
    for (let px = ox; px < ox + tile; px++) { const o = oy * W + px; rgb[o*3] = 190; rgb[o*3+1] = 190; rgb[o*3+2] = 200; }
  });
  return encodePNG(W, H, rgb);
}

// ── Self-intersection — the engine's own measure (arm-clearance.ts) ─────────────────────────────────────────────
export type { IntersectReport } from './arm-clearance';
export function measureSelfIntersection(m: SkinnedMeshData, restP: Float32Array, P: Float32Array, N: Float32Array): IntersectReport {
  return limbIntersections(buildLimbCache(m, restP), P, N);
}

// ── Clip sampling ────────────────────────────────────────────────────────────────────────────────────────────────
/** A default clip's pose at `frame`, over the Relaxed stance (what the engine plays: untouched joints keep the pose). */
export function sampleDefaultClip(m: SkinnedMeshData, clipName: string, frame: number, basePose: PoseRotations = BODY_POSES['Relaxed'] ?? []): PoseRotations {
  const joints = m.jointNames.map((name) => ({ name }));
  const clip = buildDefaultClips(joints).find((c) => c.name === clipName);
  if (!clip) throw new Error(`no clip ${clipName}`);
  const rel = new Map(basePose.map((r) => [r.joint, r.q]));
  const bind = {
    rotations: m.jointNames.map((nm) => [...(rel.get(nm) ?? [0, 0, 0, 1])] as [number, number, number, number]),
    positions: m.jointNames.map((_, j) => [m.jointLocalPositions[j*3], m.jointLocalPositions[j*3+1], m.jointLocalPositions[j*3+2]] as V3),
    scales: m.jointNames.map(() => [1, 1, 1] as V3),
  };
  // A one-shot plays as an idle BREAK in the engine: its rest keys are re-based onto the current pose (rebaseClipRest).
  // Stock one-shots are re-based onto the current pose (engine: _fitDefaultOneShot / idle breaks) — see rebaseClipRest.
  const played = DEFAULT_ONESHOT_CLIP_NAMES.includes(clip.name)
    ? rebaseClipRest(clip, new Map(bind.rotations.map((q, i) => [i, q])), (ji) => defaultRestRotation(m.jointNames[ji]))
    : clip;
  const s = sampleClipPose(played, bind, frame);
  return m.jointNames.map((joint, j) => ({ joint, q: s.rotations[j] }));
}

/** Skin + measure + render in one go. */
export function previewPose(m: SkinnedMeshData, restVerts: Float32Array, pose: PoseRotations) {
  const rest = skinAll(m, restVerts, m.jointIndices, m.jointWeights, [], 'dualQuat');
  const posed = skinAll(m, restVerts, m.jointIndices, m.jointWeights, pose, 'dualQuat');
  const inter = measureSelfIntersection(m, rest.P, posed.P, posed.N);
  return { inter, png: renderPosePNG(posed.P, m.indices, inter.verts) };
}

export { armPose, armsPose, mirrorQ, type ArmSpec } from './pose-authoring';

// ── Procedural idle sampling ─────────────────────────────────────────────────────────────────────────────────────
import { quat } from 'gl-matrix';
import { Scene3DAnimation, IDLE_JOINTS } from './scene3d-animation';
/** The procedural idle's pose at `t` seconds — the engine's own Scene3DAnimation.applyIdle, run on a bare joint list
 *  based on the Relaxed stance (intensity 1, legs 'fk'). */
export function sampleIdlePose(m: SkinnedMeshData, t: number, intensity = 1, basePose: PoseRotations = BODY_POSES['Relaxed'] ?? []): PoseRotations {
  const rel = new Map(basePose.map((r) => [r.joint, r.q]));
  const joints = m.jointNames.map((name) => ({ name, localRotation: [...(rel.get(name) ?? [0, 0, 0, 1])] as number[] }));
  const base = new Map<string, [number, number, number, number]>();
  for (const j of joints) if ((IDLE_JOINTS as readonly string[]).includes(j.name) || j.name.startsWith('upperleg') || j.name.startsWith('lowerleg') || j.name.startsWith('foot') || j.name === 'hips') base.set(j.name, [...j.localRotation] as [number, number, number, number]);
  const self = { _idleIdxCache: new WeakMap(), _idleTmpQuat: quat.create(), _idleOutQuat: quat.create() };
  const skel = { data: { joints } };
  (Scene3DAnimation.prototype.applyIdle as (this: unknown, ...a: unknown[]) => void).call(self, skel, { intensity, base, legMode: 'fk' }, t);
  return joints.map((j) => ({ joint: j.name, q: j.localRotation }));
}

// ── Contact sheets (motion review) ───────────────────────────────────────────────────────────────────────────────
/** Frames of an animation as a grid of small tiles (one view each) — check arcs, timing, overshoot at a glance. */
export function renderFramesPNG(frames: Float32Array[], indices: Uint32Array, view: View = { label: '3/4', yaw: 30, pitch: 8, cy: 1.15, h: 1.5 }, tile = 200, cols = 8): Uint8Array {
  const rows = Math.ceil(frames.length / cols);
  const tiles = frames.map((P) => ({ P, png: null as unknown }));
  // render each frame into its own tile by offsetting a copy horizontally/vertically in world space is fiddly —
  // instead rasterize per frame and blit.
  const W = tile * cols, H = tile * rows, out = new Uint8Array(W * H * 3).fill(240);
  const inflate = (png: Uint8Array): Uint8Array => {
    // decode our own PNG (single IDAT, filter 0 rows)
    let o = 8, data: Uint8Array[] = [];
    let w = 0;
    while (o < png.length) {
      const len = (png[o] << 24 | png[o+1] << 16 | png[o+2] << 8 | png[o+3]) >>> 0, type = String.fromCharCode(...png.subarray(o + 4, o + 8));
      if (type === 'IHDR') w = (png[o+8] << 24 | png[o+9] << 16 | png[o+10] << 8 | png[o+11]) >>> 0;
      if (type === 'IDAT') data.push(png.subarray(o + 8, o + 8 + len));
      o += 12 + len;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const raw: Uint8Array = require('node:zlib').inflateSync(Buffer.concat(data));
    const rgb = new Uint8Array(w * w * 3);
    for (let y = 0; y < w; y++) rgb.set(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)), y * w * 3);
    return rgb;
  };
  tiles.forEach((t, i) => {
    const rgb = inflate(renderPosePNG(t.P, indices, new Set(), [view], tile));
    const ox = (i % cols) * tile, oy = Math.floor(i / cols) * tile;
    for (let y = 0; y < tile; y++) out.set(rgb.subarray(y * tile * 3, (y + 1) * tile * 3), ((oy + y) * W + ox) * 3);
  });
  return encodePNG(W, H, out);
}
