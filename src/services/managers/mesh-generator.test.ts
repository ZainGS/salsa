/**
 * Add Mesh live settings (mesh-generator.ts + mesh-generator-regen.ts): a parametric mesh keeps its generator params,
 * regenerates in place, survives a save, and stops offering them once Edit Mesh (or anything else outside the
 * generator) changed its geometry — while merely entering Edit Mesh does not count.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { normalizeGeneratorParams, readGeneratorRecord, type MeshGeneratorType } from '../../scene-graph/shapes/mesh-generator';
import { regenerateMeshFromGenerator, type MeshGeneratorRegenHost } from './mesh-generator-regen';
import { MeshEditManager } from './mesh-edit-manager';
import { UndoManager3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

function withGen(mesh: Mesh3D, type: MeshGeneratorType, params: Record<string, unknown>): Mesh3D {
  mesh.generator = { type, params: normalizeGeneratorParams(type, params)! };
  mesh.stampGenerator();
  return mesh;
}

function host(): MeshGeneratorRegenHost & { meshes: Map<string, Mesh3D>; removed: string[] } {
  const meshes = new Map<string, Mesh3D>();
  const removed: string[] = [];
  return {
    meshes, removed,
    getMesh: (id) => meshes.get(id) ?? null,
    addEye: (x, y, z, radius) => { const m = new Mesh3D(isvc, x, y, z, { primitive: 'sphere', radius }); meshes.set(m.id, m); return m; },
    removeMesh: (id) => { meshes.delete(id); removed.push(id); },
  };
}

function regen(mesh: Mesh3D, params: Record<string, unknown>, h = host()): void {
  const g = mesh.generator!;
  const p = normalizeGeneratorParams(g.type, { ...g.params, ...params })!;
  const parts = regenerateMeshFromGenerator(mesh, g.type, p, h);
  mesh.generator = { ...g, params: p, ...(parts ? { parts } : {}) };
  mesh.stampGenerator();
}

function editManager(mesh: Mesh3D, undo = new UndoManager3D()): MeshEditManager {
  const ctx = { sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext;
  return new MeshEditManager(ctx, (cmd) => undo.push(cmd), { peek: () => undo.peekUndo(), discardTop: () => undo.discardUndoTop() });
}

const maxY = (m: Mesh3D): number => { let y = -Infinity; const v = m.geometry.vertices; for (let i = 1; i < v.length; i += 12) y = Math.max(y, v[i]); return y; };

describe('mesh generator live settings', () => {
  it('a cylinder regenerates in place from changed params and keeps applying', () => {
    const m = withGen(new Mesh3D(isvc, 1, 2, 3, { primitive: 'cylinder', radius: 0.3, height: 0.8, radialSegments: 12 }), 'cylinder', { radius: 0.3, height: 0.8, segments: 12 });
    const id = m.id;
    expect(m.generatorApplies).toBe(true);
    const before = m.geometry;
    regen(m, { height: 2, radiusTop: 0 });
    expect(m.id).toBe(id);
    expect(m.geometry).not.toBe(before);
    expect(maxY(m)).toBeCloseTo(1, 3);   // height 2, centred
    expect(m.meshPrimitive).toBe('cylinder');
    expect(m.generatorApplies).toBe(true);
    expect(m.generator!.params).toMatchObject({ radius: 0.3, radiusTop: 0, height: 2, segments: 12 });
  });

  it('entering Edit Mesh without changing anything keeps the settings; regenerating drops the edit topology', () => {
    const m = withGen(new Mesh3D(isvc, 0, 0, 0, { primitive: 'cylinder' }), 'cylinder', {});
    const me = editManager(m);
    expect(me.makeEditable(m.id)).toBe(true);
    expect(m.meshPrimitive).toBe('custom');
    expect(m.editMesh).not.toBeNull();
    expect(m.generatorApplies).toBe(true);
    regen(m, { radius: 0.6 });
    expect(m.editMesh).toBeNull();
    expect(m.meshPrimitive).toBe('cylinder');
    expect('geometry' in m.toJSON().config).toBe(false);   // params-only again
  });

  it('an Edit Mesh change (vertex move) freezes the settings, and the save says so', () => {
    const m = withGen(new Mesh3D(isvc, 0, 0, 0, { primitive: 'revolve', profile: [[0.3, -0.4], [0.4, 0], [0.3, 0.4]], radialSegments: 16 }),
      'revolve', { profile: [[0.3, -0.4], [0.4, 0], [0.3, 0.4]], segments: 16 });
    const me = editManager(m);
    me.makeEditable(m.id);
    expect(m.generatorApplies).toBe(true);
    me.moveVertex(m.id, 0, 0, 0.2, 0);
    expect(m.generatorApplies).toBe(false);
    const saved = JSON.parse(JSON.stringify(m.toJSON()));
    expect(saved.generator.type).toBe('revolve');
    expect(saved.generator.edited).toBe(true);
    const back = readGeneratorRecord(saved.generator)!;
    expect(back.edited).toBe(true);
  });

  it('undoing the first Edit Mesh change brings the settings back; redo freezes them again', () => {
    const m = withGen(new Mesh3D(isvc, 0, 0, 0, { primitive: 'cylinder' }), 'cylinder', {});
    const undo = new UndoManager3D();
    const me = editManager(m, undo);
    me.makeEditable(m.id);
    me.moveVertex(m.id, 0, 0.3, 0, 0);
    me.extrudeFace(m.id, 0, 0.2);
    expect(m.generatorApplies).toBe(false);
    undo.undo();
    expect(m.generatorApplies).toBe(false);   // still one edit left
    undo.undo();
    expect(m.generatorApplies).toBe(true);
    undo.redo();
    expect(m.generatorApplies).toBe(false);
  });

  it('Edit Mesh topology rebuild after a regenerate under Edit Mesh: fresh topology, selection cleared', () => {
    const m = withGen(new Mesh3D(isvc, 0, 0, 0, { primitive: 'cylinder', radialSegments: 8 }), 'cylinder', { segments: 8 });
    const me = editManager(m);
    me.enterEditMode(m.id);
    me.selectVertex(m.id, 3);
    regen(m, { segments: 5 });
    expect(m.editMesh).toBeNull();
    me.rebuildEditTopology(m.id);
    expect(m.editMesh).not.toBeNull();
    expect(me.getSelection(m.id)!.vertices.size).toBe(0);
    expect(m.generatorApplies).toBe(true);
  });

  it('a circle / polygon regenerates its edit topology; an extrude freezes it', () => {
    const em = EditMesh.fromCircle(0.5, 16, 0.2);
    const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: em.compile() });
    m.editMesh = em;
    withGen(m, 'circle', { radius: 0.5, segments: 16, height: 0.2 });
    regen(m, { segments: 6, height: 1 });
    expect(m.editMesh!.vertices.length).toBe(12);
    expect(maxY(m)).toBeCloseTo(1, 4);
    expect(m.generatorApplies).toBe(true);
    editManager(m).extrudeFace(m.id, 0, 0.3);
    expect(m.generatorApplies).toBe(false);

    const pe = EditMesh.fromPolygon([[0, 0], [1, 0], [0.5, 1]], 0.2);
    const p = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: pe.compile() });
    p.editMesh = pe;
    withGen(p, 'polygon', { points: [[0, 0], [1, 0], [0.5, 1]], height: 0.2 });
    regen(p, { height: 0.5 });
    expect(maxY(p)).toBeCloseTo(0.5, 4);
    expect(p.editMesh!.vertices.length).toBe(6);
  });

  it('a flat circle (height 0, the Add Mesh default since 2026-10-09) is ONE n-gon and regenerates flat', () => {
    const em = EditMesh.fromCircle(0.5, 16, 0);
    expect(em.vertices.length).toBe(16);
    expect(em.faces.length).toBe(1);
    expect(em.getFaceVertices(0).length).toBe(16);
    const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: em.compile() });
    m.editMesh = em;
    withGen(m, 'circle', { radius: 0.5, segments: 16, height: 0 });
    regen(m, { segments: 8 });
    expect(m.editMesh!.faces.length).toBe(1);
    expect(m.editMesh!.vertices.length).toBe(8);
    expect(maxY(m)).toBeCloseTo(0, 6);
    // an older circle saved with a height keeps it
    const old = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: EditMesh.fromCircle(0.5, 16, 0.2).compile() });
    old.editMesh = EditMesh.fromCircle(0.5, 16, 0.2);
    withGen(old, 'circle', { radius: 0.5, segments: 16, height: 0.2 });
    regen(old, { segments: 6 });
    expect(maxY(old)).toBeCloseTo(0.2, 4);
    expect(old.editMesh!.faces.length).toBe(8);
  });

  it('blend shapes or material slots freeze the settings; a modifier-stack change does not', () => {
    const m = withGen(new Mesh3D(isvc, 0, 0, 0, { primitive: 'tube', path: [[0, 0, 0], [0, 1, 0]], radii: [0.1] }), 'tube', { path: [[0, 0, 0], [0, 1, 0]], radii: [0.1] });
    m.invalidateModifierCache();
    expect(m.generatorApplies).toBe(true);
    m.blendShapes = [{ name: 'k', deltaVertices: new Float32Array(6) }];
    expect(m.generatorApplies).toBe(false);
    m.blendShapes = [];
    expect(m.generatorApplies).toBe(true);
    m.submeshes = [{ indexOffset: 0, indexCount: 3, material: { ...m.material } }];
    expect(m.generatorApplies).toBe(false);
  });

  it('save → reload keeps the record (restore stamps it) and duplicates the same JSON', () => {
    const m = withGen(new Mesh3D(isvc, 0, 0, 0, { primitive: 'metaball', blobs: [{ shape: 'sphere', a: [0, 0, 0], radius: 0.3 }], resolution: 16 }),
      'metaball', { blobs: [{ shape: 'sphere', a: [0, 0, 0], radius: 0.3, blend: 0.3 }], resolution: 16 });
    const saved = JSON.parse(JSON.stringify(m.toJSON()));
    expect(saved.generator).toMatchObject({ type: 'metaball', params: { resolution: 16, decimate: 1 } });
    expect(saved.generator.edited).toBeUndefined();
    const r = new Mesh3D(isvc, 0, 0, 0, { ...saved.config, primitive: saved.primitive });
    r.generator = readGeneratorRecord(saved.generator);
    r.stampGenerator();
    expect(r.generatorApplies).toBe(true);
  });

  it('a creature regenerates its body and owns / re-places / removes its eyes', () => {
    const m = withGen(new Mesh3D(isvc, 0, 0, 0, { primitive: 'metaball', blobs: [{ shape: 'sphere', a: [0, 0, 0], radius: 0.3 }], resolution: 8 }),
      'creature', { species: 'dog', resolution: 8, eyes: true, rigged: true });
    expect(m.generator!.params.rigged).toBeUndefined();
    const h = host();
    regen(m, {}, h);
    const eyes = m.generator!.parts!;
    expect(eyes).toHaveLength(2);
    m.setPosition3D(5, 0, 0);
    regen(m, { headSize: 0.5 }, h);
    expect(m.generator!.parts).toEqual(eyes);   // same eye meshes, moved
    expect(h.meshes.get(eyes[0])!.x).toBeGreaterThan(4);
    regen(m, { eyes: false }, h);
    expect(m.generator!.parts).toEqual([]);
    expect(h.removed).toEqual(eyes);
  });

  it('untrusted records are cleaned or rejected', () => {
    expect(readGeneratorRecord(null)).toBeNull();
    expect(readGeneratorRecord({ type: 'teapot', params: {} })).toBeNull();
    expect(readGeneratorRecord({ type: 'polygon', params: { points: [[0, 0], [1, 1]] } })).toBeNull();
    expect(readGeneratorRecord({ type: 'cylinder', params: { radius: 'x', segments: 9999 } })!.params).toMatchObject({ radius: 0.3, segments: 128 });
  });
});
