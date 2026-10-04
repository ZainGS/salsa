/**
 * mesh-picker-raycast.test.ts — P6 (docs/specs/performance-plan.md): the raycastWorld fast path (world-box prefilter,
 * nearest-box-first order with an early stop, the capped BVH walk, the per-list box cache) must return EXACTLY what
 * the plain walk over every candidate returns — same mesh, distance, normal — for any ray and any maxDist.
 * Also covers MeshBVH.overlapsBox / MeshPicker.meshMayTouchWorldBox (never a false negative).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { vec3 } from 'gl-matrix';
import { MeshPicker } from './mesh-picker';
import { MeshBVH } from './mesh-bvh';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { InteractionService } from '../../services/interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** Deterministic PRNG. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A random triangle soup (12-float layout) of `n` triangles inside [-1,1]^3. */
function soup(r: () => number, n: number): { vertices: Float32Array; indices: Uint32Array; format: '12float' } {
  const v = new Float32Array(n * 3 * 12), ix = new Uint32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const cx = r() * 2 - 1, cy = r() * 2 - 1, cz = r() * 2 - 1;
    for (let k = 0; k < 3; k++) {
      const o = (t * 3 + k) * 12;
      v[o] = cx + (r() - 0.5) * 0.6; v[o + 1] = cy + (r() - 0.5) * 0.6; v[o + 2] = cz + (r() - 0.5) * 0.6;
      ix[t * 3 + k] = t * 3 + k;
    }
  }
  return { vertices: v, indices: ix, format: '12float' };
}

function scene(seed: number, count: number): Mesh3D[] {
  const r = rng(seed), out: Mesh3D[] = [];
  for (let i = 0; i < count; i++) {
    const m = new Mesh3D(isvc, (r() - 0.5) * 8, (r() - 0.5) * 2, (r() - 0.5) * 8, { primitive: 'custom', geometry: soup(r, 4 + Math.floor(r() * 40)) });
    if (i % 3 === 1) m.setRotation3D(r() * 3, r() * 3, r() * 3);   // rotated / scaled meshes take the general inverse
    if (i % 4 === 2) m.setScale3D(0.5 + r(), 0.5 + r(), 0.5 + r());
    m.pickable = false;
    out.push(m);
  }
  // A coplanar duplicate pair (equal hit distances): the tie must go to the earlier list entry, as before.
  const twin = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: new Float32Array([-5, 0, -5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, -5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0]), indices: new Uint32Array([0, 1, 2]), format: '12float' } });
  const twin2 = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: new Float32Array([-5, 0, -5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, -5, 0, 0, 0, 0, 0, 0, 0, 0, 0]), indices: new Uint32Array([0, 1, 2]), format: '12float' } });
  out.splice(7, 0, twin); out.splice(20, 0, twin2);
  for (const m of out) m.gpuDirty = false;   // uploaded → the BVH path
  return out;
}

const plain = (pk: MeshPicker, o: vec3, d: vec3, ms: Mesh3D[], maxDist: number) => {
  MeshPicker.worldBoxPrefilter = false;
  try { const h = pk.raycastWorld(o, d, ms, true); return h && h.distance <= maxDist ? h : null; }
  finally { MeshPicker.worldBoxPrefilter = true; }
};

