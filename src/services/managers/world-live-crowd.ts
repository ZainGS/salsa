// Round 7 (polish-round-3): the LIVE near-field crowd — the services half of world/crowd-live.ts.
//
// The static crowd is merged per colour (world:ped-* / world:ped-deck-*), so nobody in it can move. This class
// PROMOTES the N people nearest the camera: it lifts their triangles out of the merged (chunked) layers — the index
// sub-range is degenerated IN PLACE and re-sent with Renderer3D.patchMeshIndices (a few KB, no pool rebuild) — and
// draws them with small per-rig-group LIVE meshes built from exactly those triangles (same final vertices, normals,
// names and materials → the swap is invisible), posed every frame by the pose-matched idle channels (evalIdle).
// An envelope ramps the motion in after promotion and out before demotion, so the live pose starts and ends
// EXACTLY on the static pose. Off-screen promotions / demotions skip the ramp (nobody can see the swap).
//
// Lifecycle: the crowd INDEX (every person of every live World Pedestrians group — centre + streamed tiles) is
// rebuilt when that set of groups changes; a promoted person whose source group vanished is dropped (its indices
// restored first — a retired tile can be revived). The scan runs from the world LOD pre-render callback (throttled);
// the pose update from the shared world ticker, which stays alive while anyone is live. Adds / removes are SILENT
// (notifySceneStructureChanged3D: the mesh-list caches re-walk, the host's onSceneGraphChanged — outliner / connector
// re-binding — does NOT fire; the live group sits inside the City thin wrapper).
import type { WorldManager } from './world-manager';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { cityMetresPerUnit } from '../../world/types';
import {
    type CrowdGeometry, type CrowdPerson, type IdleContext,
    rigGroupOf, evalIdle, selectLive, extractPart, degenerateRange, makeIdleContext, buildIdleContext, rigFrames, poseRig,
    RG_COUNT, RG_LOWER, RG_UPPER, RIG_STRIDE, CH_COUNT,
} from '../../world/crowd-live';
import { pointInView } from './world-traffic';
import { newSimSlot, type SimLod, type SimSlot } from '../../world/sim-lod';

/** One person of the index: where their triangles live + their render-space pivots. */
interface CrowdEntry {
    person: CrowdPerson;
    people: CrowdPerson[];
    idx: number;
    /** Every range of this person: source mesh, part, index start + count. `far` = a FAR-twin range (the cheap bake,
     *  pedestrians.ts PED_NEAR_M): hidden while the person is live, never copied — the live meshes are built from the
     *  NEAR (HIGH) twin's triangles. */
    src: { mesh: Mesh3D; part: number; start: number; count: number; far: boolean }[];
    /** Build → render offset (from the first range's reference vertex). */
    ox: number; oy: number; oz: number;
    /** Render-space upper-body pivot (the distance / view test point). */
    px: number; py: number; pz: number;
    group: MeshGroup3D;
    slot: LiveSlot | null;
}

interface LiveSlot {
    e: CrowdEntry;
    live: MeshGroup3D;
    /** Live meshes + their rig group + the static mesh they mirror (visibility / material). */
    parts: { mesh: Mesh3D; rg: number; src: Mesh3D }[];
    hidden: { mesh: Mesh3D; start: number; count: number; backup: Uint32Array }[];
    /** Render-space pivots per rig group (RG_COUNT × 3) and head / arm offsets from the upper pivot (person frame). */
    piv: Float64Array; rel: Float64Array;
    env: number; dir: 1 | -1;
    ctx: IdleContext;
    frame: number;
    /** SIM LOD band schedule (sim-lod.ts). */
    sl?: SimSlot;
}

export interface LiveCrowdOptions {
    /** Max people live at once. */
    count: number;
    /** Promote inside this camera distance (metres); demote past `radiusOut`. */
    radiusIn: number; radiusOut: number;
    /** Envelope ramp (seconds). */
    ramp: number;
}

