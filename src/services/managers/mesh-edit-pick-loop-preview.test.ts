/**
 * mesh-edit-pick-loop-preview.test.ts — the next Edit Mesh batch (docs/reviews/next-edit-mesh-batch-2026-10-08.md),
 * engine side of items 1, 2 and 4:
 *  1. edge picking measures to the projected SEGMENT (a tap near an edge's end reaches it), edges facing the camera
 *     win over hidden ones (a hidden edge behind the surface under the pointer is not picked; an open sheet seen from
 *     the back keeps its edges), the mirror copy still picks its real partner;
 *  2. Loop Cut: a press anywhere on a face → that face's edge nearest the pointer decides the ring, sliding sets the
 *     position along it, the lift cuts (one step); a 2nd finger / pointercancel / Esc cancel; off the mesh = the camera's;
 *  4. live op preview: cancelLastOp (no step, no redo), and while opPreview is on a tap re-targets the op against the
 *     mesh BEFORE it (one step), drags of the selection don't move it, the selection gizmo hides.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { mat4, vec3 } from 'gl-matrix';
import { MeshEditPointerController } from './mesh-edit-pointer-controller';
import { MeshEditManager } from './mesh-edit-manager';
import { UndoManager3D } from './undo-manager-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { isPointerEventClaimed } from '../../renderer/util/pointer-claims';
import type { Scene3DManager } from './scene3d-manager';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const W = 800, H = 600;
type P3 = [number, number, number];

function fakeCanvas(): HTMLCanvasElement {
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: {}, width: W, height: H,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  });
  return el as unknown as HTMLCanvasElement;
}

function ev(type: string, init: Record<string, unknown>): Event {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0, shiftKey: false, ctrlKey: false, ...init });
  return e;
}

/** A unit cube in Edit Mesh (a perspective camera, a REAL undo stack) — the section-4 harness. */
function setup(cameraPos: P3 = [2.2, 1.8, 3], target: P3 = [0, 0, 0]) {
  const camera = new Camera3D({ position: cameraPos, target, mode: 'perspective' });
  camera.aspect = W / H;
  const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
  const undo = new UndoManager3D();
  const ctx = { sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext;
  const meshEdit = new MeshEditManager(ctx, (cmd) => undo.push(cmd), { peek: () => undo.peekUndo(), discardTop: () => undo.discardUndoTop() });
  meshEdit.makeEditable(mesh.id);
  meshEdit.enterEditMode(mesh.id);
  const project = (x: number, y: number, z: number, w: number, h: number) => {
    const m = camera.getViewProjectionMatrix() as unknown as Float32Array;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0) return null;
    return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) * 0.5 * w, y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5 * h, depth: 0.5 };
  };
  const scene3d = {
    getMesh: (id: string) => (id === mesh.id ? mesh : null), getCamera: () => camera, getTouchNavigate3D: () => false,
    getGizmoOrientation: () => 'world', projectWorldToScreen3D: project,
    unprojectScreenToWorld3D: (sx: number, sy: number) => ({ x: sx / 100, y: -sy / 100, z: 0 }),
    patchMeshVertices3D: () => true, patchMeshIndices3D: () => true, noteMeshVerticesMoved3D: () => {},
  } as unknown as Scene3DManager;
  const frames: Array<() => void> = [];
  const c = new MeshEditPointerController(scene3d, meshEdit, (cmd) => undo.push(cmd), () => {}, {
    requestFrame: (cb) => { frames.push(cb); return frames.length; }, cancelFrame: () => {},
  });
  const canvas = fakeCanvas();
  c.attach(canvas, mesh.id);
  const fire = (type: string, init: Record<string, unknown> = {}) => { const e = ev(type, init); canvas.dispatchEvent(e); return e; };
  const flush = () => { for (let i = 0; i < 4 && frames.length; i++) frames.splice(0).forEach(f => f()); };
  const em = () => mesh.editMesh!;
  const toWorld = (p: ArrayLike<number>) => vec3.transformMat4(vec3.create(), [p[0], p[1], p[2]], mesh.localMatrix as unknown as mat4);
  /** Object-space point → canvas px. */
  const at = (x: number, y: number, z: number) => project(...(Array.from(toWorld([x, y, z])) as P3), W, H)!;
  const faceWhere = (pred: (v: { x: number; y: number; z: number }) => boolean) =>
    em().faces.findIndex((_, fi) => em().getFaceVertices(fi).every(vi => pred(em().vertices[vi])));
  const vertexWhere = (x: number, y: number, z: number) => em().vertices.findIndex(v => v.x === x && v.y === y && v.z === z);
  const endsOf = (he: number) => em().getHalfEdgeVertices(he)!.map(i => { const v = em().vertices[i]; return [v.x, v.y, v.z]; });
  const pos = () => em().vertices.map(v => [v.x, v.y, v.z]);
  return { c, mesh, meshEdit, undo, camera, fire, flush, em, at, faceWhere, vertexWhere, endsOf, pos };
}

