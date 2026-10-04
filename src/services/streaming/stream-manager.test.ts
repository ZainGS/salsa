import { describe, it, expect, beforeEach } from 'vitest';
import { StreamManager, hysteresisTile } from './stream-manager';
import type { Focus, StreamBudget, StreamKey, StreamSource } from './stream-manager';

// A fake source that records every build/dispose/callback so we can assert the manager's decisions. In the vitest
// node env there is no requestAnimationFrame, so the manager takes its synchronous "headless" pump path — the same
// one the world manager uses in offline/mock-scene builds. That path builds the whole queue at once and, matching
// the legacy tile pump, does NOT fire onProgress/onDrained.
class FakeSource implements StreamSource<{ key: StreamKey }> {
    target: StreamKey[] = [];
    readonly builds: StreamKey[] = [];
    readonly disposes: StreamKey[] = [];
    progress = 0;
    drained = 0;
    lastFocus: Focus | null = null;
    lastBudget: StreamBudget | null = null;

    targetChunks(focus: Focus, budget: StreamBudget): StreamKey[] {
        this.lastFocus = focus;
        this.lastBudget = budget;
        return this.target;
    }
    build(key: StreamKey): { key: StreamKey } {
        this.builds.push(key);
        return { key };
    }
    dispose(key: StreamKey, handle: { key: StreamKey }): void {
        expect(handle.key).toBe(key);   // the manager hands back exactly what build returned
        this.disposes.push(key);
    }
    onProgress(): void { this.progress++; }
    onDrained(): void { this.drained++; }
}

const FOCUS: Focus = { x: 0, z: 0, scale: 1 };
const BUDGET: StreamBudget = { loadRadius: 0, detailRadius: 0, unloadRadius: 0, maxLiveChunks: 64 };

describe('StreamManager (headless pump)', () => {
    let src: FakeSource;
    let mgr: StreamManager<{ key: StreamKey }>;
    beforeEach(() => {
        src = new FakeSource();
        mgr = new StreamManager(src);
    });

    it('builds every target chunk on a fresh reconcile, in the given (nearest-first) order', () => {
        mgr.reconcile(['0,1', '1,0', '1,1']);
        expect(src.builds).toEqual(['0,1', '1,0', '1,1']);
        expect(mgr.liveCount).toBe(3);
        expect(src.disposes).toEqual([]);
    });

    it('keeps overlapping chunks and only disposes the ones that fell out of range (no rebuild)', () => {
        mgr.reconcile(['0,1', '1,0', '1,1']);
        src.builds.length = 0;
        // Drop 1,1; keep 0,1 & 1,0; add a newcomer 2,0.
        mgr.reconcile(['0,1', '1,0', '2,0']);
        expect(src.disposes).toEqual(['1,1']);          // only the dropped one
        expect(src.builds).toEqual(['2,0']);            // only the newcomer — kept ones are NOT rebuilt
        expect(mgr.liveCount).toBe(3);
        expect(mgr.has('1,1')).toBe(false);
        expect(mgr.has('2,0')).toBe(true);
    });

    it('is idempotent — reconciling to the same target builds/disposes nothing', () => {
        mgr.reconcile(['0,1', '1,0']);
        src.builds.length = 0;
        mgr.reconcile(['0,1', '1,0']);
        expect(src.builds).toEqual([]);
        expect(src.disposes).toEqual([]);
        expect(mgr.liveCount).toBe(2);
    });

    it('reconciling to an empty target disposes everything', () => {
        mgr.reconcile(['0,1', '1,0']);
        mgr.reconcile([]);
        expect(src.disposes.sort()).toEqual(['0,1', '1,0']);
        expect(mgr.liveCount).toBe(0);
    });

    it('clear() disposes all live chunks and empties the cache', () => {
        mgr.reconcile(['0,1', '1,0']);
        mgr.clear();
        expect(src.disposes.sort()).toEqual(['0,1', '1,0']);
        expect(mgr.liveCount).toBe(0);
        expect(mgr.building).toBe(false);
    });

    it('sync() pulls the target from the source with the given focus/budget', () => {
        src.target = ['0,1'];
        mgr.sync(FOCUS, BUDGET);
        expect(src.lastFocus).toBe(FOCUS);
        expect(src.lastBudget).toBe(BUDGET);
        expect(src.builds).toEqual(['0,1']);
    });

    it('headless pump does not fire onProgress/onDrained (matches the legacy tile pump)', () => {
        mgr.reconcile(['0,1', '1,0']);
        expect(src.progress).toBe(0);
        expect(src.drained).toBe(0);
    });
});

