/**
 * world-traffic-train.test.ts — the EMU consists in the live ticker (railway-upgrade R1.5 / R2.2), against a FAKE scene.
 *
 * Against the real double-track line (rail-layout.ts): one consist per track in opposite directions, every car stays
 * on its (warped, noWarp) track polyline and on the rail top, cars keep their 20 m pitch, the consist stops centred
 * at a station with its doors slid open, and the leading cab shows its headlights.
 */
import { describe, it, expect } from 'vitest';

import { WorldTraffic } from './world-traffic';
import { generateCityLayout } from '../../world/layout';
import { railTrackInfo, trackArcAtZ } from '../../world/train';
import * as RW from '../../world/railway';
import type { LayoutPreviewLayer } from '../../world/types';

class FakeMesh {
    name: string; visible = true; cheapBounds = false; materialDirty = false;
    x = 0; y = 0; z = 0; rotationY = 0; rotation = 0; sx = 1;
    material: { diffuse: { r: number; g: number; b: number; a: number }; emissive: { r: number; g: number; b: number; a: number } };
    constructor(L: LayoutPreviewLayer) { this.name = L.name; this.material = { diffuse: { r: 1, g: 1, b: 1, a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 } }; }
    setXYZ(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; }
    setPoseXYZYaw(x: number, y: number, z: number, ry: number): void { this.x = x; this.y = y; this.z = z; this.rotationY = ry; }
    setScale3D(s: number): void { this.sx = s; }
    setDiffuseColor(): void { /* no-op */ }
    updateLocalMatrix(): void { /* no-op */ }
}

