/**
 * mesh-edit-face-pick.test.ts — mobile-parity §7.3d item 3: the Edit Mesh face pick casts at the edit mesh only (own
 * BVH) and finds the nearest face centre through a grid, and must return EXACTLY what the old pick returned (a
 * full-scene pick3D + a scan of every face centre, kept as pickFaceFullScene) for any ray — same face, same tie rule
 * (smallest distance, then the lowest face index) — on rotated / non-uniformly scaled meshes, a mesh whose rendered
 * geometry is a modifier result (subdivision), a mesh with exact centre ties (duplicate faces), and after a vertex drag
 * patched the geometry IN PLACE (the BVH / grid must re-key, not go stale).
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { EditFacePicker, pickFaceFullScene } from './mesh-edit-face-pick';
import { EditMesh, SubdivisionModifier } from '../../scene-graph/shapes/edit-mesh';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { MeshEditPointerController } from './mesh-edit-pointer-controller';
import { MeshEditManager } from './mesh-edit-manager';
import type { Scene3DManager } from './scene3d-manager';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const W = 800, H = 600;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function editable(em: EditMesh, place?: (m: Mesh3D) => void): Mesh3D {
  const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
  place?.(mesh);
  mesh.editMesh = em;
  mesh.syncFromEditMesh();
  mesh.gpuDirty = false;   // resident (the old pick3D took its BVH path)
  return mesh;
}

/** The OLD pick: a fresh scene picker (no stale BVH) over the scene, then the scan. */
function oldPick(mesh: Mesh3D, scene: Mesh3D[], cam: Camera3D, px: number, py: number): number {
  const picker = new MeshPicker();
  const scene3d = { pick3D: (x: number, y: number, w: number, h: number) => {
    const r = picker.pickMesh(x, y, w, h, cam, scene);
    return r ? { meshId: r.mesh.id, hitPoint: r.hitPoint } : null;
  } };
  return pickFaceFullScene(scene3d, mesh.id, mesh, px, py, W, H);
}

/** Random canvas points, most of them over the mesh (around its projected centre). */
function* rays(seed: number, n: number, cam: Camera3D, mesh: Mesh3D): Generator<[number, number]> {
  const r = rng(seed);
  const m = mesh.localMatrix as unknown as Float32Array, vp = cam.getViewProjectionMatrix() as unknown as Float32Array;
  const x = m[12], y = m[13], z = m[14];
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  const sx = ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw + 1) * 0.5 * W, sy = (1 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw) * 0.5 * H;
  for (let i = 0; i < n; i++) yield [sx + (r() - 0.5) * 360, sy + (r() - 0.5) * 300];
}

function camera(): Camera3D {
  const c = new Camera3D({ position: [0.7, 1.1, 3.2], target: [0, 0, 0] });
  c.aspect = W / H;
  return c;
}

function compare(mesh: Mesh3D, scene: Mesh3D[], seed: number, n: number, fp = new EditFacePicker()) {
  const cam = camera();
  let hits = 0;
  for (const [px, py] of rays(seed, n, cam, mesh)) {
    const want = oldPick(mesh, scene, cam, px, py);
    const got = fp.pick(mesh, cam, px, py, W, H);
    expect(got, `ray (${px.toFixed(2)}, ${py.toFixed(2)})`).toBe(want);
    if (want >= 0) hits++;
  }
  return { hits, fp };
}

