// Runs in a Web Worker (spawned by TileWorkerPool). Generates ONE neighbour tile's flat layer-groups — or the
// CENTRE city's full regen (audit §1.2) — off the main thread via the SHARED `buildTileLayerGroups` /
// `buildCentreGroups`, then TRANSFERS the geometry buffers back (zero-copy). Imports only pure `src/world` —
// no DOM / WebGPU — so it is worker-safe. See docs/specs/streaming-optimizations.md Phase 4.

import { buildTileLayerGroups } from '../../world/tile-build';
import type { TileLayerGroup } from '../../world/tile-build';
import { buildCentreGroups } from '../../world/centre-build';
import type { LayoutParams } from '../../world';

/** A params BROADCAST (cached; sent once per change, not per tile), a tile build request (uses the cache), or a
 *  CENTRE full-regen request (its params ride along — regens are rare, one clone per regen is fine). */
type TileMessage =
    | { params: LayoutParams }
    | { id: number; tx: number; tz: number }
    | { id: number; centre: true; params: Partial<LayoutParams>; parkedTrain: boolean; activeRegions: number[] | null };

// This module runs in a Worker, but the main tsconfig types `self` as the DOM `Window`. Cast to just the two
// members we use — avoids pulling the webworker lib (which would clash with DOM in the shared compile).
const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<TileMessage>) => void) | null;
    postMessage: (message: unknown, transfer: Transferable[]) => void;
};

let cachedParams: LayoutParams | null = null;

/** COPY each geometry into FRESH buffers, then transfer the copies. We must NOT transfer the builders' geometry
 *  directly: instanced detail (balconies / greenery clumps) is MODULE-CACHED and reused across builds, so
 *  transferring (which DETACHES) would corrupt the cache and break every later build in this worker — and a
 *  buffer shared by two layers would be transferred twice (DataCloneError). Fresh copies are unique + cache-safe;
 *  the memcpy runs here on the worker thread, off the main thread. The main thread still receives them zero-copy. */
function copyForTransfer(groups: TileLayerGroup[]): Transferable[] {
    const transfer: Transferable[] = [];
    for (const grp of groups) {
        for (const L of grp.layers) {
            const g = L.geometry;
            const vertices = g.vertices.slice();
            const indices = g.indices ? g.indices.slice() : g.indices;
            L.geometry = { ...g, vertices, indices };
            transfer.push(vertices.buffer);
            if (indices) transfer.push(indices.buffer);
        }
    }
    return transfer;
}

ctx.onmessage = (e): void => {
    if ('centre' in e.data) {   // CENTRE full regen: groups + the builder-MUTATED graph (adopted main-side)
        const { id, params, parkedTrain, activeRegions } = e.data;
        const { groups, graph } = buildCentreGroups(params, { parkedTrain, activeRegions });
        ctx.postMessage({ id, groups, graph }, copyForTransfer(groups));
        return;
    }
    if ('params' in e.data) { cachedParams = e.data.params; return; }   // params broadcast — cache for later builds
    const { id, tx, tz } = e.data;
    if (!cachedParams) { ctx.postMessage({ id, error: 'tile worker: no params' }, []); return; }   // protocol violation guard
    const groups = buildTileLayerGroups(cachedParams, tx, tz, /*full*/ true);
    ctx.postMessage({ id, groups }, copyForTransfer(groups));
};
