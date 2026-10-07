/**
 * Edit Mesh region ops (UI review 2026-10-07, docs/specs/edit-mesh-topology.md §12): REGION extrude / inset of
 * connected faces, subdivide of a face set at once, fill EVERY hole, and Bridge Loops independent of the pick order.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as Record<string, unknown> & { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
import { EditMesh } from './edit-mesh';
import { Mesh3D } from './mesh-3d';
import { MeshEditManager } from '../../services/managers/mesh-edit-manager';
import type { ManagerContext } from '../../services/managers/manager-context';
import type { InteractionService } from '../../services/interaction-service';
import type { Command3D } from '../../services/managers/undo-manager-3d';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** Half-edge validity (as edit-mesh-features.test.ts): next / prev inverse, loops close, twins symmetric + reversed,
 *  directed edges unique, every vertex used; `closed` = no boundary half-edge. */
function topologyErrors(em: EditMesh, closed: boolean): string[] {
  const errs: string[] = [];
  const H = em.halfEdges;
  H.forEach((he, hi) => {
    if (H[he.next]?.prev !== hi) errs.push(`he ${hi}: next.prev`);
    if (H[he.prev]?.next !== hi) errs.push(`he ${hi}: prev.next`);
    if (he.twin >= 0) {
      const tw = H[he.twin];
      if (tw.twin !== hi) errs.push(`he ${hi}: twin not symmetric`);
      if (tw.vertex !== H[he.prev].vertex || H[tw.prev].vertex !== he.vertex) errs.push(`he ${hi}: twin not reversed`);
    } else if (closed) errs.push(`he ${hi}: boundary on a closed mesh`);
  });
  em.faces.forEach((f, fi) => {
    let hi = f.halfEdge, n = 0;
    do { if (H[hi].face !== fi) errs.push(`face ${fi}: he ${hi} in another face`); hi = H[hi].next; n++; } while (hi !== f.halfEdge && n <= f.vertexCount);
    if (n !== f.vertexCount) errs.push(`face ${fi}: loop ${n} ≠ vertexCount ${f.vertexCount}`);
  });
  const seen = new Set<string>();
  H.forEach((he) => { const k = `${H[he.prev].vertex},${he.vertex}`; if (seen.has(k)) errs.push(`directed edge ${k} twice`); seen.add(k); });
  const used = new Set(H.map(h => h.vertex));
  em.vertices.forEach((_, vi) => { if (!used.has(vi)) errs.push(`vertex ${vi} unused`); });
  return errs;
}

/** An n × n grid of unit quads in the XZ plane facing +Y; face (i, j) = index j * n + i. */
function grid(n: number): EditMesh {
  const vertices: Array<{ x: number; y: number; z: number }> = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) vertices.push({ x, y: 0, z });
  const V = (x: number, z: number) => z * (n + 1) + x;
  const faces: number[][] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) faces.push([V(i, j), V(i, j + 1), V(i + 1, j + 1), V(i + 1, j)]);
  return EditMesh.fromJSON({ vertices, faces });
}

const pos = (em: EditMesh, vi: number) => [em.vertices[vi].x, em.vertices[vi].y, em.vertices[vi].z].map(c => Math.round(c * 1e6) / 1e6);
const posSet = (em: EditMesh, fi: number) => em.getFaceVertices(fi).map(v => pos(em, v).join(',')).sort();

