/**
 * The 'near' worker lane (engine-roadmap step 3): collision-cell BVHs and crowd cells. Headless there is no Worker, so
 * the collision job runs on the service's main-thread fallback (same handler, same output) and the crowd job — worker
 * only — rejects, which is the caller's cue to keep its main-thread builder.
 */
import { describe, it, expect } from 'vitest';
import { WorkerJobService } from './worker-job-service';
import { registerNearLane, nearWorkerAvailable } from './near-lane';
import { NEAR_JOB, NEAR_JOB_HANDLERS } from './near-jobs';
import { buildFlatBVH, type CellSoup } from '../../game/collision-cells';

function soup(n: number): CellSoup {
    const tris = new Float32Array(n * 9), ids = new Uint32Array(n * 2);
    for (let i = 0; i < tris.length; i++) tris[i] = ((i * 7919) % 1000) / 37;
    for (let t = 0; t < n; t++) { ids[t * 2] = t % 3; ids[t * 2 + 1] = t; }
    return { tris, ids };
}

describe('near lane (step 3)', () => {
    it('registers both job kinds', () => {
        const svc = registerNearLane(new WorkerJobService({ hardwareCap: 2 }));
        expect(svc.hasKind(NEAR_JOB.cellBvh)).toBe(true);
        expect(svc.hasKind(NEAR_JOB.crowdCell)).toBe(true);
        expect(Object.keys(NEAR_JOB_HANDLERS).sort()).toEqual([NEAR_JOB.cellBvh, NEAR_JOB.crowdCell].sort());
    });
    it('headless: the collision cell BVH comes from the fallback, equal to a direct build', async () => {
        const svc = registerNearLane(new WorkerJobService({ hardwareCap: 2 }));
        const s = soup(300);
        const ref = buildFlatBVH({ tris: s.tris.slice(), ids: s.ids.slice() });
        const got = await svc.run<CellSoup, ReturnType<typeof buildFlatBVH>>(NEAR_JOB.cellBvh, s, { priority: 'background' }).promise;
        expect(got.nodes).toBe(ref.nodes);
        expect(Array.from(got.tris)).toEqual(Array.from(ref.tris));
        expect(Array.from(got.ids)).toEqual(Array.from(ref.ids));
        expect(Array.from(got.data)).toEqual(Array.from(ref.data));
    });
    it('headless: no worker → crowd cells stay on the main thread', () => {
        expect(nearWorkerAvailable()).toBe(false);
    });
});
