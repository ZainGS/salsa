/**
 * box-hierarchy.nodes.test.ts — the RUNTIME correctness gate.
 *
 * box-hierarchy.test.ts proves the MATH (computeFoldWorldCorners == compileFoldMesh). This test
 * proves the SCENE GRAPH: it builds the hierarchy through REAL MeshGroup3D/Mesh3D nodes using the
 * exact transform semantics of the ShapeManager adapter (setXYZ + rotationX/Y setters), then reads
 * each panel's WORLD matrix via the real `localMatrix` (parent-chain) getter and asserts the panel
 * corners land where the verified math says. If the node classes composed rotations differently
 * (order/units/2D-only), THIS test fails — the gap that let a "math-correct" box render garbled.
 */
import { describe, it, expect } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { mat4, vec3 } from 'gl-matrix';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { Mesh3D } from '../scene-graph/shapes/mesh-3d';
import type { InteractionService } from '../services/interaction-service';
import { buildBoxNodes, setBoxFold, updateBoxDimensions, computeFoldWorldCorners, type BoxNodeHost, type PackagingBox } from './box-hierarchy';
import { simpleBox } from './templates/simple-box';
import type { FoldPanel } from './types';

// Shape's ctor only touches maxGlobalZIndex; hit-testing/world-matrix paths aren't exercised here.
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** A BoxNodeHost over REAL scene nodes, mirroring the ShapeManager adapter exactly. */
function makeRealNodeHost() {
  const nodes = new Map<string, MeshGroup3D | Mesh3D>();
  const meshes = new Map<string, Mesh3D>();
  const host: BoxNodeHost = {
    createGroup: (name, parentNodeId, scale) => {
      const g = new MeshGroup3D(isvc);
      g.name = name;
      if (scale !== undefined) { g.scaleX = scale; g.scaleY = scale; g.scaleZ = scale; }
      const parent = parentNodeId ? nodes.get(parentNodeId) : undefined;
      parent?.addChild(g);   // root group stays parentless (scene root is identity anyway)
      nodes.set(g.id, g);
      return g.id;
    },
    createPanelMesh: (geom, parentNodeId, name) => {
      const m = new Mesh3D(isvc, 0, 0, 0, {
        primitive: 'custom', geometry: geom,
        material: { doubleSided: true, roughness: 0.92, metalness: 0 },
      });
      m.name = name;
      nodes.get(parentNodeId)?.addChild(m);
      nodes.set(m.id, m);
      meshes.set(m.id, m);
      return m.id;
    },
    setNodeTransform: (id, t) => {   // EXACT adapter semantics (shape-manager.ts packaging host)
      const n = nodes.get(id);
      if (!n) return;
      if (t.pos) n.setXYZ(t.pos[0], t.pos[1], t.pos[2]);
      if (t.rotX !== undefined) n.rotationX = t.rotX;
      if (t.rotY !== undefined) n.rotationY = t.rotY;
      if (t.rotZ !== undefined) n.rotation = t.rotZ;
      // ★adapter's descendant version-bump (the renderer's moved-detection watches each MESH's own
      // localMatrixVersion, which doesn't change when only a parent pivot rotates).
      n.forEachDeep(d => { if (d instanceof Mesh3D) d.updateLocalMatrix(); });
    },
    // EXACT adapter semantics: scene3d.setGeometry → mesh.setGeometry (computeTangents, gpuDirty).
    setPanelGeometry: (meshId, geom) => { meshes.get(meshId)?.setGeometry(geom); },
    removeNode: (id) => { const n = nodes.get(id); n?.parent?.removeChild(n); nodes.delete(id); },
  };
  return { host, meshes };
}

/** panelFrame reimplemented (test-side oracle): origin at hinge[0], +X along the hinge, pure yaw. */
function frameOf(panel: FoldPanel): mat4 {
  const m = mat4.create();
  if (!panel.hinge) return m;
  const a = panel.hinge[0], b = panel.hinge[1];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  m[0] = ux;  m[1] = 0; m[2] = uz;
  m[8] = -uz; m[9] = 0; m[10] = ux;
  m[12] = a[0]; m[13] = 0; m[14] = a[1];
  return m;
}

/**
 * HINGE-EDGE COINCIDENCE (the gap check): each non-root panel's hinge edge — local (0,0,0)→(L·unit,0,0)
 * through the CHILD's real node chain — must land exactly on the same edge expressed in the PARENT
 * panel's local frame through the PARENT's real node chain. Any pos-vs-geometry mismatch (stale pivot,
 * wrong yaw, geometry from different dims than the pivots) opens a visible gap here.
 */
