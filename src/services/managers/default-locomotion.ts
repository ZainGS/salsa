/**
 * Default LOCOMOTION clips for the procedural humanoid rig (body-generator JOINTS) — polish-round-3 T5.2, rebuilt in
 * Round 8 (docs/specs/polish-round-3.md §Round 8, docs/ui/play-mode.md §Engine locomotion).
 *
 * The default idle set (default-animations.ts) has no gait, so the Play-mode avatar needs one. These clips are
 * generated PROCEDURALLY and are runtime-only: installed on the auto default player (play-auto-player.ts) and given to a
 * user Player that has no gait of its own — never into a saved document.
 *
 * GAITS (Walk, Run, Sneak) come from a small biomechanical model instead of hand-keyed angles:
 *  - Each leg alternates STANCE (foot on the ground, `duty` of the cycle) and SWING. In stance the ankle is PLANTED in
 *    the world (the body moves over it at the clip's ground speed), rolling heel → flat → toe: a heel strike (toes up,
 *    rotating about the heel), foot flat, then heel-off (rotating about the ball, which raises the ankle). In swing
 *    the ankle travels to the next footprint along an eased arc (zero world velocity at both ends: no skating) with a
 *    lift (and, for the run, a heel kick: the foot trails behind before the knee drives through).
 *  - The PELVIS height is the highest the stance legs allow (each ≤ legK·L, minus a mid-stance knee flex), smoothed, so
 *    the bob comes out of the geometry — highest mid-stance and lowest in double support for the walk; compressed in
 *    stance and a ballistic rise in the FLIGHT phase for the run (duty < 0.5 = both feet off the ground twice a cycle).
 *  - Every leg is solved by 2-bone IK (knee toward the toes), so the planted ankle is exactly on its footprint and a knee
 *    can never hyper-extend (reach is clamped below full extension). The foot's world pitch is authored (heel strike,
 *    toe-off, toe clearance), and the pelvis twist / roll / sway never twist a planted foot.
 *  - Upper body: counter-swinging arms (a small lag behind the legs), chest counter-rotation, lean, the head stabilised
 *    against the torso's lean and twist.
 *  - NATURAL model (2026-10-03, the specs with `bob`: Walk, Run, Stroll; play-mode.md §Natural walk / run): the pelvis
 *    is a smooth wave twice a cycle (walk: highest at mid-stance; run: lowest at mid-stance, highest mid-flight) fitted
 *    UNDER every leg's reach — including the leg about to land, so the landing foot glides onto its heel instead of
 *    hanging short of the ground and dropping (the old walk's stomp). The swing leg follows keyed thigh / knee angles
 *    (knee fold for clearance, the run's heel kick and knee drive), velocity-matched to the stance at both ends, the
 *    foot following its shank; the heel-off accelerates into the push-off. The Round 8 walk is kept as the `Stomp`
 *    clip (selectable: sm.setPlayWalkStyle3D('stomp') or a locomotion set's walk: 'Stomp').
 *  - Each gait clip carries its GROUND SPEED (rig units / s at rate 1, `groundSpeed`), so the animator plays it at
 *    speed / groundSpeed — the feet stay planted at any movement speed and any avatar scale.
 * Non-cyclic clips: Crouch (sneak idle loop), Jump (the air pose, sampled by the controller's AIR PHASE: 0 take-off →
 * 0.5 apex → 1 falling fast), Fall (a long-fall loop) and Land (an ADDITIVE squash-and-recover played on touch-down).
 *
 * Conventions (default-animations.ts / pose-authoring.ts): joints are identity at rest; thigh/shoulder qx(−) = forward,
 * lowerleg qx(+) = knee bend, foot qx(−) = toes up; the character faces +Z and its left is +X.
 */

import type { SkeletonAnimClip, SkeletonKeyframeTrack } from '../../types/armature-3d';
import { armPose, mirrorQ, qAxis, qMul, RELAXED_ARM_L, RELAXED_ARM_R, relaxedStance, type ArmSpec, type Quat } from './pose-authoring';
import { seededRandom, seedFromString, type JumpVariantInfo } from '../../game/locomotion-animator';

type V3 = [number, number, number];

/** The procedural rig's hip-to-ankle leg length (0.42 + 0.42): every spec length is a fraction of the rig's own L, and
 *  speeds are authored for this L (a longer-legged rig strides further at the same cadence). */
const REF_LEG = 0.84;
const FPS = 30;

/** Gait shape. Lengths are fractions of the leg length L, angles in degrees, `speed` in m/s for L = 0.84. */
export interface GaitSpec {
    name: string;
    period: number;      // seconds per cycle (two steps)
    speed: number;       // ground speed the clip is authored for (rate 1)
    duty: number;        // stance fraction of the cycle per leg (> 0.5 walk = double support; < 0.5 run = flight)
    legK: number;        // max stance hip→ankle length (fraction of L) — < 1 keeps a soft knee, never locked
    stanceFlex: number;  // extra mid-stance shortening (knee flex under load)
    loadDip: number;     // item 13: extra pelvis dip just after each heel strike (the knee "takes the weight")
    crouch: number;      // pelvis ceiling below rest (fraction of L) — the sneak crouch
    flight: number;      // run: pelvis rise at mid-flight
    lift: number;        // swing ankle lift
    liftPeak: number;    // swing progress (0..1) where the lift peaks
    swingK: number;      // swing end-tangent scale (1 = no skid at lift-off / touch-down; < 1 = a faster forward whip)
    reach: number;       // stance centre offset forward (+) / back (−)
    width: number;       // extra half-width of the footprints (fraction of L; + = wider)
    heelStrike: number;  // toes-up angle at contact
    toeOff: number;      // toes-down (heel raised) angle at toe-off
    toeClear: number;    // extra toes-up mid-swing (clears the toes)
    sway: number;        // pelvis sideways shift over the stance foot
    roll: number;        // pelvis roll (the swing-side hip drops)
    twist: number;       // pelvis yaw (the forward leg's hip leads); the chest counter-rotates
    lean: number;        // torso forward lean (spread over lowerback / spine / chest)
    headDown: number;    // head pitch relative to level (+ = looking down); the head counters the lean
    arm: number;         // arm swing amplitude (± forward)
    armFwd: number;      // constant forward offset of the arms
    armOut: number;      // extra sideways raise (a bent running arm must clear the torso)
    armTwist: number | null; // upper-arm roll override (null = the relaxed stance's)
    elbow: number;       // base elbow flex
    elbowSwing: number;  // extra elbow flex when the arm is forward
    armLag: number;      // arms lag the legs by this fraction of a cycle
    // ── Gait feel (2026-10-03): the secondary motion that keeps a gait from reading stiff ──
    tilt: number;        // pelvis pitch (anterior tilt) twice a cycle, peaking as each leg takes the weight (deg)
    chestSway: number;   // the upper torso sways over the stance foot, a beat after the pelvis (deg, spine + chest)
    sideLag: number;     // that sway's lag behind the pelvis (fraction of a cycle)
    headLag: number;     // the head's stabilising counter (bob / roll / twist) lags the torso by this — slightly late
    forearmLag: number;  // OVERLAP: the elbow flex lags the upper-arm swing (the forearm trails, then whips through)
    handLag: number;     // the hand trails the forearm's swing (deg of wrist deviation at peak swing speed)
    protract: number;    // the shoulder (clavicle) rides forward / back with its arm (deg)
    // ── NATURAL gait model (2026-10-03; set `bob` to use it — absent = the Round 8 model, which the Stomp clip keeps) ──
    /** Pelvis bob half-amplitude (fraction of L) of a smooth wave twice a cycle, fitted UNDER every leg's reach (stance
     *  legs and the leg about to land), so no foot ever hangs short of the ground and drops onto it. + = HIGHEST at
     *  mid-stance, lowest in double support (a walk vaulting over the stance leg); − = LOWEST at mid-stance (the run's
     *  compression) and highest at mid-flight. */
    bob?: number;
    /** Shift of that wave (fraction of a cycle; − = earlier): the walk peaks a touch before mid-stance, so the pelvis
     *  rises sooner out of the loading response and the knee takes less of a dip. */
    bobPhase?: number;
    /** Swing-leg keys [u (0 = toe-off … 1 = touch-down), thigh pitch fwd (deg), knee flex (deg)], interpolated as ankle
     *  positions relative to the hip (velocity-matched to the stance at both ends) — the knee folds / drives as keyed. */
    swingKeys?: [number, number, number][];
    /** Extra swing-foot pitch relative to the shank at mid-swing (deg, + = toes pointed / − = dorsiflexed for clearance). */
    footSwing?: number;
    /** Vertical speed of the ankle at touch-down (m/s for L = 0.84; small = a soft heel contact). */
    landVel?: number;
    /** Stance fractions: foot flat by `heelEnd` (rolling down about the heel), heel rising from `heelOff` (about the ball). */
    heelEnd?: number;
    heelOff?: number;
    /** Whole-body forward lean (deg) from the pelvis: the legs stay planted (IK), the trunk leans with it. */
    bodyLean?: number;
    // ── ENERGETIC run model (2026-10-04, Jog / Run; play-mode.md §An energetic run + the jog) ──
    /** SPRING-MASS pelvis (set it to use it): the flight APEX rise (fraction of L) above the contact height — a ballistic
     *  arc between toe-off and touch-down — while `bob` (< 0) is the stance COMPRESSION depth (a half-sine dip, deepest
     *  at mid-stance: the knee takes the landing). Fitted under every leg's reach as before, so the push-off leg is at
     *  full reach at toe-off (the stretch) and the landing leg arrives on time. Absent = the cosine wave. */
    air?: number;
    /** Spring-mass pelvis: how much HIGHER it leaves the ground at toe-off than it lands (fraction of L) — the push-off
     *  rises out of the compression, so the stance leg straightens over the pointed foot (the stretch). */
    pushRise?: number;
    /** The upper arm rolls IN as it swings forward (deg at the front of the swing): the bent forearm crosses toward the
     *  midline in front of the chest instead of pumping straight fore-aft. */
    armCross?: number;
    /** Chest bounce (deg of spine pitch, twice a cycle, forward at mid-stance) for a gait with flight (default 1.5). */
    chestBounce?: number;
    /** Head NOD on impact (deg, + = down): a short dip just after each touch-down (a beat late, headLag), on top of the
     *  head's level-holding counter — the weight of the head landing. Absent = none. */
    headNod?: number;
}

