/**
 * ShellUIManager's cart launch wiring (docs/specs/frogcart-cd-art-and-launch.md Part A): launchSlot → the cart, the
 * prechecks, the renderer as the launch presenter, the input lock,
 * single-tap launch + the double-click guard, the cart sheet (onSlotMenu), and destroyScene rejecting a pending launch.
 * The manager runs against fakes: no GPU, no OPFS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { ShellUIManager, ShellLaunchError, type ShellActivateEvent, type ShellSlotMenuEvent } from './shell-ui-manager';
import { LAUNCH, type ShellLaunchBeginOptions } from '../../renderer/shell/shell-launch';
import type { ManagerContext } from './manager-context';

const cart = () => zipSync({ 'manifest.json': strToU8(JSON.stringify({ version: '1.0', title: 'Night Market', author: 'Zain' })), 'scene.salsa': new Uint8Array([1, 2, 3]) });

type Internals = {
  registry: { version: 2; slots: unknown[] };
  storage: { readLocalCart: (id: string) => Promise<ArrayBuffer | null>; readCachedCart: (id: string) => Promise<ArrayBuffer | null> };
  renderer: unknown;
  sceneCanvas: unknown;
  clusterEl: unknown;
  handleClick(id: string): void;
  rebuildAndRender: ReturnType<typeof vi.fn>;
  buildViewerSpec(): { kind: string };
  viewerCartId(): string | null;
  view: { hoveredSlotId: string | null; selectedSlotId: string | null; mode: string };
  currentModel: { tiles: { id: string; cd?: boolean }[] };
  emitSlotMenu(id: string, x: number, y: number, s: 'long-press' | 'context-menu'): void;
  _tapActivated: { id: string; at: number } | null;
  detachInteraction(): void;
};

function manager(slots: unknown[] = [{ id: 'c1', type: 'local', name: 'Cart', order: 3, opfsPath: '/carts/c1.frogcart' }]) {
  const ctx = { webgpuRenderer: { resumeRendering: vi.fn(), play: vi.fn(), getDevice: () => null } } as unknown as ManagerContext;
  const m = new ShellUIManager(ctx);
  const mi = m as unknown as Internals;
  mi.registry = { version: 2, slots };
  const reads: string[] = [];
  mi.storage = {
    readLocalCart: async (id) => { reads.push('local:' + id); return cart().slice().buffer; },
    readCachedCart: async (id) => { reads.push('cache:' + id); return cart().slice().buffer; },
  };
  return { m, mi, reads };
}

/** Mount a fake scene: a renderer (optionally a presenter itself), a canvas, the cluster element. */
function mount(mi: Internals, renderer: Record<string, unknown> = {}) {
  mi.renderer = Object.assign(renderer, { stop: vi.fn(), destroy: vi.fn(), cancelModeFade: vi.fn(), setPointer: vi.fn() });   // same object: a presenter's state stays live
  mi.sceneCanvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    removeEventListener: vi.fn(), width: 800, height: 600,
  };
  const cluster = { style: {} as Record<string, string>, attrs: {} as Record<string, string>, remove: vi.fn(),
    setAttribute(k: string, v: string) { this.attrs[k] = v; }, removeAttribute(k: string) { delete this.attrs[k]; } };
  mi.clusterEl = cluster;
  // the model rebuild needs a real canvas + renderer: record it instead (what the viewer would show is read below)
  (mi as unknown as { rebuildAndRender: () => void }).rebuildAndRender = vi.fn();
  return cluster;
}

