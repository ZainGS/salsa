// ── World manager — the bridge between the pure `src/world` module and the 3D scene ──────────────
// This is the API surface (`sm.world.*`) for procedural worlds. It owns the generated graph + the preview
// meshes in the scene. The pure generation lives in `src/world` (Salsa core never imports it); this bridge
// imports both that module and the scene manager, mirroring how `sm.packaging.*` bridges the packaging engine.
//
// Phases build on one shared graph: generateLayout (roads/lots/zoning, flat map) → generateBiome (trees/rocks)
// → generateStreets (buildings — Phase 3). Each phase adds its own removable mesh group.
//
// City MODE: the City Tool enters a dedicated editing mode (alt+drag orbit + focus workspace, like Edit-Mesh)
// via `enterCityMode`; slider changes call `updateCity` for a live (debounced) regen that keeps the orbit view.

import type { Scene3DManager } from './scene3d-manager';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { generateCityLayout, tiledWorldExtent, buildLayoutPreview, buildBiome, buildStreets, buildRoadPaint, buildVoidGrid, buildBorderGlow, buildApron, buildTrafficLights, buildSignage, buildAwnings, buildFurniture, buildRailway, buildSkyway, buildSky, buildPedestrians, buildLandmarks, buildShotengai, buildWater, buildTerraces, makeElevation, makeHeightField, applyHeightField, regionAt, computeTraffic, computeTextSigns, cellLevelAt, hash2, makeDomainWarpInto, applyDomainWarp, cityStyle, CITY_STYLE_NAMES, Accum3D } from '../../world';
import type { LayoutParams, WorldGraph, RegionSeed, LayoutPreviewLayer, MoverSpec } from '../../world';
import { buildTileLayerGroups } from '../../world/tile-build';
import type { TileLayerGroup } from '../../world/tile-build';
import type { RenderStyle } from '../../renderer/3d/material-3d';
import type { PostProcessConfig } from '../../renderer/3d/post-process-pass';
import { StreamManager } from '../streaming/stream-manager';
import type { Focus, StreamBudget } from '../streaming/stream-manager';
import { CityStreamSource, tileKey } from '../streaming/city-stream-source';
import { TileWorkerPool } from '../streaming/tile-worker-pool';
import type { Camera3D } from '../../renderer/3d/camera-3d';

/** Dev logging for the world module — OFF by default (flip to true to trace generate/traffic in the console). */
const WORLD_VERBOSE = false;

// Streaming (Phases 1–3): the tile window follows `_streamFocus` (origin until follow drives it from the camera),
// and its radius + per-tile detail come from a zoom-derived budget (see `_streamBudget`). See
// docs/specs/spatial-streaming.md.

/** One DAY/NIGHT-CYCLE post keyframe: the bloom / colour-grade / vignette knobs at one phase of the day.
 *  The cycle lerps between the four phases as `timeOfDay` moves — the "cinematic grade" system. */
export interface TimeGradeKey {
    bloomThreshold: number;
    bloomIntensity: number;
    brightness: number;                 // −1..1 additive
    contrast: number;                   // −1..1
    saturation: number;                 // −1..1
    tint: [number, number, number];
    vignette: number;                   // 0 = off
}
export type TimeGradePhase = 'night' | 'dawn' | 'noon' | 'dusk';

/** Default cinematic keyframes: cool bloomy nights → warm dawns → neutral noons → golden dusks. */
const DEFAULT_TIME_GRADE: Record<TimeGradePhase, TimeGradeKey> = {
    night: { bloomThreshold: 0.5, bloomIntensity: 1.35, brightness: -0.04, contrast: 0.12, saturation: 0.05, tint: [0.86, 0.9, 1.12], vignette: 0.35 },
    dawn: { bloomThreshold: 0.65, bloomIntensity: 0.7, brightness: 0.0, contrast: 0.05, saturation: 0.1, tint: [1.06, 0.97, 0.94], vignette: 0.22 },
    noon: { bloomThreshold: 0.78, bloomIntensity: 0.4, brightness: 0.02, contrast: 0.04, saturation: 0.07, tint: [1, 1, 1], vignette: 0.14 },
    dusk: { bloomThreshold: 0.6, bloomIntensity: 0.95, brightness: -0.01, contrast: 0.09, saturation: 0.14, tint: [1.12, 0.93, 0.85], vignette: 0.28 },
};

/** One live traffic mover (a spawned MoverSpec + its meshes + route state). */
interface MoverRec {
    spec: MoverSpec; meshes: Mesh3D[]; len: number; t: number; dir: 1 | -1;
    pausedUntil: number; cooldownUntil: number; emote: Mesh3D | null;
    path: { pts: [number, number][]; cum: number[]; total: number } | null;
    /** In a door visit (walking to a door / inside a building) — excluded from routing, chat and car-yield. */
    visiting: boolean;
}
/** A building front door (stamped by streets' addEntrance) the visit sim can use. */
interface DoorSpot { x: number; z: number; lift: number; ox: number; oz: number; yaw: number; wx: number; wz: number }
/** A pedestrian's DOOR VISIT: walk to the door → it swings open → step in (despawn) → later come back out. */
interface DoorVisit { mv: MoverRec; door: DoorSpot; start: number; dur: number; leaf: Mesh3D }
/** In-flight progressive tile reassembly: groups accumulate into `out`; the tile's Promise resolves when `remaining` hits 0. */
// (Tile drape now happens IN THE WORKER — see src/world/drape.ts; reassembly is mesh-wrap + upload only.)
interface ReassembleCtx { out: MeshGroup3D[]; remaining: number; resolve: (m: MeshGroup3D[]) => void }

export class WorldManager {
    private _groups: MeshGroup3D[] = [];
    // TILED-world neighbour tiles are streamed via the generic StreamManager (src/services/streaming) — the same
    // content-agnostic engine the spatial-streaming spec generalises to non-city content. It owns the live tile
    // cache ("tx,tz" → that tile's groups), the async build queue (a few per frame → progressive reveal, no freeze),
    // and the reconcile diff (build newcomers, dispose out-of-range). The city plugs in via CityStreamSource below.
    // `_tileSig` = the content signature (seed + detail + every param EXCEPT tileRadius); if it changes the whole
    // cache is invalidated. The centre tile (0,0) is NOT streamed — it's the full city in `_groups`.
    private _stream!: StreamManager<MeshGroup3D[]>;             // constructed in the ctor (needs `this`)
    private _tileSig = '';
    private _tileParamsForBuild: LayoutParams | null = null;    // params the CityStreamSource builds/queries tiles with
    private _streamFocus: Focus = { x: 0, z: 0, scale: 1 };     // where the tile window centres — origin until follow drives it from the camera
    private _streamFollow = false;                              // follow the camera view (default OFF — the origin-centred diorama)
    private _maxRenderTiles = 5;                                // max render distance (tiles from view centre) + zoom-out cap: orthoSize is clamped to this × tileSpan
    private _maxLiveTiles = 40;                                 // hard cap on resident streamed tiles (maxLiveChunks safety net)
    private _fullTileBudget = 9;                               // max FULL-3D tiles resident (rest = flat proxies) — full tiles are ~tens of MB each
    private _lastVisibleSig = '';                              // last reconciled visible tile-key set — reconcile only when the view's tile set changes
    private _lastViewSig = '';                                 // last camera view signature — skip _streamCb work entirely when the view is unchanged
    private _compactTimer: ReturnType<typeof setTimeout> | null = null;   // geom-pool compaction fires this long after the stream settles (off the pan path)
    private _fogColor: [number, number, number] | null = null;   // current fog tint (from _applyTimeOfDay); null = fog off. Streaming re-derives zoom-aware fog distances from it
    private _tilePool: TileWorkerPool | null = null;           // Phase 4: Web Worker pool for off-thread tile generation (lazily created)
    private _workersEnabled = true;                            // toggle (salsaWorld.streamWorkers) — A/B the main-thread stall with/without workers
    private _reframeAfterTiles = false;   // frame to the whole world once the async tile build finishes (fresh builds only)
    // The placed City is one THIN-WRAPPER container: all world/traffic groups are its children, so the host
    // shows ONE outliner item and select/translate/rotate act on the whole city as a unit (transform composes
    // to every child via parentChainMatrix — no per-mesh iteration). Recreated per sync build; the placement
    // transform lives in `_cityTransform` and is re-applied, so it survives regens. In the City EDITOR the
    // container is kept at identity (edit upright); the placement applies in the illustration (out of edit).
    private _cityContainer: MeshGroup3D | null = null;
    private _cityTransform: { x: number; y: number; z: number; rx: number; ry: number; rz: number } =
        { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
    private _graph: WorldGraph | null = null;
    private _heightFn: (x: number, z: number) => number = () => 0;   // full elevation (smooth + terraces) applied to every layer
    private _smoothFn: (x: number, z: number) => number = () => 0;   // smooth terrain only — bridges use this so they arch OVER sunken canals
    // DOMAIN WARP — the final horizontal post-transform. ALLOCATION-FREE fill variant (writes into a scratch)
    // so the per-frame traffic tick's ~200 warp calls/frame don't churn ~12k throwaway arrays/sec (GC hitches).
    private _warpInto: (x: number, z: number, out: [number, number]) => void = (_x, _z, out) => { out[0] = 0; out[1] = 0; };
    private readonly _warpScratch: [number, number] = [0, 0];
    private _params: LayoutParams | null = null;   // last full params (after defaults) — the base for live edits
    private _autoFrame = true;                      // suppressed during live slider updates so orbit isn't yanked
    private _activeRegions: Set<number> | null = null;   // active-region editor: null = ALL districts build; else only these region ids
    private _cityMode = false;
    // Day/night cycle: 0 = midnight · 0.25 = sunrise · 0.5 = noon · 0.75 = sunset. null = untouched (editor lighting).
    private _timeOfDay: number | null = null;
    private _cyclePeriod = 120;
    private _renderStyle: RenderStyle | null = null;   // world-wide style override (cel / gouraud / …); null = PBR default
    // Traffic sim (v1): movers = individual meshes slid along their routes by the shared ticker.
    private _trafficOn = false;
    private _movers: MoverRec[] = [];
    // All movers (traffic + clouds) live over the CENTRE city. In follow mode, once you've panned the centre
    // fully off-screen they're wasted work (ticked + drawn every frame for nothing) → pause + hide them, resume
    // when the centre re-enters the view. Off in the diorama / non-tiled worlds (centre is always visible there).
    private _moversHidden = false;
    private _centreVisible = true;
    // DOOR VISITS: pedestrians occasionally walk to a stamped front door, it swings open, they step inside
    // (despawn) and come back out later. Two reusable animated door LEAVES serve all visits.
    private _visits: DoorVisit[] = [];
    private _doorSpots: DoorSpot[] = [];
    private _doorLeaves: Mesh3D[] = [];
    private _simTime = 0;      // seconds of sim time (chat pauses/cooldowns + weather anims key off this)
    private _chatTimer = 0;    // encounter scan throttle
    private _flash = 0;        // lightning strobe level (storms) — read by _applyTimeOfDay
    private _poseBuf = new Float32Array(0);   // reused mover pose scratch (x, z, hx, hz per mover — no per-frame allocs)
    // Cinematic grade: post-processing (bloom/grade/vignette) keyed to the time of day (4 lerped keyframes).
    private _gradeOn = false;
    private _gradeKeys: Record<TimeGradePhase, TimeGradeKey> = JSON.parse(JSON.stringify(DEFAULT_TIME_GRADE)) as Record<TimeGradePhase, TimeGradeKey>;
    private _prePostFX: PostProcessConfig | null = null;   // the host's config, captured on enable + restored on disable

    constructor(private readonly scene3d: Scene3DManager) {
        // Streamed neighbour tiles: the content-agnostic StreamManager drives the city's tiles through a
        // CityStreamSource whose hooks delegate back to this manager (build / dispose / progress / settled).
        this._stream = new StreamManager<MeshGroup3D[]>(new CityStreamSource({
            tileParams: () => this._tileParamsForBuild,
            buildTile: (p, tx, tz, proxy) => this._buildTile(p, tx, tz, proxy),
            buildTileAsync: (p, tx, tz) => this._buildTileAsync(p, tx, tz),
            canUseWorkers: () => this._workersEnabled && this._ensureTilePool().available,
            workerCount: () => this._tilePool?.size ?? 0,   // caps concurrent async dispatches to the pool size
            disposeTile: (groups, key) => this._disposeTileGroups(groups, key),
            onSlice: () => this.scene3d.requestRender3D(),
            onSettled: () => this._onTilesSettled(),
        }));
        // DEV hook so a world can be triggered from the browser console before Frogmarks has UI for it:
        //   salsaWorld.generate({ border: 'circle', pattern: 'radial', seed: 3 })   ·   salsaWorld.clear()
        //   salsaWorld.enterMode({...}) / .update({ seed: 9 }) / .exitMode()  drive the City-Tool mode.
        if (typeof window !== 'undefined') {
            (window as unknown as { salsaWorld?: unknown }).salsaWorld = {
                generate: (p: Partial<LayoutParams> = {}) => this._log(this.generateWorld(p)),
                layout: (p: Partial<LayoutParams> = {}) => this._log(this.generateLayout(p)),
                biome: () => this._log(this.generateBiome()),
                streets: () => this._log(this.generateStreets()),
                enterMode: (p?: Partial<LayoutParams>) => this._log(this.enterCityMode(p)),   // no args = resume existing city
                exitMode: () => this.exitCityMode(),
                update: (p: Partial<LayoutParams> = {}) => this._log(this.updateCity(p)),
                region: (id: number | null) => this.setActiveRegion(id),   // focus ONE district; null = whole city
                toggle: (id: number) => this.toggleRegion(id),             // enable/disable one district (multi-select)
                setRegions: (ids: number[] | null) => this.setActiveRegions(ids),   // exact enabled set; null = all
                regions: () => this.regions,
                time: (t: number) => this.setTimeOfDay(t),                 // 0 midnight · 0.25 dawn · 0.5 noon · 0.75 dusk
                cycle: (periodSec = 120) => periodSec > 0 ? this.playDayCycle(periodSec) : this.stopDayCycle(),
                spin: (degPerSec = 6) => this.setTurntable(degPerSec),     // ◉ slow turntable orbit; spin(0) stops
                style: (s: RenderStyle | null) => this.setRenderStyle(s),  // 'cel'|'cel-hd'|'sketch'|'ink'|'gouraud'|null(PBR)
                pack: (name: string) => this.applyStyle(name),             // one-call style pack: tokyo|oldtown|seaside|noir|toon|retro
                packs: () => this.styleNames,
                traffic: (on = true) => on ? this.startTraffic() : this.stopTraffic(),   // ▶ moving cars/train/walkers
                grade: (on = true) => this.setCinematicGrade(on),          // cinematic post keyed to the time of day
                gradeKey: (k: TimeGradePhase, v: Partial<TimeGradeKey>) => this.setTimeGradeKey(k, v),   // tune a keyframe live
                perf: () => this.scene3d.getPerf3D(),   // paste when frames dip — poolRebuilds/atlasRebuilds climbing = the culprit
                frameStats: () => this.scene3d.getFrameStats3D(),   // ◧ per-frame render profile: drawCalls / meshes / arrayGroups / instances / msTotal / msUpload / msShadow (find the bottleneck)
                debug: () => ({   // paste this output when something looks stuck
                    trafficOn: this._trafficOn, movers: this._movers.length, tickerRunning: this._tickerRaf !== 0,
                    streamFollow: this._streamFollow, centreVisible: this._centreVisible, moversPaused: this._moversHidden,   // follow mode: movers pause when centre off-screen
                    cycleOn: this._cycleOn, timeOfDay: this._timeOfDay, cityMode: this._cityMode,
                    groups: this._groups.length, hasGraph: !!this._graph,
                    preRenderCbs: this.scene3d.getPreRenderCallbackCount3D(),   // should be STABLE across regens; climbing = a per-frame callback leak
                    sceneMeshes: this.scene3d.getAllMeshes().length,   // ★ CURRENT scene mesh count — if this CLIMBS per regen, old cities leak into the scene graph (Salsa); if FLAT while heap grows, the leak is host-side
                    geomPool: this.scene3d.getGeomPoolStats3D(),       // liveAllocs≈sceneMeshes; appendsSinceCompact/vtxUsedMB climbing = pool not compacting (VRAM, not lag)
                    lastRegen: this._lastRegen,   // ms + 'full' vs 'selective: <units>' — slider-lag diagnosis
                    moverSample: this._movers[0] ? { t: this._movers[0].t, x: (this._movers[0].meshes[0] as { x?: number })?.x } : null,
                }),
                clear: () => this.clear(),
                cityId: () => this.getCityContainerId(),                                 // the one City wrapper node id
                move:   (t: Partial<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }>) => this.setCityTransform(t),  // translate/rotate the placed city (radians for rx/ry/rz)
                transform: () => this.getCityTransform(),
                tiles:  (r = 1, detail: 'flat' | 'focus' | 'full' = 'focus') => this._log(this.updateCity({ worldMode: 'tiled', tileRadius: r, tileDetail: detail })),   // ▦ N×N tiles (r=1 → 3×3); detail 'flat'|'focus'|'full'
                untile: () => this._log(this.updateCity({ worldMode: 'diorama' })),                     // back to one city
                restore: () => this.restoreFromSave(),                                                   // regenerate the city from a loaded save's params (host calls this on doc load)
                detailLod: (on = true, far?: number) => this.setCityDetailLOD(on, far),                   // ◧ zoom-gated fine-detail cull; far = camera dist (world units) past which balconies/trim/props stop drawing
                streamFollow: (on = true) => this.setStreamFollow(on),                                     // ▤ tiled worlds: stream the tile window to follow the camera (pan → tiles load ahead / unload behind)
                streamMaxDist: (n = 5) => this.setStreamMaxDist(n),                                         // ▤ max render distance in tiles (2–8) + zoom-out cap; bounds the resident set for huge worlds
                dynRes: (on = true) => this.setDynamicResEnabled(on),                                       // ◨ pan-time dynamic resolution (0.78× while the camera moves) — off to A/B crispness
                streamWorkers: (on = true) => this.setStreamWorkers(on),                                    // ▤ Web-Worker off-thread tile generation (default ON); off = main-thread build (A/B the stall)
                streamStats: () => this.getStreamStats(),                                                  // ▤ streaming state: focus tile + live/pending tile counts
                manager: this,
            };
        }

        // When the placed City is moved/rotated via the transform gizmo, the controller writes the container's
        // own transform directly — mirror it back into `_cityTransform` so the placement persists + survives
        // regens (same path as the console `move()`). Skipped in the editor, where the transform is forced identity.
        this.scene3d.setThinWrapperTransformSync((c) => {
            if (this._cityMode) return;
            if (c !== this._cityContainer) return;   // ignore Building thin-wrappers (they own their own sync)
            this.setCityTransform({ x: c.x, y: c.y, z: c.z, rx: c.rotationX, ry: c.rotationY, rz: c.rotation });
        });

        this.scene3d.addPreRenderCallback3D(this._lodCb);   // zoom-gated city detail LOD (registered once, stable across regens)
        this.scene3d.addPreRenderCallback3D(this._streamCb); // tiled-world focus follow (streams the tile window to the camera)
    }

