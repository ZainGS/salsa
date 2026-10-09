/**
 * mesh-edit-section4.test.ts — the Edit Mesh redesign's engine side (UI review 2026-10-07 §4,
 * docs/reviews/section4-engine-api.md):
 *  - A: a one-finger / mouse drag that starts ON the selection moves it on the view plane (one undo step; a 2nd finger /
 *       right click cancels; a click without a drag still selects; elsewhere the old behaviour);
 *  - B: pickElementAt (vertex / edge / face + the selected flag);
 *  - D: the tool strip (gizmo per tool), the Knife tool (taps → apply = one step), the Loop Cut tool (click an edge);
 *  - E: adjust last operation — the op's step is REPLACED (net one step), params applied, cleared by any other edit.
 */
import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { mat4, vec3 } from 'gl-matrix';
import { MeshEditPointerController } from './mesh-edit-pointer-controller';
import { MeshEditManager } from './mesh-edit-manager';
import { UndoManager3D } from './undo-manager-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { isPointerEventClaimed } from '../../renderer/util/pointer-claims';
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

/** A cube in Edit Mesh, a perspective camera from the front-right-above, a REAL undo stack. */
function setup() {
  const camera = new Camera3D({ position: [2.2, 1.8, 3], target: [0, 0, 0], mode: 'perspective' });
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
  const screen = (p: ArrayLike<number>) => project(p[0], p[1], p[2], W, H)!;
  const toWorld = (p: { x: number; y: number; z: number }) => vec3.transformMat4(vec3.create(), [p.x, p.y, p.z], mesh.localMatrix as unknown as mat4);
  const faceWhere = (pred: (v: { x: number; y: number; z: number }) => boolean) =>
    em().faces.findIndex((_, fi) => em().getFaceVertices(fi).every(vi => pred(em().vertices[vi])));
  const faceCentre = (fi: number) => screen(toWorld(Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, em().getFaceCenter(fi)[i]])) as { x: number; y: number; z: number }));
  const vertexAt = (vi: number) => screen(toWorld(em().vertices[vi]));
  const pos = () => em().vertices.map(v => [v.x, v.y, v.z]);
  return { c, mesh, meshEdit, undo, camera, fire, flush, em, screen, toWorld, faceWhere, faceCentre, vertexAt, pos };
}

