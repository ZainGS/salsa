/**
 * view-cull.test.ts — T7.5: city culling / LOD is CAMERA-aware, so a low-pitch street-level view keeps its
 * surroundings (the old flat-footprint projection culled the tile you stand in when looking up at the buildings).
 */
import { describe, it, expect } from 'vitest';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { tileViewRank, cityLodMetric, frustumPlanes, boxInFrustum } from './view-cull';

const vpOf = (pos: [number, number, number], tgt: [number, number, number]): { vp: Float32Array; cam: Camera3D } => {
    const cam = new Camera3D({ position: pos, target: tgt, fov: 0.9, near: 0.05, far: 2000 });
    cam.aspect = 16 / 9;
    return { vp: cam.getViewProjectionMatrix() as Float32Array, cam };
};

/** The PRE-T7.5 test (flat ground footprint corners → NDC bbox), kept here to pin the regression. */
function oldFootprintRank(m: Float32Array, wx: number, wy: number, wz: number, r: number, MARGIN = 0.2): number {
    let anyFront = false, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let c = 0; c < 4; c++) {
        const x = wx + (c === 0 || c === 3 ? -r : r), z = wz + (c < 2 ? -r : r);
        const cw = m[3] * x + m[7] * wy + m[11] * z + m[15];
        if (cw <= 1e-4) continue;
        anyFront = true;
        const nx = (m[0] * x + m[4] * wy + m[8] * z + m[12]) / cw, ny = (m[1] * x + m[5] * wy + m[9] * z + m[13]) / cw;
        minX = Math.min(minX, nx); maxX = Math.max(maxX, nx); minY = Math.min(minY, ny); maxY = Math.max(maxY, ny);
    }
    if (!anyFront || maxX < -1 - MARGIN || minX > 1 + MARGIN || maxY < -1 - MARGIN || minY > 1 + MARGIN) return -1;
    return ((minX + maxX) / 2) ** 2 + ((minY + maxY) / 2) ** 2;
}

describe('tileViewRank (camera-aware tile cull + rank)', () => {
    const r = 10, span = 20, H = 9;
    it('street level, looking UP at the buildings: the tile you stand in stays (old footprint test culled it)', () => {
        const { vp, cam } = vpOf([2, 0.15, 3], [2, 4, -3]);   // eye height, pitched up ~34°
        expect(oldFootprintRank(vp, 0, 0, 0, r)).toBe(-1);   // the bug
        expect(tileViewRank(vp, cam.position, 0, 0, 0, r, H, 0.2, span)).toBeGreaterThanOrEqual(0);
    });
    it('street level, low pitch: the neighbour ahead stays, the one behind the camera drops', () => {
        const { vp, cam } = vpOf([0, 0.15, 5], [0, 0.1, -5]);   // looking along −Z
        expect(tileViewRank(vp, cam.position, 0, 0, -span, r, H, 0.2, span)).toBeGreaterThanOrEqual(0);
        expect(tileViewRank(vp, cam.position, 0, 0, 2 * span, r, H, 0.2, span)).toBe(-1);
    });
    it('ranks by CAMERA distance: the tile you are in < the one ahead < two ahead', () => {
        const { vp, cam } = vpOf([0, 0.15, 5], [0, 0.1, -5]);
        const a = tileViewRank(vp, cam.position, 0, 0, 0, r, H, 0.2, span);
        const b = tileViewRank(vp, cam.position, 0, 0, -span, r, H, 0.2, span);
        const c = tileViewRank(vp, cam.position, 0, 0, -2 * span, r, H, 0.2, span);
        expect(a).toBeLessThan(b);
        expect(b).toBeLessThan(c);
    });
    it('top-down overview: in-view tiles pass, far-off-screen tiles cull (the zoomed-out behaviour is kept)', () => {
        const { vp, cam } = vpOf([0, 60, 30], [0, 0, 0]);
        expect(tileViewRank(vp, cam.position, 0, 0, 0, r, H, 0.2, span)).toBeGreaterThanOrEqual(0);
        expect(tileViewRank(vp, cam.position, 400, 0, 0, r, H, 0.2, span)).toBe(-1);
    });
    it('the frustum test never culls a box that contains the camera', () => {
        const { vp } = vpOf([0, 1, 0], [0, 1, -1]);
        expect(boxInFrustum(frustumPlanes(vp, 0), -1, 0, -1, 1, 2, 1)).toBe(true);
    });
});

describe('cityLodMetric (camera-aware detail tiers)', () => {
    const R = 16;
    it('overview at ~30° pitch over the city: same as the orbit radius (tier thresholds unchanged)', () => {
        const r = 40, el = Math.PI / 6;
        const cam = [0, r * Math.sin(el), r * Math.cos(el)];   // pivot at the centre
        expect(cityLodMetric(cam, r, 0, 0, R, 0, 0)).toBeCloseTo(r, 6);
    });
    it('street level near the edge while orbiting a FAR pivot: collapses → the detail around the lens stays', () => {
        expect(cityLodMetric([R - 1, 0.1, 0], 60, 0, 0, R, 0, 0)).toBeLessThan(1);
        expect(cityLodMetric([R + 3, 0.1, 0], 60, 0, 0, R, 0, 0)).toBeCloseTo(2 * Math.hypot(3, 0.1), 6);
    });
    it('never exceeds the orbit radius (it can only SHOW more detail than before, never cull more)', () => {
        expect(cityLodMetric([500, 300, 0], 10, 0, 0, R, 0, 0)).toBe(10);
    });
});