describe('MeshPicker.raycastWorld fast path (P6)', () => {
  afterEach(() => { MeshPicker.worldBoxPrefilter = true; });

  it('matches the plain walk for random rays and caps (incl. a re-sent list → per-list box cache)', () => {
    const ms = scene(7, 60);
    const fast = new MeshPicker(), ref = new MeshPicker();
    const r = rng(99);
    let hits = 0;
    for (let k = 0; k < 600; k++) {
      const o = vec3.fromValues((r() - 0.5) * 10, (r() - 0.5) * 3, (r() - 0.5) * 10);
      const d = vec3.fromValues(r() - 0.5, (r() - 0.5) * (k % 5 === 0 ? 0 : 1), r() - 0.5);
      if (k % 7 === 0) vec3.set(d, 0, -1, 0);
      vec3.normalize(d, d);
      const cap = k % 3 === 0 ? Infinity : r() * 6;
      const a = fast.raycastWorld(o, d, ms, true, cap);
      const aa = a && a.distance <= cap ? a : null;
      const b = plain(ref, o, d, ms, cap);
      expect(!!aa).toBe(!!b);
      if (aa && b) {
        hits++;
        expect(aa.mesh).toBe(b.mesh);
        expect(aa.distance).toBe(b.distance);
        expect(aa.faceNormal).toEqual(b.faceNormal);
        expect(aa.triangleIndex).toBe(b.triangleIndex);
      }
    }
    expect(hits).toBeGreaterThan(50);
  });

  it('follows a mesh that moves (box cache keyed by the matrix version)', () => {
    const ms = scene(3, 30);
    const pk = new MeshPicker();
    const o = vec3.fromValues(0, 5, 0), d = vec3.fromValues(0, -1, 0);
    pk.raycastWorld(o, d, ms, true); pk.raycastWorld(o, d, ms, true);   // warm the per-list cache
    for (const m of ms) m.setPosition3D(m.x + 20, m.y, m.z);           // everything leaves the column
    expect(pk.raycastWorld(o, d, ms, true)).toBeNull();
    expect(plain(new MeshPicker(), o, d, ms, Infinity)).toBeNull();
  });
});

describe('MeshBVH.overlapsBox / meshMayTouchWorldBox (P6)', () => {
  it('never misses a triangle that a segment inside the box hits', () => {
    const ms = scene(11, 40);
    const pk = new MeshPicker();
    const r = rng(5);
    for (let k = 0; k < 300; k++) {
      const o = vec3.fromValues((r() - 0.5) * 8, (r() - 0.5) * 2, (r() - 0.5) * 8);
      const d = vec3.fromValues(r() - 0.5, r() - 0.5, r() - 0.5); vec3.normalize(d, d);
      const len = r() * 1.5;
      const e = [o[0] + d[0] * len, o[1] + d[1] * len, o[2] + d[2] * len];
      const box = [Math.min(o[0], e[0]), Math.min(o[1], e[1]), Math.min(o[2], e[2]), Math.max(o[0], e[0]), Math.max(o[1], e[1]), Math.max(o[2], e[2])] as const;
      const full = plain(pk, o, d, ms, len);
      // Warm the BVHs (a ray that reaches a mesh builds it), then filter by the box.
      const kept = ms.filter((m) => pk.meshMayTouchWorldBox(m, ...box));
      const viaKept = plain(pk, o, d, kept, len);
      expect(viaKept?.mesh ?? null).toBe(full?.mesh ?? null);
      if (full) expect(viaKept!.distance).toBe(full.distance);
    }
  });

  it('overlapsBox: true for a box around a triangle, false far away', () => {
    const g = soup(rng(1), 1);
    const bvh = MeshBVH.build(g.vertices, g.indices);
    const v = g.vertices;
    expect(bvh.overlapsBox(v[0] - 0.01, v[1] - 0.01, v[2] - 0.01, v[0] + 0.01, v[1] + 0.01, v[2] + 0.01)).toBe(true);
    expect(bvh.overlapsBox(50, 50, 50, 51, 51, 51)).toBe(false);
  });

  it('capped BVH intersect = uncapped result when the hit is within the cap', () => {
    const g = soup(rng(2), 200);
    const bvh = MeshBVH.build(g.vertices, g.indices);
    const r = rng(8);
    for (let k = 0; k < 400; k++) {
      const o = [(r() - 0.5) * 3, (r() - 0.5) * 3, (r() - 0.5) * 3];
      const d = [r() - 0.5, r() - 0.5, r() - 0.5]; const l = Math.hypot(d[0], d[1], d[2]); d[0] /= l; d[1] /= l; d[2] /= l;
      const full = bvh.intersect(o[0], o[1], o[2], d[0], d[1], d[2]);
      const cap = r() * 3;
      const c = bvh.intersect(o[0], o[1], o[2], d[0], d[1], d[2], cap);
      if (full && full.t <= cap) { expect(c).not.toBeNull(); expect(c!.t).toBe(full.t); expect(c!.triIndex).toBe(full.triIndex); }
      else expect(c).toBeNull();
    }
  });
});