/** Screen distance from point p to segment a–b. */
function segDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / L2)) : 0;
  return Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y);
}
const sameEdge = (ends: number[][], a: number[], b: number[]) =>
  (ends[0].join() === a.join() && ends[1].join() === b.join()) || (ends[0].join() === b.join() && ends[1].join() === a.join());

describe('1 — edge picking along the whole edge', () => {
  it('a tap near an edge END (far from its midpoint) picks that edge; mouse and finger', () => {
    const t = setup();
    t.c.setMode('edge');
    const A: P3 = [-0.5, 0.5, 0.5], B: P3 = [0.5, 0.5, 0.5];   // the top-front edge
    const sa = t.at(...A), sb = t.at(...B), mid = t.at(0, 0.5, 0.5);
    // 18 px along the edge from A, 3 px off it
    const L = Math.hypot(sb.x - sa.x, sb.y - sa.y), ux = (sb.x - sa.x) / L, uy = (sb.y - sa.y) / L;
    const p = { x: sa.x + ux * 18 - uy * 3, y: sa.y + uy * 18 + ux * 3 };
    expect(Math.hypot(p.x - mid.x, p.y - mid.y)).toBeGreaterThan(40);   // the old midpoint-only pick missed this
    const hit = t.c.pickElementAt(p.x, p.y)!;
    expect(hit.kind).toBe('edge');
    expect(sameEdge(t.endsOf(hit.index), A, B)).toBe(true);
    // a finger (×2 radius) a little further off still gets it
    const q = { x: sa.x + ux * 25 - uy * 12, y: sa.y + uy * 25 + ux * 12 };
    expect(t.c.pickElementAt(q.x, q.y)).toBeNull();
    expect(sameEdge(t.endsOf(t.c.pickElementAt(q.x, q.y, true)!.index), A, B)).toBe(true);
    // the tap selects it too
    t.fire('pointerdown', { clientX: p.x, clientY: p.y });
    t.fire('pointerup', { clientX: p.x, clientY: p.y });
    const sel = [...t.meshEdit.getSelection(t.mesh.id)!.edges];
    expect(sel).toHaveLength(1);
    expect(sameEdge(t.endsOf(sel[0]), A, B)).toBe(true);
  });

  it('hidden edges (every face turned away) lose to facing ones, and are not picked behind the surface', () => {
    const t = setup();
    t.c.setMode('edge');
    const em = t.em(), H2 = em.halfEdges;
    const eye = t.camera.position;
    const faces = (hi: number) => [H2[hi].face, H2[hi].twin >= 0 ? H2[H2[hi].twin].face : -1].filter(f => f >= 0);
    const facing = (f: number) => { const n = em.getFaceNormal(f), c = em.getFaceCenter(f); return n[0] * (c[0] - eye[0]) + n[1] * (c[1] - eye[1]) + n[2] * (c[2] - eye[2]) < 0; };
    const edges: number[] = [];
    for (let hi = 0; hi < H2.length; hi++) if (H2[hi].twin < 0 || hi < H2[hi].twin) edges.push(hi);
    const hidden = edges.filter(hi => !faces(hi).some(facing)), front = edges.filter(hi => faces(hi).some(facing));
    expect(hidden).toHaveLength(3);                                   // the three edges at the far corner
    const scr = (hi: number) => { const [a, b] = t.endsOf(hi); return [t.at(a[0], a[1], a[2]), t.at(b[0], b[1], b[2])]; };
    // (a) on a hidden edge where no facing edge is in reach: nothing (the front faces cover it)
    let tested = 0, preferred = 0;
    for (const hi of hidden) {
      const [a, b] = scr(hi);
      for (let k = 1; k < 20; k++) {
        const p = { x: a.x + (b.x - a.x) * k / 20, y: a.y + (b.y - a.y) * k / 20 };
        const nearFront = Math.min(...front.map(f => { const [fa, fb] = scr(f); return segDist(p, fa, fb); }));
        const hit = t.c.pickElementAt(p.x, p.y);
        if (nearFront >= 10) { expect(hit).toBeNull(); tested++; }
        else if (nearFront > 0.5) {
          // (b) a facing edge in reach — though the hidden one is nearer (0 px): the facing edge wins
          expect(hit).not.toBeNull();
          expect(hidden).not.toContain(hit!.index);
          preferred++;
        }
      }
    }
    expect(tested).toBeGreaterThan(5);
    expect(preferred).toBeGreaterThan(0);
  });

  it('an open box seen from behind its faces: those edges stay pickable (nothing in front of them)', () => {
    const t = setup([0, 0, 3]);
    t.c.setMode('edge');
    const back: [P3, P3] = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5]];   // the bottom edge of the back (-Z) face
    const p = t.at(0, -0.5, -0.5);
    // closed: the +Z face is in front of it → not picked
    expect(t.c.pickElementAt(p.x, p.y)).toBeNull();
    // the +Z face deleted: the back edge (both its faces turned away) is seen through the hole → picked
    t.meshEdit.deleteFaces(t.mesh.id, new Set([t.faceWhere(v => v.z > 0)]));
    const hit = t.c.pickElementAt(p.x, p.y)!;
    expect(hit).not.toBeNull();
    expect(sameEdge(t.endsOf(hit.index), back[0], back[1])).toBe(true);
  });

  it('a mirror copy: a tap near the END of a copy edge picks its real partner', () => {
    const t = setup([3.2, 1.8, 3], [0.3, 0, 0]);
    t.meshEdit.addMirrorFromFace(t.mesh.id, t.faceWhere(v => v.x > 0));   // plane x = 0.5, copy on +X
    t.c.setMode('edge');
    // the copy of the edge (-0.5, 0.5, -0.5)–(-0.5, 0.5, 0.5) runs at x = 1.5; tap near its +Z end, off the midpoint
    const p = t.at(1.5, 0.5, 0.38), mid = t.at(1.5, 0.5, 0);
    expect(Math.hypot(p.x - mid.x, p.y - mid.y)).toBeGreaterThan(25);
    const hit = t.c.pickElementAt(p.x, p.y)!;
    expect(sameEdge(t.endsOf(hit.index), [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5])).toBe(true);
  });
});

