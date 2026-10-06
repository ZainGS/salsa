/**
 * Stylized rocks (rocks.ts): the archetype pool is deterministic and within budget, every stone is SUNK (its base is
 * below the ground line, nothing floats), normals are split only at hard edges, and the biome / apron layers keep
 * the `world:rocks` / `world:apron-rocks` prefixes the LOD tier, camera-occluder and collision rules key on.
 */
import { describe, it, expect } from 'vitest';
import { rockVariants, buildRockPool, rockCluster, rockLayers, powerLawSize, type RockPlacement } from './rocks';
import { makeRng } from './util';
import { generateCityLayout } from './layout';
import { buildBiome } from './biome';
import { buildApron } from './apron';
import { CITY_SOFT } from '../game/camera-occluders';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

const PROPS_LOD = /world:tree-|world:rocks|world:apron-rocks/;   // the rock entries of WorldManager.PROPS_LOD

function yRange(g: MeshGeometry): [number, number] {
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < g.vertices.length; i += 12) { lo = Math.min(lo, g.vertices[i]); hi = Math.max(hi, g.vertices[i]); }
    return [lo, hi];
}

describe('rock archetype pool', () => {
    const pool = rockVariants();

    it('has every archetype kind', () => {
        for (const k of ['boulder', 'slab', 'cluster', 'pebbles']) expect(pool.some(v => v.kind === k)).toBe(true);
    });

    it('is deterministic (same bytes when rebuilt from the recipe)', () => {
        const other = buildRockPool();
        expect(other).not.toBe(pool);
        expect(other.length).toBe(pool.length);
        other.forEach((v, i) => {
            expect(v.id).toBe(pool[i].id);
            expect(Array.from(v.stone.vertices)).toEqual(Array.from(pool[i].stone.vertices));
            expect(Array.from(v.stone.indices)).toEqual(Array.from(pool[i].stone.indices));
        });
    });

    it('stays within the triangle budget', () => {
        for (const v of pool) {
            const cap = v.kind === 'cluster' ? 200 : v.kind === 'pebbles' ? 110 : 170;
            expect(v.tris, v.id).toBeLessThanOrEqual(cap);
            expect(v.tris, v.id).toBeGreaterThan(40);   // not the old 8-tri octahedron
        }
    });

    it('never floats: every archetype is sunk 15-30 % of its height, base below the ground line', () => {
        for (const v of pool) {
            const [lo, hi] = yRange(v.stone);
            expect(lo, v.id).toBeLessThan(0);
            expect(hi, v.id).toBeGreaterThan(0);
            const frac = v.sink / (v.sink + v.height);
            expect(frac, v.id).toBeGreaterThanOrEqual(0.15);
            expect(frac, v.id).toBeLessThanOrEqual(0.31);
        }
    });

    it('is wider than tall with a ~1 m footprint', () => {
        for (const v of pool) {
            let r = 0;
            for (let i = 0; i < v.stone.vertices.length; i += 12) r = Math.max(r, Math.hypot(v.stone.vertices[i], v.stone.vertices[i + 2]));
            expect(r, v.id).toBeGreaterThan(0.45);
            expect(r, v.id).toBeLessThanOrEqual(0.5 + 1e-6);
            expect(v.height + v.sink, v.id).toBeLessThan(2 * r);
        }
    });

    it('splits normals only at hard edges (smooth forms share vertices; cut rims get duplicates)', () => {
        for (const v of pool) {
            const g = v.stone, nV = g.vertices.length / 12, nT = g.indices.length / 3;
            expect(nV, v.id).toBeLessThan(nT * 3);   // not a flat-shaded triangle soup
            for (let i = 0; i < g.vertices.length; i += 12) expect(Math.hypot(g.vertices[i + 3], g.vertices[i + 4], g.vertices[i + 5])).toBeCloseTo(1, 4);
        }
    });
});

describe('rock placement', () => {
    it('clusters: one big stone plus smaller ones, sizes on a power law', () => {
        const out: RockPlacement[] = [];
        for (let i = 0; i < 40; i++) rockCluster(out, i * 10, 0, 0, makeRng(1000 + i), 1, () => true);
        expect(out.length).toBeGreaterThan(80);   // 2-4 stones a cluster
        const sizes = out.map(p => p.size).sort((a, b) => a - b);
        expect(sizes[Math.floor(sizes.length / 2)]).toBeLessThan(sizes[sizes.length - 1] * 0.6);   // skewed: most small
        expect(powerLawSize(0, 0.5, 2)).toBeCloseTo(0.5, 6);
        expect(powerLawSize(1, 0.5, 2)).toBeCloseTo(2, 6);
    });

    it('rejected points are skipped (water / outside the lot)', () => {
        const out: RockPlacement[] = [];
        rockCluster(out, 0, 0, 0, makeRng(5), 1, () => false);
        expect(out.length).toBe(0);
    });

    it('is deterministic for a seed', () => {
        const a: RockPlacement[] = [], b: RockPlacement[] = [];
        rockCluster(a, 1, 2, 0, makeRng(77), 0.1, () => true);
        rockCluster(b, 1, 2, 0, makeRng(77), 0.1, () => true);
        expect(a).toEqual(b);
    });

    it('layers: instanced, shared geometry keys, per-copy scale in world units', () => {
        const L = rockLayers([{ x: 0, y: 0, z: 0, ry: 0, size: 1.5, v: 0 }, { x: 1, y: 0, z: 0, ry: 1, size: 0.5, v: 0 }], 15, 'world:rocks');
        expect(L.length).toBeGreaterThan(0);
        for (const l of L) {
            expect(l.arrayGroup).toBe(true);
            expect(l.instances!.length).toBe(2);
            expect(l.instances![0].s).toBeCloseTo(0.1, 6);
            expect(l.instanceKey).toMatch(/^rock:/);
            expect(l.foliageShade?.baseAO).toBeGreaterThan(0);
        }
        expect(L[0].instances).not.toBe(L[L.length - 1].instances);   // drape lifts in place: never alias
    });
});

describe('rock layers in the city', () => {
    const graph = generateCityLayout({ seed: 7, radius: 200, pattern: 'grid', elevation: 0 });

    it('park rocks keep the world:rocks prefix (PROPS_LOD + camera occluders match)', () => {
        const rocks = buildBiome(graph).filter(l => l.name.startsWith('world:rocks'));
        const inst = rocks.filter(l => l.instances?.length);
        expect(inst.length).toBeGreaterThan(0);
        for (const l of rocks) { expect(PROPS_LOD.test(l.name)).toBe(true); expect(CITY_SOFT.test(l.name)).toBe(true); }
    });

    it('apron rocks keep the world:apron-rocks prefix', () => {
        const g = generateCityLayout({ seed: 7, radius: 200, pattern: 'grid', elevation: 0, terrainApron: true } as never);
        const rocks = buildApron(g).filter(l => l.name.includes('rocks'));
        for (const l of rocks) {
            expect(l.name.startsWith('world:apron-rocks-')).toBe(true);
            expect(PROPS_LOD.test(l.name)).toBe(true);
            expect(CITY_SOFT.test(l.name)).toBe(true);
            expect(l.excludeFromFrame).toBe(true);
        }
    });
});