    // ── City detail LOD (zoom-gated draw cull) ───────────────────────────────────────────────────────────────
    // The high-count detail is invisible from a zoomed-out view but dominates the tri count. Hide it past a zoom
    // threshold, restore on zoom-in. DRAWS-ONLY — visibility=false skips the DRAW; the geometry STAYS resident in
    // VRAM (this frees frame/compute cost, NOT memory; the 147 MB win is the later don't-generate tier). TWO tiers:
    //  · Tier 1 (~25% zoom): FINE detail + the little movers (walkers/birds) + static crowd. `world:traffic-walker`
    //    covers walker+skin; robot-visor too; EXCLUDES `world:traffic-emote` (chat bubbles own their vis). Cars/
    //    trains/flyers/holos keep drawing (bigger, read at city scale).
    //  · Tier 2 (~10% zoom, deeper): ROOF OBJECTS — the clutter/equipment/markings ON the roofs. NOT the roof DECK
    //    (`world:roofs` / `world:detail-roof`), which is the building silhouette and must stay.
    private static readonly DETAIL_LOD = /world:detail-juliet|world:detail-windowtrim|world:detail-greenery|world:detail-bloom|world:detail-sign|world:detail-screen|world:detail-awning|world:detail-pfoliage|world:detail-trim|world:balcony|world:signal-|awning-|textsign-|world:sign-|util-wire|laundry|alley-clutter|noren|world:ped-|world:traffic-walker|world:traffic-robot-visor|world:traffic-bird/;
    private static readonly ROOF_LOD = /world:roof-detail|world:roof-equip|world:roof-mark|world:detail-roof-equip/;
    // Tier 2b (PROPS): all the small scene furniture — invisible once tiles are small, but a huge chunk of the draw
    // count. Trees / rocks / lamp posts / parked cars / utility poles / benches / bus stops / bikes / vending / signs
    // / screens / apron nature. Keeps building bases, roofs, roads, landmarks (the readable-from-afar silhouette).
    private static readonly PROPS_LOD = /world:tree-|world:rocks|world:apron-foliage|world:apron-rocks|world:apron-trunks|world:lightpoles|world:lamplights|world:lamp-pool|world:util-pole|world:car-|world:bench|world:busstop|world:bicycle|world:cabinet|world:cone|world:guardrail|world:manhole|world:planter|world:postbox|world:vending-|world:sg-lantern|world:sg-struct|world:screen-|world:park-prop|world:cafe-terrace|world:shopfront|world:construction|world:tactile|world:retaining|world:stairs|world:stair-rail|world:bridge-rail|world:bridge-railpost|world:bridge-lamplights|world:water-rail|world:water-railposts/;
    // Tier 3 (FAR-PROXY): the flat-map FINE layers — sidewalks / courtyards / plaza paving. Many small meshes that
    // are invisible once tiles are small on screen; hiding them slashes the zoomed-out draw count. Roads + zone
    // ground colour stay, so the city pattern is preserved. Applies to every tile (all are small when zoomed out).
    private static readonly FLATMAP_LOD = /world:sidewalks|world:courtyard|world:plaza|world:sg-paving|world:parking/;
    // Tier 4 (STRUCTURE — extreme zoom-out): past this band only the "basic structure" remains — roads, zone ground,
    // building bodies + shells, roof decks, landmark massing, water, backdrop. Hides road paint, the rail viaduct
    // (never the train — its visibility belongs to the traffic system), shotengai fabric, bridge dressing, fountain
    // spray, landmark ornament. DELIBERATELY DISJOINT from every other tier (lookaheads carve out their matches):
    // an outer tier re-SHOWING on zoom-in must never un-hide meshes an inner, still-hidden tier owns.
    // (roadpaint deliberately NOT here — lane lines/crosswalks are ~3MB and carry the map's readability zoomed out.)
    private static readonly STRUCTURE_LOD = /world:rail-(?!train)|world:sg-(?!lantern|struct|paving)|world:bridge-stone|world:bridge-paint|world:fountain-water|world:lm-accent|world:lm-glass|world:lm-field|world:lm-red|world:lm-steps/;
    private _lodEnabled = true;
    private _lodFar = 0;               // explicit Tier-1 override in the active zoom metric; 0 = auto (from city extent)
    private _lodShown = true;          // Tier 1 (fine detail) currently drawn?
    private _lodRoofShown = true;      // Tier 2 (roof objects) currently drawn?
    private _lodPropsShown = true;     // Tier 2b (trees/rocks/lamps/cars/furniture) currently drawn?
    private _lodFlatShown = true;      // Tier 3 (flat-map fine layers: sidewalks/courtyards/plaza) currently drawn?
    private _lodStructShown = true;    // Tier 4 (extreme zoom-out: everything but roads/bodies/ground) currently drawn?
    private _lodCityR = 12;            // city world radius (max |lot.center|) — basis for the auto thresholds
    private _lodRGraph: WorldGraph | null = null;   // which graph _lodCityR was computed for (memo invalidation)
    // Scene "epoch" — bumped whenever visible nodes enter `_groups` (add / reveal / traffic spawn). The LOD re-hide
    // only re-walks the scene graph when the epoch advanced (new nodes might have spawned visible), NOT every frame —
    // a big zoomed-out saving on a tiled world. A slow safety re-apply (every 30 frames) covers any missed bump.
    private _sceneEpoch = 0;
    private _lodAppliedEpoch = -1;
    private _lodFrame = 0;
    private readonly _lodCb = (): boolean => {
        if (!this._lodEnabled || !this._cityContainer || this._groups.length === 0) return false;
        // City world radius (max lot distance from centre — SAME space as the camera; scale-independent). Recompute
        // only when the graph changes.
        if (this._graph && this._lodRGraph !== this._graph) {
            this._lodRGraph = this._graph;
            let r2 = 0;
            for (const l of this._graph.lots) { const d = l.center[0] * l.center[0] + l.center[1] * l.center[1]; if (d > r2) r2 = d; }
            this._lodCityR = Math.sqrt(r2) + 3;
        }
        // Key the LOD off the VISIBLE zoom: under ORTHO that's orthoSize (view half-height in world units) — the
        // camera→centre distance is meaningless there (the ortho dolly is invisible), which is exactly why an
        // alt-scroll dolly must NOT move the LOD. Under perspective, distance is the zoom.
        const cam = this.scene3d.getCamera();
        const ortho = cam.mode === 'orthographic';
        // Perspective metric = camera→TARGET distance (the dolly), NOT |position| — distance-from-origin would
        // inflate with pan distance in follow mode and hide detail at a constant zoom purely for panning away.
        const metric = ortho ? cam.orthoSize
            : Math.hypot(cam.position[0] - cam.target[0], cam.position[1] - cam.target[1], cam.position[2] - cam.target[2]);
        const R = this._lodCityR;
        // Tier 1 ≈ 25% zoom, Tier 2 (roof objects) ≈ 20% (orthoSize ∝ 1/zoom%, so 25→20 is a ×1.25 bigger orthoSize).
        // Tune Tier 1 via salsaWorld.detailLod(true, <orthoSize>); Tier 2 tracks it at ×1.25.
        const farDetail = this._lodFar || (ortho ? R * 0.19 : R * 1.9);
        const farRoof = (this._lodFar || (ortho ? R * 0.19 : R * 1.9)) * 1.25;
        // Re-hide the hidden tiers only when the scene graph changed (new nodes may have spawned visible). All the
        // add paths bump the epoch (audited), so the safety sweep is a slow backstop (every 300 frames ≈ 5 s), not
        // the twice-a-second full tree walk × 5 tiers it used to be.
        const dirty = this._sceneEpoch !== this._lodAppliedEpoch || (++this._lodFrame % 300 === 0);
        this._lodShown = this._tier(metric, farDetail, this._lodShown, WorldManager.DETAIL_LOD, dirty);
        this._lodRoofShown = this._tier(metric, farRoof, this._lodRoofShown, WorldManager.ROOF_LOD, dirty);
        this._lodPropsShown = this._tier(metric, farDetail * 1.2, this._lodPropsShown, WorldManager.PROPS_LOD, dirty);   // hide props (trees/cars/lamps/furniture) just past fine detail
        this._lodFlatShown = this._tier(metric, farDetail * 1.4, this._lodFlatShown, WorldManager.FLATMAP_LOD, dirty);   // hide flat-map fine layers a touch past the detail cutoff
        this._lodStructShown = this._tier(metric, farDetail * 1.7, this._lodStructShown, WorldManager.STRUCTURE_LOD, dirty);   // Tier 4: extreme zoom-out → basic structure only
        if (dirty) this._lodAppliedEpoch = this._sceneEpoch;   // caught up to the current epoch
        return false;
    };

    /** One LOD tier: hysteresis compare + apply on a state change; while HIDDEN, re-apply ONLY when `dirty` (the
     *  scene graph changed) so a regen / traffic respawn (new nodes spawn visible=true) gets re-hidden without a
     *  per-frame full tree walk. Returns the new shown-state. */
    private _tier(metric: number, far: number, shown: boolean, re: RegExp, dirty: boolean): boolean {
        const show = shown ? metric < far * 1.12 : metric < far * 0.9;   // hysteresis → no boundary flicker
        if (show !== shown) this._applyLOD(re, show);
        else if (!show && dirty) this._applyLOD(re, false);
        return show;
    }

    /** Toggle / tune the zoom-gated city detail LOD. `farDistance` = the Tier-1 threshold in the active zoom metric
     *  (omit to keep the radius-derived default; pass 0 to reset to it). Tier 2 (roof objects) tracks it at ×2.5. */
    setCityDetailLOD(enabled: boolean, farDistance?: number): void {
        this._lodEnabled = enabled;
        if (farDistance !== undefined) this._lodFar = farDistance;
        if (!enabled) {   // force-show every tier
            if (!this._lodShown) { this._lodShown = true; this._applyLOD(WorldManager.DETAIL_LOD, true); }
            if (!this._lodRoofShown) { this._lodRoofShown = true; this._applyLOD(WorldManager.ROOF_LOD, true); }
            if (!this._lodPropsShown) { this._lodPropsShown = true; this._applyLOD(WorldManager.PROPS_LOD, true); }
            if (!this._lodFlatShown) { this._lodFlatShown = true; this._applyLOD(WorldManager.FLATMAP_LOD, true); }
            if (!this._lodStructShown) { this._lodStructShown = true; this._applyLOD(WorldManager.STRUCTURE_LOD, true); }
        }
    }

    private _applyLOD(re: RegExp, show: boolean): void {
        const stack: Array<{ name: string; visible: boolean; children?: unknown[] }> = [...(this._groups as unknown as { name: string; visible: boolean; children?: unknown[] }[])];
        while (stack.length) {
            const n = stack.pop()!;
            if (re.test(n.name)) { n.visible = show; continue; }   // hide the node (+ its subtree) — hidden ArrayGroups are skipped in the sync
            if (n.children) for (const k of n.children) stack.push(k as typeof n);
        }
    }

    // ── Streaming focus follow + zoom-adaptive detail (Phases 2–3) ───────────────────────────────────────────
    // Drive the streamed tile window from the camera so PANNING a tiled world loads tiles ahead and unloads behind,
    // and ZOOMING resizes the window + swaps far tiles to cheap proxies. The focus is the orbit LOOK-AT
    // (`camera.target`) — stable under orbit (rotating in place doesn't move it) and exactly the ground point being
    // studied. It's read in CITY-LOCAL space (target minus the city placement), the same upright-at-origin framing
    // the LOD assumes. Re-syncs only when the focus crosses a TILE boundary OR the zoom crosses a detail band (both
    // hysteretic) — never per frame — so the cost stays O(one reconcile per crossing), not O(world)/frame.
    // Default OFF: a pinned origin window, full detail = today's diorama. The origin tile (0,0) stays resident as the
    // full centre city (see CityStreamSource); a Phase-4 street view will let even that unload.
    private readonly _streamCb = (): boolean => {
        const p = this._params;
        if (!p || p.worldMode !== 'tiled' || !this._cityContainer) return false;
        const span = 2 * (p.radius ?? 0);
        if (span <= 0) return false;
        const cam = this.scene3d.getCamera();
        // ZOOM-OUT CAP + max render distance: never zoom past where `_maxRenderTiles` fill the view — keeps the
        // streamed set bounded and the world always looks populated. Ortho only (perspective radius is capped by the
        // orbit controller's maxRadius). Applies whether or not follow is on, whenever a tiled world is active.
        if (cam.mode === 'orthographic') {
            const maxOrtho = this._maxRenderTiles * span;
            if (cam.orthoSize > maxOrtho) { cam.orthoSize = maxOrtho; this.scene3d.requestRender3D(); }
        }
        if (!this._streamFollow) return false;
        // CAMERA-MOVED GATE: skip the projection + reconcile entirely when the view is unchanged since last frame
        // (free — no work while idle, and no streaming churn when you're not moving).
        const vsig = `${cam.target[0].toFixed(2)}|${cam.target[2].toFixed(2)}|${cam.orthoSize.toFixed(3)}|${cam.position[0].toFixed(1)}|${cam.position[1].toFixed(1)}|${cam.position[2].toFixed(1)}`;
        if (vsig === this._lastViewSig) return false;
        this._lastViewSig = vsig;
        // The camera IS moving (view-signature changed) → drop the render scale until it settles.
        this._kickDynamicRes();
        // ZOOM-AWARE FOG: the static day/night fog (scaled to the city radius) drowns a zoomed-out tiled world in
        // haze — the view reaches far past its far plane. Re-derive the distances from the camera's actual REACH
        // (orbit radius + view half-extent) so the visible tiles stay clear, with fog only just beyond the edge.
        // REACH-gated: a pure pan moves position and target TOGETHER (reach unchanged) → zero fog work.
        if (this._fogColor) {
            const reach = Math.hypot(cam.position[0] - cam.target[0], cam.position[1] - cam.target[1], cam.position[2] - cam.target[2])
                + (cam.mode === 'orthographic' ? cam.orthoSize : 0);
            if (Math.abs(reach - this._lastFogReach) > this._lastFogReach * 0.01) {
                this._lastFogReach = reach;
                this.scene3d.setFog3D({ mode: 'linear', color: this._fogColor, near: reach * 0.95, far: reach * 2.2, density: 0.1 });
            }
        }
        // COARSE MOVEMENT GATE: everything below (centre check, mover/shadow gates, the 121-tile projection scan +
        // sort + key strings) only matters once the camera has moved a MEANINGFUL amount — a 1/32-tile step or ~1%
        // zoom. Small quick back-and-forth pans stay inside one quantum and skip it all (the tile-set membership
        // hysteresis margins are far wider than a quantum, so nothing can change inside one).
        const q = span / 32;
        const csig = `${Math.round(cam.target[0] / q)},${Math.round(cam.target[2] / q)},${Math.round(cam.position[0] / q)},${Math.round(cam.position[1] / q)},${Math.round(cam.position[2] / q)},${Math.round(Math.log2(Math.max(1e-3, cam.orthoSize)) * 64)}`;
        if (csig === this._lastCoarseSig) return false;
        this._lastCoarseSig = csig;
        // CENTRE-CITY MOVER GATE: all movers (traffic + clouds) sit over the centre tile (0,0). Once it's fully
        // off-screen — OR the view is zoomed out past the props LOD band, where cars are sub-pixel — they're pure
        // waste (ticked + transform-uploaded every frame); pause + hide, resume when the centre is back and near.
        const vpc = cam.getViewProjectionMatrix() as Float32Array;
        const centreVisible = this._tileScreenRank(vpc, this._cityTransform.x, this._cityTransform.y, this._cityTransform.z, p.radius) >= 0;
        this._centreVisible = centreVisible;
        const moversZoomedOut = cam.mode === 'orthographic' && cam.orthoSize > (this._lodFar || this._lodCityR * 0.19) * 1.2;
        this._setMoversHidden(!centreVisible || moversZoomedOut);   // no-ops when the state is unchanged
        // Off-screen centre → GROUP-hide its non-backdrop groups: thousands of meshes leave the per-frame walk.
        this._setCentreHidden(!centreVisible);
        // Zoomed out past the props band, shadows are sub-pixel — skip the whole-scene shadow depth pass.
        this.scene3d.setShadowsSuspended3D(moversZoomedOut);
        // Stream exactly the tiles whose footprint is IN THE CAMERA VIEW (projection-based → tracks pan/zoom/orbit).
        // Reconcile only when that tile SET changes (sub-tile pans don't rebuild anything).
        const keys = this._visibleTileKeys(p, cam, span);
        const sig = keys.join('|');
        if (sig === this._lastVisibleSig) return false;
        this._lastVisibleSig = sig;
        this._tileParamsForBuild = p;
        this._stream.reconcile(keys);
        this.scene3d.requestRender3D();
        this._scheduleIdleCompact();   // reclaim the disposed tiles' dead space once the view settles (off the pan path)
        return false;
    };

    /** After the streamed view settles (no change for a beat), compact the geometry pool ONCE to reclaim the dead
     *  space disposed tiles leave behind — so the ~68 ms full re-upload lands on a still frame, never mid-pan. Reset
     *  on every reconcile, so continuous panning defers it until you pause. */
    private _scheduleIdleCompact(): void {
        if (this._compactTimer) clearTimeout(this._compactTimer);
        this._compactTimer = setTimeout(() => {
            this._compactTimer = null;
            this.scene3d.requestGeomCompaction3D();
            this.scene3d.requestRender3D();
        }, 350);
    }

    /** Pause/resume the movers (traffic + clouds) when the centre city leaves/re-enters the view (follow mode).
     *  HIDE: skip the per-frame tick + hide every mover mesh. SHOW: re-show them (bar chat emotes, which the tick
     *  owns) and restart the ticker if it had wound down. Cheap — flips `visible` flags, never rebuilds geometry. */
    private _setMoversHidden(hidden: boolean): void {
        if (hidden === this._moversHidden || !this._movers.length) { this._moversHidden = hidden; return; }
        this._moversHidden = hidden;
        for (const mv of this._movers) {
            for (const m of mv.meshes) {
                if ((m.name ?? '') === 'world:traffic-emote') continue;   // chat-driven bubble — leave it to _tickTraffic
                m.visible = !hidden;
            }
            if (mv.emote && hidden) mv.emote.visible = false;   // drop any live chat bubble while paused
        }
        if (!hidden) this._ensureTicker();   // the ticker may have wound down while paused — kick it back on
        this.scene3d.requestRender3D();
    }

