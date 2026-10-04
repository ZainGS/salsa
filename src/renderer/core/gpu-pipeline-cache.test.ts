import { describe, it, expect, afterEach, vi } from 'vitest';
import { GPUPipelineCache, PipelineSet, PIPELINE_PRIORITY } from './gpu-pipeline-cache';

// docs/specs/performance-plan.md P2 — the non-blocking pipeline cache, against a fake device whose async compiles
// resolve only when the test says so (so ordering / concurrency / mid-frame publication are deterministic).

type Deferred = { label: string; resolve: () => void; reject: (e: unknown) => void };

function fakeDevice(opts: { async?: boolean } = {}) {
  const calls = { sync: 0, async: 0, pending: [] as Deferred[] };
  let n = 0;
  const dev: Record<string, unknown> = {
    createRenderPipeline: (d: { label?: string }) => { calls.sync++; return { id: `s${++n}`, label: d.label }; },
    createComputePipeline: (d: { label?: string }) => { calls.sync++; return { id: `c${++n}`, label: d.label }; },
  };
  if (opts.async !== false) {
    const mkAsync = (d: { label?: string }) => new Promise((res, rej) => {
      calls.async++;
      calls.pending.push({ label: d.label ?? '', resolve: () => res({ id: `a${++n}`, label: d.label }), reject: rej });
    });
    dev.createRenderPipelineAsync = mkAsync;
    dev.createComputePipelineAsync = mkAsync;
  }
  return { dev: dev as unknown as GPUDevice, calls };
}
const desc = (label: string) => ({ label } as unknown as GPURenderPipelineDescriptor);
const flush = async (k = 4) => { for (let i = 0; i < k; i++) await new Promise((r) => setTimeout(r, 0)); };
const resolveAll = async (calls: { pending: Deferred[] }) => { const p = calls.pending.splice(0); for (const d of p) d.resolve(); await flush(); };

afterEach(() => { delete (globalThis as { __salsaPipelineMode?: string }).__salsaPipelineMode; });

