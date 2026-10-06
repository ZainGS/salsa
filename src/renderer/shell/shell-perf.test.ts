/**
 * shell-perf.test.ts — the Shell's dev instrumentation: flag parsing (every layer ON by default), frame statistics,
 * the HUD text, and the structural guards behind "one render pass".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseShellDebug, SHELL_DEBUG_DEFAULTS, SHELL_DEBUG_TOGGLES, ShellFrameStats, snapRefreshRate, formatShellHud,
} from './shell-perf';

describe('parseShellDebug', () => {
  it('defaults: every layer + bake on, the HUD and the long-task log off', () => {
    const f = parseShellDebug('');
    expect(f).toEqual(SHELL_DEBUG_DEFAULTS);
    expect(f.hud).toBe(false); expect(f.longTasks).toBe(false);
    for (const k of SHELL_DEBUG_TOGGLES) expect(f[k], k).toBe(true);
    expect(f.warmup).toBe(true);
    expect(parseShellDebug(null)).toEqual(SHELL_DEBUG_DEFAULTS);
    expect(parseShellDebug('?docW=10&x=shellperf')).toEqual(SHELL_DEBUG_DEFAULTS);
  });

  it('?shellperf turns on the HUD + the long-task log and nothing else', () => {
    const f = parseShellDebug('?shellperf');
    expect(f.hud).toBe(true); expect(f.longTasks).toBe(true);
    expect({ ...f, hud: false, longTasks: false }).toEqual(SHELL_DEBUG_DEFAULTS);
    expect(parseShellDebug('?shellperf=1').hud).toBe(true);
    expect(parseShellDebug('?shellperf=0').hud).toBe(false);
    expect(parseShellDebug('shelllongtasks')).toMatchObject({ hud: false, longTasks: true });
  });

  it('?shellskip= turns off the named layers (case-insensitive, aliases, unknown names ignored)', () => {
    const f = parseShellDebug('?shellperf&shellskip=specks,Grain,grid,tilebatch,warmup,nonsense,panelbake');
    expect(f).toMatchObject({ specks: false, grain: false, wireGrid: false, tiles: false, warmup: false, panelBake: false });
    expect(f).toMatchObject({ panel: true, hero: true, backdrop: true, grainBake: true, hud: true });
    expect(parseShellDebug('?shellskip=hero,panel,backdrop,grainbake')).toMatchObject({ hero: false, panel: false, backdrop: false, grainBake: false });
  });

  it('layers on a base (localStorage first, then the URL)', () => {
    const stored = parseShellDebug('shellskip=grain');
    const f = parseShellDebug('?shellperf', stored);
    expect(f.grain).toBe(false); expect(f.hud).toBe(true);
    expect(stored.hud).toBe(false);   // the base is not mutated
  });
});

describe('ShellFrameStats', () => {
  it('avg / p95 / max / frames over 20 ms over the window', () => {
    const s = new ShellFrameStats(100);
    let t = 1000;
    s.frame(t, 2);
    for (let i = 0; i < 100; i++) { t += i % 20 === 19 ? 40 : 16; s.frame(t, i % 20 === 19 ? 9 : 3); }
    const r = s.summary();
    expect(r.frames).toBe(100);
    expect(r.maxMs).toBe(40);
    expect(r.over20).toBe(5);
    expect(r.avgMs).toBeCloseTo((95 * 16 + 5 * 40) / 100, 5);
    expect(r.p95Ms).toBe(40);
    expect(r.cpuMaxMs).toBe(9);
    expect(r.cpuAvgMs).toBeCloseTo((95 * 3 + 5 * 9) / 100, 5);
    expect(r.gpuMs).toBe(-1); expect(r.gpuSource).toBe('none');
  });

  it('ignores pauses (tab switch) and keeps a sliding window', () => {
    const s = new ShellFrameStats(10);
    let t = 0;
    s.frame(t, 1);
    for (let i = 0; i < 5; i++) { t += 16; s.frame(t, 1); }
    t += 5000; s.frame(t, 1);            // a pause: not a frame
    for (let i = 0; i < 30; i++) { t += 8; s.frame(t, 1); }
    const r = s.summary();
    expect(r.frames).toBe(10);
    expect(r.maxMs).toBe(8);
    expect(r.over20).toBe(0);
  });

  it('detects the refresh rate from the fastest sustained interval, and keeps it through jank', () => {
    const s = new ShellFrameStats(60);
    let t = 0;
    s.frame(t, 1);
    for (let i = 0; i < 60; i++) { t += 8.33; s.frame(t, 1); }
    expect(s.summary().refreshHz).toBe(120);
    for (let i = 0; i < 60; i++) { t += 33; s.frame(t, 1); }   // a slow stretch must not lower the detected rate
    expect(s.summary().refreshHz).toBe(120);
    s.gpu(4.2, 'timestamp');
    expect(s.summary()).toMatchObject({ gpuMs: 4.2, gpuSource: 'timestamp' });
  });

  it('snapRefreshRate', () => {
    expect(snapRefreshRate(16.7)).toBe(60);
    expect(snapRefreshRate(11.1)).toBe(90);
    expect(snapRefreshRate(8.3)).toBe(120);
    expect(snapRefreshRate(6.95)).toBe(144);
    expect(snapRefreshRate(0)).toBe(0);
  });

  it('HUD lines carry every number the tablet check needs', () => {
    const s = new ShellFrameStats(30);
    let t = 0; s.frame(t, 1);
    for (let i = 0; i < 30; i++) { t += 16.6; s.frame(t, 2.5); }
    s.gpu(6.25, 'estimate');
    const text = formatShellHud(s.summary(), 1800, 1200, 1200, ['extra']).join('\n');
    expect(text).toContain('rAF 16.6 avg');
    expect(text).toContain('p95');
    expect(text).toContain('>20ms 0/30');
    expect(text).toContain('refresh 60 Hz');
    expect(text).toContain('render CPU 2.5 avg');
    expect(text).toContain('GPU 6.3 ms (est)');
    expect(text).toContain('backing 1800x1200  (x1.50)');
    expect(text).toContain('extra');
  });
});

describe('Shell frame structure (source guards)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const renderer = readFileSync(join(here, 'shell-renderer.ts'), 'utf8');
  const cartridge = readFileSync(join(here, 'shell-cartridge.ts'), 'utf8');

  it('the frame is ONE render pass: the renderer opens the frame pass + the two bake passes, the viewer none', () => {
    expect(renderer.match(/beginRenderPass\(/g)?.length).toBe(3);   // panel bake, grain bake, the frame
    expect(cartridge.match(/beginRenderPass\(/g)).toBeNull();
    // one depth attachment, cleared once and discarded
    expect(renderer.match(/depthStencilAttachment/g)?.length).toBe(1);
    expect(renderer).toContain("depthLoadOp: 'clear', depthStoreOp: 'discard'");
  });

  it('3D draws keep the full depth range (the old depth values); the tile batch resets depth where the hero drew', () => {
    const viewports = cartridge.match(/pass\.setViewport\([^)]*\)/g) ?? [];
    expect(viewports.length).toBe(6);   // render, loading dots, disc, CD, billboard + the depth reset
    for (const v of viewports) expect(v.endsWith(', 0, 1)'), v).toBe(true);
    expect(cartridge).toContain("depthStencil: { format: SHELL_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' }");
    expect(cartridge).toContain('writeMask: 0');
    expect(renderer).toContain('this.viewer.resetDepth(pass, w, h, 0, 0, w, heroDepthBottom)');
    // …and the renderer puts the full-canvas viewport back after the hero and after the tile batch
    expect(renderer.match(/pass\.setViewport\(0, 0, w, h, 0, 1\)/g)?.length).toBe(2);
    expect(renderer).toContain('pass.setScissorRect(0, 0, w, h)');
  });

  it('every on-screen pipeline is created through pipe() (cached per device, with the 2D depth state)', () => {
    expect(renderer).not.toMatch(/this\.device\.createRenderPipeline\(\{/);
    expect(renderer).toContain("depthWriteEnabled: false, depthCompare: 'always'");
  });

  it('WGSL: no backticks inside the shader sources, and the specks sit behind the grid mask', () => {
    for (const src of [renderer, cartridge]) {
      const shaders = src.match(/\/\* wgsl \*\/ `[\s\S]*?`;/g) ?? [];
      expect(shaders.length).toBeGreaterThan(3);
      for (const sh of shaders) expect(sh.slice(sh.indexOf('`') + 1, sh.lastIndexOf('`')).includes('`')).toBe(false);
    }
    const fs = renderer.slice(renderer.indexOf('let gm = gridMask(in.uv);'));
    expect(fs.indexOf('if (gm > 0.0 && bg.time.w < 0.5)')).toBeGreaterThan(0);
    expect(fs.indexOf('specks(in.uv, aspect, t) * gm')).toBeGreaterThan(fs.indexOf('if (gm > 0.0'));
  });
});