// STOMP (2026-10-03): the Round 8 / item 13 walk, kept as its own clip for custom use (a heavy stomp through swamp
// water). The pelvis rides the stance legs' reach ceiling (a cusp at each heel strike), the leg about to land can't
// reach the ground until the pelvis drops onto it, and a knee DIP follows each heel strike — a heavy, flat-footed tread.
// Select it with sm.setPlayWalkStyle3D('stomp') or sm.setPlayerLocomotionSet3D({ walk: 'Stomp', … }).
const STOMP: GaitSpec = {
    name: 'Stomp', period: 0.93, speed: 1.6, duty: 0.58, legK: 0.995, stanceFlex: 0.01, loadDip: 0.022, crouch: 0.012, flight: 0,
    lift: 0.075, liftPeak: 0.35, swingK: 0.85, reach: -0.03, width: 0.0, heelStrike: 14, toeOff: 26, toeClear: 8,
    sway: 0.024, roll: 4.5, twist: 6.5, lean: 4, headDown: 2, arm: 30, armFwd: 2, armOut: 5, armTwist: null,
    elbow: 17, elbowSwing: 27, armLag: 0.05,
    tilt: 1.8, chestSway: 2.6, sideLag: 0.04, headLag: 0.035, forearmLag: 0.09, handLag: 12, protract: 5,
};
// Walk (natural, 2026-10-03): 1.6 m/s, ~136 steps/min. Heel strike with the toes up (20°), a roll down to foot-flat,
// a long push-off over the ball (toe-off 46°); the pelvis is a smooth wave, highest at mid-stance, fitted under the legs'
// reach so the landing foot glides down onto its heel (it used to hang 4 cm up and drop: the stomp). The swing knee
// folds to ~60° just after toe-off for clearance, then opens to land; the feet land a little apart.
const WALK: GaitSpec = {
    name: 'Walk', period: 0.86, speed: 1.6, duty: 0.6, legK: 0.998, stanceFlex: 0, loadDip: 0.004, crouch: 0.004, flight: 0,
    lift: 0, liftPeak: 0.35, swingK: 1, reach: -0.05, width: 0.045, heelStrike: 20, toeOff: 46, toeClear: 8,
    sway: 0.03, roll: 4, twist: 6.5, lean: 3, headDown: 2, arm: 28, armFwd: 2, armOut: 5, armTwist: null,
    elbow: 16, elbowSwing: 24, armLag: 0.05,
    tilt: 1.6, chestSway: 2.4, sideLag: 0.04, headLag: 0.035, forearmLag: 0.09, handLag: 11, protract: 5,
    bob: 0.024, bobPhase: -0.025, swingKeys: [[0.3, 12, 66], [0.62, 26, 46], [0.86, 29, 14]], footSwing: -20, landVel: 0.15, heelEnd: 0.18, heelOff: 0.5, bodyLean: 0,
};
// Run (natural, 2026-10-03): it used to read as a LUNGE (the foot landed ~35 cm ahead of the hip, the rear leg left
// straight and far behind, then folded late, under the body). Now: a shorter stride at a higher cadence, the foot
// landing nearer under the body (~24 cm ahead), a FLIGHT phase with the pelvis highest mid-flight and lowest at
// mid-stance (compression), the rear leg folding at once (heel kick toward the glutes) and the knee driving forward and
// up, the whole body leaning from the pelvis (the legs stay planted), arms bent ~90° pumping.
//
// ENERGETIC (2026-10-04, user: "the run is awkward bc it needs more airtime / energy to it and seems kinda stiff"). The
// 10-03 run had a 41° knee drive, a 4.5 cm pelvis range on the rig, a 33° knee at toe-off (no push-off stretch), arms
// pumping mostly BEHIND (−61 … +40°, the hand never above the shoulder − 3 cm) and fore-aft only, at ~210 steps/min.
// Now: a lower cadence (~180 steps/min at Play's 5.2 m/s) and a shorter contact (duty 0.22), so each step floats; a
// SPRING-MASS pelvis (`air`: a ballistic flight arc + a stance compression — the squash at landing, the stretch to a
// near-straight knee at toe-off over a pointed foot); the heel whips up at once and the knee drives to ~75° (keys eased
// so the leg whips through; the fold during the drive held ≤ ~105° so a long dress's hem stays clear — the
// skirt-leg-follow gate); a big arm pump (the hand reaching ~chin height in front, the elbow well behind the torso,
// crossing a little toward the midline); a bigger chest bounce, chest counter-turn and lean, a head nod on each impact.
// The JOG below is the same model, smaller — the animator blends jog → run by speed.
const RUN: GaitSpec = {
    name: 'Run', period: 0.74, speed: 4.6, duty: 0.22, legK: 0.996, stanceFlex: 0, loadDip: 0, crouch: 0.02, flight: 0.05,
    lift: 0, liftPeak: 0.5, swingK: 1, reach: -0.115, width: 0.008, heelStrike: 8, toeOff: 56, toeClear: 0,
    sway: 0.01, roll: 3.5, twist: 11, lean: 9, headDown: 4, arm: 56, armFwd: 18, armOut: 11, armTwist: -6,
    elbow: 76, elbowSwing: 26, armLag: 0.04,
    tilt: 2.5, chestSway: 1.8, sideLag: 0.03, headLag: 0.04, forearmLag: 0.05, handLag: 8, protract: 10,
    bob: -0.045, air: 0.05, pushRise: 0.04, swingKeys: [[0.1, -10, 78], [0.3, 12, 104], [0.5, 50, 98], [0.68, 82, 90], [0.84, 62, 44]],
    footSwing: 10, landVel: 0.3, heelEnd: 0.18, heelOff: 0.36, bodyLean: 9, armCross: 16, chestBounce: 3, headNod: 3,
};
// Jog (2026-10-04): the energetic model at ~3 m/s — longer contact, a smaller float and compression, the knee driving
// to ~50°, a smaller arm pump, a lighter lean. Blended in between the walk and the run (play-mode.md §The jog).
const JOG: GaitSpec = {
    name: 'Jog', period: 0.76, speed: 3.0, duty: 0.32, legK: 0.994, stanceFlex: 0, loadDip: 0, crouch: 0.015, flight: 0.03,
    lift: 0, liftPeak: 0.5, swingK: 1, reach: -0.1, width: 0.012, heelStrike: 8, toeOff: 48, toeClear: 0,
    sway: 0.014, roll: 3.5, twist: 8, lean: 6, headDown: 4, arm: 34, armFwd: 9, armOut: 10, armTwist: -2,
    elbow: 72, elbowSwing: 18, armLag: 0.045,
    tilt: 2, chestSway: 1.8, sideLag: 0.035, headLag: 0.04, forearmLag: 0.06, handLag: 8, protract: 6,
    bob: -0.032, air: 0.028, pushRise: 0.02, swingKeys: [[0.12, -10, 64], [0.32, 8, 98], [0.54, 34, 94], [0.71, 52, 74], [0.86, 48, 40]],
    footSwing: 8, landVel: 0.25, heelEnd: 0.2, heelOff: 0.42, bodyLean: 5, armCross: 10, chestBounce: 2.2, headNod: 2,
};
// Sneak: crouched (pelvis ~14 cm down, knees bent), long ground contact, careful low steps, arms held forward.
const SNEAK: GaitSpec = {
    name: 'Sneak', period: 1.1, speed: 0.9, duty: 0.66, legK: 0.92, stanceFlex: 0.02, loadDip: 0.012, crouch: 0.17, flight: 0,
    lift: 0.07, liftPeak: 0.45, swingK: 0.9, reach: -0.02, width: 0.03, heelStrike: 4, toeOff: 16, toeClear: 10,
    sway: 0.018, roll: 2, twist: 4, lean: 21, headDown: 4, arm: 11, armFwd: 26, armOut: 8, armTwist: 34,
    elbow: 62, elbowSwing: 10, armLag: 0.05,
    tilt: 0.8, chestSway: 1.2, sideLag: 0.04, headLag: 0.04, forearmLag: 0.05, handLag: 4, protract: 2,
};
// Stroll (2026-10-03): the slow walk the animator blends in below the walk speed — a start, a stop, a half-tilted
// stick. Shorter, slower steps, a small loose arm swing with soft elbows, the torso nearly upright.
const STROLL: GaitSpec = {
    name: 'Stroll', period: 1.12, speed: 0.85, duty: 0.62, legK: 0.997, stanceFlex: 0, loadDip: 0.003, crouch: 0.004, flight: 0,
    lift: 0, liftPeak: 0.35, swingK: 1, reach: -0.02, width: 0.04, heelStrike: 14, toeOff: 32, toeClear: 7,
    bob: 0.014, swingKeys: [[0.3, 9, 54], [0.6, 20, 40], [0.86, 25, 16]], footSwing: -14, landVel: 0.16, heelEnd: 0.2, heelOff: 0.55, bodyLean: 0,
    sway: 0.022, roll: 3.2, twist: 4, lean: 2, headDown: 3, arm: 13, armFwd: 2, armOut: 4, armTwist: null,
    elbow: 12, elbowSwing: 11, armLag: 0.06,
    tilt: 1, chestSway: 1.8, sideLag: 0.05, headLag: 0.04, forearmLag: 0.08, handLag: 7, protract: 2.5,
};

/** A character's walking PERSONALITY (each −1..1, seeded by its id): longer / shorter stride, quicker / slower
 *  cadence, a bigger / smaller arm swing, more / less bounce, swagger (pelvis twist + roll, torso sway) and posture
 *  (lean + head). All zero = the authored gaits exactly. */
export interface GaitPersonality { stride: number; cadence: number; arm: number; bounce: number; swagger: number; posture: number; }
export const NEUTRAL_PERSONALITY: GaitPersonality = { stride: 0, cadence: 0, arm: 0, bounce: 0, swagger: 0, posture: 0 };
/** The personality for a seed (a character id string or a number): deterministic, every axis in [−1, 1]. */
export function gaitPersonality(seed: string | number): GaitPersonality {
    const r = seededRandom(typeof seed === 'number' ? seed : seedFromString(seed));
    const v = () => { const x = r() * 2 - 1; return Math.sign(x) * Math.pow(Math.abs(x), 0.8); };
    return { stride: v(), cadence: v(), arm: v(), bounce: v(), swagger: v(), posture: v() };
}
/** A gait spec varied by a personality (small: a crowd reads as individuals, no gait leaves its gates). */
export function varyGait(g: GaitSpec, p: GaitPersonality): GaitSpec {
    const k = (x: number, a: number) => 1 + a * Math.max(-1, Math.min(1, x));
    return {
        ...g,
        period: g.period * k(p.cadence, -0.045),
        speed: g.speed * k(p.stride, 0.04) * k(p.cadence, 0.02),
        arm: g.arm * k(p.arm, 0.2), elbowSwing: g.elbowSwing * k(p.arm, 0.15), armOut: g.armOut + 1.2 * Math.max(0, p.arm),
        loadDip: g.loadDip * k(p.bounce, 0.3), lift: g.lift * k(p.bounce, 0.1), flight: g.flight * k(p.bounce, 0.15),
        ...(g.bob !== undefined ? { bob: g.bob * k(p.bounce, 0.15) } : {}),
        ...(g.air !== undefined ? { air: g.air * k(p.bounce, 0.15) } : {}),
        stanceFlex: g.stanceFlex * k(p.bounce, 0.15),
        twist: g.twist * k(p.swagger, 0.25), roll: g.roll * k(p.swagger, 0.22), sway: g.sway * k(p.swagger, 0.2),
        chestSway: g.chestSway * k(p.swagger, 0.3),
        lean: g.lean + 1.5 * p.posture, headDown: g.headDown + 1.5 * p.posture,
    };
}

/** Clip names (all runtime-generated). */
export const LOCOMOTION_CLIP = {
    walk: 'Walk', run: 'Run', sneak: 'Sneak', crouch: 'Crouch', jump: 'Jump', fall: 'Fall', land: 'Land', idle: 'Stand',
    stroll: 'Stroll', landDeep: 'Land Deep', landSoft: 'Land Soft', stomp: 'Stomp', jog: 'Jog',
} as const;
/** Walk STYLES (2026-10-03): the clip the default gait walks with. 'natural' = Walk; 'stomp' = Stomp (the heavy,
 *  flat-footed tread — kept for custom use, e.g. stomping through swamp water). */
export type WalkStyle = 'natural' | 'stomp';
export const WALK_STYLE_CLIP: Record<WalkStyle, string> = { natural: 'Walk', stomp: 'Stomp' };
/** The locomotion slots with the walk style applied: 'stomp' swaps the runtime `Walk` for `Stomp` (when the rig has it)
 *  and drops the stroll (the natural slow walk would blend back in below the walk speed). Anything else is unchanged. */
