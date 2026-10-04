/**
 * locomotion-pose.ts — turn the LocomotionAnimator's weighted layers into ONE skeleton pose (the per-tick composition
 * Scene3DManager._driveLocomotionAnimator runs in Play), plus the procedural lean on top. Pure, so the gait preview
 * report (gait-preview.test.ts) renders exactly what Play draws (visual-polish item 13).
 */
import type { SkeletonAnimClip } from '../../types/armature-3d';
import { sampleClipPose, blendPoses, addPoseMasked, type SkeletonPose } from '../../renderer/3d/skeleton-animator';
import { blendWeighted, type LocoAnimLayer, type LeanOutput, type SecondaryOutput, type SecondaryInput, type LocomotionAnimator } from '../../game/locomotion-animator';
import { LOCOMOTION_GAITS } from './default-locomotion';

/** Sample each layer's clip at its phase against `rest`, blend the normal layers (weights sum to 1) and add the
 *  additive ones (landing) on top. Layers whose clip `clipFor` can't find are skipped; no layer → a copy of `rest`. */
export function composeLocomotionPose(layers: LocoAnimLayer[], clipFor: (name: string) => SkeletonAnimClip | null, rest: SkeletonPose): SkeletonPose {
    const items: { value: SkeletonPose; weight: number }[] = [];
    const additive: { pose: SkeletonPose; ref: SkeletonPose; weight: number }[] = [];
    for (const l of layers) {
        const c = clipFor(l.clip);
        if (!c) continue;
        const sp = sampleClipPose(c, rest, c.startFrame + l.phase * (c.endFrame - c.startFrame));
        // An additive layer is a delta from its OWN first frame (item 13): against the rig's rest instead, a track the
        // clip authors at identity (Land's shoulders) "undid" the relaxed stance — the arms flew up to a T on landing.
        if (l.additive) additive.push({ pose: sp, ref: sampleClipPose(c, rest, c.startFrame), weight: l.weight });
        else items.push({ value: sp, weight: l.weight });
    }
    let pose = blendWeighted(items, blendPoses) ?? {
        rotations: rest.rotations.map((r) => [...r] as [number, number, number, number]),
        positions: rest.positions.map((p) => [...p] as [number, number, number]),
        scales: rest.scales.map((v) => [...v] as [number, number, number]),
    };
    if (additive.length) {
        const all = rest.rotations.map((_, i) => i);
        for (const a of additive) pose = addPoseMasked(pose, a.pose, a.ref, a.weight, all);
    }
    return pose;
}

/** Layer the procedural lean (LocomotionLean) onto a pose of the engine's own humanoid rig: parent-frame turns on
 *  spine / chest / neck / head (their rest rotations are identity, so an axis turn means what it says). In place. */
/** Pre-multiply joint i's local rotation by an axis turn (deg) in its PARENT frame. In place. */
function turnJoint(pose: SkeletonPose, i: number, axis: 'x' | 'y' | 'z', deg: number): void {
    if (i < 0 || !deg) return;
    const h = (deg * Math.PI) / 360, sn = Math.sin(h), cs = Math.cos(h);
    const a: [number, number, number, number] = [axis === 'x' ? sn : 0, axis === 'y' ? sn : 0, axis === 'z' ? sn : 0, cs];
    const q = pose.rotations[i];
    pose.rotations[i] = [
        a[3] * q[0] + a[0] * q[3] + a[1] * q[2] - a[2] * q[1],
        a[3] * q[1] - a[0] * q[2] + a[1] * q[3] + a[2] * q[0],
        a[3] * q[2] + a[0] * q[1] - a[1] * q[0] + a[2] * q[3],
        a[3] * q[3] - a[0] * q[0] - a[1] * q[1] - a[2] * q[2],
    ];
}

export function applyLocomotionLean(jointNames: readonly string[], pose: SkeletonPose, lean: LeanOutput): void {
    if (Math.abs(lean.pitch) + Math.abs(lean.roll) + Math.abs(lean.headYaw) + Math.abs(lean.chestYaw) < 0.05) return;
    const turn = (i: number, axis: 'x' | 'y' | 'z', deg: number) => turnJoint(pose, i, axis, deg);
    const spine = jointNames.indexOf('spine'), chest = jointNames.indexOf('chest'), head = jointNames.indexOf('head'), neck = jointNames.indexOf('neck');
    turn(spine, 'x', lean.pitch * 0.6); turn(chest, 'x', lean.pitch * 0.4);
    turn(neck, 'x', -lean.pitch * 0.5);                                   // keep the eyes up
    turn(spine, 'z', lean.roll * 0.55); turn(chest, 'z', lean.roll * 0.45);
    turn(chest, 'y', lean.chestYaw); turn(head, 'y', lean.headYaw - lean.chestYaw);
}

/** Layer the SECONDARY motion (LocomotionSecondary: per-cycle arm variation, the upper-body follow-through, the head
 *  drift) onto a pose of the engine's own humanoid rig. The arm swing is a turn about the shoulder's parent X — the
 *  same axis the clips swing the arm on (pose-authoring armPose: forward = −X), so it scales the swing, never twists
 *  it. In place. */
export function applyLocomotionSecondary(jointNames: readonly string[], pose: SkeletonPose, s: SecondaryOutput): void {
    const ix = (n: string) => jointNames.indexOf(n);
    turnJoint(pose, ix('shoulder_L'), 'x', -s.armL);
    turnJoint(pose, ix('shoulder_R'), 'x', -s.armR);
    turnJoint(pose, ix('chest'), 'x', s.chestPitch);
    turnJoint(pose, ix('neck'), 'x', s.neckPitch);
    turnJoint(pose, ix('head'), 'y', s.headYaw);
    turnJoint(pose, ix('head'), 'x', s.headPitch);
}

/** The secondary-motion input for this tick from the animator's state (the same in Play and the gait preview): the
 *  gait phase, how much the gait plays, the blended default gaits' arm-swing amplitude and arm lag. */
export function secondaryInputFor(anim: LocomotionAnimator, accel: number, grounded: boolean): SecondaryInput {
    const G = LOCOMOTION_GAITS, r = anim.runMix, st = anim.strollMix, cr = anim.crouchMix, jm = anim.jogMix;
    const walkish = G.walk.arm * (1 - st) + G.stroll.arm * st;
    const runish = G.run.arm * (1 - jm) + G.jog.arm * jm, runLag = G.run.armLag * (1 - jm) + G.jog.armLag * jm;
    const amp = (walkish * (1 - r) + runish * r) * (1 - cr) + G.sneak.arm * cr;
    const lag = (G.walk.armLag * (1 - st) + G.stroll.armLag * st) * (1 - r) + runLag * r;
    return { phase: anim.gaitPhase, moveWeight: anim.weights.move, armAmp: amp, armLag: lag, accel, grounded };
}
