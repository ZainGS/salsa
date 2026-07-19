// Runs in a Web Worker (spawned by TileWorkerPool). Generates ONE neighbour tile's flat layer-groups off the main
// thread via the SHARED `buildTileLayerGroups`, then TRANSFERS the geometry buffers back (zero-copy). Imports only
// pure `src/world` — no DOM / WebGPU — so it is worker-safe. See docs/specs/streaming-optimizations.md Phase 4.

import { buildTileLayerGroups } from '../../world/tile-build';
import type { LayoutParams } from '../../world';

/** Either a params BROADCAST (cached; sent once per change, not per tile) or a build request (uses the cache). */
type TileMessage = { params: LayoutParams } | { id: number; tx: number; tz: number };

// This module runs in a Worker, but the main tsconfig types `self` as the DOM `Window`. Cast to just the two
// members we use — avoids pulling the webworker lib (which would clash with DOM in the shared compile).
const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<TileMessage>) => void) | null;
    postMessage: (message: unknown, transfer: Transferable[]) => void;
};

let cachedParams: LayoutParams | null = null;

ctx.onmessage = (e): void => {
    if ('params' in e.data) { cachedParams = e.data.params; return; }   // params broadcast — cache for later builds
    const { id, tx, tz } = e.data;
    if (!cachedParams) { ctx.postMessage({ id, error: 'tile worker: no params' }, []); return; }   // protocol violation guard
    const groups = buildTileLayerGroups(cachedParams, tx, tz, /*full*/ true);
    // COPY each geometry into FRESH buffers, then transfer the copies. We must NOT transfer the builders' geometry
    // directly: instanced detail (balconies / greenery clumps) is MODULE-CACHED and reused across tiles, so
    // transferring (which DETACHES) would corrupt the cache and break every later build in this worker — and a
    // buffer shared by two layers would be transferred twice (DataCloneError). Fresh copies are unique + cache-safe;
    // the memcpy runs here on the worker thread, off the main thread. The main thread still receives them zero-copy.
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
    ctx.postMessage({ id, groups }, transfer);
};
