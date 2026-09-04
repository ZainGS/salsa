import { describe, it, expect } from 'vitest';
import { EditMesh } from './edit-mesh';

describe('EditMesh.bevelVertex', () => {
    it('chamfers a cube corner: the vertex is replaced by a cap + new vertices, more faces', () => {
        const m = EditMesh.fromBox(1, 1, 1);
        const v0 = { x: m.vertices[0].x, y: m.vertices[0].y, z: m.vertices[0].z };
        const facesBefore = m.faces.length, vertsBefore = m.vertices.length;

        m.bevelVertex(0, 0.3);

        // A cube corner has 3 incident faces → 3 new cut-vertices + 1 cap face.
        expect(m.vertices.length).toBe(vertsBefore + 3);
        expect(m.faces.length).toBe(facesBefore + 1);
        // The 3 new vertices sit between the old corner and its neighbours (pulled inward), not at the old corner.
        const newVerts = m.vertices.slice(vertsBefore);
        for (const nv of newVerts) {
            const moved = Math.abs(nv.x - v0.x) > 1e-6 || Math.abs(nv.y - v0.y) > 1e-6 || Math.abs(nv.z - v0.z) > 1e-6;
            expect(moved).toBe(true);
        }
        // Geometry still compiles to a valid non-empty mesh.
        expect(m.compile().vertices.length).toBeGreaterThan(0);
    });

    it('is a no-op for an out-of-range index', () => {
        const m = EditMesh.fromBox(1, 1, 1);
        const before = m.faces.length;
        m.bevelVertex(999, 0.3);
        expect(m.faces.length).toBe(before);
    });

    it('survives a toJSON → fromJSON round-trip after the bevel', () => {
        const m = EditMesh.fromBox(1, 1, 1);
        m.bevelVertex(0, 0.25);
        const round = EditMesh.fromJSON(m.toJSON());
        expect(round.faces.length).toBe(m.faces.length);
        expect(round.vertices.length).toBe(m.vertices.length);
    });
});