const DEFAULTS: LiveCrowdOptions = { count: 40, radiusIn: 30, radiusOut: 38, ramp: 1.4 };
/** Max promotions per scan (bounds the promotion hitch; the rest follow on the next scans). */
const MAX_PROMOTE_PER_SCAN = 6;
/** P4.3 frame budget for one scan's promote / drop work (ms). Past it the rest are deferred to a quick follow-up
 *  scan (~2 frames later) instead of landing in the same frame — the scan used to peak at 6-9 ms (up to 37 ms with a
 *  burst of demotions) when a crowd swung into range. At least one promotion always runs per scan. */
const SCAN_BUDGET_MS = 2;
const FOLLOW_UP_MS = 34;

export class WorldLiveCrowd {
    constructor(private readonly w: WorldManager) {}

    enabled = true;
    opts: LiveCrowdOptions = { ...DEFAULTS };
    private _entries: CrowdEntry[] = [];
    private _indexed = new Set<MeshGroup3D>();
    /** P12: the instanced crowd's mesh-set version the index was built for (its lazily built cells come and go). */
    private _crowdVer = -1;
    private _slots: LiveSlot[] = [];
    private _scanAt = 0;
    private _frame = 0;
    // selection scratch (grown with the index; reused every scan)
    private _d2 = new Float32Array(0);
    private _inView = new Uint8Array(0);
    private _isLive = new Uint8Array(0);
    private _want = new Uint8Array(0);
    private _order = new Int32Array(0);
    private _key = new Float32Array(0);
    // per-frame scratch
    private readonly _ch = new Float32Array(CH_COUNT);
    private readonly _v = new Float64Array(3);
    private readonly _rig = new Float64Array(RG_COUNT * RIG_STRIDE);
    private readonly _camL = new Float64Array(3);
    readonly stats = { live: 0, candidates: 0, meshes: 0, updateMs: 0, updateAvgMs: 0, updateMaxMs: 0, scanMs: 0, scanMaxMs: 0, promotions: 0, demotions: 0, indexed: 0 };
    /** Zero the max / counters (console A/B). */
    resetStats(): void { this.stats.updateMaxMs = 0; this.stats.scanMaxMs = 0; this.stats.promotions = 0; this.stats.demotions = 0; }

    /** Anyone live (the ticker must keep running). */
    get active(): boolean { return this._slots.length > 0; }

    setOptions(o: Partial<LiveCrowdOptions> & { on?: boolean }): void {
        if (o.on !== undefined) this.enabled = o.on;
        const { on: _on, ...rest } = o; void _on;
        this.opts = { ...this.opts, ...rest };
        if (this.opts.radiusOut < this.opts.radiusIn) this.opts.radiusOut = this.opts.radiusIn * 1.2;
        if (!this.enabled) this.clearAll(true);
        this._scanAt = 0;
    }

    /** World cleared (the meshes are gone with the container) — forget everything. */
    resetOnClear(): void { this._slots = []; this._entries = []; this._indexed.clear(); }

    /** Demote everyone at once (restoring the static layers) — toggling off / a clear of the live set. */
    clearAll(notify: boolean): void {
        if (!this._slots.length) return;
        for (const s of this._slots) this._drop(s, true);
        this._slots = [];
        this.stats.live = 0; this.stats.meshes = 0;
        if (notify) { this.w.scene3d.notifySceneStructureChanged3D?.(); this.w.scene3d.requestRender3D?.(); }
    }

