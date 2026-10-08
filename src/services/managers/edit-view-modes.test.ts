/**
 * The edit camera shared by Edit Mesh, the UV editor and the Armature (round-3 feedback 2026-10-08):
 *  - the ARMATURE CAMERA JUMP: entering the Armature framed the mesh, but it still followed the 2D view — the next 2D
 *    pan / zoom (the 2D sync), "Add skeleton" (showBoneOverlay3D reset the camera to the 2D view) and the per-frame
 *    orbit update (orthoSize = 1 / 2D zoom) snapped it back, so the mesh shrank. It now owns a decoupled ortho view
 *    like Edit Mesh: framed once, then only the user's orbit / pan / zoom move it;
 *  - Frame / zoom of the edit view (the host's zoom box): frameEditView, zoomEditView, getEditViewZoom;
 *  - direct mode switches in any order (Edit Mesh ↔ Armature ↔ UV ↔ the scene), repeated: no leaked pre-render
 *    callbacks / canvas listeners / orbit controller, cameraOwnsView + suppressBoxSelect back to where they were, the
 *    camera kept across a switch on the same mesh, and a late Armature teardown never breaks an Edit Mesh that is up.
 */
import { describe, it, expect } from 'vitest';
import { Scene3DArmature, type Scene3DArmatureHost, ARMATURE_VIEW_PADDING, EDIT_VIEW_PADDING } from './scene3d-armature';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { OrbitController } from '../../renderer/3d/orbit-controller';
import type { ManagerContext } from './manager-context';

/** A canvas that counts its live listeners. */
function fakeCanvas() {
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  const live = new Map<string, number>();
  const handlers = new Map<unknown, string[]>();
  const add = el.addEventListener.bind(el), rem = el.removeEventListener.bind(el);
  el.addEventListener = ((t: string, h: EventListener, o?: boolean | AddEventListenerOptions) => {
    const k = `${t}|${typeof o === 'object' ? !!o.capture : !!o}`;
    const list = handlers.get(h) ?? [];
    if (!list.includes(k)) { list.push(k); handlers.set(h, list); live.set(k, (live.get(k) ?? 0) + 1); }
    add(t, h, o);
  }) as typeof el.addEventListener;
  el.removeEventListener = ((t: string, h: EventListener, o?: boolean | EventListenerOptions) => {
    const k = `${t}|${typeof o === 'object' ? !!o.capture : !!o}`;
    const list = handlers.get(h);
    if (list?.includes(k)) { list.splice(list.indexOf(k), 1); live.set(k, (live.get(k) ?? 1) - 1); }
    rem(t, h, o);
  }) as typeof el.removeEventListener;
  Object.assign(el, {
    style: {}, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => false,
  });
  const count = () => [...live.values()].reduce((a, b) => a + b, 0);
  return { canvas: el as unknown as HTMLCanvasElement, count };
}

function setup() {
  const { canvas, count: listeners } = fakeCanvas();
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
    scheduleRender: () => {},
    emitSceneGraphChanged: () => {},
    interactionService: is,
  } as unknown as ManagerContext;
  // a unit cube at the origin and a second one off to the side
  const boxes: Record<string, [number, number, number]> = { cube: [0, 0, 0], other: [3, 0, 0] };
  let arm!: Scene3DArmature;
  const frames: Array<{ id: string; padding: number }> = [];
  const host = {
    getMeshCenter: (id: string | null) => (id && boxes[id] ? [...boxes[id]] as [number, number, number] : null),
    getMesh: () => null, getAllMeshes: () => [],
    getSkeleton: (id: string) => (id === 'skel' ? { id, data: { joints: [], ikChains: [] } } : null),
    getAllSkeletons: () => [],
    // frameWorldBounds3D in short: centre the box from the current direction, orthoSize = half the cube × padding
    frameMesh: (id: string, padding = 1.25) => {
      const c = boxes[id];
      if (!c) return false;
      frames.push({ id, padding });
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
    isPlaying: false, cityModeActive: false,
  } as unknown as Scene3DArmatureHost;
  arm = new Scene3DArmature(ctx, host);
  (arm as unknown as { enableViewGizmo(): void }).enableViewGizmo = () => {};   // (DOM-only)
  const frame = () => { for (const cb of [...callbacks]) cb(); };
  /** The 2D view's sync (the illustration auto-sync callback calls this on every 2D pan / zoom change). */
  const sync2D = (panX: number, panY: number, zoom: number) => arm.syncIllustrationCamera(panX, panY, zoom, 800, 600);
  const wheel = (deltaY: number) => {
    const e = new Event('wheel', { cancelable: true });
    Object.assign(e, { deltaY, deltaMode: 0 });
    canvas.dispatchEvent(e);
  };
  return { arm, camera, is, callbacks, listeners, frame, sync2D, wheel, frames, canvas };
}

