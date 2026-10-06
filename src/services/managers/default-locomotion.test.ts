import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { buildLocomotionClips, legAngles, LOCOMOTION_GAITS, LOCOMOTION_CLIP, landEnvelope, playArmClearance, DEFAULT_LOCOMOTION_CLIP_NAMES, JUMP_VARIANT_CLIPS, gaitPersonality, varyGait, applyWalkStyle, holdWarp, swingWarp } from './default-locomotion';
import type { SkeletonAnimClip } from '../../types/armature-3d';

const g = globalThis as { crypto?: unknown };
g.crypto ??= webcrypto;

type V3 = [number, number, number]; type Q = [number, number, number, number];
// The procedural rig (body-generator JOINTS): hips → upperleg (±0.045, −0.14) → lowerleg (−0.42) → foot (−0.42), + torso / arms.
const JOINTS = [
    { name: 'hips', localPosition: [0, 0.9, 0] as V3 },
    { name: 'upperleg_L', localPosition: [0.045, -0.14, 0] as V3 },
    { name: 'lowerleg_L', localPosition: [0, -0.42, 0] as V3 },
    { name: 'foot_L', localPosition: [0, -0.42, 0] as V3 },
    { name: 'upperleg_R', localPosition: [-0.045, -0.14, 0] as V3 },
    { name: 'lowerleg_R', localPosition: [0, -0.42, 0] as V3 },
    { name: 'foot_R', localPosition: [0, -0.42, 0] as V3 },
    { name: 'lowerback', localPosition: [0, 0.035, 0] as V3 }, { name: 'spine', localPosition: [0, 0.085, 0] as V3 },
    { name: 'chest', localPosition: [0, 0.18, 0] as V3 }, { name: 'neck', localPosition: [0, 0.16, 0] as V3 }, { name: 'head', localPosition: [0, 0.1, 0] as V3 },
    { name: 'clavicle_L', localPosition: [0.03, 0.06, 0] as V3 }, { name: 'shoulder_L', localPosition: [0.045, 0.015, 0] as V3 }, { name: 'lowerarm_L', localPosition: [0.27, 0, 0] as V3 }, { name: 'hand_L', localPosition: [0.23, 0, 0] as V3 },
    { name: 'clavicle_R', localPosition: [-0.03, 0.06, 0] as V3 }, { name: 'shoulder_R', localPosition: [-0.045, 0.015, 0] as V3 }, { name: 'lowerarm_R', localPosition: [-0.27, 0, 0] as V3 }, { name: 'hand_R', localPosition: [-0.23, 0, 0] as V3 },
];
const idx = (n: string) => JOINTS.findIndex((j) => j.name === n);
const LB = 0.15, LH = 0.045, A0 = 0.07;          // the generator's foot rocker geometry for L = 0.84
const SOLE = 0.9 - 0.14 - 0.84 - A0;             // ground height (rest sole)

const qmul = (a: Q, b: Q): Q => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const rot = (q: Q, v: V3): V3 => { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [p[0], p[1], p[2]]; };
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function sample(clip: SkeletonAnimClip, joint: string, channel: 'rotation' | 'translation', f: number): number[] | undefined {
    return clip.tracks.find((t) => t.jointIndex === idx(joint) && t.channel === channel)?.keyframes.find((k) => k.frame === f)?.value;
}
/** Foot FK at frame f: ankle, heel and ball points (rig space, in place) + the knee flex. */
function footFK(clip: SkeletonAnimClip, side: 'L' | 'R', f: number) {
    const hipsT = (sample(clip, 'hips', 'translation', f) ?? JOINTS[0].localPosition) as V3;
    const hipsR = (sample(clip, 'hips', 'rotation', f) ?? [0, 0, 0, 1]) as Q;
    const uR = qmul(hipsR, sample(clip, `upperleg_${side}`, 'rotation', f) as Q);
    const lq = sample(clip, `lowerleg_${side}`, 'rotation', f) as Q;
    const lR = qmul(uR, lq);
    const fR = qmul(lR, sample(clip, `foot_${side}`, 'rotation', f) as Q);
    const knee = add(add(hipsT, rot(hipsR, JOINTS[idx(`upperleg_${side}`)].localPosition)), rot(uR, JOINTS[idx(`lowerleg_${side}`)].localPosition));
    const ankle = add(knee, rot(lR, JOINTS[idx(`foot_${side}`)].localPosition));
    return { ankle, heel: add(ankle, rot(fR, [0, -A0, -LH])), ball: add(ankle, rot(fR, [0, -A0, LB])), knee: 2 * Math.atan2(lq[0], lq[3]) * 180 / Math.PI, footQ: fR };
}

