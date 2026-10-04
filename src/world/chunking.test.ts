/**
 * src/world/chunking.test.ts — spatial chunking of the city's merged layers (polish-round-3 Round 5 — culling).
 *
 * Chunking must be INVISIBLE: a pure partition of each big layer's triangles (or instances) into cells, with the
 * layer's name + material fields untouched, deterministic output, and the procedural-ground uv scale preserved.
 */

import { describe, it, expect } from 'vitest';
import { chunkCityLayers, chunkGridFor, chunkMinCell, groundUvSampleGeometry, splitGeometryXZ } from './chunking';
import { buildCentreGroups } from './centre-build';
import { SIGNAL_LAMP_RE } from './signals';
import { groundUvWorldScale } from '../renderer/3d/ground-uv-scale';
import { FLOATS_PER_VERT, type MeshGeometry } from '../renderer/3d/mesh-generators';
import type { InstanceXform, LayoutParams, LayoutPreviewLayer } from './types';

const S = FLOATS_PER_VERT;

/** A draped (bumpy) grid of quads over [-10,10]² — uv = xz · 0.5, like the city ground. */
function gridGeometry(n: number, bump = 0.3): MeshGeometry {
  const v: number[] = [], ix: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -10 + 20 * i / n, z = -10 + 20 * j / n, y = bump * Math.sin(x * 0.7) * Math.cos(z * 0.4);
    v.push(x, y, z, 0, 1, 0, x * 0.5, z * 0.5, 1, 0, 0, 1);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    ix.push(a, c, b, b, c, d);
  }
  return { vertices: new Float32Array(v), indices: new Uint32Array(ix), format: '12float' };
}

/** Every triangle as a canonical string of its three full vertices (order kept). */
function triKeys(g: MeshGeometry): string[] {
  const out: string[] = [];
  for (let t = 0; t < g.indices.length / 3; t++) {
    const parts: string[] = [];
    for (let c = 0; c < 3; c++) parts.push(Array.from(g.vertices.subarray(g.indices[t * 3 + c] * S, g.indices[t * 3 + c] * S + S)).join(','));
    out.push(parts.join('|'));
  }
  return out;
}

const tris = (L: LayoutPreviewLayer): number => (L.geometry.indices.length / 3) * (L.instances?.length ?? 1);
const OPTS = { minCell: chunkMinCell(10) };   // radius 10 → 1.5-unit cells minimum

describe('splitGeometryXZ — a pure triangle partition', () => {
  const g = gridGeometry(40);   // 3200 tris
  const cells = splitGeometryXZ(g, 4, 4, -10, -10, 5, 5);

  it('loses / duplicates no triangle and keeps each cell in the original order', () => {
    const all = triKeys(g);
    const got = cells.flatMap((c) => triKeys(c.geometry));
    expect(got.length).toBe(all.length);
    expect([...got].sort()).toEqual([...all].sort());
    // Within a cell, triangles keep their original relative order.
    const pos = new Map(all.map((k, i) => [k, i]));
    for (const c of cells) {
      const idx = triKeys(c.geometry).map((k) => pos.get(k)!);
      for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }
  });

  it('puts every triangle in the cell holding its centroid, with compact vertices + correct bounds', () => {
    expect(cells.length).toBe(16);
    for (const c of cells) {
      const v = c.geometry.vertices, ix = c.geometry.indices;
      const nv = v.length / S;
      expect(Math.max(...ix)).toBe(nv - 1);   // compacted: every emitted vertex is used
      for (let t = 0; t < ix.length / 3; t++) {
        const cx = (v[ix[t * 3] * S] + v[ix[t * 3 + 1] * S] + v[ix[t * 3 + 2] * S]) / 3;
        const cz = (v[ix[t * 3] * S + 2] + v[ix[t * 3 + 1] * S + 2] + v[ix[t * 3 + 2] * S + 2]) / 3;
        expect(Math.min(3, Math.floor((cx + 10) / 5))).toBe(c.ix);
        expect(Math.min(3, Math.floor((cz + 10) / 5))).toBe(c.iz);
      }
      const b = (c.geometry as { bounds?: Float32Array }).bounds!;
      let x0 = Infinity, x1 = -Infinity;
      for (let i = 0; i < v.length; i += S) { x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]); }
      expect(b[0]).toBe(x0); expect(b[3]).toBe(x1);
    }
  });
});

