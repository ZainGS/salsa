// Audit C3 (2026-09-13): the TRAFFIC SIM (movers + car-yield + walker chats + door visits), extracted
// VERBATIM from WorldManager. The shared animation TICKER and the centre-visibility mover gate stay on
// the manager (they coordinate traffic + day-cycle + weather + turntable); this class owns the mover
// state and the per-frame routing/animation. `w` is the manager (wide host, C1 stance).
//
// 2026-09-29 (city-quality E3/E4/E12/E15): cars + walkers are ROUTED over the intersection graph (world/route-sim.ts):
// cars turn at junctions, hold at the stop line on red and at stop signs, swing out round parked cars; walkers keep
// to their pavement, turn corners, wait for the green man and cross on the zebras. The signal PHASE CLOCK re-dresses
// the lamp layers as it ticks. Walkers swing their legs (per-mesh CPU rotation — no shader edit) and face their
// route; cars carry a headlight pool that shows after dark. Legacy movers (train / clouds / weather / ducks / birds /
// shotengai shuttles) keep their original a→b ticking.
import type { WorldManager } from './world-manager';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { computeTraffic, cellLevelAt, hash2, Accum3D } from '../../world';
import type { MoverSpec, WorldGraph } from '../../world';
import { trafficParamsKey, type TrafficPrecompute } from '../../world/traffic-precompute';
import { roadNet, adoptRoadNet, carLeg, carNext, walkLeg, walkNext, legPoint, legProject, gateOpen, carHoldAt, type RoadNet, type Leg } from '../../world/route-sim';
import { bridgeSurfaceAt } from '../../world/bridge-deck';
import { carHeightAt, crossingSurfaceY } from '../../world/local-line-build';
import { LocalCrossings } from './world-crossings';
import { crossingFrame } from '../../world/local-line';
import { stationEntrances } from '../../world/station-entrances';
import type { TrainRunPlan } from '../../world/train';
import { stepTrainRun, carPoseAt, EMU_DOOR_SLIDE_M, EMU_BOGIE_HALF_M, type TrainRunState } from '../../world/train';
import { cityMetresPerUnit } from '../../world/types';
import { signalState, SIGNAL_LAMP_RE, SIGNAL_ON, SIGNAL_OFF, SIGNAL_BUCKETS, DEFAULT_SIGNAL_TIMING, type SignalTiming, type SignalLamp } from '../../world/signals';
import { SIM_FROZEN, SIM_MID, newSimSlot, simBand, simDue, simPointInView, type SimLod, type SimLodCounter, type SimSlot } from '../../world/sim-lod';
import { WalkerClock, newWalkerPose, type WalkerPose, type WalkerClockBase } from '../../world/walker-clock';
import { trainRunTimeline, trainRunAt, type TrainRunTimeline } from '../../world/train';

/** Static meshes the live sim replaces while it runs: the parked trains (main + local line) and the local line's
 *  raised crossing arms (the live arms swing). */
export const STATIC_WHILE_LIVE = /rail-train|local-train|local-xing-arm$/;

/** Dev logging (mirrors world-manager's WORLD_VERBOSE — kept local to avoid a value-import cycle). */
const WORLD_VERBOSE = false;

/** Route state of a ROUTED mover (cars / walkers over the road graph). */
interface RouteAgent {
    mode: 'car' | 'walk';
    leg: Leg; s: number; visit: number; id: number;
    /** Walkers: waiting at a gate (the green man / a turn-round beat); seconds waited so far. */
    waiting: boolean; waited: number;
    /** Cars: visual scale 0..1 and direction of a dead-end fade (−1 out, +1 in, 0 none). */
    fade: number; fading: -1 | 0 | 1;
    /** Cars: stop-sign dwell timer + whether this leg's stop sign has been served. */
    hold: number; signDone: boolean;
    /** Cars: current lateral swing toward the centreline (passing a parked car / roadworks). */
    shift: number;
    /** Cars: committed through this leg's junction on the amber (won't brake in the box). */
    through: boolean;
    halfLen: number; bus: boolean;
    /** Cars: the PEEKED next leg (car following looks through the junction): `nxFor` = the leg it was peeked from
     *  (stale once the leg changes), `nx` = the next edge (−1 = dead end). The leg transition reuses it — carNext is
     *  hash-keyed on (edge, id, visit + 1), so the peek is exactly the choice the transition would make. */
    nxFor?: Leg | null; nx?: number; nxLeg?: Leg | null;
    /** Cars, RIGHT-OF-WAY at an unsignalled junction (WorldTraffic._junctions): `gNode` = the node this car holds an
     *  entry grant for (the far node of `gFor`, its current leg; −1 = none), toward edge `gOut`. `bNode` = the junction
     *  box it is still clearing (entered from `bIn` onto `bOut`; −1 = none) — until its tail is off the curve. `jFor` /
     *  `jArr` = the leg + sim time it became the head of its approach queue (first-come first-served). */
    gNode?: number; gOut?: number; gFor?: Leg | null;
    bNode?: number; bIn?: number; bOut?: number;
    jFor?: Leg | null; jArr?: number;
}

/** CAR FOLLOWING + PLAYER YIELD tunables (WorldTraffic.follow). Distances in METRES (× s/15 world units). */
export interface CarFollowConfig {
    /** Gipps safe-speed following over the per-edge lane order (false = the old binary blocker only, A/B). */
    on: boolean;
    /** Standstill bumper-to-bumper gap a car keeps to its leader (m). */
    jamGapM: number;
    /** Time headway / reaction time of the safe-speed model (s): the moving gap grows by v·T. */
    headwayS: number;
    /** Hard floor on the bumper gap (m): the position clamp (emergency stop) never lets a car get closer. */
    hardGapM: number;
    /** Comfortable braking, × the car's own top speed per second (the red-light braking uses the same). */
    brakeK: number;
    /** Emergency braking cap, × top speed per second (a cut-in / a leader appearing inside the braking distance). */
    emergencyK: number;
    /** Cars yield to the Play player standing / walking in their lane corridor. */
    playerYield: boolean;
    /** The player's obstacle radius (m). */
    playerRadiusM: number;
    /** Half-width of a car's lane corridor (m) — the player counts as "in the lane" within this + their radius. */
    corridorHalfM: number;
    /** The player only counts when their feet (the ground under them) are within this height of the road (m) — a
     *  player on a footbridge / overpass above the lane is no obstacle. */
    playerHeightM: number;
    /** RIGHT-OF-WAY at unsignalled junctions: a car enters the junction box only with a grant (no conflicting path
     *  through the box occupied or claimed by an earlier car; stem traffic at a T last). false = the old behaviour. */
    junctionYield: boolean;
    /** Where an ungranted car waits: its front bumper this far behind the junction mouth (m) — pulled further back on
     *  an approach a turning car's swept body reaches into. */
    yieldBackM: number;
    /** Two paths through a box conflict when their swept car axes come closer than this (m) — about two half-widths. */
    boxClearM: number;
    /** A car waiting longer than this (s) at the queue head jumps the priority order (lowest id first): no starvation
     *  of a stem car on a busy main road, no circular wait. */
    maxWaitS: number;
}
export const DEFAULT_CAR_FOLLOW: CarFollowConfig = {
    on: true, jamGapM: 2, headwayS: 0.9, hardGapM: 0.6, brakeK: 3.2, emergencyK: 9,
    playerYield: true, playerRadiusM: 0.45, corridorHalfM: 1.0, playerHeightM: 1.5,
    junctionYield: true, yieldBackM: 0.5, boxClearM: 2.2, maxWaitS: 8,
};

/** The walker limb layers the ticker poses: thighs (`legL/R`), shins + shoes (`shinL/R`, `shoeL/R`), arms + hands. */
const WALKER_LIMB_RE = /^world:traffic-walker-(leg|arm|hand|shin|shoe)([LR])$/;

/** KNEE FLEX through one gait cycle, 0‥~1 (× the gait's `flex` radians), for a leg whose hip angle is amp·sin φ
 *  (forward-most at φ = π/2): folds through the SWING (peak just after the leg passes behind the body, starting
 *  before toe-off), straightens before HEEL STRIKE, and gives a little on LOADING just after it. Exported for tests. */
export function kneeFlexCurve(phase: number): number {
    let p = phase % (Math.PI * 2); if (p > Math.PI) p -= Math.PI * 2; else if (p < -Math.PI) p += Math.PI * 2;
    const sw = Math.max(0, Math.cos(p + 0.6)), load = p > Math.PI / 2 && p < Math.PI ? Math.sin((p - Math.PI / 2) * 2) : 0;
    return 0.9 * sw * sw + 0.18 * load;
}

/** How far a walker's body sits BELOW its straight-leg height (≤ 0, knee units) for two legs' (hip angle, knee flex):
 *  the lower of the two feet (its heel or toe point, whichever is lower) stays on the ground. Exported for tests. */
export function walkerSink(kn: { x: number; y: number; heel: [number, number]; toe: [number, number] }, th0: number, kf0: number, th1: number, kf1: number): number {
    let low = Infinity;
    for (const [a, f] of [[th0, kf0], [th1, kf1]]) {
        const ps = a - f, ca = Math.cos(a), sa = Math.sin(a), cp = Math.cos(ps), sq = Math.sin(ps);
        const ky = kn.x * sa + kn.y * ca;
        low = Math.min(low, ky + Math.min(kn.heel[0] * sq + kn.heel[1] * cp, kn.toe[0] * sq + kn.toe[1] * cp));
    }
    return kn.y + Math.min(kn.heel[1], kn.toe[1]) - low;
}

/** One live traffic mover (a spawned MoverSpec + its meshes + route state). */
export interface MoverRec {
    spec: MoverSpec; meshes: Mesh3D[]; len: number; t: number; dir: 1 | -1;
    pausedUntil: number; cooldownUntil: number; emote: Mesh3D | null;
    path: { pts: [number, number][]; cum: number[]; total: number } | null;
    vel: number;            // current speed (eased toward the target each frame → real accel/decel, no snap)
    yaw: number | null;     // current heading (eased toward the route heading → smooth turns)
    scale: number;          // current visual scale (cars fade in/out at a dead end instead of teleport-popping)
    /** In a door visit (walking to a door / inside a building) — excluded from routing, chat and car-yield. */
    visiting: boolean;
    /** ARTICULATED CONSIST (trains): one entry per car — its own meshes + signed longitudinal offset (world units
     *  from the consist centre). Each car is placed at its own arc-length so the train bends around curves. When
     *  set, the ticker drives these instead of the single shared transform on `meshes`. */
    segments?: TrainSeg[];
    /** RAIL RUN state (EMU consists with a station-stop schedule — train.ts stepTrainRun). */
    run?: TrainRunState;
    /** Last travel direction the cab lamps were dressed for (head lights lead, tail lights trail). */
    runLampDir?: number;
    /** Routed movers (cars / walkers over the road graph). */
    agent: RouteAgent | null;
    /** The two swinging leg meshes (walkers with a `gait`). */
    legs: { mesh: Mesh3D; side: -1 | 1 }[] | null;
    /** The FREE swinging arm meshes (0–2; walkers whose gait has `arm`) + their hands — swing opposite their same-side leg. */
    arms: { mesh: Mesh3D; side: -1 | 1 }[] | null;
    /** SHIN (+ shoe) meshes (walkers whose gait has `knee`) — hung at the swinging thigh's knee, bent by the gait. */
    shins: { mesh: Mesh3D; side: -1 | 1 }[] | null;
    /** `meshes` minus the legs + arms (the rigid part — placed at the mover base). */
    body: Mesh3D[];
    /** Headlight pool mesh (cars) — shown after dark. */
    pool: Mesh3D | null;
    phase: number;          // gait phase (radians)
    /** Last raw (unwarped) position + unit heading — the yield scan + encounters read these. */
    cx: number; cz: number; hx: number; hz: number;
    /** While paused for a chat / browsing: the heading to face (toward the partner / the stall). */
    faceYaw: number | null;
    /** T7.3 placement gate: sim time accumulated since the meshes were last posed (a throttled / off-screen mover
     *  keeps simulating every frame but only re-poses on its cadence — the pose then catches up by this dt). */
    placeDt?: number;
    // ── SIM LOD (src/world/sim-lod.ts, performance-plan §P13); unused with sim LOD off ──
    /** The band schedule. */
    sl?: SimSlot;
    /** Routed walkers: the position as a function of the clock (walker-clock.ts); dirty = rebase from the agent state
     *  (back from a door visit). */
    clock?: WalkerClock | null;
    clockDirty?: boolean;
    /** Walkers: held at a closed level crossing (a clock hold until it opens). */
    xHold?: boolean;
    /** Frozen walkers: when the clock was last evaluated (their position refreshes once a second, posed never). */
    frozenEval?: number;
    /** Rail runs: the schedule as a function of the clock (train.ts trainRunTimeline) and its time origin. */
    runTl?: TrainRunTimeline | null;
    runT0?: number;
    /** Legacy a→b movers (not walkers): the closed-form base (t, time, dir). */
    lin?: { t: number; time: number; dir: 1 | -1 } | null;
    /** Far / off-screen cars: sim time owed since their last (substepped) update. */
    simDt?: number;
}
/** One car of an articulated consist: its meshes + signed offset from the consist centre (world units). EMU cars also
 *  carry `flip` (turned 180°), the sliding door leaves (A slide −x, B +x in car space) and the cab lamps. */
export interface TrainSeg {
    meshes: Mesh3D[]; offset: number; flip?: boolean;
    doorA?: Mesh3D[]; doorB?: Mesh3D[]; body?: Mesh3D[]; head?: Mesh3D[]; tail?: Mesh3D[];
}
/** EMU door-leaf mesh names (`…-doorA`, `…-win-doorB`). */
const TRAIN_DOOR_RE = /-door([AB])$/;
/** A building front door (stamped by streets' addEntrance) the visit sim can use — or a BROWSE spot (a stall / a
 *  vending machine: the walker walks up, stands a moment facing it, and walks back; no door, never disappears). */
export interface DoorSpot { x: number; z: number; lift: number; ox: number; oz: number; yaw: number; wx: number; wz: number; browse?: boolean;
    /** A STATION ENTRANCE (railway-upgrade R2.2): the walker walks up and goes in — no leaf, vanishes like a door visit. */
    station?: boolean }
/** A pedestrian's DOOR VISIT: walk to the door → it swings open → step in (despawn) → later come back out. */
export interface DoorVisit { mv: MoverRec; door: DoorSpot; start: number; dur: number; leaf: Mesh3D | null; ax: number; az: number }

/** Scratch for legPoint (allocation-free per frame). */
const LP = { x: 0, z: 0, hx: 1, hz: 0, seg: 0 };

/** Distance between segments (a0→a1) and (b0→b1) in the plane (0 when they cross). */
function segSegDist(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
    const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz;
    const den = ux * vz - uz * vx;
    if (Math.abs(den) > 1e-14) {
        const t = ((cx - ax) * vz - (cz - az) * vx) / den, u = ((cx - ax) * uz - (cz - az) * ux) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
    }
    const pt = (px: number, pz: number, qx: number, qz: number, wx: number, wz: number): number => {
        const l2 = wx * wx + wz * wz, t = l2 > 0 ? Math.max(0, Math.min(1, ((px - qx) * wx + (pz - qz) * wz) / l2)) : 0;
        return Math.hypot(px - qx - wx * t, pz - qz - wz * t);
    };
    return Math.min(pt(ax, az, cx, cz, vx, vz), pt(bx, bz, cx, cz, vx, vz), pt(cx, cz, ax, az, ux, uz), pt(dx, dz, ax, az, ux, uz));
}

/** T7.3 — how often (in frames) a mover's MESHES are re-posed, from its camera distance (world units) relative to the
 *  city radius. The SIMULATION always runs every frame; only the transform write + terrain/warp sampling + the GPU
 *  instance upload are throttled. Near movers (street level) animate every frame; mid-distance ones every 2nd; far
 *  ones (a few pixels tall in the overview) every 3rd. Only the small, numerous kinds throttle (+ the slow drifting
 *  clouds, capped at every 2nd frame) — trains / flyers read as big smooth motion and always pose every frame. */
export function moverPoseInterval(dist: number, cityR: number, kind: string): number {
    const cloud = kind === 'cloud';   // big + slow: at most every 2nd frame
    if (!cloud && kind !== 'walker' && kind !== 'car' && kind !== 'bird') return 1;
    if (!(cityR > 0) || dist < cityR * 0.6) return 1;
    return cloud || dist < cityR * 1.5 ? 2 : 3;
}

/** T7.3 — is world point (x,y,z) inside the view (clip-space test against a row-major-in-memory column-major VP
 *  matrix, NDC widened by `margin`)? Points behind the camera are out. */
export function pointInView(vp: ArrayLike<number>, x: number, y: number, z: number, margin: number): boolean {
    const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (w <= 1e-4) return false;
    const nx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w;
    const ny = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w;
    return nx >= -margin && nx <= margin && ny >= -margin && ny <= margin;
}

export class WorldTraffic {
    constructor(private readonly w: WorldManager) { this.xing = new LocalCrossings(w); }

    /** railway-upgrade R3.2: the local line's level crossings (arms, lamps, the road-user hold). */
    readonly xing: LocalCrossings;
    private _localTrains: { run: TrainRunState; plan: TrainRunPlan }[] = [];

