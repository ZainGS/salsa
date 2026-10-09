import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { LAUNCH } from '../../renderer/shell/shell-launch';
import {
  ShellLaunchFlow, ShellLaunchError, launchErrorForProbe, LAUNCH_BLACK_SLACK_MS,
  type ShellLaunchPresenter, type ShellLaunchBeginOptions, type ShellLaunchFlowDeps,
} from './shell-launch-flow';

const cartBytes = (title = 'Night Market', author = 'Zain') =>
  zipSync({ 'manifest.json': strToU8(JSON.stringify({ version: '1.0', title, author })), 'scene.salsa': new Uint8Array([1, 2, 3]) });

class FakePresenter implements ShellLaunchPresenter {
  calls: string[] = [];
  opts: ShellLaunchBeginOptions | null = null;
  launchActive = false;
  beginLaunch(o: ShellLaunchBeginOptions): void { this.opts = o; this.launchActive = true; this.calls.push('begin'); }
  markLaunchReady(): void { this.calls.push('ready'); }
  skipLaunch(): void { this.calls.push('skip'); }
  cancelLaunch(): void { this.calls.push('cancel'); this.launchActive = false; }
  black(): void { this.launchActive = false; this.opts?.onBlack(); }
}

function setup(over: Partial<ShellLaunchFlowDeps> = {}) {
  const presenter = new FakePresenter();
  let bytes: Uint8Array | null = cartBytes();
  const loadCart = vi.fn(async () => bytes);
  const flow = new ShellLaunchFlow({ presenter: () => presenter, loadCart, now: () => Date.now(), ...over });
  return { flow, presenter, loadCart, setBytes: (b: Uint8Array | null) => { bytes = b; } };
}

/** Collect the outcome of a launch promise without an unhandled rejection. */
function track<T>(p: Promise<T>) {
  const out: { value?: T; error?: ShellLaunchError; settled: boolean } = { settled: false };
  p.then((v) => { out.value = v; out.settled = true; }, (e) => { out.error = e; out.settled = true; });
  return out;
}

const T0 = Date.UTC(2026, 9, 9, 12);   // (zipSync stamps entries: the clock must be a real date)
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

