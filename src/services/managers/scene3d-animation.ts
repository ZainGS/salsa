/**
 * Scene3DAnimation — keyframe PLAYBACK drivers + Non-Linear Animation (audit C4 Slice A; see
 * docs/specs/animation-cluster-extraction-map.md).
 *
 * OWNS: the document AnimationPlayer3D (drives applyAllKeyframesAtFrame), per-track NLA state
 * (tracks / players / bind poses), and skeleton-clip playback. Bodies moved VERBATIM from
 * scene3d-manager, which keeps its public names as delegators.
 *
 * 🐛 Also fixes two latent NLA-persistence bugs found during extraction recon (2026-09-12):
 * `Skeleton3D.toJSON` never serialized `nlaTracks` (despite createNLATrack3D's "survives save/load"
 * comment), and nothing re-seeded the runtime registry after a reload. Now: the skeleton serializes
 * `nlaTracks` + `nlaBindPose`, and this subsystem LAZILY seeds its maps from `skeleton.data` on the
 * first NLA access per skeleton — lazy, so restore ordering doesn't matter.
 */

import type { ManagerContext } from './manager-context';
import { AnimationPlayer3D, AnimationPlayer3DConfig } from '../../renderer/3d/animation-player-3d';
import type { SkeletonAnimClip, NLATrack, NLAClipSegment } from '../../types/armature-3d';
import { applySkeletonClipAtFrame, rebaseClipRest, evaluateNLAAtFrame, snapshotSkeletonPose, sampleClipPose, blendPoses, overlayPoseMasked, addPoseMasked, writePoseToSkeleton, type SkeletonPose } from '../../renderer/3d/skeleton-animator';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { AnimRegion, AdaptivePoseSample } from '../../types/armature-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { FrameLinkAnimation3D, DEFAULT_FRAME_LINK_ANIMATION_3D } from '../../types/keyframe-3d';
import { DEFAULT_BREAK_CLIP_NAMES, DEFAULT_ONESHOT_CLIP_NAMES, defaultRestRotation } from './default-animations';
import { solveAllIKChains } from '../../renderer/3d/ik-solver';
import { buildDefaultPoses, buildDefaultClips, DEFAULT_CLIP_NAMES } from './default-animations';
import { quat } from 'gl-matrix';

const _nanoid = () => Math.random().toString(36).slice(2, 10);

/** Leg idle fidelity (Slice C): 'fk' = free micro weight-shift; 'ik' = feet PINNED by foot-IK; 'none' = static. */
export type LegIdleMode = 'none' | 'fk' | 'ik';

/** The torso/head/shoulder joints the idle drives (by name) — everything else inherits via FK.
 *  Exported: the ghost body preview reuses the same idle math on its throwaway skeleton. */
export const IDLE_JOINTS = ['lowerback', 'spine', 'chest', 'neck', 'head', 'shoulder_L', 'shoulder_R',
    'clavicle_L', 'clavicle_R', 'lowerarm_L', 'lowerarm_R', 'hand_L', 'hand_R'] as const;   // arms: secondary motion (2026-09-28)
export const LEG_IDLE_JOINTS = ['hips', 'upperleg_L', 'lowerleg_L', 'foot_L', 'upperleg_R', 'lowerleg_R', 'foot_R'] as const;
/** Runtime state for one body's procedural idle. */
type IdleRig = {
    skelId: string; intensity: number; t0: number;
    base: Map<string, [number, number, number, number]>;   // the pose the idle sines layer onto
    legMode: LegIdleMode;
    legChains?: { id: string; footName: string }[];         // foot-IK chains pinned while legMode==='ik'
};

export interface Scene3DAnimationHost {
    getSkeleton(id: string): Skeleton3D | null;
    /** Keeps spring bones simulating during playback (hair jiggles, settles after stop). */
    keepSpringsAlive(skeletonId: string, ms?: number): void;
    /** The whole-document keyframe application (stays on the manager — keyframe + camera seams). */
    applyAllKeyframesAtFrame(frame: number): void;
    // ── Slice D (default anims + pose library) ──
    getMesh(id: string): Mesh3D | null;
    getAllMeshes(): Mesh3D[];
    getBodyParams(bodyMeshId: string): import('./body-generator').BodyParams | null;
    /** Keep a procedural body's hanging arms out of its torso after a pose (Scene3DManager.clearArmsForSkeleton). */
    clearArmsForSkeleton?(skel: Skeleton3D): unknown;
    /** Apply a clip face event (gaze jump / blink / restore) to the procedural body driven by `skel`. */
    clipFaceEvent?(skel: Skeleton3D, ev: import('../../types/armature-3d').ClipFaceEvent): void;
    /** Skeleton currently open in the bone overlay (Edit Armature), or null. */
    getBoneOverlaySkeletonId(): string | null;
    /** Clip lookup across all skeletons (the clip-authoring seam stays on the manager). */
    findClip(clipId: string): { skel: Skeleton3D; clip: SkeletonAnimClip } | null;
    // ── Slice B (FLA) — the ribbon scroll driver stays with Scene3DRibbons ──
    startScrollAnimation(meshId: string): void;
    clearScrollFrames(meshId: string): void;
    // ── Slice C (procedural idle) ──
    /** Bone-overlay (Edit Armature) active → the idle tick yields to manual posing. */
    isBoneOverlayActive(): boolean;
    /** Flip the idle half of the manager's cooperative live-rAF-loop cohort (idle + focus-bg holds). */
    setIdleLiveHold(on: boolean): void;
    /** R6.1: true when the renderer culled every part of this skeleton last frame (the idle may skip it). */
    isSkeletonAnimCulled?(skeletonId: string): boolean;
    /** SIM LOD (src/world/sim-lod.ts): reset a system's per-frame counters. */
    simLodBegin?(system: string): void;
    /** SIM LOD: should this character's idle update this frame (distance / view / fog band, player + selection +
     *  posing + scripts exempt)? Absent or sim LOD off = always. */
    simLodDue?(skeletonId: string, bodyMeshId: string): boolean;
    /** Play mode: true while the Play locomotion (the engine LocomotionAnimator, or a host clip handler) owns this
     *  skeleton's pose. The idle (and its breaks) must yield: it runs as a pre-render callback AFTER the Play tick, so
     *  it overwrote the gait every frame and the Player slid around in its idle pose (play-mode.md "idle vs gait"). */
    isSkeletonPlayDriven?(skeletonId: string): boolean;
}

export class Scene3DAnimation {
    private _animPlayer?: AnimationPlayer3D;
    /** skeletonId → { the authored pose captured before a clip first started playing, + the active player }.
     *  Clip playback writes the live animation frame into joint.localRotation, which is what toJSON persists —
     *  so a save WHILE a clip is playing would freeze the character in that frame on reload (there is no separate
     *  rest pose to fall back to). serializeSkeletonForSave persists this authored pose INSTEAD, but ONLY while
     *  the player is actively playing — once stopped, the live pose is authoritative again, so a later manual
     *  pose is never overwritten. Empty except during clip playback, so non-playing bodies serialize as before. */
    private _playbackSnapshots = new Map<string, { pose: SkeletonPose; player: AnimationPlayer3D }>();
    private _nlaTracks    = new Map<string, NLATrack>();
    private _nlaPlayers   = new Map<string, AnimationPlayer3D>();
    private _nlaBindPoses = new Map<string, SkeletonPose>();  // keyed by skeletonId
    /** Skeletons whose persisted NLA data has been merged into the runtime maps (lazy seed). */
    private _nlaSeeded = new Set<string>();

    // ── Frame Link Animation (Slice B) — the CONFIG + rest-pose maps. Read by four parties: the
    // manager's per-mesh keyframe application (evalFrameLink delta), the cloth + ribbons host
    // closures, and the armature host (clears rest entries when the gizmo moves a mesh) — hence the
    // public map getters (stable references; handed to the armature host at construction).
    // ── Procedural idle state (Slice C) ──
    private _idleSolveCallback: (() => boolean) | null = null;
    private _idleRigs = new Map<string, IdleRig>();
    /** Per-character leg idle fidelity (persists across idle on/off; default 'fk'). Set via setLegIdleMode. */
    private _legIdleModes = new Map<string, LegIdleMode>();

    private _frameLinkAnims = new Map<string, FrameLinkAnimation3D>();
    private _flaRest = new Map<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

    constructor(private readonly ctx: ManagerContext, private readonly host: Scene3DAnimationHost) {}

