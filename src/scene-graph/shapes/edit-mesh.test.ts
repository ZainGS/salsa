import { describe, it, expect } from 'vitest';
import { EditMesh, MirrorModifier, SubdivisionModifier } from './edit-mesh';

const STRIDE = 12;          // FLOATS_PER_VERT
const UV_OFFSET = 6;        // u,v live at [o+6], [o+7]

/** True if any compiled GPU vertex carries a non-zero UV. */
function hasNonZeroUv(geom: { vertices: Float32Array }): boolean {
  const v = geom.vertices;
  for (let o = 0; o < v.length; o += STRIDE) {
    if (v[o + UV_OFFSET] !== 0 || v[o + UV_OFFSET + 1] !== 0) return true;
  }
  return false;
}

/** Give every box vertex a distinct, mostly-non-zero UV so we can watch it survive modifiers. */
function boxWithUvs(): EditMesh {
  const mesh = EditMesh.fromBox(1, 1, 1);
  mesh.vertices.forEach((vert, i) => { vert.uv = [(i + 1) / 8, 0.5]; });
  return mesh;
}

describe('EditMesh modifier stack', () => {
  describe('applyModifier — baking the prefix', () => {
    it('removes ALL baked modifiers so they do not re-apply on the next compile', () => {
      const mesh = EditMesh.fromBox(1, 2, 3);   // asymmetric so mirrors add geometry
      mesh.modifiers.push(new MirrorModifier('x'), new MirrorModifier('y'));

      const before = mesh.compile().vertices.length;   // both mirrors live
      mesh.applyModifier(1);                            // bake the whole stack

      // The entire prefix is folded into the base — nothing should remain to re-run.
      expect(mesh.modifiers.length).toBe(0);

      // Recompiling must reproduce the baked result exactly, not double it.
      const after = mesh.compile().vertices.length;
      expect(after).toBe(before);
    });

    it('baking a middle modifier leaves only the modifiers above it', () => {
      const mesh = EditMesh.fromBox(1, 2, 3);
      mesh.modifiers.push(
        new MirrorModifier('x'),
        new SubdivisionModifier(1),
        new MirrorModifier('y'),
      );

      mesh.applyModifier(1);   // bake mirror(x) + subdivision

      expect(mesh.modifiers.length).toBe(1);
      expect(mesh.modifiers[0]).toBeInstanceOf(MirrorModifier);
      expect((mesh.modifiers[0] as MirrorModifier).axis).toBe('y');
    });
  });

  describe('UV preservation', () => {
    it('Mirror modifier keeps source UVs instead of zeroing them', () => {
      const mesh = boxWithUvs();
      mesh.modifiers.push(new MirrorModifier('x'));
      expect(hasNonZeroUv(mesh.compile())).toBe(true);
    });

    it('Subdivision modifier keeps interpolated UVs instead of zeroing them', () => {
      const mesh = boxWithUvs();
      mesh.modifiers.push(new SubdivisionModifier(1));
      expect(hasNonZeroUv(mesh.compile())).toBe(true);
    });

    it('Mirror then bake writes the preserved UVs back into the base mesh', () => {
      const mesh = boxWithUvs();
      mesh.modifiers.push(new MirrorModifier('x'));
      mesh.applyModifier(0);
      expect(mesh.vertices.some(v => v.uv && (v.uv[0] !== 0 || v.uv[1] !== 0))).toBe(true);
    });
  });

  describe('fillHole', () => {
    it('caps a hole with outward-facing winding (not inward/black)', () => {
      const mesh = EditMesh.fromBox(2, 2, 2);
      mesh.deleteFace(2);   // top face [7,6,2,3] (+Y) → leaves a hole at the top

      const heIdx = mesh.halfEdges.findIndex(he => he.twin === -1);
      expect(heIdx).toBeGreaterThanOrEqual(0);

      const newFaceIdx = mesh.fillHole(heIdx);
      expect(newFaceIdx).toBeGreaterThanOrEqual(0);

      // The cap replaces a +Y face, so it must face +Y (outward), not -Y (into the box).
      const n = mesh.getFaceNormal(newFaceIdx);
      expect(n[1]).toBeGreaterThan(0.5);
    });
  });
});
