/**
 * scene-frame.test.ts — T7.2 "return to the scene": bounds skip far decoration (sky / void grid / apron) + hidden
 * meshes; the pose fits the content and keeps (or lifts) the current view direction.
 */
import { describe, it, expect } from 'vitest';
import { sceneFrameBounds, framePose, type Box3 } from './scene-frame';
import { Camera3D } from '../../renderer/3d/camera-3d';

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box3 => ({ minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 });
const mesh = (b: Box3 | null, o: { exclude?: boolean; hidden?: boolean } = {}) => ({ b, frameExclude: !!o.exclude, isEffectivelyVisible: () => !o.hidden });

describe('sceneFrameBounds', () => {
    it('unions visible content and ignores frameExclude (sky dome / void grid / apron) + hidden meshes', () => {
        const ms = [
            mesh(box(-10, 0, -10, 10, 5, 10)),                                   // the city
            mesh(box(-200, -1, -200, 200, 90, 200), { exclude: true }),          // sky stars dome
            mesh(box(-500, 0, -500, 500, 0, 500), { exclude: true }),            // void grid
            mesh(box(300, 0, 300, 310, 3, 310), { hidden: true }),               // a hidden far thing
            mesh(box(NaN, 0, 0, 1, 1, 1)),                                       // broken bounds
            mesh(null),
            mesh(box(8, 0, 8, 12, 2, 12)),                                       // a prop poking past the city edge
        ];
        expect(sceneFrameBounds(ms, (m) => m.b)).toEqual(box(-10, 0, -10, 12, 5, 12));
    });
    it('null when nothing qualifies', () => {
        expect(sceneFrameBounds([mesh(box(0, 0, 0, 1, 1, 1), { exclude: true })], (m) => m.b)).toBeNull();
    });
});

describe('framePose', () => {
    const b = box(-10, 0, -10, 10, 4, 10);
    it('perspective: keeps the current view direction and fits the BOX tightly (binding corner on the padded edge)', () => {
        const p = framePose(b, [1, 1, 1], { mode: 'perspective', fov: Math.PI / 4, aspect: 1.5, padding: 1.2 });
        expect(p.target).toEqual([0, 2, 0]);
        const v = [p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]];
        const d = Math.hypot(v[0], v[1], v[2]);
        expect(v[0] / d).toBeCloseTo(1 / Math.sqrt(3), 5);
        expect(v[1] / d).toBeCloseTo(1 / Math.sqrt(3), 5);
        const cam = new Camera3D({ position: p.position, target: p.target, fov: Math.PI / 4, near: 0.01, far: 1000 });
        cam.aspect = 1.5;
        const m = cam.getViewProjectionMatrix() as Float32Array;
        let maxN = 0;
        for (let c = 0; c < 8; c++) {
            const x = c & 1 ? b.maxX : b.minX, y = c & 2 ? b.maxY : b.minY, z = c & 4 ? b.maxZ : b.minZ;
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            expect(w).toBeGreaterThan(0);
            maxN = Math.max(maxN, Math.abs((m[0] * x + m[4] * y + m[8] * z + m[12]) / w), Math.abs((m[1] * x + m[5] * y + m[9] * z + m[13]) / w));
        }
        expect(maxN).toBeCloseTo(1 / 1.2, 3);   // every corner on screen; the binding one exactly on the padded edge
    });
    it('a below-horizon / street-level direction is lifted to a readable 3/4 view (heading kept)', () => {
        const p = framePose(b, [0, -0.2, 1], { mode: 'perspective', fov: 0.8, aspect: 1, minElevation: 0.12, liftTo: 0.5 });
        const v = [p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]];
        const d = Math.hypot(v[0], v[1], v[2]);
        expect(Math.asin(v[1] / d)).toBeCloseTo(0.5, 5);
        expect(v[0]).toBeCloseTo(0, 6);
        expect(v[2]).toBeGreaterThan(0);
    });
    it('ortho: sets an orthoSize that encloses the content', () => {
        const p = framePose(b, [0, 1, 0.5], { mode: 'orthographic', fov: 0.8, aspect: 2, padding: 1 });
        expect(p.orthoSize).toBeCloseTo(p.radius, 6);
        expect(p.orthoSize!).toBeGreaterThan(10);
    });
});
