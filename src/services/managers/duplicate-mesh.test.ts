/**
 * Scene3DManager.duplicateMesh keeps what the copy needs to look and move like the source: its Frame Link animation
 * (kept per mesh id — the copy had none), starting from the source's REST pose when the source is mid-animation, the
 * edit topology + vertex colours, the outline and the camera-occluder mode.
 */
import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { Scene3DManager } from './scene3d-manager';
import { DEFAULT_FRAME_LINK_ANIMATION_3D, type FrameLinkAnimation3D } from '../../types/keyframe-3d';
import type { InteractionService } from '../interaction-service';

const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** A Scene3DManager `this` with just what duplicateMesh reads. */
function host() {
  const sceneGraph = new SceneGraph();
  const frameLinkAnims = new Map<string, FrameLinkAnimation3D>();
  const flaRestTransforms = new Map<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number; applied?: number[] }>();
  const renderer3D = { setSelectedMeshIds: vi.fn(), setMeshOutline: vi.fn() };
  const proto = Object.create(Scene3DManager.prototype);
  Object.defineProperty(proto, 'renderer3D', { value: renderer3D });
  const self = Object.assign(proto, {
    ctx: { interactionService: isvc, sceneGraph, emitSceneGraphChanged: vi.fn(), setSelectedNode: vi.fn(), scheduleRender: vi.fn() },
    _undoManager: { push: vi.fn() },
    _providerOf: () => null,
    _animation: {
      frameLinkAnims, flaRestTransforms,
      getFrameLinkAnimation3D: (id: string) => frameLinkAnims.get(id) ?? null,
      setFrameLinkAnimation3D: (id: string, a: Partial<FrameLinkAnimation3D>) => {
        if (!sceneGraph.findNodeById(id)) return false;
        frameLinkAnims.set(id, { ...DEFAULT_FRAME_LINK_ANIMATION_3D, ...a }); return true;
      },
    },
    getMesh: (id: string) => { const n = sceneGraph.findNodeById(id); return n instanceof Mesh3D ? n : null; },
  }) as unknown as Scene3DManager;
  return { self, sceneGraph, frameLinkAnims, flaRestTransforms, renderer3D };
}

describe('duplicateMesh', () => {
  it('copies the Frame Link animation as an independent entry', () => {
    const { self, sceneGraph, frameLinkAnims } = host();
    const src = new Mesh3D(isvc, 1, 2, 3, { primitive: 'box' } as never);
    sceneGraph.root.addChild(src);
    frameLinkAnims.set(src.id, { ...DEFAULT_FRAME_LINK_ANIMATION_3D, enabled: true, type: 'bounce', amplitude: 0.5 });
    const copy = self.duplicateMesh(src.id)!;
    expect(copy).toBeTruthy();
    const fla = frameLinkAnims.get(copy.id)!;
    expect(fla).toMatchObject({ enabled: true, type: 'bounce', amplitude: 0.5 });
    expect(fla).not.toBe(frameLinkAnims.get(src.id));
    expect([copy.x, copy.y, copy.z]).toEqual([1.5, 2, 3]);
  });

  it('a source mid-animation: the copy starts from its rest pose (+ the usual offset)', () => {
    const { self, sceneGraph, frameLinkAnims, flaRestTransforms } = host();
    const src = new Mesh3D(isvc, 0, 1.5, 0, { primitive: 'box' } as never);   // bounced up from a rest at y = 1
    sceneGraph.root.addChild(src);
    frameLinkAnims.set(src.id, { ...DEFAULT_FRAME_LINK_ANIMATION_3D, enabled: true, type: 'bounce', amplitude: 0.5 });
    flaRestTransforms.set(src.id, { x: 0, y: 1, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, applied: [0, 1.5, 0, 0, 0, 0, 1, 1, 1] });
    const copy = self.duplicateMesh(src.id)!;
    expect([copy.x, copy.y, copy.z]).toEqual([0.5, 1, 0]);
  });

  it('no Frame Link on the source → none on the copy', () => {
    const { self, sceneGraph, frameLinkAnims } = host();
    const src = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' } as never);
    sceneGraph.root.addChild(src);
    const copy = self.duplicateMesh(src.id)!;
    expect(frameLinkAnims.has(copy.id)).toBe(false);
    expect(frameLinkAnims.size).toBe(0);
  });

  it('copies the edit topology, vertex colours, outline and camera-occluder mode (independent copies)', () => {
    const { self, sceneGraph, renderer3D } = host();
    const src = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' } as never);
    sceneGraph.root.addChild(src);
    src.editMesh = EditMesh.fromBox(1, 1, 1);
    src.vertexColors = new Float32Array([1, 0, 0, 1]);
    src.outline = { color: [1, 0, 0, 1], width: 2 } as never;
    src.cameraBlock = 'ignore';
    const copy = self.duplicateMesh(src.id)!;
    expect(copy.editMesh).toBeTruthy();
    expect(copy.editMesh).not.toBe(src.editMesh);
    expect(JSON.stringify(copy.editMesh!.toJSON())).toBe(JSON.stringify(src.editMesh.toJSON()));
    expect(Array.from(copy.vertexColors!)).toEqual([1, 0, 0, 1]);
    expect(copy.vertexColors).not.toBe(src.vertexColors);
    expect(copy.outline).toEqual(src.outline);
    expect(copy.outline).not.toBe(src.outline);
    expect(renderer3D.setMeshOutline).toHaveBeenCalledWith(copy.id, copy.outline, null);
    expect(copy.cameraBlock).toBe('ignore');
  });
});

