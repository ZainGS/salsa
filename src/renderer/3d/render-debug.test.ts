/**
 * RENDER DEBUG switches (render-debug.ts; docs/ui/gpu-diagnostics.md "Render debug"; mobile-parity RENDER-1).
 *
 * 1. The flag set: all OFF by default, merge / reset, per-machine persistence (localStorage `salsa.renderDebug`, removed
 *    once everything is off), unknown keys ignored.
 * 2. ALL OFF = THE NORMAL FRAME: on the REAL Renderer3D over a recording device, a frame records exactly the same GPU
 *    calls (pass descriptors incl. load ops, pass commands, buffer writes) before any flag was touched and after a
 *    flags-on round trip + reset; and with everything off the debug uniform floats are never written.
 * 3. The shading switches reach the mesh fragment shader through IBLUniforms.dbgShade / dbgFlags (floats 53 / 54),
 *    written once per change.
 * 4. The mesh fragment shaders carry the debug code only behind those uniforms (0 = the normal path).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';
import {
    RD, RENDER_DEBUG_FLAGS, RENDER_DEBUG_STORAGE_KEY, getRenderDebug, setRenderDebug, loadRenderDebug,
    renderDebugShadeMode, renderDebugShaderBits, rdColorLoad, rdDepthLoad, rdCanvasAlphaMode,
} from './render-debug';
import { generateMeshFs } from './shaders/mesh-fs-generate';
import { meshFsAllKey, meshFsBaseKey } from './shaders/mesh-fs-key';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

class MemStorage {
    private m = new Map<string, string>();
    getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
    setItem(k: string, v: string): void { this.m.set(k, String(v)); }
    removeItem(k: string): void { this.m.delete(k); }
}

/** A device whose every call is logged (names + pass descriptors + buffer write targets), buffers backed by memory. */
function recordingDevice() {
    const mem = new Map<object, Uint8Array>();
    const ids = new Map<object, number>();
    const idOf = (o: object): number => { let i = ids.get(o); if (i === undefined) { i = ids.size; ids.set(o, i); } return i; };
    const log: string[] = [];
    const handler: ProxyHandler<() => unknown> = {
        get(_t, k) {
            if (k === 'then') return undefined;
            if (typeof k === 'string' && (k.endsWith('Async') || k === 'onSubmittedWorkDone')) return () => new Promise(() => { /* never */ });
            if (k === Symbol.toPrimitive) return () => 0;
            if (k === 'size') return 1 << 30;
            if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
            return stub;
        },
        apply() { return stub; },
    };
    const stub: unknown = new Proxy(function () { /* stub */ }, handler);
    const describeOps = (d: GPURenderPassDescriptor): string => JSON.stringify({
        c: [...(d.colorAttachments ?? [])].map((a) => a ? { l: a.loadOp, s: a.storeOp } : null),
        d: d.depthStencilAttachment ? { dl: d.depthStencilAttachment.depthLoadOp, sl: d.depthStencilAttachment.stencilLoadOp } : null,
    });
    const passProxy = () => new Proxy({}, { get: (_t, k) => (...args: unknown[]) => { log.push(`pass.${String(k)}(${args.length})`); return undefined; } });
    const encoder = new Proxy({}, { get: (_t, k) => {
        if (k === 'beginRenderPass') return (d: GPURenderPassDescriptor) => { log.push('beginRenderPass ' + describeOps(d)); return passProxy(); };
        if (k === 'copyBufferToBuffer') return (src: object, so: number, dst: object, dof: number, n: number) => { const a = mem.get(src), b = mem.get(dst); if (a && b) b.set(a.slice(so, so + n), dof); };
        if (k === 'finish') return () => stub;
        return (..._a: unknown[]) => { log.push('enc.' + String(k)); return stub; };
    } });
    const queue = new Proxy({}, { get: (_t, k) => {
        if (k === 'writeBuffer') return (buf: object, off: number, data: ArrayBuffer | ArrayBufferView, dataOff = 0, size?: number) => {
            const isAB = data instanceof ArrayBuffer;
            const bpe = isAB ? 1 : ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
            const src = isAB ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const o = dataOff * bpe, n = size !== undefined ? size * bpe : src.byteLength - o;
            log.push(`writeBuffer #${idOf(buf)} @${off} ${n}B`);
            const m = mem.get(buf); if (m) m.set(src.subarray(o, o + n), off);
        };
        if (k === 'submit') return () => { log.push('submit'); };
        if (k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
        return stub;
    } });
    const device = new Proxy({}, { get: (_t, k) => {
        if (k === 'queue') return queue;
        if (k === 'features') return { has: () => false };
        if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
        if (k === 'createBuffer') return (d: { size: number }) => { const b = { size: d.size, destroy() { /* */ }, label: '', mapAsync: () => new Promise(() => { /* */ }) }; mem.set(b, new Uint8Array(d.size)); return b; };
        if (k === 'createCommandEncoder') return () => encoder;
        if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
        return stub;
    } });
    return { device: device as unknown as GPUDevice, mem, log, idOf };
}

beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    const flags = new Proxy({}, { get: () => 1 });
    for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});
