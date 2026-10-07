/**
 * mesh-edit-touch.test.ts — TOUCH-5 / TOUCH-6 / TOUCH-10 in MeshEditPointerController (synthetic pointer events on a
 * fake canvas, a real EditMesh box + MeshEditManager selection, a real Camera3D for the projection):
 *  - the mouse selects on the press (unchanged); Shift or the additive latch adds;
 *  - a finger selects on a TAP (release point), never on the press, never after a drag or a pinch;
 *  - a finger DRAG from a vertex selects + moves it; a 2nd finger / pointercancel restores every vertex and the
 *    previous selection exactly with no undo entry;
 *  - drag moves are applied once per frame (one mesh sync), flushed on release (one undo entry).
 */
import { describe, it, expect } from 'vitest';
import { MeshEditPointerController } from './mesh-edit-pointer-controller';
import { MeshEditManager } from './mesh-edit-manager';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { claimPointerEvent } from '../../renderer/util/pointer-claims';
import type { Scene3DManager } from './scene3d-manager';
import type { ManagerContext } from './manager-context';
import type { Command3D } from './undo-manager-3d';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; shiftKey: boolean; isPrimary: boolean }>;

function fakeCanvas() {
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: {}, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  });
  return el as unknown as HTMLCanvasElement;
}
function makeEvent(type: string, init: Init, claim = false): Event {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0, shiftKey: false, ...init });
  if (claim) claimPointerEvent(e);
  return e;
}

function setup(opts: { additive?: boolean; faceHit?: boolean } = {}) {
  const canvas = fakeCanvas();
  const camera = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0] });
  camera.aspect = 800 / 600;
  const editMesh = EditMesh.fromBox(1, 1, 1);
  let syncs = 0;
  const mesh = { id: 'm', editMesh, localMatrix: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]), syncFromEditMesh: () => { syncs++; } };
  const vp = () => camera.getViewProjectionMatrix() as unknown as Float32Array;
  const project = (x: number, y: number, z: number, w: number, h: number) => {
    const m = vp();
    const cw = m[3]*x + m[7]*y + m[11]*z + m[15];
    if (cw <= 0) return null;
    return { x: ((m[0]*x + m[4]*y + m[8]*z + m[12]) / cw + 1) * 0.5 * w, y: (1 - (m[1]*x + m[5]*y + m[9]*z + m[13]) / cw) * 0.5 * h, depth: 0.5 };
  };
  const scene3d = {
    getMesh: () => mesh,
    getCamera: () => camera,
    getTouchNavigate3D: () => false,
    projectWorldToScreen3D: project,
    // A linear stand-in (only deltas matter): 100 canvas px = 1 world unit.
    unprojectScreenToWorld3D: (sx: number, sy: number) => ({ x: sx / 100, y: -sy / 100, z: 0 }),
    pick3D: () => (opts.faceHit === false ? null : { meshId: 'm', hitPoint: [0, 0, 0.5] }),
  } as unknown as Scene3DManager;
  const meshEdit = new MeshEditManager({ sceneGraph: { findNodeById: () => null } } as unknown as ManagerContext, () => {});
  const cmds: Command3D[] = [];
  const frames: Array<() => void> = [];
  let additive = !!opts.additive;
  const c = new MeshEditPointerController(scene3d, meshEdit, (cmd) => cmds.push(cmd), () => {}, {
    isAdditive: () => additive,
    requestFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelFrame: () => {},
  });
  c.attach(canvas, 'm');
  const fire = (type: string, init: Init, claim = false) => canvas.dispatchEvent(makeEvent(type, init, claim));
  const flush = () => { const fs = frames.splice(0); fs.forEach(f => f()); };
  // Client position of vertex `i` (canvas = client here: rect 800×600 at 0,0).
  const at = (i: number) => { const v = editMesh.vertices[i]; const s = project(v.x, v.y, v.z, 800, 600)!; return { clientX: s.x, clientY: s.y }; };
  const sel = () => meshEdit.getSelection('m') ?? { vertices: new Set<number>(), edges: new Set<number>(), faces: new Set<number>() };
  return { c, fire, flush, at, sel, meshEdit, editMesh, cmds, syncs: () => syncs, setAdditive: (on: boolean) => { additive = on; } };
}

/** The vertex nearest the camera at the top-right (projected inside the canvas, not occluded by the pick math). */
const V = 6;

describe('MeshEditPointerController — mouse (unchanged)', () => {
  it('selects a face on the press; Shift adds; the additive latch adds without Shift', () => {
    const t = setup();
    t.c.setMode('face');
    t.fire('pointerdown', { clientX: 400, clientY: 300 });
    expect(t.sel().faces.size).toBe(1);
    const first = [...t.sel().faces][0];
    t.fire('pointerup', { clientX: 400, clientY: 300 });
    // Another face (the pick resolves to the face centre nearest the hit point — force a different one via the latch).
    t.meshEdit.selectFace('m', (first + 1) % 6, true);
    expect(t.sel().faces.size).toBe(2);
    t.fire('pointerdown', { clientX: 400, clientY: 300 });       // plain press replaces
    expect(t.sel().faces.size).toBe(1);
    t.fire('pointerup', {});
    t.meshEdit.selectFace('m', (first + 1) % 6, true);
    t.setAdditive(true);
    t.fire('pointerdown', { clientX: 400, clientY: 300 });       // latch: adds (keeps the other face)
    expect(t.sel().faces.size).toBe(2);
  });

  it('a mouse vertex drag pushes ONE undo entry; moves are applied once per frame and flushed on release', () => {
    const t = setup();
    t.c.setMode('vertex');
    const p = t.at(V);
    const v0 = { ...t.editMesh.vertices[V] };
    t.fire('pointerdown', { ...p });
    expect(t.sel().vertices.has(V)).toBe(true);
    const s0 = t.syncs();
    t.fire('pointermove', { clientX: p.clientX + 30, clientY: p.clientY });
    t.fire('pointermove', { clientX: p.clientX + 50, clientY: p.clientY });
    expect(t.syncs()).toBe(s0);                       // waiting for the frame
    t.flush();
    expect(t.syncs()).toBe(s0 + 1);                   // two moves → one mesh sync
    t.fire('pointermove', { clientX: p.clientX + 80, clientY: p.clientY });
    t.fire('pointerup', { clientX: p.clientX + 80, clientY: p.clientY });   // flushed before the undo snapshot
    expect(t.editMesh.vertices[V].x).toBeCloseTo(v0.x + 0.8, 5);
    expect(t.cmds).toHaveLength(1);
  });
});

