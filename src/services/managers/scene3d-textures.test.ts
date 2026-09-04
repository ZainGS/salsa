import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DTextures, type Scene3DTexturesHost } from './scene3d-textures';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

// §5.1 extraction: the texture UPLOAD paths need a real GPU device, so they are browser-verified. The one piece of
// pure, subtle logic — destroyTextureIfUnshared, the use-after-free / leak guard — is GPU-free (it walks the scene
// graph comparing texture references) and IS unit-testable with a fake GPUTexture whose destroy() is a spy.

function fakeTex() {
  const t = { destroyed: false, destroy() { t.destroyed = true; } };
  return t as unknown as GPUTexture & { destroyed: boolean };
}

function makeEnv() {
  const sceneGraph = new SceneGraph();
  const interactionService = { maxGlobalZIndex: 0 } as unknown as InteractionService;
  const ctx = { sceneGraph, webgpuRenderer: {}, scheduleRender: () => {} } as unknown as ManagerContext;
  const host: Scene3DTexturesHost = {
    getMesh: (id) => (sceneGraph.findNodeById(id) as Mesh3D) ?? null,
    getAllMeshes: () => [],
  };
  const textures = new Scene3DTextures(ctx, host);
  const addMesh = () => { const m = new Mesh3D(interactionService, 0, 0, 0, { primitive: 'box' }); sceneGraph.root.addChild(m); return m; };
  return { textures, sceneGraph, addMesh };
}

describe('§5.1 Scene3DTextures — destroyTextureIfUnshared (GPU-free lifetime guard)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('destroys a texture no live mesh references', () => {
    const tex = fakeTex();
    env.textures.destroyTextureIfUnshared(tex);
    expect((tex as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it('does NOT destroy a texture a sibling mesh still references (use-after-free guard)', () => {
    const tex = fakeTex();
    const a = env.addMesh(); const b = env.addMesh();
    a.diffuseTexture = tex; b.diffuseTexture = tex;   // shared by reference (e.g. duplicateMesh)
    env.textures.destroyTextureIfUnshared(tex, a.id); // tearing down `a` — but `b` still holds it
    expect((tex as unknown as { destroyed: boolean }).destroyed).toBe(false);
  });

  it('destroys once the LAST holder is being torn down', () => {
    const tex = fakeTex();
    const a = env.addMesh();
    a.diffuseTexture = tex;
    env.textures.destroyTextureIfUnshared(tex, a.id);  // `a` is the only holder → free it
    expect((tex as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it('matches a normal-map reference too, not just diffuse', () => {
    const tex = fakeTex();
    const a = env.addMesh(); const b = env.addMesh();
    a.normalMapTexture = tex; b.normalMapTexture = tex;
    env.textures.destroyTextureIfUnshared(tex, a.id);
    expect((tex as unknown as { destroyed: boolean }).destroyed).toBe(false);
  });

  it('is a no-op for a null texture', () => {
    expect(() => env.textures.destroyTextureIfUnshared(null)).not.toThrow();
    expect(() => env.textures.destroyTextureIfUnshared(undefined)).not.toThrow();
  });
});