afterEach(() => { setRenderDebug({ reset: true }); delete (globalThis as { localStorage?: unknown }).localStorage; });

describe('render debug flag set', () => {
    it('defaults: every flag off, RD.on false, the helpers return the normal values', () => {
        loadRenderDebug();
        const f = getRenderDebug();
        expect(Object.keys(f).sort()).toEqual(RENDER_DEBUG_FLAGS.map((x) => x.key).sort());
        expect(Object.values(f).every((v) => v === false)).toBe(true);
        expect(RD.on).toBe(false);
        expect(renderDebugShadeMode()).toBe(0);
        expect(renderDebugShaderBits()).toBe(0);
        expect(rdColorLoad()).toBe('load');
        expect(rdDepthLoad()).toBe('load');
        expect(rdCanvasAlphaMode()).toBe('premultiplied');
    });

    it('merges booleans, ignores unknown keys / non-booleans, reset switches all off', () => {
        const r = setRenderDebug({ noGrid: true, solidMesh: true, bogus: true, noPost: 1 } as never);
        expect(r.noGrid).toBe(true); expect(r.solidMesh).toBe(true); expect(r.noPost).toBe(false);
        expect('bogus' in r).toBe(false);
        expect(RD.on).toBe(true);
        expect(setRenderDebug({ noGrid: false }).solidMesh).toBe(true);   // a patch keeps the others
        expect(setRenderDebug({ reset: true, noFxaa: true })).toMatchObject({ solidMesh: false, noFxaa: true });
        setRenderDebug({ noFxaa: false });
        expect(RD.on).toBe(false);
    });

    it('shading priority magenta > constant colour > unlit; load ops / alpha follow their flags', () => {
        setRenderDebug({ noLighting: true }); expect(renderDebugShadeMode()).toBe(1);
        setRenderDebug({ noTextures: true }); expect(renderDebugShadeMode()).toBe(2);
        setRenderDebug({ dbgVertexColour: true }); expect(renderDebugShadeMode()).toBe(6);
        setRenderDebug({ dbgInstanceZero: true }); expect(renderDebugShadeMode()).toBe(5);
        setRenderDebug({ dbgInstanceIndex: true }); expect(renderDebugShadeMode()).toBe(4);
        setRenderDebug({ solidMesh: true }); expect(renderDebugShadeMode()).toBe(3);
        setRenderDebug({ clampTexLayers: true }); expect(renderDebugShaderBits()).toBe(1);
        setRenderDebug({ reset: true, dbgNormal: true }); expect(renderDebugShadeMode()).toBe(9);
        setRenderDebug({ dbgVertexColour: true }); expect(renderDebugShadeMode()).toBe(6);   // the read tests beat the normal
        setRenderDebug({ solidGrey: true }); expect(renderDebugShadeMode()).toBe(7);
        setRenderDebug({ solidWhite: true }); expect(renderDebugShadeMode()).toBe(8);   // white beats grey
        setRenderDebug({ solidMesh: true }); expect(renderDebugShadeMode()).toBe(3);    // magenta beats both
        setRenderDebug({ reset: true, dbgNanCheck: true }); expect(renderDebugShaderBits()).toBe(2);
        expect(renderDebugShadeMode()).toBe(0);   // the bits are independent of the shading mode
        setRenderDebug({ safeLightingMath: true }); expect(renderDebugShaderBits()).toBe(6);
        setRenderDebug({ clampTexLayers: true, dbgNanCheck: false }); expect(renderDebugShaderBits()).toBe(5);
        setRenderDebug({ reset: true, noShadowReceive: true }); expect(renderDebugShaderBits()).toBe(8);
        setRenderDebug({ dbgShadowFactor: true }); expect(renderDebugShaderBits()).toBe(24);
        // The removed sparkle switches (noSparkle 32 / lateSparkleFlags 64, sparkle removed 2026-10-07) are unknown keys now.
        setRenderDebug({ reset: true, noSparkle: true, lateSparkleFlags: true } as never); expect(renderDebugShaderBits()).toBe(0);
        setRenderDebug({ reset: true, dbgFlagBits: true }); expect(renderDebugShadeMode()).toBe(10);
        setRenderDebug({ reset: true });
        setRenderDebug({ clearColorLoads: true }); expect(rdColorLoad()).toBe('clear'); expect(rdDepthLoad()).toBe('load');
        setRenderDebug({ clearDepthStencilLoads: true }); expect(rdDepthLoad()).toBe('clear');
        setRenderDebug({ forceOpaqueAlpha: true }); expect(rdCanvasAlphaMode()).toBe('opaque');
    });

    it('persists per machine (survives a reload), and the key is removed once all are off', () => {
        const ls = new MemStorage();
        (globalThis as { localStorage?: unknown }).localStorage = ls;
        setRenderDebug({ forceFullRes: true, noHighlight: true });
        expect(JSON.parse(ls.getItem(RENDER_DEBUG_STORAGE_KEY)!)).toEqual({ forceFullRes: true, noHighlight: true });
        RD.f.forceFullRes = false; RD.f.noHighlight = false; RD.on = false;   // "reload": the module state is fresh
        loadRenderDebug();
        expect(getRenderDebug()).toMatchObject({ forceFullRes: true, noHighlight: true, noGrid: false });
        expect(RD.on).toBe(true);
        setRenderDebug({ reset: true });
        expect(ls.getItem(RENDER_DEBUG_STORAGE_KEY)).toBeNull();
        ls.setItem(RENDER_DEBUG_STORAGE_KEY, '{not json');
        loadRenderDebug();
        expect(RD.on).toBe(false);   // corrupt = all off
    });
});

