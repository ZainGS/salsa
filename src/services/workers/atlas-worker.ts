// Runs in a Web Worker — the WorkerJobService's 'atlas' lane (registered by atlas-lane.ts). Composes GARP / adverts /
// vending-label sheets on an OffscreenCanvas off the main thread (performance-plan P3.2e). Handlers: atlas-jobs.ts.
import { serveJobs } from './worker-job-runtime';
import { ATLAS_JOB_HANDLERS } from './atlas-jobs';

serveJobs(ATLAS_JOB_HANDLERS);