describe('default locomotion clips (Round 8 gait model)', () => {
    const clips = buildLocomotionClips(JOINTS);
    const clip = (n: string) => clips.find((c) => c.name === n)!;

    it('builds Walk / Run / Sneak / Stroll / Crouch / the jump variants / Fall / the Lands / Stand; gaits carry a ground speed', () => {
        expect(clips.map((c) => c.name)).toEqual(DEFAULT_LOCOMOTION_CLIP_NAMES);
        expect(DEFAULT_LOCOMOTION_CLIP_NAMES.slice(0, 5)).toEqual(['Walk', 'Run', 'Sneak', 'Stroll', 'Crouch']);
        expect(DEFAULT_LOCOMOTION_CLIP_NAMES).toContain('Jump');
        for (const n of ['Walk', 'Run', 'Sneak', 'Stroll']) {
            const c = clip(n);
            for (const j of ['upperleg_L', 'lowerleg_R', 'foot_L', 'shoulder_L', 'lowerarm_R', 'chest', 'hips', 'head']) {
                expect(c.tracks.some((t) => t.jointIndex === idx(j) && t.channel === 'rotation'), `${c.name} ${j}`).toBe(true);
            }
            expect(c.tracks.some((t) => t.jointIndex === idx('hips') && t.channel === 'translation')).toBe(true);
            expect(c.groundSpeed).toBeGreaterThan(0);
        }
        // Nominal speeds ≈ the authored m/s (1 rig unit = 1 m on this rig): walk ~1.6, run ~4.6, sneak ~1.0.
        expect(clip('Walk').groundSpeed!).toBeCloseTo(1.6, 1);
        expect(clip('Run').groundSpeed!).toBeCloseTo(4.6, 1);
        expect(clip('Sneak').groundSpeed!).toBeCloseTo(0.9, 1);
        expect(clip('Stroll').groundSpeed!).toBeCloseTo(0.85, 1);
        expect(clip('Run').groundSpeed! / clip('Walk').groundSpeed!).toBeGreaterThan(2.5);
    });

    it('loops seamlessly (last frame == first frame on every track of the cyclic clips)', () => {
        for (const n of ['Walk', 'Run', 'Sneak', 'Stroll', 'Crouch', 'Fall', 'Jog']) for (const t of clip(n).tracks) {
            const a = t.keyframes[0].value, b = t.keyframes[t.keyframes.length - 1].value;
            expect(t.keyframes[t.keyframes.length - 1].frame).toBe(clip(n).endFrame);
            a.forEach((v, i) => expect(Math.abs(b[i] - v), `${n}`).toBeLessThan(1e-6));
        }
    });

    it('feet are PLANTED: the grounded contact point never skates, and nothing sinks into the ground', () => {
        // The authored gaits AND two characters' varied ones (the personality changes stride / cadence / bounce).
        const varied = [...buildLocomotionClips(JOINTS, { variation: 'char-a' }), ...buildLocomotionClips(JOINTS, { variation: 'char-b' })];
        const cases: SkeletonAnimClip[] = [...['Walk', 'Run', 'Sneak', 'Stroll', 'Jog'].map(clip), ...varied.filter((k) => ['Walk', 'Run', 'Stroll', 'Jog'].includes(k.name))];
        for (const c of cases) {
            const n = c.name, v = c.groundSpeed! / c.fps;       // rig units of root motion per frame
            let worstSkate = 0, worstSink = 0;
            for (const side of ['L', 'R'] as const) {
                for (let f = 0; f < c.endFrame; f++) {
                    const a = footFK(c, side, f), b = footFK(c, side, f + 1);
                    for (const pt of ['heel', 'ball'] as const) {
                        worstSink = Math.max(worstSink, SOLE - a[pt][1]);
                        // A point on the ground in both frames must not move in the world (in-place z + root motion).
                        if (a[pt][1] - SOLE < 0.004 && b[pt][1] - SOLE < 0.004) worstSkate = Math.max(worstSkate, Math.abs((b[pt][2] + v) - a[pt][2]));
                    }
                }
            }
            expect(worstSkate, `${n} skate per frame`).toBeLessThan(0.006);
            expect(worstSink, `${n} sink`).toBeLessThan(0.008);
        }
    });

    it('a foot is on the ground for about its duty fraction; the RUN has flight phases, the walk double support', () => {
        const contact = (c: SkeletonAnimClip, side: 'L' | 'R', f: number) => { const k = footFK(c, side, f); return Math.min(k.heel[1], k.ball[1]) - SOLE < 0.01; };
        const frac = (n: string) => {
            const c = clip(n); let both = 0, none = 0, l = 0;
            for (let f = 0; f < c.endFrame; f++) { const a = contact(c, 'L', f), b = contact(c, 'R', f); if (a && b) both++; if (!a && !b) none++; if (a) l++; }
            return { both: both / c.endFrame, none: none / c.endFrame, l: l / c.endFrame };
        };
        const walk = frac('Walk'), run = frac('Run'), sneak = frac('Sneak');
        expect(walk.none).toBe(0); expect(walk.both).toBeGreaterThan(0.1);
        expect(run.none).toBeGreaterThan(0.2); expect(run.both).toBe(0);
        expect(sneak.none).toBe(0); expect(sneak.both).toBeGreaterThan(walk.both);
        expect(Math.abs(walk.l - LOCOMOTION_GAITS.walk.duty)).toBeLessThan(0.1);
    });

    it('knees never hyper-extend or lock; the swing foot clears the ground; the sneak crouches', () => {
        for (const n of ['Walk', 'Run', 'Sneak', 'Stroll', 'Crouch', 'Jog']) {
            const c = clip(n);
            for (let f = 0; f <= c.endFrame; f++) for (const side of ['L', 'R'] as const) {
                const k = footFK(c, side, f).knee;
                expect(k, `${n} f${f} ${side}`).toBeGreaterThan(4);
                expect(k, `${n} f${f} ${side}`).toBeLessThan(135);
            }
        }
        const lift = (n: string) => { const c = clip(n); let m = 0; for (let f = 0; f < c.endFrame; f++) for (const s of ['L', 'R'] as const) { const k = footFK(c, s, f); m = Math.max(m, Math.min(k.heel[1], k.ball[1]) - SOLE); } return m; };
        expect(lift('Walk')).toBeGreaterThan(0.05);
        expect(lift('Run')).toBeGreaterThan(lift('Walk') * 2);
        const hipsY = (n: string) => { const c = clip(n); let s = 0; for (let f = 0; f < c.endFrame; f++) s += (sample(c, 'hips', 'translation', f) as number[])[1]; return s / c.endFrame; };
        expect(0.9 - hipsY('Sneak')).toBeGreaterThan(0.1);        // crouched ≥ 10 cm
        expect(0.9 - hipsY('Crouch')).toBeGreaterThan(0.1);
        expect(0.9 - hipsY('Walk')).toBeLessThan(0.07);
        // Walk bob: a gentle few cm, peak to peak.
        const c = clip('Walk'); const ys = Array.from({ length: c.endFrame }, (_, f) => (sample(c, 'hips', 'translation', f) as number[])[1]);
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.015);
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.07);
    });

    it('legAngles: the legs swing in opposition (mirror phase)', () => {
        for (const gait of [LOCOMOTION_GAITS.walk, LOCOMOTION_GAITS.run]) {
            // 2026-10-04: at toe-off (the energetic run's stance is short; since the run-posture pass its pelvis is near
            // upright and the hip extends well behind, ~12° in the pelvis frame on the last stance frame).
            const a = legAngles(gait, 0.02), b = legAngles(gait, gait.duty);
            expect(a.thigh).toBeLessThan(-8);    // left leg forward at heel strike
            expect(b.thigh).toBeGreaterThan(5);  // … and extended behind at toe-off
        }
    });

    it('Land is an additive squash: rest at both ends, a dip in between; the envelope dips fast and recovers', () => {
        const c = clip(LOCOMOTION_CLIP.land);
        const y = (f: number) => (sample(c, 'hips', 'translation', f) as number[])[1];
        expect(y(0)).toBeCloseTo(0.9, 6); expect(y(c.endFrame)).toBeCloseTo(0.9, 6);
        expect(Math.min(...Array.from({ length: c.endFrame + 1 }, (_, f) => y(f)))).toBeLessThan(0.9 - 0.08);
        expect(landEnvelope(0.07)).toBeCloseTo(1, 6);
        expect(landEnvelope(0.42)).toBeCloseTo(0, 6);
        // Feet stay under the hips (the squash keeps the soles flat).
        const mid = footFK(c, 'L', 2);
        expect(Math.abs(mid.ankle[2])).toBeLessThan(0.01);
    });

    it('Jump tucks at the apex and reaches for the ground at air phase 1', () => {
        const c = clip(LOCOMOTION_CLIP.jump);
        const T = c.takeoffPhase ?? 0;
        const kneeAt = (a: number) => footFK(c, 'L', Math.round((T + (1 - T) * a) * c.endFrame)).knee;
        expect(kneeAt(0.5)).toBeGreaterThan(60);
        expect(kneeAt(1)).toBeLessThan(30);
    });

    it('item 13: Jump starts with a wind-up CROUCH (feet flat under the hips, pelvis down) before its take-off phase', () => {
        const c = clip(LOCOMOTION_CLIP.jump);
        expect(c.takeoffPhase).toBeGreaterThan(0.1);
        const f = Math.round(c.takeoffPhase! * c.endFrame) - 1;              // the deepest wind-up frame
        const y = (sample(c, 'hips', 'translation', f) as number[])[1];
        expect(y).toBeLessThan(0.9 - 0.1);                                    // ≈ 14 cm down
        const ft = footFK(c, 'L', f);
        expect(ft.knee).toBeGreaterThan(50);
        expect(Math.abs(ft.ankle[2])).toBeLessThan(0.03);                     // the ankle stays under the hip
        expect(Math.abs(ft.heel[1] - ft.ball[1])).toBeLessThan(0.02);         // sole flat
    });

    it('item 13: Stand (the Play idle) loops, keeps both feet planted and moves the pelvis only a little', () => {
        const c = clip(LOCOMOTION_CLIP.idle);
        expect(c.endFrame / c.fps).toBeGreaterThan(8);
        const tr = (f: number) => sample(c, 'hips', 'translation', f) as number[];
        expect(tr(0)).toEqual(tr(c.endFrame));                                // loops
        let dx = 0;
        for (let f = 0; f < c.endFrame; f += 6) {
            dx = Math.max(dx, Math.abs(tr(f)[0]));
            for (const s of ['L', 'R'] as const) {
                const ft = footFK(c, s, f);
                expect(Math.min(ft.heel[1], ft.ball[1]) - SOLE).toBeLessThan(0.012);   // on the ground
            }
        }
        expect(dx).toBeGreaterThan(0.008); expect(dx).toBeLessThan(0.03);     // a visible but subtle weight shift
    });

    it('item 13: armClearance raises every arm pose; playArmClearance takes the larger fitted side, capped', () => {
        const fitted = buildLocomotionClips(JOINTS, { armClearance: 12 });
        const sh = (cs: SkeletonAnimClip[], n: string) => sample(cs.find((k) => k.name === n)!, 'shoulder_L', 'rotation', 0) as number[];
        for (const n of ['Walk', 'Run', 'Sneak', 'Jump', 'Stand']) expect(sh(fitted, n)).not.toEqual(sh(clips, n));
        expect(playArmClearance({ L: 4, R: 9 })).toBe(9);
        expect(playArmClearance({ L: 80, R: 0 })).toBe(20);
        expect(playArmClearance({ L: NaN, R: -3 })).toBe(0);
    });

    it('drops joints a rig lacks and returns nothing for a non-humanoid rig', () => {
        expect(buildLocomotionClips([{ name: 'tail_1' }, { name: 'tail_2' }])).toEqual([]);
    });

    it.skipIf(!process.env.LOCO_PRINT)('prints gait diagnostics', () => {
        for (const n of ['Walk', 'Run', 'Sneak', 'Crouch']) {
            const c = clip(n);
            const rows: string[] = [];
            for (let f = 0; f < c.endFrame; f++) {
                const L = footFK(c, 'L', f), R = footFK(c, 'R', f);
                const h = sample(c, 'hips', 'translation', f) as number[];
                rows.push(`${String(f).padStart(2)} hipY ${(h[1] - 0.9).toFixed(3)} L ank z ${L.ankle[2].toFixed(3)} gy ${(Math.min(L.heel[1], L.ball[1]) - SOLE).toFixed(3)} knee ${L.knee.toFixed(0)} | R z ${R.ankle[2].toFixed(3)} gy ${(Math.min(R.heel[1], R.ball[1]) - SOLE).toFixed(3)} knee ${R.knee.toFixed(0)}`);
            }
            console.log(`${n} speed ${c.groundSpeed?.toFixed(2)} frames ${c.endFrame}\n${rows.join('\n')}`);
        }
    });
});

