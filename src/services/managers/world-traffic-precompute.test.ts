/**
 * world-traffic-precompute.test.ts — performance-plan P5.W4: the traffic computation moved off the main thread.
 *
 *  · The worker centre job's traffic precompute (mover specs + the routing net as data, geometry transferred) is
 *    BYTE-IDENTICAL to what the main thread computed itself on its clone of the adopted graph (the pre-P5.W4 path).
 *  · An ADOPTED road net (route-sim adoptRoadNet / street-slots adoptStreetPlan) answers every query the live sim and
 *    the composers make exactly like a freshly built one.
 *  · computeTraffic only READS the graph (the precompute runs before the graph ships).
 *  · A TIME-SLICED spawn (WorldTraffic.startSliced) over precomputed specs lands the same movers, meshes and
 *    placement as the synchronous start() — and nothing of it is visible or in `_groups` before its reveal.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorldTraffic } from './world-traffic';
import { generateCityLayout } from '../../world/layout';
import { buildCentreGroups } from '../../world/centre-build';
import { computeTraffic, type MoverSpec } from '../../world/traffic';
import { roadNet, roadNetData, adoptRoadNet, carLeg, walkLeg, walkNext, type RoadNet } from '../../world/route-sim';
import { precomputeTraffic, type TrafficPrecompute } from '../../world/traffic-precompute';
import { buildTrafficLights } from '../../world/signals';
import type { LayoutParams, LayoutPreviewLayer, WorldGraph } from '../../world/types';
import { WORLD_JOB, WORLD_JOB_HANDLERS } from '../workers/world-jobs';
import type { JobApi } from '../workers/worker-job-runtime';

/** FNV-1a over a typed array's bytes. */
function hashView(v: ArrayBufferView): string {
    const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let h = 2166136261;
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
    return `${v.constructor.name}:${v.byteLength}:${h >>> 0}`;
}
/** Full canonical fingerprint (typed arrays by bytes). */
const canon = (x: unknown): string => JSON.stringify(x, (_k, v) => (ArrayBuffer.isView(v) ? hashView(v) : v));
/** How many DISTINCT geometry objects the specs reference (archetype sharing → instanced draws). */
function distinctGeometries(specs: MoverSpec[]): number {
    const set = new Set<unknown>();
    for (const sp of specs) {
        for (const L of sp.layers) set.add(L.geometry);
        for (const v of sp.cars?.variants ?? []) for (const L of v) set.add(L.geometry);
    }
    return set.size;
}

const workerApi = (): JobApi & { list: Transferable[] } => {
    const list: Transferable[] = [];
    return { shared: {}, fallback: false, progress: () => {}, transfer: (...b) => { list.push(...b); }, list };
};

describe('P5.W4 traffic precompute — worker == main thread', () => {
    const P: Partial<LayoutParams> = { seed: 7, radius: 6 };
    const opts = { parkedTrain: false, activeRegions: null, chunk: { minCell: 1 }, contact: { opacity: 0.55 } };

    it('the centre job ships the same specs + net the main thread computed on its adopted clone', async () => {
        // The worker job (structured clone in, transfer-copies out, structured clone back — what postMessage does).
        const api = workerApi();
        const res0 = await WORLD_JOB_HANDLERS[WORLD_JOB.centre](structuredClone({ params: P, ...opts, traffic: true }), api) as { graph: WorldGraph; traffic?: TrafficPrecompute };
        expect(res0.traffic).toBeTruthy();
        expect(new Set(api.list).size).toBe(api.list.length);            // no buffer transferred twice (DataCloneError)
        const res = structuredClone(res0);
        // The pre-P5.W4 main thread: adopt a clone of the (traffic-less) direct build's graph, compute on it.
        const direct = buildCentreGroups(P, opts);
        expect(direct.traffic).toBeUndefined();
        const adopted = structuredClone(direct.graph);
        const before = JSON.stringify(adopted);
        const specs = computeTraffic(adopted);
        const net = roadNet(adopted);
        expect(JSON.stringify(adopted)).toBe(before);                    // computeTraffic + roadNet only READ the graph
        expect(JSON.stringify(res.graph)).toBe(JSON.stringify(direct.graph));   // the precompute did not touch the shipped graph
        expect(res.traffic!.specs.length).toBe(specs.length);
        expect(canon(res.traffic!.specs)).toBe(canon(specs));           // byte-for-byte (geometry bytes included)
        expect(canon(res.traffic!.net)).toBe(canon(roadNetData(net)));
        // archetype geometry stays SHARED across the transfer + clone (one upload per archetype)
        expect(distinctGeometries(res.traffic!.specs)).toBe(distinctGeometries(specs));
        expect(distinctGeometries(specs)).toBeLessThan(specs.reduce((n, s) => n + s.layers.length, 0));
    }, 120000);

    it('tiled worlds / traffic off: no precompute', async () => {
        const off = buildCentreGroups({ ...P, traffic: false }, { ...opts, traffic: true });
        expect(off.traffic).toBeUndefined();
        const tiled = buildCentreGroups({ ...P, worldMode: 'tiled', tileRadius: 1, tileDetail: 'flat' } as Partial<LayoutParams>, { ...opts, traffic: true });
        expect(tiled.traffic).toBeUndefined();
    }, 120000);
});

