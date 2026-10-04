/**
 * IDLE VARIANTS (Play polish, 2026-10-04; docs/ui/play-mode.md §Landing dust + idle variety) — one-shot standing idles
 * the engine locomotion animator plays now and then over the runtime Stand idle (LocomotionClips.idles, played by
 * IdleVariantScheduler: seeded, never the same one twice running, eased in / out, cancelled at once by any movement).
 *
 * Runtime-only like the rest of default-locomotion.ts (never written to a document). Every variant:
 *  - starts and ends EXACTLY in the neutral Stand pose (the Stand idle at its centred weight: the same leg IK, the same
 *    relaxed arms raised by the body's arm clearance), so its crossfades never pop;
 *  - authors its arms in human terms through pose-authoring.ts (raise / forward / twist / elbow / wrist) on top of the
 *    relaxed stance + `armClearance` (the body + outfit fit), verified with the pose preview report
 *    (POSE_PREVIEW=out npx vitest run src/services/managers/pose-preview.test.ts → idle-variant PNGs);
 *  - keeps the feet planted (both legs solved by the gait IK every frame; the foot tap only pitches the toes);
 *  - carries an optional faceTrack (gaze / blink / face-kit expression) the Play driver fires as the variant plays.
 *
 * Variants: Look Around, Stretch, Check Wrist, Foot Tap (a weight shift + a toe tap), and Adjust Glasses (only for a
 * character wearing a glasses charm).
 */

import type { ClipFaceEvent, SkeletonAnimClip } from '../../types/armature-3d';
import { armPose, qAxis, qMul, RELAXED_ARM_L, RELAXED_ARM_R, relaxedStance, type ArmSpec, type Quat } from './pose-authoring';
import { measureRig, qRot, solveLeg, toClip, type Joint, type Rig } from './default-locomotion';

type V3 = [number, number, number];
const FPS = 30;

export const IDLE_VARIANT_CLIP = {
    lookAround: 'Idle Look Around', stretch: 'Idle Stretch', checkWrist: 'Idle Check Wrist', footTap: 'Idle Foot Tap', glasses: 'Idle Adjust Glasses',
} as const;
/** Every idle variant name (the glasses one is only built for a glasses wearer). */
export const IDLE_VARIANT_CLIPS: string[] = Object.values(IDLE_VARIANT_CLIP);

export interface IdleVariantOptions {
    /** Extra sideways arm raise (deg) for this body + outfit (playArmClearance), as for the Stand idle. */
    armClearance?: number;
    /** The character wears glasses (a glasses / wireglasses / sunglasses charm): adds Adjust Glasses. */
    glasses?: boolean;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const smoother = (x: number) => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };
/** 0 before a, eases to 1 by b (a small overshoot with `back`), holds to c, eases back to 0 by d. */
function pulse(t: number, a: number, b: number, c: number, d: number, back = 0): number {
    if (t <= a || t >= d) return 0;
    if (t < b) { const u = (t - a) / (b - a); return smooth(u) + back * Math.sin(Math.PI * u) * u; }
    if (t <= c) return 1;
    return 1 - smoother((t - c) / (d - c));
}
const add = (a: ArmSpec, d: Partial<ArmSpec>, k: number): ArmSpec => ({
    raise: a.raise + (d.raise ?? 0) * k, fwd: (a.fwd ?? 0) + (d.fwd ?? 0) * k, twist: (a.twist ?? 0) + (d.twist ?? 0) * k,
    elbow: (a.elbow ?? 0) + (d.elbow ?? 0) * k, wrist: (a.wrist ?? 0) + (d.wrist ?? 0) * k, wristDev: (a.wristDev ?? 0) + (d.wristDev ?? 0) * k,
});

/** What a variant authors at time t (seconds): torso / head joints, arm specs, a weight shift (+1 = onto the left leg)
 *  and the right foot's toe pitch (deg, − = toes up). Missing = neutral. */
interface VariantFrame {
    rot?: Record<string, Quat>;
    armL?: ArmSpec; armR?: ArmSpec;
    shift?: number;
    toeR?: number;
    clavL?: number; clavR?: number;   // extra clavicle lift (deg, + = up)
}
interface VariantSpec { name: string; dur: number; frame: (t: number, L: ArmSpec, R: ArmSpec) => VariantFrame; face?: (Omit<ClipFaceEvent, 'frame'> & { t: number })[]; }

// Arm targets (as the LEFT arm, deltas over the relaxed + clearance arm; mirrored for the right by armPose).
/** Stretch: both arms forward and up over the head (forward of the face, so the upper arms pass in front of the ears). */
const STRETCH_D: Partial<ArmSpec> = { raise: 10, fwd: 150, twist: -10, elbow: -2, wrist: -10 };
/** Check wrist (LEFT arm): the forearm comes up across the front of the chest, wrist toward the face. */
const WRIST_D: Partial<ArmSpec> = { raise: -4, fwd: 32, twist: 34, elbow: 88, wrist: -14 };
/** Adjust glasses (RIGHT arm, authored as left): the hand up to the bridge of the nose. */
const GLASSES_D: Partial<ArmSpec> = { raise: -4, fwd: 92, twist: 32, elbow: 126, wrist: 6 };

