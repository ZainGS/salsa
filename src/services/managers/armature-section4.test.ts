/**
 * armature-section4.test.ts — the armature tool strip's engine side (UI review 2026-10-07 §4,
 * docs/reviews/section4-engine-api.md), on Scene3DArmature with a real Skeleton3D + Camera3D (GPU bits stubbed):
 *  - tap-select: additive toggling, the primary, the change listener, the Select tool (a head press selects, no drag);
 *  - pickArmatureJointAt: screen-space nearest joint within the radius, only with an overlay;
 *  - addArmatureChildJoint: head at the parent's tail, continuing its bone, one undo step;
 *  - setArmatureIK / getArmatureIK: create, length, enable, pole joint (persisted), clear;
 *  - the tool switch (gizmo hidden for select / ik / addbone, Add Bone keeps placing).
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
import { Scene3DArmature, type Scene3DArmatureHost } from './scene3d-armature';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { UndoManager3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; buttons: number; clientX: number; clientY: number; isPrimary: boolean; shiftKey: boolean }>;

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

function setup() {
  const canvas = fakeCanvas();
  const camera = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0] });
  camera.aspect = 800 / 600;
  const skel = new Skeleton3D({ name: 'S', joints: [], clips: [] });
  skel.addJoint(-1, [0, 0, 0], 'root');
  skel.addJoint(0, [0, 1, 0], 'arm');
  const r = { selected: null as number | null, tail: false, extras: null as ReadonlySet<number> | null, gizmoHidden: false, placing: false, mode: 'move' };
  const renderer3D = {
    getCamera: () => camera,
    setSelectedJoint: (i: number | null, t = false) => { r.selected = i; r.tail = t; },
    setExtraSelectedJoints: (s: ReadonlySet<number> | null) => { r.extras = s; },
    setJointGizmoHidden: (h: boolean) => { r.gizmoHidden = h; },
    setBonePlacementActive: (on: boolean) => { r.placing = on; },
    setArmatureToolMode: (m: string) => { r.mode = m; },
    setHoveredJoint: () => {}, setHoveredTailJoint: () => {}, setJointGizmoHoveredAxis: () => {},
    setHoveredIKHandle: () => {}, setJointGizmoDraggingAxis: () => {}, setDraggingIKHandle: () => {},
    getBoneVisibility: () => ({ spring: true, fk: true }),
    getHoveredMeshIds: () => new Set<string>(), setHoveredMeshIds: () => {}, setHoveredArrayGroupId: () => {},
    hoverOutlineAnimated: false,
  };
  let sceneEvents = 0;
  const ctx = {
    webgpuRenderer: { getCanvas: () => canvas, getRenderer3D: () => renderer3D },
    scheduleRender: () => {},
    emitSceneGraphChanged: () => { sceneEvents++; },
    interactionService: { beginInteractive: () => {}, endInteractive: () => {}, additiveSelect3D: false },
    sceneGraph: { findNodeById: () => null },
  } as unknown as ManagerContext;
  const undoManager = new UndoManager3D();
  const host = {
    picker: new MeshPicker(), undoManager,
    weightPaint: { isActive: () => false },
    isPlaying: false, cityModeActive: false,
    getSkeleton: (id: string) => (id === skel.id ? skel : null),
    getAllMeshes: () => [], getMesh: () => null,
    pick3D: () => null,
  } as unknown as Scene3DArmatureHost;
  const arm = new Scene3DArmature(ctx, host);
  const gizmo = {
    hitScale: 1,
    // the ray at canvas x < 400 points left of centre: joint 1's head
    hitTestJoint: (_o: Float32Array, dir: Float32Array) => (dir[0] < 0 ? { index: 1, isTail: false } : null),
    hitTestJointGizmo: () => null, hitTestJointRotateGizmo: () => null, hitTestIKTargets: () => null,
  };
  const a = arm as unknown as Record<string, unknown>;
  a._gizmoRenderer = gizmo;
  a._boneOverlayExplicit = true;
  a._boneOverlaySkeletonId = skel.id;
  a._orbitController = { enabled: true };
  (arm as unknown as { _setupBoneOverlayListeners(): void })._setupBoneOverlayListeners();
  /** Client px of a joint's head (canvas = client here). */
  const screenOf = (ji: number) => {
    const m = camera.getViewProjectionMatrix() as unknown as Float32Array, w = skel.data.joints[ji].worldMatrix;
    const x = w[12], y = w[13], z = w[14], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) * 400, y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 300 };
  };
  /** The host's additive selection latch (setAdditiveSelect3D). */
  const latch = (on: boolean) => { (ctx.interactionService as unknown as { additiveSelect3D: boolean }).additiveSelect3D = on; };
  return { arm, skel, canvas, r, undoManager, screenOf, latch, sceneEvents: () => sceneEvents };
}

