/**
 * shell-mount-cache.test.ts — what the Shell keeps across mounts and across project-list refreshes:
 *  - pipelines per REAL device (shell-gpu-cache), not per device handle;
 *  - pre-decoded icon bitmaps upload synchronously (shell-thumbnails requestBitmap);
 *  - the icon-bake memo key covers every input of the bake;
 *  - a project-list refresh that returns the same list is not a change (shell-project-diff);
 *  - two GpuFrameTimers can share one queue (the editor's + the ?shellperf HUD's).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { shellGpuCached, shellGpuCacheSize } from './shell-gpu-cache';
import { createGpuDeviceHandle } from '../core/gpu-device-handle';
import { ShellThumbnailAtlas, THUMB_CELL_PX } from './shell-thumbnails';
import { iconVariantKey } from './shell-icon-bake';
import { sameProjectList, projectsOfKind } from '../../services/managers/shell-project-diff';
import { GpuFrameTimer } from '../core/gpu-frame-timer';
import type { ProjectEntry } from '../../services/persistence/shell-storage';

const g = globalThis as { GPUTextureUsage?: unknown; GPUBufferUsage?: unknown; GPUMapMode?: unknown };
const saved = { tu: g.GPUTextureUsage, bu: g.GPUBufferUsage, mm: g.GPUMapMode };
beforeAll(() => {
  g.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 };
  g.GPUBufferUsage = { QUERY_RESOLVE: 512, COPY_SRC: 4, MAP_READ: 1, COPY_DST: 8 };
  g.GPUMapMode = { READ: 1 };
});
afterAll(() => { g.GPUTextureUsage = saved.tu; g.GPUBufferUsage = saved.bu; g.GPUMapMode = saved.mm; });

describe('shellGpuCached', () => {
  it('creates once per key per device; a new real device behind the same handle starts empty', () => {
    const devA = { label: 'A' } as unknown as GPUDevice, devB = { label: 'B' } as unknown as GPUDevice;
    const handle = createGpuDeviceHandle(devA);
    let made = 0;
    const make = () => ({ id: ++made });
    const p1 = shellGpuCached(handle.device, 'sr.bg|bgra8unorm', make);
    expect(shellGpuCached(handle.device, 'sr.bg|bgra8unorm', make)).toBe(p1);       // a second mount: no recompile
    expect(shellGpuCached(devA, 'sr.bg|bgra8unorm', make)).toBe(p1);                // the handle and its device share
    expect(shellGpuCached(handle.device, 'sr.bg|rgba8unorm', make)).not.toBe(p1);   // another format = another pipeline
    expect(made).toBe(2);
    expect(shellGpuCacheSize(handle.device)).toBe(2);
    handle.retarget(devB);                                                          // device loss → recovery
    expect(shellGpuCacheSize(handle.device)).toBe(0);
    expect(shellGpuCached(handle.device, 'sr.bg|bgra8unorm', make)).not.toBe(p1);
    expect(made).toBe(3);
  });
});

describe('ShellThumbnailAtlas.requestBitmap', () => {
  it('uploads a pre-decoded cell bitmap synchronously, without allocating a UV per call when given a scratch', () => {
    const copies: { x: number; y: number }[] = [];
    const device = {
      createTexture: () => ({ createView: () => ({}), destroy() { /* */ } }),
      queue: { copyExternalImageToTexture: (_s: unknown, d: { origin: { x: number; y: number } }) => { copies.push(d.origin); } },
    } as unknown as GPUDevice;
    const atlas = new ShellThumbnailAtlas(device);
    const bmp = { width: THUMB_CELL_PX, height: THUMB_CELL_PX } as unknown as ImageBitmap;
    expect(atlas.hasSource('icon')).toBe(false);
    atlas.requestBitmap('icon', 'bake:1', bmp);
    expect(atlas.hasSource('icon')).toBe(true);
    expect(copies.length).toBe(0);                 // no cell yet: committed by the first touch
    atlas.beginFrame();
    const scratch = { u0: 9, v0: 9, u1: 9, v1: 9 };
    const uv = atlas.touch('icon', scratch);
    expect(uv).toBe(scratch);                      // ready in the SAME call, written into the caller's object
    expect(copies).toEqual([{ x: 0, y: 0 }]);
    expect(scratch).toEqual({ u0: 0, v0: 0, u1: THUMB_CELL_PX / 2048, v1: THUMB_CELL_PX / 2048 });
    expect(atlas.get('icon')).toEqual(scratch);
    expect(atlas.get('icon')).not.toBe(scratch);   // without a scratch: a fresh literal, as before
    // the same key again = no re-upload; a new bake for the same id re-uploads into the same cell
    atlas.requestBitmap('icon', 'bake:1', bmp);
    expect(copies.length).toBe(1);
    atlas.requestBitmap('icon', 'bake:2', { width: THUMB_CELL_PX, height: THUMB_CELL_PX } as unknown as ImageBitmap);
    expect(copies).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
    expect(atlas.touch('icon')).not.toBeNull();
  });
});

