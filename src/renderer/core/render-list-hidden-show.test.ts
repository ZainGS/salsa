/**
 * Host 3D render list vs. visibility (performance-plan.md §P15, draw-bug 2026-10-04).
 *
 * The host caches the scene's 3D nodes (_rebuild3DLists) and re-walks them only on a render-list rebuild (a structure
 * change / requestBackgroundRender). It used to DROP hidden nodes there, so a node hidden at the last rebuild and shown
 * again with only a scheduleRender — the eye decal when its expression texture lands, the face kit, a script-destroyed
 * mesh restored on Stop — stayed out of every frame ("not drawn until something forces a redraw or a scale change").
 * The lists now keep hidden nodes; draw3DMeshes filters `visible` per frame. Drives the REAL methods on a minimal host.
 */
import { describe, it, expect } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

describe('host 3D render list keeps hidden nodes', () => {
    it('a skinned part hidden across a rebuild is drawn as soon as it is shown again (no structure event)', async () => {
        const { WebGPURenderer } = await import('./webgpu-renderer');
        const { SkinnedMesh3D } = await import('../../scene-graph/shapes/skinned-mesh-3d');
        const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
        const geo = () => ({ primitive: 'custom' as const, geometry: { vertices: new Float32Array(36), indices: new Uint32Array([0, 1, 2]), format: '12float' as const } });
        const body = new SkinnedMesh3D(isvc, 0, 0, 0, geo());
        const eyes = new SkinnedMesh3D(isvc, 0, 0, 0, geo());
        const prop = new Mesh3D(isvc, 0, 0, 0, geo());
        body.name = 'body'; eyes.name = 'eyes'; prop.name = 'prop';

        const skinnedDrawn: unknown[][] = [];
        const r3 = {
            skinnedLastCount: 0,
            applySceneDepthRange() { /* */ }, clearPostOverlays() { /* */ }, noStaticMeshesThisFrame() { /* */ },
            drawArtboardTextureIfActive() { /* */ }, setSelectableMeshes() { /* */ }, drawMeshes() { /* */ },
            drawSkinnedMeshes(_p: unknown, list: unknown[]) { skinnedDrawn.push([...list]); },
        };
        // The fields the two real methods read (everything else of the host is irrelevant here).
        const host = Object.assign(Object.create(WebGPURenderer.prototype), {
            _flat3D: [body, eyes, prop], _rl3DMeshes: [], _rl3DEmitters: [], _rl3DGp: [], _rl3DSkinned: new Uint8Array(64),
            _rlSplit: true, _allMeshesScratch: [], _regularMeshesScratch: [], _skinnedMeshesScratch: [],
            _hiddenVectorLayerIds: new Set<string>(), _frameMeshEditHides: null, _rlIndex: { any3DBelowRaster: false },
            _renderer3D: r3, _overlays3DPending: false,
        }) as Record<string, (...a: unknown[]) => unknown>;
        const pass = {} as GPURenderPassEncoder;
        const frame = () => { host.draw3DMeshes(pass, [], 800, 600, true); return ((skinnedDrawn[skinnedDrawn.length - 1] ?? []) as { name: string }[]).map((m) => m.name); };

        // The eye decal is created hidden (its texture is not ready) and a structure change rebuilds the list then.
        eyes.visible = false;
        host._rebuild3DLists();
        expect(frame()).toEqual(['body']);              // hidden → not drawn (per-frame filter)

        // The texture lands: visible = true + scheduleRender only — NO rebuild in between.
        eyes.visible = true;
        expect(frame()).toEqual(['body', 'eyes']);        // was [body]: the stale list had dropped it until a structure change
    });
});
