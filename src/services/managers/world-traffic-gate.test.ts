/** world-traffic-gate.test.ts — T7.3 mover pose gate: distance cadence + in-view test. */
import { describe, it, expect } from 'vitest';
import { moverPoseInterval, pointInView } from './world-traffic';
import { Camera3D } from '../../renderer/3d/camera-3d';

describe('moverPoseInterval', () => {
    it('near movers pose every frame; mid every 2nd; far every 3rd; big / fast kinds always', () => {
        expect(moverPoseInterval(5, 20, 'walker')).toBe(1);
        expect(moverPoseInterval(20, 20, 'walker')).toBe(2);
        expect(moverPoseInterval(40, 20, 'car')).toBe(3);
        expect(moverPoseInterval(40, 20, 'cloud')).toBe(2);
        expect(moverPoseInterval(400, 20, 'train')).toBe(1);
        expect(moverPoseInterval(400, 20, 'flyer')).toBe(1);
    });
});

describe('pointInView', () => {
    const cam = new Camera3D({ position: [0, 1, 5], target: [0, 1, 0], fov: 0.9, near: 0.05, far: 500 });
    const vp = cam.getViewProjectionMatrix() as Float32Array;
    it('in front + on screen → true; behind or far off to the side → false', () => {
        expect(pointInView(vp, 0, 1, -3, 1.35)).toBe(true);
        expect(pointInView(vp, 0, 1, 9, 1.35)).toBe(false);
        expect(pointInView(vp, 80, 1, -3, 1.35)).toBe(false);
    });
});
