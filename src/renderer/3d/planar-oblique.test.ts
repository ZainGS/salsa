import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { obliqueProjectionZO, planeTimesMat, reflectionMatrix, clipPlaneFor } from './planar-reflection';
import { transformPoint4, type Vec3 } from './ssr-trace';

/** clip = M·(p,1) → ndc. */
function ndcOf(m: Float32Array | number[], p: Vec3): { x: number; y: number; z: number; w: number } {
    const c = transformPoint4(m as Float32Array, p);
    return { x: c[0] / c[3], y: c[1] / c[3], z: c[2] / c[3], w: c[3] };
}

/** World plane (keep dot(n,p) ≥ d) → view-space row plane via C_view = C_world · V⁻¹. */
function viewPlane(view: mat4, worldPlane: [number, number, number, number]): [number, number, number, number] {
    const inv = mat4.invert(mat4.create(), view)!;
    return planeTimesMat([worldPlane[0], worldPlane[1], worldPlane[2], -worldPlane[3]], inv as Float32Array);
}

describe('oblique near-plane projection (ZO) — the planar-reflection clip', () => {
    // Mirror plane z = -2, reflective side +Z (the camera side).
    const worldPlane: [number, number, number, number] = [0, 0, 1, -2];   // keep: z ≥ -2

    it('PERSPECTIVE: the clip plane becomes the near plane; screen x/y are untouched', () => {
        // Camera BEHIND the plane looking through it (the mirrored camera's configuration — the method's
        // precondition: the keep side must be the frustum's far side).
        const view = mat4.lookAt(mat4.create(), [0.4, 0.3, -9], [0, 0, 2], [0, 1, 0]);
        const proj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1.3, 0.1, 100);
        const projInv = mat4.invert(mat4.create(), proj)!;
        const pv = viewPlane(view, worldPlane);
        const pob = obliqueProjectionZO(proj as Float32Array, projInv as Float32Array, pv);
        const vpOb = mat4.multiply(mat4.create(), pob as unknown as mat4, view) as Float32Array;
        const vp = mat4.multiply(mat4.create(), proj, view) as Float32Array;

        for (const p of [[0.5, 0.4, -2], [-1, 0.2, -2], [0, -0.8, -2]] as Vec3[]) {
            expect(Math.abs(ndcOf(vpOb, p).z)).toBeLessThan(1e-4);        // ON the plane → ndc z ≈ 0 (the near plane)
        }
        for (const p of [[0.3, 0.1, -1], [0.8, -0.4, 0.5], [0, 0, 3]] as Vec3[]) {
            const a = ndcOf(vpOb, p), b = ndcOf(vp, p);
            expect(a.z).toBeGreaterThan(0);                                // keep side → in front of the new near plane
            expect(Math.abs(a.x - b.x)).toBeLessThan(1e-5);                // x/y rows untouched → identical screen pos
            expect(Math.abs(a.y - b.y)).toBeLessThan(1e-5);
        }
        for (const p of [[0.2, 0.3, -2.5], [0, 0, -4]] as Vec3[]) {
            expect(ndcOf(vpOb, p).z).toBeLessThan(0);                      // behind the mirror (camera side) → clipped
        }
    });

    it('ORTHOGRAPHIC: same contract (the w-row trick covers ortho too)', () => {
        const view = mat4.lookAt(mat4.create(), [1.5, 1, -9], [0, 0, 2], [0, 1, 0]);
        const proj = mat4.orthoZO(mat4.create(), -3, 3, -3, 3, 0.1, 100);
        const projInv = mat4.invert(mat4.create(), proj)!;
        const pv = viewPlane(view, worldPlane);
        const pob = obliqueProjectionZO(proj as Float32Array, projInv as Float32Array, pv);
        const vpOb = mat4.multiply(mat4.create(), pob as unknown as mat4, view) as Float32Array;
        const vp = mat4.multiply(mat4.create(), proj, view) as Float32Array;

        expect(Math.abs(ndcOf(vpOb, [0.7, -0.5, -2]).z)).toBeLessThan(1e-4);
        const a = ndcOf(vpOb, [0.4, 0.6, 0.5]), b = ndcOf(vp, [0.4, 0.6, 0.5]);
        expect(a.z).toBeGreaterThan(0);
        expect(Math.abs(a.x - b.x)).toBeLessThan(1e-5);
        expect(Math.abs(a.y - b.y)).toBeLessThan(1e-5);
        expect(ndcOf(vpOb, [0.4, 0.6, -3]).z).toBeLessThan(0);   // behind the mirror (camera side) → clipped
    });

    it('MIRRORED pass integration: front-of-mirror geometry survives, behind-mirror geometry clips', () => {
        // The mirrored camera VP' = P_oblique · (V · M): renders the ORIGINAL world; the oblique plane (in the
        // MIRRORED view space) discards what lies behind the mirror.
        const eye: Vec3 = [0, 0.5, 5];
        const view = mat4.lookAt(mat4.create(), [0, 0.5, 5], [0, 0, 0], [0, 1, 0]);
        const proj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1, 0.1, 100);
        const planePoint: Vec3 = [0, 0, -2];
        const planeNormal: Vec3 = [0, 0, 1];
        const refl = reflectionMatrix(planePoint, planeNormal);
        const vm = mat4.multiply(mat4.create(), view, refl as unknown as mat4);
        const vmInv = mat4.invert(mat4.create(), vm)!;
        const cw = clipPlaneFor(planePoint, planeNormal, eye);            // keep = the camera's (reflective) side
        const pv = planeTimesMat([cw[0], cw[1], cw[2], -cw[3]], vmInv as Float32Array);
        const projInv = mat4.invert(mat4.create(), proj)!;
        const pob = obliqueProjectionZO(proj as Float32Array, projInv as Float32Array, pv);
        const vpm = mat4.multiply(mat4.create(), pob as unknown as mat4, vm) as Float32Array;

        const front = ndcOf(vpm, [0.8, 0.4, 0]);                          // an object between camera and mirror
        expect(front.z).toBeGreaterThan(0);
        expect(front.z).toBeLessThan(1.0001);
        const behind = ndcOf(vpm, [0.5, 0.2, -3]);                        // wall behind the mirror
        expect(behind.z).toBeLessThan(0);
    });
});
