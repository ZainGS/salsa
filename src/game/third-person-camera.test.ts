import { describe, it, expect } from 'vitest';
import { ThirdPersonCamera, avatarCameraFraming } from './third-person-camera';
import { DEFAULT_CHARACTER, type Vec3 } from './character-controller';
import type { RayCaster } from './collision-math';

const CFG = { ...DEFAULT_CHARACTER, thirdPersonDistance: 4.5, cameraShoulderOffset: 0 };
const inp = (pivot: Vec3, yaw = 0, pitch = 0, velX = 0, velZ = 0) => ({ pivot, yaw, pitch, velX, velZ });
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** An infinite wall plane x = wx (hit by any ray crossing it). */
function wallAtX(wx: number): RayCaster {
    return (o, d, max) => {
        if (Math.abs(d[0]) < 1e-9) return null;
        const t = (wx - o[0]) / d[0];
        return t >= 0 && t <= max ? { distance: t, normal: [1, 0, 0] } : null;
    };
}

describe('ThirdPersonCamera (R6.2)', () => {
    it('first frame snaps: the eye sits `distance` behind the pivot along the look direction', () => {
        const cam = new ThirdPersonCamera();
        const r = cam.update(1 / 60, inp([0, 1.4, 0]), CFG);
        expect(r.eye[2]).toBeCloseTo(-4.5, 6);       // yaw 0 looks +Z → camera at −Z
        expect(r.eye[1]).toBeCloseTo(1.4, 6);
        expect(r.target).toEqual([0, 1.4, 0]);
    });

    it('orbit is crisp (yaw applies immediately), follow lags (pivot eases toward the character)', () => {
        const cam = new ThirdPersonCamera();
        cam.update(1 / 60, inp([0, 1.4, 0]), CFG);
        const r = cam.update(1 / 60, inp([0, 1.4, 0], Math.PI / 2), CFG);
        expect(r.eye[0]).toBeCloseTo(-4.5, 6);       // swung round instantly
        const cam2 = new ThirdPersonCamera();
        cam2.update(1 / 60, inp([0, 1.4, 0]), { ...CFG, cameraLookAhead: 0 });
        const r2 = cam2.update(1 / 60, inp([1, 1.4, 0]), { ...CFG, cameraLookAhead: 0 });
        expect(r2.target[0]).toBeGreaterThan(0);
        expect(r2.target[0]).toBeLessThan(1);        // trailing, not rigid
    });

    it('follow smoothing is frame-rate independent (30 vs 144 fps land in the same place)', () => {
        const run = (fps: number) => {
            const cam = new ThirdPersonCamera();
            cam.update(1 / fps, inp([0, 1.4, 0]), CFG);
            let t = 0, r = cam.update(0, inp([0, 1.4, 0]), CFG);
            while (t < 0.5 - 1e-9) { t += 1 / fps; r = cam.update(1 / fps, inp([3 * t, 1.4, 0], 0, 0, 3, 0), CFG); }
            return r.target[0];
        };
        expect(Math.abs(run(30) - run(144))).toBeLessThan(0.08);
    });

    it('vertical follow is softer than horizontal (a step / jump does not jolt the view)', () => {
        const cam = new ThirdPersonCamera();
        cam.update(1 / 60, inp([0, 1.4, 0]), { ...CFG, cameraLookAhead: 0 });
        const r = cam.update(1 / 60, inp([0.4, 1.8, 0]), { ...CFG, cameraLookAhead: 0 });
        expect(r.target[1] - 1.4).toBeLessThan((r.target[0]) );   // moved less in Y than in X for the same offset
    });

    it('the lag is leashed: a fast mover is never lost', () => {
        const cam = new ThirdPersonCamera();
        cam.update(1 / 60, inp([0, 1.4, 0]), { ...CFG, cameraLookAhead: 0 });
        const r = cam.update(1 / 60, inp([20, 1.4, 0]), { ...CFG, cameraLookAhead: 0 });
        expect(dist(r.target, [20, 1.4, 0])).toBeLessThanOrEqual(4.5 * 0.35 + 1e-6);
    });

    it('look-ahead leads the pivot in the direction of travel', () => {
        const cam = new ThirdPersonCamera();
        let r = cam.update(1 / 60, inp([0, 1.4, 0], 0, 0, 3.5, 0), CFG);
        for (let i = 0; i < 120; i++) r = cam.update(1 / 60, inp([0, 1.4, 0], 0, 0, 3.5, 0), CFG);
        expect(r.target[0]).toBeGreaterThan(0.5);    // 0.2 s × 3.5 m/s ≈ 0.7 m ahead
    });

    it('collision pulls in IMMEDIATELY when a wall is behind, then eases back out when it clears', () => {
        const cam = new ThirdPersonCamera();
        const wall = wallAtX(-2);                  // camera looks +X (yaw π/2 ... use yaw −π/2 → looks −X? choose yaw π/2)
        // yaw = π/2 → forward +X, camera behind at −X: the wall at x = −2 sits between.
        cam.update(1 / 60, inp([0, 1.4, 0], Math.PI / 2), CFG, null);
        const hit = cam.update(1 / 60, inp([0, 1.4, 0], Math.PI / 2), CFG, wall);
        expect(cam.distance).toBeLessThan(2);       // in front of the wall this very frame
        expect(hit.eye[0]).toBeGreaterThan(-2);
        const clear = cam.update(1 / 60, inp([0, 1.4, 0], Math.PI / 2), CFG, null);
        expect(cam.distance).toBeGreaterThan(1.7);
        expect(cam.distance).toBeLessThan(4.5);     // recovering, not popping back
        void clear;
        for (let i = 0; i < 180; i++) cam.update(1 / 60, inp([0, 1.4, 0], Math.PI / 2), CFG, null);
        expect(cam.distance).toBeCloseTo(4.5, 2);
    });

    it('a thin prop only ONE edge ray grazes is ignored (no pop-in); a real obstruction the bundle hits pulls in', () => {
        // A vertical slab behind the camera line (plane z = −2) spanning x ∈ [x0, x1].
        const slab = (x0: number, x1: number): RayCaster => (o, d, max) => {
            if (Math.abs(d[2]) < 1e-9) return null;
            const t = (-2 - o[2]) / d[2];
            if (t < 0 || t > max) return null;
            const x = o[0] + d[0] * t;
            return x >= x0 && x <= x1 ? { distance: t, normal: [0, 0, 1] } : null;
        };
        const cam = new ThirdPersonCamera();
        cam.update(1 / 60, inp([0, 1.4, 0]), { ...CFG, cameraCollisionRadius: 0.2 }, slab(0.15, 0.25));   // thin post: one ray
        expect(cam.distance).toBeCloseTo(4.5, 6);
        const up: RayCaster = (o, d, max) => {   // a wide obstruction below y = 1.3 (the camera is pitched below the pivot)
            if (Math.abs(d[2]) < 1e-9) return null;
            const t = (-2 - o[2]) / d[2];
            if (t < 0 || t > max) return null;
            const y = o[1] + d[1] * t;
            return y <= 1.3 ? { distance: t, normal: [0, 0, 1] } : null;
        };
        const cam2 = new ThirdPersonCamera();
        cam2.update(1 / 60, inp([0, 1.4, 0], 0, 0.3), { ...CFG, cameraCollisionRadius: 0.2 }, up);
        expect(cam2.distance).toBeLessThan(2);
    });
});

