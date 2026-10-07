/**
 * mesh-element-transform.test.ts — Edit Mesh ELEMENT transforms (docs/specs/edit-mesh-topology.md §11): G / R / S and
 * the selection gizmo move the selected vertices / edges / faces, not the object.
 *  - G on a selected face moves only its 4 vertices (the welded neighbours follow — they share them);
 *  - R / S about the selection's centroid; axis constraints (world + local); typed amounts;
 *  - proportional falloff (the vertex drag's curve);
 *  - Apply = ONE undo step (undo / redo exact); Cancel restores byte-exactly (Esc, right click, custom normals);
 *  - mouse-follow / finger drags patch in place == a full compile, one full compile on Apply;
 *  - the gizmo on the centroid: hidden without a selection, a handle drag moves the selection along its axis.
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
import { EditMesh, SubdivisionModifier } from '../../scene-graph/shapes/edit-mesh';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { GizmoRenderer } from '../../renderer/3d/gizmo-renderer';
import { generateBox } from '../../renderer/3d/mesh-generators';
import { Scene3DManager } from './scene3d-manager';
import type { ManagerContext } from './manager-context';
import type { Command3D } from './undo-manager-3d';
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

/** Counts every EditMesh.compile (the full path). */
const compileSpy = vi.spyOn(EditMesh.prototype, 'compile');

function setup(opts: { em?: EditMesh; orientation?: 'world' | 'local'; rotateY?: number; ortho?: boolean } = {}) {
  const camera = new Camera3D({ position: [2.2, 1.8, 3], target: [0, 0, 0], mode: opts.ortho ? 'orthographic' : 'perspective', orthoSize: 2 });
  camera.aspect = W / H;
  const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
  if (opts.rotateY) mesh.rotationY = opts.rotateY;
  const meshEdit = new MeshEditManager({ sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext, () => {});
  if (opts.em) { mesh.editMesh = opts.em; mesh.syncFromEditMesh(); } else meshEdit.makeEditable(mesh.id);
  meshEdit.enterEditMode(mesh.id);
  mesh.gpuDirty = false;
  let snap = false;
  const project = (x: number, y: number, z: number, w: number, h: number) => {
    const m = camera.getViewProjectionMatrix() as unknown as Float32Array;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0) return null;
    return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) * 0.5 * w, y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5 * h, depth: 0.5 };
  };
  const uploads: number[] = [];
  const scene3d = {
    getMesh: (id: string) => (id === mesh.id ? mesh : null), getCamera: () => camera, getTouchNavigate3D: () => false,
    getGizmoOrientation: () => opts.orientation ?? 'world',
    projectWorldToScreen3D: project,
    unprojectScreenToWorld3D: (sx: number, sy: number) => ({ x: sx / 100, y: -sy / 100, z: 0 }),
    patchMeshVertices3D: (_m: Mesh3D, _s: number, count: number) => { uploads.push(count); return true; },
    patchMeshIndices3D: () => true, noteMeshVerticesMoved3D: () => {},
  } as unknown as Scene3DManager;
  const cmds: Command3D[] = [];
  const frames: Array<() => void> = [];
  const c = new MeshEditPointerController(scene3d, meshEdit, (cmd) => cmds.push(cmd), () => {}, {
    requestFrame: (cb) => { frames.push(cb); return frames.length; }, cancelFrame: () => {},
    isSnapLatched: () => snap,
  });
  const canvas = fakeCanvas();
  c.attach(canvas, mesh.id);
  const router = c.elementTransformRouter();
  const fire = (type: string, init: Record<string, unknown> = {}) => canvas.dispatchEvent(ev(type, init));
  const flush = () => { const fs = frames.splice(0); fs.forEach(f => f()); };
  const toWorld = (p: { x: number; y: number; z: number }) => vec3.transformMat4(vec3.create(), [p.x, p.y, p.z], mesh.localMatrix as unknown as mat4);
  const screen = (p: ArrayLike<number>) => project(p[0], p[1], p[2], W, H)!;
  const em = () => mesh.editMesh!;
  const faceWhere = (pred: (v: { x: number; y: number; z: number }) => boolean) =>
    em().faces.findIndex((_, fi) => em().getFaceVertices(fi).every(vi => pred(em().vertices[vi])));
  const pos = () => em().vertices.map(v => [v.x, v.y, v.z]);
  const centroid = (vs: number[]) => {
    const s = [0, 0, 0];
    for (const i of vs) { s[0] += em().vertices[i].x; s[1] += em().vertices[i].y; s[2] += em().vertices[i].z; }
    return s.map(x => x / vs.length);
  };
  return {
    c, router, mesh, meshEdit, camera, cmds, fire, flush, toWorld, screen, faceWhere, pos, centroid, em, uploads,
    setSnap: (on: boolean) => { snap = on; },
  };
}