const T0 = Date.UTC(2026, 9, 9, 12);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  vi.setSystemTime(T0);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({}) } });   // ShellStorage.isAvailable()
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('ShellUIManager.launchSlot', () => {
  it('advertises launch support (the old stub was a function too)', () => {
    const { m } = manager();
    expect(m.launchSupported).toBe(true);
    expect(m.isLaunching).toBe(false);
  });

  it('with no scene mounted: reads the installed cart, checks it and resolves with it', async () => {
    const { m, reads } = manager();
    const r = await m.launchSlot('c1');
    expect(reads).toEqual(['local:c1']);
    expect(r.slotId).toBe('c1');
    expect(r.title).toBe('Night Market');
    expect(r.author).toBe('Zain');
    expect(new Uint8Array(await r.cart.arrayBuffer())).toEqual(cart());
  });

  it('a remote cart reads its cached copy; one with no cached copy is not installed', async () => {
    const { m, reads } = manager([
      { id: 'r1', type: 'remote', name: 'R', order: 3, cachedOpfsPath: '/carts/cache/r1.frogcart' },
      { id: 'r2', type: 'remote', name: 'R2', order: 4 },
    ]);
    await m.launchSlot('r1');
    expect(reads).toEqual(['cache:r1']);
    await expect(m.launchSlot('r2')).rejects.toMatchObject({ code: 'not-installed' });
    // … unless the host loads it itself
    const own = await m.launchSlot('r2', { loadCart: async () => cart() });
    expect(own.slotId).toBe('r2');
  });

  it('unknown slot → not-found; a system app → not-installed; both are ShellLaunchErrors', async () => {
    const { m } = manager();
    const e = await m.launchSlot('nope').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ShellLaunchError);
    expect((e as ShellLaunchError).code).toBe('not-found');
    await expect(m.launchSlot('system:settings')).rejects.toMatchObject({ code: 'not-installed' });
  });

  it('a file that is not a cart → invalid-cart; a missing file → read-failed', async () => {
    const { m, mi } = manager();
    mi.storage.readLocalCart = async () => strToU8('junk').buffer as ArrayBuffer;
    await expect(m.launchSlot('c1')).rejects.toMatchObject({ code: 'invalid-cart' });
    mi.storage.readLocalCart = async () => null;
    await expect(m.launchSlot('c1')).rejects.toMatchObject({ code: 'read-failed' });
  });

  it('readCartBinary: local → installed copy, remote → cache, system / unknown → null', async () => {
    const { m, reads } = manager([{ id: 'c1', type: 'local', name: 'C', order: 3 }, { id: 'r1', type: 'remote', name: 'R', order: 4 }]);
    expect(await m.readCartBinary('c1')).toBeInstanceOf(ArrayBuffer);
    expect(await m.readCartBinary('r1')).toBeInstanceOf(ArrayBuffer);
    expect(await m.readCartBinary('system:illustrator')).toBeNull();
    expect(await m.readCartBinary('nope')).toBeNull();
    expect(reads).toEqual(['local:c1', 'cache:r1']);
  });
});

/** A renderer that is a launch presenter (as ShellRenderer is): records calls; the test drives black / settled. */
function fakePresenter() {
  const calls: string[] = [];
  const p = {
    calls,
    opts: null as ShellLaunchBeginOptions | null,
    launchActive: false,
    beginLaunch(o: ShellLaunchBeginOptions) { p.opts = o; calls.push('begin'); p.launchActive = true; },
    markLaunchReady() { calls.push('ready'); },
    skipLaunch() { calls.push('skip'); },
    cancelLaunch() { calls.push('cancel'); },
    /** the fade finished (stays active: black) */
    black() { p.opts?.onBlack(); },
    /** a spin-down finished */
    settle() { p.launchActive = false; p.opts?.onSettled(); },
  };
  return p;
}