describe('render debug on the real Renderer3D', () => {
    async function setup() {
        const { Renderer3D } = await import('./renderer-3d');
        const { Camera3D } = await import('./camera-3d');
        const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
        const cam = new Camera3D(); cam.setPosition(0, 2, 6); cam.setTarget(0, 0, 0);
        const dev = recordingDevice();
        const r = new Renderer3D(dev.device, cam) as unknown as Record<string, any>;
        const v = new Float32Array(36 * 12), ix = new Uint32Array(36);
        for (let i = 0; i < v.length; i++) v[i] = ((i * 2654435761) % 1000) / 500 - 1;
        for (let i = 0; i < ix.length; i++) ix[i] = i;
        const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: v, indices: ix, format: '12float' } });
        const pass = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => { dev.log.push(`main.${String(k)}(${a.length})`); } }) as unknown as GPURenderPassEncoder;
        const srcTex = { createView: () => ({}), width: 800, height: 600, format: 'bgra8unorm' } as unknown as GPUTexture;
        const frame = (): string[] => {
            dev.log.length = 0;
            r.drawMeshes(pass, [mesh], 800, 600);
            const out = r.runPostProcess(dev.device.createCommandEncoder(), srcTex, 800, 600);
            dev.log.push('post:' + (out === null ? 'null' : 'tex'));
            dev.log.push('lores:' + JSON.stringify(r.getLoResSize(800, 600)));
            return [...dev.log];
        };
        const ibl = (): Float32Array => new Float32Array(dev.mem.get(r._iblUniformBuffer)!.buffer.slice(0));
        const iblWrites = (log: string[]): number => log.filter((l) => l.startsWith(`writeBuffer #${dev.idOf(r._iblUniformBuffer)} `)).length;
        // settle: geometry placement / first-frame work until two consecutive frames record the same calls
        let prev = frame(), cur = frame();
        for (let i = 0; i < 20 && JSON.stringify(prev) !== JSON.stringify(cur); i++) { prev = cur; cur = frame(); }
        expect(cur).toEqual(prev);
        return { r, frame, ibl, iblWrites, steady: cur };
    }

    it('all flags off records exactly the same frame as after a flags-on round trip, and never writes the debug uniforms', async () => {
        const { frame, iblWrites, steady } = await setup();
        expect(iblWrites(steady)).toBe(0);
        expect(steady.some((l) => l.startsWith('beginRenderPass'))).toBe(true);
        // every switch on for a frame, then reset
        const all: Record<string, boolean> = {};
        for (const { key } of RENDER_DEBUG_FLAGS) all[key] = true;
        setRenderDebug(all);
        const on = frame();
        expect(on).not.toEqual(steady);
        setRenderDebug({ reset: true });
        frame();   // writes the debug uniforms back to 0 (one IBL write), then steady again
        const after = frame();
        expect(after).toEqual(steady);
        expect(iblWrites(after)).toBe(0);
    });

    it('the shading switches land in IBLUniforms.dbgShade / dbgFlags once per change', async () => {
        const { frame, ibl, iblWrites } = await setup();
        expect(ibl()[53]).toBe(0); expect(ibl()[54]).toBe(0);
        setRenderDebug({ solidMesh: true, clampTexLayers: true });
        expect(iblWrites(frame())).toBe(1);
        expect(ibl()[53]).toBe(3); expect(ibl()[54]).toBe(1);
        expect(iblWrites(frame())).toBe(0);   // unchanged → no write
        setRenderDebug({ solidMesh: false, noTextures: true, clampTexLayers: false });
        expect(iblWrites(frame())).toBe(1);
        expect(ibl()[53]).toBe(2); expect(ibl()[54]).toBe(0);
        setRenderDebug({ reset: true });
        frame();
        expect(ibl()[53]).toBe(0);
    });

    it('noPost / noFxaa / forceFullRes act on runPostProcess and getLoResSize', async () => {
        const { r, frame, steady } = await setup();
        expect(steady).toContain('post:tex');   // FXAA (the default AA) ran on the 3D frame
        setRenderDebug({ noFxaa: true });
        expect(frame()).toContain('post:null');
        setRenderDebug({ reset: true });
        expect(frame()).toContain('post:tex');
        r.setUserResolutionScale(0.5);
        r._loFiPass = { ready: () => true };   // the lo-res blit "compiled"
        expect(r.getLoResSize(800, 600)).toEqual([400, 300]);
        setRenderDebug({ forceFullRes: true });
        expect(r.getLoResSize(800, 600)).toBeNull();
        setRenderDebug({ reset: true });
        expect(r.getLoResSize(800, 600)).toEqual([400, 300]);
    });
});