const target = (c: Camera3D) => Array.from(c.target).map(v => +v.toFixed(5));

describe('Armature edit camera (the camera jump)', () => {
  it('entry frames the mesh once; 2D pan / zoom, Add skeleton and every frame after leave it alone', () => {
    const t = setup();
    t.sync2D(0, 0, 0.2);                       // the 2D view zoomed out: orthoSize 5 — the cube is small there
    expect(t.camera.orthoSize).toBeCloseTo(5, 6);
    t.arm.enterArmatureMode3D('cube');
    expect(t.frames).toEqual([{ id: 'cube', padding: ARMATURE_VIEW_PADDING }]);
    const framed = t.camera.orthoSize;
    expect(framed).toBeCloseTo(0.5 * ARMATURE_VIEW_PADDING, 6);
    expect(t.camera.mode).toBe('orthographic');
    expect(t.is.cameraOwnsView).toBe(true);
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(framed, 6);
    // the 2D view pans / zooms (the old sync re-applied the 2D camera here)
    t.sync2D(120, -40, 0.35);
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(framed, 6);
    expect(target(t.camera)).toEqual([0, 0, 0]);
    // Add skeleton: the overlay shows (it reset the camera to the 2D view and then followed the 2D zoom)
    t.arm.showBoneOverlay3D('skel', 'cube');
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(framed, 6);
    expect(target(t.camera)).toEqual([0, 0, 0]);
    t.arm.enterBonePlacementMode3D('skel');
    t.sync2D(-300, 80, 0.1);
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(framed, 6);
    expect(t.frames).toHaveLength(1);         // never re-framed
  });

  it('the wheel / pinch / zoom box zoom the armature view itself, never the 2D zoom; Frame re-frames', () => {
    const t = setup();
    t.sync2D(0, 0, 0.2);
    t.arm.enterArmatureMode3D('cube');
    const framed = t.camera.orthoSize;
    t.wheel(-100);                              // one notch in
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(framed / 1.1, 6);
    t.arm.getOrbitController()!.pinch(2);       // fingers apart: zoom in ×2 (ortho → the view's own zoom)
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(framed / 2.2, 6);
    expect(t.arm.getEditViewZoom()).toBeCloseTo(2.2, 6);
    expect(t.arm.zoomEditView(1 / 2.2)).toBe(true);
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(framed, 6);
    expect(t.arm.getEditViewZoom()).toBeCloseTo(1, 6);
    t.arm.zoomEditView(3);
    expect(t.arm.frameEditView()).toBe(true);   // Frame: the entry framing again, 100 %
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(framed, 6);
    expect(t.arm.getEditViewZoom()).toBeCloseTo(1, 6);
    expect(t.frames.map(f => f.padding)).toEqual([ARMATURE_VIEW_PADDING, ARMATURE_VIEW_PADDING]);
  });

  it('leaving gives the camera back to the 2D view; outside an edit view the zoom API is inert', () => {
    const t = setup();
    t.sync2D(0, 0, 0.2);
    t.arm.enterArmatureMode3D('cube');
    t.arm.showBoneOverlay3D(null);
    expect(t.arm.editViewOwner).toBeNull();
    expect(t.is.cameraOwnsView).toBe(false);
    t.sync2D(0, 0, 0.25);
    expect(t.camera.orthoSize).toBeCloseTo(4, 6);  // the 2D camera again
    expect(t.arm.zoomEditView(2)).toBe(false);
    expect(t.arm.getEditViewZoom()).toBeNull();
    expect(t.arm.frameEditView()).toBe(false);
  });

  it('Edit Mesh Frame uses the Edit Mesh entry framing', () => {
    const t = setup();
    t.arm.enableMeshEditOrbit('cube');
    t.arm.zoomEditView(4);
    expect(t.arm.frameEditView()).toBe(true);
    expect(t.frames.at(-1)).toEqual({ id: 'cube', padding: EDIT_VIEW_PADDING });
    expect(t.arm.getEditViewZoom()).toBeCloseTo(1, 6);
  });
});

