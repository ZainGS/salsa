import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerJobService, JobCancelledError, WorkerUnavailableError, type WorkerJobProgress } from './worker-job-service';
import type { JobMessage, JobReply, JobHandler } from './worker-job-runtime';

// A fake Worker that runs a handler table "in another thread" (a macrotask later), speaking the serveJobs protocol.
class FakeWorker {
    static handlers: Record<string, JobHandler<any, any>> = {};
    static spawned = 0;
    onmessage: ((e: MessageEvent<JobReply>) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    shared: Record<string, unknown> = {};
    terminated = false;
    posted: JobMessage[] = [];
    constructor() { FakeWorker.spawned++; }
    postMessage(m: JobMessage): void {
        this.posted.push(m);
        const msg = structuredClone(m);
        setTimeout(async () => {
            if (this.terminated) return;
            if (msg.t === 'shared') { this.shared[msg.key] = msg.value; return; }
            const h = FakeWorker.handlers[msg.kind];
            const reply = (r: JobReply): void => { if (!this.terminated) this.onmessage?.({ data: structuredClone(r) } as MessageEvent<JobReply>); };
            try {
                const result = await h(msg.payload, { shared: this.shared, fallback: false, progress: (p) => reply({ t: 'progress', id: msg.id, p }), transfer: () => {} });
                reply({ t: 'done', id: msg.id, result });
            } catch (e) { reply({ t: 'error', id: msg.id, error: String(e) }); }
        }, 0);
    }
    terminate(): void { this.terminated = true; }
    crash(): void { this.onerror?.(new Event('error')); }
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('WorkerJobService — main-thread fallback (no Worker)', () => {
    it('runs the handler on a later macrotask with a CLONED payload; priority order; same result as a direct call', async () => {
        const svc = new WorkerJobService({ hardwareCap: 2 });
        const order: string[] = [];
        const handler: JobHandler<{ name: string; arr: number[] }, number> = (p) => { order.push(p.name); p.arr.push(99); return p.arr.reduce((a, b) => a + b, 0); };
        svc.registerLane({ lane: 'L', create: () => { throw new Error('no worker'); } });
        svc.registerKind({ kind: 'sum', lane: 'L', handler });
        const payload = { name: 'bg', arr: [1, 2, 3] };
        const a = svc.run<typeof payload, number>('sum', payload, { priority: 'background' });
        const b = svc.run<typeof payload, number>('sum', { name: 'vis', arr: [1] }, { priority: 'visible' });
        const c = svc.run<typeof payload, number>('sum', { name: 'int', arr: [2] }, { priority: 'interactive' });
        expect(order).toEqual([]);   // nothing ran synchronously
        expect(await a.promise).toBe(105);
        await Promise.all([b.promise, c.promise]);
        expect(order).toEqual(['int', 'vis', 'bg']);
        expect(payload.arr).toEqual([1, 2, 3]);   // the handler mutated a CLONE (like postMessage)
        expect(svc.stats().fallbackRuns).toBe(3);
    });
    it('cancel + supersede-by-key while queued', async () => {
        const svc = new WorkerJobService();
        const ran: number[] = [];
        svc.registerLane({ lane: 'L', create: () => { throw new Error('x'); } });
        svc.registerKind({ kind: 'k', lane: 'L', handler: (n: number) => { ran.push(n); return n; } });
        const a = svc.run('k', 1, { key: 'same' });
        const b = svc.run('k', 2, { key: 'same' });
        const c = svc.run('k', 3);
        c.cancel();
        await expect(a.promise).rejects.toBeInstanceOf(JobCancelledError);
        await expect(c.promise).rejects.toBeInstanceOf(JobCancelledError);
        expect(await b.promise).toBe(2);
        expect(ran).toEqual([2]);
    });
    it("mode 'worker' / handler-less kinds reject with WorkerUnavailableError", async () => {
        const svc = new WorkerJobService();
        svc.registerLane({ lane: 'L', create: () => { throw new Error('x'); } });
        svc.registerKind({ kind: 'w', lane: 'L' });
        svc.registerKind({ kind: 'h', lane: 'L', handler: () => 1 });
        await expect(svc.run('w', 0).promise).rejects.toBeInstanceOf(WorkerUnavailableError);
        await expect(svc.run('h', 0, { mode: 'worker' }).promise).rejects.toBeInstanceOf(WorkerUnavailableError);
    });
    it('progress events: active while queued/running, done/total, idle at the end', async () => {
        const svc = new WorkerJobService();
        svc.registerLane({ lane: 'L', create: () => { throw new Error('x'); } });
        svc.registerKind({ kind: 'k', lane: 'L', handler: (n: number, api) => { api.progress(0.5); return n; } });
        const seen: WorkerJobProgress[] = [];
        svc.onProgress(p => seen.push(p));
        const jobs = [svc.run('k', 1, { label: 'one' }), svc.run('k', 2, { label: 'two' })];
        await Promise.all(jobs.map(j => j.promise));
        await tick();
        expect(seen[0].active).toBe(true);
        expect(seen[0].total).toBe(2);
        expect(seen.some(p => p.jobs.some(j => j.label === 'one'))).toBe(true);
        expect(seen[seen.length - 1].active).toBe(false);
    });
});

describe('WorkerJobService — workers', () => {
    const G = globalThis as unknown as { Worker?: unknown };
    let had: unknown;
    beforeEach(() => { had = G.Worker; G.Worker = FakeWorker; FakeWorker.spawned = 0; });
    afterEach(() => { G.Worker = had; });

    it('dispatches to idle workers by priority, replays sticky shared state to new workers, honours the cap', async () => {
        const svc = new WorkerJobService({ hardwareCap: 2 });
        const done: string[] = [];
        FakeWorker.handlers = { echo: (p: string, api) => { done.push(p); return `${p}:${String(api.shared.tag)}`; } };
        const workers: FakeWorker[] = [];
        svc.registerLane({ lane: 'L', create: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; } });
        svc.registerKind({ kind: 'echo', lane: 'L' });
        svc.broadcast('L', 'tag', 'T1');
        const hs = ['a', 'b', 'c', 'd'].map((x, i) => svc.run<string, string>('echo', x, { priority: i === 3 ? 'interactive' : 'background' }));
        expect(svc.liveWorkers('L')).toBe(2);   // capped
        expect(await hs[0].promise).toBe('a:T1');   // shared state replayed to the lazily-spawned worker
        await Promise.all(hs.map(h => h.promise));
        expect(done.indexOf('d')).toBeLessThan(done.indexOf('c'));   // interactive jumped the queued background job
        // identity-compare broadcast: same value → no re-post
        const n0 = workers[0].posted.length;
        svc.broadcast('L', 'tag', 'T1');
        expect(workers[0].posted.length).toBe(n0);
        expect(svc.stats().byKind.echo.worker).toBe(4);
    });
    it("a crash rejects only that worker's job; the lane keeps serving; a running cancel discards the result", async () => {
        const svc = new WorkerJobService({ hardwareCap: 2 });
        FakeWorker.handlers = { slow: async (n: number) => { await tick(20); return n; } };
        const workers: FakeWorker[] = [];
        svc.registerLane({ lane: 'L', create: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; } });
        svc.registerKind({ kind: 'slow', lane: 'L' });
        const a = svc.run<number, number>('slow', 1), b = svc.run<number, number>('slow', 2);
        workers[0].crash();
        await expect(a.promise).rejects.toThrow(/worker error/);
        b.cancel();
        await expect(b.promise).rejects.toBeInstanceOf(JobCancelledError);
        const c = svc.run<number, number>('slow', 3);
        expect(await c.promise).toBe(3);
    });
    it('P19: a terminateOnCancel cancel replaces its worker at once (the live count never drains); switch off = lazily', async () => {
        for (const on of [true, false]) {
            WorkerJobService.respawnRecycled = on;
            try {
                const svc = new WorkerJobService({ hardwareCap: 3 });
                FakeWorker.handlers = { slow: async (n: number) => { await tick(20); return n; } };
                svc.registerLane({ lane: 'L', create: () => new FakeWorker() as unknown as Worker });
                svc.registerKind({ kind: 'slow', lane: 'L', terminateOnCancel: true });
                svc.ensureWorkers('L', 3);
                const hs = [1, 2, 3].map(n => svc.run<number, number>('slow', n));
                for (const h of hs) { h.cancel(); await expect(h.promise).rejects.toBeInstanceOf(JobCancelledError); }
                expect(svc.liveWorkers('L')).toBe(on ? 3 : 0);   // off: every recycle shrank the lane (nothing queued to respawn it)
                expect(await svc.run<number, number>('slow', 4).promise).toBe(4);   // either way the lane still serves
            } finally { WorkerJobService.respawnRecycled = true; }
        }
    });
    it('disposeLane rejects queued + running jobs (callers take their own fallback)', async () => {
        const svc = new WorkerJobService({ hardwareCap: 1 });
        FakeWorker.handlers = { slow: async (n: number) => { await tick(20); return n; } };
        svc.registerLane({ lane: 'L', create: () => new FakeWorker() as unknown as Worker });
        svc.registerKind({ kind: 'slow', lane: 'L' });
        const a = svc.run('slow', 1), b = svc.run('slow', 2);
        svc.disposeLane('L');
        await expect(a.promise).rejects.toThrow(/disposed/);
        await expect(b.promise).rejects.toThrow(/disposed/);
        expect(svc.liveWorkers('L')).toBe(0);
    });
    it('bug-hunt 2026-10-01: a crash-capped lane after disposeLane still settles jobs (fallback / reject), never strands them', async () => {
        const svc = new WorkerJobService({ hardwareCap: 1 });
        FakeWorker.handlers = { slow: async (n: number) => { await tick(5); return n; } };
        const workers: FakeWorker[] = [];
        svc.registerLane({ lane: 'L', create: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; } });
        svc.registerKind({ kind: 'slow', lane: 'L', handler: (n: number) => n * 10 });
        for (let i = 0; i < 3; i++) {   // three crashes (a dispose between each re-arms the lane) → stops respawning
            const h = svc.run<number, number>('slow', i, { mode: 'worker' });
            workers[workers.length - 1].crash();
            await expect(h.promise).rejects.toThrow(/worker error/);
            svc.disposeLane('L');   // e.g. setStreamWorkers(false) → resets `failed` but not `crashes`
        }
        const auto = svc.run<number, number>('slow', 7);
        const forced = svc.run<number, number>('slow', 8, { mode: 'worker' });
        const settled = await Promise.race([
            Promise.allSettled([auto.promise, forced.promise]),
            tick(200).then(() => 'STRANDED' as const),
        ]);
        expect(settled).not.toBe('STRANDED');
        expect(await auto.promise).toBe(70);   // main-thread fallback
        await expect(forced.promise).rejects.toBeInstanceOf(WorkerUnavailableError);
    });
    it('unsupported lane (supported() false) → fallback even with Worker present', async () => {
        const svc = new WorkerJobService();
        const spy = vi.fn(() => new FakeWorker() as unknown as Worker);
        svc.registerLane({ lane: 'L', create: spy, supported: () => false });
        svc.registerKind({ kind: 'k', lane: 'L', handler: (n: number) => n * 2 });
        expect(await svc.run('k', 4).promise).toBe(8);
        expect(spy).not.toHaveBeenCalled();
    });
});