describe('GPUPipelineCache', () => {
  it('outside a live frame get() compiles synchronously, once', () => {
    const { dev, calls } = fakeDevice();
    const h = GPUPipelineCache.for(dev).render(desc('A'));
    expect(calls.sync).toBe(0);                      // registration compiles nothing
    const p = h.get();
    expect(p).toBeTruthy();
    expect(h.get()).toBe(p);
    expect(calls.sync).toBe(1);
    expect(calls.async).toBe(0);
  });

  it('inside a live frame get() returns null, starts ONE async compile, and fires onPipelineReady when it lands', async () => {
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    const h = cache.render(desc('A'));
    let readyFired = 0;
    cache.onPipelineReady(() => readyFired++);
    cache.frame(() => {
      expect(h.get()).toBeNull();
      expect(h.get()).toBeNull();                    // a second request in the same frame doesn't recompile
    });
    expect(calls.sync).toBe(0);
    expect(calls.async).toBe(1);
    expect(cache.status()).toMatchObject({ pending: 1, total: 1, waitingDraws: 1, ready: false });
    await resolveAll(calls);
    expect(h.ready).toBe(true);
    expect(readyFired).toBe(1);
    expect(cache.status()).toMatchObject({ pending: 0, compiled: 1, ready: true });
    cache.frame(() => expect(h.get()).toBeTruthy());
  });

  it('a compile landing MID-frame is published only when the frame ends (one consistent ready-set per frame)', async () => {
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    const h = cache.render(desc('A'));
    cache.beginFrame();
    expect(h.get()).toBeNull();
    await resolveAll(calls);                         // lands while the (async) frame is still open
    expect(h.get()).toBeNull();                      // ...but this frame keeps seeing it as pending
    cache.endFrame();
    expect(h.ready).toBe(true);
  });

  it('warm-up drains in priority order with a concurrency cap; an on-demand request jumps the cap', async () => {
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    cache.maxConcurrentWarm = 2;
    const rare = cache.render(desc('rare')), c1 = cache.render(desc('c1')), c2 = cache.render(desc('c2')), doc = cache.render(desc('doc'));
    void rare.warm(PIPELINE_PRIORITY.RARE); void c1.warm(PIPELINE_PRIORITY.COMMON); void c2.warm(PIPELINE_PRIORITY.COMMON); void doc.warm(PIPELINE_PRIORITY.DOCUMENT);
    await flush();
    expect(calls.pending.map((d) => d.label)).toEqual(['doc', 'c1']);   // cap 2, highest priority first
    const urgent = cache.render(desc('urgent'));
    cache.frame(() => expect(urgent.get()).toBeNull());
    expect(calls.pending.map((d) => d.label)).toEqual(['doc', 'c1', 'urgent']);   // not held behind the cap
    await resolveAll(calls);
    expect(calls.pending.map((d) => d.label)).toEqual(['c2', 'rare']);
    await resolveAll(calls);
    expect(cache.status()).toMatchObject({ total: 5, compiled: 5, pending: 0, ready: true });
    expect(calls.sync).toBe(0);
  });

  it('a device without the async API falls back to synchronous compiles and warm() never hangs', async () => {
    const { dev, calls } = fakeDevice({ async: false });
    const cache = GPUPipelineCache.for(dev);
    const h = cache.render(desc('A'));
    expect(await h.warm(PIPELINE_PRIORITY.COMMON)).toBeNull();   // lazy — no blocking warm
    cache.frame(() => expect(h.get()).toBeTruthy());              // sync fallback even inside a frame
    expect(calls.sync).toBe(1);
    const n = cache.render(desc('B'));
    expect(await n.warm(PIPELINE_PRIORITY.NOW)).toBeTruthy();     // NOW = an async caller that needs it: compile
  });

  it('a failed compile is skipped forever (null), counted, and never retried synchronously', async () => {
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    const h = cache.render(desc('bad'));
    const err = console.error; console.error = () => {};
    try {
      cache.frame(() => h.get());
      calls.pending.splice(0)[0].reject(new Error('validation'));
      await flush();
    } finally { console.error = err; }
    expect(h.failed).toBe(true);
    expect(h.get()).toBeNull();
    expect(calls.sync).toBe(0);
    expect(cache.status()).toMatchObject({ failed: 1, pending: 0, ready: true });
  });

  // bug-hunt 2026-10-01 D-R4: failures used to be TERMINAL — one transient failure disabled that draw for the session.
  it('a failed pipeline is retried after a backoff, a bounded number of times', async () => {
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    const h = cache.render(desc('flaky'));
    let t = 1000;
    const now = performance.now; (performance as { now: () => number }).now = () => t;
    const err = console.error; console.error = () => {};
    try {
      cache.frame(() => h.get());
      calls.pending.splice(0)[0].reject(new Error('transient'));
      await flush();
      expect(h.failed).toBe(true);
      cache.frame(() => expect(h.get()).toBeNull());
      expect(calls.async).toBe(1);                   // inside the backoff: no retry yet
      t += 60_000;
      cache.frame(() => h.get());                    // past the backoff: ONE async retry
      expect(calls.async).toBe(2);
      expect(cache.status().failed).toBe(0);         // back to pending while it recompiles
      await resolveAll(calls);
      expect(h.ready).toBe(true);

      const bad = cache.render(desc('always-bad'));
      for (let i = 0; i < 6; i++) {
        t += 60_000;
        cache.frame(() => bad.get());
        for (const d of calls.pending.splice(0)) d.reject(new Error('validation'));
        await flush();
      }
      expect(calls.async).toBe(2 + 3);               // capped at 3 attempts
      expect(bad.failed).toBe(true);
      expect(cache.status().failed).toBe(1);
    } finally { console.error = err; (performance as { now: () => number }).now = now; }
  });

  // §P15 draw-bug 2026-10-04: the retry above only starts from a get() — a FRAME. An idle on-demand host renders no
  // frame by itself, so the waiting draw stayed missing until unrelated input. The backoff expiry now wakes the
  // ready listeners (the host schedules a frame), whose get() retries; the landed retry wakes them again.
  it('a waited draw whose pipeline failed transiently gets a frame requested when the retry backoff expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    const h = cache.render(desc('flaky-on-demand'));
    let t = 1000;
    const now = performance.now; (performance as { now: () => number }).now = () => t;
    const err = console.error; console.error = () => {};
    let frames = 0;
    // The host: every ready notification renders one live frame (exactly what WebGPURenderer.scheduleRender does).
    cache.onPipelineReady(() => { frames++; cache.frame(() => h.get()); });
    try {
      cache.frame(() => expect(h.get()).toBeNull());
      calls.pending.splice(0)[0].reject(new Error('transient'));
      await Promise.resolve(); await Promise.resolve();
      expect(h.failed).toBe(true);
      expect(frames).toBe(0);
      t += 1001;                                     // the backoff elapses with NO input / frame
      vi.advanceTimersByTime(1001);
      expect(frames).toBe(1);                        // woken: the host rendered a frame → its get() retried
      expect(calls.async).toBe(2);
      calls.pending.splice(0)[0].resolve();
      await Promise.resolve(); await Promise.resolve();
      expect(h.ready).toBe(true);
      expect(frames).toBe(2);                        // the landed retry asks for the frame that draws it
    } finally { console.error = err; (performance as { now: () => number }).now = now; vi.useRealTimers(); }
  });

  it('onStatus is coalesced and whenIdle resolves when the queue drains', async () => {
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    const seen: number[] = [];
    cache.onStatus((s) => seen.push(s.pending));
    const hs = [0, 1, 2].map((i) => cache.render(desc(`p${i}`)));
    hs.forEach((h) => void h.warm());
    await flush();
    let idle = false; void cache.whenIdle().then(() => { idle = true; });
    while (calls.pending.length) await resolveAll(calls);
    await flush();
    expect(idle).toBe(true);
    expect(seen[seen.length - 1]).toBe(0);
    expect(seen.length).toBeLessThan(8);             // coalesced, not one per internal state change
  });

  it('whenWaitedSettled resolves once every SKIPPED draw has compiled — capture re-render gate (bug-hunt 2026-10-01)', async () => {
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    const a = cache.render(desc('A')), b = cache.render(desc('B'));
    await cache.whenWaitedSettled();                 // nothing waited → immediate
    cache.frame(() => { expect(a.get()).toBeNull(); expect(b.get()).toBeNull(); });
    expect(cache.status().waitingDraws).toBe(2);
    let settled = false;
    void cache.whenWaitedSettled().then(() => { settled = true; });
    calls.pending.shift()!.resolve(); await flush();
    expect(settled).toBe(false);                     // one of the two skipped draws still compiling
    calls.pending.shift()!.reject(new Error('boom')); await flush();
    expect(settled).toBe(true);                      // compiled OR failed both settle it (a failure never hangs a capture)
    expect(cache.status().waitingDraws).toBe(0);
  });

  it('keyed registration dedupes a shared pipeline', () => {
    const { dev } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    expect(cache.render(desc('x'), 'X', 'shared')).toBe(cache.render(desc('x'), 'X', 'shared'));
  });

  it('PipelineSet.ready() is all-or-nothing', async () => {
    const { dev, calls } = fakeDevice();
    const set = new PipelineSet(dev, null);
    set.render(desc('a')); set.render(desc('b'));
    const cache = GPUPipelineCache.for(dev);
    cache.frame(() => expect(set.ready()).toBe(false));
    calls.pending.splice(0, 1)[0].resolve(); await flush();
    cache.frame(() => expect(set.ready()).toBe(false));
    await resolveAll(calls);
    cache.frame(() => expect(set.ready()).toBe(true));
  });

  it('legacy A/B mode (__salsaPipelineMode = sync) blocks on demand, like pre-P2', () => {
    (globalThis as { __salsaPipelineMode?: string }).__salsaPipelineMode = 'sync';
    const { dev, calls } = fakeDevice();
    const cache = GPUPipelineCache.for(dev);
    const h = cache.render(desc('A'));
    const log = console.log; console.log = () => {};
    try { cache.frame(() => expect(h.get()).toBeTruthy()); } finally { console.log = log; }
    expect(calls.sync).toBe(1);
  });
});
