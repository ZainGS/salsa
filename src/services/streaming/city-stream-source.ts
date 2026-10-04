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
import type { HlodLevel } from '../../world/tile-hlod';

/** The bits of the world manager the city source needs. Keeps this file free of world-manager internals. */
export interface CityStreamHost {
    /** Current params to build tiles with (set right before each reconcile — mirrors the old `_buildTile(p,…)`). */
    tileParams(): LayoutParams | null;
    /** Build ONE neighbour tile's mesh groups and register them in the scene. `proxy` = a cheap far-tile stand-in
     *  (flat map only) regardless of `tileDetail`, so distant tiles cost almost nothing. SYNCHRONOUS (main thread). */
    buildTile(p: LayoutParams, tx: number, tz: number, proxy: boolean, massing?: boolean, hlod?: HlodLevel | null): MeshGroup3D[];
    /** Build ONE FULL 3D tile via the Worker pool — generation runs off the main thread, geometry transfers back,
     *  the main thread only wraps + uploads. Only called when `canUseWorkers()` is true (Phase 4). */
    buildTileAsync(p: LayoutParams, tx: number, tz: number, key?: StreamKey): Promise<MeshGroup3D[]>;
    /** P10.D5: build a CHEAP tile (flat proxy / massing) in a worker — null = take the synchronous `buildTile`
     *  (no live pool, the switch is off, or a cached build re-attaches at once). Optional. */
    buildCheapTileAsync?(p: LayoutParams, tx: number, tz: number, massing: boolean, key: StreamKey, hlod?: HlodLevel | null): Promise<MeshGroup3D[]> | null;
    /** P17: a tier swap of a chunk landed (`next` replaces the held `prev`). Return true to take over `prev`'s disposal
     *  (the host dissolves the HLOD side and disposes `prev` once the fade is done); false = dispose it now. Optional. */
    crossFadeTile?(prevKey: StreamKey, prev: MeshGroup3D[], prevPreview: boolean, nextKey: StreamKey, next: MeshGroup3D[]): boolean;
    /** P10.B5: cancel the in-flight worker build of `key` (it left the window). True = cancelled. Optional. */
    cancelTileBuild?(key: StreamKey): boolean;
    /** P10.B4: a retired (LRU-cached) build exists for `key` — its rebuild is a cheap re-attach, so no preview. */
    hasRetired?(key: StreamKey): boolean;
    /** Whether tile generation can be offloaded to Workers right now (a live pool). False → the sync path is used. */
    canUseWorkers(): boolean;
    /** Live worker count — the source caps concurrent async dispatches to it (queue waits on the manager, not the
     *  pool, so a pan re-prioritises what actually builds). Optional; absent → a conservative default. */
    workerCount?(): number;
    /** P10.D6: reserve 2 workers for the cheap (flat / massing) class — full builds get workers − 2 slots. Optional. */
    reserveCheap?(): boolean;
    /** P17: the cheap class streams the HLOD skyline (many tiles a second while flying) — it may take more workers and
     *  borrow full-build slots during a backlog (CityStreamSource.fullCapFor). Optional. */
    cheapBoost?(): boolean;
    /** P20 slotOnWorkerDone: is the in-flight build of `key` still on its WORKER (false once its result is being
     *  reassembled on the main thread — the worker slot is free for the next full build). Optional; absent = true. */
    holdsWorker?(key: StreamKey): boolean;
    /** P22 landingSlots: a still camera is landing full tiles — the full class keeps all its slots (fullCapFor does not
     *  lend two to the HLOD backlog). Optional; absent = false. */
    landing?(): boolean;
    /** Remove a built tile's groups from the scene + the flat group list (the old drop loop). `key` (when known)
     *  lets the host RETIRE a full tile's built groups into its LRU cache instead of dropping them. */
    disposeTile(groups: MeshGroup3D[], key?: StreamKey): void;
    /** After each async build slice — request a render so tiles pop in progressively. */
    onSlice(): void;
    /** Once the build queue drains — recache bounds + reframe if this was a fresh build. */
    onSettled(): void;
}

/** A chunk key is "tx,tz" for a full tile, "tx,tz|l" for a LITE full tile (no detailed buildings), "tx,tz|p" for a
 *  flat-map proxy, "tx,tz|m" for the MASSING tier (flat map + building boxes, P10.C1) and "tx,tz|h" / "tx,tz|f" for
 *  the P17 HLOD tiers (mid: merged building shells in colour buckets; far: a 2-draw silhouette). Encoding the DETAIL TIER in
 *  the key means a zoom change that reclassifies a tile changes its key, so the generic reconcile disposes the old
 *  version and builds the new one — the StreamManager never needs a detail concept of its own. */
