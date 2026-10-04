import { describe, it, expect } from 'vitest';
import { LocomotionAnimator, LocomotionLean, LocomotionSecondary, JumpVariantPicker, blendWeighted, seedFromString, DEFAULT_LOCOMOTION_ANIM, type JumpVariantInfo } from './locomotion-animator';
import type { LocomotionState, LocomotionClips } from './locomotion';

const CLIPS: LocomotionClips = { idle: 'Breathe', walk: 'Walk', run: 'Run' };
const DUR = (n: string) => ({ Breathe: 4, Walk: 26 / 24, Run: 18 / 24, Jump: 0.5, Fall: 0.6 } as Record<string, number>)[n] ?? 1;
const grounded = (speed: number): LocomotionState => ({ planarSpeed: speed, moving: speed > 1e-3, grounded: true, airborne: false, rising: false });
const air = (rising: boolean): LocomotionState => ({ planarSpeed: 2, moving: true, grounded: false, airborne: true, rising });
const w = (layers: { clip: string; weight: number }[], clip: string) => layers.filter((l) => l.clip === clip).reduce((a, l) => a + l.weight, 0);
const sum = (layers: { weight: number }[]) => layers.reduce((a, l) => a + l.weight, 0);

/** The R6.2 tests' blend points (walk 1.5 / run 3.5 m/s). */
const newAnim = (cfg: Partial<typeof DEFAULT_LOCOMOTION_ANIM> = {}) => new LocomotionAnimator({ walkSpeed: 1.5, runSpeed: 3.5, ...cfg });

function steps(a: LocomotionAnimator, n: number, loco: LocomotionState, clips = CLIPS) {
    let out = a.update(1 / 60, loco, clips, DUR);
    for (let i = 1; i < n; i++) out = a.update(1 / 60, loco, clips, DUR);
    return out;
}

describe('LocomotionAnimator (R6.2 state machine)', () => {
    it('starts in idle, fully weighted on the idle clip', () => {
        const a = newAnim();
        const l = a.update(1 / 60, grounded(0), CLIPS, DUR);
        expect(a.state).toBe('idle');
        expect(w(l, 'Breathe')).toBeCloseTo(1, 9);
    });

    it('idle → walk CROSSFADES over ~startFade (not a snap)', () => {
        const a = newAnim();
        steps(a, 5, grounded(0));
        const first = a.update(1 / 60, grounded(1.5), CLIPS, DUR);
        expect(a.state).toBe('move');
        expect(w(first, 'Walk')).toBeGreaterThan(0);
        expect(w(first, 'Walk')).toBeLessThan(0.5);               // one tick in: mostly still idle
        const later = steps(a, Math.ceil(DEFAULT_LOCOMOTION_ANIM.startFade * 60) + 2, grounded(1.5));
        expect(w(later, 'Walk')).toBeCloseTo(1, 3);
    });

    it('stop → idle crossfades back to the idle clip (no frozen last stride)', () => {
        const a = newAnim();
        steps(a, 60, grounded(1.5));
        expect(a.state).toBe('move');
        const t1 = a.update(1 / 60, grounded(0), CLIPS, DUR);
        // Speed is smoothed, so the state may take a couple of ticks to leave move; the walk weight must decay smoothly.
        let prevWalk = w(t1, 'Walk');
        let sawBlend = false;
        for (let i = 0; i < 60; i++) {
            const l = a.update(1 / 60, grounded(0), CLIPS, DUR);
            const ww = w(l, 'Walk');
            expect(ww).toBeLessThanOrEqual(prevWalk + 1e-9);        // monotonic fade-out
            if (ww > 0.05 && w(l, 'Breathe') > 0.05) sawBlend = true;
            prevWalk = ww;
            expect(sum(l)).toBeCloseTo(1, 9);
        }
        expect(sawBlend).toBe(true);                                  // there WAS an in-between (a crossfade)
        expect(a.state).toBe('idle');
        expect(w(a.update(1 / 60, grounded(0), CLIPS, DUR), 'Breathe')).toBeCloseTo(1, 6);
    });

    it('walk ⇄ run blends continuously by speed (Shift toggle / analog stick)', () => {
        const a = newAnim();
        steps(a, 60, grounded(1.5));
        expect(a.runMix).toBeCloseTo(0, 3);
        const mid = steps(a, 60, grounded(2.5));
        expect(a.runMix).toBeGreaterThan(0.3); expect(a.runMix).toBeLessThan(0.7);
        expect(w(mid, 'Walk')).toBeGreaterThan(0.2); expect(w(mid, 'Run')).toBeGreaterThan(0.2);
        const walkL = mid.find((l) => l.clip === 'Walk')!, runL = mid.find((l) => l.clip === 'Run')!;
        expect(walkL.phase).toBe(runL.phase);                        // one shared gait phase — feet stay in step
        steps(a, 60, grounded(3.5));
        expect(a.runMix).toBeCloseTo(1, 3);
    });

    it('stride matching: the gait phase advances faster at a higher speed (and at run cadence)', () => {
        const rate = (speed: number) => {
            const a = newAnim();
            steps(a, 60, grounded(speed));
            const p0 = a.update(1 / 60, grounded(speed), CLIPS, DUR).find((l) => l.clip === 'Walk' || l.clip === 'Run')!.phase;
            const p1 = a.update(1 / 60, grounded(speed), CLIPS, DUR).find((l) => l.clip === 'Walk' || l.clip === 'Run')!.phase;
            return (p1 - p0 + 1) % 1;
        };
        expect(rate(1.0)).toBeLessThan(rate(1.5));
        expect(rate(3.5)).toBeGreaterThan(rate(1.5));
    });

    it('airborne crossfades to jump (rising) then fall, and lands back to the ground state', () => {
        const clips = { ...CLIPS, jump: 'Jump', fall: 'Fall' };
        const a = newAnim();
        steps(a, 30, grounded(2), clips);
        steps(a, 20, air(true), clips);
        expect(a.state).toBe('jump');
        const f = steps(a, 60, air(false), clips);   // Round 8: the Fall loop takes over after fallAfter (1 s) airborne
        expect(a.state).toBe('fall');
        expect(w(f, 'Fall')).toBeGreaterThan(0.9);
        steps(a, 30, grounded(2), clips);
        expect(a.state).toBe('move');
    });

    it('without jump/fall clips, airborne keeps the grounded state (no blank pose)', () => {
        const a = newAnim();
        steps(a, 30, grounded(2));
        const l = steps(a, 10, air(true));
        expect(a.state).toBe('move');
        expect(sum(l)).toBeCloseTo(1, 9);
    });

    it('a rig without a run clip walks at any speed', () => {
        const a = newAnim();
        const l = steps(a, 60, grounded(3.5), { idle: 'Breathe', walk: 'Walk' });
        expect(w(l, 'Walk')).toBeCloseTo(1, 6);
    });
});