describe('chunkGridFor — only big, wide layers split', () => {
  it('small or narrow layers stay one cell; big wide layers split up to the cap', () => {
    expect(chunkGridFor(5000, 20, 20, OPTS)).toEqual([1, 1]);          // < 4 × target → no split
    expect(chunkGridFor(24000, 20, 20, OPTS)).toEqual([4, 4]);         // sqrt(24000 / 1500) = 4
    expect(chunkGridFor(24000, 20, 1, OPTS)).toEqual([4, 1]);          // a thin strip only splits along its length
    expect(chunkGridFor(1e7, 20, 20, OPTS)).toEqual([10, 10]);         // MAX_CELLS cap
    expect(chunkGridFor(1e7, 2.5, 2.5, OPTS)).toEqual([1, 1]);         // compact (< 2 × minCell) never shreds
  });
});

describe('chunkCityLayers — invisible partition', () => {
  const big: LayoutPreviewLayer = { name: 'world:roads', color: [0.2, 0.2, 0.2], y: 0, geometry: gridGeometry(90),
    ground: { surface: 'asphalt' as never, metersPerUnit: 15 }, emissive: 0.1 };

  it('keeps name + every material field, loses no triangle', () => {
    const out = chunkCityLayers([big], OPTS);
    expect(out.length).toBeGreaterThan(1);
    expect(out.reduce((n, L) => n + tris(L), 0)).toBe(tris(big));
    for (const L of out) {
      expect(L.name).toBe(big.name);
      expect(L.color).toBe(big.color); expect(L.ground).toBe(big.ground); expect(L.emissive).toBe(big.emissive);
      expect(L.chunk).toMatch(/^\d+_\d+\/\d+x\d+$/);
    }
  });

  it('is deterministic', () => {
    const a = chunkCityLayers([big], OPTS), b = chunkCityLayers([big], OPTS);
    expect(a.map((L) => L.chunk)).toEqual(b.map((L) => L.chunk));
    a.forEach((L, i) => { expect(L.geometry.vertices).toEqual(b[i].geometry.vertices); expect(L.geometry.indices).toEqual(b[i].geometry.indices); });
  });

  it('every ground chunk reproduces the UNSPLIT uv scale exactly (no paver seam at a cell border)', () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const want = groundUvWorldScale(big.geometry, I);
    expect(groundUvWorldScale(groundUvSampleGeometry(big.geometry), I)).toEqual(want);
    const out = chunkCityLayers([big], OPTS);
    const own = out.map((L) => groundUvWorldScale(L.geometry, I)![0]);
    expect(new Set(own).size).toBeGreaterThan(1);   // the bumpy chunks WOULD disagree on their own …
    for (const L of out) expect(groundUvWorldScale(L.groundUvSample!, I)).toEqual(want);   // … the carried sample doesn't
  });

  it('leaves small, transparent, outline-ranged and per-instance-mesh layers as the SAME object', () => {
    const small = { ...big, geometry: gridGeometry(10) };
    const glass = { ...big, opacity: 0.5 };
    const lm = { ...big, outlineRanges: [{ id: 1, start: 0, count: 3 }] };
    const perInst = { ...big, instances: [{ x: 0, y: 0, z: 0, ry: 0 }, { x: 9, y: 0, z: 9, ry: 0 }] };
    for (const L of [small, glass, lm, perInst]) expect(chunkCityLayers([L], OPTS)[0]).toBe(L);
  });

  it('partitions an instanced ARRAY layer by position (order kept, one shared geometry key)', () => {
    const geo = gridGeometry(6);   // 72 tris per copy
    const inst: InstanceXform[] = Array.from({ length: 900 }, (_, i) => ({ x: -10 + (i % 30) * 0.69, y: 0, z: -10 + Math.floor(i / 30) * 0.69, ry: i * 0.1, s: 1 + (i % 3) * 0.1 }));
    const L: LayoutPreviewLayer = { name: 'world:tree-zelkova-0', color: [0, 1, 0], y: 0, geometry: geo, instances: inst, arrayGroup: true, castShadow: true };
    const out = chunkCityLayers([L], OPTS);
    expect(out.length).toBeGreaterThan(1);
    const flat = out.flatMap((c) => c.instances!);
    expect(flat.length).toBe(inst.length);
    expect(new Set(flat)).toEqual(new Set(inst));
    for (const c of out) {
      expect(c.name).toBe(L.name); expect(c.geometry).toBe(geo); expect(c.castShadow).toBe(true);
      expect(c.instanceKey).toBe(out[0].instanceKey);
      const order = c.instances!.map((t) => inst.indexOf(t));
      for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
  });

  it('P7: splits a few HEAVY instances (trees, vending cans) into per-cell groups; light ones still need 4 per cell', () => {
    const inst: InstanceXform[] = Array.from({ length: 13 }, (_, i) => ({ x: -9 + (i % 5) * 4.5, y: 0, z: -9 + Math.floor(i / 5) * 9, ry: 0 }));
    const heavy: LayoutPreviewLayer = { name: 'world:tree-zelkova-0:foliage:leaf', color: [0, 1, 0], y: 0, geometry: gridGeometry(30), instances: inst, arrayGroup: true };   // 1800 tris per copy
    const out = chunkCityLayers([heavy], OPTS);
    expect(out.length).toBeGreaterThan(4);   // was 1 (13 / 4 → a 1 × 1 grid): a city-wide box nothing could cull
    expect(out.flatMap((c) => c.instances!).length).toBe(13);
    const light: LayoutPreviewLayer = { ...heavy, geometry: gridGeometry(6) };   // 72 tris per copy — unchanged rule
    expect(chunkCityLayers([light], OPTS)).toEqual([light]);
  });

  it('P8: instanced near/far twins (far tree crowns) split their identical transforms on ONE grid', () => {
    const mk = (): InstanceXform[] => Array.from({ length: 40 }, (_, i) => ({ x: -9 + (i % 8) * 2.5, y: 0, z: -9 + Math.floor(i / 8) * 4.5, ry: i }));
    const nearG = gridGeometry(30), farG = gridGeometry(10);   // 1800 vs 200 tris per copy: alone they would grid differently
    const tw = { key: 'tree:zelkova:0', dist: 10, gridTris: 1800 };
    const near: LayoutPreviewLayer = { name: 'world:tree-zelkova-0:foliage:leaf#0', color: [0, 1, 0], y: 0, geometry: nearG, instances: mk(), arrayGroup: true, nearTwin: { ...tw, role: 'near' } };
    const far: LayoutPreviewLayer = { ...near, geometry: farG, instances: mk(), nearTwin: { ...tw, role: 'far' } };
    for (const order of [[near, far], [far, near]]) {
      const out = chunkCityLayers(order, OPTS);
      const cells = (role: string): string[] => out.filter((c) => c.nearTwin!.role === role).map((c) => `${c.chunk}:${c.instances!.map((t) => t.ry).join(',')}`).sort();
      expect(cells('near').length).toBeGreaterThan(1);
      expect(cells('far')).toEqual(cells('near'));
    }
  });
});

