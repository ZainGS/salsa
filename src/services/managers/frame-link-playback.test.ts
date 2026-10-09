/**
 * Timeline playback of Frame Link / keyframed meshes (docs/reviews/playback-perf-2026-10-09.md):
 *  - E4: a transform-only frame asks the renderer for the TRANSFORMS fast path (markTransformsDirty — no full repack, no
 *    generation bump, no stale shadow map), assigns each mesh's transform in ONE call (one matrix version bump per
 *    frame, was up to 9), re-versions descendant meshes so the fast path rewrites them too; colour / opacity /
 *    visibility tracks still take the full path.
 *  - E10: a save while a Frame Link mesh is mid-animation writes its REST transform, so the reload re-captures the
 *    right rest (it used to bake the displacement in → a permanent offset); a mesh moved since the link posed it saves
 *    its live transform.
 */
import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Scene3DManager } from './scene3d-manager';
import { buildDocumentMeshState } from '../persistence/document-mesh-json';
import { DEFAULT_FRAME_LINK_ANIMATION_3D, type FrameLinkAnimation3D, createFrameLinkEval3D, evalFrameLink3D, sampleVec3TrackInto, sampleTrack, interpolateVec3, type Keyframe, type Vec3Value } from '../../types/keyframe-3d';
import type { InteractionService } from '../interaction-service';

const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const box = (x = 0, y = 0, z = 0) => new Mesh3D(isvc, x, y, z, { primitive: 'box' } as never);

/** A Scene3DManager `this` with just what the keyframe pass and the save hook read. */
function host(meshes: Mesh3D[], links: Record<string, Partial<FrameLinkAnimation3D>>) {
  const renderer3D = { markInstancesDirty: vi.fn(), markTransformsDirty: vi.fn(), getCamera: () => ({}) };
  const frameLinkAnims = new Map<string, FrameLinkAnimation3D>();
  for (const [id, a] of Object.entries(links)) frameLinkAnims.set(id, { ...DEFAULT_FRAME_LINK_ANIMATION_3D, enabled: true, ...a });
  const proto = Object.create(Scene3DManager.prototype);
  Object.defineProperty(proto, 'renderer3D', { value: renderer3D });   // (a getter on the class)
  const self = Object.assign(proto, {
    _animation: { frameLinkAnims, flaRestTransforms: new Map() },
    _cameraKeyframeTracks: {}, _previewThroughCameras: false, _animatedCamFov: new Map(),
    _kfPos: [0, 0, 0], _kfRot: [0, 0, 0], _kfScale: [0, 0, 0], _kfFla: createFrameLinkEval3D(),
    _blendShapes: { sync: () => undefined },
    getAllMeshes: () => meshes, getMesh: (id: string) => meshes.find((m) => m.id === id) ?? null,
  }) as unknown as Scene3DManager;
  const scene3d = {
    getModelStore: () => new Map(), findGroupMemberGlbId: () => undefined, getRibbonData3D: () => null,
    getFrameLinkAnimation3D: (id: string) => frameLinkAnims.get(id) ?? null,
    frameLinkRestForSave: (m: Mesh3D) => self.frameLinkRestForSave(m),
  } as unknown as Scene3DManager;
  return { self, renderer3D, scene3d, frameLinkAnims };
}

describe('E4: transform-only playback frames take the transforms fast path', () => {
  it('Frame Link bounce / sway / spin / pulse / shake + a position track: markTransformsDirty, never markInstancesDirty', () => {
    const ms = [box(0, 1, 0), box(2, 0, 0), box(4, 0, 0), box(6, 0, 0), box(8, 0, 0), box(10, 0, 0)];
    ms[5].keyframeTracks.position = [{ frame: 0, value: [10, 0, 0], easing: 'linear' }, { frame: 24, value: [10, 2, 0], easing: 'linear' }];
    const { self, renderer3D } = host(ms, {
      [ms[0].id]: { type: 'bounce', amplitude: 0.5 }, [ms[1].id]: { type: 'sway', amplitude: 20 }, [ms[2].id]: { type: 'spin', amplitude: 5 },
      [ms[3].id]: { type: 'pulse', amplitude: 0.2 }, [ms[4].id]: { type: 'shake', amplitude: 0.1 },
    });
    for (let f = 1; f <= 30; f++) {
      const v0 = ms.map((m) => m.localMatrixVersion);
      self.applyAllKeyframesAtFrame(f);
      // ONE matrix rebuild per moving mesh per frame (the 9 separate setters each bumped it)
      ms.forEach((m, i) => expect(m.localMatrixVersion - v0[i]).toBeLessThanOrEqual(1));
    }
    expect(renderer3D.markTransformsDirty).toHaveBeenCalledTimes(30);
    expect(renderer3D.markInstancesDirty).not.toHaveBeenCalled();
    expect(ms[0].y).toBeCloseTo(1 + Math.sin((30 / 24) * Math.PI * 2) * 0.5, 6);   // the transform IS applied
    expect(ms[5].y).toBeCloseTo(2, 6);
  });

  it('colour / opacity / visibility tracks still request the full repack', () => {
    const a = box(), b = box(), c = box();
    a.keyframeTracks.opacity = [{ frame: 0, value: 1, easing: 'linear' }, { frame: 10, value: 0, easing: 'linear' }];
    b.keyframeTracks.diffuseColor = [{ frame: 0, value: [1, 0, 0, 1], easing: 'linear' }];
    c.keyframeTracks.visible = [{ frame: 0, value: true, easing: 'step' }];
    for (const m of [a, b, c]) {
      const { self, renderer3D } = host([m], {});
      self.applyAllKeyframesAtFrame(5);
      expect(renderer3D.markInstancesDirty).toHaveBeenCalledTimes(1);
    }
  });

  it('nothing animated: no renderer invalidation at all', () => {
    const { self, renderer3D } = host([box(), box()], {});
    self.applyAllKeyframesAtFrame(3);
    expect(renderer3D.markInstancesDirty).not.toHaveBeenCalled();
    expect(renderer3D.markTransformsDirty).not.toHaveBeenCalled();
  });

  it('a moved mesh re-versions its descendants (attached decals ride its matrix through the fast path)', () => {
    const parent = box(0, 1, 0), child = box(0.5, 0, 0);
    parent.addChild(child);
    const { self } = host([parent, child], { [parent.id]: { type: 'bounce', amplitude: 0.5 } });
    const cv = child.localMatrixVersion;
    self.applyAllKeyframesAtFrame(6);
    expect(child.localMatrixVersion).toBeGreaterThan(cv);
    expect((child.localMatrix as unknown as Float32Array)[13]).toBeCloseTo(1.5, 5);   // world y follows the parent
  });
});

