// Runs in a Web Worker — the WorkerJobService's 'character' lane (character-lane.ts). Serves the character job kinds
// (character-jobs.ts): procedural body / garments / hair generation, results TRANSFERRED back as GPU-ready typed
// arrays. Imports only the pure generators — no DOM / WebGPU / scene-graph. See docs/specs/performance-plan.md P3.2.

import { serveJobs } from './worker-job-runtime';
import { CHARACTER_JOB_HANDLERS } from './character-jobs';

serveJobs(CHARACTER_JOB_HANDLERS);
