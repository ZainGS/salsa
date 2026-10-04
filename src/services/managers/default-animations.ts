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
 * Arm poses are authored in human terms via pose-authoring.ts (raise / forward / twist / elbow / wrist, left arm
 *   mirrored to the right) and checked with the pose preview report (pose-preview.test.ts renders every pose + clip
 *   keyframe and counts limb verts inside the body/head). The old hand-typed quats clipped or were plainly wrong
 *   (pose & animation audit 2026-09-28).
 */

import type { SkeletonPose, SkeletonAnimClip, SkeletonKeyframeTrack, AdaptivePoseSample, AnimRegion, ClipFaceEvent } from '../../types/armature-3d';
import { armPose, claviclesPose, relaxedStance, waveBody, weightShift, WEIGHT_JOINTS, WAVE_ARM, type ArmSpec } from './pose-authoring';
import { bake, lag, type Ease, type MoveKey } from './anim-authoring';

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

// The natural stance every pose/arm-clip starts from — pose-authoring.relaxedStance (== BODY_POSES 'Relaxed'):
// arms ~20° out, soft asymmetric elbows, forearms turned in, relaxed wrists, dropped shoulders.
const RELAXED: Record<string, Q> = relaxedStance();
const REL_SH_L = RELAXED.shoulder_L, REL_SH_R = RELAXED.shoulder_R;
const REL_EL_L = RELAXED.lowerarm_L, REL_EL_R = RELAXED.lowerarm_R;
const REL_HD_R = RELAXED.hand_R;
/** Shoulders level (no relaxed drop) — for captured poses, where a dropped clavicle would move the capture. */
const CLAV_LEVEL: Record<string, Q> = { clavicle_L: IDENT, clavicle_R: IDENT };
/** Shoulders lifted a little — a raised arm lifts the shoulder girdle. Only on ONE-arm poses: on both-arms-up poses
 *  (Cheer, Stretch) the lift drove the upper arms into the sides of the head (measured), so those keep level. */
const CLAV_UP = claviclesPose(-8);

// Authored arms (pose-authoring). Each checked with the pose preview report: rendered + 0 verts into the body/head.
/** Right hand resting on the back of the head, elbow up and out. (The old captured quats put the hand ~3 cm INSIDE
 *  the back of the skull — 277 verts.) */
const BEHIND = armPose({ raise: 145, fwd: -5, twist: -140, elbow: 125, wrist: 10 }, 'R');
const SH_BEHIND = BEHIND.shoulder_R, EL_BEHIND = BEHIND.lowerarm_R, HAND_BEHIND = BEHIND.hand_R;
/** Thinking: right hand at the chin, left forearm folded across the waist under it. */
const THINK_R: ArmSpec = { raise: 15, fwd: 60, twist: 5, elbow: 145, wrist: 35 };
const THINK_L: ArmSpec = { raise: 16, fwd: 30, twist: 60, elbow: 95, wrist: 10 };
/** Wave: the rest of the body (pose-authoring.waveBody) — head toward the hand, chest turned + leaning away. */
const WAVE_BODY = waveBody();
const WAVE_HEAD = WAVE_BODY.head, WAVE_CHEST = WAVE_BODY.chest;

// ── Pose library ────────────────────────────────────────────────────────────
interface PoseDef { name: string; over: Record<string, Q>; region?: AnimRegion; adaptive?: { metric: 'girth'; samples: AdaptivePoseSample[] }; }

