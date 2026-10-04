import { describe, it, expect } from 'vitest';
import { CharacterController, DEFAULT_CHARACTER, NO_INPUT, turnToward, wrapAngle } from './character-controller';

/** Instant speed (no accel ramp) — the exact-distance tests below predate the R6.2 speed easing. */
const INSTANT = { acceleration: 0, deceleration: 0 } as const;

describe('CharacterController', () => {
    it('moves forward along +Z at yaw 0', () => {
        const c = new CharacterController({ ...INSTANT, moveSpeed: 2 });
        c.update(0.5, { ...NO_INPUT, forward: 1 });
        expect(c.pos[2]).toBeCloseTo(1, 5);   // 2 u/s × 0.5 s
        expect(c.pos[0]).toBeCloseTo(0, 5);
    });

    it('turns RIGHT with positive look input, then moves along the new facing', () => {
        const c = new CharacterController({ ...INSTANT, moveSpeed: 1, turnSpeed: Math.PI });   // π rad/s
        // Positive look = turn right (clockwise from above). Facing +Z, a 90° right turn faces −X
        // (screen-right of a +Z camera in this right-handed Y-up world).
        c.update(1, { ...NO_INPUT, look: 0.5 });   // π·0.5 = 90° right
        expect(c.yaw).toBeCloseTo(-Math.PI / 2, 5);
        c.update(1, { ...NO_INPUT, forward: 1 });
        expect(c.pos[0]).toBeCloseTo(-1, 4);       // now forward is −X
        expect(c.pos[2]).toBeCloseTo(0, 4);
    });

    it('positive right input strafes SCREEN-right (−X when facing +Z) — the 2026-09-16 handedness fix', () => {
        const c = new CharacterController({ ...INSTANT, moveSpeed: 2 });
        c.update(0.5, { ...NO_INPUT, right: 1 });   // "D"
        expect(c.pos[0]).toBeCloseTo(-1, 5);        // −X = to the right of a +Z-facing camera
        expect(c.pos[2]).toBeCloseTo(0, 5);
    });

    it('normalizes diagonal movement (not faster than cardinal)', () => {
        const c = new CharacterController({ ...INSTANT, moveSpeed: 1 });
        c.update(1, { ...NO_INPUT, forward: 1, right: 1 });
        expect(Math.hypot(c.pos[0], c.pos[2])).toBeCloseTo(1, 4);   // 1 u/s, not √2
    });

    it('partial (analog) input moves proportionally slower — walk vs run (T5.2)', () => {
        const c = new CharacterController({ ...INSTANT, moveSpeed: 2 });
        c.update(1, { ...NO_INPUT, forward: 0.4 });
        expect(c.pos[2]).toBeCloseTo(0.8, 4);   // 0.4 × 2 u/s
    });

    it('falls under gravity and lands on the ground plane', () => {
        const c = new CharacterController({ gravity: 10, groundY: 0 }, [0, 5, 0]);
        for (let i = 0; i < 300; i++) c.update(1 / 60);   // ~5s
        expect(c.pos[1]).toBeCloseTo(0, 5);
        expect(c.grounded).toBe(true);
        expect(c.vel[1]).toBe(0);
    });

    it('jumps only when grounded, then returns to the ground', () => {
        const c = new CharacterController({ jumpSpeed: 5, gravity: 10 });
        expect(c.grounded).toBe(true);
        c.update(1 / 60, { ...NO_INPUT, jump: true });
        expect(c.grounded).toBe(false);
        expect(c.pos[1]).toBeGreaterThan(0);
        const airborne = c.pos[1];
        // a second jump mid-air does nothing (not grounded)
        c.update(1 / 60, { ...NO_INPUT, jump: true });
        expect(c.vel[1]).toBeLessThan(5);   // still just decelerating, not re-launched
        void airborne;
        for (let i = 0; i < 120; i++) c.update(1 / 60);
        expect(c.grounded).toBe(true);
    });

    it('eye + look target sit above the feet and ahead of the facing', () => {
        const c = new CharacterController({ eyeHeight: 1.6 }, [1, 0, 2]);
        expect(c.eyePosition()).toEqual([1, 1.6, 2]);
        const tgt = c.lookTarget();
        expect(tgt[2]).toBeGreaterThan(2);   // 1 unit ahead along +Z at yaw 0
    });

    it('applies direct mouse-look yaw/pitch deltas and clamps pitch', () => {
        const c = new CharacterController({ pitchMin: -1, pitchMax: 1 });
        c.update(1 / 60, { ...NO_INPUT, lookYaw: 0.3, lookPitch: 0.2 });
        expect(c.yaw).toBeCloseTo(-0.3, 5);   // positive lookYaw (mouse right) = turn right = yaw decreases (CCW convention)
        expect(c.pitch).toBeCloseTo(0.2, 5);
        // pitch clamps to pitchMax even under a large delta
        c.update(1 / 60, { ...NO_INPUT, lookPitch: 5 });
        expect(c.pitch).toBeCloseTo(1, 5);
        c.update(1 / 60, { ...NO_INPUT, lookPitch: -50 });
        expect(c.pitch).toBeCloseTo(-1, 5);
    });

    it('look target aims up when pitched up', () => {
        const c = new CharacterController({}, [0, 0, 0]);
        c.update(1 / 60, { ...NO_INPUT, lookPitch: 0.5 });
        const tgt = c.lookTarget();
        expect(tgt[1]).toBeGreaterThan(c.eyePosition()[1]);   // looking upward
    });

    it('rests on the sampled ground height, not the flat fallback', () => {
        const c = new CharacterController({ gravity: 10, groundY: 0 }, [0, 10, 0]);
        c.groundSampler = () => 3;   // ground is a plateau at y=3
        for (let i = 0; i < 300; i++) c.update(1 / 60);
        expect(c.pos[1]).toBeCloseTo(3, 4);
        expect(c.grounded).toBe(true);
    });

    it('falls to the flat fallback when the ground sampler returns null (walked off an edge)', () => {
        const c = new CharacterController({ gravity: 10, groundY: 0 }, [0, 5, 0]);
        c.groundSampler = () => null;   // no ground under us
        for (let i = 0; i < 300; i++) c.update(1 / 60);
        expect(c.pos[1]).toBeCloseTo(0, 4);   // fell to the fallback floor
    });

    it('honors a move resolver that blocks a wall (into-wall component cancelled)', () => {
        const c = new CharacterController({ moveSpeed: 2 }, [0, 0, 0]);
        // A wall at z = 0.5: clamp the resolved z, keep x free.
        c.moveResolver = (fx, _fz, tx, tz, _r) => [tx, Math.min(tz, 0.5)];
        c.update(1, { ...NO_INPUT, forward: 1 });   // wants to move +Z by 2
        expect(c.pos[2]).toBeCloseTo(0.5, 5);        // blocked at the wall
    });

    it('reports locomotion: idle at rest, moving speed while walking, airborne on jump', () => {
        const c = new CharacterController({ ...INSTANT, moveSpeed: 3, jumpSpeed: 5, gravity: 10 });
        c.update(1 / 60, NO_INPUT);
        let loco = c.locomotion();
        expect(loco.moving).toBe(false);
        expect(loco.grounded).toBe(true);
        expect(loco.planarSpeed).toBeCloseTo(0, 5);

        c.update(1 / 60, { ...NO_INPUT, forward: 1 });
        loco = c.locomotion();
        expect(loco.moving).toBe(true);
        expect(loco.planarSpeed).toBeCloseTo(3, 2);   // moveSpeed

        c.update(1 / 60, { ...NO_INPUT, jump: true });
        loco = c.locomotion();
        expect(loco.airborne).toBe(true);
        expect(loco.rising).toBe(true);               // just launched
    });

    it('planar speed drops to ~0 when a wall blocks the move', () => {
        const c = new CharacterController({ moveSpeed: 3 });
        c.moveResolver = (fx, fz) => [fx, fz];   // wall: no movement allowed
        c.update(1 / 60, { ...NO_INPUT, forward: 1 });
        expect(c.locomotion().planarSpeed).toBeCloseTo(0, 5);
        expect(c.locomotion().moving).toBe(false);
    });

    it('third-person camera sits behind and above the head', () => {
        const c = new CharacterController({ cameraMode: 'third', eyeHeight: 1.6, thirdPersonDistance: 4, thirdPersonHeight: 0.4 }, [0, 0, 0]);
        // yaw 0 → forward +Z, so the camera pulls back to -Z and looks at the head.
        const eye = c.cameraEye();
        const tgt = c.cameraTarget();
        expect(eye[2]).toBeCloseTo(-4, 4);           // 4 units behind along -Z
        expect(eye[1]).toBeCloseTo(2.0, 4);          // eyeHeight 1.6 + pivot height 0.4
        expect(tgt[1]).toBeCloseTo(2.0, 4);          // looks at the raised head pivot
        expect(tgt[2]).toBeCloseTo(0, 4);
    });

    // ── R6.2 third-person game feel ─────────────────────────────────────────────────────────────────────────
    describe('R6.2: camera-relative movement + body facing', () => {
        const TP = { ...INSTANT, cameraMode: 'third' as const, moveSpeed: 2 };

        it('W / S / D move relative to the CAMERA yaw (not the body)', () => {
            const c = new CharacterController(TP);
            c.applyLook(Math.PI / 2, 0);            // camera turned 90° right → looks along −X
            expect(c.yaw).toBeCloseTo(-Math.PI / 2, 6);
            c.update(0.5, { ...NO_INPUT, forward: 1 });
            expect(c.pos[0]).toBeCloseTo(-1, 5);   // W = away from the camera = −X
            expect(c.pos[2]).toBeCloseTo(0, 5);
            const s2 = new CharacterController(TP);
            s2.update(0.5, { ...NO_INPUT, forward: -1 });
            expect(s2.pos[2]).toBeCloseTo(-1, 5);  // S = toward the camera
            const d = new CharacterController(TP);
            d.update(0.5, { ...NO_INPUT, right: 1 });
            expect(d.pos[0]).toBeCloseTo(-1, 5);   // D = screen-right (−X for a +Z camera)
        });

        it('mouse / look input orbits the camera only — standing still, the body never turns', () => {
            const c = new CharacterController(TP);
            for (let i = 0; i < 120; i++) c.update(1 / 60, { ...NO_INPUT, lookYaw: 0.05, look: 1 });
            expect(Math.abs(c.yaw)).toBeGreaterThan(1);   // the camera went round
            expect(c.facing).toBe(0);                     // the character stayed put
            // Releasing the stick after moving keeps the last facing, also while orbiting.
            c.update(1 / 60, { ...NO_INPUT, forward: 1 });
            const f = c.facing;
            for (let i = 0; i < 60; i++) c.update(1 / 60, { ...NO_INPUT, lookYaw: 0.05 });
            expect(c.facing).toBeCloseTo(f, 9);
        });

        it('the body turns SMOOTHLY toward the move direction (not instantly) and converges', () => {
            const c = new CharacterController({ ...TP, faceTurnRate: 14, maxTurnSpeed: 12 });
            c.update(1 / 60, { ...NO_INPUT, forward: -1 });            // run toward the camera: target facing = π
            expect(Math.abs(c.facing)).toBeGreaterThan(0);
            expect(Math.abs(c.facing)).toBeLessThan(Math.PI / 2);        // one tick is only part of the turn
            for (let i = 0; i < 40; i++) c.update(1 / 60, { ...NO_INPUT, forward: -1 });
            expect(Math.abs(wrapAngle(c.facing - Math.PI))).toBeLessThan(0.02);
        });

        it('first-person: the body facing IS the look yaw', () => {
            const c = new CharacterController({ ...INSTANT, cameraMode: 'first' });
            c.update(1 / 60, { ...NO_INPUT, lookYaw: 0.4 });
            expect(c.facing).toBeCloseTo(c.yaw, 9);
        });

        it('holding forward while orbiting runs in circles (facing follows the camera, path curves)', () => {
            const c = new CharacterController({ ...TP });
            const pts: [number, number][] = [];
            for (let i = 0; i < 360; i++) {
                c.update(1 / 60, { ...NO_INPUT, forward: 1, lookYaw: (2 * Math.PI) / 360 });   // one full orbit in 6 s
                pts.push([c.pos[0], c.pos[2]]);
            }
            // Closed loop: end near the start; the path spans a circle of diameter 2·v/ω.
            const R = 2 / ((2 * Math.PI) / 6);
            const xs = pts.map((p) => p[0]);
            expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2 * R, 0);
            expect(Math.hypot(c.pos[0], c.pos[2])).toBeLessThan(0.5);
            expect(Math.abs(wrapAngle(c.facing - c.yaw))).toBeLessThan(0.2);   // facing tracks the travel direction
        });

        it('setHeading points camera + body the same way; renderPos interpolates the last step', () => {
            const c = new CharacterController(TP);
            c.setHeading(1.2);
            expect(c.yaw).toBeCloseTo(1.2, 9); expect(c.facing).toBeCloseTo(1.2, 9);
            c.update(0.5, { ...NO_INPUT, forward: 1 });
            const mid = c.renderPos(0.5);
            expect(mid[0]).toBeCloseTo(c.pos[0] / 2, 6);
            expect(mid[2]).toBeCloseTo(c.pos[2] / 2, 6);
            expect(c.renderPos(1)).toEqual(c.pos);
        });

        it('turnToward takes the shortest arc and caps the turn speed', () => {
            expect(turnToward(3, -3, 0, 0, 1 / 60)).toBeCloseTo(-3, 9);                 // rate 0 = snap
            expect(turnToward(0, Math.PI - 0.01, 1000, 6, 0.1)).toBeCloseTo(0.6, 6);     // capped at 6 rad/s × 0.1 s
            expect(turnToward(3.1, -3.1, 1000, 100, 1)).toBeCloseTo(-3.1, 6);            // across ±π, not the long way
        });
    });

    describe('R6.2: walk / run + speed easing', () => {
        it('toggleRun switches the full-input speed between run (moveSpeed) and walk (× walkSpeedFactor)', () => {
            const c = new CharacterController({ ...INSTANT, moveSpeed: 4, walkSpeedFactor: 0.4 });
            expect(c.running).toBe(true);
            c.update(1, { ...NO_INPUT, forward: 1 });
            expect(c.lastPlanarSpeed).toBeCloseTo(4, 5);
            expect(c.toggleRun()).toBe(false);
            c.update(1, { ...NO_INPUT, forward: 1 });
            expect(c.lastPlanarSpeed).toBeCloseTo(1.6, 5);
            c.update(1, { ...NO_INPUT, forward: 0.5 });                  // analog still scales the walk
            expect(c.lastPlanarSpeed).toBeCloseTo(0.8, 5);
            c.toggleRun();
            expect(c.targetTopSpeed()).toBe(4);
        });

        it('speed ramps up on start and eases down to a full stop on release (no snap)', () => {
            const c = new CharacterController({ moveSpeed: 3.5, acceleration: 9, deceleration: 11 });
            c.update(1 / 60, { ...NO_INPUT, forward: 1 });
            expect(c.lastPlanarSpeed).toBeGreaterThan(0.1);
            expect(c.lastPlanarSpeed).toBeLessThan(1);
            for (let i = 0; i < 60; i++) c.update(1 / 60, { ...NO_INPUT, forward: 1 });
            expect(c.lastPlanarSpeed).toBeCloseTo(3.5, 1);
            c.update(1 / 60, NO_INPUT);
            expect(c.lastPlanarSpeed).toBeGreaterThan(2);                  // still coasting one tick after release
            for (let i = 0; i < 60; i++) c.update(1 / 60, NO_INPUT);
            expect(c.lastPlanarSpeed).toBe(0);                             // settled, not creeping forever
        });
    });

    describe('R6.2: ground rules in the controller', () => {
        it('a jump never gets pulled UP onto a surface above where the feet started the step', () => {
            const c = new CharacterController({ jumpSpeed: 5, gravity: 10, stepHeight: 0.4 });
            c.groundSampler = () => 0;
            c.update(1 / 60, { ...NO_INPUT, jump: true });
            // Mid-rise, a sampler now reports a surface 0.3 above the current feet (e.g. an overhead underside).
            const feet = c.pos[1];
            c.groundSampler = () => feet + 0.3;
            c.update(1 / 60, NO_INPUT);
            expect(c.grounded).toBe(false);
            expect(c.pos[1]).toBeLessThan(feet + 0.3);
        });

        it('walking down a step ≤ stepHeight stays grounded (glued); a taller drop falls', () => {
            const c = new CharacterController({ ...INSTANT, stepHeight: 0.4 });
            c.groundSampler = (x) => (x < -0.5 ? -0.3 : 0);   // a 0.3 step down beyond x = −0.5 (D walks −X)
            for (let i = 0; i < 30; i++) c.update(1 / 60, { ...NO_INPUT, right: 1 });
            expect(c.pos[0]).toBeLessThan(-0.5);
            expect(c.pos[1]).toBeCloseTo(-0.3, 6);
            expect(c.grounded).toBe(true);
            const d = new CharacterController({ ...INSTANT, stepHeight: 0.4 });
            d.groundSampler = (x) => (x < -0.5 ? -5 : 0);
            for (let i = 0; i < 30; i++) d.update(1 / 60, { ...NO_INPUT, right: 1 });
            expect(d.pos[0]).toBeLessThan(-0.5);
            expect(d.grounded).toBe(false);                    // off a ledge: falling, not teleported down
        });
    });
});

