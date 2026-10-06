/**
 * canvas-pixel-ratio.test.ts — pointer maths under a DPR-CAPPED backing store (mobile-parity TIER-1 / TOUCH-11).
 *
 * The mobile caps back a DPR-2 tablet canvas at 1.5 (1280 × 800 CSS → 1920 × 1200), so the backing ratio
 * (canvas.width / CSS width) ≠ window.devicePixelRatio. Every CSS ↔ canvas conversion must use the BACKING ratio:
 *  - canvasPixelRatio() / shellBackingRatio() return 1.5 here, not 2 (one shared rule);
 *  - a Pan-tool / middle-mouse / one-finger pan of N CSS px moves the content exactly N CSS px (it moved N / 1.5);
 *  - Ctrl+wheel and the two-finger pinch zoom around the pointer; the two-finger pan stays finger-locked;
 *  - a brush stroke, a 2D pick and an eraser hit land on what is DRAWN under the pointer;
 *  - a 3D ray from client coords goes through what is drawn under the pointer.
 * "Drawn under the pointer" is computed independently, the way the GPU does it: world → NDC (world matrix) →
 * BACKING px → CSS px (÷ backing ratio). Tolerances allow for gl-matrix's float32 matrices.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mat4, vec4, vec3 } from 'gl-matrix';
import { canvasPixelRatio } from './canvas-pixel-ratio';
import { shellBackingRatio } from '../shell/shell-backing';
import { canvasPxToWorld } from './handles';
import { RasterInteractionController } from '../core/raster-interaction-controller';
import { InteractionService } from '../../services/interaction-service';
import { RasterDrawingService } from '../../services/raster-drawing-service';
import { EraserService } from '../../services/drawing/eraser-service';
import { Node } from '../../scene-graph/shapes/base/node';
import { Camera3D } from '../3d/camera-3d';
import { MeshPicker } from '../3d/mesh-picker';
import type { WebGPURenderer } from '../core/webgpu-renderer';

afterEach(() => { vi.unstubAllGlobals(); });

type Handler = (e: any) => unknown;

/** A DPR-2 tablet under the mobile cap: 1280 × 800 CSS, backed at 1.5 → 1920 × 1200. `ox/oy` = the canvas's page offset. */
function cappedCanvas(css = { w: 1280, h: 800 }, backing = { w: 1920, h: 1200 }, ox = 0, oy = 0) {
  const listeners = new Map<string, Handler[]>();
  const canvas = {
    width: backing.w, height: backing.h, clientWidth: css.w, clientHeight: css.h, style: {},
    getBoundingClientRect: () => ({ left: ox, top: oy, width: css.w, height: css.h, right: ox + css.w, bottom: oy + css.h }),
    addEventListener: (t: string, h: Handler) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    removeEventListener: (t: string, h: Handler) => { listeners.set(t, (listeners.get(t) ?? []).filter(x => x !== h)); },
    setPointerCapture: () => {}, hasPointerCapture: () => true, releasePointerCapture: () => {},
  };
  const fire = async (type: string, e: any) => { for (const h of listeners.get(type) ?? []) await h(e); };
  return { canvas: canvas as unknown as HTMLCanvasElement, fire };
}

/** Where world (wx, wy) is DRAWN, in canvas-relative CSS px: world → NDC → backing px → CSS (÷ the backing ratio). */
function drawnAt(is: InteractionService, wx: number, wy: number): { x: number; y: number } {
  const c = is.canvas;
  const v = vec4.transformMat4(vec4.create(), vec4.fromValues(wx, wy, 0, 1), is.getWorldMatrix());
  const bx = (v[0] / v[3] + 1) / 2 * c.width, by = (1 - v[1] / v[3]) / 2 * c.height;
  return { x: bx / (c.width / c.clientWidth), y: by / (c.height / c.clientHeight) };
}

function controller(canvas: HTMLCanvasElement) {
  const is = new InteractionService(canvas);
  const r = {
    canvas, interactionService: is, mode: { kind: 'idle' }, illustrationMode: false, illustrationBounds: undefined,
    bgDirty: { matrix: false }, renderListDirty: false, backgroundPatternFixed: false, sceneGraph: { root: new Node() },
    scheduleRender: () => {},
    canvasPxToWorld: (x: number, y: number) => canvasPxToWorld(x, y, canvas, is),
    getRandomCursor: () => 'default',
    webGPURenderStrategy: { getLiveTextNodes: () => [] },
  };
  return { ctrl: new RasterInteractionController(r as unknown as WebGPURenderer), r, is };
}
const pev = (init: Record<string, unknown>): PointerEvent => ({
  pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 0, clientY: 0, shiftKey: false, preventDefault() {},
  ...init, offsetX: init.clientX ?? 0, offsetY: init.clientY ?? 0,
} as unknown as PointerEvent);

