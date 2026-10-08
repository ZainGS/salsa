/**
 * Tablet feedback 2026-10-08 (pen, Armature mode):
 *  - hovering the mesh showed the animated blue hover outline (and the FPS sank: the outline held the on-demand render
 *    loop live — a full scene render + the silhouette mask + its full-screen composite every frame — and every pen
 *    hover frame ran a full-scene raycast). Now NO object hover highlight (and no hover raycast) in any edit mode:
 *    Edit Mesh / UV (the mesh-edit checker or the edit camera), the Armature (overlay or armature mode, with or without a
 *    skeleton), Grease Pencil drawing;
 *  - the hover outline's animation keeps the loop live only for HOVER_ANIM_HOLD_MS after the hover changed / the pointer
 *    last moved over it — a pointer RESTING on a mesh no longer keeps the GPU busy forever (the normal scene too).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scene3DArmature, type Scene3DArmatureHost } from './scene3d-armature';
import { Renderer3D } from '../../renderer/3d/renderer-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import type { ManagerContext } from './manager-context';

afterEach(() => { vi.restoreAllMocks(); });

function setup() {
  const camera = new Camera3D({ position: [0, 0, 10], target: [0, 0, 0] });
  let hovered = new Set<string>();
  const r3 = {
    getCamera: () => camera,
    armatureModeActive: false,
    setHoveredMeshIds: (ids: Set<string>) => { hovered = new Set(ids); },
    getHoveredMeshIds: () => hovered,
    setHoveredArrayGroupId: () => {},
    hoverOutlineAnimated: true, hoverOutlineAnimExpired: false,
    refreshHoverOutlineAnim: vi.fn(),
  };
  let interactive = 0;
  const ctx = {
    webgpuRenderer: { getCanvas: () => null, getRenderer3D: () => r3, addPreRenderCallback: () => {}, removePreRenderCallback: () => {} },
    scheduleRender: () => {},
    emitSceneGraphChanged: () => {},
    sceneGraph: { findNodeById: () => null },
    interactionService: { beginInteractive: () => { interactive++; }, endInteractive: () => { interactive--; } },
  } as unknown as ManagerContext;
  const pick = vi.fn(() => ({ meshId: 'body', hitPoint: [0, 0, 0], faceNormal: [0, 0, 1], triangleIndex: 0, distance: 1 }));
  const host = {
    getMesh: () => null, getMeshGroup: () => null, getAllMeshes: () => [], getSkeleton: () => null, getAllSkeletons: () => [],
    pick3D: pick, gpDrawActive: false, isPlaying: false, cityModeActive: false,
    ensureIdleCallback: () => {}, syncFocusBgLiveLoop: () => {}, springsActiveFor: () => false,
  } as unknown as Scene3DArmatureHost & { gpDrawActive: boolean };
  const arm = new Scene3DArmature(ctx, host);
  const hover = (x = 100, y = 100) => (arm as unknown as { _armHover(x: number, y: number, w: number, h: number): void })._armHover(x, y, 800, 600);
  return { arm, r3, host, pick, hover, hovered: () => [...hovered], interactive: () => interactive };
}

describe('edit modes: no object hover highlight, no hover raycast', () => {
  it('the normal scene hovers as before (pick + outline), with no begin/endInteractive hold', () => {
    const t = setup();
    expect(t.arm.isObjectInputLocked()).toBe(false);
    t.hover();
    expect(t.pick).toHaveBeenCalledTimes(1);
    expect(t.hovered()).toEqual(['body']);
    expect(t.interactive()).toBe(0);              // the self-evaluating 'hoverOutline' callback keeps frames flowing
    t.hover(110, 100);                             // same mesh: no re-set…
    expect(t.r3.refreshHoverOutlineAnim).not.toHaveBeenCalled();
    t.r3.hoverOutlineAnimExpired = true;           // …until its animation hold ran out: a move re-arms it
    t.hover(120, 100);
    expect(t.r3.refreshHoverOutlineAnim).toHaveBeenCalledTimes(1);
  });

  for (const [name, lock] of [
    ['Edit Mesh / UV (the mesh-edit checker)', (t: ReturnType<typeof setup>) => t.arm.setMeshEditModeChecker(() => true)],
    ['the Armature before a skeleton (armature mode)', (t: ReturnType<typeof setup>) => { t.r3.armatureModeActive = true; }],
    ['the Armature with its overlay', (t: ReturnType<typeof setup>) => { (t.arm as unknown as { _boneOverlayExplicit: boolean })._boneOverlayExplicit = true; }],
    ['the shared edit camera (Edit Mesh / UV / Armature)', (t: ReturnType<typeof setup>) => { (t.arm as unknown as { _editViewOwner: string })._editViewOwner = 'armature'; }],
    ['Grease Pencil drawing', (t: ReturnType<typeof setup>) => { (t.host as { gpDrawActive: boolean }).gpDrawActive = true; }],
  ] as const) {
    it(`${name}: no hover pick, no outline, a stale hover is cleared, setHoveredMesh refuses`, () => {
      const t = setup();
      t.hover();                                   // hovering in the scene…
      expect(t.hovered()).toEqual(['body']);
      lock(t);                                     // …then the mode opens
      expect(t.arm.isObjectInputLocked()).toBe(true);
      t.pick.mockClear();
      t.hover();
      expect(t.pick).not.toHaveBeenCalled();       // no full-scene raycast per hover frame
      expect(t.hovered()).toEqual([]);             // the outline is gone
      t.arm.setHoveredMesh('body');                // any other source (outliner hover) is refused too
      expect(t.hovered()).toEqual([]);
    });
  }
});

describe('Renderer3D: the animated hover outline holds the loop only briefly', () => {
  it('active right after the hover starts; idle after HOVER_ANIM_HOLD_MS; a refresh re-arms it', () => {
    let now = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const r = Object.create(Renderer3D.prototype) as Renderer3D & Record<string, unknown>;
    Object.assign(r, {
      _hoverOutlineStyle: { speed: 1 }, _hoverOutlineRanges: null, _hoveredMeshIds: new Set(), _selectedMeshIds: new Set(),
      _hoverAnimT: -Infinity,
    });
    expect(r.hoverOutlineActive).toBe(false);
    r.setHoveredMeshIds(new Set(['m']));
    expect(r.hoverOutlineActive).toBe(true);
    now += Renderer3D.HOVER_ANIM_HOLD_MS - 1;
    expect(r.hoverOutlineActive).toBe(true);
    now += 2;
    expect(r.hoverOutlineActive).toBe(false);     // resting pointer: the loop may idle (the outline stays drawn)
    expect(r.hoverOutlineAnimExpired).toBe(true);
    r.refreshHoverOutlineAnim();                  // the pointer moved over it again
    expect(r.hoverOutlineActive).toBe(true);
    (r as unknown as { _hoverOutlineStyle: { speed: number } })._hoverOutlineStyle.speed = 0;   // a static style never holds it
    expect(r.hoverOutlineActive).toBe(false);
  });
});
