import { describe, it, expect } from 'vitest';
import { classifyCameraOccluder, cameraOccluderScale, isCameraBlockMode, type CameraOccluderInfo, type CameraBlockMode } from './camera-occluders';
import { ThirdPersonCamera } from './third-person-camera';
import { DEFAULT_CHARACTER, type Vec3 } from './character-controller';
import type { RayCaster } from './collision-math';

const S = cameraOccluderScale(1.7);
const info = (p: Partial<CameraOccluderInfo>): CameraOccluderInfo => ({ names: [], fogClass: 0, character: false, mover: false, extents: [10, 10, 10], ...p });
const hard = (p: Partial<CameraOccluderInfo>, prev?: boolean) => classifyCameraOccluder(info(p), S, prev).hard;

describe('camera occluder classes', () => {
    it('city street furniture, trees, signs, wires and crowd are soft; buildings, ground, bridges, stairs are hard', () => {
        for (const n of ['world:util-pole', 'world:lightpoles', 'world:signal-housing', 'world:tree-trunks', 'world:apron-foliage',
            'world:roadsign-stop', 'world:sign-board', 'util-wire', 'world:bench', 'world:bicycle', 'world:bollard', 'world:vending-body',
            'world:car-body', 'world:ped-0', 'world:traffic-walker', 'world:guardrail', 'world:bridge-rail', 'world:stair-rail',
            'world:detail-awning', 'world:detail-windowtrim', 'world:detail-sign-text', 'world:detail-juliet', 'awning-3', 'world:lamp-banner', 'world:rail-fine-cat-wire', 'world:busstop'])
            expect(hard({ names: [n] }), n).toBe(false);
        for (const n of ['world:buildings', 'World Tile 0', 'world:roads', 'world:sidewalks', 'world:rail-viaduct', 'world:rail-deck',
            'world:bridge', 'world:bridge-stone', 'world:stairs', 'world:retaining', 'world:shopfront', 'world:metro-kiosk',
            // the building generator's facade layers are walls, even though its trim / signs / awnings are soft
            'world:detail-wall', 'world:detail-wallbase#3', 'world:detail-partywall', 'world:detail-shop-glass', 'world:detail-storefront',
            'world:detail-shutter', 'world:detail-door', 'world:detail-parapet', 'world:metro-glass'])
            expect(hard({ names: [n] }), n).toBe(true);
    });

    it('a family stamped on an ANCESTOR group classes its meshes; the prop tier fog class alone does not make stairs soft', () => {
        expect(hard({ names: ['mesh 12', 'world:util-pole', 'World Tile 2'] })).toBe(false);
        expect(hard({ names: ['world:stairs'], fogClass: 2 })).toBe(true);
    });

    it('fog classes 1 (attachment) and 2 (other) are soft; class 0 falls to the size rule', () => {
        expect(hard({ fogClass: 1 })).toBe(false);
        expect(hard({ fogClass: 2 })).toBe(false);
        expect(hard({ fogClass: 0, extents: [8, 12, 6] })).toBe(true);
    });

    it('size rule: thin (a pole / post) and small (a crate) are soft; a wall panel, a big box and a ground plane are hard', () => {
        expect(hard({ extents: [0.25, 6, 0.25] })).toBe(false);        // a pole
        expect(hard({ extents: [0.05, 0.05, 30] })).toBe(false);       // a wire
        expect(hard({ extents: [0.9, 0.9, 0.9] })).toBe(false);        // a crate
        expect(hard({ extents: [3, 2.5, 0.2] })).toBe(true);           // a wall panel
        expect(hard({ extents: [40, 0.1, 40] })).toBe(true);           // the ground
        expect(hard({ extents: [2, 2, 2] })).toBe(true);
        expect(hard({ extents: null })).toBe(true);                    // no bounds yet: block (never a camera inside a wall)
    });

    it('the size thresholds follow the avatar (a giant ignores a 1 m box, a doll does not)', () => {
        const giant = cameraOccluderScale(17), doll = cameraOccluderScale(0.17);
        expect(classifyCameraOccluder(info({ extents: [1, 1, 1] }), giant).hard).toBe(false);
        expect(classifyCameraOccluder(info({ extents: [1, 1, 1] }), doll).hard).toBe(true);
    });

    it('hysteresis: a mesh near a threshold keeps its previous class', () => {
        const e: [number, number, number] = [0.52, 3, 0.52];          // just over the 0.5 m thin threshold
        expect(hard({ extents: e })).toBe(true);
        expect(hard({ extents: e }, false)).toBe(false);               // was soft: stays soft inside the band
        const e2: [number, number, number] = [0.48, 3, 0.48];
        expect(hard({ extents: e2 })).toBe(false);
        expect(hard({ extents: e2 }, true)).toBe(true);                // was hard: stays hard inside the band
        expect(hard({ extents: [0.3, 3, 0.3] }, true)).toBe(false);    // clearly thin: flips
    });

    it('characters and movers are never hard, even with block-sized bounds; the override beats every rule', () => {
        expect(hard({ character: true, extents: [5, 5, 5] })).toBe(false);
        expect(hard({ mover: true, extents: [5, 5, 5] })).toBe(false);
        expect(hard({ cameraBlock: 'block', names: ['world:util-pole'], extents: [0.2, 6, 0.2] })).toBe(true);
        expect(hard({ cameraBlock: 'ignore', names: ['world:buildings'] })).toBe(false);
        expect(hard({ cameraBlock: 'block', character: true })).toBe(true);
        expect(hard({ cameraBlock: 'auto', extents: [0.2, 6, 0.2] })).toBe(false);
        expect(['auto', 'block', 'ignore', 'x', undefined].map(isCameraBlockMode)).toEqual([true, true, true, false, false]);
    });
});

