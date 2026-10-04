// railway-upgrade R3.2 — the LEVEL CROSSINGS' live half (the at-grade local line): per-crossing state stepped from the
// local consist's run (world/level-crossing.ts), the barrier ARMS (their own small meshes, created with the traffic
// movers and hidden with them — the static build carries raised arms for when the sim is off), the alternating red
// LAMPS (static phase-switched layers — a MATERIAL-only write, never gpuDirty, like the traffic signals), and the
// hold query the car + walker routing asks ("how far to the stop line of a closed crossing ahead of me?").
// Owned by WorldTraffic; `w` is the manager (wide host, like the traffic sim).
import type { WorldManager } from './world-manager';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { WorldGraph } from '../../world/types';
import { Accum3D } from '../../world/meshbuild';
import { localTrack, localArms, localRunPlan, LOCAL_LAMP_RE, LOCAL_LAMP_ON, LOCAL_LAMP_OFF, type LocalTrack, type LocalArm } from '../../world/local-line-build';
import { LOCAL_M, crossingFrame, crossingSin } from '../../world/local-line';
import { crossingStart, stepCrossing, trainDemand, crossingClosed, lampPhase, type CrossingState } from '../../world/level-crossing';
import type { TrainRunPlan, TrainRunState } from '../../world/train';

interface ArmRec { mesh: Mesh3D; arm: LocalArm; x: number; y: number; z: number; yaw: number; last: number }
interface LampRec { mesh: Mesh3D; xing: number; ab: 0 | 1; on: boolean | null }

export class LocalCrossings {
    T: LocalTrack | null = null;
    states: CrossingState[] = [];
    private _arms: ArmRec[] = [];
    private _lamps: LampRec[] = [];
    private _group: MeshGroup3D | null = null;
    private _epoch = -1;
    private _half = 0;
    private readonly _f = { u: 0, w: 0 };

    constructor(private readonly w: WorldManager) {}