const bytes = (m: Mesh3D) => Array.from(m.geometry!.vertices);
const idx = (m: Mesh3D) => Array.from(m.geometry!.indices ?? []);
function bits(a: ArrayLike<number>): number[] { return Array.from(new Uint32Array(Float32Array.from(a).buffer)); }

/** A full compile of the current edit state on an exact structural clone (the live incremental state is untouched). */
function fullCompile(em: EditMesh): { v: number[]; i: number[] } {
  const c = new EditMesh();
  c.vertices = em.vertices.map(v => ({ ...v, color: [...v.color] as [number, number, number, number], uv: v.uv ? [v.uv[0], v.uv[1]] as [number, number] : undefined }));
  c.faces = em.faces.map(f => ({ ...f }));
  c.halfEdges = em.halfEdges.map(h => ({ ...h }));
  c.modifiers = em.modifiers;
  const g = c.compile();
  return { v: bits(g.vertices), i: Array.from(g.indices ?? []) };
}

const close = (a: number[], b: number[], eps = 1e-6) => a.every((x, k) => Math.abs(x - b[k]) < eps);

describe('Element transforms — G moves the selected face, not the object', () => {
  it('typed G X 0.5 on the top face moves exactly its 4 vertices; the side faces follow (shared); Apply = one undo step', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    const topVerts = t.em().getFaceVertices(top);
    expect(topVerts).toHaveLength(4);
    t.meshEdit.selectFace(t.mesh.id, top);
    const p0 = t.pos(), g0 = bytes(t.mesh), x0 = t.mesh.x;
    t.router.begin('grab');
    expect(t.router.isModal()).toBe(true);
    t.router.constrainAxis('x');
    for (const ch of '0.5') t.router.appendNumeric(ch);
    expect(t.router.numeric()).toBe('0.5');
    const p1 = t.pos();
    for (let i = 0; i < p0.length; i++) {
      if (topVerts.includes(i)) expect(p1[i]).toEqual([p0[i][0] + 0.5, p0[i][1], p0[i][2]]);
      else expect(p1[i]).toEqual(p0[i]);                      // every other vertex untouched (bit for bit)
    }
    expect(t.mesh.x).toBe(x0);                                  // the OBJECT did not move
    // a side face shares the top's vertices → its render vertices moved too (welded topology)
    const side = t.faceWhere(v => v.x > 0);
    expect(t.em().getFaceVertices(side).filter(v => topVerts.includes(v))).toHaveLength(2);
    t.router.commit();
    expect(t.router.isActive()).toBe(false);
    expect(t.cmds).toHaveLength(1);
    expect(t.cmds[0].description).toBe('Move elements');
    expect(bytes(t.mesh)).not.toEqual(g0);
    // the selection is kept (same indices — no topology change)
    expect([...t.meshEdit.getSelection(t.mesh.id)!.faces]).toEqual([top]);
  });

  it('nothing selected → nothing starts (no object fallback)', () => {
    const t = setup();
    t.router.begin('grab');
    expect(t.router.isActive()).toBe(false);
    expect(t.c.transform.begin(t.mesh.id, 'grab')).toBe(false);
  });

  it('edges and vertices: the vertex set of the selection moves', () => {
    const t = setup();
    t.c.setMode('edge');
    const e = t.em();
    const he = e.halfEdges.findIndex(h => h.twin >= 0);
    const ends = e.getHalfEdgeVertices(he)!;
    t.meshEdit.selectEdge(t.mesh.id, he);
    const p0 = t.pos();
    t.router.begin('grab'); t.router.constrainAxis('y'); t.router.appendNumeric('1');
    const p1 = t.pos();
    for (let i = 0; i < p0.length; i++) expect(p1[i][1]).toBe(ends.includes(i) ? p0[i][1] + 1 : p0[i][1]);
    t.router.cancel();
    expect(t.pos()).toEqual(p0);
  });
});

