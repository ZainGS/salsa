import { describe, it, expect, vi } from 'vitest';

// Node test env: GPU enums the paint-engine constructors read + a minimal DOM for the pane canvas.
const g = globalThis as Record<string, unknown>;
g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, VERTEX: 32, INDEX: 16 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.document ??= {
  createElement: () => ({
    width: 0, height: 0, style: {},
    getContext: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
};

import { UVPaintController, PaneReadbackGate } from './uv-paint-controller';
import { UVEditorSession } from './uv-canvas-renderer';
import type { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { PointerInput } from '../../renderer/raster/brushes/brush-engine';

/** Permissive callable proxy for GPU objects whose behaviour is irrelevant here (the engine calls are stubbed). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const permissive: any = new Proxy(function () { /* callable */ }, {
  get: (_t, p) => (p === 'then' ? undefined : permissive),
  apply: () => permissive,
});

describe('S3 PaneReadbackGate (UV pane readback throttle)', () => {
  it('outside a stroke every request is a FULL read, started at once; one in flight, the rest coalesce', () => {
    const gate = new PaneReadbackGate();
    expect(gate.poll(0, false)).toBeNull();                       // nothing wanted
    gate.want(false);
    expect(gate.poll(0, false)).toEqual({ start: 'full' });
    gate.want(false); gate.want(false);
    expect(gate.poll(1, false)).toBeNull();                       // in flight
    gate.done();
    expect(gate.poll(2, false)).toEqual({ start: 'full' });       // the coalesced follow-up: ONE read
    gate.done();
    expect(gate.poll(3, false)).toBeNull();
  });

  it('mid-stroke: region reads at most every STROKE_INTERVAL_MS (~9 Hz)', () => {
    const gate = new PaneReadbackGate();
    const T = PaneReadbackGate.STROKE_INTERVAL_MS;
    gate.want(false);
    expect(gate.poll(1000, true)).toEqual({ start: 'rect' });
    gate.done();
    gate.want(false);
    expect(gate.poll(1000 + 30, true)).toEqual({ waitMs: T - 30 });
    expect(gate.poll(1000 + T, true)).toEqual({ start: 'rect' });
    gate.done();
    // 60 dab frames over one second → at most ~1000 / T reads.
    let reads = 0;
    for (let t = 2000; t < 3000; t += 16) {
      gate.want(false);
      const r = gate.poll(t, true);
      if (r && 'start' in r) { reads++; gate.done(); }
    }
    expect(reads).toBeLessThanOrEqual(Math.ceil(1000 / T));
    expect(reads).toBeGreaterThanOrEqual(Math.floor(1000 / T) - 1);
  });

  it('a FULL request (stroke end) is never delayed, and a pending full wins over a region read', () => {
    const gate = new PaneReadbackGate();
    gate.want(false);
    expect(gate.poll(0, true)).toEqual({ start: 'rect' });
    gate.done();
    gate.want(false);
    gate.want(true);
    expect(gate.poll(5, true)).toEqual({ start: 'full' });
  });

  it('reset drops queued requests but keeps an in-flight read tracked (an old read never lands after a newer one)', () => {
    const gate = new PaneReadbackGate();
    gate.want(true);
    expect(gate.poll(0, false)).toEqual({ start: 'full' });
    gate.want(true);
    gate.reset();
    gate.want(true);                                              // the next session's first read…
    expect(gate.poll(1, false)).toBeNull();                       // …waits for the old one
    gate.done();
    expect(gate.poll(2, false)).toEqual({ start: 'full' });
  });
});

// ── S2 / S7 / P1: the controller's per-frame dab drain (engine calls stubbed) ───────────────────────────────────────

function makeController(withFrameHooks = true) {
  const hooks: Array<() => boolean> = [];
  const c = new UVPaintController(permissive as GPUDevice, () => {}, withFrameHooks ? {
    add: (cb) => { if (!hooks.includes(cb)) hooks.push(cb); },
    remove: (cb) => { const i = hooks.indexOf(cb); if (i >= 0) hooks.splice(i, 1); },
  } : null);
  const engine = c.getEngine();
  const log: Array<[string, unknown?]> = [];
  vi.spyOn(engine, 'beginStroke').mockImplementation((p: PointerInput, o?: { pointerType?: string }) => { log.push(['begin', { x: p.x, pt: o?.pointerType }]); });
  vi.spyOn(engine, 'addStrokePoints').mockImplementation((pts: readonly PointerInput[]) => { log.push(['points', pts.map(p => p.x)]); });
  vi.spyOn(engine, 'addStrokePoint').mockImplementation(() => { log.push(['point']); });
  vi.spyOn(engine, 'endStroke').mockImplementation(async () => { log.push(['end']); return null; });
  vi.spyOn(engine, 'cancelStroke').mockImplementation(() => { log.push(['cancel']); return true; });
  vi.spyOn(engine, 'setSizeScale').mockImplementation((s: number) => { log.push(['scale', s]); });
  vi.spyOn(engine, 'beginDabBatch').mockImplementation(() => { log.push(['batch{']); });
  vi.spyOn(engine, 'endDabBatch').mockImplementation(() => { log.push(['}batch']); });
  vi.spyOn(engine, 'setActiveTexture').mockImplementation(() => {});
  vi.spyOn(engine, 'initializeSnapshots').mockImplementation(async () => {});
  const lift = vi.spyOn(engine, 'liftStroke').mockImplementation((_a: PointerInput, b: PointerInput) => { log.push(['lift', b.x]); return true; });
  const tex = { width: 100, height: 100 };
  const texMgr = { getTexture: () => tex, getTextureSize: () => ({ w: 100, h: 100 }) } as unknown as RasterTextureManager;
  c.enter({ mesh: { id: 'm' } as unknown as Mesh3D, texMgr, session: new UVEditorSession('m'), uvRenderer: null, canvas: null });
  const frame = () => hooks.slice().forEach((h) => h());
  return { c, log, frame, hooks, lift };
}

describe('S2 UVPaintController: one dab batch per frame', () => {
  it('moves are queued and stamped once per frame through addStrokePoints (one batch), with the event timestamps', () => {
    const { c, log, frame, hooks } = makeController();
    c.strokeBeginUV(0.1, 0.1, 1, 1, { pointerType: 'touch', timestamp: 100 });
    expect(log.find((l) => l[0] === 'begin')).toEqual(['begin', { x: 10, pt: 'touch' }]);   // S1: pointerType threaded
    expect(hooks).toHaveLength(1);
    log.length = 0;
    c.strokeMoveUV(0.11, 0.1, 1, 1, 116);
    c.strokeMoveUV(0.12, 0.1, 1, 1, 120);
    c.strokeMoveUV(0.13, 0.1, 1, 1, 124);
    expect(log).toHaveLength(0);                                  // nothing stamped before the frame
    frame();
    expect(log).toEqual([['batch{'], ['points', [11, 12, 13]], ['}batch']]);
    c.strokeEndUV(200);
    expect(log[log.length - 1]).toEqual(['end']);
    expect(hooks).toHaveLength(0);                                // drain unhooked at stroke end
  });

  it('a size-scale change splits the frame into addStrokePoints runs inside ONE batch', () => {
    const { c, log, frame } = makeController();
    c.strokeBeginUV(0.1, 0.1, 1, 1);
    log.length = 0;
    c.strokeMoveUV(0.11, 0.1, 1, 1);
    c.strokeMoveUV(0.12, 0.1, 1, 2);
    c.strokeMoveUV(0.13, 0.1, 1, 2);
    frame();
    expect(log).toEqual([['batch{'], ['points', [11]], ['scale', 2], ['points', [12, 13]], ['}batch']]);
  });

  it('S7: a seam jump inside a frame LIFTS the brush in the same stroke (no end / restart, per-sample check)', () => {
    const { c, log, frame } = makeController();
    c.strokeBeginUV(0.1, 0.1, 1, 1);
    log.length = 0;
    c.strokeMoveUV(0.12, 0.1, 1, 1);
    c.strokeMoveUV(0.8, 0.8, 1, 1);    // jump → lift
    c.strokeMoveUV(0.81, 0.8, 1, 1);
    frame();
    expect(log).toEqual([['batch{'], ['points', [12]], ['lift', 80], ['points', [81]], ['}batch']]);
    expect(log.some((l) => l[0] === 'end' || l[0] === 'begin')).toBe(false);
  });

  it('S7 fallback: a preset that cannot lift ends + restarts on the new island (without the brush mirror)', () => {
    const { c, log, frame, lift } = makeController();
    lift.mockImplementation(() => false);
    let mirrors = 0;
    c.beforeStroke = () => { mirrors++; };
    c.strokeBeginUV(0.1, 0.1, 1, 1);
    expect(mirrors).toBe(1);
    log.length = 0;
    c.strokeMoveUV(0.8, 0.8, 1, 1);
    c.strokeMoveUV(0.81, 0.8, 1, 1);
    frame();
    const kinds = log.map((l) => l[0]);
    expect(kinds).toContain('end');
    expect(kinds).toContain('begin');
    expect(kinds.indexOf('end')).toBeLessThan(kinds.indexOf('begin'));
    expect(log[log.length - 2]).toEqual(['points', [81]]);
    expect(mirrors).toBe(1);                                      // the restart skipped beforeStroke (no preset JSON clone)
  });

  it('without a frame loop every sample stamps at once (still through addStrokePoints)', () => {
    const { c, log } = makeController(false);
    c.strokeBeginUV(0.1, 0.1, 1, 1);
    log.length = 0;
    c.strokeMoveUV(0.11, 0.1, 1, 1);
    expect(log).toEqual([['batch{'], ['points', [11]], ['}batch']]);
  });

  it('the stroke end stamps the queue first; a cancel drops it and restores (no end / undo patch)', () => {
    const a = makeController();
    a.c.strokeBeginUV(0.1, 0.1, 1, 1);
    a.log.length = 0;
    a.c.strokeMoveUV(0.11, 0.1, 1, 1);
    a.c.strokeEndUV();
    expect(a.log.map((l) => l[0])).toEqual(['batch{', 'points', '}batch', 'scale', 'end']);

    const b = makeController();
    let ends = 0;
    b.c.onStrokeEnd = () => { ends++; };
    b.c.strokeBeginUV(0.1, 0.1, 1, 1);
    b.log.length = 0;
    b.c.strokeMoveUV(0.11, 0.1, 1, 1);
    b.c.strokeCancelUV();
    b.frame();
    expect(b.log.map((l) => l[0])).toEqual(['scale', 'cancel']);
    expect(b.c.isDrawing()).toBe(false);
    expect(ends).toBe(1);                                         // the live-texture link / package composite refresh
    expect(b.hooks).toHaveLength(0);
  });

  it('timestamps stay non-decreasing within a stroke', () => {
    const { c, frame } = makeController();
    const pts: number[] = [];
    vi.spyOn(c.getEngine(), 'addStrokePoints').mockImplementation((p: readonly PointerInput[]) => { pts.push(...p.map(q => q.timestamp)); });
    c.strokeBeginUV(0.1, 0.1, 1, 1, { timestamp: 500 });
    c.strokeMoveUV(0.11, 0.1, 1, 1, 520);
    c.strokeMoveUV(0.12, 0.1, 1, 1, 510);   // out of order (coalesced from another source)
    frame();
    expect(pts).toEqual([520, 520]);
  });
});