export function applyWalkStyle<T extends { walk: string; stroll?: string }>(clips: T, style: WalkStyle | string | null | undefined, available: (name: string) => boolean): T {
    if (style !== 'stomp' || clips.walk !== WALK_STYLE_CLIP.natural || !available(WALK_STYLE_CLIP.stomp)) return clips;
    const out = { ...clips, walk: WALK_STYLE_CLIP.stomp };
    delete out.stroll;
    return out;
}
/** The JUMP VARIANTS (2026-10-03), in build order; `Jump` (the classic) is one of them. The asymmetric ones come as a
 *  mirrored pair named by the leg that leads (the animator matches it to the gait at take-off). */
export const JUMP_VARIANT_CLIPS: string[] = ['Jump', 'Jump Tuck', 'Jump Reach', 'Jump Swing L', 'Jump Swing R', 'Jump Stride L', 'Jump Stride R', 'Jump Hop'];
/** Every runtime clip buildLocomotionClips makes, in its order. */
export const DEFAULT_LOCOMOTION_CLIP_NAMES: string[] = [
    'Walk', 'Run', 'Sneak', 'Stroll', 'Crouch', ...JUMP_VARIANT_CLIPS, 'Fall', 'Land', 'Land Deep', 'Land Soft', 'Stand', 'Stomp', 'Jog',
];

const TAU = Math.PI * 2;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const smoother = (x: number) => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };

// ── Small quaternion / vector kit ([x,y,z,w], the body-generator convention) ─────────────────────────────────────
const qInv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qRot(q: Quat, v: V3): V3 {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addV = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Quaternion of the rotation matrix with columns x, y, z (orthonormal, right-handed). */
function qFromBasis(x: V3, y: V3, z: V3): Quat {
    const m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
    let q: Quat;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, 0.25 * s]; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s]; }
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

// ── Rig measurements ───────────────────────────────────────────────────────────────────────────────────────────
export type Joint = { name: string; localPosition?: [number, number, number] | number[] };

/** Exported for the idle variants (default-idle-variants.ts, 2026-10-04), which reuse the rig measurement + leg IK. */
export interface Rig {
    idx: Map<string, number>;
    hipsRest: V3 | null;
    hipOff: { L: V3; R: V3 };  // upperleg offsets from the hips joint
    l1: number; l2: number; L: number;
    lb: number;                // ankle → ball (foot rocker length)
    lh: number;                // ankle → heel
    a0: number;                // ankle height above the sole
    groundY: number;           // rest ankle height relative to the hips joint (stance ankle plane)
}

export function measureRig(joints: Joint[]): Rig {
    const idx = new Map(joints.map((j, i) => [j.name, i]));
    const pos = (n: string): V3 | null => { const p = joints[idx.get(n) ?? -1]?.localPosition; return p ? [p[0], p[1], p[2]] : null; };
    const lenOf = (n: string, fb: number) => { const p = pos(n); return p ? Math.hypot(p[0], p[1], p[2]) : fb; };
    const l1 = lenOf('lowerleg_L', 0.42), l2 = lenOf('foot_L', 0.42), L = l1 + l2;
    const hipL = pos('upperleg_L') ?? [0.045, -0.14, 0], hipR = pos('upperleg_R') ?? [-hipL[0], hipL[1], hipL[2]];
    const k = L / REF_LEG;
    return {
        idx, hipsRest: pos('hips'), hipOff: { L: hipL, R: hipR }, l1, l2, L,
        lb: 0.15 * k, lh: 0.045 * k, a0: 0.07 * k, groundY: hipL[1] - L,
    };
}

/** The clip's ground speed in rig units / s (what `groundSpeed` records). */
function rigSpeed(g: GaitSpec, rig: Rig): number { return g.speed * (rig.L / REF_LEG); }

// ── Two-bone leg IK ────────────────────────────────────────────────────────────────────────────────────────────
/** Local rotations of upperleg / lowerleg / foot that put the ankle at `ankle` (rig space) with the foot at world pitch
 *  `footPitch` (deg, − = toes up), for a hip joint at `hip` under a pelvis rotation `hipsQ`. The knee bends toward +Z
 *  (the toes). The reach is clamped below full extension (knee ≥ ~6°), so a knee never locks or hyper-extends. */
export function solveLeg(rig: Rig, hipsQ: Quat, hip: V3, ankle: V3, footPitch: number): { upper: Quat; lower: Quat; foot: Quat; knee: number; reached: boolean } {
    const { l1, l2 } = rig;
    const toA = sub(ankle, hip);
    const want = len(toA);
    const maxR = (l1 + l2) * 0.9985, minR = Math.abs(l1 - l2) + 0.2 * (l1 + l2);
    const D = Math.max(minR, Math.min(maxR, want));
    const u = want > 1e-9 ? scl(toA, 1 / want) : [0, -1, 0] as V3;
    const ca = Math.max(-1, Math.min(1, (l1 * l1 + D * D - l2 * l2) / (2 * l1 * D)));
    const a = Math.acos(ca);
    // Knee pole: the character's forward (+Z), made perpendicular to the hip→ankle line.
    let perp = sub([0, 0, 1], scl(u, u[2]));
    if (len(perp) < 1e-6) perp = [0, 1, 0];
    perp = norm(perp);
    const knee = addV(hip, addV(scl(u, l1 * Math.cos(a)), scl(perp, l1 * Math.sin(a))));
    const end = addV(hip, scl(u, D));
    const dT = norm(sub(knee, hip)), dS = norm(sub(end, knee));
    let hinge = cross(dT, dS);
    if (len(hinge) < 1e-5) hinge = [1, 0, 0];
    const yAx = scl(dT, -1);
    const xAx = norm(sub(hinge, scl(yAx, dot(hinge, yAx))));
    const zAx = cross(xAx, yAx);
    const thighW = qFromBasis(xAx, yAx, zAx);
    const kneeDeg = deg(Math.acos(Math.max(-1, Math.min(1, dot(dT, dS)))));
    const lower = qAxis('x', kneeDeg);
    const shinW = qMul(thighW, lower);
    return { upper: qMul(qInv(hipsQ), thighW), lower, foot: qMul(qInv(shinW), qAxis('x', footPitch)), knee: kneeDeg, reached: want <= maxR + 1e-6 };
}

// ── The gait model ─────────────────────────────────────────────────────────────────────────────────────────────
/** Ankle target (rig space relative to the REST hips joint, root motion removed) + foot pitch for one leg at leg-phase
 *  q ∈ [0,1): 0 = heel strike, duty = toe-off. */
function footAt(g: GaitSpec, rig: Rig, side: 'L' | 'R', q: number): { z: number; y: number; pitch: number; stance: boolean; s: number } {
    const L = rig.L, v = rigSpeed(g, rig), T = g.period;
    const hs = rad(g.heelStrike), to = rad(g.toeOff);
    // Rockers: the ankle's offset from its flat-foot position while rolling about the heel (toes up γ) / the ball (β).
    const heelRock = (gam: number) => ({ z: -(rig.lh * (1 - Math.cos(gam)) + rig.a0 * Math.sin(gam)), y: rig.lh * Math.sin(gam) + rig.a0 * (Math.cos(gam) - 1) });
    const ballRock = (bet: number) => ({ z: rig.lb * (1 - Math.cos(bet)) + rig.a0 * Math.sin(bet), y: rig.lb * Math.sin(bet) + rig.a0 * (Math.cos(bet) - 1) });
    const travel = v * g.duty * T;                                  // hip travel over the planted foot
    const rockTo = ballRock(to);
    const zFlat = g.reach * L + (travel - rockTo.z) / 2;             // centre the ankle sweep on the reach offset
    const HEEL_END = 0.14, HEEL_OFF = g.duty > 0.5 ? 0.55 : 0.45;   // stance fractions: foot flat by / heel rises from
    if (q < g.duty) {
        const s = q / g.duty, tau = s * g.duty * T;
        let z = zFlat - v * tau, y = rig.groundY, pitch = 0;
        if (s < HEEL_END) { const gam = hs * (1 - smooth(s / HEEL_END)); const r = heelRock(gam); z += r.z; y += r.y; pitch = -deg(gam); }
        else if (s > HEEL_OFF) { const bet = to * smooth((s - HEEL_OFF) / (1 - HEEL_OFF)); const r = ballRock(bet); z += r.z; y += r.y; pitch = deg(bet); }
        return { z, y, pitch, stance: true, s };
    }
    // Swing: a cubic Hermite in place from the toe-off ankle to the next heel-strike ankle. The end tangents are the
    // planted foot's in-place velocity (−v) × swingK: 1 = zero world velocity at lift-off and touch-down (no skid),
    // less = the foot whips forward sooner (a run's heel kick / knee drive; the lift clears it off the ground at once).
    const u = (q - g.duty) / (1 - g.duty), swingT = (1 - g.duty) * T;
    const hr = heelRock(hs);
    const z0 = zFlat - travel + rockTo.z, y0 = rig.groundY + rockTo.y;
    const z1 = zFlat + hr.z, y1 = rig.groundY + hr.y;
    const m = -v * swingT * g.swingK;
    const u2 = u * u, u3 = u2 * u;
    const z = (2 * u3 - 3 * u2 + 1) * z0 + (u3 - 2 * u2 + u) * m + (-2 * u3 + 3 * u2) * z1 + (u3 - u2) * m;
    const bump = Math.pow(Math.sin(Math.PI * Math.pow(u, Math.log(0.5) / Math.log(g.liftPeak))), 1.1);
    const y = y0 + (y1 - y0) * smooth(u) + g.lift * L * bump;
    const pitch = deg(to) * (1 - smooth(u / 0.6)) - g.toeClear * Math.sin(Math.PI * clamp01(u / 0.85)) - g.heelStrike * smooth((u - 0.55) / 0.45);
    void side;
    return { z, y, pitch, stance: false, s: u };
}

// ── The NATURAL gait model (2026-10-03, specs with `bob`) ──────────────────────────────────────────────────────────
/** Stance ankle (rig space, root motion removed) + world foot pitch at stance fraction s ∈ [0,1]: the heel strike rolls
 *  down about the heel to foot-flat by `heelEnd`, the heel rises from `heelOff` about the ball, ACCELERATING into the
 *  push-off (the old model eased it to a stop at toe-off, so the foot paused before it left the ground). */
function naturalStance(g: GaitSpec, rig: Rig, s: number): { z: number; y: number; pitch: number } {
    const L = rig.L, v = rigSpeed(g, rig), T = g.period;
    const hs = rad(g.heelStrike), to = rad(g.toeOff);
    const travel = v * g.duty * T;
    const rockTo = ballRockAt(rig, to);
    const zFlat = g.reach * L + (travel - rockTo.z) / 2;
    const HE = g.heelEnd ?? 0.14, HO = g.heelOff ?? 0.5;
    let z = zFlat - v * s * g.duty * T, y = rig.groundY, pitch = 0;
    if (s < HE) { const gam = hs * (1 - smooth(s / HE)); const r = heelRockAt(rig, gam); z += r.z; y += r.y; pitch = -deg(gam); }
    else if (s > HO) { const x = clamp01((s - HO) / (1 - HO)); const bet = to * x * x * (1.6 - 0.6 * x); const r = ballRockAt(rig, bet); z += r.z; y += r.y; pitch = deg(bet); }
    return { z, y, pitch };
}
/** The ankle's offset from its flat-foot position, rolling about the heel (toes up γ) / the ball (heel up β). */
function heelRockAt(rig: Rig, gam: number) { return { z: -(rig.lh * (1 - Math.cos(gam)) + rig.a0 * Math.sin(gam)), y: rig.lh * Math.sin(gam) + rig.a0 * (Math.cos(gam) - 1) }; }
function ballRockAt(rig: Rig, bet: number) { return { z: rig.lb * (1 - Math.cos(bet)) + rig.a0 * Math.sin(bet), y: rig.lb * Math.sin(bet) + rig.a0 * (Math.cos(bet) - 1) }; }

