import { describe, it, expect } from 'vitest';
import { deriveCameraPose, frustumCorners, frustumLineSegments, FRUSTUM_EDGES, type Vec3, type CameraSettings } from './camera-math';

// column-major identity
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('deriveCameraPose', () => {
    it('identity → eye at origin, looking down −Z, up +Y', () => {
        const p = deriveCameraPose(IDENTITY);
        expect(p.eye).toEqual([0, 0, 0]);
        expect(p.forward.map(v => +v.toFixed(6) + 0)).toEqual([0, 0, -1]);
        expect(p.up.map(v => +v.toFixed(6) + 0)).toEqual([0, 1, 0]);
    });

    it('reads the translation column as the eye', () => {
        const m = [...IDENTITY]; m[12] = 3; m[13] = 4; m[14] = 5;
        expect(deriveCameraPose(m).eye).toEqual([3, 4, 5]);
    });

    it('a 90°-about-Y rotation aims forward down +X', () => {
        // rotY(90°): X-axis→−Z, Z-axis→+X. Column-major: col0=(0,0,-1), col1=(0,1,0), col2=(1,0,0).
        const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
        const m = [c, 0, -s, 0,  0, 1, 0, 0,  s, 0, c, 0,  0, 0, 0, 1];
        const p = deriveCameraPose(m);
        // forward = −Z axis = −(col2) = (−s,0,−c) = (−1,0,0)
        expect(p.forward.map(v => +v.toFixed(6) + 0)).toEqual([-1, 0, 0]);
    });
});

describe('frustumCorners (perspective)', () => {
    const persp: CameraSettings = { fov: Math.PI / 2, projection: 'perspective', near: 1, far: 2 };   // 90° → tan=1
    const pose = deriveCameraPose(IDENTITY);   // origin, −Z, +Y
    const c = frustumCorners(pose, persp, 1);

    it('has 8 corners, near ones at z=−near and far at z=−far', () => {
        expect(c).toHaveLength(8);
        for (let i = 0; i < 4; i++) expect(close(c[i][2], -1)).toBe(true);   // near plane
        for (let i = 4; i < 8; i++) expect(close(c[i][2], -2)).toBe(true);   // far plane
    });

    it('sizes the near/far rects by tan(fov/2)·distance·aspect', () => {
        // fov 90 → tan=1; near=1 → half-extent 1; aspect 1 → x half = 1
        // near TL = (−1, 1, −1)
        expect(c[0].map(v => +v.toFixed(6) + 0)).toEqual([-1, 1, -1]);
        // far BR = (2, −2, −2)
        expect(c[6].map(v => +v.toFixed(6) + 0)).toEqual([2, -2, -2]);
    });

    it('aspect widens the horizontal extent only', () => {
        const wide = frustumCorners(pose, persp, 2);   // aspect 2
        expect(close(Math.abs(wide[0][0]), 2)).toBe(true);   // x half = tan·near·aspect = 2
        expect(close(Math.abs(wide[0][1]), 1)).toBe(true);   // y half unchanged = 1
    });
});

describe('frustumCorners (orthographic)', () => {
    it('is a box: near size = far size = orthoSize', () => {
        const ortho: CameraSettings = { fov: 0, projection: 'orthographic', orthoSize: 3, near: 1, far: 5 };
        const c = frustumCorners(deriveCameraPose(IDENTITY), ortho, 1);
        // near TL and far TL share x/y (a box), only z differs
        expect(close(c[0][0], c[4][0])).toBe(true);
        expect(close(c[0][1], c[4][1])).toBe(true);
        expect(close(Math.abs(c[0][1]), 3)).toBe(true);   // orthoSize
    });
});

describe('FRUSTUM_EDGES', () => {
    it('12 edges, each referencing valid corners', () => {
        expect(FRUSTUM_EDGES).toHaveLength(12);
        for (const [a, b] of FRUSTUM_EDGES) { expect(a).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(8); expect(a).not.toBe(b); }
    });
    it('frustumLineSegments returns 12 world-space segments', () => {
        const segs = frustumLineSegments(deriveCameraPose(IDENTITY), { fov: 1, projection: 'perspective', near: 1, far: 2 }, 1);
        expect(segs).toHaveLength(12);
        for (const [p0, p1] of segs) { expect(p0).toHaveLength(3); expect(p1).toHaveLength(3); }
    });
});