describe('A — drag on the selection moves it (setMeshEditDragMovesSelection3D)', () => {
  it('mouse: a drag starting on a selected face moves the WHOLE selection on the view plane; release = ONE undo step', () => {
    const t = setup();
    t.c.setTool('select');                                         // (no gizmo at the centroid)
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0), front = t.faceWhere(v => v.z > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.selectFace(t.mesh.id, front, true);
    const p0 = t.pos();
    const moving = t.meshEdit.selectedVertexIndices(t.mesh.id);
    expect(moving).toHaveLength(6);
    const at = t.faceCentre(top);
    t.fire('pointerdown', { clientX: at.x, clientY: at.y });
    expect(t.c.isBusy).toBe(true);
    expect(t.pos()).toEqual(p0);                                    // nothing moves on the press
    t.fire('pointermove', { clientX: at.x + 2, clientY: at.y });     // inside the slop: still a click
    expect(t.c.transform.active).toBe(false);
    t.fire('pointermove', { clientX: at.x + 60, clientY: at.y - 20 });
    t.flush();
    expect(t.c.transform.state()?.source).toBe('drag');
    const p1 = t.pos();
    // the selection moved by ONE world delta; every other vertex is bit-identical
    const d = [p1[moving[0]][0] - p0[moving[0]][0], p1[moving[0]][1] - p0[moving[0]][1], p1[moving[0]][2] - p0[moving[0]][2]];
    expect(Math.hypot(d[0], d[1], d[2])).toBeGreaterThan(0.05);
    for (let i = 0; i < p0.length; i++) {
      if (moving.includes(i)) for (let k = 0; k < 3; k++) expect(p1[i][k] - p0[i][k]).toBeCloseTo(d[k], 9);
      else expect(p1[i]).toEqual(p0[i]);
    }
    // on the camera-facing plane through the pivot: the move is perpendicular to pivot → eye
    const piv = t.c.transform.state()!.pivot;
    const view = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), t.camera.position as unknown as vec3, piv as unknown as vec3));
    expect(Math.abs(vec3.dot(view, d as unknown as vec3))).toBeLessThan(1e-6);
    t.fire('pointerup', { clientX: at.x + 60, clientY: at.y - 20 });
    expect(t.c.transform.active).toBe(false);
    expect(t.undo.stackSize).toBe(1);
    expect(t.undo.undoDescription).toBe('Move elements');
    expect([...t.meshEdit.getSelection(t.mesh.id)!.faces].sort()).toEqual([top, front].sort());   // selection kept
    t.undo.undo();
    expect(t.pos()).toEqual(p0);
  });

  it('mouse: a click (no drag) on a selected face selects it alone; a right click mid-drag cancels exactly', () => {
    const t = setup();
    t.c.setTool('select');
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0), front = t.faceWhere(v => v.z > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.selectFace(t.mesh.id, front, true);
    const at = t.faceCentre(top);
    t.fire('pointerdown', { clientX: at.x, clientY: at.y });
    t.fire('pointerup', { clientX: at.x, clientY: at.y });
    expect([...t.meshEdit.getSelection(t.mesh.id)!.faces]).toEqual([top]);
    expect(t.undo.stackSize).toBe(0);
    // drag, then a right click: everything back, no step
    const p0 = t.pos(), bytes0 = Array.from(t.mesh.geometry!.vertices);
    t.fire('pointerdown', { clientX: at.x, clientY: at.y });
    t.fire('pointermove', { clientX: at.x + 50, clientY: at.y + 30 });
    t.flush();
    expect(t.pos()).not.toEqual(p0);
    const rc = t.fire('pointerdown', { button: 2, pointerId: 1, clientX: at.x + 50, clientY: at.y + 30 });
    expect(rc.defaultPrevented).toBe(true);
    expect(t.c.transform.active).toBe(false);
    expect(t.pos()).toEqual(p0);
    expect(Array.from(t.mesh.geometry!.vertices)).toEqual(bytes0);
    expect(t.undo.stackSize).toBe(0);
  });

  it('touch: a finger drag from a selected vertex moves the selection; a 2nd finger cancels; off the selection = old behaviour', () => {
    const t = setup();
    t.c.setTool('select');
    t.c.setMode('vertex');
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    for (const v of verts) t.meshEdit.selectVertex(t.mesh.id, v, true);
    const p0 = t.pos();
    const at = t.vertexAt(verts[0]);
    const touch = { pointerType: 'touch', pointerId: 7 };
    t.fire('pointerdown', { ...touch, clientX: at.x, clientY: at.y });
    t.fire('pointermove', { ...touch, clientX: at.x + 40, clientY: at.y });
    t.flush();
    expect(t.c.transform.state()?.source).toBe('drag');
    const p1 = t.pos();
    for (const v of verts) expect(p1[v]).not.toEqual(p0[v]);       // all four selected vertices moved together
    // a second finger: cancelled, exactly restored, no step
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 8, isPrimary: false, clientX: 100, clientY: 100 });
    expect(t.c.transform.active).toBe(false);
    expect(t.pos()).toEqual(p0);
    expect(t.undo.stackSize).toBe(0);
    t.fire('pointerup', { pointerType: 'touch', pointerId: 8 });
    t.fire('pointerup', { ...touch });
    // a drag again → lift = one step
    t.fire('pointerdown', { ...touch, pointerId: 9, clientX: at.x, clientY: at.y });
    t.fire('pointermove', { ...touch, pointerId: 9, clientX: at.x, clientY: at.y + 40 });
    t.flush();
    t.fire('pointerup', { ...touch, pointerId: 9, clientX: at.x, clientY: at.y + 40 });
    expect(t.undo.stackSize).toBe(1);
    // the toggle off: a finger drag from the (selected) vertex is the old single-vertex drag
    t.c.dragMovesSelection = false;
    const q0 = t.pos();
    t.fire('pointerdown', { ...touch, pointerId: 10, clientX: at.x, clientY: at.y + 40 });
    t.fire('pointermove', { ...touch, pointerId: 10, clientX: at.x + 30, clientY: at.y + 40 });
    t.flush();
    expect(t.c.transform.active).toBe(false);
    const q1 = t.pos();
    const changed = q1.map((p, i) => (p.join() !== q0[i].join() ? i : -1)).filter(i => i >= 0);
    expect(changed).toEqual([verts[0]]);                           // only the dragged vertex
  });
});