describe('blendWeighted', () => {
    it('is the weighted average for scalars', () => {
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
        expect(blendWeighted([{ value: 0, weight: 0.25 }, { value: 4, weight: 0.75 }], lerp)).toBeCloseTo(3, 9);
        expect(blendWeighted([{ value: 1, weight: 1 }, { value: 2, weight: 1 }, { value: 6, weight: 2 }], lerp)).toBeCloseTo(3.75, 9);
        expect(blendWeighted([], lerp)).toBeNull();
    });
});

describe('LocomotionAnimator — Round 8 (sneak, air phase, landing, stride matching)', () => {
    const FULL: LocomotionClips = { idle: 'Breathe', walk: 'Walk', run: 'Run', sneak: 'Sneak', crouch: 'Crouch', jump: 'Jump', fall: 'Fall', land: 'Land' };
    const D = (n: string) => ({ Breathe: 4, Walk: 28 / 30, Run: 21 / 30, Sneak: 33 / 30, Crouch: 2.4, Jump: 0.8, Fall: 1, Land: 0.42 } as Record<string, number>)[n] ?? 1;
    const st = (o: Partial<LocomotionState>): LocomotionState => ({ planarSpeed: 0, moving: false, grounded: true, airborne: false, rising: false, ...o });
    const run = (a: LocomotionAnimator, n: number, s: LocomotionState, clips = FULL) => { let l = a.update(1 / 60, s, clips, D); for (let i = 1; i < n; i++) l = a.update(1 / 60, s, clips, D); return l; };

    it('sneak: the crouch mix EASES in and out (idle → crouch, walk → sneak), never snaps', () => {
        const a = newAnim();
        run(a, 30, st({}));
        const first = a.update(1 / 60, st({ sneaking: true }), FULL, D);
        expect(w(first, 'Crouch')).toBeGreaterThan(0); expect(w(first, 'Crouch')).toBeLessThan(0.3);
        const idleC = run(a, 60, st({ sneaking: true }));
        expect(w(idleC, 'Crouch')).toBeCloseTo(1, 3);
        const walkS = run(a, 60, st({ sneaking: true, planarSpeed: 1, moving: true }));
        expect(w(walkS, 'Sneak')).toBeCloseTo(1, 3);
        const mid = run(a, 6, st({ sneaking: false, planarSpeed: 1.5, moving: true }));
        expect(w(mid, 'Sneak')).toBeGreaterThan(0.2); expect(w(mid, 'Walk')).toBeGreaterThan(0.2);   // blending out
        expect(sum(mid)).toBeCloseTo(1, 9);
        const out = run(a, 60, st({ sneaking: false, planarSpeed: 1.5, moving: true }));
        expect(w(out, 'Walk')).toBeCloseTo(1, 3);
        // One shared phase across walk / run / sneak.
        const both = run(a, 3, st({ sneaking: true, planarSpeed: 1.2, moving: true }));
        const ph = new Set(both.filter((l) => ['Walk', 'Run', 'Sneak'].includes(l.clip)).map((l) => l.phase));
        expect(ph.size).toBe(1);
    });

    it('stride matching uses the clips\' ground speeds: phase rate = speed / distance per cycle', () => {
        const a = newAnim({ walkSpeed: 1.6, runSpeed: 5.2, walkClipSpeed: 1.6, runClipSpeed: 4.6 });
        const rateAt = (speed: number) => {
            run(a, 90, st({ planarSpeed: speed, moving: true }));
            const p0 = a.update(1 / 60, st({ planarSpeed: speed, moving: true }), FULL, D).find((l) => l.clip === 'Walk' || l.clip === 'Run')!.phase;
            const p1 = a.update(1 / 60, st({ planarSpeed: speed, moving: true }), FULL, D).find((l) => l.clip === 'Walk' || l.clip === 'Run')!.phase;
            return ((p1 - p0 + 1) % 1) * 60;   // cycles / s
        };
        expect(rateAt(1.6)).toBeCloseTo(1.6 / (1.6 * D('Walk')), 2);   // exactly the clip's cadence at its own speed
        expect(rateAt(5.2)).toBeCloseTo(5.2 / (4.6 * D('Run')), 2);    // run clip sped up 13% for the faster run
    });

    it('character scale (2026-10-04): a scaled avatar keeps PLANTED feet — the rate clamp widens to its gait cadence', () => {
        // Feet slide = body speed − (distance per cycle × cycles per second). Planted ⇔ cps × dist == speed.
        const slideAt = (k: number, scaleRateClamp = true) => {
            const a = newAnim({ walkSpeed: 1.6, runSpeed: 5.2, walkClipSpeed: 1.6 * k, runClipSpeed: 4.6 * k, scaleRateClamp });
            const rateAt = (speed: number) => {
                run(a, 90, st({ planarSpeed: speed, moving: true }));
                const ph = () => a.update(1 / 60, st({ planarSpeed: speed, moving: true }), FULL, D).find((l) => l.clip === 'Walk' || l.clip === 'Run')!.phase;
                const p0 = ph(), p1 = ph();
                return ((p1 - p0 + 1) % 1) * 60;
            };
            const walkDist = 1.6 * k * D('Walk');                       // ground covered per walk cycle at rate 1
            return Math.abs(1.6 - rateAt(1.6) * walkDist) / 1.6;        // fractional slide at the walk speed
        };
        for (const k of [0.25, 0.5, 1, 2, 3]) expect(slideAt(k)).toBeLessThan(0.01);
        // The fixed clamp (the old behaviour) slid a 3× giant (rate 0.33 < 0.45) and a quarter-size doll (4 > 1.7).
        expect(slideAt(3, false)).toBeGreaterThan(0.2);
        expect(slideAt(0.25, false)).toBeGreaterThan(0.5);
        // An avatar at its natural size is bit-identical with the widening on or off.
        expect(slideAt(1)).toBe(slideAt(1, false));
    });

    it('a jump samples the Jump clip by AIR PHASE; a long fall switches to the Fall loop; a small drop never shows the air pose', () => {
        const a = newAnim();
        run(a, 30, st({ planarSpeed: 1.6, moving: true }));
        let l = run(a, 8, st({ airborne: true, grounded: false, rising: true, jumped: true, airPhase: 0.1, planarSpeed: 1.6 }));
        expect(a.state).toBe('jump');
        expect(l.find((x) => x.clip === 'Jump')!.phase).toBeCloseTo(0.1, 6);
        l = run(a, 4, st({ airborne: true, grounded: false, rising: false, jumped: true, airPhase: 0.62, planarSpeed: 1.6 }));
        expect(l.find((x) => x.clip === 'Jump')!.phase).toBeCloseTo(0.62, 6);
        run(a, 40, st({ airborne: true, grounded: false, rising: false, jumped: true, airPhase: 1, airTime: 1.2 }));
        expect(a.state).toBe('fall');
        // A walk off a curb: airborne for 3 ticks, never jumped → stays in move.
        const b = newAnim();
        run(b, 30, st({ planarSpeed: 1.6, moving: true }));
        run(b, 3, st({ airborne: true, grounded: false, planarSpeed: 1.6, moving: true, airPhase: 0.55 }));
        expect(b.state).toBe('move');
    });

    it('landing adds an ADDITIVE squash weighted by the impact (lighter while moving) that plays out and ends', () => {
        const a = newAnim();
        run(a, 10, st({ airborne: true, grounded: false, rising: false, jumped: true, airPhase: 0.9 }));
        const land = a.update(1 / 60, st({ landImpact: 1 }), FULL, D);
        const L = land.find((x) => x.clip === 'Land')!;
        expect(L.additive).toBe(true);
        expect(L.weight).toBeGreaterThan(0.8);
        expect(sum(land.filter((x) => !x.additive))).toBeCloseTo(1, 9);   // additive layers are outside the normal sum
        const later = run(a, 40, st({}));
        expect(later.some((x) => x.clip === 'Land')).toBe(false);          // played once (0.42 s) and gone
        // A soft landing while running: lighter.
        const b = newAnim();
        run(b, 10, st({ airborne: true, grounded: false, rising: false, jumped: true, airPhase: 0.9, planarSpeed: 3.5, moving: true }));
        run(b, 1, st({ landImpact: 0.5, planarSpeed: 3.5, moving: true }));
        const soft = run(b, 12, st({ planarSpeed: 3.5, moving: true }));
        expect(soft.find((x) => x.clip === 'Land')!.weight).toBeLessThan(L.weight * 0.6);
    });
});