    // ── Index ────────────────────────────────────────────────────────────────────────────────────────────────────
    private _pedGroups(): MeshGroup3D[] {
        const out: MeshGroup3D[] = [];
        for (const g of this.w._groups) if (/World Pedestrians$/.test(g.name ?? '')) out.push(g);   // centre + streamed tiles ('World Tile x_z World Pedestrians')
        return out;
    }
    /** Rebuild the person index when the set of pedestrian groups changed. */
    private _syncIndex(): void {
        const groups = this._pedGroups();
        let same = groups.length === this._indexed.size && this._crowdVer === this.w._crowd.version;
        if (same) for (const g of groups) if (!this._indexed.has(g)) { same = false; break; }
        if (same) return;
        this._crowdVer = this.w._crowd.version;
        const keep = new Set(groups);
        // drop live people whose source group went away (restore their indices first — a retired tile may come back)
        let changed = false;
        this._slots = this._slots.filter(s => { if (keep.has(s.e.group)) return true; this._drop(s, true); changed = true; return false; });
        if (changed) this.w.scene3d.notifySceneStructureChanged3D?.();
        const bySlot = new Map<CrowdPerson, LiveSlot>();
        for (const s of this._slots) bySlot.set(s.e.person, s);
        const map = new Map<CrowdPerson, CrowdEntry>();
        const entries: CrowdEntry[] = [];
        for (const g of groups) {
            for (const ch of g.children) {
                const m = ch as Mesh3D, geo = m.geometry as CrowdGeometry | undefined, cm = geo?.crowd;
                if (!cm) continue;
                const R = cm.ranges, v = geo!.vertices, ix = geo!.indices;
                for (let r = 0; r < R.length; r += 4) {
                    const person = cm.people[R[r]];
                    let e = map.get(person);
                    if (!e) {
                        const vi = ix[R[r + 2]] * 12, q = (r / 4) * 3;
                        const ox = v[vi] - cm.refs[q], oy = v[vi + 1] - cm.refs[q + 1], oz = v[vi + 2] - cm.refs[q + 2];
                        const pv = person.piv;
                        e = { person, people: cm.people, idx: R[r], src: [], ox, oy, oz, px: pv[0] + ox, py: pv[1] + oy, pz: pv[2] + oz, group: g, slot: null };
                        map.set(person, e); entries.push(e);
                    }
                    e.src.push({ mesh: m, part: R[r + 1], start: R[r + 2], count: R[r + 3], far: m.lodTwinRole !== 0 && m.lodTwinRole !== 1 });   // P9: mid + xfar crowd tiers are hidden copies too
                }
            }
        }
        for (const e of entries) { const s = bySlot.get(e.person); if (s) { e.slot = s; s.e = e; } }
        // P12: a live person's ranges in a freshly built crowd cell are hidden too; ranges of a mesh that left (an evicted
        // cell) need no restore. Live people no longer indexed at all (their cell meshes all evicted) are dropped.
        let restaged = false;
        this._slots = this._slots.filter(s => {
            const e = map.get(s.e.person);
            if (!e) { this._drop(s, false); restaged = true; return false; }
            s.hidden = s.hidden.filter(h => !!h.mesh.parent);
            for (const r of e.src) {
                if (s.hidden.some(h => h.mesh === r.mesh && h.start === r.start)) continue;
                const ix = r.mesh.geometry.indices as Uint32Array;
                s.hidden.push({ mesh: r.mesh, start: r.start, count: r.count, backup: degenerateRange(ix, r.start, r.count) });
                this.w.scene3d.patchMeshIndices3D?.(r.mesh, r.start, r.count);
            }
            return true;
        });
        if (restaged) this.w.scene3d.notifySceneStructureChanged3D?.();
        this._entries = entries;
        this._indexed = keep;
        const n = entries.length;
        if (this._d2.length < n) {
            this._d2 = new Float32Array(n); this._inView = new Uint8Array(n); this._isLive = new Uint8Array(n);
            this._want = new Uint8Array(n); this._order = new Int32Array(n); this._key = new Float32Array(n);
        }
        this.stats.indexed = n;
    }

