import { describe, it, expect } from 'vitest';
import { TileWorkerPool } from './tile-worker-pool';
import { WORLD_JOB_HANDLERS, WORLD_JOB } from '../workers/world-jobs';
import type { WorkerJobService } from '../workers/worker-job-service';
import type { LayoutParams } from '../../world';

// bug-hunt 2026-10-01 D-W2: tile params used to be SHARED lane state (broadcast, identity-compared) — a queued lite/full
// tile job ran with whichever params were broadcast last, and an in-place params mutation never re-broadcast. Each
// tile job now carries a SNAPSHOT of its own params.
function fakeSvc() {
    const runs: { kind: string; payload: unknown }[] = [];
    const svc = {
        registerLane() {}, hasKind: () => true, registerKind() {}, ensureWorkers() {}, liveWorkers: () => 1, broadcast() {},
        run(kind: string, payload: unknown) { runs.push({ kind, payload }); return { id: 1, promise: new Promise(() => {}), cancel() {} }; },
        hardwareCap: 1,
    };
    return { svc: svc as unknown as WorkerJobService, runs };
}

describe('TileWorkerPool tile params', () => {
    it('each tile job carries its own params snapshot (lite vs full never race; in-place edits never leak)', () => {
        const g = globalThis as { Worker?: unknown };
        const had = 'Worker' in g; const prev = g.Worker;
        g.Worker = class {};
        try {
            const { svc, runs } = fakeSvc();
            const pool = new TileWorkerPool(1, svc);
            const full = { seed: 1, detailedBuildings: true } as unknown as LayoutParams;
            const lite = { ...full, detailedBuildings: false } as LayoutParams;
            void pool.build(full, 0, 1);
            void pool.build(lite, 1, 0);
            (full as { seed: number }).seed = 99;   // in-place mutation AFTER the request
            const p0 = (runs[0].payload as { params: LayoutParams }).params, p1 = (runs[1].payload as { params: LayoutParams }).params;
            expect(runs[0].kind).toBe(WORLD_JOB.tile);
            expect(p0.detailedBuildings).toBe(true);
            expect(p1.detailedBuildings).toBe(false);
            expect((p0 as { seed: number }).seed).toBe(1);
        } finally { if (had) g.Worker = prev; else delete g.Worker; }
    });

    it('the tile handler builds from the job params, not the lane-shared ones', () => {
        const handler = WORLD_JOB_HANDLERS[WORLD_JOB.tile];
        expect(() => handler({ tx: 0, tz: 0 }, { shared: {}, transfer() {}, progress() {}, fallback: true } as never)).toThrow(/no params/);
    });
});