describe('LocomotionAnimator — item 13 (jump wind-up, turn anticipation)', () => {
    const J: LocomotionClips = { idle: 'Breathe', walk: 'Walk', jump: 'Jump', land: 'Land' };
    it("a ground wind-up plays the Jump clip's crouch part, then the air maps onto [takeoff, 1]; no landing on the wind-up", () => {
        const a = newAnim({ jumpTakeoff: 0.2 });
        steps(a, 30, grounded(0), J);
        let out = steps(a, 1, { ...grounded(0), jumpWindup: 0.5 }, J);
        expect(a.state).toBe('jump');
        expect(out.find((l) => l.clip === 'Jump')!.phase).toBeCloseTo(0.1, 6);
        out = steps(a, 3, { ...grounded(0), jumpWindup: 1 }, J);
        expect(out.find((l) => l.clip === 'Jump')!.weight).toBeGreaterThan(0.9);   // the 30 ms fade: in by now
        expect(out.some((l) => l.clip === 'Land')).toBe(false);                    // grounded wind-up is not a landing
        out = steps(a, 1, { ...air(true), airPhase: 0.5, jumped: true }, J);
        expect(out.find((l) => l.clip === 'Jump')!.phase).toBeCloseTo(0.2 + 0.8 * 0.5, 6);
        // A clip without a take-off (an authored Jump): the wind-up holds its first frame, the air maps as before.
        const b = newAnim();
        steps(b, 30, grounded(0), J);
        expect(steps(b, 2, { ...grounded(0), jumpWindup: 0.6 }, J).find((l) => l.clip === 'Jump')!.phase).toBe(0);
        expect(steps(b, 1, { ...air(true), airPhase: 0.3, jumped: true }, J).find((l) => l.clip === 'Jump')!.phase).toBeCloseTo(0.3, 6);
    });
    it('the head leads a turn the body is still making (turnRemaining), and lets go once it is made', () => {
        const l = new LocomotionLean();
        for (let i = 0; i < 4; i++) l.update(1 / 60, 0, 1, 0, 5, true, Math.PI / 2);   // about to turn left 90 deg
        expect(l.output.headYaw).toBeGreaterThan(10);                                    // already looking left after 4 ticks
        for (let i = 0; i < 60; i++) l.update(1 / 60, 0, 1, 0, 5, true, 0);
        expect(Math.abs(l.output.headYaw)).toBeLessThan(0.5);
    });
});