describe('Armature tap-select (selectArmatureJoint3D / getSelectedArmatureJoints3D / onArmatureJointSelectionChanged)', () => {
  it('select, additive toggle, primary promotion, listener calls; a foreign skeleton is refused', () => {
    const t = setup();
    const calls: Array<{ skeletonId: string; jointIndex: number }[]> = [];
    const off = t.arm.onJointSelectionChanged(sel => calls.push(sel));
    expect(t.arm.selectArmatureJoint(t.skel.id, 1)).toBe(true);
    expect(t.arm.getSelectedArmatureJoints()).toEqual([{ skeletonId: t.skel.id, jointIndex: 1 }]);
    expect(t.r.selected).toBe(1);
    t.arm.selectArmatureJoint(t.skel.id, 0, true);                       // add: 0 becomes the primary
    expect(t.arm.getSelectedArmatureJoints().map(s => s.jointIndex)).toEqual([0, 1]);
    expect(t.r.selected).toBe(0);
    expect([...t.r.extras!]).toEqual([1]);
    t.arm.selectArmatureJoint(t.skel.id, 0, true);                       // toggle the primary off: 1 is promoted
    expect(t.arm.getSelectedArmatureJoints().map(s => s.jointIndex)).toEqual([1]);
    expect(t.r.extras).toBeNull();
    t.arm.selectArmatureJoint(t.skel.id, 0, true);
    t.arm.selectArmatureJoint(t.skel.id, 1);                             // plain: only 1
    expect(t.arm.getSelectedArmatureJoints().map(s => s.jointIndex)).toEqual([1]);
    expect(calls.map(c => c.map(s => s.jointIndex))).toEqual([[1], [0, 1], [1], [0, 1], [1]]);
    // the legacy single-select path (selectJoint3D) also notifies, and drops the multi-selection
    t.arm.selectArmatureJoint(t.skel.id, 0, true);
    t.arm.selectJoint(null);
    expect(t.arm.getSelectedArmatureJoints()).toEqual([]);
    expect(calls[calls.length - 1]).toEqual([]);
    off();
    t.arm.selectArmatureJoint(t.skel.id, 1);
    expect(calls[calls.length - 1]).toEqual([]);                         // unsubscribed
    expect(t.arm.selectArmatureJoint('nope', 0)).toBe(false);
    expect(t.arm.selectArmatureJoint(t.skel.id, 9)).toBe(false);
  });

  it('the Select tool: a head press selects without dragging; Shift adds; the gizmo is hidden', () => {
    const t = setup();
    expect(t.arm.setArmatureActiveTool('select')).toBe(true);
    expect(t.r.gizmoHidden).toBe(true);
    const p0 = [...t.skel.data.joints[1].localPosition];
    fire(t.canvas, 'pointerdown', { clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { clientX: 260, clientY: 280 });
    fire(t.canvas, 'pointerup', { clientX: 260, clientY: 280, buttons: 0 });
    expect(t.arm.getSelectedArmatureJoints().map(s => s.jointIndex)).toEqual([1]);
    expect(t.skel.data.joints[1].localPosition).toEqual(p0);           // not moved
    t.arm.selectJoint(0);
    fire(t.canvas, 'pointerdown', { clientX: 200, clientY: 300, shiftKey: true });
    fire(t.canvas, 'pointerup', { clientX: 200, clientY: 300, buttons: 0 });
    expect(t.arm.getSelectedArmatureJoints().map(s => s.jointIndex)).toEqual([1, 0]);
    // the Move tool brings the gizmo + the press-drag back
    t.arm.setArmatureActiveTool('move');
    expect(t.r.gizmoHidden).toBe(false);
    expect(t.r.mode).toBe('move');
    fire(t.canvas, 'pointerdown', { clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { clientX: 260, clientY: 280 });
    fire(t.canvas, 'pointerup', { clientX: 260, clientY: 280, buttons: 0 });
    expect(t.skel.data.joints[1].localPosition).not.toEqual(p0);
  });
});

describe('pickArmatureJointAt3D', () => {
  it('the joint nearest the point within 24 CSS px; null further away or without an overlay', () => {
    const t = setup();
    const s1 = t.screenOf(1), s0 = t.screenOf(0);
    expect(t.arm.pickArmatureJointAt(s1.x + 10, s1.y - 8)).toEqual({ skeletonId: t.skel.id, jointIndex: 1, jointName: 'arm' });
    expect(t.arm.pickArmatureJointAt(s0.x - 3, s0.y + 4)!.jointIndex).toBe(0);
    expect(t.arm.pickArmatureJointAt(s1.x + 30, s1.y)).toBeNull();
    (t.arm as unknown as Record<string, unknown>)._boneOverlaySkeletonId = null;
    expect(t.arm.pickArmatureJointAt(s1.x, s1.y)).toBeNull();
  });
});

describe('addArmatureChildJoint3D', () => {
  it('head at the parent tail, the bone continued, selected; ONE undo step (undo removes it, redo re-adds)', () => {
    const t = setup();
    t.skel.setJointTailOffset(1, [0, 0.5, 0]);
    const idx = t.arm.addArmatureChildJoint(t.skel.id, 1, 'hand');
    expect(idx).toBe(2);
    const j = t.skel.data.joints[2];
    expect(j.name).toBe('hand');
    expect(j.parentIndex).toBe(1);
    expect(t.skel.data.joints[1].children).toContain(2);
    expect(j.localPosition).toEqual([0, 0.5, 0]);
    expect(j.tailOffset).toEqual([0, 0.5, 0]);
    expect(j.worldMatrix[13]).toBeCloseTo(1.5, 6);
    expect(t.arm.getSelectedArmatureJoints()).toEqual([{ skeletonId: t.skel.id, jointIndex: 2 }]);
    expect(t.undoManager.stackSize).toBe(1);
    t.undoManager.undo();
    expect(t.skel.data.joints).toHaveLength(2);
    expect(t.skel.data.joints[1].children).not.toContain(2);
    expect(t.arm.getSelectedArmatureJoints()).toEqual([]);
    t.undoManager.redo();
    expect(t.skel.data.joints).toHaveLength(3);
    expect(t.skel.data.joints[2].worldMatrix[13]).toBeCloseTo(1.5, 6);
    // a new root; bad parents are refused
    expect(t.arm.addArmatureChildJoint(t.skel.id, -1)).toBe(3);
    expect(t.skel.data.joints[3].parentIndex).toBe(-1);
    expect(t.arm.addArmatureChildJoint(t.skel.id, 99)).toBe(-1);
    expect(t.arm.addArmatureChildJoint('nope', 0)).toBe(-1);
  });
});

describe('setArmatureIK3D / getArmatureIK3D', () => {
  it('creates the chain on the end joint, sets length / enabled / pole joint; the pole joint survives save / load', () => {
    const t = setup();
    t.arm.addArmatureChildJoint(t.skel.id, 1, 'hand');
    expect(t.arm.getArmatureIK(t.skel.id, 2)).toBeNull();
    expect(t.arm.setArmatureIK(t.skel.id, 2, { chainLength: 2, enabled: false })).toBeNull();   // nothing to disable
    const id = t.arm.setArmatureIK(t.skel.id, 2, { chainLength: 2, enabled: true });
    expect(id).toBeTruthy();
    let ik = t.arm.getArmatureIK(t.skel.id, 2)!;
    expect(ik).toMatchObject({ chainId: id, chainLength: 2, enabled: true, poleJointIndex: null, poleTarget: null });
    expect(ik.target[1]).toBeCloseTo(t.skel.data.joints[2].worldMatrix[13], 6);
    // pole = joint 0 (its world position); length 3; the same chain (no duplicate)
    expect(t.arm.setArmatureIK(t.skel.id, 2, { chainLength: 3, enabled: true, poleJointIndex: 0 })).toBe(id);
    ik = t.arm.getArmatureIK(t.skel.id, 2)!;
    expect(ik.chainLength).toBe(3);
    expect(ik.poleJointIndex).toBe(0);
    expect(ik.poleTarget).toEqual([0, 0, 0]);
    expect(t.skel.data.ikChains).toHaveLength(1);
    // persistence
    const back = Skeleton3D.fromJSON(JSON.parse(JSON.stringify(t.skel.toJSON())));
    expect(back.data.ikChains![0].poleJointIdx).toBe(0);
    // undefined pole = unchanged; disable; null pole clears it
    t.arm.setArmatureIK(t.skel.id, 2, { chainLength: 3, enabled: false });
    ik = t.arm.getArmatureIK(t.skel.id, 2)!;
    expect(ik.enabled).toBe(false);
    expect(ik.poleJointIndex).toBe(0);
    t.arm.setArmatureIK(t.skel.id, 2, { chainLength: 1, enabled: true, poleJointIndex: null });
    ik = t.arm.getArmatureIK(t.skel.id, 2)!;
    expect(ik).toMatchObject({ enabled: true, poleJointIndex: null, poleTarget: null, chainLength: 2 });   // (length ≥ 2)
    expect(t.arm.setArmatureIK(t.skel.id, 9, { chainLength: 2, enabled: true })).toBeNull();
  });
});

describe('setArmatureActiveTool3D', () => {
  it('Add Bone keeps bone placement on after each bone; switching away stops it; weight needs a skinned mesh', () => {
    const t = setup();
    expect(t.arm.getArmatureActiveTool()).toBe('move');
    expect(t.arm.setArmatureActiveTool('addbone')).toBe(true);
    expect(t.arm.isBonePlacementModeActive3D()).toBe(true);
    expect(t.r.gizmoHidden).toBe(true);
    // a finished placement re-arms it while the tool is on
    (t.arm as unknown as { _endBonePlacement(): void })._endBonePlacement();
    expect(t.arm.isBonePlacementModeActive3D()).toBe(true);
    expect(t.arm.setArmatureActiveTool('ik')).toBe(true);
    expect(t.arm.isBonePlacementModeActive3D()).toBe(false);
    expect(t.arm.setArmatureActiveTool('weight')).toBe(false);          // no skinned mesh on this skeleton
    expect(t.arm.getArmatureActiveTool()).toBe('ik');
    expect(t.arm.setArmatureActiveTool('rotate')).toBe(true);
    expect(t.r.mode).toBe('rotate');
    expect(t.r.gizmoHidden).toBe(false);
    expect(t.arm.setArmatureActiveTool('lasso' as never)).toBe(false);
    // the legacy Move / Rotate setter is the same tool
    t.arm.setArmatureActiveTool('select');
    t.arm.setArmatureToolMode('move');
    expect(t.arm.getArmatureActiveTool()).toBe('move');
    expect(t.r.gizmoHidden).toBe(false);
  });
});

describe('Additive head press (latch / Shift) in Move: toggle on release, a drag past the slop moves', () => {
  const sel = (t: ReturnType<typeof setup>) => t.arm.getSelectedArmatureJoints().map(s => s.jointIndex);

  it('a tap (no move) toggles on RELEASE: pen, touch, a small wobble inside the slop, Shift + click', () => {
    const t = setup();
    t.latch(true);
    t.arm.selectJoint(0);
    const p0 = [...t.skel.data.joints[1].localPosition];
    fire(t.canvas, 'pointerdown', { pointerType: 'pen', clientX: 200, clientY: 300 });
    expect(sel(t)).toEqual([0]);                                          // nothing on the press
    fire(t.canvas, 'pointermove', { pointerType: 'pen', clientX: 202, clientY: 302 });   // inside the 4 px slop
    fire(t.canvas, 'pointerup', { pointerType: 'pen', clientX: 202, clientY: 302, buttons: 0 });
    expect(sel(t)).toEqual([1, 0]);                                       // added on the release
    expect(t.skel.data.joints[1].localPosition).toEqual(p0);
    // a finger tap (inside the 8 px slop) toggles it back off
    fire(t.canvas, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { pointerType: 'touch', clientX: 205, clientY: 304 });
    expect(sel(t)).toEqual([1, 0]);
    fire(t.canvas, 'pointerup', { pointerType: 'touch', clientX: 205, clientY: 304, buttons: 0 });
    expect(sel(t)).toEqual([0]);
    expect(t.skel.data.joints[1].localPosition).toEqual(p0);
    expect(t.undoManager.stackSize).toBe(0);
    // Shift + mouse click: the same (toggle on release)
    t.latch(false);
    fire(t.canvas, 'pointerdown', { clientX: 200, clientY: 300, shiftKey: true });
    expect(sel(t)).toEqual([0]);
    fire(t.canvas, 'pointerup', { clientX: 200, clientY: 300, buttons: 0, shiftKey: true });
    expect(sel(t)).toEqual([1, 0]);
    fire(t.canvas, 'pointerdown', { clientX: 200, clientY: 300, shiftKey: true });
    fire(t.canvas, 'pointerup', { clientX: 200, clientY: 300, buttons: 0, shiftKey: true });
    expect(sel(t)).toEqual([0]);
    // a plain mouse click still replaces on the press
    fire(t.canvas, 'pointerdown', { clientX: 200, clientY: 300 });
    expect(sel(t)).toEqual([1]);
    fire(t.canvas, 'pointerup', { clientX: 200, clientY: 300, buttons: 0 });
    expect(sel(t)).toEqual([1]);
    expect(t.undoManager.stackSize).toBe(0);                              // no move, no step
  });

  it('press + drag on a SELECTED joint moves it without toggling; ONE undo step (undo / redo exact)', () => {
    const t = setup();
    t.arm.selectArmatureJoint(t.skel.id, 0);
    t.arm.selectArmatureJoint(t.skel.id, 1, true);                       // [1, 0]
    t.latch(true);
    const p0 = [...t.skel.data.joints[1].localPosition];
    fire(t.canvas, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { pointerType: 'touch', clientX: 230, clientY: 290 });
    fire(t.canvas, 'pointermove', { pointerType: 'touch', clientX: 260, clientY: 280 });
    fire(t.canvas, 'pointerup', { pointerType: 'touch', clientX: 260, clientY: 280, buttons: 0 });
    const p1 = [...t.skel.data.joints[1].localPosition];
    expect(p1).not.toEqual(p0);
    expect(sel(t)).toEqual([1, 0]);                                       // still selected (no toggle)
    expect(t.undoManager.stackSize).toBe(1);
    expect(t.undoManager.undoDescription).toBe('Move joint');
    t.undoManager.undo();
    expect(t.skel.data.joints[1].localPosition).toEqual(p0);
    t.undoManager.redo();
    expect(t.skel.data.joints[1].localPosition).toEqual(p1);
    // dragging a non-primary selected joint makes it the primary, keeping the rest
    t.arm.selectArmatureJoint(t.skel.id, 0, true);                       // off: [1]
    t.arm.selectArmatureJoint(t.skel.id, 0, true);                       // on again as the primary: [0, 1]
    expect(sel(t)).toEqual([0, 1]);
    fire(t.canvas, 'pointerdown', { pointerType: 'pen', clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { pointerType: 'pen', clientX: 240, clientY: 300 });
    fire(t.canvas, 'pointerup', { pointerType: 'pen', clientX: 240, clientY: 300, buttons: 0 });
    expect(sel(t)).toEqual([1, 0]);
    expect(t.undoManager.stackSize).toBe(2);
  });

  it('press + drag on an UNSELECTED joint selects it additively, then moves it; no toggle on release', () => {
    const t = setup();
    t.arm.selectJoint(0);
    t.latch(true);
    const p0 = [...t.skel.data.joints[1].localPosition];
    fire(t.canvas, 'pointerdown', { pointerType: 'pen', clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { pointerType: 'pen', clientX: 250, clientY: 280 });
    expect(sel(t)).toEqual([1, 0]);                                       // added as the primary at the drag start
    expect(t.r.selected).toBe(1);
    fire(t.canvas, 'pointerup', { pointerType: 'pen', clientX: 250, clientY: 280, buttons: 0 });
    expect(sel(t)).toEqual([1, 0]);
    expect(t.skel.data.joints[1].localPosition).not.toEqual(p0);
    expect(t.undoManager.stackSize).toBe(1);
  });

  it('a 2nd finger / pointercancel / Esc cancel: pose + selection restored exactly, no undo step, no toggle', () => {
    const t = setup();
    t.arm.selectJoint(0);
    t.latch(true);
    const p0 = [...t.skel.data.joints[1].localPosition];
    // 2nd finger
    fire(t.canvas, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { pointerType: 'touch', clientX: 260, clientY: 280 });
    expect(t.skel.data.joints[1].localPosition).not.toEqual(p0);
    expect(sel(t)).toEqual([1, 0]);
    fire(t.canvas, 'pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 500, clientY: 300 });
    expect(t.skel.data.joints[1].localPosition).toEqual(p0);
    expect(sel(t)).toEqual([0]);
    fire(t.canvas, 'pointerup', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 500, clientY: 300, buttons: 0 });
    fire(t.canvas, 'pointerup', { pointerType: 'touch', clientX: 260, clientY: 280, buttons: 0 });
    expect(sel(t)).toEqual([0]);
    // pointercancel (mid-drag, and on a press still deciding)
    fire(t.canvas, 'pointerdown', { pointerType: 'pen', clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { pointerType: 'pen', clientX: 260, clientY: 280 });
    fire(t.canvas, 'pointercancel', { pointerType: 'pen', clientX: 260, clientY: 280, buttons: 0 });
    expect(t.skel.data.joints[1].localPosition).toEqual(p0);
    expect(sel(t)).toEqual([0]);
    fire(t.canvas, 'pointerdown', { pointerType: 'pen', clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointercancel', { pointerType: 'pen', clientX: 200, clientY: 300, buttons: 0 });
    expect(sel(t)).toEqual([0]);
    // Esc (cancelTransform3D): the later release neither toggles nor moves
    fire(t.canvas, 'pointerdown', { pointerType: 'pen', clientX: 200, clientY: 300 });
    fire(t.canvas, 'pointermove', { pointerType: 'pen', clientX: 260, clientY: 280 });
    expect(t.arm.isArmatureDragActive).toBe(true);
    t.arm.cancelTransform3D();
    expect(t.skel.data.joints[1].localPosition).toEqual(p0);
    expect(sel(t)).toEqual([0]);
    expect(t.arm.isArmatureDragActive).toBe(false);
    fire(t.canvas, 'pointerup', { pointerType: 'pen', clientX: 260, clientY: 280, buttons: 0 });
    expect(sel(t)).toEqual([0]);
    expect(t.skel.data.joints[1].localPosition).toEqual(p0);
    expect(t.undoManager.stackSize).toBe(0);
  });
});
