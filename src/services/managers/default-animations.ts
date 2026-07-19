/**
 * Default IDLE animations + reference poses that pre-populate a freshly-created procedural body's
 * armature (Edit-Armature → Animation Clips + Pose Library). The goal is "characters feel alive even
 * when idle" — a handful of Nintendo-style micro-behaviours (breathe, shift weight, look around) plus
 * a few personality one-shots (stretch, scratch head, talk gesture) and recallable poses.
 *
 * Authored by JOINT NAME against the procedural rig (body-generator JOINTS), then resolved to indices
 * per skeleton — so a clip/pose silently drops any joint a given rig is missing.
 *
 * ── Rotation conventions (PROVEN, see body-generator.BODY_POSES + scene3d _applyIdle + the elbow/knee
 *    limitRotation hinges) ─────────────────────────────────────────────────────────────────────────
 *   ARMS rest straight OUT along ±X (the rig is a T-pose).
 *     qz = raise / lower an arm in the frontal plane.  LEFT: +up / −down.  RIGHT mirrored: −up / +down.
 *          (A-pose = L qz(-50) / R qz(+50);  arm straight up ≈ ±90;  overhead-inward ≈ ±110.)
 *     qx = tilt the arm forward (−) / back (+).
 *     qy = ELBOW hinge (lowerarm_*) — LEFT bends −, RIGHT bends +  (matches minY/maxY limits).
 *   TORSO / HEAD rest at identity.
 *     qx = nod / tilt (pitch),  qy = turn (yaw),  qz = lean (roll).
 *
 * ⚠ The arm-heavy numbers (stretch / scratch / talk / thinking / hands-on-hips) are first-guesses in the
 *   same spirit as BODY_POSES — the apply-by-name plumbing is the durable part; tweak the degrees in-app.
 */

import type { SkeletonPose, SkeletonAnimClip, SkeletonKeyframeTrack, AdaptivePoseSample, AnimRegion } from '../../types/armature-3d';

type Q = [number, number, number, number];
const IDENT: Q = [0, 0, 0, 1];

// Axis-angle quaternions in DEGREES (half-angle baked in), matching BODY_POSES exactly.
const qx = (d: number): Q => { const r = (d * Math.PI) / 360; return [Math.sin(r), 0, 0, Math.cos(r)]; };
const qy = (d: number): Q => { const r = (d * Math.PI) / 360; return [0, Math.sin(r), 0, Math.cos(r)]; };
const qz = (d: number): Q => { const r = (d * Math.PI) / 360; return [0, 0, Math.sin(r), Math.cos(r)]; };
/** a*b — applies b first, then a (same as body-generator qmul). */
const qmul = (a: Q, b: Q): Q => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** Compose left→right with the leftmost applied LAST (outermost): qc(tilt, raise) = tilt∘raise. */
const qc = (...qs: Q[]): Q => qs.reduce((acc, q) => qmul(acc, q));

// The natural arms-hang stance every pose/arm-clip starts from (body-generator BODY_POSES 'Relaxed').
// Arms hang DOWN at the sides (≈13° out from vertical so they clear the hips), NO forward tilt (the old
// qx(-5) read as "arms too far forward"), very soft elbow. MUST match BODY_POSES.Relaxed in body-generator.ts.
const REL_SH_L = qz(-77);
const REL_SH_R = qz(77);
const REL_EL_L = qy(-10);
const REL_EL_R = qy(10);
const RELAXED: Record<string, Q> = {
    shoulder_L: REL_SH_L, shoulder_R: REL_SH_R, lowerarm_L: REL_EL_L, lowerarm_R: REL_EL_R,
};

// Captured "right hand behind the head" arm (exportPoseData3D, neutral wrist) — used by the Hand Behind Head
// pose AND the Scratch Head clip. The forearm gets a small oscillation composed on top for the scratch.
const SH_BEHIND: Q = [-0.9160, 0.2031, 0.0907, -0.3340];
const EL_BEHIND: Q = [0.2948, 0.1858, 0.8522, 0.3903];
const HAND_BEHIND: Q = [0.1111, 0.1216, -0.0577, 0.9846];