    /** GROUP-hide the centre city when it's fully off-screen (follow mode). Its groups' meshes leave the sync +
     *  per-frame renderer walk entirely; instance slots stay allocated (no evict), so the re-show is ~free through
     *  the incremental path. Backdrop groups that frame the WHOLE tiled world (apron/void grid/glow/sky) stay. */
    private _setCentreHidden(hidden: boolean): void {
        if (hidden === this._centreHidden) return;
        this._centreHidden = hidden;
        for (const g of this._groups) {
            if (this._tileGroups.has(g)) continue;                       // streamed tiles manage their own lifecycle
            if (WorldManager.CENTRE_KEEP.test(g.name ?? '')) continue;   // world-extent backdrop stays
            g.visible = !hidden;
        }
        this.scene3d.requestRender3D();
    }

    /** Drop the render scale while the camera moves (called per view change), restore after stillness. Fill-rate
     *  is the dominant zoomed-out GPU cost; 0.78× ≈ 40% fewer fragments, invisible mid-pan (linear upscale through
     *  the lo-res path). ENGAGES only after 150 ms of SUSTAINED movement — each lo-res↔native switch reallocates
     *  the size-dependent pass textures (bloom chain &co), so a quick nudge must never pay that round-trip. */
    private _kickDynamicRes(): void {
        if (!this._dynResEnabled) return;
        const now = performance.now();
        if (!this._dynResMoveStart) this._dynResMoveStart = now;
        if (!this._dynResOn && now - this._dynResMoveStart >= 150) {
            this._dynResOn = true;
            this.scene3d.setDynamicResScale3D(0.78);
        }
        if (this._dynResTimer) clearTimeout(this._dynResTimer);
        this._dynResTimer = setTimeout(() => {
            this._dynResTimer = null;
            this._dynResMoveStart = 0;   // the movement burst ended
            if (this._dynResOn) {
                this._dynResOn = false;
                this.scene3d.setDynamicResScale3D(1);
                this.scene3d.requestRender3D();   // re-render the settled view at native res
            }
        }, 400);
    }

    /** Toggle the pan-time dynamic resolution (console: `salsaWorld.dynRes(false)` to A/B the crispness). */
    setDynamicResEnabled(on: boolean): void {
        this._dynResEnabled = on;
        if (!on) {
            if (this._dynResTimer) { clearTimeout(this._dynResTimer); this._dynResTimer = null; } this._dynResMoveStart = 0;
            if (this._dynResOn) { this._dynResOn = false; this.scene3d.setDynamicResScale3D(1); this.scene3d.requestRender3D(); }
        }
    }

    // HYSTERESIS state for the visible-tile computation — both boundaries need a deadband or panning THRASHES:
    //  · membership: a tile hovering at the frustum edge would enter/leave every frame → build/dispose churn.
    //    Tiles IN the set last reconcile use a wider exit margin (0.5 NDC) than the 0.2 entry margin.
    //  · the full/proxy split: tiles straddling rank #budget would swap full↔proxy every frame → the WORST churn
    //    (a full tile is a worker build + tens of MB). Previously-full tiles keep their seat while still ranked
    //    inside 1.5× the budget; fresh tiles only take seats that remain. Keys are packed ints (no string churn).
    private _prevVisTiles = new Set<number>();
    private _prevFullTiles = new Set<number>();

    // Streamed-tile groups (vs the centre city's) — membership drives the centre-hide and the retire cache.
    private readonly _tileGroups = new Set<MeshGroup3D>();
    // CENTRE-CITY HIDE: when the centre (0,0) is fully off-screen in follow mode, its groups (thousands of meshes)
    // are group-hidden — they leave the renderer's per-frame mesh walk entirely. Backdrop groups that frame the
    // WHOLE tiled world (not just the centre) stay. Their instance slots stay allocated, so re-show is ~free.
    private _centreHidden = false;
    private static readonly CENTRE_KEEP = /World Apron|World Void Grid|World Border Glow|World Sky/;
    // RETIRED-TILE LRU (the procedural win: seed+coords fully determine a tile, so this can never be stale-wrong
    // while the params object is unchanged): a disposed FULL tile keeps its BUILT groups — draped geometry, layer
    // materials, everything — as plain JS objects. Panning back re-ATTACHES them: no worker round-trip, no drape,
    // no mesh construction; just a geometry re-upload (spread by warmGeometry). Byte-capped, insertion-order LRU.
    private readonly _tileRetired = new Map<string, { groups: MeshGroup3D[]; bytes: number }>();
    private _tileRetiredBytes = 0;
    private static readonly TILE_RETIRE_CAP = 256 * 1024 * 1024;   // CPU-side cap (~6-10 full tiles)
    // DYNAMIC RESOLUTION: drop the render scale while the camera is moving (fill-rate is the zoomed-out GPU cost),
    // restore on settle. Driven from _streamCb's view-changed signature; 250 ms of stillness restores native res.
    private _dynResEnabled = true;
    private _dynResOn = false;
    private _dynResTimer: ReturnType<typeof setTimeout> | null = null;
    private _dynResMoveStart = 0;   // when the current movement burst began (0 = camera still) — the engage delay
    // Tiny-pan waste gates: fog only re-derives when the camera REACH actually changes (a pure pan doesn't move
    // it), and the tile-set scan only reruns once the camera crosses a coarse movement quantum (1/32 tile / ~1%
    // zoom) — sub-quantum back-and-forth jiggle skips the 121-tile projection + sort + key churn entirely.
    private _lastFogReach = 0;
    private _lastCoarseSig = '';

