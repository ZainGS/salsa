/**
 * src/packaging/test-utils.ts — SHARED helpers for the packaging test suites (not a test file).
 *
 * The real-node host + oracle helpers extracted from the box-hierarchy.nodes.test.ts pattern so
 * every template suite (tuck-end, sleeve, …) runs the same RUNTIME correctness gate: build the
 * hierarchy through REAL MeshGroup3D/Mesh3D nodes with the exact ShapeManager-adapter transform
 * semantics, then compare world corners / hinge coincidence against the closed-form math.
 */

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { Mesh3D } from '../scene-graph/shapes/mesh-3d';
import type { InteractionService } from '../services/interaction-service';
import type { BoxNodeHost, PackagingBox } from './box-hierarchy';
import type { FoldPanel } from './types';

// Shape's ctor only touches maxGlobalZIndex; hit-testing/world-matrix paths aren't exercised here.
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** A BoxNodeHost over REAL scene nodes, mirroring the ShapeManager adapter exactly. */
export function makeRealNodeHost(): { host: BoxNodeHost; meshes: Map<string, Mesh3D> } {
  const nodes = new Map<string, MeshGroup3D | Mesh3D>();
  const meshes = new Map<string, Mesh3D>();
  const host: BoxNodeHost = {
    createGroup: (name, parentNodeId, scale) => {
      const grp = new MeshGroup3D(isvc);
      grp.name = name;
      if (scale !== undefined) { grp.scaleX = scale; grp.scaleY = scale; grp.scaleZ = scale; }
      const parent = parentNodeId ? nodes.get(parentNodeId) : undefined;
      parent?.addChild(grp);
      nodes.set(grp.id, grp);
      return grp.id;
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
      n.forEachDeep(d => { if (d instanceof Mesh3D) d.updateLocalMatrix(); });
    },
    setPanelGeometry: (meshId, geom) => { meshes.get(meshId)?.setGeometry(geom); },
    removeNode: (id) => { const n = nodes.get(id); n?.parent?.removeChild(n); nodes.delete(id); },
  };
  return { host, meshes };
}

/** World-space corner positions of a panel mesh via the REAL node matrix chain. */
export function realWorldCorners(mesh: Mesh3D): [number, number, number][] {
  const world = mesh.localMatrix as mat4;            // combined parent-chain × local (the render path)
  const geo = mesh.geometry;                          // 12-float stride after computeTangents
  const out: [number, number, number][] = [];
  for (let k = 0; k < geo.vertices.length / 12; k++) {
    const p = vec3.fromValues(geo.vertices[k * 12], geo.vertices[k * 12 + 1], geo.vertices[k * 12 + 2]);
    const w = vec3.transformMat4(vec3.create(), p, world);
    out.push([w[0], w[1], w[2]]);
  }
  return out;
}

/** panelFrame reimplemented (test-side oracle): origin at hinge[0], +X along the hinge, pure yaw. */
export function frameOf(panel: FoldPanel): mat4 {
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
 * HINGE-EDGE COINCIDENCE (the gap check): each non-root panel's hinge edge through the CHILD's
 * real node chain must land exactly on the same edge expressed in the PARENT panel's local frame
 * through the PARENT's real node chain. Any pos-vs-geometry mismatch opens a visible gap here.
 */
export function expectHingeCoincidence(
  panels: FoldPanel[], box: PackagingBox, meshes: Map<string, Mesh3D>, unit: number, label: string,
): void {
  panels.forEach((panel, i) => {
    if (!panel.hinge || panel.parentPanelIndex < 0) return;
    const childWorld = meshes.get(box.panels[i].meshId)!.localMatrix as mat4;
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

// ── interpenetration oracle (board-zero tolerance) ────────────────────────

type V3 = [number, number, number];

function planeOf(corners: V3[]): { n: V3; d: number } | null {
  for (let i = 1; i < corners.length - 1; i++) {
    const ax = corners[i][0] - corners[0][0], ay = corners[i][1] - corners[0][1], az = corners[i][2] - corners[0][2];
    const bx = corners[i + 1][0] - corners[0][0], by = corners[i + 1][1] - corners[0][1], bz = corners[i + 1][2] - corners[0][2];
    const n: V3 = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > 1e-8) return { n: [n[0] / len, n[1] / len, n[2] / len], d: n[0] / len * corners[0][0] + n[1] / len * corners[0][1] + n[2] / len * corners[0][2] };
  }
  return null;
}

/** True when point x (already ON B's plane) lies strictly inside convex polygon B by margin eps. */
function insideConvex(x: V3, B: V3[], n: V3, eps: number): boolean {
  let sign = 0;
  for (let i = 0; i < B.length; i++) {
    const a = B[i], b = B[(i + 1) % B.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    const px = x[0] - a[0], py = x[1] - a[1], pz = x[2] - a[2];
    // (edge × toPoint) · n — signed side distance scaled by |edge|.
    const cx = ey * pz - ez * py, cy = ez * px - ex * pz, cz = ex * py - ey * px;
    const s = cx * n[0] + cy * n[1] + cz * n[2];
    const elen = Math.hypot(ex, ey, ez) || 1;
    const dist = s / elen;
    if (Math.abs(dist) <= eps) return false;             // within the margin of an edge → not "strictly inside"
    if (sign === 0) sign = Math.sign(dist);
    else if (Math.sign(dist) !== sign) return false;     // outside
  }
  return true;
}

/**
 * PROPER interpenetration test: does any EDGE of panel A pierce THROUGH panel B's interior —
 * crossing B's plane with more than `eps` (board-zero tolerance) on BOTH sides, at a point
 * strictly inside B's polygon? Coplanar stacking (tongue against a wall, closure over dust
 * flaps) and edge-on-edge contact are NOT penetration — exactly the physical model of
 * zero-thickness board plies lying on each other.
 */
export function edgesPenetratePanel(A: V3[], B: V3[], eps = 1e-3): boolean {
  const plane = planeOf(B);
  if (!plane) return false;
  const { n, d } = plane;
  for (let i = 0; i < A.length; i++) {
    const p = A[i], q = A[(i + 1) % A.length];
    const dp = p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - d;
    const dq = q[0] * n[0] + q[1] * n[1] + q[2] * n[2] - d;
    if (!((dp > eps && dq < -eps) || (dp < -eps && dq > eps))) continue;   // no proper crossing
    const t = dp / (dp - dq);
    const x: V3 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    if (insideConvex(x, B, n, eps)) return true;
  }
  return false;
}

/** Assert NO pair of panels properly interpenetrates (both directions) at the given fold pose. */
export function expectNoInterpenetration(cornersPerPanel: V3[][], panels: FoldPanel[], label: string, eps = 1e-3): void {
  for (let i = 0; i < cornersPerPanel.length; i++) {
    for (let j = 0; j < cornersPerPanel.length; j++) {
      if (i === j) continue;
      expect(edgesPenetratePanel(cornersPerPanel[i], cornersPerPanel[j], eps),
        `${label}: panel '${panels[i].id}' edge pierces through panel '${panels[j].id}'`,
      ).toBe(false);
    }
  }
}
