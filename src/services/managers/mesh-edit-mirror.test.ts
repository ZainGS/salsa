/**
 * mesh-edit-mirror.test.ts — the plane mirror in Edit Mesh (round 2 "Mirror rework", docs/reviews/section4-engine-api.md
 * "Mirror (round 2)"): add from a face / bisect, plane get / set (live preview vs one undo step), flip, the copy side
 * picks (and drags) its partner on the real side, the discarded part is not pickable, and the plane handle (rotation
 * rings: drag = live + one step, Esc / 2nd finger cancel; hidden when cleared).
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
import { MirrorModifier } from '../../scene-graph/shapes/edit-mesh';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { GizmoRenderer, hitTestGizmoAt } from '../../renderer/3d/gizmo-renderer';
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

/** A cube in Edit Mesh, a perspective camera from +X / above / front, a REAL undo stack (the section-4 harness). */
function setup(cameraPos: [number, number, number] = [3.2, 1.8, 3]) {
  const camera = new Camera3D({ position: cameraPos, target: [0.3, 0, 0], mode: 'perspective' });
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
  const toWorld = (x: number, y: number, z: number) => vec3.transformMat4(vec3.create(), [x, y, z], mesh.localMatrix as unknown as mat4);
  const at = (x: number, y: number, z: number) => screen(toWorld(x, y, z));
  const faceWhere = (pred: (v: { x: number; y: number; z: number }) => boolean) =>
    em().faces.findIndex((_, fi) => em().getFaceVertices(fi).every(vi => pred(em().vertices[vi])));
  const vertexWhere = (x: number, y: number, z: number) => em().vertices.findIndex(v => v.x === x && v.y === y && v.z === z);
  const pos = () => em().vertices.map(v => [v.x, v.y, v.z]);
  const mirror = (i = 0) => em().modifiers[i] as MirrorModifier;
  return { c, mesh, meshEdit, undo, camera, fire, flush, em, at, faceWhere, vertexWhere, pos, mirror };
}

describe('plane mirror — add / get / set / flip + undo steps', () => {
  it('addMirrorFromFace: plane through the face centroid along its normal; addMirrorBisect: bounds centre, local -X', () => {
    const t = setup();
    const fx = t.faceWhere(v => v.x > 0);
    expect(t.meshEdit.addMirrorFromFace(t.mesh.id, fx)).toBe(0);
    expect(t.meshEdit.getMirrorPlane(t.mesh.id, 0)).toEqual({ mode: 'face', point: [0.5, 0, 0], normal: [1, 0, 0] });
    expect(t.meshEdit.addMirrorBisect(t.mesh.id)).toBe(1);
    expect(t.meshEdit.getMirrorPlane(t.mesh.id, 1)).toEqual({ mode: 'bisect', point: [0, 0, 0], normal: [-1, 0, 0] });
    expect(t.undo.stackSize).toBe(2);
    expect(t.meshEdit.addMirrorFromFace(t.mesh.id, 99)).toBe(-1);
    expect(t.meshEdit.getMirrorPlane(t.mesh.id, 5)).toBeNull();
    // the old API still makes an axis mirror
    expect(t.meshEdit.addMirrorModifier(t.mesh.id, 'y', true)).toBe(2);
    expect(t.meshEdit.getMirrorPlane(t.mesh.id, 2)).toEqual({ mode: 'axis', point: [0, 0, 0], normal: [0, 1, 0] });
  });

  it('setMirrorPlane: commit:false previews (no step), commit:true = ONE step from before the preview; undo restores', () => {
    const t = setup();
    t.meshEdit.addMirrorBisect(t.mesh.id);
    const geom0 = Array.from(t.mesh.geometry!.vertices);
    expect(t.undo.stackSize).toBe(1);
    for (const a of [0.1, 0.2, 0.3]) {
      expect(t.meshEdit.setMirrorPlane(t.mesh.id, 0, { normal: [-Math.cos(a), Math.sin(a), 0] }, { commit: false })).toBe(true);
    }
    expect(t.undo.stackSize).toBe(1);                                      // live: no steps
    expect(Array.from(t.mesh.geometry!.vertices)).not.toEqual(geom0);      // ...but the mesh re-cut
    t.meshEdit.setMirrorPlane(t.mesh.id, 0, { normal: [-1, 1, 0] });      // commit (default)
    expect(t.undo.stackSize).toBe(2);
    expect(t.mirror().normal[0]).toBeCloseTo(-Math.SQRT1_2, 12);
    t.undo.undo();
    expect(t.mirror().normal).toEqual([-1, 0, 0]);                         // back to before the FIRST preview
    expect(Array.from(t.mesh.geometry!.vertices)).toEqual(geom0);
    t.undo.redo();
    expect(t.mirror().normal[1]).toBeCloseTo(Math.SQRT1_2, 12);
    // a preview then a cancel: back exactly, no step
    t.meshEdit.setMirrorPlane(t.mesh.id, 0, { point: [0.2, 0, 0] }, { commit: false });
    expect(t.meshEdit.cancelMirrorPlanePreview()).toBe(true);
    expect(t.mirror().point).toEqual([0, 0, 0]);
    expect(t.undo.stackSize).toBe(2);
    // an unchanged commit pushes nothing; a zero normal is refused
    expect(t.meshEdit.setMirrorPlane(t.mesh.id, 0, {})).toBe(true);
    expect(t.undo.stackSize).toBe(2);
    expect(t.meshEdit.setMirrorPlane(t.mesh.id, 0, { normal: [0, 0, 0] })).toBe(false);
  });

  it('flipMirrorSide: the normal reverses (one step); an axis mirror becomes a bisect mirror', () => {
    const t = setup();
    t.meshEdit.addMirrorBisect(t.mesh.id);
    expect(t.meshEdit.flipMirrorSide(t.mesh.id, 0)).toBe(true);
    expect(t.meshEdit.getMirrorPlane(t.mesh.id, 0)!.normal).toEqual([1, 0, 0]);
    expect(t.undo.stackSize).toBe(2);
    t.undo.undo();
    expect(t.meshEdit.getMirrorPlane(t.mesh.id, 0)!.normal).toEqual([-1, 0, 0]);
    t.meshEdit.addMirrorModifier(t.mesh.id, 'x', true);
    t.meshEdit.flipMirrorSide(t.mesh.id, 1);
    expect(t.meshEdit.getMirrorPlane(t.mesh.id, 1)).toEqual({ mode: 'bisect', point: [0, 0, 0], normal: [-1, 0, 0] });
    expect(t.meshEdit.flipMirrorSide(t.mesh.id, 7)).toBe(false);
  });
});