describe('canvasPixelRatio: the ACTUAL backing ratio, one rule for editor + Shell', () => {
  it('canvas 1920 wide, client 1280, window DPR 2 → 1.5 (not the DPR)', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const { canvas } = cappedCanvas();
    expect(canvasPixelRatio(canvas)).toBe(1.5);
    expect(shellBackingRatio(canvas, 2)).toBe(1.5);
    expect(canvasPixelRatio(canvas, 1, 1280)).toBe(1.5);           // an explicit CSS width (the event rect)
  });
  it('falls back to window.devicePixelRatio (or the given fallback) only before layout', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const unlaid = { width: 300, clientWidth: 0, getBoundingClientRect: () => ({ width: 0 }) };
    expect(canvasPixelRatio(unlaid)).toBe(2);
    expect(canvasPixelRatio(unlaid, 1.25)).toBe(1.25);
    expect(shellBackingRatio(unlaid as never)).toBe(1);            // the Shell's default fallback is unchanged
    expect(canvasPixelRatio(null)).toBe(2);
  });
  it('desktop (uncapped): backing == DPR, so the ratio IS the DPR', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(canvasPixelRatio(cappedCanvas({ w: 800, h: 600 }, { w: 1600, h: 1200 }).canvas)).toBe(2);
    expect(canvasPixelRatio(cappedCanvas({ w: 800, h: 600 }, { w: 800, h: 600 }).canvas)).toBe(1);
  });
});

describe('2D pan / zoom stay pointer-locked at backing 1.5 ≠ DPR 2', () => {
  for (const [label, init] of [
    ['Pan tool, mouse', { pointerType: 'mouse', button: 0 }],
    ['Pan tool, one finger', { pointerType: 'touch', button: 0 }],
    ['middle mouse', { pointerType: 'mouse', button: 1 }],
  ] as const) {
    it(`${label}: a drag of N CSS px moves the content exactly N CSS px`, () => {
      vi.stubGlobal('window', { devicePixelRatio: 2 });
      const { ctrl, r, is } = controller(cappedCanvas().canvas);
      is.isPanToolSelected = init.button === 0;
      is.setZoom(1.7);
      const grabbed = is.toWorldCoordsFromCanvas(300, 300);
      ctrl.handlePointerDown(pev({ ...init, clientX: 300, clientY: 300 }));
      expect(r.mode.kind).toBe('panning');
      ctrl.handlePointerMove(pev({ ...init, clientX: 340, clientY: 320 }));
      ctrl.handlePointerMove(pev({ ...init, clientX: 390, clientY: 270 }));
      const at = drawnAt(is, grabbed.x, grabbed.y);
      expect(at.x).toBeCloseTo(390, 3);                               // was 300 + 90 / 1.5 = 360 ("pans less")
      expect(at.y).toBeCloseTo(270, 3);
    });
  }

  it('Ctrl+wheel zooms around the cursor (the world point under it stays drawn under it)', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const { ctrl, is } = controller(cappedCanvas().canvas);
    const under = is.toWorldCoordsFromCanvas(1000, 200);
    ctrl.handleWheel({ ctrlKey: true, deltaY: -300, clientX: 1000, clientY: 200, preventDefault() {} } as unknown as WheelEvent);
    expect(is.getZoomFactor()).toBeCloseTo(1.3, 6);
    const at = drawnAt(is, under.x, under.y);
    expect(at.x).toBeCloseTo(1000, 3);
    expect(at.y).toBeCloseTo(200, 3);
  });

  it('two-finger pan + pinch stay finger-locked', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const { ctrl, is } = controller(cappedCanvas().canvas);
    is.suppressBoxSelect = true;
    const t = (id: number, x: number, y: number) => pev({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y });
    ctrl.handlePointerDown(t(1, 400, 400));
    ctrl.handlePointerDown(t(2, 600, 400));
    const mid = is.toWorldCoordsFromCanvas(500, 400);
    ctrl.handlePointerMove(t(1, 330, 450));                           // both fingers move + spread 200 → 300
    ctrl.handlePointerMove(t(2, 630, 450));
    const at = drawnAt(is, mid.x, mid.y);
    expect(at.x).toBeCloseTo(480, 3);                                 // the new midpoint
    expect(at.y).toBeCloseTo(450, 3);
    expect(is.getZoomFactor()).toBeCloseTo(1.5, 6);
  });

  it('desktop DPR 1 (backing == CSS): the pan rule is unchanged (delta × 2 pan units)', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const { ctrl, is } = controller(cappedCanvas({ w: 800, h: 600 }, { w: 800, h: 600 }).canvas);
    is.isPanToolSelected = true;
    ctrl.handlePointerDown(pev({ clientX: 100, clientY: 100 }));
    ctrl.handlePointerMove(pev({ clientX: 110, clientY: 95 }));
    expect(is.getPanOffset()).toEqual({ x: 20, y: -10 });
  });
});

