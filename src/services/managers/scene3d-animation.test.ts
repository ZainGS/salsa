import { describe, it, expect, vi } from 'vitest';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
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

describe('Scene3DAnimation — clip playback does not contaminate the saved pose', () => {
    // AnimationPlayer3D.play() schedules a rAF; stub it so the Node test env can flip `playing` without ticking.
    const rafG = globalThis as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number; cancelAnimationFrame?: (id: number) => void };
    rafG.requestAnimationFrame ??= () => 0;
    rafG.cancelAnimationFrame ??= () => {};
    const clip = { id: 'c', name: 'C', startFrame: 0, endFrame: 10, fps: 24, tracks: [] } as any;

    it('serializes the authored pre-play pose while a clip is ACTIVELY playing (not the transient frame)', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [] });
        skel.isProceduralBody = true;
        const anim = env([skel]);
        const authored = [...skel.data.joints[1].localRotation];   // [0,0,0,1] from the joint() helper

        const player = anim.playSkeletonClip(skel.id, clip);   // snapshots the authored pose
        player.play();                                          // now "playing"
        skel.data.joints[1].localRotation = [0.5, 0, 0, 0.8660254];   // simulate a clip frame written live

        const saved = anim.serializeSkeletonForSave(skel);
        expect(saved.skeletonData.joints[1].localRotation).toEqual(authored);
        expect(saved.skeletonData.joints[1].localRotation).not.toEqual([0.5, 0, 0, 0.8660254]);
        player.pause();
    });

    it('serializes the LIVE pose once the clip is no longer playing — a later manual pose is never clobbered', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [] });
        skel.isProceduralBody = true;
        const anim = env([skel]);
        const player = anim.playSkeletonClip(skel.id, clip);
        player.play();
        player.pause();   // stopped playing → snapshot must NOT override
        skel.data.joints[1].localRotation = [0.1, 0.2, 0.3, 0.9];   // a deliberate pose set after playback

        const saved = anim.serializeSkeletonForSave(skel);
        expect(saved.skeletonData.joints[1].localRotation).toEqual([0.1, 0.2, 0.3, 0.9]);
    });
});

