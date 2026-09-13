import { describe, it, expect } from 'vitest';
import { StrokesStagingBuffer } from './strokes-staging-buffer';

// Node has no WebGPU globals; the buffer only reads usage FLAGS, so any distinct bits work.
(globalThis as unknown as { GPUBufferUsage?: unknown }).GPUBufferUsage ??=
    { STORAGE: 0x80, COPY_DST: 0x8, VERTEX: 0x20, INDEX: 0x10 };
import type { Line } from '../../../scene-graph/shapes/line';
import type { Scribble } from '../../../scene-graph/shapes/scribble';

/** Mock GPUDevice recording writeBuffer calls (buffer token, offset, byteLength). */
function mockDevice() {
    const writes: { buffer: { id: number }; offset: number; byteLength: number }[] = [];
    const bindGroups: { offset: number; size: number }[] = [];
    let nextId = 0;
    const device = {
        createBuffer: (desc: { size: number }) => ({ id: nextId++, size: desc.size }),
        createBindGroup: (desc: { entries: { resource: { offset: number; size: number } }[] }) => {
            bindGroups.push({ offset: desc.entries[0].resource.offset, size: desc.entries[0].resource.size });
            return {} as GPUBindGroup;
        },
        queue: {
            writeBuffer: (buffer: { id: number }, offset: number, _src: ArrayBuffer, _srcOff?: number, byteLength?: number) => {
                writes.push({ buffer, offset, byteLength: byteLength ?? 0 });
            },
        },
    } as unknown as GPUDevice;
    return { device, writes, bindGroups };
}

const fakeLine = (n: number, seed = 0): Line =>
    ({ getGeometryVertices: () => Float32Array.from({ length: n * 2 }, (_, i) => seed + i) }) as unknown as Line;

const fakeStroke = (pts: [number, number][], w = 0.01): Scribble =>
    ({ points: pts.map(([x, y]) => ({ x, y })), strokeWidth: w }) as unknown as Scribble;

describe('StrokesStagingBuffer — multi-shape append (the polygon-overlay fix)', () => {
    it('hands out sequential uniform slots at 256-aligned offsets and bakes them into bind groups', () => {
        const { device, bindGroups } = mockDevice();
        const b = new StrokesStagingBuffer(device);
        b.beginStagingPass();
        const s0 = b.appendUniforms(new Float32Array(64));
        const s1 = b.appendUniforms(new Float32Array(64));
        expect([s0, s1]).toEqual([0, 1]);
        b.createStagingBindGroupAt({} as GPUBindGroupLayout, s0);
        b.createStagingBindGroupAt({} as GPUBindGroupLayout, s1);
        expect(bindGroups[0].offset % 256).toBe(0);
        expect(bindGroups[1].offset % 256).toBe(0);
        expect(bindGroups[1].offset - bindGroups[0].offset).toBe(512);   // one slot stride apart
    });

    it('appends line geometry at advancing ranges with RELATIVE indices (baseVertex draws)', () => {
        const { device } = mockDevice();
        const b = new StrokesStagingBuffer(device);
        b.beginStagingPass();
        const d0 = b.appendLine(fakeLine(6));     // 6 verts → 12 floats
        const d1 = b.appendLine(fakeLine(4, 100));
        expect(d0.baseVertex).toBe(0);
        expect(d0.firstIndex).toBe(0);
        expect(d0.indexCount).toBe(6);
        expect(d1.baseVertex).toBe(6);            // after the first line's 6 vertices
        expect(d1.firstIndex).toBe(6);            // 6 indices (even → no pad)
        expect(d1.info.vertexStart).toBe(12);     // floats
        // Second line's data landed after the first, first line intact.
        const vd = (b as unknown as { vertexData: Float32Array[] }).vertexData[0];
        expect(vd[0]).toBe(0); expect(vd[11]).toBe(11);
        expect(vd[12]).toBe(100); expect(vd[19]).toBe(107);
        // Indices are relative per line: both start at 0.
        const id = (b as unknown as { indexData: Uint16Array[] }).indexData[0];
        expect(id[0]).toBe(0);
        expect(id[6]).toBe(0);
    });

    it('pads odd index counts so index-buffer writeBuffer offsets stay 4-byte aligned', () => {
        const { device, writes } = mockDevice();
        const b = new StrokesStagingBuffer(device);
        b.beginStagingPass();
        b.appendLine(fakeLine(5));                // 5 indices (odd) → cursor padded to 6
        const d1 = b.appendLine(fakeLine(4));
        expect(d1.firstIndex % 2).toBe(0);        // even index start ⇒ byte offset % 4 === 0
        for (const w of writes) expect(w.offset % 4).toBe(0);
    });

    it('appendStroke expands points into quads and interleaves with lines in one pass', () => {
        const { device } = mockDevice();
        const b = new StrokesStagingBuffer(device);
        b.beginStagingPass();
        const s = b.appendStroke(fakeStroke([[0, 0], [1, 0], [2, 0]]));   // 2 segments → 16 floats, 12 idx
        expect(s.info.vertexCount).toBe(16);
        expect(s.indexCount).toBe(12);
        const l = b.appendLine(fakeLine(6));
        expect(l.baseVertex).toBe(8);             // 16 floats / 2
        expect(l.firstIndex).toBe(12);
    });

    it('growing mid-pass PRESERVES already-appended geometry', () => {
        const { device } = mockDevice();
        const b = new StrokesStagingBuffer(device);
        b.beginStagingPass();
        b.appendLine(fakeLine(6, 7));             // floats 7..18 at [0..11]
        b.appendLine(fakeLine(4096));             // forces both arrays to grow
        const vd = (b as unknown as { vertexData: Float32Array[] }).vertexData[0];
        expect(vd[0]).toBe(7);
        expect(vd[11]).toBe(18);                  // first line survived the grow
    });
});