describe('2 — Loop Cut: press anywhere on a face', () => {
  /** The x (or y) of the cut's new vertices. */
  const newVerts = (t: ReturnType<typeof setup>, n0: number) => t.em().vertices.slice(n0).map(v => [v.x, v.y, v.z]);

  it('mouse: a press inside the front face near its top edge → that ring; dragging slides the cut; release cuts (one step)', () => {
    const t = setup();
    t.c.setTool('loopcut');
    const p0 = t.at(0.1, 0.45, 0.5);                                // inside the front face, nearest its top edge
    t.fire('pointerdown', { clientX: p0.x, clientY: p0.y });
    let g = t.c.guideLines()!;
    expect(g.length).toBe(4 * 6);                                   // 4 quads × 1 cut
    // the preview lines cross the x-direction edges at the pointer's x
    for (let i = 0; i < g.length; i += 3) expect(g[i]).toBeCloseTo(0.1, 1);
    // slide: the same ring, the position follows the pointer (its projection onto the edge)
    const p1 = t.at(-0.3, 0.46, 0.5);
    t.fire('pointermove', { clientX: p1.x, clientY: p1.y });
    t.flush();
    g = t.c.guideLines()!;
    expect(g.length).toBe(4 * 6);
    for (let i = 0; i < g.length; i += 3) expect(g[i]).toBeCloseTo(-0.3, 1);
    expect(t.undo.stackSize).toBe(0);
    t.fire('pointerup', { clientX: p1.x, clientY: p1.y });
    expect(t.em().vertices.length).toBe(12);
    const added = newVerts(t, 8);
    for (const v of added) expect(v[0]).toBeCloseTo(-0.3, 1);       // the cut at the release position
    expect(added.every(v => Math.abs(v[0] - added[0][0]) < 1e-9)).toBe(true);
    expect(t.undo.stackSize).toBe(1);
    expect(t.meshEdit.getLastOp()!.op).toBe('loopCut');
  });

  it('the face edge nearest the pointer decides: near the left edge → the vertical ring; hover previews the same', () => {
    const t = setup();
    t.c.setTool('loopcut');
    const p = t.at(-0.45, -0.2, 0.5);                               // inside the front face, nearest its left edge
    t.fire('pointermove', { clientX: p.x, clientY: p.y });          // mouse hover
    t.flush();
    const g = t.c.guideLines()!;
    expect(g.length).toBe(4 * 6);
    for (let i = 1; i < g.length; i += 3) expect(g[i]).toBeCloseTo(-0.2, 1);   // cut at y ≈ -0.2
    t.fire('pointerdown', { clientX: p.x, clientY: p.y });
    t.fire('pointerup', { clientX: p.x, clientY: p.y });            // a click cuts
    const added = newVerts(t, 8);
    expect(added).toHaveLength(4);
    for (const v of added) expect(v[1]).toBeCloseTo(-0.2, 1);
    expect(t.undo.stackSize).toBe(1);
  });

  it('touch: the finger previews, slides, lifts = cut; a 2nd finger / pointercancel / Esc cancel; off the mesh = the camera', () => {
    const t = setup();
    t.c.setTool('loopcut');
    t.c.loopCutCount = 2;
    const touch = { pointerType: 'touch' };
    const p = t.at(0, 0.3, 0.5);
    // a 2nd finger cancels
    let d = t.fire('pointerdown', { ...touch, pointerId: 3, clientX: p.x, clientY: p.y });
    expect(isPointerEventClaimed(d)).toBe(true);
    expect(t.c.guideLines()!.length).toBe(4 * 2 * 6);
    t.fire('pointerdown', { ...touch, pointerId: 4, isPrimary: false, clientX: 50, clientY: 50 });
    expect(t.c.guideLines()).toBeNull();
    t.fire('pointerup', { ...touch, pointerId: 4 });
    t.fire('pointerup', { ...touch, pointerId: 3, clientX: p.x, clientY: p.y });
    expect(t.em().vertices.length).toBe(8);
    // pointercancel cancels
    t.fire('pointerdown', { ...touch, pointerId: 5, clientX: p.x, clientY: p.y });
    t.fire('pointercancel', { ...touch, pointerId: 5 });
    t.fire('pointerup', { ...touch, pointerId: 5, clientX: p.x, clientY: p.y });
    expect(t.em().vertices.length).toBe(8);
    // Esc (the host: cancelMeshEditLoopCut3D) cancels
    t.fire('pointerdown', { ...touch, pointerId: 6, clientX: p.x, clientY: p.y });
    expect(t.c.cancelLoopCutPress()).toBe(true);
    expect(t.c.cancelLoopCutPress()).toBe(false);
    t.fire('pointerup', { ...touch, pointerId: 6, clientX: p.x, clientY: p.y });
    expect(t.em().vertices.length).toBe(8);
    expect(t.undo.stackSize).toBe(0);
    // off the mesh: not claimed (the drag orbits), nothing previews or cuts
    d = t.fire('pointerdown', { ...touch, pointerId: 7, clientX: 5, clientY: 5 });
    expect(isPointerEventClaimed(d)).toBe(false);
    expect(t.c.guideLines()).toBeNull();
    t.fire('pointerup', { ...touch, pointerId: 7, clientX: 5, clientY: 5 });
    // a lift on the mesh cuts (count from the tool: 2 cuts)
    t.fire('pointerdown', { ...touch, pointerId: 8, clientX: p.x, clientY: p.y });
    t.fire('pointerup', { ...touch, pointerId: 8, clientX: p.x, clientY: p.y });
    expect(t.em().vertices.length).toBe(16);
    expect(t.undo.stackSize).toBe(1);
  });
});

