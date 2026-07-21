/**
 * src/packaging/box-hierarchy.ts — the rigid-panel HINGE HIERARCHY box.
 *
 * Replaces the vertex-baking fold compiler (fold-mesh.ts) at runtime: instead of re-uploading
 * one merged geometry every fold frame, the box is a tree of scene-graph nodes — 6 flat panel
 * meshes whose geometry is created ONCE, and a pivot node per panel. Folding = rotating the
 * pivot nodes around their local +X (pure transforms, cascading via parent-child).
 *
 * FRAME MATH (this is the whole point — it must reproduce compileFoldMesh EXACTLY):
 *  - Each panel gets a rigid FRAME F = T(hinge[0]) · B, where B is the pure-yaw basis whose
 *    +X is the hinge direction (hinge[0]→hinge[1]), +Y is up, +Z completes the right-handed set.
 *    F maps the panel's LOCAL coords → flat-net coords. The root's frame is the identity.
 *  - The panel MESH geometry is authored in local coords: localCorner = F⁻¹ · (netX, 0, netZ).
 *    So the hinge sits on the local origin along +X, and the panel lies flat (normal ±Y).
 *  - The pivot node's REST transform in its PARENT's frame is C = F_parent⁻¹ · F. Because every
 *    panel starts coplanar (flat net), C is always a pure yaw + translation, so it is expressible
 *    EXACTLY by the Euler scene node as position + rotationY. Folding adds rotationX = θ.
 *  - Key identity: rotateAroundLine(a,b,θ) · F = F · Rx(θ) when F's +X = normalize(b−a). Hence
 *    the node world W_i = W_parent · C · Rx(θ) satisfies W_i = world_i(compile) · F_i, and a local
 *    corner maps to W_i · F_i⁻¹ · net = world_i(compile) · net — identical to compileFoldMesh.
 *    (box-hierarchy.test.ts verifies this numerically to 1e-4.)
 */

import { mat4, vec3 } from 'gl-matrix';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { FoldPanel } from './types';

const DEG2RAD = Math.PI / 180;

/** Unit normal of a (planar) polygon from its first non-degenerate triangle (matches fold-mesh.ts). */
function polygonNormal(pts: vec3[]): vec3 {
  const n = vec3.create();
  for (let i = 1; i < pts.length - 1; i++) {
    const e1 = vec3.subtract(vec3.create(), pts[i], pts[0]);
    const e2 = vec3.subtract(vec3.create(), pts[i + 1], pts[0]);
    vec3.cross(n, e1, e2);
    if (vec3.length(n) > 1e-6) { return vec3.normalize(n, n); }
  }
  return vec3.fromValues(0, 1, 0);
}

/**
 * Rigid frame F mapping this panel's LOCAL coords → flat-net coords. Origin at hinge[0], local
 * +X along the hinge, +Y up, +Z = X×Y. Identity for the root (no hinge). A pure yaw + translation.
 */
function panelFrame(panel: FoldPanel): mat4 {
  const m = mat4.create();   // identity
  if (!panel.hinge) return m;
  const a = panel.hinge[0], b = panel.hinge[1];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  // column-major: col0=X=(ux,0,uz), col1=Y=(0,1,0), col2=Z=X×Y=(-uz,0,ux), col3=T=(a.x,0,a.z)
  m[0] = ux;  m[1] = 0; m[2] = uz;  m[3] = 0;
  m[4] = 0;   m[5] = 1; m[6] = 0;   m[7] = 0;
  m[8] = -uz; m[9] = 0; m[10] = ux; m[11] = 0;
  m[12] = a[0]; m[13] = 0; m[14] = a[1]; m[15] = 1;
  return m;
}

/** Winding canon: force the flat-net normal to −Y (the net's back face) — identical to fold-mesh.ts. */
function windCanon(panel: FoldPanel): { corners: [number, number][]; uvs: [number, number][] } {
  let corners = panel.corners, uvs = panel.uvs;
  const flat = corners.map(c => vec3.fromValues(c[0], 0, c[1]));
  if (polygonNormal(flat)[1] > 0) { corners = corners.slice().reverse(); uvs = uvs.slice().reverse(); }
  return { corners, uvs };
}

/** The flat panel mesh in LOCAL coords (hinge on origin, +X along hinge, normal ±Y). Built once.
 *  `unit` BAKES the mm→world scale into the vertices (see buildPanelBuilds — we do NOT rely on group scale). */
