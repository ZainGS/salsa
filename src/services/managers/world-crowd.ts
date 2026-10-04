// performance-plan P12 — the INSTANCED static crowd, services half (world/crowd-instanced.ts is the pure half).
//
// Every crowd build (the centre, each streamed tile, a pedestrian regen) arrives as person RECORDS + GPU-instanced xfar
// copies of shared variants (one ArrayGroup per tile and variant; the source is a never-drawn phantom, so every
// person is a copy and can be hidden on its own). This class owns the rest, per 50 m CELL:
//   · which tier a cell shows — NEAR (inside the crowd's first twin distance, 30 m), MID (inside the second, 100 m) or
//     XFAR — with the renderer's own rules (lens / quality scale, ortho = uniform zoom distance, the 10 % hysteresis,
//     distance LOD off = mid), written straight into the meshes' externally driven twin state (Mesh3D.lodTwinExternal)
//     and the xfar copies' visibility;
//   · building the NEAR / MID tiers LAZILY, only for the cells around the camera: the exact baked people (same emitter)
//     in ONE palette-coded mesh per cell (CrowdCellBuilder), time-sliced on the main thread, prefetched a little past
//     the swap distance and evicted past a larger one (+ a byte cap). A cell swaps to a tier only once its mesh is
//     resident on the GPU (no frame where neither tier draws); until then the nearest resident tier stands in;
//   · the live near-field crowd's hand-off: a promoted person's xfar copy is hidden too (setLive), and every mesh add /
//     remove bumps `version` so WorldLiveCrowd re-indexes (and hides a live person's ranges in a freshly built mesh).
// Lazily built meshes are children of the build's own group (so tile dispose / retire / regen take them along) and are
// dressed by the world's crowd style + glow rules like the baked layers (WorldManager._dressCrowdMesh).
import type { WorldManager } from './world-manager';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { ArrayGroup3D, InstanceOverride } from '../../scene-graph/shapes/array-group-3d';
import type { LayoutPreviewLayer, CrowdRecords } from '../../world/types';
import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import type { CrowdPerson } from '../../world/crowd-live';
import { buildCrowdCellAsync, nearWorkerAvailable } from '../workers/near-lane';
import { CrowdCellBuilder, crowdPeopleOf, crowdCellJob, adoptCrowdCell, type CrowdCellResult, cellKey, CREC_STRIDE, CREC_X, CREC_Y, CREC_Z, CREC_DX, CREC_DY, CREC_DZ, CREC_CX, CREC_CZ } from '../../world/crowd-instanced';
import { distanceLodHidden, fovDistanceScale, orthoLodDistance } from '../../renderer/3d/distance-lod';
import type { SimLod } from '../../world/sim-lod';

const NEAR = 0, MID = 1, XFAR = 2;

interface CrowdCell {
    key: number;
    people: number[];
    /** City-local box of the cell's people (render space). */
    box: Float64Array;
    /** World box (cached per container matrix). */
    wbox: Float64Array;
    near1: boolean; near2: boolean;
    shown: number;
    mesh: [Mesh3D | null, Mesh3D | null];
    /** Frame a mesh was added (it may swap in from the next frame on, once resident). */
    madeAt: [number, number];
    /** Last frame the tier was wanted (eviction LRU). */
    usedAt: [number, number];
    bytes: [number, number];
}
interface CrowdBlock {
    id: string;
    rec: CrowdRecords | null;
    people: CrowdPerson[];
    /** The group holding the AUX layer — parent of the lazily built meshes. */
    group: MeshGroup3D | null;
    groups: Set<MeshGroup3D>;
    xfar: ArrayGroup3D[];
    /** Per person: index into `xfar` (-1 = none yet) and the copy index there. */
    pg: Int32Array; pc: Int32Array;
    /** Visible copies per xfar group (the group draws while > 0). */
    shownCopies: Int32Array;
    src: Mesh3D | null;
    cells: CrowdCell[];
    cellOf: Int32Array;
    live: Uint8Array;
}

export interface CrowdBuildTask {
    b: CrowdBlock; c: CrowdCell; tier: 0 | 1;
    /** Main-thread builder (time-sliced), or null while the cell builds in the near worker. */
    builder: CrowdCellBuilder | null;
    /** Step 3 worker build: the job, its result once it lands (finished on the next update), failure → main thread. */
    job?: { promise: Promise<CrowdCellResult>; cancel(): void } | null;
    result?: CrowdCellResult | null;
}

export class WorldCrowd {
    constructor(private readonly w: WorldManager) {}

