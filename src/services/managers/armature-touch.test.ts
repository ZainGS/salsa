/**
 * armature-touch.test.ts — TOUCH-9 / TOUCH-16 in Scene3DArmature's overlay listeners: synthetic pointer events on a
 * fake canvas, a real Skeleton3D + MeshPicker + Camera3D, the GizmoRenderer hit tests stubbed (no GPU).
 *  - pick-on-down: a mouse press on a joint selects + drags it with no hover move before it;
 *  - a finger press waits (no selection) until it moves; ×2 hit scale under a finger;
 *  - a 2nd finger / pointercancel restores the joint position, rotation and the joint selection EXACTLY;
 *  - the drag moves the joint without a scene-graph event per move (one at the end);
 *  - a finger never runs the hover pick (the sticky hover outline).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scene3DArmature, type Scene3DArmatureHost } from './scene3d-armature';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import type { ManagerContext } from './manager-context';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; buttons: number; clientX: number; clientY: number; isPrimary: boolean }>;

function fakeCanvas() {
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: {}, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => true,
  });
  return el as unknown as HTMLCanvasElement;
}
function fire(el: HTMLCanvasElement, type: string, init: Init): void {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true, clientX: 0, clientY: 0, altKey: false, ctrlKey: false, shiftKey: false, ...init });
  el.dispatchEvent(e);
}

function setup(opts: { tool?: 'move' | 'rotate'; gizmoAxis?: 'x' | 'y' | 'z' | null } = {}) {
  const canvas = fakeCanvas();
  const camera = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0] });
  camera.aspect = 800 / 600;
  const skel = new Skeleton3D({ name: 'S', joints: [], clips: [] });
  skel.addJoint(-1, [0, 0, 0], 'root');
  skel.addJoint(0, [0, 1, 0], 'arm');
  let selected: number | null = null, selectedTail = false;
  let sceneEvents = 0;
  const hitScales: number[] = [];
  let pick3DCalls = 0;
  const renderer3D = {
    getCamera: () => camera,
    setSelectedJoint: (i: number | null, t = false) => { selected = i; selectedTail = t; },
    setHoveredJoint: () => {}, setHoveredTailJoint: () => {}, setJointGizmoHoveredAxis: () => {},
    setHoveredIKHandle: () => {}, setJointGizmoDraggingAxis: () => {}, setDraggingIKHandle: () => {},
    getBoneVisibility: () => ({ spring: true, fk: true }),
    getHoveredMeshIds: () => new Set<string>(), setHoveredMeshIds: () => {}, setHoveredArrayGroupId: () => {},
    hoverOutlineAnimated: false,
  };
  const ctx = {
    webgpuRenderer: { getCanvas: () => canvas, getRenderer3D: () => renderer3D },
    scheduleRender: () => {},
    emitSceneGraphChanged: () => { sceneEvents++; },
    interactionService: { beginInteractive: () => {}, endInteractive: () => {} },
    sceneGraph: { findNodeById: () => null },
  } as unknown as ManagerContext;
  const host = {
    picker: new MeshPicker(),
    weightPaint: { isActive: () => false },
    isPlaying: false, cityModeActive: false,
    getSkeleton: (id: string) => (id === skel.id ? skel : null),
    getAllMeshes: () => [],
    pick3D: () => { pick3DCalls++; return null; },
  } as unknown as Scene3DArmatureHost;
  const arm = new Scene3DArmature(ctx, host);
  // Joint 1 sits under canvas x < 400 for the stubbed hit test (the real ray math is MeshPicker's).
  const gizmo = {
    hitScale: 1,
    hitTestJoint(this: { hitScale: number }, origin: Float32Array, dir: Float32Array) {
      hitScales.push(this.hitScale);
      // The ray at canvas x=200 points left of centre (dir.x < 0): call that joint 1's head.
      return dir[0] < 0 ? { index: 1, isTail: false } : null;
    },
    hitTestJointGizmo: () => (opts.tool !== 'rotate' ? opts.gizmoAxis ?? null : null),
    hitTestJointRotateGizmo: () => (opts.tool === 'rotate' ? opts.gizmoAxis ?? null : null),
    hitTestIKTargets: () => null,
  };
  const orbit = { enabled: true };
  const a = arm as unknown as Record<string, unknown>;
  a._gizmoRenderer = gizmo;
  a._boneOverlayExplicit = true;
  a._boneOverlaySkeletonId = skel.id;
  a._orbitController = orbit;
  a._armatureToolMode = opts.tool ?? 'move';
  (arm as unknown as { _setupBoneOverlayListeners(): void })._setupBoneOverlayListeners();
  const select = (i: number | null) => { a._selectedJointIndex = i; a._selectedJointIsTail = false; selected = i; };
  return {
    arm, canvas, skel, orbit, hitScales,
    sel: () => ({ idx: selected, tail: selectedTail, field: a._selectedJointIndex }),
    sceneEvents: () => sceneEvents, pick3DCalls: () => pick3DCalls, select,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('Scene3DArmature overlay — pick on down (TOUCH-9)', () => {
  it('a MOUSE press on a joint selects and drags it with no hover move first; one scene event at the end', () => {
    const { canvas, skel, sel, sceneEvents, orbit } = setup();
    fire(canvas, 'pointerdown', { clientX: 200, clientY: 300 });
    expect(sel().idx).toBe(1);
    expect(orbit.enabled).toBe(false);
    const before = sceneEvents();
    const p0 = [...skel.data.joints[1].localPosition];
    fire(canvas, 'pointermove', { clientX: 260, clientY: 280 });
    fire(canvas, 'pointermove', { clientX: 300, clientY: 250 });
    expect(skel.data.joints[1].localPosition).not.toEqual(p0);
    expect(sceneEvents()).toBe(before);              // no scene-graph event per move
    fire(canvas, 'pointerup', { clientX: 300, clientY: 250, buttons: 0 });
    expect(sceneEvents()).toBe(before + 1);
    expect(orbit.enabled).toBe(true);
  });

  it('a press off every joint is let through (no selection change)', () => {
    const { canvas, sel } = setup();
    fire(canvas, 'pointerdown', { clientX: 600, clientY: 300 });
    expect(sel().idx).toBeNull();
  });
});

describe('Scene3DArmature overlay — fingers (TOUCH-9 / TOUCH-8)', () => {
  it('a finger press picks with ×2 hit radii but selects nothing until it moves', () => {
    const { canvas, sel, hitScales } = setup();
    fire(canvas, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 300 });
    expect(hitScales).toEqual([2]);
    expect(sel().idx).toBeNull();
    fire(canvas, 'pointermove', { pointerType: 'touch', clientX: 230, clientY: 300 });
    expect(sel().idx).toBe(1);
  });

  it('a 2nd finger restores the joint position AND the previous joint selection exactly', () => {
    const { canvas, skel, sel, select, orbit } = setup();
    select(0);
    const p0 = [...skel.data.joints[1].localPosition];
    fire(canvas, 'pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 300 });
    fire(canvas, 'pointermove', { pointerType: 'touch', pointerId: 1, clientX: 260, clientY: 250 });
    expect(skel.data.joints[1].localPosition).not.toEqual(p0);
    expect(sel().idx).toBe(1);
    fire(canvas, 'pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 500, clientY: 300 });
    expect(skel.data.joints[1].localPosition).toEqual(p0);
    expect(sel().idx).toBe(0);
    expect(sel().field).toBe(0);
    expect(orbit.enabled).toBe(true);                  // handed to the pinch / two-finger orbit
    fire(canvas, 'pointermove', { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 200 });
    expect(skel.data.joints[1].localPosition).toEqual(p0);   // blocked until every finger lifts
  });

  it('a rotate-ring drag is restored exactly by pointercancel', () => {
    const { canvas, skel, select } = setup({ tool: 'rotate', gizmoAxis: 'y' });
    select(1);
    const q0 = [...skel.data.joints[1].localRotation];
    fire(canvas, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 300 });
    fire(canvas, 'pointermove', { pointerType: 'touch', clientX: 260, clientY: 300 });
    expect(skel.data.joints[1].localRotation).not.toEqual(q0);
    fire(canvas, 'pointercancel', { pointerType: 'touch', clientX: 260, clientY: 300 });
    expect(skel.data.joints[1].localRotation).toEqual(q0);
  });

  it('TOUCH-16: a finger never runs the hover pick; the mouse does (once per frame)', () => {
    vi.useFakeTimers();
    const { canvas, pick3DCalls } = setup();
    fire(canvas, 'pointermove', { pointerType: 'touch', buttons: 0, clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(50);
    expect(pick3DCalls()).toBe(0);
    fire(canvas, 'pointermove', { buttons: 0, clientX: 100, clientY: 100 });
    fire(canvas, 'pointermove', { buttons: 0, clientX: 110, clientY: 100 });
    vi.advanceTimersByTime(50);
    expect(pick3DCalls()).toBe(1);
  });
});
