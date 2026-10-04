/**
 * world-traffic.test.ts — the live traffic ticker, stepped for a simulated minute against a FAKE scene (no renderer).
 *
 * The CPU-checkable half of the city-quality life items: walkers FACE the way they walk and swing their legs; cars
 * never shrink mid-street (only a dead-end fade); no car crosses its stop line while its light is red; everyone moves
 * continuously (no teleport); the signal lamps actually change.
 */

import { describe, it, expect } from 'vitest';
import { WorldTraffic } from './world-traffic';
import { generateCityLayout } from '../../world/layout';
import { roadNet } from '../../world/route-sim';
import { buildTrafficLights, signalState } from '../../world/signals';
import type { LayoutPreviewLayer } from '../../world/types';

class FakeMesh {
    name: string; visible = true; cheapBounds = false; materialDirty = false;
    x = 0; y = 0; z = 0; rotationY = 0; rotation = 0; sx = 1;
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

function fakeHost(seed: number) {
    const graph = generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square' });
    const groups: { children: FakeMesh[] }[] = [];
    // The static signal lamps, as the world build would have added them.
    groups.push({ children: buildTrafficLights(graph).map(L => new FakeMesh(L)) });
    const host = {
        _graph: graph, _groups: groups, _sceneEpoch: 0, get _meshSetEpoch(): number { return this._sceneEpoch; }, _simTime: 0, _timeOfDay: null as number | null, _lastGlowNight: -1,
        _warpScratch: [0, 0] as [number, number],
        _warpInto: (_x: number, _z: number, out: [number, number]) => { out[0] = 0; out[1] = 0; },
        _heightFn: () => 0, _smoothFn: () => 0,
        _allWorldMeshes: () => groups.flatMap(g => g.children),
        visNotifies: 0,
        _ensureCityContainer: () => null, _hasStyle: () => false, _applyRenderStyle: () => {}, _applyTimeOfDay: () => {}, _ensureTicker: () => {},
        scene3d: {
            addFlatColorMeshGroup: (_n: string, layers: LayoutPreviewLayer[]) => { const g = { children: layers.map(L => new FakeMesh(L)) }; for (const m of g.children) (m as unknown as { parent: unknown }).parent = g; groups.push(g); return g; },
            removeFlatColorMeshGroup: () => {}, notifyMeshTransformsChanged3D: () => {},
            notifyVisibilityChanged3D: () => { host.visNotifies++; },
        },
    };
    return { host, graph };
}

describe('WorldTraffic — a simulated minute', () => {
    const { host, graph } = fakeHost(11);
    const tr = new WorldTraffic(host as never);
    tr.start();
    const s = graph.params.radius / 10, net = roadNet(graph);
    const dt = 1 / 30;
    const prev = new Map<unknown, [number, number]>();
    let minCarScaleMid = 1, facingChecks = 0, facingOk = 0, maxJump = 0, legSwing = 0, armSwing = 0, armChecks = 0, armOpposite = 0;
    const lampColours = new Set<string>();
    let dbg = '';

    for (let f = 0; f < 60 * 30; f++) {
        host._simTime += dt;
        tr.tick(dt);
        for (const mv of tr.movers) {
            const a = mv.agent; if (!a || mv.visiting) continue;
            const body = mv.body[0] as unknown as FakeMesh;
            const p0 = prev.get(mv);
            if (p0) {
                const jump = Math.hypot(mv.cx - p0[0], mv.cz - p0[1]);
                if (!(a.mode === 'car' && (a.fading !== 0 || a.fade < 1))) { const r = jump / (mv.spec.speed * dt + 1e-9); if (r > maxJump) { maxJump = r; dbg = `${a.mode} f=${f} s=${a.s.toFixed(4)} tot=${a.leg.total.toFixed(4)} waiting=${a.waiting} shift=${a.shift.toFixed(4)} pts=${a.leg.pts.length} vel=${mv.vel.toFixed(4)} sp=${mv.spec.speed.toFixed(4)}`; } }
                // Facing: the eased yaw tracks the direction of actual motion (+X built → (cos, −sin)).
                if (a.mode === 'walk' && jump > mv.spec.speed * dt * 0.6 && mv.faceYaw == null) {
                    facingChecks++;
                    const vx = (mv.cx - p0[0]) / jump, vz = (mv.cz - p0[1]) / jump;
                    if (Math.cos(body.rotationY) * vx + -Math.sin(body.rotationY) * vz > 0.5) facingOk++;
                }
            }
            prev.set(mv, [mv.cx, mv.cz]);
            if (a.mode === 'car') {
                if (a.fading === 0) minCarScaleMid = Math.min(minCarScaleMid, (body as FakeMesh).sx);
            } else if (mv.legs) {
                legSwing = Math.max(legSwing, Math.abs((mv.legs[0].mesh as unknown as FakeMesh).rotation));
                // Free arms swing OPPOSITE their same-side leg (the left arm comes forward with the right leg).
                for (const A of mv.arms ?? []) {
                    const ar = (A.mesh as unknown as FakeMesh).rotation, L = mv.legs.find(l => l.side === A.side);
                    armSwing = Math.max(armSwing, Math.abs(ar));
                    const lr = L ? (L.mesh as unknown as FakeMesh).rotation : 0;
                    if (Math.abs(lr) > 0.05) { armChecks++; if (Math.sign(ar) === -Math.sign(lr)) armOpposite++; }
                }
            }
        }
        if (f % 30 === 0) for (const g of host._groups[0].children) if (/^world:signal-green-0a$/.test(g.name)) lampColours.add(g.material.diffuse.r.toFixed(2));
    }

    it('spawned routed cars and walkers', () => {
        expect(tr.movers.filter(m => m.agent?.mode === 'car').length).toBeGreaterThan(10);
        expect(tr.movers.filter(m => m.agent?.mode === 'walk').length).toBeGreaterThan(30);
    });
    it('cars never shrink mid-route (only an explicit dead-end fade)', () => { expect(minCarScaleMid).toBeGreaterThan(0.999); });
    it('everyone moves continuously — no teleports', () => { expect(maxJump, dbg).toBeLessThan(1.6); });
    it('walkers face the way they walk', () => { expect(facingChecks).toBeGreaterThan(500); expect(facingOk / facingChecks).toBeGreaterThan(0.9); });
    it('walkers swing their legs', () => { expect(legSwing).toBeGreaterThan(0.2); });
    it('free arms swing too, opposite the same-side leg', () => { expect(armSwing).toBeGreaterThan(0.15); expect(armChecks).toBeGreaterThan(100); expect(armOpposite).toBe(armChecks); });
    it('a mesh shown by the sim (chat emote / back out of a door) asks the host to re-filter its render list', () => { expect(host.visNotifies).toBeGreaterThan(0); });
    it('the signal lamps change (lit ↔ unlit) as the phase clock runs', () => { expect(lampColours.size).toBeGreaterThanOrEqual(2); });

    it('cars hold at the stop line: a car that had room to stop when its light went red never crosses it on red', () => {
        let checks = 0, bad = 0;
        const was = new Map<unknown, { leg: unknown; mustStop: boolean }>();
        for (let f = 0; f < 30 * 30; f++) {
            host._simTime += dt; tr.tick(dt);
            for (const mv of tr.movers) {
                const a = mv.agent; if (!a || a.mode !== 'car' || a.leg.stopKind !== 'signal') { was.delete(mv); continue; }
                const e = net.edges[a.leg.edge], sig = net.nodes[e.to].signal!;
                const axis = Math.abs(e.d[0] * sig.axis0[0] + e.d[1] * sig.axis0[1]) > 0.7 ? 0 : 1;
                const lamp = signalState(host._simTime, sig.bucket, axis, tr.timing).lamp;
                const hold = a.leg.stopS - a.halfLen;
                let w = was.get(mv);
                if (!w || w.leg !== a.leg) { w = { leg: a.leg, mustStop: false }; was.set(mv, w); }
                if (lamp !== 'red') { w.mustStop = false; continue; }
                // First red frame with plenty of room (≥ 2× the braking distance) → this car MUST stop.
                const brakeDist = mv.vel * mv.vel / (2 * mv.spec.speed * 3.2);
                if (!w.mustStop && a.s < hold - Math.max(0.02 * s, 2 * brakeDist) && !a.through) { w.mustStop = true; checks++; }
                if (w.mustStop && a.s > hold + 0.006 * s) bad++;
            }
        }
        expect(bad).toBe(0);
        expect(checks).toBeGreaterThan(0);
    });
});
