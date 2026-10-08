/**
 * view-roll.test.ts — VIEW ROLL (two-finger twist, 2026-10-08) in the hosts:
 *  - which views may roll (Scene3DArmature.canViewRoll): the decoupled edit camera (Edit Mesh / UV / Armature) and the
 *    3D Free scene view; never Play, City mode, the 2D illustration cameras;
 *  - the edit camera keeps the roll through its per-frame update, Frame and a direct mode switch on the same mesh;
 *    leaving the edit view gives the camera back level;
 *  - the 3D Free camera's roll persists with the view state (freeCam.roll; old saves without it load level);
 *  - Frame fits on the rolled screen (framePose / faceOnFraming).
 */
import { describe, it, expect } from 'vitest';
import { Scene3DArmature, type Scene3DArmatureHost } from './scene3d-armature';
import { Scene3DManager } from './scene3d-manager';
import { normalizeViewState, type ViewState } from './view-state';
import { framePose } from './scene-frame';
import { faceOnFraming } from './edit-face-frame';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { OrbitController } from '../../renderer/3d/orbit-controller';
import type { ManagerContext } from './manager-context';

const DEG = Math.PI / 180;

function setup() {
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: {}, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => false,
  });
  const canvas = el as unknown as HTMLCanvasElement;
  const camera = new Camera3D({ position: [0, 0, 10], target: [0, 0, 0] });
  camera.aspect = 800 / 600;
  camera.mode = 'orthographic';
  const callbacks = new Set<() => boolean>();
  const r3 = {
    getCamera: () => camera,
    setMeshEditModeActive: () => {}, setArmatureModeActive: () => {}, setBoneOverlaySkeleton: () => {},
    setSelectedJoint: () => {}, setHoveredJoint: () => {}, setGizmoMode: () => {}, setHoveredTailJoint: () => {},
    setBonePlacementActive: () => {}, setExtraSelectedJoints: () => {},
  };
  const is = { cameraOwnsView: false, suppressBoxSelect: false, additiveSelect3D: false, isPanToolSelected: false,
    getPanOffset: () => ({ x: 0, y: 0 }), getZoomFactor: () => 1, beginInteractive: () => {}, endInteractive: () => {} };
  const ctx = {
    webgpuRenderer: {
      getCanvas: () => canvas, getRenderer3D: () => r3,
      addPreRenderCallback: (cb: () => boolean) => { callbacks.add(cb); },
      removePreRenderCallback: (cb: () => boolean) => { callbacks.delete(cb); },
      touchZoom2D: () => {}, touchPan2D: () => {},
    },
    scheduleRender: () => {}, emitSceneGraphChanged: () => {}, interactionService: is,
  } as unknown as ManagerContext;
  const boxes: Record<string, [number, number, number]> = { cube: [0, 0, 0] };
  let arm!: Scene3DArmature;
  const flags = { isPlaying: false, cityModeActive: false, freeView3D: false };
  const host = {
    getMeshCenter: (id: string | null) => (id && boxes[id] ? [...boxes[id]] as [number, number, number] : null),
    getMesh: () => null, getAllMeshes: () => [],
    getSkeleton: (id: string) => (id === 'skel' ? { id, data: { joints: [], ikChains: [] } } : null),
    getAllSkeletons: () => [],
    // frameWorldBounds3D in short: re-centre from the current direction (a lookAt — level), then re-sync the orbit
    frameMesh: (id: string, padding = 1.25) => {
      const c = boxes[id];
      if (!c) return false;
      const p = camera.position, t = camera.target;
      const d = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      camera.orthoSize = 0.5 * padding;
      camera.lookAt(c[0] + d[0] / len * 4, c[1] + d[1] / len * 4, c[2] + d[2] / len * 4, c[0], c[1], c[2]);
      arm.getOrbitController()?.syncFromCamera();
      arm.reseedDecoupledZoom();
      return true;
    },
    ensureIdleCallback: () => {}, syncFocusBgLiveLoop: () => {}, springsActiveFor: () => false,
    character: { hasOverlayBody: () => false }, resolveOverlayToBody: (id: string) => id,
    weightPaint: { isActive: () => false }, picker: {}, undoManager: {},
    get isPlaying() { return flags.isPlaying; },
    get cityModeActive() { return flags.cityModeActive; },
    get freeView3D() { return flags.freeView3D; },
  } as unknown as Scene3DArmatureHost;
  arm = new Scene3DArmature(ctx, host);
  (arm as unknown as { enableViewGizmo(): void }).enableViewGizmo = () => {};   // (DOM-only)
  const frame = () => { for (const cb of [...callbacks]) cb(); };
  return { arm, camera, frame, flags };
}
const level = (c: Camera3D) => Array.from(c.up).every((v, i) => v === [0, 1, 0][i]);

