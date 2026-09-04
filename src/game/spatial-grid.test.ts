import { describe, it, expect } from 'vitest';
import { SpatialGridXZ, type XZBounds } from './spatial-grid';

const b = (minX: number, minZ: number, maxX: number, maxZ: number): XZBounds => ({ minX, minZ, maxX, maxZ });

describe('SpatialGridXZ', () => {
    it('returns only meshes whose AABB covers the queried column', () => {
        const boxes = [b(0, 0, 1, 1), b(10, 10, 11, 11), b(0.5, 0.5, 2, 2)];
        const g = SpatialGridXZ.build(boxes);
        const out: number[] = [];
        g.queryPoint(0.75, 0.75, out);
        expect(out.sort()).toEqual([0, 2]);       // 0 and 2 overlap (0.75,0.75); 1 is far away
        g.queryPoint(10.5, 10.5, out);
        expect(out).toEqual([1]);
    });

    it('finds nothing in an empty column', () => {
        const g = SpatialGridXZ.build([b(0, 0, 1, 1)]);
        const out: number[] = [];
        g.queryPoint(50, 50, out);
        expect(out).toEqual([]);
    });

    it('deduplicates a mesh spanning several cells across a region query', () => {
        // one big-ish box over many cells (but under the oversized cap), queried over a region it fills.
        const g = new SpatialGridXZ(1, 1024);
        g.insert(0, b(0, 0, 5, 5));
        const out: number[] = [];
        g.query(b(0, 0, 5, 5), out);
        expect(out).toEqual([0]);                  // appears once despite covering 36 cells
    });

    it('always tests oversized AABBs (a city-spanning ground plane)', () => {
        const g = new SpatialGridXZ(1, 16);        // low cap so the big plane is "oversized"
        g.insert(0, b(-1000, -1000, 1000, 1000));  // spans millions of cells → oversized list
        g.insert(1, b(3, 3, 4, 4));                // a normal small mesh
        const out: number[] = [];
        g.queryPoint(500, 500, out);
        expect(out).toEqual([0]);                  // the ground plane is found far from any small mesh
        g.queryPoint(3.5, 3.5, out);
        expect(out.sort()).toEqual([0, 1]);        // ground plane + the small mesh
    });

    it('reuses the out array (clears it each query)', () => {
        const g = SpatialGridXZ.build([b(0, 0, 1, 1)]);
        const out: number[] = [];
        g.queryPoint(0.5, 0.5, out);
        expect(out).toEqual([0]);
        g.queryPoint(99, 99, out);
        expect(out).toEqual([]);                   // not stale from the previous query
    });
});