function expectHingeCoincidence(
  panels: FoldPanel[], box: PackagingBox, meshes: Map<string, Mesh3D>, unit: number, label: string,
): void {
  panels.forEach((panel, i) => {
    if (!panel.hinge || panel.parentPanelIndex < 0) return;
    const childWorld = meshes.get(box.panels[i].meshId)!.localMatrix as mat4;       // pivot chain (mesh local = I)
    const parentWorld = meshes.get(box.panels[panel.parentPanelIndex].meshId)!.localMatrix as mat4;
    const Fp = frameOf(panels[panel.parentPanelIndex]);
    const FpInv = mat4.invert(mat4.create(), Fp)!;
    const a = panel.hinge[0], b = panel.hinge[1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const childLocal: [number, number, number][] = [[0, 0, 0], [L * unit, 0, 0]];
    const netPts = [vec3.fromValues(a[0], 0, a[1]), vec3.fromValues(b[0], 0, b[1])];
    childLocal.forEach((cl, k) => {
      const fromChild = vec3.transformMat4(vec3.create(), vec3.fromValues(cl[0], cl[1], cl[2]), childWorld);
      const inParentLocal = vec3.transformMat4(vec3.create(), netPts[k], FpInv);
      vec3.scale(inParentLocal, inParentLocal, unit);
      const fromParent = vec3.transformMat4(vec3.create(), inParentLocal, parentWorld);
      for (let d = 0; d < 3; d++) {
        expect(Math.abs(fromChild[d] - fromParent[d]),
          `${label}: panel ${i} (${panel.id}) hinge endpoint ${k} axis ${d}: child-side ${fromChild[d]} vs parent-side ${fromParent[d]} — GAP`,
        ).toBeLessThan(1e-4);
      }
    });
  });
}

/** World-space corner positions of a panel mesh via the REAL node matrix chain. */
function realWorldCorners(mesh: Mesh3D): [number, number, number][] {
  const world = mesh.localMatrix as mat4;            // combined parent-chain × local (the render path)
  const g = mesh.geometry;                            // 12-float stride after computeTangents
  const out: [number, number, number][] = [];
  for (let k = 0; k < g.vertices.length / 12; k++) {
    const p = vec3.fromValues(g.vertices[k * 12], g.vertices[k * 12 + 1], g.vertices[k * 12 + 2]);
    const w = vec3.transformMat4(vec3.create(), p, world);
    out.push([w[0], w[1], w[2]]);
  }
  return out;
}

describe('box hierarchy through REAL scene-graph nodes', () => {
  const { foldMeshData } = simpleBox({ width: 80, height: 60, depth: 40 });

  for (const amount of [0, 0.5, 1]) {
    it(`real-node world corners match the verified fold math at fold=${amount} (scale 1)`, () => {
      const { host, meshes } = makeRealNodeHost();
      const box = buildBoxNodes(foldMeshData.panels, host, { scale: 1 });   // scale 1 → compare in net mm
      setBoxFold(box, amount, host);
      const expected = computeFoldWorldCorners(foldMeshData.panels, amount);  // == compileFoldMesh (proven)
      box.panels.forEach((p, i) => {
        const actual = realWorldCorners(meshes.get(p.meshId)!);
        expect(actual.length).toBe(expected[i].length);
        actual.forEach((c, k) => {
          for (let d = 0; d < 3; d++) {
            expect(Math.abs(c[d] - expected[i][k][d]),
              `panel ${i} corner ${k} axis ${d}: real-node ${c[d]} vs math ${expected[i][k][d]} (fold ${amount})`,
            ).toBeLessThan(1e-4);
          }
        });
      });
    });
  }

  it('root scale 0.02 uniformly scales the whole box (mm → world units)', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(foldMeshData.panels, host, { scale: 0.02 });
    setBoxFold(box, 1, host);
    const expected = computeFoldWorldCorners(foldMeshData.panels, 1);
    box.panels.forEach((p, i) => {
      const actual = realWorldCorners(meshes.get(p.meshId)!);
      actual.forEach((c, k) => {
        for (let d = 0; d < 3; d++) {
          expect(Math.abs(c[d] - expected[i][k][d] * 0.02)).toBeLessThan(1e-4);
        }
      });
    });
  });
});