describe('Scene3DAnimation — clips over the idle + face events (pose & animation audit 2026-09-28)', () => {
    const rafG = globalThis as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number; cancelAnimationFrame?: (id: number) => void };
    rafG.requestAnimationFrame ??= () => 0;
    rafG.cancelAnimationFrame ??= () => {};
    const tilt = [0.2588, 0, 0, 0.9659];   // 30° about X

    function world() {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [] });
        const body = Object.create(SkinnedMesh3D.prototype) as SkinnedMesh3D;
        Object.defineProperty(body, 'id', { value: 'body' });
        Object.assign(body, { skeleton: skel, skeletonId: skel.id, isProceduralBody: true });
        const faces: unknown[] = [];
        const cbs: (() => boolean)[] = [];
        const ctx = {
            scheduleRender: () => {}, emitSceneGraphChanged: () => {},
            sceneGraph: { root: { children: [skel] } },
            webgpuRenderer: { addPreRenderCallback: (cb: () => boolean) => { if (!cbs.includes(cb)) cbs.push(cb); } },
            interactionService: { beginInteractive: () => {}, endInteractive: () => {} },
        } as unknown as ManagerContext;
        const host: Scene3DAnimationHost = {
            getSkeleton: (id) => (id === skel.id ? skel : null), keepSpringsAlive: () => {}, applyAllKeyframesAtFrame: () => {},
            getMesh: (id) => (id === 'body' ? body : null), getAllMeshes: () => [body], getBodyParams: () => null,
            getBoneOverlaySkeletonId: () => null, findClip: () => null, startScrollAnimation: () => {}, clearScrollFrames: () => {},
            isBoneOverlayActive: () => false, setIdleLiveHold: () => {},
            clipFaceEvent: (_s, ev) => { faces.push(ev); },
        };
        const clip = {
            id: 'w', name: 'Wave', startFrame: 0, endFrame: 24, fps: 24,
            tracks: [{ jointIndex: 1, channel: 'rotation' as const, keyframes: [{ frame: 0, value: [0, 0, 0, 1] }, { frame: 12, value: tilt }, { frame: 24, value: [0, 0, 0, 1] }] }],
            faceTrack: [{ frame: 6, gaze: [0.3, 0] as [number, number] }, { frame: 20, restore: true }],
        };
        skel.data.clips = [clip];
        return { anim: new Scene3DAnimation(ctx, host), skel, faces, cbs };
    }

    it('playClipOverIdle: plays through the idle callback, fires face events, then turns the idle back off + restores the pose', () => {
        const { anim, skel, faces, cbs } = world();
        const now = { t: 1000 };
        const spy = vi.spyOn(performance, 'now').mockImplementation(() => now.t);
        try {
            expect(anim.playClipOverIdle('body', 'Wave')).toBe(true);
            expect(anim.isIdleAnimating('body')).toBe(true);        // the idle was off → turned on for the clip
            expect(anim.isPlayingOverIdle('body')).toBe(true);
            const tick = () => cbs.forEach((cb) => cb());
            now.t = 1000 + 500; tick();                              // frame 12 (mid-clip, fully faded in)
            const q = skel.data.joints[1].localRotation;
            for (let c = 0; c < 4; c++) expect(q[c]).toBeCloseTo(tilt[c], 3);
            expect(faces).toEqual([{ frame: 6, gaze: [0.3, 0] }]);
            now.t = 1000 + 900; tick();                              // frame 21.6 → the restore event
            expect(faces.length).toBe(2);
            now.t = 1000 + 1200; tick();                             // past the end
            expect(anim.isPlayingOverIdle('body')).toBe(false);
            expect(anim.isIdleAnimating('body')).toBe(false);       // switched back off
            expect(skel.data.joints[1].localRotation).toEqual([0, 0, 0, 1]);   // base restored exactly
        } finally { spy.mockRestore(); }
    });

    it('playSkeletonClip fires face events as playback crosses their frames', () => {
        const { anim, skel, faces } = world();
        const player = anim.playSkeletonClip(skel.id, skel.data.clips![0]);
        player.seek(5); expect(faces.length).toBe(0);
        player.seek(8); expect(faces).toEqual([{ frame: 6, gaze: [0.3, 0] }]);
        player.seek(22); expect(faces.length).toBe(2);
    });
});

describe('Scene3DAnimation — the idle keeps a pose made in armature mode (the "stuck in T-pose" bug)', () => {
    const rafG = globalThis as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number };
    rafG.requestAnimationFrame ??= () => 0;
    function named(index: number, name: string, parentIndex = -1): Joint3D { return { ...joint(index, parentIndex), name }; }

    it('posing starts → snaps to the base; save mid-pose keeps the edits; posing ends → the pose becomes the new idle base', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [named(0, 'hips'), named(1, 'shoulder_L', 0)], clips: [] });
        skel.isProceduralBody = true;
        const body = Object.create(SkinnedMesh3D.prototype) as SkinnedMesh3D;
        Object.defineProperty(body, 'id', { value: 'body' });
        Object.assign(body, { skeleton: skel, skeletonId: skel.id, isProceduralBody: true });
        const cbs: (() => boolean)[] = [];
        let posing = false;
        const ctx = {
            scheduleRender: () => {}, emitSceneGraphChanged: () => {}, sceneGraph: { root: { children: [skel] } },
            webgpuRenderer: { addPreRenderCallback: (cb: () => boolean) => { if (!cbs.includes(cb)) cbs.push(cb); } },
            interactionService: { beginInteractive: () => {}, endInteractive: () => {} },
        } as unknown as ManagerContext;
        const host: Scene3DAnimationHost = {
            getSkeleton: (id) => (id === skel.id ? skel : null), keepSpringsAlive: () => {}, applyAllKeyframesAtFrame: () => {},
            getMesh: (id) => (id === 'body' ? body : null), getAllMeshes: () => [body], getBodyParams: () => null,
            getBoneOverlaySkeletonId: () => (posing ? skel.id : null), findClip: () => null, startScrollAnimation: () => {},
            clearScrollFrames: () => {}, isBoneOverlayActive: () => posing, setIdleLiveHold: () => {},
        };
        const anim = new Scene3DAnimation(ctx, host);
        const tick = () => cbs.forEach((cb) => cb());
        const sh = () => skel.data.joints[1];

        anim.setIdleAnimation('body', true);                      // base = the T-pose (identity)
        tick();                                                    // idle moves the shoulder a little
        posing = true; tick();                                     // enter armature mode
        expect(sh().localRotation).toEqual([0, 0, 0, 1]);          // snapped to the clean base (no mid-breath residue)

        const pose: [number, number, number, number] = [0, 0, -0.6, 0.8];   // user drops the arm
        sh().localRotation = [...pose];
        const saved = anim.serializeSkeletonForSave(skel);         // an autosave WHILE posing
        expect(saved.skeletonData.joints[1].localRotation).toEqual(pose);   // the edit, not the stale T-pose base

        posing = false; tick();                                    // leave armature mode
        expect(anim.getIdleBase('body')!.get('shoulder_L')).toEqual(pose);  // the pose became the idle's base
        const q = sh().localRotation;                              // idle continues FROM the new pose (± a small sway)
        expect(Math.abs(q[2] - pose[2])).toBeLessThan(0.05);
        expect(anim.serializeSkeletonForSave(skel).skeletonData.joints[1].localRotation).toEqual(pose);
    });
});

