/**
 * mesh-edit-drag-patch.test.ts — mobile-parity §7.3d item 2: a vertex drag in Edit Mesh patches the compiled geometry
 * IN PLACE (only the triangles around the moved vertices: positions + flat normals / tangents) and re-sends only those
 * vertex spans, instead of recompiling + re-uploading the whole mesh every frame.
 *  - after every drag frame the CPU geometry is BIT-identical to a fresh full compile, and every changed vertex lies
 *    inside an uploaded span;
 *  - mid-drag frames never run the full compile; release runs exactly one (the final state is the full path's);
 *  - proportional editing (many vertices move) and cancel stay exact;
 *  - the patch is refused (full recompile) with a modifier stack, and a span the renderer cannot take sets gpuDirty.
 */
import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { MeshEditPointerController } from './mesh-edit-pointer-controller';
import { MeshEditManager } from './mesh-edit-manager';
import { EditMesh, MirrorModifier, SubdivisionModifier } from '../../scene-graph/shapes/edit-mesh';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import type { Scene3DManager } from './scene3d-manager';
import type { ManagerContext } from './manager-context';
import type { Command3D } from './undo-manager-3d';
import type { InteractionService } from '../interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** A cage with many quads (a twice-subdivided box, baked) — 96 faces. */
function cage(): EditMesh {
  const em = EditMesh.fromBox(1, 1, 1);
  em.modifiers.push(new SubdivisionModifier(2));
  em.applyModifier(0);
  em.autoUnwrap();
  return em;
}

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
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0, shiftKey: false, ...init });
  return e;
}

function setup(opts: { em?: EditMesh; patchOk?: boolean } = {}) {
  const camera = new Camera3D({ position: [0, 0.6, 3], target: [0, 0, 0] });
  camera.aspect = 800 / 600;
  const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
  mesh.editMesh = opts.em ?? cage();
  mesh.syncFromEditMesh();
  mesh.gpuDirty = false;   // resident
  const uploads: { start: number; count: number }[] = [];
  let moved = 0;
  const project = (x: number, y: number, z: number, w: number, h: number) => {
    const m = camera.getViewProjectionMatrix() as unknown as Float32Array;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0) return null;
    return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) * 0.5 * w, y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5 * h, depth: 0.5 };
  };
  const scene3d = {
    getMesh: () => mesh,
    getCamera: () => camera,
    getTouchNavigate3D: () => false,
    projectWorldToScreen3D: project,
    unprojectScreenToWorld3D: (sx: number, sy: number) => ({ x: sx / 100, y: -sy / 100, z: 0 }),
    patchMeshVertices3D: (_m: Mesh3D, start: number, count: number) => { uploads.push({ start, count }); return opts.patchOk ?? true; },
    noteMeshVerticesMoved3D: () => { moved++; },
  } as unknown as Scene3DManager;
  const meshEdit = new MeshEditManager({ sceneGraph: { findNodeById: () => null } } as unknown as ManagerContext, () => {});
  const cmds: Command3D[] = [];
  const frames: Array<() => void> = [];
  const c = new MeshEditPointerController(scene3d, meshEdit, (cmd) => cmds.push(cmd), () => {}, {
    requestFrame: (cb) => { frames.push(cb); return frames.length; }, cancelFrame: () => {},
  });
  const canvas = fakeCanvas();
  c.attach(canvas, mesh.id);
  c.setMode('vertex');
  const fire = (type: string, init: Record<string, unknown>) => canvas.dispatchEvent(ev(type, init));
  const flush = () => { const fs = frames.splice(0); fs.forEach(f => f()); };
  // The front-most vertex (largest z, then y) — projected inside the canvas, nothing nearer on screen.
  const em = mesh.editMesh;
  let best = 0;
  for (let i = 1; i < em.vertices.length; i++) {
    const a = em.vertices[i], b = em.vertices[best];
    if (a.z > b.z + 1e-9 || (Math.abs(a.z - b.z) <= 1e-9 && a.y > b.y)) best = i;
  }
  const s = project(em.vertices[best].x, em.vertices[best].y, em.vertices[best].z, 800, 600)!;
  const base = compileSpy.mock.calls.length - referenceCompiles;
  const compile = { count: () => compileSpy.mock.calls.length - referenceCompiles - base };
  return { c, mesh, fire, flush, at: { clientX: s.x, clientY: s.y }, uploads, cmds, moved: () => moved, compile, meshEdit };
}