describe('positions land under the pointer at backing 1.5 ≠ DPR 2', () => {
  function pannedZoomed(canvas: HTMLCanvasElement) {
    const is = new InteractionService(canvas);
    is.setZoom(2.3);
    is.adjustPan(-410, 260);
    return is;
  }

  it('2D picks (canvasPxToWorld + toWorldCoordsFromCanvas) hit what is drawn under the pointer', () => {
    const { canvas } = cappedCanvas();
    const is = pannedZoomed(canvas);
    for (const [wx, wy] of [[0.1, -0.2], [-0.35, 0.05], [0.4, 0.3]]) {
      const p = drawnAt(is, wx, wy);
      const a = canvasPxToWorld(p.x, p.y, canvas, is);
      const b = is.toWorldCoordsFromCanvas(p.x, p.y);
      expect(a[0]).toBeCloseTo(wx, 6); expect(a[1]).toBeCloseTo(wy, 6);
      expect(b.x).toBeCloseTo(wx, 6); expect(b.y).toBeCloseTo(wy, 6);
    }
  });

  it('the eraser hits what is drawn under the pointer (it divided CSS px by the BACKING size)', () => {
    const { canvas } = cappedCanvas();
    const is = pannedZoomed(canvas);
    const eraser = new EraserService(is, { root: new Node() } as never, {} as never, {} as never);
    const toWorld = (eraser as unknown as { transformMouseCoordinatesToWorldSpace(x: number, y: number): [number, number] })
      .transformMouseCoordinatesToWorldSpace.bind(eraser);
    const p = drawnAt(is, 0.12, -0.07);
    const w = toWorld(p.x, p.y);
    expect(w[0]).toBeCloseTo(0.12, 6);
    expect(w[1]).toBeCloseTo(-0.07, 6);
  });

  it('a brush stroke starts on the texel drawn under the pointer (canvas offset on the page too)', async () => {
    const { canvas, fire } = cappedCanvas(undefined, undefined, 37, 64);
    const is = pannedZoomed(canvas);
    const begins: Array<{ x: number; y: number }> = [];
    const engine = {
      setBrushColor() {}, setLockTransparency() {}, setAspectCorrection() {}, setSelectionMask() {}, setEraseMode() {},
      setActivePreset: () => true, beginStroke: (p: { x: number; y: number }) => { begins.push(p); }, addStrokePoints() {},
      endStroke: async () => null,
    };
    const renderer = {
      rasterPaintEngine: engine, getRasterTextureSize: () => ({ w: 2048, h: 2048 }),
      getIllustrationMode: () => false, getIllustrationBounds: () => null,
      syncActiveLayerTexture() {}, scheduleRender() {}, addPreRenderCallback() {}, removePreRenderCallback() {},
    };
    const svc = new RasterDrawingService(is, renderer as never, {} as never);
    svc.enable();
    // The raster quad spans world [-1, 1]² → texels [0, 2048]² (v down). Put the pointer over world (0.25, -0.4).
    const p = drawnAt(is, 0.25, -0.4);
    await fire('pointerdown', { pointerId: 1, button: 0, buttons: 1, pressure: 0.5, clientX: p.x + 37, clientY: p.y + 64, timeStamp: 10 });
    expect(begins.length).toBe(1);
    expect(begins[0].x).toBeCloseTo((0.25 + 1) / 2 * 2048, 2);
    expect(begins[0].y).toBeCloseTo((1 - -0.4) / 2 * 2048, 2);
  });

  it('a 3D ray from client px (pickFromClient3D path) and from backing px (canvas.width/rect.width path) both go through the drawn point', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const { canvas } = cappedCanvas();
    const cam = new Camera3D();
    cam.aspect = canvas.width / canvas.height;
    cam.lookAt(3, 2, 6, 0, 0, 0);
    const target = vec3.fromValues(0.4, -0.3, 0.2);
    const clip = vec4.transformMat4(vec4.create(), vec4.fromValues(target[0], target[1], target[2], 1), cam.getViewProjectionMatrix() as mat4);
    const bx = (clip[0] / clip[3] + 1) / 2 * canvas.width, by = (1 - clip[1] / clip[3]) / 2 * canvas.height;
    const k = canvasPixelRatio(canvas);
    const css = { x: bx / k, y: by / k };                             // where the finger is
    const pk = new MeshPicker();
    const distToRay = (o: vec3, d: vec3) => {
      const v = vec3.sub(vec3.create(), target, o);
      return vec3.length(vec3.sub(vec3.create(), v, vec3.scale(vec3.create(), d, vec3.dot(v, d))));
    };
    const r1 = pk.castRay(css.x, css.y, canvas.clientWidth, canvas.clientHeight, cam);
    expect(distToRay(vec3.clone(r1.origin), vec3.clone(r1.dir))).toBeLessThan(1e-4);
    const r2 = pk.castRay(css.x * k, css.y * k, canvas.width, canvas.height, cam);
    expect(distToRay(vec3.clone(r2.origin), vec3.clone(r2.dir))).toBeLessThan(1e-4);
    // window.devicePixelRatio (2) instead of the backing ratio (1.5) would aim the ray elsewhere.
    const bad = pk.castRay(css.x * 2, css.y * 2, canvas.width, canvas.height, cam);
    expect(distToRay(vec3.clone(bad.origin), vec3.clone(bad.dir))).toBeGreaterThan(0.05);
  });
});
