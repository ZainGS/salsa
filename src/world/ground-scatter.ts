// ── Procedural Ground — P5 SCATTER placement (procedural-ground.md §7) ───────────────────────────
// The instancing HALF of the ground system: blue-noise props (flowers / pebbles / twigs / tall-grass
// clumps / bushes / rocks) placed over a ground mesh's footprint, with per-type DENSITY driven by the
// SAME weathering masks the material uses (ground-masks.ts). Worn tracks thin the flowers + grass; moist
// edges grow more grass + bush — one source of truth, so the scatter reads coherent with the surface.
//
// This module is PURE (no renderer / scene-graph deps): it produces canonical LOCAL geometry per prop
// type + a list of per-instance transforms. scene3d-manager turns each into ONE GPU-instanced draw
// (ArrayGroup3D) — never thousands of loose nodes. Vegetation geometry is deliberately LOW-POLY: the
// user flagged it as a later QUALITY pass; P5 delivers the SYSTEM (placement + mask density + instancing).

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { Accum3D } from './meshbuild';
import { bladeTuft, type BladeTuftSpec } from './blade';
import { emitStalk, resolveStalk, type StalkSpec } from './stalk';
import type { Rng } from './util';
import { wearMask, edgeMask, moistMask, dirtMask, fbm2 } from './ground-masks';

/** The world-space rectangle a ground mesh covers (its UV 0..1 maps across this rect). y = ground height. */
export interface ScatterFootprint {
  minX: number;
  minZ: number;
  sizeX: number;
  sizeZ: number;
  y: number;
}

/**
 * ★ The real SURFACE a scatter grows out of (bug: props used to be laid on a flat world-space rectangle, so a
 * rotated / scaled / non-flat ground left its foliage behind on a plane). Triangles are held in the space the
 * transforms are EMITTED in — the ground mesh's OWN LOCAL space — so the scatter group can simply be PARENTED
 * to the mesh and every later move/rotate/scale composes for free (see ShapeManager.scatterOnGround3D).
 */
export interface ScatterSurface {
  /** 9 floats per triangle (3 × xyz). */
  pos: Float32Array;
  /** 9 floats per triangle (3 × the vertex normal). */
  nrm: Float32Array;
  /** 6 floats per triangle (3 × uv) — the MASK domain (§1 shared masks). */
  uv: Float32Array;
  /** Running triangle-area sum (length = triCount); `cum[triCount-1]` = total area. Drives area-WEIGHTED picking. */
  cum: Float32Array;
  triCount: number;
  area: number;
  /** Planar XZ bounds of the surface — the fallback mask domain when the mesh carries no real UVs. */
  minX: number; minZ: number; sizeX: number; sizeZ: number;
  /** Mean Y (only used to report a footprint). */
  y: number;
  /** Whether the mesh's uv attribute actually varies (else the planar projection is used for the masks). */
  hasUv: boolean;
  /** WORLD units per surface unit — the mesh's uniform world scale. Spacing + prop size are given in metres and
   *  divided by this, so a scatter over a 2×-scaled plane still reads as real-size plants at real spacing. */
  unit: number;
}

/** One placement the sampler produced: a point ON the surface plus the interpolated surface normal + uv. */
export interface SurfaceSample {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  u: number; v: number;
}

/** Per-type density multipliers (1 = preset default, 0 = off) + the shared wear track + an extra reject. */
export interface ScatterRules {
  seed?: number;
  /** ★ Props grow PERPENDICULAR to the surface (default) or straight up in world/parent space (`false`).
   *  The random yaw + lean jitter is applied on top of whichever basis. */
  alignToSurface?: boolean;
  flowers?: number;
  pebbles?: number;
  twigs?: number;
  tallGrass?: number;
  bushes?: number;
  rocks?: number;
  /** The worn TRACK in uv (center + radius) — the same mask the material's weathering uses; thins scatter. */
  wearPath?: readonly [number, number, number] | null;
  /** Extra world-space reject (e.g. ponds / paved paths) — return true to drop a point. */
  reject?: ((x: number, z: number) => boolean) | null;
}

