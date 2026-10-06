/**
 * world-traffic-follow.test.ts — CAR FOLLOWING (Gipps safe speed over the per-edge lane order) + PLAYER YIELD in the
 * live traffic ticker, against a FAKE scene (no renderer):
 *  - the whole city for a minute: no two same-direction cars in one lane ever overlap (centres vs car lengths);
 *  - a queue at a red light stops cleanly behind the lead car (standstill gaps, no overlap);
 *  - a fast car catching a slow one stays behind it;
 *  - the Play player standing in the lane: the lead car stops short of them, the followers queue, all resume after;
 *  - a queue across a junction / through a turn (a stopped car just past the junction);
 *  - RIGHT-OF-WAY at unsignalled junctions: no two cars' bodies overlap in / at a junction box (any heading), stem
 *    traffic yields, throughput holds;
 *  - the player on a footbridge above the lane is no obstacle (height); one in the lane / the box holds cars for good;
 *  - sim LOD: far cars stepped in substeps never overlap their leader.
 */
import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { SimLod } from '../../world/sim-lod';
import { WorldTraffic, type MoverRec } from './world-traffic';
import { generateCityLayout } from '../../world/layout';
import { roadNet, carLeg, carNext, legPoint, type RoadNet, type Leg } from '../../world/route-sim';
import { buildTrafficLights, signalState } from '../../world/signals';
import type { LayoutPreviewLayer } from '../../world/types';

class FakeMesh {
    name: string; visible = true; cheapBounds = false; materialDirty = false;
    x = 0; y = 0; z = 0; rotationY = 0; rotation = 0; sx = 1;
    material: { diffuse: { r: number; g: number; b: number; a: number }; emissive: { r: number; g: number; b: number; a: number } };
    constructor(L: LayoutPreviewLayer) {
        this.name = L.name;
        this.material = { diffuse: { r: L.color[0], g: L.color[1], b: L.color[2], a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 } };
    }
    setXYZ(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; }
    setPoseXYZYaw(x: number, y: number, z: number, ry: number, rz: number = this.rotation): void { this.x = x; this.y = y; this.z = z; this.rotationY = ry; this.rotation = rz; }
    setScale3D(s: number): void { this.sx = s; }
    setDiffuseColor(r: number, g: number, b: number): void { this.material.diffuse = { r, g, b, a: 1 }; }
    updateLocalMatrix(): void { /* no-op */ }
}

type Feet = { x: number; y: number; z: number; height: number; groundY?: number } | null;
/** `camAt` → a camera + an enabled sim LOD (far cars substep). */
function fakeHost(seed: number, camAt?: [number, number, number]) {
    const graph = generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square' });
    const groups: { children: FakeMesh[] }[] = [{ children: buildTrafficLights(graph).map(L => new FakeMesh(L)) }];
    let lodBits: Record<string, unknown> = {};
    if (camAt) {
        const proj = mat4.perspective(mat4.create(), Math.PI / 4, 1.5, 0.1, 5000), view = mat4.lookAt(mat4.create(), camAt, [0, 0, 0], [0, 1, 0]);
        const vp = mat4.multiply(mat4.create(), proj, view) as unknown as ArrayLike<number>;
        const simLod = new SimLod();
        simLod.view.cam = [...camAt]; simLod.view.vp = vp; simLod.view.mpu = 15; simLod.view.fogEye = [...camAt];
        lodBits = { simLod, getCamera: () => ({ position: camAt, getViewProjectionMatrix: () => vp }) };
    }
    const host = {
        _graph: graph, _groups: groups, _sceneEpoch: 0, get _meshSetEpoch(): number { return this._sceneEpoch; }, _simTime: 0, _timeOfDay: null as number | null, _lastGlowNight: -1,
        _warpScratch: [0, 0] as [number, number],
        _warpInto: (_x: number, _z: number, out: [number, number]) => { out[0] = 0; out[1] = 0; },
        _heightFn: () => 0, _smoothFn: () => 0,
        _allWorldMeshes: () => groups.flatMap(g => g.children),
        _ensureCityContainer: () => null, _hasStyle: () => false, _applyRenderStyle: () => {}, _applyTimeOfDay: () => {}, _ensureTicker: () => {},
        cityRoot: null,
        scene3d: {
            playerFeet3D: null as Feet,
            addFlatColorMeshGroup: (_n: string, layers: LayoutPreviewLayer[]) => { const g = { children: layers.map(L => new FakeMesh(L)) }; for (const m of g.children) (m as unknown as { parent: unknown }).parent = g; groups.push(g); return g; },
            removeFlatColorMeshGroup: () => {}, notifyMeshTransformsChanged3D: () => {}, notifyVisibilityChanged3D: () => {},
            ...lodBits,
        },
    };
    return { host, graph };
}

