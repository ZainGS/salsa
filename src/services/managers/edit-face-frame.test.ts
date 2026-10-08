/**
 * edit-face-frame.test.ts — Edit Mesh's Frame on faces (next Edit Mesh batch 2026-10-08 §3): the face-on framing
 * (faceOnFraming) and the edit camera's animated move (Scene3DArmature.animateEditView): the camera ends looking along
 * −normal, centred and fitted, with the minimal roll-free turn (a vertical normal keeps the azimuth); several faces aim
 * along their average normal only when the normals agree; the move eases over ~250 ms, completes, and stops where it is
 * when the user moves the camera.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { faceOnFraming, FACE_ON_AGREE } from './edit-face-frame';
import { Scene3DArmature, type Scene3DArmatureHost } from './scene3d-armature';
import { Camera3D } from '../../renderer/3d/camera-3d';
import type { ManagerContext } from './manager-context';

/** A unit-cube face as a flat world xyz list (counter-clockwise seen from outside). */
const QUADS = {
  px: [0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5],
  py: [-0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5],
  pz: [-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5],
};
const OPTS = { azimuth: 0.6, aspect: 4 / 3, padding: 1.4 };

describe('faceOnFraming', () => {
  it('one face: azimuth / elevation along its normal, target = its centre, half-height = fit × padding', () => {
    const f = faceOnFraming([QUADS.px], OPTS)!;
    expect(f.normal.map(v => +v.toFixed(9))).toEqual([1, 0, 0]);
    expect(f.azimuth).toBeCloseTo(Math.PI / 2, 9);
    expect(f.elevation).toBeCloseTo(0, 9);
    f.target.forEach((v, i) => expect(v).toBeCloseTo([0.5, 0, 0][i], 9));
    expect(f.halfHeight).toBeCloseTo(0.5 * 1.4, 9);                   // 1 tall, 1 wide (fits the height at 4:3)
    // a wide face: fitted by its width over the aspect
    const wide = [-2, -0.5, 0.5, 2, -0.5, 0.5, 2, 0.5, 0.5, -2, 0.5, 0.5];
    expect(faceOnFraming([wide], OPTS)!.halfHeight).toBeCloseTo(2 / (4 / 3) * 1.4, 9);
    // a tilted face
    const s = Math.SQRT1_2;
    const tilted = [0, -0.5, 0, s, -0.5, -s, s, 0.5, -s, 0, 0.5, 0];   // normal (s, 0, s)
    const g = faceOnFraming([tilted], OPTS)!;
    expect(g.azimuth).toBeCloseTo(Math.PI / 4, 9);
    // minHalf: a tiny face still shows some surroundings
    const tiny = QUADS.pz.map(v => v * 0.001);
    expect(faceOnFraming([tiny], { ...OPTS, minHalf: 0.1 })!.halfHeight).toBeCloseTo(0.1 * 1.4, 9);
  });

  it('a vertical normal (the top face): the current azimuth is kept (no spin), the elevation stops at the orbit limit', () => {
    const maxElevation = Math.PI / 2 - 0.05;
    const f = faceOnFraming([QUADS.py], { ...OPTS, maxElevation })!;
    expect(f.azimuth).toBe(0.6);
    expect(f.elevation).toBe(maxElevation);
    // nearly vertical, still within the pole limit's cone: same
    const n = faceOnFraming([[-0.5, 0.5, 0.5, 0.5, 0.5 - 0.01, 0.5, 0.5, 0.5 - 0.01, -0.5, -0.5, 0.5, -0.5]], { ...OPTS, maxElevation })!;
    expect(n.azimuth).toBe(0.6);
  });

  it('several faces: their average normal when they agree (a flat panel / a gentle curve); else null (no turn)', () => {
    // two coplanar halves of the +Z face
    const left = [-0.5, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, -0.5, 0.5, 0.5];
    const right = [0, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0, 0.5, 0.5];
    const f = faceOnFraming([left, right], OPTS)!;
    expect(f.azimuth).toBeCloseTo(0, 9);
    expect(f.elevation).toBeCloseTo(0, 9);
    f.target.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 0.5][i], 9));
    // +Z and a face turned 20° (agreement cos 10° ≈ 0.985): aims between them
    const a = 20 * Math.PI / 180;
    const turned = [0.5, -0.5, 0.5, 0.5 + Math.cos(a), -0.5, 0.5 - Math.sin(a), 0.5 + Math.cos(a), 0.5, 0.5 - Math.sin(a), 0.5, 0.5, 0.5];
    expect(faceOnFraming([QUADS.pz, turned], OPTS)!.azimuth).toBeCloseTo(a / 2, 6);
    // top + front (a corner): |n1 + n2| / 2 = 0.71 < the threshold → no turn
    expect(Math.SQRT1_2).toBeLessThan(FACE_ON_AGREE);
    expect(faceOnFraming([QUADS.py, QUADS.pz], OPTS)).toBeNull();
    // degenerate input
    expect(faceOnFraming([], OPTS)).toBeNull();
    expect(faceOnFraming([[0, 0, 0, 1, 1, 1]], OPTS)).toBeNull();
  });
});