describe('render debug in the mesh fragment shaders', () => {
    // The generated mesh fragment shaders with the DEBUG hooks (the only mesh fragment source since shader-split
    // phase 4): the all-features key and the BASE family per layout (a DEBUG key: render debug on).
    const fragments: [string, string][] = [true, false].flatMap((tex) => [false, true].flatMap((sh): [string, string][] => [
        [`ALL ${tex ? 'T' : 'U'}${sh ? ' + shadow' : ''}`, generateMeshFs(meshFsAllKey(tex, sh))],
        [`BASE ${tex ? 'T' : 'U'}${sh ? ' + shadow' : ''}`, generateMeshFs(meshFsBaseKey(tex, sh, true, false))],
    ]));

    it('every mesh fragment shader declares the debug floats and gates every debug return on them', () => {
        expect(fragments.length).toBeGreaterThanOrEqual(8);
        for (const [name, src] of fragments) {
            expect(src, name).toContain('dbgShade: f32');
            expect(src, name).toContain('dbgFlags: f32');
            // the early modes (magenta / constant colour) and the unlit mode, each behind its uniform test
            expect(src.match(/if \(ibl\.dbgShade > 1\.5\) \{/g)?.length, name).toBe(1);
            expect(src.match(/if \(ibl\.dbgShade > 0\.5\) \{/g)?.length, name).toBe(1);
            expect(src.includes('return vec4<f32>(1.0, 0.0, 1.0, 1.0);'), name).toBe(true);
        }
    });

    it('solid grey / white / world-normal modes sit in the uniform early block; NaN check wraps every lit return', () => {
        for (const [name, src] of fragments) {
            expect(src, name).toContain('if (dbgM == 7u) { return vec4<f32>(0.5, 0.5, 0.5, 1.0); }');
            expect(src, name).toContain('if (dbgM == 8u) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }');
            expect(src, name).toContain('if (dbgM == 9u) { return dbgFinal(vec4<f32>(worldNormal * 0.5 + 0.5, 1.0), 0u); }');
            // the early block (modes 2-9) comes before every texture sample / derivative of the normal path
            const early = src.indexOf('if (ibl.dbgShade > 1.5) {');
            const fsMain = src.indexOf('fn fs_main(');
            expect(early, name).toBeGreaterThan(fsMain);
            const firstSampleInMain = src.slice(fsMain).search(/textureSample|fwidth\(|dpdx\(|patternMask\(|windowsPattern\(|gr_uvMetres\(|uvWorldAxes\(/);
            expect(firstSampleInMain, name).toBeGreaterThan(-1);
            expect(early, name).toBeLessThan(fsMain + firstSampleInMain);
            // ONE lit return, through dbgFinal with the pre-clamp state; no bare return of the lit colour is left
            expect(src.match(/return dbgFinal\(finalColor, rdPre\);/g)?.length, name).toBe(1);
            expect(src.includes('return finalColor;'), name).toBe(false);
            expect(src, name).toContain('if ((u32(ibl.dbgFlags) & 2u) != 0u) { rdPre = rdState(vec4<f32>(lit, 1.0)); }');
            // NaN / Inf is detected on the exponent bits (a self-compare may be folded away)
            expect(src, name).toContain('bitcast<vec4<u32>>(v) & vec4<u32>(0x7f800000u)');
            expect(src, name).toMatch(/fn dbgFinal\(c: vec4<f32>, pre: u32\) -> vec4<f32> \{\s*if \(\(u32\(ibl\.dbgFlags\) & 2u\) == 0u\) \{ return c; \}/);
        }
    });

    it('safeLightingMath is read only through select() (off = the original maths, never a branch)', () => {
        for (const [name, src] of fragments) {
            expect(src, name).toContain('var<private> rdSafeMath: bool = false;');
            expect(src.match(/rdSafeMath = \(u32\(ibl\.dbgFlags\) & 4u\) != 0u;/g)?.length, name).toBe(1);
            const uses = src.split(/\r?\n/).filter((l) => l.includes('rdSafeMath') && !l.trim().startsWith('//')
                && !l.includes('var<private> rdSafeMath') && !/rdSafeMath = \(u32/.test(l));
            expect(uses.length, name).toBeGreaterThanOrEqual(3);   // rdPow, rdNormalize, rdDot01 (+ the cascade band in the shadow variants)
            for (const l of uses) expect(l, name).toMatch(/select\(.*rdSafeMath\)/);
            // the guarded sites of the default PBR path use the helpers
            expect(src, name).toContain('var N = rdNormalize(worldNormal);');
            expect(src, name).toContain('let H     = rdNormalize(L + V);');
            expect(src, name).toContain('let NdotH = rdDot01(N, H);');
            expect(src, name).toContain('let rimF = rdPow(1.0 - max(dot(N, V), 0.0), 3.0);');
        }
    });

    it('textured shaders clamp the layer indices only under dbgFlags bit 0 (select keeps the instance value when off)', () => {
        for (const [name, src] of fragments) {
            if (!src.includes('diffuseTexture')) continue;
            expect(src, name).toContain('let dbgClampL = (u32(ibl.dbgFlags) & 1u) != 0u;');
            expect(src, name).toMatch(/let texLayer {2}= select\(i32\(inst\.textureIndex\), min\(.*\), dbgClampL\);/);
            expect(src.includes('i32(inst.textureIndex));'), name).toBe(false);   // every sample uses the selected layer
        }
    });
});

describe('render debug RENDER-1 shader-size tests', () => {
    afterEach(() => { setRenderDebug({ reset: true }); });

    it('tinyMeshFS swaps every mesh fragment module for the tiny shader; off = the code unchanged', async () => {
        const { rdMeshFragmentCode } = await import('./render-debug');
        const { MESH3D_FS_TINY } = await import('./shaders/mesh3d-tiny-fs');
        expect(rdMeshFragmentCode('GENERATED', MESH3D_FS_TINY)).toBe('GENERATED');
        setRenderDebug({ tinyMeshFS: true });
        expect(rdMeshFragmentCode('GENERATED', MESH3D_FS_TINY)).toBe(MESH3D_FS_TINY);
        setRenderDebug({ reset: true, dbgNormal: true });
        expect(rdMeshFragmentCode('GENERATED', MESH3D_FS_TINY)).toBe('GENERATED');
    });

    it('the tiny shader keeps the mesh fragment shaders\' binding + location contract', async () => {
        const { MESH3D_FS_TINY } = await import('./shaders/mesh3d-tiny-fs');
        expect(MESH3D_FS_TINY).toContain('@group(0) @binding(0) var<storage, read> u_instances');
        expect(MESH3D_FS_TINY).toContain('@group(0) @binding(1) var<uniform> scene');
        expect(MESH3D_FS_TINY).toContain('@location(2) @interpolate(flat) instanceIdx: u32');
        expect(MESH3D_FS_TINY).toContain('@location(4)                    worldNormal');
        expect(MESH3D_FS_TINY.includes('`')).toBe(false);
    });
});