/** Ankle relative to the hip for a thigh pitch θ (deg, + = forward) and knee flex k (deg), in the sagittal plane. */
function legFK(rig: Rig, th: number, k: number): { z: number; y: number } {
    const a = rad(th), b = rad(th - k);
    return { z: rig.l1 * Math.sin(a) + rig.l2 * Math.sin(b), y: -(rig.l1 * Math.cos(a) + rig.l2 * Math.cos(b)) };
}
/** The shank's angle from straight down (deg, + = the ankle ahead of the knee) for an ankle at (dz, dy) from the hip,
 *  as the 2-bone IK (knee forward) solves it. A foot at right angles to the shank has world pitch −φ (toes down +). */
function shankAngle(rig: Rig, dz: number, dy: number): number {
    const { l1, l2 } = rig;
    const D = Math.max(Math.abs(l1 - l2) + 0.2 * (l1 + l2), Math.min((l1 + l2) * 0.9985, Math.hypot(dz, dy)));
    const th = Math.atan2(dz, -dy) + Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + D * D - l2 * l2) / (2 * l1 * D))));
    const kz = l1 * Math.sin(th), ky = -l1 * Math.cos(th);
    const ux = dz / (Math.hypot(dz, dy) || 1) * D, uy = dy / (Math.hypot(dz, dy) || 1) * D;
    return deg(Math.atan2(ux - kz, -(uy - ky)));
}

/** NATURAL foot target for one leg at leg-phase q (0 = heel strike, duty = toe-off), for a hip joint at `hip` (rig space
 *  relative to the rest hips joint). Stance: naturalStance. Swing: a spline of ankle positions from the toe-off ankle
 *  (leaving at the stance's own velocity — continuous push-off) through the `swingKeys` (thigh / knee angles placed off
 *  this hip: the knee folds and drives as keyed) to the heel-strike ankle, arriving with zero forward world velocity
 *  and a small downward one (`landVel`) — a glide onto the heel, not a drop. The swing foot follows its shank, plus a
 *  mid-swing pitch (`footSwing`), from the toe-off pitch to the heel-strike pitch. */
function naturalFoot(g: GaitSpec, rig: Rig, q: number, hip: V3): { z: number; y: number; pitch: number; stance: boolean; s: number } {
    if (q < g.duty) { const s = q / g.duty; return { ...naturalStance(g, rig, s), stance: true, s }; }
    const u = (q - g.duty) / (1 - g.duty);
    const stT = g.duty * g.period, swT = (1 - g.duty) * g.period, e = 1e-3;
    const a = naturalStance(g, rig, 1), a0 = naturalStance(g, rig, 1 - e), b = naturalStance(g, rig, 0), b1 = naturalStance(g, rig, e);
    // Tangents per unit u: the stance velocity at toe-off / heel strike (zero world velocity there), + the touch-down drop.
    const kSc = rig.L / REF_LEG;
    const m0 = { z: (a.z - a0.z) / (e * stT) * swT, y: (a.y - a0.y) / (e * stT) * swT };
    const m1 = { z: (b1.z - b.z) / (e * stT) * swT * g.swingK, y: -(g.landVel ?? 0) * kSc * swT };
    // The keys hang off a NOMINAL hip height (the gait's mean pelvis), not this frame's: a key that rode the pelvis down
    // would lower the landing target, which lowers the pelvis fit (pelvisWave), and so on — a feedback that sank the walk.
    const hipKeyY = rig.hipOff.L[1] - (g.crouch + Math.abs(g.bob ?? 0) + 0.01) * rig.L;
    // The spring-mass run (`air`) floats the pelvis well above that in flight: the EARLY keys (heel kick, knee drive —
    // never part of the pelvis fit, which only reads a swing leg from s 0.72) hang off this frame's hip, so the knee
    // folds and drives as keyed at the top of the float instead of straightening toward a nominal hip below it.
    const keyY = (ku: number) => (g.air !== undefined && ku < 0.6 ? hip[1] : hipKeyY);
    const pts: { u: number; z: number; y: number }[] = [{ u: 0, z: a.z, y: a.y }];
    for (const [ku, th, k] of g.swingKeys ?? []) { const f = legFK(rig, th, k); pts.push({ u: ku, z: hip[2] + f.z, y: keyY(ku) + f.y }); }
    pts.push({ u: 1, z: b.z, y: b.y });
    let i = 0;
    while (i < pts.length - 2 && u > pts[i + 1].u) i++;
    const cr = (j: number) => ({ z: (pts[j + 1].z - pts[j - 1].z) / (pts[j + 1].u - pts[j - 1].u), y: (pts[j + 1].y - pts[j - 1].y) / (pts[j + 1].u - pts[j - 1].u) });
    // The spring-mass run's leg RETRACTS into the landing (the knee drive peaks ahead, then the foot paws back to zero
    // world speed): the last key already leans toward the landing's backward sweep, so the foot doesn't brake in the
    // final frames (a skid at touch-down).
    const tan = (j: number) => j === 0 ? m0 : j === pts.length - 1 ? m1
        : g.air !== undefined && j === pts.length - 2 ? { z: 0.5 * cr(j).z + 0.5 * m1.z, y: cr(j).y } : cr(j);
    const P = pts[i], Q = pts[i + 1], du = Q.u - P.u, t = clamp01((u - P.u) / du), tP = tan(i), tQ = tan(i + 1);
    const h00 = 2 * t ** 3 - 3 * t * t + 1, h10 = t ** 3 - 2 * t * t + t, h01 = -2 * t ** 3 + 3 * t * t, h11 = t ** 3 - t * t;
    const z = h00 * P.z + h10 * du * tP.z + h01 * Q.z + h11 * du * tQ.z;
    let y = h00 * P.y + h10 * du * tP.y + h01 * Q.y + h11 * du * tQ.y;
    // Foot pitch: relative to the shank, eased from the toe-off value to the heel-strike value, + the mid-swing pitch.
    const phi = (zz: number, yy: number) => shankAngle(rig, zz - hip[2], yy - hip[1]);
    const r0 = a.pitch + phi(a.z, a.y), r1 = b.pitch + phi(b.z, b.y);
    const rel = r0 + (r1 - r0) * smooth(u) + (g.footSwing ?? 0) * Math.sin(Math.PI * clamp01(u / 0.8));
    const pitch = rel - phi(z, y);
    // Never through the floor: the ankle stays high enough that the heel (toes up) / the ball (toes down) clears it.
    const pr = rad(pitch);
    const drop = rig.a0 * (1 - Math.cos(pr)) + (pitch < 0 ? rig.lh : -rig.lb) * Math.sin(pr);   // lowest point vs a flat foot
    y = Math.max(y, rig.groundY - drop);
    return { z, y, pitch, stance: false, s: u };
}

/** NATURAL pelvis height offsets (from rest, n frames): a smooth wave (±|bob|·L, twice a cycle: + = highest at
 *  mid-stance, − = lowest there) placed as HIGH as every leg's reach allows — the stance legs and the leg landing next
 *  (late swing) — so the planted ankles are on their footprints and the landing foot reaches the ground on time. Minus
 *  a gentle loading-response dip (`loadDip`, peaking ~10 % of a cycle after each heel strike). */
function pelvisWave(g: GaitSpec, rig: Rig, n: number, hipsQAt: (p: number) => Quat, swayAt: (p: number) => number): number[] {
    const L = rig.L, A = Math.abs(g.bob ?? 0) * L, sgn = (g.bob ?? 0) >= 0 ? 1 : -1;
    const shape = g.air !== undefined ? springShape(g, L) : (p: number) => sgn * A * Math.cos(2 * TAU * (p - g.duty / 2 - (g.bobPhase ?? 0)));
    let c = -g.crouch * L;
    for (let pass = 0; pass < 3; pass++) {
        let lim = Infinity;
        for (let i = 0; i < n; i++) {
            const p = i / n, hipsQ = hipsQAt(p), sway = swayAt(p), h = c + shape(p);
            for (const side of ['L', 'R'] as const) {
                const q = side === 'L' ? p : (p + 0.5) % 1;
                const off = qRot(hipsQ, rig.hipOff[side]);
                const hip: V3 = [sway + off[0], h + off[1], off[2]];
                const f = naturalFoot(g, rig, q, hip);
                if (!f.stance && f.s < 0.72) continue;              // a leg in the air (not landing yet) doesn't bound it
                const ax = rig.hipOff[side][0] + Math.sign(rig.hipOff[side][0]) * g.width * L;
                const dx = ax - (off[0] + sway), dz = f.z - off[2];
                const reach = L * g.legK;
                const cap = f.y - off[1] + Math.sqrt(Math.max(0, reach * reach - dx * dx - dz * dz));
                lim = Math.min(lim, cap - shape(p));
            }
        }
        c = Math.min(-g.crouch * L, lim - 0.001 * L);
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        const p = i / n, u = ((p % 0.5) + 0.5) % 0.5, w = 0.2;
        out.push(c + shape(p) - g.loadDip * L * (u < w ? Math.pow(Math.sin(Math.PI * u / w), 2) : 0));
    }
    return out;
}

/** The SPRING-MASS pelvis shape (specs with `air`, the jog / run), twice a cycle: over each stance a half-sine
 *  COMPRESSION (−|bob|·L, deepest at mid-stance), over each flight a ballistic ARC (+air·L at its apex), zero at contact
 *  and toe-off. One periodic [1 2 1] pass over the frames rounds the joins (the takeoff / landing velocities of the two
 *  pieces needn't match exactly). Returns the shape at a frame phase p = i / n. */
function springShape(g: GaitSpec, L: number): (p: number) => number {
    const Ac = Math.abs(g.bob ?? 0) * L, Af = (g.air ?? 0) * L, T = (g.pushRise ?? 0) * L, d = Math.min(0.45, Math.max(0.05, g.duty));
    const raw = (p: number) => {
        const u = ((p % 0.5) + 0.5) % 0.5;
        if (u < d) { const s = u / d; return -Ac * Math.sin(Math.PI * s) + T * s * s; }
        const x = (u - d) / (0.5 - d);
        return T * (1 - x) + Af * 4 * x * (1 - x);
    };
    const cache = new Map<number, number>();
    return (p: number) => {
        const key = Math.round(p * 1e6);
        let v = cache.get(key);
        if (v === undefined) { const h = 1 / Math.max(8, Math.round(g.period * FPS)); v = (raw(p - h) + 2 * raw(p) + raw(p + h)) / 4; cache.set(key, v); }
        return v;
    };
}

/** Pelvis translation Y offset (from rest) for a phase, BEFORE smoothing: the highest the stance legs allow. */
function pelvisCeiling(g: GaitSpec, rig: Rig, p: number, hipsQ: Quat, swayX: number): number | null {
    let h = -g.crouch * rig.L;
    let any = false;
    for (const side of ['L', 'R'] as const) {
        const q = side === 'L' ? p : (p + 0.5) % 1;
        const f = footAt(g, rig, side, q);
        if (!f.stance) continue;
        any = true;
        const off = qRot(hipsQ, rig.hipOff[side]);
        const ax = rig.hipOff[side][0] + Math.sign(rig.hipOff[side][0]) * g.width * rig.L;
        const dx = ax - (off[0] + swayX), dz = f.z - off[2];
        const reach = rig.L * (g.legK - g.stanceFlex * Math.sin(Math.PI * f.s));
        const r2 = reach * reach - dx * dx - dz * dz;
        const cap = f.y - off[1] + Math.sqrt(Math.max(0, r2));
        // Soft min (k ≈ 1 cm) so a leg taking over doesn't kink the curve.
        const k = 0.012 * rig.L;
        h = -k * Math.log(Math.exp(-h / k) + Math.exp(-cap / k));
    }
    return any ? h : null;
}

