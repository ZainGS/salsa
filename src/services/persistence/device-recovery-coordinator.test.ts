import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeviceRecoveryCoordinator, describeShadowGaps, gpuOnlyFromRestorePayload, blankGpuOnlyData, type DeviceRecoveryHost } from './device-recovery-coordinator';
import type { GpuOnlyDocumentData } from './document-state-coordinator';
import type { DocumentSavePayload } from './document-persistence';

afterEach(() => { vi.restoreAllMocks(); });

const payloadWith = (layers: Array<{ id: string; name?: string; type?: string }>, extra: Partial<DocumentSavePayload> = {}) =>
  ({ manifest: { docId: 'd', name: 'd', version: 3, layers, createdAt: 0, updatedAt: 0 }, layers: [], ...extra }) as unknown as DocumentSavePayload;

/** A host that records the order of every call. `epoch` = the GPU-pixel edit count; `content` = has raster layers. */
function makeHost(over: Partial<DeviceRecoveryHost> = {}) {
  const calls: string[] = [];
  const st = { epoch: 0, content: true, healthy: true, gathered: null as GpuOnlyDocumentData | null, readBacks: 0, layers: [{ id: 'bg', name: 'Background', type: 'layer' }] };
  const host: DeviceRecoveryHost = {
    leaveTransientModes: () => { calls.push('leave'); },
    captureRuntime: () => { calls.push('capture'); return { cam: 1 }; },
    listContent: () => { calls.push('list'); return new Set<object>(); },
    gather: async (g) => { calls.push('gather'); st.gathered = g; return payloadWith(st.layers); },
    readBackGpuOnly: async () => { st.readBacks++; return { ...blankGpuOnlyData(st.epoch, st.layers.map((l) => l.id)), at: Date.now() + st.readBacks }; },
    hasGpuOnlyContent: () => st.content,
    gpuPixelEpoch: () => st.epoch,
    resetManagersForNewDevice: () => { calls.push('reset'); return []; },
    restore: async () => { calls.push('restore'); },
    resetSurvivors: () => { calls.push('survivors'); },
    applyRuntime: () => { calls.push('apply'); },
    deviceHealthy: () => st.healthy,
    ...over,
  };
  const install = vi.fn(async () => { calls.push('install'); });
  return { host, calls, st, install };
}

describe('DeviceRecoveryCoordinator.recover — ordering', () => {
  it('stops Play, snapshots, installs the device, resets managers, restores, then re-applies the runtime view', async () => {
    const { host, calls, install } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    await c.recover(install);
    expect(calls).toEqual(['leave', 'capture', 'list', 'gather', 'install', 'reset', 'restore', 'survivors', 'apply']);
  });

  it('the snapshot is gathered BEFORE install (from the shadow), never from the new device', async () => {
    const { host, st, install } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    const shadow = { ...blankGpuOnlyData(0, ['bg']), layers: [{ id: 'bg', pixelData: new ArrayBuffer(4) }] };
    c.seedShadow(shadow);
    await c.recover(install);
    expect(st.gathered).toBe(shadow);
  });

  it('a failing install rejects (the renderer reports failed) and nothing is restored', async () => {
    const { host, calls } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    await expect(c.recover(async () => { calls.push('install'); throw new Error('no adapter'); })).rejects.toThrow('no adapter');
    expect(calls).not.toContain('restore');
    expect(calls).not.toContain('reset');
  });

  it('a failing snapshot still installs the device, skips the restore and reports it', async () => {
    const { host, calls, install } = makeHost({ gather: async () => { throw new Error('boom'); } });
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    const un = await c.recover(install);
    expect(calls).toContain('install');
    expect(calls).not.toContain('restore');
    expect(un.some((s) => /snapshot failed \(boom\)/.test(s))).toBe(true);
  });

  it('a throwing leave / runtime step does not stop the recovery; manager + restore errors are reported', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host, calls, install } = makeHost({
      leaveTransientModes: () => { throw new Error('play'); },
      applyRuntime: () => { throw new Error('view'); },
      resetManagersForNewDevice: () => ['2 HTML texture(s)'],
      restore: async () => { calls.push('restore'); throw new Error('restore broke'); },
    });
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    const un = await c.recover(install);
    expect(un).toContain('2 HTML texture(s)');
    expect(un.some((s) => /document restore: restore broke/.test(s))).toBe(true);
    expect(calls).toContain('restore');
  });
});

