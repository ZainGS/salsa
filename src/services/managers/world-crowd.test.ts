/**
 * world-crowd.test.ts — performance-plan P12: the instanced crowd's tier manager (WorldCrowd) against a fake world.
 *
 * Pins: a cell shows XFAR until a lazily built tier is resident, then the wanted tier (near inside the first twin
 * distance, mid inside the second) with the renderer's 10 % hysteresis; the shown tier is written into the meshes'
 * externally driven twin state and the xfar copies hide exactly for the cells not showing xfar; a live-crowd person's
 * copy hides and comes back; distance LOD off = mid; leaving the radius evicts the lazy tiers; a vanished build drops.
 */
import { describe, it, expect } from 'vitest';
import { WorldCrowd } from './world-crowd';
import { generateCityLayout } from '../../world/layout';
import { buildPedestriansInstanced, CREC_STRIDE, CREC_X, CREC_Y, CREC_Z } from '../../world/crowd-instanced';
import type { LayoutPreviewLayer } from '../../world/types';
import type { InstanceOverride } from '../../scene-graph/shapes/array-group-3d';

type FakeMesh = Record<string, unknown> & { name: string; visible: boolean; lodTwinNear: boolean; lodTwinNear2: boolean; lodTwinRole: number; material: Record<string, unknown>; parent: unknown };
function fakeWorld(layers: LayoutPreviewLayer[]) {
    const added: FakeMesh[] = [], removed: FakeMesh[] = [];
    let repacks = 0;
    const cam = { mode: 'perspective', fov: Math.PI / 4, position: [0, 0.2, 0] as number[], orthoSize: 1,
        // a VP that keeps everything "in view"
        getViewProjectionMatrix: () => Float32Array.of(1e-3, 0, 0, 0, 0, 1e-3, 0, 0, 0, 0, 1e-4, 0, 0, 0, 0.5, 1) };
    const r3 = { distanceLod: true, orthoScreenLod: true, distanceLodScale: 1, lodResolutionScale: 1, warmGeometry: () => true };
    const group = { name: 'World Pedestrians', children: [] as unknown[] };
    // the xfar sources + groups the scene manager would make for the instanced layers
    let id = 0;
    for (const L of layers) {
        if (!L.crowdInst) continue;
        const src = { id: `s${id}`, name: L.name, visible: true, lodTwinDist: L.nearTwin!.dist, lodTwinDist2: L.nearTwin!.dist2, lodTwinNear: false, lodTwinNear2: true,
            material: { diffuse: { r: 0.6, g: 0.6, b: 0.6, a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 } }, drawDistance: 0, drawDistanceBias: 0, shadowFeatureSize: 0, fogClass: 2 };
        const T = L.instances!;
        const ov = new Map<number, InstanceOverride>(T.map((_, i) => [i, {}]));
        const arr = { id: `a${id++}`, sourceId: src.id, crowdId: L.crowdInst.id, crowdPi: Int32Array.from(T, t => t.pi!), instanceOverrides: ov, arrayParams: { mode: 'explicit', offsets: T.map(t => [t.x, t.y, t.z]) } };
        group.children.push(src, arr);
    }
    const w = {
        _groups: [group], _meshSetEpoch: 1, cityRoot: { localMatrix: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) },
        _dressCrowdMesh: () => {},
        scene3d: {
            getCamera: () => cam, renderer3D: r3,
            hasMeshGeometry3D: () => true,
            addProceduralMesh3D: (g: { children: unknown[] }, name: string, geometry: unknown) => { const m: FakeMesh = { name, geometry, visible: true, lodTwinNear: false, lodTwinNear2: false, lodTwinRole: 0, material: {}, parent: g }; g.children.push(m); added.push(m); return m; },
            removeProceduralMesh3D: (m: FakeMesh) => { const g = m.parent as { children: unknown[] }; g.children.splice(g.children.indexOf(m), 1); m.parent = null; removed.push(m); },
            repackArrayGroups3D: (s: Set<unknown>) => { repacks += s.size; return s.size; },
            notifySceneStructureChanged3D: () => {}, notifyVisibilityChanged3D: () => {}, requestRender3D: () => {},
        },
    };
    const crowd = new WorldCrowd(w as never);
    crowd.register(group as never, layers);
    return { crowd, cam, r3, group, added, removed, w, repacks: () => repacks };
}
const run = (c: WorldCrowd, n = 400): void => { for (let i = 0; i < n; i++) c.update(); };