interface GaitFrame { hipsT: V3; hipsQ: Quat; rot: Record<string, Quat>; }

/** The loading-response dip (0..1) at cycle phase p: a smooth bump just after EACH heel strike (p = 0 and 0.5), peaking
 *  ~11 % of a cycle after contact — the knee flexes as the leg takes the body's weight (it only ever LOWERS the pelvis,
 *  so every planted ankle stays reachable). */
export function loadDipAt(p: number, duty: number): number {
    const u = ((p % 0.5) + 0.5) % 0.5, w = Math.min(0.32, duty * 0.8);
    return u < w ? Math.pow(Math.sin(Math.PI * u / w), 2) : 0;
}

/** Sample the gait at N frames (one cycle). `clr` = the body's extra arm raise (deg, playArmClearance). */
function sampleGait(g: GaitSpec, rig: Rig, n: number, clr = 0): GaitFrame[] {
    const yawAt = (p: number) => -g.twist * Math.cos(TAU * p);           // left leg forward at p = 0 → left hip leads
    const rollAt = (p: number) => g.roll * Math.cos(TAU * (p - g.duty / 2));   // left mid-stance → the right (swing) hip drops
    const tiltAt = (p: number) => g.tilt * Math.cos(2 * TAU * (p - 0.08));     // tips forward as each leg takes the weight
    const bodyLean = g.bodyLean ?? 0;                                        // natural model: the whole body leans
    const hipsQAt = (p: number) => qMul(qAxis('y', yawAt(p)), qMul(qAxis('z', rollAt(p)), qAxis('x', tiltAt(p) + bodyLean)));
    const swayAt = (p: number) => g.sway * rig.L * Math.cos(TAU * (p - g.duty / 2));   // over the stance foot
    const natural = g.bob !== undefined;
    const s = natural ? pelvisWave(g, rig, n, hipsQAt, swayAt) : legacyPelvis(g, rig, n, hipsQAt, swayAt);

    const out: GaitFrame[] = [];
    const hipsRest = rig.hipsRest ?? [0, 0, 0];
    for (let i = 0; i < n; i++) {
        const p = i / n;
        const hipsQ = hipsQAt(p), sway = swayAt(p);
        const hipsT: V3 = [hipsRest[0] + sway, hipsRest[1] + s[i], hipsRest[2]];
        const rot: Record<string, Quat> = {};
        for (const side of ['L', 'R'] as const) {
            const q = side === 'L' ? p : (p + 0.5) % 1;
            const off = qRot(hipsQ, rig.hipOff[side]);
            const hip: V3 = [sway + off[0], s[i] + off[1], off[2]];
            const f = natural ? naturalFoot(g, rig, q, hip) : footAt(g, rig, side, q);
            const ax = rig.hipOff[side][0] + Math.sign(rig.hipOff[side][0]) * g.width * rig.L;
            const leg = solveLeg(rig, hipsQ, hip, [ax, f.y, f.z], f.pitch);
            rot[`upperleg_${side}`] = leg.upper; rot[`lowerleg_${side}`] = leg.lower; rot[`foot_${side}`] = leg.foot;
        }
        upperBody(g, rot, p, hipsQ, yawAt, rollAt, tiltAt, clr);
        out.push({ hipsT, hipsQ, rot });
    }
    return out;
}

/** The Round 8 pelvis (Stomp / Sneak): the stance ceilings, flight a ballistic arc, smoothed, re-clamped, the load dip. */
function legacyPelvis(g: GaitSpec, rig: Rig, n: number, hipsQAt: (p: number) => Quat, swayAt: (p: number) => number): number[] {
    // Pelvis height: stance ceilings; flight (no stance leg) = a ballistic arc between the neighbouring stance values.
    const raw: (number | null)[] = [];
    for (let i = 0; i < n; i++) { const p = i / n; raw.push(pelvisCeiling(g, rig, p, hipsQAt(p), swayAt(p))); }
    const h: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        if (raw[i] !== null) { h[i] = raw[i]!; continue; }
        let a = i - 1, b = i + 1;                                           // unwrapped neighbours with a stance leg
        while (raw[((a % n) + n) % n] === null && i - a < n) a--;
        while (raw[b % n] === null && b - i < n) b++;
        const ha = raw[((a % n) + n) % n] ?? 0, hb = raw[b % n] ?? 0, u = (i - a) / Math.max(1, b - a);
        h[i] = ha + (hb - ha) * u + 4 * g.flight * rig.L * u * (1 - u);
    }
    // Smooth (periodic [1 2 1]/4 twice), then re-clamp to the stance ceilings so every planted ankle stays reachable.
    let s = h.slice();
    for (let pass = 0; pass < 2; pass++) s = s.map((_, i) => (s[(i - 1 + n) % n] + 2 * s[i] + s[(i + 1) % n]) / 4);
    for (let i = 0; i < n; i++) if (raw[i] !== null) s[i] = Math.min(s[i], raw[i]!);
    for (let i = 0; i < n; i++) s[i] -= g.loadDip * rig.L * loadDipAt(i / n, g.duty);
    return s;
}

/** The gait's upper body at cycle phase p, written into `rot`. */
function upperBody(g: GaitSpec, rot: Record<string, Quat>, p: number, hipsQ: Quat, yawAt: (p: number) => number, rollAt: (p: number) => number, tiltAt: (p: number) => number, clr: number): void {
    {
        // Upper body: lean spread down the spine, the chest counter-rotating the pelvis, the torso swaying over the stance
        // foot a beat late, the head held level + forward — its stabilising counter a touch LATE (headLag), so it floats
        // instead of being nailed to the horizon. Gait feel 2026-10-03: the bob is smooth (was |sin|, a kink each step).
        // The natural model's whole-body lean (bodyLean, on the pelvis) is countered by the neck / head only.
        const bl = g.bodyLean ?? 0;
        const yaw = yawAt(p), roll = rollAt(p), tilt = tiltAt(p);
        const bounceAt = (q: number) => g.flight > 0 ? (g.chestBounce ?? 1.5) * Math.cos(TAU * 2 * (q - g.duty / 2)) : 0.9 * Math.pow(Math.sin(TAU * q), 2);
        const sideAt = (q: number) => -g.chestSway * Math.cos(TAU * (q - g.duty / 2 - g.sideLag));   // − = toward the left (stance) foot
        const bounce = bounceAt(p), side = sideAt(p);
        const ph = p - g.headLag;
        rot.hips = hipsQ;
        rot.lowerback = qMul(qAxis('z', -roll * 0.8), qAxis('x', g.lean * 0.35 - tilt * 0.8));
        rot.spine = qMul(qAxis('z', side * 0.5), qAxis('x', g.lean * 0.35 + bounce));
        rot.chest = qMul(qAxis('y', -yaw * 1.9), qMul(qAxis('z', side * 0.5), qAxis('x', g.lean * 0.3)));
        rot.neck = qAxis('x', -(g.lean + bl) * 0.3);
        const headRoll = -(0.2 * rollAt(ph) + sideAt(ph)) * 0.85;
        // The impact nod: a smooth bump over the first 35 % of each half-cycle after a touch-down (p = 0 and 0.5).
        const nodAt = (q: number) => { const u = (((2 * q) % 1) + 1) % 1; return u < 0.35 ? (g.headNod ?? 0) * Math.pow(Math.sin(Math.PI * u / 0.35), 2) : 0; };
        rot.head = qMul(qAxis('y', yawAt(ph) * 0.9), qMul(qAxis('z', headRoll), qAxis('x', -(g.lean + bl) * 0.55 - bounceAt(ph) * 0.9 + g.headDown + nodAt(ph))));
        // Arms counter-swing the legs (left arm forward while the RIGHT leg is forward, p = 0.5), a touch behind them.
        // OVERLAP: the elbow flex trails the upper arm (forearmLag: it bends most just after the arm's forward extreme,
        // then whips open on the back-swing) and the hand trails the forearm (handLag) — a loose arm, not a rigid pendulum.
        const sw = -Math.cos(TAU * (p - g.armLag));
        const swF = -Math.cos(TAU * (p - g.armLag - g.forearmLag));
        const swV = Math.sin(TAU * (p - g.armLag - g.forearmLag * 0.6));       // + = the left arm swinging forward
        const flex = (x: number) => Math.pow(0.5 + 0.5 * x, 1.6);              // smooth 0 → 1, most bend in front
        const armAt = (base: ArmSpec, s1: number, sF: number, sV: number): ArmSpec => ({
            ...base,
            raise: base.raise + g.armOut + clr,
            twist: (g.armTwist ?? base.twist ?? 0) + (g.armCross ?? 0) * flex(s1),   // the forearm crosses in, in front
            fwd: (base.fwd ?? 0) + g.armFwd + g.arm * s1,
            elbow: g.elbow + g.elbowSwing * flex(sF),
            wrist: (base.wrist ?? 0) + 3,
            wristDev: g.handLag * sV,
        });
        Object.assign(rot, armPose(armAt(RELAXED_ARM_L, sw, swF, swV), 'L'), armPose(armAt(RELAXED_ARM_R, -sw, -swF, -swV), 'R'));
        const relaxed = relaxedStance();
        const lift = g.flight > 0 ? 3 : 1;
        // The shoulders ride with their arms: forward (protracted) as the arm swings forward, lifted a little in front.
        rot.clavicle_L = qMul(relaxed.clavicle_L, qMul(qAxis('y', -g.protract * sw), qAxis('x', -lift * flex(sw) * flex(sw))));
        rot.clavicle_R = qMul(relaxed.clavicle_R, qMul(mirrorQ(qAxis('y', g.protract * sw)), qAxis('x', -lift * flex(-sw) * flex(-sw))));
    }
}

/** Assemble frames into a looping clip (the last frame repeats the first). */
export function toClip(name: string, rig: Rig, frames: { hipsT?: V3; rot: Record<string, Quat> }[], loop: boolean, extra?: Partial<SkeletonAnimClip>): SkeletonAnimClip | null {
    const seq = loop ? [...frames, frames[0]] : frames;
    const rotTracks = new Map<number, Quat[]>();
    for (const fr of seq) for (const [j, q] of Object.entries(fr.rot)) {
        const ji = rig.idx.get(j);
        if (ji === undefined) continue;
        let a = rotTracks.get(ji); if (!a) { a = []; rotTracks.set(ji, a); } a.push(q);
    }
    const tracks: SkeletonKeyframeTrack[] = [];
    for (const [ji, qs] of rotTracks) {
        // Keep the quaternion hemisphere continuous so slerp between keys never takes the long way round.
        for (let i = 1; i < qs.length; i++) { const a = qs[i - 1], b = qs[i]; if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) qs[i] = [-b[0], -b[1], -b[2], -b[3]]; }
        tracks.push({ jointIndex: ji, channel: 'rotation', keyframes: qs.map((q, f) => ({ frame: f, value: q.slice() })) });
    }
    const hi = rig.idx.get('hips');
    if (hi !== undefined && rig.hipsRest && seq.every((f) => f.hipsT)) {
        tracks.push({ jointIndex: hi, channel: 'translation', keyframes: seq.map((f, i) => ({ frame: i, value: f.hipsT!.slice() })) });
    }
    if (!tracks.some((t) => t.channel === 'rotation')) return null;   // not a humanoid rig
    return { id: crypto.randomUUID(), name, startFrame: 0, endFrame: seq.length - 1, fps: FPS, tracks, ...extra };
}

