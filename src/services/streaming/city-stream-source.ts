// The city's StreamSource — the first (flagship) implementation of the streaming contract.  It answers three
// questions for the generic StreamManager: which tiles the focus needs, how to build one, how to dispose one.
// Phase 0 keeps the legacy behaviour exactly: the target set is the fixed grid around the origin (radius =
// tileRadius), nearest-first, and build/dispose delegate to the world manager. Later phases make targetChunks
// focus-relative (Phase 1/2) and add a detail tier (Phase 3) without touching the manager.
//
// See docs/specs/spatial-streaming.md.  The world manager stays the "host" that owns the actual geometry;
// this class is just the seam that lets the content-agnostic manager drive it.

import type { LayoutParams } from '../../world/types';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Focus, StreamBudget, StreamKey, StreamSource } from './stream-manager';

/** The bits of the world manager the city source needs. Keeps this file free of world-manager internals. */
export interface CityStreamHost {
    /** Current params to build tiles with (set right before each reconcile — mirrors the old `_buildTile(p,…)`). */
    tileParams(): LayoutParams | null;
    /** Build ONE neighbour tile's mesh groups and register them in the scene. `proxy` = a cheap far-tile stand-in
     *  (flat map only) regardless of `tileDetail`, so distant tiles cost almost nothing. SYNCHRONOUS (main thread). */
    buildTile(p: LayoutParams, tx: number, tz: number, proxy: boolean): MeshGroup3D[];
    /** Build ONE FULL 3D tile via the Worker pool — generation runs off the main thread, geometry transfers back,
     *  the main thread only wraps + uploads. Only called when `canUseWorkers()` is true (Phase 4). */
    buildTileAsync(p: LayoutParams, tx: number, tz: number): Promise<MeshGroup3D[]>;
    /** Whether tile generation can be offloaded to Workers right now (a live pool). False → the sync path is used. */
    canUseWorkers(): boolean;
    /** Live worker count — the source caps concurrent async dispatches to it (queue waits on the manager, not the
     *  pool, so a pan re-prioritises what actually builds). Optional; absent → a conservative default. */
    workerCount?(): number;
    /** Remove a built tile's groups from the scene + the flat group list (the old drop loop). `key` (when known)
     *  lets the host RETIRE a full tile's built groups into its LRU cache instead of dropping them. */
    disposeTile(groups: MeshGroup3D[], key?: StreamKey): void;
    /** After each async build slice — request a render so tiles pop in progressively. */
    onSlice(): void;
    /** Once the build queue drains — recache bounds + reframe if this was a fresh build. */
    onSettled(): void;
}

/** A chunk key is "tx,tz" for a full tile or "tx,tz|p" for a proxy (far, cheap) tile. Encoding the DETAIL TIER in
 *  the key means a zoom change that reclassifies a tile changes its key, so the generic reconcile disposes the old
 *  version and builds the new one — the StreamManager never needs a detail concept of its own. */
export function tileKey(tx: number, tz: number, proxy: boolean, lite = false): StreamKey {
    return proxy ? `${tx},${tz}|p` : lite ? `${tx},${tz}|l` : `${tx},${tz}`;
}
export function parseKey(key: StreamKey): { tx: number; tz: number; proxy: boolean; lite: boolean } {
    const bar = key.indexOf('|');
    const core = bar >= 0 ? key.slice(0, bar) : key;
    const c = core.split(',');
    return { tx: Number(c[0]), tz: Number(c[1]), proxy: key.endsWith('|p'), lite: key.endsWith('|l') };
}

export class CityStreamSource implements StreamSource<MeshGroup3D[]> {
    // 5 ms: the old 10 ms slice left only ~6 ms of a 16.6 ms frame for render + input while streaming — visible
    // hitching during a pan. (A single heavy sync build can still overrun — the slice is only checked between
    // builds — but full 3D tiles go async via workers, so sync builds here are cheap flat maps.)
    readonly sliceMs = 5;
    constructor(private readonly host: CityStreamHost) {}

    /** Cap concurrent async worker dispatches to the pool size — excess queue stays on the manager where the next
     *  reconcile can re-prioritise (or drop) it, instead of going stale inside the pool's FIFO. */
    get maxConcurrentBuilds(): number { return Math.max(1, this.host.workerCount?.() ?? 4); }

    /** Same chunk across detail tiers: "tx,tz" and "tx,tz|p" are the SAME tile → reconcile holds the old tier's
     *  geometry visible until the replacement builds (no blink when a tile crosses the full/proxy boundary). */
    chunkId(key: StreamKey): string {
        const bar = key.indexOf('|');
        return bar >= 0 ? key.slice(0, bar) : key;
    }

    /** Preview-eligible = only the keys whose full build is genuinely heavier than the preview: full-3D tiles in a
     *  `tileDetail:'full'` world. Proxies (and flat worlds) skip the preview queue hop entirely. */
    canPreviewKey(key: StreamKey): boolean {
        if (key.indexOf('|') >= 0) return false;                 // proxy — its full build IS the flat stand-in
        const p = this.host.tileParams();
        return !!p && p.tileDetail === 'full';
    }