/** Do two cars' bodies (rectangles: half-length x half-width 0.8 m, a bus 1.2 m) overlap by more than `tol`? */
function bodiesOverlap(P: MoverRec, Q: MoverRec, M: number, tol: number): boolean {
    const p = P.agent!, q = Q.agent!, wP = (p.bus ? 1.2 : 0.8) * M, wQ = (q.bus ? 1.2 : 0.8) * M;
    for (const [ux, uz] of [[P.hx, P.hz], [-P.hz, P.hx], [Q.hx, Q.hz], [-Q.hz, Q.hx]]) {
        const c = Math.abs((Q.cx - P.cx) * ux + (Q.cz - P.cz) * uz);
        const rP = p.halfLen * Math.abs(P.hx * ux + P.hz * uz) + wP * Math.abs(-P.hz * ux + P.hx * uz);
        const rQ = q.halfLen * Math.abs(Q.hx * ux + Q.hz * uz) + wQ * Math.abs(-Q.hz * ux + Q.hx * uz);
        if (c > rP + rQ - tol) return false;
    }
    return true;
}
/** Overlapping car pairs (any heading) where one of them is in / at the box of an UNSIGNALLED junction (on its curve,
 *  tail not yet clear, or nose at the mouth). Head-on pairs (a car swinging out past a parked car into the oncoming
 *  lane) are not a junction matter and are left out. O(n^2), test-only. */
function junctionOverlaps(list: MoverRec[], net: RoadNet, s: number): number {
    const M = s / 15;
    const box = (m: MoverRec): number => {
        const a = m.agent!, e = net.edges[a.leg.edge];
        const n = a.s < a.leg.sStart + a.halfLen ? e.from : a.leg.total - a.s < a.halfLen + 0.5 * M ? e.to : -1;
        return n >= 0 && !net.nodes[n].signal && net.nodes[n].arms.length >= 2 ? n : -1;
    };
    let n = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (A.agent!.fading !== 0 || B.agent!.fading !== 0 || A.agent!.leg.edge === B.agent!.leg.edge) continue;
        if (Math.hypot(B.cx - A.cx, B.cz - A.cz) > A.agent!.halfLen + B.agent!.halfLen + 2.5 * M) continue;
        if (box(A) < 0 && box(B) < 0) continue;
        if (A.hx * B.hx + A.hz * B.hz < -0.9) continue;
        if (bodiesOverlap(A, B, M, 0.02 * M)) n++;
    }
    return n;
}

/** Same-direction cars in one lane that overlap: |longitudinal| < the two half-lengths (minus `tol`), laterally inside
 *  a lane, headings parallel. O(n²) — a test-only measure, independent of the sim's own leader bookkeeping. */
function overlaps(cars: MoverRec[], s: number, tol: number, net?: RoadNet): { n: number; worst: number; what: string; merge: number } {
    let n = 0, worst = Infinity, what = '', merge = 0;
    const M = s / 15;
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const A = cars[i], B = cars[j], a = A.agent!, b = B.agent!;
        if (a.fading !== 0 || b.fading !== 0) continue;   // a dead-end fade shrinks + re-enters (not a lane car)
        if (A.hx * B.hx + A.hz * B.hz < 0.9) continue;
        const dx = B.cx - A.cx, dz = B.cz - A.cz;
        const lon = dx * A.hx + dz * A.hz, lat = Math.abs(-dx * A.hz + dz * A.hx);
        if (lat > 1.2 * M) continue;
        const clear = Math.abs(lon) - a.halfLen - b.halfLen;
        // With `net`: only LANE pairs count — the same edge, or a leader that left the follower's own lane onto the
        // edge it will take next. Two approaches converging in a junction box (a turn across / into traffic at an
        // unsignalled junction) is a right-of-way conflict, counted separately in `merge`.
        if (net && a.leg.edge !== b.leg.edge) {
            const [F, Ld] = lon > 0 ? [a, b] : [b, a];
            const nx = carNext(net, F.leg.edge, F.id, F.visit + 1, F.bus), end = F.leg.pts[F.leg.pts.length - 1], q0 = Ld.leg.pts[0];
            const fromMyLane = Math.hypot(q0[0] - end[0], q0[1] - end[1]) < 1e-4 * s;
            if (nx !== Ld.leg.edge || !fromMyLane) { if (clear < -tol) merge++; continue; }
        }
        if (clear < worst) { worst = clear; what = `ids ${a.id}/${b.id} edges ${a.leg.edge}/${b.leg.edge} lon=${lon.toFixed(3)} hl=${a.halfLen.toFixed(3)}+${b.halfLen.toFixed(3)}`; }
        if (clear < -tol) n++;
    }
    return { n, worst, what, merge };
}