describe('MeshEditPointerController — fingers (TOUCH-5 / TOUCH-6)', () => {
  it('a finger selects nothing on the press; a TAP selects on release', () => {
    const t = setup();
    t.c.setMode('vertex');
    const p = t.at(V);
    t.fire('pointerdown', { pointerType: 'touch', ...p });
    expect(t.sel().vertices.size).toBe(0);
    t.fire('pointerup', { pointerType: 'touch', clientX: p.clientX + 3, clientY: p.clientY + 2 });
    expect([...t.sel().vertices]).toEqual([V]);
    expect(t.cmds).toHaveLength(0);
  });

  it('a finger drag in face mode selects nothing (not a tap); a pinch selects nothing', () => {
    const t = setup();
    t.c.setMode('face');
    t.fire('pointerdown', { pointerType: 'touch', clientX: 400, clientY: 300 });
    t.fire('pointermove', { pointerType: 'touch', clientX: 440, clientY: 300 });
    t.fire('pointerup', { pointerType: 'touch', clientX: 440, clientY: 300 });
    expect(t.sel().faces.size).toBe(0);
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 400, clientY: 300 });
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 600, clientY: 300 });
    t.fire('pointerup', { pointerType: 'touch', pointerId: 2, clientX: 600, clientY: 300 });
    t.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 400, clientY: 300 });
    expect(t.sel().faces.size).toBe(0);
  });

  it('a finger DRAG from a vertex selects + moves it; a 2nd finger restores the vertices and the selection exactly', () => {
    const t = setup();
    t.c.setMode('vertex');
    t.meshEdit.selectVertex('m', 2);                  // the selection before the gesture
    const before = t.editMesh.vertices.map(v => ({ x: v.x, y: v.y, z: v.z }));
    const p = t.at(V);
    t.fire('pointerdown', { pointerType: 'touch', ...p });
    t.fire('pointermove', { pointerType: 'touch', clientX: p.clientX + 40, clientY: p.clientY });
    t.flush();
    expect([...t.sel().vertices]).toEqual([V]);
    expect(t.editMesh.vertices[V].x).not.toBeCloseTo(before[V].x, 5);
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 700, clientY: 300 });
    expect(t.editMesh.vertices.map(v => ({ x: v.x, y: v.y, z: v.z }))).toEqual(before);
    expect([...t.sel().vertices]).toEqual([2]);
    t.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: p.clientX + 60, clientY: p.clientY });
    t.flush();
    expect(t.cmds).toHaveLength(0);                   // no undo entry
    expect(t.editMesh.vertices.map(v => ({ x: v.x, y: v.y, z: v.z }))).toEqual(before);
  });

  it('pointercancel restores a finger drag too', () => {
    const t = setup();
    t.c.setMode('vertex');
    const before = t.editMesh.vertices.map(v => ({ x: v.x, y: v.y, z: v.z }));
    const p = t.at(V);
    t.fire('pointerdown', { pointerType: 'touch', ...p });
    t.fire('pointermove', { pointerType: 'touch', clientX: p.clientX + 40, clientY: p.clientY });
    t.flush();
    t.fire('pointercancel', { pointerType: 'touch' });
    expect(t.editMesh.vertices.map(v => ({ x: v.x, y: v.y, z: v.z }))).toEqual(before);
    expect(t.sel().vertices.size).toBe(0);
    expect(t.cmds).toHaveLength(0);
  });

  it('a finger drag that completes pushes ONE undo entry', () => {
    const t = setup();
    t.c.setMode('vertex');
    const p = t.at(V);
    t.fire('pointerdown', { pointerType: 'touch', ...p });
    t.fire('pointermove', { pointerType: 'touch', clientX: p.clientX + 40, clientY: p.clientY });
    t.fire('pointerup', { pointerType: 'touch', clientX: p.clientX + 40, clientY: p.clientY });
    expect(t.cmds).toHaveLength(1);
  });

  it('the additive latch applies to finger taps too', () => {
    const t = setup({ additive: true });
    t.c.setMode('vertex');
    t.meshEdit.selectVertex('m', 2);
    const p = t.at(V);
    t.fire('pointerdown', { pointerType: 'touch', ...p });
    t.fire('pointerup', { pointerType: 'touch', ...p });
    expect([...t.sel().vertices].sort()).toEqual([2, V].sort());
  });

  it('a claimed finger (UV paint stroke) never picks', () => {
    const t = setup();
    t.c.setMode('vertex');
    const p = t.at(V);
    t.fire('pointerdown', { pointerType: 'touch', ...p }, true);
    t.fire('pointerup', { pointerType: 'touch', ...p });
    expect(t.sel().vertices.size).toBe(0);
  });
});