    /** A window of neighbour tiles around the FOCUS tile, nearest-to-focus first. The window RADIUS is
     *  `budget.loadRadius` (Phase 3: derived from zoom — small when zoomed in, up to `tileRadius` when zoomed out),
     *  and every tile past `budget.detailRadius` is a cheap PROXY (flat map) rather than full geometry. The origin
     *  tile (0,0) is skipped — it's the full centre city living in `_groups`. With the follow off + a full budget
     *  (loadRadius = detailRadius = tileRadius, focus at origin) this is byte-for-byte the old all-full grid. */
    targetChunks(focus: Focus, budget: StreamBudget): StreamKey[] {
        const p = this.host.tileParams();
        if (!p) return [];
        const cap = Math.max(0, Math.min(3, (p.tileRadius ?? 1) | 0));
        const load = Math.max(0, Math.min(cap, budget.loadRadius | 0));      // resident window radius (in tiles)
        const detail = Math.max(0, Math.min(load, budget.detailRadius | 0)); // full-detail radius; beyond → proxy
        // Proxy only CHANGES a tile when it would otherwise be a full 3D city — for flat/focus neighbours a proxy
        // build is identical, so keep the plain key (no needless dispose+rebuild churn as the tier flips).
        const canProxy = p.tileDetail === 'full';
        const span = 2 * p.radius;                       // world units spanned by one tile (see _buildTile's offset)
        const fx = span > 0 ? Math.round(focus.x / span) : 0;   // the tile the focus sits on
        const fz = span > 0 ? Math.round(focus.z / span) : 0;
        const tiles: Array<{ tx: number; tz: number; proxy: boolean; d2: number }> = [];
        for (let dz = -load; dz <= load; dz++) for (let dx = -load; dx <= load; dx++) {
            const tx = fx + dx, tz = fz + dz;
            if (tx === 0 && tz === 0) continue;          // (0,0) = the full centre city, not a neighbour tile
            const cheb = Math.max(Math.abs(dx), Math.abs(dz));
            tiles.push({ tx, tz, proxy: canProxy && cheb > detail, d2: dx * dx + dz * dz });
        }
        tiles.sort((a, b) => a.d2 - b.d2);
        return tiles.map(t => tileKey(t.tx, t.tz, t.proxy));
    }

    /** Proxy-first (instant load): a FULL 3D tile shows a cheap flat stand-in immediately, then upgrades to full via
     *  `build`. Skip (return null) when the full build isn't actually heavier than the preview — a tile that's
     *  already a proxy, or a non-`full` world whose tiles are flat anyway (building the flat twice would be waste). */
    buildPreview(key: StreamKey): MeshGroup3D[] | null {
        const { tx, tz, proxy } = parseKey(key);
        if (proxy) return null;
        const p = this.host.tileParams();
        if (!p || p.tileDetail !== 'full') return null;
        return this.host.buildTile(p, tx, tz, /*proxy*/ true);
    }

    // Memoized LITE variant of the current params (detailed buildings OFF). "|l" tiles — full 3D tiles built while
    // the camera is zoomed out past the detail LOD band — use it: the detail would be LOD-HIDDEN anyway, but a
    // detailed tile still costs ~4-5× to generate/ship/upload and keep resident, and its ArrayGroups force full
    // instance repacks. Building WITHOUT detail at far zoom makes detail-on streaming cost the same as detail-off.
    private _liteSrc: LayoutParams | null = null;
    private _liteParams: LayoutParams | null = null;
    private _liteOf(p: LayoutParams): LayoutParams {
        if (this._liteSrc !== p) { this._liteSrc = p; this._liteParams = { ...p, detailedBuildings: false }; }
        return this._liteParams!;
    }

    build(key: StreamKey): MeshGroup3D[] | Promise<MeshGroup3D[]> {
        const p = this.host.tileParams();
        // THROW, don't return [] — an empty handle would be cached as a completed full build and the tile would
        // stay permanently blank. A throw leaves it unbuilt so the next reconcile retries.
        if (!p) throw new Error('city stream: no tile params');
        const { tx, tz, proxy, lite } = parseKey(key);
        const bp = lite ? this._liteOf(p) : p;   // lite tier: same full 3D tile, minus the detailed-building load
        // A FULL 3D tile is the expensive build → offload generation to the Worker pool (async) when available.
        // Proxy / non-full tiles are cheap flat maps → build synchronously on the main thread.
        if (!proxy && p.tileDetail === 'full' && this.host.canUseWorkers()) {
            return this.host.buildTileAsync(bp, tx, tz).then(g => {
                // STALE-PARAMS GUARD: params changed while the worker built (seed/layout edit) → the result is
                // from the OLD world. Dispose + reject; the param change's own reconcile rebuilds with fresh params.
                if (this.host.tileParams() !== p) { this.host.disposeTile(g); throw new Error('stale tile params'); }
                return g;
            });
        }
        return this.host.buildTile(bp, tx, tz, proxy);
    }

    dispose(key: StreamKey, groups: MeshGroup3D[]): void {
        this.host.disposeTile(groups, key);
    }

    onProgress(): void { this.host.onSlice(); }
    onDrained(): void { this.host.onSettled(); }
}