const dt = 1 / 30;
const cars = (tr: WorldTraffic): MoverRec[] => tr.movers.filter(m => m.agent?.mode === 'car');

/** A simulated minute of the whole city (seed): lane overlaps, junction merges, junction body overlaps, mean speed. */
function cityMinute(seed: number, junctionYield = true) {
    const { host, graph } = fakeHost(seed);
    const tr = new WorldTraffic(host as never);
    tr.follow.junctionYield = junctionYield;
    tr.start();
    const s = graph.params.radius / 10;
    const net = roadNet(graph);
    let bad = 0, worst = Infinity, what = '', frames = 0, merge = 0, box = 0, vSum = 0, vN = 0;
    for (let f = 0; f < 60 * 30; f++) {
        host._simTime += dt; tr.tick(dt);
        if (f < 30) continue;   // let the spawn settle one second
        const cs = cars(tr);
        const o = overlaps(cs, s, 0.02 * s / 15, net);
        bad += o.n; frames++; merge += o.merge; box += junctionOverlaps(cs, net, s);
        for (const c of cs) { vSum += c.vel / c.spec.speed; vN++; }
        if (o.worst < worst) { worst = o.worst; what = `f=${f} ${o.what}`; }
    }
    return { bad, worst, what, frames, merge, box, meanV: vSum / vN, tr };
}

describe('car following — a simulated minute of the whole city', () => {
    const r = cityMinute(11);
    it('no same-lane car ever overlaps another (centres along the lane vs car lengths)', () => {
        expect(r.frames).toBeGreaterThan(1000);
        expect(r.bad, `worst clearance ${r.worst.toFixed(4)} (${r.what})`).toBe(0);
    });
    it('no junction-box merge conflicts (was ~20 000 overlapping pair-frames/min before following, 29 before right-of-way)', () => {
        expect(r.merge).toBe(0);
    });
    it('no two car bodies overlap at an unsignalled junction, any heading (was ~100 pair-frames/min)', () => {
        expect(r.box).toBe(0);
    });
});

describe('right-of-way at unsignalled junctions', () => {
    it('a second city (seed 7): no junction merges or body overlaps either', () => {
        const r = cityMinute(7);
        expect(r.bad).toBe(0);
        expect(r.merge).toBe(0);
        expect(r.box).toBe(0);
    });
    it('throughput holds: the mean speed stays within a few % of the model switched off (no gridlock)', () => {
        const on = cityMinute(11), off = cityMinute(11, false);
        expect(on.meanV).toBeGreaterThan(off.meanV * 0.93);
        expect(off.box).toBeGreaterThan(20);   // (the measure does see the conflicts the model removes)
    });
    it('stem traffic at a T waits at its line while a main-road car through the box is coming', () => {
        const S = scene(), { host, tr, net, s } = S;
        const stemCar = S.pool[0], mainCar = S.pool[1];
        // A T: a stem approach (stop sign) and a main-road approach whose next picks are the same exit (a sure conflict).
        let found: { stem: Leg; main: Leg } | null = null;
        for (const e of net.carEdges) {
            const L = carLeg(net, e, null);
            if (L.stopKind !== 'sign' || L.total - L.sStart < 1.0 * s) continue;
            const node = net.nodes[net.edges[e].to];
            const nxS = carNext(net, e, stemCar.agent!.id, 1, false);
            if (nxS === null) continue;
            for (const o of node.out) {
                const m = net.edges[o].rev;
                if (m === e || !net.edges[m].car) continue;
                const LM = carLeg(net, m, null);
                if (LM.stopKind !== null || LM.total - LM.sStart < 1.0 * s) continue;
                if (carNext(net, m, mainCar.agent!.id, 1, false) !== nxS) continue;
                found = { stem: L, main: LM }; break;
            }
            if (found) break;
        }
        expect(found).not.toBeNull();
        const { stem, main } = found!, M = s / 15;
        // The stem car is stopped at its sign with the dwell served; the main-road car arrives at speed.
        place(stemCar, stem, stem.stopS - stemCar.agent!.halfLen - 2.5 * M, 0); stemCar.agent!.visit = 0; stemCar.agent!.signDone = true;
        place(mainCar, main, main.total - 0.9 * s, mainCar.spec.speed); mainCar.agent!.visit = 0;
        tr.movers.push(stemCar, mainCar);
        let stemFirst = false, mainThrough = false, overlap = false;
        for (let f = 0; f < 15 * 30; f++) {
            host._simTime += dt; tr.tick(dt);
            if (mainCar.agent!.leg !== main) mainThrough = true;
            if (!mainThrough && stemCar.agent!.leg !== stem) stemFirst = true;
            if (bodiesOverlap(stemCar, mainCar, M, 0)) overlap = true;
        }
        expect(mainThrough).toBe(true);
        expect(stemFirst, 'the stem car entered before the main-road car had passed').toBe(false);
        expect(stemCar.agent!.leg !== stem, 'the stem car goes once the box is clear').toBe(true);
        expect(overlap).toBe(false);
    });
});