describe('A2 — pen / finger: drags of the selection are the tool’s (claimed), any other drag the camera’s', () => {
  it('pen: a drag from the selection moves it (claimed, one step); a drag from an unselected vertex is not claimed and moves nothing', () => {
    const t = setup();
    t.c.setTool('select');
    t.c.setMode('vertex');
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectVertex(t.mesh.id, verts[0]);
    const p0 = t.pos();
    const at = t.vertexAt(verts[0]);
    const pen = { pointerType: 'pen', pointerId: 3 };
    const down = t.fire('pointerdown', { ...pen, clientX: at.x, clientY: at.y });
    expect(isPointerEventClaimed(down)).toBe(true);
    t.fire('pointermove', { ...pen, clientX: at.x + 40, clientY: at.y });
    t.flush();
    expect(t.c.transform.state()?.source).toBe('drag');
    t.fire('pointerup', { ...pen, clientX: at.x + 40, clientY: at.y });
    expect(t.pos()[verts[0]]).not.toEqual(p0[verts[0]]);
    expect(t.undo.stackSize).toBe(1);
    // an unselected vertex: the press waits unclaimed, the drag leaves the mesh alone
    const q0 = t.pos();
    const other = t.vertexAt(verts[2]);
    const down2 = t.fire('pointerdown', { ...pen, pointerId: 4, clientX: other.x, clientY: other.y });
    expect(isPointerEventClaimed(down2)).toBe(false);
    t.fire('pointermove', { ...pen, pointerId: 4, clientX: other.x + 40, clientY: other.y });
    t.flush();
    t.fire('pointerup', { ...pen, pointerId: 4, clientX: other.x + 40, clientY: other.y });
    expect(t.pos()).toEqual(q0);
    expect(t.c.transform.active).toBe(false);
    expect([...(t.meshEdit.getSelection(t.mesh.id)?.vertices ?? [])]).toEqual([verts[0]]);
    expect(t.undo.stackSize).toBe(1);
  });

  it('finger: pointercancel restores a drag of the selection exactly (no step)', () => {
    const t = setup();
    t.c.setTool('select');
    t.c.setMode('vertex');
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectVertex(t.mesh.id, verts[0]);
    const p0 = t.pos();
    const at = t.vertexAt(verts[0]);
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 5, clientX: at.x, clientY: at.y });
    t.fire('pointermove', { pointerType: 'touch', pointerId: 5, clientX: at.x + 40, clientY: at.y });
    t.flush();
    expect(t.pos()).not.toEqual(p0);
    t.fire('pointercancel', { pointerType: 'touch', pointerId: 5 });
    expect(t.pos()).toEqual(p0);
    expect(t.undo.stackSize).toBe(0);
  });

  it('the host Pan tool: presses are ignored (no select, no drag) while it is on', () => {
    const t = setup();
    let pan = true;
    (t.c as unknown as { _scene3d: Record<string, unknown> })._scene3d.isEditPanTool3D = () => pan;
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0);
    const at = t.faceCentre(top);
    for (const pointerType of ['mouse', 'pen', 'touch']) {
      t.fire('pointerdown', { pointerType, clientX: at.x, clientY: at.y });
      t.fire('pointerup', { pointerType, clientX: at.x, clientY: at.y });
    }
    expect(t.meshEdit.getSelection(t.mesh.id)?.faces.size ?? 0).toBe(0);
    pan = false;
    t.fire('pointerdown', { clientX: at.x, clientY: at.y });
    t.fire('pointerup', { clientX: at.x, clientY: at.y });
    expect([...(t.meshEdit.getSelection(t.mesh.id)?.faces ?? [])]).toEqual([top]);
  });
});