/** A ready-to-instance scatter layer: one canonical geometry + N per-instance transforms. */
export interface ScatterLayer {
  name: string;
  geometry: MeshGeometry;
  color: [number, number, number];
  leafCard?: boolean;
  /** LOD band (0 drops first at distance … 5 last): flowers 0, twigs 1, pebbles 2, tallGrass 3, bushes 4, rocks 5. */
  band: number;
  /** Optional REDUCED-geometry variant for the mid/far LOD band (foliage-quality.md §2.5) — same instance
   *  transforms, fewer blades. The scene manager builds both and swaps them on the distance gate. */
  lodGeometry?: MeshGeometry;
  transforms: { x: number; y: number; z: number; ry: number; rx: number; rz: number; scale: number }[];
  /** WIND (foliage-quality.md S1) — the VEGETATION bands sway; pebbles/rocks/twigs are inert. `height` is the
   *  prop's canonical local height (the grading denominator), `stiffness` the bend exponent, `amount` the scale.
   *  The per-instance PHASE is derived in-shader from each copy's world translation — a meadow never pulses
   *  in unison, and no per-instance data is added to the (already instanced) transform buffer. */
  wind?: { height: number; stiffness: number; amount: number };
  /** TRANSLUCENCY + GROUND BLEND + BASE AO (foliage-quality.md S2) — backlit glow + a base that sits in the
   *  ground. Vegetation only. */
  foliageShade?: { translucency?: number; translucencyColor?: [number, number, number]; groundBlend?: number; groundTint?: [number, number, number]; baseAO?: number };
}

/** The soil tint scatter vegetation blends toward at its base (matches the foliage generator's). */
const SCATTER_GROUND_TINT: [number, number, number] = [0.26, 0.28, 0.17];

/** The default `park` biome scatter (procedural-ground.md §10 CityPark). */
export const PARK_RULES: Required<Omit<ScatterRules, 'seed' | 'wearPath' | 'reject' | 'alignToSurface'>> = {
  flowers: 1, pebbles: 0.6, twigs: 0.8, tallGrass: 1, bushes: 1, rocks: 1,
};

// ── Blue-noise sampler (§7 "never a grid") ───────────────────────────────────────────────────────
/** PLANAR blue-noise. Superseded for ground scatter by {@link poissonOnSurface} (which samples the mesh's real
 *  triangles); kept for 2D/rect callers and as the reference for the min-distance property.
 *
 *  Poisson-disc–style blue-noise over a [0,w]×[0,h] rect: a jittered-grid candidate per cell, greedily
 *  rejected against a spatial hash so EVERY accepted pair is ≥ minDist apart (the min-distance property).
 *  Seeded (deterministic) → the layout is stable across reloads. Returns points in world-rect coordinates. */
export function poissonDisc(w: number, h: number, minDist: number, rng: Rng, maxPoints = 20000): [number, number][] {
  const out: [number, number][] = [];
  if (w <= 0 || h <= 0 || minDist <= 0) return out;
  const cell = minDist / Math.SQRT2;             // ≤ 1 accepted point per background cell
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const grid = new Int32Array(gw * gh).fill(-1); // cell → index into out (-1 empty)
  const min2 = minDist * minDist;
  // Candidate order: a jittered grid at minDist spacing (blue-noise-ish, no visible rows once jittered).
  const stepX = minDist, stepZ = minDist;
  const nx = Math.max(1, Math.ceil(w / stepX));
  const nz = Math.max(1, Math.ceil(h / stepZ));
  for (let jz = 0; jz < nz && out.length < maxPoints; jz++) {
    for (let jx = 0; jx < nx && out.length < maxPoints; jx++) {
      const px = (jx + rng.next()) * stepX;
      const pz = (jz + rng.next()) * stepZ;
      if (px >= w || pz >= h) continue;
      const cx = Math.min(gw - 1, Math.floor(px / cell));
      const cz = Math.min(gh - 1, Math.floor(pz / cell));
      let ok = true;
      for (let dz = -2; dz <= 2 && ok; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const gx = cx + dx, gzz = cz + dz;
          if (gx < 0 || gzz < 0 || gx >= gw || gzz >= gh) continue;
          const idx = grid[gzz * gw + gx];
          if (idx < 0) continue;
          const q = out[idx];
          const ex = q[0] - px, ez = q[1] - pz;
          if (ex * ex + ez * ez < min2) { ok = false; break; }
        }
      }
      if (!ok) continue;
      grid[cz * gw + cx] = out.length;
      out.push([px, pz]);
    }
  }
  return out;
}

// ── The SURFACE (bug fix: grow out of the mesh, not off a flat rectangle) ────────────────────────