    /** Exposed for the manager's full-character-deletion state sweep (the spawnSpins pattern). */
    get nlaBindPoses(): Map<string, SkeletonPose> { return this._nlaBindPoses; }
    get frameLinkAnims(): Map<string, FrameLinkAnimation3D> { return this._frameLinkAnims; }
    // Slice C maps — exposed for the manager's full-character-deletion state sweep.
    get idleRigs(): Map<string, unknown> { return this._idleRigs; }
    get legIdleModes(): Map<string, LegIdleMode> { return this._legIdleModes; }
    get idleBreaks(): Map<string, unknown> { return this._idleBreaks as unknown as Map<string, unknown>; }
    get squashStretch(): Map<string, unknown> { return this._squashStretch as unknown as Map<string, unknown>; }
    get flaRestTransforms(): Map<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }> { return this._flaRest; }

    // ── Animation player ─────────────────────────────────────────────

    /**
     * Create (or replace) an AnimationPlayer3D that drives keyframe playback.
     * The player automatically calls applyAllKeyframesAtFrame on every frame tick.
     */
    createAnimationPlayer(config?: AnimationPlayer3DConfig): AnimationPlayer3D {
        this.destroyAnimationPlayer();
        this._animPlayer = new AnimationPlayer3D(config);
        this._animPlayer.onFrame((frame) => {
            this.host.applyAllKeyframesAtFrame(frame);
            this.ctx.scheduleRender();
        });
        return this._animPlayer;
    }

    getAnimationPlayer(): AnimationPlayer3D | undefined {
        return this._animPlayer;
    }

    destroyAnimationPlayer(): void {
        this._animPlayer?.destroy();
        this._animPlayer = undefined;
    }

    // ── Skeleton animation ────────────────────────────────────────────

    /**
     * Create an AnimationPlayer3D that drives a SkeletonAnimClip on a Skeleton3D node.
     * The player's onFrame handler interpolates joint poses each tick and recomputes
     * skin matrices.  The returned player starts paused — call player.play() to begin.
     * Destroy the player when done to stop the RAF loop.
     */
    playSkeletonClip(skeletonId: string, clip: SkeletonAnimClip): AnimationPlayer3D {
        const skeleton = this.host.getSkeleton(skeletonId);
        if (!skeleton) throw new Error(`Skeleton not found: ${skeletonId}`);
        clip = this._fitDefaultOneShot(skeleton, clip);

        const player = new AnimationPlayer3D({
            startFrame: clip.startFrame,
            endFrame:   clip.endFrame,
            fps:        clip.fps,
            loop:       true,
        });

        this._armPlaybackSnapshot(skeletonId, skeleton, player);
        let lastFrame = clip.startFrame - 1;
        player.onFrame(frame => {
            applySkeletonClipAtFrame(clip, skeleton, frame);
            this._fireFaceEvents(skeleton, clip, lastFrame, frame); lastFrame = frame;
            this.host.keepSpringsAlive(skeleton.id);   // hair jiggles during playback, settles after it stops
            this.ctx.scheduleRender();
        });

        return player;
    }

    /** Fire the clip's face events whose frame lies in (prev, cur] — handling a loop wrap (cur < prev). */
    private _fireFaceEvents(skel: Skeleton3D, clip: SkeletonAnimClip, prev: number, cur: number): void {
        const evs = clip.faceTrack;
        if (!evs?.length || !this.host.clipFaceEvent) return;
        for (const ev of evs) {
            const hit = cur >= prev ? (ev.frame > prev && ev.frame <= cur) : (ev.frame > prev || ev.frame <= cur);
            if (hit) this.host.clipFaceEvent(skel, ev);
        }
    }

    /**
     * A STOCK one-shot (Stretch / Scratch Head / Wave — unedited, compared against a fresh default) played on a
     * character that doesn't stand in the exact default stance (arms fitted wider on a heavier body, or the user's own
     * pose) is re-based so it leaves from and returns to where the character actually is, instead of snapping to the
     * default stance at its ends. Only tracks that start AT the default stance move; anything else plays as authored.
     */
    private _fitDefaultOneShot(skel: Skeleton3D, clip: SkeletonAnimClip): SkeletonAnimClip {
        if (!DEFAULT_ONESHOT_CLIP_NAMES.includes(clip.name)) return clip;
        const stock = buildDefaultClips(skel.data.joints).find(c => c.name === clip.name);
        if (!stock || !Scene3DAnimation._eqNoId(stock, clip)) return clip;   // edited by the user → play it as is
        const base = new Map<number, readonly number[]>();
        skel.data.joints.forEach((j, i) => base.set(i, j.constraintRotation ?? j.ikRotation ?? j.localRotation));
        return rebaseClipRest(clip, base, (ji) => defaultRestRotation(skel.data.joints[ji]?.name ?? ''));
    }

    /** Before a clip starts writing the live animation frame into joint.localRotation, snapshot the authored
     *  pose so serializeSkeletonForSave can persist it (instead of a transient frame) while the clip plays.
     *  Keeps the OLDEST snapshot (the true pre-playback authored pose) across back-to-back clips, but always
     *  tracks the CURRENT player so the serialize gate reflects the live play state. */
    private _armPlaybackSnapshot(skeletonId: string, skeleton: Skeleton3D, player: AnimationPlayer3D): void {
        const pose = this._playbackSnapshots.get(skeletonId)?.pose ?? snapshotSkeletonPose(skeleton);
        this._playbackSnapshots.set(skeletonId, { pose, player });
    }

    /**
     * Like {@link playSkeletonClip} but CROSSFADES out of `fromPose` (a snapshot of the skeleton at the moment
     * of the switch) into the clip over `blendFrames` clip-frames — so a state-machine transition doesn't snap
     * (animation-library-and-triggers.md §4.1). Reuses the NLA compositor's sample/blend/write primitives (no
     * second mixer). blendFrames ≤ 0 behaves like playSkeletonClip.
     */
    playSkeletonClipBlended(skeletonId: string, clip: SkeletonAnimClip, fromPose: SkeletonPose, blendFrames: number): AnimationPlayer3D {
        const skeleton = this.host.getSkeleton(skeletonId);
        if (!skeleton) throw new Error(`Skeleton not found: ${skeletonId}`);
        clip = this._fitDefaultOneShot(skeleton, clip);

        const player = new AnimationPlayer3D({ startFrame: clip.startFrame, endFrame: clip.endFrame, fps: clip.fps, loop: true });
        const start = clip.startFrame;
        let lastFrame = clip.startFrame - 1;
        player.onFrame(frame => {
            this._fireFaceEvents(skeleton, clip, lastFrame, frame); lastFrame = frame;
            const elapsed = frame - start;
            if (blendFrames > 0 && elapsed < blendFrames) {
                // Ramp fromPose → the clip's pose at this frame. Unanimated joints fall back to fromPose (passed
                // as the bind), so blend(fromPose, fromPose) = fromPose — they hold steady through the fade.
                const t = Math.max(0, Math.min(1, elapsed / blendFrames));
                writePoseToSkeleton(blendPoses(fromPose, sampleClipPose(clip, fromPose, frame), t), skeleton);
            } else {
                applySkeletonClipAtFrame(clip, skeleton, frame);
            }
            this.host.keepSpringsAlive(skeleton.id);
            this.ctx.scheduleRender();
        });
        player.seek(start);   // apply frame 0 (t=0 → fromPose) immediately, so there's no one-frame flash
        return player;
    }

    /**
     * Sample two clips at the given frames, blend by `t`, and write the result to the skeleton — the per-tick
     * primitive for the 1D locomotion blend tree (continuous idle↔walk↔run mix, animation-library-and-triggers.md §8).
     * Stateless (Scene3DManager owns the phase + which clips): `clipB` null or `t <= 0` writes `clipA` alone.
     * Unanimated joints fall back to `bind`, so joints outside the gait clips hold steady. No AnimationPlayer3D —
     * the caller drives it each Play tick, so it must NOT run alongside a locomotion player writing the same rig.
     */
    applyBlendedClips(
        skeletonId: string, clipA: SkeletonAnimClip, frameA: number, clipB: SkeletonAnimClip | null, frameB: number, t: number, bind: SkeletonPose,
        overlay?: { clip: SkeletonAnimClip; frame: number; mask: number[]; mode?: 'replace' | 'additive'; weight?: number; refFrame?: number },
    ): void {
        const skeleton = this.host.getSkeleton(skeletonId);
        if (!skeleton) return;
        const poseA = sampleClipPose(clipA, bind, frameA);
        let pose = (clipB && t > 0) ? blendPoses(poseA, sampleClipPose(clipB, bind, frameB), t) : poseA;
        // Layered overlay (§8): a masked clip (e.g. a wave/aim) over the base gait. 'replace' overrides the masked
        // joints; 'additive' layers the clip's motion RELATIVE to its reference frame on top (subtle lean/breathe).
        if (overlay && overlay.mask.length > 0) {
            const oPose = sampleClipPose(overlay.clip, bind, overlay.frame);
            if (overlay.mode === 'additive') {
                const refPose = sampleClipPose(overlay.clip, bind, overlay.refFrame ?? overlay.clip.startFrame);
                pose = addPoseMasked(pose, oPose, refPose, overlay.weight ?? 1, overlay.mask);
            } else {
                pose = overlayPoseMasked(pose, oPose, overlay.mask);
            }
        }
        writePoseToSkeleton(pose, skeleton);
        this.host.keepSpringsAlive(skeleton.id);
        this.ctx.scheduleRender();
    }

    // ── Non-Linear Animation (NLA) ────────────────────────────────────

    /** Merge a skeleton's PERSISTED NLA data (skeleton.data.nlaTracks / nlaBindPose) into the runtime
     *  maps, once per skeleton. Runtime-created tracks are already registered; persisted entries with
     *  the same id are skipped. Lazy — called at every NLA entry point, so restore order is a non-issue. */
    private _seedFromSkeleton(skeletonId: string): void {
        if (this._nlaSeeded.has(skeletonId)) return;
        this._nlaSeeded.add(skeletonId);
        const skeleton = this.host.getSkeleton(skeletonId);
        if (!skeleton) { this._nlaSeeded.delete(skeletonId); return; }   // not restored yet — retry later
        const data = skeleton.data as { nlaTracks?: NLATrack[]; nlaBindPose?: SkeletonPose };
        for (const t of data.nlaTracks ?? []) {
            if (!this._nlaTracks.has(t.id)) this._nlaTracks.set(t.id, t);
        }
        if (data.nlaBindPose && !this._nlaBindPoses.has(skeletonId)) {
            this._nlaBindPoses.set(skeletonId, data.nlaBindPose);
        }
    }

    private _trackById(trackId: string): NLATrack | undefined {
        const t = this._nlaTracks.get(trackId);
        if (t) return t;
        // Unknown id: it may be a persisted track on a not-yet-seeded skeleton — seed all skeletons
        // that carry NLA data (cheap: bounded by skeleton count) and retry once.
        for (const skel of this.ctx.sceneGraph.root.children) {
            const id = (skel as { id?: string }).id;
            if (id) this._seedFromSkeleton(id);
        }
        return this._nlaTracks.get(trackId);
    }

    /**
     * Create a new NLATrack for the given skeleton.
     * The bind pose is captured immediately from the skeleton's current joint state
     * and held for the lifetime of the track.
     */
    createNLATrack3D(
        skeletonId: string,
        name: string,
        fps = 24,
        loop = true,
    ): string {
        const skeleton = this.host.getSkeleton(skeletonId);
        if (!skeleton) throw new Error(`Skeleton not found: ${skeletonId}`);
        this._seedFromSkeleton(skeletonId);

        const trackId = _nanoid();
        const track: NLATrack = { id: trackId, name, skeletonId, segments: [], fps, loop };
        this._nlaTracks.set(trackId, track);

        // Snapshot bind pose if not yet captured for this skeleton.
        if (!this._nlaBindPoses.has(skeletonId)) {
            this._nlaBindPoses.set(skeletonId, snapshotSkeletonPose(skeleton));
        }

        // Persist the track + bind pose on the skeleton data so they survive save/load
        // (Skeleton3D.toJSON serializes both — the persistence half of the 2026-09-12 fix).
        const data = skeleton.data as { nlaTracks?: NLATrack[]; nlaBindPose?: SkeletonPose };
        data.nlaTracks ??= [];
        data.nlaTracks.push(track);
        data.nlaBindPose ??= this._nlaBindPoses.get(skeletonId);

        return trackId;
    }

    getNLATracks3D(skeletonId: string): NLATrack[] {
        this._seedFromSkeleton(skeletonId);
        return Array.from(this._nlaTracks.values()).filter(t => t.skeletonId === skeletonId);
    }

    addNLASegment3D(
        trackId: string,
        clipId: string,
        startFrame: number,
        opts?: Partial<Omit<NLAClipSegment, 'clipId' | 'startFrame'>>,
    ): number {
        const track = this._trackById(trackId);
        if (!track) throw new Error(`NLA track not found: ${trackId}`);
        const seg: NLAClipSegment = {
            clipId,
            startFrame,
            clipStartOffset: opts?.clipStartOffset ?? 0,
            weight:          opts?.weight ?? 1,
            blendMode:       opts?.blendMode ?? 'replace',
            fadeIn:          opts?.fadeIn ?? 0,
            fadeOut:         opts?.fadeOut ?? 0,
        };
        track.segments.push(seg);
        return track.segments.length - 1;
    }

    removeNLASegment3D(trackId: string, segIndex: number): void {
        const track = this._trackById(trackId);
        if (!track) return;
        track.segments.splice(segIndex, 1);
    }

    updateNLASegment3D(trackId: string, segIndex: number, updates: Partial<NLAClipSegment>): void {
        const track = this._trackById(trackId);
        if (!track || !track.segments[segIndex]) return;
        Object.assign(track.segments[segIndex], updates);
    }

    /**
     * Start an AnimationPlayer3D that drives the NLA track.
     * Returns the player (starts paused — call player.play() to begin).
     */
    playNLATrack3D(trackId: string): AnimationPlayer3D {
        this.stopNLATrack3D(trackId);

        const track = this._trackById(trackId);
        if (!track) throw new Error(`NLA track not found: ${trackId}`);

        const skeleton = this.host.getSkeleton(track.skeletonId);
        if (!skeleton) throw new Error(`Skeleton not found: ${track.skeletonId}`);
        this._seedFromSkeleton(track.skeletonId);

        // Restored skeletons seed the bind pose from persisted data; a track created THIS session
        // captured it at create time. Fall back to a fresh snapshot only if both are missing.
        const bindPose = this._nlaBindPoses.get(track.skeletonId)
            ?? (() => { const p = snapshotSkeletonPose(skeleton); this._nlaBindPoses.set(track.skeletonId, p); return p; })();
        const clips    = skeleton.data.clips ?? [];

        // Compute total timeline span from the latest segment end.
        const totalFrames = track.segments.reduce((max, seg) => {
            const clip = clips.find(c => c.id === seg.clipId);
            const dur  = clip ? clip.endFrame - clip.startFrame - seg.clipStartOffset : 0;
            return Math.max(max, seg.startFrame + dur);
        }, 1);

        const player = new AnimationPlayer3D({
            startFrame: 0,
            endFrame:   totalFrames,
            fps:        track.fps,
            loop:       track.loop,
        });

        player.onFrame(frame => {
            evaluateNLAAtFrame(track, clips, skeleton, bindPose, frame);
            this.host.keepSpringsAlive(skeleton.id);   // hair jiggles during playback, settles after it stops
            this.ctx.scheduleRender();
        });

        this._nlaPlayers.set(trackId, player);
        return player;
    }

    stopNLATrack3D(trackId: string): void {
        const player = this._nlaPlayers.get(trackId);
        if (player) {
            player.destroy();
            this._nlaPlayers.delete(trackId);
        }
    }

    seekNLATrack3D(trackId: string, frame: number): void {
        const track = this._trackById(trackId);
        if (!track) return;
        const skeleton = this.host.getSkeleton(track.skeletonId);
        if (!skeleton) return;
        this._seedFromSkeleton(track.skeletonId);
        const bindPose = this._nlaBindPoses.get(track.skeletonId);
        if (!bindPose) return;
        const clips = skeleton.data.clips ?? [];
        evaluateNLAAtFrame(track, clips, skeleton, bindPose, frame);
        this.ctx.scheduleRender();
    }

    /**
     * Schedule a crossfade: ramps fromSeg weight 1→0 and toSeg weight 0→1
     * over `durationFrames` at the current player position.
     */
    crossfade3D(trackId: string, fromSegIdx: number, toSegIdx: number, durationFrames: number): void {
        const track = this._trackById(trackId);
        if (!track) return;
        const player = this._nlaPlayers.get(trackId);
        if (!player) return;

        const fromSeg = track.segments[fromSegIdx];
        const toSeg   = track.segments[toSegIdx];
        if (!fromSeg || !toSeg) return;

        const startFrame = player.currentFrame;
        fromSeg.fadeOut = durationFrames;
        toSeg.startFrame = startFrame;
        toSeg.fadeIn     = durationFrames;
    }

    // ── Default idle animations + poses ───────────────────────────────────

    /** Resolve the skeleton id a mesh is bound to (or null). Accepts a body/skinned-mesh id. */
    getSkeletonIdForMesh(meshId: string): string | null {
        const m = this.host.getMesh(meshId);
        return (m instanceof SkinnedMesh3D) ? (m.skeletonId ?? null) : null;
    }

    /**
     * Pre-populate a skeleton's Animation Clips + Pose Library with the default idle/personality set
     * (breathe, shift weight, look around, stretch, scratch head, talk gesture + recallable poses).
     * Called automatically on procedural-body creation; also exposed so the host can BACKFILL an older
     * character whose skeleton predates this feature. Idempotent: skips any clip/pose whose name is
     * already present, so it never duplicates and never clobbers the animator's own authored content.
     * Accepts EITHER a skeleton id OR a body/skinned-mesh id (resolved to its skeleton). Returns the
     * number of clips + poses actually added.
     */
    installDefaultAnimations(skelOrMeshId: string): number {
        // Forgiving: try it as a skeleton id, else treat it as a mesh id and resolve the bound skeleton.
        const skel = this.host.getSkeleton(skelOrMeshId) ?? this.host.getSkeleton(this.getSkeletonIdForMesh(skelOrMeshId) ?? '');
        if (!skel) return 0;
        let added = 0;
        const clips = (skel.data.clips ??= []);
        const haveClip = new Set(clips.map(c => c.name));
        for (const clip of buildDefaultClips(skel.data.joints)) {
            if (haveClip.has(clip.name)) continue;
            clips.push(clip); added++;
        }
        const poses = (skel.data.poses ??= []);
        const havePose = new Set(poses.map(p => p.name));
        for (const pose of buildDefaultPoses(skel.data.joints)) {
            if (havePose.has(pose.name)) continue;
            poses.push(pose); added++;
        }
        if (added > 0) { this.ctx.emitSceneGraphChanged(); this.ctx.scheduleRender(); }
        return added;
    }

    /** Skeleton JSON for persistence with the UNEDITED default clips/poses stripped — they're re-installed
     *  idempotently on load (installDefaultAnimations), so the identical default anim set isn't duplicated
     *  across every procedural character. An EDITED default (or a renamed/added clip/pose) is KEPT, via a deep
     *  compare against a freshly-built default (ids ignored). */
    serializeSkeletonForSave(skel: Skeleton3D): any {
        const j = skel.toJSON();
        // ── Strip TRANSIENT animation frames from the persisted pose ──────────────────────────────────────────
        // Skeleton3D.toJSON emits the LIVE joint.localRotation/localScale, and there is no separate rest pose to
        // fall back to — so a save while ANY animation is running would freeze the character in that frame on
        // reload. Restore the authored pose from whatever source is driving the joints, in order:
        // 1. IDLE animation (the common case — writes localRotation every frame + squash/stretch writes localScale).
        //    rig.base is the exact pre-idle authored pose (idle-off restores from it); persist THAT.
        if (j.skeletonData?.joints) {
            let idleRig: IdleRig | undefined;
            for (const r of this._idleRigs.values()) if (r.skelId === skel.id) { idleRig = r; break; }
            // While this skeleton is being POSED in armature mode the idle is paused and the live joints ARE the authored
            // pose (the base is only re-captured when posing ends) — so persist the live pose, not the stale base.
            if (idleRig && this._posingSkels.has(skel.id)) idleRig = undefined;
            if (idleRig) {
                for (const jj of j.skeletonData.joints) {
                    const base = idleRig.base.get(jj.name);
                    if (base) { jj.localRotation = [...base]; jj.localScale = [1, 1, 1]; }  // reset squash/stretch scale too
                }
            }
        }
        // 2. A clip ACTIVELY playing (armature panel). Gated on `player.playing` so a stopped clip's snapshot never
        //    overrides a later manual pose. A no-op whenever nothing is playing.
        const snap = this._playbackSnapshots.get(skel.id);
        if (snap?.player.playing && j.skeletonData?.joints) {
            for (const jj of j.skeletonData.joints) {
                const r = snap.pose.rotations[jj.index];
                if (r) jj.localRotation = [...r];
            }
        }
        if (!skel.isProceduralBody || !j.skeletonData) return j;
        const pClip = new Map(buildDefaultClips(skel.data.joints).map(c => [c.name, c] as const));
        const pPose = new Map(buildDefaultPoses(skel.data.joints).map(p => [p.name, p] as const));
        const dropClip = new Set<string>();
        for (const c of (skel.data.clips ?? [])) { const p = pClip.get(c.name); if (p && Scene3DAnimation._eqNoId(c, p)) dropClip.add(c.id); }
        const dropPose = new Set<string>();
        for (const p of (skel.data.poses ?? [])) { const pr = pPose.get(p.name); if (pr && Scene3DAnimation._eqNoId(p, pr)) dropPose.add(p.id); }
        if (dropClip.size) j.skeletonData.clips = (j.skeletonData.clips ?? []).filter((c: any) => !dropClip.has(c.id));
        if (dropPose.size) j.skeletonData.poses = (j.skeletonData.poses ?? []).filter((p: any) => !dropPose.has(p.id));
        return j;
    }

    /** Structural equality ignoring `id` (arrays are order-sensitive; both operands come from the same
     *  deterministic default builder, so an unedited default compares equal to a freshly-built one). */
    private static _eqNoId(a: any, b: any): boolean {
        if (a === b) return true;
        if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (!Scene3DAnimation._eqNoId(a[i], b[i])) return false;
            return true;
        }
        const ka = Object.keys(a).filter(k => k !== 'id'), kb = Object.keys(b).filter(k => k !== 'id');
        if (ka.length !== kb.length) return false;
        for (const k of ka) if (!(k in b) || !Scene3DAnimation._eqNoId(a[k], b[k])) return false;
        return true;
    }

    /** The clip names installDefaultAnimations adds (so the host can label/filter the built-ins). */
    getDefaultClipNames(): string[] { return [...DEFAULT_CLIP_NAMES]; }

    /** Convert a quaternion [x,y,z,w] → Euler XYZ degrees (human-readable pose export only). */
    private static _quatToEulerDeg(q: readonly number[]): [number, number, number] {
        const [x, y, z, w] = q;
        const sinr = 2 * (w * x + y * z), cosr = 1 - 2 * (x * x + y * y);
        const sinp = 2 * (w * y - z * x);
        const siny = 2 * (w * z + x * y), cosy = 1 - 2 * (y * y + z * z);
        const k = 180 / Math.PI;
        return [
            Math.atan2(sinr, cosr) * k,
            (Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp)) * k,
            Math.atan2(siny, cosy) * k,
        ];
    }

    /**
     * Export the CURRENT pose as a copy-pasteable text block — one line per joint that's rotated away from
     * rest, with its quaternion [x,y,z,w] + Euler XYZ degrees. Captures the EFFECTIVE rotation
     * (constraintRotation ?? ikRotation ?? localRotation) so it works whether the character was posed with
     * FK gizmos OR IK handles. Pass a skeleton id, or omit to use the skeleton currently in the bone overlay
     * (Edit Armature). Hand the result to an author/LLM (with a description) to bake into a named pose/clip.
     */
    exportPoseData(skelId?: string): string {
        const id = skelId ?? this.host.getBoneOverlaySkeletonId() ?? '';
        const skel = this.host.getSkeleton(id);
        if (!skel) return '(no skeleton — open Edit Armature on a character first, or pass a skeleton id)';
        const EPS = 1.5e-3;
        const lines: string[] = [];
        for (const j of skel.data.joints) {
            const q = (j.constraintRotation ?? j.ikRotation ?? j.localRotation) as [number, number, number, number];
            const [x, y, z, w] = q;
            if (Math.abs(x) < EPS && Math.abs(y) < EPS && Math.abs(z) < EPS && Math.abs(Math.abs(w) - 1) < EPS) continue; // at rest → skip
            const e = Scene3DAnimation._quatToEulerDeg(q);
            lines.push(`  ${j.name.padEnd(12)} [${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)}, ${w.toFixed(4)}]  euler°(${e[0].toFixed(1)}, ${e[1].toFixed(1)}, ${e[2].toFixed(1)})`);
        }
        const head = `POSE EXPORT — skeleton ${id.slice(0, 8)} — ${lines.length} posed joint(s)\n(jointName  quat[x,y,z,w]  euler XYZ°) — paste to Claude with what the pose IS:`;
        return lines.length ? `${head}\n${lines.join('\n')}` : `${head}\n  (all joints at rest — pose the character first)`;
    }

    /**
     * Export the procedural body's PROPORTIONS as a copy-pasteable block — the body params (mesh shape) plus
     * a few rest bone lengths from the skeleton — so a captured pose can be ASSOCIATED with the body it was
     * authored on (hand-on-body poses depend on hip width / arm reach). Pass a body mesh id OR a skeleton id,
     * or omit to use the procedural body bound to the bone-overlay skeleton. Pair with exportPoseData.
     */
    exportBodyData(idOrSkel?: string): string {
        const meshes = this.host.getAllMeshes();
        let body = idOrSkel ? this.host.getMesh(idOrSkel) : undefined;
        if (!(body instanceof SkinnedMesh3D) || !body.isProceduralBody) {
            const skelId = (idOrSkel && this.host.getSkeleton(idOrSkel)) ? idOrSkel : this.host.getBoneOverlaySkeletonId();
            body = meshes.find(m => m instanceof SkinnedMesh3D && m.isProceduralBody && (!skelId || m.skeletonId === skelId))
                ?? meshes.find(m => m instanceof SkinnedMesh3D && m.isProceduralBody);
        }
        if (!(body instanceof SkinnedMesh3D) || !body.isProceduralBody || !body.skeleton) {
            return '(no procedural body found — create/select a character first)';
        }
        const params = this.host.getBodyParams(body.id);
        const byName = new Map(body.skeleton.data.joints.map(j => [j.name, j]));
        const len = (child: string): number => { const j = byName.get(child); if (!j) return 0; const p = j.localPosition; return Math.hypot(p[0], p[1], p[2]); };
        const sumY = (...names: string[]): number => names.reduce((s, n) => s + (byName.get(n)?.localPosition[1] ?? 0), 0);
        const measures: Record<string, number> = {
            upperArm: len('lowerarm_L'), forearm: len('hand_L'),
            thigh: len('lowerleg_L'), shin: len('foot_L'),
            hipsToNeck: sumY('lowerback', 'spine', 'chest', 'neck'), neckToHead: len('head'),
        };
        const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v.toFixed(3)}`).join('  ');
        return [
            `BODY EXPORT — body ${body.id.slice(0, 8)} (skeleton ${body.skeletonId?.slice(0, 8) ?? '?'})`,
            `params: ${params ? JSON.stringify(params) : '(none cached)'}`,
            `rest measures (world units): ${fmt(measures)}`,
            `— paste ALONGSIDE a POSE EXPORT so Claude can associate the pose with this body.`,
        ].join('\n');
    }

    // ── Pose Library ─────────────────────────────────────────────────────

    capturePose(skelId: string, name: string): string {
        const skel = this.host.getSkeleton(skelId);
        if (!skel) throw new Error(`Skeleton not found: ${skelId}`);
        if (!skel.data.poses) skel.data.poses = [];
        const id = _nanoid();
        const rotations = skel.data.joints.map((j, i) => ({
            jointIndex: i,
            rotation: [...j.localRotation] as [number, number, number, number],
        }));
        skel.data.poses.push({ id, name, rotations });
        this.ctx.scheduleRender();
        return id;
    }

    applyPose(skelId: string, poseId: string): void {
        const skel = this.host.getSkeleton(skelId);
        const pose = skel?.data.poses?.find(p => p.id === poseId);
        if (!skel || !pose) return;
        // A deliberately-applied pose is the new authored state — drop any pre-play snapshot so it can't
        // override this pose at save time.
        this._playbackSnapshots.delete(skelId);
        for (const entry of pose.rotations) {
            const joint = skel.data.joints[entry.jointIndex];
            if (joint) joint.localRotation = [...entry.rotation] as [number, number, number, number];
        }
        // Body-ADAPTIVE arm blend: slerp the captured samples by this body's girth (so a hand-on-hip pose
        // fits thin AND fat bodies). Done AFTER the base rotations (which are the fallback look).
        if (pose.adaptive?.samples.length) this._applyAdaptivePose(skel, pose.adaptive);
        else this.host.clearArmsForSkeleton?.(skel);   // keep hanging arms out of THIS body's torso (arm-clearance.ts)
        skel.computeWorldMatrices();
        skel.matricesDirty = true;
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /**
     * Blend a pose's captured arm samples by a body metric and write the result to the arm joints (LEFT mirrored
     * to RIGHT). `girth` = torsoThick + hipWidth — as it rises the shoulder abducts less + the elbow bends more.
     * Slerps between the two bracketing samples (clamped outside the range), so endpoints are exact captures and
     * in-betweens are smooth. Far more reliable than IK for redundant hand-on-body poses (no awkward solutions).
     */
    private _applyAdaptivePose(skel: Skeleton3D, adaptive: { metric: 'girth'; samples: import('../../types/armature-3d').AdaptivePoseSample[] }): void {
        const body = this.host.getAllMeshes().find(m => m instanceof SkinnedMesh3D && m.isProceduralBody && m.skeletonId === skel.id) as SkinnedMesh3D | undefined;
        const params = body ? this.host.getBodyParams(body.id) : null;
        const girth = (params?.torsoThick ?? 1) + (params?.hipWidth ?? 1);
        const s = [...adaptive.samples].sort((a, b) => a.at - b.at);
        let lo = s[0], hi = s[s.length - 1];
        for (let i = 0; i < s.length - 1; i++) { if (girth >= s[i].at && girth <= s[i + 1].at) { lo = s[i]; hi = s[i + 1]; break; } }
        const t = hi.at > lo.at ? Math.max(0, Math.min(1, (girth - lo.at) / (hi.at - lo.at))) : 0;
        const byName = new Map(skel.data.joints.map(j => [j.name, j]));
        const tmp = quat.create();
        for (const name of Object.keys(lo.left)) {
            const a = lo.left[name], b = hi.left[name] ?? a;
            quat.slerp(tmp, a as unknown as quat, b as unknown as quat, t);
            const ql: [number, number, number, number] = [tmp[0], tmp[1], tmp[2], tmp[3]];
            const jl = byName.get(name); if (jl) jl.localRotation = [...ql] as [number, number, number, number];
            const jr = byName.get(name.replace('_L', '_R'));   // mirror across the body's symmetry plane
            if (jr && name.endsWith('_L')) jr.localRotation = [ql[0], -ql[1], -ql[2], ql[3]];
        }
    }

    getPoses(skelId: string): { id: string; name: string; region?: AnimRegion }[] {
        const skel = this.host.getSkeleton(skelId);
        return (skel?.data.poses ?? []).map(p => ({ id: p.id, name: p.name, region: p.region }));
    }

    /** Tag a pose's spatial region (Left/Right/Top/Bottom/Center) for library filtering; null clears it. */
    setPoseRegion(skelId: string, poseId: string, region: AnimRegion | null): void {
        const pose = this.host.getSkeleton(skelId)?.data.poses?.find(p => p.id === poseId);
        if (pose) { if (region) pose.region = region; else delete pose.region; this.ctx.emitSceneGraphChanged(); }
    }

    /** Tag a clip's spatial region (Left/Right/Top/Bottom/Center); null clears it. */
    setClipRegion(clipId: string, region: AnimRegion | null): void {
        const found = this.host.findClip(clipId);
        if (found) { if (region) found.clip.region = region; else delete found.clip.region; this.ctx.emitSceneGraphChanged(); }
    }

    /** All poses + clips on a skeleton with the given region — drives the Left/Right/Top/Bottom/Center filter. */
    getAnimationsByRegion(skelId: string, region: AnimRegion): { poses: { id: string; name: string }[]; clips: SkeletonAnimClip[] } {
        const skel = this.host.getSkeleton(skelId);
        return {
            poses: (skel?.data.poses ?? []).filter(p => p.region === region).map(p => ({ id: p.id, name: p.name })),
            clips: (skel?.data.clips ?? []).filter(c => c.region === region),
        };
    }

    renamePose(skelId: string, poseId: string, name: string): void {
        const pose = this.host.getSkeleton(skelId)?.data.poses?.find(p => p.id === poseId);
        if (pose) { pose.name = name; this.ctx.emitSceneGraphChanged(); }
    }

    deletePose(skelId: string, poseId: string): void {
        const skel = this.host.getSkeleton(skelId);
        if (!skel?.data.poses) return;
        skel.data.poses = skel.data.poses.filter(p => p.id !== poseId);
        this.ctx.emitSceneGraphChanged();
    }

    // ── Frame Link Animation 3D ──────────────────────────────────────

    /** Set (or replace) the procedural frame-link animation for a mesh or MeshGroup3D.
     *  When called on a group, the same config is written to every Mesh3D child (write-time
     *  propagation). Each child stores an independent entry so the evaluation and serialization
     *  paths are unchanged. */
    setFrameLinkAnimation3D(meshId: string, anim: Partial<FrameLinkAnimation3D>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            let any = false;
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    this.setFrameLinkAnimation3D(child.id, anim);
                    any = true;
                }
            }
            return any;
        }
        if (!this.host.getMesh(meshId)) return false;
        const existing = this._frameLinkAnims.get(meshId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION_3D };
        const merged = { ...existing, ...anim };
        this._frameLinkAnims.set(meshId, merged);
        this._flaRest.delete(meshId); // re-capture rest on next frame
        if (merged.enabled && merged.type === 'scroll') {
            this.host.startScrollAnimation(meshId);   // reset scroll counter + start the ribbon tick
        }
        return true;
    }

    /** Get the frame-link animation config for a mesh or group.
     *  For groups, returns the first child's config as a representative value. */
    getFrameLinkAnimation3D(meshId: string): FrameLinkAnimation3D | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    const fla = this._frameLinkAnims.get(child.id);
                    if (fla) return fla;
                }
            }
            return null;
        }
        return this._frameLinkAnims.get(meshId) ?? null;
    }

    /** Remove the frame-link animation from a mesh or all children of a MeshGroup3D. */
    removeFrameLinkAnimation3D(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            let any = false;
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    this.host.clearScrollFrames(child.id);
                    this._flaRest.delete(child.id);
                    any = this._frameLinkAnims.delete(child.id) || any;
                }
            }
            return any;
        }
        this.host.clearScrollFrames(meshId);
        this._flaRest.delete(meshId);
        return this._frameLinkAnims.delete(meshId);
    }

    // ── Procedural idle (breathing / weight-shift / sway) ────────────────────────────────────────────

    /** Toggle a gentle, looping IDLE animation on a standing character — breathing, weight-shift + sway, a slow head
     *  drift — driven procedurally (no keyframes). Layers on top of the current pose (captures it as the base), and
     *  the hair/chains/pendant SWING with it (it runs before the spring solve). `intensity` 0..~2 scales the motion. */
    /** Create (once) + register the procedural-idle pre-render callback on the CURRENT renderer, idempotently.
     *  DECOUPLED from orbit controls: `disableOrbitControls` (fired by the host when LEAVING an edit mode) used to
     *  strip this callback, which is exactly why the idle only ran in Edit Mesh/UV mode and died in normal view.
     *  Now `setIdleAnimation(on)` ensures it's registered regardless of orbit state. `addPreRenderCallback` dedupes
     *  by reference, so calling this repeatedly is safe and preserves ordering (it lands before the spring solve
     *  when orbit setup runs first → hair/chains still react to the breathing). */
    ensureIdleCallback(): void {
        if (!this._idleSolveCallback) {
            this._idleSolveCallback = () => {
                if (this._idleRigs.size === 0) return false;
                // Armature posing pauses the idle — except for a body playing a clip OVER its idle (playClipOverIdle).
                const posing = this.host.isBoneOverlayActive();
                // Kept in step even while paused (the armature pauses the idle on a tablet): entering posing must still
                // snap to the clean base, and leaving it must still re-capture the pose as the new base.
                this._syncIdleWithPosing(posing);   // enter → snap to the clean base; leave → the new pose BECOMES the base
                if (this._idlePauses.size > 0) return false;   // paused (e.g. UV paint on a tablet): no pose work, no keep-alive
                if (posing && ![...this._idleBreaks.values()].some(b => b.active?.overIdle)) return false;
                const now = performance.now();
                let animating = false;
                this.host.simLodBegin?.('characters');
                for (const [bodyMeshId, rig] of this._idleRigs) {
                    const skel = this.host.getSkeleton(rig.skelId);
                    if (!skel) continue;
                    if (posing && !this._idleBreaks.get(bodyMeshId)?.active?.overIdle) continue;
                    // Play: the locomotion owns the Player's rig (Stand / Walk / Run / Jump …) — never overwrite it.
                    if (this.host.isSkeletonPlayDriven?.(rig.skelId)) continue;
                    // R6.1: the renderer culled this whole character last frame (out of view with a margin, no shadow
                    // into the view) → skip its pose work. Everything here is driven by absolute time (rig.t0 /
                    // break t0), so it resumes at the right phase; the skeleton's skin buffer stays dirty-free.
                    if (this.host.isSkeletonAnimCulled?.(rig.skelId)) { animating = true; continue; }
                    // SIM LOD: mid-distance idles pose at ~10 Hz, far / off-screen ones at ~2 Hz, fogged ones never —
                    // the same absolute-time rule, so a skipped frame just resumes at the right phase.
                    if (this.host.simLodDue && !this.host.simLodDue(rig.skelId, bodyMeshId)) { animating = true; continue; }
                    // Idle BREAK: a one-shot personality clip occasionally plays OVER the base idle, then settles
                    // back. While it plays it drives the joints (the procedural idle is skipped that frame).
                    if (this._tickIdleBreak(skel, rig, bodyMeshId, now)) { animating = true; continue; }
                    this.applyIdle(skel, rig, (now - rig.t0) / 1000);   // base breathing / weight-shift / sway
                    this._finishIdleRig(skel, rig, bodyMeshId);          // squash/stretch (if on) + re-FK + springs
                    animating = true;
                }
                return animating;   // keep the render loop ticking while idling
            };
        }
        this.ctx.webgpuRenderer.addPreRenderCallback(this._idleSolveCallback, 'idle');   // idempotent (dedupes by ref)
    }

    /** SIM LOD exemption: a timeline / clip / NLA preview is playing (the user is watching characters animate). */
    hasActivePlayback(): boolean {
        if (this._animPlayer?.playing) return true;
        for (const e of this._playbackSnapshots.values()) if (e.player.playing) return true;
        for (const p of this._nlaPlayers.values()) if (p.playing) return true;
        return false;
    }

    /** Skeletons whose idle rig was paused for armature posing (their pose is re-captured when posing ends). */
    private _posingSkels = new Set<string>();
    /**
     * Keep the procedural idle in step with ARMATURE POSING. The idle re-applies `rig.base` + breathing every frame, and
     * `base` was captured when the idle turned on — so a pose made in armature mode was overwritten the moment you left
     * it (the "stuck in T-pose" bug: the idle's base was the old T-pose). Now:
     *  • posing STARTS → the paused character snaps to its clean base (you pose from the authored stance, not a
     *    mid-breath frame);
     *  • posing ENDS → the pose you made is re-captured as the new base, and the idle carries on from it.
     */
    private _syncIdleWithPosing(posing: boolean): void {
        if (posing) {
            for (const [bodyMeshId, rig] of this._idleRigs) {
                if (this._posingSkels.has(rig.skelId) || this._idleBreaks.get(bodyMeshId)?.active?.overIdle) continue;
                const skel = this.host.getSkeleton(rig.skelId);
                if (!skel) continue;
                this._posingSkels.add(rig.skelId);
                for (const [name, q] of rig.base) {
                    const j = skel.data.joints.find(jt => jt.name === name);
                    if (j) { j.localRotation = [...q] as [number, number, number, number]; j.localScale = [1, 1, 1]; }
                }
                skel.computeWorldMatrices(); skel.matricesDirty = true;
            }
            return;
        }
        if (this._posingSkels.size === 0) return;
        for (const rig of this._idleRigs.values()) {
            if (!this._posingSkels.has(rig.skelId)) continue;
            const skel = this.host.getSkeleton(rig.skelId);
            if (!skel) continue;
            for (const name of rig.base.keys()) {
                const j = skel.data.joints.find(jt => jt.name === name);
                if (j) rig.base.set(name, [...(j.constraintRotation ?? j.ikRotation ?? j.localRotation)] as [number, number, number, number]);
            }
        }
        this._posingSkels.clear();
    }

    /** The idle's captured base pose for a body (joint name → rotation), or null when its idle is off. Mutable: a caller
     *  that corrects the authored pose while the idle runs (arm clearance) writes the new rotation here too, or the
     *  next idle frame would put the old one back. */
    getIdleBase(bodyMeshId: string): Map<string, [number, number, number, number]> | null {
        return this._idleRigs.get(bodyMeshId)?.base ?? null;
    }

    setIdleAnimation(bodyMeshId: string, on: boolean, intensity = 1): void {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton || !body.skeletonId) return;
        const skel = body.skeleton;
        const wasOn = this._idleRigs.has(bodyMeshId);
        if (on) {
            this.ensureIdleCallback();   // make sure the per-frame callback is registered (independent of orbit controls)
            const base = new Map<string, [number, number, number, number]>();   // snapshot the pose we layer onto
            for (const name of [...IDLE_JOINTS, ...LEG_IDLE_JOINTS]) {
                const j = skel.data.joints.find(jt => jt.name === name);
                // capture the EFFECTIVE rotation (what FK actually uses), so the idle layers onto the real current pose
                if (j) base.set(name, [...(j.constraintRotation ?? j.ikRotation ?? j.localRotation)] as [number, number, number, number]);
            }
            const legMode = this._legIdleModes.get(bodyMeshId) ?? 'fk';   // micro-FK by default (free; feet drift ~cm)
            const rig: IdleRig = { skelId: body.skeletonId, intensity, t0: performance.now(), base, legMode };
            this._idleRigs.set(bodyMeshId, rig);
            if (legMode === 'ik') this._setupLegIK(skel, rig);   // pin the feet + enable the leg chains
            // Drive CONTINUOUS rendering while idling. The on-demand view only animated in Edit Mesh/UV mode because
            // SOMETHING there forces a frame every vsync (the animated 'wavy' bg rides that loop — it doesn't cause it).
            // (1) START the renderer's OWN live rAF loop (`play()`) — Salsa renders every frame on its own, independent
            //     of the host. Cooperative with the focus-bg hold: _syncCohortLiveLoop only starts a loop nothing else
            //     already drives, and only the cohort that started it pauses it (never stomp a clip/other owner).
            // (While paused — setIdleAnimationPaused — neither hold is taken; resuming takes them.)
            if (this._idlePauses.size === 0) this.host.setIdleLiveHold(true);
            // (2) ALSO emit the interactive signal (renderer + host both subscribe) so a host that composites the 3D
            //     view on-demand keeps re-compositing too.
            if (!wasOn && this._idlePauses.size === 0) this.ctx.interactionService.beginInteractive();
        } else {
            const rig = this._idleRigs.get(bodyMeshId);
            const posedLive = !!rig && this._posingSkels.delete(rig.skelId);   // turned off mid-posing → keep the pose being made
            if (rig) {   // restore the base pose so the character settles back to its rest stance
                this._teardownLegIK(skel, rig);   // disable leg chains + clear their ikRotation (BEFORE we re-FK)
                if (!posedLive) for (const [name, q] of rig.base) {
                    const j = skel.data.joints.find(jt => jt.name === name);
                    if (j) j.localRotation = [...q] as [number, number, number, number];
                }
                skel.computeWorldMatrices(); skel.matricesDirty = true;
            }
            this._idleRigs.delete(bodyMeshId);
            const paused = this._idlePauses.size > 0;   // paused → the holds were already released
            if (wasOn && !paused) this.ctx.interactionService.endInteractive();   // release the interactive signal
            if (this._idleRigs.size === 0 && !paused) this.host.setIdleLiveHold(false);   // last idle off → release our hold (focus-bg may still need the loop)
        }
        this.ctx.scheduleRender();
    }

    /** Reasons the idle is paused (e.g. 'uvPaint'). While any is set the idle callback does no pose work and holds
     *  neither the live loop nor the interactive signal; the characters stay in their current pose. */
    private readonly _idlePauses = new Set<string>();
    /**
     * Pause / resume EVERY procedural idle for `reason` (mobile-parity 7.3b P3: UV paint on a tablet — the idle re-poses
     * the rig every frame, so the loop renders every vsync and the skinned pick re-skins per move). The rigs stay
     * registered; resuming re-takes the holds exactly as setIdleAnimation(on) took them and the idle carries on from
     * absolute time (like a SIM-LOD skip). Reasons nest: the idle runs again when the last one is cleared.
     */
    setIdleAnimationPaused(reason: string, paused: boolean): void {
        const was = this._idlePauses.size > 0;
        if (paused) this._idlePauses.add(reason); else this._idlePauses.delete(reason);
        const now = this._idlePauses.size > 0;
        if (was === now) return;
        const n = this._idleRigs.size;
        if (n > 0) {
            if (now) {
                for (let i = 0; i < n; i++) this.ctx.interactionService.endInteractive();
                this.host.setIdleLiveHold(false);
            } else {
                this.host.setIdleLiveHold(true);
                for (let i = 0; i < n; i++) this.ctx.interactionService.beginInteractive();
            }
        }
        this.ctx.scheduleRender();
    }
    /** Whether the idle is paused (any reason). */
    isIdleAnimationPaused(): boolean { return this._idlePauses.size > 0; }
    /** Whether a body currently has the idle animation running. */
    isIdleAnimating(bodyMeshId: string): boolean { return this._idleRigs.has(bodyMeshId); }

    /** Pin both feet as IK targets at their current (rest) world position + enable the leg chains, so the idle can
     *  shift the pelvis while the feet stay planted. No-op if the skeleton has no foot chains (older rigs). */
    private _setupLegIK(skel: Skeleton3D, rig: IdleRig): void {
        skel.computeWorldMatrices();   // ensure the foot world positions we pin as targets are current
        const chains: { id: string; footName: string }[] = [];
        for (const c of skel.data.ikChains ?? []) {
            const footName = skel.data.joints[c.endJointIdx]?.name;
            if (footName !== 'foot_L' && footName !== 'foot_R') continue;
            const foot = skel.data.joints[c.endJointIdx];
            c.target = [foot.worldMatrix[12], foot.worldMatrix[13], foot.worldMatrix[14]];   // pin where it rests
            c.enabled = true;
            chains.push({ id: c.id, footName });
        }
        rig.legChains = chains;
    }
    /** Undo _setupLegIK: disable the leg chains + clear the leg joints' ikRotation so FK/manual posing resumes cleanly. */
    private _teardownLegIK(skel: Skeleton3D, rig: IdleRig): void {
        if (!rig.legChains?.length) return;
        for (const lc of rig.legChains) {
            const c = (skel.data.ikChains ?? []).find(cc => cc.id === lc.id);
            if (c) c.enabled = false;
        }
        for (const name of LEG_IDLE_JOINTS) {
            const j = skel.data.joints.find(jt => jt.name === name);
            if (j) j.ikRotation = undefined;
        }
        rig.legChains = undefined;
    }
    /** Set a character's leg idle fidelity: 'fk' (default) = free micro weight-shift (feet oscillate ~cm), 'ik' = feet
     *  PINNED via foot-IK while the pelvis shifts (locked feet, +2 solves/frame), 'none' = legs static. Persists across
     *  idle on/off; reconfigures a running idle immediately. */
    setLegIdleMode(bodyMeshId: string, mode: LegIdleMode): void {
        this._legIdleModes.set(bodyMeshId, mode);
        const rig = this._idleRigs.get(bodyMeshId);
        if (!rig) return;                                            // not idling → applies next time idle starts
        const skel = this.host.getSkeleton(rig.skelId);
        if (!skel) return;
        if (rig.legMode === 'ik') this._teardownLegIK(skel, rig);    // leaving IK → release the pins
        rig.legMode = mode;
        if (mode === 'ik') { this._setupLegIK(skel, rig); }          // entering IK → pin the feet now
        else {                                                       // → restore legs to their captured base (no frozen frame)
            for (const name of LEG_IDLE_JOINTS) {
                const q = rig.base.get(name); const j = skel.data.joints.find(jt => jt.name === name);
                if (q && j) { j.localRotation = [...q] as [number, number, number, number]; j.ikRotation = undefined; }
            }
        }
        skel.computeWorldMatrices(); skel.matricesDirty = true;
        this.ctx.scheduleRender();
    }
    /** A character's current leg idle fidelity (default 'fk'). */
    getLegIdleMode(bodyMeshId: string): LegIdleMode { return this._legIdleModes.get(bodyMeshId) ?? 'fk'; }

    // ── Idle breaks (random one-shot personality clips between the base idle) ──
    private _idleBreaks = new Map<string, { enabled: boolean; minSec: number; maxSec: number; clips: string[]; active: { clipId: string; t0: number; clip?: SkeletonAnimClip; lastFrame?: number; overIdle?: boolean; idleOffAfter?: boolean; restore?: Map<number, [number, number, number, number]> } | null; nextAt: number }>();

    /** A break/over-idle copy of a clip, re-based onto the rig's idle base (rebaseClipRest, default-stance tracks only). */
    private _layeredClipCopy(skel: Skeleton3D, rig: IdleRig, src: SkeletonAnimClip): SkeletonAnimClip {
        const base = new Map<number, readonly number[]>();
        skel.data.joints.forEach((j, i) => { const q = rig.base.get(j.name); if (q) base.set(i, q); });
        return rebaseClipRest(src, base, (ji) => defaultRestRotation(skel.data.joints[ji]?.name ?? ''));
    }

    /**
     * Play a clip ONCE layered OVER the procedural idle: the idle keeps breathing / swaying / shifting every joint the
     * clip doesn't animate (a wave no longer freezes the rest of the body), the clip crossfades in and out, its face
     * events fire, and stock one-shots leave from + return to the character's real stance. If the idle is off it's
     * turned on for the clip and back off after. Also works in armature mode (where the idle is otherwise paused).
     * `clip` = a clip NAME or id on the body's skeleton. Returns false if the body or clip isn't found.
     */
    playClipOverIdle(bodyMeshId: string, clip: string): boolean {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return false;
        const skel = body.skeleton;
        const src = skel.data.clips?.find(c => c.id === clip) ?? skel.data.clips?.find(c => c.name === clip);
        if (!src) return false;
        const wasIdle = this._idleRigs.has(bodyMeshId);
        if (!wasIdle) this.setIdleAnimation(bodyMeshId, true);
        const rig = this._idleRigs.get(bodyMeshId);
        if (!rig) return false;
        const br = this._idleBreaks.get(bodyMeshId) ?? { enabled: false, minSec: 8, maxSec: 20, clips: [], active: null, nextAt: Infinity };
        // Joints the clip animates that the idle doesn't own: snapshot them so they're put back when it ends (the clip
        // stops on its last sampled frame, not exactly its end key).
        const restore = new Map<number, [number, number, number, number]>();
        for (const t of src.tracks) {
            const j = skel.data.joints[t.jointIndex];
            if (t.channel === 'rotation' && j && !rig.base.has(j.name)) restore.set(t.jointIndex, [...j.localRotation] as [number, number, number, number]);
        }
        br.active = { clipId: src.id, t0: performance.now(), clip: this._layeredClipCopy(skel, rig, src), lastFrame: -1, overIdle: true, idleOffAfter: !wasIdle, restore };
        this._idleBreaks.set(bodyMeshId, br);
        this.ensureIdleCallback();
        this.ctx.scheduleRender();
        return true;
    }
    /** Whether a body is currently playing a clip over its idle (playClipOverIdle) or an idle break. */
    isPlayingOverIdle(bodyMeshId: string): boolean { return !!this._idleBreaks.get(bodyMeshId)?.active; }

    /**
     * Configure random IDLE BREAKS — the BotW "alive" multiplier: between the base idle, every [minSec,maxSec]
     * (small random range) a random one-shot clip plays (Stretch / Scratch Head / …) then settles back. Requires
     * the base idle to be ON (setIdleAnimation) — breaks tick inside its per-frame callback. `clips` = clip NAMES
     * eligible to fire (default = the built-in one-shots present on the skeleton; any one-shot clip you add is
     * eligible). enabled:false stops breaks. Defaults: minSec 8, maxSec 20.
     */
    setIdleBreaks(bodyMeshId: string, opts: { enabled?: boolean; minSec?: number; maxSec?: number; clips?: string[] }): void {
        const cur = this._idleBreaks.get(bodyMeshId) ?? { enabled: false, minSec: 8, maxSec: 20, clips: [], active: null, nextAt: 0 };
        const next = { ...cur, ...opts, active: cur.active };
        if (opts.enabled && !cur.enabled) next.nextAt = performance.now() + this._idleBreakDelay(next);   // first break
        if (opts.enabled === false) next.active = null;                                                    // stop any in-flight break
        this._idleBreaks.set(bodyMeshId, next);
        if (next.enabled) this.ensureIdleCallback();
    }

    private _idleBreakDelay(b: { minSec: number; maxSec: number }): number {
        return (b.minSec + Math.random() * Math.max(0, b.maxSec - b.minSec)) * 1000;
    }
    private _pickIdleBreakClip(skel: Skeleton3D, names: string[]): string | null {
        const want = names.length ? names : DEFAULT_BREAK_CLIP_NAMES;
        const matches = (skel.data.clips ?? []).filter(c => want.includes(c.name));
        return matches.length ? matches[Math.floor(Math.random() * matches.length)].id : null;
    }
    /** Clear stale IK/constraint rotation on a clip's tracked joints so FK reads the clip's localRotation
     *  (matches what _applyIdle does for its joints — prevents a leftover IK pose hiding the break). */
    private _clearClipIK(skel: Skeleton3D, clip: { tracks: { jointIndex: number }[] }): void {
        for (const tr of clip.tracks) { const j = skel.data.joints[tr.jointIndex]; if (j) { j.ikRotation = undefined; j.constraintRotation = undefined; } }
    }
    /** Tick a body's idle break. Returns true if a break is CURRENTLY playing (so the base idle is skipped). */
    private _tickIdleBreak(skel: Skeleton3D, rig: IdleRig, bodyMeshId: string, now: number): boolean {
        const br = this._idleBreaks.get(bodyMeshId);
        if (!br || (!br.enabled && !br.active)) return false;
        if (br.active) {
            const clip = br.active.clip ?? skel.data.clips?.find(c => c.id === br.active!.clipId);
            if (clip) {
                const tSec = (now - br.active.t0) / 1000;
                const frame = tSec * clip.fps;
                this._fireFaceEvents(skel, clip, br.active.lastFrame ?? -1, Math.min(frame, clip.endFrame)); br.active.lastFrame = Math.min(frame, clip.endFrame);
                if (frame < clip.endFrame) {
                    // Base idle on ALL joints first → untracked joints (legs, the far arm) keep breathing through
                    // the break; the clip + crossfade only override the joints the break actually animates.
                    this.applyIdle(skel, rig, (now - rig.t0) / 1000);
                    // Crossfade weight: ease 0→1 over the first `fade` s, 1→0 over the last `fade` s.
                    const durSec = clip.endFrame / Math.max(1, clip.fps);
                    const fade = Math.min(0.25, durSec * 0.3);
                    const w = Math.max(0, Math.min(1, Math.min(tSec / fade, (durSec - tSec) / fade)));
                    // No FK inside the clip apply: nothing below reads world matrices, and _finishIdleRig runs the
                    // full FK pass on the final pose (§7.3d — was a wasted extra pass a frame). A non-parent-first rig
                    // keeps it (its FK result depends on the previous world state, so the extra pass is not a no-op).
                    const clipFK = !skel.isParentFirst();
                    if (w >= 0.999) {
                        applySkeletonClipAtFrame(clip, skel, frame, clipFK);
                        this._clearClipIK(skel, clip);
                    } else {
                        // snapshot the idle pose on the clip's rotation joints, apply the clip, slerp back by w
                        const idleQ = new Map<number, [number, number, number, number]>();
                        for (const tr of clip.tracks) if (tr.channel === 'rotation') idleQ.set(tr.jointIndex, [...skel.data.joints[tr.jointIndex].localRotation] as [number, number, number, number]);
                        applySkeletonClipAtFrame(clip, skel, frame, clipFK);
                        this._clearClipIK(skel, clip);
                        const tmp = quat.create();
                        for (const [ji, q0] of idleQ) {
                            const j = skel.data.joints[ji];
                            quat.slerp(tmp, q0 as unknown as quat, j.localRotation as unknown as quat, w);
                            j.localRotation = [tmp[0], tmp[1], tmp[2], tmp[3]];
                        }
                    }
                    this._finishIdleRig(skel, rig, bodyMeshId);   // squash/stretch (if on) + re-FK + springs
                    return true;
                }
            }
            const idleOff = br.active.idleOffAfter;
            for (const [ji, q] of br.active.restore ?? []) { const j = skel.data.joints[ji]; if (j) j.localRotation = [...q] as [number, number, number, number]; }
            br.active = null; br.nextAt = br.enabled ? now + this._idleBreakDelay(br) : Infinity;   // finished → schedule the next
            if (idleOff) { this.setIdleAnimation(bodyMeshId, false); return true; }   // idle was on just for this clip → off (base restored; skip this frame's idle step)
        } else if (br.enabled && now >= br.nextAt) {
            const clipId = this._pickIdleBreakClip(skel, br.clips);
            if (clipId) {
                // Play a copy whose rest keys sit on THIS character's current (idle base) pose — see rebaseClipRest.
                const src = skel.data.clips?.find(c => c.id === clipId);
                br.active = { clipId, t0: now, clip: src ? this._layeredClipCopy(skel, rig, src) : undefined };
                return this._tickIdleBreak(skel, rig, bodyMeshId, now);   // play it now
            }
            br.nextAt = now + this._idleBreakDelay(br);                     // none eligible → try again later
        }
        return false;
    }

    // ── Squash & stretch (Option B — procedural volume change on top of ANY pose) ──
    private _squashStretch = new Map<string, { enabled: boolean; intensity: number; restSpan: number }>();

    /**
     * Toggle procedural SQUASH & STRETCH — a volume-preserving torso scale derived from how extended/compressed
     * the body is each frame (whole-body vertical span vs its rest span): reach/arms-up → STRETCH (taller+thinner),
     * crouch → SQUASH (shorter+wider), with X/Z = 1/√(Y). Layers on top of the idle + break clips (no per-clip
     * authoring). `intensity` ~0.04–0.12 (subtle; default 0.06); the effect is clamped. Requires the base idle ON (it applies in
     * the idle/break finalize each frame). NOTE: drives lowerback+spine, so push intensity too high and raised
     * arms can shear — keep it subtle.
     */
    setSquashStretch(bodyMeshId: string, opts: { enabled?: boolean; intensity?: number }): void {
        const cur = this._squashStretch.get(bodyMeshId) ?? { enabled: false, intensity: 0.06, restSpan: 0 };
        const next = { ...cur, ...opts };
        if (opts.enabled && !cur.enabled) next.restSpan = 0;   // recalibrate the rest span on (re)enable
        this._squashStretch.set(bodyMeshId, next);
        if (opts.enabled === false) {   // reset the torso scale to rest immediately
            const body = this.host.getMesh(bodyMeshId);
            const skel = body instanceof SkinnedMesh3D ? body.skeleton : null;
            for (const n of ['lowerback', 'spine']) { const j = skel?.data.joints.find(jj => jj.name === n); if (j) j.localScale = [1, 1, 1]; }
            skel?.computeWorldMatrices(); if (skel) skel.matricesDirty = true;
            this.ctx.scheduleRender();
        } else { this.ensureIdleCallback(); }
    }

    /** Finalize an idle/break frame: apply procedural squash/stretch (if enabled) then re-FK + keep springs alive.
     *  Measures the CLEAN pose (scale reset first) so the span signal doesn't feed back on itself. */
    private _finishIdleRig(skel: Skeleton3D, rig: IdleRig, bodyMeshId: string): void {
        const ss = this._squashStretch.get(bodyMeshId);
        const joints = skel.data.joints;
        const lbI = ss?.enabled ? joints.findIndex(j => j.name === 'lowerback') : -1;
        const spI = ss?.enabled ? joints.findIndex(j => j.name === 'spine') : -1;
        const lb = lbI >= 0 ? joints[lbI] : undefined;
        const sp = spI >= 0 ? joints[spI] : undefined;
        // ONE full FK pass a frame (§7.3d). Every later pass only re-derives the subtrees whose inputs just changed
        // (squash → the lowerback/spine scale; foot IK → the leg joints IK wrote) — bit-identical to the full passes
        // it used to run (up to 4 a frame with squash + foot IK).
        const sub = this._idleSubtrees; sub.length = 0;
        if (ss?.enabled && lb && sp) {
            lb.localScale = [1, 1, 1]; sp.localScale = [1, 1, 1];   // clean pose for the measurement
            skel.computeWorldMatrices();
            let minY = Infinity, maxY = -Infinity;
            for (const j of skel.data.joints) {
                if (/spring|charm|dangle|tail/i.test(j.name)) continue;   // ignore hair/charm bones
                const y = j.worldMatrix[13]; if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
            const span = maxY - minY;
            if (ss.restSpan <= 0) ss.restSpan = span;                     // lazy rest calibration (first frame)
            const ratio = ss.restSpan > 0 ? span / ss.restSpan : 1;
            const k = Math.max(0.88, Math.min(1.15, 1 + (ratio - 1) * ss.intensity));   // Y factor (clamped)
            const s = 1 / Math.sqrt(k);                                   // X/Z = volume-preserving
            lb.localScale = [s, k, s]; sp.localScale = [s, k, s];
            sub.push(lbI, spI);
            skel.recomputeSubtrees(sub);   // only lowerback's + spine's subtrees changed since the measuring pass
            sub.length = 0;
        } else {
            skel.computeWorldMatrices();
        }
        // Foot-IK weight-shift: the pelvis just moved (in _applyIdle); re-solve the knees so the PINNED feet stay
        // planted. TWO passes: solveIKChain's position→rotation step is APPROXIMATE (per-joint minimal-arc from the
        // PRE-solve bone directions, applied once), so a single pass leaves the foot slightly off target and it
        // visibly "chases" the moving pelvis a frame behind (the staggered/delayed look). The 2nd pass warm-starts
        // from the 1st result (foot already near target → origDir ≈ newDir), collapsing the conversion error to ~0
        // so the feet lock solid. Cheap: 2 leg chains. (Bump to 3 if any residual chase remains.)
        if (rig.legMode === 'ik' && rig.legChains?.length) {
            solveAllIKChains(skel, sub); skel.recomputeSubtrees(sub); sub.length = 0;   // each pass: only the IK-moved legs
            solveAllIKChains(skel, sub); skel.recomputeSubtrees(sub); sub.length = 0;
        }
        skel.matricesDirty = true;
        this.host.keepSpringsAlive(rig.skelId, 250);
    }

    /** Apply one frame of the idle pose: small phase-offset sine waves on the torso/head, composed onto the captured
     *  base rotations. Breathing ~4.5s, weight-shift/sway ~9.5s, head drift ~16s — kept tiny + organic. */
    // Idle-solver scratch: a name→index map cached per skeleton (rebuilt only when joint count changes — was
    // a fresh Map rebuilt over ALL joints every frame) + reused quats (was quat.create() + an array literal
    // per joint-set, ~15/frame). WeakMap auto-frees when the skeleton is GC'd (no manual cleanup needed).
    private _idleIdxCache = new WeakMap<Skeleton3D, { n: number; idx: Map<string, number> }>();
    /** Reused subtree-root list for _finishIdleRig's partial FK passes. */
    private readonly _idleSubtrees: number[] = [];
    private readonly _idleTmpQuat = quat.create();
    private readonly _idleOutQuat = quat.create();

    applyIdle(skel: Skeleton3D, rig: { intensity: number; base: Map<string, [number, number, number, number]>; legMode: LegIdleMode }, t: number): void {
        const k = rig.intensity;
        // ORGANIC rhythms (round 2, 2026-09-28): pure sines read metronomic. Breath = a real breath SHAPE (quicker
        // inhale, a beat's pause at the top, longer exhale); sway/drift = two incommensurate tones so the motion never
        // visibly repeats. All stay in −1..1 like the old sines, so every amplitude below keeps its meaning.
        const breathAt = (tt: number): number => {
            const ph = ((tt * 0.22) % 1 + 1) % 1;                       // 0..1 over one ~4.5 s breath
            const e = (x: number) => x * x * (3 - 2 * x);
            return ph < 0.38 ? -1 + 2 * e(ph / 0.38) : ph < 0.48 ? 1 : 1 - 2 * e((ph - 0.48) / 0.52);
        };
        const tone2 = (tt: number, f: number, ph: number): number =>
            (Math.sin(tt * Math.PI * 2 * f + ph) + 0.35 * Math.sin(tt * Math.PI * 2 * f * 2.37 + ph * 1.7)) / 1.35;
        const breath = breathAt(t);                                    // inhale/exhale
        const sway   = tone2(t, 0.105, 0);                             // weight shift L↔R
        const sway2  = tone2(t, 0.105, 1.1);                           // a lagged copy for the shoulders
        const drift  = tone2(t, 0.062, 0.3);                           // slow head look-around
        // ARM secondary motion (pose & animation audit 2026-09-28 — the idle read "stiff" because only the torso moved
        // and the arms hung dead still). The arms trail the torso's weight-shift like a pendulum (phase-lagged), float
        // out a hair + the shoulders lift on each breath, the elbows soften with the breath, the wrists drift slowly.
        // Each side has its OWN phase so the two arms never move in lockstep (mirror-symmetric motion = mannequin).
        const swingL = tone2(t, 0.105, 2.0), swingR = tone2(t, 0.105, 2.6);
        const breathLag = breathAt(t - 0.5);                           // the arms react a beat after the chest
        const wristL = Math.sin(t * Math.PI * 2 * 0.071 + 0.4), wristR = Math.sin(t * Math.PI * 2 * 0.058 + 2.1);
        let ic = this._idleIdxCache.get(skel);
        if (!ic || ic.n !== skel.data.joints.length) {
            const m = new Map<string, number>();
            for (let i = 0; i < skel.data.joints.length; i++) m.set(skel.data.joints[i].name, i);
            ic = { n: skel.data.joints.length, idx: m };
            this._idleIdxCache.set(skel, ic);
        }
        const idx = ic.idx;
        const tmp = this._idleTmpQuat;
        const set = (name: string, pitchDeg: number, yawDeg: number, rollDeg: number): void => {
            const i = idx.get(name); if (i === undefined) return;
            const base = rig.base.get(name); if (!base) return;
            quat.fromEuler(tmp, pitchDeg * k, yawDeg * k, rollDeg * k);          // small local-space delta
            const out = quat.multiply(this._idleOutQuat, base as unknown as quat, tmp);
            const j = skel.data.joints[i];
            // Mutate localRotation in place (reused array) instead of a fresh literal every set. out is reused
            // scratch → COPY the values, never assign the reference.
            const lr = j.localRotation as number[] | undefined;
            if (lr) { lr[0] = out[0]; lr[1] = out[1]; lr[2] = out[2]; lr[3] = out[3]; }
            else j.localRotation = [out[0], out[1], out[2], out[3]];
            // CRITICAL: computeWorldMatrices() reads (constraintRotation ?? ikRotation ?? localRotation). A leftover
            // IK/constraint rotation from a prior armature edit is NEVER cleared on exit, so it silently OVERRODE the
            // idle's localRotation → "idle does nothing". Clear them on the joints we drive so our pose takes effect.
            j.ikRotation = undefined;
            j.constraintRotation = undefined;
        };
        // pitch = nod (X), yaw = turn (Y), roll = lean (Z). Gentle but clearly visible; `intensity` scales it.
        set('lowerback',  0,             sway * 1.1,  -sway * 2.0);              // sway from the LUMBAR (above the legs) → FEET STAY PLANTED (rotating the root 'hips' carried the feet sideways)
        set('spine',      breath * 1.8,  sway * 0.7,   sway * 2.8);             // chest rises, body leans back
        set('chest',      breath * 3.0,  0,            sway * 1.3);             // ribcage breath
        set('neck',      -breath * 1.4,  drift * 1.8, -sway * 1.6);             // head stays level as the chest moves
        set('head',      -breath * 0.5,  drift * 4.0, -sway * 1.1);             // a slow look-around
        // shoulder local frame: X = the arm's own axis (roll), Y = swing forward/back, Z = out/in. Right side mirrored.
        set('shoulder_L', breath * 0.6,  swingL * 1.6,  sway2 * 0.9 + breathLag * 0.6);   // pendulum trail + float out on the inhale
        set('shoulder_R', breath * 0.6, -swingR * 1.6, -sway2 * 0.9 - breathLag * 0.6);
        set('clavicle_L', 0, 0,  breath * 1.2);                                            // shoulders rise on the inhale
        set('clavicle_R', 0, 0, -breath * 1.2);
        set('lowerarm_L', 0, -(breathLag * 1.8 + swingL * 1.0), 0);                        // elbow softens (hinge = local Y; left flexes −)
        set('lowerarm_R', 0,  (breathLag * 1.8 + swingR * 1.0), 0);
        set('hand_L', 0, wristL * 1.5, -wristL * 3.0);                                     // slow wrist drift
        set('hand_R', 0, -wristR * 1.5, wristR * 3.0);
        // ── Legs (leg idle) ─────────────────────────────────────────────────────────────────────────
        // 'none' → static (torso-only idle). 'fk' → tiny weight-shift on the leg joints directly; the feet
        // oscillate ~1cm (sub-visible, free). 'ik' → drive the PELVIS only; the feet are pinned by foot-IK
        // (solved in _finishIdleRig) so the knees bend for a real, feet-locked contrapposto. Angles are first
        // guesses — tune from a screenshot (like BODY_POSES).
        if (rig.legMode === 'fk') {
            const wL = Math.max(0, sway), wR = Math.max(0, -sway);   // which leg is currently taking the weight
            set('upperleg_L', 0, 0, sway * 0.7);                     // thighs roll a hair with the sway
            set('upperleg_R', 0, 0, sway * 0.7);
            set('lowerleg_L', wR * 1.5, 0, 0);                       // the UNWEIGHTED knee softens
            set('lowerleg_R', wL * 1.5, 0, 0);
            set('foot_L', -wR * 0.8, 0, 0);                          // ankle keeps the sole roughly level
            set('foot_R', -wL * 0.8, 0, 0);
        } else if (rig.legMode === 'ik') {
            // Roll the pelvis OPPOSITE the lowerback lean (contrapposto: hips tip one way, torso counter-leans),
            // + a touch of yaw and breath bob. Feet locked by IK → the knees absorb the tilt.
            set('hips', breath * 0.3, sway * 0.7, sway * 2.4);
        }
    }
}
