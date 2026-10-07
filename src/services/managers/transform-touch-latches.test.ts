/**
 * transform-touch-latches.test.ts — TOUCH-10: the additive-select and snap LATCHES (sm.setAdditiveSelect3D /
 * sm.setSnapToggle3D → InteractionService flags → TransformController3D callbacks). A tablet has no Shift / Ctrl.
 */
import { describe, it, expect } from 'vitest';
import { TransformController3D, type TransformControllerCallbacks } from './transform-controller-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import type { GizmoRenderer } from '../../renderer/3d/gizmo-renderer';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';

type Init = Partial<{ pointerId: number; pointerType: string; clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean }>;

function fakeCanvas(): HTMLCanvasElement {
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: {}, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  });
  return el as unknown as HTMLCanvasElement;
}
function fire(el: HTMLCanvasElement, type: string, init: Init): void {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, altKey: false, ctrlKey: false, shiftKey: false, ...init });
  el.dispatchEvent(e);
}

function setup() {
  const mk = (id: string) => ({ id, x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotation: 0, scaleX: 1, scaleY: 1, scaleZ: 1, localMatrix: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]) } as unknown as Mesh3D);
  const A = mk('A'), B = mk('B');
  let selected = new Set<string>(['B']);
  const latches = { additive: false, snap: false };
  const gizmo = { hitScale: 1, hitTestArrayHandle: () => null, hitTestCorner: () => null, hitTest: () => null } as unknown as GizmoRenderer;
  const cb: TransformControllerCallbacks = {
    getMeshes: () => [A, B],
    getCamera: () => new Camera3D({ position: [0, 0, 5], target: [0, 0, 0] }),
    getCanvasSize: () => ({ width: 800, height: 600 }),
    getSelectedIds: () => selected,
    setSelectedIds: (ids) => { selected = new Set(ids); },
    scheduleRender: () => {},
    isAdditiveSelect: () => latches.additive,
    isSnapLatched: () => latches.snap,
  };
  const tc = new TransformController3D(cb, gizmo);
  (tc as unknown as { picker: unknown }).picker = {
    castRay: () => ({ origin: new Float32Array([0, 0, 5]), dir: new Float32Array([0, 0, -1]) }),
    pickMesh: (x: number) => (x < 400 ? { mesh: A } : null),
  };
  const el = fakeCanvas();
  tc.attach(el);
  return { tc, el, latches, sel: () => [...selected].sort() };
}

describe('TransformController3D latches (TOUCH-10)', () => {
  it('additive latch off: a click replaces the selection; on: it adds like Shift (mouse and finger tap)', () => {
    const t = setup();
    fire(t.el, 'pointerdown', { clientX: 100, clientY: 100 });
    expect(t.sel()).toEqual(['A']);
    t.latches.additive = true;
    fire(t.el, 'pointerup', {});
    (t.tc as unknown as { cb: { setSelectedIds(s: Set<string>): void } }).cb.setSelectedIds(new Set(['B']));
    fire(t.el, 'pointerdown', { clientX: 100, clientY: 100 });
    expect(t.sel()).toEqual(['A', 'B']);
    fire(t.el, 'pointerup', {});
    // finger tap with the latch: toggles A off again (Shift semantics: an additive click on a selected mesh removes it)
    fire(t.el, 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
    fire(t.el, 'pointerup', { pointerType: 'touch', clientX: 100, clientY: 100 });
    expect(t.sel()).toEqual(['B']);
  });

  it('additive latch on: a tap on empty space keeps the selection (Shift never deselects)', () => {
    const t = setup();
    t.latches.additive = true;
    fire(t.el, 'pointerdown', { pointerType: 'touch', clientX: 600, clientY: 100 });
    fire(t.el, 'pointerup', { pointerType: 'touch', clientX: 600, clientY: 100 });
    expect(t.sel()).toEqual(['B']);
  });

  it('snapActive follows Ctrl OR the snap latch', () => {
    const t = setup();
    expect(t.tc.snapActive).toBe(false);
    t.latches.snap = true;
    expect(t.tc.snapActive).toBe(true);
    t.latches.snap = false;
    fire(t.el, 'pointermove', { ctrlKey: true, clientX: 10, clientY: 10 });
    expect(t.tc.snapActive).toBe(true);
  });
});