function buildGait(g: GaitSpec, rig: Rig, clr = 0): SkeletonAnimClip | null {
    if (!rig.idx.has('upperleg_L') && !rig.idx.has('upperleg_R')) return null;
    const n = Math.max(8, Math.round(g.period * FPS));
    // passPhases: mid-stance of each leg (the legs pass each other) — where the animator's settle step stops a gait.
    return toClip(g.name, rig, sampleGait(g, rig, n, clr), true, { groundSpeed: rigSpeed(g, rig) * g.period / (n / FPS), passPhases: [g.duty / 2, g.duty / 2 + 0.5] });
}

// ── Crouch (sneak idle) ──────────────────────────────────────────────────────────────────────────────────────────
function buildCrouch(rig: Rig, clr = 0): SkeletonAnimClip | null {
    if (!rig.idx.has('upperleg_L')) return null;
    const n = 72;                                                          // 2.4 s breathing loop
    const hipsRest = rig.hipsRest ?? [0, 0, 0];
    const frames: GaitFrame[] = [];
    const drop = 0.17 * rig.L;
    for (let i = 0; i < n; i++) {
        const t = i / n, br = Math.sin(TAU * t), look = Math.sin(TAU * t + 1.1);
        const hipsQ = qMul(qAxis('y', 3), qAxis('z', 1.5));               // weight a touch onto the forward (left) foot
        const hipsT: V3 = [hipsRest[0] + 0.012 * rig.L, hipsRest[1] - drop - 0.006 * rig.L * br, hipsRest[2]];
        const rot: Record<string, Quat> = { hips: hipsQ };
        for (const side of ['L', 'R'] as const) {
            const off = qRot(hipsQ, rig.hipOff[side]);
            const hip: V3 = [hipsT[0] - hipsRest[0] + off[0], hipsT[1] - hipsRest[1] + off[1], off[2]];
            const ax = rig.hipOff[side][0] + Math.sign(rig.hipOff[side][0]) * 0.05 * rig.L;
            const az = side === 'L' ? 0.1 * rig.L : -0.1 * rig.L;          // staggered: left foot forward
            const leg = solveLeg(rig, hipsQ, hip, [ax, rig.groundY, az], 0);
            rot[`upperleg_${side}`] = leg.upper; rot[`lowerleg_${side}`] = leg.lower; rot[`foot_${side}`] = leg.foot;
        }
        const lean = 22 + 1.2 * br;
        rot.lowerback = qAxis('x', lean * 0.35); rot.spine = qAxis('x', lean * 0.35); rot.chest = qMul(qAxis('y', -3), qAxis('x', lean * 0.3));
        rot.neck = qAxis('x', -lean * 0.3);
        rot.head = qMul(qAxis('y', 6 * look), qAxis('x', -lean * 0.6 + 3));
        const armL: ArmSpec = { raise: 30 + clr, fwd: 30 + 2 * br, twist: 38, elbow: 66, wrist: 6 };
        const armR: ArmSpec = { raise: 28 + clr, fwd: 24 + 2 * br, twist: 34, elbow: 58, wrist: 8 };
        Object.assign(rot, armPose(armL, 'L'), armPose(armR, 'R'));
        const relaxed = relaxedStance();
        rot.clavicle_L = relaxed.clavicle_L; rot.clavicle_R = relaxed.clavicle_R;
        frames.push({ hipsT, hipsQ, rot });
    }
    return toClip(LOCOMOTION_CLIP.crouch, rig, frames, true);
}

// ── Air: Jump (sampled by air phase), Fall (loop) ───────────────────────────────────────────────────────────────
/** One air-pose key. Legs per side (thigh / knee / foot pitch), torso lean + head, the arms (raise / forward / elbow,
 *  `asym` = the LEFT arm that much further forward and the right that much further back, `aElbow` likewise for the
 *  elbows), the chest / pelvis yaw (+ = to the left) and the pelvis height (fraction of L). */
interface AirKey {
    a: number; tL: number; kL: number; fL: number; tR: number; kR: number; fR: number; lean: number; head: number;
    raise: number; fwd: number; elbow: number; hipsY: number; asym: number; aElbow: number; yaw: number; hipsYaw: number;
}
const K = (k: Partial<AirKey> & Pick<AirKey, 'a'>): AirKey => ({
    tL: 0, kL: 0, fL: 0, tR: 0, kR: 0, fR: 0, lean: 0, head: 0, raise: 21, fwd: 0, elbow: 10, hipsY: 0, asym: 0, aElbow: 0, yaw: 0, hipsYaw: 0, ...k,
});
/** Air phase keys: 0 = take-off (rising fast), 0.5 = apex, 1 = falling fast (reaching for the ground). Item 13: the
 *  take-off extends out of the wind-up crouch (toes pointed, the arms SWING up from behind — they used to sit straight
 *  out in front the whole jump), the apex tucks with the arms out for balance, then the legs reach for the ground. */
const JUMP_KEYS: AirKey[] = [
    K({ a: 0.00, tL: 8, kL: 6, fL: 34, tR: -40, kR: 62, fR: 4, lean: -3, head: -3, raise: 32, fwd: 52, elbow: 28, hipsY: 0.03 }),
    K({ a: 0.22, tL: -10, kL: 46, fL: 18, tR: -54, kR: 84, fR: 4, lean: 3, head: 0, raise: 40, fwd: 36, elbow: 40, hipsY: 0.01 }),
    K({ a: 0.50, tL: -42, kL: 84, fL: 12, tR: -48, kR: 76, fR: 10, lean: 8, head: 4, raise: 50, fwd: 20, elbow: 44, hipsY: 0 }),
    K({ a: 0.76, tL: -26, kL: 40, fL: 6, tR: -30, kR: 46, fR: 8, lean: 4, head: 2, raise: 52, fwd: 10, elbow: 32, hipsY: 0 }),
    K({ a: 1.00, tL: -18, kL: 22, fL: 4, tR: -10, kR: 16, fR: 8, lean: 2, head: 0, raise: 46, fwd: 8, elbow: 24, hipsY: 0 }),
];
/** The WIND-UP (item 13): from a stand to the push-off crouch (feet flat — thigh −θ, knee 2θ, foot −θ, the pelvis down
 *  by L(1 − cos θ)), the torso folding forward and the arms swinging BACK, so the take-off has something to spring from.
 *  Each variant crouches its own way: depth θ, arms back, lean. */
function windupKeys(theta: number, armsBack: number, lean: number, raise = 20, asym = 0): AirKey[] {
    return [
        K({ a: 0, kL: 4, fL: -4, kR: 4, fR: -4, raise: 21, elbow: 10 }),
        K({ a: 1, tL: -theta, kL: 2 * theta, fL: -theta, tR: -theta, kR: 2 * theta, fR: -theta, lean, head: -6, raise, fwd: armsBack, elbow: 16, asym, hipsY: -(1 - Math.cos(rad(theta))) }),
    ];
}
const WINDUP_KEYS = windupKeys(34, -34, 16);

