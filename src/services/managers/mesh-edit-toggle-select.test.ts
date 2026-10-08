/**
 * mesh-edit-toggle-select.test.ts — Edit Mesh toggle-off: with Shift held (desktop) or the additive latch on (touch /
 * pen, sm.setAdditiveSelect3D), a click / tap on an ALREADY selected vertex / edge (either half-edge) / face removes it
 * from the selection — on RELEASE without a drag only; a drag from it still moves the selection; a plain click still
 * replaces; a pick on a mirror's copy side toggles the real partner. The section-4 harness (cube, perspective camera,
 * real undo stack).
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
import type { Scene3DManager } from './scene3d-manager';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const W = 800, H = 600;

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

function setup(cameraPos: [number, number, number] = [2.2, 1.8, 3], target: [number, number, number] = [0, 0, 0]) {
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
  const latch = { on: false };
  const c = new MeshEditPointerController(scene3d, meshEdit, (cmd) => undo.push(cmd), () => {}, {
    isAdditive: () => latch.on,
    requestFrame: (cb) => { frames.push(cb); return frames.length; }, cancelFrame: () => {},
  });
  const canvas = fakeCanvas();
  let changes = 0;
  c.attach(canvas, mesh.id, () => { changes++; });
  c.setTool('select');                                               // (no gizmo at the centroid)
  const fire = (type: string, init: Record<string, unknown> = {}) => { const e = ev(type, init); canvas.dispatchEvent(e); return e; };
  const flush = () => { for (let i = 0; i < 4 && frames.length; i++) frames.splice(0).forEach(f => f()); };
  const em = () => mesh.editMesh!;
  const screen = (p: ArrayLike<number>) => project(p[0], p[1], p[2], W, H)!;
  const at = (x: number, y: number, z: number) => screen(vec3.transformMat4(vec3.create(), [x, y, z], mesh.localMatrix as unknown as mat4));
  const faceWhere = (pred: (v: { x: number; y: number; z: number }) => boolean) =>
    em().faces.findIndex((_, fi) => em().getFaceVertices(fi).every(vi => pred(em().vertices[vi])));
  const faceCentre = (fi: number) => { const q = em().getFaceCenter(fi); return at(q[0], q[1], q[2]); };
  const vertexAt = (vi: number) => { const v = em().vertices[vi]; return at(v.x, v.y, v.z); };
  const vertexWhere = (x: number, y: number, z: number) => em().vertices.findIndex(v => v.x === x && v.y === y && v.z === z);
  const sel = () => meshEdit.getSelection(mesh.id)!;
  const pos = () => em().vertices.map(v => [v.x, v.y, v.z]);
  /** A mouse click (press + release, no move) at p. */
  const click = (p: { x: number; y: number }, shiftKey = false) => {
    fire('pointerdown', { clientX: p.x, clientY: p.y, shiftKey });
    fire('pointerup', { clientX: p.x, clientY: p.y, shiftKey });
  };
  /** A finger tap at p. */
  let tid = 20;
  const tap = (p: { x: number; y: number }) => {
    const id = tid++;
    fire('pointerdown', { pointerType: 'touch', pointerId: id, clientX: p.x, clientY: p.y });
    fire('pointerup', { pointerType: 'touch', pointerId: id, clientX: p.x, clientY: p.y });
  };
  return { c, mesh, meshEdit, undo, latch, fire, flush, em, at, faceWhere, faceCentre, vertexAt, vertexWhere, sel, pos, click, tap, changes: () => changes };
}