describe('ShapeManager.duplicateMesh3D — UV-painted source', () => {
  const gu = globalThis as Record<string, unknown>;
  gu.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
  function mockDevice() {
    const copies: Array<{ from: unknown; to: unknown; size: number[] }> = [];
    const device = {
      createTexture: (d: { size: number[] }) => ({ width: d.size[0], height: d.size[1], destroy() { /* */ }, createView: () => ({}) }),
      createCommandEncoder: () => ({
        copyTextureToTexture: (a: { texture: unknown }, b: { texture: unknown }, size: number[]) => { copies.push({ from: a.texture, to: b.texture, size }); },
        finish: () => ({}),
      }),
      queue: { submit: vi.fn() },
    };
    return { device, copies };
  }

  async function setup() {
    const ShapeManager = (await import('../shape-manager')).default;
    const { RasterTextureManager } = await import('../../renderer/raster/raster-texture-manager');
    const { device, copies } = mockDevice();
    const src = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' } as never);
    const srcMgr = new RasterTextureManager(device as unknown as GPUDevice);
    const srcTex = srcMgr.ensureTexture(512, 256);
    src.diffuseTexture = srcTex; src.material.hasTexture = true;
    const textures = new Map([[src.id, srcMgr]]);
    let copy: Mesh3D | null = null;
    const sm = Object.assign(Object.create(ShapeManager.prototype), {
      _uvPaintSess: { textures },
      webgpuRenderer: { getDevice: () => device },
      scheduleRender: vi.fn(),
      scene3d: { duplicateMesh: () => {
        copy = new Mesh3D(isvc, 0.5, 0, 0, { primitive: 'box' } as never);
        copy.diffuseTexture = src.diffuseTexture; copy.material.hasTexture = true;   // what duplicateMesh does
        return copy;
      } },
    });
    return { sm, src, srcTex, textures, copies, getCopy: () => copy! };
  }

  it('the copy gets its own painted texture, registered under its id (so the save writes it)', async () => {
    const { sm, src, srcTex, textures, copies, getCopy } = await setup();
    const ret = sm.duplicateMesh3D(src.id);
    const copy = getCopy();
    expect(ret).toBe(copy);
    const mgr = textures.get(copy.id);
    expect(mgr).toBeTruthy();
    expect(mgr).not.toBe(textures.get(src.id));
    expect(copy.diffuseTexture).toBe(mgr!.getTexture());
    expect(copy.diffuseTexture).not.toBe(srcTex);
    expect(copy.material.hasTexture).toBe(true);
    expect(copies).toEqual([{ from: srcTex, to: copy.diffuseTexture, size: [512, 256] }]);
    expect(src.diffuseTexture).toBe(srcTex);   // the source keeps its own
  });

  it('a source without UV paint: nothing registered', async () => {
    const { sm, src, textures, copies } = await setup();
    textures.clear();
    sm.duplicateMesh3D(src.id);
    expect(textures.size).toBe(0);
    expect(copies.length).toBe(0);
  });
});