describe('ThirdPersonCamera — Round 8 jumps', () => {
    it('a jump rise is followed only partly (the view does not bob with every hop); a drop below take-off is followed fully', () => {
        const cam = new ThirdPersonCamera();
        cam.update(1 / 60, inp([0, 1.4, 0]), CFG);
        for (let i = 0; i < 120; i++) cam.update(1 / 60, { ...inp([0, 1.4 + 1.1, 0]), airborne: true }, CFG);
        expect(cam.target[1]).toBeLessThan(1.4 + 0.5);            // ~35 % of the 1.1 m rise
        expect(cam.target[1]).toBeGreaterThan(1.4 + 0.2);
        const off = new ThirdPersonCamera();
        off.update(1 / 60, inp([0, 1.4, 0]), CFG);
        for (let i = 0; i < 240; i++) off.update(1 / 60, { ...inp([0, 1.4 - 3, 0]), airborne: true }, CFG);
        expect(off.target[1]).toBeCloseTo(1.4 - 3, 1);             // falling off a ledge: follows all the way down
    });
});

describe('avatarCameraFraming — any-size Player (2026-10-01)', () => {
    /** The avatar's standing AABB (feet at the origin, facing +Z): shoulders + arms ±0.17·H, depth ±0.1·H. */
    const inside = (e: Vec3, H: number) => Math.abs(e[0]) < 0.17 * H && Math.abs(e[2]) < 0.1 * H && e[1] > 0 && e[1] < H;
    /** A wall plane z = wz behind the avatar (the camera sits at −Z for yaw 0). */
    const wallBehind = (wz: number): RayCaster => (o, d, max) => {
        if (d[2] >= -1e-9) return null;
        const t = (wz - o[2]) / d[2];
        return t >= 0 && t <= max ? { distance: t, normal: [0, 0, 1] } : null;
    };
    const frame = (H: number) => {
        const eye = H * 0.9;
        const f = avatarCameraFraming(H, eye, DEFAULT_CHARACTER);
        return { cfg: { ...DEFAULT_CHARACTER, eyeHeight: eye, ...f }, pivotY: eye + f.thirdPersonHeight };
    };

    it('a 1.7-unit avatar gets exactly the metre defaults; everything scales linearly with H', () => {
        const f = avatarCameraFraming(1.7, 1.53, DEFAULT_CHARACTER);
        expect(f.cameraMinDistance).toBeCloseTo(DEFAULT_CHARACTER.cameraMinDistance, 9);
        expect(f.cameraCollisionRadius).toBeCloseTo(DEFAULT_CHARACTER.cameraCollisionRadius, 9);
        expect(f.cameraCollisionPadding).toBeCloseTo(DEFAULT_CHARACTER.cameraCollisionPadding, 9);
        expect(f.thirdPersonDistance).toBeCloseTo(1.7 * 1.8, 9);
        expect(1.53 + f.thirdPersonHeight).toBeCloseTo(1.7 * 0.76, 9);         // chest pivot (visual-polish 7a; was 0.8)
        const g = avatarCameraFraming(25.5, 22.95, DEFAULT_CHARACTER);         // a 1.7-unit body in a 15 m/unit city
        expect(g.cameraMinDistance / f.cameraMinDistance).toBeCloseTo(15, 6);
        expect(g.thirdPersonDistance / f.thirdPersonDistance).toBeCloseTo(15, 6);
    });

    for (const [label, H] of [['small (0.11 units: 1.7 m in a city)', 0.1133], ['normal (1.7)', 1.7], ['giant (25.5: a generated body in a city, metre-for-metre)', 25.5]] as const) {
        it(`the camera is never inside a ${label} avatar — open space, and pulled in by a wall right behind it`, () => {
            const { cfg, pivotY } = frame(H);
            for (let pitch = cfg.thirdPersonPitchMin; pitch <= cfg.thirdPersonPitchMax + 1e-9; pitch += 0.05) {
                for (const cast of [null, wallBehind(-0.2 * H)]) {
                    const cam = new ThirdPersonCamera();
                    const r = cam.update(1 / 60, inp([0, pivotY, 0], 0, pitch), cfg, cast);
                    expect(inside(r.eye, H), `pitch ${pitch.toFixed(2)} wall ${!!cast} eye ${r.eye.map((v) => v.toFixed(3))}`).toBe(false);
                    if (!cast) expect(cam.distance).toBeCloseTo(H * 1.8, 6);
                }
            }
        });
    }

    it('regression: a giant user Player whose own top is hit by the camera ray — old metre-in-city values parked the eye inside its body', () => {
        const H = 1.7, mpu = 15;                                   // a generated 1.7-unit body in a city
        const ownTop: RayCaster = (o, d, max) => (0.08 * H <= max ? { distance: 0.08 * H, normal: [0, 0, 1] } : null);   // the back of its own garment
        const eye = H * 0.9, pivot: Vec3 = [0, H * 0.8, 0];
        const old = { ...DEFAULT_CHARACTER, eyeHeight: eye, thirdPersonDistance: H * 2.6, cameraMinDistance: 0.5 / mpu, cameraCollisionRadius: 0.2 / mpu, cameraCollisionPadding: 0.25 / mpu };
        const a = new ThirdPersonCamera().update(1 / 60, inp(pivot, 0, -0.3), old, ownTop);
        expect(inside(a.eye, H)).toBe(true);                        // the reported bug: "the camera got stuck in the head"
        const { cfg } = frame(H);
        const b = new ThirdPersonCamera().update(1 / 60, inp(pivot, 0, -0.3), cfg, ownTop);
        expect(inside(b.eye, H)).toBe(false);                       // even before the own-parts exclusion, the min distance clears the body
    });
});
