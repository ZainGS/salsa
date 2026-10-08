/**
 * Face-on framing for the edit camera (Edit Mesh's Frame with faces selected — next Edit Mesh batch 2026-10-08 §3).
 *
 * Given the selected faces as WORLD-space polygons, the camera turns to look straight at them (their area-weighted
 * normal toward the camera), centred, the ortho half-height fitted with a margin. The edit camera is a roll-free orbit
 * (azimuth / elevation around world up), so "no roll" holds by construction; the turn is the minimal one: the current
 * azimuth is kept when the normal points (nearly) straight up / down — where any azimuth is face-on — and the elevation
 * stays inside the orbit's limits. Faces whose normals don't mostly agree (|Σ area·n| / Σ area below `agree`) are not
 * turned to: null.
 */

/** |Σ area·n| / Σ area at or above this = the faces face one way (a flat / gently curved panel). */
export const FACE_ON_AGREE = 0.9;

export interface FaceOnFramingOptions {
  /** The orbit's current azimuth (kept when the normal is vertical). */
  azimuth: number;
  /** Viewport width / height. */
  aspect: number;
  /** Margin factor on the fitted half-height (1 = edge to edge). */
  padding: number;
  /** The smallest half-height (before the padding) — a tiny face still shows some of its surroundings. */
  minHalf?: number;
  minElevation?: number;
  maxElevation?: number;
  /** Agreement threshold (default {@link FACE_ON_AGREE}). */
  agree?: number;
}

export interface FaceOnFraming {
  /** The orbit target (world): the faces' centre on screen. */
  target: [number, number, number];
  azimuth: number;
  elevation: number;
  /** The ortho half-height that fits the faces with the padding. */
  halfHeight: number;
  /** The unit normal the camera looks against (world). */
  normal: [number, number, number];
}

/** Faces = flat world xyz lists (x0, y0, z0, x1, …), one per face (≥ 3 corners). */
export function faceOnFraming(faces: ArrayLike<number>[], o: FaceOnFramingOptions): FaceOnFraming | null {
  let ax = 0, ay = 0, az = 0, total = 0;
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const f of faces) {
    const n = Math.floor(f.length / 3);
    if (n < 3) continue;
    // Newell: twice the area vector
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const x0 = f[k * 3], y0 = f[k * 3 + 1], z0 = f[k * 3 + 2], x1 = f[j * 3], y1 = f[j * 3 + 1], z1 = f[j * 3 + 2];
      nx += (y0 - y1) * (z0 + z1); ny += (z0 - z1) * (x0 + x1); nz += (x0 - x1) * (y0 + y1);
      cx += x0; cy += y0; cz += z0; count++;
    }
    ax += nx; ay += ny; az += nz;
    total += Math.hypot(nx, ny, nz);
  }
  const len = Math.hypot(ax, ay, az);
  if (!(total > 0) || !(len > 0) || count === 0 || len / total < (o.agree ?? FACE_ON_AGREE)) return null;
  const nrm: [number, number, number] = [ax / len, ay / len, az / len];
  const minEl = o.minElevation ?? -Math.PI / 2 + 0.05, maxEl = o.maxElevation ?? Math.PI / 2 - 0.05;
  const el0 = Math.asin(Math.max(-1, Math.min(1, nrm[1])));
  const elevation = Math.max(minEl, Math.min(maxEl, el0));
  // (straight up / down — or past the orbit's pole limit: every azimuth is as face-on, keep the current one)
  const azimuth = el0 > maxEl || el0 < minEl || Math.hypot(nrm[0], nrm[2]) < 1e-9 ? o.azimuth : Math.atan2(nrm[0], nrm[2]);
  // the camera basis at the end of the turn (eye at target + d · radius, world up)
  const d = [Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)];
  const f = [-d[0], -d[1], -d[2]];
  // right = forward × world up (the elevation never reaches ±90°, so it is never zero)
  const rl = Math.hypot(f[2], f[0]) || 1;
  const rx = -f[2] / rl, ry = 0, rz = f[0] / rl;
  const ux = ry * f[2] - rz * f[1], uy = rz * f[0] - rx * f[2], uz = rx * f[1] - ry * f[0];   // right × forward
  cx /= count; cy /= count; cz /= count;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const fc of faces) {
    const n = Math.floor(fc.length / 3);
    if (n < 3) continue;
    for (let k = 0; k < n; k++) {
      const px = fc[k * 3] - cx, py = fc[k * 3 + 1] - cy, pz = fc[k * 3 + 2] - cz;
      const sx = px * rx + py * ry + pz * rz, sy = px * ux + py * uy + pz * uz;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const aspect = o.aspect > 0 ? o.aspect : 1;
  const half = Math.max((y1 - y0) / 2, (x1 - x0) / 2 / aspect, o.minHalf ?? 0, 1e-6) * o.padding;
  return {
    target: [cx + rx * mx + ux * my, cy + ry * mx + uy * my, cz + rz * mx + uz * my],
    azimuth, elevation, halfHeight: half, normal: nrm,
  };
}