describe('IN-PLACE re-dimension (the setDimensions fast path) through REAL nodes', () => {
  const UNIT = 0.02;
  const oldPanels = simpleBox({ width: 80, height: 60, depth: 40 }).foldMeshData.panels;
  const newPanels = simpleBox({ width: 110, height: 45, depth: 55 }).foldMeshData.panels;

  /** Assert every panel's REAL-node world corners == the verified fold math (·UNIT). */
  function expectCornersMatch(panels: FoldPanel[], box: PackagingBox, meshes: Map<string, Mesh3D>, amount: number, label: string): void {
    const expected = computeFoldWorldCorners(panels, amount);
    box.panels.forEach((p, i) => {
      const actual = realWorldCorners(meshes.get(p.meshId)!);
      expect(actual.length, `${label}: panel ${i} corner count`).toBe(expected[i].length);
      actual.forEach((c, k) => {
        for (let d = 0; d < 3; d++) {
          expect(Math.abs(c[d] - expected[i][k][d] * UNIT),
            `${label}: panel ${i} corner ${k} axis ${d}: real-node ${c[d]} vs math ${expected[i][k][d] * UNIT}`,
          ).toBeLessThan(1e-4);
        }
      });
    });
  }

  it('the user sequence: build(80×60×40, 0.02) → fold 0.57 → updateBoxDimensions → fold 0.57 matches the math, no hinge gaps', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(oldPanels, host, { scale: UNIT });
    setBoxFold(box, 0.57, host);
    expectCornersMatch(oldPanels, box, meshes, 0.57, 'before resize');

    // Hinge coincidence BEFORE the resize at fold 0 / 0.57 / 1.
    for (const amt of [0, 0.57, 1]) {
      setBoxFold(box, amt, host);
      expectHingeCoincidence(oldPanels, box, meshes, UNIT, `before resize, fold ${amt}`);
    }
    setBoxFold(box, 0.57, host);

    // Simulate packaging-manager.setDimensions' in-place fast path.
    expect(updateBoxDimensions(box, newPanels, host, { scale: UNIT })).toBe(true);
    setBoxFold(box, 0.57, host);

    expectCornersMatch(newPanels, box, meshes, 0.57, 'after resize');

    // Hinge coincidence AFTER the resize at fold 0 / 0.57 / 1.
    for (const amt of [0, 0.57, 1]) {
      setBoxFold(box, amt, host);
      expectHingeCoincidence(newPanels, box, meshes, UNIT, `after resize, fold ${amt}`);
      expectCornersMatch(newPanels, box, meshes, amt, `after resize, fold ${amt}`);
    }
  });

  it('re-dimension bumps every panel MESH matrix version (the renderer moved-slot contract)', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(oldPanels, host, { scale: UNIT });
    setBoxFold(box, 0.57, host);
    const before = box.panels.map(p => meshes.get(p.meshId)!.localMatrixVersion);
    updateBoxDimensions(box, newPanels, host, { scale: UNIT });
    setBoxFold(box, 0.57, host);
    box.panels.forEach((p, i) => {
      expect(meshes.get(p.meshId)!.localMatrixVersion,
        `panel ${i}: mesh matrix version must change so the renderer fast path re-uploads its slot`,
      ).not.toBe(before[i]);
    });
  });
});

describe('renderer transform contract through the node chain', () => {
  it('a GRAND-parent pivot rotation refreshes the leaf combined matrix AND (via the adapter bump) its version', () => {
    const { host, meshes } = makeRealNodeHost();
    const { foldMeshData } = simpleBox({ width: 80, height: 60, depth: 40 });
    const box = buildBoxNodes(foldMeshData.panels, host, { scale: 0.02 });

    // The lid (index 5) hangs off the back wall (index 2): root → backPivot → lidPivot → lidMesh.
    // Rotating the BACK pivot is a GRAND-parent change for the lid mesh.
    const lidMesh = meshes.get(box.panels[5].meshId)!;
    void lidMesh.localMatrix;                          // prime the combined-matrix cache
    const v0 = lidMesh.localMatrixVersion;
    const c0 = realWorldCorners(lidMesh).map(c => [...c]);

    const back = box.panels[2];
    host.setNodeTransform(back.pivotNodeId, { pos: back.pos, rotY: back.yaw, rotX: back.targetAngleRad * 0.8 });

    // 1. Version bumped (the renderer's `_slotMatVer.get(id) !== localMatrixVersion` moved-check fires).
    expect(lidMesh.localMatrixVersion).not.toBe(v0);
    // 2. The combined localMatrix getter did NOT serve the stale cached ancestor chain.
    const c1 = realWorldCorners(lidMesh);
    const moved = c1.some((c, k) => c.some((v, d) => Math.abs(v - c0[k][d]) > 1e-6));
    expect(moved, 'leaf combined matrix must reflect a grand-parent rotation').toBe(true);
    // 3. And it lands exactly where the verified math says.
    const expected = computeFoldWorldCorners(foldMeshData.panels, 0.8);
    // Only the back+lid chain moved (fold 0.8 applied to the back pivot only) — check the LID via the
    // math with the same partial pose: rebuild by folding ONLY the back panel's ancestor chain.
    // Simplest exact oracle: fold the whole box to 0.8 and compare the lid+back panels, whose world
    // pose depends only on their own chain (base is root, unrotated in both).
    setBoxFold(box, 0.8, host);
    for (const idx of [2, 5]) {
      const actual = realWorldCorners(meshes.get(box.panels[idx].meshId)!);
      actual.forEach((c, k) => {
        for (let d = 0; d < 3; d++) {
          expect(Math.abs(c[d] - expected[idx][k][d] * 0.02)).toBeLessThan(1e-4);
        }
      });
    }
  });
});