describe('Element transforms — mouse follow (desktop)', () => {
  it('G follows the mouse on the view plane (the pivot stays under the cursor); a left click applies', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectFace(t.mesh.id, top);
    const piv = t.screen(t.toWorld({ x: 0, y: 0.5, z: 0 }));
    t.fire('pointermove', { clientX: piv.x, clientY: piv.y });           // the mouse is over the pivot when G is pressed
    t.flush();
    t.router.begin('grab');
    t.fire('pointermove', { clientX: piv.x + 40, clientY: piv.y - 25 });
    t.flush();
    const c = t.centroid(verts);
    const s = t.screen(t.toWorld({ x: c[0], y: c[1], z: c[2] }));
    expect(s.x).toBeCloseTo(piv.x + 40, 3);
    expect(s.y).toBeCloseTo(piv.y - 25, 3);
    // a left click APPLIES (and is swallowed: no selection pick)
    const down = ev('pointerdown', { clientX: piv.x + 40, clientY: piv.y - 25 });
    (t.c as unknown as { _canvas: EventTarget })._canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(t.router.isActive()).toBe(false);
    expect(t.cmds).toHaveLength(1);
    expect([...t.meshEdit.getSelection(t.mesh.id)!.faces]).toEqual([top]);
  });

  it('a right click cancels (byte-exact) and swallows the context menu', () => {
    const t = setup();
    t.meshEdit.selectFace(t.mesh.id, t.faceWhere(v => v.y > 0));
    const em0 = t.mesh.editMesh, g0 = bytes(t.mesh), i0 = idx(t.mesh), p0 = t.pos();
    t.fire('pointermove', { clientX: 400, clientY: 300 }); t.flush();
    t.router.begin('grab');
    t.fire('pointermove', { clientX: 470, clientY: 240 }); t.flush();
    expect(t.pos()).not.toEqual(p0);
    t.fire('pointerdown', { button: 2, clientX: 470, clientY: 240 });
    expect(t.router.isActive()).toBe(false);
    const menu = new Event('contextmenu', { cancelable: true });
    (t.c as unknown as { _canvas: EventTarget })._canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(t.mesh.editMesh).toBe(em0);
    expect(t.pos()).toEqual(p0);
    expect(bytes(t.mesh)).toEqual(g0);
    expect(idx(t.mesh)).toEqual(i0);
    expect(t.cmds).toHaveLength(0);
  });

  it('R follows the mouse angle around the pivot (view axis, centroid fixed); S the distance ratio (uniform)', () => {
    for (const ortho of [false, true]) {
      const t = setup({ ortho });
      const top = t.faceWhere(v => v.y > 0);
      const verts = t.em().getFaceVertices(top);
      t.meshEdit.selectFace(t.mesh.id, top);
      const c0 = t.centroid(verts);
      const piv = t.screen(t.toWorld({ x: c0[0], y: c0[1], z: c0[2] }));
      t.fire('pointermove', { clientX: piv.x + 100, clientY: piv.y }); t.flush();
      t.router.begin('rotate');
      t.fire('pointermove', { clientX: piv.x, clientY: piv.y - 100 }); t.flush();   // a quarter turn on screen
      const s = t.c.transform.state()!;
      expect(Math.abs(s.angleDeg)).toBeCloseTo(90, 6);
      expect(close(t.centroid(verts), c0)).toBe(true);                              // rotation about the centroid
      // every rotated vertex keeps its distance from the pivot
      const p0 = (EditMesh.fromJSON((t.c.transform as unknown as { _before: object })._before)).vertices;
      for (const i of verts) {
        const a = p0[i], b = t.em().vertices[i];
        expect(Math.hypot(b.x - c0[0], b.y - c0[1], b.z - c0[2])).toBeCloseTo(Math.hypot(a.x - c0[0], a.y - c0[1], a.z - c0[2]), 9);
      }
      t.router.cancel();
      t.fire('pointermove', { clientX: piv.x + 50, clientY: piv.y }); t.flush();
      t.router.begin('scale');
      t.fire('pointermove', { clientX: piv.x + 100, clientY: piv.y }); t.flush();   // twice as far from the pivot
      expect(t.c.transform.state()!.factor).toBeCloseTo(2, 9);
      for (const i of verts) {
        const a = p0[i], b = t.em().vertices[i];
        expect(close([b.x - c0[0], b.y - c0[1], b.z - c0[2]], [2 * (a.x - c0[0]), 2 * (a.y - c0[1]), 2 * (a.z - c0[2])], 1e-9)).toBe(true);
      }
      t.router.commit();
      expect(t.cmds.map(c => c.description)).toEqual(['Scale elements']);
    }
  });
});

