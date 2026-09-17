// Audit C3 (2026-09-13): the TRAFFIC SIM (movers + car-yield + walker chats + door visits), extracted
// VERBATIM from WorldManager. The shared animation TICKER and the centre-visibility mover gate stay on
// the manager (they coordinate traffic + day-cycle + weather + turntable); this class owns the mover
// state and the per-frame routing/animation. `w` is the manager (wide host, C1 stance).
import type { WorldManager } from './world-manager';
import type { Scene3DManager } from './scene3d-manager';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { generateCityLayout, tiledWorldExtent, buildLayoutPreview, buildBiome, buildStreets, buildRoadPaint, buildVoidGrid, buildBorderGlow, buildApron, buildTrafficLights, buildSignage, buildAwnings, buildFurniture, buildRailway, buildSkyway, buildSky, buildPedestrians, buildLandmarks, buildShotengai, buildWater, buildTerraces, makeElevation, makeHeightField, applyHeightField, regionAt, computeTraffic, computeTextSigns, computeSignalTextSigns, buildRoadSigns, cellLevelAt, hash2, makeDomainWarpInto, applyDomainWarp, cityStyle, CITY_STYLE_NAMES, Accum3D, LANDMARK_LABEL, LANDMARK_H, pointInPolygon } from '../../world';
import type { LayoutParams, WorldGraph, RegionSeed, LayoutPreviewLayer, MoverSpec, Landmark } from '../../world';
import { drawLandmarkCard, drawLandmarkPill, CARD3D_RADIUS_PX } from '../../world/landmark-card';
import { computeDayNight, DEFAULT_SKY, type TimeGradePhase, type SkyKey } from '../../world/day-night';
import { buildTileLayerGroups } from '../../world/tile-build';
import type { TileLayerGroup } from '../../world/tile-build';
import { DRESSING_ORDER, FULL_BUILD_ORDER } from '../../world/build-order';
import type { RenderStyle } from '../../renderer/3d/material-3d';
import type { PostProcessConfig } from '../../renderer/3d/post-process-pass';
import { TileWorkerPool } from '../streaming/tile-worker-pool';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import { debugLog } from '../debug-log';

/** Dev logging (mirrors world-manager's WORLD_VERBOSE — kept local to avoid a value-import cycle). */
const WORLD_VERBOSE = false;

/** One live traffic mover (a spawned MoverSpec + its meshes + route state). */
export interface MoverRec {
    spec: MoverSpec; meshes: Mesh3D[]; len: number; t: number; dir: 1 | -1;
    pausedUntil: number; cooldownUntil: number; emote: Mesh3D | null;
    path: { pts: [number, number][]; cum: number[]; total: number } | null;
    vel: number;            // current speed (eased toward the target each frame → real accel/decel, no snap)
    yaw: number | null;     // current heading (eased toward the route heading → smooth turns)
    scale: number;          // current visual scale (cars fade in/out at their run ends instead of teleport-popping)
    /** In a door visit (walking to a door / inside a building) — excluded from routing, chat and car-yield. */
    visiting: boolean;
    /** ARTICULATED CONSIST (trains): one entry per car — its own meshes + signed longitudinal offset (world units
     *  from the consist centre). Each car is placed at its own arc-length so the train bends around curves. When
     *  set, the ticker drives these instead of the single shared transform on `meshes`. */
    segments?: { meshes: Mesh3D[]; offset: number }[];
}
/** A building front door (stamped by streets' addEntrance) the visit sim can use. */
export interface DoorSpot { x: number; z: number; lift: number; ox: number; oz: number; yaw: number; wx: number; wz: number }
/** A pedestrian's DOOR VISIT: walk to the door → it swings open → step in (despawn) → later come back out. */
export interface DoorVisit { mv: MoverRec; door: DoorSpot; start: number; dur: number; leaf: Mesh3D }

export class WorldTraffic {
    constructor(private readonly w: WorldManager) {}