/**
 * Build a {@link ScatterSurface} from a mesh's interleaved vertex buffer + index buffer. Everything stays in the
 * INPUT space (the mesh's local space); `worldScale` only tells the placer how big a metre is in that space.
 *
 * @param vertices interleaved attributes; `stride` floats per vertex with pos at 0 (3), normal at 3 (3), uv at 6 (2).
 * @param indices  the real index buffer — the triangles are respected, so a non-rectangular / holed ground
 *                 scatters only where it actually has surface.
 */
export function buildScatterSurface(
  vertices: Float32Array, indices: ArrayLike<number>,
  opts?: { stride?: number; worldScale?: number },
): ScatterSurface | null {
  const S = opts?.stride ?? 12;
  const n = Math.floor(indices.length / 3);
  if (n <= 0 || vertices.length < S) return null;
  const pos = new Float32Array(n * 9), nrm = new Float32Array(n * 9), uv = new Float32Array(n * 6);
  const cum = new Float32Array(n);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, sumY = 0;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  let area = 0, tri = 0;
  for (let t = 0; t < n; t++) {
    const i0 = indices[t * 3] * S, i1 = indices[t * 3 + 1] * S, i2 = indices[t * 3 + 2] * S;
    if (i0 + S > vertices.length || i1 + S > vertices.length || i2 + S > vertices.length) continue;
    const p = tri * 9, q = tri * 6;
    const src = [i0, i1, i2];
    for (let k = 0; k < 3; k++) {
      const i = src[k];
      const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
      pos[p + k * 3] = x; pos[p + k * 3 + 1] = y; pos[p + k * 3 + 2] = z;
      nrm[p + k * 3] = vertices[i + 3]; nrm[p + k * 3 + 1] = vertices[i + 4]; nrm[p + k * 3 + 2] = vertices[i + 5];
      uv[q + k * 2] = vertices[i + 6]; uv[q + k * 2 + 1] = vertices[i + 7];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      sumY += y;
      const uu = vertices[i + 6], vv = vertices[i + 7];
      if (uu < uMin) uMin = uu; if (uu > uMax) uMax = uu;
      if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv;
    }
    // Triangle area = ½‖(b−a)×(c−a)‖ — the area weight that makes big triangles receive proportionally more props.
    const ax = pos[p], ay = pos[p + 1], az = pos[p + 2];
    const e1x = pos[p + 3] - ax, e1y = pos[p + 4] - ay, e1z = pos[p + 5] - az;
    const e2x = pos[p + 6] - ax, e2y = pos[p + 7] - ay, e2z = pos[p + 8] - az;
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    area += Math.hypot(cx, cy, cz) * 0.5;
    cum[tri] = area;
    tri++;
  }
  if (tri === 0 || area <= 0) return null;
  return {
    pos: pos.subarray(0, tri * 9), nrm: nrm.subarray(0, tri * 9), uv: uv.subarray(0, tri * 6),
    cum: cum.subarray(0, tri), triCount: tri, area,
    minX, minZ, sizeX: Math.max(1e-6, maxX - minX), sizeZ: Math.max(1e-6, maxZ - minZ),
    y: sumY / (tri * 3),
    hasUv: (uMax - uMin) > 1e-6 && (vMax - vMin) > 1e-6,
    unit: Math.max(1e-6, opts?.worldScale ?? 1),
  };
}

/** Adapt the legacy flat {@link ScatterFootprint} to a surface: one world-space quad, +Y normal, uv 0..1. */
export function footprintSurface(fp: ScatterFootprint): ScatterSurface {
  const { minX, minZ, sizeX, sizeZ, y } = fp;
  const V = new Float32Array(4 * 12);
  const put = (i: number, x: number, z: number, u: number, v: number): void => {
    const o = i * 12;
    V[o] = x; V[o + 1] = y; V[o + 2] = z;
    V[o + 3] = 0; V[o + 4] = 1; V[o + 5] = 0;
    V[o + 6] = u; V[o + 7] = v;
  };
  put(0, minX, minZ, 0, 0); put(1, minX + sizeX, minZ, 1, 0);
  put(2, minX + sizeX, minZ + sizeZ, 1, 1); put(3, minX, minZ + sizeZ, 0, 1);
  return buildScatterSurface(V, [0, 1, 2, 0, 2, 3])!;
}

const isSurface = (t: ScatterFootprint | ScatterSurface): t is ScatterSurface => (t as ScatterSurface).triCount !== undefined;

