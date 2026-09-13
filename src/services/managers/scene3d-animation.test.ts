import { describe, it, expect } from 'vitest';
import { Scene3DAnimation, type Scene3DAnimationHost } from './scene3d-animation';
import type { ManagerContext } from './manager-context';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { Joint3D } from '../../types/armature-3d';

// Node.toJSON reaches for the browser `self.crypto.randomUUID` — polyfill for the Node test env.
const g = globalThis as unknown as { self?: { crypto?: { randomUUID?: () => string } } };
g.self ??= g as never;
let uuidN = 0;
(g.self.crypto ??= {} as never).randomUUID ??= () => `test-uuid-${uuidN++}`;

function joint(index: number, parentIndex = -1): Joint3D {
    return {
        index, name: `j${index}`, parentIndex, children: [],
        localPosition: [0, index * 0.5, 0], localRotation: [0, 0, 0, 1], localScale: [1, 1, 1],
        tailOffset: [0, 0.3, 0], worldMatrix: new Float32Array(16), inverseBindMatrix: new Float32Array(16),
    };
}

function env(skeletons: Skeleton3D[]) {
    const ctx = {
        scheduleRender: () => {},
        emitSceneGraphChanged: () => {},
        sceneGraph: { root: { children: skeletons } },
    } as unknown as ManagerContext;
    const host: Scene3DAnimationHost = {
        getSkeleton: (id) => skeletons.find((s) => s.id === id) ?? null,
        keepSpringsAlive: () => {},
        applyAllKeyframesAtFrame: () => {},
        getMesh: () => null,
        getAllMeshes: () => [],
        getBodyParams: () => null,
        getBoneOverlaySkeletonId: () => null,
        findClip: () => null,
        startScrollAnimation: () => {},
        clearScrollFrames: () => {},
        isBoneOverlayActive: () => false,
        setIdleLiveHold: () => {},
    };
    return new Scene3DAnimation(ctx, host);
}

describe('Scene3DAnimation — NLA registry', () => {
    it('createNLATrack3D registers the track, captures the bind pose, and persists both on skeleton.data', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [] });
        const anim = env([skel]);
        const trackId = anim.createNLATrack3D(skel.id, 'walk-layer', 30, false);

        const tracks = anim.getNLATracks3D(skel.id);
        expect(tracks).toHaveLength(1);
        expect(tracks[0]).toMatchObject({ id: trackId, name: 'walk-layer', fps: 30, loop: false });
        expect(anim.nlaBindPoses.get(skel.id)?.rotations).toHaveLength(2);
        // Persisted for save/load (the 2026-09-12 fix):
        expect(skel.data.nlaTracks).toHaveLength(1);
        expect(skel.data.nlaBindPose?.rotations).toHaveLength(2);

        anim.addNLASegment3D(trackId, 'clipX', 5, { weight: 0.5 });
        expect(tracks[0].segments[0]).toMatchObject({ clipId: 'clipX', startFrame: 5, weight: 0.5 });
    });

    it('NLA tracks SURVIVE toJSON → fromJSON and lazily re-seed a fresh subsystem (the latent bug)', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0)], clips: [] });
        const anim1 = env([skel]);
        const trackId = anim1.createNLATrack3D(skel.id, 'persisted', 24, true);
        anim1.addNLASegment3D(trackId, 'clipA', 0, { weight: 1 });

        // Round-trip through plain JSON (what the document save does).
        const restored = Skeleton3D.fromJSON(JSON.parse(JSON.stringify(skel.toJSON())));
        expect(restored.id).toBe(skel.id);
        expect(restored.data.nlaTracks).toHaveLength(1);
        expect(restored.data.nlaBindPose?.rotations).toHaveLength(1);

        // A FRESH subsystem (new session) sees the persisted track via the lazy seed.
        const anim2 = env([restored]);
        const tracks = anim2.getNLATracks3D(restored.id);
        expect(tracks).toHaveLength(1);
        expect(tracks[0].name).toBe('persisted');
        expect(tracks[0].segments[0].clipId).toBe('clipA');
        // Track-id addressed ops work on the seeded entry too (the _trackById fallback path).
        anim2.updateNLASegment3D(trackId, 0, { weight: 0.25 });
        expect(anim2.getNLATracks3D(restored.id)[0].segments[0].weight).toBe(0.25);
    });

    it('seekNLATrack3D on a restored track evaluates without throwing (bind pose from persisted data)', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0)], clips: [] });
        const anim1 = env([skel]);
        const trackId = anim1.createNLATrack3D(skel.id, 't', 24, true);
        const restored = Skeleton3D.fromJSON(JSON.parse(JSON.stringify(skel.toJSON())));
        const anim2 = env([restored]);
        expect(() => anim2.seekNLATrack3D(trackId, 3)).not.toThrow();
    });
});

describe('Scene3DAnimation — pose library (Slice D)', () => {
    it('capturePose stores the current joint rotations; applyPose restores them', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [] });
        const anim = env([skel]);
        skel.data.joints[1].localRotation = [0, 0, 0.3827, 0.9239];   // ~45° Z
        const poseId = anim.capturePose(skel.id, 'wave');
        expect(anim.getPoses(skel.id)).toEqual([{ id: poseId, name: 'wave', region: undefined }]);

        skel.data.joints[1].localRotation = [0, 0, 0, 1];             // move away
        anim.applyPose(skel.id, poseId);
        expect(skel.data.joints[1].localRotation[2]).toBeCloseTo(0.3827, 4);
    });

    it('rename/delete/region tagging round-trip', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0)], clips: [] });
        const anim = env([skel]);
        const a = anim.capturePose(skel.id, 'a');
        const b = anim.capturePose(skel.id, 'b');
        anim.renamePose(skel.id, a, 'renamed');
        anim.setPoseRegion(skel.id, a, 'left');
        expect(anim.getAnimationsByRegion(skel.id, 'left').poses).toEqual([{ id: a, name: 'renamed' }]);
        anim.setPoseRegion(skel.id, a, null);
        expect(anim.getAnimationsByRegion(skel.id, 'left').poses).toEqual([]);
        anim.deletePose(skel.id, b);
        expect(anim.getPoses(skel.id).map((p) => p.id)).toEqual([a]);
    });

    it('installDefaultAnimations is idempotent and serializeSkeletonForSave strips unedited defaults', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [] });
        skel.isProceduralBody = true;
        const anim = env([skel]);
        const added = anim.installDefaultAnimations(skel.id);
        expect(added).toBeGreaterThan(0);
        expect(anim.installDefaultAnimations(skel.id)).toBe(0);       // idempotent

        // (A toy j0/j1 skeleton only matches SOME defaults — clips/poses are humanoid-name-keyed.)
        const clips0 = skel.data.clips!.length, poses0 = skel.data.poses!.length;
        expect(clips0 + poses0).toBe(added);

        // Unedited defaults are stripped from the save payload...
        const saved = anim.serializeSkeletonForSave(skel);
        expect((saved.skeletonData.clips ?? []).length).toBe(0);
        expect((saved.skeletonData.poses ?? []).length).toBe(0);
        // ...but an EDITED default is kept (mutate whichever collection the toy skeleton got).
        if (clips0 > 0) skel.data.clips![0].endFrame += 7;
        else skel.data.poses![0].rotations[0].rotation = [0, 0, 0.5, 0.866];
        const saved2 = anim.serializeSkeletonForSave(skel);
        const kept = (saved2.skeletonData.clips ?? []).length + (saved2.skeletonData.poses ?? []).length;
        expect(kept).toBe(1);
    });
});
