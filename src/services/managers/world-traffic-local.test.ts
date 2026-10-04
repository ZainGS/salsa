/**
 * world-traffic-local.test.ts — the AT-GRADE local line in the live ticker (railway-upgrade R3.2 / R3.3 + the R2.2
 * leftover), against a FAKE scene: the short consist rides its terrain-following rails, the level crossings close for
 * it (arms down, lamps flashing), no car or walker is on a crossing while the train is, cars queue at the stop line,
 * and walkers visit the station entrances.
 */
import { describe, it, expect } from 'vitest';

import { WorldTraffic } from './world-traffic';
import { generateCityLayout } from '../../world/layout';
import { crossingFrame, LOCAL_M, crossingSin } from '../../world/local-line';
import { heightAtArc, LOCAL_LAMP_ON } from '../../world/local-line-build';
import { crossingClosed } from '../../world/level-crossing';
import type { LayoutPreviewLayer } from '../../world/types';

class FakeMesh {
    name: string; visible = true; cheapBounds = false; materialDirty = false;
    x = 0; y = 0; z = 0; rotationY = 0; rotation = 0; sx = 1;
    material: { diffuse: { r: number; g: number; b: number; a: number }; emissive: { r: number; g: number; b: number; a: number } };
    constructor(L: LayoutPreviewLayer) { this.name = L.name; this.material = { diffuse: { r: L.color[0], g: L.color[1], b: L.color[2], a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 } }; }
    setXYZ(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; }
    setPoseXYZYaw(x: number, y: number, z: number, ry: number, rz = this.rotation): void { this.x = x; this.y = y; this.z = z; this.rotationY = ry; this.rotation = rz; }
    setScale3D(s: number): void { this.sx = s; }
    setDiffuseColor(): void { /* no-op */ }
    updateLocalMatrix(): void { /* no-op */ }
}

describe('the local line in the live ticker', () => {
    const graph = generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square', localLine: true, pedestrianDensity: 3 });
    const groups: { children: FakeMesh[] }[] = [];
    // the static crossing lamps (normally built by buildLocalLine): one fake mesh per lamp layer
    const lampLayers = graph.localLine!.crossings.flatMap(q => (['a', 'b'] as const).map(k => ({ name: `world:local-xing-lamp-${q.id}${k}`, color: [0.2, 0.05, 0.04] as [number, number, number], y: 0, geometry: { vertices: new Float32Array(0), indices: new Uint32Array(0), format: '12float' as const } })));
    groups.push({ children: lampLayers.map(L => new FakeMesh(L as unknown as LayoutPreviewLayer)) });
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
    const X = tr.xing, T = X.T!;
    const local = tr.movers.find(m => m.spec.run?.local)!;
    const u = T.unitsPerMetre, dt = 1 / 30;

    it('spawns the short consist, the crossing arms and finds the lamps', () => {
        expect(local).toBeTruthy();
        expect(local.segments!.length).toBe(graph.localLine!.cars);
        expect(X.states.length).toBe(T.xings.length);
        expect(groups.some(g => g.children.some(m => /local-xing-arm-live/.test(m.name)))).toBe(true);
    });

    it('runs 4 minutes: the train rides its rails; arms down + lamps while it is on a road; nobody else on the tracks then', () => {
        let yErr = 0, occFrames = 0, carsHeld = 0, lampsLit = 0, armsDownPose = 0, carOnTrackWhileTrain = 0, walkOnTrackWhileTrain = 0, stationVisits = 0;
        const F = { u: 0, w: 0 };
        const half = local.spec.cars!.count * local.spec.cars!.spacing / 2;
        const seenVisit = new Set<unknown>();
        for (let f = 0; f < 30 * 240; f++) {
            host._simTime += dt; tr.tick(dt);
            const run = local.run!;
            // cars sit on the rail-top profile (bogie-averaged height)
            for (const seg of local.segments!) {
                const body = seg.body![0] as unknown as FakeMesh;
                const hb = local.spec.run!.bogieHalf!, d = run.s + seg.offset, H = local.spec.run!.heights!, cum = local.path!.cum;
                const want = (heightAtArc(cum, H, d - hb) + heightAtArc(cum, H, d + hb)) / 2;   // the body rides its two bogies
                yErr = Math.max(yErr, Math.abs(body.y - want) / u);
            }
            for (let i = 0; i < T.xings.length; i++) {
                const Xi = T.xings[i], q = Xi.q, st = X.states[i];
                const on = run.s + half > Xi.arc - Xi.zoneHalf && run.s - half < Xi.arc + Xi.zoneHalf;
                if (on) {
                    occFrames++;
                    expect(st.arm, `crossing ${i}`).toBe(1);
                    // every live arm of this crossing is posed lowered (roll 0)
                    const arms = groups.flatMap(g => g.children).filter(m => /local-xing-arm-live/.test(m.name));
                    if (arms.some(a => Math.abs(a.rotation) < 1e-6)) armsDownPose++;
                    // no car / walker in the crossing core
                    const core = LOCAL_M.crossCore * u / crossingSin(q) + 0.5 * u;
                    for (const m of tr.movers) {
                        if (!m.agent || m.visiting) continue;
                        crossingFrame(q, m.cx, m.cz, F);
                        if (Math.abs(F.w) > q.band || Math.abs(F.u) > core) continue;
                        if (m.agent.mode === 'car') carOnTrackWhileTrain++; else walkOnTrackWhileTrain++;
                    }
                }
                if (crossingClosed(st)) {
                    for (const m of tr.movers) {
                        if (!m.agent || m.agent.mode !== 'car' || m.vel > 1e-4) continue;
                        crossingFrame(q, m.cx, m.cz, F);
                        const stop = (LOCAL_M.barrier + LOCAL_M.stopLine) * u / crossingSin(q);
                        if (Math.abs(F.w) < q.roadHalf && Math.abs(F.u) > stop && Math.abs(F.u) < stop + 0.4) carsHeld++;
                    }
                }
            }
            for (const g of groups) for (const m of g.children) if (/local-xing-lamp/.test(m.name) && Math.abs(m.material.diffuse.r - LOCAL_LAMP_ON[0]) < 1e-6) lampsLit++;
            for (const v of (tr as unknown as { _visits: { door: { station?: boolean }; mv: unknown }[] })._visits) if (v.door.station && !seenVisit.has(v)) { seenVisit.add(v); stationVisits++; }
        }
        expect(yErr, 'car height off the rail profile (m)').toBeLessThan(0.01);
        expect(occFrames, 'the train crossed roads').toBeGreaterThan(30 * 5);
        expect(armsDownPose).toBeGreaterThan(0);
        expect(lampsLit, 'lamps flashed').toBeGreaterThan(0);
        expect(carOnTrackWhileTrain, 'cars on a crossing while the train was on it').toBe(0);
        expect(walkOnTrackWhileTrain, 'walkers on a crossing while the train was on it').toBe(0);
        expect(carsHeld, 'car-frames waiting at a closed crossing stop line').toBeGreaterThan(0);
        expect(stationVisits, 'walkers went into a station entrance').toBeGreaterThan(0);
    }, 180_000);

    it('stop() removes the live arms and turns the lamps off', () => {
        tr.stop();
        expect(X.T).toBeNull();
        for (const m of groups[0].children) expect(m.material.diffuse.r).toBeLessThan(0.5);
    });
});