describe('jump variants + walking personality (2026-10-03)', () => {
    const clips = buildLocomotionClips(JOINTS);
    const clip = (n: string) => clips.find((c) => c.name === n)!;
    const atAir = (c: SkeletonAnimClip, a: number) => Math.round((JUMP_TAKEOFF_OF(c) + (1 - JUMP_TAKEOFF_OF(c)) * a) * c.endFrame);
    const JUMP_TAKEOFF_OF = (c: SkeletonAnimClip) => c.takeoffPhase ?? 0;
    const pitch = (c: SkeletonAnimClip, j: string, f: number) => { const q = sample(c, j, 'rotation', f) as Q; return 2 * Math.atan2(q[0], q[3]) * 180 / Math.PI; };
    /** World direction of the upper arm (shoulder → elbow) at frame f, chest frame (the clavicle offsets are tiny). */
    const armUp = (c: SkeletonAnimClip, side: 'L' | 'R', f: number) => {
        const cl = (sample(c, `clavicle_${side}`, 'rotation', f) ?? [0, 0, 0, 1]) as Q, sh = sample(c, `shoulder_${side}`, 'rotation', f) as Q;
        return rot(qmul(cl, sh), [side === 'L' ? 1 : -1, 0, 0]);
    };

    it('every variant is a jump clip: a take-off phase, pick weights, a wind-up crouch, a reach for the ground at air phase 1', () => {
        expect(JUMP_VARIANT_CLIPS.length).toBeGreaterThanOrEqual(5);
        for (const n of JUMP_VARIANT_CLIPS) {
            const c = clip(n);
            expect(c, n).toBeTruthy();
            expect(c.takeoffPhase, n).toBeGreaterThan(0.1);
            expect(c.jumpVariant, n).toBeTruthy();
            const f = Math.round(c.takeoffPhase! * c.endFrame) - 1;
            expect((sample(c, 'hips', 'translation', f) as number[])[1], `${n} crouches`).toBeLessThan(0.9 - 0.02);
            expect(footFK(c, 'L', atAir(c, 1)).knee, `${n} lands on soft knees`).toBeLessThan(50);
            expect(footFK(c, 'L', atAir(c, 1)).knee, `${n} lands on soft knees`).toBeGreaterThan(4);
            if (c.jumpVariant!.land) expect(clips.some((k) => k.name === c.jumpVariant!.land), `${n} land clip`).toBe(true);
        }
    });

    it('the variants are visibly different: tuck > classic knees at the apex, reach arms overhead, hop small, strides split', () => {
        const kneeApex = (n: string) => footFK(clip(n), 'L', atAir(clip(n), 0.48)).knee;
        expect(kneeApex('Jump Tuck')).toBeGreaterThan(kneeApex('Jump') + 20);
        expect(kneeApex('Jump Hop')).toBeLessThan(kneeApex('Jump') - 30);
        expect(armUp(clip('Jump Reach'), 'L', atAir(clip('Jump Reach'), 0.3))[1]).toBeGreaterThan(0.75);   // arm pointing up
        expect(armUp(clip('Jump'), 'L', atAir(clip('Jump'), 0.3))[1]).toBeLessThan(0.5);
        // Stride: the thighs split (one forward, one back) at the apex; the mirror leads with the other leg.
        const split = (n: string) => { const c = clip(n), f = atAir(c, 0.5); return { L: pitch(c, 'upperleg_L', f), R: pitch(c, 'upperleg_R', f) }; };
        const sL = split('Jump Stride L'), sR = split('Jump Stride R');
        expect(sL.L).toBeLessThan(-40); expect(sL.R).toBeGreaterThan(15);
        expect(sR.R).toBeCloseTo(sL.L, 3); expect(sR.L).toBeCloseTo(sL.R, 3);
        // Swing: one arm forward, the other back (asymmetric).
        const c = clip('Jump Swing R'), f = atAir(c, 0.25);
        expect(armUp(c, 'L', f)[2] - armUp(c, 'R', f)[2]).toBeGreaterThan(0.6);
        expect(clip('Jump Swing L').jumpVariant!.family).toBe(clip('Jump Swing R').jumpVariant!.family);
        expect(clip('Jump Swing L').jumpVariant!.side).toBe('L');
    });

    it('per-character variation: deterministic per seed, different between seeds, small, and none without a seed', () => {
        expect(gaitPersonality('char-a')).toEqual(gaitPersonality('char-a'));
        expect(gaitPersonality('char-a')).not.toEqual(gaitPersonality('char-b'));
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) for (const v of Object.values(gaitPersonality(id))) { expect(v).toBeGreaterThanOrEqual(-1); expect(v).toBeLessThanOrEqual(1); }
        const a1 = buildLocomotionClips(JOINTS, { variation: 'char-a' }), a2 = buildLocomotionClips(JOINTS, { variation: 'char-a' }), b = buildLocomotionClips(JOINTS, { variation: 'char-b' });
        const walk = (cs: SkeletonAnimClip[]) => cs.find((k) => k.name === 'Walk')!;
        const strip = (c: SkeletonAnimClip) => JSON.stringify({ ...c, id: '' });
        expect(strip(walk(a1))).toEqual(strip(walk(a2)));
        expect(strip(walk(a1))).not.toEqual(strip(walk(b)));
        expect(strip(walk(buildLocomotionClips(JOINTS, { variation: null })))).toEqual(strip(clip('Walk')));
        const w = LOCOMOTION_GAITS.walk;
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
            const v = varyGait(w, gaitPersonality(id));
            expect(Math.abs(v.period / w.period - 1)).toBeLessThan(0.06);
            expect(Math.abs(v.speed / w.speed - 1)).toBeLessThan(0.07);
            expect(Math.abs(v.arm / w.arm - 1)).toBeLessThan(0.21);
        }
    });
});