    /** The tiles whose ground footprint is CURRENTLY IN THE CAMERA VIEW — projection-based, so it tracks pan, zoom
     *  AND orbit exactly (a square radius around the pivot can't — orbit doesn't move the pivot). Nearest-to-view
     *  first; the closest `_fullTileBudget` get FULL 3D, the rest cheap flat proxies (full tiles are ~tens of MB, so
     *  only a handful can be resident). Bounded by `_maxRenderTiles` (search + zoom cap) and `_maxLiveTiles`. */
    private _visibleTileKeys(p: LayoutParams, cam: Camera3D, span: number): string[] {
        const vp = cam.getViewProjectionMatrix() as Float32Array;
        const ctx = this._cityTransform.x, cty = this._cityTransform.y, ctz = this._cityTransform.z;
        const r = p.radius;
        const cxT = Math.round((cam.target[0] - ctx) / span);   // centre the candidate scan on the orbit look-at tile
        const czT = Math.round((cam.target[2] - ctz) / span);
        const R = this._maxRenderTiles;
        const pack = (tx: number, tz: number): number => (tx + 8192) * 16384 + (tz + 8192);
        const vis: Array<{ tx: number; tz: number; rank: number; id: number }> = [];
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
            const tx = cxT + dx, tz = czT + dz;
            if (tx === 0 && tz === 0) continue;   // centre city — never streamed
            const id = pack(tx, tz);
            const margin = this._prevVisTiles.has(id) ? 0.5 : 0.2;   // sticky membership (see hysteresis note)
            const rank = this._tileScreenRank(vp, tx * span + ctx, cty, tz * span + ctz, r, margin);
            if (rank >= 0) vis.push({ tx, tz, rank, id });
        }
        // FULL detail goes to the tiles nearest the SCREEN CENTRE (where you're looking), not nearest the pivot —
        // in an angled/orbit view the pivot sits low on screen, which is why the centre used to read as flat.
        vis.sort((a, b) => a.rank - b.rank);
        if (vis.length > this._maxLiveTiles) vis.length = this._maxLiveTiles;   // hard cap (maxLiveChunks safety net)
        this._prevVisTiles = new Set(vis.map(t => t.id));
        const canProxy = p.tileDetail === 'full';
        if (!canProxy) return vis.map(t => tileKey(t.tx, t.tz, false));
        // Sticky full/proxy split: seats go FIRST to previously-full tiles still ranked inside the 1.5× band (no
        // demote at the raw boundary), THEN nearest-first to fresh tiles while seats remain. Full count ≤ budget
        // always; a previous full only loses its seat by falling past the band (or out of view) — never by a
        // one-rank jitter against a neighbour.
        const budget = this._fullTileBudget;
        const band = Math.min(vis.length, Math.ceil(budget * 1.5));
        const full = new Set<number>();
        for (let i = 0; i < band && full.size < budget; i++) if (this._prevFullTiles.has(vis[i].id)) full.add(vis[i].id);
        for (let i = 0; i < vis.length && full.size < budget; i++) full.add(vis[i].id);
        this._prevFullTiles = full;
        // BUILD-LEVEL detail LOD: zoomed out past the props band (hysteretic — reuse the LOD tier state so the
        // boundary can't flap), full tiles build as "|l" LITE (detailedBuildings OFF). Their detail would be
        // LOD-HIDDEN anyway, but a detailed tile still costs ~4-5× to generate/upload/keep + its ArrayGroups
        // force full repacks — lite tiles make detail-on streaming cost what detail-off costs. Zooming back in
        // re-keys them to full detail; the chunkId tier-flip hold swaps without a hole, and both tiers retire
        // to the LRU under their own keys.
        const lite = (p.detailedBuildings ?? false) && !this._lodPropsShown;
        return vis.map(t => tileKey(t.tx, t.tz, !full.has(t.id), lite));
    }

    /** A tile's ground footprint (a `2r` square at world (wx,wy,wz)) projected to the screen: returns its squared
     *  NDC-centre distance (0 = dead centre of the view) if it's IN the viewport, else −1 (culled). Used both to cull
     *  and to RANK prominence — central tiles get full detail, peripheral ones stay flat proxies. `margin` widens
     *  the in-view test (callers pass a wider one for already-resident tiles — membership hysteresis). */
    private _tileScreenRank(m: Float32Array, wx: number, wy: number, wz: number, r: number, MARGIN = 0.2): number {
        let anyFront = false, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let c = 0; c < 4; c++) {
            const x = wx + (c === 0 || c === 3 ? -r : r);
            const z = wz + (c < 2 ? -r : r);
            const cw = m[3] * x + m[7] * wy + m[11] * z + m[15];
            if (cw <= 1e-4) continue;   // corner behind the camera
            anyFront = true;
            const nx = (m[0] * x + m[4] * wy + m[8] * z + m[12]) / cw;
            const ny = (m[1] * x + m[5] * wy + m[9] * z + m[13]) / cw;
            if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
            if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
        }
        if (!anyFront || maxX < -1 - MARGIN || minX > 1 + MARGIN || maxY < -1 - MARGIN || minY > 1 + MARGIN) return -1;
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;   // NDC centre of the footprint
        return cx * cx + cy * cy;
    }

    /** The follow-OFF (diorama) budget: the all-full origin grid at `tileRadius`. When follow is ON the resident set
     *  comes from `_visibleTileKeys` (projection-based) instead, not from a budget. */
    private _streamBudget(p: LayoutParams): StreamBudget {
        const cap = Math.max(0, Math.min(3, (p.tileRadius ?? 1) | 0));
        return { loadRadius: cap, detailRadius: cap, unloadRadius: cap, maxLiveChunks: 999 };
    }

    /** Sync the resident tiles for the current mode (used by generate/regen and the follow toggle). Follow ON →
     *  defer to the per-frame `_streamCb` (projection-based visible set); follow OFF → the all-full diorama grid. */
    private _streamSyncNow(p: LayoutParams): void {
        this._tileParamsForBuild = p;
        // Force _streamCb through ALL its gates next frame (view + coarse + set sigs) — with a static camera the
        // stale signatures would otherwise early-return and the reconcile would never run (latent re-enable bug).
        if (this._streamFollow) { this._lastVisibleSig = ''; this._lastViewSig = ''; this._lastCoarseSig = ''; return; }
        this._stream.sync(this._streamFocus, this._streamBudget(p));
    }

    /** Toggle tiled-world streaming follow. ON = the resident tiles track the CAMERA VIEW (pan/zoom/orbit); OFF =
     *  snap back to the origin-centred, all-full diorama grid. No-op on non-tiled worlds. */
    setStreamFollow(on: boolean): void {
        this._streamFollow = on;
        this._lastVisibleSig = '';
        if (!on) {
            this._streamFocus = { x: 0, z: 0, scale: this._streamFocus.scale };
            this._centreVisible = true;
            this._setMoversHidden(false);
            this._setCentreHidden(false);
            this.scene3d.setShadowsSuspended3D(false);
            if (this._dynResTimer) { clearTimeout(this._dynResTimer); this._dynResTimer = null; } this._dynResMoveStart = 0;
            if (this._dynResOn) { this._dynResOn = false; this.scene3d.setDynamicResScale3D(1); }
        }
        if (this._params && this._params.worldMode === 'tiled') {
            this._streamSyncNow(this._params);
            this.scene3d.requestRender3D();
        }
    }

    /** Max render distance (tiles from the view centre) — also the ZOOM-OUT CAP: `orthoSize` is clamped so you can't
     *  zoom past where this many tiles fill the view. Bounds the resident set for arbitrarily large tiled worlds.
     *  Clamped 2–8. */
    setStreamMaxDist(tiles: number): void {
        this._maxRenderTiles = Math.max(2, Math.min(8, tiles | 0));
        this._lastVisibleSig = '';   // recompute the visible set at the new distance
        if (this._streamFollow) this.scene3d.requestRender3D();
    }

    /** Streaming diagnostics (console `salsaWorld.streamStats()`): follow state, resident / full-detail / pending
     *  tile counts, the max render distance, whether Web-Worker generation is live, and the retired-tile LRU. */
    getStreamStats(): { follow: boolean; live: number; full: number; pending: number; building: boolean; maxDist: number; workers: boolean; cached: number; cacheMB: number; worstJobMs: number; worstJob: string } {
        return { follow: this._streamFollow, live: this._stream.liveCount, full: this._fullTileBudget, pending: this._stream.pending, building: this._stream.building, maxDist: this._maxRenderTiles, workers: (this._workersEnabled && this._tilePool?.available) ?? false, cached: this._tileRetired.size, cacheMB: Math.round(this._tileRetiredBytes / 1048576), worstJobMs: Math.round(this._worstJobMs * 10) / 10, worstJob: this._worstJobName };
    }

    private _log(g: WorldGraph): WorldGraph {
        // eslint-disable-next-line no-console
        if (WORLD_VERBOSE) console.log('[world]', { lots: g.lots.length, blocks: g.blocks.length, roads: g.roads.length, border: g.params.border, pattern: g.params.pattern, seed: g.params.seed, radius: g.params.radius });
        return g;
    }

    /** Phase 1 — generate the layout graph + drop its flat top-down preview map in. Resets any existing world. */
    generateLayout(params: Partial<LayoutParams> = {}): WorldGraph {
        this.clear();
        const tiled = params.worldMode === 'tiled';
        // Tiled: the CENTRE tile is a full city (grid/square, terraces off); neighbours are cheap flat maps (added
        // below). Brute-forcing every tile at full detail OOMs — this is the TILE-LOD that keeps memory sane.
        const graph = tiled
            ? generateCityLayout({ ...params, pattern: 'grid', border: 'square', terraces: false, shotengai: false })
            : generateCityLayout(params);
        this._heightFn = makeElevation(graph);   // smooth terrain + discrete terrace steps — every layer drapes/lifts onto it (see _add)
        this._smoothFn = makeHeightField(graph.params);   // smooth only (bridges keep street level over sunken canals)
        this._warpInto = makeDomainWarpInto(graph.params);   // horizontal domain warp — roads curve, the grid feel dissolves
        if (this._activeRegions && this._activeRegions.size) {   // drop ids that no longer exist after a regen (all stale → whole city)
            const pruned = new Set([...this._activeRegions].filter(id => id >= 0 && id < graph.regions.length));
            this._activeRegions = pruned.size ? pruned : null;
        }
        this._add('World Layout', buildLayoutPreview(graph));
        this._add('World Water', buildWater(graph));            // canals + ponds + railings + bridges (ground-level)
        this._add('World Terraces', buildTerraces(graph));      // retaining walls + stairs where the ground steps up
        this._add('World Road Paint', buildRoadPaint(graph));   // lane lines + crosswalks (ground-level, part of the map)
        if (tiled) {
            // Widen the border to the whole tiled area so the void grid / apron / border glow wrap the full world,
            // then build the neighbour tiles (ASYNC, a few per frame → progressive reveal). Full rebuild → no cache.
            const half = tiledWorldExtent(graph.params);
            graph.border = [[half, half], [-half, half], [-half, -half], [half, -half]];
            graph.bounds = { min: [-half, -half], max: [half, half] };
            this._reframeAfterTiles = this._autoFrame;   // frame the WHOLE world once the async tiles finish (not just the centre)
            this._syncNeighborTiles(graph.params, false);
        }
        this._add('World Apron', buildApron(graph));            // nature ring beyond the border (draped on terrain)
        this._add('World Void Grid', buildVoidGrid(graph));     // cyberspace grid/rings past the border (flat + unwarped)
        this._add('World Border Glow', buildBorderGlow(graph)); // emissive edge outline (hugs the warped city edge)
        this._graph = graph;
        this._params = graph.params;
        // Params-only persistence: stamp the regenerate-from params onto the City container (it serializes them
        // in its lightweight save marker — a few hundred bytes — instead of the baked geometry).
        if (this._cityContainer) this._cityContainer.worldParams = { params: graph.params, transform: this._cityTransform };
        // Non-tiled frames now; tiled frames AFTER its async tiles finish (see _onTilesSettled) so it fits the whole world.
        if (this._autoFrame && !tiled) this.scene3d.frameAllMeshes(1.3);   // auto-frame (suppressed during live slider updates)
        if (this._timeOfDay != null) this._applyTimeOfDay();     // re-dress fresh meshes for the current time of day
        return graph;
    }

    /** Regenerate the city from a saved doc's City marker (params-only persistence). The host calls this AFTER
     *  loading a document: if a lightweight "City" marker was restored (empty, `worldParams` set), rebuild the
     *  whole city from those params into it. Returns false (no-op) if there's no saved world. */
    restoreFromSave(): boolean {
        const c = this.scene3d.findExistingCityContainer();
        const wp = (c as unknown as { worldParams?: { params?: Partial<LayoutParams>; transform?: Partial<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }> } } | null)?.worldParams;
        if (!wp || !wp.params) return false;
        if (wp.transform) this._cityTransform = { ...this._cityTransform, ...wp.transform };
        this.generateWorld(wp.params);   // rebuilds the city from its params into the adopted marker container
        return true;
    }

    /** Content signature of a tiled world — everything that changes a TILE's geometry EXCEPT tileRadius. When this
     *  is unchanged, cached tiles are reused (only the ring that appeared/disappeared rebuilds). */
    private _tileSigOf(p: LayoutParams): string {
        // Exclude tileRadius (grid size — handled separately) + params that DON'T change BAKED tile geometry: the
        // movers (clouds/traffic) and post (fog). Tweaking those must NOT invalidate every tile's cache and rebuild
        // it. (nightMode/weather/pedestrianDensity DO bake into geometry, so they stay in the signature.)
        const { tileRadius, clouds, cloudDensity, traffic, fog, ...rest } = p;   // eslint-disable-line @typescript-eslint/no-unused-vars
        return JSON.stringify(rest);
    }

    /** Reconcile the streamed neighbour-tile set to `tileRadius` (via the StreamManager): drop tiles that fell out
     *  of range or whose content signature changed, and QUEUE the newcomers for an async build. `keepCache=false`
     *  (a full rebuild) clears the whole cache first. Caching (#2) + async (#3) now live in the StreamManager;
     *  WHICH tiles + HOW to build one live in the CityStreamSource (constructed in the ctor). */
    private _syncNeighborTiles(p: LayoutParams, keepCache: boolean): void {
        const sig = this._tileSigOf(p);
        if (!keepCache || sig !== this._tileSig) {
            this._stream.clear();   // NOTE: runs disposals first (which may retire tiles) — so purge retired AFTER
            this._tileRetired.clear();   // params changed → every retired tile is from the OLD world
            this._tileRetiredBytes = 0;
        }
        this._tileSig = sig;
        this._setCentreHidden(false);   // regen/sync baseline: centre shown (the next _streamCb re-hides if off-screen)
        this._streamSyncNow(p);   // window + detail for the current focus/zoom budget (all-full at origin when follow is off)
    }

    /** CityStreamSource hook: build ONE neighbour tile — flat map (focus/flat) or a full 3D city (full) — and
     *  return its mesh groups. `proxy` (a far tile, Phase 3) forces the cheap flat-map build regardless of
     *  `tileDetail`, so distant tiles cost almost nothing. The StreamManager owns the live cache; the groups also
     *  join `_groups` (so they render / clear / bound like any other world group). */
    private _buildTile(p: LayoutParams, tx: number, tz: number, proxy = false): MeshGroup3D[] {
        const full = !proxy && p.tileDetail === 'full';
        if (full) {
            // `p` !== the host params object ⇒ the source passed its LITE variant ("|l" tier) — separate LRU key.
            const retired = this._takeRetired(tx, tz, p !== this._tileParamsForBuild);
            if (retired) return retired;
        }
        return this._assembleTile(buildTileLayerGroups(p, tx, tz, full), full);
    }

    /** Reassemble a tile's flat layer-groups (from `_buildTile` OR the Worker pool) into scene MeshGroup3Ds: drape +
     *  make meshes + track into `_groups`, and WARM the geometry (pre-upload) so a full tile's reveal render pays
     *  only the instance repack, not the geometry upload. Shared by the sync and async (worker) build paths. */
    private _assembleTile(groups: TileLayerGroup[], full: boolean): MeshGroup3D[] {
        const out: MeshGroup3D[] = [];
        for (const { name, layers } of groups) this._addTracked(name, layers, out);
        if (full) for (const g of out) this.scene3d.warmGroupGeometry3D(g);
        if (out.length) this.scene3d.notifySceneGraphChanged3D();   // ONE host notification per tile (adds were silent)
        return out;
    }

    /** Lazily spawn the Worker pool (only when a full tiled world first needs it). */
    private _ensureTilePool(): TileWorkerPool {
        return (this._tilePool ??= new TileWorkerPool());
    }

    /** CityStreamSource hook (Phase 4): generate a FULL tile's geometry in a Worker (off the main thread), then wrap
     *  + upload it on the main thread. If the worker rejects (crash), fall back to a synchronous main-thread build so
     *  the tile still appears. The StreamManager discards the result if the tile left the window while building. */
    private async _buildTileAsync(p: LayoutParams, tx: number, tz: number): Promise<MeshGroup3D[]> {
        const retired = this._takeRetired(tx, tz, p !== this._tileParamsForBuild);   // LRU hit → re-attach (lite tier keys separately)
        if (retired) return retired;
        let groups: TileLayerGroup[];
        try {
            groups = await this._ensureTilePool().build(p, tx, tz);
        } catch {
            return this._buildTile(p, tx, tz, false);   // worker failed → main-thread fallback (still correct)
        }
        if (!groups.length) return [];
        // PROGRESSIVE, TIME-SLICED reassembly: each of a tile's GROUPS (drape + make meshes + upload) is a separate
        // queued job, processed within a per-frame budget in PRIORITY order — ground/roads → buildings → signage →
        // foliage/props. So a streaming tile appears structure-first and decoration fills in, the cost never spikes a
        // frame (workers finish in parallel; this drip-feeds the main-thread work), and proxy-first already shows the
        // flat tile underneath. The tile's Promise resolves when all its groups are assembled.
        return new Promise<MeshGroup3D[]>(resolve => {
            // SPLIT each group into BUDGET-BOUNDED LAYER CHUNKS: the frame budget only checks BETWEEN jobs, and one
            // whole-group job ("World Streets" of a dense tile) measured 21.6 ms — a guaranteed blown frame per
            // heavy group. Weight ≈ drape cost (world-baked vertex floats) + mesh-spawn cost (per instance); a
            // single huge INSTANCED layer additionally splits its instance list. Chunks share the group's name
            // (priority + LOD are name-keyed) and simply become sibling groups — dispose/retire collect them all.
            // 120k: the 400k first guess measured a 28.7ms single job with detailed buildings on — drape+warp cost
            // per vertex is ~5× the estimate. ~120k ≈ 5-8ms worst-case per job, safely inside a frame.
            // → 300k now: jobs are mesh-wrap + upload ONLY (drape + bounds precompute run in the WORKER), so the
            // drape-calibrated budget over-split tiles into many slow-to-finish slices for no frame-time benefit.
            // W_INST 6000: with geometry now cheap, Mesh3D SPAWN (~50µs each) dominates instanced layers — 1500
            // let ~200 spawns pack into one job (field: 16.1ms). 6000 caps it at ~50 spawns ≈ 2-3ms/job.
            const W_INST = 6000, JOB_BUDGET = 300_000;
            const weight = (L: LayoutPreviewLayer): number => L.geometry.vertices.length + (L.instances?.length ?? 0) * W_INST;
            const jobs: Array<{ name: string; layers: LayoutPreviewLayer[]; prio: number }> = [];
            for (const g of groups) {
                const prio = this._tileGroupPrio(g.name);
                let cur: LayoutPreviewLayer[] = [], curW = 0;
                const flush = (): void => { if (cur.length) { jobs.push({ name: g.name, layers: cur, prio }); cur = []; curW = 0; } };
                for (const L of g.layers) {
                    const w = weight(L);
                    if (w > JOB_BUDGET && L.instances && L.instances.length > 32) {
                        flush();   // one huge instanced layer → its own jobs, instance list sliced to the budget
                        const per = Math.max(16, Math.floor(L.instances.length * JOB_BUDGET / w));
                        for (let i = 0; i < L.instances.length; i += per) {
                            jobs.push({ name: g.name, layers: [{ ...L, instances: L.instances.slice(i, i + per) }], prio });
                        }
                        continue;
                    }
                    if (curW + w > JOB_BUDGET) flush();
                    cur.push(L); curW += w;
                }
                flush();
            }
            if (!jobs.length) { resolve([]); return; }
            const ctx: ReassembleCtx = { out: [], remaining: jobs.length, resolve };
            for (const j of jobs) this._reassembleQueue.push({ name: j.name, layers: j.layers, prio: j.prio, ctx });
            this._pumpReassemble();
        });
    }

    /** Reveal order for a tile's groups (lower = sooner): ground/roads → buildings → signage → foliage/props. */
    private _tileGroupPrio(name: string): number {
        if (/Layout|Water|Road Paint|Terraces/.test(name)) return 0;
        if (/Streets|Landmarks|Shotengai|Railway|Skyway/.test(name)) return 1;
        if (/Signals|Signage|Awnings/.test(name)) return 2;
        return 3;   // Biome (foliage) · Furniture · Pedestrians — decoration last
    }

    private readonly _reassembleQueue: Array<{ name: string; layers: LayoutPreviewLayer[]; prio: number; ctx: ReassembleCtx }> = [];
    private _reassembleRaf = 0;
    private _worstJobMs = 0;          // slowest single reassembly job seen (streamStats) — >8ms = split that group
    private _worstJobName = '';
    private _pumpReassemble(): void {
        if (typeof requestAnimationFrame === 'undefined') {   // headless: no time-slicing, assemble immediately
            while (this._reassembleOne()) { /* drain */ }
            return;
        }
        if (this._reassembleRaf) return;
        const step = (): void => {
            const t0 = performance.now();
            // SHARED frame budget: the stream pump gets up to 5 ms of its own (sliceMs) — when its queue is busy
            // this drops to 3 ms so the two together stay ≤ ~8 ms/frame, never the old 6+10 = a blown frame.
            const budget = this._stream.queued ? 3 : 6;
            do { if (!this._reassembleOne()) break; } while (this._reassembleQueue.length && performance.now() - t0 < budget);
            this.scene3d.requestRender3D();
            this._reassembleRaf = this._reassembleQueue.length ? requestAnimationFrame(step) : 0;
        };
        this._reassembleRaf = requestAnimationFrame(step);
    }

    /** Assemble ONE queued group — the lowest-priority pending (ground before buildings before foliage, across all
     *  in-flight tiles). Warms + resolves the tile's Promise once its last group lands. */
    private _reassembleOne(): boolean {
        if (!this._reassembleQueue.length) return false;
        let bi = 0;
        for (let i = 1; i < this._reassembleQueue.length; i++) if (this._reassembleQueue[i].prio < this._reassembleQueue[bi].prio) bi = i;
        const job = this._reassembleQueue.splice(bi, 1)[0];
        const jt0 = performance.now();
        const nBefore = job.ctx.out.length;
        this._addTracked(job.name, job.layers, job.ctx.out);   // layers arrive pre-draped from the worker
        // WARM (pre-upload geometry) per job, not per tile — batching all warms at tile completion landed the
        // whole tile's writeBuffer bytes on ONE frame, the opposite of the drip-feed intent.
        if (job.ctx.out.length > nBefore) this.scene3d.warmGroupGeometry3D(job.ctx.out[job.ctx.out.length - 1]);
        // The budget check runs BETWEEN jobs — one heavy group (drape + mesh construction) can still blow a frame.
        // Track the worst job so `streamStats()` can prove/disprove that in the field.
        const jMs = performance.now() - jt0;
        if (jMs > this._worstJobMs) { this._worstJobMs = jMs; this._worstJobName = job.name; }
        if (--job.ctx.remaining === 0) {
            this.scene3d.notifySceneGraphChanged3D();   // ONE host notification per tile (the group adds were silent; warms happened per job)
            job.ctx.resolve(job.ctx.out);
        }
        return true;
    }

    /** Toggle Web-Worker tile generation (Phase 4). ON (default) = full tiles generate off the main thread; OFF =
     *  the synchronous main-thread build (for A/B-ing the stall). Disposing frees the workers. */
    setStreamWorkers(on: boolean): void {
        this._workersEnabled = on;
        if (!on && this._tilePool) { this._tilePool.dispose(); this._tilePool = null; }
    }

    /** CityStreamSource hook: drop a built tile's groups from the scene + the flat group list. FULL tiles RETIRE
     *  into the LRU instead of vanishing — their built (draped) groups survive as JS objects so panning back
     *  re-attaches them (`_takeRetired`): no worker round-trip, no drape, just a geometry re-upload. Proxies are
     *  ~free to rebuild and skip the cache. */
    private _disposeTileGroups(groups: MeshGroup3D[], key?: string): void {
        const doomed = new Set(groups);
        for (const g of groups) {
            this.scene3d.removeFlatColorMeshGroup(g, /*silent*/ true);
            this._tileGroups.delete(g);
        }
        this._groups = this._groups.filter(g => !doomed.has(g));   // ONE O(N) pass (was indexOf+splice per group = O(groups×N))
        if (groups.length) this.scene3d.notifySceneGraphChanged3D();   // ONE host notification per disposed tile
        // Retire FULL and LITE ("|l") tiles — both are expensive 3D builds worth caching; only flat proxies ("|p") skip.
        if (key === undefined || key.endsWith('|p') || this._params?.tileDetail !== 'full' || !groups.length) return;
        let bytes = 0;
        for (const g of groups) for (const ch of g.children) {
            const geo = (ch as { geometry?: { vertices: Float32Array; indices?: Uint32Array } }).geometry;
            if (geo) bytes += geo.vertices.byteLength + (geo.indices ? geo.indices.byteLength : 0);
        }
        const prev = this._tileRetired.get(key);
        if (prev) { this._tileRetiredBytes -= prev.bytes; this._tileRetired.delete(key); }
        this._tileRetired.set(key, { groups, bytes });
        this._tileRetiredBytes += bytes;
        for (const [k, e] of this._tileRetired) {   // byte-capped LRU (Map iterates insertion order = oldest first)
            if (this._tileRetiredBytes <= WorldManager.TILE_RETIRE_CAP) break;
            this._tileRetired.delete(k);
            this._tileRetiredBytes -= e.bytes;
        }
    }

    /** Take a retired tile out of the LRU and RE-ATTACH its groups to the scene — the cache-hit rebuild path.
     *  Geometry is already draped and positioned; the only remaining cost is the GPU re-upload (spread by
     *  warmGeometry) + incremental instance slots. LOD tier states may have moved while the tile was away, so
     *  each group's children are reconciled against the CURRENT tier states. */
    private _takeRetired(tx: number, tz: number, lite = false): MeshGroup3D[] | null {
        const key = lite ? `${tx},${tz}|l` : `${tx},${tz}`;   // matches the stream key the dispose path stored under
        const hit = this._tileRetired.get(key);
        if (!hit) return null;
        this._tileRetired.delete(key);
        this._tileRetiredBytes -= hit.bytes;
        const parent = this._ensureCityContainer();
        for (const g of hit.groups) {
            this.scene3d.reattachFlatColorMeshGroup(g, parent, /*silent*/ true);
            this._groups.push(g);
            this._tileGroups.add(g);
            this._applyLodToGroup(g);   // scoped — no epoch bump (a bump = a full 5-tier tree walk next frame)
            this.scene3d.warmGroupGeometry3D(g);
        }
        this.scene3d.notifySceneGraphChanged3D();   // ONE host notification for the whole re-attached tile
        return hit.groups;
    }

    /** Apply the CURRENT LOD tier states to one (re-attached) group's subtree — mirrors `_applyLOD`'s walk but for
     *  all five tiers at once. A retired tile's children carry the tier flags from when it was DISPOSED; without
     *  this, a tile cached zoomed-in would re-attach with its props visible at extreme zoom (or vice versa). */
    private _applyLodToGroup(root: MeshGroup3D): void {
        const tiers: Array<[RegExp, boolean]> = [
            [WorldManager.DETAIL_LOD, this._lodShown],
            [WorldManager.ROOF_LOD, this._lodRoofShown],
            [WorldManager.PROPS_LOD, this._lodPropsShown],
            [WorldManager.FLATMAP_LOD, this._lodFlatShown],
            [WorldManager.STRUCTURE_LOD, this._lodStructShown],
        ];
        type N = { name: string; visible: boolean; children?: unknown[] };
        const stack: N[] = [root as unknown as N];
        while (stack.length) {
            const n = stack.pop()!;
            let matched = false;
            for (const [re, shown] of tiers) if (re.test(n.name)) { n.visible = shown; matched = true; break; }
            if (!matched && n.children) for (const k of n.children) stack.push(k as N);
        }
    }

    /** CityStreamSource hook: the async tile build drained — recache the gizmo bounds (now that all tiles exist)
     *  and frame the whole world if this was a fresh build. */
    private _onTilesSettled(): void {
        this._cacheCityBounds();
        if (this._reframeAfterTiles) { this._reframeAfterTiles = false; this.scene3d.frameAllMeshes(1.3); }
    }

    /** _add + capture the created group into `out` (so a tile's groups can be tracked for the cache). SILENT: a
     *  tile has ~16 groups, and every non-silent add fires a host scene-graph notification (Angular change
     *  detection in Frogmarks) — with several tiles arriving mid-pan that notification STORM was a ~20fps dip
     *  while the actual render cost 2 ms. Callers notify ONCE per completed tile instead. */
    private _addTracked(name: string, layers: LayoutPreviewLayer[], out: MeshGroup3D[]): void {
        if (!layers.length) return;
        const before = this._groups.length;
        // preDraped: tile layers arrive world-ready from buildTileLayerGroups (drape ran in the WORKER — the
        // per-vertex noise never touches the main thread). Reassembly here is mesh-wrap + upload only.
        this._addStaged(name, layers, this._heightFn, this._smoothFn, this._warpInto, this._groups, /*silent*/ true, /*preDraped*/ true);
        if (this._groups.length > before) {
            const g = this._groups[this._groups.length - 1];
            out.push(g);
            this._tileGroups.add(g);   // tile-owned (vs centre) — drives the centre-hide + retire cache
            // SCOPED LOD apply to just this group — bumping _sceneEpoch here made every streaming frame re-walk
            // the ENTIRE tree ×5 hidden tiers in _lodCb (one dirty pass per job that landed). Same result, O(group).
            this._applyLodToGroup(g);
        }
    }

    /** On an incremental tileRadius change: widen the union border + rebuild the extent-dependent groups (apron /
     *  void grid / border glow) and resize the shadow frustum, keeping the centre + cached tiles. */
    private _reflowTiledExtent(p: LayoutParams): void {
        if (!this._graph) return;
        const half = tiledWorldExtent(p);
        this._graph.border = [[half, half], [-half, half], [-half, -half], [half, -half]];
        this._graph.bounds = { min: [-half, -half], max: [half, half] };
        this._removeGroupsByName(['World Apron', 'World Void Grid', 'World Border Glow']);
        this._add('World Apron', buildApron(this._graph));
        this._add('World Void Grid', buildVoidGrid(this._graph));
        this._add('World Border Glow', buildBorderGlow(this._graph));
        if (this.scene3d.shadowsEnabled) this.scene3d.setShadowHalfExtent3D(Math.max(15, half * 1.6));
        if (this._cityContainer) this._cityContainer.worldParams = { params: this._graph.params, transform: this._cityTransform };
    }

    /** Phase 2 — scatter biome dressing (trees/rocks) onto the current graph (auto-builds a layout if none). */
    generateBiome(): WorldGraph {
        const graph = this._graph ?? this.generateLayout();
        this._add('World Biome', buildBiome(graph, this._regionFilter()));
        return graph;
    }

    /** Phase 3 — extrude lot footprints into buildings on the current graph (auto-builds a layout if none). */
    generateStreets(): WorldGraph {
        const graph = this._graph ?? this.generateLayout();
        this._add('World Streets', buildStreets(graph, this._regionFilter()));
        this._add('World Landmarks', buildLandmarks(graph, this._regionFilter()));
        this._add('World Shotengai', buildShotengai(graph, this._regionFilter()));
        this._add('World Signals', buildTrafficLights(graph, this._regionFilter()));
        this._add('World Signage', buildSignage(graph, this._regionFilter()));
        this._add('World Awnings', buildAwnings(graph, this._regionFilter()));
        this._add('World Furniture', buildFurniture(graph, this._regionFilter()));
        this._add('World Railway', buildRailway(graph, !this._trafficOn));   // parked train only when traffic is off
        this._add('World Skyway', buildSkyway(graph));                       // cyber: the sky-train's glowing guideway
        this._add('World Sky', buildSky(graph));                             // stars + moon (shown at night by the cycle)
        for (const ch of this._groups[this._groups.length - 1].children) (ch as Mesh3D).visible = false;   // hidden until the cycle reveals them
        this._add('World Pedestrians', buildPedestrians(graph, this._regionFilter()));
        this._addTextSigns(graph);
        // Traffic follows the param + City mode: auto-runs while the tool is open (the panel toggle turns it off).
        if (graph.params.traffic === false) this.stopTraffic();
        else if (this._trafficOn || this._cityMode) this.startTraffic();   // respawn after regen / start on toggle-on
        if (this._timeOfDay != null) this._applyTimeOfDay();
        if (this._renderStyle) this._applyRenderStyle();
        return graph;
    }

    /** The canonical build order after the layout groups — generateWorld, DRAFT builds and the ASYNC
     *  time-sliced regen all walk this list through {@link _buildGroup}. */
    private static readonly BUILD_ORDER: readonly string[] = [
        'World Biome', 'World Streets', 'World Landmarks', 'World Shotengai', 'World Signals',
        'World Signage', 'World Awnings', 'World Furniture', 'World Railway', 'World Skyway',
        'World Sky', 'World Pedestrians',
    ];
    /** Groups SKIPPED by a DRAFT build (the fast preview during a slider drag) — dressing that reads fine
     *  missing for half a second. Draft also skips text signs and the traffic respawn. */
    private static readonly DRAFT_SKIP = new Set([
        'World Signage', 'World Awnings', 'World Furniture', 'World Pedestrians', 'World Sky', 'World Skyway',
    ]);

    /** Build all phases at once. `draft` = the reduced drag-preview build (see updateCity). */
    generateWorld(params: Partial<LayoutParams> = {}, draft = false): WorldGraph {
        const graph = this.generateLayout(params);
        // Flat tiled overview: skip ALL the 3D dressing — the centre stays a flat map like its neighbours (a cheap
        // top-down view of the whole world). generateLayout already added every tile's flat map.
        const flatOnly = graph.params.worldMode === 'tiled' && graph.params.tileDetail === 'flat';
        for (const name of WorldManager.BUILD_ORDER) {
            if (flatOnly) break;
            if (draft && WorldManager.DRAFT_SKIP.has(name)) continue;
            this._add(name, this._buildGroup(name, graph));
            if (name === 'World Sky') for (const ch of this._groups[this._groups.length - 1].children) (ch as Mesh3D).visible = false;   // hidden until the cycle reveals them
        }
        if (!draft) this._addTextSigns(graph);
        // Traffic follows the param + City mode: auto-runs while the tool is open (the panel toggle turns it off).
        if (graph.params.traffic === false) this.stopTraffic();
        else if (!draft && (this._trafficOn || this._cityMode)) this.startTraffic();   // respawn after regen / start on toggle-on
        if (this._timeOfDay != null) this._applyTimeOfDay();
        if (this._renderStyle) this._applyRenderStyle();
        if (!draft) this._cacheCityBounds();   // gizmo box (skip draft — the full build follows)
        return graph;
    }

    // ── City Tool MODE ───────────────────────────────────────────────────────────────────────────
    /** Enter City mode (alt+drag orbit + focus workspace). Only ONE city ever exists — re-opening the tool goes back
     *  to editing it. Called with EXPLICIT params → (re)generate the city; called with NO args → RESUME orbit on the
     *  existing city WITHOUT regenerating (falls back to generating a default city if none exists yet). Frogmarks calls
     *  this when the City Tool opens; slider changes then call {@link updateCity}. */
    enterCityMode(params?: Partial<LayoutParams>): WorldGraph {
        this._cityMode = true;                     // set BEFORE the build so the wrapper is created at IDENTITY (edit upright)
        const graph = (params === undefined && this.hasWorld && this._graph)
            ? this._graph                          // resume: the city + its meshes already exist — just re-enter orbit
            : this.generateWorld(params ?? {});    // (re)generate from params, or a default city if none exists
        this._applyCityTransform();                // force identity (covers the resume path where no build ran)
        this.scene3d.enterCityMode3D([0, graph.params.groundY, 0]);
        // SHADOWS sized to the diorama — with the day/night cycle moving the sun, shadows sweep across the city.
        // THROTTLED to every 3rd frame in city mode (mover shadows lag imperceptibly; the whole-scene shadow
        // depth pass stops being a per-frame GPU cost). Restored to every-frame on exit.
        const worldR = graph.params.worldMode === 'tiled' ? tiledWorldExtent(graph.params) : graph.params.radius;
        const shadowHE = Math.max(15, worldR * 1.6);
        if (!this.scene3d.shadowsEnabled) this.scene3d.enableShadows(2048, shadowHE, 0.002);
        else this.scene3d.setShadowHalfExtent3D(shadowHE);   // resize to THIS city (a bigger one would clip otherwise)
        const tiled = graph.params.worldMode === 'tiled';
        this.scene3d.setShadowUpdateInterval(tiled ? 30 : 3);   // tiled = far more geometry per shadow pass → throttle hard
        this.scene3d.setShadowSoftness(2.4);   // wide PCF penumbra — soft, city-scale sun shadows
        this.setCinematicGrade(true);   // bloom/grade/vignette keyed to the day cycle (host config restored on exit)
        // Default to a NOON sky + sun (instead of the wavy focus background) — the Time slider takes it from here.
        if (this._timeOfDay == null) this.setTimeOfDay(0.5);
        // The city is ALIVE by default: moving cars/train/walkers unless the traffic param is off. Tiled worlds
        // skip auto-traffic (a moving sim across many tiles stutters); the user can turn it on knowingly.
        if (!tiled && graph.params.traffic !== false) this.startTraffic();
        this.setEditPulse(true);   // live "cyberspace stage" breath on the border glow while the tool is open
        return graph;
    }

    /** Leave City mode (keeps the city in the scene; call {@link clear} to remove it). */
    exitCityMode(): void {
        this.scene3d.exitCityMode3D();
        this.scene3d.setShadowUpdateInterval(1);   // back to every-frame shadows for normal editing
        this.scene3d.setShadowSoftness(1);
        this.scene3d.setPointLights3D([]);         // lamp lights off outside the city
        this.setCinematicGrade(false);             // hand the post stack back to the host's own settings
        this.setEditPulse(false);                  // stop the border-glow breath + restore its built emissive
        this._cityMode = false;
        this._applyCityTransform();                // restore the placed transform now that we're back in the illustration
        // Refresh the illustration outliner: the host doesn't track hierarchy changes while the City Tool is open,
        // so the City wrapper node (+ its groups) would otherwise stay invisible until the next unrelated edit.
        this.scene3d.notifySceneGraphChanged3D();
    }

    /** Which rebuild units each param touches. Params NOT listed here change the graph topology → full regen.
     *  Units: mesh-group names to rebuild on the EXISTING graph · 'traffic' = respawn the movers · 'lighting'
     *  = re-apply the day/night dressing only. This is what makes most sliders near-instant. */
    private static readonly PARAM_TIER: Partial<Record<keyof LayoutParams, readonly string[]>> = {
        sidewalks: ['World Layout'],
        roadPaint: ['World Road Paint'],
        trafficLights: ['World Signals'],
        signage: ['World Signage'],
        awnings: ['World Awnings'],
        streetFurniture: ['World Furniture'], powerLines: ['World Furniture'], parkedCars: ['World Furniture'],
        bicycles: ['World Furniture'], lanterns: ['World Furniture', 'World Shotengai'],
        cornerStyle: ['World Streets'], roofStyle: ['World Streets'], facadeDetail: ['World Streets'], rooftops: ['World Streets'],
        streetTrees: ['World Biome'],
        pedestrians: ['World Pedestrians'],
        railway: ['World Railway', 'traffic'],
        traffic: ['traffic'], clouds: ['traffic'], cloudDensity: ['traffic'],
        weather: ['traffic', 'lighting'],
        fog: ['lighting'],
        voidGrid: ['World Void Grid'], voidExtent: ['World Void Grid'], voidGridSpacing: ['World Void Grid'], voidLineWidth: ['World Void Grid'],
        borderGlow: ['World Border Glow'], borderGlowHeight: ['World Border Glow'],
        terrainApron: ['World Apron'], apronRadius: ['World Apron'], natureDensity: ['World Apron'],
    };

    /** Re-run ONE group's builder on the existing graph (selective regen). */
    private _buildGroup(name: string, graph: WorldGraph): LayoutPreviewLayer[] {
        const f = this._regionFilter();
        switch (name) {
            case 'World Layout': return buildLayoutPreview(graph);
            case 'World Water': return buildWater(graph);
            case 'World Terraces': return buildTerraces(graph);
            case 'World Road Paint': return buildRoadPaint(graph);
            case 'World Apron': return buildApron(graph);
            case 'World Void Grid': return buildVoidGrid(graph);
            case 'World Border Glow': return buildBorderGlow(graph);
            case 'World Biome': return buildBiome(graph, f);
            case 'World Streets': return buildStreets(graph, f);
            case 'World Landmarks': return buildLandmarks(graph, f);
            case 'World Shotengai': return buildShotengai(graph, f);
            case 'World Signals': return buildTrafficLights(graph, f);
            case 'World Signage': return buildSignage(graph, f);
            case 'World Awnings': return buildAwnings(graph, f);
            case 'World Furniture': return buildFurniture(graph, f);
            case 'World Railway': return buildRailway(graph, !this._trafficOn);
            case 'World Skyway': return buildSkyway(graph);
            case 'World Sky': return buildSky(graph);
            case 'World Pedestrians': return buildPedestrians(graph, f);
            default: return [];
        }
    }

    private _removeGroupsByName(names: readonly string[]): void {
        for (const g of [...this._groups]) {
            if (!names.includes(g.name ?? '')) continue;
            this.scene3d.removeFlatColorMeshGroup(g);
            const i = this._groups.indexOf(g);
            if (i >= 0) this._groups.splice(i, 1);
        }
    }

    /** Live slider update: merge onto the current params + regenerate WITHOUT re-framing (orbit view preserved).
     *  Debounce host-side (~150 ms). Three speeds:
     *   · SELECTIVE — non-topology params rebuild only their own groups / respawn traffic / re-light (instant).
     *   · DRAFT — rapid successive topology changes (a drag) build a reduced preview synchronously, then
     *     PROMOTE to a full build once the drag settles (~450 ms idle).
     *   · ASYNC — a single topology change rebuilds TIME-SLICED into hidden staging groups while the old city
     *     stays live, then swaps in one frame (no freeze). Headless (no rAF) falls back to the classic sync build. */
    updateCity(params: Partial<LayoutParams> = {}): WorldGraph {
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        const prev = this._params, graph = this._graph;
        const pendingFull = !!this._async || !!this._promoteTimer;
        if (!pendingFull && prev && graph) {
            const changed = (Object.keys(params) as (keyof LayoutParams)[])
                .filter(k => JSON.stringify(params[k]) !== JSON.stringify(prev[k]));
            if (changed.length === 0) return graph;
            const units = new Set<string>();
            let selective = true;
            for (const k of changed) {
                const tier = WorldManager.PARAM_TIER[k];
                if (!tier) { selective = false; break; }
                for (const u of tier) units.add(u);
            }
            if (selective) {
                Object.assign(prev, params);   // prev IS graph.params (same object) — builders read the update
                const groupNames = [...units].filter(u => u !== 'traffic' && u !== 'lighting');
                if (groupNames.length) {
                    this._removeGroupsByName(groupNames);
                    for (const name of groupNames) this._add(name, this._buildGroup(name, graph));
                    this._lastGlowNight = -1;              // fresh meshes need re-dressing
                    if (this._renderStyle) this._applyRenderStyle();
                }
                if (units.has('traffic')) {
                    if (graph.params.traffic === false) this.stopTraffic();
                    else if (this._trafficOn || this._cityMode) { this._despawnTraffic(); this._trafficOn = true; this._spawnTraffic(); }
                }
                if (this._timeOfDay != null && (units.has('lighting') || groupNames.length || units.has('traffic'))) this._applyTimeOfDay();
                this._lastRegen = { ms: t0 ? performance.now() - t0 : 0, kind: 'selective: ' + [...units].join(', ') };
                this._lastUpdateAt = t0;
                this.scene3d.requestRender3D();
                return graph;
            }
        }

        // FULL pipeline. Merge onto the REQUESTED params (a pending async/draft build's target), so mid-drag
        // key changes never lose earlier ones; abort any in-flight build — this call supersedes it.
        const merged: Partial<LayoutParams> = { ...(this._targetParams ?? prev ?? {}), ...params };
        this._targetParams = merged;
        this._abortAsync();
        if (this._promoteTimer) { clearTimeout(this._promoteTimer); this._promoteTimer = null; }
        const rapid = t0 - this._lastUpdateAt < 350;
        this._lastUpdateAt = t0;

        // TILED worlds build SYNCHRONOUSLY — the async double-buffer would hold 2× a multi-tile scene (huge), and
        // the tile-LOD (centre full + flat-map neighbours) keeps a single sync build cheap enough. Reframe to fit.
        if (merged.worldMode === 'tiled') {
            // INCREMENTAL (#2): if ONLY tileRadius changed on an existing tiled world (content signature matches),
            // keep the centre + all cached tiles — just add/remove the outer ring (async) + reflow the extent groups.
            // No regen, no clear. Preserves the view. Growing 3×3→5×5 rebuilds 16 tiles, not 25.
            if (graph && this._params && prev?.worldMode === 'tiled' && this._tileSigOf({ ...this._params, ...merged } as LayoutParams) === this._tileSig) {
                if (merged.tileRadius !== undefined) this._params.tileRadius = merged.tileRadius;
                this._reflowTiledExtent(this._params);
                this._syncNeighborTiles(this._params, true);
                this._lastRegen = { ms: t0 ? performance.now() - t0 : 0, kind: 'tiled-incremental' };
                this.scene3d.requestRender3D();
                return graph;
            }
            this._autoFrame = false;   // a live slider change on a tiled world: preserve the view (don't reframe)
            let g: WorldGraph;
            try { g = this.generateWorld(merged); } finally { this._autoFrame = true; }
            const wr = tiledWorldExtent(g.params);
            if (this.scene3d.shadowsEnabled) this.scene3d.setShadowHalfExtent3D(Math.max(15, wr * 1.6));
            this.scene3d.setShadowUpdateInterval(30);
            this._lastRegen = { ms: t0 ? performance.now() - t0 : 0, kind: 'full-tiled' };
            this.scene3d.requestRender3D();
            return g;
        }

        if (graph && rapid) {
            // DRAFT: instant reduced build for drag feedback; a full build promotes after the drag settles.
            this._autoFrame = false;
            let g: WorldGraph;
            try { g = this.generateWorld(merged, true); } finally { this._autoFrame = true; }
            this._lastRegen = { ms: t0 ? performance.now() - t0 : 0, kind: 'draft' };
            if (typeof setTimeout !== 'undefined') {
                this._promoteTimer = setTimeout(() => {
                    this._promoteTimer = null;
                    const target = this._targetParams ?? { ...(this._params ?? {}) };
                    if (typeof requestAnimationFrame !== 'undefined') this._startAsyncFull(target);
                    else {
                        const pt0 = typeof performance !== 'undefined' ? performance.now() : 0;
                        this._autoFrame = false;
                        try { this.generateWorld(target); this._targetParams = null; } finally { this._autoFrame = true; }
                        this._lastRegen = { ms: pt0 ? performance.now() - pt0 : 0, kind: 'full' };
                        this.scene3d.requestRender3D();
                    }
                }, 450);
            }
            return g;
        }

        if (graph && typeof requestAnimationFrame !== 'undefined') {
            // ASYNC: time-sliced staged rebuild; the OLD city stays visible + ticking until the swap.
            this._startAsyncFull(merged);
            this._lastRegen = { ms: t0 ? performance.now() - t0 : 0, kind: 'full-async (building…)' };
            return graph;
        }

        // No city yet, or headless: the classic synchronous full build.
        this._autoFrame = false;
        try {
            const g = this.generateWorld(merged);
            this._targetParams = null;
            this._lastRegen = { ms: t0 ? performance.now() - t0 : 0, kind: 'full' };
            return g;
        } finally { this._autoFrame = true; }
    }
    /** Timing of the last updateCity (paste with salsaWorld.debug() when sliders feel slow). */
    private _lastRegen: { ms: number; kind: string } = { ms: 0, kind: 'none' };
    private _lastUpdateAt = -1e9;
    private _promoteTimer: ReturnType<typeof setTimeout> | null = null;
    /** The latest REQUESTED full params while a draft/async build is pending (merge base; null when settled). */
    private _targetParams: Partial<LayoutParams> | null = null;

    // ── Time-sliced ASYNC full regen (double-buffered: staged hidden groups → one-frame swap) ─────
    private _async: {
        merged: Partial<LayoutParams>; graph: WorldGraph; t0: number;
        h: (x: number, z: number) => number; s: (x: number, z: number) => number; w: (x: number, z: number, out: [number, number]) => void;
        queue: string[]; staged: MeshGroup3D[]; raf: number;
    } | null = null;

    private _abortAsync(): void {
        if (!this._async) return;
        if (this._async.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._async.raf);
        for (const g of this._async.staged) this.scene3d.removeFlatColorMeshGroup(g);
        this._async = null;
    }

    private _startAsyncFull(merged: Partial<LayoutParams>): void {
        this._abortAsync();
        const graph = generateCityLayout(merged);   // tiled builds synchronously (see updateCity) — async is single-city only
        this._async = {
            merged, graph, t0: typeof performance !== 'undefined' ? performance.now() : 0,
            h: makeElevation(graph), s: makeHeightField(graph.params), w: makeDomainWarpInto(graph.params),
            queue: ['World Layout', 'World Water', 'World Terraces', 'World Road Paint', 'World Apron', 'World Void Grid', 'World Border Glow', ...WorldManager.BUILD_ORDER],
            staged: [], raf: 0,
        };
        if (typeof requestAnimationFrame === 'undefined') { while (this._async) this._asyncStep(); return; }
        this._async.raf = requestAnimationFrame(() => this._asyncStep());
    }

    private _asyncStep(): void {
        const st = this._async;
        if (!st) return;
        for (let n = 0; n < 2 && st.queue.length; n++) {     // two groups per frame ≈ 5–15 ms slices
            const name = st.queue.shift()!;
            const before = st.staged.length;
            this._addStaged(name, this._buildGroup(name, st.graph), st.h, st.s, st.w, st.staged, /*silent*/ true);
            if (st.staged.length > before) {
                const g = st.staged[st.staged.length - 1];
                for (const ch of g.children) (ch as Mesh3D).visible = false;   // hidden until the swap
                // PRE-UPLOAD this group's geometry into the pool now, while it's hidden. Spread across the
                // staging frames, this makes the reveal SWAP a cheap visibility flip (no big GPU upload).
                this.scene3d.warmGroupGeometry3D(g);
            }
        }
        if (st.queue.length) { st.raf = requestAnimationFrame(() => this._asyncStep()); return; }
        this._finishAsync(st);
    }

    /** The one-frame SWAP: drop the old world, adopt the staged one, respawn the sim on the new graph. */
    private _finishAsync(st: NonNullable<WorldManager['_async']>): void {
        this._async = null;
        this._despawnTraffic();                              // old movers reference the old graph
        for (const g of this._groups) this.scene3d.removeFlatColorMeshGroup(g);
        this._groups = st.staged;
        this._sceneEpoch++;   // the reveal swaps a fresh set of visible nodes into _groups → LOD must re-hide
        for (const g of this._groups) {
            const sky = g.name === 'World Sky';              // stars stay hidden until the cycle reveals them
            for (const ch of g.children) (ch as Mesh3D).visible = !sky;
        }
        this._graph = st.graph;
        this._params = st.graph.params;
        this._heightFn = st.h; this._smoothFn = st.s; this._warpInto = st.w;
        if (this._activeRegions && this._activeRegions.size) {
            const pruned = new Set([...this._activeRegions].filter(id => id >= 0 && id < st.graph.regions.length));
            this._activeRegions = pruned.size ? pruned : null;
        }
        this._lastGlowNight = -1;
        this._targetParams = null;
        this._addTextSigns(st.graph);
        // Tiled worlds = many cities at once: a moving sim (9× movers) + frequent shadow redraws over all that
        // geometry stutter hard. Auto-off traffic + throttle shadows for tiled; the user re-enables knowingly.
        if (st.graph.params.worldMode === 'tiled') {
            this.stopTraffic();
            this.scene3d.setShadowUpdateInterval(30);
        } else {
            if (st.graph.params.traffic === false) this.stopTraffic();
            else if (this._trafficOn || this._cityMode) { this._trafficOn = true; this._spawnTraffic(); }
            this.scene3d.setShadowUpdateInterval(3);
        }
        if (this._timeOfDay != null) this._applyTimeOfDay();
        if (this._renderStyle) this._applyRenderStyle();
        this._cacheCityBounds();   // gizmo box for the newly-revealed city
        this._lastRegen = { ms: st.t0 ? performance.now() - st.t0 : 0, kind: 'full-async' };
        // The staged groups were added SILENTLY (no per-group emit, to hide the transient 2N state) — now that
        // the swap is done, tell the host ONCE so the outliner reflects the revealed city.
        this.scene3d.notifySceneGraphChanged3D();
        this.scene3d.requestRender3D();
    }

    // ── Active-region editor ───────────────────────────────────────────────────────────────────────
    // Districts can be independently ENABLED / DISABLED: only enabled districts build full 3D (buildings / trees /
    // signage / signals / landmarks); the rest of the city stays as the cheap flat map + roads + lights. `null` =
    // ALL enabled (the whole city). Every mutator rebuilds WITHOUT re-framing, so the orbit view is preserved.

    /** Region → build predicate handed to the composers (null when the whole city builds — the cheap path). */
    private _regionFilter(): ((r: number) => boolean) | null {
        const set = this._activeRegions;
        return set ? (r: number) => set.has(r) : null;
    }
    private _regenNoFrame(): WorldGraph | null {
        if (!this._graph) return null;
        this._autoFrame = false;
        try { return this.generateWorld(this._params ?? {}); }
        finally { this._autoFrame = true; }
    }
    /** Set the EXACT set of enabled districts (`null` = all, `[]` = none). Rebuilds. */
    setActiveRegions(ids: number[] | null): WorldGraph | null {
        this._activeRegions = ids ? new Set(ids) : null;
        return this._regenNoFrame();
    }
    /** Flip one district on/off. From the "all enabled" state, the first toggle disables just that one. Rebuilds. */
    toggleRegion(id: number): WorldGraph | null {
        const all = (this._graph?.regions ?? []).map(r => r.id);
        const set = new Set(this._activeRegions ?? all);
        if (set.has(id)) set.delete(id); else set.add(id);
        this._activeRegions = set.size === all.length ? null : set;   // everything back on → the cheap "null = all" path
        return this._regenNoFrame();
    }
    /** Enable or disable one district explicitly. Rebuilds. */
    setRegionEnabled(id: number, on: boolean): WorldGraph | null {
        const all = (this._graph?.regions ?? []).map(r => r.id);
        const set = new Set(this._activeRegions ?? all);
        if (on) set.add(id); else set.delete(id);
        this._activeRegions = set.size === all.length ? null : set;
        return this._regenNoFrame();
    }
    /** Convenience: focus EXACTLY one district (or `null` = whole city). */
    setActiveRegion(id: number | null): WorldGraph | null {
        return this.setActiveRegions(id == null ? null : [id]);
    }
    /** The enabled district ids, or null (= all enabled). */
    get activeRegions(): number[] | null { return this._activeRegions ? [...this._activeRegions] : null; }
    /** Back-compat: the sole focused region id, or null (when 0 or >1 are enabled). */
    get activeRegion(): number | null { return this._activeRegions && this._activeRegions.size === 1 ? [...this._activeRegions][0] : null; }
    /** All district instances (id + type + centre) — for a region picker / list. */
    get regions(): RegionSeed[] { return this._graph?.regions ?? []; }
    /** Resolve a world (x, z) ground point to its region id — call this on a viewport click to toggle a neighbourhood.
     *  Clicks arrive in WARPED render space; a one-step inverse of the domain warp maps them back to layout space. */
    regionAt(x: number, z: number): number | null {
        if (!this._graph) return null;
        this._warpInto(x, z, this._warpScratch);
        return regionAt(this._graph, x - this._warpScratch[0], z - this._warpScratch[1]);
    }

    /** Resolve a viewport (screen/CSS) click to a district id via the ground plane — MESH-FREE (the city
     *  meshes are non-pickable for perf), so wire the region-editor click through this, not pick3D. */
    regionAtScreen(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): number | null {
        const g = this.scene3d.pickGroundXZ(clientX, clientY, rect, this._params?.groundY ?? 0);
        return g ? this.regionAt(g[0], g[1]) : null;
    }

    // ── Day / night cycle ─────────────────────────────────────────────────────────────────────────
    // Drives the SUN (directional light sweeps + warms at the horizons), ambient, the City-mode sky background,
    // and the city's own lights: glow layers (signs / screens / lamps / lanterns / vending / signal lamps / train
    // windows) brighten as the base flat-map emissive dims, and building WINDOWS light up (the shader 'windows'
    // pattern lit-fraction ramps). All live material updates — NO regeneration, so it can animate every frame.

    /** Set the time of day (0 = midnight · 0.25 = sunrise · 0.5 = noon · 0.75 = sunset). Live, no regen. */
    setTimeOfDay(t: number): void {
        this._timeOfDay = ((t % 1) + 1) % 1;
        this._applyTimeOfDay();
    }
    /** Current time of day 0..1, or null (untouched — the editor's default lighting). */
    get timeOfDay(): number | null { return this._timeOfDay; }

    /** Animate a full day/night loop, `periodSec` seconds per day (default 120). Keeps rendering continuously —
     *  animated screens/water shimmer and the lit-window set drifts while it plays. */
    playDayCycle(periodSec = 120): void {
        this._cyclePeriod = Math.max(5, periodSec);
        this._cycleOn = true;
        this._ensureTicker();
    }
    /** Stop the day/night animation (keeps the current time of day). */
    stopDayCycle(): void { this._cycleOn = false; }
    /** Whether the day/night animation is running. */
    get dayCyclePlaying(): boolean { return this._cycleOn; }
    private _cycleOn = false;

    // ── Turntable (slow auto-orbit around the city) ──────────────────────────────────────────────
    /** Slowly SPIN the view around the city: `degPerSec` > 0 = counter-clockwise (a full lap at 6°/s ≈ 60 s),
     *  negative = clockwise, 0 = stop. Rides the shared ticker; manual alt+drag still works while spinning. */
    setTurntable(degPerSec: number): void {
        this._turntable = degPerSec;
        if (degPerSec !== 0) this._ensureTicker();
    }
    /** Current turntable speed in °/s (0 = off). */
    get turntableSpeed(): number { return this._turntable; }
    private _turntable = 0;

    // ── Cinematic grade (post-processing keyed to the time of day) ───────────────────────────────
    /** Toggle the CINEMATIC GRADE: bloom + colour grade + vignette driven by four time-of-day keyframes
     *  (night/dawn/noon/dusk, lerped as the cycle plays — cool bloomy nights, golden dusks). The host's own
     *  post-processing config is captured on enable and restored on disable. Auto-enabled in City mode. */
    setCinematicGrade(on: boolean): void {
        if (on === this._gradeOn) return;
        this._gradeOn = on;
        if (on) {
            const live = this.scene3d.getPostProcessing3D();
            this._prePostFX = JSON.parse(JSON.stringify(live)) as PostProcessConfig;   // live ref → deep copy
            if (this._timeOfDay != null) this._applyTimeOfDay();
        } else if (this._prePostFX) {
            this.scene3d.setPostProcessing3D(this._prePostFX);
            this._prePostFX = null;
            this.scene3d.requestRender3D();
        }
    }
    /** Whether the cinematic grade is driving the post stack. */
    get cinematicGrade(): boolean { return this._gradeOn; }
    /** Tune ONE keyframe of the grade (partial merge) — the host UI's per-phase knobs write through here. */
    setTimeGradeKey(phase: TimeGradePhase, values: Partial<TimeGradeKey>): void {
        Object.assign(this._gradeKeys[phase], values);
        if (this._gradeOn && this._timeOfDay != null) this._applyTimeOfDay();
    }
    /** The current keyframes (live reference — read for seeding the host UI). */
    get timeGradeKeys(): Record<TimeGradePhase, TimeGradeKey> { return this._gradeKeys; }

    /** Lerp the four grade keyframes at time-of-day `t` (keys sit at 0 night · 0.25 dawn · 0.5 noon · 0.75 dusk). */
    private _gradeAt(t: number): TimeGradeKey {
        const order: TimeGradePhase[] = ['night', 'dawn', 'noon', 'dusk'];
        const x = ((t % 1) + 1) % 1 * 4;
        const i = Math.floor(x) % 4, k = x - Math.floor(x);
        const a = this._gradeKeys[order[i]], b = this._gradeKeys[order[(i + 1) % 4]];
        const L = (p: number, q: number): number => p + (q - p) * k;
        return {
            bloomThreshold: L(a.bloomThreshold, b.bloomThreshold), bloomIntensity: L(a.bloomIntensity, b.bloomIntensity),
            brightness: L(a.brightness, b.brightness), contrast: L(a.contrast, b.contrast), saturation: L(a.saturation, b.saturation),
            tint: [L(a.tint[0], b.tint[0]), L(a.tint[1], b.tint[1]), L(a.tint[2], b.tint[2])],
            vignette: L(a.vignette, b.vignette),
        };
    }

    // ── Traffic sim (v1 — a first taste of the src/game tick) ────────────────────────────────────
    /** Start MOVING traffic: cars driving the long road runs (left-hand, both directions), a moving train on
     *  the viaduct (the parked one hides), and strolling walkers. Runs on the shared ticker; regen-safe. */
    startTraffic(): void {
        this._trafficOn = true;
        this._spawnTraffic();
        if (this._timeOfDay != null) this._applyTimeOfDay();   // dress the fresh movers (headlights/pools) for the current time
        this._ensureTicker();
    }
    /** Stop and remove the movers (the static parked train returns on the next regen). */
    stopTraffic(): void {
        this._trafficOn = false;
        this._despawnTraffic();
    }
    /** Whether the traffic sim is running. */
    get trafficRunning(): boolean { return this._trafficOn; }

    private _spawnTraffic(): void {
        if (!this._graph || this._movers.length) return;
        this._sceneEpoch++;   // movers/doors push into _groups below → LOD must re-hide walkers/birds when zoomed out
        for (const child of this._allWorldMeshes()) if (/rail-train/.test(child.name ?? '')) child.visible = false;   // hide the parked train
        for (const spec of computeTraffic(this._graph)) {
            const g = this.scene3d.addFlatColorMeshGroup('World Traffic', spec.layers, false, this._ensureCityContainer());
            this._groups.push(g);
            const meshes = g.children as unknown as Mesh3D[];
            for (const m of meshes) m.cheapBounds = true;   // movers transform EVERY FRAME — skip the per-frame O(verts) AABB re-scan
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
            this._movers.push({ spec, meshes, len, t: spec.t0, dir: 1, pausedUntil: 0, cooldownUntil: 0, emote, path, visiting: false });
        }
        // DOOR VISITS: collect the stamped front doors + create the two reusable animated door LEAVES
        // (hinge at the mesh origin — rotationY swings them open; hidden until a visit needs one).
        const gp = this._graph.params, ws = gp.radius / 10;
        this._doorSpots = [];
        for (const lot of this._graph.lots) {
            if (!lot.door || !lot.doorOut) continue;
            const e: [number, number] = [-lot.doorOut[1], lot.doorOut[0]];   // door frontage direction
            this._warpInto(lot.door[0], lot.door[1], this._warpScratch);
            this._doorSpots.push({
                x: lot.door[0], z: lot.door[1], lift: this._heightFn(lot.center[0], lot.center[1]),
                ox: lot.doorOut[0], oz: lot.doorOut[1], yaw: Math.atan2(-e[1], e[0]),
                wx: lot.door[0] + this._warpScratch[0], wz: lot.door[1] + this._warpScratch[1],
            });
        }
        this._visits = [];
        if (this._doorSpots.length) {
            const leafGeo = (): ReturnType<Accum3D['geometry']> => {
                const a = new Accum3D();
                a.obox([0.013 * ws, 0.033 * ws, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.013 * ws, 0.033 * ws, 0.0025 * ws);
                return a.geometry();
            };
            const lg = this.scene3d.addFlatColorMeshGroup('World Visit Doors', [
                { name: 'world:visit-door-0', color: [0.32, 0.22, 0.14], geometry: leafGeo() },
                { name: 'world:visit-door-1', color: [0.32, 0.22, 0.14], geometry: leafGeo() },
            ], false, this._ensureCityContainer());
            this._groups.push(lg);
            this._doorLeaves = lg.children as unknown as Mesh3D[];
            for (const l of this._doorLeaves) { l.visible = false; l.cheapBounds = true; }
        }
        // eslint-disable-next-line no-console
        if (WORLD_VERBOSE) console.log('[world] traffic started:', this._movers.length, 'movers');
        this._lastGlowNight = -1;   // fresh mover meshes (headlights etc.) must be dressed by the next glow pass
        if (this._renderStyle) this._applyRenderStyle();
        this._tickTraffic(0);   // place everyone before the first frame
    }
    private _despawnTraffic(): void {
        for (const mv of this._movers) {
            const g = (mv.meshes[0] as unknown as { parent?: MeshGroup3D })?.parent;
            if (g) { this.scene3d.removeFlatColorMeshGroup(g); const i = this._groups.indexOf(g); if (i >= 0) this._groups.splice(i, 1); }
        }
        this._movers = [];
        this._visits = [];
        // Remove the reusable door-LEAVES group too (not just hide it) — _spawnTraffic creates a fresh one every
        // time, so hiding-only orphaned a 2-mesh group into _groups + the scene graph on EVERY traffic respawn
        // (weather / railway / clouds / traffic toggles), growing getAllMeshes() and the pool without bound.
        const lg = (this._doorLeaves[0] as unknown as { parent?: MeshGroup3D })?.parent;
        if (lg) { this.scene3d.removeFlatColorMeshGroup(lg); const i = this._groups.indexOf(lg); if (i >= 0) this._groups.splice(i, 1); }
        this._doorLeaves = [];
        for (const child of this._allWorldMeshes()) if (/rail-train/.test(child.name ?? '')) child.visible = true;
    }

    private _tickTraffic(dt: number): void {
        const graph = this._graph;
        if (!graph) return;
        // NOTE: _simTime is advanced by the shared ticker (not here) — this also runs once at spawn with dt=0.
        const p = graph.params, s = p.radius / 10, R = p.radius;
        const cw = 2 * R / Math.max(2, p.gridCols | 0), ch = 2 * R / Math.max(2, p.gridRows | 0);

        // Current positions + headings (for the car-yield scan and chat encounters) — packed into ONE reused
        // Float32Array (stride 4: x, z, hx, hz) instead of ~220 fresh objects per frame (GC pressure).
        if (this._poseBuf.length < this._movers.length * 4) this._poseBuf = new Float32Array(this._movers.length * 4);
        const pose = this._poseBuf;
        for (let i = 0; i < this._movers.length; i++) {
            const mv = this._movers[i], sp = mv.spec;
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
            const win = Math.floor(this._simTime / 10);
            // DOOR VISITS: a walker passing a stamped front door may head in (~12%/10 s window; ≤2 at once).
            if (this._doorSpots.length && this._visits.length < Math.min(2, this._doorLeaves.length)) {
                for (let i = 0; i < this._movers.length && this._visits.length < 2; i++) {
                    const a = this._movers[i];
                    if (a.spec.kind !== 'walker' || a.visiting || this._simTime < a.cooldownUntil || this._simTime < a.pausedUntil) continue;
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
                    this._visits.push({ mv: a, door: best, start: this._simTime, dur: 5 + hash2(i * 3.1, win, (p.seed ^ 0x77d3) >>> 0) * 7, leaf });
                }
            }
            for (let i = 0; i < this._movers.length; i++) {
                const a = this._movers[i];
                if (a.spec.kind !== 'walker' || a.visiting || this._simTime < a.cooldownUntil) continue;
                for (let j = i + 1; j < this._movers.length; j++) {
                    const b = this._movers[j];
                    if (b.spec.kind !== 'walker' || b.visiting || this._simTime < b.cooldownUntil) continue;
                    const dxp = pose[i * 4] - pose[j * 4], dzp = pose[i * 4 + 1] - pose[j * 4 + 1];
                    if (dxp * dxp + dzp * dzp > (0.05 * s) * (0.05 * s)) continue;
                    if (hash2(i * 31.7 + j * 13.3, win, (p.seed ^ 0xc4a7) >>> 0) > 0.2) continue;
                    a.pausedUntil = b.pausedUntil = this._simTime + 3.5;      // stop and talk
                    a.cooldownUntil = b.cooldownUntil = this._simTime + 18;
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

        for (let i = 0; i < this._movers.length; i++) {
            const mv = this._movers[i], sp = mv.spec;
            if (mv.visiting) continue;   // door-visit sim owns this walker's meshes right now
            if (mv.emote && mv.emote.visible && this._simTime >= mv.pausedUntil) mv.emote.visible = false;   // chat over
            let speed = this._simTime < mv.pausedUntil ? 0 : sp.speed;

            // CAR AI: brake for a car ahead in the same lane, or any pedestrian ahead on/near the roadway.
            if (speed > 0 && sp.kind === 'car') {
                const mex = pose[i * 4], mez = pose[i * 4 + 1], mehx = pose[i * 4 + 2], mehz = pose[i * 4 + 3];
                for (let j = 0; j < this._movers.length; j++) {
                    if (j === i) continue;
                    const ot = this._movers[j].spec.kind;
                    if (ot !== 'car' && ot !== 'walker') continue;
                    const dxp = pose[j * 4] - mex, dzp = pose[j * 4 + 1] - mez;
                    const ahead = dxp * mehx + dzp * mehz;                    // along my heading
                    // JUNCTION / OVERLAP guard: another vehicle beside-or-ahead within collision radius (any
                    // heading — crossing streets meet at junctions) → the LOWER-index car has priority, the
                    // higher one stops. Deterministic tie-break, so crossing pairs can't deadlock, and any
                    // residual overlap resolves itself (one drives clear while the other waits).
                    if (this._movers[j].visiting) continue;   // walkers inside a building can't block traffic
                    if (ot === 'car' && ahead > -0.02 * s && j < i
                        && dxp * dxp + dzp * dzp < (0.085 * s) * (0.085 * s)) { speed = 0; break; }
                    if (ahead <= 0.02 * s) continue;
                    const lateral = Math.abs(dxp * -mehz + dzp * mehx);
                    if (ot === 'car' && ahead < 0.16 * s && lateral < 0.06 * s) { speed = 0; break; }               // car-following gap
                    // Yield to pedestrians ON THE ROADWAY (jaywalkers/crossers) — 0.35× keeps SIDEWALK walkers
                    // (lane ≈ 0.5×width + margin) out of the window, so vehicles stop phantom-braking for them.
                    if (ot === 'walker' && ahead < 0.14 * s && lateral < p.streetWidth * 0.35) { speed = 0; break; }
                }
            }

            // BUS STOPS: route-t positions where the bus pulls up for a moment (then a cooldown so it doesn't
            // re-trigger while still inside the stop window).
            if (sp.stops && speed > 0 && this._simTime >= mv.cooldownUntil) {
                for (const st of sp.stops) {
                    if (Math.abs(mv.t - st) < 0.01) { mv.pausedUntil = this._simTime + 2.2; mv.cooldownUntil = this._simTime + 9; speed = 0; break; }
                }
            }

            // Advance along the route — shuttles (train / shotengai strollers) reverse at their end margins.
            const step = (sp.kind === 'rain' ? 0 : (speed * dt) / mv.len);   // fall clusters don't travel their route
            if (sp.pingPong) {
                const lo = sp.margin ?? 0, hi = 1 - (sp.margin ?? 0);
                mv.t += step * mv.dir;
                if (mv.t >= hi) { mv.t = hi; mv.dir = -1; }
                else if (mv.t <= lo) { mv.t = lo; mv.dir = 1; }
            } else {
                mv.t = (mv.t + step) % 1;
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
                y = Math.sin(this._simTime * 1.4 + sp.t0 * 6.283) * 0.05 * s;   // lazy vertical swim bob (fish, soaring birds)
            } else if (sp.kind === 'rain') {
                const range = sp.fallRange ?? 1.7 * s;   // fall from cloud height, wrap back to the top
                y = range - ((this._simTime * sp.speed + sp.t0 * range) % range) - 0.32 * range;
                if (sp.sway) { const sw = Math.sin(this._simTime * 0.9 + sp.t0 * 6.283) * sp.sway; px += sw; pz += sw * 0.6; }
            } else if (sp.kind === 'boat') {
                y = this._smoothFn(px, pz) + Math.sin(this._simTime * 0.8 + sp.t0 * 6.283) * 0.003 * s;   // water line + gentle bob
            } else if (sp.kind !== 'cloud' && sp.kind !== 'train') {
                if (cellLevelAt(graph, px, pz) < 0) {
                    const sm = this._smoothFn(px, pz);
                    const horiz = Math.abs(sp.b[0] - sp.a[0]) >= Math.abs(sp.b[1] - sp.a[1]);
                    const span = horiz ? cw : ch;
                    const cellT = horiz ? (((px + R) % cw) + cw) % cw / cw : (((pz + R) % ch) + ch) % ch / ch;
                    const rise = Math.min(0.045 * s, span * 0.5 * 0.18);
                    y = sm + 0.012 * s + rise * (1 - (2 * cellT - 1) * (2 * cellT - 1));
                } else {
                    y = this._heightFn(px, pz);
                }
                // WALKER GAIT: a small step-bounce while moving (pedestrians stop gliding like chess pieces).
                if (sp.kind === 'walker' && speed > 0) y += Math.abs(Math.sin(this._simTime * (8 + (sp.speed / s) * 25) + sp.t0 * 6.283)) * 0.004 * s;
            }
            // Domain warp LAST — heights + all layout logic sampled unwarped, then the position curves with the roads.
            // (Sky elements — clouds/rain sheets — stay unwarped; the warp is a ground-plane illusion.)
            // Allocation-free: write into the reused scratch, not a fresh tuple (this runs per mover per frame).
            let wx = 0, wz = 0;
            if (sp.kind !== 'cloud' && sp.kind !== 'rain') { this._warpInto(px, pz, this._warpScratch); wx = this._warpScratch[0]; wz = this._warpScratch[1]; }
            for (const m of mv.meshes) {
                m.x = px + wx; m.y = sp.baseY + y; m.z = pz + wz;
                if (yaw != null) m.rotationY = yaw;
                m.updateLocalMatrix();   // bare x/y/z writes don't rebuild the 3D matrix — this bumps the matrix version
            }
        }
        // Repack instance matrices + draw this frame (otherwise movers only "jump" when an interaction forces it).
        this.scene3d.notifyMeshTransformsChanged3D();
    }

    /** Advance one DOOR VISIT. Timeline (t since start): 0–0.5 the leaf swings open while the walker heads
     *  for the door (0–0.9) · 0.9 the walker steps INSIDE (meshes hidden) · 0.9–1.4 the leaf swings shut and
     *  hides (the painted door reads as closed) · `dur` seconds inside · then the mirror: open, reappear,
     *  walk back to the route, close. Returns true when the visit is finished. */
    private _tickVisit(v: DoorVisit, s: number): boolean {
        const mv = v.mv, sp = mv.spec, t = this._simTime - v.start;
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
            mv.cooldownUntil = this._simTime + 30;
            v.leaf.visible = false;
            for (const m of mv.meshes) m.visible = (m.name ?? '') !== 'world:traffic-emote';
            return true;
        }

        // Leaf transform (hinge at the door's left jamb, proud of the wall; baked door lift).
        const e: [number, number] = [-door.oz, door.ox];
        const hx = door.x - e[0] * 0.013 * s + door.ox * 0.006 * s;
        const hz = door.z - e[1] * 0.013 * s + door.oz * 0.006 * s;
        this._warpInto(hx, hz, this._warpScratch);
        const lwx = this._warpScratch[0], lwz = this._warpScratch[1];
        v.leaf.visible = leafOn;
        if (leafOn) {
            v.leaf.x = hx + lwx; v.leaf.y = gy + door.lift; v.leaf.z = hz + lwz;
            v.leaf.rotationY = door.yaw + swing * 1.55;
            v.leaf.updateLocalMatrix();
        }

        // Walker transit: route anchor → doorstep (eased), terrain height blending up to the door lift.
        const ke = k * k * (3 - 2 * k);
        const px = rx + (tx - rx) * ke, pz = rz + (tz - rz) * ke;
        const y = this._heightFn(px, pz) * (1 - ke) + door.lift * ke;
        this._warpInto(px, pz, this._warpScratch);
        const wx = this._warpScratch[0], wz = this._warpScratch[1];
        for (const m of mv.meshes) {
            const isEmote = (m.name ?? '') === 'world:traffic-emote';
            m.visible = walkerOn && !isEmote;
            if (walkerOn) { m.x = px + wx; m.y = gy + y; m.z = pz + wz; m.updateLocalMatrix(); }
        }
        return false;
    }

    // ── Shared animation ticker (day/night cycle + traffic) ──────────────────────────────────────
    private _tickerRaf = 0;
    private _tickerPrev = 0;
    private _tickErrorLogged = false;
    private _ensureTicker(): void {
        if (this._tickerRaf || typeof requestAnimationFrame === 'undefined') return;   // headless-safe
        this._tickerPrev = performance.now();
        const tick = (now: number): void => {
            const dt = Math.min(0.1, (now - this._tickerPrev) / 1000);
            this._tickerPrev = now;
            // The rAF chain MUST survive a bad frame — one uncaught throw here would silently freeze
            // traffic + the day cycle forever (no next frame is ever requested).
            try {
                this._simTime += dt;   // the shared sim clock (traffic + weather anims; NOT advanced in _tickTraffic)
                if (this._turntable !== 0) this.scene3d.orbitTurntable(this._turntable * (Math.PI / 180) * dt);
                if (this._cycleOn) {
                    this._timeOfDay = (((this._timeOfDay ?? 0.5) + dt / this._cyclePeriod) % 1 + 1) % 1;
                    this._applyTimeOfDay();
                }
                // LIGHTNING (storms only): hash-keyed 2 s windows → an occasional double-strobe flash that
                // spikes the sun + ambient via _applyTimeOfDay (only re-applied on flash EDGES — it's a full
                // material walk, so we don't run it every frame).
                if (this._params?.weather === 'rain' && this._timeOfDay != null) {
                    const win = Math.floor(this._simTime / 2);
                    const strikes = hash2(win, 17.3, ((this._params?.seed ?? 1) ^ 0x7e11) >>> 0) < 0.14;
                    const tIn = this._simTime - win * 2;
                    const flash = strikes && tIn < 0.24 ? ((tIn < 0.07 || (tIn > 0.12 && tIn < 0.2)) ? 1 : 0.25) : 0;
                    if (Math.abs(flash - this._flash) > 0.05) { this._flash = flash; this._applyTimeOfDay(); }
                }
                if (this._trafficOn && this._movers.length && !this._moversHidden) this._tickTraffic(dt);   // ticks + notifies transforms + schedules
                if (this._editPulseOn && this._cityMode && this._applyEditPulse()) this.scene3d.requestRender3D();   // live border-glow breath
            } catch (err) {
                if (!this._tickErrorLogged) {
                    this._tickErrorLogged = true;
                    // eslint-disable-next-line no-console
                    console.error('[world] animation tick failed (continuing):', err);
                }
            }
            const stormy = this._params?.weather === 'rain' && this._timeOfDay != null;   // lightning needs the clock
            const trafficLive = this._trafficOn && !this._moversHidden;   // paused (centre off-screen) counts as nothing to animate
            if (!this._cycleOn && !trafficLive && !stormy && this._turntable === 0 && !(this._editPulseOn && this._cityMode)) { this._tickerRaf = 0; return; }   // nothing left to animate
            this._tickerRaf = requestAnimationFrame(tick);
        };
        this._tickerRaf = requestAnimationFrame(tick);
    }

    // ── City Edit Mode: live "cyberspace stage" pulse on the border glow ─────────────────────────
    private _editPulseOn = false;
    private _pulseBase = new Map<string, [number, number, number]>();   // meshId → built emissive (the pulse rides on top)

    /** Toggle a slow breathing GLOW on the border edge — the "live stage" feel while City Edit Mode is open. Runs on
     *  the shared ticker (keeps it alive so the pulse animates); restores the built emissive when turned off. */
    setEditPulse(on: boolean): void {
        if (on === this._editPulseOn) return;
        this._editPulseOn = on;
        if (on) { this._ensureTicker(); return; }
        for (const g of this._groups) for (const child of g.children) {   // restore each border-glow mesh's base emissive
            const m = child as Mesh3D, base = this._pulseBase.get(m.id);
            if (base && m.material) { m.material.emissive = { r: base[0], g: base[1], b: base[2], a: 1 }; m.materialDirty = true; }
        }
        this._pulseBase.clear();
        this.scene3d.requestRender3D();
    }

    /** Modulate the border-glow emissive by a slow sine. Returns true if any border-glow mesh was touched (so the
     *  ticker only forces a re-render when there's actually something pulsing). */
    private _applyEditPulse(): boolean {
        const pulse = 0.62 + 0.38 * Math.sin(this._simTime * 1.5);   // slow breath ~0.24..1.0
        let touched = false;
        for (const g of this._groups) {
            if (!/Border Glow/.test(g.name ?? '')) continue;
            for (const child of g.children) {
                const m = child as Mesh3D;
                if (!m.material) continue;
                let base = this._pulseBase.get(m.id);
                if (!base) { const e = m.material.emissive; base = [e.r, e.g, e.b]; this._pulseBase.set(m.id, base); }
                m.material.emissive = { r: base[0] * pulse, g: base[1] * pulse, b: base[2] * pulse, a: 1 };
                m.materialDirty = true;
                touched = true;
            }
        }
        return touched;
    }

    private _allWorldMeshes(): Mesh3D[] {
        const out: Mesh3D[] = [];
        for (const g of this._groups) for (const child of g.children) out.push(child as Mesh3D);
        return out;
    }

    // ── Real TEXT signs (landmark name plates + shotengai arch boards) ───────────────────────────
    // The pure module computes label + placement + quad; here each label is rasterized to a small canvas and
    // bound as the mesh texture. Browser-only (headless builds show the plain plate colour).
    private _addTextSigns(graph: WorldGraph): void {
        const specs = computeTextSigns(graph);
        if (!specs.length) return;
        this._add('World Sign Text', specs.map(sp => sp.layer));
        if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return;
        const group = this._groups[this._groups.length - 1];
        // BATCH all ~75 bitmaps and apply them in ONE go — resolving them one-by-one used to trigger a
        // per-arrival repack for many consecutive frames right after every regen (a visible hitch window).
        // Bitmaps are CACHED by label+colour across regens (STATION / BAKERY / 1ST AVE recur every city),
        // so a typical slider regen rasterizes zero new canvases.
        const jobs: Promise<{ id: string; bmp: ImageBitmap }>[] = [];
        specs.forEach((sp, i) => {
            const mesh = group.children[i] as Mesh3D;
            if (!mesh) return;
            const key = sp.label + '|' + sp.layer.color.map(c => c.toFixed(3)).join(',');
            const cached = this._signBitmaps.get(key);
            if (cached) { jobs.push(Promise.resolve({ id: mesh.id, bmp: cached })); return; }
            const cv = document.createElement('canvas');
            cv.width = 256; cv.height = 64;
            const ctx = cv.getContext('2d');
            if (!ctx) return;
            const [r, g, b] = sp.layer.color;
            ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
            ctx.fillRect(0, 0, 256, 64);
            ctx.fillStyle = '#f6f1e2';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            let px = 40;   // shrink-to-fit for longer English labels
            do { ctx.font = `bold ${px}px sans-serif`; px -= 2; } while (px > 14 && ctx.measureText(sp.label).width > 236);
            ctx.fillText(sp.label, 128, 34);
            jobs.push(createImageBitmap(cv).then(bmp => { this._signBitmaps.set(key, bmp); return { id: mesh.id, bmp }; }));
        });
        void Promise.all(jobs).then(results => {
            for (const { id, bmp } of results) void this.scene3d.setMeshTexture(id, bmp);
        });
    }
    /** Rasterized sign textures, keyed label|colour — persists across regens (~75 × 64KB ≈ 5 MB, worth it). */
    private _signBitmaps = new Map<string, ImageBitmap>();

    /** Apply a named CITY STYLE PACK — one call swaps the whole aesthetic (palette, warp, elevation, densities,
     *  render style, time of day). Packs are data (`CITY_STYLES` in src/world/styles.ts); every knob remains
     *  individually tweakable afterwards. Returns the regenerated graph, or null for an unknown name. */
    applyStyle(name: string): WorldGraph | null {
        const pack = cityStyle(name);
        if (!pack) return null;
        const graph = this.updateCity(pack.params);
        if (pack.renderStyle !== undefined) this.setRenderStyle(pack.renderStyle ?? null);
        if (pack.timeOfDay !== undefined) this.setTimeOfDay(pack.timeOfDay);
        return graph;
    }
    /** The available style pack names (for a panel dropdown). */
    get styleNames(): string[] { return [...CITY_STYLE_NAMES]; }

    /** Restyle the WHOLE city live: 'cel' / 'cel-hd' (toon), 'sketch', 'ink', 'gouraud' (PS1), or null → default PBR.
     *  (For the full retro pipeline — low res / dither / affine — combine with sm.setRetroPreset('wobble'|'pocket').) */
    setRenderStyle(style: RenderStyle | null): void {
        this._renderStyle = style;
        this._applyRenderStyle();
    }
    /** The current world-wide style override, or null (PBR). */
    get renderStyle(): RenderStyle | null { return this._renderStyle; }

    private _applyRenderStyle(): void {
        const style = this._renderStyle ?? 'default';
        for (const g of this._groups) {
            for (const child of g.children) {
                const m = child as Mesh3D;
                if (!m.material) continue;
                m.material.renderStyle = style;
                m.gpuDirty = true;
            }
        }
        this.scene3d.requestRender3D();
    }

    private _applyTimeOfDay(): void {
        const t = this._timeOfDay;
        if (t == null) return;
        const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
        const lerp3 = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] =>
            [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

        const ang = (t - 0.25) * Math.PI * 2;                       // sun sweep (0.25 = sunrise on the horizon)
        const elev = Math.sin(ang);                                 // -1..1 sun elevation
        const day = clamp01((elev + 0.12) / 0.45);                  // 0 night → 1 day (soft twilight band)
        const dusk = Math.exp(-((elev / 0.16) ** 2)) * clamp01(day * 3);   // warm burst near sunrise/sunset
        const night = 1 - day;
        const weather = this._params?.weather ?? 'clear';
        const rain = weather === 'rain', snow = weather === 'snow'; // overcast: dimmer, flatter, closer fog
        const flash = this._flash;                                  // lightning strobe (storms; set by the ticker)

        // SUN: direction sweeps east→west; at night a faint moon-ish light from above keeps silhouettes readable.
        const dirX = -Math.cos(ang) * 0.8, dirY = -Math.max(0.1, elev * 0.9 + 0.1), dirZ = -0.45;
        let lc = lerp3([0.30, 0.40, 0.62], [1.0, 0.97, 0.90], day);
        lc = lerp3(lc, [1.0, 0.55, 0.30], dusk * 0.7);
        if (rain) lc = lerp3(lc, [0.55, 0.58, 0.64], 0.55);         // grey key light under the rain deck
        if (snow) lc = lerp3(lc, [0.80, 0.83, 0.90], 0.4);          // cold pale winter light
        if (flash > 0) lc = lerp3(lc, [0.9, 0.93, 1.0], flash * 0.8);
        this.scene3d.setDirectionalLight(dirX, dirY, dirZ, lc[0], lc[1], lc[2], (0.18 + 0.92 * day) * (rain ? 0.72 : snow ? 0.88 : 1) * (1 + flash * 2.2));
        let ac = lerp3([0.16, 0.20, 0.34], [0.55, 0.62, 0.72], day);
        ac = lerp3(ac, [0.75, 0.50, 0.40], dusk * 0.4);
        if (flash > 0) ac = lerp3(ac, [0.85, 0.9, 1.0], flash * 0.6);
        this.scene3d.setAmbientLight(ac[0], ac[1], ac[2], (0.28 + 0.5 * day) * (rain ? 0.85 : 1) * (1 + flash * 1.1));

        // SKY: the City-mode focus background becomes a day↔dusk↔night gradient.
        let top = lerp3([0.03, 0.05, 0.12], [0.45, 0.65, 0.88], day);
        top = lerp3(top, [0.55, 0.30, 0.42], dusk * 0.5);
        let bot = lerp3([0.10, 0.12, 0.22], [0.82, 0.88, 0.94], day);
        bot = lerp3(bot, [1.0, 0.62, 0.36], dusk * 0.7);
        this.scene3d.setMeshEditBgMode3D({ mode: 'gradient', color1: [top[0], top[1], top[2], 1], color2: [bot[0], bot[1], bot[2], 1] });

        // DISTANCE FOG: a soft atmospheric haze matched to the horizon colour — blue-grey by day, warm at dusk,
        // deep navy at night. Adds depth/scale to the diorama; the far plane keeps the whole city visible.
        // The `fog` param is the panel toggle.
        if (this._params?.fog === false) {
            this.scene3d.setFog3D({ mode: 'off' });
        } else {
            // Fog distance scales with the whole world extent (a tiled world is several cities wide → push it back).
            const R = this._params?.worldMode === 'tiled' && this._params ? tiledWorldExtent(this._params) : (this._params?.radius ?? 10);
            let fc = lerp3([0.05, 0.07, 0.14], [0.74, 0.81, 0.88], day);
            fc = lerp3(fc, [0.85, 0.58, 0.42], dusk * 0.6);
            if (rain) fc = lerp3(fc, [0.52, 0.56, 0.62], 0.5);      // rain haze closes in
            if (snow) fc = lerp3(fc, [0.82, 0.84, 0.90], 0.55);     // bright white winter haze
            // Fog distances are CAMERA-relative: the orbit camera sits ~2–3·R from the centre, so `near` must
            // clear the whole city (~camera + R) or everything drowns in haze. Weather only closes it in a bit.
            // Weather fog ~50% lighter than before: keep the onset (`near`) but DOUBLE the near→far ramp so haze
            // builds up half as fast (rain far 5.6→9.3, snow 6.0→10.0). Clear is unchanged.
            const fogNear = rain ? 1.9 : snow ? 2.0 : 2.4, fogFar = rain ? 9.3 : snow ? 10.0 : 7.5;
            this.scene3d.setFog3D({ mode: 'linear', color: [fc[0], fc[1], fc[2]], near: R * fogNear, far: R * fogFar, density: 0.1 });
            this._fogColor = [fc[0], fc[1], fc[2]];   // remembered so streaming can re-derive zoom-aware distances (see _streamCb)
        }
        if (this._params?.fog === false) this._fogColor = null;

        this._applyGlow(night);

        // REAL POINT LIGHTS at night: up to 16 street lamps become actual lights — walls, cars and walkers
        // entering a lamp's radius pick up its warm pool (the FF7-street look). Off by day (sun wins).
        {
            const g = this._graph;
            const lampOn = night > 0.35 && g ? Math.min(1, (night - 0.35) / 0.3) : 0;
            if (lampOn > 0 && g) {
                const s = g.params.radius / 10;
                const lights: { pos: [number, number, number]; radius: number; color: [number, number, number]; intensity: number }[] = [];
                for (let i = 0; i < g.intersections.length && lights.length < 16; i++) {
                    if (hash2(i * 13.7, 5.1, (g.params.seed ^ 0x11a9) >>> 0) > 16 / Math.max(16, g.intersections.length)) continue;
                    const it = g.intersections[i];
                    this._warpInto(it.pos[0], it.pos[1], this._warpScratch);
                    lights.push({
                        pos: [it.pos[0] + this._warpScratch[0], g.params.groundY + this._heightFn(it.pos[0], it.pos[1]) + 0.2 * s, it.pos[1] + this._warpScratch[1]],
                        radius: 0.85 * s, color: [1.0, 0.85, 0.55], intensity: 0.9 * lampOn,
                    });
                }
                this.scene3d.setPointLights3D(lights);
            } else {
                this.scene3d.setPointLights3D([]);
            }
        }

        // CINEMATIC GRADE: drive the post stack (bloom / colour grade / vignette) from the four time-of-day
        // keyframes. Lightning flashes momentarily crank the bloom (the sky blows out, like a real strike).
        if (this._gradeOn) {
            const g = this._gradeAt(t);
            this.scene3d.setPostProcessing3D({
                bloom: { enabled: true, threshold: Math.max(0.05, g.bloomThreshold * (1 - flash * 0.4)), intensity: g.bloomIntensity * (1 + flash * 0.9) },
                colorGrade: { enabled: true, brightness: g.brightness, contrast: g.contrast, saturation: g.saturation, tint: g.tint },
                vignette: { enabled: g.vignette > 0.01, intensity: g.vignette, radius: 0.78, softness: 0.5 },
            });
        }
        if (rain) this._ensureTicker();   // storms need the shared clock alive for lightning (idempotent)
    }

    /** Per-layer light dressing: the city's own lights come ON as darkness rises, the flat-map base emissive dims
     *  (so the lights POP against a dark city), and building windows light up. Matched by layer name. */
    private _lastGlowNight = -1;
    private _lastGlowWeather = '';
    private _applyGlow(night: number): void {
        // THROTTLE: the glow walk touches every mesh material — skip when nothing meaningful changed
        // (lightning flashes and per-frame cycle ticks call _applyTimeOfDay far more often than the glow
        // actually needs to move). ~0.004 night ≈ half a minute of a 2-minute day cycle per re-dress.
        const weatherNow = this._params?.weather ?? 'clear';
        if (Math.abs(night - this._lastGlowNight) < 0.004 && weatherNow === this._lastGlowWeather) return;
        this._lastGlowNight = night;
        this._lastGlowWeather = weatherNow;
        const GLOW: [RegExp, number, number][] = [   // [layer-name match, day factor, night factor]
            [/sky-stars|sky-moon/, 0.0, 1.5],        // celestial: invisible-dark by day (also visibility-gated below)
            [/headlight|taillight|lamp-pool/, 0.25, 1.9],   // the moving/pooled night lights
            [/sign-|screen-|vending-|busstop-sign|sg-lantern|rail-train-win|lm-accent|lamplights|traffic-holo|traffic-flyer-glow|traffic-skytrain-glow|robot-visor|rail-sky/, 0.6, 1.7],
            [/signal-red|signal-yellow|signal-green/, 0.55, 1.5],
            [/canal|pond|fountain-water/, 0.45, 0.28],
            [/./, 0.45, 0.13],                       // everything else: dark city ground/massing at night
        ];
        const litFrac = 0.62 * Math.max(0, Math.min(1, night * 1.6 - 0.1));   // windows come on through dusk
        const weather = this._params?.weather ?? 'clear';
        const wet = weather === 'rain';   // rain-slick asphalt: low roughness → the city lights smear
        const snowy = weather === 'snow'; // frost: ground/roof layers get a white emissive cast (reversible — recomputed each pass)
        const showSky = night > 0.45 && weather === 'clear';   // stars/moon: night only, hidden by an overcast deck
        for (const g of this._groups) {
            for (const child of g.children) {
                const m = child as Mesh3D;
                const mat = m.material;
                if (!mat) continue;
                const name = m.name ?? '';
                if (/border-glow/.test(name)) continue;   // the border glow keeps its built emissive (bright always); the edit pulse owns it
                if (/sky-stars|sky-moon/.test(name)) m.visible = showSky;
                const hit = GLOW.find(([re]) => re.test(name))!;
                const f = hit[1] + (hit[2] - hit[1]) * night;
                const d = mat.diffuse;
                if (snowy && /world:roads|sidewalk|crosswalk|world:roofs|courtyard|world:parking|zone-|parks/.test(name)) {
                    const k = 0.5;   // frost blend toward white
                    mat.emissive = { r: d.r * f * (1 - k) + 0.68 * k, g: d.g * f * (1 - k) + 0.70 * k, b: d.b * f * (1 - k) + 0.74 * k, a: 1 };
                } else {
                    mat.emissive = { r: d.r * f, g: d.g * f, b: d.b * f, a: 1 };
                }
                if (mat.patternMode === 'windows') mat.patternSpacing = litFrac;
                if (/world:roads|sidewalk|crosswalk|roadpaint/.test(name)) mat.roughness = wet ? 0.35 : 1;
                // materialDirty (NOT gpuDirty): repack the instance slots without re-uploading the whole
                // city's geometry + rebuilding the texture atlas — the old flag caused multi-second hitches.
                m.materialDirty = true;
            }
        }
    }

    /** Remove the whole generated world from the scene. */
    clear(): void {
        this.stopDayCycle();
        this._abortAsync();         // drop any staged half-built city
        this._stream.clear();       // abort any in-flight tile pump + forget the neighbour-tile cache
        this._tileSig = '';
        this._streamFocus = { x: 0, z: 0, scale: 1 };   // origin diorama focus (follow-off)
        this._lastVisibleSig = '';
        this._lastViewSig = '';
        this._lastCoarseSig = '';
        this._lastFogReach = 0;
        this._worstJobMs = 0;
        this._worstJobName = '';
        if (this._compactTimer) { clearTimeout(this._compactTimer); this._compactTimer = null; }
        if (this._reassembleRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._reassembleRaf);
        this._reassembleRaf = 0;
        const drained = new Set<ReassembleCtx>();   // resolve each in-flight tile's Promise ONCE (jobs share a ctx)
        for (const job of this._reassembleQueue) if (!drained.has(job.ctx)) { drained.add(job.ctx); job.ctx.resolve([]); }
        this._reassembleQueue.length = 0;
        if (this._promoteTimer) { clearTimeout(this._promoteTimer); this._promoteTimer = null; }   // no ghost rebuilds after a clear
        this._targetParams = null;
        this._lastGlowNight = -1;   // fresh meshes must be re-dressed (the glow throttle would skip them)
        this._visits = [];
        this._doorSpots = [];
        this._doorLeaves = [];      // the leaf group lives in _groups — removed below
        this._movers = [];   // mover groups live in _groups (removed below); _trafficOn persists → respawns on regen
        for (const g of this._groups) this.scene3d.removeFlatColorMeshGroup(g);
        this._groups = [];
        this._tileGroups.clear();
        this._tileRetired.clear();   // retired tiles belong to the world being cleared — never revive across worlds
        this._tileRetiredBytes = 0;
        this._centreHidden = false;  // fresh groups spawn visible — the flag must match
        this.scene3d.setShadowsSuspended3D(false);
        if (this._dynResTimer) { clearTimeout(this._dynResTimer); this._dynResTimer = null; } this._dynResMoveStart = 0;
        if (this._dynResOn) { this._dynResOn = false; this.scene3d.setDynamicResScale3D(1); }
        // Remove the (now-empty) City wrapper too; a rebuild recreates it and re-applies `_cityTransform`, so the
        // placement persists across regens. (`_cityTransform` itself is NOT reset here — only setCityTransform changes it.)
        if (this._cityContainer) { this.scene3d.removeFlatColorMeshGroup(this._cityContainer); this._cityContainer = null; }
        this._graph = null;
    }

    /** Cache the city's aggregate bounds for the gizmo (once per build; excludes moving traffic/doors). */
    private _cacheCityBounds(): void {
        if (this._cityContainer) this.scene3d.cacheGroupBounds(this._cityContainer, n => /World Traffic|World Visit Doors|World Void Grid|World Border Glow|World Apron/.test(n));
    }

    private _add(name: string, layers: LayoutPreviewLayer[]): void {
        this._addStaged(name, layers, this._heightFn, this._smoothFn, this._warpInto, this._groups);
        this._sceneEpoch++;   // new visible nodes → the LOD re-hide must re-walk once (see _lodCb)
    }

    /** The one City wrapper container — created lazily; all world/traffic groups attach under it. */
    private _ensureCityContainer(): MeshGroup3D {
        if (!this._cityContainer) {
            // ADOPT an existing City node (e.g. a marker deserialized from a save) so we NEVER stack duplicates;
            // only create one if none exists.
            this._cityContainer = this.scene3d.findExistingCityContainer() ?? this.scene3d.createCityContainer('City');
            this._applyCityTransform();   // re-apply the persisted placement to the fresh container
        }
        return this._cityContainer;
    }

    /** Push the placement transform to the container: IDENTITY while editing (city upright in the editor),
     *  the stored `_cityTransform` when placed in the illustration. */
    private _applyCityTransform(): void {
        if (!this._cityContainer) return;
        const t = this._cityMode
            ? { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }
            : this._cityTransform;
        this.scene3d.setGroupTransform(this._cityContainer, t);
    }

    /** The placed City's transform (translate + rotate). Rotate lets the flat illustration view show top/angled
     *  instead of just the skyline. No scale (would distort the diorama). Applied live when NOT in the editor. */
    setCityTransform(t: Partial<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }>): void {
        this._cityTransform = { ...this._cityTransform, ...t };
        if (!this._cityMode) this._applyCityTransform();
    }
    getCityTransform(): { x: number; y: number; z: number; rx: number; ry: number; rz: number } { return { ...this._cityTransform }; }
    /** Scene-graph id of the City wrapper node (for the host outliner / selection). null if no city. */
    getCityContainerId(): string | null { return this._cityContainer?.id ?? null; }

    /** _add with explicit height/warp environment + target list — the ASYNC regen stages a NEW city's groups
     *  (built with the NEW graph's fields) while the OLD city stays live and ticking. `silent` skips the host
     *  scene-graph notification (async staging → the host never sees the transient old+new "2N" graph). */
    private _addStaged(name: string, layers: LayoutPreviewLayer[],
        heightFn: (x: number, z: number) => number, smoothFn: (x: number, z: number) => number,
        warpInto: (x: number, z: number, out: [number, number]) => void, into: MeshGroup3D[], silent = false, preDraped = false): void {
        if (!layers.length) return;
        if (preDraped) {   // streamed tiles arrive world-ready (drapeTileLayers ran in the worker) — skip both passes
            into.push(this.scene3d.addFlatColorMeshGroup(name, layers, silent, this._ensureCityContainer()));
            return;
        }
        // Elevation tiers by layer name:
        //  · BAKED  — rail-* (level viaduct), util poles/wires (tear fix), and the whole RIGID BUILDING family
        //             (walls/roofs/dressing/signs/landmarks + foundation slope pads): these bake their anchor
        //             elevation at build time, so the post-transform must not lift them again.
        //  · SMOOTH — layers whose discrete level is already in their geometry (bridges at street level over sunken
        //             canals, terrace walls/stairs with loY/hiY per edge, the canal floor at gy - step).
        //  · FULL   — everything else drapes/lifts onto smooth terrain + terrace steps.
        // After the height tier, EVERY layer goes through the DOMAIN WARP (horizontal, render-space) — heights and
        // all layout-space logic sample UNWARPED coordinates, so the whole city curves consistently.
        const BAKED = /rail-|util-pole|util-wire|bldg-|world:detail|world:roofs|roof-detail|roof-equip|roof-mark|balcony|screen-|world:sign-|awning-|shopfront|noren|textsign-|lm-|foundation|world:sky-|laundry|construction|world:parking|alley-clutter/;
        // Void grid + border glow DRAPE on the terrain (not baked) so they sit ON the ground surface and aren't
        // occluded from above by the draped map. The void grid keeps its lines geometrically pure (no domain warp);
        // the border glow warps so it hugs the (warped) city edge.
        const NOWARP = /void-grid/;
        const _ws: [number, number] = [0, 0];
        for (const L of layers) {
            // Instanced detailed-building detail (juliet / window-trim) carries ONE canonical geometry at the
            // ORIGIN plus a per-window transform list. Height-fielding or warping that canonical would sample
            // (0,0), shifting EVERY instance by a constant (balconies float off into the street). Anchor
            // elevation is already baked into each transform's Y; warp only the horizontal position so the
            // instances track the (warped) walls, and skip the geometry passes below.
            const inst = (L as any).instances as { x: number; z: number }[] | undefined;
            if (L.name.startsWith('world:detail') && inst?.length) {
                // warpInto writes a DISPLACEMENT (dx, dz) — add it (like applyDomainWarp does per-vertex), don't
                // overwrite the position (that collapsed every instance to the origin → one giant pile).
                for (const t of inst) { warpInto(t.x, t.z, _ws); t.x += _ws[0]; t.z += _ws[1]; }
                continue;
            }
            if (!BAKED.test(L.name)) applyHeightField(L.geometry, /bridge|retaining|stair|canal/.test(L.name) ? smoothFn : heightFn);
            if (!NOWARP.test(L.name)) applyDomainWarp(L.geometry, warpInto);
        }
        into.push(this.scene3d.addFlatColorMeshGroup(name, layers, silent, this._ensureCityContainer()));
    }

    /** The last generated graph (for later composers / inspection), or null. */
    get graph(): WorldGraph | null { return this._graph; }
    /** The current full params (after defaults), or null. */
    get params(): LayoutParams | null { return this._params; }
    /** Whether a world is currently shown. */
    get hasWorld(): boolean { return this._groups.length > 0; }
    /** Whether the City editing mode is active. */
    get cityMode(): boolean { return this._cityMode; }
}