describe('WorldCrowd tiers', () => {
    const graph = generateCityLayout({ seed: 5, radius: 10, pattern: 'grid', border: 'square' });
    const layers = buildPedestriansInstanced(graph, null);
    const rec = layers.find(L => L.crowdRecords)!.crowdRecords!;
    // pick a person; stand the camera 1 m above their feet
    const P = 7, o = P * CREC_STRIDE;
    const feet = [rec.recs[o + CREC_X], rec.recs[o + CREC_Y], rec.recs[o + CREC_Z]];
    type Arr = { crowdPi: Int32Array; instanceOverrides: Map<number, InstanceOverride> };
    const copyOf = (g: { children: unknown[] }, p: number): InstanceOverride => {
        for (const a of g.children as Arr[]) if (a.crowdPi) { const j = Array.from(a.crowdPi).indexOf(p); if (j >= 0) return a.instanceOverrides.get(j)!; }
        throw new Error('no copy');
    };

    it('builds near + mid lazily, swaps to NEAR once resident, hides exactly that cell\'s copies', () => {
        const f = fakeWorld(layers);
        f.cam.position = [feet[0], feet[1] + rec.u, feet[2]];
        f.crowd.update();
        expect(copyOf(f.group, P).visible).not.toBe(false);   // nothing resident yet → still the xfar copy
        run(f.crowd);
        const near = f.added.filter(m => m.name === 'world:ped-near'), mid = f.added.filter(m => m.name === 'world:ped-mid');
        expect(near.length).toBeGreaterThan(0); expect(mid.length).toBeGreaterThan(0);
        expect(copyOf(f.group, P).visible).toBe(false);
        const s = f.crowd.stats.shown;
        expect(s[0]).toBeGreaterThan(0);
        // the shown near mesh draws (external twin role 1), its cell's mid mesh does not
        expect(near.some(m => m.lodTwinNear && m.lodTwinExternal && m.lodTwinRole === 1)).toBe(true);
        expect(mid.every(m => m.lodTwinRole === 3 && m.lodTwinNear === false)).toBe(true);
        // copies hidden == people in cells showing near / mid
        let hidden = 0;
        for (const a of f.group.children as Arr[]) if (a.crowdPi) for (const v of a.instanceOverrides.values()) if (v.visible === false) hidden++;
        expect(hidden).toBeGreaterThan(0);
        expect(hidden).toBeLessThan(rec.n);
        expect(f.repacks()).toBeGreaterThan(0);
    });

    it('far away: everything XFAR, the lazy tiers evicted, every copy visible again', () => {
        const f = fakeWorld(layers);
        f.cam.position = [feet[0], feet[1] + rec.u, feet[2]];
        run(f.crowd);
        f.cam.position = [feet[0] + 400 * rec.u, feet[1] + 300 * rec.u, feet[2]];
        run(f.crowd, 5);
        expect(f.crowd.stats.near + f.crowd.stats.mid).toBe(0);
        expect(f.removed.length).toBe(f.added.length);
        for (const a of f.group.children as Arr[]) if (a.crowdPi) for (const v of a.instanceOverrides.values()) expect(v.visible).not.toBe(false);
        expect(f.crowd.stats.shown[2]).toBe(f.crowd.stats.cells);
    });

    it('hysteresis: a cell just past the near distance keeps NEAR until 10 % beyond the show threshold', () => {
        const f = fakeWorld(layers);
        f.cam.position = [feet[0], feet[1] + rec.u, feet[2]];
        run(f.crowd);
        const d1 = rec.d1 * Math.min(4, Math.max(0.25, Math.tan(Math.PI / 8) / Math.tan(Math.PI / 8)));
        const cellsNear = f.crowd.stats.shown[0];
        // move straight up to 1.05 × d1 above the cell top: still near (hidden only past d1 → but the box top is lower)
        f.cam.position = [feet[0], feet[1] + 2.3 * rec.u + d1 * 0.95, feet[2]];
        run(f.crowd, 3);
        expect(f.crowd.stats.shown[0]).toBeGreaterThan(0);
        f.cam.position = [feet[0], feet[1] + 2.3 * rec.u + d1 * 1.3, feet[2]];
        run(f.crowd, 3);
        expect(f.crowd.stats.shown[0]).toBe(0);
        // back to 0.95 × d1: within the threshold but outside 0.9 × → stays mid (the hysteresis band)
        f.cam.position = [feet[0], feet[1] + 2.3 * rec.u + d1 * 0.95, feet[2]];
        run(f.crowd, 3);
        expect(f.crowd.stats.shown[0]).toBe(0);
        f.cam.position = [feet[0], feet[1] + rec.u, feet[2]];
        run(f.crowd, 3);
        expect(f.crowd.stats.shown[0]).toBe(cellsNear);
    });

    it('live-crowd hand-off: a promoted person\'s xfar copy hides, and comes back on release', () => {
        const f = fakeWorld(layers);
        f.cam.position = [feet[0] + 400 * rec.u, feet[1] + 300 * rec.u, feet[2]];   // all xfar
        run(f.crowd, 3);
        const blk = (f.crowd as unknown as { _blocks: Map<string, { people: unknown[] }> })._blocks.values().next().value!;
        const person = blk.people[P];
        expect(copyOf(f.group, P).visible).not.toBe(false);
        f.crowd.setLive(person as never, true);
        expect(copyOf(f.group, P).visible).toBe(false);
        f.crowd.setLive(person as never, false);
        expect(copyOf(f.group, P).visible).not.toBe(false);
    });

    it('distance LOD off → every cell wants MID (near never built)', () => {
        const f = fakeWorld(layers);
        f.r3.distanceLod = false;
        f.cam.position = [feet[0], feet[1] + rec.u, feet[2]];
        run(f.crowd);
        expect(f.added.some(m => m.name === 'world:ped-near')).toBe(false);
        expect(f.crowd.stats.shown[0]).toBe(0);
        expect(f.crowd.stats.shown[1]).toBeGreaterThan(0);
    });

    it('a build whose groups left the scene is dropped (its lazy meshes removed)', () => {
        const f = fakeWorld(layers);
        f.cam.position = [feet[0], feet[1] + rec.u, feet[2]];
        run(f.crowd);
        expect(f.crowd.active).toBe(true);
        (f.w as { _groups: unknown[]; _meshSetEpoch: number })._groups = [];
        (f.w as { _meshSetEpoch: number })._meshSetEpoch++;
        f.crowd.update();
        expect(f.crowd.active).toBe(false);
        expect(f.removed.length).toBe(f.added.length);
    });
});
