/**
 * group-bounds.test.ts — engine-roadmap step 3: the City gizmo bounds from cached per-geometry boxes, in time slices,
 * must equal the old whole-vertex walk (Scene3DManager.cacheGroupBounds) exactly, through adds / removes / geometry
 * swaps / in-place edits and excluded subgroups.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { InteractionService } from '../interaction-service';
import { GroupBoundsJob, groupBoundsStats } from './group-bounds';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function geom(r: () => number, n: number, spread: number) {
    const v = new Float32Array(n * 12), ix = new Uint32Array(n - (n % 3));
    for (let i = 0; i < n; i++) { v[i * 12] = (r() - 0.5) * spread; v[i * 12 + 1] = r() * spread * 0.3; v[i * 12 + 2] = (r() - 0.5) * spread; }
    for (let i = 0; i < ix.length; i++) ix[i] = i;
    return { vertices: v, indices: ix, format: '12float' as const };
}
function mesh(r: () => number, spread: number): Mesh3D {
    const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: geom(r, 3 + Math.floor(r() * 60), spread) });
    m.gpuDirty = false;
    return m;
}

/** The pre-step-3 cacheGroupBounds loop, verbatim. */
function oldBounds(group: MeshGroup3D, exclude?: (n: string) => boolean) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const child of group.children) {
        if (child instanceof MeshGroup3D && exclude?.(child.name ?? '')) continue;
        child.forEachDeep(n => {
            if (!(n instanceof Mesh3D)) return;
            const v = n.geometry?.vertices;
            if (!v || v.length === 0) return;
            for (let i = 0; i < v.length; i += 12) {
                const x = v[i], y = v[i + 1], z = v[i + 2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
        });
    }
    return isFinite(minX) ? { minX, minY, minZ, maxX, maxY, maxZ } : null;
}
function sliced(group: MeshGroup3D, exclude?: (n: string) => boolean, budget = 0) {
    const job = new GroupBoundsJob(group, exclude);
    let steps = 0;
    while (!job.step(budget)) if (++steps > 1e6) throw new Error('no progress');
    return job.result();
}

describe('GroupBoundsJob (step 3 incremental tile bounds)', () => {
    it('equals the old vertex walk over random tile trees, through adds / removes / swaps / in-place edits', () => {
        const r = rng(7);
        const exclude = (n: string) => /World Traffic|World Apron/.test(n);
        const root = new MeshGroup3D(isvc); root.name = 'City';
        const tiles: MeshGroup3D[] = [];
        const addTile = (i: number) => {
            const t = new MeshGroup3D(isvc); t.name = i % 5 === 4 ? 'World Traffic' : `World Tile ${i}_0 Streets`;
            for (let k = 0; k < 4 + Math.floor(r() * 8); k++) {
                if (r() < 0.25) { const sub = new MeshGroup3D(isvc); sub.name = 'cell'; sub.addChild(mesh(r, 40 + i * 3)); t.addChild(sub); }
                else t.addChild(mesh(r, 20 + i * 5));
            }
            root.addChild(t); tiles.push(t);
        };
        for (let i = 0; i < 12; i++) addTile(i);
        for (let round = 0; round < 40; round++) {
            const op = r();
            if (op < 0.3) addTile(12 + round);
            else if (op < 0.5 && tiles.length > 2) { const t = tiles.splice(Math.floor(r() * tiles.length), 1)[0]; root.removeChild(t); }
            else if (op < 0.7) {   // geometry replaced (a new vertex array)
                const t = tiles[Math.floor(r() * tiles.length)]; const m = t.children.find((c) => c instanceof Mesh3D) as Mesh3D | undefined;
                if (m) { m.setGeometry(geom(r, 9, 300)); m.gpuDirty = false; }
            } else if (op < 0.85) {   // edited in place: gpuDirty until uploaded
                const t = tiles[Math.floor(r() * tiles.length)]; const m = t.children.find((c) => c instanceof Mesh3D) as Mesh3D | undefined;
                if (m) { m.geometry.vertices[0] = 900 * (r() - 0.5); m.gpuDirty = true; }
            } else {   // a mesh whose vertices were released
                const t = tiles[Math.floor(r() * tiles.length)]; const m = t.children.find((c) => c instanceof Mesh3D) as Mesh3D | undefined;
                if (m) { m.setGeometry({ vertices: new Float32Array(0), indices: new Uint32Array(0), format: '12float' }); m.gpuDirty = false; }
            }
            expect(sliced(root, exclude, round % 2 ? 0 : Infinity)).toEqual(oldBounds(root, exclude));
        }
    });

    it('scans each geometry once: a repeat walk is served from the cache', () => {
        const r = rng(3);
        const root = new MeshGroup3D(isvc);
        for (let i = 0; i < 50; i++) root.addChild(mesh(r, 10));
        sliced(root);
        const before = groupBoundsStats.scanned;
        expect(sliced(root)).toEqual(oldBounds(root));
        expect(groupBoundsStats.scanned).toBe(before);
    });

    it('an empty tree has no bounds', () => {
        const root = new MeshGroup3D(isvc);
        expect(sliced(root)).toBeNull();
        expect(oldBounds(root)).toBeNull();
    });
});