describe('P5.W4 adopted road net == freshly built', () => {
    const g0 = generateCityLayout({ seed: 12, radius: 8, localLine: true } as Partial<LayoutParams>);
    const fresh = structuredClone(g0), adoptedG = structuredClone(g0), src = structuredClone(g0);
    const A: RoadNet = roadNet(fresh);
    const B: RoadNet = adoptRoadNet(adoptedG, structuredClone(roadNetData(roadNet(src))));

    it('the plain data and the memo agree', () => {
        expect(canon(roadNetData(B))).toBe(canon(roadNetData(A)));
        expect(roadNet(adoptedG)).toBe(B);                               // the cache is seeded (no rebuild)
    });
    it('every plan + net query answers identically', () => {
        const kinds = new Set(A.plan.slots.map(s => s.kind));
        for (const k of kinds) expect(canon(B.plan.of(k))).toBe(canon(A.plan.of(k)));
        const R = g0.params.radius;
        let n = 0;
        A.plan.roads.forEach((road, ri) => {
            if (!road) return;
            for (const side of [1, -1] as const) {
                expect(canon(B.plan.side(ri, side))).toBe(canon(A.plan.side(ri, side)));
                expect(canon(B.plan.onSide(ri, side))).toBe(canon(A.plan.onSide(ri, side)));
                for (let t = 0; t <= 1; t += 0.125) {
                    const al = road.len * t;
                    expect(B.plan.frontageAt(ri, side, al)).toBe(A.plan.frontageAt(ri, side, al));
                    for (const band of ['kerb', 'walk', 'front', 'road'] as const) { expect(B.plan.free(ri, side, band, al, 0.02)).toBe(A.plan.free(ri, side, band, al, 0.02)); n++; }
                    expect(B.plan.at(ri, side, al, 0.3)).toEqual(A.plan.at(ri, side, al, 0.3));
                }
            }
        });
        for (let x = -R; x <= R; x += R / 23) for (let z = -R; z <= R; z += R / 23) {
            expect(B.plan.inBuilding(x, z)).toBe(A.plan.inBuilding(x, z));
            expect(B.dry(x, z)).toBe(A.dry(x, z));
        }
        expect(n).toBeGreaterThan(100);
    });
    it('routing over it (legs, turns, crossings) is identical', () => {
        for (const e of A.carEdges) expect(canon(carLeg(B, e, null))).toBe(canon(carLeg(A, e, null)));
        for (const e of A.walkEdges) for (const side of [1, -1] as const) {
            const la = walkLeg(A, e, side), lb = walkLeg(B, e, side);
            expect(canon(lb)).toBe(canon(la));
            expect(canon(walkNext(B, lb, e, 3, 0.1))).toBe(canon(walkNext(A, la, e, 3, 0.1)));
        }
    });
});