    // ── Scan (promotion / demotion) ─────────────────────────────────────────────────────────────────────────────
    /** Throttled promotion scan — call once per rendered frame (world LOD callback). */
    scan(): void {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now < this._scanAt) return;
        this._scanAt = now + 180;
        const t0 = now;
        const p = this.w.params, root = this.w.cityRoot;
        if (!this.enabled || !p || !root || !(p.pedestrians ?? true)) { this.clearAll(true); return; }
        const cam = this.w.scene3d.getCamera?.();
        if (!cam) return;
        this._syncIndex();
        const E = this._entries, n = E.length;
        if (!n && !this._slots.length) return;
        const u = 1 / cityMetresPerUnit(p.radius);
        const rIn = this.opts.radiusIn * u, rOut = this.opts.radiusOut * u;
        // camera → city-local (the container may be placed / rotated in an illustration)
        const cm = root.localMatrix as unknown as Float32Array, cp = cam.position as unknown as ArrayLike<number>;
        this._toLocal(cm, cp[0], cp[1], cp[2], this._camL);
        const cx = this._camL[0], cy = this._camL[1], cz = this._camL[2];
        const vp = cam.getViewProjectionMatrix() as unknown as ArrayLike<number>;
        const ortho = cam.mode === 'orthographic';
        const d2 = this._d2, iv = this._inView, lv = this._isLive, want = this._want;
        // SIM LOD (sim-lod.ts): nobody past the fog horizon's cull distance is promoted (they are not drawn) — a fogged
        // live person is demoted like one out of range.
        const lod = this._simLod(), fogE = lod && lod.settings.fogFreeze ? lod.view.fogEdge : Infinity;
        let fx = 0, fy = 0, fz = 0;
        if (fogE < Infinity) { const f = lod!.view.fogEye; this._toLocal(cm, f[0], f[1], f[2], this._v); fx = this._v[0]; fy = this._v[1]; fz = this._v[2]; }
        const fogE2 = fogE * fogE;
        for (let i = 0; i < n; i++) {
            const e = E[i], dx = e.px - cx, dy = e.py - cy, dz = e.pz - cz;
            d2[i] = ortho ? Infinity : dx * dx + dy * dy + dz * dz;
            if (fogE < Infinity) { const gx = e.px - fx, gy = e.py - fy, gz = e.pz - fz; if (gx * gx + gy * gy + gz * gz > fogE2) d2[i] = Infinity; }
            lv[i] = e.slot && e.slot.dir > 0 ? 1 : 0;
            iv[i] = 0;
        }
        // view test only for the near ones (the rest can't be picked anyway)
        const rOut2 = rOut * rOut;
        for (let i = 0; i < n; i++) if (d2[i] < rOut2) { const e = E[i]; this._toWorld(cm, e.px, e.py, e.pz, this._v); iv[i] = pointInView(vp, this._v[0], this._v[1], this._v[2], 1.3) ? 1 : 0; }   // wide margin: a swap just off-screen (a shadow may still show) ramps like an on-screen one
        const liveCount = selectLive(n, d2, iv, lv, rIn, rOut, this.opts.count, want, this._order, this._key);
        let changed = false, promoted = 0, deferred = false;
        const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        // demotions first (frees the budget)
        for (let i = 0; i < n; i++) {
            const s = E[i].slot;
            if (!s || want[i]) continue;
            if (!iv[i] || s.env <= 0) {
                if (changed && clock() - t0 > SCAN_BUDGET_MS) { deferred = true; continue; }   // P4.3: rest next scan
                this._drop(s, true); E[i].slot = null; changed = true; this.stats.demotions++;
            }
            else s.dir = -1;   // ramp out, then swap back (update drops it at env 0)
        }
        for (let i = 0; i < n; i++) {
            if (!want[i]) continue;
            const e = E[i];
            if (e.slot) { e.slot.dir = 1; continue; }
            if (this._slots.length >= this.opts.count + 8) continue;
            if (promoted >= MAX_PROMOTE_PER_SCAN) { deferred = true; continue; }
            if (promoted > 0 && clock() - t0 > SCAN_BUDGET_MS) { deferred = true; continue; }   // P4.3: frame budget
            const s = this._promote(e, root, iv[i] ? 0 : 1);
            if (s) { e.slot = s; promoted++; changed = true; this.stats.promotions++; }
        }
        this._slots = this._slots.filter(s => s.e.slot === s);
        // mirror source visibility (LOD tiers / centre hide) + material (glow / style / weather redress)
        let shown = false;
        for (const s of this._slots) for (const pt of s.parts) {
            const src = pt.src, vis = src.visible && (src.parent as unknown as { visible?: boolean })?.visible !== false;
            if (vis !== pt.mesh.visible) { if (vis) shown = true; pt.mesh.visible = vis; }
            if (syncMaterial(pt.mesh, src)) pt.mesh.materialDirty = true;
        }
        if (changed) this.w.scene3d.notifySceneStructureChanged3D?.();
        if (changed || shown) { this.w.scene3d.notifyVisibilityChanged3D?.(); this.w.scene3d.requestRender3D?.(); }
        if (this._slots.length) this.w._ensureTicker();
        if (deferred) this._scanAt = Math.min(this._scanAt, clock() + FOLLOW_UP_MS);   // finish the backlog soon, a little per frame
        this.stats.live = this._slots.length; this.stats.candidates = liveCount;
        this.stats.meshes = this._slots.reduce((a, s) => a + s.parts.length, 0);
        this.stats.scanMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        if (this.stats.scanMs > this.stats.scanMaxMs) this.stats.scanMaxMs = this.stats.scanMs;
    }

    /** The scene's sim LOD when it is on (absent in the headless unit-test host). */
    private _simLod(): SimLod | null {
        const l = (this.w.scene3d as unknown as { simLod?: SimLod }).simLod;
        return l && l.enabled ? l : null;
    }

    private _toLocal(m: Float32Array, x: number, y: number, z: number, out: Float64Array): void {
        // inverse of a rigid (rotation + translation) matrix: R^T (p − t)
        const tx = x - m[12], ty = y - m[13], tz = z - m[14];
        out[0] = m[0] * tx + m[1] * ty + m[2] * tz;
        out[1] = m[4] * tx + m[5] * ty + m[6] * tz;
        out[2] = m[8] * tx + m[9] * ty + m[10] * tz;
    }
    private _toWorld(m: Float32Array, x: number, y: number, z: number, out: Float64Array): void {
        out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }

    /** Lift one person out of the merged layers into live meshes. */
    private _promote(e: CrowdEntry, root: MeshGroup3D, env0: number): LiveSlot | null {
        const P = e.person, yaw = P.yaw;
        const piv = new Float64Array(RG_COUNT * 3), rel = new Float64Array(RG_COUNT * 3);
        rigFrames(P, e.ox, e.oy, e.oz, piv, rel);
        // (mesh, rig group) → the index ranges to copy
        const byKey = new Map<Mesh3D, number[][]>();
        const hasNear = e.src.some(r => !r.far);
        for (const r of e.src) {
            if (r.far && hasNear) continue;   // the live rig copies the HIGH twin (the far twin is only hidden)
            let a = byKey.get(r.mesh); if (!a) { a = Array.from({ length: RG_COUNT }, () => []); byKey.set(r.mesh, a); }
            a[rigGroupOf(P, r.part)].push(r.start, r.count);
        }
        const layers: { name: string; geometry: CrowdGeometry; color: [number, number, number] }[] = [];
        const meta: { rg: number; src: Mesh3D }[] = [];
        for (const [mesh, groups] of byKey) {
            const d = mesh.material.diffuse;
            for (let rg = 0; rg < RG_COUNT; rg++) {
                const rr = groups[rg]; if (!rr.length) continue;
                layers.push({ name: mesh.name ?? 'world:ped-live', geometry: extractPart(mesh.geometry, rr, piv.subarray(rg * 3, rg * 3 + 3), yaw), color: [d.r, d.g, d.b] });
                meta.push({ rg, src: mesh });
            }
        }
        if (!layers.length) return null;
        const live = this.w.scene3d.addFlatColorMeshGroup('World Live Crowd', layers, true, root);
        const parts: LiveSlot['parts'] = [];
        live.children.forEach((ch, i) => {
            const m = ch as Mesh3D, mt = meta[i];
            m.cheapBounds = true;
            copyMaterial(m, mt.src);
            m.visible = mt.src.visible;
            // Distance LOD + fog horizon (2026-10-01): the live copy takes its source layer's stamp (the live groups are
            // not in WorldManager._groups, so assignDrawDistances never reaches them — they drew at any distance and
            // counted as fog class 0 = building, never fog-culled / faded). Its own small box drives the tests.
            m.drawDistance = mt.src.drawDistance; m.drawDistanceBias = mt.src.drawDistanceBias;
            m.shadowFeatureSize = mt.src.shadowFeatureSize;
            if (m.fogClass !== mt.src.fogClass) { m.fogClass = mt.src.fogClass; m.materialDirty = true; }   // flags2 fade bits
            parts.push({ mesh: m, rg: mt.rg, src: mt.src });
        });
        // hide the static copy (degenerate its triangles in place + a partial index upload)
        const hidden: LiveSlot['hidden'] = [];
        for (const r of e.src) {
            const ix = r.mesh.geometry.indices as Uint32Array;
            hidden.push({ mesh: r.mesh, start: r.start, count: r.count, backup: degenerateRange(ix, r.start, r.count) });
            this.w.scene3d.patchMeshIndices3D?.(r.mesh, r.start, r.count);
        }
        const ctx = makeIdleContext();
        if (P.group >= 0) {
            const members: number[] = [];
            for (let j = Math.max(0, e.idx - 6); j < Math.min(e.people.length, e.idx + 7); j++) if (e.people[j].group === P.group) members.push(j);
            buildIdleContext(e.people, e.idx, members, ctx);
        }
        const slot: LiveSlot = { e, live, parts, hidden, piv, rel, env: env0, dir: 1, ctx, frame: this._slots.length };
        this._slots.push(slot);
        this.w._crowd.setLive(P, true);   // P12: the instanced crowd's xfar copy of this person hides too
        this._pose(slot, this.w._simTime, true);
        return slot;
    }

    /** Remove a slot's live meshes; restore the static triangles when `restore`. */
    private _drop(s: LiveSlot, restore: boolean): void {
        if (restore) for (const h of s.hidden) {
            const ix = h.mesh.geometry.indices as Uint32Array;
            if (ix.length >= h.start + h.count) { ix.set(h.backup, h.start); this.w.scene3d.patchMeshIndices3D?.(h.mesh, h.start, h.count); }
        }
        s.hidden = [];
        this.w.scene3d.removeFlatColorMeshGroup(s.live, true);
        this.w._crowd.setLive(s.e.person, false);
        if (s.e.slot === s) s.e.slot = null;
    }

    // ── Per-frame pose ──────────────────────────────────────────────────────────────────────────────────────────
    /** Advance the envelopes + pose the live meshes (the shared world ticker). */
    update(dt: number): void {
        if (!this._slots.length) return;
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        const t = this.w._simTime, rate = dt / Math.max(0.05, this.opts.ramp);
        const cam = this.w.scene3d.getCamera?.(), root = this.w.cityRoot;
        const vp = cam ? cam.getViewProjectionMatrix() as unknown as ArrayLike<number> : null;
        const cm = root ? root.localMatrix as unknown as Float32Array : null;
        this._frame++;
        let dropped = false, posed = false;
        // SIM LOD (sim-lod.ts): near + on screen every frame, mid ~10 Hz, far / off screen ~2 Hz, fogged never — the
        // idle is a closed form of the clock (evalIdle(t)), so a skipped frame resumes at the right phase.
        const lod = vp && cm ? this._simLod() : null, counter = lod ? lod.counter('liveCrowd') : null;
        counter?.begin();
        const u = lod ? 1 / cityMetresPerUnit(this.w.params?.radius ?? 10) : 1;
        for (let i = 0; i < this._slots.length; i++) {
            const s = this._slots[i];
            s.env += rate * s.dir;
            if (s.env >= 1) s.env = 1;
            if (s.env <= 0) {
                s.env = 0;
                if (s.dir < 0) { this._drop(s, true); dropped = true; this.stats.demotions++; continue; }
            }
            if (lod && cm) {
                const pv = s.piv;
                this._toWorld(cm, pv[RG_UPPER * 3], pv[RG_UPPER * 3 + 1], pv[RG_UPPER * 3 + 2], this._v);
                const sl = s.sl ?? (s.sl = newSimSlot());
                if (!lod.step(counter!, sl, t, (s.frame * 0.618034) % 1, this._v[0], this._v[1], this._v[2], 0.9 * u)) continue;
                this._pose(s, t, false);
                posed = true;
                continue;
            }
            // pose gate: off-screen people re-pose on a slow cadence (staggered)
            if (vp && cm) {
                const pv = s.piv;
                this._toWorld(cm, pv[RG_UPPER * 3], pv[RG_UPPER * 3 + 1], pv[RG_UPPER * 3 + 2], this._v);
                if (!pointInView(vp, this._v[0], this._v[1], this._v[2], 1.35) && ((this._frame + s.frame) & 7) !== 0) continue;
            }
            this._pose(s, t, false);
            posed = true;
        }
        if (dropped) {
            this._slots = this._slots.filter(s => s.e.slot === s);
            this.w.scene3d.notifySceneStructureChanged3D?.();
        }
        if (posed) this.w.scene3d.notifyMeshTransformsChanged3D();
        const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
        this.stats.updateMs = ms; this.stats.updateAvgMs = this.stats.updateAvgMs * 0.95 + ms * 0.05;
        if (ms > this.stats.updateMaxMs) this.stats.updateMaxMs = ms;
        this.stats.live = this._slots.length;
    }

    /** Write one live person's mesh transforms for time `t` (allocation-free). The LOWER body never moves — posed
     *  once (`all`). */
    private _pose(s: LiveSlot, t: number, all: boolean): void {
        const ch = this._ch, R = this._rig, env = s.env * s.env * (3 - 2 * s.env);
        evalIdle(s.e.person, s.ctx, t, env, ch, 0);
        poseRig(s.e.person.yaw, s.piv, s.rel, ch, R, this._v);
        for (let i = 0; i < s.parts.length; i++) {
            const pt = s.parts[i];
            if (pt.rg === RG_LOWER && !all) continue;
            const o = pt.rg * RIG_STRIDE;
            pt.mesh.setPoseXYZYaw(R[o], R[o + 1], R[o + 2], R[o + 3], R[o + 4], R[o + 5]);
        }
    }
}

/** Copy the static mesh's material onto its live twin (new object per colour field — never shared). */
function copyMaterial(dst: Mesh3D, src: Mesh3D): void {
    const d = dst.material as unknown as Record<string, unknown>, s = src.material as unknown as Record<string, unknown>;
    for (const k of Object.keys(s)) {
        const v = s[k];
        d[k] = v && typeof v === 'object' && !ArrayBuffer.isView(v) && !Array.isArray(v) ? { ...(v as object) } : Array.isArray(v) ? [...v] : v;
    }
    dst.materialDirty = true;
}
/** Re-copy when the static mesh's material moved on (day/night glow, render style, weather). True when changed. */
function syncMaterial(dst: Mesh3D, src: Mesh3D): boolean {
    const d = dst.material as unknown as Record<string, unknown>, s = src.material as unknown as Record<string, unknown>;
    for (const k in s) {
        const a = s[k], b = d[k];
        if (a === b) continue;
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
            let eq = true;
            for (const kk in ao) if (ao[kk] !== bo[kk]) { eq = false; break; }
            if (eq) continue;
        }
        copyMaterial(dst, src);
        return true;
    }
    return false;
}

