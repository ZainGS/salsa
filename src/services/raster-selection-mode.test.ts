/**
 * Selection New / Add / Subtract (UI audit 2026-10-09): the magic wand's own mode reaches the engine, Shift = add and
 * Alt = subtract on any selection press, and an Add / Subtract press builds onto the selection instead of grabbing it.
 */
import { describe, it, expect, vi } from 'vitest';
import { RasterSelectionService, resolveSelectionMode } from './raster-selection-service';

type Handler = (e: any) => unknown;

function setup(state: { hasSelection?: boolean } = {}) {
  const listeners = new Map<string, Handler[]>();
  const canvas = {
    width: 100, height: 100, style: {} as any,
    addEventListener: (t: string, h: Handler) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    removeEventListener: (t: string, h: Handler) => { listeners.set(t, (listeners.get(t) ?? []).filter(x => x !== h)); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  const fire = async (type: string, e: any) => {
    for (const h of listeners.get(type) ?? []) await h({ button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...e });
  };
  const interactionService = { canvas, toWorldCoords: (e: any) => ({ x: e.clientX / 50 - 1, y: 1 - e.clientY / 50 }) };
  const engine: any = {
    dragPreview: null, dragLassoPoints: null, selectionTool: 'rect',
    getSelectionInfo: () => ({
      hasSelection: !!state.hasSelection, bounds: state.hasSelection ? { x: 20, y: 20, w: 40, h: 40 } : null,
      isTransforming: false, transform: null, dragPreview: null, tool: 'rect', lassoPoints: null,
    }),
    selectRect: vi.fn(async () => {}), selectEllipse: vi.fn(async () => {}), selectLasso: vi.fn(async () => {}),
    selectMagicWand: vi.fn(async () => {}), deselectAll: vi.fn(async () => {}),
    commitTransform: vi.fn(async () => {}), beginTransform: vi.fn(async () => {}), updateTransform: vi.fn(),
  };
  const renderer: any = {
    rasterSelectionEngine: engine,
    getRasterTextureSize: () => ({ w: 100, h: 100 }),
    getIllustrationMode: () => false, getIllustrationBounds: () => null, scheduleRender: () => {},
  };
  const svc = new RasterSelectionService(interactionService as any, renderer);
  svc.enable();
  const click = async (x: number, y: number, mods: any = {}) => {
    await fire('pointerdown', { clientX: x, clientY: y, ...mods });
    await fire('pointerup', { clientX: x, clientY: y, buttons: 0, ...mods });
  };
  const drag = async (x0: number, y0: number, x1: number, y1: number, mods: any = {}) => {
    await fire('pointerdown', { clientX: x0, clientY: y0, ...mods });
    await fire('pointermove', { clientX: x1, clientY: y1, ...mods });
    await fire('pointerup', { clientX: x1, clientY: y1, buttons: 0, ...mods });
  };
  return { svc, engine, click, drag };
}

describe('resolveSelectionMode', () => {
  it('Alt = subtract, Shift = add, else the wand mode (wand only), else the shared mode', () => {
    expect(resolveSelectionMode('rect', { altKey: true }, 'new')).toBe('subtract');
    expect(resolveSelectionMode('rect', { altKey: true, shiftKey: true }, 'add')).toBe('subtract');
    expect(resolveSelectionMode('lasso', { shiftKey: true }, 'new')).toBe('add');
    expect(resolveSelectionMode('magic-wand', {}, 'new', 'subtract')).toBe('subtract');
    expect(resolveSelectionMode('rect', {}, 'new', 'subtract')).toBe('new');   // the wand mode is the wand's own
    expect(resolveSelectionMode('magic-wand', {}, 'add')).toBe('add');
  });
});

describe('RasterSelectionService modes', () => {
  it('the wand mode from setMagicWandOptions reaches selectMagicWand', async () => {
    const t = setup();
    t.svc.setTool('magic-wand');
    await t.click(30, 30);
    expect(t.engine.selectMagicWand).toHaveBeenLastCalledWith(30, 30, 32, true, 'new', undefined);
    t.svc.setMagicWandOptions({ mode: 'add' });
    await t.click(40, 40);
    expect(t.engine.selectMagicWand).toHaveBeenLastCalledWith(40, 40, 32, true, 'add', undefined);
    t.svc.setMagicWandOptions({ tolerance: 10 });   // other options leave the mode alone
    await t.click(41, 41);
    expect(t.engine.selectMagicWand).toHaveBeenLastCalledWith(41, 41, 10, true, 'add', undefined);
  });

  it('Shift / Alt on a wand click override its mode for that click', async () => {
    const t = setup();
    t.svc.setTool('magic-wand');
    await t.click(10, 10, { shiftKey: true });
    expect(t.engine.selectMagicWand.mock.calls[0][4]).toBe('add');
    await t.click(10, 10, { altKey: true });
    expect(t.engine.selectMagicWand.mock.calls[1][4]).toBe('subtract');
    await t.click(10, 10);
    expect(t.engine.selectMagicWand.mock.calls[2][4]).toBe('new');
  });

  it('wand Add / Subtract inside an existing selection selects (no transform grab); New inside still grabs it', async () => {
    const t = setup({ hasSelection: true });
    t.svc.setTool('magic-wand');
    t.svc.setMagicWandOptions({ mode: 'subtract' });
    await t.click(30, 30);
    expect(t.engine.beginTransform).not.toHaveBeenCalled();
    expect(t.engine.selectMagicWand).toHaveBeenCalledWith(30, 30, 32, true, 'subtract', undefined);
    t.svc.setMagicWandOptions({ mode: 'new' });
    await t.click(30, 30);
    expect(t.engine.beginTransform).toHaveBeenCalledTimes(1);
  });

  it('marquee: Shift-drag adds, Alt-drag subtracts; an Add / Subtract click without a drag does not deselect', async () => {
    const t = setup({ hasSelection: true });
    await t.drag(70, 70, 90, 90, { shiftKey: true });
    expect(t.engine.selectRect).toHaveBeenLastCalledWith({ x: 70, y: 70, w: 20, h: 20 }, 0, 'add');
    await t.drag(25, 25, 35, 35, { altKey: true });   // starts inside the selection: still a marquee
    expect(t.engine.beginTransform).not.toHaveBeenCalled();
    expect(t.engine.selectRect).toHaveBeenLastCalledWith({ x: 25, y: 25, w: 10, h: 10 }, 0, 'subtract');
    await t.click(90, 90, { shiftKey: true });
    expect(t.engine.deselectAll).not.toHaveBeenCalled();
    await t.click(90, 90);
    expect(t.engine.deselectAll).toHaveBeenCalledTimes(1);
  });

  it('Reference: None clears the reference texture (an explicit undefined used to keep the old one)', async () => {
    const t = setup();
    const tex = { label: 'ref' } as unknown as GPUTexture;
    t.svc.setMagicWandOptions({ referenceLayerTexture: tex });
    t.svc.setMagicWandOptions({ tolerance: 5 });
    expect(t.svc.getMagicWandOptions().referenceLayerTexture).toBe(tex);
    t.svc.setMagicWandOptions({ referenceLayerTexture: undefined });
    expect(t.svc.getMagicWandOptions().referenceLayerTexture).toBeNull();
  });
});