// ── Pose library ────────────────────────────────────────────────────────────
interface PoseDef { name: string; over: Record<string, Q>; region?: AnimRegion; adaptive?: { metric: 'girth'; samples: AdaptivePoseSample[] }; }

const POSES: PoseDef[] = [
    // Recallable reference stances (cheap + reliable).
    { name: 'Relaxed', region: 'center', over: {} },                            // arms hang (the RELAXED base)
    { name: 'A-pose',  region: 'center', over: { shoulder_L: qz(-50), shoulder_R: qz(50), lowerarm_L: IDENT, lowerarm_R: IDENT } },
    // Personality poses (arm numbers are first-guesses — tune in-app).
    { name: 'Wave',    region: 'right', over: { shoulder_R: qz(-92), lowerarm_R: qz(-25) } },        // right arm up (≈vertical, not over the head) + slight forearm tilt
    { name: 'Cheer',   region: 'top', over: { shoulder_L: qz(74), lowerarm_L: qy(-10), shoulder_R: qz(-74), lowerarm_R: qy(10) } }, // both arms up + OUT in a wide V (NOT past vertical, or they cross)
    { name: 'Thinking', region: 'right', over: { shoulder_R: qc(qx(-30), qz(42)), lowerarm_R: qy(125), neck: qy(-3), head: qc(qy(-6), qx(4)) } }, // hand to chin + head tilt
    // Right hand resting on the back of the head, elbow out (casual / sheepish); left arm inherits Relaxed.
    // Captured via exportPoseData3D — NEUTRAL wrist (the 'up'/'down' wrist variants differ only in hand_R).
    { name: 'Hand Behind Head', region: 'right', over: { shoulder_R: SH_BEHIND, lowerarm_R: EL_BEHIND, hand_R: HAND_BEHIND } },
    // Hands on hips (BOTH) — captured from a real pose via exportPoseData3D (left arm), then mirrored to the
    // right across the body's symmetry plane ([x,y,z,w] → [x,-y,-z,w]). Includes the wrists so the hands sit
    // on the hips naturally. Torso/head left at rest for a clean, composable pose.
    { name: 'Hands on Hips', region: 'center',
        // `over` is the fallback (thin-body capture); `adaptive` BLENDS real captured poses by body girth
        // (torsoThick+hipWidth) so the hands fit thin AND fat bodies. As girth ↑: shoulder abducts LESS,
        // elbow bends MORE (the wider torso brings the elbow in). Endpoints are exact user captures.
        over: {
            shoulder_L: [-0.0495, 0.1215, -0.3609, 0.9233], lowerarm_L: [-0.0521, -0.0466, -0.6872, 0.7231], hand_L: [0.1806, -0.0347, 0.3185, 0.9299],
            shoulder_R: [-0.0495, -0.1215, 0.3609, 0.9233], lowerarm_R: [-0.0521, 0.0466, 0.6872, 0.7231], hand_R: [0.1806, 0.0347, -0.3185, 0.9299],
        },
        adaptive: { metric: 'girth', samples: [
            // thin body (torsoThick 0.7 + hipWidth 1.0 = 1.7)
            { at: 1.7, left: { shoulder_L: [-0.0495, 0.1215, -0.3609, 0.9233], lowerarm_L: [-0.0521, -0.0466, -0.6872, 0.7231], hand_L: [0.1806, -0.0347, 0.3185, 0.9299] } },
            // fat body (torsoThick 1.35 + hipWidth 1.15 = 2.5)
            { at: 2.5, left: { shoulder_L: [0.0, 0.0, -0.1296, 0.9916], lowerarm_L: [0.0, 0.0, -0.8046, 0.5938], hand_L: [0.0, 0.0, 0.3288, 0.9444] } },
        ] },
    },
];

