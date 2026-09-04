import { describe, it, expect } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { DecalManager, type DecalManagerHost } from './decal-manager';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import type { ManagerContext } from './manager-context';
import type { Scene3DManager } from './scene3d-manager';
import type { EphemeraService } from '../ephemera/ephemera-service';

// Decal placement/tool/texture route through scene3d picking, GPU texture upload, and canvas pointer listeners
// (browser-only). These pin the CPU-safe surface the god-object used to own inline: the registry accessors, the
// missing-id guards, the tool-inactive no-ops, and that placeDecal3D registers a decal + returns its container id.
function makeEnv() {
    const calls = { scheduleRender: 0, emitChanged: 0 };
    const sceneGraph = new SceneGraph();
    let cid = 0;
    const rootGroups: unknown[] = [];
    const scene3d = {
        getRootMeshGroups: () => rootGroups,
        getMesh: () => null,
        createCityContainer: (name: string) => ({ id: `decal-${++cid}`, name, thinWrapper: false, documentSkipChildren: false, worldParams: null, addChild() {} }),
        removeFlatColorMeshGroup: () => {},
        getCamera: () => ({ position: [0, 0, 10] }),
        setMeshTexture: async () => true,
        pickFromClient3D: () => null,
        pickMeshFromClient3D: () => null,
        screenToMeshUV3D: () => null,
    } as unknown as Scene3DManager;
    const ctx = {
        sceneGraph,
        interactionService: { maxGlobalZIndex: 0 },
        webgpuRenderer: { getRenderer3D: () => ({ setHoveredMeshIds() {} }), getCanvas: () => null, getDevice: () => null },
        scheduleRender: () => { calls.scheduleRender++; },
        emitSceneGraphChanged: () => { calls.emitChanged++; },
    } as unknown as ManagerContext;
    const host: DecalManagerHost = { scene3d, ephemera: {} as EphemeraService, uvPaintTextures: new Map() };
    return { mgr: new DecalManager(ctx, host), calls };
}

describe('DecalManager (Mode A)', () => {
    it('starts empty: no place-mode, no decals', () => {
        const { mgr } = makeEnv();
        expect(mgr.decalPlaceModeActive).toBe(false);
        expect(mgr.isDecal3D('x')).toBe(false);
        expect(mgr.listDecals3D()).toEqual([]);
    });

    it('mutators on a missing decal id return false', () => {
        const { mgr } = makeEnv();
        expect(mgr.removeDecal3D('nope')).toBe(false);
        expect(mgr.setDecalSize3D('nope', 0.3)).toBe(false);
        expect(mgr.setDecalRotation3D('nope', 45)).toBe(false);
    });

    it('setDecalSource3D resolves false for a missing decal', async () => {
        expect(await makeEnv().mgr.setDecalSource3D('nope', { kind: 'image', dataUrl: 'x' })).toBe(false);
    });

    it('tool-size/rotation are no-ops while no place session is active', () => {
        const { mgr } = makeEnv();
        expect(() => mgr.setDecalToolSize3D(0.5)).not.toThrow();
        expect(() => mgr.setDecalToolRotation3D(30)).not.toThrow();
        expect(mgr.decalPlaceModeActive).toBe(false);
    });

    it('placeDecal3D registers a decal and returns its container id', () => {
        const { mgr } = makeEnv();
        const id = mgr.placeDecal3D({ kind: 'image', dataUrl: 'data:' }, { hitPoint: [0, 1, 0], faceNormal: [0, 0, 1] }, { size: 0.5 });
        expect(id).toMatch(/^decal-/);
        expect(mgr.isDecal3D(id)).toBe(true);
        expect(mgr.listDecals3D().map(d => d.id)).toContain(id);
    });

    it('restoreDecalsFromSave3D returns 0 when the scene has no decal markers', () => {
        expect(makeEnv().mgr.restoreDecalsFromSave3D()).toBe(0);
    });

    it('Mode B stamp resolves false when the mesh / device / UV cannot resolve', async () => {
        const { mgr } = makeEnv();   // getMesh → null, getDevice → null, screenToMeshUV3D → null
        expect(await mgr.stampDecalAtUV3D('m', { kind: 'image', dataUrl: 'x' }, 0.5, 0.5)).toBe(false);
        expect(await mgr.stampDecalAtScreen3D('m', { kind: 'image', dataUrl: 'x' }, 0, 0, { left: 0, top: 0, width: 1, height: 1 })).toBe(false);
    });
});