    /** Main-thread budget per frame for lazily emitting near / mid people (ms). */
    static BUILD_MS = 3;
    /** Prefetch factors (× the swap distance): a tier is built once the cell is this close… */
    static PREFETCH = [1.45, 1.25];
    /** …and dropped once it is farther than this. */
    static EVICT = [2.2, 1.7];
    /** Cap on the lazily built near + mid geometry (bytes); the least recently wanted go first. */
    static MAX_BYTES = 160 << 20;
    /** Step 3 A/B (sm.setStep3Options3D crowdCellsInWorker): near / mid cells build in the 'near' worker lane (only the
     *  merge into a mesh + its upload stay here); false = the main-thread builder (BUILD_MS a frame). */
    static inWorker = true;
    /** Worker cell builds in flight at once. */
    static MAX_IN_FLIGHT = 2;
    /** Step 3: the prefetch radius grows by this many seconds of the camera's travel (a fast street-level fly builds the
     *  cells ahead before it reaches them, so the far figures show as briefly as possible). 0 = the fixed radius. */
    static LEAD_S = 1.0;
    /** …capped at this many metres ahead (a 200 m/s fly would otherwise prefetch / evict cells far ahead and behind). */
    static LEAD_MAX_M = 40;
    /** Above this camera speed (m/s) no new near / mid cell is started: a 50 m cell is crossed in well under a second,
     *  so its build would land behind the camera (each build + eviction is a structure change and an upload). The
     *  cells that are resident keep showing; the rest show the instanced far figures until the camera slows down. */
    static SKIP_SPEED_MS = 50;

    private readonly _blocks = new Map<string, CrowdBlock>();
    private readonly _geo = new Map<string, MeshGeometry>();
    private readonly _who = new WeakMap<CrowdPerson, { b: CrowdBlock; i: number }>();
    private _tasks: CrowdBuildTask[] = [];
    private _taskFor(c: CrowdCell, t: 0 | 1): CrowdBuildTask | undefined { for (const T of this._tasks) if (T.c === c && T.tier === t) return T; return undefined; }
    private _cancelTasks(pred: (T: CrowdBuildTask) => boolean): void {
        this._tasks = this._tasks.filter((T) => { if (!pred(T)) return true; T.job?.cancel(); return false; });
    }
    // camera speed (world units / s, smoothed) for the prefetch lead
    private _camAt: [number, number, number, number] | null = null;
    private _camSpeed = 0;
    private _frame = 0;
    private _groupsSig = '';
    private readonly _mat = new Float64Array(16).fill(NaN);
    private _bytes = 0;
    private readonly _dirtyGroups = new Set<ArrayGroup3D>();
    /** Bumped whenever a lazily built crowd mesh is added or removed (WorldLiveCrowd re-indexes). */
    version = 0;
    readonly stats = { workerJobs: 0, waiting: 0, waitCellFrames: 0, skippedFast: 0, blocks: 0, people: 0, cells: 0, near: 0, mid: 0, xfarGroups: 0, xfarCopies: 0, residentBytes: 0, builds: 0, buildMs: 0, buildMaxMs: 0, finishMaxMs: 0, updateMs: 0, updateMaxMs: 0, evictions: 0, repacks: 0, shown: [0, 0, 0] as number[] };
    resetStats(): void { this.stats.waitCellFrames = 0; this.stats.workerJobs = 0; this.stats.skippedFast = 0; this.stats.buildMaxMs = 0; this.stats.finishMaxMs = 0; this.stats.updateMaxMs = 0; this.stats.builds = 0; this.stats.evictions = 0; this.stats.repacks = 0; this.stats.buildMs = 0; }

    /** Any instanced crowd present. */
    get active(): boolean { return this._blocks.size > 0; }

    /** One shared JS geometry per xfar variant key (every tile's copy of a variant arrives as its own buffer). */
    intern(key: string, g: MeshGeometry): MeshGeometry {
        const h = this._geo.get(key);
        if (h) return h;
        this._geo.set(key, g);
        return g;
    }

    /** World cleared — forget everything (the meshes went with the container). */
    reset(): void { this._blocks.clear(); this._registered = new WeakSet(); this._cancelTasks(() => true); this._bytes = 0; this._groupsSig = ''; this._dirtyGroups.clear(); this.version++; }