/**
 * ★ Blue-noise placement ON a surface (replaces the flat-rect `poissonDisc` for real ground meshes).
 * TRIANGLE-AREA-WEIGHTED dart throwing: candidates are drawn uniformly over the surface AREA (pick a triangle
 * with probability ∝ its area, then a uniform barycentric point), and each is greedily rejected against a 3D
 * spatial hash so **every accepted pair is ≥ minDist apart in real space** — the same min-distance/blue-noise
 * property `poissonDisc` gave on the plane, now valid on a tilted, scaled or curved surface. Position, NORMAL
 * and uv are barycentrically interpolated, so the caller gets an orientation and a mask coordinate per sample.
 */
export function poissonOnSurface(s: ScatterSurface, minDist: number, rng: Rng, maxPoints = 20000): SurfaceSample[] {
  const out: SurfaceSample[] = [];
  if (minDist <= 0 || s.area <= 0) return out;
  const min2 = minDist * minDist;
  const cell = minDist / Math.SQRT2;
  // Sparse 3D hash: cellKey → indices into `out`. Only occupied cells are stored, so an unbounded surface costs
  // nothing extra (a dense grid over a 40 m plane at 0.28 m spacing would be fine, but a tall mesh would not).
  const grid = new Map<number, number[]>();
  const key = (a: number, b: number, c: number): number => (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) | 0;
  // Enough darts that the accepted set actually saturates the surface (≈ area / minDist² sites, × an
  // oversample so the greedy pass finds them). Capped so a huge field can't run away.
  const sites = s.area / (minDist * minDist);
  const darts = Math.min(400000, Math.max(16, Math.ceil(sites * 9)));
  for (let d = 0; d < darts && out.length < maxPoints; d++) {
    // Area-weighted triangle pick (binary search over the running area sum).
    const target = rng.next() * s.area;
    let lo = 0, hi = s.triCount - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.cum[mid] < target) lo = mid + 1; else hi = mid; }
    // Uniform barycentric point in that triangle.
    let b1 = rng.next(), b2 = rng.next();
    if (b1 + b2 > 1) { b1 = 1 - b1; b2 = 1 - b2; }
    const b0 = 1 - b1 - b2;
    const p = lo * 9, q = lo * 6;
    const x = s.pos[p] * b0 + s.pos[p + 3] * b1 + s.pos[p + 6] * b2;
    const y = s.pos[p + 1] * b0 + s.pos[p + 4] * b1 + s.pos[p + 7] * b2;
    const z = s.pos[p + 2] * b0 + s.pos[p + 5] * b1 + s.pos[p + 8] * b2;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
    let ok = true;
    for (let dz = -2; dz <= 2 && ok; dz++) {
      for (let dy = -2; dy <= 2 && ok; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const bucket = grid.get(key(gx + dx, gy + dy, gz + dz));
          if (!bucket) continue;
          let hit = false;
          for (const idx of bucket) {
            const o = out[idx];
            const ex = o.x - x, ey = o.y - y, ez = o.z - z;
            if (ex * ex + ey * ey + ez * ez < min2) { hit = true; break; }
          }
          if (hit) { ok = false; break; }
        }
      }
    }
    if (!ok) continue;
    let nx = s.nrm[p] * b0 + s.nrm[p + 3] * b1 + s.nrm[p + 6] * b2;
    let ny = s.nrm[p + 1] * b0 + s.nrm[p + 4] * b1 + s.nrm[p + 7] * b2;
    let nz = s.nrm[p + 2] * b0 + s.nrm[p + 5] * b1 + s.nrm[p + 8] * b2;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; } else { nx = 0; ny = 1; nz = 0; }
    // MASK domain (§1 "one mask, two consumers"): the mesh's own uvs when it has them, else the planar
    // projection the flat footprint always used — so the wear/moist/dirt fields stay meaningful either way.
    const u = s.hasUv ? s.uv[q] * b0 + s.uv[q + 2] * b1 + s.uv[q + 4] * b2 : (x - s.minX) / s.sizeX;
    const v = s.hasUv ? s.uv[q + 1] * b0 + s.uv[q + 3] * b1 + s.uv[q + 5] * b2 : (z - s.minZ) / s.sizeZ;
    const k = key(gx, gy, gz);
    let bucket = grid.get(k);
    if (!bucket) { bucket = []; grid.set(k, bucket); }
    bucket.push(out.length);
    out.push({ x, y, z, nx, ny, nz, u, v });
  }
  return out;
}