describe('plane mirror — editing through the copy', () => {
  it('a face mirror on +X: vertex / edge / face picks on the COPY select the partner on the real side', () => {
    const t = setup();
    t.meshEdit.addMirrorFromFace(t.mesh.id, t.faceWhere(v => v.x > 0));
    // vertex: the copy of (-0.5, 0.5, 0.5) is at (1.5, 0.5, 0.5)
    t.c.setMode('vertex');
    const v = t.vertexWhere(-0.5, 0.5, 0.5);
    let p = t.at(1.5, 0.5, 0.5);
    expect(t.c.pickElementAt(p.x, p.y)).toEqual({ kind: 'vertex', index: v, selected: false });
    // face: the copy of the -X face is the far +X end (x = 1.5), facing the camera
    t.c.setMode('face');
    const fneg = t.faceWhere(v2 => v2.x < 0);
    p = t.at(1.5, 0, 0);
    expect(t.c.pickElementAt(p.x, p.y)).toEqual({ kind: 'face', index: fneg, selected: false });
    // the real -X face is hidden from this camera; the real top face picks itself
    const top = t.faceWhere(v2 => v2.y > 0);
    p = t.at(0, 0.5, 0);
    expect(t.c.pickElementAt(p.x, p.y)!.index).toBe(top);
    // ...and its copy (centre (1, 0.5, 0)) picks it too
    p = t.at(1, 0.5, 0);
    expect(t.c.pickElementAt(p.x, p.y)!.index).toBe(top);
    // edge: the copy of the edge (-0.5, 0.5, ±0.5) is at x = 1.5
    t.c.setMode('edge');
    p = t.at(1.5, 0.5, 0);
    const hit = t.c.pickElementAt(p.x, p.y)!;
    const ends = t.em().getHalfEdgeVertices(hit.index)!.map(i => t.em().vertices[i]);
    expect(ends.every(e => e.x === -0.5 && e.y === 0.5)).toBe(true);
  });

  it('a bisect mirror: the discarded half is not pickable — its place is the copy of the real half', () => {
    const t = setup([-3.2, 1.8, 3]);                                     // looking from -X (the copy side)
    t.meshEdit.addMirrorBisect(t.mesh.id);                                // real = +X half, copy on -X
    t.c.setMode('vertex');
    const p = t.at(-0.5, 0.5, 0.5);
    // the base vertex there is discarded: the pick is its PARTNER (+0.5, 0.5, 0.5)
    expect(t.c.pickElementAt(p.x, p.y)!.index).toBe(t.vertexWhere(0.5, 0.5, 0.5));
    // face mode: the -X face is discarded; the copy there is the +X face's
    t.c.setMode('face');
    const q = t.at(-0.5, 0, 0);
    expect(t.c.pickElementAt(q.x, q.y)!.index).toBe(t.faceWhere(v => v.x > 0));
    // without the mirror the same tap picks the -X face itself
    t.meshEdit.removeModifier(t.mesh.id, 0);
    expect(t.c.pickElementAt(q.x, q.y)!.index).toBe(t.faceWhere(v => v.x < 0));
  });

  it('dragging a vertex on the copy moves its partner mirrored (the copy follows the pointer); one undo step', () => {
    const t = setup();
    t.c.setTool('select');
    t.meshEdit.addMirrorFromFace(t.mesh.id, t.faceWhere(v => v.x > 0));   // plane x = 0.5, copy on +X
    t.c.setMode('vertex');
    const v = t.vertexWhere(-0.5, 0.5, 0.5);
    const p = t.at(1.5, 0.5, 0.5);
    const p0 = t.pos();
    t.fire('pointerdown', { clientX: p.x, clientY: p.y });
    t.fire('pointermove', { clientX: p.x + 60, clientY: p.y });
    t.flush();
    t.fire('pointerup', { clientX: p.x + 60, clientY: p.y });
    // the harness unprojects +60 px as +0.6 world X at the copy → the real vertex moves −0.6 X (reflected)
    expect(t.em().vertices[v].x).toBeCloseTo(-1.1, 6);
    expect(t.em().vertices[v].y).toBeCloseTo(0.5, 6);
    expect(t.undo.stackSize).toBe(2);                                      // add mirror + the drag
    t.undo.undo();
    expect(t.pos()).toEqual(p0);
  });

  it('dragging the SELECTION from its copy moves the real elements so the copy follows (element grab through the mirror)', () => {
    const t = setup();
    t.c.setTool('select');
    t.meshEdit.addMirrorFromFace(t.mesh.id, t.faceWhere(v => v.x > 0));
    t.c.setMode('face');
    const top = t.faceWhere(v => v.y > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    const moving = t.meshEdit.selectedVertexIndices(t.mesh.id);
    const p0 = t.pos();
    const p = t.at(1, 0.5, 0);                                              // the copy of the top face
    t.fire('pointerdown', { clientX: p.x, clientY: p.y });
    t.fire('pointermove', { clientX: p.x + 80, clientY: p.y });
    t.flush();
    expect(t.c.transform.state()?.source).toBe('drag');
    const p1 = t.pos();
    const d = [0, 1, 2].map(k => p1[moving[0]][k] - p0[moving[0]][k]);
    // the pointer moved right: the COPY of the moved vertices follows it on screen
    const copyOf = (q: number[]) => t.at(1 - q[0], q[1], q[2]);           // reflection across x = 0.5
    expect(copyOf(p1[moving[0]]).x).toBeGreaterThan(copyOf(p0[moving[0]]).x + 20);
    expect(Math.hypot(d[0], d[1], d[2])).toBeGreaterThan(0.05);
    t.fire('pointerup', { clientX: p.x + 80, clientY: p.y });
    expect(t.undo.stackSize).toBe(2);
  });
});

describe('plane mirror — the plane handle', () => {
  /** A screen point on ring `axis` of the handle that hits it (the near half), or null. */
  function ringPoint(t: ReturnType<typeof setup>, axis: 'x' | 'y' | 'z') {
    const g = t.c.gizmoDrawData()!;
    const s = GizmoRenderer.computeGizmoScale(t.camera, g.center as unknown as vec3);
    const vp = t.camera.getViewProjectionMatrix() as unknown as mat4;
    const inv = mat4.invert(mat4.create(), vp)!;
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2, c = Math.cos(a) * s, sn = Math.sin(a) * s;
      const off = axis === 'x' ? [0, c, sn] : axis === 'y' ? [c, 0, sn] : [c, sn, 0];
      const w = [g.center[0] + off[0], g.center[1] + off[1], g.center[2] + off[2]];
      const sp = t.at(w[0], w[1], w[2]);
      // the world ray through that pixel must hit this ring
      const nx = (2 * sp.x) / W - 1, ny = 1 - (2 * sp.y) / H;
      const o = vec3.transformMat4(vec3.create(), [nx, ny, 0], inv), f = vec3.transformMat4(vec3.create(), [nx, ny, 1], inv);
      const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), f, o));
      if (hitTestGizmoAt(o, dir, g.center, g.rotation as unknown as mat4 | null, t.camera, 'rotate') === axis) return sp;
    }
    return null;
  }

  it('shown: the rotate rings replace the selection gizmo + a plane quad; hidden by null', () => {
    const t = setup();
    t.meshEdit.addMirrorBisect(t.mesh.id);
    t.meshEdit.selectFace(t.mesh.id, 0);
    expect(t.c.gizmoDrawData()?.mode).toBe('move');                        // the selection gizmo
    t.c.setMirrorPlaneHandle(t.mesh.id, 0);
    const g = t.c.gizmoDrawData()!;
    expect(g.mode).toBe('rotate');
    expect(g.center).toEqual([0, 0, 0]);                                   // the plane's point
    const q = t.c.mirrorPlaneQuad()!;
    expect(q).toHaveLength(12);
    for (let k = 0; k < 4; k++) expect(Math.abs(q[k * 3])).toBeLessThan(1e-6);   // the quad lies in the plane x = 0
    t.c.setMirrorPlaneHandle(null, null);
    expect(t.c.mirrorPlaneQuad()).toBeNull();
    expect(t.c.gizmoDrawData()?.mode).toBe('move');
    // leaving Edit Mesh hides it
    t.c.setMirrorPlaneHandle(t.mesh.id, 0);
    t.meshEdit.exitEditMode();
    expect(t.c.mirrorPlaneQuad()).toBeNull();
  });

  it('dragging a ring turns the plane about its point: live preview, ONE undo step on release; Esc / a 2nd finger cancel', () => {
    const t = setup();
    t.meshEdit.addMirrorBisect(t.mesh.id);
    t.c.setMirrorPlaneHandle(t.mesh.id, 0);
    const sp = ringPoint(t, 'y')!;
    expect(sp).not.toBeNull();
    t.fire('pointerdown', { clientX: sp.x, clientY: sp.y });
    expect(t.c.isBusy).toBe(true);
    t.fire('pointermove', { clientX: sp.x + 40, clientY: sp.y + 30 });
    t.flush();
    const live = t.mirror().normal;
    expect(live[1]).toBeCloseTo(0, 12);                                    // turned about Y: still horizontal
    expect(live[0]).not.toBeCloseTo(-1, 3);                                // ...but turned
    expect(t.mirror().point).toEqual([0, 0, 0]);
    expect(t.undo.stackSize).toBe(1);                                      // live: no step yet
    t.fire('pointerup', { clientX: sp.x + 40, clientY: sp.y + 30 });
    expect(t.c.isBusy).toBe(false);
    expect(t.undo.stackSize).toBe(2);
    t.undo.undo();
    expect(t.mirror().normal).toEqual([-1, 0, 0]);
    // Esc (the router's cancel) mid-drag: back exactly, no step
    t.fire('pointerdown', { clientX: sp.x, clientY: sp.y });
    t.fire('pointermove', { clientX: sp.x + 50, clientY: sp.y - 20 });
    t.flush();
    expect(t.mirror().normal).not.toEqual([-1, 0, 0]);
    t.c.elementTransformRouter().cancel();
    expect(t.mirror().normal).toEqual([-1, 0, 0]);
    expect(t.c.isBusy).toBe(false);
    t.fire('pointerup', { clientX: sp.x + 50, clientY: sp.y - 20 });
    expect(t.undo.undoDescription).toBe('Add mirror (bisect)');   // nothing pushed (the undone step waits as a redo)
    expect(t.undo.stackSize).toBe(2);
    // a finger drag + a 2nd finger: cancelled
    const touch = { pointerType: 'touch', pointerId: 5 };
    t.fire('pointerdown', { ...touch, clientX: sp.x, clientY: sp.y });
    expect(t.c.isBusy).toBe(true);
    t.fire('pointermove', { ...touch, clientX: sp.x + 40, clientY: sp.y });
    t.flush();
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 6, isPrimary: false, clientX: 50, clientY: 50 });
    expect(t.c.isBusy).toBe(false);
    expect(t.mirror().normal).toEqual([-1, 0, 0]);
    expect(t.undo.undoDescription).toBe('Add mirror (bisect)');
    expect(t.undo.stackSize).toBe(2);
  });
});