describe('Element transforms — R / S about the centroid, axis constraints', () => {
  it('typed R Y 90 turns the top face about its centroid; S X 2 doubles only its X extent', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectFace(t.mesh.id, top);
    const p0 = t.pos();
    t.router.begin('rotate'); t.router.constrainAxis('y'); for (const ch of '90') t.router.appendNumeric(ch);
    for (const i of verts) {
      // +90° about +Y (right-handed): (x, z) → (z, −x), about the centroid (0, 0.5, 0)
      expect(close(t.pos()[i], [p0[i][2], p0[i][1], -p0[i][0]], 1e-9)).toBe(true);
    }
    t.router.commit();
    const p1 = t.pos();
    t.router.begin('scale'); t.router.constrainAxis('x'); t.router.appendNumeric('2');
    for (const i of verts) expect(close(t.pos()[i], [p1[i][0] * 2, p1[i][1], p1[i][2]], 1e-9)).toBe(true);
    t.router.commit();
    expect(t.cmds.map(c => c.description)).toEqual(['Rotate elements', 'Scale elements']);
  });

  it('a mouse grab constrained to X moves along X only (Y and Z bit-identical)', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectFace(t.mesh.id, top);
    const p0 = t.pos();
    t.fire('pointermove', { clientX: 400, clientY: 300 }); t.flush();
    t.router.begin('grab');
    t.router.constrainAxis('x');
    t.fire('pointermove', { clientX: 470, clientY: 260 }); t.flush();
    const p1 = t.pos();
    for (const i of verts) { expect(p1[i][0]).not.toBe(p0[i][0]); expect(p1[i][1]).toBe(p0[i][1]); expect(p1[i][2]).toBe(p0[i][2]); }
    // the move along X is the same for every selected vertex
    expect(new Set(verts.map(i => (p1[i][0] - p0[i][0]).toFixed(12))).size).toBe(1);
    // typing an amount overrides the mouse
    t.router.appendNumeric('1');
    for (const i of verts) expect(t.pos()[i][0]).toBeCloseTo(p0[i][0] + 1, 12);
    t.router.cancel();
  });

  it('local orientation: X follows the object\'s own X axis (object rotated 90° about Y)', () => {
    const t = setup({ orientation: 'local', rotateY: Math.PI / 2 });
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectFace(t.mesh.id, top);
    const p0 = t.pos();
    t.router.begin('grab'); t.router.constrainAxis('x'); t.router.appendNumeric('1');
    // one unit along the object's X → in object space exactly +1 on x
    for (const i of verts) expect(close(t.pos()[i], [p0[i][0] + 1, p0[i][1], p0[i][2]], 1e-6)).toBe(true);
    t.router.cancel();
    // world orientation on the same rotated object: world +X = object +Z (Ry(90°) maps object +Z to world +X)
    const w = setup({ orientation: 'world', rotateY: Math.PI / 2 });
    const top2 = w.faceWhere(v => v.y > 0);
    w.meshEdit.selectFace(w.mesh.id, top2);
    const q0 = w.pos();
    w.router.begin('grab'); w.router.constrainAxis('x'); w.router.appendNumeric('1');
    for (const i of w.em().getFaceVertices(top2)) expect(close(w.pos()[i], [q0[i][0], q0[i][1], q0[i][2] + 1], 1e-6)).toBe(true);
  });

  it('snap (latch) rounds a free grab to 0.1 steps and an angle to 15°', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.setSnap(true);
    t.fire('pointermove', { clientX: 400, clientY: 300 }); t.flush();
    t.router.begin('grab');
    t.fire('pointermove', { clientX: 433, clientY: 271 }); t.flush();
    for (const d of t.c.transform.state()!.delta) expect(Math.abs(d * 10 - Math.round(d * 10))).toBeLessThan(1e-9);
    t.router.cancel();
    t.router.begin('rotate');
    t.fire('pointermove', { clientX: 452, clientY: 333 }); t.flush();
    const a = t.c.transform.state()!.angleDeg;
    expect(Math.abs(a / 15 - Math.round(a / 15))).toBeLessThan(1e-9);
    t.router.cancel();
  });
});