    /** A crowd build's group landed: its AUX layer (records) and / or its xfar copies. `layers` = what built it (the
     *  crowd ones are stashed on the group, so a group that comes back — a retired tile, the parked centre — is found
     *  again by the liveness scan). */
    register(group: MeshGroup3D, layers: readonly LayoutPreviewLayer[]): void {
        // (only the ids + records: the AUX footprint geometry has done its job — the contact blobs are built)
        (group as unknown as { _crowdReg?: readonly Partial<LayoutPreviewLayer>[] })._crowdReg = layers.filter(L => L.crowdRecords || L.crowdInst)
            .map(L => (L.crowdRecords ? { crowdRecords: L.crowdRecords } : { crowdInst: L.crowdInst }));
        this._registerGroup(group);
    }
    private _registered = new WeakSet<MeshGroup3D>();
    private _registerGroup(group: MeshGroup3D): void {
        const layers = (group as unknown as { _crowdReg?: readonly Partial<LayoutPreviewLayer>[] })._crowdReg ?? [];
        this._registered.add(group);
        for (const L of layers) {
            const id = L.crowdRecords?.id ?? L.crowdInst?.id;
            if (!id) continue;
            const b = this._block(id);
            b.groups.add(group);
            if (L.crowdRecords && !b.rec) this._adoptRecords(b, L.crowdRecords, group);
        }
        for (const ch of group.children) {
            const a = ch as unknown as ArrayGroup3D & { crowdId?: string; crowdPi?: Int32Array };
            if (!a.crowdId || !a.crowdPi) continue;
            const b = this._block(a.crowdId);
            b.groups.add(group);
            if (b.xfar.includes(a)) continue;
            b.xfar.push(a);
            if (!b.src) b.src = (group.children as unknown as Mesh3D[]).find(m => m.id === a.sourceId) ?? null;
            this._indexCopies(b, a, b.xfar.length - 1);
        }
        this._groupsSig = '';   // liveness re-check
    }
    private _block(id: string): CrowdBlock {
        let b = this._blocks.get(id);
        if (!b) {
            b = { id, rec: null, people: [], group: null, groups: new Set(), xfar: [], pg: new Int32Array(0), pc: new Int32Array(0), shownCopies: new Int32Array(0), src: null, cells: [], cellOf: new Int32Array(0), live: new Uint8Array(0) };
            this._blocks.set(id, b);
        }
        return b;
    }
    private _adoptRecords(b: CrowdBlock, r: CrowdRecords, group: MeshGroup3D): void {
        b.rec = r; b.group = group;
        b.people = crowdPeopleOf(r);
        b.people.forEach((p, i) => this._who.set(p, { b, i }));
        const pg = new Int32Array(r.n).fill(-1), pc = new Int32Array(r.n).fill(-1);
        // copies indexed before the records arrived keep their mapping
        const keepN = Math.min(b.pg.length, r.n);
        if (keepN) { pg.set(b.pg.subarray(0, keepN)); pc.set(b.pc.subarray(0, keepN)); }
        b.pg = pg; b.pc = pc; b.live = new Uint8Array(r.n);
        const byKey = new Map<number, CrowdCell>(), R = r.recs, U = r.u;
        b.cellOf = new Int32Array(r.n);
        for (let i = 0; i < r.n; i++) {
            const o = i * CREC_STRIDE, k = cellKey(R[o + CREC_CX], R[o + CREC_CZ]);
            let c = byKey.get(k);
            if (!c) {
                c = { key: k, people: [], box: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity), wbox: new Float64Array(6),
                    near1: false, near2: false, shown: XFAR, mesh: [null, null], madeAt: [0, 0], usedAt: [0, 0], bytes: [0, 0] };
                byKey.set(k, c); b.cells.push(c);
            }
            b.cellOf[i] = b.cells.indexOf(c);
            c.people.push(i);
            const x = R[o + CREC_X] + R[o + CREC_DX], y = R[o + CREC_Y] + R[o + CREC_DY], z = R[o + CREC_Z] + R[o + CREC_DZ], bx = c.box;
            const m = 0.8 * U, top = 2.3 * U;
            if (x - m < bx[0]) bx[0] = x - m; if (y - 0.1 * U < bx[1]) bx[1] = y - 0.1 * U; if (z - m < bx[2]) bx[2] = z - m;
            if (x + m > bx[3]) bx[3] = x + m; if (y + top > bx[4]) bx[4] = y + top; if (z + m > bx[5]) bx[5] = z + m;
        }
        this._mat[0] = NaN;   // (re)compute the world boxes
    }
    private _indexCopies(b: CrowdBlock, a: ArrayGroup3D & { crowdPi?: Int32Array }, gi: number): void {
        const pi = a.crowdPi!;
        let max = -1;
        for (let j = 0; j < pi.length; j++) if (pi[j] > max) max = pi[j];
        if (b.pg.length <= max) {   // records not here yet: grow the person maps
            const n = Math.max(max + 1, b.rec?.n ?? 0), pg = new Int32Array(n).fill(-1), pc = new Int32Array(n).fill(-1);
            pg.set(b.pg); pc.set(b.pc); b.pg = pg; b.pc = pc;
        }
        for (let j = 0; j < pi.length; j++) if (pi[j] >= 0) { b.pg[pi[j]] = gi; b.pc[pi[j]] = j; }
        const sc = new Int32Array(b.xfar.length); sc.set(b.shownCopies.subarray(0, Math.min(sc.length, b.shownCopies.length)));
        sc[gi] = pi.length; b.shownCopies = sc;
        // the cell states may already hide some of these people (a sibling group landed later)
        for (let j = 0; j < pi.length; j++) { const p = pi[j]; if (p >= 0 && b.rec && p < b.rec.n) this._applyCopy(b, p); }
    }

    /** Tile groups about to RETIRE into the LRU / be disposed: take the lazily built meshes out (rebuilt on demand). */
    onGroupsRemoved(groups: readonly MeshGroup3D[]): void {
        const doomed = new Set(groups);
        for (const b of this._blocks.values()) {
            let hit = false;
            for (const g of b.groups) if (doomed.has(g)) { hit = true; break; }
            if (!hit) continue;
            this._dropBlock(b);
        }
    }
    private _dropBlock(b: CrowdBlock): void {
        for (const c of b.cells) { this._evict(b, c, 0); this._evict(b, c, 1); }
        // every copy visible again (a re-registered block starts from "all xfar")
        for (const a of b.xfar) if (a.instanceOverrides) for (const ov of a.instanceOverrides.values()) if (ov.visible === false) delete ov.visible;
        for (const g of b.groups) this._registered.delete(g);
        this._cancelTasks((T) => T.b === b);
        this._blocks.delete(b.id);
        this.version++;
    }

    /** The live crowd promoted (`on`) / released a person: their xfar copy hides while they are live. */
    setLive(p: CrowdPerson, on: boolean): void {
        const who = this._who.get(p);
        if (!who || !who.b.rec) return;
        who.b.live[who.i] = on ? 1 : 0;
        this._applyCopy(who.b, who.i);
        this._flushRepack();
    }

    /** Per rendered frame (the world LOD callback). Returns true while lazy builds are pending (keep frames coming). */
    update(): boolean {
        if (!this._blocks.size) return false;
        const t0 = now();
        this._frame++;
        this._liveness();
        const root = this.w.cityRoot, cam = this.w.scene3d.getCamera?.();
        if (!root || !cam) return false;
        const r3 = (this.w.scene3d as unknown as { renderer3D?: { distanceLod: boolean; orthoScreenLod: boolean; distanceLodScale: number; lodResolutionScale: number } }).renderer3D;
        const ortho = cam.mode === 'orthographic';
        const lodOn = !!r3 && r3.distanceLod && (!ortho || r3.orthoScreenLod);
        const lodScale = lodOn && r3 ? (ortho ? 1 : fovDistanceScale(cam.fov)) * r3.distanceLodScale * r3.lodResolutionScale : 1;
        const orthoD2 = ortho ? orthoLodDistance(cam.orthoSize) ** 2 : 0;
        const cp = cam.position as unknown as ArrayLike<number>, cx = cp[0], cy = cp[1], cz = cp[2];
        // camera speed → the prefetch lead (step 3)
        {
            const a = this._camAt;
            if (a && t0 > a[3]) { const v = Math.hypot(cx - a[0], cy - a[1], cz - a[2]) / ((t0 - a[3]) / 1000); this._camSpeed = Number.isFinite(v) ? this._camSpeed * 0.7 + Math.min(v, 1e4) * 0.3 : this._camSpeed; }
            this._camAt = [cx, cy, cz, t0];
        }
        let uPerM = 0;
        for (const b of this._blocks.values()) if (b.rec) { uPerM = b.rec.u; break; }
        const lead = Math.min(WorldCrowd.LEAD_S * this._camSpeed, WorldCrowd.LEAD_MAX_M * uPerM);
        const tooFast = WorldCrowd.LEAD_S > 0 && uPerM > 0 && WorldCrowd.SKIP_SPEED_MS > 0 && this._camSpeed / uPerM > WorldCrowd.SKIP_SPEED_MS;   // (part of the speed-aware mode: crowdPrefetchLead)
        const vp = cam.getViewProjectionMatrix() as unknown as ArrayLike<number>;
        const M = root.localMatrix as unknown as ArrayLike<number>;
        let remap = false;
        for (let i = 0; i < 16; i++) if (M[i] !== this._mat[i]) { remap = true; this._mat[i] = M[i]; }
        let want: { b: CrowdBlock; c: CrowdCell; tier: 0 | 1; pri: number } | null = null;
        let anyShownChange = false, visChange = false, structure = false;
        let nNear = 0, nMid = 0, nCells = 0, nCopies = 0, waiting = 0;
        const shown = [0, 0, 0];
        // SIM LOD (sim-lod.ts): no lazy build for a cell wholly past the fog horizon's cull distance (its people are not
        // drawn there); it is built when it comes within the edge (the next-cheaper tier shows meanwhile).
        const simL = (this.w.scene3d as unknown as { simLod?: SimLod }).simLod;
        const fogE = simL && simL.enabled && simL.settings.fogFreeze ? simL.view.fogEdge : Infinity, fogE2 = fogE * fogE;
        const fe = simL?.view.fogEye;
        for (const b of this._blocks.values()) {
            if (!b.rec || !b.src || !b.group) continue;
            const src = b.src, vis = src.visible;
            const D1 = src.lodTwinDist * lodScale, D2 = src.lodTwinDist2 * lodScale;
            for (const c of b.cells) {
                nCells++;
                if (remap) worldBox(M, c.box, c.wbox);
                const wb = c.wbox;
                const d2 = ortho ? orthoD2 : boxD2(cx, cy, cz, wb);
                if (!lodOn) { c.near1 = false; c.near2 = true; }
                else {
                    c.near1 = D1 > 0 ? !distanceLodHidden(d2, D1, !c.near1) : false;
                    c.near2 = D2 > 0 ? !distanceLodHidden(d2, D2, !c.near2) : true;
                }
                const tier = c.near1 ? NEAR : c.near2 ? MID : XFAR;
                // prefetch / evict (perspective: by distance; ortho: the cells in view only — every cell is "at" the zoom)
                const inView = boxInView(vp, wb);
                const fogged = fogE < Infinity && !!fe && boxD2(fe[0], fe[1], fe[2], wb) > fogE2;
                for (let t: 0 | 1 = 0; t <= 1; t = (t + 1) as 0 | 1) {
                    const Dt = t === 0 ? D1 : D2;
                    const preD = Dt * WorldCrowd.PREFETCH[t] + (ortho ? 0 : Math.min(lead, Dt * 2));
                    let pre = vis && Dt > 0 && d2 < preD ** 2 && (!ortho || inView) && (lodOn || t === 1);
                    if (pre && fogged) { pre = false; if (!c.mesh[t]) simL!.fogSkippedCellBuilds++; }
                    if (pre) c.usedAt[t] = this._frame;
                    const m = c.mesh[t];
                    if (m) { if (t === 0) nNear++; else nMid++; }
                    if (m && (!vis || d2 > Math.max(Dt * WorldCrowd.EVICT[t], preD * 1.1) ** 2 || (ortho && !inView && this._frame - c.usedAt[t] > 120))) {
                        if (this._evict(b, c, t)) structure = true;
                    } else if (!m && pre && !this._taskFor(c, t)) {
                        const pri = (inView ? 0 : 4) + (tier === t ? 0 : 1) + (t === 0 ? 0 : 0.5) + Math.sqrt(d2) / Math.max(1e-6, D2 * 4);
                        if (!want || pri < want.pri) want = { b, c, tier: t, pri };
                    }
                }
                // what this cell shows: the wanted tier if resident, else the closest resident one, else xfar
                let s = XFAR;
                if (tier === NEAR) s = this._ready(c, 0) ? NEAR : this._ready(c, 1) ? MID : XFAR;
                else if (tier === MID) s = this._ready(c, 1) ? MID : this._ready(c, 0) ? NEAR : XFAR;
                if (s !== c.shown) { c.shown = s; anyShownChange = true; for (const p of c.people) this._applyCopy(b, p); }
                shown[s]++;
                if (s !== tier && vis) waiting++;   // step 3 diagnostics: a cell showing a cheaper tier while its wanted one builds
                // the meshes' externally driven twin state + visibility (zoom tiers hide the crowd by the source's visible)
                const mn = c.mesh[0], mm = c.mesh[1];
                if (mn) { mn.lodTwinNear = s === NEAR; if (mn.visible !== vis) { mn.visible = vis; visChange = true; } }
                if (mm) { mm.lodTwinNear = false; mm.lodTwinNear2 = s === MID; if (mm.visible !== vis) { mm.visible = vis; visChange = true; } }
            }
            for (let g = 0; g < b.xfar.length; g++) {
                const s2 = b.shownCopies[g] > 0, gsrc = this._srcOf(b, g);
                if (gsrc) { gsrc.lodTwinNear = false; gsrc.lodTwinNear2 = s2; }
                nCopies += b.xfar[g].arrayParams.mode === 'explicit' ? (b.xfar[g].arrayParams as { offsets: unknown[] }).offsets.length : 0;
            }
        }
        // one lazy build step per frame, within the budget (step 3: or up to MAX_IN_FLIGHT cells in the near worker, and
        // one landed worker cell merged into a mesh per frame)
        let pending = false;
        const worker = WorldCrowd.inWorker && nearWorkerAvailable();
        if (tooFast && want) { this.stats.skippedFast++; want = null; }
        if (want && this._tasks.length < (worker ? WorldCrowd.MAX_IN_FLIGHT : 1)) {
            const w2 = want as { b: CrowdBlock; c: CrowdCell; tier: 0 | 1 };
            const T: CrowdBuildTask = { b: w2.b, c: w2.c, tier: w2.tier, builder: null };
            if (worker) {
                T.job = buildCrowdCellAsync(crowdCellJob(w2.b.rec!, w2.c.people, w2.tier));
                T.job.promise.then((r) => { T.result = r; this.w.scene3d.requestRender3D?.(); },
                    () => { T.job = null; if (this._tasks.includes(T)) T.builder = new CrowdCellBuilder(T.b.rec!, T.b.people, T.c.people, T.tier); this.w.scene3d.requestRender3D?.(); });
                this.stats.workerJobs = (this.stats.workerJobs ?? 0) + 1;
            } else T.builder = new CrowdCellBuilder(w2.b.rec!, w2.b.people, w2.c.people, w2.tier);
            this._tasks.push(T);
        }
        if (this._tasks.length) {
            const bt0 = now();
            let finished = false, stepped = false;
            for (const T of [...this._tasks]) {
                if (!this._blocks.has(T.b.id) || T.c.mesh[T.tier]) { this._cancelTasks((x) => x === T); continue; }
                if (T.result) {
                    if (finished) continue;   // one merge + upload per frame
                    this._finish(T, adoptCrowdCell(T.result, T.b.people, T.c.people));
                    this._tasks.splice(this._tasks.indexOf(T), 1);
                    finished = true; structure = true;
                    const fm = now() - bt0; if (fm > this.stats.finishMaxMs) this.stats.finishMaxMs = fm;
                } else if (T.builder) {
                    if (stepped || finished) continue;
                    if (T.builder.done) {   // the merge + mesh + upload get a frame of their own (after the last people)
                        this._finish(T, T.builder.finish());
                        this._tasks.splice(this._tasks.indexOf(T), 1);
                        finished = true; structure = true;
                        const fm = now() - bt0; if (fm > this.stats.finishMaxMs) this.stats.finishMaxMs = fm;
                    } else { T.builder.step(WorldCrowd.BUILD_MS); stepped = true; }
                }
            }
            const ms = now() - bt0;
            this.stats.buildMs += ms; if (ms > this.stats.buildMaxMs) this.stats.buildMaxMs = ms;
            pending = this._tasks.length > 0 || finished;
        }
        if (!pending && want) pending = true;
        this._enforceCap();
        if (anyShownChange) this._flushRepack();
        if (structure) { this.w.scene3d.notifySceneStructureChanged3D?.(); this.version++; }
        if (visChange || structure) this.w.scene3d.notifyVisibilityChanged3D?.();
        if (pending || anyShownChange) this.w.scene3d.requestRender3D?.();
        const st = this.stats;
        st.waiting = waiting; st.waitCellFrames += waiting;
        st.blocks = this._blocks.size; st.cells = nCells; st.near = nNear; st.mid = nMid; st.xfarCopies = nCopies; st.residentBytes = this._bytes; st.shown = shown;
        st.people = 0; st.xfarGroups = 0;
        for (const b of this._blocks.values()) { st.people += b.rec?.n ?? 0; st.xfarGroups += b.xfar.length; }
        st.updateMs = now() - t0; if (st.updateMs > st.updateMaxMs) st.updateMaxMs = st.updateMs;
        return pending;
    }

    private _ready(c: CrowdCell, t: 0 | 1): boolean {
        const m = c.mesh[t];
        return !!m && this._frame > c.madeAt[t] && this.w.scene3d.hasMeshGeometry3D(m);
    }

    private _srcOf(b: CrowdBlock, g: number): Mesh3D | null {
        const a = b.xfar[g] as ArrayGroup3D & { _crowdSrc?: Mesh3D | null };
        if (a._crowdSrc === undefined) {
            let found: Mesh3D | null = null;
            for (const grp of b.groups) { const m = (grp.children as unknown as Mesh3D[]).find(x => x.id === a.sourceId); if (m) { found = m; break; } }
            a._crowdSrc = found;
        }
        return a._crowdSrc ?? null;
    }

    /** A person's xfar copy shows only while their cell shows xfar and they are not live. */
    private _applyCopy(b: CrowdBlock, p: number): void {
        const g = b.pg[p];
        if (g < 0 || !b.rec) return;
        const a = b.xfar[g], j = b.pc[p];
        const c = b.cells[b.cellOf[p]];
        const want = (c ? c.shown === XFAR : true) && !b.live[p];
        const ov = a.instanceOverrides?.get(j);
        if (!ov) return;
        const was = ov.visible !== false;
        if (was === want) return;
        if (want) delete (ov as InstanceOverride).visible; else ov.visible = false;
        b.shownCopies[g] += want ? 1 : -1;
        this._dirtyGroups.add(a);
    }
    private _flushRepack(): void {
        if (!this._dirtyGroups.size) return;
        this.stats.repacks += this.w.scene3d.repackArrayGroups3D(this._dirtyGroups);
        this._dirtyGroups.clear();
        this.w.scene3d.requestRender3D?.();
    }

    private _finish(T: CrowdBuildTask, geo: ReturnType<CrowdCellBuilder['finish']>): void {
        const { b, c, tier } = T;
        if (!b.group || !b.src) return;
        const name = tier === 0 ? 'world:ped-near' : 'world:ped-mid';
        const m = this.w.scene3d.addProceduralMesh3D(b.group, name, geo);
        const src = b.src;
        // the crowd material of this build (style / glow / render style as the xfar source wears it), flat diffuse —
        // _dressCrowdMesh re-derives the crowd style's diffuse + emissive from it exactly like the baked layers'
        const sm = src.material as unknown as Record<string, unknown>, dm = m.material as unknown as Record<string, unknown>;
        for (const k of Object.keys(sm)) { const v = sm[k]; dm[k] = v && typeof v === 'object' && !ArrayBuffer.isView(v) && !Array.isArray(v) ? { ...(v as object) } : Array.isArray(v) ? [...v] : v; }
        delete dm.crowdSlots;
        m.material.crowdPalette = true;
        m.castsInstancedShadow = false;
        m.drawDistance = src.drawDistance; m.drawDistanceBias = src.drawDistanceBias; m.shadowFeatureSize = src.shadowFeatureSize; m.fogClass = src.fogClass;
        m.lodTwinExternal = true; m.lodTwinRole = tier === 0 ? 1 : 3; m.lodTwinNear = false; m.lodTwinNear2 = false;
        m.lodTwinDist = src.lodTwinDist; m.lodTwinDist2 = src.lodTwinDist2;
        m.visible = src.visible;
        this.w._dressCrowdMesh(m);
        m.materialDirty = true;
        const r3 = (this.w.scene3d as unknown as { renderer3D?: { warmGeometry(ms: Mesh3D[], budget?: number): boolean } }).renderer3D;
        r3?.warmGeometry([m]);
        c.mesh[tier] = m; c.madeAt[tier] = this._frame; c.usedAt[tier] = this._frame;
        c.bytes[tier] = geo.vertices.byteLength + geo.indices.byteLength;
        this._bytes += c.bytes[tier];
        this.stats.builds++;
    }
    private _evict(b: CrowdBlock, c: CrowdCell, t: 0 | 1): boolean {
        const m = c.mesh[t];
        if (!m) return false;
        this.w.scene3d.removeProceduralMesh3D(m);
        c.mesh[t] = null;
        this._bytes -= c.bytes[t]; c.bytes[t] = 0;
        // the cell can no longer show that tier
        if ((t === 0 && c.shown === NEAR) || (t === 1 && c.shown === MID)) {
            c.shown = t === 0 && c.mesh[1] ? MID : t === 1 && c.mesh[0] ? NEAR : XFAR;
            if (c.shown === XFAR) for (const p of c.people) this._applyCopy(b, p);
        }
        this.stats.evictions++;
        void b;
        return true;
    }
    private _enforceCap(): void {
        if (this._bytes <= WorldCrowd.MAX_BYTES) return;
        const all: { b: CrowdBlock; c: CrowdCell; t: 0 | 1; at: number }[] = [];
        for (const b of this._blocks.values()) for (const c of b.cells) for (const t of [0, 1] as const) if (c.mesh[t]) all.push({ b, c, t, at: c.usedAt[t] });
        all.sort((x, y) => x.at - y.at);
        let changed = false;
        for (const e of all) { if (this._bytes <= WorldCrowd.MAX_BYTES * 0.85) break; if (e.at >= this._frame) break; if (this._evict(e.b, e.c, e.t)) changed = true; }
        if (changed) { this._flushRepack(); this.w.scene3d.notifySceneStructureChanged3D?.(); this.version++; }
    }

    /** Blocks whose groups all left the scene are dropped (a regen / clear / a tile disposed without the hook). */
    private _liveness(): void {
        const gs = this.w._groups;
        const sig = `${gs.length}|${this.w._meshSetEpoch}`;
        if (sig === this._groupsSig) return;
        this._groupsSig = sig;
        const live = new Set(gs);
        for (const b of [...this._blocks.values()]) {
            let any = false;
            for (const g of b.groups) if (live.has(g)) { any = true; break; }
            if (!any && b.groups.size) this._dropBlock(b);
        }
        // groups that came back (re-attached tiles, the restored centre) carry their crowd stash
        for (const g of gs) if (!this._registered.has(g) && (g as unknown as { _crowdReg?: unknown })._crowdReg) this._registerGroup(g);
    }

    /** Per-build byte breakdown (records + instance slots), for the P12 report. */
    bytes(): { blocks: number; records: number; copies: number; slotBytes: number; residentLazy: number; variants: number; variantBytes: number } {
        let records = 0, copies = 0;
        for (const b of this._blocks.values()) {
            records += b.rec ? b.rec.recs.byteLength : 0;
            for (const a of b.xfar) copies += (a.arrayParams as { offsets?: unknown[] }).offsets?.length ?? 0;
        }
        let variantBytes = 0;
        for (const g of this._geo.values()) variantBytes += g.vertices.byteLength + g.indices.byteLength;
        return { blocks: this._blocks.size, records, copies, slotBytes: copies * 240, residentLazy: this._bytes, variants: this._geo.size, variantBytes };
    }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** City-local box → world AABB under the container matrix `m` (column-major). */