describe('toggle-off — face / vertex / edge', () => {
  it('face: Shift-click on a selected face removes it (selection-changed fires); on an unselected one adds; a plain click replaces', () => {
    const t = setup();
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0), front = t.faceWhere(v => v.z > 0), right = t.faceWhere(v => v.x > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.selectFace(t.mesh.id, front, true);
    const n0 = t.changes();
    t.click(t.faceCentre(top), true);
    expect([...t.sel().faces]).toEqual([front]);
    expect(t.changes()).toBeGreaterThan(n0);
    t.click(t.faceCentre(right), true);                                // unselected → added
    expect([...t.sel().faces].sort()).toEqual([front, right].sort());
    t.click(t.faceCentre(right), true);                                // and off again
    expect([...t.sel().faces]).toEqual([front]);
    t.click(t.faceCentre(front), true);                                // the last one: nothing selected
    expect(t.sel().faces.size).toBe(0);
    // a plain click (no Shift / latch) replaces, even on a selected face
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.selectFace(t.mesh.id, front, true);
    t.click(t.faceCentre(top));
    expect([...t.sel().faces]).toEqual([top]);
    expect(t.undo.stackSize).toBe(0);
  });

  it('face, touch latch: a tap on a selected face removes it, a tap on an unselected one adds; latch off = replace', () => {
    const t = setup();
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0), front = t.faceWhere(v => v.z > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.latch.on = true;
    t.tap(t.faceCentre(front));
    expect([...t.sel().faces].sort()).toEqual([top, front].sort());
    t.tap(t.faceCentre(top));
    expect([...t.sel().faces]).toEqual([front]);
    t.latch.on = false;
    t.tap(t.faceCentre(top));
    expect([...t.sel().faces]).toEqual([top]);
    t.tap(t.faceCentre(top));                                          // no latch: a re-tap keeps it selected
    expect([...t.sel().faces]).toEqual([top]);
  });

  it('vertex: Shift-click and a latched tap remove a selected vertex; a vertex selected through a face drops out of the vertex set', () => {
    const t = setup();
    t.c.setMode('vertex');
    const top = t.faceWhere(v => v.y > 0);
    const [a, b] = t.em().getFaceVertices(top);
    t.meshEdit.selectVertex(t.mesh.id, a);
    t.meshEdit.selectVertex(t.mesh.id, b, true);
    t.click(t.vertexAt(a), true);
    expect([...t.sel().vertices]).toEqual([b]);
    t.latch.on = true;
    t.tap(t.vertexAt(a));                                              // latched tap on unselected → added
    expect([...t.sel().vertices].sort()).toEqual([a, b].sort());
    t.tap(t.vertexAt(b));
    expect([...t.sel().vertices]).toEqual([a]);
    t.latch.on = false;
    // the top face selected (face mode), then vertex mode: Shift-click a corner → the other three remain
    t.meshEdit.selectFace(t.mesh.id, top);
    t.click(t.vertexAt(a), true);
    expect(t.sel().faces.size).toBe(0);
    expect([...t.sel().vertices].sort()).toEqual(t.em().getFaceVertices(top).filter(v => v !== a).sort());
    expect(t.undo.stackSize).toBe(0);                                  // (a click is not a move)
  });

  it('edge: Shift-click removes the edge whichever half-edge of it was selected', () => {
    const t = setup();
    t.c.setMode('edge');
    const top = t.faceWhere(v => v.y > 0);
    const he = t.em().faces[top].halfEdge;
    const twin = t.em().halfEdges[he].twin;
    expect(twin).toBeGreaterThanOrEqual(0);
    const [ia, ib] = t.em().getHalfEdgeVertices(he)!;
    const A = t.em().vertices[ia], B = t.em().vertices[ib];
    const mid = t.at((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    const picked = t.c.pickElementAt(mid.x, mid.y)!.index;
    expect([he, twin]).toContain(picked);
    const other = picked === he ? twin : he;                           // the half the picker does NOT return
    const he2 = t.em().halfEdges[he].next;                             // another edge of the top face
    t.meshEdit.selectEdge(t.mesh.id, other);
    t.meshEdit.selectEdge(t.mesh.id, he2, true);
    t.click(mid, true);
    expect(t.sel().edges.has(he) || t.sel().edges.has(twin)).toBe(false);
    expect([...t.sel().edges]).toEqual([he2]);
    // the picked half itself selected: toggled off too; then Shift-click adds it back
    t.meshEdit.selectEdge(t.mesh.id, picked, true);
    t.click(mid, true);
    expect([...t.sel().edges]).toEqual([he2]);
    t.click(mid, true);
    expect(t.sel().edges.has(picked)).toBe(true);
  });
});

describe('toggle-off — never on a drag', () => {
  it('Shift-press on a selected face then a drag moves the selection (one step) and keeps every face selected', () => {
    const t = setup();
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0), front = t.faceWhere(v => v.z > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.selectFace(t.mesh.id, front, true);
    const p0 = t.pos();
    const at = t.faceCentre(top);
    t.fire('pointerdown', { clientX: at.x, clientY: at.y, shiftKey: true });
    t.fire('pointermove', { clientX: at.x + 60, clientY: at.y - 20, shiftKey: true });
    t.flush();
    expect(t.c.transform.state()?.source).toBe('drag');
    t.fire('pointerup', { clientX: at.x + 60, clientY: at.y - 20, shiftKey: true });
    expect(t.pos()).not.toEqual(p0);
    expect(t.undo.stackSize).toBe(1);
    expect([...t.sel().faces].sort()).toEqual([top, front].sort());
  });

  it('latched finger drag from a selected vertex moves the selection; the selection is unchanged', () => {
    const t = setup();
    t.c.setMode('vertex');
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    for (const v of verts) t.meshEdit.selectVertex(t.mesh.id, v, true);
    t.latch.on = true;
    const at = t.vertexAt(verts[0]);
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: at.x, clientY: at.y });
    t.fire('pointermove', { pointerType: 'touch', pointerId: 7, clientX: at.x + 40, clientY: at.y });
    t.flush();
    t.fire('pointerup', { pointerType: 'touch', pointerId: 7, clientX: at.x + 40, clientY: at.y });
    expect(t.undo.stackSize).toBe(1);
    expect([...t.sel().vertices].sort()).toEqual([...verts].sort());
  });

  it('drag-moves-selection OFF: a Shift-click still toggles off; a Shift-drag is the old single-vertex drag (still selected)', () => {
    const t = setup();
    t.c.setMode('vertex');
    t.c.dragMovesSelection = false;
    const top = t.faceWhere(v => v.y > 0);
    const [a, b] = t.em().getFaceVertices(top);
    t.meshEdit.selectVertex(t.mesh.id, a);
    t.meshEdit.selectVertex(t.mesh.id, b, true);
    t.click(t.vertexAt(a), true);
    expect([...t.sel().vertices]).toEqual([b]);
    const q0 = t.pos();
    const at = t.vertexAt(b);
    t.fire('pointerdown', { clientX: at.x, clientY: at.y, shiftKey: true });
    t.fire('pointermove', { clientX: at.x + 30, clientY: at.y, shiftKey: true });
    t.flush();
    t.fire('pointerup', { clientX: at.x + 30, clientY: at.y, shiftKey: true });
    expect(t.c.transform.active).toBe(false);
    const q1 = t.pos();
    const changed = q1.map((p, i) => (p.join() !== q0[i].join() ? i : -1)).filter(i => i >= 0);
    expect(changed).toEqual([b]);                                      // only the dragged vertex
    expect([...t.sel().vertices]).toEqual([b]);                        // not toggled by the drag
  });
});