// ── Controlled scenarios: only a few hand-placed cars (no walkers → no pedestrian yields) ─────────────────────────
interface Scene { host: ReturnType<typeof fakeHost>['host']; tr: WorldTraffic; net: RoadNet; s: number; pool: MoverRec[] }
function scene(): Scene {
    const { host, graph } = fakeHost(11);
    const tr = new WorldTraffic(host as never);
    tr.start();
    const pool = cars(tr).filter(m => !m.agent!.bus);
    tr.movers.length = 0;
    return { host, tr, net: roadNet(graph), s: graph.params.radius / 10, pool };
}
/** Put car `mv` on `leg` at leg distance `at`, speed `vel`. */
function place(mv: MoverRec, leg: Leg, at: number, vel: number): MoverRec {
    const a = mv.agent!;
    a.leg = leg; a.s = at; a.fading = 0; a.fade = 1; a.signDone = false; a.hold = 0; a.through = false; a.shift = 0;
    mv.vel = vel; mv.yaw = null; mv.pausedUntil = 0; mv.cooldownUntil = 0;
    legPoint(leg, at, LPT); mv.cx = LPT.x; mv.cz = LPT.z; mv.hx = LPT.hx; mv.hz = LPT.hz;
    return mv;
}
const LPT = { x: 0, z: 0, hx: 1, hz: 0, seg: 0 };
/** Along-lane order + clearances of cars sharing one leg (front first). */
function clearances(list: MoverRec[]): number[] {
    const q = [...list].sort((A, B) => B.agent!.s - A.agent!.s), out: number[] = [];
    for (let k = 1; k < q.length; k++) out.push(q[k - 1].agent!.s - q[k].agent!.s - q[k - 1].agent!.halfLen - q[k].agent!.halfLen);
    return out;
}

