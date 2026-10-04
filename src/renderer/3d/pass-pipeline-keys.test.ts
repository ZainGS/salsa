import { describe, it, expect, beforeAll } from 'vitest';
import { OutlinePass } from './outline-pass';
import { BloomPass } from './bloom-pass';

// bug-hunt 2026-10-01 D-R3: toggling outlines / bloom re-created their passes with UN-keyed pipeline handles, so every
// re-enable paid a fresh async compile (several frames with no effect). The handles are now keyed in the device cache.
beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    g.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, VERTEX: 32, INDEX: 16, STORAGE: 128, COPY_SRC: 4, MAP_READ: 1 };
    g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
    g.GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1, COPY_DST: 2, STORAGE_BINDING: 8 };
});
function fakeDevice(): GPUDevice {
    const stub = (): unknown => new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : () => stub()) });
    return new Proxy({}, { get: (_t, k: string) => (k === 'createRenderPipelineAsync' ? undefined : () => stub()) }) as unknown as GPUDevice;
}
const handles = (o: object): unknown[] => Object.values(o).filter(v => v && typeof v === 'object' && 'kind' in (v as object) && 'label' in (v as object));

describe('pass pipelines are keyed (re-enable reuses the compiled pipelines)', () => {
    it('OutlinePass', () => {
        const dev = fakeDevice();
        const a = new OutlinePass(dev, {} as GPUBindGroupLayout, 'bgra8unorm');
        const b = new OutlinePass(dev, {} as GPUBindGroupLayout, 'bgra8unorm');
        const ha = handles(a), hb = handles(b);
        expect(ha.length).toBeGreaterThanOrEqual(3);
        expect(hb).toEqual(ha);
        for (let i = 0; i < ha.length; i++) expect(hb[i]).toBe(ha[i]);
    });
    it('BloomPass', () => {
        const dev = fakeDevice();
        const a = new BloomPass(dev, 'bgra8unorm'), b = new BloomPass(dev, 'bgra8unorm');
        const ha = handles(a), hb = handles(b);
        expect(ha.length).toBeGreaterThanOrEqual(2);
        for (let i = 0; i < ha.length; i++) expect(hb[i]).toBe(ha[i]);
    });
});