const DEG = 180 / Math.PI;
/**
 * Euler angles (deg, applied Y→X→Z exactly as Shape.updateLocalMatrix does) that take the prop's local +Y onto
 * `n`, for a chosen yaw `yawDeg` about the world/parent up. Solving Ry(ψ)·Rx(φ)·Rz(θ)·ŷ = n gives
 * θ = asin(−aₓ) and φ = atan2(a_z, a_y) where a = Ry(−ψ)·n. World-up (0,1,0) falls out as rx = rz = 0, so the
 * `alignToSurface: false` branch is exactly the old behaviour.
 */
export function alignEuler(nx: number, ny: number, nz: number, yawDeg: number): { rx: number; rz: number } {
  const psi = yawDeg / DEG, cp = Math.cos(psi), sp = Math.sin(psi);
  const ax = nx * cp - nz * sp;
  const ay = ny;
  const az = nx * sp + nz * cp;
  const rz = Math.asin(Math.max(-1, Math.min(1, -ax))) * DEG;
  const rx = Math.atan2(az, ay) * DEG;
  return { rx, rz };
}

// ── Canonical (local, origin) prop geometry ──────────────────────────────────────────────────────
// Everything except tallGrass is still a LOW-POLY placeholder (quality is a later pass: P2 whorl/stalk
// for flowers, P4 branch for bushes). tallGrass now emits REAL blade clumps (foliage-quality.md P1).
/** What a prop's builder hands back: the canonical geometry, an optional reduced LOD variant, the real
 *  local height (the wind grading denominator), and — for blade props — the blade count (the field cap). */
interface BuiltProp {
  geometry: MeshGeometry;
  lod?: MeshGeometry;
  height?: number;
  /** Thin swept elements (blades / petals) in ONE prop — what the FIELD budget is counted in. */
  blades?: number;
  /** Extra sub-layers of the SAME prop that need their own colour (a flower's eye and stem are not the
   *  colour of its petals). They SHARE the prop's instance transforms — one extra instanced draw each,
   *  no extra placement work — and carry their own reduced LOD variant. */
  extra?: { suffix: string; geometry: MeshGeometry; lod?: MeshGeometry; color: [number, number, number]; windAmount?: number; foliageShade?: ScatterLayer['foliageShade'] }[];
}

/** The scatter MEADOW FLOWER (foliage-quality.md §4 "daisy") — a real `stalk` + `whorl` (P2), replacing
 *  the beam-plus-blob placeholder. Deliberately leaner than the authored `daisy` plant (11 short petals,
 *  3 spine segments): this one is drawn hundreds of times per field. */
const SCATTER_DAISY: StalkSpec = resolveStalk({
  height: 0.26, thickness: 0.004, curve: 0.35, segments: 3, sides: 3,
  bloomStart: 0.94, bloomEnd: 1, bloomDensity: 12, bloomScaleCurve: 0, pedicel: 0.06,
  terminalCluster: false, branches: 0,
  leaves: 2, leafStart: 0.05, leafEnd: 0.3, leafLength: 0.06, leafWidth: 0.018, leafShape: 'pointed',
  floret: {
    count: 11, rows: 1, elementLength: 0.045, elementWidth: 0.011, lengthVar: 0.16,
    shape: 'rounded', pitch: 1.32, pitchVar: 0.18, curve: 0.28, twist: 0.14, fold: 0.16, segments: 2,
    centerRadius: 0.012, centerDome: 0.6, centerSides: 6,
  },
});
const SCATTER_PETAL: [number, number, number] = [0.95, 0.94, 0.9];
const SCATTER_EYE: [number, number, number] = [0.98, 0.82, 0.18];
const SCATTER_STEM: [number, number, number] = [0.36, 0.5, 0.26];