const SPECS: VariantSpec[] = [
    {
        // Look round to the left, then the right, and back: the eyes lead, the head turns with a small overshoot, the
        // neck and chest follow late. A blink on each new direction.
        name: IDLE_VARIANT_CLIP.lookAround, dur: 4.4,
        frame: (t) => {
            const l = pulse(t, 0.3, 0.85, 1.5, 2.0, 0.3), r = pulse(t, 1.95, 2.55, 3.2, 3.95, 0.3);
            const ll = pulse(t, 0.45, 1.05, 1.6, 2.15), rl = pulse(t, 2.1, 2.75, 3.3, 4.1);
            const yaw = 30 * l - 34 * r, late = 30 * ll - 34 * rl;
            return {
                rot: {
                    head: qMul(qAxis('y', yaw * 0.72), qAxis('x', -3 * (l + r) + 1)),
                    neck: qAxis('y', late * 0.22), chest: qAxis('y', late * 0.12), spine: qAxis('y', late * 0.05),
                },
                shift: 0.25 * (ll - rl),
            };
        },
        face: [
            { t: 0.3, blink: true }, { t: 0.32, gaze: [-0.45, -0.05] },
            { t: 1.95, blink: true }, { t: 1.97, gaze: [0.5, -0.05] },
            { t: 3.6, restore: true },
        ],
    },
    {
        // A big stretch: arms forward and up over the head, the chest arching back, up a little, a yawn on the face kit.
        name: IDLE_VARIANT_CLIP.stretch, dur: 4.2,
        frame: (t, L, R) => {
            const k = pulse(t, 0.25, 1.35, 2.35, 3.7, 0.12), late = pulse(t, 0.45, 1.6, 2.45, 3.9);
            return {
                armL: add(L, STRETCH_D, k), armR: add(R, { ...STRETCH_D, fwd: STRETCH_D.fwd! - 6 }, late * 0.97 + k * 0.03),
                rot: {
                    chest: qAxis('x', -7 * late), spine: qAxis('x', -4 * k), lowerback: qAxis('x', -2 * k),
                    neck: qAxis('x', 3 * late), head: qAxis('x', -6 * late),
                },
                clavL: 9 * k, clavR: 9 * late,
            };
        },
        face: [{ t: 0.9, expression: 'open', weight: 0.7 }, { t: 1.2, blink: true }, { t: 2.6, restore: true }],
    },
    {
        // Check the watch on the left wrist: the arm comes up, the head dips and turns to it, a glance, back down.
        name: IDLE_VARIANT_CLIP.checkWrist, dur: 3.4,
        frame: (t, L) => {
            const k = pulse(t, 0.2, 0.9, 2.1, 2.9, 0.08), h = pulse(t, 0.45, 1.05, 2.0, 2.75);
            return {
                armL: add(L, WRIST_D, k),
                rot: { head: qMul(qAxis('y', 12 * h), qAxis('x', 18 * h)), neck: qAxis('x', 7 * h), chest: qAxis('y', 3 * k) },
                clavL: 3 * k, shift: -0.2 * k,
            };
        },
        face: [{ t: 0.8, gaze: [-0.2, 0.55] }, { t: 1.6, blink: true }, { t: 2.3, restore: true }],
    },
    {
        // Weight onto the left leg, then the right toes tap three times (the heel stays down), and the weight comes back.
        name: IDLE_VARIANT_CLIP.footTap, dur: 4.2,
        frame: (t, L, R) => {
            const s = pulse(t, 0.1, 0.8, 3.3, 4.0);
            const tapT = (t - 1.0) / 0.42, tapOn = t > 1.0 && t < 1.0 + 3 * 0.42;
            const tap = tapOn ? Math.pow(Math.sin(Math.PI * (tapT % 1)), 2) : 0;
            return {
                shift: s, toeR: -16 * tap * s,
                armL: add(L, { fwd: 2, elbow: 4 }, s), armR: add(R, { fwd: -2, raise: 1 }, s),
                rot: { head: qMul(qAxis('z', 2.5 * s), qAxis('x', 4 * s)) },
            };
        },
        face: [{ t: 1.0, gaze: [0, 0.3] }, { t: 2.6, restore: true }],
    },
    {
        // Push the glasses back up the nose with the right hand.
        name: IDLE_VARIANT_CLIP.glasses, dur: 2.8,
        frame: (t, _L, R) => {
            const k = pulse(t, 0.15, 0.85, 1.35, 2.3, 0.06), push = pulse(t, 0.85, 1.05, 1.15, 1.35);
            return {
                armR: add(R, { ...GLASSES_D, wrist: GLASSES_D.wrist! + 8 * push, raise: GLASSES_D.raise! + 2 * push }, k),
                rot: { head: qAxis('x', 5 * k - 3 * push), neck: qAxis('x', 2 * k) },
                clavR: 4 * k,
            };
        },
        face: [{ t: 0.95, blink: true }, { t: 1.1, browRaise: 0.35 }, { t: 2.2, restore: true }],
    },
];

