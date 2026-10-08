/**
 * Skinned draws under on-demand rendering (performance-plan.md §P15, draw-bug 2026-10-04).
 *
 * A freshly created character draws through the skinned pipelines. In a LIVE frame (GPUPipelineCache.frame) a pipeline
 * that is still compiling returns null and the part is skipped; the cache's ready event must then ask for the frame
 * that draws it, and the frame stats must say the part is WAITING, not drawn (they used to count it as drawn before
 * the pipeline check, so a character invisible for seconds read "9/9 drawn" — the misleading half of the bug report).
 * Real Renderer3D over a recording device whose async compiles land only when the test says so; no wall-clock
 * assertions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

type Pending = { label: string; resolve: () => void };

function controlledDevice() {
    const pending: Pending[] = [];
    const handler: ProxyHandler<() => unknown> = {
        get(_t, k) {
            if (k === 'then') return undefined;
            if (k === Symbol.toPrimitive) return () => 0;
            if (k === 'size') return 1 << 30;
            if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
            if (typeof k === 'string' && k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
            return stub;
        },
        apply() { return stub; },
    };
    const stub: unknown = new Proxy(function () { /* stub */ }, handler);
    const queue = new Proxy({}, { get: (_t, k) => (k === 'onSubmittedWorkDone' ? () => new Promise(() => { /* never */ }) : stub) });
    const asyncCompile = (d: { label?: string }) => new Promise((res) => { pending.push({ label: d?.label ?? '', resolve: () => res({ label: d?.label }) }); });
    const device = new Proxy({}, { get: (_t, k) => {
        if (k === 'queue') return queue;
        if (k === 'features') return { has: () => false };
        if (k === 'createRenderPipelineAsync' || k === 'createComputePipelineAsync') return asyncCompile;
        if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
        if (k === 'createBuffer') return (d: { size: number }) => ({ size: d.size, destroy() { /* */ }, label: '', mapAsync: () => new Promise(() => { /* */ }) });
        if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
        return stub;
    } });
    return { device: device as unknown as GPUDevice, pending };
}

beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    const flags = new Proxy({}, { get: () => 1 });
    for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

const flush = async (k = 6) => { for (let i = 0; i < k; i++) await Promise.resolve(); };

describe('skinned draws under on-demand rendering', () => {
    // SHADER SPLIT: the part draws with its generated skinned pipeline (the only mesh pipelines since phase 4).
    it('a part whose skinned pipeline is compiling is WAITING (not drawn), and the landed compile requests the frame that draws it', async () => {
        await scenario();
    });
});

async function scenario(): Promise<void> {
        const { Renderer3D } = await import('./renderer-3d');
        const { Camera3D } = await import('./camera-3d');
        const { SkinnedMesh3D } = await import('../../scene-graph/shapes/skinned-mesh-3d');
        const { Skeleton3D } = await import('../../scene-graph/shapes/skeleton-3d');
        const { GPUPipelineCache } = await import('../core/gpu-pipeline-cache');

        const cam = new Camera3D({ position: [0, 0.5, 3], target: [0, 0.5, 0] });
        const { device, pending } = controlledDevice();
        const r = new Renderer3D(device, cam) as unknown as Record<string, any>;
        const cache = GPUPipelineCache.for(device);

        // A one-joint "character" part: a quad in front of the camera, fully weighted to the root.
        const verts = new Float32Array(4 * 12);
        const P = [[-0.3, 0, 0], [0.3, 0, 0], [0.3, 1, 0], [-0.3, 1, 0]];
        for (let i = 0; i < 4; i++) { verts[i * 12] = P[i][0]; verts[i * 12 + 1] = P[i][1]; verts[i * 12 + 2] = P[i][2]; verts[i * 12 + 5] = 1; }
        const mesh = new SkinnedMesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: verts, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), format: '12float' } });
        mesh.transformViaSkeleton = true;
        mesh.jointIndices = new Uint8Array(16);
        mesh.jointWeights = new Float32Array(16); for (let i = 0; i < 4; i++) mesh.jointWeights[i * 4] = 1;
        mesh.skinDirty = true;
        const skel = new Skeleton3D({ name: 'char', joints: [], clips: [] });
        skel.addJoint(-1, [0, 0, 0], 'root');
        skel.computeInverseBindMatrices();
        skel.computeWorldMatrices();
        mesh.skeleton = skel; mesh.skeletonId = skel.id;

        const splitSkinnedReady = (): boolean => r.setShaderSplit({}).list.some((e: { axis: string; key: string; ready: boolean }) => e.axis === 'skinned' && e.ready);

        let draws = 0;
        const pass = new Proxy({}, { get: (_t, k) => (k === 'drawIndexed' ? () => { draws++; } : () => { /* */ }) }) as unknown as GPURenderPassEncoder;
        let readyFrames = 0;
        cache.onPipelineReady(() => { readyFrames++; });   // the host's scheduleRender
        const liveFrame = () => cache.frame(() => r.drawSkinnedMeshes(pass, [mesh], 800, 600));

        // Frame 1 — the pipeline compiles asynchronously: the part is skipped, and the stats must say so.
        liveFrame();
        let fs = r.getFrameStats3D();
        expect(draws).toBe(0);
        expect(fs.skinnedMeshes).toBe(1);
        expect(fs.skinnedDrawn).toBe(0);          // was 1: counted before the pipeline check
        expect(fs.skinnedWaiting).toBe(1);
        expect(cache.status().waitingDraws).toBeGreaterThan(0);   // the skip is a WAITED draw → a ready event will follow

        // Nothing else happens (no input): the compiles land → the ready event asks for a frame.
        for (let i = 0; i < 20 && pending.length; i++) { for (const p of pending.splice(0)) p.resolve(); await flush(); }
        expect(splitSkinnedReady(), 'the part\'s generated skinned pipeline compiled').toBe(true);
        expect(readyFrames).toBeGreaterThan(0);

        // Frame 2 (the requested one) draws the part.
        draws = 0;
        liveFrame();
        fs = r.getFrameStats3D();
        expect(draws).toBeGreaterThan(0);
        expect(fs.skinnedDrawn).toBe(1);
        expect(fs.skinnedWaiting).toBe(0);
}