describe('which views may roll', () => {
  it('the edit camera (Edit Mesh / UV / Armature) rolls; leaving it gives the camera back level', () => {
    const t = setup();
    t.arm.enableMeshEditOrbit('cube');
    const orb = t.arm.getOrbitController()!;
    expect(t.arm.canViewRoll()).toBe(true);
    orb.twist(-30 * DEG);
    t.frame();
    expect(orb.roll).toBeCloseTo(30 * DEG, 12);
    expect(level(t.camera)).toBe(false);
    t.arm.disableMeshEditOrbit();
    expect(level(t.camera)).toBe(true);
    t.arm.enterArmatureMode3D('cube');
    expect(t.arm.canViewRoll()).toBe(true);
    t.flags.isPlaying = true;
    expect(t.arm.canViewRoll()).toBe(false);              // Play: never
  });

  it('the 3D Free scene view rolls; City mode, Play and the 2D cameras do not', () => {
    const t = setup();
    t.flags.freeView3D = true;
    t.arm.enableOrbitControls({ freeLookNav: true });
    t.arm.setMeshEditOrbitCenter([0, 0, 0]);
    t.camera.mode = 'perspective';
    expect(t.arm.canViewRoll()).toBe(true);
    const orb = t.arm.getOrbitController()!;
    orb.twist(-40 * DEG);
    t.frame();
    expect(orb.roll).toBeCloseTo(40 * DEG, 12);
    expect(level(t.camera)).toBe(false);
    t.flags.cityModeActive = true;
    expect(t.arm.canViewRoll()).toBe(false);
    t.frame();
    expect(level(t.camera)).toBe(true);                   // City: level (the roll waits)
    t.flags.cityModeActive = false;
    t.flags.isPlaying = true;
    expect(t.arm.canViewRoll()).toBe(false);
    t.flags.isPlaying = false;
    t.flags.freeView3D = false;                            // a 2D Ortho / 2D Persp camera
    expect(t.arm.canViewRoll()).toBe(false);
    orb.twist(-20 * DEG);
    expect(orb.roll).toBeCloseTo(40 * DEG, 12);           // no twist there
    t.arm.disableOrbitControls();
    expect(level(t.camera)).toBe(true);
  });
});

describe('the edit camera keeps its roll', () => {
  it('through the per-frame update, Frame, and a direct mode switch on the same mesh', () => {
    const t = setup();
    t.arm.enableMeshEditOrbit('cube');
    const orb = t.arm.getOrbitController()!;
    orb.twist(-86 * DEG);                                  // 86° → snaps to 90°
    t.frame();
    expect(orb.roll).toBeCloseTo(90 * DEG, 12);
    const up = Array.from(t.camera.up);
    t.frame(); t.frame();
    expect(Array.from(t.camera.up)).toEqual(up);
    expect(t.arm.frameEditView()).toBe(true);             // Frame: lookAt + sync — keeps the roll
    t.frame();
    expect(orb.roll).toBeCloseTo(90 * DEG, 12);
    expect(level(t.camera)).toBe(false);
    // Edit Mesh → UV (both run enableMeshEditOrbit on the same mesh): the kept camera carries the roll
    t.arm.disableMeshEditOrbit();
    t.arm.enableMeshEditOrbit('cube');
    t.frame();
    expect(t.arm.getOrbitController()!.roll).toBeCloseTo(90 * DEG, 12);
    // Edit Mesh → Armature
    t.arm.disableMeshEditOrbit();
    t.arm.enterArmatureMode3D('cube');
    t.frame();
    expect(t.arm.getOrbitController()!.roll).toBeCloseTo(90 * DEG, 12);
  });
});