describe('Edit Mesh — region extrude', () => {
  it('two adjacent faces extrude as one piece: one ring of 6 walls, no wall between them, a welded top', () => {
    const em = grid(3);
    expect(em.getFaceNormal(4)[1]).toBeCloseTo(1);
    const out = em.extrudeRegion([4, 5], 0.5);
    expect(em.vertices.length).toBe(16 + 6);
    expect(em.faces.length).toBe(9 + 6);
    expect(out.slice(0, 2)).toEqual([4, 5]);                 // the tops keep their indices
    expect(topologyErrors(em, false)).toEqual([]);
    // the two tops share their middle edge (twinned), and sit at y = 0.5
    const shared = em.getFaceVertices(4).filter(v => em.getFaceVertices(5).includes(v));
    expect(shared.length).toBe(2);
    for (const fi of [4, 5]) for (const v of em.getFaceVertices(fi)) expect(em.vertices[v].y).toBeCloseTo(0.5);
    const H = em.halfEdges;
    expect(H.filter(h => h.face === 4 && h.twin >= 0 && H[h.twin].face === 5).length).toBe(1);
  });

  it('a 2 × 2 block: the inner vertex moves in place (no unused vertex), 8 walls', () => {
    const em = grid(4);
    em.extrudeRegion([5, 6, 9, 10], 1);
    expect(em.vertices.length).toBe(25 + 8);
    expect(em.faces.length).toBe(16 + 8);
    expect(topologyErrors(em, false)).toEqual([]);
    expect(pos(em, 12)).toEqual([2, 1, 2]);                    // the block's centre vertex, moved up
  });

  it('two faces round a cube edge: the average normal, still a closed manifold', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const top = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[1] > 0.9);
    const front = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[2] > 0.9);
    em.extrudeRegion([top, front], 0.2);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(em.vertices.length - em.halfEdges.length / 2 + em.faces.length).toBe(2);   // Euler: a sphere
    const k = 0.2 / Math.SQRT2;
    for (const v of em.getFaceVertices(top)) expect(em.vertices[v].y).toBeCloseTo(0.5 + k);
  });

  it('one face: exactly the single-face extrude', () => {
    const a = EditMesh.fromBox(1, 1, 1), b = EditMesh.fromBox(1, 1, 1);
    a.extrudeFace(2, 0.3);
    b.extrudeRegion([2], 0.3);
    expect(b.toJSON()).toEqual(a.toJSON());
  });

  it('disjoint faces each extrude along their own normal', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const top = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[1] > 0.9);
    const bottom = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[1] < -0.9);
    em.extrudeRegion([top, bottom], 0.25);
    expect(topologyErrors(em, true)).toEqual([]);
    for (const v of em.getFaceVertices(top)) expect(em.vertices[v].y).toBeCloseTo(0.75);
    for (const v of em.getFaceVertices(bottom)) expect(em.vertices[v].y).toBeCloseTo(-0.75);
  });
});

describe('Edit Mesh — region inset', () => {
  it('a 2 × 2 block gets ONE mitred border; the inner edges stay', () => {
    const em = grid(4);
    em.insetRegion([5, 6, 9, 10], 0.2);
    expect(em.vertices.length).toBe(25 + 8);
    expect(em.faces.length).toBe(16 + 8);
    expect(topologyErrors(em, false)).toEqual([]);
    // the block's corners move diagonally by the border (0.2 = 0.2 × the 1.0 centre-to-outline distance); edge
    // midpoints move straight in; the centre vertex is untouched
    const inner = new Set([5, 6, 9, 10].flatMap(fi => posSet(em, fi)));
    for (const p of ['1.2,0,1.2', '2.8,0,1.2', '1.2,0,2.8', '2.8,0,2.8', '2,0,1.2', '1.2,0,2', '2,0,2']) expect(inner.has(p)).toBe(true);
    expect(posSet(em, 5)).toEqual(['1.2,0,1.2', '1.2,0,2', '2,0,1.2', '2,0,2']);
  });

  it('one face: exactly the single-face inset', () => {
    const a = EditMesh.fromBox(1, 1, 1), b = EditMesh.fromBox(1, 1, 1);
    a.insetFace(3, 0.25);
    b.insetRegion([3], 0.25);
    expect(b.toJSON()).toEqual(a.toJSON());
  });

  it('a cube side band insets as one piece and stays closed', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const sides = em.faces.map((_, fi) => fi).filter(fi => Math.abs(em.getFaceNormal(fi)[1]) < 0.1);
    em.insetRegion(sides, 0.2);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(em.faces.length).toBe(6 + 8);                     // two rings of 4 border quads (top + bottom outlines)
  });
});

describe('Edit Mesh — subdivide a face set', () => {
  it('two adjacent faces share ONE midpoint on their shared edge; neighbours gain the midpoints', () => {
    const em = grid(3);
    em.subdivideFaces([4, 5]);
    expect(em.vertices.length).toBe(16 + 2 + 7);
    expect(em.faces.length).toBe(9 - 2 + 8);
    expect(topologyErrors(em, false)).toEqual([]);
    expect(em.faces.slice(-8).every(f => f.vertexCount === 4)).toBe(true);
  });

  it('one face: exactly subdivideFace', () => {
    const a = grid(3), b = grid(3);
    a.subdivideFace(4);
    b.subdivideFaces([4]);
    expect(b.toJSON()).toEqual(a.toJSON());
  });
});

describe('Edit Mesh — fill holes', () => {
  it('fills EVERY hole at once (closed again), or only the holes touching given vertices', () => {
    const open = () => {
      const em = EditMesh.fromBox(1, 1, 1);
      const top = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[1] > 0.9);
      const bottom = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[1] < -0.9);
      em.deleteFaces(new Set([top, bottom]));
      return em;
    };
    const em = open();
    expect(em.boundaryLoops().length).toBe(2);
    expect(em.fillHoles()).toBe(2);
    expect(em.faces.length).toBe(6);
    expect(topologyErrors(em, true)).toEqual([]);
    for (let fi = 4; fi < 6; fi++) expect(Math.abs(em.getFaceNormal(fi)[1])).toBeCloseTo(1);
    // outward caps: the top cap's normal points up
    const cap = [4, 5].find(fi => em.getFaceCenter(fi)[1] > 0)!;
    expect(em.getFaceNormal(cap)[1]).toBeCloseTo(1);

    const one = open();
    const topLoop = one.boundaryLoops().find(l => one.vertices[l[0]].y > 0)!;
    expect(one.fillHoles(new Set([topLoop[0]]))).toBe(1);
    expect(one.boundaryLoops().length).toBe(1);
    expect(one.fillHoles()).toBe(1);
    expect(topologyErrors(one, true)).toEqual([]);
  });
});