function flowerGeom(rng: Rng): BuiltProp {
  // One seed drives BOTH LOD variants so the far clump reads as the same plant, just sparser.
  const seed = (rng.next() * 0x7fffffff) | 0;
  const mk = (lodLevel: number): { petal: MeshGeometry; eye: MeshGeometry; stem: MeshGeometry; height: number; petals: number } => {
    const petal = new Accum3D(), eye = new Accum3D(), stem = new Accum3D();
    const rnd = tuftRng(seed);
    const stalks = lodLevel === 0 ? 3 : 1;                     // a scatter point is a little CLUMP, not one flower
    let height = 0, petals = 0;
    for (let i = 0; i < stalks; i++) {
      const a = i * 2.39996 + rnd() * 0.7;
      const rr = i === 0 ? 0 : 0.025 + rnd() * 0.035;
      const lean = 0.12 + rnd() * 0.22;
      const r = emitStalk(
        { stem, leaf: stem, petal, centre: eye },
        { ...SCATTER_DAISY, lodLevel },
        { base: [Math.cos(a) * rr, 0, Math.sin(a) * rr], axis: [Math.cos(a) * lean, 1, Math.sin(a) * lean], scale: 0.8 + rnd() * 0.4 },
        rnd,
      );
      height = Math.max(height, r.height); petals += r.petals;
    }
    return { petal: petal.geometry(), eye: eye.geometry(), stem: stem.geometry(), height, petals };
  };
  const near = mk(0), far = mk(1);
  return {
    geometry: near.petal, lod: far.petal, height: near.height, blades: near.petals,
    extra: [
      { suffix: ':eye', geometry: near.eye, lod: far.eye, color: SCATTER_EYE, windAmount: 1, foliageShade: { translucency: 0.3, translucencyColor: [1, 0.95, 0.62], groundBlend: 0.2, groundTint: SCATTER_GROUND_TINT, baseAO: 0.3 } },
      { suffix: ':stem', geometry: near.stem, lod: far.stem, color: SCATTER_STEM, windAmount: 0.95, foliageShade: { translucency: 0.6, translucencyColor: [0.6, 0.9, 0.34], groundBlend: 0.45, groundTint: SCATTER_GROUND_TINT, baseAO: 0.45 } },
    ],
  };
}
function pebbleGeom(): BuiltProp {
  const a = new Accum3D();
  a.blob([0, 0.02, 0], 0.05, 0.03, 0.045, 0.4, 3);
  return { geometry: a.geometry() };
}
function twigGeom(): BuiltProp {
  const a = new Accum3D();
  a.beam([0, 0.01, 0], [0.14, 0.05, 0.05], 0.007, 3);        // a fallen stick
  a.beam([0.05, 0.03, 0.02], [0.02, 0.07, -0.03], 0.004, 3); // a little fork
  return { geometry: a.geometry() };
}

/** The scatter meadow clump (foliage-quality.md §4 "grass field" = the tuft as a scatter element).
 *  Deliberately leaner than the authored `tall-grass` plant — this one is drawn hundreds of times. */
const SCATTER_GRASS_TUFT: BladeTuftSpec = {
  blades: 11, radius: 0.06, length: 0.55, lengthVar: 0.3, width: 0.016, taper: 0.9,
  curve: 0.5, curveVar: 0.4, segments: 4, twist: 1.1, twistVar: 0.5, foldAngle: 0.45,
  lean: 0.55, leanVar: 0.35, tipStart: 1,   // one colour per scatter layer → no leaf/tip split
};
/** Total blades a single scatter FIELD may emit before instances are truncated (and it is LOGGED, §7). */
export const MAX_FIELD_BLADES = 240000;

function tallGrassGeom(rng: Rng): BuiltProp {
  // One seed drives BOTH variants so the far clump reads as the same plant, just sparser.
  const seed = (rng.next() * 0x7fffffff) | 0;
  const mk = (lodLevel: number): { geom: MeshGeometry; r: { blades: number; height: number } } => {
    const a = new Accum3D();
    const r = bladeTuft(a, null, { ...SCATTER_GRASS_TUFT, lodLevel }, tuftRng(seed));
    return { geom: a.geometry(), r };
  };
  const near = mk(0), far = mk(1);
  return { geometry: near.geom, lod: far.geom, height: near.r.height, blades: near.r.blades };
}
/** A tiny self-contained mulberry32 so a tuft's shape depends only on its own seed (not on how many
 *  scatter points were drawn before it) — the near/far variants must agree. */
function tuftRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function bushGeom(): BuiltProp {
  const a = new Accum3D();
  a.blob([0, 0.18, 0], 0.32, 0.22, 0.32, 0.35, 11);
  a.blob([0.18, 0.12, -0.1], 0.2, 0.16, 0.2, 0.35, 23);
  a.blob([-0.14, 0.13, 0.12], 0.18, 0.15, 0.18, 0.35, 41);
  return { geometry: a.geometry() };
}
function rockGeom(): BuiltProp {
  const a = new Accum3D();
  a.blob([0, 0.06, 0], 0.15, 0.1, 0.13, 0.35, 5);
  return { geometry: a.geometry() };
}