describe('natural walk / run + the Stomp walk style (2026-10-03)', () => {
    const clips = buildLocomotionClips(JOINTS);
    const clip = (n: string) => clips.find((c) => c.name === n)!;
    const hipsY = (c: SkeletonAnimClip, f: number) => (sample(c, 'hips', 'translation', f) as number[])[1];
    /** World foot pitch (deg, + = toes UP) at frame f. */
    const footPitch = (c: SkeletonAnimClip, side: 'L' | 'R', f: number) => { const d = rot(footFK(c, side, f).footQ, [0, 0, 1]); return Math.atan2(d[1], d[2]) * 180 / Math.PI; };
    const ground = (c: SkeletonAnimClip, side: 'L' | 'R', f: number) => { const k = footFK(c, side, f); return Math.min(k.heel[1], k.ball[1]) - SOLE; };
    const circ = (a: number, b: number) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
    /** Phase (0..1, 0 = left heel strike) of the pelvis max / min within the first half-cycle (the left step). */
    const extremes = (c: SkeletonAnimClip) => {
        const n = c.endFrame, half = Math.round(n / 2);
        let hi = 0, lo = 0;
        for (let f = 0; f < half; f++) { if (hipsY(c, f) > hipsY(c, hi)) hi = f; if (hipsY(c, f) < hipsY(c, lo)) lo = f; }
        return { hi: hi / n, lo: lo / n };
    };

    it('walk bob: the pelvis is HIGHEST near mid-stance and lowest in double support (the walk and the stroll)', () => {
        for (const n of ['Walk', 'Stroll']) {
            const g = n === 'Walk' ? LOCOMOTION_GAITS.walk : LOCOMOTION_GAITS.stroll, e = extremes(clip(n));
            expect(circ(e.hi, g.duty / 2), `${n} max at ${e.hi}`).toBeLessThan(0.06);
            expect(e.lo, `${n} min at ${e.lo}`).toBeLessThan(g.duty - 0.5 + 0.06);      // in / right after double support
        }
        // Personalities keep the phase.
        for (const id of ['char-a', 'char-b']) {
            const w = buildLocomotionClips(JOINTS, { variation: id }).find((k) => k.name === 'Walk')!;
            expect(circ(extremes(w).hi, LOCOMOTION_GAITS.walk.duty / 2)).toBeLessThan(0.07);
        }
    });

    it('run: a FLIGHT phase (both feet off the ground) with a visible rise; the pelvis is lowest at mid-stance, highest mid-flight', () => {
        const c = clip('Run'), g = LOCOMOTION_GAITS.run, n = c.endFrame;
        const e = extremes(c);
        expect(circ(e.lo, g.duty / 2), `min at ${e.lo}`).toBeLessThan(0.07);
        expect(e.hi, `max at ${e.hi}`).toBeGreaterThan(g.duty);
        expect(e.hi).toBeLessThan(0.5);
        // The longest run of frames with both feet > 1 cm up: a real airborne stretch, each half-cycle.
        let best = 0, cur = 0;
        for (let f = 0; f < 2 * n; f++) { const air = ground(c, 'L', f % n) > 0.01 && ground(c, 'R', f % n) > 0.01; cur = air ? cur + 1 : 0; best = Math.max(best, Math.min(cur, n)); }
        expect(best / n).toBeGreaterThan(0.12);
        const ys = Array.from({ length: n }, (_, f) => hipsY(c, f));
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.03);
    });

    // ── The ENERGETIC run + the jog (2026-10-04: "the run needs more airtime / energy, seems kinda stiff") ──
    const airFrac = (c: SkeletonAnimClip) => { let a = 0; for (let f = 0; f < c.endFrame; f++) if (ground(c, 'L', f) > 0.01 && ground(c, 'R', f) > 0.01) a++; return a / c.endFrame; };
    const range = (c: SkeletonAnimClip) => { const ys = Array.from({ length: c.endFrame }, (_, f) => hipsY(c, f)); return Math.max(...ys) - Math.min(...ys); };
    const thighFwd = (n: string, g: { duty: number }) => { void g; const c = clip(n); return Math.max(...Array.from({ length: c.endFrame }, (_, f) => -legAngles(n === 'Run' ? LOCOMOTION_GAITS.run : LOCOMOTION_GAITS.jog, f / c.endFrame).thigh)); };
    /** Upper-arm swing in the side plane (deg from hanging, + = forward) at frame f, in the rig frame (hips → spine → chest). */
    const armPitch = (c: SkeletonAnimClip, f: number) => {
        let q = (sample(c, 'hips', 'rotation', f) ?? [0, 0, 0, 1]) as Q;
        for (const j of ['lowerback', 'spine', 'chest', 'clavicle_L', 'shoulder_L']) q = qmul(q, (sample(c, j, 'rotation', f) ?? [0, 0, 0, 1]) as Q);
        const d = rot(q, [1, 0, 0]);
        return Math.atan2(d[2], -d[1]) * 180 / Math.PI;
    };

    it('energetic run: real airtime, a big rise, a high knee drive, a heel kick, a push-off stretch, landing near under the body', () => {
        const r = clip('Run'), n = r.endFrame, g = LOCOMOTION_GAITS.run;
        expect(airFrac(r), 'both feet off the ground (the 10-03 run: 0.40)').toBeGreaterThan(0.4);
        expect(range(r), 'pelvis range on the rig (10-03: 4.5 cm)').toBeGreaterThan(0.075);
        expect(range(r)).toBeLessThan(0.12);
        expect(thighFwd('Run', g), 'knee drive (10-03: 41°)').toBeGreaterThan(70);
        expect(thighFwd('Run', g), 'knee drive').toBeLessThan(92);
        expect(Math.max(...Array.from({ length: n }, (_, f) => footFK(r, 'L', f).knee)), 'heel kick').toBeGreaterThan(100);
        // The push-off: the knee nearly straight as the foot leaves the ground on its toes.
        const toeOff = Math.round(g.duty * n);
        expect(footFK(r, 'L', toeOff).knee, 'toe-off knee').toBeLessThan(32);
        // The squash: the knee takes the landing (flexes after contact).
        expect(footFK(r, 'L', 2).knee).toBeGreaterThan(footFK(r, 'L', 0).knee + 12);
        expect(footFK(r, 'L', 0).ankle[2], 'landing ankle ahead of the hip').toBeLessThan(0.28);
        // Arms: a big pump, the hand up toward the chin in front, the elbow well behind the torso.
        const pitches = Array.from({ length: n }, (_, f) => armPitch(r, f));
        expect(Math.max(...pitches) - Math.min(...pitches), 'arm arc (10-03: ~100°)').toBeGreaterThan(105);
        expect(Math.max(...pitches), 'forward').toBeGreaterThan(55);
        // The head NODS on impact (headNod): pitched further down a beat after each touch-down than at it.
        const headPitch = (f: number) => {   // the head's WORLD pitch (+ = looking down), through the spine chain
            let q = (sample(r, 'hips', 'rotation', f) ?? [0, 0, 0, 1]) as Q;
            for (const j of ['lowerback', 'spine', 'chest', 'neck', 'head']) q = qmul(q, (sample(r, j, 'rotation', f) ?? [0, 0, 0, 1]) as Q);
            const d = rot(q, [0, 0, 1]);
            return Math.atan2(-d[1], d[2]) * 180 / Math.PI;
        };
        const afterLand = Math.max(...[1, 2, 3, 4].map((k) => headPitch(Math.round(g.headLag * n) + k)));
        expect(afterLand - headPitch(Math.round((0.5 * 0.5 + g.headLag) * n)), 'nod vs mid-flight').toBeGreaterThan(3);
    });

    it('the jog is the same model, smaller: less air, rise, knee drive and arm pump than the run, still a flight phase', () => {
        const j = clip('Jog'), r = clip('Run');
        expect(j.groundSpeed!).toBeCloseTo(3.0, 1);
        expect(j.passPhases?.length).toBe(2);
        expect(airFrac(j)).toBeGreaterThan(0.15); expect(airFrac(j)).toBeLessThan(airFrac(r));
        expect(range(j)).toBeLessThan(range(r));
        expect(thighFwd('Jog', LOCOMOTION_GAITS.jog)).toBeLessThan(thighFwd('Run', LOCOMOTION_GAITS.run) - 10);
        expect(thighFwd('Jog', LOCOMOTION_GAITS.jog)).toBeGreaterThan(35);
        const arc = (c: SkeletonAnimClip) => { const p = Array.from({ length: c.endFrame }, (_, f) => armPitch(c, f)); return Math.max(...p) - Math.min(...p); };
        expect(arc(j)).toBeLessThan(arc(r));
        expect(LOCOMOTION_CLIP.jog).toBe('Jog');
    });

    it('foot roll: toes UP at heel strike, heel UP (toes down) at toe-off — walk and run', () => {
        for (const n of ['Walk', 'Run']) {
            const c = clip(n), g = n === 'Walk' ? LOCOMOTION_GAITS.walk : LOCOMOTION_GAITS.run;
            const toeOff = Math.floor(g.duty * c.endFrame) - (n === 'Walk' ? 1 : 0);
            expect(footPitch(c, 'L', 0), `${n} heel strike`).toBeGreaterThan(n === 'Walk' ? 12 : 3);
            expect(footPitch(c, 'L', toeOff), `${n} toe-off`).toBeLessThan(-30);
            expect(ground(c, 'L', 0)).toBeLessThan(0.005);                 // the heel is on the ground at contact
        }
    });

    it('the landing foot glides down onto its heel (no foot hanging short of the ground and dropping); the Stomp still drops', () => {
        const maxDrop = (c: SkeletonAnimClip) => {
            let m = 0;
            // The last approach only: the heel within 2.5 cm of the ground (mid-swing it comes down from the knee fold).
            for (const s of ['L', 'R'] as const) for (let f = 0; f < c.endFrame; f++) { const a = footFK(c, s, f).heel[1], b = footFK(c, s, f + 1).heel[1]; if (b - SOLE < 0.025) m = Math.max(m, a - b); }
            return m;
        };
        console.log('MAXDROP run', maxDrop(clip('Run')).toFixed(4), 'jog', maxDrop(clip('Jog')).toFixed(4));
        expect(maxDrop(clip('Walk'))).toBeLessThan(0.02);
        expect(maxDrop(clip('Stroll'))).toBeLessThan(0.012);
        expect(maxDrop(clip('Stomp'))).toBeGreaterThan(0.03);                // kept as the heavy tread
    });

    it('swing knee ~60° in the walk; the run folds the rear leg at once (heel kick), drives the knee, and lands nearer under the body', () => {
        const kneeMax = (c: SkeletonAnimClip) => Math.max(...Array.from({ length: c.endFrame }, (_, f) => footFK(c, 'L', f).knee));
        expect(kneeMax(clip('Walk'))).toBeGreaterThan(52); expect(kneeMax(clip('Walk'))).toBeLessThan(75);
        const r = clip('Run'), n = r.endFrame, toeOff = Math.round(LOCOMOTION_GAITS.run.duty * n);
        expect(footFK(r, 'L', toeOff + Math.round(0.12 * n)).knee, 'folds within 0.12 cycle of toe-off (the old run: ~25°)').toBeGreaterThan(45);
        expect(kneeMax(r)).toBeGreaterThan(90);
        const thighMax = Math.max(...Array.from({ length: n }, (_, f) => legAngles(LOCOMOTION_GAITS.run, f / n).thigh * -1));
        expect(thighMax, 'knee drive (thigh forward)').toBeGreaterThan(50);
        expect(footFK(r, 'L', 0).ankle[2], 'landing ankle ahead of the hip').toBeLessThan(0.3);
        expect(footFK(clip('Stomp'), 'L', 0).ankle[2]).toBeGreaterThan(footFK(clip('Walk'), 'L', 0).ankle[2] - 0.1);
    });

    it('the walk lands the feet a little apart (step width)', () => {
        const c = clip('Walk');
        expect(footFK(c, 'L', 0).ankle[0]).toBeGreaterThan(0.045 + 0.012);
        expect(footFK(c, 'R', Math.round(c.endFrame / 2)).ankle[0]).toBeLessThan(-0.045 - 0.012);
    });

    it('Stomp: the old walk is its own runtime clip (a gait with ground speed + passing phases), selectable as the walk', () => {
        const s = clip('Stomp');
        expect(LOCOMOTION_CLIP.stomp).toBe('Stomp');
        expect(s.groundSpeed!).toBeCloseTo(1.6, 1);
        expect(s.passPhases?.length).toBe(2);
        const slots = { idle: 'Stand', walk: 'Walk', run: 'Run', stroll: 'Stroll' };
        expect(applyWalkStyle(slots, 'stomp', () => true)).toEqual({ idle: 'Stand', walk: 'Stomp', run: 'Run' });
        expect(applyWalkStyle(slots, 'natural', () => true)).toBe(slots);
        expect(applyWalkStyle(slots, 'stomp', () => false)).toBe(slots);                     // the rig lacks it
        expect(applyWalkStyle({ ...slots, walk: 'My Walk' }, 'stomp', () => true).walk).toBe('My Walk');   // authored walk untouched
    });

    // ── The SPRING run (2026-10-04 pass 2: "more like Link's run — dynamic, readable, weighty") ──
    /** World yaw (deg) of a joint's sideways (+X) axis through the chain from the hips. */
    const yawOf = (c: SkeletonAnimClip, f: number, chain: string[]) => {
        let q = (sample(c, 'hips', 'rotation', f) ?? [0, 0, 0, 1]) as Q;
        for (const j of chain) q = qmul(q, (sample(c, j, 'rotation', f) ?? [0, 0, 0, 1]) as Q);
        const d = rot(q, [1, 0, 0]);
        return Math.atan2(-d[2], d[0]) * 180 / Math.PI;
    };
    const springMetrics = (c: SkeletonAnimClip) => {
        const n = c.endFrame, F = Array.from({ length: n }, (_, f) => f);
        const pelvis = F.map((f) => yawOf(c, f, []));
        const chest = F.map((f) => yawOf(c, f, ['lowerback', 'spine', 'chest']));
        const head = F.map((f) => yawOf(c, f, ['lowerback', 'spine', 'chest', 'neck', 'head']));
        const pk = pelvis.reduce((b, v, i) => (Math.abs(v) > Math.abs(pelvis[b]) ? i : b), 0);
        const elbow = F.map((f) => { const q = sample(c, 'lowerarm_L', 'rotation', f) as Q; return 2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180 / Math.PI; });
        const heel = Math.max(...F.map((f) => footFK(c, 'L', f).heel[1] - SOLE));
        const arms = F.map((f) => armPitch(c, f)), lo = Math.min(...arms), hi = Math.max(...arms), mid = (lo + hi) / 2;
        const held = arms.filter((a) => Math.abs(a - mid) > 0.8 * (hi - lo) / 2).length / n;
        return { pelvis: pelvis[pk], chest: chest[pk], headMax: Math.max(...head.map(Math.abs)), pelvisMax: Math.abs(pelvis[pk]), elbowMin: Math.min(...elbow), elbowMax: Math.max(...elbow), heel, held };
    };

    it('spring run: shoulders counter-rotate the pelvis, the head stays steady, a high heel kick, bent elbows, held extremes', () => {
        const r = springMetrics(clip('Run')), j = springMetrics(clip('Jog')), w = springMetrics(clip('Walk'));
        // Counter-rotation: at the pelvis's peak yaw the shoulder line is turned clearly the OTHER way.
        expect(Math.sign(r.chest), 'shoulders vs pelvis').toBe(-Math.sign(r.pelvis));
        expect(r.pelvisMax, 'pass 1: 11').toBeGreaterThan(12.5);
        expect(Math.abs(r.chest), 'pass 1: 9.8').toBeGreaterThan(13);
        expect(Math.abs(r.chest)).toBeGreaterThan(Math.abs(w.chest) * 2);
        expect(Math.sign(j.chest)).toBe(-Math.sign(j.pelvis));
        // The head floats: it turns far less than either the pelvis or the shoulders.
        expect(r.headMax).toBeLessThan(0.45 * Math.abs(r.chest));
        // Trailing leg: the heel kicks up toward the butt (the heel well above the ground behind).
        expect(r.heel, 'heel kick height (pass 1: 0.61)').toBeGreaterThan(0.62);
        expect(j.heel).toBeLessThan(r.heel);
        // Arms: elbows bent ~70–90° all cycle.
        expect(r.elbowMin).toBeGreaterThan(65); expect(r.elbowMax).toBeLessThan(95);
        // Uneven timing: the arm spends more of the cycle near its extremes than a raw sine (0.41 of it). (≥ since the
        // run-posture pass: an upright pelvis under a trunk leaning from the lower back measures 11 / 22 frames, was 12.)
        expect(r.held, 'a raw sine: ~0.45 here').toBeGreaterThanOrEqual(0.5);
    });

    // ── RUN POSTURE (2026-10-04 pass 3: "goofy, like a cartoon villain — the hips and butt locked in place") ──
    // The run leaned with an anterior PELVIC TILT (bodyLean 10.5° + tilt) plus a spine lean on top, over a pelvis the
    // late-swing fit had sunk ~6 cm: the butt stuck out behind the feet and the knees never straightened. A runner runs
    // TALL: the pelvis near upright, the trunk tipped forward as a line, near-straight at push-off.
    /** World pitch (deg, + = forward) of a chain's Y axis, and world positions of hips / chest / neck at frame f. */
    const chainAt = (c: SkeletonAnimClip, f: number) => {
        const hipsT = (sample(c, 'hips', 'translation', f) ?? JOINTS[0].localPosition) as V3;
        let q = (sample(c, 'hips', 'rotation', f) ?? [0, 0, 0, 1]) as Q;
        const up = (qq: Q) => { const d = rot(qq, [0, 1, 0]); return Math.atan2(d[2], d[1]) * 180 / Math.PI; };
        const pelvisTilt = up(q);
        let p = hipsT; const pos: Record<string, V3> = { hips: hipsT };
        for (const j of ['lowerback', 'spine', 'chest', 'neck']) { p = add(p, rot(q, JOINTS[idx(j)].localPosition as V3)); pos[j] = p; q = qmul(q, (sample(c, j, 'rotation', f) ?? [0, 0, 0, 1]) as Q); }
        const ang = (a: V3, b: V3) => Math.atan2(b[2] - a[2], b[1] - a[1]) * 180 / Math.PI;
        return { pelvisTilt, trunk: ang(pos.hips, pos.neck), fold: ang(pos.chest, pos.neck) - ang(pos.hips, pos.chest), hipsT, neck: pos.neck };
    };
    /** World thigh angle from vertical (deg, + = the knee ahead of the hip). */
    const thighWorld = (c: SkeletonAnimClip, side: 'L' | 'R', f: number) => {
        const hipsT = (sample(c, 'hips', 'translation', f) ?? JOINTS[0].localPosition) as V3, hipsR = (sample(c, 'hips', 'rotation', f) ?? [0, 0, 0, 1]) as Q;
        const hip = add(hipsT, rot(hipsR, JOINTS[idx(`upperleg_${side}`)].localPosition as V3));
        const kn = add(hip, rot(qmul(hipsR, sample(c, `upperleg_${side}`, 'rotation', f) as Q), JOINTS[idx(`lowerleg_${side}`)].localPosition as V3));
        return Math.atan2(kn[2] - hip[2], hip[1] - kn[1]) * 180 / Math.PI;
    };

    it('run posture: an upright pelvis, the trunk leaning as a line, tall at mid-stance, hip extended at toe-off (Run + Jog)', () => {
        for (const [name, g, trunkLo, trunkHi] of [['Run', LOCOMOTION_GAITS.run, 8, 12], ['Jog', LOCOMOTION_GAITS.jog, 5, 8]] as const) {
            const c = clip(name), n = c.endFrame, F = Array.from({ length: n }, (_, f) => chainAt(c, f));
            // Pelvis tilt within a few degrees of rest all cycle (the old run: 8–12° anterior, the Jog 5–8°).
            for (const x of F) { expect(x.pelvisTilt, `${name} pelvis tilt`).toBeGreaterThan(-2); expect(x.pelvisTilt, `${name} pelvis tilt`).toBeLessThan(4.5); }
            // The trunk (pelvis → neck line) leans forward in range, as one line: no fold between the pelvis and the chest.
            const meanTrunk = F.reduce((s, x) => s + x.trunk, 0) / n;
            expect(meanTrunk, `${name} trunk lean`).toBeGreaterThan(trunkLo); expect(meanTrunk, `${name} trunk lean`).toBeLessThan(trunkHi);
            for (const x of F) expect(Math.abs(x.fold), `${name} pelvis–chest fold`).toBeLessThan(4);
            // Tall at mid-stance (the old run: 0.865 of the standing pelvis height), the knee a runner's compliance.
            const mid = Math.round(g.duty / 2 * n);
            expect(F[mid].hipsT[1] / 0.9, `${name} mid-stance pelvis height`).toBeGreaterThan(0.905);
            expect(footFK(c, 'L', mid).knee, `${name} mid-stance knee`).toBeGreaterThan(28);
            expect(footFK(c, 'L', mid).knee, `${name} mid-stance knee`).toBeLessThan(45);
            // The push-off: the last stance frame — the hip extended (the thigh behind the vertical), the knee nearly
            // straight, and the pelvis NOT behind the line from the stance ankle to the neck (no butt-out).
            const to = Math.floor(g.duty * n);
            expect(thighWorld(c, 'L', to), `${name} toe-off thigh`).toBeLessThan(name === 'Run' ? -12 : -8);
            expect(footFK(c, 'L', to).knee, `${name} toe-off knee`).toBeLessThan(28);
            const a = footFK(c, 'L', to).ankle, nk = F[to].neck, h = F[to].hipsT, t = (h[1] - a[1]) / (nk[1] - a[1]);
            expect(h[2] - (a[2] + t * (nk[2] - a[2])), `${name} pelvis vs the ankle → neck line at toe-off`).toBeGreaterThan(0);
        }
    });

    it('run posture: the hips stay alive — pelvis yaw against the shoulders, a swing-side drop, a ballistic bounce', () => {
        const c = clip('Run'), n = c.endFrame, g = LOCOMOTION_GAITS.run;
        // Swing-side drop: the pelvis rolls a few degrees, the RIGHT (swing) hip low at the left's mid-stance.
        const rollAt = (f: number) => { const d = rot((sample(c, 'hips', 'rotation', f) ?? [0, 0, 0, 1]) as Q, [1, 0, 0]); return Math.atan2(d[1], d[0]) * 180 / Math.PI; };
        const mid = Math.round(g.duty / 2 * n);
        expect(rollAt(mid), 'left hip up / right (swing) hip down at left mid-stance').toBeGreaterThan(2);
        expect(rollAt(Math.round((g.duty / 2 + 0.5) * n)) ).toBeLessThan(-2);
        // The bounce: lowest at mid-stance, highest mid-flight, and a real range.
        const ys = Array.from({ length: n }, (_, f) => (sample(c, 'hips', 'translation', f) as number[])[1]);
        const lo = ys.indexOf(Math.min(...ys)), hi = ys.indexOf(Math.max(...ys));
        expect(Math.abs(((lo / n) % 0.5) - g.duty / 2)).toBeLessThan(0.07);
        expect((hi / n) % 0.5).toBeGreaterThan(g.duty);
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.05);
    });

    it('phase remaps: identity at 0, monotonic, the swing remap keeps rate 1 at both ends', () => {
        for (const x of [0, 0.13, 0.5, 0.77]) { expect(holdWarp(x, 0)).toBe(x); expect(swingWarp(x, 0)).toBe(x); }
        for (const h of [0.3, 0.6]) {
            let a = holdWarp(0, h), b = swingWarp(0, h);
            for (let i = 1; i <= 200; i++) { const x = i / 200; expect(holdWarp(x, h)).toBeGreaterThan(a); expect(swingWarp(x, h)).toBeGreaterThan(b); a = holdWarp(x, h); b = swingWarp(x, h); }
            expect(swingWarp(1, h)).toBeCloseTo(1, 9);
            expect((swingWarp(1e-4, h) - swingWarp(0, h)) / 1e-4).toBeCloseTo(1, 3);
            expect((swingWarp(1, h) - swingWarp(1 - 1e-4, h)) / 1e-4).toBeCloseTo(1, 3);
            expect(holdWarp(0.5, h)).toBeCloseTo(0.5, 9);
        }
    });
});
