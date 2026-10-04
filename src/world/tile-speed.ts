// ── P22 tile landing: faster tile builds (performance-plan §P22) ──────────────────────────────────────────────────────
// The A/B switches of the tile-build speed-ups. Every one leaves the build's OUTPUT unchanged, byte for byte
// (tile-speed.test.ts builds tiles with all on and all off and compares every vertex, index, transform and box).
// They live in this module so the builders can read them cheaply; a tile build applies the job's `opts.speed`
// (TileBuildOptions, plain data → the same in the worker and on the main thread) around its run (`withTileSpeed`).

export interface TileSpeedSwitches {
    /** The height field's out-of-core lattice nodes (every streamed tile's vertices) cached in 32 × 32 blocks of doubles
     *  instead of one Map entry per node (elevation.ts makeHeightField). */
    nodeBlocks: boolean;
    /** The domain warp evaluates its two value-noise pairs with the shared floor / fade terms computed once
     *  (warp.ts makeDomainWarpInto; the same arithmetic in the same order). */
    fusedWarp: boolean;
    /** The memoised drape does the height pass, the warp pass and the bounds scan in ONE pass over each layer, on one
     *  table (drape-memo.ts applyDrapeFused; was three passes and two tables). */
    fusedDrape: boolean;
}

export const TILE_SPEED: TileSpeedSwitches = { nodeBlocks: true, fusedWarp: true, fusedDrape: true };

/** Every switch off (the P20 build) — the A/B reference. */
export const TILE_SPEED_OFF: TileSpeedSwitches = { nodeBlocks: false, fusedWarp: false, fusedDrape: false };

/** Run `fn` with `over` applied to TILE_SPEED (restored after, even on a throw). */
export function withTileSpeed<T>(over: Partial<TileSpeedSwitches> | undefined, fn: () => T): T {
    if (!over) return fn();
    const prev = { ...TILE_SPEED };
    Object.assign(TILE_SPEED, over);
    try { return fn(); } finally { Object.assign(TILE_SPEED, prev); }
}