/** A jump VARIANT (2026-10-03): its wind-up crouch, its air keys, when it is picked (JumpVariantInfo) and how it lands. */
interface JumpVariantSpec { name: string; windup: AirKey[]; air: AirKey[]; info: JumpVariantInfo; mirror?: { name: string; side: 'L' | 'R' } }
// A jump from the walk / run blends the stride straight into the take-off pose (no crouch), so the variants that take
// off on BOTH feet (tuck, reach) are rare at a run; the one-footed ones (swing, stride, the classic) carry it.
const JUMP_VARIANTS: JumpVariantSpec[] = [
    // The classic: a knee drives through, a moderate tuck at the apex, arms up and out for balance.
    { name: 'Jump', windup: WINDUP_KEYS, air: JUMP_KEYS, info: { stand: 1, walk: 1, run: 0.6, tap: 0.35, hold: 1, land: 'Land' } },
    // TUCK: a deeper crouch, then both knees pulled up high at the apex, the hands down by the shins; lands deep.
    { name: 'Jump Tuck', windup: windupKeys(40, -40, 20), info: { stand: 1, walk: 0.8, run: 0.25, tap: 0.15, hold: 1.1, land: 'Land Deep' }, air: [
        K({ a: 0.00, tL: 4, kL: 8, fL: 32, tR: 2, kR: 10, fR: 30, lean: -2, head: -4, raise: 30, fwd: 84, elbow: 30, hipsY: 0.03 }),
        K({ a: 0.24, tL: -52, kL: 92, fL: 14, tR: -50, kR: 94, fR: 14, lean: 10, head: 2, raise: 34, fwd: 44, elbow: 70, hipsY: 0.02 }),
        K({ a: 0.48, tL: -64, kL: 108, fL: 16, tR: -60, kR: 104, fR: 14, lean: 16, head: 6, raise: 30, fwd: 22, elbow: 96, hipsY: 0.04 }),
        K({ a: 0.74, tL: -40, kL: 56, fL: 8, tR: -36, kR: 54, fR: 8, lean: 8, head: 3, raise: 46, fwd: 18, elbow: 46, hipsY: 0 }),
        K({ a: 1.00, tL: -20, kL: 24, fL: 4, tR: -18, kR: 22, fR: 4, lean: 4, head: 0, raise: 46, fwd: 14, elbow: 26, hipsY: 0 }),
    ] },
    // REACH: arms swing from far behind to straight up overhead, the body fully extended (toes pointed, a slight arch,
    // looking up), the arms come down forward for the landing.
    { name: 'Jump Reach', windup: windupKeys(32, -52, 18, 22), info: { stand: 1.1, walk: 0.8, run: 0.1, tap: 0.1, hold: 1, land: 'Land' }, air: [
        K({ a: 0.00, tL: 4, kL: 6, fL: 36, tR: 2, kR: 8, fR: 34, lean: -5, head: -8, raise: 24, fwd: 132, elbow: 14, hipsY: 0.03 }),
        K({ a: 0.26, tL: -4, kL: 14, fL: 30, tR: -2, kR: 18, fR: 28, lean: -7, head: -10, raise: 24, fwd: 160, elbow: 12, hipsY: 0.02 }),
        K({ a: 0.50, tL: -12, kL: 30, fL: 18, tR: -8, kR: 36, fR: 20, lean: -4, head: -8, raise: 26, fwd: 158, elbow: 16, hipsY: 0.01 }),
        K({ a: 0.76, tL: -22, kL: 34, fL: 8, tR: -18, kR: 30, fR: 8, lean: 2, head: -2, raise: 36, fwd: 92, elbow: 22, hipsY: 0 }),
        K({ a: 1.00, tL: -18, kL: 24, fL: 4, tR: -14, kR: 20, fR: 6, lean: 4, head: 0, raise: 40, fwd: 52, elbow: 24, hipsY: 0 }),
    ] },
    // SWING (asymmetric, a "layup"): the RIGHT knee drives up while the left leg trails, the LEFT arm reaches high
    // overhead and the right drops back, the chest twisting with them. Mirrored for a left-knee lead.
    { name: 'Jump Swing R', mirror: { name: 'Jump Swing L', side: 'L' }, windup: windupKeys(30, -28, 14, 20, -14),
      info: { stand: 0.6, walk: 1.2, run: 0.9, tap: 0.25, hold: 1, family: 'Jump Swing', side: 'R', land: 'Land' }, air: [
        K({ a: 0.00, tL: 12, kL: 10, fL: 34, tR: -58, kR: 78, fR: 6, lean: -2, head: -6, raise: 26, fwd: 44, asym: 70, elbow: 22, aElbow: -6, yaw: -10, hipsYaw: 6, hipsY: 0.03 }),
        K({ a: 0.25, tL: 8, kL: 42, fL: 22, tR: -64, kR: 72, fR: 8, lean: 2, head: -6, raise: 24, fwd: 52, asym: 92, elbow: 16, aElbow: -4, yaw: -12, hipsYaw: 7, hipsY: 0.02 }),
        K({ a: 0.50, tL: -6, kL: 62, fL: 14, tR: -56, kR: 64, fR: 10, lean: 4, head: -3, raise: 28, fwd: 48, asym: 86, elbow: 20, aElbow: -2, yaw: -9, hipsYaw: 5, hipsY: 0.01 }),
        K({ a: 0.76, tL: -22, kL: 44, fL: 8, tR: -36, kR: 42, fR: 8, lean: 4, head: 1, raise: 42, fwd: 26, asym: 34, elbow: 30, yaw: -4, hipsYaw: 2, hipsY: 0 }),
        K({ a: 1.00, tL: -16, kL: 20, fL: 4, tR: -14, kR: 18, fR: 6, lean: 2, head: 0, raise: 44, fwd: 10, asym: 6, elbow: 24, hipsY: 0 }),
    ] },
    // STRIDE (a running long jump): the LEFT knee drives through, the right leg pushes off and trails — a stride split in
    // the air, the right arm reaching forward, the left back; the trail leg comes through for the landing. Mirrored.
    { name: 'Jump Stride L', mirror: { name: 'Jump Stride R', side: 'R' }, windup: windupKeys(22, -18, 18, 22, -10),
      info: { stand: 0, walk: 0.35, run: 1.8, tap: 0.3, hold: 1, family: 'Jump Stride', side: 'L', land: 'Land Deep' }, air: [
        K({ a: 0.00, tL: -56, kL: 72, fL: 6, tR: 20, kR: 16, fR: 30, lean: 12, head: 6, raise: 34, fwd: 22, asym: -48, elbow: 40, aElbow: 10, yaw: 8, hipsYaw: -6, hipsY: 0.02 }),
        K({ a: 0.25, tL: -60, kL: 46, fL: 4, tR: 28, kR: 50, fR: 24, lean: 10, head: 5, raise: 40, fwd: 30, asym: -56, elbow: 34, aElbow: 8, yaw: 9, hipsYaw: -7, hipsY: 0.01 }),
        K({ a: 0.50, tL: -56, kL: 26, fL: 4, tR: 22, kR: 84, fR: 20, lean: 9, head: 4, raise: 46, fwd: 34, asym: -40, elbow: 32, aElbow: 6, yaw: 7, hipsYaw: -5, hipsY: 0 }),
        K({ a: 0.70, tL: -50, kL: 24, fL: 4, tR: -12, kR: 88, fR: 12, lean: 10, head: 3, raise: 44, fwd: 40, asym: -16, elbow: 32, yaw: 3, hipsYaw: -2, hipsY: 0 }),
        K({ a: 1.00, tL: -36, kL: 18, fL: 2, tR: -8, kR: 42, fR: 10, lean: 11, head: 2, raise: 42, fwd: 30, asym: -6, elbow: 34, yaw: 1, hipsY: 0 }),
    ] },
    // HOP: a TAP — a shallow dip, a small spring off the toes, soft knees and small arm lift; lands soft.
    { name: 'Jump Hop', windup: windupKeys(16, -10, 6, 22), info: { stand: 1, walk: 1, run: 0.7, tap: 3, hold: 0.12, land: 'Land Soft' }, air: [
        K({ a: 0.00, tL: 4, kL: 6, fL: 28, tR: 2, kR: 8, fR: 26, lean: 0, head: -2, raise: 30, fwd: 26, elbow: 44, hipsY: 0.02 }),
        K({ a: 0.40, tL: -20, kL: 44, fL: 14, tR: -14, kR: 38, fR: 12, lean: 3, head: 0, raise: 34, fwd: 18, elbow: 50, aElbow: 6, hipsY: 0.01 }),
        K({ a: 0.70, tL: -16, kL: 30, fL: 8, tR: -12, kR: 26, fR: 8, lean: 3, head: 0, raise: 32, fwd: 12, elbow: 36, hipsY: 0 }),
        K({ a: 1.00, tL: -10, kL: 14, fL: 4, tR: -8, kR: 12, fR: 6, lean: 2, head: 0, raise: 27, fwd: 8, elbow: 22, hipsY: 0 }),
    ] },
];
/** The default Jump clip's phase at take-off: [0, JUMP_TAKEOFF) is the wind-up, the rest the air phase 0 → 1. */
export const JUMP_TAKEOFF = 0.2;
function airKeyAt(keys: AirKey[], a: number): AirKey {
    let i = 0;
    while (i < keys.length - 2 && a > keys[i + 1].a) i++;
    const k0 = keys[i], k1 = keys[i + 1], t = smooth((a - k0.a) / Math.max(1e-6, k1.a - k0.a));
    const out = { ...k0 };
    for (const key of Object.keys(k0) as (keyof AirKey)[]) (out as Record<string, number>)[key] = k0[key] + (k1[key] - k0[key]) * t;
    return out;
}
function airPose(rig: Rig, k: AirKey, clr = 0): { hipsT?: V3; rot: Record<string, Quat> } {
    const rot: Record<string, Quat> = {
        hips: qAxis('y', k.hipsYaw),
        upperleg_L: qAxis('x', k.tL), lowerleg_L: qAxis('x', k.kL), foot_L: qAxis('x', k.fL),
        upperleg_R: qAxis('x', k.tR), lowerleg_R: qAxis('x', k.kR), foot_R: qAxis('x', k.fR),
        lowerback: qMul(qAxis('y', -k.hipsYaw * 0.6), qAxis('x', k.lean * 0.4)), spine: qAxis('x', k.lean * 0.3), chest: qMul(qAxis('y', k.yaw), qAxis('x', k.lean * 0.3)),
        neck: qAxis('x', -k.lean * 0.3), head: qMul(qAxis('y', -(k.yaw + k.hipsYaw * 0.4) * 0.7), qAxis('x', -k.lean * 0.5 + k.head)),
    };
    const armL: ArmSpec = { ...RELAXED_ARM_L, raise: k.raise + clr, fwd: k.fwd + k.asym, elbow: k.elbow + k.aElbow, twist: 10 };
    const armR: ArmSpec = { ...RELAXED_ARM_R, raise: k.raise - 3 + clr, fwd: k.fwd - 4 - k.asym, elbow: k.elbow + 4 - k.aElbow, twist: 8 };
    Object.assign(rot, armPose(armL, 'L'), armPose(armR, 'R'));
    const relaxed = relaxedStance();
    rot.clavicle_L = relaxed.clavicle_L; rot.clavicle_R = relaxed.clavicle_R;
    const hr = rig.hipsRest;
    return { hipsT: hr ? [hr[0], hr[1] + k.hipsY * rig.L, hr[2]] : undefined, rot };
}
/** Mirror a frame across the body's X symmetry plane: swap every _L / _R joint and mirror each rotation (the rig is
 *  left-right symmetric, its joints identity at rest), the pelvis's sideways offset negated. */
function mirrorFrame(rig: Rig, f: { hipsT?: V3; rot: Record<string, Quat> }): { hipsT?: V3; rot: Record<string, Quat> } {
    const rot: Record<string, Quat> = {};
    for (const [j, q] of Object.entries(f.rot)) {
        const m = j.endsWith('_L') ? j.slice(0, -2) + '_R' : j.endsWith('_R') ? j.slice(0, -2) + '_L' : j;
        rot[m] = mirrorQ(q);
    }
    const hr = rig.hipsRest;
    return { hipsT: f.hipsT && hr ? [2 * hr[0] - f.hipsT[0], f.hipsT[1], f.hipsT[2]] : f.hipsT, rot };
}
function buildJumpVariant(rig: Rig, v: JumpVariantSpec, clr = 0): SkeletonAnimClip[] {
    const n = 30;
    const frames = Array.from({ length: n + 1 }, (_, i) => {
        const c = i / n;
        const k = c < JUMP_TAKEOFF ? airKeyAt(v.windup, c / JUMP_TAKEOFF) : airKeyAt(v.air, (c - JUMP_TAKEOFF) / (1 - JUMP_TAKEOFF));
        return airPose(rig, k, clr);
    });
    const out: SkeletonAnimClip[] = [];
    const a = toClip(v.name, rig, frames, false, { takeoffPhase: JUMP_TAKEOFF, jumpVariant: { ...v.info } });
    if (a) out.push(a);
    if (v.mirror) {
        const b = toClip(v.mirror.name, rig, frames.map((f) => mirrorFrame(rig, f)), false, { takeoffPhase: JUMP_TAKEOFF, jumpVariant: { ...v.info, side: v.mirror.side } });
        if (b) out.push(b);
    }
    return out;
}
/** Every jump variant, in JUMP_VARIANT_CLIPS order. */
function buildJumps(rig: Rig, clr = 0): SkeletonAnimClip[] {
    const all = JUMP_VARIANTS.flatMap((v) => buildJumpVariant(rig, v, clr));
    return JUMP_VARIANT_CLIPS.map((n) => all.find((c) => c.name === n)).filter((c): c is SkeletonAnimClip => !!c);
}
function buildFall(rig: Rig, clr = 0): SkeletonAnimClip | null {
    const n = 30;
    const frames = Array.from({ length: n }, (_, i) => {
        const t = i / n, s = Math.sin(TAU * t), c = Math.cos(TAU * t);
        return airPose(rig, K({
            a: 1, tL: -24 + 12 * s, kL: 38 + 14 * c, fL: 10, tR: -20 - 12 * s, kR: 34 - 14 * c, fR: 10,
            lean: 3, head: -6, raise: 72 + 8 * c, fwd: 12 + 6 * s, elbow: 32 + 8 * s, hipsY: 0,
        }), clr);
    });
    return toClip(LOCOMOTION_CLIP.fall, rig, frames, true);
}

// ── Land (additive, relative to rest) ─────────────────────────────────────────────────────────────────────────────
/** The landing squash envelope over the clip's `dur` s (default 0.42): a fast dip (≈ 70 ms) then a smooth recovery. */
export function landEnvelope(t: number, dur = 0.42): number {
    const DOWN = 0.07 * Math.sqrt(dur / 0.42), DUR = dur;
    if (t <= 0) return 0;
    if (t < DOWN) return smooth(t / DOWN);
    return 1 - smoother((t - DOWN) / (DUR - DOWN));
}
/** A landing squash: `depth` = the pelvis drop (fraction of L), `dur` seconds, the torso fold, the arms forward and the
 *  elbows bending for balance. Land = the standard; Land Deep (tuck / long jump) sinks further and longer with the
 *  arms thrown forward; Land Soft (the hop) barely dips. */
interface LandSpec { name: string; depth: number; dur: number; lean: number; arms: number; elbow: number; }
const LANDS: LandSpec[] = [
    { name: 'Land', depth: 0.13, dur: 0.42, lean: 7, arms: 10, elbow: 18 },
    { name: 'Land Deep', depth: 0.2, dur: 0.56, lean: 12, arms: 24, elbow: 30 },
    { name: 'Land Soft', depth: 0.06, dur: 0.3, lean: 3, arms: 4, elbow: 8 },
];
function buildLand(rig: Rig, spec: LandSpec = LANDS[0]): SkeletonAnimClip | null {
    const n = spec.name === 'Land' ? 13 : Math.max(9, Math.round(spec.dur * 30) + 1), dur = spec.dur, D = spec.depth * rig.L;
    const hr = rig.hipsRest;
    const frames = Array.from({ length: n }, (_, i) => {
        const e = landEnvelope((i / (n - 1)) * dur, dur);
        const th = deg(Math.acos(Math.max(-1, Math.min(1, (rig.L - D * e) / rig.L))));
        const rot: Record<string, Quat> = {
            upperleg_L: qAxis('x', -th), lowerleg_L: qAxis('x', 2 * th), foot_L: qAxis('x', -th),
            upperleg_R: qAxis('x', -th), lowerleg_R: qAxis('x', 2 * th), foot_R: qAxis('x', -th),
            lowerback: qAxis('x', spec.lean * e), spine: qAxis('x', spec.lean * (6 / 7) * e), neck: qAxis('x', -spec.lean * (5 / 7) * e), head: qAxis('x', -spec.lean * (6 / 7) * e),
            shoulder_L: qAxis('x', -spec.arms * e), shoulder_R: qAxis('x', -spec.arms * e),
            lowerarm_L: qAxis('y', -spec.elbow * e), lowerarm_R: qAxis('y', spec.elbow * e),
        };
        return { hipsT: hr ? [hr[0], hr[1] - D * e, hr[2]] as V3 : undefined, rot };
    });
    // Frame 0 / last are the rest pose (envelope 0) → a pure delta over whatever the base is doing.
    return toClip(spec.name, rig, frames, false, { fps: (n - 1) / dur });
}