describe('Edit Mesh — bridge loops', () => {
  /** Two unit quads facing away from each other: y = 0 facing −Y, y = 1 facing +Y. */
  function twoQuads(): EditMesh {
    const vertices = [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 },
      { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 1 },
    ];
    return EditMesh.fromJSON({ vertices, faces: [[0, 1, 2, 3], [4, 7, 6, 5]] });
  }

  it('makes a closed box whatever order the vertices were picked in', () => {
    const ref = twoQuads();
    expect(ref.getFaceNormal(0)[1]).toBeCloseTo(-1);
    expect(ref.getFaceNormal(1)[1]).toBeCloseTo(1);
    expect(ref.bridgeVertexLoops([0, 1, 2, 3, 4, 5, 6, 7])).toEqual([2, 3, 4, 5]);
    expect(topologyErrors(ref, true)).toEqual([]);
    // the walls face outward: each side face's normal points away from the box centre
    for (let fi = 2; fi < 6; fi++) {
      const c = ref.getFaceCenter(fi), n = ref.getFaceNormal(fi);
      expect((c[0] - 0.5) * n[0] + (c[1] - 0.5) * n[1] + (c[2] - 0.5) * n[2]).toBeGreaterThan(0.4);
    }
    for (const order of [[7, 0, 5, 2, 6, 1, 4, 3], [3, 2, 1, 0, 7, 6, 5, 4], [6, 4, 2, 0, 1, 3, 5, 7]]) {
      const em = twoQuads();
      expect(em.bridgeVertexLoops(order)).not.toBeNull();
      expect(em.toJSON()).toEqual(ref.toJSON());
    }
  });

  it('refuses vertices that do not form two equal loops', () => {
    const em = twoQuads();
    expect(em.bridgeVertexLoops([0, 1, 2, 3, 4, 5, 6])).toBeNull();
    expect(em.bridgeVertexLoops([0, 1, 2, 3])).toBeNull();
    expect(em.faces.length).toBe(2);
  });
});

describe('MeshEditManager region ops — one undo step, the selection', () => {
  function setup() {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    const cmds: Command3D[] = [];
    const ctx = { sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext;
    const mgr = new MeshEditManager(ctx, (c) => { cmds.push(c); });
    mgr.makeEditable(mesh.id);
    return { mesh, cmds, mgr };
  }

  it('extrudeRegion: the extruded faces stay selected; undo / redo restore the bytes', () => {
    const { mesh, cmds, mgr } = setup();
    expect(mgr.enterEditMode(mesh.id)).toBe(true);
    const em = mesh.editMesh!;
    const top = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[1] > 0.9);
    const front = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[2] > 0.9);
    const before = JSON.stringify(mesh.editMesh!.toJSON());
    expect(mgr.extrudeRegion(mesh.id, [top, front], 0.2)).toBe(true);
    expect(cmds.length).toBe(1);
    expect([...mgr.getSelection(mesh.id)!.faces].sort()).toEqual([top, front].sort());
    const after = JSON.stringify(mesh.editMesh!.toJSON());
    cmds[0].undo();
    expect(JSON.stringify(mesh.editMesh!.toJSON())).toBe(before);
    cmds[0].redo();
    expect(JSON.stringify(mesh.editMesh!.toJSON())).toBe(after);
  });

  it('fillHoles with a selected hole vertex fills only that hole; nothing to fill = no undo step', () => {
    const { mesh, cmds, mgr } = setup();
    mgr.enterEditMode(mesh.id);
    const em = mesh.editMesh!;
    const top = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[1] > 0.9);
    const bottom = em.faces.findIndex((_, fi) => em.getFaceNormal(fi)[1] < -0.9);
    mgr.deleteFaces(mesh.id, new Set([top, bottom]));
    const loops = mesh.editMesh!.boundaryLoops();
    mgr.selectVertex(mesh.id, loops[0][0], false);
    expect(mgr.fillHoles(mesh.id)).toBe(1);
    expect(mgr.fillHoles(mesh.id)).toBe(1);                  // the selection was cleared: the other hole
    const n = cmds.length;
    expect(mgr.fillHoles(mesh.id)).toBe(0);
    expect(cmds.length).toBe(n);
  });
});
