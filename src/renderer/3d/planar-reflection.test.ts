import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { projectPoint, norm3, type Vec3 } from './ssr-trace';
import {
    reflectionMatrix, reflectPointAcrossPlane, mirroredViewProj, clipPlaneFor, clipPlaneSide, reflectorPlane,
} from './planar-reflection';

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The mirror fragment F at which a viewer at C sees object point P (virtual-image construction — ground truth). */
function analyticFragment(C: Vec3, planePoint: Vec3, n: Vec3, P: Vec3): Vec3 {
    const Pv = reflectPointAcrossPlane(P, planePoint, n);
    const dir = sub3(Pv, C);
    const s = dot3(sub3(planePoint, C), n) / dot3(dir, n);
    return add3(C, scale3(dir, s));
}

describe('planar reflection math', () => {
    const floorPoint: Vec3 = [0, 0, 0];
    const floorN: Vec3 = [0, 1, 0];

    it('reflectionMatrix reflects points, fixes the plane, and is involutory', () => {
        const M = reflectionMatrix(floorPoint, floorN);
        // reflects
        const p: Vec3 = [1, 2, -3];
        const r = [M[0] * 1 + M[4] * 2 + M[8] * -3 + M[12], M[1] * 1 + M[5] * 2 + M[9] * -3 + M[13], M[2] * 1 + M[6] * 2 + M[10] * -3 + M[14]] as Vec3;
        expect(r[0]).toBeCloseTo(1, 6); expect(r[1]).toBeCloseTo(-2, 6); expect(r[2]).toBeCloseTo(-3, 6);
        expect(reflectPointAcrossPlane(p, floorPoint, floorN)[1]).toBeCloseTo(-2, 6);
        // plane points fixed
        const onPlane = reflectPointAcrossPlane([5, 0, 7], floorPoint, floorN);
        expect(onPlane[1]).toBeCloseTo(0, 9);
        // involution: reflect twice = identity
        const twice = reflectPointAcrossPlane(reflectPointAcrossPlane(p, floorPoint, floorN), floorPoint, floorN);
        expect(twice[0]).toBeCloseTo(p[0], 9); expect(twice[1]).toBeCloseTo(p[1], 9); expect(twice[2]).toBeCloseTo(p[2], 9);
    });

    it('THE SAMPLING CONTRACT (perspective): mirroredVP projects P to the mirror fragment that shows P', () => {
        const eye: Vec3 = [0.4, 1.5, 3.5];
        const view = mat4.lookAt(mat4.create(), [0.4, 1.5, 3.5], [0, 0.3, -1], [0, 1, 0]);
        const proj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1.3, 0.1, 100);
        const vp = mat4.multiply(mat4.create(), proj, view) as Float32Array;
        const mvp = mirroredViewProj(vp, floorPoint, floorN);
        // Sweep points ABOVE the floor — including BOTTOM-face-style points the real camera cannot see.
        for (const P of [[0, 0.5, -1], [0.6, 0.9, -0.5], [-0.5, 0.2, -1.4], [0.2, 1.1, -2]] as Vec3[]) {
            const F = analyticFragment(eye, floorPoint, floorN, P);
            const expected = projectPoint(vp, F);          // where the mirror fragment sits on screen
            const got = projectPoint(mvp, P);              // where the mirrored render draws P
            expect(got.visible).toBe(true);
            expect(got.uv[0]).toBeCloseTo(expected.uv[0], 4);
            expect(got.uv[1]).toBeCloseTo(expected.uv[1], 4);
        }
    });

    it('THE SAMPLING CONTRACT (orthographic / isometric)', () => {
        const view = mat4.lookAt(mat4.create(), [4, 4, 4], [0, 0, 0], [0, 1, 0]);
        const proj = mat4.orthoZO(mat4.create(), -3, 3, -3, 3, 0.1, 100);
        const vp = mat4.multiply(mat4.create(), proj, view) as Float32Array;
        const mvp = mirroredViewProj(vp, floorPoint, floorN);
        const fwd = norm3([-1, -1, -1] as Vec3);
        for (const P of [[0, 0.6, 0], [0.8, 0.4, -0.5], [-0.6, 1.0, 0.4]] as Vec3[]) {
            // ortho virtual-image fragment: F = intersection of the view ray through virtualImage(P) with the plane
            const Pv = reflectPointAcrossPlane(P, floorPoint, floorN);
            const s = dot3(sub3(floorPoint, Pv), floorN) / dot3(scale3(fwd, -1), floorN);
            const F = add3(Pv, scale3(scale3(fwd, -1), s));
            const expected = projectPoint(vp, F);
            const got = projectPoint(mvp, P);
            expect(got.uv[0]).toBeCloseTo(expected.uv[0], 4);
            expect(got.uv[1]).toBeCloseTo(expected.uv[1], 4);
        }
    });

    it('clip plane keeps the reflective side and discards behind the mirror', () => {
        const camera: Vec3 = [0, 2, 3];
        const plane = clipPlaneFor(floorPoint, floorN, camera);
        expect(clipPlaneSide(plane, [0, 1, 0])).toBeGreaterThan(0);    // above the floor → kept
        expect(clipPlaneSide(plane, [0, -1, 0])).toBeLessThan(0);      // below the floor → discarded
        // orientation flips automatically if the normal points away from the camera side
        const flipped = clipPlaneFor(floorPoint, [0, -1, 0], camera);
        expect(clipPlaneSide(flipped, [0, 1, 0])).toBeGreaterThan(0);
    });

    it('reflectorPlane derives the world plane from a model matrix', () => {
        const model = mat4.create();
        mat4.translate(model, model, [2, 0.5, -1]);
        mat4.rotateY(model, model, Math.PI / 4);
        const { point, normal } = reflectorPlane(model as Float32Array, [0, 0.5, 0], [0, 1, 0]);
        expect(point[1]).toBeCloseTo(1.0, 6);                 // top face lifted by translation
        expect(normal[0]).toBeCloseTo(0, 6);                  // Y rotation keeps an up normal up
        expect(normal[1]).toBeCloseTo(1, 6);
        expect(normal[2]).toBeCloseTo(0, 6);
    });
});