type Mode = 'mesh' | 'uv' | 'arm' | 'scene';
/** Enter / leave a mode the way the hosts do (Edit Mesh and the UV editor both run enableMeshEditOrbit). */
function enter(t: ReturnType<typeof setup>, m: Mode): void {
  if (m === 'mesh' || m === 'uv') t.arm.enableMeshEditOrbit('cube');
  else if (m === 'arm') { t.arm.enterArmatureMode3D('cube'); t.arm.showBoneOverlay3D('skel', 'cube'); }
}
function leave(t: ReturnType<typeof setup>, m: Mode): void {
  if (m === 'mesh' || m === 'uv') t.arm.disableMeshEditOrbit();
  else if (m === 'arm') t.arm.showBoneOverlay3D(null);
}

describe('Direct mode switches (Edit Mesh ↔ Armature ↔ UV ↔ scene)', () => {
  const sequences: Mode[][] = [
    ['mesh', 'arm'], ['arm', 'mesh'], ['mesh', 'uv'], ['uv', 'arm'], ['arm', 'uv'],
    ['mesh', 'arm', 'mesh'], ['arm', 'mesh', 'arm'], ['mesh', 'uv', 'arm'], ['arm', 'uv', 'mesh'], ['uv', 'mesh', 'arm', 'scene'],
  ];
  for (const seq of sequences) {
    it(`${seq.join(' → ')} ×20: no leaks, state back to the scene's`, () => {
      const t = setup();
      t.sync2D(0, 0, 0.2);
      t.is.cameraOwnsView = false;
      t.is.suppressBoxSelect = false;
      const baseCallbacks = t.callbacks.size, baseListeners = t.listeners();
      for (let round = 0; round < 20; round++) {
        let cur: Mode = 'scene';
        for (const m of seq) {
          leave(t, cur);
          enter(t, m);
          cur = m;
          t.frame();
          if (m !== 'scene') {
            // the edit camera is up and owned by the mode that just entered
            expect(t.arm.editViewOwner).toBe(m === 'arm' ? 'armature' : 'meshEdit');
            expect(t.is.cameraOwnsView).toBe(true);
            expect(t.arm.getOrbitController()).toBeDefined();
            expect(t.camera.mode).toBe('orthographic');
          }
        }
        leave(t, cur);
        t.frame();
        expect(t.arm.editViewOwner).toBeNull();
        expect(t.arm.getOrbitController()).toBeUndefined();
        expect(t.is.cameraOwnsView).toBe(false);
        expect(t.is.suppressBoxSelect).toBe(false);
        expect(t.callbacks.size).toBe(baseCallbacks);
        expect(t.listeners()).toBe(baseListeners);
      }
    });
  }

  it('a switch on the same mesh keeps the camera both ways (Edit Mesh → Armature → Edit Mesh)', () => {
    const t = setup();
    t.arm.enableMeshEditOrbit('cube');
    const oc = t.arm.getOrbitController()!;
    oc.setSpherical(1.1, 0.2);
    t.arm.zoomEditView(2);
    t.frame();
    const size = t.camera.orthoSize;
    t.arm.disableMeshEditOrbit();
    t.arm.enterArmatureMode3D('cube');
    t.frame();
    expect(t.arm.getOrbitController()!.azimuth).toBeCloseTo(1.1, 6);
    expect(t.camera.orthoSize).toBeCloseTo(size, 6);
    expect(t.arm.getEditViewZoom()).toBeCloseTo(2, 6);    // still relative to the Edit Mesh framing
    t.arm.getOrbitController()!.setSpherical(-0.4, 0.1);
    t.arm.showBoneOverlay3D(null);
    t.arm.enableMeshEditOrbit('cube');
    t.frame();
    expect(t.arm.getOrbitController()!.azimuth).toBeCloseTo(-0.4, 6);
    expect(t.camera.orthoSize).toBeCloseTo(size, 6);
  });

  it('a LATE Armature teardown (the host entered Edit Mesh first) leaves Edit Mesh working', () => {
    const t = setup();
    t.sync2D(0, 0, 0.2);
    t.arm.enterArmatureMode3D('cube');
    t.arm.showBoneOverlay3D('skel', 'cube');
    t.arm.enableMeshEditOrbit('cube');          // Edit Mesh entered before the Armature's teardown ran
    const oc = t.arm.getOrbitController();
    t.arm.showBoneOverlay3D(null);
    expect(t.arm.getOrbitController()).toBe(oc);   // not torn down
    expect(t.arm.editViewOwner).toBe('meshEdit');
    expect(t.is.cameraOwnsView).toBe(true);
    expect(t.is.suppressBoxSelect).toBe(true);
    const size = t.camera.orthoSize;
    t.wheel(-100);
    t.frame();
    expect(t.camera.orthoSize).toBeCloseTo(size / 1.1, 6);   // its wheel zoom still works
    t.arm.disableMeshEditOrbit();
    expect(t.arm.getOrbitController()).toBeUndefined();
    expect(t.is.cameraOwnsView).toBe(false);
  });

  it('every edit view enables edit navigation on its orbit controller; the scene orbit does not', () => {
    const t = setup();
    t.arm.enableMeshEditOrbit('cube');
    expect(t.arm.getOrbitController()!.editNavActive).toBe(true);
    t.arm.disableMeshEditOrbit();
    t.arm.enterArmatureMode3D('cube');
    expect(t.arm.getOrbitController()!.editNavActive).toBe(true);
    t.arm.showBoneOverlay3D(null);
    const scene = t.arm.enableOrbitControls({});
    expect(scene).toBeInstanceOf(OrbitController);
    expect(scene.editNavActive).toBe(false);
  });
});