describe('E10: a mid-animation save stores the Frame Link REST pose', () => {
  const bounce = { type: 'bounce' as const, amplitude: 0.5, framesPerCycle: 24 };

  it('save during playback → reload → the same pose at every frame (no permanent offset)', () => {
    const m = box(1, 1, 0);
    const live = host([m], { [m.id]: bounce });
    live.self.applyAllKeyframesAtFrame(6);                     // peak of the bounce: y = 1.5
    expect(m.y).toBeCloseTo(1.5, 6);
    const state = buildDocumentMeshState(live.scene3d, m);
    expect(state.y).toBe(1);                                   // the rest, not the displaced frame pose
    expect(state.frameLinkAnimation3D.type).toBe('bounce');
    // reload: a fresh mesh at the saved transform + the saved link (rest re-captured on its first frame)
    const r = box(state.x, state.y, state.z);
    const re = host([r], { [r.id]: state.frameLinkAnimation3D });
    for (const f of [6, 0, 12, 18]) {
      re.self.applyAllKeyframesAtFrame(f); live.self.applyAllKeyframesAtFrame(f);
      expect(r.y).toBeCloseTo(m.y, 6);
    }
    re.self.applyAllKeyframesAtFrame(0);
    expect(r.y).toBeCloseTo(1, 6);                             // back at the authored rest
  });

  it('an old save (displaced pose, no rest) still loads as before — the field set is unchanged', () => {
    const m = box(1, 1.5, 0);
    const { scene3d } = host([m], { [m.id]: bounce });         // never played this session: no rest captured
    expect(buildDocumentMeshState(scene3d, m).y).toBe(1.5);
  });

  it('a mesh moved after the link posed it saves the move; spin (no rest) saves its live rotation', () => {
    const m = box(1, 1, 0), s = box(0, 0, 0);
    const { self, scene3d } = host([m, s], { [m.id]: bounce, [s.id]: { type: 'spin', amplitude: 10 } });
    self.applyAllKeyframesAtFrame(6);
    m.y = 3;                                                   // the user dragged it while paused
    expect(buildDocumentMeshState(scene3d, m).y).toBe(3);
    expect(buildDocumentMeshState(scene3d, s).rotation).toBeCloseTo(s.rotation, 9);
  });
});

describe('E8: allocation-free samplers agree with the allocating ones', () => {
  it('sampleVec3TrackInto = sampleTrack(interpolateVec3); evalFrameLink3D(out) = evalFrameLink3D()', () => {
    const tr: Keyframe<Vec3Value>[] = [
      { frame: 0, value: [0, 0, 0], easing: 'ease-in-out' }, { frame: 10, value: [1, 2, 3], easing: 'step' }, { frame: 20, value: [5, 5, 5], easing: 'linear' },
    ];
    const out: Vec3Value = [9, 9, 9];
    for (const f of [-1, 0, 3.5, 10, 14, 20, 25]) {
      expect(sampleVec3TrackInto(tr, f, out)).toBe(true);
      expect(out).toEqual(sampleTrack(tr, f, interpolateVec3));
    }
    expect(sampleVec3TrackInto([], 3, out)).toBe(false);
    const r = createFrameLinkEval3D();
    for (const type of ['bounce', 'sway', 'spin', 'pulse', 'shake', 'scroll', 'wind'] as const) {
      const a = { ...DEFAULT_FRAME_LINK_ANIMATION_3D, enabled: true, type, amplitude: 0.7 };
      for (const f of [0, 5, 17]) expect(evalFrameLink3D(a, f, r)).toEqual(evalFrameLink3D(a, f));
    }
  });
});