describe('Drag Lock (setMeshEditDragLock3D) — no press-drag moves geometry; a press only selects', () => {
  for (const pointerType of ['mouse', 'pen', 'touch']) {
    it(`${pointerType}: a drag from an unselected vertex / the selection moves nothing (vertex mode); the press still selects`, () => {
      const t = setup();
      t.c.setTool('select');
      t.c.setMode('vertex');
      t.c.dragMovesSelection = false;   // what the host sets with the lock (setDragLock)
      t.c.dragLock = true;
      const top = t.faceWhere(v => v.y > 0);
      const [a, b] = t.em().getFaceVertices(top);
      const p0 = t.pos();
      const drag = (vi: number, id: number, shiftKey = false) => {
        const at = t.vertexAt(vi);
        const down = t.fire('pointerdown', { pointerType, pointerId: id, clientX: at.x, clientY: at.y, shiftKey });
        if (t.c.dragLock) expect(isPointerEventClaimed(down)).toBe(false);   // locked: a finger / pen drag is the camera's
        t.fire('pointermove', { pointerType, pointerId: id, clientX: at.x + 40, clientY: at.y + 10, shiftKey });
        t.flush();
        t.fire('pointerup', { pointerType, pointerId: id, clientX: at.x + 40, clientY: at.y + 10, shiftKey });
      };
      drag(a, 11);                                  // an unselected vertex
      expect(t.pos()).toEqual(p0);
      if (pointerType === 'mouse') expect([...t.meshEdit.getSelection(t.mesh.id)!.vertices]).toEqual([a]);   // selected on the press
      t.meshEdit.selectVertex(t.mesh.id, a);
      t.meshEdit.selectVertex(t.mesh.id, b, true);
      drag(a, 12);                                  // the selection
      drag(b, 13, true);                            // an additive press on the selection
      expect(t.pos()).toEqual(p0);
      expect(t.c.transform.active).toBe(false);
      expect(t.undo.stackSize).toBe(0);
      // a tap still selects
      const at = t.vertexAt(b);
      t.fire('pointerdown', { pointerType, pointerId: 14, clientX: at.x, clientY: at.y });
      t.fire('pointerup', { pointerType, pointerId: 14, clientX: at.x, clientY: at.y });
      expect([...t.meshEdit.getSelection(t.mesh.id)!.vertices]).toEqual([b]);
      // unlocked again: the old single-vertex drag is back
      t.c.dragLock = false;
      drag(a, 15);
      expect(t.pos()).not.toEqual(p0);
    });
  }
});

describe('B — pickElementAt', () => {
  it('returns the vertex / edge / face under the point (by mode) and whether it is selected; null off the mesh', () => {
    const t = setup();
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0);
    let at = t.faceCentre(top);
    expect(t.c.pickElementAt(at.x, at.y)).toEqual({ kind: 'face', index: top, selected: false });
    t.meshEdit.selectFace(t.mesh.id, top);
    expect(t.c.pickElementAt(at.x, at.y)).toEqual({ kind: 'face', index: top, selected: true });
    expect(t.c.pickElementAt(3, 3)).toBeNull();
    // vertex mode: a corner of the selected top face is selected (the selection's vertex set)
    t.c.setMode('vertex');
    const v = t.em().getFaceVertices(top)[0];
    at = t.vertexAt(v);
    expect(t.c.pickElementAt(at.x + 3, at.y - 2)).toEqual({ kind: 'vertex', index: v, selected: true });
    // edge mode: the half-edge at an edge midpoint (selectEdge takes it); selected once selected
    t.c.setMode('edge');
    const he = t.em().faces[top].halfEdge;
    const [a, b] = t.em().getHalfEdgeVertices(he)!;
    const A = t.em().vertices[a], B = t.em().vertices[b];
    at = t.screen(t.toWorld({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 }));
    const hit = t.c.pickElementAt(at.x, at.y)!;
    expect(hit.kind).toBe('edge');
    expect(new Set(t.em().getHalfEdgeVertices(hit.index))).toEqual(new Set([a, b]));
    expect(hit.selected).toBe(false);
    t.meshEdit.selectEdge(t.mesh.id, hit.index);
    expect(t.c.pickElementAt(at.x, at.y)!.selected).toBe(true);
  });
});