/** The edit-view harness (edit-view-modes.test.ts, trimmed): a Scene3DArmature in Edit Mesh on a unit cube. */
function setup() {
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: {}, width: 800, height: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => false,
  });
  const canvas = el as unknown as HTMLCanvasElement;
  const camera = new Camera3D({ position: [0, 0, 10], target: [0, 0, 0] });
  camera.aspect = 800 / 600;
  camera.mode = 'orthographic';
  const callbacks = new Set<() => boolean>();
  let renders = 0;
  const r3 = { getCamera: () => camera, setMeshEditModeActive: () => {}, setArmatureModeActive: () => {} };
  const is = { cameraOwnsView: false, suppressBoxSelect: false, isPanToolSelected: false, getPanOffset: () => ({ x: 0, y: 0 }), getZoomFactor: () => 1 };
  const ctx = {
    webgpuRenderer: {
      getCanvas: () => canvas, getRenderer3D: () => r3,
      addPreRenderCallback: (cb: () => boolean) => { callbacks.add(cb); },
      removePreRenderCallback: (cb: () => boolean) => { callbacks.delete(cb); },
      touchZoom2D: () => {}, touchPan2D: () => {},
    },
    scheduleRender: () => { renders++; }, emitSceneGraphChanged: () => {}, interactionService: is,
  } as unknown as ManagerContext;
  let arm!: Scene3DArmature;
  const host = {
    getMeshCenter: (id: string | null) => (id === 'cube' ? [0, 0, 0] as [number, number, number] : null),
    getMesh: () => null, getAllMeshes: () => [], getSkeleton: () => null, getAllSkeletons: () => [],
    frameMesh: (id: string, padding = 1.25) => {
      if (id !== 'cube') return false;
      const p = camera.position, t = camera.target;
      const d = [p[0] - t[0], p[1] - t[1], p[2] - t[2]], len = Math.hypot(d[0], d[1], d[2]) || 1;
      camera.orthoSize = 0.5 * padding;
      camera.lookAt(d[0] / len * 4, d[1] / len * 4, d[2] / len * 4, 0, 0, 0);
      arm.getOrbitController()?.syncFromCamera();
      arm.reseedDecoupledZoom();
      return true;
    },
    ensureIdleCallback: () => {}, syncFocusBgLiveLoop: () => {}, springsActiveFor: () => false,
    character: { hasOverlayBody: () => false }, resolveOverlayToBody: (id: string) => id,
    weightPaint: { isActive: () => false }, picker: {}, undoManager: {}, isPlaying: false, cityModeActive: false,
  } as unknown as Scene3DArmatureHost;
  arm = new Scene3DArmature(ctx, host);
  (arm as unknown as { enableViewGizmo(): void }).enableViewGizmo = () => {};
  const frame = () => { for (const cb of [...callbacks]) cb(); };
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const advance = (ms: number) => { now += ms; frame(); };
  const viewDir = () => {
    const p = camera.position, t = camera.target;
    const d = [t[0] - p[0], t[1] - p[1], t[2] - p[2]], l = Math.hypot(d[0], d[1], d[2]);
    return d.map(v => v / l);
  };
  return { arm, camera, frame, advance, viewDir, renders: () => renders };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the animated face-on Frame on the edit camera', () => {
  it('one face: eases over ~250 ms to look along −normal, centred, fitted; the move completes and keeps the frames coming', () => {
    const t = setup();
    t.arm.enableMeshEditOrbit('cube');
    const orb = t.arm.getOrbitController()!;
    const az0 = orb.azimuth;
    const f = faceOnFraming([QUADS.px], { azimuth: orb.azimuth, aspect: t.camera.aspect, padding: 1.4, minElevation: orb.minElevation, maxElevation: orb.maxElevation })!;
    expect(t.arm.animateEditView({ target: f.target, azimuth: f.azimuth, elevation: f.elevation, zoom: 1 / f.halfHeight }, 250)).toBe(true);
    expect(t.arm.isEditViewAnimating).toBe(true);
    t.advance(0);
    expect(orb.azimuth).toBeCloseTo(az0, 9);                         // starts where it was
    const r0 = t.renders();
    t.advance(125);
    expect(t.arm.isEditViewAnimating).toBe(true);
    expect(t.renders()).toBeGreaterThan(r0);                         // (on-demand renderer: the next frame is asked for)
    const mid = orb.azimuth;
    expect(mid).toBeGreaterThan(Math.min(az0, Math.PI / 2) - 1e-9);
    expect(mid).toBeLessThan(Math.max(az0, Math.PI / 2) + 1e-9);
    t.advance(125);
    expect(t.arm.isEditViewAnimating).toBe(false);
    const d = t.viewDir();
    expect(d[0]).toBeCloseTo(-1, 6);                                 // looking along −normal
    expect(d[1]).toBeCloseTo(0, 6);
    expect(d[2]).toBeCloseTo(0, 6);
    Array.from(t.camera.target).forEach((v, i) => expect(v).toBeCloseTo([0.5, 0, 0][i], 6));
    expect(t.camera.orthoSize).toBeCloseTo(0.7, 6);
    expect(Array.from(t.camera.up)).toEqual([0, 1, 0]);               // roll-free
    // the next frames leave it there; the edit view's own zoom is the framed one (zoom / pan carry on from it)
    t.advance(16);
    expect(t.camera.orthoSize).toBeCloseTo(0.7, 6);
    expect(t.arm.zoomEditView(2)).toBe(true);
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(0.35, 6);
  });

  it('the top face from a 3/4 view: only the elevation turns (azimuth kept); the azimuth turns the short way round', () => {
    const t = setup();
    t.arm.enableMeshEditOrbit('cube');
    const orb = t.arm.getOrbitController()!;
    const az0 = orb.azimuth;
    const f = faceOnFraming([QUADS.py], { azimuth: orb.azimuth, aspect: t.camera.aspect, padding: 1.4, minElevation: orb.minElevation, maxElevation: orb.maxElevation })!;
    t.arm.animateEditView({ target: f.target, azimuth: f.azimuth, elevation: f.elevation, zoom: 1 / f.halfHeight }, 250);
    t.advance(0); t.advance(300);
    expect(orb.azimuth).toBeCloseTo(az0, 9);
    expect(orb.elevation).toBeCloseTo(orb.maxElevation, 9);
    expect(t.viewDir()[1]).toBeLessThan(-0.99);
    // from azimuth 3 to −3: through ±π (0.28 rad), not through 0 (5.7 rad)
    orb.setSpherical(3, 0.2);
    t.arm.animateEditView({ target: [0, 0, 0], azimuth: -3, elevation: 0.2, zoom: 1 }, 250);
    t.advance(0); t.advance(125);
    expect(Math.abs(orb.azimuth)).toBeGreaterThan(3 - 1e-9);
    t.advance(200);
    expect(Math.cos(orb.azimuth)).toBeCloseTo(Math.cos(-3), 9);
    expect(Math.sin(orb.azimuth)).toBeCloseTo(Math.sin(-3), 9);
  });

  it('the user moving the camera mid-move stops it there; ms 0 jumps; outside an edit view: false', () => {
    const t = setup();
    expect(t.arm.animateEditView({ target: [0, 0, 0], azimuth: 1, elevation: 0, zoom: 1 }, 250)).toBe(false);
    t.arm.enableMeshEditOrbit('cube');
    const orb = t.arm.getOrbitController()!;
    t.arm.animateEditView({ target: [0.5, 0, 0], azimuth: Math.PI / 2, elevation: 0, zoom: 2 }, 250);
    t.advance(0); t.advance(100);
    orb.azimuth += 0.3;                                              // an orbit drag
    const az = orb.azimuth;
    t.advance(16);
    expect(t.arm.isEditViewAnimating).toBe(false);
    expect(orb.azimuth).toBe(az);
    t.advance(300);
    expect(orb.azimuth).toBe(az);
    // instant
    t.arm.animateEditView({ target: [0, 0.5, 0], azimuth: 0, elevation: 0, zoom: 4 }, 0);
    expect(t.arm.isEditViewAnimating).toBe(false);
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(0.25, 9);
    expect(t.camera.target[1]).toBeCloseTo(0.5, 6);
    // leaving the edit view drops a running move
    t.arm.animateEditView({ target: [0, 0, 0], azimuth: 1, elevation: 0, zoom: 1 }, 250);
    t.arm.disableMeshEditOrbit();
    expect(t.arm.isEditViewAnimating).toBe(false);
  });
});