    /** Whether the traffic sim is running (persists across regens → respawn). */
    on = false;
    movers: MoverRec[] = [];
    private _visits: DoorVisit[] = [];
    private _doorSpots: DoorSpot[] = [];
    private _doorLeaves: Mesh3D[] = [];
    private _chatTimer = 0;    // encounter scan throttle
    private _poseBuf = new Float32Array(0);   // reused mover pose scratch (x, z, hx, hz per mover — no per-frame allocs)

    /** Drop all mover/visit/door state on a world clear (the meshes' groups are removed by the caller). */
    resetOnClear(): void {
        this.movers = [];
        this._visits = [];
        this._doorSpots = [];
        this._doorLeaves = [];
    }

    start(): void {
        this.on = true;
        this.spawn();
        if (this.w._timeOfDay != null) this.w._applyTimeOfDay();   // dress the fresh movers (headlights/pools) for the current time
        this.w._ensureTicker();
    }
    /** Stop and remove the movers (the static parked train returns on the next regen). */
    stop(): void {
        this.on = false;
        this.despawn();
    }

    spawn(): void {
        if (!this.w._graph || this.movers.length) return;
        this.w._sceneEpoch++;   // movers/doors push into _groups below → LOD must re-hide walkers/birds when zoomed out
        for (const child of this.w._allWorldMeshes()) if (/rail-train/.test(child.name ?? '')) child.visible = false;   // hide the parked train
        for (const spec of computeTraffic(this.w._graph)) {
            // ARTICULATED CONSIST: `spec.layers` is ONE car; clone it `count` times so each car gets its own meshes
            // (they share the car geometry → still cheap). Otherwise a single mesh set for the whole mover.
            const meshes: Mesh3D[] = [];
            let segments: { meshes: Mesh3D[]; offset: number }[] | undefined;
            if (spec.cars && spec.cars.count > 1) {
                segments = [];
                const n = spec.cars.count;
                for (let c = 0; c < n; c++) {
                    const g = this.w.scene3d.addFlatColorMeshGroup('World Traffic', spec.layers, false, this.w._ensureCityContainer());
                    this.w._groups.push(g);
                    const cm = g.children as unknown as Mesh3D[];
                    for (const m of cm) { m.cheapBounds = true; meshes.push(m); }
                    segments.push({ meshes: cm, offset: (c - (n - 1) / 2) * spec.cars.spacing });   // signed distance from the consist centre
                }
            } else {
                const g = this.w.scene3d.addFlatColorMeshGroup('World Traffic', spec.layers, false, this.w._ensureCityContainer());
                this.w._groups.push(g);
                for (const m of (g.children as unknown as Mesh3D[])) { m.cheapBounds = true; meshes.push(m); }   // movers transform EVERY FRAME → skip the per-frame O(verts) AABB re-scan
            }
            const emote = meshes.find(m => (m.name ?? '') === 'world:traffic-emote') ?? null;
            if (emote) emote.visible = false;   // shown only while two walkers stop for a chat
            // Polyline routes (the sky-train): precompute cumulative segment lengths so t maps to arc length.
            let path: { pts: [number, number][]; cum: number[]; total: number } | null = null;
            if (spec.path && spec.path.length >= 2) {
                const cum = [0];
                for (let i = 1; i < spec.path.length; i++) cum.push(cum[i - 1] + Math.hypot(spec.path[i][0] - spec.path[i - 1][0], spec.path[i][1] - spec.path[i - 1][1]));
                path = { pts: spec.path as [number, number][], cum, total: Math.max(1e-6, cum[cum.length - 1]) };
            }
            const len = path ? path.total : Math.hypot(spec.b[0] - spec.a[0], spec.b[1] - spec.a[1]) || 1;
            this.movers.push({ spec, meshes, len, t: spec.t0, dir: 1, pausedUntil: 0, cooldownUntil: 0, emote, path, visiting: false, vel: 0, yaw: null, scale: 1, segments });
        }
        // DOOR VISITS: collect the stamped front doors + create the two reusable animated door LEAVES
        // (hinge at the mesh origin — rotationY swings them open; hidden until a visit needs one).
        const gp = this.w._graph.params, ws = gp.radius / 10;
        this._doorSpots = [];
        for (const lot of this.w._graph.lots) {
            if (!lot.door || !lot.doorOut) continue;
            const e: [number, number] = [-lot.doorOut[1], lot.doorOut[0]];   // door frontage direction
            this.w._warpInto(lot.door[0], lot.door[1], this.w._warpScratch);
            this._doorSpots.push({
                x: lot.door[0], z: lot.door[1], lift: this.w._heightFn(lot.center[0], lot.center[1]),
                ox: lot.doorOut[0], oz: lot.doorOut[1], yaw: Math.atan2(-e[1], e[0]),
                wx: lot.door[0] + this.w._warpScratch[0], wz: lot.door[1] + this.w._warpScratch[1],
            });
        }
        this._visits = [];
        if (this._doorSpots.length) {
            const leafGeo = (): ReturnType<Accum3D['geometry']> => {
                const a = new Accum3D();
                a.obox([0.013 * ws, 0.033 * ws, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.013 * ws, 0.033 * ws, 0.0025 * ws);
                return a.geometry();
            };
            const lg = this.w.scene3d.addFlatColorMeshGroup('World Visit Doors', [
                { name: 'world:visit-door-0', color: [0.32, 0.22, 0.14], geometry: leafGeo() },
                { name: 'world:visit-door-1', color: [0.32, 0.22, 0.14], geometry: leafGeo() },
            ], false, this.w._ensureCityContainer());
            this.w._groups.push(lg);
            this._doorLeaves = lg.children as unknown as Mesh3D[];
            for (const l of this._doorLeaves) { l.visible = false; l.cheapBounds = true; }
        }
        // eslint-disable-next-line no-console
        if (WORLD_VERBOSE) console.log('[world] traffic started:', this.movers.length, 'movers');
        this.w._lastGlowNight = -1;   // fresh mover meshes (headlights etc.) must be dressed by the next glow pass
        if (this.w._renderStyle) this.w._applyRenderStyle();
        this.tick(0);   // place everyone before the first frame
    }
    despawn(): void {
        for (const mv of this.movers) {
            const g = (mv.meshes[0] as unknown as { parent?: MeshGroup3D })?.parent;
            if (g) { this.w.scene3d.removeFlatColorMeshGroup(g); const i = this.w._groups.indexOf(g); if (i >= 0) this.w._groups.splice(i, 1); }
        }
        this.movers = [];
        this._visits = [];
        // Remove the reusable door-LEAVES group too (not just hide it) — _spawnTraffic creates a fresh one every
        // time, so hiding-only orphaned a 2-mesh group into _groups + the scene graph on EVERY traffic respawn
        // (weather / railway / clouds / traffic toggles), growing getAllMeshes() and the pool without bound.
        const lg = (this._doorLeaves[0] as unknown as { parent?: MeshGroup3D })?.parent;
        if (lg) { this.w.scene3d.removeFlatColorMeshGroup(lg); const i = this.w._groups.indexOf(lg); if (i >= 0) this.w._groups.splice(i, 1); }
        this._doorLeaves = [];
        for (const child of this.w._allWorldMeshes()) if (/rail-train/.test(child.name ?? '')) child.visible = true;
    }

    tick(dt: number): void {
        const graph = this.w._graph;
        if (!graph) return;
        // NOTE: _simTime is advanced by the shared ticker (not here) — this also runs once at spawn with dt=0.
        const p = graph.params, s = p.radius / 10, R = p.radius;
        const cw = 2 * R / Math.max(2, p.gridCols | 0), ch = 2 * R / Math.max(2, p.gridRows | 0);

        // Current positions + headings (for the car-yield scan and chat encounters) — packed into ONE reused
        // Float32Array (stride 4: x, z, hx, hz) instead of ~220 fresh objects per frame (GC pressure).
        if (this._poseBuf.length < this.movers.length * 4) this._poseBuf = new Float32Array(this.movers.length * 4);
        const pose = this._poseBuf;
        for (let i = 0; i < this.movers.length; i++) {
            const mv = this.movers[i], sp = mv.spec;
            const dx = (sp.b[0] - sp.a[0]) / mv.len, dz = (sp.b[1] - sp.a[1]) / mv.len;
            const o = i * 4;
            pose[o] = sp.a[0] + (sp.b[0] - sp.a[0]) * mv.t - dz * sp.lane;
            pose[o + 1] = sp.a[1] + (sp.b[1] - sp.a[1]) * mv.t + dx * sp.lane;
            pose[o + 2] = dx * mv.dir;
            pose[o + 3] = dz * mv.dir;
        }

        // CHAT ENCOUNTERS (every 0.5 s): two nearby walkers may stop for a talk — emote bubbles pop up over both.
        // ~20% chance per near-pair per 10 s window (hash-keyed → no RNG state), then an 18 s cooldown.
        this._chatTimer += dt;
        if (this._chatTimer >= 0.5) {
            this._chatTimer = 0;
            const win = Math.floor(this.w._simTime / 10);
            // DOOR VISITS: a walker passing a stamped front door may head in (~12%/10 s window; ≤2 at once).
            if (this._doorSpots.length && this._visits.length < Math.min(2, this._doorLeaves.length)) {
                for (let i = 0; i < this.movers.length && this._visits.length < 2; i++) {
                    const a = this.movers[i];
                    if (a.spec.kind !== 'walker' || a.visiting || this.w._simTime < a.cooldownUntil || this.w._simTime < a.pausedUntil) continue;
                    if (hash2(i * 7.7, win, (p.seed ^ 0x0d00) >>> 0) > 0.12) continue;
                    let best: DoorSpot | null = null, bestD = (0.09 * s) * (0.09 * s);
                    for (const dr of this._doorSpots) {
                        const ddx = dr.x - pose[i * 4], ddz = dr.z - pose[i * 4 + 1];
                        const d2 = ddx * ddx + ddz * ddz;
                        if (d2 < bestD) { bestD = d2; best = dr; }
                    }
                    if (!best) continue;
                    const leaf = this._doorLeaves.find(l => !this._visits.some(v => v.leaf === l));
                    if (!leaf) break;
                    a.visiting = true;
                    this._visits.push({ mv: a, door: best, start: this.w._simTime, dur: 5 + hash2(i * 3.1, win, (p.seed ^ 0x77d3) >>> 0) * 7, leaf });
                }
            }
            for (let i = 0; i < this.movers.length; i++) {
                const a = this.movers[i];
                if (a.spec.kind !== 'walker' || a.visiting || this.w._simTime < a.cooldownUntil) continue;
                for (let j = i + 1; j < this.movers.length; j++) {
                    const b = this.movers[j];
                    if (b.spec.kind !== 'walker' || b.visiting || this.w._simTime < b.cooldownUntil) continue;
                    const dxp = pose[i * 4] - pose[j * 4], dzp = pose[i * 4 + 1] - pose[j * 4 + 1];
                    if (dxp * dxp + dzp * dzp > (0.05 * s) * (0.05 * s)) continue;
                    if (hash2(i * 31.7 + j * 13.3, win, (p.seed ^ 0xc4a7) >>> 0) > 0.2) continue;
                    a.pausedUntil = b.pausedUntil = this.w._simTime + 3.5;      // stop and talk
                    a.cooldownUntil = b.cooldownUntil = this.w._simTime + 18;
                    if (a.emote) a.emote.visible = true;
                    if (b.emote) b.emote.visible = true;
                    break;
                }
            }
        }

        // Advance active DOOR VISITS (leaf swings + walker transit/despawn) — visiting movers skip normal routing.
        for (let vi = this._visits.length - 1; vi >= 0; vi--) {
            if (this._tickVisit(this._visits[vi], s)) this._visits.splice(vi, 1);
        }

        for (let i = 0; i < this.movers.length; i++) {
            const mv = this.movers[i], sp = mv.spec;
            if (mv.visiting) continue;   // door-visit sim owns this walker's meshes right now
            if (mv.emote && mv.emote.visible && this.w._simTime >= mv.pausedUntil) mv.emote.visible = false;   // chat over
            let speed = this.w._simTime < mv.pausedUntil ? 0 : sp.speed;

            // CAR AI: brake for a car ahead in the same lane, or any pedestrian ahead on/near the roadway.
            if (speed > 0 && sp.kind === 'car') {
                const mex = pose[i * 4], mez = pose[i * 4 + 1], mehx = pose[i * 4 + 2], mehz = pose[i * 4 + 3];
                for (let j = 0; j < this.movers.length; j++) {
                    if (j === i) continue;
                    const ot = this.movers[j].spec.kind;
                    if (ot !== 'car' && ot !== 'walker') continue;
                    const dxp = pose[j * 4] - mex, dzp = pose[j * 4 + 1] - mez;
                    const ahead = dxp * mehx + dzp * mehz;                    // along my heading
                    // JUNCTION / OVERLAP guard: another vehicle beside-or-ahead within collision radius (any
                    // heading — crossing streets meet at junctions) → the LOWER-index car has priority, the
                    // higher one stops. Deterministic tie-break, so crossing pairs can't deadlock, and any
                    // residual overlap resolves itself (one drives clear while the other waits).
                    if (this.movers[j].visiting) continue;   // walkers inside a building can't block traffic
                    if (ot === 'car' && ahead > -0.02 * s && j < i
                        && dxp * dxp + dzp * dzp < (0.085 * s) * (0.085 * s)) { speed = 0; break; }
                    if (ahead <= 0.02 * s) continue;
                    const lateral = Math.abs(dxp * -mehz + dzp * mehx);
                    if (ot === 'car' && ahead < 0.16 * s && lateral < 0.06 * s) { speed = 0; break; }               // car-following gap
                    // Yield to a pedestrian CROSSING our path — but NOT one strolling ALONG the road beside us
                    // (parallel), or the car would crawl behind a same-direction walker forever (the "peds block a
                    // car for a long time" bug). Compare the walker's heading to ours: parallel → ignore.
                    if (ot === 'walker' && ahead < 0.14 * s && lateral < p.streetWidth * 0.35) {
                        const wj = this.movers[j], wa = wj.spec.a, wb = wj.spec.b;
                        const wl = Math.hypot(wb[0] - wa[0], wb[1] - wa[1]) || 1;
                        const whx = (wb[0] - wa[0]) / wl * wj.dir, whz = (wb[1] - wa[1]) / wl * wj.dir;
                        if (Math.abs(whx * mehx + whz * mehz) < 0.6) { speed = 0; break; }   // crossing (not parallel) → yield
                    }
                }
            }

            // BUS STOPS: route-t positions where the bus pulls up for a moment (then a cooldown so it doesn't
            // re-trigger while still inside the stop window).
            if (sp.stops && speed > 0 && this.w._simTime >= mv.cooldownUntil) {
                for (const st of sp.stops) {
                    if (Math.abs(mv.t - st) < 0.01) { mv.pausedUntil = this.w._simTime + 2.2; mv.cooldownUntil = this.w._simTime + 9; speed = 0; break; }
                }
            }

            // ACCELERATE / DECELERATE: ease the actual velocity toward the target (0 when braking or paused, else
            // sp.speed) instead of snapping — cars pull away smoothly and brake in, not teleport between stop and go.
            // Cars brake harder than they accelerate; non-ground movers (train/clouds/fall) keep their direct speed.
            if (sp.kind === 'car' || sp.kind === 'walker') {
                const accel = sp.speed * 1.6 * dt, decel = sp.speed * 3.2 * dt;
                mv.vel = speed > mv.vel ? Math.min(speed, mv.vel + accel) : Math.max(speed, mv.vel - decel);
            } else mv.vel = speed;
            // Advance along the route — shuttles (train / shotengai strollers) reverse at their end margins.
            const step = (sp.kind === 'rain' ? 0 : (mv.vel * dt) / mv.len);   // fall clusters don't travel their route
            if (sp.pingPong) {
                const lo = sp.margin ?? 0, hi = 1 - (sp.margin ?? 0);
                mv.t += step * mv.dir;
                if (mv.t >= hi) { mv.t = hi; mv.dir = -1; }
                else if (mv.t <= lo) { mv.t = lo; mv.dir = 1; }
            } else {
                mv.t = (mv.t + step) % 1;
            }

            // ARTICULATED CONSIST (trains): place each car at its OWN arc-length (offset from the consist centre)
            // with the LOCAL track heading there, so the train bends around a curve. Rigid in Y (the deck/skyway
            // altitude is baked into the car geometry) and never warped (the viaduct is noWarp — they stay glued).
            if (mv.segments) {
                for (const seg of mv.segments) {
                    const tk = Math.max(0, Math.min(1, mv.t + seg.offset / mv.len));
                    const P = this._moverPosAt(mv, tk);
                    for (const m of seg.meshes) {
                        m.x = P.px; m.y = sp.baseY; m.z = P.pz;
                        if (P.yaw != null) m.rotationY = P.yaw;
                        m.updateLocalMatrix();
                    }
                }
                continue;
            }

            let px: number, pz: number, yaw: number | null = null;
            if (mv.path) {
                // POLYLINE route (the sky-train): t → arc length → segment; the meshes YAW to the segment heading
                // (geometry is built along +X; gl-matrix rotateY maps +X to (cosθ, -sinθ) → θ = atan2(-dz, dx)).
                const pd = mv.path, d = mv.t * pd.total;
                let si = 0; while (si < pd.cum.length - 2 && pd.cum[si + 1] < d) si++;
                const segLen = Math.max(1e-6, pd.cum[si + 1] - pd.cum[si]), lt = (d - pd.cum[si]) / segLen;
                const ax = pd.pts[si][0], az = pd.pts[si][1], bx = pd.pts[si + 1][0], bz = pd.pts[si + 1][1];
                const sdx = (bx - ax) / segLen, sdz = (bz - az) / segLen;
                px = ax + (bx - ax) * lt - sdz * sp.lane;
                pz = az + (bz - az) * lt + sdx * sp.lane;
                yaw = Math.atan2(-sdz * mv.dir, sdx * mv.dir);
            } else {
                const dx = (sp.b[0] - sp.a[0]) / mv.len, dz = (sp.b[1] - sp.a[1]) / mv.len;
                px = sp.a[0] + (sp.b[0] - sp.a[0]) * mv.t - dz * sp.lane;   // lane = offset LEFT of travel
                pz = sp.a[1] + (sp.b[1] - sp.a[1]) * mv.t + dx * sp.lane;
                // Archetype movers build along +X and yaw to their route (shared geometry → batched draws).
                if (sp.faceRoute) yaw = Math.atan2(-dz * mv.dir, dx * mv.dir);
            }

            // Height: clouds keep their altitude; trains keep their deck/skyway; FALL movers (rain/snow/petals)
            // cycle downward and wrap (speed = fall rate, sway = lateral flutter); boats ride the canal water;
            // ground movers ride the terrain — and over a sunken canal cell they ARC OVER THE BRIDGE.
            let y = 0;
            if (sp.kind === 'holo') {
                y = Math.sin(this.w._simTime * 1.4 + sp.t0 * 6.283) * 0.05 * s;   // lazy vertical swim bob (fish, soaring birds)
            } else if (sp.kind === 'rain') {
                const range = sp.fallRange ?? 1.7 * s;   // fall from cloud height, wrap back to the top
                y = range - ((this.w._simTime * sp.speed + sp.t0 * range) % range) - 0.32 * range;
                if (sp.sway) { const sw = Math.sin(this.w._simTime * 0.9 + sp.t0 * 6.283) * sp.sway; px += sw; pz += sw * 0.6; }
            } else if (sp.kind === 'boat') {
                y = this.w._smoothFn(px, pz) + Math.sin(this.w._simTime * 0.8 + sp.t0 * 6.283) * 0.003 * s;   // water line + gentle bob
            } else if (sp.kind !== 'cloud' && sp.kind !== 'train') {
                if (cellLevelAt(graph, px, pz) < 0) {
                    const sm = this.w._smoothFn(px, pz);
                    const horiz = Math.abs(sp.b[0] - sp.a[0]) >= Math.abs(sp.b[1] - sp.a[1]);
                    const span = horiz ? cw : ch;
                    const cellT = horiz ? (((px + R) % cw) + cw) % cw / cw : (((pz + R) % ch) + ch) % ch / ch;
                    const rise = Math.min(0.045 * s, span * 0.5 * 0.18);
                    y = sm + 0.012 * s + rise * (1 - (2 * cellT - 1) * (2 * cellT - 1));
                } else {
                    y = this.w._heightFn(px, pz);
                }
                // WALKER GAIT: a small step-bounce while moving (pedestrians stop gliding like chess pieces).
                if (sp.kind === 'walker' && speed > 0) y += Math.abs(Math.sin(this.w._simTime * (8 + (sp.speed / s) * 25) + sp.t0 * 6.283)) * 0.004 * s;
            }
            // Domain warp LAST — heights + all layout logic sampled unwarped, then the position curves with the roads.
            // (Sky elements — clouds/rain sheets — stay unwarped; the warp is a ground-plane illusion.)
            // Allocation-free: write into the reused scratch, not a fresh tuple (this runs per mover per frame).
            let wx = 0, wz = 0;
            if (sp.kind !== 'cloud' && sp.kind !== 'rain' && sp.kind !== 'train') { this.w._warpInto(px, pz, this.w._warpScratch); wx = this.w._warpScratch[0]; wz = this.w._warpScratch[1]; }
            // SMOOTH TURN: ease the heading toward the route heading (snaps read as an instant spin at a corner /
            // path segment). Wrapped to the shortest arc so it never spins the long way round.
            if (yaw != null) {
                if (mv.yaw == null) mv.yaw = yaw;
                else { let d = yaw - mv.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; mv.yaw += d * Math.min(1, dt * 8); }
            }
            // FADE at the run ends: a looping car teleport-pops from its run's end back to its start. Scale it to
            // ~0 across the last/first few % of the route so it shrinks away and grows back in instead of jumping.
            if (sp.kind === 'car' && !sp.pingPong) {
                const W = 0.04;
                mv.scale = Math.max(0.001, Math.min(1, mv.t / W) * Math.min(1, (1 - mv.t) / W));
            }
            const appliedYaw = mv.yaw ?? yaw;
            for (const m of mv.meshes) {
                m.x = px + wx; m.y = sp.baseY + y; m.z = pz + wz;
                if (appliedYaw != null) m.rotationY = appliedYaw;
                if (sp.kind === 'car') m.setScale3D(mv.scale, mv.scale, mv.scale);
                m.updateLocalMatrix();   // bare x/y/z writes don't rebuild the 3D matrix — this bumps the matrix version
            }
        }
        // Repack instance matrices + draw this frame (otherwise movers only "jump" when an interaction forces it).
        this.w.scene3d.notifyMeshTransformsChanged3D();
    }

    /** Raw layout-space position + heading of a mover at normalized route param `t` — the shared math for the
     *  single-transform ticker and the articulated-train (per-car) placement. `yaw` maps the +X-built geometry to
     *  the route heading (gl-matrix rotateY sends +X to (cosθ, -sinθ), so θ = atan2(-dz, dx)); direction-signed. */
    private _moverPosAt(mv: MoverRec, t: number): { px: number; pz: number; yaw: number } {
        const sp = mv.spec;
        if (mv.path) {
            const pd = mv.path, d = t * pd.total;
            let si = 0; while (si < pd.cum.length - 2 && pd.cum[si + 1] < d) si++;
            const segLen = Math.max(1e-6, pd.cum[si + 1] - pd.cum[si]), lt = (d - pd.cum[si]) / segLen;
            const ax = pd.pts[si][0], az = pd.pts[si][1], bx = pd.pts[si + 1][0], bz = pd.pts[si + 1][1];
            const sdx = (bx - ax) / segLen, sdz = (bz - az) / segLen;
            return { px: ax + (bx - ax) * lt - sdz * sp.lane, pz: az + (bz - az) * lt + sdx * sp.lane, yaw: Math.atan2(-sdz * mv.dir, sdx * mv.dir) };
        }
        const dx = (sp.b[0] - sp.a[0]) / mv.len, dz = (sp.b[1] - sp.a[1]) / mv.len;
        return { px: sp.a[0] + (sp.b[0] - sp.a[0]) * t - dz * sp.lane, pz: sp.a[1] + (sp.b[1] - sp.a[1]) * t + dx * sp.lane, yaw: Math.atan2(-dz * mv.dir, dx * mv.dir) };
    }

    /** Advance one DOOR VISIT. Timeline (t since start): 0–0.5 the leaf swings open while the walker heads
     *  for the door (0–0.9) · 0.9 the walker steps INSIDE (meshes hidden) · 0.9–1.4 the leaf swings shut and
     *  hides (the painted door reads as closed) · `dur` seconds inside · then the mirror: open, reappear,
     *  walk back to the route, close. Returns true when the visit is finished. */
    private _tickVisit(v: DoorVisit, s: number): boolean {
        const mv = v.mv, sp = mv.spec, t = this.w._simTime - v.start;
        const IN_END = 0.9, SHUT = 1.4, D0 = SHUT + v.dur, END = D0 + 1.6;
        const door = v.door, gy = sp.baseY;

        // Walker route anchor (t frozen while visiting) + the doorstep target (both unwarped).
        const dx = (sp.b[0] - sp.a[0]) / mv.len, dz = (sp.b[1] - sp.a[1]) / mv.len;
        const rx = sp.a[0] + (sp.b[0] - sp.a[0]) * mv.t - dz * sp.lane;
        const rz = sp.a[1] + (sp.b[1] - sp.a[1]) * mv.t + dx * sp.lane;
        const tx = door.x + door.ox * 0.012 * s, tz = door.z + door.oz * 0.012 * s;

        // Leaf: swing angle + visibility per phase.
        let swing = 0, leafOn = false, walkerOn = true, k = 0;
        if (t < SHUT) {                                   // heading in
            leafOn = true;
            swing = t < 0.5 ? t / 0.5 : t < IN_END ? 1 : Math.max(0, 1 - (t - IN_END) / 0.5);
            k = Math.min(1, t / (IN_END - 0.05));
            walkerOn = t < IN_END;
        } else if (t < D0) {                              // inside
            walkerOn = false;
        } else if (t < END) {                             // coming back out
            leafOn = true;
            const te = t - D0;
            swing = te < 0.5 ? te / 0.5 : te < 1.1 ? 1 : Math.max(0, 1 - (te - 1.1) / 0.5);
            walkerOn = te >= 0.3;
            k = walkerOn ? Math.max(0, 1 - (te - 0.3) / 0.8) : 1;
        } else {                                          // done
            mv.visiting = false;
            mv.cooldownUntil = this.w._simTime + 30;
            v.leaf.visible = false;
            for (const m of mv.meshes) m.visible = (m.name ?? '') !== 'world:traffic-emote';
            return true;
        }

        // Leaf transform (hinge at the door's left jamb, proud of the wall; baked door lift).
        const e: [number, number] = [-door.oz, door.ox];
        const hx = door.x - e[0] * 0.013 * s + door.ox * 0.006 * s;
        const hz = door.z - e[1] * 0.013 * s + door.oz * 0.006 * s;
        this.w._warpInto(hx, hz, this.w._warpScratch);
        const lwx = this.w._warpScratch[0], lwz = this.w._warpScratch[1];
        v.leaf.visible = leafOn;
        if (leafOn) {
            v.leaf.x = hx + lwx; v.leaf.y = gy + door.lift; v.leaf.z = hz + lwz;
            v.leaf.rotationY = door.yaw + swing * 1.55;
            v.leaf.updateLocalMatrix();
        }

        // Walker transit: route anchor → doorstep (eased), terrain height blending up to the door lift.
        const ke = k * k * (3 - 2 * k);
        const px = rx + (tx - rx) * ke, pz = rz + (tz - rz) * ke;
        const y = this.w._heightFn(px, pz) * (1 - ke) + door.lift * ke;
        this.w._warpInto(px, pz, this.w._warpScratch);
        const wx = this.w._warpScratch[0], wz = this.w._warpScratch[1];
        for (const m of mv.meshes) {
            const isEmote = (m.name ?? '') === 'world:traffic-emote';
            m.visible = walkerOn && !isEmote;
            if (walkerOn) { m.x = px + wx; m.y = gy + y; m.z = pz + wz; m.updateLocalMatrix(); }
        }
        return false;
    }

    // ── Shared animation ticker (day/night cycle + traffic) ──────────────────────────────────────

}