// A source WITH buildPreview → exercises the proxy-first two-phase pump (preview pass, then full upgrade).
class TwoPhaseSource implements StreamSource<{ key: StreamKey; stage: string }> {
    target: StreamKey[] = [];
    readonly order: string[] = [];              // "P:key" for previews, "B:key" for full builds — in call order
    readonly disposed: Array<{ key: StreamKey; stage: string }> = [];
    readonly noPreview = new Set<StreamKey>();   // keys whose buildPreview returns null (no coarse stand-in)
    targetChunks(): StreamKey[] { return this.target; }
    buildPreview(key: StreamKey): { key: StreamKey; stage: string } | null {
        this.order.push(`P:${key}`);
        return this.noPreview.has(key) ? null : { key, stage: 'preview' };
    }
    build(key: StreamKey): { key: StreamKey; stage: string } { this.order.push(`B:${key}`); return { key, stage: 'full' }; }
    dispose(_key: StreamKey, handle: { key: StreamKey; stage: string }): void { this.disposed.push(handle); }
}

describe('StreamManager two-phase (proxy-first) build', () => {
    it('INTERLEAVES previews and full upgrades (neither pass starves the other), disposing each preview on swap', () => {
        // Previews-first-strictly would defer every full upgrade for as long as a pan keeps refilling the preview
        // queue — the world would stay flat until the user stops. The pump alternates once both queues have work:
        // P:a fills the full queue, then previews and fulls take turns.
        const src = new TwoPhaseSource(); src.target = ['a', 'b', 'c'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(src.order).toEqual(['P:a', 'P:b', 'B:a', 'P:c', 'B:b', 'B:c']);   // alternating, nearest-first within each pass
        expect(src.disposed.map(h => h.stage)).toEqual(['preview', 'preview', 'preview']);   // each preview swapped out
        expect(mgr.liveCount).toBe(3);
    });

    it('a chunk becomes live at the preview stage before its full build', () => {
        // Drive one preview manually via reconcile ordering is awkward in headless (it drains fully), so assert the
        // end state: everything ends live + full, previews all disposed.
        const src = new TwoPhaseSource(); src.target = ['a'];
        const mgr = new StreamManager(src);
        mgr.reconcile(['a']);
        expect(mgr.has('a')).toBe(true);
        expect(src.order).toEqual(['P:a', 'B:a']);
    });

    it('buildPreview returning null skips the preview but still full-builds (no preview to dispose)', () => {
        const src = new TwoPhaseSource(); src.target = ['a']; src.noPreview.add('a');
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(src.order).toEqual(['P:a', 'B:a']);
        expect(src.disposed).toEqual([]);        // nothing was live at preview stage → nothing to dispose
        expect(mgr.liveCount).toBe(1);
    });

    it('does not rebuild chunks already at full detail on a repeat sync', () => {
        const src = new TwoPhaseSource(); src.target = ['a', 'b'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        src.order.length = 0;
        mgr.sync(FOCUS, BUDGET);                 // same target, all full already
        expect(src.order).toEqual([]);
    });

    it('disposing an out-of-range chunk frees its current (full) handle', () => {
        const src = new TwoPhaseSource(); src.target = ['a', 'b'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        src.disposed.length = 0;
        src.target = ['a'];
        mgr.sync(FOCUS, BUDGET);
        expect(src.disposed.map(h => h.stage)).toEqual(['full']);   // 'b' dropped at full stage
        expect(mgr.has('b')).toBe(false);
    });
});

// A source whose full build is ASYNC (Promise) — models the Worker pool. buildPreview returns null so the tests
// focus on the async full path. In vitest (no rAF) the pump dispatches all builds synchronously; the promises
// resolve when the test awaits a macrotask.
class AsyncSource implements StreamSource<{ key: StreamKey }> {
    target: StreamKey[] = [];
    readonly built: StreamKey[] = [];
    readonly disposed: Array<{ key: StreamKey }> = [];
    targetChunks(): StreamKey[] { return this.target; }
    buildPreview(): { key: StreamKey } | null { return null; }
    build(key: StreamKey): Promise<{ key: StreamKey }> { this.built.push(key); return Promise.resolve({ key }); }
    dispose(_key: StreamKey, handle: { key: StreamKey }): void { this.disposed.push(handle); }
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('StreamManager async (worker-style) build', () => {
    it('dispatches async builds and marks them full once resolved', async () => {
        const src = new AsyncSource(); src.target = ['a', 'b'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(src.built.slice().sort()).toEqual(['a', 'b']);   // dispatched
        expect(mgr.liveCount).toBe(0);                          // not live yet (still building)
        await flush();
        expect(mgr.has('a') && mgr.has('b')).toBe(true);
        expect(mgr.liveCount).toBe(2);
    });

    it('discards an async result whose chunk left the window mid-build', async () => {
        const src = new AsyncSource(); src.target = ['a', 'b'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);                 // dispatch a, b
        src.target = ['a']; mgr.sync(FOCUS, BUDGET);   // b leaves before it resolves
        await flush();
        expect(mgr.has('a')).toBe(true);
        expect(mgr.has('b')).toBe(false);
        expect(src.disposed.map(h => h.key)).toEqual(['b']);   // b's arrived handle discarded, not shown
    });

    it('does not re-dispatch a key whose async build is still in flight', async () => {
        const src = new AsyncSource(); src.target = ['a'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        mgr.sync(FOCUS, BUDGET);                 // second sync while 'a' is in flight
        expect(src.built).toEqual(['a']);        // built once, not twice
        await flush();
        expect(mgr.liveCount).toBe(1);
    });

    it('clear() disposes async results that resolve after the clear', async () => {
        const src = new AsyncSource(); src.target = ['a'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        mgr.clear();
        await flush();
        expect(mgr.liveCount).toBe(0);
        expect(src.disposed.map(h => h.key)).toEqual(['a']);   // the late arrival is disposed, not leaked
    });
});

// bug-hunt 2026-10-01 D-W4: a clear() + rebuild of the same key while the OLD generation's build is still in flight —
// the old result used to delete the NEW in-flight entry (duplicate dispatch) and go live as the new chunk.
class ManualSource implements StreamSource<{ key: StreamKey; gen: number }> {
    target: StreamKey[] = [];
    gen = 0;
    readonly pending: Array<{ key: StreamKey; gen: number; resolve: (h: { key: StreamKey; gen: number }) => void; reject: (e: Error) => void }> = [];
    readonly disposed: Array<{ key: StreamKey; gen: number }> = [];
    targetChunks(): StreamKey[] { return this.target; }
    buildPreview(): null { return null; }
    build(key: StreamKey): Promise<{ key: StreamKey; gen: number }> {
        const gen = this.gen;
        return new Promise((resolve, reject) => this.pending.push({ key, gen, resolve, reject }));
    }
    dispose(_key: StreamKey, handle: { key: StreamKey; gen: number }): void { this.disposed.push(handle); }
}
describe('StreamManager in-flight generations', () => {
    it('an old generation resolving after clear + rebuild neither goes live nor frees the new in-flight slot', async () => {
        const src = new ManualSource(); src.target = ['a'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);                       // gen 0 dispatch
        mgr.clear();
        src.gen = 1; mgr.sync(FOCUS, BUDGET);          // gen 1 dispatch of the same key
        expect(src.pending.map(p => p.gen)).toEqual([0, 1]);
        src.pending[0].resolve({ key: 'a', gen: 0 });  // the stale result lands first
        await flush();
        expect(mgr.has('a')).toBe(false);              // not shown as the new chunk
        expect(src.disposed).toEqual([{ key: 'a', gen: 0 }]);
        mgr.sync(FOCUS, BUDGET);                       // must NOT re-dispatch: gen 1 is still in flight
        expect(src.pending.length).toBe(2);
        src.pending[1].resolve({ key: 'a', gen: 1 });
        await flush();
        expect(mgr.has('a')).toBe(true);
    });

    it('an old generation REJECTING after clear + rebuild keeps the new in-flight slot', async () => {
        const src = new ManualSource(); src.target = ['a'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        mgr.clear();
        src.gen = 1; mgr.sync(FOCUS, BUDGET);
        src.pending[0].reject(new Error('cancelled'));
        await flush();
        mgr.sync(FOCUS, BUDGET);
        expect(src.pending.length).toBe(2);           // no duplicate dispatch
    });
});

describe('StreamManager tier-flip hold (chunkId)', () => {
    // A source whose chunk identity strips a "|p" tier suffix — models the city's proxy↔full key flip.
    class TierSource implements StreamSource<{ key: StreamKey }> {
        target: StreamKey[] = [];
        readonly events: string[] = [];   // "B:key" / "D:key" in call order — proves dispose comes AFTER the rebuild
        targetChunks(): StreamKey[] { return this.target; }
        chunkId(key: StreamKey): string { const b = key.indexOf('|'); return b >= 0 ? key.slice(0, b) : key; }
        build(key: StreamKey): { key: StreamKey } { this.events.push(`B:${key}`); return { key }; }
        dispose(key: StreamKey, _h: { key: StreamKey }): void { this.events.push(`D:${key}`); }
    }

    it('holds the old tier\'s handle until the replacement builds, then swap-disposes (no hole)', () => {
        const src = new TierSource(); src.target = ['a'];
        const mgr = new StreamManager(src);
        mgr.reconcile(['a']);
        src.events.length = 0;
        mgr.reconcile(['a|p']);   // full → proxy flip: same chunk, new key
        expect(src.events).toEqual(['B:a|p', 'D:a']);   // rebuild FIRST, old handle disposed after — never a gap
        expect(mgr.has('a|p')).toBe(true);
        expect(mgr.has('a')).toBe(false);
    });

    it('disposes a held handle whose replacement key left the target before building', () => {
        const src = new TierSource(); src.target = ['a'];
        const mgr = new StreamManager(src);
        mgr.reconcile(['a']);
        src.events.length = 0;
        // Flip to proxy and away again in back-to-back reconciles: the hold must not leak the old handle.
        mgr.reconcile(['b']);     // 'a' has no replacement in this target → plain dispose
        expect(src.events).toEqual(['D:a', 'B:b']);
    });
});

describe('StreamManager P17: a tier swap the source dissolves (crossFade)', () => {
    class FadeSource implements StreamSource<{ key: StreamKey }> {
        target: StreamKey[] = [];
        readonly events: string[] = [];
        readonly handed: Array<{ prev: StreamKey; next: StreamKey; nextHandle: StreamKey }> = [];
        take = true;   // the source takes over the old handle's disposal
        targetChunks(): StreamKey[] { return this.target; }
        chunkId(key: StreamKey): string { const b = key.indexOf('|'); return b >= 0 ? key.slice(0, b) : key; }
        build(key: StreamKey): { key: StreamKey } { this.events.push(`B:${key}`); return { key }; }
        dispose(key: StreamKey): void { this.events.push(`D:${key}`); }
        crossFade(prevKey: StreamKey, _prev: { key: StreamKey }, _pp: boolean, nextKey: StreamKey, next: { key: StreamKey }): boolean {
            this.handed.push({ prev: prevKey, next: nextKey, nextHandle: next.key });
            return this.take;
        }
    }

    it('hands the held old tier + the landed new one to the source, which then owns the old handle', () => {
        const src = new FadeSource();
        const mgr = new StreamManager(src);
        mgr.reconcile(['a|h']);
        src.events.length = 0;
        mgr.reconcile(['a|f']);   // mid → far HLOD swap
        expect(src.events).toEqual(['B:a|f']);   // the old tier is NOT disposed by the manager
        expect(src.handed).toEqual([{ prev: 'a|h', next: 'a|f', nextHandle: 'a|f' }]);
        expect(mgr.has('a|f')).toBe(true);
        expect(mgr.has('a|h')).toBe(false);
        mgr.clear();
        expect(src.events).toEqual(['B:a|f', 'D:a|f']);   // clear never disposes a handle it gave away
    });

    it('a source that declines (false) gets the old handle disposed at once; the A/B switch skips the hook', () => {
        const src = new FadeSource(); src.take = false;
        const mgr = new StreamManager(src);
        mgr.reconcile(['a']);
        src.events.length = 0;
        mgr.reconcile(['a|h']);
        expect(src.events).toEqual(['B:a|h', 'D:a']);
        src.take = true; src.handed.length = 0; src.events.length = 0;
        StreamManager.crossFade = false;
        try { mgr.reconcile(['a|f']); } finally { StreamManager.crossFade = true; }
        expect(src.handed).toEqual([]);
        expect(src.events).toEqual(['B:a|f', 'D:a|h']);
    });
});

describe('StreamManager per-key preview routing + build-error tolerance', () => {
    it('canPreviewKey=false keys skip the preview pass entirely (straight to full)', () => {
        const src = new TwoPhaseSource(); src.target = ['a', 'b|p'];
        (src as StreamSource<unknown>).canPreviewKey = (key: StreamKey) => key.indexOf('|') < 0;
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(src.order.filter(e => e.startsWith('P:'))).toEqual(['P:a']);   // no P:b|p — never entered the preview queue
        expect(mgr.liveCount).toBe(2);
    });

    it('a build() that throws leaves the chunk unbuilt without killing the pump (retried on next reconcile)', () => {
        const src = new TwoPhaseSource(); src.target = ['a', 'b'];
        let failB = true;
        const origBuild = src.build.bind(src);
        src.build = (key: StreamKey) => { if (key === 'b' && failB) throw new Error('no params yet'); return origBuild(key); };
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(mgr.has('a')).toBe(true);          // 'a' unaffected by 'b' throwing
        failB = false;
        mgr.sync(FOCUS, BUDGET);                  // params "arrived" → retry succeeds
        expect(mgr.has('b')).toBe(true);
    });
});

describe('StreamManager async in-flight cap (maxConcurrentBuilds)', () => {
    class CappedSource implements StreamSource<{ key: StreamKey }> {
        target: StreamKey[] = [];
        readonly maxConcurrentBuilds = 2;
        readonly dispatched: StreamKey[] = [];
        readonly resolvers = new Map<StreamKey, (h: { key: StreamKey }) => void>();
        targetChunks(): StreamKey[] { return this.target; }
        build(key: StreamKey): Promise<{ key: StreamKey }> {
            this.dispatched.push(key);
            return new Promise(res => this.resolvers.set(key, res));
        }
        dispose(): void { /* not exercised */ }
    }

    it('never dispatches more than the cap; queued keys dispatch as in-flight builds settle', async () => {
        const src = new CappedSource(); src.target = ['a', 'b', 'c', 'd'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(src.dispatched).toEqual(['a', 'b']);          // capped at 2 — c/d wait ON the manager, not the pool
        src.resolvers.get('a')!({ key: 'a' });
        await flush();
        expect(src.dispatched).toEqual(['a', 'b', 'c']);     // one settled → one more dispatched (nearest-first)
        src.resolvers.get('b')!({ key: 'b' });
        src.resolvers.get('c')!({ key: 'c' });
        await flush();
        expect(src.dispatched).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('StreamManager P10: stale-build cancellation + preview-aware dispose', () => {
    class CancelSource implements StreamSource<{ key: StreamKey; preview?: boolean }> {
        target: StreamKey[] = [];
        readonly maxConcurrentBuilds = 2;
        cancelOk = true;
        readonly dispatched: StreamKey[] = [];
        readonly cancelled: StreamKey[] = [];
        readonly disposed: Array<[StreamKey, boolean]> = [];
        readonly resolvers = new Map<StreamKey, (h: { key: StreamKey }) => void>();
        targetChunks(): StreamKey[] { return this.target; }
        buildPreview(key: StreamKey): { key: StreamKey; preview: boolean } { return { key, preview: true }; }
        build(key: StreamKey): Promise<{ key: StreamKey }> {
            this.dispatched.push(key);
            return new Promise(res => this.resolvers.set(key, res));
        }
        cancel(key: StreamKey): boolean { this.cancelled.push(key); return this.cancelOk; }
        dispose(key: StreamKey, h: { key: StreamKey; preview?: boolean }, preview?: boolean): void {
            expect(!!preview).toBe(!!h.preview);   // the manager says exactly which handles are preview stand-ins
            this.disposed.push([key, !!preview]);
        }
    }

    it('a chunk that leaves the target mid-build is cancelled and its slot freed at once', async () => {
        const src = new CancelSource(); src.target = ['a', 'b', 'c', 'd'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(src.dispatched).toEqual(['a', 'b']);              // capped
        src.target = ['c', 'd'];                                 // a + b scrolled out while building
        mgr.sync(FOCUS, BUDGET);
        expect(src.cancelled.sort()).toEqual(['a', 'b']);
        expect(src.dispatched).toEqual(['a', 'b', 'c', 'd']);    // the freed slots went to the wanted chunks NOW
        // the stale results still resolve later: discarded (disposed as full builds), never live
        src.resolvers.get('a')!({ key: 'a' });
        await flush();
        expect(mgr.has('a')).toBe(false);
        expect(src.disposed).toContainEqual(['a', false]);
    });

    it('without a successful cancel the slot stays held (the legacy behaviour)', () => {
        const src = new CancelSource(); src.cancelOk = false; src.target = ['a', 'b', 'c'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        src.target = ['c'];
        mgr.sync(FOCUS, BUDGET);
        expect(src.dispatched).toEqual(['a', 'b']);              // c waits until a / b settle
    });

    it('preview handles are disposed with preview = true (upgrade swap and scroll-out)', async () => {
        const src = new CancelSource(); src.target = ['a', 'b'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);                                  // previews of a + b live, fulls in flight
        src.resolvers.get('a')!({ key: 'a' });
        await flush();
        expect(src.disposed).toContainEqual(['a', true]);         // a's preview swapped out for its full build
        src.target = [];
        mgr.sync(FOCUS, BUDGET);
        expect(src.disposed).toContainEqual(['b', true]);         // b left while still a preview
        expect(src.disposed).toContainEqual(['a', false]);        // a left as a full build
    });
});

describe('hysteresisTile (Phase 2 focus deadband)', () => {
    it('stays on the current tile within the deadband, snaps once past 0.5 + margin', () => {
        // On tile 0, margin 0.15 → deadband is |pos| ≤ 0.65.
        expect(hysteresisTile(0.0, 0)).toBe(0);
        expect(hysteresisTile(0.6, 0)).toBe(0);     // inside band → stay
        expect(hysteresisTile(-0.6, 0)).toBe(0);
        expect(hysteresisTile(0.7, 0)).toBe(1);     // past band → snap to nearest
        expect(hysteresisTile(-0.7, 0)).toBe(-1);
    });

    it('does not flicker when hovering exactly on a boundary (no hysteresis would toggle here)', () => {
        // A focus parked at x = 0.5 tiles: a plain round() would flip-flop; the deadband holds whichever tile owns it.
        expect(hysteresisTile(0.5, 0)).toBe(0);     // still on 0
        expect(hysteresisTile(0.5, 1)).toBe(1);     // still on 1 — both stable, no toggle
    });

    it('snaps directly across multiple tiles on a big jump', () => {
        expect(hysteresisTile(3.2, 0)).toBe(3);
    });
});

describe('StreamManager P10.D6: a cheap concurrency class is never starved by capped full builds', () => {
    class ClassSource implements StreamSource<{ key: StreamKey }> {
        target: StreamKey[] = [];
        readonly maxConcurrentBuilds = 2;
        readonly maxConcurrentCheap = 1;
        readonly dispatched: StreamKey[] = [];
        readonly resolvers = new Map<StreamKey, (h: { key: StreamKey }) => void>();
        isCheapKey(key: StreamKey): boolean { return key.endsWith('|p'); }
        targetChunks(): StreamKey[] { return this.target; }
        build(key: StreamKey): Promise<{ key: StreamKey }> { this.dispatched.push(key); return new Promise(res => this.resolvers.set(key, res)); }
        dispose(): void { /* not exercised */ }
    }
    it('dispatches cheap keys past a full queue that is at its cap, each class within its own cap', async () => {
        const src = new ClassSource(); src.target = ['a', 'b', 'c', 'x|p', 'y|p'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(src.dispatched).toEqual(['a', 'b', 'x|p']);   // 2 full (cap) + 1 cheap (its cap); 'c' and 'y|p' wait
        src.resolvers.get('x|p')!({ key: 'x|p' });
        await flush();
        expect(src.dispatched).toEqual(['a', 'b', 'x|p', 'y|p']);   // the cheap slot freed → the next cheap key, fulls still capped
        src.resolvers.get('a')!({ key: 'a' });
        await flush();
        expect(src.dispatched).toEqual(['a', 'b', 'x|p', 'y|p', 'c']);
    });
});

describe('StreamManager P17: a cheap backlog borrows full-build slots (fullCapFor)', () => {
    class BorrowSource implements StreamSource<{ key: StreamKey }> {
        target: StreamKey[] = [];
        readonly maxConcurrentBuilds = 3;
        readonly maxConcurrentCheap = 2;
        readonly dispatched: StreamKey[] = [];
        readonly seenQueued: number[] = [];
        readonly resolvers = new Map<StreamKey, (h: { key: StreamKey }) => void>();
        isCheapKey(key: StreamKey): boolean { return key.endsWith('|h'); }
        fullCapFor(cheapQueued: number): number { this.seenQueued.push(cheapQueued); return cheapQueued > 2 ? 1 : this.maxConcurrentBuilds; }
        targetChunks(): StreamKey[] { return this.target; }
        build(key: StreamKey): Promise<{ key: StreamKey }> { this.dispatched.push(key); return new Promise(res => this.resolvers.set(key, res)); }
        dispose(): void { /* not exercised */ }
    }
    it('with many cheap keys waiting the full class keeps one slot; once they drain it gets its cap back', async () => {
        const src = new BorrowSource(); src.target = ['a', 'b', 'c', '1|h', '2|h', '3|h', '4|h', '5|h'];
        const mgr = new StreamManager(src);
        mgr.sync(FOCUS, BUDGET);
        expect(src.dispatched.filter(k => !k.endsWith('|h'))).toEqual(['a']);          // backlog of 5 cheap keys → full cap 1
        expect(src.dispatched.filter(k => k.endsWith('|h')).length).toBe(2);           // the cheap class at its own cap
        expect(Math.max(...src.seenQueued)).toBe(5);
        for (const k of ['1|h', '2|h']) src.resolvers.get(k)!({ key: k });
        await flush();
        for (const k of ['3|h', '4|h']) src.resolvers.get(k)!({ key: k });
        await flush();
        src.resolvers.get('5|h')!({ key: '5|h' });
        await flush();
        // the backlog is gone (≤ 2 queued) → the other full keys dispatch
        expect(src.dispatched.filter(k => !k.endsWith('|h'))).toEqual(['a', 'b', 'c']);
    });
});

describe('StreamManager P20: a build past its worker phase frees its slot (holdsWorker)', () => {
    class PhaseSource implements StreamSource<{ key: StreamKey }> {
        target: StreamKey[] = [];
        readonly maxConcurrentBuilds = 2;
        readonly dispatched: StreamKey[] = [];
        readonly reassembling = new Set<StreamKey>();
        readonly resolvers = new Map<StreamKey, (h: { key: StreamKey }) => void>();
        useHolds = true;
        targetChunks(): StreamKey[] { return this.target; }
        holdsWorker(key: StreamKey): boolean { return !this.useHolds || !this.reassembling.has(key); }
        build(key: StreamKey): Promise<{ key: StreamKey }> { this.dispatched.push(key); return new Promise(res => this.resolvers.set(key, res)); }
        dispose(): void { /* not exercised */ }
    }
    it('the next key dispatches once a build reassembles; never more worker-phase builds than the cap', async () => {
        for (const useHolds of [true, false]) {
            const src = new PhaseSource(); src.useHolds = useHolds; src.target = ['a', 'b', 'c', 'd'];
            const mgr = new StreamManager(src);
            mgr.sync(FOCUS, BUDGET);
            expect(src.dispatched).toEqual(['a', 'b']);
            src.reassembling.add('a');                // a's worker is done; its result reassembles on the main thread
            mgr.sync(FOCUS, BUDGET);
            expect(src.dispatched).toEqual(useHolds ? ['a', 'b', 'c'] : ['a', 'b']);   // the A/B: off = the slot is held
            const inWorker = src.dispatched.filter(k => !src.reassembling.has(k) && src.resolvers.has(k)).length;
            expect(inWorker).toBeLessThanOrEqual(2);
            src.resolvers.get('a')!({ key: 'a' });
            await flush();
            // with the hook b + c are in their worker phase (the cap) so d waits; without it c took a's freed slot
            expect(src.dispatched).toEqual(['a', 'b', 'c']);
            src.reassembling.add('b');
            mgr.sync(FOCUS, BUDGET);
            expect(src.dispatched).toEqual(useHolds ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c']);
        }
    });
});

describe('StreamManager P10.D7: a held old-tier handle is the stand-in (no preview rebuild)', () => {
    class HeldSource implements StreamSource<{ key: StreamKey }> {
        target: StreamKey[] = [];
        readonly events: string[] = [];
        readonly resolvers = new Map<StreamKey, (h: { key: StreamKey }) => void>();
        targetChunks(): StreamKey[] { return this.target; }
        chunkId(key: StreamKey): string { const b = key.indexOf('|'); return b >= 0 ? key.slice(0, b) : key; }
        canPreviewKey(key: StreamKey): boolean { return !key.includes('|'); }
        buildPreview(key: StreamKey): { key: StreamKey } { this.events.push(`P:${key}`); return { key }; }
        build(key: StreamKey): { key: StreamKey } | Promise<{ key: StreamKey }> {
            this.events.push(`B:${key}`);
            if (key.includes('|')) return { key };
            return new Promise(res => this.resolvers.set(key, res));
        }
        dispose(key: StreamKey): void { this.events.push(`D:${key}`); }
    }
    it('a flat tile promoted to full stays on screen until the full build lands; no preview is built', async () => {
        const src = new HeldSource();
        const mgr = new StreamManager(src);
        mgr.reconcile(['a|p']);
        src.events.length = 0;
        mgr.reconcile(['a']);                      // the moving window promotes the flat tile
        expect(src.events).toEqual(['B:a']);       // straight to the full build — the held 'a|p' is the stand-in
        src.resolvers.get('a')!({ key: 'a' });
        await flush();
        expect(src.events).toEqual(['B:a', 'D:a|p']);   // swap-disposed when the full build landed
        // a chunk that was NOT live still gets its preview
        src.events.length = 0;
        mgr.reconcile(['a', 'b']);
        expect(src.events.slice(0, 2)).toEqual(['P:b', 'B:b']);
    });
    it('the A/B switch restores the old preview-on-flip behaviour', () => {
        StreamManager.heldAsPreview = false;
        try {
            const src = new HeldSource();
            const mgr = new StreamManager(src);
            mgr.reconcile(['a|p']);
            src.events.length = 0;
            mgr.reconcile(['a']);
            expect(src.events).toEqual(['P:a', 'D:a|p', 'B:a']);
        } finally { StreamManager.heldAsPreview = true; }
    });
});