function worldBox(m: ArrayLike<number>, b: Float64Array, out: Float64Array): void {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let ci = 0; ci < 8; ci++) {
        const x = ci & 1 ? b[3] : b[0], y = ci & 2 ? b[4] : b[1], z = ci & 4 ? b[5] : b[2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (wx < x0) x0 = wx; if (wx > x1) x1 = wx; if (wy < y0) y0 = wy; if (wy > y1) y1 = wy; if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
    }
    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = x1; out[4] = y1; out[5] = z1;
}
function boxD2(px: number, py: number, pz: number, b: Float64Array): number {
    const dx = px < b[0] ? b[0] - px : px > b[3] ? px - b[3] : 0;
    const dy = py < b[1] ? b[1] - py : py > b[4] ? py - b[4] : 0;
    const dz = pz < b[2] ? b[2] - pz : pz > b[5] ? pz - b[5] : 0;
    return dx * dx + dy * dy + dz * dz;
}
/** Whether a world box may be in the view (clip-space test of its 8 corners, 15 % margin; conservative). */
function boxInView(vp: ArrayLike<number>, b: Float64Array): boolean {
    let l = 0, r = 0, d = 0, u = 0, n = 0, f = 0;
    for (let ci = 0; ci < 8; ci++) {
        const x = ci & 1 ? b[3] : b[0], y = ci & 2 ? b[4] : b[1], z = ci & 4 ? b[5] : b[2];
        const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
        const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        const wm = Math.abs(cw) * 1.15;
        if (cx < -wm) l++; if (cx > wm) r++; if (cy < -wm) d++; if (cy > wm) u++; if (cw <= 1e-6) n++; if (cz > cw) f++;
    }
    return !(l === 8 || r === 8 || d === 8 || u === 8 || n === 8 || f === 8);
}