export function buildPanelLocalGeometry(panel: FoldPanel, unit = 1): MeshGeometry {
  const F = panelFrame(panel);
  const Finv = mat4.invert(mat4.create(), F) ?? mat4.create();
  const { corners, uvs } = windCanon(panel);
  const local = corners.map(c => vec3.transformMat4(vec3.create(), vec3.fromValues(c[0], 0, c[1]), Finv));
  const nrm = polygonNormal(local);
  const n = local.length;
  const verts = new Float32Array(n * 8);
  for (let k = 0; k < n; k++) {
    verts[k * 8 + 0] = local[k][0] * unit; verts[k * 8 + 1] = local[k][1] * unit; verts[k * 8 + 2] = local[k][2] * unit;
    verts[k * 8 + 3] = nrm[0];      verts[k * 8 + 4] = nrm[1];      verts[k * 8 + 5] = nrm[2];
    verts[k * 8 + 6] = uvs[k][0];   verts[k * 8 + 7] = uvs[k][1];
  }
  const indices: number[] = [];
  for (let k = 1; k < n - 1; k++) indices.push(0, k, k + 1);   // fan
  return { vertices: verts, indices: new Uint32Array(indices), format: '8float' };
}

/** Rest placement (in the parent panel's frame) + fold parameters for one panel. */
export interface PanelBuild {
  geometry: MeshGeometry;
  /** Pivot rest transform in the PARENT frame: position + yaw (rotationY). Root: zeros. */
  pivot: { pos: [number, number, number]; yaw: number };
  /** Fully-folded angle in radians (targetAngle·π/180); 0 for the root. Fold sets rotationX = this·amount. */
  targetAngleRad: number;
  isRoot: boolean;
  parentPanelIndex: number;
}

/** Per-panel geometry + pivot placement, derived purely from the net (no scene graph).
 *  `unit` bakes the mm→world scale into BOTH the local geometry and the pivot translations — uniform scale
 *  commutes with the (rotation-only) hinge chain, so world output = unit × the unit-1 output, EXACTLY. We bake
 *  instead of relying on a root group scale: group-scale semantics proved environment-divergent (headless test
 *  applied it, the browser render path did not — the "120mm net vs 3.4-unit camera" invisibility). */
export function buildPanelBuilds(panels: FoldPanel[], unit = 1): PanelBuild[] {
  const frames = panels.map(panelFrame);
  return panels.map((p, i) => {
    const isRoot = p.parentPanelIndex < 0 || !p.hinge;
    let pos: [number, number, number] = [0, 0, 0];
    let yaw = 0;
    if (!isRoot) {
      // C = F_parent⁻¹ · F_i  (pure yaw + translation → node position + rotationY)
      const Fp = frames[p.parentPanelIndex];
      const C = mat4.multiply(mat4.create(), mat4.invert(mat4.create(), Fp) ?? mat4.create(), frames[i]);
      pos = [C[12] * unit, C[13] * unit, C[14] * unit];
      yaw = Math.atan2(-C[2], C[0]);   // col0 = (cos, 0, −sin)
    }
    return {
      geometry: buildPanelLocalGeometry(p, unit),
      pivot: { pos, yaw },
      targetAngleRad: (isRoot ? 0 : p.targetAngle) * DEG2RAD,
      isRoot,
      parentPanelIndex: p.parentPanelIndex,
    };
  });
}

// ── Host-driven node builder ──────────────────────────────────────────────

/** The scene-node hooks box-hierarchy needs. The PackagingHost (ShapeManager adapter) supplies them. */
export interface BoxNodeHost {
  /** Create a container node under `parentNodeId` (root if omitted); `scale` = uniform scale. Returns id. */
  createGroup(name: string, parentNodeId?: string, scale?: number): string;
  /** Create a custom-geometry mesh child under `parentNodeId`. Returns id. */
  createPanelMesh(geometry: MeshGeometry, parentNodeId: string, name: string): string;
  /** Set a node's own local transform (position + Euler rotations). Only the given fields change. */
  setNodeTransform(id: string, t: { pos?: [number, number, number]; rotX?: number; rotY?: number; rotZ?: number }): void;
  /** Swap a panel mesh's geometry in place (in-place re-dimension). Optional (legacy hosts rebuild instead). */
  setPanelGeometry?(meshId: string, geometry: MeshGeometry): void;
  /** Remove a node and its whole subtree. */
  removeNode(id: string): void;
}

export interface PackagingBoxPanel {
  pivotNodeId: string;
  meshId: string;
  pos: [number, number, number];
  yaw: number;
  targetAngleRad: number;
  /** Always local +X — the axis the pivot folds around. */
  hingeAxisLocal: [number, number, number];
}

/** Handle to a built box hierarchy: the root container + per-panel pivot/mesh ids. */
export interface PackagingBox {
  rootGroupId: string;
  panels: PackagingBoxPanel[];
}