describe('jump variety (2026-10-03)', () => {
    // Pick weights like the runtime defaults (default-locomotion.ts JUMP_VARIANTS).
    const INFO: Record<string, JumpVariantInfo> = {
        Jump: { stand: 1, walk: 1, run: 0.6, tap: 0.35, hold: 1, land: 'Land' },
        Tuck: { stand: 1, walk: 0.8, run: 0.5, tap: 0.15, hold: 1.1, land: 'Land Deep' },
        Reach: { stand: 1.1, walk: 0.8, run: 0.3, tap: 0.1, hold: 1 },
        'Swing L': { stand: 0.6, walk: 1.2, run: 0.9, tap: 0.25, hold: 1, family: 'Swing', side: 'L' },
        'Swing R': { stand: 0.6, walk: 1.2, run: 0.9, tap: 0.25, hold: 1, family: 'Swing', side: 'R' },
        'Stride L': { stand: 0, walk: 0.35, run: 1.8, tap: 0.3, hold: 1, family: 'Stride', side: 'L' },
        'Stride R': { stand: 0, walk: 0.35, run: 1.8, tap: 0.3, hold: 1, family: 'Stride', side: 'R' },
        Hop: { stand: 1, walk: 1, run: 0.7, tap: 3, hold: 0.12, land: 'Land Soft' },
    };
    const NAMES = Object.keys(INFO);
    const fam = (n: string) => INFO[n].family ?? n;
    const vinfo = (n: string) => INFO[n];
    const info = (n: string) => (INFO[n] ? { jumpVariant: INFO[n] } : null);
    const STAND = { stand: 1, walk: 0, run: 0, held: true };
    const RUN = { stand: 0, walk: 0, run: 1, held: true };

    it('the picker never repeats the previous variant (family), and is deterministic for a seed', () => {
        const seq = (seed: number) => { const p = new JumpVariantPicker(seed); return Array.from({ length: 60 }, () => p.pick(NAMES, vinfo, STAND)!); };
        const a = seq(7);
        for (let i = 1; i < a.length; i++) expect(fam(a[i]), `jump ${i}`).not.toBe(fam(a[i - 1]));
        expect(seq(7)).toEqual(a);
        expect(seq(8)).not.toEqual(a);
        expect(new Set(a.map(fam)).size).toBeGreaterThanOrEqual(4);       // real variety from a stand
    });

    it('weights by context: no stride from a stand, mostly strides at a run, the hop for a tap', () => {
        const count = (ctx: { stand: number; walk: number; run: number; held: boolean }, n = 400) => {
            const p = new JumpVariantPicker(3), c: Record<string, number> = {};
            for (let i = 0; i < n; i++) { const f = fam(p.pick(NAMES, vinfo, ctx)!); c[f] = (c[f] ?? 0) + 1; }
            return c;
        };
        const stand = count(STAND), run = count(RUN), tap = count({ ...STAND, held: false });
        expect(stand.Stride ?? 0).toBe(0);
        expect(run.Stride).toBeGreaterThan(Math.max(run.Jump ?? 0, run.Tuck ?? 0, run.Reach ?? 0, run.Hop ?? 0));
        expect(tap.Hop).toBeGreaterThan(400 * 0.4);                         // every other tap at least (no repeats)
        expect(stand.Hop ?? 0).toBeLessThan(400 * 0.1);                     // a held jump rarely hops
        // Within a mirrored family the side matches the leading leg.
        const p = new JumpVariantPicker(1);
        const only = ['Stride L', 'Stride R'];
        expect(p.pick(only, vinfo, { ...RUN, lead: 'R' }, null)).toBe('Stride R');
        expect(p.pick(only, vinfo, { ...RUN, lead: 'L' }, null)).toBe('Stride L');
    });

    const V: LocomotionClips = { idle: 'Breathe', walk: 'Walk', run: 'Run', jump: 'Jump', jumps: NAMES, land: 'Land' };
    const DV = (n: string) => (n === 'Missing' ? 0 : DUR(n));
    const jumpOnce = (a: LocomotionAnimator, held = true, speed = 0) => {
        steps(a, 20, grounded(speed), V);
        a.update(1 / 60, { ...grounded(speed), jumpWindup: 0.5, jumpHeld: held }, V, DV, info);
        const l = a.update(1 / 60, { ...air(true), planarSpeed: speed, airPhase: 0.3, jumped: true, jumpHeld: held }, V, DV, info);
        const picked = a.jumpClip!;
        a.update(1 / 60, { ...grounded(speed), landImpact: 1 }, V, DV, info);
        return { picked, layers: l };
    };

    it('each jump plays a picked variant (never the same twice running); same seed gives the same sequence; off plays Jump', () => {
        const seqOf = (seed: number) => { const a = newAnim({ jumpSeed: seed }); return Array.from({ length: 12 }, () => jumpOnce(a).picked); };
        const s1 = seqOf(11);
        for (let i = 1; i < s1.length; i++) expect(fam(s1[i])).not.toBe(fam(s1[i - 1]));
        expect(seqOf(11)).toEqual(s1);
        expect(new Set(s1.map(fam)).size).toBeGreaterThanOrEqual(3);
        const a = newAnim({ jumpSeed: 11 });
        const j = jumpOnce(a);
        expect(j.layers.some((l) => l.clip === j.picked && l.weight > 0.5)).toBe(true);
        const off = newAnim({ jumpVariety: false });
        for (let i = 0; i < 4; i++) expect(jumpOnce(off).picked).toBe('Jump');
        // No `jumps` list (an authored set): always clips.jump, exactly as before.
        const b = newAnim();
        const A: LocomotionClips = { ...V, jumps: undefined };
        steps(b, 20, grounded(0), A);
        const l = b.update(1 / 60, { ...air(true), airPhase: 0.3, jumped: true }, A, DV, info);
        expect(b.jumpClip).toBe('Jump');
        expect(l.find((x) => x.clip === 'Jump')!.weight).toBeGreaterThan(0);
    });

    it('a TAP (button released before the take-off window ends) re-picks a tap variant (the hop) and crossfades to it', () => {
        let hops = 0;
        for (let seed = 1; seed <= 12; seed++) {
            const a = newAnim({ jumpSeed: seed });
            steps(a, 20, grounded(0), V);
            a.update(1 / 60, { ...grounded(0), jumpWindup: 0.25, jumpHeld: true }, V, DV, info);
            const held = a.jumpClip!;
            const l = a.update(1 / 60, { ...grounded(0), jumpWindup: 0.5, jumpHeld: false }, V, DV, info);
            if (INFO[held].tap < INFO[held].hold) {
                expect(a.jumpClip).not.toBe(held);
                expect(l.some((x) => x.clip === held)).toBe(true);           // fading out, not snapped
            }
            if (a.jumpClip === 'Hop') hops++;
        }
        expect(hops).toBeGreaterThan(6);
    });

    it('lands with the variant landing clip when the rig has it, else clips.land', () => {
        const H: LocomotionClips = { ...V, jump: 'Hop' };
        const a = newAnim({ jumpVariety: false });
        steps(a, 20, grounded(0), H);
        a.update(1 / 60, { ...air(true), airPhase: 0.9, jumped: true }, H, DV, info);
        let l = a.update(1 / 60, { ...grounded(0), landImpact: 1 }, H, DV, info);
        expect(l.find((x) => x.additive)!.clip).toBe('Land Soft');
        const miss = (n: string) => (n === 'Jump' ? { jumpVariant: { ...INFO.Jump, land: 'Missing' } } : info(n));
        const b = newAnim({ jumpVariety: false });
        steps(b, 20, grounded(0), V);
        b.update(1 / 60, { ...air(true), airPhase: 0.9, jumped: true }, V, DV, miss);
        l = b.update(1 / 60, { ...grounded(0), landImpact: 1 }, V, DV, miss);
        expect(l.find((x) => x.additive)!.clip).toBe('Land');
    });
});