// Per-type placement config: minDist (full-density spacing, world units), base accept probability, how
// hard WEAR suppresses it, MOIST boost, whether it CLUSTERS (flowers/grass patch), geometry + colour + band.
interface TypeCfg {
  key: keyof typeof PARK_RULES;
  name: string;
  minDist: number;
  baseProb: number;
  wearSuppress: number; // 1 = fully gone on a fully-worn track
  moistBoost: number;
  cluster: boolean;
  band: number;
  color: [number, number, number];
  leafCard?: boolean;
  /** Shared foliage look (foliage-quality S1/S2) — vegetation only; mineral/dead props leave both undefined. */
  wind?: ScatterLayer['wind'];
  foliageShade?: ScatterLayer['foliageShade'];
  build: (rng: Rng) => BuiltProp;
}

const TYPES: TypeCfg[] = [
  {
    // REAL stalks + whorls (P2) — no leafCard: the alpha-cut silhouette would eat actual petal geometry.
    // The layer's colour is the PETAL colour; the eye + stem ride along as `extra` sub-layers.
    key: 'flowers', name: 'scatter:flowers', minDist: 0.28, baseProb: 0.55, wearSuppress: 1.0, moistBoost: 0.3, cluster: true, band: 0, color: SCATTER_PETAL, build: flowerGeom,
    // A thin stem + head: floppy (low exponent), full amount — flowers are the most visibly wind-sensitive prop.
    // `height` is overwritten below with the clump's MEASURED height (the wind grading denominator).
    wind: { height: 0.3, stiffness: 1.3, amount: 0.9 },
    // Petals are the thinnest geometry in the scene → the strongest backlit glow in the whole scatter.
    foliageShade: { translucency: 0.9, translucencyColor: [1.0, 0.99, 0.94], groundBlend: 0.3, groundTint: SCATTER_GROUND_TINT, baseAO: 0.35 },
  },
  { key: 'twigs', name: 'scatter:twigs', minDist: 0.6, baseProb: 0.35, wearSuppress: 0.7, moistBoost: 0.0, cluster: false, band: 1, color: [0.42, 0.32, 0.2], build: twigGeom },
  { key: 'pebbles', name: 'scatter:pebbles', minDist: 0.5, baseProb: 0.3, wearSuppress: 0.2, moistBoost: 0.0, cluster: false, band: 2, color: [0.56, 0.55, 0.52], build: pebbleGeom },
  {
    // REAL blade clumps (P1) — no leafCard: the alpha-cut silhouette would eat actual blade geometry.
    key: 'tallGrass', name: 'scatter:tallGrass', minDist: 0.42, baseProb: 0.75, wearSuppress: 1.0, moistBoost: 0.6, cluster: true, band: 3, color: [0.34, 0.5, 0.24], build: tallGrassGeom,
    // Blades: the floppiest thing in the scene + the strongest backlit glow (the NTE meadow read).
    // `height` is overwritten below with the clump's MEASURED height (the wind grading denominator).
    wind: { height: 0.85, stiffness: 1.15, amount: 1.0 },
    foliageShade: { translucency: 0.75, translucencyColor: [0.66, 0.92, 0.36], groundBlend: 0.4, groundTint: SCATTER_GROUND_TINT, baseAO: 0.4 },
  },
  {
    key: 'bushes', name: 'scatter:bushes', minDist: 4.0, baseProb: 0.8, wearSuppress: 0.9, moistBoost: 0.6, cluster: false, band: 4, color: [0.3, 0.45, 0.26], build: bushGeom,
    wind: { height: 0.42, stiffness: 2.4, amount: 0.5 },
    foliageShade: { translucency: 0.45, translucencyColor: [0.58, 0.84, 0.34], groundBlend: 0.35, groundTint: SCATTER_GROUND_TINT, baseAO: 0.4 },
  },
  { key: 'rocks', name: 'scatter:rocks', minDist: 2.6, baseProb: 0.7, wearSuppress: 0.3, moistBoost: 0.0, cluster: false, band: 5, color: [0.55, 0.55, 0.58], build: rockGeom },
];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Build the mask-driven scatter layers over a footprint. For each type: blue-noise the footprint at the
 * type's full-density spacing, then ACCEPT each candidate with a probability modulated by the shared masks
 * (wear thins, dirt suppresses, moist boosts grass/bush). Returns one ScatterLayer per non-empty type.
 */