/** Counts every EditMesh.compile (the full path), whichever EditMesh instance runs it. */
const compileSpy = vi.spyOn(EditMesh.prototype, 'compile');

/** A fresh full compile of the mesh's current edit state (on a clone, so the live incremental state is untouched). */
let referenceCompiles = 0;   // (the test's own reference compiles, not counted as the controller's)
function fullCompile(em: EditMesh): Float32Array {
  referenceCompiles++;
  // (an exact structural clone — a toJSON/fromJSON round trip rotates each face's start vertex, so its fan differs)
  const c = new EditMesh();
  c.vertices = em.vertices.map(v => ({ ...v, color: [...v.color] as [number, number, number, number], uv: v.uv ? [v.uv[0], v.uv[1]] as [number, number] : undefined }));
  c.faces = em.faces.map(f => ({ ...f }));
  c.halfEdges = em.halfEdges.map(h => ({ ...h }));
  c.modifiers = em.modifiers;
  return c.compile().vertices as Float32Array;
}
function bits(a: Float32Array): Uint32Array { return new Uint32Array(a.buffer, a.byteOffset, a.length); }

describe('Mesh Edit vertex drag — in-place patch (7.3d item 2)', () => {
  it('mid-drag frames patch in place (no compile), bit-identical to a full compile; uploads cover exactly the changes', () => {
    const t = setup();
    const nVerts = t.mesh.geometry.vertices.length / FLOATS_PER_VERT;
    t.fire('pointerdown', { ...t.at });
    expect(t.meshEdit.getSelection(t.mesh.id)?.vertices.size).toBe(1);
    const geomBefore = t.mesh.geometry;
    const c0 = t.compile.count();
    const FRAMES = 12;
    for (let f = 1; f <= FRAMES; f++) {
      const prev = (t.mesh.geometry.vertices as Float32Array).slice();
      t.uploads.length = 0;
      t.fire('pointermove', { clientX: t.at.clientX + f * 7, clientY: t.at.clientY - f * 3 });
      t.flush();
      const cur = t.mesh.geometry.vertices as Float32Array;
      expect(t.mesh.geometry).toBe(geomBefore);                         // patched in place, not replaced
      expect(bits(cur)).toEqual(bits(fullCompile(t.mesh.editMesh!)));    // == the full path, bit for bit
      // every changed vertex is inside an uploaded span
      const pb = bits(prev), cb = bits(cur);
      for (let v = 0; v < nVerts; v++) {
        let changed = false;
        for (let k = 0; k < FLOATS_PER_VERT; k++) if (pb[v * FLOATS_PER_VERT + k] !== cb[v * FLOATS_PER_VERT + k]) { changed = true; break; }
        if (changed) expect(t.uploads.some(u => v >= u.start && v < u.start + u.count)).toBe(true);
      }
    }
    expect(t.compile.count() - c0).toBe(0);                 // no full compile mid-drag
    expect(t.mesh.gpuDirty).toBe(false);                     // no pool rebuild
    expect(t.c.dragStats.patches).toBe(FRAMES);
    expect(t.c.dragStats.fullSyncs).toBe(0);
    expect(t.moved()).toBe(FRAMES);
    const perFrameVerts = t.c.dragStats.uploadVerts / FRAMES;
    expect(perFrameVerts).toBeLessThan(nVerts / 4);          // a few triangles, not the mesh
    t.fire('pointerup', { clientX: t.at.clientX + FRAMES * 7, clientY: t.at.clientY - FRAMES * 3 });
    expect(t.compile.count() - c0).toBe(1);                 // ONE full recompile on release
    expect(t.c.dragStats.fullSyncs).toBe(1);
    expect(t.cmds).toHaveLength(1);
    expect(bits(t.mesh.geometry.vertices as Float32Array)).toEqual(bits(fullCompile(t.mesh.editMesh!)));
    // before 7.3d: FRAMES full compiles + FRAMES whole-mesh uploads (pool rebuilds)
    const report = {
      faces: t.mesh.editMesh!.faces.length, gpuVerts: nVerts, frames: FRAMES,
      before: { compiles: FRAMES, uploadBytes: FRAMES * nVerts * 48 },
      after: { compiles: 1, patches: t.c.dragStats.patches, spans: t.c.dragStats.spans, uploadBytes: t.c.dragStats.uploadBytes },
    };
    expect(report.after.uploadBytes).toBeLessThan(report.before.uploadBytes / 4);  });

  it('proportional editing (many vertices move) stays bit-exact; a cancel restores via the full path', () => {
    const t = setup();
    t.mesh.editMesh!.proportionalEditEnabled = true;
    t.mesh.editMesh!.proportionalEditRadius = 0.6;
    t.fire('pointerdown', { ...t.at });
    const c0 = t.compile.count();
    for (let f = 1; f <= 6; f++) {
      t.fire('pointermove', { clientX: t.at.clientX + f * 10, clientY: t.at.clientY + f * 4 });
      t.flush();
      expect(bits(t.mesh.geometry.vertices as Float32Array)).toEqual(bits(fullCompile(t.mesh.editMesh!)));
    }
    expect(t.compile.count() - c0).toBe(0);
    const before = EditMesh.fromJSON(t.mesh.editMesh!.toJSON());
    t.fire('pointercancel', {});
    expect(t.compile.count() - c0).toBe(1);   // the restore recompiles
    expect(t.cmds).toHaveLength(0);
    expect(t.mesh.editMesh!.vertices.map(v => v.x)).not.toEqual(before.vertices.map(v => v.x));   // moved back
    expect(bits(t.mesh.geometry.vertices as Float32Array)).toEqual(bits(fullCompile(t.mesh.editMesh!)));
  });

  it('a modifier stack refuses the patch → the full recompile per frame (as before)', () => {
    const em = cage();
    em.modifiers.push(new MirrorModifier('x', false));
    const t = setup({ em });
    t.fire('pointerdown', { ...t.at });
    const c0 = t.compile.count();
    for (let f = 1; f <= 3; f++) { t.fire('pointermove', { clientX: t.at.clientX + f * 9, clientY: t.at.clientY }); t.flush(); }
    expect(t.compile.count() - c0).toBe(3);
    expect(t.c.dragStats.patches).toBe(0);
    expect(t.c.dragStats.fullSyncs).toBe(3);
    expect(t.uploads).toHaveLength(0);
  });

  it('a span the renderer cannot take marks gpuDirty (the pool re-uploads the patched CPU copy)', () => {
    const t = setup({ patchOk: false });
    t.fire('pointerdown', { ...t.at });
    t.fire('pointermove', { clientX: t.at.clientX + 20, clientY: t.at.clientY });
    t.flush();
    expect(t.c.dragStats.patches).toBe(1);
    expect(t.c.dragStats.gpuDirty).toBe(1);
    expect(t.mesh.gpuDirty).toBe(true);
    expect(t.moved()).toBe(0);
    expect(bits(t.mesh.geometry.vertices as Float32Array)).toEqual(bits(fullCompile(t.mesh.editMesh!)));
  });

  it('EditMesh.patchCompiledPositions refuses a stale baseline (topology change / another geometry)', () => {
    const em = cage();
    const g = em.compile();
    expect(em.patchCompiledPositions(g)).toEqual([]);                 // nothing moved
    em.vertices[3].x += 0.1;
    const spans = em.patchCompiledPositions(g)!;
    expect(spans.length).toBeGreaterThan(0);
    expect(bits(g.vertices as Float32Array)).toEqual(bits(fullCompile(em)));
    expect(em.patchCompiledPositions(EditMesh.fromBox().compile())).toBeNull();   // not this mesh's last compile
    em.extrudeFace(0, 0.2);                                            // topology rebuilt
    expect(em.patchCompiledPositions(g)).toBeNull();
  });
});
