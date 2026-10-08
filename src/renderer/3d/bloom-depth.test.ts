/**
 * Particle bloom respects scene depth (2026-10-08).
 *
 * The "Particles only" Bloom (BloomPass) used to capture the particles on its own encoder, submitted BEFORE the main
 * pass and with no depth attachment — the frame's depth didn't exist yet — so particles behind a wall glowed through
 * it. Now drawParticles only records what to bloom; the host ends the scene pass and runs runParticleBloom, whose
 * capture pass loads that pass's depth READ-ONLY and depth-tests like the visible particles ('less', no write).
 * Recording devices only (the real-GPU check lives in the Dawn harness).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';
import { BloomPass, createBloomCapturePipeline } from './bloom-pass';
import type { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;

beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    const flags = new Proxy({}, { get: () => 1 });
    for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

/** A stub device: every call returns a callable stub; textures / buffers are plain objects; submits are counted. */
function stubDevice() {
    const handler: ProxyHandler<() => unknown> = {
        get(_t, k) {
            if (k === 'then') return undefined;
            if (k === Symbol.toPrimitive) return () => 0;
            if (k === 'size') return 1 << 30;
            return stub;
        },
        apply() { return stub; },
    };
    const stub: unknown = new Proxy(function () { /* stub */ }, handler);
    const counts = { submits: 0 };
    const queue = new Proxy({}, { get: (_t, k) => {
        if (k === 'submit') return () => { counts.submits++; };
        if (k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
        return stub;
    } });
    const limits = { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
    const device = new Proxy({}, { get: (_t, k) => {
        if (k === 'queue') return queue;
        if (k === 'features') return { has: () => false };
        if (k === 'limits') return limits;
        if (typeof k === 'string' && k.endsWith('Async')) return undefined;   // sync pipeline fallback
        if (k === 'createBuffer') return (d: { size: number }) => ({ size: d.size, destroy() { /* */ }, label: '' });
        if (k === 'createTexture') return (d: { label?: string }) => ({ label: d.label ?? '', destroy() { /* */ }, createView: () => ({ tex: d.label ?? '' }) });
        return stub;
    } });
    return { device: device as unknown as GPUDevice, counts };
}

type RecPass = { desc: GPURenderPassDescriptor; viewports: number[][]; draws: number[][]; ended: boolean };
function recordingEncoder() {
    const passes: RecPass[] = [];
    const enc = {
        beginRenderPass(desc: GPURenderPassDescriptor) {
            const p: RecPass = { desc, viewports: [], draws: [], ended: false };
            passes.push(p);
            return {
                setPipeline() { /* */ }, setBindGroup() { /* */ },
                setViewport(...a: number[]) { p.viewports.push(a); },
                draw(...a: number[]) { p.draws.push(a); },
                end() { p.ended = true; },
            };
        },
    };
    return { enc: enc as unknown as GPUCommandEncoder, passes };
}

const emitter = (n: number) => ({ activeCount: n }) as unknown as ParticleEmitter3D;

describe('particle bloom capture is depth-tested against the scene', () => {
    it('the capture pipeline depth-tests (no write) like the particle pipeline', () => {
        const { device } = stubDevice();
        const h = createBloomCapturePipeline(device, {} as GPUBindGroupLayout, {} as GPUBindGroupLayout);
        const d = h.descriptor() as GPURenderPipelineDescriptor;
        expect(d.depthStencil).toEqual({ format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less' });
    });

    it('captureAndBlur records into the host encoder: capture with the scene depth read-only, then the blur; no own submit', () => {
        const { device, counts } = stubDevice();
        const bloom = new BloomPass(device, 'bgra8unorm');
        bloom.ensureTextures(320, 180);
        const { enc, passes } = recordingEncoder();
        const depthView = { depth: true } as unknown as GPUTextureView;
        bloom.captureAndBlur(enc, depthView, 0, {} as GPUBuffer, {} as GPUBuffer, {} as GPUBindGroupLayout, {} as GPUBindGroupLayout,
            {} as GPURenderPipeline, [emitter(5), emitter(0), emitter(3)], [0, 5, 5], {} as GPUSampler, bloom.sourceTexture!);
        expect(counts.submits).toBe(0);
        expect(passes.length).toBe(3);   // capture + H blur + V blur
        const cap = passes[0];
        const ds = cap.desc.depthStencilAttachment!;
        expect(ds.view).toBe(depthView);
        expect(ds.depthReadOnly).toBe(true);
        expect(ds.stencilReadOnly).toBe(true);
        expect(ds.depthLoadOp).toBeUndefined();   // read-only attachments take no load / store ops
        expect(cap.viewports).toEqual([]);        // plain [0, 1] depth range → the default viewport
        expect(cap.draws).toEqual([[6, 5, 0, 0], [6, 3, 0, 5]]);   // zero-instance emitters are skipped
        for (const p of passes) expect(p.ended).toBe(true);
        expect(passes[1].desc.depthStencilAttachment).toBeUndefined();
    });

    it('the capture uses the scene depth range (ortho remap) so its depths match the stored ones', () => {
        const { device } = stubDevice();
        const bloom = new BloomPass(device, 'bgra8unorm');
        bloom.ensureTextures(200, 100);
        const { enc, passes } = recordingEncoder();
        bloom.captureAndBlur(enc, {} as GPUTextureView, 1 / 3, {} as GPUBuffer, {} as GPUBuffer, {} as GPUBindGroupLayout, {} as GPUBindGroupLayout,
            {} as GPURenderPipeline, [emitter(2)], [0], {} as GPUSampler, bloom.sourceTexture!);
        expect(passes[0].viewports).toEqual([[0, 0, 200, 100, 1 / 3, 1]]);
    });

    it('composite opens a load pass on the scene colour', () => {
        const { device } = stubDevice();
        const bloom = new BloomPass(device, 'bgra8unorm');
        bloom.ensureTextures(64, 64);
        const { enc, passes } = recordingEncoder();
        const color = { color: true } as unknown as GPUTextureView;
        bloom.composite(enc, color, {} as GPUSampler);
        expect(passes.length).toBe(1);
        const ca = (passes[0].desc.colorAttachments as GPURenderPassColorAttachment[])[0];
        expect(ca.view).toBe(color);
        expect(ca.loadOp).toBe('load');
        expect(passes[0].desc.depthStencilAttachment).toBeUndefined();
        expect(passes[0].ended).toBe(true);
    });
});

describe('Renderer3D: drawParticles records the bloom, runParticleBloom runs it after the pass', () => {
    async function setup() {
        const { Renderer3D } = await import('./renderer-3d');
        const { Camera3D } = await import('./camera-3d');
        const { ParticleEmitter3D } = await import('../../scene-graph/shapes/particle-emitter-3d');
        const { device } = stubDevice();
        const cam = new Camera3D({ position: [0, 0, 3], target: [0, 0, 0] });
        const r = new Renderer3D(device, cam, 'bgra8unorm');
        const ri = r as unknown as Record<string, any>;
        ri._initParticlePipeline();
        ri._particlePipeline = { get: () => ({}) };   // compiled
        r.enableBloom(0.4, 2);
        ri._bloomCapturePipeline = { get: () => ({}) };
        const calls: { capture: unknown[][]; composite: unknown[][]; drawComposite: number } = { capture: [], composite: [], drawComposite: 0 };
        const bp = ri._bloomPass as Record<string, unknown>;
        bp.ready = () => true;
        bp.captureAndBlur = (...a: unknown[]) => { calls.capture.push(a.map(x => (Array.isArray(x) ? [...x] : x))); };   // (snapshot: the renderer reuses its arrays)
        bp.composite = (...a: unknown[]) => { calls.composite.push(a); };
        bp.drawComposite = () => { calls.drawComposite++; };
        const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
        const e = new ParticleEmitter3D(isvc, 0, 0, 0, { emitRate: 100 });
        e.tick(0.2);
        const mainPass = { setPipeline() { /* */ }, setBindGroup() { /* */ }, draw() { /* */ } } as unknown as GPURenderPassEncoder;
        return { r, ri, cam, e, calls, mainPass };
    }

    it('nothing blooms inside the scene pass; the pending bloom runs with the scene depth and is consumed', async () => {
        const { r, e, calls, mainPass } = await setup();
        r.drawParticles(mainPass, [e], 320, 180);
        expect(r.particleBloomPending).toBe(true);
        expect(calls.capture.length).toBe(0);       // not captured before the pass ends (no depth yet)
        expect(calls.drawComposite).toBe(0);        // no composite inside the scene pass any more
        const { enc } = recordingEncoder();
        const color = { c: 1 } as unknown as GPUTextureView, depth = { d: 1 } as unknown as GPUTextureView;
        r.runParticleBloom(enc, color, depth);
        expect(calls.capture.length).toBe(1);
        const a = calls.capture[0];
        expect(a[0]).toBe(enc);
        expect(a[1]).toBe(depth);
        expect(a[2]).toBe(0);                        // perspective → the plain [0, 1] range
        expect((a[8] as ParticleEmitter3D[]).length).toBe(1);
        expect(calls.composite.length).toBe(1);
        expect(calls.composite[0][1]).toBe(color);
        expect(r.particleBloomPending).toBe(false);
        r.runParticleBloom(enc, color, depth);       // consumed → a second run is a no-op
        expect(calls.capture.length).toBe(1);
    });

    it('ortho passes the remapped depth range; an emptied frame or disableBloom leaves nothing pending', async () => {
        const { r, cam, e, calls, mainPass } = await setup();
        cam.mode = 'orthographic';
        r.drawParticles(mainPass, [e], 320, 180);
        const { enc } = recordingEncoder();
        r.runParticleBloom(enc, {} as GPUTextureView, {} as GPUTextureView);
        expect(calls.capture[0][2]).toBeCloseTo(1 / 3);
        cam.mode = 'perspective';
        r.drawParticles(mainPass, [e], 320, 180);
        expect(r.particleBloomPending).toBe(true);
        e.visible = false;
        r.drawParticles(mainPass, [e], 320, 180);   // no visible particles this frame → last frame's record is dropped
        expect(r.particleBloomPending).toBe(false);
        e.visible = true;
        r.drawParticles(mainPass, [e], 320, 180);
        r.disableBloom();
        expect(r.particleBloomPending).toBe(false);
        r.drawParticles(mainPass, [e], 320, 180);   // bloom off → never pending
        expect(r.particleBloomPending).toBe(false);
    });
});