    /** Whether the traffic sim is running (persists across regens → respawn). */
    on = false;
    /** True while the live sim has hidden the STATIC_WHILE_LIVE meshes (parked trains, raised crossing arms) — the zoom
     *  LOD must not re-show them (bug-hunt 2026-10-01 D-W5). */
    staticsHidden = false;
    movers: MoverRec[] = [];
    /** Signal phase timing (seconds) — `setSignalTiming` for a UI control. */
    timing: SignalTiming = { ...DEFAULT_SIGNAL_TIMING };
    private _visits: DoorVisit[] = [];
    private _doorSpots: DoorSpot[] = [];
    private _browseSpots: DoorSpot[] = [];
    private _stationSpots: DoorSpot[] = [];
    private _doorLeaves: Mesh3D[] = [];
    private _chatTimer = 0;    // encounter scan throttle
    private _poseBuf = new Float32Array(0);   // reused mover pose scratch (x, z, hx, hz per mover — no per-frame allocs)
    // T7.3 placement gate state (per tick): camera VP + position, frame counter, and whether gating is live.
    private _gateFrame = 0;
    private _gateVP: ArrayLike<number> | null = null;
    private _gateCam: ArrayLike<number> | null = null;
    private _gateR = 1;
    /** Off for A/B (console: salsaWorld.manager['_traffic'].poseGate = false) — every mover re-poses every frame. */
    poseGate = true;
    /** P9 (performance-plan P9): the car AI's blocker scan (_carBlocked) reads only the cars / walkers in the grid
     *  cells around the car (a per-tick uniform grid over the tick's pose snapshot) instead of every mover — it was
     *  O(cars × movers) a frame, the largest single cost of the tick. false = the full scan (A/B). The result is the
     *  same boolean: every predicate is bounded by a reach the query covers. `checkBlockGrid` runs both and counts
     *  disagreements in `blockGridMismatches` (verification). */
    blockGrid = true;
    checkBlockGrid = false;
    blockGridMismatches = 0;
    private _bgCell = 1;
    private _bgX0 = 0;
    private _bgZ0 = 0;
    private _bgNx = 0;
    private _bgNz = 0;
    private _bgStart = new Int32Array(0);
    private _bgItems = new Int32Array(0);
    private _bgCellOf = new Int32Array(0);
    private _net: RoadNet | null = null;
    /** Phase-switched signal lamp meshes (rescanned when the scene epoch moves — streamed tiles bring new ones). */
    private _signals: { mesh: Mesh3D; lamp: SignalLamp; bucket: number; axis: 0 | 1 }[] = [];
    /** Scratch per-leg hip angles + knee flex for _place (no per-frame allocation). */
    private readonly _legTh = [0, 0];
    private readonly _legKf = [0, 0];
    private _sigEpoch = -1;
    private _sigLamp: (SignalLamp | null)[] = new Array(SIGNAL_BUCKETS * 2).fill(null);
    /** Parked cars / roadworks per road side (`ri|side` → along intervals) — the swerve obstacles. */
    private _obstacles = new Map<string, { lo: number; hi: number }[]>();
    private _busStops = new Map<string, number[]>();
    /** CAR FOLLOWING + PLAYER YIELD tunables (see CarFollowConfig) — live; console: salsaWorld.manager['_traffic'].follow. */
    follow: CarFollowConfig = { ...DEFAULT_CAR_FOLLOW };
    // Per-tick LANE ORDER (counting sort of the cars by their leg's directed edge, each bucket sorted by the distance
    // left to the edge's end): a car's leader is its neighbour in its bucket, or the last car of its peeked next
    // edge's bucket — O(cars) a tick, no all-pairs scan. Snapshot values (rem / vel / half-length) at tick start: a
    // leader only moves forward, so a stale snapshot under-states the gap (safe).
    private _laneOn = false;
    private _laneStart = new Int32Array(0);
    private _laneFill = new Int32Array(0);
    private _laneItems = new Int32Array(0);
    private _laneEdge = new Int32Array(0);
    private _laneRem = new Float64Array(0);
    private _laneVel = new Float64Array(0);
    /** The Play player as a lane obstacle (city-local, unwarped) — `on` false outside Play (costs nothing). */
    private readonly _pl = { on: false, x: 0, z: 0, r: 0 };
    private readonly _pj = { s: 0, lat: 0 };

    /** Retime the signals (green / yellow / all-red seconds). Takes effect on the next tick. */
    setSignalTiming(t: Partial<SignalTiming>): void {
        this.timing = {
            green: Math.max(2, t.green ?? this.timing.green), yellow: Math.max(0.5, t.yellow ?? this.timing.yellow),
            allRed: Math.max(0, t.allRed ?? this.timing.allRed),
        };
        this._sigLamp.fill(null);
        for (const mv of this.movers) if (mv.clock) mv.clock = null;   // sim LOD: the clocks re-derive their gate times
    }

    /** Drop all mover/visit/door state on a world clear (the meshes' groups are removed by the caller). */
    resetOnClear(): void {
        this._dropSpawnJob();   // (a sliced spawn's hidden groups are not in _groups yet → removed here)
        this._pre = null;
        this.movers = [];
        this.staticsHidden = false;   // the hidden statics went with the cleared world (D-W5)
        this._visits = [];
        this._doorSpots = [];
        this._browseSpots = [];
        this._stationSpots = [];
        this._doorLeaves = [];
        this._signals = [];
        this._sigEpoch = -1;
        this._net = null;
        this.xing.reset();
        this._localTrains = [];
    }

    start(): void {
        this.on = true;
        this.spawn();
        this._afterStart();
    }
    private _afterStart(): void {
        if (this.w._timeOfDay != null) this.w._applyTimeOfDay();   // dress the fresh movers (headlights/pools) for the current time
        this.w._ensureTicker();
    }
    /** Stop and remove the movers (the static parked train returns on the next regen). */
    stop(): void {
        this.on = false;
        this.despawn();
    }

    // ── P5.W4: precomputed specs + time-sliced spawn ──────────────────────────────────────────────────────────
    /** A traffic precompute for a graph (the worker centre build / the main-thread staging queue), consumed by the
     *  next spawn on that graph — if its params still match (a selective regen in between changes them in place). */
    private _pre: { graph: WorldGraph; tp: TrafficPrecompute } | null = null;
    /** Hand the next spawn on `graph` its precomputed mover specs (+ the shipped routing net, adopted by that spawn —
     *  it seeds the roadNet / streetPlan caches of the adopted graph → no ~50 ms main-thread rebuild). */
    preload(graph: WorldGraph, tp: TrafficPrecompute): void { this._pre = { graph, tp }; }
    /** True when a precompute is waiting for `graph` (diagnostics / tests). */
    hasPreload(graph: WorldGraph): boolean { return this._pre?.graph === graph; }
    /** Take the precompute if it is for `graph` with its current params (adopting its net), else null. */
    private _takePre(graph: WorldGraph): TrafficPrecompute | null {
        const pre = this._pre;
        if (!pre || pre.graph !== graph) return null;   // (one for another graph stays until replaced / cleared)
        this._pre = null;
        if (pre.tp.paramsKey !== trafficParamsKey(graph.params)) return null;   // a param changed in place since → stale
        if (pre.tp.net) adoptRoadNet(graph, pre.tp.net);
        return pre.tp;
    }
    /** Whether the last spawn used precomputed specs (diagnostics: salsaWorld.manager._traffic.lastSpawnPrecomputed). */
    lastSpawnPrecomputed = false;

    /** An in-flight SLICED spawn: the step generator, the groups it created so far (hidden until the reveal), the
     *  frame handle and the completion callback. */
    private _spawnJob: { graph: WorldGraph; it: Generator<void, void, void>; created: MeshGroup3D[]; raf: number; onDone: (() => void) | null } | null = null;
    /** The last sliced spawn: frames it took, its longest slice (ms) and the mover count (diagnostics). */
    sliceStats: { slices: number; maxMs: number; movers: number } | null = null;
    /** Sliced spawns pre-upload each staged group's geometry while hidden (A/B: false = upload at the reveal). */
    warmStaged = true;
    /** True while a sliced spawn is in flight. */
    get spawning(): boolean { return !!this._spawnJob; }

    /** start(), with the mover MESHES created over several frames under `budgetMs()` per frame (P5.W4 — the frames
     *  right after a city reveal). The new groups stay hidden (+ pre-uploaded) until the last one lands; then the
     *  sim starts in exactly the state start() leaves (same movers, same order, same placement pass). A start() /
     *  spawn() meanwhile finishes it synchronously; stop() / a despawn / a world clear cancels it. Headless (no
     *  frame loop) = start(). `onDone` runs once the movers are live (not when cancelled). */
    startSliced(budgetMs: () => number, onDone?: () => void): void {
        const graph = this.w._graph;
        if (this._spawnJob) { if (onDone) this._spawnJob.onDone = onDone; return; }
        if (typeof requestAnimationFrame === 'undefined' || !graph || this.movers.length) { this.start(); onDone?.(); return; }
        const job: NonNullable<WorldTraffic['_spawnJob']> = { graph, it: this._spawnSteps(graph, true), created: [], raf: 0, onDone: onDone ?? null };
        this._spawnJob = job;
        const st = { slices: 0, maxMs: 0, movers: 0 };
        const step = (): void => {
            if (this._spawnJob !== job) return;
            job.raf = 0;
            const t0 = performance.now(), budget = Math.max(1, budgetMs());
            let done = false;
            do { done = !!job.it.next().done; } while (!done && performance.now() - t0 < budget);
            st.slices++; st.maxMs = Math.max(st.maxMs, performance.now() - t0);
            if (done) { st.movers = this.movers.length; this.sliceStats = st; this._finishSpawnJob(job); return; }
            this.w.scene3d.requestRender3D?.();
            job.raf = requestAnimationFrame(step);
        };
        job.raf = requestAnimationFrame(step);
    }
    private _finishSpawnJob(job: NonNullable<WorldTraffic['_spawnJob']>): void {
        if (this._spawnJob !== job) return;
        this._spawnJob = null;
        this.on = true;
        this._afterStart();
        job.onDone?.();
    }
    /** Run an in-flight sliced spawn to completion NOW (a synchronous start / spawn arrived). */
    private _drainSpawn(): void {
        const job = this._spawnJob;
        if (!job) return;
        if (job.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(job.raf);
        job.raf = 0;
        while (!job.it.next().done) { /* drain */ }
        this._finishSpawnJob(job);
    }
    /** Cancel an in-flight sliced spawn and remove the hidden groups it created. */
    private _dropSpawnJob(): void {
        const job = this._spawnJob;
        if (!job) return;
        this._spawnJob = null;
        if (job.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(job.raf);
        // Not yet in `_groups` (they join at the reveal) → a world clear's group sweep would miss them: always remove.
        for (const g of job.created) this.w.scene3d.removeFlatColorMeshGroup(g, true);
        this._doorLeaves = [];
    }

    spawn(): void {
        if (this._spawnJob) { this._drainSpawn(); return; }   // a sliced spawn in flight → finish it synchronously
        const graph = this.w._graph;
        if (!graph || this.movers.length) return;
        const it = this._spawnSteps(graph, false);
        while (!it.next().done) { /* one go */ }
    }

    /** THE spawn, as steps (a yield = a slice boundary). spawn() runs it in one go; startSliced() runs it under a frame
     *  budget with `sliced` = true: every mover group is created HIDDEN (its meshes' own visibility recorded) and
     *  pre-uploaded, and revealed — together with everything that touches the live scene (the parked-train hide, the
     *  signals, the glow, the placement pass) — in the LAST step, so the outcome is the synchronous spawn's. */
    private *_spawnSteps(graph: WorldGraph, sliced: boolean): Generator<void, void, void> {
        this.w._sceneEpoch++;   // movers/doors push into _groups below → LOD must re-hide walkers/birds when zoomed out
        // The parked trains (+ the local line's raised static arms): collected BEFORE any mover exists (the moving
        // consists share the name stems); a sliced spawn hides them at the reveal.
        const statics: Mesh3D[] = [];
        for (const child of this.w._allWorldMeshes()) if (STATIC_WHILE_LIVE.test(child.name ?? '')) statics.push(child);
        if (!sliced) { for (const m of statics) m.visible = false; this.staticsHidden = true; }
        // Sliced: the new groups join `_groups` only at the reveal (so the zoom LOD / glow / crowd walks never touch a
        // half-spawned mover), their meshes hidden meanwhile (own visibility recorded, restored at the reveal).
        const created: MeshGroup3D[] = sliced && this._spawnJob ? this._spawnJob.created : [];
        const hidden: { meshes: Mesh3D[]; vis: boolean[] }[] = [];
        const addGroup = (layers: MoverSpec['layers']): MeshGroup3D => {
            const g = this.w.scene3d.addFlatColorMeshGroup('World Traffic', layers, true, this.w._ensureCityContainer());
            if (!sliced) { this.w._groups.push(g); return g; }
            const cm = g.children as unknown as Mesh3D[];
            hidden.push({ meshes: cm, vis: cm.map(m => m.visible) });
            for (const m of cm) m.visible = false;
            created.push(g);
            if (this.warmStaged) this.w.scene3d.warmGroupGeometry3D?.(g);   // pre-upload while hidden → the reveal is a visibility flip
            return g;
        };
        const pre = this._takePre(graph);
        this.lastSpawnPrecomputed = !!pre;
        const net = this._net = roadNet(graph);
        const specs = pre ? pre.specs : computeTraffic(graph);
        const movers: MoverRec[] = [];
        for (const spec of specs) {
            // ARTICULATED CONSIST: `spec.layers` is ONE car; clone it `count` times so each car gets its own meshes
            // (they share the car geometry → still cheap). Otherwise a single mesh set for the whole mover.
            const meshes: Mesh3D[] = [];
            let segments: TrainSeg[] | undefined;
            if (spec.cars && (spec.cars.count > 1 || spec.cars.variants)) {
                segments = [];
                const n = spec.cars.count, cars = spec.cars;
                for (let c = 0; c < n; c++) {
                    const layers = cars.variants ? cars.variants[cars.pick?.[c] ?? 0] ?? spec.layers : spec.layers;
                    const g = addGroup(layers);
                    const cm = g.children as unknown as Mesh3D[];
                    for (const m of cm) { m.cheapBounds = true; meshes.push(m); }
                    const seg: TrainSeg = { meshes: cm, offset: (c - (n - 1) / 2) * cars.spacing, flip: !!cars.flip?.[c] };   // signed distance from the consist centre
                    if (spec.run) {
                        // EMU car: split the sliding door leaves + cab lamps from the rigid body.
                        seg.doorA = []; seg.doorB = []; seg.body = []; seg.head = []; seg.tail = [];
                        for (const m of cm) {
                            const nm = m.name ?? '', d = TRAIN_DOOR_RE.exec(nm);
                            (d ? (d[1] === 'A' ? seg.doorA : seg.doorB) : seg.body).push(m);
                            if (/headlight$/.test(nm)) seg.head.push(m); else if (/taillight$/.test(nm)) seg.tail.push(m);
                        }
                    }
                    segments.push(seg);
                }
            } else {
                const g = addGroup(spec.layers);
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
            // Routed agent (cars / walkers over the road graph).
            let agent: RouteAgent | null = null;
            if (spec.route) {
                const r = spec.route;
                const leg = r.mode === 'car' ? carLeg(net, r.edge, null) : walkLeg(net, r.edge, r.side);
                const s0 = r.mode === 'car' ? leg.sStart + Math.max(0, (leg.total - leg.sStart) * r.t - (r.halfLen * 2)) : leg.total * r.t;
                agent = { mode: r.mode, leg, s: s0, visit: 0, id: r.id, waiting: false, waited: 0, fade: 1, fading: 0, hold: 0, signDone: false, shift: 0, through: false, halfLen: r.halfLen, bus: !!r.bus };
            }
            const legs: { mesh: Mesh3D; side: -1 | 1 }[] = [], arms: { mesh: Mesh3D; side: -1 | 1 }[] = [], shins: { mesh: Mesh3D; side: -1 | 1 }[] = [];
            for (const m of meshes) {
                const r = WALKER_LIMB_RE.exec(m.name ?? '');
                if (!r) continue;
                const side: -1 | 1 = r[2] === 'L' ? -1 : 1;
                (r[1] === 'leg' ? legs : r[1] === 'arm' || r[1] === 'hand' ? arms : shins).push({ mesh: m, side });
            }
            const pool = meshes.find(m => (m.name ?? '') === 'world:traffic-headlight-pool') ?? null;
            if (pool) pool.visible = false;
            if (spec.scale && spec.scale !== 1) for (const m of meshes) m.setScale3D(spec.scale, spec.scale, spec.scale);
            movers.push({
                run: spec.run ? { ...spec.run.start } : undefined,
                spec, meshes, len, t: spec.run ? spec.run.start.s / len : spec.t0, dir: spec.run ? spec.run.start.dir : 1, pausedUntil: 0, cooldownUntil: 0, emote, path, visiting: false, vel: 0, yaw: null, scale: 1, segments,
                agent, legs: legs.length ? legs : null, arms: arms.length && spec.gait?.arm ? arms : null, shins: shins.length && spec.gait?.knee ? shins : null,
                body: meshes.filter(m => !legs.some(l => l.mesh === m) && !(spec.gait?.arm && arms.some(l => l.mesh === m)) && !(spec.gait?.knee && shins.some(l => l.mesh === m))),
                pool, phase: hash2(movers.length, 7, 0x9a17) * 6.283,
                cx: spec.a[0], cz: spec.a[1], hx: 1, hz: 0, faceYaw: null,
            });
            if (sliced) yield;   // a slice boundary per mover
        }
        // Swerve obstacles (parked cars + roadworks) and bus-stop positions per road side, from the shared plan.
        this._obstacles.clear(); this._busStops.clear();
        for (const sl of [...net.plan.of('parked'), ...net.plan.of('roadworks')]) {
            const k = sl.ri + '|' + sl.side, arr = this._obstacles.get(k) ?? [];
            arr.push({ lo: sl.along - sl.half, hi: sl.along + sl.half }); this._obstacles.set(k, arr);
        }
        for (const sl of net.plan.of('busstop')) { const k = sl.ri + '|' + sl.side; this._busStops.set(k, [...(this._busStops.get(k) ?? []), sl.along]); }
        if (sliced) yield;
        // DOOR VISITS: collect the stamped front doors + create the two reusable animated door LEAVES
        // (hinge at the mesh origin — rotationY swings them open; hidden until a visit needs one).
        const gp = graph.params, ws = gp.radius / 10;
        this._doorSpots = [];
        const stepH = 0.16 * ws * 0.5;   // half a terrace step (elevation.terraceStep)
        for (const lot of graph.lots) {
            if (!lot.door || !lot.doorOut) continue;
            // ★ B1: a door on a raised terrace (a retaining wall between it and the pavement) can't be walked to
            // from the street — the visit would walk the pedestrian through the wall. Only level doors host visits.
            const apx = lot.door[0] + lot.doorOut[0] * 0.25 * ws, apz = lot.door[1] + lot.doorOut[1] * 0.25 * ws;
            if (Math.abs(this.w._heightFn(lot.door[0], lot.door[1]) - this.w._heightFn(apx, apz)) > stepH) continue;
            const e: [number, number] = [-lot.doorOut[1], lot.doorOut[0]];   // door frontage direction
            this.w._warpInto(lot.door[0], lot.door[1], this.w._warpScratch);
            this._doorSpots.push({
                x: lot.door[0], z: lot.door[1], lift: this.w._heightFn(lot.center[0], lot.center[1]),
                ox: lot.doorOut[0], oz: lot.doorOut[1], yaw: Math.atan2(-e[1], e[0]),
                wx: lot.door[0] + this.w._warpScratch[0], wz: lot.door[1] + this.w._warpScratch[1],
            });
        }
        if (sliced) yield;
        // BROWSE spots: shoppers step up to the produce stalls and the vending runs (E12 — visits beyond doors).
        this._browseSpots = [];
        for (const sl of [...net.plan.of('stall'), ...net.plan.of('vending')]) {
            const R = net.plan.roads[sl.ri]!, out: [number, number] = [R.pp[0] * sl.side, R.pp[1] * sl.side];
            const off = sl.kind === 'stall' ? net.plan.side(sl.ri, sl.side)!.walkC : sl.off - 0.045 * ws;
            const [x, z] = net.plan.at(sl.ri, sl.side, sl.along, off);
            this._browseSpots.push({ x, z, lift: 0, ox: -out[0], oz: -out[1], yaw: Math.atan2(-out[1], out[0]), wx: x, wz: z, browse: true });
        }
        // STATION ENTRANCES (R2.2): the elevated line's stair feet, metro kiosks, the local line's platform stairs.
        this._stationSpots = stationEntrances(graph).map(e => ({ x: e.x, z: e.z, lift: this.w._heightFn(e.x, e.z), ox: e.ox, oz: e.oz,
            yaw: Math.atan2(e.ox, -e.oz), wx: e.x, wz: e.z, station: true }));
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
            ], true, this.w._ensureCityContainer());
            if (sliced) { created.push(lg); if (this.warmStaged) this.w.scene3d.warmGroupGeometry3D?.(lg); } else this.w._groups.push(lg);
            this._doorLeaves = lg.children as unknown as Mesh3D[];
            for (const l of this._doorLeaves) { l.visible = false; l.cheapBounds = true; }
        }
        if (sliced) yield;
        // ── THE REVEAL (one step): the movers go live exactly as a synchronous spawn leaves them. ──
        if (sliced) {
            for (const h of hidden) for (let i = 0; i < h.meshes.length; i++) h.meshes[i].visible = h.vis[i];
            for (const mv of movers) { if (mv.emote) mv.emote.visible = false; if (mv.pool) mv.pool.visible = false; }
            for (const m of statics) m.visible = false;
            this.staticsHidden = true;
            for (const g of created) this.w._groups.push(g);   // (creation order = the synchronous spawn's)
            this.w._sceneEpoch++;   // shown meshes → LOD re-applies (walkers / birds when zoomed out)
            this.w.scene3d.notifyVisibilityChanged3D?.();   // hidden → shown: the host render list re-filters
        }
        this.movers = movers;
        // ★ T7.3: every mover group above was added SILENT — ONE scene-graph notification for the whole spawn. Each
        // non-silent add fired emitSceneGraphChanged → the host's full-scene walks (connector re-binding etc.) —
        // ~430 groups × a whole-city tree walk was most of the ~70 ms spawn (weather / traffic toggles / regens).
        // R3.2: the level crossings follow the local consist (its run state object is mutated in place by the ticker).
        this._localTrains = this.movers.filter(m => m.run && m.spec.run?.local).map(m => ({ run: m.run!, plan: m.spec.run!.plan }));
        this.xing.spawn(graph);
        this.w.scene3d.notifySceneGraphChanged3D?.();
        this._scanSignals();
        // eslint-disable-next-line no-console
        if (WORLD_VERBOSE) console.log('[world] traffic started:', this.movers.length, 'movers');
        this.w._lastGlowNight = -1;   // fresh mover meshes (headlights etc.) must be dressed by the next glow pass
        if (this.w._hasStyle()) this.w._applyRenderStyle();
        this.tick(0);   // place everyone before the first frame
    }
    despawn(): void {
        this._dropSpawnJob();   // P5.W4: a sliced spawn in flight → its hidden groups go too
        // EVERY group of a mover: an articulated consist has one per car (removing only meshes[0]'s parent leaked the
        // other cars' groups into the scene + _groups on every respawn — fixed P5.W4). One _groups pass, in place.
        const doomed = new Set<MeshGroup3D>();
        for (const mv of this.movers) for (const m of mv.meshes) {
            const g = (m as unknown as { parent?: MeshGroup3D }).parent;
            if (g && !doomed.has(g)) { doomed.add(g); this.w.scene3d.removeFlatColorMeshGroup(g, true); }
        }
        if (doomed.size) {
            const gs = this.w._groups, keep = gs.filter(g => !doomed.has(g));
            gs.length = 0; for (const g of keep) gs.push(g);
        }
        const hadMovers = this.movers.length > 0;
        this.movers = [];
        this._visits = [];
        // Remove the reusable door-LEAVES group too (not just hide it) — _spawnTraffic creates a fresh one every
        // time, so hiding-only orphaned a 2-mesh group into _groups + the scene graph on EVERY traffic respawn
        // (weather / railway / clouds / traffic toggles), growing getAllMeshes() and the pool without bound.
        const lg = (this._doorLeaves[0] as unknown as { parent?: MeshGroup3D })?.parent;
        if (lg) { this.w.scene3d.removeFlatColorMeshGroup(lg, true); const i = this.w._groups.indexOf(lg); if (i >= 0) this.w._groups.splice(i, 1); }
        this._doorLeaves = [];
        this.xing.despawn();
        this._localTrains = [];
        if (hadMovers || lg) this.w.scene3d.notifySceneGraphChanged3D?.();   // ONE notification for the whole despawn (see spawn)
        for (const child of this.w._allWorldMeshes()) if (STATIC_WHILE_LIVE.test(child.name ?? '')) child.visible = true;
        this.staticsHidden = false;
    }