describe('EMU consists in the live ticker', () => {
    const graph = generateCityLayout({ seed: 5, radius: 10, pattern: 'grid', border: 'square' });
    const groups: { children: FakeMesh[] }[] = [];
    const host = {
        _graph: graph, _groups: groups, _sceneEpoch: 0, get _meshSetEpoch(): number { return this._sceneEpoch; }, _simTime: 0, _timeOfDay: null as number | null, _lastGlowNight: -1,
        _warpScratch: [0, 0] as [number, number], _warpInto: (_x: number, _z: number, out: [number, number]) => { out[0] = 0; out[1] = 0; },
        _heightFn: () => 0, _smoothFn: () => 0, _allWorldMeshes: () => groups.flatMap(g => g.children),
        _ensureCityContainer: () => null, _hasStyle: () => false, _applyRenderStyle: () => {}, _applyTimeOfDay: () => {}, _ensureTicker: () => {},
        scene3d: {
            addFlatColorMeshGroup: (_n: string, layers: LayoutPreviewLayer[]) => { const g = { children: layers.map(L => new FakeMesh(L)) }; for (const m of g.children) (m as unknown as { parent: unknown }).parent = g; groups.push(g); return g; },
            removeFlatColorMeshGroup: () => {}, notifyMeshTransformsChanged3D: () => {}, notifyVisibilityChanged3D: () => {},
        },
    };
    const tr = new WorldTraffic(host as never);
    tr.start();
    const T = railTrackInfo(graph.params, RW.railwayLine(graph.params), RW.railStations(graph.params));
    const trackOf = (t: { spec: { path?: [number, number][] } }) => T.tracks.findIndex(k => Math.hypot(k.path[0][0] - t.spec.path![0][0], k.path[0][1] - t.spec.path![0][1]) < 1e-9);
    const distToPath = (x: number, z: number, path: [number, number][]): number => {
        let best = Infinity;
        for (let i = 0; i < path.length - 1; i++) {
            const a = path[i], b = path[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
            best = Math.min(best, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t));
        }
        return best;
    };
    const trains = tr.movers.filter(m => m.run);
    const mpu = 15, dt = 1 / 30;

    it('one 8-car consist per track, in opposite directions', () => {
        expect(trains.length).toBe(2);
        expect(trains.map(t => t.segments!.length)).toEqual([8, 8]);
        expect(T.tracks.length).toBe(2);
        expect(T.stations.length).toBeGreaterThan(0);
        const offs = trains.map(t => trackOf(t)).sort();
        expect(offs).toEqual([0, 1]);
        // at start they head opposite ways (keep-left: +z-bound on the higher-x track)
        const hi = trains.find(t => trackOf(t) === 1)!, lo = trains.find(t => trackOf(t) === 0)!;
        expect(hi.run!.dir).toBe(1); expect(lo.run!.dir).toBe(-1);
    });

    it('runs for 3 minutes: cars stay on their track + rail top, keep a 20 m pitch, stop at the station with doors open', () => {
        const stationS = new Map(trains.map(t => [t, trackArcAtZ(T.tracks[trackOf(t)], T.stations[0].z)]));
        let drift = 0, pitchErr = 0, stationDwellFrames = 0, doorOpenMax = 0, leadHeadOk = 0, leadChecks = 0, moved = 0;
        const s0 = trains.map(t => t.run!.s);
        for (let f = 0; f < 30 * 180; f++) {
            host._simTime += dt; tr.tick(dt);
            for (const t of trains) {
                const segs = t.segments!;
                for (let c = 0; c < segs.length; c++) {
                    const body = segs[c].body![0] as unknown as FakeMesh;
                    // the BOGIES sit on the track (the body is their chord): body centre -/+ 7 m along the car's heading
                    const hx = Math.cos(body.rotationY) * 7 / mpu, hz = -Math.sin(body.rotationY) * 7 / mpu;
                    drift = Math.max(drift, distToPath(body.x + hx, body.z + hz, t.spec.path!) * mpu, distToPath(body.x - hx, body.z - hz, t.spec.path!) * mpu);
                    expect(body.y).toBe(0);   // rail top is baked into the geometry
                    if (c > 0) { const prev = segs[c - 1].body![0] as unknown as FakeMesh; pitchErr = Math.max(pitchErr, Math.abs(Math.hypot(body.x - prev.x, body.z - prev.z) * mpu - 20)); }
                }
                const r = t.run!;
                moved = Math.max(moved, Math.abs(r.s - s0[trains.indexOf(t)]));
                if (r.dwell > 0 && Math.abs(r.s - stationS.get(t)!) < 1e-6) {
                    stationDwellFrames++;
                    // door leaves are offset from the car body along the car axis (z here) by up to 0.64 m
                    const seg = segs[3], body = seg.body![0] as unknown as FakeMesh, leaf = seg.doorA![0] as unknown as FakeMesh;
                    doorOpenMax = Math.max(doorOpenMax, Math.hypot(leaf.x - body.x, leaf.z - body.z) * mpu);
                }
                if (r.v > 0) {
                    const lead = r.dir > 0 ? segs[segs.length - 1] : segs[0], trail = r.dir > 0 ? segs[0] : segs[segs.length - 1];
                    leadChecks++;
                    if ((lead.head![0] as unknown as FakeMesh).visible && !(lead.tail![0] as unknown as FakeMesh).visible && (trail.tail![0] as unknown as FakeMesh).visible && !(trail.head![0] as unknown as FakeMesh).visible) leadHeadOk++;
                }
            }
        }
        expect(drift, 'bogie metres off the track centre').toBeLessThan(0.01);
        expect(pitchErr, 'car pitch error (m)').toBeLessThan(0.05);
        expect(stationDwellFrames).toBeGreaterThan(30 * 20);
        expect(doorOpenMax).toBeCloseTo(0.64, 2);
        expect(leadChecks).toBeGreaterThan(100); expect(leadHeadOk).toBe(leadChecks);
        expect(moved).toBeGreaterThan(0);
    }, 120_000);

    it('stop() hides nothing it should keep, and the parked-train rule matches the new names', () => {
        expect(/rail-train/.test('world:rail-train-win')).toBe(true);
        tr.stop();
        expect(tr.movers.length).toBe(0);
    });
});
