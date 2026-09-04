import { describe, it, expect } from 'vitest';
import { CharacterController, NO_INPUT } from './character-controller';

describe('CharacterController', () => {
    it('moves forward along +Z at yaw 0', () => {
        const c = new CharacterController({ moveSpeed: 2 });
        c.update(0.5, { ...NO_INPUT, forward: 1 });
        expect(c.pos[2]).toBeCloseTo(1, 5);   // 2 u/s × 0.5 s
        expect(c.pos[0]).toBeCloseTo(0, 5);
    });

    it('turns with look input, then moves along the new facing', () => {
        const c = new CharacterController({ moveSpeed: 1, turnSpeed: Math.PI });   // π rad/s
        c.update(1, { ...NO_INPUT, look: 0.5 });   // +π·0.5 = 90° → faces +X
        expect(c.yaw).toBeCloseTo(Math.PI / 2, 5);
        c.update(1, { ...NO_INPUT, forward: 1 });
        expect(c.pos[0]).toBeCloseTo(1, 4);        // now forward is +X
        expect(c.pos[2]).toBeCloseTo(0, 4);
    });

    it('normalizes diagonal movement (not faster than cardinal)', () => {
        const c = new CharacterController({ moveSpeed: 1 });
        c.update(1, { ...NO_INPUT, forward: 1, right: 1 });
        expect(Math.hypot(c.pos[0], c.pos[2])).toBeCloseTo(1, 4);   // 1 u/s, not √2
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
        expect(c.yaw).toBeCloseTo(0.3, 5);
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
        const c = new CharacterController({ moveSpeed: 3, jumpSpeed: 5, gravity: 10 });
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
});