// ── WorldTraffic: sliced spawn over a precompute == synchronous start ───────────────────────────────────────────
class FakeMesh {
    name: string; visible = true; cheapBounds = false; materialDirty = false;
    x = 0; y = 0; z = 0; rotationY = 0; rotation = 0; sx = 1; parent: unknown = null;
    material: { diffuse: { r: number; g: number; b: number; a: number }; emissive: { r: number; g: number; b: number; a: number } };
    constructor(L: LayoutPreviewLayer) {
        this.name = L.name;
        const e = L.emissive ?? 0.45;
        this.material = { diffuse: { r: L.color[0], g: L.color[1], b: L.color[2], a: 1 }, emissive: { r: L.color[0] * e, g: L.color[1] * e, b: L.color[2] * e, a: 1 } };
    }
    setXYZ(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; }
    setPoseXYZYaw(x: number, y: number, z: number, ry: number, rz: number = this.rotation): void { this.x = x; this.y = y; this.z = z; this.rotationY = ry; this.rotation = rz; }
    setScale3D(s: number): void { this.sx = s; }
    setDiffuseColor(r: number, g: number, b: number): void { this.material.diffuse = { r, g, b, a: 1 }; }
    updateLocalMatrix(): void { /* no-op */ }
}
function fakeHost(graph: WorldGraph) {
    const groups: { name: string; children: FakeMesh[] }[] = [];
    groups.push({ name: 'World Signals', children: buildTrafficLights(graph).map(L => new FakeMesh(L)) });
    const scene: { name: string; children: FakeMesh[] }[] = [];   // every group ever added to the "scene"
    const host = {
        _graph: graph, _groups: groups, _sceneEpoch: 0, get _meshSetEpoch(): number { return this._sceneEpoch; }, _simTime: 0, _timeOfDay: null as number | null, _lastGlowNight: -1,
        _warpScratch: [0, 0] as [number, number],
        _warpInto: (_x: number, _z: number, out: [number, number]) => { out[0] = 0; out[1] = 0; },
        _heightFn: () => 0, _smoothFn: () => 0,
        _allWorldMeshes: () => groups.flatMap(g => g.children),
        _ensureCityContainer: () => null, _hasStyle: () => false, _applyRenderStyle: () => {}, _applyTimeOfDay: () => {}, _ensureTicker: () => {},
        warmed: 0, removed: 0,
        scene3d: {
            addFlatColorMeshGroup: (name: string, layers: LayoutPreviewLayer[]) => { const g = { name, children: layers.map(L => new FakeMesh(L)) }; for (const m of g.children) m.parent = g; scene.push(g); return g; },
            removeFlatColorMeshGroup: (g: unknown) => { const i = scene.indexOf(g as never); if (i >= 0) { scene.splice(i, 1); host.removed++; } },
            notifyMeshTransformsChanged3D: () => {}, notifyVisibilityChanged3D: () => {}, notifySceneGraphChanged3D: () => {},
            warmGroupGeometry3D: () => { host.warmed++; }, requestRender3D: () => {},
        },
    };
    return { host, scene };
}
/** Everything observable about the live movers + their meshes. */
function snapshot(tr: WorldTraffic, host: { _groups: { name: string; children: FakeMesh[] }[] }): string {
    return canon({
        movers: tr.movers.map(m => ({ kind: m.spec.kind, t: m.t, cx: m.cx, cz: m.cz, yaw: m.yaw, phase: m.phase, vel: m.vel, s: m.agent?.s, edge: m.agent?.leg.edge,
            meshes: m.meshes.map(x => { const f = x as unknown as FakeMesh; return [f.name, f.visible, f.x, f.y, f.z, f.rotationY, f.rotation, f.sx]; }) })),
        groups: host._groups.map(g => [g.name, g.children.length, g.children.map(c => c.visible)]),
    });
}

