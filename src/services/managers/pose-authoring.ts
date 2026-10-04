/**
 * pose-authoring.ts — author procedural-rig arm poses in human terms instead of raw quaternions (pose & animation
 * audit 2026-09-28). The old presets were hand-typed axis quats ("first guesses — verify in-app"), and several were
 * plainly wrong when finally rendered: Wave crossed over the head, Thinking's hand sat beside the head, Hand Behind
 * Head / Scratch Head buried the hand ~3–6 cm inside the skull, Stretch drove the arms through the ears.
 *
 * Rig facts (body-generator JOINTS): arms rest straight out along ±X (T-pose); the elbow is a hinge about the forearm's
 * local Y (LEFT flexes −Y, i.e. toward the front at twist 0); the palm faces −Y at rest. Everything is authored for
 * the LEFT arm and MIRRORED for the right ([x,y,z,w] → [x,−y,−z,w]), so the two sides can never disagree.
 *
 * Verify any change with the pose preview report (renders + self-intersection):
 *   POSE_PREVIEW=out npx vitest run src/services/managers/pose-preview.test.ts
 */

export type Quat = [number, number, number, number];

/** Axis rotation in degrees, [x,y,z,w] (body-generator convention). */
export const qAxis = (axis: 'x' | 'y' | 'z', deg: number): Quat => {
    const h = (deg * Math.PI) / 360, s = Math.sin(h);
    return [axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0, Math.cos(h)];
};
/** a*b — applies b first, then a. */
export const qMul = (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** Mirror a LEFT-side local rotation to the right side (across the body's X symmetry plane). */
export const mirrorQ = (q: readonly number[]): Quat => [q[0], -q[1], -q[2], q[3]];

/** One arm, in degrees, as the LEFT arm (the right is mirrored). */
export interface ArmSpec {
    /** Upper arm raised SIDEWAYS from hanging straight down: 0 = down, 90 = T-pose, 180 = straight up. */
    raise: number;
    /** Swing FORWARD (+) / back (−) about the body's left-right axis, applied after `raise`. */
    fwd?: number;
    /** Roll of the upper arm about its own axis. With the arm down, + turns the elbow crease forward/in (forearm
     *  comes across the front of the thigh); − turns it out. With the arm raised sideways, −90 makes the elbow bend
     *  UP (wave), +90 DOWN. */
    twist?: number;
    /** Elbow flex (0 = straight). */
    elbow?: number;
    /** Wrist flex (+ palm-ward) and side deviation. */
    wrist?: number;
    wristDev?: number;
}

/** Local rotations for shoulder_/lowerarm_/hand_ of `side`. Order: twist (innermost) → raise → forward. */
export function armPose(spec: ArmSpec, side: 'L' | 'R'): Record<string, Quat> {
    const sh = qMul(qAxis('x', -(spec.fwd ?? 0)), qMul(qAxis('z', spec.raise - 90), qAxis('x', spec.twist ?? 0)));
    const el = qAxis('y', -(spec.elbow ?? 0));
    const hd = qMul(qAxis('z', -(spec.wrist ?? 0)), qAxis('y', spec.wristDev ?? 0));
    if (side === 'L') return { shoulder_L: sh, lowerarm_L: el, hand_L: hd };
    return { shoulder_R: mirrorQ(sh), lowerarm_R: mirrorQ(el), hand_R: mirrorQ(hd) };
}

/** Both arms: `left` for the left, `right` (default = `left`) mirrored onto the right. */
export function armsPose(left: ArmSpec, right: ArmSpec = left): Record<string, Quat> {
    return { ...armPose(left, 'L'), ...armPose(right, 'R') };
}

/** Clavicle drop (deg, + lowers the shoulder) for both sides — relaxed shoulders instead of a squared "coat hanger". */
export function claviclesPose(dropL: number, dropR: number = dropL): Record<string, Quat> {
    return { clavicle_L: qAxis('z', -dropL), clavicle_R: mirrorQ(qAxis('z', -dropR)) };
}

// ── The shared stances ───────────────────────────────────────────────────────────────────────────────────────────
/** RELAXED standing arms (the default stance every new character + the idle start from): arms hang ~20° out so they
 *  clear the hips, a touch forward, elbow crease turned in so the forearms come slightly across the front of the
 *  thighs, soft elbows, relaxed wrists — and deliberately a little ASYMMETRIC (the right elbow softer), which is what
 *  stops a standing figure reading as a mannequin. Shoulders dropped a few degrees. Measured clean (0 verts into the
 *  torso besides the body's own armpit crease). */
export const RELAXED_ARM_L: ArmSpec = { raise: 21.5, fwd: 0, twist: 18, elbow: 8, wrist: 5 };
export const RELAXED_ARM_R: ArmSpec = { raise: 21, fwd: 1, twist: 15, elbow: 11, wrist: 7 };   // round 3: was fwd 5 / elbow 20 — the forearm jutted forward in side view (user)
export const RELAXED_CLAVICLE_DROP: [number, number] = [6, 5];
export function relaxedStance(): Record<string, Quat> {
    return { ...armsPose(RELAXED_ARM_L, RELAXED_ARM_R), ...claviclesPose(...RELAXED_CLAVICLE_DROP) };
}

/**
 * CONTRAPPOSTO — weight onto one leg, feet planted. The pelvis tips (the standing leg's hip up, the free hip drops), the
 * thighs COUNTER-rotate by exactly the pelvis tilt so the legs keep their world direction (rotating the root 'hips'
 * alone would swing both feet sideways — legs hang off it), the free knee softens with the foot kept flat, and the
 * lumbar counters most of the tilt so the torso stays upright — the shoulders end up tilting opposite the hips, which is
 * what reads as a relaxed, weighted stance. `deg` = pelvis tilt (3–5 is natural). Pure local rotations.
 */
export function weightShift(onto: 'L' | 'R', deg: number): Record<string, Quat> {
    const s = onto === 'L' ? 1 : -1, free = onto === 'L' ? 'R' : 'L';
    const tilt = qAxis('z', s * deg), undo = qAxis('z', -s * deg);
    const k = Math.min(1.5, deg / 4);                                              // the free-knee soften scales with the shift
    return {
        hips: tilt,
        lowerback: qAxis('z', -s * deg * 0.85),
        [`upperleg_${onto}`]: undo,
        [`upperleg_${free}`]: qMul(undo, qAxis('x', -3 * k)),                     // free thigh a touch forward…
        [`lowerleg_${free}`]: qAxis('x', 7 * k),                                   // …knee soft…
        [`foot_${free}`]: qAxis('x', -4 * k),                                      // …sole kept flat
    };
}
/** The rest (unshifted) value of every joint weightShift drives. */
export const WEIGHT_JOINTS = ['hips', 'lowerback', 'upperleg_L', 'upperleg_R', 'lowerleg_L', 'lowerleg_R', 'foot_L', 'foot_R'] as const;

/** Waving arm (authored as LEFT, used mirrored on the right): elbow about shoulder height and a little in front, the
 *  forearm up, the hand bent back, palm out. (Round 2, 2026-09-28: was raise 105 / fwd 12 — stiff, arm-only.) */
export const WAVE_ARM: ArmSpec = { raise: 80, fwd: 30, twist: -70, elbow: 95, wrist: -15 };
/** The rest of the body in a (right-hand) wave: head tips toward the waving hand and turns to "whoever", the chest
 *  turns + leans away, the lumbar shifts, the right shoulder lifts. The whole body waves, not just the arm. */
export function waveBody(): Record<string, Quat> {
    return {
        head: qMul(qAxis('z', -7), qMul(qAxis('y', -10), qAxis('x', -4))), neck: qAxis('z', -3),
        chest: qMul(qAxis('z', 3), qAxis('y', -6)),
        clavicle_R: mirrorQ(qAxis('z', 10)),
        ...weightShift('L', 4),                                                   // weight onto the far leg
        ...armPose({ raise: 22, fwd: 4, twist: 26, elbow: 18, wrist: 8 }, 'L'),   // the other arm hangs a little softer
    };
}