describe('3D Free roll persistence (view state freeCam.roll)', () => {
  type Fn = (...a: unknown[]) => unknown;
  const proto = Scene3DManager.prototype as unknown as Record<string, Fn>;
  /** A Scene3DManager stand-in in scene × 3D Free running the REAL _captureCurrentPose / _applyViewState. */
  function manager(viewState: ViewState) {
    const cam = new Camera3D({ position: [0, 2, 6], target: [0, 0, 0] });
    const orb = new OrbitController(cam, { enableDamping: false });
    orb.canRoll = () => true;
    const noop = () => {};
    const stub = {
      _viewState: viewState, _flyLookHeld: false, _cityModeActive: false,
      ctx: { interactionService: { cameraOwnsView: false, getPanOffset: () => ({ x: 0, y: 0 }), getZoomFactor: () => 1 }, scheduleRender: noop },
      renderer3D: { getCamera: () => cam, setMeshEditModeActive: noop, setMeshEditBgMode: noop },
      _armature: { getOrbitController: () => orb, setMeshEditOrbitCenter: noop },
      enableOrbitControls: noop, _configureFreeZoom: noop, enableViewGizmo: noop, frameAllMeshes: noop,
      _applyArtboardFrame: noop, _applyFly: noop,
    };
    return { stub, cam, orb, capture: () => proto._captureCurrentPose.call(stub), apply: () => proto._applyViewState.call(stub) };
  }
  const free3D = (): ViewState => ({ target: 'scene', cameraMode: 'free3D', showArtboardFrame: true, showArtboardTexture: true });

  it('save → JSON → load restores the roll (and the rolled up vector)', () => {
    const a = manager(free3D());
    a.orb.setRoll(-63 * DEG);
    a.capture();
    expect(a.stub._viewState.freeCam?.roll).toBeCloseTo(-63 * DEG, 12);
    const saved = JSON.parse(JSON.stringify(a.stub._viewState)) as Partial<ViewState>;
    const b = manager(normalizeViewState(saved));
    b.apply();
    expect(b.orb.roll).toBeCloseTo(-63 * DEG, 12);
    expect(b.orb.azimuth).toBeCloseTo(a.orb.azimuth, 6);
    for (let i = 0; i < 3; i++) expect(b.cam.up[i]).toBeCloseTo(a.cam.up[i], 6);
  });

  it('a level view saves no roll; an old save without one loads level', () => {
    const a = manager(free3D());
    a.capture();
    expect(a.stub._viewState.freeCam).toBeDefined();
    expect('roll' in (a.stub._viewState.freeCam as object)).toBe(false);
    const old = normalizeViewState({ ...free3D(), freeCam: { target: [1, 2, 3], radius: 4, yaw: 0.5, pitch: 0.2, projection: 'perspective' } });
    const b = manager(old);
    b.orb.setRoll(0.7);                                     // whatever the controller had: the load levels it
    b.apply();
    expect(b.orb.roll).toBe(0);
    expect(level(b.cam)).toBe(true);
  });
});

describe('Frame fits on the rolled screen', () => {
  it('framePose: a wide box at a 90° roll fits like the tall box at 0°', () => {
    const opts = { mode: 'perspective' as const, fov: 60 * DEG, aspect: 2, padding: 1.2, minElevation: -2 };
    const wide = { minX: -5, maxX: 5, minY: -0.5, maxY: 0.5, minZ: -0.05, maxZ: 0.05 };
    const tall = { minX: -0.5, maxX: 0.5, minY: -5, maxY: 5, minZ: -0.05, maxZ: 0.05 };
    const w0 = framePose(wide, [0, 0, 1], opts), w90 = framePose(wide, [0, 0, 1], { ...opts, roll: 90 * DEG });
    const t0 = framePose(tall, [0, 0, 1], opts);
    expect(w90.position[2]).toBeGreaterThan(w0.position[2] * 1.5);   // now the long side is up the short screen axis
    expect(w90.position[2]).toBeCloseTo(t0.position[2], 6);
  });

  it('faceOnFraming: the half-height is measured on the rolled screen', () => {
    const face = [-2, -0.5, 0, 2, -0.5, 0, 2, 0.5, 0, -2, 0.5, 0];   // 4 × 1, facing +Z
    const o = { azimuth: 0, aspect: 2, padding: 1 };
    const f0 = faceOnFraming([face], o)!, f90 = faceOnFraming([face], { ...o, roll: 90 * DEG })!;
    expect(f0.halfHeight).toBeCloseTo(1, 9);              // 4 wide on a 2:1 screen
    expect(f90.halfHeight).toBeCloseTo(2, 9);             // 4 tall
    for (let i = 0; i < 3; i++) expect(f90.target[i]).toBeCloseTo(f0.target[i], 9);
    expect(f90.azimuth).toBeCloseTo(f0.azimuth, 12);
  });
});