export function buildScatterLayers(target: ScatterFootprint | ScatterSurface, rules: ScatterRules, rng: Rng): { layers: ScatterLayer[]; total: number } {
  const layers: ScatterLayer[] = [];
  let total = 0;
  const surf = isSurface(target) ? target : footprintSurface(target);
  const path = rules.wearPath ?? null;
  const align = rules.alignToSurface !== false;   // ★ default TRUE: props grow perpendicular to the surface
  const unit = surf.unit;                          // world metres → surface units
  for (const t of TYPES) {
    const mult = rules[t.key] ?? PARK_RULES[t.key];
    if (mult <= 0) continue;
    const pts = poissonOnSurface(surf, t.minDist / unit, rng);
    const transforms: ScatterLayer['transforms'][number][] = [];
    for (const s of pts) {
      const u = clamp01(s.u), v = clamp01(s.v);
      if (rules.reject && rules.reject(s.x, s.z)) continue;
      // Shared weathering masks (same formulas as the material shader) → density.
      const wear = wearMask(u, v, path);
      const em = edgeMask(u, v);
      const moist = moistMask(u, v, em.edge, 1);
      const dirt = dirtMask(u, v, em.edge, em.corner);
      let prob = t.baseProb * mult;
      prob *= 1 - t.wearSuppress * wear;          // FEWER on the worn path (the shared-mask payoff)
      prob *= 1 - 0.6 * dirt;                      // dirt patches suppress vegetation
      prob *= 1 + t.moistBoost * moist;            // more grass/bush in moist/shade
      if (t.cluster) {
        const clust = fbm2(u * 5.0 + 2.0, v * 5.0 + 6.0);   // low-freq patchiness → clumped, not uniform
        prob *= smooth(0.42, 0.72, clust);
      }
      if (rng.next() >= clamp01(prob)) continue;
      // ORIENTATION: the instance's up-axis is the interpolated surface NORMAL (`alignToSurface`, default) or
      // the parent's +Y. The random yaw + lean jitter rides on top of whichever basis, exactly as before.
      const ry = rng.next() * 360;
      const base = align ? alignEuler(s.nx, s.ny, s.nz, ry) : { rx: 0, rz: 0 };
      transforms.push({
        x: s.x, y: s.y, z: s.z,
        ry,
        rx: base.rx + (rng.next() - 0.5) * 16,     // lean
        rz: base.rz + (rng.next() - 0.5) * 16,
        scale: (0.75 + rng.next() * 0.6) / unit,   // height/size variation, in surface units
      });
    }
    if (!transforms.length) continue;
    const built = t.build(rng);
    // FIELD blade cap (§7): a dense meadow over a big footprint can run into the millions of blades.
    // Truncate instances rather than lose density silently — and say so.
    if (built.blades && built.blades * transforms.length > MAX_FIELD_BLADES) {
      const maxInst = Math.max(1, Math.floor(MAX_FIELD_BLADES / built.blades));
      console.warn(`[ground-scatter] ${t.name}: blade budget hit — ${transforms.length} clumps × ${built.blades} blades > ${MAX_FIELD_BLADES}; truncated to ${maxInst} clumps`);
      transforms.length = maxInst;
    }
    // The wind grading denominator must be the prop's REAL local height, not a guess.
    const wind = t.wind ? { ...t.wind, height: built.height ?? t.wind.height } : undefined;
    layers.push({ name: t.name, geometry: built.geometry, lodGeometry: built.lod, color: t.color, leafCard: t.leafCard, band: t.band, transforms, wind, foliageShade: t.foliageShade });
    // Multi-COLOUR props (a flower's petals / eye / stem) ship as sibling layers over the SAME transform
    // list — the placement is computed once, and each part is still exactly one instanced draw.
    for (const x of built.extra ?? []) {
      layers.push({
        name: t.name + x.suffix, geometry: x.geometry, lodGeometry: x.lod, color: x.color,
        leafCard: t.leafCard, band: t.band, transforms,
        wind: wind ? { ...wind, amount: wind.amount * (x.windAmount ?? 1) } : undefined,
        foliageShade: x.foliageShade ?? t.foliageShade,
      });
    }
    total += transforms.length;
  }
  return { layers, total };
}

function smooth(a: number, b: number, x: number): number {
  const tt = Math.min(1, Math.max(0, (x - a) / ((b - a) || 1e-12)));
  return tt * tt * (3 - 2 * tt);
}