describe('4 — live op preview (engine side)', () => {
  it('cancelLastOp: the mesh and the selection exactly back, NO undo step and no redo entry', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    const p0 = t.pos(), geom0 = Array.from(t.mesh.geometry!.vertices);
    expect(t.meshEdit.extrudeRegion(t.mesh.id, null, 0.3)).toBe(true);
    expect(t.meshEdit.redoLastOp({ distance: 0.5 })).toBe(true);
    expect(t.undo.stackSize).toBe(1);
    expect(t.meshEdit.cancelLastOp()).toBe(true);
    expect(t.pos()).toEqual(p0);
    expect(Array.from(t.mesh.geometry!.vertices)).toEqual(geom0);
    expect(t.undo.stackSize).toBe(0);
    expect(t.undo.canRedo).toBe(false);
    expect([...t.meshEdit.getSelection(t.mesh.id)!.faces]).toEqual([top]);
    expect(t.meshEdit.getLastOp()).toBeNull();
    expect(t.meshEdit.cancelLastOp()).toBe(false);
    // a re-run that changed nothing (no step): cancel still restores the selection, leaves the earlier steps alone
    t.meshEdit.moveVertex(t.mesh.id, 0, 0.01, 0, 0);
    expect(t.undo.stackSize).toBe(1);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.insetRegion(t.mesh.id, null, 0.2);
    t.meshEdit.redoLastOp({ amount: 0 });
    expect(t.undo.stackSize).toBe(1);
    expect(t.meshEdit.cancelLastOp()).toBe(true);
    expect(t.undo.stackSize).toBe(1);
    expect(t.em().vertices.length).toBe(8);
  });

  it('opPreview: a tap re-targets the op, resolved against the mesh BEFORE it — still one step', () => {
    const t = setup();
    t.c.setTool('extrude');
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0), front = t.faceWhere(v => v.z > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.extrudeRegion(t.mesh.id, null, 0.5);
    t.c.opPreview = true;
    expect(t.em().vertices.length).toBe(12);
    // a point that is the new front WALL in the preview — but the top face of the original cube
    const p = t.at(0.2, 0.6, 0.5);
    t.fire('pointerdown', { clientX: p.x, clientY: p.y });
    t.fire('pointerup', { clientX: p.x, clientY: p.y });
    expect(t.em().vertices.length).toBe(12);                         // the TOP extruded again (a wall would be 16)
    expect(t.undo.stackSize).toBe(1);
    expect(t.meshEdit.getLastOp()).toEqual({ op: 'extrudeRegion', params: { distance: 0.5 } });
    // the front face: the preview moves there (the top goes back)
    const f = t.at(0, -0.1, 0.5);
    t.fire('pointerdown', { clientX: f.x, clientY: f.y });
    t.fire('pointerup', { clientX: f.x, clientY: f.y });
    expect(t.em().vertices.length).toBe(12);
    expect(t.em().vertices.filter(v => Math.abs(v.z - 1) < 1e-9)).toHaveLength(4);   // the front pushed out to z = 1
    expect(t.em().vertices.every(v => v.y <= 0.5 + 1e-9)).toBe(true);                 // the top is back
    expect(t.undo.stackSize).toBe(1);
    // Shift (additive): top + front together, one region
    const p2 = t.at(0.2, 0.5, 0);
    t.fire('pointerdown', { clientX: p2.x, clientY: p2.y, shiftKey: true });
    t.fire('pointerup', { clientX: p2.x, clientY: p2.y, shiftKey: true });
    expect(t.em().vertices.length).toBe(14);
    expect(t.undo.stackSize).toBe(1);
    // undo: the original cube
    t.undo.undo();
    expect(t.em().vertices.length).toBe(8);
    expect(t.em().faces.length).toBe(6);
    void front;
  });

  it('opPreview: a drag from the selection orbits (not claimed, nothing moves); the selection gizmo hides', () => {
    const t = setup();
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    expect(t.c.gizmoDrawData()).not.toBeNull();                      // (tool 'move': the gizmo)
    t.meshEdit.extrudeRegion(t.mesh.id, null, 0.3);
    t.c.opPreview = true;
    expect(t.c.gizmoDrawData()).toBeNull();
    const p0 = t.pos();
    const at = t.at(0, 0.8, 0);                                      // the extruded (selected) top
    const pen = { pointerType: 'pen', pointerId: 9 };
    const d = t.fire('pointerdown', { ...pen, clientX: at.x, clientY: at.y });
    expect(isPointerEventClaimed(d)).toBe(false);
    t.fire('pointermove', { ...pen, clientX: at.x + 40, clientY: at.y });
    t.flush();
    t.fire('pointerup', { ...pen, clientX: at.x + 40, clientY: at.y });
    expect(t.c.transform.active).toBe(false);
    expect(t.pos()).toEqual(p0);
    expect(t.undo.stackSize).toBe(1);
    t.c.detach();
    expect(t.c.opPreview).toBe(false);                               // leaving Edit Mesh turns it off
  });
});