describe('Element transforms — proportional editing', () => {
  it('neighbours within the radius move by the falloff of their distance to the nearest selected vertex', () => {
    // a 96-face cage (subdivided box) so there are neighbours at several distances
    const cage = EditMesh.fromBox(1, 1, 1);
    cage.modifiers.push(new SubdivisionModifier(2));
    cage.applyModifier(0);
    const t = setup({ em: cage });
    const e = t.em();
    e.proportionalEditEnabled = true;
    e.proportionalEditRadius = 0.6;
    e.proportionalEditFalloff = 'linear';
    // the front-top-right-most vertex
    let vi = 0;
    e.vertices.forEach((v, i) => { const b = e.vertices[vi]; if (v.x + v.y + v.z > b.x + b.y + b.z) vi = i; });
    t.c.setMode('vertex');
    t.meshEdit.selectVertex(t.mesh.id, vi);
    const p0 = t.pos();
    t.router.begin('grab'); t.router.constrainAxis('y'); t.router.appendNumeric('1');
    let partial = 0;
    for (let i = 0; i < p0.length; i++) {
      const d = Math.hypot(p0[i][0] - p0[vi][0], p0[i][1] - p0[vi][1], p0[i][2] - p0[vi][2]);
      const w = d < 0.6 ? 1 - d / 0.6 : 0;
      expect(t.pos()[i][1]).toBeCloseTo(p0[i][1] + w, 6);
      if (w > 0 && w < 1) partial++;
    }
    expect(partial).toBeGreaterThan(3);
    // a single selected vertex: the same result as the vertex drag's moveVertex (the shared falloff)
    const ref = EditMesh.fromJSON(e.toJSON());
    for (let i = 0; i < p0.length; i++) { ref.vertices[i].x = p0[i][0]; ref.vertices[i].y = p0[i][1]; ref.vertices[i].z = p0[i][2]; }
    ref.proportionalEditEnabled = true; ref.proportionalEditRadius = 0.6; ref.proportionalEditFalloff = 'linear';
    ref.moveVertex(vi, 0, 1, 0);
    for (let i = 0; i < p0.length; i++) expect(t.pos()[i][1]).toBeCloseTo(ref.vertices[i].y, 6);
    expect(t.c.transform.state()!.affected).toBeGreaterThan(1);
    t.router.commit();
    expect(t.cmds).toHaveLength(1);
  });

  it('proportional off: only the selection moves', () => {
    const t = setup();
    t.meshEdit.selectFace(t.mesh.id, t.faceWhere(v => v.y > 0));
    t.router.begin('grab');
    expect(t.c.transform.state()!.affected).toBe(4);
    t.router.cancel();
  });
});

describe('Element transforms — undo / redo / cancel', () => {
  it('Apply is ONE undo step: undo restores the bytes, redo re-applies them', () => {
    const t = setup();
    t.meshEdit.selectFace(t.mesh.id, t.faceWhere(v => v.y > 0));
    const g0 = bytes(t.mesh);
    t.fire('pointermove', { clientX: 400, clientY: 300 }); t.flush();
    t.router.begin('grab');
    for (let k = 1; k <= 5; k++) { t.fire('pointermove', { clientX: 400 + 12 * k, clientY: 300 - 7 * k }); t.flush(); }
    t.router.commit();
    expect(t.cmds).toHaveLength(1);
    const g1 = bytes(t.mesh);
    t.cmds[0].undo();
    expect(bytes(t.mesh)).toEqual(g0);
    t.cmds[0].redo();
    expect(bytes(t.mesh)).toEqual(g1);
  });

  it('Cancel (Esc) restores byte-exactly — same EditMesh object, same geometry and indices; a no-op Apply pushes nothing', () => {
    const t = setup();
    t.meshEdit.selectFace(t.mesh.id, t.faceWhere(v => v.z > 0));
    const em0 = t.mesh.editMesh, g0 = bytes(t.mesh), i0 = idx(t.mesh), json0 = JSON.stringify(em0!.toJSON());
    for (const mode of ['grab', 'rotate', 'scale'] as const) {
      t.fire('pointermove', { clientX: 380, clientY: 310 }); t.flush();
      t.router.begin(mode);
      t.fire('pointermove', { clientX: 455, clientY: 222 }); t.flush();
      expect(bytes(t.mesh)).not.toEqual(g0);
      t.router.cancel();
      expect(t.mesh.editMesh).toBe(em0);
      expect(bytes(t.mesh)).toEqual(g0);
      expect(idx(t.mesh)).toEqual(i0);
      expect(JSON.stringify(t.mesh.editMesh!.toJSON())).toBe(json0);
    }
    t.router.begin('grab');
    t.router.commit();                               // nothing moved
    expect(t.cmds).toHaveLength(0);
    expect(bytes(t.mesh)).toEqual(g0);
  });

  it('Cancel restores custom (imported) normals exactly', () => {
    // a box whose normals are rounded (authored, not the flat face normals) → custom split normals on every corner
    const g = generateBox(1, 1, 1);
    const v = g.vertices as Float32Array;
    for (let i = 0; i < v.length; i += 12) {
      const n = vec3.normalize(vec3.create(), [v[i], v[i + 1], v[i + 2]]);
      v[i + 3] = n[0]; v[i + 4] = n[1]; v[i + 5] = n[2];
    }
    const em = EditMesh.fromGeometry(g);
    expect(em.hasCustomNormals()).toBe(true);
    const t = setup({ em });
    t.meshEdit.selectFace(t.mesh.id, t.faceWhere(p => p.y > 0));
    const g0 = bytes(t.mesh), json0 = JSON.stringify(t.mesh.editMesh!.toJSON());
    t.router.begin('grab'); t.router.constrainAxis('y'); t.router.appendNumeric('1');
    expect(bytes(t.mesh)).not.toEqual(g0);
    t.router.cancel();
    expect(bits(t.mesh.geometry!.vertices)).toEqual(bits(g0));
    expect(JSON.stringify(t.mesh.editMesh!.toJSON())).toBe(json0);
  });

  it('switching the selection mode / detaching cancels; an undo from outside ends the session', () => {
    const t = setup();
    t.meshEdit.selectFace(t.mesh.id, t.faceWhere(v => v.y > 0));
    const p0 = t.pos();
    t.router.begin('grab'); t.router.constrainAxis('x'); t.router.appendNumeric('3');
    t.c.setMode('vertex');
    expect(t.router.isActive()).toBe(false);
    expect(t.pos()).toEqual(p0);
    t.router.begin('grab'); t.router.constrainAxis('x'); t.router.appendNumeric('3');
    t.c.detach();
    expect(t.router.isActive()).toBe(false);
    expect(t.pos()).toEqual(p0);
  });
});