export function tileKey(tx: number, tz: number, proxy: boolean, lite = false, massing = false): StreamKey {
    return massing ? `${tx},${tz}|m` : proxy ? `${tx},${tz}|p` : lite ? `${tx},${tz}|l` : `${tx},${tz}`;
}
/** P17: the key of an HLOD tile ('mid' → "tx,tz|h", 'far' → "tx,tz|f"). */
export function hlodKey(tx: number, tz: number, level: HlodLevel): StreamKey { return `${tx},${tz}|${level === 'mid' ? 'h' : 'f'}`; }
export function parseKey(key: StreamKey): { tx: number; tz: number; proxy: boolean; lite: boolean; massing: boolean; hlod: HlodLevel | null } {
    const bar = key.indexOf('|');
    const core = bar >= 0 ? key.slice(0, bar) : key;
    const c = core.split(',');
    return { tx: Number(c[0]), tz: Number(c[1]), proxy: key.endsWith('|p'), lite: key.endsWith('|l'), massing: key.endsWith('|m'),
        hlod: key.endsWith('|h') ? 'mid' : key.endsWith('|f') ? 'far' : null };
}
/** P17: an HLOD key ("|h" / "|f"). */
export const isHlodKey = (key: StreamKey): boolean => key.endsWith('|h') || key.endsWith('|f');

export class CityStreamSource implements StreamSource<MeshGroup3D[]> {
    // 5 ms: the old 10 ms slice left only ~6 ms of a 16.6 ms frame for render + input while streaming — visible
    // hitching during a pan. (A single heavy sync build can still overrun — the slice is only checked between
    // builds — but full 3D tiles go async via workers, so sync builds here are cheap flat maps.)
    readonly sliceMs = 5;
    /** P10.B4 A/B: LITE ("|l") tiles show the flat proxy as a preview while their worker build runs (they used to stay
     *  BLANK for the whole build — 2-4 s after the P9 content growth). false = the old no-preview behaviour. */
    static previewLite = true;
    /** P10 A/B: dispose a preview stand-in under its own proxy key (see dispose). false = the old (buggy) key. */
    static previewKeyFix = true;
    constructor(private readonly host: CityStreamHost) {}

    /** Cap concurrent async worker dispatches to the pool size — excess queue stays on the manager where the next
     *  reconcile can re-prioritise (or drop) it, instead of going stale inside the pool's FIFO. */
    get maxConcurrentBuilds(): number {
        const n = Math.max(1, this.host.workerCount?.() ?? 4);
        return this.host.reserveCheap?.() && n >= 4 ? n - 2 : n;   // P10.D6: keep 2 workers free for the cheap class
    }
    /** P10.D6: flat / massing tiles are their own concurrency class (fast worker jobs) — see StreamSource.isCheapKey. */
    isCheapKey(key: StreamKey): boolean { return key.endsWith('|p') || key.endsWith('|m') || isHlodKey(key); }
    /** P17 A/B: under the HLOD skyline (host.cheapBoost) the cheap class may use every worker, and a cheap backlog
     *  borrows two full-build slots (see fullCapFor). false = the plain 2-4 cheap slots. */
    static hlodBoost = true;
    get maxConcurrentCheap(): number {
        const n = this.host.workerCount?.() ?? 2;
        return CityStreamSource.hlodBoost && this.host.cheapBoost?.() ? Math.max(2, Math.min(8, n)) : Math.max(2, Math.min(4, n));
    }
    /** P17: a fly at rooftop height asks for ~40 new HLOD tiles a second (the skyline's leading edge + the far → mid
     *  swaps), while the full window's 2-4 s builds held all but 2 workers — and in a fast fly those full builds are
     *  cancelled before they land anyway. While more than 2 × the cheap cap of cheap keys wait, the full class keeps
     *  two fewer slots (never under 1), so the skyline keeps up; the slots return as soon as the backlog drains. */
    /** P20: an in-flight key counts against its class cap only while its worker builds (see CityStreamHost.holdsWorker). */
    holdsWorker(key: StreamKey): boolean { return this.host.holdsWorker?.(key) ?? true; }
    fullCapFor(cheapQueued: number): number {
        const base = this.maxConcurrentBuilds;
        if (!CityStreamSource.hlodBoost || !this.host.cheapBoost?.() || cheapQueued <= this.maxConcurrentCheap * 2) return base;
        if (this.host.landing?.()) return base;   // P22 landingSlots
        return Math.max(1, base - 2);
    }