let live = true;
const gl = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
beforeAll(() => {
    live = true;
    gl.requestAnimationFrame = (cb: (t: number) => void) => live ? (setTimeout(() => cb(performance.now()), 0) as unknown as number) : 0;
    gl.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
});
afterAll(async () => {
    live = false;
    await new Promise(r => setTimeout(r, 30));
    delete gl.requestAnimationFrame; delete gl.cancelAnimationFrame;
});

describe('P5.W4 sliced spawn over a precompute == synchronous start()', () => {
    const g0 = generateCityLayout({ seed: 11, radius: 10, pattern: 'grid', border: 'square' });

    it('same movers, meshes, placement and sim — hidden + out of _groups until the reveal', async () => {
        const sync = fakeHost(structuredClone(g0));
        const a = new WorldTraffic(sync.host as never);
        a.start();
        expect(a.lastSpawnPrecomputed).toBe(false);

        const gs = structuredClone(g0);
        const sl = fakeHost(gs);
        const b = new WorldTraffic(sl.host as never);
        b.preload(gs, structuredClone(precomputeTraffic(structuredClone(g0))));   // the worker's result, cloned across
        let done = 0, frames = 0, sawHidden = false;
        b.startSliced(() => 0.05, () => { done++; });   // a tiny budget → many slices
        while (b.spawning) {
            await new Promise(r => setTimeout(r, 0));
            frames++;
            if (b.spawning) {
                expect(b.movers.length).toBe(0);                                       // not live yet
                expect(sl.host._groups.length).toBe(1);                                // (only the signals) — LOD / glow never see them
                const staged = sl.scene.filter(g => g.name === 'World Traffic');
                if (staged.length) { sawHidden = true; expect(staged.every(g => g.children.every(c => !c.visible))).toBe(true); }
            }
        }
        expect(done).toBe(1);
        expect(frames).toBeGreaterThan(3);
        expect(sawHidden).toBe(true);
        expect(b.lastSpawnPrecomputed).toBe(true);
        expect(b.on).toBe(true);
        expect(sl.host.warmed).toBeGreaterThan(0);
        expect(b.movers.length).toBe(a.movers.length);
        expect(snapshot(b, sl.host)).toBe(snapshot(a, sync.host));
        // ...and they keep behaving the same (signals, crossings, chats, visits are all hash / time driven).
        for (let f = 0; f < 600; f++) {
            sync.host._simTime += 1 / 30; sl.host._simTime += 1 / 30;
            a.tick(1 / 30); b.tick(1 / 30);
        }
        expect(snapshot(b, sl.host)).toBe(snapshot(a, sync.host));
    }, 120000);

    it('a stale precompute (params changed in place) is ignored; start() mid-slice finishes it synchronously; stop() cancels', async () => {
        const g = structuredClone(g0);
        const { host, scene } = fakeHost(g);
        const tr = new WorldTraffic(host as never);
        tr.preload(g, precomputeTraffic(structuredClone(g0)));
        (g.params as { weather?: string }).weather = 'rain';
        tr.start();
        expect(tr.lastSpawnPrecomputed).toBe(false);
        expect(tr.movers.some(m => m.spec.kind === 'rain')).toBe(true);
        tr.stop();
        expect(scene.filter(x => x.name === 'World Traffic').length).toBe(0);

        tr.startSliced(() => 0.05);
        await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
        expect(tr.spawning).toBe(true);
        tr.start();                                                   // a synchronous start arrives mid-slice
        expect(tr.spawning).toBe(false);
        expect(tr.movers.length).toBeGreaterThan(50);
        const n = scene.filter(x => x.name === 'World Traffic').length;
        expect(host._groups.filter(x => x.name === 'World Traffic').length).toBe(n);

        tr.stop();
        tr.startSliced(() => 0.05);
        await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
        expect(tr.spawning).toBe(true);
        tr.stop();                                                    // cancelled mid-slice: its hidden groups go
        expect(tr.spawning).toBe(false);
        expect(scene.filter(x => x.name === 'World Traffic' || x.name === 'World Visit Doors').length).toBe(0);
        expect(tr.movers.length).toBe(0);
    }, 120000);
});