describe('car following — controlled scenarios', () => {
    it('a queue at a red light stops cleanly (no overlap, lead car on the line, followers at the standstill gap)', () => {
        const S = scene(), { host, tr, net, s } = S;
        tr.setSignalTiming({ green: 60, yellow: 2.5, allRed: 1.5 });
        // A long signalled edge.
        let best = -1, bestLen = 0;
        for (const e of net.carEdges) { const L = carLeg(net, e, null); if (L.stopKind === 'signal' && L.stopS - L.sStart > bestLen) { bestLen = L.stopS - L.sStart; best = e; } }
        expect(best).toBeGreaterThanOrEqual(0);
        const leg = carLeg(net, best, null);
        const e = net.edges[best], sig = net.nodes[e.to].signal!;
        const axis = Math.abs(e.d[0] * sig.axis0[0] + e.d[1] * sig.axis0[1]) > 0.7 ? 0 : 1;
        // A start time with ≥ 40 s of red left on this approach.
        let t0 = 0; while (!(signalState(t0, sig.bucket, axis, tr.timing).lamp === 'red' && signalState(t0, sig.bucket, axis, tr.timing).remaining > 40)) t0 += 0.25;
        host._simTime = t0;
        const q: MoverRec[] = [];
        // Tighter than the model's headway: all at full speed, 1 m bumper gaps (below the 2 m standstill gap) — as
        // many as fit on the approach (the edges are short; ≥ 3).
        let at = leg.stopS - 0.3 * s;
        for (let k = 0; k < 6; k++) {
            if (k > 0) at -= S.pool[k - 1].agent!.halfLen + S.pool[k].agent!.halfLen + 1.0 * s / 15;
            if (at - S.pool[k].agent!.halfLen < leg.sStart) break;
            q.push(place(S.pool[k], leg, at, S.pool[k].spec.speed));
        }
        expect(q.length).toBeGreaterThanOrEqual(3);
        tr.movers.push(...q);
        let minClear = Infinity;
        for (let f = 0; f < 30 * 30; f++) { host._simTime += dt; tr.tick(dt); for (const c of clearances(q)) minClear = Math.min(minClear, c); }
        const M = s / 15;
        expect(minClear, 'min bumper clearance in the queue (m)').toBeGreaterThan(tr.follow.hardGapM * M - 1e-9);
        for (const mv of q) expect(mv.vel).toBeLessThan(1e-3);
        const lead = [...q].sort((A, B) => B.agent!.s - A.agent!.s)[0];
        expect(lead.agent!.s).toBeLessThanOrEqual(leg.stopS - lead.agent!.halfLen + 0.006 * s);
        expect(leg.stopS - lead.agent!.halfLen - lead.agent!.s).toBeLessThan(0.02 * s);   // held ON the line
        for (const c of clearances(q)) { expect(c).toBeGreaterThan(tr.follow.jamGapM * M * 0.8); expect(c).toBeLessThan(tr.follow.jamGapM * M * 1.6); }
    });

    it('a fast car catching a slow one stays behind it', () => {
        const S = scene(), { host, tr, net, s } = S;
        // A long edge with no stop line.
        let best = -1, bestLen = 0;
        for (const e of net.carEdges) { const L = carLeg(net, e, null); if (L.stopKind === null && L.total - L.sStart > bestLen) { bestLen = L.total - L.sStart; best = e; } }
        const leg = carLeg(net, best, null);
        const slow = place(S.pool[0], leg, leg.sStart + 0.9 * s, 0.15 * s), fast = place(S.pool[1], leg, leg.sStart, S.pool[1].spec.speed);
        slow.spec = { ...slow.spec, speed: 0.15 * s }; fast.spec = { ...fast.spec, speed: 0.64 * s };
        fast.vel = 0.64 * s;
        tr.movers.push(slow, fast);
        let minClear = Infinity, frames = 0, minFastVel = Infinity;
        const M = s / 15;
        for (let f = 0; f < 30 * 30; f++) {
            host._simTime += dt; tr.tick(dt);
            if (slow.agent!.leg !== fast.agent!.leg && slow.agent!.leg.edge !== fast.agent!.leg.edge) continue;
            const o = overlaps([slow, fast], s, 0);
            if (o.n) minClear = -1;
            const ahead = slow.agent!.s - fast.agent!.s - slow.agent!.halfLen - fast.agent!.halfLen;
            if (slow.agent!.leg === fast.agent!.leg) { minClear = Math.min(minClear, ahead); frames++; minFastVel = Math.min(minFastVel, fast.vel); }
        }
        expect(frames).toBeGreaterThan(60);
        expect(minClear, 'bumper clearance (m)').toBeGreaterThan(tr.follow.hardGapM * M - 1e-9);
        expect(minFastVel).toBeLessThan(0.2 * s);   // it slowed to the leader's pace
    });

    it('the Play player in the lane: the lead car stops short, followers queue, all resume once the player leaves', () => {
        const S = scene(), { host, tr, net, s } = S;
        let best = -1, bestLen = 0;
        for (const e of net.carEdges) { const L = carLeg(net, e, null); if (L.stopKind === null && L.total - L.sStart > bestLen) { bestLen = L.total - L.sStart; best = e; } }
        const leg = carLeg(net, best, null);
        const pAt = leg.sStart + Math.min(leg.total - leg.sStart - 0.05 * s, 1.6 * s);
        legPoint(leg, pAt, LPT);
        host.scene3d.playerFeet3D = { x: LPT.x, y: 0, z: LPT.z, height: 0.1 };
        const q: MoverRec[] = [];
        for (let k = 0; k < 3; k++) q.push(place(S.pool[k], leg, leg.sStart + 0.6 * s - k * 0.4 * s, S.pool[k].spec.speed));
        tr.movers.push(...q);
        let minClear = Infinity;
        for (let f = 0; f < 25 * 30; f++) { host._simTime += dt; tr.tick(dt); for (const c of clearances(q)) minClear = Math.min(minClear, c); }
        const M = s / 15, R = tr.follow.playerRadiusM * M;
        const lead = [...q].sort((A, B) => B.agent!.s - A.agent!.s)[0];
        for (const mv of q) { expect(mv.vel).toBeLessThan(1e-3); expect(mv.agent!.leg).toBe(leg); }
        const front = lead.agent!.s + lead.agent!.halfLen;
        expect(front, 'lead bumper stays short of the player').toBeLessThan(pAt - R);
        expect(pAt - R - front).toBeLessThan(tr.follow.jamGapM * M * 1.6);
        expect(minClear).toBeGreaterThan(tr.follow.hardGapM * M - 1e-9);
        // The player steps off the road → everyone drives on (past where the player stood).
        host.scene3d.playerFeet3D = null;
        for (let f = 0; f < 6 * 30; f++) { host._simTime += dt; tr.tick(dt); }
        expect(lead.agent!.leg !== leg || lead.agent!.s > pAt).toBe(true);
        for (const mv of q) expect(mv.vel).toBeGreaterThan(0.1 * s);
    });

    it('the player on the pavement beside the lane is no obstacle', () => {
        const S = scene(), { host, tr, net, s } = S;
        let best = -1, bestLen = 0;
        for (const e of net.carEdges) { const L = carLeg(net, e, null); if (L.stopKind === null && L.total - L.sStart > bestLen) { bestLen = L.total - L.sStart; best = e; } }
        const leg = carLeg(net, best, null), M = s / 15;
        const pAt = leg.sStart + Math.min(leg.total - leg.sStart - 0.05 * s, 1.2 * s);
        legPoint(leg, pAt, LPT);
        // Toward the kerb (our lane is LEFT of the centreline: −L(d) = (hz, −hx)), just onto the pavement.
        const side = (net.half - net.lane) + 0.6 * M;
        host.scene3d.playerFeet3D = { x: LPT.x + LPT.hz * side, y: 0, z: LPT.z - LPT.hx * side, height: 0.1 };
        const car = place(S.pool[0], leg, leg.sStart, S.pool[0].spec.speed);
        tr.movers.push(car);
        let minVel = Infinity;
        for (let f = 0; f < 8 * 30 && car.agent!.leg === leg; f++) { host._simTime += dt; tr.tick(dt); if (car.agent!.leg === leg) minVel = Math.min(minVel, car.vel); }
        expect(car.agent!.leg !== leg || car.agent!.s > pAt).toBe(true);
        expect(minVel).toBeGreaterThan(0.9 * car.spec.speed);
    });

    for (const turn of [false, true]) it(`queues across a junction${turn ? ' through a turn' : ' (straight on)'}: no overlap behind a car stopped just past it`, () => {
        const S = scene(), { host, tr, net, s } = S;
        tr.setSignalTiming({ green: 600, yellow: 2.5, allRed: 1.5 });
        // An approach edge whose far junction is unsignalled (no stop line), and whose next pick (as the follower
        // will choose it) goes straight / turns.
        const fol = S.pool[1], fid = fol.agent!.id;
        let pick: { a: number; b: number } | null = null;
        for (const e of net.carEdges) {
            const L = carLeg(net, e, null);
            if (L.stopKind !== null || L.total - L.sStart < 1.2 * s) continue;
            const nx = carNext(net, e, fid, 1, false);
            if (nx === null) continue;
            const c = net.edges[nx].d[0] * net.edges[e].d[0] + net.edges[nx].d[1] * net.edges[e].d[1];
            if (turn ? c > 0.3 : c < 0.9) continue;
            if (net.nodes[net.edges[e].to].arms.length < 3) continue;
            pick = { a: e, b: nx }; break;
        }
        expect(pick).not.toBeNull();
        const legA = carLeg(net, pick!.a, null), legB = carLeg(net, pick!.b, pick!.a);
        // A broken-down car just past the junction curve (speed 0 → it never moves).
        const stopped = place(S.pool[0], legB, legB.sStart + S.pool[0].agent!.halfLen + 0.02 * s, 0);
        stopped.spec = { ...stopped.spec, speed: 0 };
        place(fol, legA, legA.total - 1.0 * s, fol.spec.speed); fol.agent!.visit = 0;
        const fol2 = place(S.pool[2], legA, legA.total - 1.45 * s, S.pool[2].spec.speed);
        tr.movers.push(stopped, fol, fol2);
        let worst = Infinity, what = '';
        for (let f = 0; f < 20 * 30; f++) {
            host._simTime += dt; tr.tick(dt);
            const o = overlaps([stopped, fol, fol2], s, 0);
            if (o.worst < worst) { worst = o.worst; what = o.what; }
            // Physical distance between centres vs the half-lengths (the curve breaks the lane frame).
            const d = Math.hypot(fol.cx - stopped.cx, fol.cz - stopped.cz);
            worst = Math.min(worst, d - fol.agent!.halfLen - stopped.agent!.halfLen);
        }
        const M = s / 15;
        expect(worst, what).toBeGreaterThan(tr.follow.hardGapM * M * 0.5);
        expect(fol.vel).toBeLessThan(1e-3);
        expect(fol2.vel).toBeLessThan(1e-3);
        expect(fol.agent!.leg.edge === pick!.b || fol.agent!.leg.edge === pick!.a).toBe(true);
    });
});