describe('Edit Mesh face pick — edit mesh only + face-centre grid (7.3d item 3)', () => {
  it('matches the old full-scene pick + scan on random rays (rotated, non-uniformly scaled sphere)', () => {
    const mesh = editable(EditMesh.fromSphere(0.6, 24), (m) => { m.setPosition3D(0.1, -0.05, 0.2); m.setRotation3D(0.4, 0.9, -0.2); m.setScale3D(1.3, 0.7, 1.0); });
    const faces = mesh.editMesh!.faces.length;
    const { hits, fp } = compare(mesh, [mesh], 11, 600);
    expect(hits).toBeGreaterThan(200);
    expect(fp.stats.bvhBuilds).toBe(1);
    expect(fp.stats.gridBuilds).toBe(1);
    // before: every face centre per hit; after: the few around the hit
    expect(fp.stats.facesTested / fp.stats.hits).toBeLessThan(faces / 8);  });

  it('matches on a mesh rendered through a modifier stack (picks hit the subdivided surface, centres are the cage)', () => {
    const em = EditMesh.fromBox(1, 0.8, 1.2);
    em.modifiers.push(new SubdivisionModifier(2));
    const mesh = editable(em, (m) => m.setRotation3D(0.3, -0.6, 0.1));
    expect(compare(mesh, [mesh], 23, 400).hits).toBeGreaterThan(60);
  });

  it('exact centre ties resolve to the lowest face index, as the old scan (duplicate faces)', () => {
    // a 4x4 plane of quads, then every face duplicated (identical vertex order → identical centres)
    const verts: { x: number; y: number; z: number }[] = [];
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) verts.push({ x: i * 0.4 - 0.8, y: j * 0.4 - 0.8, z: 0 });
    const quads: number[][] = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const a = j * 5 + i; quads.push([a, a + 1, a + 6, a + 5]); }
    const em = EditMesh.fromJSON({ vertices: verts, faces: [...quads, ...quads] });
    const mesh = editable(em);
    const { hits } = compare(mesh, [mesh], 5, 400);
    expect(hits).toBeGreaterThan(100);
    const cam = camera(), fp = new EditFacePicker();
    for (const [px, py] of rays(9, 200, cam, mesh)) { const f = fp.pick(mesh, cam, px, py, W, H); if (f >= 0) expect(f).toBeLessThan(16); }
  });

  it('a vertex drag that patched the geometry in place re-keys the BVH + grid (no stale pick)', () => {
    const mesh = editable(EditMesh.fromSphere(0.6, 16));
    const fp = new EditFacePicker();
    compare(mesh, [mesh], 3, 150, fp);
    const builds = fp.stats.bvhBuilds;
    const em = mesh.editMesh!;
    for (let i = 0; i < em.vertices.length; i += 3) { em.vertices[i].x *= 1.25; em.vertices[i].z += 0.15; }
    const spans = mesh.patchFromEditMesh();
    expect(spans && spans.length).toBeGreaterThan(0);
    compare(mesh, [mesh], 4, 300, fp);
    expect(fp.stats.bvhBuilds).toBe(builds + 1);
  });

  it('only the edit mesh is cast at: another mesh is neither tested nor blocks (deliberate change); a miss is -1', () => {
    const mesh = editable(EditMesh.fromBox(1, 1, 1));
    const cam = camera(), fp = new EditFacePicker();
    // a wall between the camera and the box: the old pick returned -1 behind it, the new one still finds the face
    const wall = new Mesh3D(isvc, 0.35, 0.55, 1.6, { primitive: 'box', width: 3, height: 3, depth: 0.05 });
    wall.gpuDirty = false;
    const [px, py] = [W / 2, H / 2];
    expect(oldPick(mesh, [mesh, wall], cam, px, py)).toBe(-1);
    const unblocked = oldPick(mesh, [mesh], cam, px, py);
    expect(unblocked).toBeGreaterThanOrEqual(0);
    expect(fp.pick(mesh, cam, px, py, W, H)).toBe(unblocked);
    expect(fp.pick(mesh, cam, 2, 2, W, H)).toBe(-1);   // the corner misses the box
  });

  it('the controller face tap goes through the edit-mesh picker, never the full-scene pick3D', () => {
    const mesh = editable(EditMesh.fromSphere(0.6, 12));
    const cam = camera();
    const canvas = new EventTarget() as EventTarget & Record<string, unknown>;
    Object.assign(canvas, { style: {}, width: W, height: H, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }), setPointerCapture: () => {}, releasePointerCapture: () => {} });
    let fullScene = 0;
    const scene3d = { getMesh: () => mesh, getCamera: () => cam, pick3D: () => { fullScene++; return null; } } as unknown as Scene3DManager;
    const meshEdit = new MeshEditManager({ sceneGraph: { findNodeById: () => null } } as unknown as ManagerContext, () => {});
    const c = new MeshEditPointerController(scene3d, meshEdit, () => {}, () => {});
    c.attach(canvas as unknown as HTMLCanvasElement, mesh.id);
    c.setMode('face');
    const e = new Event('pointerdown');
    Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: W / 2, clientY: H / 2, shiftKey: false });
    canvas.dispatchEvent(e);
    expect(fullScene).toBe(0);
    expect(c.facePickStats.picks).toBe(1);
    expect([...(meshEdit.getSelection(mesh.id)?.faces ?? [])]).toEqual([oldPick(mesh, [mesh], cam, W / 2, H / 2)]);
  });
});
