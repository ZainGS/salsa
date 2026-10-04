import { describe, it, expect, vi } from 'vitest';
import { runWhenIdle, IdleGateStaleError } from './idle-gate';
import ShapeManager from '../shape-manager';

/** A manual clock: sleep() resolves when the test advances it (no real timers). */
function manualSleep() {
  const waiters: Array<() => void> = [];
  return {
    sleep: () => new Promise<void>((r) => waiters.push(r)),
    tick: async () => { const w = waiters.splice(0); w.forEach((r) => r()); await Promise.resolve(); await Promise.resolve(); },
    get pending() { return waiters.length; },
  };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('runWhenIdle (export deferral, bug-hunt 2026-10-01 G2 follow-up)', () => {
  it('runs immediately when idle', async () => {
    const task = vi.fn(async () => 42);
    await expect(runWhenIdle(() => false, task)).resolves.toBe(42);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('waits while busy, then runs once after it clears', async () => {
    let busy = true;
    const clock = manualSleep();
    const onDeferred = vi.fn();
    const task = vi.fn(async () => 'editor-state');
    const p = runWhenIdle(() => busy, task, { sleep: clock.sleep, onDeferred });
    await flush();
    expect(task).not.toHaveBeenCalled();
    expect(onDeferred).toHaveBeenCalledTimes(1);
    await clock.tick(); await flush();
    expect(task).not.toHaveBeenCalled();   // still playing
    busy = false;
    await clock.tick(); await flush();
    await expect(p).resolves.toBe('editor-state');
    expect(task).toHaveBeenCalledTimes(1);
    expect(onDeferred).toHaveBeenCalledTimes(1);
  });

  it('discards a result gathered while Play started mid-task and gathers again after Stop', async () => {
    let busy = false;
    const clock = manualSleep();
    let n = 0;
    const task = vi.fn(async () => { n++; if (n === 1) busy = true; return n === 1 ? 'in-game' : 'editor'; });
    const p = runWhenIdle(() => busy, task, { sleep: clock.sleep });
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    busy = false;
    await clock.tick(); await flush();
    await expect(p).resolves.toBe('editor');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('rejects when the request went stale (another document loaded) while waiting', async () => {
    let busy = true, stale = false;
    const clock = manualSleep();
    const task = vi.fn(async () => 1);
    const p = runWhenIdle(() => busy, task, { sleep: clock.sleep, isStale: () => stale });
    await flush();
    stale = true; busy = false;
    await clock.tick();
    await expect(p).rejects.toBeInstanceOf(IdleGateStaleError);
    expect(task).not.toHaveBeenCalled();
  });

  it('a task that throws because the editor went busy (device lost mid-read-back) runs again once idle', async () => {
    let busy = false;
    const clock = manualSleep();
    let n = 0;
    const task = vi.fn(async () => { n++; if (n === 1) { busy = true; throw new Error('mapAsync: device lost'); } return 'recovered'; });
    const p = runWhenIdle(() => busy, task, { sleep: clock.sleep });
    await flush();
    busy = false;
    await clock.tick(); await flush();
    await expect(p).resolves.toBe('recovered');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('a task failing while idle still rejects', async () => {
    await expect(runWhenIdle(() => false, async () => { throw new Error('real'); })).rejects.toThrow('real');
  });

  it('a task that spanned a whole busy period (lost AND recovered while it ran) runs again', async () => {
    let lost = 0, n = 0;
    const task = vi.fn(async () => { n++; if (n === 1) lost++; return n; });
    await expect(runWhenIdle(() => false, task, { busyEpoch: () => lost })).resolves.toBe(2);
    expect(task).toHaveBeenCalledTimes(2);
  });
});

describe('ShapeManager.packProject during Play', () => {
  /** The members packProject touches — the gather itself is stubbed (it is the shared autosave gather). */
  function fakeSm(playing: { v: boolean }) {
    const self = {
      scene3d: { isPlayModeActive: () => playing.v },
      ui: { interactive: false },
      _uiPlayerMode: false,
      _docLoadEpoch: 0,
      _persistBusyEpoch: () => 0,
      _notifyPersistDeferred: () => {},
      // what the gather would capture: the player's position at the time it runs
      player: { x: 0 },
      gathered: [] as number[],
      _isEditorBusyForPersist(): boolean { return (ShapeManager.prototype as any)._isEditorBusyForPersist.call(this); },
      async _packProjectNow(): Promise<Blob> { self.gathered.push(self.player.x); return new Blob([JSON.stringify({ x: self.player.x })]); },
    };
    return self;
  }

  it('does not capture the in-game frame: the export runs after Stop, with the restored editor state', async () => {
    vi.useFakeTimers();
    try {
      const playing = { v: false };
      const sm = fakeSm(playing);
      // Enter Play and walk the player away from its editor position.
      playing.v = true; sm.player.x = 25;
      const p = (ShapeManager.prototype.packProject as () => Promise<Blob>).call(sm);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sm.gathered).toEqual([]);           // nothing packed while playing
      // Stop: the editor transforms come back, then the gate opens.
      sm.player.x = 0; playing.v = false;
      await vi.advanceTimersByTimeAsync(300);
      const blob = await p;
      expect(sm.gathered).toEqual([0]);
      expect(JSON.parse(await blob.text())).toEqual({ x: 0 });
    } finally { vi.useRealTimers(); }
  });

  it('a document load while the export waits rejects instead of packing the new document', async () => {
    vi.useFakeTimers();
    try {
      const playing = { v: true };
      const sm = fakeSm(playing);
      const p = (ShapeManager.prototype.packProject as () => Promise<Blob>).call(sm);
      const caught = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(500);
      sm._docLoadEpoch++; playing.v = false;   // restoreDocumentState bumps the epoch (and a load stops Play)
      await vi.advanceTimersByTimeAsync(300);
      expect(await caught).toBeInstanceOf(IdleGateStaleError);
      expect(sm.gathered).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('exports immediately when not playing', async () => {
    const sm = fakeSm({ v: false });
    await (ShapeManager.prototype.packProject as () => Promise<Blob>).call(sm);
    expect(sm.gathered).toEqual([0]);
  });
});
