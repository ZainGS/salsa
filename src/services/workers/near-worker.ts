// Runs in a Web Worker — the WorkerJobService's 'near' lane (near-lane.ts): the near-field jobs (near-jobs.ts):
// collision-cell BVHs and crowd cell meshes. Imports only pure builders.

import { serveJobs } from './worker-job-runtime';
import { NEAR_JOB_HANDLERS } from './near-jobs';

serveJobs(NEAR_JOB_HANDLERS);