describe('Edit-view orbit pivot (notes 2026-10-08 #1)', () => {
  const pointer = (canvas: HTMLCanvasElement, type: string, x: number, y: number) => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, altKey: true, isPrimary: true });
    canvas.dispatchEvent(e);
  };
  const viewXY = (c: Camera3D, p: [number, number, number]) => {
    const m = c.getViewMatrix() as unknown as Float32Array;
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]];
  };

  it('Edit Mesh: the selection centre, else the mesh bounds centre; the scene: none', () => {
    const t = setup();
    expect(t.arm.getEditOrbitPivot()).toBeNull();
    t.arm.enableMeshEditOrbit('other');
    expect(t.arm.getEditOrbitPivot()).toEqual([3, 0, 0]);                 // nothing selected: the mesh's centre
    t.arm.editSelectionPivotProvider = () => [3.4, 0.2, -0.1];
    expect(t.arm.getEditOrbitPivot()).toEqual([3.4, 0.2, -0.1]);
    t.arm.editSelectionPivotProvider = () => null;
    expect(t.arm.getEditOrbitPivot()).toEqual([3, 0, 0]);
    t.arm.disableMeshEditOrbit();
    expect(t.arm.getEditOrbitPivot()).toBeNull();
  });

  it('Armature with no joint selected: the mesh bounds centre', () => {
    const t = setup();
    t.arm.enterArmatureMode3D('other');
    expect(t.arm.getEditOrbitPivot()).toEqual([3, 0, 0]);
  });

  it('an Alt+drag orbit in Edit Mesh turns around the selection: it keeps its place on screen through the frames', () => {
    const t = setup();
    t.arm.enableMeshEditOrbit('cube');
    const P: [number, number, number] = [0.5, 0.5, 0.5];                   // a selected corner
    t.arm.editSelectionPivotProvider = () => P;
    t.frame();
    const before = viewXY(t.camera, P), az0 = t.arm.getOrbitController()!.azimuth;
    pointer(t.canvas, 'pointerdown', 100, 100);
    t.frame();
    viewXY(t.camera, P).forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));   // no jump at the start
    pointer(t.canvas, 'pointermove', 180, 140);
    pointer(t.canvas, 'pointerup', 180, 140);
    for (let i = 0; i < 200; i++) t.frame();                                 // momentum runs out
    viewXY(t.camera, P).forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));
    expect(Math.abs(t.arm.getOrbitController()!.azimuth - az0)).toBeGreaterThan(0.2);   // it did turn
  });
});
