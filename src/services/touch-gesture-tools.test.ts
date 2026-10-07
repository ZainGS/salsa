/**
 * TOUCH-5 (docs/ui/touch-controls.md): the other one-finger 2D tools a pinch used to leave a mark with —
 *  - raster SELECTION (marquee / lasso / transform drag): a finger press waits for 8 px of movement (a tap is still a
 *    click); a second finger drops the marquee / lasso or puts the transform back, and never deselects or commits;
 *  - raster MOVE: a finger press takes no snapshot until it moves 8 px; a second finger puts the layer back;
 *  - vector SCRIBBLE ERASER: a second finger puts back what the finger erase removed; other fingers never erase.
 * Mouse / pen behaviour is unchanged.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { RasterSelectionService } from './raster-selection-service';
import { RasterMoveService } from './raster-move-service';
import { EraserService } from './drawing/eraser-service';
import { mat4 } from 'gl-matrix';
import { installGpuGlobals } from '../renderer/raster/cpu-gpu-mirror';

beforeAll(() => installGpuGlobals());   // GPUTextureUsage etc. (the move tool's staging texture)

afterEach(() => { vi.unstubAllGlobals(); });

type Handler = (e: any) => unknown;

function makeCanvas() {
  const listeners = new Map<string, Handler[]>();
  const canvas = {
    width: 100, height: 100, style: {} as any,
    addEventListener: (t: string, h: Handler) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    removeEventListener: (t: string, h: Handler) => { listeners.set(t, (listeners.get(t) ?? []).filter(x => x !== h)); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  const fire = async (type: string, e: any) => {
    for (const h of listeners.get(type) ?? []) {
      await h({ button: 0, buttons: 1, pointerId: 1, pointerType: 'touch', isPrimary: true, ...e });
    }
  };
  return { canvas, fire };
}

const f = (id: number, x: number, y: number, extra: any = {}) => ({ pointerId: id, clientX: x, clientY: y, offsetX: x, offsetY: y, isPrimary: id === 1, ...extra });
const up = (id: number, x: number, y: number) => f(id, x, y, { buttons: 0 });

// ── Raster selection ──

function selectionSetup(state: { hasSelection?: boolean; transforming?: boolean } = {}) {
  const { canvas, fire } = makeCanvas();
  const interactionService = {
    canvas,
    toWorldCoords: (e: any) => ({ x: e.clientX / 50 - 1, y: 1 - e.clientY / 50 }),   // 100 CSS px → 100 texels
  };
  let transforming = !!state.transforming;
  let transform = { translateX: 5, translateY: 6, scaleX: 1, scaleY: 1, rotation: 0 };
  const engine: any = {
    dragPreview: null, dragLassoPoints: null, selectionTool: 'rect',
    getSelectionInfo: () => ({
      hasSelection: !!state.hasSelection || transforming, bounds: (state.hasSelection || transforming) ? { x: 20, y: 20, w: 40, h: 40 } : null,
      isTransforming: transforming, transform: transforming ? { ...transform } : null, dragPreview: null, tool: 'rect', lassoPoints: null,
    }),
    selectRect: vi.fn(async () => {}), selectEllipse: vi.fn(async () => {}), selectLasso: vi.fn(async () => {}),
    selectMagicWand: vi.fn(async () => {}), deselectAll: vi.fn(async () => {}),
    commitTransform: vi.fn(async () => { transforming = false; }),
    beginTransform: vi.fn(async () => { transforming = true; transform = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 }; }),
    updateTransform: vi.fn((dx: number, dy: number, sx?: number, sy?: number, rot?: number) => {
      transform = { translateX: dx, translateY: dy, scaleX: sx ?? transform.scaleX, scaleY: sy ?? transform.scaleY, rotation: rot ?? transform.rotation };
    }),
  };
  const renderer: any = {
    rasterSelectionEngine: engine,
    getRasterTextureSize: () => ({ w: 100, h: 100 }),
    getIllustrationMode: () => false, getIllustrationBounds: () => null, scheduleRender: () => {},
  };
  const svc = new RasterSelectionService(interactionService as any, renderer);
  svc.enable();
  return { svc, fire, engine, get transform() { return transform; } };
}

describe('TOUCH-5 raster selection', () => {
  it('a one-finger marquee drag still selects; a finger tap still deselects (the click it always was)', async () => {
    const t = selectionSetup();
    await t.fire('pointerdown', f(1, 25, 25));
    await t.fire('pointermove', f(1, 28, 27));                // < 8 px: nothing yet
    expect(t.engine.dragPreview).toBeNull();
    await t.fire('pointermove', f(1, 50, 50));
    expect(t.engine.dragPreview).toEqual({ x: 25, y: 25, w: 25, h: 25 });
    await t.fire('pointerup', up(1, 75, 75));
    expect(t.engine.selectRect).toHaveBeenCalledWith({ x: 25, y: 25, w: 50, h: 50 }, 0, 'new');
    const tap = selectionSetup({ hasSelection: true });
    await tap.fire('pointerdown', f(1, 90, 90));
    await tap.fire('pointerup', up(1, 90, 90));
    expect(tap.engine.deselectAll).toHaveBeenCalledTimes(1);
  });

  it('a pinch (2nd finger before or after the drag started) leaves no marquee and no deselect', async () => {
    for (const early of [true, false]) {
      const t = selectionSetup({ hasSelection: true });
      await t.fire('pointerdown', f(1, 70, 70));
      if (!early) await t.fire('pointermove', f(1, 80, 85));
      await t.fire('pointerdown', f(2, 10, 10));
      for (let i = 1; i <= 3; i++) { await t.fire('pointermove', f(1, 80 + i * 4, 85)); await t.fire('pointermove', f(2, 10 - i * 2, 10)); }
      await t.fire('pointerup', up(1, 92, 85));
      await t.fire('pointerup', up(2, 4, 10));
      expect(t.engine.selectRect).not.toHaveBeenCalled();
      expect(t.engine.deselectAll).not.toHaveBeenCalled();
      expect(t.engine.dragPreview).toBeNull();
    }
  });

  it('a lasso cut short by a pinch is dropped', async () => {
    const t = selectionSetup();
    t.svc.setTool('lasso');
    await t.fire('pointerdown', f(1, 10, 10));
    for (let i = 1; i <= 4; i++) await t.fire('pointermove', f(1, 10 + i * 9, 10 + i * 5));
    expect(t.engine.dragLassoPoints?.length).toBeGreaterThan(2);
    await t.fire('pointerdown', f(2, 80, 80));
    expect(t.engine.dragLassoPoints).toBeNull();
    await t.fire('pointerup', up(1, 46, 30));
    await t.fire('pointerup', up(2, 80, 80));
    expect(t.engine.selectLasso).not.toHaveBeenCalled();
  });

  it('a transform drag interrupted by a 2nd finger goes back to where it started; a pinch outside never commits', async () => {
    const t = selectionSetup({ transforming: true });
    await t.fire('pointerdown', f(1, 40, 40));                 // inside the (translated) box
    await t.fire('pointermove', f(1, 60, 50));
    expect(t.transform.translateX).toBe(25);
    await t.fire('pointerdown', f(2, 90, 90));
    expect(t.transform).toEqual({ translateX: 5, translateY: 6, scaleX: 1, scaleY: 1, rotation: 0 });
    await t.fire('pointermove', f(1, 70, 70));
    expect(t.transform.translateX).toBe(5);                    // the rest of the pinch moves nothing
    await t.fire('pointerup', up(1, 70, 70));
    await t.fire('pointerup', up(2, 90, 90));
    const outside = selectionSetup({ transforming: true });
    await outside.fire('pointerdown', f(1, 95, 5));
    await outside.fire('pointerdown', f(2, 50, 95));
    await outside.fire('pointerup', up(1, 95, 5));
    await outside.fire('pointerup', up(2, 50, 95));
    expect(outside.engine.commitTransform).not.toHaveBeenCalled();
  });

  it('mouse: unchanged (a press outside a transform commits at once)', async () => {
    const t = selectionSetup({ transforming: true });
    await t.fire('pointerdown', f(1, 95, 5, { pointerType: 'mouse' }));
    expect(t.engine.commitTransform).toHaveBeenCalledTimes(1);
  });
});

// ── Raster move ──

function moveSetup() {
  const { canvas, fire } = makeCanvas();
  const interactionService = { canvas, toWorldCoords: (e: any) => ({ x: e.clientX / 50 - 1, y: 1 - e.clientY / 50 }) };
  const tex = { width: 100, height: 100 };
  const device: any = {
    createTexture: () => ({ destroy: () => {} }),
    createCommandEncoder: () => ({ copyTextureToTexture: () => {}, finish: () => ({}) }),
    queue: { submit: () => {} },
  };
  const layerMgr = { getSelectedLayerId: () => 'L1', pushSnapshotForLayer: vi.fn() };
  const renderer: any = {
    getDevice: () => device,
    rasterPaintEngine: { getActiveTexture: () => tex, snapshotManager: { pushSnapshot: vi.fn(async () => {}) } },
    rasterLayerManager: layerMgr,
    getRasterTextureSize: () => ({ w: 100, h: 100 }),
    getIllustrationMode: () => false, getIllustrationBounds: () => null, scheduleRender: () => {},
  };
  const svc = new RasterMoveService(interactionService as any, renderer);
  const offsets: Array<[number, number]> = [];
  (svc as any).applyOffset = (_d: unknown, _t: unknown, dx: number, dy: number) => { offsets.push([dx, dy]); };
  svc.enable();
  return { svc, fire, offsets, layerMgr };
}

describe('TOUCH-5 raster move', () => {
  it('a finger tap moves nothing and leaves no undo entry; a finger drag moves the layer', async () => {
    const t = moveSetup();
    await t.fire('pointerdown', f(1, 30, 30));
    await t.fire('pointerup', up(1, 31, 30));
    expect(t.layerMgr.pushSnapshotForLayer).not.toHaveBeenCalled();
    await t.fire('pointerdown', f(1, 30, 30));
    await t.fire('pointermove', f(1, 34, 30));
    expect(t.offsets.length).toBe(0);
    await t.fire('pointermove', f(1, 50, 40));
    expect(t.layerMgr.pushSnapshotForLayer).toHaveBeenCalledTimes(1);
    expect(t.offsets.at(-1)).toEqual([20, 10]);
    await t.fire('pointerup', up(1, 50, 40));
  });

  it('a second finger: before the drag nothing happens; during it the layer goes back to offset 0', async () => {
    const early = moveSetup();
    await early.fire('pointerdown', f(1, 30, 30));
    await early.fire('pointerdown', f(2, 80, 80));
    await early.fire('pointermove', f(1, 60, 30));
    expect(early.offsets.length).toBe(0);
    expect(early.layerMgr.pushSnapshotForLayer).not.toHaveBeenCalled();
    const late = moveSetup();
    await late.fire('pointerdown', f(1, 30, 30));
    await late.fire('pointermove', f(1, 50, 30));
    await late.fire('pointerdown', f(2, 80, 80));
    expect(late.offsets.at(-1)).toEqual([0, 0]);
    const n = late.offsets.length;
    await late.fire('pointermove', f(1, 70, 30));
    expect(late.offsets.length).toBe(n);
  });

  it('mouse: unchanged (the snapshot is taken on press)', async () => {
    const t = moveSetup();
    await t.fire('pointerdown', f(1, 30, 30, { pointerType: 'mouse' }));
    expect(t.layerMgr.pushSnapshotForLayer).toHaveBeenCalledTimes(1);
  });
});

// ── Vector scribble eraser ──

function eraserSetup() {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1; });
  const { canvas, fire } = makeCanvas();
  let interactive = 0;
  const changed = vi.fn();
  const interactionService = {
    canvas, updateWorldMatrix: () => {}, requestRender: () => {},
    beginInteractive: () => { interactive++; }, endInteractive: () => { interactive--; },
    toWorldCoordsFromCanvas: (x: number, y: number) => ({ x, y }),
    onSceneGraphChanged: { emit: changed },
  };
  const root: any = {
    children: [] as any[],
    addChild(n: any) { n.parent = this; this.children.push(n); },
    removeChild(n: any) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parent = null; },
  };
  const mk = (name: string, x0: number, x1: number) => ({
    name, visible: true, parent: null as any, localMatrix: mat4.create(),
    intersectsLine: (ax: number, _ay: number, bx: number) => Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1,
    containsPoint: () => false,
  });
  const a = mk('a', 10, 20), b = mk('b', 40, 50), c = mk('c', 70, 80);
  for (const s of [a, b, c]) root.addChild(s);
  const svc = new EraserService(interactionService as any, { root } as any, {} as any, {} as any);
  svc.scribbles = [a, b, c] as any;
  svc.enable();
  return { svc, fire, root, a, b, c, changed, get interactive() { return interactive; } };
}

describe('TOUCH-5 scribble eraser', () => {
  it('a second finger puts back what the finger erase removed, in the same draw order', async () => {
    const t = eraserSetup();
    await t.fire('pointerdown', f(1, 5, 5));
    await t.fire('pointermove', f(1, 15, 5));                  // crosses a
    await t.fire('pointermove', f(1, 45, 5));                  // crosses b
    expect(t.root.children.map((n: any) => n.name)).toEqual(['c']);
    await t.fire('pointerdown', f(2, 90, 90));
    expect(t.root.children.map((n: any) => n.name)).toEqual(['a', 'b', 'c']);
    expect(t.svc.scribbles.length).toBe(3);
    expect(t.interactive).toBe(0);
    await t.fire('pointermove', f(1, 75, 5));                  // the pinch: nothing erased
    await t.fire('pointerup', up(1, 75, 5));
    await t.fire('pointerup', up(2, 90, 90));
    expect(t.root.children.length).toBe(3);
    expect(t.interactive).toBe(0);
  });

  it('only the erasing finger erases; a pointerup with no erase running returns no lease', async () => {
    const t = eraserSetup();
    await t.fire('pointerup', up(1, 0, 0));                    // e.g. another tool's click
    expect(t.interactive).toBe(0);
    await t.fire('pointerdown', f(1, 5, 5));
    await t.fire('pointerdown', f(3, 5, 50, { isPrimary: false, pointerType: 'pen' }));   // (a pen never cancels)
    await t.fire('pointermove', f(3, 75, 50, { pointerType: 'pen' }));
    expect(t.root.children.length).toBe(3);
    await t.fire('pointermove', f(1, 15, 5));
    await t.fire('pointerup', up(1, 15, 5));
    expect(t.root.children.map((n: any) => n.name)).toEqual(['b', 'c']);
    expect(t.interactive).toBe(0);
  });
});

// ── Raster text ──

describe('TOUCH-5 raster text', () => {
  async function textSetup() {
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    const { RasterTextService } = await import('./raster-text-service');
    const { canvas, fire } = makeCanvas();
    const interactionService = { canvas, clearSelectedNodes: () => {}, toWorldCoords: (e: any) => ({ x: e.clientX / 50 - 1, y: 1 - e.clientY / 50 }) };
    const renderer: any = { getRasterTextureSize: () => ({ w: 100, h: 100 }), getIllustrationMode: () => false, getIllustrationBounds: () => null, scheduleRender: () => {} };
    const svc = new RasterTextService(interactionService as any, renderer);
    const commit = vi.fn();
    (svc as any).commit = commit;
    svc.enable();
    return { svc, fire, commit };
  }

  it('a finger tap places the text entry on lift; a pinch places nothing and commits nothing', async () => {
    const t = await textSetup();
    await t.fire('pointerdown', f(1, 25, 50));
    expect(t.svc.getState().isActive).toBe(false);
    await t.fire('pointerup', up(1, 26, 50));
    expect(t.svc.getState()).toMatchObject({ isActive: true, destX: 25, destY: 50 });
    // typing… then a pinch
    await t.fire('pointerdown', f(1, 75, 75));
    await t.fire('pointerdown', f(2, 10, 10));
    await t.fire('pointerup', up(1, 70, 70));
    await t.fire('pointerup', up(2, 12, 12));
    expect(t.commit).not.toHaveBeenCalled();
    expect(t.svc.getState()).toMatchObject({ isActive: true, destX: 25, destY: 50 });
  });

  it('mouse: unchanged (placed on press)', async () => {
    const t = await textSetup();
    await t.fire('pointerdown', f(1, 25, 50, { pointerType: 'mouse' }));
    expect(t.svc.getState()).toMatchObject({ isActive: true, destX: 25, destY: 50 });
  });
});
