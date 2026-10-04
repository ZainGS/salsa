import { describe, it, expect, afterEach } from 'vitest';
import { createGpuDeviceHandle, unwrapDevice, getDeviceHandle } from './gpu-device-handle';
import { rebuildInPlace, sweepGpuFields, isGpuObject, GpuDeviceStatusTracker } from './gpu-device-recovery';

// ── A fake GPUDevice: methods BRAND-CHECK `this` like the real ones (called on a proxy they throw) ──────────────────
const BRAND = new WeakSet<object>();
class FakeDevice extends EventTarget {
  label: string;
  onuncapturederror: ((e: unknown) => void) | null = null;
  readonly queue: { owner: FakeDevice };
  constructor(label: string) {
    super();
    this.label = label;
    this.queue = { owner: this };
    BRAND.add(this);
  }
  createBuffer(desc: { size: number }): { device: FakeDevice; size: number } {
    if (!BRAND.has(this)) throw new TypeError('Illegal invocation');
    return { device: this, size: desc.size };
  }
}
const asDev = (d: FakeDevice) => d as unknown as GPUDevice;

describe('GpuDeviceHandle', () => {
  it('forwards methods (bound to the real device) and properties to the CURRENT device', () => {
    const a = new FakeDevice('a'), b = new FakeDevice('b');
    const h = createGpuDeviceHandle(asDev(a));
    const dev = h.device as unknown as FakeDevice;
    expect(dev.createBuffer({ size: 4 }).device).toBe(a);
    expect(dev.queue.owner).toBe(a);
    expect(h.generation).toBe(0);
    h.retarget(asDev(b));
    expect(h.generation).toBe(1);
    expect(h.current).toBe(b);
    expect(dev.createBuffer({ size: 8 }).device).toBe(b);   // the same proxy, a new device: no stale bound method
    expect(dev.queue.owner).toBe(b);
    expect(dev.label).toBe('b');
  });

  it('a method reference captured BEFORE the retarget still targets the device it was read from', () => {
    // (owners read device.createBuffer at call time; this documents what a cached method reference does)
    const a = new FakeDevice('a'), b = new FakeDevice('b');
    const h = createGpuDeviceHandle(asDev(a));
    const early = (h.device as unknown as FakeDevice).createBuffer;
    h.retarget(asDev(b));
    expect(early({ size: 1 }).device).toBe(a);
    expect((h.device as unknown as FakeDevice).createBuffer({ size: 1 }).device).toBe(b);
  });

  it('moves event listeners and assigned handlers to the new device', () => {
    const a = new FakeDevice('a'), b = new FakeDevice('b');
    const h = createGpuDeviceHandle(asDev(a));
    const seen: string[] = [];
    const fn = (e: Event) => seen.push((e.target as FakeDevice).label);
    h.device.addEventListener('uncapturederror', fn);
    h.device.addEventListener('uncapturederror', fn);   // duplicate: recorded once
    const onErr = () => {};
    (h.device as unknown as FakeDevice).onuncapturederror = onErr;
    h.retarget(asDev(b));
    a.dispatchEvent(new Event('uncapturederror'));        // removed from the old device
    b.dispatchEvent(new Event('uncapturederror'));
    expect(seen).toEqual(['b']);
    expect(b.onuncapturederror).toBe(onErr);
    h.device.removeEventListener('uncapturederror', fn);
    h.retarget(asDev(new FakeDevice('c')));
    b.dispatchEvent(new Event('uncapturederror'));
    expect(seen).toEqual(['b']);                           // removed listeners don't follow
  });

  it('retarget to the same device is a no-op; unwrap / getDeviceHandle / instanceof', () => {
    const a = new FakeDevice('a');
    const h = createGpuDeviceHandle(asDev(a));
    h.retarget(asDev(a));
    expect(h.generation).toBe(0);
    expect(unwrapDevice(h.device)).toBe(a);
    expect(unwrapDevice(asDev(a))).toBe(a);              // a plain device unwraps to itself
    expect(unwrapDevice(null)).toBeNull();
    expect(getDeviceHandle(h.device)).toBe(h);
    expect(getDeviceHandle(asDev(a))).toBeNull();
    expect(h.device instanceof FakeDevice).toBe(true);
    const b = new FakeDevice('b');
    h.retarget(asDev(b));
    expect(unwrapDevice(h.device)).toBe(b);
  });
});