/** The longest edge with no stop line (a clear straight run). */
function longClearLeg(net: RoadNet): Leg {
    let best = -1, bestLen = 0;
    for (const e of net.carEdges) { const L = carLeg(net, e, null); if (L.stopKind === null && L.total - L.sStart > bestLen) { bestLen = L.total - L.sStart; best = e; } }
    return carLeg(net, best, null);
}
/** Distance from point (x, z) to car `mv`'s axis segment (centre ± half-length along its heading). */
function axisDist(mv: MoverRec, x: number, z: number): number {
    const hl = mv.agent!.halfLen, ax = mv.cx - mv.hx * hl, az = mv.cz - mv.hz * hl;
    const t = Math.max(0, Math.min(2 * hl, (x - ax) * mv.hx + (z - az) * mv.hz));
    return Math.hypot(x - ax - mv.hx * t, z - az - mv.hz * t);
}

describe('player yield — height and patience', () => {
    for (const [label, feetM, groundM, stops] of [
        ['on a footbridge 5 m above the lane: no obstacle', 5, 5, false],
        ['jumping in the lane (feet 1.2 m up, ground = the road): an obstacle', 1.2, 0, true],
        ['standing on a kerb-high step (0.4 m): an obstacle', 0.4, 0.4, true],
    ] as const) it(`the player ${label}`, () => {
        const S = scene(), { host, tr, net, s } = S, M = s / 15;
        const leg = longClearLeg(net);
        const pAt = leg.sStart + Math.min(leg.total - leg.sStart - 0.05 * s, 1.2 * s);
        legPoint(leg, pAt, LPT);
        host.scene3d.playerFeet3D = { x: LPT.x, y: feetM * M, z: LPT.z, height: 0.1, groundY: groundM * M };
        const car = place(S.pool[0], leg, leg.sStart, S.pool[0].spec.speed);
        tr.movers.push(car);
        let minVel = Infinity;
        for (let f = 0; f < 8 * 30 && car.agent!.leg === leg; f++) { host._simTime += dt; tr.tick(dt); if (car.agent!.leg === leg) minVel = Math.min(minVel, car.vel); }
        if (stops) {
            expect(car.agent!.leg).toBe(leg);
            expect(car.vel).toBeLessThan(1e-3);
            expect(car.agent!.s + car.agent!.halfLen).toBeLessThan(pAt - tr.follow.playerRadiusM * M);
        } else {
            expect(car.agent!.leg !== leg || car.agent!.s > pAt).toBe(true);
            expect(minVel).toBeGreaterThan(0.9 * car.spec.speed);
        }
    });

    it('cars wait for as long as the player stands in the lane (2 min) and never push through', () => {
        const S = scene(), { host, tr, net, s } = S, M = s / 15;
        const leg = longClearLeg(net);
        const pAt = leg.sStart + Math.min(leg.total - leg.sStart - 0.05 * s, 1.6 * s);
        legPoint(leg, pAt, LPT);
        const px = LPT.x, pz = LPT.z, R = tr.follow.playerRadiusM * M;
        host.scene3d.playerFeet3D = { x: px, y: 0, z: pz, height: 0.1, groundY: 0 };
        const q: MoverRec[] = [];
        for (let k = 0; k < 3; k++) q.push(place(S.pool[k], leg, leg.sStart + 0.6 * s - k * 0.4 * s, S.pool[k].spec.speed));
        tr.movers.push(...q);
        let minD = Infinity, maxLateVel = 0;
        for (let f = 0; f < 120 * 30; f++) {
            host._simTime += dt; tr.tick(dt);
            for (const mv of q) minD = Math.min(minD, axisDist(mv, px, pz));
            if (f > 20 * 30) for (const mv of q) maxLateVel = Math.max(maxLateVel, mv.vel);
        }
        expect(minD, 'closest car axis to the player (world units)').toBeGreaterThan(R + 0.8 * M);
        expect(maxLateVel, 'nobody creeps on after the queue has settled').toBeLessThan(1e-6);
        for (const mv of q) expect(mv.agent!.leg).toBe(leg);
        host.scene3d.playerFeet3D = null;
        for (let f = 0; f < 6 * 30; f++) { host._simTime += dt; tr.tick(dt); }
        for (const mv of q) expect(mv.vel).toBeGreaterThan(0.1 * s);
    });

    it('a player standing in an unsignalled junction box holds the car turning through it (2 min), overdue or not', () => {
        const S = scene(), { host, tr, net, s } = S, M = s / 15;
        const car = S.pool[0], id = car.agent!.id;
        let pick: { a: number; b: number } | null = null;
        for (const e of net.carEdges) {
            const L = carLeg(net, e, null);
            if (L.stopKind !== null || L.total - L.sStart < 1.2 * s || net.nodes[net.edges[e].to].arms.length < 3) continue;
            const nx = carNext(net, e, id, 1, false);
            if (nx === null) continue;
            const c = net.edges[nx].d[0] * net.edges[e].d[0] + net.edges[nx].d[1] * net.edges[e].d[1];
            if (c > 0.3) continue;   // a turn
            pick = { a: e, b: nx }; break;
        }
        expect(pick).not.toBeNull();
        const legA = carLeg(net, pick!.a, null), legB = carLeg(net, pick!.b, pick!.a);
        legPoint(legB, legB.sStart * 0.5, LPT);   // mid-curve, in the box
        const px = LPT.x, pz = LPT.z, R = tr.follow.playerRadiusM * M;
        host.scene3d.playerFeet3D = { x: px, y: 0, z: pz, height: 0.1, groundY: 0 };
        place(car, legA, legA.total - 0.8 * s, car.spec.speed); car.agent!.visit = 0;
        tr.movers.push(car);
        let minD = Infinity;
        for (let f = 0; f < 120 * 30; f++) { host._simTime += dt; tr.tick(dt); minD = Math.min(minD, axisDist(car, px, pz)); }
        expect(minD).toBeGreaterThan(R + 0.5 * M);
        expect(car.vel).toBeLessThan(1e-3);
        host.scene3d.playerFeet3D = null;
        for (let f = 0; f < 8 * 30; f++) { host._simTime += dt; tr.tick(dt); }
        expect(car.agent!.leg.edge !== pick!.a || car.agent!.s > legA.total - 1e-6 || car.vel > 0.1 * s).toBe(true);
    });
});