describe('P9 prop near / far twins', () => {
  it('every twin layer of one cell gets the SAME box (union), so their swap decisions agree exactly', () => {
    const nearG = gridGeometry(40), farG = gridGeometry(12, 0.05);   // different bumps → different per-cell boxes
    const tw = { key: 'util-pole', dist: 3, gridTris: 20000, uvFromNear: true };
    const layers: LayoutPreviewLayer[] = [
      { name: 'world:util-pole', color: [1, 1, 1], y: 0, geometry: nearG, nearTwin: { ...tw, role: 'near' } },
      { name: 'world:util-pole', color: [1, 1, 1], y: 0, geometry: farG, nearTwin: { ...tw, role: 'far' } },
    ];
    const out = chunkCityLayers(layers, OPTS);
    const byCell = new Map<string, Float32Array[]>();
    for (const c of out) { const b = (c.geometry as { bounds?: Float32Array }).bounds!; (byCell.get(c.chunk!) ?? byCell.set(c.chunk!, []).get(c.chunk!)!).push(b); }
    expect(byCell.size).toBeGreaterThan(1);
    // gridTris: the pair chunks on the grid the plain near layer would have had
    const [gx, gz] = chunkGridFor(20000, 20, 20, OPTS);
    expect(byCell.size).toBe(gx * gz);
    for (const [, bs] of byCell) { expect(bs.length).toBe(2); expect(Array.from(bs[0])).toEqual(Array.from(bs[1])); }
    // the shared box still contains each twin's own vertices
    for (const c of out) {
      const b = (c.geometry as { bounds?: Float32Array }).bounds!, v = c.geometry.vertices;
      for (let i = 0; i < v.length; i += S) for (let k = 0; k < 3; k++) { expect(v[i + k]).toBeGreaterThanOrEqual(b[k] - 1e-6); expect(v[i + k]).toBeLessThanOrEqual(b[k + 3] + 1e-6); }
    }
  });
  it('a ground layer pair takes its uv-scale sample from the NEAR (full) geometry — the pre-twin scale', () => {
    const nearG = gridGeometry(40), farG = gridGeometry(12);
    const tw = { key: 'util-pole', dist: 3, cell: 6, uvFromNear: true };
    const ground = { surface: 'concrete' as const };
    const out = chunkCityLayers([
      { name: 'world:util-pole', color: [1, 1, 1], y: 0, geometry: farG, ground, nearTwin: { ...tw, role: 'far' } },
      { name: 'world:util-pole', color: [1, 1, 1], y: 0, geometry: nearG, ground, nearTwin: { ...tw, role: 'near' } },
    ], OPTS);
    const want = Array.from(groundUvSampleGeometry(nearG).vertices);
    for (const c of out) expect(Array.from(c.groundUvSample!.vertices)).toEqual(want);
  });
});