describe('Element transforms — fast path', () => {
  it('mouse-follow frames patch in place (no compile) == a full compile; Apply runs exactly one compile', () => {
    const cage = EditMesh.fromBox(1, 1, 1);
    cage.modifiers.push(new SubdivisionModifier(1));
    cage.applyModifier(0);
    cage.autoUnwrap();
    const t = setup({ em: cage });
    // the highest face of the (smoothed) cage
    let sel = 0;
    const minY = (fi: number) => Math.min(...t.em().getFaceVertices(fi).map(v => t.em().vertices[v].y));
    t.em().faces.forEach((_, fi) => { if (minY(fi) > minY(sel)) sel = fi; });
    t.meshEdit.selectFace(t.mesh.id, sel);
    for (const mode of ['grab', 'rotate', 'scale'] as const) {
      const geom = t.mesh.geometry;
      t.fire('pointermove', { clientX: 400, clientY: 300 }); t.flush();
      t.router.begin(mode);
      const c0 = compileSpy.mock.calls.length;
      const up0 = t.uploads.length;
      for (let k = 1; k <= 6; k++) {
        t.fire('pointermove', { clientX: 400 + 15 * k, clientY: 300 - 11 * k }); t.flush();
        const ref = fullCompile(t.mesh.editMesh!);                         // (+1 compile: the reference's own)
        expect(compileSpy.mock.calls.length).toBe(c0 + k);                // → none by the transform mid-session
        expect(t.mesh.geometry).toBe(geom);
        expect(bits(t.mesh.geometry!.vertices)).toEqual(ref.v);
        expect(idx(t.mesh)).toEqual(ref.i);
      }
      expect(t.uploads.length).toBeGreaterThan(up0);                     // only patched spans were re-sent
      const before = compileSpy.mock.calls.length;
      t.router.commit();
      expect(compileSpy.mock.calls.length - before).toBe(1);             // Apply: one full compile
    }
    expect(t.cmds.map(c => c.description)).toEqual(['Move elements', 'Rotate elements', 'Scale elements']);
  });
});

describe('Element transforms — touch (pill Grab / Rotate / Scale + one-finger drag)', () => {
  it('a finger drag moves; lifting keeps it, the next drag continues; a 2nd finger drops the live drag; Apply = one step', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectFace(t.mesh.id, top);
    const p0 = t.pos();
    t.router.begin('grab');                                            // the pill's Grab (no mouse over the canvas)
    t.router.constrainAxis('x');
    const touch = (type: string, id: number, x: number, y: number) => t.fire(type, { pointerType: 'touch', pointerId: id, isPrimary: id === 1, clientX: x, clientY: y });
    touch('pointerdown', 1, 300, 300);
    expect(t.router.isActive()).toBe(true);                            // a finger press doesn't apply
    touch('pointermove', 1, 360, 300); t.flush();
    const d1 = t.pos()[verts[0]][0] - p0[verts[0]][0];
    expect(d1).toBeGreaterThan(0);
    touch('pointerup', 1, 360, 300);
    expect(t.pos()[verts[0]][0] - p0[verts[0]][0]).toBeCloseTo(d1, 12);   // kept after the lift
    touch('pointerdown', 1, 100, 400);
    touch('pointermove', 1, 160, 400); t.flush();
    const d2 = t.pos()[verts[0]][0] - p0[verts[0]][0];
    expect(d2).toBeGreaterThan(d1 * 1.5);                              // continued from the first drag
    touch('pointerdown', 2, 500, 100);                                 // a pinch starts: the live drag is dropped
    expect(t.pos()[verts[0]][0] - p0[verts[0]][0]).toBeCloseTo(d1, 12);
    touch('pointerup', 2, 500, 100);
    touch('pointerup', 1, 160, 400);
    t.router.commit();                                                 // the pill's Apply
    expect(t.cmds).toHaveLength(1);
    expect(t.meshEdit.getSelection(t.mesh.id)!.faces.size).toBe(1);   // no tap-select happened
  });
});