// ── Idle / personality clips ─────────────────────────────────────────────────
interface ClipChan { joint: string; keys: { f: number; q: Q }[]; }
interface ClipDef { name: string; fps: number; end: number; loop: boolean; region?: AnimRegion; channels: ClipChan[]; }

const CLIPS: ClipDef[] = [
    // BREATHE — torso-only so it composes on ANY arm pose. Chest rises, body eases back, head stays level.
    {
        name: 'Breathe', region: 'center', fps: 24, end: 96, loop: true, channels: [
            { joint: 'chest', keys: [{ f: 0, q: IDENT }, { f: 40, q: qx(4) }, { f: 56, q: qx(4) }, { f: 96, q: IDENT }] },
            { joint: 'spine', keys: [{ f: 0, q: IDENT }, { f: 40, q: qx(2) }, { f: 56, q: qx(2) }, { f: 96, q: IDENT }] },
            { joint: 'neck',  keys: [{ f: 0, q: IDENT }, { f: 40, q: qx(-2) }, { f: 56, q: qx(-2) }, { f: 96, q: IDENT }] },
        ],
    },
    // SHIFT WEIGHT — slow L↔R upper-body sway. Drives the lumbar/spine/chest ONLY (all ABOVE the leg roots,
    // since legs hang off the root 'hips'), so the FEET STAY PLANTED — the character sways while standing.
    // Rotating the root 'hips' would carry the legs + feet sideways, which is wrong for a standing idle.
    {
        name: 'Shift Weight', region: 'center', fps: 24, end: 160, loop: true, channels: [
            { joint: 'lowerback', keys: [{ f: 0, q: IDENT }, { f: 40, q: qz(-3) }, { f: 80, q: IDENT }, { f: 120, q: qz(3) }, { f: 160, q: IDENT }] },
            { joint: 'spine', keys: [{ f: 0, q: IDENT }, { f: 40, q: qz(-1.6) }, { f: 80, q: IDENT }, { f: 120, q: qz(1.6) }, { f: 160, q: IDENT }] },
            { joint: 'chest', keys: [{ f: 0, q: IDENT }, { f: 40, q: qz(-1) }, { f: 80, q: IDENT }, { f: 120, q: qz(1) }, { f: 160, q: IDENT }] },
            { joint: 'head',  keys: [{ f: 0, q: IDENT }, { f: 40, q: qz(4) }, { f: 80, q: IDENT }, { f: 120, q: qz(-4) }, { f: 160, q: IDENT }] },
        ],
    },
    // LOOK AROUND — neck + head turn left, hold, centre, right, hold, centre. Reads as "taking in the room".
    {
        name: 'Look Around', region: 'top', fps: 24, end: 220, loop: true, channels: [
            { joint: 'neck', keys: [{ f: 0, q: IDENT }, { f: 45, q: qy(12) }, { f: 70, q: qy(12) }, { f: 95, q: IDENT }, { f: 140, q: qy(-12) }, { f: 165, q: qy(-12) }, { f: 190, q: IDENT }, { f: 220, q: IDENT }] },
            { joint: 'head', keys: [{ f: 0, q: IDENT }, { f: 45, q: qc(qy(18), qx(-3)) }, { f: 70, q: qc(qy(18), qx(-3)) }, { f: 95, q: IDENT }, { f: 140, q: qc(qy(-18), qx(2)) }, { f: 165, q: qc(qy(-18), qx(2)) }, { f: 190, q: IDENT }, { f: 220, q: IDENT }] },
        ],
    },
    // STRETCH — one-shot: both arms reach STRAIGHT up (≈±88, parallel). NOT past vertical (±90) or the arms
    // swing across the centreline and cross. Back arches, look up, hold, lower.
    {
        name: 'Stretch', region: 'top', fps: 24, end: 130, loop: false, channels: [
            { joint: 'shoulder_L', keys: [{ f: 0, q: REL_SH_L }, { f: 35, q: qz(88) }, { f: 75, q: qz(88) }, { f: 110, q: REL_SH_L }, { f: 130, q: REL_SH_L }] },
            { joint: 'shoulder_R', keys: [{ f: 0, q: REL_SH_R }, { f: 35, q: qz(-88) }, { f: 75, q: qz(-88) }, { f: 110, q: REL_SH_R }, { f: 130, q: REL_SH_R }] },
            { joint: 'lowerarm_L', keys: [{ f: 0, q: REL_EL_L }, { f: 35, q: qy(-6) }, { f: 75, q: qy(-6) }, { f: 110, q: REL_EL_L }, { f: 130, q: REL_EL_L }] },
            { joint: 'lowerarm_R', keys: [{ f: 0, q: REL_EL_R }, { f: 35, q: qy(6) }, { f: 75, q: qy(6) }, { f: 110, q: REL_EL_R }, { f: 130, q: REL_EL_R }] },
            { joint: 'chest', keys: [{ f: 0, q: IDENT }, { f: 35, q: qx(-6) }, { f: 75, q: qx(-6) }, { f: 110, q: IDENT }, { f: 130, q: IDENT }] },
            { joint: 'spine', keys: [{ f: 0, q: IDENT }, { f: 35, q: qx(-3) }, { f: 75, q: qx(-3) }, { f: 110, q: IDENT }, { f: 130, q: IDENT }] },
            { joint: 'head',  keys: [{ f: 0, q: IDENT }, { f: 35, q: qx(-8) }, { f: 75, q: qx(-8) }, { f: 110, q: IDENT }, { f: 130, q: IDENT }] },
        ],
    },
    // SCRATCH HEAD — one-shot, built on the CAPTURED "hand behind head" pose (SH/EL/HAND_BEHIND): raise the arm
    // to rest the hand on the back of the head, scratch (a small forearm + wrist oscillation composed on the
    // captured pose), then lower. Upper arm holds; only the forearm/wrist wiggle so it reads as a scratch.
    {
        name: 'Scratch Head', region: 'right', fps: 24, end: 120, loop: false, channels: [
            { joint: 'shoulder_R', keys: [{ f: 0, q: REL_SH_R }, { f: 28, q: SH_BEHIND }, { f: 90, q: SH_BEHIND }, { f: 110, q: REL_SH_R }, { f: 120, q: REL_SH_R }] },
            { joint: 'lowerarm_R', keys: [
                { f: 0, q: REL_EL_R }, { f: 28, q: EL_BEHIND },
                { f: 36, q: qc(EL_BEHIND, qz(10)) }, { f: 44, q: qc(EL_BEHIND, qz(-10)) }, { f: 52, q: qc(EL_BEHIND, qz(10)) },
                { f: 60, q: qc(EL_BEHIND, qz(-10)) }, { f: 68, q: qc(EL_BEHIND, qz(10)) }, { f: 76, q: qc(EL_BEHIND, qz(-10)) }, { f: 84, q: qc(EL_BEHIND, qz(7)) },
                { f: 90, q: EL_BEHIND }, { f: 110, q: REL_EL_R }, { f: 120, q: REL_EL_R },
            ] },
            { joint: 'hand_R', keys: [
                { f: 0, q: IDENT }, { f: 28, q: HAND_BEHIND },
                { f: 40, q: qc(HAND_BEHIND, qx(7)) }, { f: 56, q: qc(HAND_BEHIND, qx(-7)) }, { f: 72, q: qc(HAND_BEHIND, qx(7)) }, { f: 88, q: qc(HAND_BEHIND, qx(-5)) },
                { f: 90, q: HAND_BEHIND }, { f: 110, q: IDENT }, { f: 120, q: IDENT },
            ] },
            { joint: 'head', keys: [{ f: 0, q: IDENT }, { f: 28, q: qc(qx(3), qz(5)) }, { f: 90, q: qc(qx(3), qz(5)) }, { f: 110, q: IDENT }, { f: 120, q: IDENT }] },
        ],
    },
    // TALK GESTURE — loop: forearms raised in front, alternating hand motions + small head bobs (chatting).
    {
        name: 'Talk Gesture', region: 'center', fps: 24, end: 150, loop: true, channels: [
            { joint: 'shoulder_L', keys: [{ f: 0, q: qc(qx(-35), qz(-58)) }, { f: 150, q: qc(qx(-35), qz(-58)) }] },
            { joint: 'shoulder_R', keys: [{ f: 0, q: qc(qx(-35), qz(58)) }, { f: 150, q: qc(qx(-35), qz(58)) }] },
            { joint: 'lowerarm_L', keys: [{ f: 0, q: qy(-88) }, { f: 30, q: qy(-72) }, { f: 60, q: qy(-92) }, { f: 90, q: qy(-100) }, { f: 120, q: qy(-84) }, { f: 150, q: qy(-88) }] },
            { joint: 'lowerarm_R', keys: [{ f: 0, q: qy(88) }, { f: 30, q: qy(98) }, { f: 60, q: qy(82) }, { f: 90, q: qy(70) }, { f: 120, q: qy(94) }, { f: 150, q: qy(88) }] },
            { joint: 'head', keys: [{ f: 0, q: IDENT }, { f: 30, q: qc(qy(4), qx(-2)) }, { f: 60, q: IDENT }, { f: 90, q: qc(qy(-4), qx(-2)) }, { f: 120, q: IDENT }, { f: 150, q: IDENT }] },
            { joint: 'chest', keys: [{ f: 0, q: IDENT }, { f: 45, q: qx(2) }, { f: 100, q: qx(-1) }, { f: 150, q: IDENT }] },
        ],
    },
];