describe('DeviceRecoveryCoordinator — the read-back shadow decides what is reported', () => {
  it('a blank document with no edits reports nothing (the start-up shadow is exact)', async () => {
    const { host, install } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    expect(c.shadowCurrent).toBe(true);
    expect(await c.recover(install)).toEqual([]);
  });

  it('a document seeded from its restore payload, unedited, reports nothing', async () => {
    const { host, st, install } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    st.epoch = 7;   // the load's own uploads moved the count; the seed records the count after them
    c.seedShadow({ ...blankGpuOnlyData(7, ['bg']), layers: [{ id: 'bg', pixelData: new ArrayBuffer(16) }] });
    expect(await c.recover(install)).toEqual([]);
  });

  it('an edit after the last read-back is reported (with any layer the shadow never saw)', async () => {
    const { host, st, install } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    st.layers = [{ id: 'bg', name: 'Background', type: 'layer' }, { id: 'l2', name: 'Ink', type: 'layer' }];
    st.epoch = 1;   // painted
    const un = await c.recover(install);
    expect(un.some((s) => /edits made in the \d+s before the loss/.test(s))).toBe(true);
    expect(un.some((s) => /created after the last read-back come back blank: Background, Ink/.test(s))).toBe(true);
  });

  it('a refresh after the edit makes the shadow exact again', async () => {
    const { host, st, install } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    st.epoch = 3;
    expect(c.shadowCurrent).toBe(false);
    expect(await c.refreshShadow()).toBe(true);
    expect(c.shadowCurrent).toBe(true);
    expect(await c.recover(install)).toEqual([]);
  });

  it('no trustworthy shadow (seeded null after a failed load) with raster content reports the pixels', async () => {
    const { host, install } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    c.seedShadow(null);
    const un = await c.recover(install);
    expect(un).toEqual(['raster layer / painted texture pixels (no read-back was taken before the loss)']);
  });

  it('nothing is reported for a document without GPU-only content, even after edits', async () => {
    const { host, st, install } = makeHost();
    st.content = false;
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    st.epoch = 5;
    expect(await c.recover(install)).toEqual([]);
  });

  it('the timer tick reads back only when the edit count moved (and the device is healthy)', async () => {
    const { host, st } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    c.tick(); await Promise.resolve();
    expect(st.readBacks).toBe(0);                  // exact → no read
    st.epoch = 1; st.healthy = false;
    c.tick(); await Promise.resolve();
    expect(st.readBacks).toBe(0);                  // lost → no read
    st.healthy = true;
    c.tick(); await Promise.resolve(); await Promise.resolve();
    expect(st.readBacks).toBe(1);
    c.tick(); await Promise.resolve();
    expect(st.readBacks).toBe(1);                  // exact again
  });

  it('a read-back that finishes after the device was lost is discarded', async () => {
    const { host, st } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    const before = c.shadow;
    st.epoch = 2;
    host.readBackGpuOnly = async () => { st.healthy = false; return blankGpuOnlyData(2); };
    expect(await c.refreshShadow()).toBe(false);
    expect(c.shadow).toBe(before);
  });

  it('noteGpuOnly keeps the newest capture; seedShadow replaces unconditionally', () => {
    const { host } = makeHost();
    const c = new DeviceRecoveryCoordinator(host, { shadowIntervalMs: 0 });
    const newer = blankGpuOnlyData(1, [], Date.now() + 1000), older = blankGpuOnlyData(0, [], Date.now() - 1000);
    c.noteGpuOnly(newer); c.noteGpuOnly(older);
    expect(c.shadow).toBe(newer);
    c.seedShadow(older);
    expect(c.shadow).toBe(older);
  });
});

describe('gpuOnlyFromRestorePayload / describeShadowGaps', () => {
  it('seeds from the payload pixels when every layer / cel matches the canvas size', () => {
    const px = new ArrayBuffer(2 * 2 * 4);
    const p = payloadWith([{ id: 'bg' }], { layers: [{ id: 'bg', pixelData: px }], cels: [{ celId: 'c1', pixelData: px }], meshTextures: { m: new ArrayBuffer(3) } });
    const s = gpuOnlyFromRestorePayload(p, 4, { w: 2, h: 2 }, ['bg', 'blank'], ['c1'])!;
    expect(s.editEpoch).toBe(4);
    expect(s.layers[0].pixelData).toBe(px);
    expect(s.layerIds).toEqual(['bg', 'blank']);
    expect(s.meshTextureKeys).toEqual(['m']);
  });

  it('refuses (null) when a stored layer is another size (it was resized on load, so the bytes differ)', () => {
    const p = payloadWith([{ id: 'bg' }], { layers: [{ id: 'bg', pixelData: new ArrayBuffer(4 * 4 * 4) }] });
    expect(gpuOnlyFromRestorePayload(p, 0, { w: 2, h: 2 }, ['bg'], [])).toBeNull();
  });

  it('a payload without pixels (blank document) seeds an exact empty shadow', () => {
    const s = gpuOnlyFromRestorePayload(payloadWith([{ id: 'bg' }]), 0, { w: 8, h: 8 }, ['bg'], []);
    expect(s?.layers).toEqual([]);
  });

  it('describeShadowGaps lists only raster layers the shadow never saw, plus the age', () => {
    const shadow = blankGpuOnlyData(0, ['bg'], 10_000);
    const p = payloadWith([{ id: 'bg', name: 'Background' }, { id: 'v', name: 'Vec', type: 'vector' }, { id: 'n', name: 'New' }]);
    expect(describeShadowGaps(shadow, p, 22_000)).toEqual([
      'raster layer(s) created after the last read-back come back blank: New',
      'raster / painted-texture edits made in the 12s before the loss (after the last read-back) are lost',
    ]);
  });
});