describe('sim LOD: far cars in substeps', () => {
    it('a far / off-screen city for a minute: substepped cars never overlap their leader or each other at a junction', () => {
        // The camera far out over one corner: the near corner is NEAR / MID, most of the city FAR or off screen.
        const { host, graph } = fakeHost(11, [60, 30, 60]);
        const tr = new WorldTraffic(host as never);
        tr.start();
        const s = graph.params.radius / 10, net = roadNet(graph), lod = (host.scene3d as unknown as { simLod: SimLod }).simLod;
        let bad = 0, worst = Infinity, what = '', merge = 0, box = 0;
        for (let f = 0; f < 60 * 30; f++) {
            host._simTime += dt; tr.tick(dt);
            if (f < 30) continue;
            const cs = cars(tr), o = overlaps(cs, s, 0.02 * s / 15, net);
            bad += o.n; merge += o.merge; box += junctionOverlaps(cs, net, s);
            if (o.worst < worst) { worst = o.worst; what = `f=${f} ${o.what}`; }
        }
        const C = lod.counter('cars');
        expect(C.totalSkipped, 'cars were actually throttled into substeps').toBeGreaterThan(cars(tr).length * 300);
        expect(bad, `worst clearance ${worst.toFixed(4)} (${what})`).toBe(0);
        expect(merge).toBe(0);
        expect(box).toBe(0);
    });
});