/** The neutral Stand frame + a variant's frame at t → joint rotations + hips translation. */
function poseAt(rig: Rig, f: VariantFrame, L: ArmSpec, R: ArmSpec): { hipsT?: V3; rot: Record<string, Quat> } {
    const hipsRest = rig.hipsRest ?? [0, 0, 0];
    const relaxed = relaxedStance();
    const w = Math.max(-1, Math.min(1, f.shift ?? 0));
    // The weight shift exactly as the Stand idle does it (pelvis slide + tilt over the standing foot, legs by IK).
    const tilt = 2.4 * w;
    const hipsQ = qMul(qAxis('y', -1.2 * w), qAxis('z', tilt));
    const sway = 0.02 * rig.L * w, drop = 0.006 * rig.L * Math.abs(w);
    const hipsT: V3 = [hipsRest[0] + sway, hipsRest[1] - drop, hipsRest[2]];
    const rot: Record<string, Quat> = { hips: hipsQ };
    for (const side of ['L', 'R'] as const) {
        const off = qRot(hipsQ, rig.hipOff[side]);
        const hip: V3 = [sway + off[0], -drop + off[1], off[2]];
        const sgn = Math.sign(rig.hipOff[side][0]);
        const free = (side === 'L' ? -w : w) > 0;
        const ax = rig.hipOff[side][0] + sgn * 0.018 * rig.L, az = free ? 0.02 * rig.L * Math.abs(w) : -0.004 * rig.L;
        const toe = side === 'R' ? (f.toeR ?? 0) : 0;
        // A toe tap pivots on the heel: the ankle rises by heel-length × sin(pitch) so the heel stays on the ground.
        const ay = rig.groundY + (toe < 0 ? rig.lh * Math.sin(-toe * Math.PI / 180) : 0);
        const leg = solveLeg(rig, hipsQ, hip, [ax, ay, az], toe);
        rot[`upperleg_${side}`] = leg.upper; rot[`lowerleg_${side}`] = leg.lower; rot[`foot_${side}`] = leg.foot;
    }
    // The lumbar counters the pelvis tilt (the shoulders stay level), as in Stand.
    const extra = f.rot ?? {};
    const mul = (a: Quat, b: Quat | undefined) => (b ? qMul(a, b) : a);
    rot.lowerback = mul(qAxis('z', -tilt * 0.8), extra.lowerback);
    rot.spine = mul(qAxis('z', -tilt * 0.15), extra.spine);
    rot.chest = extra.chest ?? [0, 0, 0, 1];
    rot.neck = extra.neck ?? [0, 0, 0, 1];
    rot.head = mul(qAxis('z', 1.5 * w), extra.head);
    rot.clavicle_L = qMul(relaxed.clavicle_L, qAxis('z', f.clavL ?? 0));
    rot.clavicle_R = qMul(relaxed.clavicle_R, qAxis('z', -(f.clavR ?? 0)));
    Object.assign(rot, armPose(f.armL ?? L, 'L'), armPose(f.armR ?? R, 'R'));
    return { hipsT, rot };
}

/** Build the idle variant clips for a skeleton's joints ([] for a non-humanoid rig). One-shots (loop false), each
 *  starting and ending in the neutral Stand pose. */
export function buildIdleVariantClips(joints: Joint[], opts: IdleVariantOptions = {}): SkeletonAnimClip[] {
    const rig = measureRig(joints);
    if (!rig.idx.has('upperleg_L') || !rig.idx.has('shoulder_L')) return [];
    const clr = Math.max(0, Math.min(30, Number.isFinite(opts.armClearance) ? opts.armClearance! : 0));
    const L: ArmSpec = { ...RELAXED_ARM_L, raise: RELAXED_ARM_L.raise + clr };
    const R: ArmSpec = { ...RELAXED_ARM_R, raise: RELAXED_ARM_R.raise + clr };
    const out: SkeletonAnimClip[] = [];
    for (const s of SPECS) {
        if (s.name === IDLE_VARIANT_CLIP.glasses && !opts.glasses) continue;
        const n = Math.max(2, Math.round(s.dur * FPS));
        const frames: { hipsT?: V3; rot: Record<string, Quat> }[] = [];
        for (let i = 0; i <= n; i++) frames.push(poseAt(rig, s.frame((i / n) * s.dur, L, R), L, R));
        const faceTrack = s.face?.map(({ t, ...e }): ClipFaceEvent => ({ frame: Math.max(0, Math.min(n, Math.round(t * FPS))), ...e }));
        const clip = toClip(s.name, rig, frames, false, faceTrack?.length ? { faceTrack } : undefined);
        if (clip) out.push(clip);
    }
    return out;
}

/** Attachment types that count as glasses for Adjust Glasses. */
export const GLASSES_CHARMS = ['glasses', 'wireglasses', 'sunglasses'];