describe('stroll + secondary motion (2026-10-03)', () => {
    const S: LocomotionClips = { idle: 'Breathe', walk: 'Walk', run: 'Run', stroll: 'Stroll' };
    const D2 = (n: string) => (n === 'Stroll' ? 1.12 : DUR(n));
    it('the stroll takes over below the walk speed and is gone at it; one shared phase', () => {
        const a = newAnim({ walkSpeed: 1.6, runSpeed: 5.2 });
        let l = a.update(1 / 60, grounded(0.8), S, D2);
        for (let i = 0; i < 60; i++) l = a.update(1 / 60, grounded(0.8), S, D2);
        expect(w(l, 'Stroll')).toBeGreaterThan(0.95);
        for (let i = 0; i < 60; i++) l = a.update(1 / 60, grounded(1.2), S, D2);
        expect(w(l, 'Stroll')).toBeGreaterThan(0.2); expect(w(l, 'Walk')).toBeGreaterThan(0.2);
        expect(new Set(l.filter((x) => x.clip === 'Walk' || x.clip === 'Stroll').map((x) => x.phase)).size).toBe(1);
        for (let i = 0; i < 60; i++) l = a.update(1 / 60, grounded(1.6), S, D2);
        expect(w(l, 'Stroll')).toBe(0);
        // Without a stroll clip (an authored set): the walk only, as before.
        const b = newAnim({ walkSpeed: 1.6, runSpeed: 5.2 });
        for (let i = 0; i < 60; i++) l = b.update(1 / 60, grounded(0.8), CLIPS, D2);
        expect(w(l, 'Walk')).toBeCloseTo(1, 6);
    });

    it('secondary motion: deterministic per seed, off at looseness 0, per-cycle arm variation, a stop overshoots', () => {
        const armTrace = (seed: number, looseness = 0.5) => {
            const s = new LocomotionSecondary({ looseness }, seed), out: number[] = [];
            let ph = 0;
            for (let i = 0; i < 240; i++) { ph = (ph + 1 / 60 / 0.93) % 1; out.push(s.update(1 / 60, { phase: ph, moveWeight: 1, armAmp: 30, armLag: 0.05, accel: 0, grounded: true }).armL); }
            return out;
        };
        expect(armTrace(seedFromString('a'))).toEqual(armTrace(seedFromString('a')));
        expect(armTrace(seedFromString('a'))).not.toEqual(armTrace(seedFromString('b')));
        expect(Math.max(...armTrace(5, 0).map(Math.abs))).toBe(0);
        expect(Math.max(...armTrace(5).map(Math.abs))).toBeGreaterThan(0.3);
        expect(Math.max(...armTrace(5).map(Math.abs))).toBeLessThan(30 * 0.13);
        // A hard stop (-15 m/s2 for 0.15 s): the chest swings forward, then overshoots back past rest and settles.
        const s = new LocomotionSecondary({}, 1);
        let maxF = 0, minAfter = 0, last = 0;
        for (let i = 0; i < 180; i++) {
            const o = s.update(1 / 60, { phase: 0, moveWeight: 0, armAmp: 0, armLag: 0, accel: i < 9 ? -15 : 0, grounded: true });
            if (i < 30) maxF = Math.max(maxF, o.chestPitch); else minAfter = Math.min(minAfter, o.chestPitch);
            last = o.chestPitch;
        }
        expect(maxF).toBeGreaterThan(1);
        expect(minAfter).toBeLessThan(-0.05);
        expect(Math.abs(last)).toBeLessThan(0.05);
    });
});