describe('ShellLaunchFlow — the happy path', () => {
  it('starts the animation at once, loads + probes, marks ready, and resolves with the cart on black', async () => {
    const { flow, presenter, loadCart } = setup();
    const out = track(flow.start('cart-1', { fadeColor: '#0a0a0a' }));
    expect(presenter.calls).toEqual(['begin']);           // synchronously, before the bytes are read
    expect(presenter.opts).toMatchObject({ slotId: 'cart-1', startMs: T0, reducedMotion: false, fadeColor: '#0a0a0a' });
    expect(flow.busy).toBe(true);
    expect(flow.slotId).toBe('cart-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(loadCart).toHaveBeenCalledWith('cart-1');
    expect(presenter.calls).toEqual(['begin', 'ready']);
    expect(out.settled).toBe(false);                       // not before the screen is black
    await vi.advanceTimersByTimeAsync(LAUNCH.minFadeStartMs + LAUNCH.fadeMs - 10);
    presenter.black();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value?.slotId).toBe('cart-1');
    expect(out.value?.title).toBe('Night Market');
    expect(out.value?.author).toBe('Zain');
    expect(out.value?.cart.type).toBe('application/zip');
    expect(new Uint8Array(await out.value!.cart.arrayBuffer())).toEqual(cartBytes());
    expect(flow.busy).toBe(false);
  });

  it('accepts ArrayBuffer and Blob from loadCart', async () => {
    for (const make of [(b: Uint8Array) => b.slice().buffer, (b: Uint8Array) => new Blob([b as unknown as BlobPart])]) {
      const presenter = new FakePresenter();
      const flow = new ShellLaunchFlow({ presenter: () => presenter, loadCart: async () => make(cartBytes()), now: () => Date.now() });
      const out = track(flow.start('c'));
      await vi.advanceTimersByTimeAsync(0);
      presenter.black();
      await vi.advanceTimersByTimeAsync(0);
      expect(out.value?.title).toBe('Night Market');
    }
  });

  it('a presenter that never reports black: the fallback timer resolves at the computed black moment (+ slack)', async () => {
    const { flow } = setup();
    const out = track(flow.start('c'));
    await vi.advanceTimersByTimeAsync(LAUNCH.minFadeStartMs + LAUNCH.fadeMs + LAUNCH_BLACK_SLACK_MS - 5);
    expect(out.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(out.value?.slotId).toBe('c');
  });

  it('black before the cart is ready cannot resolve it (the fade is gated on the bytes)', async () => {
    let release!: (b: Uint8Array) => void;
    const { flow, presenter } = setup({ loadCart: () => new Promise<Uint8Array>((r) => { release = r; }) });
    const out = track(flow.start('c'));
    presenter.black();
    await vi.advanceTimersByTimeAsync(3000);
    expect(out.settled).toBe(false);
    release(cartBytes());
    await vi.advanceTimersByTimeAsync(0);
    expect(presenter.calls).toEqual(['begin', 'ready']);
    // ready at 3 s → black at 3 s + fade: the fallback resolves it
    await vi.advanceTimersByTimeAsync(LAUNCH.fadeMs + LAUNCH_BLACK_SLACK_MS + 1);
    expect(out.value?.slotId).toBe('c');
  });

  it('no scene mounted (no presenter): resolves as soon as the cart is ready', async () => {
    const { flow } = setup({ presenter: () => null });
    const out = track(flow.start('c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value?.slotId).toBe('c');
  });

  it('a presenter whose beginLaunch throws still launches (no animation)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = new FakePresenter();
    bad.beginLaunch = () => { throw new Error('gpu'); };
    const flow = new ShellLaunchFlow({ presenter: () => bad, loadCart: async () => cartBytes(), now: () => Date.now() });
    const out = track(flow.start('c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value?.slotId).toBe('c');
    warn.mockRestore();
  });

  it('reduced motion is passed to the presenter and shortens the fallback to the quick fade', async () => {
    const { flow, presenter } = setup();
    const out = track(flow.start('c', { reducedMotion: true }));
    expect(presenter.opts?.reducedMotion).toBe(true);
    await vi.advanceTimersByTimeAsync(LAUNCH.reducedFadeMs + LAUNCH_BLACK_SLACK_MS + 1);
    expect(out.value?.slotId).toBe('c');
  });

  it('passes onFrame / onSettled through to the presenter', () => {
    const { flow, presenter } = setup();
    const onFrame = vi.fn(), onSettled = vi.fn();
    void flow.start('c', { onFrame, onSettled }).catch(() => {});
    expect(presenter.opts?.onFrame).toBe(onFrame);
    presenter.opts?.onSettled();
    expect(onSettled).toHaveBeenCalled();
  });
});

describe('ShellLaunchFlow — errors', () => {
  it('busy: a second launch while one runs is rejected; the first carries on', async () => {
    const { flow, presenter } = setup();
    const first = track(flow.start('a'));
    const second = track(flow.start('b'));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.error?.code).toBe('busy');
    expect(presenter.calls.filter((c) => c === 'begin')).toHaveLength(1);
    presenter.black();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.value?.slotId).toBe('a');
  });

  it('precheck rejects before anything starts', async () => {
    const { flow, presenter, loadCart } = setup({ precheck: (id) => (id === 'sys' ? 'not-installed' : null) });
    const out = track(flow.start('sys'));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.error?.code).toBe('not-installed');
    expect(presenter.calls).toEqual([]);
    expect(loadCart).not.toHaveBeenCalled();
    expect(flow.busy).toBe(false);
  });

  it('a missing file → read-failed, a throwing read → read-failed; both spin down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = setup(); a.setBytes(null);
    const outA = track(a.flow.start('c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outA.error?.code).toBe('read-failed');
    expect(a.presenter.calls).toEqual(['begin', 'cancel']);
    const b = setup({ loadCart: async () => { throw new Error('opfs'); } });
    const outB = track(b.flow.start('c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outB.error?.code).toBe('read-failed');
    expect(b.flow.busy).toBe(false);
    warn.mockRestore();
  });

  it('not a cart → invalid-cart; a newer cart → too-new', async () => {
    const a = setup(); a.setBytes(strToU8('nope'));
    const outA = track(a.flow.start('c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outA.error?.code).toBe('invalid-cart');
    const b = setup(); b.setBytes(zipSync({ 'manifest.json': strToU8('{"version":"9.0"}'), 'scene.salsa': new Uint8Array([1]) }));
    const outB = track(b.flow.start('c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outB.error?.code).toBe('too-new');
    expect(launchErrorForProbe({ ok: false, reason: 'missing-scene' })).toBe('invalid-cart');
  });

  it('timeout: a read that never finishes rejects after 10 s and spins down; a late read is ignored', async () => {
    let release!: (b: Uint8Array) => void;
    const { flow, presenter } = setup({ loadCart: () => new Promise<Uint8Array>((r) => { release = r; }) });
    const out = track(flow.start('c'));
    await vi.advanceTimersByTimeAsync(LAUNCH.timeoutMs - 1);
    expect(out.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(out.error?.code).toBe('timeout');
    expect(presenter.calls).toEqual(['begin', 'cancel']);
    release(cartBytes());
    await vi.advanceTimersByTimeAsync(0);
    expect(presenter.calls).toEqual(['begin', 'cancel']);   // no 'ready' after the failure
    expect(flow.busy).toBe(false);
  });

  it('a custom timeout', async () => {
    const { flow } = setup({ loadCart: () => new Promise<Uint8Array>(() => {}) });
    const out = track(flow.start('c', { timeoutMs: 500 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(out.error?.code).toBe('timeout');
  });

  it('once the cart is ready the timeout no longer applies (a slow fade is not a timeout)', async () => {
    const { flow } = setup();
    const out = track(flow.start('c', { timeoutMs: 600 }));
    await vi.advanceTimersByTimeAsync(LAUNCH.minFadeStartMs + LAUNCH.fadeMs + LAUNCH_BLACK_SLACK_MS + 1);
    expect(out.value?.slotId).toBe('c');
  });
});

describe('ShellLaunchFlow — skip / cancel / destroy', () => {
  it('skip: ignored right after the launching tap (double-click), then skips once; the fallback follows the short fade', async () => {
    const { flow, presenter } = setup();
    const out = track(flow.start('c'));
    await vi.advanceTimersByTimeAsync(LAUNCH.skipGuardMs - 50);
    expect(flow.skip()).toBe(false);
    expect(presenter.calls).not.toContain('skip');
    await vi.advanceTimersByTimeAsync(100);
    expect(flow.skip()).toBe(true);
    expect(flow.skip()).toBe(true);   // consumed (still launching) but not re-sent
    expect(presenter.calls.filter((c) => c === 'skip')).toHaveLength(1);
    // skipped at 400 ms with the cart ready → black at 400 + skipFade
    await vi.advanceTimersByTimeAsync(LAUNCH.skipFadeMs + LAUNCH_BLACK_SLACK_MS + 1);
    expect(out.value?.slotId).toBe('c');
    expect(flow.skip()).toBe(false);  // nothing launching
  });

  it('cancel (Esc): rejects cancelled, spins down, frees the flow', async () => {
    const { flow, presenter } = setup();
    const out = track(flow.start('c'));
    await vi.advanceTimersByTimeAsync(300);
    expect(flow.cancel()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(out.error).toBeInstanceOf(ShellLaunchError);
    expect(out.error?.code).toBe('cancelled');
    expect(presenter.calls).toEqual(['begin', 'ready', 'cancel']);
    expect(flow.busy).toBe(false);
    presenter.opts?.onBlack();   // a late black from the presenter changes nothing
    await vi.advanceTimersByTimeAsync(5000);
    expect(out.value).toBeUndefined();
    expect(flow.cancel()).toBe(false);
  });

  it('destroy: rejects unmounted without a spin-down (the scene is going away); a later read is ignored', async () => {
    let release!: (b: Uint8Array) => void;
    const { flow, presenter } = setup({ loadCart: () => new Promise<Uint8Array>((r) => { release = r; }) });
    const out = track(flow.start('c'));
    flow.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.error?.code).toBe('unmounted');
    expect(presenter.calls).toEqual(['begin']);
    release(cartBytes());
    await vi.advanceTimersByTimeAsync(LAUNCH.timeoutMs + 1000);
    expect(presenter.calls).toEqual(['begin']);
    flow.destroy();   // idempotent
  });

  it('after a failure a new launch can start', async () => {
    const { flow, presenter } = setup();
    const a = track(flow.start('a'));
    flow.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.error?.code).toBe('cancelled');
    const b = track(flow.start('b'));
    await vi.advanceTimersByTimeAsync(0);
    presenter.black();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.value?.slotId).toBe('b');
  });
});