    // ── Signals ───────────────────────────────────────────────────────────────────────────────────
    /** Find the phase-switched lamp meshes (`world:signal-<lamp>-<bucket><a|b>`). */
    private _scanSignals(): void {
        this._signals = [];
        for (const m of this.w._allWorldMeshes()) {
            const r = SIGNAL_LAMP_RE.exec(m.name ?? '');
            if (r) this._signals.push({ mesh: m, lamp: r[1] as SignalLamp, bucket: Number(r[2]), axis: r[3] === 'b' ? 1 : 0 });
        }
        this._sigEpoch = this.w._meshSetEpoch;
        this._sigLamp.fill(null);
    }
    /** Re-dress the lamps whose (bucket, axis) state changed. The unlit lens gets a dark diffuse — the glow walk sets
     *  emissive = diffuse × its day/night factor, so an off lamp stays off through every later re-dress too. */
    private _tickSignals(time: number): void {
        if (this._sigEpoch !== this.w._meshSetEpoch) this._scanSignals();
        if (!this._signals.length) return;
        for (let b = 0; b < SIGNAL_BUCKETS; b++) for (const axis of [0, 1] as const) {
            const lamp = signalState(time, b, axis, this.timing).lamp, k = b * 2 + axis;
            if (this._sigLamp[k] === lamp) continue;
            this._sigLamp[k] = lamp;
            for (const sg of this._signals) {
                if (sg.bucket !== b || sg.axis !== axis) continue;
                const mat = sg.mesh.material; if (!mat) continue;
                const f = mat.diffuse.r > 1e-4 ? mat.emissive.r / mat.diffuse.r : 0.55;
                const c = sg.lamp === lamp ? SIGNAL_ON[sg.lamp] : SIGNAL_OFF[sg.lamp];
                // ★ T7.3: MATERIAL-ONLY write. setDiffuseColor() sets gpuDirty, which on a RESIDENT mesh means "its
                // geometry changed" → the renderer did a FULL geometry-pool rebuild (~190 ms re-upload of the whole
                // city) on every signal phase change — the periodic city-mode hitch. materialDirty = the per-slot repack.
                mat.diffuse = { r: c[0], g: c[1], b: c[2], a: 1 };
                mat.emissive = { r: c[0] * f, g: c[1] * f, b: c[2] * f, a: 1 };
                sg.mesh.materialDirty = true;
            }
        }
    }