describe('Scene3DAnimation — the idle skips characters the renderer culled (R6.1)', () => {
    const rafG = globalThis as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number };
    rafG.requestAnimationFrame ??= () => 0;
    it('no pose work while culled; resumes at the time-based phase when visible again', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [{ ...joint(0, -1), name: 'hips' }, { ...joint(1, 0), name: 'spine' }, { ...joint(2, 1), name: 'chest' }], clips: [] });
        skel.isProceduralBody = true;
        const body = Object.create(SkinnedMesh3D.prototype) as SkinnedMesh3D;
        Object.defineProperty(body, 'id', { value: 'body' });
        Object.assign(body, { skeleton: skel, skeletonId: skel.id, isProceduralBody: true });
        const cbs: (() => boolean)[] = [];
        let culled = false;
        const ctx = {
            scheduleRender: () => {}, emitSceneGraphChanged: () => {}, sceneGraph: { root: { children: [skel] } },
            webgpuRenderer: { addPreRenderCallback: (cb: () => boolean) => { if (!cbs.includes(cb)) cbs.push(cb); } },
            interactionService: { beginInteractive: () => {}, endInteractive: () => {} },
        } as unknown as ManagerContext;
        const host: Scene3DAnimationHost = {
            getSkeleton: (id) => (id === skel.id ? skel : null), keepSpringsAlive: () => {}, applyAllKeyframesAtFrame: () => {},
            getMesh: (id) => (id === 'body' ? body : null), getAllMeshes: () => [body], getBodyParams: () => null,
            getBoneOverlaySkeletonId: () => null, findClip: () => null, startScrollAnimation: () => {}, clearScrollFrames: () => {},
            isBoneOverlayActive: () => false, setIdleLiveHold: () => {},
            isSkeletonAnimCulled: (id) => culled && id === skel.id,
        };
        const now = { t: 1000 };
        const spy = vi.spyOn(performance, 'now').mockImplementation(() => now.t);
        try {
            const anim = new Scene3DAnimation(ctx, host);
            anim.setIdleAnimation('body', true);
            const tick = () => cbs.map((cb) => cb()).some(Boolean);
            now.t = 2000; tick();
            const v0 = skel.poseVersion;
            culled = true;
            now.t = 3000;
            expect(tick()).toBe(true);                 // still "animating" → the render loop keeps ticking
            expect(skel.poseVersion).toBe(v0);         // but no FK / pose work happened
            culled = false;
            now.t = 3500; tick();
            expect(skel.poseVersion).toBeGreaterThan(v0);
        } finally { spy.mockRestore(); }
    });
});
