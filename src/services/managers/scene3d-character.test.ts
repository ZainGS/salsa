import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DCharacter, type Scene3DCharacterHost } from './scene3d-character';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { OrbitController } from '../../renderer/3d/orbit-controller';
import type { Camera3D } from '../../renderer/3d/camera-3d';

// §5.1 character extraction. The GPU-heavy paths (mesh generation, texture upload, spring rigs) need a real
// device and are browser-verified. What IS unit-testable — and what these tests lock down — is the CPU surface
// the extraction has to preserve exactly: the default/preset providers, the overlay-rig query methods (used by
// picking + undo), the serialize/restore round-trips, and the body-param + delete-capture lifecycle.

function makeEnv() {
  const calls = { scheduleRender: 0, emitChanged: 0 };
  const sceneGraph = new SceneGraph();
  const ctx = {
    sceneGraph,
    interactionService: { maxGlobalZIndex: 0 } as unknown as InteractionService,
    webgpuRenderer: {
      addPreRenderCallback: () => {},
      removePreRenderCallback: () => {},
      getDevice: () => null,
    },
    scheduleRender: () => { calls.scheduleRender++; },
    emitSceneGraphChanged: () => { calls.emitChanged++; },
  } as unknown as ManagerContext;

  const meshes = new Map<string, Mesh3D>();
  const host: Scene3DCharacterHost = {
    getMesh: (id) => meshes.get(id) ?? null,
    getAllMeshes: () => [...meshes.values()],
    getOrbitController: () => null as unknown as OrbitController,
    getCamera: () => ({}) as unknown as Camera3D,
    setRenderStyle: () => {},
    keepSpringsAlive: () => {},
  };
  return { ctx, host, meshes, calls };
}

const ALL_SLOTS = ['top', 'bottom', 'shoes', 'socks', 'undershirt', 'underpants'] as const;

describe('§5.1 Scene3DCharacter (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  let ch: Scene3DCharacter;
  beforeEach(() => { env = makeEnv(); ch = new Scene3DCharacter(env.ctx, env.host); });

  it('provides defaults + presets for every clothing slot without touching the GPU', () => {
    for (const slot of ALL_SLOTS) {
      const def = ch.getDefaultClothingParams(slot);
      expect(def).toBeTruthy();
      expect(def.slot).toBe(slot);
      expect(Array.isArray(ch.getClothingPresetNames(slot))).toBe(true);
    }
    expect(ch.getDefaultHairParams()).toBeTruthy();
    expect(ch.getDefaultEyeParams()).toBeTruthy();
    // getDefaultHairParams returns a COPY (mutating it must not poison the shared default).
    const h1 = ch.getDefaultHairParams(); (h1 as { length?: number }).length = 999;
    expect((ch.getDefaultHairParams() as { length?: number }).length).not.toBe(999);
  });

  it('exposes the attachment catalog with per-type defaults', () => {
    const types = ch.attachmentTypeNames();
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) {
      expect(ch.getDefaultAttachmentParams(t)).toBeTruthy();
      expect(ch.getDefaultAttachmentPlacement(t)).toBeTruthy();
    }
  });

  it('all overlay-query methods are empty/null on a fresh subsystem', () => {
    expect(ch.hasFace('body')).toBe(false);
    expect(ch.hasOverlayBody('body')).toBe(false);
    expect(ch.overlayBodyOf('anything')).toBeNull();
    expect(ch.overlayMeshIds('body')).toEqual([]);
    expect(ch.getHairParams('body')).toBeNull();
    expect(ch.getHairMeshId('body')).toBeNull();
    expect(ch.getEyesMeshId('body')).toBeNull();
    expect(ch.getFaceDecalMeshId('body')).toBeNull();
    expect(ch.getClothingParams('body', 'top')).toBeNull();
    expect(ch.getClothingMeshId('body', 'top')).toBeNull();
    expect(ch.getBodyParams('body')).toBeNull();
    expect(ch.prepareFaceRigDeletion('body')).toBeNull();
  });

  it('serialize methods return empty collections with no rigs registered', () => {
    expect(ch.serializeClothingRigs()).toEqual([]);
    expect(ch.serializeHairRigs()).toEqual([]);
    expect(ch.serializeAttachments()).toEqual([]);
    expect(ch.serializeBodyParams()).toEqual([]);
    expect(ch.serializeFaceRigs()).toEqual([]);
  });

  it('registerBody stores params; getBodyParams + serialize round-trip them', () => {
    const params = { height: 1.7, tag: 'a' } as unknown as import('./body-generator').BodyParams;
    ch.registerBody('body', params, [] as never, [] as never, [] as never);
    expect(ch.getBodyParams('body')).toBe(params);

    const serialized = ch.serializeBodyParams();
    expect(serialized).toEqual([{ bodyMeshId: 'body', params }]);

    // restore into a fresh subsystem reproduces the same body params
    const fresh = new Scene3DCharacter(env.ctx, env.host);
    fresh.restoreBodyParams(serialized);
    expect(fresh.getBodyParams('body')).toEqual(params);
    // restoreBodyParams tolerates undefined/empty
    expect(() => fresh.restoreBodyParams(undefined)).not.toThrow();
  });

  it('captureBodyOverlaysForDeletion drops then restores a registered body`s params (undo contract)', () => {
    const params = { height: 1.6 } as unknown as import('./body-generator').BodyParams;
    ch.registerBody('body', params, [] as never, [] as never, [] as never);
    const cap = ch.captureBodyOverlaysForDeletion('body');

    cap.drop();
    expect(ch.getBodyParams('body')).toBeNull();   // dropped
    cap.restore();
    expect(ch.getBodyParams('body')).toBe(params);  // undo brings the exact value back

    // capturing a body with no overlays is a harmless no-op
    const empty = ch.captureBodyOverlaysForDeletion('ghost');
    expect(() => { empty.drop(); empty.restore(); }).not.toThrow();
  });

  it('skin tone reads/writes through the host mesh material', () => {
    const fakeMesh = {
      material: { diffuse: { r: 0, g: 0, b: 0 } },
      gpuDirty: false,
      setDiffuseColor(r: number, g: number, b: number) { this.material.diffuse = { r, g, b }; },
    };
    env.meshes.set('body', fakeMesh as unknown as Mesh3D);

    expect(ch.getSkinTone('body')).toBe('#000000');
    ch.setSkinTone('body', '#ff8000');
    expect(ch.getSkinTone('body')).toBe('#ff8000');
    expect(env.calls.scheduleRender).toBeGreaterThan(0);

    // missing mesh → null, no throw
    expect(ch.getSkinTone('nope')).toBeNull();
    expect(() => ch.setSkinTone('nope', '#fff')).not.toThrow();
  });
});