describe('D — tool strip, Knife, Loop Cut', () => {
  it('setTool: move / rotate / scale = the gizmo mode, every other tool hides it; unknown tools are refused', () => {
    const t = setup();
    expect(t.c.tool).toBe('move');
    for (const tool of ['rotate', 'scale', 'move'] as const) { expect(t.c.setTool(tool)).toBe(true); expect(t.c.gizmoMode).toBe(tool); }
    for (const tool of ['select', 'extrude', 'inset', 'loopcut', 'knife', 'bevel'] as const) { t.c.setTool(tool); expect(t.c.gizmoMode).toBeNull(); }
    expect(t.c.setTool('lasso' as never)).toBe(false);
    // the scene's gizmo mode (the rail) drives the tool back
    t.c.elementTransformRouter().setGizmoMode('scale');
    expect(t.c.tool).toBe('scale');
  });

  it('Knife: two clicks near opposite edges of the top face (snapped onto them), apply = ONE step splitting the face', () => {
    const t = setup();
    t.c.setTool('knife');
    const top = t.faceWhere(v => v.y > 0);
    const a = t.screen(t.toWorld({ x: 0, y: 0.5, z: 0.5 })), b = t.screen(t.toWorld({ x: 0, y: 0.5, z: -0.5 }));
    // 3 px inside the face: the snap puts the point ON the edge
    const ca = t.faceCentre(top);
    const inward = (p: { x: number; y: number }) => { const dx = ca.x - p.x, dy = ca.y - p.y, l = Math.hypot(dx, dy); return { x: p.x + dx / l * 3, y: p.y + dy / l * 3 }; };
    const pa = inward(a), pb = inward(b);
    t.fire('pointerdown', { clientX: pa.x, clientY: pa.y }); t.fire('pointerup', { clientX: pa.x, clientY: pa.y });
    expect(t.c.knifePointCount).toBe(1);
    t.fire('pointerdown', { clientX: pb.x, clientY: pb.y }); t.fire('pointerup', { clientX: pb.x, clientY: pb.y });
    expect(t.c.knifePointCount).toBe(2);
    expect(t.c.guideLines()!.length).toBeGreaterThan(0);          // the path + point markers draw
    expect(t.c.knifeApply()).toBe(1);
    expect(t.c.knifePointCount).toBe(0);
    expect(t.em().vertices.length).toBe(10);
    expect(t.em().faces.length).toBe(7);
    expect(t.em().halfEdges.every(h => h.twin >= 0)).toBe(true);
    expect(t.undo.stackSize).toBe(1);
    expect(t.undo.undoDescription).toBe('Knife');
    t.undo.undo();
    expect(t.em().vertices.length).toBe(8);
    // Cancel drops the points; a miss adds nothing
    t.fire('pointerdown', { clientX: pa.x, clientY: pa.y });
    t.fire('pointerdown', { clientX: 2, clientY: 2 });
    expect(t.c.knifePointCount).toBe(1);
    t.c.knifeCancel();
    expect(t.c.knifePointCount).toBe(0);
    expect(t.c.knifeApply()).toBe(0);
    expect(t.undo.canUndo).toBe(false);                            // (the undone knife step is only redo history)
  });

  it('Loop Cut: hover previews, a click on an edge cuts the loop with the tool count / position (one step, the last op)', () => {
    const t = setup();
    t.c.setTool('loopcut');
    t.c.loopCutCount = 2;
    const top = t.faceWhere(v => v.y > 0);
    const he = t.em().faces[top].halfEdge;
    const [a, b] = t.em().getHalfEdgeVertices(he)!;
    const A = t.em().vertices[a], B = t.em().vertices[b];
    const at = t.screen(t.toWorld({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 }));
    t.fire('pointermove', { clientX: at.x, clientY: at.y });
    t.flush();
    expect(t.c.guideLines()!.length).toBe(4 * 2 * 6);              // 4 quads × 2 cuts × 1 segment
    t.fire('pointerdown', { clientX: at.x, clientY: at.y });
    t.fire('pointerup', { clientX: at.x, clientY: at.y });
    expect(t.em().vertices.length).toBe(16);
    expect(t.em().faces.length).toBe(14);
    expect(t.undo.stackSize).toBe(1);
    // (the position is the pointer's along the edge — the click was on its midpoint)
    const last = t.meshEdit.getLastOp()!;
    expect(last.op).toBe('loopCut');
    expect(last.params.count).toBe(2);
    expect(last.params.position as number).toBeCloseTo(0.5, 6);
  });
});