describe('settle step + tap history (2026-10-03)', () => {
    const G: LocomotionClips = { idle: 'Breathe', walk: 'Walk', run: 'Run' };
    const PASS = (n: string) => (n === 'Walk' || n === 'Run' ? { passPhases: [0.29, 0.79] } : null);
    it('a stop steps on to the next passing phase while it fades (gaits with passPhases); others freeze as before', () => {
        const a = newAnim();
        for (let i = 0; i < 50; i++) a.update(1 / 60, grounded(1.5), G, DUR, PASS);
        let l = a.update(1 / 60, grounded(0), G, DUR, PASS);
        for (let i = 0; i < 40 && a.weights.move > 1e-3; i++) l = a.update(1 / 60, grounded(0), G, DUR, PASS);
        const ph = a.gaitPhase;
        expect(Math.min(Math.abs(ph - 0.29), Math.abs(ph - 0.79))).toBeLessThan(0.02);
        expect(a.weights.move).toBeLessThan(1e-3);
        expect(l.length).toBeGreaterThan(0);
        // Without passPhases (an authored walk): the old stop (fade over stopFade, the phase at its slow minimum rate).
        const b = newAnim();
        for (let i = 0; i < 50; i++) b.update(1 / 60, grounded(1.5), G, DUR);
        let n = 0;
        b.update(1 / 60, grounded(0), G, DUR);
        while (b.weights.move > 1e-3 && n < 100) { b.update(1 / 60, grounded(0), G, DUR); n++; }
        // (the smoothed speed first has to drop below the stop threshold, then the stopFade crossfade runs)
        expect(n / 60).toBeGreaterThan(DEFAULT_LOCOMOTION_ANIM.stopFade); expect(n / 60).toBeLessThan(DEFAULT_LOCOMOTION_ANIM.stopFade + 0.35);
    });

    it('a tap re-pick never repeats the jump that played before it', () => {
        const INFO: Record<string, JumpVariantInfo> = {
            A: { stand: 1, walk: 1, run: 1, tap: 0.2, hold: 1 }, B: { stand: 1, walk: 1, run: 1, tap: 0.2, hold: 1 },
            C: { stand: 1, walk: 1, run: 1, tap: 0.2, hold: 1 }, Hop: { stand: 1, walk: 1, run: 1, tap: 3, hold: 0.1 }, Hop2: { stand: 1, walk: 1, run: 1, tap: 3, hold: 0.1 },
        };
        const V: LocomotionClips = { idle: 'Breathe', walk: 'Walk', jump: 'A', jumps: Object.keys(INFO), land: 'Land' };
        const info = (n: string) => (INFO[n] ? { jumpVariant: INFO[n] } : null);
        for (let seed = 1; seed < 8; seed++) {
            const a = newAnim({ jumpSeed: seed }), played: string[] = [];
            for (let k = 0; k < 16; k++) {
                steps(a, 20, grounded(0), V);
                a.update(1 / 60, { ...grounded(0), jumpWindup: 0.3, jumpHeld: true }, V, DUR, info);
                a.update(1 / 60, { ...grounded(0), jumpWindup: 0.6, jumpHeld: k % 2 === 0 }, V, DUR, info);
                a.update(1 / 60, { ...air(true), airPhase: 0.3, jumped: true, jumpHeld: k % 2 === 0 }, V, DUR, info);
                played.push(a.jumpClip!);
                a.update(1 / 60, { ...grounded(0), landImpact: 1 }, V, DUR, info);
            }
            for (let i = 1; i < played.length; i++) expect(played[i], `seed ${seed} jump ${i}: ${played.join(',')}`).not.toBe(played[i - 1]);
        }
    });
});