describe('CharacterController — Round 8 gaits + jump feel', () => {
    const tick = (c: CharacterController, n: number, input = NO_INPUT) => { for (let i = 0; i < n; i++) c.update(1 / 60, input); };
    const FWD = { ...NO_INPUT, forward: 1 };

    it('three gaits: walk (walkSpeed), run (moveSpeed), sneak (sneakSpeed — wins over run); analog scales each', () => {
        const c = new CharacterController({ acceleration: 0, deceleration: 0 });
        c.running = false;
        c.update(1 / 60, FWD); expect(c.lastPlanarSpeed).toBeCloseTo(DEFAULT_CHARACTER.walkSpeed, 6);
        c.running = true;
        c.update(1 / 60, FWD); expect(c.lastPlanarSpeed).toBeCloseTo(DEFAULT_CHARACTER.moveSpeed, 6);
        c.sneaking = true;
        expect(c.gait()).toBe('sneak');
        c.update(1 / 60, FWD); expect(c.lastPlanarSpeed).toBeCloseTo(DEFAULT_CHARACTER.sneakSpeed, 6);
        c.update(1 / 60, { ...NO_INPUT, forward: 0.5 }); expect(c.lastPlanarSpeed).toBeCloseTo(DEFAULT_CHARACTER.sneakSpeed * 0.5, 6);
        expect(DEFAULT_CHARACTER.moveSpeed).toBeGreaterThan(3 * DEFAULT_CHARACTER.walkSpeed);   // a TRUE run
    });

    it('snappy acceleration: walk speed in ~0.1 s, run speed in ~0.35 s, a stop from a run in ~0.3 s — no long tail', () => {
        const c = new CharacterController();
        c.running = false;
        tick(c, 6, FWD);                                                 // 0.1 s
        expect(c.lastPlanarSpeed).toBeGreaterThan(0.9 * DEFAULT_CHARACTER.walkSpeed);
        c.running = true;
        tick(c, 21, FWD);                                                // +0.35 s
        expect(c.lastPlanarSpeed).toBeGreaterThan(0.95 * DEFAULT_CHARACTER.moveSpeed);
        let n = 0;
        while (c.lastPlanarSpeed > 0 && n < 120) { c.update(1 / 60, NO_INPUT); n++; }
        expect(n / 60).toBeLessThan(0.35);
        expect(n / 60).toBeGreaterThan(0.1);                             // eased, not a dead stop
    });

    it('a reversal decelerates THROUGH zero (the velocity is a vector) instead of snapping round at full speed', () => {
        const c = new CharacterController({ cameraMode: 'third' });
        tick(c, 60, FWD);
        const zs: number[] = [];
        for (let i = 0; i < 40; i++) { c.update(1 / 60, { ...NO_INPUT, forward: -1 }); zs.push(c.vel[2]); }
        expect(zs[0]).toBeGreaterThan(3);                                // still moving forward the first tick
        expect(Math.min(...zs.map(Math.abs))).toBeLessThan(0.6);         // passed (near) zero
        expect(zs[zs.length - 1]).toBeLessThan(-0.95 * DEFAULT_CHARACTER.moveSpeed);   // and runs back at full speed
    });

    it('jump height ≈ 1.0–1.2 m with the button held; a tap is a short hop (variable height); ~0.6 s in the air', () => {
        const hold = new CharacterController();
        let maxY = 0, t = 0;
        hold.update(1 / 60, { ...NO_INPUT, jump: true });
        while (!hold.grounded && t < 300) { hold.update(1 / 60, { ...NO_INPUT, jump: true }); maxY = Math.max(maxY, hold.pos[1]); t++; }
        expect(maxY).toBeGreaterThan(1.0); expect(maxY).toBeLessThan(1.2);
        expect(t / 60).toBeGreaterThan(0.5); expect(t / 60).toBeLessThan(0.75);
        const tap = new CharacterController();
        tap.update(1 / 60, { ...NO_INPUT, jump: true });
        let tapMax = 0;
        for (let i = 0; i < 120; i++) { tap.update(1 / 60, NO_INPUT); tapMax = Math.max(tapMax, tap.pos[1]); }
        expect(tapMax).toBeLessThan(0.7 * maxY);
        expect(tapMax).toBeGreaterThan(0.35);
        // variableJumpHeight: false → the tap is full height.
        const full = new CharacterController({ variableJumpHeight: false });
        full.update(1 / 60, { ...NO_INPUT, jump: true });
        let fullMax = 0;
        for (let i = 0; i < 120; i++) { full.update(1 / 60, NO_INPUT); fullMax = Math.max(fullMax, full.pos[1]); }
        expect(fullMax).toBeGreaterThan(0.95 * maxY - 0.05);
    });

    it('descent is snappier than the rise (fall gravity), and holding the button hangs a moment at the apex', () => {
        const c = new CharacterController();
        c.update(1 / 60, { ...NO_INPUT, jump: true });
        let up = 1, down = 0, apexTicks = 0;
        while (c.vel[1] > 0) { c.update(1 / 60, { ...NO_INPUT, jump: true }); up++; if (Math.abs(c.vel[1]) < DEFAULT_CHARACTER.apexHangSpeed) apexTicks++; }
        while (!c.grounded) { c.update(1 / 60, { ...NO_INPUT, jump: true }); down++; }
        expect(down).toBeLessThan(up);
        expect(apexTicks).toBeGreaterThan(3);
    });

    it('holding jump does not bunny-hop; a press just BEFORE landing is buffered and jumps on touch-down', () => {
        const c = new CharacterController();
        tick(c, 1, { ...NO_INPUT, jump: true });
        let landedAt = -1;
        for (let i = 0; i < 90; i++) { c.update(1 / 60, { ...NO_INPUT, jump: true }); if (c.grounded && landedAt < 0) landedAt = i; }
        expect(landedAt).toBeGreaterThan(0);
        expect(c.grounded).toBe(true);                                   // held the whole time: no second jump
        // Buffer: release, then press ~0.08 s before landing.
        const b = new CharacterController();
        b.update(1 / 60, { ...NO_INPUT, jump: true });
        while (!(b.vel[1] < 0 && b.pos[1] < 0.35)) b.update(1 / 60, NO_INPUT);
        b.update(1 / 60, { ...NO_INPUT, jump: true });                   // pressed in the air
        let relaunched = false;
        for (let i = 0; i < 20; i++) { b.update(1 / 60, { ...NO_INPUT, jump: true }); if (b.vel[1] > 5) relaunched = true; }
        expect(relaunched).toBe(true);
    });

    it('coyote time: a jump just after walking off a ledge still works; late is too late', () => {
        const mk = () => { const c = new CharacterController({ acceleration: 0, deceleration: 0 }); c.groundSampler = (x) => (x < -0.3 ? null : 0); c.cfg.groundY = -10; return c; };
        const c = mk();
        while (c.grounded) c.update(1 / 60, { ...NO_INPUT, right: 1 });   // walk off (D = −X)
        c.update(1 / 60, { ...NO_INPUT, right: 1 }); c.update(1 / 60, { ...NO_INPUT, right: 1, jump: true });
        expect(c.vel[1]).toBeGreaterThan(5);                              // ~2 ticks late: still jumps
        const late = mk();
        while (late.grounded) late.update(1 / 60, { ...NO_INPUT, right: 1 });
        for (let i = 0; i < 12; i++) late.update(1 / 60, { ...NO_INPUT, right: 1 });
        late.update(1 / 60, { ...NO_INPUT, right: 1, jump: true });
        expect(late.vel[1]).toBeLessThan(0);                              // 0.2 s: falls
    });

    it('air control: momentum is kept with no input and steering is limited; landing reports the impact', () => {
        const c = new CharacterController();
        tick(c, 60, FWD);
        const v0 = c.vel[2];
        c.update(1 / 60, { ...FWD, jump: true });
        tick(c, 10, { ...NO_INPUT, jump: true });
        expect(c.vel[2]).toBeCloseTo(v0, 3);                             // released the stick: carried on
        tick(c, 10, { ...NO_INPUT, forward: -1, jump: true });
        expect(c.grounded).toBe(false);
        expect(c.vel[2]).toBeGreaterThan(0);                              // can not reverse in 1/6 s mid-air
        let impact = 0;
        for (let i = 0; i < 120 && !c.grounded; i++) { c.update(1 / 60, NO_INPUT); impact = Math.max(impact, c.landImpact); }
        expect(impact).toBeGreaterThan(0.5);
        c.update(1 / 60, NO_INPUT);
        expect(c.locomotion().landImpact).toBe(0);                        // only on the landing tick
    });

    it('falls are capped at maxFallSpeed; air phase goes 0 → 0.5 → 1 over a jump', () => {
        const c = new CharacterController({ groundY: -1000 }, [0, 0, 0]);
        c.grounded = false;
        tick(c, 600);
        expect(c.vel[1]).toBeCloseTo(-DEFAULT_CHARACTER.maxFallSpeed, 6);
        const j = new CharacterController();
        j.update(1 / 60, { ...NO_INPUT, jump: true });
        expect(j.locomotion().airPhase!).toBeLessThan(0.1);
        while (j.vel[1] > 0) j.update(1 / 60, { ...NO_INPUT, jump: true });
        expect(j.locomotion().airPhase!).toBeCloseTo(0.5, 1);
        while (!j.grounded) {
            const ph = j.locomotion().airPhase!;
            j.update(1 / 60, { ...NO_INPUT, jump: true });
            if (!j.grounded) expect(j.locomotion().airPhase!).toBeGreaterThanOrEqual(ph - 1e-9);
        }
    });
});