const POSES: PoseDef[] = [
    // Recallable reference stances (cheap + reliable).
    { name: 'Relaxed', region: 'center', over: {} },                            // the RELAXED base
    { name: 'A-pose',  region: 'center', over: { shoulder_L: qz(-50), shoulder_R: qz(50), lowerarm_L: IDENT, lowerarm_R: IDENT, hand_L: IDENT, hand_R: IDENT, ...CLAV_LEVEL } },
    // Right hand up in a wave: upper arm out, forearm UP, palm out (was: the whole arm past vertical, through the head).
    { name: 'Wave',    region: 'right', over: { ...WAVE_BODY, ...armPose(WAVE_ARM, 'R') } },
    { name: 'Cheer',   region: 'top', over: { shoulder_L: qz(70), lowerarm_L: qy(-10), shoulder_R: qz(-70), lowerarm_R: qy(10), hand_L: IDENT, hand_R: IDENT, ...CLAV_LEVEL } }, // both arms up + OUT in a wide V (NOT past vertical, or they cross)
    // Hand to chin, other forearm folded under the elbow; the head turns aside and tips UP a little (pondering), the
    // chest turns back against it and the weight shifts — the body line is what sells "hmm".
    { name: 'Thinking', region: 'center', over: { ...armPose(THINK_R, 'R'), ...armPose(THINK_L, 'L'), ...CLAV_LEVEL, neck: qx(2), head: qc(qy(14), qx(-6), qz(-8)), chest: qc(qy(-5), qx(3)), ...weightShift('R', 3) } },
    // Right hand resting on the back of the head, elbow out (casual / sheepish); left arm inherits Relaxed.
    { name: 'Hand Behind Head', region: 'right', over: { shoulder_R: SH_BEHIND, lowerarm_R: EL_BEHIND, hand_R: HAND_BEHIND, clavicle_R: CLAV_UP.clavicle_R } },
    // Hands on hips (BOTH) — captured from a real pose via exportPoseData3D (left arm), then mirrored to the
    // right across the body's symmetry plane ([x,y,z,w] → [x,-y,-z,w]). Includes the wrists so the hands sit
    // on the hips naturally. Torso/head left at rest; clavicles level (the captures were made with level shoulders).
    { name: 'Hands on Hips', region: 'center',
        // `over` is the fallback (thin-body capture); `adaptive` BLENDS real captured poses by body girth
        // (torsoThick+hipWidth) so the hands fit thin AND fat bodies. As girth ↑: shoulder abducts LESS,
        // elbow bends MORE (the wider torso brings the elbow in). Endpoints are exact user captures.
        over: {
            shoulder_L: [-0.0495, 0.1215, -0.3609, 0.9233], lowerarm_L: [-0.0521, -0.0466, -0.6872, 0.7231], hand_L: [0.1806, -0.0347, 0.3185, 0.9299],
            shoulder_R: [-0.0495, -0.1215, 0.3609, 0.9233], lowerarm_R: [-0.0521, 0.0466, 0.6872, 0.7231], hand_R: [0.1806, 0.0347, -0.3185, 0.9299],
            ...CLAV_LEVEL,
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
// Authored as eased KEY POSES (anim-authoring.ts) and baked to dense keyframes: slow-in/slow-out, overshoot-and-settle
// ('outBack'), anticipation, and follow-through (forearm / hand / head trailing by a few frames via `lag`). The old
// clips were linear key-to-key — constant speed + dead stops — which is most of why they read stiff.
interface ClipChan { joint: string; keys: { f: number; q: Q }[]; }
interface ClipDef { name: string; fps: number; end: number; loop: boolean; region?: AnimRegion; channels: ClipChan[]; /** eligible as a random idle break (default: one-shots) */ breakable?: boolean; /** eye gaze jumps / blinks (→ SkeletonAnimClip.faceTrack; `f` = frame) */ face?: (Omit<ClipFaceEvent, 'frame'> & { f: number })[]; }

/**
 * Screen-direction sign that makes the EYES look toward the character's own LEFT (+X). The eye decal's gaze is in
 * screen space (+x = screen-right); for a character facing the viewer its left is screen-right, so +1. NOTE: checked
 * only on paper (the decal can't be rendered in the Node preview) - if the eyes look AWAY from where the head turns in
 * the browser, flip this one constant.
 */
const GAZE_TO_LEFT = 1;

/** WEIGHT-SHIFT channels (pose-authoring.weightShift) from a list of (frame, onto-leg | null = centred, tilt). */
function shiftChannels(end: number, keys: { f: number; onto: 'L' | 'R' | null; deg?: number; ease?: Ease }[]): ClipChan[] {
    return WEIGHT_JOINTS.map((joint) => ch(joint, end, keys.map((k) => ({
        f: k.f, ease: k.ease,
        q: (k.onto ? weightShift(k.onto, k.deg ?? 4)[joint] : undefined) ?? IDENT,
    }))));
}

/** A baked channel from eased key poses. */
const ch = (joint: string, end: number, keys: MoveKey[]): ClipChan => ({ joint, keys: bake(keys, end) });
/** LEFT-arm spec → shoulder/elbow/hand quats for `side` (pose-authoring, mirrored for the right). */
const arm = (spec: ArmSpec, side: 'L' | 'R') => { const a = armPose(spec, side); return { sh: a[`shoulder_${side}`], el: a[`lowerarm_${side}`], hd: a[`hand_${side}`] }; };
/** Both-arm channels from a list of (frame, spec, ease) arm key poses — the shoulder leads, the elbow trails `elLag`
 *  frames and the hand `hdLag` frames (follow-through). `rest` = the relaxed arm for `side` (first/last key). */
function armChannels(side: 'L' | 'R', end: number, poses: { f: number; spec: ArmSpec | 'rest'; ease?: Ease }[], elLag = 2, hdLag = 4): ClipChan[] {
    const rest = { sh: RELAXED[`shoulder_${side}`], el: RELAXED[`lowerarm_${side}`], hd: RELAXED[`hand_${side}`] };
    const at = (p: typeof poses[number]) => (p.spec === 'rest' ? rest : arm(p.spec, side));
    const k = (pick: 'sh' | 'el' | 'hd'): MoveKey[] => poses.map((p) => ({ f: p.f, q: at(p)[pick], ease: p.ease }));
    return [
        ch(`shoulder_${side}`, end, k('sh')),
        ch(`lowerarm_${side}`, end, lag(k('el'), elLag)),
        ch(`hand_${side}`, end, lag(k('hd'), hdLag)),
    ];
}
/** An elbow/wrist OSCILLATION around a held quat (waving, scratching): alternating ±`a`/`b` degrees about the local
 *  `axis`, every `period` frames from f0 to f1 (eased), composed onto `held`. */
function wiggle(held: Q, axis: (d: number) => Q, a: number, b: number, f0: number, f1: number, period: number): MoveKey[] {
    const out: MoveKey[] = [];
    let i = 0;
    for (let f = f0 + period; f < f1; f += period, i++) out.push({ f, q: qc(held, axis(i % 2 ? b : a)), ease: 'inOut' });
    out.push({ f: f1, q: held, ease: 'inOut' });
    return out;
}

/** Scratch Head's in-between: arm out to the side, forearm up — the route to/from behind the head that clears it. */
const SCRATCH_VIA = arm({ raise: 110, fwd: 20, twist: -90, elbow: 90, wrist: 0 }, 'R');
/** Right-arm WAVE (the pose + the clip): upper arm out and up, forearm up, palm out. */
const WAVE_R = arm(WAVE_ARM, 'R');

const CLIPS: ClipDef[] = [
    // BREATHE — torso-only so it composes on ANY arm pose. A quicker inhale, a small top-of-breath pause, a longer
    // exhale (real breathing isn't a sine); the shoulders lift a beat after the chest.
    {
        name: 'Breathe', region: 'center', fps: 24, end: 96, loop: true, channels: [
            ch('chest', 96, [{ f: 0, q: IDENT }, { f: 34, q: qx(3.5) }, { f: 44, q: qx(3.9) }, { f: 96, q: IDENT }]),
            ch('spine', 96, [{ f: 0, q: IDENT }, { f: 34, q: qx(1.5) }, { f: 44, q: qx(1.7) }, { f: 96, q: IDENT }]),
            ch('neck',  96, [{ f: 0, q: IDENT }, { f: 36, q: qx(-1.6) }, { f: 46, q: qx(-1.8) }, { f: 96, q: IDENT }]),
            ch('clavicle_L', 96, lag([{ f: 0, q: RELAXED.clavicle_L }, { f: 34, q: qc(RELAXED.clavicle_L, qz(1.6)) }, { f: 44, q: qc(RELAXED.clavicle_L, qz(1.8)) }, { f: 96, q: RELAXED.clavicle_L }], 3)),
            ch('clavicle_R', 96, lag([{ f: 0, q: RELAXED.clavicle_R }, { f: 34, q: qc(RELAXED.clavicle_R, qz(-1.6)) }, { f: 44, q: qc(RELAXED.clavicle_R, qz(-1.8)) }, { f: 96, q: RELAXED.clavicle_R }], 3)),
        ],
    },
    // SHIFT WEIGHT - a real L/R weight shift: the pelvis tips onto one leg (feet planted - the thighs counter-rotate),
    // the free knee softens, the torso stays upright; each shift lands with a small settle, the chest + head follow late.
    {
        name: 'Shift Weight', region: 'center', fps: 24, end: 160, loop: true, channels: [
            ...shiftChannels(160, [{ f: 0, onto: null }, { f: 36, onto: 'L', deg: 3.5, ease: 'outBack' }, { f: 80, onto: null }, { f: 116, onto: 'R', deg: 3.5, ease: 'outBack' }, { f: 160, onto: null }]),
            ch('chest', 160, lag([{ f: 0, q: IDENT }, { f: 36, q: qc(qz(-0.8), qy(1.5)) }, { f: 80, q: IDENT }, { f: 116, q: qc(qz(0.8), qy(-1.5)) }, { f: 160, q: IDENT }], 5)),
            ch('head',  160, lag([{ f: 0, q: IDENT }, { f: 36, q: qz(2.5) }, { f: 80, q: IDENT }, { f: 116, q: qz(-2.5) }, { f: 160, q: IDENT }], 8)),
        ],
        face: [{ f: 30, blink: true }, { f: 112, blink: true }],
    },
    // LOOK AROUND — a quick GLANCE (the head snaps over and settles past the target), a short look with a little
    // drift, back to centre, then the other side. The neck turns less than the head and the chest follows late.
    // Was a slow 9 s pan; now 6 s with real glances.
    {
        name: 'Look Around', region: 'top', fps: 24, end: 144, loop: true, channels: [
            ch('head', 144, [
                { f: 0, q: IDENT }, { f: 10, q: qc(qy(22), qx(-2)), ease: 'outBack' }, { f: 30, q: qc(qy(20), qx(1), qz(2)) }, { f: 44, q: qc(qy(21), qx(0), qz(1)) },
                { f: 56, q: IDENT }, { f: 70, q: IDENT }, { f: 80, q: qc(qy(-24), qx(3)), ease: 'outBack' }, { f: 100, q: qc(qy(-21), qx(4), qz(-2)) },
                { f: 114, q: qc(qy(-22), qx(3), qz(-1)) }, { f: 128, q: IDENT }, { f: 144, q: IDENT },
            ]),
            ch('neck', 144, lag([
                { f: 0, q: IDENT }, { f: 10, q: qy(9), ease: 'outBack' }, { f: 44, q: qy(9) }, { f: 56, q: IDENT }, { f: 70, q: IDENT },
                { f: 80, q: qy(-10), ease: 'outBack' }, { f: 114, q: qy(-10) }, { f: 128, q: IDENT }, { f: 144, q: IDENT },
            ], 2)),
            ch('chest', 144, lag([
                { f: 0, q: IDENT }, { f: 14, q: qy(3) }, { f: 44, q: qy(3) }, { f: 60, q: IDENT }, { f: 72, q: IDENT },
                { f: 86, q: qy(-3) }, { f: 114, q: qy(-3) }, { f: 132, q: IDENT }, { f: 144, q: IDENT },
            ], 4)),
        ],
        // The EYES lead: they jump to the new target a few frames BEFORE the head arrives (the head turns to follow
        // the eyes), and a blink rides the big return turns.
        face: [
            { f: 2, gaze: [0.55 * GAZE_TO_LEFT, 0.05] }, { f: 14, gaze: [0.3 * GAZE_TO_LEFT, 0.1] }, { f: 50, blink: true }, { f: 52, gaze: [0, 0] },
            { f: 74, gaze: [-0.55 * GAZE_TO_LEFT, 0.15] }, { f: 86, gaze: [-0.3 * GAZE_TO_LEFT, 0.15] }, { f: 122, blink: true }, { f: 124, restore: true },
        ],
    },
    // STRETCH — one-shot. ANTICIPATION (a small hunch, arms pull in) → the arms sweep up IN FRONT (not sideways through
    // a T) → reach overhead and OVERSHOOT, reach a little further, ease off → float down out to the sides with soft
    // elbows → settle. Elbows/hands trail the shoulders; the head leads the look up.
    {
        name: 'Stretch', region: 'top', fps: 24, end: 132, loop: false, channels: [
            ...(['L', 'R'] as const).flatMap((s) => armChannels(s, 132, [
                { f: 0, spec: 'rest' },
                { f: 10, spec: { raise: 21, fwd: 8, twist: 10, elbow: 26, wrist: 12 } },   // wind-up: elbows gather, arms don't tuck IN (that hit the hips)
                { f: 26, spec: { raise: 25, fwd: 90, twist: 10, elbow: 45, wrist: -5 } },
                { f: 40, spec: { raise: 152, fwd: 12, elbow: 8, wrist: -25 }, ease: 'outBack' },
                { f: 64, spec: { raise: 156, fwd: 10, elbow: 3, wrist: -32 } },
                { f: 76, spec: { raise: 153, fwd: 11, elbow: 6, wrist: -20 } },
                { f: 98, spec: { raise: 55, fwd: 22, twist: 20, elbow: 38, wrist: 10 } },
                { f: 116, spec: 'rest', ease: 'outBack' },
                { f: 132, spec: 'rest' },
            ], 2, 4)),
            ...(['L', 'R'] as const).map((s) => ch(`clavicle_${s}`, 132, [
                { f: 0, q: RELAXED[`clavicle_${s}`] }, { f: 40, q: IDENT }, { f: 76, q: IDENT }, { f: 116, q: RELAXED[`clavicle_${s}`] }, { f: 132, q: RELAXED[`clavicle_${s}`] },
            ])),
            ch('chest', 132, [{ f: 0, q: IDENT }, { f: 10, q: qx(3) }, { f: 40, q: qx(-7), ease: 'outBack' }, { f: 64, q: qx(-9) }, { f: 76, q: qx(-7) }, { f: 100, q: qx(1) }, { f: 116, q: IDENT, ease: 'outBack' }, { f: 132, q: IDENT }]),
            ch('spine', 132, [{ f: 0, q: IDENT }, { f: 10, q: qx(2) }, { f: 40, q: qx(-4), ease: 'outBack' }, { f: 64, q: qx(-5) }, { f: 76, q: qx(-4) }, { f: 100, q: qx(0.5) }, { f: 116, q: IDENT }, { f: 132, q: IDENT }]),
            ch('head', 132, [{ f: 0, q: IDENT }, { f: 10, q: qx(5) }, { f: 36, q: qx(-12), ease: 'outBack' }, { f: 64, q: qc(qx(-14), qz(4)) }, { f: 76, q: qc(qx(-11), qz(2)) }, { f: 100, q: qx(2) }, { f: 116, q: IDENT, ease: 'outBack' }, { f: 132, q: IDENT }]),
        ],
        face: [{ f: 8, blink: true }, { f: 28, gaze: [0, -0.45], expression: 'open', weight: 0.6 }, { f: 78, gaze: [0, -0.2], expression: 'smile', weight: 0.5 }, { f: 98, blink: true }, { f: 100, restore: true }],
    },
    // SCRATCH HEAD — one-shot: the hand snaps up to the back of the head (overshoot + settle), a quick scratch (elbow +
    // wrist wiggle, the wrist a couple of frames behind), the head tips down and away a touch, then the arm drops back.
    {
        name: 'Scratch Head', region: 'right', fps: 24, end: 120, loop: false, channels: [
            // The arm goes up OUT TO THE SIDE first (forearm up) and comes back down the same way — a straight blend
            // between hanging and hand-behind-head swings the hand THROUGH the head (measured). On the way down the ELBOW leads
            // (the hand lifts off the head first), then the shoulder lowers.
            ch('shoulder_R', 120, [{ f: 0, q: REL_SH_R }, { f: 10, q: SCRATCH_VIA.sh }, { f: 20, q: SH_BEHIND, ease: 'outBack' }, { f: 86, q: SH_BEHIND }, { f: 92, q: SH_BEHIND }, { f: 100, q: SCRATCH_VIA.sh }, { f: 111, q: REL_SH_R }, { f: 120, q: REL_SH_R }]),
            ch('lowerarm_R', 120, [{ f: 0, q: REL_EL_R }, { f: 12, q: SCRATCH_VIA.el }, { f: 23, q: EL_BEHIND, ease: 'outBack' }, ...wiggle(EL_BEHIND, qy, 4, -8, 23, 86, 6), { f: 92, q: SCRATCH_VIA.el }, { f: 101, q: SCRATCH_VIA.el }, { f: 113, q: REL_EL_R }, { f: 120, q: REL_EL_R }]),
            ch('hand_R', 120, [{ f: 0, q: REL_HD_R }, { f: 14, q: SCRATCH_VIA.hd }, { f: 25, q: HAND_BEHIND, ease: 'outBack' }, ...wiggle(HAND_BEHIND, qz, 12, -10, 25, 86, 6), { f: 93, q: SCRATCH_VIA.hd }, { f: 103, q: SCRATCH_VIA.hd }, { f: 115, q: REL_HD_R }, { f: 120, q: REL_HD_R }]),
            ch('clavicle_R', 120, [{ f: 0, q: RELAXED.clavicle_R }, { f: 20, q: CLAV_UP.clavicle_R }, { f: 86, q: CLAV_UP.clavicle_R }, { f: 104, q: RELAXED.clavicle_R }, { f: 120, q: RELAXED.clavicle_R }]),
            ch('head', 120, [{ f: 0, q: IDENT }, { f: 24, q: qc(qx(5), qz(3)) }, { f: 55, q: qc(qx(6), qz(4)) }, { f: 86, q: qc(qx(5), qz(3)) }, { f: 106, q: IDENT }, { f: 120, q: IDENT }]),   // tips down + AWAY from the hand
            ...shiftChannels(120, [{ f: 0, onto: null }, { f: 24, onto: 'L', deg: 3.5, ease: 'outBack' }, { f: 86, onto: 'L', deg: 3 }, { f: 110, onto: null }, { f: 120, onto: null }]),
        ],
        face: [{ f: 18, gaze: [0.35 * GAZE_TO_LEFT, 0.35], expression: 'frown', weight: 0.35 }, { f: 54, blink: true }, { f: 70, gaze: [0.2 * GAZE_TO_LEFT, 0.25] }, { f: 100, blink: true }, { f: 102, restore: true }],
    },
    // WAVE — one-shot (not an idle break — nobody waves at no one): the arm swings up (overshoot), the forearm waves
    // side to side from the elbow with the hand flicking a beat behind, the head tilts toward the wave and the chest
    // leans away a touch, then the arm drops and settles.
    {
        name: 'Wave', region: 'right', fps: 24, end: 104, loop: false, breakable: false, channels: [
            ch('shoulder_R', 104, [{ f: 0, q: REL_SH_R }, { f: 14, q: WAVE_R.sh, ease: 'outBack' }, { f: 72, q: WAVE_R.sh }, { f: 92, q: REL_SH_R, ease: 'outBack' }, { f: 104, q: REL_SH_R }]),
            ch('lowerarm_R', 104, [{ f: 0, q: REL_EL_R }, { f: 17, q: WAVE_R.el, ease: 'outBack' }, ...wiggle(WAVE_R.el, qy, 18, -14, 17, 72, 8), { f: 94, q: REL_EL_R }, { f: 104, q: REL_EL_R }]),
            ch('hand_R', 104, [{ f: 0, q: REL_HD_R }, { f: 19, q: WAVE_R.hd, ease: 'outBack' }, ...wiggle(WAVE_R.hd, qz, -12, 12, 21, 74, 8), { f: 96, q: REL_HD_R }, { f: 104, q: REL_HD_R }]),
            ch('clavicle_R', 104, [{ f: 0, q: RELAXED.clavicle_R }, { f: 14, q: WAVE_BODY.clavicle_R }, { f: 72, q: WAVE_BODY.clavicle_R }, { f: 92, q: RELAXED.clavicle_R }, { f: 104, q: RELAXED.clavicle_R }]),
            ch('head', 104, lag([{ f: 0, q: IDENT }, { f: 14, q: WAVE_HEAD, ease: 'outBack' }, { f: 72, q: WAVE_HEAD }, { f: 92, q: IDENT }, { f: 104, q: IDENT }], 3)),
            ch('chest', 104, [{ f: 0, q: IDENT }, { f: 14, q: WAVE_CHEST }, { f: 72, q: WAVE_CHEST }, { f: 92, q: IDENT }, { f: 104, q: IDENT }]),
            ch('neck', 104, lag([{ f: 0, q: IDENT }, { f: 14, q: WAVE_BODY.neck }, { f: 72, q: WAVE_BODY.neck }, { f: 92, q: IDENT }, { f: 104, q: IDENT }], 2)),
            ...shiftChannels(104, [{ f: 0, onto: null }, { f: 16, onto: 'L', deg: 4, ease: 'outBack' }, { f: 72, onto: 'L', deg: 4 }, { f: 96, onto: null }, { f: 104, onto: null }]),
        ],
        face: [{ f: 3, blink: true, browRaise: 0.4 }, { f: 8, gaze: [-0.3 * GAZE_TO_LEFT, -0.1], expression: 'smile' }, { f: 88, blink: true }, { f: 92, restore: true }],
    },
    // TALK GESTURE — loop: forearms up in front making beats (each lands with a little overshoot), hands turning a
    // couple of frames behind the forearms, the head nodding just BEFORE each beat, the chest turning with the gestures.
    {
        name: 'Talk Gesture', region: 'center', fps: 24, end: 150, loop: true, channels: [
            ch('shoulder_L', 150, [{ f: 0, q: qc(qx(-35), qz(-58)) }, { f: 60, q: qc(qx(-38), qz(-54)) }, { f: 110, q: qc(qx(-33), qz(-60)) }, { f: 150, q: qc(qx(-35), qz(-58)) }]),
            ch('shoulder_R', 150, [{ f: 0, q: qc(qx(-35), qz(58)) }, { f: 70, q: qc(qx(-32), qz(55)) }, { f: 120, q: qc(qx(-37), qz(60)) }, { f: 150, q: qc(qx(-35), qz(58)) }]),
            ch('lowerarm_L', 150, [{ f: 0, q: qy(-88) }, { f: 18, q: qy(-70), ease: 'outBack' }, { f: 36, q: qy(-92) }, { f: 60, q: qy(-100), ease: 'outBack' }, { f: 84, q: qy(-80) }, { f: 108, q: qy(-95), ease: 'outBack' }, { f: 130, q: qy(-85) }, { f: 150, q: qy(-88) }]),
            ch('lowerarm_R', 150, [{ f: 0, q: qy(88) }, { f: 24, q: qy(98), ease: 'outBack' }, { f: 44, q: qy(80) }, { f: 66, q: qy(72), ease: 'outBack' }, { f: 92, q: qy(96) }, { f: 116, q: qy(84), ease: 'outBack' }, { f: 136, q: qy(92) }, { f: 150, q: qy(88) }]),
            ch('hand_L', 150, lag([{ f: 0, q: IDENT }, { f: 18, q: qc(qz(10), qy(8)), ease: 'outBack' }, { f: 40, q: qz(-6) }, { f: 60, q: qc(qz(12), qy(-6)), ease: 'outBack' }, { f: 86, q: qz(-4) }, { f: 108, q: qz(8), ease: 'outBack' }, { f: 150, q: IDENT }], 3)),
            ch('hand_R', 150, lag([{ f: 0, q: IDENT }, { f: 24, q: qc(qz(-10), qy(-8)), ease: 'outBack' }, { f: 46, q: qz(6) }, { f: 66, q: qc(qz(-12), qy(6)), ease: 'outBack' }, { f: 94, q: qz(4) }, { f: 116, q: qz(-8), ease: 'outBack' }, { f: 150, q: IDENT }], 3)),
            ch('head', 150, [{ f: 0, q: IDENT }, { f: 15, q: qc(qy(5), qx(-3)), ease: 'outBack' }, { f: 38, q: qx(2) }, { f: 56, q: qc(qy(-4), qx(-3)), ease: 'outBack' }, { f: 80, q: IDENT }, { f: 104, q: qc(qy(3), qx(2)) }, { f: 128, q: qx(-2) }, { f: 150, q: IDENT }]),
            ch('chest', 150, [{ f: 0, q: IDENT }, { f: 45, q: qc(qx(2), qy(3)) }, { f: 100, q: qc(qx(-1), qy(-3)) }, { f: 150, q: IDENT }]),
            ...shiftChannels(150, [{ f: 0, onto: null }, { f: 40, onto: 'L', deg: 2.5 }, { f: 110, onto: 'R', deg: 2.5 }, { f: 150, onto: null }]),
        ],
        face: [
            { f: 14, blink: true, browRaise: 0.35 }, { f: 18, expression: 'open', weight: 0.45 }, { f: 30, gaze: [0.15 * GAZE_TO_LEFT, 0], expression: 'smile', weight: 0.7 },
            { f: 60, gaze: [-0.1 * GAZE_TO_LEFT, 0.05], expression: 'open', weight: 0.4 }, { f: 84, expression: 'smile', weight: 0.6 }, { f: 104, blink: true },
            { f: 120, gaze: [0, 0] }, { f: 146, restore: true },
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
        out.push({ id: crypto.randomUUID(), name: def.name, startFrame: 0, endFrame: def.end, fps: def.fps, tracks, ...(def.region ? { region: def.region } : {}),
            ...(def.face ? { faceTrack: def.face.map(({ f, ...e }): ClipFaceEvent => ({ frame: f, ...e, ...(e.gaze ? { gaze: [e.gaze[0], e.gaze[1]] as [number, number] } : {}) })) } : {}) });
    }
    return out;
}

/** The names we install, so callers can detect/avoid duplicates. */
export const DEFAULT_POSE_NAMES = POSES.map(p => p.name);
export const DEFAULT_CLIP_NAMES = CLIPS.map(c => c.name);
/** The built-in ONE-SHOT clips (they start + end on the relaxed stance → re-based onto the character's real pose). */
export const DEFAULT_ONESHOT_CLIP_NAMES = CLIPS.filter(c => !c.loop).map(c => c.name);
/** The default stance rotation a joint's one-shot tracks start from (relaxed arm/clavicle, identity elsewhere). */
export const defaultRestRotation = (jointName: string): Q => RELAXED[jointName] ?? IDENT;
/** The built-in ONE-SHOT clips eligible to fire as random idle breaks (the loops are the base idle, not breaks). */
export const DEFAULT_BREAK_CLIP_NAMES = CLIPS.filter(c => !c.loop && c.breakable !== false).map(c => c.name);