describe('toggle-off — through the mirror copy', () => {
  it('a Shift-click / latched tap on the COPY of a selected vertex / face toggles its real partner', () => {
    const t = setup([3.2, 1.8, 3], [0.3, 0, 0]);
    t.meshEdit.addMirrorFromFace(t.mesh.id, t.faceWhere(v => v.x > 0));   // plane x = 0.5, copy on +X
    t.c.setMode('vertex');
    const v = t.vertexWhere(-0.5, 0.5, 0.5), w = t.vertexWhere(-0.5, 0.5, -0.5);
    t.meshEdit.selectVertex(t.mesh.id, v);
    t.meshEdit.selectVertex(t.mesh.id, w, true);
    const copy = t.at(1.5, 0.5, 0.5);
    expect(t.c.pickElementAt(copy.x, copy.y)).toEqual({ kind: 'vertex', index: v, selected: true });
    t.click(copy, true);
    expect([...t.sel().vertices]).toEqual([w]);
    t.latch.on = true;
    t.tap(copy);                                                       // and back on (a latched tap)
    expect([...t.sel().vertices].sort()).toEqual([v, w].sort());
    t.tap(copy);                                                       // off again
    expect([...t.sel().vertices]).toEqual([w]);
    t.latch.on = false;
    // face: the copy of the -X face is the far +X end
    t.c.setMode('face');
    const fneg = t.faceWhere(q => q.x < 0), top = t.faceWhere(q => q.y > 0);
    t.meshEdit.selectFace(t.mesh.id, fneg);
    t.meshEdit.selectFace(t.mesh.id, top, true);
    t.latch.on = true;
    t.tap(t.at(1.5, 0, 0));
    expect([...t.sel().faces]).toEqual([top]);
    expect(t.undo.stackSize).toBe(1);                                  // only the mirror's step
  });
});