describe('CharacterController — item 13 jump wind-up', () => {
    it('jumpWindup: a ground jump crouches first (still grounded, progress 0 to 1), then launches; 0 = on the press tick', () => {
        const c = new CharacterController({ jumpWindup: 0.06 });
        c.update(1 / 60, { ...NO_INPUT, jump: true });
        expect(c.grounded).toBe(true);
        const w0 = c.locomotion().jumpWindup!;
        expect(w0).toBeGreaterThan(0);
        c.update(1 / 60, NO_INPUT);                                      // a tap: released during the wind-up still jumps
        expect(c.locomotion().jumpWindup!).toBeGreaterThan(w0);
        let ticks = 1;
        while (c.grounded && ticks < 20) { c.update(1 / 60, NO_INPUT); ticks++; }
        expect(ticks).toBeGreaterThanOrEqual(3); expect(ticks).toBeLessThanOrEqual(5);   // about 60 ms
        expect(c.vel[1]).toBeGreaterThan(0);
        expect(c.locomotion().jumpWindup).toBe(0);
        const d = new CharacterController();
        d.update(1 / 60, { ...NO_INPUT, jump: true });
        expect(d.grounded).toBe(false);                                  // the pure default: unchanged
    });
    it('turnRemaining: how far the body still has to turn toward the move direction (third-person)', () => {
        const c = new CharacterController({ cameraMode: 'third' });
        c.update(1 / 60, { ...NO_INPUT, right: -1 });                   // move screen-LEFT (+X) from facing +Z: a left turn
        expect(c.turnRemaining()).toBeGreaterThan(0.5);
        for (let i = 0; i < 60; i++) c.update(1 / 60, { ...NO_INPUT, right: -1 });
        expect(Math.abs(c.turnRemaining())).toBeLessThan(1e-3);
        c.update(1 / 60, NO_INPUT);
        expect(c.turnRemaining()).toBe(0);
    });
});