describe('jog between the walk and the run (2026-10-04)', () => {
    const J: LocomotionClips = { idle: 'Breathe', walk: 'Walk', run: 'Run', jog: 'Jog' };
    const DJ = (n: string) => (n === 'Jog' ? 0.76 : DUR(n));
    const at = (a: LocomotionAnimator, speed: number, clips: LocomotionClips = J) => { let l = a.update(1 / 60, grounded(speed), clips, DJ); for (let i = 0; i < 90; i++) l = a.update(1 / 60, grounded(speed), clips, DJ); return l; };
    const cfg = { walkSpeed: 1.6, runSpeed: 5.2, walkClipSpeed: 1.6, runClipSpeed: 4.6, jogClipSpeed: 3.0 };

    it('walk → jog → run by speed (absolute clip speeds), one shared phase; weights sum to 1', () => {
        const a = newAnim(cfg);
        let l = at(a, 2.3);
        expect(w(l, 'Walk')).toBeGreaterThan(0.2); expect(w(l, 'Jog')).toBeGreaterThan(0.2); expect(w(l, 'Run')).toBe(0);
        l = at(a, 3.0);
        expect(w(l, 'Jog')).toBeGreaterThan(0.99); expect(a.jogMix).toBeCloseTo(1, 3);
        l = at(a, 3.4);
        expect(w(l, 'Jog')).toBeGreaterThan(w(l, 'Run'));
        l = at(a, 5.2);                                   // the run speed (≥ 0.85 × the run clip's 4.6 m/s): the full run
        expect(w(l, 'Run')).toBeGreaterThan(0.99); expect(w(l, 'Jog')).toBe(0);
        expect(new Set(at(a, 3.5).filter((x) => x.clip === 'Jog' || x.clip === 'Run').map((x) => x.phase)).size).toBe(1);
        expect(at(a, 3.5).reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 6);
    });

    it('a slow top run speed stays a jog; without a jog clip the walk ⇄ run blend is unchanged', () => {
        const slow = newAnim({ ...cfg, runSpeed: 2.8 });
        expect(w(at(slow, 2.8), 'Jog')).toBeGreaterThan(0.99);
        // A long-legged body (clips planted for 1.45× the speeds): Play's 5.2 m/s top speed still gets the full run.
        const big = newAnim({ ...cfg, walkClipSpeed: 2.3, runClipSpeed: 6.7, jogClipSpeed: 4.35 });
        expect(w(at(big, 5.2), 'Run')).toBeGreaterThan(0.99);
        expect(w(at(big, 4.35), 'Jog')).toBeGreaterThan(0.99);
        const a = newAnim(cfg), b = newAnim(cfg);
        const noJog: LocomotionClips = { idle: 'Breathe', walk: 'Walk', run: 'Run' };
        const la = at(a, 3.4, noJog);
        expect(w(la, 'Run')).toBeCloseTo((3.4 - 1.6) / (5.2 - 1.6), 2);
        expect(b.jogMix).toBe(0);
    });
});

