/**
 * P16 streaming hitches (docs/specs/performance-plan.md §P16, docs/ui/performance.md §Streaming hitches): the A/B
 * switches + limits shared by the renderer (instance slots, array-group packs, upload ledger, deferred eviction), the
 * world manager (LOD stamps) and the scene manager (collision snapshot). All on by default; per session (never saved).
 * `sm.setStreamHitchOptions3D({...})` / `sm.getStreamHitchOptions3D()` / `sm.getStreamHitchStats3D()`.
 */
export interface StreamHitchOptions {
    /** The instance-slot allocator keeps its free space coalesced and bucketed by size (O(1) frees, a bucket scan per
     *  range alloc). false = the P5 unsorted free list (every range alloc scanned it; ~20 ms a tile landing). */
    indexedSlotFree: boolean;
    /** Newly shown array groups are packed under a per-frame instance budget, nearest in-view first; a group not packed
     *  yet is not placed, so it is not drawn (never with stale data). false = every new group packed in one frame. */
    slicedGroupPacks: boolean;
    /** A removed group detaches at once (scene graph, picker), and the renderer's per-mesh cleanup (slots, geometry
     *  refs, caches) runs over the next frames under a time budget. false = all of it in the removing call. */
    deferredEviction: boolean;
    /** One per-frame write ledger: instance / group-pack bytes come off the frame's upload budget first, geometry takes
     *  the rest (with a floor so it never starves); no single geometry write over the write cap. false = the step-3
     *  geometry-only budget (16 MB a frame, 4 MB a write). */
    uploadLedger: boolean;
    /** The LOD stamps (draw distances, fog class, twin distances) look tiers up by node name once per name (memo per
     *  tier list), and a whole-world restamp skips groups already stamped for the current key. false = regexes per node. */
    lodStampMemo: boolean;
    /** The Play collision snapshot trusts a member's footprint by its own geometry version (Mesh3D.geometryVersion)
     *  instead of the global geometry epoch (which every new streamed mesh bumps: every sync re-read all ~13 k). */
    snapshotMeshVersion: boolean;
    /** The GPU geometry-pool compaction moves runs of adjacent live geometries as one copy (chunked by its scratch)
     *  instead of one copy pair per geometry: thousands of encoder calls, 5-20 ms of CPU, in the compaction frame. */
    coalescedCompaction: boolean;
}

export const STREAM_HITCH: StreamHitchOptions = {
    indexedSlotFree: true,
    slicedGroupPacks: true,
    deferredEviction: true,
    uploadLedger: true,
    lodStampMemo: true,
    snapshotMeshVersion: true,
    coalescedCompaction: true,
};

/** Tunables (not switches). */
export const STREAM_HITCH_LIMITS = {
    /** Array-group instances packed per frame (fresh packs; reclaims of parked ranges are free). ~1-3 µs each (per-instance rotation / scale overrides cost the most). */
    groupPackInstances: 1_500,
    /** Milliseconds of deferred mesh eviction per frame. */
    evictBudgetMs: 1.5,
    /** Largest single geometry write under the ledger (bytes). */
    writeSliceBytes: 2 << 20,
    /** All upload bytes in one frame interval under the ledger (instances + group packs + geometry + warms). */
    frameWriteBytes: 8 << 20,
    /** Geometry always gets at least this much of a frame (bytes), whatever the instance writes took. */
    geomFloorBytes: 2 << 20,
};

/** Diagnostics (sm.getStreamHitchStats3D). */
export const streamHitchStats = {
    /** Groups whose pack was deferred to a later frame (sum over frames) / frames that deferred any. */
    groupPacksDeferred: 0, groupPackFramesDeferred: 0,
    /** Meshes evicted through the deferred queue / the most left in it / drains that hit the time budget. */
    evictDeferred: 0, evictQueueMax: 0, evictBudgetHits: 0, evictFlushed: 0,
    /** Instance / group-pack bytes written through the ledger (last frame, max frame). */
    instBytesLast: 0, instBytesMax: 0,
    /** Largest whole frame of upload bytes seen by the ledger. */
    frameBytesMax: 0,
    /** LOD stamp: groups skipped (already stamped for the key) / restamped; tier-name memo hits / misses. */
    stampSkipped: 0, stampDone: 0, memoHits: 0, memoMisses: 0,
};

export function resetStreamHitchStats(): void {
    for (const k of Object.keys(streamHitchStats) as (keyof typeof streamHitchStats)[]) streamHitchStats[k] = 0;
}