    /** Same chunk across detail tiers: "tx,tz" and "tx,tz|p" are the SAME tile → reconcile holds the old tier's
     *  geometry visible until the replacement builds (no blink when a tile crosses the full/proxy boundary). */
    chunkId(key: StreamKey): string {
        const bar = key.indexOf('|');
        return bar >= 0 ? key.slice(0, bar) : key;
    }

    /** Preview-eligible = only the keys whose full build is genuinely heavier than the preview: full-3D tiles in a
     *  `tileDetail:'full'` world. Proxies (and flat worlds) skip the preview queue hop entirely. */
    canPreviewKey(key: StreamKey): boolean {
        if (key.endsWith('|p') || key.endsWith('|m') || isHlodKey(key)) return false;   // proxy / massing / HLOD — its build IS the cheap stand-in
        if (key.endsWith('|l') && !CityStreamSource.previewLite) return false;
        const p = this.host.tileParams();
        if (!p || p.tileDetail !== 'full') return false;
        return !this.host.hasRetired?.(key);                         // a cached build re-attaches at once — no stand-in
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
        const { tx, tz, proxy, massing, hlod } = parseKey(key);
        if (proxy || massing || hlod) return null;
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
        const { tx, tz, proxy, lite, massing, hlod } = parseKey(key);
        if (hlod) {
            // P17: the HLOD tiers are cheap worker builds like the flat / massing tiles (sync = a cache hit / no pool).
            const a = this.host.buildCheapTileAsync?.(p, tx, tz, false, key, hlod) ?? null;
            if (a) return a.then(g => { if (this.host.tileParams() !== p) { this.host.disposeTile(g); throw new Error('stale tile params'); } return g; });
            return this.host.buildTile(p, tx, tz, /*proxy*/ true, false, hlod);
        }
        if (massing || (proxy && p.tileDetail === 'full')) {
            // P10.D5: cheap tiles go to the worker pool too (an ~18 ms main-thread build per tile was the long-frame
            // source of a fast fly); null = the synchronous build (cache hit / no pool / switch off).
            const a = this.host.buildCheapTileAsync?.(p, tx, tz, massing, key) ?? null;
            if (a) return a.then(g => { if (this.host.tileParams() !== p) { this.host.disposeTile(g); throw new Error('stale tile params'); } return g; });
            if (massing) return this.host.buildTile(p, tx, tz, /*proxy*/ true, /*massing*/ true);   // P10.C1: cheap + sync
        }
        const bp = lite ? this._liteOf(p) : p;   // lite tier: same full 3D tile, minus the detailed-building load
        // A FULL 3D tile is the expensive build → offload generation to the Worker pool (async) when available.
        // Proxy / non-full tiles are cheap flat maps → build synchronously on the main thread.
        if (!proxy && p.tileDetail === 'full' && this.host.canUseWorkers()) {
            return this.host.buildTileAsync(bp, tx, tz, key).then(g => {
                // STALE-PARAMS GUARD: params changed while the worker built (seed/layout edit) → the result is
                // from the OLD world. Dispose + reject; the param change's own reconcile rebuilds with fresh params.
                if (this.host.tileParams() !== p) { this.host.disposeTile(g); throw new Error('stale tile params'); }
                return g;
            });
        }
        return this.host.buildTile(bp, tx, tz, proxy);
    }

    dispose(key: StreamKey, groups: MeshGroup3D[], preview?: boolean): void {
        // A PREVIEW handle is the flat proxy build (buildPreview) — retire it as what it is ("tx,tz|p"), never under
        // the full / lite key (P10: a dropped preview used to be cached as the full tile → that tile stayed flat).
        this.host.disposeTile(groups, preview && CityStreamSource.previewKeyFix ? `${this.chunkId(key)}|p` : key);
    }

    /** P17: a tier swap landed — the host may dissolve it (see CityStreamHost.crossFadeTile / StreamSource.crossFade). */
    crossFade(prevKey: StreamKey, prev: MeshGroup3D[], prevPreview: boolean, nextKey: StreamKey, next: MeshGroup3D[]): boolean {
        return this.host.crossFadeTile?.(prevKey, prev, prevPreview, nextKey, next) ?? false;
    }

    /** P10.B5: a full / lite tile that left the window mid-build — cancel its worker job (see StreamSource.cancel). */
    cancel(key: StreamKey): boolean { return this.host.cancelTileBuild?.(key) ?? false; }

    onProgress(): void { this.host.onSlice(); }
    onDrained(): void { this.host.onSettled(); }
}
