/**
 * mesh-bevel-tool.test.ts — the interactive Chamfer / Bevel (docs/specs/edit-mesh-topology.md §8): both entry orders
 * (selection first / pick first), the relative drag → amount mapping, clamp + snap + segments, Apply = one undo step,
 * Cancel = exact restore, touch (tap picks, finger drag sets the amount, a 2nd finger aborts the drag) and the guides.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { MeshEditPointerController } from './mesh-edit-pointer-controller';
import { MeshEditManager } from './mesh-edit-manager';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import type { Scene3DManager } from './scene3d-manager';
import type { ManagerContext } from './manager-context';
import type { Command3D } from './undo-manager-3d';
import type { InteractionService } from '../interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

function fakeCanvas(): HTMLCanvasElement {
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: {}, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  });
  return el as unknown as HTMLCanvasElement;
}

function ev(type: string, init: Record<string, unknown>): Event {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0, shiftKey: false, ctrlKey: false, ...init });
  return e;
}

function setup() {
  const camera = new Camera3D({ position: [2.2, 1.8, 3], target: [0, 0, 0] });
  camera.aspect = 800 / 600;
  const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
  const meshEdit = new MeshEditManager({ sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext, () => {});
  meshEdit.makeEditable(mesh.id);
  meshEdit.enterEditMode(mesh.id);
  const project = (x: number, y: number, z: number, w: number, h: number) => {
    const m = camera.getViewProjectionMatrix() as unknown as Float32Array;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0) return null;
    return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) * 0.5 * w, y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5 * h, depth: 0.5 };
  };
  const scene3d = {
    getMesh: () => mesh, getCamera: () => camera, getTouchNavigate3D: () => false,
    projectWorldToScreen3D: project,
    unprojectScreenToWorld3D: (sx: number, sy: number) => ({ x: sx / 100, y: -sy / 100, z: 0 }),
    patchMeshVertices3D: () => true, patchMeshIndices3D: () => true, noteMeshVerticesMoved3D: () => {},
  } as unknown as Scene3DManager;
  const cmds: Command3D[] = [];
  let changes = 0;
  const frames: Array<() => void> = [];
  const c = new MeshEditPointerController(scene3d, meshEdit, (cmd) => cmds.push(cmd), () => {}, {
    requestFrame: (cb) => { frames.push(cb); return frames.length; }, cancelFrame: () => {},
  });
  const canvas = fakeCanvas();
  c.attach(canvas, mesh.id, () => { changes++; });
  const fire = (type: string, init: Record<string, unknown>) => canvas.dispatchEvent(ev(type, init));
  const flush = () => { const fs = frames.splice(0); fs.forEach(f => f()); };
  const screen = (x: number, y: number, z: number) => project(x, y, z, 800, 600)!;
  const corner = (sx: number, sy: number, sz: number) => mesh.editMesh!.vertices.findIndex(p => Math.sign(p.x) === sx && Math.sign(p.y) === sy && Math.sign(p.z) === sz);
  return { c, mesh, meshEdit, cmds, fire, flush, screen, corner, changes: () => changes };
}

const bytes = (m: Mesh3D) => Array.from(m.geometry!.vertices);

describe('Chamfer tool — entry (a): selection first', () => {
  it('a selected vertex: adjust at once; the amount previews a corner cut; Cancel restores the very same mesh', () => {
    const t = setup();
    const em0 = t.mesh.editMesh!, g0 = bytes(t.mesh);
    const v = t.corner(1, 1, 1);
    t.meshEdit.selectVertex(t.mesh.id, v);
    expect(t.c.bevel.begin(t.mesh.id)).toBe(true);
    const s = t.c.bevel.state()!;
    expect(s.phase).toBe('adjust');
    expect(s.kind).toBe('vertex');
    expect(s.maxAmount).toBeCloseTo(0.995, 9);
    expect(t.meshEdit.getSelection(t.mesh.id)!.vertices.size).toBe(0);   // indices change while previewing
    t.c.bevel.setAmount(0.25);
    expect(t.mesh.editMesh).not.toBe(em0);
    expect(t.mesh.editMesh!.faces.length).toBe(7);
    expect(em0.faces.length).toBe(6);                                    // the original is untouched
    t.c.bevel.setAmount(42);
    expect(t.c.bevel.state()!.amount).toBeCloseTo(0.995, 9);             // clamped
    t.c.bevel.cancel();
    expect(t.mesh.editMesh).toBe(em0);
    expect(bytes(t.mesh)).toEqual(g0);
    expect([...t.meshEdit.getSelection(t.mesh.id)!.vertices]).toEqual([v]);   // selection back
    expect(t.cmds).toHaveLength(0);
    expect(t.c.bevel.active).toBe(false);
  });

  it('selected edges → edge bevel; segments + snap; Apply = ONE undo step (undo / redo exact)', () => {
    const t = setup();
    const g0 = bytes(t.mesh);
    const em = t.mesh.editMesh!;
    const a = t.corner(1, 1, 1), b = t.corner(-1, 1, 1);
    const he = em.halfEdges.findIndex(h => h.vertex === b && em.halfEdges[h.prev].vertex === a);
    t.c.setMode('edge');
    t.meshEdit.selectEdge(t.mesh.id, he);
    t.c.bevel.begin(t.mesh.id);
    expect(t.c.bevel.state()!.kind).toBe('edge');
    t.c.bevel.setSegments(3);
    t.c.bevel.setSnap(true);
    t.c.bevel.setAmount(0.237);
    expect(t.c.bevel.state()!.amount).toBeCloseTo(0.25, 9);              // snapped to 0.05 steps
    expect(t.mesh.editMesh!.faces.length).toBe(6 + 3);
    const applied = bytes(t.mesh);
    expect(t.c.bevel.commit()).toBe(true);
    expect(t.cmds).toHaveLength(1);
    expect(t.c.bevel.active).toBe(false);
    t.cmds[0].undo();
    expect(bytes(t.mesh)).toEqual(g0);
    t.cmds[0].redo();
    expect(bytes(t.mesh)).toEqual(applied);
  });

  it('Apply with amount 0 is a cancel (no undo step)', () => {
    const t = setup();
    t.meshEdit.selectVertex(t.mesh.id, t.corner(1, 1, 1));
    t.c.bevel.begin(t.mesh.id);
    expect(t.c.bevel.commit()).toBe(false);
    expect(t.cmds).toHaveLength(0);
  });
});

describe('Chamfer tool — entry (b): pick first, then drag', () => {
  it('mouse: nothing selected → pick phase; a press on a corner starts it and the drag sets the amount', () => {
    const t = setup();
    t.c.setMode('vertex');
    t.c.bevel.begin(t.mesh.id);
    expect(t.c.bevel.state()!.phase).toBe('pick');
    expect(t.c.bevel.state()!.hint).toBe('Tap a corner or edge to chamfer');
    expect(t.c.bevel.guideLines()).toBeNull();
    const p = t.screen(0.5, 0.5, 0.5);
    t.fire('pointerdown', { clientX: p.x, clientY: p.y });
    expect(t.c.bevel.state()!.phase).toBe('adjust');
    expect(t.c.bevel.state()!.dragging).toBe(true);
    // drag toward the cube centre (inward along the guide, roughly — it need not be exact)
    const c = t.screen(0, 0, 0);
    t.fire('pointermove', { clientX: p.x + (c.x - p.x) * 0.3 + 4, clientY: p.y + (c.y - p.y) * 0.3 - 3 });
    t.flush();
    const a1 = t.c.bevel.state()!.amount;
    expect(a1).toBeGreaterThan(0.05);
    // further in = more
    t.fire('pointermove', { clientX: p.x + (c.x - p.x) * 0.6, clientY: p.y + (c.y - p.y) * 0.6 });
    t.flush();
    expect(t.c.bevel.state()!.amount).toBeGreaterThan(a1);
    t.fire('pointerup', { clientX: p.x + (c.x - p.x) * 0.6, clientY: p.y + (c.y - p.y) * 0.6 });
    expect(t.c.bevel.state()!.dragging).toBe(false);
    expect(t.c.bevel.guideLines()!.length).toBe(14 * 2 * 3);
    expect(t.changes()).toBeGreaterThan(3);
    expect(t.c.bevel.commit()).toBe(true);
    expect(t.mesh.editMesh!.faces.length).toBe(7);
  });

  it('a press on an edge midpoint (no vertex near) starts an edge bevel', () => {
    const t = setup();
    t.c.bevel.begin(t.mesh.id);
    const m = t.screen(0, 0.5, 0.5);
    t.fire('pointerdown', { clientX: m.x, clientY: m.y });
    expect(t.c.bevel.state()!.kind).toBe('edge');
    t.fire('pointerup', { clientX: m.x, clientY: m.y });
  });

  it('touch: a tap picks, a finger drag sets the amount, a 2nd finger puts the amount back (camera gesture)', () => {
    const t = setup();
    t.c.bevel.begin(t.mesh.id);
    const p = t.screen(0.5, 0.5, 0.5), c = t.screen(0, 0, 0);
    const touch = { pointerType: 'touch' };
    t.fire('pointerdown', { ...touch, clientX: p.x, clientY: p.y });
    expect(t.c.bevel.state()!.phase).toBe('pick');                 // nothing on the press
    t.fire('pointerup', { ...touch, clientX: p.x + 2, clientY: p.y });
    expect(t.c.bevel.state()!.phase).toBe('adjust');               // the tap picked the corner
    expect(t.c.bevel.state()!.amount).toBe(0);
    // a drag anywhere (not on the guide) sets the amount relative to the press
    const s0 = { x: 200, y: 400 };
    t.fire('pointerdown', { ...touch, clientX: s0.x, clientY: s0.y });
    t.fire('pointermove', { ...touch, clientX: s0.x + (c.x - p.x) * 0.4, clientY: s0.y + (c.y - p.y) * 0.4 });
    t.flush();
    const a = t.c.bevel.state()!.amount;
    expect(a).toBeGreaterThan(0.05);
    t.fire('pointerup', { ...touch, clientX: s0.x + (c.x - p.x) * 0.4, clientY: s0.y + (c.y - p.y) * 0.4 });
    // the next drag starts from the current amount; a second finger aborts it
    t.fire('pointerdown', { ...touch, pointerId: 1, clientX: s0.x, clientY: s0.y });
    t.fire('pointermove', { ...touch, pointerId: 1, clientX: s0.x + (c.x - p.x) * 0.7, clientY: s0.y + (c.y - p.y) * 0.7 });
    t.flush();
    expect(t.c.bevel.state()!.amount).toBeGreaterThan(a);
    t.fire('pointerdown', { ...touch, pointerId: 2, isPrimary: false, clientX: 600, clientY: 300 });
    expect(t.c.bevel.state()!.amount).toBeCloseTo(a, 12);
    expect(t.c.bevel.state()!.dragging).toBe(false);
    t.c.bevel.cancel();
  });

  it('Ctrl while dragging snaps (inverts the Snap toggle)', () => {
    const t = setup();
    t.meshEdit.selectVertex(t.mesh.id, t.corner(1, 1, 1));
    t.c.bevel.begin(t.mesh.id);
    const p = t.screen(0.5, 0.5, 0.5), c = t.screen(0, 0, 0);
    t.fire('pointerdown', { clientX: p.x, clientY: p.y });
    t.fire('pointermove', { clientX: p.x + (c.x - p.x) * 0.37, clientY: p.y + (c.y - p.y) * 0.37, ctrlKey: true });
    t.flush();
    const a = t.c.bevel.state()!.amount;
    expect(Math.abs(a / 0.05 - Math.round(a / 0.05))).toBeLessThan(1e-9);
    t.fire('pointerup', { clientX: p.x, clientY: p.y });
    t.c.bevel.cancel();
  });

  it('leaving Edit Mesh / switching the selection mode cancels the tool (mesh back)', () => {
    const t = setup();
    const em0 = t.mesh.editMesh!;
    t.meshEdit.selectVertex(t.mesh.id, t.corner(1, 1, 1));
    t.c.bevel.begin(t.mesh.id);
    t.c.bevel.setAmount(0.3);
    t.c.setMode('edge');   // (the controller starts in face mode)
    expect(t.c.bevel.active).toBe(false);
    expect(t.mesh.editMesh).toBe(em0);
    t.c.bevel.begin(t.mesh.id);
    t.c.detach();
    expect(t.c.bevel.active).toBe(false);
  });
});

describe('Chamfer tool — guides', () => {
  it('a vertex guide points inward along the bisector of its edges (a cube corner: toward the centre)', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const v = em.vertices.findIndex(p => p.x > 0 && p.y > 0 && p.z > 0);
    const [g] = em.bevelGuides({ vertices: [v] });
    expect(g.origin).toEqual([0.5, 0.5, 0.5]);
    for (const k of [0, 1, 2]) expect(g.dir[k]).toBeCloseTo(-1 / Math.sqrt(3), 9);
    const [e] = em.bevelGuides({ edges: [[v, em.vertices.findIndex(p => p.x < 0 && p.y > 0 && p.z > 0)]] });
    expect(e.origin).toEqual([0, 0.5, 0.5]);
    expect(e.dir[1]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(e.dir[2]).toBeCloseTo(-Math.SQRT1_2, 9);
  });
});