describe('E — adjust last operation', () => {
  it('extrude region: re-run with another distance REPLACES the step (net one), params applied; undo / redo; cleared by another edit', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    expect(t.meshEdit.extrudeRegion(t.mesh.id, null, 0.5)).toBe(true);
    expect(t.undo.stackSize).toBe(1);
    expect(t.meshEdit.getLastOp()).toEqual({ op: 'extrudeRegion', params: { distance: 0.5 } });
    const topY = () => t.em().getFaceVertices(top).map(v => t.em().vertices[v].y);
    expect(topY().every(y => Math.abs(y - 1) < 1e-9)).toBe(true);
    const compile = vi.spyOn(EditMesh.prototype, 'compile');
    compile.mockClear();
    for (const dist of [0.2, 0.35, 0.3]) {
      expect(t.meshEdit.redoLastOp({ distance: dist })).toBe(true);
      expect(t.undo.stackSize).toBe(1);                              // still ONE step
      expect(topY().every(y => Math.abs(y - (0.5 + dist)) < 1e-9)).toBe(true);
      expect(t.em().vertices.length).toBe(12);                       // one extrusion, not stacked
    }
    expect(compile.mock.calls.length).toBe(3);                       // one compile per re-run (cheap enough to scrub)
    compile.mockRestore();
    expect(t.meshEdit.getLastOp()!.params.distance).toBe(0.3);
    expect([...t.meshEdit.getSelection(t.mesh.id)!.faces]).toEqual([top]);
    // unknown keys are ignored; a non-number for a number param too
    expect(t.meshEdit.redoLastOp({ bogus: 1, distance: 'x' })).toBe(true);
    expect(t.meshEdit.getLastOp()!.params).toEqual({ distance: 0.3 });
    // undo → the cube; the record no longer applies (the step is not on top)
    t.undo.undo();
    expect(t.em().vertices.length).toBe(8);
    expect(t.meshEdit.getLastOp()).toBeNull();
    expect(t.meshEdit.redoLastOp({ distance: 1 })).toBe(false);
    t.undo.redo();
    expect(topY().every(y => Math.abs(y - 0.8) < 1e-9)).toBe(true);
    // another edit clears it
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.extrudeRegion(t.mesh.id, null, 0.1);
    t.meshEdit.moveVertex(t.mesh.id, 0, 0.1, 0, 0);
    expect(t.meshEdit.getLastOp()).toBeNull();
  });

  it('a re-run that changes nothing leaves the mesh as before with NO step; scrubbing back brings it back', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    // (an extrude of 0 still extrudes — zero-height walls, as Blender; an inset of 0 with no depth is nothing)
    t.meshEdit.insetRegion(t.mesh.id, null, 0.5);
    expect(t.em().vertices.length).toBe(12);
    expect(t.meshEdit.redoLastOp({ amount: 0 })).toBe(true);
    expect(t.undo.canUndo).toBe(false);
    expect(t.em().vertices.length).toBe(8);
    expect(t.meshEdit.getLastOp()).toEqual({ op: 'insetRegion', params: { amount: 0, depth: 0 } });
    expect(t.meshEdit.redoLastOp({ amount: 0.4 })).toBe(true);
    expect(t.undo.canUndo).toBe(true);
    expect(t.undo.stackSize).toBe(1);
    expect(t.em().vertices.length).toBe(12);
    expect([...t.meshEdit.getSelection(t.mesh.id)!.faces]).toEqual([top]);
  });

  it('inset {amount, depth}, bevel {amount, segments}, loop cut {count, position}, subdivide {levels}', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    // inset + depth
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.insetRegion(t.mesh.id, null, 0.5);
    expect(t.meshEdit.getLastOp()).toEqual({ op: 'insetRegion', params: { amount: 0.5, depth: 0 } });
    expect(t.meshEdit.redoLastOp({ depth: -0.2 })).toBe(true);
    expect(t.undo.stackSize).toBe(1);
    for (const v of t.em().getFaceVertices(top)) expect(t.em().vertices[v].y).toBeCloseTo(0.3, 9);
    t.undo.undo();
    // bevel of one edge: amount + segments
    const he = t.em().halfEdges.findIndex(h => h.twin >= 0);
    const edge = t.em().getHalfEdgeVertices(he)!;
    expect(t.meshEdit.bevel(t.mesh.id, { edges: [edge], amount: 0.1, segments: 1 })).toBeCloseTo(0.1, 9);
    expect(t.meshEdit.getLastOp()).toEqual({ op: 'bevel', params: { amount: 0.1, segments: 1 } });
    const f1 = t.em().faces.length;
    expect(t.meshEdit.redoLastOp({ segments: 3 })).toBe(true);
    expect(t.em().faces.length).toBe(f1 + 2);                        // 3 strip quads instead of 1
    expect(t.undo.stackSize).toBe(1);
    t.undo.undo();
    // loop cut: count
    expect(t.meshEdit.loopCuts(t.mesh.id, he, 1, 0.5)).toBe(true);
    expect(t.em().vertices.length).toBe(12);
    expect(t.meshEdit.redoLastOp({ count: 3 })).toBe(true);
    expect(t.em().vertices.length).toBe(20);
    expect(t.undo.stackSize).toBe(1);
    t.undo.undo();
    // subdivide: levels
    t.meshEdit.selectFace(t.mesh.id, top);
    t.meshEdit.subdivideFaces(t.mesh.id, null);
    expect(t.em().faces.length).toBe(5 + 4);
    expect(t.meshEdit.redoLastOp({ levels: 2 })).toBe(true);
    expect(t.em().faces.length).toBe(5 + 16);
    expect(t.undo.stackSize).toBe(1);
    expect(t.em().halfEdges.every(h => h.twin >= 0)).toBe(true);
  });

  it('the interactive Chamfer records its result too (adjust its amount / segments after Apply)', () => {
    const t = setup();
    t.c.setMode('vertex');
    t.meshEdit.selectVertex(t.mesh.id, 0);
    expect(t.c.bevel.begin(t.mesh.id)).toBe(true);
    t.c.bevel.setAmount(0.1);
    expect(t.c.bevel.commit()).toBe(true);
    expect(t.undo.stackSize).toBe(1);
    expect(t.meshEdit.getLastOp()).toEqual({ op: 'bevel', params: { amount: 0.1, segments: 1 } });
    const v1 = t.em().vertices.length;
    expect(t.meshEdit.redoLastOp({ segments: 2 })).toBe(true);
    expect(t.em().vertices.length).toBeGreaterThan(v1);
    expect(t.undo.stackSize).toBe(1);
  });
});