// ── The camera with the classes: an axis-aligned box world, cast through a classifier-filtered list ──────────────────
interface Box { name: string; min: Vec3; max: Vec3; fogClass?: number; cameraBlock?: CameraBlockMode }
function boxCaster(boxes: Box[]): RayCaster {
    const blocks = boxes.filter((b) => classifyCameraOccluder(info({
        names: [b.name], fogClass: b.fogClass ?? 0, cameraBlock: b.cameraBlock,
        extents: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] }), S).hard);
    return (o, d, max) => {
        let best = Infinity;
        for (const b of blocks) {
            let t0 = 0, t1 = max;
            for (let a = 0; a < 3; a++) {
                if (Math.abs(d[a]) < 1e-12) { if (o[a] < b.min[a] || o[a] > b.max[a]) { t0 = Infinity; break; } continue; }
                let ta = (b.min[a] - o[a]) / d[a], tb = (b.max[a] - o[a]) / d[a];
                if (ta > tb) [ta, tb] = [tb, ta];
                t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
            }
            if (t0 <= t1 && t0 < best) best = t0;
        }
        return best <= max ? { distance: best, normal: [0, 0, 1] } : null;
    };
}

describe('third-person camera with hard / soft occluders', () => {
    const CFG = { ...DEFAULT_CHARACTER, thirdPersonDistance: 3, cameraShoulderOffset: 0, cameraCollisionRadius: 0.2 };
    const run = (boxes: Box[]): number => {
        const cam = new ThirdPersonCamera();
        const cast = boxCaster(boxes);
        // yaw 0 looks +Z: the camera sits behind the pivot at -Z
        cam.update(1 / 60, { pivot: [0, 1.3, 0], yaw: 0, pitch: 0, velX: 0, velZ: 0 }, CFG, cast);
        return cam.distance;
    };
    // a lamp post right behind the player, centred on the camera ray
    const pole: Box = { name: 'world:lightpoles', min: [-0.12, 0, -1.6], max: [0.12, 6, -1.36] };
    const wall: Box = { name: 'world:buildings', min: [-10, 0, -1.6], max: [10, 12, -1.2], fogClass: 0 };

    it('a lamp post, a tree and a parked car behind the player: no pull-in', () => {
        expect(run([pole])).toBeCloseTo(3, 6);
        expect(run([{ name: 'world:tree-trunks', min: [-0.3, 0, -2], max: [0.3, 8, -1.4], fogClass: 2 }])).toBeCloseTo(3, 6);
        expect(run([{ name: 'world:car-body', min: [-1, 0, -2.5], max: [1, 1.5, -1] }])).toBeCloseTo(3, 6);
        expect(run([{ name: 'my post', min: [-0.1, 0, -1.6], max: [0.1, 3, -1.4] }])).toBeCloseTo(3, 6);   // an authored thin post
    });

    it('a building wall behind the player still pulls the camera in (in front of the wall)', () => {
        const d = run([wall, pole]);
        expect(d).toBeLessThan(1.2);
        expect(d).toBeGreaterThanOrEqual(CFG.cameraMinDistance - 1e-9);
    });

    it('the override is respected: a blocked pole pulls in, an ignored wall does not', () => {
        expect(run([{ ...pole, cameraBlock: 'block' }])).toBeLessThan(1.4);
        expect(run([{ ...wall, cameraBlock: 'ignore' }])).toBeCloseTo(3, 6);
    });
});
