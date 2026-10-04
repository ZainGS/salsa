import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerJobService, JobCancelledError } from './worker-job-service';
import { jobParts, type JobApi, type JobHandler, type JobMessage, type JobReply } from './worker-job-runtime';
import { postGroupParts, resolveGeoRefs, transferGroups } from './world-jobs';
import type { TileLayerGroup } from '../../world/tile-build';

// performance-plan P19 — a worker result posted in PARTS (one message each, so the main thread deserialises a big tile
// in pieces): the service protocol, and the tile groups' shared geometry across parts (GeoRef → the same object again).

/** A fake Worker speaking serveJobs' protocol, with api.part: every reply is its own macrotask + structured clone
 *  (with its transfer list, like postMessage). */
class PartsWorker {
    static handlers: Record<string, JobHandler<any, any>> = {};
    static messages = 0;
    onmessage: ((e: MessageEvent<JobReply>) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    terminated = false;
    postMessage(m: JobMessage): void {
        const msg = structuredClone(m);
        setTimeout(async () => {
            if (this.terminated || msg.t !== 'job') return;
            const replies: Array<{ r: JobReply; tr: Transferable[] }> = [];
            const transfer: Transferable[] = [];
            const api: JobApi = { shared: {}, fallback: false, progress: () => {}, transfer: (...l) => { for (const b of l) if (!transfer.includes(b)) transfer.push(b); },
                part: (v) => { const tr = transfer.splice(0); replies.push({ r: structuredClone({ t: 'part', id: msg.id, part: v } as JobReply, { transfer: tr }), tr }); } };
            try { const result = await PartsWorker.handlers[msg.kind](msg.payload, api); replies.push({ r: structuredClone({ t: 'done', id: msg.id, result } as JobReply, { transfer: transfer.splice(0) }), tr: [] }); }
            catch (e) { replies.push({ r: { t: 'error', id: msg.id, error: String(e) }, tr: [] }); }
            // deliver one reply per macrotask (each part is its own main-thread task)
            for (const { r } of replies) { await new Promise(res => setTimeout(res, 0)); if (this.terminated) return; PartsWorker.messages++; this.onmessage?.({ data: r } as MessageEvent<JobReply>); }
        }, 0);
    }
    terminate(): void { this.terminated = true; }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
function svcWith(handler: JobHandler<any, any>): WorkerJobService {
    const svc = new WorkerJobService({ hardwareCap: 2 });
    PartsWorker.handlers = { k: handler };
    svc.registerLane({ lane: 'L', create: () => new PartsWorker() as unknown as Worker });
    svc.registerKind({ kind: 'k', lane: 'L', handler });
    return svc;
}

describe('P19 job parts (WorkerJobService)', () => {
    const G = globalThis as unknown as { Worker?: unknown };
    let had: unknown;
    beforeEach(() => { had = G.Worker; G.Worker = PartsWorker; });
    afterEach(() => { G.Worker = had; });
    it('a handler posting parts resolves with the parts, in order, one message each', async () => {
        const svc = svcWith((_p: unknown, api: JobApi) => { for (let i = 0; i < 3; i++) api.part!({ i, data: new Float32Array([i, i + 1]) }); return jobParts(3); });
        PartsWorker.messages = 0;
        const r = await svc.run<unknown, Array<{ i: number; data: Float32Array }>>('k', {}, { mode: 'worker' }).promise;
        expect(r.map(x => x.i)).toEqual([0, 1, 2]);
        expect(Array.from(r[2].data)).toEqual([2, 3]);
        expect(PartsWorker.messages).toBe(4);   // 3 parts + done
    });
    it('a part count mismatch rejects (never a silently partial tile)', async () => {
        const svc = svcWith((_p: unknown, api: JobApi) => { api.part!({ i: 0 }); return jobParts(2); });
        await expect(svc.run('k', {}, { mode: 'worker' }).promise).rejects.toThrow(/1 of 2 parts/);
    });
    it('a job cancelled between its parts rejects as cancelled; its parts are dropped', async () => {
        const svc = svcWith(async (_p: unknown, api: JobApi) => { api.part!({ i: 0 }); api.part!({ i: 1 }); return jobParts(2); });
        PartsWorker.messages = 0;
        const h = svc.run('k', {}, { mode: 'worker' });
        for (let i = 0; i < 200 && PartsWorker.messages < 1; i++) await tick(0);   // the first part has arrived
        h.cancel();
        await expect(h.promise).rejects.toBeInstanceOf(JobCancelledError);
        for (let i = 0; i < 200 && PartsWorker.messages < 3; i++) await tick(0);   // the second part + done arrive after the cancel
        expect(PartsWorker.messages).toBe(3);
        expect(svc.stats().running).toBe(0);   // the late 'done' released the job; nothing kept
    });
});

describe('P19 tile groups in parts: shared geometry across parts', () => {
    const geo = (n: number) => ({ vertices: new Float32Array(12 * n).map((_, i) => i * 0.5 + n), indices: new Uint32Array([0, 1, 2]) });
    function tile(): TileLayerGroup[] {
        const shared = geo(3), local = geo(2);   // `shared` in two groups (and twice in the second), `local` twice in one group
        return [
            { name: 'A', layers: [{ name: 'a0', geometry: shared, color: [1, 0, 0], y: 0 } as never, { name: 'a1', geometry: geo(1), color: [0, 1, 0], y: 0, instances: [{ x: 1, y: 2, z: 3 }] } as never] },
            { name: 'B', layers: [{ name: 'b0', geometry: local, color: [0, 0, 1], y: 0 } as never, { name: 'b1', geometry: local, color: [0, 0, 1], y: 0 } as never, { name: 'b2', geometry: shared, color: [1, 1, 1], y: 0 } as never] },
            { name: 'C', layers: [{ name: 'c0', geometry: shared, color: [1, 1, 0], y: 0, instances: [{ x: 4, y: 5, z: 6, ry: 1 }] } as never] },
        ];
    }
    /** postGroupParts through a structured clone per part (the transfer lists detach exactly what a postMessage would). */
    function roundTrip(src: TileLayerGroup[]): TileLayerGroup[] {
        const parts: TileLayerGroup[] = [];
        const transfer: Transferable[] = [];
        const api: JobApi = { shared: {}, fallback: false, progress: () => {}, transfer: (...l) => { for (const b of l) if (!transfer.includes(b)) transfer.push(b); },
            part: (v) => { parts.push(structuredClone(v, { transfer: transfer.splice(0) }) as TileLayerGroup); } };
        postGroupParts(src, api, true);
        expect(transfer.length).toBe(0);
        return resolveGeoRefs(parts);
    }
    it('the same layers, values and SHARING as the one-message path; the builders\' source geometry is untouched', () => {
        const a = tile(), srcShared = a[0].layers[0].geometry, srcVerts = Array.from(srcShared.vertices);
        const got = roundTrip(a);
        // sharing: one object for every use of `shared` across the three parts, one for `local` inside B
        const g = (gi: number, li: number) => got[gi].layers[li].geometry;
        expect(g(1, 2)).toBe(g(0, 0));
        expect(g(2, 0)).toBe(g(0, 0));
        expect(g(1, 1)).toBe(g(1, 0));
        expect(g(0, 1)).not.toBe(g(0, 0));
        // the source geometry was copied, not transferred (module-cached builder geometry must survive)
        expect(Array.from(srcShared.vertices)).toEqual(srcVerts);
        // the one-message path for comparison
        const b = tile();
        const tr: Transferable[] = [];
        transferGroups(b, { shared: {}, fallback: false, progress: () => {}, transfer: (...l) => { tr.push(...l); } });
        const one = structuredClone(b, { transfer: tr });
        const strip = (gs: TileLayerGroup[]) => gs.map(x => ({ name: x.name, layers: x.layers.map(L => ({ name: L.name, color: L.color, v: Array.from(L.geometry.vertices), i: Array.from(L.geometry.indices ?? []) })) }));
        expect(strip(got)).toEqual(strip(one));
        // instance lists rode packed (step 3b) in their part
        expect((got[2].layers[0] as unknown as { instPacked?: unknown }).instPacked).toBeTruthy();
    });
    it('P20 splitParts: a big group goes as several messages and merges back into the same group, layer for layer', () => {
        const big = (): TileLayerGroup[] => {
            const shared = geo(4);
            const layers = Array.from({ length: 130 }, (_, i) => ({ name: 'L' + i, geometry: i % 17 === 0 ? shared : geo(1 + (i % 5)), color: [i / 130, 0, 0], y: 0 } as never));
            return [{ name: 'Small', layers: [{ name: 's', geometry: shared, color: [0, 0, 0], y: 0 } as never] }, { name: 'Big', layers }];
        };
        const run = (split: { layers: number; bytes: number } | null) => {
            const parts: TileLayerGroup[] = [];
            const transfer: Transferable[] = [];
            const api: JobApi = { shared: {}, fallback: false, progress: () => {}, transfer: (...l) => { for (const b of l) if (!transfer.includes(b)) transfer.push(b); },
                part: (v) => { parts.push(structuredClone(v, { transfer: transfer.splice(0) }) as TileLayerGroup); } };
            postGroupParts(big(), api, false, split);
            return { n: parts.length, got: resolveGeoRefs(parts) };
        };
        const one = run(null), cut = run({ layers: 48, bytes: 1 << 30 }), tiny = run({ layers: 1000, bytes: 12 * 4 * 6 });
        expect(one.n).toBe(2);
        expect(cut.n).toBe(1 + Math.ceil(130 / 48));
        expect(tiny.n).toBeGreaterThan(cut.n);   // the byte cap cuts too (a single layer is never split)
        const strip = (gs: TileLayerGroup[]) => gs.map(x => ({ name: x.name, layers: x.layers.map(L => ({ name: L.name, v: Array.from(L.geometry.vertices) })) }));
        expect(strip(cut.got)).toEqual(strip(one.got));
        expect(strip(tiny.got)).toEqual(strip(one.got));
        // sharing survives the split: every use of `shared` is one object again, across parts
        for (const r of [cut, tiny]) {
            const s = r.got[0].layers[0].geometry;
            for (let i = 0; i < 130; i += 17) expect(r.got[1].layers[i].geometry).toBe(s);
        }
    });
    it('P20 splitParts through the job service: the handler reports the PART count, the job resolves whole', async () => {
        const G = globalThis as unknown as { Worker?: unknown };
        const had = G.Worker; G.Worker = PartsWorker;
        try {
            const big = (): TileLayerGroup[] => [{ name: 'Big', layers: Array.from({ length: 100 }, (_, i) => ({ name: 'L' + i, geometry: geo(1 + (i % 3)), color: [0, 0, 0], y: 0 } as never)) }];
            const svc = svcWith((_p: unknown, api: JobApi) => jobParts(postGroupParts(big(), api, false, { layers: 30, bytes: 1 << 30 })));
            const r = await svc.run<unknown, TileLayerGroup[]>('k', {}, { mode: 'worker' }).promise;
            expect(r.length).toBe(4);   // 100 layers / 30 a part
            const got = resolveGeoRefs(r);
            expect(got.length).toBe(1);
            expect(got[0].layers.map(L => L.name)).toEqual(Array.from({ length: 100 }, (_, i) => 'L' + i));
        } finally { G.Worker = had; }
    });
});