describe('rebuildInPlace', () => {
  class Owner { atlas: { v: number; extra?: number }; buf: string; constructor(v: number) { this.atlas = { v }; this.buf = `buf${v}`; } }

  it('keeps the instance identity, replaces state, deletes fields the fresh instance lacks', () => {
    const t = new Owner(1); (t as unknown as Record<string, unknown>).ghost = 'stale';   // a field only the old instance has
    const holder = { owner: t };
    const out = rebuildInPlace(t, new Owner(2));
    expect(out).toBe(t);
    expect(holder.owner).toBe(t);
    expect(t.buf).toBe('buf2');
    expect('ghost' in t).toBe(false);
  });

  it('keepIdentity rebuilds a shared sub-object in place instead of swapping it', () => {
    const t = new Owner(1);
    const sharedAtlas = t.atlas; sharedAtlas.extra = 9;
    const captured = { atlas: sharedAtlas };                 // e.g. a drawing service captured the atlas
    rebuildInPlace(t, new Owner(2), ['atlas']);
    expect(t.atlas).toBe(sharedAtlas);
    expect(captured.atlas.v).toBe(2);
    expect('extra' in captured.atlas).toBe(false);
    // without keepIdentity the sub-object is swapped
    const t2 = new Owner(1), a2 = t2.atlas;
    rebuildInPlace(t2, new Owner(3));
    expect(t2.atlas).not.toBe(a2);
    expect(t2.atlas.v).toBe(3);
  });

  it('is a no-op for the same object', () => {
    const t = new Owner(1);
    expect(rebuildInPlace(t, t)).toBe(t);
    expect(t.buf).toBe('buf1');
  });
});

describe('sweepGpuFields', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { GPUBuffer: g.GPUBuffer, GPUTexture: g.GPUTexture };
  class GPUBufferFake {}
  class GPUTextureFake {}
  afterEach(() => { g.GPUBuffer = saved.GPUBuffer; g.GPUTexture = saved.GPUTexture; });

  it('nulls GPU fields, empties GPU arrays, clears GPU maps; leaves CPU data and skipped fields', () => {
    g.GPUBuffer = GPUBufferFake; g.GPUTexture = GPUTextureFake;
    const keep = new GPUBufferFake();
    const o = {
      buf: new GPUBufferFake(), tex: new GPUTextureFake(), keep,
      bufs: [new GPUBufferFake(), new GPUBufferFake()], nums: [1, 2, 3],
      texByKey: new Map<string, unknown>([['a', new GPUTextureFake()]]), names: new Map([['a', 'x']]),
      cpu: new Float32Array(4), label: 'x',
    };
    const swept = sweepGpuFields(o, ['keep']);
    expect(swept.sort()).toEqual(['buf', 'bufs', 'tex', 'texByKey']);
    expect(o.buf).toBeNull(); expect(o.tex).toBeNull();
    expect(o.bufs).toEqual([]); expect(o.texByKey.size).toBe(0);
    expect(o.keep).toBe(keep);
    expect(o.nums).toEqual([1, 2, 3]); expect(o.names.size).toBe(1); expect(o.cpu.length).toBe(4); expect(o.label).toBe('x');
  });

  it('isGpuObject is false without WebGPU classes (node) and for plain values', () => {
    g.GPUBuffer = undefined; g.GPUTexture = undefined;
    expect(isGpuObject({})).toBe(false);
    expect(isGpuObject(null)).toBe(false);
    expect(isGpuObject(3)).toBe(false);
  });
});

describe('GpuDeviceStatusTracker', () => {
  it('counts losses and recoveries and notifies subscribers with a snapshot', () => {
    const t = new GpuDeviceStatusTracker();
    const seen: string[] = [];
    const off = t.subscribe((i) => seen.push(`${i.status}:${i.lostCount}/${i.recoveredCount}`));
    t.set({ status: 'ok' });
    t.set({ status: 'lost', reason: 'unknown' });
    t.set({ status: 'lost' });                         // repeated 'lost' is not a second loss
    t.set({ status: 'recovering' });
    t.set({ status: 'ok', unrecovered: ['x'] });
    expect(seen).toEqual(['ok:0/0', 'lost:1/0', 'lost:1/0', 'recovering:1/0', 'ok:1/1']);
    expect(t.info.lastRecoveryMs).not.toBeNull();
    const info = t.info; info.unrecovered.push('mutated');
    expect(t.info.unrecovered).toEqual(['x']);        // a copy
    off();
    t.set({ status: 'lost' });
    expect(seen.length).toBe(5);
  });
});