describe('a whole city (seed 3 grid) — nothing lost, every name-keyed rule still matches', () => {
  const PARAMS = { seed: 3, radius: 10, pattern: 'grid', border: 'square' } as unknown as LayoutParams;
  const groups = (buildCentreGroups(PARAMS, { parkedTrain: false, activeRegions: null } as never) as unknown as
    { groups: Array<{ name: string; layers: LayoutPreviewLayer[] }> }).groups;

  it('per group: same triangle count per layer NAME, same name set, and a real reduction in city-wide meshes', () => {
    let before = 0, after = 0, split = 0;
    for (const g of groups) {
      const out = chunkCityLayers(g.layers, OPTS);
      const sum = (ls: LayoutPreviewLayer[]): Map<string, number> => {
        const m = new Map<string, number>(); for (const L of ls) m.set(L.name, (m.get(L.name) ?? 0) + tris(L)); return m;
      };
      expect(sum(out)).toEqual(sum(g.layers));   // → every name regex (GLOW / LOD / snow / wet / drape tiers) sees the same set
      // (near/far twins: only one of a pair draws, so a pair counts once — P8 far tree crowns, P9 prop twins)
      const drawn = (ls: LayoutPreviewLayer[]): number => ls.filter((L) => !L.nearTwin || L.nearTwin.role === 'near').length;
      before += drawn(g.layers); after += drawn(out);
      split += g.layers.filter((L) => !out.includes(L)).length;
    }
    expect(split).toBeGreaterThan(10);           // the big merged layers really do split
    expect(after - before).toBeLessThan(1500);   // …without a draw-call explosion
  });

  it('signal lamps keep their phase-parsed names (SIGNAL_LAMP_RE)', () => {
    const sig = groups.find((g) => g.name === 'World Signals');
    if (!sig) return;
    const lampsIn = sig.layers.filter((L) => SIGNAL_LAMP_RE.test(L.name)).map((L) => L.name);
    const lampsOut = chunkCityLayers(sig.layers, OPTS).filter((L) => SIGNAL_LAMP_RE.test(L.name)).map((L) => L.name);
    expect(new Set(lampsOut)).toEqual(new Set(lampsIn));
  });
});
