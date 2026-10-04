/**
 * orbit-dolly.test.ts — T7.1: the free-3D wheel zoom never "slows down" and has no near stall.
 */
import { describe, it, expect } from 'vitest';
import { wheelDollyStep, wheelSteps, OrbitController } from './orbit-controller';
import { Camera3D } from './camera-3d';

describe('wheelDollyStep', () => {
    it('classic mode is the old multiplicative, clamped dolly (unchanged for Edit-Mesh / packaging orbit)', () => {
        let r = 10;
        for (let i = 0; i < 200; i++) r = wheelDollyStep(r, -1, 0.1, 0.1, 50, false, 1).radius;
        expect(r).toBeCloseTo(0.1, 6);                    // stalls at minRadius…
        const steps: number[] = []; r = 1;
        for (let i = 0; i < 5; i++) { const n = wheelDollyStep(r, -1, 0.1, 0.01, 50, false, 1).radius; steps.push(r - n); r = n; }
        for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1]);   // …by ever-smaller steps
        expect(wheelDollyStep(40, 1, 0.1, 0.1, 50, false, 1).radius).toBe(44);
        expect(wheelDollyStep(48, 1, 0.1, 0.1, 50, false, 1).radius).toBe(50);   // max clamp
    });

    it('dolly-through: the camera advance per step never drops below floor × speed, the pivot is pushed', () => {
        const floor = 2, speed = 0.1;
        let r = 20, travelled = 0, minStep = Infinity;
        for (let i = 0; i < 300; i++) {
            const s = wheelDollyStep(r, -1, speed, 1e-4, 1e5, true, floor);
            const step = (r - s.radius) + s.push;          // camera travel = radius shrink + pivot push
            minStep = Math.min(minStep, step); travelled += step;
            expect(s.radius).toBeGreaterThanOrEqual(floor - 1e-9);
            r = s.radius;
        }
        expect(minStep).toBeGreaterThanOrEqual(floor * speed - 1e-9);   // constant-rate floor: never slows down
        expect(travelled).toBeGreaterThan(20 + 250 * floor * speed * 0.9);   // flew THROUGH the old pivot and kept going
    });

    it('dolly-through far away is still multiplicative (fast across big distances) and zoom-out is unbounded-ish', () => {
        const s = wheelDollyStep(1000, -1, 0.1, 1e-4, 1e5, true, 2);
        expect(s.radius).toBeCloseTo(900, 6); expect(s.push).toBe(0);
        let r = 50; for (let i = 0; i < 60; i++) r = wheelDollyStep(r, 1, 0.1, 1e-4, 1e5, true, 2).radius;
        expect(r).toBeGreaterThan(5000);                  // the old City-mode cap was 50
    });

    it('OrbitController.dolly pushes the target along the view ray and keeps the camera moving forward', () => {
        const cam = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0], sceneRadius: 10 });
        const orb = new OrbitController(cam);
        orb.dollyThrough = true; orb.minRadius = 1e-4; orb.maxRadius = 1e5; orb.dollyFloor = 1;   // the host sets it from the framed content
        let prevZ = cam.position[2];
        for (let i = 0; i < 80; i++) {
            orb.dolly(-1);
            const dz = prevZ - cam.position[2];
            expect(dz).toBeGreaterThanOrEqual(0.1 - 1e-6);   // ≥ floor × zoomSpeed every step
            prevZ = cam.position[2];
        }
        expect(cam.position[2]).toBeLessThan(-2);           // flew past the original pivot at z = 0
        expect(cam.target[2]).toBeLessThan(cam.position[2]);  // pivot stays AHEAD of the camera
    });
});

describe('wheelSteps — only a real vertical scroll dollies (free-3D camera flew forward forever)', () => {
    it('ignores deltaY 0 / sub-pixel jitter (horizontal tilt, trackpad sideways, inertial tails)', () => {
        const st = { _wheelAcc: 0 };
        for (let i = 0; i < 500; i++) expect(wheelSteps(st, 0)).toBe(0);
        for (let i = 0; i < 500; i++) expect(wheelSteps(st, i % 2 ? 0.3 : -0.3)).toBe(0);
    });
    it('one mouse notch = one step each way; lines mode scaled', () => {
        const st = { _wheelAcc: 0 };
        expect(wheelSteps(st, 100)).toBe(1);
        expect(wheelSteps(st, -100)).toBe(-1);
        expect(wheelSteps(st, -120)).toBe(-1);
        expect(wheelSteps(st, 3, 1)).toBe(1);   // Firefox: 3 lines ≈ 99 px
    });
    it('small trackpad deltas accumulate; a direction flip resets; a flick is capped', () => {
        const st = { _wheelAcc: 0 };
        let n = 0; for (let i = 0; i < 10; i++) n += wheelSteps(st, -10);
        expect(n).toBe(-1);
        wheelSteps(st, -60); expect(wheelSteps(st, 20)).toBe(0); expect(st._wheelAcc).toBe(20);
        expect(wheelSteps({ _wheelAcc: 0 }, -2000)).toBe(-3);
    });
});