export interface LocomotionClipOptions {
    /** Extra sideways arm raise (deg) for THIS body + outfit (playArmClearance): every gait / air / idle arm pose is
     *  raised by it, so the swinging arms clear a broad torso or a bulky jacket. 0 / absent = the authored poses. */
    armClearance?: number;
    /** Per-character VARIATION (2026-10-03): a seed (the character's id) for its walking personality (gaitPersonality:
     *  stride, cadence, arm swing, bounce, swagger, posture), so a crowd of one body doesn't move in lockstep. Absent =
     *  the authored gaits exactly. */
    variation?: string | number | null;
}

/** The gait arm offset (deg) for a body from the arm-clearance fit of its RELAXED stance on the body + its top
 *  (resolveArmClearance over arm-clearance.withGarments — its per-side raise includes a small margin): the larger side,
 *  capped so a pathological fit can't fling the arms out. */
export function playArmClearance(fitted: { L: number; R: number }): number {
    const fit = Math.max(0, Number.isFinite(fitted.L) ? fitted.L : 0, Number.isFinite(fitted.R) ? fitted.R : 0);
    return Math.min(20, fit);
}

// ── Stand (the Play idle) ─────────────────────────────────────────────────────────────────────────────────────────
/** A breath (0 → 1 → 0 over one cycle u ∈ [0,1)): a quicker inhale, a short top-of-breath hold, a long exhale. */
function breath(u: number): number {
    u = ((u % 1) + 1) % 1;
    if (u < 0.36) return smooth(u / 0.36);
    if (u < 0.44) return 1;
    return 1 - smooth((u - 0.44) / 0.56);
}
/** An eased one-off: 0 before a, rises to 1 by b (with a small overshoot when `back`), holds, falls back to 0 from c to d. */
function pulse(t: number, a: number, b: number, c: number, d: number, back = 0): number {
    if (t <= a || t >= d) return 0;
    if (t < b) { const u = (t - a) / (b - a); return smooth(u) + back * Math.sin(Math.PI * u) * u; }
    if (t <= c) return 1;
    return 1 - smoother((t - c) / (d - c));
}
const STAND_LOOP = 9.6;   // seconds — three breaths, one slow weight shift each way, one glance, one shoulder roll
/**
 * STAND — the Play idle (item 13; the old idle was the stock Breathe clip, torso-only, over straight hanging arms, which
 * read as a mannequin). Subtle, layered, and looping every 9.6 s so it never reads as a cycle:
 *  - breathing (3 breaths): chest / spine rise, the neck counters, the clavicles lift a beat late, the arms drift with it;
 *  - a slow WEIGHT SHIFT left ↔ right: the pelvis slides over the standing foot and tips, the lumbar counters so the
 *    shoulders stay level, the free knee softens — every leg solved by the same IK as the gaits, so the feet stay planted;
 *  - one GLANCE (head snaps round past the target and settles, the neck / chest follow late) and one SHOULDER ROLL
 *    (the right shoulder up, back and down).
 * Arms are the relaxed stance raised by the body's clearance, so the hands hang clear of a broad body / bulky top.
 */
function buildStand(rig: Rig, clr = 0): SkeletonAnimClip | null {
    if (!rig.idx.has('upperleg_L')) return null;
    const n = Math.round(STAND_LOOP * FPS);
    const hipsRest = rig.hipsRest ?? [0, 0, 0];
    const relaxed = relaxedStance();
    const frames: GaitFrame[] = [];
    for (let i = 0; i < n; i++) {
        const t = (i / n) * STAND_LOOP;
        const b = breath(t / (STAND_LOOP / 3));
        // Weight shift: +1 = onto the LEFT leg. A slow sine with a little dwell at each side.
        const ws = Math.sin(TAU * (t / STAND_LOOP - 0.1)), w = Math.sign(ws) * Math.pow(Math.abs(ws), 0.7);
        const tilt = 2.4 * w;                                              // pelvis roll (deg): the standing hip rises
        const hipsQ = qMul(qAxis('y', -1.2 * w), qAxis('z', tilt));
        const sway = 0.02 * rig.L * w, drop = 0.006 * rig.L * Math.abs(w) + 0.002 * rig.L * b;
        const hipsT: V3 = [hipsRest[0] + sway, hipsRest[1] - drop, hipsRest[2]];
        const rot: Record<string, Quat> = { hips: hipsQ };
        for (const side of ['L', 'R'] as const) {
            const off = qRot(hipsQ, rig.hipOff[side]);
            const hip: V3 = [sway + off[0], -drop + off[1], off[2]];
            const sgn = Math.sign(rig.hipOff[side][0]);
            const free = (side === 'L' ? -w : w) > 0;                      // the unweighted leg: a touch forward + out
            const ax = rig.hipOff[side][0] + sgn * 0.018 * rig.L, az = free ? 0.02 * rig.L * Math.abs(w) : -0.004 * rig.L;
            const leg = solveLeg(rig, hipsQ, hip, [ax, rig.groundY, az], 0);
            rot[`upperleg_${side}`] = leg.upper; rot[`lowerleg_${side}`] = leg.lower; rot[`foot_${side}`] = leg.foot;
        }
        // Glance (to the character's left) at 5.2 s, a shoulder roll (right) at 1.6 s.
        const gl = pulse(t, 5.2, 5.5, 6.5, 7.0, 0.35), glLate = pulse(t, 5.3, 5.75, 6.6, 7.2);
        const roll = pulse(t, 1.6, 2.0, 2.05, 2.7);
        const rollBack = pulse(t, 1.85, 2.2, 2.25, 2.9);
        rot.lowerback = qMul(qAxis('z', -tilt * 0.8), qAxis('x', 0.6 * b));
        rot.spine = qMul(qAxis('z', -tilt * 0.15), qAxis('x', -1.2 * b));
        rot.chest = qMul(qAxis('y', 3 * glLate + 1.2 * w), qAxis('x', -2.6 * b));
        rot.neck = qMul(qAxis('y', 5 * glLate), qAxis('x', 1.4 * b));
        rot.head = qMul(qAxis('y', 16 * gl), qMul(qAxis('z', 1.5 * w - 2 * gl), qAxis('x', 1.5 * b - 1.5 * gl + 1)));
        rot.clavicle_L = qMul(relaxed.clavicle_L, qAxis('z', 1.6 * breath(t / (STAND_LOOP / 3) - 0.05)));
        rot.clavicle_R = qMul(relaxed.clavicle_R, qMul(qAxis('y', -6 * rollBack), qAxis('z', -1.6 * breath(t / (STAND_LOOP / 3) - 0.05) - 7 * roll)));
        // Arms: relaxed + clearance, drifting with the breath and the shift (the hanging arm swings a little opposite the hips).
        const armL: ArmSpec = { ...RELAXED_ARM_L, raise: RELAXED_ARM_L.raise + clr + 1.2 * b, fwd: (RELAXED_ARM_L.fwd ?? 0) + 1.5 * w, elbow: (RELAXED_ARM_L.elbow ?? 0) + 2 * b };
        const armR: ArmSpec = { ...RELAXED_ARM_R, raise: RELAXED_ARM_R.raise + clr + 1.2 * b + 2 * roll, fwd: (RELAXED_ARM_R.fwd ?? 0) - 1.5 * w - 3 * rollBack, elbow: (RELAXED_ARM_R.elbow ?? 0) + 2 * b };
        Object.assign(rot, armPose(armL, 'L'), armPose(armR, 'R'));
        frames.push({ hipsT, hipsQ, rot });
    }
    return toClip(LOCOMOTION_CLIP.idle, rig, frames, true);
}

/** Build every default locomotion clip for a skeleton's joints (skips joints the rig lacks; [] for a non-humanoid rig),
 *  in DEFAULT_LOCOMOTION_CLIP_NAMES order: Walk, Run, Sneak, Stroll (gaits with `groundSpeed`), Crouch, the jump
 *  variants (JUMP_VARIANT_CLIPS, each with its wind-up `takeoffPhase` and `jumpVariant` pick weights), Fall, Land /
 *  Land Deep / Land Soft, Stand (the Play idle), Stomp and Jog (2026-10-04). `opts.armClearance` raises every arm pose for this body
 *  (playArmClearance); `opts.variation` seeds the walking personality. */
export function buildLocomotionClips(joints: Joint[], opts: LocomotionClipOptions = {}): SkeletonAnimClip[] {
    const rig = measureRig(joints);
    const clr = Math.max(0, Math.min(30, Number.isFinite(opts.armClearance) ? opts.armClearance! : 0));
    const pers = opts.variation !== undefined && opts.variation !== null && opts.variation !== '' ? gaitPersonality(opts.variation) : null;
    const gait = (g: GaitSpec) => buildGait(pers ? varyGait(g, pers) : g, rig, clr);
    const out = [
        gait(WALK), gait(RUN), gait(SNEAK), gait(STROLL), buildCrouch(rig, clr),
        ...buildJumps(rig, clr), buildFall(rig, clr),
        ...LANDS.map((l) => buildLand(rig, l)), buildStand(rig, clr), gait(STOMP), gait(JOG),
    ];
    return out.filter((c): c is SkeletonAnimClip => !!c);
}

/** Thigh pitch (deg, − = forward) and knee flex (deg, +) of one leg at cycle phase p ∈ [0,1) (0 = heel strike), from
 *  the solved gait on the procedural rig (tests / diagnostics). */
export function legAngles(g: GaitSpec, p: number, joints?: Joint[]): { thigh: number; knee: number } {
    const rig = measureRig(joints ?? DEFAULT_RIG_JOINTS);
    const n = Math.max(8, Math.round(g.period * FPS));
    const frames = sampleGait(g, rig, n);
    const f = frames[Math.round(((p % 1) + 1) % 1 * n) % n];
    const up = f.rot.upperleg_L, lo = f.rot.lowerleg_L;
    return { thigh: deg(2 * Math.atan2(up[0], up[3])), knee: deg(2 * Math.atan2(lo[0], lo[3])) };
}

/** The procedural rig's leg chain (body-generator JOINTS) — the default for legAngles. */
const DEFAULT_RIG_JOINTS: Joint[] = [
    { name: 'hips', localPosition: [0, 0.9, 0] },
    { name: 'upperleg_L', localPosition: [0.045, -0.14, 0] }, { name: 'lowerleg_L', localPosition: [0, -0.42, 0] }, { name: 'foot_L', localPosition: [0, -0.42, 0] },
    { name: 'upperleg_R', localPosition: [-0.045, -0.14, 0] }, { name: 'lowerleg_R', localPosition: [0, -0.42, 0] }, { name: 'foot_R', localPosition: [0, -0.42, 0] },
];

/** Exposed for tests. */
export const LOCOMOTION_GAITS = { walk: WALK, run: RUN, sneak: SNEAK, stroll: STROLL, stomp: STOMP, jog: JOG } as const;
