// ── World generation — TRAFFIC PRECOMPUTE (performance-plan P5.W4) ─────────────────────────────────
// Everything the live traffic sim needs from a finished city that is pure CPU work: the mover specs (computeTraffic —
// route starts, archetype geometry, train consists, sky / weather / wildlife) and the routing network (roadNet — the
// intersection graph + the street plan). After a city appears this used to cost ~50 ms (road net + street plan) +
// ~50–100 ms (computeTraffic) on the main thread, on the frames right after the reveal. The worker centre build now
// runs it after the group builders (the graph is final then) and ships the result: upload-ready geometry
// (transferable typed arrays — world-jobs.ts transferTraffic) + the net as plain data. The main thread adopts the net
// (route-sim adoptRoadNet) and only creates the mover meshes, time-sliced (WorldTraffic.startSliced).
//
// DETERMINISM: computeTraffic + roadNet are pure functions of the graph; the worker runs them on the final worker
// graph, the main thread used to run them on its structured clone of it — the same data, so the same output
// (world-traffic-precompute.test.ts pins worker == main byte-for-byte). Pure (no DOM / WebGPU) → worker-safe.

import type { WorldGraph, LayoutParams } from './types';
import { computeTraffic, type MoverSpec } from './traffic';
import { roadNet, roadNetData, type RoadNetData } from './route-sim';

export interface TrafficPrecompute {
    /** computeTraffic(graph), in order. */
    specs: MoverSpec[];
    /** roadNet(graph) as plain data (null = the consumer builds / already has the net — the main-thread staging path,
     *  where the graph object is the same and roadNet is memoized on it). */
    net: RoadNetData | null;
    /** Fingerprint of the params the specs were computed for (a selective regen between the precompute and the
     *  spawn changes `graph.params` in place → the precompute is stale). */
    paramsKey: string;
}

/** Canonical params fingerprint (key-order-insensitive; `adverts` excluded — image payloads, not read by traffic). */
export function trafficParamsKey(p: Partial<LayoutParams>): string {
    const o = p as Record<string, unknown>;
    return JSON.stringify(Object.keys(o).filter(k => k !== 'adverts' && o[k] !== undefined).sort().map(k => [k, o[k]]));
}

/** Does this city get live traffic at all (the conditions WorldManager spawns under)? Tiled worlds auto-stop it. */
export function wantsTraffic(p: Partial<LayoutParams>): boolean {
    return p.worldMode !== 'tiled' && p.traffic !== false;
}

/** The traffic precompute for a FINISHED graph (every builder ran — planes read lot.builtH). `withNet` ships the
 *  routing net as data (the worker path); false leaves it to the consumer's memoized roadNet (same thread). */
export function precomputeTraffic(graph: WorldGraph, withNet = true): TrafficPrecompute {
    const specs = computeTraffic(graph);
    return { specs, net: withNet ? roadNetData(roadNet(graph)) : null, paramsKey: trafficParamsKey(graph.params) };
}
