// The 'near' LANE's job kinds (engine-roadmap step 3, performance-plan §P13 "Step 3"): the NEAR-FIELD work built
// around the player / camera, off the main thread and off the world lane (whose workers are busy with seconds-long
// tile builds):
//  - the Play collision cells' merged BVHs (src/game/collision-cells.ts);
//  - the instanced crowd's near / mid cell meshes (src/world/crowd-instanced.ts CrowdCellBuilder).
// The SAME handlers run inside the near Worker (near-worker.ts → serveJobs) and as the WorkerJobService's main-thread
// fallback. Pure: no DOM / WebGPU / scene graph.

import { buildFlatBVH, type CellSoup, type FlatBVH } from '../../game/collision-cells';
import { buildCrowdCell, type CrowdCellJob, type CrowdCellResult } from '../../world/crowd-instanced';
import type { JobHandler } from './worker-job-runtime';

export const NEAR_LANE = 'near';
export const NEAR_JOB = {
    /** One collision cell's triangle soup → its flat BVH (reordered triangles + nodes), transferred back. */
    cellBvh: 'collision.cellBvh',
    /** One instanced-crowd near / mid cell (its people's record rows) → the merged cell mesh + ranges + pivots. */
    crowdCell: 'crowd.cell',
} as const;

const cellBvhJob: JobHandler<CellSoup, FlatBVH> = (soup, api) => {
    const bvh = buildFlatBVH(soup);
    if (!api.fallback) api.transfer(bvh.bounds.buffer, bvh.data.buffer, bvh.tris.buffer, bvh.ids.buffer);
    return bvh;
};

const crowdCellJob: JobHandler<CrowdCellJob, CrowdCellResult> = (job, api) => {
    const r = buildCrowdCell(job);
    if (!api.fallback) api.transfer(r.vertices.buffer, r.indices.buffer, r.ranges.buffer, r.refs.buffer, r.piv.buffer, ...(r.bounds ? [r.bounds.buffer] : []), ...(r.runBoxes ? [r.runBoxes.buffer] : []));
    return r;
};

export const NEAR_JOB_HANDLERS: Record<string, JobHandler<any, any>> = {
    [NEAR_JOB.cellBvh]: cellBvhJob,
    [NEAR_JOB.crowdCell]: crowdCellJob,
};