    /** Build the runtime for a graph (no-op without a local line). Called from WorldTraffic.spawn. */
    spawn(graph: WorldGraph): void {
        this.despawn();
        const T = this.T = localTrack(graph);
        if (!T) return;
        this.states = T.xings.map(() => crossingStart());
        this._half = localRunPlan(graph.params, T).half;
        // Live arms: one mesh per arm, built LOWERED along +x from the pivot (the ticker raises it about local Z).
        const arms = localArms(graph), u = T.unitsPerMetre;
        if (arms.length) {
            const layers = arms.map((a, k) => {
                const acc = new Accum3D();
                acc.obox([a.len / 2 + 0.05 * u, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], a.len / 2, 0.035 * u, 0.03 * u);
                acc.obox([-0.3 * u, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.25 * u, 0.07 * u, 0.06 * u);   // counterweight
                return { name: `world:local-xing-arm-live-${k}`, color: [0.92, 0.72, 0.08] as [number, number, number], geometry: acc.geometry(),
                    pattern: { color: [0.06, 0.06, 0.07] as [number, number, number], freq: 1 / (0.3 * u), scale: 0.5, mode: 'stripes' as const, angle: 0 } };
            });
            const g = this._group = this.w.scene3d.addFlatColorMeshGroup('World Crossing Arms', layers, true, this.w._ensureCityContainer());
            this.w._groups.push(g);
            const ms = g.children as unknown as Mesh3D[];
            arms.forEach((a, k) => {
                const m = ms[k]; if (!m) return;
                m.cheapBounds = true;
                this.w._warpInto(a.x, a.z, this.w._warpScratch);
                const x = a.x + this.w._warpScratch[0], z = a.z + this.w._warpScratch[1];
                const yaw = Math.atan2(-a.dir[1], a.dir[0]);
                this._arms.push({ mesh: m, arm: a, x, y: a.y, z, yaw, last: -1 });
                m.setPoseXYZYaw(x, a.y, z, yaw, Math.PI / 2);
            });
        }
        this._scanLamps();
    }

    /** Forget everything without touching the scene (a world clear removes the groups itself). */
    reset(): void { this._group = null; this._arms = []; this._lamps = []; this.states = []; this.T = null; this._epoch = -1; }

    despawn(): void {
        if (this._group) {
            this.w.scene3d.removeFlatColorMeshGroup(this._group, true);
            const i = this.w._groups.indexOf(this._group); if (i >= 0) this.w._groups.splice(i, 1);
        }
        this._group = null; this._arms = []; this._lamps = []; this.states = []; this.T = null; this._epoch = -1;
        // lamps back to OFF (a despawn mid-warning must not leave a lamp lit)
        for (const m of this.w._allWorldMeshes()) if (LOCAL_LAMP_RE.test(m.name ?? '')) this._dress(m, false);
    }

    private _scanLamps(): void {
        this._lamps = [];
        for (const m of this.w._allWorldMeshes()) {
            const r = LOCAL_LAMP_RE.exec(m.name ?? '');
            if (r) this._lamps.push({ mesh: m, xing: Number(r[1]), ab: r[2] === 'b' ? 1 : 0, on: null });
        }
        this._epoch = this.w._meshSetEpoch;
    }

    private _dress(m: Mesh3D, on: boolean): void {
        const mat = m.material; if (!mat) return;
        const f = mat.diffuse.r > 1e-4 ? mat.emissive.r / mat.diffuse.r : 0.55;
        const c = on ? LOCAL_LAMP_ON : LOCAL_LAMP_OFF;
        // ★ MATERIAL-ONLY write (materialDirty, never gpuDirty — see WorldTraffic._tickSignals).
        mat.diffuse = { r: c[0], g: c[1], b: c[2], a: 1 };
        mat.emissive = { r: c[0] * f, g: c[1] * f, b: c[2] * f, a: 1 };
        m.materialDirty = true;
    }

    /** Step every crossing from the local consist(s) and pose the arms / dress the lamps. */
    tick(dt: number, time: number, trains: { run: TrainRunState; plan: TrainRunPlan }[]): void {
        const T = this.T;
        if (!T || !this.states.length) return;
        if (this._epoch !== this.w._meshSetEpoch) this._scanLamps();
        const u = T.unitsPerMetre, margin = 2 * u;
        for (let i = 0; i < T.xings.length; i++) {
            const X = T.xings[i];
            let demand = false;
            for (const tr of trains) if (trainDemand(tr.run, tr.plan, this._half, X.arc - X.zoneHalf, X.arc + X.zoneHalf, margin)) { demand = true; break; }
            stepCrossing(this.states[i], demand, dt);
        }
        for (const A of this._arms) {
            const a = this.states[A.arm.xing]?.arm ?? 0;
            if (Math.abs(a - A.last) < 1e-4) continue;
            A.last = a;
            A.mesh.setPoseXYZYaw(A.x, A.y, A.z, A.yaw, (1 - a) * Math.PI / 2);
        }
        const ph = lampPhase(time);
        for (const L of this._lamps) {
            const st = this.states[L.xing];
            const on = !!st && st.lamps && ph === L.ab;
            if (on === L.on) continue;
            L.on = on;
            this._dress(L.mesh, on);
        }
    }

    /** Distance (world units) from a road user's front to the stop line of a crossing it must not enter, or Infinity:
     *  a CLOSED crossing it is approaching, or (cars) an open one whose far side is blocked by a queued car — nobody
     *  stops ON the tracks. `walker` stops just outside the barrier, a car at the painted stop line. Layout-space pose.
     *  `exitBlocked(q, sign, u0, u1)` answers "is a slow car in this lane beyond the crossing, u in [u0, u1] on the
     *  `sign` side?" (the caller owns the mover list). */
    holdDist(x: number, z: number, hx: number, hz: number, halfLen: number, walker: boolean,
        exitBlocked?: (q: LocalTrack['xings'][number]['q'], sign: number, u0: number, u1: number) => boolean): number {
        const T = this.T;
        if (!T) return Infinity;
        const u = T.unitsPerMetre, F = this._f;
        let best = Infinity;
        for (let i = 0; i < T.xings.length; i++) {
            const q = T.xings[i].q;
            if (Math.abs(x - q.x) > q.band * 6 || Math.abs(z - q.z) > q.band * 6) continue;
            crossingFrame(q, x, z, F);
            if (Math.abs(F.w) > q.band + 0.3 * u) continue;
            const hd = hx * q.d[0] + hz * q.d[1];
            if (Math.abs(hd) < 0.5 || F.u * hd >= 0) continue;            // not heading for the track
            const sA = crossingSin(q);
            const stopU = (walker ? LOCAL_M.barrier + LOCAL_M.walkWait : LOCAL_M.barrier + LOCAL_M.stopLine) * u / sA;
            const d = Math.abs(F.u) - stopU - halfLen;
            if (d < -0.6 * u) continue;                                      // already past the line: clear the crossing
            let stop = crossingClosed(this.states[i]);
            if (!stop && !walker && exitBlocked) {
                const uOut = LOCAL_M.barrier * u / sA, sg = F.u > 0 ? -1 : 1;   // the far side
                stop = exitBlocked(q, sg, uOut, uOut + 2 * halfLen + 3 * u);
            }
            if (!stop) continue;
            if (d < best) best = Math.max(0, d);
        }
        return best;
    }
}