describe('idle variety (2026-10-04)', () => {
    const IDLES = ['Look', 'Stretch', 'Wrist', 'Tap'];
    const D = (n: string) => ({ Breathe: 4, Walk: 26 / 24, Look: 4.4, Stretch: 4.2, Wrist: 3.4, Tap: 4.2 } as Record<string, number>)[n] ?? 1;
    const V: LocomotionClips = { idle: 'Breathe', walk: 'Walk', idles: IDLES };
    /** Stand still for `secs` at 60 Hz; returns the variant sequence started and the max variant weight seen. */
    const stand = (a: LocomotionAnimator, secs: number, clips = V) => {
        let maxW = 0, sumOk = true;
        for (let i = 0; i < secs * 60; i++) {
            const l = a.update(1 / 60, grounded(0), clips, D);
            const s = sum(l); if (Math.abs(s - 1) > 1e-6) sumOk = false;
            for (const n of IDLES) maxW = Math.max(maxW, w(l, n));
        }
        return { seq: [...a.idleVariantHistory], maxW, sumOk };
    };

    it('seeded scheduling: waits the first delay, never repeats the previous variant, same seed = same sequence', () => {
        const a = newAnim({ jumpSeed: 7 }), b = newAnim({ jumpSeed: 7 }), c = newAnim({ jumpSeed: 99 });
        // Nothing before the first delay (4–7 s).
        stand(a, 3.9);
        expect(a.idleVariantCount).toBe(0);
        const r = stand(a, 120);
        expect(r.seq.length).toBeGreaterThanOrEqual(8);
        for (let i = 1; i < r.seq.length; i++) expect(r.seq[i], r.seq.join(', ')).not.toBe(r.seq[i - 1]);
        expect(new Set(r.seq).size).toBeGreaterThanOrEqual(3);              // the variety really varies
        expect(r.sumOk).toBe(true);                                         // the base idle + variant always sum to 1
        expect(r.maxW).toBeGreaterThan(0.99);                               // eased fully in at its middle
        expect(stand(b, 123.9).seq).toEqual(r.seq);                         // deterministic for a seed
        expect(stand(c, 123.9).seq).not.toEqual(r.seq);
    });

    it('a variant crossfades in and out smoothly (no frame-to-frame jump in its weight)', () => {
        const a = newAnim({ jumpSeed: 3 });
        let prev = 0, maxStep = 0, seen = false;
        for (let i = 0; i < 25 * 60; i++) {
            const l = a.update(1 / 60, grounded(0), V, D);
            const cur = IDLES.reduce((s, n) => s + w(l, n), 0);
            if (cur > 0) seen = true;
            maxStep = Math.max(maxStep, Math.abs(cur - prev)); prev = cur;
        }
        expect(seen).toBe(true);
        expect(maxStep).toBeLessThan(0.06);                                 // ≥ ~0.3 s fades at 60 Hz
    });

    it('locomotion always wins: a move cancels the variant within the cancel fade; the wait restarts', () => {
        const a = newAnim({ jumpSeed: 5 });
        for (let i = 0; i < 30 * 60 && !a.idleVariant; i++) a.update(1 / 60, grounded(0), V, D);
        expect(a.idleVariant).not.toBeNull();
        for (let i = 0; i < 30; i++) a.update(1 / 60, grounded(0), V, D);  // into it
        let l = a.update(1 / 60, grounded(1.5), V, D);
        for (let i = 0; i < 12; i++) l = a.update(1 / 60, grounded(1.5), V, D);   // 0.2 s > idleCancelFade 0.15
        expect(a.idleVariant).toBeNull();
        expect(IDLES.reduce((s, n) => s + w(l, n), 0)).toBe(0);
        // Back to a stand: nothing for at least the (non-first) delay's minimum.
        const n0 = a.idleVariantCount;
        stand(a, 5.5);
        expect(a.idleVariantCount).toBe(n0);
    });

    it('off (idleVariety false), no idles, crouched or airborne: no variant', () => {
        expect(stand(newAnim({ idleVariety: false }), 40).seq).toEqual([]);
        expect(stand(newAnim(), 40, { idle: 'Breathe', walk: 'Walk' }).seq).toEqual([]);
        const a = newAnim();
        const crouch: LocomotionClips = { ...V, crouch: 'Crouch' };
        for (let i = 0; i < 40 * 60; i++) a.update(1 / 60, { ...grounded(0), sneaking: true }, crouch, D);
        expect(a.idleVariantCount).toBe(0);
    });
});

describe('landing counter (2026-10-04, the host landing dust keys off it)', () => {
    it('counts each landing that played the land layer, with its clip + impact', () => {
        const a = newAnim();
        const J: LocomotionClips = { idle: 'Breathe', walk: 'Walk', jump: 'Jump', land: 'Land' };
        steps(a, 10, grounded(0), J);
        expect(a.landCount).toBe(0);
        steps(a, 40, { ...air(true), planarSpeed: 0, jumped: true, airPhase: 0.3 }, J);
        steps(a, 1, { ...grounded(0), landImpact: 1.1 }, J);
        expect(a.landCount).toBe(1);
        expect(a.lastLanding).toEqual({ clip: 'Land', impact: 1.1 });
        steps(a, 60, grounded(0), J);
        expect(a.landCount).toBe(1);
    });
});
