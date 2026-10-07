/**
 * mobile-parity 7.3c: the engine outlives every route, so a free3D camera / Play / Edit Mesh left on by the
 * illustration editor carried into a BOARD (its orbit controller re-attached to the board's canvas and owned pan /
 * zoom). ShapeManager.resetTo2DEditingView + Scene3DManager.resetToDefaultView3D put the engine back into the plain
 * 2D editing view. These tests run the real methods (and the real _applyViewState) against stubs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scene3DManager } from './scene3d-manager';
import { DEFAULT_VIEW_STATE, type ViewState } from './view-state';
import ShapeManager from '../shape-manager';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

type Fn = (...a: unknown[]) => unknown;
const proto = Scene3DManager.prototype as unknown as Record<string, Fn>;

/** A Scene3DManager stand-in left in illustration × free3D with a remembered orbit pose, a camera preview and the
 *  armature overlay on: the state the illustration editor leaves behind. `_applyViewState` is the REAL one. */
function scene3dLeftInFree3D() {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push(args.length ? `${name}(${JSON.stringify(args)})` : name); };
  const is = { cameraOwnsView: true };
  const cam = { mode: 'perspective' as string };
  const stub = {
    _viewState: {
      target: 'illustration', cameraMode: 'free3D', showArtboardFrame: true, showArtboardTexture: true,
      freeCam: { target: [1, 2, 3], radius: 4, yaw: 0.5, pitch: 0.2, projection: 'perspective' },
      flatCam: { panX: 10, panY: 20, zoom: 2 },
    } as ViewState,
    _viewChangedInPlay: true,
    _flyLookHeld: true,
    _cityModeActive: false,
    _previewThroughCameras: true,
    _lookThroughCamId: null as string | null,
    ctx: { interactionService: is, scheduleRender: rec('render') },
    renderer3D: { getCamera: () => cam, setMeshEditModeActive: rec('meshEditBg'), setMeshEditBgMode: rec('bgMode') },
    _armature: {
      isBoneOverlayActive: () => true,
      exitMeshOrbit3D: rec('exitMeshOrbit'),
      setMeshEditOrbitCenter: rec('orbitCenter'),
      getOrbitController: () => undefined,
    },
    onViewStateChanged: { emit: rec('viewChanged') },
    exitPlayMode3D: rec('exitPlay'),
    showBoneOverlay3D: rec('boneOverlay'),
    setPreviewThroughCameras3D: rec('preview'),
    lookThroughCamera3D: rec('lookThrough'),
    disableTransformControls: rec('transformControlsOff'),
    setHoveredMesh: rec('hover'),
    clearSelection: rec('selection'),
    disableOrbitControls: rec('orbitOff'),
    enableOrbitControls: rec('orbitOn'),
    enableViewGizmo: rec('gizmoOn'),
    setIllustrationProjection: rec('projection'),
    _forceIllustrationResync: rec('resync'),
    _applyArtboardFrame: rec('artboardFrame'),
    _applyFly: rec('fly'),
    _refreshArtboardTexture: async () => { calls.push('artboardTexture'); },
    _applyViewState: proto._applyViewState,
  };
  return { stub, calls, is, cam };
}

describe('Scene3DManager.resetToDefaultView3D', () => {
  it('ends the camera-owning modes, then applies the DEFAULT view: orbit + gizmo released, 2D owns pan / zoom again', () => {
    const { stub, calls, is } = scene3dLeftInFree3D();
    proto.resetToDefaultView3D.call(stub);

    expect(stub._viewState).toEqual(DEFAULT_VIEW_STATE);           // illustration × ortho2D, no remembered free / flat pose
    expect(is.cameraOwnsView).toBe(false);                         // 2D wheel / drag / pinch reach the 2D view again
    for (const c of ['exitPlay', 'boneOverlay([null])', 'preview([false])', 'exitMeshOrbit', 'transformControlsOff',
                     'hover([null])', 'selection', 'orbitOff', 'meshEditBg([false])', 'orbitCenter([null])',
                     'projection(["orthographic"])', 'resync', 'fly', 'viewChanged', 'artboardTexture']) {
      expect(calls).toContain(c);
    }
    expect(calls).not.toContain('orbitOn');
    expect(calls).not.toContain('gizmoOn');
    expect(calls).not.toContain('lookThrough');                    // not looking through a camera: nothing to exit
    // The mode exits run BEFORE the view is applied (the mesh-orbit exit hands back its cameraOwnsView claim first).
    expect(calls.indexOf('exitMeshOrbit')).toBeLessThan(calls.indexOf('orbitOff'));
    expect(stub._viewChangedInPlay).toBe(false);
    expect(stub._flyLookHeld).toBe(false);
  });

  it('is idempotent: a second call leaves the default view as it is', () => {
    const { stub, is } = scene3dLeftInFree3D();
    proto.resetToDefaultView3D.call(stub);
    proto.resetToDefaultView3D.call(stub);
    expect(stub._viewState).toEqual(DEFAULT_VIEW_STATE);
    expect(is.cameraOwnsView).toBe(false);
  });

  it('ends a camera look-through when one is active', () => {
    const { stub, calls } = scene3dLeftInFree3D();
    stub._lookThroughCamId = 'cam-1';
    proto.resetToDefaultView3D.call(stub);
    expect(calls).toContain('lookThrough([null])');
  });
});