// ── Builders (resolve joint names → indices for a given skeleton) ─────────────

/** Build the default Pose-Library snapshots for a skeleton. Each pose covers ALL joints (identity by
 *  default, the RELAXED arm stance, then the pose's overrides) so recalling it gives a clean stance. */
export function buildDefaultPoses(joints: { name: string }[]): SkeletonPose[] {
    return POSES.map(def => ({
        id: crypto.randomUUID(),
        name: def.name,
        rotations: joints.map((j, i) => ({
            jointIndex: i,
            rotation: (def.over[j.name] ?? RELAXED[j.name] ?? IDENT).slice() as Q,
        })),
        ...(def.region ? { region: def.region } : {}),
        ...(def.adaptive ? { adaptive: { metric: def.adaptive.metric, samples: def.adaptive.samples.map(s => ({ at: s.at, left: { ...s.left } })) } } : {}),
    }));
}

/** Build the default animation clips for a skeleton. Joints the rig lacks are skipped; a clip with no
 *  resolvable channel is dropped (non-humanoid rig). `loop` is encoded by equal first/last keyframes. */
export function buildDefaultClips(joints: { name: string }[]): SkeletonAnimClip[] {
    const idx = new Map(joints.map((j, i) => [j.name, i]));
    const out: SkeletonAnimClip[] = [];
    for (const def of CLIPS) {
        const tracks: SkeletonKeyframeTrack[] = [];
        for (const ch of def.channels) {
            const ji = idx.get(ch.joint);
            if (ji === undefined) continue;
            tracks.push({
                jointIndex: ji,
                channel: 'rotation',
                keyframes: ch.keys.map(k => ({ frame: k.f, value: k.q.slice() })),
            });
        }
        if (tracks.length === 0) continue;
        out.push({ id: crypto.randomUUID(), name: def.name, startFrame: 0, endFrame: def.end, fps: def.fps, tracks, ...(def.region ? { region: def.region } : {}) });
    }
    return out;
}

/** The names we install, so callers can detect/avoid duplicates. */
export const DEFAULT_POSE_NAMES = POSES.map(p => p.name);
export const DEFAULT_CLIP_NAMES = CLIPS.map(c => c.name);
/** The built-in ONE-SHOT clips eligible to fire as random idle breaks (the loops are the base idle, not breaks). */
export const DEFAULT_BREAK_CLIP_NAMES = CLIPS.filter(c => !c.loop).map(c => c.name);