/** Build the rigid-panel node hierarchy for a net. Panels start flat (fold 0). */
export function buildBoxNodes(
  panels: FoldPanel[], host: BoxNodeHost, opts: { name?: string; scale?: number } = {},
): PackagingBox {
  // opts.scale is BAKED into geometry + pivot translations (see buildPanelBuilds) — the root group stays
  // scale 1, so no code path's group-scale semantics can un-scale the box.
  const builds = buildPanelBuilds(panels, opts.scale ?? 1);
  const rootGroupId = host.createGroup(opts.name ?? 'Package', undefined, 1);
  const pivotIds: string[] = new Array(panels.length);
  const out: PackagingBoxPanel[] = [];
  for (let i = 0; i < panels.length; i++) {
    const b = builds[i];
    const parentNode = b.isRoot ? rootGroupId : pivotIds[b.parentPanelIndex];
    const pivotId = host.createGroup(panels[i].name + ' Hinge', parentNode, 1);
    host.setNodeTransform(pivotId, { pos: b.pivot.pos, rotY: b.pivot.yaw, rotX: 0 });
    pivotIds[i] = pivotId;
    const meshId = host.createPanelMesh(b.geometry, pivotId, panels[i].name);
    out.push({
      pivotNodeId: pivotId, meshId,
      pos: b.pivot.pos, yaw: b.pivot.yaw, targetAngleRad: b.targetAngleRad,
      hingeAxisLocal: [1, 0, 0],
    });
  }
  return { rootGroupId, panels: out };
}

/** IN-PLACE re-dimension: same panel count/topology → swap each panel's quad geometry + pivot placement
 *  without tearing down the node hierarchy (no outliner churn, no picker/cache evictions, no notification
 *  storm — the W/H/D slider-drag path). Caller re-applies the current fold afterwards. */
export function updateBoxDimensions(
  box: PackagingBox, panels: FoldPanel[], host: BoxNodeHost, opts: { scale?: number } = {},
): boolean {
  if (panels.length !== box.panels.length) return false;   // topology changed → caller rebuilds
  const builds = buildPanelBuilds(panels, opts.scale ?? 1);
  for (let i = 0; i < panels.length; i++) {
    const b = builds[i], p = box.panels[i];
    host.setPanelGeometry?.(p.meshId, b.geometry);
    p.pos = b.pivot.pos; p.yaw = b.pivot.yaw; p.targetAngleRad = b.targetAngleRad;
    host.setNodeTransform(p.pivotNodeId, { pos: b.pivot.pos, rotY: b.pivot.yaw });
  }
  return true;
}

/** Fold to `amount` (0 flat → 1 closed): rotate each non-root pivot around local +X. Transforms only. */
export function setBoxFold(box: PackagingBox, amount: number, host: BoxNodeHost): void {
  const amt = Math.max(0, Math.min(1, amount));
  for (const p of box.panels) {
    if (p.targetAngleRad === 0) continue;   // root / non-folding panels stay put
    host.setNodeTransform(p.pivotNodeId, { pos: p.pos, rotY: p.yaw, rotX: p.targetAngleRad * amt });
  }
}

// ── Correctness helper (used by the test) ─────────────────────────────────

/**
 * Compose the node hierarchy transforms EXACTLY as the Euler scene graph does
 * (each pivot local = T(pos)·Ry(yaw)·Rx(θ), θ = targetAngleRad·amount) and return each panel's
 * 4 corner positions in WORLD/net space. Independent of the scene graph, so the test can assert
 * these equal compileFoldMesh's output vertices. Corner order matches (same winding canon).
 */
export function computeFoldWorldCorners(panels: FoldPanel[], amount: number, unit = 1): [number, number, number][][] {
  const amt = Math.max(0, Math.min(1, amount));
  const builds = buildPanelBuilds(panels, unit);
  const worlds: (mat4 | null)[] = new Array(panels.length).fill(null);
  const worldOf = (i: number): mat4 => {
    const cached = worlds[i];
    if (cached) return cached;
    const b = builds[i];
    let m: mat4;
    if (b.isRoot) {
      m = mat4.create();
    } else {
      const parent = worldOf(b.parentPanelIndex);
      const local = mat4.create();
      mat4.translate(local, local, b.pivot.pos);
      mat4.rotateY(local, local, b.pivot.yaw);
      mat4.rotateX(local, local, b.targetAngleRad * amt);
      m = mat4.multiply(mat4.create(), parent, local);
    }
    worlds[i] = m;
    return m;
  };
  return builds.map((b, i) => {
    const m = worldOf(i);
    const g = b.geometry;
    const n = g.vertices.length / 8;
    const out: [number, number, number][] = [];
    for (let k = 0; k < n; k++) {
      const lp = vec3.fromValues(g.vertices[k * 8], g.vertices[k * 8 + 1], g.vertices[k * 8 + 2]);
      const w = vec3.transformMat4(vec3.create(), lp, m);
      out.push([w[0], w[1], w[2]]);
    }
    return out;
  });
}