describe('Element transforms — scene3d routing (sm.beginTransform3D …)', () => {
  /** A Scene3DManager shell: just the routing methods, with a spy armature (the object transform). */
  function shell(t: ReturnType<typeof setup> | null) {
    const calls: string[] = [];
    const tc = { isShortcutActive: true, shortcutMode: 'grab', shortcutAxis: 'z', shortcutNumericDisplay: '7',
      constrainAxis3D: () => calls.push('obj:axis'), appendNumericInput: () => calls.push('obj:num') };
    const s = Object.create(Scene3DManager.prototype) as Scene3DManager & Record<string, unknown>;
    Object.assign(s, {
      _playing: false, _elementXf: null,
      _armature: {
        beginTransform3D: (m: string) => calls.push('obj:begin:' + m), commitTransform3D: () => calls.push('obj:commit'),
        cancelTransform3D: () => calls.push('obj:cancel'), getTransformController: () => tc,
        setGizmoMode: (m: string) => calls.push('obj:gizmo:' + m), getDragInfo: () => ({ isDragging: false }),
      },
    });
    if (t) s.setElementTransformRouter(t.router);
    return { s, calls };
  }

  it('in Edit Mesh the G / R / S family drives the selected elements; the object path is untouched', () => {
    const t = setup();
    t.meshEdit.selectFace(t.mesh.id, t.faceWhere(v => v.y > 0));
    const { s, calls } = shell(t);
    const p0 = t.pos();
    s.beginTransform3D('grab');
    expect(s.isShortcutActive).toBe(true);
    expect(s.shortcutMode).toBe('grab');
    s.constrainAxis3D('y');
    s.appendNumericInput('2');
    expect(s.shortcutAxis).toBe('y');
    expect(s.shortcutNumericDisplay).toBe('2');
    expect(t.pos().some((p, i) => p[1] !== p0[i][1])).toBe(true);
    s.commitTransform3D();
    expect(s.isShortcutActive).toBe(false);
    expect(t.cmds).toHaveLength(1);
    s.setGizmoMode('scale');
    expect(t.c.gizmoMode).toBe('scale');
    expect(calls).toEqual(['obj:gizmo:scale']);                         // (the object gizmo mode follows too)
  });

  it('outside Edit Mesh (or without a router) everything goes to the object transform, as before', () => {
    const t = setup();
    t.meshEdit.exitEditMode();
    for (const { s, calls } of [shell(t), shell(null)]) {
      s.beginTransform3D('rotate');
      expect(s.isShortcutActive).toBe(true);                            // the object controller's
      expect(s.shortcutAxis).toBe('z');
      s.constrainAxis3D('x'); s.appendNumericInput('1'); s.commitTransform3D(); s.cancelTransform3D();
      expect(calls).toEqual(['obj:begin:rotate', 'obj:axis', 'obj:num', 'obj:commit', 'obj:cancel']);
    }
    expect(t.cmds).toHaveLength(0);
  });
});

