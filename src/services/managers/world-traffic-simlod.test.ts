/**
 * world-traffic-simlod.test.ts — sim LOD (performance-plan §P13) inside the traffic ticker, against a FAKE scene:
 *  - walkers frozen in the fog for half a minute land exactly where walkers updated all along are (the clock);
 *  - both stay on the stepped sim's routes (same legs) and close to its positions;
 *  - the selection is never throttled, a far crowd is;
 *  - switching sim LOD off hands every walker back to the stepped sim in place.
 */
import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { WorldTraffic } from './world-traffic';
import { generateCityLayout } from '../../world/layout';
import { legPoint } from '../../world/route-sim';
import { buildTrafficLights } from '../../world/signals';
import { SimLod } from '../../world/sim-lod';
import type { LayoutPreviewLayer } from '../../world/types';

let NEXT_ID = 1;
class FakeMesh {
    id = 'm' + (NEXT_ID++); name: string; visible = true; cheapBounds = false; materialDirty = false; fogHidden = false;
    x = 0; y = 0; z = 0; rotationY = 0; rotation = 0; sx = 1; poses = 0;
    localMatrix = new Float32Array(16);
    material: { diffuse: { r: number; g: number; b: number; a: number }; emissive: { r: number; g: number; b: number; a: number } };
    constructor(L: LayoutPreviewLayer) {
        this.name = L.name;
        this.material = { diffuse: { r: L.color[0], g: L.color[1], b: L.color[2], a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 } };
    }
    setXYZ(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; this.localMatrix[12] = x; this.localMatrix[13] = y; this.localMatrix[14] = z; }
    setPoseXYZYaw(x: number, y: number, z: number, ry: number, rz: number = this.rotation): void { this.setXYZ(x, y, z); this.rotationY = ry; this.rotation = rz; this.poses++; }
    setScale3D(s: number): void { this.sx = s; }
    setDiffuseColor(r: number, g: number, b: number): void { this.material.diffuse = { r, g, b, a: 1 }; }
    updateLocalMatrix(): void { /* no-op */ }
}

/** A fake world + scene with a camera and a sim LOD. `camAt` = camera position, looking at the city centre. */
function world(camAt: [number, number, number], opts: { lod?: boolean; selected?: Set<string> } = {}) {
    const graph = generateCityLayout({ seed: 11, radius: 10, pattern: 'grid', border: 'square' });
    const groups: { children: FakeMesh[] }[] = [{ children: buildTrafficLights(graph).map(L => new FakeMesh(L)) }];
    const proj = mat4.perspective(mat4.create(), Math.PI / 4, 1.5, 0.1, 5000), view = mat4.lookAt(mat4.create(), camAt, [0, 0, 0], [0, 1, 0]);
    const vp = mat4.multiply(mat4.create(), proj, view);
    const simLod = new SimLod();
    simLod.view.cam = [...camAt]; simLod.view.vp = vp as unknown as ArrayLike<number>; simLod.view.mpu = 15; simLod.view.fogEye = [...camAt];
    if (opts.lod === false) simLod.configure({ enabled: false });
    const host = {
        _graph: graph, _groups: groups, _sceneEpoch: 0, get _meshSetEpoch(): number { return this._sceneEpoch; }, _simTime: 0, _timeOfDay: null as number | null, _lastGlowNight: -1,
        _warpScratch: [0, 0] as [number, number],
        _warpInto: (_x: number, _z: number, out: [number, number]) => { out[0] = 0; out[1] = 0; },
        _heightFn: () => 0, _smoothFn: () => 0,
        _allWorldMeshes: () => groups.flatMap(g => g.children),
        _ensureCityContainer: () => null, _hasStyle: () => false, _applyRenderStyle: () => {}, _applyTimeOfDay: () => {}, _ensureTicker: () => {},
        cityRoot: null,
        scene3d: {
            simLod,
            renderer3D: { getSelectedMeshIds: () => opts.selected ?? new Set<string>() },
            getCamera: () => ({ position: camAt, getViewProjectionMatrix: () => vp }),
            addFlatColorMeshGroup: (_n: string, layers: LayoutPreviewLayer[]) => { const g = { children: layers.map(L => new FakeMesh(L)) }; for (const m of g.children) (m as unknown as { parent: unknown }).parent = g; groups.push(g); return g; },
            removeFlatColorMeshGroup: () => {}, notifyMeshTransformsChanged3D: () => {}, notifyVisibilityChanged3D: () => {}, notifySceneGraphChanged3D: () => {},
        },
    };
    const tr = new WorldTraffic(host as never);
    tr.start();
    for (const mv of tr.movers) mv.cooldownUntil = 1e9;   // no chats / door visits: those re-plan walkers by encounter
    const step = (secs: number, dt = 1 / 30): void => { for (let k = 0; k < secs / dt; k++) { host._simTime += dt; tr.tick(dt); } };
    return { tr, host, simLod, step, graph };
}
const walkersOf = (tr: WorldTraffic) => tr.movers.filter(m => m.agent?.mode === 'walk');
const P = { x: 0, z: 0, hx: 0, hz: 0, seg: 0 };