describe('ShapeManager.resetTo2DEditingView', () => {
  function engine(o: { playing?: boolean; meshEdit?: boolean; uvSessions?: number; uvPaint?: boolean; uiPlayer?: boolean; bonePlacement?: boolean } = {}) {
    const calls: string[] = [];
    const rec = (name: string) => () => { calls.push(name); };
    const scene3d = {
      isPlaying3D: o.playing ?? false,
      isBonePlacementModeActive3D: () => o.bonePlacement ?? false,
      exitBonePlacementMode3D: rec('exitBonePlacement'),
      exitWeightPaintMode3D: rec('exitWeightPaint'),
      exitGpDrawMode: rec('exitGpDraw'),
      exitGpFaceSelectMode: rec('exitGpFace'),
      resetToDefaultView3D: rec('defaultView'),
    };
    const self = {
      scene3d,
      _uiPlayerMode: o.uiPlayer ?? false,
      isMeshEditMode3D: o.meshEdit ?? false,
      _uvSessions: new Map(Array.from({ length: o.uvSessions ?? 0 }, (_, i) => [`m${i}`, {}])),
      uvPaint: { isActive: () => o.uvPaint ?? false },
      exitPlayMode3D: rec('exitPlay'),
      exitUIPlayerMode: rec('exitUIPlayer'),
      detachMeshEditPointerHandlers: rec('detachMeshEditPointers'),
      exitMeshEditMode3D: rec('exitMeshEdit'),
      closeAllUVEditors3D: rec('closeUV'),
      exitCreatorStage3D: rec('exitCreatorStage'),
      exitCDDesigner3D: rec('exitCD'),
      exitDecalPlaceMode3D: rec('exitDecalPlace'),
      scheduleRender: rec('render'),
    };
    return { self, calls };
  }

  it('exits Play, the UI player, Edit Mesh and the UV editor when they are on, then resets the 3D view', () => {
    const { self, calls } = engine({ playing: true, meshEdit: true, uvSessions: 1, uiPlayer: true, bonePlacement: true });
    ShapeManager.prototype.resetTo2DEditingView.call(self as never);
    for (const c of ['exitPlay', 'exitUIPlayer', 'detachMeshEditPointers', 'exitMeshEdit', 'closeUV', 'exitCreatorStage', 'exitCD',
                     'exitBonePlacement', 'exitWeightPaint', 'exitGpDraw', 'exitGpFace', 'exitDecalPlace', 'defaultView', 'render']) {
      expect(calls).toContain(c);
    }
    // The view reset comes last: every mode has handed its camera / cameraOwnsView claim back by then.
    expect(calls.indexOf('defaultView')).toBe(calls.length - 2);
  });

  it('skips the exits whose mode is off (no Play stop, no mesh-edit exit, no UV close)', () => {
    const { self, calls } = engine();
    ShapeManager.prototype.resetTo2DEditingView.call(self as never);
    for (const c of ['exitPlay', 'exitUIPlayer', 'exitMeshEdit', 'closeUV', 'exitBonePlacement']) expect(calls).not.toContain(c);
    expect(calls).toContain('detachMeshEditPointers');   // cheap + idempotent: always released
    expect(calls).toContain('defaultView');
  });

  it('UV paint without an open session still closes the UV editors', () => {
    const { self, calls } = engine({ uvPaint: true });
    ShapeManager.prototype.resetTo2DEditingView.call(self as never);
    expect(calls).toContain('closeUV');
  });

  it('a failing exit does not stop the rest: the view is still reset', () => {
    const { self, calls } = engine({ playing: true });
    self.exitPlayMode3D = () => { throw new Error('boom'); };
    self.exitCreatorStage3D = () => { throw new Error('boom'); };
    ShapeManager.prototype.resetTo2DEditingView.call(self as never);
    expect(calls).toContain('defaultView');
    expect(console.warn).toHaveBeenCalled();
  });
});