describe('Element transforms — the gizmo on the selection', () => {
  it('sits on the selection centroid, hidden without a selection / during G / with no gizmo mode', () => {
    const t = setup();
    expect(t.c.gizmoDrawData()).toBeNull();                           // nothing selected
    const top = t.faceWhere(v => v.y > 0);
    t.meshEdit.selectFace(t.mesh.id, top);
    const g = t.c.gizmoDrawData()!;
    expect(g.mode).toBe('move');
    expect(close(g.center, [0, 0.5, 0], 1e-9)).toBe(true);
    expect(g.rotation).toBeNull();
    t.router.begin('grab');
    expect(t.c.gizmoDrawData()).toBeNull();                           // a modal transform hides it
    t.router.cancel();
    t.router.setGizmoMode('rotate');
    expect(t.c.gizmoDrawData()!.mode).toBe('rotate');
    t.router.setGizmoMode(null);
    expect(t.c.gizmoDrawData()).toBeNull();
    // local orientation: the object's rotation
    const l = setup({ orientation: 'local', rotateY: 0.7 });
    l.meshEdit.selectFace(l.mesh.id, l.faceWhere(v => v.y > 0));
    expect(Array.from(l.c.gizmoDrawData()!.rotation!)).toEqual(Array.from(GizmoRenderer.rotationOf(l.mesh.localMatrix as unknown as ArrayLike<number>)));
  });

  it('dragging the X arrow moves the selection along X only; the release applies (one step); Esc mid-drag cancels', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectFace(t.mesh.id, top);
    const p0 = t.pos();
    const centre = vec3.fromValues(0, 0.5, 0);
    const scale = GizmoRenderer.computeGizmoScale(t.camera, centre);
    const tip = t.screen([0.7 * scale, 0.5, 0]);                       // on the X arrow's shaft
    const base = t.screen(centre);
    t.fire('pointermove', { clientX: tip.x, clientY: tip.y }); t.flush();
    expect(t.c.gizmoDrawData()!.hovered).toBe('x');                    // hover highlight
    t.fire('pointerdown', { clientX: tip.x, clientY: tip.y });
    expect(t.c.transform.state()!.source).toBe('gizmo');
    expect(t.c.gizmoDrawData()!.dragging).toBe('x');
    expect(t.router.isModal()).toBe(false);                            // not a "shortcut"
    const dir = [tip.x - base.x, tip.y - base.y], len = Math.hypot(dir[0], dir[1]);
    t.fire('pointermove', { clientX: tip.x + dir[0] / len * 60, clientY: tip.y + dir[1] / len * 60 + 25 }); t.flush();
    const p1 = t.pos();
    for (const i of verts) { expect(p1[i][0]).toBeGreaterThan(p0[i][0]); expect(p1[i][1]).toBe(p0[i][1]); expect(p1[i][2]).toBe(p0[i][2]); }
    // the gizmo follows the selection
    expect(t.c.gizmoDrawData()!.center[0]).toBeCloseTo(p1[verts[0]][0] - p0[verts[0]][0], 9);
    t.fire('pointerup', { clientX: tip.x + 60, clientY: tip.y });
    expect(t.router.isActive()).toBe(false);
    expect(t.cmds).toHaveLength(1);
    expect(t.meshEdit.getSelection(t.mesh.id)!.faces.size).toBe(1);   // the press didn't re-pick
    // a 2nd drag, cancelled with Esc (router.cancel) mid-drag → back exactly
    const g1 = bytes(t.mesh), q0 = t.pos();
    const g = t.c.gizmoDrawData()!;
    const tip2 = t.screen([g.center[0] + 0.7 * GizmoRenderer.computeGizmoScale(t.camera, vec3.fromValues(...g.center)), g.center[1], g.center[2]]);
    t.fire('pointerdown', { clientX: tip2.x, clientY: tip2.y });
    t.fire('pointermove', { clientX: tip2.x + 50, clientY: tip2.y }); t.flush();
    expect(t.pos()).not.toEqual(q0);
    t.router.cancel();
    expect(t.pos()).toEqual(q0);
    expect(bytes(t.mesh)).toEqual(g1);
    expect(t.cmds).toHaveLength(1);
  });

  it('the rotate ring turns the selection about the centroid and reports its angle; a finger on a handle drags too', () => {
    const t = setup();
    const top = t.faceWhere(v => v.y > 0);
    const verts = t.em().getFaceVertices(top);
    t.meshEdit.selectFace(t.mesh.id, top);
    t.router.setGizmoMode('rotate');
    const c0 = t.centroid(verts);
    const centre = vec3.fromValues(0, 0.5, 0);
    const r = GizmoRenderer.computeGizmoScale(t.camera, centre);
    // the Y ring's near half: the point of the ring toward the camera
    const toCam = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), t.camera.position, centre));
    const a = Math.atan2(toCam[0], toCam[2]);
    const ringPt = t.screen([Math.sin(a) * r, 0.5, Math.cos(a) * r]);
    const touch = (type: string, x: number, y: number) => t.fire(type, { pointerType: 'touch', pointerId: 5, clientX: x, clientY: y });
    touch('pointerdown', ringPt.x, ringPt.y);
    const s = t.c.transform.state()!;
    expect(s.source).toBe('gizmo');
    expect(s.axis).toBe('y');
    touch('pointermove', ringPt.x + 40, ringPt.y + 10); t.flush();
    const info = t.router.dragInfo()!;
    expect(info.isDragging).toBe(true);
    expect(Math.abs(info.angleDeg!)).toBeGreaterThan(1);
    expect(close(t.centroid(verts), c0, 1e-9)).toBe(true);
    for (const i of verts) expect(t.em().vertices[i].y).toBeCloseTo(0.5, 12);   // a Y rotation keeps Y
    touch('pointerup', ringPt.x + 40, ringPt.y + 10);
    expect(t.cmds.map(c => c.description)).toEqual(['Rotate elements']);
  });
});