describe('icon bake memo key', () => {
  it('covers the outline colour, the rim width and the geometry config (key order irrelevant)', () => {
    const k = iconVariantKey([0, 0, 0, 1], 8, { alphaThreshold: 110 });
    expect(iconVariantKey([0, 0, 0, 1], 8, { alphaThreshold: 110 })).toBe(k);
    expect(iconVariantKey([1, 0, 0, 1], 8, { alphaThreshold: 110 })).not.toBe(k);
    expect(iconVariantKey([0, 0, 0, 1], 0, { alphaThreshold: 110 })).not.toBe(k);
    expect(iconVariantKey([0, 0, 0, 1], 8, { alphaThreshold: 111 })).not.toBe(k);
    expect(iconVariantKey([0, 0, 0, 1], 8, { borderPx: 12 })).not.toBe(k);
    expect(iconVariantKey([0, 0, 0, 1], 0, { borderPx: 12, depth: 0.05 })).toBe(iconVariantKey([0, 0, 0, 1], 0, { depth: 0.05, borderPx: 12 }));
  });
});

describe('sameProjectList', () => {
  const list = (): ProjectEntry[] => [
    { id: 'a', name: 'A', lastModified: 2, thumbnailDataUrl: 'data:a' },
    { id: 'b', name: 'B', lastModified: 1, kind: 'packaging' },
  ];
  it('equal content = same (a refresh that changes nothing must not emit)', () => {
    expect(sameProjectList(list(), list())).toBe(true);
    expect(sameProjectList([], [])).toBe(true);
    const a = list(); a[0].kind = 'illustration';   // untagged = 'illustration'
    expect(sameProjectList(a, list())).toBe(true);
  });
  it('any field, the order or the length differing = changed', () => {
    const cases: ((l: ProjectEntry[]) => void)[] = [
      l => { l[0].name = 'A2'; }, l => { l[0].lastModified = 3; }, l => { l[0].thumbnailDataUrl = 'data:b'; },
      l => { l[1].kind = 'illustration'; }, l => { l[1].sizeBytes = 5; }, l => { l[0].opfsPath = '/x'; },
      l => { l.reverse(); }, l => { l.pop(); }, l => { l.push({ id: 'c', name: 'C' }); },
    ];
    for (const mutate of cases) { const b = list(); mutate(b); expect(sameProjectList(list(), b)).toBe(false); }
  });
  it('projectsOfKind splits the one cached list per dashboard', () => {
    expect(projectsOfKind(list(), 'illustration').map(p => p.id)).toEqual(['a']);
    expect(projectsOfKind(list(), 'packaging').map(p => p.id)).toEqual(['b']);
  });
});

describe('GpuFrameTimer: two timers on one queue', () => {
  function fakeDevice() {
    const submitted: number[] = [];
    class Queue { submit(cbs: Iterable<unknown>) { submitted.push([...cbs].length); return undefined; } }
    const queue = new Queue();
    const enc = () => ({ beginComputePass: () => ({ end() { /* */ } }), finish: () => ({}), resolveQuerySet() { /* */ }, copyBufferToBuffer() { /* */ } });
    const device = {
      features: new Set(['timestamp-query']),
      queue,
      createQuerySet: () => ({ destroy() { /* */ } }),
      createBuffer: () => ({ destroy() { /* */ }, mapAsync: () => new Promise(() => { /* never */ }) }),
      createCommandEncoder: enc,
    } as unknown as GPUDevice;
    return { device, queue: queue as unknown as { submit: (c: unknown[]) => void }, submitted, own: () => Object.prototype.hasOwnProperty.call(queue, 'submit') };
  }

  it('one timer: installs an own wrapper and removes it (unchanged behaviour)', () => {
    const f = fakeDevice();
    const t = new GpuFrameTimer(f.device);
    t.setEnabled(true);
    expect(f.own()).toBe(true);
    f.queue.submit([{}]);
    expect(f.submitted).toEqual([3]);   // begin marker + the buffer + end marker
    t.setEnabled(false);
    expect(f.own()).toBe(false);
    f.queue.submit([{}]);
    expect(f.submitted).toEqual([3, 1]);
  });

  it('inner disabled last / outer disabled first: the remaining timer keeps timing, then the queue is clean', () => {
    const f = fakeDevice();
    const editor = new GpuFrameTimer(f.device), hud = new GpuFrameTimer(f.device);
    editor.setEnabled(true); hud.setEnabled(true);
    f.queue.submit([{}]);
    expect(f.submitted).toEqual([5]);   // both bracket the submission
    hud.setEnabled(false);              // the Shell unmounts
    expect(f.own()).toBe(true);         // the editor's wrapper is back, not deleted with the HUD's
    f.queue.submit([{}]);
    expect(f.submitted).toEqual([5, 3]);
    editor.setEnabled(false);
    expect(f.own()).toBe(false);
  });

  it('inner disabled first: the chain is left alone and passes through; the outer one still uninstalls', () => {
    const f = fakeDevice();
    const editor = new GpuFrameTimer(f.device), hud = new GpuFrameTimer(f.device);
    editor.setEnabled(true); hud.setEnabled(true);
    editor.setEnabled(false);
    f.queue.submit([{}]);
    expect(f.submitted).toEqual([3]);   // only the HUD's markers; the editor's wrapper passes through
    hud.setEnabled(false);
    f.queue.submit([{}]);
    expect(f.submitted).toEqual([3, 1]);
  });
});