describe('ShellUIManager launch — with a mounted scene (the renderer presents it)', () => {
  it('starts the renderer launch at once, fades the cluster with its frames, locks input, resolves at black', async () => {
    const { m, mi } = manager();
    const r = fakePresenter();
    const cluster = mount(mi, r as unknown as Record<string, unknown>);
    const p = m.launchSlot('c1', { reducedMotion: false });
    expect(r.calls).toEqual(['begin']);
    expect(r.opts).toMatchObject({ slotId: 'c1', reducedMotion: false, fadeColor: LAUNCH.fadeColor });
    expect(m.isLaunching).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls).toEqual(['begin', 'ready']);
    r.opts!.onFrame?.({ yaw: 0, tilt: 0, scale: 1, spin: 0, spinRate: 0, blur: 0, dim: 0.44, fade: 0, chromeOpacity: 0.5, black: false });
    expect(cluster.style.opacity).toBe('0.5');
    expect(cluster.style.pointerEvents).toBe('none');
    r.black();
    expect((await p).title).toBe('Night Market');
    expect(m.isLaunching).toBe(true);    // black: still locked while the host opens the Player
    // the host could not open the Player → fade the Shell back in
    expect(m.cancelLaunch()).toBe(true);
    expect(r.calls).toContain('cancel');
    r.settle();
    expect(m.isLaunching).toBe(false);
    expect(cluster.style.opacity).toBe('');
  });

  it('an error rejects at once; the spin-down keeps input locked until it settles, then the cluster is back', async () => {
    const { m, mi } = manager();
    const r = fakePresenter();
    const cluster = mount(mi, r as unknown as Record<string, unknown>);
    mi.storage.readLocalCart = async () => null;
    const out = m.launchSlot('c1').catch((e: ShellLaunchError) => e.code);
    await vi.advanceTimersByTimeAsync(0);
    expect(await out).toBe('read-failed');
    expect(r.calls).toEqual(['begin', 'cancel']);
    expect(m.isLaunching).toBe(true);
    r.settle();
    expect(m.isLaunching).toBe(false);
    expect(cluster.style.opacity).toBe('');
  });

  it('the top viewer switches to the TAPPED cart (whatever was hovered / selected) before the first frame, and back after a failed launch', async () => {
    const { m, mi } = manager([
      { id: 'c1', type: 'local', name: 'One', order: 3 }, { id: 'c2', type: 'local', name: 'Two', order: 4 },
    ]);
    const r = fakePresenter();
    let atBegin: string | null = null;
    const begin = r.beginLaunch;
    r.beginLaunch = (o) => { atBegin = mi.viewerCartId(); begin(o); };
    mount(mi, r as unknown as Record<string, unknown>);
    mi.view.hoveredSlotId = 'c2';
    mi.view.selectedSlotId = 'c2';
    mi.currentModel = { tiles: [{ id: 'c1', cd: true }, { id: 'c2', cd: true }] };
    mi.storage.readLocalCart = async () => null;   // → read-failed
    const out = m.launchSlot('c1').catch((e: ShellLaunchError) => e.code);
    expect(mi.rebuildAndRender).toHaveBeenCalledTimes(1);   // rebuilt BEFORE the presenter starts
    expect(atBegin).toBe('c1');
    expect(mi.buildViewerSpec().kind).toBe('cd');
    expect(await out).toBe('read-failed');
    expect(mi.viewerCartId()).toBe('c1');                  // still on it while the disc spins down
    r.settle();
    expect(mi.viewerCartId()).toBe('c2');                  // back to the hovered one
    expect(mi.rebuildAndRender).toHaveBeenCalledTimes(2);
  });

  it('Esc-style cancel rejects cancelled; a second launch while one runs is busy', async () => {
    const { m, mi } = manager();
    mount(mi, fakePresenter() as unknown as Record<string, unknown>);
    const a = m.launchSlot('c1').catch((e: ShellLaunchError) => e.code);
    const b = m.launchSlot('c1').catch((e: ShellLaunchError) => e.code);
    expect(await b).toBe('busy');
    expect(m.cancelLaunch()).toBe(true);
    expect(await a).toBe('cancelled');
  });

  it('destroyScene rejects a pending launch (unmounted)', async () => {
    vi.stubGlobal('window', { removeEventListener: vi.fn() });
    const { m, mi } = manager();
    mount(mi, fakePresenter() as unknown as Record<string, unknown>);
    let release!: (b: ArrayBuffer) => void;
    mi.storage.readLocalCart = () => new Promise<ArrayBuffer>((r) => { release = r; });
    const out = m.launchSlot('c1').catch((e: ShellLaunchError) => e.code);
    m.destroyScene();
    expect(await out).toBe('unmounted');
    expect(m.isLaunching).toBe(false);
    release(cart().slice().buffer);
  });

  it('a renderer that is not a presenter: no animation, the launch resolves when the cart is ready', async () => {
    const { m, mi } = manager();
    mount(mi);
    const r = await m.launchSlot('c1');
    expect(r.slotId).toBe('c1');
  });
});

describe('ShellUIManager — a tap on a cart launches (host side: onActivate → launchSlot)', () => {
  it('one tap emits the activation once and records it for the double-click guard', () => {
    const { m, mi } = manager();
    const got: ShellActivateEvent[] = [];
    m.onActivate.subscribe((e) => got.push(e));
    mi.handleClick('c1');
    expect(got).toEqual([{ id: 'c1', kind: 'local', dashboardKind: undefined }]);
    expect(mi._tapActivated?.id).toBe('c1');
    expect(m.getViewState().selectedSlotId).toBe('c1');
  });

  it('the cart sheet: emitted for carts only, never while a launch runs', async () => {
    const { m, mi } = manager();
    const menus: ShellSlotMenuEvent[] = [];
    m.onSlotMenu.subscribe((e) => menus.push(e));
    mi.emitSlotMenu('c1', 10, 20, 'long-press');
    mi.emitSlotMenu('system:settings', 10, 20, 'context-menu');
    expect(menus).toEqual([{ id: 'c1', kind: 'local', clientX: 10, clientY: 20, source: 'long-press' }]);
    mount(mi, fakePresenter() as unknown as Record<string, unknown>);
    const p = m.launchSlot('c1').catch(() => undefined);
    mi.emitSlotMenu('c1', 10, 20, 'context-menu');
    expect(menus).toHaveLength(1);
    m.cancelLaunch();
    await p;
  });
});
