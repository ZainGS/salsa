// Runs in a Web Worker — the WorkerJobService's 'world' lane (spawned via TileWorkerPool / world-lane.ts).
// Serves the world job kinds (world-jobs.ts): ONE neighbour tile's flat layer-groups, the CENTRE city's full regen
// (audit §1.2), and SELECTIVE group regens (performance-plan P3.2) — all off the main thread via the SHARED pure
// builders, geometry TRANSFERRED back (zero-copy). Imports only pure `src/world` — no DOM / WebGPU — so it is
// worker-safe. See docs/specs/streaming-optimizations.md Phase 4 + docs/specs/performance-plan.md P3.

import { serveJobs } from '../workers/worker-job-runtime';
import { WORLD_JOB_HANDLERS } from '../workers/world-jobs';

serveJobs(WORLD_JOB_HANDLERS);
