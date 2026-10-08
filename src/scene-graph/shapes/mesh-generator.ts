/**
 * Mesh generator settings — the parameters a parametric mesh was generated from (Add Mesh › Cylinder… / Circle… /
 * Polygon… / Revolve… / Tube… / Metaballs… / Creature…), kept ON the mesh (Mesh3D.generator, persisted) so a live
 * settings panel can regenerate it in place and show the same values again after a reload.
 *
 * The settings stop applying once the mesh's own geometry changes outside the generator — Edit Mesh (any topology or
 * vertex change), a UV unwrap, vertex colours, blend shapes, a bind to a skeleton: regenerating would wipe that work.
 * Mesh3D tracks it with a source-geometry version stamped at each generation (Mesh3D.generatorApplies); merely
 * entering Edit Mesh (which recompiles the same geometry) re-stamps and does not count.
 */

export type MeshGeneratorType = 'cylinder' | 'circle' | 'polygon' | 'revolve' | 'tube' | 'metaball' | 'creature';

export const MESH_GENERATOR_TYPES: readonly MeshGeneratorType[] =
  ['cylinder', 'circle', 'polygon', 'revolve', 'tube', 'metaball', 'creature'];

export interface MeshGeneratorRecord {
  type: MeshGeneratorType;
  /** The generator's parameters (plain JSON — see the per-type shapes in normalizeGeneratorParams). */
  params: Record<string, unknown>;
  /** Set (and persisted) once the mesh was changed outside the generator; the settings never apply again. */
  edited?: boolean;
  /** Extra meshes the generator made and owns (a creature's eye spheres) — replaced on regenerate. */
  parts?: string[];
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const int = (v: unknown, d: number, lo: number, hi: number): number => Math.round(num(v, d, lo, hi));
const pts2 = (v: unknown): [number, number][] =>
  Array.isArray(v) ? v.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [num(p[0], 0), num(p[1], 0)] as [number, number]) : [];
const pts3 = (v: unknown): [number, number, number][] =>
  Array.isArray(v) ? v.filter((p) => Array.isArray(p) && p.length >= 3).map((p) => [num(p[0], 0), num(p[1], 0), num(p[2], 0)] as [number, number, number]) : [];

const BLOB_SHAPES = new Set(['sphere', 'capsule', 'ellipsoid', 'box', 'torus']);

/** Clamp / default one generator's params into the shape its builder takes (UI input and old saves are untrusted).
 *  Returns null when the params can't build anything (a polygon with < 3 points, a profile with < 2 …). */
export function normalizeGeneratorParams(type: MeshGeneratorType, p: Record<string, unknown>): Record<string, unknown> | null {
  switch (type) {
    case 'cylinder':
      return {
        radius: num(p.radius, 0.3, 0.001), radiusTop: num(p.radiusTop ?? p.radius, 0.3, 0),
        height: num(p.height, 0.8, 0.001), segments: int(p.segments, 12, 3, 128),
      };
    case 'circle':
      return { radius: num(p.radius, 0.5, 0.001), segments: int(p.segments, 16, 3, 128), height: num(p.height, 0.2, 0) };
    case 'polygon': {
      const points = pts2(p.points);
      return points.length >= 3 ? { points, height: num(p.height, 0.2, 0) } : null;
    }
    case 'revolve': {
      const profile = pts2(p.profile).map(([r, y]) => [Math.max(0, r), y] as [number, number]);
      return profile.length >= 2 ? { profile, segments: int(p.segments, 16, 3, 128) } : null;
    }
    case 'tube': {
      const path = pts3(p.path);
      if (path.length < 2) return null;
      const radii = Array.isArray(p.radii) ? p.radii.map((r) => num(r, 0.1, 0.001)) : [0.1];
      return { path, radii: radii.length ? radii : [0.1], segments: int(p.segments, 8, 3, 64) };
    }
    case 'metaball': {
      const blobs = Array.isArray(p.blobs) ? p.blobs.filter((b) => b && typeof b === 'object').map((b: any) => ({
        shape: BLOB_SHAPES.has(b.shape) ? b.shape : 'sphere',
        a: pts3([b.a])[0] ?? [0, 0, 0],
        ...(Array.isArray(b.b) ? { b: pts3([b.b])[0] ?? [0, 0.3, 0] } : {}),
        radius: num(b.radius, 0.25, 0.001),
        blend: num(b.blend, 0.3, 0),
        ...(b.subtract ? { subtract: true } : {}),
      })) : [];
      if (!blobs.length) return null;
      const decimate = num(p.decimate, 1, 0.05, 1);
      return { blobs, resolution: int(p.resolution, 32, 8, 96), decimate };
    }
    case 'creature': {
      const out: Record<string, unknown> = { ...p };
      out.resolution = int(p.resolution, 32, 8, 96);
      out.decimate = num(p.decimate, 0.4, 0.05, 1);
      out.seed = int(p.seed, 42, 0, 1e9);
      out.eyes = p.eyes !== false;
      delete out.rigged;   // a rig binds the mesh to a skeleton: the settings no longer apply after that
      return out;
    }
  }
  return null;
}

/** A saved / untrusted record → a clean MeshGeneratorRecord, or null. */
export function readGeneratorRecord(raw: unknown): MeshGeneratorRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { type?: unknown; params?: unknown; edited?: unknown; parts?: unknown };
  if (typeof r.type !== 'string' || !(MESH_GENERATOR_TYPES as readonly string[]).includes(r.type)) return null;
  const type = r.type as MeshGeneratorType;
  const params = normalizeGeneratorParams(type, (r.params && typeof r.params === 'object' ? r.params : {}) as Record<string, unknown>);
  if (!params) return null;
  const parts = Array.isArray(r.parts) ? r.parts.filter((s): s is string => typeof s === 'string') : [];
  return { type, params, ...(r.edited === true ? { edited: true } : {}), ...(parts.length ? { parts } : {}) };
}

/** Deep copy (params are plain JSON). */
export function cloneGeneratorRecord(g: MeshGeneratorRecord): MeshGeneratorRecord {
  return JSON.parse(JSON.stringify(g)) as MeshGeneratorRecord;
}