    tick(dt: number): void {
        const graph = this.w._graph;
        if (!graph) return;
        // NOTE: _simTime is advanced by the shared ticker (not here) — this also runs once at spawn with dt=0.
        const p = graph.params, s = p.radius / 10;
        const time = this.w._simTime;
        this._tickSignals(time);
        this.xing.tick(dt, time, this._localTrains);
        // T7.3 placement gate: one camera read per tick (see _poseGate).
        {
            const cam = this.w.scene3d.getCamera?.();   // (absent in the headless unit-test host → gate off)
            this._gateVP = cam ? cam.getViewProjectionMatrix() as unknown as ArrayLike<number> : null;
            this._gateCam = cam ? cam.position as unknown as ArrayLike<number> : null;
            this._gateR = Math.max(1e-3, p.radius);
            this._gateFrame++;
        }
        // SIM LOD (sim-lod.ts): banded updates. Only with a camera (the headless unit-test host keeps the stepped sim);
        // switched off → every clock-driven mover hands its state back to the stepped sim (seamless).
        const lodObj = (this.w.scene3d as unknown as { simLod?: SimLod }).simLod;
        const lod = this._gateVP && lodObj && lodObj.enabled && dt > 0 ? lodObj : null;
        if (!lod && this._lodWas && dt > 0) this._lodOff(time);
        if (dt > 0) this._lodWas = !!lod;
        this._lod = lod;
        if (lod) {
            this._cW = lod.counter('walkers'); this._cC = lod.counter('cars'); this._cT = lod.counter('trains'); this._cO = lod.counter('otherMovers');
            this._cW.begin(); this._cC.begin(); this._cT.begin(); this._cO.begin();
            this._cm = (this.w.cityRoot?.localMatrix as unknown as Float32Array | undefined) ?? null;
            const sel = (this.w.scene3d as unknown as { renderer3D?: { getSelectedMeshIds?(): Set<string> } }).renderer3D?.getSelectedMeshIds?.();
            this._sel = sel && sel.size ? sel : null;
        }

        // Current positions + headings (for the car-yield scan and chat encounters) — packed into ONE reused
        // Float32Array (stride 4: x, z, hx, hz) instead of ~220 fresh objects per frame (GC pressure).
        if (this._poseBuf.length < this.movers.length * 4) this._poseBuf = new Float32Array(this.movers.length * 4);
        const pose = this._poseBuf;
        for (let i = 0; i < this.movers.length; i++) {
            const mv = this.movers[i], sp = mv.spec, o = i * 4;
            // (sim LOD: a mover frozen in the fog is invisible to the others — no chats, no yields, no blocking)
            if (lod && mv.sl && mv.sl.band === SIM_FROZEN) { pose[o] = NaN; pose[o + 1] = NaN; pose[o + 2] = 1; pose[o + 3] = 0; continue; }
            if (mv.agent) { pose[o] = mv.cx; pose[o + 1] = mv.cz; pose[o + 2] = mv.hx; pose[o + 3] = mv.hz; continue; }
            const dx = (sp.b[0] - sp.a[0]) / mv.len, dz = (sp.b[1] - sp.a[1]) / mv.len;
            pose[o] = sp.a[0] + (sp.b[0] - sp.a[0]) * mv.t - dz * sp.lane;
            pose[o + 1] = sp.a[1] + (sp.b[1] - sp.a[1]) * mv.t + dx * sp.lane;
            pose[o + 2] = dx * mv.dir;
            pose[o + 3] = dz * mv.dir;
        }

        if (this.blockGrid) this._buildBlockGrid(pose, s);
        this._buildLanes(pose);
        this._readPlayer(s);
        this._junctions(time, s);

        // CHAT ENCOUNTERS (every 0.5 s): two nearby walkers may stop for a talk — emote bubbles pop up over both.
        // ~20% chance per near-pair per 10 s window (hash-keyed → no RNG state), then an 18 s cooldown.
        this._chatTimer += dt;
        if (this._chatTimer >= 0.5) {
            this._chatTimer = 0;
            const win = Math.floor(time / 10);
            // DOOR VISITS: a walker passing a stamped front door may head in (~12%/10 s window; ≤2 at once, one per
            // animated leaf). BROWSE visits: a stall / vending run (~18%; ≤6 at once — no leaf needed).
            const nDoor = this._visits.filter(v => v.leaf).length, nStation = this._visits.filter(v => v.door.station).length, nBrowse = this._visits.length - nDoor - nStation;
            for (let i = 0; i < this.movers.length; i++) {
                const a = this.movers[i];
                if (a.spec.kind !== 'walker' || a.visiting || time < a.cooldownUntil || time < a.pausedUntil) continue;
                if (a.agent?.waiting) continue;
                const roll = hash2(i * 7.7, win, (p.seed ^ 0x0d00) >>> 0);
                const pickNear = (spots: DoorSpot[], r: number): DoorSpot | null => {
                    let best: DoorSpot | null = null, bestD = r * r;
                    for (const dr of spots) { const ddx = dr.x - pose[i * 4], ddz = dr.z - pose[i * 4 + 1], d2 = ddx * ddx + ddz * ddz; if (d2 < bestD) { bestD = d2; best = dr; } }
                    return best;
                };
                if (roll < 0.12 && nDoor < Math.min(2, this._doorLeaves.length) && this._doorSpots.length) {
                    const best = pickNear(this._doorSpots, 0.09 * s); if (!best) continue;
                    const leaf = this._doorLeaves.find(l => !this._visits.some(v => v.leaf === l));
                    if (!leaf) continue;
                    a.visiting = true;
                    this._visits.push({ mv: a, door: best, start: time, dur: 5 + hash2(i * 3.1, win, (p.seed ^ 0x77d3) >>> 0) * 7, leaf, ax: pose[i * 4], az: pose[i * 4 + 1] });
                    break;
                } else if (roll > 0.82 && nBrowse < 6 && this._browseSpots.length) {
                    const best = pickNear(this._browseSpots, 0.1 * s); if (!best) continue;
                    a.visiting = true;
                    this._visits.push({ mv: a, door: best, start: time, dur: 2 + hash2(i * 5.3, win, (p.seed ^ 0x51c1) >>> 0) * 4, leaf: null, ax: pose[i * 4], az: pose[i * 4 + 1] });
                    break;
                } else if (roll >= 0.3 && roll < 0.62 && nStation < 8 && this._stationSpots.length) {
                    // A walker near a station entrance catches a train: in through the gates (or down the stair), and
                    // after a while somebody comes back out (R2.2). Commuters are common near stations (~32 % / 10 s).
                    const best = pickNear(this._stationSpots, 0.35 * s); if (!best) continue;
                    a.visiting = true;
                    this._visits.push({ mv: a, door: best, start: time, dur: 8 + hash2(i * 2.9, win, (p.seed ^ 0x57a7) >>> 0) * 14, leaf: null, ax: pose[i * 4], az: pose[i * 4 + 1] });
                    break;
                }
            }
            for (let i = 0; i < this.movers.length; i++) {
                const a = this.movers[i];
                if (a.spec.kind !== 'walker' || a.visiting || time < a.cooldownUntil) continue;
                for (let j = i + 1; j < this.movers.length; j++) {
                    const b = this.movers[j];
                    if (b.spec.kind !== 'walker' || b.visiting || time < b.cooldownUntil) continue;
                    const dxp = pose[i * 4] - pose[j * 4], dzp = pose[i * 4 + 1] - pose[j * 4 + 1];
                    if (dxp * dxp + dzp * dzp > (0.05 * s) * (0.05 * s)) continue;
                    if (hash2(i * 31.7 + j * 13.3, win, (p.seed ^ 0xc4a7) >>> 0) > 0.2) continue;
                    a.pausedUntil = b.pausedUntil = time + 3.5;      // stop and talk
                    a.cooldownUntil = b.cooldownUntil = time + 18;
                    a.faceYaw = Math.atan2(dzp, -dxp);               // face each other (yaw maps +X → (cos, −sin))
                    b.faceYaw = Math.atan2(-dzp, dxp);
                    if (a.clock) this._clockHold(a, time);            // sim LOD: the clocks brake, hold, walk on
                    if (b.clock) this._clockHold(b, time);
                    if (a.emote) this._show(a.emote, true);
                    if (b.emote) this._show(b.emote, true);
                    break;
                }
            }
        }

        // Advance active DOOR VISITS (leaf swings + walker transit/despawn) — visiting movers skip normal routing.
        for (let vi = this._visits.length - 1; vi >= 0; vi--) {
            if (this._tickVisit(this._visits[vi], s, dt)) this._visits.splice(vi, 1);
        }

        // Night level for the headlight pools (the live cycle's glow night, else the static nightMode flag).
        const night = this.w._timeOfDay != null ? Math.max(0, this.w._lastGlowNight) : (p.nightMode ? 1 : 0);
        const poolsOn = night > 0.35;

        for (let i = 0; i < this.movers.length; i++) {
            const mv = this.movers[i], sp = mv.spec;
            if (mv.visiting) { if (mv.clock) mv.clockDirty = true; continue; }   // door-visit sim owns this walker's meshes right now
            if (mv.emote && mv.emote.visible && time >= mv.pausedUntil) mv.emote.visible = false;   // chat over
            if (mv.faceYaw != null && time >= mv.pausedUntil) mv.faceYaw = null;
            if (mv.pool && mv.pool.visible !== poolsOn) this._show(mv.pool, poolsOn);
            if (mv.agent) {
                if (!lod) this._tickAgent(mv, i, dt, pose, s);
                else if (mv.agent.mode === 'walk') this._tickWalkerLod(mv, i, dt, s, lod, time);
                else this._tickCarLod(mv, i, dt, pose, s, lod, time);
                continue;
            }
            if (mv.run && sp.run && mv.segments && mv.path) { this._tickRailRun(mv, dt, p.radius, lod); continue; }
            let speed = time < mv.pausedUntil ? 0 : sp.speed;

            if (lod && sp.kind !== 'walker') {
                // SIM LOD: a legacy a→b mover (cloud, bird, boat, duck, rain, shuttle) moves at a constant speed, so its
                // route parameter is a closed form of the clock (a sawtooth, or a triangle wave for a shuttle).
                if (!mv.lin) mv.lin = { t: mv.t, time, dir: mv.dir };
                const L = mv.lin, u = sp.kind === 'rain' ? 0 : (sp.speed * (time - L.time)) / mv.len;
                if (sp.pingPong) {
                    const lo = sp.margin ?? 0, hi = 1 - lo, w = Math.max(1e-9, hi - lo);
                    let q = L.dir > 0 ? L.t - lo : 2 * w - (L.t - lo);
                    q = ((q + u) % (2 * w) + 2 * w) % (2 * w);
                    if (q < w) { mv.t = lo + q; mv.dir = 1; } else { mv.t = hi - (q - w); mv.dir = -1; }
                } else mv.t = ((L.t + u) % 1 + 1) % 1;
                mv.vel = speed;
            } else {
            if (mv.lin) mv.lin = null;
            // ACCELERATE / DECELERATE: ease the actual velocity toward the target instead of snapping.
            if (sp.kind === 'walker') {
                const accel = sp.speed * 2.5 * dt, decel = sp.speed * 4 * dt;
                mv.vel = speed > mv.vel ? Math.min(speed, mv.vel + accel) : Math.max(speed, mv.vel - decel);
            } else mv.vel = speed;
            // Advance along the route — shuttles (train / shotengai strollers) reverse at their end margins.
            const step = (sp.kind === 'rain' ? 0 : (mv.vel * dt) / mv.len);   // fall clusters don't travel their route
            if (sp.pingPong) {
                const lo = sp.margin ?? 0, hi = 1 - (sp.margin ?? 0);
                mv.t += step * mv.dir;
                // A walker turning round pauses for a beat while its heading eases through the 180° (no instant flip).
                if (mv.t >= hi) { mv.t = hi; mv.dir = -1; if (sp.kind === 'walker') mv.pausedUntil = time + 0.8; }
                else if (mv.t <= lo) { mv.t = lo; mv.dir = 1; if (sp.kind === 'walker') mv.pausedUntil = time + 0.8; }
            } else {
                mv.t = (mv.t + step) % 1;
            }
            }
            speed = mv.vel;

            // ARTICULATED CONSIST (trains): place each car at its OWN arc-length (offset from the consist centre)
            // with the LOCAL track heading there, so the train bends around a curve. Rigid in Y (the deck/skyway
            // altitude is baked into the car geometry) and never warped (the viaduct is noWarp — they stay glued).
            if (mv.segments) {
                for (const seg of mv.segments) {
                    const tk = Math.max(0, Math.min(1, mv.t + seg.offset / mv.len));
                    const P = this._moverPosAt(mv, tk);
                    for (const m of seg.meshes) m.setPoseXYZYaw(P.px, sp.baseY, P.pz, P.yaw);
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
            if (mv.faceYaw != null) yaw = mv.faceYaw;
            // SMOOTH TURN: ease the heading toward the route heading (wrapped to the shortest arc) — every frame (state).
            if (yaw != null) this._easeYaw(mv, yaw, dt * (sp.kind === 'walker' ? 5 : 8));
            // T7.3 pose gate: hidden / off-screen / far-throttled movers skip the terrain + warp sampling and the write.
            // (sim LOD: the band schedule decides instead.)
            if (lod) this._lodPose = this._lodLegacyDue(mv, i, px, pz, s, lod, time);
            const pdt = this._poseGate(mv, i, dt);
            if (pdt < 0) continue;

            // Height: clouds keep their altitude; trains keep their deck/skyway; FALL movers (rain/snow/petals)
            // cycle downward and wrap (speed = fall rate, sway = lateral flutter); boats ride the canal water;
            // ground movers ride the terrain — and over a sunken canal cell they ARC OVER THE BRIDGE.
            let y = 0;
            if (sp.kind === 'holo') {
                y = Math.sin(time * 1.4 + sp.t0 * 6.283) * 0.05 * s;   // lazy vertical swim bob (fish, soaring birds)
            } else if (sp.kind === 'rain') {
                const range = sp.fallRange ?? 1.7 * s;   // fall from cloud height, wrap back to the top
                y = range - ((time * sp.speed + sp.t0 * range) % range) - 0.32 * range;
                if (sp.sway) { const sw = Math.sin(time * 0.9 + sp.t0 * 6.283) * sp.sway; px += sw; pz += sw * 0.6; }
            } else if (sp.kind === 'boat') {
                y = this.w._smoothFn(px, pz) + Math.sin(time * 0.8 + sp.t0 * 6.283) * 0.003 * s;   // water line + gentle bob
            } else if (sp.kind !== 'cloud' && sp.kind !== 'train') {
                y = this._groundY(px, pz, Math.abs(sp.b[0] - sp.a[0]) >= Math.abs(sp.b[1] - sp.a[1]), s);
            }
            // Domain warp LAST — heights + all layout logic sampled unwarped, then the position curves with the roads.
            let wx = 0, wz = 0;
            if (sp.kind !== 'cloud' && sp.kind !== 'rain' && sp.kind !== 'train') { this.w._warpInto(px, pz, this.w._warpScratch); wx = this.w._warpScratch[0]; wz = this.w._warpScratch[1]; }
            this._place(mv, px + wx, sp.baseY + y, pz + wz, mv.yaw ?? yaw, pdt, speed, s);
        }
        // Repack instance matrices + draw this frame (otherwise movers only "jump" when an interaction forces it).
        this.w.scene3d.notifyMeshTransformsChanged3D();
        // Something went hidden -> shown this tick (a chat emote, a walker back out of a door, a headlight pool):
        // the host render list must be re-filtered or the shown mesh stays undrawn (see notifyVisibilityChanged3D).
        if (this._shownAny) { this._shownAny = false; this.w.scene3d.notifyVisibilityChanged3D?.(); }
    }

    /** T7.3 — should this mover's meshes be re-posed THIS frame? Accumulates `dt` into `mv.placeDt` and returns the
     *  dt to pose with (the time since its last pose), or -1 to skip. Skips: LOD / centre-hidden meshes (nobody sees
     *  them — posed on a slow cadence so they're current when re-shown), OFF-SCREEN movers (the last posed position,
     *  ≤ 8 frames stale, is tested with a wide NDC margin, so a mover walking in is posed before it's visible) and
     *  distance-throttled far movers (see moverPoseInterval). dt = 0 (spawn / placement pass) always poses. */
    private _poseGate(mv: MoverRec, i: number, dt: number): number {
        const acc = (mv.placeDt ?? 0) + dt;
        if (this._lod && dt !== 0) {   // SIM LOD: the caller's band schedule (`_lodPose`) decides
            if (!this._lodPose) { mv.placeDt = acc; return -1; }
            mv.placeDt = 0; return acc;
        }
        if (dt === 0 || !this.poseGate || !this._gateVP || !this._gateCam) { mv.placeDt = 0; return acc; }
        const m0 = mv.body[0] ?? mv.meshes[0];
        if (!m0) { mv.placeDt = 0; return acc; }
        const f = this._gateFrame + i;   // stagger by mover index → the work spreads evenly over frames
        const parentVis = (m0 as unknown as { parent?: { visible?: boolean } }).parent?.visible !== false;
        // (2026-10-01: + movers whose every mesh the fog horizon culls (past the fog's Far: on screen but not drawn), so
        // the slow cadence too. Safe: a mover coming back passes through the fade band from coverage 0, so a pose up to
        // 8 frames old is never seen. Not the distance-LOD-hidden ones: they reappear at full opacity, a stale pose
        // would jump. The loop exits at the first drawn mesh, normally the first one.)
        let undrawn = m0.fogHidden;
        if (undrawn) for (const m of mv.meshes) if (!m.fogHidden && (m.name ?? '') !== 'world:traffic-emote') { undrawn = false; break; }
        if (!m0.visible || !parentVis || undrawn) {
            if (f % 8 !== 0) { mv.placeDt = acc; return -1; }
            mv.placeDt = 0; return acc;
        }
        const wm = m0.localMatrix as unknown as Float32Array;   // last posed WORLD position (combined parent chain)
        const x = wm[12], y = wm[13], z = wm[14];
        if (!pointInView(this._gateVP, x, y, z, 1.35)) {
            if (f % 8 !== 0) { mv.placeDt = acc; return -1; }
            mv.placeDt = 0; return acc;
        }
        const c = this._gateCam;
        const every = moverPoseInterval(Math.hypot(x - c[0], y - c[1], z - c[2]), this._gateR, mv.spec.kind);
        if (every > 1 && f % every !== 0) { mv.placeDt = acc; return -1; }
        mv.placeDt = 0;
        return acc;
    }

    /** Terrain height under a ground mover — and over a sunken canal cell, the BRIDGE DECK surface (E12/S13).
     *  The deck's own height rule (bridge-deck.ts: carriageway at road height, footways kerb-raised, ramped between
     *  banks on different levels) + the smooth field it drapes on — so a walker on the deck's footway walks ON it.
     *  (It was a per-cell arc 18 cm up at level 0: it matched neither the deck span nor a raised bank, so walkers
     *  sank into or floated over the deck and dropped at the abutments.) */
    private _groundY(px: number, pz: number, _horiz: boolean, _s: number): number {
        const graph = this.w._graph!;
        if (cellLevelAt(graph, px, pz) < 0) {
            const deck = bridgeSurfaceAt(graph, px, pz);
            if (deck !== null) return this.w._smoothFn(px, pz) + deck;
        }
        const h = this.w._heightFn(px, pz);
        return this.xing.T ? crossingSurfaceY(this.xing.T, px, pz, h) : h;   // (R3.2) over a level crossing's board table
    }

    /** Set a mover mesh's visibility, noting a hidden -> shown flip (the host render list needs a re-filter). */
    private _shownAny = false;
    private _show(m: Mesh3D, on: boolean): void {
        if (on && !m.visible) this._shownAny = true;
        m.visible = on;
    }

    private _easeYaw(mv: MoverRec, yaw: number, k: number): void {
        if (mv.yaw == null) { mv.yaw = yaw; return; }
        let d = yaw - mv.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        mv.yaw += d * Math.min(1, k);
    }

    /** Write one mover's transform to its meshes: body meshes at the base, THIGH meshes at their hip pivots (rotated by
     *  the yaw into the mover frame) swinging about local Z, SHINS hung at each thigh's knee and bent by the gait's
     *  knee curve, free ARMS (+ hands) at the shoulders. Also advances the gait phase; the walking bob is the body
     *  sinking so the lower foot stays on the ground (legs with a knee), else a fixed bounce. */
    private _place(mv: MoverRec, x: number, y: number, z: number, yaw: number | null, dt: number, speed: number, s: number): void {
        const sp = mv.spec, g = sp.gait, k = sp.scale ?? 1;
        let bob = 0, swing = 0;
        const kn = g?.knee, th = this._legTh, kf = this._legKf;
        th[0] = th[1] = kf[0] = kf[1] = 0;
        if (g && sp.speed > 0) {
            const moving = Math.min(1, speed / (sp.speed * 0.5));
            mv.phase += (speed * dt) / Math.max(1e-6, g.stride) * Math.PI;
            swing = g.amp * Math.sin(mv.phase) * moving;
            if (kn) {
                // per-leg phase (hip angle = amp·sin φ; the left leg runs half a cycle behind), knee flex from it
                for (let i = 0; i < 2; i++) {
                    const ph = mv.phase + (i === 0 ? Math.PI : 0);
                    th[i] = (i === 0 ? -1 : 1) * swing;
                    kf[i] = kn.pedal ? kn.flex * (0.55 + 0.45 * Math.sin(ph)) : kn.flex * kneeFlexCurve(ph) * moving;
                }
                if (!kn.pedal) bob = walkerSink(kn, th[0], kf[0], th[1], kf[1]) * k;
            } else bob = Math.abs(Math.cos(mv.phase)) * 0.0022 * s * moving;
        } else if (sp.kind === 'walker' && speed > 0) {
            bob = Math.abs(Math.sin(this.w._simTime * 9 + sp.t0 * 6.283)) * 0.003 * s;   // legless walkers (robots) bounce
        }
        const yw = yaw ?? 0, cy = Math.cos(yw), sy = Math.sin(yw);
        // HIP SWAY: a walking body shifts ~1 cm over the stance foot each step (the whole walker — legs, arms and body
        // together — so no joint drifts): lateral = mover-local Z, which rotateY maps to (sin θ, cos θ).
        if (g && kn && !kn.pedal && sp.speed > 0) {
            const sw = g.pivotZ * k * 0.13 * Math.sin(mv.phase) * Math.min(1, speed / (sp.speed * 0.5));
            x += sy * sw; z += cy * sw;
        }
        // ★ T7.3: ONE matrix rebuild per mesh (setPoseXYZYaw) — rotationY / rotation / setXYZ were separate
        // rebuilds (each + a bounds refresh), ~3× the per-frame transform cost across ~1.5k mover meshes.
        for (const m of (mv.legs && g ? mv.body : mv.meshes)) {
            m.setPoseXYZYaw(x, y + bob, z, yaw ?? m.rotationY);
        }
        if (mv.legs && g) {
            for (const L of mv.legs) {
                // Mover-local (0, pivotY, side·pivotZ) → world: rotateY maps local Z to (sin θ, cos θ).
                const lz = L.side * g.pivotZ * k;
                // opposite legs swing opposite ways (local Z = the hip axis)
                L.mesh.setPoseXYZYaw(x + sy * lz, y + bob + g.pivotY * k, z + cy * lz, yaw ?? L.mesh.rotationY, L.side * swing);
            }
            // SHINS (+ shoes) hang at the swung thigh's knee: knee = hip + R(θ)·(kx, ky); local X maps to (cos θ, −sin θ).
            if (mv.shins && kn) for (const S of mv.shins) {
                const i = S.side < 0 ? 0 : 1, a = th[i], ca = Math.cos(a), sa = Math.sin(a);
                const kx = (kn.x * ca - kn.y * sa) * k, ky = (kn.x * sa + kn.y * ca) * k, lz = S.side * g.pivotZ * k;
                S.mesh.setPoseXYZYaw(x + cy * kx + sy * lz, y + bob + g.pivotY * k + ky, z - sy * kx + cy * lz, yaw ?? S.mesh.rotationY, a - kf[i]);
            }
            // Free ARMS swing about the shoulder, opposite their same-side leg (left arm forward with the right leg).
            const ga = g.arm;
            if (mv.arms && ga) for (const A of mv.arms) {
                const az = A.side * ga.z * k;
                A.mesh.setPoseXYZYaw(x + sy * az, y + bob + ga.y * k, z + cy * az, yaw ?? A.mesh.rotationY, -A.side * swing * ga.amp);
            }
        }
        if (sp.kind === 'car' && mv.agent) {
            const f = Math.max(0.001, mv.agent.fade);
            if (Math.abs(f - mv.scale) > 1e-4) { mv.scale = f; for (const m of mv.meshes) m.setScale3D(f, f, f); }
        }
    }

    /** One ROUTED mover (car / walker over the road graph) for one frame. */
    private _tickAgent(mv: MoverRec, i: number, dt: number, pose: Float32Array, s: number): void {
        const a = mv.agent!, sp = mv.spec, net = this._net!, time = this.w._simTime;
        let target = time < mv.pausedUntil ? 0 : sp.speed;
        // Car following: the bumper gap to whatever is ahead in the lane (a car, the Play player) + its speed.
        let fGap = Infinity, fVel = 0, fBind = false, lineD = Infinity;

        if (a.mode === 'walk') {
            // A gated leg (a zebra / a turn-round beat) holds at gateS until the green man (or the beat) comes.
            if (a.waiting && a.s >= a.leg.gateS - 1e-6) {
                if (gateOpen(net, a.leg.gate, a.waited, time, this.timing)) { a.waiting = false; a.waited = 0; }
                else { a.waited += dt; target = 0; a.s = Math.min(a.s, a.leg.gateS + 1e-6); }   // (just past gateS → faces the crossing)
            } else if (a.waiting) target = Math.min(target, Math.max(0.3 * sp.speed, (a.leg.gateS - a.s) * 4));
            // R3.2: a CLOSED level crossing ahead — wait outside the barrier.
            if (this.xing.T) { const xd = this.xing.holdDist(mv.cx, mv.cz, mv.hx, mv.hz, 0, true); if (xd < 0.25 * s) target = xd < 0.003 * s ? 0 : Math.min(target, Math.max(0.2 * sp.speed, xd * 4)); }
        } else {
            // Dead-end FADE (the only time a car changes size): shrink away at the border, re-enter elsewhere.
            if (a.fading === -1) {
                target = 0;
                a.fade = Math.max(0, a.fade - dt * 1.8);
                if (a.fade <= 0) this._respawnCar(mv, i, pose, s);
            } else if (a.fading === 1) {
                a.fade = Math.min(1, a.fade + dt * 1.8);
                if (a.fade >= 1) a.fading = 0;
            }
            if (target > 0 && this._carBlocked(mv, i, pose, s)) target = 0;
            // RED LIGHT: brake smoothly onto the stop line (front bumper behind the zebra). A car the amber caught too
            // close to stop is COMMITTED for this leg — it clears the junction instead of braking in the box.
            const hold = a.through ? -1 : carHoldAt(net, a.leg, a.s, a.halfLen, mv.vel, time, this.timing, sp.speed * 3.2);
            if (hold === -2) a.through = true;
            if (hold >= 0) target = hold - a.s < 0.004 * s ? 0 : Math.min(target, Math.max(0.05 * sp.speed, (hold - a.s) * 2.2));
            // R3.2: a CLOSED level crossing ahead — brake onto its stop line (like a red light).
            if (this.xing.T && a.fading === 0) { const xd = (this._exitI = i, this._exitPose = pose, this.xing.holdDist(mv.cx, mv.cz, mv.hx, mv.hz, a.halfLen, false, this._exitBlocked)); if (xd < 0.4 * s) target = xd < 0.004 * s ? 0 : Math.min(target, Math.max(0.05 * sp.speed, xd * 2.2)); }
            // STOP SIGN (arriving from a T's stem): full stop, a beat, then go.
            if (a.leg.stopKind === 'sign' && !a.signDone) {
                // (under the right-of-way model: at its yield line, which is never in front of the sign's line)
                const stopAt = this._jOn && this._jCtl(net.edges[a.leg.edge].to) ? this._yieldS(a) : a.leg.stopS - a.halfLen;
                if (a.s >= stopAt - 0.004 * s) { target = 0; a.hold += dt; if (a.hold > 0.9 && mv.vel < 0.02 * sp.speed) a.signDone = true; }
                else target = Math.min(target, Math.max(0.05 * sp.speed, (stopAt - a.s) * 2.2));
            }
            // BUS STOPS: pull in for a moment at the plan's stops on this side of the road.
            if (a.bus && target > 0 && time >= mv.cooldownUntil && a.s >= a.leg.sStart) {
                const e = net.edges[a.leg.edge], along = this._alongOnRoad(a, e), stops = this._busStops.get(e.ri + '|' + (e.forward ? -1 : 1));
                if (stops) for (const st of stops) if (Math.abs(along - st) < 0.012 * s) { mv.pausedUntil = time + 2.4; mv.cooldownUntil = time + 9; target = 0; break; }
            }
            // CAR FOLLOWING (Gipps safe speed): never faster than lets this car stop behind its leader — the car ahead
            // in its lane, through the junction onto its next edge, or the Play player in its lane corridor — even if
            // the leader brakes hard. A queue at a red light / behind the player builds car by car.
            if (this.follow.on && a.fading !== -1) {
                this._leaderGap(mv, i, s);
                fGap = this._fg; fVel = this._fv;
                if (fGap < Infinity) {
                    const F = this.follow, M = s / 15, b = sp.speed * F.brakeK, T = F.headwayS, g = Math.max(0, fGap - F.jamGapM * M);
                    const vSafe = Math.max(0, -b * T + Math.sqrt(b * b * T * T + fVel * fVel + 2 * b * g));
                    if (vSafe < target) { target = vSafe; fBind = true; }
                }
            }
            // RIGHT-OF-WAY: no entry grant for the unsignalled junction ahead → brake onto its yield line (front bumper
            // behind the mouth, so a car turning through the box never sweeps into this one) and wait there.
            if (this._jOn && a.fading !== -1 && !(a.gFor === a.leg && (a.gNode ?? -1) >= 0) && this._jCtl(net.edges[a.leg.edge].to) && this._peekLeg(a)) {
                lineD = this._yieldS(a) - a.s;
                const vL = lineD <= 0.004 * s ? 0 : Math.sqrt(2 * sp.speed * this.follow.brakeK * lineD);
                if (vL < target) { target = vL; fBind = true; }
            }
        }

        // ACCELERATE / DECELERATE (cars brake harder than they accelerate; walkers start and stop quickly).
        const accel = sp.speed * (a.mode === 'car' ? 1.6 : 2.5) * dt;
        let decel = sp.speed * (a.mode === 'car' ? this.follow.brakeK : 4) * dt;
        // EMERGENCY BRAKE: a leader inside the comfortable braking distance (a cut-in, a car appearing round the corner,
        // the player stepping out) → brake up to the emergency cap.
        if (fBind && mv.vel - target > decel) decel = Math.min(mv.vel - target, sp.speed * this.follow.emergencyK * dt);
        mv.vel = target > mv.vel ? Math.min(target, mv.vel + accel) : Math.max(target, mv.vel - decel);
        let adv = mv.vel * dt;
        // HARD CLAMP: whatever the braking managed, the front bumper never comes closer than hardGap to the leader
        // (no overlap, ever). The clamped car takes the leader's speed.
        if (fGap < Infinity) {
            const room = Math.max(0, fGap - this.follow.hardGapM * (s / 15));
            if (adv > room) { adv = room; mv.vel = Math.min(mv.vel, fVel); }
        }
        // (an ungranted car never crosses its yield line)
        if (adv > lineD) { adv = Math.max(0, lineD); mv.vel = 0; }
        a.s += adv;

        // Leg transitions (route choice at the junction).
        for (let guard = 0; guard < 4 && a.s >= a.leg.total; guard++) {
            const over = a.s - a.leg.total;
            if (a.mode === 'car') {
                if (a.fading === -1) { a.s = a.leg.total; break; }
                // (the peeked next leg — car following looked through the junction — is exactly this choice)
                const peeked = a.nxFor === a.leg;
                const nx = peeked ? (a.nx! < 0 ? null : a.nx!) : carNext(net, a.leg.edge, a.id, a.visit + 1, a.bus);
                a.visit++;
                if (nx === null) { a.s = a.leg.total; a.fading = -1; break; }
                // Into a junction box: clearing it until the tail is off the curve (others' grants respect it).
                const fromE = a.leg.edge, node = net.edges[fromE].to;
                if (this._jCtl(node)) { a.bNode = node; a.bIn = fromE; a.bOut = nx; } else a.bNode = -1;
                a.gNode = -1; a.gFor = null;
                a.leg = peeked && a.nxLeg ? a.nxLeg : carLeg(net, nx, a.leg.edge); a.s = over; a.signDone = false; a.hold = 0; a.through = false;
            } else {
                a.leg = walkNext(net, a.leg, a.id, ++a.visit, sp.speed);
                if (a.leg.gate) { a.waiting = true; a.waited = 0; if (a.leg.gateS <= 1e-6) { a.s = 0; mv.vel = 0; break; } }
                a.s = Math.min(over, a.leg.gate ? a.leg.gateS : over);
            }
        }

        legPoint(a.leg, a.s, LP);
        let px = LP.x, pz = LP.z;
        const hx = LP.hx, hz = LP.hz;
        // PARKED-CAR SWERVE: on the straight, ease toward the centreline while passing a parked car / roadworks.
        if (a.mode === 'car') {
            // Only on the straight, and tucked back into the lane before the next junction (a shift carried into the
            // turn would swing round with the heading).
            const onStraight = a.s >= a.leg.sStart && a.leg.total - a.s > 0.3 * s;
            const want = onStraight && this._obstacleAhead(a, s) ? Math.min(0.075 * s, net.lane * 0.9) : 0;
            a.shift += (want - a.shift) * Math.min(1, dt * (want > a.shift ? 2.6 : 3.5));
            if (a.shift > 1e-5) { px -= hz * a.shift; pz += hx * a.shift; }   // toward the centreline = +R(heading) (we drive on the left)
        }
        mv.cx = px; mv.cz = pz; mv.hx = hx; mv.hz = hz;
        mv.t = a.leg.total > 0 ? a.s / a.leg.total : 0;

        // Face the route (a waiting walker faces its crossing — the leg starts with it); chats / browsing face the partner.
        const yaw = mv.faceYaw ?? Math.atan2(-hz, hx);
        this._easeYaw(mv, yaw, dt * (a.mode === 'walk' ? 6 : 8));
        // T7.3 pose gate (after the sim + heading state, before the terrain/warp sampling and the transform write).
        const pdt = this._poseGate(mv, i, dt);
        if (pdt < 0) return;
        const y = this._groundY(px, pz, Math.abs(hx) >= Math.abs(hz), s);
        this.w._warpInto(px, pz, this.w._warpScratch);
        const wx = this.w._warpScratch[0], wz = this.w._warpScratch[1];
        this._place(mv, px + wx, sp.baseY + y, pz + wz, mv.yaw, pdt, mv.vel, s);
    }

    /** (R3.2) "Is the lane beyond this level crossing blocked by a slow car?" for car `_exitI` — a car only enters a
     *  crossing when it can clear it (the exit-box rule). One persistent callback (no per-frame closures). */
    private _exitI = 0;
    private _exitPose: Float32Array = new Float32Array(0);
    private readonly _exitBlocked = (q: { x: number; z: number; d: [number, number]; t: [number, number]; roadHalf: number }, sign: number, u0: number, u1: number): boolean => {
        const F = this._xf, i = this._exitI, pose = this._exitPose, hx = pose[i * 4 + 2], hz = pose[i * 4 + 3];
        for (let j = 0; j < this.movers.length; j++) {
            if (j === i) continue;
            const o = this.movers[j];
            if (o.spec.kind !== 'car' || !o.agent || o.visiting) continue;
            if (o.vel > o.spec.speed * 0.35) continue;
            if (pose[j * 4 + 2] * hx + pose[j * 4 + 3] * hz < 0.7) continue;   // same direction
            crossingFrame(q as never, pose[j * 4], pose[j * 4 + 1], F);
            if (Math.abs(F.w) > q.roadHalf || F.u * sign <= 0) continue;
            const au = Math.abs(F.u);
            if (au >= u0 - o.agent.halfLen && au <= u1) return true;
        }
        return false;
    };
    private readonly _xf = { u: 0, w: 0 };

    /** Per tick: the LANE ORDER — every live car bucketed by its leg's directed edge (counting sort), each bucket
     *  sorted by `rem` = distance left to the edge's end (front car first). Legs onto one edge share its straight run
     *  and end point, so `rem` orders cars from different approaches consistently (a merge zips). Frozen (sim-LOD
     *  fog) and visiting movers are left out, like the blocker scan. */
    private _buildLanes(pose: Float32Array): void {
        const net = this._net;
        this._laneOn = false;
        if (!net || !this.follow.on) return;
        const M = this.movers, n = M.length, E = net.edges.length;
        if (this._laneStart.length < E + 1) { this._laneStart = new Int32Array(E + 1); this._laneFill = new Int32Array(E + 1); }
        if (this._laneItems.length < n) {
            this._laneItems = new Int32Array(n); this._laneEdge = new Int32Array(n);
            this._laneRem = new Float64Array(n); this._laneVel = new Float64Array(n);
        }
        const start = this._laneStart, fill = this._laneFill, items = this._laneItems, edgeOf = this._laneEdge, rem = this._laneRem, vel = this._laneVel;
        start.fill(0, 0, E + 1);
        let k = 0;
        for (let j = 0; j < n; j++) {
            const mv = M[j], a = mv.agent;
            if (!a || a.mode !== 'car' || mv.visiting || !(pose[j * 4] === pose[j * 4])) { edgeOf[j] = -1; continue; }
            edgeOf[j] = a.leg.edge; rem[j] = a.leg.total - a.s; vel[j] = mv.vel; start[a.leg.edge + 1]++; k++;
        }
        if (k === 0) return;
        for (let e = 0; e < E; e++) start[e + 1] += start[e];
        fill.set(start.subarray(0, E));
        for (let j = 0; j < n; j++) { const e = edgeOf[j]; if (e >= 0) items[fill[e]++] = j; }
        // Insertion sort per bucket (rem ascending; ties by index — deterministic). Buckets hold a handful of cars.
        for (let e = 0; e < E; e++) {
            const b0 = start[e], b1 = start[e + 1];
            for (let q = b0 + 1; q < b1; q++) {
                const j = items[q], r = rem[j];
                let w = q - 1;
                while (w >= b0 && (rem[items[w]] > r || (rem[items[w]] === r && items[w] > j))) { items[w + 1] = items[w]; w--; }
                items[w + 1] = j;
            }
        }
        this._laneOn = true;
    }

    /** Per tick: the Play player's feet (scene3d.playerFeet3D, world space) → city-local + unwarped, as a lane
     *  obstacle. Absent outside Play → off. */
    private _readPlayer(s: number): void {
        const P = this._pl;
        P.on = false;
        if (!this.follow.on || !this.follow.playerYield) return;
        const pf = (this.w.scene3d as unknown as { playerFeet3D?: { x: number; y: number; z: number; groundY?: number } | null }).playerFeet3D;
        if (!pf) return;
        // HEIGHT: the ground under the player (groundY — stable through a jump; else the feet) against the road a car
        // would drive on at that spot. A player on a footbridge / overpass above the lane is no obstacle.
        const fy = Number.isFinite(pf.groundY) ? pf.groundY! : pf.y;
        let x = pf.x, z = pf.z, y = fy;
        const m = this.w.cityRoot?.localMatrix as unknown as Float32Array | undefined;
        if (m) {   // inverse of the city container's (rotation · scale + translation) matrix — orthogonal columns
            const tx = pf.x - m[12], ty = fy - m[13], tz = pf.z - m[14];
            const k0 = 1 / Math.max(1e-12, m[0] * m[0] + m[1] * m[1] + m[2] * m[2]), k1 = 1 / Math.max(1e-12, m[4] * m[4] + m[5] * m[5] + m[6] * m[6]);
            const k2 = 1 / Math.max(1e-12, m[8] * m[8] + m[9] * m[9] + m[10] * m[10]);
            x = (m[0] * tx + m[1] * ty + m[2] * tz) * k0; y = (m[4] * tx + m[5] * ty + m[6] * tz) * k1; z = (m[8] * tx + m[9] * ty + m[10] * tz) * k2;
        }
        // Rendered (warped) → layout space: the one-step inverse of the domain warp (as hoverLandmarkAtScreen).
        this.w._warpInto(x, z, this.w._warpScratch);
        P.x = x - this.w._warpScratch[0]; P.z = z - this.w._warpScratch[1];
        if (Number.isFinite(y) && Math.abs(y - this._groundY(P.x, P.z, true, s)) > this.follow.playerHeightM * (s / 15)) return;
        P.r = this.follow.playerRadiusM * (s / 15);
        P.on = true;
    }

    // ── RIGHT-OF-WAY at unsignalled junctions ────────────────────────────────────────────────────────────────────
    // A car may enter the box of an unsignalled junction (≥ 3 arms) only with a GRANT. Per tick, per junction, the
    // CANDIDATES are the heads of its approach queues within braking reach; they are ranked (overdue first, lowest id
    // first · then main-road before stem traffic at a T · then first come · then id) and granted in that order when
    // their path through the box conflicts with no car COMMITTED there (granted, or still clearing the box) and with
    // no higher-ranked candidate still waiting, and their exit has room (don't block the box). An ungranted car waits
    // with its front bumper behind the mouth (pulled back where a turning car's swept body reaches). Movement
    // conflicts are swept car axes closer than boxClearM (cached per movement pair). O(cars + approach edges) a tick.
    private _jOn = false;
    private _jNet: RoadNet | null = null;
    private _jHl = 0;
    private _jStamp = 0;
    private _jNodeStamp = new Int32Array(0);
    private _jComHead = new Int32Array(0);
    private _jCandHead = new Int32Array(0);
    private _jActive = new Int32Array(0);
    private _jeCar = new Int32Array(0);
    private _jeIn = new Int32Array(0);
    private _jeOut = new Int32Array(0);
    private _jeHq = new Int32Array(0);
    private _jeNext = new Int32Array(0);
    private _jcNext = new Int32Array(0);
    private _jOrder: number[] = [];
    private _jWait: number[] = [];
    private _jBack = new Float64Array(0);
    private readonly _jSweep = new Map<number, Float64Array>();
    private readonly _jConf = new Map<number, Map<number, boolean>>();
    /** Diagnostics: grants given out of the normal order (a candidate overdue past maxWaitS). */
    junctionOverdue = 0;

    /** Is node `n` an unsignalled junction (or a bend) under the right-of-way model? */
    private _jCtl(n: number): boolean {
        return this._jCars[n] >= 2;
    }
    /** Per node: its number of car arms when it has a junction box (≥ 3 arms, or a bend) and no signals, else 0. */
    private _jCars = new Uint8Array(0);
    /** Reset the per-net caches (a new net / fleet). */
    private _jEnsure(net: RoadNet): void {
        if (this._jNet === net) return;
        this._jNet = net;
        this._jSweep.clear(); this._jConf.clear();
        this._jBack = new Float64Array(net.edges.length).fill(NaN);
        this._jNodeStamp = new Int32Array(net.nodes.length); this._jStamp = 0;
        this._jComHead = new Int32Array(net.nodes.length); this._jCandHead = new Int32Array(net.nodes.length);
        this._jActive = new Int32Array(net.nodes.length);
        this._jCars = new Uint8Array(net.nodes.length);
        this._jExtra = new Float64Array(net.edges.length); this._jExtraSt = new Int32Array(net.edges.length);
        net.nodes.forEach((N, k) => {
            const A = N.arms, box = A.length >= 3 || (A.length === 2 && A[0][0] * A[1][0] + A[0][1] * A[1][1] >= -0.985);   // (as carMouth)
            if (!N.signal && box) this._jCars[k] = Math.min(255, N.out.filter(o => net.edges[o].car).length);
        });
        let hl = 0; for (const mv of this.movers) if (mv.agent?.mode === 'car' && !mv.agent.bus) hl = Math.max(hl, mv.agent.halfLen);
        this._jHl = this._jQ(hl || 0.15 * net.s);
    }
    /** A half-length quantized UP to 0.25 m steps (the sweep cache key). */
    private _jQ(hl: number): number { return Math.max(1, Math.ceil(hl / (0.25 * this._net!.s / 15) - 1e-6)); }
    /** The swept car AXES of movement in → out through the box for a car of quantized half-length `hq` (x0, z0, x1, z1
     *  per sample): the centre runs from one half-length before the mouth to one past the curve's end, the axis ± the
     *  half-length along the path heading (a rigid body: on a tight curve its ends swing out along the tangent). */
    private _sweep(inE: number, outE: number, hq: number): Float64Array {
        const net = this._net!, key = (inE * net.edges.length + outE) * 128 + Math.min(127, hq);
        let sw = this._jSweep.get(key);
        if (sw) return sw;
        const leg = carLeg(net, outE, inE), hl = hq * 0.25 * net.s / 15, step = 0.5 * net.s / 15, d = net.edges[inE].d, P0 = leg.pts[0];
        const n = Math.max(2, Math.ceil((leg.sStart + 2 * hl) / step) + 1);
        sw = new Float64Array(n * 4);
        for (let k = 0; k < n; k++) {
            const t = -hl + (leg.sStart + 2 * hl) * (k / (n - 1));
            let cx: number, cz: number, hx: number, hz: number;
            if (t < 0) { cx = P0[0] + d[0] * t; cz = P0[1] + d[1] * t; hx = d[0]; hz = d[1]; }
            else { legPoint(leg, t, LP); cx = LP.x; cz = LP.z; hx = LP.hx; hz = LP.hz; }
            sw[k * 4] = cx - hx * hl; sw[k * 4 + 1] = cz - hz * hl; sw[k * 4 + 2] = cx + hx * hl; sw[k * 4 + 3] = cz + hz * hl;
        }
        this._jSweep.set(key, sw);
        return sw;
    }
    /** Do movements (i1 → o1, car half-length h1) and (i2 → o2, h2) through one box conflict? (Same approach lane =
     *  a queue: never.) */
    private _jConflict(i1: number, o1: number, h1: number, i2: number, o2: number, h2: number): boolean {
        if (i1 === i2) return false;
        const E = this._net!.edges.length, a = (i1 * E + o1) * 128 + Math.min(127, h1), b = (i2 * E + o2) * 128 + Math.min(127, h2);
        const k0 = Math.min(a, b), k1 = Math.max(a, b);
        let row = this._jConf.get(k0);
        if (!row) { row = new Map(); this._jConf.set(k0, row); }
        let c = row.get(k1);
        if (c !== undefined) return c;
        const A = this._sweep(i1, o1, h1), B = this._sweep(i2, o2, h2), lim = this.follow.boxClearM * (this._net!.s / 15);
        c = false;
        for (let p = 0; p < A.length && !c; p += 4) for (let q = 0; q < B.length; q += 4) {
            if (segSegDist(A[p], A[p + 1], A[p + 2], A[p + 3], B[q], B[q + 1], B[q + 2], B[q + 3]) < lim) { c = true; break; }
        }
        row.set(k1, c);
        return c;
    }
    /** How far behind its mouth a car on approach edge `e` waits (front bumper, world units): yieldBackM, or more if
     *  an ordinary car's swept body on any movement not from `e` needs it further back (see _jIntrude). Cached. */
    private _jBackOf(e: number): number {
        let b = this._jBack[e];
        if (b === b) return b;
        const net = this._net!, node = net.nodes[net.edges[e].to], M = net.s / 15;
        let intr = 0;
        for (const o of node.out) {
            if (!net.edges[o].car) continue;
            for (const i2 of node.out) {
                const in2 = net.edges[i2].rev;
                if (in2 === e || !net.edges[in2].car || o === i2) continue;   // (o === i2: a U-turn back out its own arm)
                // (an ordinary car's sweep: a longer car's ends swing wider — _jIntrude holds the approaches it reaches)
                intr = Math.max(intr, this._jIntrude(e, in2, o, this._jHl));
            }
        }
        b = Math.max(this.follow.yieldBackM * M, intr);
        this._jBack[e] = b;
        return b;
    }
    /** How far behind approach `e`'s mouth a waiting car's FRONT must stay so that the swept axes of movement in2 → o
     *  (a car of quantized half-length `hq`) keep boxClearM from its axis — car bodies as capsules round their axes —
     *  + 0.1 m (0 = never near). Cached per sweep. */
    private _jIntrude(e: number, in2: number, o: number, hq: number): number {
        const sw = this._sweep(in2, o, hq);
        let row = this._jIntr.get(sw);
        if (!row) { row = new Map(); this._jIntr.set(sw, row); }
        let r = row.get(e);
        if (r !== undefined) return r;
        const net = this._net!, M = net.s / 15, lim = this.follow.boxClearM * M, d = net.edges[e].d;
        const Q = carLeg(net, e, null).pts, q = Q[Q.length - 1];
        let intr = 0;
        for (let k = 0; k < sw.length; k += 4) for (let u = 0; u <= 4; u++) {
            const px = sw[k] + (sw[k + 2] - sw[k]) * u / 4, pz = sw[k + 1] + (sw[k + 3] - sw[k + 1]) * u / 4;
            const along = (q[0] - px) * d[0] + (q[1] - pz) * d[1], lat = Math.abs((px - q[0]) * d[1] - (pz - q[1]) * d[0]);
            if (lat < lim) { const need = along + Math.sqrt(lim * lim - lat * lat); if (need > intr) intr = need; }
        }
        r = intr > 0 ? intr + 0.1 * M : 0;
        row.set(e, r);
        return r;
    }
    private readonly _jIntr = new WeakMap<Float64Array, Map<number, number>>();
    /** Per tick: extra wait-back per approach edge while a LONG car (a bus) committed in the box sweeps into it. */
    private _jExtra = new Float64Array(0);
    private _jExtraSt = new Int32Array(0);
    /** The leg distance where car `a`'s CENTRE waits for its grant (its stop sign's line if that is further back). */
    private _yieldS(a: RouteAgent): number {
        const e = a.leg.edge, ex = this._jExtraSt[e] === this._jStamp ? this._jExtra[e] : 0;
        let y = a.leg.total - Math.max(this._jBackOf(e), ex) - a.halfLen;
        if (a.leg.stopKind === 'sign') y = Math.min(y, a.leg.stopS - a.halfLen);
        return Math.max(Math.min(a.s, a.leg.sStart), y);   // (never behind where it already is on its curve)
    }

    /** Per tick: hand out the junction-entry grants (see the section comment). */
    private _junctions(time: number, s: number): void {
        this._jOn = false;
        const net = this._net, F = this.follow;
        if (!net || !F.on || !F.junctionYield || !this._laneOn) return;
        this._jEnsure(net);
        this._jOn = true;
        const Mv = this.movers, n = Mv.length, M = s / 15;
        if (this._jcNext.length < n) { this._jcNext = new Int32Array(n); this._jeCar = new Int32Array(2 * n); this._jeIn = new Int32Array(2 * n); this._jeOut = new Int32Array(2 * n); this._jeHq = new Int32Array(2 * n); this._jeNext = new Int32Array(2 * n); }
        const stamp = ++this._jStamp, nst = this._jNodeStamp, com = this._jComHead, cand = this._jCandHead, act = this._jActive;
        const touch = (node: number): void => { if (nst[node] !== stamp) { nst[node] = stamp; com[node] = -1; cand[node] = -1; } };
        const edgeOf = this._laneEdge, st = this._laneStart, it = this._laneItems, rem = this._laneRem, vel = this._laneVel;
        let ne = 0;
        const commit = (node: number, j: number, i: number, o: number): void => {
            touch(node);
            const hq = this._jQ(Mv[j].agent!.halfLen);
            this._jeCar[ne] = j; this._jeIn[ne] = i; this._jeOut[ne] = o; this._jeHq[ne] = hq; this._jeNext[ne] = com[node]; com[node] = ne++;
            // A long car in the box: the other approaches it sweeps into wait further back while it is there.
            if (hq > this._jHl) for (const x of net.nodes[node].out) {
                const e2 = net.edges[x].rev; if (e2 === i || !net.edges[e2].car) continue;
                const need = this._jIntrude(e2, i, o, hq);
                if (need <= 0) continue;
                if (this._jExtraSt[e2] !== stamp) { this._jExtraSt[e2] = stamp; this._jExtra[e2] = 0; }
                this._jExtra[e2] = Math.max(this._jExtra[e2], need);
            }
        };
        // 1. COMMITTED: granted (not yet in) + still clearing a box.
        for (let j = 0; j < n; j++) {
            const a = Mv[j].agent;
            if (!a || a.mode !== 'car' || edgeOf[j] < 0) continue;
            if ((a.bNode ?? -1) >= 0) {
                if (a.leg.edge !== a.bOut || a.s >= a.leg.sStart + a.halfLen) a.bNode = -1;
                else commit(a.bNode!, j, a.bIn!, a.bOut!);
            }
            if ((a.gNode ?? -1) >= 0) {
                if (a.gFor !== a.leg) a.gNode = -1;
                else commit(a.gNode!, j, a.leg.edge, a.gOut!);
            }
        }
        // 2. CANDIDATES: the head car of each approach queue, within its braking reach of the line.
        let na = 0;
        for (const e of net.carEdges) {
            const b0 = st[e]; if (b0 === st[e + 1]) continue;
            const node = net.edges[e].to; if (!this._jCtl(node)) continue;
            const j = it[b0], mv = Mv[j], a = mv.agent!;
            if (a.fading === -1 || (a.gFor === a.leg && (a.gNode ?? -1) >= 0)) continue;
            const v = Math.max(vel[j], mv.spec.speed), b = mv.spec.speed * F.brakeK;
            if (rem[j] - a.halfLen > v * F.headwayS + (v * v) / (2 * b) + F.jamGapM * M + this._jBackOf(e) + 0.1 * s) continue;
            if (!this._peekLeg(a)) continue;
            if (a.jFor !== a.leg) { a.jFor = a.leg; a.jArr = time; }
            touch(node);
            if (cand[node] < 0) act[na++] = node;
            this._jcNext[j] = cand[node]; cand[node] = j;
        }
        // 3. GRANTS per junction, in rank order.
        const order = this._jOrder, wait = this._jWait, maxW = F.maxWaitS;
        const cmp = (x: number, y: number): number => {
            const A = Mv[x].agent!, B = Mv[y].agent!, tA = A.jArr ?? time, tB = B.jArr ?? time;
            const oA = time - tA > maxW ? 0 : 1, oB = time - tB > maxW ? 0 : 1;
            if (oA !== oB) return oA - oB;
            if (oA === 0) return A.id - B.id;   // overdue: lowest id goes first
            const sA = A.leg.stopKind === 'sign' ? 1 : 0, sB = B.leg.stopKind === 'sign' ? 1 : 0;
            return (sA - sB) || (tA - tB) || (A.id - B.id);
        };
        for (let k = 0; k < na; k++) {
            const node = act[k];
            order.length = 0; wait.length = 0;
            for (let j = cand[node]; j >= 0; j = this._jcNext[j]) order.push(j);
            if (order.length > 1) order.sort(cmp);
            for (const j of order) {
                const mv = Mv[j], a = mv.agent!, i1 = a.leg.edge, o1 = a.nx!, h1 = this._jQ(a.halfLen);
                let ok = !(a.leg.stopKind === 'sign' && !a.signDone), reach = false;
                // A LONG car (a bus) sweeps further than the approaches' wait lines allow for: only with every head car
                // it would reach held back far enough (not once overdue: a head car waiting on it would wait forever).
                const outs: number[] = net.nodes[node].out;
                if (ok && h1 > this._jHl && time - (a.jArr ?? time) <= maxW) for (const x of outs) {
                    const e2: number = net.edges[x].rev; if (e2 === i1 || !net.edges[e2].car || st[e2] === st[e2 + 1]) continue;
                    const need = this._jIntrude(e2, i1, o1, h1), c = it[st[e2]];
                    if (need > this._jBackOf(e2) && rem[c] - Mv[c].agent!.halfLen < need) { ok = false; reach = true; break; }
                }
                for (let q = com[node]; ok && q >= 0; q = this._jeNext[q]) if (this._jeCar[q] !== j && this._jConflict(i1, o1, h1, this._jeIn[q], this._jeOut[q], this._jeHq[q])) ok = false;
                for (let w = 0; ok && w < wait.length; w++) { const aw = Mv[wait[w]].agent!; if (this._jConflict(i1, o1, h1, aw.leg.edge, aw.nx!, this._jQ(aw.halfLen))) ok = false; }
                // EXIT ROOM: the back of the queue on the exit must leave space for this car past the box (or be moving).
                if (ok && st[o1] < st[o1 + 1]) {
                    const c = it[st[o1 + 1] - 1], nl = a.nxLeg!;
                    const tail = nl.total - rem[c] - Mv[c].agent!.halfLen;
                    if (tail < nl.sStart + 2 * a.halfLen + F.jamGapM * M && vel[c] < 0.25 * Mv[c].spec.speed) ok = false;
                }
                if (ok) {
                    if (time - (a.jArr ?? time) > maxW) this.junctionOverdue++;
                    a.gNode = node; a.gOut = o1; a.gFor = a.leg;
                    commit(node, j, i1, o1);
                } else if (!reach) wait.push(j);   // (a bus held only by its reach does not block the cars it waits for)
            }
        }
    }

    /** The peeked next leg of a car (see RouteAgent.nxFor) — null at a dead end. */
    private _peekLeg(a: RouteAgent): Leg | null {
        if (a.nxFor !== a.leg) {
            const net = this._net!, nx = carNext(net, a.leg.edge, a.id, a.visit + 1, a.bus);
            a.nxFor = a.leg; a.nx = nx ?? -1; a.nxLeg = nx === null ? null : carLeg(net, nx, a.leg.edge);
        }
        return a.nxLeg ?? null;
    }

    private _fg = Infinity;
    private _fv = 0;
    private _phOn: Leg | null = null;
    /** Distance along car `a`'s path (the rest of its leg, then its peeked next leg's junction part) to the point
     *  (x, z), if that point lies inside its path corridor — else −1. Leaves the projection in `_pj` and the leg it hit
     *  in `_phOn`. (The rest of our own leg first: a hairpin's curve can sweep into our lane's end.) */
    private _pathHit(a: RouteAgent, nl: Leg | null, myRem: number, x: number, z: number, corr: number): number {
        const PJ = this._pj;
        legProject(a.leg, x, z, PJ);
        if (PJ.lat < corr && PJ.s > a.s && PJ.s < a.leg.total - 1e-6) { this._phOn = a.leg; return PJ.s - a.s; }
        if (!nl) return -1;
        legProject(nl, x, z, PJ);
        if (PJ.lat < corr && PJ.s > 1e-6 && PJ.s < nl.sStart + a.halfLen) { this._phOn = nl; return myRem + PJ.s; }
        return -1;
    }
    /** Car `i`'s bumper gap to what is ahead in its lane → `_fg` (Infinity = nothing within its look-ahead) and that
     *  obstacle's speed → `_fv`: the next car on its edge, else the last car on its peeked next edge (queued through
     *  the junction / round the turn), and the Play player inside its lane corridor (speed 0). */
    private _leaderGap(mv: MoverRec, i: number, s: number): void {
        const a = mv.agent!, F = this.follow, M = s / 15;
        let gap = Infinity, vL = 0;
        const v = Math.max(mv.vel, mv.spec.speed), b = mv.spec.speed * F.brakeK;
        // Far enough to see anything we might have to stop for: the safe-speed stopping distance + the gaps + slack.
        const look = a.halfLen + v * F.headwayS + (v * v) / (2 * b) + F.jamGapM * M + 0.45 * s;
        const myRem = a.leg.total - a.s;
        if (this._laneOn) {
            const st = this._laneStart, it = this._laneItems, rem = this._laneRem, e = a.leg.edge;
            let j = -1;
            // Bucket is rem-ascending; from the back, the first car with a smaller rem is the nearest one ahead.
            for (let q = st[e + 1] - 1; q >= st[e]; q--) { const c = it[q]; if (c === i) continue; if (rem[c] < myRem || (rem[c] === myRem && c < i)) { j = c; break; } }
            if (j >= 0) { gap = myRem - rem[j] - a.halfLen - this.movers[j].agent!.halfLen; vL = this._laneVel[j]; }
            else if (myRem < look) {
                const nl = this._peekLeg(a);
                if (nl) {
                    const e2 = nl.edge;
                    for (let q = st[e2 + 1] - 1; q >= st[e2]; q--) {
                        const c = it[q]; if (c === i) continue;
                        // On the shared straight the rem difference is exact. A car still on ITS junction curve (from
                        // another approach — a merge) is placed by projecting it onto our next leg; off our path it
                        // counts as at the straight's start (it merges there): yield to it.
                        const ac = this.movers[c].agent!;
                        let dL = Math.max(0, nl.total - rem[c]);
                        if (ac.s < ac.leg.sStart && ac.leg !== nl) {
                            const PJ = this._pj, oc = this.movers[c];
                            legProject(nl, oc.cx, oc.cz, PJ);
                            dL = PJ.lat < 2 * F.corridorHalfM * M ? Math.min(dL, PJ.s) : Math.min(dL, nl.sStart);
                        }
                        gap = myRem + dL - a.halfLen - this.movers[c].agent!.halfLen; vL = this._laneVel[c];
                        break;
                    }
                }
                // The JUNCTION BOX ahead: cars still on a junction curve (tail not yet onto their straight) of the
                // other exits. One that left MY lane (its leg starts at our lane's end point) is ahead of us along
                // the shared entry until it clears; any other one inside our own path through the box (projected onto
                // our next leg, within two car half-widths) is crossing / merging in front of us — wait for it to
                // clear (don't enter an occupied box). Only cars OUTSIDE the box wait on cars inside it → no deadlock.
                const net = this._net!, out = net.nodes[net.edges[e].to].out, P0 = a.leg.pts[a.leg.pts.length - 1], tol = 1e-4 * s + 1e-9;
                const PJ = this._pj, corr = 2 * F.corridorHalfM * M;
                for (let oi = 0; oi < out.length; oi++) {
                    const o = out[oi];
                    if ((nl && o === nl.edge) || !net.edges[o].car) continue;
                    for (let q = st[o + 1] - 1; q >= st[o]; q--) {
                        const c = it[q]; if (c === i) continue;
                        const oc = this.movers[c], ac = oc.agent!, q0 = ac.leg.pts[0];
                        if (ac.s >= ac.leg.sStart + ac.halfLen) continue;
                        let g = Infinity, gv = 0;
                        if (Math.abs(q0[0] - P0[0]) <= tol && Math.abs(q0[1] - P0[1]) <= tol) { g = myRem + ac.s - a.halfLen - ac.halfLen; gv = this._laneVel[c]; }
                        else {
                            // Where it is now, and where its curve still goes (its remaining curve points): the first
                            // spot on our path it occupies / will sweep through is the obstacle — we wait at our mouth
                            // instead of nosing into its turn. (Moving along our path = its speed; crossing = 0.)
                            let at = this._pathHit(a, nl, myRem, oc.cx, oc.cz, corr);
                            if (at >= 0) { legPoint(this._phOn!, PJ.s, LP); gv = this._laneVel[c] * Math.max(0, oc.hx * LP.hx + oc.hz * LP.hz); }
                            const L2 = ac.leg, sEnd = L2.sStart + ac.halfLen;
                            for (let pi = 1; pi < L2.pts.length && L2.cum[pi - 1] < sEnd; pi++) {
                                if (L2.cum[pi] <= ac.s) continue;
                                const h = this._pathHit(a, nl, myRem, L2.pts[pi][0], L2.pts[pi][1], corr);
                                if (h >= 0 && (at < 0 || h < at)) { at = h; gv = 0; }
                            }
                            if (at >= 0) g = at - a.halfLen - ac.halfLen;
                        }
                        if (g < gap) { gap = g; vL = gv; }
                    }
                }
            }
        }
        const P = this._pl;
        if (P.on) {
            const dx = P.x - mv.cx, dz = P.z - mv.cz, R = look + P.r;
            if (dx * dx + dz * dz < R * R) {
                const PJ = this._pj, corr = F.corridorHalfM * M + P.r;
                let d = -1;
                legProject(a.leg, P.x, P.z, PJ);
                if (PJ.lat < corr && PJ.s >= a.s && PJ.s < a.leg.total - 1e-6) d = PJ.s - a.s;
                else if (myRem < look) {
                    const nl = this._peekLeg(a);
                    if (nl) { legProject(nl, P.x, P.z, PJ); if (PJ.lat < corr && PJ.s > 1e-6) d = myRem + PJ.s; }
                }
                if (d >= 0) { const g = d - a.halfLen - P.r; if (g < gap) { gap = g; vL = 0; } }
            }
        }
        this._fg = gap; this._fv = vL;
    }

    /** A routed car's position along its ROAD (road.a → road.b coordinates) on the straight part of its leg. */
    private _alongOnRoad(a: RouteAgent, e: RoadNet['edges'][number]): number {
        const net = this._net!;
        const A = net.nodes[e.from].arms, pass = A.length === 2 && A[0][0] * A[1][0] + A[0][1] * A[1][1] < -0.985;
        const m0 = pass ? 0 : A.length <= 1 ? 0.02 * net.s : net.half;
        const d = m0 + (a.s - a.leg.sStart);
        return e.forward ? d : e.len - d;
    }

    /** Is a parked car / roadworks patch on this car's kerb within its swerve window? */
    private _obstacleAhead(a: RouteAgent, s: number): boolean {
        // Our kerb is on our LEFT: the −pp side of the road for a forward (a→b) edge.
        const e = this._net!.edges[a.leg.edge], obs = this._obstacles.get(e.ri + '|' + (e.forward ? -1 : 1));
        if (!obs) return false;
        const al = this._alongOnRoad(a, e), dir = e.forward ? 1 : -1;
        const lookA = 0.3 * s, back = a.halfLen + 0.04 * s;
        for (const o of obs) {
            // In travel coordinates: the obstacle spans [lo, hi]; we swing out from `lookA` before it until our tail clears it.
            const rel0 = dir > 0 ? o.lo - al : al - o.hi, rel1 = dir > 0 ? o.hi - al : al - o.lo;
            if (rel0 < lookA + a.halfLen && rel1 > -back) return true;
        }
        return false;
    }

    /** CAR AI: brake for a car ahead in the same lane, a crossing pedestrian, or (while swinging out past a parked car)
     *  oncoming traffic. Lower-index car wins a junction overlap (deterministic → no deadlock). */
    private _carBlocked(mv: MoverRec, i: number, pose: Float32Array, s: number): boolean {
        const swinging = !!mv.agent && (mv.agent.shift > 0.01 * s || this._obstacleAhead(mv.agent, s));
        if (!this.blockGrid || this._bgNx === 0) return this._carBlockedScan(mv, i, pose, s, swinging, -1);
        const r = this._blockedAt(mv, i, pose, s, swinging);
        if (this.checkBlockGrid && r !== this._carBlockedScan(mv, i, pose, s, swinging, -1)) this.blockGridMismatches++;
        return r;
    }

    /** P9: per-tick uniform grid (counting sort) of the cars + walkers over the tick's pose snapshot. Cell = the
     *  typical blocker reach (0.5 · s); _blockedAt widens its query for longer reaches. */
    private _buildBlockGrid(pose: Float32Array, s: number): void {
        const M = this.movers, n = M.length;
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, k = 0;
        for (let j = 0; j < n; j++) {
            const ot = M[j].spec.kind;
            if (ot !== 'car' && ot !== 'walker') continue;
            const x = pose[j * 4], z = pose[j * 4 + 1];
            if (!(x === x) || !(z === z)) continue;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
            k++;
        }
        if (k === 0) { this._bgNx = 0; return; }
        const cell = Math.max(1e-6, 0.5 * s);
        const nx = Math.min(512, Math.floor((x1 - x0) / cell) + 1), nz = Math.min(512, Math.floor((z1 - z0) / cell) + 1);
        const cw = Math.max(cell, (x1 - x0) / nx + 1e-9), cz = Math.max(cell, (z1 - z0) / nz + 1e-9);
        if (this._bgStart.length < nx * nz + 1) this._bgStart = new Int32Array(nx * nz + 1);
        if (this._bgItems.length < n) { this._bgItems = new Int32Array(n); this._bgCellOf = new Int32Array(n); }
        const start = this._bgStart, items = this._bgItems, cellOf = this._bgCellOf;
        start.fill(0, 0, nx * nz + 1);
        for (let j = 0; j < n; j++) {
            const ot = M[j].spec.kind, x = pose[j * 4], z = pose[j * 4 + 1];
            if ((ot !== 'car' && ot !== 'walker') || !(x === x) || !(z === z)) { cellOf[j] = -1; continue; }
            const c = Math.min(nz - 1, Math.floor((z - z0) / cz)) * nx + Math.min(nx - 1, Math.floor((x - x0) / cw));
            cellOf[j] = c; start[c + 1]++;
        }
        for (let c = 0; c < nx * nz; c++) start[c + 1] += start[c];
        if (this._bgFill.length < nx * nz) this._bgFill = new Int32Array(nx * nz);
        const fill = this._bgFill; fill.set(start.subarray(0, nx * nz));   // the cells' write cursors
        for (let j = 0; j < n; j++) { const c = cellOf[j]; if (c >= 0) items[fill[c]++] = j; }
        this._bgCell = Math.max(cw, cz); this._bgX0 = x0; this._bgZ0 = z0; this._bgNx = nx; this._bgNz = nz;
        this._bgCw = cw; this._bgCz = cz;
    }
    private _bgCw = 1;
    private _bgCz = 1;
    private _bgFill = new Int32Array(0);

    /** _carBlocked over the grid cells within the car's largest blocker reach. */
    private _blockedAt(mv: MoverRec, i: number, pose: Float32Array, s: number, swinging: boolean): boolean {
        const sw = this.w._graph!.params.streetWidth;
        const hl = mv.agent ? mv.agent.halfLen : 0.15 * s;
        // The predicates' reach (see _carBlockedScan): overlap 0.085 s · following (hl + 0.1 s, 0.06 s lateral) ·
        // swinging (0.45 s, 0.2 s) · a crossing pedestrian (0.14 s, 0.35 × street width).
        const R = 1.001 * Math.max(0.085 * s, Math.hypot(hl + 0.1 * s, 0.06 * s), Math.hypot(0.45 * s, 0.2 * s), Math.hypot(0.14 * s, 0.35 * sw));
        const x = pose[i * 4], z = pose[i * 4 + 1];
        const gx0 = Math.max(0, Math.floor((x - R - this._bgX0) / this._bgCw)), gx1 = Math.min(this._bgNx - 1, Math.floor((x + R - this._bgX0) / this._bgCw));
        const gz0 = Math.max(0, Math.floor((z - R - this._bgZ0) / this._bgCz)), gz1 = Math.min(this._bgNz - 1, Math.floor((z + R - this._bgZ0) / this._bgCz));
        const start = this._bgStart, items = this._bgItems;
        for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
            const c = gz * this._bgNx + gx;
            for (let q = start[c]; q < start[c + 1]; q++) if (this._carBlockedScan(mv, i, pose, s, swinging, items[q])) return true;
        }
        return false;
    }

    /** The blocker predicates: over every mover (`only` < 0) or for mover `only` alone. */
    private _carBlockedScan(mv: MoverRec, i: number, pose: Float32Array, s: number, swinging: boolean, only: number): boolean {
        const p = this.w._graph!.params;
        const mex = pose[i * 4], mez = pose[i * 4 + 1], mehx = pose[i * 4 + 2], mehz = pose[i * 4 + 3];
        const j0 = only < 0 ? 0 : only, j1 = only < 0 ? this.movers.length : only + 1;
        for (let j = j0; j < j1; j++) {
            if (j === i) continue;
            const o = this.movers[j], ot = o.spec.kind;
            if (ot !== 'car' && ot !== 'walker') continue;
            if (o.visiting) continue;   // walkers inside a building can't block traffic
            if (o.agent && o.agent.fading === -1 && o.agent.fade < 0.3) continue;   // a car fading out at the border
            const dxp = pose[j * 4] - mex, dzp = pose[j * 4 + 1] - mez;
            const ahead = dxp * mehx + dzp * mehz;                    // along my heading
            if (ot === 'car' && ahead > -0.02 * s && j < i && dxp * dxp + dzp * dzp < (0.085 * s) * (0.085 * s)) return true;
            if (ahead <= 0.02 * s) continue;
            const lateral = Math.abs(dxp * -mehz + dzp * mehx);
            const ohx = pose[j * 4 + 2], ohz = pose[j * 4 + 3], para = ohx * mehx + ohz * mehz;
            if (ot === 'car') {
                if (ahead < (mv.agent ? mv.agent.halfLen : 0.15 * s) + 0.1 * s && lateral < 0.06 * s && para > -0.3) return true;   // car-following gap
                // Swinging out past a parked car: wait for oncoming traffic in the other lane to clear.
                if (swinging && para < -0.7 && ahead < 0.45 * s && lateral < 0.2 * s && (!mv.agent || mv.agent.shift < 0.03 * s)) return true;
                continue;
            }
            // Yield to a pedestrian CROSSING our path — not one strolling ALONG the road beside us (parallel).
            if (ahead < 0.14 * s && lateral < p.streetWidth * 0.35 && Math.abs(para) < 0.6) return true;
        }
        return false;
    }

    /** A car that faded out at a dead end re-enters at a border entry (or any road) once that spot is clear. */
    private _respawnCar(mv: MoverRec, i: number, pose: Float32Array, s: number): void {
        const a = mv.agent!, net = this._net!;
        const pool = a.bus ? net.carEdges.filter(e => net.edges[e].arterial) : (net.entries.length ? net.entries : net.carEdges);
        const cand = pool.length ? pool : net.carEdges;
        if (!cand.length) return;
        for (let tries = 0; tries < 4; tries++) {
            const e = cand[(hash2(a.id, a.visit * 4 + tries, 0x5e5e) * cand.length) | 0];
            const leg = carLeg(net, e, null);
            legPoint(leg, leg.sStart, LP);
            let clear = true;
            for (let j = 0; j < this.movers.length && clear; j++) {
                if (j === i || this.movers[j].spec.kind !== 'car') continue;
                const dx = pose[j * 4] - LP.x, dz = pose[j * 4 + 1] - LP.z;
                // Clear by both car lengths + the standstill gap (a fixed 0.4 s let a bus re-enter on top of a car).
                const oh = this.movers[j].agent?.halfLen ?? 0.15 * s, r = Math.max(0.4 * s, a.halfLen + oh + this.follow.jamGapM * (s / 15));
                if (dx * dx + dz * dz < r * r) clear = false;
            }
            a.visit++;
            if (!clear) continue;
            a.leg = leg; a.s = leg.sStart; a.fading = 1; a.fade = 0.001; a.signDone = false; a.hold = 0; a.shift = 0; a.through = false;
            a.gNode = -1; a.gFor = null; a.bNode = -1; a.jFor = null;
            mv.vel = mv.spec.speed * 0.5; mv.yaw = null;
            // Into the tick's pose snapshot: a second car respawning this tick must see this one at the entry.
            pose[i * 4] = LP.x; pose[i * 4 + 1] = LP.z; pose[i * 4 + 2] = LP.hx; pose[i * 4 + 3] = LP.hz;
            return;
        }
    }

    /** RAIL RUN (railway-upgrade R2.2): step the consist's station-stop schedule, then place every car at its own arc
     *  length along its track polyline (each car on the chord between its bogies) — rigid in Y (rail top baked), unwarped (the viaduct is noWarp). Door leaves
     *  slide along the car's own axis while dwelling; the leading cab shows its headlights, the trailing one its tail
     *  lights. Allocation-free. Trains always pose (big smooth motion — see moverPoseInterval). */
    private _tickRailRun(mv: MoverRec, dt: number, radius: number, lod: SimLod | null = null): void {
        const sp = mv.spec, run = mv.run!, plan = sp.run!.plan, pd = mv.path!;
        if (lod) {
            // SIM LOD: the run as a function of the clock (train.ts trainRunAt) — built from the state at a stop (a
            // train caught moving when sim LOD turns on keeps stepping until it next stops). Written into the SAME run
            // object, so the level crossings (_localTrains) read the scheduled state.
            if (mv.runTl === undefined && run.v === 0) { mv.runTl = trainRunTimeline(plan, { ...run }); mv.runT0 = this.w._simTime; }
            if (mv.runTl) trainRunAt(mv.runTl, this.w._simTime - (mv.runT0 ?? 0), run); else stepTrainRun(run, plan, dt);
        } else {
            if (mv.runTl !== undefined) mv.runTl = undefined;
            stepTrainRun(run, plan, dt);
        }
        mv.t = run.s / mv.len; mv.dir = run.dir; mv.vel = run.v;
        const mpu = cityMetresPerUnit(radius), hb = sp.run!.bogieHalf ?? EMU_BOGIE_HALF_M / mpu;
        if (lod && dt !== 0 && !this._lodTrainDue(mv, run.s, hb, lod)) {
            const P0 = this._carPose; carPoseAt(pd.pts, pd.cum, run.s, hb, P0);
            mv.cx = P0.x; mv.cz = P0.z; mv.hx = Math.cos(P0.yaw) * run.dir; mv.hz = -Math.sin(P0.yaw) * run.dir;
            return;   // posed on its band's cadence (fogged: not at all) — the schedule above keeps it on time
        }
        const slide = run.door * (sp.run!.doorSlide ?? EMU_DOOR_SLIDE_M / mpu);
        const H = sp.run!.heights, HP = this._carH;   // (R3.2) the at-grade local consist rides its terrain-following rails
        const relamp = mv.runLampDir !== run.dir;
        mv.runLampDir = run.dir;
        const P = this._carPose;
        for (const seg of mv.segments!) {
            carPoseAt(pd.pts, pd.cum, run.s + seg.offset, hb, P);
            const yaw = seg.flip ? P.yaw + Math.PI : P.yaw;
            const lx = Math.cos(yaw), lz = -Math.sin(yaw);   // the car's own +x in world (rotateY maps +x to (cos, -sin))
            let y = sp.baseY, pitch = 0;
            if (H) { carHeightAt(pd.cum, H, run.s + seg.offset, hb, HP); y += HP.y; pitch = seg.flip ? -HP.pitch : HP.pitch; }
            for (const m of seg.body ?? seg.meshes) m.setPoseXYZYaw(P.x, y, P.z, yaw, pitch);
            if (seg.doorA) for (const m of seg.doorA) m.setPoseXYZYaw(P.x - lx * slide, y, P.z - lz * slide, yaw, pitch);
            if (seg.doorB) for (const m of seg.doorB) m.setPoseXYZYaw(P.x + lx * slide, y, P.z + lz * slide, yaw, pitch);
            if (relamp && (seg.head?.length || seg.tail?.length)) {
                const lead = (seg.flip ? -1 : 1) === run.dir;   // this cab faces the way the train is going
                for (const m of seg.head!) this._show(m, lead);
                for (const m of seg.tail!) this._show(m, !lead);
            }
        }
        carPoseAt(pd.pts, pd.cum, run.s, hb, P);
        mv.cx = P.x; mv.cz = P.z; mv.hx = Math.cos(P.yaw) * run.dir; mv.hz = -Math.sin(P.yaw) * run.dir;
    }
    private readonly _carPose = { x: 0, z: 0, yaw: 0 };
    private readonly _carH = { y: 0, pitch: 0 };

    // ── SIM LOD (src/world/sim-lod.ts, performance-plan §P13) ─────────────────────────────────────────────────────
    // With `scene3d.simLod` enabled (and a camera), each mover is banded every tick by its distance, whether it is on
    // screen and whether the fog horizon hides it: NEAR every frame, MID ~10 Hz, FAR / OFF-SCREEN ~2 Hz, FROZEN never.
    //   - routed WALKERS are a function of the clock (walker-clock.ts): a skipped frame costs nothing and the next
    //     evaluation lands exactly on the route, after any gap;
    //   - TRAINS (rail runs) are a function of the clock (train.ts trainRunAt), posed on their band's cadence;
    //   - CARS interact (following, yielding, junctions), so they stay a stepped sim: every frame NEAR / MID (posed at
    //     the band rate), at the band rate in ≤ 0.1 s substeps FAR / OFF-SCREEN, paused while FROZEN (the others
    //     ignore a frozen mover: NaN in the pose buffer);
    //   - legacy a→b movers (clouds, birds, boats …) are a closed form of the clock, posed by band.
    // The selection is never throttled. Off → `_lodOff` hands every clock-driven state back to the stepped sim.
    private _lod: SimLod | null = null;
    private _lodWas = false;
    private _lodPose = true;
    private _cm: Float32Array | null = null;
    private _sel: Set<string> | null = null;
    private _cW!: SimLodCounter;
    private _cC!: SimLodCounter;
    private _cT!: SimLodCounter;
    private _cO!: SimLodCounter;
    private readonly _wp = new Float64Array(3);
    private _cpose: WalkerPose | null = null;

    /** City-local → world (the city container's matrix). */
    private _toWorld(x: number, y: number, z: number): Float64Array {
        const m = this._cm, o = this._wp;
        if (!m) { o[0] = x; o[1] = y; o[2] = z; return o; }
        o[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
        o[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        o[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        return o;
    }
    private _isSel(mv: MoverRec): boolean {
        const sel = this._sel; if (!sel) return false;
        for (const m of mv.meshes) if (sel.has(m.id)) return true;
        return false;
    }
    private _phase(i: number): number { return (i * 0.6180339887) % 1; }

    /** Sim LOD switched off: every clock-driven state is evaluated now and handed back to the stepped sim. */
    private _lodOff(time: number): void {
        for (const mv of this.movers) {
            if (mv.clock && mv.agent) { const cp = this._cpose ?? (this._cpose = newWalkerPose(mv.agent.leg)); mv.clock.eval(time, cp); this._syncFromClock(mv, cp); }
            mv.clock = null; mv.clockDirty = false; mv.xHold = false; mv.lin = null; mv.simDt = 0;
            if (mv.sl) mv.sl.band = 0;
        }
    }

    private _syncFromClock(mv: MoverRec, cp: WalkerPose): void {
        const a = mv.agent!;
        a.leg = cp.leg; a.s = cp.s; a.visit = cp.visit; a.waiting = cp.waiting; a.waited = cp.waited;
        mv.vel = cp.v; mv.cx = cp.x; mv.cz = cp.z; mv.hx = cp.hx; mv.hz = cp.hz;
        mv.t = cp.leg.total > 0 ? cp.s / cp.leg.total : 0;
    }
    private _clockBase(mv: MoverRec, time: number, v: number): WalkerClockBase {
        const a = mv.agent!;
        return { leg: a.leg, s: a.s, visit: a.visit, waiting: a.waiting, waited: a.waited, v, t: time,
            holdUntil: mv.pausedUntil > time ? mv.pausedUntil : undefined };
    }
    /** (Re)start a walker's clock from its agent state (spawn / sim LOD on / back from a visit: v = 0). */
    private _rebaseClock(mv: MoverRec, time: number): void {
        const base = this._clockBase(mv, time, mv.clockDirty ? 0 : mv.vel);
        if (mv.clock) mv.clock.rebase(base);
        else mv.clock = new WalkerClock(this._net!, () => this.timing, mv.agent!.id, mv.spec.speed, base);
        mv.clockDirty = false; mv.xHold = false;
    }
    /** A chat started: the clock brakes from where the walker is now and holds until pausedUntil. */
    private _clockHold(mv: MoverRec, time: number): void {
        const cp = this._cpose ?? (this._cpose = newWalkerPose(mv.agent!.leg));
        mv.clock!.eval(time, cp); this._syncFromClock(mv, cp);
        mv.clock!.rebase(this._clockBase(mv, time, cp.v));
        mv.xHold = false;
    }

    /** One routed walker under sim LOD: band it, and when due evaluate its clock and pose it. */
    private _tickWalkerLod(mv: MoverRec, i: number, dt: number, s: number, lod: SimLod, time: number): void {
        const sp = mv.spec, cp = this._cpose ?? (this._cpose = newWalkerPose(mv.agent!.leg));
        if (!mv.clock || mv.clockDirty) this._rebaseClock(mv, time);
        const m0 = mv.body[0] ?? mv.meshes[0];
        const y = (m0?.localMatrix as unknown as Float32Array | undefined)?.[13] ?? sp.baseY;
        const w = this._toWorld(mv.cx, y, mv.cz), sl = mv.sl ?? (mv.sl = newSimSlot());
        const due = lod.step(this._cW, sl, time, this._phase(i), w[0], w[1], w[2], 0.03 * s, this._isSel(mv), false, false, mv.vel, mv.hx * mv.vel, mv.hz * mv.vel);
        if (!due) {
            mv.placeDt = (mv.placeDt ?? 0) + dt;
            // frozen in the fog: the position (not the pose) refreshes once a second, so the band follows the walker
            if (sl.band === SIM_FROZEN && time - (mv.frozenEval ?? -Infinity) >= 1) { mv.frozenEval = time; mv.clock!.eval(time, cp); this._syncFromClock(mv, cp); }
            return;
        }
        mv.clock!.eval(time, cp); this._syncFromClock(mv, cp);
        // R3.2: a CLOSED level crossing ahead — hold outside the barrier until it opens (checked when evaluated).
        if (this.xing.T) {
            const xd = this.xing.holdDist(mv.cx, mv.cz, mv.hx, mv.hz, 0, true);
            if (xd < 0.25 * s && !cp.stopped && !mv.xHold) {
                mv.xHold = true;
                mv.clock!.rebase({ ...this._clockBase(mv, time, cp.v), holdUntil: Infinity, stopIn: Math.max(0, xd - 0.003 * s) });
                mv.clock!.eval(time, cp); this._syncFromClock(mv, cp);
            } else if (mv.xHold && xd >= 0.25 * s) {
                mv.xHold = false;
                mv.clock!.rebase(this._clockBase(mv, time, 0));
            }
        }
        const pdt = (mv.placeDt ?? 0) + dt; mv.placeDt = 0;
        this._easeYaw(mv, mv.faceYaw ?? Math.atan2(-cp.hz, cp.hx), pdt * 6);
        const gy = this._groundY(cp.x, cp.z, Math.abs(cp.hx) >= Math.abs(cp.hz), s);
        this.w._warpInto(cp.x, cp.z, this.w._warpScratch);
        this._place(mv, cp.x + this.w._warpScratch[0], sp.baseY + gy, cp.z + this.w._warpScratch[1], mv.yaw, pdt, cp.v, s);
    }

    /** One routed car under sim LOD: stepped every frame near / mid (posed at the band rate), in ≤ 0.1 s substeps at
     *  the band rate far / off screen, paused while frozen. */
    private _tickCarLod(mv: MoverRec, i: number, dt: number, pose: Float32Array, s: number, lod: SimLod, time: number): void {
        const m0 = mv.body[0] ?? mv.meshes[0];
        const y = (m0?.localMatrix as unknown as Float32Array | undefined)?.[13] ?? mv.spec.baseY;
        const w = this._toWorld(mv.cx, y, mv.cz), sl = mv.sl ?? (mv.sl = newSimSlot());
        const due = lod.step(this._cC, sl, time, this._phase(i), w[0], w[1], w[2], 0.15 * s, this._isSel(mv), false, false, mv.vel, mv.hx * mv.vel, mv.hz * mv.vel);
        if (sl.band === SIM_FROZEN) { mv.simDt = 0; return; }   // paused in the fog (and invisible to the others)
        if (sl.band <= SIM_MID) { this._lodPose = due; this._tickAgent(mv, i, dt, pose, s); return; }
        mv.simDt = (mv.simDt ?? 0) + dt;
        if (!due) return;
        let left = Math.min(mv.simDt, 2); mv.simDt = 0;
        const o = i * 4;
        while (left > 1e-6) {
            const h = Math.min(0.1, left); left -= h;
            this._lodPose = left <= 1e-6;
            this._tickAgent(mv, i, h, pose, s);
            pose[o] = mv.cx; pose[o + 1] = mv.cz; pose[o + 2] = mv.hx; pose[o + 3] = mv.hz;
        }
    }

    /** A rail run's pose band (big: no distance bands; on screen = every frame; the consist's ends count). */
    private _lodTrainDue(mv: MoverRec, sCentre: number, hb: number, lod: SimLod): boolean {
        const pd = mv.path!, P = this._carPose, sl = mv.sl ?? (mv.sl = newSimSlot());
        let half = 0; for (const g of mv.segments!) half = Math.max(half, Math.abs(g.offset));
        half += hb * 1.6;
        let inView = false, inFog = true;
        for (const k of [0, -1, 1]) {
            carPoseAt(pd.pts, pd.cum, sCentre + k * half, hb, P);
            const w = this._toWorld(P.x, mv.spec.baseY, P.z);
            if (!inView && simPointInView(lod.view.vp, w[0], w[1], w[2], 1.35)) inView = true;
            if (inFog && !lod.inFog(w[0], w[1], w[2], hb)) inFog = false;
        }
        const band = simBand(lod.settings, 0, inView, inFog, sl.band, this._isSel(mv));
        const due = simDue(lod.settings, sl, band, this.w._simTime, 0);
        this._cT.count(band, due);
        return due;
    }

    /** A legacy mover's pose band at its (unwarped) route point. Small kinds (walkers) take the distance bands;
     *  big ones (clouds, boats, rain, holo flyers) only the off-screen / fog rules. No-fog meshes never freeze. */
    private _lodLegacyDue(mv: MoverRec, i: number, px: number, pz: number, s: number, lod: SimLod, time: number): boolean {
        const k = mv.spec.kind, small = k === 'walker' || k === 'car';
        const m0 = mv.body[0] ?? mv.meshes[0];
        const noFog = !!(m0?.material as { noFog?: unknown } | undefined)?.noFog;
        const y = (m0?.localMatrix as unknown as Float32Array | undefined)?.[13] ?? mv.spec.baseY;
        const w = this._toWorld(px, y, pz), sl = mv.sl ?? (mv.sl = newSimSlot());
        return lod.step(this._cO, sl, time, this._phase(i), w[0], w[1], w[2], (small ? 0.05 : 0.3) * s, this._isSel(mv), !small, noFog, mv.vel);
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

    /** Advance one DOOR / BROWSE VISIT. Timeline (t since start): 0–0.5 the leaf swings open while the walker heads
     *  for the door (0–0.9) · 0.9 the walker steps INSIDE (meshes hidden) · 0.9–1.4 the leaf swings shut and
     *  hides (the painted door reads as closed) · `dur` seconds inside · then the mirror: open, reappear,
     *  walk back to the route, close. A BROWSE visit (stall / vending, no leaf) walks up, stands facing it for
     *  `dur`, and walks back — never disappears. Returns true when the visit is finished. */
    private _tickVisit(v: DoorVisit, s: number, dt: number): boolean {
        const mv = v.mv, sp = mv.spec, t = this.w._simTime - v.start;
        const door = v.door, gy = sp.baseY, browse = !v.leaf && !door.station;
        // A station entrance is picked from farther away: the walk in / out takes as long as walking it does.
        const tw = door.station ? Math.max(0.9, Math.hypot(door.x - v.ax, door.z - v.az) / Math.max(1e-6, sp.speed * 0.8)) : 0.9;
        const IN_END = tw, SHUT = tw + 0.5, D0 = SHUT + v.dur, END = D0 + 0.7 + tw;

        // Walker route anchor (frozen while visiting) + the doorstep target (both unwarped).
        const rx = v.ax, rz = v.az;
        const tx = browse ? door.x : door.x + door.ox * 0.012 * s, tz = browse ? door.z : door.z + door.oz * 0.012 * s;

        // Leaf: swing angle + visibility per phase.
        let swing = 0, leafOn = false, walkerOn = true, k = 0, outward = false;
        if (t < SHUT) {                                   // heading in
            leafOn = !browse;
            swing = t < 0.5 ? t / 0.5 : t < IN_END ? 1 : Math.max(0, 1 - (t - IN_END) / 0.5);
            k = Math.min(1, t / (IN_END - 0.05));
            walkerOn = browse || t < IN_END;
        } else if (t < D0) {                              // inside (door) / browsing (stall)
            walkerOn = browse; k = 1;
        } else if (t < END) {                             // coming back out
            leafOn = !browse;
            const te = t - D0;
            swing = te < 0.5 ? te / 0.5 : te < 1.1 ? 1 : Math.max(0, 1 - (te - 1.1) / 0.5);
            walkerOn = browse || te >= 0.3;
            k = walkerOn ? Math.max(0, 1 - (te - (browse ? 0 : 0.3)) / (browse ? 1.1 : door.station ? tw : 0.8)) : 1;
            outward = true;
        } else {                                          // done
            mv.visiting = false;
            mv.cooldownUntil = this.w._simTime + 30;
            if (v.leaf) v.leaf.visible = false;
            for (const m of mv.meshes) this._show(m, (m.name ?? '') !== 'world:traffic-emote' && (m !== mv.pool));
            return true;
        }

        if (v.leaf) {
            // Leaf transform (hinge at the door's left jamb, proud of the wall; baked door lift).
            const e: [number, number] = [-door.oz, door.ox];
            const hx = door.x - e[0] * 0.013 * s + door.ox * 0.006 * s;
            const hz = door.z - e[1] * 0.013 * s + door.oz * 0.006 * s;
            this.w._warpInto(hx, hz, this.w._warpScratch);
            const lwx = this.w._warpScratch[0], lwz = this.w._warpScratch[1];
            this._show(v.leaf, leafOn);
            if (leafOn) {
                v.leaf.rotationY = door.yaw + swing * 1.55;
                v.leaf.setXYZ(hx + lwx, gy + door.lift, hz + lwz);
            }
        }

        // Walker transit: route anchor → doorstep (eased), terrain height blending up to the door lift.
        const ke = k * k * (3 - 2 * k);
        const px = rx + (tx - rx) * ke, pz = rz + (tz - rz) * ke;
        const y = browse ? this.w._heightFn(px, pz) : this.w._heightFn(px, pz) * (1 - ke) + door.lift * ke;
        this.w._warpInto(px, pz, this.w._warpScratch);
        const wx = this.w._warpScratch[0], wz = this.w._warpScratch[1];
        const moving = (t < IN_END || (t >= D0 && t < END)) && Math.abs(1 - ke) > 1e-3 && ke > 1e-3;
        // Heading: toward the target going in, back toward the anchor coming out; standing = facing the stall/door.
        const hx2 = outward ? rx - tx : tx - rx, hz2 = outward ? rz - tz : tz - rz;
        const yaw = moving && Math.hypot(hx2, hz2) > 1e-6 ? Math.atan2(-hz2, hx2) : Math.atan2(door.oz, -door.ox);
        this._easeYaw(mv, yaw, dt * 6);
        for (const m of mv.meshes) {
            const isEmote = (m.name ?? '') === 'world:traffic-emote';
            this._show(m, walkerOn && !isEmote && m !== mv.pool);
        }
        if (walkerOn) this._place(mv, px + wx, gy + y, pz + wz, mv.yaw, dt, moving ? sp.speed * 0.8 : 0, s);
        return false;
    }

    // ── Shared animation ticker (day/night cycle + traffic) ──────────────────────────────────────

}