describe('sim LOD in the traffic ticker', () => {
    it('walkers frozen in the fog for 30 s land exactly where continuously updated ones are', () => {
        const A = world([0, 40, 60]), B = world([0, 40, 60]);
        A.step(5); B.step(5);
        A.simLod.view.fogEdge = 0;   // everything past the fog line → frozen
        A.step(30); B.step(30);
        A.simLod.view.fogEdge = Infinity;
        A.step(2); B.step(2);
        const wa = walkersOf(A.tr), wb = walkersOf(B.tr);
        expect(wa.length).toBeGreaterThan(10);
        expect(A.simLod.counter('walkers').totalSkipped).toBeGreaterThan(wa.length * 500);
        const t = A.host._simTime, pa = { leg: wa[0].agent!.leg } as never, pb = { leg: wb[0].agent!.leg } as never;
        for (let i = 0; i < wa.length; i++) {
            const ca = wa[i].clock!.eval(t, pa), cb = wb[i].clock!.eval(t, pb);
            expect((ca as { x: number }).x).toBe((cb as { x: number }).x);
            expect((ca as { z: number }).z).toBe((cb as { z: number }).z);
            expect((ca as { visit: number }).visit).toBe((cb as { visit: number }).visit);
        }
    });

    it('stays on the stepped sim\'s routes, close to its positions', () => {
        const L = world([0, 40, 60]), S = world([0, 40, 60], { lod: false });
        L.step(40); S.step(40);
        const wl = walkersOf(L.tr), ws = walkersOf(S.tr), s = L.graph.params.radius / 10;
        let close = 0, sameLeg = 0;
        for (let i = 0; i < wl.length; i++) {
            const a = wl[i].agent!, b = ws[i].agent!;
            legPoint(a.leg, a.s, P); const ax = P.x, az = P.z;
            legPoint(b.leg, b.s, P);
            if (Math.hypot(ax - P.x, az - P.z) < 0.05 * s) close++;
            if (a.visit === b.visit) sameLeg++;
        }
        expect(sameLeg / wl.length).toBeGreaterThan(0.9);
        expect(close / wl.length).toBeGreaterThan(0.85);
    }, 30000);   // two 40 s sim runs: past the 5 s default under full-suite load

    it('the selection is never throttled; far movers are', () => {
        const selected = new Set<string>();
        const W = world([0, 400, 600], { selected });   // far above: every mover far / off screen
        const m = walkersOf(W.tr)[3], other = walkersOf(W.tr)[4];
        selected.add(m.meshes[0].id);
        const p0 = m.meshes[0] as unknown as FakeMesh, o0 = other.meshes[0] as unknown as FakeMesh;
        W.step(0.5);
        const pm = p0.poses, po = o0.poses;
        W.step(3);
        expect(p0.poses - pm).toBeGreaterThanOrEqual(89);   // every tick (90)
        expect(o0.poses - po).toBeLessThan(20);              // ~2 Hz (+ anti-stutter off: no pixel scale)
        expect(m.sl!.band).toBe(0);
    });

    it('switching sim LOD off hands every walker back to the stepped sim in place', () => {
        const W = world([0, 40, 60]);
        W.step(10);
        const before = walkersOf(W.tr).map(mv => { const c = mv.clock!.eval(W.host._simTime, { leg: mv.agent!.leg } as never) as unknown as { x: number; z: number }; return [c.x, c.z]; });
        W.simLod.configure({ enabled: false });
        W.step(1 / 30);
        const ws = walkersOf(W.tr);
        for (let i = 0; i < ws.length; i++) {
            expect(ws[i].clock).toBeNull();
            legPoint(ws[i].agent!.leg, ws[i].agent!.s, P);
            const d = Math.hypot(P.x - before[i][0], P.z - before[i][1]);
            expect(d).toBeLessThanOrEqual(ws[i].spec.speed * 2 / 30 + 1e-9);   // the hand-back tick + one stepped tick
        }
    });
});
